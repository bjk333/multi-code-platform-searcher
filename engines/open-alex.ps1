# engines/open-alex.ps1 —— 由 U-100 步骤 C 从 multi-platform-searcher.ps1 位移而来（2026-09-28）
#   只含函数定义，无顶层副作用；由主脚本 dot-source（注入链 (Get-Item "function:X").Definition 零改动）。
#   位移来源：主脚本 L2252–2273（22 行，权威 AST 口径）；body_sha256=22195afb2a647171e2b2287b773764dc913eda3fc819dd447a45dcfea212980a

function Search-OpenAlex {
    param($Keyword, $Limit)
    Write-ColorOutput "正在 OpenAlex 检索学术论文..." "Cyan"
    $results = @(); $i = 1
    try {
        $uri = "https://api.openalex.org/works?search=$([uri]::EscapeDataString($Keyword))`&per-page=$Limit`&select=id,display_name,cited_by_count,publication_year,doi"
        # P0-1（2026-10-19 实测）：OpenAlex 已改为**按网络 IP 共享免费额度**，用尽即 429（resets at UTC 午夜）。
        #   `mailto`（旧 polite pool）实测**已不生效**（带与不带同为 429）；**免费 API key** 才自带独立预算。故 key 优先，mailto 保留作旧机制兼容。
        $oaKey = [string]$env:MCPS_OPENALEX_API_KEY; $oaMail = [string]$env:MCPS_OPENALEX_MAILTO
        if ($oaKey) { $uri += "`&api_key=" + [uri]::EscapeDataString($oaKey) } elseif ($oaMail) { $uri += "`&mailto=" + [uri]::EscapeDataString($oaMail) }
        $ua = @{"User-Agent" = "multi-code-platform-searcher/$VERSION"}
        $resp = Invoke-ApiRequest -Uri $uri -Headers $ua -TimeoutSec $script:Cfg.ApiTimeoutSec
        # v1.46.0：预算头透出（2026-10-20 实测：响应带 X-RateLimit-Limit / -Remaining，单位 credits，默认 1000/天）。
        #   此前只在 429 之后才让用户知道"没额度了"，看不到"还剩多少、什么时候重置"⇒ 无法判断该等还是该配 key。
        $oaLimit = Get-HeaderValue -Headers $resp.Headers -Name 'X-RateLimit-Limit'
        $oaRemain = Get-HeaderValue -Headers $resp.Headers -Name 'X-RateLimit-Remaining'
        if ($oaLimit -match '^\d+$' -and $oaRemain -match '^\d+$' -and [int]$oaLimit -gt 0) {
            $oaL = [int]$oaLimit; $oaR = [int]$oaRemain
            if ($oaR -le [Math]::Ceiling($oaL * 0.1)) {
                Add-EngineWarning -Engine 'OpenAlex' -Message ("今日额度仅剩 {0}/{1} credits（UTC 午夜重置）；免费 API key 自带独立预算：MCPS_OPENALEX_API_KEY" -f $oaR, $oaL) -From 'X-RateLimit-Remaining' -To 'budget-low'
            }
        }
        $data = $resp.Content | ConvertFrom-Json
        if ($data -and $data.results) {
            foreach ($w in $data.results) {
                $cited = if ($null -ne $w.cited_by_count) { [int]$w.cited_by_count } else { 0 }
                $year = if ($null -ne $w.publication_year) { [string]$w.publication_year } else { '' }
                $url = if ($w.id) { [string]$w.id } elseif ($w.doi) { "https://doi.org/$($w.doi)" } else { '' }
                $results += [PSCustomObject]@{ Index = $i; Platform = "OpenAlex"; Name = [string]$w.display_name; Stars = $cited; Unit = 'citations'; Url = $url; Desc = "cited: $cited; year: $year"; License = ''; Updated = "$year" }
                $i++
            }
        }
    }
    catch {
        # 批次2（2026-10-09）：**失败必须显式上报**（与 U-157 修 GitLab 同型）。
        #   病灶：旧写法只打一行 DarkYellow 文案、**不设引擎状态** ⇒ 状态保持 unknown ⇒
        #   ReasonCode 落 'not-run'，用户看到的是「检索成功但 0 命中」的假阴性；
        #   而真实原因可能是端点限流（实测 OpenAlex 现恒返 429 + Retry-After: 30805s≈8.6h，
        #   触发 Invoke-ApiRequest 的 TooLong 快失败分支，抛「限流等待过长」，该文案不含 429）。
        $msg = "$_"
        if ($msg -match '\b429\b|限流等待过长|rate.?limit') {
            # v1.46.0：把服务端给的 Retry-After 折算成"还要等多久"，避免只看到「已用尽」却无法安排重试。
            $waitHint = ''
            if ($msg -match 'Retry-After\s+(\d+)') {
                $waitMin = [int][Math]::Round([int]$Matches[1] / 60.0, 0)
                $waitHint = "；服务端要求等待约 $waitMin 分钟后重试（UTC 约 $([DateTime]::UtcNow.AddMinutes($waitMin).ToString('HH:mm'))）"
            }
            Set-EngineStatus -Name 'OpenAlex' -Status 'rate_limited' -Reason ('OpenAlex 429：免费额度按【网络 IP 共享】且已用尽（UTC 午夜重置）；免费 API key 自带独立预算 —— 设 MCPS_OPENALEX_API_KEY（申请：https://help.openalex.org/api/auth）；实测 mailto 已不生效' + $waitHint)
        } else {
            Set-EngineStatus -Name 'OpenAlex' -Status 'error' -Reason "检索失败: $($_.Exception.Message)"
        }
        Write-ColorOutput "OpenAlex 检索失败(可忽略): $_" "DarkYellow"
    }
    Write-ColorOutput "OpenAlex 命中 $($results.Count) 条" "Green"
    return $results
}
