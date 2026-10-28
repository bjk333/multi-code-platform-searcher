# engines/stack-exchange.ps1 —— 由 U-100 步骤 C 从 multi-platform-searcher.ps1 位移而来（2026-09-28）
#   只含函数定义，无顶层副作用；由主脚本 dot-source（注入链 (Get-Item "function:X").Definition 零改动）。
#   位移来源：主脚本 L2210–2247（38 行，权威 AST 口径）；body_sha256=1b6b0a90352ac72f49e9d4ed050a58863f9670f0d8238a2e085edb05aa18b67e

function Search-StackExchange {
    param($Keyword, $Limit, [string]$Site = 'stackoverflow')
    Write-ColorOutput "正在 Stack Exchange 检索问答（site=$Site）..." "Cyan"
    $results = @(); $i = 1
    try {
        $q = [uri]::EscapeDataString($Keyword)
        $uri = "https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=$q&site=$Site&pagesize=$Limit&filter=withbody"
        # M4（v1.14.0）：可选 SE_KEY（Stack Apps 免费注册的应用 key）注入，匿名 300 req/天 → 有 key 提升配额并降低 429
        if ($env:SE_KEY) { $uri += "&key=$([uri]::EscapeDataString($env:SE_KEY))" }
        $ua = @{"User-Agent" = "multi-code-platform-searcher/$VERSION"}
        $data = (Invoke-ApiRequest -Uri $uri -Headers $ua -TimeoutSec $script:Cfg.ApiTimeoutSec).Content | ConvertFrom-Json
        if ($data -and $data.items) {
            foreach ($item in $data.items) {
                $score = if ($null -ne $item.score) { [int]$item.score } else { 0 }
                $answers = if ($null -ne $item.answer_count) { [int]$item.answer_count } else { 0 }
                $body = if ($item.body) { ([string]$item.body -replace '<[^>]+>', ' ' -replace '\s+', ' ').Trim() } else { '' }
                $preview = if ($body.Length -gt $script:Cfg.PreviewLen) { $body.Substring(0, $script:Cfg.PreviewLen) + '…' } else { $body }
                $tags = if ($item.tags) { (@($item.tags) -join ', ') } else { '' }
                $results += [PSCustomObject]@{
                    Index    = $i
                    Platform = "StackExchange"
                    Name     = [string]$item.title
                    Stars    = $score
                    Unit = 'votes'
                    Url      = [string]$item.link
                    Desc     = "score: $score; answers: $answers; tags: $tags"
                    License  = ''
                    Updated  = ''
                    Preview  = $preview
                }
                $i++
            }
        }
    }
    catch {
        # R5-TLS（2026-10-10）：失败**必须显式上报** —— 旧写法只打印 ⇒ 状态停留 unknown
        #   ⇒ 池尾兜底判成 empty（"检索成功但 0 命中"）⇒ Verdict 仍 full ⇒ 静默假阴性。
        Write-ColorOutput "Stack Exchange 检索失败: $_" "Red"
        Set-EngineStatus -Name 'SE' -Status 'error' -Reason "检索失败: $($_.Exception.Message)"
        Add-EngineWarning -Engine 'SE' -Message "[Stack Exchange] 检索失败：$($_.Exception.Message)" -From 'engine' -To 'error'
        return @()
    }
    Write-ColorOutput "Stack Exchange 命中 $($results.Count) 条（site=$Site）" "Green"
    if ($results.Count -eq 0) {
        # v1.42.0（P1-c 实测）：SE 的 q 是 **AND 语义**（"kubernetes operators" 5 条 → 加一个无意义词即 0 条）
        #   ⇒ 多词长查询会结构性零命中。实测**放宽查询后返回的 5 条多为单向匹配的噪声**
        #   （"Model Context Protocol registry" ⇒ "Why use a schema registry"），故**不自动放宽**，只在 reason 里讲清机制。
        $tc = @($Keyword -split '\s+' | Where-Object { $_ }).Count
        $why = if ($tc -ge 3) { "检索成功但 0 命中（AND 语义：$tc 个词须同时出现，长查询易结构性零命中；不自动放宽——实测放宽后多为单词语义噪声）" } else { '检索成功但 0 命中' }
        Set-EngineStatus -Name 'SE' -Status 'empty' -Reason $why
    }
    else { Set-EngineStatus -Name 'SE' -Status 'ok' -Reason '' }
    return $results
}
