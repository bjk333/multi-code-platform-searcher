// U-274 引擎三臂表：**数据与执行分离** —— 表放这里，执行放 engines.test.mjs，
// 元门（tests/test-u274-behavior-layer.test.mjs）直接 import 这张表断言"每个引擎都真的有三臂"，
// 不用正则去数测试源码（用文本猜行为，正是这一批要治的病）。
//
// 每条 case 的字段：
//   name/fn/status  —— 展示名、产品函数名、Get-EngineStatus 用的引擎名
//   params          —— 传给引擎函数的具名实参（__statusName 由探针转成 status 名，不传给产品）
//   ok/zero/fail    —— 三臂各自的夹具路由；expect 是对应的判据
//   expect.ok.urlHas —— 必须出现在**实际请求**里的子串（"你问了什么"这一半的断言）

export const RETRY_AFTER = '99999';   // > Cfg.MaxRetryWaitSec ⇒ 快速失败（引擎 catch 收到"限流等待过长"）

export const CASES = [
  {
    name: 'Gitee（repo · 双通道）',
    fn: 'Search-Gitee',
    status: 'Gitee',
    params: { Keyword: 'vue admin', Limit: 5, MinStars: 0 },
    ok: [
      {
        host: 'so.gitee.com',
        path: /^\/v1\/search\/widget\//,
        body: {
          hits: {
            hits: [
              { _score: 100.1, fields: { title: ['disjob'], 'count.star': ['3476'], langs: ['Java'], description: ['distributed task scheduler'], url: ['https://gitee.com/dromara/disjob'], license: ['Apache-2.0'], last_push_at: ['2026-10-01T00:00:00+08:00'] } },
              { _score: 12.5, fields: { title: ['vue-admin-better'], 'count.star': ['100'], langs: ['Vue'], description: ['vue admin'], url: ['https://gitee.com/x/vue-admin-better'] } },
            ],
          },
        },
      },
    ],
    zero: [{ host: 'so.gitee.com', path: /^\/v1\/search\/widget\//, body: { hits: { hits: [] } } }],
    fail: [
      { host: 'so.gitee.com', path: /^\/v1\/search\/widget\//, status: 429, headers: { 'Retry-After': RETRY_AFTER }, body: { message: 'too many' } },
      // v5 匿名恒返空数组（Gitee Feedback #ICCSIY）⇒ 产品应判「本次未执行」而不是「0 命中」
      { host: 'gitee.com', path: /^\/api\/v5\/search\/repositories/, body: [] },
    ],
    expect: {
      ok: { count: 2, status: 'ok', first: { Name: 'disjob', Stars: 3476, Platform: 'Gitee' }, urlHas: ['q=vue%20admin', 'size='] },
      zero: { count: 0, status: 'empty' },
      fail: { count: 0, status: 'auth_missing', warnHas: '未执行' },
    },
    extra: [
      {
        // U-288（v1.70.0）：**相关度地板**的两条行为臂。此前这两条只被静态门
        //   `test-t2-7-gitee-floor.test.mjs` 守着，而那道门做的是"在 JS 里**重新实现**一遍过滤规则" ——
        //   产品改了口径（比如把 `-or` 改成 `-and`），门里那份 JS 不会跟着变，于是门绿着、产品已经错了。
        //   这里改由产品自己算：三行输入、两行输出，被剔的那行就是暗网门户。
        //
        // 数据为什么是这三个 _score（配置：GiteeMinApiScore=2.0，GiteeRelFloorRatio=0.25）：
        //   榜首 100.1 ⇒ 地板 = 25.025。
        //   · disjob 100.1 —— Rel=0（desc 不含 vue/admin）但等于榜首 ⇒ **保留**（分数够高）
        //   · 中文高相关 30.0 —— Rel=0 但 30 ≥ 25.025 ⇒ **保留**（"高分中文 desc"不许被误伤）
        //   · darknet 7.3 —— Rel=0 且 7.3 < 25.025 ⇒ **剔除**
        // 变异检验（改产品，不改正则）：删掉那行 Where-Object 地板 ⇒ 本臂变 3 条（实测）。
        name: '相关度地板：零相关且低于榜首×0.25 的行被剔除，高分中文行保留',
        routes: [{
          host: 'so.gitee.com',
          path: /^\/v1\/search\/widget\//,
          body: {
            hits: {
              hits: [
                { _score: 100.1, fields: { title: ['disjob'], 'count.star': ['3476'], langs: ['Java'], description: ['distributed task scheduler'], url: ['https://gitee.com/dromara/disjob'] } },
                { _score: 30.0, fields: { title: ['中文高相关'], 'count.star': ['900'], langs: ['Java'], description: ['中文描述的调度框架'], url: ['https://gitee.com/x/cn-high'] } },
                { _score: 7.3, fields: { title: ['darknet portal'], 'count.star': ['12'], langs: ['PHP'], description: ['dark web marketplace'], url: ['https://gitee.com/x/darknet'] } },
              ],
            },
          },
        }],
        expect: { count: 2, status: 'ok', first: { Name: 'disjob' } },
      },
      {
        // 相邻规则（不是地板）：`awesome-*` 且与关键词零相关的仓库**无论分数多高**都剔除。
        //   ★`awesome-vue` 不能当样本 —— title 含 "vue" ⇒ Rel>0 ⇒ 它压根不进这条规则（第一版就选错了样本）。
        //   所以样本用 `awesome-rust`（title/desc 都不含 vue/admin），分数给到 200（榜首）——
        //   地板保不住它，只有 awesome 规则能剔掉它。删掉那行 ⇒ 本臂变 2 条（实测）。
        name: 'awesome-* 零相关仓库即便分数最高也剔除（与地板是两条规则）',
        routes: [{
          host: 'so.gitee.com',
          path: /^\/v1\/search\/widget\//,
          body: {
            hits: {
              hits: [
                { _score: 200.0, fields: { title: ['awesome-rust'], 'count.star': ['50000'], langs: ['Rust'], description: ['a curated list of rust crates'], url: ['https://gitee.com/x/awesome-rust'] } },
                { _score: 100.1, fields: { title: ['disjob'], 'count.star': ['3476'], langs: ['Java'], description: ['distributed task scheduler'], url: ['https://gitee.com/dromara/disjob'] } },
              ],
            },
          },
        }],
        expect: { count: 1, status: 'ok', first: { Name: 'disjob' } },
      },
    ],
  },
  {
    name: 'Codeberg（repo）',
    fn: 'Search-Codeberg',
    status: 'Codeberg',
    params: { Keyword: 'forgejo', Limit: 5, MinStars: 0 },
    ok: [
      {
        host: 'codeberg.org',
        path: /^\/api\/v1\/repos\/search/,
        body: {
          data: [
            { full_name: 'forgejo/forgejo', stars: 1234, html_url: 'https://codeberg.org/forgejo/forgejo', description: 'Git forge', language: 'Go', updated_at: '2026-10-20T00:00:00Z', archived: false },
            { full_name: 'someone/tool', stars: null, html_url: 'https://codeberg.org/someone/tool', description: 'no star field', language: 'Rust', updated_at: '2026-09-01T00:00:00Z' },
          ],
        },
      },
    ],
    zero: [{ host: 'codeberg.org', path: /^\/api\/v1\/repos\/search/, body: { data: [] } }],
    fail: [{ host: 'codeberg.org', path: /^\/api\/v1\/repos\/search/, status: 429, headers: { 'Retry-After': RETRY_AFTER }, body: { message: 'slow down' } }],
    expect: {
      // U-276（B3-5 变异抽检首跑抓到）：`archived: false` 与「字段缺失」必须分开 ——
      //   把 `$null -ne $item.archived` 改成 `-eq` 时，这条断言没红，说明此前根本没验过 archived。
      //   这与 v1.45.3 的 stars 是同一类病：「未知」被写成某个具体值。
      ok: { count: 2, status: 'ok', first: { Name: 'forgejo/forgejo', Stars: 1234, Platform: 'Codeberg', Archived: false }, urlHas: ['q=forgejo', 'sort=stars'] },
      zero: { count: 0, status: 'empty' },
      fail: { count: 0, status: 'error', warnHas: 'Codeberg' },
    },
    extra: [
      {
        name: '缺 archived / 缺 stars ⇒ null（未知不是 false，也不是 0）',
        routes: [{
          host: 'codeberg.org',
          path: /^\/api\/v1\/repos\/search/,
          body: { data: [{ full_name: 'someone/tool', html_url: 'https://codeberg.org/someone/tool', language: 'Rust' }] },
        }],
        expect: { count: 1, status: 'ok', first: { Stars: null, Archived: null } },
      },
    ],
  },
  {
    name: 'npm（package · 含下载量补全）',
    fn: 'Search-NpmRegistry',
    status: 'Npm',
    params: { Keyword: 'express', Limit: 5 },
    ok: [
      {
        host: 'registry.npmjs.org',
        path: /^\/-\/v1\/search/,
        body: {
          objects: [
            { package: { name: 'express', version: '4.19.2', description: 'Fast web framework', links: { npm: 'https://www.npmjs.com/package/express' }, keywords: ['web'] }, score: { detail: { popularity: 0.9 } } },
            { package: { name: 'koa', version: '2.15.0', description: 'Koa web app framework', links: { npm: 'https://www.npmjs.com/package/koa' } }, score: { detail: { popularity: 0.4 } } },
          ],
        },
      },
      { host: 'api.npmjs.org', path: /^\/downloads\/point\/last-week\//, body: { express: { downloads: 30000000 }, koa: { downloads: 1000000 } } },
    ],
    zero: [{ host: 'registry.npmjs.org', path: /^\/-\/v1\/search/, body: { objects: [] } }],
    fail: [{ host: 'registry.npmjs.org', path: /^\/-\/v1\/search/, status: 429, headers: { 'Retry-After': RETRY_AFTER }, body: { error: 'rate limit' } }],
    expect: {
      ok: { count: 2, first: { Name: 'express', Stars: 30000000, Unit: 'downloads/week' }, urlHas: ['text=express', 'size=5'] },
      zero: { count: 0 },
      fail: { count: 0, warnHas: 'npm 检索失败', statusNot: 'ok' },
    },
  },
  {
    name: 'crates.io（package）',
    fn: 'Search-CratesIo',
    status: 'Crates',
    params: { Keyword: 'serde', Limit: 5 },
    ok: [
      {
        host: 'crates.io',
        path: /^\/api\/v1\/crates/,
        body: {
          crates: [
            { name: 'serde', max_version: '1.0.210', description: 'serialize/deserialize', keywords: ['serde', 'serialization'], downloads: 123456789 },
            { name: 'serde_json', max_version: '1.0.128', description: 'JSON for serde', downloads: 98765432 },
          ],
        },
      },
    ],
    zero: [{ host: 'crates.io', path: /^\/api\/v1\/crates/, body: { crates: [] } }],
    fail: [{ host: 'crates.io', path: /^\/api\/v1\/crates/, status: 429, headers: { 'Retry-After': RETRY_AFTER }, body: { errors: [] } }],
    expect: {
      ok: { count: 2, first: { Name: 'serde', Stars: 123456789, Unit: 'downloads', Platform: 'crates.io' }, urlHas: ['q=serde', 'sort=downloads'] },
      zero: { count: 0 },
      fail: { count: 0, warnHas: 'crates.io 检索失败', statusNot: 'ok' },
    },
  },
  {
    name: 'Maven Central（package）',
    fn: 'Search-MavenCentral',
    status: 'Maven',
    params: { Keyword: 'guava', Limit: 5 },
    ok: [
      {
        host: 'search.maven.org',
        path: /^\/solrsearch\/select/,
        body: {
          response: {
            docs: [
              { g: 'com.google.guava', a: 'guava', latestVersion: '33.3.0-jre' },
              { g: 'org.springframework', a: 'spring-core', latestVersion: '6.1.13' },
            ],
          },
        },
      },
    ],
    zero: [{ host: 'search.maven.org', path: /^\/solrsearch\/select/, body: { response: { docs: [] } } }],
    fail: [{ host: 'search.maven.org', path: /^\/solrsearch\/select/, status: 429, headers: { 'Retry-After': RETRY_AFTER }, body: {} }],
    expect: {
      ok: { count: 2, first: { Name: 'com.google.guava:guava', Platform: 'Maven', Unit: 'none' }, urlHas: ['q=guava', 'rows=5'] },
      zero: { count: 0 },
      fail: { count: 0, warnHas: 'Maven Central 检索失败', statusNot: 'ok' },
    },
  },
  {
    name: 'HackerNews（research）',
    fn: 'Search-HackerNews',
    status: 'HackerNews',
    params: { Keyword: 'vector database', Limit: 5 },
    ok: [
      {
        host: 'hn.algolia.com',
        path: /^\/api\/v1\/search/,
        body: {
          hits: [
            { title: 'Show HN: a vector database', points: 120, num_comments: 45, url: 'https://example.com/a', author: 'bob', objectID: '1' },
            { title: 'Why vector databases', points: 30, num_comments: 7, author: 'alice', objectID: '2' },
          ],
        },
      },
    ],
    zero: [{ host: 'hn.algolia.com', path: /^\/api\/v1\/search/, body: { hits: [] } }],
    fail: [{ host: 'hn.algolia.com', path: /^\/api\/v1\/search/, status: 429, headers: { 'Retry-After': RETRY_AFTER }, body: {} }],
    expect: {
      ok: { count: 2, status: 'ok', first: { Name: 'Show HN: a vector database', Stars: 120, Platform: 'HackerNews' }, urlHas: ['query=vector%20database', 'tags=story'] },
      zero: { count: 0, status: 'empty' },
      fail: { count: 0, status: 'error' },
    },
  },
  {
    name: 'OpenAlex（research · 预算头）',
    fn: 'Search-OpenAlex',
    status: 'OpenAlex',
    params: { Keyword: 'retrieval augmented generation', Limit: 5 },
    ok: [
      {
        host: 'api.openalex.org',
        path: /^\/works/,
        headers: { 'X-RateLimit-Limit': '100', 'X-RateLimit-Remaining': '5' },
        body: {
          results: [
            { id: 'https://openalex.org/W1', display_name: 'Paper A', cited_by_count: 42, publication_year: 2020, doi: 'https://doi.org/10.1/a' },
            { id: 'https://openalex.org/W2', display_name: 'Paper B', cited_by_count: 7, publication_year: 2023 },
          ],
        },
      },
    ],
    zero: [{ host: 'api.openalex.org', path: /^\/works/, body: { results: [] } }],
    fail: [{ host: 'api.openalex.org', path: /^\/works/, status: 429, headers: { 'Retry-After': RETRY_AFTER }, body: {} }],
    expect: {
      ok: { count: 2, first: { Name: 'Paper A', Stars: 42, Unit: 'citations' }, urlHas: ['search=retrieval%20augmented%20generation', 'per-page=5'], warnHas: '额度仅剩' },
      zero: { count: 0 },
      fail: { count: 0, status: 'rate_limited' },
    },
    extra: [
      {
        // U-283（v1.65.0）：fail 臂走的是「Retry-After 超上限 ⇒ 快速失败」那条路（抛的是**字符串**，
        //   所以正文写什么都无所谓）。这条补的是**另一条路**：Retry-After 正常 ⇒ 真重试 ⇒ 重试耗尽。
        //   那一档抛的也是构造出来的字符串（带 ", rate-limit"），与正文无关 —— 这条把"无关"钉成证据。
        name: '429 重试耗尽（正文不含 429）⇒ 仍判 rate_limited',
        routes: [{ host: 'api.openalex.org', path: /^\/works/, status: 429, headers: { 'Retry-After': '1' }, body: { error: 'slow' } }],
        expect: { count: 0, status: 'rate_limited' },
      },
    ],
  },
  {
    name: 'SEExcerpts（code）',
    fn: 'Search-SEExcerpts',
    status: 'SEExcerpts',
    params: { Keyword: 'jwt expire', Limit: 5 },
    ok: [
      {
        host: 'api.stackexchange.com',
        path: /^\/2\.3\/search\/advanced/,
        body: {
          items: [
            { title: 'How to handle &#39;jwt expire&#39;?', body: '<p>Use <code>exp</code> claim &amp; refresh</p>', question_id: 123, link: 'https://stackoverflow.com/q/123', score: 7, answer_count: 2, tags: ['c#', '.net'] },
            { title: 'JWT refresh pattern', body: '<p>See <a href="x">docs</a></p>', question_id: 456, link: 'https://stackoverflow.com/q/456', score: 3, answer_count: 1, tags: ['jwt'] },
          ],
        },
      },
    ],
    zero: [{ host: 'api.stackexchange.com', path: /^\/2\.3\/search\/advanced/, body: { items: [] } }],
    fail: [{ host: 'api.stackexchange.com', path: /^\/2\.3\/search\/advanced/, status: 429, headers: { 'Retry-After': RETRY_AFTER }, body: {} }],
    expect: {
      ok: { count: 2, status: 'ok', first: { Name: "How to handle 'jwt expire'?", Platform: 'SEExcerpts' }, urlHas: ['q=jwt%20expire', 'site=stackoverflow'], noHtml: true },
      zero: { count: 0, status: 'empty' },
      fail: { count: 0, status: 'rate_limited' },
    },
  },
];
