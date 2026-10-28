# test-dedup：跨平台去重语义（纯内存，无需网络）——v1.17 修复的回归防线
# 断言：同名跨平台保留（repo|Platform|Name）、同平台同名去重、代码证据按 仓库+文件+行号 去重（不含 Platform）。
# 由 run-tests.ps1 dot-source 执行；此处用绝对路径 self dot-source 确保函数定义（宿主下 $PSScriptRoot 不可靠）。
$t_main = $env:MCPS_MAIN
if (-not $t_main) { $t_main = $mainScript }
. $t_main

# t_Count：免疫 Merge-DedupResults 的 Write-Output -NoEnumerate 嵌套包装（@() 可能包成「外层1元素含内层数组」）
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

$t_ok = $true
$t_fail = @()

# 1. 同名跨平台保留（v1.17 核心修复：npm devise vs RubyGems devise 不应合并）
$t_r1 = [PSCustomObject]@{ Name = 'devise'; Platform = 'npm'; Url = 'x'; Stars = 1 }
$t_r2 = [PSCustomObject]@{ Name = 'devise'; Platform = 'RubyGems'; Url = 'y'; Stars = 2 }
$t_m1 = @(Merge-DedupResults -Results @($t_r1, $t_r2))
$t_c1 = t_Count $t_m1
if ($env:MCPS_TEST_DEBUG) {
    "DBG ver=$VERSION id1=[$(Get-ResultIdentity -r $t_r1)] id2=[$(Get-ResultIdentity -r $t_r2)] m1count=$t_c1 raw=$(@($t_m1).Count) json=$(@($t_m1) | ForEach-Object { $_ } | ConvertTo-Json -Compress -Depth 2)" | Out-File -Append -Encoding utf8 "D:\想法作品\skill\multi-code-platform-searcher\__dedup_dbg.txt"
}
if ($t_c1 -ne 2) { $t_ok = $false; $t_fail += "cross-platform same name should keep 2, got $t_c1" }

# 2. 同平台同名去重（不应重复）
$t_r3 = [PSCustomObject]@{ Name = 'foo'; Platform = 'GitHub'; Url = 'a'; Stars = 1 }
$t_r4 = [PSCustomObject]@{ Name = 'foo'; Platform = 'GitHub'; Url = 'b'; Stars = 2 }
$t_m2 = @(Merge-DedupResults -Results @($t_r3, $t_r4))
$t_c2 = t_Count $t_m2
if ($t_c2 -ne 1) { $t_ok = $false; $t_fail += "same-platform same name should dedup to 1, got $t_c2" }

# 3. 代码证据：同 仓库+文件+行号 跨源去重（grep.app vs Sourcegraph 视为重复）
$t_d1 = [PSCustomObject]@{ Name = 'r'; Platform = 'grep.app'; File = 'a.py'; Line = 3; Url = 'x' }
$t_d2 = [PSCustomObject]@{ Name = 'r'; Platform = 'Sourcegraph'; File = 'a.py'; Line = 3; Url = 'y' }
$t_m3 = @(Merge-DedupResults -Results @($t_d1, $t_d2))
$t_c3 = t_Count $t_m3
if ($t_c3 -ne 1) { $t_ok = $false; $t_fail += "code same file+line should dedup, got $t_c3" }

# 4. 代码证据：不同行号保留
$t_d3 = [PSCustomObject]@{ Name = 'r'; Platform = 'grep.app'; File = 'a.py'; Line = 5; Url = 'x' }
$t_m4 = @(Merge-DedupResults -Results @($t_d1, $t_d3))
$t_c4 = t_Count $t_m4
if ($t_c4 -ne 2) { $t_ok = $false; $t_fail += "code different line should keep 2, got $t_c4" }

if ($t_ok) { Write-Output "TEST_PASS test-dedup (4/4)" }
else { Write-Output "TEST_FAIL test-dedup: $($t_fail -join '; ')" }
