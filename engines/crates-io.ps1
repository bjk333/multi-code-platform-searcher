# engines/crates-io.ps1 —— U-243（v1.53.25，验收 B1-7）从 package-registries.ps1 拆出的**单一上游**引擎。

function Search-CratesIo {
    param($Keyword, $Limit)
    Write-ColorOutput "正在检索 crates.io..." "Cyan"
    $ua = @{"User-Agent" = "multi-code-platform-searcher/$VERSION"}
    $results = @(); $i = 1
    # 官方 /api/v1/crates（按 downloads 排序，含真实下载量）。实测 0.53–1.14s（n=8/10）。
    try {
        $uri = "https://crates.io/api/v1/crates?q=$([uri]::EscapeDataString($Keyword))`&per_page=$Limit`&sort=downloads"
        $data = (Invoke-ApiRequest -Uri $uri -Headers $ua -TimeoutSec $script:Cfg.CratesTimeoutSec -MaxAttempts 1).Content | ConvertFrom-Json
        if ($data -and $data.crates) {
            foreach ($c in $data.crates) {
                $dl = if ($null -ne $c.downloads) { $c.downloads } else { 0 }
                $results += [PSCustomObject]@{ Index = $i; Platform = "crates.io"; Name = $c.name; Stars = $dl; Unit = 'downloads'; Url = "https://crates.io/crates/$($c.name)"; Desc = "v$($c.max_version); $($c.description)" + $(if ($c.keywords) { "; kw: " + (@($c.keywords) -join ', ') } else { '' }); License = ''; Updated = '' }
                $i++
            }
        }
    }
    catch {
        Write-ColorOutput "crates.io 检索失败(可忽略): $_" "DarkYellow"
        Add-EngineWarning -Engine 'Crates' -Message ("crates.io 检索失败: " + $_.Exception.Message) -From 'crates.io' -To 'skip'
    }
    Write-ColorOutput "crates.io 命中 $($results.Count) 条" "Green"
    return $results
}
