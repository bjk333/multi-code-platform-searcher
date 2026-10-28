# Multi-Code-Platform Searcher PowerShell Tool（起版 v1.7.0 · 当前 v1.81.0）
# v1.81.0（2026-10-28 验收后续七）：**类型契约：python 拒的，-Serve 全都收** —— v1.79/1.80 只对账了"键名在不在"，值的类型全靠 PS 强转：`{"limit":"5"}` 收下当 5 用、`{"excludeArchived":"false"}` 被 `[bool]` 读成 `$True`（客户端的"别排除归档"变成"排除归档"）、`{"keyword":5}` 拿 5 当关键词真发了一轮检索。mcps.py 对这三例自 v1.46.7 起就抛 ValueError（U-202 C 也只测了 python 那一半）—— 同一条纪律在一个入口生效、在另一个入口躺了 34 个版本。实测 13 例里 12 例两层判定相反。现把白名单表从"键名数组"升级成"键名→类型"，分发前第二道闸（`Get-ServeTypeRejection`）按 python 的措辞逐字拒绝；U-295-I 用同一批用例喂两层，判决集与文案都要求**相等**。
# v1.80.0（2026-10-28 验收后续六）：**同一份输入，两层判定相反** —— 请求键白名单 v1.79.0 用的是大小写不敏感的 `-notcontains`，于是 `{"op":"repo","keyword":"x","MinStars":5}` 在 `-Serve` 被放行（PS 属性读取也不敏感 ⇒ 值真被用上：实测 ok:true / count:27 / 11.9s），而 mcps.py 对同一个 `MinStars` 直接判 `unexpected arguments`。现 PS 侧改 `-cnotcontains` 逐字匹配（`op` 仍宽容，协议键没有 python 对端），U-295 加 H3 层：26 个 (op, 变体) 两层必须同判 + 全小写阴性对照 + 退回 `-notcontains` 必红。
# v1.79.0（2026-10-28 验收后续五）：**拼错的请求键不许静默忽略** —— schema 的 `additionalProperties:false` 只被 MCP 层执行，`-Serve` 按分支逐个取 `$req.<key>`、其余键静默丢弃：`{"op":"repo","keyword":"x","minStar":5}`（少一个 s）会按默认 minStars=100 检索并返回 0 条，无任何告警 —— 与 v1.74.0 修掉的「拼错的命令行开关」同类，只是发生在 JSON 协议层。现抽 `Get-ServeKeyPolicy`/`Get-ServeUnknownKeys`（lib/serve.ps1），分发前拒绝并回显 allowed 名单；U-295 加 H 层（与 mcps.py 的 MCP_TOOL_OPS 逐 op 对账 + 真起 -Serve 三行探针 + 三变异）。
# v1.78.0（2026-10-28 验收后续四）：**数值边界写了，两层都不看** —— inputSchema 的 min/max/default 此前既没被 build_tool_request 校验、-Serve 也只夹 limit/maxResults；minStars=-1 / activeWithin=40000 原样穿过。现统一 clamp（抽成纯函数 Get-ServeBoundedInt），U-295-G 两层真跑 + 三方对账。
# v1.77.0（2026-10-28 验收后续三）：参数面的**第四份拷贝** —— 参数速查的 MCP 工具表自称「多一个就 -32602」，却从没有门读过（6 个工具 / 26 个键）；现 U-295-F 把它与 mcps.py 的 MCP_TOOL_OPS 三向对账（工具 / op / 键）+ 四条文档变异。另修 U-136 的扫描面：运行期产物（.gitignore 宣告）不进判据 ⇒ 门不再随活网检索结果变红。
# v1.75–v1.76（2026-10-28 验收后续二/三）：参数面的第三、四份拷贝 —— MCP 包装层（白名单 / inputSchema / 三张类型表 对账 -Serve 的 $req 读取集，U-295-E）与文档里那张"白名单"表（U-295-F）；此前 9d 只比"个数"，改名与对换照绿，现按集合两向点名。
# v1.74.0（2026-10-28 全量验收 F8）：**拼错的开关不许静默忽略** —— 简单 `param()` 块（无 `[CmdletBinding()]`）会把未声明的具名参数丢进 `$args` 后**静默丢弃**：实测 `-CodeSearch`（不存在的开关）与 `-Zzzz` 都 rc=0、无任何报错，本轮验收因此把 repo 模式的结果当成 code 语义结论跑了一轮。现声明 `[CmdletBinding(PositionalBinding = $false)]`，未知具名参数与裸位置参数在**绑定阶段**即失败（PS 5.1 与 7.6.6 双运行时 rc=1，FQID = NamedParameterNotFound / PositionalParameterNotFound），由 U-294 双运行时真跑 + 合成负例 + `Get-Command` 参数真值三层守住。
# v1.73.0（2026-10-28 验收收口）：**副本"多余文件"第一次有观测面** —— 发布链只查「清单 → A」（发全了没），没有任何门查「A → 清单」。于是 `.github/workflows/skill-regression.yml`（`.yml` 从不在发货形态里）能留成两周前的旧版、`说明书.md` 能停在一个月前：不报错、不影响哈希、不进任何报告。现 U-293 真遍历 A，断言「清单外文件 ⊆ 已声明白名单」，白名单四档逐项与发布器三张表对账（各带负例），"遍历到的文件数 ≥ 清单条目数"当执行标记（空目录不许绿）；另给 U-292 标 `gate-profile: installed`，让新判据在安装副本上也真的跑。
# v1.72.0（2026-10-28 全量验收整改 F2/F3）：**判据要能分辨它想分辨的东西** —— ① `test-docs` 的字面转义判据原来全文 Contains，分不清"文档在描述一条正则"（合法）与"换行真被替换成字符"（损伤），v1.70.0 就带着这条误伤发布；现改为围栏/行内代码段内算示例、正文才算工件，并抽成纯函数由新门 U-292 跑真值表 + 3 条可执行变异。② `publish-skill.ps1` 补**根级退役**：`$PUB_EXCLUDE_EXACT` 里登记"有意不随发"的根级文件（`说明书.md`、`stress-frontend-ui.ps1`）在目标侧也会被清掉（U-279 原来只碰受管目录）。
# v1.71.0（2026-10-28 全量验收整改 F1）：**PS 套件也进发布凭证** —— `tests/run-tests.ps1` 落 `.ps-gate.json`，`scripts/publish-skill.ps1` 的 `Test-PsGate` 默认拒绝（缺文件/有红/`-LocalOnly`/版本不符/超龄）；另修 `SKILL.md` 里被 `test-docs` 判红的字面转义（v1.70.0 带着这条红发布）。
# v1.70.0（2026-10-27 结构批 B3-17）：**三道静态门改跑产品** —— 规划器判词（真跑 6 次）、Gitee 相关度地板（2 条夹具臂）、源码优先/文档兜底（CLI 回放）。★三处都是"门在自说自话"：规划器门只 grep 源码词表（词在词表里 ≠ 词生效）、Gitee 门在 JS 里把过滤规则重写了一遍（产品改口径它不跟着变）、发布器 `-StampOnly` 配 `-RegenerateMirror` 会一个戳都不盖却 exit 0（静默空操作，已 fail-closed 拒绝）。
# v1.62–v1.69（B3-9..B3-16）：第四类传输与封套类状态码分档、`"$_"` 是响应正文（PS7）、26 个引擎全部有行为臂 + 元门 U-274-H、主流程首次有行为门（U-182 零产出 / U-115 缺凭据 / U-120 verdict+rc / U-175 AND 注解）、证据外置工具化 + provenance 留 3 份 —— 详见 references/脚本变更历史.md。
# B3-2（v1.54.0，2026-10-26）：模块拆分。本文件只留「入口」：参数 -> 路径解析 -> 加载 lib/ -> 主流程。判据是行为等价而不是「看起来更整齐」：拆分前后 tests/test-u267-replay-golden.test.mjs 的 4 份语料（repo / code / research / package）必须逐字节一致（除已声明的时序字段）。
#
#   模块地图（加载顺序 = 下表顺序；每个模块只定义、无顶层副作用）：
#     lib/config.ps1    配置与数据表（Cfg / 引擎注册表 / 主题词 / 注入白名单 / 全局状态）
#     lib/core.ps1      输出通道、.env 加载、引擎封套、预算、自动模式、结果表
#     lib/net.ps1       选路：探活 / 代理 / hosts / 熔断 / 未证实路由
#     lib/http.ps1      传输：重试退避 / TLS 兜底 / socks+node 回退 / 回放 / 账本 / Invoke-ApiRequest
#     lib/quality.ps1   结果加工：缓存 / 去重 / 评分 / 编码 / 完整度 / 注入防御
#     lib/engines.ps1   引擎编排：Runspace 池 / 注入 / 截止 / 健康记忆 / 并发检索 / 仓库作用域
#     lib/doctor.ps1    -Doctor 与 -ResearchBatch
#     lib/serve.ps1     -Serve 缓存 / 覆盖度 / 请求键白名单
#   逐版历史改动已移至 references/脚本变更历史.md：本文件从 800 行注释瘦到可读体量，不是「删掉历史」，是把它放到该在的地方（G3：脚本头部不承载会过期的读数与叙事）。
#
# U-294（F8，v1.74.0）：未声明的具名参数必须在**绑定阶段**失败 —— 简单 param 块会把它们塞进 `$args` 后静默丢弃（rc=0，try/catch 也抓不到）。
#   故声明 PositionalBinding=$false：裸位置参数也一并拒绝（本条与本仓对 harness 的 U-92 同款，不是运行期守卫 —— advanced script 的 $args 恒空，写守卫是装饰）。
[CmdletBinding(PositionalBinding = $false)]
param(
    [string]$Keyword,
    [string]$Language,
    [int]$MinStars = 100,
    # v1.46.7（2026-10-21，T1-1/T1-2）：**仓库发现的质量过滤**（客户端侧，不改上游查询串 —— 不偷换检索语义）。
    #   ★各源字段能力不同（实测 2026-10-21）：GitHub 有 archived/license/updated；Codeberg 有 archived/updated；
    #     Gitee(so) 有 license/last_push_at；GitLab /projects 列表**三样都不返回**。
    #     缺字段的源**不剔除**该条，并在 warnings 明说"该源未提供 X ⇒ 未过滤" —— 绝不假装过滤生效。
    [ValidateRange(0, 36500)]
    [int]$ActiveWithin = 0,
    [switch]$ExcludeArchived,
    [string]$License = '',
    [int]$Limit = 5,
    [ValidateSet("GitHub", "Gitee", "GitLab", "Codeberg", "All")]
    [string]$Platform = "All",
    [switch]$Download,
    [string]$RepoToDownload,
    [switch]$CodeEvidence,
    [int]$CacheTTLSeconds = 900,
    [switch]$NoCache,
    [switch]$AsJson,
    [switch]$LocalCodeSearch,
    [string]$LocalPath,
    [switch]$UseAstGrep,
    [switch]$UseAria2,
    [switch]$RequireAria2,
    [string]$Refine,
    [switch]$InteractiveSelect,
    [switch]$NoProxyFix,
    # U-156：auto = 实际目标 URL 逐域探活并选 env→system→direct；direct 禁用所有代理；proxy:<url> 强制指定代理。
    [string]$ProxyMode = "auto",
    [switch]$NoEnvFile,
    [switch]$ResearchSources,
    [string]$Site = "stackoverflow",
    [int]$ContextTopK = 0,
    [switch]$Doctor,
    [string]$FocusTerms,
    [double]$NoiseFloor = 0,
    [switch]$ExpandQuery,
    [switch]$Auto,
    # U-242（v1.53.24）：清空跨运行的源健康记忆（source-health.json）后继续本次检索。
    #   用途：刚修好 hosts/代理/余额后，不想等 TTL 到期才恢复全量等待。
    [switch]$ResetHealth,
    # U-65（Wave C，2026-09-26）：通用"响应头观察"——对任意端点做一次 GET（MaxAttempts 1、-NoProxy 可选沿用 Doctor 语义），只打印
    # Deprecation / Sunset / Link(rel=deprecation) / X-RateLimit-* / Retry-After / Date 等治理类头，**不打印请求凭据、不打印响应体**。
    # 用途：N-17 类"某 API 是否已下发废弃头"的复评从人工读头变成一条命令；-AsJson 同样输出。
    [string]$ObserveHeaders = '',
    # U-114: multi-query research input file; JSON array of strings or {"queries":[...]}.
    [string]$ResearchBatch = '',
    # v1.39.0（归并 A 线 v1.38.0）：searchcode **仓库级**代码证据范围。需公开仓库 git URL
    # （如 https://github.com/redis/redis）；配合 -CodeEvidence 使用，串行于并发池之外（1s 级开销），
    # 结果含 commit 精确行链接。缺省 = 不启用该通道（不计入 Requested）。
    [string]$RepoScope,
    # U-192（2026-10-21）：`-RepoScope` 的**作用域语义**（默认行为变更，需知情）。
    #   旧行为：给了 -RepoScope 仍跑**全部**全局代码源，再把 searchcode 仓库级结果追加进来 —— 实测
    #   `-CodeEvidence -RepoScope https://github.com/redis/redis -Keyword expire` 返回 9 条，其中 3 条来自
    #   openclaw/openclaw、3 条来自 SEExcerpts：名字叫"仓库级"，结果不是仓库级。
    #   only（默认）= 只跑能按仓库约束的源（GitHub/GrepApp/Sourcegraph）并按仓库身份**二次过滤**；
    #   add = 旧行为（全局池 + 追加 searchcode），保留给"想同时看库外实现"的场景。
    [ValidateSet('only', 'add')]
    [string]$RepoScopeMode = 'only',
    # U-198（2026-10-21）：代码证据**路径过滤**（grep.app `path` / GitHub `path:`）。未给 ⇒ 请求体与旧版逐字节一致。
    [string]$PathFilter,
    # U-198：grep.app MCP 的匹配语义开关（`matchCase` / `useRegexp`），只在显式给出时下发。
    #   仅 grep.app 支持；其它代码源在 warnings 明说未应用（不假装生效）。
    [switch]$MatchCase,
    [switch]$UseRegexp,
    # v1.46.3：**精确包元数据**（deps.dev，免 key）。写法 `<生态>:<包名>`，逗号分隔可查多个：
    #   -Package "npm:express,pypi:requests"；生态别名 npm/pypi/cargo/go/maven/nuget。
    #   为什么是独立模式：deps.dev **没有关键词检索端点**（/v3alpha/search 实测 404），
    #   与 -Keyword 的检索语义不同 —— 强行塞进 -ResearchSources 会造出"按定义必然 0 命中"的源。
    #   输出：results[] 每条一个包（Name=生态/包名、License、Updated、Desc=默认版本/版本数/公告数），
    #   公告不落单独字段而是进 warnings[]（同一包多次查询不会因字段膨胀而改 schema）。
    [string]$Package = '',
    # P1（2026-10-19）：**常驻服务模式**。启动后只 parse 一次脚本，随后逐行读 JSON 请求、逐行写 JSON 响应，
    #   把每次调用约 6s 的冷启动（pwsh 1.9s + parse 3.0s + python 1.2s）降到 ~50ms（实测 16×）。
    #   协议（**内部行协议，不是 MCP**）：`{"op":"ping"}` / `{"op":"repo"|"code"|"research","keyword":"...","limit":5,...}`；
    #   `__EXIT__` 退出。MCP JSON-RPC 封装在 mcps.py 侧（v1.44.0：`python mcps.py --mcp`，两层解耦：
    #   这里只管性能（只 parse 一次），那里只管协议（帧/工具/参数白名单/错误码）。
    [switch]$Serve
)

# P1（2026-10-19）：**-Serve 必须在任何输出之前静音并转 UTF-8**。
#   实测教训：首版把 $AsJson=$true 放在 serve 循环里（L4116），而 L375 的「已加载 GitHub 令牌」提示
#   走的是 if (-not $AsJson) 分支 ⇒ 它先打印了一行 GBK 中文到 stdout ⇒ 协议流首行不是 JSON，调用方直接 parse 失败。
#   全脚本 Write-Host 计数为 0（全部经 Write-ColorOutput），故提前置 $AsJson 即可彻底静音。
if ($Serve) { $AsJson = $true; try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { } try { [Console]::InputEncoding = [System.Text.Encoding]::UTF8 } catch { } }

# M2（v1.14.0）：ErrorActionPreference=Continue 为有意权衡——容错优先（单源失败自动跳过、不阻断整体），
# 依赖各函数内 try/catch 显式处理；避免全局 Stop 使单个 API 异常中断整个检索。
$ErrorActionPreference = "Continue"
# 4.6 健壮性：$ScriptDir 在本宿主可能为空，做多候选 + 保底硬赋值，避免 $CacheFile 收到 null 静默失败
# M1（v1.14.0）：移除硬编码绝对路径兜底（跨机器失效），改为可选 env:MCPS_HOME；其余候选均为宿主自省路径。
$ScriptDir = $null
$candidates = @()
try { if ($MyInvocation.MyCommand.Definition) { $candidates += (Split-Path -Parent $MyInvocation.MyCommand.Definition -ErrorAction SilentlyContinue) } } catch { }
try { if ($PSScriptRoot) { $candidates += $PSScriptRoot } } catch { }
try { if ($PSCommandPath) { $candidates += (Split-Path -Parent $PSCommandPath -ErrorAction SilentlyContinue) } } catch { }
if ($env:MCPS_HOME) { $candidates += $env:MCPS_HOME }
try { if ($PWD) { $candidates += $PWD.Path } } catch { }
foreach ($c in $candidates) {
    if ($c -and (Test-Path -LiteralPath $c -PathType Container)) { $ScriptDir = $c; break }
}
if (-not $ScriptDir) { $ScriptDir = '.' }   # 终极兜底，确保 Join-Path 永不收到 null
$CacheFile = Join-Path $ScriptDir "search_cache.json"
# U-166（2026-10-04）：缓存文件路径**可被 MCPS_CACHE_FILE 覆盖**（向后兼容：未设 = 上面那行原样）。
#   为什么加这个：`-NoCache` 的语义是「跳过读、照写」（刷新语义）⇒ **任何**跑完主流程的门都会写真仓缓存，
#   而某道门断言「真仓缓存未被碰」⇒ 只要有别的门并发跑就必然假红（U-162 门间竞态）。
#   覆盖路径后，「测试期间不写真仓」由**门运行器统一保证**，而不是"每个门自己记得"——新增门自动受保护。
#   ★写成**追加的一条顶层语句**（而不是把上面那行包进 if/else）：U-53 门按"顶层单条赋值"识别变量定义，
#     包进条件里会让 CacheFile 变成"认不出的注入变量"。
if ($env:MCPS_CACHE_FILE) { $CacheFile = $env:MCPS_CACHE_FILE }

# v1.38.0（U-100 C-1，2026-09-28）：引擎实现外置为 engines/*.ps1。
#   为什么最稳：注入链读 (Get-Item "function:X").Definition ⇒ 函数在池运行前已定义即可，其余零改动；
#   dot-source 只做定义、无顶层副作用；路径用已解析的 $ScriptDir（不依赖裸 $PSScriptRoot —— N-42 形态依赖）。
$EngineDir = Join-Path $ScriptDir 'engines'
if (Test-Path -LiteralPath $EngineDir -PathType Container) {
    Get-ChildItem -LiteralPath $EngineDir -Filter '*.ps1' -File | Sort-Object Name | ForEach-Object { . $_.FullName }
}

# ---------- B3-2（v1.54.0）：模块加载 ----------
#   顺序即依赖顺序（config 的数据先于一切；其余只定义函数，顺序无关但固定下来便于阅读）。
#   缺文件不静默：后续「未识别为 cmdlet」会立刻暴露（不做「少一个模块也照跑」的容错）。
$LibDir = Join-Path $ScriptDir 'lib'
foreach ($__m in @('config', 'core', 'net', 'http', 'quality', 'engines', 'doctor', 'serve')) {
    $__p = Join-Path $LibDir ($__m + '.ps1')
    if (Test-Path -LiteralPath $__p -PathType Leaf) { . $__p }
}

$VERSION = "1.81.0"

if (-not $NoEnvFile) {
    # v1.45.8：cwd 的 .env 只收令牌键；配置类（MCPS_* / NO_PROXY）只认技能目录那份。
    #   两个路径相同时（就在技能目录里运行）只读一次，按"技能目录"口径 —— 否则会把自己的配置误报成被忽略。
    $envNorm = { param($x) ("$x").TrimEnd('\', '/') }
    $sameEnvDir = ((& $envNorm $PWD.Path) -eq (& $envNorm $ScriptDir))
    $envIgnored = @()
    if ($sameEnvDir) {
        $envIgnored += @(Load-EnvFile -Path (Join-Path $ScriptDir '.env') -FromSkillDir)
    } else {
        $cwdIgnored = @(Load-EnvFile -Path (Join-Path $PWD.Path '.env'))
        $envIgnored += @(Load-EnvFile -Path (Join-Path $ScriptDir '.env') -FromSkillDir)
        # cwd 被拒、但技能目录随后设上了的同名键，实际上没被忽略 ⇒ 不报
        foreach ($k in $cwdIgnored) {
            if (-not [Environment]::GetEnvironmentVariable($k)) { $envIgnored += $k }
        }
    }
    $script:EnvIgnoredKeys = @($envIgnored | Where-Object { $_ } | Select-Object -Unique)
    if ($script:EnvIgnoredKeys.Count -and -not $AsJson) {
        Write-ColorOutput ("  [env] 已忽略 .env 中非白名单键（cwd 仅接受令牌键；其余只认技能目录）: {0}" -f ($script:EnvIgnoredKeys -join ', ')) 'Yellow'
    }
    # v1.45.9：`.env` 在但读不到 —— 与"没配置"必须区分开（Doctor 的 envFile 字段同源）。
    if (@($script:EnvLoadErrors).Count -and -not $AsJson) {
        foreach ($envErr in @($script:EnvLoadErrors)) {
            Write-ColorOutput ("  [env] .env 存在但不可读（权限/占用？）：{0} — {1}" -f $envErr.Path, $envErr.Error) 'Yellow'
        }
    }
    if (-not $AsJson) {
        if ($env:GITHUB_TOKEN) { Write-ColorOutput "已加载 GitHub 令牌：远程检索限速提升至 $($script:Cfg.GhSearchRateAuthPerMin)/min（未认证为 $($script:Cfg.GhSearchRateAnonPerMin)/min）" "Green" }
        elseif ($env:GITEE_TOKEN -or $env:GITLAB_TOKEN) { Write-ColorOutput "已加载 Gitee/GitLab 令牌" "Green" }
    }
}
# v1.30.1：Sourcegraph 令牌别名兼容——官方变量为 SRC_TOKEN，兼容常见 SOURCEGRAPH_TOKEN 写法
# （Get-ApiHeaders/搜索引擎统一读 $env:SRC_TOKEN；两者都设时 SRC_TOKEN 优先）
if ($env:SOURCEGRAPH_TOKEN -and -not $env:SRC_TOKEN) { $env:SRC_TOKEN = $env:SOURCEGRAPH_TOKEN }
# U-156：2026-09-19 仅某台机器的本地证书接管可直连、系统 SOCKS5 失效；
# 那次机器特例不足以证明所有 localhost 代理都死。默认保留系统代理，按真实目标 URL 对
# 环境代理→系统代理→直连短探活选路，不再全局修改 WebRequest.DefaultWebProxy。
# MCPS_SYSTEM_PROXY=bypass 只排除 auto 模式的系统代理候选，不改 DefaultWebProxy；keep 为兼容旧开关。
$script:_sysProxyMode = 'keep'
if ($env:MCPS_SYSTEM_PROXY -and $env:MCPS_SYSTEM_PROXY.Trim().ToLower() -in @('bypass', '0', 'off', 'false')) {
    $script:_sysProxyMode = 'bypass'
}
$script:_proxyBypassed = $false
if ($ProxyMode -ne 'auto' -and $ProxyMode -ne 'direct' -and $ProxyMode -notmatch '^proxy:https?://[^\s]+$' -and $ProxyMode -notmatch '^proxy:socks5h?://[^\s]+$') {
    throw 'ProxyMode 仅支持 auto、direct 或 proxy:<http(s)/socks5(h) URL>（地址不回显）'
}

# 4.2 进程级令牌桶：GitHub Search 严格限流（未认证 10/min，认证 30/min），避免突发 429 雪崩
$script:_rateLimitedCount = 0
# H4 全局重试预算（v1.14.0）：跨请求/跨 Runspace 共享的 429/5xx 重试总次数上限，
# 防止研究模式 6 源等批量场景最坏情况（每请求 3 次重试 × 退避）长尾累积到分钟级；预算耗尽即放弃重试。
$script:_retryBudget = $script:Cfg.RetryBudget
# U-160 L4：客户端速率 = 观测限值 × (1 − headroom)。每个桶**各自独立**（不同键、各自 Tokens/Last，无共享单计数器）。
$rlHeadroom = 1.0 - [double]$script:Cfg.RateLimitHeadroomRatio
$ghSearchRate = ($script:Cfg.GhSearchRateAnonPerMin / 60.0) * $rlHeadroom
if ($env:GITHUB_TOKEN) { $ghSearchRate = ($script:Cfg.GhSearchRateAuthPerMin / 60.0) * $rlHeadroom }
$script:_rlLock = [System.Object]::new()
$script:_rlBuckets = @{
    "github-search" = @{ Capacity = 1.0; RefillPerSec = $ghSearchRate; Tokens = 1.0; Last = $null }
    "github-code"   = @{ Capacity = 1.0; RefillPerSec = (($script:Cfg.GhCodeSearchRatePerMin / 60.0) * $rlHeadroom); Tokens = 1.0; Last = $null }   # U-43：code search 单列（观测 10/min）⇒ 客户端 8/min（L4 headroom）
}
# R1 可观测性：分平台成功率（编排层包裹成功/失败），进程级共享统计见 Invoke-ApiRequest
$script:_perPlatformSuccess = @{}
# B2-5（U-260）：逐池 execution 事实（`Invoke-EnginePool` 内 append，payload 组装时读取）。
#   为什么用脚本级 List 而不是返回值：返回值是**结果集**，契约已定；预算/墙钟/早停是元数据，
#   混进结果集就得再拆一次（B2-1 刚拆过封套）。每轮清空，避免 `-Serve` 长驻跨请求累加。
$script:_poolStats = [System.Collections.Generic.List[object]]::new()
# B2-6（U-261）：账本的**当前引擎/模式**归属。每 runspace 各一份（池内由包装块写，串行路径由
#   Invoke-EngineSerial 写并还原）。空串 = 不在任何引擎上下文里（探针/合并期直连），不猜。
$script:_ledgerEngine = ''
$script:_ledgerMode = ''
$script:_ledgerOpen = $null
# v1.21.0 P0-1 可观测化：引擎级结构化状态表（谁 failed / 为什么），修正"静默失效"误导。
# 状态取值为 ok | empty | auth_missing | tool_missing | rate_limited | error | network_unavailable；
# 与 _perPlatformSuccess 的布尔差异：empty=检索成功但 0 命中(可信)，auth_missing/tool_missing=检索根本没执行(不可信)。
# 因引擎在 Runspace 池内执行（脚本级作用域不共享），经 ConcurrentDictionary 跨 Runspace 记录。
$script:_engineStatus = [System.Collections.Concurrent.ConcurrentDictionary[string,string]]::new()
$script:_engineStatusReason = [System.Collections.Concurrent.ConcurrentDictionary[string,string]]::new()
# B2-1（U-258）：engine/1 封套的判定结果（host 侧派生，不注入 runspace）。
#   存在的理由：迁移引擎的 reasonCode 由这里直取，**不再**走 L7863 那套文案正则 —— 文案是给人看的，不该决定机器判定。
$script:_engineVerdict = [System.Collections.Concurrent.ConcurrentDictionary[string,object]]::new()
# U-155：共享到并发/嵌套 Runspace 的逐域选路缓存、确定不可达与已见 HTTP 响应（后者防止部分成功被误报为全跳过）。
$script:_networkRoutes = [System.Collections.Concurrent.ConcurrentDictionary[string,object]]::new()
$script:_networkFailures = [System.Collections.Concurrent.ConcurrentDictionary[string,string]]::new()
$script:_networkHttpResponses = [System.Collections.Concurrent.ConcurrentDictionary[string,bool]]::new()
# v1.51.0：确定性失败死主机登记（进程内熔断的最小形态）—— 同进程同主机只失败一次，后续零等待跳过。
$script:_networkDeadHosts = [System.Collections.Concurrent.ConcurrentDictionary[string,string]]::new()
# v1.53.7：代理网关 5xx 熔断表（host → 记录）。**与 _networkDeadHosts 分开存**：后者是「确定性失败、本进程
#   永久跳过」，这里带 TTL（60s 后值得再试一次）—— 语义不同，混存会让"到期重试"变成"永久跳过"。
$script:_proxyBreaker = [System.Collections.Concurrent.ConcurrentDictionary[string,object]]::new()
# U-206（2026-10-21）：逐域**选路证据**（哪个候选、探活结论、候选是否被白名单排除）。
#   为什么必须有：实网故障里 `unknown`（探活超时）被选中后，真实请求再超时，最终只剩一句
#   「单引擎超 10s 截止」—— 用户无从知道是代理死了、直连被封，还是 hosts 把域名指向了 127.0.0.1。
$script:_routeTrace = [System.Collections.Concurrent.ConcurrentDictionary[string,object]]::new()
$script:_networkEngine = $null # H2/U-53：主池/顶层显式声明；GitLabBlobs 嵌套池按引擎名覆盖此注入值。

# U-242：-ResetHealth 是**动作**不是配置 —— 放在这里（首次用到记忆之前）执行一次。
if ($ResetHealth) {
    Reset-HealthStore
    Write-ColorOutput '源健康记忆已清空（source-health.json）：本轮所有源按健康处理' 'DarkGray'
}

# ---------- 主流程（dot-source 时跳过，便于单元测试） ----------
# 可靠的 dot-source 探测：直接执行时 InvocationName 为脚本名/'.\' 且 Line 为调用命令行；
# dot-source 时 InvocationName 偶尔不可靠（PowerShell 5.1 会返回非 '.'），但 Line 恒为 $null，
# 故两者同时成立才执行主流程（避免单元测试 dot-source 时误触发 exit 0）。
# v1.22.0 增强：$env:MCPS_NO_MAIN=1 时显式跳过主流程（单元测试/子进程 dot-source 的可靠开关——PS5.1 -File 子进程下 Line 为空串被误判）。
if (-not $env:MCPS_NO_MAIN -and ($MyInvocation.InvocationName -ne '.') -and ($MyInvocation.Line -ne $null)) {
$sw = [System.Diagnostics.Stopwatch]::StartNew()
# U-130（2026-09-28）：-AsJson 时把本进程 stdout 钉为 UTF-8（无 BOM）。Windows 控制台默认代码页非 UTF-8 时，管道消费方（MCP 宿主 / Node spawn）
#   会把中日文条目与中文 warnings 折成 '?'（R69 三段定位：产出正确、捕获段失真）。只改本进程、只在 AsJson 生效；无控制台句柄的宿主吞异常。
if ($AsJson) { try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { } }
# U-114: run nine independent research queries concurrently IN THIS PROCESS; delegate each to the
# ordinary -ResearchSources -AsJson path in an outer runspace, never launch a new pwsh per query.
if ($ResearchBatch) {
    if ($Keyword -or $Auto -or $Doctor -or $ObserveHeaders -or $Download -or $LocalCodeSearch -or $CodeEvidence) {
        throw 'U-114: -ResearchBatch cannot be combined with a separate search/Doctor/download mode.'
    }
    Invoke-ResearchBatch -InputPath $ResearchBatch -MainPath (Join-Path $ScriptDir 'multi-platform-searcher.ps1') `
        -TaskLimit $Limit -TaskSite $Site -TaskNoEnvFile:$NoEnvFile -TaskNoCache:$NoCache -TaskNoProxyFix:$NoProxyFix -TaskProxyMode $ProxyMode -AsJson:$AsJson
    return
}
# ★ v1.39.0 新增（归并 A 线 v1.41.0 修复批 / E6·E8）：**参数值域校验**（与 U-142 同区：任何非法调用必须在
#   网络/环境初始化之前失败）。语义：值域错误一律早失败（-Limit 正整数；-MinStars/-ContextTopK 非负；
#   -ContextTopK 的 0 是合法哨兵=跟随 Limit）。为什么不是"宽容处理"：A 线实测 -Limit 0 曾被当"不限"
#   返回 79 条、-MinStars -5 曾被当 0 —— 把调用方笔误包装成"看起来成功"的结果，违反 R-1（不静默）。
#   -Doctor 豁免（对齐 A 线：自检模式不消费这些参数）。失败形态：AsJson ⇒ stdout 可解析信封
#   （error=invalid-parameter-value）+ stderr throw（nonzero）；非 AsJson ⇒ 红字 + throw。
#   ★用 throw 而非 exit：沿用 U-142 先例（U-84/D1 exit AST count=4 不变量不允许随手加 exit）。
$paramErrors = @()
if ($Limit -le 0)       { $paramErrors += ("-Limit 必须为正整数（收到 {0}）" -f $Limit) }
if ($MinStars -lt 0)    { $paramErrors += ("-MinStars 不能为负（收到 {0}）" -f $MinStars) }
if ($ContextTopK -lt 0) { $paramErrors += ("-ContextTopK 不能为负（收到 {0}）" -f $ContextTopK) }
# v1.46.3：`-Package` 的规格在**触网之前**校验 —— 写成 `npm:express` 之外的形式必然是笔误，
#   让它带着 0 条结果"看起来成功"比早失败更糟（同 -Limit 0 的教训）。
if (-not [string]::IsNullOrWhiteSpace($Package)) {
    $pkgSpecs = @($Package -split '[,;]' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    if ($pkgSpecs.Count -eq 0) { $paramErrors += '-Package 为空（示例：npm:express）' }
    if ($pkgSpecs.Count -gt [int]$script:Cfg.DepsDevMaxSpecs) {
        $paramErrors += ("-Package 一次最多 {0} 个（收到 {1}）—— 每个包两次请求，再多请分次" -f [int]$script:Cfg.DepsDevMaxSpecs, $pkgSpecs.Count)
    }
    $knownSys = @($script:Cfg.DepsDevSystems.Keys | Sort-Object)
    foreach ($specItem in $pkgSpecs) {
        $ci = $specItem.IndexOf(':')
        if ($ci -lt 1 -or $ci -ge ($specItem.Length - 1)) { $paramErrors += ("-Package 规格必须是 <生态>:<包名>（收到 `"{0}`"）" -f $specItem); continue }
        $sn = $specItem.Substring(0, $ci).Trim().ToLowerInvariant()
        if ($knownSys -notcontains $sn) { $paramErrors += ("-Package 不支持的生态 `"{0}`"（支持：{1}）" -f $sn, ($knownSys -join '/')) }
    }
}
if ($paramErrors.Count -gt 0 -and -not $Doctor) {
    $pmsg = ($paramErrors -join '；')
    if ($AsJson) {
        [PSCustomObject]@{
            version  = $VERSION
            error    = 'invalid-parameter-value'
            message  = $pmsg
            usage    = 'multi-platform-searcher.ps1 -Keyword "<关键词>" [-Limit <正整数>] [-MinStars <非负整数>] -AsJson'
            results  = @()
            warnings = @(("参数值域错误：{0}；**未执行任何检索**" -f $pmsg))
        } | ConvertTo-Json -Depth 5 | Write-Output
    } else {
        Write-ColorOutput ("✗ 参数错误：{0}" -f $pmsg) "Red"
    }
    throw ("参数值域错误: {0}" -f $pmsg)
}

# U-142: invalid machine-readable invocation must fail *before* network/env initialization.
# Doctor, header observation, and explicit download do not require a search keyword.
# v1.46.3：`-Package` 是**精确包查询**，不需要关键词（与 -Doctor 同理），必须排除在守卫之外。
if ($AsJson -and [string]::IsNullOrWhiteSpace($Keyword) -and
    -not $Serve -and -not $Doctor -and -not $ObserveHeaders -and -not ($Download -and $RepoToDownload) -and
    [string]::IsNullOrWhiteSpace($Package)) {
    # P1（2026-10-19）：**-Serve 必须排除在外** —— 它是常驻循环，请求由 stdin 逐行给入，没有 -Keyword 参数。
    #   实测教训：首版漏了这条件 ⇒ serve 模式被这条守卫拦下并 throw，调用方看到的是「缺 Keyword」而不是服务就绪。
    # v1.39.0（归并 A 线 v1.41.0 修复批 / E1 对齐）：保持 throw 语义（U-84/D1 exit AST count=4 不变），
    #   为机器调用方补**可解析错误信封**（stdout）——A 线原诉求即"rc 非零 + 可解析"，本侧已满足前者，此处补齐后者。
    [PSCustomObject]@{
        version  = $VERSION
        error    = 'missing-required-parameter'
        message  = '-Keyword 为空或全空白：本工具需要关键词（-Doctor 模式除外）'
        usage    = 'multi-platform-searcher.ps1 -Keyword "<关键词>" [-CodeEvidence|-ResearchSources|-Auto] -AsJson'
        results  = @()
        warnings = @('-Keyword 为空 => 未执行任何检索；这是参数错误，不是"无结果"')
    } | ConvertTo-Json -Depth 5 | Write-Output
    throw 'U-142: -Keyword is required for -AsJson search mode.'  # nonzero via exception; preserve U-84/D1 exit AST count=4
}
Initialize-Network
$cacheHit = $false
# R1：重置进程级共享统计（确保每次运行指标从零开始；同进程内跨 Runspace 池汇总）
try {
    [System.AppDomain]::CurrentDomain.SetData('mcps_latencies', (New-Object 'System.Collections.Concurrent.ConcurrentBag[double]'))
    # U-256：请求账本同步重置（否则 -Serve 长驻进程里 Requests 会跨请求累加）
    [System.AppDomain]::CurrentDomain.SetData('mcps_reqstats', (New-Object 'System.Collections.Concurrent.ConcurrentBag[string]'))
    [System.AppDomain]::CurrentDomain.SetData('mcps_retries', ([int[]]::new(1)))
    [System.AppDomain]::CurrentDomain.SetData('mcps_ratelimited', ([int[]]::new(1)))
    # H4 全局重试预算：每次运行重置为 $script:_retryBudget（跨请求/跨 Runspace 共享），耗尽后不再重试
    $rb = [int[]]::new(1); $rb[0] = $script:_retryBudget
    [System.AppDomain]::CurrentDomain.SetData('mcps_retry_budget', $rb)
    # B2-1（U-258）：verdict 表必须每轮清空（清空理由见 Reset-EngineVerdicts 头注）。
    Reset-EngineVerdicts
    # B2-5（U-260）：逐池事实每轮清空（同 verdict 的理由：旧池的记录会被当成本轮的）
    try { $script:_poolStats.Clear() } catch { }
    # B2-6（U-261）：账本袋子 + seq 计数器 + runId 每轮重置（漏了它 `行数 == Requests` 必然先红）
    Reset-ApiLedger
} catch { }

if ($Download -and $RepoToDownload) {
    $plat = if ($Platform -ne "All") { $Platform } else { "GitHub" }
    Download-Repo -RepoFullName $RepoToDownload -Platform $plat
    $sw.Stop(); exit 0
}

# v1.21.0 P0-2：-Doctor 环境自检模式——Agent 在跑任何检索前先校准能力边界（缺 rg/token 时不再静默）。
# 输出：工具存在性 / token 设置 / 引擎能力矩阵。任何"缺失"直接决定后续检索链的可用度（配合 P0-1 的状态标注）。
if ($ObserveHeaders) {
    # U-65：与 Doctor 同源的单次探测；凭据只按 Get-ApiHeaders 规则附带（GitHub/GitLab 域自动带 token），但**从不输出**
    $obsHeaders = @{ 'User-Agent' = "multi-code-platform-searcher/$VERSION (observe-headers)"; 'Accept' = 'application/json' }
    try {
        $obsHost = ([uri]$ObserveHeaders).Host
        if ($obsHost -match '(^|\.)github\.com$' -and $env:GITHUB_TOKEN) { $obsHeaders['Authorization'] = "Bearer $($env:GITHUB_TOKEN)" }
        elseif ($obsHost -match '(^|\.)gitlab\.com$' -and $env:GITLAB_TOKEN) { $obsHeaders['PRIVATE-TOKEN'] = $env:GITLAB_TOKEN }
    } catch { }
    $obs = [ordered]@{ url = $ObserveHeaders; http = $null; observedAt = (Get-Date).ToString('s'); proxyMode = $null; headers = [ordered]@{}; error = $null }
    $watch = @('Deprecation', 'Sunset', 'Link', 'X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset', 'X-RateLimit-Used', 'X-RateLimit-Resource', 'Retry-After', 'Date', 'Server', 'X-GitHub-Api-Version', 'X-GitHub-Request-Id', 'RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset', 'Warning')
    try {
        $r = Invoke-ApiRequest -Uri $ObserveHeaders -Headers $obsHeaders -TimeoutSec $script:Cfg.DoctorProbeSec -MaxAttempts 1
        $obs.http = [int]$r.StatusCode
        foreach ($w in $watch) { $v = Get-HeaderValue -Headers $r.Headers -Name $w; if ($null -ne $v -and "$v" -ne '') { $obs.headers[$w] = "$v" } }
    } catch {
        $obs.error = (("$_" -replace '\s+', ' ')); if ($obs.error.Length -gt 200) { $obs.error = $obs.error.Substring(0, 200) }
        if ($_.Exception.Message -match 'HTTP (\d{3})') { $obs.http = [int]$matches[1] }
    }
    $obs.proxyMode = $script:LastRequestProxyMode
    if ($AsJson) { [PSCustomObject]@{ version = $VERSION; mode = 'observe-headers'; observe = [PSCustomObject]$obs } | ConvertTo-Json -Depth 5 }
    else {
        Write-ColorOutput ("`n════════ 响应头观察 (U-65) ════════`n{0}`nHTTP {1}  proxyMode={2}  at {3}" -f $obs.url, $obs.http, $obs.proxyMode, $obs.observedAt) "Cyan"
        if ($obs.error) { Write-ColorOutput ("  error: {0}" -f $obs.error) "DarkYellow" }
        if ($obs.headers.Count -eq 0) { Write-ColorOutput "  （无治理类响应头：Deprecation/Sunset/Link/X-RateLimit-*/Retry-After 均未下发）" "Gray" }
        foreach ($k in $obs.headers.Keys) { Write-ColorOutput ("  {0,-24} {1}" -f $k, $obs.headers[$k]) $(if ($k -in 'Deprecation', 'Sunset') { 'Yellow' } else { 'White' }) }
        Write-ColorOutput "  （凭据不打印；结论须以本次实测为准 —— N-17 纪律）" "Gray"
    }
    exit 0
}

if ($Serve) {
    # P1（2026-10-19）常驻服务：**所有函数与引擎已在此前的 top-level 执行中定义完毕**（引擎 dot-source 在 L152）。
    # 四个必须显式处理的边界：
    #   ① 静音：$AsJson=$true ⇒ Write-ColorOutput 直接 return，否则彩色文案会污染单向协议流；
    #   ② 编码：Windows 控制台默认 GBK ⇒ 中文结果必须显式 UTF-8，否则往返即乱码；
    #   ③ 行协议：响应一律 -Compress（单行），结果内含换行会被 JSON 转义成 \n，不会破帧；
    #   ④ 失败必须回一行 JSON（不得 exit / throw 到 stdout）—— 否则调用方会**永久等一行永不出现的响应**。
    $AsJson = $true
    try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
    try { [Console]::InputEncoding = [System.Text.Encoding]::UTF8 } catch { }
    function Write-ServeLine { param($Obj) [Console]::Out.WriteLine(($Obj | ConvertTo-Json -Depth 6 -Compress)); [Console]::Out.Flush() }
    # P1（2026-10-19，MCP 封装配套）：常驻进程会**跨请求累积**引擎状态/告警，而每次 CLI 调用都是从零开始。
    #   不重置 ⇒ 第 N 次请求的 coverage 会带上前 N-1 次的残留（典型：上次的 rate_limited 这次还在）。
    #   ConcurrentQueue 在 .NET Framework（PS 5.1）没有 Clear() ⇒ 只能用 TryDequeue 排空。
    function Reset-ServeState {
        foreach ($d in @($script:_engineStatus, $script:_engineStatusReason, $script:_engineTimings)) { try { $d.Clear() } catch { } }
        $tmp = $null
        try { while ($script:_engineWarnings.TryDequeue([ref]$tmp)) { } } catch { }
    }
    # 结果整形与 CLI 同一口径：丢非数据对象 → 去重 → 统一相关性打分（-FocusTerms 常驻模式不暴露）。
    #   ★Merge-DedupResults / Set-UnifiedScore 用 `Write-Output -NoEnumerate` 返回（PS 5.1 序列化坑的既有写法）
    #   ⇒ 直接 `@(...)` 只会得到"一个数组元素"，JSON 里就是 `results=[[...]]`（实测踩到）。这里用管道展开还原。
    function Get-ServeRankedResults {
        param($Results, [string]$Keyword)
        $r = @($Results | Where-Object { $_ -and ($_.PSObject.Properties.Name -contains 'Name') })
        $r = @(Merge-DedupResults -Results $r | ForEach-Object { $_ })
        $scored = Set-UnifiedScore -Results $r -Keyword $Keyword -FocusTerms ''
        return @($scored | ForEach-Object { $_ })
    }
    while ($true) {
        $line = [Console]::In.ReadLine()
        if ($null -eq $line -or $line -eq '__EXIT__') { break }
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        try {
            $req = $line | ConvertFrom-Json
            $op = [string]$req.op
            # v1.79.0 键名白名单（拼错 minStars 曾按默认 100 检索、0 条无告警）+ v1.81.0 值的类型（`"limit":"5"`、`"excludeArchived":"false"` 曾被 PS 强转收下）—— 两道闸都在**分发前**拒，并回显 allowed 名单。
            $rej = Get-ServeRequestRejection -Req $req -Op $op -Ms $sw.ElapsedMilliseconds; if ($null -ne $rej) { Write-ServeLine $rej; continue }
            $kw = [string]$req.keyword
            # limit = **每源页大小**（与 CLI 的 -Limit 同义）；maxResults = 返回条数上限（0=不截断）。
            #   ★别合并：-Limit 从不是"最终条数"（聚合型会超出）；混用会被误读成"只该有 5 条"。v1.78.0 起四个数值参数统一走 Get-ServeBoundedInt（边界 = schema 的 min/max；U-295-G 三方对账）。
            $lim = Get-ServeBoundedInt -Value $req.limit -Min 1 -Max 50 -Default 5
            $max = Get-ServeBoundedInt -Value $req.maxResults -Min 0 -Default 0
            switch ($op) {
                'ping' { Write-ServeLine ([PSCustomObject]@{ ok = $true; op = 'ping'; version = $VERSION; pid = $PID; ms = $sw.ElapsedMilliseconds }) }
                'auto' {
                    # v1.46.8（T1-4）：一次调用 = planner 分类 + 对应模式并集（等价 CLI `-Auto`）。
                    #   Serve 侧此前够不到 planner ⇒ Agent 只能自己猜该调 repo / code / research，猜错就是整轮空跑。
                    #   ★关键词分工与 CLI 一致：repo/code 用 Get-AutoSearchKeyword（抽技术词/剥元词），research 用**原句**。
                    if ([string]::IsNullOrWhiteSpace($kw)) { Write-ServeLine ([PSCustomObject]@{ ok = $false; op = 'auto'; error = 'keyword is required'; ms = $sw.ElapsedMilliseconds }); break }
                    $lang = [string]$req.language
                    $minStars = Get-ServeBoundedInt -Value $req.minStars -Min 0 -Default 100
                    $site = if ($req.site) { [string]$req.site } else { 'stackoverflow' }
                    # v1.49.0：coverage 需要"本次可能参与的引擎"——在缓存**外**先算 plan（纯分类，<100ms）。
                    #   否则缓存命中时拿不到 modes，Requested 会误算成全量 ⇒ 未跑的池被判 not-run ⇒ 假 degraded。
                    $plan0 = Get-AutoPlan -Keyword $kw
                    $autoNames = @()
                    if (@($plan0.Modes) -contains 'repo') { $autoNames += @(Get-EnabledEngines -Engines (Get-EngineByKind -Kind 'repo') | ForEach-Object { [string]$_.Name }) }
                    if (@($plan0.Modes) -contains 'code') { $autoNames += @(Get-EnabledEngines -Engines (Get-EngineByKind -Kind 'code') | ForEach-Object { [string]$_.Name }) }
                    if (@($plan0.Modes) -contains 'research') { $autoNames += @(Get-EnabledEngines -Engines @(Get-EngineByKind -Kind 'research' | Where-Object { Test-ResearchEngineAvailable $_ }) | ForEach-Object { [string]$_.Name }) }
                    Reset-ServeState
                    $ck = Get-ServeCacheKey -Op 'auto' -Keyword $kw -Limit $lim -Platforms '' -Language $lang -MinStars $minStars -Site $site
                    $sc = Invoke-ServeCached -Key $ck -Factory {
                        $p = Get-AutoPlan -Keyword $kw
                        $ak = Get-AutoSearchKeyword -Keyword $kw
                        $bag = [ordered]@{ modes = @($p.Modes); queryType = [string]$p.QueryType; confidence = $p.Confidence; planSource = [string]$p.Source; autoKeyword = $ak; repo = @(); code = @(); research = @() }
                        if ($p.Modes -contains 'repo') {
                            $names = @(Get-EnabledEngines -Engines @(Get-EngineByKind -Kind 'repo') | ForEach-Object { [string]$_.Name })
                            if ($names.Count -gt 0) { $bag.repo = @(Invoke-ConcurrentPlatformSearch -Platforms $names -Keyword $ak -Language $lang -MinStars $minStars -Limit $lim) }
                        }
                        if ($p.Modes -contains 'code') { $bag.code = @(Invoke-ConcurrentCodeSearch -Keyword $ak -Limit $lim -Language $lang) }
                        if ($p.Modes -contains 'research') { $bag.research = @(Invoke-ConcurrentResearchSearch -Keyword $kw -Limit $lim -Site $site) }
                        [PSCustomObject]$bag
                    }
                    $bag = @($sc.Data)[0]
                    if ($null -eq $bag) { Write-ServeLine ([PSCustomObject]@{ ok = $false; op = 'auto'; error = 'planner produced no plan'; ms = $sw.ElapsedMilliseconds }); break }
                    $merged = @(@($bag.repo) + @($bag.code) + @($bag.research))
                    $res = @(Get-ServeRankedResults -Results $merged -Keyword $kw)
                    if ($max -gt 0) { $res = @($res | Select-Object -First $max) }
                    Write-ServeLine ([PSCustomObject]@{ ok = $true; op = 'auto'; count = $res.Count; modes = @($bag.modes); queryType = $bag.queryType; planSource = $bag.planSource; autoKeyword = $bag.autoKeyword; counts = [PSCustomObject]@{ repo = @($bag.repo).Count; code = @($bag.code).Count; research = @($bag.research).Count }; coverage = (Get-ServeCoverage -Requested $autoNames); cached = $sc.Cached; ms = $sw.ElapsedMilliseconds; reasons = (Get-ServeReasons); results = $res })
                }
                'research' {
                    if ([string]::IsNullOrWhiteSpace($kw)) { Write-ServeLine ([PSCustomObject]@{ ok = $false; op = 'research'; error = 'keyword is required'; ms = $sw.ElapsedMilliseconds }); break }
                    $site = if ($req.site) { [string]$req.site } else { 'stackoverflow' }
                    # v1.49.0：coverage.Requested = 本次真正参与的研究源（禁用与未配置的都不进，与 CLI 同口径）
                    $researchNames = @(Get-EnabledEngines -Engines @(Get-EngineByKind -Kind 'research' | Where-Object { Test-ResearchEngineAvailable $_ }) | ForEach-Object { [string]$_.Name })
                    Reset-ServeState
                    $ck = Get-ServeCacheKey -Op 'research' -Keyword $kw -Limit $lim -Platforms '' -Language '' -MinStars -1 -Site $site
                    $sc = Invoke-ServeCached -Key $ck -Factory { @(Invoke-ConcurrentResearchSearch -Keyword $kw -Limit $lim -Site $site) }
                    $res = @(Get-ServeRankedResults -Results $sc.Data -Keyword $kw)
                    if ($max -gt 0) { $res = @($res | Select-Object -First $max) }
                    Write-ServeLine ([PSCustomObject]@{ ok = $true; op = 'research'; count = $res.Count; site = $site; coverage = (Get-ServeCoverage -Requested $researchNames); cached = $sc.Cached; ms = $sw.ElapsedMilliseconds; reasons = (Get-ServeReasons); results = $res })
                }
                'repo' {
                    if ([string]::IsNullOrWhiteSpace($kw)) { Write-ServeLine ([PSCustomObject]@{ ok = $false; op = 'repo'; error = 'keyword is required'; ms = $sw.ElapsedMilliseconds }); break }
                    # 平台名以注册表为准（未知名字必须报错，不能静默返回 0 条 —— 那是"假零命中"）。
                    # v1.48.2（全模块验收 P1）：**MCPS_DISABLE 必须在 Serve 侧也生效**。
                    #   病灶：CLI 主流程在派生 platformsToSearch 时统一过滤（`Invoke-ConcurrentPlatformSearch`
                    #   注释明说"本函数按传入名单取引擎"），而 Serve 的 repo op 直接把注册表全量名单传进去
                    #   ⇒ 实测 `MCPS_DISABLE=GitHub,Gitee,GitLab,Codeberg` 下 `search_repositories` 仍返回 5 条、
                    #   `reasons.GitHub=error`（真的发了请求）。禁用在这里是**合规/配额**开关，不能只在 CLI 生效。
                    $repoEngines = @($script:_engineRegistry | Where-Object { $_.Kind -eq 'repo' })
                    $known = @($repoEngines | ForEach-Object { [string]$_.Name })
                    $enabled = @($repoEngines | Where-Object { -not (Test-EngineDisabled -Engine $_) } | ForEach-Object { [string]$_.Name })
                    # ★未指定 platforms 时按**用户意图=全部**取 $known，再减去被禁项 —— 否则 disabledNames 永远为空，
                    #   reasons 里就没有"这些源为什么没跑"的证据（实测第一版这么写，count=0 但 reasons 空）。
                    $plat = if ($req.platforms) { @([string]$req.platforms -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ }) } else { $known }
                    $bad = @($plat | Where-Object { $known -notcontains $_ })
                    if ($bad.Count -gt 0) { Write-ServeLine ([PSCustomObject]@{ ok = $false; op = 'repo'; error = ("unknown platforms: " + ($bad -join ',')); allowed = $enabled; ms = $sw.ElapsedMilliseconds }); break }
                    $disabledNames = @($plat | Where-Object { $enabled -notcontains $_ })
                    $plat = @($plat | Where-Object { $enabled -contains $_ })
                    $lang = [string]$req.language
                    $minStars = Get-ServeBoundedInt -Value $req.minStars -Min 0 -Default 100
                    # v1.46.7（T1-1/T1-2）：质量过滤与 CLI **同一函数、同一套文案**；在截断 maxResults **之前**过滤
                    #   （先取前 N 再过滤会给出比"可用结果"更少的条数，且丢掉的其实没过期/没归档）。
                    $aw = Get-ServeBoundedInt -Value $req.activeWithin -Min 0 -Max 36500 -Default 0
                    $ea = [bool]$req.excludeArchived
                    $licq = [string]$req.license
                    Reset-ServeState
                    $platKey = (@($plat | Sort-Object) -join ',')
                    $ck = Get-ServeCacheKey -Op 'repo' -Keyword $kw -Limit $lim -Platforms $platKey -Language $lang -MinStars $minStars -Site ''
                    $sc = Invoke-ServeCached -Key $ck -Factory { @(Invoke-ConcurrentPlatformSearch -Platforms $plat -Keyword $kw -Language $lang -MinStars $minStars -Limit $lim) }
                    $res = @(Get-ServeRankedResults -Results $sc.Data -Keyword $kw)
                    $fStats = $null; $fNotes = @(); $fKept = @($res).Count
                    if ($aw -gt 0 -or $ea -or -not [string]::IsNullOrWhiteSpace($licq)) {
                        $qf = Select-RepoQualityResults -Results $res -ActiveWithin $aw -ExcludeArchived:$ea -License $licq
                        $res = @($qf.Kept)
                        $fKept = @($res).Count
                        $fStats = $qf.Stats
                        $fNotes = @(Get-RepoQualityNotes -Stats $qf.Stats -ActiveWithin $aw -ExcludeArchived:$ea -License $licq)
                    }
                    if ($max -gt 0) { $res = @($res | Select-Object -First $max) }
                    $fOut = $null
                    if ($null -ne $fStats) {
                        # notApplied 按**字段**分组（只列非空项）：`{"archived":["Gitee"],"updated":[]}` 比一个混在一起的
                        #   `["Gitee"]` 更能说清"哪个过滤器在这个源上不可用"（混着写时调用方只能猜）。
                        $na = [ordered]@{}
                        if ($fStats.ArchivedUnknown.Count -gt 0) { $na['archived'] = @($fStats.ArchivedUnknown.Keys | Sort-Object) }
                        if ($fStats.UpdatedUnknown.Count -gt 0) { $na['updated'] = @($fStats.UpdatedUnknown.Keys | Sort-Object) }
                        if ($fStats.LicenseUnknown.Count -gt 0) { $na['license'] = @($fStats.LicenseUnknown.Keys | Sort-Object) }
                        $fOut = [PSCustomObject]@{
                            input = $fStats.Input; kept = $fKept; archived = $fStats.Archived; stale = $fStats.Stale
                            licenseMismatch = $fStats.LicenseMismatch; licenseMissing = $fStats.LicenseMissing; cutoff = $fStats.Cutoff
                            notApplied = [PSCustomObject]$na
                        }
                    }
                    Write-ServeLine ([PSCustomObject]@{ ok = $true; op = 'repo'; count = $res.Count; platforms = $plat; disabledPlatforms = @($disabledNames); coverage = (Get-ServeCoverage -Requested $plat); cached = $sc.Cached; ms = $sw.ElapsedMilliseconds; filtered = $fOut; filterNotes = @($fNotes); reasons = (Get-ServeReasons -Disabled $disabledNames); results = $res })
                }
                'code' {
                    if ([string]::IsNullOrWhiteSpace($kw)) { Write-ServeLine ([PSCustomObject]@{ ok = $false; op = 'code'; error = 'keyword is required'; ms = $sw.ElapsedMilliseconds }); break }
                    $lang = [string]$req.language
                    # U-201（2026-10-21）：MCP 侧此前够不到 v1.46.5 的仓库作用域（只有 CLI 有 -RepoScope）。
                    #   语义与 CLI 的 only 模式一致：只跑能约束到仓库的源 + searchcode + 按身份二次过滤；
                    #   解析失败**直接报参数错**，不退回全局检索（否则"限定仓库"的承诺是空的）。
                    $repo = [string]$req.repoScope
                    $pathF = [string]$req.pathFilter
                    $scope = Resolve-ServeCodeScope -RepoScope $repo
                    $plan = $scope.Plan
                    if (-not $scope.Valid) {
                        Write-ServeLine ([PSCustomObject]@{ ok = $false; op = 'code'; error = 'repoScope must be a git URL or owner/repo'; ms = $sw.ElapsedMilliseconds }); break
                    }
                    $repoSlug = $scope.Slug
                    # v1.49.0：coverage.Requested = 本次真正参与的 code 源（有 repoScope 时取作用域名单，否则取启用集）
                    $codeNames = if ($repoSlug) { @($plan.Engines | ForEach-Object { [string]$_.Name }) } else { @(Get-EnabledEngines -Engines (Get-EngineByKind -Kind 'code') | ForEach-Object { [string]$_.Name }) }
                    Reset-ServeState
                    $ck = Get-ServeCacheKey -Op 'code' -Keyword $kw -Limit $lim -Platforms '' -Language $lang -MinStars -1 -Site '' -RepoScope $repo -PathFilter $pathF
                    $sc = Invoke-ServeCached -Key $ck -Factory {
                        $r = @()
                        $codeArgs = @{ Keyword = $kw; Limit = $lim; Language = $lang; PathFilter = $pathF }
                        if ($repoSlug) { $codeArgs['Engines'] = @($plan.Engines); $codeArgs['RepoScope'] = $repoSlug }
                        if (-not $repoSlug -or @($plan.Engines).Count -gt 0) { $r = @(Invoke-ConcurrentCodeSearch @codeArgs) }
                        if ($repo) {
                            $r += @(Search-SearchCodeRepo -Keyword $kw -Repository $repo -Limit $lim)
                            if ($plan.Identity) { $r = @((Select-RepoScopedResults -Results $r -Identity $plan.Identity).Kept) }
                        }
                        $r
                    }
                    $res = @(Get-ServeRankedResults -Results $sc.Data -Keyword $kw)
                    if ($max -gt 0) { $res = @($res | Select-Object -First $max) }
                    Write-ServeLine ([PSCustomObject]@{ ok = $true; op = 'code'; count = $res.Count; cached = $sc.Cached; repoScope = $repo; coverage = (Get-ServeCoverage -Requested $codeNames); ms = $sw.ElapsedMilliseconds; reasons = (Get-ServeReasons); results = $res })
                }
                'package' {
                    # U-196（2026-10-21）：MCP 侧此前够不到 v1.46.3 的 -Package（tools/call → unknown tool）。
                    #   语义与 CLI 一致：逗号/分号分隔的 `生态:包名`，不需要 keyword。
                    $pkgs = [string]$req.packages
                    if ([string]::IsNullOrWhiteSpace($pkgs)) { Write-ServeLine ([PSCustomObject]@{ ok = $false; op = 'package'; error = 'packages is required'; ms = $sw.ElapsedMilliseconds }); break }
                    $pkgList = @($pkgs -split '[,;]' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
                    if ($pkgList.Count -lt 1) { Write-ServeLine ([PSCustomObject]@{ ok = $false; op = 'package'; error = 'packages is required'; ms = $sw.ElapsedMilliseconds }); break }
                    if ($pkgList.Count -gt $script:Cfg.DepsDevMaxSpecs) { Write-ServeLine ([PSCustomObject]@{ ok = $false; op = 'package'; error = ('too many packages (max {0})' -f $script:Cfg.DepsDevMaxSpecs); ms = $sw.ElapsedMilliseconds }); break }
                    Reset-ServeState
                    $ck = Get-ServeCacheKey -Op 'package' -Keyword (($pkgList | ForEach-Object { $_.ToLowerInvariant() }) -join ',') -Limit 0 -Platforms '' -Language '' -MinStars -1 -Site ''
                    $sc = Invoke-ServeCached -Key $ck -Factory { $buf = @(); foreach ($p in $pkgList) { $buf += @(Search-DepsDevPackage -PackageSpec $p) }; $buf }
                    $res = @($sc.Data)
                    Write-ServeLine ([PSCustomObject]@{ ok = $true; op = 'package'; count = $res.Count; cached = $sc.Cached; coverage = (Get-ServeCoverage -Requested @('Packages')); ms = $sw.ElapsedMilliseconds; reasons = (Get-ServeReasons); results = $res })
                }
                default { Write-ServeLine ([PSCustomObject]@{ ok = $false; op = $op; error = "unknown op: $op"; ms = $sw.ElapsedMilliseconds }) }
            }
        } catch {
            try { Write-ServeLine ([PSCustomObject]@{ ok = $false; error = (("$_" -replace '\s+', ' ')); ms = $sw.ElapsedMilliseconds }) } catch { }
        }
    }
    exit 0
}

if ($Doctor) { Invoke-DoctorReport -AsJson:$AsJson; exit 0 }

# v1.46.3：`-Package` 不需要关键词 ⇒ 必须排除在本块之外，否则 -AsJson 会静默 exit 0（实测：0 字节 stdout）。
if ((-not $Keyword -or -not $Keyword.Trim()) -and [string]::IsNullOrWhiteSpace($Package)) {
    # v1.39.0（归并 A 线 v1.41.0 修复批 / E1 对齐）：空/全空白统一走"用法/前置报错"路径 ——
    #   -AsJson：上游 U-142 守卫（IsNullOrWhiteSpace，先于网络初始化）已覆盖并 throw（nonzero + 明确错误 + 信封）；
    #   非 AsJson：本块打印用法横幅后 exit 0。本处仅把条件从"空串"扩到"全空白"
    #   （旧条件对 " " 是 truthy ⇒ 会直接带着空格去检索——A 线实测该路径返回全站高星榜且零告警）。
    if (-not $AsJson) {
        $banner = @"
╔═══════════════════════════════════════════════════════════════╗
║     Multi-Code-Platform Searcher v$VERSION
║     仓库发现: GitHub, Gitee, GitLab, Codeberg   |   代码证据: GitHub(第一方), GitLab(/search blobs), grep.app, SEExcerpts(社区实现证据), Sourcegraph(兜底); 可选 -RepoScope 仓库级(searchcode)   |   研究/包: Hugging Face + npm/crates.io/Maven + arXiv + StackExchange
╚═══════════════════════════════════════════════════════════════╝

使用方式:
  .\multi-platform-searcher.ps1 -Keyword "关键词" [-Language 语言] [-MinStars 星数] [-Platform 平台] [-Limit 数量]
  .\multi-platform-searcher.ps1 -CodeEvidence -Keyword "函数名/代码片段"
  .\multi-platform-searcher.ps1 -CodeEvidence -RepoScope "https://github.com/redis/redis" -Keyword "expire"   # v1.39.0 仓库级(searchcode 新 API，含 commit 精确行链接)
  .\multi-platform-searcher.ps1 -LocalCodeSearch -CodeEvidence -Keyword "函数名" -LocalPath ".\repo"   # 本地离线检索(需 rg/ugrep)
  .\multi-platform-searcher.ps1 -LocalCodeSearch -CodeEvidence -UseAstGrep -Keyword '`$A.map(`$B)' -LocalPath ".\repo"  # ast-grep 结构化模式检索(需 ast-grep, 缺失回退 rg)
  .\multi-platform-searcher.ps1 -ResearchSources -Keyword "llama" [-Site superuser]  # 研究信源(匿名): HF + npm/crates.io/Maven + arXiv + Stack Exchange(默认 stackoverflow, -Site 换站)
  .\multi-platform-searcher.ps1 -Package "npm:express,pypi:requests"   # v1.46.3 精确包元数据(deps.dev 免key): 默认版本/许可证/发布时间/安全公告(生态: npm/pypi/cargo/go/maven/nuget)
  .\multi-platform-searcher.ps1 -Auto -Keyword "调研 jwt 开源项目与代码实现" -AsJson   # -Auto: planner 自动分类(integrated 类一次进程三模式)
  .\multi-platform-searcher.ps1 -Platform Codeberg -Keyword "react modal"  # Codeberg(Gitea) 仓库发现
  .\multi-platform-searcher.ps1 -AsJson -Keyword "关键词"        # 机器可读输出
  .\multi-platform-searcher.ps1 -Download -RepoToDownload "owner/repo" -Platform GitHub
  .\multi-platform-searcher.ps1 -Download -RepoToDownload "owner/repo" -RequireAria2    # 强制 aria2 多线程下载
  .\multi-platform-searcher.ps1 -Keyword "关键词" -Refine "子串"        # 对已取回结果做二次检索(内存过滤, 不触网)
  .\multi-platform-searcher.ps1 -Keyword "关键词" -InteractiveSelect    # 可选 fzf 交互筛选(缺失则编号菜单, 非交互自动跳过)

平台选项: GitHub, Gitee, GitLab, Codeberg, All    |    缓存 TTL 默认 900s（-CacheTTLSeconds 调，-NoCache 关）
多平台搜索: 自动并发（原生 Runspace 池）；下载: -UseAria2 自动探测 / -RequireAria2 强制 aria2 / curl 启用 HTTP/2
缓存: 进程内 LRU(内存命中免磁盘IO) + 磁盘 search_cache.json；结果按归一化身份跨平台去重
排序(v1.12.0): 跨信源统一相关性排序——组内热度归一化 Score(0-1) + 关键词命中加成，稳定降序（-AsJson 每条含 Score）
加固(v1.14.0): H2 Runspace 依赖注入 / H3 缓存写合并(进程末一次落盘) / H4 全局重试预算(默认6次, metrics.RetryBudgetLeft) / M1-M6 系列优化
能力(v1.15.0): P1 ast-grep 本地结构化检索(-UseAstGrep, 缺失回退 rg/ugrep) | P3 RAG context 输出(-AsJson 顶层 context, -ContextTopK 调 K)
韧性(v1.16.0): GitHub secondary rate limit(403 变体)识别并退避重试——x-ratelimit-remaining:0/Retry-After/abuse 体特征, 非限流 403 不误重试
包生态(v1.17.0): 研究信源 6→9(+RubyGems/NuGet/DockerHub)——包语言覆盖 JS/Rust/Java → +Ruby/.NET +容器镜像(Go 无 JSON API 实测替代)
论文(v1.18.0): 研究信源 9→10(+OpenAlex 正式论文, cited 作热度) | P2 收口: arXiv 引用数经 Semantic Scholar batch 补全(替换 Stars=0)
并发(v1.19.0): 研究 10 源 Runspace 池并行(注册表+注入规范)——串行 p95 15s+ → 并发; v1.36.4 加单引擎级截止(默认15s)后宿主实测 7.8s(full)/16s(卡源时 degraded+warnings), S2 引用补全串行后置, 失败跳过/降级串行
收尾(v1.20.0): L1 魔法数字集中(`$script:Cfg) / L3 Write-Host 统一 Write-ColorOutput / L4 缓存惰性清理 / ast-grep 0.45.x 实机复测闭环(--json 数组+range 行号兼容)
可观测(v1.21.0): P0-1 代码证据静默失效可观测化——引擎级状态(ok/empty/auth_missing/tool_missing/error) + metrics.PerPlatformOutcome(coverage) + 独立退出码(0正常/2工具缺失/3认证缺失/4降级)；P0-2 -Doctor 环境自检(工具/token/能力矩阵)
降噪(v1.22.0): P1-3 宽概念召回降噪——关键词术语覆盖度计分(每命中词+0.1) + -FocusTerms 核心词惩罚(未命中×0.4) + -NoiseFloor 阈值过滤 + MatchTerms/NoiseFlagged 字段；P1-4 研究信源 0 命中诊断——-ExpandQuery 自动同义/上位词扩写轮次 + research 输出(interpretation/confidence/lowConfidenceNegative/searchRounds/suggestedWiderQueries)
官方端点(v1.23.0): P1-5 grep.app empty 语义校准（v1.38.0 起入口=官方 MCP mcp.grep.app） + Sourcegraph 官方 streaming API(/.api/search/stream SSE, context:global) + -Doctor 远程引擎健康 ping + warnings[] 降级警示契约(任何引擎 fallback/失败进顶层 warnings)
结构(v1.24.0): P2-6 SKILL.md 渐进式披露精简(330→50行) + references/ 参数速查/引擎链/故障排查/变更历史/端到端范例 + evals/ 评测环(8 ground-truth 用例含 r1-r4)；P2-7 与直接调研的三段式协同工作流固化
社区反馈(v1.32.0): 新增 HackerNews 研究信源(Algolia HN API, 匿名 10k/h)——闭环覆盖缺口「用户社区反馈」半边(HN 部分)，points 热度代理 + 0 命中 empty 语义
治理(v1.33.0): MCPS_DISABLE 引擎禁用开关(逗号/分号分隔, 匹配引擎名或显示名, 不进 Requested + warnings[] 可审计) | MCPS_TIME_BUDGET_SEC 总时长预算(默认120s, 超时引擎 Stop 并标 Degraded) | GitLab 项目级回退并行化(嵌套 Runspace 池)+路径缓存(免 N 次冗余 GET) | -Platform All 平台列表改由引擎注册表派生(兑现 H1 单一事实源)
能力(v1.34.0): -Auto 集成模式(内嵌 query-planner 自动分类, integrated→repo+code+research 一次进程三连跑, modeResults 按模式隔离缓存, coverage 取并集) | Stars 增 Unit 语义字段(stars/downloads/week/downloads/month/downloads/citations/votes/points/tools/none, 跨源热度代理不再混淆) | npm 换真实周下载量(api.npmjs.org 批量, 失败诚实降级 popularity 代理) | PyPI 评估后不接入(无官方匿名搜索 JSON API, 沿用 Go 先例记录)
"@
        Write-PayloadOutput $banner -ForegroundColor Cyan
    }
    exit 0
}

$allResults = @()

# v1.47.3（P1-2）：各模式结果条数 + Auto 计划对象 —— 前者与 MCP `search_auto` 的 `counts` 同构，
#   后者供载荷回填 `modes/queryType/planSource`（此前只在控制台打印，`-AsJson` 下整段丢失）。
$modeCountRepo = 0; $modeCountCode = 0; $modeCountResearch = 0
$AutoPlan = $null

# v1.34.0 P2：模式决定——-Auto 优先（planner 自动分类，可多模式三连跑）；显式开关在无 -Auto 时按原语义生效
$runModes = @()
if (-not [string]::IsNullOrWhiteSpace($Package)) {
    # v1.46.3：-Package 独占一个模式 —— 它与"关键词检索"语义不同（精确包 vs 模糊搜）。
    #   与其它模式同时给出时**不静默择一**：只跑 package 并显式告警，避免调用方以为两件事都做了。
    $runModes = @('package')
    if ($Auto -or $ResearchSources -or $CodeEvidence -or $LocalCodeSearch) {
        Add-EngineWarning -Engine 'package' -Message '-Package 与 -Auto/-ResearchSources/-CodeEvidence/-LocalCodeSearch 互斥：本次**只执行**包元数据查询，其余模式未运行'
        Write-ColorOutput '提示: -Package 为独立模式，本次不执行 -Auto/-CodeEvidence/-ResearchSources/-LocalCodeSearch' 'Yellow'
    }
}
elseif ($Auto) {
    $AutoPlan = Get-AutoPlan -Keyword $Keyword   # v1.47.3：计划对象要进载荷，不能只取 Modes
    $runModes = @($AutoPlan.Modes)
}
elseif ($ResearchSources) { $runModes = @('research') }
elseif ($CodeEvidence -or $LocalCodeSearch) { $runModes = @('code') }
else { $runModes = @('repo') }

# v1.47.2（P1-1）：`-LocalCodeSearch` 此前只被 code 分支内部消费 ⇒ 单用时落到 `else @('repo')`，
#   实际发了 4 个远程仓库请求、0 条、零告警（说明书 §4 的官方示例就踩这条）。
#   `-Auto` 走 planner 分支，同样可能不含 code ⇒ 补并集（并把"为什么多跑一个模式"写进 warnings）。
#   ★必须放在 elseif 链**之后**：插在链中间会把末尾的 `else` 抢走（实测：单用开关仍然跑 repo 模式）。
if ($Auto -and $LocalCodeSearch -and $runModes -notcontains 'code') {
    $runModes += 'code'
    Add-EngineWarning -Engine 'query' -Message '-LocalCodeSearch 与 -Auto 同用：planner 未选中 code 模式，已按开关补入（本地检索优先，0 命中才降级远程）'
}

# v1.45.3（2026-10-20 全量验收遗留项）：-Auto 的 repo/code 检索式改写（research 保留原句）。
#   只影响 repo/code 分支的 cacheKey 与引擎入参；打分（Set-UnifiedScore）仍用原句，故 Relevance 口径不变。
$AutoKeyword = if ($Auto) { Get-AutoSearchKeyword -Keyword $Keyword } else { $Keyword }
if ($Auto -and $AutoKeyword -ne $Keyword) {
    # v1.53.16：改写**原因要可审计** —— 是「去打包词」还是「中文主题词映射」，直接决定该不该信这条检索式。
    $zhMapped = if ($Keyword -match '[\u4e00-\u9fff]') { @(Get-ZhTopicExpansion -Keyword $Keyword) } else { @() }
    $rewriteWhy = if ($zhMapped.Count -gt 0) { '中文主题词→英文（{0}）+ 去停用/打包词' -f ($zhMapped -join ' ') } else { '去停用/打包词' }
    Add-EngineWarning -Engine 'query' -Message ('-Auto 检索式改写（仅 repo/code，{0}）："{1}" → "{2}" —— 长句与打包词在仓库/代码源上结构性低命中（U-95 同源）；research 仍用原句' -f $rewriteWhy, $Keyword, $AutoKeyword)
    Write-ColorOutput ('提示: -Auto 将 repo/code 检索式改写为 "{0}"（{1}；原句留给研究源）' -f $AutoKeyword, $rewriteWhy) 'DarkGray'
    # v1.53.15：**检索式只剩语言/工具名**时结果会按星数泛化 —— 实测「调研 rust 生态的异步运行时选型」（v1.53.15）
    #   ⇒ autoKeyword=rust ⇒ repo 返回 hello-algo / veloren 等无关高星项目；v1.53.16 起该例走主题词映射，
    #   但映射表不可能覆盖所有中文主题词，故仍保留本告警：只做**如实告知 + 给可执行改法**，不假装能切中文。
    if ($AutoKeyword -match '^(?i)(rust|go|golang|python|java|typescript|javascript|node|react|vue|docker|kubernetes|k8s)$' -and $Keyword -match '[\u4e00-\u9fff]') {
        Add-EngineWarning -Engine 'query' -Message ('-Auto 检索式只剩语言/工具名 "{0}"：该中文主题词不在内置映射表内，repo 结果会按 star 泛化。要精确请把主题词写成英文短词，如 -Keyword "rust async runtime"' -f $AutoKeyword)
        Write-ColorOutput ('注意: repo 检索式仅 "{0}"（中文主题词不在映射表内）—— 精确检索请直接写英文主题词，如 "rust async runtime"' -f $AutoKeyword) 'Yellow'
    }
}

# T3-8（v1.53.4）：-Auto 的**最坏墙钟**说在前面（只告知，不改预算语义）。
#   必须放在 $runModes 定稿之后（-LocalCodeSearch 补 code 在上一段）——否则池数算少。
if ($Auto) {
    $autoBudgetNotice = Get-AutoBudgetNotice -BudgetSec (Get-TimeBudgetSec) -Modes $runModes -TotalBudgetSec (Get-TotalBudgetSec)
    if ($autoBudgetNotice) { Write-ColorOutput $autoBudgetNotice 'DarkGray' }
}

# U-121（S1）/ U-113（2026-09-28）：查询侧告警 —— 只告警不改行为，全部进 warnings[]（[query] 前缀）可审计。
$kwTerms = @((($Keyword -replace '["“”'']', ' ') -split '\s+') | ForEach-Object { $_.Trim().ToLower() } | Where-Object { $_ })
$lowDiscTerms = @($kwTerms | Where-Object { $script:Cfg.LowDiscriminationTerms -contains $_ } | Select-Object -Unique)
if ($lowDiscTerms.Count -gt 0) {
    Add-EngineWarning -Engine 'query' -Message ('低区分度词: {0} —— Top-N 易被泛项占满，建议 -FocusTerms 限定或换更具体术语（S1）' -f ($lowDiscTerms -join ', '))
    Write-ColorOutput ('提示(S1): 关键词含低区分度词 [{0}]，建议 -FocusTerms 限定或换更具体术语' -f ($lowDiscTerms -join ', ')) 'Yellow'
}
if ($runModes -contains 'repo') {
    $minStarsTier = if ($MinStars -le 0) { 'none' } elseif ($MinStars -lt $script:Cfg.MinStarsHighThreshold) { 'low' } else { 'high' }
    if ($minStarsTier -eq 'high' -and $lowDiscTerms.Count -gt 0) {
        Add-EngineWarning -Engine 'query' -Message ('MinStars={0} 为高门槛档（≥{1}）且关键词含低区分度词 —— 小众/新项目会被整段滤掉，0 命中不可信；先用 -MinStars 0 复核（U-113）' -f $MinStars, $script:Cfg.MinStarsHighThreshold)
        Write-ColorOutput ('提示(U-113): -MinStars {0} 为高门槛档且含低区分度词，0 命中时先用 -MinStars 0 复核' -f $MinStars) 'Yellow'
    }
    elseif ($minStarsTier -eq 'high') {
        Write-ColorOutput ('提示: -MinStars {0} 为高门槛档（≥{1}）；结果稀疏时先用 -MinStars 0 复核' -f $MinStars, $script:Cfg.MinStarsHighThreshold) 'DarkGray'
    }
}

# U-241（v1.53.24）：总预算耗尽 ⇒ 整段跳过（见 Skip-ModeByBudget）。单模式 0 = 不限 ⇒ 本段恒不触发。
$script:_skipModesByBudget = @()
if (($runModes -contains 'research') -and (Test-RunBudgetExhausted)) { Skip-ModeByBudget -Mode 'research' -Kind 'research'; $script:_skipModesByBudget += 'research' }

if (($runModes -contains 'research') -and ($script:_skipModesByBudget -notcontains 'research')) {
    # P1：研究信源模式（Hugging Face Hub，匿名），不与仓库发现/代码证据混淆
    # v1.34.0 P2：-Auto 多模式下按 modeResults 累积（缓存仅存本模式结果，避免跨模式污染缓存键）
    $modeResults = @()
    # U-199（2026-10-21）：**引擎集合进缓存键**。病灶实测：新增 Packagist 后，`research#hf#redis#3` 命中了
    #   旧版（无 Packagist）的缓存 ⇒ Packagist 从未被请求，却被记成"检索成功但 0 命中"——等于用旧世界的结果
    #   报告新世界的覆盖。集合变化（新增引擎 / MCPS_DISABLE / 付费源可用性）必须换键。
    $researchSet = (@($script:_engineRegistry | Where-Object { $_.Kind -eq 'research' -and -not (Test-EngineDisabled -Engine $_) -and (Test-ResearchEngineAvailable $_) } | ForEach-Object { $_.Name }) -join ',')
    $cacheKey = "research#hf#$Keyword#$Limit#$researchSet"
    $cached = Get-LruResult -Key $cacheKey
    $researchDiag = $null
    $searchRounds = @()
    if ($cached) { $cacheHit = $true; $modeResults = @($cached) }
    else {
        # v1.19.0 ①研究源并发化：10 源 Runspace 池并行（替代 8 行串行 +=），SE 特判透传 -Site
        # v1.22.0 P1-4：-ExpandQuery 生效——首轮搜索结果做 0 命中诊断，必要时自动扩写变体重查（治 r3）
        $roundResults = @(Invoke-ConcurrentResearchSearch -Keyword $Keyword -Limit $Limit -Site $Site)
        $searchRounds += [PSCustomObject]@{ Round = 1; Query = $Keyword; Kind = 'original'; Hits = @($roundResults).Count }
        if ($ExpandQuery -and @($roundResults).Count -eq 0) {
            Write-ColorOutput "研究信源首轮 0 命中，-ExpandQuery 自动扩写变体重查（r3 场景）..." "Yellow"
            $firstHit = $null
            foreach ($v in @(Build-QueryVariants -Keyword $Keyword)) {
                if ($v.Round -eq 0) { continue }
                $vr = @(Invoke-ConcurrentResearchSearch -Keyword $v.Query -Limit $Limit -Site $Site)
                $searchRounds += [PSCustomObject]@{ Round = $v.Round + 1; Query = $v.Query; Kind = $v.Kind; Hits = @($vr).Count }
                $roundResults += $vr
                if (@($vr).Count -gt 0) { Write-ColorOutput "  ✓ 变体「$($v.Query)」命中 $(@($vr).Count) 条" "Green" }
            }
        }
        $modeResults = @($roundResults)
        # P2（v1.18.0）：arXiv 引用数补全（Semantic Scholar batch，顺序依赖串行后置），失败保持 Stars=0 不阻断
        # v1.34.0 修复：Enrich 经 Write-Output -NoEnumerate 返回（数组被 PSObject 包裹），@() 赋值后管线不展开、
        #           会被 Name 过滤器整体丢弃（实测 0 结果回归）；且其成功消息在重定向模式下泄漏进返回流。
        #           按仓库惯用法显式展平"数组的数组"并丢弃泄漏字符串（不再入缓存/结果）。
        $modeResults = @()
        # U-241：富化是一次额外的联网批量请求（不受池预算约束）⇒ 余量 <4s 时直接跳过，别把 45s 顶穿
        $enrInput = if (Test-RunBudgetExhausted -ReserveSec 4) { @() } else { @(Enrich-ArxivCitations -Results $roundResults) }
        foreach ($enr in @($enrInput)) {
            if ($enr -is [System.Array] -or $enr -is [System.Collections.IList]) { foreach ($enr2 in @($enr)) { $modeResults += $enr2 } }
            elseif ($enr -is [string]) { }   # 丢弃重定向泄漏的状态字符串（如"arXiv 引用数补全成功"）
            else { $modeResults += $enr }
        }
        Set-LruResult -Key $cacheKey -Data $modeResults
    }
    # v1.22.0 P1-4：0 命中诊断契约（无论是否 -ExpandQuery 都输出，Agent 可据此判断"确实没有" vs "太窄"）
    # v1.32.0 修复：MCPRegistry(Glama) 对任意 q 宽松返回默认单条(Stoop)——服务端行为。
    #           仅当「除 MCPRegistry 外 0 命中」时仍输出 research 诊断（避免宽松项掩盖 0 命中真相）。
    $nonMcpResults = @($modeResults | Where-Object { $_.Platform -ne 'MCPRegistry' })
    if (@($nonMcpResults).Count -eq 0) {
        $diagRounds = if ($searchRounds.Count -gt 0) { $searchRounds } else { @([PSCustomObject]@{ Round = 1; Query = $Keyword; Kind = 'original'; Hits = 0 }) }
        # v1.22.0：wider 建议恒非空——无领域词可扩时兜底"逐步放宽（去掉尾词）"由 Build-QueryVariants 生成；仍空则给通用搜索建议
        $widerSuggestions = @(Build-QueryVariants -Keyword $Keyword | Where-Object { $_.Round -ge 1 } | ForEach-Object { $_.Query } | Select-Object -Unique)
        if ($widerSuggestions.Count -eq 0 -and $Keyword) { $widerSuggestions = @("$Keyword general", "$Keyword overview") }
        $researchDiag = [PSCustomObject]@{
            interpretation       = 'no-match'
            confidence           = 'low'   # 0 命中有三义：确实没有 / 查询太窄 / 源瞬时不可用
            lowConfidenceNegative = $true
            searchRounds         = $diagRounds
            suggestedWiderQueries = $widerSuggestions
            disclaimer           = '0 命中不等价于"不存在"——请用 web 路径或更宽查询二次印证'
        }
        Write-ColorOutput "研究信源全轮 0 命中（low-confidence-negative）：建议用 web 搜索二次印证（可能确实没有，也可能查询太窄）" "Yellow"
    }
    # 研究信源按实际有无命中标记分平台成功（best-effort，部分源失败不影响其他）—— H1：平台列表由注册表驱动，新增研究源自动纳入
    foreach ($k in @($script:_engineRegistry | Where-Object { $_.Kind -eq 'research' } | ForEach-Object { $_.Platforms })) {
        $script:_perPlatformSuccess[$k] = (($modeResults | Where-Object { $_.Platform -eq $k }).Count) -gt 0
        # v1.21.0 P0-1：研究源引擎名（HF/Packages/...）未写状态时，按用户可读平台归并补 empty/ok
        $srcName = @($script:_engineRegistry | Where-Object { $_.Kind -eq 'research' -and $_.Platforms -contains $k } | ForEach-Object { $_.Name })[0]
        if ($srcName -and (Get-EngineStatus -Name $srcName) -eq 'unknown') {
            if (($modeResults | Where-Object { $_.Platform -eq $k }).Count -gt 0) { Set-EngineStatus -Name $srcName -Status 'ok' -Reason '' }
            else { Set-EngineStatus -Name $srcName -Status 'empty' -Reason '检索成功但 0 命中' }
        }
    }
    $modeCountResearch = @($modeResults | Where-Object { $_ }).Count
    $allResults = @($allResults) + @($modeResults)
}
if ($runModes -contains 'package') {
    # v1.46.3：-Package —— deps.dev **精确包**元数据（每包两次 GET，串行）。
    #   不并发：单包实测 0.3–2.7s，起 runspace 池的固定开销就超过收益；包数上限 10（Cfg.DepsDevMaxSpecs）。
    $modeResults = @()
    $pkgList = @($Package -split '[,;]' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    $pkgCacheKey = 'package#' + (($pkgList | ForEach-Object { $_.ToLowerInvariant() }) -join '|')
    $pkgCached = Get-LruResult -Key $pkgCacheKey
    if ($pkgCached) { $cacheHit = $true; $modeResults = @($pkgCached) }
    else {
        # 总时长预算（Cfg.TimeBudgetDefaultSec / MCPS_TIME_BUDGET_SEC）在这里也必须生效：
        #   单包两次请求实测 0.3–2.7s，10 个包串行可能吃掉整轮预算。超出即**停止后续包并明说还有几个没查**
        #   —— 与并发池"超预算 Stop 剩余引擎 + 告警"同一口径，不静默丢。
        $pkgBudget = Get-TimeBudgetSec
        $pkgDone = 0
        foreach ($pkgSpec in $pkgList) {
            if ($pkgBudget -gt 0 -and $pkgDone -gt 0 -and $sw.Elapsed.TotalSeconds -gt $pkgBudget) {
                $left = $pkgList.Count - $pkgDone
                Add-EngineWarning -Engine 'DepsDev' -Message ('超总时长预算 {0}s：剩余 {1} 个包未查询（-Package "{2}"）' -f $pkgBudget, $left, ($pkgList[$pkgDone..($pkgList.Count - 1)] -join ',')) -From 'time budget' -To 'stop (budget)'
                Write-ColorOutput ("DepsDev 超总时长预算 {0}s，剩余 {1} 个包未查询" -f $pkgBudget, $left) 'Yellow'
                break
            }
            $modeResults += @(Search-DepsDevPackage -PackageSpec $pkgSpec)
            $pkgDone++
        }
        if (@($modeResults).Count -gt 0) { Set-LruResult -Key $pkgCacheKey -Data @($modeResults) }
    }
    # 状态汇总：有结果 ⇒ ok；一条都没有时 **error 优先于 empty** —— 否则"网络失败"会被后一个 404 洗成"包不存在"。
    if (@($modeResults).Count -gt 0) { Set-EngineStatus -Name 'DepsDev' -Status 'ok' -Reason '' }
    elseif ((Get-EngineStatus -Name 'DepsDev') -ne 'error') { Set-EngineStatus -Name 'DepsDev' -Status 'empty' -Reason ('包不存在（deps.dev 404）：{0}' -f ($pkgList -join ', ')) }
    $allResults = @($allResults) + @($modeResults)
}

# U-241：code 模式同款预算守卫（见 Skip-ModeByBudget）
if (($runModes -contains 'code') -and (Test-RunBudgetExhausted)) { Skip-ModeByBudget -Mode 'code' -Kind 'code'; $script:_skipModesByBudget += 'code' }
if (($runModes -contains 'code') -and ($script:_skipModesByBudget -notcontains 'code')) {
    # v1.45.8：本次是否"只由本地通道接管"（供下方 coverage.Requested 过滤，见 code 分支与 Requested 段）
    $localCodeTookOver = $false
    # U-192（2026-10-21）：作用域计划先算（缓存键/引擎名单/Requested 三处共用同一事实源）
    $scopePlan = Get-CodeScopePlan -RepoScope $RepoScope -RepoScopeMode $RepoScopeMode
    $script:_codeScopePlan = $scopePlan
    if ($RepoScope -and -not $scopePlan.Identity) {
        Add-EngineWarning -Engine 'RepoScope' -Message ('-RepoScope "{0}" 无法解析为 owner/repo 或 git URL —— 本次退回全局检索，结果不再限定在该仓库' -f $RepoScope) -From '-RepoScope' -To 'fallback (global)'
        Write-ColorOutput "-RepoScope 无法解析：$RepoScope（仅支持 git URL 或 owner/repo），本次按全局检索" "DarkYellow"
    }
    if ($scopePlan.Mode -eq 'only' -and @($scopePlan.Excluded).Count -gt 0) {
        # 作用域内**被排除**的源必须明说：否则"0 条"会被读成"该仓库没有这段代码"
        Add-EngineWarning -Engine 'RepoScope' -Message ('-RepoScope only：以下源未参与 —— {0}' -f (@($scopePlan.Excluded) -join '; ')) -From '-RepoScope' -To 'skip (out of scope)'
    }
    $scopeSlug = if ($scopePlan.Identity) { [string]$scopePlan.Identity.Slug } else { $null }
    $poolEngines = if ($scopePlan.Mode -eq 'only') { @($scopePlan.Engines) } else { $null }
    if ($scopePlan.Mode -eq 'only' -and @($poolEngines).Count -eq 0) {
        Add-EngineWarning -Engine 'RepoScope' -Message '-RepoScope only：没有任何支持仓库过滤的源可用（搜索code/GrepApp/GitHub 均不可用）—— 本次代码证据必然为空' -From '-RepoScope' -To 'skip (no scoped engine)'
    }
    # v1.34.0 P2：多模式下按 modeResults 累积（缓存仅存本模式结果）
    $modeResults = @()
    # U-197/U-192/U-198：语言、仓库、路径、匹配语义都影响结果 ⇒ 全部进缓存键（否则 A 仓库命中会被 B 仓库复用）
    # U-199 同型：**实际引擎集合**也进键（新增/禁用源后不能复用旧覆盖）；only 模式取作用域名单，add 取全量。
    $codeSet = (@($(if ($scopePlan.Mode -eq 'only') { @($poolEngines) } else { @($script:_engineRegistry | Where-Object { $_.Kind -eq 'code' -and -not (Test-EngineDisabled -Engine $_) }) }) | ForEach-Object { $_.Name }) -join ',')
    $cacheKey = "evidence#$AutoKeyword#$Language#$Limit#$RepoScope#$RepoScopeMode#$PathFilter#$($MatchCase.IsPresent)#$($UseRegexp.IsPresent)#$codeSet"
    $cached = Get-LruResult -Key $cacheKey
    if ($cached) { $cacheHit = $true; $modeResults = @($cached) }
    else {
        if ($LocalCodeSearch) {
            # P2：优先本地离线代码检索，缺失自动降级远程（AC-P2-1/2）
            # v1.45.8：`$localCodeTookOver` 记录"本次只有本地通道参与"这一**事实**，供下方 Requested 过滤 ——
            #   否则远端 code 源会留在 Requested 里被记 not-run ⇒ 本地明明成功却报 Verdict=degraded/exit 4。
            $localKey = "localcode#$AutoKeyword#$LocalPath#$Limit"
            $localCached = Get-LruResult -Key $localKey
            if ($localCached) { $cacheHit = $true; $modeResults = @($localCached); $localCodeTookOver = $true }
            else {
                $local = Search-LocalCode -Keyword $AutoKeyword -LocalPath $LocalPath -Limit $Limit -UseAstGrep:$UseAstGrep
                if ($local -and @($local).Count -gt 0) {
                    $modeResults = @($local)
                    $localCodeTookOver = $true
                    Set-LruResult -Key $localKey -Data $modeResults
                }
                else {
                    # v1.47.2（P1-1）：降级是设计（AC-P2-1/2），但**必须留痕** —— 否则用户以为结果来自本地代码。
                    # v1.47.8：原因必须照抄引擎 reason。旧文案把三种情况一律说成"0 命中（或二进制缺失）"，
                    #   实测 `-LocalPath Z:/no/such/dir` 时用户会被引去查代码内容，而不是查自己的路径。
                    $localWhy = '原因未记录'
                    $localReasonTmp = $null
                    try { if ($script:_engineStatusReason.TryGetValue('LocalCode', [ref]$localReasonTmp) -and $localReasonTmp) { $localWhy = [string]$localReasonTmp } } catch { }
                    Add-EngineWarning -Engine 'LocalCode' -Message ("本地检索未接管（{0}）：已降级到远程 code 引擎，结果不再来自本机代码" -f $localWhy) -From 'local-first' -To 'remote code engines'
                    $modeResults = @(Invoke-ConcurrentCodeSearch -Keyword $AutoKeyword -Limit $Limit -Language $Language -Engines $poolEngines -RepoScope $scopeSlug -PathFilter $PathFilter -MatchCase:$MatchCase -UseRegexp:$UseRegexp)
                    Set-LruResult -Key $cacheKey -Data $modeResults
                }
            }
        }
        else {
            $modeResults = @(Invoke-ConcurrentCodeSearch -Keyword $AutoKeyword -Limit $Limit -Language $Language -Engines $poolEngines -RepoScope $scopeSlug -PathFilter $PathFilter -MatchCase:$MatchCase -UseRegexp:$UseRegexp)
            Set-LruResult -Key $cacheKey -Data $modeResults
        }
    }
    # v1.39.0（归并 A 线 v1.38.0）：-RepoScope 时合并 searchcode 仓库级检索（子缓存键独立，与并发池串行）。
    #   ★与 A 线的行为差异（已记录）：A 将本块放在"非缓存分支"内 ⇒ 主缓存命中时 sc 结果缺失；
    #   本侧放在**公共尾部**，主缓存命中时同样从 sc 子缓存合并（sc 子缓存未命中则补检一次）——不复制该缺陷。
    #   U-192：这是唯一**天然支持**任意宿主（GitHub/GitLab/Gitee…）的仓库级源，两种 RepoScopeMode 都保留。
    if ($RepoScope) {
        $scKey = "searchcoderepo#$AutoKeyword#$RepoScope#$Limit"
        # ★注意：Get-LruResult 未命中返回 $null，**不能**用 `@(...)` 包装再比 Count —— @($null).Count == 1 恒真
        #   ⇒ 会永远跳过函数调用（实跑踩过：SearchCodeRepo 进 Requested 但状态 not-run）。以真值判定：
        $sc = Get-LruResult -Key $scKey
        if (-not $sc) {
            $sc = @(Search-SearchCodeRepo -Keyword $AutoKeyword -Repository $RepoScope -Limit $Limit)
            if (@($sc).Count -gt 0) { Set-LruResult -Key $scKey -Data @($sc) }
        }
        if ($sc) { $modeResults = @($modeResults) + @($sc) }
    }
    # U-192（2026-10-21）：only 模式的**第二道**约束 —— 按仓库身份二次过滤。
    #   上游忽略限定符时（grep.app 的 repo 过滤、Sourcegraph 的 repo: 正则都可能失配），这里把库外结果剔掉并**报数**，
    #   否则"结果 100% 来自指定仓库"只是口号。本地通道（LocalCode）不适用：它的 Name/File 是文件路径。
    if ($scopePlan.Mode -eq 'only' -and $scopePlan.Identity -and -not $localCodeTookOver) {
        $sel = Select-RepoScopedResults -Results $modeResults -Identity $scopePlan.Identity
        if ($sel.Dropped -gt 0) {
            Add-EngineWarning -Engine 'RepoScope' -Message ('-RepoScope 过滤掉 {0} 条库外结果（上游未遵守仓库过滤，已二次剔除）' -f $sel.Dropped) -From 'upstream' -To 'filtered'
        }
        $modeResults = @($sel.Kept)
    }
    $modeCountCode = @($modeResults | Where-Object { $_ }).Count
    $allResults = @($allResults) + @($modeResults)
}

# U-241：repo 模式同款预算守卫（见 Skip-ModeByBudget）
if (($runModes -contains 'repo') -and (Test-RunBudgetExhausted)) { Skip-ModeByBudget -Mode 'repo' -Kind 'repo'; $script:_skipModesByBudget += 'repo' }
if (($runModes -contains 'repo') -and ($script:_skipModesByBudget -notcontains 'repo')) {
    # v1.34.0 P2：多模式下按 modeResults 累积（缓存仅存本模式结果）
    $modeResults = @()
    $cacheKey = "repo#$Platform#$AutoKeyword#$Language#$MinStars#$Limit"
    # v1.33.0 P1：平台列表由引擎注册表派生（H1 单一事实源——新增 repo 引擎自动纳入 All，此前为硬编码四平台）
    # + MCPS_DISABLE 统一过滤（缓存命中也同口径，保证 coverage.Requested 一致；不重复告警只调一次）
    $repoEngines = if ($Platform -eq "All") { @(Get-EngineByKind -Kind 'repo') } else { @(Get-EngineByKind -Kind 'repo' -Names @($Platform)) }
    $repoEngines = @(Get-EnabledEngines -Engines $repoEngines)
    $platformsToSearch = @($repoEngines | ForEach-Object { $_.Name })
    $cached = Get-LruResult -Key $cacheKey
    if ($cached) { $cacheHit = $true; $modeResults = @($cached) }
    elseif ($platformsToSearch.Count -eq 0) {
        Write-ColorOutput "所请求平台均被 MCPS_DISABLE 禁用，跳过仓库检索" "Yellow"
    }
    else {
        if ($platformsToSearch.Count -eq 1) {
            # 单平台直连：与 v1.5.1 串行行为一致，无并发开销（AC-P1-4）
            # ★B2-5（U-260）实测抓到：这里原先是 `& ("Search-$pf")` —— **动态调用**，绕过了 B2-1 的归一点。
            #   B2-1 当时把三处“池不可用回退串行”改成了 Invoke-EngineSerial，却漏了这一处（grep `& $e.Func` 看不见
            #   字符串拼出来的函数名）⇒ 它是全仓唯一不认封套的地方：迁移引擎单平台跑时，封套会被原样塞进结果集。
            #   改走 Invoke-EngineSerial（同一归一点）。副作用是 engine/1 的 verdict 也会在这里写状态。
            $pf = $platformsToSearch[0]
            $script:_perPlatformSuccess[$pf] = $false
            try {
                $modeResults += Invoke-EngineSerial -Engine $repoEngines[0] -EngineArgs @{ Keyword = $AutoKeyword; Language = $Language; MinStars = $MinStars; Limit = $Limit }
                $script:_perPlatformSuccess[$pf] = $true
                # v1.21.0：单平台直连成功但引擎未写状态 → 依结果 ok/empty
                if ((Get-EngineStatus -Name $pf) -eq 'unknown') {
                    if (@($allResults).Count -eq 0) { Set-EngineStatus -Name $pf -Status 'empty' -Reason '检索成功但 0 命中' }
                    else { Set-EngineStatus -Name $pf -Status 'ok' -Reason '' }
                }
            }
            catch {
                $script:_perPlatformSuccess[$pf] = $false
                if ((Get-EngineStatus -Name $pf) -eq 'unknown') { Set-EngineStatus -Name $pf -Status 'error' -Reason $_.Exception.Message }
                Write-ColorOutput "$pf 搜索失败(已跳过): $_" "Red"
            }
        }
        else {
            # 多平台并发：原生 Runspace 池（AC-P1-2/3/5）
            $modeResults += Invoke-ConcurrentPlatformSearch -Platforms $platformsToSearch -Keyword $AutoKeyword -Language $Language -MinStars $MinStars -Limit $Limit
        }
        Set-LruResult -Key $cacheKey -Data $modeResults
    }
    # v1.46.7（2026-10-21）：仓库质量过滤放在**缓存读取之后** —— 缓存存的是源原始结果（与过滤参数无关），
    #   同一份原始结果可服务任意过滤组合；过滤只改"本次交付的视图"。三个开关都没开时这段零开销。
    if ($ActiveWithin -gt 0 -or $ExcludeArchived -or -not [string]::IsNullOrWhiteSpace($License)) {
        $preByPlat = @{}
        foreach ($r in @($modeResults)) {
            $pp = [string]$r.Platform
            if (-not $pp) { continue }
            $preByPlat[$pp] = 1 + [int]$preByPlat[$pp]
        }
        $qf = Select-RepoQualityResults -Results $modeResults -ActiveWithin $ActiveWithin -ExcludeArchived:$ExcludeArchived -License $License
        $modeResults = @($qf.Kept)
        Write-RepoQualityWarnings -Stats $qf.Stats -ActiveWithin $ActiveWithin -ExcludeArchived:$ExcludeArchived -License $License
        # 某个源**原本有命中**、却被过滤光了 ⇒ 它的状态必须是 empty + 说清原因，不能留着 ok 让人以为还有结果。
        foreach ($pp in @($preByPlat.Keys)) {
            $after = @($modeResults | Where-Object { [string]$_.Platform -eq $pp }).Count
            if ($after -eq 0 -and (Get-EngineStatus -Name $pp) -eq 'ok') {
                Set-EngineStatus -Name $pp -Status 'empty' -Reason ('检索成功但质量过滤剔除全部 {0} 条' -f [int]$after)
            }
        }
    }
    $modeCountRepo = @($modeResults | Where-Object { $_ }).Count
    $allResults = @($allResults) + @($modeResults)
}

# P5：跨平台去重索引（O(1) 去重 + 重编号），幂等可重复执行
# 先过滤 Write-ColorOutput 在重定向(本工具捕获)时经成功流泄漏的状态字符串，避免其进入数据/缓存/编号
# （用“是否含 Name 属性”判定，因本环境 '-is [PSCustomObject]' 对 [string] 误判为 True）
$allResults = @($allResults | Where-Object { $_.PSObject.Properties.Name -contains 'Name' })
$allResults = Merge-DedupResults -Results $allResults
# P5：-Refine 二次检索（对已取回结果内存过滤，不触网）
if ($Refine) { $allResults = Refine-Results -Results $allResults -Keyword $Refine }
# v1.12.0 增强③：跨信源统一相关性排序（v1.22.0 起带关键词覆盖度 + FocusTerms 热度惩罚）
$allResults = Set-UnifiedScore -Results $allResults -Keyword $Keyword -FocusTerms $FocusTerms
# v1.39.0（归并 A 线 v1.40.0）：-FocusTerms 时检查"疑似流行榜占位"症状（零命中 + 最低星数≥1w）并告警
if ($FocusTerms) { Add-FocusPlaceholderWarning -Results $allResults -FocusTerms $FocusTerms -Keyword $Keyword }
# R94-D / H（远端 R1）：候选实体键只标注不合并（跨宿主等价未证实）；$candidateCount = 后置过滤（NoiseFloor/代码闸/交互选择）前的候选数，供 completeness 自曝省略量
foreach ($__r in @($allResults)) { try { $__r | Add-Member -NotePropertyName EntityKey -NotePropertyValue (Get-CanonicalRepoKey -Url ([string]$__r.Url) -Name ([string]$__r.Name)) -Force } catch { } }
$candidateCount = @($allResults).Count
# v1.22.0：-NoiseFloor 二级过滤——低于阈值的噪音候选直接剔除（assess-then-filter，默认关闭=丢弃 None）
if ($NoiseFloor -gt 0) {
    $before = @($allResults).Count
    $allResults = @($allResults | Where-Object { $_ -and ($_.PSObject.Properties.Name -contains 'Score') -and [double]$_.Score -ge $NoiseFloor })
    if (@($allResults).Count -lt $before) { Write-ColorOutput "-NoiseFloor=$NoiseFloor 过滤噪音候选: $before → $(@($allResults).Count)" "Yellow" }
}
# T1-5：只在纯代码证据模式套用源码质量闸；-Auto 的多模式混合排序不改变。
if ($runModes.Count -eq 1 -and $runModes[0] -eq 'code') {
    $beforeCodeCount = @($allResults).Count
    $allResults = @(Select-CodeEvidenceSourceFiles -Results @($allResults))
    if (@($allResults).Count -lt $beforeCodeCount) {
        Add-EngineWarning -Engine 'CodeEvidence' -Message ("优先源码文件：过滤 {0} 条文档/数据项" -f ($beforeCodeCount - @($allResults).Count))
    }
    elseif (@($allResults).Count -gt 0 -and
            @($allResults | Where-Object { [string]$_.File -match '\.(md|markdown|txt|rst|adoc|html?|json|ya?ml|csv|log|ipynb)\z' }).Count -eq @($allResults).Count) {
        Add-EngineWarning -Engine 'CodeEvidence' -Message '只有文档/数据命中，已保留兜底；不能当作源码证据'
    }
}
# P6：可选 fzf 交互选择（opt-in，非交互安全跳过）
if ($InteractiveSelect) { $allResults = Select-Interactive -Results $allResults }

# H3：缓存写合并——主流程结束时统一落盘一次（进程内多次 Set-LruResult 合并为一次全量写）
Flush-LruCache

$sw.Stop()
# R1 可观测性：分平台计数（从结果按 Platform 归并）+ p95 延迟（共享延迟袋）+ 重试次数
$perPlatformCount = @{}
foreach ($r in $allResults) {
    if ($r -and $r.PSObject.Properties.Name -contains 'Platform') {
        $k = [string]$r.Platform
        if (-not $perPlatformCount.ContainsKey($k)) { $perPlatformCount[$k] = 0 }
        $perPlatformCount[$k]++
    }
}
$p95 = 0
$requestsN = 0   # R94-F：HTTP 请求数 = 共享延迟袋条数（成功响应 + HTTP 层失败各记 1；传输层未达的不计）
try {
    $bag = [System.AppDomain]::CurrentDomain.GetData('mcps_latencies')
    if ($bag) { $requestsN = [int]$bag.Count }
    if ($bag -and (@($bag).Count -gt 0)) {
        $arr = @($bag | Sort-Object)
        $idx = [math]::Min($arr.Count - 1, [math]::Ceiling(0.95 * $arr.Count) - 1)
        if ($idx -lt 0) { $idx = 0 }
        $p95 = [math]::Round($arr[$idx], 1)
    }
} catch { }
# U-256：请求账本（attempted / succeeded；failed 派生）。与上面的延迟袋**并存**，一个版本内可对照。
$reqStats = Get-ApiRequestStats
$retryN = 0
try {
    $rc = [System.AppDomain]::CurrentDomain.GetData('mcps_retries')
    if ($rc) { $retryN = $rc[0] }
} catch { }
# v1.36.3：限流次数（AppDomain 共享，跨 Runspace 汇总；未初始化时回落旧 script 变量）
$rateLimitedN = $script:_rateLimitedCount
try {
    $rl = [System.AppDomain]::CurrentDomain.GetData('mcps_ratelimited')
    if ($rl) { $rateLimitedN = $rl[0] }
} catch { }
# H4：重试预算剩余量（可观测）
$retryBudgetLeft = -1
try {
    $rb = [System.AppDomain]::CurrentDomain.GetData('mcps_retry_budget')
    if ($rb) { $retryBudgetLeft = $rb[0] }
} catch { }
# v1.21.0 P0-1：coverage 汇总——区分「检索成功但 0 命中」(可信) 与「检索根本没执行/失败」(不可信)。
# requested=本次请求涉及的引擎；executed=ok|empty；blocked=auth_missing|tool_missing；degraded=error|rate_limited。
$requestedEngines = @()
$executedEngines = @()
$blockedEngines = @()
$degradedEngines = @()
$statusReasons = @{}
# v1.34.0 P2：按实际运行模式聚合 Requested（-Auto 多模式时为并集；引擎过滤口径与调度一致）
if ($runModes -contains 'research') {
    # v1.40.0：与 Invoke-ConcurrentResearchSearch 同源——可选付费源缺凭据不进 Requested（否则 Verdict 恒 partial）
    $requestedEngines += @($script:_engineRegistry | Where-Object { $_.Kind -eq 'research' -and -not (Test-EngineDisabled -Engine $_) -and (Test-ResearchEngineAvailable $_) } | ForEach-Object { $_.Name })
    # v1.45.8（审计 P2）：DeepSeek 是**付费**源（按成功请求计费），配了 key 即默认参与。
    #   默认行为不改（用户填了 key 就是要用），但"这次会花钱"必须可见 —— 否则只能靠事后看账单。
    if ($requestedEngines -contains 'DeepSeek') {
        Add-EngineWarning -Engine 'DeepSeek' -Message '付费源：按成功请求计费（约 $0.75/千次），本次参与研究检索；关闭方式 MCPS_DISABLE=DeepSeek 或 MCPS_RESEARCH_SOURCES 白名单'
    }
}
if ($runModes -contains 'package') {
    # v1.46.3：非注册表源（同 LocalCode / SearchCodeRepo 口径）—— 只有它一个，且必然请求。
    $requestedEngines += 'DepsDev'
}
if ($runModes -contains 'code') {
    if ($LocalCodeSearch) { $requestedEngines += 'LocalCode' }
    if ($RepoScope) { $requestedEngines += 'SearchCodeRepo' }   # v1.39.0（归并 A 线 v1.38.0）：仓库级 searchcode（按条件启用，同 LocalCode 口径）
    # v1.45.8（审计 P2）：Requested 必须等于「本次真正会跑的引擎」。
    #   病灶：`-LocalCodeSearch -LocalPath .` 本地命中后，远端 code 源**根本没有被调用**（见上面 code 分支的 else），
    #   却仍进 Requested ⇒ 被记 not-run ⇒ Verdict=degraded / exit 4。实测（本地 3 条命中）：
    #   Requested 5 / Executed ['LocalCode'] / Degraded [] / Verdict degraded / exit 4 —— 用户会以为本地结果不可信。
    #   ⚠ 不能反过来把 not-run 一律不计降级：那是 P0-D 为「池提前收工静默丢源」设的防线（真实缺陷）。
    #   这里只做**事实过滤**：本地通道确实接管时，远端本就没被请求过，不该出现在 Requested 里。
    if ($localCodeTookOver) {
        Add-EngineWarning -Engine 'coverage' -Message ('本地检索已命中，远端 code 源本次未参与（-LocalCodeSearch）: {0}' -f (@($script:_engineRegistry | Where-Object { $_.Kind -eq 'code' } | ForEach-Object { $_.Name }) -join ', '))
    } else {
        # U-192（2026-10-21）：only 模式只请求**作用域内**引擎 —— 被排除的源本次没发过请求，进 Requested 会被记 not-run
        #   并把 Verdict 拖成 degraded（与 U-158 的"本地接管"同型：Requested 必须等于真正会跑的引擎）。
        $codeReqPool = if ($script:_codeScopePlan -and $script:_codeScopePlan.Mode -eq 'only') { @($script:_codeScopePlan.Engines) } else { @($script:_engineRegistry | Where-Object { $_.Kind -eq 'code' -and -not (Test-EngineDisabled -Engine $_) }) }
        $requestedEngines += @($codeReqPool | ForEach-Object { $_.Name })
    }
}
if ($runModes -contains 'repo') {
    # v1.29.0 修复：缓存命中路径不执行搜索、$platformsToSearch 未赋值，此处从 $Platform 参数推导，
    # 避免 "You cannot call a method on a null-valued expression"（缓存命中 + 非 All 平台时的回归）。
    # v1.33.0：注册表派生 + MCPS_DISABLE 同口径过滤（主流程已赋值时直接复用，不重复调用）
    if (-not $platformsToSearch) {
        $tRe = if ($Platform -eq "All") { @(Get-EngineByKind -Kind 'repo') } else { @(Get-EngineByKind -Kind 'repo' -Names @($Platform)) }
        $platformsToSearch = @(Get-EnabledEngines -Engines $tRe | ForEach-Object { $_.Name })
    }
    $requestedEngines += @($platformsToSearch | ForEach-Object { $_.ToString() })
}
# U-155：各引擎 catch 可能吞掉网络异常并把“没发出去”误写成 empty（尤其 research/嵌套池）。
# 只在该引擎有“所有候选路由明确不可达”且没有任何 HTTP 响应/结果时，将其纠正为 skip；
# 401/403/429/5xx/超时/TLS 不在此列，避免活代理被判死或覆盖 auth/tool 缺失。
foreach ($en in $requestedEngines) {
    $netReason = $null
    if ($script:_networkFailures.TryGetValue($en, [ref]$netReason)) {
        $statusBefore = Get-EngineStatus -Name $en
        $hadHttp = $script:_networkHttpResponses.ContainsKey($en)
        $enPlatforms = @($script:_engineRegistry | Where-Object { $_.Name -eq $en } | ForEach-Object { $_.Platforms })
        $hasResults = @($allResults | Where-Object { $enPlatforms -contains $_.Platform }).Count -gt 0
        # U-206：`network-route-unproven` 只是「探活没确认」，慢代理/冷启动下真实请求可能已经成功；
        #   只有**真拿到结果**才静音（否则「路由未确认」会贴在成功结果旁边，比不报还糟）。
        # v1.47.2（P1-4 配套）：`$hadHttp` 不再单独静音 —— 探活曾判可达（含代理 502 错误页）、
        #   实际一个结果都没有时，旧条件会把整条归因吞掉，只剩 deadline。
        $quiet = $netReason -like 'network-route-unproven:*' -and $hasResults
        if (-not $quiet) {
            Add-EngineWarning -Engine $en -Message $netReason -From 'URL preflight' -To 'skip this domain'
            if (-not $hadHttp -and -not $hasResults) {
                if ($statusBefore -eq 'error') {
                    # v1.47.2：已记 error（deadline/预算/真失败）时**不改判 network_unavailable** ——
                    #   把"暂时没查成"改写成"所有路由不可达"是更坏的谎。只追加网络证据。
                    $prevReason = $null
                    [void]$script:_engineStatusReason.TryGetValue($en, [ref]$prevReason)
                    # v1.49.1：走 Join-EngineNetworkReason（含"已包含就不追加"）—— 旧写法直接 `-f` 拼接，
                    #   实测同一句「network-route-unproven: gitlab.com…」在 deadline 归因里出现两次。
                    if ($prevReason) { Set-EngineStatus -Name $en -Status 'error' -Reason (Join-EngineNetworkReason -Reason ([string]$prevReason) -EngineName $en) }
                }
                elseif ($statusBefore -in @('unknown','empty')) {
                    Set-EngineStatus -Name $en -Status 'network_unavailable' -Reason $netReason
                }
            }
        }
    }
}
# U-157（2026-10-02）：与 U-155 对称的另一侧纠正 —— **有结果就不许记 zero-hit**。
#   放在 U-155 之后、executed/ReasonCodes 汇总之前：判据取合并后的 $allResults（与 coverage/metrics 同一口径），
#   修掉"results=20 但 ReasonCodes=zero-hit"这类自相矛盾载荷（实测 Gitee/Codeberg）。
foreach ($en in $requestedEngines) {
    $stBefore = Get-EngineStatus -Name $en
    if ($stBefore -notin @('empty', 'unknown')) { continue }   # 其余状态不动：缺凭据/不可达/错误不许被"有结果"掩盖
    $enPlatforms = @($script:_engineRegistry | Where-Object { $_.Name -eq $en } | ForEach-Object { $_.Platforms })
    if (@($enPlatforms).Count -eq 0) { continue }               # LocalCode 等无 Platform 映射的引擎不参与本纠正
    $hasRes = @($allResults | Where-Object { $enPlatforms -contains $_.Platform }).Count -gt 0
    $stAfter = Resolve-EngineStatusFromResults -Status $stBefore -HasResults $hasRes
    if ($stAfter -ne $stBefore) {
        # 理由也要改写：Set-EngineStatus 的 -Reason 为空时**不清除**旧条目（`if ($Reason)`），
        # 留着"检索成功但 0 命中"会与改判后的 ok 自相矛盾（实测 Gitee：code=ok 但 Reasons 仍写 0 命中）。
        Set-EngineStatus -Name $en -Status $stAfter -Reason '状态纠正：合并结果集里确有本引擎结果，此前误记零命中'
        Add-EngineWarning -Engine $en -Message ("状态纠正：{0}({1}) → ok（合并结果集里确有本引擎结果）" -f $en, $stBefore) -From 'result reconciliation' -To 'ok'
    }
}
foreach ($en in $requestedEngines) {
    $st = Get-EngineStatus -Name $en
    if ($st -eq 'ok' -or $st -eq 'empty') { $executedEngines += $en }
    elseif ($st -in @('auth_missing', 'tool_missing', 'network_unavailable')) { $blockedEngines += $en }
    elseif ($st -eq 'error' -or $st -eq 'rate_limited') { $degradedEngines += $en }
    $reason = $null
    [void]$script:_engineStatusReason.TryGetValue($en, [ref]$reason)
    if ($reason) { $statusReasons[$en] = (Remove-InvisibleChars -Text $reason) }   # R95-C：Reasons 来自异常/上游文本，出口去零宽/双向控制字符（字符门）
}
# U-120b（C8，2026-09-28）：ReasonCodes —— 每个"未产出结果"的引擎一个机器可读原因码（Reasons 仍是人读文本，二者并存）。
#   missing-credential(auth_missing) / tool-missing(tool_missing) / rate-limited(rate_limited) / deadline(error 且原因含 超预算|截止|超时|timed out|timeout)
#   / error(其余 error) / zero-hit(empty) / not-run(unknown：请求了但未写状态)
#   + user-disabled：被 MCPS_DISABLE 禁用的本模式引擎 —— 语义不动（不进 Requested，宿主 R64 §1.2 裁定），只进 ReasonCodes。
$reasonCodes = [ordered]@{}
foreach ($en in $requestedEngines) {
    $st = Get-EngineStatus -Name $en
    $rtxt = $null
    [void]$script:_engineStatusReason.TryGetValue($en, [ref]$rtxt)
    # B2-1（U-258）：**迁到 engine/1 的引擎直接取 verdict.reasonCode**，不再用文案正则反推。
    #   为什么：正则是把「人读文案」当机器判定的输入 —— 改一句建议话术就会改 coverage 的机器分类，
    #   而且 "budget-truncated / filtered / deadline / forbidden" 四者全靠措辞区分（实测踩过 empty 三义）。
    #   未迁移引擎（engine/0）逐位走原 switch，行为不变。
    #   ★变量名用 $__verdict 而不是 $v：这段在**脚本作用域**里跑，$v 太常见（引擎里就有 foreach ($v in $variants)），
    #     留着等于给后面几百行埋一个"同名但语义不同"的坑。
    $__verdict = $null
    [void]$script:_engineVerdict.TryGetValue($en, [ref]$__verdict)
    $code = if ($__verdict) { if ($__verdict.ReasonCode) { [string]$__verdict.ReasonCode } else { $null } }
    else {
        switch ($st) {
        'ok'           { $null }
        'empty'        {
            # 2026-10-17（E-4 实测）：`empty` 有两种语义 —— ①真零命中 ②**自设预算截断**（主动放弃，非服务端拒绝）。
            #   引擎层已写清（如 gitlab-blobs.ps1「调用预算已用尽（n/n 次，自设封顶非服务端 429）」），
            #   但此处若一律映射 zero-hit ⇒ 限流 / 预算 / 真零命中 三者不可区分（E-4 证据：redis 必然命中却 0 条）。
            #   本步只细分 **ReasonCodes**（U-160：不改 Verdict；U-89：不新增 coverage 键）。
            # 2026-10-18（P0-C）：第三种语义 —— **被质量门槛丢弃**（找到 N 条但全低于阈值）。
            #   与 zero-hit 混同的后果：用户以为"库里没有"，实际是"我们丢了"（与 budget-truncated / forbidden 同类）。
            if ($rtxt -and $rtxt -match '预算已用尽|预算截断') { 'budget-truncated' }
            elseif ($rtxt -and $rtxt -match '已丢弃|低于阈值|filtered') { 'filtered' }
            else { 'zero-hit' }
        }
        'auth_missing' { 'missing-credential' }
        'tool_missing' { 'tool-missing' }
        'network_unavailable' { 'network-unavailable' }
        'rate_limited' { 'rate-limited' }
        'error'        {
            # B2-5（U-260）：**整段模式被总预算跳过**（Skip-ModeByBudget 的原话「未执行（不是 0 命中）」）
            #   此前笼统落 error ⇒ 与新的 execution.skipped（标 budget-truncated）**同一事实两种说法**。
            #   这里改成 budget-truncated：既与 skipped 一致，也让"没跑"不再被读成"跑了但失败"。
            if ($rtxt -and $rtxt -match '总预算已耗尽|未执行（不是 0 命中）') { 'budget-truncated' }
            # P0-A：403 = 能力关闭（账号层级），优先于 deadline —— 它是"不可用"而非"太慢"
            elseif ($rtxt -and $rtxt -match '\b403\b|forbidden|Global Search is disabled') { 'forbidden' }
            elseif ($rtxt -and $rtxt -match '超预算|截止|超时|timed out|timeout') { 'deadline' }
            else { 'error' }
        }
        default        { 'not-run' }
        }
    }
    if ($code) { $reasonCodes[$en] = $code }
}
$disabledKinds = @($runModes | Where-Object { $_ -in @('research', 'code', 'repo') })
foreach ($e in @($script:_engineRegistry | Where-Object { $disabledKinds -contains $_.Kind -and (Test-EngineDisabled -Engine $_) })) {
    if ($e.Kind -eq 'repo' -and $Platform -ne 'All' -and $e.Name -ne $Platform -and (@($e.Platforms) -notcontains $Platform)) { continue }
    if ($requestedEngines -notcontains $e.Name) { $reasonCodes[$e.Name] = 'user-disabled' }
}
# U-115（2026-09-28）：缺凭据源单列 —— "因缺凭据未请求"（auth_missing：连请求都没发）与 "已请求但失败"（error/rate_limited/deadline）分开报，
#   不新增 coverage 键（键集由 U-89 样本门守护）：① warnings[] 一条 [coverage] 汇总行；② 非 AsJson 的引擎健康度分三段；③ 逐引擎码见 ReasonCodes。
$credMissingEngines = @($requestedEngines | Where-Object { (Get-EngineStatus -Name $_) -eq 'auth_missing' })
$requestedFailedEngines = @($degradedEngines)
if ($credMissingEngines.Count -gt 0 -or $requestedFailedEngines.Count -gt 0) {
    Add-EngineWarning -Engine 'coverage' -Message ('因缺凭据未请求: {0}; 已请求但失败: {1}' -f $(if ($credMissingEngines.Count -gt 0) { $credMissingEngines -join ', ' } else { '(无)' }), $(if ($requestedFailedEngines.Count -gt 0) { $requestedFailedEngines -join ', ' } else { '(无)' }))
}
$hasBlocked = $blockedEngines.Count -gt 0
$hasDegraded = $degradedEngines.Count -gt 0
# P0-D（2026-10-19）：**请求了、却既没执行也没被阻塞**的源 —— 池提前收工时它们会从覆盖里静默消失。
#   实测（-NoProxy / cap=0 两臂）：Requested 4 源 / Executed 2 源 / Degraded [] ⇒ Verdict=full（假绿）。
#   与 budget-truncated / forbidden / filtered / verify-0 文件同族：把「没跑」当成「没问题」。
$notRunEngines = @($requestedEngines | Where-Object { $executedEngines -notcontains $_ -and $blockedEngines -notcontains $_ -and $degradedEngines -notcontains $_ })   # Degraded = 执行过但失败 ⇒ 不算「没跑」
$hasNotRun = $notRunEngines.Count -gt 0
if ($hasNotRun) { Add-EngineWarning -Engine 'coverage' -Message ('请求但未执行（池提前收工或未起 handle）: {0}' -f ($notRunEngines -join ', ')) }
$coverage = [PSCustomObject]@{
    Requested = $requestedEngines
    Executed  = $executedEngines
    Blocked   = $blockedEngines
    Degraded  = $degradedEngines
    Reasons   = $statusReasons
    ReasonCodes = $reasonCodes
    # U-120（C8，2026-09-28）：零执行单列。旧顺序 hasBlocked 优先 ⇒ Executed=[] 且有 blocked 时报 partial（"部分源成功"语义失真，
    # r61-research-R2 W6 实测）。现在：请求了引擎但一个都没执行 ⇒ 'none'；'no-engines' 仍指"什么都没请求"（全被禁用）。
    # v1.49.0：表达式抽成 Get-CoverageVerdict（Serve 侧共用同一套顺序，避免两处漂移）。
    Verdict   = (Get-CoverageVerdict -RequestedCount $requestedEngines.Count -ExecutedCount $executedEngines.Count -HasBlocked $hasBlocked -HasDegraded $hasDegraded -HasNotRun $hasNotRun)
}
# v1.21.0 P0-1：独立退出码（脚本级 ExitCode，供 Agent 判断"静默失败"）：
#   0 = 正常（全部引擎执行，含真实 0 命中）  2 = 工具缺失阻塞（tool_missing）
#   3 = 认证缺失阻塞（auth_missing）         4 = 引擎降级/部分失败（error/rate_limited）
$script:scriptExitCode = 0
if ($hasBlocked -or $hasDegraded -or $hasNotRun) {
    $toolBlocked = @($blockedEngines | Where-Object { (Get-EngineStatus -Name $_) -eq 'tool_missing' }).Count -gt 0
    $authBlocked = @($blockedEngines | Where-Object { (Get-EngineStatus -Name $_) -eq 'auth_missing' }).Count -gt 0
    if ($toolBlocked) { $script:scriptExitCode = 2 }
    elseif ($authBlocked) { $script:scriptExitCode = 3 }
    else { $script:scriptExitCode = 4 }
}
elseif ($hasDegraded) { $script:scriptExitCode = 4 }

# v1.22.0：研究信源 0 命中诊断（v1.34.0：仅在本次实际运行了 research 模式时输出）
if ($runModes -notcontains 'research') { $researchDiag = $null }

$metrics = [PSCustomObject]@{
    ElapsedMs          = $sw.ElapsedMilliseconds
    EngineMs           = $(  # U-61：每引擎耗时（ms），键 = 注册表 Name；被截止/预算 Stop 的引擎按池侧记录的已耗时长回填
        $__t = [ordered]@{}
        foreach ($__k in @($script:_engineTimings.Keys | Sort-Object)) { $__t[$__k] = [int]$script:_engineTimings[$__k] }
        [PSCustomObject]$__t
    )
    ResultCount        = $allResults.Count
    CacheHit           = $cacheHit
    RateLimitedCount   = $rateLimitedN
    WorkingSetMB       = [math]::Round([System.Diagnostics.Process]::GetCurrentProcess().WorkingSet64 / 1MB, 1)
    PerPlatformSuccess = $script:_perPlatformSuccess
    PerPlatformCount   = $perPlatformCount
    PerPlatformOutcome = $coverage
    P95LatencyMs       = $p95
    RetryCount         = $retryN
    RetryBudgetLeft    = $retryBudgetLeft
    # U-256（B1-6）：Requests 改为 **attempted**（含传输失败与 node 兜底），不再等于"延迟袋条数"。
    #   RequestsReturned 保留旧口径一个版本；恒等式 Requests = RequestsSucceeded + RequestsFailed。
    Requests           = $reqStats.Attempted
    RequestsSucceeded  = $reqStats.Succeeded
    RequestsFailed     = [Math]::Max(0, $reqStats.Attempted - $reqStats.Succeeded)
    RequestsReturned   = $requestsN
    Tokens             = $null   # R94-F：本技能不调用计 token 的模型接口 ⇒ 恒 null（unset），不伪造 0
    SpanStatus         = (Get-SpanStatus -Verdict $coverage.Verdict -ResultCount $allResults.Count)
    InjectionFlags     = (Get-InjectionFlagSummary -Results $allResults)   # R96：各检测标记命中的结果条数（只计数，不拦截）
    ExitCode           = $script:scriptExitCode
}

# v1.53.20：裸装首跑引导。**必须在 `if ($AsJson)` 之前算** —— 两个输出分支都要用这个变量；
#   放进分支里会让另一分支读到 $null（第一版就这么错，人读输出永远不打印）。
#   成本：正常用户（有令牌）在这里零开销 —— Get-FirstRunAdvice 先判令牌，够 4 个直接返回空，不探测工具。
$firstRunAdvice = @(Get-FirstRunAdvice)

if ($AsJson) {
    # 防 PS5.1 序列化坑：Merge-DedupResults/Refine-Results 经 Write-Output -NoEnumerate 返回时，
    # 数组会被 PSObject 包裹，ConvertTo-Json 会误序列化为 {"value":[...],"Count":n} 而非纯数组，
    # 破坏 -AsJson 供 Agent 流水线消费的合同。此处用 ForEach 枚举剥离 PSObject 包装，确保 results 为纯数组。
    # R2 同时做 null 字段规范化（Desc/License/Updated 置空串，利于严格消费方）。
    $cleanResults = @($allResults | ForEach-Object {
        $o = $_
        if ($null -eq $o.Desc) { try { $o.Desc = '' } catch { } }
        if ($null -eq $o.License) { try { $o.License = '' } catch { } }
        if ($null -eq $o.Updated) { try { $o.Updated = '' } catch { } }
        # U-124（2026-09-28）：URL 秘密参数打码 + 文本零宽/双向控制字符剔除（指令文本保留为数据）
        Protect-ResultOutput -Result $o
    })
    # P3（v1.15.0）：RAG context 输出——排序后取 top-K 拼 LLM 友好纯文本上下文（默认 K=Limit，-ContextTopK 可覆盖）
    $ragTopK = if ($ContextTopK -gt 0) { $ContextTopK } else { $Limit }
    $ragContext = Build-RagContext -Results $allResults -TopK $ragTopK
    # ★ v1.39.0 新增（归并 A 线 v1.41.0 修复批 / E3）：**全引擎 0 命中必须给信息性告警** ——
    #   0 命中本身合法（empty 是合法状态），但调用方看到 results:[] 无法区分"真没结果"与"查询本身有问题"；
    #   此处补"查询侧"线索（关键词长度/泛度），引擎故障侧的 0 命中已由既有状态-警告契约覆盖（u158 系）。
    if (@($cleanResults).Count -eq 0) {
        $kwLen = if ($Keyword) { $Keyword.Length } else { 0 }
        $zHint = if ($kwLen -gt 200) {
            ("关键词长度 {0} 字符，**过长可能导致无法匹配**；建议收窄到 1-2 个具体名词" -f $kwLen)
        } else {
            "可能原因：关键词过窄/过泛/含特殊字符；引擎状态见 coverage.Reasons 与 warnings[]"
        }
        Add-EngineWarning -Engine 'query' -Message ("0 命中：所有引擎均返回空。{0}" -f $zHint) -From 'result-count' -To 'info'
    }
    # v1.53.20：裸装首跑引导（变量在 `if ($AsJson)` 之前算好，非 AsJson 分支同样使用）—— 必须在 warnings 取值前入队。
    if ($firstRunAdvice.Count -gt 0) {
        Add-EngineWarning -Engine 'first-run' -Message ('检测到裸装（无令牌 + 无本地检索工具）：匿名限速会显著压低召回。建议 —— ' + (($firstRunAdvice | ForEach-Object { $_ }) -join '；'))
    }
    # v1.23.0 #5c：引擎警示（fallback/失败路径）进 JSON 顶层 warnings[]（Agent 可审计"谁降级了、为什么"）
    $warningsOut = @(Get-EngineWarnings | ForEach-Object { if ($_ -is [string]) { Remove-InvisibleChars -Text $_ } else { $_ } })   # R95-C 字符门
    # v1.45.9：`.env` 读失败**置顶** —— 它决定"令牌为何没生效"，比任何单引擎降级都更影响判读。
    #   刻意保留上面那行的原样（R95-C 门按字面锚定"所有引擎告警都过 Remove-InvisibleChars"）；
    #   本行只做前置拼接，且对自带路径/异常文本同样过字符门。
    if (@($script:EnvLoadErrors).Count) {
        $envFileWarnings = @($script:EnvLoadErrors | ForEach-Object { Remove-InvisibleChars -Text "[env] .env 存在但不可读：$($_.Path) — $($_.Error)" })
        $warningsOut = @($envFileWarnings + $warningsOut)
    }
    # R94-H（远端 R1）：不完整要自曝 —— 返回/候选/省略 + mode + truncated + requery 游标；context(top-K) 另报 extract
    $completeness = New-CompletenessInfo -Returned @($cleanResults).Count -Candidates $candidateCount -PerSourceCount $perPlatformCount -PerSourceLimit $Limit -ContextTopK $ragTopK
    # U-160 L2（2026-10-03）：失败子源**显式化**（AIP-217 `unreachable[]` / `errors[]`）。
    #   ★code **引用**既有 ReasonCodes，**不复制第二份枚举**（复制必漂移）；生成与校验同源。
    #   ★只有 **网络不可达** 进 `unreachable[]`；**成功的零命中（zero-hit）绝不进**（否则又是"空跑冒充成功"）。
    #   ★失败子源按 AIP-217 以 null 语义表达（本载荷把各源结果合并进 results[]，故以 errors[].path 指认源）。
    $unreachableOut = @($requestedEngines |
        Where-Object { (Get-EngineStatus -Name $_) -eq 'network_unavailable' } |
        ForEach-Object { [PSCustomObject]@{ path = "engines.$_" } })
    $errorsOut = @($requestedEngines | ForEach-Object {
        $st = Get-EngineStatus -Name $_
        if ($st -notin @('ok', 'empty')) {
            # ★注意：$reasonCodes 是 [ordered]@{}（OrderedDictionary），**没有 TryGetValue**（那是 Hashtable 的方法）
            #   —— 首版用 TryGetValue 在运行期抛 InvalidOperation（实测）。这里用 Contains + 索引器。
            $code = $null
            if ($reasonCodes -and $reasonCodes.Contains($_)) { $code = [string]$reasonCodes[$_] }
            if ($code) {
                # R4-F1-c（2026-10-04）：带上**脱敏后的原因摘要** —— 此前 `errors[]` 只有 { path, code }，
                #   `deadline` / `error` 对调用方是**黑盒**（R4-0b 查到根因全靠 doctor + 读码，不是靠载荷）。
                #   ★复用 Protect-TextField（与结果项同一脱敏器，单一源；防零宽/双向控制字符混入）★限长防膨胀。
                $rsn = ''
                try {
                    if ($script:_engineStatusReason -and $script:_engineStatusReason.ContainsKey($_)) {
                        $rsn = [string]$script:_engineStatusReason[$_]
                    }
                } catch { }
                if ($rsn) { $rsn = [string](Protect-TextField -Text $rsn) }
                if ($rsn.Length -gt 200) { $rsn = $rsn.Substring(0, 200) }
                # ★无条件发出 message（空串也算）：本仓 schema 纪律是 closed + **full required**
                #   ⇒ 省略字段会让载荷不合法；不能按"可选更兼容"处理（首版判断错，被 R95-A 门纠正）。
                [PSCustomObject]@{ path = "engines.$_"; code = $code; message = $rsn }
            }
        }
    })
    $contractStatus = Get-ContractStatus -Verdict $coverage.Verdict
    # ── B2-5（U-260）：execution 块（RunEnvelope v2 §3.3）──────────────────────────────
    #   只填**本进程真的知道**的数：
    #     budgetMs  = 总预算（MCPS_TOTAL_BUDGET_SEC；未设 ⇒ 0，不编默认值）
    #     spentMs   = 全局秒表（与 metrics.ElapsedMs 同源）
    #     reserveMs = 1500（归并/渲染预留，B1-2 定的常量；写出来是为了让"预算-实耗"能对账）
    #     truncated = 任一池早停（预算或逐源截止）**或** 任一引擎 reasonCode ∈ {deadline, budget-truncated}
    #     skipped   = 请求过但**没执行**的源（复用 coverage.ReasonCodes 这一份事实，不另起一套判定）
    #     pools     = 逐池事实，由 Invoke-EnginePool 在池内记录（含被总预算收紧后的预算）
    #   ★为什么不把 "sufficient" 放顶层：它是**逐池**性质；顶层给一个布尔会掩盖"repo 够了、code 不够"。
    #   ★判定全部在 New-ExecutionBlock（纯函数，可单测）；这里只负责取数。
    $__totalBudgetSec = 0
    try { $__totalBudgetSec = [int](Get-TotalBudgetSec) } catch { }
    $execution = New-ExecutionBlock -PoolStats @($script:_poolStats) -ReasonCodes $reasonCodes -ReasonTexts $script:_engineStatusReason `
        -TotalBudgetSec $__totalBudgetSec -SpentMs ([int]$sw.ElapsedMilliseconds) -ReserveMs 1500 -Ledger (Save-ApiLedger)
    $payload = [PSCustomObject]@{ version = $VERSION; results = $cleanResults; metrics = $metrics; coverage = $coverage; research = $researchDiag; warnings = $warningsOut; completeness = $completeness; context = $ragContext; status = $contractStatus; unreachable = $unreachableOut; errors = $errorsOut; modes = @($runModes); queryType = $(if ($AutoPlan) { [string]$AutoPlan.QueryType } else { $null }); planSource = $(if ($AutoPlan) { [string]$AutoPlan.Source } else { $null }); autoKeyword = $(if ($Auto) { [string]$AutoKeyword } else { $null }); counts = [PSCustomObject]@{ repo = $modeCountRepo; code = $modeCountCode; research = $modeCountResearch }; execution = $execution }
    # R2 结构化契约校验（PS5.1 无 Test-Json，手写轻量校验）；失败则包裹 _schemaError 而非裸抛
    $contract = Test-AsJsonContract -Payload $payload
    if ($contract.Ok) {
        $payload | ConvertTo-Json -Depth 6
    } else {
        [PSCustomObject]@{
            version      = $VERSION
            _schemaError = $contract.Reason
            results      = @()
            metrics      = $metrics
        } | ConvertTo-Json -Depth 6
    }
}
else {
    # v1.53.20：裸装首跑引导（-AsJson 走 warnings[]；这里给人读的版本，放在结果头部而不是淹没在末尾）
    if ($firstRunAdvice.Count -gt 0) {
        Write-ColorOutput '' 'Yellow'
        Write-ColorOutput '首次使用建议（检测到：无令牌 + 无本地检索工具）' 'Yellow'
        $frun = 1
        foreach ($a in $firstRunAdvice) { Write-ColorOutput ("  {0}) {1}" -f $frun++, $a) 'Yellow' }
    }
    Write-ColorOutput "`n═══════════════════════════════════════════════════════════════" "Magenta"
    Write-ColorOutput "所有平台搜索结果汇总" "Magenta"
    Write-ColorOutput "═══════════════════════════════════════════════════════════════`n" "Magenta"
    Display-Results -Results $allResults
    Write-ColorOutput "`n── 指标 ──" "Magenta"
    Write-ColorOutput "ElapsedMs=$($metrics.ElapsedMs) ResultCount=$($metrics.ResultCount) CacheHit=$($metrics.CacheHit) WorkingSetMB=$($metrics.WorkingSetMB)" "Magenta"
    # v1.21.0 P0-1：人读状态摘要——Engine 健康度（谁执行了 / 谁被阻塞 / 为什么）
    if ($coverage.Blocked.Count -gt 0 -or $coverage.Degraded.Count -gt 0) {
        Write-ColorOutput "`n── 引擎健康度 ──" "Yellow"
        Write-ColorOutput ("  执行成功: {0}" -f ($(if ($coverage.Executed.Count -gt 0) { $coverage.Executed -join ', ' } else { '(无)' }))) "White"
        # U-115：缺凭据（未请求）/ 工具缺失 / 已请求但失败 三段分列
        if ($credMissingEngines.Count -gt 0) {
            Write-ColorOutput ("  因缺凭据未请求: {0}" -f ($credMissingEngines -join ', ')) "Red"
            foreach ($en in $credMissingEngines) {
                $rr = $null; [void]$script:_engineStatusReason.TryGetValue($en, [ref]$rr)
                Write-ColorOutput "    - ${en}: $rr" "DarkRed"
            }
        }
        $toolMissingEngines = @($coverage.Blocked | Where-Object { $credMissingEngines -notcontains $_ })
        if ($toolMissingEngines.Count -gt 0) {
            Write-ColorOutput ("  工具缺失被阻塞: {0}" -f ($toolMissingEngines -join ', ')) "Red"
            foreach ($en in $toolMissingEngines) {
                $rr = $null; [void]$script:_engineStatusReason.TryGetValue($en, [ref]$rr)
                Write-ColorOutput "    - ${en}: $rr" "DarkRed"
            }
        }
        if ($coverage.Degraded.Count -gt 0) {
            Write-ColorOutput ("  已请求但失败(降级): {0}" -f ($coverage.Degraded -join ', ')) "Yellow"
            foreach ($en in $coverage.Degraded) {
                $rr = $null; [void]$script:_engineStatusReason.TryGetValue($en, [ref]$rr)
                Write-ColorOutput "    - ${en}: $rr" "DarkYellow"
            }
        }
        Write-ColorOutput ("  结论(退出码 {0}): {1}" -f $script:scriptExitCode, $(if ($script:scriptExitCode -eq 0) { '全部引擎执行成功' } elseif ($script:scriptExitCode -eq 2) { '本地检索工具缺失，结果不可信' } elseif ($script:scriptExitCode -eq 3) { '认证缺失，部分代码证据未检索' } else { '部分引擎降级/失败' })) "Cyan"
    }
}
# v1.47.2（P1-6）：把"文档承诺的退出码"真正落到**进程**上（此前 6209-6217 只写进 metrics.ExitCode，
#   进程 rc 恒 0 ⇒ 任何靠 rc 判静默失败的 Agent/CI 都把"一个源都没查成"当成功）。
#   ★ 只在**一个引擎都没查成**时非 0（Verdict ∈ none / no-engines）。`partial`/`degraded` 表示
#   "查到了，但有源被挡/被拖慢" —— 多源聚合下几乎每轮都成立（本机 hosts 劫持 GitHub ⇒ 恒 partial），
#   一律非 0 会把 rc 变成常量噪声，反而更看不见真失败。
#   `metrics.ExitCode` 的 0/2/3/4 语义**不变**（要归因读它）；进程 rc 只回答"这次有没有结论"。
#   ★ 用 `exit` 而不是 `[Environment]::ExitCode`：后者会被同会话调用方（门禁 harness）继承，
#     让"全绿"的 harness 进程带非 0 退出码；`exit` 只结束本脚本（实测 `& script.ps1` 不会杀宿主）。
$processExitCode = 0
if ($coverage.Verdict -in @('none', 'no-engines')) {
    $processExitCode = $(if ($script:scriptExitCode -ne 0) { $script:scriptExitCode } else { 4 })
}
exit $processExitCode
} # end main-flow guard (skipped when dot-sourced)
