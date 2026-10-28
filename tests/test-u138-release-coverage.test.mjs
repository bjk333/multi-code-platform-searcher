// U-138（2026-09-29）：tests/ 发布覆盖门 —— tests/ 下每个文件要么在根清单 fileHashes、要么在 tests/release-exclude.txt（U-91 在 tests/ 的对应物）。
// 排除文件分两节：[exclude] 永久排除（生成物，如 test-results.log）；[pending-p1] 临时排除（等宿主按 U-138 P1「全量纳入」补清单后删除本节 ⇒ 只打印 WARN 计数，不判红）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mirrorPath = path.join(root, 'reports/_skill-assets.root.json');

export function readExclude(file) {
  const out = { exclude: new Set(), pending: new Set() }; let sec = null;
  if (!fs.existsSync(file)) return out;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim(); if (!line || line.startsWith('#')) continue;
    if (line === '[exclude]') { sec = 'exclude'; continue; } if (line === '[pending-p1]') { sec = 'pending'; continue; }
    if (sec) out[sec].add(line);
  }
  return out;
}
export function checkTestsCoverage(rootDir, opts = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, opts.manifest ?? 'reports/_skill-assets.root.json'), 'utf8').replace(/^\uFEFF/, ''));
  const keys = new Set(Object.keys(manifest.assets[0].fileHashes));
  const ex = readExclude(path.join(rootDir, opts.exclude ?? 'tests/release-exclude.txt'));
  // U-145（2026-09-29，rule 6：门不得污染它所量测的对象）：磁盘清单可注入 —— 负例用合成清单，不再往 tests/ 写文件
  const disk = opts.disk ?? fs.readdirSync(path.join(rootDir, 'tests')).filter(f => fs.statSync(path.join(rootDir, 'tests', f)).isFile()).sort();
  const res = { uncovered: [], pending: [], stale: [] };
  for (const f of disk) {
    const k = 'tests/' + f;
    if (keys.has(k)) { if (ex.exclude.has(f) || ex.pending.has(f)) res.stale.push(f); continue; }
    if (ex.exclude.has(f)) continue;
    if (ex.pending.has(f)) { res.pending.push(f); continue; }
    res.uncovered.push(f);
  }
  for (const f of [...ex.exclude, ...ex.pending]) if (!disk.includes(f)) res.stale.push(f);
  return res;
}
test('U-138: every tests/ file is in the root manifest or explicitly excluded; pending-p1 entries are only counted', () => {
  const r = checkTestsCoverage(root);
  console.error(`[U-138] tests/ uncovered=${r.uncovered.length} pending-p1=${r.pending.length} stale-exclude=${r.stale.length}`);
  assert.deepEqual(r.uncovered, [], 'tests/ files in neither manifest nor release-exclude: ' + r.uncovered.join(','));
  assert.deepEqual(r.stale, [], 'exclude rows that are already in manifest or no longer on disk: ' + r.stale.join(','));
});
test('U-138 negative control: a file present in neither list is reported by name (synthetic listing, nothing written to tests/)', () => {
  const real = fs.readdirSync(path.join(root, 'tests')).filter(f => fs.statSync(path.join(root, 'tests', f)).isFile()).sort();
  const r = checkTestsCoverage(root, { disk: [...real, 'zz-u138-negative.tmp'].sort() });
  assert.deepEqual(r.uncovered, ['zz-u138-negative.tmp']);
  assert.ok(!fs.existsSync(path.join(root, 'tests', 'zz-u138-negative.tmp')), 'negative control must not leave a file behind');
});
test('U-145 static: this gate never writes into tests/', () => {
  const self = fs.readFileSync(new URL(import.meta.url), 'utf8');
  assert.doesNotMatch(self, /writeFileSync\(path\.join\(root, 'tests'/);
});
test('U-138 static: the exclude file has both sections and every permanent exclusion carries a reason comment above it', () => {
  const src = fs.readFileSync(path.join(root, 'tests/release-exclude.txt'), 'utf8');
  assert.match(src, /^\[exclude\]$/m); assert.match(src, /^\[pending-p1\]$/m);
  const lines = src.split(/\r?\n/); let sec = null;
  lines.forEach((l, i) => {
    const t = l.trim(); if (t === '[exclude]') sec = 'ex'; else if (t === '[pending-p1]') sec = 'p';
    else if (sec === 'ex' && t && !t.startsWith('#')) assert.ok(/^#/.test((lines[i - 1] || '').trim()), t + ' needs a reason comment line above');
  });
});
// U-146: network-dependent PS groups must explicitly SKIP only when transport preflight is unavailable; reachable HTTP errors keep assertions active.
test('U-146: network groups report explicit unavailable reason and retain the online TEST_FAIL path', () => {
  const harness = fs.readFileSync(path.join(root, 'tests/run-tests.ps1'), 'utf8');
  assert.match(harness, /function t_NetworkPreflight[\s\S]*Invoke-ApiRequest -Uri \$u146Uri -TimeoutSec 6 -MaxAttempts 1/);
  assert.match(harness, /\[network-preflight\] Available=\{0\} Reason=\{1\}/);
  for (const group of ['test-contract', 'test-sorting']) {
    const i = harness.indexOf(`# ---------- ${group === 'test-contract' ? '3' : '4'}) ${group}`);
    assert.ok(i >= 0, group + ' section missing');
    const block = harness.slice(i, harness.indexOf('\n# ----------', i + 5));
    assert.match(block, /elseif \(-not \$t_networkProbe\.Available\) \{ \$lines\.Add\("\[test-[^"]+\] TEST_SKIP \(network unavailable; \$\(\$t_networkProbe\.Reason\)\)"\); \$skipC\+\+ \}/);
    assert.match(block, /else \{\r?\n\$t_ok = \$true/);
    assert.match(block, /TEST_FAIL:/, group + ' must still red on real online assertion failure');
  }
});
test('U-146 negative control: removing the offline skip is detected by the guard', () => {
  const harness = fs.readFileSync(path.join(root, 'tests/run-tests.ps1'), 'utf8');
  const mutant = harness.replaceAll(/elseif \(-not \$t_networkProbe\.Available\) \{[^\n]+\}/g, '');
  assert.notEqual(mutant, harness);
  assert.equal((mutant.match(/elseif \(-not \$t_networkProbe\.Available\)/g) || []).length, 0);
  assert.equal((harness.match(/elseif \(-not \$t_networkProbe\.Available\)/g) || []).length, 2);
});

// U-139 (2026-09-29): all nonempty host-mirror hashes must match current bytes; empty template values are not hashes.
const U139_SELF_PATH = 'scripts/skill-assets.example.json';
function u139ReadPackageBytes(rel) {
  const abs = path.resolve(root, rel);
  const fromRoot = path.relative(root, abs);
  if (path.isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith('..' + path.sep)) return null;
  try { return fs.readFileSync(abs); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
function u139HashAudit(fileHashes, readBytes = u139ReadPackageBytes) {
  const findings = [];
  for (const [rel, expected] of Object.entries(fileHashes)) {
    if (expected === '') continue; // template placeholders are explicitly not checksums
    if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/i.test(expected)) {
      findings.push({ path: rel, reason: 'invalid-hash' }); continue;
    }
    const bytes = readBytes(rel);
    if (bytes === null || bytes === undefined) { findings.push({ path: rel, reason: 'missing' }); continue; }
    const actual = crypto.createHash('sha256').update(bytes).digest('hex');
    if (actual.toLowerCase() !== expected.toLowerCase()) findings.push({ path: rel, reason: 'mismatch' });
  }
  return findings;
}
function u139AssertExampleSelfRule(fileHashes) {
  assert.ok(Object.hasOwn(fileHashes, U139_SELF_PATH), 'the example manifest must list its own file path');
  assert.equal(fileHashes[U139_SELF_PATH], '', 'the example self-entry is a path placeholder, never a recursive hash');
}
test('U-139: every nonempty host-mirror SHA-256 matches current bytes; baseline is zero and one-byte mutation is detected exactly once', () => {
  // In an MCP-restricted session fail before fs.readFileSync ONLY if a shielded path
  // actually carries a nonempty hash; host cleared .env.example to a blank placeholder.
  const mirror = JSON.parse(fs.readFileSync(mirrorPath, 'utf8')).assets[0];
  if (process.env.MCPS_MCP_RESTRICTED === '1') {
    const shielded = Object.entries(mirror.fileHashes).filter(([rel, hash]) => hash !== '' &&
      /(^\.env|\.pem$|\.key$|code-no-token\.json$)/i.test(rel)).map(([rel]) => rel);
    assert.deepEqual(shielded, [], 'U-139 blocked: a nonempty MCP-shielded hash requires host-owned verification (no bypass)');
  }
  const example = JSON.parse(fs.readFileSync(path.join(root, 'scripts/skill-assets.example.json'), 'utf8')).assets[0];
  const nonempty = Object.entries(mirror.fileHashes).filter(([, h]) => h !== '');
  assert.ok(nonempty.length > 0, 'the ruler needs at least one nonempty hash to validate');
  assert.deepEqual(u139HashAudit(mirror.fileHashes), [], 'prechange hash baseline must be 0 drift/missing');
  u139AssertExampleSelfRule(example.fileHashes);
  // Positive control: mutate one file buffer in memory, keep its manifest hash unchanged; never write to disk/tests/.
  const [controlPath] = nonempty[0];
  const original = u139ReadPackageBytes(controlPath);
  assert.ok(original && original.length > 0, `positive-control file must be readable: ${controlPath}`);
  const changed = Buffer.from(original); changed[0] ^= 0xff;
  const positive = u139HashAudit(mirror.fileHashes, rel => rel === controlPath ? changed : u139ReadPackageBytes(rel));
  assert.deepEqual(positive, [{ path: controlPath, reason: 'mismatch' }], 'one changed file with an unchanged manifest must yield exactly one hit');
});
test('U-139 self-reference negative control: a nonempty self-hash in the template is rejected, while the external mirror checksum remains verified', () => {
  const example = JSON.parse(fs.readFileSync(path.join(root, 'scripts/skill-assets.example.json'), 'utf8')).assets[0];
  const mirror = JSON.parse(fs.readFileSync(mirrorPath, 'utf8')).assets[0];
  u139AssertExampleSelfRule(example.fileHashes);
  const mutant = structuredClone(example.fileHashes); mutant[U139_SELF_PATH] = 'a'.repeat(64);
  assert.throws(() => u139AssertExampleSelfRule(mutant), assert.AssertionError);
  assert.ok(mirror.fileHashes[U139_SELF_PATH], 'mirror stores the example checksum outside the example file');
  assert.equal(u139HashAudit({ [U139_SELF_PATH]: mirror.fileHashes[U139_SELF_PATH] }).length, 0, 'the mirror self-path hash is checked against the current example bytes');
});

// U-139 ledger follow-up: root mirror version and deploymentCopies semantics.
const U139_SCRIPT_PATH = 'multi-platform-searcher.ps1';
function u139ScriptVersion() {
  const source = fs.readFileSync(path.join(root, U139_SCRIPT_PATH), 'utf8');
  const match = source.match(/^\$VERSION\s*=\s*['"]([^'"]+)['"]/m);
  assert.ok(match, 'main script must expose a literal $VERSION');
  return match[1];
}
function u139AssertVersion(manifestVersion, scriptVersion) {
  assert.equal(manifestVersion, scriptVersion, `host root version ${manifestVersion} must match script $VERSION ${scriptVersion}`);
}
function u139AssertImplicitDeployment(asset, comment, publisher) {
  assert.equal(Object.hasOwn(asset, 'deploymentCopies'), false, 'user-level host-loaded copy is implicit; remove deploymentCopies from the manifest, do not leave []');
  assert.ok(comment.includes('默认追加为发布目标') && comment.includes('无需写进 deploymentCopies'), 'manifest must explain that the host-loaded copy is auto-added and not registered');
  assert.ok(publisher.includes('$targets += Join-Path $env:USERPROFILE'), 'publisher must auto-append the user-level host target');
  assert.ok(publisher.includes('.workbuddy\\skills\\$AssetName'), 'publisher must point at the actual user-level skills path');
}
test('U-139 root version: host mirror and example equal the script $VERSION', () => {
  const mirrorDoc = JSON.parse(fs.readFileSync(mirrorPath, 'utf8'));
  const exampleDoc = JSON.parse(fs.readFileSync(path.join(root, 'scripts/skill-assets.example.json'), 'utf8'));
  const version = u139ScriptVersion();
  u139AssertVersion(mirrorDoc.assets[0].version, version);
  u139AssertVersion(exampleDoc.assets[0].version, version);
});
test('U-139 root version negative control: stale version is detected by the same guard', () => {
  const version = u139ScriptVersion();
  const mutant = version === '1.37.8' ? '1.37.7' : '1.37.8';
  assert.throws(() => u139AssertVersion(mutant, version), assert.AssertionError);
});
test('U-139 deploymentCopies: omit the field for the implicit host-loaded target and document publisher behavior', () => {
  const mirrorDoc = JSON.parse(fs.readFileSync(mirrorPath, 'utf8'));
  const exampleDoc = JSON.parse(fs.readFileSync(path.join(root, 'scripts/skill-assets.example.json'), 'utf8'));
  const publisher = fs.readFileSync(path.join(root, 'scripts/publish-skill.ps1'), 'utf8');
  const comment = `${mirrorDoc._comment || ''}\n${exampleDoc._comment || ''}`;
  u139AssertImplicitDeployment(mirrorDoc.assets[0], comment, publisher);
  u139AssertImplicitDeployment(exampleDoc.assets[0], comment, publisher);
});
test('U-139 deploymentCopies positive/negative control: omitted field with documented publisher passes; empty array is rejected', () => {
  const mirrorDoc = JSON.parse(fs.readFileSync(mirrorPath, 'utf8'));
  const publisher = fs.readFileSync(path.join(root, 'scripts/publish-skill.ps1'), 'utf8');
  const comment = String(mirrorDoc._comment || '');
  const omitted = structuredClone(mirrorDoc.assets[0]); delete omitted.deploymentCopies;
  assert.doesNotThrow(() => u139AssertImplicitDeployment(omitted, comment, publisher));
  const mutant = { ...omitted, deploymentCopies: [] };
  assert.throws(() => u139AssertImplicitDeployment(mutant, comment, publisher), assert.AssertionError);
});
