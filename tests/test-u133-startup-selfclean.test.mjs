// U-133（2026-09-29）：门临时目录「启动自清」—— 静态钉参数 + 行为 P2/P3/P4（在系统临时沙盒里模拟 _verify，不碰仓内 _verify）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearStaleGateTemp, U133_TEMP_DIR, U133_MIN_AGE_MS, U133_KEEP } from './run-node-gates.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const launcher = fs.readFileSync(path.join(root, 'tests/run-node-gates.mjs'), 'utf8');
const harness = fs.readFileSync(path.join(root, 'tests/run-tests.ps1'), 'utf8');

test('U-133 static: both runtimes pin the whitelist shape, the 10-minute age floor, the keep-list and the WhatIf switch', () => {
  assert.equal(U133_TEMP_DIR.source, '^(n9|n9neg|r2|r2neg)-[A-Za-z0-9]{6}$');
  assert.equal(U133_MIN_AGE_MS, 600000);
  assert.deepEqual(U133_KEEP, ['r2', 'u119', 'u120', 'u134-specimen']);
  assert.match(launcher, /clearStaleGateTemp\(root, \{ whatIf: process\.env\.U133_WHATIF === '1' \}\)/);
  assert.match(launcher, /const TEMP_PREFIX = \/\^\(n9\|n9neg\|r2\|r2neg\|u58\)-\//, 'U-81 detection must stay');
  assert.match(harness, /-notmatch '\^\(n9\|n9neg\|r2\|r2neg\)-\[A-Za-z0-9\]\{6\}\$'/);
  assert.match(harness, /\.TotalMinutes -lt 10\) \{ continue \}/);
  assert.match(harness, /\$u133Keep = @\('r2', 'u119', 'u120', 'u134-specimen'\)/);
  assert.match(harness, /Clear-StaleGateTemp -RepoRoot \(Split-Path -Parent \$mainScript\) -WhatIfOnly:\(\$env:U133_WHATIF -eq '1'\)/);
  assert.match(harness, /U-81 _verify\/ 有未自清的门临时目录/, 'U-81 detection must stay');
  const idx = harness.indexOf('Clear-StaleGateTemp -RepoRoot'); const u81 = harness.indexOf('U-81 _verify/ 有未自清');
  assert.ok(idx > 0 && idx < u81, 'self-clean must run before the U-81 check');
});

function sandbox() {
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'u133-')); fs.mkdirSync(path.join(sb, '_verify'));
  return sb;
}
const old = new Date(Date.now() - 3600 * 1000);
function mk(sb, name, { stale = true, file = false } = {}) {
  const p = path.join(sb, '_verify', name);
  if (file) fs.writeFileSync(p, 'x'); else { fs.mkdirSync(p, { recursive: true }); fs.writeFileSync(path.join(p, 'a.txt'), 'x'); }
  if (stale) fs.utimesSync(p, old, old);
  return p;
}
test('U-133 P2: stale whitelisted dirs are removed and logged one line each', () => {
  const sb = sandbox(); const logs = [];
  try {
    mk(sb, 'n9-ABCDEF'); mk(sb, 'r2neg-XYZ123'); mk(sb, 'n9neg-a1b2c3'); mk(sb, 'r2-000000');
    const removed = clearStaleGateTemp(sb, { log: m => logs.push(m) });
    assert.deepEqual(removed.sort(), ['n9-ABCDEF', 'n9neg-a1b2c3', 'r2-000000', 'r2neg-XYZ123']);
    assert.deepEqual(logs.filter(l => l.startsWith('[U-133] 启动自清: ')).length, 4);
    assert.deepEqual(fs.readdirSync(path.join(sb, '_verify')), []);
  } finally { fs.rmSync(sb, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
test('U-133 P3 negative: a fresh whitelisted dir is NOT cleaned, so the U-81 residue check would still fire', () => {
  const sb = sandbox();
  try {
    mk(sb, 'n9-FRESH1', { stale: false });
    const removed = clearStaleGateTemp(sb, { log: () => {} });
    assert.deepEqual(removed, []);
    assert.ok(fs.existsSync(path.join(sb, '_verify', 'n9-FRESH1')));
    // same predicate U-81 uses in the launcher
    const TEMP_PREFIX = /^(n9|n9neg|r2|r2neg|u58)-/;
    assert.ok(fs.readdirSync(path.join(sb, '_verify')).some(n => TEMP_PREFIX.test(n)), 'U-81 must still see it');
  } finally { fs.rmSync(sb, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
test('U-133 P4 safety: keep-list, non-whitelisted names, nested dirs inside evidence dirs, and files are never touched', () => {
  const sb = sandbox();
  try {
    mk(sb, 'r2'); mk(sb, 'u119'); mk(sb, 'u120'); mk(sb, 'u134-specimen'); mk(sb, 'evidence-keep');
    mk(sb, 'n9-TOOLONG7'); mk(sb, 'n9-sh0rt'); mk(sb, 'u58-synthetic.tmp'); mk(sb, 'n9-FILE01', { file: true });
    mk(sb, path.join('r2', 'n9-FAKE00'));
    const removed = clearStaleGateTemp(sb, { log: () => {} });
    assert.deepEqual(removed, []);
    for (const n of ['r2', 'u119', 'u120', 'u134-specimen', 'evidence-keep', 'n9-TOOLONG7', 'n9-sh0rt', 'u58-synthetic.tmp', 'n9-FILE01', path.join('r2', 'n9-FAKE00')])
      assert.ok(fs.existsSync(path.join(sb, '_verify', n)), n + ' must survive');
  } finally { fs.rmSync(sb, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
test('U-133 WhatIf: preview logs "预演(不删)" and removes nothing', () => {
  const sb = sandbox(); const logs = [];
  try {
    mk(sb, 'n9-ABCDEF');
    const removed = clearStaleGateTemp(sb, { whatIf: true, log: m => logs.push(m) });
    assert.deepEqual(removed, []);
    assert.deepEqual(logs, ['[U-133] 预演(不删): n9-ABCDEF']);
    assert.ok(fs.existsSync(path.join(sb, '_verify', 'n9-ABCDEF')));
  } finally { fs.rmSync(sb, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
