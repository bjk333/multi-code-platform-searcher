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
    $skill = [System.IO.File]::ReadAllLines((Join-Path (Join-Path $here '..') 'SKILL.md'))
    $closing = -1; for ($i = 1; $i -lt $skill.Count; $i++) { if ($skill[$i].Trim() -eq '---') { $closing = $i; break } }
    if ($closing -lt 0) { throw 'SKILL frontmatter unclosed' }
    for ($i = $closing + 1; $i -lt $skill.Count; $i++) { if ($skill[$i].Length -gt 300) { throw "SKILL body line $($i+1) > 300 chars" } }
    if (-not (@($skill | Where-Object { $_ -match 'version:.*' + [regex]::Escape($VERSION) }).Count)) { throw 'metadata.version drift' }
    $cheat = [System.IO.File]::ReadAllLines((Join-Path (Join-Path $here '..') 'references/参数速查.md'))[0]
    $chain = [System.IO.File]::ReadAllLines((Join-Path (Join-Path $here '..') 'references/引擎链.md'))[0]
    if ($cheat -notmatch [regex]::Escape($VERSION) -or $chain -notmatch [regex]::Escape($VERSION)) { throw 'reference version stamp drift' }
    'TEST_PASS test-docs (frontmatter/line length/version)'
} catch { Write-Output "TEST_FAIL test-docs: $($_.Exception.Message)"; exit 1 }
