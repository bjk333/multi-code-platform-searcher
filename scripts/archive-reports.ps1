<#
.SYNOPSIS
    把仓内证据（reports/ 下的文件）**移出**工作区：复制到外部归档 → 校验 → 追加 MANIFEST → 删源。

.DESCRIPTION
    为什么要有这个脚本（2026-10-27 第五次手工做同一件事之后）：
      `tests/reports-quota.json` 把 `reports/` 钉在 546 个文件，每个版本又必然 +1 张门日志、+1 份 Statement
      ⇒ 每次发版都得手工"挑两旧的外置"。手工做过五次，其中**一次挑中了被 08-实施记录 引用的日志** ——
      删完才想起去 grep。这个脚本把那套动作固化成一条命令，并把"被引用就不许删"变成拒绝条件。

    安全边界（三条，缺一条就会删错东西）：
      ① 只处理 `reports/` 下的文件（不接受任意路径）；
      ② 保护名单 + 被文档引用 ⇒ 拒绝（`-AllowCited` 可显式放行，并在输出里留痕）；
      ③ 先复制再校验哈希，**校验通过才删源**；任何一步失败，源文件原样保留。

    归档目录默认在仓外（`<workspace>\_archive\mcps-reports-2026-10-27`），可用 -ArchiveRoot 覆盖；
    MANIFEST.tsv 是 `相对 reports/ 的路径 \t size \t sha256 \t mtime(ISO8601)`，与 2026-10-27 那批手工记录同格式。

.PARAMETER Path
    相对 reports/ 的路径（可多条）。也接受 `reports/...` 前缀写法。

.PARAMETER Reason
    为什么外置（写进输出；本脚本不改 MANIFEST 的列，理由记在 08-实施记录 里）。

.EXAMPLE
    pwsh -NoProfile -File scripts/archive-reports.ps1 -Path 'provenance/statement-1.62.0.json' -Reason '保留最近 3 份'
#>
param(
    [Parameter(Mandatory = $true)][string[]]$Path,
    [string]$ArchiveRoot = '<workspace>\_archive\mcps-reports-2026-10-27',
    [string]$Reason = '',
    [string]$RepoRoot,
    [switch]$AllowCited,
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'

if (-not $RepoRoot) { $RepoRoot = Split-Path -Parent $PSScriptRoot }
# `-File` 调用时 PowerShell 不做数组绑定（`-Path a,b` 会当成**一个**字符串"a,b"）⇒ 这里自己拆。
#   不依赖调用方写 for 循环，也不要求 `& script -Path @('a','b')` 这种只有交互式才方便的写法。
$Path = @($Path | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
if ($Path.Count -eq 0) { throw '没有要外置的文件（-Path 为空）' }
$reportsDir = Join-Path $RepoRoot 'reports'
if (-not (Test-Path -LiteralPath $reportsDir)) { throw "找不到 reports 目录：$reportsDir（用 -RepoRoot 指定仓库根）" }

# ① 保护名单：删了会痛且不可再生成。与 publish-skill.ps1 的 PUB_EXCLUDE_NAMES 同源语义，但这里更窄 ——
#   这里删的是**证据**，凭据/清单本来就不该出现在 reports 下，出现即异常，直接拒绝处理。
$ProtectedNames = @('.env', 'skill-assets.json', '.gate-green.json')

function Get-ArchiveRel([string]$p) {
    # 三种写法都收：`x/a.txt`（相对 reports/）、`reports/x/a.txt`（相对仓根）、绝对路径。
    #   ★不要用"裸 GetFullPath"：它按**当前工作目录**解析，而本脚本的 cwd 可能是任何地方。
    if ([System.IO.Path]::IsPathRooted($p)) {
        $full = [System.IO.Path]::GetFullPath($p)
    } elseif ($p -match '^reports[\\/]') {
        $full = [System.IO.Path]::GetFullPath((Join-Path $RepoRoot $p))
    } else {
        $full = [System.IO.Path]::GetFullPath((Join-Path $reportsDir $p))
    }
    $prefix = [System.IO.Path]::GetFullPath($reportsDir).TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
    if (-not $full.StartsWith($prefix)) { throw "只允许外置 reports/ 下的文件：$p" }
    return $full.Substring($prefix.Length).Replace('\', '/')
}

function Get-RelativeDocFiles {
    # 只扫可能"引用证据"的文档：reports 下的 .md/.txt + references/ 下的 .md + 仓根的 SKILL.md / 说明书.md
    #   ★不要写成嵌套 scriptblock 里 `$out += ...`：那是**另一个作用域**，累加结果丢在闭包里，
    #     调用方拿到空数组 ⇒ 引用检查静默失效（第一次实跑就踩到：被 note.md 引用的文件照样被外置）。
    $out = New-Object System.Collections.Generic.List[string]
    foreach ($dir in @((Join-Path $RepoRoot 'reports'), (Join-Path $RepoRoot 'references'))) {
        if (-not (Test-Path -LiteralPath $dir)) { continue }
        foreach ($e in Get-ChildItem -LiteralPath $dir -Recurse -File -ErrorAction SilentlyContinue) {
            if ($e.Extension -in @('.md', '.txt')) { $out.Add($e.FullName) }
        }
    }
    foreach ($n in @('SKILL.md', '说明书.md')) {
        $p = Join-Path $RepoRoot $n
        if (Test-Path -LiteralPath $p) { $out.Add($p) }
    }
    return $out.ToArray()
}

$script:docFiles = $null
function Find-Citations([string]$relPath) {
    if ($null -eq $script:docFiles) { $script:docFiles = @(Get-RelativeDocFiles) }
    $base = [System.IO.Path]::GetFileName($relPath)
    $hits = @()
    foreach ($f in $script:docFiles) {
        # 文档里通常写全路径或 basename；两者任一出现即算引用（宁可误拒，不可误删）
        $text = [System.IO.File]::ReadAllText($f)
        if ($text.Contains($relPath) -or $text.Contains($base)) { $hits += $f }
    }
    return $hits
}

New-Item -ItemType Directory -Force -Path $ArchiveRoot | Out-Null
$manifest = Join-Path $ArchiveRoot 'MANIFEST.tsv'
if (-not (Test-Path -LiteralPath $manifest)) {
    # 新归档根的 MANIFEST 头部与 2026-10-27 那份一致
    Set-Content -LiteralPath $manifest -Value "# 相对 reports/ 的路径`tsize`tsha256`tmtime" -Encoding utf8
}

$ok = 0; $refused = 0
foreach ($p in $Path) {
    $rel = Get-ArchiveRel $p
    $src = Join-Path $reportsDir ($rel -replace '/', [System.IO.Path]::DirectorySeparatorChar)
    if (-not (Test-Path -LiteralPath $src -PathType Leaf)) { throw "源文件不存在：$rel" }
    $name = [System.IO.Path]::GetFileName($rel)
    if ($ProtectedNames -contains $name) { throw "拒绝：$rel 命中保护名单（$name）—— 凭据/清单不是证据，不该被外置" }

    $cited = @(Find-Citations $rel)
    if ($cited.Count -gt 0 -and -not $AllowCited) {
        $refused++
        Write-Host ("[拒绝] {0} 被 {1} 处文档引用：{2}" -f $rel, $cited.Count, (($cited | ForEach-Object { Split-Path -Leaf $_ }) -join ', ')) -ForegroundColor Yellow
        Write-Host '        确实要外置就加 -AllowCited（并同步改掉引用，否则记录里会留下悬空路径）' -ForegroundColor Yellow
        continue
    }
    if ($cited.Count -gt 0) {
        Write-Warning ("{0} 仍被 {1} 处文档引用（-AllowCited 已放行）—— 记得回头改引用" -f $rel, $cited.Count)
    }

    $hash = (Get-FileHash -LiteralPath $src -Algorithm SHA256).Hash.ToLower()
    $size = (Get-Item -LiteralPath $src).Length
    $mt = (Get-Item -LiteralPath $src).LastWriteTimeUtc.ToString('yyyy-MM-ddTHH:mm:ss.') + ((Get-Item -LiteralPath $src).LastWriteTimeUtc.Millisecond.ToString('000')) + 'Z'
    $dst = Join-Path $ArchiveRoot ($rel -replace '/', [System.IO.Path]::DirectorySeparatorChar)

    if ($DryRun) {
        Write-Host ("[预演] {0} → {1}（{2} B, {3}）" -f $rel, $ArchiveRoot, $size, $hash.Substring(0, 12)) -ForegroundColor Cyan
        continue
    }

    $dstDir = Split-Path -Parent $dst
    if (-not (Test-Path -LiteralPath $dstDir)) { New-Item -ItemType Directory -Force -Path $dstDir | Out-Null }
    Copy-Item -LiteralPath $src -Destination $dst -Force
    $hash2 = (Get-FileHash -LiteralPath $dst -Algorithm SHA256).Hash.ToLower()
    if ($hash2 -ne $hash) { throw "复制后哈希不一致，源文件保留：$rel（$hash ≠ $hash2）" }

    Add-Content -LiteralPath $manifest -Value ("{0}`t{1}`t{2}`t{3}" -f $rel, $size, $hash, $mt) -Encoding utf8
    Remove-Item -LiteralPath $src -Force
    $ok++
    Write-Host ("[已外置] {0}（{1} B）{2}" -f $rel, $size, $(if ($Reason) { " —— $Reason" } else { '' })) -ForegroundColor Green
}

Write-Host ("[archive-reports] 外置 {0} 个 / 拒绝 {1} 个 / 归档根 {2}{3}" -f $ok, $refused, $ArchiveRoot, $(if ($DryRun) { '（预演，未落盘）' } else { '' })) -ForegroundColor Cyan
if ($refused -gt 0) { exit 3 }
exit 0
