# engines/packagist.ps1 —— Packagist（PHP / Composer）研究源（U-199，2026-10-21）
#   为什么值得新增：调研当日实测 `GET https://packagist.org/search.json?q=redis&per_page=15` 返回
#   200 / 0.74s / 15 条（total 6453），免 key、无分页陷阱；而同期候选（DBLP 被 Anubis 拦 202、
#   Papers with Code 302、Bitbucket 404、Debian Code Search 只有 HTML、grep.ai 401）全部出局。
#   PHP 生态此前只有 Sourcegraph/SE 能间接覆盖，缺一个"包级"入口。
#   只含函数定义，无顶层副作用；由主脚本 dot-source。
function Search-Packagist {
    param($Keyword, $Limit)
    Write-ColorOutput "正在 Packagist 检索 PHP 包..." "Cyan"
    $results = @(); $i = 1
    try {
        $perPage = [Math]::Max(1, [Math]::Min(100, [int]$Limit))
        $uri = "https://packagist.org/search.json?q=$([uri]::EscapeDataString($Keyword))&per_page=$perPage"
        $headers = @{ 'User-Agent' = "multi-code-platform-searcher/$VERSION"; 'Accept' = 'application/json' }
        # R5 口径：显式超时/次数，不吃默认（否则单源抖动会把整轮拖到引擎截止）
        $rsp = Invoke-ApiRequest -Uri $uri -Headers $headers -TimeoutSec $script:Cfg.ApiTimeoutSec -MaxAttempts $script:Cfg.CodeRequestMaxAttempts
        $data = $rsp.Content | ConvertFrom-Json
        foreach ($p in @($data.results)) {
            if (-not $p -or -not $p.name) { continue }
            $dl = if ($null -ne $p.downloads) { [int64]$p.downloads } else { 0 }
            $url = if ($p.url) { [string]$p.url } elseif ($p.repository) { [string]$p.repository } else { "https://packagist.org/packages/$($p.name)" }
            $desc = [string]$p.description
            if ($p.abandoned) { $desc = "[abandoned] " + $desc }   # 弃用标记必须透出：这直接决定"能不能用"
            $favers = if ($null -ne $p.favers) { [int]$p.favers } else { 0 }
            $results += [PSCustomObject]@{
                Index    = $i
                Platform = 'Packagist'
                Name     = [string]$p.name
                Stars    = $dl
                Unit     = 'downloads'
                Url      = $url
                Desc     = ("{0}; favers: {1}" -f $desc, $favers)
                License  = ''
                Updated  = ''
            }
            $i++
        }
        # 少命中可见：Packagist 的 total 是服务端总量，本次只取 per_page 条 ⇒ 差额必须说清楚（同 searchcode 口径）
        if ($null -ne $data.total -and [int]$data.total -gt @($results).Count) {
            Add-EngineWarning -Engine 'Packagist' -Message ("Packagist 仅返回前 {0} 条（服务端 total={1}）—— 别当成全量" -f @($results).Count, [string]$data.total) -From 'packagist.org' -To 'observe (truncated)'
        }
    }
    catch {
        $msg = $_.Exception.Message
        # 429 是"可达但被限"，不是"源坏了"——分档写，避免把限流说成不可用
        if ($msg -match '\b429\b|rate.?limit|Too Many|限流等待过长') {
            Set-EngineStatus -Name 'Packagist' -Status 'rate_limited' -Reason ("Packagist 限流：{0}" -f $msg)
            Add-EngineWarning -Engine 'Packagist' -Message ("Packagist 限流，本次跳过：{0}" -f $msg) -From 'packagist.org' -To 'skip (rate_limited)'
        }
        else {
            Set-EngineStatus -Name 'Packagist' -Status 'error' -Reason ("检索失败：{0}" -f $msg)
            Add-EngineWarning -Engine 'Packagist' -Message ("[Packagist] 检索失败：{0}" -f $msg) -From 'engine' -To 'error'
        }
        Write-ColorOutput "Packagist 检索失败: $_" "Red"
        return @()
    }
    Write-ColorOutput "Packagist 命中 $($results.Count) 条" "Green"
    if ($results.Count -eq 0) { Set-EngineStatus -Name 'Packagist' -Status 'empty' -Reason '检索成功但 0 命中' }
    else { Set-EngineStatus -Name 'Packagist' -Status 'ok' -Reason '' }
    return $results
}
