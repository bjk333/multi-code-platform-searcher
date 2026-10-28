// U-200（2026-10-21，v1.46.5）：慢源必须**可见**，但不能因此被判"不可信"。
//
// 背景（调研实测）：hex.pm 17.4s / pub.dev 9.6–14.5s / OSV 16.7–21.6s 都超出 10s 引擎预算；
//   报告里只有"整轮 40s"一个数字，看不出是谁拖的；若把慢源直接判 degraded，又把"慢"说成了"错"。
//
// 口径：引擎自身用时 ≥ Cfg.SlowEngineWarnMs（默认 8000，`MCPS_SLOW_ENGINE_MS=0` 关闭）且状态为 ok/empty
//   ⇒ warnings 里加一条"慢源"（Verdict 不变）；error/deadline/rate_limited 不贴"慢"标签（已有各自告警）；无计时记录不猜。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { probeWithMutants, MAIN, PRODUCT_SRC } from './r94-ps-probe.mjs';

const MAIN_SRC = PRODUCT_SRC().replace(/^\uFEFF/, '');

test('U-200 A: 源码契约 —— 阈值可配、只在 TrackStatus 时判定、文案点明"结果可用"', () => {
  assert.match(MAIN_SRC, /SlowEngineWarnMs = 8000/, '默认阈值 8s 必须在 Cfg 里（单一事实源）');
  assert.match(MAIN_SRC, /if \(\$env:MCPS_SLOW_ENGINE_MS\)/, '必须可用环境变量覆盖（0 = 关）');
  assert.match(MAIN_SRC, /Write-SlowEngineWarnings -Engines \$Engines -Timings \$script:_engineTimings -MinMs \(\[int\]\$script:Cfg\.SlowEngineWarnMs\)/, '★ 池尾必须真的调用告警');
  assert.match(MAIN_SRC, /function Write-SlowEngineWarnings \{[\s\S]{0,400}Get-SlowEngines/, '告警器必须基于 Get-SlowEngines 的判定');
  assert.match(MAIN_SRC, /慢源：本次用时 \{0:N1\}s（阈值 \{1:N1\}s）—— 结果可用/, '★ 告警文案必须说"结果可用"（不改判）');
  assert.match(MAIN_SRC, /-notin @\('ok', 'empty'\)/, '★ 只标注成功源；error/deadline 不贴"慢"标签');
});

test('U-200 B: 判定矩阵（慢+成功 ⇒ 命中；快/失败/无计时 ⇒ 不命中）+ 变异', async () => {
  const probe = `
$ErrorActionPreference = 'Stop'
$out = [ordered]@{}
$t = [System.Collections.Concurrent.ConcurrentDictionary[string,int]]::new()
$t['Slow'] = 9000
$t['Fast'] = 100
$t['Err'] = 20000
Set-EngineStatus -Name 'Slow' -Status 'ok' -Reason ''
Set-EngineStatus -Name 'Fast' -Status 'ok' -Reason ''
Set-EngineStatus -Name 'Err' -Status 'error' -Reason 'boom'
$engines = @(
  [pscustomobject]@{ Name = 'Slow' },
  [pscustomobject]@{ Name = 'Fast' },
  [pscustomobject]@{ Name = 'Err' },
  [pscustomobject]@{ Name = 'NoTiming' }
)
$rows = @(Get-SlowEngines -Engines $engines -Timings $t -MinMs 8000)
$out.names = @($rows | ForEach-Object { $_.Name })
$out.ms = @($rows | ForEach-Object { $_.Ms })
$out.disabled = @(Get-SlowEngines -Engines $engines -Timings $t -MinMs 0).Count
$out.none = @(Get-SlowEngines -Engines $engines -Timings $t -MinMs 50000).Count
$out
`;
  const r = await probeWithMutants(probe, [
    {
      name: 'keep-error-status',
      fn: 'Get-SlowEngines',
      find: "if ((Get-EngineStatus -Name $e.Name) -notin @('ok', 'empty')) { continue }",
      replace: '# mutated: status filter removed',
    },
  ], { timeoutMs: 180000 });

  const o = r.real;
  assert.deepEqual(o.names, ['Slow'], '★ 只有"慢且有产出"才命中');
  assert.deepEqual(o.ms, [9000]);
  assert.equal(o.disabled, 0, 'MinMs=0 ⇒ 关闭');
  assert.equal(o.none, 0, '阈值高于所有用时 ⇒ 无');
  assert.ok(r.mutants['keep-error-status'].names.includes('Err'), '★ 变异后仍不报 Err ⇒ 状态过滤没被测到');
});
