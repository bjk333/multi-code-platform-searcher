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
    $hot = [PSCustomObject]@{ Name = 'AutoGPT'; Platform = 'GitHub'; Desc = 'generic AI agent'; Url = 'x'; Stars = 100000 }
    $focused = [PSCustomObject]@{ Name = 'llm-flow-monitor'; Platform = 'GitHub'; Desc = 'monitor LLM flow session alerting console'; Url = 'y'; Stars = 800 }
    $raw = @(Set-UnifiedScore -Results @($hot, $focused) -Keyword 'llm flow monitor console' -FocusTerms 'session,alert')
    $flat = @(); foreach ($item in $raw) { if ($item -is [array]) { $flat += @($item) } else { $flat += $item } }
    $names = @($flat | ForEach-Object { $_.Name })
    if ([array]::IndexOf($names, 'llm-flow-monitor') -ge [array]::IndexOf($names, 'AutoGPT')) { throw 'specific evidence ranked below generic popularity' }
    if ($flat[0].PSObject.Properties.Name -notcontains 'MatchTerms' -or $flat[0].PSObject.Properties.Name -notcontains 'NoiseFlagged') { throw 'denoise fields missing' }
    'TEST_PASS test-denoise (score/focus fields)'
} catch { Write-Output "TEST_FAIL test-denoise: $($_.Exception.Message)"; exit 1 }
