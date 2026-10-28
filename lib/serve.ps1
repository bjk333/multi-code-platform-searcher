# ==============================================================================
# lib/serve.ps1 -- Multi-Code-Platform Searcher | B3-2 模块拆分（v1.54.0）
#
# -Serve 常驻服务的缓存、覆盖度与原因码拼装。
#
# 契约：本文件只定义（函数 / $script: 数据），无顶层副作用；由主脚本按固定顺序点源加载。
#   · 作用域：点源进主脚本作用域，故 $script: 指向主脚本；版本号/参数等由主脚本提供。
#   · 不要在这里 exit、不要写 stdout：进度与产物分别走 Write-ColorOutput / Write-PayloadOutput。
#   · 新增函数放对应模块；跨模块调用无需前置声明（全部在运行前定义完毕）。
# ==============================================================================

# U-195（2026-10-21）：`-Serve` 此前**没有查询级缓存** —— repo/research 分支直接调 Invoke-Concurrent*，
#   绕过了主流程的 LRU/磁盘缓存。实测同请求连发两次：repo 12.08s→11.48s、research 14.43s→10.96s；
#   而 CLI 同请求 18.98s→3.91s（缓存命中）。Agent 会重复问同一个问题（重试/换措辞），每次重付 11 秒。
#   口径：只缓存**有结果**的原始结果（空/失败不缓存，避免把一次限流固化 15 分钟）；键含全部影响结果的参数。
#   定义在**主流程守卫之前**（与其它工具函数同层），否则 dot-source 单测里不存在。
function Resolve-ServeCodeScope {
    # U-201（2026-10-21）：Serve/MCP 的 `code` op 仓库作用域解析（抽成纯函数便于单测与变异）。
    #   Valid=false 只发生在"给了 repoScope 但解析不出 owner/repo"——此时必须报参数错，**不能**退回全局检索。
    param([string]$RepoScope)
    $plan = Get-CodeScopePlan -RepoScope $RepoScope -RepoScopeMode 'only'
    $valid = $true
    if (-not [string]::IsNullOrWhiteSpace($RepoScope) -and -not $plan.Identity) { $valid = $false }
    $slug = if ($plan.Identity) { [string]$plan.Identity.Slug } else { $null }
    return [PSCustomObject]@{ Valid = $valid; Plan = $plan; Slug = $slug }
}
function Get-ServeCacheKey {
    param([string]$Op, [string]$Keyword, [int]$Limit, [string]$Platforms, [string]$Language, [int]$MinStars, [string]$Site,
        # U-201（2026-10-21）：`code` op 的仓库/路径作用域也影响结果 ⇒ 必须进键（否则 A 仓库命中会被 B 仓库复用）
        [string]$RepoScope = '', [string]$PathFilter = '')
    $kw = if ($null -eq $Keyword) { '' } else { $Keyword.Trim().ToLowerInvariant() }
    return ('serve#{0}#{1}#{2}#{3}#{4}#{5}#{6}#{7}#{8}' -f $Op, $kw, $Limit, $Platforms, $Language, $MinStars, $Site, $RepoScope, $PathFilter)
}
function Get-CoverageVerdict {
    # U-120（C8，2026-09-28）的裁定顺序，**逐字同序**（v1.49.0 抽出成函数，CLI 与 Serve 共用）：
    #   请求了引擎但一个都没执行 ⇒ none（"部分源成功"在这里是失真）
    #   有 Blocked ⇒ partial；有 Degraded/NotRun ⇒ degraded；执行=0 ⇒ no-engines；否则 full
    #   ★顺序即语义：`none` 必须排在 `partial` 之前，否则 Executed=[] + Blocked 会被报成 partial。
    param([int]$RequestedCount, [int]$ExecutedCount, [bool]$HasBlocked, [bool]$HasDegraded, [bool]$HasNotRun)
    if ($RequestedCount -gt 0 -and $ExecutedCount -eq 0) { return 'none' }
    if ($HasBlocked) { return 'partial' }
    if ($HasDegraded) { return 'degraded' }
    if ($HasNotRun) { return 'degraded' }
    if ($ExecutedCount -eq 0) { return 'no-engines' }
    return 'full'
}
function Get-ServeCoverage {
    # v1.49.0：**MCP 侧此前没有 coverage** —— `content[0].text` 只有 count/reasons，Agent 无法一眼判断
    #   "这一轮到底查成了没有"（reasons 要逐条读）。这里按 CLI 同一套分组口径从 _engineStatus 汇总：
    #   ok|empty ⇒ Executed；auth_missing|tool_missing|network_unavailable ⇒ Blocked；error|rate_limited ⇒ Degraded；
    #   请求了却没写状态 ⇒ NotRun（池提前收工）。Verdict 走同一个 Get-CoverageVerdict。
    #   Reasons/ReasonCodes 不重复造 —— 响应顶层已有 `reasons`（逐源 `<status>: <reason>`）。
    param([string[]]$Requested)
    $req = @($Requested | Where-Object { $_ } | Select-Object -Unique)
    $exec = 0; $blk = 0; $deg = 0; $notRun = 0
    foreach ($en in $req) {
        $st = [string]$script:_engineStatus[$en]
        if ($st -in @('ok', 'empty')) { $exec++ }
        elseif ($st -in @('auth_missing', 'tool_missing', 'network_unavailable')) { $blk++ }
        elseif ($st -in @('error', 'rate_limited')) { $deg++ }
        else { $notRun++ }
    }
    return [PSCustomObject]@{
        Requested = $req
        Executed  = $exec
        Blocked   = $blk
        Degraded  = $deg
        NotRun    = $notRun
        Verdict   = (Get-CoverageVerdict -RequestedCount $req.Count -ExecutedCount $exec -HasBlocked ($blk -gt 0) -HasDegraded ($deg -gt 0) -HasNotRun ($notRun -gt 0))
    }
}
function Get-ServeReasons {
    # v1.46.8：MCP 侧此前**看不到任何 per-engine 原因**（Serve 只回 count/results）⇒ 0 条分不清
    #   "真的没有" 与 "令牌失效/限流/截止"。CLI 有 coverage.Reasons，这里给同一份信息的精简版：
    #   只列非 ok/empty 的引擎（`<status>: <reason>`），不把正常源塞满响应。
    #   ★放在顶层（不在 if ($Serve) 里）：这样它可被单测直接调用 —— Serve 块内的函数只有跑起常驻进程才存在。
    # v1.48.2：`-Disabled` 补**被 MCPS_DISABLE 挡在池外**的源 —— 它们不会有 _engineStatus，
    #   不显式补就会出现"名单里没了、reasons 里也没有"的静默空洞。
    param([string[]]$Disabled)
    $out = [ordered]@{}
    foreach ($k in @($script:_engineStatus.Keys | Sort-Object)) {
        $st = [string]$script:_engineStatus[$k]
        if ($st -in @('ok', 'empty')) { continue }
        $rs = [string]$script:_engineStatusReason[$k]
        $out[$k] = if ($rs) { ('{0}: {1}' -f $st, $rs) } else { $st }
    }
    foreach ($n in @($Disabled)) {
        if ($n -and -not $out.Contains($n)) { $out[$n] = 'user-disabled: 已按 MCPS_DISABLE 配置跳过' }
    }
    return [PSCustomObject]$out
}
function Invoke-ServeCached {
    param([string]$Key, [scriptblock]$Factory)
    $disabled = ($env:MCPS_SERVE_CACHE -and $env:MCPS_SERVE_CACHE.Trim() -eq '0')
    if (-not $disabled) {
        $hit = Get-LruResult -Key $Key
        if ($null -ne $hit) { return [PSCustomObject]@{ Cached = $true; Data = @($hit) } }
    }
    $data = @(& $Factory)
    if (-not $disabled -and $data.Count -gt 0) { Set-LruResult -Key $Key -Data $data }
    return [PSCustomObject]@{ Cached = $false; Data = $data }
}

function Get-ServeBoundedInt {
    # v1.78.0：把 schema 声明的数值边界在 -Serve 侧真正兑现（此前只有 limit/maxResults 做了）。
    #   病灶：`inputSchema` 写了 minimum/maximum，但 minStars / activeWithin 在 -Serve 里是裸 [int]，
    #   越界值原样进缓存键与引擎过滤 ⇒ 绕开 MCP 层、直接写 stdout 的客户端能塞进 -1 / 40000。
    #   语义 = clamp（越界夹到边界，不报错），与 limit/maxResults 的历史行为同构 —— 不新造第二种口径。
    #   $Max 用 [object]$null 表示「无上限」：`[int]$Max = $null` 会变成 0（PS 的 $null→int 转换），
    #   那样 maxResults 的"无上限"就会变成"上限 0"——正是本仓记录过的 -21 号坑。
    # v1.81.0：夹紧改在 decimal 域做。此前是 `$v = [int]$Value`，20 位整数（python 侧是合法的 int，
    #   会被夹到上界）在 PS 里直接 Int32 溢出抛异常 ⇒ 两层对同一个值一个"接受并夹紧"、一个"炸掉"。
    param([object]$Value, [int]$Min = 0, [object]$Max = $null, [int]$Default = 0)
    if ($null -eq $Value) { return $Default }
    try { $d = [decimal]$Value } catch { $d = [decimal]::MaxValue }   # 超出 decimal 域 ⇒ 当"非常大"，下面按边界收口
    if ($d -lt [decimal]$Min) { return $Min }
    if ($d -gt [decimal][int]::MaxValue) {
        if ($null -ne $Max) { return [int]$Max }
        return [int]::MaxValue
    }
    $v = [int]$d
    if (($null -ne $Max) -and ($v -gt [int]$Max)) { return [int]$Max }
    return $v
}

function Get-ServeKeyPolicy {
    # v1.79.0：`-Serve` 的**请求键白名单** —— schema 里写着 `additionalProperties: false`，MCP 层
    #   （`build_tool_request`）也真的拒，但 `-Serve` 这一层从来不拒：它按分支逐个 `$req.<key>` 取值，
    #   剩下的键静默丢弃。于是 `{"op":"repo","keyword":"x","minStar":5}`（少一个 s）会**安静地按默认
    #   minStars=100 检索**，返回 0 条且无任何告警 —— 与 v1.74.0 修掉的「拼错的命令行开关被静默忽略」
    #   是同一类错误，只是发生在 JSON 协议层。手写客户端（不经 mcps.py）走的就是这条路。
    #   ★这是参数面的第五份拷贝 ⇒ 必须与 mcps.py 的 MCP_TOOL_OPS 逐 op 对账（门 U-295-H1）。
    #   返回对象而不是裸数组：`return @()` 会被 PS 展开成 `$null`，那样"ping 不接受任何键"与
    #   "未知 op"就分不开了（本仓 -21 号坑的同类变体）。Known=$false 表示该 op 不存在。
    # v1.81.0：表从"键名数组"升级成"键名 → 类型"。v1.79/1.80 只对账**有没有这个键**，类型全靠
    #   PS 强转兜：`{"limit":"5"}` 收下、`{"excludeArchived":"false"}` 被 `[bool]` 读成 $True、
    #   `{"keyword":5}` 把 5 当关键词真去搜 —— 而 mcps.py 对这三例全部抛 ValueError（v1.46.7 就抛了，
    #   只是从来没人问"-Serve 那一层抛不抛"）。类型进表后，两张判据（键集合 H1 / 类型 I1）读同一份数据。
    #   取值：'int' 整数 | 'bool' 布尔 | 'str' 字符串 | 'str!' 必填非空字符串（缺键或空串都拒）。
    param([string]$Op)
    $tbl = @{
        'ping'     = @{}
        'auto'     = @{ keyword = 'str!'; limit = 'int'; maxResults = 'int'; language = 'str'; minStars = 'int'; site = 'str' }
        'research' = @{ keyword = 'str!'; limit = 'int'; maxResults = 'int'; site = 'str' }
        'repo'     = @{ keyword = 'str!'; limit = 'int'; maxResults = 'int'; platforms = 'str'; language = 'str'; minStars = 'int'; activeWithin = 'int'; excludeArchived = 'bool'; license = 'str' }
        'code'     = @{ keyword = 'str!'; limit = 'int'; maxResults = 'int'; language = 'str'; repoScope = 'str'; pathFilter = 'str' }
        'package'  = @{ packages = 'str!' }
    }
    if (-not $tbl.ContainsKey($Op)) { return [PSCustomObject]@{ Known = $false; Keys = @(); Kinds = @{} } }
    $h = $tbl[$Op]
    $keys = if ($h.Count -gt 0) { @($h.Keys | Sort-Object) } else { @() }
    return [PSCustomObject]@{ Known = $true; Keys = $keys; Kinds = $h }
}
function Get-ServeUnknownKeys {
    # v1.79.0：请求里有、该 op 不认、且不是协议键 `op` 的键名（排序后返回；空数组 = 合规）。
    #   `op` 本身是协议键不算参数；未知 op 一律放行给 switch 的 default 分支（那边报 `unknown op`，
    #   两处都报会让同一次错误出现两种文案）。
    # v1.80.0：**键名逐字匹配**（`-cnotcontains`，大小写敏感）。此前用 `-notcontains`，于是
    #   `{"op":"repo","keyword":"x","MinStars":5}` 在这层被放行（PS 属性读取也是大小写不敏感的，
    #   于是连值都真的用上了），而 mcps.py 对同一个 `MinStars` 直接判 "unexpected arguments" ——
    #   **同一份输入，两层判定相反**。JSON 的成员名是大小写敏感的（schema 的 properties 全小写），
    #   这里按 python 的口径对齐；`op` 仍保持宽容（协议键、没有 python 对端可比，且 PS 天然按
    #   大小写不敏感绑定它 —— 这处不对称是**有意**的，见 U-295-H3 的负例）。
    param($Req, [string]$Op)
    $pol = Get-ServeKeyPolicy -Op $Op
    if (-not $pol.Known) { return @() }
    $names = @()
    if ($null -ne $Req) {
        if ($Req -is [System.Collections.IDictionary]) { $names = @($Req.Keys) }
        else { $names = @($Req.PSObject.Properties | ForEach-Object { [string]$_.Name }) }
    }
    return @($names | Where-Object { $_ -and $_ -ne 'op' -and $pol.Keys -cnotcontains $_ } | Sort-Object)
}
function Get-ServeKeyRejection {
    # v1.79.0：把"该不该拒"与"拒了回什么"收成一处，入口只留一行调用 —— 入口有 1500 行硬上限（U-273-A）。
    #   回 $null = 放行；否则回一整行响应对象（含 allowed，让调用方自己就能改对，不用去翻文档）。
    param($Req, [string]$Op, [long]$Ms = 0)
    $bad = @(Get-ServeUnknownKeys -Req $Req -Op $Op)
    if ($bad.Count -eq 0) { return $null }
    return [PSCustomObject]@{
        ok      = $false
        op      = $Op
        error   = ('unexpected request keys: ' + ($bad -join ','))
        allowed = @((Get-ServeKeyPolicy -Op $Op).Keys)
        ms      = $Ms
    }
}
function Test-ServeIntegral {
    # v1.81.0：JSON 的整数字面量在两个运行时映射成不同 CLR 类型 —— 5.1 给 Int32/Int64（超长给 Decimal），
    #   7 给 Int64（超长给 BigInteger）。只认整数：Double / 带小数的 Decimal / String / Boolean 全不认。
    #   Decimal 只在 **scale=0** 时认（= 字面量没写小数点）：`5.0` 在 5.1 下正是 scale=1 的 Decimal，
    #   而 python 的 `isinstance(5.0, int)` 也是 False ⇒ 两边同判"不是整数"。1e3 两边也都是 Double/float。
    #   ★别用 `.Scale`：`System.Decimal.Scale` 在 .NET Framework（PS 5.1）里**不存在**（PS7 才有），
    #   取不到的属性回 $null，`$null -eq 0` 恒 false ⇒ 20 位整数在 5.1 被误判成"不是整数"、
    #   而 PS7 走 BigInteger 分支放行 —— 同一个函数两个运行时两种判决。用 GetBits 的 flags 位。
    param([object]$Value)
    if ($null -eq $Value) { return $false }
    if ($Value -is [bool]) { return $false }
    if ($Value -is [int] -or $Value -is [long] -or $Value -is [int16] -or $Value -is [byte] -or
        $Value -is [sbyte] -or $Value -is [uint16] -or $Value -is [uint32] -or $Value -is [uint64]) { return $true }
    if ($Value.GetType().Name -eq 'BigInteger') { return $true }
    if ($Value -is [decimal]) { return (((([System.Decimal]::GetBits([decimal]$Value))[3] -shr 16) -band 0xFF) -eq 0) }
    return $false
}
function Get-ServeTypeRejection {
    # v1.81.0：**值的类型**也要两层同判。v1.79/1.80 只管"键名对不对"，值的类型全靠 PS 强转兜 ——
    #   `{"limit":"5"}` 收下当 5 用；`{"excludeArchived":"false"}` 更糟，`[bool]"false"` 是 $True，
    #   客户端说"别排除归档"被读成"排除归档"；`{"keyword":5}` 把 5 当关键词真的发了一轮检索。
    #   mcps.py 对这三例全部抛 ValueError（v1.46.7 就抛了，U-202 C 也只测了 python 那一半）——
    #   同一条纪律"类型不许静默转换"在一个入口生效、在另一个入口躺了 34 个版本。
    #   顺序：先键名再类型（Get-ServeRequestRejection）—— 拼错又类型不对时先报拼错，用户改一次就够。
    #   回 $null = 放行；否则回一整行响应。error 文本与 python 的 ValueError 逐字一致（门 U-295-I1 断言相等）。
    param($Req, [string]$Op, [long]$Ms = 0)
    $pol = Get-ServeKeyPolicy -Op $Op
    if (-not $pol.Known) { return $null }      # 未知 op 交给 default 分支报（两处都报会让同一次错误两种文案）
    $names = @()
    if ($null -ne $Req) {
        if ($Req -is [System.Collections.IDictionary]) { $names = @($Req.Keys) }
        else { $names = @($Req.PSObject.Properties | ForEach-Object { [string]$_.Name }) }
    }
    foreach ($k in @($pol.Kinds.Keys | Sort-Object)) {
        $kind = [string]$pol.Kinds[$k]
        # 大小写敏感地判"这个键到底在不在"：PS 的属性绑定不敏感，靠它判会把 `Limit` 当成 `limit`（H3 管键名，这里不越权）
        $has = (@($names | Where-Object { $_ -ceq $k }).Count -gt 0)
        $v = if ($has) { if ($Req -is [System.Collections.IDictionary]) { $Req[$k] } else { $Req.$k } } else { $null }
        if ((-not $has) -or ($null -eq $v)) {
            # python 侧：`args.get(k)` 为 None ⇒ 必填键报"required"，可选键当没传（`... is not None` 守卫）
            if ($kind -eq 'str!') { return [PSCustomObject]@{ ok = $false; op = $Op; error = ('{0} is required (non-empty string)' -f $k); ms = $Ms } }
            continue
        }
        $good = if ($kind -eq 'int') { Test-ServeIntegral -Value $v }
                elseif ($kind -eq 'bool') { $v -is [bool] }
                else { $v -is [string] }
        if (-not $good) {
            $why = if ($kind -eq 'int') { 'an integer' } elseif ($kind -eq 'bool') { 'a boolean' } else { 'a string' }
            $msg = if ($kind -eq 'str!') { '{0} is required (non-empty string)' -f $k } else { '{0} must be {1}' -f $k, $why }
            return [PSCustomObject]@{ ok = $false; op = $Op; error = $msg; ms = $Ms }
        }
        if (($kind -eq 'str!') -and [string]::IsNullOrWhiteSpace([string]$v)) {
            return [PSCustomObject]@{ ok = $false; op = $Op; error = ('{0} is required (non-empty string)' -f $k); ms = $Ms }
        }
    }
    return $null
}
function Get-ServeRequestRejection {
    # v1.81.0：分发前的两道闸合成一个入口（入口 1500 行硬上限，接线只留一行）。
    #   ① 键名白名单（v1.79，含 v1.80 的大小写逐字匹配）② 值的类型（v1.81）。
    param($Req, [string]$Op, [long]$Ms = 0)
    $r = Get-ServeKeyRejection -Req $Req -Op $Op -Ms $Ms
    if ($null -ne $r) { return $r }
    return Get-ServeTypeRejection -Req $Req -Op $Op -Ms $Ms
}
