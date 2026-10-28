// U-246（v1.53.26，验收 B1-5 后半）：`.audit-lock` —— 测量与发布互斥。
//
// 病灶（F17）：`product_red` / `gate-green.json` 都是"某一刻的树"的读数，而树在测量**过程中**可以变。
//   旧流程没有任何东西阻止"一边测量一边发布" ⇒ 无法回答"这份绿是哪棵树上的"。
//   本批加最小机制：跑前写锁（version+pid+startedAt）、跑完只删自己那把、发布器见活锁即拒；
//   另记 `versionAtStart/End`，不一致 ⇒ 该轮**作废**（不许当绿用）。
//
// 门分三层：
//   A JS 真值表（6 例）+ 所有权（clearAuditLock 只删自己的）；
//   B **两侧同表**：把 publish-skill.ps1 里的 `Test-AuditLockActive` 用 AST 抠出来跑**同一张**真值表 ——
//     两处实现（JS 产锁 / PS 判锁）必须对同一份锁给出同一结论，否则发布器的拒绝是假的；
//   C 接线与 3 条变异。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPwsh } from './r2-ps-run.mjs';
import { auditLockPath, readAuditLock, auditLockActive, writeAuditLock, clearAuditLock, AUDIT_LOCK_NAME, AUDIT_STALE_MS } from './audit-lock.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER = fs.readFileSync(path.join(ROOT, 'tests', 'run-node-gates.mjs'), 'utf8');
const PUB = fs.readFileSync(path.join(ROOT, 'scripts', 'publish-skill.ps1'), 'utf8');
const GI = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'u246-')); }
const ISO = ms => new Date(Date.now() - ms).toISOString();

test('U-246-A: JS 判活真值表（6 例）与所有权（只删自己那把）', () => {
  const dir = tmpdir();
  const f = path.join(dir, AUDIT_LOCK_NAME);
  const now = Date.now();
  // ① 无文件
  assert.equal(auditLockActive(readAuditLock(f), { now }), null, '文件不存在 ⇒ 无锁');
  // ② 新鲜 + 本进程（活）
  writeAuditLock(f, { version: '1.2.3', pid: process.pid });
  assert.equal(auditLockActive(readAuditLock(f), { now }).why, 'measuring');
  // ③ 新鲜 + 死 pid ⇒ 可接管
  writeAuditLock(f, { version: '1.2.3', pid: 999999, startedAt: ISO(60_000) });
  assert.equal(auditLockActive(readAuditLock(f), { now }), null, '进程不在 ⇒ 死锁可接管');
  // ④ 超龄 + 活 pid ⇒ 可接管（防 kill -9 后 pid 被复用）
  writeAuditLock(f, { version: '1.2.3', pid: process.pid, startedAt: ISO(AUDIT_STALE_MS + 60_000) });
  assert.equal(auditLockActive(readAuditLock(f), { now }), null, '超龄 ⇒ 死锁可接管');
  // ⑤ 坏 JSON ⇒ 当活（fail-closed）
  fs.writeFileSync(f, '{not json', 'utf8');
  assert.equal(auditLockActive(readAuditLock(f), { now }).why, 'unparsable(fail-closed)');
  // ⑥ 缺 startedAt ⇒ 当活（fail-closed）
  fs.writeFileSync(f, JSON.stringify({ version: '1.2.3', pid: process.pid }), 'utf8');
  assert.equal(auditLockActive(readAuditLock(f), { now }).why, 'no-startedAt(fail-closed)');
  // 所有权：别人的锁不许删（并发跑互删就会各自"以为没锁"）
  writeAuditLock(f, { version: '1.2.3', pid: 999999 });
  assert.equal(clearAuditLock(f, process.pid), false, 'pid 对不上不许删');
  assert.ok(fs.existsSync(f), '别人的锁必须还在');
  writeAuditLock(f, { version: '1.2.3', pid: process.pid });
  assert.equal(clearAuditLock(f, process.pid), true, '自己的锁要能删');
  assert.equal(fs.existsSync(f), false);
  fs.rmSync?.(dir, { recursive: true, force: true });
});

test('U-246-B: 两侧同表 —— PS 的 Test-AuditLockActive 对同一份锁给出同一结论', async () => {
  const r = await runPwsh(['-File', path.join(ROOT, 'tests', 'u246-lock-truth.ps1')], { timeoutMs: 180000 });
  assert.equal(r.status, 0, `harness rc=${r.status}: ${(r.stderr || '').slice(-500)}`);
  const line = r.stdout.split(/\r?\n/).filter(l => l.trim().startsWith('{"ok"')).pop();
  assert.ok(line, `harness 未输出 JSON：${(r.stdout || '').slice(-300)}`);
  const rows = JSON.parse(line).rows;
  const want = {
    missing: { active: false, why: '' },
    'fresh-alive': { active: true, why: 'measuring' },
    'fresh-dead-pid': { active: false, why: '' },
    'stale-alive': { active: false, why: '' },
    'bad-json': { active: true, why: 'unparsable(fail-closed)' },
    'no-startedAt': { active: true, why: 'no-startedAt(fail-closed)' },
  };
  assert.deepEqual(rows.map(x => x.id).sort(), Object.keys(want).sort(), '两侧用例集不一致');
  for (const row of rows) assert.deepEqual({ active: row.active, why: row.why }, want[row.id], `${row.id} 与 JS 侧口径不一致`);
});

test('U-246-C: 接线 —— 跑前写锁/跑后只删自己那把/版本漂移作废/发布器见活锁即拒', () => {
  const bad = [];
  if (!/writeAuditLock\(lockFile, \{ version: versionAtStart \}\)/.test(RUNNER)) bad.push('runner 未写 .audit-lock');
  if (!/finally \{\s*\n\s*if \(lockMine\) clearAuditLock\(lockFile, process\.pid\)/.test(RUNNER)) bad.push('runner 未在 finally 里只删自己那把');
  if (!/held\) console\.error/.test(RUNNER)) bad.push('已有活锁时未声明（并发跑却不说话）');
  if (!/versionAtStart !== versionAtEnd/.test(RUNNER) || !/summary\.voided = true/.test(RUNNER)) bad.push('版本漂移未作废该轮');
  if (!/function Test-AuditLockActive/.test(PUB)) bad.push('发布器缺判锁函数');
  if (!/if \(-not \$IgnoreAuditLock\) \{ throw/.test(PUB)) bad.push('发布器见锁未拒绝（或没有默认拒绝）');
  if (!/^\.audit-lock$/m.test(GI)) bad.push('.gitignore 未忽略 .audit-lock（会进库/进发布）');
  assert.deepEqual(bad, [], bad.join('; '));
});

test('U-246-C 负例：不删锁 / 不作废 / 发布器放行 —— 各自判红', () => {
  const badOf = (runner, pub, gi) => {
    const out = [];
    if (!/if \(lockMine\) clearAuditLock\(lockFile, process\.pid\)/.test(runner)) out.push('clear');
    if (!/summary\.voided = true/.test(runner)) out.push('voided');
    if (!/if \(-not \$IgnoreAuditLock\) \{ throw/.test(pub)) out.push('refuse');
    if (!/^\.audit-lock$/m.test(gi)) out.push('ignore');
    return out;
  };
  assert.deepEqual(badOf(RUNNER, PUB, GI), [], '原文件必须通过');
  const noClear = RUNNER.replace('if (lockMine) clearAuditLock(lockFile, process.pid);', '');
  assert.notEqual(noClear, RUNNER, '变异①未生效');
  assert.ok(badOf(noClear, PUB, GI).includes('clear'));
  // ② 不作废。★必须**全量**删：`summary.voided = true` 现在有两处语义不同的落点 ——
  //    ① 版本漂移（U-246 原本守的）② 整轮挂住（U-251 新增）。`String.replace` 只换第一处，
  //    删完第二处还在 ⇒ 正则照样命中 ⇒ 报的是"变异未判红"，看起来像门坏了。
  //    这是本仓第三次踩同一个坑（B1-7 的 `Get-NetworkCandidates -Target`、U-244 变异③）。
  const VOID_STMT = 'summary.voided = true;';
  assert.ok(RUNNER.split(VOID_STMT).length - 1 >= 2, 'voided 至少有两处落点（版本漂移 + 挂住）');
  const noVoid = RUNNER.split(VOID_STMT).join('');
  assert.notEqual(noVoid, RUNNER, '变异②未生效');
  assert.ok(badOf(noVoid, PUB, GI).includes('voided'));
  const noRefuse = PUB.replace('if (-not $IgnoreAuditLock) { throw', 'if ($false) { throw');
  assert.notEqual(noRefuse, PUB, '变异③未生效');
  assert.ok(badOf(RUNNER, noRefuse, GI).includes('refuse'), '发布器改成"永不拒绝"未被判红');
});
