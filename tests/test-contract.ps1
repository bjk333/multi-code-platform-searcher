# test-contract：三模式 -AsJson 输出契约（需网络，网络不可用时 FAIL 并说明）
# 断言：研究/仓库/代码证据三模式 _schemaError 均为空、version 匹配、results 非空数组。
$t_main = $env:MCPS_MAIN
if (-not $t_main) { $t_main = $mainScript }
. $t_main

$t_ok = $true
$t_fail = @()
try {
    $t_json = & $t_main -ResearchSources -Keyword "jwt" -Limit 3 -AsJson -NoCache | Out-String
    $t_o = $t_json | ConvertFrom-Json
    if ($t_o._schemaError) { $t_ok = $false; $t_fail += "research schemaError: $($t_o._schemaError)" }
    if ($t_o.version -ne $VERSION) { $t_ok = $false; $t_fail += "research version: $($t_o.version) != $VERSION" }
    if (-not ($t_o.results -is [array]) -or $t_o.results.Count -lt 1) { $t_ok = $false; $t_fail += "research results empty" }
} catch { $t_ok = $false; $t_fail += "research exec: $($_.Exception.Message)" }
try {
    $t_json2 = & $t_main -Platform All -Keyword "jwt" -MinStars 0 -Limit 3 -AsJson -NoCache | Out-String
    $t_o2 = $t_json2 | ConvertFrom-Json
    if ($t_o2._schemaError) { $t_ok = $false; $t_fail += "repo schemaError: $($t_o2._schemaError)" }
    if ($t_o2.version -ne $VERSION) { $t_ok = $false; $t_fail += "repo version: $($t_o2.version)" }
} catch { $t_ok = $false; $t_fail += "repo exec: $($_.Exception.Message)" }
try {
    $t_json3 = & $t_main -CodeEvidence -Keyword "jwt" -Limit 3 -AsJson -NoCache | Out-String
    $t_o3 = $t_json3 | ConvertFrom-Json
    if ($t_o3._schemaError) { $t_ok = $false; $t_fail += "evidence schemaError: $($t_o3._schemaError)" }
    if ($t_o3.version -ne $VERSION) { $t_ok = $false; $t_fail += "evidence version: $($t_o3.version)" }
} catch { $t_ok = $false; $t_fail += "evidence exec: $($_.Exception.Message)" }
if ($t_ok) { Write-Output "TEST_PASS test-contract (3 modes)" }
else { Write-Output "TEST_FAIL test-contract: $($t_fail -join '; ')" }
