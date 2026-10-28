// U-130：-AsJson 输出在非 UTF-8 控制台（模拟 Windows 默认代码页）下经管道捕获仍为 UTF-8，中文不折成 '?'。
// 预注册：reports/U-130-预注册判据-2026-09-28.md（P1 / P1' / P4）。向量 = -Doctor -AsJson -NoEnvFile（输出含中文字段「本地代码检索」）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { envFail, envFailIfOffline } from './gate-partition.mjs';
import { sourceAll } from './lib/source.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = path.join(rootDir, 'multi-platform-searcher.ps1');

function run(exe, command) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, ['-NoProfile', '-NonInteractive', '-Command', command], { cwd: rootDir, env: { ...process.env, MCPS_NO_MAIN: '' } });
    const out = [], err = [];
    let timedOut = false;   // U-153：超时须可区分（有离线证据 ⇒ env:no-network；否则仍是 product 红）
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 120000);
    child.stdout.on('data', c => { out.push(c); }); child.stderr.on('data', c => { err.push(c); });
    child.once('error', e => { clearTimeout(timer); reject(e); });
    child.once('close', (status) => {
      clearTimeout(timer);
      const stdoutBytes = Buffer.concat(out), stderrBytes = Buffer.concat(err);
      resolve({ status, timedOut, stdout: stdoutBytes.toString('utf8'), stderr: stderrBytes.toString('utf8'), stdoutBytes });
    });
  });
}
async function runAny(command) {
  let last = null;
  for (const exe of ['pwsh', 'powershell']) {
    try { last = await run(exe, command); return last; } catch (e) { last = { error: e }; }
  }
  // U-153：两个解释器都 ENOENT = 本机没有 PowerShell（环境），其它启动错误仍按 product 红。
  const code = last && last.error && last.error.code;
  if (code === 'ENOENT') envFail('no-powershell', 'no PowerShell found (pwsh/powershell): ' + last.error.message);
  assert.fail('no PowerShell found (pwsh/powershell): ' + (last && last.error && last.error.message));
}
async function notTimedOut(r, label) {
  if (r.timedOut) await envFailIfOffline(label + ': PowerShell child killed after 120000ms timeout');
  return r;
}
const ASCII = '[Console]::OutputEncoding=[System.Text.Encoding]::ASCII; ';

// D1: JSON and human stdout must stay in the renderer reached by the public Doctor,
// and the renderer must run as a bare pipeline expression (not an assignment or @()).
function doctorSection(src, name) {
  const mark = `function ${name} {`;
  const at = src.indexOf(mark);
  assert.ok(at >= 0, 'U-130 D1 function missing: ' + name);
  const tail = src.slice(at);
  const next = /^function [A-Za-z][\w-]* \{/gm;
  next.lastIndex = mark.length;
  return tail.slice(0, next.exec(tail)?.index ?? tail.length);
}
function checkDoctorOutputWiring(src) {
  const caller = doctorSection(src, 'Invoke-DoctorReport');
  const split = src.includes('function Write-DoctorReportOutput {');
  const output = split ? doctorSection(src, 'Write-DoctorReportOutput') : caller;
  if (split) {
    const calls = caller.split(/\r?\n/).filter(line => line.includes('Write-DoctorReportOutput -AsJson:$AsJson'));
    assert.equal(calls.length, 1, 'U-130 Doctor must invoke renderer exactly once');
    assert.match(calls[0], /^\s+Write-DoctorReportOutput -AsJson:\$AsJson -VERSION \$VERSION -doctorReport \$doctorReport(?:\s|$)/, 'U-130 renderer call must be bare, not captured');
  }
  assert.match(output, /\$doctorOut \| ConvertTo-Json -Depth 6/, 'U-130 actual output path must serialize doctor JSON');
  assert.match(output, /Write-PayloadOutput/, 'U-130 actual output path must also preserve human stdout');
  return true;
}
test('U-130 D1 source wiring: Doctor reaches JSON/human renderer without swallowing pipeline bytes', () => {
  assert.ok(checkDoctorOutputWiring(sourceAll(rootDir)));
});
test('U-130 D1 negative controls: dropping or capturing the renderer is detected against a passing split fixture', () => {
  const fixture = [
    'function Invoke-DoctorReport {',
    '    param([switch]$AsJson)',
    '    $doctorReport = [ordered]@{}',
    '    Write-DoctorReportOutput -AsJson:$AsJson -VERSION $VERSION -doctorReport $doctorReport',
    '}',
    'function Write-DoctorReportOutput {',
    '    $doctorOut | ConvertTo-Json -Depth 6',
    '    Write-PayloadOutput "Doctor" "Cyan"',
    '}'
  ].join('\n');
  assert.ok(checkDoctorOutputWiring(fixture), 'positive renderer fixture must pass before mutations');
  const removed = fixture.replace('    Write-DoctorReportOutput -AsJson:$AsJson -VERSION $VERSION -doctorReport $doctorReport', '    $doctorOut = $null');
  assert.notEqual(removed, fixture);
  assert.throws(() => checkDoctorOutputWiring(removed), /U-130 Doctor must invoke renderer exactly once/);
  for (const prefix of ['$null = ', '$capture = ', '@(']) {
    const captured = fixture.replace('    Write-DoctorReportOutput -AsJson:', '    ' + prefix + 'Write-DoctorReportOutput -AsJson:');
    assert.notEqual(captured, fixture);
    assert.throws(() => checkDoctorOutputWiring(captured), /U-130 renderer call must be bare/);
  }
});

test('U-130 negative control: an ASCII console really folds Chinese to "?" (the emulation is effective)', async () => {
  const r = await runAny(ASCII + '"本地代码检索"');
  assert.equal(r.status, 0, r.stderr.slice(0, 300));
  assert.match(r.stdout, /\?{6}/, 'expected ?????? from ASCII console, got: ' + JSON.stringify(r.stdout.slice(0, 40)));
  assert.doesNotMatch(r.stdout, /本地代码检索/);
});

test('U-130: -AsJson pins the process stdout to UTF-8 so piped JSON keeps Chinese under an ASCII console', async () => {
  const r = await notTimedOut(await runAny(ASCII + `& '${MAIN.replace(/'/g, "''")}' -Doctor -AsJson -NoEnvFile`), 'U-130 -Doctor -AsJson');
  assert.equal(r.status, 0, 'doctor failed: ' + r.stderr.slice(0, 500));
  // Keep the original pipe bytes until strict UTF-8 decoding; replacement decoding masks U-150.
  const text = new TextDecoder('utf-8', { fatal: true }).decode(r.stdoutBytes);
  const json = text.slice(text.indexOf('{'));
  const obj = JSON.parse(json);
  assert.ok(obj.doctor, 'doctor payload missing');
  assert.match(json, /本地代码检索/, 'Chinese field lost under ASCII console: ' + JSON.stringify(json.slice(0, 120)));
  assert.doesNotMatch(json, /\?{5}/, 'found ????? in -AsJson output under ASCII console');
});

// U-150/U-130: real batch serializer -> raw pipe bytes -> strict UTF-8 -> strict JSON.
// This fixture uses only an OS-temp input and an injected offline runspace; no endpoint or .env read.
test('U-150: batch stdout round-trips quote, backslash, newline, U+E168 and CJK as strict UTF-8 JSON', async () => {
  const vector = 'quoted " slash \\ newline\n中文 日本語 \uE168 …';
  const temp = path.join(os.tmpdir(), `mcps-u150-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(temp, JSON.stringify([vector]), 'utf8');
  const script = `$ErrorActionPreference='Stop'; $env:MCPS_NO_MAIN='1'; . '${MAIN.replaceAll("'", "''")}' -NoEnvFile -AsJson;
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
$mock = @'
param($Q, $Take, $Script, $Site, $SkipEnv, $SkipCache, $SkipProxy)
[PSCustomObject]@{
 version='fixture'
 results=@([PSCustomObject]@{Name=$Q;Platform='Fixture';Url='https://fixture.invalid';Stars=1})
 coverage=[PSCustomObject]@{Requested=@('Fixture');Executed=@('Fixture');Blocked=@();Degraded=@();Reasons=[PSCustomObject]@{};ReasonCodes=[PSCustomObject]@{};Verdict='full'}
 metrics=[PSCustomObject]@{ResultCount=1}
 warnings=@($Q)
} | ConvertTo-Json -Depth 8 -Compress
'@
Invoke-ResearchBatch -InputPath '${temp.replaceAll("'", "''")}' -MainPath '${MAIN.replaceAll("'", "''")}' -RunnerText $mock -TaskNoEnvFile -AsJson -BatchBudgetSec 4`;
  try {
    const r = await runAny(script);
    assert.equal(r.status, 0, 'offline batch failed: ' + r.stderr.slice(0, 500));
    const text = new TextDecoder('utf-8', { fatal: true }).decode(r.stdoutBytes);
    const batch = JSON.parse(text); // no preamble or tolerant parser
    assert.equal(batch.queries.length, 1);
    assert.equal(batch.queries[0].results[0].Name, vector);
    assert.equal(batch.queries[0].warnings[0], vector);
    assert.deepEqual(Buffer.from(batch.queries[0].results[0].Name, 'utf8'), Buffer.from(vector, 'utf8'));
  } finally { fs.rmSync(temp, { force: true }); }
});

test('U-150 negative control: the historical GBK-misdecoded preview is rejected by strict JSON', () => {
  const damaged = '{"Preview":"nicer鈥?,\n"x":1}';
  assert.throws(() => JSON.parse(damaged), SyntaxError);
});

// U-142: an invalid machine-readable invocation must fail explicitly, not exit 0 with zero bytes.
test('U-142 positive control: the same CLI emits a usage banner without -AsJson', async () => {
  const r = await runAny(`& '${MAIN.replace(/'/g, "''")}' -NoEnvFile -NoProxyFix`);
  assert.equal(r.status, 0, r.stderr.slice(0, 300));
  assert.match(r.stdout, /Multi-Code-Platform Searcher/, 'stdout capture must be live');
});

test('U-142 negative: -AsJson without -Keyword returns nonzero with an explicit error', async () => {
  const r = await runAny(`& '${MAIN.replace(/'/g, "''")}' -NoEnvFile -NoProxyFix -AsJson`);
  assert.notEqual(r.status, 0, 'missing keyword silently returned rc=0');
  assert.match(r.stderr, /-Keyword/, 'stderr must identify the missing parameter');
});

test('U-142 negative: whitespace-only -Keyword with -AsJson also fails before searching', async () => {
  const r = await runAny(`& '${MAIN.replace(/'/g, "''")}' -NoEnvFile -NoProxyFix -AsJson -Keyword '   '`);
  assert.notEqual(r.status, 0, 'blank keyword silently started a search');
  assert.match(r.stderr, /-Keyword/);
});

test('U-142 existing invalid-argument binder rejects an unknown platform', async () => {
  const r = await runAny(`& '${MAIN.replace(/'/g, "''")}' -NoEnvFile -NoProxyFix -AsJson -Platform InvalidPlatform`);
  assert.notEqual(r.status, 0, 'ValidateSet error was swallowed');
  assert.match(r.stderr, /InvalidPlatform/);
});
