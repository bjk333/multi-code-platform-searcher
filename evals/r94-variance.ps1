# evals/r94-variance.ps1 —— R94 银标的**不确定性**报告（2026-10-19 · P2-5）
#   动机：R94 的 qrels 是**冻结快照**，跑两次读数完全相同 ⇒「多次跑取 std」恒为 0，没有信息量。
#         真正的问题是**每桶只有 3–13 条标注**（DockerHub 3 / crates.io 5 / npm 5 / arXiv 12 …），
#         一个 P@5=0 或 1 在小样本上几乎无意义（2605.11209：saturated/small benchmark 上单点分数不可解释）。
#   做法：**自助法（bootstrap）**——对每桶的标注项做有放回重采样 B 次，重算 P@K / nDCG@K / RR，
#         给出 mean±std 与 95% 区间；并对 N<5 的桶显式标注 insufficient（不参与"谁更好"的判断）。
#   纪律：
#     · 复用主脚本的 Get-PrecisionAtK / Get-NdcgAtK / Get-ReciprocalRank —— **不重写指标**（两套实现必然漂移）
#     · 固定种子 ⇒ 输出**逐字节可复现**（否则"方差"本身就是噪声）
#     · 只读 qrels，不联网
param(
    [string]$Qrels = '',
    [int]$K = 5,
    [int]$Bootstrap = 2000,
    [int]$Seed = 20261019,
    [string]$SkillDir = ''
)
$ErrorActionPreference = 'Stop'
if (-not $SkillDir) { $SkillDir = (Resolve-Path (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '..')).Path }
$SkillDir = (Resolve-Path $SkillDir).Path
if (-not $Qrels) { $Qrels = Join-Path $SkillDir 'evals\qrels-r94.json' }
if (-not (Test-Path $Qrels)) { Write-Output "R94V_FAIL missing qrels: $Qrels"; exit 2 }

$env:MCPS_NO_MAIN = '1'
. (Join-Path $SkillDir 'multi-platform-searcher.ps1')

$q = Get-Content -LiteralPath $Qrels -Raw -Encoding UTF8 | ConvertFrom-Json
$items = @($q.items | Sort-Object { [int]$_.rank })
$sources = @($q.sources_with_results)

function Measure-Bucket([double[]]$Gains, [int]$K, [int]$B, $Rng) {
    $n = $Gains.Count
    if ($n -eq 0) { return $null }
    $relv = [bool[]]@($Gains | ForEach-Object { $_ -gt 0 })
    $p5 = Get-PrecisionAtK -Relevant $relv -K $K
    $nd = Get-NdcgAtK -Gains $Gains -K $K
    $rr = Get-ReciprocalRank -Relevant $relv
    $ps = New-Object 'System.Collections.Generic.List[double]'
    $nds = New-Object 'System.Collections.Generic.List[double]'
    $rrs = New-Object 'System.Collections.Generic.List[double]'
    # ★PowerShell 变量**不区分大小写**：循环变量不能叫 $b（会覆盖参数 $B）—— 我用 $it 迭代次数
    for ($iter = 0; $iter -lt $B; $iter++) {
        $sg = [double[]]::new($n); $sr = [bool[]]::new($n)
        for ($i = 0; $i -lt $n; $i++) { $j = $Rng.Next(0, $n); $sg[$i] = $Gains[$j]; $sr[$i] = ($sg[$i] -gt 0) }
        $ps.Add((Get-PrecisionAtK -Relevant $sr -K $K))
        $ndv = Get-NdcgAtK -Gains $sg -K $K
        if ($null -ne $ndv) { $nds.Add([double]$ndv) }
        $rrs.Add((Get-ReciprocalRank -Relevant $sr))
    }
    function Stat($vals) {
        if ($vals.Count -eq 0) { return $null }
        $arr = @($vals | Sort-Object)
        $mean = ($arr | Measure-Object -Average).Average
        $var = 0.0
        if ($arr.Count -gt 1) { foreach ($v in $arr) { $var += [math]::Pow($v - $mean, 2) }; $var = $var / ($arr.Count - 1) }
        $sd = [math]::Sqrt($var)
        $lo = $arr[[int][math]::Floor(0.025 * ($arr.Count - 1))]
        $hi = $arr[[int][math]::Ceiling(0.975 * ($arr.Count - 1))]
        return [PSCustomObject]@{ Mean = [math]::Round($mean, 4); Sd = [math]::Round($sd, 4); Lo = [math]::Round($lo, 4); Hi = [math]::Round($hi, 4) }
    }
    return [PSCustomObject]@{ N = $n; P5 = $p5; Ndcg = $nd; RR = $rr; BP = (Stat $ps); BN = (Stat $nds); BR = (Stat $rrs) }
}

$rng = [System.Random]::new($Seed)
$rows = @()
foreach ($s in $sources) {
    $mine = @($items | Where-Object { [string]$_.source -eq $s })
    $gains = [double[]]@($mine | ForEach-Object { [double]$_.rel })
    $m = Measure-Bucket -Gains $gains -K $K -B $Bootstrap -Rng $rng
    if ($null -eq $m) { continue }
    $flag = if ($m.N -lt 5) { 'insufficient' } else { 'ok' }
    $rows += [PSCustomObject]@{ Source = $s; M = $m; Flag = $flag }
}

# ---- 机器可读输出（ASCII 标记，便于门解析）----
foreach ($r in $rows) {
    $m = $r.M
    $pn = if ($null -ne $m.BN) { '{0}±{1}[{2},{3}]' -f ($m.BN.Mean), ($m.BN.Sd), ($m.BN.Lo), ($m.BN.Hi) } else { 'n/a' }
    # 结构上限：P@K 的分母恒为 K（TREC 口径）⇒ 每桶只有 N 条标注时，P@K 最大只能到 min(N,K)/K
    $ceiling = [math]::Round([math]::Min($m.N, $K) / [double]$K, 4)
    Write-Output ('R94V-POINT {0} N={1} P5={2} NDCG={3} RR={4} ceiling={5} flag={6}' -f ($r.Source), ($m.N), ($m.P5), ($m.Ndcg), ($m.RR), ($ceiling), ($r.Flag))
    Write-Output ('R94V {0} N={1} P5={2}±{3}[{4},{5}] NDCG={6} RR={7}±{8} flag={9}' -f `
            ($r.Source), ($m.N), ($m.BP.Mean), ($m.BP.Sd), ($m.BP.Lo), ($m.BP.Hi), ($pn), ($m.RR), ($m.BR.Sd), ($r.Flag))
}

$insuff = @($rows | Where-Object { $_.Flag -eq 'insufficient' }).Count
Write-Output ('R94V_SUMMARY buckets={0} insufficient={1} K={2} bootstrap={3} seed={4}' -f $rows.Count, $insuff, $K, $Bootstrap, $Seed)
if ($insuff -gt 0) {
    Write-Output ('R94V_WARN {0}/{1} buckets have N<5 - per-bucket ranking is NOT interpretable; report mean+-std only' -f $insuff, $rows.Count)
}
Write-Output 'R94V_OK'
exit 0
