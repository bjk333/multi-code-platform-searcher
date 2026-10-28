# T2-11 独立参考断言；主回归以 tests/run-tests.ps1 为准，本文件也可单独运行。
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$main = (Resolve-Path (Join-Path (Join-Path $here '..') 'multi-platform-searcher.ps1')).Path
$oldNoMain = [Environment]::GetEnvironmentVariable('MCPS_NO_MAIN', 'Process')
try { $env:MCPS_NO_MAIN = '1'; . $main -NoEnvFile -AsJson }
finally {
    if ($null -eq $oldNoMain) { Remove-Item Env:MCPS_NO_MAIN -ErrorAction SilentlyContinue }
    else { $env:MCPS_NO_MAIN = $oldNoMain }
}
$oldDisabled = [Environment]::GetEnvironmentVariable('MCPS_DISABLE', 'Process')
try {
    # U-100-B: this reference test uses the same shipped catalog as the main harness.
    $catalogPath = Join-Path (Split-Path -Parent $main) 'query-plan.schema.json'
    $catalog = ([System.IO.File]::ReadAllText($catalogPath) | ConvertFrom-Json).'x-engineCatalog'
    $catalogCode = @($catalog.PSObject.Properties | Where-Object { $_.Value.kind -eq 'code' })
    $catalogNames = @($catalogCode | ForEach-Object { $_.Name })
    if ($catalogNames.Count -eq 0) { throw 'code catalog missing/empty' }
    $code = @(Get-EngineByKind -Kind 'code')
    if ((@($code | ForEach-Object { $_.Name }) -join ',') -ne ($catalogNames -join ',')) { throw 'code catalog drift' }
    $env:MCPS_DISABLE = 'grep.app, Sourcegraph'
    $selectors = @($env:MCPS_DISABLE -split '[,;\s]+' | Where-Object { $_ })
    $expectedEnabled = @($catalogCode | Where-Object {
        $entry = $_
        $selectors -notcontains $entry.Name -and @($entry.Value.platforms | Where-Object { $selectors -contains $_ }).Count -eq 0
    } | ForEach-Object { $_.Name })
    $enabled = @(Get-EnabledEngines -Engines $code | ForEach-Object { $_.Name })
    if (($enabled -join ',') -ne ($expectedEnabled -join ',')) { throw 'disabled engines remained in candidates or enabled catalog drifted' }
    'TEST_PASS test-disable (name/alias routing)'
} catch { Write-Output "TEST_FAIL test-disable: $($_.Exception.Message)"; exit 1 }
finally {
    if ($null -eq $oldDisabled) { Remove-Item Env:MCPS_DISABLE -ErrorAction SilentlyContinue }
    else { $env:MCPS_DISABLE = $oldDisabled }
}
