// U-252（2026-10-25，P0-2）：固定语料回归集 —— 排序改动必须能在离线语料上判"变好还是变坏"。
//
// 为什么这条门必须存在：
//   · 质量基线走 live GitHub（`-NoCache`），同一查询两次可能不同；改排序后，"变好 3pp"与"网络抖了 3pp"
//     在读数上长得一样（R5、10-17 两份方案都栽在这上面）。
//   · 处置：候选池连同打分信号冻结成语料（`evals/snapshots/quality-*-.json`），排序实验只在语料上跑。
//   · 语料一旦被静默改动，"基线"就成了可以随便调的东西 —— 所以本门一半篇幅在守"改了一定红"。
//
// 门分四层（全部离线，不联网）：
//   A 语料自洽：sha256 可校验、条数/期望集合法、查询不重复、候选规模够评测（>500 条）
//   B 公式一致：base 重算 == 引擎记录（±1.5e-3）；复算名次 == 采集时的名次（逐条）
//     —— 引擎改公式而这里不同步 ⇒ 红。这是设计好的绊线：复算结果作废必须显式暴露。
//   C 判据可用：快照 Hit@3 与 live 全量报告差异 ≤5pp（含分组）—— 否则"快照不代表线上"，读数不许用
//   D 三种失败必红：改一字节（sha256 拒读）、删一条已知命中（missing 必须点名）、
//     判别力（archived 同权 vs 维护分层，两个 scorer 的名次必须不同——否则"没变化"没有信息量）
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadSnapshot, replay, findMissing, checkParity, rankCandidates, segment } from '../evals/quality-replay.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SNAPSHOT = path.join(ROOT, 'evals', 'snapshots', 'quality-2026-10-25.json');

test('U-252 A: 固定语料必须自洽（sha256 / 条数 / 期望集 / 唯一性）', () => {
  assert.ok(fs.existsSync(SNAPSHOT), '★ 缺 evals/snapshots/quality-2026-10-25.json');
  const snap = loadSnapshot(SNAPSHOT); // 内部校验 sha256，不一致直接抛
  assert.ok(snap.queryCount >= 60, `★ 语料只有 ${snap.queryCount} 条查询，少于 60`);
  assert.equal(snap.queries.length, snap.queryCount, '★ queryCount 与 queries 长度不一致');
  const qs = snap.queries.map((q) => q.q);
  assert.equal(new Set(qs).size, qs.length, '★ 语料里有重复查询，聚合会被重复计数');
  const bad = [];
  for (const q of snap.queries) {
    if (!Array.isArray(q.want) || q.want.length < 3) bad.push(`${q.q}: want 少于 3 项`);
    if (!Array.isArray(q.candidates)) bad.push(`${q.q}: candidates 不是数组`);
    for (const w of q.want || []) if (!/^[a-z0-9._-]+$/.test(w)) bad.push(`${q.q}: want "${w}" 不是小写 ASCII repo 名`);
    for (const w of q.presentWants || []) if (!(q.want || []).includes(w)) bad.push(`${q.q}: presentWants 里的 "${w}" 不在 want 中`);
  }
  assert.deepEqual(bad, [], '★ 语料不合格：\n' + bad.join('\n'));
  assert.ok(snap.totalCandidates > 500, `★ 候选总量只有 ${snap.totalCandidates}，样本不足（快照应按 -SnapshotLimit 50 采集）`);
  assert.ok(snap.engineVersion, '★ 语料缺 engineVersion：无法判断是哪版引擎采的');
});

test('U-252 B: 复算公式必须与引擎一致（分数 + 名次逐条对齐）', () => {
  const snap = loadSnapshot(SNAPSHOT);
  const parity = checkParity(snap);
  assert.deepEqual(parity.slice(0, 5), [], `★ 公式不一致 ${parity.length} 处（引擎改了排序式？）`);
  const res = replay(snap, { scorer: 'base', limit: 5 });
  assert.deepEqual(res.rankMismatch.slice(0, 5), [], `★ 名次不一致 ${res.rankMismatch.length} 处：复算无法复现采集时的排序`);
  assert.equal(res.overall.n, snap.queryCount, '★ 复算条数与语料条数不一致（有查询被静默跳过）');
});

test('U-252 C: 快照必须代表线上（与 live 全量报告 Hit@3 差异 ≤5pp）', () => {
  const snap = loadSnapshot(SNAPSHOT);
  const dir = path.join(ROOT, 'reports');
  const cands = fs.readdirSync(dir)
    .filter((f) => /^quality-baseline-.*\.json$/.test(f))
    .sort()
    .map((f) => ({ f, d: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }))
    .filter((x) => x.d && x.d.set === 'all' && typeof x.d.timeouts === 'number' && x.d.n > 0);
  assert.ok(cands.length > 0, '★ 缺 live 全量报告（reports/quality-baseline-*.json，set=all）');
  const live = cands[cands.length - 1].d;
  const res = replay(snap, { scorer: 'base', limit: 5 });
  const dd = Math.abs(res.overall.hit3 - live.hit3);
  assert.ok(dd <= 5, `★ 快照与 live 差 ${dd}pp（快照 ${res.overall.hit3}% vs live ${live.hit3}%）> 5pp，快照不代表线上`);
  const perSet = [];
  for (const [g, s] of Object.entries(res.sets)) {
    const l = live.sets && live.sets[g];
    if (!l) continue;
    const d = Math.abs(s.hit3 - l.hit3);
    if (d > 5) perSet.push(`${g}: 快照 ${s.hit3}% vs live ${l.hit3}% (Δ${d.toFixed(1)}pp)`);
  }
  assert.deepEqual(perSet, [], '★ 分组偏差超 5pp：\n' + perSet.join('\n'));
});

test('U-252 D1: 语料被改一字节必须拒读（fail-closed，不许"照算不误"）', () => {
  const tmp = path.join(os.tmpdir(), `u252-tamper-${process.pid}.json`);
  const text = fs.readFileSync(SNAPSHOT, 'utf8');
  const mutated = text.replace(/("stars":\s*)(\d+)/, (m, p1, p2) => p1 + (Number(p2) + 1));
  assert.notEqual(mutated, text, '★ 语料里没有可被改动的 stars 字段，测试样本失效');
  fs.writeFileSync(tmp, mutated, 'utf8');
  try {
    assert.throws(() => loadSnapshot(tmp), /sha256/, '★ 改动一字节后仍能读：sha256 校验形同虚设');
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

test('U-252 D2: 删掉一条已知命中必须报 missing 并点名（不许静默跳过）', () => {
  const snap = loadSnapshot(SNAPSHOT);
  assert.deepEqual(findMissing(snap), [], '★ 语料自检就不干净：presentWants 有对不上 candidates 的条目');
  const clone = JSON.parse(JSON.stringify(snap));
  const q = clone.queries.find((x) => (x.presentWants || []).length > 0);
  assert.ok(q, '★ 语料里没有任何已知命中，无法构造负例');
  const victim = q.presentWants[0];
  q.candidates = q.candidates.filter((c) => segment(c.name) !== victim);
  const miss = findMissing(clone, snap); // current=clone, previous=语料
  assert.ok(miss.some((m) => m.name === victim && m.q === q.q), `★ 删掉 "${victim}" 后没有报 missing（这正是"基线被偷偷放宽"的形态）`);
});

test('U-252 D3: 判别力——维护信号必须能改变名次（否则 A/B 的"没变化"没有信息量）', () => {
  const now = Date.parse('2026-10-25T00:00:00Z');
  const mk = (name, relevance, popularity, archived, updated) => ({ name, relevance, popularity, archived, updated, index: 0, score: 0.8 * relevance + 0.2 * popularity });
  // 死项目（archived，但相关度高）vs 活项目（相关度略低）—— 同权公式会把死项目排前面
  const dead = mk('old/dead-lib', 0.9, 0.9, true, '2020-01-01T00:00:00Z');
  const alive = mk('new/alive-lib', 0.85, 0.85, false, '2026-10-20T00:00:00Z');
  const ctx = { nowMs: now };
  const base = rankCandidates([dead, alive], 'base', ctx).map((r) => segment(r.c.name));
  const maint = rankCandidates([dead, alive], 'maintenance', ctx).map((r) => segment(r.c.name));
  assert.equal(base[0], 'dead-lib', '★ base 应把死项目排第一（否则样本本身不构成对比）');
  assert.equal(maint[0], 'alive-lib', '★ 维护分层没有把死项目挪后：判别力为零，任何"无变化"的结论都不可信');
  // 同分必须按 index 稳定排序（不许让 ties 随机翻转名次）
  const a = { name: 'x/a', relevance: 0.5, popularity: 0.5, index: 1 };
  const b = { name: 'x/b', relevance: 0.5, popularity: 0.5, index: 2 };
  assert.deepEqual(rankCandidates([b, a], 'base', ctx).map((r) => r.c.name), ['x/a', 'x/b'], '★ 同分未按 index 稳定排序');
});
