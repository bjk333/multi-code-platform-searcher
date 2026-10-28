// U-282（v1.64.0）：**封套类引擎**的状态码分档 —— 这两个引擎不返回结果数组，返回 `EngineContract v1` 封套。
//
// 为什么不走通用执行器（define.mjs）：
//   执行器按"结果条数"判（`payload.count`），而封套类引擎返回**一个**对象 ⇒ `count` 恒为 1，
//   "1 条结果"与"1 个封套"在那一层**同形**。这类引擎真正要钉的是封套里的 `failure.reasonCode`
//   —— 它决定调用方去配令牌、去等配额、还是去查网络。所以拆封套这件事必须显式写在断言里，不能塞进执行器。
//
// 选这两个引擎的理由（B3-10 §13.7 留的账）：
//   · GitHub —— repo 检索主引擎，401/403/403+配额/500 四档都在 `catch` 里靠**消息文本**分；
//   · GitLabBlobs —— 同样的分档，且 U-265 的注释明确写着"401 判据曾只在 PS 7 下恒假"。
//   两者的分档都只被静态契约门（u263/u265）覆盖过，而那些门把传输层桩掉了 —— 桩掉的正是状态码。
//
// ★本文件有一条**故意更狠**的臂：401 的正文写成不含 "401"/"Unauthorized" 的 `{"message":"Bad credentials"}`。
//   GitLab 线上 401 的正文恰好是 "401 Unauthorized"（所以现有实现"碰巧"能认出来）；
//   一旦正文换了措辞，判据就只剩异常消息里的状态码。这不是假想：B3-10 在 Sourcegraph 上实测过同一形状。
import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixture } from './lib/fixture-server.mjs';
import { runEngine } from './lib/engine-probe.mjs';

/** 起夹具 → 跑引擎 → 拆封套 → 关夹具 */
async function run(routes, { fn, status, params, preamble = '', env = {} }) {
  const fx = await startFixture(routes);
  try {
    const r = await runEngine({ fn, params: { ...params, __statusName: status }, port: fx.port, preamble, env });
    assert.ok(r.payload, '探针没吐 JSON：' + r.stderr.slice(-500));
    assert.equal(r.payload.ok, true, '引擎不该把异常抛给调用方：' + r.payload.error);
    assert.equal(r.payload.count, 1, '封套类引擎必须只返回**一个**封套（不是结果数组）');
    const e = r.payload.result[0];
    assert.equal(e.contract, 'engine/1', '封套契约版本');
    return { e, fx, payload: r.payload };
  } finally {
    await fx.close();
  }
}

const GH = { fn: 'Search-GitHub', status: 'GitHub', params: { Keyword: 'redis', Limit: 2 } };
const GL = { fn: 'Search-GitLabBlobs', status: 'GitLabBlobs', params: { Keyword: 'redis', Limit: 5, RepoScope: 'redis/redis' } };

const ghItem = (name, stars, extra = {}) => ({
  full_name: name,
  stargazers_count: stars,
  html_url: 'https://github.com/' + name,
  description: name + ' desc',
  license: { spdx_id: 'BSD-3-Clause' },
  updated_at: '2026-10-01T00:00:00Z',
  archived: false,
  ...extra,
});

// ─────────────────────────────── GitHub（repo 检索主引擎）───────────────────────────────

test('U-282-A GitHub：200 + 两条 ⇒ 封套 results 2，字段逐字对，且请求参数正确', async () => {
  const { e, fx } = await run([{
    host: 'api.github.com',
    path: /^\/search\/repositories/,
    body: { total_count: 2, items: [ghItem('redis/redis', 42000), ghItem('valkey-io/valkey', 3000)] },
  }], GH);
  assert.equal(e.results.length, 2, '结果数');
  assert.equal(e.results[0].Platform, 'GitHub');
  assert.equal(e.results[0].Name, 'redis/redis');
  assert.equal(e.results[0].Stars, 42000);
  assert.equal(e.results[0].Unit, 'stars');
  assert.equal(e.results[0].License, 'BSD-3-Clause');
  assert.equal(e.results[0].Relaxed, false, '首轮直接命中时 Relaxed 必须是 false（不是"没这个字段"）');
  assert.equal(e.failure, null, '成功时不许带 failure');
  assert.equal(e.requests.succeeded, 1, '成功的请求数');
  const q = fx.hits[0].path;
  assert.ok(q.includes('q=redis'), '查询串：' + q);
  assert.ok(q.includes('sort=stars') && q.includes('per_page=2'), '排序与页大小：' + q);
});

test('U-282-B GitHub：200 + 零命中 ⇒ results 0 且 **不带 failure**（"搜了没有"是成功）', async () => {
  const { e } = await run([{ host: 'api.github.com', path: /^\/search\/repositories/, body: { total_count: 0, items: [] } }], GH);
  assert.equal(e.results.length, 0);
  assert.equal(e.failure, null, '零命中不许冒充失败（否则 L1 会把空结果判成 error）');
  assert.equal(e.requests.succeeded, 1);
});

test('U-282-C GitHub：401 ⇒ missing-credential（配令牌，不是查网络）', async () => {
  const { e, payload } = await run([{ host: 'api.github.com', path: /^\/search\/repositories/, status: 401, body: { message: 'Bad credentials' } }], GH);
  assert.equal(e.results.length, 0);
  assert.equal(e.failure.reasonCode, 'missing-credential', '封套 reasonCode（理由：' + (e.failure && e.failure.reason) + '）');
  assert.match(payload.warnings.join('\n'), /认证失败/, '必须留可见告警');
});

test('U-282-D GitHub：403（无配额特征）⇒ forbidden（权限问题，不是限流）', async () => {
  const { e } = await run([{ host: 'api.github.com', path: /^\/search\/repositories/, status: 403, body: { message: 'Forbidden' } }], GH);
  assert.equal(e.failure.reasonCode, 'forbidden', '理由：' + (e.failure && e.failure.reason));
});

test('U-282-D GitHub：403 + x-ratelimit-remaining:0 ⇒ rate-limited（配额耗尽 ≠ 权限不足）', async () => {
  // ★v1.68.0（U-286）：正文里**故意不写** "rate limit"。原来写的是 `API rate limit exceeded`，
  //   而引擎的 `$msg -match 'rate-limit|API rate limit exceeded'` 只看文案 —— 于是**响应头丢不丢都能绿**，
  //   这条臂声称在测"看头分档"，实际测的是"看正文分档"（实测：把头名比较改回大小写敏感，它照样绿）。
  //   现在唯一的信号就是那个头：`Test-RateLimit403` 读到 `x-ratelimit-remaining: 0` 才会把 403 当可重试，
  //   重试耗尽的消息里才带 `, rate-limit` 标记。头一丢，这条臂立刻变 `forbidden`。
  const { e } = await run([{
    host: 'api.github.com',
    path: /^\/search\/repositories/,
    status: 403,
    headers: { 'x-ratelimit-remaining': '0' },
    body: { message: 'Forbidden' },
  }], GH);
  assert.equal(e.failure.reasonCode, 'rate-limited', '理由：' + (e.failure && e.failure.reason));
});

test('U-282-D GitHub：500 ⇒ error（既不是凭据也不是配额）', async () => {
  const { e } = await run([{ host: 'api.github.com', path: /^\/search\/repositories/, status: 500, body: { message: 'boom' } }], GH);
  assert.equal(e.failure.reasonCode, 'error', '理由：' + (e.failure && e.failure.reason));
});

test('U-282-D GitHub：松弛链每一变体都真发一次，最后一个必须是 OR 放宽', async () => {
  const { e, fx } = await run([{ host: 'api.github.com', path: /^\/search\/repositories/, body: { total_count: 0, items: [] } }], {
    ...GH, params: { Keyword: 'redis cluster', Language: 'Go', Limit: 2 },
  });
  assert.equal(fx.hits.length, 3, '三档变体（原查询 → 去语言 → OR 放宽）各发一次；实际：' + fx.hits.map((h) => h.path).join(' | '));
  assert.ok(fx.hits[0].path.includes('language%3AGo'), '第一变体带语言：' + fx.hits[0].path);
  assert.ok(!fx.hits[1].path.includes('language'), '第二变体必须去掉语言（否则这一档白跑）');
  assert.ok(fx.hits[2].path.includes('redis%20OR%20cluster'), '第三变体是 OR 放宽：' + fx.hits[2].path);
  assert.equal(e.results.length, 0);
  assert.equal(e.failure, null, '全部变体都拿到了 200 ⇒ 是"没有结果"，不是失败');
});

test('U-282-D GitHub：无令牌仍发请求，quota.class 标 anonymous（匿名配额是事实，不是跳过）', async () => {
  const { e, fx } = await run([{ host: 'api.github.com', path: /^\/search\/repositories/, body: { total_count: 0, items: [] } }], GH);
  assert.equal(fx.hits.length, 1, '匿名也必须真发一次');
  assert.equal(e.quota.class, 'anonymous', '配额档必须如实标 anonymous');
});

// ─────────────────────────────── GitLabBlobs（仓库级 = 单请求）───────────────────────────────

const GL_BLOBS = [
  { path: 'src/server.c', startline: 42, data: 'int main(void) {', ref: 'main', project_id: 123 },
  { path: 'src/net.c', startline: 88, data: 'void beforeSleep(void) {}', ref: 'main', project_id: 123 },
];
const GL_PRE = "$env:GITLAB_TOKEN = 'glpat_test'";

test('U-282-A GitLabBlobs：仓库级 200 + 两条 ⇒ results 2，Url 带行锚点', async () => {
  const { e, fx } = await run([{ host: 'gitlab.com', path: /^\/api\/v4\/projects\/[^/]+\/search/, body: GL_BLOBS }], { ...GL, preamble: GL_PRE });
  assert.equal(e.results.length, 2);
  assert.equal(e.results[0].Platform, 'GitLabBlobs');
  assert.equal(e.results[0].Name, 'redis/redis', '仓库级结果的项目名来自 -RepoScope');
  assert.equal(e.results[0].File, 'src/server.c');
  assert.equal(e.results[0].Line, 42);
  assert.equal(e.results[0].Url, 'https://gitlab.com/redis/redis/-/blob/main/src/server.c#L42', '证据要能直接跳到那一行');
  assert.equal(e.failure, null);
  assert.equal(fx.hits.length, 1, '仓库级只需一次请求（不走发现链）');
  assert.ok(fx.hits[0].path.includes('scope=blobs') && fx.hits[0].path.includes('search=redis'), '请求参数：' + fx.hits[0].path);
  assert.equal(fx.hits[0].headers['private-token'], 'glpat_test', 'GitLab 用 PRIVATE-TOKEN 头');
});

test('U-282-B GitLabBlobs：200 + 空数组 ⇒ results 0 且不带 failure', async () => {
  const { e } = await run([{ host: 'gitlab.com', path: /^\/api\/v4\/projects/, body: [] }], { ...GL, preamble: GL_PRE });
  assert.equal(e.results.length, 0);
  assert.equal(e.failure, null, '空数组是"查了没有"，不是失败');
});

test('U-282-C GitLabBlobs：401 + 正文含 401 ⇒ missing-credential', async () => {
  const { e } = await run([{ host: 'gitlab.com', path: /^\/api\/v4\/projects/, status: 401, body: { message: '401 Unauthorized' } }], { ...GL, preamble: GL_PRE });
  assert.equal(e.failure.reasonCode, 'missing-credential', '理由：' + (e.failure && e.failure.reason));
});

test('U-282-D ★ GitLabBlobs：401 + 正文不含 401/Unauthorized ⇒ 仍须 missing-credential（状态码在异常消息里）', async () => {
  // 线上 GitLab 的 401 正文恰好写 "401 Unauthorized"，所以现有实现"碰巧"认得出来。
  // 换个措辞（例如反代/网关改写、或上游改文案）就只剩异常消息里的状态码 —— 这条臂钉的是**那个**来源。
  const { e } = await run([{ host: 'gitlab.com', path: /^\/api\/v4\/projects/, status: 401, body: { message: 'Bad credentials' } }], { ...GL, preamble: GL_PRE });
  assert.equal(e.failure.reasonCode, 'missing-credential', '理由：' + (e.failure && e.failure.reason));
});

test('U-282-D GitLabBlobs：429 ⇒ rate-limited', async () => {
  const { e } = await run([{ host: 'gitlab.com', path: /^\/api\/v4\/projects/, status: 429, body: { message: 'slow down' } }], { ...GL, preamble: GL_PRE });
  assert.equal(e.failure.reasonCode, 'rate-limited', '理由：' + (e.failure && e.failure.reason));
});

test('U-282-D GitLabBlobs：403（无配额特征）⇒ error（不是 missing-credential）', async () => {
  const { e } = await run([{ host: 'gitlab.com', path: /^\/api\/v4\/projects/, status: 403, body: { message: 'forbidden' } }], { ...GL, preamble: GL_PRE });
  assert.equal(e.failure.reasonCode, 'error', '理由：' + (e.failure && e.failure.reason));
});

test('U-282-D GitLabBlobs：没有 GITLAB_TOKEN ⇒ missing-credential，且一条请求都不发', async () => {
  const { e, fx } = await run([], { ...GL, preamble: '' });
  assert.equal(e.failure.reasonCode, 'missing-credential');
  assert.equal(fx.hits.length, 0, '缺令牌是"发请求前就退出"，花配额是不可接受的');
  assert.equal(e.requests.attempted, 0, '封套自己的请求账本也必须是 0');
});

// ─────────────────────── GitLabBlobs 发现链（不给 -RepoScope 时走的那条路）───────────────────────
//
// 这是最后一条没被行为层覆盖的引擎路径，也是 2026-10-11 那次「429 分支实际不可达」的现场：
//   调用1 全局 blobs（免费版恒 403，不消耗预算）→ 调用2 项目搜索 → 调用3+ 逐项目 blobs（受 4 次预算截断）。
// 状态分档全在这条链的**分支上**：403 是能力关闭、预算耗尽是我方主动放弃、零命中是真空。
// 三者在结果集上都是 0 条 —— 只有 failure.reasonCode 能分开。

const GL_DISC = { fn: 'Search-GitLabBlobs', status: 'GitLabBlobs', params: { Keyword: 'redis', Limit: 5 } };
// ★夹具的路由按**pathname** 匹配（query 不进 rest）——写成 `/search\?` 会一条都命不中，
//   而"没命中的路由"在引擎眼里与"源返回空"同形（都只是 data=null），所以这错只会表现成"0 条"。
const glSearch = (body, extra = {}) => ({ host: 'gitlab.com', path: '/api/v4/search', body, ...extra });
const glProjects = (body, extra = {}) => ({ host: 'gitlab.com', path: '/api/v4/projects', body, ...extra });
const glBlobs = (id, body) => ({ host: 'gitlab.com', path: `/api/v4/projects/${id}/search`, body });

test('U-282-E GitLabBlobs 发现链：全局 blobs 直接命中 ⇒ 1 次检索 + 逐项目补路径，failure 为 null', async () => {
  const { e, fx } = await run([
    glSearch([{ project_id: 123, path: 'src/a.c', startline: 3, data: 'x', ref: 'main' }]),
    { host: 'gitlab.com', path: '/api/v4/projects/123', body: { path_with_namespace: 'redis/redis' } },
  ], { ...GL_DISC, preamble: GL_PRE });
  assert.equal(e.results.length, 1);
  assert.equal(e.results[0].Url, 'https://gitlab.com/redis/redis/-/blob/main/src/a.c#L3', '路径补全后 Url 必须可点击');
  assert.equal(e.failure, null, '全局命中是干净成功');
  assert.equal(fx.hits.length, 2, '全局检索 1 次 + 补路径 1 次；实际：' + fx.hits.map((h) => h.path).join(' | '));
});

test('U-282-E ★ GitLabBlobs 发现链：全局 403 ⇒ 回退项目级，**结果照给**但 failure 必须留痕 forbidden', async () => {
  // 403 是"该账号层级关闭全局搜索"，不是限流、不是预算。有产出也要把首因写进 failure（degraded）。
  const { e, fx } = await run([
    glSearch({ message: '403 Forbidden - Global Search is disabled for this scope' }, { status: 403 }),
    glProjects([{ id: 9, path_with_namespace: 'g/p' }]),
    glBlobs(9, [{ path: 'lib/b.rb', startline: 8, data: 'y', ref: 'main' }]),
  ], { ...GL_DISC, preamble: GL_PRE });
  assert.equal(e.results.length, 1, '回退路径必须真的产出');
  assert.equal(e.results[0].Name, 'g/p');
  assert.equal(e.failure.reasonCode, 'forbidden', '理由：' + (e.failure && e.failure.reason));
  assert.match(e.failure.reason, /项目级回退/, '理由要说清结果来自回退');
  assert.equal(fx.hits.length, 3, '403 那次不消耗预算、也不再补路径；实际：' + fx.hits.map((h) => h.path).join(' | '));
});

test('U-282-E ★ GitLabBlobs 发现链：预算耗尽 ⇒ budget-truncated（"我方主动放弃"，不是 error）', async () => {
  // 预算设 2：调用1 全局（空）用 1 次，调用2 项目搜索用第 2 次 ⇒ 逐项目 blobs 一次都没发。
  //   这跟"源挂了"必须分开：判 error 会让它落 Degraded，coverage 里从 executed 组掉出去。
  const { e } = await run([
    glSearch([]),
    glProjects([{ id: 9, path_with_namespace: 'g/p' }]),
  ], { ...GL_DISC, preamble: GL_PRE + "; $env:MCPS_GITLAB_MAX_CALLS = '2'" });
  assert.equal(e.results.length, 0);
  assert.equal(e.failure.reasonCode, 'budget-truncated', '理由：' + (e.failure && e.failure.reason));
  assert.match(e.failure.reason, /预算已用尽/, '文案必须说"预算"，不是"没搜到"');
});

test('U-282-E GitLabBlobs 发现链：全局空 + 项目搜索 0 条 ⇒ 真·零命中（failure 为 null）', async () => {
  const { e, payload } = await run([glSearch([]), glProjects([])], { ...GL_DISC, preamble: GL_PRE });
  assert.equal(e.results.length, 0);
  assert.equal(e.failure, null, '没 403、没预算截断 ⇒ 就是"没有"，不许带 failure');
  assert.match(payload.warnings.join('\n'), /项目级回退/, '零命中也要说清查过哪儿');
});

test('U-282-E ★ GitLabBlobs 发现链：项目搜索 401 **必须上抛** ⇒ missing-credential（不许吞成零命中）', async () => {
  // U-265 修的就是这条：吞掉 401 ⇒ 最终报 zero-hit ⇒「库里没有」的假结论。
  const { e } = await run([
    glSearch([]),
    glProjects({ message: '401 Unauthorized' }, { status: 401 }),
  ], { ...GL_DISC, preamble: GL_PRE });
  assert.equal(e.results.length, 0);
  assert.equal(e.failure.reasonCode, 'missing-credential', '理由：' + (e.failure && e.failure.reason));
  assert.match(e.failure.reason, /401|GITLAB_TOKEN/, '理由要指向令牌');
});
