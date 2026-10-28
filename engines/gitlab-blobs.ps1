# engines/gitlab-blobs.ps1 —— 由 U-100 步骤 C 从 multi-platform-searcher.ps1 位移而来（2026-09-28）
#   只含函数定义，无顶层副作用；由主脚本 dot-source（注入链 (Get-Item "function:X").Definition 零改动）。
#   位移来源：主脚本 L1564–1689（126 行，权威 AST 口径）；body_sha256=e1f33441cdb02cdfe93ef55ffc10afae882497aade3da0b6df467751e4bae12a（搬迁时原始 body 哈希；U-155 仅将逐域路由状态注入嵌套池，当前 body 已变化）
#
# ★批次1动作2（2026-10-09）：**单查询调用预算**。此前本函数最坏情形会发 18 次请求/查询
#   （全局 blobs 1 + projects?search 1 + 逐项目 blobs ≤8 + 逐项目路径 GET ≤8），
#   而 GitLab 自 10-19 起未认证 = 60 req/h/IP（约 500 倍砍）⇒ 约 3 次查询即耗尽。
#   现按 $script:Cfg.GitLabMaxCallsPerQuery（默认 4，v1.45.2 由 2 上调）硬封顶，超额时**显式降级**、不静默丢结果。
#
# ★批次3拆分（2026-10-10）：本函数曾涨到 138 行，触红 U-163-5（engines/ 里任何 >100 行都直接红；
#   U-167 早已把本函数从 126 行拆到 ≤100，批次1 的改动属**回潮**）。现按内聚块拆为三个函数，行为逐行等价。
#   ★拆出的 Invoke-GitLabBlobDiscover / ConvertTo-GitLabBlobResults **定义在主脚本**，不在这里——
#   因为 Needs 里登记的函数必须在主脚本有实现（U-157 C 门的既有约定，理由见主脚本 U-167 注释段），
#   否则 Runspace 池注入取不到定义 ⇒ CommandNotFound 被 catch 吞成静默 0 命中（U-41 同型）。
#   本文件只保留各平台**薄适配器**（与 U-167 定下的「主脚本 = 可注入库」一致）。
#   共享可变状态走引用对象 $St 的属性：PS 参数按值传，[int]/[bool] 直接赋值传不出调用方。

function Search-GitLabBlobs {
    param($Keyword, $Limit, $Language, $RepoScope, $PathFilter, $MatchCase, $UseRegexp)   # U-197：GitLab blobs 无语言过滤参数 ⇒ 接受但忽略（由调用方告警，不静默）；U-192：仓库级靠 GitLabBlobs 自身的项目搜索，未接 -RepoScope
    # ★B2-1（U-265）：已迁 EngineContract v1 —— 返回封套、不自报 status（判定归池侧 Resolve-EngineVerdict）。
    #   `requests` **不由本函数数**：它从 B2-6 的账本按 engine 聚合（理由见 Get-ApiRequestLedgerByEngine 头注）——
    #   本引擎的请求散在 4 个辅助函数 + 一个嵌套 runspace 池里，逐点手写必然有漏。
    $t0 = [DateTime]::UtcNow
    # 账本归属兜底：池包装块 / Invoke-EngineSerial 会设；夹具与 -Serve 合并期可能没设 ⇒ 自己补上
    #   （这是**准确**赋值而非猜：本函数就是 GitLabBlobs 的执行体。没设的后果是 requests 恒 0/0/0 的假零）。
    try { if (-not $script:_ledgerEngine) { $script:_ledgerEngine = 'GitLabBlobs'; $script:_ledgerMode = 'code' } } catch { }
    $quota = @{ class = $(if ($env:GITLAB_TOKEN) { 'token' } else { 'none' }); limit = $null; remaining = $null; resetAt = $null }
    if (-not $env:GITLAB_TOKEN) {
        # v1.21.0 P0-1：缺 token 即声明 auth_missing（不再静默跳过）。此处**零请求** ⇒ 不传 -Requests（默认 0/0/0）。
        Write-ColorOutput "GitLab 代码搜索需 GITLAB_TOKEN（未设置，跳过）" "DarkYellow"
        return New-EngineEnvelope -Engine 'GitLabBlobs' -Kind 'code' -Quota $quota -StartedAt $t0 `
            -Failure @{ reasonCode = 'missing-credential'; reason = '需要 GITLAB_TOKEN（GitLab blobs 搜索要求认证）；未配置时本引擎不参与 code 检索' }
    }
    # v1.25.0：GitLab 官方推荐 PRIVATE-TOKEN 头（Bearer 亦可，但 PRIVATE-TOKEN 最规范）
    $headers = Get-ApiHeaders -Token $env:GITLAB_TOKEN -Scheme "PrivateToken"
    # 默认取 Cfg（单源）；取不到时兜底 4（与 Cfg.GitLabMaxCallsPerQuery 同值，防注入链未带 Cfg 时退回旧值）。
    #   ★v1.45.2（2026-10-20）：2 → 4。实测默认 2 在回退路径下只够「403 + 一次项目搜索」或「一次 blobs」，
    #   项目搜索命中多个项目时必然 0 产出（keyword=agent：预算 2 ⇒ 0 条，预算 4 ⇒ 2 条）。
    $maxCalls = 4
    try { if ($script:Cfg -and $script:Cfg.GitLabMaxCallsPerQuery) { $maxCalls = [int]$script:Cfg.GitLabMaxCallsPerQuery } } catch { }
    if ($env:MCPS_GITLAB_MAX_CALLS) { try { $maxCalls = [int]$env:MCPS_GITLAB_MAX_CALLS } catch { } }
    if ($maxCalls -lt 1) { $maxCalls = 1 }
    # 调用预算 + 回退标志 + 项目路径缓存，三者在两个子函数间共享 ⇒ 走引用对象（PS 参数按值传）。
    $st = [PSCustomObject]@{ Calls = 0; BudgetHit = $false; UsedFallback = $false; ProjCache = @{}; Forbidden = $false; ProjCount = 0; BlobsSearched = $false }
    try {
        # v1.46.9（T1-3）：`-RepoScope` 指向 GitLab 项目 ⇒ 直接项目级检索（1 次请求），不走"全局→项目搜索→逐项目"发现链。
        #   失败不在这里另判，交给下方 catch 按 401/429/其它统一分类。
        if (-not [string]::IsNullOrWhiteSpace($RepoScope)) {
            $rs = @(Invoke-GitLabRepoScopedBlobs -Keyword $Keyword -Limit $Limit -Headers $headers -RepoSlug $RepoScope)
            # 零命中的上下文（"仓库级"）走 warnings：verdict 的 zero-hit 文案是通用的，这里补的是"查的是哪个仓库"。
            if ($rs.Count -eq 0) { Add-EngineWarning -Engine 'GitLabBlobs' -Message ("仓库级检索（{0}）：项目内无命中" -f $RepoScope) -From 'engine' -To 'zero-hit' }
            return New-EngineEnvelope -Engine 'GitLabBlobs' -Kind 'code' -Results $rs -Requests (Get-ApiRequestLedgerByEngine -Engine 'GitLabBlobs') -Quota $quota -StartedAt $t0
        }
        $data = Invoke-GitLabBlobDiscover -Keyword $Keyword -Limit $Limit -Headers $headers -MaxCalls $maxCalls -St $st
        # 空结果三档（Forbidden > BudgetHit > UsedFallback/空）：状态文案按**实际进度**说，不把没做的事说成做过。
        #   ★2026-10-19 旧文案恒定写「已回退项目级但无命中」—— 实测有 token 时预算在项目搜索后即耗尽 ⇒ blobs 一次未发。
        $why = ''
        $code = $null
        if (-not $data -or @($data).Count -eq 0) {
            if ($st.Forbidden) {
                # 2026-10-18（P0-A）：**优先于预算** —— 403 是能力关闭，报成预算等于把失效说成节制。
                $why = if ($st.BlobsSearched) { '已回退项目级但无命中' }
                    elseif ($st.ProjCount -gt 0) { ("项目级 blobs **未执行**（调用预算 {0}/{1} 已耗尽；项目搜索命中 {2} 个项目但未检索其代码）" -f $st.Calls, $maxCalls, $st.ProjCount) }
                    else { '项目级回退也未命中项目（projects?search 返回 0 条），未发起 blobs 检索' }
                $why = "403：GitLab 全局搜索对该账号层级已关闭（Global Search is disabled for this scope；非限流、非自设预算）。$why"
                $code = 'forbidden'
            } elseif ($st.BudgetHit) {
                # 批次1动作2/3：预算耗尽**是我们主动放弃**，不是服务端拒绝 ⇒ 判 empty（执行了、无命中），
                #   不判 error。判 error 会让它落 Degraded ⇒ 从 coverage 的 executed 组掉出 ⇒ Verdict 可能落
                #   none（"请求了引擎但全未执行"），那是 U-158E A-2 实测抓到的那个谎。
                $why = ("GitLab 调用预算已用尽（{0}/{1} 次，自设封顶非服务端 429）：跳过后续项目级 blobs，避免 10-19 起 60 req/h/IP 配额耗尽。可用 MCPS_GITLAB_MAX_CALLS 调高" -f $st.Calls, $maxCalls)
                $code = 'budget-truncated'
            } elseif ($st.UsedFallback) { $why = '项目级回退：未搜到匹配项目或项目内无命中' }
            else { $why = 'API 返回空' }
            if (-not $code) { Add-EngineWarning -Engine 'GitLabBlobs' -Message $why -From 'engine' -To 'zero-hit' }
            return New-EngineEnvelope -Engine 'GitLabBlobs' -Kind 'code' -Requests (Get-ApiRequestLedgerByEngine -Engine 'GitLabBlobs') -Quota $quota -StartedAt $t0 `
                -Failure $(if ($code) { @{ reasonCode = $code; reason = $why } } else { $null })
        }
        $results = @(ConvertTo-GitLabBlobResults -Data $data -Headers $headers -MaxCalls $maxCalls -St $st)
        $failure = $null
        if ($st.Forbidden) {
            # 有产出 + 全局 403 ⇒ degraded（保留首因）：结果来自项目级回退，"全局搜索不可用"这件事必须留痕
            $failure = @{ reasonCode = 'forbidden'; reason = '全局搜索 403：该账号层级已关闭（非限流、非自设预算）；结果来自项目级回退' }
        }
        if ($st.BudgetHit) {
            # v1.45.2（2026-10-20 全量验收 P0-2）：文案沿用「预算已用尽」形状 —— 旧文案「调用预算 2/2 次已用尽」
            #   中间夹着数字 ⇒ 正则不匹配 ⇒ 归 zero-hit，把"我们主动截断"说成"库里没有"。
            $note = ("调用预算已用尽（{0}/{1} 次），部分路径未补全（自设封顶非服务端 429；MCPS_GITLAB_MAX_CALLS 可调高）" -f $st.Calls, $maxCalls)
            if ($failure) { $failure = @{ reasonCode = $failure.reasonCode; reason = ($failure.reason + '；' + $note) } }
            else { $failure = @{ reasonCode = 'budget-truncated'; reason = $note } }
        }
        Write-ColorOutput "GitLab 代码搜索命中 $($results.Count) 条代码证据$(if ($st.UsedFallback) { '（项目级）' } else { '' })$(if ($st.BudgetHit) { "（调用 $($st.Calls)/$maxCalls 已达预算）" } else { '' })" "Green"
        return New-EngineEnvelope -Engine 'GitLabBlobs' -Kind 'code' -Results $results -Requests (Get-ApiRequestLedgerByEngine -Engine 'GitLabBlobs') -Quota $quota -Failure $failure -StartedAt $t0
    }
    catch {
        # v1.21.0：401 → 缺凭据，其余 → error。分类收进表（本函数顶在 U-163 的 100 行红线上）。
        # ★429 分支曾**实际不可达**（Discover 两级 catch 全吞成 empty + 假文案，2026-10-11 探针实证）—— 已修。
        # ★v1.64.0（U-282 实跑）：`"$_"` 在 PS 7 上是 **ErrorDetails（响应正文）**；线上 401 正文恰好含 "401" 故旧写法"碰巧"对，换个措辞就丢状态码 ⇒ 两源都收。
        $m = ((@($_.Exception.Message, "$_") | Where-Object { $_ } | Select-Object -Unique) -join ' | ')
        # ★U-265：401 判据原来只认 `[System.Net.WebException]`（PS7 重抛 HttpResponseException ⇒ 恒 false ⇒ 退化成 error）⇒ 补消息判据，类型判据留着兼容 PS5.1。
        $is401 = ($_.Exception -is [System.Net.WebException] -and $_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 401) -or ($m -match '\b401\b|Unauthorized|未经授权')
        # ★表的键是**名字**不是 scriptblock：scriptblock 当键会走 ToString()，`& $k` 也拿不到原块。
        #   判据放 `on` 字段 ⇒ 顺序仍是 ordered 的插入顺序（先 401 后 429）。
        $is429 = ("$_") -match '\b429\b|限流等待过长'
        if (-not $is429) { $is429 = ("$_") -match 'rate-limit' }   # U-177：403+配额耗尽在重试耗尽后走这条（另起一行，保住 M4 夹具的原文锚点）
        $failMap = [ordered]@{
            'auth' = @{ on = $is401; code = 'missing-credential'; reason = '收到 401：GITLAB_TOKEN 缺失或无效' }
            'rl'   = @{ on = $is429; code = 'rate-limited'; reason = 'GitLab 限流 429：配额用尽（10-19 起未认证 60 req/h/IP；Free 认证 5,000/h，burst 100/min）。建议设置 GITLAB_TOKEN 或降低查询频率' }
        }
        $failure = @{ reasonCode = 'error'; reason = $m }
        foreach ($k in $failMap.Keys) { if ($failMap[$k].on) { $failure = @{ reasonCode = $failMap[$k].code; reason = $failMap[$k].reason }; break } }
        Write-ColorOutput "GitLab 代码搜索失败(可忽略): $m" "DarkYellow"
        Add-EngineWarning -Engine 'GitLabBlobs' -Message ("[GitLabBlobs] " + $failure.reason) -From 'engine' -To $failure.reasonCode
        return New-EngineEnvelope -Engine 'GitLabBlobs' -Kind 'code' -Requests (Get-ApiRequestLedgerByEngine -Engine 'GitLabBlobs') -Quota $quota -Failure $failure -StartedAt $t0
    }
}
