// R4-F1 · 代码通路「重试预算」不变式门
//
// 病灶（R4-0b 实测 + 代码核对）：
//   代码通路四个引擎原先都吃默认 —— 单请求 15s（ApiTimeoutDefaultSec）× MaxAttempts=3 = **最坏 45s**，
//   而 code 路径的引擎级截止只有 EngineDeadlineCodeSec = **17s**
//   ⇒ 一次网络抖动就让引擎**必然以 deadline 死掉**、**重试根本来不及发生**
//   ⇒ 唯一在工作的代码源偶发失败 ⇒ **整条代码证据通道 0 条**（`errors=["engines.GitHubCode:deadline"]`）。
//
// 本门把不变式变成**可断言**的，防这类"配置不自洽"再现：
//   ① 不变式：CodeRequestTimeoutSec × CodeRequestMaxAttempts + RetryBaseSec ≤ EngineDeadlineCodeSec
//   ② 四个 Kind=code 引擎的**每一处真实** Invoke-ApiRequest 都**显式**传超时与尝试次数（不许吃默认）
//   ③ 负例：默认值本身**就是超预算的**（15×3+2=47 > 17）⇒ 证明"必须显式传"不是无的放矢
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceAll } from './lib/source.mjs';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(testsDir, '..');
const MAIN = sourceAll(path.join(root));

function cfgNum(name) {
  const m = new RegExp('^\\s*' + name + '\\s*=\\s*(\\d+)', 'm').exec(MAIN);
  assert.ok(m, `Cfg 里必须有 ${name}（本门靠它算预算，缺了就是门失效）`);
  return Number(m[1]);
}
// Kind=code 的引擎（来自 x-engineCatalog 的权威口径）+ 仓库级独立通道（searchcode，串行于池外）—— 均属 code 通路请求预算守护面
// v1.39.0（A 线归并批）：+ se-excerpts.ps1 / searchcode-repo.ps1 两个新通道（"不许吃默认"对它们同样适用）
const CODE_ENGINE_FILES = ['github-code.ps1', 'gitlab-blobs.ps1', 'grep-app.ps1', 'se-excerpts.ps1', 'sourcegraph.ps1', 'searchcode-repo.ps1'];

test('R4-F1-1（不变式）: code 通路重试预算必须落在引擎截止之内', () => {
  const single = cfgNum('CodeRequestTimeoutSec');
  const attempts = cfgNum('CodeRequestMaxAttempts');
  const backoff = cfgNum('RetryBaseSec');
  const cap = cfgNum('EngineDeadlineCodeSec');
  const budget = single * attempts + backoff;
  console.log(`[R4-F1] 预算 = ${single}s × ${attempts} + 退避 ${backoff}s = ${budget}s  vs 引擎截止 ${cap}s`);
  assert.ok(attempts >= 2, `★至少 2 次尝试（否则"重试"是名义上的），实得 ${attempts}`);
  assert.ok(budget <= cap, `★重试预算 ${budget}s 必须 ≤ 引擎截止 ${cap}s —— 否则重试必然来不及发生（这正是本缺陷）`);
});

test('R4-F1-2（不许吃默认）: code 通路引擎的每一处真实请求都显式传超时与尝试次数', () => {
  const offenders = [];
  for (const f of CODE_ENGINE_FILES) {
    const p = path.join(root, 'engines', f);
    assert.ok(fs.existsSync(p), `code 引擎文件必须存在: ${f}`);
    const phys = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
    // ★必须先合并 backtick 续行再判：首版逐行判，把我自己写的两行续行误报成"缺参数"
    //   —— 判据要按**逻辑行**看，不是物理行。保留起始物理行号便于报错定位。
    const logical = [];
    for (let i = 0; i < phys.length; i++) {
      let text = phys[i], start = i + 1;
      while (/`\s*$/.test(text) && i + 1 < phys.length) { text = text.replace(/`\s*$/, '') + ' ' + phys[++i].trim(); }
      logical.push({ text, start });
    }
    for (const { text, start } of logical) {
      if (!/Invoke-ApiRequest/.test(text)) continue;
      if (/^\s*#/.test(text)) continue;                       // 注释不算
      if (/-TimeoutSec/.test(text) && /-MaxAttempts/.test(text)) continue;
      offenders.push(`${f}:${start}  ${text.trim().slice(0, 90)}`);
    }
  }
  assert.deepEqual(offenders, [],
    '★这些 code 通路请求在吃默认（15s × 3 = 最坏 45s > 17s 截止）⇒ 抖动一次就丢整条通道:\n  ' + offenders.join('\n  '));
});

test('R4-F1-3（负例 · 证明"必须显式传"不是无的放矢）: 默认值本身超预算', () => {
  const defSingle = cfgNum('ApiTimeoutDefaultSec');
  const defAttempts = cfgNum('MaxAttempts');
  const backoff = cfgNum('RetryBaseSec');
  const cap = cfgNum('EngineDeadlineCodeSec');
  const defaultBudget = defSingle * defAttempts + backoff;
  console.log(`[R4-F1] 默认预算 = ${defSingle}s × ${defAttempts} + 退避 ${backoff}s = ${defaultBudget}s  >  截止 ${cap}s`);
  assert.ok(defaultBudget > cap,
    '★若默认值已经落在截止内，则"必须显式传 code 预算"这条约定可以重新评估（此时本门会红，提示复核）');
});

test('R4-F1-4（主脚本里的嵌套池也要守）: 嵌套 Runspace 内的请求同样显式传预算', () => {
  // 原 gitlab 内层 scriptblock（现居主脚本）会自己发请求 —— 它吃默认同样出事
  // v1.54.0（B3-2）：注册表（lib/config.ps1）也含这个函数名，且现在排在前面 ⇒ 必须锚函数定义，不能锚裸名字。
  const idx = MAIN.indexOf('function Invoke-GitLabProjectBlobSearch {');
  assert.ok(idx > 0, '必须找得到嵌套池宿主函数');
  const seg = MAIN.slice(idx, idx + 6000);
  assert.match(seg, /Invoke-ApiRequest[\s\S]{0,200}?-TimeoutSec \$script:Cfg\.CodeRequestTimeoutSec/,
    '★嵌套池内的 Invoke-ApiRequest 必须显式传 code 预算（它不在引擎文件里，容易被漏）');
});
