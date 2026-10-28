# 探针（U-266）：`Write-ColorOutput` 在被重定向时，进度串会不会落进 runspace 的**结果集**？
#
# 为什么单独探：引擎函数返回封套（engine/1）后，池内每条 `Invoke()` 的输出集合按约定只有**一个**对象。
# 若进度串写成功流，集合就是 `[string, 封套]`；`ConvertTo-EngineEnvelope` 见到数组即判 `engine/0`
# ⇒ 引擎明明成功却被记成"旧契约"，或更糟：下游把 string 当结果项。这不是排版问题，是数据问题。
#
# 探针**从产品文件里取函数原文**（不是复制一份），所以它随产品一起变：
# 改回 `Write-Output` ⇒ 本探针 pollutions=1；改走 Console.Error ⇒ pollutions=0。
#
# 用法：
#   pwsh -NoProfile -File tests/u266-probe-output-channel.ps1 [-Main <主脚本路径>]
# 输出：单行 JSON（stdout）。进度串本身会出现在 stderr —— 这正是判据之一。
param([string]$Main = '')

$ErrorActionPreference = 'Stop'
if (-not $Main) { $Main = Join-Path (Split-Path -Parent $PSCommandPath) '..\multi-platform-searcher.ps1' }
if (-not (Test-Path $Main)) { throw "主脚本不存在: $Main" }

# ---- 取函数原文：从 `function Write-ColorOutput {` 起到配对的 `}` ----
$src = [System.IO.File]::ReadAllText($Main)
# v1.54.0（B3-2）：函数已搬进 lib/ ⇒ 主脚本旁边有 lib/ 就把它拼进来源（变异副本没有 lib/，自然跳过）。
$__libDir = Join-Path (Split-Path -Parent $Main) 'lib'
if (Test-Path -LiteralPath $__libDir -PathType Container) {
    foreach ($__lf in (Get-ChildItem -LiteralPath $__libDir -Filter '*.ps1' -File | Sort-Object Name)) {
        $src += ([string][char]10) + [System.IO.File]::ReadAllText($__lf.FullName)
    }
}
$m = [regex]::Match($src, '(?m)^function Write-ColorOutput\s*\{')
if (-not $m.Success) { throw '找不到 function Write-ColorOutput' }
$start = $m.Index
$i = $src.IndexOf('{', $start)
$depth = 0; $end = -1
for ($p = $i; $p -lt $src.Length; $p++) {
    $ch = $src[$p]
    if ($ch -eq '{') { $depth++ }
    elseif ($ch -eq '}') { $depth--; if ($depth -eq 0) { $end = $p; break } }
}
if ($end -lt 0) { throw 'Write-ColorOutput 大括号不配对' }
$fnText = $src.Substring($start, $end - $start + 1)

# ---- 在 runspace 里照生产形状跑：先打一行进度，再返回封套 ----
$pool = [runspacefactory]::CreateRunspacePool(1, 1)
$pool.ApartmentState = 'MTA'
$pool.Open()
$ps = [powershell]::Create()
$ps.RunspacePool = $pool
[void]$ps.AddScript({
        param($FnText)
        $AsJson = $false
        . ([scriptblock]::Create($FnText))
        Write-ColorOutput 'PROGRESS-U266-标记串' 'Yellow'
        [pscustomobject]@{ contract = 'engine/1'; engine = 'Probe'; results = @() }
    }).AddArgument($fnText)
$out = @($ps.Invoke())
$err = @($ps.Streams.Error | ForEach-Object { [string]$_ })
$ps.Dispose(); $pool.Close(); $pool.Dispose()

$strings = @($out | Where-Object { $_ -is [string] })
$objects = @($out | Where-Object { $_ -isnot [string] })
$result = [ordered]@{
    redirected      = [bool][Console]::IsOutputRedirected
    functionText    = $fnText
    outputCount     = $out.Count
    stringOutputs   = $strings.Count
    objectOutputs   = $objects.Count
    pollutions      = $strings.Count
    progressInStdout = [bool](@($strings | Where-Object { $_ -like '*PROGRESS-U266*' }).Count -gt 0)
    # 生产口径：`ConvertTo-EngineEnvelope` 拿到的就是这整个集合。集合不是"恰好一个封套" ⇒ 判 engine/0。
    envelopeIntact  = ($out.Count -eq 1 -and $out[0] -isnot [string] -and $out[0].contract -eq 'engine/1')
    errorStream     = $err
}
$result | ConvertTo-Json -Depth 4 -Compress
