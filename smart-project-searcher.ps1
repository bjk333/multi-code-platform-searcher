# Smart Project Searcher — 智能项目分析 · 全平台搜索 · 下载 · 缓存 · 导出
# ⚠️ v1.36.3 标注：本文件是**早期影子实现，已弃用**，不在 SKILL.md 能力范围内、不受 tests/evals 覆盖。
#    与主脚本实现已分叉：仍用已被 Gitee 服务端风控（恒返回空）的 /api/v5/search/repositories，无 coverage/warnings 契约。
#    请改用 multi-platform-searcher.ps1（仓库发现 -Platform All / -Auto）。保留文件仅为历史参考，未删除。
param(
    [switch]$AnalyzeOnly,
    [string]$CustomKeywords,
    [int]$MinStars = 100,
    [int]$Limit = 5,
    [ValidateSet("GitHub", "Gitee", "GitLab", "All")]
    [string]$Platform = "All",
    [switch]$AutoDownload,
    [int]$AutoDownloadCount = 1,
    [string]$OutputCSV,
    [string]$CacheFile = ".\smart-search_cache.json",
    [string]$ProjectPath = ".",
    [int]$CacheTTLSeconds = 900,
    [string]$OutputDir,
    [switch]$CodeSearch,
    [ValidateSet("GrepApp", "Sourcegraph", "All")]
    [string]$CodePlatform = "All",
    [int]$CodeLimit = 20,
    [ValidateSet("auto", "research_only", "repository_only", "code_evidence_only", "integrated_research_and_code")]
    [string]$QueryType = "auto",
    [string]$PlanOutput,
    [switch]$NoProxyFix,
    # v1.45.7：弃用入口的显式逃生阀。不传就拒绝执行（见下方运行时闸门）。
    [switch]$IUnderstandDeprecated
)

$ErrorActionPreference = "Stop"

# v1.45.7（2026-10-20）：**弃用不能只写在注释里**。注释只有打开文件才看得见，而实测直接运行本文件
#   会静默跑出结果（走已被服务端风控、恒返回空的 Gitee v5），使用者无从知道自己拿到的是旧行为。
#   口径：默认拒绝执行并给替代命令；确要复现历史行为时显式 -IUnderstandDeprecated。
#   dot-source（`. .\smart-project-searcher.ps1`）不退出 —— 那通常是为了取函数，杀掉宿主会话更糟。
$script:_spDotSourced = ($MyInvocation.InvocationName -eq '.')
if (-not $IUnderstandDeprecated) {
    $banner = @"
============================================================
  smart-project-searcher.ps1 —— 已弃用（v1.36.3 起）
============================================================
  这是早期的影子实现，与主脚本已经分叉：
    * Gitee 走 /api/v5（服务端已风控，恒返回空）
    * 无 coverage / warnings 契约，结果不可与主脚本对比
    * 不受 test-* 门禁保护

  请改用：
    .\multi-platform-searcher.ps1 -Auto -Keyword "jwt"
    .\multi-platform-searcher.ps1 -Keyword "jwt" -Platform All

  确要复现历史行为（不推荐）：
    .\smart-project-searcher.ps1 -IUnderstandDeprecated <原参数>
============================================================
"@
    if (-not $script:_spDotSourced) {
        [Console]::Error.WriteLine($banner)
        exit 2
    }
    Write-Warning 'smart-project-searcher.ps1 已弃用：dot-source 只加载函数，不执行主流程'
    return   # dot-source 时不杀会话，也不跑主流程（return 结束本脚本，调用者继续）
}
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$script:RunStart = Get-Date
$script:CacheHit = $false

function cw($Text, $Color = "White") {
    # 重定向（如本工具的 PowerShell 捕获 / 管道）时走成功流，确保输出不被吞；
    # 交互终端则保留彩色 Write-Host。
    if ([Console]::IsOutputRedirected) { Write-Output $Text }
    else { Write-Host $Text -ForegroundColor $Color }
}

# ---------- 网络：规避死代理（沙箱/企业环境常把 HTTPS_PROXY 指向 127.0.0.1 死代理） ----------
function Initialize-Network {
    if ($NoProxyFix) { return }
    $bad = $false
    foreach ($v in @('HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'all_proxy')) {
        $pv = [Environment]::GetEnvironmentVariable($v)
        if ($pv -and ($pv -match '127\.0\.0\.1|localhost|::1')) {
            $bad = $true
            [Environment]::SetEnvironmentVariable($v, $null)
            if (Test-Path "env:$v") { Remove-Item "env:$v" -ErrorAction SilentlyContinue }
        }
    }
    if ($bad) {
        try { [System.Net.WebRequest]::DefaultWebProxy = [System.Net.GlobalProxySelection]::GetEmptyWebProxy() } catch {}
        cw "  [网络] 检测到无效本地代理，已切换为直连（GitHub/Gitee 等 API 不再经 127.0.0.1 死代理）" "Gray"
    }
}

Initialize-Network
$KnownFrameworks = @{
    "react"="react"; "vue"="vue"; "angular"="angular"; "next"="nextjs"; "nuxt"="nuxt"; "svelte"="svelte"
    "express"="express"; "koa"="koa"; "fastify"="fastify"; "nestjs"="nestjs"; "tailwindcss"="tailwind"; "bootstrap"="bootstrap"
    "electron"="electron"; "taro"="taro"; "uniapp"="uniapp"; "prisma"="prisma"; "typeorm"="typeorm"; "mongoose"="mongoose"
    "redux"="redux"; "zustand"="zustand"; "pinia"="pinia"; "vite"="vite"; "webpack"="webpack"; "rollup"="rollup"
    "three"="threejs"; "phaser"="phaser"; "babylonjs"="babylon"; "tensorflow"="tensorflow"; "pytorch"="pytorch"; "transformers"="transformers"
    "django"="django"; "flask"="flask"; "fastapi"="fastapi"; "celery"="celery"; "sqlalchemy"="sqlalchemy"; "scikit-learn"="scikit-learn"
    "pandas"="pandas"; "numpy"="numpy"; "langchain"="langchain"; "llama-index"="llamaindex"; "aiohttp"="aiohttp"; "httpx"="httpx"; "requests"="requests"; "jinja2"="jinja2"
}

function Analyze-Project($ProjectPath = ".") {
    cw ""; cw "===============================================" "Cyan"; cw "  Analyzing Project..." "Cyan"; cw "==============================================="; cw ""
    $a = @{ Keywords = @(); Frameworks = @(); Language = $null; ProjectType = $null }
    $foundFrameworks = @{}
    $deps = @{}
    $pkg = Join-Path $ProjectPath "package.json"
    if (Test-Path $pkg) {
        cw "[+] package.json (Node.js)" "Green"
        try {
            $json = Get-Content $pkg -Raw | ConvertFrom-Json
            if ($json.name) { $a.ProjectName = $json.name; $json.name.Split("-") | ForEach-Object { $a.Keywords += $_ } }
            $a.Language = "javascript"; $a.ProjectType = "nodejs"
            if ($json.dependencies) { $json.dependencies.PSObject.Properties | ForEach-Object { $deps[$_.Name] = $true } }
            if ($json.devDependencies) { $json.devDependencies.PSObject.Properties | ForEach-Object { $deps[$_.Name] = $true } }
        } catch { cw "[!] package.json parse error" "Yellow" }
    }
    $req = Join-Path $ProjectPath "requirements.txt"; $pyt = Join-Path $ProjectPath "pyproject.toml"
    if ((Test-Path $req) -or (Test-Path $pyt)) {
        cw "[+] Python project" "Green"; $a.Language = "python"; $a.ProjectType = "python"
        if (Test-Path $req) { try { Get-Content $req | Where-Object { $_ -match '^\s*([\w-]+)' } | ForEach-Object { $deps[$Matches[1].ToLower()] = $true } } catch {} }
    }
    $gom = Join-Path $ProjectPath "go.mod"
    if (Test-Path $gom) { cw "[+] go.mod (Go)" "Green"; $a.Language = "go"; $a.ProjectType = "golang" }
    foreach ($dependency in $deps.Keys) { if ($KnownFrameworks.ContainsKey($dependency)) { $foundFrameworks[$KnownFrameworks[$dependency]] = $true } }
    $rm = Join-Path $ProjectPath "README.md"
    if (Test-Path $rm) {
        cw "[+] README.md" "Green"
        try { $txt = Get-Content $rm -Raw; $common = @("admin","dashboard","ui","api","backend","frontend","fullstack","template","boilerplate","starter","cli","tool","library","framework","component","app","web","mobile","ai","ml","machine-learning","deep-learning","llm","chatbot","automation","devops","docker","kubernetes","cloud","database"); foreach ($kw in $common) { if ($txt -match "(?i)$kw") { $a.Keywords += $kw } } } catch {}
    }
    $a.Frameworks = @($foundFrameworks.Keys | Select-Object -Unique); $a.Keywords += $a.Frameworks
    $a.Keywords = @($a.Keywords | Where-Object { $_ -and $_.Length -gt 2 -and $_.Length -lt 30 } | Select-Object -Unique)
    cw ""; cw "[OK] Analysis complete" "Green"; return $a
}

function New-ApiUri($BaseUri, [hashtable]$Query) {
    $builder = New-Object System.UriBuilder($BaseUri)
    $pairs = @()
    foreach ($key in $Query.Keys) { if ($null -ne $Query[$key] -and "$($Query[$key])" -ne "") { $pairs += ([System.Uri]::EscapeDataString([string]$key) + "=" + [System.Uri]::EscapeDataString([string]$Query[$key])) } }
    $builder.Query = $pairs -join "&"
    return $builder.Uri.AbsoluteUri
}
function Get-ProviderHeaders($Provider) {
    $headers = @{ "User-Agent" = "smart-project-searcher"; "Accept" = "application/json" }
    $tokenName = switch ($Provider) { "GitHub" { "GITHUB_TOKEN" } "Gitee" { "GITEE_TOKEN" } "GitLab" { "GITLAB_TOKEN" } default { $null } }
    if ($tokenName) { $token = [Environment]::GetEnvironmentVariable($tokenName); if ($token) { $headers["Authorization"] = "Bearer $token" } }
    return $headers
}
function Invoke-ApiRequest($Uri, $Provider, [int]$TimeoutSec = 15, [string]$OutFile) {
    $maxAttempts = 3
    for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
        try {
            $args = @{ Uri=$Uri; Headers=(Get-ProviderHeaders $Provider); UseBasicParsing=$true; TimeoutSec=$TimeoutSec; ErrorAction="Stop" }
            if ($OutFile) { $args.OutFile = $OutFile }
            return Invoke-WebRequest @args
        } catch {
            $status = $null; $retryAfter = $null
            if ($_.Exception.Response) {
                try { $status = [int]$_.Exception.Response.StatusCode } catch {}
                try { $retryAfter = $_.Exception.Response.Headers["Retry-After"] } catch {}
            }
            $retryable = ($status -eq 429 -or ($status -ge 500 -and $status -lt 600))
            if ($retryable -and $attempt -lt $maxAttempts) {
                $delay = [Math]::Min(30, [Math]::Pow(2, $attempt))
                if ($retryAfter) { $parsed = 0; if ([int]::TryParse($retryAfter, [ref]$parsed)) { $delay = [Math]::Min(60, $parsed) } }
                Start-Sleep -Seconds $delay
                continue
            }
            cw "  [$Provider] Request failed (status: $status)" "Yellow"
            return $null
        }
    }
    return $null
}

function Normalize-Result($item, $platform) {
    $name = ""; $stars = 0; $url = ""; $desc = ""
    if ($platform -eq "GitHub" -or $platform -eq "Gitee") { $name=$item.full_name; $stars=$item.stargazers_count; $url=$item.html_url; $desc=$item.description }
    elseif ($platform -eq "GitLab") { $name=$item.path_with_namespace; $stars=$item.star_count; $url=$item.web_url; $desc=$item.description }
    return [PSCustomObject]@{ Name=$name; Stars=[int]$stars; URL=$url; Desc=$desc; Platform=$platform }
}

function Get-CachePath { if ([IO.Path]::IsPathRooted($CacheFile)) { return $CacheFile }; return (Join-Path (Get-Location) $CacheFile) }
function Get-CacheKey($Query, $Platform, $Language, $Stars, $ResultLimit) { return "q=$Query|p=$Platform|l=$Language|s=$Stars|n=$ResultLimit" }
function Load-Cache { $path = Get-CachePath; if (Test-Path $path) { try { return Get-Content $path -Raw | ConvertFrom-Json } catch { return $null } }; return $null }
function Get-CachedResults($cache, $key) {
    try {
        if (-not $cache) { return @() }
        $entry = $null
        if ($cache.Entries) { $entry = $cache.Entries.PSObject.Properties[$key].Value }
        elseif ($cache.Query) { $entry = $cache } # legacy cache is readable, but requires a timestamp to be valid
        if (-not $entry -or -not $entry.CreatedAt) { return @() }
        try { $age = ((Get-Date) - ([DateTime]::Parse($entry.CreatedAt))).TotalSeconds } catch { return @() }
        if ($age -lt 0 -or $age -gt $CacheTTLSeconds) { return @() }
        if ($entry.Key -and $entry.Key -ne $key) { return @() }
        return @($entry.Results)
    } catch {
        cw "  [Cache] 读取缓存条目失败，视为未命中: $($_.Exception.Message)" "Yellow"
        return @()
    }
}
function Save-Cache($cache, $key, $data) {
    if (-not $CacheFile) { return }
    if (-not $cache -or -not $cache.Entries) { $cache = [PSCustomObject]@{ Entries = [PSCustomObject]@{} } }
    $cache.Entries | Add-Member -NotePropertyName $key -NotePropertyValue ([PSCustomObject]@{ Key=$key; CreatedAt=(Get-Date).ToString("o"); Results=@($data) }) -Force
    try { $cache | ConvertTo-Json -Depth 5 | Out-File (Get-CachePath) -Encoding UTF8; cw "[Cache] Saved to $(Get-CachePath)" "Gray" } catch { cw "[Cache] Save failed" "Yellow" }
}

function Search-GitHub($q, $lang, $stars, $limit) {
    $query = $q; if ($lang) { $query += " language:$lang" }; if ($stars -gt 0) { $query += " stars:>$stars" }
    $uri = New-ApiUri "https://api.github.com/search/repositories" @{ q=$query; sort="stars"; order="desc"; per_page=$limit }
    Write-Host "  [GitHub] Searching" -ForegroundColor "Gray"; $r = Invoke-ApiRequest $uri "GitHub"; if (-not $r) { return @() }
    try { $d=$r.Content | ConvertFrom-Json; Write-Host "  [GitHub] $($d.total_count) total" -ForegroundColor "Green"; return @($d.items | ForEach-Object { Normalize-Result $_ "GitHub" }) } catch { Write-Host "  [GitHub] Response parse failed" -ForegroundColor "Yellow"; return @() }
}
function Search-Gitee($q, $stars, $limit) {
    # Gitee v5 搜索接口不支持按 stars 排序（sort=stars 返回 400），故只取 order=desc，
    # 多取候选后在客户端按星标降序排序，再按 MinStars 过滤。
    $perPage = [Math]::Min(50, [Math]::Max($limit, 20))
    $uri = New-ApiUri "https://gitee.com/api/v5/search/repositories" @{ q=$q; per_page=$perPage; order="desc" }
    Write-Host "  [Gitee] Searching" -ForegroundColor "Gray"; $r = Invoke-ApiRequest $uri "Gitee"; if (-not $r) { return @() }
    try {
        $d=$r.Content | ConvertFrom-Json
        if (-not $d -or $d.Count -eq 0) { Write-Host "  [Gitee] 无结果（可能网络受限或未匹配）" -ForegroundColor "Yellow"; return @() }
        return @($d | Sort-Object stargazers_count -Descending | Where-Object { $_.stargazers_count -ge $stars } | ForEach-Object { Normalize-Result $_ "Gitee" })
    } catch { Write-Host "  [Gitee] Response parse failed" -ForegroundColor "Yellow"; return @() }
}
function Search-GitLab($q, $stars, $limit) {
    $uri = New-ApiUri "https://gitlab.com/api/v4/projects" @{ search=$q; per_page=$limit; order_by="star_count"; sort="desc" }
    Write-Host "  [GitLab] Searching" -ForegroundColor "Gray"; $r = Invoke-ApiRequest $uri "GitLab"; if (-not $r) { return @() }
    try { $d=$r.Content | ConvertFrom-Json; return @($d | Where-Object { $_.star_count -ge $stars } | ForEach-Object { Normalize-Result $_ "GitLab" }) } catch { Write-Host "  [GitLab] Response parse failed" -ForegroundColor "Yellow"; return @() }
}

# 并发检索仓库（GitHub/Gitee/GitLab）—— 复用原生 Runspace 池，失败时回退串行（AC-P3-2）
function Invoke-ConcurrentRepoSearch {
    param([string[]]$Engines, [string]$Query, [string]$Language, [int]$MinStars, [int]$Limit)
    $all = @()
    try {
        $needed = @('cw', 'New-ApiUri', 'Get-ProviderHeaders', 'Invoke-ApiRequest', 'Normalize-Result', 'Search-GitHub', 'Search-Gitee', 'Search-GitLab')
        $defs = @()
        foreach ($fn in $needed) { if (Test-Path "function:$fn") { $defs += "function $fn { $((Get-Item function:$fn).Definition) }" } }
        $pool = [runspacefactory]::CreateRunspacePool(1, [math]::Max(1, $Engines.Count))
        $pool.ApartmentState = 'MTA'; $pool.Open()
        $handles = @()
        foreach ($e in $Engines) {
            $ps = [powershell]::Create(); $ps.RunspacePool = $pool
            [void]$ps.AddScript({
                param($Defs, $Engine, $Query, $Language, $MinStars, $Limit)
                foreach ($d in $Defs) { . ([scriptblock]::Create($d)) }
                if ($Engine -eq "GitHub") { Search-GitHub $Query $Language $MinStars $Limit }
                elseif ($Engine -eq "Gitee") { Search-Gitee $Query $MinStars $Limit }
                elseif ($Engine -eq "GitLab") { Search-GitLab $Query $MinStars $Limit }
            }).AddArgument($defs).AddArgument($e).AddArgument($Query).AddArgument($Language).AddArgument($MinStars).AddArgument($Limit)
            $h = $ps.BeginInvoke(); $handles += [PSCustomObject]@{ PS=$ps; Handle=$h; Engine=$e }
        }
        foreach ($h in $handles) {
            try { $res = $h.PS.EndInvoke($h.Handle); if ($res) { $all = @($all) + @($res) } }
            catch { cw "  [$($h.Engine)] 并发检索异常(已跳过): $_" "Red" }
            finally { try { $h.PS.Dispose() } catch { } }
        }
        $pool.Close(); $pool.Dispose()
    }
    catch {
        cw "  [Smart] 并发池不可用，回退串行: $_" "Yellow"
        foreach ($e in $Engines) {
            if ($e -eq "GitHub") { $all = @($all) + @(Search-GitHub $Query $Language $MinStars $Limit) }
            elseif ($e -eq "Gitee") { $all = @($all) + @(Search-Gitee $Query $MinStars $Limit) }
            elseif ($e -eq "GitLab") { $all = @($all) + @(Search-GitLab $Query $MinStars $Limit) }
        }
    }
    return $all
}

function Normalize-Query($q) { $noise=@("a","an","the","of","for","and","or","to","in","on","with","project","code"); return @($q.ToLower() -split "\s+" | Where-Object { $_ -and $_.Length -gt 1 -and $noise -notcontains $_ } | Select-Object -Unique) }
function Search-GrepApp($q, $limit = 20) {
    $uri=New-ApiUri "https://grep.app/api/search" @{ q=$q; regexp="false"; case="true" }; Write-Host "  [grep.app] Searching" -ForegroundColor "Gray"; $r=Invoke-ApiRequest $uri "grep.app"; if (-not $r) { return @() }
    try { $d=$r.Content | ConvertFrom-Json; $out=@(); foreach ($h in $d.hits.hits) { $repo=$h.repo.raw; $pth=$h.path.raw; $snip=$h.content.snippet -replace "<[^>]+>",""; $out += [PSCustomObject]@{ Name=$repo; Stars=0; URL="https://github.com/$repo/blob/$($h.branch)/$pth#L$($h.content.line_number)"; Desc="[$pth] $snip"; Platform="grep.app"; Repo=$repo; Path=$pth; MatchCount=1; Snippet=$snip } }; return $out } catch { return @() }
}
function Search-Sourcegraph($q, $limit = 20) {
    $uri=New-ApiUri "https://sourcegraph.com/.api/search/stream" @{ q=$q; v="V3"; t="literal"; sm="0"; display=$limit; cm="f" }
    Write-Host "  [Sourcegraph] Searching" -ForegroundColor "Gray"
    $r=Invoke-ApiRequest $uri "Sourcegraph" 20
    if (-not $r) { return @() }
    $out=@()
    foreach ($line in ($r.Content -split "`n")) {
        if ($line.Trim() -match '^data: (.+)$') {
            try {
                foreach ($m in @($Matches[1] | ConvertFrom-Json)) {
                    if ($m.type -eq "content" -and $m.repository) {
                        $preview=if ($m.lineMatches.Count -gt 0) { $m.lineMatches[0].line } else { "" }
                        $out += [PSCustomObject]@{ Name=$m.repository; Stars=if ($m.repoStars) {[int]$m.repoStars} else {0}; URL="https://sourcegraph.com/$($m.repository)/-/blob/$($m.path)"; Desc="[$($m.path)] $preview"; Platform="Sourcegraph"; Repo=$m.repository; Path=$m.path; MatchCount=@($m.lineMatches).Count; Snippet=$preview }
                    }
                }
            } catch {}
        }
    }
    return $out
}
function Merge-Dedupe($groups) { $seen=@{}; $out=@(); foreach ($group in $groups) { foreach ($item in $group) { $key="$($item.Repo):$($item.Path)"; if (-not $seen.ContainsKey($key)) { $seen[$key]=$true; $out += $item } } }; return $out }
function Score-Result($item, $q) { $terms=Normalize-Query $q; $haystack="$($item.Name) $($item.Repo) $($item.Path) $($item.Snippet) $($item.Desc)".ToLower(); $matched=@($terms | Where-Object { $haystack.Contains($_) }).Count; $relevance=if ($terms.Count) {[Math]::Round(($matched/$terms.Count)*100)} else {50}; $popularity=[Math]::Min(100,[Math]::Log10(($item.Stars+1))*20); $density=if ($item.MatchCount) {[Math]::Min(100,$item.MatchCount*20)} else {0}; $item | Add-Member Score ([Math]::Round($relevance*.5+$popularity*.2+$density*.3)) -Force; $item | Add-Member Relevance $relevance -Force; return $item }
function Search-Code($q, $limit = 20) {
    Write-Host "═══ Code-level search: grep.app + Sourcegraph ═══" -ForegroundColor "Magenta"
    $groups=@()
    if ($CodePlatform -eq "All" -or $CodePlatform -eq "GrepApp") { $groups += @(Search-GrepApp $q $limit) }
    if ($CodePlatform -eq "All" -or $CodePlatform -eq "Sourcegraph") { $groups += @(Search-Sourcegraph $q $limit) }
    return @((Merge-Dedupe $groups) | ForEach-Object { Score-Result $_ $q } | Sort-Object Score -Descending)
}

function Get-RepositoryScore($item, $q) { $terms=Normalize-Query $q; $text="$($item.Name) $($item.Desc)".ToLower(); $matches=@($terms | Where-Object { $text.Contains($_) }).Count; $relevance=if ($terms.Count) {$matches/$terms.Count} else {0}; return (($relevance * 1000) + [Math]::Log10(([double]$item.Stars + 1)) * 100) }
function Show-Results($results) { if (-not $results -or $results.Count -eq 0) { cw "No results found." "Yellow"; return }; cw ""; cw "═══════════════════════════════════════" "Magenta"; cw "  All Platform Results  (Top $($results.Count))" "Magenta"; cw "═══════════════════════════════════════"; cw ""; $i=1; foreach ($r in $results) { cw "  [$i] Stars: $($r.Stars)  ·  $($r.Platform)  ·  $($r.Name)" "White"; cw "       $($r.URL)" "Cyan"; if ($r.Desc) { cw "       $($r.Desc.Substring(0,[Math]::Min(100,$r.Desc.Length)))" "Gray" }; cw ""; $i++ } }

function Get-DefaultBranch($platform, $fullName) {
    if ($platform -eq "GitHub") { $uri="https://api.github.com/repos/$($fullName.Split('/') | ForEach-Object {[Uri]::EscapeDataString($_)} -join '/')" }
    elseif ($platform -eq "Gitee") { $uri="https://gitee.com/api/v5/repos/$($fullName.Split('/') | ForEach-Object {[Uri]::EscapeDataString($_)} -join '/')" }
    else { $uri="https://gitlab.com/api/v4/projects/$([Uri]::EscapeDataString($fullName))" }
    $response=Invoke-ApiRequest $uri $platform; if (-not $response) { return $null }; try { return (($response.Content | ConvertFrom-Json).default_branch) } catch { return $null }
}
function Invoke-Download($repoUrl, $outputDir = ".\downloads") {
    $repoUri=[Uri]$repoUrl; $platformMap=@{"github.com"="GitHub";"gitee.com"="Gitee";"gitlab.com"="GitLab"}; $plat=$platformMap[$repoUri.Host.ToLower()]
    if (-not $plat) { cw "[!] Unsupported repository URL: $repoUrl" "Red"; return }
    $parts=@($repoUri.AbsolutePath.Trim('/') -split '/'); if ($parts.Count -lt 2) { cw "[!] Cannot parse repository URL: $repoUrl" "Red"; return }; $fullName="$($parts[0])/$($parts[1])"; $repoName=$parts[1]
    $branch=Get-DefaultBranch $plat $fullName; if (-not $branch) { cw "[Download] Could not get default branch for $fullName" "Yellow"; return }
    if (-not (Test-Path $outputDir)) { New-Item -ItemType Directory -Path $outputDir -Force | Out-Null }
    $target=Join-Path $outputDir $repoName; if (Test-Path $target) { $target=Join-Path $outputDir ("{0}-{1}" -f $repoName,(Get-Date -Format "yyyyMMddHHmmssfff")) }
    $outZip=Join-Path $outputDir ("{0}.zip" -f [Guid]::NewGuid().ToString("N"))
    if ($plat -eq "GitHub") { $zipUrl="https://api.github.com/repos/$fullName/zipball/$([Uri]::EscapeDataString($branch))" }
    elseif ($plat -eq "Gitee") { $zipUrl="https://gitee.com/api/v5/repos/$fullName/zipball/$([Uri]::EscapeDataString($branch))" }
    else { $zipUrl=New-ApiUri "https://gitlab.com/api/v4/projects/$([Uri]::EscapeDataString($fullName))/repository/archive.zip" @{ sha=$branch } }
    cw "Downloading $fullName ($branch)" "Cyan"; $download=Invoke-ApiRequest $zipUrl $plat 120 $outZip
    if (-not $download -or -not (Test-Path $outZip) -or (Get-Item $outZip).Length -eq 0) { if (Test-Path $outZip) { Remove-Item $outZip -Force }; return }
    try { New-Item -ItemType Directory -Path $target -Force | Out-Null; Expand-Archive $outZip -DestinationPath $target -Force; Remove-Item $outZip -Force; $inner=Get-ChildItem $target -Directory | Select-Object -First 1; if ($inner) { Get-ChildItem $inner.FullName -Force | Move-Item -Destination $target -Force; Remove-Item $inner.FullName -Recurse -Force }; cw "[Download] $target" "Green" } catch { cw "[Download] Extract failed" "Red" }
}

$primaryQuery=""; $analysis=@{}
$plannerPath = Join-Path $scriptDir 'query-planner.ps1'
if ($CustomKeywords) { cw ""; cw "Custom keywords: $CustomKeywords" "Cyan"; $primaryQuery=$CustomKeywords; $analysis=@{ Language=$null; Frameworks=@(); ProjectType=$null } }
else {
    $analysis=Analyze-Project -ProjectPath $ProjectPath
    if ($analysis.ProjectName) { cw "  Name: $($analysis.ProjectName)" "White" }; if ($analysis.ProjectType) { cw "  Type: $($analysis.ProjectType)" "White" }; if ($analysis.Language) { cw "  Lang: $($analysis.Language)" "White" }; if ($analysis.Frameworks.Count -gt 0) { cw "  FW: $($analysis.Frameworks -join ', ')" "White" }; cw ""
    if ($analysis.Keywords.Count -gt 0) { $primaryQuery=($analysis.Keywords | Select-Object -First 5) -join " " } elseif ($analysis.ProjectType) { $primaryQuery="$($analysis.ProjectType) project" } else { $primaryQuery="code project" }
    if ($AnalyzeOnly) { cw "Generated query: $primaryQuery" "Cyan"; $elapsed=[int]((Get-Date)-$script:RunStart).TotalMilliseconds; cw "Metrics: ElapsedMs=$elapsed ResultCount=0 CacheHit=False WorkingSetMB=$([Math]::Round((Get-Process -Id $PID).WorkingSet64 / 1MB,2))" "Gray"; exit 0 }
    cw "Search query: $primaryQuery" "Cyan"; cw ""
}
$plan = $null
if (Test-Path $plannerPath) {
    # 用哈希表展开（而非数组展开）调用 planner：PS 5.1 数组展开在参数值含空格时会
    # 误把值当作位置参数导致 ParameterBindingException，哈希表展开可避免该问题。
    $planSplat = @{ Query = $primaryQuery; QueryType = $QueryType }
    if ($PlanOutput) { $planSplat['OutputPath'] = $PlanOutput }
    try {
        $planRaw = & $plannerPath @planSplat 2>&1
        if ($planRaw -is [System.Array]) { $planRaw = $planRaw -join "`n" }
        # 容忍 planner 输出的非 JSON 噪声：抽取首个 {...} JSON 对象
        $m = [regex]::Match($planRaw, '\{.*\}', [Text.RegularExpressions.RegexOptions]::Singleline)
        if ($m.Success) { $plan = $m.Value | ConvertFrom-Json }
        else { cw "  [Planner] 未返回有效 JSON，跳过规划步骤，继续直接检索" "Yellow" }
    } catch {
        cw "  [Planner] 执行失败，跳过规划步骤，继续直接检索: $($_.Exception.Message)" "Yellow"
    }
    if ($plan) {
        cw "Query plan: $($plan.queryType) confidence=$($plan.confidence)" "DarkCyan"
        if ($PlanOutput) {
            & (Join-Path $scriptDir 'validate-query-plan.ps1') -PlanPath $PlanOutput 2>&1 | Out-Null
        }
    }
}
$cacheKey=Get-CacheKey $primaryQuery $Platform $analysis.Language $MinStars $Limit; $cache=Load-Cache; $allResults=@(Get-CachedResults $cache $cacheKey)
if ($allResults.Count -gt 0) {
    $script:CacheHit=$true
    $cachedCount=$allResults.Count
    cw "[Cache] Using cached results" "Yellow"
} else {
    cw "Searching across platforms..." "Magenta"
    cw ""
    $engines = @()
    if ($Platform -eq "All" -or $Platform -eq "GitHub") { $engines += "GitHub" }
    if ($Platform -eq "All" -or $Platform -eq "Gitee") { $engines += "Gitee" }
    if ($Platform -eq "All" -or $Platform -eq "GitLab") { $engines += "GitLab" }
    $allResults += Invoke-ConcurrentRepoSearch -Engines $engines -Query $primaryQuery -Language $analysis.Language -MinStars $MinStars -Limit $Limit
    Save-Cache $cache $cacheKey $allResults
}
# 防御：仅保留“带 Name 属性的数据对象”，过滤任何泄漏到结果数组中的状态字符串（本环境 '-is [PSCustomObject]' 对 [string] 误判为 True，故用属性存在性判定）
$allResults=@($allResults | Where-Object { $_.PSObject.Properties.Name -contains 'Name' } | ForEach-Object { $_ | Add-Member -NotePropertyName SearchScore -NotePropertyValue (Get-RepositoryScore $_ $primaryQuery) -Force; $_ } | Sort-Object SearchScore, Stars -Descending)
if ($CodeSearch) { $codeResults=@(Search-Code $primaryQuery $CodeLimit) }
Show-Results $allResults
if ($OutputCSV) { $csvPath=if ([IO.Path]::IsPathRooted($OutputCSV)) {$OutputCSV} else {Join-Path (Get-Location) $OutputCSV}; $allResults | Select-Object Name,Platform,Stars,URL,Desc | Export-Csv $csvPath -NoTypeInformation -Encoding UTF8; cw "[CSV] Exported: $csvPath" "Green" }
if ($AutoDownload -and $allResults.Count -gt 0) { $downloadDir=if ($OutputDir) {$OutputDir} else {".\downloads"}; cw ""; cw "═══ Auto-downloading top $AutoDownloadCount ═══" "Magenta"; $allResults | Select-Object -First $AutoDownloadCount | ForEach-Object { if ($_.URL) { Invoke-Download $_.URL $downloadDir } } }
$elapsed=[int]((Get-Date)-$script:RunStart).TotalMilliseconds; $workingSet=[Math]::Round((Get-Process -Id $PID).WorkingSet64 / 1MB,2); cw ""; cw "Metrics: ElapsedMs=$elapsed ResultCount=$($allResults.Count) CacheHit=$($script:CacheHit) WorkingSetMB=$workingSet" "Gray"; cw "Done" "Green"
