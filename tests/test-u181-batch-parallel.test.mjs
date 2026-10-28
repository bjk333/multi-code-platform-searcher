// U-181（2026-10-19）：批模式并发可调，且**默认行为不变**
//
// 背景（有决定性对照，见 reports/gates/p02-batch-parallel-2026-10-19/README.md）：
//   4 路并行 × 11 源 = 44 并发 ⇒ 单源延迟被放大 2–3 倍。
//   实测同一批 8 查询：
//     MaxParallel=4（默认）：38s · 95 条 · deadline 9 次 · npm 0 条
//     MaxParallel=1       ：106s · 110 条 · deadline 4 次 · npm 10 条（+15.8%）
//   ⇒ 根因是**并发拥塞**，不是单源 10s 上限太小。
//
// 本门锁两条真契约：
//   A. 两个旋钮存在、被 clamp 到声明范围、且**未设时完全沿用参数默认值**（零行为变更）
//   B. 证据报告必须留下 4 vs 1 的对照读数（含 deadline 次数与 npm 产出）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceAll } from './lib/source.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const MAIN = sourceAll(path.join(ROOT)).replace(/^\uFEFF/, '');
const DOC = fs.readFileSync(path.join(ROOT, 'references', '参数速查.md'), 'utf8');
const REPORT = path.join(ROOT, 'reports', 'gates', 'p02-batch-parallel-2026-10-19', 'README.md');

// 注释剔除（U-178 教训：注释里引用旧写法会被 doesNotMatch 误伤）
const code = MAIN.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');

test('U-181 A: 两个旋钮存在，且被 clamp 到声明范围', () => {
  assert.match(code, /if \(\$env:MCPS_BATCH_MAX_PARALLEL\) \{ \$MaxParallel = \[Math\]::Max\(1, \[Math\]::Min\(8, \[int\]\$env:MCPS_BATCH_MAX_PARALLEL\)\) \}/,
    '★ 并发旋钮必须存在且 clamp 到 1–8（与 param 的 ValidateRange(1,8) 一致）');
  assert.match(code, /if \(\$env:MCPS_BATCH_BUDGET_SEC\) \{ \$BatchBudgetSec = \[Math\]::Max\(10, \[Math\]::Min\(600, \[int\]\$env:MCPS_BATCH_BUDGET_SEC\)\) \}/,
    '★ 预算旋钮必须存在且 clamp 到 10–600（与 ValidateRange(1,600) 的下界放宽为 10）');
});

test('U-181 B: ★ 未设环境变量时完全沿用参数默认值（零行为变更）', () => {
  // 参数默认值必须仍是 4 / 120
  assert.match(code, /\[ValidateRange\(1, 8\)\]\[int\]\$MaxParallel = 4/, '默认并发必须仍是 4');
  assert.match(code, /\[ValidateRange\(1, 600\)\]\[int\]\$BatchBudgetSec = 120/, '默认预算必须仍是 120');
  // 覆盖必须包在 if ($env:...) 内 —— 不得无条件赋值
  const assignLines = code.split(/\r?\n/).filter((l) => /\$MaxParallel = \[Math\]/.test(l) || /\$BatchBudgetSec = \[Math\]/.test(l));
  assert.equal(assignLines.length, 2, '应恰好 2 处覆盖赋值');
  for (const l of assignLines) {
    assert.match(l, /^\s*if \(\$env:MCPS_BATCH_/, '★ 覆盖赋值必须被 `if ($env:MCPS_BATCH_...)` 守卫：' + l.trim().slice(0, 60));
  }
});

test('U-181 C: 文档必须登记两个旋钮，并写明实测取舍（耗时 ↔ 覆盖）', () => {
  assert.match(DOC, /\| `MCPS_BATCH_MAX_PARALLEL` \|/, '必须有 MCPS_BATCH_MAX_PARALLEL 行');
  assert.match(DOC, /\| `MCPS_BATCH_BUDGET_SEC` \|/, '必须有 MCPS_BATCH_BUDGET_SEC 行');
  assert.match(DOC, /deadline/, '文档必须写出 deadline 次数的实测差异（这是取舍的依据）');
  assert.match(DOC, /2\.8×|2\.8x/, '文档必须写出耗时代价（38s → 106s ≈ 2.8×）');
});

test('U-181 D: 证据报告必须留下 4 vs 1 的决定性对照', () => {
  assert.ok(fs.existsSync(REPORT), '证据报告必须存在：' + REPORT);
  const r = fs.readFileSync(REPORT, 'utf8');
  assert.match(r, /MaxParallel\s*=\s*4|并发\s*4|4 路并行/, '必须记录 4 并发的读数');
  assert.match(r, /MaxParallel\s*=\s*1|单并发|并发\s*1/, '必须记录 1 并发的读数');
  assert.match(r, /npm/, '必须记录 npm 的产出变化（0 → 10）—— 这是"结构性 0"被推翻的直接证据');
  assert.match(r, /110/, '必须记录 1 并发下的总条数 110');
});
