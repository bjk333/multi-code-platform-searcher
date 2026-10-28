# tests/u259-needs-closure-harness.ps1 —— U-259（B2-4）的数据面：**纯 AST 静态推导**，不 dot-source 主脚本。
#
# 为什么不用 `Test-Path "function:X"` 判"是不是本仓函数"（v1 原型的教训，实测踩到）：
#   本机宿主有一个 safe-delete 垫片，把 `Remove-Item` 变成了函数 ⇒ 每个引擎的闭包都多拖进 8 个
#   `*-SafeDelete*` 家族函数，看上去像"引擎依赖了一大坨"。那是**宿主环境**，不是本仓事实。
#   改为「从 AST 收集 FunctionDefinitionAst」⇒ 结果与宿主装了什么模块无关（本机/CI 同值）。
#
# 判据方向只有一个：**漏登记**。引擎（含传递闭包）引用到的本仓函数，必须要么在手写 `Needs`、
#   要么在 `Get-HttpLayerClosure` 的 47 项里（B2-6 加了账本 4 项）。这就是 U-02（漏 Test-RateLimit403）与
#   U-40（漏 Invoke-WebRequestDirect ⇒ GitLab blobs 静默 0 命中）的形态。
# 反方向（手写但不可达）只报数不判红 —— 那是多余的注入，代价是体积，不是正确性。
param([string]$SkillDir = '')
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
if (-not $SkillDir) { $SkillDir = (Resolve-Path (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '..')).Path }
$SkillDir = (Resolve-Path $SkillDir).Path
$mainPath = Join-Path $SkillDir 'multi-platform-searcher.ps1'
# v1.54.0（B3-2）：Get-HttpLayerClosure 与 _engineRegistry 已搬进 lib/ ⇒ 正则要扫"主脚本 + lib/*.ps1"的合并文本，
#   只读主脚本会让 http 闭包算成 0 项（本门会红在"闭包应为 50 项"上，属真实失配而非噪声）。
$mainSrc = [System.IO.File]::ReadAllText($mainPath, [System.Text.Encoding]::UTF8)
$__libDirForSrc = Join-Path $SkillDir 'lib'
if (Test-Path -LiteralPath $__libDirForSrc -PathType Container) {
    foreach ($__lf in (Get-ChildItem -Path $__libDirForSrc -Filter '*.ps1' -File | Sort-Object Name)) {
        $mainSrc += "`n" + [System.IO.File]::ReadAllText($__lf.FullName, [System.Text.Encoding]::UTF8)
    }
}

# ---------- 1. 本仓脚本函数表（主脚本 + lib/*.ps1 + engines/*.ps1）----------
# v1.54.0（B3-2）：函数按领域搬进 lib/ ⇒ 函数表必须扫 lib，否则"闭包/依赖"会算空，
#   本门最危险的失败模式（解析不到东西却在"没漏登记"上变绿）就会出现。
$files = @($mainPath)
$libDir = Join-Path $SkillDir 'lib'
if (Test-Path -LiteralPath $libDir -PathType Container) {
    $files += @(Get-ChildItem -Path $libDir -Filter '*.ps1' -File | ForEach-Object { $_.FullName })
}
$files += @(Get-ChildItem -Path (Join-Path $SkillDir 'engines') -Filter '*.ps1' -File | ForEach-Object { $_.FullName })
$defs = @{}
$parseErrors = @()
foreach ($f in $files) {
    $t = $null; $e = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($f, [ref]$t, [ref]$e)
    if ($e -and @($e).Count) { $parseErrors += [System.IO.Path]::GetFileName($f); continue }
    foreach ($fd in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
        $defs[$fd.Name] = $fd.Extent.Text
    }
}

# ---------- 2. HTTP 层闭包（取自源码字面量，与运行时同一份事实）----------
$hm = [regex]::Match($mainSrc, '(?s)function Get-HttpLayerClosure\s*\{.*?return @\((.*?)\)\s*\}')
$http = @([regex]::Matches($hm.Groups[1].Value, "'([^']+)'") | ForEach-Object { $_.Groups[1].Value })

# ---------- 3. 注册表（解析源码，不执行）----------
$block = [regex]::Match($mainSrc, '(?ms)^\$script:_engineRegistry\s*=\s*@\(\s*\r?\n(.*?)^\)')
$rows = @()
foreach ($line in ($block.Groups[1].Value -split "`r?`n")) {
    if (-not $line.Trim() -or $line.Trim().StartsWith('#')) { continue }
    $n = [regex]::Match($line, "\bName\s*=\s*'([^']+)'").Groups[1].Value
    $fn = [regex]::Match($line, "\bFunc\s*=\s*'([^']+)'").Groups[1].Value
    $nr = [regex]::Match($line, "\bNeeds\s*=\s*@\(([^)]*)\)").Groups[1].Value
    $needs = @([regex]::Matches($nr, "'([^']+)'") | ForEach-Object { $_.Groups[1].Value })
    if ($n) { $rows += [PSCustomObject]@{ Name = $n; Func = $fn; Needs = $needs } }
}

# ---------- 4. 传递闭包 ----------
$script:_refCache = @{}
function Get-Refs([string]$name) {
    # 只看**字面量命令名**（`Get-CommandName()`）。`& $x` 这类动态调用返回 $null ⇒ 天然跳过；
    #   本仓 engines/*.ps1 里实测**零**动态调用（所以不需要 extraNeeds 兜底）；
    #   主脚本里的 `& $curl`/`& $nodeExe`/`& $srcs` 都是外部工具或局部脚本块，本来也不该注入。
    if (-not $defs.ContainsKey($name)) { return @() }
    $t = $null; $e = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseInput($defs[$name], [ref]$t, [ref]$e)
    if ($e -and @($e).Count) { return @() }
    $out = @()
    foreach ($c in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] }, $true)) {
        $cn = $c.GetCommandName()
        if ($cn -and $defs.ContainsKey($cn)) { $out += $cn }
    }
    return @($out | Select-Object -Unique)
}
function Get-Closure([string]$fn) {
    if ($script:_refCache.ContainsKey($fn)) { return $script:_refCache[$fn] }
    $seen = [System.Collections.Generic.HashSet[string]]::new()
    $q = [System.Collections.Generic.Queue[string]]::new()
    $q.Enqueue($fn); [void]$seen.Add($fn)
    while ($q.Count -gt 0) {
        $cur = $q.Dequeue()
        foreach ($n in (Get-Refs $cur)) { if ($seen.Add($n)) { $q.Enqueue($n) } }
    }
    $r = @($seen); $script:_refCache[$fn] = $r; return $r
}

# ---------- 5. 逐引擎比对 ----------
$engines = @()
$allMissing = @()
foreach ($r in $rows) {
    $cls = @(Get-Closure $r.Func) | Where-Object { $_ -ne $r.Func }
    $missing = @($cls | Where-Object { $r.Needs -notcontains $_ -and $http -notcontains $_ })
    $redundant = @($r.Needs | Where-Object { @(Get-Closure $r.Func) -notcontains $_ -and $http -notcontains $_ })
    if ($missing.Count) { $allMissing += ("{0}: {1}" -f $r.Name, ($missing -join ',')) }
    $engines += [PSCustomObject]@{
        name = $r.Name; func = $r.Func
        hand = @($r.Needs).Count
        trans = @($cls).Count
        missing = @($missing)
        redundant = @($redundant)
    }
}

[PSCustomObject]@{
    ok          = ($allMissing.Count -eq 0)
    fails       = @($allMissing)
    funcCount   = $defs.Count
    httpCount   = $http.Count
    engineCount = $rows.Count
    parseErrors = @($parseErrors)
    engines     = @($engines)
} | ConvertTo-Json -Depth 6 -Compress
if ($allMissing.Count -gt 0) { exit 1 }
