// C-3 预注册锁门（骨架同 test-a9 / test-c1-prereg-lock）
//   ① 预注册未被事后改动（sha 三重一致：文件 / prereg.sha256 / 两份 readings）
//   ② 口径字面量与裁决用值一致（噪声率定义 / 两个计数 / 重锁记录在案）
//   ③ 一切数字可由两查 112 条读数**机械重算**（逐查询汇总 → 逐查询判定 → 聚合决策 → 与 compare.json 一致）
//   负例（内存）：改预注册一字节 / 改一条读数 / 翻转判定 ⇒ 各自红
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(root, 'reports/gates/c3-noise-registry-desc-2026-10-12');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const REG_SRC = ['npm', 'crates.io', 'NuGet'];

function checkPrereg(preregBytes, readingsList, shaFileText) {
  const t = preregBytes.toString('utf8');
  const locked = shaFileText.trim().split(/\s+/)[0];
  assert.equal(sha(preregBytes), locked, '预注册文本 sha256 与 prereg.sha256 不一致 ⇒ 文本被事后改动（本项作废）');
  for (const r of readingsList) assert.equal(r.preregSha256, locked, `readings(${r.side}) 记录的 sha 与锁定值不一致`);
  // 口径字面量
  assert.match(t, /噪声率\*\* = `NoiseFlagged=true` 条数 ÷ 该查询结果总数/, '预注册缺噪声率定义字面量');
  assert.match(t, /`rel>0`：`Relevance > 0` 的条数/, '预注册缺 rel>0 计数定义');
  assert.match(t, /`rel=1`：`Relevance >= 1` 的条数/, '预注册缺 rel>=1 计数定义');
  assert.match(t, /; kw: /, '预注册缺追加标记字面量（; kw: 半角）');
  assert.match(t, /附二：重锁记录/, '预注册缺重锁记录（透明性要求）');
  assert.match(t, /统一 `; kw: `/i, '预注册未记录「统一 ; kw: 」的处置');
}

// ---------- ③ 机械重算：两次读数 → 逐查询汇总 → 判定 → 决策 ----------
function summarize(readings) {
  const out = {};
  for (const i of readings.items) {
    const q = out[i.query] = out[i.query] || { n: 0, noise: 0, relGt0: 0, relGe1: 0, kwTagged: 0 };
    q.n++; if (i.noiseFlagged) q.noise++;
    if (i.relevance > 0) q.relGt0++;
    if (i.relevance >= 1) q.relGe1++;
    if (i.descHasKwTag && REG_SRC.includes(i.platform)) q.kwTagged++;
  }
  for (const q of Object.values(out)) q.noiseRate = +(q.noise / q.n).toFixed(4);
  return out;
}
function decide(before, after) {
  const sb = summarize(before), sa = summarize(after);
  const EPS = 0.01;
  const per = [];
  for (const q of Object.keys(sb)) {
    const b = sb[q], a = sa[q];
    if (!a) { per.push({ query: q, status: 'no-conclusion' }); continue; }
    const dNoise = +(a.noiseRate - b.noiseRate).toFixed(4);
    const dG0 = a.relGt0 - b.relGt0, dG1 = a.relGe1 - b.relGe1;
    let verdict;
    if (dNoise > 0 || dG0 < 0 || dG1 < 0) verdict = '回滚（有指标恶化）';
    else if (Math.abs(dNoise) < EPS && dG0 === 0 && dG1 === 0) verdict = '需复测（差异贴阈值）';
    else verdict = '通过（不升且不降）';
    per.push({ query: q, status: 'ok', verdict, delta: { noiseRate: dNoise, relGt0: dG0, relGe1: dG1 } });
  }
  const ok = per.filter(p => p.status === 'ok');
  const nRetest = ok.filter(p => p.verdict.startsWith('需复测')).length;
  const nPass = ok.filter(p => p.verdict.startsWith('通过')).length;
  const anyRollback = ok.some(p => p.verdict.startsWith('回滚'));
  const anyNC = per.some(p => p.status === 'no-conclusion');
  const decision = ok.length === 0 ? '**无结论**（两条查询均无有效读数）'
    : anyRollback ? `**回滚**：有 ${ok.filter(p => p.verdict.startsWith('回滚')).length} 条查询指标恶化 ⇒ 改动不保留`
      : (nRetest === 0 && nPass === ok.length) ? (anyNC ? '**部分通过**：有效查询通过，另有查询无结论（如实记）' : '**通过**：噪声率不升且满分命中数不降 ⇒ 保留改动')
        : `**交人裁**：${nPass} 条查询通过、**${nRetest} 条贴阈值（Δ<1pp，单次口径不足以定论）** ⇒ 按预注册 §5「不据此放行/回滚」` + (anyNC ? '；另有查询无结论' : '');
  return { per, decision };
}
function checkRecalc(before, after, compare) {
  const d = decide(before, after);
  for (const p of compare.perQuery) {
    if (p.status !== 'ok') continue;
    const x = d.per.find(y => y.query === p.query);          // ★per 是数组 ⇒ 必须 find（首版误当字典索引 ⇒ undefined）
    assert.ok(x && x.status === 'ok', `compare 的查询「${p.query}」在读数里不存在`);
    assert.deepEqual(p.delta, x.delta, `${p.query}: Δ 与逐条读数重算不一致`);
    assert.equal(p.verdict, x.verdict, `${p.query}: 判定与逐条读数重算不一致`);
  }
  assert.equal(compare.decision, d.decision, '聚合决策与逐条读数重算不一致');
  return d;
}

const preregBytes = fs.readFileSync(path.join(DIR, '预注册-C3.md'));
const shaFileText = fs.readFileSync(path.join(DIR, 'prereg.sha256'), 'utf8');
const before = JSON.parse(fs.readFileSync(path.join(DIR, 'readings-before.json'), 'utf8'));
const after = JSON.parse(fs.readFileSync(path.join(DIR, 'readings-after.json'), 'utf8'));
const compare = JSON.parse(fs.readFileSync(path.join(DIR, 'compare.json'), 'utf8'));

test('C-3 锁 ①②: 预注册未被事后改动（含重锁记录），且口径字面量一致', () => {
  checkPrereg(preregBytes, [before, after], shaFileText);
});

test('C-3 锁 ③: 逐查询汇总/判定/聚合决策可由 112 条读数机械重算（当前：1 通过 + 1 贴阈值 ⇒ 交人裁）', () => {
  const d = checkRecalc(before, after, compare);
  assert.equal(d.decision.startsWith('**交人裁**'), true, '当前读数下决策应为「交人裁」');
  assert.equal(before.items.length, 112, '改前读数应为 112 条');
  assert.equal(after.items.length, 112, '改后读数应为 112 条');
});

test('C-3 负例（内存，不写盘）: 改预注册一字节 / 改一条读数 / 翻转判定 ⇒ 各自红', () => {
  // ① 改预注册一字节 ⇒ sha 失配
  assert.throws(() => checkPrereg(Buffer.concat([preregBytes, Buffer.from(' ')]), [before, after], shaFileText),
    /sha256 与 prereg\.sha256 不一致/);
  // ② 改一条读数（把 after 某条 noiseFlagged 翻成 true）⇒ 汇总/判定变 ⇒ 红
  const t2 = JSON.parse(JSON.stringify(after));
  const victim = t2.items.find(i => !i.noiseFlagged);
  victim.noiseFlagged = true;
  assert.throws(() => checkRecalc(before, t2, compare), /Δ 与逐条读数重算不一致|判定与逐条读数重算不一致|聚合决策与逐条读数重算不一致/);
  // ③ 翻转判定（把 compare 的决策改成"通过"）⇒ 红
  const t3 = JSON.parse(JSON.stringify(compare));
  t3.decision = '**通过**：噪声率不升且满分命中数不降 ⇒ 保留改动';
  assert.throws(() => checkRecalc(before, after, t3), /聚合决策与逐条读数重算不一致/);
});
