[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
function U([string]$value) { ConvertFrom-Json ('"' + $value + '"') }
$planner = Join-Path $PSScriptRoot 'query-planner.ps1'
$cases = @(
    @{ Query = (U '\u67e5\u5b98\u65b9\u6587\u6863\u548c\u6700\u4f73\u5b9e\u8df5'); Expected = 'research_only' },
    @{ Query = (U '\u641c\u7d22 GitHub Gitee GitLab \u5f00\u6e90\u9879\u76ee'); Expected = 'repository_only' },
    @{ Query = (U '\u67e5\u627e\u51fd\u6570\u4ee3\u7801\u5b9e\u73b0 grep.app'); Expected = 'code_evidence_only' },
    @{ Query = (U '\u5168\u7f51\u8c03\u7814 React 18 \u641c\u7d22\u5f00\u6e90\u9879\u76ee\u548c\u4ee3\u7801\u5b9e\u73b0'); Expected = 'integrated_research_and_code' },
    @{ Query = (U '\u6700\u65b0\u6280\u672f\u65b9\u6848\uff0c\u4e0d\u8981\u641c\u7d22\u4ed3\u5e93'); Expected = 'research_only' },
    @{ Query = (U '\u8c03\u7814 \u6280\u80fd CI \u5206\u53d1'); Expected = 'integrated_research_and_code' },
    @{ Query = (U '\u627e\u7c7b\u4f3c\u9879\u76ee'); Expected = 'repository_only' },
    @{ Query = (U '\u540c\u7c7b\u5f00\u6e90\u9879\u76ee'); Expected = 'repository_only' },
    # v1.48.0（2026-10-22 全模块验收 P2-2）：动词原形此前不在 $codeTerms（只有 implementation），
    #   词边界匹配下 "how to implement X" 被判 research_only ⇒ 拿不到代码证据。
    @{ Query = 'how to implement binary search in go'; Expected = 'code_evidence_only' },
    @{ Query = 'implementing a rate limiter in rust'; Expected = 'code_evidence_only' }
)
# v1.45.8（2026-10-20 审计 P2）：期望值不再硬编码 —— 从 planner **自身**的候选数组派生。
#   病灶：这里写死 research_only=10 / integrated=18，而 v1.39 加 SEExcerpts、v1.40 加 DeepSeek 之后
#   实际是 11 / 20；Node 门只校验 planner↔registry parity、不跑本脚本 ⇒ 长期假绿、一运行就红。
#   现在改数组只需改 planner 一处，本测试自动跟随；数组名写错则直接抛错（不静默跳过）。
$plannerSrc = [System.IO.File]::ReadAllText($planner)
$plannerCounts = @{}
foreach ($arrName in 'repoEngineCandidates', 'codeEngineCandidates', 'researchEngineCandidates') {
    $m = [regex]::Match($plannerSrc, '(?s)\' + [char]36 + $arrName + '\s*=\s*@\((?<body>.*?)\)')
    if (-not $m.Success) { throw "planner 里找不到数组 $arrName —— 测试与实现已分叉" }
    $plannerCounts[$arrName] = @($m.Groups['body'].Value -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ }).Count
}
$expectedEngines = @{
    research_only                = $plannerCounts['researchEngineCandidates']
    repository_only              = $plannerCounts['repoEngineCandidates']
    code_evidence_only           = $plannerCounts['codeEngineCandidates']
    integrated_research_and_code = ($plannerCounts['repoEngineCandidates'] + $plannerCounts['codeEngineCandidates'] + $plannerCounts['researchEngineCandidates'])
}
Write-Output ("[planner] 派生期望: research={0} repo={1} code={2} integrated={3}" -f $expectedEngines['research_only'], $expectedEngines['repository_only'], $expectedEngines['code_evidence_only'], $expectedEngines['integrated_research_and_code'])

$passed = 0
foreach ($case in $cases) {
    $plan = & $planner -Query $case.Query | ConvertFrom-Json
    if ($plan.queryType -ne $case.Expected) { throw "Expected $($case.Expected), got $($plan.queryType)" }
    if ($plan.confidence -lt 0 -or $plan.confidence -gt 1) { throw "Invalid confidence" }
    if (-not $plan.normalizedQuery) { throw "Missing normalized query" }
    if (@($plan.engineCandidates).Count -ne $expectedEngines[$case.Expected]) { throw "Wrong engineCandidates count for $($case.Expected): expected $($expectedEngines[$case.Expected]), got $(@($plan.engineCandidates).Count)" }
    $passed++
}
$forced = & $planner -Query (U '\u53ea\u67e5\u8d44\u6599') -QueryType repository_only | ConvertFrom-Json
if ($forced.queryType -ne 'repository_only') { throw 'Explicit QueryType override failed' }
$temp = Join-Path ([System.IO.Path]::GetTempPath()) ('query-plan-s1-' + $PID + '.json')
& $planner -Query (U 'React 18 \u5f00\u6e90\u9879\u76ee\u548c\u5b98\u65b9\u6587\u6863') -OutputPath $temp | Out-Null
if (-not (Test-Path $temp)) { throw 'OutputPath did not create a plan file' }
$written = Get-Content $temp -Raw | ConvertFrom-Json
if ($written.queryType -ne 'integrated_research_and_code') { throw 'Written plan is invalid' }
Remove-Item $temp -Force
Write-Output "S1 query planner tests: $passed/$($cases.Count) passed"
