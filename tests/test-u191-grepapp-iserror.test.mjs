// U-191（2026-10-21，v1.46.4）：grep.app MCP 的 `result.isError` 必须分档 —— 上游限流不得记成"检索成功但 0 命中"。
//
// 事实（2026-10-21 实测）：
//   mcp.grep.app 在限流时仍返回 HTTP 200，SSE 负载是
//   {"result":{"content":[{"type":"text","text":"Unexpected token 'T', \"Too Many R\"... is not valid JSON"}],"isError":true}}
//   旧实现只判 `payload.error`（JSON-RPC error），于是把这段错误文本按 `Repository:` 切块 → 0 块 → `empty / 检索成功但 0 命中`。
//   产品实测：coverage.Executed 含 GrepApp，coverage.Reasons.GrepApp = "检索成功但 0 命中"，而同一分钟上游在限流/504。
//
// 门结构：A 源码契约；B 行为（四种 payload）+ C 引擎内变异（去掉 isError 分支 ⇒ 限流必须退化成 empty）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { probeWithMutants, rootDir } from './r94-ps-probe.mjs';

const read = (p) => fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
const ENGINE_PATH = path.join(rootDir, 'engines', 'grep-app.ps1');
const ENGINE = read(ENGINE_PATH);
const stripComments = (src) => src.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');
const ENGINE_CODE = stripComments(ENGINE);

test('U-191 A: 源码契约 —— isError 先于文本解析，且映射到 rate_limited / error（不是 empty）', () => {
  assert.match(ENGINE_CODE, /result\.PSObject\.Properties\.Name -contains 'isError'/,
    '★ 必须检查 result.isError（上游把限流包在 HTTP 200 的 result 里）');
  assert.match(ENGINE_CODE, /-Status 'rate_limited'/, '★ 限流必须记 rate_limited');
  assert.match(ENGINE_CODE, /Too Many\|429\|rate\.\?limit/, '★ 限流文本识别（实测正文含 Too Many Requests）');
  // 顺序：isError 分档必须在文本解析之前 —— 否则错误文本会先被当正常负载解析。
  //   ★v1.53.1：解析段抽进 ConvertFrom-GrepAppText（U-163-5 拆 104 行函数）⇒ 锚点从 `Split($block, …)` 挪到**调用点**；
  //   语义不变（仍是"分档早于解析"），但锚定的是调用而非实现细节 —— 解析实现再变也不用改本门。
  const isErrAt = ENGINE_CODE.indexOf("contains 'isError'");
  const splitAt = ENGINE_CODE.indexOf("ConvertFrom-GrepAppText -Text $block");
  assert.ok(isErrAt > 0 && splitAt > 0 && isErrAt < splitAt, '★ isError 分档必须早于文本解析（ConvertFrom-GrepAppText 调用）');
  // 只判 payload.error 不够（旧实现的根因）
  assert.match(ENGINE_CODE, /payload\.error/, 'payload.error 仍需保留（JSON-RPC 层错误）');
  const branch = ENGINE_CODE.slice(isErrAt, splitAt);
  assert.doesNotMatch(branch, /-Status 'empty'/, '★ isError 分支内不得写 empty（那是"执行过且没有"）');
});

test('U-191 B/C: 四种 payload 的状态分档 + 引擎内变异（去掉 isError ⇒ 限流退化成 empty）', async () => {
  const probe = `
$ErrorActionPreference = 'Stop'
$out = [ordered]@{}
$global:__body = ''
$NL = [char]10

function global:Invoke-ApiRequest {
  param($Uri, $Headers, $TimeoutSec, $Method, $Body, $MaxAttempts, [switch]$NoProxy, $DeadlineSec, $NodeDeadlineSec)
  return [PSCustomObject]@{ Content = $global:__body; StatusCode = 200; Headers = @{} }
}
function Set-Sse([string]$text, [bool]$isErr) {
  $p = @{ jsonrpc = '2.0'; id = 1; result = @{ content = @(@{ type = 'text'; text = $text }); isError = $isErr } } | ConvertTo-Json -Depth 8 -Compress
  $global:__body = ('event: message' + $NL + 'data: ' + $p)
}

# (1) 限流（实测原文）
Set-Sse 'Unexpected token ''T'', "Too Many R"... is not valid JSON' $true
$null = @(Search-GrepApp -Keyword 'x' -Limit 1)
$out.rateStatus = [string](Get-EngineStatus -Name 'GrepApp')
$out.rateReason = [string]$script:_engineStatusReason['GrepApp']
$out.rateWarn = (@(Get-EngineWarnings) -join ' | ')

# (2) 其它 isError ⇒ error（不是 empty）
Set-Sse 'upstream exploded' $true
$null = @(Search-GrepApp -Keyword 'x' -Limit 1)
$out.errStatus = [string](Get-EngineStatus -Name 'GrepApp')
$out.errReason = [string]$script:_engineStatusReason['GrepApp']

# (3) isError=false 且没有 Repository 块 ⇒ 仍是 empty（合法的零命中，不能被误升为 error）
Set-Sse 'no matches here' $false
$null = @(Search-GrepApp -Keyword 'x' -Limit 1)
$out.emptyStatus = [string](Get-EngineStatus -Name 'GrepApp')

# (4) 正常负载 ⇒ ok + 有结果
$okText = ('Repository: a/b' + $NL + 'Path: x.js' + $NL + 'URL: https://example.invalid/a/b/blob/main/x.js' + $NL + 'License: MIT' + $NL + $NL + '--- Snippet 1 (Line 3) ---' + $NL + 'const a = 1;')
Set-Sse $okText $false
$r = @(Search-GrepApp -Keyword 'x' -Limit 1)
$out.okStatus = [string](Get-EngineStatus -Name 'GrepApp')
$out.okCount = @($r).Count
$out.okPreview = [string]$r[0].Preview

# ---- 变异：把 isError 分支条件改成 $false ⇒ (1) 必须退化成 empty（证明门测的是真逻辑）----
$eng = [System.IO.File]::ReadAllText('__ENG_PATH__').TrimStart([char]0xFEFF)
$anchor = 'if ($payload.result -and ($payload.result.PSObject.Properties.Name -contains ''isError'') -and [bool]$payload.result.isError) {'
$mut = $eng.Replace($anchor, 'if ($false) {')
if ($mut -eq $eng) { throw 'mutation anchor missing' }
Invoke-Expression $mut
Set-Sse 'Unexpected token ''T'', "Too Many R"... is not valid JSON' $true
$null = @(Search-GrepApp -Keyword 'x' -Limit 1)
$out.mutStatus = [string](Get-EngineStatus -Name 'GrepApp')
Invoke-Expression $eng
$out
`.replace('__ENG_PATH__', ENGINE_PATH.replace(/\\/g, '\\\\'));

  const r = await probeWithMutants(probe, [], { timeoutMs: 180000 });
  const o = r.real;

  assert.equal(o.rateStatus, 'rate_limited', '★ 上游限流必须是 rate_limited（不能 empty）');
  assert.match(o.rateReason, /限流|Too Many|isError/, '★ 原因必须能看出是上游限流');
  assert.match(o.rateWarn, /不要当零命中|限流/, '★ 必须进 warnings（可审计）');
  assert.equal(o.errStatus, 'error', '其它 isError 必须 error');
  assert.equal(o.emptyStatus, 'empty', 'isError=false 且 0 块 ⇒ 仍是合法 empty（负例）');
  assert.equal(o.okStatus, 'ok');
  assert.equal(o.okCount, 1);
  assert.match(o.okPreview, /const a = 1/);
  assert.equal(o.mutStatus, 'empty', '★ 变异后仍不是 empty ⇒ isError 分支没被真正测到');
});
