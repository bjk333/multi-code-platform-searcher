// T1-2: offline Doctor wiring guard; run-tests.ps1 12h exercises the classifier on both whitelist sides.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sourceAll } from './lib/source.mjs';
const root = path.resolve(import.meta.dirname, '..');
const main = sourceAll(path.join(root));
const harness = fs.readFileSync(path.join(root, 'tests/run-tests.ps1'), 'utf8');

function doctorSection(src, name) {
  const marker = `function ${name} {`;
  const at = src.indexOf(marker);
  assert.ok(at >= 0, 'T1-2 D1 function missing: ' + name);
  const tail = src.slice(at);
  const next = /^function [A-Za-z][\w-]* \{/gm;
  next.lastIndex = marker.length;
  return tail.slice(0, next.exec(tail)?.index ?? tail.length);
}
function checkProxyWiring(src) {
  const publicDoctor = doctorSection(src, 'Invoke-DoctorReport');
  const split = src.includes('function Get-DoctorRemoteCodeHealth {');
  const probe = split ? doctorSection(src, 'Get-DoctorRemoteCodeHealth') : publicDoctor;
  if (split) {
    assert.match(publicDoctor, /\$codeHealth = Get-DoctorRemoteCodeHealth -VERSION \$VERSION -ghTok \$ghTok -glTok \$glTok/, 'T1-2 Doctor must call remote health helper');
    assert.match(publicDoctor, /\$proxyConsistency = @\(\$codeHealth\.ProxyConsistency\)/, 'T1-2 Doctor must use returned advice');
  }
  assert.match(src, /function Get-DoctorProxyAdvice \{/);
  // 域匹配（含子域后缀）已随白名单解析一起进 Get-McpsProxySpec（U-207），此处只钉"它还在"。
  assert.match(src, /\$HostName -eq \$_ -or \$HostName -like "\*\.\$_"/);
  assert.match(publicDoctor, /\$doctorReport\['proxyConsistency'\] = @\(\$proxyConsistency\)/, 'T1-2 Doctor must publish advice');
  assert.match(probe, /Get-DoctorProxyAdvice -Domain 'gitlab.com'/, 'T1-2 executed remote path must ask for GitLab advice');
  // U-207（2026-10-21）：白名单解析已抽成**单源** Get-McpsProxySpec（此前 Doctor 与真实选路各写一份，
  //   正是 T1-2 要防的"同一域名两个结论"）。判据随之改成：解析只许一处、且两个消费方都必须调它。
  const specFn = doctorSection(src, 'Get-McpsProxySpec');
  assert.match(specFn, /\$_\.Trim\(\)/, 'whitelist hosts must be trimmed (single source)');
  assert.match(specFn, /\$HostName -eq \$_ -or \$HostName -like "\*\.\$_"/, 'suffix match must stay in the single source');
  assert.match(specFn, /\$raw\.Contains\(';'\)/, 'whitelist detection must stay in the single source');
  const hostParses = [...src.matchAll(/\$matches\[1\] -split ','/g)];
  assert.equal(hostParses.length, 1, '★ 白名单逗号切分只允许一处（抽单源后又有第二份 ⇒ 两边会漂）');
  assert.match(src, /Get-McpsProxySpec -HostName \(\[string\]\$Target\.Host\)/, '★ 真实选路必须复用单源解析');
  assert.match(doctorSection(src, 'Get-DoctorProxyAdvice'), /Get-McpsProxySpec -HostName \$Domain -ProxySpec \$ProxySpec/, '★ Doctor 建议必须复用单源解析');
}
test('Doctor only advises adding unreachable hosts missing from a restricted proxy whitelist', () => {
  checkProxyWiring(main);
  assert.match(harness, /T1-2 outside whitelist/);
  assert.match(harness, /T1-2 inside whitelist/);
});

test('T1-2 D1 pre-move synthetic control: advice helper is used, lost call/advice/routing fails', () => {
  const fixture = [
    'function Get-McpsProxySpec {',
    '    $matched = @($hosts | Where-Object { $HostName -eq $_ -or $HostName -like "*.$_" })',
    "    $hasWhitelist = $raw.Contains(';')",
    "    $hosts = @($matches[1] -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })",
    '}',
    'function Get-NetworkCandidates {',
    '    $ms = Get-McpsProxySpec -HostName ([string]$Target.Host)',
    '}',
    'function Get-DoctorProxyAdvice {',
    '    $sp = Get-McpsProxySpec -HostName $Domain -ProxySpec $ProxySpec',
    '}',
    'function Get-DoctorRemoteCodeHealth {',
    "    Get-DoctorProxyAdvice -Domain 'gitlab.com' -Reachable:$false -Note ''",
    '}',
    'function Invoke-DoctorReport {',
    '    $codeHealth = Get-DoctorRemoteCodeHealth -VERSION $VERSION -ghTok $ghTok -glTok $glTok',
    '    $proxyConsistency = @($codeHealth.ProxyConsistency)',
    "    $doctorReport['proxyConsistency'] = @($proxyConsistency)",
    '}'
  ].join('\n');
  assert.doesNotThrow(() => checkProxyWiring(fixture), 'positive proxy split fixture must pass');
  const uncalled = fixture.replace('$codeHealth = Get-DoctorRemoteCodeHealth -VERSION $VERSION -ghTok $ghTok -glTok $glTok', '$codeHealth = $null');
  assert.notEqual(uncalled, fixture);
  assert.throws(() => checkProxyWiring(uncalled), /T1-2 Doctor must call remote health helper/);
  const noAdvice = fixture.replace("Get-DoctorProxyAdvice -Domain 'gitlab.com'", "Get-DoctorProxyAdvice -Domain 'nothing.invalid'");
  assert.notEqual(noAdvice, fixture);
  assert.throws(() => checkProxyWiring(noAdvice), /T1-2 executed remote path must ask for GitLab advice/);
  const noTrim = fixture.replace('ForEach-Object { $_.Trim() }', 'ForEach-Object { $_ }');
  assert.notEqual(noTrim, fixture);
  assert.throws(() => checkProxyWiring(noTrim), /whitelist hosts must be trimmed/);
});

// U-76 (2026-09-26): negative control — the whitelist-host trim must be the same in real routing and Doctor advice.
test('U-76 negative controls: untrimmed routing or an uncalled Doctor helper are detected', () => {
  assert.doesNotThrow(() => checkProxyWiring(main), 'positive proxy wiring must pass before mutation');
  const reverted = main.replace('ForEach-Object { $_.Trim() } | Where-Object { $_ }) }', 'ForEach-Object { $_ } | Where-Object { $_ }) }');
  assert.notEqual(reverted, main, 'the mutation must hit the whitelist parse in Get-McpsProxySpec');
  assert.throws(() => checkProxyWiring(reverted), /whitelist hosts must be trimmed/);
  // 去掉 Doctor 对单源的复用（退回自己解析）必须被抓到
  const noReuse = main.replace('$sp = Get-McpsProxySpec -HostName $Domain -ProxySpec $ProxySpec', '$sp = $null');
  assert.notEqual(noReuse, main);
  assert.throws(() => checkProxyWiring(noReuse), /Doctor 建议必须复用单源解析/);
  if (main.includes('function Get-DoctorRemoteCodeHealth {')) {
    const uncalled = main.replace('$codeHealth = Get-DoctorRemoteCodeHealth -VERSION $VERSION -ghTok $ghTok -glTok $glTok', '$codeHealth = $null');
    assert.notEqual(uncalled, main);
    assert.throws(() => checkProxyWiring(uncalled), /T1-2 Doctor must call remote health helper/);
  }
});
