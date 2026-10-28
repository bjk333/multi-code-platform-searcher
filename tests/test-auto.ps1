# T2-11 独立参考断言；主回归以 tests/run-tests.ps1 为准，本文件也可单独运行。
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$main = (Resolve-Path (Join-Path (Join-Path $here '..') 'multi-platform-searcher.ps1')).Path
$oldNoMain = [Environment]::GetEnvironmentVariable('MCPS_NO_MAIN', 'Process')
try { $env:MCPS_NO_MAIN = '1'; . $main -NoEnvFile -AsJson }
finally {
    if ($null -eq $oldNoMain) { Remove-Item Env:MCPS_NO_MAIN -ErrorAction SilentlyContinue }
    else { $env:MCPS_NO_MAIN = $oldNoMain }
}
try {
    if ((@(Convert-PlanToModes -QueryType 'integrated_research_and_code') -join ',') -ne 'repo,code,research') { throw 'integrated mode mapping wrong' }
    $planner = (Resolve-Path (Join-Path (Join-Path $here '..') 'query-planner.ps1')).Path
    $plan = & $planner -Query '调研技能的代码仓库及实现' | ConvertFrom-Json
    if ($plan.queryType -ne 'integrated_research_and_code') { throw 'engineering query not integrated' }
    $registered = @($script:_engineRegistry | ForEach-Object { $_.Name })
    $candidates = @($plan.engineCandidates)
    if ($registered.Count -ne 18 -or $candidates.Count -ne 18 -or @(Compare-Object $registered $candidates).Count -ne 0) { throw 'engineCandidates differ from registry' }
    'TEST_PASS test-auto (integrated/planner 18 engine candidates)'
} catch { Write-Output "TEST_FAIL test-auto: $($_.Exception.Message)"; exit 1 }
