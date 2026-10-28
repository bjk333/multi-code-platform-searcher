# tests/test-gitlab-budget.ps1 —— 批次 1 动作 2/3 的离线门（可单独跑，零网络）
#
# 覆盖：
#   C1  429 ⇒ GitLab 引擎标 rate_limited + warning 带配额语义（动作3）
#   C2  预算 = 2：全局 blobs 失败 + 项目搜索成功 ⇒ **恰好 2 次调用**，且不再发起逐项目 blobs（动作2）
#   C3  预算 = 3 ⇒ 允许 1 次逐项目 blobs（确认预算不是"一刀切禁用"）
#   C4  预算耗尽时状态值必须是主脚本认识的那组（ReasonCode 不得落成 'not-run'）
#   C5  **不设 env** 时必须走 Cfg（单源）——否则 Cfg 那条路径根本没被测到（假门）
#   C6  预算耗尽的状态必须属 **executed 组（ok|empty）**，不得落 degraded 组（error|rate_limited）
#       —— 这正是 C2 原先写错的地方：把它记成 rate_limited 会让 coverage 报 Verdict=none。
#   C7  429 **文案**配额语义（B-5 负例锚点）：repo warning 须含「配额」且不得退回「检索失败」；
#       blobs 429 须 rate_limited + reason 含「配额」（2026-10-11 探针实证：blobs 的 429 此前被两级 catch 吞成 empty，
#       配额文案不可达——已修）；「限流等待过长」形状（Retry-After 超限快速失败，消息不含 429）两引擎同样归 rate_limited
#   C8  403 免费版关闭 ⇒ 预算留给回退 + 文案分「已检索/未执行」两档（2026-10-19 修）
#   C9  403 进程级记忆（AppDomain，跨 runspace）⇒ 后续查询不再探全局端点
#   C10 逐项目 blobs 的页大小必须跟随 -Limit（原写死 3 ⇒ 回退路径静默忽略 Limit）
#
# 用法: powershell -File tests/test-gitlab-budget.ps1 -SkillDir <dir>
param([string]$SkillDir = '')
$ErrorActionPreference = 'Continue'
if (-not $SkillDir) { $SkillDir = (Resolve-Path (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '..')).Path }
$SkillDir = (Resolve-Path $SkillDir).Path

# 取函数定义而不跑主流程（守卫见 multi-platform-searcher.ps1:3555-3556）
$env:MCPS_NO_MAIN = '1'
# ★桩值必须含 FAKE：U-136 令牌门按形状 `glpat-` + 20 个 [A-Za-z0-9\-_] 全仓扫描，
#   而它的放行判据是**匹配串自身**含 FAKE/EXAMPLE/PLACEHOLDER/DUMMY/xxxx。
#   旧值以 glpat- 开头但串内无这些词 ⇒ 被当成真 PAT 判红。
#   ★注意：连**注释里**也不能出现该形状的字面量（注释同样是文本文件内容）——所以这里不复述旧值。
$env:GITLAB_TOKEN = 'glpat-FAKE-not-a-real-token-00'
. (Join-Path $SkillDir 'multi-platform-searcher.ps1')

$ok = $true; $fails = @(); $lines = @()

# ★B2-1（U-265，2026-10-26）：`Search-GitLabBlobs` 已改返回 **EngineContract v1 封套**、不再自报状态。
#   本门要问的题目没变（预算/429/403 各自落哪一格），变的是**取值的来源** ⇒ 这里走生产同一条 L1 链路
#   （Resolve-EngineVerdict + ConvertTo-LegacyEngineStatus）把封套换算成"最终会进 coverage 的那个状态"。
#   ★不许改成读 `_engineStatus` 表：迁移后引擎不写它了，读到的永远是 `unknown`（那正是第一版 11 条全红的原因）。
function Get-BlobsState {
    param($Envelope)
    $v = Resolve-EngineVerdict -Envelope (ConvertTo-EngineEnvelope -Engine 'GitLabBlobs' -Kind 'code' -Result $Envelope)
    return [PSCustomObject]@{
        Status = [string](ConvertTo-LegacyEngineStatus -Verdict $v)
        Reason = [string]$v.Reason
        Code   = [string]$v.ReasonCode
    }
}

# ---- mock 基础设施（离线） ----
$script:apiCalls = 0
$script:apiUris = @()
$script:blobSearchCalls = 0
$script:mockMode = 'empty'   # 'empty' | '429' | 'toolong' | 'projects'

$origApi = Get-Item function:Invoke-ApiRequest
$origBlob = $null
if (Test-Path function:Invoke-GitLabProjectBlobSearch) { $origBlob = Get-Item function:Invoke-GitLabProjectBlobSearch }

# ★B2-1（U-265）：`Write-ColorOutput` 在**输出被重定向**时走 `Write-Output`（成功流），
#   于是引擎 return 之前的进度串会混进返回值。迁移后引擎返回的是封套 ⇒ 被污染就变成 [字符串, 封套]
#   ⇒ ConvertTo-EngineEnvelope 判成 engine/0 + 2 条结果 ⇒ 状态全错。U-263/U-264 的夹具都显式桩掉它。
function Write-ColorOutput { param([string]$Text, [string]$Color = 'White') }
# ★`Add-EngineWarning` **不桩**：C7a/C7c 的题目就是"429 的 warning 带不带配额语义"，桩掉等于把被测环换成自己的实现。

Set-Item function:Invoke-ApiRequest -Value {
    param($Uri, $Headers, $TimeoutSec = 15, $MaxAttempts = 3, [switch]$NoProxy)
    $script:apiCalls++
    $script:apiUris += [string]$Uri
    if ($script:mockMode -eq '429') { throw 'HTTP 429 Too Many Requests (Retry-After: 60)' }
    # C7c：原样复现 Invoke-ApiRequest 的 TooLong 分支（主脚本 throw "限流等待过长: $Uri (Retry-After Ns)"，消息不含 429）
    if ($script:mockMode -eq 'toolong') { throw "限流等待过长: $Uri (Retry-After 30805s)" }
    if ($script:mockMode -eq '403' -and $Uri -match 'api/v4/search\?scope=blobs') { throw '403: Global Search is disabled for this scope' }
    if ($Uri -match '/search\?scope=blobs') { return [PSCustomObject]@{ Content = '[]'; StatusCode = 200 } }
    if ($script:mockMode -eq '403' -and $Uri -match '/projects\?search=') { return [PSCustomObject]@{ Content = '[{"id":1,"path_with_namespace":"a/b"},{"id":2,"path_with_namespace":"c/d"},{"id":3,"path_with_namespace":"e/f"}]'; StatusCode = 200 } }
    if ($Uri -match '/projects\?search=') {
        return [PSCustomObject]@{ Content = '[{"id":1,"path_with_namespace":"a/b"},{"id":2,"path_with_namespace":"c/d"},{"id":3,"path_with_namespace":"e/f"}]'; StatusCode = 200 }
    }
    return [PSCustomObject]@{ Content = '[]'; StatusCode = 200 }
} -Force

Set-Item function:Invoke-GitLabProjectBlobSearch -Value {
    param($Keyword, $Limit, $projData)
    $script:blobSearchCalls++
    $script:apiCalls += @($projData).Count     # 逐项目各 1 请求，按引擎语义记账
    return @()
} -Force

function Reset-Stub([string]$mode, [switch]$KeepMemo) {
    $script:apiCalls = 0; $script:apiUris = @(); $script:blobSearchCalls = 0; $script:mockMode = $mode
    # C9 要跨调用观察"记忆"⇒ KeepMemo 时不清；其余用例必须清，否则 403 用例会污染后面的用例
    if (-not $KeepMemo) { try { [System.AppDomain]::CurrentDomain.SetData('MCPS.GitLabGlobalBlobsDisabled', $false) } catch { } }
}

# ---- C1：429 ⇒ rate_limited（动作3）----
try {
    Reset-Stub '429'
    $r = @(Search-GitLab -Keyword 'x' -Language '' -MinStars 0 -Limit 5)
    $st = Get-EngineStatus -Name 'GitLab'
    if ($st -ne 'rate_limited') { $ok = $false; $fails += "C1 GitLab 状态应为 rate_limited，实得 '$st'" }
    if ($script:apiCalls -ne 1) { $ok = $false; $fails += "C1 repo 路径应恰好 1 次调用，实得 $($script:apiCalls)" }
    $lines += ("[C1] 429 -> status={0} calls={1}" -f $st, $script:apiCalls)
} catch { $ok = $false; $fails += "C1 exec: $($_.Exception.Message)" }

# ---- C2：预算 2 ⇒ 恰好 2 次、不发起逐项目 blobs（动作2）----
try {
    Reset-Stub 'empty'
    $env:MCPS_GITLAB_MAX_CALLS = '2'
    $r = @(Search-GitLabBlobs -Keyword 'x' -Limit 5)
    $st = (Get-BlobsState $r).Status
    if ($script:apiCalls -ne 2) { $ok = $false; $fails += "C2 应恰好 2 次调用，实得 $($script:apiCalls)" }
    if ($script:blobSearchCalls -ne 0) { $ok = $false; $fails += "C2 预算 2 时不应发起逐项目 blobs，实得 $($script:blobSearchCalls)" }
    if ($st -ne 'empty') { $ok = $false; $fails += "C2 预算耗尽状态应为 empty，实得 '$st'" }
    # ★批次3语义修正（2026-10-10）：原断言钉的是 'rate_limited'——那是**错的**，本门当时在为一个错误设计背书。
    #   主脚本 coverage 口径（顶层注释）：executed = ok|empty；blocked = auth_missing|tool_missing；
    #   degraded = error|rate_limited。把"自设预算耗尽"记成 rate_limited ⇒ 进 degraded ⇒ executed 为空
    #   ⇒ Verdict 落 'none'（"请求了引擎但全未执行"），把"跑过但被截断无命中"谎报成"根本没跑"。
    #   U-158E A-2 对照臂（有 GITLAB_TOKEN）实测抓到。语义上预算耗尽是我方**主动**放弃，不是服务端拒绝。
    #   ★新增 C6 把这条提升为**类级**判据（钉组别而非字面值），避免下次再被单个字面量误导。
    $lines += ("[C2] budget=2 -> calls={0} blobSearch={1} status={2}" -f $script:apiCalls, $script:blobSearchCalls, $st)
} catch { $ok = $false; $fails += "C2 exec: $($_.Exception.Message)" }

# ---- C3：预算 3 ⇒ 允许 1 次逐项目 blobs ----
try {
    Reset-Stub 'empty'
    $env:MCPS_GITLAB_MAX_CALLS = '3'
    $r = @(Search-GitLabBlobs -Keyword 'x' -Limit 5)
    if ($script:blobSearchCalls -lt 1) { $ok = $false; $fails += "C3 预算 3 时应发起逐项目 blobs，实得 $($script:blobSearchCalls)" }
    if ($script:apiCalls -gt 3) { $ok = $false; $fails += "C3 调用数不得超预算 3，实得 $($script:apiCalls)" }
    $lines += ("[C3] budget=3 -> calls={0} blobSearch={1}" -f $script:apiCalls, $script:blobSearchCalls)
} catch { $ok = $false; $fails += "C3 exec: $($_.Exception.Message)" }

# ---- C4：状态值必须在主脚本认识的那组内（否则 ReasonCode 落 not-run）----
try {
    $known = @('ok', 'empty', 'auth_missing', 'tool_missing', 'rate_limited', 'error', 'network_unavailable')
    Reset-Stub 'empty'
    $env:MCPS_GITLAB_MAX_CALLS = '2'
    $r = @(Search-GitLabBlobs -Keyword 'x' -Limit 5)
    $st = (Get-BlobsState $r).Status
    if ($known -notcontains $st) { $ok = $false; $fails += "C4 状态 '$st' 不在主脚本已知集合内 ⇒ ReasonCode 会落 not-run" }
    $lines += ("[C4] status-in-known-set={0} ({1})" -f ($known -contains $st), $st)
} catch { $ok = $false; $fails += "C4 exec: $($_.Exception.Message)" }

# ---- C5：**不设 env** 时必须走 Cfg（单源）----
#   ★本条的由来（2026-10-09 实测教训）：C2/C3 都显式设了 MCPS_GITLAB_MAX_CALLS，
#   而 env 优先级高于 Cfg ⇒ 当时把 Cfg.GitLabMaxCallsPerQuery 改成 999，门**依然全绿** ——
#   因为 Cfg 这条路径根本没被测到。没有 C5，这个门是**假门**。
try {
    Reset-Stub 'empty'
    Remove-Item Env:\MCPS_GITLAB_MAX_CALLS -ErrorAction SilentlyContinue
    $r = @(Search-GitLabBlobs -Keyword 'x' -Limit 5)
    $expected = 2
    try { if ($script:Cfg -and $script:Cfg.GitLabMaxCallsPerQuery) { $expected = [int]$script:Cfg.GitLabMaxCallsPerQuery } } catch { }
    if ($script:apiCalls -ne $expected) { $ok = $false; $fails += "C5 无 env 时调用数应等于 Cfg($expected)，实得 $($script:apiCalls)" }
    $lines += ("[C5] default(Cfg) -> calls={0} expected(Cfg)={1}" -f $script:apiCalls, $expected)
} catch { $ok = $false; $fails += "C5 exec: $($_.Exception.Message)" }

# ---- C6：预算耗尽的状态组别 —— 必须 executed（ok|empty），不得 degraded（error|rate_limited）----
#   ★这条是"防同类复发"的类级判据（钉组别而非字面值）：C2 曾把 rate_limited 当作期望值，
#   于是一道本该拦住错误设计的门反过来为它背书。组别口径抄自主脚本 coverage 汇总处的注释，是权威定义。
try {
    $executedGroup = @('ok', 'empty')
    $degradedGroup = @('error', 'rate_limited')
    $violations = @()
    foreach ($budget in @('1', '2', '3')) {
        foreach ($mode in @('empty', '429')) {
            Reset-Stub $mode
            $env:MCPS_GITLAB_MAX_CALLS = $budget
            $r = @(Search-GitLabBlobs -Keyword 'x' -Limit 5)
            $st = (Get-BlobsState $r).Status
            # 429 走 catch 分支，本就应记 rate_limited（服务端限流）⇒ 只对非 429 场景施加本条
            if ($mode -eq 'empty' -and ($degradedGroup -contains $st)) { $violations += "budget=$budget/$mode status=$st（被误记进 degraded ⇒ Verdict 会落 none）" }
            if ($mode -eq 'empty' -and -not ($executedGroup -contains $st)) { $violations += "budget=$budget/$mode status=$st 不属 executed 组" }
        }
    }
    if ($violations.Count -gt 0) { $ok = $false; $fails += ("C6 " + ($violations -join ' | ')) }
    $lines += ("[C6] 6 个场景的状态组别违规数={0}" -f $violations.Count)
} catch { $ok = $false; $fails += "C6 exec: $($_.Exception.Message)" }

# ---- C7：429 文案配额语义 + TooLong 形状（B-5 负例锚点）----
#   ★C1 只查了 status 与调用数、没查文案 ⇒「文案退回检索失败」这条 B-5 负例在 C7 之前无门可拦。
#   变异锚点（供 Node 包装门 tests/test-gitlab-budget-ci.test.mjs 逐条打红）：
#     engines/search-gitlab.ps1 的 Add-EngineWarning 行：「限流 429：配额用尽」→「[GitLab] 检索失败」⇒ C7a 红
#     engines/search-gitlab.ps1 的 $is429 行退回只匹配 429 字面量 ⇒ C7c 红（TooLong 落成 error）
#     主脚本 Invoke-GitLabBlobDiscover 调用2 catch 去掉上抛 ⇒ C7b 红（429 又被吞成 empty）
try {
    [void]@(Get-EngineWarnings)   # 清空队列（C1 已入队一条），只看本轮
    # C7a：repo 引擎 429 ⇒ warning 带配额语义、不得退回通用「检索失败」
    Reset-Stub '429'
    [void]@(Search-GitLab -Keyword 'x' -Language '' -MinStars 0 -Limit 5)
    $w = (@(Get-EngineWarnings) -join "`n")
    if ($w -notmatch '配额') { $ok = $false; $fails += "C7a repo 429 warning 应含配额语义，实得 [$w]" }
    if ($w -match '检索失败') { $ok = $false; $fails += "C7a repo 429 warning 不得退回通用「检索失败」文案，实得 [$w]" }
    # C7b：blobs 引擎 429（默认预算 Cfg）⇒ rate_limited + reason 带配额语义
    Reset-Stub '429'
    Remove-Item Env:\MCPS_GITLAB_MAX_CALLS -ErrorAction SilentlyContinue
    $r = @(Search-GitLabBlobs -Keyword 'x' -Limit 5)
    $bst = (Get-BlobsState $r).Status
    $bReason = (Get-BlobsState $r).Reason
    if ($bst -ne 'rate_limited') { $ok = $false; $fails += "C7b blobs 429 状态应为 rate_limited，实得 '$bst'（吞进 empty 就是假文案）" }
    if ($bReason -notmatch '配额') { $ok = $false; $fails += "C7b blobs 429 reason 应含配额语义，实得 [$bReason]" }
    # C7c：TooLong 形状（Retry-After 超 MaxRetryWaitSec ⇒ 消息不含 429）两引擎同样归 rate_limited
    Reset-Stub 'toolong'
    [void]@(Search-GitLab -Keyword 'x' -Language '' -MinStars 0 -Limit 5)
    $rst = Get-EngineStatus -Name 'GitLab'
    $w2 = (@(Get-EngineWarnings) -join "`n")
    Reset-Stub 'toolong'
    $r = @(Search-GitLabBlobs -Keyword 'x' -Limit 5)
    $bst2 = (Get-BlobsState $r).Status
    if ($rst -ne 'rate_limited') { $ok = $false; $fails += "C7c repo TooLong 形状应归 rate_limited，实得 '$rst'" }
    if ($w2 -notmatch '配额') { $ok = $false; $fails += "C7c repo TooLong warning 应含配额语义，实得 [$w2]" }
    if ($bst2 -ne 'rate_limited') { $ok = $false; $fails += "C7c blobs TooLong 形状应归 rate_limited，实得 '$bst2'" }
    $lines += ("[C7] repo429 quota={0} generic={1} | blobs429 status={2} quota={3} | toolong repo={4} blobs={5}" -f ($w -match '配额'), ($w -match '检索失败'), $bst, ($bReason -match '配额'), $rst, $bst2)
} catch { $ok = $false; $fails += "C7 exec: $($_.Exception.Message)" }

# ---- C8：403（免费版全局搜索关闭）—— 预算必须留给回退路径，文案不许把没做的事说成做过 ----
#   ★来源（2026-10-19 实测 · 有 token · keyword=agent）：默认预算 2 被**注定 403** 的全局调用吃掉一半
#     ⇒ 回退路径结构性走不到 blobs ⇒ 免费版每条查询恒 0 命中；而 reason 却恒定写「已回退项目级但无命中」
#     —— 把没做的事说成做过（同族：budget-truncated / filtered / verify-0文件）。
#   判据：① 预算 2 时 blobs 必须真被调用（403 不消耗服务端配额 ⇒ 不计入预算）；
#         ② 预算 1 时 blobs 未调用 ⇒ 文案必须写「未执行」，**不得**写「无命中」。
try {
    Reset-Stub '403'
    $env:MCPS_GITLAB_MAX_CALLS = '2'
    $r = @(Search-GitLabBlobs -Keyword 'x' -Limit 5)
    $b2 = $script:blobSearchCalls
    if ($b2 -ne 1) { $ok = $false; $fails += "C8 预算 2 + 403 必须回退到逐项目 blobs（1 次），实得 $b2（403 吃了预算 ⇒ 结构性 0 命中）" }
    $st403 = (Get-BlobsState $r).Status
    if ($st403 -ne 'error') { $ok = $false; $fails += "C8 403 能力关闭必须记 error（P0-A），实得 '$st403'" }
    $rA = (Get-BlobsState $r).Reason
    if ($rA -notmatch '无命中') { $ok = $false; $fails += "C8 blobs 真跑过且 0 命中 ⇒ 文案应写「已回退项目级但无命中」，实得 [$rA]" }

    Reset-Stub '403'
    $env:MCPS_GITLAB_MAX_CALLS = '1'
    $r = @(Search-GitLabBlobs -Keyword 'x' -Limit 5)
    $rB = (Get-BlobsState $r).Reason
    $b1 = $script:blobSearchCalls
    if ($b1 -ne 0) { $ok = $false; $fails += "C8 预算 1 时不应发起 blobs，实得 $b1" }
    if ($rB -match '无命中') { $ok = $false; $fails += "C8 预算 1 时 blobs 未执行 ⇒ 文案不得写「无命中」（把没做的说成做过），实得 [$rB]" }
    if ($rB -notmatch '未执行') { $ok = $false; $fails += "C8 预算 1 时文案须写明「未执行」，实得 [$rB]" }
    $lines += ("[C8] 403 budget2 blobSearch={0} status={1} has无命中={2} | budget1 blobSearch={3} has未执行={4}" -f $b2, $st403, ($rA -match '无命中'), $b1, ($rB -match '未执行'))
} catch { $ok = $false; $fails += "C8 exec: $($_.Exception.Message)" }

# ---- C9：进程级记忆 —— 403 之后不得再探已知会失败的全局端点（省 1 次请求 / 一次往返）----
#   必要性：未认证配额 60 req/h，一条查询 2 次调用 ⇒ 记忆把可用查询数从 30 提到 60。
#   跨 runspace 生效靠 AppDomain（引擎跑在 Invoke-EnginePool 的新池里，$script: 变量不保留）。
try {
    Reset-Stub '403'
    $env:MCPS_GITLAB_MAX_CALLS = '2'
    $r = @(Search-GitLabBlobs -Keyword 'x' -Limit 5)
    $first = @($script:apiUris | Where-Object { $_ -match 'api/v4/search\?scope=blobs' }).Count
    Reset-Stub '403' -KeepMemo
    $r = @(Search-GitLabBlobs -Keyword 'x' -Limit 5)
    $second = @($script:apiUris | Where-Object { $_ -match 'api/v4/search\?scope=blobs' }).Count
    if ($first -ne 1) { $ok = $false; $fails += "C9 首次调用应探全局端点 1 次，实得 $first" }
    if ($second -ne 0) { $ok = $false; $fails += "C9 已记忆 403 后仍重复探全局端点（$second 次）⇒ 记忆未生效" }
    $lines += ("[C9] globalProbe first={0} second={1}" -f $first, $second)
} catch { $ok = $false; $fails += "C9 exec: $($_.Exception.Message)" }

# ---- C10：逐项目 blobs 的页大小必须跟随 -Limit（源码契约）----
#   由来（2026-10-19）：`Invoke-GitLabProjectBlobSearch` 的 URL 写死 `per_page=3`、结果再 `Select-Object -First 3`
#   ⇒ CLI 文档的「每源页大小」在回退路径上被静默忽略（-Limit 10 仍只回 3 条）。实测修复前后：3/3 → 3/10。
try {
    $mainSrc = [System.IO.File]::ReadAllText((Join-Path $SkillDir 'multi-platform-searcher.ps1'))

# v1.54.0（B3-2）：函数已搬进 lib/ ⇒ 静态文本断言要扫"主脚本 + lib/*.ps1"的合并文本。
$__libDir = Join-Path $SkillDir 'lib'
if (Test-Path -LiteralPath $__libDir -PathType Container) {
    foreach ($__lf in (Get-ChildItem -LiteralPath $__libDir -Filter '*.ps1' -File | Sort-Object Name)) {
        $mainSrc += ([string][char]10) + [System.IO.File]::ReadAllText($__lf.FullName)
    }
}

    $miss = @()
    # ★锚点必须钉在 GitLab 那一条 URL 上：Gitee 也有 `per_page=$PerPage`（L936），
    #   若只查全文出现过该串，变异臂把 GitLab 写回 3 时门仍绿（假门 —— 首版就是这么错的）。
    if ($mainSrc -notmatch 'gitlab\.com/api/v4/projects/\$ProjectId/search\?scope=blobs[^\r\n]*&per_page=\$PerPage') { $miss += 'GitLab 逐项目 URL 未用 $PerPage' }
    if ($mainSrc -notmatch 'Select-Object -First \$PerPage') { $miss += '结果未按 $PerPage 截断' }
    if ($mainSrc -notmatch 'AddArgument\(\[int\]\$perPage\)') { $miss += '未把 perPage 传进 runspace' }
    if ($miss.Count -gt 0) { $ok = $false; $fails += ("C10 " + ($miss -join '; ')) }
    $lines += ("[C10] perPageFollowsLimit={0}" -f ($miss.Count -eq 0))
} catch { $ok = $false; $fails += "C10 exec: $($_.Exception.Message)" }

# ---- C11：0 条 + 预算耗尽 ⇒ **empty**（不得 ok）----
#   由来（2026-10-20 全量验收 P0-2）：走"项目搜索有结果、逐项目 blobs 0 命中、预算已耗尽"这条路径时，
#   旧实现置 status=ok ⇒ 主脚本不生成 ReasonCode ⇒ 载荷是 `Verdict=full` + `Executed` 含本引擎 + 0 条
#   + Reasons 写着「部分路径未补全」——调用方无法区分「真没有」与「只搜了 2 个项目就没预算了」。
#   改后：empty（仍属 executed 组，不影响"全未执行判 none"），Reason 含「预算已用尽」⇒ 落 budget-truncated。
#   变异锚点：把 gitlab-blobs.ps1 的 `-Status 'empty'`（0 条 + BudgetHit 分支）改回 `-Status 'ok'` ⇒ 本条必红。
try {
    Reset-Stub 'empty'
    $env:MCPS_GITLAB_MAX_CALLS = '3'
    $r = @(Search-GitLabBlobs -Keyword 'x' -Limit 5)
    $st = (Get-BlobsState $r).Status
    $rs = (Get-BlobsState $r).Reason
    # ★不能写 `@($r.results)`：`$r` 是 `@(封套)`（单元素数组），成员枚举在"唯一元素的属性是空数组"时
    #   返回 `$null`，而 `@($null).Count` = **1** ⇒ 断言会假红成"实得 1 条"（踩过一次）。显式索引。
    if (@($r[0].results).Count -ne 0) { $ok = $false; $fails += "C11 该场景应 0 条，实得 $(@($r[0].results).Count)" }
    if ($st -ne 'empty') { $ok = $false; $fails += "C11 0 条 + 预算耗尽应为 empty，实得 '$st'（ok ⇒ Verdict=full 掩盖截断）" }
    if ($rs -notmatch '预算已用尽') { $ok = $false; $fails += "C11 reason 必须含「预算已用尽」（ReasonCodes 靠该串映射 budget-truncated），实得 '$rs'" }
    $lines += ("[C11] zero+budgetHit -> status={0} reasonHasBudgetWord={1}" -f $st, ($rs -match '预算已用尽'))
} catch { $ok = $false; $fails += "C11 exec: $($_.Exception.Message)" }

# ---- 还原 ----
Remove-Item Env:\MCPS_GITLAB_MAX_CALLS -ErrorAction SilentlyContinue
Set-Item function:Invoke-ApiRequest -Value $origApi.Value -Force
if ($origBlob) { Set-Item function:Invoke-GitLabProjectBlobSearch -Value $origBlob.Value -Force }

$lines | ForEach-Object { Write-Output $_ }
if ($ok) { Write-Output 'TEST_PASS test-gitlab-budget (11/11 offline)'; exit 0 }
Write-Output ("TEST_FAIL test-gitlab-budget: " + ($fails -join '; ')); exit 1
