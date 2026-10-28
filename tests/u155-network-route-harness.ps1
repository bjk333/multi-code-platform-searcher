# U-155/U-156 纯离线选路夹具。宿主运行；本端只落文件、不在桥内执行。
# 覆盖环境代理活/死、HEAD→GET、4xx/5xx 分类静态门、显式模式、NO_PROXY、全失败 skip。
$ErrorActionPreference = 'Stop'
$main = Join-Path (Split-Path -Parent $PSScriptRoot) 'multi-platform-searcher.ps1'
$env:MCPS_NO_MAIN = '1'
. $main -NoEnvFile -ProxyMode auto
$script:_sysProxyMode = 'bypass' # 不依赖宿主 WinINET；本夹具由合成候选决定
$env:MCPS_PROXY = 'socks5://127.0.0.1:49678;fixture.invalid'
$env:HTTPS_PROXY = 'http://127.0.0.1:49679'
$env:https_proxy = 'http://127.0.0.1:49679' # Windows 环境变量名大小写不敏感，不能把上面的 HTTPS_PROXY 覆盖成空串
$env:ALL_PROXY = ''
$env:all_proxy = ''
$env:NO_PROXY = ''
$env:no_proxy = ''
$target = 'https://fixture.invalid/path?q=vector'
$script:ProbeCalls = @(); $script:ProbePolicy = @{}
$oldProbe = (Get-Item function:Invoke-NetworkProbeOnce).ScriptBlock
Set-Item function:Invoke-NetworkProbeOnce -Value {
    param([uri]$Target, $Route, [string]$Method)
    $key = "$($Route.Source)|$Method"
    $script:ProbeCalls += "$key|$($Target.AbsoluteUri)"
    if ($script:ProbePolicy.ContainsKey($key)) { return $script:ProbePolicy[$key] }
    return 'unreachable'
}
try {
    # localhost 是有效代理候选，不能用地址字符串把它判死。HEAD 见 HTTP（模拟响应）无需 GET。
    $script:_networkRoutes.Clear(); $script:ProbeCalls = @()
    $script:ProbePolicy = @{ 'MCPS_PROXY|HEAD' = 'reachable' }
    $route = Get-NetworkRoute -Uri $target
    if ($route.Source -ne 'MCPS_PROXY' -or $route.Kind -ne 'socks' -or @($script:ProbeCalls).Count -ne 1 -or
        $script:ProbeCalls[0] -ne "MCPS_PROXY|HEAD|$target") { throw 'U-155 live localhost proxy/actual URL HEAD failed' }
    # 同域路由缓存：后续相同域的请求不额外 HEAD 猜测用不到的站点。
    $route2 = Get-NetworkRoute -Uri 'https://fixture.invalid/next?x=1'
    if ($route2.Source -ne 'MCPS_PROXY' -or @($script:ProbeCalls).Count -ne 1) { throw 'U-155 domain cache failed' }

    # SOCKS 明确拒绝，env proxy HEAD 传输未知但 GET 见 HTTP，则必须选 env，非直连。
    $script:_networkRoutes.Clear(); $script:ProbeCalls = @()
    $script:ProbePolicy = @{ 'HTTPS_PROXY|HEAD' = 'unknown'; 'HTTPS_PROXY|GET' = 'reachable' }
    $route = Get-NetworkRoute -Uri $target
    if ($route.Source -ne 'HTTPS_PROXY' -or $route.Kind -ne 'http' -or
        @($script:ProbeCalls | Where-Object { $_ -match '^HTTPS_PROXY\|GET\|' }).Count -ne 1) {
        throw 'U-156 dead SOCKS then live process HTTP proxy / GET fallback failed'
    }

    # HEAD/GET 均只得到超时/TLS 不明信号：宁可继续真实请求，也不能凭空报网络不可达。
    $script:_networkRoutes.Clear()
    $script:ProbePolicy = @{ 'HTTPS_PROXY|HEAD' = 'unknown'; 'HTTPS_PROXY|GET' = 'unknown' }
    $route = Get-NetworkRoute -Uri $target
    if ($route.Kind -ne 'http' -or $route.Source -ne 'HTTPS_PROXY') { throw 'U-155 ambiguous TLS/timeout must not be skipped' }

    # 全候选明确 DNS/连接被拒时才有 network-unavailable，异常不得回显 URL query 参数。
    $script:_networkRoutes.Clear(); $script:ProbePolicy = @{}
    $script:_networkEngine = 'HF'
    $script:_networkFailures.Clear()
    $errorText = ''
    try { $null = Invoke-ApiRequest -Uri 'https://fixture.invalid/path?token=synthetic-private' -Headers @{} -MaxAttempts 1 }
    catch { $errorText = $_.Exception.Message }
    if ($errorText -notmatch '^network-unavailable:' -or $errorText -match 'synthetic-private' -or
        -not $script:_networkFailures.ContainsKey('HF')) { throw 'U-155 all-candidates-unreachable skip/reason/query redaction failed' }
    $script:_networkEngine = $null

    # 显式指定代理只试本代理（不用环境候选/直连）；direct 和 NO_PROXY 只能直连。
    $script:ProxyMode = 'proxy:http://127.0.0.1:49680'
    $spec = @(Get-NetworkCandidates -Target ([uri]$target))
    if ($spec.Count -ne 1 -or $spec[0].Source -ne 'explicit') { throw 'U-156 explicit proxy must not fallback to another route' }
    $script:ProxyMode = 'direct'
    $spec = @(Get-NetworkCandidates -Target ([uri]$target))
    if ($spec.Count -ne 1 -or $spec[0].Kind -ne 'direct') { throw 'U-156 direct ignored' }
    $script:ProxyMode = 'auto'; $env:NO_PROXY = 'fixture.invalid'
    $spec = @(Get-NetworkCandidates -Target ([uri]$target))
    if ($spec.Count -ne 1 -or $spec[0].Kind -ne 'direct') { throw 'U-156 NO_PROXY ignored' }
    $env:NO_PROXY = ''
    $env:MCPS_PROXY = 'socks5://127.0.0.1:49678;other.invalid'
    $spec = @(Get-NetworkCandidates -Target ([uri]$target))
    if (@($spec | Where-Object { $_.Source -eq 'MCPS_PROXY' }).Count -gt 0) { throw 'U-76 whitelist mismatch still selected SOCKS' }
    Write-Output '[U-155/U-156] offline route vectors PASS (live-localhost/dead-fallback/unknown/skip/direct/explicit/NO_PROXY/whitelist)'
} finally {
    Set-Item function:Invoke-NetworkProbeOnce -Value $oldProbe
    $script:_networkEngine = $null
}
