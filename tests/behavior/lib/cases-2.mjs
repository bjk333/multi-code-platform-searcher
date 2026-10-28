// U-274 第二批引擎三臂表（B3-3 扩展：覆盖从 8/25 提到 15/25）。
// 与第一批同构（ok/zero/fail + 可选 extra），只是引擎的响应形状不同：
//   数组根（GitLab/RubyGems）、对象包数组（NuGet/Packagist）、XML（arXiv）、
//   客户端过滤（DockerHub/MCPRegistry）、remotes 兼容（MCPRegistry）。
//
// ★选这 7 个的理由不是"好写"，而是它们各自带着一类**只在行为层才看得见**的逻辑：
//   GitLab：PS7 把 `[]` 解析成 `$null` 的坑 + "错误体是对象不是数组"的形状守卫；
//   DockerHub / MCPRegistry：**客户端过滤**（服务端不支持 q= 或不支持星标筛），过滤写错就静默零命中；
//   arXiv：唯一的 XML 解析路径；Packagist：`abandoned` 标记必须透出（直接决定能不能用）；
//   NuGet / RubyGems：包级常规形状，作为对照组。

export const RETRY_AFTER2 = '99999';

export const CASES2 = [
  {
    name: 'GitLab（repo · 数组根 + 形状守卫）',
    fn: 'Search-GitLab',
    status: 'GitLab',
    params: { Keyword: 'gitlab runner', Limit: 5, MinStars: 0 },
    ok: [
      {
        host: 'gitlab.com',
        path: /^\/api\/v4\/projects/,
        body: [
          { path_with_namespace: 'gitlab-org/gitlab', star_count: 25000, web_url: 'https://gitlab.com/gitlab-org/gitlab', description: 'GitLab', language: 'Ruby', last_activity_at: '2026-10-20T00:00:00Z' },
          { path_with_namespace: 'gitlab-org/gitlab-runner', star_count: 8000, web_url: 'https://gitlab.com/gitlab-org/gitlab-runner', description: 'Runner', language: 'Go', last_activity_at: '2026-10-19T00:00:00Z' },
        ],
      },
    ],
    // 空数组：PS7 的 ConvertFrom-Json 把它解成 $null —— 引擎必须判"成功但空"，不是"失败"
    zero: [{ host: 'gitlab.com', path: /^\/api\/v4\/projects/, body: [] }],
    fail: [{ host: 'gitlab.com', path: /^\/api\/v4\/projects/, status: 429, headers: { 'Retry-After': RETRY_AFTER2 }, body: { message: 'too many' } }],
    extra: [
      {
        name: '200 但错误体是对象 ⇒ 必须判 error，不许当 0 命中',
        routes: [{ host: 'gitlab.com', path: /^\/api\/v4\/projects/, body: { error: 'order_by does not have a valid value' } }],
        expect: { count: 0, status: 'error' },
      },
    ],
    expect: {
      ok: { count: 2, status: 'ok', first: { Name: 'gitlab-org/gitlab', Stars: 25000, Platform: 'GitLab', Unit: 'stars' }, urlHas: ['search=gitlab%20runner', 'order_by=star_count', 'per_page=5'] },
      zero: { count: 0, status: 'empty' },
      fail: { count: 0, status: 'rate_limited' },
    },
  },
  {
    name: 'NuGet（package · downloads）',
    fn: 'Search-NuGet',
    status: 'NuGet',
    params: { Keyword: 'newtonsoft json', Limit: 5 },
    ok: [
      {
        host: 'azuresearch-usnc.nuget.org',
        path: /^\/query/,
        body: {
          data: [
            { id: 'Newtonsoft.Json', version: '13.0.3', description: 'Json.NET', totalDownloads: 1234567890, projectUrl: 'https://www.newtonsoft.com/json', tags: ['json'] },
            { id: 'Newtonsoft.Json.Bson', version: '1.0.2', description: 'BSON support', totalDownloads: 1000000 },
          ],
        },
      },
    ],
    zero: [{ host: 'azuresearch-usnc.nuget.org', path: /^\/query/, body: { data: [] } }],
    fail: [{ host: 'azuresearch-usnc.nuget.org', path: /^\/query/, status: 429, headers: { 'Retry-After': RETRY_AFTER2 }, body: {} }],
    expect: {
      ok: { count: 2, status: 'ok', first: { Name: 'Newtonsoft.Json', Stars: 1234567890, Unit: 'downloads', Platform: 'NuGet' }, urlHas: ['q=newtonsoft%20json', 'take=5'] },
      zero: { count: 0, status: 'empty' },
      fail: { count: 0, status: 'error', warnHas: 'NuGet' },
    },
  },
  {
    name: 'RubyGems（package · 数组根）',
    fn: 'Search-RubyGems',
    status: 'RubyGems',
    params: { Keyword: 'rails', Limit: 5 },
    ok: [
      {
        host: 'rubygems.org',
        path: /^\/api\/v1\/search\.json/,
        body: [
          { name: 'rails', version: '7.1.0', info: 'Full-stack framework', downloads: 500000000 },
          { name: 'railties', version: '7.1.0', info: 'Rails internals', downloads: 480000000 },
        ],
      },
    ],
    zero: [{ host: 'rubygems.org', path: /^\/api\/v1\/search\.json/, body: [] }],
    fail: [{ host: 'rubygems.org', path: /^\/api\/v1\/search\.json/, status: 429, headers: { 'Retry-After': RETRY_AFTER2 }, body: {} }],
    expect: {
      ok: { count: 2, status: 'ok', first: { Name: 'rails', Stars: 500000000, Unit: 'downloads', Platform: 'RubyGems' }, urlHas: ['query=rails'] },
      zero: { count: 0, status: 'empty' },
      fail: { count: 0, status: 'error', warnHas: 'RubyGems' },
    },
  },
  {
    name: 'DockerHub（package · 客户端质量门槛）',
    fn: 'Search-DockerHub',
    status: 'DockerHub',
    params: { Keyword: 'nginx', Limit: 5 },
    ok: [
      {
        host: 'hub.docker.com',
        path: /^\/v2\/search\/repositories/,
        body: {
          results: [
            { repo_name: 'library/nginx', star_count: 100, short_description: 'Official nginx image' },
            { repo_name: 'grafana/mcp-grafana', star_count: 5, short_description: 'observability for LLMs' },
          ],
        },
      },
    ],
    zero: [{ host: 'hub.docker.com', path: /^\/v2\/search\/repositories/, body: { results: [] } }],
    fail: [{ host: 'hub.docker.com', path: /^\/v2\/search\/repositories/, status: 429, headers: { 'Retry-After': RETRY_AFTER2 }, body: {} }],
    extra: [
      {
        name: '全部条目与查询词无交集 ⇒ 丢弃并说明"不等于该源无结果"',
        routes: [{
          host: 'hub.docker.com',
          path: /^\/v2\/search\/repositories/,
          body: { results: [{ repo_name: 'a/foo', star_count: 1, short_description: 'bar' }, { repo_name: 'b/baz', star_count: 2, short_description: 'qux' }] },
        }],
        params: { Keyword: 'postgres' },
        expect: { count: 0, status: 'empty', warnHas: '丢弃 2 条' },
      },
    ],
    expect: {
      ok: { count: 1, status: 'ok', first: { Name: 'library/nginx', Stars: 100, Platform: 'DockerHub' }, urlHas: ['query=nginx', 'page_size=5'], warnHas: '丢弃 1 条' },
      zero: { count: 0, status: 'empty' },
      fail: { count: 0, status: 'error', warnHas: 'Docker Hub' },
    },
  },
  {
    name: 'MCPRegistry（research · 客户端子串过滤 + remotes 兼容）',
    fn: 'Search-McpRegistry',
    status: 'MCPRegistry',
    params: { Keyword: 'sqlite', Limit: 5 },
    ok: [
      {
        host: 'registry.modelcontextprotocol.io',
        path: /^\/v0\/servers/,
        body: {
          servers: [
            { server: { name: 'io.example/sqlite', title: 'SQLite MCP', description: 'query sqlite databases', version: '1.0.0', remotes: [{ url: 'https://example.com/mcp' }] } },
            { server: { name: 'other/thing', title: 'Other', description: 'unrelated' } },
          ],
          metadata: { nextCursor: 'abc' },
        },
      },
    ],
    zero: [{ host: 'registry.modelcontextprotocol.io', path: /^\/v0\/servers/, body: { servers: [], metadata: { nextCursor: 'abc' } } }],
    fail: [{ host: 'registry.modelcontextprotocol.io', path: /^\/v0\/servers/, status: 429, headers: { 'Retry-After': RETRY_AFTER2 }, body: {} }],
    expect: {
      ok: { count: 1, status: 'ok', first: { Name: 'io.example/sqlite', Url: 'https://example.com/mcp', Platform: 'MCPRegistry' }, urlHas: ['limit=100'] },
      zero: { count: 0, status: 'empty', warnHas: '只扫描了前 100 条' },
      fail: { count: 0, status: 'error' },
    },
  },
  {
    name: 'arXiv（research · XML 解析）',
    fn: 'Search-Arxiv',
    status: 'arXiv',
    params: { Keyword: 'graph neural', Limit: 5 },
    ok: [
      {
        host: 'export.arxiv.org',
        path: /^\/api\/query/,
        headers: { 'content-type': 'application/atom+xml' },
        body: `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2601.00001v1</id>
    <title>Paper One</title>
    <summary>Summary one.</summary>
    <published>2026-01-02T00:00:00Z</published>
    <author><name>Alice</name></author>
    <author><name>Bob</name></author>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2601.00002v1</id>
    <title>Paper Two</title>
    <summary>Summary two.</summary>
    <published>2026-01-03T00:00:00Z</published>
    <author><name>Carol</name></author>
  </entry>
</feed>`,
      },
    ],
    zero: [{ host: 'export.arxiv.org', path: /^\/api\/query/, body: '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>' }],
    fail: [{ host: 'export.arxiv.org', path: /^\/api\/query/, status: 429, headers: { 'Retry-After': RETRY_AFTER2 }, body: {} }],
    expect: {
      ok: { count: 2, status: 'ok', first: { Name: 'Paper One', Platform: 'arXiv', Unit: 'citations' }, urlHas: ['search_query=all:graph%20neural', 'max_results=5'] },
      zero: { count: 0, status: 'empty' },
      fail: { count: 0, status: 'error', warnHas: 'arXiv' },
    },
  },
  {
    name: 'Packagist（package · abandoned 标记 + 少命中可见）',
    fn: 'Search-Packagist',
    status: 'Packagist',
    params: { Keyword: 'monolog', Limit: 5 },
    ok: [
      {
        host: 'packagist.org',
        path: /^\/search\.json/,
        body: {
          results: [
            { name: 'monolog/monolog', description: 'Logging', downloads: 600000000, favers: 20000, url: 'https://github.com/Seldaek/monolog' },
            { name: 'symfony/monolog-bridge', description: 'bridge', downloads: 1000000, favers: 300 },
          ],
          total: 99,
        },
      },
    ],
    zero: [{ host: 'packagist.org', path: /^\/search\.json/, body: { results: [], total: 0 } }],
    fail: [{ host: 'packagist.org', path: /^\/search\.json/, status: 429, headers: { 'Retry-After': RETRY_AFTER2 }, body: {} }],
    extra: [
      {
        name: 'abandoned=true 必须在 Desc 里透出',
        routes: [{ host: 'packagist.org', path: /^\/search\.json/, body: { results: [{ name: 'old/pkg', description: 'dead', downloads: 10, abandoned: true }], total: 1 } }],
        expect: { count: 1, status: 'ok', first: { Name: 'old/pkg', Platform: 'Packagist' }, descHas: '[abandoned]' },
      },
    ],
    expect: {
      ok: { count: 2, status: 'ok', first: { Name: 'monolog/monolog', Stars: 600000000, Unit: 'downloads', Platform: 'Packagist' }, urlHas: ['q=monolog', 'per_page=5'], warnHas: '仅返回前' },
      zero: { count: 0, status: 'empty' },
      fail: { count: 0, status: 'rate_limited' },
    },
  },
];
