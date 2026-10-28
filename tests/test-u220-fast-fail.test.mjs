// U-220（2026-10-22，v1.51.0）：确定性失败快速失败（Tier1-1）。
//
// 依据（reports/全模块目标验收与下一阶段方案-2026-10-22.md §3.1 调研）：业界对"确定性传输失败"
//   （代理 CONNECT 失败 / DNS 解析失败 / 连接被拒）不给任何等待预算 —— 同一坏路由上重试、
//   或走同一条坏代理做 TLS 兜底，都是纯损耗。本机实测：-Auto 单轮 HF 独占 22.2s、
//   GitHubCode 的 reason 里先出现代理 502、再被 node 兜底按同一代理打一遍。
// 三处接线：① 死主机零等待跳过（route context 之前）② 确定性失败零重试不走 TLS 兜底并登记
//   ③ 未证实路由的单次请求超时封顶（8s ≥ socks 冷启动 6s，不误伤慢代理）。
// 三层判据：真值表（dot-source 直测）+ 接线静态断言（可变异）+ 死主机登记行为。
// ★R2 卫生门：本文件只用异步 spawn（新文件禁 spawnSync）。
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

function pwshFile(script, timeout = 120000) {
  return new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u220-'));
    const f = path.join(dir, 'probe.ps1');
    fs.writeFileSync(f, '﻿' + script, 'utf8');
    const child = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-File', f], { cwd: ROOT, windowsHide: true });
    let out = '', err = '';
    const t = setTimeout(() => { try { child.kill(); } catch { } reject(new Error('probe timeout')); }, timeout);
    child.stdout.on('data', (b) => { out += b.toString('utf8'); });
    child.stderr.on('data', (b) => { err += b.toString('utf8'); });
    child.once('error', (e) => { clearTimeout(t); reject(e); });
    child.once('close', () => {
      clearTimeout(t);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { }
      const lines = out.trim().split(/\r?\n/).filter(Boolean);
      if (!lines.length) return reject(new Error('probe produced no output: ' + err.slice(0, 300)));
      try { resolve(JSON.parse(lines[lines.length - 1])); } catch (e) { reject(new Error('bad json: ' + out.slice(0, 300))); }
    });
  });
}

const PROBE = `
$ErrorActionPreference = 'Stop'
$env:MCPS_NO_MAIN = '1'
. ./multi-platform-searcher.ps1 -NoEnvFile -Keyword x -Limit 1
$cases = @(
  @{ n = 'proxyTunnel'; t = "The proxy tunnel request to proxy 'http://127.0.0.1:13828/' failed with status code '502'." },
  @{ n = 'dns';         t = 'The remote name could not be resolved: huggingface.co' },
  @{ n = 'connect';     t = 'Unable to connect to the remote server' },
  @{ n = 'timeout';     t = 'The request was canceled due to the configured HttpClient.Timeout of 6 seconds elapsing.' },
  @{ n = 'http500';     t = 'Response status code does not indicate success: 500 (Internal Server Error).' },
  @{ n = 'empty';       t = '' },
  # v1.53.5：PS 5.1 的代理 CONNECT 502 措辞（与 PS 7 完全不同）—— 有代理时必须判 proxy-tunnel
  @{ n = 'ps51Proxy502';   t = '基础连接已经关闭: 发送时发生错误。 由于远程方已关闭传输流，身份验证失败。'; proxy = $true },
  @{ n = 'ps51NoProxy502'; t = '基础连接已经关闭: 发送时发生错误。 由于远程方已关闭传输流，身份验证失败。'; proxy = $false },
  @{ n = 'tlsCertNoProxy'; t = '基础连接已经关闭: 无法建立 SSL/TLS 的安全通道。'; proxy = $false }
)
$out = foreach ($c in $cases) {
  [PSCustomObject]@{ n = $c.n; code = [string](Test-DeterministicTransportFailure -Text $c.t -ProxyActive ([bool]$c.proxy)) }
}
# Get-TransportFailureText：必须把 InnerException 一并取出（PS 5.1 的证据只在那里）
try {
  throw (New-Object System.Net.WebException('基础连接已经关闭: 发送时发生错误。', (New-Object System.IO.IOException('由于远程方已关闭传输流，身份验证失败。'))))
} catch { $we = $_ }
$helperText = Get-TransportFailureText -ErrorRecord $we
$helperHasInner = ($helperText -match '远程方已关闭传输流')
$helperCode = [string](Test-DeterministicTransportFailure -Text $helperText -ProxyActive $true)
# 死主机登记：登记后可取回、不同主机不串、未登记返回空
Set-DeadNetworkHost -HostName 'dead.example.com' -Reason 'proxy-tunnel'
$hit = [string](Get-DeadNetworkHost -HostName 'dead.example.com')
$miss = [string](Get-DeadNetworkHost -HostName 'other.example.com')
[PSCustomObject]@{ deadGet = $hit; deadMissEmpty = ($miss -eq ''); registry = @($out); helperHasInner = $helperHasInner; helperCode = $helperCode } | ConvertTo-Json -Depth 5 -Compress
`;

test('U-220 A: 真值表 —— 代理/ DNS / 连接被拒判确定性；超时/5xx/空串不算（后者要保留重试）', async () => {
  const r = await pwshFile(PROBE);
  const by = Object.fromEntries(r.registry.map((x) => [x.n, x.code]));
  assert.equal(by.proxyTunnel, 'proxy-tunnel', '代理 CONNECT 失败必须判确定性');
  assert.equal(by.dns, 'dns-or-refused', 'DNS 解析失败必须判确定性');
  assert.equal(by.connect, 'connect', '连接被拒必须判确定性');
  assert.equal(by.timeout, '', '★超时不是确定性失败 —— 慢代理/冷启动值得重试（U-206 实测 socks 6s）');
  assert.equal(by.http500, '', '★5xx 是服务端抖动，保留既有重试语义，不得被本函数洗掉');
  assert.equal(by.empty, '', '空输入必须返回空，不得抛');
  // v1.53.5：PS 5.1 措辞（本批实测 —— 此前在默认运行时上 proxy-tunnel 从不命中）
  assert.equal(by.ps51Proxy502, 'proxy-tunnel', '★ PS 5.1 的代理 CONNECT 502（基础连接已关闭 + Inner 远程方已关闭传输流）必须判 proxy-tunnel');
  assert.equal(by.ps51NoProxy502, '', '★ 同一措辞在**无代理**时必须保留重试（直连 TLS 抖动可能是可恢复的）');
  assert.equal(by.tlsCertNoProxy, '', '直连证书/TLS 失败不得被当成代理隧道问题（不在本函数职责内）');
  assert.equal(r.helperHasInner, true, '★ Get-TransportFailureText 必须取出 InnerException —— PS 5.1 的证据只在那里');
  assert.equal(r.helperCode, 'proxy-tunnel', 'helper 拼出的文本必须能被分类器认成 proxy-tunnel（两者同源）');
  // 死主机登记行为
  assert.equal(r.deadGet, 'proxy-tunnel', '登记后必须可取回');
  assert.equal(r.deadMissEmpty, true, '未登记主机必须返回空（不得把 A 的登记串给 B）');
});

function checkWiring(src) {
  assert.match(src, /\$deadWhy = Get-DeadNetworkHost -HostName \$reqHost[\s\S]{0,200}if \(\$deadWhy\) \{ throw \("network-unavailable/,
    '★死主机检查必须在路由探活之前（探活本身 4s 预算，在死主机上是纯损耗）');
  assert.match(src, /\$detFail = Test-DeterministicTransportFailure -Text[\s\S]{0,400}if \(\$detFail -eq 'proxy-tunnel'\) \{[\s\S]{0,200}throw \("deterministic-fail:/,
    '★确定性失败必须零重试、不走 TLS 兜底（node 兜底走的是同一条坏代理）');
  // 行动边界：只有 proxy-tunnel 触发跳兜底 —— dns/connect 仍走 node 兜底（run-tests 12e/N-8 契约：另一套栈可能成功）
  assert.equal((src.match(/\$detFail -eq 'proxy-tunnel'/g) || []).length, 2, 'web/代理两个 catch 的快速失败都只对 proxy-tunnel');
  // v1.53.5：三处调用点都必须把"当前是否走代理"传进分类器，否则 PS 5.1 的新规则永不生效
  assert.equal((src.match(/-ProxyActive \(\[bool\]\$proxyMode\)/g) || []).length, 3, '★ detP + 两个 detFail 都必须传 -ProxyActive');
  assert.match(src, /function Get-TransportFailureText\s*\{/, '必须存在 Get-TransportFailureText');
  assert.match(src, /while \(\$inner -and \$inner\.InnerException\)/, '★ helper 必须逐层取 InnerException（PS 5.1 的证据在第二层）');
  // v1.53.8：封顶逻辑抽成 Resolve-UnprovenRouteBudget（并顺带把重试压到 1 次），锚点改到**调用点**
  //   —— 旧的 `$unprovenCap` 内联表达式已不存在，死锚在字面上会让正确实现判红（本仓第 N 次）。
  assert.match(src, /\$ub = Resolve-UnprovenRouteBudget -Route \$routeCtx\.NetworkRoute -TimeoutSec \$TimeoutSec -MaxAttempts \$maxAttempts/,
    '★未证实路由必须封顶单次请求超时（挂死在未证实路由是死代理的主要形态）');
  assert.match(src, /\$TimeoutSec = \$ub\.TimeoutSec; \$maxAttempts = \$ub\.MaxAttempts/,
    '★封顶结果必须同时改超时与尝试次数（v1.53.8 起未证实路由只试一次）');
}
test('U-220 B: 三处接线都在 —— 死主机跳过 / 零重试不兜底 / 未证实路由封顶', () => {
  checkWiring(SRC);
});

test('U-220 C negative control: 三处接线任一被拆都必须被点名', () => {
  const noDeadHost = SRC.replace('$deadWhy = Get-DeadNetworkHost -HostName $reqHost; if ($deadWhy)', '$deadWhy = $null; if ($false)');
  assert.notEqual(noDeadHost, SRC, 'mutation must hit the dead-host check');
  assert.throws(() => checkWiring(noDeadHost), /死主机检查/);
  const noFastFail = SRC.split('throw ("deterministic-fail: {0} ({1}) {2}" -f $detFail, $reqHost, $traceUri)').join('throw "重试次数耗尽"');
  assert.notEqual(noFastFail, SRC, 'mutation must hit the deterministic-fail throw');
  assert.throws(() => checkWiring(noFastFail), /零重试|不走 TLS/);
  const noCap = SRC.replace('$ub = Resolve-UnprovenRouteBudget -Route $routeCtx.NetworkRoute', '$ub = $null; $null = 1');
  assert.notEqual(noCap, SRC, 'mutation must hit the unproven cap');
  assert.throws(() => checkWiring(noCap), /封顶单次请求超时/);
  const noAttemptCut = SRC.replace('$maxAttempts = $ub.MaxAttempts', '$maxAttempts = $maxAttempts');
  assert.notEqual(noAttemptCut, SRC, 'mutation must drop the attempt cut');
  assert.throws(() => checkWiring(noAttemptCut), /同时改超时与尝试次数/);
});
