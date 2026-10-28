<#
.SYNOPSIS
    下载官方 ripgrep（Windows x64 MSVC 版）到 <skill>\tools\bin\rg.exe，双重 sha256 校验（zip + rg.exe）。
.DESCRIPTION
    v1.37.2（N-3c）：tools/bin/ 下的二进制不入库（.gitignore），新机器/新 clone 用本脚本一条命令恢复。
    固定版本 + 固定哈希（取自官方 release 的 .sha256 文件，并与本机现存 rg.exe 逐位核对过）：
      ripgrep 15.2.0 x86_64-pc-windows-msvc
        zip    sha256 = 71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5
        rg.exe sha256 = 14231169855ec5205cf5a1b6f1db358ff4aed4247c86b69ce8aae647c77f6680（4 218 880 B）
    任一哈希不符即中止、不落盘。已存在且哈希一致时直接跳过（幂等）。
    R2-M（2026-09-30）：台账 tools/ripgrep.lock.json 与下列常量逐字段一致（Node 门 test-r2m-ripgrep-lock 守护）；
      + 大小断言（4 218 880 B，先比长度再算哈希）；+ 下载 URL 前缀白名单；+ 最终重定向主机白名单（取不到最终 URL ⇒ 失败关闭）。
      上游事实：ripgrep 只发未签名的逐资产 .sha256；tag 的 GPG 签名只证源码 tag、不证二进制；无 attestation ⇒ 二进制签名级校验不可得。
      升级流程见台账 upgrade[]（必须同时比对官方 .sha256 并 git verify-tag；禁止运行时动态抓 .sha256 再校验同一 zip）。
.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\fetch-ripgrep.ps1          # 下载/校验
    powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\fetch-ripgrep.ps1 -Check   # 只校验现有文件，不联网
#>
[CmdletBinding()]
param(
    [switch]$Check,
    [switch]$Force
)
$ErrorActionPreference = 'Stop'
$Version   = '15.2.0'
$ZipName   = "ripgrep-$Version-x86_64-pc-windows-msvc.zip"
$ZipUrl    = "https://github.com/BurntSushi/ripgrep/releases/download/$Version/$ZipName"
$ZipSha    = '71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5'
$ExeSha    = '14231169855ec5205cf5a1b6f1db358ff4aed4247c86b69ce8aae647c77f6680'
$ExeSize   = 4218880
$UrlPrefix = 'https://github.com/BurntSushi/ripgrep/releases/download/'
$RedirectHosts = @('github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com')

function Get-FinalResponseUri($Response) {
    # PS 5.1：BaseResponse = HttpWebResponse(.ResponseUri)；PS 7：BaseResponse = HttpResponseMessage(.RequestMessage.RequestUri)
    $u = $null
    try { $u = $Response.BaseResponse.ResponseUri } catch { }
    if (-not $u) { try { $u = $Response.BaseResponse.RequestMessage.RequestUri } catch { } }
    return $u
}

function Get-FileSha256([string]$Path) {
    $algo = [System.Security.Cryptography.SHA256]::Create()
    try { (($algo.ComputeHash([System.IO.File]::ReadAllBytes($Path))) | ForEach-Object { $_.ToString('x2') }) -join '' }
    finally { $algo.Dispose() }
}

$here = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Definition }
$binDir = Join-Path $here 'bin'
$dst = Join-Path $binDir 'rg.exe'

if (Test-Path -LiteralPath $dst -PathType Leaf) {
    $curLen = (Get-Item -LiteralPath $dst).Length
    $cur = if ($curLen -ne $ExeSize) { "size=$curLen≠$ExeSize" } else { Get-FileSha256 $dst }   # 先比长度再哈希
    if ($cur -eq $ExeSha) { Write-Host "OK  $dst 已是 ripgrep $Version（sha256 一致）"; if (-not $Force) { exit 0 } }
    else { Write-Host "DIFF $dst sha256=$cur ≠ 期望 $ExeSha（ripgrep $Version）" -ForegroundColor Yellow }
} else { Write-Host "MISS $dst 不存在" -ForegroundColor Yellow }
if ($Check) { exit 1 }
if (-not $ZipUrl.StartsWith($UrlPrefix, [System.StringComparison]::Ordinal)) { throw "下载 URL 不在白名单（须以 $UrlPrefix 开头）：中止，未联网" }

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("mcps-rg-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
try {
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }
    $zip = Join-Path $tmp $ZipName
    Write-Host "GET $ZipUrl"
    $resp = Invoke-WebRequest -Uri $ZipUrl -OutFile $zip -UseBasicParsing -TimeoutSec 120 -PassThru
    $final = Get-FinalResponseUri $resp
    if (-not $final) { throw '无法取得最终下载 URL（重定向主机无法核对）：失败关闭，未落盘' }
    if ($RedirectHosts -notcontains ([uri]$final).Host) { throw "最终下载主机不在白名单：$(([uri]$final).Host)（中止，未落盘）" }
    $zs = Get-FileSha256 $zip
    if ($zs -ne $ZipSha) { throw "zip sha256 不符：$zs ≠ $ZipSha（中止，未落盘）" }
    Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force
    $exe = Get-ChildItem -LiteralPath $tmp -Recurse -Filter 'rg.exe' | Select-Object -First 1
    if (-not $exe) { throw 'zip 内未找到 rg.exe' }
    if ($exe.Length -ne $ExeSize) { throw "rg.exe 大小不符：$($exe.Length) ≠ $ExeSize B（中止，未落盘）" }
    $es = Get-FileSha256 $exe.FullName
    if ($es -ne $ExeSha) { throw "rg.exe sha256 不符：$es ≠ $ExeSha（中止，未落盘）" }
    New-Item -ItemType Directory -Path $binDir -Force | Out-Null
    Copy-Item -LiteralPath $exe.FullName -Destination $dst -Force
    Write-Host "OK  已安装 ripgrep $Version -> $dst（zip/exe 双 sha256 校验通过）" -ForegroundColor Green
} finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
