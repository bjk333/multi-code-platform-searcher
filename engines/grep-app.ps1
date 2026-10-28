# engines/grep-app.ps1 —— 由 U-100 步骤 C 从 multi-platform-searcher.ps1 位移而来（2026-09-28）
#   只含函数定义，无顶层副作用；由主脚本 dot-source（注入链 (Get-Item "function:X").Definition 零改动）。
#   v1.38.0（2026-10-06，A 线移植）：检索入口由 REST `/api/search` 改为**官方 MCP 端点 `https://mcp.grep.app/`**。
#     病灶：旧 REST 入口对本出口被 Vercel 人机校验拦死（恒 429，直连/走代理均然），故 .env 曾以 MCPS_DISABLE 停用；
#     实证：官方 MCP 端点同机可达（POST JSON-RPC tools/call → SSE → 真实代码片段），官方文档亦称“限流时改用 MCP server”。
#     原 body_sha256 锚点因本次改动作废（位移来源已变），改以本注记 + git 历史为凭。

function ConvertFrom-GrepAppText {
    # v1.53.1（U-163-5）：从 Search-GrepApp 抽出的纯文本解析段（Repository/Path/URL + Snippets → 结果数组）。
    #   抽出理由：① Search-GrepApp 体 104 行 >100（U-163-5 红），解析段是无副作用的纯转换、天然可拆；
    #   ② 解析规则（Snippet 正则、无 snippet 时保留文件级命中）从此可单测，不需起网络。
    #   语义逐位不变：Limit 截断、无 snippet 仍保文件级命中（保 Recall）、Preview 超长截断加省略号。
    param([string]$Text, [int]$Limit)
    $results = @(); $i = 1
    foreach ($chunk in [regex]::Split($Text, '(?m)^(?=Repository: )')) {
        if ($chunk -notmatch '^Repository: ') { continue }
        if ($i -gt $Limit) { break }
        $repo = ([regex]::Match($chunk, '(?m)^Repository: (.+)$')).Groups[1].Value.Trim()
        $path = ([regex]::Match($chunk, '(?m)^Path: (.+)$')).Groups[1].Value.Trim()
        $url  = ([regex]::Match($chunk, '(?m)^URL: (.+)$')).Groups[1].Value.Trim()
        $snips = [regex]::Matches($chunk, '(?s)--- Snippet \d+ \(Line (\d+)\) ---[^\r\n]*\r?\n(.*?)(?=\r?\n--- Snippet |\z)')
        if ($snips.Count -eq 0) {
            # 无 snippet 块时仍保留文件级命中（保 Recall，不丢结果）
            $results += [PSCustomObject]@{ Index = $i; Platform = "grep.app"; Name = $repo; File = $path; Line = $null; Url = $url; Desc = $null; Preview = $null }
            $i++
            continue
        }
        foreach ($sm in $snips) {
            if ($i -gt $Limit) { break }
            $ln = [int]$sm.Groups[1].Value
            $snip = ($sm.Groups[2].Value -replace '\s+$', '')
            $prev = if ($snip.Length -gt $script:Cfg.PreviewLen) { $snip.Substring(0, $script:Cfg.PreviewLen) + '…' } else { $snip }
            $results += [PSCustomObject]@{ Index = $i; Platform = "grep.app"; Name = $repo; File = $path; Line = $ln; Url = $url; Desc = "line $ln"; Preview = $prev }
            $i++
        }
    }
    return $results
}

function Search-GrepApp {
    param($Keyword, $Limit, $Language, $RepoScope, $PathFilter, [switch]$MatchCase, [switch]$UseRegexp)
    Write-ColorOutput "正在 grep.app 检索代码实现证据 (官方 MCP)..." "Cyan"
    $uri = [string]$script:Cfg.GrepAppMcpUrl
    if (-not $uri) { $uri = 'https://mcp.grep.app/' }   # 兜底：Cfg 未注入时（单测/独立调用）仍可用
    $headers = @{
        'User-Agent'   = "multi-code-platform-searcher/$VERSION"
        'Content-Type' = 'application/json'
        'Accept'       = 'application/json, text/event-stream'
    }
    # U-197（2026-10-21）：官方 MCP 的 inputSchema 有 language: string[]（tools/list 实测）。只在给出时下发，
    #   未给 ⇒ body 与旧版逐字节一致（负例）。
    $toolArgs = [ordered]@{ query = $Keyword }
    if (-not [string]::IsNullOrWhiteSpace($Language)) { $toolArgs['language'] = @($Language) }
    # U-192/U-198（2026-10-21）：inputSchema 实测有 repo/path/matchCase/useRegexp（tools/list）；只在给出时下发
    #   （未给 ⇒ body 与旧版逐字节一致，负例见 test-u198）；repo 形如 `redis/redis`，path 支持片段匹配（`/route.ts`）
    foreach ($kv in @(@('repo', $RepoScope), @('path', $PathFilter))) { if (-not [string]::IsNullOrWhiteSpace($kv[1])) { $toolArgs[$kv[0]] = [string]$kv[1] } }
    if ($MatchCase) { $toolArgs['matchCase'] = $true }; if ($UseRegexp) { $toolArgs['useRegexp'] = $true }
    # ★v1.68.0（U-286）：`[ordered]` 不是洁癖 —— PowerShell 的哈希表枚举顺序**逐进程不同**（实测同一份代码两次
    #   跑出 `jsonrpc/params/method/id` 与 `params/jsonrpc/id/method` 两种字节序）。回放键是
    #   `sha256(method\0uri\0body)`（`Get-ApiReplayKey`），正文一变键就变 ⇒ 离线回放必 miss，
    #   而 miss 会被产品的 catch 吞成"0 命中"，与"源没数据"同形。固定插入顺序后请求可复现，键也稳定。
    $rpc = [ordered]@{ jsonrpc = '2.0'; id = 1; method = 'tools/call'; params = [ordered]@{ name = 'searchGitHub'; arguments = $toolArgs } }
    $body = ($rpc | ConvertTo-Json -Depth 8 -Compress)
    try {
        # v1.53.0（U-223，Tier1-4）：单请求预算取自 Get-CodeRequestBudget（= f(生效截止)）——
        #   此前写死 CodeRequestTimeoutSec=6：`MCPS_ENGINE_DEADLINE="GrepApp=25"` 只改引擎级截止、
        #   单请求仍在 6s 超时 ⇒ 调了截止救不了慢源（实测 grep.app 源活着、6s 过紧）。
        $budget = Get-CodeRequestBudget -EngineName 'GrepApp'
        $text = [string](Invoke-ApiRequest -Uri $uri -Headers $headers -TimeoutSec $budget.TimeoutSec -MaxAttempts $budget.MaxAttempts -Method POST -Body $body).Content
        # SSE 解包：取 data: 行的 JSON 负载
        $payload = $null
        foreach ($m in [regex]::Matches($text, '(?m)^data:\s*(\{.+\})\s*$')) {
            try { $payload = $m.Groups[1].Value | ConvertFrom-Json } catch { continue }
        }
        if (-not $payload) { throw 'MCP 响应无可解析 data 负载（SSE 格式变更？）' }
        if ($payload.error) { throw ("MCP 错误: " + $payload.error.message) }
        # U-191（2026-10-21，P0）：mcp.grep.app 在**限流/内部错误**时仍返回 HTTP 200，把错误塞进 result.isError=true。
        #   实测正文：{"result":{"content":[{"type":"text","text":"Unexpected token 'T', \"Too Many R\"... is not valid JSON"}],"isError":true}}
        #   只判 payload.error ⇒ 会走到下面"检索成功但 0 命中"，把上游失败洗成可信零命中（U-140 同型）。
        #   分档：Too Many/429/rate ⇒ rate_limited；其它 isError ⇒ error；两者都不写 empty。
        if ($payload.result -and ($payload.result.PSObject.Properties.Name -contains 'isError') -and [bool]$payload.result.isError) {
            $errText = ''
            foreach ($c in @($payload.result.content)) { if ($c.type -eq 'text') { $errText += [string]$c.text } }
            $errText = ($errText -replace '\s+', ' ').Trim()
            if ([string]::IsNullOrWhiteSpace($errText)) { $errText = '（上游未给出错误文本）' }
            if ($errText -match 'Too Many|429|rate.?limit') {
                Set-EngineStatus -Name 'GrepApp' -Status 'rate_limited' -Reason ('grep.app MCP 限流（上游把错误包在 result.isError）：{0}' -f $errText)
                Add-EngineWarning -Engine 'GrepApp' -Message 'grep.app MCP 限流（HTTP 200 + result.isError）—— 本次未执行，不要当零命中' -From 'mcp.grep.app' -To 'skip (rate_limited)'
            }
            else {
                Set-EngineStatus -Name 'GrepApp' -Status 'error' -Reason ('grep.app MCP 返回 isError：{0}' -f $errText)
                Add-EngineWarning -Engine 'GrepApp' -Message ('grep.app(MCP) 返回 isError：{0}' -f $errText) -From 'mcp.grep.app' -To 'skip'
            }
            Write-ColorOutput ("grep.app(MCP) 上游返回错误，本次跳过：{0}" -f $errText) "DarkYellow"
            return @()
        }
        $block = ''
        foreach ($c in @($payload.result.content)) { if ($c.type -eq 'text') { $block += [string]$c.text } }
        # 文本块结构： Repository/Path/URL/License + Snippets（--- Snippet N (Line X) --- 后跟代码行）—— 解析在 ConvertFrom-GrepAppText
        $results = @(ConvertFrom-GrepAppText -Text $block -Limit $Limit)
        if ($results.Count -gt 0) {
            Write-ColorOutput "grep.app(MCP) 命中 $($results.Count) 条代码证据" "Green"
            Set-EngineStatus -Name 'GrepApp' -Status 'ok' -Reason ''
        }
        else {
            Write-ColorOutput "grep.app(MCP) 检索成功但 0 命中" "DarkYellow"
            Set-EngineStatus -Name 'GrepApp' -Status 'empty' -Reason '检索成功但 0 命中'
        }
        return $results
    }
    catch {
        $msg = $_.Exception.Message
        $isRateLimited = $msg -match '429|Too Many Requests|rate.?limit|限流等待过长'
        if ($isRateLimited) {
            Set-EngineStatus -Name 'GrepApp' -Status 'rate_limited' -Reason 'grep.app MCP 限流，稍后重试'
            Add-EngineWarning -Engine 'GrepApp' -Message 'grep.app MCP 限流，本次跳过' -From 'mcp.grep.app' -To 'skip (rate_limited)'
        }
        else {
            Set-EngineStatus -Name 'GrepApp' -Status 'error' -Reason $msg
            Add-EngineWarning -Engine 'GrepApp' -Message "grep.app(MCP) 检索失败: $msg" -From 'mcp.grep.app' -To 'skip'
        }
        Write-ColorOutput "grep.app(MCP) 检索失败(可忽略): $_" "DarkYellow"
        return @()
    }
}
