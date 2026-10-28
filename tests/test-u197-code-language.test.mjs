// U-197（2026-10-21，v1.46.4）：`-CodeEvidence` 必须支持 `-Language`（此前只作用于仓库发现）。
//
// 事实：`$Language` 只在 repo 路径接线（`:3681-3696`、缓存键 `:5047`）；code 路径
//   `Invoke-ConcurrentCodeSearch` 的签名只有 `Keyword, Limit`，`-CodeEvidence -Language python` 会静默返回所有语言。
//
// 上游能力（分证据强度）：
//   · grep.app MCP：`language: string[]` 在 tools/list 的 inputSchema 里实测读到；
//   · GitHub：`repo:` 限定符实测有效；`language:` 属官方文档口径（本轮复测被 hosts 劫持挡住，标待验证）；
//   · GitLab/SE 无语言参数 ⇒ 必须显式告警"未应用"；Sourcegraph 支持 `lang:`。
//
// 门结构：A 静态接线；B 行为（stub Invoke-ApiRequest 抓 URI/body，正例+负例）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { probeWithMutants, rootDir, MAIN } from './r94-ps-probe.mjs';
import { sourceAll } from './lib/source.mjs';

const read = (p) => fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
const MAIN_SRC = sourceAll(rootDir);   // v1.54.0（B3-2）：读加载后视图
const CODE = MAIN_SRC.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');

test('U-197 A: 静态接线 —— 池/引擎/缓存键/告警四处都要有 Language', () => {
  assert.match(CODE, /function Invoke-ConcurrentCodeSearch \{[\s\S]{0,300}\[string\]\$Language/, 'Invoke-ConcurrentCodeSearch 缺 -Language');
  assert.match(CODE, /\$poolArgs = @\{ Keyword = \$Keyword; Limit = \$Limit; Language = \$Language \}/, '★ 池参数里必须带 Language');
  assert.match(CODE, /-EngineArgs \$poolArgs/, '★ 池调用没把参数传下去');
  assert.match(CODE, /-Language \$Language/, '串行回退路径也要传 Language');
  assert.match(CODE, /if \(-not \$e\.LangFilter\)[\s\S]{0,220}未应用/, '★ 不支持语言过滤的源必须显式告警（不得假装过滤了）');
  assert.match(CODE, /evidence#\$AutoKeyword#\$Language#\$Limit/, '★ code 缓存键必须含 Language（否则跨语言串结果）');
  for (const f of ['github-code', 'grep-app', 'gitlab-blobs', 'se-excerpts', 'sourcegraph']) {
    const src = read(path.join(rootDir, 'engines', f + '.ps1'));
    assert.match(src, /param\(\$Keyword, \$Limit, \$Language/, `engines/${f}.ps1 必须接受 Language（池统一 splat，缺参数会整源报错）`);
  }
});

test('U-197 B: GitHub language: 与 grep.app language[]（正例 + 无 Language 负例）', async () => {
  const probe = `
$ErrorActionPreference = 'Stop'
$out = [ordered]@{}
$global:__uris = @(); $global:__bodies = @(); $global:__content = '{"items":[]}'; $NL = [char]10
$env:GITHUB_TOKEN = 'probe-token'

function global:Invoke-ApiRequest {
  param($Uri, $Headers, $TimeoutSec, $Method, $Body, $MaxAttempts, [switch]$NoProxy, $DeadlineSec, $NodeDeadlineSec)
  $global:__uris += [string]$Uri
  $global:__bodies += [string]$Body
  return [PSCustomObject]@{ Content = $global:__content; StatusCode = 200; Headers = @{} }
}
function global:Wait-RateLimitToken { param($Bucket) }

# GitHub 正例 / 负例
$global:__content = '{"items":[]}'
$null = @(Search-GitHubCode -Keyword 'jwt verify' -Limit 1 -Language 'python')
$out.ghLang = [string]$global:__uris[-1]
$global:__uris = @()
$null = @(Search-GitHubCode -Keyword 'jwt verify' -Limit 1)
$out.ghNoLang = [string]$global:__uris[-1]

# grep.app 正例 / 负例
function Set-Sse([string]$text) {
  $p = @{ jsonrpc = '2.0'; id = 1; result = @{ content = @(@{ type = 'text'; text = $text }); isError = $false } } | ConvertTo-Json -Depth 8 -Compress
  $global:__content = ('event: message' + $NL + 'data: ' + $p)
}
Set-Sse 'nothing'
$null = @(Search-GrepApp -Keyword 'jwt verify' -Limit 1 -Language 'python')
$out.grepBody = [string]$global:__bodies[-1]
$global:__bodies = @()
$null = @(Search-GrepApp -Keyword 'jwt verify' -Limit 1)
$out.grepNoLang = [string]$global:__bodies[-1]

# Sourcegraph lang:（函数直调，不经池）
$global:__content = ('event: done' + $NL + 'data: {}')
$null = @(Search-Sourcegraph -Keyword 'jwt' -Limit 1 -Language 'go')
$out.sgLang = [string]$global:__uris[-1]
$out
`;

  const r = await probeWithMutants(probe, [], { timeoutMs: 180000 });
  const o = r.real;

  assert.match(o.ghLang, /language%3Apython/, '★ GitHub 查询必须带 language:python（EscapeDataString 后为 %3A）');
  assert.doesNotMatch(o.ghNoLang, /language%3A/, '负例：不传 -Language 时不得出现 language 限定符');
  assert.match(o.grepBody, /"language":\["python"\]/, '★ grep.app body 必须带 language:["python"]');
  assert.doesNotMatch(o.grepNoLang, /"language"/, '负例：不传 -Language 时 body 不得带 language 键');
  assert.match(o.sgLang, /lang%3Ago/, 'Sourcegraph 应使用 lang: 过滤器');
});
