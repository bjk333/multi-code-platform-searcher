# test-sorting：统一排序 Score 契约（需网络）
# 断言：Score ∈ [0,1]、全量携带、降序单调；-AsJson context 存在。
$t_main = $env:MCPS_MAIN
if (-not $t_main) { $t_main = $mainScript }
. $t_main

$t_ok = $true
$t_fail = @()
try {
    $t_json = & $t_main -ResearchSources -Keyword "jwt" -Limit 5 -AsJson -NoCache | Out-String
    $t_o = $t_json | ConvertFrom-Json
    if ($t_o.results.Count -gt 0) {
        $t_scores = @($t_o.results | ForEach-Object { [double]$_.Score })
        for ($t_i = 1; $t_i -lt $t_scores.Count; $t_i++) {
            if ($t_scores[$t_i] -gt $t_scores[$t_i - 1] + 1e-9) { $t_ok = $false; $t_fail += "score not monotonic at idx $t_i ($($t_scores[$t_i-1])->$($t_scores[$t_i]))" }
        }
        foreach ($t_s in $t_scores) {
            if ($t_s -lt 0 -or $t_s -gt 1.0001) { $t_ok = $false; $t_fail += "score out of range: $t_s"; break }
        }
    }
    if (-not $t_o.context) { $t_ok = $false; $t_fail += "context missing in AsJson" }
} catch { $t_ok = $false; $t_fail += "exec: $($_.Exception.Message)" }
if ($t_ok) { Write-Output "TEST_PASS test-sorting (score+context)" }
else { Write-Output "TEST_FAIL test-sorting: $($t_fail -join '; ')" }
