# engines/hacker-news.ps1 —— 由 U-100 步骤 C 从 multi-platform-searcher.ps1 位移而来（2026-09-28）
#   只含函数定义，无顶层副作用；由主脚本 dot-source（注入链 (Get-Item "function:X").Definition 零改动）。
#   位移来源：主脚本 L2206–2233（28 行，权威 AST 口径）；body_sha256=843d74bac10a53a73b5520d5cac5c668a1143983f2f7c2d1f02ddb13e55a2d2f

function Search-HackerNews {
    param($Keyword, $Limit)
    Write-ColorOutput "正在 Hacker News 社区检索讨论帖..." "Cyan"
    $results = @(); $i = 1
    try {
        $q = [uri]::EscapeDataString($Keyword)
        $uri = "https://hn.algolia.com/api/v1/search?query=$q&tags=story&hitsPerPage=$Limit"
        $ua = @{"User-Agent" = "multi-code-platform-searcher/$VERSION"}
        $data = (Invoke-ApiRequest -Uri $uri -Headers $ua -TimeoutSec $script:Cfg.ApiTimeoutSec).Content | ConvertFrom-Json
        if ($data -and $data.hits) {
            foreach ($h in $data.hits) {
                $title = [string]$h.title
                $pts = if ($null -ne $h.points) { [int]$h.points } else { 0 }
                $cmts = if ($null -ne $h.num_comments) { [int]$h.num_comments } else { 0 }
                $url = if ($h.url) { [string]$h.url } else { "https://news.ycombinator.com/item?id=$($h.objectID)" }
                $desc = "[$cmts comments] by $($h.author) · hn.algolia.com"
                $results += [PSCustomObject]@{ Index = $i; Platform = "HackerNews"; Name = $title; Stars = $pts; Unit = 'points'; Url = $url; Desc = $desc; License = ''; Updated = '' }
                $i++
                if ($i -gt $Limit) { break }
            }
        }
        if ($results.Count -eq 0) {
            # v1.42.0（P1-c 实测）：Algolia query 亦 **AND 语义**（"kubernetes operators" 5 条 → 加一个无意义词即 0 条）。
            #   与 SE 同口径：不自动放宽（实测放宽引入噪声），只在 reason 里讲清机制。
            $tc = @($Keyword -split '\s+' | Where-Object { $_ }).Count
            $why = if ($tc -ge 3) { "检索成功但 0 命中（AND 语义：$tc 个词须同时出现，长查询易结构性零命中；不自动放宽——实测放宽后多为单词语义噪声）" } else { '检索成功但 0 命中' }
            Set-EngineStatus -Name 'HackerNews' -Status 'empty' -Reason $why
        }
        else { Set-EngineStatus -Name 'HackerNews' -Status 'ok' -Reason '' }
    }
    catch { Set-EngineStatus -Name 'HackerNews' -Status 'error' -Reason "检索失败: $($_.Exception.Message)" }
    Write-ColorOutput "Hacker News 命中 $($results.Count) 条" "Green"
    return $results
}
