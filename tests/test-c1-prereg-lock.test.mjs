// C-1 预注册锁门（骨架同 tests/test-a9-prereg-lock.test.mjs）
//   守卫三件事：① 预注册文本未被事后改动（sha 三重一致）② 阈值/口径字面量与裁决用值一致
//             ③ 逐对判定可由逐次读数**机械重算**（flap → 可判性 → 集合差 → 判定 → 决策）
//   负例（内存，不写盘）：改预注册一字节 / 改 flap 阈值 / 翻一条读数 ⇒ 各自红在对的理由
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(root, 'reports/gates/c1-concept-vs-anchored-2026-10-12');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');

// ---------- ① 预注册锁定 + 口径字面量 ----------
function checkPrereg(preregBytes, readings, shaFileText) {
  const t = preregBytes.toString('utf8');
  assert.equal(sha(preregBytes), readings.preregSha256,
    '预注册文本 sha256 与 readings.json 记录不一致 ⇒ 文本被事后改动（本项作废）');
  if (shaFileText !== undefined) {
    assert.equal(shaFileText.trim().split(/\s+/)[0], readings.preregSha256,
      'prereg.sha256 与 readings.json 记录的 sha 不一致');
  }
  // 口径字面量
  assert.match(t, /6 对 × 2 序 × 2 次\/序 × 2 臂 = 48/, '预注册缺跑次数等式（48 的算术）');
  assert.match(t, /flap\(臂, 对\) = max\(该臂该对的 4 次读数 count\) − min/, '预注册缺 flap 定义字面量');
  assert.match(t, /≥ 3\/6/, '预注册缺决策阈值（扩召回 ≥3/6）字面量');
  assert.match(t, /双向先手平衡/, '预注册缺序设计命名（双向先手平衡）');
  assert.equal(readings.flapDef.includes('max'), true, 'readings.flapDef 应含 flap 定义');
}

// ---------- ② 判定可由逐次读数机械重算 ----------
function recalc(readings) {
  const byPair = {};
  for (const i of readings.items) {
    if (i.count === undefined) continue;                      // 跳过 kw-mismatch / missing-file 记账项
    byPair[i.pair] = byPair[i.pair] || { concept: { counts: [], keys: new Set() }, anchored: { counts: [], keys: new Set() } };
    const slot = byPair[i.pair][i.role];
    slot.counts.push(i.count);
    for (const k of (i.keys || [])) slot.keys.add(k);
  }
  const perPair = {};
  for (const [p, v] of Object.entries(byPair)) {
    const flapC = Math.max(...v.concept.counts) - Math.min(...v.concept.counts);
    const flapA = Math.max(...v.anchored.counts) - Math.min(...v.anchored.counts);
    const judgeable = flapC === 0 && flapA === 0;
    const aMinusB = [...v.concept.keys].filter(x => !v.anchored.keys.has(x)).length;
    const bMinusA = [...v.anchored.keys].filter(x => !v.concept.keys.has(x)).length;
    let verdict;
    if (!judgeable) verdict = '无结论（条件未钉住）';
    else if (aMinusB > 0) verdict = '缩召回（红）';
    else if (bMinusA > 0) verdict = '扩召回';
    else verdict = '等价（无收益）';
    perPair[p] = { flap: { concept: flapC, anchored: flapA }, judgeable, verdict, aMinusB, bMinusA };
  }
  const judgeable = Object.values(perPair).filter(x => x.judgeable).length;
  const shrink = Object.values(perPair).filter(x => x.verdict === '缩召回（红）').length;
  const grow = Object.values(perPair).filter(x => x.verdict === '扩召回').length;
  const decision = shrink > 0 ? '打回' : (grow >= 3 ? '放行' : '无收益/样本不足');
  return { perPair, judgeable, shrink, grow, decision, total: Object.keys(perPair).length };
}

function checkRecalc(readings) {
  const r = recalc(readings);
  assert.equal(readings.totalUnderlyingQueries, readings.items.filter(i => i.count !== undefined).length,
    '逐次读数条数与实际条目不一致');
  assert.equal(readings.summary.pairsJudgeable, r.judgeable, '可判对数与逐次重算不一致');
  assert.equal(readings.summary.thresholds.shrinkCount, r.shrink, '缩召回对数与逐次重算不一致');
  assert.equal(readings.summary.thresholds.growCount, r.grow, '扩召回对数与逐次重算不一致');
  for (const p of readings.perPair) {
    const x = r.perPair[p.pair];
    assert.ok(x, `逐对表含未知对：${p.pair}`);
    assert.deepEqual(p.flap, x.flap, `${p.pair}: flap 与逐次重算不一致`);
    assert.equal(p.judgeable, x.judgeable, `${p.pair}: 可判性与逐次重算不一致`);
    assert.equal(p.verdict, x.verdict, `${p.pair}: 判定与逐次重算不一致`);
  }
  const shrink = r.shrink;
  const expectDecision = shrink > 0 ? `**打回**：有 ${shrink} 对呈「缩召回」⇒ 按预注册 §7 不得放行`
    : (r.grow >= 3 ? `**放行**：扩召回成立 ${r.grow}/6 ≥ 3 ⇒ 进入 3-2d/词表设计`
      : `**记「无收益」/样本不足**：扩召回仅 ${r.grow}/${r.total}，且可判对数 ${r.judgeable}/6`);
  assert.equal(readings.decision, expectDecision, '决策与逐次重算不一致');
  return r;
}

const preregBytes = fs.readFileSync(path.join(DIR, '预注册-C1.md'));
const shaFileText = fs.readFileSync(path.join(DIR, 'prereg.sha256'), 'utf8');
const readings = JSON.parse(fs.readFileSync(path.join(DIR, 'readings.json'), 'utf8'));

test('C-1 锁 ①②: 预注册未被事后改动，且口径字面量（48 算式 / flap 定义 / ≥3/6 / 双向先手平衡）与裁决用值一致', () => {
  checkPrereg(preregBytes, readings, shaFileText);
});

test('C-1 锁 ③: 逐对判定与决策可由逐次读数机械重算（当前：可判 4/6、缩召回 4 ⇒ 打回）', () => {
  const r = checkRecalc(readings);
  assert.equal(r.shrink >= 1, true, '当前读数应至少有 1 对缩召回');
});

test('C-1 负例（内存，不写盘）: 改预注册一字节 / 放宽 flap 阈值 / 翻一条读数 ⇒ 各自红在对的理由', () => {
  // ① 改预注册一字节 ⇒ sha 失配
  const mutated = Buffer.concat([preregBytes, Buffer.from(' ')]);
  assert.throws(() => checkPrereg(mutated, readings), /sha256 与 readings\.json 记录不一致/);
  // ② 放宽 flap 阈值（>0 → >2）⇒ 判定表与重算不一致
  const loose = JSON.parse(JSON.stringify(readings));
  for (const p of loose.perPair) { p.judgeable = true; p.verdict = p.verdict === '无结论（条件未钉住）' ? '等价（无收益）' : p.verdict; }
  assert.throws(() => checkRecalc(loose), /可判性与逐次重算不一致|判定与逐次重算不一致/);
  // ③ 翻一条读数（把 rf/concept 某次 count 改成不同值）⇒ flap 变化 ⇒ 判定/汇总翻转 ⇒ 红
  //   注：断言只要求"红在不一致"，不锁死红在哪一层（实测它先撞汇总层的"可判对数"断言——链完整即可）
  const flipped = JSON.parse(JSON.stringify(readings));
  const victim = flipped.items.find(i => i.pair === 'rf' && i.role === 'concept' && i.count !== undefined);
  victim.count = victim.count + 1;
  assert.throws(() => checkRecalc(flipped), /不一致/);
});
