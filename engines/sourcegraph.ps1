# engines/sourcegraph.ps1 —— 由 U-100 步骤 C 从 multi-platform-searcher.ps1 位移而来（2026-09-28）
#   只含函数定义，无顶层副作用；由主脚本 dot-source（注入链 (Get-Item "function:X").Definition 零改动）。
#   位移来源：主脚本 L1648–1699（52 行，权威 AST 口径）；body_sha256=fc43901b1f6ddd9b72737ce6c29cc1ffb37bb04f64acef0e43002e6eb421c01d

function Search-Sourcegraph {
    param($Keyword, $Limit, $Language, $RepoScope, $PathFilter, $MatchCase, $UseRegexp)
    Write-ColorOutput "正在 Sourcegraph 检索代码实现证据 (streaming)..." "Cyan"
    # v1.23.0：官方 streaming 端点 + context:global（公共代码默认上下文）；display 控制返回条数
    # U-197（2026-10-21）：Sourcegraph 查询语法支持 lang: 过滤器；未给 ⇒ 查询串与旧版一致。
    $sgQ = "context:global $Keyword"
    if (-not [string]::IsNullOrWhiteSpace($Language)) { $sgQ = "$sgQ lang:$Language" }
    # U-192（2026-10-21）：Sourcegraph 的 repo 过滤器是**正则**且按 `host/owner/repo` 全名匹配 ⇒ 用 `$` 锚定后缀。
    #   path 过滤器同样是正则（`file:` / `path:` 均可），这里用 `path:` 与 GitHub 口径对齐。
    if (-not [string]::IsNullOrWhiteSpace($RepoScope)) { $sgQ = ('{0} repo:{1}$' -f $sgQ, ($RepoScope -replace '([.\\^$+?()\[\]{}|])', '\$1')) }
    if (-not [string]::IsNullOrWhiteSpace($PathFilter)) { $sgQ = ('{0} path:{1}' -f $sgQ, ($PathFilter -replace '([.\\^$+?()\[\]{}|])', '\$1')) }
    $uri = "https://sourcegraph.com/.api/search/stream?q=$([uri]::EscapeDataString($sgQ))`&v=V3`&t=`&display=$Limit"
    $headers = Get-ApiHeaders -Token $env:SRC_TOKEN -Scheme "token"
    try {
        $text = [string](Invoke-ApiRequest -Uri $uri -Headers $headers -TimeoutSec $script:Cfg.CodeRequestTimeoutSec -MaxAttempts $script:Cfg.CodeRequestMaxAttempts).Content
        $results = @(); $i = 1
        # SSE 解析：逐个 event 块（event: X\n\ndata: Y\n\n），只消费 matches 事件的 data（JSON 数组）
        foreach ($block in [regex]::Matches($text, 'event: (\w+)\r?\ndata: ([^\r\n]+)')) {
            if ($block.Groups[1].Value -ne 'matches') { continue }
            $items = $null
            try { $items = $block.Groups[2].Value | ConvertFrom-Json } catch { continue }
            foreach ($r in @($items)) {
                if ($i -gt $Limit) { break }
                # content 类型才有代码命中（path/lineMatches）；symbol/path 等其他类型跳过
                if ($r.type -ne 'content' -or -not $r.lineMatches -or -not $r.lineMatches[0]) { continue }
                $lm = $r.lineMatches[0]
                $repo = [string]$r.repository
                $file = [string]$r.path
                $srcUrl = "https://sourcegraph.com/$repo/-/blob/$file`#L$($lm.lineNumber)"
                $results += [PSCustomObject]@{ Index = $i; Platform = "Sourcegraph"; Name = $repo; File = $file; Line = $lm.lineNumber; Preview = if ($lm.line) { $lm.line } else { $null }; Url = $srcUrl; Desc = $null }
                $i++
            }
        }
        if ($results.Count -gt 0) {
            Write-ColorOutput "Sourcegraph 命中 $($results.Count) 条代码证据" "Green"
            Set-EngineStatus -Name 'Sourcegraph' -Status 'ok' -Reason ''
        }
        else {
            Write-ColorOutput "Sourcegraph 检索成功但 0 命中" "DarkYellow"
            Set-EngineStatus -Name 'Sourcegraph' -Status 'empty' -Reason '检索成功但 0 命中'
        }
        return $results
    }
    catch {
        # v1.63.0（U-281 实跑）：`"$_"` 在 PS 7 上取到的是 **ErrorDetails（响应正文）**，不是异常消息。
        #   403 + "Firewall Block" 正文时 `$msg` 里根本没有 "403" ⇒ 三档归因全部落空、退化成通用 error，
        #   而这三档正是"换令牌 / 换网络 / 重试"的唯一判据。两个来源都收：**状态码在异常消息里，业务提示在正文里**。
        $msg = ((@($_.Exception.Message, "$_") | Where-Object { $_ } | Select-Object -Unique) -join ' | ')
        # v1.23.0：429 判为 rate_limited（可恢复降级）
        $isRateLimited = $msg -match '429|Too Many Requests|rate.?limit|限流等待过长'
        if ($isRateLimited) {
            Set-EngineStatus -Name 'Sourcegraph' -Status 'rate_limited' -Reason 'Sourcegraph 限流，稍后重试'
            Add-EngineWarning -Engine 'Sourcegraph' -Message 'Sourcegraph 限流，本次跳过' -From 'streaming API' -To 'skip (rate_limited)'
        }
        elseif ($msg -match '\b403\b|Forbidden') {
            # v1.46.0（2026-10-20 实测）：403 必须分档。此前一律 error ⇒ ReasonCode=forbidden，
            #   把「出口 IP 被 sourcegraph.com 边缘防火墙拦（正文 "Firewall Block"，17.6KB HTML）」说成
            #   「账号能力关闭」⇒ Agent 会去换令牌，实际换什么都没用。
            $fwBody = ''
            try {
                $f = [System.AppDomain]::CurrentDomain.GetData('mcps_last_403')
                if ($f -and [string]$f.Uri -match 'sourcegraph\.com' -and ([DateTime]::UtcNow - [DateTime]$f.Ts).TotalSeconds -lt 120) { $fwBody = [string]$f.Body }
            } catch { }
            if ($fwBody -match 'Firewall Block|firewall') {
                Set-EngineStatus -Name 'Sourcegraph' -Status 'network_unavailable' -Reason ('Sourcegraph 403 + 正文 "Firewall Block"：该网络出口被 sourcegraph.com 边缘防火墙拦（出口 IP/地区级），不是令牌问题、重试无效 —— 换网络/代理，或 MCPS_DISABLE=Sourcegraph；{0}' -f $script:Cfg.CodeFallbackHint)
                Add-EngineWarning -Engine 'Sourcegraph' -Message 'Sourcegraph 被边缘防火墙拦（Firewall Block）：本源在当前网络不可用，重试无意义' -From 'streaming API (403)' -To 'skip (firewall-blocked)'
            }
            elseif (-not $env:SRC_TOKEN) {
                Set-EngineStatus -Name 'Sourcegraph' -Status 'network_unavailable' -Reason ('Sourcegraph 403（匿名）：官方支持匿名检索 ⇒ 多为出口 IP 被边缘规则拦；设 SRC_TOKEN 或换网络后重试（本次未执行，勿当零命中）；{0}' -f $script:Cfg.CodeFallbackHint)
                Add-EngineWarning -Engine 'Sourcegraph' -Message 'Sourcegraph 匿名 403：未执行（非零命中）' -From 'streaming API (403)' -To 'skip (blocked)'
            }
            else {
                Set-EngineStatus -Name 'Sourcegraph' -Status 'error' -Reason ('Sourcegraph 403（带 SRC_TOKEN）：令牌无该范围/已吊销，或出口 IP 被拦 —— 先换令牌，再换网络；{0}' -f $script:Cfg.CodeFallbackHint)
                Add-EngineWarning -Engine 'Sourcegraph' -Message 'Sourcegraph 403（带令牌）：未执行' -From 'streaming API (403)' -To 'skip (forbidden)'
            }
        }
        else {
            Set-EngineStatus -Name 'Sourcegraph' -Status 'error' -Reason $_.Exception.Message
            # v1.23.0 #5c：引擎失败/降级进 warnings[]（不再无声兜底）
            Add-EngineWarning -Engine 'Sourcegraph' -Message "Sourcegraph streaming 检索失败: $($_.Exception.Message)" -From 'streaming API' -To 'skip'
        }
        Write-ColorOutput "Sourcegraph 检索失败(可忽略): $_" "DarkYellow"
        return @()
    }
}
