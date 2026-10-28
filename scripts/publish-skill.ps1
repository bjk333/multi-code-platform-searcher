[CmdletBinding()]
param(
    [string]$AssetName = 'multi-code-platform-searcher',
    [string]$WorkspaceRoot,
    [string]$Version,
    [switch]$NoUserLevel,
    [switch]$WhatIf,
    # U-46（R16 Wave A，2026-09-26）：清单/镜像单源化。
    #   -RegenerateMirror     ：从已入库的根清单 <workspace>\skill-assets.json 再生成 <canonical>\reports\_skill-assets.root.json（M-15 门的比对镜像，
    #                          被 .gitignore 刻意忽略 ⇒ 新克隆必须能再生成，否则跑不了 M-15 门）。只读根清单，不发布、不改哈希。
    #   -SyncExampleFromMirror：把 scripts\skill-assets.example.json 的 fileHashes 路径集从镜像**派生**（哈希留空，发布器回填），
    #                          让"示例清单 vs 镜像"这对事实只有一处手写来源。两开关均在做完动作后 exit 0，不进入发布流程。
    [switch]$RegenerateMirror,
    [switch]$SyncExampleFromMirror,
    # Tier1-3（v1.52.0）：预检发现"符合收录形态但不在清单"的文件时，显式放行并自动登记（空哈希由本次发布回填）。
    [switch]$RegisterMissing,
    # U-246（v1.53.26）：测量与发布互斥 —— 默认见 .audit-lock 即拒；此开关只给"确认无人在测"的紧急情形，
    #   生效时会在输出里留痕（发布产物与证据的时间关系因此不再自证，需人工记录原因）。
    [switch]$IgnoreAuditLock,
    # U-247（v1.53.26，B1-4 前半）：**带红不许发布**。默认必须存在一份可复核的 `.gate-green.json`；
    #   -SkipGateGreen 只给"今天就要发、红已确认与本次改动无关"的紧急情形，生效时留痕。
    [switch]$SkipGateGreen,
    # U-248（v1.53.26，B1-4 后半）：发布后清**白名单内的残留**（下划线临时物/_verify/.cache/search_*.json/*.bak-*）。
    #   ★只删白名单，**绝不按"target − manifest"反删** —— 2026-10-25 盘点实测：A 副本 915 个 extra 里
    #     `.env`（用户凭据）与 886 份 reports 证据都在其中，反删会删凭据与证据。默认开启，-NoPrune 关闭。
    [switch]$NoPrune,
    # U-249（v1.53.26，B1-4 收口）：**只盖戳，不发布** —— 计算当前字节的哈希、回写根清单与镜像、同步示例清单版本，
    #   然后立刻退出；**不复制任何文件到 target、不写 target 侧的 skill-assets.json、不写 Statement、不 Prune**。
    #
    #   为什么必须存在这个开关（U-139 的结构性死锁，2026-10-25 实测）：
    #     · `reports/_skill-assets.root.json`（镜像）是**根清单的镜像**，而根清单只在发布流程的第 8 步才回写；
    #     · U-139 要求「镜像里的非空哈希 == 当前字节」且「镜像 version == $VERSION」；
    #     · 于是"改了树但还没发布"时 U-139 **必然红** ⇒ `product_red ≠ 0` ⇒ U-247 的 gate-green 拒发 ⇒ **永远发不出去**。
    #   这不是门写错了，是"发布前必须绿"与"绿要求先发布"撞在一起。解法只有一个：把"盖戳"从"发布"里拆出来，
    #   让它在不碰目标目录的前提下单独可执行 —— 即本开关。它**不产生任何对外可见的变化**（A 副本一个字节都不动），
    #   只让清单/镜像承认"当前这棵树是什么"。
    #
    #   ★它**刻意绕过** U-246 的锁与 U-247 的 gate-green：这两道门防的是"带红发布"，而本开关**不发布**。
    #     绕过的代价必须可见 —— 生效时无条件打印一行（见下方），且门 U-249 会断言"这条路径确实不写 target"。
    [switch]$StampOnly
)

<#
.SYNOPSIS
    从 canonical 目录发布技能到所有部署副本与用户级真实加载路径。
.DESCRIPTION
    - 读取 workspace 根目录下的 skill-assets.json（UTF-8 BOM 安全读取）。
    - 将 asset.fileHashes 中列出的静态文件同步到：
        * skill-assets.json 中声明的 deploymentCopies（相对 workspace 根）
        * 用户级真实加载路径 $env:USERPROFILE\.workbuddy\skills\<AssetName>（默认开启）
    - 仅复制清单中列出的文件，绝不删除目标目录中的任何文件（运行时产物
      search_cache.json / run.log / _user_meta.json / plan_custom_model_eval.json 自然保留）。
    - 重算每个文件的 SHA-256 并写回 skill-assets.json（保持 UTF-8 BOM）。
    用法：
      .\scripts\publish-skill.ps1                 # 发布到 .trae/optimized + 用户级
      .\scripts\publish-skill.ps1 -WhatIf         # 仅预览，不写文件
      .\scripts\publish-skill.ps1 -Version 1.7.2  # 发布并 bump 版本号
#>

$ErrorActionPreference = 'Stop'

# ---- 解析 workspace 根目录（脚本位于 <workspace>\multi-code-platform-searcher\scripts\）----
if (-not $WorkspaceRoot) {
    if ($PSScriptRoot) { $WorkspaceRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot) }
    if (-not $WorkspaceRoot -and $PSCommandPath) { $WorkspaceRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath) }
    if (-not $WorkspaceRoot) { $WorkspaceRoot = (Get-Location).Path }
}
$WorkspaceRoot = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($WorkspaceRoot)

$manifestPath = Join-Path $WorkspaceRoot 'skill-assets.json'
if (-not (Test-Path $manifestPath)) {
    # v1.36.3（P0-3）：缺清单时给出可执行的指引，而不是裸 throw（此前任何调用都直接崩，"多副本同步"链路断裂且原因不明）
    $example = Join-Path (Split-Path -Parent $PSCommandPath) 'skill-assets.example.json'
    Write-Host "找不到清单文件: $manifestPath" -ForegroundColor Red
    Write-Host "  · 本脚本只应在 canonical 工作区运行（清单位于 <workspace>\skill-assets.json）；" -ForegroundColor Yellow
    Write-Host "    用户级加载副本（~\.workbuddy\skills\<name>）本身就是发布目标，不应从这里发布。" -ForegroundColor Yellow
    Write-Host "  · 如确需新建清单：复制模板 $example 到 $manifestPath 并按实际路径修改，或用 -WorkspaceRoot 指向正确的工作区。" -ForegroundColor Yellow
    exit 2
}

# UTF-8 BOM 安全读取
$raw = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8
if ($raw.Length -gt 0 -and $raw[0] -eq [char]0xFEFF) { $raw = $raw.Substring(1) }
$manifest = $raw | ConvertFrom-Json

$asset = $manifest.assets | Where-Object { $_.name -eq $AssetName }
if (-not $asset) { throw "清单中找不到 asset: $AssetName" }

$canonicalDir = Join-Path $WorkspaceRoot $asset.canonicalPath
if (-not (Test-Path $canonicalDir)) { throw "canonical 目录不存在: $canonicalDir" }

# ---- U-246（v1.53.26，验收 B1-5 后半）：测量与发布互斥 ----
#   为什么要有：`product_red` / `gate-green.json` 都是"某一刻的树"的读数，而树在测量**过程中**可以变。
#   旧流程里没有任何东西阻止"一边测量一边发布" ⇒ 你无法回答"这份绿是哪棵树上的"。
#   判据（与 tests/audit-lock.mjs 同口径，别处不许再写一份）：
#     · 文件不存在 ⇒ 无锁；坏 JSON / 缺 startedAt ⇒ **当活**（fail-closed，读不懂就别让它过去）；
#     · startedAt 超龄（30min）或进程不在 ⇒ 死锁，可接管。
function Test-AuditLockActive {
    param([Parameter(Mandatory = $true)][string]$LockPath, [datetime]$Now = [datetime]::UtcNow, [int]$StaleSec = 1800)
    if (-not (Test-Path -LiteralPath $LockPath)) { return $null }
    $raw = ''
    try { $raw = [System.IO.File]::ReadAllText($LockPath, [System.Text.Encoding]::UTF8) } catch { return [PSCustomObject]@{ Version = $null; Pid = $null; StartedAt = $null; AgeSec = $null; Why = 'unreadable(fail-closed)' } }
    $j = $null
    try { $j = $raw | ConvertFrom-Json } catch { return [PSCustomObject]@{ Version = $null; Pid = $null; StartedAt = $null; AgeSec = $null; Why = 'unparsable(fail-closed)' } }
    $ver = [string]$j.version
    $pidNum = 0
    [void][int]::TryParse([string]$j.pid, [ref]$pidNum)
    $startedRaw = $j.startedAt
    if ($null -eq $startedRaw) { return [PSCustomObject]@{ Version = $ver; Pid = $pidNum; StartedAt = $null; AgeSec = $null; Why = 'no-startedAt(fail-closed)' } }
    # ★PS 7 的 ConvertFrom-Json 会把 ISO-8601 解成 [datetime]（v1.53.25 踩过）⇒ 两种形态都要接
    if ($startedRaw -is [datetime]) { $started = $startedRaw.ToUniversalTime() }
    else {
        $started = [datetime]::MinValue
        if (-not [datetime]::TryParse([string]$startedRaw, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind, [ref]$started)) {
            return [PSCustomObject]@{ Version = $ver; Pid = $pidNum; StartedAt = $startedRaw; AgeSec = $null; Why = 'bad-startedAt(fail-closed)' }
        }
        $started = $started.ToUniversalTime()
    }
    $age = ($Now.ToUniversalTime() - $started).TotalSeconds
    if ($age -ge $StaleSec) { return $null }
    $alive = $false
    if ($pidNum -gt 0) { try { $null = Get-Process -Id $pidNum -ErrorAction Stop; $alive = $true } catch { $alive = $false } }
    if (-not $alive) { return $null }
    return [PSCustomObject]@{ Version = $ver; Pid = $pidNum; StartedAt = $started.ToString('o'); AgeSec = [int]$age; Why = 'measuring' }
}
$auditLockPath = Join-Path $canonicalDir '.audit-lock'
$lockState = Test-AuditLockActive -LockPath $auditLockPath
if ($lockState -and -not $StampOnly) {
    $lockMsg = "[U-246] 拒绝发布：正在测量中（.audit-lock version=$($lockState.Version) pid=$($lockState.Pid) startedAt=$($lockState.StartedAt)）"
    if (-not $IgnoreAuditLock) { throw ($lockMsg + '；等测量结束，或确认无人在测后加 -IgnoreAuditLock（会在输出里留痕）') }
    Write-Warning ($lockMsg + ' —— -IgnoreAuditLock 已生效：本次发布的证据可能对应一个正在变动的树')
}
if ($lockState -and $StampOnly) {
    Write-Warning ("[U-249] -StampOnly 无视 .audit-lock（version=$($lockState.Version) pid=$($lockState.Pid)）—— 本开关不发布、不碰目标目录，只在磁盘上刷新清单/镜像；" +
        '但若有人在测量，他们量到的树会变，其读数因此不可引用')
}

# ---- U-247（v1.53.26，验收 B1-4 前半）：带红不许发布 —— `gate-green.json` 前置 ----
#   判据与 tests/gate-green.mjs 的 gateGreenVerdict **逐条对应**（两处实现、同一张真值表；U-247 B 层会逐行比对）：
#     缺文件/坏 JSON/缺字段 ⇒ 拒；product_red≠0 ⇒ 拒；**meta_red≠0 ⇒ 拒**；voided ⇒ 拒；
#     **run_mode=parallel ⇒ 拒**（并行绿不算绿）；versionAtStart≠versionAtEnd ⇒ 拒；-Version 给了但对不上 ⇒ 拒。
#   ★U-275（v1.57.0）：meta_red = "仓库记账/文档/度量自身要修"。它不是产品结论，但**也不是绿** ——
#     发布包里的清单、版本锚点、Statement、隐私文档都得是对的。缺字段同样拒：
#     没有 metaRed 的凭证产生于"还没有这一类"的版本，那一轮的 meta 红被记进了 product，数不可比。
#   ★抽成函数是为了"能被门用 AST 抠出来单跑真值表"（不执行发布主体）—— 与 U-246 的 Test-AuditLockActive 同法。
function Test-GateGreen {
    param([Parameter(Mandatory = $true)][string]$Path, [string]$Version = '')
    if (-not (Test-Path -LiteralPath $Path)) { return '没有 .gate-green.json（先跑一次全量门禁）' }
    $gg = $null
    try { $gg = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8) | ConvertFrom-Json } catch { return 'gate-green.json 不是合法 JSON' }
    if ([string]$gg.schema -ne 'mcps/gate-green/1') { return "schema 不认识（$($gg.schema)）" }
    if ($gg.voided) { return '该轮已作废（起止版本不一致）' }
    if ([int]$gg.productRed -ne 0) { return "product_red=$($gg.productRed)（必须为 0）" }
    # ★`[int]$null` 是 0 —— 不显式判空就会把"缺字段"读成"meta_red=0"（fail-open）。
    if ($null -eq $gg.metaRed) { return '凭证缺 metaRed 字段（老版本生成的凭证不可引用：那一轮 meta 红被记进了 product）' }
    if ([int]$gg.metaRed -ne 0) { return "meta_red=$($gg.metaRed)（必须为 0：文档/清单/记账同样要修）" }
    if ([string]$gg.runMode -eq 'parallel') { return 'run_mode=parallel —— 并行绿不算绿（没做过串行复核）' }
    if (([string]$gg.runMode -ne 'serial') -and ([string]$gg.runMode -ne 'parallel+serial-recheck')) { return "run_mode 不认识（$($gg.runMode)）" }
    if ([string]$gg.versionAtStart -ne [string]$gg.versionAtEnd) { return 'versionAtStart ≠ versionAtEnd' }
    if ($Version -and (([string]$gg.version -ne [string]$Version) -or ([string]$gg.versionAtEnd -ne [string]$Version))) { return "凭证版本 $($gg.version)/$($gg.versionAtEnd) ≠ 本次发布 $Version" }
    return $null
}
$ggProblem = Test-GateGreen -Path (Join-Path $canonicalDir '.gate-green.json') -Version ([string]$Version)
if ($ggProblem -and -not $StampOnly) {
    $ggMsg = "[U-247] 拒绝发布：$ggProblem"
    if (-not $SkipGateGreen) { throw ($ggMsg + '；如确认要带红发布，加 -SkipGateGreen 并在提交信息里写原因') }
    Write-Warning ($ggMsg + ' —— -SkipGateGreen 已生效：本次发布**没有**可复核的门禁凭证')
}
# ---- U-291（v1.71.0，2026-10-28 全量验收 F1）：**PS 套件也要有凭证** ----
#   病灶（本轮验收实证）：`Test-GateGreen` 只读 Node runner 写的 `.gate-green.json`，于是
#   **只被 PS 套件覆盖**的断言（文档卫生 `\n` 工件 / BOM / 注入 12e·12i / doctor C1..C5）红也能发布 ——
#   v1.70.0 就是带着 `test-docs` 红发出去的（SKILL.md 里的正则字面量，2026-10-26 引入）。
#   判据与 `tests/ps-gate.mjs` 的 psGateVerdict 逐条对应（两处实现、同一张真值表；U-291 B 层逐例比对）。
function Test-PsGate {
    param([Parameter(Mandatory = $true)][string]$Path, [string]$Version = '')
    if (-not (Test-Path -LiteralPath $Path)) { return '没有 .ps-gate.json（先跑一次 tests/run-tests.ps1 全量）' }
    $pg = $null
    try { $pg = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8) | ConvertFrom-Json } catch { return 'ps-gate.json 不是合法 JSON' }
    if ([string]$pg.schema -ne 'mcps/ps-gate/1') { return "schema 不认识（$($pg.schema)）" }
    # ★`[int]$null` 是 0 —— 不显式判空就会把"缺字段"读成"failed=0"（fail-open）。
    if ($null -eq $pg.failed) { return '凭证缺 failed 字段（fail-closed）' }
    if ([int]$pg.failed -ne 0) { return "PS 套件 failed=$($pg.failed)（必须为 0）" }
    if ($null -eq $pg.exitCode -or [int]$pg.exitCode -ne 0) { return "PS 套件 exitCode=$($pg.exitCode)（必须为 0）" }
    if ($pg.localOnly) { return '-LocalOnly 跑出来的凭证不能背书（只跑了快路径，契约/网络组没跑）' }
    if ($Version -and ([string]$pg.version -ne [string]$Version)) { return "PS 凭证版本 $($pg.version) ≠ 本次发布 $Version" }
    $pgAt = [datetime]::MinValue
    if (-not [datetime]::TryParse([string]$pg.finishedAt, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::AdjustToUniversal -bor [System.Globalization.DateTimeStyles]::AssumeUniversal, [ref]$pgAt)) {
        return 'finishedAt 不可解析'
    }
    if (((Get-Date).ToUniversalTime() - $pgAt.ToUniversalTime()).TotalHours -gt 24) { return 'PS 凭证超龄（>24h）' }
    return $null
}
$pgProblem = Test-PsGate -Path (Join-Path $canonicalDir '.ps-gate.json') -Version ([string]$Version)
if ($pgProblem -and -not $StampOnly) {
    $pgMsg = "[U-291] 拒绝发布：$pgProblem"
    if (-not $SkipGateGreen) { throw ($pgMsg + '；如确认要带红发布，加 -SkipGateGreen 并在提交信息里写原因') }
    Write-Warning ($pgMsg + ' —— -SkipGateGreen 已生效：本次发布**没有**可复核的 PS 套件凭证')
}
if ($StampOnly) {
    # 这一行是**绕过 U-246/U-247 的可见代价**：不打印就等于悄悄把两道门关了。
    Write-Host ('[U-249] -StampOnly：只刷新根清单/镜像的版本与哈希，随后退出。' +
        '不复制到 target、不写 target 侧 skill-assets.json、不写 Statement、不 Prune。' +
        '（跳过 U-246 锁与 U-247 gate-green 判据，因为本开关不发布；但仍需之后跑一次全量门禁并发布）') -ForegroundColor Cyan
}

# ---- U-248（v1.53.26，B1-4 后半）：发布副本的残留清理（**白名单式**）----
#   为什么不是"target − manifest"：2026-10-25 实测 A 副本 915 个 extra 里，
#     `.env`（用户凭据，1）、`reports/**` 证据（886）、`tools/audit/*`（疑似漏登记）都在其中 ——
#     反选式删除会删凭据与证据，并把"漏登记"静默成"没这个东西"。
#   只删四类**明确是临时物**的东西（与仓里 .gitignore 的口径同源）：
#     reports/_*/**（下划线前缀 = 本仓临时证据约定）、_verify/**、**/.cache/**、search_*.json、*.bak-*
#   两道护栏：① 命中保护名单（.env / skill-assets.json）即 throw；② 先打印将删清单与计数，再删。
#   U-254（2026-10-26，dry-run 抓到的真缺陷）：**源仓也有的，一律不删**。
#     2026-10-26 在真 A 副本上 dry-run 时，白名单 `^reports/_` 命中了 `reports/_verify-保留策略.md` ——
#     那不是临时物，是 T1-6/U-12 的**裁决记录**（SKILL.md 明写"M-14 条款以本文件为准"），
#     而且它**在源仓里存在**（只是没进清单 = 漏登记）。按旧白名单会被删掉 ⇒ 目标侧丢掉一份被引用的决策记录。
#     ★根因是白名单把 `reports/_*` 整个泛化了，而项目 `.gitignore` 只忽略 `reports/_*.txt` —— 规则本来更窄。
#     与其继续猜"哪些下划线是临时"，不如加一条否决权：**目标里有、源仓里也有 ⇒ 它不是残留**（是内容或漏登记），
#     跳过并告警（告警文案点明"疑似漏登记"，把人引向补清单而不是删文件）。
#     判据顺序硬性要求：**保护名单先判**（.env 即使源仓也有，也必须炸而不是被"源仓也有"豁免掉）。
#   U-279（v1.61.0，B3-8）：**退役** —— 清单不再发货的文件要从目标里撤下。
#     2026-10-27 实测 A 副本：manifest=308 / actual=1200 ⇒ extra **892**，其中 `reports/**` 880。
#     病因不是白名单太窄，而是发布只做"复制 + 覆盖"，**从不撤下已删文件** ⇒ 副本是历次发布的并集，
#     不是"这一版的安装"。后果不只是占空间：`--profile=installed` 跑的是另一套目录树（那两条记录类门
#     U-277/U-278 只能靠 skip 保命），"装好的副本 === 清单"这句话根本没法成立。
#     为什么仍不反选整棵树（U-248 的结论没变）：那会删 `.env`（凭据）与用户自己放进来的文件。
#     退役要**三条同时成立**（声明式，不猜）：
#       ① 落在**受管目录**内 —— 清单里出现的顶层目录 + 脚本里声明的 `reports`（随包不发证据）；
#          根级散文件**一律不碰**（用户会在安装目录里放自己的东西，这一档宁可留垃圾也不误删）；
#       ② 不在本轮清单里；
#       ③ 不在保护名单（`.env*` / 清单 / 凭证 / 运行期状态与缓存）。
#     安全性依据：受管目录里的东西都是**包自己的**（用户数据不会长在 tests/ 里），且 2026-10-27 抽样
#       核对 A 的 reports 副本与外部归档 sha256 **12/12 一致** ⇒ 删的是副本，不是孤本。
function Remove-PublishResidue {
    param(
        [Parameter(Mandatory = $true)][string]$TargetDir,
        [string]$CanonicalDir = '',
        [string[]]$ManifestFiles = @(),
        [string[]]$OwnedDirs = @(),
        # U-292（v1.72.0）：`$PUB_EXCLUDE_EXACT` 的**根级**键 —— 已登记"有意不随发"的文件。
        #   缺省空 = 老行为（根级一概不动），所以不带该参数的调用方（含既有真值表用例）语义不变。
        [string[]]$NotShippedFiles = @(),
        [switch]$WhatIf
    )
    $empty = [PSCustomObject]@{ Removed = @(); Retired = @(); Skipped = @(); RemovedDirs = @() }
    if (-not (Test-Path -LiteralPath $TargetDir)) { return $empty }
    $manifestSet = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($p in @($ManifestFiles)) { if ($p) { [void]$manifestSet.Add(([string]$p).Replace('\', '/')) } }
    $ownedSet = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($d in @($OwnedDirs)) { if ($d) { [void]$ownedSet.Add(([string]$d).Replace('\', '/').Trim('/')) } }
    $notShippedSet = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($p in @($NotShippedFiles)) { if ($p) { [void]$notShippedSet.Add(([string]$p).Replace('\', '/').Trim('/')) } }
    $victims = @()
    $retired = @()
    $skipped = @()
    foreach ($f in @(Get-ChildItem -LiteralPath $TargetDir -Recurse -Force -File -ErrorAction SilentlyContinue)) {
        $rel = $f.FullName.Substring($TargetDir.Length).TrimStart('\', '/').Replace('\', '/')
        $base = ($rel -split '/')[-1]
        # 保护名单按"整路径 + 文件名"两档判：`.env` 在根级，而 `tools/.env` 同样不能删。
        #   ★只收"删了会痛且不可再生成"的三类；`search_cache.json` / `source-health.json` 是运行期缓存，
        #     归残留白名单管（第一版把它们也列进来 ⇒ 白名单命中它们时直接 throw，U-248-B 当场红）。
        $isProtected =
            ($rel -in @('.env', 'skill-assets.json')) -or
            ($base -in @('.env', 'skill-assets.json', '.gate-green.json'))
        # ---- U-292（v1.72.0，全量验收 F3）：已登记"有意不随发"的**根级**文件 —— 目标侧的历史镜像必须退役 ----
        #   病灶（2026-10-28 全量验收实测）：`说明书.md` 在源仓明确不随发（U-39：与渐进式文档重复），
        #     但 A 副本里有一份**手工镜像**的旧版（19,016 B / 10-20，源仓 46,507 B / 10-28）——
        #     门读到的文档与仓内事实能差一个月。同一形态还有 `stress-frontend-ui.ps1`（源仓 10-20 已删）。
        #   为什么 U-279 帮不上：那条规则刻意只碰**受管目录内**的文件（`$rel -notmatch '/'` ⇒ continue），
        #     而这两个都在根级 ⇒ 永远轮不到；`publish` 又只 copy 不 delete。
        #   判据（四条，都是"宁可少删"的方向）：
        #     ① 名字必须在 `$PUB_EXCLUDE_EXACT` 登记过 —— 是人的判断，可审；不是按"源仓没有"猜的；
        #     ② **只在根级生效**（带目录的一律不走这条，缩小打击面）；
        #     ③ 保护名单优先（`.env` / `skill-assets.json` 命中即 throw，与其它白名单同款）；
        #     ④ **不看源仓是否存在** —— "不随发"的定义就是"目标侧不该有"，U-254 的否决权在这里是反的。
        if ($notShippedSet.Count -gt 0 -and $rel -notmatch '/' -and $notShippedSet.Contains($rel)) {
            if ($isProtected) { throw "[U-292] 保护名单被命中：$rel（绝不允许清理凭据/清单）" }
            $retired += [PSCustomObject]@{ Rel = $rel; Full = $f.FullName }
            continue
        }
        $allowed =
            ($rel -match '^reports/_') -or
            ($rel -eq '_verify' -or $rel -like '_verify/*') -or
            ($rel -like '*/.cache/*' -or $rel -like '.cache/*') -or
            ($rel -match '(^|/)search_[^/]*\.json$') -or
            ($rel -match '(^|/)[^/]*\.bak-[^/]*$')
        if ($allowed) {
            # 护栏只在"**白名单真的指到了受保护文件**"时触发 —— 那说明白名单本身被改坏了（变异会打到这里）
            if ($isProtected) { throw "[U-248] 保护名单被命中：$rel（绝不允许清理凭据/清单）" }
            # U-254 否决权：源仓也存在 ⇒ 不是残留（是内容/漏登记）。★必须排在保护名单之后（.env 仍要炸）。
            if ($CanonicalDir -and (Test-Path -LiteralPath (Join-Path $CanonicalDir $rel))) {
                $skipped += [PSCustomObject]@{ Rel = $rel; Full = $f.FullName }
                continue
            }
            $victims += [PSCustomObject]@{ Rel = $rel; Full = $f.FullName }
            continue
        }
        # ---- U-279 退役判定（上文的 ①②③）----
        if ($manifestSet.Count -eq 0 -or $ownedSet.Count -eq 0) { continue }   # 没清单/没受管目录 ⇒ 不猜
        if ($isProtected) { continue }
        if ($manifestSet.Contains($rel)) { continue }
        if ($rel -notmatch '/') { continue }                                    # 根级散文件不动
        if (-not $ownedSet.Contains(($rel -split '/')[0])) { continue }
        $retired += [PSCustomObject]@{ Rel = $rel; Full = $f.FullName }
    }
    if ($skipped.Count -gt 0) {
        Write-Host ("[U-254] 跳过 {0} 项（源仓也存在 ⇒ 疑似漏登记，不是残留；应补清单而非删文件）：" -f $skipped.Count) -ForegroundColor Yellow
        foreach ($s in ($skipped | Select-Object -First 10)) { Write-Host ("  ! " + $s.Rel) -ForegroundColor Yellow }
        if ($skipped.Count -gt 10) { Write-Host ("  … 其余 {0} 项" -f ($skipped.Count - 10)) -ForegroundColor Yellow }
    }
    if ($victims.Count -gt 0) {
        Write-Host ("[U-248] {0}残留 {1} 项（白名单：reports/_* · _verify · .cache · search_*.json · *.bak-*）：" -f $(if ($WhatIf) { '将清理' } else { '已清理' }), $victims.Count) -ForegroundColor Cyan
        foreach ($v in ($victims | Select-Object -First 10)) { Write-Host ("  - " + $v.Rel) -ForegroundColor DarkGray }
        if ($victims.Count -gt 10) { Write-Host ("  … 其余 {0} 项" -f ($victims.Count - 10)) -ForegroundColor DarkGray }
        if (-not $WhatIf) {
            foreach ($v in $victims) { try { Remove-Item -LiteralPath $v.Full -Force -ErrorAction Stop } catch { Write-Warning ("[U-248] 删除失败: " + $v.Rel + " — " + $_.Exception.Message) } }
        }
    }
    # ---- U-279：退役（清单里没有的受管文件）+ 残留，一起删；两者分开报数 ----
    #   U-292 补第 ④ 类：**根级 + 已登记不随发**的文件（说明书.md / stress-frontend-ui.ps1）。
    if ($retired.Count -gt 0) {
        Write-Host ("[U-279] {0}退役 {1} 项（受管目录内不在清单 / 根级已登记不随发；均非保护名单）：" -f $(if ($WhatIf) { '将' } else { '已' }), $retired.Count) -ForegroundColor Cyan
        # 按顶层目录汇总（880 个 reports 文件逐条打印没有信息量，只看前 3 条形态即可）
        foreach ($g in ($retired | Group-Object { ($_.Rel -split '/')[0] } | Sort-Object Count -Descending)) {
            Write-Host ("  - {0}/  {1} 项（例：{2}）" -f $g.Name, $g.Count, $g.Group[0].Rel) -ForegroundColor DarkGray
        }
        if (-not $WhatIf) {
            foreach ($v in $retired) { try { Remove-Item -LiteralPath $v.Full -Force -ErrorAction Stop } catch { Write-Warning ("[U-279] 删除失败: " + $v.Rel + " — " + $_.Exception.Message) } }
        }
    }
    # U-255（2026-10-26）：**空目录收尾**。三条教训都来自真 A 与 harness 的反复打脸：
    #   ① 必须跑在**删完文件之后** —— 第一版放在删除前，`_verify`/`reports/_tmp` 当时还有文件、判"非空"跳过，
    #      删完文件后就再没人管它们了（harness 的 dirs 快照当场抓到）；
    #   ② 必须与 **`$victims` 解耦** —— 第二版挂在 victims 的父目录上，而"上一轮已删完文件、只剩空壳"时
    #      `$victims.Count -eq 0` 提前 return，空壳永远清不掉（真 A 的 `reports/_smoke-u240/{,agents,raw}` 就是这个形态）；
    #   ③ 目录规则必须与**文件白名单同源** —— 文件含 `**/.cache/*`，目录漏了 `.cache`，`.cache` 空壳就留下来了。
    #   U-279 追加第 ④ 条：**退役后**的受管目录同样会留壳（`reports/` 清空后整棵树还在），规则必须一起放宽到受管目录。
    #   判据：自底向上（路径长度降序）；只收**真为空**的目录；非空立刻停（绝不为删目录去删文件）。
    $emptyDirs = @(Get-ChildItem -LiteralPath $TargetDir -Recurse -Force -Directory -ErrorAction SilentlyContinue |
        Where-Object {
            $rd = $_.FullName.Substring($TargetDir.Length).TrimStart('\', '/').Replace('\', '/')
            ($rd -match '^reports/_') -or $rd -eq '_verify' -or $rd -like '_verify/*' -or $rd -eq '.cache' -or $rd -like '*/.cache' -or
            # ★受管目录的**顶级**也要收（`reports/` 清空后它自己就没人管了；第一版只判 `$rd -match '/'`，实测漏掉）
            ($ownedSet.Count -gt 0 -and ($ownedSet.Contains($rd) -or ($rd -match '/' -and $ownedSet.Contains(($rd -split '/')[0]))))
        } | Sort-Object { $_.FullName.Length } -Descending)
    $removedDirs = @()
    foreach ($d in $emptyDirs) {
        if (-not (Test-Path -LiteralPath $d.FullName)) { continue }
        if (@(Get-ChildItem -LiteralPath $d.FullName -Force).Count -gt 0) { continue }
        $relD = $d.FullName.Substring($TargetDir.Length).TrimStart('\', '/').Replace('\', '/')
        if (-not $WhatIf) { try { Remove-Item -LiteralPath $d.FullName -Force -ErrorAction Stop } catch { continue } }
        $removedDirs += $relD
    }
    if ($removedDirs.Count -gt 0) {
        Write-Host ("[U-255] {0}空目录 {1} 个（白名单命名或受管目录下、已为空）：{2}" -f $(if ($WhatIf) { '将移除' } else { '已移除' }), $removedDirs.Count, (($removedDirs | Select-Object -First 5) -join ', ')) -ForegroundColor $(if ($WhatIf) { 'DarkGray' } else { 'Green' })
    }
    return [PSCustomObject]@{
        Removed    = @($victims | ForEach-Object { $_.Rel })
        Retired    = @($retired | ForEach-Object { $_.Rel })
        RemovedDirs = @($removedDirs)
        Skipped    = @($skipped | ForEach-Object { $_.Rel })
    }
}

# ---- Tier1-3（v1.52.0）：发布收口三件套抽成函数/预检 ----
#   动机（2026-10-22 v1.51.0 实测踩了三次）：发布顺序靠人记 ⇒ ① 新文件忘登记（A 副本拿不到，outputSchema 静默消失）；
#   ② SyncExample 改了清单内文件却没重算哈希 ⇒ U-139 漂移；③ 镜像没最后刷 ⇒ U-139 红。
#   处置：① 预检 fail-closed（下）；②③ 把"示例派生"挪到哈希之前、"镜像重生成"挪到发布最后 ⇒ 一条命令即正确顺序。

function Write-SkillMirror {
    param($ManifestObj, [string]$MirrorPath)
    New-Item -ItemType Directory -Path (Split-Path -Parent $MirrorPath) -Force | Out-Null
    # 镜像 = 根清单原样（含 fileHashes 与 sourceSha256），UTF-8 无 BOM、LF，便于 Node 门直接 JSON.parse
    $mirrorJson = ($ManifestObj | ConvertTo-Json -Depth 10) -replace "`r`n", "`n"
    [System.IO.File]::WriteAllText($MirrorPath, $mirrorJson + "`n", [System.Text.UTF8Encoding]::new($false))
    Write-Host ("[U-46] 镜像已再生成: {0}（{1} 条路径）" -f $MirrorPath, @($ManifestObj.assets[0].fileHashes.PSObject.Properties).Count) -ForegroundColor Green
}

function Sync-ExamplePathSet {
    # U-75（N-23）：**就地改写** —— 只重建 `"fileHashes": { … }` 块内的路径行，其余字节（键序、缩进、`_comment` 位置、非 ASCII、
    # 换行风格、BOM）一律不动；不再走 ConvertFrom/ConvertTo-Json（它会重排键、把 < > 转义成 <）。
    # 幂等由脚本自证：改写后再算一遍，第二遍结果必须与第一遍逐字节相同，否则 exit 3。
    # v1.52.0：抽出为函数 —— 发布路径在**哈希之前**调用它（示例改动自动进哈希），-SyncExampleFromMirror 仍可单独跑。
    param([string[]]$Paths, [string]$ExamplePath)
    $exBytes = [System.IO.File]::ReadAllBytes($ExamplePath)
    $exHasBom = ($exBytes.Length -ge 3 -and $exBytes[0] -eq 0xEF -and $exBytes[1] -eq 0xBB -and $exBytes[2] -eq 0xBF)
    $exText = [System.Text.Encoding]::UTF8.GetString($exBytes)
    if ($exHasBom) { $exText = $exText.Substring(1) }
    $nl = if ($exText.Contains("`r`n")) { "`r`n" } else { "`n" }
    function Sync-FileHashesBlock([string]$Text, [string[]]$Paths, [string]$Nl) {
        $m = [regex]::Match($Text, '(?s)("fileHashes"\s*:\s*\{)(?<body>.*?)(\r?\n)(?<indentClose>[ \t]*)\}')
        if (-not $m.Success) { throw '[U-75] 示例清单里找不到 "fileHashes": { … } 块' }
        $body = $m.Groups['body'].Value
        $existing = [regex]::Matches($body, '"(?<k>(?:[^"\\]|\\.)*)"\s*:\s*"(?<v>[^"]*)"') | ForEach-Object { $_.Groups['k'].Value }
        $indentM = [regex]::Match($body, '(?m)^([ \t]+)"')
        $indent = if ($indentM.Success) { $indentM.Groups[1].Value } else { $m.Groups['indentClose'].Value + '  ' }
        # 顺序：先保留示例里已有且仍在镜像中的路径（原序），再追加新增的（按给定顺序）；给定集合里没有的路径删除
        $ordered = @()
        foreach ($k in $existing) { if ($Paths -contains $k -and $ordered -notcontains $k) { $ordered += $k } }
        foreach ($k in $Paths) { if ($ordered -notcontains $k) { $ordered += $k } }
        $lines = @($ordered | ForEach-Object { '{0}"{1}": ""' -f $indent, $_ })
        $newBody = $Nl + ($lines -join (',' + $Nl))
        return $Text.Substring(0, $m.Groups['body'].Index) + $newBody + $Text.Substring($m.Groups['body'].Index + $m.Groups['body'].Length)
    }
    $pass1 = Sync-FileHashesBlock -Text $exText -Paths $Paths -Nl $nl
    $pass2 = Sync-FileHashesBlock -Text $pass1 -Paths $Paths -Nl $nl
    if ($pass1 -ne $pass2) { Write-Host '[U-75] 幂等自检失败：第二遍改写与第一遍不同' -ForegroundColor Red; exit 3 }
    $changed = ($pass1 -ne $exText)
    if ($changed) {
        $outBytes = [System.Text.Encoding]::UTF8.GetBytes($pass1)
        if ($exHasBom) { $outBytes = [byte[]](0xEF, 0xBB, 0xBF) + $outBytes }
        [System.IO.File]::WriteAllBytes($ExamplePath, $outBytes)
    }
    return $changed
}

function Sync-ExampleVersion {
    # v1.53.3（P1，实测）：`-Version` 此前只写根清单（下文 `$asset.version = $Version`），示例清单的
    #   version 靠手改 ⇒ 门 U-139 root version 要求「镜像+示例 version == 脚本 $VERSION」，下次全量必红。
    #   示例是**发布派生物**，版本应与本次发布同源。就地只替换 `"version"` 的值（该文件仅一处），
    #   键序 / 缩进 / 换行 / BOM 一律不动（与 Sync-ExamplePathSet 同一纪律）。
    #   调用点在"示例派生"之后、"复制+算哈希"之前 ⇒ 版本改动自动进本次哈希，不需要第二次 publish。
    param([string]$Version, [string]$ExamplePath)
    if ([string]::IsNullOrWhiteSpace($Version)) { return $false }
    $bytes = [System.IO.File]::ReadAllBytes($ExamplePath)
    $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
    $text = [System.Text.Encoding]::UTF8.GetString($bytes)
    if ($hasBom) { $text = $text.Substring(1) }
    $m = [regex]::Match($text, '"version"\s*:\s*"[^"]*"')
    if (-not $m.Success) { throw '[U-139] 示例清单里找不到 "version" 字段（无法同步发布版本）' }
    $replacement = '"version": "' + $Version + '"'
    # ★U-243 修复（2026-10-25 实测踩到）：这里原本是 `if ($m.Value -ceq $replacement) { return $false }`
    #   —— version 已经同步过时**直接早退**，把下面的 `_comment` 同步一起跳过。
    #   结果：第二次跑 publish 时 version 早已是目标值 ⇒ `_comment` 永远停在旧版本 ⇒ 门 U-75 恒红。
    #   "提前返回"在这种"一个函数管两个锚点"的场景里就是漏改的同义词，改成累计标记后统一返回。
    $vChanged = ($m.Value -cne $replacement)
    $newText = if ($vChanged) { $text.Substring(0, $m.Index) + $replacement + $text.Substring($m.Index + $m.Length) } else { $text }
    # U-243（v1.53.25）：`_comment` 前导版本号**也是**版本锚点。
    #   本文件第 151 行的注释一直声称会同步它，但实现只改了 `version` 字段 ⇒ 门 U-75 每批都红一次
    #   （v1.53.25 实测：示例 version 已是 1.53.25，`_comment` 仍停在 v1.53.24）。
    #   规则同本函数：只替换 `"_comment": "v<x.y.z>` 里那一个版本号，其余字节（含理由正文）一律不动。
    $cChanged = $false
    $cm = [regex]::Match($newText, '"_comment"\s*:\s*"v\d+\.\d+\.\d+')
    if ($cm.Success) {
        $cmNew = $cm.Value -replace 'v\d+\.\d+\.\d+$', ('v' + $Version)
        if ($cmNew -cne $cm.Value) {
            $newText = $newText.Substring(0, $cm.Index) + $cmNew + $newText.Substring($cm.Index + $cm.Length)
            $cChanged = $true
        }
    }
    if (-not ($vChanged -or $cChanged)) { return $false }
    $outBytes = [System.Text.Encoding]::UTF8.GetBytes($newText)
    if ($hasBom) { $outBytes = [byte[]](0xEF, 0xBB, 0xBF) + $outBytes }
    [System.IO.File]::WriteAllBytes($ExamplePath, $outBytes)
    return $true
}

function Sync-VersionAnchors {
    # v1.53.6（2026-10-23）：**把"只含版本号"的锚点自动化**。
    #   动机：v1.53.4 与 v1.53.5 连续两批都栽在 `$VERSION` 变量漏改（它是门 U-139
    #   `u139ScriptVersion()` 真正读的值），说明"8 处手工版本戳"靠人记不可行。
    #   范围（7 处，全部只含版本号、不含语义）：
    #     SKILL.md frontmatter / 主脚本 `$VERSION` / 主脚本第 1 行「当前 vX」/
    #     参数速查首行 / 引擎链首行 / 故障排查首行 / 说明书目录树「主脚本（vX」
    #   ★**不在**范围内（必须手写语义，写错了门也抓不住对错）：
    #     SKILL.md 基线行、主脚本第 2 行变更条目、变更历史「当前基线」行、example `_comment` 前缀。
    #   调用点必须在"复制+算哈希"**之前** ⇒ 改动进本次哈希；幂等（已是目标版本则逐字节不变）。
    #   定位策略是「先按 LineMatch 找行、再在该行内按 Replace 改」——**绝不全文批量替换**：
    #   正文里也常出现 `（v1.47.0）` 这类历史版本引用，全文替换会误伤。
    #   ★LineMatch 还必须能**区分模板占位符与真实实例**：说明书里同时存在
    #   「主脚本（vX；…」（文档约定，讲目录树格式）与「主脚本（v1.53.5；…」（实例行）；
    #   写成 `主脚本（v` 会先命中占位符 ⇒ 该行 Replace 不匹配 ⇒ **静默跳过且无告警**
    #   （本函数第一版即如此，靠发布输出里少了「说明书目录树」一项才发现）⇒ 收紧为 `主脚本（v[\d]+\.[\d]+`。
    param([string]$Version, [string]$CanonicalDir)
    if ([string]::IsNullOrWhiteSpace($Version)) { return @() }
    $jobs = @(
        @{ Rel = 'SKILL.md';                    LineMatch = '^\s*version:\s*"';                   Replace = '"[^"\r\n]*"';              With = '"' + $Version + '"';        Label = 'SKILL.md frontmatter'; Required = $true },
        @{ Rel = 'multi-platform-searcher.ps1'; LineMatch = '^\$VERSION\s*=\s*"';                  Replace = '"[^"\r\n]*"';              With = '"' + $Version + '"';        Label = '$VERSION 变量';        Required = $true },
        @{ Rel = 'multi-platform-searcher.ps1'; LineMatch = '^# Multi-Code-Platform Searcher';     Replace = '当前 v[\d]+\.[\d]+\.[\d]+'; With = '当前 v' + $Version;         Label = '主脚本第 1 行';        Required = $true },
        @{ Rel = 'references/参数速查.md';       LineMatch = '^# multi-code-platform-searcher 参数速查'; Replace = '（v[\d]+\.[\d]+\.[\d]+）';   With = '（v' + $Version + '）';      Label = '参数速查首行';          Required = $false },
        @{ Rel = 'references/引擎链.md';         LineMatch = '^# multi-code-platform-searcher 引擎链';   Replace = '（v[\d]+\.[\d]+\.[\d]+）';   With = '（v' + $Version + '）';      Label = '引擎链首行';            Required = $false },
        @{ Rel = 'references/故障排查.md';       LineMatch = '^# multi-code-platform-searcher 故障排查'; Replace = '（v[\d]+\.[\d]+\.[\d]+）';   With = '（v' + $Version + '）';      Label = '故障排查首行';          Required = $false },
        @{ Rel = '说明书.md';                    LineMatch = '主脚本（v[\d]+\.[\d]+';            Replace = '主脚本（v[\d]+\.[\d]+\.[\d]+'; With = '主脚本（v' + $Version;       Label = '说明书目录树';          Required = $false }
    )
    $done = @()
    foreach ($j in $jobs) {
        $path = Join-Path $CanonicalDir $j.Rel
        if (-not (Test-Path -LiteralPath $path)) {
            if ($j.Required) { throw "[U-227] 版本锚点必需文件缺失: $($j.Rel)" }
            Write-Warning "[U-227] 版本锚点跳过（文件不存在）: $($j.Label)"
            continue
        }
        $bytes = [System.IO.File]::ReadAllBytes($path)
        $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
        $text = [System.Text.Encoding]::UTF8.GetString($bytes)
        if ($hasBom) { $text = $text.Substring(1) }
        # U-255（2026-10-26）：换行风格改**多数决**。旧写法是 `if ($text.Contains("\r\n"))` —— 只要混进**一个**
        #   游离 CRLF（我编辑 SKILL.md 时手滑插了一个），整份 LF 文件就被按 CRLF 切 ⇒ 全文变"一行" ⇒
        #   frontmatter 的 version 锚点永远匹配不到，报「结构可能已变，必须人看」。文件其实没坏，是判据坏了。
        $crlfN = ([regex]::Matches($text, "`r`n")).Count
        $lfN = ([regex]::Matches($text, "`n")).Count
        $nl = if ($crlfN -gt 0 -and $crlfN * 2 -gt $lfN) { "`r`n" } else { "`n" }
        $lines = [System.Collections.ArrayList]::new()
        foreach ($l in $text.Split([string[]]@($nl), [System.StringSplitOptions]::None)) { [void]$lines.Add($l) }
        $idx = -1
        for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -match $j.LineMatch) { $idx = $i; break } }
        if ($idx -lt 0) {
            if ($j.Required) { throw "[U-227] 版本锚点定位失败（结构可能已变，必须人看）: $($j.Label) @ $($j.Rel)" }
            Write-Warning "[U-227] 版本锚点定位失败（跳过）: $($j.Label) @ $($j.Rel)"
            continue
        }
        $old = [string]$lines[$idx]
        $new = [regex]::Replace($old, $j.Replace, $j.With, 'None')
        if ($new -ceq $old) { continue }
        $lines[$idx] = $new
        $outText = [string]::Join($nl, $lines.ToArray())
        $outBytes = [System.Text.Encoding]::UTF8.GetBytes($outText)
        if ($hasBom) { $outBytes = [byte[]](0xEF, 0xBB, 0xBF) + $outBytes }
        [System.IO.File]::WriteAllBytes($path, $outBytes)
        $done += $j.Label
    }
    return $done
}

# ---- U-46：镜像再生成 / 示例清单派生（不发布）----
if ($RegenerateMirror -or $SyncExampleFromMirror) {
    # ★U-289（v1.70.0，实测撞出来的）：与 `-StampOnly` 同时用会**静默变成空操作**。
    #   本块位于「算哈希 / 回写根清单」**之前**，末尾直接 `exit 0` ⇒ 传了 `-StampOnly` 也一个哈希都不会算，
    #   而输出里三行绿字（镜像已再生成 / 示例已派生 / rc=0）看起来完全像成功。
    #   2026-10-27 实测：清单 version 仍是旧的、两个新门文件也没登记，直到手工逐项比对才发现（B3-17）。
    #   这两个动作有严格先后（先盖戳 → 再从**刚刷新**的镜像派生示例），合并语义只会猜错 ⇒ fail-closed 拒绝。
    if ($StampOnly) {
        throw ('[U-289] -StampOnly 不能与 -RegenerateMirror / -SyncExampleFromMirror 同时使用：' +
            '镜像/示例块在算哈希之前就 exit 0，-StampOnly 会静默变成空操作（看起来还全绿）。' +
            '正确顺序：① 先跑 `-StampOnly [-RegisterMissing] -Version X`（它会自己刷新镜像）；' +
            '② 再单独跑 `-SyncExampleFromMirror`（从刚刷新的镜像派生示例路径集）。')
    }
    $mirrorPath = Join-Path (Join-Path $canonicalDir 'reports') '_skill-assets.root.json'
    if ($RegenerateMirror) { Write-SkillMirror -ManifestObj $manifest -MirrorPath $mirrorPath }
    if ($SyncExampleFromMirror) {
        $examplePath = Join-Path (Split-Path -Parent $PSCommandPath) 'skill-assets.example.json'
        if (-not (Test-Path $mirrorPath)) { throw "[U-46] 镜像不存在，先跑 -RegenerateMirror: $mirrorPath" }
        $mirror = (Get-Content -LiteralPath $mirrorPath -Raw -Encoding UTF8) | ConvertFrom-Json
        $mAsset = $mirror.assets | Where-Object { $_.name -eq $AssetName }
        $mirrorPaths = @($mAsset.fileHashes.PSObject.Properties.Name)
        $changed = Sync-ExamplePathSet -Paths $mirrorPaths -ExamplePath $examplePath
        Write-Host ("[U-46] 示例清单路径集已从镜像派生: {0}（{1} 条；changed={2}；idempotent=True）" -f $examplePath, $mirrorPaths.Count, $changed) -ForegroundColor Green
    }
    exit 0
}

# ---- 目标目录 ----
$targets = @()
foreach ($dc in $asset.deploymentCopies) {
    $targets += Join-Path $WorkspaceRoot $dc
}
if (-not $NoUserLevel) {
    # 用户级真实加载路径（$Skill 工具实际加载处），默认同步，确保 Skill 加载到最新版；可用 -NoUserLevel 跳过
    $targets += Join-Path $env:USERPROFILE (".workbuddy\skills\$AssetName")
}

# 运行时产物（只复制清单文件，绝不删除这些）
$runtimeArtifacts = @('search_cache.json', 'run.log', '_user_meta.json', 'plan_custom_model_eval.json')

# v1.36.3（P0-3）：目标与 canonical 为同一目录时跳过（防止自拷贝 / 把自己当成发布目标）
$canonicalFull = [System.IO.Path]::GetFullPath($canonicalDir).TrimEnd('\', '/')
$targets = @($targets | Where-Object {
    $same = ([System.IO.Path]::GetFullPath($_).TrimEnd('\', '/') -ieq $canonicalFull)
    if ($same) { Write-Warning "目标与 canonical 相同，已跳过: $_" }
    -not $same
})

function Get-Sha256($filePath) {
    $algo = [System.Security.Cryptography.SHA256]::Create()
    $bytes = [System.IO.File]::ReadAllBytes($filePath)
    $hash = $algo.ComputeHash($bytes)
    ($hash | ForEach-Object { $_.ToString('x2') }) -join ''
}

# ---- Tier1-3 预检（fail-closed）：符合收录形态却不在清单的文件一律阻断，防止"新文件静默漏发" ----
#   有意不随发的文件必须登记进 $PUB_EXCLUDE_EXACT 并写 why —— 排除不留理由 = 下次没人敢删也不敢留。
$PUB_EXCLUDE_DIRS = @('reports', '_verify', '.git', 'node_modules', '__pycache__', '_archive', '_vendor', 'bin', '.workbuddy')
# U-243（v1.53.25）：`source-health.json` = **跨运行源健康记忆**（U-242）。
#   ★它是**每台机器各自的运行时状态**：里面记着"上一轮哪些源不可达"。
#   一旦随包发出去，用户首跑就会继承**发布者机器**的网络问题（实测本机 GitLab/HF/DockerHub 全是死的），
#   等于把"我这边连不上"伪装成"这个源坏了"。它同时也让 U-139 的哈希永远不稳（每轮都在变）。
#   同一类必须继续挡在门外的还有：缓存（search_cache.json）、用户元数据（_user_meta.json）。
$PUB_EXCLUDE_NAMES = @('search_cache.json', 'source-health.json', 'run.log', '_user_meta.json', 'plan_custom_model_eval.json', '.env',
    # U-249（v1.53.26）：`.gate-green.json` = **门禁凭证**（U-247），每次跑门禁都重写。
    #   ★与 source-health.json 完全同类：它是"这台机器最近一次测量"的运行时状态，不是资产。
    #   漏在这里的后果（2026-10-25 实测）：Tier1-3 预检把它当成"符合收录形态但不在清单"的文件 ⇒
    #   每次发布都 fail-closed 拒绝，而它**永远不该**被收录（`.gitignore` 已挡）。排除项必须与 .gitignore 对齐，
    #   否则两道门对"这个文件算不算资产"给出不同答案。
    '.gate-green.json',
    # U-291（v1.71.0，2026-10-28 全量验收 F1）：`.ps-gate.json` = **PS 套件凭证**（run-tests.ps1 写）。
    #   与 .gate-green.json 同类：那是"这台机器最近一次 PS 回归"的读数，不是资产；`.gitignore` 已挡。
    '.ps-gate.json')
$PUB_EXCLUDE_EXACT = @{
    '说明书.md'             = 'U-39：与已发布渐进式文档重复，无运行时入口读取（A 侧为手工镜像）'
    # U-292（v1.72.0）：源仓 2026-10-20 已删的开发期前端压测脚本；A 侧仍留着 10-13 的副本。
    #   登记在此 = ① 预检不再把它当"该发没发" ② 目标侧的陈旧副本按 U-292 退役。
    'stress-frontend-ui.ps1' = '开发期前端压测脚本，无运行时入口；源仓已删，仅 A 侧残留'
    'smart-search_cache.json' = '运行时缓存产物（同 search_cache.json 一族）'
    'tools/audit/audit-analyze.py'       = '本地审计工具：无 tests/脚本引用，不随发（要随发就登记进清单）'
    'tools/audit/audit-driver.ps1'       = '同上'
    'tools/audit/audit-run.ps1'          = '同上'
    'tools/audit/battery.json'           = '同上'
    'tools/audit/battery.schema.json'    = '同上'
    'tools/audit/export-norm-fixture.ps1' = '同上'
    'tools/audit/paired-variants.mjs'    = '同上'
}
# U-267（v1.53.36）：加 `.jsonl` —— 回放语料 `tests/fixtures/replay/*/responses.jsonl` 是**测试资产**，
#   不随发的话 A 副本上 `test-u267` 会因为"找不到基线语料"而红（随包发测试却不发它依赖的语料 = 发货缺口）。
#   当前仓内只有这一处 .jsonl，没有把运行时账本误纳的风险（账本默认不落盘，落盘路径由 MCPS_LEDGER 指到仓外）。
$PUB_INCLUDE_EXT = @('.ps1', '.psm1', '.py', '.mjs', '.js', '.json', '.jsonl', '.md', '.txt', '.example')
$pubRoot = [System.IO.Path]::GetFullPath($canonicalDir).TrimEnd('\', '/')
$pubCandidates = @(Get-ChildItem -LiteralPath $canonicalDir -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($pubRoot.Length).TrimStart('\', '/') -replace '\\', '/'
    $parts = $rel -split '/'
    if ($parts.Count -gt 1 -and $PUB_EXCLUDE_DIRS -contains $parts[0]) { return }
    if ($PUB_EXCLUDE_NAMES -contains $_.Name) { return }
    # ★U-290（v1.70.0，实测撞出来的）：临时物不进清单 —— 与 `.gitignore` 的命名约定同源。
    #   病灶：`-RegisterMissing` 收的是"符合收录形态的新文件"，而**调试脚本长得完全一样**。
    #   2026-10-27 实测：`.tmp-seam.mjs`（B3-15 的临时验证脚本）被登记进清单、发布到 A；
    #   更糟的是根级文件**不在退役规则**里（U-279 刻意只碰受管目录），所以它会永久留在副本里。
    #   宁可漏发一个文件（Tier1-3 预检会喊），也不要把自己刚写的调试脚本当资产发出去。
    if ($_.Name -like '.tmp*' -or $_.Name -like 'tmp-*' -or $_.Name -like '*.bak-*' -or $_.Name -like '*.tmp.*') { return }
    if ($PUB_EXCLUDE_EXACT.ContainsKey($rel)) { return }
    if ($PUB_INCLUDE_EXT -notcontains $_.Extension -and $_.Name -ne 'LICENSE') { return }
    $rel
})
$pubMissing = @($pubCandidates | Where-Object { -not $asset.fileHashes.PSObject.Properties[$_] })
if ($pubMissing.Count -gt 0) {
    if (-not $RegisterMissing) {
        Write-Host '[Tier1-3] 以下文件符合收录形态但不在发布清单（fail-closed，防静默漏发）:' -ForegroundColor Red
        $pubMissing | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
        Write-Host '  处置二选一：① 加进 skill-assets.json 的 fileHashes（正式随发）；② 加进 $PUB_EXCLUDE_EXACT 并写 why（有意不发）。' -ForegroundColor Yellow
        Write-Host '  确认要随发：重跑并加 -RegisterMissing（空哈希由本次发布回填）。' -ForegroundColor Yellow
        exit 2
    }
    foreach ($m in $pubMissing) {
        $asset.fileHashes | Add-Member -NotePropertyName $m -NotePropertyValue '' -Force
        Write-Host "[Tier1-3] 已登记新文件: $m" -ForegroundColor Green
    }
}

# ---- Tier1-3 延伸（v1.53.2）：文档里的「N 项」由**清单实际条目数**自动同步 ----
#   动机：SKILL / 说明书 / 参数速查 三处都写死了清单项数，每加一个文件就要手改三处；
#     v1.53.0 与 v1.53.2 各漏过一次（G2 直接报「文档写 200，源码派生 201」）。
#   项数是**发布产物**，不该手写 ⇒ 在哈希之前同步，改动自然进哈希与镜像。
#   ★只改三处已知句式（各自只出现一次）；历史叙述里的数字不受影响。
$manifestCount = @($asset.fileHashes.PSObject.Properties).Count
$countDocs = @(
    @{ File = 'SKILL.md';                Re = '(宿主按 \*\*)\d+( 项清单\*\*发布 A)' },
    @{ File = '说明书.md';               Re = '(（当前 )\d+( 项，由 G2 从清单派生校验）)' },
    @{ File = 'references/参数速查.md';   Re = '(当前 )\d+( 项发布路径)' }
)
$syncedDocs = @()
foreach ($d in $countDocs) {
    $docFull = Join-Path $canonicalDir $d.File
    if (-not (Test-Path -LiteralPath $docFull)) { continue }
    $docRaw = [System.IO.File]::ReadAllText($docFull)
    $docNew = [regex]::Replace($docRaw, $d.Re, ('${1}' + $manifestCount + '${2}'))
    if ($docNew -eq $docRaw) { continue }
    if ($WhatIf) { Write-Host "[WhatIf] 将同步 $($d.File) 的清单项数 -> $manifestCount"; continue }
    $docBytes = [System.IO.File]::ReadAllBytes($docFull)
    $docBom = ($docBytes.Length -ge 3 -and $docBytes[0] -eq 0xEF -and $docBytes[1] -eq 0xBB -and $docBytes[2] -eq 0xBF)
    [System.IO.File]::WriteAllText($docFull, $docNew, (New-Object System.Text.UTF8Encoding($docBom)))
    $syncedDocs += $d.File
}
if ($syncedDocs.Count -gt 0) { Write-Host "[Tier1-3] 清单项数已同步为 $manifestCount：$($syncedDocs -join ', ')" -ForegroundColor Green }

# ---- Tier1-3：示例路径集**先**派生（在哈希之前）⇒ 示例文件的改动自动进哈希，不再需要第二次 publish ----
$pubExamplePath = Join-Path (Split-Path -Parent $PSCommandPath) 'skill-assets.example.json'
if ($WhatIf) { Write-Host '[WhatIf] 跳过示例派生（只在真实发布时就地改写）' }
else {
    $null = Sync-ExamplePathSet -Paths @($asset.fileHashes.PSObject.Properties.Name) -ExamplePath $pubExamplePath
    $exVerChanged = Sync-ExampleVersion -Version $Version -ExamplePath $pubExamplePath
    if ($exVerChanged) { Write-Host "[U-139] 示例清单 version 已同步为 $Version（示例是发布派生物，不得与根清单漂移）" -ForegroundColor Green }
    # v1.53.11（P1，实测）：示例清单是**派生 JSON**，而上面两个同步函数都按**正则/文本**改字节（为保住键序与缩进），
    #   谁都发现不了"改完之后不是合法 JSON"。实测 v1.53.10：我在 `_comment` 里插了两个未转义的直引号 ⇒ 文件废了，
    #   而 publish 一路绿（照样复制、照样算哈希、照样刷镜像），是**门** U-139 事后才红。
    #   派生物坏了就不该发出去 ⇒ 在此 fail-closed（早于"复制+算哈希"，不会把坏字节写进清单）。
    try { $null = [System.IO.File]::ReadAllText($pubExamplePath) | ConvertFrom-Json }
    catch { throw "[U-221e] 示例清单不是合法 JSON，发布中止（派生阶段就已损坏）：$($_.Exception.Message)" }
    # v1.53.6（U-227）：纯版本锚点自动改写 —— 必须在"复制+算哈希"之前，改动才会进本次哈希
    $anchorChanged = @(Sync-VersionAnchors -Version $Version -CanonicalDir $canonicalDir)
    if ($anchorChanged.Count -gt 0) { Write-Host ("[U-227] 版本锚点已同步为 {0}：{1}" -f $Version, ($anchorChanged -join ', ')) -ForegroundColor Green }
}

$synced = 0
$checked = 0
$updatedHashes = @{}
foreach ($fileName in $asset.fileHashes.PSObject.Properties.Name) {
    $src = Join-Path $canonicalDir $fileName
    if (-not (Test-Path $src)) { Write-Warning "源文件缺失（跳过）: $src"; continue }
    $checked++
    $updatedHashes[$fileName] = Get-Sha256 $src
    # U-249（-StampOnly）：只算哈希，**一个文件都不复制**（这是"不发布"的物理含义）
    if ($StampOnly) { continue }
    foreach ($tgt in $targets) {
        $dst = Join-Path $tgt $fileName
        $dstDir = Split-Path -Parent $dst
        if (-not (Test-Path $dstDir)) {
            if ($WhatIf) { Write-Host "[WhatIf] 新建目录 $dstDir" }
            else { $null = New-Item -ItemType Directory -Force -Path $dstDir }
        }
        if ($WhatIf) {
            Write-Host "[WhatIf] 复制 $src -> $dst"
        } else {
            Copy-Item -LiteralPath $src -Destination $dst -Force
            $synced++
        }
    }
}

# ---- 回写清单 ----
foreach ($fileName in $updatedHashes.Keys) {
    $asset.fileHashes.PSObject.Properties[$fileName].Value = $updatedHashes[$fileName]
}
if ($Version) { $asset.version = $Version }
if (-not $StampOnly) {
    # U-249：`-StampOnly` **不更新** publishedAt / buildSummary —— 它没有发布。
    #   让时间戳撒谎比不写时间戳更糟：将来"这份清单是哪次发布写的"就再也查不出来了。
    $asset.publishedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    $asset.buildSummary = "files=$($updatedHashes.Count); targets=$($targets.Count); syncedOps=$synced; published via scripts/publish-skill.ps1"
}
if ($updatedHashes.ContainsKey('SKILL.md')) { $asset.sourceSha256 = $updatedHashes['SKILL.md'] }

if ($WhatIf) {
    Write-Host "[WhatIf] 将写回清单: $manifestPath"
} else {
    $utf8Bom = New-Object System.Text.UTF8Encoding($true)
    $json = $manifest | ConvertTo-Json -Depth 10
    [System.IO.File]::WriteAllText($manifestPath, $json, $utf8Bom)
    Write-Host "清单已更新: $manifestPath"
}

# ---- U-249（v1.53.26，B1-4 收口）：`-StampOnly` 到此为止 —— 后面全是"发布"动作，一律不做 ----
#   位置不是随手选的：必须**在根清单回写之后**（镜像要反映新哈希）、**在 target 侧任何写入之前**。
#   镜像用 `Write-SkillMirror`（与 -RegenerateMirror 同一个函数）—— 绝不另写一份镜像生成逻辑，
#   否则"镜像长什么样"就有了两个答案（U-46 的整条教训）。
if ($StampOnly) {
    if ($WhatIf) { Write-Host '[U-249][WhatIf] 将刷新镜像并退出（不改任何文件）'; exit 0 }
    Write-SkillMirror -ManifestObj $manifest -MirrorPath (Join-Path (Join-Path $canonicalDir 'reports') '_skill-assets.root.json')
    Write-Host ("[U-249] 盖戳完成：{0} 条哈希、version={1}。target 目录**一个字节都没动**。" -f $updatedHashes.Count, $asset.version) -ForegroundColor Green
    Write-Host '[U-249] 下一步：跑一次全量门禁（U-139 这类"要求已发布态"的门应转绿），再用**不带** -StampOnly 的命令真正发布。' -ForegroundColor Yellow
    exit 0
}

# ---- v1.42.0（P1-3）：把清单写到**目标目录**，使安装副本可自证 ----
#   动机（2026-10-19 实测）：发布副本此前带一个 1.38.0 空壳清单 ⇒ 用户 -Verify 得 UNKNOWN，
#   等于"有哈希能力却无法自证"。此处写**最小字段**清单（name/version/fileHashes）。
if (-not $WhatIf) {
    $provObj = [ordered]@{
        _comment   = '安装副本自校验清单：在本目录执行 python mcps.py -Verify（0=PASS / 1=DRIFT 或 MISSING / 2=UNKNOWN）'
        assets     = @([ordered]@{
            name       = $asset.name
            version    = $asset.version
            fileHashes = $asset.fileHashes
        })
    }
    $provJson = ($provObj | ConvertTo-Json -Depth 10)
    foreach ($t in $targets) {
        try {
            [System.IO.File]::WriteAllText((Join-Path $t 'skill-assets.json'), $provJson, (New-Object System.Text.UTF8Encoding($false)))
        } catch { Write-Warning "目标清单写入失败: $t : $_" }
    }
    Write-Host "目标清单已写入（$($targets.Count) 处）: skill-assets.json"
}

# ---- U-248：发布后清残留（白名单式）+ U-279：退役（清单外受管文件）；-NoPrune 一并关闭 ----
#   ★放在复制之后、镜像刷之前：清的是目标目录里的临时物与**上一版还发、这一版不发了**的文件，
#     与本轮清单/哈希无关。
if (-not $NoPrune) {
    $manifestPaths = @($asset.fileHashes.PSObject.Properties.Name)
    # 受管目录 = 清单里出现的顶层目录 + 明确"随包不发"的 reports（证据不进安装副本）。
    #   ★整目录退场（比如某天不再发 evals/）要在这里补一条 —— 只靠清单推导会漏掉"已整个消失的目录"。
    $ownedDirs = @(@($manifestPaths | Where-Object { $_ -match '/' } | ForEach-Object { ($_ -split '/')[0] } | Sort-Object -Unique) + @('reports'))
    # U-292：登记过的"有意不随发"根级文件（说明书.md / stress-frontend-ui.ps1 …）——
    #   给 Remove-PublishResidue 用，让"不随发"在目标侧也真的不残留。带目录的键不走这条（见函数内 ②）。
    $notShippedRoot = @($PUB_EXCLUDE_EXACT.Keys | Where-Object { [string]$_ -notmatch '/' })
    foreach ($t in $targets) {
        if (-not (Test-Path -LiteralPath $t)) { continue }
        try {
            # U-254：把源仓传进去做否决 —— 源仓也有的文件不当残留（dry-run 实测：旧白名单会删掉
            #   `reports/_verify-保留策略.md`，那是被 SKILL.md 引用的裁决记录，只是没进清单）。
            $pr = Remove-PublishResidue -TargetDir $t -CanonicalDir $canonicalDir -ManifestFiles $manifestPaths -OwnedDirs $ownedDirs -NotShippedFiles $notShippedRoot -WhatIf:$WhatIf
            $removed = @($pr.Removed); $skipped = @($pr.Skipped); $retired = @($pr.Retired)
            if ($removed.Count -gt 0) { Write-Host ("[U-248] $t → 清理 {0} 项" -f $removed.Count) -ForegroundColor Green }
            if ($retired.Count -gt 0) { Write-Host ("[U-279] $t → 退役 {0} 项（不在清单、非保护名单）" -f $retired.Count) -ForegroundColor Green }
            if ($skipped.Count -gt 0) { Write-Host ("[U-254] $t → 跳过 {0} 项（源仓也存在，未删）" -f $skipped.Count) -ForegroundColor Yellow }
        } catch { Write-Warning ("[U-248] 清理失败（已跳过，不影响发布）: $t — " + $_.Exception.Message) }
    }
}

# ---- Tier1-3 收口①：镜像刷（镜像=最终清单；先刷后改哈希就是 U-139 红）----
#   ★v1.53.8 顺序修正：Statement **读的就是这份镜像**（test-u158 的发货集合取自 reports/_skill-assets.root.json），
#   而旧顺序是「Statement 先、镜像后」⇒ 新增文件的版本里 Statement 永远滞后一版（fileCount 204 vs 205，实测）。
#   镜像刷新只写 reports/，不碰任何哈希 ⇒ 放在 Statement **之前**是安全的（哈希此时已定稿）。
if (-not $WhatIf) {
    Write-SkillMirror -ManifestObj $manifest -MirrorPath (Join-Path (Join-Path $canonicalDir 'reports') '_skill-assets.root.json')
    Write-Host '[Tier1-3] 镜像已刷（Statement 以此为发货集合）' -ForegroundColor Green
}
# ---- U-176（v1.42.0）：发布末尾重生成 in-toto Statement ----
#   动机（2026-10-19 两次实测）：改了**清单内**文件 → publish 只更新哈希 → Statement 陈旧 ⇒ U-158 A 假红。
#   语义上 publish 正是"声明发货集合"的动作，Statement 必须与它同源 ⇒ 在此重生成，不再依赖人工 U158_REGEN=1。
#   边界：只改 reports/provenance/（不在清单内，无自引用）；node 不可用或测试失败时**只告警、不阻断发布**
#         （发布的职责是复制与声明，不是跑门）。
if (-not $WhatIf) {
    $stmtTest = Join-Path $canonicalDir 'tests\test-u158-provenance.test.mjs'
    if ((Test-Path $stmtTest) -and (Get-Command node -ErrorAction SilentlyContinue)) {
        $prevRegen = $env:U158_REGEN
        $env:U158_REGEN = '1'
        $stmtOk = $false
        $prevEap = $ErrorActionPreference
        try {
            # v1.53.3（P1，实测）：本脚本开头是 $ErrorActionPreference='Stop'，而 native 命令的 stderr
            #   经 `2>&1` 会变成 ErrorRecord ⇒ Stop 下**第一行 stderr 就抛终止错误**。
            #   node 每次启动都往 stderr 打 `[UNDICI-EHPA] Warning`，于是这段重生成从此**从未成功**
            #   （症状：publish 打「Statement 重生成失败」而手动 U158_REGEN=1 全绿；警告里的"最后 4 行"
            #    正是那两行 warning，不是断言失败信息）。判据只看退出码，故临时放开 EAP。
            $ErrorActionPreference = 'Continue'
            Push-Location $canonicalDir
            $stmtOut = & node --test $stmtTest 2>&1
            $stmtOk = ($LASTEXITCODE -eq 0)
        } catch { $stmtOk = $false; $stmtOut = @("$($_.Exception.Message)") }
        finally {
            $ErrorActionPreference = $prevEap
            Pop-Location
            if ($null -eq $prevRegen) { Remove-Item Env:\U158_REGEN -ErrorAction SilentlyContinue } else { $env:U158_REGEN = $prevRegen }
        }
        if ($stmtOk) { Write-Host 'in-toto Statement 已按当前工作树重生成: reports/provenance/' -ForegroundColor Green }
        else {
            Write-Warning 'Statement 重生成失败（发布本身已完成）'
            @($stmtOut) | Select-Object -Last 4 | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkYellow }
            Write-Host '  排查：node --test tests/test-u158-provenance.test.mjs' -ForegroundColor DarkYellow
        }
    } else {
        Write-Warning '跳过 Statement 重生成（未找到 node 或 tests/test-u158-provenance.test.mjs）'
    }
}

if (-not $WhatIf) { Write-Host '[Tier1-3] 发布收口完成：预检 + 示例先派生 + 哈希回写 + 镜像先刷 + Statement 后生成' -ForegroundColor Green }


Write-Host "发布完成 -> 文件数=$checked 目标数=$($targets.Count) 同步操作=$synced"
foreach ($t in $targets) { Write-Host "  目标: $t" }
