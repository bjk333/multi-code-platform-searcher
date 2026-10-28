# ==============================================================================
# lib/engines.ps1 -- Multi-Code-Platform Searcher | B3-2 模块拆分（v1.54.0）
#
# 引擎编排：Runspace 池、依赖注入、按引擎截止、健康记忆、并发检索（repo/code/research）、
#   仓库作用域与质量筛选、本地检索与下载。
#
# 契约：本文件只定义（函数 / $script: 数据），无顶层副作用；由主脚本按固定顺序点源加载。
#   · 作用域：点源进主脚本作用域，故 $script: 指向主脚本；版本号/参数等由主脚本提供。
#   · 不要在这里 exit、不要写 stdout：进度与产物分别走 Write-ColorOutput / Write-PayloadOutput。
#   · 新增函数放对应模块；跨模块调用无需前置声明（全部在运行前定义完毕）。
# ==============================================================================

# ─────────────────────────────────────────────────────────────────────────────
# U-167（2026-10-04）：三个**可注入**助手从 engines/ 搬到这里。
#   为什么在主脚本：U-157 C 的既有约定是「Needs 里列的函数必须在主脚本里有实现」——
#   既有 Needs 的每一项（Invoke-ApiRequest / Get-ApiHeaders / Get-StaleCacheResult / Wait-RateLimitToken…）
#   都在主脚本；引擎里定义会让它们成为**唯一例外**。⇒ 主脚本 = 可注入库，engines/ = 各平台薄适配器。
#   注入链本身是运行期 (Get-Item "function:X").Definition ⇒ 位置不影响可注入性，但约定要统一。
# ─────────────────────────────────────────────────────────────────────────────
# ★批次3拆分（2026-10-10）：`Search-GitLabBlobs` 涨到 138 行（U-163-5 红线：engines/ 里任何 >100 行都直接红；
#   U-167 早已把它从 126 行拆到 ≤100，批次1 的改动属**回潮**）。按内聚块拆出下面两个函数，行为逐行等价。
#   ★★它们必须定义在**主脚本**而不是 engines/gitlab-blobs.ps1 —— 与 `Invoke-GitLabProjectBlobSearch`
#   同一个理由（见上方 U-167 约定 + U-157 C 门）：Needs 里登记的函数必须在主脚本有实现，
#   否则 Runspace 注入链取不到定义 ⇒ 池内 CommandNotFound 被 catch 吞成静默 0 命中（U-41 同型）。
#   ★共享可变状态（调用计数 / 预算耗尽 / 回退标志 / 项目路径缓存）走**引用对象** $St 的属性：
#   PowerShell 参数按值传递，[int]/[bool] 直接赋值传不出调用方，只有对象属性改动能回传。
# 发现阶段：全局 blobs →（空则）项目搜索 + 逐项目 blobs；预算不足时截断并发信号给调用方。
function Invoke-GitLabBlobDiscover {
    param([string]$Keyword, $Limit, $Headers, [int]$MaxCalls, $St)
    # v1.25.0：回退链——先试全局 blobs 搜索（企业版/自托管实例可用）；
    # GitLab.com 免费版全局搜索禁用（403 "Global Search is disabled for this scope"），
    # 自动回退「项目搜索 + 逐项目 blobs」：projects?search= 免费版可用，项目级 blobs 搜索亦可用。
    $globalUri = "https://gitlab.com/api/v4/search?scope=blobs&search=$([uri]::EscapeDataString($Keyword))`&per_page=$Limit"
    $data = $null
    # 2026-10-19（P1-gitlab-fallback）：**进程级记忆**「全局搜索对该账号恒 403」。
    #   引擎跑在 runspace 池里（Invoke-EnginePool 每次新建池）⇒ `$script:` 变量跨查询不保留，故走 AppDomain；
    #   收益 = 每查询省 1 次请求（未认证配额仅 60 req/h）与一次往返。
    $globalDisabled = $false
    try { $globalDisabled = [bool][System.AppDomain]::CurrentDomain.GetData('MCPS.GitLabGlobalBlobsDisabled') } catch { }
    if ($globalDisabled) {
        $St.Forbidden = $true   # 能力仍关闭：P0-A 契约要求不得降级成 zero-hit
    } else {
        $St.Calls++
        try {
            $data = (Invoke-ApiRequest -Uri $globalUri -Headers $Headers -TimeoutSec $script:Cfg.CodeRequestTimeoutSec -MaxAttempts $script:Cfg.CodeRequestMaxAttempts).Content | ConvertFrom-Json
            if ($data -is [string]) { try { $data = $data | ConvertFrom-Json } catch { $data = $null } }
        } catch {
            # 全局搜索 403/失败 → 项目级回退
            # 2026-10-18（P0-A）：**403 必须单独标记** —— 它是"该账号层级的能力关闭"，不是限流、不是预算。
            #   不标记的后果（实测）：403 ⇒ data=null ⇒ 回退耗尽预算 ⇒ 只报"预算已用尽"，能力失效被掩盖。
            # U-177：403 有两种 —— 能力关闭（真 forbidden）与配额耗尽（rate-limit）。后者**不得**标 Forbidden。
            $isRlErr = ("$_") -match 'rate-limit|\b429\b|限流'
            if (-not $isRlErr -and ("$_" -match '\b403\b|forbidden|禁止|disabled for this scope')) { $St.Forbidden = $true }
            if ($St.Forbidden) {
                # ★2026-10-19 实测（有 token、keyword=agent）：默认预算 2 被这次**注定失败**的调用吃掉一半
                #   ⇒ 回退路径结构性走不到 blobs ⇒ 免费版每条查询恒 0 命中（2 次调用全用光、blobs 一次未发）。
                #   403 不消耗服务端配额、也不产出数据 ⇒ 不计入预算：预算约束的是"我方发起的有效检索"，
                #   不是"我方先探一次已知会失败的能力"。
                $St.Calls--
                try { [System.AppDomain]::CurrentDomain.SetData('MCPS.GitLabGlobalBlobsDisabled', $true) } catch { }
            }
            $data = $null
        }
    }
    # ★U-265（2026-10-26）实测缺陷：原判据是 `-not ($data -and $data.message)` —— 而 PS 的**成员枚举**
    #   对 N≥2 的元素数组取不存在的属性会返回 `@($null, $null)`，那是**非空数组 ⇒ truthy** ⇒ 守卫判成
    #   "这是错误体" ⇒ 把 2 条真实命中整段丢弃、退回项目级搜索（预算被多吃一次，最坏 0 命中）。
    #   单元素数组返回 $null（falsy）——所以只有"1 条结果"能活下来，2 条以上全被吞：典型的"看起来偶尔正常"。
    #   正确判据：错误体是**单个对象**且带 message；数组即便元素没 message 也不是错误体。
    $isErrBody = ($data -isnot [System.Array]) -and ($data.PSObject.Properties.Name -contains 'message')
    if ($data -and @($data).Count -gt 0 -and -not $isErrBody) { return $data }
    # 空结果也可能是免费版全局禁用（403 时 Invoke-ApiRequest 已 throw，走到这里的是空/含 message 的响应）
    if ($St.Calls -ge $MaxCalls) {
        $St.BudgetHit = $true
        return $data
    }
    $St.UsedFallback = $true
    # ★[void] 保留作双保险：U-266 起 Write-ColorOutput 写 stderr（无返回值），本行已不会污染；
    #   但"值返回函数不写成功流"这条纪律不能只押在被调函数的实现上（它长期就是 Write-Output）。
    #   一旦有人改回去，这里也不会立刻把 $data 撑成字符串数组
    #   （实测过：预算耗尽本该返回空数组，却被这个字符串撑成非空 ⇒ 状态误报为 ok 而非 rate_limited）。判据在门 U-266-A。
    [void](Write-ColorOutput "全局 blobs 搜索不可用（GitLab 免费版限制），回退项目级搜索..." "DarkYellow")
    # ---------- 调用 2：项目搜索 ----------
    $projUri = "https://gitlab.com/api/v4/projects?search=$([uri]::EscapeDataString($Keyword))`&simple=true`&per_page=$Limit"
    $projData = $null
    $St.Calls++
    try { $projData = (Invoke-ApiRequest -Uri $projUri -Headers $Headers -TimeoutSec $script:Cfg.CodeRequestTimeoutSec -MaxAttempts $script:Cfg.CodeRequestMaxAttempts).Content | ConvertFrom-Json }
    catch {
        # 批次B·C7（2026-10-11）：429 / 限流等待过长 **不得吞成**「项目级回退：未搜到匹配项目」——那是服务端限流（配额耗尽），
        #   必须上抛给 Search-GitLabBlobs 的 catch 按 rate_limited + 配额文案上报。此前调用1/调用2 两级 catch 全吞 429
        #   ⇒ 批1动作3 给 blobs 写的 429 文案实际不可达（探针实证：429 ⇒ status=empty + 假文案）。
        #   调用1（全局 blobs）的 429 仍走回退不上抛：search 级限流不必然代表 /projects 也限流，保留可用性；
        #   预算=1 时调用1 失败即预算耗尽，仍按 empty（我方主动封顶）上报，不在此改。
        if ("$_" -match 'rate-limit') { throw }   # U-177：限流必须上抛（否则被吞成 empty + 假文案）
        if ("$_" -match '\b429\b|限流等待过长') { throw }
        # ★U-265：401 也必须上抛。原写法把它吞成"回退"⇒ 项目搜索再失败 ⇒ 最终报 zero-hit
        #   （"搜了没结果"），而事实是 token 无效 —— 缺凭据被伪装成"库里没有"，是本仓最不能接受的一类假结论。
        if ("$_" -match '\b401\b|Unauthorized|未经授权') { throw }
        $projData = $null
    }
    if (-not $projData -or @($projData).Count -le 0) { return @() }
    $St.ProjCount = @($projData).Count
    foreach ($proj in @($projData)) { if ($proj.id) { $St.ProjCache[[string]$proj.id] = $proj.path_with_namespace } }
    # ---------- 调用 3+：逐项目 blobs（受剩余预算截断） ----------
    $remaining = $MaxCalls - $St.Calls
    if ($remaining -le 0) {
        $St.BudgetHit = $true
        return @()
    }
    # Invoke-GitLabProjectBlobSearch 内部会把项目数截到 min(count, max(3, Limit))；
    # 这里再按剩余预算收紧，保证总调用不越界。调用数按实际发起的项目数记账。
    $want = [math]::Min(@($projData).Count, [math]::Max(3, $Limit))
    if ($want -gt $remaining) {
        $projData = @($projData | Select-Object -First $remaining)
        $St.BudgetHit = $true
    }
    $St.Calls += @($projData).Count
    $St.BlobsSearched = $true   # 2026-10-19：供状态文案区分「检索了但无命中」与「预算耗在项目搜索上、blobs 未发」
    return @(Invoke-GitLabProjectBlobSearch -Keyword $Keyword -Limit $Limit -ProjData $projData)
}
# 映射阶段：逐条构造结果对象，必要时按预算补全 project path（超额时退化为不可点击 API URL，不丢结果）。
function ConvertTo-GitLabBlobResults {
    param($Data, $Headers, [int]$MaxCalls, $St)
    # 去重 project_id，解析 path_with_namespace 以构造可点击的 blob URL（搜索结果本身不含项目路径）
    # v1.33.0 P1：路径优先取项目搜索缓存（键统一 string），未命中才逐个 GET（全局搜索命中路径的正常情形）
    $results = @(); $i = 1
    foreach ($item in $Data) {
        $projectId = if ($item.project_id) { $item.project_id } elseif ($item.id) { $item.id } else { $null }
        if ($null -eq $projectId) { continue }
        if (-not $St.ProjCache.ContainsKey([string]$projectId)) {
            # 批次1动作2：路径补全 GET 也吃预算——超额时**不放弃结果**，只是退化为不可点击的 API URL。
            if ($St.Calls -ge $MaxCalls) {
                $St.ProjCache[[string]$projectId] = $null
                $St.BudgetHit = $true
            } else {
                $St.Calls++
                try {
                    $proj = (Invoke-ApiRequest -Uri "https://gitlab.com/api/v4/projects/$projectId" -Headers $Headers -TimeoutSec $script:Cfg.CodeRequestTimeoutSec -MaxAttempts $script:Cfg.CodeRequestMaxAttempts).Content | ConvertFrom-Json
                    $St.ProjCache[[string]$projectId] = if ($proj -and $proj.path_with_namespace) { $proj.path_with_namespace } else { $null }
                } catch { $St.ProjCache[[string]$projectId] = $null }
            }
        }
        $ns = $St.ProjCache[[string]$projectId]
        $blobUrl = if ($ns) { "https://gitlab.com/$ns/-/blob/$($item.ref)/$($item.path)" } else { "https://gitlab.com/api/v4/projects/$projectId/repository/blobs" }
        # v1.46.9：带上行锚点 —— 证据要能直接跳到那一行（searchcode 通道早已如此，GitLab 侧此前只有文件级链接）
        if ($ns -and $item.startline) { $blobUrl = "$blobUrl#L$($item.startline)" }
        $preview = if ($item.data) { $item.data } else { $null }
        $results += [PSCustomObject]@{ Index = $i; Platform = "GitLabBlobs"; Name = $(if ($ns) { $ns } else { "project#$projectId" }); File = $item.path; Line = $item.startline; Preview = $preview; Url = $blobUrl; Desc = $null }
        $i++
    }
    return $results
}
function Invoke-GitLabRepoScopedBlobs {
    # v1.46.9（T1-3）：GitLab **项目级** blob 检索 —— `-RepoScope` 指向 gitlab 宿主时走这里，
    #   不再跑"全局 blobs → 项目搜索 → 逐项目 blobs"的发现链（那条链是给**关键词**检索用的，不是给仓库作用域用的）。
    #   依据（2026-10-21 实测）：Free 版全局搜索对该账号层级 403；而
    #   `GET /projects/{group%2Fproject}/search?scope=blobs&search=…`（token）返回 200 + 结构化命中（path/startline/data/ref）。
    #   ★路径直接 URL-编码进 `:id`（GitLab 接受编码后的全路径）⇒ **1 次请求**，无需先解析 project id。
    #   ★B2-1（U-265）：本函数**不再写状态**（原文是 ok/empty 两处 Set-EngineStatus）—— 判定归 L1，
    #     由 Search-GitLabBlobs 用一个出口统一构造封套。失败仍一律 throw，由主函数的 catch 按 401/429/其它分类。
    param([string]$Keyword, [int]$Limit, $Headers, [string]$RepoSlug)
    $perPage = [math]::Min(100, [math]::Max(1, $Limit))
    $u = "https://gitlab.com/api/v4/projects/$([uri]::EscapeDataString($RepoSlug))/search?scope=blobs&search=$([uri]::EscapeDataString($Keyword))&per_page=$perPage"
    $data = $null
    try {
        $data = (Invoke-ApiRequest -Uri $u -Headers $Headers -TimeoutSec $script:Cfg.CodeRequestTimeoutSec -MaxAttempts $script:Cfg.CodeRequestMaxAttempts).Content | ConvertFrom-Json
    } catch {
        if (("$_") -match '\b404\b') { throw ("GitLab 项目不存在或无权访问：{0}（404；需要公开项目且路径为 group/project）" -f $RepoSlug) }
        throw
    }
    # PS 版本差异（同 R5 坑族）：PS7 把 `'[]'` 解析成 $null，且会把**单元素数组**展开成单个对象；PS5.1 都保持数组。
    #   ⇒ 空就是空（不是失败）；单条有 `path` 的就是结果（包回数组）；只有 message/error 的才是错误体。
    if ($null -eq $data) { $data = @() }
    elseif ($data -isnot [System.Array]) {
        if ($data.PSObject.Properties.Name -contains 'path') { $data = @($data) }
        else {
            $m = if ($data.message) { [string]$data.message } else { ($data | ConvertTo-Json -Compress -Depth 3) }
            throw ("GitLab 项目 blobs 返回非数组：{0}" -f $m)
        }
    }
    # 结果整形复用全局路径的函数：预置 ProjCache 后它不会再去 GET 项目路径（本项目已知道 slug）
    $st = [PSCustomObject]@{ Calls = 1; BudgetHit = $false; UsedFallback = $true; ProjCache = @{}; Forbidden = $false; ProjCount = 1; BlobsSearched = $true }
    $st.ProjCache['__repo__'] = $RepoSlug
    foreach ($b in @($data)) {
        if ($b.project_id) { $st.ProjCache[[string]$b.project_id] = $RepoSlug }
        else { try { $b | Add-Member -NotePropertyName project_id -NotePropertyValue '__repo__' -Force } catch { } }
    }
    $results = @(ConvertTo-GitLabBlobResults -Data $data -Headers $Headers -MaxCalls 1 -St $st)
    # ★[void] 保留作双保险：U-266 起 Write-ColorOutput 写 stderr（无返回值），判据在门 U-266-A
    [void](Write-ColorOutput ("GitLab 仓库内命中 {0} 条（{1}）" -f $results.Count, $RepoSlug) "Green")
    return $results
}
# ★U-167（2026-10-04）：从 `Search-GitLabBlobs` 抽出的「项目级 blobs 并行检索」（原体内联 126 行 ⇒ 主函数降到 80 行）。
#   抽它的理由：它是**独立可测的一步**（拿一批项目 → 并行打各项目 blobs → 汇总），与主函数的
#   「令牌守卫 / 全局搜索 / 回退判定 / 结果映射 / 401 分类」互不相干 ⇒ 内联只会让每一层都变长。
#   ★行为不变：代码逐字搬迁；唯一差别是**数据回传方式**（原来就地累加 $data，现在 return）。
function Invoke-GitLabProjectBlobSearch {
    # ★param 名与体内用法**大小写对齐**（写成 $projData）：变量名本不敏感，但 U-53 的 AST 检查按大小写匹配
    #   ⇒ 若 param 写成 $ProjData，体内那个 $projData 会被判为「未注入的外部变量」而红。
    param($Keyword, $Limit, $projData)
    # 2026-10-19：每项目页大小跟随 -Limit（GitLab 上限 100；未给 Limit 时保持旧的 3）
    $perPage = if ($Limit) { [math]::Min(100, [math]::Max(1, [int]$Limit)) } else { 3 }
            $projLimit = [math]::Min(@($projData).Count, [math]::Max(3, $Limit))
            $blobTargets = @(@($projData | Select-Object -First $projLimit) | Where-Object { $_.id })
            # v1.33.0 P1：项目级 blobs 检索并行化（嵌套 Runspace 池，复用 H1/H2 注入规范）——
            # N 个项目各 1 请求，串行 → 并行省 (N-1)×单请求延迟；单项目失败静默跳过（与旧串行语义一致）
            $data = @()
            $blobPool = $null
            try {
                $defs2 = @()
                # U-41（N-18）：嵌套池的注入列表改从单源取 —— 此前手工列表漏 Invoke-WebRequestDirect（U-40 引入）⇒ 池内
                # Invoke-ApiRequest 抛 CommandNotFoundException 被下方 catch 吞掉 ⇒ 项目级 blobs 并行路径静默 0 命中（相对 v1.37.7 回归）。
                foreach ($fn in (Get-HttpLayerClosure)) {
                    if (Test-Path "function:$fn") { $defs2 += "function $fn { $((Get-Item "function:$fn").Definition) }" }
                }
                $inject2 = @{ VERSION = $VERSION; Cfg = $script:Cfg; NodeEnginePath = $script:NodeEnginePath; NodeExePath = $script:NodeExePath; ProxyMode = $script:ProxyMode; _sysProxyMode = $script:_sysProxyMode; _networkRoutes = $script:_networkRoutes; _networkFailures = $script:_networkFailures; _networkHttpResponses = $script:_networkHttpResponses; _networkDeadHosts = $script:_networkDeadHosts; _proxyBreaker = $script:_proxyBreaker; _routeTrace = $script:_routeTrace; _networkEngine = 'GitLabBlobs' }   # U-155/U-206：嵌套池与主池共享逐域路由/skip/选路证据，N-18 单源函数闭包不遗漏
                $blobPool = [runspacefactory]::CreateRunspacePool(1, [math]::Max(1, $blobTargets.Count))
                $blobPool.ApartmentState = 'MTA'
                $blobPool.Open()
                $blobHandles = @()
                foreach ($proj in $blobTargets) {
                    $ps2 = [powershell]::Create()
                    $ps2.RunspacePool = $blobPool
                    [void]$ps2.AddScript({
                        param($Defs, $ProjectId, $Keyword, $Inject, $PerPage)
                        foreach ($d in $Defs) { . ([scriptblock]::Create($d)) }
                        foreach ($k in $Inject.Keys) { Set-Variable -Name $k -Value $Inject[$k] }
                        # B2-6（U-261）：嵌套池的账本归属。此处是 GitLabBlobs 自己的项目级 fan-out ⇒ 常量而非参数
                        #   （不设的话这些行会记成 engine=''，看起来像"主流程发的请求"，比缺一行更误导）。
                        $script:_ledgerEngine = 'GitLabBlobs'; $script:_ledgerMode = 'code'
                        $hdrs = Get-ApiHeaders -Token $env:GITLAB_TOKEN -Scheme "PrivateToken"
                        # 2026-10-19：页大小改为跟随 -Limit（原写死 3 —— 与 CLI 的「每源页大小」口径不符，
                        #   且 `Select-Object -First 3` 再截一次，等于 Limit 在回退路径上被静默忽略）。GitLab 上限 100。
                        $u = "https://gitlab.com/api/v4/projects/$ProjectId/search?scope=blobs&search=$([uri]::EscapeDataString($Keyword))&per_page=$PerPage"
                        $bd = $null
                        try { $bd = (Invoke-ApiRequest -Uri $u -Headers $hdrs -TimeoutSec $script:Cfg.CodeRequestTimeoutSec -MaxAttempts $script:Cfg.CodeRequestMaxAttempts).Content | ConvertFrom-Json } catch { $bd = $null }
                        $hits = @()
                        if ($bd -and @($bd).Count -gt 0) {
                            foreach ($b in (@($bd) | Select-Object -First $PerPage)) {
                                # 项目级 blobs 结果缺 project_id，用所属项目补上
                                if (-not $b.project_id) { try { $b | Add-Member -NotePropertyName project_id -NotePropertyValue $ProjectId -Force } catch { } }
                                $hits += $b
                            }
                        }
                        return $hits
                    }).AddArgument($defs2).AddArgument([int]$proj.id).AddArgument($Keyword).AddArgument($inject2).AddArgument([int]$perPage)
                    $blobHandles += [PSCustomObject]@{ PS = $ps2; Handle = $ps2.BeginInvoke() }
                }
                foreach ($bh in $blobHandles) {
                    try {
                        $res2 = $bh.PS.EndInvoke($bh.Handle)
                        foreach ($item in @($res2)) { if ($item) { $data += $item } }
                    } catch { }
                    finally { try { $bh.PS.Dispose() } catch { } }
                }
            } finally { if ($blobPool) { try { $blobPool.Close(); $blobPool.Dispose() } catch { } } }
    return $data
}
# ★U-167（2026-10-04）：从 `Search-PackageRegistries` 抽出的「npm 周下载量补全」。
#   抽它的理由：这是**独立关切** —— 把 crates/Maven/npm 混在一起的检索，与"把 npm 的代理热度换成
#   真实下载量、换不到就诚实标 popularity (proxy)"是两件事。内联只会让两层都变长、也难单独测。
function Set-NpmDownloadStats {
    param($Results, $UserAgent)
    $results = $Results          # 下面逐字沿用原变量名，避免改动搬运过来的代码
    $ua = $UserAgent
    $npmItems = @($results | Where-Object { $_.Platform -eq 'npm' })
    if ($npmItems.Count -gt 0) {
        $npmNames = @($npmItems | ForEach-Object { [string]$_.Name } | Select-Object -Unique)
        $dlMap = $null
        try {
            # v1.34.0 验收修复：批量端点的逗号分隔名单位于 URL 路径段，scoped 包名含 '/'（如 @fastify/jwt）
            # 会被当作路径分隔符致整批失败（实测全批降级 proxy）——scoped 拆出逐个查询（literal path 合法），
            # 非 scoped 名字保持批量。
            $dlMap = @{}
            $plain = @($npmNames | Where-Object { $_.IndexOf('/') -lt 0 })
            $scoped = @($npmNames | Where-Object { $_.IndexOf('/') -ge 0 })
            if ($plain.Count -gt 0) {
                $dlUri = "https://api.npmjs.org/downloads/point/last-week/$($plain -join ',')"
                # U-243：这里是**增强**不是主结果 —— 失败只是保留 popularity 代理值（下方已有降级分支）。
                #   实测该端点 3/10 会挂死；给 3s + 单次尝试，宁可少一次"真下载量"，不拖 20s×3。
                $dlRaw = (Invoke-ApiRequest -Uri $dlUri -Headers $ua -TimeoutSec $script:Cfg.NpmDownloadTimeoutSec -MaxAttempts 1).Content | ConvertFrom-Json
                foreach ($p2 in @($dlRaw.PSObject.Properties)) {
                    if ($p2.Name -eq 'downloads') { $dlMap[[string]$dlRaw.package] = [long]$p2.Value }   # 单包：{downloads,package,...}
                    else { try { $dlMap[$p2.Name] = [long]$p2.Value.downloads } catch { } }              # 批量：{name:{downloads,...}}
                }
            }
            foreach ($sn in $scoped) {
                try {
                    $dlRaw2 = (Invoke-ApiRequest -Uri "https://api.npmjs.org/downloads/point/last-week/$sn" -Headers $ua -TimeoutSec $script:Cfg.NpmDownloadTimeoutSec -MaxAttempts 1).Content | ConvertFrom-Json
                    if ($dlRaw2 -and $null -ne $dlRaw2.downloads) { $dlMap[$sn] = [long]$dlRaw2.downloads }
                } catch { }
            }
            if ($dlMap.Count -eq 0) { $dlMap = $null }
        } catch { $dlMap = $null }
        foreach ($it in $npmItems) {
            if ($dlMap -and $dlMap.ContainsKey([string]$it.Name)) {
                try { $it | Add-Member -NotePropertyName Stars -NotePropertyValue ($dlMap[[string]$it.Name]) -Force } catch { }
                try { $it | Add-Member -NotePropertyName Unit -NotePropertyValue 'downloads/week' -Force } catch { }
            } else {
                try { $it | Add-Member -NotePropertyName Unit -NotePropertyValue 'popularity (proxy)' -Force } catch { }
            }
        }
        if ($dlMap) { Write-ColorOutput "npm 周下载量补全成功（$(@($npmItems | Where-Object { $_.Unit -eq 'downloads/week' }).Count)/$($npmItems.Count)）" "Green" }
        else { Write-ColorOutput "npm 下载量 API 失败，保留 popularity 代理值（Unit=popularity (proxy)）" "DarkYellow" }
    }
}
# ★U-167（2026-10-04）：从 `Search-GitHub` 抽出的「陈旧缓存兜底」。
#   抽它的理由：它是**失败路径上的一整个独立步骤**（取近 TTL 缓存 → 复制并标 Stale/Index → 记状态与告警），
#   与主流程的「分页检索 / 限流等待 / 认证判定」互不相干 ⇒ 内联只会把 try/catch 撑到 100 行以上。
function Get-GitHubStaleFallback {
    # ★param 名与体内用法**大小写对齐**（写成 $cacheKey）：变量名本不敏感，但 U-53 的 AST 检查按大小写匹配
    #   ⇒ 若 param 写成 $CacheKey，体内那个 $cacheKey 会被判为「未注入的外部变量」而红。
    param($cacheKey)
                $stale = Get-StaleCacheResult -Key $cacheKey
                if ($stale -and @($stale).Count -gt 0) {
                    Write-ColorOutput "GitHub 实时检索失败，回退陈旧缓存 ($($stale.Count) 条, Stale)" "DarkYellow"
                    $out = @(); $i = 1
                    foreach ($r in $stale) {
                        $r2 = $r.PSObject.Copy()
                        try { $r2 | Add-Member -NotePropertyName Stale -NotePropertyValue $true -Force } catch { }
                        try { $r2 | Add-Member -NotePropertyName Index -NotePropertyValue $i -Force } catch { }
                        $out += $r2; $i++
                    }
                    # ★B2-1（U-263）：不再自报 ok —— 池侧对 engine/1 引擎会用 Resolve-EngineVerdict 覆盖状态，
                    #   写在这里是**死代码 + 第二个真源**。"结果可能是旧的"由 `Stale=true` 与下面这条 warning 承载。
                    Add-EngineWarning -Engine 'GitHub' -Message "实时检索失败，回退陈旧缓存 (仅提示，结果可能陈旧)"
                    return $out
                }
    return @()          # 无可用陈旧缓存 ⇒ 空数组（调用点据此不 return，继续走 continue）
}
function Invoke-GiteeV5Fallback {
    # U-163-5 拆分（2026-10-10）：原内联在 Search-Gitee 的 catch 里（33 行）⇒ 主函数 114 行、超 100 上限。
    #   语义不变：v5 回退 + **每个出口显式设引擎状态**（R5-TLS：失败必须上报，不被池尾兜成 empty）。
    #   ★本函数必须进注册表 Needs（池内 dot-source 注入），否则池内报"未识别为 cmdlet"。
    param($Keyword, $MinStars, $Language, $Limit, $PerPage)
    try {
        $uri = "https://gitee.com/api/v5/search/repositories?q=$([uri]::EscapeDataString($Keyword))&order=desc&per_page=$PerPage"
        if ($env:GITEE_TOKEN) { $uri += "&access_token=$($env:GITEE_TOKEN)" }
        $data2 = (Invoke-ApiRequest -Uri $uri -Headers @{}).Content | ConvertFrom-Json
        if (-not $data2 -or $data2.Count -eq 0) {
            Write-ColorOutput "Gitee v5 也 0 命中" "Yellow"
            # v1.46.0（2026-10-20 实测）：v5 `/search/repositories` **匿名恒返空数组**（带无效 token 反而 401；Gitee Feedback #ICCSIY）。
            #   此前一律记 empty ⇒ ReasonCode=zero-hit，把「没登录所以没执行」说成「搜了但没有」。
            #   分档：无 token ⇒ auth_missing（blocked，提示配 GITEE_TOKEN）；有 token ⇒ 仍 empty（服务端内容风控未解除，如实记账）。
            if (-not $env:GITEE_TOKEN) {
                Set-EngineStatus -Name 'Gitee' -Status 'auth_missing' -Reason 'Gitee v5 搜索需登录（匿名恒返空数组，实测 2026-10-20）且 so.gitee.com 通道本次失败 ⇒ 本次 Gitee 未执行；设 GITEE_TOKEN 后重试'
                Add-EngineWarning -Engine 'Gitee' -Message 'v5 回退匿名恒返空数组 ⇒ 本次未执行（非零命中）；设 GITEE_TOKEN 或稍后重试 so 通道' -From 'api/v5/search/repositories' -To 'skip (auth_required)'
            } else {
                Set-EngineStatus -Name 'Gitee' -Status 'empty' -Reason '检索成功但 0 命中（v5 带 GITEE_TOKEN；Gitee 服务端内容风控未解除，勿当真实零命中）'
            }
            return @()
        }
        $all2 = @($data2 | Sort-Object stargazers_count -Descending)
        $results2 = @(); $i2 = 1
        foreach ($item in $all2) {
            if ($item.stargazers_count -ge $MinStars -and (-not $Language -or (([string]$item.language).ToLower() -eq $Language.ToLower()))) {
                $results2 += [PSCustomObject]@{ Index = $i2; Platform = "Gitee"; Name = $item.full_name; Stars = $item.stargazers_count; Unit = 'stars'; Url = $item.html_url; Desc = $item.description; License = $null; Updated = $item.updated_at }
                $i2++
            }
        }
        if ($results2.Count -eq 0) { Set-EngineStatus -Name 'Gitee' -Status 'empty' -Reason '检索成功但 0 命中' }
        else { Set-EngineStatus -Name 'Gitee' -Status 'ok' -Reason '' }
        return $results2
    }
    catch {
        Write-ColorOutput "Gitee 搜索失败: $_" "Red"
        Set-EngineStatus -Name 'Gitee' -Status 'error' -Reason "检索失败: $($_.Exception.Message)"
        Add-EngineWarning -Engine 'Gitee' -Message "[Gitee] 检索失败：$($_.Exception.Message)" -From 'engine' -To 'error'
        return @()
    }
}
# H2 静态检查（诊断/验收用）：扫描引擎函数与依赖函数文本，枚举引用到的外部变量
# （非 param、非 $env、非自动变量、非函数内已赋值变量、非白名单），用于发现 Runspace 文本化重建后的 $null 隐患。
# 启发式：函数内被赋值（$x = ...）或作为 foreach 循环变量的视为局部变量，不报。
function Assert-EngineDeps {
    param($Engines)
    $auto = @('_','args','null','true','false','this','input','Matches','LASTEXITCODE','ErrorActionPreference','Host','PSScriptRoot','PSCommandPath','MyInvocation','PWD','PID','HOME','env','script','global','local','private','Error','PSItem','foreach','switch')
    $findings = @()
    foreach ($e in $Engines) {
        $fnList = @($e.Func) + @($e.Needs)
        foreach ($fn in $fnList) {
            if (-not (Test-Path "function:$fn")) { continue }
            $text = (Get-Item "function:$fn").Definition
            # v1.39.0（归并修复）：变量/局部扫描先去注释（与本函数 D4 对命令扫描同一近似口径）——
            #   注释里提及的变量名不该产生 finding。实测基线（2026-10-07）：engines/github.ps1 的注释含
            #   "原块是 return $out" ⇒ 误报 Search-GitHub -> $out，令 test-inject 组基线 rc=1。
            $textScan = ($text -split "`n" | ForEach-Object { $_ -replace '(^|\s)#.*$', '$1' }) -join "`n"
            $params = @()
            # v1.36.3：参数改由 AST 收集（含函数体内嵌脚本块的 param，如 Runspace AddScript({ param($Defs,...) })）；
            # 旧 regex 只取第一个 param(...) ⇒ 内嵌脚本块参数被误报（实测 Search-GitLabBlobs -> $Defs/$Inject）。AST 失败时回落旧 regex。
            try {
                $ast = [scriptblock]::Create($text).Ast
                $params = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.ParameterAst] }, $true) | ForEach-Object { $_.Name.VariablePath.UserPath })
            } catch { $params = @() }
            if ($params.Count -eq 0 -and $text -match '(?s)param\((?<p>.*?)\)') {
                $params = @($Matches['p'] -split ',' | ForEach-Object { ($_ -replace '\[[^\]]*\]', '').Trim().TrimStart('$') -split '\s+' | Select-Object -First 1 })
            }
            # 局部变量：函数内被赋值 / foreach 循环变量
            $locals = @()
            $locals += [regex]::Matches($textScan, '\$([A-Za-z_][A-Za-z0-9_]*)\s*=') | ForEach-Object { $_.Groups[1].Value }
            $locals += [regex]::Matches($textScan, 'foreach \(\$([A-Za-z_][A-Za-z0-9_]*) in') | ForEach-Object { $_.Groups[1].Value }
            $locals = @($locals | Sort-Object -Unique)
            # v1.36.3：修 $script: 前缀盲区——旧 regex 把 `$script:x` 截成 `script`（命中 $auto 白名单）⇒ 对 $script:x 引用恒 0 findings。
            # 现剥掉 script: 前缀取真实变量名；(?![\w:]) 让 `$env:X`/`$global:X` 等作用域限定整体不入候选（与旧行为一致）。
            $cands = [regex]::Matches($textScan, '\$(?:script:)?([A-Za-z_][A-Za-z0-9_]*)(?![\w:])') | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique
            foreach ($v in $cands) {
                if ($auto -contains $v -or $params -contains $v -or $locals -contains $v) { continue }
                if ($script:_injectVars -notcontains $v) { $findings += "$fn -> `$$v" }
            }
        }
        # ---- U-49（R16 Wave A，2026-09-26）：本函数此前只查"外部变量 $null 隐患"，不查"依赖是否补齐"——N-18 本可被它抓到。
        #      现补三向：① Func 必须存在；② 用到 Invoke-ApiRequest 的引擎，其注入集必须含 HTTP 层闭包（Get-HttpLayerClosure）全部；
        #      ③ Func + Needs（+ 闭包）必须覆盖各自函数体内出现的全部自定义命令（Verb-Noun 且本脚本定义了同名函数）。
        #      每条 finding 都带「引擎名 + 函数名」。
        # v1.45.2（2026-10-20 全量验收 P1-2）：只认**本技能目录内定义**的函数。
        #   旧写法 `Get-ChildItem function:` 取的是**进程**函数表 ⇒ 宿主注入的同名包装会被当成
        #   「本脚本定义的自定义函数」：WorkBuddy 宿主的 safe-delete `Remove-Item`（ScriptBlock.File 为空）
        #   使 22 个引擎各报 2 条 `… 调用 Remove-Item（不在 Func+Needs+闭包）` ⇒ test-inject 40 条假 finding、
        #   本地门 6/1/5 假红；同一份代码在 `powershell.exe -NoProfile` 干净会话是 7/0/5 全绿。
        #   判定口径与 Node 侧 test-n8 的 definedFns（从源码 `^function` 正则派生）对齐。
        $skillDirResolved = $ScriptDir
        try { if ($ScriptDir) { $skillDirResolved = (Resolve-Path -LiteralPath $ScriptDir -ErrorAction Stop).Path } } catch { }
        $definedFns = @(Get-ChildItem function: | Where-Object {
            $fnFile = $null; try { $fnFile = $_.ScriptBlock.File } catch { }
            $fnFile -and $skillDirResolved -and $fnFile.StartsWith($skillDirResolved, [System.StringComparison]::OrdinalIgnoreCase)
        } | ForEach-Object { $_.Name })
        if (-not (Test-Path "function:$($e.Func)")) { $findings += ("{0}: Func {1} 未定义" -f $e.Name, $e.Func); continue }
        $injectSet = @(@($e.Func) + @($e.Needs))
        $usesHttp = $injectSet -contains 'Invoke-ApiRequest'
        $closure = @()
        if ($usesHttp) {
            $closure = @(Get-HttpLayerClosure)
            # U-74（N-22）：旧写法 `-and -not ($closure -contains $cf)` 对来自 $closure 的 $cf 恒假 ⇒ 死断言。改为对**实际注入路径**断言：
            # 经 Get-EngineNeeds 展开后的注入集必须 ⊇ 闭包（这才是 Runspace 里真正 dot-source 的集合）。
            $expanded = @(Get-EngineNeeds -Engines @($e))
            foreach ($cf in $closure) { if ($expanded -notcontains $cf) { $findings += ("{0}: Get-EngineNeeds 展开后缺 HTTP 闭包函数 {1}" -f $e.Name, $cf) } }
        }
        $effective = @($injectSet + $closure | Sort-Object -Unique)
        # D4（2026-09-30）：扫描范围从 Func+Needs 扩到 Func+Needs+闭包 —— HTTP 层已拆成多个 helper（如 Invoke-WebRequestDirect 现由 Invoke-ApiWebOnce 调用），
        #   只扫 injectSet 会漏掉"闭包成员之间"的调用（U-74 断言③在 D4 后变空）。Node 门 guardU49 同步改为扫 effective。
        foreach ($fn in $effective) {
            if (-not (Test-Path "function:$fn")) { continue }
            $body = (Get-Item "function:$fn").Definition
            $body = ($body -split "`n" | ForEach-Object { $_ -replace '(^|\s)#.*$', '$1' }) -join "`n"   # 去注释再扫
            $calls = [regex]::Matches($body, '(?<![\w$-])([A-Z][a-z]+-[A-Za-z0-9]+)') | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique
            foreach ($c in $calls) {
                if ($definedFns -notcontains $c) { continue }
                if ($effective -notcontains $c) { $findings += ("{0}: {1} 调用 {2}（不在 Func+Needs+闭包）" -f $e.Name, $fn, $c) }
            }
        }
    }
    return $findings
}
# 容错删除：清理临时文件不应导致整个下载被判失败（部分环境会拦截删除操作）
function Remove-Safe {
    param($Path, [switch]$Recurse)
    try { Remove-Item -Path $Path -Recurse:$Recurse -Force -ErrorAction Stop } catch { }
}
function Download-Repo {
    param($RepoFullName, $Platform, $OutputPath = ".\downloads")

    # L3 修复：校验仓库名格式，避免路径穿越
    if ($RepoFullName -notmatch '^[\w.\-]+/[\w.\-]+$') {
        Write-ColorOutput "仓库名格式应为 owner/repo，已忽略: $RepoFullName" "Red"
        return
    }

    if (-not (Test-Path $OutputPath)) { New-Item -ItemType Directory -Path $OutputPath -Force | Out-Null }

    $baseUrls = @{ GitHub = "https://github.com"; Gitee = "https://gitee.com"; GitLab = "https://gitlab.com"; Gitea = "https://gitea.com"; Bitbucket = "https://bitbucket.org" }
    $baseUrl = if ($baseUrls[$Platform]) { $baseUrls[$Platform] } else { $baseUrls["GitHub"] }

    $apiUrls = @{ GitHub = "https://api.github.com/repos/$RepoFullName"; Gitee = "https://gitee.com/api/v5/repos/$RepoFullName"; GitLab = "https://gitlab.com/api/v4/projects/$($RepoFullName.Replace('/', '%2F'))" }
    $defaultBranch = "main"
    $apiUrl = $apiUrls[$Platform]
    if ($apiUrl) {
        try {
            # M1 修复：按平台取对应的令牌，而不是对所有平台都用 GITHUB_TOKEN
            $tok = Get-PlatformToken -Platform $Platform
            $repoInfo = (Invoke-ApiRequest -Uri $apiUrl -Headers (Get-ApiHeaders -Token $tok -Scheme "token")).Content | ConvertFrom-Json
            $defaultBranch = if ($repoInfo.default_branch) { $repoInfo.default_branch } else { "main" }
        }
        catch { Write-ColorOutput "无法获取分支信息，尝试 main 和 master" "Yellow" }
    }

    # L5 修复：去重分支列表，避免 defaultBranch 已是 main/master 时重复尝试
    $branchesToTry = @($defaultBranch, "main", "master") | Select-Object -Unique; $downloaded = $false
    foreach ($branch in $branchesToTry) {
        try {
            $zipUrl = "$baseUrl/$RepoFullName/archive/refs/heads/$branch.zip"
            $repoName = $RepoFullName.Split('/')[-1]
            $outFile = Join-Path $OutputPath "$repoName-$branch.zip"   # 避免不同分支互相覆盖
            # H2 修复：目标目录按时间戳新建，绝不删除已有内容（与 SKILL.md 承诺一致）
            $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
            $targetPath = Join-Path $OutputPath ($repoName + '_' + $stamp)
            Write-ColorOutput "正在尝试下载 $RepoFullName (分支: $branch)..." "Cyan"
            if (Test-Path $outFile) { Remove-Safe -Path $outFile }
            # P3：aria2 优先多线程下载，缺失/失败自动回退 curl.exe（AC-P3-1/3）
            $dlOk = Invoke-DownloadFile -Url $zipUrl -OutFile $outFile
            if (-not $dlOk) { Write-ColorOutput "  下载失败，跳过该分支" "Yellow"; continue }
            if ((Test-Path $outFile) -and ((Get-Item $outFile).Length -gt 0)) {
                New-Item -ItemType Directory -Path $targetPath -Force | Out-Null
                Expand-Archive -Path $outFile -DestinationPath $targetPath -Force
                Remove-Safe -Path $outFile
                $extractedDir = Get-ChildItem -Path $targetPath -Directory | Select-Object -First 1
                if ($extractedDir) {
                    Move-Item -Path "$($extractedDir.FullName)\*" -Destination $targetPath -Force -ErrorAction SilentlyContinue
                    Remove-Safe -Path $extractedDir.FullName -Recurse
                }
                Write-PayloadOutput "`n下载成功！保存至: $targetPath`n" "Green"
                $downloaded = $true; break
            }
        }
        catch { Write-ColorOutput "分支 $branch 下载失败: $_" "Yellow" }
    }
    if (-not $downloaded) { Write-ColorOutput "所有分支尝试下载失败，请检查仓库地址是否正确" "Red" }
}
# ---------- 本地代码搜索 / 下载加速 / 并发搜索（v1.6.0） ----------
# v1.37.1（N-1）：技能自带二进制目录，按优先级：bin/（历史位置/手放便携版）→ tools/bin/（canonical 位置，mcps.py 同源）
function Get-LocalBinCandidateDirs {
    return @('bin', 'tools\bin') | ForEach-Object { Join-Path $ScriptDir $_ }
}
function Test-LocalBinaryAlive {
    # U-140：探活 —— 能执行 --version 且退出码 0 才算可用（Linux 上的 Windows PE / 损坏文件在此被拒）
    param([string]$Path)
    if (-not $Path) { return $false }
    try {
        $null = & $Path --version 2>$null
        return ($LASTEXITCODE -eq 0)
    } catch { return $false }
}
function Find-LocalSearchBinary {
    # 优先 ripgrep(rg)，其次 ugrep；返回可用二进制路径，缺失返回 $null
    # v1.35.0 增强：除 PATH 外，额外探测本技能目录 bin/ 下的 rg/ugrep
    # （便携部署/便携 rg 常见于 PATH 之外，纯 Get-Command 会漏检导致本地检索
    #  静默降级 remote-only，Doctor 报 tool_missing 误导）。
    $candidateDirs = Get-LocalBinCandidateDirs   # v1.37.1：bin/ + tools/bin/（此前只有 bin/）
    # U-140（2026-09-29）：跨平台修复 —— 非 Windows 候选名不带 .exe；任何候选选中前先探活（--version），
    # 探活失败继续下一个；全部失败返回 $null ⇒ 调用方报 tool_missing（绝不能把"没跑"报成 zero-hit）
    $isWin = if ($null -ne $IsWindows) { [bool]$IsWindows } else { $true }
    $names = if ($isWin) { @('rg.exe', 'ugrep.exe') } else { @('rg', 'ugrep') }
    foreach ($c in $names) {
        # 1) 技能自带的 bin/ 优先（最可控，随技能分发）
        foreach ($d in $candidateDirs) {
            $candidate = Join-Path $d $c
            if ((Test-Path $candidate -PathType Leaf) -and (Test-LocalBinaryAlive -Path $candidate)) { return $candidate }
        }
        # 2) 其次 PATH
        $p = Get-Command $c -ErrorAction SilentlyContinue
        if ($p -and (Test-LocalBinaryAlive -Path $p.Source)) { return $p.Source }
    }
    return $null
}
# P1（v1.15.0）：ast-grep 结构化检索二进制探测（ast-grep.exe / sg.exe）
function Find-AstGrep {
    foreach ($c in @('ast-grep.exe', 'sg.exe', 'ast-grep', 'sg')) {
        $p = Get-Command $c -ErrorAction SilentlyContinue
        if ($p) { return $p.Source }
    }
    return $null
}
# 下载工具选择：aria2 优先（多线程加速），缺失/失败回退 curl，再回退 .NET 原生下载（AC-P3）
# v1.53.17（跨平台补洞）：此前 `& curl.exe` / `& aria2c.exe` 是**裸命令名** ⇒ Linux/macOS 上永远找不到
#   （实测容器内 `-Download` 直接失败）。现在按平台候选名择一取 .Source；连 curl 都没有时用
#   Invoke-WebRequest 兜底 —— 不让"没装 curl"变成"下载功能坏"。
function Invoke-DownloadFile {
    param([string]$Url, [string]$OutFile)
    $aria = Get-Command -Name @('aria2c.exe', 'aria2c') -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    $curl = Get-Command -Name @('curl.exe', 'curl') -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    $useAria = $false
    if ($RequireAria2) {
        if (-not $aria) { Write-ColorOutput "RequireAria2 已指定但未找到 aria2c，终止下载" "Red"; return $false }
        $useAria = $true
    }
    elseif ($UseAria2 -and $aria) { $useAria = $true }
    if ($useAria) {
        Write-ColorOutput "  使用 aria2 多线程下载..." "Cyan"
        & $aria.Source -x16 -s16 -k1M --retry-wait=2 --max-tries=3 -o $OutFile $Url 2>$null
        if ($LASTEXITCODE -eq 0 -and (Test-Path $OutFile) -and (Get-Item $OutFile).Length -gt 0) { return $true }
        Write-ColorOutput "  aria2 失败(退出码 $LASTEXITCODE)，回退 curl" "Yellow"
    }
    if ($curl) {
        & $curl.Source -s -L --http2 --retry 2 --retry-delay 2 -o $OutFile $Url
        if ($LASTEXITCODE -eq 0) { return $true }
    }
    try {
        Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing -TimeoutSec 120 -ErrorAction Stop
        return $true
    } catch {
        Write-ColorOutput ("  下载失败（curl={0}；IWR: {1}）" -f $(if ($curl) { '有' } else { '无' }), $_.Exception.Message) "Yellow"
        return $false
    }
}
# 并发平台搜索：PS 5.1 原生 Runspace 池，零外部依赖（AC-P1）
# v1.36.3（P1-11）：三份并发编排（repo / code / research）原为近逐行重复的 ~90 行×3，合并为本公共池函数。
# 行为与旧实现逐项对齐：函数文本重建 + _injectVars 注入 → BeginInvoke → 总时长预算（超时 Stop 并记 warnings）→ EndInvoke 汇总。
# -TrackStatus：repo/code 路径维护 _perPlatformSuccess 并在引擎未自报状态时按结果补 ok/empty/error（research 路径旧实现不做，保持不做）。
# -EngineArgs：统一以哈希表 splat 给引擎函数；'Site' 只传给 SE 引擎（其余研究源函数无此参数）。
# 池创建/运行失败直接抛出，由调用方 catch 回退串行（与旧实现一致）。
function Start-EnginePoolHandles {
    param($Engines, $EngineArgs, [switch]$TrackStatus, $pool, $defs, $inject)
        $handles = @()
        foreach ($e in $Engines) {
            if ($TrackStatus) { $script:_perPlatformSuccess[$e.Name] = $false }
            $a = @{}
            foreach ($k in $EngineArgs.Keys) { $a[$k] = $EngineArgs[$k] }
            if ($e.Name -ne 'SE') { [void]$a.Remove('Site') }
            $ps = [powershell]::Create()
            $ps.RunspacePool = $pool
            [void]$ps.AddScript({
                param($Defs, $EngineFunc, $EngineArgs, $Inject, $EngineName, $EngineMode)
                foreach ($d in $Defs) { . ([scriptblock]::Create($d)) }
                foreach ($k in $Inject.Keys) { Set-Variable -Name $k -Value $Inject[$k] }
                # B2-6（U-261）：账本的 engine/mode 归属。写的是**本 runspace 的** `$script:`（探针
                #   tests/u261-probe-runspace-ledger-ctx.ps1 实测 8 runspace 零串台）—— 不是 AppDomain 共享标量，
                #   否则 8 个 runspace 会互相覆盖，账本"看起来精确但指错人"。
                $script:_ledgerEngine = $EngineName; $script:_ledgerMode = $EngineMode; $script:_ledgerOpen = $null
                # U-61：引擎级计时（含被 Stop 时已耗时长由池侧回填）；_engineTimings 为共享 ConcurrentDictionary
                $__sw = [System.Diagnostics.Stopwatch]::StartNew()
                try { & $EngineFunc @EngineArgs }
                finally { $__sw.Stop(); try { if ($_engineTimings) { $_engineTimings[$EngineName] = [int]$__sw.ElapsedMilliseconds } } catch { } }
            }).AddArgument($defs).AddArgument($e.Func).AddArgument($a).AddArgument($inject).AddArgument($e.Name).AddArgument([string]$e.Kind)
            $h = $ps.BeginInvoke()
            $handles += [PSCustomObject]@{ PS = $ps; Handle = $h; Engine = $e }
        }
    return $handles
}
function Get-EngineDeadlineSec {
    # v1.45.2（P0-1）：从 Invoke-EnginePool 抽出（U-163 要求该函数 ≤100 行，内联会把 100 撑到 105）。
    #   语义 = 「逐源截止 × Auto 倍数」后再取单源硬上限（min），不改表内下限（U-62/U-63 不受影响）。
    #   -Auto 三组引擎并发时单源 10s 不够（实测 HF/Packages/DockerHub/MCPRegistry/SE 全 deadline）；
    #   单模式逐位不变。`MCPS_ENGINE_HARD_CAP_SEC` 仍一票覆盖（两模式同值）。
    param([int]$DeadlineSec, [string]$EngineName = '')
    $d = $DeadlineSec
    try { if ($Auto -and [double]$script:Cfg.MultiModeTimeScale -gt 1 -and $d -gt 0) { $d = [int][Math]::Ceiling($d * [double]$script:Cfg.MultiModeTimeScale) } } catch { }
    try {
        $hc = [int]$script:Cfg.EngineHardCapSec
        if ($Auto -and [int]$script:Cfg.EngineHardCapMultiModeSec -gt 0) { $hc = [int]$script:Cfg.EngineHardCapMultiModeSec }
        if ($env:MCPS_ENGINE_HARD_CAP_SEC) { $hc = [int]$env:MCPS_ENGINE_HARD_CAP_SEC }
        if ($hc -gt 0 -and ($d -le 0 -or $d -gt $hc)) { $d = $hc }
    } catch { }
    # v1.47.4：显式逐源覆盖**最后**生效 —— 顺序本身就是语义（用户拍板 > Auto 倍数 > 硬上限）。
    #   只认 `MCPS_ENGINE_DEADLINE`；未设/未列出的源返回 $null ⇒ $d 逐位不变（U-62/U-63 的测定不作废）。
    if ($EngineName) {
        try { $ov = Get-EngineDeadlineOverride -EngineName $EngineName; if ($null -ne $ov) { $d = [int]$ov } } catch { }
    }
    # U-241：**总预算剩余是最终约束**（比逐源显式覆盖更硬：源不该活得比这一轮更久）。
    #   只在池已经起表之后生效（`_runBudgetSw` 非空）—— `-Doctor` 的 deadlinePolicy 是纯展示，
    #   不能因为"顺手调了本函数"就把展示值夹成剩余预算。
    try {
        if ($script:_runBudgetSw) {
            $totalSec = Get-TotalBudgetSec
            if ($totalSec -gt 0) {
                $left = Get-RunRemainingSec -TotalSec $totalSec
                $cap = if ($left -gt 1) { $left - 1 } else { 1 }   # 留 1s 归并/渲染，与"预算 + 1.5s 墙钟"口径一致
                if ($d -le 0 -or $d -gt $cap) { $d = [int]$cap }
            }
        }
    } catch { }
    return $d
}
function Get-EngineDeadlineOverride {
    # v1.47.4（P2-7）：`MCPS_ENGINE_DEADLINE="HF=30,DockerHub=45"` —— 逐源截止的**显式覆盖**。
    #   存在的理由：`Cfg.EngineDeadlineByEngine` 是硬编码表（HF/MCPRegistry/OpenAlex/RubyGems=8s），
    #   而 `MCPS_ENGINE_HARD_CAP_SEC` 只能**调低**（Get-EngineDeadlineSec 取 min）⇒ 网络慢一点的环境
    #   想给某个源多等几秒，此前**只能改代码**。本函数给出唯一受支持的"调高"口子。
    #   语义（刻意的）：
    #     · 值**逐字生效**：不乘 MultiModeTimeScale、不再与硬上限取 min（用户显式拍板 > 自动倍数）
    #     · `Name=0` = 关闭该源的**单源**截止（全局时间预算仍生效）
    #     · 未知引擎名 / 非法片段 ⇒ 各一条 warning（静默吞掉会让"设了没用"变成新的排障黑洞）
    #     · 按原始字符串缓存：同进程内环境变量被改（测试/宿主）会重新解析
    param([string]$EngineName)
    $raw = [string]$env:MCPS_ENGINE_DEADLINE
    if ([string]::IsNullOrWhiteSpace($raw)) {
        $script:_engineDeadlineOverride = $null
        $script:_engineDeadlineOverrideRaw = ''
        return $null
    }
    if ($script:_engineDeadlineOverrideRaw -ne $raw) {
        $map = @{}
        foreach ($tok in ($raw -split ',')) {
            $t = $tok.Trim()
            if (-not $t) { continue }
            if ($t -match '^([A-Za-z][\w-]*)\s*=\s*(\d{1,3})$') {
                $map[$matches[1]] = [int]$matches[2]
            } else {
                Add-EngineWarning -Engine 'config' -Message ("MCPS_ENGINE_DEADLINE 忽略无法解析的片段：{0}（要 Name=秒）" -f $t)
            }
        }
        $known = @{}
        try { foreach ($e in @($script:_engineRegistry)) { if ($e -and $e.Name) { $known[[string]$e.Name] = $true } } } catch { }
        foreach ($k in @($map.Keys)) {
            if (-not $known.ContainsKey($k)) {
                Add-EngineWarning -Engine 'config' -Message ("MCPS_ENGINE_DEADLINE 的引擎名不存在：{0}（可用名见 references/引擎链.md）" -f $k)
            }
        }
        $script:_engineDeadlineOverride = $map
        $script:_engineDeadlineOverrideRaw = $raw
    }
    if (-not $EngineName -or -not $script:_engineDeadlineOverride) { return $null }
    if ($script:_engineDeadlineOverride.ContainsKey($EngineName)) { return [int]$script:_engineDeadlineOverride[$EngineName] }
    return $null
}
function Get-CodeRequestBudget {
    # v1.53.0（U-223，Tier1-4）：code 通路**单请求预算** = f(该引擎生效截止)。返回 @{ TimeoutSec; MaxAttempts }。
    #   病灶：GrepApp 单请求超时写死 CodeRequestTimeoutSec=6，`MCPS_ENGINE_DEADLINE="GrepApp=25"` 只改引擎级
    #   截止（池侧 Stop 时机）——单请求仍在 6s 超时 ⇒「调了截止救不了慢源」（实测 grep.app 源活着、6s 过紧）。
    #   语义（刻意的）：
    #     · 无显式覆盖（或 `GrepApp=0` 即关闭单源截止）⇒ **逐位不变**：CodeRequestTimeoutSec × CodeRequestMaxAttempts
    #     · 显式覆盖 D>0 ⇒ **单次长请求**：MaxAttempts=1、TimeoutSec = clamp(D − 退避, 1, CodeRequestTimeoutSec×4)
    #       —— 源慢但活着时两次短超时只会双双失败；不变式 TimeoutSec×MaxAttempts+退避 ≤ D 恒成立（D≤退避时下限
    #       1s，由引擎截止兜底）；4× 上限防误设 9999 把单源变成无限等待
    #   解析单源仍是 Get-EngineDeadlineOverride（U-210：不得在调用点内联解析）。
    param([string]$EngineName)
    $t = [int]$script:Cfg.CodeRequestTimeoutSec
    $n = [int]$script:Cfg.CodeRequestMaxAttempts
    $backoff = [int]$script:Cfg.RetryBaseSec
    $ov = Get-EngineDeadlineOverride -EngineName $EngineName
    if ($null -ne $ov -and [int]$ov -gt 0) {
        $d = [int]$ov
        $n = 1
        $want = $d - $backoff
        if ($want -lt 1) { $want = 1 }
        $maxT = $t * 4
        if ($want -gt $maxT) { $want = $maxT }
        $t = $want
    }
    return [PSCustomObject]@{ TimeoutSec = $t; MaxAttempts = $n }
}
function Get-SlowEngines {
    # U-200（2026-10-21）：慢源判定（纯函数，供池尾告警，也可单测/变异）。
    #   · MinMs ≤ 0 ⇒ 关闭（MCPS_SLOW_ENGINE_MS=0）
    #   · 只认有状态的成功源（ok/empty）：error/deadline/rate_limited 已有各自告警，再贴"慢"会把"失败"说成"慢"
    #   · 没有计时记录 ⇒ 跳过（不猜）
    param($Engines, $Timings, [int]$MinMs)
    $rows = @()
    if ($MinMs -le 0 -or -not $Timings) { return $rows }
    foreach ($e in @($Engines)) {
        if (-not $e) { continue }
        $ms = 0
        if (-not $Timings.TryGetValue([string]$e.Name, [ref]$ms)) { continue }
        if ([int]$ms -lt $MinMs) { continue }
        if ((Get-EngineStatus -Name $e.Name) -notin @('ok', 'empty')) { continue }
        $rows += [PSCustomObject]@{ Name = [string]$e.Name; Ms = [int]$ms }
    }
    return @($rows)
}
function Write-SlowEngineWarnings {
    # U-200（2026-10-21）：把"慢但有产出"的源写进 warnings —— 让"整轮 40s"能归因到具体源，
    #   同时**不改 Verdict**（慢 ≠ 错）。阈值：Cfg.SlowEngineWarnMs，`MCPS_SLOW_ENGINE_MS` 覆盖（0 = 关）。
    param($Engines, $Timings, [int]$MinMs)
    if ($env:MCPS_SLOW_ENGINE_MS) { try { $MinMs = [int]$env:MCPS_SLOW_ENGINE_MS } catch { } }
    foreach ($s in @(Get-SlowEngines -Engines $Engines -Timings $Timings -MinMs $MinMs)) {
        Add-EngineWarning -Engine $s.Name -Message ('慢源：本次用时 {0:N1}s（阈值 {1:N1}s）—— 结果可用，但会拖慢整轮；可用 MCPS_DISABLE 或 MCPS_ENGINE_HARD_CAP_SEC 收敛' -f ($s.Ms / 1000.0), ($MinMs / 1000.0)) -From 'engine timing' -To 'observe (slow)'
        Write-ColorOutput ('{0} 用时 {1:N1}s（慢源，结果可用）' -f $s.Name, ($s.Ms / 1000.0)) 'DarkYellow'
    }
}
# v1.47.2（P1-4）：`Set-EngineStatus` 是**替换**语义（`if ($Reason) { ... = $Reason }`）。
#   deadline / 总预算这两条"粗暴停止"路径原先直接传自己的文案 ⇒ 把探活已写下的网络证据抹掉。
#   状态仍记 error（ReasonCodes 仍是 deadline），原因**追加** —— 两者不互相顶掉。
function Join-EngineNetworkReason {
    param([string]$Reason, [string]$EngineName)
    $nf = $null
    if ($EngineName -and $script:_networkFailures -and $script:_networkFailures.TryGetValue($EngineName, [ref]$nf) -and $nf) {
        if ($Reason -notlike "*$nf*") { return "$Reason；$nf" }
    }
    return $Reason
}
# ─────────────────────────────────────────────────────────────────────────────
# U-242（v1.53.24，验收 B1-1）：**源健康记忆**（跨运行）
#   病灶（验收 F5/F16）：失败源每轮都等满 deadline —— 实测 GitLab 12.1s、HF 12.4s、GitLabBlobs 17.1s，
#   占 repo/code 墙钟的 95%+；而 -Doctor 早已能判定"这些域不可达"。进程内记忆只在同一轮有效。
#   设计（刻意的）：
#     · **半开探测而非跳过**：冷源仍进 Requested/Executed（只给 HealthProbeSec 秒），
#       否则"没试"和"试了没问题"在 coverage 里长得一样（P0-D 同型缺陷）。
#     · 只记"源本身不健康"的类（网络/截止/限流/配额/403）；缺凭据、缺工具是**配置**问题，
#       记进来只会把配置错误伪装成"源坏了"（下一次跑连真实错误都看不到）。
#     · 成功即清除；连续失败 TTL 翻倍（上限 1h）—— 源恢复后最多 1h 内被重新探到。
#     · 落盘失败**不影响检索**（best-effort，只告警）：健康记忆是加速器，不是正确性依赖。
#     · `MCPS_HEALTH=0` 一键关闭（等价于回到 v1.53.23 的"每轮都等满"）。
function Get-HealthStorePath {
    if ($env:MCPS_HEALTH_FILE) { return [string]$env:MCPS_HEALTH_FILE }
    $dir = ''
    try { $dir = Split-Path -Parent ([string]$CacheFile) } catch { }
    if (-not $dir) { $dir = [string]$ScriptDir }
    return (Join-Path $dir 'source-health.json')
}
function Get-HealthStore {
    if ($null -ne $script:_healthStore) { return $script:_healthStore }
    $script:_healthStore = @{}
    $script:_healthStoreLoaded = $true
    if ([string]$env:MCPS_HEALTH -eq '0') { return $script:_healthStore }
    $p = Get-HealthStorePath
    try {
        if (-not (Test-Path -LiteralPath $p)) { return $script:_healthStore }
        $raw = Get-Content -LiteralPath $p -Raw -Encoding UTF8 -ErrorAction Stop
        if ([string]::IsNullOrWhiteSpace($raw)) { return $script:_healthStore }
        $obj = $raw | ConvertFrom-Json -ErrorAction Stop
        if ($obj -and $obj.entries) {
            foreach ($pn in @($obj.entries.PSObject.Properties)) {
                $e = $pn.Value
                if ($e -and $e.until) {
                    # ★跨运行时差异（实测）：**PS7 的 ConvertFrom-Json 会把 ISO-8601 字符串直接解成 [datetime]**，
                    #   而 PS5.1 保留字符串。若直接 `[string]$e.until`，PS7 会用**本地文化**格式化成
                    #   `2026/10/25 15:38:36`（丢掉 Z）⇒ 后续解析不回 UTC，冷源永远“未过期”。
                    #   统一归一成 UTC roundtrip 字符串（两个运行时都能解）。
                    $u = $e.until
                    $us = if ($u -is [datetime]) { $u.ToUniversalTime().ToString('o') } else { [string]$u }
                    $script:_healthStore[[string]$pn.Name] = [PSCustomObject]@{ Until = $us; Reason = [string]$e.reason; Fails = [int]$e.fails }
                }
            }
        }
    } catch {
        Add-EngineWarning -Engine 'health' -Message ("源健康记忆读取失败（已忽略，本轮按全部健康处理）：{0}" -f $_.Exception.Message)
        $script:_healthStore = @{}
    }
    return $script:_healthStore
}
function Test-EngineHealthCold {
    # 返回冷却条目（$null = 健康/未记录/已过期）。纯读，不改状态。
    param([string]$EngineName)
    if (-not $EngineName) { return $null }
    if ([string]$env:MCPS_HEALTH -eq '0' -or [int]$script:Cfg.HealthProbeSec -le 0) { return $null }
    $st = Get-HealthStore
    if (-not $st.ContainsKey($EngineName)) { return $null }
    $e = $st[$EngineName]
    # ★RoundtripKind：Until 写的是 UTC（'...Z'）；默认 TryParse 会转成**本地时间**，
    #   与 UtcNow 直接比较会差一个时区（实测：过期条目被判成「还有 8 小时」⇒ 死源永不恢复）。
    #   这是新门 U-242 的第一个真实收获，不是测试写错。
    $until = [datetime]::MinValue
    if (-not [datetime]::TryParse([string]$e.Until, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind, [ref]$until)) { return $null }
    if ($until.ToUniversalTime() -le [datetime]::UtcNow) { return $null }
    return $e
}
function Set-EngineHealthOutcome {
    param([string]$EngineName, [string]$Status, [string]$Reason)
    if (-not $EngineName) { return }
    if ([string]$env:MCPS_HEALTH -eq '0' -or [int]$script:Cfg.HealthProbeSec -le 0) { return }
    $st = Get-HealthStore
    if ($Status -in @('ok', 'empty')) {
        if ($st.ContainsKey($EngineName)) { $st.Remove($EngineName); $script:_healthDirty = $true }
        return
    }
    $r = [string]$Reason
    $cls = $null
    if ($Status -eq 'rate_limited') { $cls = 'rate-limited' }
    elseif ($r -match '402|余额不足|quota') { $cls = 'quota' }
    elseif ($r -match 'network-unavailable|确定性失败|不可达|hosts') { $cls = 'network' }
    elseif ($r -match '403|forbidden|Global Search is disabled') { $cls = 'forbidden' }
    elseif ($Status -eq 'error' -and $r -match '截止|超时|deadline|timeout|超预算') { $cls = 'deadline' }
    if (-not $cls) { return }   # auth_missing / tool_missing / 普通 error 不入健康记忆（配置问题不伪装成源问题）
    $base = if ($cls -eq 'quota') { [int]$script:Cfg.HealthTtlQuotaSec } else { [int]$script:Cfg.HealthTtlSec }
    $prev = 0
    if ($st.ContainsKey($EngineName)) { $prev = [int]$st[$EngineName].Fails }
    $fails = $prev + 1
    $ttl = $base
    for ($i = 1; $i -lt $fails -and $ttl -lt 3600; $i++) { $ttl = $ttl * 2 }
    if ($ttl -gt 3600) { $ttl = 3600 }
    $until = (Get-Date).ToUniversalTime().AddSeconds($ttl).ToString('o')
    $st[$EngineName] = [PSCustomObject]@{ Until = $until; Reason = $cls; Fails = $fails }
    $script:_healthDirty = $true
}
function Save-HealthStore {
    if ([string]$env:MCPS_HEALTH -eq '0') { return }
    if (-not $script:_healthDirty) { return }
    $p = Get-HealthStorePath
    try {
        $entries = [ordered]@{}
        $st = Get-HealthStore
        foreach ($k in @($st.Keys | Sort-Object)) {
            $e = $st[$k]
            if (-not $e) { continue }
            $entries[[string]$k] = [ordered]@{ until = [string]$e.Until; reason = [string]$e.Reason; fails = [int]$e.Fails }
        }
        $obj = [ordered]@{ version = 1; updatedAt = (Get-Date).ToUniversalTime().ToString('o'); entries = $entries }
        $json = ($obj | ConvertTo-Json -Depth 6)
        $tmp = "$p.tmp"
        [System.IO.File]::WriteAllText($tmp, $json, (New-Object System.Text.UTF8Encoding($false)))
        Move-Item -LiteralPath $tmp -Destination $p -Force -ErrorAction Stop
        $script:_healthDirty = $false
    } catch {
        Add-EngineWarning -Engine 'health' -Message ("源健康记忆写入失败（不影响本轮检索结果）：{0}" -f $_.Exception.Message)
    }
}
function Reset-HealthStore {
    $script:_healthStore = @{}
    $script:_healthDirty = $true
    Save-HealthStore
}
# ─────────────────────────────────────────────────────────────────────────────
# U-163 约束（主脚本**任何**函数体 ≤100 行）：下面 4 个助手是从 Invoke-EnginePool 抽出的等价块。
#   抽出原因只有一个 —— 加 U-241/U-242 后该函数到 132 行，直接撞红线；语义逐行不变。
function Stop-EngineHandle {
    # 停一个引擎并**保留已产出部分**：预算/截止两条"粗暴停止"路径共用（原来两处各 11 行、逐字重复）。
    #   返回该 handle 已产出的结果（$null = 没有）。调用方负责 `if ($part) { $all += $part }`。
    param($H, [string]$Why, [string]$Detail, [string]$From, [string]$To, [string]$Console, [string]$Color = 'Yellow', $SwRun)
    try { $H.PS.Stop() } catch { }
    $partial = $null
    try { $partial = $H.PS.EndInvoke($H.Handle) } catch { }
    try { if (-not $script:_engineTimings.ContainsKey($H.Engine.Name)) { $script:_engineTimings[$H.Engine.Name] = [int]$SwRun.ElapsedMilliseconds } } catch { }   # U-61 回填
    Set-EngineStatus -Name $H.Engine.Name -Status 'error' -Reason (Join-EngineNetworkReason -Reason $Why -EngineName $H.Engine.Name)
    Add-EngineWarning -Engine $H.Engine.Name -Message $Detail -From $From -To $To
    if ($Console) { Write-ColorOutput $Console $Color }
    try { $H.PS.Dispose() } catch { }
    return $partial
}
function Get-HealthProbedDeadlineSec {
    # U-242：冷源**半开探测** —— 把等待压到 HealthProbeSec，但**不跳过**（跳过会让"没试"与"没问题"同形）。
    #   ★逐源表查找留在 Invoke-EnginePool 里（U-23 静态门按函数体核接线，抽走就红）。
    param([string]$EngineName, [int]$DeadlineSec)
    $dl = $DeadlineSec
    try {
        $cold = Test-EngineHealthCold -EngineName $EngineName
        if ($cold) {
            $probe = [int]$script:Cfg.HealthProbeSec
            if ($probe -gt 0 -and ($dl -le 0 -or $dl -gt $probe)) { $dl = $probe }
            Add-EngineWarning -Engine $EngineName -Message ("健康记忆：上轮 {0}（连续 {1} 次，冷却至 {2}）=> 本轮半开探测 {3}s" -f $cold.Reason, $cold.Fails, $cold.Until, $probe) -From 'health store' -To 'probe'
        }
    } catch { }
    return $dl
}
function Update-EngineHealthFromPool {
    # 本池结果入健康记忆（成功清除 / 失败记冷却）+ best-effort 落盘。必须在慢源判定之前（只读 status）。
    param([object[]]$Engines)
    foreach ($eng in @($Engines)) {
        if (-not $eng -or -not $eng.Name) { continue }
        $rsn = ''
        try { [void]$script:_engineStatusReason.TryGetValue([string]$eng.Name, [ref]$rsn) } catch { }
        Set-EngineHealthOutcome -EngineName ([string]$eng.Name) -Status (Get-EngineStatus -Name $eng.Name) -Reason ([string]$rsn)
    }
    Save-HealthStore
}
function Invoke-EnginePool {
    param(
        [object[]]$Engines,
        [hashtable]$EngineArgs,
        [string]$Label = '并发检索',
        [switch]$TrackStatus,
        # 0 = 调用方不传时该池不设截止（repo/code/research 三路均显式传值，见 U-63）
        [int]$EngineDeadlineSec = 0
    )
    $all = @()
    if (@($Engines).Count -eq 0) { return $all }
    # B2-5（U-260）：本池 execution 事实（预算/实耗/早停/是否够用）——只有池内同时知道"收紧后的预算"与真实墙钟。
    $poolEarlyStop = $false; $poolProduced = 0
    $defs = @(Get-EnginePoolDefs -Engines $Engines)
    # H2 依赖注入：白名单顶层变量
    $inject = @{}
    foreach ($k in $script:_injectVars) { $inject[$k] = Get-Variable -Name $k -ValueOnly -ErrorAction SilentlyContinue }
    $pool = [runspacefactory]::CreateRunspacePool(1, [math]::Max(1, @($Engines).Count))
    $pool.ApartmentState = 'MTA'
    $pool.Open()
    try {
        $handles = @(Start-EnginePoolHandles -Engines $Engines -EngineArgs $EngineArgs -TrackStatus:$TrackStatus -pool $pool -defs $defs -inject $inject)
        # U-241：池预算 = min(单池默认, 本轮总预算剩余)；总预算未设 ⇒ 逐位同旧行为
        $poolBudgetSec = [int](Get-TimeBudgetSec)
        $budgetSec = [int](Get-PoolBudgetSec -PoolBudgetSec $poolBudgetSec)
        $budgetLabel = Get-PoolBudgetLabel -PoolBudgetSec $poolBudgetSec -EffectiveSec $budgetSec
        if ($budgetSec -ne $poolBudgetSec -and $budgetSec -gt 0) {
            Add-EngineWarning -Engine 'budget' -Message ('本轮总预算余量不足：本池预算由 {0}s 收紧为 {1}s（{2}）' -f $poolBudgetSec, $budgetSec, $budgetLabel)
        }
        $swRun = [System.Diagnostics.Stopwatch]::StartNew()
        foreach ($h in $handles) {
            # 预算耗尽：**只 Stop 没跑完的**（已完成的照常收结果，否则 Stop 会丢掉整批产出 —— 实测 8 源 2s 返回却 0 条）
            if ($budgetSec -gt 0 -and $swRun.Elapsed.TotalSeconds -gt $budgetSec -and -not $h.Handle.IsCompleted) {
                $part = Stop-EngineHandle -H $h -Why ("运行时长超预算 {0}s（{1}），提前停止" -f $budgetSec, $budgetLabel) `
                    -Detail ("运行时长超预算 {0}s（{1}），本次停止等待" -f $budgetSec, $budgetLabel) `
                    -From 'concurrency pool' -To 'stop (time budget)' -SwRun $swRun `
                    -Console "$($h.Engine.Name) 超时长预算 ${budgetSec}s（$budgetLabel），已停止等待"
                if ($part) { $all += $part }
                $poolEarlyStop = $true   # B2-5：预算早停也算 truncated（不许把"没跑完"说成"没结果"）
                continue
            }
            try {
                # U-23：逐源截止**查表**（缺省 = 调用方传入；0 = 不设）；表值下限见 Cfg.EngineDeadlineByEngine
                $dlSec = $EngineDeadlineSec
                try {
                    $byEng = $script:Cfg.EngineDeadlineByEngine
                    if ($EngineDeadlineSec -gt 0 -and $byEng -is [hashtable] -and $byEng.ContainsKey($h.Engine.Name) -and [int]$byEng[$h.Engine.Name] -gt 0) { $dlSec = [int]$byEng[$h.Engine.Name] }
                } catch { $dlSec = $EngineDeadlineSec }
                # 硬上限 / -Auto 倍数 / 显式覆盖（Get-EngineDeadlineSec）+ U-242 冷源半开探测
                $dlSec = Get-EngineDeadlineSec -DeadlineSec $dlSec -EngineName $h.Engine.Name
                $dlSec = Get-HealthProbedDeadlineSec -EngineName $h.Engine.Name -DeadlineSec $dlSec
                if ($dlSec -gt 0 -and -not $h.Handle.IsCompleted) {
                    # 剩余时间从**池启动**算起（否则 N 个慢源会相加成 N×deadline），且只等未完成的 handle
                    $remainMs = [int]($dlSec * 1000 - $swRun.Elapsed.TotalMilliseconds)
                    if ($remainMs -gt 0) { [void]$h.Handle.AsyncWaitHandle.WaitOne($remainMs) }
                }
                if ($dlSec -gt 0 -and -not $h.Handle.IsCompleted) {
                    $part = Stop-EngineHandle -H $h -Why ("单引擎超 {0}s 截止，已停止" -f $dlSec) `
                        -Detail ("单引擎超 {0}s 截止，本次停止等待" -f $dlSec) `
                        -From 'engine deadline' -To 'stop (deadline)' -SwRun $swRun `
                        -Console "$($h.Engine.Name) 超单引擎截止 ${dlSec}s，已停止"
                    if ($part) { $all += $part }
                    $poolEarlyStop = $true   # B2-5：逐源截止也是"没跑完"（同 budget 早停，不许伪装成零命中）
                    continue
                }
                $res = $h.PS.EndInvoke($h.Handle)
                # B2-1（U-258）：先归一到封套再取 results —— 旧写法 `$all += $res` 在引擎返回封套时
                #   会把**封套对象本身**当成一条结果塞进结果集（泄漏 2 条：engine/1 与 engine/0 包装都会漏）。
                $out = @(Resolve-EngineResultEnvelope -Engine $h.Engine -Raw $res)
                if ($TrackStatus) { $script:_perPlatformSuccess[$h.Engine.Name] = $true }
                if ($out.Count -gt 0) { $poolProduced++ }   # B2-5：够不够用按"有产出的源数"算，不按条数
                $all += $out
                # v1.21.0 P0-1：引擎未自行写状态则按结果补 ok/empty（不覆盖 auth_missing/tool_missing）
                if ($TrackStatus -and (Get-EngineStatus -Name $h.Engine.Name) -eq 'unknown') {
                    if ($out.Count -eq 0) { Set-EngineStatus -Name $h.Engine.Name -Status 'empty' -Reason '检索成功但 0 命中' }
                    else { Set-EngineStatus -Name $h.Engine.Name -Status 'ok' -Reason '' }
                }
            }
            catch {
                if ($TrackStatus) {
                    $script:_perPlatformSuccess[$h.Engine.Name] = $false
                    if ((Get-EngineStatus -Name $h.Engine.Name) -eq 'unknown') { Set-EngineStatus -Name $h.Engine.Name -Status 'error' -Reason $_.Exception.Message }
                }
                Write-ColorOutput "$($h.Engine.Name) ${Label}异常(已跳过): $_" "Red"
            }
            finally { try { $h.PS.Dispose() } catch { } }
        }
        # U-242：本池结果入健康记忆（成功清除 / 失败记冷却）+ 落盘
        try { Update-EngineHealthFromPool -Engines $Engines }
        catch { Add-EngineWarning -Engine 'health' -Message ("源健康记忆更新失败（不影响本轮结果）：{0}" -f $_.Exception.Message) }
        # U-200：慢源分档（只标注，不改 Verdict）
        if ($TrackStatus) { Write-SlowEngineWarnings -Engines $Engines -Timings $script:_engineTimings -MinMs ([int]$script:Cfg.SlowEngineWarnMs) }
        # B2-5（U-260）：落一条 execution.pools（mode 取本池引擎的 Kind；budgetMs 用**收紧后**的预算）。
        $__mode = if (@($Engines).Count) { [string](@($Engines)[0].Kind) } else { '' }
        Add-PoolStat -Mode $__mode -BudgetSec $budgetSec -SwRun $swRun -EarlyStop $poolEarlyStop -Produced $poolProduced
    }
    finally { try { $pool.Close(); $pool.Dispose() } catch { } }
    return $all
}
function Invoke-ConcurrentPlatformSearch {
    param(
        [string[]]$Platforms,
        [string]$Keyword,
        [string]$Language,
        [int]$MinStars,
        [int]$Limit
    )
    $all = @()
    if (@($Platforms).Count -eq 0) { return $all }   # v1.33.0：全被 MCPS_DISABLE 禁用时不再回退全量引擎
    # v1.33.0：MCPS_DISABLE 过滤在主流程派生 platformsToSearch 时统一应用（本函数按传入名单取引擎）
    $engines = @(Get-EngineByKind -Kind 'repo' -Names $Platforms)
    try {
        $all = @(Invoke-EnginePool -Engines $engines -Label '并发搜索' -TrackStatus -EngineDeadlineSec $script:Cfg.EngineDeadlineRepoSec -EngineArgs @{ Keyword = $Keyword; Language = $Language; MinStars = $MinStars; Limit = $Limit })   # U-63：repo 路径引擎级截止（此前 Cfg 键已定义但未接线）
    }
    catch {
        # 降级：Runspace 不可用时回退串行（AC-P1-6）—— H1：由注册表驱动，新增引擎自动纳入
        Write-ColorOutput "并发池不可用，回退串行搜索: $_" "Yellow"
        foreach ($e in $engines) {
            $all += Invoke-EngineSerial -Engine $e -EngineArgs @{ Keyword = $Keyword; Language = $Language; MinStars = $MinStars; Limit = $Limit }
        }
    }
    return $all
}
# U-192（2026-10-21）：-RepoScope 的**身份解析 / 匹配 / 计划**三件套（宿主侧，不进 runspace）。
#   为什么需要"身份"而不是直接比字符串：-RepoScope 允许 git URL / 带 .git / 尾部斜杠 / owner/repo 简写，
#   而各引擎回填的 Name 形态不一（GitHub=`owner/repo`、Sourcegraph=`github.com/owner/repo`、
#   searchcode=完整 URL）—— 只有把两侧都归一成 host+slug 才能判断"这条结果是否真的在库里"。
function Get-RepoIdentity {
    param([string]$Repository)
    if ([string]::IsNullOrWhiteSpace($Repository)) { return $null }
    $s = $Repository.Trim()
    if ($s -match '^git@([^:]+):(.+)$') { $s = 'https://' + $Matches[1] + '/' + $Matches[2] }   # scp 形态 git@github.com:o/r.git
    $s = ($s -replace '[?#].*$', '').TrimEnd('/')
    $s = $s -replace '\.git$', ''
    $hostName = ''; $seg = @()
    if ($s -match '^[a-zA-Z][\w+.-]*://') {
        $u = $null
        try { $u = [uri]$s } catch { return $null }
        if (-not $u -or -not $u.Host) { return $null }
        $hostName = $u.Host.ToLowerInvariant()
        $seg = @($u.AbsolutePath.Trim('/') -split '/' | Where-Object { $_ })
    }
    else {
        $seg = @($s -split '/' | Where-Object { $_ })
    }
    if (@($seg).Count -lt 2) { return $null }
    # GitHub（含 enterprise）只认 owner/repo；GitLab 允许子组（a/b/c），取全路径避免把子组截掉造成误匹配
    $slug = if ($hostName -match 'github') { (@($seg)[0..1] -join '/') } else { (@($seg) -join '/') }
    return [PSCustomObject]@{ Host = $hostName; Slug = $slug.ToLowerInvariant() }
}
function Test-RepoScopeMatch {
    param($Result, $Identity)
    if (-not $Identity) { return $true }
    if (-not $Result) { return $false }
    $slug = [string]$Identity.Slug
    $name = [string]$Result.Name
    $url = [string]$Result.Url
    $cands = @()
    if ($name) {
        $n = ($name -replace '^[a-zA-Z][\w+.-]*://', '').TrimEnd('/') -replace '\.git$', ''
        # Sourcegraph 的 Name 形如 `github.com/owner/repo`：取出 host 后**严格比对**（否则同名的 GitLab 仓库会混进来）
        if ($n -match '^(?<h>[^/]+\.[^/]+)/(?<p>.+)$') {
            $nh = $Matches['h'].ToLowerInvariant()
            if ($Identity.Host -and $nh -ne [string]$Identity.Host) { return $false }
            $n = $Matches['p']
        }
        $cands += $n
    }
    if ($url) {
        try { $cands += ([uri]$url).AbsolutePath.Trim('/') } catch { }   # blob URL：owner/repo/blob/... 或 group/repo/-/blob/...
    }
    foreach ($c in $cands) {
        $cl = ([string]$c).ToLowerInvariant()
        if (-not $cl) { continue }
        if ($cl -eq $slug) { return $true }
        if ($cl -match ('^' + [regex]::Escape($slug) + '(/|$)')) { return $true }
        if ($cl -match ('/' + [regex]::Escape($slug) + '(/|$)')) { return $true }
    }
    return $false
}
function Get-CodeScopePlan {
    # 返回 Mode（only/add）、Identity、本次可参与的作用域内引擎、被排除的引擎及原因。
    #   `add` = 旧行为（全部全局源 + 追加 searchcode）；`only` = 只跑能按仓库约束的源。
    param([string]$RepoScope, [string]$RepoScopeMode)
    $plan = [PSCustomObject]@{ Mode = 'add'; Identity = $null; Engines = @(); Excluded = @() }
    if ([string]::IsNullOrWhiteSpace($RepoScope)) { return $plan }
    $id = Get-RepoIdentity -Repository $RepoScope
    if (-not $id) { return $plan }   # 解析失败 ⇒ 退回 add，由调用方显式告警（不能悄悄"过滤"成 0 条）
    $plan.Identity = $id
    if ($RepoScopeMode -ne 'only') { return $plan }
    $plan.Mode = 'only'
    foreach ($e in @($script:_engineRegistry | Where-Object { $_.Kind -eq 'code' })) {
        if (Test-EngineDisabled -Engine $e) { continue }   # 被 MCPS_DISABLE 关掉的源既不发请求，也不必解释"未参与"
        if (-not $e.SupportsRepoScope) { $plan.Excluded += ('{0}(源不支持仓库过滤)' -f $e.Name); continue }
        $h = [string]$id.Host
        if ($h -and $h -notmatch 'github') {
            if ($e.Name -in @('GitHubCode', 'GrepApp')) { $plan.Excluded += ('{0}(只索引 GitHub 仓库)' -f $e.Name); continue }
        }
        # v1.46.9（T1-3）：GitLabBlobs 的仓库作用域只有「GitLab 项目级」这一种形态 ⇒ 非 gitlab 宿主直接排除，
        #   否则会拿 `github.com/owner/repo` 去查 gitlab.com/projects/… ⇒ 404 被当成"仓库不存在"。
        # v1.48.1（全模块验收 P1）：**无宿主也必须排除**。`-RepoScope "owner/repo"` 是文档明确支持的形式，
        #   但它拿不到 host（`$h=''`），旧守卫 `$h -and ...` 因此整条失效 ⇒ 一个 GitHub 仓库的检索
        #   会把 GitLabBlobs 拉进 Requested 并记 Blocked（实测 `Requested=[SearchCodeRepo,GitHubCode,GitLabBlobs,GrepApp,Sourcegraph]`）。
        #   那种情况下它要么白占一个 Blocked、要么真发一次 404 —— 两种都是噪声。
        if ($e.Name -eq 'GitLabBlobs' -and ((-not $h) -or ($h -notmatch 'gitlab'))) {
            $plan.Excluded += $(if ($h) { 'GitLabBlobs(只能按 GitLab 项目作用域检索)' } else { 'GitLabBlobs(未指定宿主，无法判定是 GitLab 项目)' })
            continue
        }
        # GitLab 仍可由 Sourcegraph 覆盖（其公共索引含 GitLab）；只有非 GitHub/GitLab 宿主才排除它
        if ($h -and $h -notmatch 'github|gitlab' -and $e.Name -eq 'Sourcegraph') { $plan.Excluded += ('{0}(公共索引只覆盖 GitHub/GitLab)' -f $e.Name); continue }
        $plan.Engines += $e
    }
    return $plan
}
function Select-RepoScopedResults {
    param($Results, $Identity)
    $kept = @(); $dropped = 0
    foreach ($r in @($Results)) {
        if (-not $r) { continue }
        if (Test-RepoScopeMatch -Result $r -Identity $Identity) { $kept += $r } else { $dropped++ }
    }
    return [PSCustomObject]@{ Kept = @($kept); Dropped = [int]$dropped }
}
# v1.46.7（2026-10-21，T1-1/T1-2）：仓库发现质量过滤三件套。
#   为什么放客户端而不是翻译成上游限定符：四个源的限定符能力各不相同（GitHub 有 archived:/pushed:/license:，
#   Gitee(so) 一个都没有，GitLab 只有 last_activity_after），同一组参数在不同源上会得出**不同的候选集**，
#   用户无法判断"少了的那几条"是上游没给还是被拦了。统一在客户端过滤 ⇒ 同一套语义、同一份计数、同一份告警。
#   代价：过滤后可能少于 -Limit（已告警），不会静默补位。
function ConvertTo-RepoUpdatedAt {
    # 各源时间格式不一（GitHub `2026-01-02T03:04:05Z`、GitLab 带毫秒偏移、Gitee 同上）⇒ 一律按 UTC 解析。
    param($Value)
    if ($null -eq $Value) { return $null }
    $s = [string]$Value
    if ([string]::IsNullOrWhiteSpace($s)) { return $null }
    $ci = [System.Globalization.CultureInfo]::InvariantCulture
    $dto = [datetimeoffset]::MinValue
    if ([datetimeoffset]::TryParse($s, $ci, [System.Globalization.DateTimeStyles]::AssumeUniversal, [ref]$dto)) {
        return $dto.UtcDateTime
    }
    $dt = [datetime]::MinValue
    if ([datetime]::TryParse($s, $ci, [System.Globalization.DateTimeStyles]::AssumeUniversal, [ref]$dt)) {
        return $dt.ToUniversalTime()
    }
    return $null
}
function ConvertTo-RepoLicenseSet {
    # `-License "mit, apache-2.0"` ⇒ 小写集合。SPDX id 大小写敏感度低（GitHub 回 `mit`、Gitee 回 `MIT`），统一小写比。
    param([string]$License)
    $set = @{}
    if ([string]::IsNullOrWhiteSpace($License)) { return $set }
    foreach ($x in ($License -split ',')) {
        $k = ([string]$x).Trim().ToLowerInvariant()
        if ($k) { $set[$k] = $true }
    }
    return $set
}
function Select-RepoQualityResults {
    # 返回 Kept（保留下来的结果）与 Stats（每类剔除数 + 每类"源没给字段"的源名集合）。
    #   ★`Archived`/`License`/`Updated` 缺失 ⇒ **保留**并记入 Unknown，绝不当成 false/过期/不匹配。
    #     反例：GitLab 列表不返回 archived，若按"缺失=未归档"处理，用户会以为过滤生效了（实际一条没滤）。
    param(
        [object[]]$Results,
        [int]$ActiveWithin = 0,
        [switch]$ExcludeArchived,
        [string]$License = '',
        $Now = $null
    )
    $nowDt = if ($null -ne $Now) { [datetime]$Now } else { [datetime]::UtcNow }
    $cut = $null
    if ($ActiveWithin -gt 0) { $cut = $nowDt.AddDays(-1 * $ActiveWithin) }
    $lic = ConvertTo-RepoLicenseSet -License $License
    $stats = [PSCustomObject]@{
        Input           = @($Results).Count
        Archived        = 0
        Stale           = 0
        LicenseMismatch = 0
        LicenseMissing  = 0
        ArchivedUnknown = @{}
        UpdatedUnknown  = @{}
        LicenseUnknown  = @{}
        Cutoff          = $(if ($cut) { $cut.ToString('yyyy-MM-dd') } else { '' })
    }
    $kept = @()
    foreach ($r in @($Results)) {
        if ($null -eq $r) { continue }
        $p = [string]$r.Platform
        if ([string]::IsNullOrWhiteSpace($p)) { $p = 'unknown' }
        if ($ExcludeArchived) {
            $prop = $r.PSObject.Properties['Archived']
            if ($null -eq $prop -or $null -eq $prop.Value) { $stats.ArchivedUnknown[$p] = 1 + [int]$stats.ArchivedUnknown[$p] }
            elseif ($prop.Value -eq $true) { $stats.Archived++; continue }
        }
        if ($cut) {
            $upd = ConvertTo-RepoUpdatedAt -Value $r.Updated
            if ($null -eq $upd) { $stats.UpdatedUnknown[$p] = 1 + [int]$stats.UpdatedUnknown[$p] }
            elseif ($upd -lt $cut) { $stats.Stale++; continue }
        }
        if ($lic.Count -gt 0) {
            $l = ([string]$r.License).Trim().ToLowerInvariant()
            if (-not $l -or $l -eq 'noassertion' -or $l -eq 'other') {
                $stats.LicenseMissing++
                $stats.LicenseUnknown[$p] = 1 + [int]$stats.LicenseUnknown[$p]
                continue
            }
            if (-not $lic.ContainsKey($l)) { $stats.LicenseMismatch++; continue }
        }
        $kept += $r
    }
    return [PSCustomObject]@{ Kept = @($kept); Stats = $stats }
}
function Get-RepoQualityNotes {
    # 只报**实际发生/实际无法判断**的事；三个开关都没开时一句也不说（默认路径零噪音）。
    #   ★与 Write-RepoQualityWarnings 分开：CLI 走 warnings[]，MCP/Serve 走 filterNotes[]，两边**同一份文案**
    #     （否则"CLI 说 GitLab 没过滤、MCP 不说"又是一种口径漂移）。
    param($Stats, [int]$ActiveWithin = 0, [switch]$ExcludeArchived, [string]$License = '')
    $notes = @()
    if ($null -eq $Stats) { return $notes }
    # 每个源单独一句（"GitLab 不返回 archived ⇒ 未过滤（3 条无法判断）"）——
    #   只说"N 条无法判断"会让用户以为只有 N 条受影响，实际是**该源全部**。
    $srcs = {
        param($map, $field)
        $out = @()
        foreach ($k in @($map.Keys | Sort-Object)) { $out += ('{0} 不返回 {1} ⇒ 未过滤（{2} 条无法判断）' -f $k, $field, [int]$map[$k]) }
        return $out
    }
    if ($ExcludeArchived -and $Stats.Archived -gt 0) {
        $notes += ('-ExcludeArchived 剔除归档仓库 {0} 条' -f $Stats.Archived)
    }
    if ($ExcludeArchived -and $Stats.ArchivedUnknown.Count -gt 0) {
        foreach ($s in @(& $srcs $Stats.ArchivedUnknown 'archived')) { $notes += ('-ExcludeArchived 未完全生效：' + $s) }
    }
    if ($ActiveWithin -gt 0 -and $Stats.Stale -gt 0) {
        $notes += ('-ActiveWithin {0} 剔除更新早于 {1} 的仓库 {2} 条' -f $ActiveWithin, $Stats.Cutoff, $Stats.Stale)
    }
    if ($ActiveWithin -gt 0 -and $Stats.UpdatedUnknown.Count -gt 0) {
        foreach ($s in @(& $srcs $Stats.UpdatedUnknown '更新时间')) { $notes += ('-ActiveWithin 未完全生效：' + $s) }
    }
    if (-not [string]::IsNullOrWhiteSpace($License) -and ($Stats.LicenseMismatch -gt 0 -or $Stats.LicenseMissing -gt 0)) {
        $m = ('-License {0} 剔除不匹配 {1} 条' -f $License.Trim(), $Stats.LicenseMismatch)
        if ($Stats.LicenseMissing -gt 0) {
            $who = @($Stats.LicenseUnknown.Keys | Sort-Object | ForEach-Object { '{0}({1})' -f $_, [int]$Stats.LicenseUnknown[$_] })
            $m += ('；另剔除 {0} 条**无 license 信息**{1}' -f $Stats.LicenseMissing, $(if ($who.Count -gt 0) { '（' + ($who -join ', ') + '）' } else { '' }))
        }
        $notes += $m
    }
    $left = $Stats.Input - $Stats.Archived - $Stats.Stale - $Stats.LicenseMismatch - $Stats.LicenseMissing
    if ($Stats.Input -gt 0 -and $left -eq 0) {
        $notes += ('质量过滤后 0 条（过滤前 {0} 条）：这是过滤结果，不是源无命中；放宽 -ActiveWithin/-License 或去掉 -ExcludeArchived 再看' -f $Stats.Input)
    }
    return $notes
}
function Write-RepoQualityWarnings {
    param($Stats, [int]$ActiveWithin = 0, [switch]$ExcludeArchived, [string]$License = '')
    foreach ($n in @(Get-RepoQualityNotes -Stats $Stats -ActiveWithin $ActiveWithin -ExcludeArchived:$ExcludeArchived -License $License)) {
        Add-EngineWarning -Engine 'RepoFilter' -Message $n -From 'filter' -To 'applied'
    }
}
# 并发检索代码实现证据（GitHubCode → GitLabBlobs → GrepApp → SEExcerpts → Sourcegraph 兜底，注册表保序）—— 失败时回退串行（AC-P3-1）
function Invoke-ConcurrentCodeSearch {
    param(
        [string]$Keyword,
        [int]$Limit,
        [string]$Language,
        # U-192/U-198：作用域内引擎名单与仓库/路径/匹配语义（只在显式给出时下发给引擎）
        [object[]]$Engines,
        [string]$RepoScope,
        [string]$PathFilter,
        [switch]$MatchCase,
        [switch]$UseRegexp
    )
    $all = @()
    # U-192：-RepoScopeMode only 时由调用方传入**作用域内**引擎名单（只含支持仓库过滤的源）。
    #   ★按「值是否为 null」判断，不能按 Count>0，也不能看 PSBoundParameters：add 模式调用方传的是 `-Engines $null`
    #   （参数**已绑定**但值为空）—— 用绑定判断会让 add 模式拿到空名单 ⇒ 一个引擎都不跑（U-158E 立刻红）。
    #   only 模式传 `@()`（空数组 = 一个可用源都没有）⇒ 必须真的返回空，不能回退全量（那等于取消限定）。
    $engines = if ($null -ne $Engines) { @($Engines) } else { @(Get-EnabledEngines -Engines (Get-EngineByKind -Kind 'code')) }
    if (@($engines).Count -eq 0) { return @() }
    # U-197（2026-10-21）：`-Language` 只对注册表声明 LangFilter 的源生效；其余源**显式告警**（不假装过滤了）。
    if (-not [string]::IsNullOrWhiteSpace($Language)) {
        foreach ($e in $engines) {
            if (-not $e.LangFilter) {
                Add-EngineWarning -Engine $e.Name -Message ("-Language '{0}' 未应用：该源不支持语言过滤" -f $Language) -From 'parameter' -To 'ignored'
            }
        }
    }
    # U-198：matchCase/useRegexp 只有 grep.app 认（已实测其 inputSchema）；其余源明说未应用
    if ($MatchCase -or $UseRegexp) {
        foreach ($e in $engines) {
            if ($e.Name -ne 'GrepApp') {
                Add-EngineWarning -Engine $e.Name -Message ('-MatchCase/-UseRegexp 未应用：该源不支持匹配语义开关') -From 'parameter' -To 'ignored'
            }
        }
    }
    $poolArgs = @{ Keyword = $Keyword; Limit = $Limit; Language = $Language }
    if ($RepoScope) { $poolArgs['RepoScope'] = $RepoScope }
    if ($PathFilter) { $poolArgs['PathFilter'] = $PathFilter }
    if ($MatchCase) { $poolArgs['MatchCase'] = $true }
    if ($UseRegexp) { $poolArgs['UseRegexp'] = $true }
    try {
        $all = @(Invoke-EnginePool -Engines $engines -Label '并发代码检索' -TrackStatus -EngineDeadlineSec $script:Cfg.EngineDeadlineCodeSec -EngineArgs $poolArgs)   # U-17：默认 0 = 不设截止
    }
    catch {
        # 降级：Runspace 不可用时回退串行（AC-P3-1）；v1.33.0：沿用已过滤引擎名单
        Write-ColorOutput "并发代码检索池不可用，回退串行: $_" "Yellow"
        foreach ($e in $engines) {
            $all += Invoke-EngineSerial -Engine $e -EngineArgs $poolArgs
        }
    }
    return $all
}
# v1.19.0 ①研究源并发化：10 个研究信源并行检索（复用 H1 注册表 + H2 依赖注入规范），
# 目标：研究模式 p95 15s+（串行）→ 3-5s。SE 引擎特判透传 -Site；S2 引用补全（顺序依赖）由主流程串行后置。
# 失败引擎跳过不阻断；Runspace 不可用回退串行（与既有并发函数同构）。
function Invoke-ConcurrentResearchSearch {
    param([string]$Keyword, [int]$Limit, [string]$Site)
    $all = @()
    # v1.33.0 P1：MCPS_DISABLE 过滤在此统一应用（主流程 coverage 同口径过滤）
    # v1.40.0：再叠加可选付费源可用性（Test-ResearchEngineAvailable），与 L4300 的 Requested 同源判定
    $engines = @(Get-EnabledEngines -Engines @(Get-EngineByKind -Kind 'research' | Where-Object { Test-ResearchEngineAvailable $_ }))
    # v1.42.0（甲）：研究期间启用**请求层**上限（见 Invoke-ApiRequest 顶部）—— 否则 Stop() 停不住同步 HTTP。
    try { if ([int]$script:Cfg.EngineHardCapSec -gt 0) { $env:MCPS_RESEARCH_HARD_CAP = [string][int]$script:Cfg.EngineHardCapSec } } catch { }
    try {
        try {
            $all = @(Invoke-EnginePool -Engines $engines -Label '并发研究检索' -EngineDeadlineSec $script:Cfg.EngineDeadlineSec -EngineArgs @{ Keyword = $Keyword; Limit = $Limit; Site = $Site })
        }
        catch {
            # 降级：Runspace 不可用回退串行（H1 注册表驱动）
            Write-ColorOutput "研究并发池不可用，回退串行: $_" "Yellow"
            foreach ($e in $engines) {
                $a1 = @{ Keyword = $Keyword; Limit = $Limit }
                if ($e.Name -eq 'SE') { $a1['Site'] = $Site }
                $all += Invoke-EngineSerial -Engine $e -EngineArgs $a1
            }
        }
    }
    finally {
        # 必须清除：否则同进程内后续 code/repo（上限 17/29s）会被误 clamp 到 10s
        try { Remove-Item Env:\MCPS_RESEARCH_HARD_CAP -ErrorAction SilentlyContinue } catch { }
    }
    # v1.42.0（O-2）：记一轮逐源产出（仅阈值>0；默认关闭 ⇒ 零副作用）
    try {
        if ([int]$env:MCPS_ZERO_STREAK_THRESHOLD -gt 0) {
            $counts = @{}
            foreach ($r in $all) { $pn = [string]$r.Platform; if ($pn) { if (-not $counts.ContainsKey($pn)) { $counts[$pn] = 0 }; $counts[$pn]++ } }
            $ran = @{}
            foreach ($e in $engines) {
                $stt = $null; try { $stt = Get-EngineStatus -Name $e.Name } catch { }
                $ran[$e.Name] = ($stt -eq 'ok' -or $stt -eq 'empty' -or ($counts.ContainsKey($e.Name) -and $counts[$e.Name] -gt 0))
            }
            Save-ZeroStreakState -Counts $counts -Ran $ran
        }
    } catch { }
    # P0-3（2026-10-19）：把「本轮哪些源零产出」**说出来**，但不自动降级（降级=改用户默认，需显式设阈值）。
    #   实测动机：批模式 8 查询里 7/11 源零产出，而输出只有逐源 reason，用户看不到「整体覆盖」。
    #   零产出按**引擎产出**判定（$e.Platforms 命中数 = 0），不依赖 ReasonCodes（该层在上游才算出）。
    try {
        $zeroNames = @()
        foreach ($e in $engines) { $hit = 0; foreach ($r in $all) { if ($e.Platforms -contains [string]$r.Platform) { $hit++ } }; if ($hit -eq 0) { $zeroNames += $e.Name } }
        if ($zeroNames.Count -ge 3) {
            Add-EngineWarning -Engine 'Research' -Message ("本轮 {0}/{1} 源零产出：{2}。批模式下若并发>1，多为并发拥塞（MCPS_BATCH_MAX_PARALLEL=1 换覆盖，实测 +15.8% 产出/2.8× 耗时）；长期零产出可设 MCPS_ZERO_STREAK_THRESHOLD=5 自动降级" -f $zeroNames.Count, @($engines).Count, ($zeroNames -join ' '))
        }
    } catch { }
    return $all
}
