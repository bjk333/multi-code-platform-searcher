// U-189（2026-10-20，v1.46.1）：上游"少命中/结构变化"三条守卫。
//
// 依据：reports/升级空间调研-2026-10-20.md 的 P2/P3 中可**离线验证**的三项：
//   ① GitHub `/search/code` 的 `sort`/`order` 官方标注 "closing down"（无日期）——
//      现实现没用到，但没有任何门阻止以后有人"顺手加个排序"。加一条静态守卫。
//   ② searchcode 新 API 返回 `context_before/context_after` 与 `truncated/has_more/total_matches`；
//      旧实现只取 `content` 单行、且**完全不透出截断** ⇒「只返回前 N 条」与「仓库里就这么多」长得一样。
//   ③ MCP Registry 官方 schema（v0/servers，2025-12-11）里 `url` 可缺省，连接方式在 `remotes[]`，
//      且一个 server 可有多条 remotes；旧实现只取第一条且不看是否为空。
//
// 门结构：A 源码行为契约；B/C 行为臂（桩 Invoke-ApiRequest）+ **引擎内变异自证**（把新逻辑改坏 ⇒ 读数必须变）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { probeWithMutants, rootDir } from './r94-ps-probe.mjs';

const read = (p) => fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
const stripComments = (src) => src.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');

const GH_CODE = read(path.join(rootDir, 'engines', 'github-code.ps1'));
const GH_CODE_CODE = stripComments(GH_CODE);
const SC = read(path.join(rootDir, 'engines', 'searchcode-repo.ps1'));
const MCP = read(path.join(rootDir, 'engines', 'mcp-registry.ps1'));

test('U-189 A: GitHub /search/code 不得带 sort/order（官方标注 closing down）', () => {
  // 只盯 code search：仓库搜索 /search/repositories 用 sort=stars 是合法的，不能一并禁掉。
  const codeUrlLines = GH_CODE_CODE.split(/\r?\n/).filter((l) => /search\/code/.test(l));
  assert.ok(codeUrlLines.length >= 1, 'github-code.ps1 里必须能找到 /search/code 的 URI 组装行');
  for (const l of codeUrlLines) {
    assert.doesNotMatch(l, /\bsort=/, '★ /search/code 不得带 sort=（官方标注 closing down，加了以后会静默失效）: ' + l.trim());
    assert.doesNotMatch(l, /\border=/, '★ /search/code 不得带 order=（同上）: ' + l.trim());
  }
  // 预览依赖 text-match 媒体类型；删了它 Preview 会恒为 null（此前踩过）
  assert.match(GH_CODE_CODE, /application\/vnd\.github\.text-match\+json/, 'text-match Accept 头必须保留（否则 Preview 恒 null）');

  // MCP 注册中心：默认页只有 30 条且带 nextCursor ⇒ 必须显式取 100 条，且 0 命中时要说明"只扫了前 100 条"
  assert.match(MCP, /v0\/servers\?limit=100/, '★ 必须显式 limit=100（默认 30 条 ⇒ 把"没扫到"说成"没有"）');
  assert.match(MCP, /metadata\.nextCursor/, '必须读 metadata.nextCursor（分页边界要可见）');
  assert.match(MCP, /仅扫描前 100 条/, '0 命中且分页未走完时 reason 必须说明只扫了前 100 条');
  // ★ 服务端 search= 实测**不可作默认路径**（2026-10-20，见 reports/v1.46.1 §六）：
  //   `?search=redis` 命中时 1.9–6.1s，零命中要全表扫描 8–22s（两次 12s 超时），而该引擎截止只有 8s、单源硬上限 10s。
  //   要用它必须先有「per-engine 硬上限」，否则加了就是给每次 MCP 查询制造 deadline。
  assert.doesNotMatch(MCP, /[?&]search=/, '★ 默认路径不得依赖服务端 search=（实测 8–22s，超 8s 引擎截止；见报告）');
});

test('U-189 B/C: searchcode 上下文与截断、MCP remotes（含引擎内变异自证）', async () => {
  const probe = `
$ErrorActionPreference = 'Stop'
$out = [ordered]@{}

function global:Invoke-ApiRequest {
  param($Uri, $Headers, $TimeoutSec, $Method, $Body, $MaxAttempts, [switch]$NoProxy, $DeadlineSec, $NodeDeadlineSec)
  [PSCustomObject]@{ Content = $global:__fixture; StatusCode = 200; Headers = @{} }
}

# ---- searchcode：带上下文 + 截断 ----
$global:__fixture = '{"repository":"https://github.com/redis/redis","commit_sha":"abc","total_matches":7,"results_returned":1,"has_more":false,"truncated":true,"results":[{"file":"src/expire.c","language":"C","matches_in_file":1,"matches":[{"line":42,"content":"void expireGenericCommand(client *c, long long basetime, int unit) {","context_before":["/* EXPIRE family */"],"context_after":["    robj *key = c->argv[1];"]}]}]}'
$r1 = @(Search-SearchCodeRepo -Keyword 'expire' -Repository 'https://github.com/redis/redis' -Limit 5)
$out.scPreview = [string]$r1[0].Preview
$out.scDesc = [string]$r1[0].Desc
$out.scWarn = (@(Get-EngineWarnings) -join ' | ')

# ---- searchcode 负例：不截断、无上下文 ⇒ 预览就是单行本身，且不得刷截断告警 ----
$global:__fixture = '{"total_matches":1,"results_returned":1,"has_more":false,"truncated":false,"results":[{"file":"a.c","language":"C","matches_in_file":1,"matches":[{"line":1,"content":"int main(void) {"}]}]}'
$r2 = @(Search-SearchCodeRepo -Keyword 'x' -Repository 'https://github.com/redis/redis' -Limit 5)
$out.scPlainPreview = [string]$r2[0].Preview
$out.scPlainWarn = (@(Get-EngineWarnings) -join ' | ')

# ---- 引擎内变异：把上下文拼接改坏 ⇒ 预览必须退回单行（证明 B 臂测的是真逻辑）----
$eng = [System.IO.File]::ReadAllText('__SC_PATH__').TrimStart([char]0xFEFF)
$mut = $eng.Replace('if ($before.Count -and $before[0])', 'if ($false -and $before.Count -and $before[0])')
if ($mut -eq $eng) { throw 'mutation anchor missing in searchcode engine' }
Invoke-Expression $mut
$global:__fixture = '{"total_matches":7,"results_returned":1,"truncated":true,"results":[{"file":"src/expire.c","language":"C","matches_in_file":1,"matches":[{"line":42,"content":"void expireGenericCommand(client *c) {","context_before":["/* EXPIRE family */"],"context_after":["    robj *key;"]}]}]}'
$r3 = @(Search-SearchCodeRepo -Keyword 'expire' -Repository 'https://github.com/redis/redis' -Limit 5)
$out.scMutPreview = [string]$r3[0].Preview
Invoke-Expression $eng

# ---- MCP：url 缺省 + 多条 remotes（第一条空）+ 未知 _meta 字段 ----
$global:__fixture = '{"servers":[{"server":{"name":"io.example/redis","title":"Redis MCP","description":"Redis tools","version":"1.2.3","remotes":[{"type":"sse","url":""},{"type":"streamable-http","url":"https://example.test/mcp"}]},"_meta":{"io.modelcontextprotocol.registry/official":{"status":"active"},"unknown":"tolerated"}}],"metadata":{"nextCursor":null,"count":1}}'
$m1 = @(Search-McpRegistry -Keyword 'redis' -Limit 5)
$out.mcpUrl = [string]$m1[0].Url
$out.mcpName = [string]$m1[0].Name
$out.mcpHitWarn = (@(Get-EngineWarnings) -join ' | ')
$m2 = @(Search-McpRegistry -Keyword 'nomatch-zzz' -Limit 5)
$out.mcpNoHit = @($m2).Count

# ---- MCP：0 命中 + nextCursor 存在 ⇒ 必须说明"只扫了前 100 条"（有命中时不提示，避免噪音）----
$global:__fixture = '{"servers":[{"server":{"name":"a/b","description":"no match here"}}],"metadata":{"nextCursor":"a/b:1.0.0","count":100}}'
$m4 = @(Search-McpRegistry -Keyword 'zzz-none' -Limit 5)
$out.mcpBoundaryWarn = (@(Get-EngineWarnings) -join ' | ')
$out.mcpBoundaryReason = [string]$script:_engineStatusReason['MCPRegistry']

# ---- MCP 变异：只认第一条 remote（旧行为）⇒ url 变空 ----
$engM = [System.IO.File]::ReadAllText('__MCP_PATH__').TrimStart([char]0xFEFF)
$mutM = $engM.Replace('foreach ($rm in @($s.remotes)) { if ($rm.url) { $url = [string]$rm.url; break } }', '$url = [string](@($s.remotes))[0].url')
if ($mutM -eq $engM) { throw 'mutation anchor missing in mcp engine' }
Invoke-Expression $mutM
$global:__fixture = '{"servers":[{"server":{"name":"io.example/redis","remotes":[{"url":""},{"url":"https://example.test/mcp"}]}}]}'
$m3 = @(Search-McpRegistry -Keyword 'redis' -Limit 5)
$out.mcpMutUrl = [string]$m3[0].Url
Invoke-Expression $engM

$out
`.replace('__SC_PATH__', path.join(rootDir, 'engines', 'searchcode-repo.ps1').replace(/\\/g, '\\\\'))
    .replace('__MCP_PATH__', path.join(rootDir, 'engines', 'mcp-registry.ps1').replace(/\\/g, '\\\\'));

  const r = await probeWithMutants(probe, [], { timeoutMs: 180000 });
  const o = r.real;

  // searchcode：上下文进预览、total 进 Desc、截断进 warnings
  assert.match(o.scPreview, /EXPIRE family/, '★ 预览必须含 context_before（此前被丢掉）');
  assert.match(o.scPreview, /robj \*key = c->argv\[1\]/, '★ 预览必须含 context_after');
  assert.match(o.scPreview, /⏎/, '上下文与命中行之间要有分隔符（否则读起来是一行乱码）');
  assert.match(o.scDesc, /total: 7/, 'Desc 必须带 total_matches');
  assert.match(o.scWarn, /仅返回部分匹配/, '★ truncated=true 必须进 warnings（少命中 ≠ 全量）');

  // 负例：不截断、无上下文
  assert.equal(o.scPlainPreview, 'int main(void) {', '无上下文时必须原样返回 content（不得凭空加分隔符）');
  assert.doesNotMatch(o.scPlainWarn, /仅返回部分匹配/, 'truncated=false 时不得刷截断告警');

  // 变异自证：上下文拼接去掉 ⇒ 预览退回单行
  assert.doesNotMatch(o.scMutPreview, /EXPIRE family/, '★ 变异后仍带上下文 ⇒ B 臂没测到真逻辑');

  // MCP：取第一条**非空** remote
  assert.equal(o.mcpUrl, 'https://example.test/mcp', '★ 必须跳过空 url 取到下一条 remote（旧行为取到空串）');
  assert.equal(o.mcpName, 'io.example/redis', '未知 _meta 字段不得影响解析');
  assert.equal(o.mcpNoHit, 0, '关键词不匹配时必须 0 条（客户端过滤仍生效）');
  assert.doesNotMatch(o.mcpHitWarn, /只扫描了前 100 条/, '有命中时不得刷分页边界告警（噪音）');
  assert.match(o.mcpBoundaryWarn, /只扫描了前 100 条/, '★ 0 命中 + nextCursor ⇒ 必须提示只扫了前 100 条（否则"没有"是假结论）');
  assert.match(o.mcpBoundaryReason, /仅扫描前 100 条/, 'reason 也要写清扫描边界');
  assert.equal(o.mcpMutUrl, '', '★ 变异回「只取第一条」后 url 应变空 ⇒ C 臂确实测到新逻辑');
});
