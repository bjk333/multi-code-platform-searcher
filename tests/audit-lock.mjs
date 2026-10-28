// U-246（v1.53.26，验收 B1-5 后半）：`.audit-lock` —— **测量与发布互斥**的最小机制。
//
// 要解决的问题（验收问题 F17）：
//   `product_red` / `gate-green.json` 都是"某一刻的树"的读数，而树在测量**过程中**是可以变的
//   （改一个文件、跑一次发布、切一次分支）。旧流程里没有任何东西阻止"一边测量一边发布"，
//   于是证据与产物之间没有可辩护的时间关系：你无法回答"这份绿是哪棵树上的"。
//
// 机制（刻意做到最小）：
//   ① 全量 CLI 跑**开始前**写 `<root>/.audit-lock`（version + pid + startedAt）；
//   ② 跑完（含异常）**只删自己写的那把**（pid 对得上才删 —— 否则两次并发跑会互删）；
//   ③ 发布器见锁且锁"活"⇒ 拒绝；锁被判"死"（pid 不在 / 超龄 / 坏 JSON 之外的确定性失效）⇒ 可接管；
//   ④ 起止版本不一致 ⇒ 该轮**作废**（`voided`），不许当绿用。
//
// 判活的判据（两侧都保持可证伪）：
//   · 文件不存在 ⇒ 无锁；
//   · **坏 JSON / 缺字段 ⇒ 视为活**（fail-closed：读不懂就当有人在测，别让发布偷偷过去）；
//   · `startedAt` 超过 `staleMs` ⇒ 死（进程可能被 kill -9，pid 会留在文件里）；
//   · 进程不在 ⇒ 死（pid 复用理论上会误判活，所以还要有 `staleMs` 这道上限）。
import fs from 'node:fs';
import path from 'node:path';

export const AUDIT_LOCK_NAME = '.audit-lock';
export const AUDIT_STALE_MS = 30 * 60 * 1000;   // 30 分钟：全量门最坏也就这个量级

export function auditLockPath(root) { return path.join(root, AUDIT_LOCK_NAME); }

/** 读锁：不存在 ⇒ null；存在但不合法 ⇒ { unparsable: true, raw }（调用方按"活"处理） */
export function readAuditLock(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  try {
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object') return { unparsable: true, raw };
    return { version: j.version ?? null, pid: Number.isFinite(Number(j.pid)) ? Number(j.pid) : null, startedAt: j.startedAt ?? null, raw };
  } catch { return { unparsable: true, raw }; }
}

export function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return false;
  if (n === process.pid) return true;
  try { process.kill(n, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }   // EPERM = 进程在、只是没权限
}

/** 返回 null（无锁/已死）或 { version, pid, startedAt, ageMs, why } */
export function auditLockActive(lock, { now = Date.now(), staleMs = AUDIT_STALE_MS } = {}) {
  if (!lock) return null;
  if (lock.unparsable) return { version: null, pid: null, startedAt: null, ageMs: null, why: 'unparsable(fail-closed)' };
  if (!lock.startedAt) return { version: lock.version, pid: lock.pid, startedAt: null, ageMs: null, why: 'no-startedAt(fail-closed)' };
  const t = Date.parse(String(lock.startedAt));
  if (!Number.isFinite(t)) return { version: lock.version, pid: lock.pid, startedAt: lock.startedAt, ageMs: null, why: 'bad-startedAt(fail-closed)' };
  const ageMs = now - t;
  if (ageMs >= staleMs) return null;          // 超龄 ⇒ 死锁，可接管
  if (!pidAlive(lock.pid)) return null;       // 进程不在 ⇒ 死锁，可接管
  return { version: lock.version, pid: lock.pid, startedAt: lock.startedAt, ageMs, why: 'measuring' };
}

export function writeAuditLock(file, { version = null, pid = process.pid, startedAt = new Date().toISOString() } = {}) {
  fs.writeFileSync(file, JSON.stringify({ version, pid, startedAt, tool: 'run-node-gates' }, null, 2) + '\n', 'utf8');
  return { version, pid, startedAt };
}

/** 只删自己写的那把（pid 对不上 = 已被别人接管，不碰） */
export function clearAuditLock(file, pid = process.pid) {
  const cur = readAuditLock(file);
  if (!cur) return false;
  if (cur.pid !== null && Number(cur.pid) !== Number(pid)) return false;
  try { fs.unlinkSync(file); return true; } catch { return false; }
}

/** 从主脚本读 `$VERSION = "x"` —— 用于 versionAtStart/End（读不到就返回 null，不猜） */
export function readScriptVersion(root) {
  try {
    const src = fs.readFileSync(path.join(root, 'multi-platform-searcher.ps1'), 'utf8');
    const m = /^\$VERSION\s*=\s*"([^"]+)"/m.exec(src);
    return m ? m[1] : null;
  } catch { return null; }
}
