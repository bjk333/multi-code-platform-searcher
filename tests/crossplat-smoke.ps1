# 跨平台冒烟（v1.53.18 / U-235）：在 Windows / Linux / macOS 上跑同一份端到端检查。
#   动机：v1.53.17 的跨平台修复只在 Windows + 一次性 Docker 手工验证过，没有"换台机器就能重跑"的入口。
#   设计取舍（实测踩坑后定的，别再改回去）：
#     ① **不 dot-source 主脚本**：`-File` 模式下 dot-source 会把 `$MyInvocation.MyCommand.Definition`
#        解析成调用者脚本 ⇒ 主脚本 `$ScriptDir` 指向 tests/ ⇒ `engines/*.ps1` 找不到 ⇒ 检索静默 0 条。
#     ② **不经 PowerShell 管道/`>` 捕获**：PS 的 `>` 按宿主编码写（ANSI/UTF-16），JSON 里的中文读回来必坏；
#        .NET Process 的 ReadToEnd 又会因主脚本末尾的 `exit` 拿到 0 字节。
#     ③ 因此统一走**平台 shell 重定向**（cmd /c 或 bash -c），字节级落盘，主脚本的 `exit` 不影响。
#   判定：网络类检查不可达 ⇒ skip（弱网不等于产品坏）；其余任何失败 ⇒ FAIL（rc=1）。
#   用法：
#     pwsh -NoProfile -File tests/crossplat-smoke.ps1                 # 全量（Doctor + 一次真实检索）
#     pwsh -NoProfile -File tests/crossplat-smoke.ps1 -SkipNetwork    # 只跑静态项
param(
    [switch]$SkipNetwork,
    [string]$Platform = 'GitHub',
    [int]$Limit = 3,
    [string]$OutFile = ''
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$main = Join-Path $root 'multi-platform-searcher.ps1'
$hostExe = (Get-Process -Id $PID).Path
$isWin = ($null -ne $IsWindows -and $IsWindows) -or ($PSVersionTable.PSEdition -eq 'Desktop')
$isMac = ($null -ne $IsMacOS -and $IsMacOS)
$platName = if ($isWin) { 'windows' } elseif ($isMac) { 'macos' } else { 'linux' }
$tmp = [System.IO.Path]::GetTempPath()

$rows = New-Object System.Collections.Generic.List[string]
$fails = 0
$skips = 0
function Add-Row([string]$name, [string]$value) {
    $script:rows.Add(('[crossplat] {0}={1}' -f $name, $value))
    Write-Host ('[crossplat] {0}={1}' -f $name, $value)
}
function Add-Fail([string]$name, [string]$why) { $script:fails++; Add-Row $name ('FAIL: ' + $why) }
function Add-Skip([string]$name, [string]$why) { $script:skips++; Add-Row $name ('skip: ' + $why) }

# 用平台 shell 跑一次 CLI，stdout/stderr 字节级落盘（避开 PowerShell 编码与 exit 缓冲问题）
function Invoke-Cli {
    param([string[]]$CliArgs, [string]$OutPath, [string]$ErrPath)
    $quoted = ($CliArgs | ForEach-Object { '"' + ($_ -replace '"', '\"') + '"' }) -join ' '
    if ($isWin) {
        $line = 'chcp 65001 >nul && "' + $hostExe + '" ' + $quoted + ' > "' + $OutPath + '" 2> "' + $ErrPath + '"'
        & $env:ComSpec /c $line | Out-Null
    } else {
        $sq = ($CliArgs | ForEach-Object { "'" + ($_ -replace "'", "'\''") + "'" }) -join ' '
        $line = "'" + $hostExe + "' " + $sq + " > '" + $OutPath + "' 2> '" + $ErrPath + "'"
        & bash -c $line | Out-Null
    }
    return $LASTEXITCODE
}
function Read-Utf8([string]$p) {
    if (-not (Test-Path -LiteralPath $p)) { return '' }
    return [System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8)
}

# ---- 1. 运行时与平台 ----
$osText = if ($PSVersionTable.OS) { $PSVersionTable.OS } else { [Environment]::OSVersion.VersionString }
Add-Row 'os' ("{0} / PS {1} / {2}" -f $osText, $PSVersionTable.PSVersion, $PSVersionTable.PSEdition)
Add-Row 'platform' $platName

# ---- 2. 语法解析（不加载脚本，只管语法/编码）----
try {
    $errs = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($main, [ref]$null, [ref]$errs)
    if ($errs.Count -gt 0) { Add-Fail 'parse' ("{0} error(s): {1}" -f $errs.Count, $errs[0].Message) } else { Add-Row 'parse' 'ok' }
} catch { Add-Fail 'parse' $_.Exception.Message }

if ($SkipNetwork) {
    Add-Skip 'doctor' '-SkipNetwork'
    Add-Skip 'search' '-SkipNetwork'
} else {
    # ---- 3. -Doctor：工具清单 + 本平台安装提示 + 能力矩阵 ----
    $docOut = Join-Path $tmp ('crossplat-doc-' + $PID + '.json')
    $docErr = Join-Path $tmp ('crossplat-doc-' + $PID + '.err')
    try {
        $rc = Invoke-Cli -CliArgs @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $main, '-Doctor', '-AsJson', '-NoEnvFile') -OutPath $docOut -ErrPath $docErr
        $doc = $null
        try { $doc = (Read-Utf8 $docOut) | ConvertFrom-Json } catch { }
        if ($null -eq $doc -or $null -eq $doc.doctor) {
            Add-Skip 'doctor' ("exit={0} 且未产出可解析 JSON（{1} 字节；stderr={2}）" -f $rc, (Read-Utf8 $docOut).Length, (Read-Utf8 $docErr).Substring(0, [Math]::Min(120, (Read-Utf8 $docErr).Length)))
        } else {
            $tools = @($doc.doctor.tools)
            if ($tools.Count -lt 5) { Add-Fail 'doctor' ("tools={0}（应 ≥5）" -f $tools.Count) }
            else {
                Add-Row 'tools' (($tools | ForEach-Object { $_.Tool + '=' + $_.Status }) -join ',')
                Add-Row 'code_evidence_level' ([string]$doc.doctor.codeEvidenceLevel)
                # 安装提示只在"缺本地工具"时才该出现；已有 rg/ugrep 时给出的是"本地优先"建议。
                $hasLocal = @($tools | Where-Object { $_.Tool -in @('ripgrep', 'ugrep') -and $_.Status -eq 'ok' }).Count -gt 0
                $rec = [string]$doc.doctor.recommendation.codeEvidence
                if ($hasLocal) {
                    if ($rec -match '本地') { Add-Row 'install_hint' ('n/a（本机已有本地工具）：' + $rec) }
                    else { Add-Fail 'install_hint' ('有本地工具但建议未提本地优先：' + $rec) }
                } else {
                    $want = if ($isWin) { 'winget' } elseif ($isMac) { 'brew' } else { 'apt' }
                    if ($rec -match $want) { Add-Row 'install_hint' $rec }
                    else { Add-Fail 'install_hint' ("缺本地工具但建议里没有本平台安装命令（期望含 {0}）：{1}" -f $want, $rec) }
                }
            }
        }
    } catch { Add-Skip 'doctor' $_.Exception.Message }
    finally { Remove-Item -LiteralPath $docOut, $docErr -Force -ErrorAction SilentlyContinue }

    # ---- 4. 真实检索 + 缓存不可写告警（一次调用验两件事）----
    $resOut = Join-Path $tmp ('crossplat-res-' + $PID + '.json')
    $resErr = Join-Path $tmp ('crossplat-res-' + $PID + '.err')
    $badCache = Join-Path (Join-Path $tmp ('crossplat-nodir-' + $PID)) 'cache.json'
    try {
        $oldCache = $env:MCPS_CACHE_FILE
        $env:MCPS_CACHE_FILE = $badCache
        $rc = Invoke-Cli -CliArgs @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $main, '-Keyword', 'jwt', '-Platform', $Platform, '-Limit', "$Limit", '-NoCache', '-AsJson') -OutPath $resOut -ErrPath $resErr
        if ($null -eq $oldCache) { Remove-Item Env:MCPS_CACHE_FILE -ErrorAction SilentlyContinue } else { $env:MCPS_CACHE_FILE = $oldCache }
        $res = $null
        try { $res = (Read-Utf8 $resOut) | ConvertFrom-Json } catch { }
        if ($null -eq $res) {
            Add-Fail 'search' ("exit={0} 且输出不可解析（{1} 字节；stderr={2}）" -f $rc, (Read-Utf8 $resOut).Length, (Read-Utf8 $resErr).Substring(0, [Math]::Min(120, (Read-Utf8 $resErr).Length)))
        } else {
            $verdict = [string]$res.coverage.Verdict
            $exec = @($res.coverage.Executed).Count
            if ($exec -eq 0) { Add-Skip 'search' ("Verdict={0} Executed=0（网络/凭据不可用）" -f $verdict) }
            elseif ($rc -ne 0) { Add-Fail 'search' ("exit={0} 但 Executed={1}" -f $rc, $exec) }
            else { Add-Row 'search' ("exit={0} Verdict={1} results={2} Executed={3}" -f $rc, $verdict, @($res.results).Count, $exec) }
            $w = @($res.warnings)
            if (@($w | Where-Object { $_ -like '*缓存不可写*' }).Count -gt 0) { Add-Row 'cache_warn' 'ok' }
            else { Add-Fail 'cache_warn' ('缓存指向不可写路径但 warnings 未告警（warnings={0}）' -f $w.Count) }
        }
    } catch { Add-Fail 'search' $_.Exception.Message }
    finally { Remove-Item -LiteralPath $resOut, $resErr -Force -ErrorAction SilentlyContinue }
}

$verdictText = if ($fails -gt 0) { 'FAIL' } else { 'PASS' }
Add-Row 'RESULT' ("{0} (fails={1} skips={2})" -f $verdictText, $fails, $skips)
if ($OutFile) { [System.IO.File]::WriteAllLines($OutFile, $rows, (New-Object System.Text.UTF8Encoding($false))) }
if ($fails -gt 0) { exit 1 } else { exit 0 }
