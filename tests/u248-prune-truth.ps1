# tests/u248-prune-truth.ps1 —— U-248 的数据面：把 publish-skill.ps1 的 `Remove-PublishResidue`
#   用 AST 抠出来，在**合成目录**上跑真值表（绝不动真实 A 副本）。
#   要证的是两件事：① 白名单内的会被删 ② 凭据/证据/工具一律不动。
param([string]$SkillDir = '', [string]$PubPath = '')
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
if (-not $SkillDir) { $SkillDir = (Resolve-Path (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '..')).Path }
$SkillDir = (Resolve-Path $SkillDir).Path
$pub = if ($PubPath) { $PubPath } else { Join-Path $SkillDir 'scripts/publish-skill.ps1' }
$ast = [System.Management.Automation.Language.Parser]::ParseFile($pub, [ref]$null, [ref]$null)
$fn = @($ast.FindAll({ $args[0] -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $args[0].Name -eq 'Remove-PublishResidue' }, $true))[0]
if (-not $fn) { throw 'publish-skill.ps1 缺少 Remove-PublishResidue' }
. ([scriptblock]::Create($fn.Extent.Text))

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('u248-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$null = New-Item -ItemType Directory -Path $tmp -Force
function Mk([string]$rel) {
    $p = Join-Path $script:tmp $rel
    $d = Split-Path -Parent $p
    if (-not (Test-Path -LiteralPath $d)) { $null = New-Item -ItemType Directory -Path $d -Force }
    [System.IO.File]::WriteAllText($p, 'x', (New-Object System.Text.UTF8Encoding($false)))
}
# 该删的（白名单内）
foreach ($p in @('reports/_tmp/a.json', '_verify/probe.txt', 'reports/gates/.cache/c.json', 'search_cache.json', 'SKILL.md.bak-fm')) { Mk $p }
# 绝不该删的
foreach ($p in @('.env', 'skill-assets.json', 'reports/gates/keep.md', 'reports/evidence-2026-10-20/x.json', 'tools/audit/audit-run.ps1', 'SKILL.md', 'tests/test-x.mjs', '说明书.md')) { Mk $p }
# U-255：**空的白名单目录**本身也是残留（对应真 A 上 `reports/_smoke-u240/{,agents,raw}`：
#   上一轮已经把文件删了，只剩空壳 ⇒ `$victims.Count -eq 0` 会提前 return，永远清不掉）。
$null = New-Item -ItemType Directory -Path (Join-Path $tmp 'reports\_empty\nested') -Force

function RelDirs([string]$base) {
    @(Get-ChildItem -LiteralPath $base -Recurse -Force -Directory -ErrorAction SilentlyContinue |
        ForEach-Object { $_.FullName.Substring($base.Length).TrimStart('\', '/').Replace('\', '/') } | Sort-Object)
}
function RelList([string]$base) {
    @(Get-ChildItem -LiteralPath $base -Recurse -Force -File -ErrorAction SilentlyContinue |
        ForEach-Object { $_.FullName.Substring($base.Length).TrimStart('\', '/').Replace('\', '/') } | Sort-Object)
}
# ---- 用例 1：不给源仓 ⇒ 纯白名单行为（U-248 原口径，5 删）----
$r1 = Remove-PublishResidue -TargetDir $tmp
$removed = @($r1.Removed)
$remain = RelList $tmp

# U-255：清理后**不得留下空目录壳**。★快照必须取在这里 —— veto 用例会重建 `reports/_tmp/a.json`，
#   取在它后面就只能看见"目录又有了"，看不见"目录本来已被清掉"。
$dirs = @(Get-ChildItem -LiteralPath $tmp -Recurse -Force -Directory -ErrorAction SilentlyContinue |
    ForEach-Object { $_.FullName.Substring($tmp.Length).TrimStart('\', '/').Replace('\', '/') } | Sort-Object)

# ---- 用例 1b（U-255）：**没有文件可删、只剩空壳**的路径（真 A 上 `reports/_smoke-u240` 的形态）----
#   第一版把空目录清理挂在 victims 上 ⇒ 这里 `$victims.Count -eq 0` 提前 return，空壳永远清不掉。
$null = New-Item -ItemType Directory -Path (Join-Path $tmp 'reports\_shell2\deep') -Force
$r1b = Remove-PublishResidue -TargetDir $tmp
$shell = [PSCustomObject]@{
    removed = @($r1b.Removed)
    removedDirs = @($r1b.RemovedDirs | Sort-Object)
    remainDirs = @(RelDirs $tmp)
}

# ---- 用例 2（U-254）：源仓也有的，即使命中白名单也不许删 ----
#   对应的真实形态：`reports/_verify-保留策略.md` 是裁决记录（SKILL.md 引用它），只是没进清单。
#   这里用 ASCII 路径复现同一形态：`reports/_tmp/a.json` 在源仓里也存在。
$canon = Join-Path ([System.IO.Path]::GetTempPath()) ('u248c-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$null = New-Item -ItemType Directory -Path (Join-Path $canon 'reports\_tmp') -Force
[System.IO.File]::WriteAllText((Join-Path $canon 'reports\_tmp\a.json'), 'y', (New-Object System.Text.UTF8Encoding($false)))
Mk 'reports/_tmp/a.json'          # 目标侧重建成"已存在"
$r2 = Remove-PublishResidue -TargetDir $tmp -CanonicalDir $canon
$veto = [PSCustomObject]@{ removed = @($r2.Removed | Sort-Object); skipped = @($r2.Skipped | Sort-Object); remain = @(RelList $tmp) }

# ---- 用例 3（U-292）：根级"已登记不随发"的文件必须退役，未登记的一律不动 ----
#   真实形态：A 副本的 `说明书.md`（源仓 10-28 / 46 KB，副本停在 10-20 / 19 KB）与
#   `stress-frontend-ui.ps1`（源仓 10-20 已删，副本还在）。U-279 只碰受管目录 ⇒ 这两个永远轮不到。
#   ★关键断言：**源仓也存在时照样退役**（"不随发"= 目标侧不该有，U-254 的否决权在这里是反的）。
$tmp3 = Join-Path ([System.IO.Path]::GetTempPath()) ('u292-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$null = New-Item -ItemType Directory -Path $tmp3 -Force
$canon2 = Join-Path ([System.IO.Path]::GetTempPath()) ('u292c-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$null = New-Item -ItemType Directory -Path $canon2 -Force
[System.IO.File]::WriteAllText((Join-Path $canon2 '说明书.md'), 'new', (New-Object System.Text.UTF8Encoding($false)))
function MkIn([string]$base, [string]$rel) {
    $p = Join-Path $base $rel
    $d = Split-Path -Parent $p
    if (-not (Test-Path -LiteralPath $d)) { $null = New-Item -ItemType Directory -Path $d -Force }
    [System.IO.File]::WriteAllText($p, 'x', (New-Object System.Text.UTF8Encoding($false)))
}
MkIn $tmp3 '说明书.md'
MkIn $tmp3 'stress-frontend-ui.ps1'
MkIn $tmp3 'notes.md'
MkIn $tmp3 '.env'
MkIn $tmp3 'skill-assets.json'
$r3 = Remove-PublishResidue -TargetDir $tmp3 -CanonicalDir $canon2 -NotShippedFiles @('说明书.md', 'stress-frontend-ui.ps1')
$notShipped = [PSCustomObject]@{
    retired      = @($r3.Retired | Sort-Object)
    remain       = @(RelList $tmp3)
    skipped      = @($r3.Skipped | Sort-Object)
}

$out = [PSCustomObject]@{ removed = @($removed | Sort-Object); remain = @($remain); dirs = @($dirs); shell = $shell; veto = $veto; notShipped = $notShipped; ok = $true }
$out | ConvertTo-Json -Depth 5 -Compress
try { Remove-Item -LiteralPath $canon -Recurse -Force -ErrorAction SilentlyContinue } catch { }
try { Remove-Item -LiteralPath $canon2 -Recurse -Force -ErrorAction SilentlyContinue } catch { }
try { Remove-Item -LiteralPath $tmp3 -Recurse -Force -ErrorAction SilentlyContinue } catch { }
try { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue } catch { }
