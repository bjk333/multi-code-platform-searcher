// N-9 offline gate: real Node process + static verification of the 12e test harness.
// PowerShell execution (PS7 and PS5.1) remains a separate host acceptance gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'tests/run-tests.ps1'), 'utf8');
const start = source.indexOf('    # 12e)');
const end = source.indexOf('} catch { $t_ok', start);
assert.ok(start > 0 && end > start, 'cannot locate the real 12e block');
const check = source.slice(start, end);

// U-76（Wave C，2026-09-26）：把 12e 接线断言收成函数，供下方"破坏必红"负例复用（同一断言集，不是另写一套）。
function assertHarnessWiring(code) {
  assert.doesNotMatch(code, /\$PSVersionTable\.PSEdition\s+-ne\s+['"]Core['"]/);
  assert.match(code, /fake-node\.mjs/);
  assert.match(code, /Get-Command node -CommandType Application/);
  assert.match(code, /\$script:NodeExePath\s*=\s*\$t_nodeExe/);
  assert.match(code, /\$script:NodeEnginePath\s*=\s*\$t_stub/);
  assert.match(code, /MCPS_T12E_ARGV_FILE/);
  assert.match(code, /-d 25000/);
  assert.match(code, /-d 5000/);
}
const NET_CALL = /(?:https?|net)\.(?:get|request|createConnection)\s*\(/;
function mutate(text, from, to) {
  const out = text.split(from).join(to);
  assert.notEqual(out, text, `negative control must actually mutate: ${from}`);
  return out;
}

test('12e no longer skips PowerShell Core and invokes a real Node executable', () => {
  assertHarnessWiring(check);
});

test('U-76 negative control: re-adding the PSEdition skip, dropping fake-node.mjs or shrinking -d 25000 is detected', () => {
  const skipped = "if ($PSVersionTable.PSEdition -ne 'Core') { $t_skip = $true }\n" + check;
  assert.throws(() => assertHarnessWiring(skipped), assert.AssertionError);
  assert.throws(() => assertHarnessWiring(mutate(check, 'fake-node.mjs', 'fake-node.cmd')), assert.AssertionError);
  assert.throws(() => assertHarnessWiring(mutate(check, '-d 25000', '-d 250')), assert.AssertionError);
  assert.throws(() => assertHarnessWiring(mutate(check, 'MCPS_T12E_ARGV_FILE', 'MCPS_ARGV')), assert.AssertionError);
});

test('inline fake-node.mjs records actual Node argv and never opens a network connection', async () => {
  const match = check.match(/\$t_stubSource\s*=\s*@'\r?\n([\s\S]*?)\r?\n'@/);
  assert.ok(match, '12e must build a JavaScript stub, not an unexecutable Linux .cmd');
  const source = match[1];
  assert.doesNotMatch(source, NET_CALL);
  const tmp = fs.mkdtempSync(path.join(root, '_verify', 'n9-'));
  try {
    const program = path.join(tmp, 'fake-node.mjs');
    const captured = path.join(tmp, 'argv.txt');
    fs.writeFileSync(program, source, 'utf8');
    // N-11: async spawn avoids host WorkBuddy's NODE_OPTIONS shim blocking spawnSync (EBUSY).
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--use-system-ca', program,
        '-o', path.join(tmp, 'out.json'), '-d', '5000',
        'http://127.0.0.1:1/mcps-t12e', 'User-Agent:t12e'],
        { env: { ...process.env, MCPS_T12E_ARGV_FILE: captured } });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', (status, signal) => {
        clearTimeout(timer);
        resolve({ status, signal, stdout, stderr });
      });
    });
    assert.equal(result.status, 0, result.stderr || `node child ended with ${result.signal}`);
    assert.match(result.stdout, /^STATUS 200\s*$/m);
    const args = fs.readFileSync(captured, 'utf8');
    assert.match(args, /(^|\s)-d 5000(\s|$)/);
    assert.match(args, /mcps-t12e/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('U-76 negative control: a stub that opens the network, is not a here-string, or stops recording argv / STATUS 200 is detected', async () => {
  const match = check.match(/\$t_stubSource\s*=\s*@'\r?\n([\s\S]*?)\r?\n'@/);
  assert.ok(match);
  const source = match[1];
  // (1) 静态：任何 http/https/net 出网调用都会被 NET_CALL 逮住（三种写法各试一次）。
  for (const call of ["http.get('http://127.0.0.1:1/x');", "https.request({ host: 'api.github.com' });", "net.createConnection(443, 'x');"]) {
    assert.match(source + '\n' + call, NET_CALL);
  }
  // (2) 静态：把 here-string 换成 .cmd 一行式 ⇒ 匹配器拿不到可执行 JS。
  const noHereString = mutate(check, "$t_stubSource = @'", "$t_stubSource = '@echo STATUS 200'   # @'");
  assert.equal(noHereString.match(/\$t_stubSource\s*=\s*@'\r?\n([\s\S]*?)\r?\n'@/), null);
  // (3) 运行时：删掉 argv 落盘、把 STATUS 200 改成 500 ⇒ 正例的两条运行时断言都会失败。
  const broken = mutate(mutate(source, "console.log('STATUS 200');", "console.log('STATUS 500');"), 'writeFileSync(target,', '// writeFileSync(target,');
  const tmp = fs.mkdtempSync(path.join(root, '_verify', 'n9neg-'));
  try {
    const program = path.join(tmp, 'fake-node.mjs');
    const captured = path.join(tmp, 'argv.txt');
    fs.writeFileSync(program, broken, 'utf8');
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [program, '-d', '5000', 'http://127.0.0.1:1/mcps-t12e'],
        { env: { ...process.env, MCPS_T12E_ARGV_FILE: captured } });
      let stdout = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', status => { clearTimeout(timer); resolve({ status, stdout }); });
    });
    assert.doesNotMatch(result.stdout, /^STATUS 200\s*$/m);
    assert.equal(fs.existsSync(captured), false, 'broken stub must not record argv, otherwise the positive assertion is vacuous');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
