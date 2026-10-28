// U-247（v1.53.26，验收 B1-4 前半）：`gate-green.json` —— **发布只能引用一份可复核的绿**。
//
// 病灶（F18「带红发布」）：发布器此前只看"清单哈希 == 当前字节"，与门禁结果毫无关系。
//   2026-10-25 实测：门禁 704/707（2 条红）仍然发布成功 —— 因为"红"只活在人的记忆里，不在产物里。
//
// 本模块只做两件事（判据与写盘分离，方便门对判据做真值表）：
//   ① `buildGateGreen(summary, meta)`：一轮跑完把它压成一份**可复核的凭证**；
//   ② `gateGreenVerdict(obj, opts)`：发布前问"这份凭证还能用吗"。
//
// 判据（每条都对应一个已知的假绿手法）：
//   · 缺文件 / 坏 JSON / 缺字段 ⇒ 不可用（fail-closed）；
//   · `productRed > 0` ⇒ 不可用；
//   · `metaRed > 0`（U-275，v1.57.0）⇒ 不可用 —— meta 红是"记账/文档/度量自身要修"，
//     它**不是产品结论**，但也**不是绿**：发布包里的文档锚点、清单、Statement 都得是对的。
//     ★字段缺失同样拒（fail-closed）：老凭证没有 metaRed，说明它是在"还没有这一类"的时候生成的，
//       那一轮的 meta 红会被记进 product —— 数已经不可比了，不能拿来背书。
//   · `voided`（起止版本漂移）⇒ 不可用；
//   · `runMode === 'parallel'` ⇒ 不可用 —— **并行绿不算绿**：并行跑没做过串行复核，
//     它连"这条门到底绿不绿"都没确认过（U-245 的教训：并行红有 8/11 是假的，绿同理不可信）；
//   · 版本不一致（凭证 version / versionAtStart / versionAtEnd / 当前 $VERSION 四者）⇒ 不可用；
//   · 超龄（默认 24h）⇒ 不可用（树早就不是那棵树了）。
import fs from 'node:fs';
import path from 'node:path';

// ★落盘位置刻意选**项目根** `.gate-green.json`（而不是 `reports/`）：
//   它是**运行时凭证**（每次跑都变），不是要归档的证据。放 `reports/` 会两难 ——
//   被 .gitignore 忽略 ⇒ U-73 红（"证据被 ignore 吞了"）；不忽略 ⇒ 每跑一次门禁就脏一次工作树。
//   归档的证据仍然是 `reports/**` 下的门禁日志；凭证只回答"最近一次绿是哪一轮"。
export const GATE_GREEN_SCHEMA = 'mcps/gate-green/1';
export const GATE_GREEN_REL = '.gate-green.json';
export const GATE_GREEN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function gateGreenPath(root) { return path.join(root, GATE_GREEN_REL); }

export function buildGateGreen(summary, { version = null, now = new Date().toISOString(), files = [] } = {}) {
  return {
    schema: GATE_GREEN_SCHEMA,
    version,
    versionAtStart: summary.versionAtStart ?? null,
    versionAtEnd: summary.versionAtEnd ?? null,
    runMode: summary.runMode ?? null,
    // U-253（2026-10-26）：实际并发（null = node 默认 = CPU 核数）。只记录、不参与判据 ——
    //   但**必须在凭证里**：同一句"product 红为 0"，32 并发跑出来的和 4 并发跑出来的可信度不同。
    concurrency: summary.concurrency ?? null,
    productRed: summary.productRed ?? null,
    metaRed: summary.metaRed ?? null,
    envRed: summary.envRed ?? null,
    envByKind: summary.envByKind ?? {},
    voided: !!summary.voided,
    movedToEnv: summary.movedToEnv ?? [],
    finishedAt: now,
    gateFiles: files.map(f => path.basename(String(f))).sort(),
  };
}

/** 返回 { ok, why } —— why 是给发布器直接打给人看的一句话 */
export function gateGreenVerdict(obj, { version = null, now = Date.now(), maxAgeMs = GATE_GREEN_MAX_AGE_MS } = {}) {
  const bad = why => ({ ok: false, why });
  if (!obj || typeof obj !== 'object') return bad('没有 gate-green.json（先跑一次全量门禁）');
  if (obj.schema !== GATE_GREEN_SCHEMA) return bad(`schema 不认识（${obj.schema ?? 'missing'}）`);
  if (obj.voided) return bad('该轮已作废（起止版本不一致）');
  if (obj.productRed !== 0) return bad(`product_red=${obj.productRed ?? 'missing'}（必须为 0）`);
  if (obj.metaRed !== 0) return bad(`meta_red=${obj.metaRed ?? 'missing'}（必须为 0：文档/清单/记账同样要修）`);
  if (obj.runMode === 'parallel') return bad('run_mode=parallel —— 并行绿不算绿（没做过串行复核）');
  if (obj.runMode !== 'serial' && obj.runMode !== 'parallel+serial-recheck') return bad(`run_mode 不认识（${obj.runMode ?? 'missing'}）`);
  for (const k of ['version', 'versionAtStart', 'versionAtEnd']) {
    if (!obj[k]) return bad(`缺 ${k}`);
    if (version && obj[k] !== version) return bad(`${k}=${obj[k]} ≠ 当前 ${version}`);
  }
  if (obj.versionAtStart !== obj.versionAtEnd) return bad('versionAtStart ≠ versionAtEnd');
  const t = Date.parse(String(obj.finishedAt || ''));
  if (!Number.isFinite(t)) return bad('finishedAt 不可解析');
  if (now - t > maxAgeMs) return bad(`凭证超龄（${Math.round((now - t) / 3600000)}h > ${Math.round(maxAgeMs / 3600000)}h）`);
  return { ok: true, why: `run_mode=${obj.runMode} product_red=0 meta_red=0 version=${obj.version}` };
}

export function readGateGreen(root) {
  try { return JSON.parse(fs.readFileSync(gateGreenPath(root), 'utf8')); } catch { return null; }
}
