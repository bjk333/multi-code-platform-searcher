# ==============================================================================
# lib/core.ps1 -- Multi-Code-Platform Searcher | B3-2 模块拆分（v1.54.0）
#
# 运行时基座：输出通道（stdout/stderr 分工）、.env 白名单加载、引擎状态与封套、
#   预算（时间/总量/池）、自动模式规划、结果表展示。
#
# 契约：本文件只定义（函数 / $script: 数据），无顶层副作用；由主脚本按固定顺序点源加载。
#   · 作用域：点源进主脚本作用域，故 $script: 指向主脚本；版本号/参数等由主脚本提供。
#   · 不要在这里 exit、不要写 stdout：进度与产物分别走 Write-ColorOutput / Write-PayloadOutput。
#   · 新增函数放对应模块；跨模块调用无需前置声明（全部在运行前定义完毕）。
# ==============================================================================

# 早期定义：4.7 的 .env 加载提示与后续多处都需要，必须在 top-level 顺序执行中先于调用点定义
function Write-ColorOutput {
    param([string]$Text, [string]$Color = "White")
    if ($AsJson) { return }
    # U-266（v1.53.35）：重定向时写 **stderr**，不再写成功流。
    #   病灶：`Write-Output` 把进度串写进**成功流**。在 runspace 池里，成功流就是 `Invoke()` 的返回值集合
    #   ⇒ 引擎函数返回封套后，集合变成 `[string, 封套]`，`ConvertTo-EngineEnvelope` 见数组即判 `engine/0`
    #   ⇒ 引擎成功却记成"旧契约"，下游还可能把 string 当结果项（U-263/U-264/U-265 三个夹具都被迫桩掉本函数，
    #   桩掉就等于**把被测路径换了一条**，这类绿不算数）。
    #   纪律：成功流只承载"值"（封套 / JSON 载荷）；进度、告警、提示一律 stderr。
    #   仍然"不被吞"：捕获方通常两者都收；只收 stdout 的调用方本来就该只看到值。
    if ([Console]::IsOutputRedirected) { [Console]::Error.WriteLine($Text) }
    else { Write-Host $Text -ForegroundColor $Color }
}
function Write-PayloadOutput {
    param([string]$Text, [string]$Color = "White")
    if ($AsJson) { return }
    # U-266：与 Write-ColorOutput 的分工 —— **产物 vs 进度**。
    #   产物（用法横幅 / 结果表 / Doctor 报告 / 下载落点）是这次调用的**答案**：重定向时用户要的就是它 ⇒ 成功流。
    #   进度 / 告警 / 提示（"正在搜索…"、"退避 2s 后重试"）⇒ stderr（Write-ColorOutput）。
    #   ★为什么不能只留一个：把产物也赶去 stderr，`.\x.ps1 -Keyword k > out.txt` 会得到空文件；
    #     把进度也留在成功流，runspace 池里 `Invoke()` 的集合就会混进字符串（U-266 的病灶）。
    #   ★为什么不用 Write-Host 一把梭：实测 runspace 内**没有宿主**，Write-Host 被直接吞掉
    #     （_verify 探针：进程级 Write-Host 进重定向文件，runspace 内那行完全不出现）⇒ 拿静默换干净，比原缺陷更坏。
    if ([Console]::IsOutputRedirected) { Write-Output $Text }
    else { Write-Host $Text -ForegroundColor $Color }
}
# R2 输出契约结构化校验（PS5.1 无 Test-Json，手写轻量校验）：确保 version 为字符串、
# results 为数组且每项含必填字段、metrics 含必填数值字段。返回 @{Ok; Reason}。
function Test-AsJsonContract {
    param($Payload)
    try {
        if ($null -eq $Payload) { return @{ Ok = $false; Reason = 'payload 为空' } }
        if ([string]::IsNullOrWhiteSpace([string]$Payload.version)) { return @{ Ok = $false; Reason = '缺少 version' } }
        if ($null -eq $Payload.results -or $Payload.results -is [string] -or ($Payload.results -isnot [System.Collections.IEnumerable])) {
            return @{ Ok = $false; Reason = 'results 非数组' }
        }
        # 仓库结果需含 Stars；代码证据结果（含 File 字段）以 Name/Platform/Url/File 为准，Stars 可选。
        # 与 Display-Results 的双模判定（含 File 即代码证据）保持一致。
        $i = 0
        foreach ($r in $Payload.results) {
            $i++
            if ($null -eq $r -or $r -is [string]) { return @{ Ok = $false; Reason = "results[$i] 非对象" } }
            $isCode = ($r.PSObject.Properties.Name -contains 'File')
            $reqResult = if ($isCode) { @('Name', 'Platform', 'Url', 'File') } else { @('Name', 'Platform', 'Url', 'Stars') }
            foreach ($f in $reqResult) {
                if (-not ($r.PSObject.Properties.Name -contains $f)) { return @{ Ok = $false; Reason = "results[$i] 缺字段 $f" } }
            }
        }
        $reqMetrics = @('ElapsedMs', 'ResultCount', 'CacheHit')
        foreach ($f in $reqMetrics) {
            if (-not ($Payload.metrics.PSObject.Properties.Name -contains $f)) { return @{ Ok = $false; Reason = "metrics 缺字段 $f" } }
        }
        return @{ Ok = $true; Reason = '' }
    } catch {
        return @{ Ok = $false; Reason = "校验异常: $($_.Exception.Message)" }
    }
}
function Test-EnvKeyAllowed {
    param([string]$Key, [bool]$FromSkillDir)
    if ($script:EnvTokenKeys -contains $Key) { return $true }
    if (-not $FromSkillDir) { return $false }
    if ($script:EnvConfigKeys -contains $Key) { return $true }
    if ($Key -like 'MCPS_*') { return $true }
    return $false
}
function Load-EnvFile {
    param([string]$Path, [switch]$FromSkillDir)
    if (-not (Test-Path -LiteralPath $Path)) { return @() }
    $ignored = @()
    try {
        foreach ($line in [System.IO.File]::ReadAllLines($Path, [System.Text.Encoding]::UTF8)) {
            $l = $line.Trim()
            if (-not $l -or $l.StartsWith('#')) { continue }
            if ($l -match '^(?<k>[A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?<v>.*)$') {
                $k = $Matches['k']
                if (-not (Test-EnvKeyAllowed -Key $k -FromSkillDir:$FromSkillDir.IsPresent)) {
                    $ignored += $k
                    continue
                }
                $v = $Matches['v'].Trim().Trim('"').Trim("'")
                if (-not [Environment]::GetEnvironmentVariable($k)) {
                    [Environment]::SetEnvironmentVariable($k, $v)
                }
            }
        }
    } catch {
        # 只记事实，不改退出码：匿名检索仍可用，但"令牌为何没生效"必须能自证。
        if ($null -eq $script:EnvLoadErrors) { $script:EnvLoadErrors = @() }
        $script:EnvLoadErrors += [PSCustomObject]@{ Path = $Path; Error = "$($_.Exception.Message)" }
    }
    return @($ignored | Select-Object -Unique)
}
# v1.21.0：引擎状态写入/读取辅助（Runspace 内经 Needs 注入，主流程直接调用）
function Set-EngineStatus {
    param([string]$Name, [string]$Status, [string]$Reason = '')
    $script:_engineStatus[$Name] = $Status
    if ($Reason) { $script:_engineStatusReason[$Name] = $Reason }
}
function Get-EngineStatus {
    param([string]$Name)
    $s = $null
    [void]$script:_engineStatus.TryGetValue($Name, [ref]$s)
    if (-not $s) { $s = 'unknown' }
    return $s
}
function Test-EngineStatus {
    param([string]$Name, [string]$Status)
    return ((Get-EngineStatus -Name $Name) -eq $Status)
}
# ─────────────── B2-1（U-258，2026-10-26）：EngineContract v1 ───────────────
# **先纠正一条被写进源码的错误前提**（L1193 原话："引擎在 runspace 内的 Set-EngineStatus 写不进父作用域"）。
#   2026-10-26 实测**不成立**：`_engineStatus` 是 ConcurrentDictionary 且在 `_injectVars` 里，注入的是**引用**，
#   runspace 内写入父侧立即可见（`_verify/probe-runspace-status.ps1`：A/B 两臂都看到 ok）；
#   并发写也不丢（`probe-runspace-hashtable-race.ps1`：8 runspace × 20 键 × 40 轮 = 6400 键零丢失，普通 Hashtable 都不丢）。
#   ⇒ 封套不是为了"把状态传回来"。它解决的是三件确实没解决的事：
#     ① 状态是**旁路**：引擎提前 return（含陈旧缓存兜底、鉴权早退）就没人写，池尾只能按 `$res.Count` 猜 ——
#        U-157 的「results=20 而 ReasonCodes=zero-hit」正是这条旁路漏了一次写；
#     ② reasonCode 由**文案正则**猜（L7863 `$rtxt -match '预算已用尽'`）—— 改一句人读文案就改机器判定；
#     ③ requests / quota / partial / elapsedMs 只有全局口径，没有逐引擎口径（C4）。
#   所以 v1 的形态是：引擎返回**一条自包含事实记录**，判定归 L1（本文件的 Resolve-EngineVerdict），
#   引擎不再自报 status —— 自报与派生只能有一个真源，否则又是"同一事实两处说不同话"。
# 契约版本：engine/1 = 新封套；engine/0 = 兼容层给旧引擎现包的（**不派生 verdict**，旧路径逐位不变）。
function New-EngineEnvelope {
    # 引擎侧唯一构造入口。参数刻意只收**事实**（results/requests/partial/failure），不收 status：
    #   把"我成功了"这种判断留给 L1，引擎只负责如实上报"我发了几个请求、拿到什么、哪里失败了"。
    param(
        [string]$Engine, [string]$Kind,
        [object[]]$Results = @(),
        [bool]$Partial = $false,
        [hashtable]$Requests = @{ attempted = 0; succeeded = 0; failed = 0 },
        [hashtable]$Quota = @{ class = 'unknown'; limit = $null; remaining = $null; resetAt = $null },
        [hashtable]$Failure = $null,          # $null 或 @{ reasonCode='<12 值之一>'; reason='<含建议的人读说明>' }
        $StartedAt = $null                    # [DateTime]::UtcNow；给了就算 elapsedMs，没给就 $null（不许编 0）
    )
    $elapsed = $null
    if ($StartedAt -is [datetime]) { $elapsed = [int][Math]::Max(0, ([datetime]::UtcNow - $StartedAt).TotalMilliseconds) }
    return [PSCustomObject]@{
        contract  = 'engine/1'
        engine    = $Engine
        kind      = $Kind
        results   = @($Results)
        partial   = [bool]$Partial
        elapsedMs = $elapsed
        requests  = $Requests
        quota     = $Quota
        failure   = $Failure
    }
}
function Resolve-EngineVerdict {
    # L1 的唯一判定点（纯函数：不读 $script:、不写状态表、不打印）。表驱动，规则见 02-架构设计-v2 §3.1。
    #   results>0 且无 failure          ⇒ ok
    #   results=0 且无 failure          ⇒ empty / zero-hit（"搜了没结果"是**成功**，不是失败）
    #   results>0 且有 failure          ⇒ degraded（保留首因）
    #   results=0 且有 failure ∈ {filtered, budget-truncated} ⇒ empty / 该码（**我方主动放弃**，见下）
    #   results=0 且有其余 failure      ⇒ blocked（未执行类原因）/ error（执行了但失败）
    param($Envelope)
    $n = @($Envelope.results).Count
    $f = $Envelope.failure
    if (-not $f) {
        if ($n -gt 0) { return [PSCustomObject]@{ Status = 'ok'; ReasonCode = ''; Reason = '' } }
        return [PSCustomObject]@{ Status = 'empty'; ReasonCode = 'zero-hit'; Reason = '检索成功但 0 命中' }
    }
    $rc = if ($f.reasonCode) { [string]$f.reasonCode } else { 'error' }
    $rs = if ($f.reason) { [string]$f.reason } else { '' }
    if ($n -gt 0) { return [PSCustomObject]@{ Status = 'degraded'; ReasonCode = $rc; Reason = $rs } }
    # ★自设截断类（B2-1/U-264、U-265）：`filtered`（结果被我们的质量门槛丢掉）与 `budget-truncated`
    #   （我们的调用预算用尽、没搜完）都是**我方主动放弃**，不是源坏了 ⇒ n=0 时判 empty 而**不是** error。
    #   为什么必须显式：归 error ⇒ legacy 落 Degraded ⇒ 从 coverage 的 executed 组掉出 ⇒ Verdict 可能落
    #   none（"请求了引擎但全未执行"）。GitLabBlobs 在默认预算下 100% 走这条（有 token 时预算必然在项目搜索后
    #   耗尽）—— 那正是 U-158E A-2 对照臂实测抓到的谎；当时靠把状态改成 empty 绕过去，现在它是判定表里的一条规则。
    if ($rc -in @('filtered', 'budget-truncated')) { return [PSCustomObject]@{ Status = 'empty'; ReasonCode = $rc; Reason = $rs } }
    # blocked = 这件事**没被执行**（缺凭据/被禁/健康跳过/配额耗尽/池没收工），与"执行了但失败"必须分开，
    #   否则用户会去排查网络，而实际要做的是配 key / 等充值 / 改配置。
    $blocked = @('missing-credential', 'tool-missing', 'user-disabled', 'not-run', 'health-skip', 'quota-exhausted')
    $st = if ($blocked -contains $rc) { 'blocked' } else { 'error' }
    return [PSCustomObject]@{ Status = $st; ReasonCode = $rc; Reason = $rs }
}
function ConvertTo-LegacyEngineStatus {
    # verdict → 既有内部状态串（coverage 的三分类只看这个串，见 L7838-7840）。
    #   刻意**不新增状态值**：新增会让 U-160 派生表与 U-89 样本门同时失效，而 B2 的题目不是改对外四态。
    #   degraded → ok：有产出就是有产出，降级事实由 warnings[] 承载（旧口径如此，不改）。
    param($Verdict)
    switch ($Verdict.Status) {
        'ok' { return 'ok' }
        'empty' { return 'empty' }
        'degraded' { return 'ok' }
        'blocked' {
            switch ($Verdict.ReasonCode) {
                'missing-credential' { return 'auth_missing' }
                'tool-missing' { return 'tool_missing' }
                'network-unavailable' { return 'network_unavailable' }
                # ★quota-exhausted（B2-1/U-264）：verdict 层归 blocked 是对的（actionable = 充值/换 key，
                #   与 auth_missing 同类），但 legacy **绝不能落 unknown** —— unknown ⇒ coverage 的 NotRun
                #   ⇒ 载荷会写着"这个源压根没跑"，而事实是它发了请求、被 402 拒了。那是明确的谎。
                #   error ⇒ Degraded（"执行过但失败"）才是准确的分类；"该充值"这件事由 Reason 文本承载，
                #   不该由四态分类承载（分类是给人做汇总判断的，不是给建议的）。
                'quota-exhausted' { return 'error' }
                default { return 'unknown' }   # not-run / user-disabled / health-skip ⇒ 确实未执行
            }
        }
        default {
            switch ($Verdict.ReasonCode) {
                'network-unavailable' { return 'network_unavailable' }
                'rate-limited' { return 'rate_limited' }
                default { return 'error' }
            }
        }
    }
}
function ConvertTo-EngineEnvelope {
    # 兼容层（B2-2）：旧引擎返回数组/空/单个 PSCustomObject ⇒ 现包成 engine/0。
    #   ★engine/0 **不派生 verdict**：调用方必须继续走旧路径（状态表 + 池尾兜底），否则 22 个未迁移引擎的行为会变。
    param([string]$Engine, [string]$Kind, $Result)
    # ★@($null) 是**长度 1 的数组**（PS 语义），不是空数组 —— 引擎 `return @()` 与 `return $null` 必须归一到同一形态，
    #   否则兼容层会把一个 $null 当成"一条结果"，下游再按 .Platform 过滤时表现为"某源贡献了一条空壳"。
    $items = @($Result | Where-Object { $null -ne $_ })
    if ($items.Count -eq 1 -and $items[0] -and $items[0].PSObject.Properties['contract'] -and ([string]$items[0].contract -like 'engine/*')) {
        return $items[0]
    }
    return [PSCustomObject]@{
        contract = 'engine/0'; engine = $Engine; kind = $Kind; results = $items
        partial = $false; elapsedMs = $null; requests = $null; quota = $null; failure = $null
    }
}
function Get-EnginePoolDefs {
    # H1：Needs 动态聚合（保序去重）+ 引擎函数自身定义（& $EngineFunc 需要它存在）。
    #   B2-5 抽出来是为了守住 U-163-2 的 100 行红线（Invoke-EnginePool 一个字节都没多写就被顶到 120 行）。
    param($Engines)
    $needed = Get-EngineNeeds -Engines $Engines
    $defs = @()
    foreach ($fn in $needed) {
        if (Test-Path "function:$fn") { $defs += "function $fn { $((Get-Item function:$fn).Definition) }" }
    }
    foreach ($e in $Engines) {
        if (Test-Path "function:$($e.Func)") { $defs += "function $($e.Func) { $((Get-Item "function:$($e.Func)").Definition) }" }
    }
    return $defs
}
function Add-PoolStat {
    # B2-5（U-260）：把本池的 execution 事实追加到 `_poolStats`。抽成函数是为了让 Invoke-EnginePool
    #   守住 U-163-2 的 100 行红线（上一次就是因为内联这段冲到 120 行被门抓到）。
    param($Mode, [int]$BudgetSec, $SwRun, [bool]$EarlyStop, [int]$Produced)
    try {
        if ($null -eq $script:_poolStats) { return }
        $script:_poolStats.Add([PSCustomObject]@{
                mode       = [string]$Mode
                budgetMs   = [int]([Math]::Max(0, $BudgetSec) * 1000)
                spentMs    = [int]$SwRun.ElapsedMilliseconds
                earlyStop  = [bool]$EarlyStop
                sufficient = [bool]($Produced -ge 2)
            })
    } catch { }
}
function New-ExecutionBlock {
    # B2-5（U-260）：`execution` 块的**唯一**构造点（纯函数：不读 $script:，不打印）。
    #   抽出来有两个理由：① 载荷里那一段是 20 行内联，没人测得到；② 「哪些源算 skipped」这条判定
    #   必须只有一处 —— 它此前散在 coverage 的 skip 码、Skip-ModeByBudget 的文案、以及 notRun 集合三处。
    # 参数：
    #   -PoolStats     逐池事实（Invoke-EnginePool 在池内 append；单平台直连不产生池记录）
    #   -ReasonCodes   coverage 用的那份 [ordered]@{engine=code}（**同一份事实**，不另算）
    #   -ReasonTexts   引擎状态原因表（_engineStatusReason）；用来识别"预算跳过"这类**有码但码不准**的情形
    #   -TotalBudgetSec/-SpentMs/-ReserveMs  总预算、墙钟、预留
    #   -Ledger        账本汇总（B2-6：Save-ApiLedger 的产物）。**只有 payload 一个调用点会传**；
    #                  为 $null 时本块给 `ledger=$null`（= 调用点没提供账本），不编一个"0 行"冒充"跑过但没请求"。
    param($PoolStats = @(), $ReasonCodes = $null, $ReasonTexts = $null, [int]$TotalBudgetSec = 0, [int]$SpentMs = 0, [int]$ReserveMs = 1500, $Ledger = $null)
    $pools = @($PoolStats | Where-Object { $_ })
    $codes = @{}
    if ($ReasonCodes) { foreach ($k in @($ReasonCodes.Keys)) { $codes[[string]$k] = [string]$ReasonCodes[$k] } }
    # "没执行"的判定：① 语义上就是未执行的码；② 文案里明写"未执行（不是 0 命中）"（Skip-ModeByBudget 的原话）。
    #   ★② 必须留着：那批引擎的历史码是 `error`（不是 budget-truncated），只按码判会把它们漏出 skipped，
    #   于是"4 个源压根没跑"这件事在 execution 里看不见 —— 那正是本仓反复要治的那种谎。
    $skipCodes = @('health-skip', 'user-disabled', 'not-run', 'missing-credential', 'tool-missing')
    $skipped = @()
    foreach ($k in @($codes.Keys | Sort-Object)) {
        $why = ''
        if ($ReasonTexts) { try { if ($ReasonTexts.ContainsKey($k)) { $why = [string]$ReasonTexts[$k] } } catch { } }
        $notRun = ($why -match '未执行（不是 0 命中）')
        if ($skipCodes -contains $codes[$k] -or $notRun) {
            $rc = if ($codes[$k]) { $codes[$k] } else { 'not-run' }
            if ($notRun -and $skipCodes -notcontains $rc) { $rc = 'budget-truncated' }
            $skipped += [PSCustomObject]@{ engine = $k; reasonCode = $rc }
        }
    }
    $truncated = (@($pools | Where-Object { $_.earlyStop }).Count -gt 0)
    if (-not $truncated) {
        foreach ($k in @($codes.Keys)) { if (@('deadline', 'budget-truncated') -contains $codes[$k]) { $truncated = $true; break } }
    }
    # "被预算整段跳过"也是截断 —— 它的码历史上是 error，只看码会漏（实测：4 个 repo 源没跑，execution 却说没截断）。
    if (-not $truncated -and @($skipped | Where-Object { $_.reasonCode -eq 'budget-truncated' }).Count -gt 0) { $truncated = $true }
    return [PSCustomObject]@{
        budgetMs  = [int]([Math]::Max(0, $TotalBudgetSec) * 1000)
        spentMs   = [int][Math]::Max(0, $SpentMs)
        reserveMs = [int][Math]::Max(0, $ReserveMs)
        truncated = [bool]$truncated
        skipped   = @($skipped)
        pools     = $pools
        ledger    = $Ledger
    }
}
function Reset-EngineVerdicts {
    # B2-1（U-258）：每轮清空 verdict 表。抽成函数**只为了能被门直接调用**（内联在 7300 行附近没人测得到）。
    #   为什么必须清：某轮引擎被 deadline 杀掉时走 engine/0、不写 verdict；留着上一轮的值，
    #   coverage 会把**过期**的 reasonCode 当成这轮的（"上轮 rate-limited" ⇒ "这轮也限流"）。
    try { $script:_engineVerdict.Clear() } catch { }
}
function Resolve-EngineResultEnvelope {
    # B2-1（U-258）：单引擎出口的**唯一**归一 + 判定点（池内与串行回退共用）。
    #   抽出来的两个理由：① 池与串行两条路必须同一套语义（否则"池不可用"会成为唯一不认封套的路径）；
    #   ② Invoke-EnginePool 已顶到 U-163 的 100 行红线，这段必须外提。
    param($Engine, $Raw)
    $envl = ConvertTo-EngineEnvelope -Engine $Engine.Name -Kind $Engine.Kind -Result $Raw
    if ([string]$envl.contract -eq 'engine/1') {
        $v = Resolve-EngineVerdict -Envelope $envl
        $script:_engineVerdict[$Engine.Name] = $v
        Set-EngineStatus -Name $Engine.Name -Status (ConvertTo-LegacyEngineStatus -Verdict $v) -Reason $v.Reason
        if ($v.Status -eq 'degraded') {
            Add-EngineWarning -Engine $Engine.Name -Message ('部分失败（契约降级）：' + $v.Reason) -From 'engine contract' -To 'degraded'
        }
    }
    return @($envl.results)
}
function Invoke-EngineSerial {
    # B2-1（U-258）：串行回退路径 —— 与池内共用 Resolve-EngineResultEnvelope。
    #   否则"池不可用"这条罕见路径会变成全仓唯一不认识封套的地方：它会把封套对象当结果返回，且一条告警都没有。
    param($Engine, [hashtable]$EngineArgs)
    # B2-6（U-261）：串行路径的账本归属（池内由 runspace 包装块设；这里是主作用域，写 $script: 即可）。
    #   ★必须 try/finally 还原：串行返回后还剩着"上一个引擎"的话，紧随其后的非引擎请求（探针/合并期）
    #   会被记到那个引擎名下 —— 账本"看起来精确但指错人"，比空串更坏。
    $prevE = [string]$script:_ledgerEngine; $prevM = [string]$script:_ledgerMode
    try {
        $script:_ledgerEngine = [string]$Engine.Name; $script:_ledgerMode = [string]$Engine.Kind
        return @(Resolve-EngineResultEnvelope -Engine $Engine -Raw (& $Engine.Func @EngineArgs))
    }
    finally { $script:_ledgerEngine = $prevE; $script:_ledgerMode = $prevM }
}
# 2026-10-02 信源体检（U-157）：**有结果就不许记"零命中"**。
#   实测症状：Gitee 隔离跑返回 20 条、Codeberg 返回 3 条，metrics.PerPlatformCount 也是 20/3，
#   但 coverage.ReasonCodes 给的是 zero-hit、Reasons 写"检索成功但 0 命中" —— 载荷自相矛盾，
#   消费方（Agent/报告）会据此得出"这个源没东西"的错误结论。
#   成因有两层，都不在这一层解决：① 引擎在 runspace 内的 Set-EngineStatus 写不进父作用域；
#   ② 父侧兜底（Invoke-EnginePool 尾部按 $res.Count 判 empty/ok）用的 $res 与合并后的结果集可能不一致。
#   与 U-155（empty→network_unavailable）对称，这里做**反向**纠正：判据只认合并后的结果集。
#   纯函数（无副作用、可单测）：仅当状态是 empty/unknown 且确实有该引擎的结果时改判 ok；
#   auth_missing / tool_missing / network_unavailable / error / rate_limited 一律不动（缺凭据不能被"有结果"掩盖）。
function Resolve-EngineStatusFromResults {
    param([string]$Status, [bool]$HasResults)
    if ($HasResults -and $Status -in @('empty', 'unknown')) { return 'ok' }
    return $Status
}
# U-160 L1（2026-10-03）：**对外四态** `ok|partial|empty|failed` —— 由 5 值 `Verdict` **机械派生**。
#   ★设计要点（外部模型协作 + 核实后采纳）：四态**只许派生、不许独立赋值** ⇒ 从根上避免"同一事实两处说法"
#   （本仓曾因 results=20 与 ReasonCodes=zero-hit 并存而自相矛盾）。派生表：
#     full→ok｜partial→partial｜degraded→partial｜none→failed｜no-engines→empty
#   理由：degraded 有引擎执行但另有受阻 ⇒ 不得冒充完整成功 ⇒ partial；
#         none = 有请求而零执行 ⇒ 就是"失败"，不是"搜了没结果"；
#         no-engines ⇒ Requested 必为空（若 Requested>0 且 Executed==0 早已被 none 截走）⇒ empty，且**必须**由
#         ReasonCodes（如 user-disabled）说明"为何没请求"，否则会被读成"空跑冒充成功"。
function Get-ContractStatus {
    param([string]$Verdict)
    switch ($Verdict) {
        'full'       { return 'ok' }
        'partial'    { return 'partial' }
        'degraded'   { return 'partial' }
        'none'       { return 'failed' }
        'no-engines' { return 'empty' }
        default      { return 'failed' }
    }
}
function Add-EngineWarning {
    param([string]$Engine, [string]$Message, [string]$From = '', [string]$To = '')
    $entry = "[$Engine] $Message"
    if ($From) { $entry += " (from: $From -> $To)" }
    $script:_engineWarnings.Enqueue($entry)
}
function Get-EngineWarnings {
    $out = @()
    $item = $null
    while ($script:_engineWarnings.TryDequeue([ref]$item)) { $out += $item }
    return $out
}
# 注册表辅助：按 Kind（可再按 Name 过滤）取引擎，保序返回
function Get-EngineByKind {
    param([string]$Kind, [string[]]$Names)
    $list = @($script:_engineRegistry | Where-Object { $_.Kind -eq $Kind })
    if ($Names) { $list = @($list | Where-Object { $Names -contains $_.Name }) }
    return $list
}
# v1.40.0（2026-10-17）：可选付费源可用性。单源判定，供「调度」与「coverage.Requested」两处共用，
#   避免出现「Requested 有它、调度没跑」⇒ Verdict 恒 partial 的口径分裂（同 MCPS_DISABLE 的历史教训）。
#   规则：DeepSeek 需要 DEEPSEEK_API_KEY；缺凭据 ⇒ 整体排除（不计入 Requested，不算 Blocked，不改 Verdict）。
# v1.42.0（O-2 · 2026-10-18）：连续 0 产出 streak 状态。**默认关闭** —— 只有 MCPS_ZERO_STREAK_THRESHOLD>0
#   时才读写（阈值 0 ⇒ 本机制完全不生效，尊重既有原则"不静默改默认"）。
#   位置：MCPS_ZERO_STREAK_FILE 或系统临时目录（不写仓库 ⇒ 发布副本也不会污染）。
function Get-ZeroStreakFile {
    if ($env:MCPS_ZERO_STREAK_FILE) { return $env:MCPS_ZERO_STREAK_FILE }
    return (Join-Path ([System.IO.Path]::GetTempPath()) 'mcps-source-streak.json')
}
function Get-ZeroStreakState {
    if ($null -ne $script:_zeroStreakCache) { return $script:_zeroStreakCache }
    $script:_zeroStreakCache = @{}
    try {
        $p = Get-ZeroStreakFile
        if (Test-Path -LiteralPath $p) {
            $j = [System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
            foreach ($pr in $j.PSObject.Properties) { $script:_zeroStreakCache[$pr.Name] = [int]$pr.Value.streak }
        }
    } catch { }
    return $script:_zeroStreakCache
}
function Save-ZeroStreakState {
    param([hashtable]$Counts, [hashtable]$Ran)
    try {
        $state = Get-ZeroStreakState
        $out = [ordered]@{}
        foreach ($n in @($state.Keys)) { $out[$n] = [PSCustomObject]@{ streak = [int]$state[$n]; lastRunAt = $null; lastCount = $null } }
        foreach ($n in @($Ran.Keys)) {
            if (-not $Ran[$n]) { continue }          # 本轮没跑成（deadline/限流/缺凭据）⇒ 不计、不清零
            $c = 0; if ($Counts.ContainsKey($n)) { $c = [int]$Counts[$n] }
            $prev = 0; if ($state.ContainsKey($n)) { $prev = [int]$state[$n] }
            $next = $prev + 1; if ($c -gt 0) { $next = 0 }
            $out[$n] = [PSCustomObject]@{ streak = $next; lastRunAt = (Get-Date).ToString('o'); lastCount = $c }
            $state[$n] = $next
        }
        $json = $out | ConvertTo-Json -Depth 5
        [System.IO.File]::WriteAllText((Get-ZeroStreakFile), $json, (New-Object System.Text.UTF8Encoding($false)))
    } catch { }
}
function Test-ResearchEngineAvailable {
    param($Engine)
    if ($null -eq $Engine) { return $false }
    if ($Engine.Name -eq 'DeepSeek' -and -not $env:DEEPSEEK_API_KEY) { return $false }
    # v1.41.0：MCPS_RESEARCH_SOURCES 白名单（逗号/分号分隔注册名）。设置后只有列出的源参与并发——
    #   用途：把长期 0 产出的源（实测 HF/MCPRegistry/NuGet/RubyGems/SE）降为「按需」。
    #   未设置 = 全跑（保持既有行为，不静默改默认）。
    if ($env:MCPS_RESEARCH_SOURCES) {
        $allow = @($env:MCPS_RESEARCH_SOURCES -split '[;,]' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
        if ($allow.Count -gt 0 -and $allow -notcontains $Engine.Name) { return $false }
    }
    # v1.42.0（O-2）：连续 0 产出降为按需。**默认关闭**（阈值 0 ⇒ 不读状态）；MCPS_FORCE_SOURCES 可强制打开。
    try {
        $thr = [int]$env:MCPS_ZERO_STREAK_THRESHOLD
        if ($thr -gt 0) {
            $force = @($env:MCPS_FORCE_SOURCES -split '[;,]' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
            if ($force -notcontains $Engine.Name) {
                $zs = Get-ZeroStreakState
                if ($zs.ContainsKey($Engine.Name) -and [int]$zs[$Engine.Name] -ge $thr) { return $false }
            }
        }
    } catch { }
    return $true
}
# 注册表辅助：聚合一组引擎的 Needs 函数名（保序去重），供 Runspace 重建函数定义
# ---------- U-41（N-18，2026-09-26）：HTTP 层函数闭包 **单源** ----------
# 事实只写一遍：凡 Runspace 里要调 Invoke-ApiRequest，就必须把它**传递依赖的全部自定义函数**一起 dot-source 进去。
# 历史上这份事实写了两处（Get-EngineNeeds 的自动补全 vs GitLab blobs 嵌套池 :1791 的手工列表），两次漏项：
#   U-02 漏 Test-RateLimit403（只补了一处）、U-40 漏 Invoke-WebRequestDirect（又只补了一处 ⇒ N-18：blobs 并行路径静默 0 命中）。
# 现在两处都从 Get-HttpLayerClosure 取；Node 门 test-n8 静态扫 Invoke-ApiRequest 体内出现的自定义命令，漏一项直接报函数名。
# 注意：函数体只返回字面量、不读 $script: 变量 —— 它自己也会被 dot-source 进 Runspace（列表含自身），Runspace 里没有 $script: 变量。
function Get-HttpLayerClosure {
    # U-132：Invoke-ApiRequest 新增传递依赖 Repair-Latin1Mojibake（U-41 门在漏项时直接报函数名，本次即由它抓出）
    # D4（2026-09-30）：Invoke-ApiRequest 拆出的 11 个顶层 helper（含外提的 Write-TlsTrace/Get-TraceUri/Get-RetryBackoff）全部入闭包：12 → 23 项。
    # P1（2026-10-19）：Get-ApiWallBudget 入闭包 —— Invoke-ApiRequest 直接调用它（请求层总预算）。
    # v1.45.7：Get-CurlFailureHint 入闭包 —— Invoke-ApiRequest 的 socks 分支在 throw 里调它（本项由 test-inject 直接抓出）。
    # v1.49.1：Test-NetworkPlaceholderReason 入闭包 —— Get-ApiRequestRouteContext（reachable 分支）直接调它，
    #   而它已经在本清单里 ⇒ 闭包必须自洽（test-inject 的 U-41 门逐引擎报"不在 Func+Needs+闭包"，本次同样由它抓出）。
    # v1.51.0：确定性失败快速失败三件套（Test-DeterministicTransportFailure / Set-DeadNetworkHost / Get-DeadNetworkHost）
    #   由 Invoke-ApiRequest 直接调用，同理必须自洽。
    return @('Get-HttpLayerClosure', 'Write-ColorOutput', 'Get-ApiHeaders', 'Repair-Latin1Mojibake', 'Test-RateLimit403', 'Invoke-WebRequestDirect', 'Test-NetworkNoProxy', 'Get-McpsProxySpec', 'Get-NetworkCandidates', 'Invoke-NetworkProbeOnce', 'Get-NetworkRoute', 'Get-NetworkRouteHint', 'Get-HostsOverride', 'Test-LoopbackAddress', 'Get-NetworkEngineName', 'Invoke-ApiRequest', 'Get-ApiWallBudget', 'Write-TlsTrace', 'Get-TraceUri', 'Get-RetryBackoff', 'Get-FullJitterWait', 'Get-ApiRequestRouteContext', 'Get-CurlFailureHint', 'Invoke-ApiSocksOnce', 'Invoke-ApiWebOnce', 'Resolve-ApiHttpFailure', 'Get-ApiNodePaths', 'Invoke-ApiNodeOnce', 'Update-ApiRetryCounters', 'Test-ApiRetryBudget', 'Test-NetworkPlaceholderReason', 'Get-TransportFailureText', 'Test-DeterministicTransportFailure', 'Set-DeadNetworkHost', 'Get-DeadNetworkHost', 'Get-ProxyBreakerState', 'Update-ProxyBreaker', 'Resolve-ProxyGatewayOutcome', 'Resolve-UnprovenRouteBudget', 'Test-UnprovenRouteTimeout', 'Invoke-ApiNodeFallback', 'Add-ApiRequestStat', 'Get-ApiRequestStats', 'Get-ApiLedgerVerdict', 'Set-ApiLedgerStatus', 'Close-ApiLedgerRow', 'Add-ApiLedgerRow', 'Get-ApiReplayKey', 'Invoke-ApiReplayOnce', 'Save-ApiReplayFixture')
}
function Get-EngineNeeds {
    param($Engines)
    $needs = @()
    foreach ($e in $Engines) { foreach ($n in $e.Needs) { if ($needs -notcontains $n) { $needs += $n } } }
    # U-02 / U-40 / U-41：并发 Runspace 里只要用到 Invoke-ApiRequest，就把 HTTP 层闭包整组带上（单源，不再逐个手补）。
    if ($needs -contains 'Invoke-ApiRequest') {
        foreach ($fn in (Get-HttpLayerClosure)) { if ($needs -notcontains $fn) { $needs += $fn } }
    }
    return $needs
}
# v1.33.0 P1：MCPS_DISABLE 引擎禁用开关（逗号/分号/空白分隔，匹配注册表 Name 或 Platforms 显示名，大小写不敏感）。
# 用途：本网已知永久降级引擎（如 grep.app 长效 429）显式跳过，省去每次重试退避等待。
# 语义：被禁引擎不进入 Requested/调度（coverage 不再计入），并写 warnings[] 说明——可审计，不静默。
function Get-DisabledEngineSpecs {
    $spec = $env:MCPS_DISABLE
    if (-not $spec) { return @() }
    return @($spec -split '[,;\s]' | ForEach-Object { $_.Trim().ToLower() } | Where-Object { $_ })
}
function Test-EngineDisabled {
    param($Engine)
    $disabled = Get-DisabledEngineSpecs
    if ($disabled.Count -eq 0) { return $false }
    foreach ($d in $disabled) {
        foreach ($label in (@($Engine.Name) + @($Engine.Platforms))) {
            if ($label -and $label.ToLower() -eq $d) { return $true }
        }
    }
    return $false
}
function Get-EnabledEngines {
    param($Engines)
    $out = @()
    foreach ($e in @($Engines)) {
        if (Test-EngineDisabled -Engine $e) {
            Add-EngineWarning -Engine $e.Name -Message '已按 MCPS_DISABLE 配置跳过' -From 'engine registry' -To 'skip (user-disabled)'
        } else { $out += $e }
    }
    return @($out)
}
# v1.33.0 P1：单次运行总时长预算（秒）——并发编排的 EndInvoke 循环在超预算后 Stop 剩余引擎（标 Degraded + warnings），
# 拦截病态长尾（如 GitLab 项目级回退与多源重试叠加把代码证据拖到 111s 的场景）。默认 120s（正常检索 5-30s 不受影响），
# MCPS_TIME_BUDGET_SEC 可覆盖（0=不限，非法值回退默认）。
function Get-TimeBudgetSec {
    $raw = $env:MCPS_TIME_BUDGET_SEC
    if ([string]::IsNullOrWhiteSpace([string]$raw)) { return $script:Cfg.TimeBudgetDefaultSec }
    $v = 0
    if ([int]::TryParse([string]$raw, [ref]$v) -and $v -ge 0) { return $v }
    return $script:Cfg.TimeBudgetDefaultSec
}
function Get-TotalBudgetSec {
    # U-241（v1.53.24）：**整轮总预算**（跨池共享）。0 = 不限。
    #   病灶（验收 F16 / C3）：单池预算在 Invoke-EnginePool 里每池各取一次，-Auto 顺序跑 repo/code/research
    #   ⇒ 最坏 = 单池 × 池数（产品默认 120x3=360s；本机 .env 240x3=720s），且只告知不限制。
    #   语义（刻意的）：
    #     · `MCPS_TOTAL_BUDGET_SEC` 显式设置 ⇒ 逐字生效（0 = 关闭，回到旧的每池独立）
    #     · 未设 ⇒ 单模式 0（不限，行为与 v1.53.23 逐位一致）；`-Auto` 取 Cfg.TotalBudgetAutoDefaultSec
    #     · 非法值 ⇒ **回落默认 + 一条 warning**（把"写错了"读成"不限"会让最坏墙钟悄悄回来）
    #   ★不改 Get-TimeBudgetSec 的取值（U-226 的"每池预算不被乘"守卫仍成立）：本函数是**另一层**约束。
    $raw = [string]$env:MCPS_TOTAL_BUDGET_SEC
    if ([string]::IsNullOrWhiteSpace($raw)) { return $(if ($Auto) { [int]$script:Cfg.TotalBudgetAutoDefaultSec } else { 0 }) }
    if ($script:_totalBudgetRaw -ne $raw) {
        $script:_totalBudgetRaw = $raw
        $v = 0
        if ([int]::TryParse($raw, [ref]$v) -and $v -ge 0) { $script:_totalBudgetVal = $v }
        else {
            $script:_totalBudgetVal = $(if ($Auto) { [int]$script:Cfg.TotalBudgetAutoDefaultSec } else { 0 })
            Add-EngineWarning -Engine 'config' -Message ("MCPS_TOTAL_BUDGET_SEC 无法解析：{0}（要非负整数秒；0=不限）—— 已回落到默认 {1}s" -f $raw, $script:_totalBudgetVal)
        }
    }
    return [int]$script:_totalBudgetVal
}
function Get-RunRemainingSec {
    # U-241：本轮**剩余**总预算（秒，向上取整；0 = 不限 / 已耗尽，由调用方区分）。
    #   计时起点 = **第一次真正要发请求的时刻**（第一次调用本函数），不是进程启动：
    #   参数解析/planner/Doctor 探针不该吃掉用户的等待预算。
    #   ★只在父线程调用（池循环里算逐源截止）；不进 Runspace，故不进 _injectVars。
    param([int]$TotalSec)
    if ($TotalSec -le 0) { return 0 }
    if (-not $script:_runBudgetSw) { $script:_runBudgetSw = [System.Diagnostics.Stopwatch]::StartNew() }
    $left = [double]$TotalSec - $script:_runBudgetSw.Elapsed.TotalSeconds
    if ($left -lt 0) { return 0 }
    return [int][Math]::Ceiling($left)
}
function Get-PoolBudgetSec {
    # U-241：单池预算 = min(单池默认, 本轮剩余)。总预算关闭 ⇒ **逐位返回**单池默认（旧行为不变）。
    #   ★返回 0 在旧语义里是"该池不设预算" ⇒「总预算已耗尽」**不能**返回 0（那会变成不限），
    #     必须给 1s 让池走"超预算"路径并写明原因。
    param([int]$PoolBudgetSec)
    $total = Get-TotalBudgetSec
    if ($total -le 0) { return $PoolBudgetSec }
    $left = Get-RunRemainingSec -TotalSec $total
    if ($left -le 0) { return 1 }
    if ($PoolBudgetSec -le 0) { return $left }
    if ($left -lt $PoolBudgetSec) { return $left }
    return $PoolBudgetSec
}
function Test-RunBudgetExhausted {
    # U-241：本轮总预算是否已耗尽（留 ReserveSec 给归并/渲染/富化）。
    #   总预算未生效（单模式）⇒ 恒 $false ⇒ 单模式行为逐位不变。
    param([double]$ReserveSec = 1.5)
    $total = Get-TotalBudgetSec
    if ($total -le 0) { return $false }
    return ((Get-RunRemainingSec -TotalSec $total) -le $ReserveSec)
}
function Skip-ModeByBudget {
    # U-241：预算耗尽 ⇒ **整段模式不执行**，并把每个引擎标成 error + 写明原因。
    #   为什么不能"照跑 1s"：1s 内所有源都会 timeout，留下 12 条 deadline 噪音，
    #   而真正的事实只有一句——"这一轮没时间跑这个模式"。宁可少一条假归因。
    #   记账口径：这些引擎仍在 Requested 里（它们本来就要被请求），落到 Degraded ⇒ Verdict 不会是 full（诚实）。
    param([string]$Mode, [string]$Kind)
    $why = '本轮总预算已耗尽，未执行（不是 0 命中）'
    foreach ($e in @($script:_engineRegistry | Where-Object { $_.Kind -eq $Kind })) {
        if (-not $e -or -not $e.Name) { continue }
        if (Test-EngineDisabled -Engine $e) { continue }
        Set-EngineStatus -Name $e.Name -Status 'error' -Reason $why
    }
    Add-EngineWarning -Engine 'budget' -Message ('{0} 模式被跳过：{1}' -f $Mode, $why)
    Write-ColorOutput ('预算提示: 本轮总预算已耗尽，跳过 {0} 模式（未执行，不是 0 命中）' -f $Mode) 'Yellow'
}
function Get-PoolBudgetLabel {
    # U-241：池预算的**来源**（写进 warnings 与退出文案）。"为什么只跑了 3s"必须能一眼答出来。
    param([int]$PoolBudgetSec, [int]$EffectiveSec)
    $total = Get-TotalBudgetSec
    if ($total -gt 0 -and $EffectiveSec -le 1) { return ('本轮总预算已耗尽（总预算 {0}s）' -f $total) }
    if ($total -gt 0 -and $EffectiveSec -lt $PoolBudgetSec) { return ('本轮总预算剩余（总预算 {0}s）' -f $total) }
    return '单池预算'
}
# v1.34.0 P2：-Auto 集成模式——内嵌 query-planner.ps1 自动分类，按计划映射执行模式（可多模式三连跑）。
# 映射：research_only→research；repository_only→repo；code_evidence_only→code；
#       integrated_research_and_code→repo+code+research（一次进程内三模式，结果统一去重/排序/coverage 取并集）。
#       ★v1.48.0：上面四行只是 planner 分类的"基础模式"——实际 modes 还会经 Add-AutoResearchMode
#       追加 research（关键词无显式代码标识符时），所以 `repository_only` 的真实 modes 是 repo+research。
#       见 references/引擎链.md 的 U-143 段（那里才是准确描述）。
function Convert-PlanToModes {
    param([string]$QueryType)
    switch ($QueryType) {
        'research_only'                { return @('research') }
        'repository_only'              { return @('repo') }
        'code_evidence_only'           { return @('code') }
        'integrated_research_and_code' { return @('repo', 'code', 'research') }
        default                        { return @('repo') }
    }
}
function Test-AutoCodeIdentifier {
    # U-143：仅把显式代码语法视为标识符；PowerShell/module/script/refactor 等自然语言工程词不算。
    param([string]$Keyword)
    if ([string]::IsNullOrWhiteSpace($Keyword)) { return $false }
    # Whitespace before '(' is prose (e.g. 'methodology (overview)'), not a function call.
    # Likewise 'Multi-Agent'/'Large-Scale' are prose, not PowerShell Verb-Noun identifiers.
    $syntax = '(?:`[^`]+`|\$[A-Za-z_][A-Za-z0-9_]*|(?<![A-Za-z0-9])--[A-Za-z][A-Za-z0-9-]*|\b[A-Za-z_][A-Za-z0-9_]*::[A-Za-z_][A-Za-z0-9_]*|\b[A-Za-z_][A-Za-z0-9_]*\(|\b[A-Za-z_][A-Za-z0-9_]*_[A-Za-z0-9_]+\b|\b(?:Get|Set|New|Invoke|Test|Find|Remove|Add|Resolve|Search|Write|Read|Convert|Import|Export)-[A-Z][A-Za-z0-9]*\b)'
    return ($Keyword -cmatch $syntax)
}
function Add-AutoResearchMode {
    param([string[]]$Modes, [string]$Keyword)
    if (-not (Test-AutoCodeIdentifier -Keyword $Keyword) -and $Modes -notcontains 'research') {
        return @($Modes) + @('research')
    }
    return @($Modes)
}
function Get-AutoPlan {
    # v1.46.8（T1-4）：`-Auto` 的**计划对象**（模式 + queryType + confidence + 来源）。
    #   MCP `search_auto` 需要把"为什么跑这几种模式"如实回给 Agent：只回 modes 时，
    #   分类错了只能看到"结果不像"，看不到"planner 把它判成了 code_evidence_only"。
    param([string]$Keyword)
    $plan = [PSCustomObject]@{ QueryType = ''; Confidence = $null; Modes = @(); Source = 'planner' }
    $planner = Join-Path $ScriptDir 'query-planner.ps1'
    if (-not (Test-Path $planner)) {
        $plan.Modes = @(Add-AutoResearchMode -Modes @('repo') -Keyword $Keyword)
        $plan.Source = 'fallback-missing-planner'
        Add-EngineWarning -Engine 'AutoPlanner' -Message 'query-planner.ps1 缺失，回退仓库发现模式' -From 'auto' -To ($plan.Modes -join '+')
        return $plan
    }
    try {
        $planRaw = (& $planner -Query $Keyword) | Out-String
        $p = $planRaw | ConvertFrom-Json
        $plan.QueryType = [string]$p.queryType
        $plan.Confidence = $p.confidence
        $modes = @(Convert-PlanToModes -QueryType $plan.QueryType)
        if ($modes.Count -eq 0) { $modes = @('repo') }
        $plan.Modes = @(Add-AutoResearchMode -Modes $modes -Keyword $Keyword)
        Write-ColorOutput ("[Auto] 分类={0} (confidence={1}) → 模式: {2}" -f $plan.QueryType, $plan.Confidence, ($plan.Modes -join '+')) "Cyan"
        return $plan
    } catch {
        $plan.Modes = @(Add-AutoResearchMode -Modes @('repo') -Keyword $Keyword)
        $plan.Source = 'fallback-planner-error'
        Add-EngineWarning -Engine 'AutoPlanner' -Message ("规划失败回退仓库发现: " + $_.Exception.Message) -From 'auto' -To ($plan.Modes -join '+')
        return $plan
    }
}
function Get-AutoModes {
    param([string]$Keyword)
    return @((Get-AutoPlan -Keyword $Keyword).Modes)
}
function Get-ZhTopicExpansion {
    # v1.53.16：中文主题词 → 英文检索**短语**。**只做词表匹配**，不切词、不猜边界：命中即取，未命中不猜。
    #   重叠处理：键按长度降序扫描，命中后标记占用字符 ⇒「中文分词」不会被「分词」截胡。
    #   返回短语（不是词）：调用方需要判断「整条短语是否已有对应缩写」，见 Get-AutoSearchKeyword ③。
    param([string]$Keyword, $Map = $script:ZhTopicTermMap)
    if (-not $Keyword) { return @() }
    $taken = [bool[]]::new($Keyword.Length)
    $found = New-Object System.Collections.Generic.List[string]
    foreach ($k in @($Map.Keys | Sort-Object -Property Length -Descending)) {
        $from = 0
        while ($from -lt $Keyword.Length) {
            $at = $Keyword.IndexOf($k, $from, [StringComparison]::Ordinal)
            if ($at -lt 0) { break }
            $free = $true
            for ($i = $at; $i -lt $at + $k.Length; $i++) { if ($taken[$i]) { $free = $false; break } }
            if ($free) {
                for ($i = $at; $i -lt $at + $k.Length; $i++) { $taken[$i] = $true }
                if (-not $found.Contains($Map[$k])) { $found.Add($Map[$k]) }
            }
            $from = $at + $k.Length
        }
    }
    return @($found)
}
function Get-AutoSearchKeyword {
    # v1.45.3（2026-10-20 全量验收遗留项）：`-Auto` 的 **repo/code 检索式改写** —— 只抽 ASCII/技术词，不猜中文切词；
    #   research 保留原句（语义检索对自然语言更宽容）。
    #   依据：SKILL.md 自己写着「repo 用短关键词，不要把自然语言长句直接当仓库检索式」，而 `-Auto` 此前把原句
    #   直接下发给所有引擎。实测「调研 jwt 开源项目与代码实现」：12 源仅 4 条；同进程短词「jwt」39 条。
    #   v1.45.5（2026-10-20）：纯中文此前原样下发 ⇒ 结构性低命中（实测 1 条 vs 9 条）。现剥任务词/元词，见 ⑤。
    #   v1.53.16（2026-10-23）：**纯英文不再原样放行** —— 打包词（library/framework/…）同样稀释 AND 召回；
    #     并合入中文主题词的英文映射（见 ZhTopicTermMap）。规则收敛为：
    #     ① 抽 `[A-Za-z][A-Za-z0-9_.+#-]{1,}` 去重 → ② 去停用/打包词（**剩 <2 个则整批保留**，避免「rust library」→「rust」更泛）
    #     → ③ 含中文则合并 ZhTopicTermMap 的英文词（去重）→ ④ 有词即空格连接 → ⑤ 仍无词（纯中文且无映射）才删元词。
    param([string]$Keyword)
    if (-not $Keyword) { return $Keyword }
    $hasCjk = $Keyword -match '[\u4e00-\u9fff]'
    $stop = @('the', 'and', 'for', 'with', 'from', 'into', 'about', 'this', 'that', 'are', 'was', 'were', 'will', 'can',
        'how', 'what', 'why', 'best', 'practices', 'code', 'project', 'projects', 'open', 'source', 'implementation',
        'implementations', 'search', 'find', 'look', 'using', 'use', 'based', 'via', 'vs', 'of', 'in', 'on', 'to',
        'a', 'an', 'is', 'it', 'as', 'by', 'compare', 'comparison', 'survey', 'review',
        # v1.53.16 打包词：它们几乎只出现在 README 的营销句里，作为 AND 条件只会把主流库滤掉（实测见上）。
        'library', 'libraries', 'framework', 'frameworks', 'tool', 'tools', 'toolkit', 'sdk', 'package', 'packages',
        'example', 'examples', 'demo', 'tutorial', 'tutorials', 'guide', 'guides', 'template', 'boilerplate',
        'awesome', 'plugin', 'plugins', 'docs', 'documentation')
    $all = @([regex]::Matches($Keyword, '[A-Za-z][A-Za-z0-9_.+#-]{1,}') | ForEach-Object { $_.Value } | Select-Object -Unique)
    $kept = @($all | Where-Object { $stop -notcontains $_.ToLower() })
    $words = @(if ($kept.Count -ge 2 -or $kept.Count -eq $all.Count) { $kept } else { $all })
    if ($hasCjk) {
        # ③ 中文主题词映射：短语整条加入；但若该短语的规范缩写**已在词表里**（如查询自带 RAG），
        #    只留缩写 —— 否则「RAG + retrieval augmented generation」AND 起来反而更窄（v1.53.16 实测同类稀释）。
        foreach ($phrase in @(Get-ZhTopicExpansion -Keyword $Keyword)) {
            $abbr = $script:Cfg.AbbrevPhraseMap[$phrase]
            if ($abbr -and ($words -contains $abbr)) { continue }
            foreach ($w in @($phrase -split '\s+')) { if ($w -and $words -notcontains $w) { $words += $w } }
        }
    }
    if ($words.Count -gt 0) { return ($words -join ' ') }
    # ⑤ 纯中文（抽不出 ASCII 词）：只做「删元词」，**不切词、不猜词边界** —— 切词需要词典，属产品决策。
    #    依据（2026-10-20 实测，`-Platform All -MinStars 100 -Limit 5 -NoCache`）：
    #      「中文分词开源库」1 条 vs 「中文分词」9 条；「分布式锁的几种实现方式」3 条 vs 「分布式锁」15 条。
    #    规则：剥前缀任务词（调研/如何/寻找…）→ 反复剥后缀元词（开源库/代码/实现/方案…，长串优先）→ 修边（的/了/与/和/及/等）；
    #    剥完不足 2 字或没变化 ⇒ 原样返回（宁可不改，也不把「数据库」剥成「数据」—— 故单位「库/框/架」不入表）。
    $zh = $Keyword.Trim()
    $prefixes = @('如何用', '怎么用', '调研', '研究', '查找', '搜索', '寻找', '请问', '帮我', '我想', '如何', '怎么', '怎样') | Sort-Object Length -Descending
    $suffixes = @('的几种实现方式', '的几种实现方法', '的几种方案', '的几种实现', '的实现方式', '的实现方法', '的实现',
        '开源项目', '开源框架', '开源工具', '开源代码', '开源库', '代码实现', '代码示例', '示例代码',
        '代码', '实现', '方案', '方法', '方式', '框架', '工具', '教程', '文档', '资料', '用法', '项目') | Sort-Object Length -Descending
    foreach ($p in $prefixes) {
        if ($zh.StartsWith($p) -and ($zh.Length - $p.Length) -ge 2) { $zh = $zh.Substring($p.Length); break }
    }
    $again = $true
    while ($again) {
        $again = $false
        foreach ($s in $suffixes) {
            if ($zh.EndsWith($s) -and ($zh.Length - $s.Length) -ge 2) { $zh = $zh.Substring(0, $zh.Length - $s.Length); $again = $true; break }
        }
    }
    $zh = $zh.Trim().Trim([char[]]@('的', '了', '与', '和', '及', '等')).Trim()
    if ($zh.Length -lt 2 -or $zh -eq $Keyword) { return $Keyword }
    # 剥成「元词本身」等于没信息（实测「开源项目」→「开源」）：这类回退原句，宁可不改。
    $generic = @('开源', '项目', '代码', '实现', '方案', '方法', '方式', '框架', '工具', '教程', '文档', '资料', '用法', '开发', '系统', '平台')
    if ($generic -contains $zh) { return $Keyword }
    return $zh
}
# ---------- 展示 ----------
function Display-Results {
    param($Results)
    if (-not $Results -or $Results.Count -eq 0) { Write-PayloadOutput "未找到任何结果" "Yellow"; return }
    $isCode = $Results[0].PSObject.Properties.Name -contains "File"
    if ($isCode) {
        foreach ($r in $Results) {
            Write-PayloadOutput "[$($r.Index)] ($($r.Platform)) $($r.Name) -> $($r.File)" "White"
            if ($r.Preview) { Write-PayloadOutput "    $($r.Preview)" "DarkGray" }
            Write-PayloadOutput "    $($r.Url)" "Cyan"
        }
    }
    else {
        $Results | Format-Table -AutoSize -Property Index, Platform, @{Name = "Name"; Expression = { $_.Name }; Width = 40 }, Stars, @{Name = "Description"; Expression = { $_.Desc }; Width = 50 }
        Write-PayloadOutput "`nURLs:" "Cyan"
        foreach ($r in $Results) { Write-PayloadOutput "[$($r.Index)] $($r.Url)" }
    }
}
function Get-AutoBudgetNotice {
    # T3-8（v1.53.4，2026-10-23）：**只做告知，不动预算语义**（用户拍板）。
    #   代码事实：`Get-TimeBudgetSec` 在 `Invoke-EnginePool` 里**每池各调一次**，而 `-Auto` 顺序跑
    #   repo/code/research 多个池 ⇒ 进程内最坏 = 预算 × 实际池数（池间缝隙不计）。
    #   Doctor 的 `budgetPolicy.WorstCaseSec` 早就如实报，但那只在 `-Doctor` 里；跑 `-Auto` 的人
    #   按单池预算估时间就会等超。这里在**执行前**把这次的最坏墙钟说出来。
    #   ★行为不变：不改预算值、不做跨池共享、不提前砍池（共享预算是行为变更，需单独拍板）。
    #   池数按**实际** $Modes 数（planner 可能只选 2 个池），不用 Doctor 那个"潜在最坏 3"。
    param([int]$BudgetSec, [string[]]$Modes, [int]$TotalBudgetSec = 0)
    # U-241（v1.53.24）：总预算生效时**旧文案就是错的**（它说最坏 = 预算x池数）。
    #   这里改成"总预算 T 秒，跨 N 池共享，池间不叠加"；TotalBudgetSec=0（单模式/显式关闭）走旧文案。
    if ($TotalBudgetSec -gt 0) {
        $poolModesT = @(@($Modes) | Where-Object { $_ -eq 'repo' -or $_ -eq 'code' -or $_ -eq 'research' } | Select-Object -Unique)
        if ($poolModesT.Count -le 1) { return $null }
        return ('预算提示: 本轮总预算 {0}s（跨 {1} 个池 {2} 共享，池间不叠加）；单池上限 MCPS_TIME_BUDGET_SEC={3}s。来源：{4}' -f `
            $TotalBudgetSec, $poolModesT.Count, ($poolModesT -join '+'), $BudgetSec, $(if ($env:MCPS_TOTAL_BUDGET_SEC) { 'MCPS_TOTAL_BUDGET_SEC' } else { '-Auto 默认值' }))
    }
    if ($BudgetSec -le 0) { return $null }        # 0 = 不设预算，没有"最坏"可算
    $poolModes = @(@($Modes) | Where-Object { $_ -eq 'repo' -or $_ -eq 'code' -or $_ -eq 'research' } | Select-Object -Unique)
    if ($poolModes.Count -le 1) { return $null }  # 单池不存在叠加，提示无信息量
    #   文案只用 GBK 可表示字符：控制台代码页是 936，`⇒`(U+21D2) 会被渲染成 `?`（实测）。
    return ('预算提示: 每池独立计 MCPS_TIME_BUDGET_SEC={0}s，本次 {1} 个池（{2}）=> 最坏 {3}s（池间缝隙不计）；要缩短用 MCPS_TIME_BUDGET_SEC' -f `
        $BudgetSec, $poolModes.Count, ($poolModes -join '+'), ($BudgetSec * $poolModes.Count))
}
