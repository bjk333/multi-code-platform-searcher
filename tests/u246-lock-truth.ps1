# tests/u246-lock-truth.ps1 —— U-246 的数据面：把 publish-skill.ps1 里的 `Test-AuditLockActive`
#   用 AST 抠出来**单独跑真值表**（不执行发布器主体 —— 它有副作用）。
# 口径必须与 tests/audit-lock.mjs 逐字一致（两处实现、同一张真值表；谁改了判据，另一侧的门会红）。
param([string]$SkillDir = '')
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
if (-not $SkillDir) { $SkillDir = (Resolve-Path (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '..')).Path }
$SkillDir = (Resolve-Path $SkillDir).Path
$pub = Join-Path $SkillDir 'scripts/publish-skill.ps1'
if (-not (Test-Path -LiteralPath $pub)) { throw "not found: $pub" }
$ast = [System.Management.Automation.Language.Parser]::ParseFile($pub, [ref]$null, [ref]$null)
$fn = @($ast.FindAll({ $args[0] -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $args[0].Name -eq 'Test-AuditLockActive' }, $true))[0]
if (-not $fn) { throw 'publish-skill.ps1 缺少 Test-AuditLockActive（发布器见锁即拒的判据）' }
. ([scriptblock]::Create($fn.Extent.Text))   # 只定义函数，不执行发布流程

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('u246-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$null = New-Item -ItemType Directory -Path $tmp -Force
$rows = @()
function NewLock([string]$name, [string]$json) {
    $p = Join-Path $script:tmp $name
    [System.IO.File]::WriteAllText($p, $json, (New-Object System.Text.UTF8Encoding($false)))
    return $p
}
function Case([string]$id, [string]$path, [int]$staleSec = 1800) {
    $now = [datetime]::UtcNow
    $r = Test-AuditLockActive -LockPath $path -Now $now -StaleSec $staleSec
    return [PSCustomObject]@{ id = $id; active = [bool]$r; why = $(if ($r) { [string]$r.Why } else { '' }) }
}
$iso = { param([int]$minutesAgo) ([datetime]::UtcNow.AddMinutes(-$minutesAgo)).ToString('o') }

$rows += Case 'missing' (Join-Path $tmp 'nope.lock')
$rows += Case 'fresh-alive' (NewLock 'fresh.json' ("{`"version`":`"9.9.9`",`"pid`":$PID,`"startedAt`":`"$(& $iso 1)`"}"))
$rows += Case 'fresh-dead-pid' (NewLock 'dead.json' ("{`"version`":`"9.9.9`",`"pid`":999999,`"startedAt`":`"$(& $iso 1)`"}"))
$rows += Case 'stale-alive' (NewLock 'stale.json' ("{`"version`":`"9.9.9`",`"pid`":$PID,`"startedAt`":`"$(& $iso 120)`"}"))
$rows += Case 'bad-json' (NewLock 'bad.json' '{not json')
$rows += Case 'no-startedAt' (NewLock 'nostart.json' ("{`"version`":`"9.9.9`",`"pid`":$PID}"))

$out = [PSCustomObject]@{ ok = $true; rows = @($rows) }
$out | ConvertTo-Json -Depth 5 -Compress
try { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue } catch { }
