// U-229（v1.53.8，2026-10-23）：路由**未证实**时——单请求超时封顶 **且不再重试**。
//
// 事实（实测，2026-10-23 本机）：`-Platform All` 31s 里 GitLab 独占 29s，归因
//   `network-route-unproven: gitlab.com（未确认的路由：HTTPS_PROXY）` ⇒ 引擎 29s 截止。
//   时间构成：逐域探活 4s（NetworkRouteBudgetMs）+ 单请求封顶 8s × 3 次尝试 = 28s。
//
// 为什么"不再重试"是对的：v1.51.0 的封顶语义是「未证实路由上的**单次**请求最多等 8s」——
//   8s 到了还没回应，重试只是把同一个 8s 再等一遍，而探活已经先失败过一次（这是第二次、第三次同样的等待）。
//   与 v1.53.0 的 `Get-CodeRequestBudget`（长请求 MaxAttempts=1）是同一条思路：**等待不能靠乘法放大**。
//
// 判据三层：
//   ① 真值表（纯函数）：reachable 原样 · unknown 且超时>封顶 ⇒ 封顶+1 次 · unknown 但超时已≤封顶 ⇒ 超时原样+1 次 ·
//      **loopback 例外**（本机桩没有探活阶段，照旧重试）· 无路由原样 · 封顶=0 原样；
//   ② 接线：调用点在 `while ($attempt -lt $maxAttempts)` **之前**（否则重试已经发生）· 旧的内联封顶必须消失（单一事实源）；
//   ③ 变异：去掉 loopback 例外 / 把 MaxAttempts=1 改回原值 ⇒ 都必须被点名。

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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u229-'));
    const f = path.join(dir, 'probe.ps1');
    const outFile = path.join(dir, 'out.txt');
    fs.writeFileSync(f, '\ufeff' + body, 'utf8');   // BOM：-File 下让 PS 按 UTF-8 读中文
    const child = spawn(exe, ['-NoProfile', '-NonInteractive', '-File', f], {
      cwd: ROOT, windowsHide: true,
      env: { ...process.env, MCPS_NO_MAIN: '1', U229_OUT: outFile },
    });
    let out = '', err = '';
    const killer = setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } reject(new Error(exe + ' timeout')); }, timeoutMs);
    child.stdout.on('data', (b) => { out += b.toString('utf8'); });
    child.stderr.on('data', (b) => { err += b.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(killer); reject(e); });
    child.on('close', () => {
      clearTimeout(killer);
      let fileOut = '';
      try { fileOut = fs.readFileSync(outFile, 'utf8'); } catch { /* 探针崩溃时无文件 */ }
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 系统清 */ }
      resolve({ out: (fileOut || out).trim(), stdout: out.trim(), err: err.trim() });
    });
    child.stdin.end();
  });
}

const PROBE = `
$ErrorActionPreference = 'Continue'
$env:MCPS_NO_MAIN = '1'
. ./multi-platform-searcher.ps1 -NoEnvFile -Keyword x -Limit 1
function Row([string]$n, $r) { '{0}={1}|{2}|{3}' -f $n, $(if ($r.Capped) { 'Y' } else { 'N' }), $r.TimeoutSec, $r.MaxAttempts }
$rows = @()
$rows += Row 'reachable'    (Resolve-UnprovenRouteBudget -Route ([PSCustomObject]@{ Kind = 'http'; Source = 'HTTPS_PROXY'; ProbeState = 'reachable' }) -TimeoutSec 20 -MaxAttempts 3)
$rows += Row 'unknownBig'   (Resolve-UnprovenRouteBudget -Route ([PSCustomObject]@{ Kind = 'http'; Source = 'HTTPS_PROXY'; ProbeState = 'unknown' })   -TimeoutSec 20 -MaxAttempts 3)
$rows += Row 'unknownSmall' (Resolve-UnprovenRouteBudget -Route ([PSCustomObject]@{ Kind = 'http'; Source = 'HTTPS_PROXY'; ProbeState = 'unknown' })   -TimeoutSec 3  -MaxAttempts 3)
$rows += Row 'loopback'     (Resolve-UnprovenRouteBudget -Route ([PSCustomObject]@{ Kind = 'direct'; Source = 'loopback' })                            -TimeoutSec 20 -MaxAttempts 3)
$rows += Row 'noroute'      (Resolve-UnprovenRouteBudget -Route $null                                                                                  -TimeoutSec 20 -MaxAttempts 3)
$env:MCPS_UNPROVEN_ROUTE_SEC = '0'
$rows += Row 'off'          (Resolve-UnprovenRouteBudget -Route ([PSCustomObject]@{ Kind = 'http'; Source = 'HTTPS_PROXY'; ProbeState = 'unknown' })   -TimeoutSec 20 -MaxAttempts 3)
$env:MCPS_UNPROVEN_ROUTE_SEC = ''
$rows += 'toFull='   + (Test-UnprovenRouteTimeout -Capped $true  -ElapsedSec 8.0 -TimeoutSec 8)
$rows += 'toEdge='   + (Test-UnprovenRouteTimeout -Capped $true  -ElapsedSec 6.4 -TimeoutSec 8)
$rows += 'toFast='   + (Test-UnprovenRouteTimeout -Capped $true  -ElapsedSec 1.2 -TimeoutSec 8)
$rows += 'toNoCap='  + (Test-UnprovenRouteTimeout -Capped $false -ElapsedSec 8.0 -TimeoutSec 8)
$rows += 'toZero='   + (Test-UnprovenRouteTimeout -Capped $true  -ElapsedSec 8.0 -TimeoutSec 0)
[System.IO.File]::WriteAllLines($env:U229_OUT, $rows, (New-Object System.Text.UTF8Encoding($false)))
`;

function parseRows(out) {
  const rows = {};
  for (const line of out.split(/\r?\n/)) {
    const m = /^(reachable|unknownBig|unknownSmall|loopback|noroute|off)=([YN])\|(\d+)\|(\d+)$/.exec(line.trim());
    if (m) { rows[m[1]] = { capped: m[2], timeout: Number(m[3]), attempts: Number(m[4]) }; continue; }
    const b = /^(toFull|toEdge|toFast|toNoCap|toZero)=(True|False)$/.exec(line.trim());
    if (b) rows[b[1]] = b[2];
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

test('U-229 真值表: 未证实路由 ⇒ 封顶 + 只试一次；reachable / loopback / 无路由 / 关闭阀 ⇒ 原样', async () => {
  const exe = await pickExe();
  const { out, err } = await runPs(exe, PROBE);
  const r = parseRows(out);
  assert.ok(r.reachable, 'probe 未产出结果；stderr=' + err.slice(0, 400));

  assert.deepEqual(r.reachable, { capped: 'N', timeout: 20, attempts: 3 }, '★★ reachable 必须原样（不许把健康路由也砍成一次）');
  assert.deepEqual(r.unknownBig, { capped: 'Y', timeout: 8, attempts: 1 }, '★★ 未证实 + 超时 20s ⇒ 封顶 8s 且**只试一次**（这就是本批的全部意义）');
  assert.deepEqual(r.unknownSmall, { capped: 'Y', timeout: 3, attempts: 1 }, '★ 未证实但超时本来就 ≤ 封顶 ⇒ 超时原样、仍只试一次（重试与否与封顶大小无关）');
  assert.deepEqual(r.loopback, { capped: 'N', timeout: 20, attempts: 3 }, '★★ loopback 必须例外：本机桩没有探活阶段，砍重试会打断 test-u177/u188 的本机桩');
  assert.deepEqual(r.noroute, { capped: 'N', timeout: 20, attempts: 3 }, '无路由对象 ⇒ 不做任何改写（fail-open）');
  assert.deepEqual(r.off, { capped: 'N', timeout: 20, attempts: 3 }, '★ MCPS_UNPROVEN_ROUTE_SEC=0 必须整体恢复旧行为（封顶与重试一起）');
  // v1.53.9：node 兜底的取舍 —— 只有"用满超时"才跳，快速传输失败仍走兜底（12e/N-8 契约）
  assert.equal(r.toFull, 'True', '★ 用满超时（8s/8s）⇒ 不再换栈重走同一条路');
  assert.equal(r.toEdge, 'True', '★ 边界 80%（6.4s/8s）必须判真（阈值就是这条线）');
  assert.equal(r.toFast, 'False', '★★ 快速失败（1.2s/8s = DNS/拒接形态）必须**仍走** node 兜底 —— 换栈对这类失败确实可能成');
  assert.equal(r.toNoCap, 'False', '未封顶（路由已证实）⇒ 不跳兜底');
  assert.equal(r.toZero, 'False', 'TimeoutSec=0 ⇒ 不做时间比，fail-open');
});

function checkWiring(src) {
  assert.match(src, /function Resolve-UnprovenRouteBudget\s*\{/, '必须存在 Resolve-UnprovenRouteBudget');
  assert.match(src, /if \(\[string\]\$Route\.Source -eq 'loopback'\) \{ return \$out \}/, '★ loopback 例外必须存在（本机桩靠它）');
  assert.match(src, /MaxAttempts = 1; Capped = \$true/, '★ 未证实路由必须把 MaxAttempts 压到 1');

  const iCall = src.indexOf('Resolve-UnprovenRouteBudget -Route $routeCtx.NetworkRoute');
  assert.ok(iCall > 0, '★ Invoke-ApiRequest 必须调用它（否则规则不存在）');
  const iLoop = src.indexOf('while ($attempt -lt $maxAttempts)', iCall);
  assert.ok(iLoop > iCall, '★ 调用必须早于重试循环 —— 晚了重试已经发生，规则形同不存在');

  // v1.53.9：跳兜底必须发生在 Invoke-ApiNodeFallback **之前**，且条件来自封顶标记
  const iSkip = src.indexOf('Test-UnprovenRouteTimeout -Capped ([bool]$ub.Capped)');
  assert.ok(iSkip > 0, '★ 必须按"封顶 + 用满超时"判定是否跳 node 兜底');
  const iFb = src.indexOf('Invoke-ApiNodeFallback -Uri $Uri', iSkip);
  assert.ok(iFb > iSkip, '★ 判定必须早于 node 兜底调用');
  assert.match(src, /function Test-UnprovenRouteTimeout\s*\{/, '必须存在 Test-UnprovenRouteTimeout');
  assert.match(src, /\$ElapsedSec -ge \(\$TimeoutSec \* \$Ratio\)/, '★ 判据必须是"耗时 ≥ 超时×比例"（不是恒真）');

  // 单一事实源：旧的内联封顶（$unprovenCap）必须彻底消失
  assert.ok(!src.includes('$unprovenCap'), '★ 旧的内联封顶仍在 ⇒ 两处各算一遍，迟早不一致');
  assert.equal((src.match(/Resolve-UnprovenRouteBudget -Route \$routeCtx\.NetworkRoute/g) || []).length, 1, '调用点只能有一处');
}

test('U-229 接线: 调用早于重试循环、旧内联封顶已移除、loopback 与 MaxAttempts=1 都在', () => {
  checkWiring(SRC);
});

test('U-229 negative control: 去掉 loopback 例外 / 不压 MaxAttempts / 留回内联封顶 —— 三者都必须被点名', () => {
  const noLoop = SRC.replace("if ([string]$Route.Source -eq 'loopback') { return $out }", 'if ($false) { return $out }');
  assert.notEqual(noLoop, SRC, 'mutation 1 must drop the loopback bypass');
  assert.throws(() => checkWiring(noLoop), /loopback 例外必须存在/);

  const noClamp = SRC.replace('MaxAttempts = 1; Capped = $true', 'MaxAttempts = $MaxAttempts; Capped = $true');
  assert.notEqual(noClamp, SRC, 'mutation 2 must stop clamping attempts');
  assert.throws(() => checkWiring(noClamp), /必须把 MaxAttempts 压到 1/);

  const noSkip = SRC.replace('if (Test-UnprovenRouteTimeout -Capped ([bool]$ub.Capped) -ElapsedSec $reqSw.Elapsed.TotalSeconds -TimeoutSec $TimeoutSec) { throw', 'if ($false) { throw');
  assert.notEqual(noSkip, SRC, 'mutation must drop the fallback skip');
  assert.throws(() => checkWiring(noSkip), /封顶 \+ 用满超时/);

  const back = SRC.replace('Resolve-UnprovenRouteBudget -Route $routeCtx.NetworkRoute', '$unprovenCap = Resolve-UnprovenRouteBudget -Route $routeCtx.NetworkRoute');
  assert.notEqual(back, SRC, 'mutation 3 must reintroduce the old inline variable');
  assert.throws(() => checkWiring(back), /旧的内联封顶仍在/);
});
