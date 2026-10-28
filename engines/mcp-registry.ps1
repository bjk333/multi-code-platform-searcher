# engines/mcp-registry.ps1 —— 由 U-100 步骤 C 从 multi-platform-searcher.ps1 位移而来（2026-09-28）
#   只含函数定义，无顶层副作用；由主脚本 dot-source（注入链 (Get-Item "function:X").Definition 零改动）。
#   位移来源：主脚本 L2200–2245（46 行，权威 AST 口径）；body_sha256=8db4c81e650793950cd81d7484f36e403b8f34e8bf25b459f8680d9c18ab36bd

function Search-McpRegistry {
    param($Keyword, $Limit)
    Write-ColorOutput "正在检索 MCP 目录(MCP 官方注册中心)..." "Cyan"
    $results = @(); $i = 1
    try {
        # v1.35.0 修复：Glama glama.ai/api/mcp/v1/servers 已关闭匿名访问(实测永久 401)，
        # 改用 MCP 官方注册中心 registry.modelcontextprotocol.io/v0/servers（稳定、公开、无需认证、JSON）。
        # 该 API 不支持服务端 q= 过滤，故做客户端关键词子串过滤（同技能 MatchTerms 思路）。
        # v1.46.1（2026-10-20 实测）：**默认只返回 30 条**且带 `metadata.nextCursor`。此前不带 limit ⇒
        #   只过滤前 30 条却报「0 命中」，把"没扫到"说成"没有"。现显式取 100 条，并在有 nextCursor 时
        #   **只在 0 命中**场景提示"仅前 100 条"（有命中时提示只是噪音）。
        $uri = "https://registry.modelcontextprotocol.io/v0/servers?limit=100"
        $ua = @{"User-Agent" = "multi-code-platform-searcher/$VERSION" ; "Accept" = "application/json"}
        # v1.36.3（P1-6）：MCP 注册中心为慢源（宿主实测超时主导研究模式 47–49s），用慢源短超时
        # v1.36.4：同时限制重试次数（SlowSourceMaxAttempts=1）。订正：MCP 本身并不慢（宿主实测 0.9s，curl 3s），
        # 它只是此前被"单次 5s × 3 次重试"放大成整轮长尾的参与者之一；真正缺的是引擎级截止（见 Cfg.EngineDeadlineSec）。
        $data = (Invoke-ApiRequest -Uri $uri -Headers $ua -TimeoutSec $script:Cfg.SlowSourceTimeoutSec -MaxAttempts $script:Cfg.SlowSourceMaxAttempts).Content | ConvertFrom-Json
        # 兼容两种结构：官方注册中心 { servers:[{server:{...},_meta}] } 与旧 Glama { servers:[{name,url,...}] }
        $servers = @()
        if ($data.servers) {
            foreach ($s in $data.servers) {
                if ($s.server -and $s.server.PSObject.Properties.Name) { $servers += $s.server }
                elseif ($s.name) { $servers += $s }
            }
        }
        # 客户端关键词过滤（对 name + description + title，大小写不敏感）
        $q = [string]$Keyword
        foreach ($s in $servers) {
            $name = [string]$s.name
            $title = [string]$s.title
            $desc = [string]$s.description
            $needle = "$name $title $desc".ToLowerInvariant()
            if ($q -and -not $needle.Contains($q.ToLowerInvariant())) { continue }
            # v1.46.1（2026-10-20）：官方 schema（v0/servers，2025-12-11）里 `url` 可缺省、连接方式在 `remotes[]`；
            #   一个 server 可有**多条** remotes（sse / streamable-http…），此前只取第一条且不看是否为空 ⇒ 取到空串。
            $url = [string]$s.url
            if (-not $url -and $s.remotes) {
                foreach ($rm in @($s.remotes)) { if ($rm.url) { $url = [string]$rm.url; break } }
            }
            $tools = 0
            if ($s.tools) { $tools = @($s.tools).Count }
            $desc2 = ($desc -replace '\s+', ' ').Trim()
            if ($desc2.Length -gt $script:Cfg.PreviewLen) { $desc2 = $desc2.Substring(0, $script:Cfg.PreviewLen) + '…' }
            $results += [PSCustomObject]@{ Index = $i; Platform = "MCPRegistry"; Name = $name; Stars = $tools; Unit = 'tools'; Url = $url; Desc = $desc2; License = ''; Updated = ([string]$s.version) }
            $i++
            if ($i -gt $Limit) { break }
        }
        $next = [string]$data.metadata.nextCursor
        if ($results.Count -eq 0) {
            if ($next) {
                Add-EngineWarning -Engine 'MCPRegistry' -Message '注册中心只扫描了前 100 条（metadata.nextCursor 存在）—— 0 命中不代表全库没有，换更具体的关键词再试' -From 'registry v0/servers' -To 'observe (partial scan)'
            }
            Set-EngineStatus -Name 'MCPRegistry' -Status 'empty' -Reason ('检索成功但 0 命中' + $(if ($next) { '（仅扫描前 100 条）' } else { '' }))
        }
        else { Set-EngineStatus -Name 'MCPRegistry' -Status 'ok' -Reason '' }
    }
    catch { Set-EngineStatus -Name 'MCPRegistry' -Status 'error' -Reason "检索失败: $($_.Exception.Message)" }
    Write-ColorOutput "MCP 官方注册中心命中 $($results.Count) 条" "Green"
    return $results
}
