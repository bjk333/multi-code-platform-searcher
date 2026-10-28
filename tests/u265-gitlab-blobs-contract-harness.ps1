# tests/u265-gitlab-blobs-contract-harness.ps1 —— U-265（B2-1 4/4）：GitLabBlobs 迁 EngineContract v1。
#
# 为什么这个引擎要单独一套夹具（不复用 U-263/U-264 的形状）：
#   ① 它是唯一**有自设预算**的引擎（默认 4 次/查询），预算耗尽必须判 empty 而**不是** error ——
#      判 error 会让它从 coverage 的 executed 组掉出，Verdict 可能落 none（"请求了引擎但全未执行"）。
#      那正是 U-158E A-2 对照臂实测抓到的谎，当时靠改状态值绕过，现在是判定表里的一条规则。
#   ② 它是唯一把请求散在 **4 个辅助函数 + 一个嵌套 runspace 池**里的引擎 ⇒ `requests` 不从逐点计数来，
#      而是从 B2-6 的**账本**按 engine 聚合（Get-ApiRequestLedgerByEngine）。本夹具因此跑**真**
#      `Invoke-ApiRequest`（含记账一行），只桩传输层 —— 否则账本是空的，requests 恒 0 而门看不出来。
#
# 十臂（全部零网络）：
#   1  ok            全局 blobs 2 条 + 项目路径 1 次 GET   ⇒ ok，req=2/2/0
#   2  zero          全局 [] → 项目搜索 []                  ⇒ empty/zero-hit，req=2/2/0
#   3  forbidden     全局 403 + 项目搜索 403                ⇒ forbidden ⇒ error；req=2/0/2（**≠ 预算计数 1**）
#   4  budget        预算=1，全局 []                        ⇒ budget-truncated ⇒ **empty**，req=1/1/0
#   5  budgetPartial 预算=1，全局 2 条（路径补全被截断）    ⇒ budget-truncated + n=2 ⇒ degraded（legacy ok）
#   6  nokey         无 GITLAB_TOKEN                        ⇒ missing-credential ⇒ blocked，**零请求**
#   7  repoOk        -RepoScope，blobs 2 条                 ⇒ ok，req=1/1/0
#   8  repoZero      -RepoScope，blobs []                   ⇒ empty/zero-hit，req=1/1/0
#   9  auth401       全局 401                               ⇒ missing-credential（★PS7 下旧判据恒 false，见引擎注释）
#   10 rate429       全局 429 + 项目搜索 429                ⇒ rate-limited ⇒ legacy rate_limited
#
# ★本夹具**不**验 `Resolve-ApiHttpFailure` 的状态码分类（那是 U-261/U-178 的题目）：发送器抛的是字符串，
#   分类器判 IsHttpFailure=false 后原样重抛，消息里的 401/403/429 由引擎自己的判据读 —— 这正是被测的那一层。
param([string]$SkillDir = '')
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
if (-not $SkillDir) { $SkillDir = (Resolve-Path (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '..')).Path }
$SkillDir = (Resolve-Path $SkillDir).Path
$env:MCPS_NO_MAIN = '1'
. (Join-Path $SkillDir 'multi-platform-searcher.ps1')
. (Join-Path $SkillDir 'engines/gitlab-blobs.ps1')

# ---------- 传输层桩：只桩"发包"与"读配置"，记账一行不桩（同 U-261 的做法） ----------
function Get-DeadNetworkHost { param([string]$HostName) return '' }
function Get-ApiRequestRouteContext {
    param([string]$Uri, [switch]$NoProxy, [int]$BudgetMs)
    return [PSCustomObject]@{ ProxyMode = $false; Direct = $true; ProxyUrl = ''; NetworkRoute = [PSCustomObject]@{ Kind = 'direct' } }
}
function Resolve-UnprovenRouteBudget { param($Route, [int]$TimeoutSec, [int]$MaxAttempts) return [PSCustomObject]@{ TimeoutSec = $TimeoutSec; MaxAttempts = $MaxAttempts; Capped = $false } }
function Test-UnprovenRouteTimeout { param([bool]$Capped, [double]$ElapsedSec, [int]$TimeoutSec) return $false }
function Write-TlsTrace { param([string]$Message) }
function Get-ApiWallBudget { param($Start, [int]$DeadlineSec, [int]$TimeoutSec) return [PSCustomObject]@{ TimeoutSec = $TimeoutSec; RemainingMs = 5000; Exhausted = $false } }
function Resolve-ProxyGatewayOutcome { param($HostName, [switch]$ViaProxy, [int]$Code) return $null }
function Test-DeterministicTransportFailure { param([string]$Text, [bool]$ProxyActive) return '' }
function Set-DeadNetworkHost { param([string]$HostName, [string]$Reason) }
function Update-ApiRetryCounters { param($Resp) }
function Test-ApiRetryBudget { return $false }
function Get-RetryBackoff { param($Attempt, $MaxAttempts, $RetryAfterHeader) return [PSCustomObject]@{ HasNext = $false; WaitSec = 0; TooLong = $false } }
function Invoke-ApiNodeFallback {
    param($Uri, $Headers, $Method, $Body, $NodeDeadlineSec, $TraceUri, $Attempt, $MaxAttempts)
    return [PSCustomObject]@{ Action = 'throw'; Message = 'stub: node fallback disabled'; Log = ''; Result = $null; LastCode = $null }
}
function Write-ColorOutput { param([string]$Text, [string]$Color = 'White') }
function Add-EngineWarning { param($Engine, $Message, $From, $To) }
function Get-ApiHeaders { param($Token, $Scheme) return @{} }

# 按 URI 路由的发送器（`$script:` 前缀在调用时解析 ⇒ 每臂改 routes 立即生效，不用 GetNewClosure）
$script:routes = @()
$routeSender = {
    param($Uri, $Headers, $TimeoutSec, $Method, $Body, $networkRoute, [switch]$NoProxy, $reqSw)
    try { if ($reqSw) { $reqSw.Stop() } } catch { }
    foreach ($r in @($script:routes)) {
        if ($Uri -match $r.pat) {
            if ($r.thr) { throw $r.thr }
            return [PSCustomObject]@{ Content = $r.body; StatusCode = 200; Headers = @{} }
        }
    }
    throw ("stub: 未路由的 URI: {0}" -f $Uri)
}
Set-Item -Path function:Invoke-ApiWebOnce -Value $routeSender

function Set-Route([string]$Pattern, [string]$Body = '', [string]$Throw = '') {
    $script:routes = @($script:routes) + @([PSCustomObject]@{ pat = $Pattern; body = $Body; thr = $Throw })
}
function Reset-Routes { $script:routes = @() }

function Run-Arm {
    param([string]$Id, [scriptblock]$Setup, [string]$RepoScope = '', [bool]$NoKey = $false)
    Reset-Routes
    if ($NoKey) { Remove-Item Env:\GITLAB_TOKEN -ErrorAction SilentlyContinue } else { $env:GITLAB_TOKEN = 'stub' }
    Remove-Item Env:\MCPS_GITLAB_MAX_CALLS -ErrorAction SilentlyContinue
    & $Setup
    # ★进程级记忆必须每臂清：`Invoke-GitLabBlobDiscover` 会把"全局搜索对该账号恒 403"写进 AppDomain
    #   （生产里这是省 1 次请求的优化）。夹具不清的话，第 3 臂之后的**每一臂**都会走 403 回退路径，
    #   量到的全是 forbidden —— 那不是产品缺陷，是夹具在跨臂串味。
    try { [System.AppDomain]::CurrentDomain.SetData('MCPS.GitLabGlobalBlobsDisabled', $false) } catch { }
    # 账本与请求计数**同点重置**（生产里同在每轮开头那个 try 块）：只重置一边会让 requests 假红。
    Reset-ApiLedger
    [System.AppDomain]::CurrentDomain.SetData('mcps_reqstats', (New-Object 'System.Collections.Concurrent.ConcurrentBag[string]'))
    # 归属上下文：生产里由池包装块 / Invoke-EngineSerial 设；夹具显式清空以验证引擎的兜底赋值生效
    $script:_ledgerEngine = ''; $script:_ledgerMode = ''
    $envl = $null
    try { $envl = Search-GitLabBlobs -Keyword 'x' -Limit 3 -RepoScope $RepoScope } catch { }
    $null = Save-ApiLedger -NoWrite
    $v = Resolve-EngineVerdict -Envelope (ConvertTo-EngineEnvelope -Engine 'GitLabBlobs' -Kind 'code' -Result $envl)
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
        # 不自报：跑完后状态表里不该出现 GitLabBlobs
        selfReport  = [string](Get-EngineStatus -Name 'GitLabBlobs')
        # 账本侧交叉核对：行数必须等于封套的 attempted（同一份事实两处看）
        ledgerRows  = @(Get-ApiLedgerRows).Count
    }
}

# ★PS 单引号里可以直接写双引号 —— 别用 `.Replace('""','"')` 绕：那种写法的首尾引号会留下来，
#   于是 JSON 变成一个**字符串**而不是数组，`ConvertFrom-Json` 得到字符串、结果恒 0 条（第一版就这么翻车的）。
$blob2 = '[{"project_id":1,"ref":"main","path":"src/a.js","startline":10,"data":"code a"},{"project_id":1,"ref":"main","path":"src/b.js","startline":20,"data":"code b"}]'
$blobEmpty = '[]'
$proj = '{"path_with_namespace":"grp/proj"}'

$arms = @()
$arms += Run-Arm 'ok' { Set-Route 'search\?scope=blobs' $blob2; Set-Route '/api/v4/projects/1$' $proj }
$arms += Run-Arm 'zero' { Set-Route 'search\?scope=blobs' $blobEmpty; Set-Route '/api/v4/projects\?' $blobEmpty }
$arms += Run-Arm 'forbidden' {
    Set-Route 'search\?scope=blobs' '' 'stub: 403 Forbidden (Global Search is disabled for this scope)'
    Set-Route '/api/v4/projects\?' '' 'stub: 403 Forbidden'
}
$arms += Run-Arm 'budget' { $env:MCPS_GITLAB_MAX_CALLS = '1'; Set-Route 'search\?scope=blobs' $blobEmpty }
$arms += Run-Arm 'budgetPartial' { $env:MCPS_GITLAB_MAX_CALLS = '1'; Set-Route 'search\?scope=blobs' $blob2 }
$arms += Run-Arm 'nokey' { } -NoKey $true
$arms += Run-Arm 'repoOk' { Set-Route '/search\?scope=blobs' $blob2 } -RepoScope 'grp/proj'
$arms += Run-Arm 'repoZero' { Set-Route '/search\?scope=blobs' $blobEmpty } -RepoScope 'grp/proj'
# ★两条路由都要给：全局 401 ⇒ Discover 上抛前会**先回退**一次项目搜索（那是既有控制流），
#   只给第一条路由的话第二次落到"未路由"的桩异常，测到的是夹具的洞而不是产品行为（第一版就这么翻车的）。
$arms += Run-Arm 'auth401' { Set-Route 'search\?scope=blobs' '' 'stub: 401 Unauthorized - bad token'; Set-Route '/api/v4/projects\?' '' 'stub: 401 Unauthorized - bad token' }
$arms += Run-Arm 'rate429' { Set-Route 'search\?scope=blobs' '' 'stub: 429 Too Many Requests'; Set-Route '/api/v4/projects\?' '' 'stub: 429 Too Many Requests' }
Remove-Item Env:\GITLAB_TOKEN -ErrorAction SilentlyContinue
Remove-Item Env:\MCPS_GITLAB_MAX_CALLS -ErrorAction SilentlyContinue

$fails = @()
foreach ($a in $arms) { if ($a.selfReport -ne 'unknown') { $fails += ("{0}: 引擎自报了 status={1}（判定应只由 L1 派生）" -f $a.id, $a.selfReport) } }
foreach ($a in $arms) {
    if ($a.rAttempted -ne ($a.rSucceeded + $a.rFailed)) { $fails += ("{0}: attempted({1}) != succeeded+failed({2}+{3})" -f $a.id, $a.rAttempted, $a.rSucceeded, $a.rFailed) }
    if ($a.rAttempted -ne $a.ledgerRows) { $fails += ("{0}: attempts({1}) != 账本行数({2}) —— 两处必须同一份事实" -f $a.id, $a.rAttempted, $a.ledgerRows) }
}

[PSCustomObject]@{ ok = (@($fails).Count -eq 0); fails = @($fails); arms = @($arms) } | ConvertTo-Json -Depth 6 -Compress
if (@($fails).Count -gt 0) { exit 1 }
