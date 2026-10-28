// A-9（任务书 §3 批 A，2026-10-11）：假阴性分类表的**预注册锁**。
//   任务书原话：「T1 阈值先预注册再跑；事后改阈值 ⇒ 本项作废」。本门把这句话变成可弄红的判据：
//   ① 预注册文本的当前 sha256 必须等于 readings.json 里记录的那份（跑电池前取的）；改一个字节 ⇒ 红。
//   ② 预注册文本里的阈值字面量（≥5% / ≥2 条/查询）必须与 readings.json 里实际用于裁决的阈值一致。
//   ③ readings.json 的 T1/T2 结论必须能由其自带的逐条判定**机械重算**出来（防"表改了结论没改"或反之）。
//   负例：在内存里篡改预注册文本 / 篡改阈值 / 改一条判定 ⇒ 各自红在对的理由（不写盘）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(root, 'reports/gates/a9-false-negative-2026-10-11');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');

export function checkPrereg(preregBytes, readings) {
  assert.equal(sha(preregBytes), readings.preregSha256, '预注册文本 sha256 与 readings.json 记录不一致 ⇒ 阈值/定义被事后改动 ⇒ 本项作废');
  const text = preregBytes.toString('utf8');
  assert.match(text, /≥\s*\*{0,2}5%/, '预注册文本缺 T1 的 5% 阈值字面量');
  assert.match(text, /≥\s*\*{0,2}2\*{0,2}\s*条/, '预注册文本缺 T1 的 ≥2 条/查询 阈值字面量');
  assert.equal(readings.t1.thresholdPct, 5.0); assert.equal(readings.t1.thresholdPerQuery, 2);
}
export function recompute(readings) {
  const items = readings.items; const total = readings.totalResults;
  const rel = items.filter(i => i.judgedRelevant === true);
  const perQuery = {}; for (const i of rel) perQuery[i.case] = (perQuery[i.case] || 0) + 1;
  const pct = Math.round(10000 * rel.length / total) / 100;
  const byPct = pct >= readings.t1.thresholdPct;
  const byQuery = Object.values(perQuery).some(v => v >= readings.t1.thresholdPerQuery);
  const exceeded = byPct || byQuery;
  const visExplained = rel.filter(i => ['file-only', 'preview-truncated-outside'].includes(i.substantiveLayer)).length;
  return { relCount: rel.length, perQuery, pct, byPct, byQuery, exceeded, visExplained, t2: exceeded && visExplained === 0 };
}
export function assertConsistent(readings) {
  const r = recompute(readings);
  assert.equal(readings.judgedRelevantCount, r.relCount, '判定相关条数与逐条表不一致');
  assert.deepEqual(readings.judgedRelevantPerQuery, r.perQuery, '逐查询相关数与逐条表不一致');
  assert.equal(readings.t1.semanticFnPct, r.pct, 'T1 百分比重算不一致');
  assert.equal(readings.t1.exceeded, r.exceeded, 'T1 结论与逐条表重算不一致');
  assert.equal(readings.t2.satisfied, r.t2, 'T2 结论与逐条表重算不一致');
  for (const i of readings.items) assert.ok(typeof i.judgeReason === 'string' && i.judgeReason.length > 0, `判定缺理由：${i.case} ${i.name}`);
  return r;
}

const prereg = fs.readFileSync(path.join(DIR, '预注册-A9-T1判据.md'));
const readings = JSON.parse(fs.readFileSync(path.join(DIR, 'readings.json'), 'utf8'));

test('A-9 锁 ①②: 预注册文本未被事后改动，且阈值字面量与裁决用阈值一致', () => { checkPrereg(prereg, readings); });

test('A-9 锁 ③: readings.json 的 T1/T2 结论可由逐条判定机械重算（当前读数：相关 2 条、b6=2 ⇒ T1 按「≥2 条/查询」超阈）', () => {
  const r = assertConsistent(readings);
  assert.equal(readings.relevanceZero.count, readings.items.length);
  console.log(`[A-9] total=${readings.totalResults} rel0=${readings.relevanceZero.count} judgedRelevant=${r.relCount} pct=${r.pct} perQuery=${JSON.stringify(r.perQuery)} T1=${r.exceeded} T2=${r.t2}`);
});

test('A-9 负例（内存，不写盘）: 改预注册一个字节 / 改阈值 / 翻一条判定 ⇒ 各自红在对的理由', () => {
  const mutated = Buffer.from(prereg); mutated[mutated.length - 1] ^= 0xff;
  assert.throws(() => checkPrereg(mutated, readings), /sha256 与 readings\.json 记录不一致/);
  const badThr = structuredClone(readings); badThr.t1.thresholdPct = 10;
  assert.throws(() => checkPrereg(prereg, badThr), /Expected values to be strictly equal/);
  const flipped = structuredClone(readings); const idx = flipped.items.findIndex(i => i.judgedRelevant);
  flipped.items[idx].judgedRelevant = false;   // 把一条相关改成不相关，但结论字段不动 ⇒ 重算必红
  assert.throws(() => assertConsistent(flipped), /判定相关条数与逐条表不一致/);
  const noReason = structuredClone(readings); noReason.items[0].judgeReason = '';
  assert.throws(() => assertConsistent(noReason), /判定缺理由/);
});
