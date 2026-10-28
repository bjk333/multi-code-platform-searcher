// U-153（A5，2026-09-30）：门输出分区（env 红 / product 红）自检。预注册：reports/U-153-预注册判据-2026-09-30.md。
// 1) 分类器：宿主原始红行（安全删除 shim、spawnSync EBUSY、无 powershell.exe）⇒ env；断言失败 / 未知 / 超时 ⇒ product。
// 2) 端到端（真门 + 注入）：
//    P1 真产品违约：临时副本里从 Get-HttpLayerClosure 删掉 Invoke-WebRequestDirect ⇒ 真门 U-49(mirror) 报 product 红，rc=1；
//    P2 纯 env 症状：假 shim 让 spawnSync 一律 EBUSY ⇒ 真门 U-100 D1 文件级红记 env:spawnsync-ebusy，product=0，rc=3；
//    P3 safe-delete：假 shim 让清理 rmSync 抛 [safe-delete] ⇒ 真门 U-136 负例本身通过，清理记 env:safe-delete-shim，rc=3；
//    P4 掩盖：测试体断言失败 + finally 清理被 shim 拦 ⇒ 仍报 product 红（对照：不挂 preload 时报文被 [safe-delete] 顶掉）。
// 所有注入只发生在 os.tmpdir() 下的副本里，本门不写 tests/ 与 _verify/。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { classifyFailure, uncaughtLine, GateEnvError, envFail, networkOffline, envFailIfOffline, summarize, exitCodeFor, ENV_KINDS, envFailIfInterpBroken, INTERP_BROKEN } from './gate-partition.mjs';
import { runGates } from './run-node-gates.mjs';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(testsDir, '..');
const launcher = fs.readFileSync(path.join(testsDir, 'run-node-gates.mjs'), 'utf8');

test('U-153 static: launcher mounts the preload and the partition reporter, keeps spec on stdout, and maps rc product=1 / env-only=3', () => {
  assert.match(launcher, /'--import', pathToFileURL\(path\.join\(testsDir, 'gate-env-preload\.mjs'\)\)\.href/);
  assert.match(launcher, /'--test-reporter=spec', '--test-reporter-destination=stdout'/);
  assert.match(launcher, /gate-partition\.mjs'\)\)\.href, '--test-reporter-destination=' \+ partFile/);
  assert.match(launcher, /printPartition\(summary\)/);
  assert.equal(exitCodeFor({ productRed: 1, envRed: 5 }, 1), 1);
  assert.equal(exitCodeFor({ productRed: 0, envRed: 2 }, 1), 3);
  assert.equal(exitCodeFor({ productRed: 0, envRed: 0 }, 0), 0);
  assert.equal(exitCodeFor({ productRed: 0, envRed: 0 }, 1), 1, 'child failed with nothing classifiable ⇒ product (fail-closed)');
  const s = summarize(null, []);
  assert.equal(s.productRed, 0);
});

test('U-153 classifier: the host\'s raw env lines are env, each with its kind', () => {
  const cases = [
    ['[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED] {"count":3014,"threshold":50}', 'safe-delete-shim'],
    ['[safe-delete] rmSync C:\\Users\\x\\genie-trash\\y ETIMEDOUT', 'safe-delete-shim'],
    ['unverifiable: PowerShell candidates exist but could not be verified: pwsh(-Command:EBUSY) | powershell(-Command:EBUSY)', 'spawnsync-ebusy'],
    ['unverifiable: PowerShell candidates exist but could not be verified: pwsh(-Command:ETIMEDOUT) | powershell(-File:ETIMEDOUT)', 'interp-timeout'],
    [{ message: 'spawnSync pwsh EBUSY', code: 'EBUSY', syscall: 'spawnSync pwsh' }, 'spawnsync-ebusy'],
    [{ message: 'spawn powershell.exe ENOENT', code: 'ENOENT', syscall: 'spawn powershell.exe' }, 'no-powershell'],
    ['not-found: no PowerShell executable found (MCPS_PWSH, PATH, /usr/bin)', 'no-powershell'],
    [new GateEnvError('no-network', 'doctor killed after 120000ms [U153_NETWORK=offline]'), 'no-network'],
    // 2026-10-20：CoreCLR 起不来（高并发/低可用内存）—— 门在拿到子进程输出后显式声明，不在报文白名单里
    [new GateEnvError('interp-oom', 'Failed to create CoreCLR, HRESULT: 0x8007000E'), 'interp-oom'],
  ];
  for (const [input, kind] of cases) {
    const c = classifyFailure(input);
    assert.deepEqual([c.cls, c.kind], ['env', kind], JSON.stringify(typeof input === 'string' ? input : input.message) + ' ⇒ ' + c.why);
  }
});

test('U-153 classifier negatives: assertions, unknown markers, product timeouts and non-PowerShell ENOENT stay product', () => {
  const ae = new assert.AssertionError({ message: 'expected no spawnSync pwsh EBUSY but saw one', actual: 1, expected: 2, operator: 'strictEqual' });
  const cases = [
    ae,
    { message: 'wrapped', cause: { message: '[safe-delete] looks like env but is an assertion', code: 'ERR_ASSERTION', name: 'AssertionError' } },
    // 2026-10-20 收窄性负例：CoreCLR 报文出现在**断言**里仍 product —— 只有门显式 envFail('interp-oom') 才改记 env。
    new assert.AssertionError({ message: 'Failed to create CoreCLR, HRESULT: 0x8007000E (but this is an assertion)', actual: 1, expected: 0, operator: 'strictEqual' }),
    'injectVars entries with no top-level definition: _networkEngine',
    'PowerShell batch harness: pwsh harness timeout (40s)',
    'unverifiable: PowerShell candidates exist but could not be verified: pwsh(-Command:exit=1)',
    // 收窄性负例（2026-10-19）：通用 spawn 超时**不是** U-144 的探活形状 ⇒ 仍 product（fail-closed，不给"门自己挂死"开后门）
    { message: 'spawnSync pwsh ETIMEDOUT', code: 'ETIMEDOUT', syscall: 'spawnSync pwsh' },
    '[gate-env:bogus] not an allowed kind',
    { message: 'spawn rg ENOENT', code: 'ENOENT', syscall: 'spawn rg' },
    { message: 'getaddrinfo ENOTFOUND api.example.invalid', code: 'ENOTFOUND' },
    '',
  ];
  for (const input of cases) {
    const saved = process.env.U153_TIMING;   // U-153 Q2：本负例针对「无时序凭据」路径 ⇒ 临时清声明
    try { delete process.env.U153_TIMING; assert.equal(classifyFailure(input).cls, 'product', JSON.stringify(input?.message ?? input)); }
    finally { if (saved === undefined) delete process.env.U153_TIMING; else process.env.U153_TIMING = saved; }
  }
  assert.throws(() => new GateEnvError('bogus', 'x'), /unknown env kind/);
  assert.throws(() => envFail('safe-delete-shim', 'x'), e => e instanceof GateEnvError && classifyFailure(e).kind === 'safe-delete-shim');
  assert.deepEqual([...ENV_KINDS], ['spawnsync-ebusy', 'interp-timeout', 'interp-oom', 'safe-delete-shim', 'no-powershell', 'no-network', 'timing'], '2026-10-19 增 interp-timeout：解释器探活超时是环境症状（测试一行未跑），不是产品违约；2026-10-20 增 interp-oom：CoreCLR 起不来同理');
});

// U-153（2026-10-20）：解释器 OOM 的**显式声明器** —— 只有调用点主动传进 CoreCLR 报文才记 env；别处不猜。
test('U-153 interp-oom: only an explicit call site converts CoreCLR startup failure into env:interp-oom', () => {
  const oom = 'Failed to load System.Private.CoreLib.dll (error code 0x8007000E)\nPath: C:\\x\\System.Private.CoreLib.dll\nError message: Out Of Memory\nFailed to create CoreCLR, HRESULT: 0x8007000E';
  assert.ok(INTERP_BROKEN.test(oom));
  const e = (() => { try { envFailIfInterpBroken(oom); } catch (x) { return x; } })();
  assert.ok(e instanceof GateEnvError);
  assert.deepEqual([classifyFailure(e).cls, classifyFailure(e).kind], ['env', 'interp-oom']);
  // 负例：普通失败不因本助手改记 env（保持 fail-closed）
  assert.doesNotThrow(() => envFailIfInterpBroken('U-114/U-152 nine-query batch acceptance failed: counts/errors differ'));
  assert.doesNotThrow(() => envFailIfInterpBroken(''));
});

// U-153 Q2（宿主裁定，2026-09-30）：时序类与 no-network 同口径 —— 须凭据。无 U153_TIMING 声明时已知时序签名仍记 product。
test('U-153 timing class: known timing signatures are env:timing ONLY with U153_TIMING evidence; else product', () => {
  const msg114 = 'PowerShell batch harness: pwsh harness timeout (40s)';
  const msg114elapsed = 'PowerShell batch harness: Exception: U-114 acceptance failed: batch elapsed 16242ms > half-p95 8100ms';
  const msgD = 'engine hung for >4000ms';
  const saved = process.env.U153_TIMING;
  try {
    delete process.env.U153_TIMING;
    assert.equal(classifyFailure({ message: msg114 }).cls, 'product', 'timing w/o evidence must stay product (fail-closed)');
    assert.equal(classifyFailure({ message: msg114elapsed }).cls, 'product', 'elapsed-only red w/o evidence stays product');
    assert.equal(classifyFailure({ message: msgD }).cls, 'product');
    process.env.U153_TIMING = '1';
    for (const m of [msg114, msg114elapsed, msgD]) {
      const c = classifyFailure({ message: m });
      assert.deepEqual([c.cls, c.kind], ['env', 'timing'], JSON.stringify(m) + ' ⇒ ' + c.why);
    }
    assert.equal(classifyFailure({ message: 'some unrelated operation timed out after 99s' }).cls, 'product', 'arbitrary timeout is NOT timing');
    // 2026-10-20 收窄性：条数/错误不符**不是**时序，凭据在也仍 product
    assert.equal(classifyFailure({ message: 'U-114/U-152 nine-query batch acceptance failed: counts/errors differ' }).cls, 'product');
  } finally { if (saved === undefined) delete process.env.U153_TIMING; else process.env.U153_TIMING = saved; }
});

test('U-153 file-level: only the uncaught error line classifies, never diagnostics that merely mention EBUSY', () => {
  const stderr = '[diag] retrying spawnSync pwsh EBUSY (informational)\nfile:///x.mjs:2\nthrow new Error(...)\n\nError: injectVars entries with no top-level definition: x\n    at file:///x.mjs:2:7\n';
  assert.equal(uncaughtLine(stderr), 'Error: injectVars entries with no top-level definition: x');
  assert.equal(uncaughtLine('[diag] only diagnostics\n'), null);
  assert.equal(uncaughtLine('TypeError [ERR_X]: boom\n'), 'TypeError [ERR_X]: boom');
});

test('U-153 no-network: needs evidence (declared offline or DNS failure); a timeout with reachable DNS stays product', async () => {
  const ok = async () => ({ address: '1.2.3.4' });
  const nx = async () => { throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' }); };
  assert.equal((await networkOffline({ env: {}, lookup: ok })).offline, false);
  assert.equal((await networkOffline({ env: {}, lookup: nx })).offline, true);
  assert.equal((await networkOffline({ env: { U153_NETWORK: 'offline' }, lookup: ok })).offline, true);
  assert.equal((await networkOffline({ env: { U153_NETWORK: 'online' }, lookup: nx })).offline, false);
  await assert.rejects(envFailIfOffline('doctor killed', { env: {}, lookup: nx }), e => classifyFailure(e).kind === 'no-network');
  await assert.rejects(envFailIfOffline('doctor killed', { env: {}, lookup: ok }), e => classifyFailure(e).cls === 'product');
});

// ---------------- 端到端：临时副本 + 真门 ----------------
let sb = null;
const SKIP = new Set(['_verify', '.git', '__pycache__', 'node_modules']);
before(() => {
  sb = fs.mkdtempSync(path.join(os.tmpdir(), 'u153-sb-'));
  const skipCopy = src => {
    const b = path.basename(src);
    if (b === '.env' || b.startsWith('.env.')) return false;   // 本地凭据文件不入沙箱副本（卫生 + 不依赖本机配置）
    if (SKIP.has(b) && path.dirname(src) === root) return false;
    // 读不了的本机文件（权限/占用）不该让整个沙箱崩：副本不是被测物，真树完整性由 U-138/U-139 另管。
    // ★必须真的 open 一次 —— fs.accessSync(R_OK) 在 Windows 上只查属性、不查 DACL，空 ACL 的文件会被它判"可读"。
    try { fs.closeSync(fs.openSync(src, 'r')); } catch { console.error('[copy] skip unreadable: ' + src); return false; }
    return true;
  };
  fs.cpSync(root, sb, { recursive: true, filter: skipCopy });
  fs.writeFileSync(path.join(sb, 'shim-ebusy.cjs'),
    "const cp = require('child_process'); cp.spawnSync = function () { const e = new Error('spawnSync ' + arguments[0] + ' EBUSY'); e.code = 'EBUSY'; e.syscall = 'spawnSync ' + arguments[0]; return { pid: 0, output: [], stdout: '', stderr: '', status: null, signal: null, error: e }; }; require('module').syncBuiltinESMExports();\n");
  fs.writeFileSync(path.join(sb, 'shim-safe-delete.cjs'),
    "const fs = require('fs'); fs.rmSync = function () { throw new Error('[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED] {\"count\":3014,\"threshold\":50}'); }; require('module').syncBuiltinESMExports();\n");
  fs.mkdirSync(path.join(sb, 'u153fx'));
  fs.writeFileSync(path.join(sb, 'u153fx', 'test-masked.test.mjs'),
    "import { test } from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';\n" +
    "test('U153FX masked product failure', () => { const t = fs.mkdtempSync(path.join(os.tmpdir(), 'u153fx-')); try { assert.equal('product', 'broken', 'U153FX real product assertion'); } finally { fs.rmSync(t, { recursive: true, force: true }); } });\n");
});
after(() => { if (sb) try { fs.rmSync(sb, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (e) { console.error('[U-153] sandbox cleanup: ' + e.message); } });
const quiet = (extra = {}) => { const env = { ...process.env, NODE_OPTIONS: '', U153_NETWORK: 'online', ...extra }; delete env.U153_ENV_EVENTS; return { cwd: sb, stdio: 'pipe', env }; };

test('U-153 P1 product violation: dropping Invoke-WebRequestDirect from the HTTP closure makes the real U-49 gate report product red (rc=1); unmutated it is green', async () => {
  const gate = path.join(sb, 'tests', 'test-n8-http-catch.test.mjs');
  const only = ['--test-name-pattern=^U-49 \\(mirror\\)'];
  const clean = await runGates({ files: [gate], extraExecArgv: only, ...quiet() });
  assert.equal(clean.summary.productRed, 0, 'baseline must be green before mutation: ' + clean.output.slice(-800));
  // v1.54.0（B3-2）：`Get-HttpLayerClosure` 已搬进 lib/。变异必须打在**它真正定义的文件**上，
  //   否则门只会绿在"变异没咬到"上（这类假绿比红更坏）。
  const defFile = [path.join(sb, 'multi-platform-searcher.ps1'), ...fs.readdirSync(path.join(sb, 'lib')).map(f => path.join(sb, 'lib', f))]
    .find(p => fs.readFileSync(p, 'utf8').includes('function Get-HttpLayerClosure {'));
  assert.ok(defFile, '找不到 Get-HttpLayerClosure 的定义文件（主脚本 + lib/*）');
  const src = fs.readFileSync(defFile, 'utf8');
  const mutated = src.replace(/(function Get-HttpLayerClosure \{[\s\S]*?return @\([^\n]*?)'Invoke-WebRequestDirect',\s*/, '$1');
  assert.notEqual(mutated, src, 'mutation must bite');
  fs.writeFileSync(defFile, mutated, 'utf8');
  try {
    const r = await runGates({ files: [gate], extraExecArgv: only, ...quiet() });
    console.error('[U-153 P1] product_red=' + r.summary.productRed + ' env_red=' + r.summary.envRed + ' rc=' + r.rc);
    assert.ok(r.summary.product.some(x => /^U-49 \(mirror\)/.test(x.name)), JSON.stringify(r.summary.product.map(x => x.name)));
    assert.equal(r.summary.envRed, 0);
    assert.equal(r.rc, 1);
  } finally { fs.writeFileSync(defFile, src, 'utf8'); }
});

test('U-153 P2 pure env symptom: spawnSync EBUSY shim turns the real U-100 D1 gate red as env:spawnsync-ebusy only (product=0, rc=3)', async () => {
  const gate = path.join(sb, 'tests', 'test-u100-d1-no-exit-in-functions.test.mjs');
  const r = await runGates({ files: [gate], ...quiet({ NODE_OPTIONS: '--require ./shim-ebusy.cjs' }) });
  console.error('[U-153 P2] product_red=' + r.summary.productRed + ' env_red=' + r.summary.envRed + ' ' + JSON.stringify(r.summary.envByKind) + ' rc=' + r.rc);
  assert.ok(r.summary.envByKind['spawnsync-ebusy'] >= 1, r.output.slice(-1200));
  assert.equal(r.summary.productRed, 0, JSON.stringify(r.summary.product));
  assert.equal(r.rc, 3);
});

test('U-153 P3 safe-delete shim: the real U-136 negative control still passes; the blocked cleanup is counted env:safe-delete-shim (rc=3)', async () => {
  const gate = path.join(sb, 'tests', 'test-u136-token-gate.test.mjs');
  const r = await runGates({ files: [gate], extraExecArgv: ['--test-name-pattern=^U-136 negative control'], ...quiet({ NODE_OPTIONS: '--require ./shim-safe-delete.cjs' }) });
  console.error('[U-153 P3] product_red=' + r.summary.productRed + ' env_red=' + r.summary.envRed + ' ' + JSON.stringify(r.summary.envByKind) + ' rc=' + r.rc);
  assert.equal(r.summary.productRed, 0, JSON.stringify(r.summary.product));
  assert.ok(r.summary.envByKind['safe-delete-shim'] >= 1, r.output.slice(-1200));
  assert.equal(r.rc, 3);
});

test('U-153 P4 masking: a real assertion failure followed by a shim-blocked cleanup is still product red (control: without the preload the [safe-delete] text hides it)', async () => {
  const fx = path.join(sb, 'u153fx', 'test-masked.test.mjs');
  const shimOpt = '--require ./shim-safe-delete.cjs';   // 相对 cwd=sb：避免 Windows 路径在 NODE_OPTIONS 里的引号/反斜杠转义
  const r = await runGates({ files: [fx], ...quiet({ NODE_OPTIONS: shimOpt }) });
  console.error('[U-153 P4] product_red=' + r.summary.productRed + ' env_red=' + r.summary.envRed + ' rc=' + r.rc);
  assert.ok(r.summary.product.some(x => x.name === 'U153FX masked product failure' && /U153FX real product assertion/.test(x.message)), JSON.stringify(r.summary.product));
  assert.equal(r.summary.envByKind['safe-delete-shim'], 1);
  assert.equal(r.rc, 1);
  // 对照：直接 node --test（无 preload）⇒ finally 的 [safe-delete] 顶掉断言 —— 证明 P4 的防掩盖不是空转
  const raw = await new Promise(res => {
    const env = { ...process.env, NODE_OPTIONS: shimOpt }; delete env.NODE_TEST_CONTEXT; delete env.U153_ENV_EVENTS;
    const c = spawn(process.execPath, ['--test', fx], { cwd: sb, env }); let o = '';
    c.stdout.on('data', d => { o += d; }); c.stderr.on('data', d => { o += d; }); c.once('exit', code => res({ code, o }));
  });
  assert.notEqual(raw.code, 0);
  assert.match(raw.o, /\[safe-delete\]\[SAFE_DELETE_BULK_CONFIRM_REQUIRED\]/);
  assert.doesNotMatch(raw.o, /U153FX real product assertion/);
});
