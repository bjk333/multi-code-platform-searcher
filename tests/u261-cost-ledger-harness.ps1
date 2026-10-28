# tests/u261-cost-ledger-harness.ps1 —— U-261（B2-6）的数据面：**跑真 `Invoke-ApiRequest`**，只桩发送器。
#
# 为什么必须跑真函数：账本唯一要保证的是 `行数 == metrics.Requests`（每行 = 一次线上尝试）。
#   读源码只能看出"有没有那一行"，看不出"node 兜底算不算一次"、"重试后 attempt 有没有递增"、
#   "402 那种一次就抛的尝试有没有被记成 transport"。所以这里跟 U-256 同法：桩掉发包，记账一行不桩。
#
# ★关键：**`Resolve-ApiHttpFailure` 不桩**（除了 transport 臂）—— 状态码是在它体内 `Set-ApiLedgerStatus`
#   盖上去的。桩掉它等于把被测的那一环换成自己的实现，402 臂就会"通过"却什么也没验证。
#   做法是让发送器抛**真的** `HttpResponseException`（PS7 类型），由真分类器解析出 402/429/500。
#
# 臂：
#   1 ok           —— 200，1 行，outcome=ok
#   2 http402      —— 402，1 行（**不重试**），reasonCode=quota-exhausted
#   3 http429stop  —— 429 + 退避判定"不再重试"，1 行
#   4 http429retry —— 429，第 1 次退避后重试，第 2 次不再 ⇒ **2 行**，attempt 1/2
#   5 http500      —— 500，1 行，reasonCode=http-5xx
#   6 transport    —— 拿不到响应 ⇒ node 兜底也失败 ⇒ 2 行（web 1 + node 1），httpStatus 均为 null
param([string]$SkillDir = '')
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
if (-not $SkillDir) { $SkillDir = (Resolve-Path (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '..')).Path }
$SkillDir = (Resolve-Path $SkillDir).Path
$env:MCPS_NO_MAIN = '1'
. (Join-Path $SkillDir 'multi-platform-searcher.ps1')

# ---------- 传输层桩（只桩"发包"与"读配置"，记账一行不桩）----------
function Get-DeadNetworkHost { param([string]$HostName) return '' }
function Get-ApiRequestRouteContext {
    param([string]$Uri, [switch]$NoProxy, [int]$BudgetMs)
    return [PSCustomObject]@{ ProxyMode = $false; Direct = $true; ProxyUrl = ''; NetworkRoute = [PSCustomObject]@{ Kind = 'direct' } }
}
function Resolve-UnprovenRouteBudget { param($Route, [int]$TimeoutSec, [int]$MaxAttempts) return [PSCustomObject]@{ TimeoutSec = $TimeoutSec; MaxAttempts = $MaxAttempts; Capped = $false } }
function Test-UnprovenRouteTimeout { param([bool]$Capped, [double]$ElapsedSec, [int]$TimeoutSec) return $false }
function Write-TlsTrace { param([string]$Message) }
function Get-ApiWallBudget { param($Start, [int]$DeadlineSec, [int]$TimeoutSec) return [PSCustomObject]@{ TimeoutSec = $TimeoutSec; RemainingMs = 5000; Exhausted = $false } }
function Resolve-ProxyGatewayOutcome { param($HostName, [switch]$ViaProxy, [int]$Code) return $null }
function Test-DeterministicTransportFailure { param([string]$Text, [bool]$ProxyActive) return '' }
function Set-DeadNetworkHost { param([string]$HostName, [string]$Reason) }
function Get-ApiHeaders { return @{} }
function Write-ColorOutput { param([string]$Message, [string]$Color) }
function Update-ApiRetryCounters { param($Resp) }
function Test-ApiRetryBudget { return $false }
function Invoke-ApiNodeFallback {
    param($Uri, $Headers, $Method, $Body, $NodeDeadlineSec, $TraceUri, $Attempt, $MaxAttempts)
    return [PSCustomObject]@{ Action = 'throw'; Message = 'stub: node fallback disabled'; Log = ''; Result = $null; LastCode = $null }
}
$script:_backoffHasNextAt = 0   # 0 = 永不重试；1 = 第 1 次退避后重试
function Get-RetryBackoff {
    param($Attempt, $MaxAttempts, $RetryAfterHeader)
    $hasNext = ($script:_backoffHasNextAt -gt 0 -and [int]$Attempt -lt $script:_backoffHasNextAt)
    return [PSCustomObject]@{ HasNext = $hasNext; WaitSec = 0; TooLong = $false }
}

# ---------- 真响应异常（让真 Resolve-ApiHttpFailure 去解析状态码）----------
function New-HttpFailSender {
    param([int]$Code)
    return {
        param($Uri, $Headers, $TimeoutSec, $Method, $Body, $networkRoute, [switch]$NoProxy, $reqSw)
        $msg = [System.Net.Http.HttpResponseMessage]::new([System.Net.HttpStatusCode]$Code)
        throw [Microsoft.PowerShell.Commands.HttpResponseException]::new("stub: HTTP $Code", $msg)
    }.GetNewClosure()
}
$okSender = { param($Uri, $Headers, $TimeoutSec, $Method, $Body, $networkRoute, [switch]$NoProxy, $reqSw) return [PSCustomObject]@{ Content = '{}'; StatusCode = 200; Headers = @{} } }
$boomSender = { param($Uri, $Headers, $TimeoutSec, $Method, $Body, $networkRoute, [switch]$NoProxy, $reqSw) throw 'stub: transport boom' }
$realClassifier = (Get-Item function:Resolve-ApiHttpFailure).ScriptBlock
$transportClassifier = {
    param($ErrorRecord, $reqSw, [string]$Uri = '')
    return [PSCustomObject]@{ IsHttpFailure = $true; Response = $null }
}

function Run-Arm {
    param([string]$Id, [scriptblock]$Sender, [scriptblock]$Classifier, [int]$BackoffAt = 0, [string]$Mode = 'code', [string]$Engine = 'FakeEngine')
    Reset-ApiLedger
    # ★两道账必须**同点**重置（生产里同在 7258 那个 try 块）：只重置一边，`行数 == Requests` 会因为
    #   "上一臂的 Requests 还留着"而假红 —— 那是门自己造出来的红，不是产品缺陷。
    [System.AppDomain]::CurrentDomain.SetData('mcps_reqstats', (New-Object 'System.Collections.Concurrent.ConcurrentBag[string]'))
    Set-Item -Path function:Resolve-ApiHttpFailure -Value $Classifier
    Set-Item -Path function:Invoke-ApiWebOnce -Value $Sender
    $script:_backoffHasNextAt = $BackoffAt
    # 归属上下文（生产里由池包装块/Invoke-EngineSerial 设；这里直接设成主作用域的 $script:）
    $script:_ledgerEngine = $Engine; $script:_ledgerMode = $Mode
    $err = ''
    try { $null = Invoke-ApiRequest -Uri 'https://ledger.invalid/x' -Headers @{} -TimeoutSec 5 -MaxAttempts 3 } catch { $err = [string]$_.Exception.Message }
    # 走**生产的收尾路径**：`Save-ApiLedger` 会把仍 open 的行按失败结掉（payload 里就是这么做的）。
    #   跳过它去看原始行，会看到 `outcome=open` 并误以为"账本坏了" —— 其实那是"还没收尾"。
    $null = Save-ApiLedger -NoWrite
    $rows = @(Get-ApiLedgerRows)
    $s = Get-ApiRequestStats
    $runId = [string]([System.AppDomain]::CurrentDomain.GetData('mcps_run_id'))
    return [PSCustomObject]@{
        id      = $Id
        rows    = @($rows | ForEach-Object {
                [PSCustomObject]@{ seq = [int]$_.seq; engine = [string]$_.engine; mode = [string]$_.mode; attempt = [int]$_.attempt
                    httpStatus = $_.httpStatus; outcome = [string]$_.outcome; reasonCode = $_.reasonCode; quotaClass = [string]$_.quotaClass
                    latencyMs = $_.latencyMs; runId = [string]$_.runId; ts = [string]$_.ts
                }
            })
        count   = $rows.Count
        attempted = $s.Attempted
        succeeded = $s.Succeeded
        identity = ($rows.Count -eq $s.Attempted)
        runId   = $runId
        threw   = ($err -ne '')
    }
}

$arms = @()
$arms += Run-Arm 'ok' $okSender $realClassifier
$arms += Run-Arm 'http402' (New-HttpFailSender 402) $realClassifier
$arms += Run-Arm 'http429stop' (New-HttpFailSender 429) $realClassifier
$arms += Run-Arm 'http429retry' (New-HttpFailSender 429) $realClassifier -BackoffAt 2
$arms += Run-Arm 'http500' (New-HttpFailSender 500) $realClassifier
$arms += Run-Arm 'transport' $boomSender $transportClassifier

# 纯函数真值表：账本的 outcome/reasonCode/quotaClass 只由 (是否成功, 状态码) 决定。
#   ★这一臂专治"分类靠文案"：同一条 HTTP 码在任何引擎、任何文案下必须给出同一个判定。
$verdicts = @()
foreach ($c in @(200, 201, 204, 402, 429, 403, 404, 500, 503, 0, $null)) {
    $v = Get-ApiLedgerVerdict -Status $c
    $verdicts += [PSCustomObject]@{ status = $c; outcome = $v.Outcome; reasonCode = $v.ReasonCode; quotaClass = $v.QuotaClass }
}
$vOk = Get-ApiLedgerVerdict -Ok -Status 200
$verdicts += [PSCustomObject]@{ status = 'ok'; outcome = $vOk.Outcome; reasonCode = $vOk.ReasonCode; quotaClass = $vOk.QuotaClass }

# 落盘臂：真写 JSONL，再读回来验（这是 `written` 唯一能被证伪的地方）。
function Run-FileArm {
    $tmp = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), ('u261-ledger-' + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.jsonl'))
    $env:MCPS_LEDGER = $tmp
    $sums = @()
    try {
        foreach ($round in 1..2) {
            Reset-ApiLedger
            [System.AppDomain]::CurrentDomain.SetData('mcps_reqstats', (New-Object 'System.Collections.Concurrent.ConcurrentBag[string]'))
            Set-Item -Path function:Resolve-ApiHttpFailure -Value $realClassifier
            Set-Item -Path function:Invoke-ApiWebOnce -Value $okSender
            $script:_backoffHasNextAt = 0
            $script:_ledgerEngine = 'FileEngine'; $script:_ledgerMode = 'research'
            # 每轮发 **2 次**请求：`(runId,seq)` 的唯一性只有在**同一轮内多行**时才可证伪
            #   （每轮只有 1 行的话，seq 恒为 1 也看不出来 —— 变异⑤原本就是这么漏过去的）。
            foreach ($n in 1..2) { try { $null = Invoke-ApiRequest -Uri 'https://ledger.invalid/f' -Headers @{} -TimeoutSec 5 -MaxAttempts 1 } catch { } }
            $sums += (Save-ApiLedger)   # 第 2 轮必须**追加**，不是覆盖
        }
        $lines = @()
        if (Test-Path $tmp) { $lines = @(Get-Content -LiteralPath $tmp -Encoding UTF8) }
        $parsed = @($lines | ForEach-Object { try { ($_ | ConvertFrom-Json) } catch { $null } })
        $good = @($parsed | Where-Object { $_ })
        $keys = if ($good.Count -gt 0) { @($good[0].PSObject.Properties.Name | Sort-Object) } else { @() }
        $uniqSeq = @($good | ForEach-Object { [int]$_.seq } | Sort-Object -Unique).Count
        $runIds = @($good | ForEach-Object { [string]$_.runId } | Sort-Object -Unique).Count
        # 唯一键是 (runId, seq)：seq 只在**一轮内**唯一（每轮重置计数器 —— 那是刻意的，
        #   否则长驻进程跑一年后 seq 会变成一串无意义的大数）。
        $uniqPairs = @($good | ForEach-Object { ([string]$_.runId) + '#' + [string]$_.seq } | Sort-Object -Unique).Count
        return [PSCustomObject]@{
            rows        = [int]$sums[-1].rows
            written     = @($sums | ForEach-Object { [int]$_.written })
            pathSet     = [bool]$sums[-1].path
            error       = [string]$sums[-1].error
            lines       = $lines.Count
            parsed      = $good.Count
            keys        = $keys
            uniqSeq     = $uniqSeq
            uniqPairs   = $uniqPairs
            uniqRunIds  = $runIds     # 两轮各一个 runId ⇒ 期望 2（追加不是覆盖的证据）
            sample      = $(if ($good.Count -gt 0) { $good[0] } else { $null })
        }
    } finally {
        Remove-Item Env:\MCPS_LEDGER -ErrorAction SilentlyContinue
        if (Test-Path $tmp) { Remove-Item -LiteralPath $tmp -Force }
    }
}
$fileArm = Run-FileArm

# 重置臂：Reset 之后必须 0 行、且 runId 换新（`-Serve` 长驻里不换 ⇒ 第 2 轮的行冒充第 1 轮的）
$before = [string]([System.AppDomain]::CurrentDomain.GetData('mcps_run_id'))
Reset-ApiLedger
$after = [string]([System.AppDomain]::CurrentDomain.GetData('mcps_run_id'))
$reset = [PSCustomObject]@{ rowsAfterReset = @(Get-ApiLedgerRows).Count; runIdChanged = ($before -ne $after); runIdEmpty = ($after -eq '') }

Set-Item -Path function:Resolve-ApiHttpFailure -Value $realClassifier

$fails = @()
foreach ($a in $arms) { if (-not $a.identity) { $fails += ("{0}: rows({1}) != attempted({2})" -f $a.id, $a.count, $a.attempted) } }
if ($reset.rowsAfterReset -ne 0) { $fails += 'reset: 重置后仍有行' }
if (-not $reset.runIdChanged) { $fails += 'reset: runId 未换新' }
if ($reset.runIdEmpty) { $fails += 'reset: runId 为空' }
# 落盘臂的内部一致性（三条互相独立：行数、写出行数、文件行数）
if (@($fileArm.written)[0] -ne @($fileArm.written)[1]) { $fails += ("file: 两轮 written 不等（{0}）" -f (@($fileArm.written) -join ',')) }
if ($fileArm.error -ne '') { $fails += ("file: 落盘报错 {0}" -f $fileArm.error) }
if ($fileArm.parsed -ne $fileArm.lines) { $fails += ("file: {0} 行里有 {1} 行解析失败" -f $fileArm.lines, ($fileArm.lines - $fileArm.parsed)) }
if ($fileArm.uniqPairs -ne $fileArm.parsed) { $fails += ("file: (runId,seq) 不唯一（{0} 行只有 {1} 个键）" -f $fileArm.parsed, $fileArm.uniqPairs) }

[PSCustomObject]@{
    ok       = (@($fails).Count -eq 0)
    fails    = @($fails)
    arms     = @($arms)
    reset    = $reset
    verdicts = @($verdicts)
    file     = $fileArm
} | ConvertTo-Json -Depth 8 -Compress
if (@($fails).Count -gt 0) { exit 1 }
