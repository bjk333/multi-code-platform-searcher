// U-291（v1.71.0，2026-10-28 全量验收 F1）：`.ps-gate.json` —— **PS 套件的那半张发布凭证**。
//
// 病灶（本轮验收实证，不是推演）：
//   发布器此前只问"Node 门绿不绿"（`.gate-green.json`，只由 run-node-gates 写）。
//   于是**只被 PS 套件覆盖**的断言红也不拦发布 —— 2026-10-28 实测：`test-docs` 判 SKILL.md 含字面 `\n`（第 171 行），
//   该行 2026-10-26 20:48 进树，v1.70.0 于 10-27 16:58 带着这条红发布出去了。
//   受影响的断言族（Node 侧根本没有）：文档卫生 `\n` 工件 / BOM 与编码 / 注入 12e·12i / doctor C1..C5。
//
// 判据（每条都对应一种"看起来是绿"的手法）：
//   · 缺文件 / 坏 JSON / 缺字段 ⇒ 不可用（fail-closed：`[int]$null` 是 0，不显式判空就把"缺"读成"0 红"）；
//   · failed > 0 ⇒ 不可用；exitCode ≠ 0 ⇒ 不可用（两个都要，防"计数器与组行不一致"那种局部修补）；
//   · `localOnly === true` ⇒ 不可用 —— `-LocalOnly` 只跑快路径，契约/网络组被跳过，不能背书；
//   · version ≠ 当前 `$VERSION` ⇒ 不可用（凭证必须描述**这棵树**）；
//   · 超龄（默认 24h）⇒ 不可用；
//   · **skipped 允许**：网络不可用时组会 SKIP（那是环境，不是红）—— 把它也算红会逼人用 -SkipGateGreen。
//
// ★真值表是**两处实现**（本文件 / publish-skill.ps1 的 Test-PsGate），U-291 B 层用 AST 抠出 PS 函数逐例比对布尔。
export const PS_GATE_SCHEMA = 'mcps/ps-gate/1';
export const PS_GATE_REL = '.ps-gate.json';
export const PS_GATE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** 返回 { ok, why } —— why 是给发布器直接打给人看的一句话 */
export function psGateVerdict(obj, { version = null, now = Date.now(), maxAgeMs = PS_GATE_MAX_AGE_MS } = {}) {
  const bad = why => ({ ok: false, why });
  if (!obj || typeof obj !== 'object') return bad('没有 ps-gate.json（先跑一次 tests/run-tests.ps1 全量）');
  if (obj.schema !== PS_GATE_SCHEMA) return bad(`schema 不认识（${obj.schema ?? 'missing'}）`);
  if (!('failed' in obj)) return bad('凭证缺 failed 字段（fail-closed）');
  if (Number(obj.failed) !== 0) return bad(`PS 套件 failed=${obj.failed}（必须为 0）`);
  if (!('exitCode' in obj) || Number(obj.exitCode) !== 0) return bad(`PS 套件 exitCode=${obj.exitCode ?? 'missing'}（必须为 0）`);
  if (obj.localOnly === true) return bad('-LocalOnly 跑出来的凭证不能背书（只跑了快路径，契约/网络组没跑）');
  if (!obj.version) return bad('缺 version');
  if (version && String(obj.version) !== String(version)) return bad(`PS 凭证版本 ${obj.version} ≠ 本次发布 ${version}`);
  const t = Date.parse(String(obj.finishedAt || ''));
  if (!Number.isFinite(t)) return bad('finishedAt 不可解析');
  if (now - t > maxAgeMs) return bad(`PS 凭证超龄（${Math.round((now - t) / 3600000)}h > ${Math.round(maxAgeMs / 3600000)}h）`);
  return { ok: true, why: `PS 套件 failed=0 skipped=${obj.skipped ?? 0} version=${obj.version} runtime=${obj.runtime ?? '?'}` };
}
