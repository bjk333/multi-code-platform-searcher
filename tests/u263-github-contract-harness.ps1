# tests/u263-github-contract-harness.ps1 —— U-263（B2-1 2/4）：GitHub 迁 EngineContract v1 后的**契约与请求账**。
#
# 为什么要独立于 U-178（403 分类）：
#   U-178 只问"403 是限流还是权限"；本门问**封套本身**——字段集恰好 9 个、contract=engine/1、
#   `requests` 三格与真实发包次数对得上、`quota.class` 是已知事实（有令牌就 authenticated）、
#   以及**引擎不再自报 status**（自报与派生只能有一个真源）。
#
# 六臂（全部零网络，只桩发包）：
#   1 ok        200 + 1 条结果            ⇒ ok / 无 failure
#   2 zero      200 + total_count=0       ⇒ empty / zero-hit（"搜了没结果"是成功）
#   3 auth401   401                       ⇒ missing-credential（blocked ⇒ auth_missing）
#   4 forbid403 403 无 rate-limit 标记     ⇒ forbidden（error；不许说成限流）
#   5 stale     传输失败 + 陈旧缓存 2 条    ⇒ ok（有产出即 ok；陈旧由 Stale 标记与 warnings 承载）
#   6 anon      无 GITHUB_TOKEN            ⇒ quota.class=anonymous
#
# ★`Write-ColorOutput` 必须桩掉：它在**输出被重定向**时走 `Write-Output`（成功流），
#   字符串会混进 `$envl = Search-GitHub …` 的捕获 ⇒ 被离成"结果"（U-178 第一版就这么翻车过）。
param([string]$SkillDir = '')
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
if (-not $SkillDir) { $SkillDir = (Resolve-Path (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '..')).Path }
$SkillDir = (Resolve-Path $SkillDir).Path
$env:MCPS_NO_MAIN = '1'
. (Join-Path $SkillDir 'multi-platform-searcher.ps1')
. (Join-Path $SkillDir 'engines/github.ps1')

function Write-ColorOutput { param([string]$Text, [string]$Color = 'White') }
function Wait-RateLimitToken { param($Bucket) }
function Get-ApiHeaders { param($Token, $Scheme) return @{} }
function Add-EngineWarning { param($Engine, $Message, $From, $To) }

$script:staleRows = @()
function Get-GitHubStaleFallback {
    param($CacheKey)
    return $script:staleRows
}

function Run-Arm {
    param([string]$Id, [scriptblock]$Sender, [int]$StaleCount = 0, [bool]$NoToken = $false)
    if ($NoToken) { Remove-Item Env:\GITHUB_TOKEN -ErrorAction SilentlyContinue } else { $env:GITHUB_TOKEN = 'stub' }
    # ★`1..0` 在 PowerShell 里是 @(1,0)（**倒着数两行**），不是空集 ⇒ 必须显式判 0，
    #   否则"没有陈旧缓存"的臂会凭空拿到两条 stale 行（本夹具第一版就吃了这个亏）。
    $script:staleRows = @(if ($StaleCount -gt 0) { 1..$StaleCount | ForEach-Object { [PSCustomObject]@{ Index = $_; Platform = 'GitHub'; Name = "stale/$_"; Stale = $true } } })
    Set-Item -Path function:Invoke-ApiRequest -Value $Sender -Force
    $envl = $null
    try { $envl = Search-GitHub -Keyword 'x' -Language $null -MinStars 0 -Limit 3 } catch { }
    $v = Resolve-EngineVerdict -Envelope (ConvertTo-EngineEnvelope -Engine 'GitHub' -Kind 'repo' -Result $envl)
    return [PSCustomObject]@{
        id          = $Id
        contract    = [string]$envl.contract
        engine      = [string]$envl.engine
        kind        = [string]$envl.kind
        fields      = @($envl.PSObject.Properties.Name | Sort-Object)
        n           = @($envl.results).Count
        names       = @($envl.results | ForEach-Object { [string]$_.Name })
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
        # 不自报：跑完后状态表里不该出现 GitHub（夹具已把注入的状态表当真实表用）
        selfReport  = [string](Get-EngineStatus -Name 'GitHub')
    }
}

$script:okJson = '{"total_count":1,"items":[{"full_name":"a/b","stargazers_count":5,"html_url":"https://github.com/a/b","description":"d","license":null,"updated_at":"2026-01-01T00:00:00Z","archived":false}]}'
$script:zeroJson = '{"total_count":0,"items":[]}'
$okSender = { param($Uri, $Headers, $TimeoutSec, $Method, $Body) return [PSCustomObject]@{ Content = $script:okJson; StatusCode = 200 } }
$zeroSender = { param($Uri, $Headers, $TimeoutSec, $Method, $Body) return [PSCustomObject]@{ Content = $script:zeroJson; StatusCode = 200 } }
function New-ThrowSender([string]$msg) {
    return { param($Uri, $Headers, $TimeoutSec, $Method, $Body) throw $msg }.GetNewClosure()
}

$arms = @()
$arms += Run-Arm 'ok' $okSender
$arms += Run-Arm 'zero' $zeroSender
$arms += Run-Arm 'auth401' (New-ThrowSender '401 未经授权: Bad credentials')
$arms += Run-Arm 'forbid403' (New-ThrowSender '403 禁止: Resource not accessible by personal access token')
$arms += Run-Arm 'stale' (New-ThrowSender 'stub: transport boom') -StaleCount 2
$arms += Run-Arm 'anon' $okSender -NoToken $true
Remove-Item Env:\GITHUB_TOKEN -ErrorAction SilentlyContinue

$fails = @()
foreach ($a in $arms) { if ($a.selfReport -ne 'unknown') { $fails += ("{0}: 引擎自报了 status={1}（判定应只由 L1 派生）" -f $a.id, $a.selfReport) } }

[PSCustomObject]@{ ok = (@($fails).Count -eq 0); fails = @($fails); arms = @($arms) } | ConvertTo-Json -Depth 6 -Compress
if (@($fails).Count -gt 0) { exit 1 }
