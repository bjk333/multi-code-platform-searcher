// U-155/U-156 B-line regression gate: static mutations + host-only offline PS 5.1/7 vectors.
// The agent must NOT run this gate; the host runs it with the rest of the bline tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sourceAll } from './lib/source.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = sourceAll(path.join(root));
const schema = JSON.parse(fs.readFileSync(path.join(root, 'schema/asjson.schema.json'), 'utf8'));
const harness = path.join(root, 'tests/u155-network-route-harness.ps1');

function contract(main, spec) {
  assert.match(main, /\[string\]\$ProxyMode\s*=\s*"auto"/, 'B1 CLI default auto');
  assert.match(main, /function Get-NetworkCandidates\s*\{/);
  assert.match(main, /function Get-NetworkRoute\s*\{/);
  assert.match(main, /Get-NetworkRoute -Uri \$Uri -NoProxy:\$NoProxy/, 'real HTTP path must select route');
  assert.match(main, /GetSystemWebProxy\(\)/, 'auto still tries system proxy');
  assert.match(main, /Test-NetworkNoProxy -Target \$Target/, 'NO_PROXY must change real routing');
  assert.match(main, /Get-NetworkCandidates -Target \$target -ForceDirect:\$NoProxy/, 'candidate set must use actual request target');
  assert.match(main, /Invoke-NetworkProbeOnce -Target \$target -Route \$candidate -Method HEAD/);
  assert.match(main, /Invoke-NetworkProbeOnce -Target \$target -Route \$candidate -Method GET/);
  assert.match(main, /if \(\$_\.Exception\.Response\).*return 'reachable'/, '4xx/5xx are HTTP responses, not unreachable');
  assert.match(main, /'unknown' # 超时、TLS\/CA/, 'ambiguous transport must not be skipped');
  assert.doesNotMatch(main, /SetEnvironmentVariable\(\$v,\s*\$null\)/, 'dead localhost proxy heuristic must be gone');
  assert.match(main, /'network_unavailable'\s*\{\s*'network-unavailable'\s*\}/, 'source machine code');
  assert.match(main, /'auth_missing', 'tool_missing', 'network_unavailable'/, 'skip enters Blocked, not trustworthy zero-hit');
  assert.match(main, /'_networkRoutes'.*'_networkFailures'.*'_networkHttpResponses'/, 'main runspace injection');
  // U-167（2026-10-04）：GitLab 嵌套池宿主从 `engines/gitlab-blobs.ps1` **搬到了主脚本**
  //   （`Needs` 里列的函数必须在主脚本里有实现，见 U-157 C）。⇒ 判据改**定位**、不改意图，
  //   且比原来更严：把断言钉在**池宿主函数自己的函数体**里（原来只查"这个文件里有这几个字段"——
  //   字段出现在文件里别处也能过；现在必须与 `Get-HttpLayerClosure` 派生在**同一个函数**里）。
  const allSrc = source + '\n' + fs.readdirSync(path.join(root, 'engines'))
    .filter(f => f.endsWith('.ps1')).map(f => fs.readFileSync(path.join(root, 'engines', f), 'utf8')).join('\n');
  const fnBodies = [...allSrc.matchAll(/function\s+([A-Za-z][\w-]+)\s*\{([\s\S]*?)\n\}/g)];
  const hosts = fnBodies.filter(m => /foreach \(\$fn in \(Get-HttpLayerClosure\)\)/.test(m[2]));
  assert.ok(hosts.length > 0, '必须存在从 Get-HttpLayerClosure 派生的嵌套池宿主函数');
  for (const field of ['_networkRoutes', '_networkFailures', '_networkHttpResponses', '_networkEngine'])
    assert.ok(hosts.some(h => new RegExp(field + '\\s*=').test(h[2])),
      '★嵌套池宿主函数体内缺 ' + field + '（宿主: ' + hosts.map(h => h[1]).join('/') + '）');
  const codes = spec.properties.coverage.properties.ReasonCodes.additionalProperties.enum;
  const item = spec.$defs.researchBatch.properties.queries.items.properties;
  assert.ok(codes.includes('network-unavailable') && item.reasonCode.enum.includes('network-unavailable') &&
    item.ReasonCodes.additionalProperties.enum.includes('network-unavailable'), 'schema/default+batch new code');
}

test('U-155/U-156: router, API status, schema, main+nested runspaces stay connected', () => {
  contract(source, schema);
  assert.ok(fs.existsSync(harness));
});

test('U-155 negative controls: localhost purge, missing HEAD/GET, and HTTP 5xx misclassification fail', () => {
  const purge = source.replace('if ($NoProxyFix) { return }', 'if ($NoProxyFix) { [Environment]::SetEnvironmentVariable($v, $null); return }');
  assert.notEqual(purge, source);
  assert.throws(() => contract(purge, schema), /localhost/);
  const noGet = source.replace('Invoke-NetworkProbeOnce -Target $target -Route $candidate -Method GET', '$get = "unreachable"');
  assert.notEqual(noGet, source);
  assert.throws(() => contract(noGet, schema), /Method GET/);
  const noHttpError = source.replace("if ($_.Exception.Response) { try { $_.Exception.Response.Close() } catch { }; return 'reachable' }", "if ($_.Exception.Response) { return 'unreachable' }");
  assert.notEqual(noHttpError, source);
  assert.throws(() => contract(noHttpError, schema), /HTTP responses/);
  const bad = structuredClone(schema);
  bad.properties.coverage.properties.ReasonCodes.additionalProperties.enum = bad.properties.coverage.properties.ReasonCodes.additionalProperties.enum.filter(c => c !== 'network-unavailable');
  assert.throws(() => contract(source, bad), /schema/);
});

function ps(bin) {
  return new Promise(resolve => {
    const child = spawn(bin, ['-NoProfile', '-NonInteractive', '-File', harness], {
      cwd: root, windowsHide: true, env: { ...process.env, MCPS_NO_MAIN: '1' }, stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '', err = '', done = false;
    child.stdout.on('data', x => { out += x.toString('utf8'); });
    child.stderr.on('data', x => { err += x.toString('utf8'); });
    child.on('error', e => { if (!done) { done = true; resolve({ unavailable: e.code === 'ENOENT', code: null, out, err: e.message }); } });
    child.on('close', code => { if (!done) { done = true; resolve({ unavailable: false, code, out, err }); } });
  });
}
for (const runtime of ['pwsh', 'powershell.exe']) {
  test(`U-155/U-156: ${runtime} offline route vectors (host runs, no external network)`, async t => {
    const r = await ps(runtime);
    if (r.unavailable) { t.skip(runtime + ' not installed on this host'); return; }
    assert.equal(r.code, 0, `${runtime} exit=${r.code}\n${r.out}\n${r.err}`);
    assert.match(r.out, /\[U-155\/U-156\] offline route vectors PASS/);
  });
}
