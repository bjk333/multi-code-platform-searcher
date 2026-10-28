// U-188（2026-10-20，v1.46.0）：三类「上游信号」必须分档 —— 别再让不同的失败长得一样。
//
// 依据：reports/升级空间调研-2026-10-20.md 的 P1 三项（均为当日实测，不是二手结论）：
//   ① Sourcegraph：官方支持匿名，但本机出口返 **403 + 17.6KB "Firewall Block" HTML**。
//      旧行为：一律 `error` ⇒ ReasonCode=forbidden ⇒ 读成「账号能力关闭」，Agent 会去换令牌（换什么都不会好）。
//   ② OpenAlex：响应带 `X-RateLimit-Limit/-Remaining`（credits，默认 1000/天）；429 带 `Retry-After`。
//      旧行为：只在 429 之后说「已用尽」，看不到「还剩多少、等到几点」。
//   ③ Gitee v5 `/search/repositories`：**匿名恒返空数组**（带无效 token 才 401，Feedback #ICCSIY）。
//      旧行为：0 条记 `empty` ⇒ zero-hit，把「没登录所以没执行」说成「搜了但没有」。
//
// 门分两层：
//   A/B 源码级：接线必须存在（403 正文留证、防火墙分支、预算头读取、无 token 分档），且**不得**把带令牌 403 也说成网络问题。
//   C  行为级：Dot-source 主脚本 + 桩 `Invoke-ApiRequest`，逐个断言引擎状态；Gitee 两臂带**变异臂**（证明门能弄红）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { probeWithMutants, assertMutantsKilled, MAIN, rootDir } from './r94-ps-probe.mjs';
import { sourceAll } from './lib/source.mjs';

const read = (p) => fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
const stripComments = (src) => src.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');

const MAIN_SRC = sourceAll(rootDir);   // v1.54.0（B3-2）：读加载后视图
const MAIN_CODE = stripComments(MAIN_SRC);
const SG = read(path.join(rootDir, 'engines', 'sourcegraph.ps1'));
const SG_CODE = stripComments(SG);
const OA = read(path.join(rootDir, 'engines', 'open-alex.ps1'));
const OA_CODE = stripComments(OA);

test('U-188 A: 403 正文留证（只在 403、带时效、放在 Resolve-ApiHttpFailure 里）', () => {
  // Invoke-ApiRequest 必须在「非重试的 403」上把正文存进进程级 AppDomain（跨 runspace 可见）。
  //   ★位置有讲究：留证放在 Resolve-ApiHttpFailure（68 行）而不是 Invoke-ApiRequest（已顶到 100 行上限）——
  //   否则 U-163/U-177 的函数体长度门会红（本批踩过）。
  assert.match(
    MAIN_CODE,
    /\[System\.AppDomain\]::CurrentDomain\.SetData\('mcps_last_403'/,
    '★ 403 正文必须留证（否则引擎无法区分「出口被墙」与「令牌无权」）',
  );
  const resolver = MAIN_CODE.slice(MAIN_CODE.indexOf('function Resolve-ApiHttpFailure'), MAIN_CODE.indexOf('function Get-ApiNodePaths'));
  assert.match(resolver, /if \(\$httpCode -eq 403\) \{/, '留证必须只针对 403（不要把 200/429 的正文也存下来）');
  assert.match(resolver, /Ts = \[DateTime\]::UtcNow;/, '留证必须带时间戳（否则上一次请求的正文会被后一次误读）');
  assert.match(resolver, /if \(\$bb\.Length -gt 4096\) \{ \$bb = \$bb\.Substring\(0, 4096\) \}/, '留证必须截断（Firewall Block 页 17.6KB）');
  assert.match(MAIN_CODE, /Resolve-ApiHttpFailure -ErrorRecord \$_ -reqSw \$reqSw -Uri \$Uri/, '调用点必须把 Uri 传进解析器（否则留证无法归属到主机）');
});

test('U-188 B: Sourcegraph 403 三档 + OpenAlex 预算头 + Gitee 无 token 分档（源码契约）', () => {
  // Sourcegraph：Firewall Block ⇒ network_unavailable；匿名 403 ⇒ network_unavailable；带令牌 ⇒ 仍 error
  assert.match(SG_CODE, /\$fwBody -match 'Firewall Block\|firewall'/, '★ 必须先按正文判断是否防火墙拦截');
  const fwIdx = SG_CODE.indexOf("$fwBody -match 'Firewall Block|firewall'");
  const anonIdx = SG_CODE.indexOf('elseif (-not $env:SRC_TOKEN)');
  const tokIdx = SG_CODE.indexOf('Sourcegraph 403（带 SRC_TOKEN）');
  assert.ok(fwIdx > 0 && anonIdx > fwIdx && tokIdx > anonIdx, '★ 分档顺序必须是：防火墙 → 匿名 → 带令牌');
  // v1.53.3：锚点由「-Status … -Reason '…' 字面相邻」改为「同一调用内状态与 reason 文本共现」。
  //   v1.53.2 给三档 reason 挂 CodeFallbackHint，写法变成 -Reason ('…' -f $Cfg.CodeFallbackHint)，
  //   旧锚点 `-Reason '` 当场断 ⇒ 门过窄（断言的是字符串拼接形式，不是语义）。产品行为未变。
  assert.match(SG_CODE, /-Status 'network_unavailable'[\s\S]{0,80}?Sourcegraph 403 \+ 正文 "Firewall Block"/, '防火墙拦截必须记 network_unavailable（blocked），不是 error');
  assert.match(SG_CODE, /-Status 'network_unavailable'[\s\S]{0,80}?Sourcegraph 403（匿名）/, '匿名 403 必须记 network_unavailable（未执行）');
  assert.match(SG_CODE, /-Status 'error'[\s\S]{0,80}?Sourcegraph 403（带 SRC_TOKEN）/, '★ 带令牌 403 必须保持 error —— 不许把「令牌无权」也断言成网络问题');

  // OpenAlex：读预算头（Get-HeaderValue 必须进 Needs，否则池内取不到函数）
  assert.match(OA_CODE, /Get-HeaderValue -Headers \$resp\.Headers -Name 'X-RateLimit-Remaining'/, '必须读取 X-RateLimit-Remaining');
  assert.match(MAIN_SRC, /Func = 'Search-OpenAlex';[\s\S]{0,240}?Needs = @\([^)]*'Add-EngineWarning'[^)]*'Get-HeaderValue'/, '★ OpenAlex 的 Needs 必须登记 Add-EngineWarning + Get-HeaderValue');
  assert.match(OA_CODE, /Retry-After\\s\+\(\\d\+\)/, '429 必须解析服务端 Retry-After（折算"还要等多久"）');

  // Gitee：无 token ⇒ auth_missing（不是 zero-hit）
  assert.match(MAIN_CODE, /if \(-not \$env:GITEE_TOKEN\) \{\s*\n\s*Set-EngineStatus -Name 'Gitee' -Status 'auth_missing'/, '★ v5 匿名 0 条必须记 auth_missing（未执行），不得冒充 zero-hit');
  assert.match(MAIN_CODE, /Set-EngineStatus -Name 'Gitee' -Status 'empty' -Reason '检索成功但 0 命中（v5 带 GITEE_TOKEN/, '带令牌仍 0 条保持 empty（服务端内容风控未如实记账）');
});

test('U-188 C: 行为 —— 引擎状态按上游信号分档（含 Gitee 两臂变异）', async () => {
  const probe = `
$ErrorActionPreference = 'Stop'
$env:SRC_TOKEN = ''
$env:GITEE_TOKEN = ''
$out = [ordered]@{}

function global:Invoke-ApiRequest {
  param($Uri, $Headers, $TimeoutSec, $Method, $Body, $MaxAttempts, [switch]$NoProxy, $DeadlineSec, $NodeDeadlineSec)
  throw 'Response status code does not indicate success: 403 (Forbidden).'
}

# A: Sourcegraph 403 + Firewall Block 正文
[System.AppDomain]::CurrentDomain.SetData('mcps_last_403', [PSCustomObject]@{ Uri = 'https://sourcegraph.com/.api/search/stream?q=x'; Ts = [DateTime]::UtcNow; Body = '<html><head><title>Firewall Block</title></head></html>' })
$null = Search-Sourcegraph -Keyword 'x' -Limit 3
$out.sgFwStatus = [string](Get-EngineStatus -Name 'Sourcegraph')
$out.sgFwReason = [string]$script:_engineStatusReason['Sourcegraph']
$out.sgFwWarn = (@(Get-EngineWarnings) -join ' | ')

# B: Sourcegraph 403 无正文 + 匿名
[System.AppDomain]::CurrentDomain.SetData('mcps_last_403', $null)
$null = Search-Sourcegraph -Keyword 'x' -Limit 3
$out.sgAnonStatus = [string](Get-EngineStatus -Name 'Sourcegraph')
$out.sgAnonReason = [string]$script:_engineStatusReason['Sourcegraph']

# C: Sourcegraph 403 + 带令牌（不得断言成网络问题）
$env:SRC_TOKEN = 'dummy-token'
$null = Search-Sourcegraph -Keyword 'x' -Limit 3
$out.sgTokStatus = [string](Get-EngineStatus -Name 'Sourcegraph')
$out.sgTokReason = [string]$script:_engineStatusReason['Sourcegraph']
$env:SRC_TOKEN = ''

# D: OpenAlex 预算头 —— 剩余 3/1000 ⇒ 必须告警
function global:Invoke-ApiRequest {
  param($Uri, $Headers, $TimeoutSec, $Method, $Body, $MaxAttempts, [switch]$NoProxy, $DeadlineSec, $NodeDeadlineSec)
  [PSCustomObject]@{ Content = '{"results":[]}'; StatusCode = 200; Headers = @{ 'X-RateLimit-Limit' = '1000'; 'X-RateLimit-Remaining' = '3' } }
}
$null = Search-OpenAlex -Keyword 'x' -Limit 1
$out.oaLowWarn = (@(Get-EngineWarnings) -join ' | ')

# E: OpenAlex 预算充足 —— 不得刷告警
function global:Invoke-ApiRequest {
  param($Uri, $Headers, $TimeoutSec, $Method, $Body, $MaxAttempts, [switch]$NoProxy, $DeadlineSec, $NodeDeadlineSec)
  [PSCustomObject]@{ Content = '{"results":[]}'; StatusCode = 200; Headers = @{ 'X-RateLimit-Limit' = '1000'; 'X-RateLimit-Remaining' = '900' } }
}
$null = Search-OpenAlex -Keyword 'x' -Limit 1
$out.oaOkWarn = (@(Get-EngineWarnings) -join ' | ')

# F: Gitee v5 回退 —— 无 token / 有 token 两臂
function global:Invoke-ApiRequest {
  param($Uri, $Headers, $TimeoutSec, $Method, $Body, $MaxAttempts, [switch]$NoProxy, $DeadlineSec, $NodeDeadlineSec)
  [PSCustomObject]@{ Content = '[]'; StatusCode = 200; Headers = @{} }
}
$null = Invoke-GiteeV5Fallback -Keyword 'x' -MinStars 0 -Language '' -Limit 5 -PerPage 5
$out.giteeNoTok = [string](Get-EngineStatus -Name 'Gitee')
$out.giteeNoTokReason = [string]$script:_engineStatusReason['Gitee']
$env:GITEE_TOKEN = 'dummy-token'
$null = Invoke-GiteeV5Fallback -Keyword 'x' -MinStars 0 -Language '' -Limit 5 -PerPage 5
$out.giteeTok = [string](Get-EngineStatus -Name 'Gitee')
$env:GITEE_TOKEN = ''
$out
`;

  const mutants = [
    // Gitee：把「无 token ⇒ auth_missing」退回 empty（旧行为）⇒ 门必须红
    { name: 'gitee-no-token-as-empty', fn: 'Invoke-GiteeV5Fallback', find: "-Status 'auth_missing'", replace: "-Status 'empty'" },
    // Gitee：拆掉令牌守卫 ⇒ 无 token 也走 empty 分支
    { name: 'gitee-drop-token-guard', fn: 'Invoke-GiteeV5Fallback', find: 'if (-not $env:GITEE_TOKEN) {', replace: 'if ($false) {' },
  ];

  const r = await probeWithMutants(probe, mutants, { timeoutMs: 180000 });

  assertMutantsKilled(r, (o, where) => {
    assert.equal(o.sgFwStatus, 'network_unavailable', `${where}: Firewall Block 必须记 network_unavailable（实际 ${o.sgFwStatus}）`);
    assert.match(o.sgFwReason, /Firewall Block/, `${where}: reason 必须点名正文证据`);
    assert.match(o.sgFwReason, /重试无效|不是令牌问题/, `${where}: reason 必须写明「重试无效/不是令牌问题」`);
    assert.match(o.sgFwWarn, /\[Sourcegraph\].*防火墙/, `${where}: warnings[] 必须有一条 Sourcegraph 防火墙告警`);

    assert.equal(o.sgAnonStatus, 'network_unavailable', `${where}: 匿名 403 必须记 network_unavailable（实际 ${o.sgAnonStatus}）`);
    assert.match(o.sgAnonReason, /匿名/, `${where}: 匿名分支 reason 缺失`);

    assert.equal(o.sgTokStatus, 'error', `${where}: ★ 带令牌 403 必须仍为 error（不得断言成网络问题，实际 ${o.sgTokStatus}）`);

    assert.match(o.oaLowWarn, /\[OpenAlex\][^|]*仅剩 3\/1000 credits/, `${where}: 剩余 3/1000 必须告警（实际「${o.oaLowWarn}」）`);
    assert.doesNotMatch(o.oaOkWarn, /仅剩/, `${where}: 预算充足不得刷告警（实际「${o.oaOkWarn}」）`);

    assert.equal(o.giteeNoTok, 'auth_missing', `${where}: ★ v5 无 token 0 条必须记 auth_missing（实际 ${o.giteeNoTok}）`);
    assert.match(o.giteeNoTokReason, /GITEE_TOKEN/, `${where}: auth_missing 的 reason 必须指向 GITEE_TOKEN`);
    assert.equal(o.giteeTok, 'empty', `${where}: 带 token 0 条应保持 empty（实际 ${o.giteeTok}）`);
  });
});

test('U-188 D: 真 403 端到端 —— Invoke-ApiRequest 必须把正文留证（本地 403 服务，无外网）', async (t) => {
  // 为什么要有这一臂：C 臂把正文**直接塞进** AppDomain，只覆盖了引擎侧读取。
  //   这里用本地 403 服务真跑一遍 Invoke-ApiRequest，覆盖「请求层留证」这一半 —— 两半合起来才是完整链路。
  const body = '<html><head><title>Firewall Block</title></head><body>blocked by edge</body></html>';
  const srv = http.createServer((req, res) => {
    res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;

  let r = null;
  try {
    const script = [
      "$ErrorActionPreference = 'Continue'",
      `. '${MAIN.replace(/'/g, "''")}' -NoEnvFile -AsJson -Keyword x -Limit 1`,
      '$threw = $false; $msg = ""',
      `try { $null = Invoke-ApiRequest -Uri 'http://127.0.0.1:${port}/probe' -Headers @{} -TimeoutSec 8 -MaxAttempts 1 -NoProxy } catch { $threw = $true; $msg = "$_" }`,
      '$f = [System.AppDomain]::CurrentDomain.GetData("mcps_last_403")',
      '[ordered]@{ threw = $threw; msg = $msg; uri = $(if ($f) { [string]$f.Uri } else { "" }); body = $(if ($f) { [string]$f.Body } else { "" }) } | ConvertTo-Json -Compress',
    ].join('\n');
    // ★ 必须用异步 spawn：spawnSync 会阻塞本进程事件循环 ⇒ 同进程的 mock 服务无法应答（踩过：
    //   表现为 pwsh 侧 8s HttpClient 超时，误以为「本地 403 留证没生效」）。
    r = await new Promise((resolve) => {
      const child = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], { cwd: rootDir });
      let out = '', err = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', (c) => { out += c; });
      child.stderr.on('data', (c) => { err += c; });
      child.once('error', (e) => { clearTimeout(timer); resolve({ error: e, stdout: out, stderr: err, status: null }); });
      child.once('close', (status) => { clearTimeout(timer); resolve({ stdout: out, stderr: err, status }); });
    });
  } finally {
    srv.close();
  }

  if (!r || r.error) { t.skip('pwsh 不可用：跳过本臂（C 臂已覆盖引擎侧）'); return; }
  assert.equal(r.status, 0, 'probe 未正常结束: ' + String(r.stderr || '').slice(0, 400));
  const line = String(r.stdout || '').split(/\r?\n/).filter((l) => l.trim().startsWith('{')).pop();
  assert.ok(line, 'probe 未输出 JSON: ' + String(r.stdout || '').slice(-400));
  const o = JSON.parse(line);
  assert.equal(o.threw, true, '403 必须抛（否则调用方会把被墙当成功）');
  assert.match(o.uri, /127\.0\.0\.1/, '留证必须记录出问题的 Uri（引擎据此判断是不是 sourcegraph.com）');
  assert.match(o.body, /Firewall Block/, '★ 403 正文必须留证（这是分档的唯一证据）');
});
