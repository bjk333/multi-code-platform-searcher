// U-241 / U-242（v1.53.24，验收 B1-1 / B1-2）：整轮总预算 + 跨运行源健康记忆。
//
// 为什么要有这两条门：
//   · 验收 F16/C3：`Get-TimeBudgetSec` 是**每池**预算，`-Auto` 顺序跑 3 池 ⇒ 最坏 = 单池×池数
//     （产品默认 360s，本机 .env 720s），且只告知不限制。
//   · 验收 F5：失败源每轮都等满 deadline（GitLab 12.1s / HF 12.4s 占墙钟 95%+），
//     而 -Doctor 早已能判定这些域不可达 —— 缺的是**跨运行**记忆。
//
// 判据四层：
//   ① 真值表（dot-source 后直调纯函数）：总预算默认/覆盖/0/非法；池预算 min 语义；健康记忆 TTL/翻倍/清除/过期；
//   ② 接线：池内用 `Get-PoolBudgetSec`、预算分支必须带 `-not $h.Handle.IsCompleted`（否则丢已完成结果）、
//      健康记忆在池内探测、池尾记账、三模式块有预算跳过守卫；
//   ③ 负例：把 `-not $h.Handle.IsCompleted` 删掉 / 把 `Get-PoolBudgetSec` 换回 `Get-TimeBudgetSec` ⇒ 必须被判红；
//   ④ 不越界：`Get-TimeBudgetSec` 函数体不得出现乘池数（U-226 的语义守卫仍成立）。
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

function runPs(exe, body, timeoutMs = 180000, seedHealth = null) {
  return new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u241-'));
    const f = path.join(dir, 'probe.ps1');
    const outFile = path.join(dir, 'out.json');
    const healthFile = path.join(dir, 'source-health.json');
    fs.writeFileSync(f, '\ufeff' + body, 'utf8');
    if (seedHealth) fs.writeFileSync(healthFile, JSON.stringify(seedHealth), 'utf8');
    const env = { ...process.env, MCPS_NO_MAIN: '1', U241_OUT: outFile, U241_HEALTH: healthFile, MCPS_CACHE_FILE: path.join(dir, 'cache.json') };
    delete env.NODE_OPTIONS;
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(exe, ['-NoProfile', '-NonInteractive', '-File', f], { cwd: ROOT, windowsHide: true, env });
    let out = '', err = '';
    const killer = setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } reject(new Error(exe + ' timeout')); }, timeoutMs);
    child.stdout.on('data', (b) => { out += b.toString('utf8'); });
    child.stderr.on('data', (b) => { err += b.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(killer); reject(e); });
    child.on('close', () => {
      clearTimeout(killer);
      let fileOut = '';
      try { fileOut = fs.readFileSync(outFile, 'utf8'); } catch { /* 探针崩溃 */ }
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* 系统清 */ }
      resolve({ out: fileOut.trim(), stdout: out.trim(), err: err.trim() });
    });
    child.stdin.end();
  });
}

function pickExe() {
  // 只用异步 spawn（R2 spawn 卫生门）；探测失败回退 PS5 可执行名。
  return new Promise((resolve) => {
    const c = spawn('pwsh', ['-NoProfile', '-Command', 'exit 0'], { windowsHide: true });
    c.on('error', () => resolve('powershell'));
    c.on('close', (code) => resolve(code === 0 ? 'pwsh' : 'powershell'));
    c.stdin.end();
  });
}

const PROBE = `
$ErrorActionPreference = 'Continue'
$env:MCPS_NO_MAIN = '1'
$env:MCPS_HEALTH_FILE = $env:U241_HEALTH
. ./multi-platform-searcher.ps1 -NoEnvFile -Keyword x -Limit 1
$r = [ordered]@{}

# ---- 总预算 ----
$env:MCPS_TOTAL_BUDGET_SEC = $null
$r.cfgAutoDefault  = [int]$script:Cfg.TotalBudgetAutoDefaultSec
$r.totalDefault    = [int](Get-TotalBudgetSec)
$r.poolNoTotal     = [int](Get-PoolBudgetSec -PoolBudgetSec 120)
$env:MCPS_TOTAL_BUDGET_SEC = '10'
$r.total10         = [int](Get-TotalBudgetSec)
$r.poolMin         = [int](Get-PoolBudgetSec -PoolBudgetSec 120)
$env:MCPS_TOTAL_BUDGET_SEC = '0'
$r.totalOff        = [int](Get-TotalBudgetSec)
$r.poolOff         = [int](Get-PoolBudgetSec -PoolBudgetSec 120)
$env:MCPS_TOTAL_BUDGET_SEC = 'abc'
$r.totalBad        = [int](Get-TotalBudgetSec)
$env:MCPS_TOTAL_BUDGET_SEC = $null
$r.warnBad         = @(Get-EngineWarnings) -join ' | '
$r.deadlineNoRun   = [int](Get-EngineDeadlineSec -DeadlineSec 29 -EngineName 'GitHub')

# ---- 健康记忆 ----
Set-EngineHealthOutcome -EngineName 'DemoNet' -Status 'error' -Reason 'network-unavailable: demo host（不可达）'
$e1 = (Get-HealthStore)['DemoNet']
$r.h1reason = [string]$e1.Reason
$r.h1fails  = [int]$e1.Fails
$t1 = [datetime]::Parse([string]$e1.Until, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind)
$r.h1ttlOk  = ($t1 -gt [datetime]::UtcNow.AddMinutes(5))
Set-EngineHealthOutcome -EngineName 'DemoNet' -Status 'error' -Reason 'network-unavailable: demo host（不可达）'
$e2 = (Get-HealthStore)['DemoNet']
$t2 = [datetime]::Parse([string]$e2.Until, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind)
$r.h2fails  = [int]$e2.Fails
$r.h2longer = ($t2 -gt $t1)
$r.coldHit  = [bool](Test-EngineHealthCold -EngineName 'DemoNet')
Set-EngineHealthOutcome -EngineName 'DemoNet' -Status 'ok'
$r.cleared  = (-not (Get-HealthStore).ContainsKey('DemoNet'))
Set-EngineHealthOutcome -EngineName 'DemoCfg' -Status 'auth_missing' -Reason 'missing token'
$r.cfgNotRecorded = (-not (Get-HealthStore).ContainsKey('DemoCfg'))
Set-EngineHealthOutcome -EngineName 'DemoQuota' -Status 'error' -Reason '账户余额不足（402）'
$r.quotaReason = [string](Get-HealthStore)['DemoQuota'].Reason
(Get-HealthStore)['DemoOld'] = [PSCustomObject]@{ Until = (Get-Date).ToUniversalTime().AddSeconds(-30).ToString('o'); Reason = 'network'; Fails = 1 }
$r.expiredNull = ($null -eq (Test-EngineHealthCold -EngineName 'DemoOld'))
$env:MCPS_HEALTH = '0'
$r.offDisabled = ($null -eq (Test-EngineHealthCold -EngineName 'DemoNet'))
$env:MCPS_HEALTH = $null

[System.IO.File]::WriteAllText($env:U241_OUT, ($r | ConvertTo-Json -Depth 4), (New-Object System.Text.UTF8Encoding($false)))
`;

test('U-241/U-242 真值表：总预算默认/覆盖/0/非法，池预算 min 语义，健康记忆 TTL 与清除', async () => {
  const exe = await pickExe();
  const { out, err } = await runPs(exe, PROBE);
  assert.ok(out, 'probe 无输出；stderr=' + err.slice(0, 400));
  const j = JSON.parse(out);
  assert.equal(j.cfgAutoDefault, 45, 'Cfg.TotalBudgetAutoDefaultSec 应为 45');
  assert.equal(j.totalDefault, 0, '无 -Auto 且未设环境变量 => 总预算 0（不限），单模式行为逐位不变');
  assert.equal(j.poolNoTotal, 120, '★ 总预算关闭时池预算必须逐位等于单池默认（120 不能被改写）');
  assert.equal(j.total10, 10);
  assert.equal(j.poolMin, 10, '★ total=10 时池预算必须被夹到 10（min 语义）');
  assert.equal(j.totalOff, 0, 'MCPS_TOTAL_BUDGET_SEC=0 = 关闭');
  assert.equal(j.poolOff, 120, '关闭后池预算回到 120');
  assert.equal(j.totalBad, 0, '非法值在非 Auto 下回落 0');
  assert.match(j.warnBad, /MCPS_TOTAL_BUDGET_SEC 无法解析/, '非法值必须留一条可审计的 warning（不许静默当"不限"）');
  assert.equal(j.deadlineNoRun, 29, '未起表（Doctor/纯展示路径）时逐源截止不得被夹');

  assert.equal(j.h1reason, 'network', 'network-unavailable 应归为 network 类');
  assert.equal(j.h1fails, 1);
  assert.equal(j.h1ttlOk, true, '首次失败的冷却必须落在未来（默认 600s）');
  assert.equal(j.h2fails, 2, '连续失败应累加');
  assert.equal(j.h2longer, true, '★ 连续失败 TTL 必须翻倍（否则死源每 10 分钟就问一次）');
  assert.equal(j.coldHit, true, '冷却中的源必须被判为 cold');
  assert.equal(j.cleared, true, '成功一次即清除（源恢复后不再被 1s 截断）');
  assert.equal(j.cfgNotRecorded, true, '★ 缺凭据属配置问题，不得写入健康记忆（否则下次连真实错误都看不到）');
  assert.equal(j.quotaReason, 'quota', '402 应归为配额类（走 HealthTtlQuotaSec）');
  assert.equal(j.expiredNull, true, '过期的条目必须失效（否则源恢复后永远 1s）');
  assert.equal(j.offDisabled, true, 'MCPS_HEALTH=0 必须整体关闭');
});

// ★落盘往返（真实路径）：健康记忆是**跨进程**的，PS5.1 与 PS7 对同一份 JSON 的类型不同 ——
//   PS7 的 ConvertFrom-Json 会把 ISO-8601 串直接解成 [datetime]，若读取侧 `[string]` 化就会丢 Z、
//   变成当地文化串 ⇒ 冷源永远判"没过期"。本门就是为这条真实缺陷设的（2026-10-25 实测踩到）。
test('U-241/U-242 落盘往返：新进程读回同一份 health 文件仍判 cold（跨 PS5/PS7 类型差异）', async () => {
  const exe = await pickExe();
  const until = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const seed = { version: 1, updatedAt: new Date().toISOString(), entries: { GitLab: { until, reason: 'deadline', fails: 1 } } };
  const probe = `
$ErrorActionPreference = 'Stop'
$env:MCPS_NO_MAIN = '1'
$env:MCPS_HEALTH_FILE = $env:U241_HEALTH
. ./multi-platform-searcher.ps1 -NoEnvFile -Keyword x -Limit 1
$o = [ordered]@{}
$o.count  = (Get-HealthStore).Count
$o.cold   = ($null -ne (Test-EngineHealthCold -EngineName 'GitLab'))
$o.until  = [string](Get-HealthStore)['GitLab'].Until
[System.IO.File]::WriteAllText($env:U241_OUT, ($o | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
`;
  const { out, err } = await runPs(exe, probe, 180000, seed);
  assert.ok(out, 'probe 无输出；stderr=' + err.slice(0, 400));
  const j = JSON.parse(out);
  assert.equal(j.count, 1, '落盘的条目必须被读回');
  assert.equal(j.cold, true, '★ 未来 10 分钟到期的条目必须判 cold（否则健康记忆等于没生效）');
  assert.match(j.until, /Z$|[+-]00:00$/, '★ 读回后必须仍是 UTC roundtrip 串（丢 Z 就会按本地时间比较，偏一个时区）');
});

// ---- 接线（源码断言，带负例）----
function fnBody(src, name, endName) {
  const i = src.indexOf('function ' + name + ' {');
  assert.ok(i > 0, '锚点缺失：' + name);
  const j = src.indexOf('\nfunction ' + endName, i);
  assert.ok(j > i, '锚点缺失：' + endName);
  return src.slice(i, j);
}

function checkWiring(src) {
  const pool = fnBody(src, 'Invoke-EnginePool', 'Invoke-ConcurrentPlatformSearch');
  const dl = fnBody(src, 'Get-HealthProbedDeadlineSec', 'Update-EngineHealthFromPool');
  const rec = fnBody(src, 'Update-EngineHealthFromPool', 'Invoke-EnginePool');
  assert.match(pool, /Get-PoolBudgetSec -PoolBudgetSec/, '★ 池预算必须经 Get-PoolBudgetSec（min(单池, 本轮剩余)）');
  assert.match(pool, /\$swRun\.Elapsed\.TotalSeconds -gt \$budgetSec -and -not \$h\.Handle\.IsCompleted/,
    '★ 预算耗尽分支必须带 -not IsCompleted：已跑完的 handle 要照常收结果（否则 Stop 丢掉整批结果）');
  assert.match(pool, /Stop-EngineHandle/, '停止路径必须走 Stop-EngineHandle（保留已产出部分）');
  assert.match(dl, /Test-EngineHealthCold/, '逐源截止里必须查健康记忆（半开探测）');
  assert.match(rec, /Set-EngineHealthOutcome/, '池尾必须把结果写回健康记忆');
  assert.match(rec, /Save-HealthStore/, '池尾必须落盘');
  for (const m of ['research', 'code', 'repo']) {
    assert.match(src, new RegExp('Skip-ModeByBudget -Mode \'' + m + '\''), m + ' 模式必须有预算耗尽守卫');
  }
  const i0 = src.indexOf('function Get-TimeBudgetSec');
  const i1 = src.indexOf('function ', i0 + 10);
  assert.doesNotMatch(src.slice(i0, i1), /poolModes|\*\s*\$pools/, 'Get-TimeBudgetSec 不得改成乘池数（那是 U-226 的语义守卫）');
}

test('U-241/U-242 接线：池预算/已完成结果/健康记忆/模式跳过守卫齐备', () => {
  checkWiring(SRC);
});

test('U-241/U-242 负例：删掉 -not IsCompleted、把池预算换回 Get-TimeBudgetSec、去掉模式守卫 —— 都必须被点名', () => {
  const noCompleted = SRC.replace(' -and -not $h.Handle.IsCompleted', '');
  assert.notEqual(noCompleted, SRC, 'mutation 必须生效');
  assert.throws(() => checkWiring(noCompleted), /not IsCompleted|not \$h\.Handle/, '删掉 IsCompleted 判断必须判红');

  const backToPool = SRC.replace('Get-PoolBudgetSec -PoolBudgetSec $poolBudgetSec', '$poolBudgetSec');
  assert.notEqual(backToPool, SRC, 'mutation 必须生效');
  assert.throws(() => checkWiring(backToPool), /Get-PoolBudgetSec/, '回到每池独立预算必须判红');

  const guard = "if (($runModes -contains 'code') -and (Test-RunBudgetExhausted)) { Skip-ModeByBudget -Mode 'code' -Kind 'code'; $script:_skipModesByBudget += 'code' }";
  const noGuard = SRC.replace(guard, '');
  assert.notEqual(noGuard, SRC, 'mutation 必须生效');
  assert.throws(() => checkWiring(noGuard), /code 模式必须有预算耗尽守卫/, '去掉 code 守卫必须判红');
});
