# engines/docker-hub.ps1 —— 由 U-100 步骤 C 从 multi-platform-searcher.ps1 位移而来（2026-09-28）
#   只含函数定义，无顶层副作用；由主脚本 dot-source（注入链 (Get-Item "function:X").Definition 零改动）。
#   位移来源：主脚本 L2160–2179（20 行，权威 AST 口径）；body_sha256=2a745a6b11bd83e3bc1ced6be7eb3060c095e6ee3366cbbd97225e9586eae965

function Search-DockerHub {
    param($Keyword, $Limit)
    Write-ColorOutput "正在 Docker Hub 检索容器镜像..." "Cyan"
    $results = @(); $i = 1; $dropped = 0
    # v4 P1-a（2026-10-19）：**质量门槛** —— Docker Hub 的 search 是模糊匹配，长查询必返噪声
    #   （实测：query=MCP registry provenance ⇒ 返回 grafana/mcp-grafana、registry 等无关镜像，40/40 全噪声）。
    #   只用 ASCII 词判定；纯中文查询（无可判词）**不过滤**（避免误杀）。
    $stop = @('the','and','for','with','from','into','that','this','what','how','why','when','where','which','are','was','were','has','have','had','not','but','all','any','can','may','use','used','using','via','per','than','then','also','its','their','there','these','those','about','over','under','between','within','without','against','during','before','after','above','below','more','most','less','least','best','better','good','new','old','first','last','next','one','two','three','four','five','six','seven','eight','nine','ten')
    $terms = @([regex]::Matches(([string]$Keyword).ToLowerInvariant(), '[a-z0-9][a-z0-9._-]{2,}') | ForEach-Object { $_.Value } | Where-Object { $stop -notcontains $_ } | Select-Object -Unique)
    $minTerms = [int][Math]::Max(1, [Math]::Ceiling($terms.Count / 3.0))
    if ($env:MCPS_DOCKERHUB_MIN_TERMS) { $minTerms = [int]$env:MCPS_DOCKERHUB_MIN_TERMS }
    $filterOn = $true
    if ($env:MCPS_DOCKERHUB_FILTER -eq '0') { $filterOn = $false }
    if ($terms.Count -eq 0) { $filterOn = $false; Add-EngineWarning -Engine 'DockerHub' -Message '查询无可判 ASCII 词（纯中文？）⇒ 本轮不做质量门槛' -From 'engine' -To 'filter-skipped' }
    try {
        $uri = "https://hub.docker.com/v2/search/repositories/?query=$([uri]::EscapeDataString($Keyword))`&page_size=$Limit"
        $ua = @{"User-Agent" = "multi-code-platform-searcher/$VERSION"}
        $data = (Invoke-ApiRequest -Uri $uri -Headers $ua -TimeoutSec $script:Cfg.ApiTimeoutSec).Content | ConvertFrom-Json
        if ($data -and $data.results) {
            foreach ($r in $data.results) {
                $stars = if ($null -ne $r.star_count) { [int]$r.star_count } else { 0 }
                if ($filterOn) {
                    $hay = (([string]$r.repo_name) + ' ' + ([string]$r.short_description)).ToLowerInvariant()
                    $hit = 0
                    foreach ($t in $terms) { if ($hay.Contains($t)) { $hit++ } }
                    if ($hit -lt $minTerms) { $dropped++; continue }
                }
                $results += [PSCustomObject]@{ Index = $i; Platform = "DockerHub"; Name = [string]$r.repo_name; Stars = $stars; Unit = 'stars'; Url = "https://hub.docker.com/r/$($r.repo_name)"; Desc = [string]$r.short_description; License = ''; Updated = '' }
                $i++
            }
        }
    }
    catch {
        # R5-TLS（2026-10-10）：失败**必须显式上报** —— 旧写法只打印 ⇒ 状态停留 unknown
        #   ⇒ 池尾兜底判成 empty（"检索成功但 0 命中"）⇒ Verdict 仍 full ⇒ 静默假阴性。
        Write-ColorOutput "Docker Hub 检索失败: $_" "Red"
        Set-EngineStatus -Name 'DockerHub' -Status 'error' -Reason "检索失败: $($_.Exception.Message)"
        Add-EngineWarning -Engine 'DockerHub' -Message "[Docker Hub] 检索失败：$($_.Exception.Message)" -From 'engine' -To 'error'
        return @()
    }
    if ($dropped -gt 0) {
        Add-EngineWarning -Engine 'DockerHub' -Message "丢弃 $dropped 条与查询词无交集的模糊结果（命中词数 < $minTerms；MCPS_DOCKERHUB_MIN_TERMS 可调，MCPS_DOCKERHUB_FILTER=0 关闭）" -From 'engine' -To 'filtered'
    }
    Write-ColorOutput "Docker Hub 命中 $($results.Count) 条（丢弃 $dropped 条噪声）" "Green"
    if ($results.Count -eq 0) {
        $why = if ($dropped -gt 0) { "返回 $dropped 条但全部与查询词无交集，已丢弃（不等于该源无结果）" } else { '检索成功但 0 命中' }
        Set-EngineStatus -Name 'DockerHub' -Status 'empty' -Reason $why
    }
    else { Set-EngineStatus -Name 'DockerHub' -Status 'ok' -Reason '' }
    return $results
}
