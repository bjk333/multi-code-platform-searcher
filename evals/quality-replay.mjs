// 固定语料离线复算（P0-2）：把"改排序到底变好还是变坏"从 live 网络里摘出来。
//
// 为什么要有它：
//   · 质量基线走 live GitHub（`-NoCache`），同一查询两次可能不同 —— 改排序/改检索式后，
//     信号会被网络抖动淹没（R5、10-17 两份方案都踩过"读数是环境的"）；
//   · 候选池连同打分信号被 `evals/quality-baseline.ps1 -Snapshot` 冻结在
//     `evals/snapshots/quality-<date>.json`，本脚本只读那份语料，不发任何请求。
//
// 三条硬约束（都对应一条判据，不是装饰）：
//   ① **公式一致性**：`base` 重算的分数必须与引擎记录的 `score` 一致（±1.5e-3，引擎保留 3 位小数）。
//      引擎改了公式却不改这里 ⇒ 复算结果作废，必须显式报错，不许"差不多就行"。
//   ② **语料完整性**：建语料时记下的 `presentWants`（当时确实在候选里的期望项）若在复算时不见，
//      必须报 `missing` 并非 0 退出。删掉一条已知命中却静默跳过，等于把基线偷偷放宽。
//   ③ **语料不可改**：`sha256` 覆盖"把该字段替换成 64 个 0 之后的整文件字节"，任何字节改动都会失败。
//      （跨语言不约定规范化序列化 —— 那玩意儿的误报比它能抓的错更多。）
//
// 用法：
//   node evals/quality-replay.mjs --snapshot evals/snapshots/quality-2026-10-25.json
//   node evals/quality-replay.mjs --scorer maintenance          # 候选公式 A/B（实验，不是产品默认）
//   node evals/quality-replay.mjs --live reports/quality-baseline-2026-10-25.json   # 快照 vs live 偏差
//   node evals/quality-replay.mjs --against evals/snapshots/quality-<older>.json    # 跨版本：老命中不许消失
//   node evals/quality-replay.mjs --json
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/** repo 名取 `/` 后一段并小写 —— 与 quality-baseline.ps1 的 Get-RepoSegment 同口径。 */
export function segment(name) {
  if (!name) return '';
  const n = String(name).trim();
  const i = n.lastIndexOf('/');
  return (i >= 0 ? n.slice(i + 1) : n).toLowerCase();
}

/**
 * 引擎的默认排序式（`Set-UnifiedScore`，v1.53.26）：
 *   score = 0.8×relevance + 0.2×popularity；`noise`（0 关键词命中）再 ×0.5。
 * 注意 `-Focus` 未参与基线调用，故 focusTerms 的两个分支不在本式内；若将来基线带 Focus，
 * 这里必须同步，否则公式一致性检查会红（这是设计好的绊线，不是 bug）。
 */
export function baseScore(c) {
  let s = 0.8 * (Number(c.relevance) || 0) + 0.2 * (Number(c.popularity) || 0);
  if (c.noise === true) s *= 0.5;
  return s;
}

const MONTH = 30 * 24 * 3600 * 1000;

/**
 * 候选公式：维护信号分层（P1-1 的评测对象，**不是产品默认**）。
 * 只用语料里已有的 `archived` / `updated`，零新增请求；以语料 `createdAt` 为"现在"，
 * 不读 Date.now() —— 否则同一个语料今天跑和半年后跑结果不同，基线就废了。
 */
export function maintenanceScore(c, nowMs) {
  let s = baseScore(c);
  if (c.archived === true) return s * 0.3;
  const t = Date.parse(c.updated || '');
  if (Number.isFinite(t)) {
    const age = nowMs - t;
    if (age > 18 * MONTH) s *= 0.7;
    else if (age > 12 * MONTH) s *= 0.85;
  }
  return s;
}

export const SCORERS = {
  base: (c) => baseScore(c),
  maintenance: (c, ctx) => maintenanceScore(c, ctx.nowMs),
};

/**
 * 引擎落 `Score` 时是 `[math]::Round($score, 3)`（银行家舍入），**排序也按这个 3 位小数值**：
 * 实测 1776 条候选里有 2 条查询的原始分不同、取整后相同，按原始分排会把名次挪 1~9 位。
 * 复现引擎就必须先取整再排，否则"复算名次 ≠ 采集名次"会被误判成公式漂移。
 */
export function round3(x) {
  const scaled = x * 1000;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  const eps = 1e-9;
  let r;
  if (diff > 0.5 + eps) r = floor + 1;
  else if (diff < 0.5 - eps) r = floor;
  else r = floor % 2 === 0 ? floor : floor + 1; // 银行家舍入，与 PS [math]::Round 一致
  return r / 1000;
}

/** 排序：**取整后**的分数降序；同分按引擎给的 index 升序（复现引擎的稳定序，别让 ties 随机翻转）。 */
export function rankCandidates(candidates, scorerName, ctx) {
  const fn = SCORERS[scorerName];
  if (!fn) throw new Error(`未知 scorer: ${scorerName}（可选 ${Object.keys(SCORERS).join('/')}）`);
  return [...candidates]
    .map((c) => ({ c, s: fn(c, ctx) }))
    .sort((a, b) => (round3(b.s) - round3(a.s)) || ((a.c.index ?? 0) - (b.c.index ?? 0)));
}

/** 单条查询：返回首个命中名次（1-based；0=未命中）与 Top-K 名字。 */
export function scoreQuery(query, { scorer = 'base', limit = 5, ctx } = {}) {
  const ranked = rankCandidates(query.candidates || [], scorer, ctx);
  const want = new Set((query.want || []).map((w) => String(w).toLowerCase()));
  let rank = 0;
  const segments = ranked.map((r) => segment(r.c.name));
  for (let i = 0; i < segments.length; i++) {
    if (want.has(segments[i])) { rank = i + 1; break; }
  }
  return { rank, topK: ranked.slice(0, limit).map((r) => r.c.name), segments };
}

/**
 * 语料完整性：`previous` 里记录过"当时确实在候选里"的期望项，必须在 `current` 里仍然找得到。
 *   · 不给 `previous` ⇒ 自检（同一份语料内部：presentWants ⊆ candidates）；
 *   · 给 `previous` ⇒ 跨版本回归（重新采集后，老语料里的命中不许无声消失）。
 * 为什么必须显式失败：删掉一条已知命中却静默跳过，等于把基线偷偷放宽 —— 分数变好，能力没变。
 */
export function findMissing(current, previous = null) {
  const ref = previous || current;
  const curByQuery = new Map((current.queries || []).map((q) => [q.q, q]));
  const missing = [];
  for (const q of ref.queries || []) {
    const cur = curByQuery.get(q.q);
    if (!cur) {
      for (const w of q.presentWants || []) missing.push({ q: q.q, set: q.set, name: w, reason: 'query-gone' });
      continue;
    }
    const have = new Set((cur.candidates || []).map((c) => segment(c.name)));
    for (const w of q.presentWants || []) {
      if (!have.has(String(w).toLowerCase())) missing.push({ q: q.q, set: q.set, name: w, reason: previous ? 'gone-vs-previous' : 'absent' });
    }
  }
  return missing;
}

/**
 * 公式一致性：base 重算（取整后）必须与引擎记录一致。
 * 容差 1.2e-3 不是因为"差不多就行"，而是因为**引擎只暴露 3 位小数的 relevance/popularity**：
 * 当真实 relevance 是 0.003125 时，落盘是 0.003，而 score=0.8×0.003125=0.0025 会进位到 0.003 ——
 * 用 0.003 重算只能得到 0.002。这类"半分点"误差上限就是 0.001，再大就是公式真的变了。
 */
export function checkParity(snapshot, tol = 1.2e-3) {
  const bad = [];
  for (const q of snapshot.queries || []) {
    for (const c of q.candidates || []) {
      const got = round3(baseScore(c));
      const want = Number(c.score);
      if (!Number.isFinite(want)) continue;
      if (Math.abs(got - want) > tol) bad.push({ q: q.q, name: c.name, got, recorded: want });
    }
  }
  return bad;
}

/** 整份语料复算：总体 + 分组 + 逐条。 */
export function replay(snapshot, { scorer = 'base', limit = 5 } = {}) {
  const nowMs = Date.parse(snapshot.createdAt || '') || 0;
  const ctx = { nowMs };
  const rows = [];
  const rankMismatch = [];
  for (const q of snapshot.queries || []) {
    const { rank, topK } = scoreQuery(q, { scorer, limit, ctx });
    rows.push({ set: q.set, q: q.q, rank, recordedRank: q.rank, want: q.want, topK, verdict: q.verdict, reasonCode: q.reasonCode });
    // 端到端一致性：复算出的名次必须等于采集时引擎给的名次（同语料同公式 ⇒ 逐条相同）。
    if (scorer === 'base' && Number.isFinite(q.rank) && rank !== q.rank) rankMismatch.push({ set: q.set, q: q.q, computed: rank, recorded: q.rank });
  }
  const agg = (rs) => {
    const n = rs.length;
    const hit3 = rs.filter((r) => r.rank >= 1 && r.rank <= 3).length;
    const hitK = rs.filter((r) => r.rank >= 1 && r.rank <= limit).length;
    const mrr = rs.reduce((a, r) => a + (r.rank >= 1 && r.rank <= limit ? 1 / r.rank : 0), 0);
    return {
      n,
      hit3: n ? Number(((100 * hit3) / n).toFixed(1)) : null,
      hitK: n ? Number(((100 * hitK) / n).toFixed(1)) : null,
      mrr: n ? Number((mrr / n).toFixed(3)) : null,
    };
  };
  const sets = {};
  for (const g of new Set(rows.map((r) => r.set))) sets[g] = agg(rows.filter((r) => r.set === g));
  return { scorer, limit, overall: agg(rows), sets, rows, rankMismatch };
}

function zeroedHash(text) {
  const zeroed = text.replace(/("sha256":\s*")[0-9a-f]{64}"/, (m, p1) => p1 + '0'.repeat(64) + '"');
  return crypto.createHash('sha256').update(Buffer.from(zeroed, 'utf8')).digest('hex');
}

/** 读语料并校验 sha256；不一致抛错（fail-closed，调用方不许 catch 后继续算分）。 */
export function loadSnapshot(file) {
  const p = path.isAbsolute(file) ? file : path.join(ROOT, file);
  const text = fs.readFileSync(p, 'utf8');
  const snap = JSON.parse(text);
  const claimed = String(snap.sha256 || '');
  if (!/^[0-9a-f]{64}$/.test(claimed)) throw new Error(`语料缺合法 sha256: ${p}`);
  const got = zeroedHash(text);
  if (got !== claimed) throw new Error(`语料 sha256 不一致（期望 ${claimed}，实际 ${got}）: ${p}`);
  return { ...snap, _file: p, _sha256: got };
}

// ---------------- CLI ----------------
async function main(argv) {
  const arg = (name, def = '') => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
  };
  const asJson = argv.includes('--json');
  const snapPath = arg('--snapshot', path.join('evals', 'snapshots', 'quality-2026-10-25.json'));
  const scorer = arg('--scorer', 'base');
  const limit = Number(arg('--limit', '5'));
  const livePath = arg('--live', '');
  const againstPath = arg('--against', '');

  let snap;
  let prev = null;
  try {
    snap = loadSnapshot(snapPath);
    if (againstPath) prev = loadSnapshot(againstPath);
  } catch (e) {
    console.error(`[replay] ${e.message}`);
    return 3;
  }

  const missing = findMissing(snap, prev);
  const parity = checkParity(snap);
  const res = replay(snap, { scorer, limit });

  let live = null;
  if (livePath) {
    try { live = JSON.parse(fs.readFileSync(path.isAbsolute(livePath) ? livePath : path.join(ROOT, livePath), 'utf8')); } catch (e) { console.error(`[replay] 读 live 报告失败: ${e.message}`); }
  }

  if (asJson) {
    console.log(JSON.stringify({ snapshot: snap._file, sha256: snap._sha256, scorer, limit, overall: res.overall, sets: res.sets, missing, parityErrors: parity.length, rankMismatch: res.rankMismatch, live: live ? { n: live.n, hit3: live.hit3, sets: live.sets } : null }, null, 2));
  } else {
    console.log(`[replay] 语料 ${path.relative(ROOT, snap._file)}  sha256=${snap._sha256.slice(0, 12)}…  ${snap.queryCount} 条 / ${snap.totalCandidates} 候选  v${snap.engineVersion}  createdAt=${snap.createdAt}`);
    console.log(`[replay] scorer=${scorer}  limit=${limit}`);
    console.log('');
    console.log('| 组 | n | Hit@3 | Hit@5 | MRR@5 |');
    console.log('|---|---|---|---|---|');
    for (const [g, s] of Object.entries(res.sets)) console.log(`| ${g} | ${s.n} | ${s.hit3}% | ${s.hitK}% | ${s.mrr} |`);
    console.log(`| **合计** | ${res.overall.n} | ${res.overall.hit3}% | ${res.overall.hitK}% | ${res.overall.mrr} |`);
    if (live) {
      console.log('');
      console.log(`[replay] live: n=${live.n} Hit@3=${live.hit3}%  Δ=${(res.overall.hit3 - live.hit3).toFixed(1)}pp（判据 |Δ|≤5pp）`);
      for (const [g, s] of Object.entries(res.sets)) {
        const l = live.sets && live.sets[g];
        if (l) console.log(`[replay]   ${g}: 快照 ${s.hit3}% vs live ${l.hit3}% → Δ=${(s.hit3 - l.hit3).toFixed(1)}pp`);
      }
    }
    const zeroHit = (snap.queries || []).filter((q) => (q.candidates || []).length === 0).length;
    console.log('');
    console.log(`[replay] 空候选 ${zeroHit} 条；公式不一致 ${parity.length} 处；名次不一致 ${res.rankMismatch.length} 处；缺条目 ${missing.length} 处`);
    if (parity.length) for (const p of parity.slice(0, 5)) console.log(`  PARITY ${p.q} / ${p.name}: 重算 ${p.got} ≠ 记录 ${p.recorded}`);
    if (res.rankMismatch.length) for (const m of res.rankMismatch.slice(0, 5)) console.log(`  RANK ${m.set} / ${m.q}: 复算 ${m.computed} ≠ 记录 ${m.recorded}`);
    if (missing.length) for (const m of missing.slice(0, 10)) console.log(`  MISSING ${m.set} / ${m.q} → ${m.name}`);
  }

  if (missing.length) return 2;
  if (parity.length || res.rankMismatch.length) return 4;
  return 0;
}

const invokedDirectly = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) main(process.argv.slice(2)).then((c) => process.exit(c));
