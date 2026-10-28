// U-222 · 探针分类跨运行时一致（Tier1-2「网络失败路径不再白等」）
//
// 病灶（2026-10-22 实测）：`Invoke-NetworkProbeOnce` 只按 WebException.Status 枚举判 unreachable：
//   PS 5.1 连接被拒 ⇒ Status=ConnectFailure ⇒ 'unreachable' ⇒ 全路由失败 ⇒ Kind=unavailable ⇒ **跳过请求**；
//   PS 7 同一场景 ⇒ Status=**UnknownError**（实测 7.6.x）⇒ 落到 'unknown' ⇒ 路由判 unproven ⇒
//   **请求照发**、白等满超时才认输 —— 也就是说 PS7 上「探活不可达即 skip」这条路径**从未触发过**。
//   （SE 白等 19.4s 才 network-unavailable 的报告来自 PS7 宿主。）
//
// 判据分两层：
//   ① 真值表（真起 pwsh / powershell，dot-source 后直接调 Invoke-NetworkProbeOnce）：
//      拒接代理 ⇒ unreachable（PS7 修复前为 unknown ⇒ 红）；
//      挂死代理（accept 后永不回应）⇒ unknown（超时不得判死 —— U-155「绝不报假 skip」）；
//      NXDOMAIN 直连 ⇒ unreachable；502 服务器 ⇒ reachable（HTTP 响应 = 链路可达）。
//   ② 静态接线 + 变异控制（退回只看枚举 ⇒ 必红）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sourceAll } from './lib/source.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = sourceAll(path.join(ROOT));

function runPs(exe, body, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u222-'));
    const f = path.join(dir, 'probe.ps1');
    fs.writeFileSync(f, '﻿' + body, 'utf8');   // BOM：-File 下让 PS 按 UTF-8 读中文断言
    const child = spawn(exe, ['-NoProfile', '-NonInteractive', '-File', f], {
      cwd: ROOT, windowsHide: true,
      env: { ...process.env, MCPS_NO_MAIN: '1' },
    });
    let out = '', err = '';
    const killer = setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } reject(new Error(exe + ' timeout')); }, timeoutMs);
    child.stdout.on('data', (b) => { out += b.toString('utf8'); });
    child.stderr.on('data', (b) => { err += b.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(killer); reject(e); });
    child.on('close', () => {
      clearTimeout(killer);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 系统清 */ }
      resolve({ out: out.trim(), err: err.trim() });
    });
    child.stdin.end();
  });
}

function classifyScript(stallPort, port502) {
  return `
$ErrorActionPreference = 'Continue'
$env:MCPS_NO_MAIN = '1'
. ./multi-platform-searcher.ps1 -NoEnvFile -Keyword x -Limit 1
function Probe([string]$name, [uri]$target, $route, [int]$ms) {
  $r = Invoke-NetworkProbeOnce -Target $target -Route $route -Method HEAD -TimeoutMs $ms
  "$name=$r"
}
Probe 'refused'   'http://example.com/' ([PSCustomObject]@{ Kind = 'http'; ProxyUrl = 'http://127.0.0.1:1'; Source = 'refused' }) 2500
Probe 'stall'     'http://example.com/' ([PSCustomObject]@{ Kind = 'http'; ProxyUrl = 'http://127.0.0.1:${stallPort}'; Source = 'stall' }) 800
Probe 'nxdomain'  'http://zzz-no-such-host-abc.invalid/' ([PSCustomObject]@{ Kind = 'direct'; ProxyUrl = ''; Source = 'direct' }) 2500
Probe 'http502'   'http://127.0.0.1:${port502}/' ([PSCustomObject]@{ Kind = 'direct'; ProxyUrl = ''; Source = 'direct' }) 2500
# 组合层（U-222-4）：只给一个拒接候选 ⇒ 路由必须判 unavailable（请求要被跳过）
$script:ProxyMode = 'proxy:http://127.0.0.1:1'
$script:_networkRoutes = [System.Collections.Concurrent.ConcurrentDictionary[string,object]]::new()
$ru = Get-NetworkRoute -Uri 'http://example.com/'
"route-unavail=$($ru.Kind)"
# 对照：只给挂死候选 ⇒ 必须保留 unknown 候选（绝不报假 skip ⇒ 请求仍会发出）
$script:ProxyMode = "proxy:http://127.0.0.1:${stallPort}"
$script:_networkRoutes = [System.Collections.Concurrent.ConcurrentDictionary[string,object]]::new()
$rk = Get-NetworkRoute -Uri 'http://example.com/'
"route-stall=$($rk.Kind)"
`;
}

function parseProbeOut(out) {
  const rows = {};
  for (const line of out.split(/\r?\n/)) {
    const m = /^(refused|stall|nxdomain|http502|route-unavail|route-stall)=(.+)$/.exec(line.trim());
    if (m) rows[m[1]] = m[2].trim();
  }
  return rows;
}

function checkFallbackWiring(src) {
  assert.ok(/if \(Test-DeterministicTransportFailure -Text \(\[string\]\$_\.Exception\.Message/.test(src),
    '★探针 catch 必须按消息文本补判（PS7 把拒接映射成 UnknownError，只看枚举会漏）');
  assert.ok(/WebExceptionStatus\]::ConnectFailure\)\) \{ return 'unreachable' \}/.test(src),
    'PS5.1 的枚举快速路径必须保留');
  assert.ok(/'unknown' # 超时、TLS\/CA/.test(src), 'U-155 契约：超时/TLS 不得判死（绝不报假 skip）');
  assert.ok(/if \(\$head -eq 'reachable' -or \$get -eq 'reachable'\) \{ 'reachable' \} elseif \(\$head -eq 'unreachable' -or \$get -eq 'unreachable'\) \{ 'unreachable' \}/.test(src),
    '★verdict 合成必须按证据强度排序：可达 > 确定性失败 > 未知（GET 超时不得把已证实拒接降级成 unknown）');
  assert.ok(/if \(\$verdict -eq 'unknown' -and -not \$unknown\) \{ \$unknown = \$candidate \}/.test(src),
    '★$unknown 只收 verdict=unknown 的候选（旧谓词与合成脱钩 ⇒ 已证实拒接仍被兜回 unproven）');
}

test('U-222-1 真值表：拒接⇒unreachable / 挂死⇒unknown / NXDOMAIN⇒unreachable / 502⇒reachable（pwsh + powershell）', async () => {
  // 本地挂死代理：accept 后永不回应
  const sockets = new Set();
  const track = (srv) => { srv.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); }); };
  const stall = net.createServer(() => { /* accept & stall */ });
  const s502 = http.createServer((req, res) => { res.writeHead(502); res.end('bad'); });
  track(stall); track(s502);
  await new Promise((r) => stall.listen(0, '127.0.0.1', r));
  await new Promise((r) => s502.listen(0, '127.0.0.1', r));
  const stallPort = stall.address().port, port502 = s502.address().port;
  try {
    // U-278（v1.60.0，B3-7）：这张表比的是**两个运行时对同一批症状给出同样分类**。
    //   POSIX 上不存在 Windows PowerShell 5.1（`powershell`），只剩 pwsh；那就只跑 pwsh 那一臂 ——
    //   不是放宽断言，是那个臂在这个平台上没有对象可测。形式与 lib/interp.mjs 的 PS 默认值一致。
    const shells = process.platform === 'win32' ? ['pwsh', 'powershell'] : ['pwsh'];
    for (const exe of shells) {
      const r = await runPs(exe, classifyScript(stallPort, port502));
      const rows = parseProbeOut(r.out);
      // v1.53.1：断言消息带**实际值 + stderr 尾部**。2026-10-22 全量实红过一次（串行下 pwsh 把拒接判成
      //   unknown，单跑 3/3 全绿）—— 当时消息只有"必须判 unreachable"，看不出真实错误文本没法定性。
      //   ★不放宽断言：拒接仍是硬契约；只让失败时能一眼看出是"真拒接被漏判"还是"第三种网络错误"。
      const diag = '；实得 rows=' + JSON.stringify(rows) + '；stderr=' + (r.err || '').slice(-400);
      assert.deepEqual(Object.keys(rows).sort(), ['http502', 'nxdomain', 'refused', 'route-stall', 'route-unavail', 'stall'], exe + ' 输出行不齐: ' + r.out.slice(-600));
      assert.equal(rows.refused, 'unreachable', exe + ': 连接被拒必须判 unreachable（PS7 修复前误判 unknown ⇒ 请求照发白等）' + diag);
      assert.equal(rows.stall, 'unknown', exe + ': 超时/挂死不得判死（U-155 绝不报假 skip）' + diag);
      assert.equal(rows.nxdomain, 'unreachable', exe + ': 解析失败必须判 unreachable' + diag);
      assert.equal(rows.http502, 'reachable', exe + ': 4xx/5xx 是 HTTP 响应 ⇒ 链路可达' + diag);
      assert.equal(rows['route-unavail'], 'unavailable', exe + ': 全部候选确定性失败 ⇒ 路由必须 unavailable（请求要被跳过）' + diag);
      assert.equal(rows['route-stall'], 'http', exe + ': 挂死候选必须保留为 unknown 路由（绝不报假 skip ⇒ 请求仍发出）');
    }
  } finally {
    for (const s of sockets) { try { s.destroy(); } catch { /* 已断 */ } }
    await new Promise((r) => stall.close(r));
    await new Promise((r) => s502.close(r));
  }
});

test('U-222-2 静态接线：文本补判存在、枚举快速路径保留、unknown 语义不许动', () => {
  checkFallbackWiring(SRC);
});

test('U-222-3 负例（变异控制）：删掉文本补判 / 把补判改成恒真 / 删掉枚举路径 / verdict 降级 / $unknown 兜回 —— 必须被点名', () => {
  const noFallback = SRC.replace(
    "if (Test-DeterministicTransportFailure -Text ([string]$_.Exception.Message + ' ' + [string]$_)) { return 'unreachable' }\n", '');
  assert.notEqual(noFallback, SRC, '变异必须真的改到补判行');
  assert.throws(() => checkFallbackWiring(noFallback), /按消息文本补判/);

  const alwaysTrue = SRC.replace(
    "if (Test-DeterministicTransportFailure -Text ([string]$_.Exception.Message + ' ' + [string]$_)) { return 'unreachable' }",
    'if ($true) { return \'unreachable\' }');
  assert.notEqual(alwaysTrue, SRC, '变异必须真的改到补判条件');
  assert.throws(() => checkFallbackWiring(alwaysTrue), /按消息文本补判/);

  const noEnum = SRC.replace(
    "if ($_.Exception.Status -in @([System.Net.WebExceptionStatus]::NameResolutionFailure, [System.Net.WebExceptionStatus]::ProxyNameResolutionFailure, [System.Net.WebExceptionStatus]::ConnectFailure)) { return 'unreachable' }\n", '');
  assert.notEqual(noEnum, SRC, '变异必须真的改到枚举行');
  assert.throws(() => checkFallbackWiring(noEnum), /枚举快速路径/);

  // 退回「GET 超时优先于 HEAD 拒接」的旧合成：已证实拒接被降级成 unknown
  const weakVerdict = SRC.replace(
    "if ($head -eq 'reachable' -or $get -eq 'reachable') { 'reachable' } elseif ($head -eq 'unreachable' -or $get -eq 'unreachable') { 'unreachable' }",
    "if ($get -eq 'reachable') { 'reachable' } elseif ($head -eq 'unknown' -or $get -eq 'unknown') { 'unknown' }");
  assert.notEqual(weakVerdict, SRC, '变异必须真的改到 verdict 合成');
  assert.throws(() => checkFallbackWiring(weakVerdict), /证据强度排序/);

  // 退回「只要有一半 unknown 就记 unknown 候选」的旧谓词：已证实拒接被兜回 unproven
  const looseUnknown = SRC.replace(
    'if ($verdict -eq \'unknown\' -and -not $unknown) { $unknown = $candidate }',
    'if (($head -eq \'unknown\' -or $get -eq \'unknown\') -and -not $unknown) { $unknown = $candidate }');
  assert.notEqual(looseUnknown, SRC, '变异必须真的改到 $unknown 谓词');
  assert.throws(() => checkFallbackWiring(looseUnknown), /只收 verdict=unknown/);
});
