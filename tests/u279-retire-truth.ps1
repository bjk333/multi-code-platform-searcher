# tests/u279-retire-truth.ps1 —— U-279 的数据面：把 `Remove-PublishResidue` 用 AST 抠出来，
#   在**合成目标目录**上跑"退役"真值表（绝不动真实 A 副本 —— 真副本由发布时的 -WhatIf 预演，人工确认后才落）。
#   要证的是四件事：
#     ① 受管目录内、不在清单、非保护 ⇒ 退役（含整个 reports/ 树）；
#     ② 清单内的文件、根级散文件、不受管目录、保护名单 ⇒ 一个都不动；
#     ③ 没给清单（老调用/参数漏传）⇒ **不退役**（fail-closed：不猜）；
#     ④ `-WhatIf` 只打印不删。
param([string]$SkillDir = '', [string]$PubPath = '')
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
if (-not $SkillDir) { $SkillDir = (Resolve-Path (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '..')).Path }
$SkillDir = (Resolve-Path $SkillDir).Path
$pub = if ($PubPath) { $PubPath } else { Join-Path $SkillDir 'scripts/publish-skill.ps1' }
$ast = [System.Management.Automation.Language.Parser]::ParseFile($pub, [ref]$null, [ref]$null)
$fn = @($ast.FindAll({ $args[0] -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $args[0].Name -eq 'Remove-PublishResidue' }, $true))
if (-not $fn) { throw 'publish-skill.ps1 缺少 Remove-PublishResidue' }
. ([scriptblock]::Create($fn[0].Extent.Text))

function New-Case([string]$name) {
    $d = Join-Path ([System.IO.Path]::GetTempPath()) ('u279-' + $name + '-' + [guid]::NewGuid().ToString('N').Substring(0, 6))
    $null = New-Item -ItemType Directory -Path $d -Force
    $script:cur = $d
    return $d
}
function Mk([string]$rel, [string]$text = 'x') {
    $p = Join-Path $script:cur $rel
    $d = Split-Path -Parent $p
    if (-not (Test-Path -LiteralPath $d)) { $null = New-Item -ItemType Directory -Path $d -Force }
    [System.IO.File]::WriteAllText($p, $text, (New-Object System.Text.UTF8Encoding($false)))
}
function RelList([string]$base) {
    @(Get-ChildItem -LiteralPath $base -Recurse -Force -File -ErrorAction SilentlyContinue |
        ForEach-Object { $_.FullName.Substring($base.Length).TrimStart('\', '/').Replace('\', '/') } | Sort-Object)
}
function RelDirs([string]$base) {
    @(Get-ChildItem -LiteralPath $base -Recurse -Force -Directory -ErrorAction SilentlyContinue |
        ForEach-Object { $_.FullName.Substring($base.Length).TrimStart('\', '/').Replace('\', '/') } | Sort-Object)
}

$manifest = @('SKILL.md', 'lib/keeper.ps1', 'tests/keeper.test.mjs', 'tools/audit/parity-check.ps1')
$owned = @('lib', 'tests', 'tools', 'reports')

# ---------- 用例 1：主真值表 ----------
$t1 = New-Case 'main'
# 该留下的：清单内
foreach ($p in $manifest) { Mk $p }
# 该退役的：受管目录内、不在清单
foreach ($p in @('lib/old-engine.ps1', 'tests/gone.test.mjs', 'reports/gates/2019.log', 'reports/legacy-root.md', 'tools/audit/audit-old.ps1')) { Mk $p }
# 绝不能动的：保护名单（含"受管目录里的 .env"这一档）
foreach ($p in @('.env', 'skill-assets.json', 'lib/.env', 'lib/.gate-green.json')) { Mk $p }
# 绝不能动的：根级散文件（用户自己的东西）与不受管目录
foreach ($p in @('my-notes.md', 'stress-old.ps1', 'custom/stuff.txt')) { Mk $p }
# 白名单残留（与退役分支交叉：`reports/_*` 必须先按残留处理）
Mk 'reports/_tmp/scratch.json'

$r1 = Remove-PublishResidue -TargetDir $t1 -ManifestFiles $manifest -OwnedDirs $owned
$gone = RelList $t1
$t1retired = @($r1.Retired | Sort-Object)
$t1removed = @($r1.Removed | Sort-Object)

$out = [ordered]@{
    retired    = $t1retired
    removed    = $t1removed
    remain     = $gone
    dirs       = RelDirs $t1
    # 没给清单时：同样的目录，什么都不该退役
    noManifest = $null
    # 没给受管目录时：即便清单在，也不该退役
    noOwned    = $null
    whatIf     = $null
    protectedKept = $null
    perFile    = $null
}

# ---------- 用例 2：不给清单 ⇒ 不退役（fail-closed） ----------
$t2 = New-Case 'nomanifest'
foreach ($p in $manifest) { Mk $p }
foreach ($p in @('lib/old.ps1', 'reports/x.md')) { Mk $p }
$r2 = Remove-PublishResidue -TargetDir $t2 -OwnedDirs $owned
$out.noManifest = [ordered]@{ retired = @($r2.Retired).Count; remain = @(RelList $t2).Count }

# ---------- 用例 3：不给受管目录 ⇒ 不退役（清单不能单独当许可证） ----------
$t3 = New-Case 'noowned'
foreach ($p in $manifest) { Mk $p }
foreach ($p in @('lib/old.ps1', 'reports/x.md')) { Mk $p }
$r3 = Remove-PublishResidue -TargetDir $t3 -ManifestFiles $manifest
$out.noOwned = [ordered]@{ retired = @($r3.Retired).Count; remain = @(RelList $t3).Count }

# ---------- 用例 4：-WhatIf 只打印不删 ----------
$t4 = New-Case 'whatif'
Mk 'lib/old.ps1'
$r4 = Remove-PublishResidue -TargetDir $t4 -ManifestFiles $manifest -OwnedDirs $owned -WhatIf
$out.whatIf = [ordered]@{ retired = @($r4.Retired).Count; remain = @(RelList $t4).Count }

# ---------- 用例 5：受管目录里的保护名单文件不许被退役（按**文件名**判，不只按整路径） ----------
$t5 = New-Case 'protect'
Mk 'lib/.env'
Mk 'lib/skill-assets.json'
Mk 'lib/old.ps1'
$r5 = Remove-PublishResidue -TargetDir $t5 -ManifestFiles $manifest -OwnedDirs $owned
$out.protectedKept = @(RelList $t5 | Where-Object { $_ -like 'lib/*' })

# ---------- 用例 6：逐文件判，不是逐目录判 ----------
#   清单里**列了** `reports/keep.md` ⇒ 它必须活；同目录其它文件仍退役。
#   这条防的是"图省事按目录整棵删"（那会把将来真要发一份样本报告的可能性直接掐死）。
$t6 = New-Case 'perfile'
Mk 'reports/keep.md'
Mk 'reports/other.md'
$r6 = Remove-PublishResidue -TargetDir $t6 -ManifestFiles @('reports/keep.md') -OwnedDirs $owned
$out.perFile = [ordered]@{ retired = @($r6.Retired); remain = @(RelList $t6) }

$out | ConvertTo-Json -Depth 6 -Compress
