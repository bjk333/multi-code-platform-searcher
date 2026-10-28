# tests/u178-github-403-harness.ps1 —— U-178「GitHub 403：限流 vs 权限」分类夹具（零网络）
#   背景（2026-10-19）：`engines/github.ps1` 旧写法把 $msg **覆盖**成 '403 禁止'，
#     抹掉了 U-177 带出的 ', rate-limit' 标记，随后 403 一律报 rate_limited
#     ⇒ 「token 缺 scope」被说成「限流」，用户会去等而不是去修 token（与 U-177 相反方向的谎）。
#   三臂（桩跑 Search-GitHub 的 catch 分类）：
#     A 403 + ', rate-limit'        ⇒ rate_limited
#     B 403 + 权限文案（无标记）      ⇒ error        （负例：不得说成限流）
#     C 401 未经授权                ⇒ auth_missing
#   输出全 ASCII：U178 A=<status> … / U178_PASS | U178_FAIL <why>
param([string]$SkillDir = '')
$ErrorActionPreference = 'Continue'
if (-not $SkillDir) { $SkillDir = (Resolve-Path (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '..')).Path }
$SkillDir = (Resolve-Path $SkillDir).Path
$env:MCPS_NO_MAIN = '1'
. (Join-Path $SkillDir 'multi-platform-searcher.ps1')
if (-not $script:_engineStatus) { $script:_engineStatus = [System.Collections.Concurrent.ConcurrentDictionary[string, string]]::new() }
if (-not $script:_engineStatusReason) { $script:_engineStatusReason = [System.Collections.Concurrent.ConcurrentDictionary[string, string]]::new() }
. (Join-Path $SkillDir 'engines\github.ps1')

$fails = @()
function Set-StubMsg([string]$msg) {
    $script:stubMsg = $msg
    Set-Item function:Invoke-ApiRequest -Value {
        param($Uri, $Headers, $TimeoutSec = 15, $MaxAttempts = 3, [switch]$NoProxy, $Method, $Body)
        throw $script:stubMsg
    } -Force
    Set-Item function:Wait-RateLimitToken -Value { param($Bucket) } -Force
    Set-Item function:Get-GitHubStaleFallback -Value { param($CacheKey) return @() } -Force
    # ★必须桩掉：`Write-ColorOutput` 在**输出被重定向**时走 `Write-Output`（成功流）⇒ 字符串会混进
    #   `$envlA = Search-GitHub …` 的捕获里，`ConvertTo-EngineEnvelope` 于是包出 results=[字符串, 封套]
    #   ⇒ n=2 ⇒ 判定 ok（实测：本夹具第一版就是这样把三个臂全报成 ok 的）。
    Set-Item function:Write-ColorOutput -Value { param($Text, $Color) } -Force
}
function Reset-Status([string]$name) {
    [void]$script:_engineStatus.TryRemove($name, [ref]([string]$null))
    [void]$script:_engineStatusReason.TryRemove($name, [ref]([string]$null))
}
function Check([string]$arm, [string]$expect, [string]$got) {
    if ($got -eq $expect) { Write-Output "U178 $arm=$got" }
    else { $script:fails += "$arm expected $expect got $got"; Write-Output "U178 $arm=$got" }
}
# ★B2-1（U-263）：引擎已迁 engine/1，**不自报 status** ⇒ 夹具必须走**生产同一条链路**派生：
#   Resolve-EngineVerdict → ConvertTo-LegacyEngineStatus。直接读 `_engineStatus` 只会读到 unknown
#   （那正是"不自报"这条不变量的证据，见下面的 A_noSelfReport）。
function Get-LegacyFromEnvelope($envl) {
    $v = Resolve-EngineVerdict -Envelope (ConvertTo-EngineEnvelope -Engine 'GitHub' -Kind 'repo' -Result $envl)
    return [PSCustomObject]@{ Legacy = (ConvertTo-LegacyEngineStatus -Verdict $v); Status = $v.Status; Code = $v.ReasonCode }
}

$env:GITHUB_TOKEN = 'stub'

# A 臂：限流标记
Reset-Status 'GitHub'
Set-StubMsg '重试次数耗尽: https://api.github.com/search/repositories?q=x (last HTTP 403, rate-limit)'
$envlA = Search-GitHub -Keyword 'x' -Language $null -MinStars 0 -Limit 3
$vA = Get-LegacyFromEnvelope $envlA
Check 'A_ratelimit' 'rate_limited' $vA.Legacy
Check 'A_code' 'rate-limited' $vA.Code
Check 'A_noSelfReport' 'unknown' (Get-EngineStatus -Name 'GitHub')

# B 臂：权限不足（无标记）—— 负例
Reset-Status 'GitHub'
Set-StubMsg '403 禁止: Resource not accessible by personal access token'
$envlB = Search-GitHub -Keyword 'x' -Language $null -MinStars 0 -Limit 3
$vB = Get-LegacyFromEnvelope $envlB
Check 'B_forbidden' 'error' $vB.Legacy
Check 'B_code' 'forbidden' $vB.Code

# C 臂：401
Reset-Status 'GitHub'
Set-StubMsg '401 未经授权: Bad credentials'
$envlC = Search-GitHub -Keyword 'x' -Language $null -MinStars 0 -Limit 3
$vC = Get-LegacyFromEnvelope $envlC
Check 'C_auth' 'auth_missing' $vC.Legacy
Check 'C_code' 'missing-credential' $vC.Code

Remove-Item Env:\GITHUB_TOKEN -ErrorAction SilentlyContinue

if ($fails.Count -eq 0) { Write-Output 'U178_PASS'; exit 0 }
Write-Output ('U178_FAIL ' + ($fails -join ' | ')); exit 1
