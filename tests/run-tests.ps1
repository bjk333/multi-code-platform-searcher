# run-tests.ps1 —— 自动化全量回归入口（② v1.19.0 CI 测试套件）
# 用法：.\tests\run-tests.ps1          # 全量（含需网络的测试）
#       .\tests\run-tests.ps1 -LocalOnly   # 仅纯本地组（CI 快速门禁；网络组标 SKIP）
# 设计说明：本宿主下子进程/子脚本 dot-source 不可靠（$PSScriptRoot 空、$MyInvocation 被 shim 包装），
#           故全部断言在主进程内联执行（主脚本绝对路径 dot-source，已验证可靠）。
#           各 test-*.ps1 文件保留为断言的独立参考副本（运行请通过本入口）。
# 输出：逐组 TEST_PASS/FAIL（同时落盘 tests\test-results.log）；任一 FAIL 时 exit 1（供 CI 门禁）。
param(
    [switch]$LocalOnly,   # v1.34.0 P3：仅跑纯本地组（1 dedup/5 retry/7 denoise/9 docs/10 disable/11 auto），网络组标 SKIP
    [string]$JunitPath = '',   # U-25（T3-1 方案 C，2026-09-26）：把逐组 [group] TEST_PASS/FAIL/SKIP 落成 JUnit XML（CI/归档消费）；空 = 不写。纯增，不改判据与 rc。
    [string]$ResultJsonPath = '',   # U-80（2026-09-26）：组结果机器可读 JSON（groups[]/passed/failed/skipped/exitCode）；Pester 适配层从这里读，不再自己解析 stdout。空 = 不写。
    [string]$PsGatePath = ''        # U-291（v1.71.0）：PS 套件凭证落点（缺省 = 仓根 `.ps-gate.json`）；测试/预演时可重定向，避免覆盖真凭证。
)

# ---------- 路径探测（Definition 在脚本文件内有效） ----------
$testDir = $null
foreach ($c in @($MyInvocation.MyCommand.Definition, $PSScriptRoot)) {
    try {
        if ($c) {
            $d = Split-Path -Parent $c
            if ($d -and (Test-Path $d -PathType Container)) { $testDir = $d; break }
        }
    } catch { }
}
if (-not $testDir) { $testDir = '.' }
$mainScript = (Resolve-Path (Join-Path $testDir '..\multi-platform-searcher.ps1')).Path
# U-133（2026-09-29，预注册 reports/U-133-预注册判据-2026-09-29.md）：启动自清 —— 只删白名单形状、mtime 早于启动 ≥10 分钟的门临时目录；永不触碰保留清单；U133_WHATIF=1 只打印不删
function Clear-StaleGateTemp([string]$RepoRoot, [switch]$WhatIfOnly) {
    $u133Dir = Join-Path $RepoRoot '_verify'; $u133Removed = @()
    if (-not (Test-Path -LiteralPath $u133Dir)) { return $u133Removed }
    $u133Keep = @('r2', 'u119', 'u120', 'u134-specimen'); $u133Now = Get-Date
    foreach ($u133D in @(Get-ChildItem -LiteralPath $u133Dir -Force -Directory)) {
        if ($u133Keep -contains $u133D.Name) { continue }
        if ($u133D.Name -notmatch '^(n9|n9neg|r2|r2neg)-[A-Za-z0-9]{6}$') { continue }
        if (($u133Now - $u133D.LastWriteTime).TotalMinutes -lt 10) { continue }
        if ($WhatIfOnly) { Write-Host "[U-133] 预演(不删): $($u133D.Name)"; continue }
        try { Remove-Item -LiteralPath $u133D.FullName -Recurse -Force -ErrorAction Stop; $u133Removed += $u133D.Name; Write-Host "[U-133] 启动自清: $($u133D.Name)" } catch { Write-Host "[U-133] 自清失败: $($u133D.Name) $($_.Exception.Message)" }
    }
    return $u133Removed
}
$null = Clear-StaleGateTemp -RepoRoot (Split-Path -Parent $mainScript) -WhatIfOnly:($env:U133_WHATIF -eq '1')
. $mainScript -NoEnvFile

# ---------- 公共辅助 ----------
function t_Count([object[]]$t_Arr) {
    $t_n = 0
    foreach ($t_i in $t_Arr) {
        if ($t_i -is [System.Array] -or $t_i -is [System.Collections.IList]) {
            $t_inner = @($t_i)
            $t_n += $t_inner.Count
        }
        else { $t_n++ }
    }
    return $t_n
}
function t_First([object[]]$t_Arr) {
    foreach ($t_i in $t_Arr) {
        if ($t_i -is [System.Array] -or $t_i -is [System.Collections.IList]) {
            $t_inner = @($t_i)
            return $t_inner[0]
        }
        else { return $t_i }
    }
    return $null
}
# U-295（v1.75.0，全量验收后续）：参数面必须按**集合**比对，不能按计数。
#   病灶（实证）：9d 与 Node 侧 U-60 比的都是「参数速查声明的个数 == param 块实际个数」。计数相等挡不住
#   改名与对换 —— 把文档里的 `-UseRegexp` 写成 `-UseRegex`、或删一行再加一行，个数照样相等 ⇒ 全绿。
#   Cfg 键（U-54）早就是集合口径，参数却一直是计数口径：同一类不变量两种强度。
#   判据本体抽成纯函数（输入两个名字数组，输出差集），好让 Node 门 U-295 用 AST 抠出来跑同一张真值表，
#   并对 JS 侧的同名实现做**等价性**断言（两处实现不得漂移）。
function Compare-ParamSurface {
    param([string[]]$Declared = @(), [string[]]$Documented = @())
    $d = @($Declared | Where-Object { $_ } | Sort-Object -Unique)
    $o = @($Documented | Where-Object { $_ } | Sort-Object -Unique)
    $missing = @($d | Where-Object { $o -notcontains $_ })   # 代码里有、文档没登记
    $extra = @($o | Where-Object { $d -notcontains $_ })     # 文档登记了、代码里没有
    [PSCustomObject]@{
        Ok         = ($missing.Count -eq 0 -and $extra.Count -eq 0)
        Declared   = $d.Count
        Documented = $o.Count
        Missing    = $missing
        Extra      = $extra
    }
}
# U-146（2026-09-29）：网络组先做一次与产品相同请求栈的轻量连通探测；只有传输层不可达才 SKIP。
# 任意 HTTP 响应（含 4xx/5xx）= 网络到达、组测试照常执行；真实断言失败仍 TEST_FAIL。
function t_NetworkPreflight {
    $u146Uri = 'https://api.openalex.org/works?search=jwt&per-page=1'
    try {
        $u146R = Invoke-ApiRequest -Uri $u146Uri -TimeoutSec 6 -MaxAttempts 1
        if ($null -ne $u146R.StatusCode -and [int]$u146R.StatusCode -ge 100) {
            return [PSCustomObject]@{ Available = $true; Reason = "HTTP $([int]$u146R.StatusCode) from OpenAlex probe" }
        }
        return [PSCustomObject]@{ Available = $false; Reason = 'OpenAlex probe returned no HTTP status' }
    } catch {
        $u146Msg = $_.Exception.Message
        $u146Status = $null
        try { if ($_.Exception.Response) { $u146Status = [int]$_.Exception.Response.StatusCode } } catch { }
        if ($u146Status -ge 100 -or $u146Msg -match '(?<!\d)[1-5][0-9]{2}(?!\d)') {
            return [PSCustomObject]@{ Available = $true; Reason = "HTTP response observed despite request error: $u146Msg" }
        }
        if ($u146Msg.Length -gt 220) { $u146Msg = $u146Msg.Substring(0, 220) }
        return [PSCustomObject]@{ Available = $false; Reason = "$($_.Exception.GetType().Name): $u146Msg" }
    }
}

$pass = 0; $failC = 0; $skipC = 0
$lines = New-Object System.Collections.Generic.List[string]
$lines.Add("== multi-code-platform-searcher 回归测试 (v$VERSION) ==")
if ($LocalOnly) { $t_networkProbe = [PSCustomObject]@{ Available = $false; Reason = 'LocalOnly explicitly disables network groups' } }
else { $t_networkProbe = t_NetworkPreflight }
$lines.Add(("[network-preflight] Available={0} Reason={1}" -f $t_networkProbe.Available, $t_networkProbe.Reason))

# ---------- 1) test-dedup：跨平台去重语义（纯内存，无需网络） ----------
$t_ok = $true; $t_fail = @()
$t_r1 = [PSCustomObject]@{ Name = 'devise'; Platform = 'npm'; Url = 'x'; Stars = 1 }
$t_r2 = [PSCustomObject]@{ Name = 'devise'; Platform = 'RubyGems'; Url = 'y'; Stars = 2 }
$t_m1 = @(Merge-DedupResults -Results @($t_r1, $t_r2))
if ((t_Count $t_m1) -ne 2) { $t_ok = $false; $t_fail += "cross-platform same name should keep 2, got $(t_Count $t_m1)" }
$t_r3 = [PSCustomObject]@{ Name = 'foo'; Platform = 'GitHub'; Url = 'a'; Stars = 1 }
$t_r4 = [PSCustomObject]@{ Name = 'foo'; Platform = 'GitHub'; Url = 'b'; Stars = 2 }
$t_m2 = @(Merge-DedupResults -Results @($t_r3, $t_r4))
if ((t_Count $t_m2) -ne 1) { $t_ok = $false; $t_fail += "same-platform same name should dedup to 1, got $(t_Count $t_m2)" }
$t_d1 = [PSCustomObject]@{ Name = 'r'; Platform = 'grep.app'; File = 'a.py'; Line = 3; Url = 'x' }
$t_d2 = [PSCustomObject]@{ Name = 'r'; Platform = 'Sourcegraph'; File = 'a.py'; Line = 3; Url = 'y' }
$t_m3 = @(Merge-DedupResults -Results @($t_d1, $t_d2))
if ((t_Count $t_m3) -ne 1) { $t_ok = $false; $t_fail += "code same file+line should dedup, got $(t_Count $t_m3)" }
$t_d3 = [PSCustomObject]@{ Name = 'r'; Platform = 'grep.app'; File = 'a.py'; Line = 5; Url = 'x' }
$t_m4 = @(Merge-DedupResults -Results @($t_d1, $t_d3))
if ((t_Count $t_m4) -ne 2) { $t_ok = $false; $t_fail += "code different line should keep 2, got $(t_Count $t_m4)" }
if ($t_ok) { $lines.Add("[test-dedup] TEST_PASS (4/4)"); $pass++ } else { $lines.Add("[test-dedup] TEST_FAIL: $($t_fail -join '; ')"); $failC++ }

# ---------- 2) test-citations：arXiv 引用数补全（P2，需网络；S2 匿名限流瞬时失败时重试一次，仍失败 SKIP） ----------
if ($LocalOnly) { $lines.Add("[test-citations] TEST_SKIP (LocalOnly)"); $skipC++ }
else {
$t_ok = $true; $t_fail = @(); $t_skipped = $false
$t_fake = @([PSCustomObject]@{ Index = 1; Platform = 'arXiv'; Name = 'Attention Is All You Need'; Stars = 0; Url = 'http://arxiv.org/abs/1706.03762'; Desc = 'd'; License = ''; Updated = '' })
# 2a) v1.36.6（回迁 B v1.34.2）：S2_API_KEY → X-API-KEY 请求头（离线，mock Invoke-ApiRequest 捕获请求头；用后还原函数与环境变量）
$t_hdr = 'n/a'
$t_origFn = (Get-Item function:Invoke-ApiRequest).ScriptBlock
$t_origKey = [Environment]::GetEnvironmentVariable('S2_API_KEY')
try {
    $global:t_s2Seen = @()
    Set-Item function:Invoke-ApiRequest -Value { param($Uri, $Headers, $TimeoutSec, $Method, $Body) $global:t_s2Seen += ,@{ H = $Headers }; [PSCustomObject]@{ Content = '[{"citationCount":7}]'; StatusCode = 200; Headers = @{} } }
    [Environment]::SetEnvironmentVariable('S2_API_KEY', 'mcps-test-s2-key')
    $t_m1 = [PSCustomObject]@{ Platform = 'arXiv'; Name = 'm'; Stars = 0; Url = 'http://arxiv.org/abs/1706.03762v2'; Desc = 'd' }
    $t_log1 = (Enrich-ArxivCitations -Results @($t_m1) *>&1 | Out-String)
    [Environment]::SetEnvironmentVariable('S2_API_KEY', $null)
    $t_m2 = [PSCustomObject]@{ Platform = 'arXiv'; Name = 'm'; Stars = 0; Url = 'http://arxiv.org/abs/1706.03762'; Desc = 'd' }
    $null = (Enrich-ArxivCitations -Results @($t_m2) *>&1 | Out-String)
    if ($global:t_s2Seen.Count -ne 2) { $t_ok = $false; $t_fail += "s2-hdr: mock 调用次数 $($global:t_s2Seen.Count) != 2" }
    else {
        if ($global:t_s2Seen[0].H['X-API-KEY'] -ne 'mcps-test-s2-key') { $t_ok = $false; $t_fail += 's2-hdr: 配置 S2_API_KEY 时缺 X-API-KEY' }
        if ($global:t_s2Seen[1].H.ContainsKey('X-API-KEY')) { $t_ok = $false; $t_fail += 's2-hdr: 未配置时仍带 X-API-KEY' }
        if ($t_m1.Stars -ne 7) { $t_ok = $false; $t_fail += "s2-hdr: 回填 Stars=$($t_m1.Stars) != 7" }
        if ($t_log1 -match 'mcps-test-s2-key') { $t_ok = $false; $t_fail += 's2-hdr: key 泄漏到输出' }
        if ($t_ok) { $t_hdr = 'ok' }
    }
} catch { $t_ok = $false; $t_fail += "s2-hdr exec: $($_.Exception.Message)" }
finally {
    Set-Item function:Invoke-ApiRequest -Value $t_origFn
    [Environment]::SetEnvironmentVariable('S2_API_KEY', $t_origKey)
    Remove-Variable -Name t_s2Seen -Scope Global -ErrorAction SilentlyContinue
}
try {
    # 展开 -NoEnumerate 嵌套并过滤 Write-ColorOutput 重定向日志泄漏（字符串），只保留结果对象
    $t_raw = @(Enrich-ArxivCitations -Results $t_fake)
    $t_res = @()
    foreach ($t_x in $t_raw) {
        if ($t_x -is [System.Array] -or $t_x -is [System.Collections.IList]) { $t_res += @($t_x | Where-Object { $_ -isnot [string] }) }
        elseif ($t_x -isnot [string]) { $t_res += $t_x }
    }
    $t_first = t_First $t_res
    if ((t_Count $t_res) -ne 1 -or $null -eq $t_first -or $t_first.Stars -le 0) {
        # S2 匿名 100 req/5min，验收密集调用可能瞬时限流 → 重试一次
        Start-Sleep -Seconds 3
        $t_raw = @(Enrich-ArxivCitations -Results $t_fake)
        $t_res = @()
        foreach ($t_x in $t_raw) {
            if ($t_x -is [System.Array] -or $t_x -is [System.Collections.IList]) { $t_res += @($t_x | Where-Object { $_ -isnot [string] }) }
            elseif ($t_x -isnot [string]) { $t_res += $t_x }
        }
        $t_first = t_First $t_res
    }
    if ((t_Count $t_res) -ne 1) { $t_ok = $false; $t_fail += "enrich count: got $(t_Count $t_res)" }
    elseif ($null -eq $t_first -or $t_first.Stars -le 0) { $t_skipped = $true }
} catch { $t_ok = $false; $t_fail += "exec: $($_.Exception.Message)" }
if ($t_ok -and -not $t_skipped) { $lines.Add("[test-citations] TEST_PASS (s2-hdr=$t_hdr)"); $pass++ }
elseif ($t_ok -and $t_skipped) { $lines.Add("[test-citations] TEST_SKIP (S2 unavailable; s2-hdr=$t_hdr)"); $skipC++ }
else { $lines.Add("[test-citations] TEST_FAIL: $($t_fail -join '; ')"); $failC++ }
}

# ---------- 3) test-contract：三模式 -AsJson 契约（需网络；U-146 无传输连通时显式 SKIP） ----------
if ($LocalOnly) { $lines.Add("[test-contract] TEST_SKIP (LocalOnly; network required)"); $skipC++ }
elseif (-not $t_networkProbe.Available) { $lines.Add("[test-contract] TEST_SKIP (network unavailable; $($t_networkProbe.Reason))"); $skipC++ }
else {
$t_ok = $true; $t_fail = @()
try {
    $t_o = (& $mainScript -NoEnvFile -ResearchSources -Keyword "jwt" -Limit 3 -AsJson -NoCache | Out-String | ConvertFrom-Json)
    if ($t_o._schemaError) { $t_ok = $false; $t_fail += "research schemaError: $($t_o._schemaError)" }
    if ($t_o.version -ne $VERSION) { $t_ok = $false; $t_fail += "research version: $($t_o.version) != $VERSION" }
    if (-not ($t_o.results -is [array]) -or $t_o.results.Count -lt 1) { $t_ok = $false; $t_fail += "research results empty" }
    if (@($t_o.results | Where-Object { $_ -is [string] }).Count -gt 0) { $t_ok = $false; $t_fail += "research results contain leaked text (Write-ColorOutput regression)" }
} catch { $t_ok = $false; $t_fail += "research exec: $($_.Exception.Message)" }
try {
    $t_o2 = (& $mainScript -NoEnvFile -Platform All -Keyword "jwt" -MinStars 0 -Limit 3 -AsJson -NoCache | Out-String | ConvertFrom-Json)
    if ($t_o2._schemaError) { $t_ok = $false; $t_fail += "repo schemaError: $($t_o2._schemaError)" }
    if ($t_o2.version -ne $VERSION) { $t_ok = $false; $t_fail += "repo version: $($t_o2.version)" }
    # U-89（2026-09-26）：运行时按 schema/asjson.schema.json 做**双向**键集比对（顶层 / metrics / coverage），不一致报键名。
    #   静态侧（源码字面量 ⇔ schema）在 Node 门 test-r4；这里守"实际输出"这一侧，防止运行时才出现/消失的键。
    $t_schema = Get-Content -LiteralPath (Join-Path $testDir '..\schema\asjson.schema.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $t_cmpKeys = {
        param($label, $actualObj, $schemaProps, [string[]]$ignore)
        $a = @($actualObj.PSObject.Properties.Name | Where-Object { $ignore -notcontains $_ })
        $s = @($schemaProps.PSObject.Properties.Name | Where-Object { $ignore -notcontains $_ })
        $onlyA = @($a | Where-Object { $s -notcontains $_ }); $onlyS = @($s | Where-Object { $a -notcontains $_ })
        if ($onlyA.Count -or $onlyS.Count) { return ("U-89 {0}: only-in-output=[{1}] only-in-schema=[{2}]" -f $label, ($onlyA -join ','), ($onlyS -join ',')) }
        return $null
    }
    foreach ($t_m in @((& $t_cmpKeys 'top' $t_o2 $t_schema.properties @('_schemaError')), (& $t_cmpKeys 'metrics' $t_o2.metrics $t_schema.properties.metrics.properties @()), (& $t_cmpKeys 'coverage' $t_o2.coverage $t_schema.properties.coverage.properties @()))) {
        if ($t_m) { $t_ok = $false; $t_fail += $t_m }
    }
    if ($t_schema.properties.coverage.properties.Verdict.enum -notcontains $t_o2.coverage.Verdict) { $t_ok = $false; $t_fail += "U-89 coverage.Verdict '$($t_o2.coverage.Verdict)' not in schema enum" }
} catch { $t_ok = $false; $t_fail += "repo exec: $($_.Exception.Message)" }
try {
    $t_o3 = (& $mainScript -NoEnvFile -CodeEvidence -Keyword "jwt" -Limit 3 -AsJson -NoCache | Out-String | ConvertFrom-Json)
    if ($t_o3._schemaError) { $t_ok = $false; $t_fail += "evidence schemaError: $($t_o3._schemaError)" }
    if ($t_o3.version -ne $VERSION) { $t_ok = $false; $t_fail += "evidence version: $($t_o3.version)" }
} catch { $t_ok = $false; $t_fail += "evidence exec: $($_.Exception.Message)" }
if ($t_ok) { $lines.Add("[test-contract] TEST_PASS (3 modes/schema-keys=top+metrics+coverage)"); $pass++ } else { $lines.Add("[test-contract] TEST_FAIL: $($t_fail -join '; ')"); $failC++ }
}

# ---------- 4) test-sorting：Score 契约（需网络；U-146 无传输连通时显式 SKIP） ----------
if ($LocalOnly) { $lines.Add("[test-sorting] TEST_SKIP (LocalOnly; network required)"); $skipC++ }
elseif (-not $t_networkProbe.Available) { $lines.Add("[test-sorting] TEST_SKIP (network unavailable; $($t_networkProbe.Reason))"); $skipC++ }
else {
$t_ok = $true; $t_fail = @()
try {
    $t_o = (& $mainScript -NoEnvFile -ResearchSources -Keyword "jwt" -Limit 5 -AsJson -NoCache | Out-String | ConvertFrom-Json)
    if ($t_o.results.Count -gt 0) {
        $t_scores = @($t_o.results | ForEach-Object { [double]$_.Score })
        for ($t_i = 1; $t_i -lt $t_scores.Count; $t_i++) {
            if ($t_scores[$t_i] -gt $t_scores[$t_i - 1] + 1e-9) { $t_ok = $false; $t_fail += "score not monotonic at idx $t_i" }
        }
        foreach ($t_s in $t_scores) {
            if ($t_s -lt 0 -or $t_s -gt 1.0001) { $t_ok = $false; $t_fail += "score out of range: $t_s"; break }
        }
    }
    if (-not $t_o.context) { $t_ok = $false; $t_fail += "context missing in AsJson" }
} catch { $t_ok = $false; $t_fail += "exec: $($_.Exception.Message)" }
if ($t_ok) { $lines.Add("[test-sorting] TEST_PASS"); $pass++ } else { $lines.Add("[test-sorting] TEST_FAIL: $($t_fail -join '; ')"); $failC++ }
}

# ---------- 5) test-retry：403 限流重试语义（需 Python mock；不可用 SKIP） ----------
$t_ok = $true; $t_fail = @(); $t_skipped = $false
$t_skipReason = ("python mock unavailable: python not started; env-proxy={0} edition={1}" -f (Get-ProcessProxyEnvSummary), $PSVersionTable.PSEdition)   # U-42：SKIP 必须带原因
# v1.36.3（P2）：去掉硬编码个人路径；优先 $env:MCPS_TEST_PYTHON，否则 PATH 上的 python
$t_py = if ($env:MCPS_TEST_PYTHON -and (Test-Path $env:MCPS_TEST_PYTHON)) { $env:MCPS_TEST_PYTHON } else { "python" }
# U-96（N-30，2026-09-26）：桩状态隔离 + 实例校验。此前固定端口 18986/18987/18988 且不校验实例 ⇒ 上一次/变异副本残留的桩
#   会把 /429then200 的 429 配额吃光 ⇒ 本次直接 200、retries=0 ⇒ **非确定性假失败**（宿主实测：单独跑 PASS、连跑 FAIL）。
#   现在：① 端口由桩进程自行绑定 0（OS 分配空闲端口）并写就绪文件；② 每个响应带 X-MCPS-Stub-Run: <本次 run-id>，
#   就绪探测断言"连的是本次实例"，不是 ⇒ 明确 FAIL（不是 SKIP、不是静默失败在退避断言上）；③ 结束写停止文件 + Stop-Process 双保险。
#   $env:MCPS_TEST_STUB_PORTS="a,b,c" 可钉死端口（仅供负例：先在旧端口起陈旧桩，本组必须报"非本次实例"）。
$t_runId = [guid]::NewGuid().ToString('N').Substring(0, 12)
$t_portA = 0; $t_portB = 0; $t_portC = 0
$t_pinned = @()
if ($env:MCPS_TEST_STUB_PORTS) { $t_pinned = @($env:MCPS_TEST_STUB_PORTS -split '[,\s]+' | Where-Object { $_ } | ForEach-Object { [int]$_ }); if ($t_pinned.Count -ne 3) { $t_pinned = @() } }
if ($t_pinned.Count -eq 3) { $t_portA = $t_pinned[0]; $t_portB = $t_pinned[1]; $t_portC = $t_pinned[2] }
$t_mockPy = Join-Path ([System.IO.Path]::GetTempPath()) "mcps_mock403_$PID.py"   # v1.37.3 X-2：$env:TEMP 在 Linux 为空
$t_readyFile = Join-Path ([System.IO.Path]::GetTempPath()) "mcps_mock403_$PID.ready.json"
$t_stopFile = Join-Path ([System.IO.Path]::GetTempPath()) "mcps_mock403_$PID.stop"
$t_pyPorts = if ($t_pinned.Count -eq 3) { "$($t_pinned[0]),$($t_pinned[1]),$($t_pinned[2])" } else { "0,0,0" }
@"
import threading, time, json, os
from http.server import BaseHTTPRequestHandler, HTTPServer
RUN_ID = '$t_runId'
READY = r'$t_readyFile'
STOP = r'$t_stopFile'
WANT = [int(x) for x in '$t_pyPorts'.split(',')]
class Tagged(BaseHTTPRequestHandler):
    def end_headers(self):   # U-96：每个响应都带本次实例标识
        self.send_header('X-MCPS-Stub-Run', RUN_ID)
        BaseHTTPRequestHandler.end_headers(self)
class RL(Tagged):
    def do_GET(self):
        if self.path in ('/429', '/500'):
            self.send_response(int(self.path[1:])); self.send_header('Retry-After','1'); self.end_headers()
            self.wfile.write(b'retry fixture')
            return
        if self.path == '/429big':   # U-24：超大 Retry-After 必须快速失败（v1.28.1 MaxRetryWaitSec 上限）
            self.send_response(429); self.send_header('Retry-After','99999'); self.end_headers()
            self.wfile.write(b'retry fixture big'); return
        if self.path == '/observe':   # U-88：凭据泄漏负例 —— 桩故意回敏感头 + 治理头，-ObserveHeaders 输出只能含后者
            self.send_response(200)
            for k, v in (('Authorization', 'Bearer leak-me-if-you-can'), ('Set-Cookie', 'sid=leak; HttpOnly'), ('X-Auth-Token', 'leak-token'), ('PRIVATE-TOKEN', 'leak-glpat'),
                         ('X-RateLimit-Limit', '10'), ('X-RateLimit-Remaining', '9'), ('Deprecation', 'true'), ('Sunset', 'Sat, 27 Sep 2026 00:00:00 GMT')):
                self.send_header(k, v)
            self.end_headers(); self.wfile.write(b'{"ok":true}'); return
        if self.path == '/429then200':   # U-24：前 2 次 429、之后 200 —— 端到端"退避后成功"
            RL.n429 = getattr(RL, 'n429', 0) + 1
            if RL.n429 <= 2:
                self.send_response(429); self.send_header('Retry-After','1'); self.end_headers(); self.wfile.write(b'wait'); return
            self.send_response(200); self.end_headers(); self.wfile.write(b'{"ok":true}'); return
        self.send_response(403); self.send_header('Retry-After','1'); self.send_header('x-ratelimit-remaining','0'); self.end_headers()
        self.wfile.write(b'You have exceeded a secondary rate limit')
    def log_message(self,*a): pass
class Plain(Tagged):
    def do_GET(self):
        self.send_response(403); self.end_headers(); self.wfile.write(b'Forbidden')
    def log_message(self,*a): pass
class BodyRL(Tagged):
    def do_GET(self):
        self.send_response(403); self.end_headers()
        self.wfile.write(b'You have exceeded a secondary rate limit')
    def log_message(self,*a): pass
info = {'runId': RUN_ID, 'pid': os.getpid(), 'ports': [], 'error': None}
try:
    servers = [HTTPServer(('127.0.0.1', WANT[i]), h) for i, h in enumerate((RL, Plain, BodyRL))]
    info['ports'] = [s.server_address[1] for s in servers]
    for s in servers:
        threading.Thread(target=s.serve_forever, daemon=True).start()
except Exception as e:   # 端口被占（钉死端口 + 陈旧桩）等：如实写进就绪文件，由 PS 侧据此报"非本次实例"
    info['error'] = repr(e)
with open(READY, 'w', encoding='utf-8') as f:
    json.dump(info, f)
deadline = time.time() + 600
while time.time() < deadline and not os.path.exists(STOP):   # U-96：停止文件 ⇒ 自行退出（Stop-Process 之外的第二道回收）
    time.sleep(0.25)
"@ | Out-File -Encoding utf8 $t_mockPy
$t_p = $null
try {
    # -WindowStyle 仅 Windows 支持（PS7 非 Windows 上会抛参数不支持）
    $t_spArgs = @{ FilePath = $t_py; ArgumentList = $t_mockPy; PassThru = $true; ErrorAction = 'SilentlyContinue' }
    if ($PSVersionTable.PSEdition -ne 'Core' -or $IsWindows) { $t_spArgs['WindowStyle'] = 'Hidden' }
    $t_p = Start-Process @t_spArgs
    # U-96：等就绪文件（≤5s），从中取 OS 分配的端口；钉死端口时端口已知，就绪文件只用来拿 error
    $t_ready = $null; $t_waitSw = [System.Diagnostics.Stopwatch]::StartNew()
    while ($t_waitSw.ElapsedMilliseconds -lt 5000 -and -not $t_ready) {
        if (Test-Path -LiteralPath $t_readyFile) { try { $t_ready = Get-Content -LiteralPath $t_readyFile -Raw | ConvertFrom-Json } catch { $t_ready = $null } }
        if (-not $t_ready) { Start-Sleep -Milliseconds 100 }
    }
    if ($t_ready -and -not $t_ready.error -and @($t_ready.ports).Count -eq 3) { $t_portA = [int]$t_ready.ports[0]; $t_portB = [int]$t_ready.ports[1]; $t_portC = [int]$t_ready.ports[2] }
    $t_stubErr = if ($t_ready -and $t_ready.error) { [string]$t_ready.error } elseif (-not $t_ready) { 'ready-file not written within 5s' } else { '' }
    $t_up = $false; $t_instanceOk = $false; $t_seenRun = ''
    # U-42 / N-19：就绪探测走**真直连**（PS 7 下裸 Invoke-WebRequest 会读 HTTP_PROXY，代理死掉 ⇒ 无 Response ⇒ 整组静默 SKIP、丢 403 重试断言）
    $t_probeErr = ''
    if ($t_portA -gt 0) {
        try { $null = Invoke-WebRequestDirect -Params @{ Uri = "http://127.0.0.1:$t_portA/probe"; Headers = @{}; UseBasicParsing = $true; TimeoutSec = 3; ErrorAction = 'Stop' } -Direct }
        catch {
            if ($_.Exception.Response) {
                $t_up = $true
                # U-96：实例校验 —— 响应头 X-MCPS-Stub-Run 必须等于本次 run-id（PS5.1 WebResponse / PS7 HttpResponseMessage 两种取法）
                try {
                    $t_resp = $_.Exception.Response
                    if ($t_resp.Headers -is [System.Net.WebHeaderCollection]) { $t_seenRun = [string]$t_resp.Headers['X-MCPS-Stub-Run'] }
                    else { $t_vals = $null; if ($t_resp.Headers.TryGetValues('X-MCPS-Stub-Run', [ref]$t_vals)) { $t_seenRun = [string](@($t_vals)[0]) } }
                } catch { $t_seenRun = '' }
                $t_instanceOk = ($t_seenRun -eq $t_runId)
            } else { $t_probeErr = ("$_" -replace '\s+', ' ') }
        }
    }
    if (-not $t_up) { $t_skipped = $true; $t_skipReason = ("python mock unavailable: probe-error=[{0}] stub-error=[{1}] env-proxy={2} edition={3}" -f $t_probeErr.Substring(0, [Math]::Min(100, $t_probeErr.Length)), $t_stubErr, (Get-ProcessProxyEnvSummary), $PSVersionTable.PSEdition) }
    elseif (-not $t_instanceOk) {
        # U-96：连到了**非本次实例**（陈旧桩 / 别的进程）⇒ 明确失败并说明，绝不继续跑退避断言（那会产出 N-30 那种假红/假绿）
        $t_ok = $false
        $t_fail += ("U-96 stub instance mismatch: port {0} answered with X-MCPS-Stub-Run=[{1}] but this run is [{2}] (stale stub from another run? stub-error=[{3}])" -f $t_portA, $t_seenRun, $t_runId, $t_stubErr)
    }
    else {
        [System.AppDomain]::CurrentDomain.SetData('mcps_retries', ([int[]]::new(1)))
        [System.AppDomain]::CurrentDomain.SetData('mcps_ratelimited', ([int[]]::new(1)))
        try { Invoke-ApiRequest -Uri "http://127.0.0.1:$t_portA/t" -Headers @{} -TimeoutSec 5 -NoProxy | Out-Null } catch { }
        $t_rc = [System.AppDomain]::CurrentDomain.GetData('mcps_retries')
        $t_rA = if ($t_rc) { $t_rc[0] } else { 0 }
        if ($t_rA -lt 1) { $t_ok = $false; $t_fail += "rate-limit 403 not retried (retries=$t_rA)" }
        # v1.36.3（P0-5）：限流计数进 AppDomain 共享键
        $t_rl = [System.AppDomain]::CurrentDomain.GetData('mcps_ratelimited')
        $t_rlN = if ($t_rl) { $t_rl[0] } else { 0 }
        if ($t_rlN -lt 1) { $t_ok = $false; $t_fail += "rate-limit 403 not counted in mcps_ratelimited (n=$t_rlN)" }
        # U-02：仅正文含 secondary rate limit（无 Retry-After / remaining）时，同样须读体、重试并计数。
        [System.AppDomain]::CurrentDomain.SetData('mcps_retries', ([int[]]::new(1)))
        [System.AppDomain]::CurrentDomain.SetData('mcps_ratelimited', ([int[]]::new(1)))
        try { Invoke-ApiRequest -Uri "http://127.0.0.1:$t_portC/t" -Headers @{} -TimeoutSec 5 -NoProxy -MaxAttempts 2 | Out-Null } catch { }
        $t_bodyRetries = [System.AppDomain]::CurrentDomain.GetData('mcps_retries')
        $t_bodyLimited = [System.AppDomain]::CurrentDomain.GetData('mcps_ratelimited')
        if (-not $t_bodyRetries -or $t_bodyRetries[0] -lt 1 -or -not $t_bodyLimited -or $t_bodyLimited[0] -lt 1) {
            $t_bodyDiag = 'no response'
            try { $null = Invoke-WebRequestDirect -Params @{ Uri = "http://127.0.0.1:$t_portC/diag"; UseBasicParsing = $true; TimeoutSec = 3; ErrorAction = 'Stop' } -Direct }
            catch {
                $t_nativeBody = ''
                try { if ($_.Exception.Response.Content) { $t_nativeBody = [string]$_.Exception.Response.Content.ReadAsStringAsync().GetAwaiter().GetResult() } } catch { }
                $t_detail = [string]$_.ErrorDetails.Message
                $t_bodyDiag = "contentLen=$($t_nativeBody.Length) contentMatch=$([bool]($t_nativeBody -match 'secondary rate limit')) detailLen=$($t_detail.Length) detailMatch=$([bool]($t_detail -match 'secondary rate limit'))"
            }
            $t_ok = $false; $t_fail += "body-only 403 must retry and count (retries=$($t_bodyRetries[0]) limited=$($t_bodyLimited[0]); $t_bodyDiag)"
        }
        $t_respB = $null
        # U-42 补完（宿主，2026-09-26）：本处原是裸 cmdlet Invoke-WebRequest ⇒ PS 7 会读 HTTP_PROXY；代理失效时无 Response
        # ⇒ "plain 403 no response" 整组 FAIL（rc=1）。改走真直连后，loopback 桩不再受进程级代理影响（与就绪探测同型）。
        try { Invoke-WebRequestDirect -Params @{ Uri = "http://127.0.0.1:$t_portB/t"; Headers = @{}; UseBasicParsing = $true; TimeoutSec = 5; ErrorAction = 'Stop' } -Direct | Out-Null }
        catch { $t_respB = $_.Exception.Response }
        if ($null -eq $t_respB) { $t_ok = $false; $t_fail += "plain 403 no response" }
        elseif (Test-RateLimit403 -Resp $t_respB) { $t_ok = $false; $t_fail += "plain 403 misjudged as rate-limit" }
        # 已有的 429 / >=500 重试不应被 U-01/U-02 的跨版本响应归一化破坏。
        foreach ($t_statusCase in @(429, 500)) {
            [System.AppDomain]::CurrentDomain.SetData('mcps_retries', ([int[]]::new(1)))
            try { Invoke-ApiRequest -Uri "http://127.0.0.1:$t_portA/$t_statusCase" -Headers @{} -TimeoutSec 5 -NoProxy -MaxAttempts 2 | Out-Null } catch { }
            $t_otherRetries = [System.AppDomain]::CurrentDomain.GetData('mcps_retries')
            if (-not $t_otherRetries -or $t_otherRetries[0] -lt 1) { $t_ok = $false; $t_fail += "HTTP $t_statusCase retry regressed" }
        }
        # ---- U-24（Wave C，2026-09-26）：真实 429 端到端 · 离线桩层（-NoProxy：N-16/N-19 同型）。退避必须**可观测且按 Cfg 生效**：
        #      (a) 429×2 后 200 ⇒ 最终成功、等待 ≥ Retry-After(1s)、重试计数 ≥ 2；
        #      (b) 恒 429 且 -MaxAttempts 1 ⇒ 不重试、<900ms 抛出、异常带 HTTP 429；
        #      (c) Retry-After=99999 ⇒ 不睡 99999s：在 Cfg.MaxRetryWaitSec+5 内失败（v1.28.1 上限）。
        $t_cfgMinWait = [int]$script:Cfg.RetryMinWaitSec; $t_cfgMaxWait = [int]$script:Cfg.MaxRetryWaitSec
        [System.AppDomain]::CurrentDomain.SetData('mcps_retries', ([int[]]::new(1)))
        $t_sw429 = [System.Diagnostics.Stopwatch]::StartNew(); $t_r429 = $null
        try { $t_r429 = Invoke-ApiRequest -Uri "http://127.0.0.1:$t_portA/429then200" -Headers @{} -TimeoutSec 5 -NoProxy -MaxAttempts 4 } catch { }
        $t_sw429.Stop()
        $t_n429 = [System.AppDomain]::CurrentDomain.GetData('mcps_retries')
        if (-not $t_r429 -or [int]$t_r429.StatusCode -ne 200) { $t_ok = $false; $t_fail += "U-24(a) 429×2→200 未成功 status=$(if ($t_r429) { $t_r429.StatusCode } else { 'null' })" }
        if ($t_sw429.Elapsed.TotalSeconds -lt [Math]::Max(1, $t_cfgMinWait)) { $t_ok = $false; $t_fail += ("U-24(a) 退避未等待 Retry-After：{0:N2}s" -f $t_sw429.Elapsed.TotalSeconds) }
        if (-not $t_n429 -or $t_n429[0] -lt 2) { $t_ok = $false; $t_fail += "U-24(a) 重试计数应≥2，实得 $(if ($t_n429) { $t_n429[0] } else { 0 })" }
        $t_swOne = [System.Diagnostics.Stopwatch]::StartNew(); $t_msgOne = ''
        try { Invoke-ApiRequest -Uri "http://127.0.0.1:$t_portA/429" -Headers @{} -TimeoutSec 5 -NoProxy -MaxAttempts 1 | Out-Null } catch { $t_msgOne = "$_" }
        $t_swOne.Stop()
        if ($t_msgOne -notmatch '429') { $t_ok = $false; $t_fail += "U-24(b) MaxAttempts 1 应抛带 429 的异常：[$t_msgOne]" }
        # U-292（v1.72.0，全量验收 F3）：**绝对阈值 900ms 在负载下会假红** —— 2026-10-28 实测同一断言
        #   空载 8ms、与另一套件串跑时 2021ms，而重试计数与报文都对（不是退避）。机器卡顿与"真的睡了退避"
        #   唯一的区别是**它只加在这一条上**，所以判据改成同轮对照：同桩同端口同代码路径，一个 200、一个 429，
        #   各测 3 次取最小。卡顿对两侧同向放大（差值不变）；真退避只加给 429 侧（差值 ≥ Retry-After ≈ 1s）。
        #   ★阈值 700ms 的依据：Retry-After=1s（下面 (a) 就是按它断言的），留 300ms 给抖动。
        $t_ctlMin = [int]::MaxValue; $t_bMin = [int]::MaxValue
        for ($t_k = 1; $t_k -le 3; $t_k++) {
            $t_c = [System.Diagnostics.Stopwatch]::StartNew()
            try { Invoke-ApiRequest -Uri "http://127.0.0.1:$t_portA/429then200" -Headers @{} -TimeoutSec 5 -NoProxy -MaxAttempts 1 | Out-Null } catch { }
            $t_c.Stop()
            $t_b = [System.Diagnostics.Stopwatch]::StartNew()
            try { Invoke-ApiRequest -Uri "http://127.0.0.1:$t_portA/429" -Headers @{} -TimeoutSec 5 -NoProxy -MaxAttempts 1 | Out-Null } catch { }
            $t_b.Stop()
            if ($t_c.ElapsedMilliseconds -lt $t_ctlMin) { $t_ctlMin = $t_c.ElapsedMilliseconds }
            if ($t_b.ElapsedMilliseconds -lt $t_bMin) { $t_bMin = $t_b.ElapsedMilliseconds }
        }
        if (($t_bMin - $t_ctlMin) -ge 700) { $t_ok = $false; $t_fail += ("U-24(b) MaxAttempts 1 不应退避：429 比同轮 200 对照多 {0}ms（429={1}ms / ctl={2}ms，各取 3 次最小值）" -f ($t_bMin - $t_ctlMin), $t_bMin, $t_ctlMin) }
        $t_swBig = [System.Diagnostics.Stopwatch]::StartNew(); $t_msgBig = ''
        try { Invoke-ApiRequest -Uri "http://127.0.0.1:$t_portA/429big" -Headers @{} -TimeoutSec 5 -NoProxy -MaxAttempts 2 | Out-Null } catch { $t_msgBig = "$_" }
        $t_swBig.Stop()
        if ($t_swBig.Elapsed.TotalSeconds -gt ($t_cfgMaxWait + 5)) { $t_ok = $false; $t_fail += ("U-24(c) 超大 Retry-After 未快速失败：{0:N1}s > MaxRetryWaitSec {1}+5" -f $t_swBig.Elapsed.TotalSeconds, $t_cfgMaxWait) }
        if ($t_msgBig -notmatch '429') { $t_ok = $false; $t_fail += "U-24(c) 应以 429 失败：[$t_msgBig]" }
        $lines.Add(("[test-retry/U-24] 429 e2e (stub, -NoProxy) a={0:N2}s/retries={1} b={2}ms b-min={3}ms ctl-min={4}ms c={5:N1}s minWait={6} maxWait={7} env-proxy={8}" -f $t_sw429.Elapsed.TotalSeconds, $(if ($t_n429) { $t_n429[0] } else { 0 }), $t_swOne.ElapsedMilliseconds, $t_bMin, $t_ctlMin, $t_swBig.Elapsed.TotalSeconds, $t_cfgMinWait, $t_cfgMaxWait, (Get-ProcessProxyEnvSummary)))
        $lines.Add(("[test-retry/U-96] stub run={0} ports={1},{2},{3} instance-verified=True" -f $t_runId, $t_portA, $t_portB, $t_portC))
        # ---- U-88（R23）：-ObserveHeaders 凭据泄漏**负例**：桩回 Authorization/Set-Cookie/X-Auth-Token/PRIVATE-TOKEN + X-RateLimit-*/Deprecation/Sunset
        #      ⇒ 输出（JSON 全文）**不得**含任何敏感头名或其值；正例：X-RateLimit-Limit=10 与 Deprecation/Sunset 必须出现（白名单没被误收窄）。
        $t_obsRaw = ''
        try { $t_obsRaw = (& $mainScript -NoEnvFile -ObserveHeaders "http://127.0.0.1:$t_portA/observe" -AsJson 2>&1 | Out-String) } catch { $t_obsRaw = "EXC: $($_.Exception.Message)" }
        $t_obsJson = $null
        try { $t_b = $t_obsRaw.IndexOf('{'); $t_e = $t_obsRaw.LastIndexOf('}'); if ($t_b -ge 0 -and $t_e -gt $t_b) { $t_obsJson = $t_obsRaw.Substring($t_b, $t_e - $t_b + 1) | ConvertFrom-Json } } catch { }
        if (-not $t_obsJson -or $t_obsJson.mode -ne 'observe-headers') { $t_ok = $false; $t_fail += "U-88 -ObserveHeaders 无 JSON 输出: $($t_obsRaw.Substring(0, [Math]::Min(160, $t_obsRaw.Length)))" }
        else {
            foreach ($t_leak in @('Authorization', 'Set-Cookie', 'X-Auth-Token', 'PRIVATE-TOKEN', 'leak-me-if-you-can', 'sid=leak', 'leak-token', 'leak-glpat')) {
                if ($t_obsRaw -match [regex]::Escape($t_leak)) { $t_ok = $false; $t_fail += "U-88 凭据/敏感头泄漏到输出: $t_leak" }
            }
            $t_obsH = $t_obsJson.observe.headers
            if ("$($t_obsH.'X-RateLimit-Limit')" -ne '10') { $t_ok = $false; $t_fail += "U-88 正例失败：X-RateLimit-Limit 应为 10，实得 [$($t_obsH.'X-RateLimit-Limit')]" }
            if (-not $t_obsH.Deprecation -or -not $t_obsH.Sunset) { $t_ok = $false; $t_fail += "U-88 正例失败：Deprecation/Sunset 未透出" }
            $lines.Add(("[test-retry/U-88] observe-headers leak-check ok: whitelisted={0} http={1}" -f @($t_obsH.PSObject.Properties).Count, $t_obsJson.observe.http))
        }
    }
}
catch { $t_ok = $false; $t_fail += "exec: $($_.Exception.Message)" }
finally {
    # U-96：显式回收 —— 停止文件（桩自行退出）+ Stop-Process + 等待退出 + 清理临时文件；回收失败要说出来（不静默）
    try { [System.IO.File]::WriteAllText($t_stopFile, 'stop') } catch { }
    if ($t_p) {
        Stop-Process -Id $t_p.Id -Force -ErrorAction SilentlyContinue
        try { if (-not $t_p.WaitForExit(3000)) { $lines.Add("[test-retry/U-96] WARN stub pid=$($t_p.Id) did not exit within 3s") } } catch { }
    }
    foreach ($t_tmp in @($t_mockPy, $t_readyFile, $t_stopFile)) { try { [System.IO.File]::Delete($t_tmp) } catch { } }
}
if ($t_skipped) { $lines.Add("[test-retry] TEST_SKIP ($t_skipReason)"); $skipC++ }
elseif ($t_ok) { $lines.Add("[test-retry] TEST_PASS"); $pass++ }
else { $lines.Add("[test-retry] TEST_FAIL: $($t_fail -join '; ')"); $failC++ }

# ---------- 6) test-observe：v1.21.0 静默失败可观测化 + -Doctor（纯本地+契约，需网络的部分降级 SKIP） ----------
if ($LocalOnly) { $lines.Add("[test-observe] TEST_SKIP (LocalOnly)"); $skipC++ }
else {
$t_ok = $true; $t_fail = @(); $t_skipped = $false
# 6a) -Doctor JSON 契约
try {
    $t_doc = (& $mainScript -NoEnvFile -Doctor -AsJson | Out-String | ConvertFrom-Json)
    if ($t_doc.mode -ne 'doctor') { $t_ok = $false; $t_fail += "doctor.mode != doctor" }
    elseif (-not $t_doc.doctor.tools -or -not $t_doc.doctor.tokens) { $t_ok = $false; $t_fail += "doctor.tools/tokens missing" }
} catch { $t_ok = $false; $t_fail += "doctor exec: $($_.Exception.Message)" }
# 6b) 代码证据：无 GITHUB_TOKEN 环境 → GitHubCode auth_missing + ExitCode 3（r2 修复验收）
$t_hadGh = [bool]$env:GITHUB_TOKEN
try {
    if (-not $t_hadGh) {
        $t_ev = (& $mainScript -NoEnvFile -CodeEvidence -Keyword "session_alert" -Limit 3 -AsJson -NoCache | Out-String | ConvertFrom-Json)
        if (-not $t_ev.coverage) { $t_ok = $false; $t_fail += "evidence coverage missing" }
        elseif ($t_ev.coverage.Blocked -notcontains 'GitHubCode') { $t_ok = $false; $t_fail += "GitHubCode not blocked: $($t_ev.coverage.Blocked -join ',')" }
        elseif ($t_ev.metrics.ExitCode -ne 3) { $t_ok = $false; $t_fail += "ExitCode != 3: $($t_ev.metrics.ExitCode)" }
    }
} catch { $t_ok = $false; $t_fail += "evidence exec: $($_.Exception.Message)" }
# 6c) 本地代码检索缺 rg → LocalCode tool_missing（有 rg 则 SKIP 本子项）
$t_hasRg = [bool](Get-Command rg.exe -ErrorAction SilentlyContinue) -or [bool](Get-Command ugrep.exe -ErrorAction SilentlyContinue)
try {
    if (-not $t_hasRg) {
        $t_tmp = Join-Path ([System.IO.Path]::GetTempPath()) "mcps_t6_$PID"   # v1.37.3 X-2
        New-Item -ItemType Directory -Path $t_tmp -Force | Out-Null
        $t_ev2 = (& $mainScript -NoEnvFile -CodeEvidence -LocalCodeSearch -Keyword "never_found_xyz" -Limit 2 -LocalPath $t_tmp -AsJson -NoCache | Out-String | ConvertFrom-Json)
        $t_lcBlocked = @($t_ev2.coverage.Blocked | Where-Object { $_ -eq 'LocalCode' }).Count
        $t_lcExecuted = @($t_ev2.coverage.Executed | Where-Object { $_ -eq 'LocalCode' }).Count
        if ($t_lcBlocked -lt 1 -and $t_lcExecuted -lt 1) { $t_ok = $false; $t_fail += "LocalCode neither blocked nor executed: blocked=$($t_ev2.coverage.Blocked -join ',') executed=$($t_ev2.coverage.Executed -join ',')" }
        elseif ($t_ev2.metrics.ExitCode -lt 2) { $t_ok = $false; $t_fail += "ExitCode < 2: $($t_ev2.metrics.ExitCode)" }
        Remove-Item $t_tmp -Force -ErrorAction SilentlyContinue
    }
} catch { $t_ok = $false; $t_fail += "local exec: $($_.Exception.Message)" }
# 6d) repo 检索 coverage 契约（Codeberg 单平台，无需 token）
try {
    $t_repo = (& $mainScript -NoEnvFile -Platform Codeberg -Keyword "react" -MinStars 0 -Limit 2 -AsJson -NoCache | Out-String | ConvertFrom-Json)
    if (-not $t_repo.coverage) { $t_ok = $false; $t_fail += "repo coverage missing" }
    elseif ($t_repo.coverage.Verdict -ne 'full') { $t_ok = $false; $t_fail += "repo verdict: $($t_repo.coverage.Verdict)" }
} catch { $t_ok = $false; $t_fail += "repo exec: $($_.Exception.Message)" }
# 6e) v1.37.1（N-1）：本地二进制探测目录 = bin/ + tools/bin/，bin/ 优先（纯本地，临时 ScriptDir 下放空桩文件）
$t_bin = 'n/a'
$t_saveSD = $ScriptDir
$t_sd = Join-Path ([System.IO.Path]::GetTempPath()) "mcps_t6e_$PID"
try {
    # v1.37.3：造目录用逐级 Join-Path（与实现的写法无关，按真实部署形状）
    # U-140（2026-09-29）：选择器现在按平台取候选名（非 Windows 为 rg，无 .exe）并对每个候选探活；本组只验目录优先级 ⇒ 探活用桩替身（恒真），
    # 探活本身由 6e-2 负例（恒假 ⇒ $null ⇒ tool_missing 路径）与 Node 门 U-140 覆盖
    $t_rgName = if (($null -ne $IsWindows) -and (-not $IsWindows)) { 'rg' } else { 'rg.exe' }
    $t_origAlive = (Get-Item function:Test-LocalBinaryAlive).ScriptBlock
    Set-Item function:Test-LocalBinaryAlive -Value { param($Path) $true }
    $t_sdTools = Join-Path (Join-Path $t_sd 'tools') 'bin'
    New-Item -ItemType Directory -Path $t_sdTools -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $t_sdTools $t_rgName) -Value 'stub'
    $ScriptDir = $t_sd
    $t_r1 = Find-LocalSearchBinary
    $t_sdBin = Join-Path $t_sd 'bin'
    New-Item -ItemType Directory -Path $t_sdBin -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $t_sdBin $t_rgName) -Value 'stub'
    $t_r2 = Find-LocalSearchBinary
    # 6e-2（U-140 负例）：探活恒假 ⇒ 桩与 PATH 候选都被拒 ⇒ 必须返回 $null（调用方据此报 tool_missing，而不是 zero-hit）
    Set-Item function:Test-LocalBinaryAlive -Value { param($Path) $false }
    $t_r3 = Find-LocalSearchBinary
    Set-Item function:Test-LocalBinaryAlive -Value $t_origAlive
    if ($t_r1 -ne (Join-Path $t_sdTools $t_rgName)) { $t_ok = $false; $t_fail += "N-1: 仅 tools/bin 有 rg 时返回 '$t_r1'" }
    elseif ($t_r2 -ne (Join-Path $t_sdBin $t_rgName)) { $t_ok = $false; $t_fail += "N-1: bin 与 tools/bin 都有时返回 '$t_r2'（应为 bin/）" }
    elseif ($null -ne $t_r3) { $t_ok = $false; $t_fail += "U-140: 探活全败仍返回 '$t_r3'（应为 `$null ⇒ tool_missing）" }
    else { $t_bin = 'ok' }
} catch { $t_ok = $false; $t_fail += "N-1 exec: $($_.Exception.Message)" }
finally {
    # 2026-10-02 修：原先这里是**两个连续的 finally**（第二个是孤儿子句）—— PowerShell 一个 try 只认一个 finally，
    # 第二个 `finally { … }` 会被解析成**名叫 finally 的命令**（Parser 不报错，U-85 的 parse-errors 因此看不见），
    # 运行时抛 CommandNotFoundException ⇒ Set-Item 复原与 Remove-Item 清理**都不执行**（%TEMP% 残留 mcps_t6e_<PID>）。
    # 合并为一个 finally，两件事都保住。
    if ($t_origAlive) { Set-Item function:Test-LocalBinaryAlive -Value $t_origAlive }
    $ScriptDir = $t_saveSD
    Remove-Item -LiteralPath $t_sd -Recurse -Force -ErrorAction SilentlyContinue
}
if ($t_ok) { $lines.Add("[test-observe] TEST_PASS (doctor/auth/tool/repo/bin-dirs=$t_bin)"); $pass++ }
else { $lines.Add("[test-observe] TEST_FAIL: $($t_fail -join '; ')"); $failC++ }
}

# ---------- 7) test-denoise：v1.22.0 宽概念降噪（热度惩罚）+ 0 命中诊断（纯本地单元测试，无需网络） ----------
$t_ok = $true; $t_fail = @()
# 7a) Set-UnifiedScore 热度惩罚：具体项目（命中多词+focus）应排热门通识项目前（r1 修复验收）
try {
    $t_hot = [PSCustomObject]@{ Name = 'AutoGPT'; Platform = 'GitHub'; Desc = 'autonomous AI agent framework'; Url = 'x'; Stars = 100000 }
    $t_spec = [PSCustomObject]@{ Name = 'llm-flow-monitor'; Platform = 'GitHub'; Desc = 'monitor LLM flow session alerting console'; Url = 'y'; Stars = 800 }
    $t_oll = [PSCustomObject]@{ Name = 'ollama'; Platform = 'GitHub'; Desc = 'run LLMs locally'; Url = 'z'; Stars = 50000 }
    $t_mono = [PSCustomObject]@{ Name = 'monoscope'; Platform = 'GitHub'; Desc = 'LLM observability monitor'; Url = 'w'; Stars = 500 }
    $t_sortedRaw = @(Set-UnifiedScore -Results @($t_hot, $t_spec, $t_oll, $t_mono) -Keyword "llm flow monitor console" -FocusTerms "session,alert")
    # 展平 Write-Output -NoEnumerate 的"数组的数组"
    $t_sorted = @()
    foreach ($t_i in $t_sortedRaw) { if ($t_i -is [System.Array] -or $t_i -is [System.Collections.IList]) { $t_sorted += @($t_i) } else { $t_sorted += $t_i } }
    $t_names = @($t_sorted | ForEach-Object { $_.Name })
    $t_specIdx = [array]::IndexOf($t_names, 'llm-flow-monitor')
    $t_hotIdx = [array]::IndexOf($t_names, 'AutoGPT')
    if ($t_specIdx -lt 0 -or $t_hotIdx -lt 0 -or $t_specIdx -ge $t_hotIdx) { $t_ok = $false; $t_fail += "排序: $($t_names -join ' -> ') spec=$t_specIdx hot=$t_hotIdx" }
    # MatchTerms/NoiseFlagged 字段契约
    $t_hasMt = $t_sorted[0].PSObject.Properties.Name -contains 'MatchTerms'
    $t_hasNf = $t_sorted[0].PSObject.Properties.Name -contains 'NoiseFlagged'
    if (-not $t_hasMt -or -not $t_hasNf) { $t_ok = $false; $t_fail += "缺 MatchTerms/NoiseFlagged 字段" }
    # 具体项不应被误标噪音
    $t_specObj = $t_sorted | Where-Object { $_.Name -eq 'llm-flow-monitor' }
    if ($t_specObj -and $t_specObj.NoiseFlagged -eq $true) { $t_ok = $false; $t_fail += "具体项误标噪音" }
} catch { $t_ok = $false; $t_fail += "denoise exec: $($_.Exception.Message)" }
# 7b) Build-QueryVariants：r3 主题生成同义/上位词变体；无领域词单 token 至少含 original（合理语义，wider 兜底在 research 分支层）
try {
    $t_v = @(Build-QueryVariants -Keyword "session alerting standard protocol")
    $t_syn = @($t_v | Where-Object { $_.Kind -eq 'synonym' -or $_.Kind -eq 'wider' })
    if ($t_syn.Count -lt 1) { $t_ok = $false; $t_fail += "领域词变体不足: $($t_v.Count)" }
    # 无领域词（纯随机）：至少 original 存在、不崩溃；synonym/wider 允许为空（research 分支用 general/overview 兜底）
    $t_v2 = @(Build-QueryVariants -Keyword "qxjz42wvfn")
    if ($t_v2.Count -lt 1 -or $t_v2[0].Kind -ne 'original') { $t_ok = $false; $t_fail += "无领域词 variants 异常: count=$($t_v2.Count)" }
} catch { $t_ok = $false; $t_fail += "variants exec: $($_.Exception.Message)" }
# 7c) T1-5 source-first code evidence：模拟 RunspacePool SessionStateProxy；文档只有在无源码时才保留（并由主流程警示）。
try {
    $t_docHit = [PSCustomObject]@{ File = 'docs/RunspacePool.md'; Score = 0.99 }
    $t_dataHit = [PSCustomObject]@{ File = 'fixtures/session.json'; Score = 0.98 }
    $t_codeHit = [PSCustomObject]@{ File = 'src/RunspacePool.ps1'; Score = 0.6 }
    $t_codeSelected = @(Select-CodeEvidenceSourceFiles -Results @($t_docHit, $t_dataHit, $t_codeHit))
    if ($t_codeSelected.Count -ne 1 -or $t_codeSelected[0].File -ne 'src/RunspacePool.ps1') {
        $t_ok = $false; $t_fail += 'T1-5 source-first code evidence 首条应为源码'
    }
    $t_docFallback = @(Select-CodeEvidenceSourceFiles -Results @($t_docHit, $t_dataHit))
    if ($t_docFallback.Count -ne 2) { $t_ok = $false; $t_fail += 'T1-5 纯文档兜底不可静默丢失' }
} catch { $t_ok = $false; $t_fail += "code-quality exec: $($_.Exception.Message)" }
if ($t_ok) { $lines.Add("[test-denoise] TEST_PASS (ranking/matchterms/variants/code-quality)"); $pass++ }
else { $lines.Add("[test-denoise] TEST_FAIL: $($t_fail -join '; ')"); $failC++ }

# ---------- 8) test-endpoints：v1.23.0 官方端点 + warnings/rate_limited 契约（网络依赖部分 SKIP） ----------
if ($LocalOnly) { $lines.Add("[test-endpoints] TEST_SKIP (LocalOnly)"); $skipC++ }
else {
$t_ok = $true; $t_fail = @(); $t_skipped = $false
# 8a) -Doctor remoteEngines 契约（grep.app/Sourcegraph 健康 ping 字段存在；探邻居可达性不硬判）
try {
    $t_doc = (& $mainScript -NoEnvFile -Doctor -AsJson | Out-String | ConvertFrom-Json)
    $t_engines = @($t_doc.doctor.remoteEngines)
    $t_engineNames = @($t_engines | ForEach-Object { $_.Engine }) -join ','
    # PS5.1 陷阱：Where-Object 返回标量时 .Count 为 $null（$null -lt 1 = True 误判失败），必须 @() 包裹
    $t_srcCount = @($t_engines | Where-Object { $_.Engine -eq 'Sourcegraph' }).Count
    $t_gaCount = @($t_engines | Where-Object { $_.Engine -eq 'grep.app' }).Count
    if ($t_engines.Count -lt 2) { $t_ok = $false; $t_fail += "remoteEngines < 2: $($t_engines.Count) [engines: $t_engineNames]" }
    elseif ($t_srcCount -lt 1) { $t_ok = $false; $t_fail += "缺 Sourcegraph 健康项 [$t_engineNames]" }
    elseif ($t_gaCount -lt 1) { $t_ok = $false; $t_fail += "缺 grep.app 健康项 [$t_engineNames]" }
} catch { $t_ok = $false; $t_fail += "doctor engines: $($_.Exception.Message)" }
# 8b) coverage/reasons/warnings 契约在 -CodeEvidence 下存在（无 token 环境：Executed 至少含 Sourcegraph 或 grep.app；任一引擎被 Blocked/Degraded 时 Reasons 有解释）
try {
    $t_ev = (& $mainScript -NoEnvFile -CodeEvidence -Keyword "session_alert" -Limit 3 -AsJson -NoCache | Out-String | ConvertFrom-Json)
    if ($null -eq $t_ev.warnings) { $t_ok = $false; $t_fail += "顶层 warnings 缺失" }
    elseif (-not $t_ev.coverage -or -not $t_ev.coverage.Reasons) { $t_ok = $false; $t_fail += "coverage/Reasons 缺失" }
    elseif ($t_ev.coverage.Executed.Count -eq 0 -and $t_ev.coverage.Blocked.Count -eq 0) { $t_ok = $false; $t_fail += "无引擎执行也无阻塞（契约异常）" }
    elseif (-not $env:GITHUB_TOKEN -and $t_ev.coverage.Blocked -notcontains 'GitHubCode') { $t_ok = $false; $t_fail += "无 token 但 GitHubCode 未标 Blocked" }
} catch { $t_ok = $false; $t_fail += "evidence endpoints: $($_.Exception.Message)" }
# 8c) Build-QueryVariants 已在 test-denoise 覆盖（避免重复）；此处验证 warnings[] 数组类型（Get-EngineWarnings 纯函数）
try {
    $t_w = @(Get-EngineWarnings)
    if ($null -eq $t_w) { $t_ok = $false; $t_fail += "Get-EngineWarnings 返回 null" }
} catch { $t_ok = $false; $t_fail += "warnings fn: $($_.Exception.Message)" }
# 8d) v1.36.7：Doctor 令牌三态——不可达 ⇒ Valid=null + Probe=unreachable + remoteBlocked「不可达（无法判定有效性）」（不再误报无效/已撤销）
#     R2（2026-09-30，宿主收口 §6.2）：旧夹具只设 MCPS_PROXY=socks5 死端口 —— 选路是「MCPS_PROXY → HTTP(S)_PROXY → 系统代理 → 直连」逐个探活，
#     死端口只让第一个候选失败，其后的环境/系统代理（企业代理）照样可达 ⇒ 拿到代理的 HTTP 401，8d 随机器红绿（PS 5.1 宿主必红）。
#     新夹具：① -ProxyMode proxy:socks5://127.0.0.1:9（显式模式 = 唯一候选、无环境/系统/直连回退，见 Get-NetworkCandidates）；
#             ② 同时清空 HTTP(S)_PROXY/ALL_PROXY 大小写 8 个变量，finally 逐个复原；
#             ③ 夹具自检：同一模式下 Get-NetworkCandidates 必须恰好 1 个 socks 候选指向 127.0.0.1:9，且对照组（auto + 假 HTTPS_PROXY）必须 >1 个候选
#                —— 自检不过就判 FAIL（夹具失效），绝不静默跑成绿。
$t_unr = 'n/a'
$t_deadProxy = 'proxy:socks5://127.0.0.1:9'
$t_proxyVars = @('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'MCPS_PROXY', 'GITLAB_TOKEN')
$t_saved = @{}; foreach ($t_v in $t_proxyVars) { $t_saved[$t_v] = [Environment]::GetEnvironmentVariable($t_v, 'Process') }
$t_savedMode = $ProxyMode
try {
    foreach ($t_v in $t_proxyVars) { [Environment]::SetEnvironmentVariable($t_v, $null, 'Process') }
    [Environment]::SetEnvironmentVariable('GITLAB_TOKEN', 'mcps-test-unreachable', 'Process')
    $t_glUri = [uri]'https://gitlab.com/api/v4/user'
    $ProxyMode = $t_deadProxy
    $t_cand = @(Get-NetworkCandidates -Target $t_glUri)
    $ProxyMode = 'auto'; [Environment]::SetEnvironmentVariable('HTTPS_PROXY', 'http://127.0.0.1:9', 'Process')
    $t_ctrl = @(Get-NetworkCandidates -Target $t_glUri)
    [Environment]::SetEnvironmentVariable('HTTPS_PROXY', $null, 'Process'); $ProxyMode = $t_savedMode
    $t_c0 = if ($t_cand.Count -gt 0) { [uri]$t_cand[0].ProxyUrl } else { $null }
    if ($t_cand.Count -ne 1 -or $t_cand[0].Kind -ne 'socks' -or -not $t_c0 -or $t_c0.Host -ne '127.0.0.1' -or $t_c0.Port -ne 9) {
        $t_ok = $false; $t_fail += "unreach: 夹具自检失败（显式死代理下候选=$($t_cand.Count) $(@($t_cand | ForEach-Object { $_.Kind + ':' + $_.Source }) -join ',')，应为唯一 socks:127.0.0.1:9）"
    }
    elseif ($t_ctrl.Count -lt 2) { $t_ok = $false; $t_fail += "unreach: 夹具自检对照组失效（auto+HTTPS_PROXY 候选=$($t_ctrl.Count)，应 ≥2）" }
    else {
        $t_d2 = (& $mainScript -NoEnvFile -Doctor -AsJson -ProxyMode $t_deadProxy | Out-String | ConvertFrom-Json)
        $t_gl = @($t_d2.doctor.tokens | Where-Object { $_.Var -eq 'GITLAB_TOKEN' })[0]
        $t_rb = @($t_d2.doctor.remoteBlocked) -join ' | '
        if ($t_gl.Probe -ne 'unreachable') { $t_ok = $false; $t_fail += "unreach: Probe='$($t_gl.Probe)' != unreachable" }
        elseif ($null -ne $t_gl.Valid) { $t_ok = $false; $t_fail += "unreach: Valid=$($t_gl.Valid)（应为 null）" }
        elseif ($t_rb -notmatch 'GITLAB_TOKEN 未探通') { $t_ok = $false; $t_fail += "unreach: remoteBlocked='$t_rb'" }
        elseif ($t_rb -match 'GITLAB_TOKEN 无效') { $t_ok = $false; $t_fail += "unreach: 仍误报无效 '$t_rb'" }
        else { $t_unr = 'ok' }
    }
} catch { $t_ok = $false; $t_fail += "unreach exec: $($_.Exception.Message)" }
finally {
    $ProxyMode = $t_savedMode
    foreach ($t_v in $t_proxyVars) { [Environment]::SetEnvironmentVariable($t_v, $t_saved[$t_v], 'Process') }
}
if ($t_ok) { $lines.Add("[test-endpoints] TEST_PASS (doctor-engines/coverage-reasons/warnings/unreach=$t_unr)"); $pass++ }
else { $lines.Add("[test-endpoints] TEST_FAIL: $($t_fail -join '; ')"); $failC++ }
}

# ---------- 9) test-docs：文档完整性门禁（纯本地；2026-08-28 P0 换行损伤+版本漂移回归） ----------
# U-292（v1.72.0，全量验收 F2）：字面"反斜杠 + n"的判据必须带**上下文**，不能全文 Contains。
#   病灶：旧判据分不清两种东西 —— ①文档在**描述**一条正则（合法，且是必要的）②换行真的被替换成了两个字符（损伤）。
#   代价（实证）：v1.70.0 在 10-27 带着第 171 行的"描述"红发布；2026-10-28 整改时写注释又踩一次。
#   新判据：围栏代码块内、行内 `代码段` 内 = 合法示例；**正文里出现** = 损伤特征（仍红）。
#   ★为什么仍能抓住真损伤：真损伤会把整段文字压成一行（上面的 9a 行长门直接红），且正文里的工件照样命中这里。
#   判据本体抽成纯函数（输入行数组，输出命中列表），好让 Node 门 U-292 用 AST 抠出来跑同一张真值表。
function Test-LiteralNewlineArtifact {
    param([string[]]$Lines)
    $bs = [char]92; $bt = [char]96; $nn = [char]110   # \ ` n（避免源码里出现真实的转义序列）
    $hits = @()
    $inFence = $false
    for ($i = 0; $i -lt $Lines.Count; $i++) {
        $ln = [string]$Lines[$i]
        if ($ln.TrimStart().StartsWith(([string]$bt) * 3)) { $inFence = -not $inFence; continue }
        if ($inFence) { continue }
        $inCode = $false
        for ($j = 0; $j -lt $ln.Length; $j++) {
            $ch = $ln[$j]
            if ($ch -eq $bt) { $inCode = -not $inCode; continue }
            if ($inCode) { continue }
            if ($ch -eq $bs -and ($j + 1) -lt $ln.Length -and $ln[$j + 1] -eq $nn) {
                $from = [Math]::Max(0, $j - 20)
                $hits += [PSCustomObject]@{ Line = $i + 1; Text = $ln.Substring($from, [Math]::Min(60, $ln.Length - $from)) }
                break
            }
        }
    }
    return $hits
}
$t_ok = $true; $t_fail = @()
$t_BS = [string][char]92   # 反斜杠（避免在源码里写转义）
# 9a) SKILL.md 行长门禁：正文行 >300 字符 = 换行损伤回归；frontmatter description 豁免（另限 agentskills 规范 1024）
try {
    $t_skillFile = (Resolve-Path (Join-Path $testDir '..\SKILL.md')).Path
    $t_skillLines = [System.IO.File]::ReadAllLines($t_skillFile)
    $t_fmEnd = -1
    for ($t_i = 1; $t_i -lt $t_skillLines.Count; $t_i++) { if ($t_skillLines[$t_i].Trim() -eq '---') { $t_fmEnd = $t_i; break } }
    if ($t_fmEnd -lt 0) { $t_ok = $false; $t_fail += "SKILL.md frontmatter 未闭合" }
    else {
        foreach ($t_l in $t_skillLines[($t_fmEnd + 1)..($t_skillLines.Count - 1)]) {
            if ($t_l.Length -gt 300) { $t_ok = $false; $t_fail += ("SKILL.md 正文超长行 {0} 字符（换行损伤回归）: {1}..." -f $t_l.Length, $t_l.Substring(0, [Math]::Min(40, $t_l.Length))); break }
        }
        $t_desc = $t_skillLines | Where-Object { $_ -like 'description:*' } | Select-Object -First 1
        if (-not $t_desc) { $t_ok = $false; $t_fail += "SKILL.md 缺 description" }
        elseif ($t_desc.Length -gt 1024) { $t_ok = $false; $t_fail += ("description 超 agentskills 规范上限 1024: {0}" -f $t_desc.Length) }
    }
    # 9b) 字面工件（历史换行损伤特征）—— U-292：带上下文判据，见函数头注
    $t_nlHits = @(Test-LiteralNewlineArtifact -Lines $t_skillLines)
    if ($t_nlHits.Count -gt 0) { $t_ok = $false; $t_fail += ("SKILL.md 正文含字面反斜杠n工件（第 {0} 行）: {1}" -f $t_nlHits[0].Line, $t_nlHits[0].Text) }
    # 判据自检（两向，缺一即红）：它必须能红（正文工件）也能绿（代码段/围栏内示例）。
    #   ★这是"指标必须结构上可失败"的自证 —— 判据退化成恒真时，这里先炸，而不是等下次带红发布。
    $t_nlPos = @(Test-LiteralNewlineArtifact -Lines @('# 标题', ('正文断了' + $t_BS + 'n这里还接着')))
    # ★围栏标记先算成变量再进数组：`([string][char]96) * 3` 直接写在 `@(…)` 里会被 PS 解析成
    #   "字符串数组 × 3"（实测报 `System.Object[] → System.UInt32`），不是语法错，是静默的优先级坑。
    $t_fence3 = ([string][char]96) * 3
    $t_nlNeg = @(Test-LiteralNewlineArtifact -Lines @(('正则 `' + $t_BS + 'r?' + $t_BS + 'n` 生效'), $t_fence3, ('a' + $t_BS + 'nb'), $t_fence3))
    if ($t_nlPos.Count -lt 1) { $t_ok = $false; $t_fail += 'U-292 自检：正文里的字面工件未被判红（判据已退化成恒真）' }
    if ($t_nlNeg.Count -gt 0) { $t_ok = $false; $t_fail += 'U-292 自检：代码段/围栏内的合法示例被误判' }
} catch { $t_ok = $false; $t_fail += "docs exec: $($_.Exception.Message)" }
# 9c) 版本戳单源一致：$VERSION ↔ 脚本头 / 参数速查 / 引擎链
try {
    $t_mainHeadLines = [System.IO.File]::ReadAllLines($mainScript)
    $t_mainHead = $t_mainHeadLines[0]
    if (-not $t_mainHead.Contains('当前 v' + $VERSION)) { $t_ok = $false; $t_fail += ("脚本头版本戳 != v{0}" -f $VERSION) }
    # U-43：标题一致还不够；第 2 行必须有对应版本的变更条目。
    if ($t_mainHeadLines.Length -lt 2 -or -not $t_mainHeadLines[1].StartsWith('# v' + $VERSION + '（')) {
        $t_ok = $false; $t_fail += ("主脚本缺当前 v{0} 的头部变更条目" -f $VERSION)
    }
    $t_csLines = [System.IO.File]::ReadAllLines((Resolve-Path (Join-Path $testDir '..\references\参数速查.md')).Path)
    if (-not $t_csLines[0].Contains('v' + $VERSION)) { $t_ok = $false; $t_fail += ("参数速查.md 版本戳 != v{0}" -f $VERSION) }
    $t_ylHead = [System.IO.File]::ReadAllLines((Resolve-Path (Join-Path $testDir '..\references\引擎链.md')).Path)[0]
    if (-not $t_ylHead.Contains('v' + $VERSION)) { $t_ok = $false; $t_fail += ("引擎链.md 版本戳 != v{0}" -f $VERSION) }
} catch { $t_ok = $false; $t_fail += "version exec: $($_.Exception.Message)" }
# 9d) 参数面集合一致（v1.75.0 起：集合而非计数）：param 块 ↔ 参数速查表格首列，两向点名
try {
    $t_mainText = [System.IO.File]::ReadAllText($mainScript)
    # ★v1.74.0（U-294 连带修）：起点必须锚在**行首的 param(**，不能用 IndexOf 全文找 —— 头部注释里
    #   出现"简单 `param()` 块"这类**散文**是合法的，会被 IndexOf 当成参数块起点，于是注释里的 `$args`/`$false`
    #   被算成参数（实测 42 → 46，判"参数计数不一致"）。锚 line-start 才等于"这里真的是声明"。
    $t_pStart = ([regex]::Match($t_mainText, '(?m)^param\(')).Index
    if ($t_pStart -lt 0) { throw '找不到行首 param( —— 主脚本参数块形状变了' }
    $t_pEnd = $t_mainText.IndexOf("`n)", $t_pStart)
    $t_pRegion = $t_mainText.Substring($t_pStart, $t_pEnd - $t_pStart)
    $t_paramVars = @()
    foreach ($t_pl in ($t_pRegion -split "`n")) {
        $t_d = $t_pl.IndexOf('$')
        if ($t_d -ge 0) {
            $t_name = ''
            for ($t_j = $t_d + 1; $t_j -lt $t_pl.Length; $t_j++) {
                $t_c = $t_pl[$t_j]
                if ([char]::IsLetterOrDigit($t_c) -or $t_c -eq '_') { $t_name += $t_c } else { break }
            }
            if ($t_name) { $t_paramVars += $t_name }
        }
    }
    $t_paramVars = @($t_paramVars | Sort-Object -Unique)
    # ★v1.75.0（U-295）：判据从「计数相等」升级到「**集合相等**」。
    #   旧写法只比 header 里的那个数字与 param 块行数：改名、对换、删一行再加一行都能混过（计数不变）。
    #   现在两向都要报名字：Missing = 代码有文档没登记；Extra = 文档登记了代码没有。
    $t_csDocText = [System.IO.File]::ReadAllText((Resolve-Path (Join-Path $testDir '..\references\参数速查.md')).Path)
    $t_btc = [string][char]96
    $t_docNames = @([regex]::Matches($t_csDocText, ('(?m)^\|\s*' + [regex]::Escape($t_btc) + '-([A-Za-z0-9]+)' + [regex]::Escape($t_btc))) | ForEach-Object { $_.Groups[1].Value })
    $t_cmp = Compare-ParamSurface -Declared $t_paramVars -Documented $t_docNames
    if (-not $t_cmp.Ok) {
        $t_ok = $false
        $t_fail += ("参数面集合不一致：代码有文档缺 [{0}]；文档有代码缺 [{1}]" -f ($t_cmp.Missing -join ','), ($t_cmp.Extra -join ','))
    }
    # header 自述的数字是**第三处**声明（散文），表格对不等于散文对；它必须与 param 块一致。
    $t_declared = 0
    $t_cs5 = ($t_csLines[0..4] -join ' ')
    $t_i1 = $t_cs5.IndexOf([char]96)
    if ($t_i1 -ge 0) {
        $t_i2 = $t_cs5.IndexOf([char]96, $t_i1 + 1)
        if ($t_i2 -gt $t_i1) {
            $t_numStr = ''
            for ($t_j = $t_i1 + 1; $t_j -lt $t_i2; $t_j++) { if ([char]::IsDigit($t_cs5[$t_j])) { $t_numStr += $t_cs5[$t_j] } }
            if ($t_numStr) { $t_declared = [int]$t_numStr }
        }
    }
    if ($t_declared -ne $t_paramVars.Count) { $t_ok = $false; $t_fail += ("参数计数不一致: 参数速查头部自述 {0} vs 脚本实际 {1}" -f $t_declared, $t_paramVars.Count) }
    # U-295 自检（两向，任何一项不成立即红 —— 否则这条判据只是"恒绿装饰"）：
    #   ① 能红：文档把一个名字写错 ⇒ Ok=false 且两向各点名一个；
    #   ② 能绿：同一集合换个顺序 ⇒ Ok=true（不靠顺序）。
    $t_u295red = Compare-ParamSurface -Declared @('Alpha', 'Beta') -Documented @('Alpha', 'Gamma')
    if ($t_u295red.Ok -or ($t_u295red.Missing -notcontains 'Beta') -or ($t_u295red.Extra -notcontains 'Gamma')) {
        $t_ok = $false; $t_fail += 'U-295 自检：改名/对换未被判红（计数口径的盲区没被堵上）'
    }
    $t_u295green = Compare-ParamSurface -Declared @('Alpha', 'Beta') -Documented @('Beta', 'Alpha')
    if (-not $t_u295green.Ok) { $t_ok = $false; $t_fail += 'U-295 自检：同一集合换序被误判' }
} catch { $t_ok = $false; $t_fail += "param-surface exec: $($_.Exception.Message)" }
# 9e) agentskills 规范对齐：name 命名格式（小写字母/数字/连字符）+ metadata.version 与 $VERSION 单源一致
try {
    $t_nameLine = $t_skillLines | Where-Object { $_ -like 'name:*' } | Select-Object -First 1
    if (-not $t_nameLine) { $t_ok = $false; $t_fail += "SKILL.md 缺 name" }
    else {
        $t_nv = $t_nameLine.Split('"')[1]
        if (-not $t_nv) { $t_ok = $false; $t_fail += "name 值缺失" }
        elseif ($t_nv -notmatch '^[a-z0-9-]+$') { $t_ok = $false; $t_fail += ("name 不符合 agentskills 命名规范: {0}" -f $t_nv) }
    }
    $t_mvLine = $t_skillLines | Where-Object { $_ -like '*version:*' } | Select-Object -First 1
    if (-not $t_mvLine -or -not $t_mvLine.Contains($VERSION)) { $t_ok = $false; $t_fail += ("metadata.version != v{0}（SKILL.md frontmatter 版本戳单源）" -f $VERSION) }
} catch { $t_ok = $false; $t_fail += "spec exec: $($_.Exception.Message)" }
# 9f) U-16：原文中的白名单自查命令必须可直接执行；只喂假进程环境值，绝不加载 .env 或输出代理地址。
try {
    $t_trouble = [System.IO.File]::ReadAllText((Resolve-Path (Join-Path $testDir '..\references\故障排查.md')).Path)
    $t_matchProxy = [regex]::Match($t_trouble, '(?s)## MCPS_PROXY 域名白名单治理.*?```powershell\r?\n(.*?)\r?\n```')
    if (-not $t_matchProxy.Success) { $t_ok = $false; $t_fail += 'U-16 白名单自查代码块缺失' }
    else {
        $t_proxyCode = $t_matchProxy.Groups[1].Value
        if ($t_proxyCode -match 'multi-platform-searcher\.ps1|Get-Content|Invoke-WebRequest|\.env') {
            $t_ok = $false; $t_fail += 'U-16 自查代码块不能触碰技能脚本或 .env'
        } else {
            $t_proxyCheck = [scriptblock]::Create($t_proxyCode)
            $t_oldProxy = [Environment]::GetEnvironmentVariable('MCPS_PROXY', 'Process')
            try {
                foreach ($t_case in @(
                    @{ Spec = $null; Mode = 'not-in-process'; GitLab = $false; Gitee = $false },
                    @{ Spec = 'socks5://127.0.0.1:9;gitlab.com'; Mode = 'SOCKS5'; GitLab = $true; Gitee = $false },
                    @{ Spec = 'socks5://127.0.0.1:9'; Mode = 'SOCKS5'; GitLab = $true; Gitee = $true })) {
                    [Environment]::SetEnvironmentVariable('MCPS_PROXY', $t_case.Spec, 'Process')
                    $t_checked = & $t_proxyCheck
                    if ($t_checked.Mode -ne $t_case.Mode -or $t_checked.GitLabCovered -ne $t_case.GitLab -or
                        $t_checked.GiteeCovered -ne $t_case.Gitee) {
                        $t_ok = $false; $t_fail += 'U-16 文档自查命令行为不符（fake env）'
                    }
                }
            } finally { [Environment]::SetEnvironmentVariable('MCPS_PROXY', $t_oldProxy, 'Process') }
        }
    }
} catch { $t_ok = $false; $t_fail += "U-16 自查 exec: $($_.Exception.GetType().Name)" }
# 9h) U-85（N-29，2026-09-26）：编码/解析门 —— 仓内**全部** .ps1（清单 + reports/** + tests/**，排除 _verify/node_modules/.git）
#     ① 必须以 UTF-8 BOM（EF BB BF）开头（PS 5.1 无 BOM 按 ANSI 解码 ⇒ 含中文注释的脚本解析失败，PS 7 侧却是绿的 ⇒ 只在 5.1 可见）；
#     ② 在**当前运行时**用 Parser::ParseFile 断言 0 错并报文件名 + 首条错误。两运行时各跑一次本组即覆盖"两侧"（U-90 runner 会）。
$t_bomBad = @(); $t_parseBad = @(); $t_resvBad = @(); $t_ps1N = 0
try {
    $t_repoRoot = (Resolve-Path (Join-Path $testDir '..')).Path
    # 9h-2) U-85b（2026-10-02）：保留字（finally/catch/try/else/elseif）被解析成**命令名** = 结构错。
    #   典型：一个 try 配了两个 `finally {...}`（第 2 个会变成一条名叫 finally 的命令）。Parser 对此**不报错**，
    #   所以 U-85 的 parse-errors 看不见它；运行时才抛 CommandNotFoundException，并**跳过该 finally 的全部清理**
    #   （实测：run-tests.ps1 第 517 行那处 ⇒ %TEMP% 永久残留 mcps_t6e_<PID>，且 $ScriptDir 不复位）。
    $t_reserved = @('finally', 'catch', 'try', 'else', 'elseif')
    foreach ($t_f in @(Get-ChildItem -LiteralPath $t_repoRoot -Recurse -Filter *.ps1 -File | Where-Object { $_.FullName -notmatch '[\\/](_verify|_archive|node_modules|\.git)[\\/]' })) {
        $t_ps1N++
        $t_rel = $t_f.FullName.Substring($t_repoRoot.Length).TrimStart('\', '/')
        $t_fs = [System.IO.File]::OpenRead($t_f.FullName); $t_head = New-Object byte[] 3; $null = $t_fs.Read($t_head, 0, 3); $t_fs.Close()
        if (-not ($t_head.Length -ge 3 -and $t_head[0] -eq 0xEF -and $t_head[1] -eq 0xBB -and $t_head[2] -eq 0xBF)) { $t_bomBad += $t_rel }
        $t_tok = $null; $t_errs = $null
        $t_ast = [System.Management.Automation.Language.Parser]::ParseFile($t_f.FullName, [ref]$t_tok, [ref]$t_errs)
        if (@($t_errs).Count -gt 0) { $t_parseBad += ("{0} (L{1}: {2})" -f $t_rel, $t_errs[0].Extent.StartLineNumber, $t_errs[0].Message) }
        foreach ($t_c in @($t_ast.FindAll({ param($t_x) ($t_x -is [System.Management.Automation.Language.CommandAst]) -and ($t_reserved -contains $t_x.GetCommandName()) }, $true))) {
            $t_resvBad += ("{0} (L{1}: '{2}')" -f $t_rel, $t_c.Extent.StartLineNumber, $t_c.GetCommandName())
        }
    }
    if ($t_ps1N -lt 10) { $t_ok = $false; $t_fail += "U-85 .ps1 枚举异常：只找到 $t_ps1N 个" }
    if ($t_bomBad.Count) { $t_ok = $false; $t_fail += "U-85 缺 UTF-8 BOM：" + ($t_bomBad -join ', ') }
    if ($t_parseBad.Count) { $t_ok = $false; $t_fail += ("U-85 ParseFile 有错（PS {0}）：" -f $PSVersionTable.PSVersion) + ($t_parseBad -join ' | ') }
    if ($t_resvBad.Count) { $t_ok = $false; $t_fail += "U-85b 保留字被当作命令（结构错）：" + ($t_resvBad -join ', ') }
    $lines.Add(("[test-docs/U-85] ps1={0} bom-missing={1} parse-errors={2} runtime=PS {3}" -f $t_ps1N, $t_bomBad.Count, $t_parseBad.Count, $PSVersionTable.PSVersion))
    $lines.Add(("[test-docs/U-85b] reserved-as-command={0}{1}" -f $t_resvBad.Count, $(if ($t_resvBad.Count) { ' [' + ($t_resvBad -join ', ') + ']' } else { '' })))
    # 9i) U-81：_verify/ 卫生 —— 门自建的临时目录（n9-*/n9neg-*/r2-*/r2neg-*）必须已自清 ⇒ 否则红并列出；其它残留只列出（D-03：留档证据应落 reports/）
    $t_verifyDir = Join-Path $t_repoRoot '_verify'
    if (Test-Path -LiteralPath $t_verifyDir) {
        $t_vAll = @(Get-ChildItem -LiteralPath $t_verifyDir -Force | ForEach-Object { $_.Name })
        $t_vTemp = @($t_vAll | Where-Object { $_ -match '^(n9|n9neg|r2|r2neg|u58)-' })
        $t_vOther = @($t_vAll | Where-Object { $_ -notmatch '^(n9|n9neg|r2|r2neg|u58)-' })
        if ($t_vTemp.Count) { $t_ok = $false; $t_fail += "U-81 _verify/ 有未自清的门临时目录：" + ($t_vTemp -join ', ') }
        $lines.Add(("[test-docs/U-81] _verify temp-leftover={0} other={1}{2}" -f $t_vTemp.Count, $t_vOther.Count, $(if ($t_vOther.Count) { ' [' + ($t_vOther -join ', ') + ']' } else { '' })))
    } else { $lines.Add("[test-docs/U-81] _verify absent (clean)") }
} catch { $t_ok = $false; $t_fail += "U-85/U-81 exec: $($_.Exception.Message)" }
if ($t_ok) { $lines.Add("[test-docs] TEST_PASS (line-len/no-artifact/version-stamps/param-surface/spec/proxy-self-check/bom+parse)"); $pass++ }
else { $lines.Add("[test-docs] TEST_FAIL: $($t_fail -join '; ')"); $failC++ }

# ---------- 10) test-disable：v1.33.0 MCPS_DISABLE 过滤 + 时长预算解析（纯本地） ----------
$t_ok = $true; $t_fail = @()
try {
    $t_codeEngines = @(Get-EngineByKind -Kind 'code')
    # 10a) 无配置：全部保留
    [Environment]::SetEnvironmentVariable('MCPS_DISABLE', $null)
    $t_all = @(Get-EnabledEngines -Engines $t_codeEngines)
    if ($t_all.Count -ne $t_codeEngines.Count) { $t_ok = $false; $t_fail += "无配置应全保留: got $($t_all.Count) want $($t_codeEngines.Count)" }
    # 10b) 按注册名禁用（大小写不敏感）
    $env:MCPS_DISABLE = 'grepapp'
    $t_f1 = @(Get-EnabledEngines -Engines $t_codeEngines)
    if ($t_f1.Count -ne ($t_codeEngines.Count - 1)) { $t_ok = $false; $t_fail += "grepapp 禁用失败: got $($t_f1.Count)" }
    # 10c) 按显示名 + 混合分隔符 + 空白容错
    $env:MCPS_DISABLE = ' grep.app , Sourcegraph ; GitHubCode'
    $t_f2 = @(Get-EnabledEngines -Engines $t_codeEngines)
    if ($t_f2.Count -ne ($t_codeEngines.Count - 3)) { $t_ok = $false; $t_fail += "混合禁用失败: got $($t_f2.Count) want $($t_codeEngines.Count - 3)" }
    # 10d) 禁用警示可审计（10b+10c 累计 4 条，Get-EngineWarnings 排空语义）
    $t_w = @(Get-EngineWarnings)
    if ($t_w.Count -lt 4) { $t_ok = $false; $t_fail += "禁用警示不足: $($t_w.Count)" }
    # 10e) 时长预算解析：默认 120 / 0=不限 / 合法覆盖 / 非法回退
    [Environment]::SetEnvironmentVariable('MCPS_TIME_BUDGET_SEC', $null)
    if ((Get-TimeBudgetSec) -ne 120) { $t_ok = $false; $t_fail += "默认预算 != 120" }
    $env:MCPS_TIME_BUDGET_SEC = '0'
    if ((Get-TimeBudgetSec) -ne 0) { $t_ok = $false; $t_fail += "0 覆盖失败" }
    $env:MCPS_TIME_BUDGET_SEC = '45'
    if ((Get-TimeBudgetSec) -ne 45) { $t_ok = $false; $t_fail += "45 覆盖失败" }
    $env:MCPS_TIME_BUDGET_SEC = 'abc'
    if ((Get-TimeBudgetSec) -ne 120) { $t_ok = $false; $t_fail += "非法值应回退默认" }
}
finally {
    [Environment]::SetEnvironmentVariable('MCPS_DISABLE', $null)
    [Environment]::SetEnvironmentVariable('MCPS_TIME_BUDGET_SEC', $null)
}
if ($t_ok) { $lines.Add("[test-disable] TEST_PASS (filter/alias-case/warnings/budget-parse)"); $pass++ }
else { $lines.Add("[test-disable] TEST_FAIL: $($t_fail -join '; ')"); $failC++ }

# ---------- 11) test-auto：v1.34.0 -Auto 模式映射 + Unit 语义字段声明（纯本地） ----------
$t_ok = $true; $t_fail = @()
try {
    # 11a) Convert-PlanToModes 五分支
    if ((@(Convert-PlanToModes -QueryType 'research_only') -join ',') -ne 'research') { $t_ok = $false; $t_fail += "research_only 映射错" }
    if ((@(Convert-PlanToModes -QueryType 'repository_only') -join ',') -ne 'repo') { $t_ok = $false; $t_fail += "repository_only 映射错" }
    if ((@(Convert-PlanToModes -QueryType 'code_evidence_only') -join ',') -ne 'code') { $t_ok = $false; $t_fail += "code_evidence_only 映射错" }
    if ((@(Convert-PlanToModes -QueryType 'integrated_research_and_code') -join ',') -ne 'repo,code,research') { $t_ok = $false; $t_fail += "integrated 映射错" }
    if ((@(Convert-PlanToModes -QueryType 'unknown-x') -join ',') -ne 'repo') { $t_ok = $false; $t_fail += "未知类型应回退 repo" }
    # 11b) Unit 语义字段声明覆盖（16 个 repo/research 引擎结果均声明 Unit = '...'）
    $t_mainText2 = [System.IO.File]::ReadAllText($mainScript)
    # U-100 门跟随（2026-09-28）：引擎实现已可外置到 engines/*.ps1 ⇒ Unit 声明须在「主脚本 + engines」上合计，
#   否则每搬走一个引擎，这里就会少 1 并误报（C-1~C-4 已致 13<14 的假红）。阈值不变。
$t_engineText2 = ''
$t_engDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'engines'
if (Test-Path -LiteralPath $t_engDir) {
    $t_engineText2 = ((Get-ChildItem -LiteralPath $t_engDir -Filter '*.ps1' -File | Sort-Object Name |
        ForEach-Object { Get-Content -LiteralPath $_.FullName -Raw }) -join "`n")
}
$t_unitCount = [regex]::Matches(($t_mainText2 + $t_engineText2), ('Unit' + [char]32 + '=' + [char]32 + [char]39)).Count
    if ($t_unitCount -lt 14) { $t_ok = $false; $t_fail += ("Unit 声明不足: {0} (期望 >=14)" -f $t_unitCount) }
    # T2-8 planner fixtures：工程词触发 integrated；「类似/同类」不可因单字「类」误触发 code 模式。
    $t_planner = Join-Path (Split-Path -Parent $mainScript) 'query-planner.ps1'
    foreach ($t_case in @(@{ Q = '调研 技能 CI 分发'; Expected = 'integrated_research_and_code' },
                           @{ Q = '找类似项目'; Expected = 'repository_only' },
                           @{ Q = '同类开源项目'; Expected = 'repository_only' })) {
        $t_plan = & $t_planner -Query $t_case.Q | ConvertFrom-Json
        if ($t_plan.queryType -ne $t_case.Expected) { $t_ok = $false; $t_fail += "T2-8 planner fixtures [$($t_case.Q)] got $($t_plan.queryType), expected $($t_case.Expected)" }
    }
    # 11c) U-100-B: registry and integrated planner must match the single catalog, including order.
    $t_catalogPath = Join-Path (Split-Path -Parent $mainScript) 'query-plan.schema.json'
    $t_catalog = ([System.IO.File]::ReadAllText($t_catalogPath) | ConvertFrom-Json).'x-engineCatalog'
    $t_catalogNames = @('repo', 'code', 'research' | ForEach-Object {
        $t_kind = $_
        $t_catalog.PSObject.Properties | Where-Object { $_.Value.kind -eq $t_kind } | ForEach-Object { $_.Name }
    })
    $t_integrated = & $t_planner -Query '调研技能的代码仓库及实现' | ConvertFrom-Json
    $t_registryNames = @($script:_engineRegistry | ForEach-Object { $_.Name })
    $t_candidateNames = @($t_integrated.engineCandidates)
    if ($t_catalogNames.Count -eq 0 -or ($t_registryNames -join ',') -ne ($t_catalogNames -join ',') -or
        ($t_candidateNames -join ',') -ne ($t_catalogNames -join ',')) {
        $t_ok = $false; $t_fail += 'U-100-B registry/planner engineCandidates differ from x-engineCatalog (missing, extra or reordered)'
    }
    # 11d) T2-7 Gitee floor：本地假 so API，低分 darknet 不应混进 -Auto 的 repo 结果；中文高分仍保留。
    $t_giteeJson = @'
{"hits":{"hits":[
 {"_score":100.1,"fields":{"title":["distributed task scheduler"],"description":["task scheduler"],"count.star":[42],"url":["https://gitee.com/demo/scheduler"],"langs":["Java"]}},
 {"_score":90,"fields":{"title":["中文高相关"],"description":["任务调度"],"count.star":[1],"url":["https://gitee.com/demo/chinese"],"langs":["Java"]}},
 {"_score":0.5,"fields":{"title":["darknet portal"],"description":["unrelated"],"count.star":[500],"url":["https://gitee.com/demo/darknet"],"langs":["Java"]}}
]}}
'@
    $t_savedApiFn = (Get-Item Function:Invoke-ApiRequest).ScriptBlock
    $t_oldAsJson = $AsJson
    try {
        $AsJson = $true
        function Invoke-ApiRequest { param($Uri, $Headers, [switch]$NoProxy); return [PSCustomObject]@{ Content = $t_giteeJson; StatusCode = 200; Headers = @{} } }
        $t_giteeFound = @(Search-Gitee -Keyword 'distributed task' -Language '' -MinStars 0 -Limit 5)
        $t_giteeNames = @($t_giteeFound | ForEach-Object { $_.Name })
        if ($t_giteeNames -contains 'darknet portal' -or $t_giteeNames -notcontains 'distributed task scheduler' -or $t_giteeNames -notcontains '中文高相关') {
            $t_ok = $false; $t_fail += "T2-7 Gitee floor 保真/降噪失败：[$($t_giteeNames -join ',')]"
        }
        if (@(Get-EngineByKind -Kind 'repo' | ForEach-Object { $_.Name }) -notcontains 'Gitee') { $t_ok = $false; $t_fail += 'T2-7 -Auto repo 调度不含 Gitee' }
    } finally {
        Set-Item -Path Function:Invoke-ApiRequest -Value $t_savedApiFn
        $AsJson = $t_oldAsJson
    }
} catch { $t_ok = $false; $t_fail += "auto exec: $($_.Exception.Message)" }
if ($t_ok) { $lines.Add("[test-auto] TEST_PASS (plan-modes/unit-declared)"); $pass++ }
else { $lines.Add("[test-auto] TEST_FAIL: $($t_fail -join '; ')"); $failC++ }

# ---------- 12) test-inject：v1.36.3 Runspace 依赖注入 + 令牌桶跨 Runspace 共享（纯本地） ----------
$t_ok = $true; $t_fail = @()
try {
    # 12a) 静态检查：注册表全部引擎（Func+Needs）无未注入的外部变量引用（含 $script: 前缀）
    $t_f = @(Assert-EngineDeps -Engines $script:_engineRegistry)
    if ($t_f.Count -ne 0) { $t_ok = $false; $t_fail += ("Assert-EngineDeps findings={0}: {1}" -f $t_f.Count, ($t_f -join ',')) }
    foreach ($t_v in @('_rlBuckets', '_rlLock')) { if ($script:_injectVars -notcontains $t_v) { $t_ok = $false; $t_fail += "_injectVars 缺 $t_v" } }
    # U-02：真实编排池的依赖闭包须包含 403 识别器；去掉闭包注入会让此本地桩在 Runspace 内失败。
    try {
        function Test-U02Runspace {
            if (Test-RateLimit403 -Resp ([PSCustomObject]@{ Headers = @{ 'x-ratelimit-remaining' = '0' }; Body = '' })) { 'u02-runspace-ok' }
        }
        $t_u02Spec = @{ Name = 'U02-probe'; Func = 'Test-U02Runspace'; Needs = @('Invoke-ApiRequest') }
        $t_u02Got = @(Invoke-EnginePool -Engines @($t_u02Spec) -EngineArgs @{})
        if ($t_u02Got -notcontains 'u02-runspace-ok') { $t_ok = $false; $t_fail += 'U-02 真实 Runspace 缺 Test-RateLimit403 闭包' }
    } finally { Remove-Item -Path Function:Test-U02Runspace -Force -ErrorAction SilentlyContinue }
    # 12b) 运行时：按编排层同样方式（函数文本重建 + _injectVars 注入）起 3 个 Runspace 同时取令牌；
    #      桶 Capacity=1、RefillPerSec=4（0.25s/令牌）⇒ 共享时总耗时应 >= ~0.45s；未共享（旧缺陷）时 ~0s。
    $t_saved = $script:_rlBuckets['mcps-test']
    $script:_rlBuckets['mcps-test'] = @{ Capacity = 1.0; RefillPerSec = 4.0; Tokens = 1.0; Last = $null }
    $t_defs = @("function Wait-RateLimitToken { $((Get-Item function:Wait-RateLimitToken).Definition) }")
    $t_inj = @{}; foreach ($t_k in $script:_injectVars) { $t_inj[$t_k] = Get-Variable -Name $t_k -ValueOnly -ErrorAction SilentlyContinue }
    $t_pool = [runspacefactory]::CreateRunspacePool(1, 3); $t_pool.Open()
    $t_sw = [System.Diagnostics.Stopwatch]::StartNew()
    $t_hs = @()
    foreach ($t_i in 1..3) {
        $t_ps = [powershell]::Create(); $t_ps.RunspacePool = $t_pool
        [void]$t_ps.AddScript({
            param($Defs, $Inject)
            foreach ($d in $Defs) { . ([scriptblock]::Create($d)) }
            foreach ($k in $Inject.Keys) { Set-Variable -Name $k -Value $Inject[$k] }
            Wait-RateLimitToken -Bucket 'mcps-test'
        }).AddArgument($t_defs).AddArgument($t_inj)
        $t_hs += [PSCustomObject]@{ PS = $t_ps; H = $t_ps.BeginInvoke() }
    }
    foreach ($t_h in $t_hs) { [void]$t_h.PS.EndInvoke($t_h.H); $t_h.PS.Dispose() }
    $t_ms = $t_sw.ElapsedMilliseconds
    $t_pool.Close(); $t_pool.Dispose()
    if ($t_saved) { $script:_rlBuckets['mcps-test'] = $t_saved } else { $script:_rlBuckets.Remove('mcps-test') }
    if ($t_ms -lt 450) { $t_ok = $false; $t_fail += ("3 个 Runspace 取令牌总耗时 {0}ms < 450ms ⇒ 令牌桶未跨 Runspace 共享" -f $t_ms) }
    # 12c) 限流计数走 AppDomain 共享键（并发路径不再恒 0）
    $t_src = [System.IO.File]::ReadAllText($mainScript)
    if ($t_src -notmatch "GetData\('mcps_ratelimited'\)") { $t_ok = $false; $t_fail += "RateLimitedCount 未走 AppDomain 共享键" }
    # 12d) v1.36.5（回迁 B v1.34.1）：TLS 兜底路径在顶层解析并注入——Runspace 内 PSScriptRoot 为空，旧实现引擎路径解析失败
    foreach ($t_v in @('NodeEnginePath', 'NodeExePath')) { if ($script:_injectVars -notcontains $t_v) { $t_ok = $false; $t_fail += "_injectVars 缺 $t_v" } }
    $t_np = 'n/a'
    if (Test-Path -LiteralPath (Join-Path (Split-Path -Parent $mainScript) 'tools\node-https-engine.mjs')) {
        if (-not $script:NodeEnginePath) { $t_ok = $false; $t_fail += "tools/node-https-engine.mjs 存在但 NodeEnginePath 为空" }
        else {
            $t_rs = [powershell]::Create()
            [void]$t_rs.AddScript({ param($Inject) foreach ($k in $Inject.Keys) { Set-Variable -Name $k -Value $Inject[$k] }; $script:NodeEnginePath }).AddArgument($t_inj)
            $t_got = @($t_rs.Invoke())[0]; $t_rs.Dispose()
            if ($t_got -ne $script:NodeEnginePath) { $t_ok = $false; $t_fail += "Runspace 内 NodeEnginePath='$t_got'（未注入）" } else { $t_np = 'inj' }
        }
    }
    # 12e) N-9 / X-1：假引擎必须真的由 node 执行；PS 5.1 + PS 7 均验证 TLS 兜底 -d 默认/覆盖值。
    #      连接被拒（127.0.0.1:1）⇒ $resp 为空 ⇒ 走兜底；桩只记录 argv 并回 STATUS 200，不联网。
    # U-40 / N-16b：12e 不再依赖调用环境 —— 进程级 HTTP_PROXY 存在时，-NoProxy 现在会绕过它（Core: IWR -NoProxy；
    #      Desktop: 空 DefaultWebProxy），所以带/不带代理两种环境下结论应一致。这里把代理状态**打印进证据**，
    #      并断言 -NoProxy 请求确实走了直连模式；若仍失败，失败信息带上环境，不得静默假红。
    $t_argv = 'n/a'
    $t_proxyEnv = Get-ProcessProxyEnvSummary
    $lines.Add("[test-inject/12e] env-proxy=$t_proxyEnv edition=$($PSVersionTable.PSEdition)")
    $t_fd = Join-Path ([System.IO.Path]::GetTempPath()) "mcps_t12e_$PID"
    $t_saveExe = $script:NodeExePath; $t_saveEng = $script:NodeEnginePath
    $t_saveCapture = [Environment]::GetEnvironmentVariable('MCPS_T12E_ARGV_FILE', 'Process')
    try {
        New-Item -ItemType Directory -Path $t_fd -Force | Out-Null
        $t_argvFile = Join-Path $t_fd 'argv.txt'
        $t_stub = Join-Path $t_fd 'fake-node.mjs'
        $t_stubSource = @'
import { writeFileSync } from 'node:fs';
const target = process.env.MCPS_T12E_ARGV_FILE;
if (!target) { console.error('missing MCPS_T12E_ARGV_FILE'); process.exit(2); }
writeFileSync(target, process.argv.slice(2).join(' '), 'utf8');
console.log('STATUS 200');
'@
        [System.IO.File]::WriteAllText($t_stub, $t_stubSource, [System.Text.UTF8Encoding]::new($false))
        $t_nodeExe = (Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
        if (-not $t_nodeExe) { $t_ok = $false; $t_fail += '12e node 不可用，无法验收 TLS 兜底 argv' }
        else {
            $script:NodeExePath = $t_nodeExe; $script:NodeEnginePath = $t_stub
            $env:MCPS_T12E_ARGV_FILE = $t_argvFile
            $t_got12 = @{}; $t_status12 = @{}
            foreach ($t_case in @(@{ K = 'def'; A = @{} }, @{ K = 'd5'; A = @{ NodeDeadlineSec = 5 } },
                                   @{ K = 'post'; A = @{ Method = 'POST'; Body = '{"fixture":true}' } })) {
                Remove-Item -LiteralPath $t_argvFile -Force -ErrorAction SilentlyContinue
                $t_a = $t_case.A
                $t_result12 = $null
                try { $t_result12 = Invoke-ApiRequest -Uri 'http://127.0.0.1:1/mcps-t12e' -Headers @{ 'User-Agent' = 't12e' } -TimeoutSec 3 -NoProxy -MaxAttempts 1 @t_a } catch { }
                $t_got12[$t_case.K] = if (Test-Path -LiteralPath $t_argvFile) { ([System.IO.File]::ReadAllText($t_argvFile)).Trim() } else { '' }
                $t_status12[$t_case.K] = if ($t_result12) { [int]$t_result12.StatusCode } else { 0 }
            }
            # 独立判据：GET 的失败不应短路 POST；12g/12h 另行记录各自的执行证据。
            $t_12eFailureStart = $t_fail.Count
            $t_expectMode = if ($PSVersionTable.PSEdition -eq 'Core') { 'direct-noproxy-core' } else { 'direct-emptyproxy-desktop' }
            if ($script:LastRequestProxyMode -ne $t_expectMode) { $t_ok = $false; $t_fail += "U-40 -NoProxy 未走直连模式：got=$($script:LastRequestProxyMode) want=$t_expectMode env-proxy=$t_proxyEnv" }
            if ($t_got12['def'] -notmatch '(^|\s)-d 25000(\s|$)') { $t_ok = $false; $t_fail += "12e 默认兜底 argv 缺 '-d 25000'：[$($t_got12['def'])] env-proxy=$t_proxyEnv" }
            if ($t_got12['d5'] -notmatch '(^|\s)-d 5000(\s|$)') { $t_ok = $false; $t_fail += "12e -NodeDeadlineSec 5 兜底 argv 缺 '-d 5000'：[$($t_got12['d5'])]" }
            if ($t_got12['def'] -match '(^|\s)-(X|B)(\s|$)' -or $t_status12['def'] -ne 200) { $t_ok = $false; $t_fail += 'R-2 GET 兜底不应携带 POST 参数，且须返回 200' }
            if ($t_got12['post'] -notmatch '(^|\s)-X POST(\s|$)' -or $t_got12['post'] -notmatch '(^|\s)-B (\S+)' -or $t_status12['post'] -ne 200) {
                $t_ok = $false; $t_fail += "R-2 POST 兜底未成功或缺 -X/-B：[$($t_got12['post'])] status=$($t_status12['post'])"
            }
            if ($t_fail.Count -eq $t_12eFailureStart) {
                $t_argv = 'd+post'
                $lines.Add('[test-inject/12e] GET(no -X/-B) and POST(-X/-B) TEST_PASS')
            }
        }
    } finally {
        $script:NodeExePath = $t_saveExe; $script:NodeEnginePath = $t_saveEng
        if ($null -eq $t_saveCapture) { Remove-Item Env:MCPS_T12E_ARGV_FILE -ErrorAction SilentlyContinue }
        else { $env:MCPS_T12E_ARGV_FILE = $t_saveCapture }
        Remove-Item -LiteralPath $t_fd -Recurse -Force -ErrorAction SilentlyContinue
    }
    # 12i) U-41 / N-18：嵌套 Runspace 池（GitLab blobs 同款注入方式）里真调用 Invoke-ApiRequest，不得 CommandNotFound。
    #      正例：按 Get-HttpLayerClosure 注入 ⇒ 抛的必须是传输层/HTTP 类异常或成功，绝不能是"找不到命令"；
    #      负例：故意从闭包里去掉 Invoke-WebRequestDirect ⇒ 必须复现 CommandNotFound（证明本组能抓 N-18 这类漏项）。
    #      目标 127.0.0.1:1（连接被拒）+ -NoProxy（N-16/N-19 同型：不走进程级代理）+ MaxAttempts 1，不联网。
    $t_u41 = @{ ok = 'n/a'; neg = 'n/a' }
    try {
        $t_runPool = {
            param([string[]]$FnNames)
            $defsX = @()
            foreach ($fn in $FnNames) { if (Test-Path "function:$fn") { $defsX += "function $fn { $((Get-Item "function:$fn").Definition) }" } }
            $injX = @{ VERSION = $VERSION; Cfg = $script:Cfg; NodeEnginePath = $script:NodeEnginePath; NodeExePath = $script:NodeExePath }
            $poolX = [runspacefactory]::CreateRunspacePool(1, 1); $poolX.ApartmentState = 'MTA'; $poolX.Open()
            try {
                $psX = [powershell]::Create(); $psX.RunspacePool = $poolX
                [void]$psX.AddScript({
                    param($Defs, $Inject)
                    foreach ($d in $Defs) { . ([scriptblock]::Create($d)) }
                    foreach ($k in $Inject.Keys) { Set-Variable -Name $k -Value $Inject[$k] }
                    try { $null = Invoke-ApiRequest -Uri 'http://127.0.0.1:1/mcps-u41' -Headers @{ 'User-Agent' = 'u41' } -TimeoutSec 2 -NoProxy -MaxAttempts 1; return 'ok' }
                    catch { return ($_.Exception.GetType().FullName + ': ' + $_.Exception.Message) }
                }).AddArgument($defsX).AddArgument($injX)
                $hX = $psX.BeginInvoke()
                $rX = $psX.EndInvoke($hX)
                return [string]($rX | Select-Object -First 1)
            } finally { try { $poolX.Close(); $poolX.Dispose() } catch { } }
        }
        $t_u41.ok = & $t_runPool -FnNames (Get-HttpLayerClosure)
        $t_u41.neg = & $t_runPool -FnNames @((Get-HttpLayerClosure) | Where-Object { $_ -ne 'Invoke-WebRequestDirect' })
        $t_cnfPattern = 'CommandNotFoundException|not recognized|无法将'
        if ($t_u41.ok -match $t_cnfPattern) { $t_ok = $false; $t_fail += "U-41 嵌套池按闭包注入后仍 CommandNotFound：[$($t_u41.ok)]" }
        if ($t_u41.neg -notmatch $t_cnfPattern) { $t_ok = $false; $t_fail += "U-41 负例失效：去掉 Invoke-WebRequestDirect 后未复现 CommandNotFound：[$($t_u41.neg)]" }
        if ($t_u41.ok -notmatch $t_cnfPattern -and $t_u41.neg -match $t_cnfPattern) { $lines.Add("[test-inject/12i] U-41 nested-pool closure TEST_PASS (ok=[$(($t_u41.ok).Substring(0, [Math]::Min(60, ($t_u41.ok).Length)))] neg=CommandNotFound)") }
    } catch { $t_ok = $false; $t_fail += "U-41 12i exec: $($_.Exception.Message)" }
    # 12f) N-8：非 HTTP 异常必须穿过 Invoke-ApiRequest；测试桩仅在本进程，finally 复原命令。
    $t_prevIwrFn = Get-Item Function:global:Invoke-WebRequest -ErrorAction SilentlyContinue
    try {
        function global:Invoke-WebRequest { throw [System.InvalidOperationException]::new('n8-non-http') }
        $t_nonHttpRethrown = $false
        try {
            $null = Invoke-ApiRequest -Uri 'http://127.0.0.1:1/mcps-n8' -Headers @{} -NoProxy -MaxAttempts 1
        } catch { $t_nonHttpRethrown = ($_.Exception.Message -match 'n8-non-http') }
        if (-not $t_nonHttpRethrown) { $t_ok = $false; $t_fail += 'N-8 非 HTTP 异常被吞或改写' }
    } finally {
        if ($t_prevIwrFn) { Set-Item -Path Function:global:Invoke-WebRequest -Value $t_prevIwrFn.ScriptBlock }
        else { Remove-Item Function:global:Invoke-WebRequest -Force -ErrorAction SilentlyContinue }
    }
    # 12g) R-3：429 两义分类纯函数；Doctor catch 必须从 node 响应体调用它（离线结构门禁另见 Node 测试）。
    $t_vercel429 = Resolve-DoctorGrep429 -ResponseBody '<html>Vercel Security Checkpoint</html>'
    $t_pure429 = Resolve-DoctorGrep429 -ResponseBody '{"error":"rate limited"}'
    if ($t_vercel429.Reachable -ne $false -or $t_vercel429.Note -notmatch 'Vercel') {
        $t_ok = $false; $t_fail += 'R-3 Vercel 429 应为不可达且 Note 应包含 Vercel'
    } else { $lines.Add('[test-inject/12g] R-3 Vercel 429 TEST_PASS') }
    if ($t_pure429.Reachable -ne $true -or $t_pure429.Note -notmatch '429') {
        $t_ok = $false; $t_fail += 'R-3 pure 429 应为可达且 Note 应说明限流'
    } else { $lines.Add('[test-inject/12g] R-3 pure 429 TEST_PASS') }
    # 12h) T1-2：受限代理白名单双向判据；不给已在白名单或 Vercel 挑战页错误建议。
    $t_outside = Get-DoctorProxyAdvice -Domain 'gitlab.com' -Reachable:$false -ProxySpec 'socks5://127.0.0.1:9;gitee.com'
    $t_inside = Get-DoctorProxyAdvice -Domain 'gitlab.com' -Reachable:$false -ProxySpec 'socks5://127.0.0.1:9; gitlab.com, gitee.com'
    $t_vercelAdvice = Get-DoctorProxyAdvice -Domain 'grep.app' -Reachable:$false -Note 'Vercel Security Checkpoint' -ProxySpec 'socks5://127.0.0.1:9;gitlab.com'
    $t_blankList = Get-DoctorProxyAdvice -Domain 'gitlab.com' -Reachable:$false -ProxySpec 'socks5://127.0.0.1:9;  '
    if ($t_outside -notmatch 'gitlab.com.*白名单') { $t_ok = $false; $t_fail += 'T1-2 outside whitelist 应提示添加 gitlab.com' }
    if ($t_inside -or $t_vercelAdvice) { $t_ok = $false; $t_fail += 'T1-2 inside whitelist / Vercel 不应提示添加代理白名单' }
    if ($t_blankList -notmatch 'gitlab.com.*白名单') { $t_ok = $false; $t_fail += 'T1-2 空白白名单必须按受限直连判断' }
} catch { $t_ok = $false; $t_fail += "inject exec: $($_.Exception.Message)" }
if ($t_ok) { $lines.Add("[test-inject] TEST_PASS (deps=0/rl-shared ${t_ms}ms/rl-count-shared/node-path=$t_np/node-argv=$t_argv)"); $pass++ }
else { $lines.Add("[test-inject] TEST_FAIL: $($t_fail -join '; ')"); $failC++ }

# ---------- 汇总 ----------
$summary = "RESULT: $pass passed / $failC failed / $skipC skipped"
$lines.Add("=====================================")
$lines.Add($summary)
# U-93（2026-09-26）：-LocalOnly 时**汇总一行**列出被跳过的组 —— 让"只跑了快路径"这件事在输出里可见（U-89 的运行时契约门就在被跳过的 test-contract 里）。
if ($LocalOnly) {
    $t_skippedGroups = @()
    foreach ($ln in $lines) { if ($ln -match '^\[(test-[a-z0-9-]+)\] TEST_SKIP \(LocalOnly\)') { $t_skippedGroups += $matches[1] } }
    $lines.Add(("[localonly] skipped-groups={0}: {1} —— 契约/网络门未跑；全量或 U-90 runner -Full 才覆盖（门×触发条件表：reports/gates/gate-coverage-2026-09-26.md）" -f $t_skippedGroups.Count, ($t_skippedGroups -join ', ')))
}
if ($failC -eq 0) { $lines.Add("ALL TESTS PASSED") }
$reportFile = Join-Path $testDir 'test-results.log'
$lines | Set-Content -LiteralPath $reportFile -Encoding UTF8
# U-80（2026-09-26）：组结果**单源** —— 组结论行只在这里解析一次（唯一正则 $GroupLinePattern），得到 $groupResults；
#   JUnit XML（-JunitPath）与 JSON（-ResultJsonPath，Pester 适配层的输入）都从 $groupResults 派生，不再各自解析 stdout。
#   此前 JUnit 用 `TEST_PASS|TEST_FAIL|SKIP` 而组行写的是 `TEST_SKIP` ⇒ -LocalOnly 下 5 个 SKIP 组在 XML 里**消失**（tests=7 而非 12）——
#   正是"两处解析同一份行"的代价。现在：解析结果与 $pass/$failC/$skipC 计数器不一致 ⇒ `[results] MISMATCH` 且 **rc=1**（门红，不是 WARN）。
$GroupLinePattern = '^\[(?<g>test-[a-z0-9-]+)\] TEST_(?<v>PASS|FAIL|SKIP)\b(?<rest>.*)'
$groupResults = @()
foreach ($ln in $lines) {
    if ($ln -match $GroupLinePattern) { $groupResults += [PSCustomObject]@{ Name = $matches['g']; Status = $matches['v']; Detail = $matches['rest'].Trim(': ').Trim() } }
}
$gPass = @($groupResults | Where-Object { $_.Status -eq 'PASS' }).Count
$gFail = @($groupResults | Where-Object { $_.Status -eq 'FAIL' }).Count
$gSkip = @($groupResults | Where-Object { $_.Status -eq 'SKIP' }).Count
$resultMismatch = ($gPass -ne $pass -or $gFail -ne $failC -or $gSkip -ne $skipC)
if ($resultMismatch) { $lines.Add(("[results] MISMATCH group-lines pass/fail/skip={0}/{1}/{2} vs counters {3}/{4}/{5} —— 组行与计数器不一致，门红" -f $gPass, $gFail, $gSkip, $pass, $failC, $skipC)) }
$exitCodeFinal = if ($failC -gt 0 -or $resultMismatch) { 1 } else { 0 }
$resultObj = [PSCustomObject]@{
    tool = 'run-tests.ps1'; at = (Get-Date).ToString('s'); edition = $PSVersionTable.PSEdition; psVersion = $PSVersionTable.PSVersion.ToString()
    localOnly = [bool]$LocalOnly; proxyEnv = (Get-ProcessProxyEnvSummary)
    passed = $pass; failed = $failC; skipped = $skipC; exitCode = $exitCodeFinal; mismatch = $resultMismatch
    groups = @($groupResults)
}
# U-291（v1.71.0，2026-10-28 全量验收 F1）：`.ps-gate.json` = PS 套件的**发布凭证**。
#   病灶：发布器只看 `.gate-green.json`，而那份凭证**只由 Node runner 写** ⇒ 只被 PS 套件覆盖的断言
#   （文档卫生的 `\n` 工件 / BOM / 注入 12e·12i / doctor C1..C5）红也能发布。
#   实证：v1.70.0 就是带着 `test-docs` 红发的（SKILL.md 里的正则字面量，2026-10-26 引入）。
#   口径：**全量才算**（`-LocalOnly` 只跑快路径，不能背书）；skipped 允许（网络不可用是环境，不是红）。
#   写盘失败必须让本轮 rc≠0 —— 凭证写不出来等于没跑过，不能静默。
$psGateFile = Join-Path (Split-Path -Parent $testDir) '.ps-gate.json'
if ($PsGatePath) { $psGateFile = $PsGatePath }
try {
    $psGateObj = [PSCustomObject]@{
        schema = 'mcps/ps-gate/1'
        version = $VERSION
        runtime = ('PS ' + $PSVersionTable.PSVersion.ToString() + ' / ' + $PSVersionTable.PSEdition)
        runtimeMajor = [int]$PSVersionTable.PSVersion.Major
        localOnly = [bool]$LocalOnly
        passed = $pass; failed = $failC; skipped = $skipC
        exitCode = $exitCodeFinal
        mismatch = [bool]$resultMismatch
        finishedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        groups = @($groupResults | ForEach-Object { ('{0}:{1}' -f $_.Name, $_.Status) })
    }
    [System.IO.File]::WriteAllText($psGateFile, ($psGateObj | ConvertTo-Json -Depth 4), [System.Text.UTF8Encoding]::new($false))
    $lines.Add("[ps-gate] written $psGateFile (pass=$pass fail=$failC skip=$skipC rc=$exitCodeFinal)")
} catch { $lines.Add("[ps-gate] write failed: $($_.Exception.Message)"); $exitCodeFinal = 1 }
if ($ResultJsonPath) {
    try { [System.IO.File]::WriteAllText($ResultJsonPath, ($resultObj | ConvertTo-Json -Depth 4), [System.Text.UTF8Encoding]::new($false)); $lines.Add("[results] json written $ResultJsonPath (groups=$($groupResults.Count))") }
    catch { $lines.Add("[results] json write failed: $($_.Exception.Message)"); $exitCodeFinal = 1 }
}
# U-25 方案 C：JUnit XML（每个组 = 一个 testcase；子行 `[group/12e]` 归入同 group 的 system-out）。派生自 $groupResults（U-80）。
if ($JunitPath) {
    try {
        $xmlEsc = { param($s) [System.Security.SecurityElement]::Escape([string]$s) }
        $cases = New-Object System.Collections.Generic.List[string]
        $groupLines = @{}
        foreach ($ln in $lines) {
            if ($ln -match '^\[(?<g>[^\]/]+)(?:/(?<sub>[^\]]+))?\]\s*(?<rest>.*)') {
                $g = $matches['g']
                if (-not $groupLines.ContainsKey($g)) { $groupLines[$g] = New-Object System.Collections.Generic.List[string] }
                $groupLines[$g].Add($ln)
            }
        }
        foreach ($gr in $groupResults) {
            $body = ''
            if ($gr.Status -eq 'FAIL') { $body = ('<failure message="{0}"/>' -f (& $xmlEsc $gr.Detail)) }
            elseif ($gr.Status -eq 'SKIP') { $body = ('<skipped message="{0}"/>' -f (& $xmlEsc $gr.Detail)) }
            $out = ''
            if ($groupLines.ContainsKey($gr.Name)) { $out = ('<system-out>{0}</system-out>' -f (& $xmlEsc (($groupLines[$gr.Name]) -join [Environment]::NewLine))) }
            $cases.Add(('<testcase classname="run-tests" name="{0}">{1}{2}</testcase>' -f (& $xmlEsc $gr.Name), $body, $out))
        }
        $suite = ('<?xml version="1.0" encoding="UTF-8"?>{0}<testsuite name="multi-code-platform-searcher run-tests.ps1" tests="{1}" failures="{2}" skipped="{3}" timestamp="{4}" hostname="{5}"><properties><property name="edition" value="{6}"/><property name="localOnly" value="{7}"/><property name="proxyEnv" value="{8}"/></properties>{9}</testsuite>' -f [Environment]::NewLine, $groupResults.Count, $gFail, $gSkip, (Get-Date).ToString('s'), (& $xmlEsc $env:COMPUTERNAME), $PSVersionTable.PSEdition, [bool]$LocalOnly, (& $xmlEsc (Get-ProcessProxyEnvSummary)), ($cases -join ''))
        [System.IO.File]::WriteAllText($JunitPath, $suite, [System.Text.UTF8Encoding]::new($false))
        Write-Output ("[junit] written {0} (tests={1} failures={2} skipped={3})" -f $JunitPath, $groupResults.Count, $gFail, $gSkip)
    } catch { Write-Output ("[junit] write failed: {0}" -f $_.Exception.Message); $exitCodeFinal = 1 }
}
Write-Output ($lines -join [Environment]::NewLine)
if ($exitCodeFinal -ne 0) { exit $exitCodeFinal }
