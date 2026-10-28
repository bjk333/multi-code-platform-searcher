# engines/se-excerpts.ps1 —— SEExcerpts 代码证据引擎（社区实现证据）。
#   v1.39.0（2026-10-07 A 线归并批）：自 A 线（skillhub builtin-skills 侧）v1.36.0 引入、v1.38.0 修复端点后并入本侧。
#   语义：Stack Exchange /search/advanced（withbody）官方 API，匿名可用；产出"社区实现证据（问答片段）"，
#   **不是代码索引命中**（与 GitHubCode/GrepApp 等语义不同，references/引擎链.md 已显式标注）。
#   只含函数定义，无顶层副作用；由主脚本 dot-source（与 engines/ 其余文件同规）。
function Search-SEExcerpts {
    param($Keyword, $Limit, $Language, $RepoScope, $PathFilter, $MatchCase, $UseRegexp)   # U-197：Stack Exchange 搜索无语言过滤参数 ⇒ 接受但忽略（由调用方告警）；U-192：问答片段无仓库概念，只作全局补充
    $site = if ($env:MCPS_SE_SITE) { $env:MCPS_SE_SITE } else { 'stackoverflow' }
    Write-ColorOutput "正在 Stack Exchange 检索社区实现证据（excerpts, site=$site）..." "Cyan"
    $results = @(); $i = 1
    try {
        $q = [uri]::EscapeDataString($Keyword)
        # 端点用 /search/advanced + withbody：/search/excerpts 的 excerpt 字段含 <span class="highlight">
        # 这类 HTML 属性引号，PS 5.1 的 ConvertFrom-Json 在该负载上稳定报 "传入的对象无效 (3315)"
        # （同一响应 curl/Python 解析正常 ⇒ 本宿主解析器缺陷，非服务端问题；A 线 v1.38.0 实测后换端点）。
        $uri = "https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=$q&site=$site&pagesize=$Limit&filter=withbody"
        if ($env:SE_KEY) { $uri += "&key=$([uri]::EscapeDataString($env:SE_KEY))" }
        $ua = @{"User-Agent" = "multi-code-platform-searcher/$VERSION"}
        # v1.39.0：请求预算对齐 code 通路约定（grep-app 同款：显式 超时×尝试次数，满足
        #   CodeRequestTimeoutSec×CodeRequestMaxAttempts+退避 ≤ EngineDeadlineCodeSec；R4-F1 门守护"不许吃默认"。
        #   SE pagesize≤10 实测秒级响应，6s×2 足够；真超时按既有降级语义标 error/deadline 并写 warning）。
        $data = (Invoke-ApiRequest -Uri $uri -Headers $ua -TimeoutSec $script:Cfg.CodeRequestTimeoutSec -MaxAttempts $script:Cfg.CodeRequestMaxAttempts).Content | ConvertFrom-Json
        $items = @($data.items)
        if ($items.Count -eq 0) {
            Write-ColorOutput "Stack Exchange(excerpts) 检索成功但 0 命中" "DarkYellow"
            Set-EngineStatus -Name 'SEExcerpts' -Status 'empty' -Reason '检索成功但 0 命中'
            return @()
        }
        foreach ($item in $items) {
            # 正文/标题清洗：去标签 + 反转义常见实体（保留代码符号可读性），压空白后截断
            # （A 线 v1.36.0 修复：标题同样含 HTML 实体，如 "Can&#39;t resolve ..." —— 只清正文会漏）
            $body = [string]$item.body
            $body = $body -replace '(?s)<[^>]+>', ' '
            $body = $body -replace '&lt;', '<' -replace '&gt;', '>' -replace '&quot;', '"' -replace '&#39;', "'" -replace '&amp;', '&'
            $body = ($body -replace '\s+', ' ').Trim()
            $preview = if ($body.Length -gt $script:Cfg.PreviewLen) { $body.Substring(0, $script:Cfg.PreviewLen) + '…' } else { $body }
            $title = [string]$item.title
            $title = $title -replace '&lt;', '<' -replace '&gt;', '>' -replace '&quot;', '"' -replace '&#39;', "'" -replace '&amp;', '&'
            $qid = [string]$item.question_id
            $file = "q$qid"    # search/advanced 为"问题级"结果（无 item_type/item_id）
            $score = if ($null -ne $item.score) { [int]$item.score } else { 0 }
            $ans = if ($null -ne $item.answer_count) { [int]$item.answer_count } else { 0 }
            $results += [PSCustomObject]@{
                Index    = $i
                Platform = "SEExcerpts"   # ★与 A 线分歧（必要）：B 的 catalog 门禁止别名冲突（SE 研究引擎已占 StackExchange），
                                          #   本侧用自有展示名；语义仍是"Stack Exchange 社区实现证据"（见引擎链.md 名↔Platform 表）。
                Name     = $title
                File     = $file
                Url      = [string]$item.link
                Desc     = ("score: {0}; answers: {1}; tags: {2}" -f $score, $ans, (@($item.tags) -join ', '))
                Preview  = $preview
                Line     = $null
            }
            $i++
        }
        Write-ColorOutput "Stack Exchange(excerpts) 命中 $($results.Count) 条社区实现证据" "Green"
        Set-EngineStatus -Name 'SEExcerpts' -Status 'ok' -Reason ''
        return $results
    }
    catch {
        $msg = $_.Exception.Message
        # U-274（B3-3 行为层首跑抓到）：判据原为 '429|Too Many Requests|rate.?limit|throttl'，
        #   而产品在 **Retry-After 超上限** 时抛的是自己的文案「限流等待过长: …」——不含 429 也不含 rate limit
        #   ⇒ 真限流被判成 error（用户去查网络，而该做的是等或配 SE_KEY）。
        #   OpenAlex 的 catch 早已补上这一句（同型缺陷 2026-10-09 修过），SE 这边漏了。
        $isRateLimited = $msg -match '429|Too Many Requests|rate.?limit|throttl|限流等待过长'
        if ($isRateLimited) {
            Set-EngineStatus -Name 'SEExcerpts' -Status 'rate_limited' -Reason 'Stack Exchange 限流（匿名 300 req/天），稍后重试或配置 SE_KEY'
            Add-EngineWarning -Engine 'SEExcerpts' -Message 'Stack Exchange 匿名配额受限，本次跳过' -From 'api.stackexchange.com' -To 'skip (rate_limited)'
        }
        else {
            Set-EngineStatus -Name 'SEExcerpts' -Status 'error' -Reason $msg
            Add-EngineWarning -Engine 'SEExcerpts' -Message "Stack Exchange(excerpts) 检索失败: $msg" -From 'api.stackexchange.com' -To 'skip'
        }
        Write-ColorOutput "Stack Exchange(excerpts) 检索失败(可忽略): $_" "DarkYellow"
        return @()
    }
}
