// 第三批行为臂（U-280，v1.62.0）：挑的是**传输方式与前面 15 个都不同**的三个引擎。
//
//   · GrepApp  —— MCP over JSON-RPC：POST 正文决定"问得对不对"，响应是 **SSE**（`data:` 行），
//                 而且上游在限流时返回 **HTTP 200 + result.isError**（U-191 踩过：会被洗成"可信零命中"）。
//   · StackExchange —— 普通 JSON，但 `q` 是 **AND 语义**：长查询会结构性零命中（不能当"源没数据"）。
//   · DepsDev —— **两请求串联**：第二个 URL 由第一个的 `isDefault` 版本拼出来。链条断在哪儿，
//                 只看结果条数是看不出来的。
//
// 判据沿用 define.mjs 的三条通则（自归因 / 失败臂必须真发过请求 / 夹具不许有未命中），
// 额外多一条本批新加的：**POST 臂必须断言正文**（bodyHas）—— 只看 URL 的话，
// `method` 写成 `tools/list`、`name` 写错、`query` 没带上，三种错都会绿。

const sse = (payload) => 'event: message\ndata: ' + JSON.stringify(payload) + '\n\n';
const mcpText = (text) => sse({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }] } });

// grep.app 的文本块：Repository/Path/URL + `--- Snippet N (Line X) ---` + 代码行
const GREP_BLOCK_2 = [
  'Repository: redis/redis',
  'Path: src/server.c',
  'URL: https://github.com/redis/redis/blob/unstable/src/server.c',
  '--- Snippet 1 (Line 42) ---',
  'int main(void) { return 0; }',
  '--- Snippet 2 (Line 88) ---',
  'void beforeSleep(void) { }',
].join('\n');

export const CASES3 = [
  {
    name: 'GrepApp（MCP JSON-RPC + SSE）',
    fn: 'Search-GrepApp',
    status: 'GrepApp',
    params: { Keyword: 'redis', Limit: 5, Language: 'Go' },
    ok: [{
      host: 'mcp.grep.app',
      path: '/',
      method: 'POST',
      headers: { 'content-type': 'text/event-stream' },
      body: mcpText(GREP_BLOCK_2),
    }],
    zero: [{
      host: 'mcp.grep.app',
      path: '/',
      method: 'POST',
      headers: { 'content-type': 'text/event-stream' },
      body: mcpText(''),
    }],
    fail: [{ host: 'mcp.grep.app', path: '/', method: 'POST', status: 500, body: { message: 'boom' } }],
    expect: {
      ok: {
        count: 2,
        status: 'ok',
        first: { Platform: 'grep.app', Name: 'redis/redis', File: 'src/server.c', Line: 42, Desc: 'line 42' },
        urlHas: [],
        bodyHas: ['"method":"tools/call"', '"name":"searchGitHub"', '"query":"redis"', '"language":["Go"]'],
      },
      zero: { count: 0, status: 'empty' },
      fail: { count: 0, status: 'error', warnHas: 'grep.app' },
    },
    extra: [
      {
        // U-191 的原样：上游限流时 HTTP 仍是 200，错误塞在 result.isError 里。
        //   只判 payload.error 的实现在这里会把"被限流"记成 empty（= 可信零命中）。
        name: '200 + result.isError(Too Many) ⇒ rate_limited，不许当零命中',
        routes: [{
          host: 'mcp.grep.app',
          path: '/',
          method: 'POST',
          body: sse({ jsonrpc: '2.0', id: 1, result: { isError: true, content: [{ type: 'text', text: 'Too Many Requests' }] } }),
        }],
        expect: { count: 0, status: 'rate_limited', warnHas: '限流' },
      },
      {
        name: '200 + result.isError(其它) ⇒ error（不是 rate_limited，也不是 empty）',
        routes: [{
          host: 'mcp.grep.app',
          path: '/',
          method: 'POST',
          body: sse({ jsonrpc: '2.0', id: 1, result: { isError: true, content: [{ type: 'text', text: 'schema mismatch' }] } }),
        }],
        expect: { count: 0, status: 'error', warnHas: 'isError' },
      },
      {
        // 没有可解析的 data 行 ⇒ 必须显式报错。默认实现若"读不到就返回空数组"，
        //   用户会看到一条"0 命中"的可信结论，而真相是协议变了。
        name: 'SSE 里没有 data 负载 ⇒ error（不许静默 0 命中）',
        routes: [{ host: 'mcp.grep.app', path: '/', method: 'POST', body: 'event: ping\n\n' }],
        expect: { count: 0, status: 'error', warnHas: '无可解析 data' },
      },
    ],
  },

  {
    name: 'StackExchange（AND 语义的 JSON 源）',
    fn: 'Search-StackExchange',
    status: 'SE',
    params: { Keyword: 'rust lifetime', Limit: 5 },
    ok: [{
      host: 'api.stackexchange.com',
      path: /^\/2\.3\/search\/advanced/,
      body: {
        items: [
          {
            title: 'Why does this lifetime elide?',
            score: 12,
            answer_count: 3,
            link: 'https://stackoverflow.com/q/1',
            tags: ['rust', 'lifetimes'],
            body: '<p>Hello <b>world</b> &amp; more</p>',
          },
          {
            title: 'Borrow checker complains',
            score: 4,
            answer_count: 1,
            link: 'https://stackoverflow.com/q/2',
            tags: ['rust'],
            body: '<p>second</p>',
          },
        ],
      },
    }],
    zero: [{ host: 'api.stackexchange.com', path: /^\/2\.3\/search\/advanced/, body: { items: [] } }],
    fail: [{ host: 'api.stackexchange.com', path: /^\/2\.3\/search\/advanced/, status: 429, body: { error_message: 'throttled' } }],
    expect: {
      ok: {
        count: 2,
        status: 'ok',
        first: { Platform: 'StackExchange', Name: 'Why does this lifetime elide?', Stars: 12 },
        urlHas: ['q=rust%20lifetime', 'site=stackoverflow', 'filter=withbody'],
      },
      zero: { count: 0, status: 'empty' },
      fail: { count: 0, status: 'error', warnHas: 'Stack Exchange' },
    },
    extra: [
      {
        // HTML 必须被剥干净：schema 里 Preview 是给终端/JSON 消费者看的，
        //   残留 `<b>` 会让人以为检索的是文档而不是代码/问答（U-134 同族）。
        name: 'HTML 标签与实体必须剥掉（Preview 里不许出现 < > 与 &amp;）',
        routes: [{
          host: 'api.stackexchange.com',
          path: /^\/2\.3\/search\/advanced/,
          body: { items: [{ title: 'T &amp; T', score: 1, answer_count: 0, link: 'https://x/1', tags: [], body: '<p>a &lt;b&gt; c</p>' }] },
        }],
        expect: { count: 1, status: 'ok', first: { Name: 'T &amp; T' }, noHtml: true },
      },
      {
        // 3 个词 ⇒ AND 语义结构性零命中。这里钉的是**状态仍必须是 empty**（不是 error）：
        //   源确实回答了，只是没有同时包含三个词的问题 —— 那是可信零命中，不是故障。
        name: '多词查询零命中 ⇒ empty（AND 语义不是故障）',
        params: { Keyword: 'kubernetes operators tutorial', Limit: 5 },
        routes: [{ host: 'api.stackexchange.com', path: /^\/2\.3\/search\/advanced/, body: { items: [] } }],
        expect: { count: 0, status: 'empty' },
      },
    ],
  },

  {
    name: 'DepsDev（两请求串联）',
    fn: 'Search-DepsDevPackage',
    status: 'DepsDev',
    params: { PackageSpec: 'npm:express' },
    ok: [
      {
        host: 'api.deps.dev',
        path: '/v3alpha/systems/NPM/packages/express',
        body: {
          versions: [
            { versionKey: { version: '4.17.1' }, isDefault: false, publishedAt: '2020-05-31T00:00:00Z' },
            { versionKey: { version: '4.18.2' }, isDefault: true, publishedAt: '2026-01-02T03:04:05Z' },
            { versionKey: { version: '5.0.0-beta' }, isDefault: false, publishedAt: '2026-02-01T00:00:00Z' },
          ],
        },
      },
      {
        // ★这一条的 URL 里带着第一个响应的版本号：链条断在这里会 404 ⇒ 引擎记 error，
        //   而不是"查到了包但没有许可证"这种看起来正常的降级。
        host: 'api.deps.dev',
        path: '/v3alpha/systems/NPM/packages/express/versions/4.18.2',
        body: { licenses: ['MIT'], advisoryKeys: [{ id: 'GHSA-aaaa-bbbb' }] },
      },
    ],
    zero: [{ host: 'api.deps.dev', path: '/v3alpha/systems/NPM/packages/express', status: 404, body: { message: 'package not found' } }],
    fail: [{ host: 'api.deps.dev', path: '/v3alpha/systems/NPM/packages/express', status: 500, body: { message: 'boom' } }],
    expect: {
      ok: {
        count: 1,
        status: 'ok',
        first: { Platform: 'deps.dev', Name: 'npm/express', License: 'MIT', Updated: '2026-01-02T03:04:05Z' },
        descHas: 'default 4.18.2',
        warnHas: 'GHSA-aaaa-bbbb',
        urlHas: ['/v3alpha/systems/NPM/packages/express', '/versions/4.18.2'],
      },
      zero: { count: 0, status: 'empty', warnHas: '包不存在' },
      fail: { count: 0, status: 'error', warnHas: 'deps.dev 查询失败' },
    },
    extra: [
      {
        // 没有 isDefault ⇒ 退化为列表末项，并且必须**说出来**（"末项"不等于"最新"，实测 requests 的末项是 2016 年的）
        name: '缺 isDefault ⇒ 取末项 + 明确告警（不许静默当最新）',
        routes: [
          {
            host: 'api.deps.dev',
            path: '/v3alpha/systems/NPM/packages/express',
            body: { versions: [{ versionKey: { version: '1.0.0' }, publishedAt: '2019-01-01T00:00:00Z' }, { versionKey: { version: '1.1.0' }, publishedAt: '2018-01-01T00:00:00Z' }] },
          },
          { host: 'api.deps.dev', path: '/v3alpha/systems/NPM/packages/express/versions/1.1.0', body: { licenses: ['Apache-2.0'] } },
        ],
        expect: { count: 1, status: 'ok', first: { License: 'Apache-2.0' }, warnHas: '没有 isDefault' },
      },
      {
        // 作用域包必须编码：`@types/node` 不编码直接 404（实测）。这条钉的是**请求 URL 的形状**。
        name: '作用域包必须 EscapeDataString（@types/node ⇒ %40types%2Fnode）',
        params: { PackageSpec: 'npm:@types/node' },
        routes: [{
          host: 'api.deps.dev',
          path: /^\/v3alpha\/systems\/NPM\/packages\/%40types%2Fnode$/,
          body: { versions: [{ versionKey: { version: '20.0.0' }, isDefault: true, publishedAt: '2026-03-01T00:00:00Z' }] },
        }, {
          host: 'api.deps.dev',
          path: '/v3alpha/systems/NPM/packages/%40types%2Fnode/versions/20.0.0',
          body: { licenses: ['MIT'] },
        }],
        expect: { count: 1, status: 'ok', first: { Name: 'npm/@types/node' }, urlHas: ['%40types%2Fnode'] },
      },
      {
        // U-283（v1.65.0）：把 B3-10 §13.7 那句"看过但没验过"变成证据。
        //   deps-dev 的 404 判据靠 `Exception.Response.StatusCode`（PS 7 也成立），不靠正文文本 ——
        //   所以正文写不写 "404" 都该判 empty（包不存在），**不是** error（查询失败）。
        name: '404 + 正文不含 404 ⇒ 仍判 empty（靠 StatusCode 而不是正文文本）',
        routes: [{ host: 'api.deps.dev', path: '/v3alpha/systems/NPM/packages/express', status: 404, body: { message: 'gone' } }],
        expect: { count: 0, status: 'empty', warnHas: '包不存在' },
      },
    ],
  },
];
