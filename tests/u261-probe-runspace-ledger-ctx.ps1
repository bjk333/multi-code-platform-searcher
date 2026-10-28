# U-261 探针：runspace 内"当前引擎/模式"这类**标量**上下文，能不能被注入的函数读到？
#
# 背景：B2-6 成本账本每行要写 `engine` / `mode`，而 `Add-ApiRequestStat` 是**注入到每个 runspace** 的函数，
#   它对"自己正在替哪个引擎干活"一无所知。候选机制两条：
#     ① `$script:` —— 在 runspace 包装块里 `$script:_ledgerEngine = 'HF'`，函数内读 `$script:_ledgerEngine`
#     ② 动态作用域 —— 包装块里设局部 `$__ledgerEngine = 'HF'`，函数内按**不带作用域的名字**读
#   ★注意这两个跟 `_engineStatus` 那种"注入引用"完全不同：那个是共享**对象**，这个是**标量**，
#     不会跨 runspace 共享（也不该共享 —— 8 个 runspace 同时跑，共享标量必然互相覆盖）。
#
# 判据：两种机制在 runspace 内都必须读到正确的值，且 8 个 runspace 并发时**互不串台**。
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$m = Join-Path $root 'multi-platform-searcher.ps1'
if (-not (Test-Path $m)) { throw "no main script: $m" }

$fnDef = @'
function Get-LedgerCtx {
    $a = ''; $b = ''
    try { if ($null -ne $script:_ledgerEngine) { $a = [string]$script:_ledgerEngine } } catch { $a = '<throw>' }
    try { if ($null -ne $__ledgerEngine) { $b = [string]$__ledgerEngine } } catch { $b = '<throw>' }
    return [PSCustomObject]@{ Script = $a; Dyn = $b }
}
'@

$pool = [runspacefactory]::CreateRunspacePool(1, 8)
$pool.Open()
$jobs = @()
foreach ($n in @('A', 'B', 'C', 'D', 'E', 'F', 'G', 'H')) {
    $ps = [powershell]::Create(); $ps.RunspacePool = $pool
    [void]$ps.AddScript({
            param($FnDef, $Engine, $Mode, $Round)
            . ([scriptblock]::Create($FnDef))
            $script:_ledgerEngine = $Engine
            $script:_ledgerMode = $Mode
            $__ledgerEngine = $Engine
            $rows = @()
            for ($i = 0; $i -lt $Round; $i++) { $rows += (Get-LedgerCtx) }
            $bad = @($rows | Where-Object { $_.Script -ne $Engine -or $_.Dyn -ne $Engine })
            [PSCustomObject]@{ Engine = $Engine; Rounds = $rows.Count; Bad = $bad.Count
                FirstScript = $rows[0].Script; FirstDyn = $rows[0].Dyn
                ModeSeen = [string]$script:_ledgerMode
            }
        }).AddArgument($fnDef).AddArgument($n).AddArgument('code').AddArgument(200)
    $jobs += [PSCustomObject]@{ PS = $ps; H = $ps.BeginInvoke() }
}
$out = @()
foreach ($j in $jobs) { $out += @($j.PS.EndInvoke($j.H)); $j.PS.Dispose() }
$pool.Close(); $pool.Dispose()

$bad = @($out | Where-Object { $_.Bad -gt 0 -or $_.ModeSeen -ne 'code' })
[PSCustomObject]@{
    runspaces   = $out.Count
    scriptOk    = (@($out | Where-Object { $_.FirstScript -eq $_.Engine }).Count)
    dynOk       = (@($out | Where-Object { $_.FirstDyn -eq $_.Engine }).Count)
    crossTalk   = $bad.Count
    detail      = @($out | ForEach-Object { "$($_.Engine)=$($_.FirstScript)/$($_.FirstDyn)/$($_.ModeSeen)/bad=$($_.Bad)" })
} | ConvertTo-Json -Compress -Depth 4
