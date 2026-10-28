# engines/search-rubygems.ps1 —— 由 U-100 步骤 C 从 multi-platform-searcher.ps1 位移而来（2026-09-28）
#   只含函数定义，无顶层副作用；由主脚本 dot-source（注入链 (Get-Item "function:X").Definition 零改动）。

function Search-RubyGems {
    param($Keyword, $Limit)
    Write-ColorOutput "正在 RubyGems 检索 Ruby 包..." "Cyan"
    $results = @(); $i = 1
    try {
        $uri = "https://rubygems.org/api/v1/search.json?query=$([uri]::EscapeDataString($Keyword))"
        $ua = @{"User-Agent" = "multi-code-platform-searcher/$VERSION"}
        $data = (Invoke-ApiRequest -Uri $uri -Headers $ua -TimeoutSec $script:Cfg.ApiTimeoutSec).Content | ConvertFrom-Json
        if ($data) {
            foreach ($g in $data) {
                if ($i -gt $Limit) { break }
                $dl = if ($null -ne $g.downloads) { [int]$g.downloads } else { 0 }
                $results += [PSCustomObject]@{ Index = $i; Platform = "RubyGems"; Name = [string]$g.name; Stars = $dl; Unit = 'downloads'; Url = "https://rubygems.org/gems/$($g.name)"; Desc = "v$($g.version); $($g.info)"; License = ''; Updated = '' }
                $i++
            }
        }
    }
    catch {
        # R5-TLS（2026-10-10）：失败**必须显式上报** —— 旧写法只打印 ⇒ 状态停留 unknown
        #   ⇒ 池尾兜底判成 empty（"检索成功但 0 命中"）⇒ Verdict 仍 full ⇒ 静默假阴性。
        Write-ColorOutput "RubyGems 检索失败: $_" "Red"
        Set-EngineStatus -Name 'RubyGems' -Status 'error' -Reason "检索失败: $($_.Exception.Message)"
        Add-EngineWarning -Engine 'RubyGems' -Message "[RubyGems] 检索失败：$($_.Exception.Message)" -From 'engine' -To 'error'
        return @()
    }
    Write-ColorOutput "RubyGems 命中 $($results.Count) 条" "Green"
    if ($results.Count -eq 0) { Set-EngineStatus -Name 'RubyGems' -Status 'empty' -Reason '检索成功但 0 命中' }
    else { Set-EngineStatus -Name 'RubyGems' -Status 'ok' -Reason '' }
    return $results
}
