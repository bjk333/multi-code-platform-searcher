# tests/u295-param-truth.ps1 —— U-295 的 PS 侧数据面：把 `run-tests.ps1` 的 `Compare-ParamSurface`
#   用 AST 抠出来，跑 ① 合成用例（由 Node 侧提供，用于**跨实现等价性**断言）② 真仓现状（param 块 vs 参数速查表格）。
#
# 为什么要这个 harness（而不是只留 Node 门）：
#   同一条规则现在有两处实现 —— run-tests.ps1 的 9d（PS，随包发货、不依赖 node）与 U-295（JS）。
#   "同一份事实写两处 ⇒ 必须单源 + 守卫"（项目纪律 #11）在这里的落地方式是：**同一批输入喂两边，判定必须逐条相同**。
#   少了这一步，两边一旦漂移，9d 会在 PS 套件里绿、U-295 会在 Node 门里绿，而两边量的其实不是同一件事。
#
# 变异能力：`-RunTestsPath` 可指向**被改坏**的副本（拆掉差集、把 -notcontains 改成 -contains 等），
#   用来证明 9d 用的这条判据不是恒绿装饰（见 test-u295-param-surface.test.mjs 的 A-neg / D 层）。
param([string]$SkillDir = '', [string]$RunTestsPath = '', [string]$CasesJson = '')
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
if (-not $SkillDir) { $SkillDir = (Resolve-Path (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '..')).Path }
$SkillDir = (Resolve-Path $SkillDir).Path
$rt = $RunTestsPath
if (-not $rt) { $rt = Join-Path $SkillDir 'tests/run-tests.ps1' }
$ast = [System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path $rt).Path, [ref]$null, [ref]$null)
$fn = @($ast.FindAll({ $args[0] -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $args[0].Name -eq 'Compare-ParamSurface' }, $true))[0]
if (-not $fn) { throw 'run-tests.ps1 缺少 Compare-ParamSurface（9d 的集合判据被删了？）' }
. ([scriptblock]::Create($fn.Extent.Text))

# 真仓现状：与 9d 完全同口径地抽两侧名字（另写一遍不是重复实现，是**独立取样**：
#   若 9d 的取样正则与这里不一致，两边读数必然对不上，等价性断言会立刻炸出来）。
$mainPath = Join-Path $SkillDir 'multi-platform-searcher.ps1'
$mainText = [System.IO.File]::ReadAllText($mainPath)
$pStart = ([regex]::Match($mainText, '(?m)^param\(')).Index
if ($pStart -lt 0) { throw '找不到行首 param(' }
$pEnd = $mainText.IndexOf("`n)", $pStart)
$pRegion = $mainText.Substring($pStart, $pEnd - $pStart)
$declared = @()
foreach ($pl in ($pRegion -split "`n")) {
    $d = $pl.IndexOf('$')
    if ($d -lt 0) { continue }
    $name = ''
    for ($j = $d + 1; $j -lt $pl.Length; $j++) {
        $c = $pl[$j]
        if ([char]::IsLetterOrDigit($c) -or $c -eq '_') { $name += $c } else { break }
    }
    if ($name) { $declared += $name }
}
$bt = [string][char]96
$docText = [System.IO.File]::ReadAllText((Join-Path $SkillDir 'references/参数速查.md'))
$documented = @([regex]::Matches($docText, ('(?m)^\|\s*' + [regex]::Escape($bt) + '-([A-Za-z0-9]+)' + [regex]::Escape($bt))) | ForEach-Object { $_.Groups[1].Value })
$realCmp = Compare-ParamSurface -Declared $declared -Documented $documented

$rows = @()
if ($CasesJson) {
    $cases = @([System.IO.File]::ReadAllText($CasesJson) | ConvertFrom-Json)
    foreach ($c in $cases) {
        $r = Compare-ParamSurface -Declared @($c.declared) -Documented @($c.documented)
        $rows += [PSCustomObject]@{
            id         = [string]$c.id
            ok         = [bool]$r.Ok
            declared   = [int]$r.Declared
            documented = [int]$r.Documented
            missing    = @($r.Missing)
            extra      = @($r.Extra)
        }
    }
}

[PSCustomObject]@{
    ok   = $true
    rows = $rows
    real = [PSCustomObject]@{
        declared   = @($realCmp.Declared)
        documented = @($realCmp.Documented)
        ok         = [bool]$realCmp.Ok
        missing    = @($realCmp.Missing)
        extra      = @($realCmp.Extra)
        declaredNames   = @($declared)
        documentedNames = @($documented)
    }
} | ConvertTo-Json -Depth 6 -Compress
