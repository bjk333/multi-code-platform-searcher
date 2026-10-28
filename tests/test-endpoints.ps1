# T2-11 独立参考断言；主回归以 tests/run-tests.ps1 为准，本文件也可单独运行。
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$main = (Resolve-Path (Join-Path (Join-Path $here '..') 'multi-platform-searcher.ps1')).Path
$oldNoMain = [Environment]::GetEnvironmentVariable('MCPS_NO_MAIN', 'Process')
try { $env:MCPS_NO_MAIN = '1'; . $main -NoEnvFile -AsJson }
finally {
    if ($null -eq $oldNoMain) { Remove-Item Env:MCPS_NO_MAIN -ErrorAction SilentlyContinue }
    else { $env:MCPS_NO_MAIN = $oldNoMain }
}
# 无网络快照；真实网络端点断言仅由 run-tests.ps1 的非 LocalOnly 组执行。
try {
    $vercel = Resolve-DoctorGrep429 -ResponseBody '<html>Vercel Security Checkpoint</html>'
    $normal = Resolve-DoctorGrep429 -ResponseBody '{"error":"rate limited"}'
    if ($vercel.Reachable -ne $false -or $vercel.Note -notmatch 'Vercel') { throw 'Vercel 429 classification failed' }
    if ($normal.Reachable -ne $true -or $normal.Note -notmatch '429') { throw 'ordinary 429 classification failed' }
    $source = [System.IO.File]::ReadAllText($main)
    if ($source -notmatch '-MaxAttempts 1 -NodeDeadlineSec 5') { throw 'Doctor probe retry/deadline contract missing' }
    'TEST_PASS test-endpoints (offline 429 classification; network not run)'
} catch { Write-Output "TEST_FAIL test-endpoints: $($_.Exception.Message)"; exit 1 }
