// U-223 · code 通路单请求预算 = f(引擎生效截止)（Tier1-4「GrepApp 超时可配」）
//
// 病灶（2026-10-22 实测 + 全模块验收 代理 B）：GrepApp 的单请求超时写死 `CodeRequestTimeoutSec=6`，
//   `MCPS_ENGINE_DEADLINE="GrepApp=25"` 只改**引擎级**截止（池侧 Stop 时机），单请求仍在 6s 超时 ⇒
//   「调了截止救不了慢源」——调高截止对 GrepApp 的 6s HttpClient.Timeout **完全无效**（调了没用）。
//   代理 B 实测：grep.app 源活着，只是 6s 超时过紧。
//
// 契约（v1.53.0）：Get-CodeRequestBudget 按引擎名给出**单请求超时/尝试数**：
//   · 默认（无覆盖）逐位不变：CodeRequestTimeoutSec × CodeRequestMaxAttempts（6×2）；
//   · MCPS_ENGINE_DEADLINE="GrepApp=D" ⇒ TimeoutSec = max(默认, D - 退避 - 1)、MaxAttempts = 1
//     （源慢但活着 ⇒ 一次更长的请求优于两次短超时；不变式 TimeoutSec×MaxAttempts+退避 ≤ D 恒成立）；
//   · 覆盖值不得突破 CodeRequestTimeoutSec × 4（防误设 9999 把单源变成无限等待）。
// 判据：真值表（dot-source 直测）+ 接线（grep-app.ps1 必须用它）+ 变异控制。
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
const GREP = fs.readFileSync(path.join(ROOT, 'engines', 'grep-app.ps1'), 'utf8');

function runPs(body, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u223-'));
    const f = path.join(dir, 'budget.ps1');
    fs.writeFileSync(f, '﻿' + body, 'utf8');
    const child = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-File', f], {
      cwd: ROOT, windowsHide: true,
      env: { ...process.env, MCPS_NO_MAIN: '1' },
    });
    let out = '', err = '';
    const killer = setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } reject(new Error('pwsh timeout')); }, timeoutMs);
    child.stdout.on('data', (b) => { out += b.toString('utf8'); });
    child.stderr.on('data', (b) => { err += b.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(killer); reject(e); });
    child.on('close', () => {
      clearTimeout(killer);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 系统清 */ }
      resolve({ out: out.trim(), err: err.trim() });
    });
    child.stdin.end();
  });
}

const BUDGET_PROBE = `
$ErrorActionPreference = 'Continue'
$env:MCPS_NO_MAIN = '1'
. ./multi-platform-searcher.ps1 -NoEnvFile -Keyword x -Limit 1
function Row([string]$n, [string]$ov) {
  if ($ov) { $env:MCPS_ENGINE_DEADLINE = $ov } else { Remove-Item Env:MCPS_ENGINE_DEADLINE -ErrorAction SilentlyContinue }
  $b = Get-CodeRequestBudget -EngineName 'GrepApp'
  "{0}|{1}|{2}" -f $n, $b.TimeoutSec, $b.MaxAttempts
}
Row 'default' ''
Row 'd15' 'GrepApp=15'
Row 'd25' 'GrepApp=25'
Row 'd5'  'GrepApp=5'
Row 'dBig' 'GrepApp=9999'
Row 'other' 'HF=30'
Remove-Item Env:MCPS_ENGINE_DEADLINE -ErrorAction SilentlyContinue
`;

function parseBudget(out) {
  const rows = {};
  for (const line of out.split(/\r?\n/)) {
    const m = /^(\w+)\|(\d+)\|(\d+)$/.exec(line.trim());
    if (m) rows[m[1]] = { t: Number(m[2]), a: Number(m[3]) };
  }
  return rows;
}

function checkWiring(src, grep) {
  assert.ok(/function Get-CodeRequestBudget \{/.test(src), '必须有 Get-CodeRequestBudget（单请求预算单源）');
  assert.match(grep, /\$budget = Get-CodeRequestBudget -EngineName 'GrepApp'/,
    '★GrepApp 必须用 Get-CodeRequestBudget 取预算（写死 CodeRequestTimeoutSec ⇒ MCPS_ENGINE_DEADLINE 调了没用）');
  assert.match(grep, /-TimeoutSec \$budget\.TimeoutSec -MaxAttempts \$budget\.MaxAttempts/,
    'R4-F1-2：显式传超时与尝试次数（从预算对象取也算显式）');
  // 不变式在实现里可断言：预算 = TimeoutSec × MaxAttempts + 退避 ≤ 生效截止
  assert.match(src, /function Get-CodeRequestBudget[\s\S]{0,900}?RetryBaseSec/,
    '预算函数必须把 RetryBaseSec 计入不变式（否则 6×2+2 会超出调低后的截止）');
}

test('U-223-1 真值表：默认逐位不变 / 覆盖抬超时 / 覆盖不突破 4× 上限 / 无关引擎不受影响', async () => {
  const r = await runPs(BUDGET_PROBE);
  const rows = parseBudget(r.out);
  assert.deepEqual(Object.keys(rows).sort(), ['d15', 'd25', 'd5', 'dBig', 'default', 'other'],
    '输出行不齐: ' + r.out);

  assert.deepEqual(rows.default, { t: 6, a: 2 }, '默认必须逐位不变（CodeRequestTimeoutSec×CodeRequestMaxAttempts）');
  assert.equal(rows.d15.a, 1, '覆盖后单次长请求（慢源重试只会叠等）');
  assert.ok(rows.d15.t >= 13, 'D=15 ⇒ 单请求超时应 ≥ 13（15-退避-1），实得 ' + rows.d15.t);
  assert.ok(rows.d15.t * rows.d15.a + 2 <= 15, '不变式：15s 截止内必须装得下预算');
  assert.ok(rows.d25.t >= 23 && rows.d25.t * rows.d25.a + 2 <= 25, 'D=25 ⇒ 预算随截止放大且不超');
  assert.ok(rows.d5.t * rows.d5.a + 2 <= 5, '调低截止 ⇒ 预算必须同步收窄（不变式恒成立），实得 ' + rows.d5.t + '×' + rows.d5.a);
  assert.ok(rows.d5.t >= 1, '收窄下限 1s');
  assert.equal(rows.d5.a, 1, '覆盖后一律单次长请求');
  assert.ok(rows.dBig.t <= 24, '9999 必须被 4× 上限钳住（防单源无限等待），实得 ' + rows.dBig.t);
  assert.deepEqual(rows.other, { t: 6, a: 2 }, '覆盖别的引擎不影响 GrepApp');
});

test('U-223-2 静态接线：GrepApp 走预算函数、显式传参、退避入不变式', () => {
  checkWiring(SRC, GREP);
});

test('U-223-3 负例（变异控制）：GrepApp 回退写死超时 / 预算函数消失 —— 必须被点名', () => {
  const hardcoded = GREP.replace('$budget = Get-CodeRequestBudget -EngineName \'GrepApp\'\n', '')
    .replace('-TimeoutSec $budget.TimeoutSec -MaxAttempts $budget.MaxAttempts',
      '-TimeoutSec $script:Cfg.CodeRequestTimeoutSec -MaxAttempts $script:Cfg.CodeRequestMaxAttempts');
  assert.notEqual(hardcoded, GREP, '变异必须真的改到 GrepApp 调用点');
  assert.throws(() => checkWiring(SRC, hardcoded), /必须用 Get-CodeRequestBudget/);

  const noFn = SRC.replace('function Get-CodeRequestBudget {', 'function Get-CodeRequestBudget-REMOVED {');
  assert.notEqual(noFn, SRC, '变异必须真的改到函数名');
  assert.throws(() => checkWiring(noFn, GREP), /必须有 Get-CodeRequestBudget/);
});
