// C-3b 预注册锁门（骨架同 test-c3-prereg-lock）
//   ① 预注册未被事后改动（sha 三重一致）② 口径字面量（N=3 / flap 定义 / 决策规则）
//   ③ flap / stable / 决策可由 6 次读数**机械重算** ④ 负例（内存）：改一字节 / 翻一次读数 / 翻转判定
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(root, 'reports/gates/c3b-stability-recheck-2026-10-12');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');

function checkPrereg(preregBytes, readings, shaFileText) {
  const t = preregBytes.toString('utf8');
  const locked = shaFileText.trim().split(/\s+/)[0];
  assert.equal(sha(preregBytes), locked, '预注册文本 sha256 与 prereg.sha256 不一致 ⇒ 被事后改动（本项作废）');
  assert.equal(readings.preregSha256, locked, 'readings 记录的 sha 与锁定值不一致');
  assert.match(t, /N = 3/, '预注册缺 N=3 字面量');
  assert.match(t, /flap\(指标,查询\) = max\(3 次\) − min\(3 次\)/, '预注册缺 flap 定义字面量');
  assert.match(t, /两查询 flap 全 0 \*\*且\*\* N 次读数与 C-3 单次\*\*一致\*\*/, '预注册缺决策规则字面量');
}

function recalc(readings) {
  const per = readings.perQuery.map(p => {
    const flap = {};
    for (const k of ['noise', 'relGt0', 'relGe1']) {
      const vals = p.runs.map(r => r[k]);
      flap[k] = vals.length ? Math.max(...vals) - Math.min(...vals) : null;
    }
    const stable = flap.noise === 0 && flap.relGt0 === 0 && flap.relGe1 === 0;
    const uniq = [...new Set(p.runs.map(r => r.noise))];
    const c3Consistent = uniq.length === 1 && p.c3Single.noise === uniq[0];
    return { query: p.query, status: p.runs.length >= 2 ? 'ok' : 'no-conclusion', flap, stable, c3Consistent };
  });
  const ok = per.filter(p => p.status === 'ok');
  const allStable = ok.length === per.length && ok.every(p => p.stable);
  const allConsistent = allStable && ok.every(p => p.c3Consistent);
  const decision = ok.length === 0 ? '**无结论**（两查询均无有效读数）'
    : (allConsistent ? '**C-3 结论稳定**：两查询 flap 全 0 且与 C-3 单次一致 ⇒ q1 的 Δ0 是真实无变化（非抖动）⇒ 「贴阈值」保留意见解除'
      : (allStable ? '**单次读数不可靠**：N 次一致但与 C-3 单次不同 ⇒ C-3 该侧需重做（升格为缺陷）'
        : '**该查询读数在抖**：flap>0 ⇒ 「需复测」成立 ⇒ C-3 的「交人裁」保持'));
  return { per, decision };
}

function checkRecalc(readings) {
  const r = recalc(readings);
  for (const p of readings.perQuery) {
    const x = r.per.find(y => y.query === p.query);
    assert.ok(x, `逐查询表含未知查询：${p.query}`);
    assert.deepEqual(p.flap, x.flap, `${p.query}: flap 与逐次读数重算不一致`);
    assert.equal(p.stable, x.stable, `${p.query}: stable 与逐次读数重算不一致`);
    assert.equal(p.c3Consistent, x.c3Consistent, `${p.query}: 与 C-3 单次的一致性判定不一致`);
  }
  assert.equal(readings.decision, r.decision, '决策与逐次读数重算不一致');
  return r;
}

const preregBytes = fs.readFileSync(path.join(DIR, '预注册-C3b.md'));
const shaFileText = fs.readFileSync(path.join(DIR, 'prereg.sha256'), 'utf8');
const readings = JSON.parse(fs.readFileSync(path.join(DIR, 'readings-recheck.json'), 'utf8'));
const recheck = JSON.parse(fs.readFileSync(path.join(DIR, 'recheck.json'), 'utf8'));

test('C-3b 锁 ①②: 预注册未被事后改动，且口径字面量（N=3 / flap 定义 / 决策规则）一致', () => {
  checkPrereg(preregBytes, readings, shaFileText);
});

test('C-3b 锁 ③: flap / stable / 决策可由 6 次读数机械重算（当前：两查询 flap 全 0 ⇒ 结论稳定）', () => {
  const r = checkRecalc(readings);
  assert.equal(r.decision.startsWith('**C-3 结论稳定**'), true, '当前读数下决策应为「C-3 结论稳定」');
  assert.equal(readings.perQuery.reduce((a, p) => a + p.runs.length, 0), 6, '应为 6 次读数');
  assert.equal(recheck.preregSha256, readings.preregSha256, 'recheck.json 的 sha 与 readings 不一致');
});

test('C-3b 负例（内存，不写盘）: 改预注册一字节 / 翻一次读数 / 翻转判定 ⇒ 各自红', () => {
  assert.throws(() => checkPrereg(Buffer.concat([preregBytes, Buffer.from(' ')]), readings, shaFileText),
    /sha256 与 prereg\.sha256 不一致/);
  // 翻一次读数（把 q1 某次 noise +1）⇒ flap 变 1 ⇒ stable 翻假 ⇒ 红
  const t2 = JSON.parse(JSON.stringify(readings));
  const vic = t2.perQuery[0].runs[0]; vic.noise = vic.noise + 1;
  assert.throws(() => checkRecalc(t2), /flap 与逐次读数重算不一致|stable 与逐次读数重算不一致|决策与逐次读数重算不一致|与 C-3 单次的一致性判定不一致/);
  // 翻转判定（决策改成"在抖"）⇒ 红
  const t3 = JSON.parse(JSON.stringify(readings));
  t3.decision = '**该查询读数在抖**：flap>0 ⇒ 「需复测」成立 ⇒ C-3 的「交人裁」保持';
  assert.throws(() => checkRecalc(t3), /决策与逐次读数重算不一致/);
});
