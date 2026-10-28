// U-171：`coverage.Verdict` 的派生**必须**把「请求了却没跑」算作降级（P0-D）
//   背景（2026-10-19 实测）：池提前收工时，Requested 里的源既不在 Executed 也不在 Blocked/Degraded，
//   会从覆盖里**静默消失** ⇒ Verdict=full（假绿）。样本：reports/gates/e4-step4-2026-10-19/code-nocap.json
//     （Requested 4 / Executed 2 / Degraded [] / Verdict=full）
//   本门是**契约锁**：钉住派生分支的优先级顺序，删掉/挪错分支即红。
//   ⚠️ 本门不联网：纯源码级（该场景依赖"池提前收工"的时序，不可稳定复现）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceAll } from './lib/source.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = sourceAll(path.join(ROOT));

/** 取出 coverage 的 Verdict 派生表达式：优先单行 `Verdict = $(if ... )`，v1.49.0 起是 Get-CoverageVerdict 函数体。 */
function verdictExpr(src) {
  const inline = /Verdict\s*=\s*\$\(if \(([^)]*)\) \{ 'none' \}([\s\S]*?)\)\s*\n/.exec(src);
  if (inline) return inline[0];
  const fn = /function Get-CoverageVerdict \{[\s\S]*?\n\}/.exec(src);
  assert.ok(fn, 'Verdict 派生表达式锚点变了 ⇒ 同步改本门');
  return fn[0];
}

/** 断言分支出现顺序（这是契约：先 none，再 blocked，再 degraded，再 notRun，再 no-engines，最后 full）。 */
function orderOf(expr) {
  const marks = ['none', 'partial', 'degraded', 'hasNotRun', 'no-engines', 'full'];
  // v1.49.0：只取"分支行"（return / elseif）—— 否则函数签名里的 $HasNotRun 形参会把
  //   hasNotRun 的位置拉到最前面，顺序断言就失去意义。
  const branchLines = expr.split(/\r?\n/).filter(l => /return|elseif/.test(l));
  const body = branchLines.length > 0 ? branchLines.join('\n') : expr;
  const pos = marks.map(k => {
    const m = new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').exec(body);
    return [k, m ? m.index : -1];
  });
  for (const [k, p] of pos) assert.notEqual(p, -1, '派生表达式缺少分支: ' + k);
  return pos;
}

test('U-171-1: Verdict 派生必须含 hasNotRun 分支，且位于 degraded 之后、full 之前', () => {
  const expr = verdictExpr(SRC);
  const pos = orderOf(expr);
  const idx = Object.fromEntries(pos);
  assert.ok(idx.hasNotRun > idx.degraded, "'hasNotRun' 必须在 'degraded' 之后");
  assert.ok(idx.hasNotRun < idx['no-engines'], "'hasNotRun' 必须早于 'no-engines'");
  assert.ok(idx.hasNotRun < idx.full, "'hasNotRun' 必须早于 'full' 回退");
});

test('U-171-2: notRun 的集合定义必须是 Requested − Executed − Blocked − Degraded', () => {
  const m = /\$notRunEngines\s*=\s*@\(\$requestedEngines \| Where-Object \{([^}]*)\}\)/.exec(SRC);
  assert.ok(m, '$notRunEngines 定义缺失或形状变了');
  const body = m[1];
  for (const ex of ['$executedEngines', '$blockedEngines', '$degradedEngines']) {
    assert.match(body, new RegExp('\\' + ex + '\\s*-notcontains'), 'notRun 必须排除 ' + ex.replace('$', '') + '（Degraded = 执行过但失败，不算「没跑」）');
  }
});

test('U-171-3: 有 notRun 时必须给 warning（否则读者无法察觉）', () => {
  assert.match(SRC, /if \(\$hasNotRun\) \{ Add-EngineWarning -Engine 'coverage' -Message \('请求但未执行/,
    'hasNotRun 必须有 Add-EngineWarning（点名未执行的源）');
});

test('U-171-4: 退出码也要算 notRun（否则 Verdict=degraded 但 exit=0 自相矛盾）', () => {
  assert.match(SRC, /if \(\$hasBlocked -or \$hasDegraded -or \$hasNotRun\) \{/,
    '退出码分支必须包含 $hasNotRun');
});

test('U-171-5 负例（门自检）：删掉 hasNotRun 分支必须被本门抓住', () => {
  // v1.49.0：Verdict 可能是内联 elseif，也可能是 Get-CoverageVerdict 里的 if + return
  const broken = SRC.replace(/(\s*elseif \(\$hasNotRun\) \{ 'degraded' \}|\s*if \(\$HasNotRun\) \{ return 'degraded' \})/, '');
  assert.notEqual(broken, SRC, '负例必须真的改到源码');
  assert.throws(() => orderOf(verdictExpr(broken)), /缺少分支: hasNotRun/);
});
