# engines/arxiv.ps1 —— 由 U-100 步骤 C 从 multi-platform-searcher.ps1 位移而来（2026-09-28）
#   只含函数定义，无顶层副作用；由主脚本 dot-source（注入链 (Get-Item "function:X").Definition 零改动）。
#   位移来源：主脚本 L2188–2223（36 行，权威 AST 口径）；body_sha256=97b61c85659f21374db6e8a7f102d803b3583760f375428fd87cb923cb3042b5

function Search-Arxiv {
    param($Keyword, $Limit)
    Write-ColorOutput "正在 arXiv 检索论文（export.arxiv.org）..." "Cyan"
    $results = @(); $i = 1
    try {
        $uri = "https://export.arxiv.org/api/query?search_query=all:$([uri]::EscapeDataString($Keyword))&start=0&max_results=$Limit"
        $ua = @{"User-Agent" = "multi-code-platform-searcher/$VERSION"}
        $resp = Invoke-ApiRequest -Uri $uri -Headers $ua -TimeoutSec $script:Cfg.ApiTimeoutSec
        [xml]$xml = $resp.Content
        if ($xml -and $xml.feed -and $xml.feed.entry) {
            foreach ($entry in $xml.feed.entry) {
                $title = (($entry.title -replace '\s+', ' ').Trim())
                $summary = (($entry.summary -replace '\s+', ' ').Trim())
                $authors = (@($entry.author) | ForEach-Object { [string]$_.name }) -join ', '
                $published = [string]$entry.published
                $preview = if ($summary.Length -gt $script:Cfg.PreviewLen) { $summary.Substring(0, $script:Cfg.PreviewLen) + '…' } else { $summary }
                $results += [PSCustomObject]@{
                    Index    = $i
                    Platform = "arXiv"
                    Name     = $title
                    Stars    = 0
                    Unit = 'citations'
                    Url      = [string]$entry.id
                    Desc     = "authors: $authors; published: $published"
                    License  = ''
                    Updated  = $published
                    Preview  = $preview
                }
                $i++
            }
        }
    }
    catch {
        # R5-TLS（2026-10-10）：失败**必须显式上报** —— 旧写法只打印 ⇒ 状态停留 unknown
        #   ⇒ 池尾兜底判成 empty（"检索成功但 0 命中"）⇒ Verdict 仍 full ⇒ 静默假阴性。
        Write-ColorOutput "arXiv 检索失败: $_" "Red"
        Set-EngineStatus -Name 'arXiv' -Status 'error' -Reason "检索失败: $($_.Exception.Message)"
        Add-EngineWarning -Engine 'arXiv' -Message "[arXiv] 检索失败：$($_.Exception.Message)" -From 'engine' -To 'error'
        return @()
    }
    Write-ColorOutput "arXiv 命中 $($results.Count) 条" "Green"
    if ($results.Count -eq 0) { Set-EngineStatus -Name 'arXiv' -Status 'empty' -Reason '检索成功但 0 命中' }
    else { Set-EngineStatus -Name 'arXiv' -Status 'ok' -Reason '' }
    return $results
}
