// U-160 L3 · Full Jitter（AWS）：`sleep = random(0, min(cap, base·2ⁿ))`，`Retry-After` 是**下限**
//
// ★为什么这样测：随机源**以参数注入**（`-Rand01`），所以"真的是抖动"可以被**确定性**验证
//   （给定 rand 与上限 ⇒ 等待值必须精确等于 round(rand×U)），**不靠"多跑几次看看不一样"**这种概率门禁。
//   负例两条：① 忽略 rand（固定 Uₙ）② 抽了却丢弃（仍睡 Uₙ）—— 都在 rand=0 与 rand=1 上暴露。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sourceAll } from './lib/source.mjs';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(testsDir, '..');
const MAIN = sourceAll(path.join(root));

// ---------- 用 MCPS_NO_MAIN=1 点源加载函数（本仓既有范式，U-143 同款），只调纯函数 ----------
const BASE = 2, CAP = 30;                       // 与 Cfg.RetryBaseSec / MaxRetryWaitSec 对齐（下面另有源码断言）
function probe(attempts, rands) {
  const script = [
    "$ErrorActionPreference='Stop'",
    "$env:MCPS_NO_MAIN='1'",
    `. '${path.join(root, 'multi-platform-searcher.ps1').replace(/'/g, "''")}' -NoEnvFile`,
    `'U160B-BASE=' + $script:Cfg.RetryBaseSec + ',' + $script:Cfg.MaxRetryWaitSec`,
    `foreach ($n in @(${attempts.join(',')})) { foreach ($r in @(${rands.join(',')})) { $u=[math]::Min([double]$script:Cfg.MaxRetryWaitSec,[math]::Pow([double]$script:Cfg.RetryBaseSec,$n)); $w=Get-FullJitterWait -Attempt $n -UpperBoundSec $u -Rand01 $r; 'U160B n='+$n+' r='+$r+' u='+$u+' w='+$w } }`,
    `foreach ($r in @(0,0.25,1)) { $w=Get-FullJitterWait -Attempt 1 -UpperBoundSec 2 -Rand01 $r -RetryAfterSec 5; 'U160B-RA r='+$r+' w='+$w }`,
    `$bo=Get-RetryBackoff -Attempt 1 -MaxAttempts 3 -Rand01 0.5; 'U160B-BO wait='+$bo.WaitSec+' upper='+$bo.UpperBoundSec+' rand='+$bo.Rand01+' hasnext='+$bo.HasNext`,
    `$bo2=Get-RetryBackoff -Attempt 3 -MaxAttempts 3 -Rand01 0; 'U160B-BO2 wait='+$bo2.WaitSec+' upper='+$bo2.UpperBoundSec+' hasnext='+$bo2.HasNext`,
  ].join('; ');
  return new Promise(resolve => {
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; delete env.NODE_OPTIONS;
    const c = spawn('pwsh', ['-NoProfile', '-Command', script], { cwd: root, env, windowsHide: true });
    let o = '', e = '';
    c.stdout.on('data', d => { o += d; }); c.stderr.on('data', d => { e += d; });
    c.once('close', code => resolve({ code, o, e }));
    c.once('error', err => resolve({ code: null, o, e: err.message }));
  });
}

let lines = null;
test('U-160 L3-0（前置）: 点源可加载函数，且 Cfg 的 base/cap 与本门假设一致', async () => {
  const r = await probe([1, 3, 10], [0, 0.25, 0.5, 1]);
  assert.equal(r.code, 0, 'pwsh 必须跑通: ' + r.e.slice(0, 400));
  lines = r.o.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const base = lines.find(l => l.startsWith('U160B-BASE='));
  assert.ok(base, '必须取到 Cfg 的 base/cap（锚点变了要同步改本门）: ' + r.o.slice(0, 300));
  const [b, cap] = base.replace('U160B-BASE=', '').split(',').map(Number);
  assert.equal(b, BASE, `RetryBaseSec 必须为 ${BASE}，实得 ${b}`);
  assert.equal(cap, CAP, `MaxRetryWaitSec 必须为 ${CAP}，实得 ${cap}`);
});

test('U-160 L3-1（主判据）: 等待 = round(rand × min(cap, base·2ⁿ))，且逐点精确', () => {
  const got = new Map();
  for (const l of lines) {
    const m = /^U160B n=(\d+) r=([\d.]+) u=([\d.]+) w=([\d.]+)$/.exec(l);
    if (m) got.set(`${m[1]}|${m[2]}`, { u: Number(m[3]), w: Number(m[4]) });
  }
  assert.equal(got.size, 3 * 4, `应拿到 12 个采样，实得 ${got.size}`);
  for (const [k, v] of got) {
    const [n, r] = k.split('|').map(Number);
    const uWant = Math.min(CAP, Math.pow(BASE, n));
    assert.equal(v.u, uWant, `n=${n} 上限必须是 min(cap, base^n)=${uWant}，实得 ${v.u}`);
    assert.equal(v.w, Math.round(r * uWant * 1000) / 1000, `n=${n} r=${r} 等待必须精确等于 round(r×U)`);
    assert.ok(v.w >= 0 && v.w <= uWant, `等待必须落在 [0, U]（实得 ${v.w}, U=${uWant}）`);
  }
  // 封顶生效：n=10 ⇒ U 必须被 cap 截住
  assert.equal(got.get('10|0.5').u, CAP, 'n=10 必须被 cap 封顶');
});

test('U-160 L3-2: Retry-After 是**下限** —— 等待 = max(本地抖动, S)', () => {
  const ra = new Map();
  for (const l of lines) { const m = /^U160B-RA r=([\d.]+) w=([\d.]+)$/.exec(l); if (m) ra.set(Number(m[1]), Number(m[2])); }
  assert.equal(ra.size, 3, '应拿到 3 个 Retry-After 采样');
  assert.equal(ra.get(0), 5, 'rand=0 ⇒ 本地 0 < S=5 ⇒ 必须取 5（S 是下限）');
  assert.equal(ra.get(0.25), 5, 'rand=0.25 ⇒ 本地 0.5 < 5 ⇒ 必须取 5');
  assert.equal(ra.get(1), 5, 'U=2 < 5 ⇒ 本地最多 2 ⇒ 必须取 5');
});

test('U-160 L3-3（真实调用接线）: Get-RetryBackoff 走纯函数，且暴露 upper/rand 便于审计', () => {
  const bo = /^U160B-BO wait=([\d.]+) upper=([\d.]+) rand=([\d.]+) hasnext=(\w+)$/.exec(lines.find(l => l.startsWith('U160B-BO ')) || '');
  assert.ok(bo, '必须取到 Get-RetryBackoff 的返回（锚点变了要同步改本门）');
  assert.equal(Number(bo[1]), 1, 'attempt=1,rand=0.5,U=2 ⇒ 等待 1');
  assert.equal(Number(bo[2]), 2, '必须暴露 UpperBoundSec=2');
  assert.equal(Number(bo[3]), 0.5, '必须回显注入的 Rand01（可审计）');
  // HasNext：最后一次尝试不退避
  const bo2 = /^U160B-BO2 wait=([\d.]+) upper=([\d.]+) hasnext=(\w+)$/.exec(lines.find(l => l.startsWith('U160B-BO2 ')) || '');
  assert.equal(bo2[3], 'False', 'attempt=3=maxAttempts ⇒ HasNext 必须 False（最后一次不退避）');
  assert.equal(Number(bo2[1]), 0, 'rand=0 ⇒ 等待 0（抖动下界可达 0）');
});

test('U-160 L3-负例: 「忽略 rand（固定 Uₙ）」与「抽了却丢弃」都必须被判红', () => {
  // 本仓实现：rand=0 与 rand=1 在下界/上界上**必须可区分**（U>0 时）
  const g = new Map();
  for (const l of lines) { const m = /^U160B n=1 r=([\d.]+) u=([\d.]+) w=([\d.]+)$/.exec(l); if (m) g.set(Number(m[1]), Number(m[3])); }
  assert.equal(g.get(0), 0, 'rand=0 ⇒ 等待 0');
  assert.equal(g.get(1), 2, 'rand=1 ⇒ 等待 U=2');
  assert.notEqual(g.get(0), g.get(1), '★若忽略 rand，两值会相同 —— 那正是"无抖动"该被抓的方式');
  // 反证：造一个"固定 U"的实现，它在 rand=0 上必然对不上
  const fixed = () => 2;
  assert.notEqual(fixed(), g.get(0), '"固定 U" 的实现与 rand=0 的期望不等 ⇒ 必红');
});

test('U-160 L5-① 只一层拥有重试权: $attempt++ 在源码里只出现一次（层层重试 3^5≈243× 的前提被排除）', () => {
  const hits = MAIN.split(/\r?\n/).filter(l => /\$attempt\+\+/.test(l));
  assert.equal(hits.length, 1, `$attempt++ 只允许一处（重试单层），实得 ${hits.length}: ${JSON.stringify(hits)}`);
  // 反例形状：若在循环里再调一个"自己也重试"的函数，计数会 >1 ⇒ 上面必红
  const fake = MAIN + '\n    $attempt++\n';
  assert.equal(fake.split(/\r?\n/).filter(l => /\$attempt\+\+/.test(l)).length, 2, '注入第二处 ⇒ 断言必红（证明本检查不是恒真）');
});
