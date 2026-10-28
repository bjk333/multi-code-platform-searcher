// U-175（2026-10-19；**v1.69.0 / B3-16 改写为行为门**）：SE / HN 的 0 命中必须讲清 AND 机制，且**不得自动放宽**。
//
// 背景：v4 提案认为「SE 8 查询全零 ⇒ 研究路径没接查询改写」。实测（2026-10-19）根因是 **AND 语义**：
//   `kubernetes operators` 5 条 → 加一个无意义词即 0 条（SE 与 HN 同）。放宽虽能把 0→5，但 4/4 组的结果
//   只靠原查询 1–2 个词匹配（"citation tracking" ⇒ igraph 引用网络）⇒ 自动放宽 = 用精确性换噪声。
//   故**只增解释，不加二次请求**。
//
// 为什么改写：原门 grep 源码里的 `AND 语义`、`$tc -ge 3`、`不自动放宽` 三处正则。
//   它证明不了两件最要紧的事：① 真的只在 ≥3 词时附注；② 真的**只发一次请求**（没偷偷放宽）。
//   现在每条臂跑真实的引擎函数（真夹具），断言 `reason` 文案与**请求次数**。
//
// ★"不放宽"这条只能用请求数证明：放宽一定会多一次 HTTP（或被本地改写后重发），
//   而多一次请求在结果集上与"只发一次"完全同形 —— 只看条数永远看不出来。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixture } from './behavior/lib/fixture-server.mjs';
import { runEngine } from './behavior/lib/engine-probe.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const REPORT = path.join(ROOT, 'reports', 'gates', 'p1c-query-rewrite-2026-10-19', 'README.md');

const SE_ZERO = [{ host: 'api.stackexchange.com', path: /^\/2\.3\/search\/advanced/, body: { items: [] } }];
const HN_ZERO = [{ host: 'hn.algolia.com', path: /^\/api\/v1\/search/, body: { hits: [] } }];

async function run({ fn, status, keyword, routes }) {
  const fx = await startFixture(routes);
  try {
    const r = await runEngine({ fn, params: { Keyword: keyword, Limit: 5, __statusName: status }, port: fx.port });
    assert.ok(r.payload, '探针没吐 JSON：' + String(r.stderr).slice(-500));
    assert.equal(r.payload.ok, true, '引擎不该把异常抛给调用方：' + r.payload.error);
    assert.equal(fx.unmatched.length, 0, '有请求没打到夹具路由：' + JSON.stringify(fx.unmatched.map((h) => h.host + h.path)));
    return { p: r.payload, hits: fx.hits };
  } finally {
    await fx.close();
  }
}

test('U-175-1 SE：0 命中 + ≥3 词 ⇒ reason 讲清 AND 语义与词数，并说明不自动放宽', async () => {
  const { p, hits } = await run({ fn: 'Search-StackExchange', status: 'SE', keyword: 'kubernetes operators xyzzy', routes: SE_ZERO });
  assert.equal(p.count, 0);
  assert.equal(p.status, 'empty', '0 命中是 empty（不是 error）');
  assert.match(String(p.reason), /AND 语义：3 个词/, '必须点明"几个词同时出现"；实际：' + p.reason);
  assert.match(String(p.reason), /不自动放宽/, '必须写明不放宽（否则下一个人会以为是漏了改写）；实际：' + p.reason);
  assert.equal(hits.length, 1, '★ 只许发一次请求：放宽查询必然会多打一次；实际 ' + hits.length + ' 次：' + hits.map((h) => h.path).join(' | '));
});

test('U-175-2 SE：0 命中但只有 2 个词 ⇒ 不许附 AND 注解（短查询零命中是"没有"，不是"太窄"）', async () => {
  const { p, hits } = await run({ fn: 'Search-StackExchange', status: 'SE', keyword: 'kubernetes operators', routes: SE_ZERO });
  assert.equal(p.status, 'empty');
  assert.doesNotMatch(String(p.reason), /AND 语义/, '2 个词不该触发 AND 注解；实际：' + p.reason);
  assert.equal(String(p.reason), '检索成功但 0 命中', '短查询就是普通的零命中');
  assert.equal(hits.length, 1, '同样只许一次请求');
});

test('U-175-3 HN：同口径（Algolia 的 query 也是 AND 语义）', async () => {
  const { p, hits } = await run({ fn: 'Search-HackerNews', status: 'HackerNews', keyword: 'kubernetes operators xyzzy', routes: HN_ZERO });
  assert.equal(p.status, 'empty');
  assert.match(String(p.reason), /AND 语义：3 个词/, 'HN 必须与 SE 同口径；实际：' + p.reason);
  assert.match(String(p.reason), /不自动放宽/);
  assert.equal(hits.length, 1, '★ HN 也只许一次请求；实际：' + hits.length);
});

test('U-175-4 证据报告仍在（这张门是它推出来的，不是反过来）', () => {
  assert.ok(fs.existsSync(REPORT), '证据报告必须存在：' + REPORT);
  const r = fs.readFileSync(REPORT, 'utf8');
  assert.match(r, /AND|放宽/, '报告里必须记录"放宽后是噪声"的实测结论');
});
