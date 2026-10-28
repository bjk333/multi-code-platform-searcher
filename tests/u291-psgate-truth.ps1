# tests/u291-psgate-truth.ps1 —— U-291 的数据面：把 publish-skill.ps1 的 `Test-PsGate`
#   用 AST 抠出来跑真值表（不执行发布主体）。结论必须与 tests/ps-gate.mjs 的 psGateVerdict 一致。
param([string]$SkillDir = '')
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
if (-not $SkillDir) { $SkillDir = (Resolve-Path (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '..')).Path }
$SkillDir = (Resolve-Path $SkillDir).Path
$pub = Join-Path $SkillDir 'scripts/publish-skill.ps1'
$ast = [System.Management.Automation.Language.Parser]::ParseFile($pub, [ref]$null, [ref]$null)
$fn = @($ast.FindAll({ $args[0] -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $args[0].Name -eq 'Test-PsGate' }, $true))[0]
if (-not $fn) { throw 'publish-skill.ps1 缺少 Test-PsGate（PS 套件的发布凭证判据）' }
. ([scriptblock]::Create($fn.Extent.Text))

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('u291-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$null = New-Item -ItemType Directory -Path $tmp -Force
function Put([string]$name, $obj) {
    $p = Join-Path $script:tmp $name
    if ($obj -is [string]) { [System.IO.File]::WriteAllText($p, $obj, (New-Object System.Text.UTF8Encoding($false))) }
    else { [System.IO.File]::WriteAllText($p, ($obj | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false))) }
    return $p
}
function NewGood {
    return [ordered]@{
        schema = 'mcps/ps-gate/1'; version = '1.2.3'
        runtime = 'PS 5.1.0 / Desktop'; runtimeMajor = 5; localOnly = $false
        passed = 12; failed = 0; skipped = 0; exitCode = 0; mismatch = $false
        finishedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        groups = @('test-dedup:PASS')
    }
}
function C([string]$id, [string]$path, [string]$ver = '') {
    $r = Test-PsGate -Path $path -Version $ver
    return [PSCustomObject]@{ id = $id; ok = [bool](-not $r); why = [string]$r }
}
$rows = @()
$rows += C 'missing' (Join-Path $tmp 'nope.json')
$rows += C 'bad-json' (Put 'bad.json' '{oops')
$g1 = NewGood; $g1.schema = 'x/1'
$rows += C 'bad-schema' (Put 'badschema.json' $g1)
$g2 = NewGood; $g2.Remove('failed')
$rows += C 'no-failed' (Put 'nofailed.json' $g2)
$g3 = NewGood; $g3.failed = 1
$rows += C 'failed' (Put 'failed.json' $g3)
$g4 = NewGood; $g4.exitCode = 1
$rows += C 'exit-nonzero' (Put 'exit1.json' $g4)
$g5 = NewGood; $g5.localOnly = $true
$rows += C 'local-only' (Put 'localonly.json' $g5)
$rows += C 'version-mismatch' (Put 'ok-mismatch.json' (NewGood)) '9.9.9'
$g6 = NewGood; $g6.finishedAt = (Get-Date).ToUniversalTime().AddHours(-30).ToString('yyyy-MM-ddTHH:mm:ssZ')
$rows += C 'stale' (Put 'stale.json' $g6)
$rows += C 'ok' (Put 'ok.json' (NewGood)) '1.2.3'
$g7 = NewGood; $g7.skipped = 2
$rows += C 'ok-skip' (Put 'okskip.json' $g7) '1.2.3'
[PSCustomObject]@{ ok = $true; rows = @($rows) } | ConvertTo-Json -Depth 5 -Compress
try { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue } catch { }
