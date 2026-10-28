# engines/github.ps1 —— 由 U-100 步骤 C 从 multi-platform-searcher.ps1 位移而来（2026-09-28）
#   只含函数定义，无顶层副作用；由主脚本 dot-source（注入链 (Get-Item "function:X").Definition 零改动）。
#   位移来源：主脚本 L1539–1643（105 行，权威 AST 口径）；body_sha256=558274efee0ea79f456fe414bd6c7ff344f60600cf779d557650ba43d884e6b2


function Search-GitHub {
    param($Keyword, $Language, $MinStars, $Limit)
    Write-ColorOutput "正在 GitHub 搜索..." "Cyan"
    # ★B2-1（U-263）：已迁 EngineContract v1 —— 返回封套、不自报 status（判定归池侧 Resolve-EngineVerdict）
    $t0 = [DateTime]::UtcNow
    $headers = Get-ApiHeaders -Token $env:GITHUB_TOKEN -Scheme "token"
    # 缓存键与主流程 L708 保持一致，供 4.2 陈旧缓存兜底
    $cacheKey = "repo#GitHub#$Keyword#$Language#$MinStars#$Limit"
    $req = @{ attempted = 0; succeeded = 0; failed = 0 }
    $quota = @{ class = $(if ($env:GITHUB_TOKEN) { 'authenticated' } else { 'anonymous' }); limit = $null; remaining = $null; resetAt = $null }

    # 4.1 查询松弛候选（按收敛度降序：先原查询，再依次去 stars 门槛 → 去语言 → 多词 OR 放宽）
    $variants = @( @{ q = $Keyword; lang = $Language; stars = $MinStars; relaxed = $false } )
    if ($MinStars -gt 0) {
        $variants += @{ q = $Keyword; lang = $Language; stars = 0; relaxed = "drop-stars" }
    }
    if ($Language) {
        $variants += @{ q = $Keyword; lang = $null; stars = 0; relaxed = "drop-language" }
    }
    $words = @($Keyword -split '\s+' | Where-Object { $_ -and $_.Length -ge 2 })
    if ($words.Count -ge 2) {
        $variants += @{ q = ($words -join ' OR '); lang = $null; stars = 0; relaxed = "or-words" }
    }

    $gotResponse = $false
    $lastErr = $null
    # v1.36.0：认证失败必须显式记账（失效令牌曾走完全部变体后返回空数组 ⇒ 被当成可信的"0 命中"）
    $authFail = $null
    foreach ($v in $variants) {
        # 4.2 令牌桶：每次搜索请求前获取令牌，避免突发 429
        Wait-RateLimitToken -Bucket "github-search"
        $q = $v.q
        if ($v.lang) { $q += " language:$($v.lang)" }
        if ($v.stars -gt 0) { $q += " stars:>$($v.stars)" }
        $uri = "https://api.github.com/search/repositories?q=$([uri]::EscapeDataString($q))`&sort=stars`&order=desc`&per_page=$Limit"
        try {
            $req.attempted++
            $data = (Invoke-ApiRequest -Uri $uri -Headers $headers).Content | ConvertFrom-Json
            $req.succeeded++
            $gotResponse = $true
            if ($data.total_count -gt 0) {
                $results = @(); $i = 1
                foreach ($item in $data.items) {
                    # v1.46.7：Archived 三态（true/false/**null=该源未提供**）—— 缺失不写 false，否则"没给"与"未归档"混为一谈
                    $results += [PSCustomObject]@{ Index = $i; Platform = "GitHub"; Name = $item.full_name; Stars = $item.stargazers_count; Unit = 'stars'; Url = $item.html_url; Desc = $item.description; License = $item.license.spdx_id; Updated = $item.updated_at; Archived = $(if ($null -ne $item.archived) { [bool]$item.archived } else { $null }); Relaxed = $(if ($v.relaxed) { $v.relaxed } else { $false }) }
                    $i++
                }
                if ($v.relaxed) {
                    Write-ColorOutput "GitHub 原始查询 0 结果，已松弛为策略 [$($v.relaxed)] 找到 $($data.total_count) 个" "Yellow"
                } else {
                    Write-ColorOutput "GitHub 找到 $($data.total_count) 个结果（显示前 $Limit）" "Green"
                }
                return New-EngineEnvelope -Engine 'GitHub' -Kind 'repo' -Results $results -Requests $req -Quota $quota -StartedAt $t0
            }
            # 0 结果：尝试下一个松弛变体
        }
        catch {
            $lastErr = $_; $req.failed++
            # v1.36.0：认证/权限失败显式记账，供末尾统一上报（此处不 return，保留陈旧缓存兜底）
            $msg = "$($_.Exception.Message)"
            try {
                if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
                    $sc = [int]$_.Exception.Response.StatusCode
                    # U-178（2026-10-19）：**不再覆盖原文** —— 原文可能带 U-177 的 ', rate-limit' 标记
                    #   （旧写法 $msg = '403 禁止' 会把"配额耗尽"抹成"权限不足"，与 U-177 恰好相反方向的谎）。
                    if ($sc -eq 401) { $msg = "401 未经授权: $msg" }
                    elseif ($sc -eq 403) { $msg = "403 禁止: $msg" }
                }
            } catch { }
            if ($msg -match 'rate-limit|API rate limit exceeded|secondary rate limit') { $authFail = 'ratelimit' }   # U-178：限流必须先判，否则 403 一律落 forbidden（能力问题）
            elseif ($msg -match '未经授权|Unauthorized|\b401\b') { $authFail = 'auth' }
            elseif ($msg -match '禁止|Forbidden|\b403\b') { $authFail = 'forbidden' }
            # 4.2 陈旧缓存兜底：实时检索从未成功（被限流/网络失败），返回近 TTL 缓存而非空结果
            if (-not $gotResponse) {
                $fb = @(Get-GitHubStaleFallback -CacheKey $cacheKey)
                if ($fb.Count -gt 0) { return New-EngineEnvelope -Engine 'GitHub' -Kind 'repo' -Results $fb -Requests $req -Quota $quota -StartedAt $t0 }
            }
            continue
        }
    }
    # v1.36.0/U-178：把三类认证失败映射成 **failure 事实**，判定归 L1：
    #   missing-credential ⇒ auth_missing、rate-limited ⇒ rate_limited、forbidden ⇒ error（原样保留 U-178 的三分）。
    #   ★映射收进表里而不是 if/elseif 链：本函数已顶在 U-163 的 100 行红线上，链条每加一档就多 2 行。
    $failMap = @{
        auth      = @{ code = 'missing-credential'; warn = "认证失败(401)：GITHUB_TOKEN 无效/过期，0 命中不可信。请检查技能 .env 或用户环境变量。" }
        ratelimit = @{ code = 'rate-limited'; warn = "限流(403/429)：0 命中不可信（配额耗尽，非权限问题）。" }
        forbidden = @{ code = 'forbidden'; warn = "权限不足(403)：0 命中不可信；请检查 token scope。" }
    }
    if ($authFail -and $failMap.ContainsKey($authFail)) {
        $failure = @{ reasonCode = $failMap[$authFail].code; reason = $failMap[$authFail].warn }
        Add-EngineWarning -Engine 'GitHub' -Message $failMap[$authFail].warn
    } elseif (-not $gotResponse) {
        $failure = @{ reasonCode = 'error'; reason = "检索失败: $lastErr" }
        Add-EngineWarning -Engine 'GitHub' -Message "检索失败：$lastErr"
    }
    # `$gotResponse` 且无认证失败 ⇒ 0 命中：**不设 failure**（L1 派生 empty/zero-hit，"搜了没结果"是成功）
    Write-ColorOutput "GitHub 所有查询变体均无结果/失败: $lastErr" "Yellow"
    return New-EngineEnvelope -Engine 'GitHub' -Kind 'repo' -Results @() -Requests $req -Quota $quota -Failure $failure -StartedAt $t0
}
