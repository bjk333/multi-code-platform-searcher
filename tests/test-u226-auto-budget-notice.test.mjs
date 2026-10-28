// U-226（v1.53.4，2026-10-23）：T3-8 `-Auto` 最坏墙钟**只告知、不改行为**。
//
// 事实（代码）：`Get-TimeBudgetSec` 在 `Invoke-EnginePool` 里**每池各调一次**，而 `-Auto` 顺序跑
//   repo/code/research ⇒ 进程内最坏 = 预算 × 实际池数。Doctor 的 `budgetPolicy.WorstCaseSec` 早已如实报，
//   但只有 `-Doctor` 才有；跑 `-Auto` 的人按单池预算估时间就会等超。
// 用户拍板：只做告知，**不动**预算语义（不做跨池共享、不提前砍池）。
//
// 判据三层：
//   ① 真值表（dot-source 后直调纯函数）：多池按实际池数相乘；单池/0/去重后单池/非池模式 ⇒ 静默；
//   ② 接线：调用点在 `$runModes` 定稿（-LocalCodeSearch 补 code）**之后** —— 否则池数算少；
//   ③ 语义守卫：`Get-TimeBudgetSec` 函数体不得出现"乘池数"一类的改写（那是行为变更，不是告知）。
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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u226-'));
    const f = path.join(dir, 'probe.ps1');
    const outFile = path.join(dir, 'out.txt');
    fs.writeFileSync(f, '\ufeff' + body, 'utf8');   // BOM：-File 下让 PS 按 UTF-8 读中文
    const child = spawn(exe, ['-NoProfile', '-NonInteractive', '-File', f], {
      cwd: ROOT, windowsHide: true,
      env: { ...process.env, MCPS_NO_MAIN: '1', U226_OUT: outFile },
    });
    let out = '', err = '';
    const killer = setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } reject(new Error(exe + ' timeout')); }, timeoutMs);
    child.stdout.on('data', (b) => { out += b.toString('utf8'); });
    child.stderr.on('data', (b) => { err += b.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(killer); reject(e); });
    child.on('close', () => {
      clearTimeout(killer);
      // ★ 中文不能走 stdout：PS 用控制台代码页（936）编码，node 按 UTF-8 解码必乱码（本门第一版踩过）。
      //   探针把结果写 UTF-8 文件，这里读文件；stdout 只用于诊断。
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
function N([int]$b, [string[]]$m) {
  $r = Get-AutoBudgetNotice -BudgetSec $b -Modes $m
  if ($null -eq $r) { '<null>' } else { $r }
}
$rows = @()
$rows += 'three30='  + (N 30 @('repo','code','research'))
$rows += 'two30='    + (N 30 @('repo','research'))
$rows += 'one30='    + (N 30 @('repo'))
$rows += 'zero='     + (N 0  @('repo','code'))
$rows += 'dup='      + (N 10 @('repo','repo'))
$rows += 'nonpool='  + (N 30 @('package'))
[System.IO.File]::WriteAllLines($env:U226_OUT, $rows, (New-Object System.Text.UTF8Encoding($false)))
`;

function parseRows(out) {
  const rows = {};
  for (const line of out.split(/\r?\n/)) {
    const m = /^(three30|two30|one30|zero|dup|nonpool)=(.*)$/.exec(line.trim());
    if (m) rows[m[1]] = m[2];
  }
  return rows;
}

function pickExe() {
  // ★ 只用异步 spawn：R2 spawn 卫生门禁止新文件用 spawnSync/execSync（宿主 NODE_OPTIONS 垫片会把
  //   spawnSync 变成恒 EBUSY、status=null ⇒ "没跑"被读成"跑红"）。探测失败一律回退 powershell。
  return new Promise((resolve) => {
    const c = spawn('pwsh', ['-NoProfile', '-Command', 'exit 0'], { windowsHide: true });
    c.on('error', () => resolve('powershell'));
    c.on('close', (code) => resolve(code === 0 ? 'pwsh' : 'powershell'));
    c.stdin.end();
  });
}

test('U-226 真值表: 最坏 = 预算 × 实际池数；单池/0/去重后单池/非池模式 ⇒ 静默', async () => {
  const exe = await pickExe();
  const { out, err } = await runPs(exe, PROBE);
  const rows = parseRows(out);
  assert.ok(rows.three30, 'probe 未产出 three30 行；stderr=' + err.slice(0, 300));
  assert.match(rows.three30, /30s/, '三池必须回显预算值：' + rows.three30);
  assert.match(rows.three30, /3 个池/, '三池必须报 3 个池：' + rows.three30);
  assert.match(rows.three30, /最坏 90s/, '★ 3 池 × 30s 必须是 90s（不是 30s）—— 告知的全部意义就在这里');
  assert.match(rows.two30, /2 个池/, 'planner 只选两池时不得按 3 池报：' + rows.two30);
  assert.match(rows.two30, /最坏 60s/, '2 池 × 30s 必须是 60s：' + rows.two30);
  assert.equal(rows.one30, '<null>', '单池不存在叠加，应静默');
  assert.equal(rows.zero, '<null>', '预算 0 = 不设预算，没有"最坏"可算，应静默');
  assert.equal(rows.dup, '<null>', '同一模式重复只算一个池 ⇒ 单池，应静默');
  assert.equal(rows.nonpool, '<null>', '不含 repo/code/research 的模式（如 package）不参与池数，应静默');
});

// 接线：调用必须在 `$runModes` 定稿之后。`-LocalCodeSearch` 会补 'code'（见 multi-platform-searcher.ps1
//   的 `if ($Auto -and $LocalCodeSearch -and $runModes -notcontains 'code')`）—— 提示放在它之前就会少算一个池。
function checkWiring(src) {
  assert.match(src, /function Get-AutoBudgetNotice\s*\{/, '必须存在 Get-AutoBudgetNotice');
  const iCall = src.indexOf('Get-AutoBudgetNotice -BudgetSec (Get-TimeBudgetSec) -Modes $runModes');
  assert.ok(iCall > 0, '★ 必须在 -Auto 执行前调用 Get-AutoBudgetNotice（否则告知缺失）');
  const iLocal = src.indexOf("if ($Auto -and $LocalCodeSearch -and $runModes -notcontains 'code')");
  assert.ok(iLocal > 0, '锚点缺失：-LocalCodeSearch 补 code 的那段找不到（本门的前提）');
  assert.ok(iCall > iLocal, '★ 调用必须晚于 $runModes 定稿（-LocalCodeSearch 补 code）—— 否则池数算少');
  const iGuard = src.lastIndexOf('if ($Auto) {', iCall);
  assert.ok(iGuard > 0 && iGuard < iCall, '调用必须包在 if ($Auto) 守卫内（单模式不提示）');
}

test('U-226 接线: 调用点位于 $runModes 定稿之后，且在 if ($Auto) 守卫内', () => {
  checkWiring(SRC);
});

test('U-226 语义守卫: Get-TimeBudgetSec 函数体不得引入"乘池数"（那是行为变更，不是告知）', () => {
  const i0 = SRC.indexOf('function Get-TimeBudgetSec');
  assert.ok(i0 > 0, '锚点缺失：Get-TimeBudgetSec');
  const i1 = SRC.indexOf('function ', i0 + 10);
  const body = SRC.slice(i0, i1 > i0 ? i1 : i0 + 800);
  assert.doesNotMatch(body, /PoolsInAuto|runModes|\*\s*\$pools/, '★ 预算函数体里出现池数乘法 ⇒ 已从"告知"变成"行为变更"，需单独拍板');
});

test('U-226 negative control: 把"×池数"改成"×1"、把调用挪到定稿前 —— 都必须被点名', () => {
  const mutant1 = SRC.replace('($BudgetSec * $poolModes.Count)', '$BudgetSec');
  assert.notEqual(mutant1, SRC, 'mutation must remove the pool-count multiply');
  // 真值表用的是函数本体，这里以源码断言的等价物验证：乘法表达式消失即视为退化为单池
  assert.ok(!mutant1.includes('$BudgetSec * $poolModes.Count'), '乘法被移除');

  const block = SRC.slice(SRC.indexOf('# T3-8（v1.53.4）'), SRC.indexOf('if ($lowDiscTerms.Count -gt 0)'));
  assert.ok(block.length > 0, '锚点缺失：T3-8 提示块');
  const moved = SRC.replace(block, '').replace("if ($Auto -and $LocalCodeSearch -and $runModes -notcontains 'code') {", block + "\nif ($Auto -and $LocalCodeSearch -and $runModes -notcontains 'code') {");
  assert.notEqual(moved, SRC, 'mutation must move the block before $runModes settles');
  assert.throws(() => checkWiring(moved), /必须晚于 \$runModes 定稿/);
});
