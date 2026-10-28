# 0-6 同源门 · 驱动（一条命令跑完两条腿）
#
#   powershell -File tools/audit/parity-check.ps1 [-UpdateBaseline]
#
# 腿①同源  : export-norm-fixture.ps1 取 PS 侧真实输出 -> cross-check.py 与 Python analyzer 比对
# 腿②未漂移: 同一份 PS 现行输出与 fixtures/norm-baseline.json 比对（产品语义被人改动必红）
#
# 样本集唯一权威来源：tools/audit/norm-samples.json（改门只改它）
param(
    [string]$SkillDir = '',
    [switch]$UpdateBaseline,
    [switch]$KeepTemp
)
$ErrorActionPreference = 'Stop'

$AuditDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $SkillDir) { $SkillDir = (Resolve-Path (Join-Path $AuditDir '..\..')).Path }
$SkillDir = (Resolve-Path $SkillDir).Path

$samples   = Join-Path $AuditDir 'norm-samples.json'
$fixtures  = Join-Path $AuditDir 'fixtures'
$baseline  = Join-Path $fixtures 'norm-baseline.json'
$exportPs1 = Join-Path $AuditDir 'export-norm-fixture.ps1'
$checkPy   = Join-Path $AuditDir 'cross-check.py'
$tempDir   = Join-Path $SkillDir '_verify\parity-check'
New-Item -ItemType Directory -Force -Path $tempDir | Out-Null
New-Item -ItemType Directory -Force -Path $fixtures | Out-Null

$cur = Join-Path $tempDir 'ps-norm-current.json'

Write-Output "[0-6] skill = $SkillDir"
Write-Output "[0-6] samples = $samples"
# 解释器解析（2026-10-11）：原先硬编码 `powershell.exe` / `python` ⇒ 本门在 Linux 容器（只有 pwsh / python3）**必红**，
#   而 Node 全量门（tests/run-node-gates.mjs）是明确要在容器里跑的（reports/容器可用性-复验-2026-09-29.md）。
#   顺序：Windows PowerShell 5.1（与基线导出宿主一致）→ pwsh → 当前宿主自身；python → python3。找不到任何一个 ⇒ 显式 FAIL，不静默。
$psHost = (Get-Command powershell.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if (-not $psHost) { $psHost = (Get-Command pwsh -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source }
if (-not $psHost) { $psHost = (Get-Command pwsh.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source }
if (-not $psHost) { Write-Output "[0-6] RESULT: FAIL（找不到 powershell.exe / pwsh，无法导出 PS 侧 fixture）"; exit 1 }
$pyExe = (Get-Command python -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if (-not $pyExe) { $pyExe = (Get-Command python3 -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source }
if (-not $pyExe) { Write-Output "[0-6] RESULT: FAIL（找不到 python / python3，无法跑 cross-check）"; exit 1 }
Write-Output "[0-6] host = $psHost ; python = $pyExe"
Write-Output "[0-6] export ..."
$exp = & $psHost -NoProfile -ExecutionPolicy Bypass -File $exportPs1 -SkillDir $SkillDir -OutFile $cur -SamplesFile $samples 2>&1
$exp | ForEach-Object { Write-Output "   $_" }
if (-not (Test-Path $cur)) { Write-Output "[0-6] RESULT: FAIL（导出未产出 fixture）"; exit 1 }

if ($UpdateBaseline) {
    Copy-Item $cur $baseline -Force
    Write-Output "[0-6] 基线已更新 -> $baseline"
}

$args2 = @($checkPy, '--ps', $cur, '--skill', $SkillDir)
if (Test-Path $baseline) { $args2 += @('--baseline', $baseline) }
Write-Output "[0-6] cross-check ..."
$out = & $pyExe @args2 2>&1
$out | ForEach-Object { Write-Output $_ }
$rc = $LASTEXITCODE

if (-not $KeepTemp) { Remove-Item $tempDir -Recurse -Force -ErrorAction SilentlyContinue }

if ($rc -eq 0) { Write-Output "[0-6] RESULT: PASS"; exit 0 }
Write-Output "[0-6] RESULT: FAIL (rc=$rc)"; exit 1
