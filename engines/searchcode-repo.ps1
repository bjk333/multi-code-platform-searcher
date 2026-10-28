# engines/searchcode-repo.ps1 —— searchcode **仓库级**代码证据引擎（-RepoScope 触发，串行调用，不进并发池/不进注册表）。
#   v1.39.0（2026-10-07 A 线归并批）：自 A 线 v1.38.0 并入。
#   背景：searchcode 旧全局端点 /api/codesearch_I/ 已下线（服务 reboot），新 API 实测可用：
#   POST https://api.searchcode.com/api/v1/code_search?client=<app>   body: {repository, query, ...}
#   语义是"在**指定的一个**公开仓库里搜代码"，故需要 -RepoScope 给定仓库 URL；不是全局关键词搜索。
#   免费 beta、无需 key。端点清单见 https://searchcode.com/openapi.json 。
#   只含函数定义，无顶层副作用；由主脚本 dot-source（主进程串行调用，不经 Runspace 注入）。
function Search-SearchCodeRepo {
    param([string]$Keyword, [string]$Repository, [int]$Limit)
    Write-ColorOutput "正在 searchcode 检索仓库内代码（$Repository）..." "Cyan"
    if (-not $Repository) {
        Set-EngineStatus -Name 'SearchCodeRepo' -Status 'error' -Reason '需要 -RepoScope <公开仓库 git URL>'
        return @()
    }
    try {
        $uri = "https://api.searchcode.com/api/v1/code_search?client=multi-code-platform-searcher"
        # ★v1.68.0（U-286）：`[ordered]` 固定字节序（理由见 grep-app.ps1 同处注释：回放键取自正文）
        $body = [ordered]@{
            repository    = $Repository
            query         = $Keyword
            max_results   = [math]::Max(1, [math]::Min(100, $Limit))
            context_lines = 1   # v1.46.2 评估：改成 2 无收益 —— 预览只取前后各一行（PreviewLen=200），服务端多给的行用不上
        } | ConvertTo-Json -Compress
        $headers = @{ 'User-Agent' = "multi-code-platform-searcher/$VERSION"; 'Content-Type' = 'application/json' }
        # v1.39.0：显式传超时与尝试次数（"不许吃默认"，与 code 通路同规；本引擎串行于并发池之外，无 17s 截止约束）。
        $data = (Invoke-ApiRequest -Uri $uri -Headers $headers -TimeoutSec $script:Cfg.ApiTimeoutLongSec -MaxAttempts $script:Cfg.CodeRequestMaxAttempts -Method POST -Body $body).Content | ConvertFrom-Json
        $commit = [string]$data.commit_sha
        # v1.46.1（2026-10-20）：**少命中也要说清楚**。服务端会截断（truncated/has_more），此前完全没透出 ⇒
        #   「只返回了前 N 条」与「仓库里就这么多」长得一样（同族：budget-truncated / filtered）。
        if ($data.truncated -or $data.has_more) {
            Add-EngineWarning -Engine 'SearchCodeRepo' -Message ("searchcode 仅返回部分匹配：total_matches={0}，本次 {1} 条（has_more={2}）—— 别当成仓库内全量" -f [string]$data.total_matches, [string]$data.results_returned, [string]$data.has_more) -From 'api.searchcode.com' -To 'observe (truncated)'
        }
        # 结果链接：GitHub/GitLab 可拼到具体文件行；其它宿主退化为仓库地址（不臆造路径规则）
        $blobBase = $null
        if ($Repository -match '^https?://github\.com/') { $blobBase = ($Repository -replace '/$', '') + "/blob/$commit/" }
        elseif ($Repository -match '^https?://gitlab\.com/') { $blobBase = ($Repository -replace '/$', '') + "/-/blob/$commit/" }
        $results = @(); $i = 1
        foreach ($f in @($data.results)) {
            foreach ($m in @($f.matches)) {
                if ($i -gt $Limit) { break }
                $file = [string]$f.file
                $line = if ($null -ne $m.line) { [int]$m.line } else { $null }
                $url = if ($blobBase) { "$blobBase$file" + $(if ($line) { "#L$line" } else { '' }) } else { $Repository }
                $prev = [string]$m.content
                # v1.46.1：`context_lines=1` 一直开着，但响应里的 context_before/context_after 此前被丢掉 ——
                #   预览只剩**单行**，读代码证据时看不出上下文。这里用服务端已返回的字段把预览做实（不额外发请求）。
                $before = @($m.context_before | Where-Object { $null -ne $_ -and "$_" -ne '' } | Select-Object -Last 1)
                $after = @($m.context_after | Where-Object { $null -ne $_ -and "$_" -ne '' } | Select-Object -First 1)
                if ($before.Count -and $before[0]) { $prev = ([string]$before[0]).TrimEnd() + " ⏎ " + $prev }
                if ($after.Count -and $after[0]) { $prev = $prev + " ⏎ " + ([string]$after[0]).TrimEnd() }
                if ($prev.Length -gt $script:Cfg.PreviewLen) { $prev = $prev.Substring(0, $script:Cfg.PreviewLen) + '…' }
                $results += [PSCustomObject]@{
                    Index    = $i
                    Platform = "searchcode"
                    Name     = $Repository
                    File     = $file
                    Line     = $line
                    Url      = $url
                    Desc     = ("lang: {0}; matches_in_file: {1}; total: {2}" -f [string]$f.language, [string]$f.matches_in_file, [string]$data.total_matches)
                    Preview  = $prev
                }
                $i++
            }
            if ($i -gt $Limit) { break }
        }
        if ($results.Count -gt 0) {
            Write-ColorOutput "searchcode 命中 $($results.Count) 条（仓库内）" "Green"
            Set-EngineStatus -Name 'SearchCodeRepo' -Status 'ok' -Reason ''
        }
        else {
            Write-ColorOutput "searchcode 检索成功但 0 命中" "DarkYellow"
            Set-EngineStatus -Name 'SearchCodeRepo' -Status 'empty' -Reason '检索成功但 0 命中'
        }
        return $results
    }
    catch {
        $msg = $_.Exception.Message
        $isRateLimited = $msg -match '429|Too Many Requests|rate.?limit|限流等待过长'
        if ($isRateLimited) {
            Set-EngineStatus -Name 'SearchCodeRepo' -Status 'rate_limited' -Reason 'searchcode 限流，稍后重试'
            Add-EngineWarning -Engine 'SearchCodeRepo' -Message 'searchcode 限流，本次跳过' -From 'api.searchcode.com' -To 'skip (rate_limited)'
        }
        else {
            Set-EngineStatus -Name 'SearchCodeRepo' -Status 'error' -Reason $msg
            Add-EngineWarning -Engine 'SearchCodeRepo' -Message "searchcode 仓库级检索失败: $msg" -From 'api.searchcode.com' -To 'skip'
        }
        Write-ColorOutput "searchcode 检索失败(可忽略): $_" "DarkYellow"
        return @()
    }
}
