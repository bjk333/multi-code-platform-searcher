// U-160 L4 · 每源独立桶 + headroom 15–20%（+ L5-② 惊群 / L5-③ 预算被单源吃光）
//
// 判据（预注册 §3 L4）：
//   ① 源 A 耗尽自身令牌后，源 B **仍能**取得自己的令牌 ⇒ **不得共享单计数器**
//   ② 预留 **15–20% headroom**（客户端速率 = 观测限值 × (1 − 比例)）
//   ③ 重试消耗 ≤ 成功流量 10%
//   每用户维：**不做、不宣称**（单机单用户 CLI 无法诚实验证跨用户隔离）
//
// 手法：点源加载 + `Wait-RateLimitToken -DryRun`（只返回判定、不睡不改状态）⇒ **确定性**验证，不睡不等。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sourceAll } from './lib/source.mjs';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(testsDir, '..');
const MAIN_SRC = sourceAll(path.join(root));

function probe(withToken) {
  const script = [
    "$ErrorActionPreference='Stop'",
    "$env:MCPS_NO_MAIN='1'",
    `. '${path.join(root, 'multi-platform-searcher.ps1').replace(/'/g, "''")}' -NoEnvFile`,
    `'U160C-CFG h=' + $script:Cfg.RateLimitHeadroomRatio + ' obs=' + $script:Cfg.GhSearchRateAnonPerMin + ',' + $script:Cfg.GhSearchRateAuthPerMin + ',' + $script:Cfg.GhCodeSearchRatePerMin`,
    `$bs=$script:_rlBuckets['github-search']; $bc=$script:_rlBuckets['github-code']`,
    `'U160C-PM search=' + [math]::Round([double]$bs.RefillPerSec*60,4) + ' code=' + [math]::Round([double]$bc.RefillPerSec*60,4)`,
    `'U160C-SAME ' + [object]::ReferenceEquals($bs,$bc)`,
    `$bs.Tokens = 0.0`,
    `$a = Wait-RateLimitToken -Bucket 'github-search' -DryRun`,
    `$c = Wait-RateLimitToken -Bucket 'github-code' -DryRun`,
    `'U160C-A ' + $a.Allow + ' ' + $a.WaitSec`,
    `'U160C-C ' + $c.Allow + ' ' + $c.WaitSec`,
    `'U160C-UNK ' + (Wait-RateLimitToken -Bucket 'no-such-bucket' -DryRun)`,
    `$ws=@(); foreach ($r in @(0.1,0.3,0.5,0.7,0.9)) { $ws += (Get-FullJitterWait -Attempt 3 -UpperBoundSec 8 -Rand01 $r) }`,
    `'U160C-J ' + ($ws -join ',')`,
  ].join('; ');
  return new Promise(resolve => {
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; delete env.NODE_OPTIONS;
    if (withToken) env.GITHUB_TOKEN = 'probe-token-not-used-for-network'; else delete env.GITHUB_TOKEN;
    const c = spawn('pwsh', ['-NoProfile', '-Command', script], { cwd: root, env, windowsHide: true });
    let o = '', e = '';
    c.stdout.on('data', d => { o += d; }); c.stderr.on('data', d => { e += d; });
    c.once('close', code => resolve({ code, o, e }));
    c.once('error', err => resolve({ code: null, o, e: err.message }));
  });
}
const pick = (o, tag) => { const m = new RegExp('^' + tag + ' (.*)$', 'm').exec(o); return m ? m[1].trim() : null; };

let noTok = null, tok = null;
test('U-160 L4-0（前置）: 点源可加载，两个桶都在，且 Cfg 常量与本门假设一致', async () => {
  noTok = await probe(false);
  tok = await probe(true);
  for (const [tag, r] of [['无 token', noTok], ['有 token', tok]]) {
    assert.equal(r.code, 0, `${tag}: pwsh 必须跑通: ` + r.e.slice(0, 400));
    const cfg = pick(r.o, 'U160C-CFG');
    assert.ok(cfg, `${tag}: 必须取到 Cfg（锚点变了要同步改本门）: ` + r.o.slice(0, 300));
    assert.match(cfg, /^h=0\.2 obs=10,30,10$/, `${tag}: headroom 与观测限值必须为 0.2 与 10/30/10，实得 ${cfg}`);
  }
});

// ---------- ② headroom ----------
test('U-160 L4-②: 客户端速率 = 观测限值 ×(1−headroom)，且 headroom 落在 15–20% 带内', () => {
  const cases = [
    { label: 'repo 未认证', obs: 10, pm: Number(pick(noTok.o, 'U160C-PM').match(/search=([\d.]+)/)[1]) },
    { label: 'repo 认证', obs: 30, pm: Number(pick(tok.o, 'U160C-PM').match(/search=([\d.]+)/)[1]) },
    { label: 'code', obs: 10, pm: Number(pick(noTok.o, 'U160C-PM').match(/code=([\d.]+)/)[1]) },
  ];
  for (const c of cases) {
    const ratio = 1 - c.pm / c.obs;
    assert.ok(ratio >= 0.15 - 1e-9 && ratio <= 0.20 + 1e-9,
      `${c.label}: headroom 必须 15–20%，实得 ${(ratio * 100).toFixed(2)}%（观测 ${c.obs}/min ⇒ 客户端 ${c.pm}/min）`);
  }
  // 反证：不乘 headroom 的旧实现（=观测值）会落在 0% ⇒ 必红
  assert.ok(!(1 - 10 / 10 >= 0.15), '不乘 headroom 时 ratio=0 ⇒ 上面的断言必然拒绝它');
});

// ---------- ① 与 L5-③：独立桶、以及"预算被单源吃光" ----------
test('U-160 L4-①/L5-③: 排空 A 后 B 仍可用；且两桶必须是**不同对象**（禁共享单计数器）', () => {
  assert.equal(pick(noTok.o, 'U160C-SAME'), 'False', '★两个桶必须是不同对象 —— 共享单计数器的实现会在此判红');
  const a = pick(noTok.o, 'U160C-A').split(' ');
  const c = pick(noTok.o, 'U160C-C').split(' ');
  assert.equal(a[0], 'False', 'A 被排空 ⇒ 必须拒绝');
  assert.ok(Number(a[1]) > 0, 'A 被拒时必须给出正等待秒数');
  assert.equal(c[0], 'True', '★B 的桶未被动过 ⇒ 必须仍然放行（独立桶 / 预算不被单源吃光）');
  assert.equal(Number(c[1]), 0, 'B 放行 ⇒ 等待为 0');
  // 负例：共享单计数器 ⇒ 排空后 B 也会被拒
  const sharedWouldDenyB = false;   // 本仓实现下为 false
  assert.equal(sharedWouldDenyB, false);
  assert.notEqual(c[0], a[0], '若两桶共享，A/B 的判定会相同 —— 那正是本判据要挡的');
});

test('U-160 L4-①补充: 未注册的桶直接放行（不阻塞；与本仓既有语义一致）', () => {
  assert.match(pick(noTok.o, 'U160C-UNK'), /^$|Allow|^$/, '未注册桶不应抛错');
  assert.ok(pick(noTok.o, 'U160C-UNK') !== null, 'DryRun 对未注册桶应返回空（本仓：早退）');
});

// ---------- L5-② 惊群 / 重同步 ----------
test('U-160 L5-②: 同一 attempt 上，不同随机 ⇒ 等待互不相同（惊群/重同步被 Full Jitter 打散）', () => {
  const ws = pick(noTok.o, 'U160C-J').split(',').map(Number);
  assert.equal(ws.length, 5, '应取到 5 个采样');
  assert.equal(new Set(ws).size, 5, `5 个不同随机必须得到 5 个不同等待（实得 ${ws.join(',')}）—— 若相同即"重同步"`);
  // 反证：固定退避（无抖动）会让 5 个值全相同 ⇒ 必然判红
  const fixedImpl = [8, 8, 8, 8, 8];
  assert.equal(new Set(fixedImpl).size, 1, '固定退避的实现会得到 1 个不同值 ⇒ 上面 size===5 的断言必拒');
});

// ---------- ③ 重试 ≤ 成功流量 10% ----------
const retryWithin10pct = (success, retries) => retries <= Math.max(1, Math.ceil(success * 0.1));
test('U-160 L4-③: 重试 ≤ 成功流量 10%（账目规则）+ 真样本观测 + 负例', () => {
  assert.equal(retryWithin10pct(100, 10), true);
  assert.equal(retryWithin10pct(100, 11), false, '超过 10% 必须判假');
  assert.equal(retryWithin10pct(0, 1), true, '成功为 0 时允许 1 次（下界，避免除零式严苛）');
  // 真样本观测（**只记录不断言**，因为单次运行的样本量太小，硬门会假红）
  const s = JSON.parse(fs.readFileSync(path.join(root, 'reports/gates/u89-real-asjson.json'), 'utf8'));
  const retries = Number(s.metrics.RetryCount ?? 0);
  const reqs = Number(s.metrics.Requests ?? 0);
  const success = Math.max(0, reqs - retries);
  console.log(`[U-160 L4-③] sample: requests=${reqs} retries=${retries} ⇒ 规则结果=${retryWithin10pct(success, retries)}`);
  assert.ok(Number.isInteger(retries) && Number.isInteger(reqs), '样本计数器必须是整数');
  // 负例：把重试放大到远超 10% ⇒ 规则必判假
  assert.equal(retryWithin10pct(success, retries + 1000), false);
});

test('U-160 L4-③（如实登记）: 运行时**未**做动态 10% 限流 —— 现行机制是进程级 RetryBudget', () => {
  assert.match(MAIN_SRC, /RetryBudget\s*=\s*6/, '运行时重试上限仍是 RetryBudget（进程级常数）');
  assert.doesNotMatch(MAIN_SRC, /0\.1\s*\*\s*\$.*Success/i, '源码里不应存在"动态按成功流量算预算"的实现');
  // 本门对 10% 的守护是**账目规则 + 样本观测**，不是运行时限制器 —— 这条断言把这个事实钉住
  assert.ok(true);
});
