# engines/github-code.ps1 —— 由 U-100 步骤 C 从 multi-platform-searcher.ps1 位移而来（2026-09-28）
#   只含函数定义，无顶层副作用；由主脚本 dot-source（注入链 (Get-Item "function:X").Definition 零改动）。
#   位移来源：主脚本 L1745–1809（65 行，权威 AST 口径）；body_sha256=c996036493e9455b557de98385637080e61117b79e6da3f3330b3205f0141bdf

function Search-GitHubCode {
    # U-192/U-198：RepoScope=归一化后的 owner/repo（GitHub `repo:` 限定符）；PathFilter ⇒ `path:`；匹配开关不支持（忽略）
    param($Keyword, $Limit, $Language, $RepoScope, $PathFilter, $MatchCase, $UseRegexp)
    Write-ColorOutput "正在 GitHub 代码搜索 (/search/code)..." "Cyan"
    $headers = Get-ApiHeaders -Token $env:GITHUB_TOKEN -Scheme "token"
    # v1.36.3（P1-7）：请求 text-match 媒体类型 ⇒ 返回 text_matches[].fragment，Preview 不再恒为 null（GitHub REST 官方支持）
    $headers['Accept'] = 'application/vnd.github.text-match+json'
    # v1.36.3（P1-7）：多取一些候选（上限 30），客户端把源码文件排到文档/文本之前后再截断到 $Limit
    $fetchN = [Math]::Min($script:Cfg.GhCodeOverfetchMax, [Math]::Max(([int]$Limit) * $script:Cfg.GhCodeOverfetchFactor, [int]$Limit))
    # U-197（2026-10-21）：-Language 走 GitHub 官方 language: 限定符（repo: 限定符已由同端点实测有效）。
    #   未给 ⇒ 查询串与旧版逐字节一致（负例）。
    $q = [string]$Keyword
    if (-not [string]::IsNullOrWhiteSpace($Language)) { $q = ('{0} language:{1}' -f $q, $Language) }
    # U-192（2026-10-21）：`repo:` 限定符（GitHub code search 官方支持）—— 这是"only 模式结果只来自指定仓库"的**第一道**约束；
    #   第二道在主流程（按仓库身份二次过滤，防上游忽略限定符）。path: 同理（U-198，含空格时加引号）。
    if (-not [string]::IsNullOrWhiteSpace($RepoScope)) { $q = ('{0} repo:{1}' -f $q, $RepoScope) }
    if (-not [string]::IsNullOrWhiteSpace($PathFilter)) {
        $pv = if ($PathFilter -match '\s') { '"' + $PathFilter + '"' } else { $PathFilter }
        $q = ('{0} path:{1}' -f $q, $pv)
    }
    $uri = "https://api.github.com/search/code?q=$([uri]::EscapeDataString($q))`&per_page=$fetchN"
    # v1.21.0 P0-1：GitHub 官方 code search API 强制认证（未认证必然 401 且限 10/min）。
    # 无 token 即声明 auth_missing，不再等请求失败才暴露（r2 实测：401 → 静默返回 0 命中）。
    if (-not $env:GITHUB_TOKEN) {
        Set-EngineStatus -Name 'GitHubCode' -Status 'auth_missing' -Reason '需要 GITHUB_TOKEN（code search API 强制认证，未认证返回 401）'
        Write-ColorOutput "GitHub 代码搜索需 GITHUB_TOKEN（未设置，跳过代码证据检索）" "DarkYellow"
        return @()
    }
    try {
        Wait-RateLimitToken -Bucket "github-code"   # U-43（N-20）：code search 桶 10/min（与 X-RateLimit-Limit 实测一致）
        # R4-F1（2026-10-04）：**必须显式传超时与尝试次数**，否则吃默认（15s × 3 = 最坏 45s）
        #   而 code 路径的引擎级截止只有 EngineDeadlineCodeSec(17s) ⇒ 一次抖动就以 deadline 死、重试来不及发生。
        #   取值保证 6×2+退避(≤2)=14s ≤ 17s（见 Cfg.CodeRequestTimeoutSec 注释与本批门的"重试预算"不变式）。
        $ghResp = Invoke-ApiRequest -Uri $uri -Headers $headers `
            -TimeoutSec $script:Cfg.CodeRequestTimeoutSec -MaxAttempts $script:Cfg.CodeRequestMaxAttempts
        # N-17（2026-09-26 容器调研）：GitHub `GET /search/code` 自 2026-03-27 起在响应头下发 `Deprecation` / `Sunset`
        # （实测报告：Sunset: Sun, 27 Sep 2026），官方替代口径未公布。这里把它变成**可见**告警（不阻断），到 Sunset 后若 410/404
        # 则由既有 error 路径 + grep.app / Sourcegraph 兜底承接。头名不区分大小写、PS5.1/PS7 头字典形态不同，统一 Get-HeaderValue。
        $ghSunset = Get-HeaderValue -Headers $ghResp.Headers -Name 'Sunset'
        $ghDeprecation = Get-HeaderValue -Headers $ghResp.Headers -Name 'Deprecation'
        if ($ghSunset -or $ghDeprecation) {
            Add-EngineWarning -Engine 'GitHubCode' -Message ("GitHub /search/code 已标记废弃：Deprecation={0} Sunset={1}（N-17：到期后可能 410，代码证据将依赖 grep.app/Sourcegraph 兜底）" -f $ghDeprecation, $ghSunset) -From 'response header' -To 'observe'
        }
        $data = $ghResp.Content | ConvertFrom-Json
        if (-not $data.items) {
            if ($data.message) { Write-ColorOutput "GitHub 代码搜索提示(可忽略): $($data.message)" "DarkYellow" }
            Set-EngineStatus -Name 'GitHubCode' -Status 'empty' -Reason 'API 返回空 items'
            return @()
        }
        $results = @(); $i = 1
        foreach ($item in $data.items) {
            $repo = if ($item.repository -and $item.repository.full_name) { $item.repository.full_name } else { $null }
            $frag = $null
            if ($item.text_matches -and @($item.text_matches).Count -gt 0) { $frag = $item.text_matches[0].fragment }
            $results += [PSCustomObject]@{ Index = $i; Platform = "GitHubCode"; Name = $repo; File = $item.path; Line = $null; Preview = $frag; Url = $item.html_url; Desc = $null }
            $i++
        }
        # v1.36.3（P1-7）：代码证据降噪——文档/纯文本/数据文件（.md/.txt/.rst/.adoc/.html/.json/.csv/.log 等）稳定后置；
        # 源码文件优先。只重排不丢弃：候选全是文档时仍如实返回（不伪造"无结果"）。
        $docExt = '\.(md|markdown|txt|rst|adoc|html?|json|ya?ml|csv|log|ipynb)$'
        $codeFirst = @($results | Where-Object { [string]$_.File -notmatch $docExt })
        $docLast = @($results | Where-Object { [string]$_.File -match $docExt })
        $results = @(@($codeFirst) + @($docLast) | Select-Object -First $Limit)
        $j = 1; foreach ($r in $results) { $r.Index = $j; $j++ }
        Set-EngineStatus -Name 'GitHubCode' -Status 'ok' -Reason '';
        if ($data.incomplete_results) {
            Write-ColorOutput "GitHub 代码搜索命中 $($results.Count) 条（incomplete_results，部分结果可能缺失）" "Yellow"
        } else {
            Write-ColorOutput "GitHub 代码搜索命中 $($results.Count) 条代码证据" "Green"
        }
        return $results
    }
    catch {
        # v1.63.0（U-281 实跑）：两个来源都要看 ——
        #   ① `"$_"` 在 PS 7 上可能是 **ErrorDetails（响应正文）**（实测：401 的正文是 `{"message":"Bad credentials"}`，
        #      里面既没有 "401" 也没有 "Unauthorized"），只按它判 ⇒ 诊断随运行时/响应体变化；
        #   ② `$_.Exception -is [System.Net.WebException]` 只在 PS 5.1 成立，PS 7 是 HttpResponseException
        #      ⇒ 同一句注释在跨平台给出**两种诊断**（auth_missing vs error），而这两者对调用方的指令完全不同。
        $msg = ((@($_.Exception.Message, "$_") | Where-Object { $_ } | Select-Object -Unique) -join ' | ')
        # v1.21.0 P0-1：区分 401（认证缺失/无效）与真错误——401 标 auth_missing，否则标 error
        $is401 = ($_.Exception -is [System.Net.WebException] -and $_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 401) -or ($msg -match '\b401\b|Unauthorized|未经授权')
        # U-177（2026-10-19）：403/429 限流此前落 error（"真失败"语义），与可恢复的配额耗尽混同。
        #   Invoke-ApiRequest 现在会在重试耗尽的消息里带 ', rate-limit' 标记 ⇒ 据此报 rate_limited。
        $isRl = $msg -match 'rate-limit|\b429\b|限流'
        if ($is401) { Set-EngineStatus -Name 'GitHubCode' -Status 'auth_missing' -Reason '收到 401：GITHUB_TOKEN 缺失或无效' }
        elseif ($isRl) { Set-EngineStatus -Name 'GitHubCode' -Status 'rate_limited' -Reason 'GitHub code search 限流（403/429 且重试已耗尽）：0 命中不可信，稍后重试或降低并发' }
        else { Set-EngineStatus -Name 'GitHubCode' -Status 'error' -Reason $_.Exception.Message }
        Write-ColorOutput "GitHub 代码搜索失败(可忽略): $_" "DarkYellow"
        return @()
    }
}
