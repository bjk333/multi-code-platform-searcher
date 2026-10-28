# ==============================================================================
# lib/doctor.ps1 -- Multi-Code-Platform Searcher | B3-2 模块拆分（v1.54.0）
#
# 诊断与批量：-Doctor 报告（令牌/远程/研究源/代理覆盖）、-ResearchBatch 并发调研。
#
# 契约：本文件只定义（函数 / $script: 数据），无顶层副作用；由主脚本按固定顺序点源加载。
#   · 作用域：点源进主脚本作用域，故 $script: 指向主脚本；版本号/参数等由主脚本提供。
#   · 不要在这里 exit、不要写 stdout：进度与产物分别走 Write-ColorOutput / Write-PayloadOutput。
#   · 新增函数放对应模块；跨模块调用无需前置声明（全部在运行前定义完毕）。
# ==============================================================================

function Get-DoctorToolInventory {
    # U-141：本地目录先于 PATH；非 Windows 绝不把 .exe 当成候选；真正执行 --version 探活后才能记 Present。
    # 参数只供离线门注入路径/平台；Doctor 默认使用真实平台、目录和 Test-LocalBinaryAlive。
    param([object[]]$ToolSpecs = $script:doctorTools,
          [Nullable[bool]]$PlatformWindows = $null,
          [string[]]$CandidateDirs = $null)
    $isWin = if ($null -ne $PlatformWindows) { [bool]$PlatformWindows }
             elseif ($null -ne $IsWindows) { [bool]$IsWindows } else { $true }
    if (-not $PSBoundParameters.ContainsKey('CandidateDirs')) { $CandidateDirs = @(Get-LocalBinCandidateDirs) }
    foreach ($t in $ToolSpecs) {
        $names = @($t.Names | ForEach-Object { if ($isWin) { '{0}.exe' -f $_ } else { $_ } })
        $chosen = $null
        foreach ($name in $names) {
            $candidates = @()
            foreach ($dir in $CandidateDirs) {
                $candidate = Join-Path $dir $name
                if (Test-Path -LiteralPath $candidate -PathType Leaf) { $candidates += $candidate }
            }
            $app = Get-Command -Name $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($app) { $candidates += $app.Source }
            foreach ($candidate in $candidates) {
                if (Test-LocalBinaryAlive -Path $candidate) { $chosen = $candidate; break }
            }
            if ($chosen) { break }
        }
        $version = ''
        if ($chosen) {
            try {
                $line = & $chosen --version 2>$null | Select-Object -First 1
                if ($line) { $version = ([string]$line).Trim() }
            } catch { }
        }
        [PSCustomObject]@{
            Tool = $t.Label; Exe = $(if ($chosen) { [IO.Path]::GetFileName($chosen) } else { $names[0] })
            Present = [bool]$chosen; Version = $version; Role = $t.Role
            Status = $(if ($chosen) { 'ok' } else { 'tool_missing' })
        }
    }
}
# v1.53.17（跨平台补洞）：缺工具时给**可执行**安装命令，而不是只说"请安装 ripgrep"。
#   依据：Linux 容器实测 -Doctor 五项全 tool_missing，而旧文案在非 Windows 上无指向（那里没有 winget）。
#   平台由调用方判定（PS 5.1 没有 $IsLinux/$IsMacOS），也允许显式传入以便门覆盖三平台。
#   口径：只写各生态**官方/标准**安装入口；不确定的包 ID 不编（ugrep 的 winget 用 search 而非猜 ID）。
function Get-ToolInstallHint {
    param([string]$Tool, [string]$Platform)
    $p = if ($Platform) { $Platform.ToLower() }
         elseif ($null -ne $IsMacOS -and $IsMacOS) { 'mac' }
         elseif ($null -ne $IsLinux -and $IsLinux) { 'linux' }
         else { 'win' }
    $table = @{
        'ripgrep'  = @{ win = 'winget install BurntSushi.ripgrep.MSVC'; linux = 'sudo apt install ripgrep'; mac = 'brew install ripgrep' }
        'ugrep'    = @{ win = 'winget search ugrep（或 GitHub releases 下载）'; linux = 'sudo apt install ugrep'; mac = 'brew install ugrep' }
        'ast-grep' = @{ win = 'npm i -g @ast-grep/cli'; linux = 'npm i -g @ast-grep/cli'; mac = 'brew install ast-grep' }
        'aria2'    = @{ win = 'winget install aria2.aria2'; linux = 'sudo apt install aria2'; mac = 'brew install aria2' }
        'fzf'      = @{ win = 'winget install junegunn.fzf'; linux = 'sudo apt install fzf'; mac = 'brew install fzf' }
    }
    $row = $table[$Tool]
    if (-not $row) { return '' }
    return $row[$p]
}
# v1.53.20（零配置首跑）：**装完第一次就用**才是付费用户的第一印象。
#   现状：裸装（无任何令牌 + 无本地检索工具）时，匿名限速会显著压低召回，用户看到的是"一堆结果/0 条 + 技术性 warnings"，
#   不知道下一步该做什么。本函数只在**完全裸装**时给 ≤3 条可执行建议；有任何令牌或本地工具就返回空 —— 绝不打扰老用户。
#   取舍：不做"只缺一项"的提示。只缺工具/只缺令牌的情形在 -Doctor 的 recommendation 里已有专门分支（v1.53.17），
#   主流程每次都唠叨反而是噪音。
function Get-FirstRunAdvice {
    param([string[]]$MissingTokens = $null, [string[]]$MissingTools = $null, [string]$Platform)
    # ★用 $PSBoundParameters 判"是否已提供"，而不是判 $null：调用方传 `@()`（表示"一个都不缺"）时
    #   PS 会把空数组绑成空数组而非 $null，若按 null 判就会去探测工具/环境 —— 门用例会被本机状态污染。
    if (-not $PSBoundParameters.ContainsKey('MissingTokens')) {
        $MissingTokens = @(@('GITHUB_TOKEN', 'GITLAB_TOKEN', 'GITEE_TOKEN', 'SRC_TOKEN') |
            Where-Object { -not [Environment]::GetEnvironmentVariable($_) })
    }
    if (@($MissingTokens).Count -lt 4) { return @() }   # 配有任意令牌 ⇒ 不算裸装
    if (-not $PSBoundParameters.ContainsKey('MissingTools')) {
        # 只有真的一个令牌都没有时才探测工具：正常用户不该为这条提示付启动开销。
        $MissingTools = @(Get-DoctorToolInventory |
            Where-Object { $_.Tool -in @('ripgrep', 'ugrep') -and -not $_.Present } |
            ForEach-Object { $_.Tool })
    }
    if (@($MissingTools).Count -eq 0) { return @() }    # 有本地检索工具 ⇒ 匿名也够用
    $plat = if ($Platform) { $Platform }
            elseif ($null -ne $IsMacOS -and $IsMacOS) { 'mac' }
            elseif ($null -ne $IsLinux -and $IsLinux) { 'linux' }
            else { 'win' }
    $hint = Get-ToolInstallHint -Tool 'ripgrep' -Platform $plat
    return @(
        '先跑一次自检：-Doctor（看清哪些源可用、缺什么）',
        '配一个 GITHUB_TOKEN（放 .env 或环境变量）：匿名 10 次/分，配了 30 次/分；代码搜索必须认证',
        ("本地代码检索需要 ripgrep：{0}" -f $hint)
    )
}
# T1-2：只在已配置受限 SOCKS5 白名单且目标不可达时提示；不要输出代理 URL/凭据。
function Get-DoctorProxyAdvice {
    param([string]$Domain, [bool]$Reachable, [string]$Note = '', [string]$ProxySpec = $env:MCPS_PROXY)
    if ($Reachable -or -not $Domain -or $Note -match 'Vercel|\bHTTP\s*[1-5]\d\d\b|\b403\b') { return $null }
    # ★白名单解析**只允许一处**（U-207 抽出 Get-McpsProxySpec）：此前 Doctor 与真实选路各写一份
    #   `-split ',' | Trim`，T1-2 就是为"两边对同一域名给出不同结论"立的门 —— 现在两边同一函数。
    $sp = Get-McpsProxySpec -HostName $Domain -ProxySpec $ProxySpec
    if (-not $sp -or $sp.Allowed) { return $null }
    return "$Domain 不在 MCPS_PROXY 白名单且端点不可达；先核查代理/直连路由，必要时将 $Domain 加入白名单，不要据此判令牌无效"
}
# U-244（v1.53.26，验收 B1-3）：**逐引擎的代理覆盖** —— 「这个域到底会走哪条路由、为什么」。
#   由来（验收问题 F6，本机实测）：`MCPS_PROXY=socks5://…;api.github.com,github.com,raw.githubusercontent.com`
#   ⇒ **gitlab.com 不在白名单**，GitLab/GitLabBlobs 于是走直连，实测等满 12.1s / 17.1s 截止，
#   而 `-Doctor` 此前只说"代理状态三层"（环境变量/白名单域**个数**/系统代理），
#   **没有任何一处把『这个域被白名单排除了』说出来** —— 用户只能从"某源超时"反推，且极易误判成源侧故障。
#   口径（三条硬约束）：
#     ① **路由结论一律取自 Get-NetworkCandidates**（真实请求用的同一个函数）—— 本函数只做分类与展示。
#        绝不另写一份白名单解析：U-207/T1-2 的教训正是"Doctor 与选路各写一份 ⇒ 对同一域给出不同结论"。
#     ② **hosts 劫持单独一列，只提示不判红**：hosts 是机器级配置，且 socks5h 由远端解析 ⇒ 劫持未必生效，
#        把它混进"路由"会让结论变成猜测（本机 api.github.com、huggingface.co 都被指到 127.0.0.1）。
#     ③ 本函数**只读**：不写任何缓存/状态，不触发网络请求（Get-NetworkCandidates 只做候选枚举，不发包）。
function Resolve-ProxyCoverage {
    # 纯分类器：给「主机名 + 候选路由来源（有序）」⇒ 覆盖结论。门用它做真值表，Doctor 用它出表。
    param(
        [Parameter(Mandatory = $true)][string]$HostName,
        [string]$ProxySpec = $env:MCPS_PROXY,
        [AllowNull()][AllowEmptyString()][string]$NoProxySpec = $null,
        [string[]]$CandidateSources = @()
    )
    $h = ([string]$HostName).ToLowerInvariant()
    $spec = Get-McpsProxySpec -HostName $h -ProxySpec $ProxySpec
    $wl = if (-not $spec) { 'n/a' } elseif (-not $spec.HasWhitelist) { 'all' } elseif ($spec.Allowed) { 'allowed' } else { 'excluded' }
    $srcs = @($CandidateSources | Where-Object { $_ })
    $viaMcps = $srcs -contains 'MCPS_PROXY'
    $viaFallback = $srcs -contains 'MCPS_PROXY(fallback)'
    $viaEnv = @($srcs | Where-Object { $_ -in @('HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'all_proxy') }).Count -gt 0
    $viaSystem = $srcs -contains 'system'
    $viaDirect = $srcs -contains 'direct'
    # Route 回答"**实际**会发生什么"（按 Get-NetworkCandidates 的候选顺序取第一个非直连来源）；Whitelist 回答"为什么"。
    $route = if ($viaMcps) { 'mcps-proxy' } elseif ($viaFallback) { 'mcps-proxy-fallback' } elseif ($viaEnv) { 'env-proxy' } elseif ($viaSystem) { 'system' } elseif ($viaDirect) { 'direct' } else { 'none' }
    $noProxy = $false
    try { $noProxy = [bool](Test-NetworkNoProxy -Target ([uri]("https://" + $h + "/")) -Spec $NoProxySpec) } catch { }
    $excluded = ($wl -eq 'excluded' -and -not $viaMcps -and -not $viaFallback)
    # OnlyDirect：被排除之后**只剩直连**（连环境/系统代理都没有）。只有这种才值得报红 ——
    #   同一句"白名单未含本域"在白名单只覆盖 GitHub 的本机上有 20 行，全报红等于没报（cry wolf）。
    $onlyDirect = (-not $viaMcps -and -not $viaFallback -and -not $viaEnv -and -not $viaSystem)
    $note = ''
    if ($excluded) { $note = 'MCPS_PROXY 白名单未含本域 ⇒ 该代理被跳过（其余路由不可用时只能等满截止；MCPS_PROXY_FALLBACK=1 可临时放行）' }
    return [PSCustomObject]@{ Host = $h; Route = $route; Chain = ($srcs -join '→'); Whitelist = $wl; Excluded = [bool]$excluded; OnlyDirect = [bool]$onlyDirect; NoProxy = [bool]$noProxy; Note = $note }
}
function Get-DoctorProxyCoverage {
    # 采集器：逐注册引擎取 Host ⇒ 真实候选路由 ⇒ 分类；再附 hosts 列。返回 { Rows; Excluded; Hijacked }。
    param([string[]]$Engines)
    $rows = @()
    foreach ($e in @($script:_engineRegistry)) {
        if ($Engines -and ($Engines -notcontains [string]$e.Name)) { continue }
        $h = [string]$e.Host
        $dis = [bool](Test-EngineDisabled -Engine $e)
        if (-not $h) {
            $rows += [PSCustomObject]@{ Engine = [string]$e.Name; Host = ''; Route = 'n/a'; Chain = ''; Whitelist = 'n/a'; Excluded = $false; NoProxy = $false; Hijack = ''; Disabled = $dis; Note = '无网络端点（本地通道）' }
            continue
        }
        $cands = @()
        try { $cands = @(Get-NetworkCandidates -Target ([uri]("https://" + $h + "/")) | ForEach-Object { [string]$_.Source }) } catch { }
        $cov = Resolve-ProxyCoverage -HostName $h -CandidateSources $cands
        $ov = Get-HostsOverride -HostName $h
        # 只有 **loopback** 才算劫持：把域指到某个真实 IP 是合法的固定解析（U-194/Get-HostsHijackHint 同口径）。
        $hij = if ($ov -and $ov.Loopback) { [string]$ov.Ip } else { '' }
        $rows += [PSCustomObject]@{ Engine = [string]$e.Name; Host = $h; Route = $cov.Route; Chain = $cov.Chain; Whitelist = $cov.Whitelist; Excluded = $cov.Excluded; OnlyDirect = $cov.OnlyDirect; NoProxy = $cov.NoProxy; Hijack = $hij; Disabled = $dis; Note = $cov.Note }
    }
    $exHosts = @($rows | Where-Object { $_.Excluded } | ForEach-Object { [string]$_.Host } | Sort-Object -Unique)
    $hijHosts = @($rows | Where-Object { $_.Hijack } | ForEach-Object { [string]$_.Host } | Sort-Object -Unique)
    return [PSCustomObject]@{ Rows = @($rows); Excluded = @($exHosts); Hijacked = @($hijHosts) }
}
# R-3：Doctor 的 grep.app 429 双义分类（纯函数，允许本地注入响应体做负对照）。
function Resolve-DoctorGrep429 {
    param([AllowEmptyString()][string]$ResponseBody = '')
    $isVercel = ($ResponseBody -match 'Vercel Security Checkpoint')
    return [PSCustomObject]@{
        Engine = 'grep.app'; Endpoint = 'official MCP (mcp.grep.app tools/list)'; Reachable = (-not $isVercel); LatencyMs = $null
        Note = $(if ($isVercel) { 'Vercel 安全检查页（本 IP 长效 429，API 不可用；可用 MCPS_DISABLE=grep.app 显式跳过）' }
                 else { '429 限流（匿名配额用尽）；端点可达' })
    }
}
# U-100 D1（2026-09-29，预注册 reports/U-100-D1-预注册判据-2026-09-29.md）：主流程 S4「-Doctor 分支」逐字抽出为函数；
#   体内不含 exit（铁律 10），exit 0 留在守卫块调用点；函数不 return —— 原块的管道输出（-AsJson 的 JSON）就是 stdout 契约，调用点不得用 $null = 吞掉。
function Get-DoctorTokens {
    param([string]$VERSION)
    $tokens = @(
        # U-125（2026-09-28）：令牌粒度登记 —— MinScope = 本工具真正需要的最小权限（只读检索，不需要任何写权限）。
        [PSCustomObject]@{ Var = 'GITHUB_TOKEN'; Present = [bool]$env:GITHUB_TOKEN; NeededBy = 'GitHub 代码搜索(/search/code 强制认证), GitHub 仓库/限速'; MinScope = 'fine-grained PAT：Public repositories（read-only），无 repo 写权限；建议设到期日' }
        [PSCustomObject]@{ Var = 'GITLAB_TOKEN'; Present = [bool]$env:GITLAB_TOKEN; NeededBy = 'GitLab 代码搜索(scope=blobs), GitLab 仓库'; MinScope = 'read_api（只读）' }
        [PSCustomObject]@{ Var = 'GITEE_TOKEN';  Present = [bool]$env:GITEE_TOKEN;  NeededBy = 'Gitee 仓库(未设置则匿名低配额)'; MinScope = 'projects（只读）' }
        [PSCustomObject]@{ Var = 'SRC_TOKEN';    Present = [bool]$env:SRC_TOKEN;    NeededBy = 'Sourcegraph 公共搜索(可选)'; MinScope = 'user:read（可选）' }
        # v1.40.0（2026-10-17）：DeepSeek Search 为可选付费源（$0.75/千次成功请求）。**不主动探测**：
        #   Search 端点成功即计费，Doctor 不能为了验 key 花用户的钱 ⇒ Probe=skipped，失败在真实检索时显式上报（401/402/429 分类）。
        [PSCustomObject]@{ Var = 'DEEPSEEK_API_KEY'; Present = [bool]$env:DEEPSEEK_API_KEY; NeededBy = 'DeepSeek 网页搜索源(可选，付费；未配置则该源不进 Requested)'; MinScope = '仅 Search/Fetch 调用；无模型写权限' }
    )
    # U-125：到期登记表 —— MCPS_TOKEN_EXPIRES="GITHUB_TOKEN=2026-10-05;GITLAB_TOKEN=2026-12-31"（只读，不输出值）；GitHub 另可从 /user 响应头 github-authentication-token-expiration 自动取得。
    $tokenExpiryRegistry = @{}
    if ($env:MCPS_TOKEN_EXPIRES) {
        foreach ($kv in @($env:MCPS_TOKEN_EXPIRES -split '[;,]')) {
            $parts = $kv.Trim() -split '=', 2
            if ($parts.Count -eq 2 -and $parts[0].Trim()) { $tokenExpiryRegistry[$parts[0].Trim().ToUpper()] = $parts[1].Trim() }
        }
    }
    # v1.36.0 P0：令牌**有效性**校验——"存在"≠"可用"。
    # 背景（2026-09-10 实测）：.env 中残留失效的 ghp_* 令牌时 Doctor 仍报 Present=true，
    # 而 GitHub 仓库发现/代码搜索会因 401 静默返回 0 命中并被误判为可信 empty。
    # 改为对 2 个可校验令牌做一次轻量 /user 探测，输出 Valid/ProbeStatus 并计入 remoteBlocked。
    $tokenProbes = @{
        GITHUB_TOKEN = @{ Url = 'https://api.github.com/user';  Scheme = 'Bearer' }
        GITLAB_TOKEN = @{ Url = 'https://gitlab.com/api/v4/user'; Scheme = 'PRIVATE-TOKEN' }
    }
    foreach ($tk in $tokens) {
        Add-Member -InputObject $tk -NotePropertyName 'Valid' -NotePropertyValue $null -Force
        Add-Member -InputObject $tk -NotePropertyName 'Probe' -NotePropertyValue '' -Force
        Add-Member -InputObject $tk -NotePropertyName 'ExpiresAt' -NotePropertyValue '' -Force   # U-125：ISO 日期或空
        Add-Member -InputObject $tk -NotePropertyName 'DaysLeft' -NotePropertyValue $null -Force
        Add-Member -InputObject $tk -NotePropertyName 'HostsOverride' -NotePropertyValue '' -Force   # U-194：命中的 hosts 原始行（无命中为空）
        if (-not $tk.Present) { continue }
        if ($tokenExpiryRegistry.ContainsKey($tk.Var)) { $tk.ExpiresAt = $tokenExpiryRegistry[$tk.Var] }
        $spec = $tokenProbes[$tk.Var]
        if (-not $spec) { $tk.Probe = 'skipped'; continue }
        $val = [Environment]::GetEnvironmentVariable($tk.Var)
        if ([string]::IsNullOrWhiteSpace($val)) { $tk.Valid = $false; $tk.Probe = 'empty'; continue }
        try {
            $hdrs = @{ 'User-Agent' = "multi-code-platform-searcher/$VERSION" }
            if ($spec.Scheme -eq 'PRIVATE-TOKEN') { $hdrs['PRIVATE-TOKEN'] = $val } else { $hdrs['Authorization'] = "$($spec.Scheme) $val" }
            # v1.36.5（F-4）：改走 Invoke-ApiRequest（MaxAttempts=1）——复用 node --use-system-ca TLS 兜底，HTTPS 拦截代理下不再误报 unreachable
            $rsp = Invoke-ApiRequest -Uri $spec.Url -Headers $hdrs -TimeoutSec $script:Cfg.DoctorProbeSec -MaxAttempts 1 -DeadlineSec $script:Cfg.DoctorProbeSec -NodeDeadlineSec $script:Cfg.DoctorProbeSec
            $tk.Valid = ($rsp.StatusCode -ge 200 -and $rsp.StatusCode -lt 300)
            $tk.Probe = "HTTP $($rsp.StatusCode)"
            # U-125：GitHub 带到期日的令牌会在响应头返回 github-authentication-token-expiration（如 "2026-10-05 12:00:00 UTC"）；登记表未填时用它
            if ($tk.Var -eq 'GITHUB_TOKEN' -and -not $tk.ExpiresAt -and $rsp.Headers) {
                foreach ($hk in @($rsp.Headers.Keys)) { if ("$hk" -ieq 'github-authentication-token-expiration') { $tk.ExpiresAt = (@($rsp.Headers[$hk]) -join '').Trim() } }
            }
        }
        catch {
            $sc = ''
            try { $sc = [int]$_.Exception.Response.StatusCode } catch { }
            if (-not $sc -and "$_" -match 'HTTP (\d{3})') { $sc = $Matches[1] }
            if (-not $sc -and "$_" -match '\b(401|403)\b') { $sc = $Matches[1] }
            # v1.45.7（2026-10-20）：传输层失败不再一律叫 unreachable（分类见 ConvertFrom-TokenProbeFailure）。
            $tk.Probe = ConvertFrom-TokenProbeFailure -ErrorText "$_"
            # U-194（2026-10-21）：传输层失败 + hosts 把该域名指到回环 ⇒ 这不是"令牌/链路问题"，是本机 hosts 劫持。
            #   只改**诊断字段**，不改 Valid（仍然 null = 无法判定）。带原始行，报告可直接引用。
            $hij = Get-HostsHijackHint -Uri $spec.Url -Probe $tk.Probe
            if ($hij) { $tk.Probe = 'hosts_hijack'; $tk.HostsOverride = [string]$hij.Line }
            # v1.36.7：只有 401/403 能证明令牌无效；连不上/超时/5xx/429 等 ⇒ Valid=null（无法判定，先查链路）
            $tk.Valid = $(if ("$sc" -in @('401', '403')) { $false } else { $null })
        }
    }
    # U-125：到期换算 + ≤ Cfg.TokenExpiryWarnDays 天告警（已过期也告警；解析失败不告警但保留原文）
    $tokenExpiryWarnings = @()
    foreach ($tk in $tokens) {
        if (-not $tk.Present -or -not $tk.ExpiresAt) { continue }
        $expDt = [datetime]::MinValue
        $raw = ("$($tk.ExpiresAt)" -replace "\s*UTC$", '')
        if ([datetime]::TryParse($raw, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal, [ref]$expDt)) {
            $tk.ExpiresAt = $expDt.ToUniversalTime().ToString('yyyy-MM-dd')
            $tk.DaysLeft = [int][math]::Floor(($expDt.ToUniversalTime() - [datetime]::UtcNow).TotalDays)
            if ($tk.DaysLeft -lt 0) { $tokenExpiryWarnings += ('{0} 已于 {1} 到期（{2} 天前）——请轮换令牌并更新 .env' -f $tk.Var, $tk.ExpiresAt, (-$tk.DaysLeft)) }
            elseif ($tk.DaysLeft -le $script:Cfg.TokenExpiryWarnDays) { $tokenExpiryWarnings += ('{0} 将于 {1} 到期（剩 {2} 天，阈值 ≤{3} 天）——请提前轮换' -f $tk.Var, $tk.ExpiresAt, $tk.DaysLeft, $script:Cfg.TokenExpiryWarnDays) }
        }
    }
    [pscustomobject]@{ Tokens = @($tokens); TokenExpiryWarnings = @($tokenExpiryWarnings) }
}
# P1（2026-10-19）：**流式端点**的只取状态码探针。
#   为什么不能用 Invoke-ApiRequest：PS 7.6 的 `Invoke-WebRequest -TimeoutSec` 只是 `ConnectionTimeoutSeconds` 的别名
#   （`(Get-Command Invoke-WebRequest).Parameters['ConnectionTimeoutSeconds'].Aliases` 实测），`-OperationTimeoutSeconds`
#   对流式响应也不生效（实测 6s 设定仍读满 30s）。而 IWR 必须把响应体读完才返回 ⇒ SSE 探测被整条流拖住
#   （实测 Sourcegraph 探测 29.8s / 50.3s，TimeoutSec=6 形同虚设）。
#   curl 的 `--max-time` 是**总时长**硬截止；`-o NUL` 只取状态码 ⇒ 响应头到达即判可达，不等流结束。
#   路由沿用 Get-NetworkRoute（与主请求同一决策，含 MCPS_PROXY 白名单/系统代理/直连），不另起一套判断。
function Invoke-DoctorStreamProbe {
    param([string]$Uri, [string]$UserAgent, [int]$TimeoutSec)
    $curl = Get-Command -Name @('curl.exe', 'curl') -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    $route = Get-NetworkRoute -Uri $Uri -BudgetMs ([Math]::Max(500, [int]($TimeoutSec * 1000 / 4)))
    if ($route.Kind -eq 'unavailable') { return [PSCustomObject]@{ Http = $null; Reason = 'network-unavailable（代理/直连均不可达）' } }
    if (-not $curl) { return [PSCustomObject]@{ Http = $null; Reason = 'curl 不可用（流式端点需要总时长硬截止）' } }
    $sink = if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) { 'NUL' } else { '/dev/null' }
    $maxSec = [Math]::Max(2, $TimeoutSec)
    $cargs = @('-s', '-o', $sink, '-w', '%{http_code}', '--max-time', "$maxSec", '-A', $UserAgent)
    if ($route.Kind -eq 'socks') { $cargs += '--socks5-hostname', ($route.ProxyUrl -replace '^socks5h?://', '') }
    elseif ($route.Kind -eq 'http') { $cargs += '--proxy', $route.ProxyUrl }
    else { $cargs += '--noproxy', '*' }
    $cargs += $Uri
    $raw = (& $curl.Source @cargs 2>$null | Select-Object -Last 1)
    $rc = $LASTEXITCODE
    # 退出码 28 = 到 --max-time 被截断：对**流式**端点这是正常收尾（状态码已拿到即算成功）
    if ("$raw" -match '^[1-5][0-9]{2}$') { return [PSCustomObject]@{ Http = [int]$raw; Reason = $null } }
    return [PSCustomObject]@{ Http = $null; Reason = "curl 未拿到状态码 (rc=$rc)" }
}
function Get-DoctorRemoteCodeHealth {
    param([string]$VERSION, $ghTok, $glTok)
    # v1.23.0 #5：远程代码证据引擎健康 ping（grep.app 官方 MCP / Sourcegraph streaming 匿名可达性）
    # 探测不实搜关键词，只验证端点可达；node 侧最多 5 秒且 PS 侧仅一次 attempt。
    # v1.38.0（U-168）：grep.app 改为**探与引擎同款的 MCP 端点**（POST JSON-RPC `tools/list`，不消耗检索配额），
    #   端点取自 `Cfg.GrepAppMcpUrl`（单一事实源）。旧 REST /api/search 探测已删除——它探的是引擎早就不走的路径，
    #   正是 `remoteEngines` 与 `remoteCodeSources` 自相矛盾的根因。
    $remoteEngines = @()
    $grepprobeUrl = [string]$script:Cfg.GrepAppMcpUrl
    $grepprobeHdr = @{ 'User-Agent' = "multi-code-platform-searcher/$VERSION"; 'Content-Type' = 'application/json'; 'Accept' = 'application/json, text/event-stream' }
    $grepprobeBody = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
    try {
        $t0 = [System.Diagnostics.Stopwatch]::StartNew()
        # P1（2026-10-19）：-DeadlineSec = 断开「路由探活 + 主请求 + node 兜底」串联超时（旧：TimeoutSec 只约束中段）。
        $probe = Invoke-ApiRequest -Uri $grepprobeUrl -Headers $grepprobeHdr -Method POST -Body $grepprobeBody -TimeoutSec $script:Cfg.DoctorProbeSec -DeadlineSec $script:Cfg.DoctorProbeSec -MaxAttempts 1 -NodeDeadlineSec 5
        $t0.Stop()
        # 判据收紧：**必须真拿到 MCP 工具列表**才算可达——只看 HTTP 200 会把中间盒/占位页误判成"引擎可用"。
        $okBody = ([string]$probe.Content) -match '"tools"|searchGitHub'
        $remoteEngines += [PSCustomObject]@{
            Engine    = 'grep.app'
            Endpoint  = 'official MCP (mcp.grep.app tools/list)'
            Reachable = [bool]$okBody
            LatencyMs = [int]$t0.Elapsed.TotalMilliseconds
            Note      = $(if ($okBody) { $null } else { 'HTTP 2xx 但响应体不含 MCP tools 列表（疑似中间盒/占位页），判不可用' })
        }
    } catch {
        if (("$_") -match '429') {
            # 429 可能是 MCP 侧限流；node 读取真实响应体再判（保留 Vercel 分支以兼容历史响应与既有负对照测试）
            $probeBody = ''
            try {
                $ne = $script:NodeExePath
                if (-not $ne) { $ne = (Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source }
                if ($ne -and $script:NodeEnginePath -and (Test-Path -LiteralPath $script:NodeEnginePath -PathType Leaf)) {
                    $tmp = [System.IO.Path]::GetTempFileName()
                    try {
                        $null = & $ne '--use-system-ca' $script:NodeEnginePath '-o' $tmp '-d' '4000' $grepprobeUrl "User-Agent:multi-code-platform-searcher/$VERSION" 2>&1
                        if (Test-Path -LiteralPath $tmp) { $probeBody = [System.IO.File]::ReadAllText($tmp) }
                    } finally { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
                }
            } catch { }
            $remoteEngines += Resolve-DoctorGrep429 -ResponseBody $probeBody
        } else {
            $remoteEngines += [PSCustomObject]@{ Engine = 'grep.app'; Endpoint = 'official MCP (mcp.grep.app tools/list)'; Reachable = $false; LatencyMs = $null; Note = ("探测失败: " + ("$_") -replace '\s+', ' ') }
        }
    }
    try {
        $t1 = [System.Diagnostics.Stopwatch]::StartNew()
        $sgUri = "https://sourcegraph.com/.api/search/stream?q=$([uri]::EscapeDataString('context:global __mcps_probe__'))&v=V3&t=&display=1"
        # P1（2026-10-19）：同一端点，但用只取状态码的硬截止探针（IWR 会读完整条 SSE 流 ⇒ 探测 30–50s）。
        $sg = Invoke-DoctorStreamProbe -Uri $sgUri -UserAgent "multi-code-platform-searcher/$VERSION" -TimeoutSec $script:Cfg.DoctorProbeSec
        $t1.Stop()
        $sgCode = $sg.Http
        # 判据不变：2xx = 可达；429 = 可达但限流（不算不可达）；无状态码/其余 = 不可达
        $sgReachable = [bool](($null -ne $sgCode -and $sgCode -ge 200 -and $sgCode -lt 300) -or $sgCode -eq 429)
        $remoteEngines += [PSCustomObject]@{ Engine = 'Sourcegraph'; Endpoint = 'official streaming (/.api/search/stream)'; Reachable = $sgReachable; LatencyMs = [int]$t1.Elapsed.TotalMilliseconds; Note = $(if ($sgReachable) { $null } else { $(if ($sg.Reason) { $sg.Reason } else { "HTTP $sgCode" }) }) }
    } catch {
        $remoteEngines += [PSCustomObject]@{ Engine = 'Sourcegraph'; Endpoint = 'official streaming (/.api/search/stream)'; Reachable = $false; LatencyMs = $null; Note = ("探测失败: " + ("$_") -replace '\s+', ' ') }
    }
    # T1-2：只对「不可达且未走已配置的白名单代理」提出一致性提示；HTTP 403 / Vercel 429 不是白名单问题。
    $proxyConsistency = @()
    foreach ($re in $remoteEngines) {
        $domain = if ($re.Engine -eq 'grep.app') { 'grep.app' } else { 'sourcegraph.com' }
        $advice = Get-DoctorProxyAdvice -Domain $domain -Reachable ([bool]$re.Reachable) -Note ([string]$re.Note)
        if ($advice) {
            $proxyConsistency += [PSCustomObject]@{ Domain = $domain; Advice = $advice }
            if ($re.Note) { $re.Note += '；' + $advice } else { $re.Note = $advice }
        }
    }
    # v1.45.7：timeout / tls-error 同样「没探通」，代理建议不能只挂在 unreachable 上（否则改了分档就丢建议）
    if ($glTok.Present -and $glTok.Probe -in @('unreachable', 'timeout', 'tls-error')) {
        $advice = Get-DoctorProxyAdvice -Domain 'gitlab.com' -Reachable:$false -Note ''
        if ($advice) { $proxyConsistency += [PSCustomObject]@{ Domain = 'gitlab.com'; Advice = $advice } }
    }
    if ($ghTok.Present -and $ghTok.Probe -in @('unreachable', 'timeout', 'tls-error')) {
        $advice = Get-DoctorProxyAdvice -Domain 'api.github.com' -Reachable:$false -Note ''
        if ($advice) { $proxyConsistency += [PSCustomObject]@{ Domain = 'api.github.com'; Advice = $advice } }
    }
    [pscustomobject]@{ RemoteEngines = @($remoteEngines); ProxyConsistency = @($proxyConsistency) }
}
# P1（2026-10-19）：探针「结果/异常 → 状态」分类**单源**（串行与并行两条路径共用）。
#   为什么必须单源：A-11 的 M1 负例正是「只认 429 字面量、丢掉 TooLong 文案」这类回潮 ——
#   两条路径各写一份判定 ⇒ 修一条漏一条，同一份 Doctor 里自相打架。
# 状态口径：ok=2xx；rate-limited=429 / Retry-After 超上限；needs-key=401/403 且该源要 key；
#   timeout=预算耗尽或传输超时（**不冒充 unreachable**：没拿到响应 ≠ 主机不可达）；unreachable=其余传输失败。
function ConvertFrom-ResearchProbeOutcome {
    param($Result, $ErrorText, $Key, [bool]$KeyPresent)
    $status = 'unreachable'; $code = $null; $note = $null
    if ($Result) {
        $code = [int]$Result.StatusCode
        if ($code -ge 200 -and $code -lt 300) { $status = 'ok' }
        else { $note = "HTTP $code（非 2xx）" }
        return [PSCustomObject]@{ Status = $status; Http = $code; Note = $note }
    }
    $msg = "$ErrorText"
    # 批次2（2026-10-09）：限流识别必须覆盖「超大 Retry-After 被快速失败」这条形状。
    #   实测 OpenAlex：端点回 429 + Retry-After: 30805s(≈8.6h) ⇒ Invoke-ApiRequest 走 TooLong 分支
    #   抛「限流等待过长: ... (Retry-After 30805s)」，该消息**不含 429** ⇒ 旧匹配落空 ⇒
    #   探针把**限流**报成 **unreachable**（链路故障），与判据「429 = 可达但受限（不算不可达）」直接矛盾。
    if ($msg -match '\b429\b|rate.?limit|限流等待过长') { $status = 'rate-limited'; $code = 429 }
    elseif ($msg -match '\b(401|403)\b' -and $Key) { $status = 'needs-key'; $note = ("需要 {0}（{1}）" -f $Key, $(if ($KeyPresent) { '已配置但被拒，检查有效性' } else { '未配置' })) }
    else {
        $flat = ($msg -replace '\s+', ' ').Trim()
        $note = if ($flat.Length -gt 120) { $flat.Substring(0, 120) } else { $flat }
        # timeout 是**独立状态**：没拿到响应 ≠ 主机不可达（旧代码把它混进 unreachable，等于把"没证据"当"证据"）
        if ($msg -match '探测预算耗尽|已超时|超时|timed?\s?out') { $status = 'timeout' }
    }
    return [PSCustomObject]@{ Status = $status; Http = $code; Note = $note }
}
# P1（2026-10-19）：研究探针批量执行器。并行 = 每源一个 **runspace**（同进程，不是新进程）；
#   串行 = 唯一路径（MCPS_DOCTOR_PARALLEL=0 时，供 A-11 这类**在主 runspace 里打桩**的夹具使用）。
#   两条路径走同一个 Invoke-ApiRequest 契约与同一个分类器，唯一差别是并发度。
#   -TimeoutSec 同时作为**请求层总预算**（-DeadlineSec）与 node 兜底截止：单源上界 ≈ 路由探活 + 主请求 + 兜底。
function Invoke-ResearchProbeBatch {
    param($Probes, [int]$TimeoutSec, [string]$VERSION, [switch]$Disabled)
    $rows = @()
    if ($Disabled) {
        # 跳过 ≠ 不存在：逐源出 not-probed 行 —— 否则「没探」与「探了但全挂」在报告里长得一模一样。
        foreach ($p in $Probes) {
            $rows += [PSCustomObject]@{ Source = [string]$p.Source; Status = 'not-probed'; Http = $null; LatencyMs = $null; Key = $p.Key; KeyPresent = $false; Slow = [bool]$p.Slow; Note = '已按 MCPS_DOCTOR_RESEARCH=0 跳过'; Kind = $(if ($p.Kind) { [string]$p.Kind } else { 'engine' }); Engine = $p.Engine }
        }
        return @($rows)
    }
    # ---- 1) 组装探测定义（key 注入口径与引擎一致：header 优先、次 query；探针只取 1 条，不搜真实关键词）----
    $defs = @()
    foreach ($p in $Probes) {
        $hdrs = @{ 'User-Agent' = "multi-code-platform-searcher/$VERSION (doctor probe)" }
        $url = $p.Url
        $keyPresent = $false
        if ($p.Key) {
            $kv = [Environment]::GetEnvironmentVariable($p.Key)
            $keyPresent = -not [string]::IsNullOrWhiteSpace($kv)
            if ($keyPresent) {
                if ($p.KeyHeader) { $hdrs[$p.KeyHeader] = ("{0}{1}" -f $p.KeyPrefix, $kv) }
                elseif ($p.KeyQuery) { $url += ("&{0}={1}" -f $p.KeyQuery, [uri]::EscapeDataString($kv)) }
            }
        }
        $defs += [PSCustomObject]@{ Source = [string]$p.Source; Url = $url; Headers = $hdrs; Key = $p.Key; KeyPresent = $keyPresent; Slow = [bool]$p.Slow; Kind = $(if ($p.Kind) { [string]$p.Kind } else { 'engine' }); Engine = $p.Engine }
    }
    $parallel = -not ($env:MCPS_DOCTOR_PARALLEL -and $env:MCPS_DOCTOR_PARALLEL.Trim() -eq '0')
    if (-not $parallel -or $defs.Count -le 1) {
        foreach ($d in $defs) {
            # Slow 标记（如 Maven Central：实测偶发"连上不回包"）给双倍预算 —— 与 Cfg.SlowSourceTimeoutSec 同一口径。
            $tmo = [int]$TimeoutSec * $(if ($d.Slow) { 2 } else { 1 })
            $t0 = [System.Diagnostics.Stopwatch]::StartNew(); $res = $null; $err = $null
            try { $res = Invoke-ApiRequest -Uri $d.Url -Headers $d.Headers -TimeoutSec $tmo -MaxAttempts 1 -DeadlineSec $tmo -NodeDeadlineSec $tmo }
            catch { $err = "$_" }
            $t0.Stop()
            $c = ConvertFrom-ResearchProbeOutcome -Result $res -ErrorText $err -Key $d.Key -KeyPresent $d.KeyPresent
            $rows += [PSCustomObject]@{ Source = $d.Source; Status = $c.Status; Http = $c.Http; LatencyMs = [int]$t0.Elapsed.TotalMilliseconds; Key = $d.Key; KeyPresent = $d.KeyPresent; Slow = $d.Slow; Note = $c.Note; Kind = $d.Kind; Engine = $d.Engine }
        }
        return @($rows)
    }
    # ---- 2) 并行：注入 HTTP 层闭包 + 分类器文本，结果只带判定字段，源元数据在宿主侧回填 ----
    $maxPool = [Math]::Max(1, [int]$script:Cfg.DoctorParallelism)
    if ($env:MCPS_DOCTOR_PARALLEL_MAX) { try { $maxPool = [Math]::Max(1, [Math]::Min(16, [int]$env:MCPS_DOCTOR_PARALLEL_MAX)) } catch { } }
    $pool = $null
    try {
        $inject = @{ VERSION = $VERSION; Cfg = $script:Cfg; AsJson = $true; NodeEnginePath = $script:NodeEnginePath; NodeExePath = $script:NodeExePath; ProxyMode = $script:ProxyMode; _sysProxyMode = $script:_sysProxyMode; _networkRoutes = $script:_networkRoutes; _networkFailures = $script:_networkFailures; _networkHttpResponses = $script:_networkHttpResponses; _networkDeadHosts = $script:_networkDeadHosts; _proxyBreaker = $script:_proxyBreaker }
        $defsText = @()
        foreach ($fn in (Get-HttpLayerClosure)) { if (Test-Path "function:$fn") { $defsText += "function $fn { $((Get-Item "function:$fn").Definition) }" } }
        if (Test-Path 'function:ConvertFrom-ResearchProbeOutcome') { $defsText += "function ConvertFrom-ResearchProbeOutcome { $((Get-Item 'function:ConvertFrom-ResearchProbeOutcome').Definition) }" }
        $pool = [runspacefactory]::CreateRunspacePool(1, [Math]::Min($maxPool, $defs.Count))
        $pool.ApartmentState = 'MTA'
        $pool.Open()
        $handles = @()
        foreach ($d in $defs) {
            $ps = [powershell]::Create()
            $ps.RunspacePool = $pool
            [void]$ps.AddScript({
                param($Defs, $D, $Inject, $Tmo)
                foreach ($t in $Defs) { . ([scriptblock]::Create($t)) }
                foreach ($k in $Inject.Keys) { Set-Variable -Name $k -Value $Inject[$k] }
                $t0 = [System.Diagnostics.Stopwatch]::StartNew(); $res = $null; $err = $null
                try { $res = Invoke-ApiRequest -Uri $D.Url -Headers $D.Headers -TimeoutSec $Tmo -MaxAttempts 1 -DeadlineSec $Tmo -NodeDeadlineSec $Tmo }
                catch { $err = "$_" }
                $t0.Stop()
                $c = ConvertFrom-ResearchProbeOutcome -Result $res -ErrorText $err -Key $D.Key -KeyPresent $D.KeyPresent
                [PSCustomObject]@{ Status = $c.Status; Http = $c.Http; LatencyMs = [int]$t0.Elapsed.TotalMilliseconds; Note = $c.Note }
            }).AddArgument($defsText).AddArgument($d).AddArgument($inject).AddArgument([int]$TimeoutSec * $(if ($d.Slow) { 2 } else { 1 }))
            $handles += [PSCustomObject]@{ Def = $d; PS = $ps; Handle = $ps.BeginInvoke() }
        }
        foreach ($h in $handles) {
            $out = @()
            try { $out = @($h.PS.EndInvoke($h.Handle)) } catch { $out = @() }
            finally { try { $h.PS.Dispose() } catch { } }
            $r = $out | Where-Object { $_ -and $_.PSObject.Properties['Status'] } | Select-Object -Last 1
            if ($r) {
                $rows += [PSCustomObject]@{ Source = $h.Def.Source; Status = $r.Status; Http = $r.Http; LatencyMs = $r.LatencyMs; Key = $h.Def.Key; KeyPresent = $h.Def.KeyPresent; Slow = $h.Def.Slow; Note = $r.Note; Kind = $h.Def.Kind; Engine = $h.Def.Engine }
            } else {
                # 池内异常（如 dot-source 失败）不得消失：如实记 not-probed，不猜 ok/不可达。
                $rows += [PSCustomObject]@{ Source = $h.Def.Source; Status = 'not-probed'; Http = $null; LatencyMs = $null; Key = $h.Def.Key; KeyPresent = $h.Def.KeyPresent; Slow = $h.Def.Slow; Note = '池内探针未返回结果（runspace 异常）'; Kind = $h.Def.Kind; Engine = $h.Def.Engine }
            }
        }
    } finally { if ($pool) { try { $pool.Close(); $pool.Dispose() } catch { } } }
    return @($rows)
}
function Get-DoctorResearchHealth {
    param([string]$VERSION)
    # ---------- U-13（T2-6）/ U-26（T3-3）/ U-27（T3-4）：研究信源健康 + 关键位次 + 代理状态 ----------
    # 判据先定（宿主要求"先定误报与性能判据再动手"）：
    #   可达 = 2xx；429 = 可达但受限（不算不可达，避免把配额误报成链路故障）；401/403 且该源需 key = 可达但需 key；
    #   其余（超时/连接失败/5xx）= 不可达。每源 MaxAttempts=1、超时 = min(DoctorProbeSec, DoctorResearchProbeSec)，
    #   P1（2026-10-19）起 **14 源并行**（每源一个 runspace，池上限 MCPS_DOCTOR_PARALLEL_MAX 默认 8）：
    #     串行最坏 = 源数 × 超时（14 × 4s = 56s，实测 NuGet 单源 11.5s 就拉满整轮）；并行最坏 ≈ 单源上界 × ⌈源数/池⌉。
    #     单源上界由请求层总预算（-DeadlineSec = 同一个 4s）封顶，路由探活/主请求/兜底三段共享它。
    #   MCPS_DOCTOR_RESEARCH=0 可跳过（逐源仍出 not-probed 行）；MCPS_DOCTOR_PARALLEL=0 退回串行。探测不搜真实关键词。
    # 批次2（2026-10-09）：**探针集与引擎集对齐**（方案 §四-1/§四-3）。
    #   病灶：研究引擎已 10 个（HF / Packages[npm·crates.io·Maven] / RubyGems / NuGet / DockerHub /
    #   arXiv / OpenAlex / MCPRegistry / HackerNews / SE，见引擎注册表），探针却只有 9 项，且两头都不齐：
    #     ① **端点不同源**：npm 探针探 api.npms.io，而 npm 引擎早已改用 registry.npmjs.org
    #        ⇒ npms.io 挂了 Doctor 报 npm 不可达、引擎照常；npms.io 活着而 npmjs 挂了则反过来。
    #     ② **引擎无探针**：RubyGems / NuGet / DockerHub / OpenAlex / HackerNews 五个源**完全没探针**
    #        ⇒ Doctor 说"研究信源健康"却不覆盖它们。
    #     ③ **探针有、引擎无**：Semantic Scholar（批次 5 才接入）与 Glama（Doctor 专有 MCP 目录）
    #        ⇒ 不加标注会被误当成引擎口径。
    #   Kind = 'engine' → 该探针与某研究引擎**同源**（Engine 字段注明对应引擎名，可据此断言一致性）；
    #   Kind = 'extra'  → 引擎集里没有它（附加信源），单列。
    #   同源口径：端点/主机与引擎**逐字一致**，仅分页参数收敛为 1（探针只验可达，不取数据）。
    $researchProbes = @(
        @{ Source = 'Semantic Scholar'; Key = 'S2_API_KEY';    Kind = 'extra';  Url = 'https://api.semanticscholar.org/graph/v1/paper/search?query=__mcps_probe__&limit=1'; KeyHeader = 'x-api-key' }
        @{ Source = 'MCP Registry';     Key = $null;           Kind = 'engine'; Url = 'https://registry.modelcontextprotocol.io/v0/servers?limit=1'; Engine = 'MCPRegistry' }
        @{ Source = 'Glama';            Key = 'GLAMA_API_KEY'; Kind = 'extra';  Url = 'https://glama.ai/api/mcp/v1/servers?first=1'; KeyHeader = 'Authorization'; KeyPrefix = 'Bearer ' }
        @{ Source = 'Stack Exchange';   Key = 'SE_KEY';        Kind = 'engine'; Url = 'https://api.stackexchange.com/2.3/info?site=stackoverflow'; KeyQuery = 'key'; Engine = 'SE' }
        @{ Source = 'arXiv';            Key = $null;           Kind = 'engine'; Url = 'https://export.arxiv.org/api/query?search_query=all:__mcps_probe__&max_results=1'; Engine = 'arXiv' }
        @{ Source = 'Hugging Face';     Key = $null;           Kind = 'engine'; Url = 'https://huggingface.co/api/models?limit=1'; Engine = 'HF' }
        @{ Source = 'npm';              Key = $null;           Kind = 'engine'; Url = 'https://registry.npmjs.org/-/v1/search?text=__mcps_probe__&size=1'; Engine = 'Npm' }
        @{ Source = 'crates.io';        Key = $null;           Kind = 'engine'; Url = 'https://crates.io/api/v1/crates?q=__mcps_probe__&per_page=1'; Engine = 'Crates' }
        @{ Source = 'Maven Central';    Key = $null;           Kind = 'engine'; Url = 'https://search.maven.org/solrsearch/select?q=__mcps_probe__&rows=1&wt=json'; Slow = $true; Engine = 'Maven' }
        @{ Source = 'RubyGems';         Key = $null;           Kind = 'engine'; Url = 'https://rubygems.org/api/v1/search.json?query=__mcps_probe__&per_page=1'; Engine = 'RubyGems' }
        @{ Source = 'NuGet';            Key = $null;           Kind = 'engine'; Url = 'https://azuresearch-usnc.nuget.org/query?q=__mcps_probe__&take=1'; Engine = 'NuGet' }
        @{ Source = 'Packagist';        Key = $null;           Kind = 'engine'; Url = 'https://packagist.org/search.json?q=__mcps_probe__&per_page=1'; Engine = 'Packagist' }
        @{ Source = 'DockerHub';        Key = $null;           Kind = 'engine'; Url = 'https://hub.docker.com/v2/search/repositories/?query=__mcps_probe__&page_size=1'; Engine = 'DockerHub' }
        @{ Source = 'OpenAlex';         Key = $null;           Kind = 'engine'; Url = 'https://api.openalex.org/works?search=__mcps_probe__&per-page=1'; Engine = 'OpenAlex' }
        @{ Source = 'Hacker News';      Key = $null;           Kind = 'engine'; Url = 'https://hn.algolia.com/api/v1/search?query=__mcps_probe__&tags=story&hitsPerPage=1'; Engine = 'HackerNews' }
    )
    $researchHealth = @()
    $doResearch = -not ($env:MCPS_DOCTOR_RESEARCH -and $env:MCPS_DOCTOR_RESEARCH.Trim() -eq '0')
    $rpTimeout = [Math]::Min([int]$script:Cfg.DoctorProbeSec, [int]$script:Cfg.DoctorResearchProbeSec)
    # P1（2026-10-19）：14 源**并行**探测（此前串行，单源超时 4s ⇒ 最坏 56s，实测 NuGet 单源 11.5s 拉满整轮）。
    #   跳过时也逐源出 not-probed 行（见 Invoke-ResearchProbeBatch 头注）；探针口径/判据不变。
    $researchHealth = @(Invoke-ResearchProbeBatch -Probes $researchProbes -TimeoutSec $rpTimeout -VERSION $VERSION -Disabled:(-not $doResearch))
    # U-194（2026-10-21）：研究探针的**hosts 劫持**补充诊断。只在传输层失败（timeout/unreachable）时判：
    #   上游真回了 401/429 就不改名（那是真实回答）。加两列而不改 Status —— 既有断言/使用方仍按 Status 读。
    $probeUrlBySource = @{}
    foreach ($p in $researchProbes) { $probeUrlBySource[[string]$p.Source] = [string]$p.Url }
    $researchHealth = @($researchHealth | ForEach-Object {
        $row = $_
        $ov = $null
        if ([string]$row.Status -in @('timeout', 'unreachable', 'error')) {
            $u = $probeUrlBySource[[string]$row.Source]
            if ($u) { $ov = Get-HostsHijackHint -Uri $u -Probe '' }
        }
        $row | Add-Member -NotePropertyName 'Probe' -NotePropertyValue $(if ($ov) { 'hosts_hijack' } else { '' }) -Force
        $row | Add-Member -NotePropertyName 'HostsOverride' -NotePropertyValue $(if ($ov) { [string]$ov.Line } else { '' }) -Force
        if ($ov) { $row.Note = ('{0}（hosts 指向 {1}：{2}）' -f $row.Note, $ov.Ip, $ov.Line) }
        $row
    })
    # N-17：GitHub code search 废弃头探测（仅在有 GITHUB_TOKEN 时探，单次；不搜真实关键词）
    $ghCodeDeprecation = $null
    if ($env:GITHUB_TOKEN -and $doResearch) {
        try {
            $ghProbe = Invoke-ApiRequest -Uri 'https://api.github.com/search/code?q=__mcps_probe__+repo:github/gitignore&per_page=1' -Headers @{ 'Authorization' = "Bearer $($env:GITHUB_TOKEN)"; 'Accept' = 'application/vnd.github+json'; 'User-Agent' = "multi-code-platform-searcher/$VERSION (doctor probe)" } -TimeoutSec $rpTimeout -MaxAttempts 1 -DeadlineSec $rpTimeout -NodeDeadlineSec $rpTimeout
            $ghCodeDeprecation = [PSCustomObject]@{ Http = [int]$ghProbe.StatusCode; Deprecation = (Get-HeaderValue -Headers $ghProbe.Headers -Name 'Deprecation'); Sunset = (Get-HeaderValue -Headers $ghProbe.Headers -Name 'Sunset'); Note = $null; Probe = ''; HostsOverride = '' }
        } catch {
            $ghErr = (("$_") -replace '\s+', ' ')
            $ghHij = Get-HostsHijackHint -Uri 'https://api.github.com/search/code' -Probe ''
            $ghCodeDeprecation = [PSCustomObject]@{
                Http          = $null
                Deprecation   = $null
                Sunset        = $null
                Note          = $ghErr.Substring(0, [Math]::Min(120, $ghErr.Length))
                Probe         = $(if ($ghHij) { 'hosts_hijack' } else { 'error' })   # U-194：传输层失败要区分"hosts 劫持"与"其他错误"
                HostsOverride = $(if ($ghHij) { [string]$ghHij.Line } else { '' })
            }
        }
    }
    # U-193（2026-10-21）：**没探到 ≠ 未废弃**。Http=null（探针超时/预算耗尽）时传 0 ⇒ Lifecycle=unknown，
    #   不再用空头推出 State=active / Deprecated=false（那是用"没证据"断言"没有废弃"）。
    if ($ghCodeDeprecation) {
        $lc = Get-EndpointLifecycle -Deprecation $ghCodeDeprecation.Deprecation -Sunset $ghCodeDeprecation.Sunset -Http ([int]$ghCodeDeprecation.Http)
        $ghCodeDeprecation | Add-Member -NotePropertyName Lifecycle -NotePropertyValue $lc -Force
    }   # R94-E
    [pscustomobject]@{ ResearchHealth = @($researchHealth); ResearchProbeSkipped = (-not $doResearch); GHCodeDeprecation = $ghCodeDeprecation }
}
# A-11（2026-10-11，任务书 §3 批 A）：Doctor 单列「限流源」—— 把同一份 Doctor 里三族探针各自散落的 429 迹象
#   （研究信源 Status=rate-limited / 远程代码引擎 Note 含 429 / 令牌探测 Probe=HTTP 429）收拢成一张并列于
#   remoteCodeSources 的表，调用方不必逐表翻 Note 才知道「哪些源此刻在被限流」。
#   ★边界（如实记账）：这是**单次探测**的快照（每源 1 次），不是跨次频率；「OpenAlex 8 查 2 限流」那类读数属
#   审计台的重复采样，本函数不持久化任何状态（Doctor 不写盘）。纯函数：输入三族探针结果，输出可为空数组。
function Get-DoctorDeadlinePolicy {
    # v1.47.5（P2-7 的可观测面）：一屏看出"每个源实际等多久、这个数从哪来"。
    #   理由：`EngineDeadlineByEngine`（表）→ `MultiModeTimeScale`（-Auto）→ `EngineHardCapSec`（取 min）
    #   → `MCPS_ENGINE_DEADLINE`（显式覆盖）四层叠加后，"为什么 HF 只等 8s / 为什么 Packages 表里 28 实际 10"
    #   此前只能读代码。实测最容易误判的一条：表里 28/29/26 全被硬上限 10 夹住。
    #   ★数字一律来自 Get-EngineDeadlineSec（与真实执行同源）；本函数只**标注来源**，不重算、不复制公式
    #     （复制一份就是 T1-2 那类"两处对同一件事给不同结论"的翻版）。
    #   Source 取值：table=逐源表 / default=调用方默认 / cap=被硬上限夹 / cap-or-scale=-Auto 下倍数或上限
    #     / env=MCPS_ENGINE_DEADLINE 显式覆盖 / off=0（关闭单源截止）
    $byEng = $script:Cfg.EngineDeadlineByEngine
    $names = @()
    $kindOf = @{}
    try {
        $reg = @($script:_engineRegistry)
        $names = @($reg | ForEach-Object { [string]$_.Name } | Where-Object { $_ } | Sort-Object -Unique)
        foreach ($e in $reg) { if ($e -and $e.Name) { $kindOf[[string]$e.Name] = [string]$e.Kind } }
    } catch { }
    if (-not $names) { $names = @($byEng.Keys | Sort-Object) }
    # v1.47.6：默认值必须按**路径**取 —— 池给 repo 传 EngineDeadlineRepoSec=29、给 code 传 17、research 传 17。
    #   上一版一律用 research 的 17，导致 repo 引擎的 TableSeconds 标错（虽然被 cap 夹后 Seconds 恰好一样）。
    $pathDefault = @{
        repo     = [int]$script:Cfg.EngineDeadlineRepoSec
        code     = [int]$script:Cfg.EngineDeadlineCodeSec
        research = [int]$script:Cfg.EngineDeadlineSec
    }
    $rows = @()
    foreach ($n in $names) {
        $kind = if ($kindOf.ContainsKey($n) -and $pathDefault.ContainsKey($kindOf[$n])) { $kindOf[$n] } else { 'research' }
        $base = [int]$pathDefault[$kind]
        $src = 'default'
        if ($byEng -is [hashtable] -and $byEng.ContainsKey($n) -and [int]$byEng[$n] -gt 0) { $base = [int]$byEng[$n]; $src = 'table' }
        $final = Get-EngineDeadlineSec -DeadlineSec $base -EngineName $n
        $ov = Get-EngineDeadlineOverride -EngineName $n
        if ($null -ne $ov) { $src = 'env' }
        elseif ([int]$final -le 0) { $src = 'off' }
        elseif ([int]$final -ne $base) { $src = if ($Auto) { 'cap-or-scale' } else { 'cap' } }
        $rows += [PSCustomObject]@{ Engine = $n; Seconds = [int]$final; Source = $src; TableSeconds = [int]$base }
    }
    # v1.47.7：把"被夹住了怎么办"直接写在输出里 —— 两个受支持的口子，不要让人去翻代码。
    $cappedN = @($rows | Where-Object { $_.Source -eq 'cap' -or $_.Source -eq 'cap-or-scale' }).Count
    $advice = ''
    if ($cappedN -gt 0) {
        $advice = '部分源被单源硬上限夹住：要更长的等待，二选一 —— MCPS_ENGINE_HARD_CAP_SEC=0（全局放开上限，仍受逐源表约束）或 MCPS_ENGINE_DEADLINE="HF=30"（逐源显式覆盖，且不被上限夹）'
    }
    return [PSCustomObject]@{
        Auto                = [bool]$Auto
        DefaultSec          = [int]$script:Cfg.EngineDeadlineSec
        PathDefaults        = [PSCustomObject]@{ Repo = [int]$script:Cfg.EngineDeadlineRepoSec; Code = [int]$script:Cfg.EngineDeadlineCodeSec; Research = [int]$script:Cfg.EngineDeadlineSec }
        HardCapSec          = [int]$script:Cfg.EngineHardCapSec
        HardCapMultiModeSec = [int]$script:Cfg.EngineHardCapMultiModeSec
        MultiModeScale      = [double]$script:Cfg.MultiModeTimeScale
        EnvOverride         = [string]$env:MCPS_ENGINE_DEADLINE
        CappedCount         = $cappedN
        Advice              = $advice
        Resolved            = @($rows)
    }
}
function Get-DoctorBudgetPolicy {
    # v1.47.6（审计 P2「-Auto 预算按池各算」的可观测面）：把"每池各算一次"写出来，**不改语义**。
    #   代码事实：`Get-TimeBudgetSec` 在 `Invoke-EnginePool` 里被调用，而 `-Auto` 顺序跑 repo/code/research 三个池
    #   ⇒ 进程内最坏 3×预算（模式间缝隙不计）。写成字段，省得现场按 120s 预期却等 6 分钟。
    #   ★真要改成进程级共享预算是**行为变更**（后两个池会更早被砍、覆盖率下降），需单独拍板，本函数只报现状。
    $per = [int](Get-TimeBudgetSec)
    $pools = 3
    # U-241（v1.53.24）：总预算生效后，最坏墙钟 = min(单池x池数, 总预算)。
    #   ★本函数在 Doctor 里调用 ⇒ 不启动 run 计时器（Get-TotalBudgetSec 只读配置，不碰 stopwatch）。
    $total = [int](Get-TotalBudgetSec)
    $worst = if ($per -le 0) { 0 } elseif ($total -gt 0) { [Math]::Min($per * $pools, $total) } else { $per * $pools }
    return [PSCustomObject]@{
        PerPoolSec  = $per
        EnvOverride = [string]$env:MCPS_TIME_BUDGET_SEC
        PoolsInAuto = $pools
        TotalBudgetSec = $total
        EnvOverrideTotal = [string]$env:MCPS_TOTAL_BUDGET_SEC
        WorstCaseSec = $worst
        SharedAcrossPools = ($total -gt 0)
        Note        = $(if ($total -gt 0) { '总预算跨池共享（-Auto 默认 45s）：池预算 = min(单池默认, 本轮剩余)；0 = 不限' } else { '每池独立计预算（-Auto = repo+code+research ⇒ 最坏 N×PerPoolSec）；0 = 不设预算' })
    }
}
function Get-DoctorRateLimitedSources {
    param($ResearchHealth, $RemoteEngines, $Tokens)
    $out = @()
    foreach ($rh in @($ResearchHealth)) {
        if ([string]$rh.Status -eq 'rate-limited') { $out += [PSCustomObject]@{ Source = [string]$rh.Source; Kind = 'research'; Engine = $rh.Engine; Http = $rh.Http; Note = $rh.Note } }
    }
    foreach ($re in @($RemoteEngines)) {
        if (("$($re.Note)") -match '\b429\b|限流等待过长') { $out += [PSCustomObject]@{ Source = [string]$re.Engine; Kind = 'code'; Engine = $re.Engine; Http = 429; Note = $re.Note } }
    }
    foreach ($tk in @($Tokens)) {
        if (("$($tk.Probe)") -match '\b429\b') { $out += [PSCustomObject]@{ Source = [string]$tk.Var; Kind = 'token'; Engine = $null; Http = 429; Note = $tk.Probe } }
    }
    return @($out | Sort-Object Kind, Source)
}
function Write-DoctorReportOutput {
    param([switch]$AsJson, [string]$VERSION, $doctorReport, $tools, $tokens, $tokenExpiryWarnings, $codeEvidenceLevel, $hasLocalBin, $remoteBlocked, $remoteEngines, $proxyConsistency, $researchHealth, $ghCodeDeprecation, $keyMatrix, $proxyState)
    if ($AsJson) {
        $doctorOut = [PSCustomObject]@{ version = $VERSION; mode = 'doctor'; doctor = $doctorReport }
        $doctorOut | ConvertTo-Json -Depth 6
    }
    else {
        Write-PayloadOutput "`n════════ 环境自检 (Doctor) ════════" "Cyan"
        Write-PayloadOutput ("代码证据检索能力: {0}" -f $codeEvidenceLevel) "Cyan"
        # R4-F1-d：把"通道有几个可用远程源"说出来（单点时显式告警 + 建议）
        $rcs = $doctorReport['remoteCodeSources']
        # 批次2：以 **effectiveCount**（扣 remoteBlocked 后）为准展示 ——
        #   否则「Doctor 报 N 个可用」与同屏的 remoteBlocked 说它被阻塞直接矛盾。
        Write-PayloadOutput ("  远程代码源: {0}/{1} 实际可用（标称 {2}；禁用: {3}；凭据阻塞: {4}）" -f $rcs.effectiveCount, $rcs.total, $rcs.availableCount,
            $(if (@($rcs.disabled).Count) { @($rcs.disabled) -join ',' } else { '无' }),
            $(if (@($rcs.blockedByCredential).Count) { @($rcs.blockedByCredential) -join ',' } else { '无' })) $(if ($rcs.singlePoint) { 'DarkYellow' } else { 'Green' })
        if ($rcs.warning) { Write-PayloadOutput ("  ⚠ " + $rcs.warning) "DarkYellow" }
        # A-11：限流源单列（本次探测里被 429 的源；空 = 本次未见限流，不代表配额充裕）
        $rls = @($doctorReport['rateLimitedSources'])
        Write-PayloadOutput ("  限流源(本次探测): {0}" -f $(if ($rls.Count -eq 0) { '无' } else { (@($rls | ForEach-Object { "{0}[{1}]" -f $_.Source, $_.Kind }) -join ', ') })) $(if ($rls.Count -eq 0) { 'Green' } else { 'DarkYellow' })
        Write-PayloadOutput ("  本地二进制: {0}" -f $(if ($hasLocalBin) { 'rg/ugrep 可用' } else { '✗ 无 ripgrep/ugrep —— 本地代码检索不可用' })) $(if ($hasLocalBin) { 'Green' } else { 'Red' })
        Write-PayloadOutput ("  远程代码证据被阻塞: {0}" -f $(if ($remoteBlocked.Count -eq 0) { '无' } else { $remoteBlocked -join '; ' })) $(if ($remoteBlocked.Count -eq 0) { 'Green' } else { 'Yellow' })
        Write-PayloadOutput "`n工具清单:" "Cyan"
        $tools | Format-Table -AutoSize -Property Tool, Exe, Present, Version, Role
        Write-PayloadOutput "令牌 (v1.36.0 含有效性探测):" "Cyan"
        # v1.45.9：先报 `.env` 读失败（若有）——否则下面一排 Present=False 会被读成"没配"。
        $envFileInfo = $doctorReport['envFile']
        if ($envFileInfo -and @($envFileInfo.Unreadable).Count) {
            foreach ($eu in @($envFileInfo.Unreadable)) {
                Write-PayloadOutput ("  ⚠ .env 存在但不可读：{0} — {1}" -f $eu.Path, $eu.Error) "Red"
            }
            Write-PayloadOutput ("  ⚠ {0}" -f $envFileInfo.Note) "Yellow"
        }
        $tokens | Format-Table -AutoSize -Property Var, Present, Valid, Probe, ExpiresAt, DaysLeft, MinScope
        foreach ($w in $tokenExpiryWarnings) { Write-PayloadOutput ("  ⏰ {0}" -f $w) "Yellow" }   # U-125
        foreach ($tk in $tokens) {
            if ($tk.Present -and $tk.Valid -eq $false) {
                Write-PayloadOutput ("  ✗ {0} 存在但无效（{1}）——依赖它的引擎会静默返回 0 命中，请更新令牌" -f $tk.Var, $tk.Probe) "Red"
            }
            elseif ($tk.Present -and $null -eq $tk.Valid -and $tk.Probe -and $tk.Probe -ne 'skipped') {
                # v1.45.7：三档给三句不同的处置建议 —— 原来不管哪种都只说「查链路」，TLS 失败的人会去换令牌。
                $probeAdvice = switch ("$($tk.Probe)") {
                    'tls-error' { '本机到该端点的 TLS 握手失败（多为证书吊销检查取不到），不是令牌问题；可用 MCPS_PROXY 换一条路由再探' }
                    'timeout' { '请求在 Cfg.DoctorProbeSec 内未返回；先排本机负载与链路抖动，别急着换令牌' }
                    default { '先查链路/代理白名单（MCPS_PROXY），别急着换令牌' }
                }
                Write-PayloadOutput ("  ? {0} 无法判定有效性（{1}）——{2}" -f $tk.Var, $tk.Probe, $probeAdvice) "Yellow"
            }
        }
        Write-PayloadOutput "远程引擎健康(v1.23.0):" "Cyan"
        $remoteEngines | Format-Table -AutoSize -Property Engine, Endpoint, Reachable, LatencyMs
        foreach ($re in $remoteEngines) { if ($re.Note) { Write-PayloadOutput ("  {0}: {1}" -f $re.Engine, $re.Note) "DarkYellow" } }
        foreach ($pc in $proxyConsistency) { Write-PayloadOutput ("  代理一致性: {0}" -f $pc.Advice) "Yellow" }
        # U-13 / U-26 / U-27 / U-40 输出
        Write-PayloadOutput "`n研究信源健康(U-13/U-26；可达=2xx，429=受限，401/403=需 key；MCPS_DOCTOR_RESEARCH=0 跳过):" "Cyan"
        # P1（2026-10-19）：跳过时逐源仍记 not-probed（JSON 里有 14 行）⇒ 人读侧报出条数，避免"表里空空"被读成"探过但全挂"。
        if ($doctorReport.researchProbeSkipped) { Write-PayloadOutput ("  （已按 MCPS_DOCTOR_RESEARCH=0 跳过：{0} 源记 not-probed，非『不可达』）" -f @($researchHealth).Count) "Gray" }
        else {
            $researchHealth | Format-Table -AutoSize -Property Source, Status, Http, LatencyMs, KeyPresent
            foreach ($rh in $researchHealth) { if ($rh.Note) { Write-PayloadOutput ("  {0}: {1}" -f $rh.Source, $rh.Note) "DarkYellow" } }
        }
        if ($ghCodeDeprecation) {
            $gcd = $ghCodeDeprecation
            if ($gcd.Sunset -or $gcd.Deprecation) { Write-PayloadOutput ("  ⚠ GitHub /search/code 废弃头：Deprecation={0} Sunset={1} 状态={2} 剩余天数={3} —— 到期后代码证据将依赖 grep.app/Sourcegraph（N-17）" -f $gcd.Deprecation, $gcd.Sunset, $gcd.Lifecycle.State, $gcd.Lifecycle.DaysLeft) $(if ($gcd.Lifecycle.State -eq 'sunset-passed') { 'Red' } else { 'Yellow' }) }
            elseif ($gcd.Http) { Write-PayloadOutput ("  GitHub /search/code 探测 HTTP {0}，未见 Deprecation/Sunset 头" -f $gcd.Http) "Green" }
            else { Write-PayloadOutput ("  GitHub /search/code 探测失败：{0}" -f $gcd.Note) "DarkYellow" }
        }
        Write-PayloadOutput "`n关键位次(U-27；只报有无，不打印值):" "Cyan"
        foreach ($km in $keyMatrix) { Write-PayloadOutput ("  {0} {1} —— {2}" -f $(if ($km.Present) { '✓' } else { '·' }), $km.Var, $km.Benefit) $(if ($km.Present) { 'Green' } else { 'Gray' }) }
        Write-PayloadOutput "`n代理状态(U-40 三层):" "Cyan"
        Write-PayloadOutput ("  进程级环境变量: {0}" -f $proxyState.ProcessEnv) $(if ($proxyState.ProcessEnv -eq 'none') { 'Green' } else { 'Yellow' })
        Write-PayloadOutput ("  MCPS_PROXY: {0}（白名单域 {1}）｜系统代理模式: {2}｜-NoProxy 直连模式: {3}（{4}）" -f $proxyState.McpsProxy, $proxyState.McpsProxyWhitelist, $proxyState.SystemProxyMode, $proxyState.NoProxyDirectMode, $proxyState.Edition) "White"
        # U-244（B1-3）：代理覆盖矩阵 —— 谁被 MCPS_PROXY 白名单排除、谁被 hosts 指到本机。只诊断，不改配置。
        $cov = $doctorReport['proxyCoverage']
        if ($cov -and @($cov.Rows).Count -gt 0) {
            $netRows = @($cov.Rows | Where-Object { $_.Host })
            Write-PayloadOutput ("`n代理覆盖(U-244；逐引擎 host，路由取自真实选路): {0} 个网络引擎，MCPS_PROXY 命中 {1} 个" -f $netRows.Count, @($netRows | Where-Object { $_.Route -eq 'mcps-proxy' }).Count) "Cyan"
            $netRows | Format-Table -AutoSize -Property Engine, Host, Route, Whitelist
            # 只把「白名单排除 + 已无其他代理可走（只剩直连）」报红：本机白名单只覆盖 GitHub，
            #   若每个未覆盖域都报红，报告就退化成噪声（cry wolf）。其余未覆盖域在上表的 Whitelist 列可见。
            foreach ($r in @($netRows | Where-Object { $_.Excluded -and $_.OnlyDirect })) { Write-PayloadOutput ("  [!] {0} ({1}): {2}" -f $r.Engine, $r.Host, $r.Note) "Red" }
            foreach ($r in @($netRows | Where-Object { $_.Hijack })) { Write-PayloadOutput ("  [hosts] {0} ({1}) -> {2}：本机解析会直接打到本机（socks5h 由远端解析，不受影响）" -f $r.Engine, $r.Host, $r.Hijack) "Yellow" }
        }
        $tDis = @(Get-DisabledEngineSpecs)
        if ($tDis.Count -gt 0) { Write-PayloadOutput ("被禁引擎(MCPS_DISABLE): {0}" -f ($tDis -join ', ')) "Yellow" }
        Write-PayloadOutput "`n建议:" "Cyan"
        Write-PayloadOutput "  • $($doctorReport.recommendation.codeEvidence)" "White"
        Write-PayloadOutput "  • $($doctorReport.recommendation.research)" "White"
        Write-PayloadOutput "  • $($doctorReport.recommendation.repoDiscovery)" "White"
    }
}
# 批次3拆分（2026-10-10）：`Invoke-DoctorReport` 曾涨到 112 行（U-163-2 红线：函数体 ≤100）。
#   按内聚块抽出本函数与 Get-DoctorKeyMatrix，行为逐行等价。二者都是**主脚本**函数
#   （不进 Runspace 池）⇒ 无需登记引擎注册表的 Needs。
# R4-F1-d（2026-10-04）：**代码证据通道单点自曝**（机器可读）。
#   由来：R4-0b 实测 —— 唯一在工作的代码源（GitHubCode）偶发失败 ⇒ 整条代码证据通道 0 条，
#   而调用方**只看 count 分不清**「源失败」与「确实没有」。逐源记账（reasonCodes/errors）虽已分开记，
#   但"通道有几个源"这件事此前**没有任何地方说出来**（codeEvidenceLevel 只看本地二进制有无）。
#   ★**不动用户的 MCPS_DISABLE**（那是环境决定，见 参数速查 的"本网已知永久降级"口径）——
#     本字段只把事实**说出来**并给出建议，让调用方能据此决定，而不是替用户改配置。
function Get-DoctorRemoteCodeSources {
    param($RemoteBlocked)
    $codeAll = @($script:_engineRegistry | Where-Object { $_.Kind -eq 'code' })
    $disSpecs = @(Get-DisabledEngineSpecs)
    $codeDisabled = @($codeAll | Where-Object {
            $nm = ([string]$_.Name).ToLower()
            $pfs = @($_.Platforms | ForEach-Object { ([string]$_).ToLower() })
            @($disSpecs | Where-Object { $_ -eq $nm -or $pfs -contains $_ }).Count -gt 0
        })
    $codeAvail = @($codeAll | Where-Object { $codeDisabled -notcontains $_ })
    # 批次2（2026-10-09）：**effectiveCount** —— 从「标称可用」里再扣掉被 remoteBlocked 挡住的源。
    #   病灶：availableCount 只扣了 MCPS_DISABLE，没扣 remoteBlocked（缺 token / token 无效 / 不可达）。
    #   实测场景：GITLAB_TOKEN 缺失时 GitLabBlobs 仍在 available[] 里 ⇒ 报 availableCount=5，
    #   而同一份 Doctor 的 remoteBlocked 却写着它「需 GITLAB_TOKEN」——同一份报告自相矛盾；
    #   且 singlePoint 会因此判错（标称 2 个、实际 1 个可用时，它仍报「不是单点」）。
    #   remoteBlocked 条目形如 'GitLabBlobs(需 GITLAB_TOKEN)'，取 '(' 前的引擎名做交集。
    $rcsBlockedNames = @($RemoteBlocked | ForEach-Object { $s = [string]$_; if ($s -match '^([^\(]+)\(') { $matches[1].Trim() } } | Where-Object { $_ })
    $rcsBlockedAvail = @($codeAvail | Where-Object { $rcsBlockedNames -contains ([string]$_.Name) })
    $effectiveCount = $codeAvail.Count - $rcsBlockedAvail.Count
    $rcsWarning = $null
    if ($effectiveCount -le 1) {
        # ★注意：字符串里不要用双层双引号（PS 转义易错），用「」包引用的词
        $rcsWarning = "代码证据通道仅剩 $effectiveCount 个**实际可用**远程源（标称可用 $($codeAvail.Count) 个，其中 $($rcsBlockedAvail.Count) 个被凭据阻塞）—— 它一旦抖动/失败，整条代码证据即为 0 条" +
        "（载荷的 reasonCodes/errors 会记下原因，但只读 count 的调用方分不清「源失败」与「确实没有」）。" +
        "建议：启用至少 1 个备用远程源（从 MCPS_DISABLE 中移除 Sourcegraph/GrepApp）、补齐被阻塞源的凭据，或改用 -LocalCodeSearch（本地检索不受此影响）。"
    }
    return [ordered]@{
        total          = $codeAll.Count
        available      = @($codeAvail | ForEach-Object { $_.Name })
        disabled       = @($codeDisabled | ForEach-Object { $_.Name })
        availableCount = $codeAvail.Count
        # 批次2 新增：扣掉 remoteBlocked 后的**实际**可用数（单点判断以此为准）
        effectiveCount = $effectiveCount
        blockedByCredential = @($rcsBlockedAvail | ForEach-Object { $_.Name })
        singlePoint    = ($effectiveCount -le 1)
        warning        = $rcsWarning
    }
}
# U-27：关键位次 —— 每个令牌/密钥的存在性与受益引擎（不打印值）。
function Get-DoctorKeyMatrix {
    return @(
        @{ Var = 'GITHUB_TOKEN';  Benefit = 'GitHub repo 搜索限速 10→30/min；code search 需 token 才可用（限速仍为 10/min，U-43）' }
        @{ Var = 'GITEE_TOKEN';   Benefit = 'Gitee v5 API 回退路径' }
        @{ Var = 'GITLAB_TOKEN';  Benefit = 'GitLab /search blobs' }
        @{ Var = 'S2_API_KEY';    Benefit = 'Semantic Scholar 配额（arXiv 引用补全）' }
        @{ Var = 'GLAMA_API_KEY'; Benefit = 'Glama MCP 目录（无 key 时走官方 Registry 保底）' }
        @{ Var = 'SE_KEY';        Benefit = 'Stack Exchange 配额（匿名 ~300/天）' }
    ) | ForEach-Object { [PSCustomObject]@{ Var = $_.Var; Present = (-not [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($_.Var))); Benefit = $_.Benefit } }
}
function Invoke-DoctorReport {
    param([switch]$AsJson)
    $doctorReport = [ordered]@{}
    # U-141：工具全表共用跨平台候选与 --version 探活；探活失败一律 tool_missing，绝不是零命中。
    $tools = @(Get-DoctorToolInventory)
    $tokenState = Get-DoctorTokens -VERSION $VERSION
    $tokens = @($tokenState.Tokens)
    $tokenExpiryWarnings = @($tokenState.TokenExpiryWarnings)
    # 能力矩阵：本地代码检索可用性 + 远程代码证据可用性
    $hasLocalBin = @($tools | Where-Object { $_.Tool -in @('ripgrep','ugrep') -and $_.Present }).Count -gt 0
    $codeEvidenceLevel = if ($hasLocalBin) { 'local+remote' } else { 'remote-only' }
    $remoteBlocked = @()
    $ghTok = $tokens | Where-Object { $_.Var -eq 'GITHUB_TOKEN' }
    $glTok = $tokens | Where-Object { $_.Var -eq 'GITLAB_TOKEN' }
    if (-not $ghTok.Present) { $remoteBlocked += 'GitHubCode(需 GITHUB_TOKEN)' }
    elseif ($ghTok.Valid -eq $false) { $remoteBlocked += "GitHubCode(GITHUB_TOKEN 无效/已撤销, $($ghTok.Probe))" }
    elseif ($null -eq $ghTok.Valid -and $ghTok.Probe -and $ghTok.Probe -ne 'skipped') { $remoteBlocked += "GitHubCode(GITHUB_TOKEN 未探通（无法判定有效性）, $($ghTok.Probe))" }
    if (-not $glTok.Present) { $remoteBlocked += 'GitLabBlobs(需 GITLAB_TOKEN)' }
    elseif ($glTok.Valid -eq $false) { $remoteBlocked += "GitLabBlobs(GITLAB_TOKEN 无效/已撤销, $($glTok.Probe))" }
    elseif ($null -eq $glTok.Valid -and $glTok.Probe -and $glTok.Probe -ne 'skipped') { $remoteBlocked += "GitLabBlobs(GITLAB_TOKEN 未探通（无法判定有效性）, $($glTok.Probe))" }
    $doctorReport['tools'] = $tools
    $doctorReport['tokens'] = $tokens
    $doctorReport['tokenExpiryWarnings'] = @($tokenExpiryWarnings)   # U-125
    # v1.45.9：`.env` 可读性单列 —— tokens[].Present=false 有两种成因（没配 / 配了读不到），
    #   只报 Present 会把"权限坏了"伪装成"没配置"，从而把故障引向"去申请令牌"这条错路。
    $doctorReport['envFile'] = [PSCustomObject]@{
        Unreadable = @($script:EnvLoadErrors | ForEach-Object { [PSCustomObject]@{ Path = $_.Path; Error = $_.Error } })
        Note       = $(if (@($script:EnvLoadErrors).Count) { '.env 存在但读取失败：其中令牌一律按未配置处理（修好权限后重跑 -Doctor 复核）' } else { '' })
    }
    $doctorReport['codeEvidenceLevel'] = $codeEvidenceLevel
    $doctorReport['remoteCodeSources'] = Get-DoctorRemoteCodeSources -RemoteBlocked $remoteBlocked
    $doctorReport['remoteBlocked'] = $remoteBlocked
    # v1.53.17（跨平台补洞）：缺工具时的建议必须**可执行** —— Windows 用 winget、Linux 用 apt、macOS 用 brew。
    #   旧文案只说"请安装 ripgrep"，在非 Windows 上完全没有指向（那里没有 winget）。
    $doctorPlatform = if ($null -ne $IsMacOS -and $IsMacOS) { 'mac' } elseif ($null -ne $IsLinux -and $IsLinux) { 'linux' } else { 'win' }
    $rgHint = Get-ToolInstallHint -Tool 'ripgrep' -Platform $doctorPlatform
    $doctorReport['recommendation'] = @{
        codeEvidence = $(if ($ghTok.Present -and $ghTok.Valid -eq $false) { "GITHUB_TOKEN 无效($($ghTok.Probe))：GitHub 代码搜索与仓库发现会 401——请更新 .env 令牌后重试" }
            elseif ($hasLocalBin) { '本地 rg/ugrep 可用：建议 -LocalCodeSearch 优先本地' }
            elseif (-not $env:GITHUB_TOKEN) { "无 rg 且无 GITHUB_TOKEN：代码证据检索可能 0 命中——请安装 ripgrep（$rgHint）或设置 GITHUB_TOKEN 后重试" }
            else { "仅有远程：可远程检索（有 token）；本地检索装 ripgrep：$rgHint" })
        research     = '研究信源(HF/npm/arXiv/SE) 匿名可用，无需 token'
        repoDiscovery = $(if ($ghTok.Present -and $ghTok.Valid -eq $false) { "GitHub 令牌无效：仓库发现将返回 0 命中（非『不存在』）——请更新 GITHUB_TOKEN；其余平台匿名可用" }
            else { '仓库发现(GitHub/Gitee/GitLab/Codeberg) 匿名可用（GitHub 未认证限 60 req/hr）' })
    }
    $codeHealth = Get-DoctorRemoteCodeHealth -VERSION $VERSION -ghTok $ghTok -glTok $glTok
    $remoteEngines = @($codeHealth.RemoteEngines)
    $proxyConsistency = @($codeHealth.ProxyConsistency)
    $doctorReport['proxyConsistency'] = @($proxyConsistency)
    $doctorReport['remoteEngines'] = $remoteEngines
    $researchState = Get-DoctorResearchHealth -VERSION $VERSION
    $researchHealth = @($researchState.ResearchHealth)
    $ghCodeDeprecation = $researchState.GHCodeDeprecation
    $doResearch = -not $researchState.ResearchProbeSkipped
    $doctorReport['githubCodeSearchDeprecation'] = $ghCodeDeprecation
    $doctorReport['researchSources'] = @($researchHealth)
    $doctorReport['researchProbeSkipped'] = -not $doResearch
    # U-194（2026-10-21）：hosts 劫持汇总 —— 把散落在 tokens/researchSources/githubCodeSearchDeprecation 里的命中行
    #   收拢成一张表（去重）。空数组 = 未发现。用户看到"GitHub 超时"时，先看这里而不是去查 GitHub 状态页。
    $hostsRows = @()
    foreach ($t in @($tokens)) {
        if ($t -and [string]$t.Probe -eq 'hosts_hijack' -and $t.HostsOverride) {
            $hostsRows += [PSCustomObject]@{ Target = $t.Var; Line = [string]$t.HostsOverride; Impact = '令牌探测被本机 hosts 拦截（结果 Valid=null，不代表令牌失效）' }
        }
    }
    foreach ($r in @($researchHealth)) {
        if ($r -and [string]$r.Probe -eq 'hosts_hijack' -and $r.HostsOverride) {
            $hostsRows += [PSCustomObject]@{ Target = [string]$r.Source; Line = [string]$r.HostsOverride; Impact = '研究探针被本机 hosts 拦截（Status 只是传输层失败）' }
        }
    }
    if ($ghCodeDeprecation -and [string]$ghCodeDeprecation.Probe -eq 'hosts_hijack' -and $ghCodeDeprecation.HostsOverride) {
        $hostsRows += [PSCustomObject]@{ Target = 'GitHub code search'; Line = [string]$ghCodeDeprecation.HostsOverride; Impact = '废弃头探测未拿到响应（Lifecycle=unknown）' }
    }
    $doctorReport['hostsOverrides'] = @($hostsRows | Sort-Object Target -Unique)
    # A-11：限流源单列（与 remoteCodeSources 并列；单次探测快照，见 Get-DoctorRateLimitedSources 头注）
    $doctorReport['rateLimitedSources'] = @(Get-DoctorRateLimitedSources -ResearchHealth $researchHealth -RemoteEngines $remoteEngines -Tokens $tokens)
    # U-27：关键位次 —— 每个令牌/密钥的存在性与受益引擎（不打印值）
    $keyMatrix = @(Get-DoctorKeyMatrix)
    $doctorReport['keyMatrix'] = @($keyMatrix)
    # U-13 / U-40：代理状态三层 —— 进程级环境变量 / 技能 MCPS_PROXY / -NoProxy 实际直连模式
    $mcpsProxy = $env:MCPS_PROXY
    $proxyState = [PSCustomObject]@{
        ProcessEnv   = (Get-ProcessProxyEnvSummary)
        McpsProxy    = $(if ($mcpsProxy) { ($mcpsProxy -replace '://[^@/]+@', '://***@') } else { 'unset' })
        McpsProxyWhitelist = $(if ($mcpsProxy -and $mcpsProxy.Contains(';')) { @((($mcpsProxy -split ';')[1] -split ',') | ForEach-Object { $_.Trim() } | Where-Object { $_ }).Count } else { 0 })
        SystemProxyMode = $script:_sysProxyMode
        NoProxyDirectMode = $(if ($PSVersionTable.PSEdition -eq 'Core') { 'direct-noproxy-core' } else { 'direct-emptyproxy-desktop' })
        Edition = $PSVersionTable.PSEdition
    }
    $doctorReport['proxyState'] = $proxyState
    $doctorReport['proxyCoverage'] = Get-DoctorProxyCoverage   # U-244（B1-3，F6）：逐引擎 host 代理覆盖（只读诊断；路由结论取自 Get-NetworkCandidates）
    # v1.33.0 P1：MCPS_DISABLE 配置透出（Doctor 校准能力边界时一并展示被禁引擎）
    $doctorReport['disabledEngines'] = @(Get-DisabledEngineSpecs)
    # v1.47.5：逐源生效截止（含来源标注）—— 排"为什么这个源只等 N 秒"时先看这里，别读代码
    $doctorReport['deadlinePolicy'] = Get-DoctorDeadlinePolicy
    # v1.47.6：时间预算口径（每池各算）+ 最坏值，避免"按 120s 预期却等 3×120s"
    $doctorReport['budgetPolicy'] = Get-DoctorBudgetPolicy
    Write-DoctorReportOutput -AsJson:$AsJson -VERSION $VERSION -doctorReport $doctorReport -tools $tools -tokens $tokens -tokenExpiryWarnings $tokenExpiryWarnings -codeEvidenceLevel $codeEvidenceLevel -hasLocalBin $hasLocalBin -remoteBlocked $remoteBlocked -remoteEngines $remoteEngines -proxyConsistency $proxyConsistency -researchHealth $researchHealth -ghCodeDeprecation $ghCodeDeprecation -keyMatrix $keyMatrix -proxyState $proxyState
}
# U-114 (R90): one PowerShell process, one outer RunspacePool, one ordinary research pipeline per query.
# Input: UTF-8 JSON ["query", ...] or {"queries":["query", ...]}; max 64 entries.
# Each child calls this script in a RUNSPACE (not another pwsh); its native -AsJson results/coverage are preserved.
# U-152: one scalar reasonCode per query for quick triage; keep the engine-level ReasonCodes map.
# Priority is deterministic even when multiple engines fail; true zero-hit is not a transport failure.
function Get-ResearchBatchReasonCode {
    param($ReasonCodes, [string]$Status, [int]$ResultCount)
    if ($Status -eq 'ok') { if ($ResultCount -eq 0) { return 'zero-hit' }; return $null }
    $values = @($ReasonCodes.PSObject.Properties | ForEach-Object { [string]$_.Value })
    foreach ($code in @('missing-credential', 'tool-missing', 'network-unavailable', 'forbidden', 'rate-limited', 'deadline', 'error', 'not-run', 'user-disabled', 'budget-truncated', 'filtered', 'zero-hit')) {
        if ($values -contains $code) { return $code }
    }
    return 'error'
}
function New-ResearchBatchFailure {
    param([int]$Index, [string]$Query, [string]$Code, [string]$Message)
    $reason = [PSCustomObject]@{ Batch = $Code }
    [PSCustomObject]@{
        Index = $Index; Keyword = $Query; Status = 'error'; ResultCount = 0; results = @()
        coverage = [PSCustomObject]@{ Requested = @('ResearchBatch'); Executed = @(); Blocked = @('Batch'); Degraded = @(); Reasons = [PSCustomObject]@{ Batch = $Message }; ReasonCodes = $reason; Verdict = 'none' }
        ReasonCodes = $reason; reasonCode = $Code; Error = $Message
    }
}
function Write-BatchInputError {
    # v1.47.8：批输入错误必须与**其它机器可读错误同形**。
    #   旧行为：直接 throw ⇒ stdout 是 PowerShell 原生报错（含脚本行号/`+ ~~~~`），`--out` 落下一个 **0 字节文件**，
    #   消费方按 JSON 解析必然炸（实测 `-ResearchBatch bad.json -AsJson --out x.json`）。
    #   新行为：AsJson ⇒ 先写与参数错误同形的信封（error/message/usage/results/warnings），再 throw 保住非零退出码；
    #   非 AsJson ⇒ 只 throw（保持人类可读的红字路径）。
    param([string]$Message, [switch]$AsJson)
    if ($AsJson) {
        [PSCustomObject]@{
            version  = $VERSION
            error    = 'invalid-batch-input'
            message  = $Message
            usage    = 'multi-platform-searcher.ps1 -ResearchBatch <queries.json> [-AsJson]'
            results  = @()
            warnings = @(("批输入错误：{0}；**未执行任何检索**" -f $Message))
        } | ConvertTo-Json -Depth 5 | Write-Output
    }
    throw $Message
}
function Invoke-ResearchBatch {
    param(
        [Parameter(Mandatory)][string]$InputPath,
        [Parameter(Mandatory)][string]$MainPath,
        [int]$TaskLimit = 5,
        [string]$TaskSite = 'stackoverflow',
        [switch]$TaskNoEnvFile,
        [switch]$TaskNoCache,
        [switch]$TaskNoProxyFix,
        [string]$TaskProxyMode = 'auto',
        [switch]$AsJson,
        [ValidateRange(1, 8)][int]$MaxParallel = 4,
        [ValidateRange(1, 600)][int]$BatchBudgetSec = 120,
        [string]$RunnerText = '' # harness only; public CLI does not accept a runner
    )
    # P0-2（2026-10-19）：批模式并发度与总预算改为**可调**。实测：4 路并行 × 11 源 = 44 并发
    #   ⇒ 单源延迟被放大 2–3 倍（Packages 单查询 3–6s → 批模式 10.5s 撞 cap，npm/Maven 被砍）。
    #   未设环境变量 ⇒ 完全沿用参数默认值（4 / 120），零行为变更。
    if ($env:MCPS_BATCH_MAX_PARALLEL) { $MaxParallel = [Math]::Max(1, [Math]::Min(8, [int]$env:MCPS_BATCH_MAX_PARALLEL)) }
    if ($env:MCPS_BATCH_BUDGET_SEC) { $BatchBudgetSec = [Math]::Max(10, [Math]::Min(600, [int]$env:MCPS_BATCH_BUDGET_SEC)) }
    if (-not (Test-Path -LiteralPath $InputPath -PathType Leaf)) { Write-BatchInputError -Message 'U-114: -ResearchBatch input file does not exist.' -AsJson:$AsJson }
    $raw = [System.IO.File]::ReadAllText((Resolve-Path -LiteralPath $InputPath).Path, [System.Text.Encoding]::UTF8)
    try { $parsed = ConvertFrom-Json -InputObject $raw -ErrorAction Stop }
    catch { Write-BatchInputError -Message 'U-114: -ResearchBatch input must be valid UTF-8 JSON.' -AsJson:$AsJson }
    # ConvertFrom-Json pipeline can unwrap a one-element JSON array to a scalar (also on PS5.1).
    if ($raw.TrimStart().StartsWith('[')) { $items = @($parsed); if ($null -eq $parsed) { $items = @() } }
    elseif ($null -ne $parsed -and $parsed.PSObject.Properties.Name -contains 'queries' -and $parsed.queries -is [array]) { $items = @($parsed.queries) }
    else { Write-BatchInputError -Message 'U-114: -ResearchBatch expects a JSON array or {"queries":[...]}, not a scalar.' -AsJson:$AsJson }
    if ($items.Count -lt 1 -or $items.Count -gt 64) { Write-BatchInputError -Message 'U-114: -ResearchBatch requires 1..64 entries.' -AsJson:$AsJson }
    if ([string]::IsNullOrWhiteSpace($RunnerText)) {
        $RunnerText = @'
param($Q, $Take, $Script, $Site, $SkipEnv, $SkipCache, $SkipProxy, $NetworkMode)
& $Script -Keyword $Q -ResearchSources -Limit $Take -Site $Site -AsJson -NoEnvFile:$SkipEnv -NoCache:$SkipCache -NoProxyFix:$SkipProxy -ProxyMode $NetworkMode
'@
    }
    $tasks = New-Object 'object[]' $items.Count
    $entries = New-Object 'object[]' $items.Count
    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    $pool = [runspacefactory]::CreateRunspacePool(1, [Math]::Min($MaxParallel, $items.Count))
    $pool.Open()
    try {
        for ($i = 0; $i -lt $items.Count; $i++) {
            $q = $null
            if ($items[$i] -is [string]) { $q = [string]$items[$i] }
            if ([string]::IsNullOrWhiteSpace($q)) {
                $entries[$i] = New-ResearchBatchFailure -Index ($i + 1) -Query $q -Code 'error' -Message 'empty or non-string keyword'
                continue
            }
            # The worker compiles RunnerText in its own runspace; no cross-thread scriptblock and no child pwsh.
            $ps = [powershell]::Create()
            $ps.RunspacePool = $pool
            [void]$ps.AddScript({
                param($Code, $Q, $Take, $Script, $Site, $SkipEnv, $SkipCache, $SkipProxy, $NetworkMode)
                $ErrorActionPreference = 'Stop'
                $run = [scriptblock]::Create($Code)
                $text = @(& $run $Q $Take $Script $Site $SkipEnv $SkipCache $SkipProxy $NetworkMode) -join "`n"
                if ([string]::IsNullOrWhiteSpace($text)) { throw 'batch runner emitted no JSON' }
                $text
            }).AddArgument($RunnerText).AddArgument($q).AddArgument($TaskLimit).AddArgument($MainPath).AddArgument($TaskSite).AddArgument([bool]$TaskNoEnvFile).AddArgument([bool]$TaskNoCache).AddArgument([bool]$TaskNoProxyFix).AddArgument($TaskProxyMode)
            try { $tasks[$i] = [PSCustomObject]@{ PS = $ps; Handle = $ps.BeginInvoke() } }
            catch { $ps.Dispose(); $entries[$i] = New-ResearchBatchFailure -Index ($i + 1) -Query $q -Code 'error' -Message 'could not start query runspace' }
        }
        for ($i = 0; $i -lt $items.Count; $i++) {
            if ($null -eq $tasks[$i]) { continue }
            $task = $tasks[$i]
            $q = [string]$items[$i]
            $waitMs = [int][Math]::Max(0, $BatchBudgetSec * 1000 - $watch.ElapsedMilliseconds)
            if (-not $task.Handle.AsyncWaitHandle.WaitOne($waitMs)) {
                try { $task.PS.Stop() } catch { }
                $entries[$i] = New-ResearchBatchFailure -Index ($i + 1) -Query $q -Code 'deadline' -Message 'research batch deadline exceeded'
                continue
            }
            $entries[$i] = Convert-ResearchBatchTaskResult -task $task -i $i -q $q
        }
    } finally {
        foreach ($task in $tasks) { if ($null -ne $task) { try { $task.PS.Dispose() } catch { } } }
        $pool.Close(); $pool.Dispose(); $watch.Stop()
    }
    $batchCodes = [ordered]@{}
    foreach ($entry in $entries) {
        if ($entry.Status -ne 'ok') {
            # The scalar and the aggregate MUST agree; a successful zero-hit is not a failed query.
            $batchCodes['Q' + $entry.Index] = [string]$entry.reasonCode
        }
    }
    $batchVerdict = if (-not $batchCodes.Count) { 'full' }
                    elseif (@($entries | Where-Object { $_.Status -ne 'no-engines' }).Count -eq 0) { 'no-engines' }
                    elseif (@($entries | Where-Object { $_.Status -in @('ok', 'degraded') }).Count -eq 0) { 'none' }
                    else { 'partial' }
    $response = [PSCustomObject]@{
        version = $VERSION; mode = 'research-batch'; queries = @($entries)
        coverage = [PSCustomObject]@{ ReasonCodes = [PSCustomObject]$batchCodes; Verdict = $batchVerdict }
        metrics = [PSCustomObject]@{ ElapsedMs = $watch.ElapsedMilliseconds; QueryCount = $entries.Count; FailedCount = $batchCodes.Count; ResultCount = @($entries | ForEach-Object { $_.ResultCount } | Measure-Object -Sum).Sum }
        # U-164（2026-10-04）：batch 顶层包也对外给四态，**由既有 Get-ContractStatus 机械派生**（不新造映射、不独立赋值）。
        #   doctor 不补：它没有 coverage/Verdict ⇒ 无派生源（补了就是编状态）。该决策已落成 tests/test-u160 里的断言。
        status = Get-ContractStatus -Verdict $batchVerdict
    }
    if ($AsJson) { $response | ConvertTo-Json -Depth 12 }
    else { $response }
}
function Convert-ResearchBatchTaskResult {
    param($task, $i, $q)
            try {
                $stage = 'end-invoke'
                $text = @($task.PS.EndInvoke($task.Handle)) -join "`n"
                $stage = 'error-stream'
                if ($task.PS.Streams.Error.Count -gt 0) { throw 'runner wrote a PowerShell error stream' }
                $stage = 'json-parse'
                $body = ConvertFrom-Json -InputObject $text -ErrorAction Stop
                $stage = 'json-shape'
                if ($null -eq $body -or $body.PSObject.Properties.Name -notcontains 'results' -or $body.results -isnot [array] -or
                    $body.PSObject.Properties.Name -notcontains 'coverage' -or $null -eq $body.coverage.ReasonCodes) {
                    throw 'runner returned no results array / coverage ReasonCodes'
                }
                $verdict = [string]$body.coverage.Verdict
                if ($verdict -notin @('full', 'partial', 'degraded', 'none', 'no-engines')) { throw 'runner returned an unknown coverage verdict' }
                # U-157: zero executed is none, never degrade it merely because it is not full.
                # Full coverage with a real zero-hit remains full (U-120); ResultCount distinguishes no matches.
                $state = if ($verdict -eq 'full') { 'ok' } elseif ($verdict -eq 'no-engines') { 'no-engines' } elseif ($verdict -eq 'none') { 'none' } else { 'degraded' }
                $codes = $body.coverage.ReasonCodes
                if ($state -ne 'ok' -and @($codes.PSObject.Properties.Name).Count -eq 0) { $codes = [PSCustomObject]@{ Batch = 'error' } }
                $hitCount = @($body.results).Count
                $reasonCode = Get-ResearchBatchReasonCode -ReasonCodes $codes -Status $state -ResultCount $hitCount
                return [PSCustomObject]@{
                    Index = $i + 1; Keyword = $q; Status = $state; ResultCount = $hitCount
                    results = @($body.results); coverage = $body.coverage; ReasonCodes = $codes; reasonCode = $reasonCode
                    metrics = $body.metrics; warnings = $body.warnings; Error = $null
                }
            } catch {
                # Avoid reflecting request URLs or secrets from arbitrary exception strings to stdout.
                return New-ResearchBatchFailure -Index ($i + 1) -Query $q -Code 'error' -Message ('research query failed at ' + $stage + ' (details suppressed)')
            }
}
