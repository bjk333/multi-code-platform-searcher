// U-194（2026-10-21，v1.46.5）：Doctor 必须能区分"本机 hosts 劫持"与"远端挂了"。
//
// 事实：本机 hosts 有 `127.0.0.1 api.github.com #S302`，而 443 无本地监听 ⇒ 所有 api.github.com 请求 TCP 直接 EOF；
//   旧 Doctor 只写 `Probe=timeout` / `Status=timeout`，人读到的是"GitHub 超时"，会去查 GitHub 状态页。
//
// 口径：
//   · 只在**传输层失败**（timeout/unreachable/error）时判 hosts；上游真回了 401/403/429 一律不改判（那是真实回答）；
//   · 命中 ⇒ `Probe=hosts_hijack` + `HostsOverride=<原始行>`（令牌行、研究行、废弃头探针三处口径一致）；
//   · doctor 顶层 `hostsOverrides[]` 汇总，去重、按 Target 排序。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { probeWithMutants, MAIN, PRODUCT_SRC } from './r94-ps-probe.mjs';

const MAIN_SRC = PRODUCT_SRC().replace(/^\uFEFF/, '');

test('U-194 A: 源码契约 —— 三处诊断都接 hosts 判定，且有顶层汇总', () => {
  assert.match(MAIN_SRC, /function Get-HostsOverride/, '必须有 hosts 只读解析');
  assert.match(MAIN_SRC, /function Test-LoopbackAddress/, '必须能判回环地址');
  assert.match(MAIN_SRC, /\$tk\.Probe = 'hosts_hijack'/, '★ 令牌探针命中时要改诊断为 hosts_hijack');
  assert.match(MAIN_SRC, /\$row \| Add-Member -NotePropertyName 'Probe' -NotePropertyValue \$\(if \(\$ov\) \{ 'hosts_hijack' \}/, '★ 研究探针行也要带 hosts 诊断');
  assert.match(MAIN_SRC, /Probe\s+= \$\(if \(\$ghHij\) \{ 'hosts_hijack' \} else \{ 'error' \}\)/, '★ 废弃头探针失败要分 hosts/其它');
  assert.match(MAIN_SRC, /\$doctorReport\['hostsOverrides'\]/, '顶层必须汇总 hostsOverrides');
  assert.match(MAIN_SRC, /if \(\$Probe -match '\^HTTP\\s\+\\d\{3\}'\) \{ return \$null \}/, '★ 上游有 HTTP 回答时不得判 hosts 劫持');
});

test('U-194 B: 回环判定 + 只对传输层失败生效（变异：回环正则写错 ⇒ 判定失效）', async () => {
  const probe = `
$ErrorActionPreference = 'Stop'
$out = [ordered]@{}
$out.loop1 = Test-LoopbackAddress -Ip '127.0.0.1'
$out.loop2 = Test-LoopbackAddress -Ip '::1'
$out.loop3 = Test-LoopbackAddress -Ip '127.5.6.7'
$out.loopNo = Test-LoopbackAddress -Ip '10.1.2.3'
$out.loopEmpty = Test-LoopbackAddress -Ip ''
$out.httpAnswered = Get-HostsHijackHint -Uri 'https://api.github.com/user' -Probe 'HTTP 401'
$out.http429 = Get-HostsHijackHint -Uri 'https://api.github.com/user' -Probe 'HTTP 429'
$out.unknownHost = Get-HostsHijackHint -Uri 'https://no-such-host-in-hosts-xyz.invalid/' -Probe 'timeout'
$out
`;
  const r = await probeWithMutants(probe, [
    { name: 'loopback-regex', fn: 'Test-LoopbackAddress', find: "return ($s -match '^127\\.')", replace: "return ($s -match '^999\\.')" },
  ], { timeoutMs: 180000 });

  const o = r.real;
  assert.equal(o.loop1, true);
  assert.equal(o.loop2, true, '::1 是回环');
  assert.equal(o.loop3, true);
  assert.equal(o.loopNo, false);
  assert.equal(o.loopEmpty, false);
  assert.equal(o.httpAnswered, null, '★ 上游回了 401 ⇒ 不是 hosts 劫持（令牌问题）');
  assert.equal(o.http429, null, '★ 429 同理');
  assert.equal(o.unknownHost, null, 'hosts 里没有的域名 ⇒ null');

  assert.equal(r.mutants['loopback-regex'].loop1, false, '★ 变异后仍判回环 ⇒ 这道门没测到正则');
});
