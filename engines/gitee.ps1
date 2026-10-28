
function Search-Gitee {
    param($Keyword, $Language, $MinStars, $Limit)
    Write-ColorOutput "正在 Gitee 搜索..." "Cyan"
    # v1.28.0：改用 Gitee 官方开源搜索（so.gitee.com）后端 API——
    # /api/v5/search/repositories 已被服务端内容风控（匿名/带 token/代理均返回空数组，Gitee Feedback #ICCSIY），
    # 而 so.gitee.com 搜索 API 匿名可用、无风控（实测 q=vue→XE/vxe-table 5175★、q=jwt→dromara/surpass 3476★）。
    # 该 API 不支持服务端排序/过滤，故多取候选后在客户端按星标过滤（与旧实现同策略）。
    # 回退：so API 失败时退回 /api/v5/search/repositories（企业实例/风控解除场景仍可用）。
    $widget = 'wong1slagnlmzwvsu5ya'
    $perPage = [Math]::Min($script:Cfg.GiteeSoPageMax, [Math]::Max($Limit, $script:Cfg.GiteeSoPageMin))
    $soUri = "https://so.gitee.com/v1/search/widget/${widget}?q=$([uri]::EscapeDataString($Keyword))&from=0&size=$perPage"
    try {
        # U-156：auto 须容许企业代理可达而直连不通；显式 direct 仍保留 U-40 真直连，强制 proxy 也不被旧 -NoProxy 覆盖。
        $soDirect = ($script:ProxyMode -eq 'direct')
        $data = (Invoke-ApiRequest -Uri $soUri -Headers @{'Origin'='https://so.gitee.com';'Referer'='https://so.gitee.com/'} -NoProxy:$soDirect).Content | ConvertFrom-Json
        $hits = @($data.hits.hits)
        if ($hits.Count -eq 0) {
            Write-ColorOutput "Gitee (so.gitee.com) 未返回结果（0 命中）" "Yellow"
            # U-274（B3-3 行为层首跑抓到）：**这里原先没有 Set-EngineStatus**。
            #   同文件其它出口（v5 的 empty/ok、catch 的 error）都显式设状态，唯独 so 通道"成功但 0 条"不设
            #   ⇒ 状态停在 unknown，靠池尾兜底猜成 empty。R5-TLS 的纪律是"失败/空结果必须显式上报"，
            #   靠兜底等于把"这次到底跑没跑"交给调用方去猜 —— 行为门 B 臂因此读到 unknown 而不是 empty。
            Set-EngineStatus -Name 'Gitee' -Status 'empty' -Reason '检索成功但 0 命中'
            return @()
        }
        $kwWords = @($Keyword -split '\s+' | Where-Object { $_ -and $_.Length -ge 2 })
        $all = @()
        foreach ($h in $hits) {
            $f = $h.fields
            if (-not $f) { continue }
            $title = if ($f.title) { $f.title[0] } else { '' }
            $star = if ($f.'count.star') { [int]$f.'count.star'[0] } else { 0 }
            $langs = if ($f.langs) { @($f.langs) } else { @() }
            $desc  = if ($f.description) { $f.description[0] } else { $null }
            # v1.30.0：改用 so API 的 _score 作为真实语义相关度（原生支持中英文语义匹配，
            # 实测 disjob@distributed task scheduler _score=100.1 排第一）。
            # v1.29.0 的自造 rel 子串打分对中文 desc 仓库失效（disjob 全中文 desc -> rel=0），
            # 反把 Linux Lab 这种 _score=1.4 的内容碰词噪音排前——降级为仅识别 awesome 噪音用。
            $rel = 0
            foreach ($w in $kwWords) {
                $esc = [regex]::Escape($w)
                if ($title -match $esc) { $rel += 3 }
                if ($desc -and $desc -match $esc) { $rel += 2 }
            }
            $all += [PSCustomObject]@{
                Name    = $title
                Stars   = $star
                Unit = 'stars'
                Url     = if ($f.url) { $f.url[0] } else { '' }
                Desc    = $desc
                License = if ($f.license) { $f.license[0] } else { $null }
                Updated = if ($f.last_push_at) { $f.last_push_at[0] } else { $null }
                Langs   = $langs
                Rel     = $rel
                Score   = if ($null -ne $h._score) { [double]$h._score } else { 0 }
            }
        }
        # v1.30.0：剔除明确噪音（awesome 列表仓库且与关键词零相关）；按 API 语义相关度 _score 排序（星标次之）
        $all = @($all | Where-Object { -not ($_.Rel -eq 0 -and $_.Name -match '^awesome') })
        # v1.36.3（P1-8）：相关度地板——关键词零命中（Rel=0）且 API _score 低于绝对下限，或低于榜首 _score×比例 ⇒ 视为碰词噪音剔除。
        # 只剔 Rel=0：标题/描述命中关键词的一律保留；中文 desc 高分仓库（_score 高）也不受影响。
        $giteeTop = 0.0
        foreach ($it in $all) { if ($it.Score -gt $giteeTop) { $giteeTop = [double]$it.Score } }
        $giteeMin = [double]$script:Cfg.GiteeMinApiScore
        $giteeRatioFloor = $giteeTop * [double]$script:Cfg.GiteeRelFloorRatio
        $giteeBefore = $all.Count
        $all = @($all | Where-Object { -not ($_.Rel -eq 0 -and ($_.Score -lt $giteeMin -or $_.Score -lt $giteeRatioFloor)) })
        if ($all.Count -lt $giteeBefore) {
            Write-ColorOutput ("Gitee 相关度地板剔除 {0} 条碰词噪音（Rel=0 且 _score<{1} 或 <榜首×{2}）" -f ($giteeBefore - $all.Count), $giteeMin, $script:Cfg.GiteeRelFloorRatio) "DarkGray"
        }
        $all = @($all | Sort-Object @{Expression='Score';Descending=$true}, @{Expression='Stars';Descending=$true})
        $results = @(); $i = 1
        foreach ($item in $all) {
            if ($item.Stars -ge $MinStars -and (-not $Language -or ($item.Langs -contains $Language -or ($item.Langs | Where-Object { $_.ToLower() -eq $Language.ToLower() })))) {
                # v1.30.0：ApiScore 透出（so API 语义相关度 _score），Agent 可按此判断结果可信度；
                # Set-UnifiedScore 用它替代 Stars 热度做组内基础分（修复中文 desc 仓库跨平台排序被 Stars 压制的缺陷）
                $results += [PSCustomObject]@{ Index = $i; Platform = "Gitee"; Name = $item.Name; Stars = $item.Stars; Url = $item.Url; Desc = $item.Desc; License = $item.License; Updated = $item.Updated; ApiScore = $item.Score }
                $i++
            }
        }
        Write-ColorOutput "Gitee (so.gitee.com) 原始 $($all.Count) 条，按星标筛选后 $($results.Count) 条" "Green"
        if ($results.Count -eq 0) { Set-EngineStatus -Name 'Gitee' -Status 'empty' -Reason '检索成功但 0 命中' }
        else { Set-EngineStatus -Name 'Gitee' -Status 'ok' -Reason '' }
        return $results
    }
    catch {
        # 回退：旧 v5 API（so 失败时兜底）。**状态与错误上报在回退函数内完成**（R5-TLS：
        #   失败必须显式上报，否则被池尾兜底成 'empty' ⇒ Verdict 仍 full ⇒ 静默假阴性）。
        Write-ColorOutput "Gitee so.gitee.com 搜索失败($_),回退 v5 API..." "DarkYellow"
        return (Invoke-GiteeV5Fallback -Keyword $Keyword -MinStars $MinStars -Language $Language -Limit $Limit -PerPage $perPage)
    }
}
