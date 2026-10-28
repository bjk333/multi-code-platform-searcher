# tests/u264-deepseek-contract-harness.ps1 —— U-264（B2-1 3/4）：DeepSeek 迁 EngineContract v1 后的**契约与配额口径**。
#
# 与 U-263（GitHub）的差别：DeepSeek 是唯一会走 **402** 的付费源，所以本夹具的题目是
#   「配额耗尽这条路径，三层分类各说了什么」：
#     verdict.Status  = blocked（actionable = 充值/换 key，与 auth_missing 同类）
#     legacy 状态     = error   （⇒ coverage 的 Degraded。**绝不能是 unknown**：那会让它落进 NotRun，
#                                 载荷就会写着"这个源压根没跑"，而事实是它发了请求、被 402 拒了）
#     ReasonCodes     = quota-exhausted（精确到"是没钱，不是没网"）
#
# 八臂（全部零网络，只桩发包）：
#   1 ok        200 + 3 条（2 条过门槛、1 条被丢）  ⇒ ok（dropped>0 但有产出 ⇒ 仍 ok）
#   2 zero      200 + results=[]                    ⇒ empty / zero-hit（空结果不计费、不是失败）
#   3 filtered  200 + 2 条全低于门槛                 ⇒ empty / **filtered**（源健康，是我们自己丢的）
#   4 auth401   401                                  ⇒ missing-credential（blocked ⇒ auth_missing）
#   5 quota402  402 余额不足                          ⇒ quota-exhausted（blocked，legacy=error）
#   6 rate429   429                                  ⇒ rate-limited（error 分支 ⇒ legacy rate_limited）
#   7 forbid403 403                                  ⇒ forbidden（error；不许说成限流）
#   8 nokey     无 DEEPSEEK_API_KEY                  ⇒ not-run（blocked），**零请求**
#
# ★`Write-ColorOutput` 必须桩掉：它在**输出被重定向**时走 `Write-Output`（成功流），
#   字符串会混进 `$envl = Search-DeepSeek …` 的捕获 ⇒ 被当成"一条结果"（U-178 第一版就这么翻车过）。
param([string]$SkillDir = '')
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
if (-not $SkillDir) { $SkillDir = (Resolve-Path (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '..')).Path }
$SkillDir = (Resolve-Path $SkillDir).Path
$env:MCPS_NO_MAIN = '1'
. (Join-Path $SkillDir 'multi-platform-searcher.ps1')
. (Join-Path $SkillDir 'engines/deepseek-search.ps1')

function Write-ColorOutput { param([string]$Text, [string]$Color = 'White') }
function Add-EngineWarning { param($Engine, $Message, $From, $To) }

function New-ThrowSender([string]$msg) {
    return { param($Uri, $Headers, $TimeoutSec, $Method, $Body) throw $msg }.GetNewClosure()
}
function New-ContentSender([string]$json) {
    return { param($Uri, $Headers, $TimeoutSec, $Method, $Body) return [PSCustomObject]@{ Content = $json; StatusCode = 200 } }.GetNewClosure()
}

function Run-Arm {
    param([string]$Id, $Sender, [bool]$NoKey = $false)
    if ($NoKey) { Remove-Item Env:\DEEPSEEK_API_KEY -ErrorAction SilentlyContinue } else { $env:DEEPSEEK_API_KEY = 'stub' }
    Set-Item -Path function:Invoke-ApiRequest -Value $Sender -Force
    $envl = $null
    try { $envl = Search-DeepSeek -Keyword 'x' -Limit 3 } catch { }
    $v = Resolve-EngineVerdict -Envelope (ConvertTo-EngineEnvelope -Engine 'DeepSeek' -Kind 'research' -Result $envl)
    return [PSCustomObject]@{
        id          = $Id
        contract    = [string]$envl.contract
        engine      = [string]$envl.engine
        kind        = [string]$envl.kind
        fields      = @($envl.PSObject.Properties.Name | Sort-Object)
        n           = @($envl.results).Count
        rAttempted  = [int]$envl.requests.attempted
        rSucceeded  = [int]$envl.requests.succeeded
        rFailed     = [int]$envl.requests.failed
        quotaClass  = [string]$envl.quota.class
        hasFailure  = ($null -ne $envl.failure)
        failureCode = $(if ($envl.failure) { [string]$envl.failure.reasonCode } else { $null })
        vStatus     = [string]$v.Status
        vCode       = [string]$v.ReasonCode
        legacy      = [string](ConvertTo-LegacyEngineStatus -Verdict $v)
        elapsedOk   = ($null -ne $envl.elapsedMs -and [int]$envl.elapsedMs -ge 0)
        selfReport  = [string](Get-EngineStatus -Name 'DeepSeek')
    }
}

# rerank_score：2.0 / 1.5 过门槛（默认 1.0），0.5 被丢 ⇒ results=2, dropped=1
$okJson = '{"results":[{"title":"a","url":"https://a","summary":"s1","rerank_score":2.0,"authority":3,"site_name":"x","date":"2026-01-01"},' +
'{"title":"b","url":"https://b","summary":"s2","rerank_score":1.5,"authority":2},' +
'{"title":"c","url":"https://c","summary":"s3","rerank_score":0.5,"authority":1}]}'
$zeroJson = '{"results":[]}'
$filteredJson = '{"results":[{"title":"a","url":"https://a","summary":"s1","rerank_score":0.3},{"title":"b","url":"https://b","summary":"s2","rerank_score":0.4}]}'

$arms = @()
$arms += Run-Arm 'ok' (New-ContentSender $okJson)
$arms += Run-Arm 'zero' (New-ContentSender $zeroJson)
$arms += Run-Arm 'filtered' (New-ContentSender $filteredJson)
$arms += Run-Arm 'auth401' (New-ThrowSender '401 未经授权: Authentication Fails')
$arms += Run-Arm 'quota402' (New-ThrowSender '402 Payment Required: insufficient balance')
$arms += Run-Arm 'rate429' (New-ThrowSender '429 Too Many Requests')
$arms += Run-Arm 'forbid403' (New-ThrowSender '403 Forbidden')
$arms += Run-Arm 'nokey' (New-ContentSender $okJson) -NoKey $true
Remove-Item Env:\DEEPSEEK_API_KEY -ErrorAction SilentlyContinue

# ── verdict 规则表（直接喂合成封套，验 filtered 那条新规则不是恒真） ──
function V([int]$n, $failure) {
    # ★`1..0` 在 PowerShell 里是 @(1,0)（倒着数两行）—— 必须显式判 0（U-263 harness 记过同一个坑）
    $results = @(if ($n -gt 0) { 1..$n | ForEach-Object { [PSCustomObject]@{ Index = $_ } } })
    $v = Resolve-EngineVerdict -Envelope ([PSCustomObject]@{ results = $results; failure = $failure })
    return [PSCustomObject]@{ status = [string]$v.Status; code = [string]$v.ReasonCode; legacy = [string](ConvertTo-LegacyEngineStatus -Verdict $v) }
}
$rules = [PSCustomObject]@{
    n0NoFail      = V 0 $null
    n0Filtered    = V 0 @{ reasonCode = 'filtered'; reason = 'all dropped' }
    n0ZeroHit     = V 0 @{ reasonCode = 'zero-hit'; reason = 'none' }
    n0Quota       = V 0 @{ reasonCode = 'quota-exhausted'; reason = '402' }
    n0NotRun      = V 0 @{ reasonCode = 'not-run'; reason = 'no key' }
    n2Filtered    = V 2 @{ reasonCode = 'filtered'; reason = 'all dropped' }
    n2NoFail      = V 2 $null
}

$fails = @()
foreach ($a in $arms) { if ($a.selfReport -ne 'unknown') { $fails += ("{0}: 引擎自报了 status={1}（判定应只由 L1 派生）" -f $a.id, $a.selfReport) } }
foreach ($a in $arms) {
    if ($a.rAttempted -ne ($a.rSucceeded + $a.rFailed)) { $fails += ("{0}: attempted({1}) != succeeded+failed({2}+{3})" -f $a.id, $a.rAttempted, $a.rSucceeded, $a.rFailed) }
}

[PSCustomObject]@{ ok = (@($fails).Count -eq 0); fails = @($fails); arms = @($arms); rules = $rules } | ConvertTo-Json -Depth 6 -Compress
if (@($fails).Count -gt 0) { exit 1 }
