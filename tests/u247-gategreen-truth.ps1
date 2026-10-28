# tests/u247-gategreen-truth.ps1 —— U-247 的数据面：把 publish-skill.ps1 的 `Test-GateGreen`
#   用 AST 抠出来跑真值表（不执行发布主体）。结论必须与 tests/gate-green.mjs 的 gateGreenVerdict 一致。
param([string]$SkillDir = '')
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
if (-not $SkillDir) { $SkillDir = (Resolve-Path (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '..')).Path }
$SkillDir = (Resolve-Path $SkillDir).Path
$pub = Join-Path $SkillDir 'scripts/publish-skill.ps1'
$ast = [System.Management.Automation.Language.Parser]::ParseFile($pub, [ref]$null, [ref]$null)
$fn = @($ast.FindAll({ $args[0] -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $args[0].Name -eq 'Test-GateGreen' }, $true))[0]
if (-not $fn) { throw 'publish-skill.ps1 缺少 Test-GateGreen（带红不许发布的判据）' }
. ([scriptblock]::Create($fn.Extent.Text))

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('u247-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$null = New-Item -ItemType Directory -Path $tmp -Force
function Put([string]$name, $obj) {
    $p = Join-Path $script:tmp $name
    if ($obj -is [string]) { [System.IO.File]::WriteAllText($p, $obj, (New-Object System.Text.UTF8Encoding($false))) }
    else { [System.IO.File]::WriteAllText($p, ($obj | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false))) }
    return $p
}
function NewGood {
    return [ordered]@{
        schema = 'mcps/gate-green/1'; version = '1.2.3'; versionAtStart = '1.2.3'; versionAtEnd = '1.2.3'
        runMode = 'serial'; productRed = 0; metaRed = 0; envRed = 0; voided = $false
    }
}
function C([string]$id, [string]$path, [string]$ver = '') {
    $r = Test-GateGreen -Path $path -Version $ver
    return [PSCustomObject]@{ id = $id; ok = [bool](-not $r); why = [string]$r }
}
$rows = @()
$rows += C 'missing' (Join-Path $tmp 'nope.json')
$g1 = NewGood; $g1.schema = 'x/1'
$rows += C 'bad-schema' (Put 'badschema.json' $g1)
$g2 = NewGood; $g2.productRed = 2
$rows += C 'product-red' (Put 'red.json' $g2)
$g2b = NewGood; $g2b.metaRed = 1
$rows += C 'meta-red' (Put 'meta.json' $g2b)
$g2c = NewGood; $g2c.Remove('metaRed')
$rows += C 'meta-missing' (Put 'nometa.json' $g2c)
$g3 = NewGood; $g3.voided = $true
$rows += C 'voided' (Put 'void.json' $g3)
$g4 = NewGood; $g4.runMode = 'parallel'
$rows += C 'parallel' (Put 'par.json' $g4)
$g5 = NewGood; $g5.versionAtEnd = '9.9.9'
$rows += C 'version-drift' (Put 'drift.json' $g5)
$rows += C 'version-mismatch' (Put 'ok.json' (NewGood)) '9.9.9'
$rows += C 'ok-serial' (Put 'ok2.json' (NewGood)) '1.2.3'
$g6 = NewGood; $g6.runMode = 'parallel+serial-recheck'
$rows += C 'ok-recheck' (Put 'ok3.json' $g6) '1.2.3'
$rows += C 'bad-json' (Put 'bad.json' '{oops')
[PSCustomObject]@{ ok = $true; rows = @($rows) } | ConvertTo-Json -Depth 5 -Compress
try { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue } catch { }
