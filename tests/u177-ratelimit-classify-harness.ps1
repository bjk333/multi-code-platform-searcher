# tests/u177-ratelimit-classify-harness.ps1 —— U-177「403 限流 vs 403 权限」分类夹具（零网络）
#   背景（2026-10-19 实测推理链）：
#     Invoke-ApiRequest 在 403 限流且重试耗尽后**重抛** "重试次数耗尽: … (last HTTP 403)"
#     ⇒ 「这是限流」这一事实在层边界被丢弃 ⇒ 引擎只能看到 403 ⇒ 误判 forbidden / error。
#   本夹具把 Invoke-ApiRequest 换成**按脚本消息抛出**的桩，真跑两个引擎的 catch 分类：
#     A 臂 GitHubCode + "(last HTTP 403, rate-limit)"  ⇒ 期望 rate_limited
#     B 臂 GitHubCode + "(last HTTP 403)"（无标记）     ⇒ 期望 **不是** rate_limited（error）
#     C 臂 GitLabBlobs + "(last HTTP 403, rate-limit)"  ⇒ 期望 rate_limited
#     D 臂 GitLabBlobs + "Global Search is disabled…"   ⇒ 期望 error + reason 含 403（真 forbidden 不得被吞）
#   输出全 ASCII：U177 <arm>=<status> … / U177_PASS | U177_FAIL <why>
param([string]$SkillDir = '')
$ErrorActionPreference = 'Continue'
if (-not $SkillDir) { $SkillDir = (Resolve-Path (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '..')).Path }
$SkillDir = (Resolve-Path $SkillDir).Path
$env:MCPS_NO_MAIN = '1'
. (Join-Path $SkillDir 'multi-platform-searcher.ps1')
# NO_MAIN 跳过主流程时状态表可能未初始化 ⇒ 补上（与主脚本同类型）
if (-not $script:_engineStatus) { $script:_engineStatus = [System.Collections.Concurrent.ConcurrentDictionary[string, string]]::new() }
if (-not $script:_engineStatusReason) { $script:_engineStatusReason = [System.Collections.Concurrent.ConcurrentDictionary[string, string]]::new() }
. (Join-Path $SkillDir 'engines\github-code.ps1')
. (Join-Path $SkillDir 'engines\gitlab-blobs.ps1')

$fails = @()
# ★`Write-ColorOutput` 必须桩掉：它在**输出被重定向**时走 `Write-Output`（成功流）⇒ 引擎在 catch 里
#   打的"检索失败"会混进返回值。迁移后引擎返回封套，被污染就成 [字符串, 封套] ⇒ 判 engine/0 + 2 条结果 ⇒ ok。
#   （C 臂第一版就这么翻车的：429 分类对了，但封套被污染，派生出来的是 ok。）
function Write-ColorOutput { param([string]$Text, [string]$Color = 'White') }
function Set-StubMsg([string]$msg) {
    $script:stubMsg = $msg
    Set-Item function:Invoke-ApiRequest -Value {
        param($Uri, $Headers, $TimeoutSec = 15, $MaxAttempts = 3, [switch]$NoProxy, $Method, $Body)
        throw $script:stubMsg
    } -Force
}
function Reset-Status([string]$name) {
    [void]$script:_engineStatus.TryRemove($name, [ref]([string]$null))
    [void]$script:_engineStatusReason.TryRemove($name, [ref]([string]$null))
}
# ★B2-1（U-265）：`Search-GitLabBlobs` 改返回 EngineContract v1 封套、不再自报状态。
#   C/D 臂要问的题目没变（403 带 rate-limit 标记 ⇒ 限流；真 403 ⇒ 权限），变的是**取值的来源** ⇒
#   走生产同一条 L1 链路把封套换算成"最终会进 coverage 的那个状态"。
function Get-DerivedStatus($Envelope) {
    $v = Resolve-EngineVerdict -Envelope (ConvertTo-EngineEnvelope -Engine 'GitLabBlobs' -Kind 'code' -Result $Envelope)
    return [PSCustomObject]@{ Status = [string](ConvertTo-LegacyEngineStatus -Verdict $v); Reason = [string]$v.Reason }
}
function Check([string]$arm, [string]$expect, [string]$got) {
    if ($got -eq $expect) { Write-Output "U177 $arm=$got" }
    else { $script:fails += "$arm expected $expect got $got"; Write-Output "U177 $arm=$got" }
}

# ── A 臂：GitHubCode + 限流标记
$env:GITHUB_TOKEN = 'stub'
Reset-Status 'GitHubCode'
Set-StubMsg '重试次数耗尽: https://api.github.com/search/code (last HTTP 403, rate-limit)'
$null = Search-GitHubCode -Keyword 'x' -Limit 3
Check 'A_ghcode_ratelimit' 'rate_limited' (Get-EngineStatus -Name 'GitHubCode')

# ── B 臂：GitHubCode + 真 403（无标记）不得被说成限流
Reset-Status 'GitHubCode'
Set-StubMsg '重试次数耗尽: https://api.github.com/search/code (last HTTP 403)'
$null = Search-GitHubCode -Keyword 'x' -Limit 3
Check 'B_ghcode_plain403' 'error' (Get-EngineStatus -Name 'GitHubCode')

# ── C 臂：GitLabBlobs + 限流标记
$env:GITLAB_TOKEN = 'stub'
Reset-Status 'GitLabBlobs'
Set-StubMsg '重试次数耗尽: https://gitlab.com/api/v4/search (last HTTP 403, rate-limit)'
$rC = Search-GitLabBlobs -Keyword 'x' -Limit 3
Check 'C_gitlab_ratelimit' 'rate_limited' (Get-DerivedStatus $rC).Status

# ── D 臂：GitLabBlobs + 真 403（能力关闭）必须仍报 error，且 reason 写清 403
Reset-Status 'GitLabBlobs'
Set-StubMsg '403: Global Search is disabled for this scope'
$rD = Get-DerivedStatus (Search-GitLabBlobs -Keyword 'x' -Limit 3)
$dStatus = $rD.Status
$dReason = $rD.Reason
Check 'D_gitlab_forbidden' 'error' $dStatus
if ($dReason -match '403') { Write-Output "U177 D_reason=has403" } else { $script:fails += 'D reason missing 403'; Write-Output "U177 D_reason=missing" }

Remove-Item Env:\GITHUB_TOKEN -ErrorAction SilentlyContinue
Remove-Item Env:\GITLAB_TOKEN -ErrorAction SilentlyContinue

if ($fails.Count -eq 0) { Write-Output 'U177_PASS'; exit 0 }
Write-Output ('U177_FAIL ' + ($fails -join ' | ')); exit 1
