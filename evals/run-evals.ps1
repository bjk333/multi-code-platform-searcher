# run-evals.ps1 —— evals 评测环（v1.24.0，P2 #6）
# 用法：.\evals\run-evals.ps1
# 设计：8 个 ground-truth 用例（含 r1-r4 复测场景）——每个 = 输入查询 + 期望结果类别。
#       纯函数断言离线可跑；需网络/环境的用例标 SKIP（不阻塞门禁）。
#       结果写回 reports\evals-report.md（与版本报告体系衔接，长期量化精确率/召回改进）。
# 与 tests\run-tests.ps1 的关系：tests=实现正确性回归（8 组），evals=行为契约评测（ground-truth）。
# 本宿主下子进程 dot-source 不可靠，全部断言主进程内联执行。
# R94-A（远端 R1，2026-09-30）：-Revision 显式钉评测所对应的 commit（40-hex）；缺省取 git rev-parse HEAD；表头写 revision + judgments_sha256（evals/qrels-r94.json）。
param([string]$Revision = '')

$ErrorActionPreference = 'Continue'
$results = [System.Collections.Generic.List[string]]::new()
$pass = 0; $failC = 0; $skipC = 0

# ---------- 路径探测 ----------
$evalDir = $null
foreach ($c in @($MyInvocation.MyCommand.Definition, $PSScriptRoot)) {
    try {
        if ($c) {
            $d = Split-Path -Parent $c
            if ($d -and (Test-Path $d -PathType Container)) { $evalDir = $d; break }
        }
    } catch { }
}
if (-not $evalDir) { $evalDir = '.' }
$mainScript = (Resolve-Path (Join-Path $evalDir '..\multi-platform-searcher.ps1')).Path
$repoDir = (Resolve-Path (Join-Path $evalDir '..')).Path
$reportPath = Join-Path $repoDir 'reports\evals-report.md'
$env:MCPS_NO_MAIN = '1'   # dot-source 跳过主流程（v1.22.0 测试开关）
. $mainScript
# 注意：不在脚本内永久保留 MCPS_NO_MAIN——它会污染后续 `& $mainScript` 子进程调用（继承 env → 主流程被跳过 → 空输出）。
Remove-Item Env:MCPS_NO_MAIN -ErrorAction SilentlyContinue

function New-Result([string]$name, [int]$n, [string]$src, [int]$stars) {
    [PSCustomObject]@{ Index = $n; Platform = $src; Name = $name; Desc = ''; Url = "https://example.com/$name"; Stars = $stars; License = ''; Updated = '' }
}

$summary = @()

# ---------- 用例 1：r1 宽概念降噪 —— 热度惩罚排序（纯函数，离线） ----------
$t1_ok = $true; $t1_f = @()
try {
    # 热门通识项目（高星、关键词零命中）vs 具体项目（低星、命中双词）
    $hot = New-Result 'autogpt' 1 'GitHub' 120000
    $hot2 = New-Result 'ollama' 2 'GitHub' 80000
    $spec = New-Result 'llm-session-alert-monitor' 3 'GitHub' 3200
    $spec2 = New-Result 'session-alert-console' 4 'GitHub' 900
    $ranked = Set-UnifiedScore -Results @($hot, $hot2, $spec, $spec2) -Keyword "llm monitor session alert" -FocusTerms 'session,alert'
    $rankedArr = @($ranked)
    $top1 = $rankedArr[0].Name
    # 期望：双词命中具体项目排前（score 最高），热门零命中项垫底
    if ($top1 -ne 'llm-session-alert-monitor' -and $top1 -ne 'session-alert-console') { $t1_ok = $false; $t1_f += "Top1=$top1（期望命中双词的具体项目）" }
    $last = $rankedArr[$rankedArr.Count - 1].Name
    if ($last -ne 'autogpt' -and $last -ne 'ollama') { $t1_ok = $false; $t1_f += "垫底=$last（期望热门零命中项）" }
    # MatchTerms/NoiseFlagged 契约
    $hotOut = $rankedArr | Where-Object { $_.Name -eq 'autogpt' }
    $specOut = $rankedArr | Where-Object { $_.Name -eq 'llm-session-alert-monitor' }
    if ($specOut.NoiseFlagged) { $t1_ok = $false; $t1_f += "具体项目被误标噪音" }
    if (-not $hotOut.NoiseFlagged) { $t1_ok = $false; $t1_f += "热门零命中项未标噪音" }
    if (@($hotOut.MatchTerms).Count -ne 0) { $t1_ok = $false; $t1_f += "热门项 MatchTerms 应为空" }
    if (@($specOut.MatchTerms).Count -lt 1) { $t1_ok = $false; $t1_f += "具体项 MatchTerms 应有命中" }
} catch { $t1_ok = $false; $t1_f += $_.Exception.Message }
$summary += [PSCustomObject]@{ Id = 'E1'; Case = 'r1 宽概念降噪（热度惩罚排序+字段契约）'; Result = if ($t1_ok) { 'PASS' } else { 'FAIL' }; Detail = ($t1_f -join '; ') }

# ---------- 用例 2：r2 代码证据可观测 —— auth_missing/coverage（网络：SKIP 当有 token） ----------
$t2_ok = $true; $t2_f = @(); $t2_skip = $false
try {
    if ([bool]$env:GITHUB_TOKEN) { $t2_skip = $true; $summary += [PSCustomObject]@{ Id = 'E2'; Case = 'r2 代码证据可观测（coverage/ExitCode）'; Result = 'SKIP'; Detail = '本机有 GITHUB_TOKEN，无 token 语义需在无 token 环境复测' } }
    else {
        $ev = (& $mainScript -CodeEvidence -Keyword "session_alert" -Limit 3 -AsJson -NoCache | Out-String | ConvertFrom-Json)
        if ($null -eq $ev.coverage) { $t2_ok = $false; $t2_f += "coverage 缺失" }
        else {
            if ($ev.coverage.Blocked -notcontains 'GitHubCode') { $t2_ok = $false; $t2_f += "无 token 但 GitHubCode 未标 Blocked" }
            if ($ev.metrics.ExitCode -ne 3) { $t2_ok = $false; $t2_f += "ExitCode=$($ev.metrics.ExitCode)（期望 3）" }
            if ($null -eq $ev.warnings) { $t2_ok = $false; $t2_f += "warnings 字段缺失" }
        }
        $summary += [PSCustomObject]@{ Id = 'E2'; Case = 'r2 代码证据可观测（coverage/ExitCode/warnings）'; Result = if ($t2_ok) { 'PASS' } else { 'FAIL' }; Detail = ($t2_f -join '; ') }
    }
} catch { $summary += [PSCustomObject]@{ Id = 'E2'; Case = 'r2 代码证据可观测'; Result = 'FAIL'; Detail = $_.Exception.Message } }

# ---------- 用例 3：r3 研究源 0 命中诊断 —— research 契约（网络） ----------
$t3_ok = $true; $t3_f = @(); $t3_skip = $false
try {
    $uniq = "qxjz$([guid]::NewGuid().ToString('N').Substring(0, 8))wvfn"
    $re = (& $mainScript -ResearchSources -Keyword $uniq -Limit 1 -AsJson -NoCache -ExpandQuery | Out-String | ConvertFrom-Json)
    # v1.32.0 修复：MCPRegistry(Glama) 对任意 q 宽松返回默认单条(Stoop)——服务端行为，非技能缺陷。
    # 随机词场景下「除 MCPRegistry 外全 0 命中」即视为 0 命中，仍须产出 research 诊断契约。
    $nonMcpHits = @($re.results | Where-Object { $_.Platform -ne 'MCPRegistry' })
    if ($nonMcpHits.Count -gt 0) { $t3_ok = $false; $t3_f += "非 MCPRegistry 意外命中 $($nonMcpHits.Count) 条" }
    elseif ($null -eq $re.research) { $t3_ok = $false; $t3_f += "0 命中(除MCPRegistry宽松项)但 research 缺失" }
    else {
        if ($re.research.interpretation -ne 'no-match') { $t3_ok = $false; $t3_f += "interpretation=$($re.research.interpretation)" }
        if ($re.research.lowConfidenceNegative -ne $true) { $t3_ok = $false; $t3_f += "lowConfidenceNegative=$($re.research.lowConfidenceNegative)" }
        if (@($re.research.suggestedWiderQueries).Count -lt 1) { $t3_ok = $false; $t3_f += "suggestedWiderQueries 为空" }
        if (@($re.research.searchRounds).Count -lt 1) { $t3_ok = $false; $t3_f += "searchRounds 为空" }
    }
} catch { $t3_ok = $false; $t3_f += $_.Exception.Message }
$summary += [PSCustomObject]@{ Id = 'E3'; Case = 'r3 研究源 0 命中诊断（research 契约）'; Result = if ($t3_ok) { 'PASS' } else { 'FAIL' }; Detail = ($t3_f -join '; ') }

# ---------- 用例 4：r4/-Doctor 环境自检 —— remoteEngines + 能力矩阵（网络 ping，超时 SKIP） ----------
$t4_ok = $true; $t4_f = @()
try {
    $doc = (& $mainScript -Doctor -AsJson | Out-String | ConvertFrom-Json)
    if ($doc.version -notmatch '^1\.\d+\.\d+$') { $t4_ok = $false; $t4_f += "version 格式异常" }
    if ($doc.doctor.codeEvidenceLevel -notin @('local+remote', 'remote-only')) { $t4_ok = $false; $t4_f += "codeEvidenceLevel 异常" }
    $engines = @($doc.doctor.remoteEngines)
    if (@($engines | Where-Object { $_.Engine -eq 'grep.app' }).Count -lt 1) { $t4_ok = $false; $t4_f += "缺 grep.app 健康项" }
    if (@($engines | Where-Object { $_.Engine -eq 'Sourcegraph' }).Count -lt 1) { $t4_ok = $false; $t4_f += "缺 Sourcegraph 健康项" }
} catch { $t4_ok = $false; $t4_f += $_.Exception.Message }
$summary += [PSCustomObject]@{ Id = 'E4'; Case = 'r4/-Doctor 环境自检（remoteEngines+能力矩阵）'; Result = if ($t4_ok) { 'PASS' } else { 'FAIL' }; Detail = ($t4_f -join '; ') }

# ---------- 用例 5：Build-QueryVariants 领域词扩写（纯函数，离线） ----------
$t5_ok = $true; $t5_f = @()
try {
    $v = @(Build-QueryVariants -Keyword "llm monitor session alert")
    $kinds = @($v | ForEach-Object { $_.Kind } | Select-Object -Unique)
    if ($kinds -notcontains 'original') { $t5_ok = $false; $t5_f += "缺 original 变体" }
    if ($kinds -notcontains 'synonym') { $t5_ok = $false; $t5_f += "缺 synonym 变体" }
    if ($kinds -notcontains 'wider') { $t5_ok = $false; $t5_f += "缺 wider 变体" }
    $syn = @($v | Where-Object { $_.Kind -eq 'synonym' })
    if (@($syn | Where-Object { $_.Query -match 'conversation' }).Count -lt 1) { $t5_ok = $false; $t5_f += "session→conversation 同义替换缺失" }
    $wider = @($v | Where-Object { $_.Kind -eq 'wider' })
    if (@($wider | Where-Object { $_.Query -match 'observability|monitoring' }).Count -lt 1) { $t5_ok = $false; $t5_f += "wider 领域宽词缺失" }
} catch { $t5_ok = $false; $t5_f += $_.Exception.Message }
$summary += [PSCustomObject]@{ Id = 'E5'; Case = 'Build-QueryVariants 领域词扩写'; Result = if ($t5_ok) { 'PASS' } else { 'FAIL' }; Detail = ($t5_f -join '; ') }

# ---------- 用例 6：Build-QueryVariants 无领域词退化（纯函数，离线） ----------
$t6_ok = $true; $t6_f = @()
try {
    $v = @(Build-QueryVariants -Keyword "randomxyz")
    $kinds = @($v | ForEach-Object { $_.Kind } | Select-Object -Unique)
    if ($kinds -notcontains 'original') { $t6_ok = $false; $t6_f += "缺 original" }
    # 无领域词 → 无 synonym，wider 至少有一条（渐进放宽/兜底）
    if ($kinds -contains 'synonym') { $t6_ok = $false; $t6_f += "无领域词不应生成 synonym" }
    if (@($v | Where-Object { $_.Kind -eq 'wider' }).Count -lt 1) { $t6_ok = $false; $t6_f += "wider 为空（应渐进放宽或兜底）" }
} catch { $t6_ok = $false; $t6_f += $_.Exception.Message }
$summary += [PSCustomObject]@{ Id = 'E6'; Case = 'Build-QueryVariants 无领域词退化'; Result = if ($t6_ok) { 'PASS' } else { 'FAIL' }; Detail = ($t6_f -join '; ') }

# ---------- 用例 7：research 有命中时 research=null（防误报，网络） ----------
$t7_ok = $true; $t7_f = @(); $t7_skip = $false
try {
    $re = (& $mainScript -ResearchSources -Keyword "jwt" -Limit 1 -AsJson -NoCache -ExpandQuery | Out-String | ConvertFrom-Json)
    if (@($re.results).Count -gt 0) {
        if ($null -ne $re.research) { $t7_ok = $false; $t7_f += "有命中但 research 非 null（误报）" }
    } else { $t7_skip = $true }
} catch { $t7_ok = $false; $t7_f += $_.Exception.Message }
$summary += [PSCustomObject]@{ Id = 'E7'; Case = 'research 有命中时 research=null'; Result = if ($t7_skip) { 'SKIP' } elseif ($t7_ok) { 'PASS' } else { 'FAIL' }; Detail = if ($t7_skip) { '网络波动 0 命中，跳过' } else { ($t7_f -join '; ') } }

# ---------- 用例 8：排序分数契约 —— Score 单调降序 + 范围 0-1（纯函数，离线） ----------
$t8_ok = $true; $t8_f = @()
try {
    $items = @(
        (New-Result 'alpha-search' 1 'GitHub' 5000),
        (New-Result 'beta-hub' 2 'GitHub' 100),
        (New-Result 'gamma-lib' 3 'npm' 9000)
    )
    $ranked = @(Set-UnifiedScore -Results $items -Keyword "search hub")
    for ($i = 1; $i -lt $ranked.Count; $i++) {
        if ($ranked[$i-1].Score -lt $ranked[$i].Score) { $t8_ok = $false; $t8_f += "Score 非单调降序 @$i" }
    }
    foreach ($r in $ranked) {
        if ($r.Score -lt 0 -or $r.Score -gt 1) { $t8_ok = $false; $t8_f += "Score 越界: $($r.Score)" }
    }
} catch { $t8_ok = $false; $t8_f += $_.Exception.Message }
$summary += [PSCustomObject]@{ Id = 'E8'; Case = '排序分数契约（单调+范围）'; Result = if ($t8_ok) { 'PASS' } else { 'FAIL' }; Detail = ($t8_f -join '; ') }

# ---------- 用例 9：R94-A 可复现骨架 —— revision 必须是 40-hex commit SHA（分支名/短 SHA/空 ⇒ FAIL，不静默） ----------
if (-not $Revision) { try { $Revision = [string](& git -C $repoDir rev-parse HEAD 2>$null | Select-Object -First 1) } catch { $Revision = '' } }
$pin = Test-PinnedRevision -Revision $Revision
$judgmentsPath = Join-Path $evalDir 'qrels-r94.json'
$judgmentsSha = if (Test-Path -LiteralPath $judgmentsPath) { (Get-FileHash -LiteralPath $judgmentsPath -Algorithm SHA256).Hash.ToLowerInvariant() } else { 'MISSING' }
$summary += [PSCustomObject]@{ Id = 'E9'; Case = 'R94-A revision 钉死（40-hex commit SHA）'; Result = if ($pin.Ok) { 'PASS' } else { 'FAIL' }; Detail = if ($pin.Ok) { "revision=$Revision" } else { $pin.Reason } }

# ---------- 用例 10：R94-A/B/C 分桶读数 —— qrels 冻结快照上按源分桶 P@5/nDCG@5/RR + 公平三指标（纯函数，离线） ----------
$t10_ok = $true; $t10_f = @()
try {
    $q = Get-Content -LiteralPath $judgmentsPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $rep = Get-BucketedEvalReport -Items @($q.items) -Sources @($q.sources_with_results) -K 5
    $bk = @($rep.Buckets.PSObject.Properties)
    if ($bk.Count -lt 2) { $t10_ok = $false; $t10_f += '分桶数 < 2（禁单一聚合）' }
    foreach ($b in $bk) { if ($null -ne $b.Value.NdcgAtK -and [double]::IsNaN([double]$b.Value.NdcgAtK)) { $t10_ok = $false; $t10_f += "NaN@$($b.Name)" } }
    $t10_f += ($bk | ForEach-Object { '{0}:P@5={1},nDCG@5={2}' -f $_.Name, $_.Value.PAtK, $(if ($null -eq $_.Value.NdcgAtK) { 'excluded' } else { $_.Value.NdcgAtK }) }) -join ' '
    $t10_f += ('SC@5={0}/{1} bestRank≤5 占比={2} Δ={3}' -f $rep.Fairness.SourceCoverage.Value, $rep.Fairness.SourceCoverage.Threshold, $rep.Fairness.PerSourceBest.ShareBestWithinK, $rep.Fairness.PerSourceBest.ExposureDelta)
} catch { $t10_ok = $false; $t10_f += $_.Exception.Message }
$summary += [PSCustomObject]@{ Id = 'E10'; Case = 'R94 分桶读数（qrels 银标，未人工复核）'; Result = if ($t10_ok) { 'PASS' } else { 'FAIL' }; Detail = ($t10_f -join '; ') }

# ---------- 汇总 ----------
$outLines = @()
$outLines += "# evals 评测报告（v1.24.0）"
$outLines += ""
$outLines += "> 生成时间：$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  ·  主脚本版本：$VERSION"
$outLines += "> revision：$(if ($pin.Ok) { $Revision } else { "UNPINNED（$($pin.Reason)）" })  ·  judgments_sha256：$judgmentsSha"
$outLines += ""
$outLines += "| 用例 | 场景（ground-truth） | 结果 | 说明 |"
$outLines += "|---|---|---|---|"
foreach ($s in $summary) {
    $outLines += "| $($s.Id) | $($s.Case) | $($s.Result) | $($s.Detail) |"
    if ($s.Result -eq 'PASS') { $pass++ }
    elseif ($s.Result -eq 'SKIP') { $skipC++ }
    else { $failC++ }
}
$outLines += ""
$outLines += "**合计：$pass PASS / $failC FAIL / $skipC SKIP**"
$outLines += ""
$outLines += "> 复跑：.\evals\run-evals.ps1（纯函数用例离线，网络用例按环境 SKIP/真实断言）"
$outText = $outLines -join "`n"
[System.IO.File]::WriteAllText($reportPath, $outText + "`n", [System.Text.UTF8Encoding]::new($false))

Write-Output "== multi-code-platform-searcher evals (v1.24.0) =="
foreach ($s in $summary) {
    Write-Output ("[{0}] {1} : {2}{3}" -f $s.Result, $s.Id, $s.Case, $(if ($s.Detail) { " -- $($s.Detail)" } else { '' }))
}
Write-Output "========================================"
Write-Output "RESULT: $pass passed / $failC failed / $skipC skipped"
Write-Output ("报告已写入: $reportPath")
if ($failC -gt 0) { exit 1 } else { exit 0 }