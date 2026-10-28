# tests/test-doctor-alignment.ps1 —— 批次 2「Doctor 三处口径对齐」的离线门（零网络，PS 5.1 + 7 双跑）
#
# 覆盖（方案 §四）：
#   C1 同源：每个 Kind='engine' 的探针，其 URL 主机必须出现在**对应引擎文件**的主机集里
#            ★这就是方案要求的必红位：把 npm 探针改回 api.npms.io ⇒ 立刻红
#   C2 覆盖：research 引擎集的每个引擎都至少有一个同源探针（Engine 字段指向它）
#   C3 标注：探针必须有 Kind ∈ {engine,extra}；engine 必带 Engine，extra 必不带
#   C4 差集：effectiveCount 必须扣掉 remoteBlocked —— 用 AST 抓主脚本里的**真实表达式**执行，
#            不是在本门里复写副本，否则测的是门的逻辑而不是产品逻辑
#
# 用法: powershell -File tests/test-doctor-alignment.ps1 -SkillDir <dir>
param([string]$SkillDir = '')
$ErrorActionPreference = 'Continue'
if (-not $SkillDir) { $SkillDir = (Resolve-Path (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '..')).Path }
$SkillDir = (Resolve-Path $SkillDir).Path
$ms = Join-Path $SkillDir 'multi-platform-searcher.ps1'

$ok = $true; $fails = @(); $lines = @()
function Fail([string]$m) { $script:ok = $false; $script:fails += $m }

# ---------- 取 $researchProbes（dot-source 主脚本，走 MCPS_NO_MAIN 守卫）----------
$env:MCPS_NO_MAIN = '1'
. $ms
# v1.54.0（B3-2）：函数已搬进 lib/ ⇒ AST 要覆盖"主脚本 + lib/*.ps1"（$researchProbes 现在住在 lib/doctor.ps1 里）。
$astFiles = @($ms)
$__libDir = Join-Path $SkillDir 'lib'
if (Test-Path -LiteralPath $__libDir -PathType Container) {
    $astFiles += @(Get-ChildItem -LiteralPath $__libDir -Filter '*.ps1' -File | Sort-Object Name | ForEach-Object { $_.FullName })
}
function Get-Assignments([string]$Name) {
    @(foreach ($__f in $astFiles) {
            $__ast = [System.Management.Automation.Language.Parser]::ParseFile($__f, [ref]$null, [ref]$null)
            $__ast.FindAll({ $args[0] -is [System.Management.Automation.Language.AssignmentStatementAst] }, $true) |
                Where-Object { $_.Left.Extent.Text -eq $Name }
        })
}
$probeAssign = @(Get-Assignments '$researchProbes')
if ($probeAssign.Count -eq 0) { Write-Output 'TEST_FAIL test-doctor-alignment: 找不到 $researchProbes 定义'; exit 1 }
$researchProbes = @(& ([scriptblock]::Create($probeAssign[0].Right.Extent.Text)))
$lines += ("[C0] 探针数 = {0}" -f $researchProbes.Count)

# ---------- Engine → 引擎文件 映射 ----------
$engineFile = @{
    # U-243（v1.53.25）：包注册表拆成三个单一上游引擎，探针与引擎文件一一对应。
    'Npm'         = 'npm-registry.ps1'
    'Crates'      = 'crates-io.ps1'
    'Maven'       = 'maven-central.ps1'
    'RubyGems'    = 'search-rubygems.ps1'
    'NuGet'       = 'nuget.ps1'
    'Packagist'   = 'packagist.ps1'
    'DockerHub'   = 'docker-hub.ps1'
    'OpenAlex'    = 'open-alex.ps1'
    'HackerNews'  = 'hacker-news.ps1'
    'arXiv'       = 'arxiv.ps1'
    'HF'          = 'hugging-face.ps1'
    'MCPRegistry' = 'mcp-registry.ps1'
    'SE'          = 'stack-exchange.ps1'
}
function Get-Hosts([string]$file) {
    $p = Join-Path $SkillDir "engines\$file"
    if (-not (Test-Path $p)) { return @() }
    $a = [System.Management.Automation.Language.Parser]::ParseFile($p, [ref]$null, [ref]$null)
    $out = @()
    foreach ($n in $a.FindAll({
                ($args[0] -is [System.Management.Automation.Language.StringConstantExpressionAst] -or
                 $args[0] -is [System.Management.Automation.Language.ExpandableStringExpressionAst]) -and
                $args[0].Value -match '^https?://'
            }, $true)) {
        if ($n.Value -match '^(https?://[^/''"\s]+)') { $out += $matches[1] }
    }
    return @($out | Select-Object -Unique)
}
function Get-HostOf([string]$url) {
    if ($url -match '^(https?://[^/''"\s]+)') { return $matches[1] }
    return $null
}

# ---------- C1 同源 ----------
$c1bad = @(); $c1ok = 0
foreach ($rp in $researchProbes) {
    if (([string]$rp.Kind) -ne 'engine') { continue }
    $eng = [string]$rp.Engine
    if (-not $engineFile.ContainsKey($eng)) { $c1bad += "探针 '$($rp.Source)' 的 Engine='$eng' 不在映射表里"; continue }
    $probeHost = Get-HostOf ([string]$rp.Url)
    if (-not $probeHost) { $c1bad += "探针 '$($rp.Source)' URL 形状异常"; continue }
    $hosts = @(Get-Hosts $engineFile[$eng])
    if ($hosts -notcontains $probeHost) {
        $c1bad += "探针 '$($rp.Source)' 主机 $probeHost 不在引擎 $eng 的主机集 [$($hosts -join ',')] 内"
    }
    else { $c1ok++ }
}
if ($c1bad.Count -gt 0) { Fail ("C1 同源: " + ($c1bad -join '; ')) }
$lines += ("[C1] 同源 = {0} 同源 / {1} 违规" -f $c1ok, $c1bad.Count)

# ---------- C2 覆盖 ----------
$probeEngines = @($researchProbes | Where-Object { ([string]$_.Kind) -eq 'engine' } | ForEach-Object { [string]$_.Engine } | Select-Object -Unique)
$c2miss = @($engineFile.Keys | Where-Object { $probeEngines -notcontains $_ })
$unknownEngine = @($probeEngines | Where-Object { -not $engineFile.ContainsKey($_) })
if ($c2miss.Count -gt 0) { Fail ("C2 覆盖: 这些引擎没有同源探针 -> " + ($c2miss -join ',')) }
if ($unknownEngine.Count -gt 0) { Fail ("C2 覆盖: 探针指向未知引擎 -> " + ($unknownEngine -join ',')) }
$lines += ("[C2] 覆盖 = {0}/{1} 引擎有同源探针；缺口=[{2}]" -f ($engineFile.Count - $c2miss.Count), $engineFile.Count, ($c2miss -join ','))

# ---------- C3 标注 ----------
$c3bad = @()
foreach ($rp in $researchProbes) {
    $k = [string]$rp.Kind
    if ($k -ne 'engine' -and $k -ne 'extra') { $c3bad += "'$($rp.Source)' Kind='$k' 非法"; continue }
    if ($k -eq 'engine' -and -not $rp.Engine) { $c3bad += "'$($rp.Source)' Kind=engine 但缺 Engine" }
    if ($k -eq 'extra' -and $rp.Engine) { $c3bad += "'$($rp.Source)' Kind=extra 却带了 Engine" }
}
if ($c3bad.Count -gt 0) { Fail ("C3 标注: " + ($c3bad -join '; ')) }
$nEng = @($researchProbes | Where-Object { ([string]$_.Kind) -eq 'engine' }).Count
$nExt = @($researchProbes | Where-Object { ([string]$_.Kind) -eq 'extra' }).Count
$lines += ("[C3] 标注 = engine {0} 个 / extra {1} 个 / 违规 {2}" -f $nEng, $nExt, $c3bad.Count)

# ---------- C4 effectiveCount 差集（执行主脚本里的真实表达式）----------
$targets = @('$rcsBlockedNames', '$rcsBlockedAvail', '$effectiveCount')
$exprs = @{}
foreach ($t in $targets) {
    $a = @(Get-Assignments $t)
    if ($a.Count -eq 0) { Fail "C4 在主脚本里找不到 '$t' 的赋值（算法被改名？）"; continue }
    $exprs[$t] = $a[0].Right.Extent.Text
}
if ($exprs.Count -eq 3) {
    $setup = "$($targets[0]) = " + $exprs['$rcsBlockedNames'] + "`n" +
             "$($targets[1]) = " + $exprs['$rcsBlockedAvail'] + "`n" +
             "$($targets[2]) = " + $exprs['$effectiveCount']
    # 场景 A：无阻塞
    $codeAvail = @([pscustomobject]@{ Name = 'GitHubCode' }, [pscustomobject]@{ Name = 'GitLabBlobs' }, [pscustomobject]@{ Name = 'GrepApp' })
    $remoteBlocked = @()
    $rA = & ([scriptblock]::Create($setup + "`n`$effectiveCount"))
    if ([int]$rA -ne 3) { Fail "C4 场景A(无阻塞) effectiveCount 应为 3，实得 $rA" }
    $lines += ("[C4a] 无阻塞 -> effectiveCount={0} (期望 3)" -f $rA)

    # 场景 B：GitLabBlobs 被阻塞（形状取自主脚本 remoteBlocked 的真实写法）
    $remoteBlocked = @('GitLabBlobs(GITLAB_TOKEN 无效/已撤销, HTTP 401)')
    $rB = & ([scriptblock]::Create($setup + "`n" + "`$s = (`$rcsBlockedAvail | ForEach-Object { `$_.Name }) -join ','; `"EFF=`$effectiveCount;BLOCKED=`$s`""))
    if ("$rB" -notmatch 'EFF=2') { Fail "C4 场景B(阻塞 GitLabBlobs) effectiveCount 应为 2，实得 [$rB]" }
    if ("$rB" -notmatch 'BLOCKED=GitLabBlobs') { Fail "C4 场景B blockedByCredential 应含 GitLabBlobs，实得 [$rB]" }
    $lines += ("[C4b] 阻塞 GitLabBlobs -> {0}" -f $rB)
}

# ---------- C5 引擎失败必须显式上报（OpenAlex；与探针限流归类同源）----------
#   判据：OpenAlex 端点以「限流等待过长: ... (Retry-After 30805s)」失败时，
#         引擎状态必须是 rate_limited（旧写法只打日志、状态留 unknown ⇒ ReasonCode 落 not-run ⇒ 假阴性）。
try {
    if (-not (Test-Path function:Search-OpenAlex)) { Fail 'C5 找不到 Search-OpenAlex' }
    else {
        $script:oalCalls = 0
        $origOA = Get-Item function:Invoke-ApiRequest
        # 复现真实失败形状（实测自 OpenAlex：Retry-After 30805s ⇒ TooLong 分支）
        Set-Item function:Invoke-ApiRequest -Value {
            param($Uri, $Headers, $TimeoutSec = 15, $MaxAttempts = 3, [switch]$NoProxy)
            $script:oalCalls++
            throw '限流等待过长: https://api.openalex.org/works (Retry-After 30805s)'
        } -Force
        [void]@(Search-OpenAlex -Keyword '__mcps_probe__' -Limit 1)
        Set-Item function:Invoke-ApiRequest -Value $origOA.Value -Force
        $st = Get-EngineStatus -Name 'OpenAlex'
        if ($st -ne 'rate_limited') { Fail "C5 OpenAlex 限流后状态应为 rate_limited，实得 '$st'（旧写法会留 unknown）" }
        $lines += ("[C5] OpenAlex 限流 -> status={0} calls={1}" -f $st, $script:oalCalls)
    }
}
catch { Fail "C5 exec: $($_.Exception.Message)" }

# ---------- 还原 ----------
Remove-Item Env:\MCPS_NO_MAIN -ErrorAction SilentlyContinue
$lines | ForEach-Object { Write-Output $_ }
if ($ok) { Write-Output 'TEST_PASS test-doctor-alignment (C1..C5 offline)'; exit 0 }
Write-Output ("TEST_FAIL test-doctor-alignment: " + ($fails -join ' | ')); exit 1
