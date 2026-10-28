# tests/a11-ratelimited-harness.ps1 —— A-11「Doctor 单列限流源」离线夹具（零网络）
#   判据（任务书 §3 A-11）：人为触发限流 ⇒ 该源出现在 doctor.rateLimitedSources 表里。
#   做法：dot-source 主脚本（MCPS_NO_MAIN=1 只取函数），把 Invoke-ApiRequest 换成按 URL 决定结果的桩：
#     api.openalex.org  ⇒ throw 429（经典形状）
#     hub.docker.com    ⇒ throw「限流等待过长: … (Retry-After 30805s)」（TooLong 形状，消息不含 429）
#     其余              ⇒ 200
#   然后**真跑** Get-DoctorResearchHealth（产品的探针循环与分类），再把研究探针结果 + 合成的远程引擎/令牌行
#   交给 Get-DoctorRateLimitedSources。对照臂：全 200 桩 ⇒ 表必须为空。
#   输出全 ASCII（门解析不依赖代码页）：A11 research=<…> code=<…> token=<…> total=N / A11-CTRL total=N / A11_PASS|A11_FAIL <why>
param([string]$SkillDir = '')
$ErrorActionPreference = 'Continue'
if (-not $SkillDir) { $SkillDir = (Resolve-Path (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '..')).Path }
$SkillDir = (Resolve-Path $SkillDir).Path
$env:MCPS_NO_MAIN = '1'
$env:MCPS_DOCTOR_RESEARCH = '1'
# P1（2026-10-19）：研究探针默认**并行**（每源一个 runspace）—— 本夹具的打桩只作用于**主 runspace**，
#   故显式退回串行路径（产品的唯一另一条路径），保住「真跑探针循环与分类」的判据。
$env:MCPS_DOCTOR_PARALLEL = '0'
Remove-Item Env:\GITHUB_TOKEN -ErrorAction SilentlyContinue   # 关掉 N-17 的 GitHub 废弃头探测分支（它也走桩，但与本门无关）
. (Join-Path $SkillDir 'multi-platform-searcher.ps1')

$fails = @()
function Set-Stub([string]$Mode) {
    $script:stubMode = $Mode
    Set-Item function:Invoke-ApiRequest -Value {
        # 参数与产品签名对齐（含 P1 的 -DeadlineSec / -NodeDeadlineSec）：桩少参数会以「找不到参数」失败，
        #   那会把「夹具坏了」伪装成「探针都不可达」。
        param($Uri, $Headers, $TimeoutSec = 15, $Method = 'GET', $Body = $null, [switch]$NoProxy, $MaxAttempts = 3, $NodeDeadlineSec = -1, $DeadlineSec = 0)
        if ($script:stubMode -eq 'limit') {
            if ($Uri -match 'api\.openalex\.org') { throw 'HTTP 429 Too Many Requests' }
            if ($Uri -match 'hub\.docker\.com') { throw "限流等待过长: $Uri (Retry-After 30805s)" }
        }
        return [PSCustomObject]@{ StatusCode = 200; Content = '{}'; Headers = @{} }
    } -Force
}
# 合成的另两族：远程代码引擎行用产品自己的 429 分类函数产出（Resolve-DoctorGrep429 空体 = 「429 限流（匿名配额用尽）」），令牌行按 Get-DoctorTokens 的 Probe 形状
$remoteEngines = @(
    (Resolve-DoctorGrep429 -ResponseBody ''),
    [PSCustomObject]@{ Engine = 'Sourcegraph'; Endpoint = 'official streaming (/.api/search/stream)'; Reachable = $true; LatencyMs = 120; Note = $null }
)
$tokens = @(
    [PSCustomObject]@{ Var = 'GITHUB_TOKEN'; Present = $true; Valid = $true; Probe = 'HTTP 200' },
    [PSCustomObject]@{ Var = 'GITLAB_TOKEN'; Present = $true; Valid = $null; Probe = 'HTTP 429' }
)

# ---- 臂 1：人为触发限流 ----
Set-Stub 'limit'
$rs = Get-DoctorResearchHealth -VERSION 'a11-test'
$rh = @($rs.ResearchHealth)
$tbl = @(Get-DoctorRateLimitedSources -ResearchHealth $rh -RemoteEngines $remoteEngines -Tokens $tokens)
$research = @($tbl | Where-Object { $_.Kind -eq 'research' } | ForEach-Object { $_.Source })
$code     = @($tbl | Where-Object { $_.Kind -eq 'code' }     | ForEach-Object { $_.Source })
$token    = @($tbl | Where-Object { $_.Kind -eq 'token' }    | ForEach-Object { $_.Source })
"A11 research=$($research -join ',') code=$($code -join ',') token=$($token -join ',') total=$($tbl.Count) probes=$($rh.Count)"
if ($rh.Count -lt 10) { $fails += "research probes ran=$($rh.Count) (<10): Get-DoctorResearchHealth did not execute the probe loop" }
if ($research -notcontains 'OpenAlex')  { $fails += 'OpenAlex (429) missing from rateLimitedSources' }
if ($research -notcontains 'DockerHub') { $fails += 'DockerHub (TooLong shape) missing from rateLimitedSources' }
if ($code -notcontains 'grep.app')      { $fails += 'grep.app (remoteEngines Note 429) missing' }
if ($token -notcontains 'GITLAB_TOKEN') { $fails += 'GITLAB_TOKEN (Probe HTTP 429) missing' }
if ($research -contains 'npm' -or $research -contains 'arXiv') { $fails += 'non-limited research source leaked into table' }
if ($code -contains 'Sourcegraph')      { $fails += 'Sourcegraph (reachable, no 429) leaked into table' }
if ($token -contains 'GITHUB_TOKEN')    { $fails += 'GITHUB_TOKEN (HTTP 200) leaked into table' }
if ($tbl.Count -ne 4) { $fails += "expected exactly 4 rows, got $($tbl.Count)" }
foreach ($r in $tbl) { foreach ($k in 'Source','Kind','Http','Note') { if (-not ($r.PSObject.Properties.Name -contains $k)) { $fails += "row missing field $k" } } }

# ---- 臂 2：对照（全 200）----
Set-Stub 'ok'
$rs2 = Get-DoctorResearchHealth -VERSION 'a11-test'
$tbl2 = @(Get-DoctorRateLimitedSources -ResearchHealth @($rs2.ResearchHealth) -RemoteEngines @($remoteEngines[1]) -Tokens @($tokens[0]))
"A11-CTRL total=$($tbl2.Count)"
if ($tbl2.Count -ne 0) { $fails += "control arm must be empty, got $($tbl2.Count)" }

if ($fails.Count -eq 0) { 'A11_PASS'; exit 0 }
foreach ($f in $fails) { "A11_FAIL $f" }
exit 1
