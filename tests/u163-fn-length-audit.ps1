# U-163（2026-10-04）：AST 函数体长度审计 —— 把「函数体 >100 行」从"验收时人工重取"变成**常驻门**。
#   背景：任务书通则 #1 要求「改完重取 AST（防 >100 回潮）」，但本仓一直没有这条门 ⇒ 回潮只能靠人记得。
#   本脚本只做**测量**（不判定），判定在 tests/test-u163-fn-length-gate.test.mjs。
#   技法与 tests/u100-d1-exit-audit.ps1 同源（[System.Management.Automation.Language.Parser]::ParseFile）。
param(
    [Parameter(Mandatory = $true)][string]$Path,
    [int]$Limit = 100,
    # U-165（2026-10-04）：-Names 让门能**按名字**量到函数，而不是靠 top5 撞上。
    #   原判据 4「只对出现在 top5 的函数断言」在实践中一条都没断言到 ⇒ 近乎空转。
    #   ★用 [string] + 脚本内 -split ','，**不用 [string[]]**：`pwsh -File` 不按逗号拆数组参数
    #   （传 `[string[]]` 会把 "a,b,c" 收成**一个**元素；报"无法绑定到数组类型"或静默只量到一个）。
    [string]$Names = ''
)
$ErrorActionPreference = 'Stop'
$nameList = if ($Names) { @($Names -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ }) } else { @() }
if (-not (Test-Path -LiteralPath $Path)) { throw "not found: $Path" }

# U-165：-Path 可以是**目录** ⇒ 一次进程扫全部 *.ps1（engines/ 有 19 个文件，逐文件起进程太慢）
$files = if (Test-Path -LiteralPath $Path -PathType Container) {
    @(Get-ChildItem -LiteralPath $Path -Filter '*.ps1' -File | Sort-Object Name)
} else { @(Get-Item -LiteralPath $Path) }

$rows = @()
$errs = @()
foreach ($f in $files) {
    $t = $null; $e = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$t, [ref]$e)
    if (@($e).Count -gt 0) { $errs += [PSCustomObject]@{ file = $f.Name; parseErrors = @($e).Count } }
    foreach ($fn in @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true))) {
        if ($null -eq $fn.Body) { continue }                     # 无 body（声明型）不计长度
        $a = $fn.Extent.StartLineNumber
        $b = $fn.Body.Extent.EndLineNumber
        $rows += [PSCustomObject]@{ file = $f.Name; name = $fn.Name; start = $a; bodyLines = ($b - $a + 1) }
    }
}
$over = @($rows | Where-Object { $_.bodyLines -gt $Limit } | Sort-Object bodyLines -Descending)
$named = @()
foreach ($n in $nameList) {
    $hit = @($rows | Where-Object { $_.name -eq $n })
    $named += [PSCustomObject]@{ name = $n; found = ($hit.Count -gt 0); bodyLines = $(if ($hit.Count) { $hit[0].bodyLines } else { -1 }) }
}
[PSCustomObject]@{
    path        = $Path
    files       = $files.Count
    limit       = $Limit
    parseErrors = @($errs | ForEach-Object { $_.parseErrors } | Measure-Object -Sum).Sum
    parseErrorFiles = @($errs)
    functions   = $rows.Count
    over100     = $over.Count
    over        = @($over | ForEach-Object { [PSCustomObject]@{ name = $_.name; file = $_.file; start = $_.start; bodyLines = $_.bodyLines } })
    named       = $named
    top5        = @($rows | Sort-Object bodyLines -Descending | Select-Object -First 5)
} | ConvertTo-Json -Compress -Depth 6
