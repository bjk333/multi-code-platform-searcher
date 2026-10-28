# tests/u292-literal-nl-truth.ps1 —— U-292 的数据面之一：把 `run-tests.ps1` 的
#   `Test-LiteralNewlineArtifact` 用 AST 抠出来，在**给定行集**上跑真值表（绝不执行主套件）。
#
# 要证的两件事（双向）：
#   ① 正文里的字面"反斜杠+n"仍被判红（真损伤逮得住）；
#   ② 行内 `代码段` 与围栏代码块里的同形字符不算（描述正则不再被判红）。
# 变异能力：`-RunTestsPath` 可指向**被改坏**的副本，用来证明这两条判据不是摆设（见 test-u292）。
param([string]$SkillDir = '', [string]$RunTestsPath = '')
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
if (-not $SkillDir) { $SkillDir = (Resolve-Path (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '..')).Path }
$SkillDir = (Resolve-Path $SkillDir).Path
$rt = if ($RunTestsPath) { $RunTestsPath } else { Join-Path $SkillDir 'tests/run-tests.ps1' }
$ast = [System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path $rt).Path, [ref]$null, [ref]$null)
$fn = @($ast.FindAll({ $args[0] -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $args[0].Name -eq 'Test-LiteralNewlineArtifact' }, $true))[0]
if (-not $fn) { throw 'run-tests.ps1 缺少 Test-LiteralNewlineArtifact' }
. ([scriptblock]::Create($fn.Extent.Text))

$bs = [char]92; $bt = [char]96
$A = [string]$bs + 'n'                    # 字面两个字符
$fence = ([string]$bt) * 3

$rows = @()
function Case([string]$id, [string[]]$lines, [int]$expect) {
    $h = @(Test-LiteralNewlineArtifact -Lines $lines)
    $script:rows += [PSCustomObject]@{ id = $id; hits = $h.Count; expect = $expect; ok = ($h.Count -eq $expect) }
}
Case 'prose-artifact'  @('# 标题', ('正文断了' + $A + '这里还接着')) 1
Case 'codespan-ok'     @(('正则 `' + $bs + 'r?' + $A + '` 生效')) 0
Case 'fence-ok'        @($fence, ('a' + $A + 'b'), $fence) 0
Case 'two-artifacts'   @(($A + 'x'), ('y' + $A)) 2
Case 'clean-doc'       @('# 标题', '普通一行', ('代码 `' + $bs + 'd` 结束')) 0

# 真仓当前文件的两向核对：① 现文件必须干净（0 命中）② 在同一份内容里插一条正文工件必须红
$skill = Join-Path $SkillDir 'SKILL.md'
$real = @()
if (Test-Path -LiteralPath $skill) {
    $lines = [System.IO.File]::ReadAllLines($skill)
    $realHits = @(Test-LiteralNewlineArtifact -Lines $lines)
    $mut = @($lines)
    $ins = [Math]::Min(10, $mut.Count)          # 插在正文靠前处（frontmatter 之后通常仍有正文）
    $mut = @($mut[0..($ins - 1)]) + @('这一段是被人为破坏的' + $A + '换行') + @($mut[$ins..($mut.Count - 1)])
    $mutHits = @(Test-LiteralNewlineArtifact -Lines $mut)
    $real = [PSCustomObject]@{ file = 'SKILL.md'; lines = $lines.Count; hits = $realHits.Count; injectedHits = $mutHits.Count }
}

[PSCustomObject]@{ ok = $true; rows = $rows; real = $real } | ConvertTo-Json -Depth 5 -Compress
