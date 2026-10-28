# tests/u258-engine-contract-harness.ps1 —— U-258（B2-1 + B2-2）的数据面：**跑真函数**，只桩传输与磁盘。
#
# 为什么不能只读源码：契约的失败模式几乎全是"运行时才成立"的——
#   ① 封套被当成一条结果塞进结果集（`$all += $res` 的经典形态）—— 正则看不出来；
#   ② 引擎自报 status 与 L1 派生 status 不一致 —— 只有真跑两边才有得比；
#   ③ 旧引擎（engine/0）在兼容层之后**行为必须逐位不变** —— 这是"改了等于没改"的唯一证据。
#
# 七个臂：
#   A HF 成功（1 条/kind）      → engine/1 封套字段完整 + verdict=ok
#   B HF 零命中（'[]'）         → verdict=empty / zero-hit（不是 error）
#   C HF 全失败（传输 throw）   → verdict=error + requests 3/0/3
#   D 兼容层三形态（数组/空/单对象）→ engine/0，results 逐条一致，**不派生 verdict**
#   E verdict 判定矩阵（纯函数表驱动）→ 8 行 + 旧状态映射
#   F 混跑真池：1 个 engine/1 + 1 个 engine/0 → 结果并集正确、封套不漏进结果、两个源各自状态正确
#   G 串行回退路径：Invoke-EngineSerial 拿封套时返回的是 results，不是封套本身
param([string]$SkillDir = '')
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
if (-not $SkillDir) { $SkillDir = (Resolve-Path (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '..')).Path }
$SkillDir = (Resolve-Path $SkillDir).Path
$env:MCPS_NO_MAIN = '1'
$env:MCPS_HEALTH = '0'
. (Join-Path $SkillDir 'multi-platform-searcher.ps1')
# ★必须在桩之前把 AsJson 打开：`Write-ColorOutput` 在**输出被重定向**时走 `Write-Output`（L743），
#   于是引擎的提示语会混进函数的**输出流**，harness 里 `$envl = Search-HuggingFace` 拿到的是 @(提示语…, 封套)。
#   生产里 -AsJson 走的就是"提前 return"这条，所以这里对齐的正是被验收的那条路径；顺带也说明：
#   **非 AsJson 时引擎输出流里本来就有提示语**，池侧靠下游过滤容忍它 —— 这是既有行为，B2 不改。
$script:AsJson = $true

# ---------- 只桩"发网"与"落盘"，不桩契约逻辑 ----------
function Update-EngineHealthFromPool { param($Engines) }
function Write-SlowEngineWarnings { param($Engines, $Timings, [int]$MinMs) }
function Add-EngineWarning { param([string]$Engine, [string]$Message, [string]$From = '', [string]$To = '') }

$fails = @()
function Check([string]$id, [bool]$cond, [string]$detail = '') { if (-not $cond) { $script:fails += ("{0}: {1}" -f $id, $detail) } }

# ---------- A/B/C：HF 三臂 ----------
function Arm-HF([string]$id, [scriptblock]$stub) {
    Set-Item -Path function:Invoke-ApiRequest -Value $stub
    Remove-Item -Path variable:script:_engineVerdict -ErrorAction SilentlyContinue
    $script:_engineVerdict = [System.Collections.Concurrent.ConcurrentDictionary[string, object]]::new()
    $envl = Search-HuggingFace -Keyword 'x' -Limit 2
    $v = Resolve-EngineVerdict -Envelope $envl
    return [PSCustomObject]@{
        id = $id; contract = [string]$envl.contract; engine = [string]$envl.engine; kind = [string]$envl.kind
        n = @($envl.results).Count; partial = [bool]$envl.partial
        elapsedMs = $envl.elapsedMs
        attempted = [int]$envl.requests.attempted; succeeded = [int]$envl.requests.succeeded; failed = [int]$envl.requests.failed
        quotaClass = [string]$envl.quota.class
        hasFailure = ($null -ne $envl.failure)
        failureCode = if ($envl.failure) { [string]$envl.failure.reasonCode } else { '' }
        vStatus = [string]$v.Status; vCode = [string]$v.ReasonCode; legacy = [string](ConvertTo-LegacyEngineStatus -Verdict $v)
        # 封套字段完整性（B2-1 验收：字段完整）
        fields = @($envl.PSObject.Properties.Name | Sort-Object)
    }
}
$hfOk = Arm-HF 'A' { param($Uri, $Headers, $TimeoutSec, $Method, $Body, $NoProxy, $MaxAttempts, $NodeDeadlineSec, $DeadlineSec)
    return [PSCustomObject]@{ Content = '[{"id":"probe","downloads":7,"likes":1}]'; StatusCode = 200; Headers = @{} }
}
$hfZero = Arm-HF 'B' { param($Uri, $Headers, $TimeoutSec, $Method, $Body, $NoProxy, $MaxAttempts, $NodeDeadlineSec, $DeadlineSec)
    return [PSCustomObject]@{ Content = '[]'; StatusCode = 200; Headers = @{} }
}
$hfFail = Arm-HF 'C' { param($Uri, $Headers, $TimeoutSec, $Method, $Body, $NoProxy, $MaxAttempts, $NodeDeadlineSec, $DeadlineSec)
    throw 'stub: transport boom'
}
Check 'A.contract' ($hfOk.contract -eq 'engine/1') $hfOk.contract
Check 'A.engine' ($hfOk.engine -eq 'HF') $hfOk.engine
Check 'A.kind' ($hfOk.kind -eq 'research') $hfOk.kind
Check 'A.results' ($hfOk.n -eq 3) "n=$($hfOk.n)（三 kind 各 1 条）"
Check 'A.verdict' ($hfOk.vStatus -eq 'ok' -and $hfOk.vCode -eq '') "$($hfOk.vStatus)/$($hfOk.vCode)"
Check 'A.requests' ($hfOk.attempted -eq 3 -and $hfOk.succeeded -eq 3 -and $hfOk.failed -eq 0) "$($hfOk.attempted)/$($hfOk.succeeded)/$($hfOk.failed)"
Check 'A.elapsedMs 是数' ($hfOk.elapsedMs -is [int] -and $hfOk.elapsedMs -ge 0) "$($hfOk.elapsedMs)"
Check 'A.quota.class' ($hfOk.quotaClass -eq 'anonymous') $hfOk.quotaClass
Check 'A.无 failure' (-not $hfOk.hasFailure) ''
$wantFields = @('contract', 'elapsedMs', 'engine', 'failure', 'kind', 'partial', 'quota', 'requests', 'results')
Check 'A.封套字段集' (@(Compare-Object $wantFields $hfOk.fields).Count -eq 0) ($hfOk.fields -join ',')

Check 'B.零命中是 empty 不是 error' ($hfZero.vStatus -eq 'empty' -and $hfZero.vCode -eq 'zero-hit') "$($hfZero.vStatus)/$($hfZero.vCode)"
Check 'B.legacy' ($hfZero.legacy -eq 'empty') $hfZero.legacy
Check 'B.请求仍算成功' ($hfZero.attempted -eq 3 -and $hfZero.succeeded -eq 3) "$($hfZero.attempted)/$($hfZero.succeeded)"

Check 'C.全失败 verdict' ($hfFail.vStatus -eq 'error') "$($hfFail.vStatus)/$($hfFail.vCode)"
Check 'C.失败账' ($hfFail.attempted -eq 3 -and $hfFail.succeeded -eq 0 -and $hfFail.failed -eq 3) "$($hfFail.attempted)/$($hfFail.succeeded)/$($hfFail.failed)"
Check 'C.legacy=error' ($hfFail.legacy -eq 'error') $hfFail.legacy
Check 'C.failure 有码' ($hfFail.hasFailure -and $hfFail.failureCode -eq 'error') $hfFail.failureCode

# ---------- D：兼容层三形态 ----------
$raw = @([PSCustomObject]@{ Index = 1; Name = 'a' }, [PSCustomObject]@{ Index = 2; Name = 'b' })
$cArr = ConvertTo-EngineEnvelope -Engine 'Old' -Kind 'repo' -Result $raw
$cEmpty = ConvertTo-EngineEnvelope -Engine 'Old' -Kind 'repo' -Result @()
$cNull = ConvertTo-EngineEnvelope -Engine 'Old' -Kind 'repo' -Result $null
$cOne = ConvertTo-EngineEnvelope -Engine 'Old' -Kind 'repo' -Result ([PSCustomObject]@{ Index = 1; Name = 'solo' })
$cPass = ConvertTo-EngineEnvelope -Engine 'HF' -Kind 'research' -Result (New-EngineEnvelope -Engine 'HF' -Kind 'research' -Results @([PSCustomObject]@{ Index = 1 }))
Check 'D.数组→engine/0' ($cArr.contract -eq 'engine/0' -and @($cArr.results).Count -eq 2) "$($cArr.contract)/$(@($cArr.results).Count)"
Check 'D.空→engine/0' ($cEmpty.contract -eq 'engine/0' -and @($cEmpty.results).Count -eq 0) "$($cEmpty.contract)"
Check 'D.$null→engine/0' ($cNull.contract -eq 'engine/0' -and @($cNull.results).Count -eq 0) "$($cNull.contract)"
Check 'D.单对象不被误判成封套' ($cOne.contract -eq 'engine/0' -and @($cOne.results).Count -eq 1) "$($cOne.contract)/$(@($cOne.results).Count)"
Check 'D.已是封套则透传' ($cPass.contract -eq 'engine/1') $cPass.contract
# ★engine/0 **不派生 verdict**：调用方必须走旧路径（写进结果的只有这一个布尔，mjs 层据此钉住"兼容层不改行为"）
$dNoVerdict = ($null -eq $cArr.failure -and $null -eq $cArr.requests -and [string]$cArr.contract -eq 'engine/0')
Check 'D.engine/0 不带判定材料' $dNoVerdict ''

# ---------- E：verdict 判定矩阵 ----------
# ★`1..0` 在 PS 里是 @(1,0)（**两元素**，不是空）—— 这样写会让"零命中"臂静默变成"有 2 条结果"，
#   于是 E2 被验成 degraded 而看不出门有问题。用显式分支。
$mk = { param($n, $f) $arr = if ($n -gt 0) { @(1..$n | ForEach-Object { [PSCustomObject]@{ Index = $_ } }) } else { @() }; [PSCustomObject]@{ results = $arr; failure = $f } }
$rows = @(
    @{ id = 'E1'; env = (& $mk 2 $null); st = 'ok'; rc = ''; legacy = 'ok' }
    @{ id = 'E2'; env = (& $mk 0 $null); st = 'empty'; rc = 'zero-hit'; legacy = 'empty' }
    @{ id = 'E3'; env = (& $mk 1 @{ reasonCode = 'rate-limited'; reason = 'r' }); st = 'degraded'; rc = 'rate-limited'; legacy = 'ok' }
    @{ id = 'E4'; env = (& $mk 0 @{ reasonCode = 'missing-credential'; reason = 'r' }); st = 'blocked'; rc = 'missing-credential'; legacy = 'auth_missing' }
    @{ id = 'E5'; env = (& $mk 0 @{ reasonCode = 'tool-missing'; reason = 'r' }); st = 'blocked'; rc = 'tool-missing'; legacy = 'tool_missing' }
    @{ id = 'E6'; env = (& $mk 0 @{ reasonCode = 'health-skip'; reason = 'r' }); st = 'blocked'; rc = 'health-skip'; legacy = 'unknown' }
    @{ id = 'E7'; env = (& $mk 0 @{ reasonCode = 'rate-limited'; reason = 'r' }); st = 'error'; rc = 'rate-limited'; legacy = 'rate_limited' }
    @{ id = 'E8'; env = (& $mk 0 @{ reasonCode = 'network-unavailable'; reason = 'r' }); st = 'error'; rc = 'network-unavailable'; legacy = 'network_unavailable' }
    @{ id = 'E9'; env = (& $mk 0 @{ reasonCode = 'deadline'; reason = 'r' }); st = 'error'; rc = 'deadline'; legacy = 'error' }
    @{ id = 'E10'; env = (& $mk 0 @{ reasonCode = ''; reason = '' }); st = 'error'; rc = 'error'; legacy = 'error' }
)
$eRows = @()
foreach ($r in $rows) {
    $v = Resolve-EngineVerdict -Envelope $r.env
    $lg = [string](ConvertTo-LegacyEngineStatus -Verdict $v)
    $eRows += [PSCustomObject]@{ id = $r.id; status = [string]$v.Status; code = [string]$v.ReasonCode; legacy = $lg }
    Check "$($r.id)" (([string]$v.Status -eq $r.st) -and ([string]$v.ReasonCode -eq $r.rc) -and ($lg -eq $r.legacy)) "期望 $($r.st)/$($r.rc)/$($r.legacy) 实得 $($v.Status)/$($v.ReasonCode)/$lg"
}

# ---------- F：混跑真池（1 新 + 1 旧）----------
function Fake-EnvelopeEngine { param($Keyword, $Limit)
    return New-EngineEnvelope -Engine 'Fake1' -Kind 'research' -Results @([PSCustomObject]@{ Index = 1; Platform = 'HuggingFace'; Name = 'new' }) -Requests @{ attempted = 1; succeeded = 1; failed = 0 }
}
function Fake-LegacyEngine { param($Keyword, $Limit)
    return @([PSCustomObject]@{ Index = 1; Platform = 'arXiv'; Name = 'oldA' }, [PSCustomObject]@{ Index = 2; Platform = 'arXiv'; Name = 'oldB' })
}
$fake = @(
    @{ Name = 'Fake1'; Kind = 'research'; Platforms = @('HuggingFace'); Func = 'Fake-EnvelopeEngine'; Needs = @('New-EngineEnvelope') }
    @{ Name = 'Fake2'; Kind = 'research'; Platforms = @('arXiv'); Func = 'Fake-LegacyEngine'; Needs = @() }
)
$script:_engineVerdict = [System.Collections.Concurrent.ConcurrentDictionary[string, object]]::new()
$merged = @(Invoke-EnginePool -Engines $fake -Label 'harness' -TrackStatus -EngineArgs @{ Keyword = 'x'; Limit = 5 })
$leak = @($merged | Where-Object { $_.PSObject.Properties['contract'] }).Count
Check 'F.结果并集' (@($merged).Count -eq 3) "n=$(@($merged).Count)"
Check 'F.封套不漏进结果' ($leak -eq 0) "leak=$leak"
Check 'F.Fake1 状态' ((Get-EngineStatus -Name 'Fake1') -eq 'ok') (Get-EngineStatus -Name 'Fake1')
Check 'F.Fake2 状态（旧路径不变）' ((Get-EngineStatus -Name 'Fake2') -eq 'ok') (Get-EngineStatus -Name 'Fake2')
Check 'F.Fake1 有 verdict' ($script:_engineVerdict.ContainsKey('Fake1')) ''
Check 'F.Fake2 无 verdict（engine/0 不派生）' (-not $script:_engineVerdict.ContainsKey('Fake2')) ''

# ---------- G：串行回退路径 ----------
$ser = @(Invoke-EngineSerial -Engine $fake[0] -EngineArgs @{ Keyword = 'x'; Limit = 5 })
Check 'G.串行返回 results 而非封套' ($ser.Count -eq 1 -and -not $ser[0].PSObject.Properties['contract']) "n=$($ser.Count)"

# ---------- H：per-round 重置 ----------
# 反例形态：上一轮 HF 记了 rate-limited，这一轮它被 deadline 杀掉（走 engine/0，不写 verdict）——
#   若不清空，coverage 会拿上一轮的码当这一轮的证据。这是"旧事实冒充新证据"，本仓吃过多次。
$script:_engineVerdict['HF'] = [PSCustomObject]@{ Status = 'error'; ReasonCode = 'rate-limited'; Reason = 'stale' }
$staleBefore = $script:_engineVerdict.ContainsKey('HF')
Reset-EngineVerdicts
$staleAfter = $script:_engineVerdict.ContainsKey('HF')
Check 'H.重置前确有脏值' $staleBefore ''
Check 'H.重置后必须为空' (-not $staleAfter) ''

[PSCustomObject]@{
    ok    = (@($fails).Count -eq 0)
    fails = @($fails)
    hf    = @($hfOk, $hfZero, $hfFail)
    compat = @([PSCustomObject]@{ arr = @($cArr.results).Count; empty = @($cEmpty.results).Count; one = @($cOne.results).Count; passThrough = $cPass.contract })
    matrix = @($eRows)
    mixed = [PSCustomObject]@{ n = @($merged).Count; leak = $leak; fake1 = (Get-EngineStatus -Name 'Fake1'); fake2 = (Get-EngineStatus -Name 'Fake2') }
    serial = $ser.Count
} | ConvertTo-Json -Depth 6 -Compress
if (@($fails).Count -gt 0) { exit 1 }
