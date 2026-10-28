# engines/search-gitlab.ps1 —— 由 U-100 C-1 从 multi-platform-searcher.ps1 位移而来（2026-09-28）
#   只含函数定义，无顶层副作用；由主脚本 dot-source（注入链 (Get-Item "function:X").Definition 零改动）。
#   ★ U-157（2026-10-02）本文件在位移后被修改：order_by 由 stars 改为 star_count（前者被 GitLab 判 400）、
#     去掉 simple=true、加非数组形状守卫、失败分支显式 Set-EngineStatus error（原为静默返回空数组）。
#     故位移时记录的 body_sha256=612852300ed23b5bec9acd0f9f4857ec42600ae33e63a35407807621c796b411 **已失效**，
#     它记录的是位移当时的历史快照，不再代表当前文件内容（当前内容以下方代码为准）。

function Search-GitLab {
    param($Keyword, $Language, $MinStars, $Limit)
    Write-ColorOutput "正在 GitLab 搜索..." "Cyan"
    # U-157（2026-10-02）：order_by 必须是 GitLab /projects 认识的取值。
    #   实测 `order_by=stars` 被拒：HTTP 400 {"error":"order_by does not have a valid value"}（合法值含 star_count，不含 stars）。
    #   原先这里写 stars ⇒ 接口 400；而下面 catch 又把失败吞成空数组 ⇒ 报成"检索成功但 0 命中"，
    #   载荷里 results=0 + ReasonCodes=zero-hit，与真实故障（请求失败）不符 —— 静默假阴性。
    #   另：simple=true 的返回里 star_count 可能缺失，$null -ge $MinStars 恒为 false ⇒ 也会把全部条目滤掉，
    #   所以 -ge 判断改成"取不到星数就不按星数筛"。
    $uri = "https://gitlab.com/api/v4/projects?search=$([uri]::EscapeDataString($Keyword))`&order_by=star_count`&sort=desc`&per_page=$Limit"
    $headers = Get-ApiHeaders -Token $env:GITLAB_TOKEN -Scheme "Bearer"
    try {
        # R5（2026-10-10）：**PS7 语义坑** —— 实测 `'[]' | ConvertFrom-Json` 在 PS 7.6.6 上返回 **$null**
        #   （不是空数组）。⇒ 原来的 `if ($null -eq $data) { throw '返回空响应' }` 会把
        #   **「检索成功但 0 命中」误报成「失败」**：上游 200 + `[]`（实测 body 仅 2 字节）
        #   ⇒ 引擎 throw ⇒ code=error + Verdict 降级 ⇒ 调用方以为链路故障（实测 -Platform GitLab 5/5 全红）。
        #   ⇒ 改为**先看原始 body**：真·空 body 才算异常；`[]` 属"成功但空"，走 empty（与 zero-hit 语义一致）。
        $raw = (Invoke-ApiRequest -Uri $uri -Headers $headers).Content
        $rawText = if ($null -eq $raw) { '' } else { [string]$raw }
        if ($rawText.Trim().Length -eq 0) { throw 'GitLab 返回空 body（既无内容也无 JSON）' }
        $data = $rawText | ConvertFrom-Json
        if ($null -eq $data) {
            # ★PS7 把 '[]' 解析成 $null ⇒ 这是**合法的空结果集**，不是失败（同族门 test-r5-empty-array-not-error 钉住）
            if ($rawText.Trim() -eq '[]') { $data = @() }
            else { throw "GitLab 返回无法解析为数组的内容：$($rawText.Substring(0, [Math]::Min(120, $rawText.Length)))" }
        }
        # 形状守卫：GitLab 错误也是 JSON 对象（如 {"error": ...}），不是数组 —— 明确报失败，别当 0 命中
        if ($data -isnot [System.Array]) {
            $msg = if ($data.error) { [string]$data.error } elseif ($data.message) { [string]$data.message } else { ($data | ConvertTo-Json -Compress -Depth 3) }
            throw "GitLab /projects 返回非数组（通常是 4xx 错误体）：$msg"
        }
        $results = @(); $i = 1
        foreach ($item in $data) {
            $stars = $item.star_count
            if ($null -eq $stars) { $stars = 0 }          # simple 形态可能不带 star_count ⇒ 不按星数淘汰
            if ($stars -ge $MinStars -and (-not $Language -or (([string]$item.language).ToLower() -eq $Language.ToLower()))) {
                $results += [PSCustomObject]@{ Index = $i; Platform = "GitLab"; Name = $item.path_with_namespace; Stars = $stars; Unit = 'stars'; Url = $item.web_url; Desc = $item.description; License = $null; Updated = $item.last_activity_at }
                $i++
            }
        }
        if ($results.Count -eq 0) { Set-EngineStatus -Name 'GitLab' -Status 'empty' -Reason '检索成功但 0 命中' }
        else { Set-EngineStatus -Name 'GitLab' -Status 'ok' -Reason '' }
        Write-ColorOutput "GitLab 搜索完成：$($results.Count) 条" "Green"
        return $results
    }
    catch {
        # U-157：失败必须显式上报（旧写法 return @() 会让父层判成"检索成功但 0 命中"）
        # 批次1动作3（2026-10-09）：429 单列为 rate_limited（可恢复降级），与硬失败区分——
        #   文案必须带配额语义，否则用户看到「检索失败」会去查链路，而真实原因是配额用尽。
        # 批次B·C7（2026-10-11）：补「限流等待过长」形状——429 且 Retry-After 超 Cfg.MaxRetryWaitSec 时，
        #   Invoke-ApiRequest 走 TooLong 快速失败，抛出的消息**不含 429**（批次2 已在探针端修过同一缺口，实测 OpenAlex 30805s）；
        #   只匹配 429 字面量会把这类限流落成 error（硬失败），与探针判定自相矛盾。口径与主脚本探针一致。
        $is429 = ("$_") -match '\b429\b|限流等待过长'
        if ($is429) {
            Write-ColorOutput "GitLab 搜索限流(429)：配额用尽，本轮跳过（可恢复）" "DarkYellow"
            Set-EngineStatus -Name 'GitLab' -Status 'rate_limited' -Reason "检索限流 429: $($_.Exception.Message)"
            Add-EngineWarning -Engine 'GitLab' -Message "限流 429：配额用尽（10-19 起未认证 60 req/h/IP；Free 认证 5,000/h）——建议设置 GITLAB_TOKEN 或降低查询频率"
        } else {
            Write-ColorOutput "GitLab 搜索失败: $_" "Red"
            Set-EngineStatus -Name 'GitLab' -Status 'error' -Reason "检索失败: $($_.Exception.Message)"
            Add-EngineWarning -Engine 'GitLab' -Message "检索失败：$($_.Exception.Message)"
        }
        return @()
    }
}
# 批次1动作2核对（2026-10-09）：本函数（repo 路径）每次调用**只发 1 次** API 请求（上面那一个 Invoke-ApiRequest），
#   天然满足方案「单查询 GitLab 调用 ≤2 次」；需要预算的是 blobs 回退链（engines/gitlab-blobs.ps1）。
