// U-228（v1.53.7，2026-10-23）：代理网关 5xx 的进程内熔断（Tier-1 方案 §1 的剩余部分）。
//
// 事实（代码 + 实测）：Tier-1 方案原文给的处置是「1–2s 探测上限**或**进程内熔断（半开 60s）」。
//   v1.51.0 只落地了 CONNECT 隧道失败（`proxy-tunnel`）的快速失败；而代理把 502 当**普通 HTTP 响应**
//   返回时压根不进传输层分类器 ⇒ 照旧走 5xx 退避重试。实测（2026-10-23 本机代理 127.0.0.1:22925）：
//   GitHub 3 次尝试各 ~7s + 退避 ⇒ 独占 29s 撞引擎截止，最终 reason 只剩「单引擎超 29s 截止」——
//   用户既等满 29s，又看不出是**代理**坏了。
//
// 判据三层：
//   ① 真值表（dot-source 后直调函数，`-NowMs` 把表拨快 ⇒ 不靠 sleep 60s）：
//      连续 2 次网关 5xx ⇒ open 60s；到期 ⇒ half（放行探测）；half 再失败 ⇒ 立刻重开；ok ⇒ 清零；
//      不同主机互不影响；`MCPS_PROXY_BREAKER_SEC=0` ⇒ 永不打开。
//   ② 接线：查询在 `$proxyMode` 定稿之后；**只认 502/503/504**（500 多为源侧、429 有 Retry-After 语义）；
//      成功路径必须清零（否则一次抖动会永久熔断）。
//   ③ 变异：放宽到全部 5xx / 去掉拨开时的 throw / 去掉成功清零 ⇒ 三者都必须被点名。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sourceAll } from './lib/source.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = sourceAll(path.join(ROOT));

function runPs(exe, body, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u228-'));
    const f = path.join(dir, 'probe.ps1');
    const outFile = path.join(dir, 'out.txt');
    fs.writeFileSync(f, '\ufeff' + body, 'utf8');   // BOM：-File 下让 PS 按 UTF-8 读中文
    const child = spawn(exe, ['-NoProfile', '-NonInteractive', '-File', f], {
      cwd: ROOT, windowsHide: true,
      env: { ...process.env, MCPS_NO_MAIN: '1', U228_OUT: outFile },
    });
    let out = '', err = '';
    const killer = setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } reject(new Error(exe + ' timeout')); }, timeoutMs);
    child.stdout.on('data', (b) => { out += b.toString('utf8'); });
    child.stderr.on('data', (b) => { err += b.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(killer); reject(e); });
    child.on('close', () => {
      clearTimeout(killer);
      // 中文不能走 stdout（控制台代码页 936）⇒ 探针写 UTF-8 文件，这里读文件
      let fileOut = '';
      try { fileOut = fs.readFileSync(outFile, 'utf8'); } catch { /* 探针崩溃时无文件 */ }
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 系统清 */ }
      resolve({ out: (fileOut || out).trim(), stdout: out.trim(), err: err.trim() });
    });
    child.stdin.end();
  });
}

const T0 = 1000000;          // 假时钟基准（毫秒）—— 不靠 sleep 60s 验半开
const T1 = T0 + 61000;       // 已过熔断期 ⇒ 半开
const T2 = T0 + 62000;

const PROBE = `
$ErrorActionPreference = 'Continue'
$env:MCPS_NO_MAIN = '1'
. ./multi-platform-searcher.ps1 -NoEnvFile -Keyword x -Limit 1
$rows = @()
function Snap([string]$h, [int]$n) {
  $s = Get-ProxyBreakerState -HostName $h -NowMs $n
  '{0}|{1}|{2}|{3}' -f $s.State, $s.RemainingSec, $s.Count, $(if ($s.Reason) { 'R' } else { '-' })
}
$script:_proxyBreaker.Clear()
$rows += 'init=' + (Snap 'a.example' ${T0})
$null = Update-ProxyBreaker -HostName 'a.example' -Outcome '5xx' -NowMs ${T0}
$rows += 'after1=' + (Snap 'a.example' ${T0})
$t1 = Update-ProxyBreaker -HostName 'a.example' -Outcome '5xx' -NowMs ${T0}
$rows += 'trip1=' + $(if ($t1) { 'R' } else { 'none' })
$rows += 'after2=' + (Snap 'a.example' ${T0})
$rows += 'other=' + (Snap 'b.example' ${T0})
$rows += 'expired=' + (Snap 'a.example' ${T1})
$t2 = Update-ProxyBreaker -HostName 'a.example' -Outcome '5xx' -NowMs ${T1}
$rows += 'halfFail=' + $(if ($t2) { 'R' } else { 'none' })
$rows += 'reopened=' + (Snap 'a.example' ${T1})
$null = Update-ProxyBreaker -HostName 'a.example' -Outcome 'ok' -NowMs ${T2}
$rows += 'cleared=' + (Snap 'a.example' ${T2})
# 单次抖动不得留下持久影响：5xx -> ok -> 5xx ⇒ 仍为 closed
$null = Update-ProxyBreaker -HostName 'c.example' -Outcome '5xx' -NowMs ${T0}
$null = Update-ProxyBreaker -HostName 'c.example' -Outcome 'ok' -NowMs ${T0}
$null = Update-ProxyBreaker -HostName 'c.example' -Outcome '5xx' -NowMs ${T0}
$rows += 'flap=' + (Snap 'c.example' ${T0})
# 关闭阀：MCPS_PROXY_BREAKER_SEC=0
$env:MCPS_PROXY_BREAKER_SEC = '0'
foreach ($i in 1..4) { $null = Update-ProxyBreaker -HostName 'd.example' -Outcome '5xx' -NowMs ${T0} }
$rows += 'off=' + (Snap 'd.example' ${T0})
$env:MCPS_PROXY_BREAKER_SEC = ''
# 真实时钟一次：UtcNow.ToUnixTimeMilliseconds() ≈ 1.79e12 > Int32 —— 假时钟（1e6）测不出溢出
$script:_proxyBreaker.Clear()
try {
  $null = Update-ProxyBreaker -HostName 'real.example' -Outcome '5xx'
  $real = Update-ProxyBreaker -HostName 'real.example' -Outcome '5xx'
  $rows += 'realtime=' + $(if ($real) { 'R' } else { 'none' })
} catch { $rows += 'realtime=EX:' + $_.Exception.Message }
# 文案：必须点名主机，且给出可执行的关阀
$null = Update-ProxyBreaker -HostName 'e.example' -Outcome '5xx' -NowMs ${T0}
$msg = Update-ProxyBreaker -HostName 'e.example' -Outcome '5xx' -NowMs ${T0}
$rows += 'msg=' + $msg
[System.IO.File]::WriteAllLines($env:U228_OUT, $rows, (New-Object System.Text.UTF8Encoding($false)))
`;

function parseRows(out) {
  const rows = {};
  for (const line of out.split(/\r?\n/)) {
    const m = /^(init|after1|trip1|after2|other|expired|halfFail|reopened|cleared|flap|off|realtime|msg)=(.*)$/.exec(line.trim());
    if (m) rows[m[1]] = m[2];
  }
  return rows;
}

function pickExe() {
  // ★只用异步 spawn：R2 spawn 卫生门禁止新文件用 spawnSync/execSync
  return new Promise((resolve) => {
    const c = spawn('pwsh', ['-NoProfile', '-Command', 'exit 0'], { windowsHide: true });
    c.on('error', () => resolve('powershell'));
    c.on('close', (code) => resolve(code === 0 ? 'pwsh' : 'powershell'));
    c.stdin.end();
  });
}

test('U-228 真值表: 连续 2 次网关 5xx ⇒ 熔断 60s；到期半开；半开再失败立刻重开；ok 清零', async () => {
  const exe = await pickExe();
  const { out, err } = await runPs(exe, PROBE);
  const r = parseRows(out);
  assert.ok(r.init, 'probe 未产出 init 行；stderr=' + err.slice(0, 400));

  assert.match(r.init, /^closed\|0\|0\|-$/, '初始必须是 closed/0/0（实得 ' + r.init + '）');
  assert.match(r.after1, /^closed\|0\|1\|-$/, '★ 1 次 5xx 不得打开（单次抖动重试是合理的），实得 ' + r.after1);
  assert.equal(r.trip1, 'R', '★ 第 2 次必须返回归因文案（= 本次触发熔断）');
  assert.match(r.after2, /^open\|60\|2\|R$/, '★ 连续 2 次必须 open 且剩余 60s，实得 ' + r.after2);
  assert.notEqual(r.other, r.after2, '★ 熔断必须按主机隔离（同进程不同域互不影响），实得 ' + r.other);
  assert.match(r.other, /^closed\|/, '未失败过的主机必须 closed，实得 ' + r.other);
  assert.match(r.expired, /^half\|0\|2\|-$/, '到期必须半开（放行一次探测），实得 ' + r.expired);
  assert.equal(r.halfFail, 'R', '★ 半开期再失败必须立刻重开（不是再攒 2 次）');
  assert.match(r.reopened, /^open\|60\|/, '★ 重开后剩余时间必须重新计满，实得 ' + r.reopened);
  assert.match(r.cleared, /^closed\|0\|0\|-$/, '★ 成功必须清零（否则一次抖动会永久熔断），实得 ' + r.cleared);
  assert.match(r.flap, /^closed\|0\|1\|-$/, '5xx→ok→5xx 不得打开（成功已把连续计数清零），实得 ' + r.flap);
  assert.match(r.off, /^closed\|/, '★ MCPS_PROXY_BREAKER_SEC=0 必须是关闭阀，实得 ' + r.off);
  // ★假时钟在 Int32 内，溢出只有真实时钟能测出来（2026-10-23 受控实验真的踩了）
  assert.equal(r.realtime, 'R', '★ 真实时钟（毫秒 ≈1.79e12）也必须能打开 —— 溢出会在这里现形：' + r.realtime);
  assert.match(r.msg, /e\.example/, '归因文案必须点名主机：' + r.msg);
  assert.match(r.msg, /熔断/, '归因文案必须说明"熔断"：' + r.msg);
  assert.match(r.msg, /MCPS_PROXY_BREAKER_SEC=0/, '归因文案必须给可执行的关阀：' + r.msg);
});

// 接线：查询点必须在 `$proxyMode` 定稿之后（之前 `$proxyMode` 还没赋值 ⇒ 恒假）。
function checkWiring(src) {
  assert.match(src, /function Get-ProxyBreakerState\s*\{/, '必须存在 Get-ProxyBreakerState');
  assert.match(src, /function Update-ProxyBreaker\s*\{/, '必须存在 Update-ProxyBreaker');
  assert.match(src, /function Resolve-ProxyGatewayOutcome\s*\{/, '必须存在 Resolve-ProxyGatewayOutcome（D4：三处调用点共用一份判定）');

  const iMode = src.indexOf('$proxyMode = $routeCtx.ProxyMode');
  assert.ok(iMode > 0, '锚点缺失：$proxyMode = $routeCtx.ProxyMode');
  const iCheck = src.indexOf('Get-ProxyBreakerState -HostName $reqHost');
  assert.ok(iCheck > 0, '★ Invoke-ApiRequest 必须查询熔断状态（否则熔断永不生效）');
  assert.ok(iCheck > iMode, '★ 查询必须晚于 $proxyMode 赋值');

  // "是否走代理"必须按路由种类判：$proxyMode 只表示"socks 走 curl"，HTTP 代理的 502 走 web 分支
  assert.match(src, /\$viaProxy = \$routeCtx\.NetworkRoute\.Kind -in @\('http', 'socks'\)/, '★ 代理判定必须用 NetworkRoute.Kind（http+socks），不能用 $proxyMode');
  const iVia = src.indexOf("$viaProxy = $routeCtx.NetworkRoute.Kind");
  assert.ok(iVia > 0 && iVia < iCheck, '$viaProxy 必须先于熔断查询赋值');

  // 四个登记点：curl 2xx / curl 5xx / web 2xx / web 5xx
  const calls = (src.match(/Resolve-ProxyGatewayOutcome -HostName \$reqHost -ViaProxy:\$viaProxy/g) || []).length;
  assert.equal(calls, 4, '★ 必须四处登记（curl 与 web 两条路径的 2xx/5xx 各一），实得 ' + calls);
  assert.match(src, /-ViaProxy:\$viaProxy -Code 200/, '★ web 分支成功必须显式传 200（否则连续计数永不清零）');

  // 只认网关类 5xx：500 多为源侧异常（重试合理），429 有 Retry-After 语义 ⇒ 都不许计入
  assert.match(src, /if \(\$Code -in @\(502, 503, 504\)\)/, '★ 只许 502/503/504 计入熔断（500 是源侧、429 是限流）');
  assert.match(src, /if \(-not \$ViaProxy\) \{ return \$null \}/, '★ 直连必须早退（直连 5xx 是源侧问题，不得熔断）');

  // 熔断文案必须经 throw 收束当前请求
  assert.match(src, /if \(\$trip\) \{ throw \$trip \}/, '★ 命中熔断必须 throw（否则只是算了一下就继续发请求）');
  assert.match(src, /if \(\$brk\.Reason\) \{ throw \$brk\.Reason \}/, '★ 打开期必须 throw（否则仍会发请求）');
}

test('U-228 接线: 查询晚于 $proxyMode、只认 502/503/504、成功清零', () => {
  checkWiring(SRC);
});

test('U-228 negative control: 放宽 5xx / 去掉 throw / 去掉成功清零 / 用 $proxyMode 判代理 —— 都必须被点名', () => {
  const loose = SRC.replace('if ($Code -in @(502, 503, 504))', 'if ($Code -ge 500)');
  assert.notEqual(loose, SRC, 'mutation 1 must loosen the status filter');
  assert.throws(() => checkWiring(loose), /只许 502\/503\/504/);

  const noThrow = SRC.split('if ($trip) { throw $trip }').join('$null = $trip');   // 两处（curl/web）都要去掉
  assert.notEqual(noThrow, SRC, 'mutation 2 must drop the throw');
  assert.throws(() => checkWiring(noThrow), /命中熔断必须 throw/);

  const noReset = SRC.replace('-ViaProxy:$viaProxy -Code 200', '-ViaProxy:$viaProxy -Code 502');
  assert.notEqual(noReset, SRC, 'mutation 3 must drop the 2xx reset');
  assert.throws(() => checkWiring(noReset), /成功必须显式传 200/);

  // ★本批真实踩过的坑：把"是否走代理"写成 $proxyMode ⇒ HTTP 代理的 502 永远不进熔断
  const wrongGate = SRC.replace("$viaProxy = $routeCtx.NetworkRoute.Kind -in @('http', 'socks')", '$viaProxy = $proxyMode');
  assert.notEqual(wrongGate, SRC, 'mutation 4 must gate on $proxyMode');
  assert.throws(() => checkWiring(wrongGate), /必须用 NetworkRoute\.Kind/);

  const noDirectGuard = SRC.replace('if (-not $ViaProxy) { return $null }', 'if ($false) { return $null }');
  assert.notEqual(noDirectGuard, SRC, 'mutation 5 must drop the direct-route guard');
  assert.throws(() => checkWiring(noDirectGuard), /直连必须早退/);
});
