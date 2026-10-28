# engines/deps-dev.ps1 —— v1.46.3：deps.dev **精确包**元数据（无关键词端点，故走独立入口 -Package）
#   为什么单独一个入口：/v3alpha/search 实测 404（2026-10-20），关键词检索不存在；
#   塞进 -ResearchSources 只会造出「按定义必然 0 命中」的源，污染 coverage。
#   数据来源（均为 GET、免 key、实测无 429）：
#     1) /v3alpha/systems/{system}/packages/{name}                    → versions[]（含 isDefault / isDeprecated / publishedAt）
#     2) /v3alpha/systems/{system}/packages/{name}/versions/{version}  → licenses / licenseDetails / advisoryKeys / links
#   实测（2026-10-20）：两请求合计 0.3–2.7s；go 的 versions 可达 2365 条 / 689KB（ConvertFrom-Json 可承受）。
#   路径编码：**必须 EscapeDataString** —— npm 作用域包 `@types/node` 不编码直接 404，编码后 200（实测）。
#   不做：依赖图（/v3alpha/query 是 POST 且要逐版本展开，另行评估）、许可证合规判定（只如实透出 SPDX 串）。

function Search-DepsDevPackage {
    param([string]$PackageSpec, [int]$TimeoutSec = 0)
    $spec = ([string]$PackageSpec).Trim()
    $c = $spec.IndexOf(':')
    if ($c -lt 1 -or $c -ge ($spec.Length - 1)) {
        Set-EngineStatus -Name 'DepsDev' -Status 'error' -Reason ('包规格必须是 <生态>:<包名>（收到 "{0}"）' -f $spec)
        Add-EngineWarning -Engine 'DepsDev' -Message ('包规格无法解析："{0}"（示例：npm:express / pypi:requests）' -f $spec) -From 'cli' -To 'skip (bad spec)'
        return @()
    }
    $sysRaw = $spec.Substring(0, $c).Trim().ToLowerInvariant()
    $pkgName = $spec.Substring($c + 1).Trim()
    $sysMap = $script:Cfg.DepsDevSystems
    if (-not ($sysMap -is [hashtable]) -or -not $sysMap.ContainsKey($sysRaw)) {
        Set-EngineStatus -Name 'DepsDev' -Status 'error' -Reason ('不支持的生态 "{0}"（支持：{1}）' -f $sysRaw, (($sysMap.Keys | Sort-Object) -join ', '))
        return @()
    }
    $sys = [string]$sysMap[$sysRaw]
    $t = if ($TimeoutSec -gt 0) { $TimeoutSec } else { [int]$script:Cfg.DepsDevTimeoutSec }
    $hd = @{ 'User-Agent' = "multi-code-platform-searcher/$VERSION"; 'Accept' = 'application/json' }
    $base = 'https://api.deps.dev/v3alpha/systems/{0}/packages/{1}' -f $sys, [uri]::EscapeDataString($pkgName)
    try {
        $pkg = (Invoke-ApiRequest -Uri $base -Headers $hd -TimeoutSec $t).Content | ConvertFrom-Json
        $vers = @($pkg.versions)
        # 取「默认版本」= 新装解析到的那个（deps.dev 的 isDefault）。没有标记时退化为列表末项：
        #   实测 pypi/cargo/nuget/go 的 versions 并非严格按时间升序（requests 末项是 2.9.2/2016），
        #   但**默认标记缺失只可能发生在异常响应**上，此时列表末项是唯一的确定性选择，且会进 warnings。
        $pick = @($vers | Where-Object { $_.isDefault } | Select-Object -First 1)
        $fallback = $false
        if ($pick.Count -eq 0 -and $vers.Count -gt 0) { $pick = @($vers[$vers.Count - 1]); $fallback = $true }
        if ($pick.Count -eq 0) {
            Set-EngineStatus -Name 'DepsDev' -Status 'empty' -Reason '包存在但没有版本记录'
            return @()
        }
        $ver = [string]$pick[0].versionKey.version
        # ★PS 7 的 ConvertFrom-Json 会把 ISO 时间串**自动转成 [datetime]**（5.1 不会）⇒ 直接 [string] 会得到
        #   本地化格式（实测 "10/09/2026 12:56:54"，与 5.1 输出的 ISO 串不同，跨运行时不可比）。此处统一回 ISO。
        $published = [string]$pick[0].publishedAt
        if ($pick[0].publishedAt -is [datetime]) { $published = ([datetime]$pick[0].publishedAt).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') }
        $deprecated = [bool]$pick[0].isDeprecated
        $depReason = [string]$pick[0].deprecatedReason
        $detailUri = '{0}/versions/{1}' -f $base, [uri]::EscapeDataString($ver)
        $det = (Invoke-ApiRequest -Uri $detailUri -Headers $hd -TimeoutSec $t).Content | ConvertFrom-Json
        $lic = @($det.licenses | Where-Object { $_ } | Select-Object -Unique) -join '/'
        if (-not $lic) {
            $lic = @($det.licenseDetails | ForEach-Object { [string]$_.license } | Where-Object { $_ } | Select-Object -Unique) -join '/'
        }
        $adv = @($det.advisoryKeys | ForEach-Object { [string]$_.id } | Where-Object { $_ })
        $bits = @(('default {0}' -f $ver))
        if ($published.Length -ge 10) { $bits += $published.Substring(0, 10) }
        $bits += ('{0} 个版本' -f $vers.Count)
        $bits += ('{0} 条安全公告' -f $adv.Count)
        if ($deprecated) { $bits += ('deprecated：' + $depReason) }
        if ($fallback) { $bits += '（服务端未标 isDefault，已取列表末项）' }
        $item = [PSCustomObject]@{
            Index    = 1
            Platform = 'deps.dev'
            Name     = ('{0}/{1}' -f $sysRaw, $pkgName)
            Stars    = 0
            Unit     = 'none'
            Url      = ('https://deps.dev/{0}/{1}/{2}' -f $sysRaw, $pkgName, $ver)
            Desc     = ($bits -join ' · ')
            License  = $(if ($lic) { $lic } else { $null })
            Updated  = $(if ($published) { $published } else { $null })
        }
        # 安全公告只「如实透出」：deps.dev 给的是**存在性**，不是可利用性判定（OSV 详情另查）。
        if ($adv.Count -gt 0) {
            $show = (@($adv | Select-Object -First 3) -join ', ')
            if ($adv.Count -gt 3) { $show = $show + (' 等 {0} 条' -f $adv.Count) }
            Add-EngineWarning -Engine 'DepsDev' -Message ('{0}@{1} 有 {2} 条已知安全公告：{3}（来源 deps.dev/OSV，未做可利用性判定）' -f $item.Name, $ver, $adv.Count, $show) -From 'deps.dev advisories' -To 'observe'
        }
        if ($deprecated) {
            Add-EngineWarning -Engine 'DepsDev' -Message ('{0}@{1} 已被标记 deprecated：{2}' -f $item.Name, $ver, $depReason) -From 'deps.dev version' -To 'observe'
        }
        if ($fallback) {
            Add-EngineWarning -Engine 'DepsDev' -Message ('{0} 的响应里没有 isDefault 标记，已退化为列表末项 {1}（版本可能不是最新）' -f $item.Name, $ver) -From 'deps.dev package' -To 'fallback (no default)'
        }
        Set-EngineStatus -Name 'DepsDev' -Status 'ok' -Reason ''
        return @($item)
    }
    catch {
        $msg = "$_"
        # 404 的三种表现都要认（实测）：PS 7 的 Exception.Message 含 "404 (Not Found)"；
        #   PS 5.1 是 "远程服务器返回错误: (404) 未找到"；而 `throw` 重抛时 `"$_"` 可能只拿到**响应体**
        #   （deps.dev 的 404 正文就是 "package not found"）⇒ 三者任一命中即按「包不存在」处理。
        $httpStatus = $null
        try { if ($_.Exception.Response) { $httpStatus = [int]$_.Exception.Response.StatusCode } } catch { }
        $notFound = ($httpStatus -eq 404) -or ($msg -match '\b404\b') -or ($msg -match 'package not found')
        if ($notFound) {
            # 404 = 该生态下确实没有这个包（不是"没查"）。保持 empty ⇒ Verdict 不受影响，ReasonCode=zero-hit。
            Add-EngineWarning -Engine 'DepsDev' -Message ('包不存在：{0}（deps.dev 无此包；生态/命名空间/大小写需与服务端一致）' -f $spec) -From 'deps.dev' -To 'not found'
            Set-EngineStatus -Name 'DepsDev' -Status 'empty' -Reason ('包不存在（404）：{0}' -f $spec)
        }
        else {
            Set-EngineStatus -Name 'DepsDev' -Status 'error' -Reason ('deps.dev 查询失败：{0}' -f $msg)
            Add-EngineWarning -Engine 'DepsDev' -Message ('deps.dev 查询失败：{0}' -f $msg) -From 'engine' -To 'error'
        }
        return @()
    }
}
