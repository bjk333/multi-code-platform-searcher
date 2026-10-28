# tests/u244-proxy-coverage-harness.ps1 —— U-244（B1-3）离线门的数据面：**只出事实**，判定在 test-u244-proxy-coverage.test.mjs。
#
# 为什么要有这条门（验收问题 F6 的实证，2026-10-25 本机）：
#   `.env` 里 `MCPS_PROXY=socks5://127.0.0.1:7897;api.github.com,github.com,raw.githubusercontent.com`
#   ⇒ **gitlab.com 不在白名单** ⇒ GitLab/GitLabBlobs 只能走其余候选，实测等满 12.1s / 17.1s 截止；
#   而 `-Doctor` 此前只报"白名单域 3 个"，**没有任何一处说得出"gitlab.com 被排除了"**。
#
# 本门两条纪律：
#   ① **零网络、零本机配置依赖**：真值表全部用注入的 spec + 注入的候选来源，不读 .env / 不发包。
#      读真实环境的分支留给 `-Doctor` 的人读输出，不进断言（否则门会因机器配置变红 = U-158E 那类环境红）。
#   ② **不另写白名单解析**：一切判定经 Get-McpsProxySpec / Test-NetworkNoProxy（U-207 的单一来源）。
#      门里若出现第二份 `-split ';'`，mjs 侧会把它判红。
param([string]$SkillDir = '')
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
if (-not $SkillDir) { $SkillDir = (Resolve-Path (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '..')).Path }
$SkillDir = (Resolve-Path $SkillDir).Path
$ms = Join-Path $SkillDir 'multi-platform-searcher.ps1'
$env:MCPS_NO_MAIN = '1'
. $ms

$fails = @()
$registry = @($script:_engineRegistry | ForEach-Object {
        [PSCustomObject]@{ Engine = [string]$_.Name; Kind = [string]$_.Kind; Host = [string]$_.Host; Func = [string]$_.Func }
    })

function Case([string]$id, [string]$targetHost, [string]$proxySpec, [string]$noProxySpec, [string[]]$candidates) {
    $r = Resolve-ProxyCoverage -HostName $targetHost -ProxySpec $proxySpec -NoProxySpec $noProxySpec -CandidateSources $candidates
    return [PSCustomObject]@{
        id = $id; Host = [string]$r.Host; Route = [string]$r.Route; Chain = [string]$r.Chain
        Whitelist = [string]$r.Whitelist; Excluded = [bool]$r.Excluded; OnlyDirect = [bool]$r.OnlyDirect; NoProxy = [bool]$r.NoProxy
    }
}

# ---------- 真值表（每条都对应一个真实失败形态）----------
$rows = @()
# 1. F6 本机原样：白名单只有 GitHub，gitlab.com 被排除，但还有别的代理候选 ⇒ 不该报"只剩直连"
$rows += Case 'excluded-but-other-proxy' 'gitlab.com' 'socks5://127.0.0.1:7897;api.github.com,github.com' '' @('HTTPS_PROXY', 'system', 'direct')
# 2. 被排除且**只剩直连** ⇒ 这才是必须报红的形态（OnlyDirect=true）
$rows += Case 'excluded-direct-only' 'gitlab.com' 'socks5://127.0.0.1:7897;api.github.com' '' @('direct')
# 3. 白名单补齐 ⇒ 走 mcps-proxy，不再算排除
$rows += Case 'covered' 'gitlab.com' 'socks5://127.0.0.1:7897;api.github.com,gitlab.com' '' @('MCPS_PROXY', 'direct')
# 4. 没有分号 = 没有白名单 ⇒ 全放行
$rows += Case 'no-whitelist' 'gitlab.com' 'socks5://127.0.0.1:7897' '' @('MCPS_PROXY', 'direct')
# 5. MCPS_PROXY_FALLBACK=1 生效时，候选里是 'MCPS_PROXY(fallback)' ⇒ 已放行，不算排除
$rows += Case 'fallback-active' 'gitlab.com' 'socks5://127.0.0.1:7897;api.github.com' '' @('MCPS_PROXY(fallback)', 'direct')
# 6. NO_PROXY 命中 ⇒ Route 直连且 NoProxy=true（Maven 的真实形态）
$rows += Case 'no-proxy-hit' 'search.maven.org' 'socks5://127.0.0.1:7897;api.github.com' 'search.maven.org,repo.maven.apache.org' @('direct')
# 7. NO_PROXY 未命中 ⇒ NoProxy=false（负对照，防止"恒 true"）
$rows += Case 'no-proxy-miss' 'gitlab.com' 'socks5://127.0.0.1:7897;api.github.com' 'search.maven.org' @('direct')
# 8. ★**已记录的现状**（不是期望行为）：http:// 形态的 MCPS_PROXY 不被 Get-McpsProxySpec 识别（只认 socks5/socks5h）
#    ⇒ 白名单整段失效、连该代理本身都不进候选。此处把现状钉住：哪天要支持 http 白名单，这条会先红，改它就是改契约。
$rows += Case 'http-spec-ignored-documented' 'gitlab.com' 'http://127.0.0.1:3128;api.github.com' '' @('HTTPS_PROXY', 'direct')

# ---------- 生产路径回归（★B1-3 真弄坏过，被老门 U-155/U-156 当场抓住）----------
#   2026-10-25 第一轮全量：`U-156 NO_PROXY ignored`。根因是 `Test-NetworkNoProxy` 的 `-Spec` 判据写成了
#   `if ($null -ne $Spec)` —— PowerShell 对 `[string]` 形参的默认值 `$null` 会落成**空串**，
#   于是"没传"与"传了空串"在值上不可区分 ⇒ **生产路径（不传 -Spec）** 走进"明确没有 NO_PROXY"，
#   把用户的 NO_PROXY 整体忽略。上面 8 个用例全部**显式传 -Spec**，一条都测不到这个 bug。
#   所以这条用例的形态刻意是"**不传 -Spec**"，并真的设一次进程环境变量（用完还原）。
$prodPath = $false
$prodPathNoSpec = $false
$oldNoProxy = $env:NO_PROXY
try {
    $env:NO_PROXY = 'prod-path.invalid'
    $prodPath = [bool](Test-NetworkNoProxy -Target ([uri]'https://prod-path.invalid/'))        # 不传 -Spec ⇒ 必须读环境
    $prodPathNoSpec = [bool](Test-NetworkNoProxy -Target ([uri]'https://prod-path.invalid/') -Spec '')  # 传空串 ⇒ 必须 false
} finally { $env:NO_PROXY = $oldNoProxy }

# ---------- 结构事实（判定在 mjs）----------
foreach ($e in $registry) {
    if (-not $e.Host) { $fails += ("registry missing Host: {0}" -f $e.Engine) }
    elseif ($e.Host -notmatch '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$') { $fails += ("registry Host malformed: {0}={1}" -f $e.Engine, $e.Host) }
}

$out = [PSCustomObject]@{ ok = (@($fails).Count -eq 0); fails = @($fails); registry = @($registry); cases = @($rows); prodPath = $prodPath; prodPathNoSpec = $prodPathNoSpec }
$out | ConvertTo-Json -Depth 6 -Compress
if (@($fails).Count -gt 0) { exit 1 }