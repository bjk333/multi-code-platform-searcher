// U-193（2026-10-21，v1.46.4）：Doctor 的端点生命周期 —— "没探到"不得写成 active/false。
//
// 事实：2026-10-21 16:12 的 doctor.json 里
//   githubCodeSearchDeprecation = { Http: null, Note: "探测预算耗尽...", Lifecycle: { State: "active", Deprecated: false } }
//   即：探针根本没拿到响应，却断言"该端点未废弃"。与"0 命中必须可区分"同族。
//
// 口径：-Http 0 = 本次没有任何 HTTP 响应 ⇒ State=unknown / Deprecated=null；
//       -Http 200 + 无头 = active/false（有证据的"未废弃"）；默认 -Http -1 保留旧的纯头解析语义。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { probeWithMutants, rootDir, MAIN } from './r94-ps-probe.mjs';
import { sourceAll } from './lib/source.mjs';

const read = (p) => fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
const MAIN_SRC = sourceAll(rootDir);   // v1.54.0（B3-2）：读加载后视图

test('U-193 A: 源码契约 —— Http=0 走 unknown；Doctor 必须把真实 Http 传进来', () => {
  assert.match(MAIN_SRC, /param\(\[string\]\$Deprecation, \[string\]\$Sunset, \[int\]\$Http = -1/, 'Get-EndpointLifecycle 必须有 -Http');
  assert.match(MAIN_SRC, /if \(\$Http -eq 0\) \{[\s\S]{0,300}State = 'unknown'/, '★ Http=0 必须返回 unknown');
  assert.match(MAIN_SRC, /Get-EndpointLifecycle -Deprecation \$ghCodeDeprecation\.Deprecation -Sunset \$ghCodeDeprecation\.Sunset -Http \(\[int\]\$ghCodeDeprecation\.Http\)/,
    '★ Doctor 必须传 -Http（否则超时仍会被写成 active）');
});

test('U-193 B: 四种输入的 State/Deprecated + 变异（去掉 Http 守卫 ⇒ unknown 退化成 active）', async () => {
  const probe = `
$ErrorActionPreference = 'Stop'
$out = [ordered]@{}
$now = [datetime]::Parse('2026-10-21T00:00:00Z').ToUniversalTime()
$out.unknown = Get-EndpointLifecycle -Deprecation '' -Sunset '' -Http 0
$out.active  = Get-EndpointLifecycle -Deprecation '' -Sunset '' -Http 200
$out.dep     = Get-EndpointLifecycle -Deprecation '@1767225600' -Sunset '' -Http 200
$out.sunset  = Get-EndpointLifecycle -Deprecation 'true' -Sunset 'Sun, 27 Sep 2026 00:00:00 GMT' -Http 200 -Now $now
$out.legacy  = Get-EndpointLifecycle -Deprecation '' -Sunset ''
$out
`;
  const r = await probeWithMutants(probe, [
    { name: 'no-http-guard', fn: 'Get-EndpointLifecycle', find: 'if ($Http -eq 0) {', replace: 'if ($false) {' },
  ], { timeoutMs: 180000 });

  const o = r.real;
  assert.equal(o.unknown.State, 'unknown', '★ Http=0 必须 unknown');
  assert.equal(o.unknown.Deprecated, null, '★ 未探测时 Deprecated 必须是 null（不是 false）');
  assert.equal(o.unknown.Sunset, null);
  assert.equal(o.active.State, 'active', 'Http 200 + 无头 ⇒ active（有证据）');
  assert.equal(o.active.Deprecated, false);
  assert.equal(o.dep.State, 'deprecated');
  assert.equal(o.dep.Deprecated, true);
  assert.equal(o.sunset.State, 'sunset-passed');
  assert.equal(o.legacy.State, 'active', '默认 -Http -1 保留旧的纯头解析语义');

  const m = r.mutants['no-http-guard'];
  assert.equal(m.unknown.State, 'active', '★ 变异后仍是 unknown ⇒ 守卫没被真正测到');
});
