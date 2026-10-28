# ==============================================================================
# lib/net.ps1 -- Multi-Code-Platform Searcher | B3-2 模块拆分（v1.54.0）
#
# 网络选路：逐域探活、代理/NO_PROXY、hosts 劫持识别、未证实路由封顶、代理网关熔断。
#   本模块只回答「这个 URL 该走哪条路」，不实现传输。
#
# 契约：本文件只定义（函数 / $script: 数据），无顶层副作用；由主脚本按固定顺序点源加载。
#   · 作用域：点源进主脚本作用域，故 $script: 指向主脚本；版本号/参数等由主脚本提供。
#   · 不要在这里 exit、不要写 stdout：进度与产物分别走 Write-ColorOutput / Write-PayloadOutput。
#   · 新增函数放对应模块；跨模块调用无需前置声明（全部在运行前定义完毕）。
# ==============================================================================

# U-156/U-155：不再因为代理指向 localhost 就删除环境变量（活代理可能也在本机）。
# 参数是原请求 URI；首次请求某域时 HEAD 2.5s，只有传输失败再轻量 GET 2.5s（只读响应头/1-byte Range）。
# 4xx/5xx/405 都证明链路可达；TLS/超时等无法证实不可达的情形允许真实请求继续执行，绝不报假 skip。
function Initialize-Network {
    if ($NoProxyFix) { return } # 保留旧开关；现在不再执行任何进程级代理改写
    if (-not $AsJson) { Write-ColorOutput "  [网络] 按实际目标 URL 逐域选择代理/直连；不清理本地代理变量" "Gray" }
}
function Test-NetworkNoProxy {
    # U-244（2026-10-25）：`-Spec` 只为 Doctor 覆盖矩阵与门注入（默认仍读进程环境，生产路径逐字不变）。
    #   ★传空串 = 「明确没有 NO_PROXY」，不再回落读环境 —— 否则门无法构造"未命中"的负例。
    #   ★★**必须用 $PSBoundParameters 判"传没传"，不能用 `$null -ne $Spec`**：
    #     PowerShell 对 `[string]` 形参的默认值 `$null` 会落成**空串**（实测：未传参时 $Spec -eq ''），
    #     于是"没传"和"传了空串"在值上不可区分 ⇒ 若按值判，生产路径（不传 -Spec）会走进"明确没有 NO_PROXY"，
    #     把用户的 NO_PROXY **整体忽略**。这个回归曾被 U-155/U-156 老门当场抓住（`U-156 NO_PROXY ignored`），
    #     时间 2026-10-25，B1-3 之后第一轮全量。教训：改参数默认值的语义，必须跑"不传参"的既有门。
    param([uri]$Target, [AllowNull()][AllowEmptyString()][string]$Spec)
    $hasSpec = $PSBoundParameters.ContainsKey('Spec')
    $raw = if ($hasSpec) { [string]$Spec } else { [Environment]::GetEnvironmentVariable('NO_PROXY', 'Process') }
    if (-not $raw -and -not $hasSpec) { $raw = [Environment]::GetEnvironmentVariable('no_proxy', 'Process') }
    if (-not $raw) { return $false }
    $hostName = $Target.Host.ToLowerInvariant()
    foreach ($part in ($raw -split ',')) {
        $entry = $part.Trim().ToLowerInvariant()
        if ($entry -eq '*') { return $true }
        $bare = $entry.TrimStart('.')
        if (-not $bare) { continue }
        if ($bare -eq "$($hostName):$($Target.Port)") { return $true }
        if ($bare.Contains(':')) { continue } # host:port 仅精确匹配，绝不把端口当子域名
        if ($hostName -eq $bare -or $hostName.EndsWith(".$bare")) { return $true }
    }
    return $false
}
# U-207（2026-10-21）：MCPS_PROXY 的**白名单判定单源**。
#   旧写法把「解析 spec / 判白名单 / 决定是否加入候选」三件事挤在 Get-NetworkCandidates 里，
#   于是「被白名单排除」这个事实在函数外完全不可见 —— 实网里 gitlab.com 不在白名单，
#   socks5://127.0.0.1:7897 是**唯一**可用路由却从未被尝试，进程转而去试已死的宿主代理，
#   最终报「单引擎超 10s 截止」。此处把判定抽出来，供选路、告警、`MCPS_PROXY_FALLBACK` 共用。
function Get-McpsProxySpec {
    # U-207：`-ProxySpec` 只为 Doctor 建议的注入测试（它原本自带 -ProxySpec 参数）；默认读环境。
    param([string]$HostName, [string]$ProxySpec = $env:MCPS_PROXY)
    $raw = [string]$ProxySpec
    if (-not $raw -or $raw -notmatch '^socks5h?://') { return $null }
    $url = ($raw -split ';')[0].Trim()
    $hosts = @()
    $hasWhitelist = $raw.Contains(';')
    if ($hasWhitelist -and $raw -match ';(.*)') { $hosts = @($matches[1] -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ }) }
    $matched = @($hosts | Where-Object { $HostName -eq $_ -or $HostName -like "*.$_" }).Count -gt 0
    return [PSCustomObject]@{
        Url = $url; Whitelist = @($hosts); HasWhitelist = [bool]$hasWhitelist
        Allowed = ((-not $hasWhitelist) -or $matched)
    }
}
function Get-NetworkCandidates {
    param([uri]$Target, [switch]$ForceDirect)
    $direct = [PSCustomObject]@{ Kind = 'direct'; ProxyUrl = ''; Source = 'direct' }
    if ($ForceDirect -or $Target.IsLoopback -or $script:ProxyMode -eq 'direct' -or
        ($script:ProxyMode -eq 'auto' -and (Test-NetworkNoProxy -Target $Target))) { return $direct }
    $candidates = @(); $specs = @()
    $explicit = $script:ProxyMode -like 'proxy:*'
    if ($explicit) {
        $specs += [PSCustomObject]@{ Url = $script:ProxyMode.Substring(6); Source = 'explicit' }
    } else {
        # MCPS_PROXY 的域名白名单必须作用于真实路由，不能只在 Doctor 判断里做字符串展示。
        $ms = Get-McpsProxySpec -HostName ([string]$Target.Host)
        if ($ms) {
            if ($ms.Allowed) { $specs += [PSCustomObject]@{ Url = $ms.Url; Source = 'MCPS_PROXY' } }
            elseif ($env:MCPS_PROXY_FALLBACK -eq '1') {
                # U-207：显式开启 ⇒ 白名单只用于「优先」，不再排除；放在**最前**，否则前面几个死路由
                #   会先把引擎的截止预算耗光（实测 http 代理 5s + direct 5s > 引擎 10s 截止）。
                $specs += [PSCustomObject]@{ Url = $ms.Url; Source = 'MCPS_PROXY(fallback)' }
            }
        }
        $names = if ($Target.Scheme -eq 'https') { @('HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy') } else { @('HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy') }
        foreach ($name in $names) {
            $raw = [Environment]::GetEnvironmentVariable($name, 'Process')
            if ($raw) { $specs += [PSCustomObject]@{ Url = $raw; Source = $name } }
        }
        if ($script:_sysProxyMode -ne 'bypass') {
            try {
                $systemProxy = [System.Net.WebRequest]::GetSystemWebProxy()
                if ($systemProxy -and -not $systemProxy.IsBypassed($Target)) {
                    $systemUrl = $systemProxy.GetProxy($Target)
                    if ($systemUrl -and $systemUrl.AbsoluteUri -ne $Target.AbsoluteUri) { $specs += [PSCustomObject]@{ Url = $systemUrl.AbsoluteUri; Source = 'system' } }
                }
            } catch { } # 读不到系统代理不妨碍尝试 direct
        }
    }
    $seen = @{}
    foreach ($s in $specs) {
        $proxyUri = $null
        $valid = [uri]::TryCreate([string]$s.Url, [System.UriKind]::Absolute, [ref]$proxyUri)
        if (-not $valid -or -not $proxyUri.Host -or $proxyUri.Scheme -notin @('http', 'https', 'socks5', 'socks5h')) {
            if ($explicit) { throw 'ProxyMode 代理 URL 无效（地址不回显）' }
            continue
        }
        $unique = $proxyUri.AbsoluteUri.TrimEnd('/')
        if ($seen.ContainsKey($unique)) { continue }
        $seen[$unique] = $true
        $kind = if ($proxyUri.Scheme -in @('socks5', 'socks5h')) { 'socks' } else { 'http' }
        $candidates += [PSCustomObject]@{ Kind = $kind; ProxyUrl = $proxyUri.AbsoluteUri; Source = $s.Source }
    }
    if (-not $explicit) { $candidates += $direct }
    return $candidates
}
function Invoke-NetworkProbeOnce {
    # P1（2026-10-19）：-TimeoutMs 让调用方把**总预算**分给逐域探活（0 = 沿用 Cfg.NetworkProbeTimeoutMs，旧行为）。
    param([uri]$Target, $Route, [ValidateSet('HEAD','GET')][string]$Method, [int]$TimeoutMs = 0)
    $probeMs = if ($TimeoutMs -gt 0) { $TimeoutMs } else { [int]$script:Cfg.NetworkProbeTimeoutMs }
    if ($Route.Kind -eq 'socks') {
        # PS5.1 IWR 不支持 SOCKS5。curl -I / GET Range；任何 HTTP 响应（含 4xx/5xx）均可达。
        $curl = Get-Command -Name @('curl.exe', 'curl') -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $curl) { return 'unknown' } # 缺工具不等于目标域名不可达
        $sink = if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) { 'NUL' } else { '/dev/null' }
        $curlArgs = @('-s', '-o', $sink, '-w', '%{http_code}', '--max-time', (([double]$probeMs / 1000).ToString('0.0', [Globalization.CultureInfo]::InvariantCulture)), '--socks5-hostname', ($Route.ProxyUrl -replace '^socks5h?://', ''))
        if ($Method -eq 'HEAD') { $curlArgs += '-I' } else { $curlArgs += '-r', '0-0' }
        try {
            $code = (& $curl.Source @curlArgs $Target.AbsoluteUri 2>$null | Select-Object -Last 1)
            if ($LASTEXITCODE -eq 0 -and $code -match '^[1-5][0-9]{2}$') { return 'reachable' }
            if ($LASTEXITCODE -in @(5, 6, 7)) { return 'unreachable' } # 代理/目标 DNS 或连接被拒
        } catch { }
        return 'unknown'
    }
    try {
        $request = [System.Net.WebRequest]::Create($Target)
        $request.Method = $Method; $request.Timeout = $probeMs; $request.ReadWriteTimeout = $probeMs
        if ($Route.Kind -eq 'direct') { $request.Proxy = $null }
        elseif ($Route.Source -eq 'system') { $request.Proxy = [System.Net.WebRequest]::GetSystemWebProxy() }
        else { $request.Proxy = [System.Net.WebProxy]::new([uri]$Route.ProxyUrl) }
        if ($Method -eq 'GET' -and $request -is [System.Net.HttpWebRequest]) { $request.AddRange(0, 0) }
        # v1.53.0（U-222）：异步 + WaitOne **硬封顶**整个探活（含 DNS / 代理 CONNECT）——
        #   同步 GetResponse 的 Timeout 不覆盖那两段（故障排查.md 已记录：单次探活可白等远超 TimeoutMs，
        #   SE 的 network-unavailable 白等 19.4s 即此）。到点 Abort，返回 unknown（超时 ≠ 不可达，绝不报假 skip）。
        $ar = $request.BeginGetResponse($null, $null)
        if (-not $ar.AsyncWaitHandle.WaitOne($probeMs)) {
            try { $request.Abort() } catch { }
            return 'unknown'
        }
        $response = $request.EndGetResponse($ar) # 只读响应头，不读取 GET body
        if ($response) { $response.Close() }
        return 'reachable'
    } catch [System.Net.WebException] {
        if ($_.Exception.Response) { try { $_.Exception.Response.Close() } catch { }; return 'reachable' }
        if ($_.Exception.Status -in @([System.Net.WebExceptionStatus]::NameResolutionFailure, [System.Net.WebExceptionStatus]::ProxyNameResolutionFailure, [System.Net.WebExceptionStatus]::ConnectFailure)) { return 'unreachable' }
        # v1.53.0（U-222）：PS 7 把「连接被拒」映射成 Status=UnknownError（PS 5.1 是 ConnectFailure）——
        #   只看枚举会把确定性拒接降级成 unknown ⇒ 路由永判 unproven ⇒ 请求照发、白等满超时才认输
        #   （实测：同一拒接 PS7=unknown / PS5.1=unreachable，PS7 的 unavailable-skip 从未触发过）。
        #   按消息文本补判（与 Invoke-ApiRequest 的 Test-DeterministicTransportFailure 同判据）：
        #   拒接/解析失败/代理隧道失败 ⇒ unreachable；超时/TLS 文本不匹配 ⇒ 仍回 unknown。
        if (Test-DeterministicTransportFailure -Text ([string]$_.Exception.Message + ' ' + [string]$_)) { return 'unreachable' }
        return 'unknown' # 超时、TLS/CA、传输半闭等需由真实请求/既有 node TLS 兜底裁决
    } catch { return 'unknown' }
}
function Get-NetworkRoute {
    # P1（2026-10-19）：-BudgetMs = 本次请求**分给逐域探活的**总预算（0 = 不限，旧行为）。
    #   病灶：每个候选路由 HEAD 2.5s 失败后还要 GET 2.5s，候选有 2–3 个 ⇒ 单域探活最坏 ~15s，
    #   而 Doctor 探针的 -TimeoutSec 只约束主请求，管不到这一段 —— Sourcegraph 探测实测 27–30s 即此。
    #   ★预算截断时**不写路由缓存**：缓存是跨请求共享的，写进一个没验证完的结论会污染后续真实检索。
    param([string]$Uri, [switch]$NoProxy, [int]$BudgetMs = 0)
    $target = [uri]$Uri
    if (-not $target.IsAbsoluteUri -or $target.Scheme -notin @('http','https')) { throw '请求 URL 必须是绝对 HTTP(S) 地址' }
    if ($target.IsLoopback) { return [PSCustomObject]@{ Kind = 'direct'; ProxyUrl = ''; Source = 'loopback' } }
    $mode = if ($NoProxy) { 'direct' } elseif ($script:ProxyMode) { $script:ProxyMode } else { 'auto' }
    # U-206：调用方没给预算时用 Cfg 的默认总预算（0 = 旧行为：每候选各 2×NetworkProbeTimeoutMs）。
    if ($BudgetMs -le 0) { try { $BudgetMs = [int]$script:Cfg.NetworkRouteBudgetMs } catch { $BudgetMs = 0 } }
    $key = "$mode|$($target.Scheme)|$($target.Authority)"
    $route = $null
    if ($script:_networkRoutes -and $script:_networkRoutes.TryGetValue($key, [ref]$route)) { return $route }
    $probeSw = if ($BudgetMs -gt 0) { [System.Diagnostics.Stopwatch]::StartNew() } else { $null }
    $truncated = $false
    $unknown = $null
    $trace = @()
    # U-207：被白名单排除的 MCPS_PROXY 必须留下证据（否则「唯一可用路由从未被尝试」不可见）。
    $excluded = $null
    if ($script:ProxyMode -notlike 'proxy:*' -and -not $NoProxy) {
        $ms = Get-McpsProxySpec -HostName ([string]$target.Host)
        if ($ms -and -not $ms.Allowed) { $excluded = $ms }
    }
    foreach ($candidate in @(Get-NetworkCandidates -Target $target -ForceDirect:$NoProxy)) {
        $headMs = 0
        if ($probeSw) {
            $remainMs = $BudgetMs - [int]$probeSw.ElapsedMilliseconds
            if ($remainMs -lt 250) { $truncated = $true; break }
            $headMs = [Math]::Min([int]$script:Cfg.NetworkProbeTimeoutMs, $remainMs)
        }
        $head = Invoke-NetworkProbeOnce -Target $target -Route $candidate -Method HEAD -TimeoutMs $headMs
        if ($head -eq 'reachable') { $candidate | Add-Member -NotePropertyName ProbeState -NotePropertyValue reachable -Force; $trace += ('{0}→reachable' -f $candidate.Source); $route = $candidate; break }
        # HEAD 只有传输失败才做 GET；GET 只读头/Range，避免大响应体与测试数据污染。
        $getMs = 0
        if ($probeSw) {
            $remainMs = $BudgetMs - [int]$probeSw.ElapsedMilliseconds
            if ($remainMs -lt 250) { $truncated = $true; break }
            $getMs = [Math]::Min([int]$script:Cfg.NetworkProbeTimeoutMs, $remainMs)
        }
        $get = Invoke-NetworkProbeOnce -Target $target -Route $candidate -Method GET -TimeoutMs $getMs
        # v1.53.0（U-222）：verdict 合成按**证据强度**排序：可达 > 确定性失败 > 未知。
        #   旧写法把 GET 超时(unknown) 排在 HEAD 拒接(unreachable) 之前 ⇒ 一次探活超时就把**已证实的拒接**
        #   降级成 unknown ⇒ 路由判 unproven ⇒ 请求照发、白等满超时（SE network-unavailable 白等的第二来源）。
        #   绝不报假 skip 的底线不变：只有确定性失败（拒接/解析失败）才判死；全程只有超时 ⇒ 仍 unknown。
        $verdict = if ($head -eq 'reachable' -or $get -eq 'reachable') { 'reachable' } elseif ($head -eq 'unreachable' -or $get -eq 'unreachable') { 'unreachable' } else { 'unknown' }
        $trace += ('{0}→{1}' -f $candidate.Source, $verdict)
        if ($get -eq 'reachable') { $candidate | Add-Member -NotePropertyName ProbeState -NotePropertyValue reachable -Force; $route = $candidate; break }
        # v1.53.0（U-222）：$unknown 只收 verdict 真为 unknown 的候选 —— 旧谓词只看 head/get 各自是否
        #   'unknown'，与上面的合成 verdict 脱钩 ⇒ HEAD 已证实拒接、GET 超时的候选**同时**被记进
        #   $unknown，末尾 `if ($unknown)` 又把它兜回成 unproven 路由 ⇒ 请求照发（白等的第二来源）。
        if ($verdict -eq 'unknown' -and -not $unknown) { $unknown = $candidate }
    }
    if (-not $route) { $route = if ($unknown) { $unknown } else { [PSCustomObject]@{ Kind = 'unavailable'; ProxyUrl = ''; Source = 'all-routes-failed' } } }
    if ($script:_routeTrace) {
        try { $script:_routeTrace[$target.Authority] = [PSCustomObject]@{ Trace = @($trace); ExcludedProxy = $(if ($excluded) { $excluded.Url } else { '' }); Whitelist = $(if ($excluded) { @($excluded.Whitelist) } else { @() }); Route = [string]$route.Source } } catch { }
    }
    if ($script:_networkRoutes -and -not $truncated) { $script:_networkRoutes[$key] = $route }
    return $route
}
# U-206/U-207：把「为什么这条请求注定失败」写成**可执行**的一句话（附在 network-unavailable / 未确认告警后）。
#   取舍：只读已采集的证据（hosts 行、选路 trace、白名单），不额外发请求 —— 失败路径上不能再加延迟。
function Get-NetworkRouteHint {
    # -HostsOverride 是**测试缝**（同令牌桶 -DryRun 的做法；★不写函数名：U-41 的闭包扫描连注释里的 `Xxx-Yyy` 都算调用）：默认自己去读真实 hosts，
    #   门里传一个假对象即可验证「对象形状用对了」而不必依赖跑测试的机器 hosts 内容。
    param([string]$Uri, $HostsOverride = $null)
    try {
        $target = [uri]$Uri
        $hints = @()
        # ★Get-HostsOverride 返回 PSCustomObject（Host/Ip/Line/File/Loopback），不是字符串行 ——
        #   曾按字符串 `-match '^(\S+)\s'` 取 IP，结果匹配到 `@{Host=…}` ⇒ 永远判不出劫持（本门抓出）。
        $ov = if ($PSBoundParameters.ContainsKey('HostsOverride')) { $HostsOverride } else { Get-HostsOverride -HostName ([string]$target.Host) }
        if ($ov -and $ov.Loopback) {
            $hints += ('本机 hosts 把它指向 {0}（`{1}`）——这是本机记录，不是远端故障；先修 hosts/加速器' -f $ov.Ip, $ov.Line)
        }
        $tr = $null
        if ($script:_routeTrace -and $script:_routeTrace.TryGetValue([string]$target.Authority, [ref]$tr)) {
            if ($tr.ExcludedProxy) {
                $wl = if (@($tr.Whitelist).Count -gt 0) { @($tr.Whitelist) -join ',' } else { '(空)' }
                $hints += ('MCPS_PROXY 白名单未包含该域（当前：{0}）⇒ 未尝试 {1}；把它加入白名单，或设 MCPS_PROXY_FALLBACK=1' -f $wl, $tr.ExcludedProxy)
            }
            if (@($tr.Trace).Count -gt 0) { $hints += ('选路：{0}' -f (@($tr.Trace) -join '、')) }
        }
        if (@($hints).Count -eq 0) { return '' }
        return ('；' + (@($hints) -join '；'))
    } catch { return '' }
}
function Get-NetworkEngineName {
    if ($script:_networkEngine) { return [string]$script:_networkEngine } # GitLabBlobs 内嵌池没有 Search-* 栈
    foreach ($frame in @(Get-PSCallStack)) {
        foreach ($e in @($script:_engineRegistry)) {
            if ($e.Func -eq $frame.FunctionName) { return [string]$e.Name }
        }
    }
    return $null
}
function Test-NetworkPlaceholderReason {
    # v1.49.1：区分「占位（探活被打断）」与「真网络失败」的唯一判据。
    #   占位由 Get-ApiRequestRouteContext 在探活**之前**写入，探活确认可达后由同一函数撤回；
    #   留给下游的语义因此变成："这条还在 = 探活确实没有结论"。
    #   单独抽成纯函数是为了可 dot-source 直测（门 U-218）—— 只靠源码字符串匹配拦不住回归。
    param([string]$Reason)
    return ($Reason -like 'network-route-unproven:*探活未完成即被打断*')
}
# ---------- v1.51.0：确定性失败快速失败（Tier1-1） ----------
# 依据（2026-10-22 多子代理调研，reports/全模块目标验收与下一阶段方案-2026-10-22.md §3.1）：
#   业界对"确定性失败"（代理 CONNECT 失败 / DNS 解析失败 / 连接被拒）不给任何等待预算 ——
#   重试同一坏路由、或走同一条坏代理做 TLS 兜底，都是纯损耗。本机实测：
#   -Auto 单轮 HF 独占 22.2s、DockerHub 9.0s，reason 全是代理 502 / hosts 劫持，没有一条是"再等等就会好"。
function Get-TransportFailureText {
    # v1.53.5（2026-10-23 实测）：**PS 5.1 的代理 CONNECT 502 只在 InnerException 里留下证据**。
    #   Message  = 「基础连接已经关闭: 发送时发生错误。」
    #   Inner    = 「由于远程方已关闭传输流，身份验证失败。」（.NET 的 "authentication failed because
    #              the remote party has closed the transport stream"）
    #   而 `ErrorRecord.ToString()` 不含 Inner ⇒ 分类器只看到"基础连接已经关闭"，三条正则全不中 ⇒ 判 $null。
    #   本函数把 Message / 逐层 InnerException / 整条记录拼成一份文本（分类器与归因共用同一来源）。
    #   截断到 1000 且不切在代理对中间（U-134 同类风险：孤立代理项会让 ConvertTo-Json 输出 \ud83d）。
    param($ErrorRecord)
    $parts = @()
    try { if ($ErrorRecord.Exception.Message) { $parts += [string]$ErrorRecord.Exception.Message } } catch { }
    try {
        $inner = $ErrorRecord.Exception
        while ($inner -and $inner.InnerException) {
            $inner = $inner.InnerException
            if ($inner.Message) { $parts += [string]$inner.Message }
        }
    } catch { }
    try { if ("$ErrorRecord") { $parts += [string]$ErrorRecord } } catch { }
    $s = ($parts -join ' ').Trim()
    if ($s.Length -gt 1000) {
        $cut = 1000
        if ([char]::IsHighSurrogate($s[$cut - 1])) { $cut-- }
        $s = $s.Substring(0, $cut)
    }
    return $s
}
function Test-DeterministicTransportFailure {
    # 纯函数：给定异常/消息，返回机器可读的确定性失败码（proxy-tunnel / dns-or-refused / connect）；不确定则 $null。
    #   ★只认**传输层**症状，不认超时/5xx（那两类可能是慢代理或服务端抖动，值得重试）。
    #   ★行动边界（v1.51.0 实测决定）：**只有 `proxy-tunnel` 触发全量快速失败**（零重试、跳过 node 兜底、登记死主机）——
    #   那是"同一条坏代理上一切路径都无效"的唯一形态（本机实测浪费的正是它）。
    #   `dns-or-refused` / `connect` 只作为归因码：node 兜底走的是另一套栈（--use-system-ca），对 DNS/拒接有可能成功，
    #   且既有契约（run-tests 12e/N-8）要求兜底仍触发 —— 分类为确定性但不跳兜底。
    # v1.53.5：`-ProxyActive` 参与判定 —— PS 5.1 的代理 CONNECT 502 措辞（「基础连接已经关闭」+ Inner
    #   「由于远程方已关闭传输流」）只在有代理时算 proxy-tunnel；直连的 TLS 抖动仍按可重试处理。
    param([string]$Text, [bool]$ProxyActive = $false)
    $t = [string]$Text
    if (-not $t) { return $null }
    if ($t -match 'proxy tunnel request to proxy') { return 'proxy-tunnel' }
    # v1.53.5（2026-10-23 实测）：**PS 5.1 的措辞与 PS 7 完全不同**，导致本分类器在默认运行时上从不命中
    #   `proxy-tunnel` ⇒ 重试 8 次 + node 兜底（`-Platform All` 实测 30.9s，其中 GitHub 独占 29s 撞截止）。
    #   PS 5.1：Message「基础连接已经关闭: 发送时发生错误。」+ Inner「由于远程方已关闭传输流，身份验证失败。」
    #   PS 7  ：`The proxy tunnel request to proxy '…' failed with status code '502'.`（上面那条已覆盖）
    #   ★只在**有代理**时判定：直连场景的 TLS 抖动仍值得重试（不把可恢复故障判死 —— 与 dns/connect 同一边界）。
    if ($ProxyActive -and $t -match '基础连接已经关闭|The underlying connection was closed') {
        if ($t -match '远程方已关闭传输流|remote party has closed the transport stream') { return 'proxy-tunnel' }
    }
    if ($t -match 'The remote name could not be resolved|NameResolutionFailure|ProxyNameResolutionFailure|由于目标计算机积极拒绝|actively refused') { return 'dns-or-refused' }
    if ($t -match 'Unable to connect to the remote server|Connection refused|ConnectFailure') { return 'connect' }
    return $null
}
function Set-DeadNetworkHost {
    # 进程内死主机登记（circuit breaker 的最小形态）：命中确定性失败 ⇒ 同进程后续同主机请求零等待直接跳过。
    #   跨引擎共享（HF 的 models/datasets 同域）、跨查询共享（Serve/批模式）。
    #   不持久化：换进程重试是合理的（代理/hosts 可能已修）。
    param([string]$HostName, [string]$Reason)
    if (-not $HostName -or -not $script:_networkDeadHosts) { return }
    $prev = $null
    if (-not $script:_networkDeadHosts.TryGetValue($HostName, [ref]$prev)) {
        $script:_networkDeadHosts[$HostName] = [string]$Reason
    }
}
function Get-DeadNetworkHost {
    # 返回该主机的确定性失败登记（没有则 $null）。调用点据此零等待跳过。
    param([string]$HostName)
    if (-not $HostName -or -not $script:_networkDeadHosts) { return $null }
    $r = $null
    if ($script:_networkDeadHosts.TryGetValue($HostName, [ref]$r)) { return [string]$r }
    return $null
}
function Get-ProxyBreakerState {
    # v1.53.7（Tier-1 §1 剩余项）：代理网关 5xx 的**进程内熔断**查询，并把归因文案一并给出（单一事实源）。
    #   为什么必须有：`proxy-tunnel`（CONNECT 隧道失败）已被 v1.51.0 快速失败，但代理把 502 当**普通 HTTP 响应**
    #   返回时走的是 5xx 退避分支，压根不进传输层分类器 ⇒ 同一坏代理被重试 3 次（每次 ~7s）。
    #   实测代价：`-Platform All` 里 GitHub 独占 24–29s，最终 reason 只剩「单引擎超 29s 截止」——
    #   用户既等满，又看不出是代理坏了（Tier-1 调研的 "failing supplier costs nothing"）。
    #   语义：同一主机**连续** N 次 502/503/504 ⇒ 打开 60s（期间零请求）；到期半开（放行一次探测）；
    #   探测再失败立刻重开（不必再攒 N 次），成功则清零。
    #   ★-NowMs 是**测试缝**（0 = 真实时钟）：真值表要能把表拨到 61 秒后验半开，否则只能 sleep 60s。
    #   ★毫秒时间戳必须 long：UtcNow.ToUnixTimeMilliseconds() ≈ 1.79e12 超出 Int32 ⇒ 受控实验（2026-10-23）
    #   在真机上第一次打开熔断就抛 '值对于 Int32 太大或太小'。假时钟（1e6）在 Int32 内，真值表**测不出来**。
    param([string]$HostName, [long]$NowMs = 0)
    $closed = [PSCustomObject]@{ State = 'closed'; RemainingSec = 0; Count = 0; Reason = $null }
    if (-not $HostName -or -not $script:_proxyBreaker) { return $closed }
    $st = $null
    if (-not $script:_proxyBreaker.TryGetValue($HostName, [ref]$st) -or -not $st) { return $closed }
    $now = if ($NowMs -gt 0) { $NowMs } else { [long][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
    $until = [long]$st.OpenUntil
    if ($until -le 0) { return [PSCustomObject]@{ State = 'closed'; RemainingSec = 0; Count = [int]$st.Count; Reason = $null } }
    $left = [int][math]::Ceiling(($until - $now) / 1000.0)
    if ($left -le 0) { return [PSCustomObject]@{ State = 'half'; RemainingSec = 0; Count = [int]$st.Count; Reason = $null } }
    return [PSCustomObject]@{ State = 'open'; RemainingSec = $left; Count = [int]$st.Count
        Reason = ('proxy-breaker: {0} 代理连续 {1} 次网关 5xx，熔断剩余 {2}s 内不再请求（MCPS_PROXY_BREAKER_SEC=0 关闭）' -f $HostName, [int]$st.Count, $left) }
}
function Update-ProxyBreaker {
    # v1.53.7：登记一次**走代理**的请求结果。'ok' 清零；'5xx' 累加，达阈值或半开期再失败 ⇒ 打开。
    #   返回：**刚触发**熔断时的现成归因文案（供调用点直接 throw）；其余一律 $null。
    #   ★本函数不自己判"这次是不是走了代理"—— 调用点在代理分支里，直连 5xx 属源侧问题，不得计入。
    param([string]$HostName, [ValidateSet('ok','5xx')][string]$Outcome, [long]$NowMs = 0)
    if (-not $HostName -or -not $script:_proxyBreaker) { return $null }
    if ($Outcome -eq 'ok') { $gone = $null; [void]$script:_proxyBreaker.TryRemove($HostName, [ref]$gone); return $null }
    $openAfter = 2; $openSec = 60
    try { $openAfter = [int]$script:Cfg.ProxyBreakerOpenAfter } catch { }
    try { $openSec = [int]$script:Cfg.ProxyBreakerSec } catch { }
    if ($env:MCPS_PROXY_BREAKER_SEC -match '^\d+$') { $openSec = [int]$env:MCPS_PROXY_BREAKER_SEC }
    if ($openAfter -lt 1 -or $openSec -le 0) { return $null }   # 关闭阀（0 = 恢复旧行为逐位不变）
    $now = if ($NowMs -gt 0) { $NowMs } else { [long][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
    $prev = $null
    $cur = if ($script:_proxyBreaker.TryGetValue($HostName, [ref]$prev) -and $prev) { $prev } else { [PSCustomObject]@{ Count = 0; OpenUntil = 0 } }
    $wasOpen = ([long]$cur.OpenUntil -gt 0) -and ([long]$cur.OpenUntil -le $now)   # 半开期已过 ⇒ 这次就是那次探测
    $count = [int]$cur.Count + 1
    $trip = $wasOpen -or ($count -ge $openAfter)
    $script:_proxyBreaker[$HostName] = [PSCustomObject]@{ Count = $count; OpenUntil = $(if ($trip) { $now + $openSec * 1000 } else { [long]$cur.OpenUntil }) }
    if (-not $trip) { return $null }
    return (Get-ProxyBreakerState -HostName $HostName -NowMs $now).Reason
}
function Resolve-ProxyGatewayOutcome {
    # v1.53.7：把一次请求结果登记进代理熔断表，并返回**应立刻收束**的文案（否则 $null）。
    #   为什么单独成函数：① D4 —— Invoke-ApiRequest 已贴着 100 行上限；② curl 分支与 web 分支的判定完全同构，
    #   三处调用点各写一遍容易改漏（本批第一版就把 HTTP 代理接到了 curl 分支上，实网一次都没触发）。
    #   ★-ViaProxy 由调用点按 `NetworkRoute.Kind ∈ {http,socks}` 给出，**不能用 $proxyMode**：后者只表示
    #   "socks 走 curl"，而 HTTP 代理的 502 是 `Invoke-ApiWebOnce` 拿到的**普通 HTTP 响应**，走的是 web 分支。
    #   ★只有 502/503/504 计入：500 多为源侧异常（重试合理），429 有 Retry-After 语义（走限流路径）。
    param([string]$HostName, [switch]$ViaProxy, [int]$Code = 0)
    if (-not $ViaProxy) { return $null }   # 直连的 5xx 是源侧问题，不得计入代理熔断
    if ($Code -ge 200 -and $Code -lt 300) { $null = Update-ProxyBreaker -HostName $HostName -Outcome 'ok'; return $null }
    if ($Code -in @(502, 503, 504)) { return (Update-ProxyBreaker -HostName $HostName -Outcome '5xx') }
    return $null
}
function Resolve-UnprovenRouteBudget {
    # v1.53.8：路由**未证实**（ProbeState≠reachable）时，单请求超时封顶**并且不再重试**。
    #   为什么不再重试：v1.51.0 的封顶语义是「未证实路由上的**单次**请求最多等 8s」——8s 到了还没回应，
    #   重试只是把同一个 8s 再等一遍（探活已经先失败过一次，这是第二/第三次同样的等待）。
    #   实测（2026-10-23 本机）：`-Platform All` 31s 里 GitLab 独占 29s = 探活 4s + 8s×3 次 ⇒ 撞 29s 引擎截止，
    #   而它与 v1.53.0 的 code 通路单请求预算（长请求只许一次）是同一条思路：**等待不能靠乘法放大**。
    #   ★注释里不许写函数名：U-41 的闭包扫描把 `Xxx-Yyy` 形状一律算调用（本批第一次就是这么红的）。
    #   本机回环必须例外：`Get-NetworkRoute` 对 loopback 直接返回（没有探活阶段 ⇒ 没有 ProbeState），
    #   而 test-u177/u188 的本机桩依赖重试语义。封顶值 =0（或 MCPS_UNPROVEN_ROUTE_SEC=0）⇒ 整体恢复旧行为。
    param($Route, [int]$TimeoutSec, [int]$MaxAttempts)
    $out = [PSCustomObject]@{ TimeoutSec = $TimeoutSec; MaxAttempts = $MaxAttempts; Capped = $false }
    if (-not $Route) { return $out }
    if ([string]$Route.Source -eq 'loopback') { return $out }
    if ([string]$Route.ProbeState -eq 'reachable') { return $out }
    $cap = 0
    try { $cap = if ($env:MCPS_UNPROVEN_ROUTE_SEC -match '^\d+$') { [int]$env:MCPS_UNPROVEN_ROUTE_SEC } else { [int]$script:Cfg.UnprovenRouteRequestSec } } catch { $cap = 0 }
    if ($cap -le 0) { return $out }
    return [PSCustomObject]@{ TimeoutSec = $(if ($TimeoutSec -gt $cap) { $cap } else { $TimeoutSec }); MaxAttempts = 1; Capped = $true }
}
function Test-UnprovenRouteTimeout {
    # v1.53.9：**这条失败值不值得换栈再试一次**。node 兜底的价值在"另一套 TLS/CA 栈"
    #   （证书链、协议差异），不在"再等一遍"——如果这一轮已经把超时用满，换栈只是把同一个等待再走一次。
    #   实测（2026-10-23 GitLab，3/3）：PS 侧 8s 超时后，node 兜底 5.7s 全部 no-status(transport-failure)。
    #   ★保留原契约：**快速**传输失败（DNS/连接被拒，耗时远小于超时）仍走兜底 —— 换栈对这类确实可能成。
    #   判据用"耗时 ≥ 超时×比例"而不是"抓到了什么异常文本"：跨运行时措辞不一致（v1.53.5 的教训），耗时是硬信号。
    param([bool]$Capped, [double]$ElapsedSec, [int]$TimeoutSec, [double]$Ratio = 0.8)
    if (-not $Capped -or $TimeoutSec -le 0) { return $false }
    return ($ElapsedSec -ge ($TimeoutSec * $Ratio))
}
function Get-ApiRequestRouteContext {
    param([string]$Uri, [switch]$NoProxy, [int]$BudgetMs = 0)
    # U-267（B3-1）：回放期**完全跳过探活**。探活本身是真网络请求，而它的结论决定引擎落 blocked 还是 executed ——
    #   全量串行实测（同一份语料、同一台机器）：MCPRegistry 在两态之间翻转，`Executed/Blocked/Verdict/ExitCode` 跟着变。
    #   回放既然号称"冻结上游"，就必须连"可达性"一起冻结；否则基线仍然由**当前网络**决定，只是换了个地方抖。
    if (-not [string]::IsNullOrWhiteSpace($env:MCPS_REPLAY_DIR)) {
        $rt = [PSCustomObject]@{ Kind = 'direct'; Source = 'replay'; ProbeState = 'reachable'; ProxyUrl = $null }
        return [PSCustomObject]@{ NetworkRoute = $rt; NetworkEngine = (Get-NetworkEngineName); ProxyMode = $false; ProxyUrl = $null; Direct = $true }
    }
    # U-156/U-155：仅对本次真实请求 URL 首次逐域探活；新码只在候选明确不可达时产生。
    # 由 Get-NetworkCandidates 统一处理 MCPS_PROXY 白名单、环境/系统代理、直连，不再自行猜域名或清 env。
    # P1（2026-10-19）：-BudgetMs 透传给逐域探活（Doctor 等带总预算的调用方用它封顶）。
    $networkEngine = Get-NetworkEngineName
    # v1.47.2（P1-4）：**先占位、再探活**。探活是同步 HttpWebRequest，`Stop()` 打不断它 ⇒
    #   引擎截止若落在探活中间，下面两条写入分支都不会执行，池尾连键都拿不到
    #   （v1.47.0 实测：HF / DockerHub 只剩一句「单引擎超 Ns 截止」，hosts 证据一个字都没有）。
    #   占位值只声明"被打断"这一事实；真结论仍由下面两条分支覆盖（同引擎后续请求会改写）。
    if ($networkEngine -and $script:_networkFailures -and -not $script:_networkFailures.ContainsKey($networkEngine)) {
        $script:_networkFailures[$networkEngine] = "network-route-unproven: $(([uri]$Uri).Authority)（探活未完成即被打断）"
    }
    $networkRoute = Get-NetworkRoute -Uri $Uri -NoProxy:$NoProxy -BudgetMs $BudgetMs
    $hint = Get-NetworkRouteHint -Uri $Uri   # U-206/U-207：只读已采集证据（hosts/白名单/选路），失败路径零额外延迟
    if ($networkRoute.Kind -eq 'unavailable') {
        $hostName = ([uri]$Uri).Authority # 不包含 ?token、代理凭据等敏感字段
        $msg = "network-unavailable: $hostName（所有路由探活均确认不可达）$hint"
        if ($networkEngine -and $script:_networkFailures) { $script:_networkFailures[$networkEngine] = $msg }
        throw "$msg（本次跳过请求）"
    }
    if ($networkEngine -and $networkRoute.ProbeState -ne 'reachable' -and $script:_networkFailures) {
        # U-206：路由只是**未确认**（探活超时）时如实记下，但**不改写引擎状态** ——
        #   慢代理可能探活超时、真实请求却成功（实测 socks 冷启动 6s vs 探活 2.5s）。
        #   是否告警由调用方按「有没有拿到 HTTP/结果」二次判定（见 coverage 汇总段）。
        $script:_networkFailures[$networkEngine] = "network-route-unproven: $(([uri]$Uri).Authority)（未确认的路由：$($networkRoute.Source)）$hint"
    }
    if ($networkEngine -and $networkRoute.ProbeState -eq 'reachable' -and $script:_networkHttpResponses) {
        $script:_networkHttpResponses[$networkEngine] = $true
        # v1.49.1：占位只是「探活被打断」的**临时**断言，探活一旦确认可达就不再为真 ⇒ 必须撤回。
        #   不撤回的后果（v1.49.0 实测）：引擎在**探活完成之后**才挂死时，归因里仍挂着「探活未完成即被打断」，
        #   下游（含验收门）会把"路由正常、请求挂住"误读成"网络探活没过"。
        $curNet = $null
        if ($script:_networkFailures.TryGetValue($networkEngine, [ref]$curNet) -and (Test-NetworkPlaceholderReason -Reason ([string]$curNet))) {
            # ★ConcurrentDictionary 没有单参 Remove（显式接口实现）—— 实测 `$dict.Remove($k)` 抛
            #   "Cannot find an overload for Remove and the argument count 1"。必须用 TryRemove。
            $gone = $null
            [void]$script:_networkFailures.TryRemove($networkEngine, [ref]$gone)
        }
    }
    return [PSCustomObject]@{ NetworkRoute = $networkRoute; NetworkEngine = $networkEngine; ProxyMode = ($networkRoute.Kind -eq 'socks'); ProxyUrl = $networkRoute.ProxyUrl; Direct = ($networkRoute.Kind -eq 'direct') }
}
# v1.45.7（2026-10-20）：curl 失败原因的单源判读。
#   为什么必须有：Invoke-ApiSocksOnce 原来 `2>$null` 把 curl 的 stderr 整个丢掉，上层只拿到
#   「curl 无状态码输出」一句 ⇒ 所有传输层失败长得一样。实测同一构建同一端点：
#   Doctor 时而 `HTTP 200`、时而 `unreachable`；而 curl 直打时的 stderr 是
#   `schannel: CRYPT_E_NO_REVOCATION_CHECK`（本机取不到证书吊销列表）—— 这既不是令牌坏了，
#   也不是主机不可达，处置方式（查本机证书链）与另两种完全不同。
# 输出带**机器可判读的前缀**（`tls-error:` / `timeout:`），供 Doctor 分档，不靠猜中文。
# v1.45.7（2026-10-20）：令牌探针的失败 → Probe 状态，**单源**（显示、remoteBlocked、代理建议共用）。
#   口径：拿到 HTTP 码就报码（401/403 是唯一能证明令牌无效的）；否则按可判读的形状分档 ——
#   tls-error（本机证书链/吊销检查）、timeout（预算内没回来）、unreachable（其余传输失败）。
#   为什么不能合并：三者的处置完全不同，合并后 Doctor 只会说「换令牌」。
function Test-LoopbackAddress {
    param([string]$Ip)
    if ([string]::IsNullOrWhiteSpace($Ip)) { return $false }
    $s = $Ip.Trim().Trim('[', ']')
    if ($s -eq '::1') { return $true }
    return ($s -match '^127\.')
}
# U-194（2026-10-21）：**hosts 劫持诊断**。实测本机 hosts 有 `127.0.0.1 api.github.com #S302`，
#   而 443 无本地监听 ⇒ 所有 HTTPS 请求 TCP 直接 RST/EOF，Doctor 只报 `timeout`/`unreachable`，
#   人看到的是"GitHub 挂了"而不是"你本机 hosts 把它指到了本机"。这里把"解析到回环 + hosts 有该行"变成显式证据。
#   只读 hosts（不写、不改 DNS、不做任何解析），命中即返回原始行，供报告直接引用。
function Get-HostsOverride {
    # U-206（2026-10-21）：**进程内解析一次**。
    #   旧写法每次调用都重读 hosts 并逐行 `-split '\s+' | Where-Object { $_ }` 走管道 —— PS 5.1 实测
    #   1.2s/次（972 行 ⇒ 972 个管道）。v1.47.0 把它接进"每个请求的失败提示"路径后，单请求白付 1.2s，
    #   `run-tests.ps1` 的 U-24(b)（MaxAttempts=1 不应退避）从 53ms 变成 1718ms 立刻红。
    #   ⇒ 解析一次进缓存；顺带去掉逐行管道（手工切分），首次调用也从 1.2s 降到几十 ms。
    param([string]$HostName)
    if ([string]::IsNullOrWhiteSpace($HostName)) { return $null }
    if ($null -eq $script:_hostsCache) {
        $cache = @{}
        $files = @()
        # U-55：系统目录走 .NET 的 SpecialFolder（不读环境变量，也就不必登记成旋钮）
        $sysRoot = ''
        try { $sysRoot = [Environment]::GetFolderPath([Environment+SpecialFolder]::Windows) } catch { }
        if ($sysRoot) { $files += (Join-Path $sysRoot 'System32\drivers\etc\hosts') }
        $files += '/etc/hosts'
        foreach ($f in $files) {
            if (-not (Test-Path -LiteralPath $f)) { continue }
            try { $lines = @(Get-Content -LiteralPath $f -ErrorAction Stop) } catch { continue }
            foreach ($ln in $lines) {
                $t = [string]$ln
                $hash = $t.IndexOf('#')
                if ($hash -ge 0) { $t = $t.Substring(0, $hash) }
                $t = $t.Trim()
                if ($t.Length -eq 0) { continue }
                $parts = @($t -split '\s+')
                if ($parts.Count -lt 2) { continue }
                $ip = [string]$parts[0]
                for ($i = 1; $i -lt $parts.Count; $i++) {
                    $n = [string]$parts[$i]
                    if (-not $n) { continue }
                    if ($cache.ContainsKey($n)) { continue }   # 与旧行为一致：同名多行取第一行
                    $cache[$n] = [PSCustomObject]@{ Host = $n; Ip = $ip; Line = $ln.Trim(); File = $f; Loopback = (Test-LoopbackAddress -Ip $ip) }
                }
            }
        }
        $script:_hostsCache = $cache
    }
    if ($script:_hostsCache.ContainsKey($HostName)) { return $script:_hostsCache[$HostName] }
    return $null
}
function Get-HostsHijackHint {
    # 只对**传输层失败**给 hosts 结论：HTTP 401/403/429 是上游真实回答，即使 hosts 有该行也不改判。
    param([string]$Uri, [string]$Probe)
    if ($Probe -match '^HTTP\s+\d{3}') { return $null }
    try {
        $h = ([uri]$Uri).Host
    } catch { return $null }
    $ov = Get-HostsOverride -HostName $h
    if ($ov -and $ov.Loopback) { return $ov }
    return $null
}
function ConvertFrom-TokenProbeFailure {
    param([string]$ErrorText)
    $m = "$ErrorText"
    if ($m -match 'HTTP (\d{3})') { return "HTTP $($Matches[1])" }
    if ($m -match '\b(401|403)\b') { return "HTTP $($Matches[1])" }
    if ($m -match 'tls-error|TLS 握手失败|schannel|CRYPT_E|certificate|证书') { return 'tls-error' }
    if ($m -match 'timeout|timed?\s?out|超时|预算耗尽') { return 'timeout' }
    return 'unreachable'
}
function Get-CurlFailureHint {
    param($ExitCode, [string]$ErrorText)
    $rc = $(if ($null -ne $ExitCode) { [int]$ExitCode } else { $null })
    $t = ("$ErrorText" -replace '\s+', ' ').Trim()
    $brief = $(if ($t) { $t.Substring(0, [Math]::Min(110, $t.Length)) } else { "curl rc=$rc" })
    # curl 退出码表：35=SSL 握手失败、51/53/54/58/59/60/64/66/77/83/90/91 = 各类证书/SSL 问题
    if ($rc -in @(35, 51, 53, 54, 58, 59, 60, 64, 66, 77, 83, 90, 91) -or $t -match 'schannel|CRYPT_E|SSL|certificate|证书|吊销|revocation') {
        return ('TLS 握手失败 tls-error: {0}' -f $brief)
    }
    if ($rc -eq 28 -or $t -match 'timed?\s?out|timeout|超时') { return ('超时 timeout: {0}' -f $brief) }
    switch ($rc) {
        5 { return 'DNS 解析代理失败（curl rc=5）' }
        6 { return 'DNS 解析失败（curl rc=6）' }
        7 { return '连接被拒（curl rc=7）' }
        52 { return '服务端空回复（curl rc=52）' }
        56 { return '接收数据失败（curl rc=56）' }
    }
    if ($t) { return ('curl rc={0}: {1}' -f $(if ($null -ne $rc) { $rc } else { 'unknown' }), $brief) }
    return ('curl rc={0}' -f $(if ($null -ne $rc) { $rc } else { 'unknown' }))
}
