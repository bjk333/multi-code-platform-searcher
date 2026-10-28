# tests/u267-record-replay-corpus.ps1 —— U-267 回放语料的**录制器**（唯一需要联网的一步）。
#
# 为什么要有它：语料表 `tests/fixtures/replay/corpora.json` 是单一事实源；如果手工分别录 4 份，
#   参数/禁用集/截止覆盖迟早会漂（这个仓里"两份手写事实"栽过太多次）。录制器与门读同一张表。
#
# 每个语料做四件事：
#   ① 删掉旧目录（新旧混在一起会得到"越界/多出来"的假象）
#   ② 带 MCPS_RECORD_DIR 跑一次**真网**，然后**断言这次是干净的**（Verdict/结果数/errors/无 replay-miss）
#      —— 录进失败路径的语料等于把"当天网络不行"写成产品行为，这正是 §1.4 否掉的那条路
#   ③ 带 MCPS_REPLAY_DIR 跑一次，再断言同样干净（证明语料**够用**：没有 replay-miss/exhausted）
#   ④ 把这次**回放**输出写成 baseline.json（不是录制那份：录制那份带真实耗时，会误导后来人）
#
# 用法：
#   pwsh -NoProfile -File tests/u267-record-replay-corpus.ps1                 # 全部语料
#   pwsh -NoProfile -File tests/u267-record-replay-corpus.ps1 -Name repo-gitee # 单个
param([string]$Name = '', [string]$Corpora = '', [switch]$Force, [switch]$BaselineOnly)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = (Resolve-Path (Join-Path $here '..')).Path
if (-not $Corpora) { $Corpora = Join-Path $here 'fixtures/replay/corpora.json' }
$main = Join-Path $root 'multi-platform-searcher.ps1'
$table = Get-Content -LiteralPath $Corpora -Raw -Encoding UTF8 | ConvertFrom-Json
$exe = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
if (-not $exe) { $exe = (Get-Command powershell -ErrorAction Stop).Source }

function Invoke-Cli {
    param([string[]]$CliArgs, [hashtable]$EnvMap, [string]$Tag)
    # ★不能用 Start-Process -ArgumentList 拼参数：它把数组按空格连成一个命令行，**带空格的路径会被拆开**
    #   （本仓路径就是 `<workspace>\...`；第一次录制直接产出空 stdout ⇒ 报"payload 不可解析"）。
    #   这里显式加引号 + 用 .NET Process 并指定 UTF-8 解码（子进程 -AsJson 输出就是 UTF-8）。
    $q = { param($s) if ($s -match '[\s"]') { '"' + ($s -replace '"', '\"') + '"' } else { $s } }
    $argLine = (@('-NoProfile', '-NonInteractive', '-File', (& $q $main)) + ($CliArgs | ForEach-Object { & $q $_ })) -join ' '
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $exe
    $psi.Arguments = $argLine
    $psi.WorkingDirectory = $root
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
    $saved = @{}
    foreach ($k in $EnvMap.Keys) { $saved[$k] = [Environment]::GetEnvironmentVariable($k); [Environment]::SetEnvironmentVariable($k, [string]$EnvMap[$k]) }
    try {
        $p = [System.Diagnostics.Process]::Start($psi)
        $errTask = $p.StandardError.ReadToEndAsync()
        $text = $p.StandardOutput.ReadToEnd()
        $p.WaitForExit()
        $err = $errTask.Result
        $rc = $p.ExitCode
        $p.Dispose()
    } finally {
        foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k]) }
    }
    $payload = $null
    try { $payload = $text.Trim() | ConvertFrom-Json } catch { }
    return [PSCustomObject]@{ rc = $rc; text = $text; err = $err; payload = $payload }
}

function Assert-Clean($run, $spec, [string]$phase) {
    $bad = @()
    $who = ''
    if ($null -eq $run.payload) { $bad += 'payload 不可解析' }
    else {
        $c = $run.payload.coverage
        if ([string]$c.Verdict -ne [string]$spec.expect.verdict) { $bad += "Verdict=$($c.Verdict) ≠ $($spec.expect.verdict)" }
        $n = @($run.payload.results).Count
        if ($n -ne [int]$spec.expect.results) { $bad += "results=$n ≠ $($spec.expect.results)" }
        if (@($run.payload.errors).Count -ne 0) { $bad += "errors=$(@($run.payload.errors).Count) 条（语料不该含失败路径）" }
        if (@($c.Degraded).Count -ne 0) { $bad += "Degraded=$(@($c.Degraded) -join ',')" }
        if ($c.ReasonCodes) { $who = '；逐源归因: ' + (($c.ReasonCodes.PSObject.Properties | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join ', ') }
    }
    if ($run.text -match 'replay-(miss|exhausted|unsupported)') { $bad += '输出里有 replay-miss/exhausted' }
    if ($bad.Count) { throw ("[{0}] {1} 不干净：{2}{3}" -f $spec.name, $phase, ($bad -join '；'), $who) }
}

$results = @()
foreach ($spec in $table.corpora) {
    if ($Name -and $spec.name -ne $Name) { continue }
    $dir = Join-Path $here ("fixtures/replay/" + $spec.name)
    # U-268：`-BaselineOnly` = **语料不动，只按当前环境重建基线**。
    #   适用：改了影响输出的环境（如 MCPS_FIXED_NOW）、或换了产品行为但语料仍有效。
    #   刻意不重录网络 —— 重录会把"今天的网络"烧进语料（§2.3）。
    if ($BaselineOnly) {
        if (-not (Test-Path (Join-Path $dir 'responses.jsonl'))) { Write-Host ("[u267] {0}: 没有语料，跳过（先跑一次完整录制）" -f $spec.name) -ForegroundColor Yellow; continue }
    } else {
        # 已有语料默认**跳过**：语料是"冻结的过去"，重录等于把今天的网络状态烧进基线。
        # 要重录（例如产品行为真的变了、或换了机器）必须显式 -Force。
        if (-not $Force -and (Test-Path (Join-Path $dir 'responses.jsonl')) -and (Test-Path (Join-Path $dir 'baseline.json'))) {
            Write-Host ("[u267] {0}: 已存在，跳过（重录请加 -Force）" -f $spec.name) -ForegroundColor DarkGray
            continue
        }
        if (Test-Path $dir) { Remove-Item $dir -Recurse -Force }
        $null = New-Item -ItemType Directory -Path $dir -Force
    }

    $envMap = @{}
    foreach ($k in $table.commonEnv.PSObject.Properties) { $envMap[$k.Name] = [string]$k.Value }
    foreach ($k in $spec.env.PSObject.Properties) { $envMap[$k.Name] = [string]$k.Value }

    # ② 录制（真网）—— `-BaselineOnly` 跳过
    if (-not $BaselineOnly) {
        $recEnv = $envMap.Clone(); $recEnv['MCPS_RECORD_DIR'] = $dir
        $rec = Invoke-Cli -CliArgs $spec.args -EnvMap $recEnv -Tag ($spec.name + '-rec')
        Assert-Clean $rec $spec '录制'
    }

    # ③ 回放（离线），并断言语料够用
    $repEnv = $envMap.Clone(); $repEnv['MCPS_REPLAY_DIR'] = $dir
    $rep = Invoke-Cli -CliArgs $spec.args -EnvMap $repEnv -Tag ($spec.name + '-rep')
    Assert-Clean $rep $spec '回放'

    # ④ 基线 = 回放输出
    $baseline = ($rep.payload | ConvertTo-Json -Depth 12)
    [System.IO.File]::WriteAllText((Join-Path $dir 'baseline.json'), $baseline + "`n", (New-Object System.Text.UTF8Encoding($false)))

    $rows = 0
    $jl = Join-Path $dir 'responses.jsonl'
    if (Test-Path $jl) { $rows = @([System.IO.File]::ReadAllLines($jl) | Where-Object { $_.Trim() }).Count }
    $results += [PSCustomObject]@{ name = $spec.name; requests = $rows; results = @($rep.payload.results).Count; verdict = [string]$rep.payload.coverage.Verdict }
    Write-Host ("[u267] {0}: 录制 {1} 条请求 → 回放 {2} 条结果 / Verdict={3}" -f $spec.name, $rows, @($rep.payload.results).Count, $rep.payload.coverage.Verdict) -ForegroundColor Green
}
$results | ConvertTo-Json -Depth 4
