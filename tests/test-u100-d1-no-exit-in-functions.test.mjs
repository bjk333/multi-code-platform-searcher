// U-100 D1 P3（2026-09-29）：静态门 —— 所有 function 体内 exit = 0（AST ExitStatementAst，经 tests/u100-d1-exit-audit.ps1）。
// 自带阳性对照（宿主 R85 要求）：合成样本「函数内含 exit」必须被报出；两次读数都打印原始行。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sourceAll } from './lib/source.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const audit = path.join(root, 'tests', 'u100-d1-exit-audit.ps1');
// U-144（2026-09-29）：解释器发现 = MCPS_PWSH → PATH → 常见解包目录；探活同时验证 -Command/-File。
// EBUSY 等瞬态重试；候选存在但始终无法探活 = unverifiable（不等同 not-found）；显式覆盖存在但不可执行时不得静默回退。
const DEFAULT_ROOTS = process.platform === 'win32'
  ? ['C:\\tmp\\ps7', 'C:\\Program Files\\PowerShell', 'C:\\Program Files (x86)\\PowerShell', path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'PowerShell')]
  : ['/usr/local/bin', '/usr/bin', '/opt/microsoft/powershell'];
const RETRIES = 3;
function syncWait(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
export function probePowerShell(exe, { spawn = spawnSync, sleep = syncWait, attempts = RETRIES, auditPath = audit } = {}) {
  const failures = []; let version = null; let retries = 0;
  const modes = [
    { name: '-Command', args: ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], check: out => { const m = (out || '').match(/\d+\.\d+\.\d+/); if (m) version = m[0]; return !!m; } },
    { name: '-File', args: ['-NoProfile', '-NonInteractive', '-File', auditPath, '-Path', 'multi-platform-searcher.ps1'], check: out => { try { const j = JSON.parse((out || '').trim().split(/\r?\n/).pop()); return j.parseErrors === 0 && typeof j.exitTotal === 'number'; } catch { return false; } } },
  ];
  for (const mode of modes) {
    let ok = false;
    for (let n = 1; n <= attempts; n++) {
      // ★timeout=25s、ETIMEDOUT 也重试（2026-10-20）：全量 8 路并发下，解释器冷启 + 解析 5.4k 行实测 >8s，
      //   原口径把两个探活模式都判成 unverifiable ⇒ 整个文件红（同一构建单跑 8/8 绿）。这是测量口径问题：
      //   正常 2s 量级，真挂死仍会被 25s×3 抓住（同 r2-post-fallback 的 hangMs 4s→15s 一类）。
      const r = spawn(exe, mode.args, { cwd: root, encoding: 'utf8', timeout: 25000, windowsHide: true });
      if (r.error) {
        const code = r.error.code || 'SPAWN_ERROR';
        if (code === 'ENOENT') return { state: 'not-found', exe, version, retries, failures: [...failures, `${mode.name}:ENOENT`] };
        if ((code === 'EBUSY' || code === 'ETIMEDOUT') && n < attempts) { retries++; sleep(40 * n); continue; }
        failures.push(`${mode.name}:${code}`); break;
      }
      if (r.status === 0 && mode.check(r.stdout || '')) { ok = true; break; }
      failures.push(`${mode.name}:exit=${r.status}`); break;
    }
    if (!ok) return { state: 'unverifiable', exe, version, retries, failures };
  }
  return { state: 'ok', exe, version, retries, failures };
}
export function findPowerShell({ env = process.env, roots = DEFAULT_ROOTS, spawn = spawnSync, sleep = syncWait } = {}) {
  const override = (env.MCPS_PWSH || '').trim();
  if (override) {
    if (!fs.existsSync(override)) throw new Error('not-found: MCPS_PWSH path does not exist: ' + override);
    const p = probePowerShell(override, { spawn, sleep });
    if (p.state !== 'ok') throw new Error('unverifiable: MCPS_PWSH exists but -Command/-File probes failed: ' + p.failures.join(', '));
    return p;
  }
  const cands = ['pwsh', 'powershell'];
  for (const r of roots) {
    try {
      for (const d of fs.readdirSync(r)) {
        const p1 = path.join(r, d); const exeName = process.platform === 'win32' ? 'pwsh.exe' : 'pwsh';
        if (d === exeName) cands.push(p1);
        else if (fs.statSync(p1).isDirectory() && fs.existsSync(path.join(p1, exeName))) cands.push(path.join(p1, exeName));
      }
    } catch { }
  }
  const seen = new Set(); const unverifiable = []; let found = false;
  for (const exe of cands) {
    if (seen.has(exe)) continue; seen.add(exe);
    if ((exe.includes('/') || exe.includes('\\')) && !fs.existsSync(exe)) continue;
    const p = probePowerShell(exe, { spawn, sleep });
    if (p.state === 'ok') return p;
    if (p.state === 'unverifiable') { found = true; unverifiable.push(`${exe}(${p.failures.join(',')})`); }
  }
  if (found) throw new Error('unverifiable: PowerShell candidates exist but could not be verified: ' + unverifiable.join(' | '));
  throw new Error('not-found: no PowerShell executable found (MCPS_PWSH, PATH, ' + roots.join(', ') + ')');
}
const PS = findPowerShell();
console.error('[U-144] interpreter: ' + PS.exe + ' v' + PS.version + ' modes=-Command,-File retries=' + PS.retries);
function runAudit(target) {
  // ★timeout=30s（2026-10-20）：原 8s 是"单次墙钟"型断言 —— 全量 8 路并发下 pwsh 冷启+解析 5.4k 行实测 >8s，
  //   被记成 env:interp-timeout（同一构建单跑 8/8 绿）。这是测量口径问题不是产品缺陷：审计本身 2s 量级，
  //   真挂死仍会被 30s 抓住（与 test-r2-post-fallback 的 hangMs 4s→15s 同类）。
  const r = spawnSync(PS.exe, ['-NoProfile', '-NonInteractive', '-File', audit, '-Path', target], { cwd: root, encoding: 'utf8', timeout: 30000, windowsHide: true });
  if (r.error) throw r.error;
  const line = (r.stdout || '').trim().split(/\r?\n/).pop();
  return { exe: PS.exe, json: JSON.parse(line), raw: line };
}

test('U-100 D1 P3: no exit inside any function body of the product source (AST), with raw reading printed', () => {
  // v1.54.0（B3-2）：函数搬进了 lib/ ⇒ 逐个文件审计后汇总。判据本体不变：
  //   函数体内 exit 必须为 0，且**全产品**只剩主流程那 6 个 exit 点（少一个 = 有人删了收尾，多一个 = 有人从函数里退出）。
  const targets = ['multi-platform-searcher.ps1'];
  const libDir = path.join(root, 'lib');
  if (fs.existsSync(libDir)) targets.push(...fs.readdirSync(libDir).filter(f => f.endsWith('.ps1')).sort().map(f => 'lib/' + f));
  let totalFns = 0; let totalExits = 0; const withExit = [];
  for (const t of targets) {
    const { json, raw } = runAudit(t);
    console.error('[D1-P3] ' + t + ': ' + raw);
    assert.equal(json.parseErrors, 0, t + ' 解析失败');
    totalFns += json.functions; totalExits += json.exitTotal;
    for (const x of json.functionsWithExit) withExit.push({ file: t, name: x.name, exits: x.exits });
  }
  assert.ok(totalFns >= 60, 'functions=' + totalFns);
  assert.deepEqual(withExit, [], 'functions containing exit: ' + JSON.stringify(withExit));
  assert.equal(totalExits, 6, 'U-84/U-208 invariant: exactly 6 exit sites (2026-10-19 增 -Serve；2026-10-22 v1.47.2 增主流程收尾 exit $processExitCode)，实得 ' + totalExits);
});
test('U-100 D1 P3 positive control: a synthetic function containing exit is reported (the ruler can measure 1)', () => {
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'd1p3-'));
  const f = path.join(sb, 'sample.ps1');
  try {
    fs.writeFileSync(f, "function Good { param($x) return $x }\nfunction Bad { if ($true) { exit 3 } }\nWrite-Output 'top'\nexit 0\n");
    const { json, raw } = runAudit(f);
    console.error('[D1-P3] positive: ' + raw);
    assert.equal(json.functions, 2); assert.equal(json.exitTotal, 2);
    assert.deepEqual(json.functionsWithExit, [{ name: 'Bad', exits: 1 }]);
  } finally { fs.rmSync(sb, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
test('U-100 D1: Invoke-DoctorReport exists, the guard calls it and keeps exit 0 at the call site', () => {
  const src = sourceAll(path.join(root));
  assert.match(src, /^function Invoke-DoctorReport \{\n    param\(\[switch\]\$AsJson\)\n    \$doctorReport = \[ordered\]@\{\}/m);
  assert.match(src, /^if \(\$Doctor\) \{ Invoke-DoctorReport -AsJson:\$AsJson; exit 0 \}$/m);
  assert.doesNotMatch(src, /\$null = Invoke-DoctorReport/, 'call site must not swallow the pipeline output (it is the -AsJson stdout contract)');
  const gi = src.indexOf("if (-not $env:MCPS_NO_MAIN"); const fi = src.indexOf('function Invoke-DoctorReport {');
  assert.ok(fi > 0 && fi < gi, 'function must be defined before the main guard');
});
// D1 stage 1: pin the future helper chain before moving any product code. This gate is
// deliberately RED on the pre-split product; the synthetic positive/negative rulers below
// must be GREEN in the host's pre-move gate run.
function d1Block(src, name) {
  const marker = `function ${name} {`;
  const at = src.indexOf(marker);
  assert.ok(at >= 0, 'D1 helper missing: ' + name);
  const tail = src.slice(at);
  const next = /^function [A-Za-z][\w-]* \{/gm;
  next.lastIndex = marker.length;
  return tail.slice(0, next.exec(tail)?.index ?? tail.length);
}
function assertDoctorSplitWiring(src) {
  const body = d1Block(src, 'Invoke-DoctorReport');
  for (const name of ['Get-DoctorTokens', 'Get-DoctorRemoteCodeHealth', 'Get-DoctorResearchHealth', 'Write-DoctorReportOutput'])
    d1Block(src, name); // every called helper must have a real top-level definition
  const calls = [
    '$tokenState = Get-DoctorTokens -VERSION $VERSION',
    '$codeHealth = Get-DoctorRemoteCodeHealth -VERSION $VERSION -ghTok $ghTok -glTok $glTok',
    '$researchState = Get-DoctorResearchHealth -VERSION $VERSION',
    'Write-DoctorReportOutput -AsJson:$AsJson -VERSION $VERSION -doctorReport $doctorReport'
  ];
  const positions = calls.map(call => {
    const at = body.indexOf(call);
    assert.ok(at >= 0, 'D1 missing call: ' + call);
    return at;
  });
  assert.ok(positions.every((n, i) => i === 0 || n > positions[i - 1]), 'D1 call order changed');
  const out = body.split(/\r?\n/).filter(line => line.includes(calls[3]));
  assert.equal(out.length, 1, 'D1 output call must appear exactly once');
  assert.match(out[0], /^\s+Write-DoctorReportOutput -AsJson:\$AsJson -VERSION \$VERSION -doctorReport \$doctorReport\b/, 'D1 output must be bare: no $null =, assignment or @()');
  const renderer = d1Block(src, 'Write-DoctorReportOutput');
  assert.match(renderer, /\$doctorOut \| ConvertTo-Json -Depth 6/, 'D1 JSON producer missing');
  // U-266：人读产物改由 Write-PayloadOutput 负责（进度走 Write-ColorOutput → stderr，产物 → 成功流）。
  //   断言点不变：Doctor 的人读输出必须**存在**，且不得被 $null=/赋值/@() 吞掉。
  assert.match(renderer, /Write-PayloadOutput/, 'D1 human stdout producer missing');
  assert.match(src, /^if \(\$Doctor\) \{ Invoke-DoctorReport -AsJson:\$AsJson; exit 0 \}$/m, 'D1 exit stays at the guard');
  return true;
}
test('U-100 D1 stage 1: public Doctor invokes four real helpers in order and emits output bare', () => {
  assert.ok(assertDoctorSplitWiring(sourceAll(path.join(root))));
});
test('U-100 D1 stage 1 negative controls: absent helper/call, reordered calls or swallowed output are detected', () => {
  const fixture = [
    'function Get-DoctorTokens { param($VERSION) }',
    'function Get-DoctorRemoteCodeHealth { param($VERSION,$ghTok,$glTok) }',
    'function Get-DoctorResearchHealth { param($VERSION) }',
    'function Write-DoctorReportOutput { if ($AsJson) { $doctorOut | ConvertTo-Json -Depth 6 } else { Write-PayloadOutput "doctor" } }',
    'function Invoke-DoctorReport {',
    '    param([switch]$AsJson)',
    '    $doctorReport = [ordered]@{}',
    '    $tokenState = Get-DoctorTokens -VERSION $VERSION',
    '    $codeHealth = Get-DoctorRemoteCodeHealth -VERSION $VERSION -ghTok $ghTok -glTok $glTok',
    '    $researchState = Get-DoctorResearchHealth -VERSION $VERSION',
    '    Write-DoctorReportOutput -AsJson:$AsJson -VERSION $VERSION -doctorReport $doctorReport',
    '}',
    'if ($Doctor) { Invoke-DoctorReport -AsJson:$AsJson; exit 0 }'
  ].join('\n');
  assert.ok(assertDoctorSplitWiring(fixture), 'positive split fixture must pass before any negative mutations');
  const noHelper = fixture.replace('function Get-DoctorTokens {', 'function Omitted-DoctorTokens {');
  assert.notEqual(noHelper, fixture); assert.throws(() => assertDoctorSplitWiring(noHelper), /D1 helper missing: Get-DoctorTokens/);
  const noCall = fixture.replace('    $codeHealth = Get-DoctorRemoteCodeHealth -VERSION $VERSION -ghTok $ghTok -glTok $glTok', '    $codeHealth = $null');
  assert.notEqual(noCall, fixture); assert.throws(() => assertDoctorSplitWiring(noCall), /D1 missing call: .*Get-DoctorRemoteCodeHealth/);
  const reordered = fixture.replace('    $codeHealth = Get-DoctorRemoteCodeHealth -VERSION $VERSION -ghTok $ghTok -glTok $glTok\n    $researchState = Get-DoctorResearchHealth -VERSION $VERSION', '    $researchState = Get-DoctorResearchHealth -VERSION $VERSION\n    $codeHealth = Get-DoctorRemoteCodeHealth -VERSION $VERSION -ghTok $ghTok -glTok $glTok');
  assert.notEqual(reordered, fixture); assert.throws(() => assertDoctorSplitWiring(reordered), /D1 call order changed/);
  for (const prefix of ['$null = ', '$capture = ', '@(']) {
    const swallowed = fixture.replace('    Write-DoctorReportOutput -AsJson:', '    ' + prefix + 'Write-DoctorReportOutput -AsJson:');
    assert.notEqual(swallowed, fixture); assert.throws(() => assertDoctorSplitWiring(swallowed), /D1 output must be bare/);
  }
});
test('U-144 positive retry control: transient EBUSY is retried and both -Command and -File probes must pass', () => {
  let calls = 0; const modes = [];
  const fakeSpawn = (_exe, args) => {
    calls++; const mode = args.includes('-Command') ? '-Command' : '-File'; modes.push(mode);
    if (mode === '-Command' && calls <= 2) return { error: Object.assign(new Error('busy'), { code: 'EBUSY' }) };
    return mode === '-Command'
      ? { status: 0, stdout: '7.6.6\n', stderr: '' }
      : { status: 0, stdout: '{"parseErrors":0,"exitTotal":5}\n', stderr: '' };
  };
  const p = probePowerShell('fake-ps', { spawn: fakeSpawn, sleep: () => {}, attempts: 3, auditPath: 'unused' });
  assert.equal(p.state, 'ok'); assert.equal(p.version, '7.6.6'); assert.equal(p.retries, 2);
  assert.deepEqual(modes, ['-Command','-Command','-Command','-File']);
});
test('U-144 negative: MCPS_PWSH existing but non-executable is reported unverifiable, never not-found or silent fallback', () => {
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'u144-')); const bad = path.join(sb, 'not-an-executable.bin');
  try {
    fs.writeFileSync(bad, 'plain text');
    const env = { ...process.env, MCPS_PWSH: bad };
    assert.throws(() => findPowerShell({ env, roots: [], spawn: spawnSync, sleep: () => {} }), /unverifiable: MCPS_PWSH exists/);
  } finally { fs.rmSync(sb, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
test('U-144: ENOENT is classified not-found, distinct from an existing but unverifiable executable', () => {
  const p = probePowerShell('missing-ps', { spawn: () => ({ error: Object.assign(new Error('missing'), { code: 'ENOENT' }) }), sleep: () => {} });
  assert.equal(p.state, 'not-found'); assert.match(p.failures[0], /ENOENT/);
  assert.throws(() => findPowerShell({ env: {}, roots: [], spawn: () => ({ error: Object.assign(new Error('missing'), { code: 'ENOENT' }) }), sleep: () => {} }), /not-found:/);
});
