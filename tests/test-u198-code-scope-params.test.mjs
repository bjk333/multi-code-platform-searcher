// U-198（2026-10-21，v1.46.5）：代码证据的**范围参数**必须真的下发到支持的源。
//
// 事实：grep.app MCP 的 `inputSchema`（当日 tools/list 实测）有 7 个键：
//   query / matchCase / matchWholeWords / useRegexp / repo / path / language ——旧实现只发 query(+language)。
//   GitHub code search 官方支持 `repo:` / `path:` 限定符；Sourcegraph 支持 `repo:` / `path:` 正则过滤器。
//
// 口径：
//   · 未给参数 ⇒ 请求体/查询串与旧版一致（负例，防"顺手加了空字段"改变上游行为）；
//   · 给了 ⇒ grep.app 下发 repo/path/matchCase/useRegexp；GitHub 下发 `repo:`/`path:`；Sourcegraph 下发 `repo:<slug>$`/`path:`；
//   · 不支持的源**不假装生效**（由主流程 warnings 明说，测试见 U-197/U-192）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { probeWithMutants, rootDir } from './r94-ps-probe.mjs';

const read = (p) => fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
const MAIN_SRC = read(path.join(rootDir, 'multi-platform-searcher.ps1'));

test('U-198 A: 源码契约 —— 三个源都接范围参数，主流程真的传下去', () => {
  const grep = read(path.join(rootDir, 'engines', 'grep-app.ps1'));
  for (const k of ['RepoScope', 'PathFilter', 'MatchCase', 'UseRegexp']) {
    assert.match(grep, new RegExp(`param\\([^)]*\\$${k}`), `grep.app 引擎必须接受 $${k}`);
  }
  assert.match(grep, /@\('repo', \$RepoScope\)/, '★ repo 必须进 MCP arguments');
  assert.match(grep, /@\('path', \$PathFilter\)/, '★ path 必须进 MCP arguments');
  assert.match(grep, /\$toolArgs\['matchCase'\] = \$true/, '★ matchCase 必须进 MCP arguments');
  assert.match(grep, /\$toolArgs\['useRegexp'\] = \$true/, '★ useRegexp 必须进 MCP arguments');
  const gh = read(path.join(rootDir, 'engines', 'github-code.ps1'));
  assert.match(gh, /repo:\{1\}/, '★ GitHub 必须拼 repo: 限定符');
  assert.match(gh, /path:\{1\}/, '★ GitHub 必须拼 path: 限定符');
  const sg = read(path.join(rootDir, 'engines', 'sourcegraph.ps1'));
  assert.match(sg, /repo:\{1\}\$/, '★ Sourcegraph 用 $ 锚定仓库正则');
  assert.match(MAIN_SRC, /-Engines \$poolEngines -RepoScope \$scopeSlug -PathFilter \$PathFilter -MatchCase:\$MatchCase -UseRegexp:\$UseRegexp/,
    '★ 主流程必须把范围参数传进代码池（否则引擎永远收不到）');
});

test('U-198 B: 请求形状（给参数 ⇒ 下发；不给 ⇒ 与旧版一致）', async () => {
  const probe = `
$ErrorActionPreference = 'Stop'
$env:GITHUB_TOKEN = 'x'
$global:__cap = @()
function global:Invoke-ApiRequest {
  param($Uri, $Headers, $TimeoutSec, $MaxAttempts, $Method, $Body, $DeadlineSec, $NodeDeadlineSec)
  $global:__cap += [pscustomobject]@{ Uri = [string]$Uri; Body = [string]$Body; Method = [string]$Method }
  return [pscustomobject]@{ Content = '{"total_count":0,"items":[]}'; StatusCode = 200; Headers = @{} }
}
function Get-LastUri([string]$like) { $x = @($global:__cap | Where-Object { $_.Uri -like $like }); if ($x.Count) { $x[-1].Uri } else { '' } }
function Get-LastBody([string]$like) { $x = @($global:__cap | Where-Object { $_.Uri -like $like }); if ($x.Count) { $x[-1].Body } else { '' } }

$out = [ordered]@{}
# 1) grep.app 全参数
$null = @(Search-GrepApp -Keyword 'expire' -Limit 1 -RepoScope 'redis/redis' -PathFilter 'src' -MatchCase -UseRegexp)
$argsFull = (ConvertFrom-Json (Get-LastBody '*grep.app*')).params.arguments
$out.grepRepo = [string]$argsFull.repo
$out.grepPath = [string]$argsFull.path
$out.grepCase = [bool]$argsFull.matchCase
$out.grepRegex = [bool]$argsFull.useRegexp
$out.grepKeys = @($argsFull.PSObject.Properties.Name | Sort-Object)

# 2) grep.app 负例：不传 ⇒ 只有 query（body 与旧版一致）
$global:__cap = @()
$null = @(Search-GrepApp -Keyword 'expire' -Limit 1)
$argsBare = (ConvertFrom-Json (Get-LastBody '*grep.app*')).params.arguments
$out.bareKeys = @($argsBare.PSObject.Properties.Name | Sort-Object)

# 3) GitHub repo:/path:
$null = @(Search-GitHubCode -Keyword 'expire' -Limit 1 -RepoScope 'redis/redis' -PathFilter 'src')
$ghUri = Get-LastUri '*api.github.com/search/code*'
$out.ghRepo = ($ghUri -match 'repo%3Aredis%2Fredis')
$out.ghPath = ($ghUri -match 'path%3Asrc')

# 4) Sourcegraph repo:…$ / path:
$global:__cap = @()
$null = @(Search-Sourcegraph -Keyword 'expire' -Limit 1 -RepoScope 'redis/redis' -PathFilter 'src')
$sgUri = Get-LastUri '*sourcegraph.com*'
$out.sgRepo = ($sgUri -match 'repo%3Aredis%2Fredis%24')
$out.sgPath = ($sgUri -match 'path%3Asrc')
$out
`;

  const r = await probeWithMutants(probe, [], { timeoutMs: 180000 });
  const o = r.real;

  assert.equal(o.grepRepo, 'redis/redis', '★ repo 必须原样下发');
  assert.equal(o.grepPath, 'src');
  assert.equal(o.grepCase, true, '★ matchCase 必须下发');
  assert.equal(o.grepRegex, true, '★ useRegexp 必须下发');
  assert.deepEqual(o.grepKeys, ['matchCase', 'path', 'query', 'repo', 'useRegexp'], 'grep.app arguments 必须是这 5 个键');
  assert.deepEqual(o.bareKeys, ['query'], '★ 负例：不给参数时只能有 query（body 与旧版逐字节一致）');
  assert.equal(o.ghRepo, true, '★ GitHub 查询串必须含 repo:owner/repo');
  assert.equal(o.ghPath, true, '★ GitHub 查询串必须含 path:');
  assert.equal(o.sgRepo, true, '★ Sourcegraph 查询串必须含 repo:<slug>$');
  assert.equal(o.sgPath, true, '★ Sourcegraph 查询串必须含 path:');
});
