// B3-3 行为层探针：把**产品原函数**点源进子进程，只替换两个接缝，其余全走真代码。
//
// 替换的只有两处，且都是产品自己为"可测"留出的边界：
//   ① `Get-ApiRequestRouteContext` —— 探活。本机 hosts 把多个域指向 127.0.0.1，真探活会让引擎在
//      `blocked`/`executed` 之间翻来翻去；这里固定回 direct+reachable（与 `MCPS_REPLAY_DIR` 分支同形）。
//   ② `Invoke-ApiWebOnce` —— 只把 URL 的 host 段塞进本地夹具的路径前缀，随后调用**产品的**
//      `Invoke-WebRequestDirect`。异常类型、状态码、响应头都由真实 cmdlet 产生。
// 不替换 `Invoke-ApiRequest`：重试/退避/预算/账本/403 留证/状态派生全部真跑 —— 那才是引擎层最容易错的地方。
//
// 用真 HTTP 而不是返回假对象：为了能同时断言"你问了什么"（URL/header/方法，由夹具记录）
// 与"你从回答里读出了什么"（结果条目/状态判定，由探针返回）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..', '..');
const MAIN = path.join(ROOT, 'multi-platform-searcher.ps1');

const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";

function psValue(v) {
  if (v === null || v === undefined) return '$null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return q(v);
}

function psHashtable(obj) {
  const parts = Object.entries(obj || {}).map(([k, v]) => `${q(k)} = ${psValue(v)}`);
  return '@{ ' + parts.join('; ') + ' }';
}

function buildProbe({ fn, params, port, preamble = '', overrides = '', root = ROOT }) {
  const statusName = params.__statusName || fn.replace(/^Search-/, '');
  const cleanParams = { ...params };
  delete cleanParams.__statusName;
  const mainPath = path.join(root, 'multi-platform-searcher.ps1');
  return `$ErrorActionPreference = 'Stop'
# 本进程 stdout 钉成 UTF-8：产物是 JSON，而 AsJson 的 UTF-8 钉盘代码在主流程里（dot-source 时被跳过）
#   ⇒ 不设这一行，pwsh 会用控制台代码页（本机 GBK）写 JSON，Node 按 UTF-8 读 → 中文全成乱码，
#   于是所有"告警里必须出现某句中文"的断言都会假红。
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }
$env:MCPS_NO_MAIN = '1'
$env:MCPS_PROXY = ''
$env:MCPS_HEALTH = '0'
$env:MCPS_FIXTURE_PORT = ${q(String(port))}
# 令牌/站点类变量清空：臂的判据不许随本机 .env 或宿主环境漂移
$env:GITEE_TOKEN = ''
$env:GITHUB_TOKEN = ''
$env:SE_KEY = ''
$env:MCPS_OPENALEX_API_KEY = ''
$env:MCPS_OPENALEX_MAILTO = ''
$env:MCPS_SE_SITE = ''
${preamble}
. ${q(mainPath)} -NoEnvFile -AsJson

# ── 接缝 ①：探活固定为 direct+reachable（与 MCPS_REPLAY_DIR 分支同形，一个探针都不发）
function Get-ApiRequestRouteContext {
    param([string]$Uri, [switch]$NoProxy, [int]$BudgetMs = 0)
    $rt = [PSCustomObject]@{ Kind = 'direct'; Source = 'fixture'; ProbeState = 'reachable'; ProxyUrl = $null }
    return [PSCustomObject]@{ NetworkRoute = $rt; NetworkEngine = 'fixture'; ProxyMode = $false; ProxyUrl = $null; Direct = $true }
}

# ── 接缝 ②：只改 URL 前缀，传输仍走产品的 Invoke-WebRequestDirect（异常/状态码/头都是真的）
#   ★v1.66.0（U-284）：**自包含**，不再调用 ConvertTo-FixtureUri —— 这个函数会被注入嵌套 runspace
#   （它在 Get-HttpLayerClosure 里），而 ConvertTo-FixtureUri 不在闭包内 ⇒ 池内调用只剩 CommandNotFound，
#   被产品的 catch 吞成 0 命中。表现是"逐项目 blobs 永远没结果"，看起来跟"源没数据"一模一样。
function ConvertTo-FixtureUri {
    param([string]$Uri)
    $x = [uri]$Uri
    return ('http://127.0.0.1:{0}/{1}{2}' -f $env:MCPS_FIXTURE_PORT, $x.Host, $x.PathAndQuery)
}
function Invoke-ApiWebOnce {
    param([string]$Uri, [hashtable]$Headers, [int]$TimeoutSec, [string]$Method, [string]$Body, $networkRoute, [switch]$NoProxy, $reqSw)
    # U-286：把**改写前**的 URI 记下来。CLI 回放要把 fixture 的响应重建成 responses.jsonl，
    #   而重建只能靠"host + path"反推原 URI —— 反推对不对必须能自证，不能靠"看起来一样"。
    try { if ($null -eq $script:__probeUris) { $script:__probeUris = New-Object System.Collections.ArrayList }; [void]$script:__probeUris.Add([string]$Uri) } catch { }
    $__x = [uri]$Uri
    $__u = ('http://127.0.0.1:{0}/{1}{2}' -f $env:MCPS_FIXTURE_PORT, $__x.Host, $__x.PathAndQuery)
    $p = @{ Uri = $__u; Headers = $Headers; UseBasicParsing = $true; TimeoutSec = $TimeoutSec; Method = $Method }
    if ($Body) { $p['Body'] = $Body }
    try {
        $r = Invoke-WebRequestDirect -Params $p -Direct
        $c = $r.Content; if ($c -isnot [string]) { $c = [string]$c }
        $out = [PSCustomObject]@{ Content = $c; StatusCode = [int]$r.StatusCode; Headers = $r.Headers }
    } finally {
        if ($reqSw) { try { $reqSw.Stop() } catch { } }
    }
    return $out
}

# ── 接缝 ③（U-280）：**函数级替换**，插在点源之后、调用之前。
#   只给"根本没有网络接缝"的引擎用（LocalCode 找外部二进制、读本机磁盘）。
#   为什么不放在 preamble：preamble 在点源 **之前**，产品自己的定义会把它覆盖掉 —— 那是本文件
#   早就写过的坑（照抄会得到"替换没生效、测试照样绿"）。模板字符串里也不能出现反引号，
#   上一版就是被一个反引号提前截断了整段（JS 报的却是别的行）。
${overrides}
$__ok = $true; $__err = $null; $__res = $null
# 必须是"先赋值再 splat"：Search-X 后直接跟哈希表字面量 = 把它当**一个位置参数**传进去
#   （本轮踩过：URL 里出现 q=System.Collections.Hashtable），只有 @$var 才是具名实参。
$__p = ${psHashtable(cleanParams)}
try {
    $__res = ${fn} @__p
} catch {
    $__ok = $false; $__err = $_.Exception.Message
}
$__st = $null
try { $__st = (Get-EngineStatus -Name ${q(statusName)}) } catch { }
# U-281：状态只是一个词，**理由**才是调用方用来决定"换令牌还是换网络"的东西。
#   不把 reason 带出来，"403 被说成防火墙拦"与"403 被说成令牌无效"在断言里同形（都是 network_unavailable/error）。
$__why = $null
try { [void]$script:_engineStatusReason.TryGetValue(${q(statusName)}, [ref]$__why) } catch { }
$__warn = @()
try { $__warn = @(Get-EngineWarnings) } catch { }   # 取走即清空（ConcurrentQueue 语义），一次探针只读一次
# ★$null 不是"一条结果"：LocalCode 在 tool_missing / 路径无效时明确 return $null，
#   而 @($null).Count 是 1 ⇒ 探针会把"什么都没查到"报成"1 条"，所有零命中判据一起失效。
$__arr = @($__res | Where-Object { $null -ne $_ })
$__out = [PSCustomObject]@{
    ok = $__ok
    error = $__err
    result = $__arr             # 恒为数组：1 条结果与"没有结果"在 JSON 里不能同形
    count = $__arr.Count
    status = $__st
    reason = $__why
    warnings = @($__warn)
    uris = @($script:__probeUris | Where-Object { $_ })   # U-286：改写前的原始 URI（逐次调用，与夹具 hits 一一对应）
    killed = $false
}
$__out | ConvertTo-Json -Depth 8 -Compress
`;
}

/**
 * 跑一个引擎函数。返回 { ok, payload, stdout, stderr, code, timedOut }
 * payload: { ok, error, result, status }
 */
export function runEngine({ fn, params = {}, port, env = {}, timeoutMs = 60000, root = ROOT, overrides = '', preamble = '' }) {
  const code = buildProbe({ fn, params, port, overrides, root, preamble });
  const file = path.join(os.tmpdir(), `mcps-beh-${process.pid}-${Math.random().toString(36).slice(2)}.ps1`);
  fs.writeFileSync(file, code, 'utf8');
  const childEnv = { ...process.env, ...env };
  // 清掉可能把请求引到别处的宿主变量（本项目在真机上踩过：宿主代理全超时）
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy']) delete childEnv[k];

  return new Promise((resolve) => {
    const p = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-File', file], {
      cwd: root, windowsHide: true, env: childEnv,
    });
    let out = '';
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { p.kill(); } catch { } }, timeoutMs);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code2) => {
      clearTimeout(timer);
      try { fs.unlinkSync(file); } catch { }
      let payload = null;
      const line = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop();
      try { payload = JSON.parse(line); } catch { }
      resolve({ ok: !!(payload && payload.ok), payload, stdout: out, stderr: err, code: code2, timedOut });
    });
    p.on('error', (e) => {
      clearTimeout(timer);
      try { fs.unlinkSync(file); } catch { }
      resolve({ ok: false, payload: null, stdout: out, stderr: err + '\n' + e.message, code: -1, timedOut });
    });
  });
}
