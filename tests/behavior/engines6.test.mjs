// U-283（v1.65.0）：**最后两个引擎** —— HuggingFace 与 DeepSeek。做完这一批，26 个引擎函数全部有行为臂。
//
// 两个都是封套（`contract=engine/1`），都不能套用"数结果条数"那套执行器 —— 理由见 engines5 头注。
// 它们各自还带一件只有真跑才看得见的事：
//
//   · HuggingFace —— **三次顺序请求**（models / datasets / spaces），失败分"全挂"与"挂一部分"两档。
//     全挂 ⇒ `failure=error`；挂一部分且仍有产出 ⇒ 仍是 error 但 reason 明说"部分 kind 失败"，
//     且必须留 degraded 告警。把它写成"0 条=空"就是把"连不上"说成"没有"（R5-TLS 那次的形状）。
//   · DeepSeek —— 唯一**计费**的源，reasonCode 五档里 402=quota-exhausted 直接决定要不要去充值。
//     还有一档 `filtered`：返回了 N 条但全被置信度门槛丢掉 —— 那不是"源没结果"，是我们自己丢的。
import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixture } from './lib/fixture-server.mjs';
import { runEngine } from './lib/engine-probe.mjs';

async function run(routes, { fn, status, params, preamble = '' }) {
  const fx = await startFixture(routes);
  try {
    const r = await runEngine({ fn, params: { ...params, __statusName: status }, port: fx.port, preamble });
    assert.ok(r.payload, '探针没吐 JSON：' + r.stderr.slice(-500));
    assert.equal(r.payload.ok, true, '引擎不该把异常抛给调用方：' + r.payload.error);
    assert.equal(r.payload.count, 1, '封套类引擎必须只返回**一个**封套');
    const e = r.payload.result[0];
    assert.equal(e.contract, 'engine/1', '封套契约版本');
    return { e, fx, payload: r.payload };
  } finally {
    await fx.close();
  }
}

const HF_HITS = (n) => Array.from({ length: n }, (_, i) => ({ id: `org/m${i + 1}`, downloads: 1000 * (i + 1), likes: i, license: 'apache-2.0' }));

// ─────────────────────────────── HuggingFace（三次顺序请求）───────────────────────────────

const HF = { fn: 'Search-HuggingFace', status: 'HF', params: { Keyword: 'diffusers', Limit: 2 } };
const hfRoute = (kind, body, extra = {}) => ({ host: 'huggingface.co', path: '/api/' + kind, body, ...extra });

test('U-283-A HuggingFace：三个 kind 各一条 ⇒ results 3，Name 带 kind 前缀，三次请求都带搜索词', async () => {
  const { e, fx } = await run([
    hfRoute('models', HF_HITS(1)),
    hfRoute('datasets', [{ id: 'org/ds1', downloads: 5, likes: 1 }]),
    hfRoute('spaces', [{ id: 'org/sp1', downloads: 2, likes: 0 }]),
  ], HF);
  assert.equal(e.results.length, 3, '三个 kind 各一条');
  assert.deepEqual(e.results.map((r) => r.Name), ['model:org/m1', 'dataset:org/ds1', 'space:org/sp1'], 'Name 必须带 kind 前缀（否则三种条目在结果里分不开）');
  assert.equal(e.results[0].Platform, 'HuggingFace');
  assert.equal(e.results[0].Unit, 'downloads/month');
  assert.equal(e.results[0].Url, 'https://huggingface.co/org/m1');
  assert.equal(e.results[1].Url, 'https://huggingface.co/datasets/org/ds1', 'datasets 的 URL 前缀不同');
  assert.equal(e.results[2].Url, 'https://huggingface.co/spaces/org/sp1', 'spaces 的 URL 前缀不同');
  assert.equal(e.failure, null);
  assert.equal(e.requests.succeeded, 3, '三个 kind 各一次');
  assert.equal(fx.hits.length, 3);
  for (const h of fx.hits) assert.ok(h.path.includes('search=diffusers') && h.path.includes('limit=2'), '每个 kind 都要带搜索词与页大小：' + h.path);
});

test('U-283-B HuggingFace：三个 kind 都空 ⇒ results 0 且**不带 failure**（搜了没有 ≠ 连不上）', async () => {
  const { e } = await run([hfRoute('models', []), hfRoute('datasets', []), hfRoute('spaces', [])], HF);
  assert.equal(e.results.length, 0);
  assert.equal(e.failure, null, '空结果是成功；设 failure 会让 L1 把"没有"判成"坏了"');
  assert.equal(e.requests.succeeded, 3);
});

test('U-283-C HuggingFace：三个 kind 全 500 ⇒ failure=error 且告警点名"全部 kind 失败"', async () => {
  const { e, payload } = await run([
    hfRoute('models', { message: 'boom' }, { status: 500 }),
    hfRoute('datasets', { message: 'boom' }, { status: 500 }),
    hfRoute('spaces', { message: 'boom' }, { status: 500 }),
  ], HF);
  assert.equal(e.results.length, 0);
  assert.equal(e.failure.reasonCode, 'error');
  assert.match(e.failure.reason, /全部 kind/, '理由必须说清"全挂"，理由：' + e.failure.reason);
  assert.match(payload.warnings.join('\n'), /全部 kind 检索失败/);
});

test('U-283-D ★ HuggingFace：只挂 models、datasets 有产出 ⇒ 结果照给，但 failure 必须说"部分 kind 失败"', async () => {
  // 这一档是 R5-TLS 那次的病根：以前部分失败被"有结果"盖住，用户以为数据是全的。
  const { e, payload } = await run([
    hfRoute('models', { message: 'boom' }, { status: 500 }),
    hfRoute('datasets', [{ id: 'org/ds1', downloads: 5 }]),
    hfRoute('spaces', []),
  ], HF);
  assert.equal(e.results.length, 1, '有产出就照给，不许因为部分失败把结果丢掉');
  assert.equal(e.failure.reasonCode, 'error');
  assert.match(e.failure.reason, /部分 kind 失败/, '必须点名部分失败，理由：' + e.failure.reason);
  assert.match(payload.warnings.join('\n'), /部分 kind 失败/);
  assert.equal(e.requests.failed, 1);
});

test('U-283-D HuggingFace：没有 id 的条目跳过（不拿空 id 拼出一条假链接）', async () => {
  const { e } = await run([
    hfRoute('models', [{ downloads: 9 }, { id: 'org/ok', downloads: 3 }]),
    hfRoute('datasets', []),
    hfRoute('spaces', []),
  ], HF);
  assert.equal(e.results.length, 1);
  assert.equal(e.results[0].Name, 'model:org/ok');
});

// ─────────────────────────────── DeepSeek（唯一计费源）───────────────────────────────

const DS = { fn: 'Search-DeepSeek', status: 'DeepSeek', params: { Keyword: 'rag evaluation', Limit: 3 } };
const DS_PRE = "$env:DEEPSEEK_API_KEY = 'sk-test'";
const dsRoute = (extra = {}) => ({ host: 'api.deepseek.com', path: '/v1/tools/search', method: 'POST', ...extra });

const dsHits = [
  { title: 'RAG eval survey', url: 'https://a.example/1', summary: 'A  survey\nof RAG   evaluation', rerank_score: 2.5, authority: 3, site_name: 'a.example', date: '2026-01' },
  { title: 'Second', url: 'https://b.example/2', snippet: 'snippet text', rerank_score: 1.8, authority: 2 },
];

test('U-283-A DeepSeek：200 + 两条 ⇒ results 2，分数换算与描述正确，且正文/鉴权都对', async () => {
  const { e, fx } = await run([dsRoute({ body: { results: dsHits } })], { ...DS, preamble: DS_PRE });
  assert.equal(e.results.length, 2);
  assert.equal(e.results[0].Platform, 'DeepSeek');
  assert.equal(e.results[0].Name, 'RAG eval survey');
  assert.equal(e.results[0].Stars, 25, 'Stars = rerank_score × 10（排序用）');
  assert.equal(e.results[0].Unit, 'score');
  assert.match(e.results[0].Desc, /score=2\.5 auth=3/, 'Desc 必须带分数与权威度：' + e.results[0].Desc);
  assert.equal(e.results[0].Preview, 'A survey of RAG evaluation', '连续空白必须压成一个空格');
  assert.equal(e.results[1].Preview, 'snippet text', '没有 summary 时退回 snippet（不是空预览）');
  assert.equal(e.failure, null);
  assert.equal(fx.hits[0].headers.authorization, 'Bearer sk-test', '鉴权头');
  assert.ok(fx.hits[0].body.includes('"query":"rag evaluation"'), '正文必须带 query：' + fx.hits[0].body);
  assert.ok(fx.hits[0].body.includes('"count":3') && fx.hits[0].body.includes('"need_content":false'), '正文参数：' + fx.hits[0].body);
});

test('U-283-B DeepSeek：200 + results 空 ⇒ results 0 且不带 failure', async () => {
  const { e } = await run([dsRoute({ body: { results: [] } })], { ...DS, preamble: DS_PRE });
  assert.equal(e.results.length, 0);
  assert.equal(e.failure, null);
});

test('U-283-C DeepSeek：500 ⇒ error（既不是凭据也不是余额）', async () => {
  const { e } = await run([dsRoute({ status: 500, body: { error: 'boom' } })], { ...DS, preamble: DS_PRE });
  assert.equal(e.failure.reasonCode, 'error', '理由：' + e.failure.reason);
});

test('U-283-D ★ DeepSeek：402 ⇒ quota-exhausted（这一档决定"去充值"，不是"去查网络"）', async () => {
  const { e, payload } = await run([dsRoute({ status: 402, body: { error: 'insufficient balance' } })], { ...DS, preamble: DS_PRE });
  assert.equal(e.failure.reasonCode, 'quota-exhausted', '理由：' + e.failure.reason);
  assert.match(e.failure.reason, /余额|充值/, '理由必须给出可执行建议');
  assert.match(payload.warnings.join('\n'), /quota-exhausted/);
});

test('U-283-D DeepSeek：401 + 正文 "Authentication Fails" ⇒ missing-credential', async () => {
  const { e } = await run([dsRoute({ status: 401, body: { error: 'Authentication Fails' } })], { ...DS, preamble: DS_PRE });
  assert.equal(e.failure.reasonCode, 'missing-credential', '理由：' + e.failure.reason);
});

test('U-283-D DeepSeek：429 ⇒ rate-limited', async () => {
  const { e } = await run([dsRoute({ status: 429, body: { error: 'slow down' } })], { ...DS, preamble: DS_PRE });
  assert.equal(e.failure.reasonCode, 'rate-limited', '理由：' + e.failure.reason);
});

test('U-283-D ★ DeepSeek：返回 2 条但全低于门槛 ⇒ failure=filtered（不是 zero-hit，也不是 error）', async () => {
  // "我们自己丢的"与"源没有"必须分开：前者该调阈值，后者该换查询。
  const { e, payload } = await run([dsRoute({ body: { results: [
    { title: 'low1', url: 'https://x/1', snippet: 's', rerank_score: 0.3 },
    { title: 'low2', url: 'https://x/2', snippet: 's', rerank_score: 0.2 },
  ] } })], { ...DS, preamble: DS_PRE });
  assert.equal(e.results.length, 0);
  assert.equal(e.failure.reasonCode, 'filtered', '理由：' + e.failure.reason);
  assert.match(payload.warnings.join('\n'), /丢弃 2 条低置信结果/);
});

test('U-283-D ★ DeepSeek：没有 DEEPSEEK_API_KEY ⇒ not-run（不是 missing-credential）且 0 请求', async () => {
  // 可选付费源"没打算用"与"配了但失效"是两件事：后者要用户改 key，前者只要知道它没参与。
  const { e, fx } = await run([], { ...DS, preamble: '' });
  assert.equal(e.failure.reasonCode, 'not-run', '理由：' + e.failure.reason);
  assert.equal(fx.hits.length, 0, '没 key 就不该发请求（这是计费源）');
  assert.equal(e.requests.attempted, 0);
  assert.equal(e.quota.class, 'none');
});

test('U-283-D DeepSeek：超长查询截断到 128 并留可见告警', async () => {
  const long = 'x'.repeat(200);
  const { e, fx, payload } = await run([dsRoute({ body: { results: [] } })], { ...DS, params: { Keyword: long, Limit: 3 }, preamble: DS_PRE });
  assert.equal(e.results.length, 0);
  assert.match(payload.warnings.join('\n'), /128/, '必须告诉自己截断了');
  const body = JSON.parse(fx.hits[0].body);
  assert.equal(body.query.length, 128, '服务端硬限制 128：发出去的必须已经截断');
});
