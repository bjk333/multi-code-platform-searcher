// U-277（v1.60.0，B3-6 欠账）：**证据目录棘轮** —— `reports/` 只许降，不许涨回去。
//
// 为什么需要它（B3-6 §9 自己写的窟窿）：
//   B3-6 把 2,071 个过程产物移到外部归档，仓内留 541 —— 但**没有任何东西阻止它长回去**。
//   实测：B3 这一批自己写了 4 张全量门日志，每跑一次 +1，且没有任何代码"自动写 reports/"，
//   全是人工重定向 ⇒ 没有任何机制会因为"又多了一张"而响。没有棘轮，541 只是这一天的快照。
//
// 判据（四道互锁，缺一条就能绕）：
//   ① `total.files ≤ cap.files`、`total.bytes ≤ cap.bytes` —— 天花板。
//   ② `cap − total ≤ HEADROOM`（默认 8 个 / 2 MiB）—— ★这条才是棘轮：
//      天花板必须**贴着现实**。于是「把 cap 设成 1 万，然后随便加」不成立；
//      而一旦真的归档了一批（total 掉下去），headroom 变大 ⇒ 立刻红 ⇒ **逼你下调 cap**。
//      只写 ① 的话，cap=99999 是一次性动作，之后永远绿。
//   ③ `cap` 必须等于 `history[末条]`，且 history 的 files/bytes **单调不增**。
//      于是「今天先抬到 600、明天再说」走不通。
//   ④ 模块常量 `FROZEN_FILES / FROZEN_BYTES` 必须等于 `history[0]`。
//      单看 JSON，「把 history[0] 改成 600」和「合法的历史」长得一样；常量把同一个数
//      记在**代码**里 ⇒ 一次放行要同时改数据与代码两处，且两处不一致本身就红。
//      这不是防恶意（防不住），是防「顺手」。
//
// ★口径（说清楚它**不**管什么）：
//   · 不管"某个具体证据文件还在不在" —— 那是 U-91 索引门的活（规则块必须命中仓内文件）。
//     本门只管**总量**，因为"该留哪些"是人的判断，而"总量有没有失控"是能算的。
//   · 不管外部归档的内容（归档可能在别的盘、CI 上根本没有）；它只保证仓内这一侧不膨胀。
import fs from 'node:fs';
import path from 'node:path';

export const REPORTS_SCHEMA = 'u277-reports-quota/1';
export const REPORTS_REL = 'tests/reports-quota.json';
export const REPORTS_DIR = 'reports';

/** 冻结于 2026-10-27（v1.60.0）：542 个在仓证据 + 6 个 B3-7 预留 = 548 */
export const FROZEN_FILES = 548;
/** 14,555,121 B（13.88 MiB）+ 2 MiB 预留 */
export const FROZEN_BYTES = 14555121 + 2 * 1048576;
/** 天花板离现实最多允许多远 —— 超过就说明账本没跟上，而不是"还有余量" */
export const MAX_HEADROOM_FILES = 8;
export const MAX_HEADROOM_BYTES = 2 * 1048576;

const isInt = (x) => Number.isInteger(x) && x >= 0;

/**
 * 实测仓内证据：文件数、字节数、按顶层目录分解。
 * 不跟随符号链接（避免把外部归档算进来）。
 */
export function scan(root) {
  const dir = path.join(root, REPORTS_DIR);
  const out = { files: 0, bytes: 0, dirs: {} };
  if (!fs.existsSync(dir)) return out;
  const walk = (abs, top) => {
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      const p = path.join(abs, ent.name);
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) { walk(p, top || ent.name); continue; }
      if (!ent.isFile()) continue;
      let size = 0;
      try { size = fs.statSync(p).size; } catch { continue; }
      out.files += 1;
      out.bytes += size;
      const key = top || '(根)';
      out.dirs[key] = (out.dirs[key] || 0) + 1;
    }
  };
  walk(dir, null);
  return out;
}

/**
 * @param {{files:number,bytes:number,dirs:object}} actual 实测（scan 的返回）
 * @param {any} ledger  tests/reports-quota.json
 * @returns {{ok:boolean, problems:string[], notes:string[]}}
 */
export function reportsVerdict(actual, ledger, {
  files = FROZEN_FILES,
  bytes = FROZEN_BYTES,
  maxHeadroomFiles = MAX_HEADROOM_FILES,
  maxHeadroomBytes = MAX_HEADROOM_BYTES,
} = {}) {
  const problems = []; const notes = [];
  const bad = (m) => problems.push(m);
  if (!ledger || typeof ledger !== 'object') {
    return { ok: false, problems: [`没有 ${REPORTS_REL}（先按 U-277 的说明生成）`], notes };
  }
  if (ledger.schema !== REPORTS_SCHEMA) bad(`schema 不认识（${ledger.schema ?? 'missing'}）`);
  const cap = ledger.cap;
  if (!cap || typeof cap !== 'object') bad('`cap` 缺失');
  else {
    if (!isInt(cap.files)) bad('`cap.files` 必须是非负整数');
    if (!isInt(cap.bytes)) bad('`cap.bytes` 必须是非负整数');
  }
  const hist = ledger.history;
  if (!Array.isArray(hist) || !hist.length) bad('`history` 至少一条');
  if (problems.length) return { ok: false, problems, notes };

  for (const [i, h] of hist.entries()) {
    if (!h || typeof h !== 'object') { bad(`history[${i}] 不是对象`); continue; }
    if (typeof h.version !== 'string' || !h.version.trim()) bad(`history[${i}].version 缺失`);
    if (!isInt(h.files)) bad(`history[${i}].files 不是非负整数`);
    if (!isInt(h.bytes)) bad(`history[${i}].bytes 不是非负整数`);
  }
  if (problems.length) return { ok: false, problems, notes };

  // ---- ③ 单调不增 ----
  for (let i = 1; i < hist.length; i++) {
    if (hist[i].files > hist[i - 1].files) {
      bad(`history[${i}] 把文件上限从 ${hist[i - 1].files} 抬到 ${hist[i].files} —— 只许降`);
    }
    if (hist[i].bytes > hist[i - 1].bytes) {
      bad(`history[${i}] 把字节上限从 ${hist[i - 1].bytes} 抬到 ${hist[i].bytes} —— 只许降`);
    }
  }
  const last = hist[hist.length - 1];
  if (last.files !== cap.files) bad(`history 末条 files=${last.files} ≠ cap.files ${cap.files}（改了上限就必须追加一条）`);
  if (last.bytes !== cap.bytes) bad(`history 末条 bytes=${last.bytes} ≠ cap.bytes ${cap.bytes}`);

  // ---- ④ 常量互锁 ----
  if (hist[0].files !== files) {
    bad(`history[0].files=${hist[0].files} ≠ 冻结常量 ${files}（首条是冻结时的读数，不许回头改；要下调请追加新条目）`);
  }
  if (hist[0].bytes !== bytes) {
    bad(`history[0].bytes=${hist[0].bytes} ≠ 冻结常量 ${bytes}`);
  }

  // ---- ① 天花板 ----
  if (actual.files > cap.files) {
    bad(`在仓证据 ${actual.files} 个 > 上限 ${cap.files} —— 要加证据就得先把同量的旧证据外置（B3-6 的 MANIFEST 流程）`);
  }
  if (actual.bytes > cap.bytes) {
    bad(`在仓证据 ${actual.bytes}B > 上限 ${cap.bytes}B —— 合并成一个大文件不算瘦身，两个轴分开记`);
  }

  // ---- ② 天花板必须贴着现实（否则 ① 是一次性动作）----
  const hf = cap.files - actual.files;
  const hb = cap.bytes - actual.bytes;
  if (hf > maxHeadroomFiles) {
    bad(`上限比现实高 ${hf} 个（> ${maxHeadroomFiles}）—— 说明真的减了却没下调上限：请把 cap 调到 ${actual.files}~${actual.files + maxHeadroomFiles} 并追加 history`);
  }
  if (hb > maxHeadroomBytes) {
    bad(`上限比现实高 ${(hb / 1048576).toFixed(2)} MiB（> ${(maxHeadroomBytes / 1048576).toFixed(0)} MiB）—— 同上，请下调 cap.bytes`);
  }

  const dirs = Object.entries(actual.dirs).sort((a, b) => b[1] - a[1]);
  notes.push(`在仓证据 ${actual.files}/${cap.files} 个（余量 ${hf}）、${(actual.bytes / 1048576).toFixed(2)}/${(cap.bytes / 1048576).toFixed(2)} MiB（余量 ${(hb / 1048576).toFixed(2)}）`);
  notes.push('顶层分布：' + dirs.map(([k, v]) => `${k}=${v}`).join(' '));
  return { ok: problems.length === 0, problems, notes };
}

export function readLedger(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, REPORTS_REL), 'utf8')); } catch { return null; }
}

/**
 * 这是不是**仓库**（而不是装好的副本）？锚点取 `reports/provenance/`：
 *   每次发版都会在那里重生成 in-toto Statement，而发布清单里 `reports/` 条目为 0（B3-6 §9 的口径）。
 * ★为什么不用 `.gitignore` / `reports/` 本身：实测副本里**都有** —— 副本的 `reports/` 是历史遗留
 *   （250 个旧证据文件，清单早已不收，prune 又因为"源仓也有"而不敢删）。
 *   用 provenance 这种"只有仓库才重生成"的东西做锚点，才不会把副本误判成仓库。
 */
export function hasRepoEvidence(root) {
  return fs.existsSync(path.join(root, REPORTS_DIR, 'provenance'));
}
