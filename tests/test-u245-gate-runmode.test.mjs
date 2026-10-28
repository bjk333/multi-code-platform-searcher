// U-245（v1.53.26，验收 B1-5）：「门禁的绿必须有 provenance」—— 先落 `run_mode` 与**并行红串行复核**。
//
// 为什么要有这条门（2026-10-25 B1-3 实测）：
//   · 一次全量**并行**跑：11 条红；同文件**单跑全绿**的 8 条（`r4-docs` 40/0、`r2-post-fallback` 9/0、`n9` 4/0）；
//   · 而 `product_red` 是"能不能发布"的唯一判据 ⇒ 并行噪声会同时造成两种错：
//     要么为了发版而忽略真红，要么永远发不了版（真红淹没在 8 条假红里）。
//   · 处置不是"放宽判据"，而是**换判据**：只有**串行复现**的红才算 product；
//     并行红但串行过 ⇒ `env:flaky-parallel`（rc 仍非 0，**不冒充绿**）。
//
// 门分三层：
//   A 计数与退出码：`repartition` 是唯一的分区计数实现（复核后要用同一把尺子重新计数）；
//   B 合并真值表：`mergeRecheck` 的 4 个分支（过/又红/复核没跑成/复核冒新红）—— 每条都对应一种"假绿"或"假红"；
//   C 接线与变异：CLI 必须走 `runGatesVerified`、复核必须 `mode:'serial'` 且只带失败文件、`run_mode` 必须被记录。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { repartition, summarize, exitCodeFor, ENV_KINDS, RECHECK_KIND } from './gate-partition.mjs';
import { mergeRecheck } from './run-node-gates.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'tests', 'run-node-gates.mjs'), 'utf8');

/** 取函数体（`export [async] function X(` 到列 0 的 `}`）—— ★必须容忍 `async`，本门第一版就把它漏了 */
function fnBody(src, name) {
  const i = src.indexOf(`export function ${name}(`) >= 0
    ? src.indexOf(`export function ${name}(`)
    : src.indexOf(`export async function ${name}(`);
  assert.ok(i > 0, `函数缺失：${name}`);
  const j = src.indexOf('\n}', i);
  assert.ok(j > i, `函数体未闭合：${name}`);
  return src.slice(i, j);
}
/** 两个 run 结果的样板：reds 里 file/name 决定"是不是同一文件" */
function run(reds, code = 1, runMode = 'parallel') {
  const summary = repartition(reds, { runMode });
  return { code, signal: null, summary, rc: exitCodeFor(summary, code) };
}

test('U-245-A: repartition 是唯一计数口径（product/env/byKind/退出码一起变）', () => {
  const s = repartition([
    { name: 'a', cls: 'product' },
    { name: 'b', cls: 'env', kind: 'timing' },
    { name: 'c', cls: 'env', kind: 'timing' },
    { name: 'd', cls: 'env', kind: 'safe-delete-shim' },
  ], { runMode: 'serial' });
  assert.equal(s.productRed, 1);
  assert.equal(s.envRed, 3);
  assert.deepEqual(s.envByKind, { timing: 2, 'safe-delete-shim': 1 });
  assert.equal(s.runMode, 'serial');
  assert.equal(exitCodeFor(s, 0), 1, 'product 红 ⇒ 1');
  assert.equal(exitCodeFor(repartition([{ name: 'x', cls: 'env', kind: 'timing' }]), 0), 3, '只有 env 红 ⇒ 3（不是绿）');
  assert.equal(exitCodeFor(repartition([]), 0), 0, '全清 ⇒ 0');
  assert.equal(exitCodeFor(repartition([]), 1), 1, '子进程非 0 却没有可归类的红 ⇒ product（fail-closed）');
  // summarize 与 repartition 必须同源：同一批 reds 两条路的结果逐字段相等
  const reds = [{ name: 'a', cls: 'product' }, { name: 'b', cls: 'env', kind: 'no-network' }];
  assert.deepEqual(summarize({ reds }, []), repartition(reds));
  // flaky-parallel 是**复核产物**，不是门可以自己声明的环境症状 ⇒ 它必须**不在** ENV_KINDS 里。
  //   放进去就等于给门开了一个"我宣布我是并行抖动"的后门（U-153 那张表正是这个用途的白名单）。
  assert.equal(RECHECK_KIND, 'flaky-parallel');
  assert.ok(!ENV_KINDS.includes(RECHECK_KIND), 'RE<->ENV_KINDS 必须分开：门不得自封 flaky');
});

test('U-245-B: mergeRecheck 真值表 —— 串行过=flaky（不洗白成绿）/ 又红=product / 没跑成=product / 冒新红也要带上', () => {
  const flaky = { name: 'X 并行红', file: 'tests/x.test.mjs', cls: 'product', why: 'signature' };
  const real = { name: 'Y 并行红', file: 'tests/y.test.mjs', cls: 'product', why: 'assertion' };
  const first = run([flaky, real]);
  // ① x 串行过；y 串行又红 ⇒ x 转 flaky、y 保持 product
  const m1 = mergeRecheck(first, run([{ name: 'Y 并行红', file: 'tests/y.test.mjs', cls: 'product', why: 'assertion' }], 1, 'serial'));
  assert.equal(m1.summary.productRed, 1);
  assert.equal(m1.summary.envRed, 1);
  assert.deepEqual(m1.moved, ['X 并行红']);
  assert.deepEqual(m1.kept, ['Y 并行红']);
  assert.equal(m1.summary.runMode, 'parallel+serial-recheck', 'run_mode 必须带上"复核过"这一事实');
  assert.equal(m1.rc, 1, '还有 product 红 ⇒ 1');
  // ② 全部串行过 ⇒ product 0，但 rc=3（env 红不是绿）
  const m2 = mergeRecheck(first, run([], 0, 'serial'));
  assert.equal(m2.summary.productRed, 0);
  assert.equal(m2.summary.envRed, 2);
  assert.equal(m2.summary.envByKind[RECHECK_KIND], 2);
  assert.equal(m2.rc, 3, '复核通过也只是 env 红 —— 不许冒充 rc=0');
  // ③ 复核**没跑成**（reporter 无输出）⇒ 一条都不许挪（fail-closed）
  const m3 = mergeRecheck(first, run([{ name: 'partition report missing', file: null, cls: 'product', why: 'reporter produced no output' }], 1, 'serial'));
  assert.equal(m3.summary.productRed, 2, '复核不可用时保持原 product 红（且不虚增"复核失败"这条）');
  assert.deepEqual(m3.moved, []);
  assert.ok(m3.summary.recheckError, '复核本身失败必须显式记账，不能静默');
  assert.equal(m3.rc, 1);
  // ④ 复核里冒出来的**新**红（并行时没有）也要进 product —— 否则"并行不红、串行红"会静默丢失
  const m4 = mergeRecheck(first, run([
    { name: 'Y 并行红', file: 'tests/y.test.mjs', cls: 'product', why: 'assertion' },
    { name: 'Z 只有串行红', file: 'tests/z.test.mjs', cls: 'product', why: 'assertion' },
  ], 1, 'serial'));
  assert.equal(m4.summary.productRed, 2, 'x 转 flaky，y（复现）+z（复核新红）留 product');
  assert.ok(m4.kept.includes('Z 只有串行红'), '复核新红必须被保留');
  assert.ok(m4.moved.includes('X 并行红'), 'x 串行过 ⇒ 转 flaky');
  assert.equal(m4.summary.envRed, 1);
});

test('U-245-C: 接线 —— CLI 走 runGatesVerified；复核强制串行且只带失败文件；run_mode 必须落进 summary', () => {
  const bad = [];
  if (!/summary\.runMode = runMode/.test(SRC)) bad.push('runGates 未把 run_mode 写进 summary');
  if (!/runGatesVerified\(\{ files \}\)/.test(SRC)) bad.push('CLI 入口未走 runGatesVerified（并行红不会被复核）');
  if (!/printPartition\(summary\)/.test(SRC)) bad.push('printPartition(summary) 调用点丢了（U-153 的锚点）');
  const fn = fnBody(SRC, 'runGatesVerified');
  if (!/summary\.runMode !== 'parallel'/.test(fn)) bad.push('串行跑也会触发复核（白跑一遍）');
  // U-272（2026-10-26）：复核有**两条**路径 —— product 红复核 + env-only 轮次复核。
  //   两处都必须串行，所以这里按出现次数断言（原来只判"存在一次"，多加一条路径就漏）。
  const serialSites = (fn.match(/mode: 'serial'/g) || []).length;
  if (serialSites < 2) bad.push('复核没有强制串行或漏了一条复核路径（应两处 mode: \'serial\'，实得 ' + serialSites + '）');
  if (!/\.filter\(Boolean\)/.test(fn)) bad.push('复核没有限定"失败的文件"（全量重跑等于没复核）');
  assert.deepEqual(bad, [], bad.join('; '));
});

test('U-245-C 负例：去掉复核串行 / 退回旧入口 / 不记 run_mode —— 都必须被点名', () => {
  const badOf = s => {
    const out = [];
    if (!/summary\.runMode = runMode/.test(s)) out.push('run_mode');
    if (!/runGatesVerified\(\{ files \}\)/.test(s)) out.push('entry');
    const i = s.indexOf('export async function runGatesVerified(');
    const fn = s.slice(i, s.indexOf('\n}', i));
    if (!/mode: 'serial'/.test(fn)) out.push('serial');
    return out;
  };
  assert.deepEqual(badOf(SRC), [], '原文件必须通过（否则负例测的是别的）');
  const noSerial = SRC.replaceAll("mode: 'serial'", "mode: 'parallel'");   // 两条复核路径都要变异（U-272）
  assert.notEqual(noSerial, SRC, '变异①未生效');
  assert.ok(badOf(noSerial).includes('serial'), '复核改回并行未被判红');
  const oldEntry = SRC.replace('runGatesVerified({ files })', 'runGates({ files })');
  assert.notEqual(oldEntry, SRC, '变异②未生效');
  assert.ok(badOf(oldEntry).includes('entry'), '退回旧入口未被判红');
  const noMode = SRC.replace('summary.runMode = runMode;', '');
  assert.notEqual(noMode, SRC, '变异③未生效');
  assert.ok(badOf(noMode).includes('run_mode'), '不记 run_mode 未被判红');
});
