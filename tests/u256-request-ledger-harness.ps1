# tests/u256-request-ledger-harness.ps1 —— U-256（B1-6）的数据面：**跑真 `Invoke-ApiRequest`**，只桩掉传输层。
#
# 为什么必须跑真函数、而不是读源码正则：
#   账本的恒等式 `Requests = Succeeded + Failed` 只有在"每条出口都记了一次"时才成立。
#   静态正则能看出"有没有那一行"，看不出"`continue` 之后有没有重复记"、"node 兜底算不算一次请求"。
#   所以这里把三个**发送器**（Invoke-ApiWebOnce / Invoke-ApiNodeFallback / socks 路径）栽成桩，
#   其余（预算、路由上下文、退避、限流判定）也桩掉以免睡/发网 —— 但**记账逻辑本身一行不桩**。
#
# 三个臂对应三种真实形态：
#   1 ok        —— 2xx：attempt=1 / ok=1
#   2 transport —— 拿不到响应（WebException 无 Response）⇒ 走 node 兜底再失败：attempt=2 / ok=0
#   3 http500   —— 上游答了但 5xx，退避判定为"不再重试"⇒ attempt=1 / ok=0
param([string]$SkillDir = '')
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
if (-not $SkillDir) { $SkillDir = (Resolve-Path (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '..')).Path }
$SkillDir = (Resolve-Path $SkillDir).Path
$env:MCPS_NO_MAIN = '1'
. (Join-Path $SkillDir 'multi-platform-searcher.ps1')

# ---------- 传输层桩（只桩"发包"与"读配置"，不桩记账）----------
function Get-DeadNetworkHost { param([string]$HostName) return '' }
function Get-ApiRequestRouteContext {
    param([string]$Uri, [switch]$NoProxy, [int]$BudgetMs)
    return [PSCustomObject]@{ ProxyMode = $false; Direct = $true; ProxyUrl = ''; NetworkRoute = [PSCustomObject]@{ Kind = 'direct' } }
}
function Resolve-UnprovenRouteBudget {
    param($Route, [int]$TimeoutSec, [int]$MaxAttempts)
    return [PSCustomObject]@{ TimeoutSec = $TimeoutSec; MaxAttempts = $MaxAttempts; Capped = $false }
}
function Test-UnprovenRouteTimeout { param([bool]$Capped, [double]$ElapsedSec, [int]$TimeoutSec) return $false }
function Write-TlsTrace { param([string]$Message) }
function Get-ApiWallBudget {
    param($Start, [int]$DeadlineSec, [int]$TimeoutSec)
    return [PSCustomObject]@{ TimeoutSec = $TimeoutSec; RemainingMs = 5000; Exhausted = $false }
}
function Resolve-ProxyGatewayOutcome { param($HostName, [switch]$ViaProxy, [int]$Code) return $null }
function Test-DeterministicTransportFailure { param([string]$Text, [bool]$ProxyActive) return '' }
function Set-DeadNetworkHost { param([string]$HostName, [string]$Reason) }
function Get-ApiHeaders { return @{} }
function Write-ColorOutput { param([string]$Message, [string]$Color) }
function Update-ApiRetryCounters { param($Resp) }
function Test-ApiRetryBudget { return $true }
function Get-RetryBackoff { param($Attempt, $MaxAttempts, $RetryAfterHeader) return [PSCustomObject]@{ HasNext = $false; WaitSec = 0; TooLong = $false } }
function Invoke-ApiNodeFallback {
    param($Uri, $Headers, $Method, $Body, $NodeDeadlineSec, $TraceUri, $Attempt, $MaxAttempts)
    return [PSCustomObject]@{ Action = 'throw'; Message = 'stub: node fallback disabled'; Log = ''; Result = $null; LastCode = $null }
}

function Reset-Ledger {
    [System.AppDomain]::CurrentDomain.SetData('mcps_reqstats', (New-Object 'System.Collections.Concurrent.ConcurrentBag[string]'))
}
function Arm([string]$id, [scriptblock]$sender, [scriptblock]$failResolver, [scriptblock]$run) {
    Reset-Ledger
    if ($failResolver) { Set-Item -Path function:Resolve-ApiHttpFailure -Value $failResolver }
    else {
        # 还原成脚本自带的实现（从 dot-source 后的定义里取不回来，故显式给一个"按真实形状"的保守桩）
        Set-Item -Path function:Resolve-ApiHttpFailure -Value {
            param($ErrorRecord, $reqSw, [string]$Uri = '')
            return [PSCustomObject]@{ IsHttpFailure = $false; Response = $null }
        }
    }
    Set-Item -Path function:Invoke-ApiWebOnce -Value $sender
    $err = ''
    try { $null = & $run } catch { $err = [string]$_.Exception.Message }
    $s = Get-ApiRequestStats
    return [PSCustomObject]@{
        id = $id; attempted = $s.Attempted; succeeded = $s.Succeeded; failed = $s.Failed
        # ★`attempted = succeeded + failed` 本身是**代数恒等**（failed 是派生量）⇒ 单独验它等于没验。
        #   有判别力的是下面两条：① failed 不得为负（= succeeded 不得超过 attempted，即"成功了却没记 attempt"）；
        #   ② 每个臂的 attempted 精确值（由 mjs 层钉住）—— 它才能抓出"少记一处 attempt"。
        identity = (($s.Attempted -eq ($s.Succeeded + $s.Failed)) -and ($s.Failed -ge 0) -and ($s.Succeeded -le $s.Attempted)); threw = ($err -ne '')
        error = $err.Substring(0, [Math]::Min(90, $err.Length))
    }
}

$okSender = { param($Uri, $Headers, $TimeoutSec, $Method, $Body, $networkRoute, [switch]$NoProxy, $reqSw) return [PSCustomObject]@{ Content = '{}'; StatusCode = 200; Headers = @{} } }
$boomSender = { param($Uri, $Headers, $TimeoutSec, $Method, $Body, $networkRoute, [switch]$NoProxy, $reqSw) throw 'stub: transport boom' }
$transportFail = {
    param($ErrorRecord, $reqSw, [string]$Uri = '')
    return [PSCustomObject]@{ IsHttpFailure = $true; Response = $null }
}
$http500Fail = {
    param($ErrorRecord, $reqSw, [string]$Uri = '')
    return [PSCustomObject]@{ IsHttpFailure = $true; Response = [PSCustomObject]@{ StatusCode = 500; Headers = @{}; Content = 'boom' } }
}
$call = { Invoke-ApiRequest -Uri 'https://ledger.invalid/x' -Headers @{} -TimeoutSec 5 -MaxAttempts 3 }

$rows = @()
$rows += Arm 'ok' $okSender $null $call
$rows += Arm 'transport' $boomSender $transportFail $call
$rows += Arm 'http500' $boomSender $http500Fail $call

$fails = @()
foreach ($r in $rows) { if (-not $r.identity) { $fails += ("{0}: identity broken ({1} != {2}+{3})" -f $r.id, $r.attempted, $r.succeeded, $r.failed) } }

[PSCustomObject]@{ ok = (@($fails).Count -eq 0); fails = @($fails); arms = @($rows) } | ConvertTo-Json -Depth 6 -Compress
if (@($fails).Count -gt 0) { exit 1 }
