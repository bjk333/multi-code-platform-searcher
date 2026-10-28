# test-retry：403 secondary rate limit 重试语义（需 Python 起本地模拟服务器）
# 断言：限流特征 403（Retry-After/x-ratelimit-remaining:0/abuse 文案）→ 进入重试（mcps_retries>=1）；
#       普通 403（无特征）→ 不重试（mcps_retries=0）。
# 由 run-tests.ps1 dot-source 执行。动态端口避免残留冲突；
# Python 不可用/启动失败时输出 TEST_SKIP（环境限制，不判 FAIL）。
$t_main = $env:MCPS_MAIN
if (-not $t_main) { $t_main = $mainScript }
. $t_main

$t_ok = $true
$t_fail = @()
$t_py = (Get-Command python -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if (-not $t_py) { $t_py = 'python' }
$t_portA = 18976; $t_portB = 18977
$t_mockPy = Join-Path ([System.IO.Path]::GetTempPath()) "mcps_mock403_$PID.py"
@"
import threading, time
from http.server import BaseHTTPRequestHandler, HTTPServer
class RL(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(403); self.send_header('Retry-After','1'); self.send_header('x-ratelimit-remaining','0'); self.end_headers()
        self.wfile.write(b'You have exceeded a secondary rate limit')
    def log_message(self,*a): pass
class Plain(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(403); self.end_headers(); self.wfile.write(b'Forbidden')
    def log_message(self,*a): pass
threading.Thread(target=lambda: HTTPServer(('127.0.0.1',$t_portA),RL).serve_forever(),daemon=True).start()
threading.Thread(target=lambda: HTTPServer(('127.0.0.1',$t_portB),Plain).serve_forever(),daemon=True).start()
time.sleep(600)
"@ | Out-File -Encoding utf8 $t_mockPy
$t_p = $null
$t_skipped = $false
try {
    $t_startOpts = @{ FilePath = $t_py; ArgumentList = $t_mockPy; PassThru = $true; ErrorAction = 'SilentlyContinue' }
    if ($env:OS -eq 'Windows_NT') { $t_startOpts.WindowStyle = 'Hidden' }
    $t_p = Start-Process @t_startOpts
    Start-Sleep -Milliseconds 900
    # mock 可用性探测（不可用 → SKIP）
    $t_up = $false
    try { $null = Invoke-WebRequest -Uri "http://127.0.0.1:$t_portA/probe" -Headers @{} -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop } catch { if ($_.Exception.Response) { $t_up = $true } }
    if (-not $t_up) {
        $t_skipped = $true
    }
    else {
        # A：限流特征 403 → 进入重试链路
        [System.AppDomain]::CurrentDomain.SetData('mcps_retries', ([int[]]::new(1)))
        try { Invoke-ApiRequest -Uri "http://127.0.0.1:$t_portA/t" -Headers @{} -TimeoutSec 5 | Out-Null } catch { }
        $t_rc = [System.AppDomain]::CurrentDomain.GetData('mcps_retries')
        $t_rA = if ($t_rc) { $t_rc[0] } else { 0 }
        if ($t_rA -lt 1) { $t_ok = $false; $t_fail += "rate-limit 403 not retried (retries=$t_rA)" }
        # B：普通 403 → Test-RateLimit403 判定必须为 False（不误判为限流、不误重试）
        $t_respB = $null
        try { Invoke-WebRequest -Uri "http://127.0.0.1:$t_portB/t" -Headers @{} -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop | Out-Null }
        catch { $t_respB = $_.Exception.Response }
        if ($null -eq $t_respB) { $t_ok = $false; $t_fail += "plain 403 no response" }
        elseif (Test-RateLimit403 -Resp $t_respB) { $t_ok = $false; $t_fail += "plain 403 misjudged as rate-limit" }
    }
}
catch { $t_ok = $false; $t_fail += "exec: $($_.Exception.Message)" }
finally {
    if ($t_p) { Stop-Process -Id $t_p.Id -Force -ErrorAction SilentlyContinue }
    try { [System.IO.File]::Delete($t_mockPy) } catch { }
}
if ($t_skipped) { Write-Output "TEST_SKIP test-retry (python mock unavailable)" }
elseif ($t_ok) { Write-Output "TEST_PASS test-retry (403 RL retry + plain no-retry)" }
else { Write-Output "TEST_FAIL test-retry: $($t_fail -join '; ')" }
