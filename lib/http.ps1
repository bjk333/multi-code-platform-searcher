# ==============================================================================
# lib/http.ps1 -- Multi-Code-Platform Searcher | B3-2 模块拆分（v1.54.0）
#
# HTTP 传输层：重试/退避、TLS 兜底、socks 与 node 回退、离线回放接缝、请求账本、
#   Invoke-ApiRequest 主控。凡「发请求」的事都在这里。
#
# 契约：本文件只定义（函数 / $script: 数据），无顶层副作用；由主脚本按固定顺序点源加载。
#   · 作用域：点源进主脚本作用域，故 $script: 指向主脚本；版本号/参数等由主脚本提供。
#   · 不要在这里 exit、不要写 stdout：进度与产物分别走 Write-ColorOutput / Write-PayloadOutput。
#   · 新增函数放对应模块；跨模块调用无需前置声明（全部在运行前定义完毕）。
# ==============================================================================

# ---------- HTTP（带 429/5xx 退避与 UA） ----------
function Get-ApiHeaders {
    param([string]$Token, [string]$Scheme = "Bearer")
    $h = @{ "User-Agent" = "multi-code-platform-searcher/$VERSION" }
    if ($Token) {
        if ($Scheme -eq "token") { $h["Authorization"] = "token $Token" }
        elseif ($Scheme -eq "PrivateToken") { $h["PRIVATE-TOKEN"] = $Token }
        else { $h["Authorization"] = "Bearer $Token" }
    }
    return $h
}
# v1.16.0：GitHub secondary rate limit 判定（403 变体）——GitHub 除 primary 429 外，
# 还会以「403 + x-ratelimit-remaining: 0 / Retry-After 头 / 响应体含 secondary rate limit|abuse」形式限流。
# 命中则按退避重试；非限流 403（如无权限/令牌无效）保持 throw，不误重试。
function Test-RateLimit403 {
    param($Resp)
    try {
        if ($null -eq $Resp -or $null -eq $Resp.Headers) { return $false }
        # U-02：Invoke-ApiRequest 传统一形状；直接调用本兼容入口时也容许 PS 5.1/7 原生响应。
        $headers = $Resp.Headers
        $isCoreResponse = ($Resp.GetType().FullName -eq 'System.Net.Http.HttpResponseMessage')
        if ($isCoreResponse) {
            $headers = @{}
            foreach ($h in $Resp.Headers) {
                if ($h.Key -in @('x-ratelimit-remaining', 'Retry-After')) {
                    $headers[[string]$h.Key] = @($h.Value) -join ','
                }
            }
        }
        # 头特征：x-ratelimit-remaining: 0 或携带 Retry-After
        $rl = $headers['x-ratelimit-remaining']
        if ($rl -and [string]$rl -eq '0') { return $true }
        if ($headers['Retry-After']) { return $true }
        # 体特征：secondary rate limit / abuse；无标头时才读体，避免重试路径多余读流。
        $body = ''
        if ($Resp.PSObject.Properties['Body']) { $body = [string]$Resp.Body }
        elseif ($isCoreResponse -and $Resp.Content) {
            $body = [string]$Resp.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        }
        else {
            $stream = $Resp.GetResponseStream()
            if ($stream) {
                $sr = New-Object System.IO.StreamReader($stream)
                try { $body = $sr.ReadToEnd() } finally { $sr.Dispose() }
            }
        }
        if ($body -match 'secondary rate limit|abuse|rate limit exceeded') { return $true }
    } catch { }
    return $false
}
function Invoke-WebRequestDirect {
    param([hashtable]$Params, [switch]$Direct)
    if (-not $Direct) { $script:LastRequestProxyMode = 'default'; return (Invoke-WebRequest @Params) }
    if ($PSVersionTable.PSEdition -eq 'Core') {
        $Params['NoProxy'] = $true
        $script:LastRequestProxyMode = 'direct-noproxy-core'
        return (Invoke-WebRequest @Params)
    }
    $prevProxy = $null
    try {
        $prevProxy = [System.Net.WebRequest]::DefaultWebProxy
        [System.Net.WebRequest]::DefaultWebProxy = [System.Net.GlobalProxySelection]::GetEmptyWebProxy()
        $script:LastRequestProxyMode = 'direct-emptyproxy-desktop'
        return (Invoke-WebRequest @Params)
    } finally {
        try { [System.Net.WebRequest]::DefaultWebProxy = $prevProxy } catch { }
    }
}
function Get-HeaderValue {
    # N-17：跨运行时读响应头 —— PS 5.1 Headers 为 Dictionary<string,string>，PS 7 为 Dictionary<string,IEnumerable<string>>；键不区分大小写地找。
    param($Headers, [string]$Name)
    if ($null -eq $Headers) { return $null }
    try {
        foreach ($k in @($Headers.Keys)) {
            if ([string]$k -ieq $Name) {
                $v = $Headers[$k]
                if ($v -is [System.Array] -or $v -is [System.Collections.IEnumerable] -and -not ($v -is [string])) { return (@($v) -join ', ') }
                return [string]$v
            }
        }
    } catch { }
    return $null
}
function Get-ProcessProxyEnvSummary {
    # U-40：把进程级代理状态变成可打印/可入证据的一行（不含凭据：只保留 scheme://host:port）
    $found = @()
    foreach ($v in @('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'NO_PROXY', 'no_proxy')) {
        $pv = [Environment]::GetEnvironmentVariable($v, 'Process')
        if ($pv) { $found += ('{0}={1}' -f $v, ($pv -replace '://[^@/]+@', '://***@')) }
    }
    if ($found.Count -eq 0) { return 'none' }
    return ($found -join ' ')
}
function Get-SafePreview {
    # U-134（2026-09-29）：预览截断。.NET Substring 按 UTF-16 code unit 切，边界落在代理对（emoji 等）中间会产生孤立代理项 ⇒ ConvertTo-Json 输出 \ud83d 之类
    #   孤立转义，消费方按 UTF-8 编码时报错。此处若第 MaxChars 位是高代理项则少切一位。宿主 R73 所见「鈥?」经字节核对为捕获段按 GBK 误读 UTF-8，产出本身合法（reports/gates/u134/）。
    param([string]$Text, [int]$MaxChars)
    if ([string]::IsNullOrEmpty($Text) -or $Text.Length -le $MaxChars) { return $Text }
    $cut = $MaxChars
    if ($cut -gt 0 -and [char]::IsHighSurrogate($Text[$cut - 1])) { $cut-- }
    return $Text.Substring(0, $cut) + '…'
}
function Repair-Latin1Mojibake {
    # U-132：仅当文本确为 Latin-1 解码产物（全部字符 ≤ U+00FF）时，按 Latin-1 取回原始字节再按 UTF-8 解码（v1.28.0 修复的 PS5.1 场景）。
    #   已含 >U+00FF 字符 ⇒ 说明运行时已正确解码，原样返回（否则会被 Latin1.GetBytes 折成 '?'）。
    #   重解码若产生 U+FFFD ⇒ 原文本就是真 Latin-1 文本（如 café），保留原文。纯 ASCII 两条路径字节不变。
    param([string]$Text)
    if ([string]::IsNullOrEmpty($Text)) { return $Text }
    foreach ($ch in $Text.ToCharArray()) { if ([int]$ch -gt 0xFF) { return $Text } }
    try {
        $fixed = [System.Text.Encoding]::UTF8.GetString([System.Text.Encoding]::GetEncoding(28591).GetBytes($Text))
        if ($fixed.IndexOf([char]0xFFFD) -ge 0) { return $Text }
        return $fixed
    } catch { return $Text }
}
# ---------- D4（2026-09-30，U-100）：Invoke-ApiRequest（317 行）拆出的 HTTP 层 helper ----------
# 规则（派工 §2）：helper 只返回数据/决策对象；break / continue / 2xx return / throw 全部留在 Invoke-ApiRequest 调用点
#   （PowerShell 的 break/continue 会穿透函数边界打到调用方的循环）。Write-ColorOutput 在重定向时写成功管道（L123–129），
#   同样留在调用点，避免被 `$x = helper` 赋值捕获。全部 helper 均为顶层函数并列入 Get-HttpLayerClosure（U-41/U-74/U-104 门跟随真实调用图）。
#   搬移块按 e7362afa 的 AST 行号逐字节抽取（仅缩进归一），改动行单列于 reports/gates/u100-d4/d4-split.json。
# 以下历史注释原位于 Invoke-ApiRequest 体内（L1356–1359 / L1363–1371 / L1638–1639 / L1645–1646 / L1669 @ e7362afa），随 D4 迁出以让公有函数 ≤100 行：
# v1.18.0：扩展 POST 支持（Method/Body），供 Semantic Scholar batch 等 POST 端点复用同一退避/预算/观测链路
# v1.28.0：-NoProxy 可显式绕过 MCPS_PROXY 等代理并真直连；U-156 起 so.gitee.com 不再无条件固定直连，
# 默认 auto 先探活真实 URL，再在环境/系统代理和直连之间选可用路径。
# v1.34.1（v1.37.4 R-1 恢复）：-NodeDeadlineSec——透传 node 引擎 -d 硬截止（SSE 长流探测等场景缩短等待；<=0 用 Cfg 默认）。放最后，不扰动位置参数。
# v1.28.1：Retry-After 上限——429 携带超大 Retry-After（如 OpenAlex 限流 Retry-After=38139s≈10.6h）
# 时不再傻等，快速失败交由引擎 catch 标记 rate_limited（EXE/干净环境场景实测卡死）
# H4 全局重试预算：每次重试前消耗共享预算，耗尽即放弃本次请求（不再重试），
# 避免多源批量场景（研究模式 6 源）最坏重试长尾累积。预算未初始化（dot-source 单测）时跳过检查。
# v1.23.0：重试耗尽消息附带最后一次 HTTP 状态码（引擎 catch 可据此精确判别 rate_limited vs error）
# U-83（2026-09-26）：退避策略**单源**。此前同一策略在代理路径 / node TLS 兜底路径 / 主路径写了 3 遍（N-25 一次改 3 处）。
#   语义：退避次数 = 尝试数 − 1 —— 最后一次尝试失败后不再退避（HasNext=$false ⇒ 调用点 break 出循环抛"重试次数耗尽"）；
#   -MaxAttempts 1 = 只试一次、零等待。等待 = Retry-After 时 max(RetryMinWaitSec, Retry-After)，否则 RetryBaseSec^attempt；
#   超过 MaxRetryWaitSec ⇒ TooLong（仅主路径据此快速失败，v1.28.1）。内嵌函数随 Invoke-ApiRequest 文本一起进 Runspace，不需进闭包。
#   注意：不要在这里 break/continue（PowerShell 的 break 会穿透函数边界打到调用方的循环）—— 只返回决策，由调用点执行。
# N-43（2026-09-27）：TLS 兜底的"是否触发"改成**机器可读信号**（opt-in）：设 $env:MCPS_TLS_TRACE=<文件> 时，把 attempt / 守卫输入 /
#   兜底进入 / node 结果 逐行追加到该文件；未设时零开销。此前只能靠抓 stdout 里的一行彩色文本判定，而该文本在 `$r = Invoke-ApiRequest …`
#   赋值形态下随异常一起被丢弃、在 -AsJson 下被 Write-ColorOutput 早返吞掉 ⇒ 判据既不可靠也不可观测（宿主 R38 三段插桩互相矛盾即此因）。
#   内嵌函数随 Invoke-ApiRequest 文本进 Runspace，不需进闭包；$env: 进程级共享。
#   ★ D4（2026-09-30）更正上两段中的"内嵌函数…不需进闭包"：三者已外提为顶层函数，**必须**在 Get-HttpLayerClosure 内（否则 Runspace 内 CommandNotFound）。
function Write-TlsTrace {
    param([string]$TraceEvent)
    if ($env:MCPS_TLS_TRACE) { try { [System.IO.File]::AppendAllText($env:MCPS_TLS_TRACE, ((Get-Date).ToString('o') + ' ' + $TraceEvent + [Environment]::NewLine)) } catch { } }
}
# U-99（N-44）：trace 里的 URL 只记 scheme://host[:port]/path —— 丢弃 query/fragment（有些源把 key 放 ?key=…），与 U-88/U-66 "输出不得含凭据值"同口径
function Get-TraceUri {
    param([string]$U)
    try { $__u = [uri]$U; return ($__u.Scheme + '://' + $__u.Authority + $__u.AbsolutePath + $(if ($__u.Query) { '?<query-masked>' } else { '' })) } catch { return ($U -replace '\?.*', '?<query-masked>') }
}
# U-160 L3（2026-10-03）：退避改 **AWS Full Jitter**。★随机源**以参数注入**（`-Rand01`），不由函数内部自取 ——
#   这样"真的是抖动"可被**确定性**验证（给定 Rand01 与上限，等待值必须精确等于 rand×U），
#   而不是靠"多跑几次看看不一样"这种**概率式**门禁（通则 #6：只结构不变量可 hard-fail）。
#   语义：Uₙ = min(cap, base·2ⁿ)；本地等待 = Rand01 × Uₙ；有 Retry-After=S 时取 **max(本地, S)**（S 是**下限**）。
function Get-FullJitterWait {
    param([int]$Attempt, [double]$UpperBoundSec, [double]$Rand01, $RetryAfterSec = $null)
    $r = $Rand01
    if ($r -lt 0) { $r = 0 }
    if ($r -gt 1) { $r = 1 }                                   # 夹紧，防注入越界
    $u = [double]$UpperBoundSec
    if ($u -lt 0) { $u = 0 }
    $local = [math]::Round($r * $u, 3)
    if ($null -ne $RetryAfterSec -and [double]$RetryAfterSec -gt $local) { return [double]$RetryAfterSec }
    return [double]$local
}
function Get-RetryBackoff {
    param([int]$Attempt, [int]$MaxAttempts, $RetryAfterHeader = $null, [double]$Rand01 = -1)
    # Uₙ = min(cap, base·2ⁿ) —— 此前无 Retry-After 时**未封顶**（靠 TooLong 事后判），现在按公式直接封顶
    $upper = [math]::Min([double]$script:Cfg.MaxRetryWaitSec, [math]::Pow([double]$script:Cfg.RetryBaseSec, $Attempt))
    if ($Rand01 -lt 0 -or $Rand01 -gt 1) { $Rand01 = (Get-Random -Minimum 0.0 -Maximum 1.0) }   # 真实调用：注入随机
    $w = Get-FullJitterWait -Attempt $Attempt -UpperBoundSec $upper -Rand01 $Rand01 -RetryAfterSec $RetryAfterHeader
    return [PSCustomObject]@{ WaitSec = $w; TooLong = ($w -gt $script:Cfg.MaxRetryWaitSec); HasNext = ($Attempt -lt $MaxAttempts); UpperBoundSec = $upper; Rand01 = $Rand01 }
}
function Invoke-ApiNodeFallback {
    # v1.51.0（D4 ≤100 行）：从 Invoke-ApiRequest 抽出的 node TLS 兜底段。
    #   ★value-returning helper **不得写成功流**（D4 规则）：U-266 起 Write-ColorOutput 写 stderr，
    #   但这条规则不因被调函数变干净而放松 —— 用户可见消息仍一律放返回对象的 Log，由调用点打印。
    #   ★helper 自身不 break/continue（D4 规则）：动作以对象回传（ok/retry/stop/throw/skip），控制流留在公有函数。
    param([string]$Uri, $Headers, [string]$Method, [string]$Body, [int]$NodeDeadlineSec, [string]$traceUri, [int]$attempt, [int]$maxAttempts)
    $lastCode = $null
    try {
        $np = Get-ApiNodePaths -traceUri $traceUri
        if ($np.Ok) {
            Write-TlsTrace ("fallback-enter {0}" -f $traceUri)
            $nr = Invoke-ApiNodeOnce -nodeExe $np.NodeExe -engine $np.Engine -Uri $Uri -Headers $Headers -Method $Method -Body $Body -NodeDeadlineSec $NodeDeadlineSec -traceUri $traceUri
            if ($nr.HasStatus) {
                $nodeCode = [int]$nr.StatusCode
                if ($nodeCode -ge 200 -and $nodeCode -lt 300) {
                    return [PSCustomObject]@{ Action = 'ok'; Result = [PSCustomObject]@{ Content = $nr.Content; StatusCode = $nodeCode; Headers = @{} }; Log = "  (TLS fallback OK HTTP $nodeCode)" }
                }
                $lastCode = $nodeCode
                if ($nodeCode -eq 429 -or $nodeCode -ge 500) {
                    $bo = Get-RetryBackoff -Attempt $attempt -MaxAttempts $maxAttempts
                    if (-not $bo.HasNext) { return [PSCustomObject]@{ Action = 'stop'; LastCode = $lastCode } }   # N-25/U-83：最后一次尝试不退避
                    Start-Sleep -Seconds $bo.WaitSec
                    return [PSCustomObject]@{ Action = 'retry'; LastCode = $lastCode; Log = "  (TLS fallback HTTP $nodeCode) 退避 $($bo.WaitSec)s 后重试 ($attempt/$maxAttempts)" }
                }
                return [PSCustomObject]@{ Action = 'throw'; Message = "TLS 兜底请求失败: $Uri (HTTP $nodeCode)"; LastCode = $lastCode }
            }
        }
    } catch { }
    return [PSCustomObject]@{ Action = 'skip'; LastCode = $lastCode }
}
function Invoke-ApiSocksOnce {
    param([string]$Uri, [hashtable]$Headers, [int]$TimeoutSec, [string]$Method, [string]$Body, [string]$proxyUrl, $reqSw)
    # U-267：回放只接 web 路径（Invoke-ApiWebOnce）。回放期若仍被路由到 socks，宁可炸也不要**悄悄打真网**
    #   —— 一次静默联网就能把"逐字节一致"变成"每次都不同"，而且没人看得出来。
    if (-not [string]::IsNullOrWhiteSpace($env:MCPS_REPLAY_DIR)) { throw "replay-unsupported-route: socks 路径未接回放（$Uri）；请让本机路由为直连/HTTP 代理后重跑" }
    $curlCmd = Get-Command -Name @('curl.exe', 'curl') -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    $curl = if ($curlCmd) { $curlCmd.Source } else { $null }
    if (-not $curl) { throw 'curl 不可用（SOCKS5 代理模式需要）' }
    $tmpBody = [System.IO.Path]::GetTempFileName()
    # v1.45.7（2026-10-20）：不再 `2>$null` 丢弃 curl 的失败原因。
    #   病灶：上层只会收到「curl 无状态码输出」，于是 Doctor 把 TLS 失败 / 超时 / DNS / 连接被拒
    #   四种处置完全不同的情形一律记成 unreachable（实测同一构建同一端点时而 200、时而 unreachable）。
    $tmpErr = [System.IO.Path]::GetTempFileName()
    $curlArgs = @('-s', '-o', $tmpBody, '-w', '%{http_code}', '--max-time', "$TimeoutSec", '--socks5-hostname', ($proxyUrl -replace '^socks5h?://', ''), '-A', "multi-code-platform-searcher/$VERSION")
    if ($Method -ne 'GET') { $curlArgs += '-X', $Method }
    if ($Body) { $curlArgs += '--data-binary', $Body }
    foreach ($hk in $Headers.Keys) { $curlArgs += '-H', "$hk`:$($Headers[$hk])" }
    $curlArgs += $Uri
    $codeStr = (& $curl @curlArgs 2>$tmpErr | Select-Object -Last 1)
    $curlRc = $LASTEXITCODE
    $reqSw.Stop()
    $code = $null
    if ($codeStr -is [string] -and $codeStr -match '^(\d{3})$') { $code = [int]$matches[1] }
    $bodyText = ''
    if (Test-Path $tmpBody) { $bodyText = [System.IO.File]::ReadAllText($tmpBody) }
    $errText = ''
    if (Test-Path $tmpErr) { $errText = ([System.IO.File]::ReadAllText($tmpErr)).Trim() }
    Remove-Item $tmpBody -Force -ErrorAction SilentlyContinue
    Remove-Item $tmpErr -Force -ErrorAction SilentlyContinue
    return [PSCustomObject]@{ Code = $code; Content = $bodyText; ExitCode = $(if ($null -ne $curlRc) { [int]$curlRc } else { $null }); ErrorText = $errText }
}
# ---- U-267（B3-1 第一步）：离线回放接缝 ----
# 为什么需要：B3-1 要求"回放态逐字节一致"，而实测（2026-10-26）同一查询两次活网跑会出现
#   `coverage.ReasonCodes.GitHub: error → deadline`、`Verdict: partial → degraded`、`Executed` 成员变化 ——
#   **时间决定分类**（引擎截止 vs 失败谁先到），外加 crates 的 Stars 是实时下载量（两次差 ±50）。
#   活网永远不可能有稳定基线，所以回放不是"锦上添花"，是 B3-2 拆分的前置条件。
# 边界（写清楚，免得被当成万能）：
#   · **2xx 原样返回；非 2xx 合成一次同形的失败**（v1.68.0 / U-286 修正，见 `Invoke-ApiReplayOnce` 里那段）：
#     此前非 2xx 被当成 200 返回 —— 录到 500 的引擎会拿到空正文，然后报"检索成功但 0 命中"，
#     把"源挂了"说成"没有"。合成用 PS7 的 `HttpResponseException`（带 HttpResponseMessage：状态码/头/正文），
#     于是 `Resolve-ApiHttpFailure` 能照常读到 `Retry-After` / `x-ratelimit-remaining` / 403 正文。
#     ★PS 5.1 没有这个类型 ⇒ 退化成带状态码的普通异常（仍能按消息分档，但**拿不到响应头**）。
#   · **录制**（`Save-ApiReplayFixture`）仍只在成功出口写盘：失败请求录不到。
#     CLI 级行为臂的做法是"夹具跑一遍 → 按夹具记录重建 responses.jsonl"（`tests/behavior/lib/cli-replay.mjs`），
#     不依赖录制口。
#   · 只拦 `Invoke-ApiWebOnce`（web 路径）。socks 走 `Invoke-ApiSocksOnce`，那条路**不支持**回放 ⇒ 回放期强制直连；
#     若仍被路由到 socks，`Invoke-ApiSocksOnce` 会显式抛错（宁红不静默打网）。
#   · 录制内容是 `Repair-Latin1Mojibake` **之后**的文本（回放不再重跑修复；该逻辑有自己的门 U-132）。
function Get-ApiReplayKey {
    param([string]$Uri, [string]$Method = 'GET', [string]$Body = '')
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $raw = (($Method.ToUpperInvariant()) + "`n" + $Uri + "`n" + ([string]$Body))
        $hex = ([System.BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($raw)))) -replace '-', ''
        return $hex.Substring(0, 16).ToLowerInvariant()
    } finally { $sha.Dispose() }
}
function Invoke-ApiReplayOnce {
    param([string]$Uri, [string]$Method = 'GET', [string]$Body = '')
    $dir = $env:MCPS_REPLAY_DIR
    if ([string]::IsNullOrWhiteSpace($dir)) { return $null }   # 快路径：未启用回放（生产默认）
    if (-not $script:_replayIndex) {
        $path = Join-Path $dir 'responses.jsonl'
        if (-not (Test-Path $path)) { throw "replay-miss: 录制文件不存在 $path（MCPS_REPLAY_DIR 指向了空目录？）" }
        $idx = @{}
        foreach ($line in [System.IO.File]::ReadLines($path)) {
            if ([string]::IsNullOrWhiteSpace($line)) { continue }
            $o = $line | ConvertFrom-Json
            if (-not $idx.ContainsKey([string]$o.key)) { $idx[[string]$o.key] = New-Object System.Collections.ArrayList }
            [void]$idx[[string]$o.key].Add($o)
        }
        $script:_replayIndex = $idx
        $script:_replayCursor = @{}
    }
    $key = Get-ApiReplayKey -Uri $Uri -Method $Method -Body $Body
    if (-not $script:_replayIndex.ContainsKey($key)) { throw "replay-miss: $Method $Uri (key=$key)" }
    $list = $script:_replayIndex[$key]
    $n = 0; if ($script:_replayCursor.ContainsKey($key)) { $n = [int]$script:_replayCursor[$key] }
    if ($n -ge $list.Count) { throw ("replay-exhausted: {0} {1}（第 {2} 次请求，录制只有 {3} 条）" -f $Method, $Uri, ($n + 1), $list.Count) }
    $script:_replayCursor[$key] = $n + 1
    $hit = $list[$n]
    $h = @{}
    if ($hit.headers) { foreach ($p in $hit.headers.PSObject.Properties) { $h[$p.Name] = [string]$p.Value } }
    $code = [int]$hit.status
    if ($code -lt 200 -or $code -ge 300) {
        # ★v1.68.0（U-286 实跑抓到）：非 2xx 必须**抛**，不能当 200 返回。
        #   此前这一行是 `return @{Content=...; StatusCode=$code}` ⇒ 引擎拿到 500 的空正文 ⇒ 报"检索成功但 0 命中"，
        #   把"源挂了"说成"没有"。合成失败用 PS7 的 `HttpResponseException`（带 HttpResponseMessage），
        #   于是 `Resolve-ApiHttpFailure` 照常能读到 StatusCode / Retry-After / x-ratelimit-remaining / 403 正文，
        #   重试与限流判定都走生产同一条路。★这里**不新开函数**：`Invoke-ApiReplayOnce` 在 `Get-HttpLayerClosure` 里，
        #   新函数不在闭包内 ⇒ 池内调用只剩 CommandNotFound（U-284 的坑）。
        $msg = ('响应状态代码未指示成功: {0}' -f $code)
        $ex = $null
        try {
            $hm = New-Object System.Net.Http.HttpResponseMessage ([System.Net.HttpStatusCode]$code)
            $hm.Content = New-Object System.Net.Http.StringContent ([string]$hit.content)
            foreach ($hk in @($h.Keys)) { try { [void]$hm.Headers.TryAddWithoutValidation([string]$hk, [string]$h[$hk]) } catch { } }
            $ex = [Microsoft.PowerShell.Commands.HttpResponseException]::new($msg, $hm)
        } catch { }
        # PS 5.1 没有 HttpResponseException ⇒ 退化成带状态码的普通异常（引擎仍能按消息分档，但拿不到响应头）
        if ($null -eq $ex) { $ex = New-Object System.Exception($msg) }
        throw $ex
    }
    return [PSCustomObject]@{ Content = [string]$hit.content; StatusCode = $code; Headers = $h }
}
function Save-ApiReplayFixture {
    param([string]$Uri, [string]$Method = 'GET', [string]$Body = '', [int]$Status = 200, $Headers, [string]$Content = '')
    $dir = $env:MCPS_RECORD_DIR
    if ([string]::IsNullOrWhiteSpace($dir)) { return }        # 快路径：未启用录制（生产默认）
    if (-not (Test-Path $dir)) { $null = New-Item -ItemType Directory -Path $dir -Force }
    $h = @{}
    try {
        foreach ($k in @('content-type', 'Content-Type', 'x-ratelimit-remaining', 'X-RateLimit-Remaining', 'Retry-After')) {
            if ($Headers -and $null -ne $Headers[$k]) { $h[$k] = [string](@($Headers[$k]) -join ',') }
        }
    } catch { }
    $row = [PSCustomObject]@{ key = (Get-ApiReplayKey -Uri $Uri -Method $Method -Body $Body); method = $Method; uri = $Uri; status = $Status; headers = $h; content = $Content }
    $line = ($row | ConvertTo-Json -Depth 4 -Compress)
    # 跨 runspace 串行化：AppDomain 共享锁（池里多个引擎同时写同一文件，不加锁会截断行）
    $lock = [System.AppDomain]::CurrentDomain.GetData('mcps_replay_lock')
    if (-not $lock) { $lock = New-Object object; [System.AppDomain]::CurrentDomain.SetData('mcps_replay_lock', $lock) }
    [System.Threading.Monitor]::Enter($lock)
    try { [System.IO.File]::AppendAllText((Join-Path $dir 'responses.jsonl'), $line + "`n", (New-Object System.Text.UTF8Encoding($false))) }
    finally { [System.Threading.Monitor]::Exit($lock) }
}
function Invoke-ApiWebOnce {
    param([string]$Uri, [hashtable]$Headers, [int]$TimeoutSec, [string]$Method, [string]$Body, $networkRoute, [switch]$NoProxy, $reqSw)
    $rp = Invoke-ApiReplayOnce -Uri $Uri -Method $Method -Body $Body
    if ($null -ne $rp) { $reqSw.Stop(); return $rp }   # U-267：回放命中（未启用时上面返回 $null，生产走原路）
    $reqParams = @{ Uri = $Uri; Headers = $Headers; UseBasicParsing = $true; TimeoutSec = $TimeoutSec; Method = $Method }
    if ($Body) { $reqParams['Body'] = $Body }
    if ($networkRoute.Kind -eq 'http') { $reqParams['Proxy'] = $networkRoute.ProxyUrl } # 所选代理显式传入，避免 PS7 又被另一个环境代理覆盖
    $r = Invoke-WebRequestDirect -Params $reqParams -Direct:$NoProxy   # U-40：-NoProxy ⇒ 两运行时都真正直连
    $reqSw.Stop()
    # R1 可观测性：记录每次请求延迟（进程级共享，跨 Runspace 池汇总，因同进程同 AppDomain）
    try {
        $bag = [System.AppDomain]::CurrentDomain.GetData('mcps_latencies')
        if (-not $bag) { $bag = New-Object 'System.Collections.Concurrent.ConcurrentBag[double]'; [System.AppDomain]::CurrentDomain.SetData('mcps_latencies', $bag) }
        $bag.Add($reqSw.Elapsed.TotalMilliseconds)
    } catch { }
    # v1.28.0：PS5.1 Invoke-WebRequest 对无 charset 的 application/json 响应用 Latin-1(28591) 解码，
    # UTF-8 中文会变乱码（实测 京东零售 → äº¬ä¸é¶å®）。统一转回 UTF-8：
    # 将 Content 字符按 Latin-1 编码回原始字节，再按 UTF-8 解码。纯 ASCII 内容无影响（字节不变）。
    # U-132（2026-09-28）：上述重解码原为无条件执行 —— PS 7 的 Invoke-WebRequest 已按 UTF-8 正确解码，再按 Latin-1 取字节会把
    # 所有 >U+00FF 的字符（中日韩、emoji）折成 '?'（不可逆；C13 Gitee 对照落盘字节实测 "???/vue-admin-better"）。
    # 改为只在"全部字符 ≤ U+00FF（确为 Latin-1 解码产物）"时重解码，见 Repair-Latin1Mojibake。
    $out = $null
    try {
        if ($r.Content -is [string] -and $r.Content.Length -gt 0) {
            $out = [PSCustomObject]@{ Content = (Repair-Latin1Mojibake -Text $r.Content); StatusCode = [int]$r.StatusCode; Headers = $r.Headers }
        } else {
            $out = [PSCustomObject]@{ Content = $r.Content; StatusCode = [int]$r.StatusCode; Headers = $r.Headers }
        }
    } catch {
        # 逆转失败则原样返回（保底）
        $out = [PSCustomObject]@{ Content = $r.Content; StatusCode = [int]$r.StatusCode; Headers = $r.Headers }
    }
    Save-ApiReplayFixture -Uri $Uri -Method $Method -Body $Body -Status ([int]$out.StatusCode) -Headers $out.Headers -Content ([string]$out.Content)   # U-267：未启用录制时空转
    return $out
}
function Resolve-ApiHttpFailure {
    param($ErrorRecord, $reqSw, [string]$Uri = '')
    # N-8：PS 5.1=WebException，PS 7=HttpRequestException/HttpResponseException；其他错误原样抛出。
    # 用类型全名而非 PS 5.1 可能尚未装载的 [System.Net.Http.HttpRequestException] 类型字面量。
    $httpErr = $ErrorRecord.Exception
    $httpTypes = @('System.Net.Http.HttpRequestException', 'Microsoft.PowerShell.Commands.HttpResponseException')
    while ($httpErr.InnerException -and $httpErr -isnot [System.Net.WebException] -and
           $httpErr.GetType().FullName -notin $httpTypes) { $httpErr = $httpErr.InnerException }
    $isHttpFailure = ($httpErr -is [System.Net.WebException]) -or ($httpErr.GetType().FullName -in $httpTypes)
    if (-not $isHttpFailure) { return [PSCustomObject]@{ IsHttpFailure = $false; Response = $null } }
    try {
        $bag = [System.AppDomain]::CurrentDomain.GetData('mcps_latencies')
        if (-not $bag) { $bag = New-Object 'System.Collections.Concurrent.ConcurrentBag[double]'; [System.AppDomain]::CurrentDomain.SetData('mcps_latencies', $bag) }
        $bag.Add($reqSw.Elapsed.TotalMilliseconds)
    } catch { }
    $resp = $httpErr.Response
    # U-01：PS 7 拒绝连接时也可能给合成 Response/502；须由异常链判传输失败，不能只看 Response 是否非空。
    $isTransport = ($httpErr -is [System.Net.WebException] -and $null -eq $resp)
    if ($httpErr -isnot [System.Net.WebException]) {
        $inner = $ErrorRecord.Exception
        while ($inner -and -not $isTransport) {
            if ($inner.GetType().FullName -eq 'System.Net.Http.HttpRequestException') { $isTransport = $true }
            else { $inner = $inner.InnerException }
        }
    }
    if ($isTransport) { $resp = $null }
    elseif ($resp) {
        # U-02：真实响应统一成跨版本形状；只取重试需要的头，403 保留正文供二次限流判定。
        # PS 7 的 Invoke-WebRequest 有时已消费 Response.Content，正文只留在 ErrorDetails.Message。
        $errorBody = if ($ErrorRecord.ErrorDetails) { [string]$ErrorRecord.ErrorDetails.Message } else { '' }
        $httpCode = [int]$resp.StatusCode; Set-ApiLedgerStatus -Status $httpCode   # U-261：这是失败路径上唯一拿得到的状态码（402/429/5xx 都从这里过）
        $httpHeaders = @{}; $httpBody = ''
        if ($resp.GetType().FullName -eq 'System.Net.Http.HttpResponseMessage') {
            try {
                foreach ($h in $resp.Headers) {
                    if ($h.Key -in @('x-ratelimit-remaining', 'Retry-After')) { $httpHeaders[[string]$h.Key] = @($h.Value) -join ',' }
                }
                if ($resp.Content) {
                    foreach ($h in $resp.Content.Headers) {
                        if ($h.Key -in @('x-ratelimit-remaining', 'Retry-After')) { $httpHeaders[[string]$h.Key] = @($h.Value) -join ',' }
                    }
                    if ($httpCode -eq 403) { $httpBody = [string]$resp.Content.ReadAsStringAsync().GetAwaiter().GetResult() }
                }
            } catch { }
        } else {
            try {
                foreach ($name in @('x-ratelimit-remaining', 'Retry-After')) {
                    $value = $resp.Headers[$name]
                    if ($null -ne $value) { $httpHeaders[$name] = [string]$value }
                }
                if ($httpCode -eq 403) {
                    $stream = $resp.GetResponseStream()
                    if ($stream) {
                        $sr = New-Object System.IO.StreamReader($stream)
                        try { $httpBody = $sr.ReadToEnd() } finally { $sr.Dispose() }
                    }
                }
            } catch { }
        }
        if ($httpCode -eq 403 -and -not $httpBody -and $errorBody) { $httpBody = $errorBody }
        $resp = [PSCustomObject]@{ StatusCode = $httpCode; Headers = $httpHeaders; Body = $httpBody }
        # v1.46.0：403 正文留证（截断 4KB，带 Uri/时间戳）—— 引擎据此区分「边缘防火墙拦（Firewall Block）」与「令牌无权」；只存 403，120s 时效防盗用。
        if ($httpCode -eq 403) { try { $bb = [string]$httpBody; if ($bb.Length -gt 4096) { $bb = $bb.Substring(0, 4096) }; [System.AppDomain]::CurrentDomain.SetData('mcps_last_403', [PSCustomObject]@{ Uri = $Uri; Ts = [DateTime]::UtcNow; Body = $bb }) } catch { } }
    }
    # 仅真实 HTTP 错误可凭 StatusCode 补形状；传输失败要保留 null 进入 TLS 兜底。
    elseif ($httpErr.PSObject.Properties['StatusCode'] -and $null -ne $httpErr.StatusCode) {
        $resp = [PSCustomObject]@{ StatusCode = [int]$httpErr.StatusCode; Headers = @{}; Body = '' }
    }
    return [PSCustomObject]@{ IsHttpFailure = $true; Response = $resp }
}
function Get-ApiNodePaths {
    param([string]$traceUri)
    # v1.36.5：优先用顶层解析并注入的路径（Runspace 内 PSScriptRoot 为空）；未注入时（dot-source 单测）按旧法现取
    $nodeExe = $script:NodeExePath
    if (-not $nodeExe) { $nodeExe = (Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source }
    $engine = $script:NodeEnginePath
    if (-not $engine -and $PSScriptRoot) { $engine = Join-Path $PSScriptRoot 'tools\node-https-engine.mjs' }
    Write-TlsTrace ("fallback-guard nodeExe={0} engine={1} engineExists={2} {3}" -f [bool]$nodeExe, [bool]$engine, [bool]($engine -and (Test-Path -LiteralPath $engine)), $traceUri)
    return [PSCustomObject]@{ NodeExe = $nodeExe; Engine = $engine; Ok = [bool]($nodeExe -and $engine -and (Test-Path -LiteralPath $engine)) }
}
function Invoke-ApiNodeOnce {
    param([string]$nodeExe, [string]$engine, [string]$Uri, [hashtable]$Headers, [string]$Method, [string]$Body, [int]$NodeDeadlineSec, [string]$traceUri)
    $hdrArgs = @()
    if ($Headers) {
        foreach ($hk in $Headers.Keys) { $hdrArgs += "$hk`:$($Headers[$hk])" }
    }
    # v1.28.0：node 引擎改走 -o 文件输出——避免 PS 捕获超长单行 JSON 时截断、以及
    # PS 用系统 ANSI 解码 UTF-8 导致中文乱码（node 写 UTF-8 文件，PS ReadAllText 正确读）。
    $tmpBodyFile = [System.IO.Path]::GetTempFileName()
    $tmpPostFile = $null
    try {
        # R-2：node 引擎 v2.2 -B 文件体，避开 Windows argv 上限，也不把 @ 开头的字面体当路径。
        # 引擎参数顺序固定：-o → -d → -X → -B → url → headers。
        $nodeArgs = @('--use-system-ca', $engine, '-o', $tmpBodyFile)
        $ndMs = if ($NodeDeadlineSec -gt 0) { [int]($NodeDeadlineSec * 1000) } else { [int]($script:Cfg.NodeDeadlineSec * 1000) }
        if ($ndMs -gt 0) { $nodeArgs += '-d', "$ndMs" }
        if ($Method -ne 'GET') { $nodeArgs += '-X', $Method }
        # R-2b：[string]$Body 默认 null 可变成空串；GET 无 body 时不能附加 -B。
        if (-not [string]::IsNullOrEmpty($Body)) {
            $tmpPostFile = [System.IO.Path]::GetTempFileName()
            [System.IO.File]::WriteAllText($tmpPostFile, $Body, [System.Text.UTF8Encoding]::new($false))
            $nodeArgs += '-B', $tmpPostFile
        }
        $nodeArgs += $Uri
        $nodeArgs += $hdrArgs
        $nodeOut = & $nodeExe @nodeArgs 2>&1
        $statusMatch = $nodeOut | Select-String -Pattern '^STATUS (\d+)$' | Select-Object -First 1
        $traceNode = if ($statusMatch) { 'status=' + $statusMatch.Matches[0].Groups[1].Value } else { 'no-status(transport-failure)' }
        Write-TlsTrace ("fallback-node-result {0} {1}" -f $traceNode, $traceUri)
        if ($statusMatch) {
            $nodeCode = [int]$statusMatch.Matches[0].Groups[1].Value
            $bodyText = ''
            if (Test-Path $tmpBodyFile) { $bodyText = [System.IO.File]::ReadAllText($tmpBodyFile) }
            return [PSCustomObject]@{ HasStatus = $true; StatusCode = $nodeCode; Content = $bodyText }
        }
        return [PSCustomObject]@{ HasStatus = $false; StatusCode = $null; Content = '' }
    } finally {
        if ($tmpPostFile) { Remove-Item -LiteralPath $tmpPostFile -Force -ErrorAction SilentlyContinue }
        Remove-Item $tmpBodyFile -Force -ErrorAction SilentlyContinue
    }
}
function Update-ApiRetryCounters {
    param($resp)
    # v1.36.3：限流计数改走 AppDomain 共享 [int[]]（同 mcps_retries）——旧做法（script 作用域计数器自增）在 Runspace 内
    # 落到各自作用域，并发路径下 metrics.RateLimitedCount 恒 0。
    if ($resp.StatusCode -eq 429 -or $resp.StatusCode -eq 403) {
        try {
            $rl = [System.AppDomain]::CurrentDomain.GetData('mcps_ratelimited')
            if (-not $rl) { $rl = [int[]]::new(1); [System.AppDomain]::CurrentDomain.SetData('mcps_ratelimited', $rl) }
            [System.Threading.Monitor]::Enter($rl)
            try { $rl[0]++ } finally { [System.Threading.Monitor]::Exit($rl) }
        } catch { }
    }
    # R1 可观测性：累计重试次数（共享存储，跨 Runspace 汇总）
    # 注意：PS 中 [ref]$rc[0] 被解析为 ([ref]$rc)[0]（取元素值而非元素引用），Interlocked 无效；
    # 改用 Monitor 锁对共享 [int[]] 元素做原子自增。
    try {
        $rc = [System.AppDomain]::CurrentDomain.GetData('mcps_retries')
        if (-not $rc) { $rc = [int[]]::new(1); [System.AppDomain]::CurrentDomain.SetData('mcps_retries', $rc) }
        [System.Threading.Monitor]::Enter($rc)
        try { $rc[0]++ } finally { [System.Threading.Monitor]::Exit($rc) }
    } catch { }
}
function Test-ApiRetryBudget {
    $budgetExhausted = $false
    try {
        $budget = [System.AppDomain]::CurrentDomain.GetData('mcps_retry_budget')
        if ($budget) {
            [System.Threading.Monitor]::Enter($budget)
            try {
                if ($budget[0] -le 0) { $budgetExhausted = $true }
                else { $budget[0]-- }
            } finally { [System.Threading.Monitor]::Exit($budget) }
        }
    } catch { }
    return $budgetExhausted
}
function Get-ApiWallBudget {
    # P1（2026-10-19）：**一次逻辑请求的总预算**（秒）。0 / 未给 Start ⇒ 关闭，返回原 TimeoutSec（旧行为逐位不变）。
    # 为什么需要它（实测 2026-10-19）：`-TimeoutSec` 只约束「单次 HTTP 往返」，而一次逻辑请求的真实耗时是
    #   逐域路由探活（候选×(HEAD 2.5s + GET 2.5s)）+ 主请求（TimeoutSec）+ node TLS 兜底（NodeDeadlineSec 默认 25s）
    #   三层**串联**。Doctor 的 Sourcegraph 探测 TimeoutSec=6 却耗 29.8s、NuGet 探测 11.5s，都是这条链累加。
    # 只**计算**不抛异常（D4 规则：throw 留在 Invoke-ApiRequest 调用点）。
    # 语义边界：本预算限制「每次尝试的超时」与「是否还值得再试/兜底」；调用点仍用 MaxAttempts 控制次数。
    #   ★用它时请配 MaxAttempts=1（探针范式）—— 退避 Start-Sleep 不在本预算内（Doctor 探针全为单次尝试）。
    param($Start, [int]$DeadlineSec, [int]$TimeoutSec, [int]$MinAttemptMs = 200)
    if (-not $Start -or $DeadlineSec -le 0) { return [PSCustomObject]@{ Exhausted = $false; TimeoutSec = $TimeoutSec; RemainingMs = 0; UsedMs = 0 } }
    $usedMs = [int](([DateTime]::UtcNow - $Start).TotalMilliseconds)
    $remainMs = [int]($DeadlineSec * 1000) - $usedMs
    if ($remainMs -lt $MinAttemptMs) { return [PSCustomObject]@{ Exhausted = $true; TimeoutSec = 0; RemainingMs = [Math]::Max(0, $remainMs); UsedMs = $usedMs } }
    $sec = [int][Math]::Ceiling($remainMs / 1000.0)
    return [PSCustomObject]@{ Exhausted = $false; TimeoutSec = [int][Math]::Max(1, [Math]::Min($TimeoutSec, $sec)); RemainingMs = $remainMs; UsedMs = $usedMs }
}
# ---------- U-256（v1.53.27，验收 B1-6 / F10）：请求账本 ----------
# 病灶（实测）：`metrics.Requests` 取的是**共享延迟袋条数** ⇒ 只数"拿到响应的那几次"，
#   传输层失败（DNS/连接/超时/被 deadline 杀掉）**一次都不计**。repo 模式 4 个引擎都真的发了请求，
#   读数却常是 2 —— 拿它当分母算失败率会得到错的结论。
# 口径（恒等式由构造保证，不靠"记得在每条出口都记一次"）：
#   Requests          = attempted —— **每一次真正走到发送的请求**（含重试与 node 兜底；预算早退/主机已死的不算）
#   RequestsSucceeded = 拿到 2xx 响应
#   RequestsFailed    = attempted − succeeded（**派生，不单独计数**：少记一次会变成负数，比悄悄少 1 更容易被发现）
#   RequestsReturned  = 旧口径（延迟袋条数），保留一个版本给老消费者对照
# ★为什么用 ConcurrentBag 而不是计数器：PS 5.1 里 `[ref]$arr[0]` 不成立，Interlocked 对数组元素取不到址；
#   而且跨 Runspace 共享只能靠 AppDomain 数据。条目数=请求数（每轮百级），聚合成本可忽略。
function Add-ApiRequestStat {
    param([ValidateSet('attempt', 'ok')][string]$Kind, [int]$Attempt = 0, $Sw = $null, $Status = $null)
    try {
        $bag = [System.AppDomain]::CurrentDomain.GetData('mcps_reqstats')
        if (-not $bag) {
            $bag = New-Object 'System.Collections.Concurrent.ConcurrentBag[string]'
            [System.AppDomain]::CurrentDomain.SetData('mcps_reqstats', $bag)
        }
        $bag.Add($(if ($Kind -eq 'attempt') { 'a' } else { 'o' }))
    } catch { }
    # B2-6（U-261）：账本与计数**同点入账** —— 两处分别记必然漂移，而"行数 == Requests"正是账本的唯一硬恒等式。
    try {
        if ($Kind -eq 'attempt') { $null = Add-ApiLedgerRow -Attempt $Attempt -Sw $Sw }
        else { Close-ApiLedgerRow -Row $script:_ledgerOpen -Ok -Status $Status }
    } catch { }
}
function Get-ApiRequestStats {
    $a = 0; $o = 0
    try {
        $bag = [System.AppDomain]::CurrentDomain.GetData('mcps_reqstats')
        if ($bag) { foreach ($x in $bag) { if ($x -eq 'a') { $a++ } elseif ($x -eq 'o') { $o++ } } }
    } catch { }
    # Failed 允许为负并如实返回 —— 那说明"成功了却没记 attempt"，是账本 bug，压成 0 会把它藏起来。
    return [PSCustomObject]@{ Attempted = $a; Succeeded = $o; Failed = ($a - $o) }
}
# ── B2-6（U-261）：成本账本 v0 ──────────────────────────────────────────────
# 一行 = **一次线上尝试**（不是一次引擎调用）。硬恒等式：`行数 == metrics.Requests`。
#   为什么"总是收集、按需落盘"：行对象只有几十个、收集成本可忽略；**落盘**（`MCPS_LEDGER=<path>`）才有副作用。
#   这样"账本没丢行"在**每一轮**都能被校验，不必等到有人打开开关 —— 而"悄悄丢行"的账本比没有更坏
#   （它会让"402 之后没重试"这种结论凭空成立）。
# 归属（engine / mode）用**每 runspace 的 `$script:` 标量**：探针 tests/u261-probe-runspace-ledger-ctx.ps1
#   实测 8 runspace × 200 轮零串台。★不能用 AppDomain 共享标量 —— 8 个 runspace 会互相覆盖，
#   账本会"看起来精确但指错人"，那是本仓最不能接受的一类谎。
# ★seq 用 ConcurrentDictionary.AddOrUpdate 而不是 Interlocked：`[ref]$arr[0]` 在 PowerShell 里会**静默**
#   作用在副本上（实测返回值递增、数组元素恒为 0）⇒ seq 全是 0 且看不出来。AddOrUpdate 是真原子。
function Get-ApiLedgerVerdict {
    # 纯函数：只由 (是否成功, HTTP 状态码) 推出 outcome / reasonCode / quotaClass。无副作用、可单测。
    #   ★402 ⇒ `quota-exhausted`：与**健康记忆**的「402/余额不足/quota ⇒ quota」同口径，不另起一套判定
    #   （同一事实两处算必然漂移）。★注释里不点函数名：U-41 的传递闭包会扫进注释，点一次名就把整条调用链拉进闭包。
    param([switch]$Ok, $Status)
    $s = 0
    try { if ($null -ne $Status -and "$Status" -ne '') { $s = [int]$Status } } catch { $s = 0 }
    # ★2xx 一律算成功（不看 -Ok）：线上答了 2xx 就是成功，`-Ok` 只是成功出口的显式标记。
    #   第一版把"2xx 但没传 -Ok"归成 transport —— 那是**知道状态码却报成不知道**，正是本仓最恨的那类谎
    #   （门 U-261 的真值表当场把它抓出来）。
    if ($Ok -or ($s -ge 200 -and $s -lt 300)) { return [PSCustomObject]@{ Outcome = 'ok'; ReasonCode = $null; QuotaClass = 'none' } }
    if ($s -eq 402) { return [PSCustomObject]@{ Outcome = 'failure'; ReasonCode = 'quota-exhausted'; QuotaClass = 'quota' } }
    if ($s -eq 429) { return [PSCustomObject]@{ Outcome = 'failure'; ReasonCode = 'rate-limited'; QuotaClass = 'rate-limit' } }
    if ($s -ge 500) { return [PSCustomObject]@{ Outcome = 'failure'; ReasonCode = 'http-5xx'; QuotaClass = 'none' } }
    if ($s -ge 400) { return [PSCustomObject]@{ Outcome = 'failure'; ReasonCode = 'http-4xx'; QuotaClass = 'none' } }
    # 拿不到状态码（传输失败/超时/代理无码）：只能记 transport，**不猜**具体原因。
    return [PSCustomObject]@{ Outcome = 'failure'; ReasonCode = 'transport'; QuotaClass = 'none' }
}
function Set-ApiLedgerStatus {
    # 只盖状态码、不结行：状态码是**失败路径上唯一拿得到的证据**（响应体不进日志）。
    #   调用点在"刚拿到响应"的两处（Resolve-ApiHttpFailure 的 $httpCode、socks 分支的 $code）——
    #   而不是丢异常之前：等到抛的时候已经来不及记了。
    param($Status)
    try {
        if ($null -eq $Status -or "$Status" -eq '') { return }
        $row = $script:_ledgerOpen
        if ($row -and [string]$row.outcome -eq 'open') { $row.httpStatus = [int]$Status }
    } catch { }
}
function Close-ApiLedgerRow {
    # 结一行（幂等：已结过的直接返回）。`-Status` 为空时沿用行上被 Set-ApiLedgerStatus 盖过的状态 ——
    #   否则 402 这类"一次就抛"的尝试会在收尾时被误记成 transport。
    param($Row, [switch]$Ok, $Status = $null)
    if (-not $Row) { return }
    try {
        if ([string]$Row.outcome -ne 'open') { return }
        $eff = if ($null -ne $Status -and "$Status" -ne '') { $Status } else { $Row.httpStatus }
        $v = Get-ApiLedgerVerdict -Ok:$Ok -Status $eff
        if ($null -ne $eff -and "$eff" -ne '') { $Row.httpStatus = [int]$eff }
        $Row.outcome = $v.Outcome
        $Row.reasonCode = $v.ReasonCode
        $Row.quotaClass = $v.QuotaClass
        try {
            $sws = [System.AppDomain]::CurrentDomain.GetData('mcps_ledger_sw')
            if ($sws -and $sws.ContainsKey([int]$Row.seq)) {
                $sw = $sws[[int]$Row.seq]
                if ($sw) { $sw.Stop(); $Row.latencyMs = [int]$sw.ElapsedMilliseconds }
            }
        } catch { }
        if ([object]::ReferenceEquals($script:_ledgerOpen, $Row)) { $script:_ledgerOpen = $null }
    } catch { }
}
function Add-ApiLedgerRow {
    # 开一行。**同一 runspace 内上一行若还开着 ⇒ 它一定没成功**（成功出口会结掉它），先按失败结掉 ——
    #   这是"每行恰好代表一次尝试"的机制保证，不依赖每个调用方都记得收尾。
    #   ★-Sw 必须由调用方**按每次尝试**给：node 兜底是另一次线上尝试（Requests 也把它算一次），
    #   共用同一只秒表会把 web 那次的耗时记到 node 头上 —— 账本里两行同毫秒数，比 null 更像真的。
    param([int]$Attempt = 0, $Sw = $null)
    try {
        $prev = $script:_ledgerOpen
        if ($prev) { Close-ApiLedgerRow -Row $prev -Ok:$false }
        $bag = [System.AppDomain]::CurrentDomain.GetData('mcps_ledger')
        if (-not $bag) {
            $bag = New-Object 'System.Collections.Concurrent.ConcurrentBag[object]'
            [System.AppDomain]::CurrentDomain.SetData('mcps_ledger', $bag)
        }
        $seq = 0
        $ctr = [System.AppDomain]::CurrentDomain.GetData('mcps_ledger_seq')
        if ($ctr) { $seq = [int]$ctr.AddOrUpdate('n', 1, { param($k, $v) $v + 1 }) }
        $row = [PSCustomObject]@{
            runId      = [string]([System.AppDomain]::CurrentDomain.GetData('mcps_run_id'))
            seq        = $seq
            ts         = (Get-Date).ToUniversalTime().ToString('o')
            mode       = [string]$script:_ledgerMode
            engine     = [string]$script:_ledgerEngine
            attempt    = $Attempt
            httpStatus = $null
            outcome    = 'open'
            reasonCode = $null
            latencyMs  = $null
            quotaClass = 'none'
        }
        $bag.Add($row)
        try {
            $sws = [System.AppDomain]::CurrentDomain.GetData('mcps_ledger_sw')
            if ($sws -and $null -ne $Sw) { $sws[[int]$seq] = $Sw }
        } catch { }
        $script:_ledgerOpen = $row
        return $row
    } catch { return $null }
}
function Get-ApiLedgerRows {
    # 按 seq 排序返回（JSONL 的可读性靠它；seq 是原子发的，顺序 ≈ 到达顺序）。
    try {
        $bag = [System.AppDomain]::CurrentDomain.GetData('mcps_ledger')
        if (-not $bag) { return @() }
        return @($bag | Sort-Object { [int]$_.seq })
    } catch { return @() }
}
function Get-ApiRequestLedgerByEngine {
    # B2-1 第 4/4（U-265）：从**账本**派生逐引擎请求账，而不是让引擎自己再数一遍。
    #   为什么不在引擎里逐点 += ：GitLabBlobs 的请求分散在 4 个辅助函数 + 一个嵌套 runspace 池里，
    #   逐点手写必然有漏（DeepSeek 那轮就漏了 `$req.failed++`，靠夹具恒等式才抓到）。而 B2-6 的账本
    #   在 `Invoke-ApiRequest` 内部**必然**落一行（`attempted == 行数`），行上带 engine ⇒ 按 engine 聚合即三格。
    #   同一份事实只有一处，不会出现"账本记 5 次、封套说 4 次"。
    #   ★前提：调用点已设好 `$script:_ledgerEngine`（池内包装块 / 串行 Invoke-EngineSerial / GitLab 嵌套池，各一处）。
    #     没设 ⇒ 过滤不到 ⇒ 返回 0/0/0（**如实报零，不猜**），而不是回退去数别的信号。
    #   ★`outcome='open'`（未结行）算 failed：它是"发了但没成功"—— 与 `failed = 总数 - 成功数` 同一口径，
    #     也与 B1-6 对 `metrics.RequestsFailed` 的定义一致。
    param([string]$Engine)
    if (-not $Engine) { return @{ attempted = 0; succeeded = 0; failed = 0 } }
    $rows = @(Get-ApiLedgerRows | Where-Object { [string]$_.engine -eq $Engine })
    $ok = @($rows | Where-Object { [string]$_.outcome -eq 'ok' }).Count
    return @{ attempted = [int]$rows.Count; succeeded = [int]$ok; failed = [int]($rows.Count - $ok) }
}
function Reset-ApiLedger {
    # 每轮重置（与 mcps_reqstats 同一处调用）：新袋、新计数器、新 runId。
    #   runId 每轮换是**必要**的：`-Serve` 长驻进程里不换，第 2 轮的行会冒充第 1 轮的。
    try {
        [System.AppDomain]::CurrentDomain.SetData('mcps_ledger', (New-Object 'System.Collections.Concurrent.ConcurrentBag[object]'))
        [System.AppDomain]::CurrentDomain.SetData('mcps_ledger_sw', (New-Object 'System.Collections.Concurrent.ConcurrentDictionary[int,object]'))
        [System.AppDomain]::CurrentDomain.SetData('mcps_ledger_seq', (New-Object 'System.Collections.Concurrent.ConcurrentDictionary[string,int]'))
        [System.AppDomain]::CurrentDomain.SetData('mcps_run_id', ((Get-Date).ToString('yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 6)))
        $script:_ledgerOpen = $null
    } catch { }
}
function Save-ApiLedger {
    # 汇总 + 按需落盘。返回的块直接进 `execution.ledger`（schema 闭合）。
    #   ★「未落盘」与「落盘失败」必须长得很不一样：前者 path=$null / written=0 / error=$null（正常），
    #     后者 error 非空。把两者混成一个"0 行"会让"没有账本"和"账本丢了"不可区分。
    param([switch]$NoWrite)
    $rows = @(Get-ApiLedgerRows)
    # 收尾：仍是 open 的行 = 开了却没人结 = 那次尝试没成功（最后一行尤其常见：402 一次就抛）。
    foreach ($r in $rows) { if ([string]$r.outcome -eq 'open') { Close-ApiLedgerRow -Row $r -Ok:$false } }
    $runId = [string]([System.AppDomain]::CurrentDomain.GetData('mcps_run_id'))
    $path = [string]$env:MCPS_LEDGER
    $written = 0; $err = $null; $full = $null
    if ($path -and -not $NoWrite) {
        try {
            $full = [System.IO.Path]::GetFullPath($path)
            $lines = [string[]]@($rows | ForEach-Object { ConvertTo-Json -InputObject $_ -Compress -Depth 4 })
            if ($lines.Count -gt 0) {
                [System.IO.File]::AppendAllText($full, (($lines -join "`n") + "`n"), (New-Object System.Text.UTF8Encoding($false)))
                $written = $lines.Count
            }
        } catch { $err = [string]$_.Exception.Message; $written = 0 }
    } elseif ($path) { $full = $path }
    return [PSCustomObject]@{
        runId   = $runId
        rows    = $rows.Count
        path    = $(if ($full) { $full } else { $null })
        written = $written
        error   = $err
    }
}
function Invoke-ApiRequest {    param([string]$Uri, [hashtable]$Headers, [int]$TimeoutSec = $script:Cfg.ApiTimeoutDefaultSec, [string]$Method = 'GET', [string]$Body = $null, [switch]$NoProxy, [int]$MaxAttempts = $script:Cfg.MaxAttempts, [int]$NodeDeadlineSec = -1, [int]$DeadlineSec = 0)
    try { $capEnv = [int]$env:MCPS_RESEARCH_HARD_CAP; if ($capEnv -gt 0 -and ($TimeoutSec -le 0 -or $TimeoutSec -gt $capEnv)) { $TimeoutSec = $capEnv } } catch { }   # v1.42.0 甲：请求层上限（Stop 停不住同步 HTTP；研究路径经 env 传入、finally 清除）；-DeadlineSec 见 Get-ApiWallBudget 头注
    $attempt = 0; $maxAttempts = $MaxAttempts   # v1.36.4：MaxAttempts 可按调用点覆盖（慢源传 Cfg.SlowSourceMaxAttempts=1，避免 5s 超时被 3 次重试放大）
    $dlStart = if ($DeadlineSec -gt 0) { [DateTime]::UtcNow } else { $null }; $bud = Get-ApiWallBudget -Start $dlStart -DeadlineSec $DeadlineSec -TimeoutSec $TimeoutSec
    $traceUri = Get-TraceUri $Uri
    $lastHttpCode = $null; $nodeFail = $null   # v1.23.0：lastHttpCode 在重试耗尽时附带到异常消息，供引擎判别 rate_limited
    # v1.51.0：死主机零等待跳过（同进程已登记确定性失败的主机不再探活/请求；细节见 Test-DeterministicTransportFailure 头注）
    $reqHost = ''; try { $reqHost = [string]([uri]$Uri).Host } catch { }
    $deadWhy = Get-DeadNetworkHost -HostName $reqHost; if ($deadWhy) { throw ("network-unavailable: {0}（确定性失败已登记：{1}；本轮零等待跳过）" -f $reqHost, $deadWhy) }
    $routeCtx = Get-ApiRequestRouteContext -Uri $Uri -NoProxy:$NoProxy -BudgetMs $bud.RemainingMs   # U-156/U-155：逐域 route、network-unavailable、HTTP 已见字典（原 L1391–1405）
    $proxyMode = $routeCtx.ProxyMode
    $viaProxy = $routeCtx.NetworkRoute.Kind -in @('http', 'socks'); if ($viaProxy) { $brk = Get-ProxyBreakerState -HostName $reqHost; if ($brk.Reason) { throw $brk.Reason } }
    $NoProxy = $routeCtx.Direct # 仍经 U-40 Invoke-WebRequestDirect，PS5/7 两运行时真直连
    # v1.51.0：路由未证实 ⇒ 单次请求超时封顶（8s ≥ U-206 的 socks 冷启动 6s；MCPS_UNPROVEN_ROUTE_SEC=0 关闭）
    $ub = Resolve-UnprovenRouteBudget -Route $routeCtx.NetworkRoute -TimeoutSec $TimeoutSec -MaxAttempts $maxAttempts; $TimeoutSec = $ub.TimeoutSec; $maxAttempts = $ub.MaxAttempts
    while ($attempt -lt $maxAttempts) {
        $attempt++
        $bud = Get-ApiWallBudget -Start $dlStart -DeadlineSec $DeadlineSec -TimeoutSec $TimeoutSec; if ($bud.Exhausted) { throw "探测预算耗尽: $traceUri (${DeadlineSec}s 内未完成)" }
        Write-TlsTrace ("attempt {0}/{1} {2} {3}" -f $attempt, $maxAttempts, $Method, $traceUri)
        $reqSw = [System.Diagnostics.Stopwatch]::StartNew(); Add-ApiRequestStat -Kind 'attempt' -Attempt $attempt -Sw $reqSw   # U-256：记在"预算已放行、即将发送"这一步（早退不算）；U-261：账本行同时开（顺序不能反——反了拿到的是上一次的秒表）
        if ($proxyMode) {
            try {
                $sx = Invoke-ApiSocksOnce -Uri $Uri -Headers $Headers -TimeoutSec $bud.TimeoutSec -Method $Method -Body $Body -proxyUrl $routeCtx.ProxyUrl -reqSw $reqSw
                $code = $sx.Code
                if ($null -ne $code -and $code -ge 200 -and $code -lt 300) {
                    $null = Resolve-ProxyGatewayOutcome -HostName $reqHost -ViaProxy:$viaProxy -Code $code
                    Add-ApiRequestStat -Kind 'ok' -Status $code; return [PSCustomObject]@{ Content = $sx.Content; StatusCode = $code; Headers = @{} }   # U-256：socks 路径 2xx；U-261：结账本行并记状态码
                }
                if ($null -ne $code) {
                    $lastHttpCode = $code; Set-ApiLedgerStatus -Status $code   # U-261：socks 非 2xx 不经过 Resolve-ApiHttpFailure，状态码只能在这里盖
                    # v1.51.0：代理侧 5xx 先判确定性（CONNECT 502 重试同一代理没意义）
                    $detP = Test-DeterministicTransportFailure -Text ([string]$sx.ErrorText) -ProxyActive ([bool]$proxyMode); if ($detP -eq 'proxy-tunnel') { Set-DeadNetworkHost -HostName $reqHost -Reason $detP; throw ("deterministic-fail: {0} ({1}) {2}" -f $detP, $reqHost, $traceUri) }
                    if ($code -eq 429 -or $code -ge 500) {
                        $trip = Resolve-ProxyGatewayOutcome -HostName $reqHost -ViaProxy:$viaProxy -Code $code; if ($trip) { throw $trip }
                        $bo = Get-RetryBackoff -Attempt $attempt -MaxAttempts $maxAttempts
                        if (-not $bo.HasNext) { break }   # N-25/U-83：最后一次尝试不退避
                        Write-ColorOutput "  (代理 HTTP $code) 退避 $($bo.WaitSec)s 后重试 ($attempt/$maxAttempts)" "Yellow"
                        Start-Sleep -Seconds $bo.WaitSec
                        continue
                    }
                    throw "代理请求失败: $traceUri (HTTP $code)"
                }
                throw ("代理请求失败: {0} (curl 无状态码输出; {1})" -f $traceUri, (Get-CurlFailureHint -ExitCode $sx.ExitCode -ErrorText $sx.ErrorText))
            } catch {
                $reqSw.Stop()
                $lastHttpCode = $null
                # v1.51.0：socks/代理分支同款快速失败（原裸 throw；确定性传输失败不值得重试）
                $detFail = Test-DeterministicTransportFailure -Text (Get-TransportFailureText -ErrorRecord $_) -ProxyActive ([bool]$proxyMode); if ($detFail -eq 'proxy-tunnel') { Set-DeadNetworkHost -HostName $reqHost -Reason $detFail; throw ("deterministic-fail: {0} ({1}) {2}" -f $detFail, $reqHost, $traceUri) }
                throw
            }
        }
        try {
            $webRes = Invoke-ApiWebOnce -Uri $Uri -Headers $Headers -TimeoutSec $bud.TimeoutSec -Method $Method -Body $Body -networkRoute $routeCtx.NetworkRoute -NoProxy:$NoProxy -reqSw $reqSw
            $null = Resolve-ProxyGatewayOutcome -HostName $reqHost -ViaProxy:$viaProxy -Code 200
            Add-ApiRequestStat -Kind 'ok' -Status $webRes.StatusCode; return $webRes   # U-256：直连/HTTP 代理拿到响应（非 2xx 由 Invoke-WebRequest 抛）；U-261：结账本行
        }
        catch [System.Exception] {
            $reqSw.Stop()
            # v1.51.0：确定性传输失败在 catch 最前判（不依赖 Resolve-ApiHttpFailure 的类型识别；详见分类器头注）
            $detFail = Test-DeterministicTransportFailure -Text (Get-TransportFailureText -ErrorRecord $_) -ProxyActive ([bool]$proxyMode); if ($detFail -eq 'proxy-tunnel') { Set-DeadNetworkHost -HostName $reqHost -Reason $detFail; throw ("deterministic-fail: {0} ({1}) {2}" -f $detFail, $reqHost, $traceUri) }
            $fail = Resolve-ApiHttpFailure -ErrorRecord $_ -reqSw $reqSw -Uri $Uri
            $isHttpFailure = $fail.IsHttpFailure
            if (-not $isHttpFailure) { throw }
            $resp = $fail.Response
            if ($resp) { $lastHttpCode = [int]$resp.StatusCode }
            if ($resp) { $trip = Resolve-ProxyGatewayOutcome -HostName $reqHost -ViaProxy:$viaProxy -Code ([int]$resp.StatusCode); if ($trip) { throw $trip } }
            if (-not $resp) {
                if (Test-UnprovenRouteTimeout -Capped ([bool]$ub.Capped) -ElapsedSec $reqSw.Elapsed.TotalSeconds -TimeoutSec $TimeoutSec) { throw ("unproven-route-timeout: {0}（路由未证实且已用满 {1}s 超时；不再换栈重走同一条路）" -f $traceUri, [int]$reqSw.Elapsed.TotalSeconds) }
                Add-ApiRequestStat -Kind 'attempt' -Attempt $attempt -Sw ([System.Diagnostics.Stopwatch]::StartNew()); $fb = Invoke-ApiNodeFallback -Uri $Uri -Headers $Headers -Method $Method -Body $Body -NodeDeadlineSec $NodeDeadlineSec -TraceUri $traceUri -Attempt $attempt -MaxAttempts $maxAttempts
                if ($fb.Log) { Write-ColorOutput $fb.Log "DarkGray" }
                if ($fb.Action -eq 'ok') { Add-ApiRequestStat -Kind 'ok' -Status $fb.Result.StatusCode; return $fb.Result }
                if ($fb.Action -eq 'retry') { continue }
                if ($fb.Action -eq 'stop') { break }
                if ($fb.Action -eq 'throw') { throw $fb.Message }
                if ($null -ne $fb.LastCode) { $lastHttpCode = $fb.LastCode }
            }
            $isRetryable = $resp -and ($resp.StatusCode -eq 429 -or [int]$resp.StatusCode -ge 500 -or ($resp.StatusCode -eq 403 -and (Test-RateLimit403 -Resp $resp))); if ($isRetryable -and [int]$resp.StatusCode -in @(403, 429)) { $lastRl = $true }   # U-177：把"这是限流"带到边界之外
            if ($isRetryable) {
                Update-ApiRetryCounters -resp $resp   # v1.36.3：AppDomain 共享计数（mcps_ratelimited / mcps_retries）
                $bo = Get-RetryBackoff -Attempt $attempt -MaxAttempts $maxAttempts -RetryAfterHeader $resp.Headers["Retry-After"]
                if ($bo.TooLong) {
                    Write-ColorOutput "  (HTTP $($resp.StatusCode)) Retry-After $($bo.WaitSec)s 超过上限 $($script:Cfg.MaxRetryWaitSec)s，快速失败($Uri)" "Yellow"
                    throw "限流等待过长: $Uri (Retry-After $($bo.WaitSec)s)"
                }
                if (-not $bo.HasNext) { break }   # N-25/U-83：最后一次尝试不退避
                $budgetExhausted = Test-ApiRetryBudget
                if ($budgetExhausted) {
                    Write-ColorOutput "  (HTTP $($resp.StatusCode)) 重试预算已耗尽($Uri)，放弃本次请求" "Yellow"
                    throw "重试预算耗尽: $Uri"
                }
                Write-ColorOutput "  (HTTP $($resp.StatusCode)) 退避 $($bo.WaitSec)s 后重试 ($attempt/$maxAttempts)" "Yellow"
                Start-Sleep -Seconds $bo.WaitSec
                continue
            }
            throw
        }
    }
    if ($lastRl) { throw "重试次数耗尽: $Uri (last HTTP $lastHttpCode, rate-limit)" }; throw "重试次数耗尽: $Uri (last HTTP $lastHttpCode)"   # U-177：限流单独抛，其余保持原文（D4 钉原串）
}
# 4.2 令牌桶限速器：对“严格限流”主机做进程内全局限速（防突发 429）。
# 未认证 GitHub Search = 10 req/min（≈1/6s）；认证 = 30 req/min（≈1/2s）。
# 仅在被显式 Wait-RateLimitToken -Bucket 调用时生效；未注册桶直接放行，不阻塞。
# v1.36.3：_rlBuckets/_rlLock 已进 _injectVars，Runspace 内与宿主共享同一桶（此前 Runspace 内无桶 ⇒ 静默放行）。
function Wait-RateLimitToken {
    # U-160 L4：-DryRun 只**返回判定**（不睡、不改状态），供 test-u160c 做确定性验证；默认关闭 ⇒ 生产路径**零变化**。
    #   ★不新增函数是有意的：本函数经每引擎 Needs 注入 Runspace，新增被调函数会再扩注入面
    #   （v1.36.3 就吃过「_rlBuckets 未注入 ⇒ Runspace 内 $null 早退」的坑）。
    param([string]$Bucket, [switch]$DryRun)
    $b = $null
    try { $b = $script:_rlBuckets[$Bucket] } catch { }
    if (-not $b) { return }
    [System.Threading.Monitor]::Enter($script:_rlLock)
    try {
        $now = [datetime]::UtcNow
        if ($b.Last -eq $null) { $b.Last = $now }
        $elapsed = ($now - $b.Last).TotalSeconds
        $b.Tokens = [math]::Min($b.Capacity, $b.Tokens + $elapsed * $b.RefillPerSec)
        if ($DryRun) {
            # 只算再返回；**不动 b.Tokens / b.Last**（无副作用、可重复调用）
            $allow = ($b.Tokens -ge 1.0)
            $w = if ($allow) { 0.0 } else { (1.0 - $b.Tokens) / $b.RefillPerSec }
            return [PSCustomObject]@{ Bucket = $Bucket; Allow = $allow; WaitSec = [math]::Round([double]$w, 3); Tokens = [math]::Round([double]$b.Tokens, 3); RefillPerSec = $b.RefillPerSec }
        }
        if ($b.Tokens -ge 1.0) {
            $b.Tokens -= 1.0
            $b.Last = $now
        } else {
            $waitSec = (1.0 - $b.Tokens) / $b.RefillPerSec
            if ($waitSec -gt 0) { Start-Sleep -Milliseconds ([math]::Ceiling($waitSec * 1000)) }
            $b.Tokens = 0.0
            $b.Last = [datetime]::UtcNow
        }
    }
    finally { [System.Threading.Monitor]::Exit($script:_rlLock) }
}
# 4.2 陈旧缓存读取（stale-while-revalidate）：忽略 TTL 直接返回磁盘缓存条目，
# 供实时检索被限流/失败时兜底返回近 TTL 结果，而非空结果。
function Get-StaleCacheResult {
    # U-203（2026-10-21，实网验证时发现）：**返回的是缓存条目包装体，不是结果数组**。
    #   磁盘条目形如 `{expires, data:[...]}`，旧写法直接 `return $disk[$Key]` ⇒ 调用方（Get-GitHubStaleFallback）
    #   拿到 1 个只有 expires/data 两个属性的对象，下游 `Where-Object { $_.PSObject.Properties.Name -contains 'Name' }`
    #   把它扔掉 ⇒ **载荷 0 条，却写着 "已回退陈旧缓存" + 引擎状态 ok ⇒ coverage.Verdict=full**。
    #   这是"不是零命中却报成零命中"的假阴性（一次误命中还会把这个包装体再写进缓存，逐次套娃：实测已 3 层）。
    #   ⇒ 正确做法：拆到 data；对历史套娃按"里面还有 data 且没有 Name"下钻（≤8 层）；只返回**带 Name 的结果**。
    param([string]$Key)
    if (-not $Key) { return $null }
    try {
        $disk = Get-Cache
        if (-not ($disk -and $disk.ContainsKey($Key))) { return $null }
        $data = $disk[$Key]
        for ($i = 0; $i -lt 8; $i++) {
            if ($null -eq $data) { break }
            if ($data -is [System.Array]) { break }
            $props = @($data.PSObject.Properties.Name)
            if ($props -contains 'Name') { break }
            if ($props -contains 'data') { $data = $data.data; continue }
            break
        }
        # 没有 Name 的对象不是结果（可能是状态字符串/包装体）⇒ 一律不当作陈旧结果返回
        $arr = @($data | Where-Object { $_ -and ($_.PSObject.Properties.Name -contains 'Name') })
        if ($arr.Count -eq 0) { return $null }
        return $arr
    } catch { }
    return $null
}
# ---------- P-b（v1.18.0）：arXiv 引用数补全（P2 收口）——Semantic Scholar batch API ----------
# 用 arXiv ID 关联 S2 论文（ARXIV:<id>），batch POST 一次查引用数，回填 Stars（替换 0）与 Desc。
# 匿名配额 100 req/5min，batch 算 1 次，Limit 量级足够；失败/未命中时保持 Stars=0 不阻断（幂等容错）。
function Enrich-ArxivCitations {
    param($Results)
    $arxiv = @($Results | Where-Object { $_.PSObject.Properties.Name -contains 'Platform' -and $_.Platform -eq 'arXiv' })
    if ($arxiv.Count -eq 0) { Write-Output -NoEnumerate $Results; return }
    $ids = @()
    foreach ($r in $arxiv) {
        $id = ''
        # 真实 arXiv entry.id 带版本后缀（如 /abs/2201.00978v1），S2 不识别带版本 ID → 剥掉 v\d+ 版本号
        if ([string]$r.Url -match 'arxiv\.org/abs/(?<id>[A-Za-z0-9.]+)') {
            $id = ($Matches['id'] -replace 'v\d+$', '')
            $id = "ARXIV:$id"
        }
        if ($id) { $ids += $id }
    }
    if ($ids.Count -eq 0) { Write-Output -NoEnumerate $Results; return }
    try {
        $body = @{ ids = $ids } | ConvertTo-Json -Depth 3 -Compress
        $ua = @{"User-Agent" = "multi-code-platform-searcher/$VERSION"}
        # v1.36.6（回迁 B v1.34.2）：配置 S2_API_KEY 时走认证配额（请求头 X-API-KEY）；未配置保持匿名。key 只进请求头，不写日志
        $s2Key = [Environment]::GetEnvironmentVariable('S2_API_KEY')
        if (-not [string]::IsNullOrWhiteSpace($s2Key)) { $ua['X-API-KEY'] = $s2Key.Trim() }
        # U-243：引用数只是增强 ⇒ 6s 单次（见 Cfg.ArxivEnrichTimeoutSec）。失败时下方已有 catch，结果原样保留。
        $resp = Invoke-ApiRequest -Uri "https://api.semanticscholar.org/graph/v1/paper/batch?fields=citationCount" -Headers $ua -TimeoutSec $script:Cfg.ArxivEnrichTimeoutSec -MaxAttempts 1 -Method POST -Body $body
        $data = $resp.Content | ConvertFrom-Json
        $idx = 0
        foreach ($r in $arxiv) {
            if ($idx -lt @($data).Count -and $data[$idx] -and $null -ne $data[$idx].citationCount) {
                $c = [int]$data[$idx].citationCount
                try { $r | Add-Member -NotePropertyName Stars -NotePropertyValue $c -Force } catch { }
                try { $r | Add-Member -NotePropertyName Desc -NotePropertyValue ("cited: $c; " + $r.Desc) -Force } catch { }
            }
            $idx++
        }
        Write-ColorOutput "arXiv 引用数补全成功（$(@($data | Where-Object { $_ -and $null -ne $_.citationCount }).Count)/$($ids.Count)，$(if ($ua.ContainsKey('X-API-KEY')) { 'S2 认证' } else { 'S2 匿名' })）" "Green"
    }
    catch { Write-ColorOutput "arXiv 引用数补全失败(可忽略，Stars 保持 0): $_" "DarkYellow" }
    Write-Output -NoEnumerate $Results
}
# ---------- 下载 ----------
function Get-PlatformToken {
    param([string]$Platform)
    switch ($Platform) {
        'Gitee'  { return $env:GITEE_TOKEN }
        'GitLab' { return $env:GITLAB_TOKEN }
        default  { return $env:GITHUB_TOKEN }
    }
}
