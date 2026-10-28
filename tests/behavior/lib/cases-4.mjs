// 第四批行为臂（U-281，v1.63.0）：**最后三个"看起来同形"的引擎**。
//
// 上一批的诚实边界写着：GitHubCode / SearchCodeRepo / Sourcegraph "普通 JSON，与已覆盖者同形，价值最低"。
// 本批把它们真跑起来后，这句话被自己的夹具证伪了 —— 三个都不是同形：
//
//   · Sourcegraph —— **SSE 双字段**（`event:` + `data:`），不是 GrepApp 那种单 `data:` 行；
//                    同一个 403 有**三种**结局（边缘防火墙 / 匿名 / 带令牌），靠 4KB 正文留证分档。
//   · GitHubCode  —— **多取后客户端重排再截断**（文档后置、源码优先）：只看"取回了几条"永远看不出重排有没有发生；
//                    另外它在**发请求前**就按令牌存在与否分流（花不花配额是行为差异）。
//   · SearchCodeRepo —— POST + 仓库级语义：预览由 `context_before/after` **拼**出来（2 行变 3 行），
//                    Url 依赖响应里的 `commit_sha`（不是查询参数），宿主不认识时**不臆造**路径规则。
//
// 三条判据通则沿用 define.mjs；本批新增两条通则（都由这三个引擎逼出来的）：
//   · **headersHas**：`Accept: application/vnd.github.text-match+json` 决定 Preview 有没有内容，
//     而夹具不看 Accept 也照样回同样正文 ⇒ 不钉请求头的话，"没带媒体类型"与"带了"完全同形。
//   · **noRequest**：`auth_missing` 是"发请求前就退出"的臂，通则①'失败臂必须真发过请求'在这里**反向成立**。

const sseBlocks = (blocks) => blocks.map(([ev, data]) => `event: ${ev}\ndata: ${data}\n\n`).join('');

const SG_SRC_2 = [{
  type: 'content',
  repository: 'github.com/redis/redis',
  path: 'src/server.c',
  lineMatches: [{ lineNumber: 42, line: 'int main(void) { return 0; }' }],
}, {
  type: 'content',
  repository: 'github.com/antirez/sds',
  path: 'sds.c',
  lineMatches: [{ lineNumber: 7, line: 'sds s = sdsnew("redis");' }],
}];

export const CASES4 = [
  // ─────────────────────────── Sourcegraph ───────────────────────────
  {
    name: 'Sourcegraph（SSE：event + data 双字段）',
    fn: 'Search-Sourcegraph',
    status: 'Sourcegraph',
    params: { Keyword: 'redis', Limit: 5, Language: 'Go' },
    ok: [{
      host: 'sourcegraph.com',
      path: /^\/\.api\/search\/stream$/,
      headers: { 'content-type': 'text/event-stream' },
      // 真上游在 matches 之间会夹 progress 事件 —— 只认 matches 的实现必须把夹层忽略掉。
      body: sseBlocks([['progress', '{"done":false}'], ['matches', JSON.stringify(SG_SRC_2)]]),
    }],
    zero: [{
      host: 'sourcegraph.com',
      path: /^\/\.api\/search\/stream$/,
      headers: { 'content-type': 'text/event-stream' },
      body: sseBlocks([['progress', '{"done":true}']]),
    }],
    fail: [{ host: 'sourcegraph.com', path: /^\/\.api\/search\/stream$/, status: 429, body: { message: 'slow down' } }],
    expect: {
      ok: {
        count: 2,
        status: 'ok',
        first: {
          Platform: 'Sourcegraph',
          Name: 'github.com/redis/redis',
          File: 'src/server.c',
          Line: 42,
          Preview: 'int main(void) { return 0; }',
          Url: 'https://sourcegraph.com/github.com/redis/redis/-/blob/src/server.c#L42',
        },
        // 查询串本身是判据：context:global 少了 ⇒ 搜的是别的上下文；lang:/display= 丢了 ⇒ 结果集换了。
        urlHas: ['q=context%3Aglobal%20redis%20lang%3AGo', 'v=V3', 'display=5'],
      },
      zero: { count: 0, status: 'empty' },
      fail: { count: 0, status: 'rate_limited', warnHas: '限流' },
    },
    extra: [
      {
        name: 'matches 里夹 symbol/path 类型 ⇒ 只留 content（其余类型没有行号，收了就是编行号）',
        routes: [{
          host: 'sourcegraph.com',
          path: /^\/\.api\/search\/stream$/,
          headers: { 'content-type': 'text/event-stream' },
          body: sseBlocks([['matches', JSON.stringify([
            { type: 'symbol', repository: 'a/b', path: 'x.go' },
            { type: 'path', repository: 'a/b', path: 'y.go' },
            { type: 'content', repository: 'a/b', path: 'z.go', lineMatches: [{ lineNumber: 7, line: 'hit' }] },
          ])]]),
        }],
        expect: { count: 1, status: 'ok', first: { File: 'z.go', Line: 7 } },
      },
      {
        name: 'display 只被客户端执行：上游给了 2 条、Limit=1 ⇒ 截到 1 条',
        routes: [{
          host: 'sourcegraph.com',
          path: /^\/\.api\/search\/stream$/,
          headers: { 'content-type': 'text/event-stream' },
          body: sseBlocks([['matches', JSON.stringify(SG_SRC_2)]]),
        }],
        params: { Limit: 1 },
        expect: { count: 1, status: 'ok' },
      },
      {
        // U-192 的 `$` 锚定：repo: 是**正则**且按全名匹配，不锚定就会把 redis/redis-fork 也算进来。
        name: 'repo: 过滤按正则转义并锚定（$ 必须出现在查询串里）',
        routes: [{
          host: 'sourcegraph.com',
          path: /^\/\.api\/search\/stream$/,
          headers: { 'content-type': 'text/event-stream' },
          body: sseBlocks([['matches', JSON.stringify([SG_SRC_2[0]])]]),
        }],
        params: { RepoScope: 'redis/redis' },
        expect: { count: 1, status: 'ok', urlHas: ['repo%3Aredis%2Fredis%24'] },
      },
      {
        // v1.46.0 的三分档：同样 403，"边缘防火墙拦"与"匿名被拦"与"令牌无权"必须给出不同结论，
        //   否则 Agent 会去换令牌 —— 换什么都没用（17.6KB HTML 的 Firewall Block 页）。
        name: '403 + 正文 Firewall Block ⇒ network_unavailable（不是令牌问题）',
        routes: [{
          host: 'sourcegraph.com',
          path: /^\/\.api\/search\/stream$/,
          status: 403,
          headers: { 'content-type': 'text/html' },
          body: '<html><body>Firewall Block: your request was blocked</body></html>',
        }],
        expect: { count: 0, status: 'network_unavailable', warnHas: '边缘防火墙' },
      },
      {
        // ★正文里**故意**不写 "403"/"Forbidden"：真实 403 的正文各家不同（JSON/HTML/空），
        //   状态码只可能来自异常消息。把 "forbidden" 写进正文，`-match` 大小写不敏感 ⇒ 这条臂会因为
        //   *正文*里的词而绿，测不到"按状态码归因"（第一版就是这么假绿的）。
        name: '403 无防火墙特征 + 匿名 ⇒ network_unavailable（提示设 SRC_TOKEN）',
        routes: [{ host: 'sourcegraph.com', path: /^\/\.api\/search\/stream$/, status: 403, body: { error: 'edge rejected' } }],
        expect: { count: 0, status: 'network_unavailable', warnHas: '匿名 403' },
      },
      {
        name: '403 无防火墙特征 + 带令牌 ⇒ error（令牌无范围/吊销，口径与匿名不同）',
        routes: [{ host: 'sourcegraph.com', path: /^\/\.api\/search\/stream$/, status: 403, body: { error: 'edge rejected' } }],
        preamble: "$env:SRC_TOKEN = 'sgp_test'",
        expect: { count: 0, status: 'error', warnHas: '带令牌' },
      },
    ],
  },

  // ─────────────────────────── GitHubCode ───────────────────────────
  {
    name: 'GitHubCode（多取 + 客户端重排 + 媒体类型）',
    fn: 'Search-GitHubCode',
    status: 'GitHubCode',
    params: { Keyword: 'redis', Limit: 2, Language: 'Go' },
    // 探针默认清空令牌；这个引擎"没令牌就 auth_missing"，成功臂必须显式给一个。
    preamble: "$env:GITHUB_TOKEN = 'ghp_test'",
    ok: [{
      host: 'api.github.com',
      path: '/search/code',
      body: {
        total_count: 3,
        incomplete_results: false,
        // 顺序是**故意**的：文档在前、源码在后。产品会重排再截断 ⇒ 首条必须是 server.c。
        items: [
          { path: 'README.md', html_url: 'https://github.com/redis/redis/blob/x/README.md', repository: { full_name: 'redis/redis' }, text_matches: [{ fragment: '# Redis' }] },
          { path: 'docs/guide.txt', html_url: 'https://github.com/redis/redis/blob/x/docs/guide.txt', repository: { full_name: 'redis/redis' } },
          { path: 'src/server.c', html_url: 'https://github.com/redis/redis/blob/x/src/server.c', repository: { full_name: 'redis/redis' }, text_matches: [{ fragment: 'int main(void)' }] },
        ],
      },
    }],
    zero: [{ host: 'api.github.com', path: '/search/code', body: { total_count: 0, items: [] } }],
    fail: [{ host: 'api.github.com', path: '/search/code', status: 500, body: { message: 'boom' } }],
    expect: {
      ok: {
        count: 2,
        status: 'ok',
        first: { Platform: 'GitHubCode', Name: 'redis/redis', File: 'src/server.c', Preview: 'int main(void)' },
        urlHas: ['q=redis%20language%3AGo', 'per_page=6'],   // 6 = 2 × GhCodeOverfetchFactor(3)
        headersHas: { Accept: 'text-match' },
      },
      zero: { count: 0, status: 'empty' },
      fail: { count: 0, status: 'error' },
    },
    extra: [
      {
        // 花配额是行为差异：没令牌就该**一条请求都不发**，而不是发了 401 再解释。
        name: '没有 GITHUB_TOKEN ⇒ auth_missing，且一条请求都不发',
        routes: [],
        preamble: '',
        expect: { count: 0, status: 'auth_missing', noRequest: true },
      },
      {
        // 同一句注释（"401 标 auth_missing"）在 PS 5.1 靠 WebException 成立，在 PS 7 是 HttpResponseException。
        // 只按异常类型判 ⇒ 跨平台给出**两种诊断**；这条臂就是拿 PS 7 真跑钉住的。
        name: '带令牌 + 401 ⇒ auth_missing（PS 7 的异常不是 WebException）',
        routes: [{ host: 'api.github.com', path: '/search/code', status: 401, body: { message: 'Bad credentials' } }],
        expect: { count: 0, status: 'auth_missing' },
      },
      {
        // N-17：/search/code 已被官方标记废弃（响应头 Deprecation/Sunset）⇒ 必须让调用方看见，
        //   等到 410 那天才知道就晚了。夹具只改头，正文仍是可用结果。
        name: '响应头带 Sunset/Deprecation ⇒ ok 但必须留可见告警',
        routes: [{
          host: 'api.github.com',
          path: '/search/code',
          headers: { Sunset: 'Sun, 27 Sep 2026 23:59:59 GMT', Deprecation: 'true' },
          body: { items: [{ path: 'a.ps1', html_url: 'https://github.com/a/b/blob/x/a.ps1', repository: { full_name: 'a/b' } }] },
        }],
        expect: { count: 1, status: 'ok', warnHas: 'Sunset' },
      },
      {
        // path: 含空格必须加引号，否则 GitHub 把 `my` / `file.c` 当成两个词。
        name: 'PathFilter 含空格 ⇒ 查询串里带引号（而不是被空格拆成两个词）',
        routes: [{
          host: 'api.github.com',
          path: '/search/code',
          body: { items: [{ path: 'src/my file.c', html_url: 'https://github.com/a/b/blob/x/src/my%20file.c', repository: { full_name: 'a/b' } }] },
        }],
        params: { PathFilter: 'src/my file.c' },
        expect: { count: 1, status: 'ok', urlHas: ['path%3A%22src%2Fmy%20file.c%22'] },
      },
    ],
  },

  // ─────────────────────────── SearchCodeRepo ───────────────────────────
  {
    name: 'SearchCodeRepo（POST + 仓库级 + 上下文拼预览）',
    fn: 'Search-SearchCodeRepo',
    status: 'SearchCodeRepo',
    params: { Keyword: 'redis', Repository: 'https://github.com/redis/redis', Limit: 5 },
    ok: [{
      host: 'api.searchcode.com',
      path: '/api/v1/code_search',
      method: 'POST',
      body: {
        commit_sha: 'abc123',
        total_matches: 2,
        results: [{
          file: 'src/server.c',
          language: 'C',
          matches_in_file: 2,
          matches: [
            { line: 42, content: 'int main(void) {', context_before: ['/* start */'], context_after: ['  return 0;'] },
            { line: 88, content: 'void beforeSleep(void) {}', context_before: [], context_after: [] },
          ],
        }],
      },
    }],
    zero: [{ host: 'api.searchcode.com', path: '/api/v1/code_search', method: 'POST', body: { results: [], total_matches: 0 } }],
    fail: [{ host: 'api.searchcode.com', path: '/api/v1/code_search', method: 'POST', status: 500, body: { message: 'boom' } }],
    expect: {
      ok: {
        count: 2,
        status: 'ok',
        // Platform 是小写的 `searchcode`（引擎名是 SearchCodeRepo）—— 这两个不是一回事，别按引擎名断言。
        first: {
          Platform: 'searchcode',
          File: 'src/server.c',
          Line: 42,
          Preview: '/* start */ ⏎ int main(void) { ⏎   return 0;',
          Url: 'https://github.com/redis/redis/blob/abc123/src/server.c#L42',
        },
        descHas: 'total: 2',
        urlHas: ['client=multi-code-platform-searcher'],
        bodyHas: ['"repository":"https://github.com/redis/redis"', '"query":"redis"', '"max_results":5', '"context_lines":1'],
      },
      zero: { count: 0, status: 'empty' },
      fail: { count: 0, status: 'error', warnHas: 'searchcode' },
    },
    extra: [
      {
        // v1.46.1：服务端截断（truncated/has_more）必须透出 —— "只给了前 N 条"与"仓库里就这么多"不能同形。
        name: 'truncated/has_more ⇒ 结果照给，但必须告警"别当全量"',
        routes: [{
          host: 'api.searchcode.com',
          path: '/api/v1/code_search',
          method: 'POST',
          body: {
            commit_sha: 'abc123',
            truncated: true,
            has_more: true,
            total_matches: 99,
            results_returned: 1,
            results: [{ file: 'a.c', language: 'C', matches_in_file: 1, matches: [{ line: 1, content: 'x' }] }],
          },
        }],
        expect: { count: 1, status: 'ok', warnHas: '仅返回部分匹配' },
      },
      {
        // 宿主不认识 ⇒ 退化为仓库地址。**不臆造** blob 路径规则（拼错了就是一条打不开的证据链接）。
        name: '非 GitHub/GitLab 宿主 ⇒ Url 退化为仓库地址（不臆造 blob 路径）',
        routes: [{
          host: 'api.searchcode.com',
          path: '/api/v1/code_search',
          method: 'POST',
          body: {
            commit_sha: 'abc123',
            results: [{ file: 'a.c', language: 'C', matches_in_file: 1, matches: [{ line: 3, content: 'x' }] }],
          },
        }],
        params: { Repository: 'https://git.sr.ht/~x/y' },
        expect: { count: 1, status: 'ok', first: { Url: 'https://git.sr.ht/~x/y' } },
      },
      {
        name: 'Limit 在客户端生效：一个文件两条匹配、Limit=1 ⇒ 只出 1 条',
        routes: [{
          host: 'api.searchcode.com',
          path: '/api/v1/code_search',
          method: 'POST',
          body: {
            commit_sha: 'abc123',
            results: [{ file: 'a.c', language: 'C', matches_in_file: 2, matches: [{ line: 1, content: 'x' }, { line: 2, content: 'y' }] }],
          },
        }],
        params: { Limit: 1 },
        expect: { count: 1, status: 'ok' },
      },
    ],
  },
];
