# test-citations：arXiv 引用数补全（P2，需网络访问 Semantic Scholar）
# 断言：构造 arXiv 结果（含真实 arXiv ID，无版本号）经 Enrich-ArxivCitations 后 Stars>0。
$t_main = $env:MCPS_MAIN
if (-not $t_main) { $t_main = $mainScript }
. $t_main

function t_Count([object[]]$t_Arr) {
    $t_n = 0
    foreach ($t_i in $t_Arr) {
        if ($t_i -is [System.Array] -or $t_i -is [System.Collections.IList]) {
            $t_inner = @($t_i)
            $t_n += $t_inner.Count
        }
        else {
            $t_n++
        }
    }
    return $t_n
}
function t_First([object[]]$t_Arr) {
    foreach ($t_i in $t_Arr) {
        if ($t_i -is [System.Array] -or $t_i -is [System.Collections.IList]) {
            $t_inner = @($t_i)
            return $t_inner[0]
        }
        else {
            return $t_i
        }
    }
    return $null
}

$t_ok = $true
$t_fail = @()
try {
    $t_fake = @([PSCustomObject]@{ Index = 1; Platform = 'arXiv'; Name = 'Attention Is All You Need'; Stars = 0; Url = 'http://arxiv.org/abs/1706.03762'; Desc = 'd'; License = ''; Updated = '' })
    $t_res = @(Enrich-ArxivCitations -Results $t_fake)
    $t_first = t_First $t_res
    if ((t_Count $t_res) -ne 1) { $t_ok = $false; $t_fail += "enrich count: got $(t_Count $t_res)" }
    elseif ($null -eq $t_first -or $t_first.Stars -le 0) { $t_ok = $false; $t_fail += "citation not enriched" }
} catch { $t_ok = $false; $t_fail += "exec: $($_.Exception.Message)" }
if ($t_ok) { Write-Output "TEST_PASS test-citations (arXiv citations enriched)" }
else { Write-Output "TEST_FAIL test-citations: $($t_fail -join '; ')" }
