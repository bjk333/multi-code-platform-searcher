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
    $labels = @($script:doctorTools | ForEach-Object { $_.Exe })
    if ($labels.Count -lt 5 -or $labels -notcontains 'rg.exe') { throw 'Doctor binary catalog incomplete' }
    $dirs = @(Get-LocalBinCandidateDirs)
    if ($dirs.Count -lt 2 -or $dirs[0] -notmatch 'bin' -or $dirs[1] -notmatch 'tools') { throw 'Local binary directory order changed' }
    if (-not $script:Cfg.NodeDeadlineSec -or -not $script:NodeEnginePath) { throw 'Node fallback prerequisites missing' }
    'TEST_PASS test-observe (tool catalog/bin dirs/node path)'
} catch { Write-Output "TEST_FAIL test-observe: $($_.Exception.Message)"; exit 1 }
