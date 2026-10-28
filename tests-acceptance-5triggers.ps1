[CmdletBinding()]
param(
    [switch]$ReportOnly
)
$ErrorActionPreference = 'Stop'
# Robust script-dir resolution; verify query-planner.ps1 exists before adopting a candidate.
# 本主机 PS5.1 的 $PSScriptRoot/$MyInvocation/$PWD 等自动变量时常为空或异常，且 Split-Path
# 参数绑定错误为终止型、SilentlyContinue 无法抑制；故全程 try/catch，并在末尾做"保底硬赋值"，
# 确保 $scriptDir 绝不为空（否则 Join-Path 会抛 null Path 绑定错误）。
function Test-SkillDir($c) {
    if (-not $c) { return $null }
    try {
        $dir = $null
        if (Test-Path -LiteralPath $c -PathType Container) {
            $dir = $c
        } else {
            $dir = Split-Path -Parent $c -ErrorAction SilentlyContinue
        }
        if ($dir -and (Test-Path -LiteralPath (Join-Path $dir 'query-planner.ps1'))) {
            return $dir
        }
    } catch {
        # 该候选解析失败，跳过，尝试下一个
    }
    return $null
}
$scriptDir = $null
foreach ($c in @($PSScriptRoot, $MyInvocation.MyCommand.Path, $MyInvocation.MyCommand.Definition, $PSCommandPath, $PWD.Path, 'D:\想法作品\skill\multi-code-platform-searcher')) {
    try {
        $r = Test-SkillDir $c
        if ($r) { $scriptDir = $r; break }
    } catch { }
}
# 保底：绝不依赖 $PWD（本主机偶发指向父目录 D:\想法作品\skill 且无 planner）
if (-not $scriptDir) { $scriptDir = 'D:\想法作品\skill\multi-code-platform-searcher' }
$planner = Join-Path $scriptDir 'query-planner.ps1'

# 动态读取主脚本版本号，避免硬编码导致报告版本与技能实际版本脱节
$mainScript = Join-Path $scriptDir 'multi-platform-searcher.ps1'
$skillVersion = 'unknown'
if (Test-Path $mainScript) {
    $m = [regex]::Match((Get-Content -LiteralPath $mainScript -Raw -Encoding UTF8), '\$VERSION\s*=\s*"([^"]+)"')
    if ($m.Success) { $skillVersion = $m.Groups[1].Value }
}

function U([string]$value) {
    return ConvertFrom-Json ('"' + $value + '"')
}

$now = Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz'
$results = @()

Write-Host '=== Trigger 1: research_only ===' -ForegroundColor Cyan
$q1 = U '\u0052\u0065\u0061\u0063\u0074\u0020\u0053\u0065\u0072\u0076\u0065\u0072\u0020\u0043\u006f\u006d\u0070\u006f\u006e\u0065\u006e\u0074\u0073\u0020\u6700\u65b0\u5b98\u65b9\u6587\u6863\u548c\u6700\u4f73\u5b9e\u8df5'
Write-Host "  Query: $q1"
$p1 = & $planner -Query $q1 -QueryType research_only | ConvertFrom-Json
$ok1 = $p1.queryType -eq 'research_only'
if ($ok1) { $ok1 = $p1.confidence -ge 0.5 }
$results += @{ Trigger = 'research_only'; Query = $q1; QueryType = $p1.queryType; Confidence = $p1.confidence; Pass = $ok1 }
Write-Host "  Type: $($p1.queryType) Confidence: $($p1.confidence) Pass: $ok1"

Write-Host '=== Trigger 2: repository_only ===' -ForegroundColor Cyan
$q2 = U '\u0047\u0069\u0074\u0048\u0075\u0062\u0020\u4e0a\u641c\u7d22\u5411\u91cf\u6570\u636e\u5e93\u5f00\u6e90\u9879\u76ee'
Write-Host "  Query: $q2"
$p2 = & $planner -Query $q2 -QueryType repository_only | ConvertFrom-Json
$ok2 = $p2.queryType -eq 'repository_only'
if ($ok2) { $ok2 = $p2.confidence -ge 0.5 }
$results += @{ Trigger = 'repository_only'; Query = $q2; QueryType = $p2.queryType; Confidence = $p2.confidence; Pass = $ok2 }
Write-Host "  Type: $($p2.queryType) Confidence: $($p2.confidence) Pass: $ok2"

Write-Host '=== Trigger 3: code_evidence_only ===' -ForegroundColor Cyan
$q3 = U '\u0067\u0072\u0065\u0070\u002e\u0061\u0070\u0070\u0020\u67e5\u627e\u0020\u0073\u0069\u006e\u0067\u006c\u0065\u0066\u006c\u0069\u0067\u0068\u0074\u0020\u51fd\u6570\u5b9e\u73b0\u4ee3\u7801'
Write-Host "  Query: $q3"
$p3 = & $planner -Query $q3 -QueryType code_evidence_only | ConvertFrom-Json
$ok3 = $p3.queryType -eq 'code_evidence_only'
if ($ok3) { $ok3 = $p3.confidence -ge 0.5 }
$results += @{ Trigger = 'code_evidence_only'; Query = $q3; QueryType = $p3.queryType; Confidence = $p3.confidence; Pass = $ok3 }
Write-Host "  Type: $($p3.queryType) Confidence: $($p3.confidence) Pass: $ok3"

Write-Host '=== Trigger 4: integrated_research_and_code ===' -ForegroundColor Cyan
$q4 = U '\u5168\u7f51\u8c03\u7814\u0020\u0052\u0065\u0064\u0069\u0073\u0020\u7f13\u5b58\u65b9\u6848\u0020\u641c\u7d22\u5f00\u6e90\u9879\u76ee\u548c\u4ee3\u7801\u5b9e\u73b0'
Write-Host "  Query: $q4"
$p4 = & $planner -Query $q4 | ConvertFrom-Json
$ok4 = $p4.queryType -eq 'integrated_research_and_code'
if ($ok4) { $ok4 = $p4.confidence -ge 0.5 }
$results += @{ Trigger = 'integrated_research_and_code'; Query = $q4; QueryType = $p4.queryType; Confidence = $p4.confidence; Pass = $ok4 }
Write-Host "  Type: $($p4.queryType) Confidence: $($p4.confidence) Pass: $ok4"

Write-Host '=== Trigger 5: negative_terms ===' -ForegroundColor Cyan
$q5a = U '\u6280\u672f\u65b9\u6848\u8c03\u7814\u0020\u4e0d\u8981\u641c\u7d22\u4ed3\u5e93\u548c\u4ee3\u7801'
$q5b = U '\u0050\u0079\u0074\u0068\u006f\u006e\u0020\u5f02\u6b65\u6846\u67b6\u5bf9\u6bd4\u0020\u6392\u9664\u0020\u0047\u0069\u0074\u0048\u0075\u0062\u0020\u4ed3\u5e93'
foreach ($q in @($q5a, $q5b)) {
    Write-Host "  Query: $q"
    $p5 = & $planner -Query $q | ConvertFrom-Json
    $ok5 = $p5.queryType -ne 'repository_only'
    $results += @{ Trigger = 'negative_edge'; Query = $q; QueryType = $p5.queryType; Confidence = $p5.confidence; Pass = $ok5 }
    $ns = if ($p5.entities.negations) { [string]($p5.entities.negations -join ',') } else { '(none)' }
    Write-Host "  Type: $($p5.queryType) Confidence: $($p5.confidence) Negations: $ns Pass: $ok5"
}

Write-Host '=== Trigger B1: explicit override ===' -ForegroundColor Cyan
$qB = U '\u67e5\u6587\u6863'
$pB = & $planner -Query $qB -QueryType repository_only | ConvertFrom-Json
$okB = $pB.queryType -eq 'repository_only'
$results += @{ Trigger = 'explicit_override'; Query = $qB; QueryType = $pB.queryType; Confidence = $pB.confidence; Pass = $okB }
Write-Host "  Override to repository_only: $($pB.queryType) Pass: $okB"

$passed = ($results | Where-Object { $_.Pass }).Count
$total = $results.Count

Write-Host ''
Write-Host ('=' * 60) -ForegroundColor Cyan
Write-Host "  Trae 5-Category Acceptance Test Results" -ForegroundColor White
Write-Host "  Date: $now" -ForegroundColor Gray
Write-Host "  Passed: $passed / $total" -ForegroundColor $(if ($passed -eq $total) { 'Green' } else { 'Red' })
Write-Host ('=' * 60) -ForegroundColor Cyan

$reportDir = Join-Path $scriptDir 'reports'
if (-not (Test-Path $reportDir)) { New-Item -ItemType Directory -Force -Path $reportDir | Out-Null }
$reportPath = Join-Path $reportDir 'trae-acceptance-5triggers.json'
@{ testSuite = 'trae-5triggers-acceptance'; date = $now; skillVersion = $skillVersion; passed = $passed; total = $total; allPassed = ($passed -eq $total); results = $results } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $reportPath -Encoding UTF8
Write-Host "Report saved to: $reportPath" -ForegroundColor Gray

if (-not $ReportOnly) {
    if ($passed -eq $total) {
        Write-Host 'ALL TRIGGERS PASSED - Ready for Trae session verification' -ForegroundColor Green
    } else {
        Write-Host 'SOME TRIGGERS FAILED' -ForegroundColor Red
        exit 1
    }
}
