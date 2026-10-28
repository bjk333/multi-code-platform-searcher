# engines/npm-registry.ps1 —— U-243（v1.53.25，验收 B1-7）从 package-registries.ps1 拆出的**单一上游**引擎。
#   拆分理由（实测，见 reports/验收-全维度-2026-10-25/06-实施记录-B1.md §B1-7）：
#     · 旧 `Search-PackageRegistries` 在**一个引擎内串行**请求 npm → crates.io → Maven，
#       实测 npm search 十轮里 2 次挂满 15s 超时，而它排在最前 ⇒ 后面两个已经毫秒级返回的子源
#       被迫一起等，整引擎 20.6–21.3s，独占 research 墙钟 94%。
#     · 拆成三个引擎后由池并行调度：单源挂死只影响它自己，crates/Maven 照常 1–2s 交付。
#   一个引擎 = 一个上游（验收 02-架构设计-v2 §L2 隔离原则）。

function Search-NpmRegistry {
    param($Keyword, $Limit)
    Write-ColorOutput "正在检索 npm registry..." "Cyan"
    $ua = @{"User-Agent" = "multi-code-platform-searcher/$VERSION"}
    $results = @(); $i = 1
    # U-243：**主结果优先**。下载量补全（3s，纯增强）不得挤掉 npm search 的结果。
    #   实测：池内并发下 npm search 可到 9.9s（引擎 deadline 13s），若此时再花 3s 补全 ⇒ 撞截止 ⇒
    #   Stop 掉引擎、5 条 npm 结果一起消失（"为了一项装饰丢掉主结果"）。
    #   规则：search 用掉超过 (NpmSearchTimeoutSec − NpmDownloadTimeoutSec) 就跳过补全，并在 warnings 留痕。
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    # registry.npmjs.org 搜索 API（score.detail.popularity 作热度近似；下载量见下方 Set-NpmDownloadStats）
    try {
        $uri = "https://registry.npmjs.org/-/v1/search?text=$([uri]::EscapeDataString($Keyword))`&size=$Limit"
        # U-243：**本引擎专属 deadline 交给池**（Cfg.EngineDeadlineByEngine.Npm），这里只给请求层上限。
        #   实测 npm search 成功样本 0.85–3.04s（n=8/10），失败样本是 15.01s 整（TCP 层挂死，非源侧报错）。
        #   给 12s 是"3 倍上包络"：足够容忍抖动，又不至于让一次挂死吃掉 research 的整个预算。
        $data = (Invoke-ApiRequest -Uri $uri -Headers $ua -TimeoutSec $script:Cfg.NpmSearchTimeoutSec -MaxAttempts 1).Content | ConvertFrom-Json
        if ($data -and $data.objects) {
            foreach ($o in $data.objects) {
                $p = $o.package
                $pop = if ($o.score -and $o.score.detail -and $null -ne $o.score.detail.popularity) { [int]($o.score.detail.popularity * $script:Cfg.NpmPopularityScale) } else { 0 }
                $url = if ($p.links -and $p.links.npm) { $p.links.npm } else { "https://www.npmjs.com/package/$($p.name)" }
                $results += [PSCustomObject]@{ Index = $i; Platform = "npm"; Name = $p.name; Stars = $pop; Unit = 'popularity (proxy)'; Url = $url; Desc = "v$($p.version); $($p.description)" + $(if ($p.keywords) { "; kw: " + (@($p.keywords) -join ', ') } else { '' }); License = ''; Updated = '' }
                $i++
            }
        }
    }
    catch {
        Write-ColorOutput "npm 检索失败(可忽略): $_" "DarkYellow"
        Add-EngineWarning -Engine 'Npm' -Message ("npm 检索失败: " + $_.Exception.Message) -From 'npm' -To 'skip'
    }
    # npm Stars 换真实周下载量（api.npmjs.org/downloads/point/last-week 支持逗号分隔批量查询）。
    #   批量失败时保留 popularity 代理值且 Unit 标 'popularity (proxy)'（诚实降级，不冒充下载量）。
    #   ★U-243：补全用**独立的短超时 + 单次尝试**（Cfg.NpmDownloadTimeoutSec），它只是"把代理值换成真值"的增强，
    #     没有资格让整个引擎再等 20s×3。实测该端点 7/10 在 1.8s 内返回、3/10 挂死。
    $spentSec = $sw.Elapsed.TotalSeconds
    # U-253（v1.53.26，2026-10-26）：`full` 模式把预算设成无穷 ⇒ 守卫（`$spentSec -lt $budgetSec`）形态一字不动，
    #   只是"还有没有余量"这个问题的答案变成"永远有"。这样两种策略下契约都在：
    #     fast（默认）= 主结果优先，超预算就跳过并留痕；full = 总是补全（评测要完整字段）。
    #   环境变量优先于 Cfg，便于评测脚本单次覆盖而不改产品默认。
    $dlPolicy = [string]$env:MCPS_NPM_DOWNLOAD_POLICY
    if ($dlPolicy -ne 'full' -and $dlPolicy -ne 'fast') { $dlPolicy = [string]$script:Cfg.NpmDownloadPolicy }
    if ($dlPolicy -ne 'full' -and $dlPolicy -ne 'fast') { $dlPolicy = 'fast' }
    $budgetSec = if ($dlPolicy -eq 'full') {
        [double]::MaxValue
    } else {
        [double]$script:Cfg.NpmSearchTimeoutSec - [double]$script:Cfg.NpmDownloadTimeoutSec
    }
    if (@($results).Count -gt 0 -and $spentSec -lt $budgetSec) {
        try { Set-NpmDownloadStats -Results $results -UserAgent $ua } catch { }
    }
    elseif (@($results).Count -gt 0) {
        # 跳过不是错误，但必须留痕 —— 否则"Unit 全为 popularity (proxy)"会被当成接口退化
        Add-EngineWarning -Engine 'Npm' -Message ("npm search 已用 {0:N1}s（预算 {1}s），跳过下载量补全以保主结果" -f $spentSec, $budgetSec) -From 'npm search' -To 'skip (download enrichment)'
    }
    if (@($results).Count -eq 0) { return $results }
    Write-ColorOutput "npm 命中 $($results.Count) 条" "Green"
    return $results
}
