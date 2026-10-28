# engines/nuget.ps1 —— 由 U-100 步骤 C 从 multi-platform-searcher.ps1 位移而来（2026-09-28）
#   只含函数定义，无顶层副作用；由主脚本 dot-source（注入链 (Get-Item "function:X").Definition 零改动）。
#   位移来源：主脚本 L2138–2158（21 行，权威 AST 口径）；body_sha256=f76adf881bbfcc96e124ff88cf420341291631e3ea7565104311b3e9bc203dc9

function Search-NuGet {
    param($Keyword, $Limit)
    Write-ColorOutput "正在 NuGet 检索 .NET 包..." "Cyan"
    $results = @(); $i = 1
    try {
        $uri = "https://azuresearch-usnc.nuget.org/query?q=$([uri]::EscapeDataString($Keyword))`&take=$Limit"
        $ua = @{"User-Agent" = "multi-code-platform-searcher/$VERSION"}
        $data = (Invoke-ApiRequest -Uri $uri -Headers $ua -TimeoutSec $script:Cfg.ApiTimeoutSec).Content | ConvertFrom-Json
        if ($data -and $data.data) {
            foreach ($p in $data.data) {
                $dl = if ($null -ne $p.totalDownloads) { [int64]$p.totalDownloads } else { 0 }
                $url = if ($p.projectUrl) { [string]$p.projectUrl } else { "https://www.nuget.org/packages/$($p.id)" }
                $results += [PSCustomObject]@{ Index = $i; Platform = "NuGet"; Name = [string]$p.id; Stars = $dl; Unit = 'downloads'; Url = $url; Desc = "v$($p.version); $($p.description)" + $(if ($p.tags) { "; kw: " + (@($p.tags) -join ', ') } else { '' }); License = ''; Updated = '' }
                $i++
            }
        }
    }
    catch {
        # R5-TLS（2026-10-10）：失败**必须显式上报** —— 旧写法只打印 ⇒ 状态停留 unknown
        #   ⇒ 池尾兜底判成 empty（"检索成功但 0 命中"）⇒ Verdict 仍 full ⇒ 静默假阴性。
        Write-ColorOutput "NuGet 检索失败: $_" "Red"
        Set-EngineStatus -Name 'NuGet' -Status 'error' -Reason "检索失败: $($_.Exception.Message)"
        Add-EngineWarning -Engine 'NuGet' -Message "[NuGet] 检索失败：$($_.Exception.Message)" -From 'engine' -To 'error'
        return @()
    }
    Write-ColorOutput "NuGet 命中 $($results.Count) 条" "Green"
    if ($results.Count -eq 0) { Set-EngineStatus -Name 'NuGet' -Status 'empty' -Reason '检索成功但 0 命中' }
    else { Set-EngineStatus -Name 'NuGet' -Status 'ok' -Reason '' }
    return $results
}
