# engines/deepseek-search.ps1 —— DeepSeek Search（2026-10-17 新增）
#   只含函数定义，无顶层副作用；由主脚本 engines/*.ps1 通配 dot-source。
#   接口：POST https://api.deepseek.com/v1/tools/search（官方 2026-10-17 上线）
#   鉴权：Bearer $env:DEEPSEEK_API_KEY；按「成功请求次数」计费（$0.75/千次），空结果不计费。
#   返回字段：title / url / snippet / summary / content / date / rerank_score(0-3) / authority(0-4)。
#   纪律：无 key ⇒ 不发请求（可选付费源，未配置不算失败）；401/402/403/429 必须显式上报。
#   ★B2-1（U-264，2026-10-26）：已迁 EngineContract v1 —— 返回封套、不自报 status（判定归池侧 Resolve-EngineVerdict）
#   ★v1.68.0（U-286）：请求体用 [ordered] 固定字节序 —— 离线回放的键是 sha256(method/uri/body)，
#     而 PowerShell 哈希表枚举顺序**逐进程不同**（实测同一段代码两次跑出两种键序）⇒ 正文一变键就变，回放必 miss。
#     另两个 POST 引擎（grep-app / searchcode-repo）同处理，理由写在 grep-app.ps1 同处。

function Search-DeepSeek {
    param($Keyword, $Limit)
    # 逐引擎请求账（C4 此前只有全局口径）。quota.class='prepaid'（预付费余额，不是 anonymous 也不是 token 桶）；
    #   limit/remaining 要查账户接口才有，**不猜** —— 猜错的余额会被拿去当决策依据。
    $t0 = [DateTime]::UtcNow
    $req = @{ attempted = 0; succeeded = 0; failed = 0 }
    $quota = @{ class = 'prepaid'; limit = $null; remaining = $null; resetAt = $null }
    if (-not $env:DEEPSEEK_API_KEY) {
        # not-run（不是 missing-credential）：可选付费源"没打算用"与"配了但失效"是两件事 —— 后者要用户改 key，
        #   前者只要知道它没参与。Requested 侧已由 Test-ResearchEngineAvailable 先行排除，正常路径到不了这里。
        Write-ColorOutput "DeepSeek 源跳过：未配置 DEEPSEEK_API_KEY（可选付费源，不计失败）" "DarkGray"
        return New-EngineEnvelope -Engine 'DeepSeek' -Kind 'research' -Requests $req -StartedAt $t0 `
            -Quota @{ class = 'none'; limit = $null; remaining = $null; resetAt = $null } `
            -Failure @{ reasonCode = 'not-run'; reason = 'DEEPSEEK_API_KEY 未配置（可选付费源，不计失败；配置后自动参与）' }
    }
    Write-ColorOutput "正在 DeepSeek 搜索检索网页（api.deepseek.com，按成功请求计费）..." "Cyan"
    $results = @(); $i = 1; $dropped = 0
    # v1.41.0 门槛 1.0（官方 ≥1.5 高质量；无关查询实测 0.27）。★必须保持赋值字面量：U-174 用 `\$minScore\s*=\s*([\d.]+)$` 提取
    $minScore = 1.0
    if ($env:MCPS_DEEPSEEK_MIN_SCORE) { $minScore = [double]$env:MCPS_DEEPSEEK_MIN_SCORE }
    $count = [Math]::Max(1, [Math]::Min(50, [int]$Limit)); $q = [string]$Keyword
    if ($q.Length -gt 128) {
        $q = $q.Substring(0, 128); Add-EngineWarning -Engine 'DeepSeek' -Message "query 超过 128 字符，已截断至 128（服务端硬限制）" -From 'engine' -To 'truncated'
    }

    $failure = $null
    try {
        $body = [ordered]@{ query = $q; count = $count; need_content = $false } | ConvertTo-Json -Compress   # U-286：固定字节序（回放键取正文哈希；理由见文件头）
        $headers = @{
            'Authorization' = "Bearer $($env:DEEPSEEK_API_KEY)"
            'Content-Type'  = 'application/json'
            'User-Agent'    = "multi-code-platform-searcher/$VERSION"
        }
        $req.attempted++
        $resp = Invoke-ApiRequest -Uri 'https://api.deepseek.com/v1/tools/search' -Headers $headers `
            -TimeoutSec $script:Cfg.ApiTimeoutLongSec -MaxAttempts $script:Cfg.SlowSourceMaxAttempts `
            -Method POST -Body $body
        $req.succeeded++
        $data = $resp.Content | ConvertFrom-Json

        if ($data -and $data.results) {
            foreach ($r in $data.results) {
                if ($i -gt $count) { break }
                $score = if ($null -ne $r.rerank_score) { [double]$r.rerank_score } else { 0.0 }
                $auth = if ($null -ne $r.authority) { [int]$r.authority } else { -1 }
                if ($score -lt $minScore) { $dropped++; continue }
                $summary = if ($r.summary) { [string]$r.summary } else { [string]$r.snippet }
                $summary = ($summary -replace '\s+', ' ').Trim()
                if ($summary.Length -gt $script:Cfg.PreviewLen) { $summary = $summary.Substring(0, $script:Cfg.PreviewLen) + '…' }
                $site = [string]$r.site_name; $dt = [string]$r.date
                $desc = (@("score=$score auth=$auth", $(if ($site) { "site=$site" }), $(if ($dt) { "date=$dt" })) | Where-Object { $_ }) -join ' '
                $results += [PSCustomObject]@{
                    Index    = $i
                    Platform = 'DeepSeek'
                    Name     = [string]$r.title
                    Stars    = [int][Math]::Round($score * 10)   # 0-30，仅用于排序参考（Unit=score）
                    Unit     = 'score'
                    Url      = [string]$r.url
                    Desc     = $desc
                    License  = ''
                    Updated  = $dt
                    Preview  = $summary
                }
                $i++
            }
        }

        if ($dropped -gt 0) {
            Add-EngineWarning -Engine 'DeepSeek' -Message "丢弃 $dropped 条低置信结果（rerank_score < $minScore；MCPS_DEEPSEEK_MIN_SCORE 可调）" -From 'engine' -To 'filtered'
            # 返回 N 条但全被门槛丢掉 ⇒ `filtered`（**不是** zero-hit：源健康，是我们自己丢的）。L1 判 empty/filtered
            #   而不是 error —— 否则用户会去排查网络，而该做的是调阈值。0 命中且没丢任何东西则**不设 failure**。
            if ($results.Count -eq 0) {
                $failure = @{ reasonCode = 'filtered'; reason = "返回 $dropped 条但全部低于阈值 $minScore，已丢弃（不等于该源无结果；MCPS_DEEPSEEK_MIN_SCORE 可调）" }
            }
        }
    }
    catch {
        # 失败分类收进表（不是 if/elseif 链：本函数顶在 U-163 的 100 行红线上，每加一档多 2 行）。
        #   ★ordered：401 必须先判 —— "Authentication Fails" 里若夹数字会被后档抢走。
        #   ★402 是本引擎唯一的付费分支 ⇒ quota-exhausted。L1 判 blocked（actionable=充值），legacy 压成
        #     error（⇒ coverage 的 Degraded，而不是 NotRun；理由见 ConvertTo-LegacyEngineStatus 的注释）。
        $msg = "$($_.Exception.Message)"; $req.failed++   # 传输/HTTP 失败都是**发出去了**的一次尝试
        $failMap = [ordered]@{
            '\b401\b|Authentication Fails|invalid' = @{ code = 'missing-credential'; hint = 'DEEPSEEK_API_KEY 无效或已过期（401）——请更新 .env 后重试' }
            '\b402\b|insufficient'                 = @{ code = 'quota-exhausted'; hint = 'DeepSeek 账户余额不足（402）——充值后重试；按成功请求计费，未成功不计费' }
            '\b429\b'                              = @{ code = 'rate-limited'; hint = 'DeepSeek 限流（429，账号级 5 QPS）——降低并发或稍后重试' }
            '\b403\b'                              = @{ code = 'forbidden'; hint = 'DeepSeek 拒绝请求（403）——检查账号状态' }
        }
        $failure = @{ reasonCode = 'error'; reason = "检索失败: $msg" }
        foreach ($p in $failMap.Keys) {
            if ($msg -match $p) { $failure = @{ reasonCode = $failMap[$p].code; reason = $failMap[$p].hint }; break }
        }
        Write-ColorOutput "DeepSeek 检索失败: $($failure.reason)" "Red"
        Add-EngineWarning -Engine 'DeepSeek' -Message "[DeepSeek] $($failure.reason)" -From 'engine' -To $failure.reasonCode
    }

    Write-ColorOutput "DeepSeek 命中 $($results.Count) 条" "Green"
    return New-EngineEnvelope -Engine 'DeepSeek' -Kind 'research' -Results $results -Requests $req `
        -Quota $quota -Failure $failure -StartedAt $t0
}
