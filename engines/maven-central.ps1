# engines/maven-central.ps1 —— U-243（v1.53.25，验收 B1-7）从 package-registries.ps1 拆出的**单一上游**引擎。

function Search-MavenCentral {
    param($Keyword, $Limit)
    Write-ColorOutput "正在检索 Maven Central..." "Cyan"
    $ua = @{"User-Agent" = "multi-code-platform-searcher/$VERSION"}
    $results = @(); $i = 1
    # search.maven.org solrsearch（无下载量，Stars=0；latestVersion 作版本）。实测 0.65–1.97s（n=10/10）。
    # v1.36.3（P1-6）：Maven Central 偶发挂起，用慢源专用短超时（Cfg.SlowSourceTimeoutSec）
    # v1.36.4：同时限制重试次数（SlowSourceMaxAttempts=1），否则 5s 被 MaxAttempts=3 放大
    try {
        $uri = "https://search.maven.org/solrsearch/select?q=$([uri]::EscapeDataString($Keyword))`&rows=$Limit`&wt=json"
        $data = (Invoke-ApiRequest -Uri $uri -Headers $ua -TimeoutSec $script:Cfg.SlowSourceTimeoutSec -MaxAttempts $script:Cfg.SlowSourceMaxAttempts).Content | ConvertFrom-Json
        if ($data -and $data.response -and $data.response.docs) {
            foreach ($d in $data.response.docs) {
                $g = if ($d.g) { if ($d.g -is [array]) { $d.g[0] } else { $d.g } } else { '' }
                $a = if ($d.a) { if ($d.a -is [array]) { $d.a[0] } else { $d.a } } else { $d.artifactId }
                $ver = if ($d.latestVersion) { $d.latestVersion } else { ($d.version | Select-Object -Last 1) }
                $results += [PSCustomObject]@{ Index = $i; Platform = "Maven"; Name = "$g`:$a"; Stars = 0; Unit = 'none'; Url = "https://search.maven.org/artifact/$g/$a"; Desc = "v$ver"; License = ''; Updated = '' }
                $i++
            }
        }
    }
    catch {
        Write-ColorOutput "Maven Central 检索失败(可忽略): $_" "DarkYellow"
        Add-EngineWarning -Engine 'Maven' -Message ("Maven Central 检索失败: " + $_.Exception.Message) -From 'Maven' -To 'skip'
    }
    Write-ColorOutput "Maven Central 命中 $($results.Count) 条" "Green"
    return $results
}
