// R-3: offline wiring guards; PowerShell behavioral fixtures live in run-tests.ps1 12g.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sourceAll } from './lib/source.mjs';

const root = path.resolve(import.meta.dirname, '..');
const source = sourceAll(path.join(root));
const harness = fs.readFileSync(path.join(root, 'tests/run-tests.ps1'), 'utf8');
// D1 gate-follow: read only the function that the public Doctor actually calls.
// Pre-split source keeps the original narrow inline region; once the helper exists,
// the caller must bind it and the old inline text cannot make an unused helper pass.
function d1Section(src, name) {
  const mark = `function ${name} {`;
  const at = src.indexOf(mark);
  if (at < 0) throw new Error('R-3 D1 function missing: ' + name);
  const tail = src.slice(at);
  const next = /^function [A-Za-z][\w-]* \{/gm;
  next.lastIndex = mark.length;
  return tail.slice(0, next.exec(tail)?.index ?? tail.length);
}
function remoteProbeBlock(src) {
  if (src.includes('function Get-DoctorRemoteCodeHealth {')) {
    const caller = d1Section(src, 'Invoke-DoctorReport');
    if (!caller.includes('$codeHealth = Get-DoctorRemoteCodeHealth -VERSION $VERSION -ghTok $ghTok -glTok $glTok'))
      throw new Error('R-3 Doctor must call Get-DoctorRemoteCodeHealth');
    if (!caller.includes('$remoteEngines = @($codeHealth.RemoteEngines)'))
      throw new Error('R-3 Doctor must use returned remoteEngines');
    if (!caller.includes("$doctorReport['remoteEngines'] = $remoteEngines"))
      throw new Error('R-3 Doctor must publish the live remoteEngines result');
    return d1Section(src, 'Get-DoctorRemoteCodeHealth');
  }
  const b = src.indexOf('# v1.23.0 #5：远程代码证据引擎健康 ping');
  const e = src.indexOf("$doctorReport['remoteEngines']", b);
  if (b < 0 || e <= b) throw new Error('R-3 inline Doctor probe anchors missing');
  return src.slice(b, e);
}
function guardsPass(block, src = source) {
  return /-MaxAttempts 1 -NodeDeadlineSec 5/.test(block) &&
    /Resolve-DoctorGrep429 -ResponseBody \$probeBody/.test(block) &&
    /ReadAllText\(\$tmp\)/.test(block) &&
    /finally \{ Remove-Item -LiteralPath \$tmp/.test(block) &&
    // P1（2026-10-19）：Sourcegraph 改走只取状态码的硬截止探针（IWR 会读完整条 SSE 流）。
    //   判据不变：429 = 可达但限流，不得报成不可达 —— 由「$sgCode -eq 429 参与 Reachable 判定」承接。
    /Invoke-DoctorStreamProbe -Uri \$sgUri/.test(block) &&
    /\$sgCode -eq 429/.test(block) &&
    /Engine = 'Sourcegraph';.*Reachable = \$sgReachable/.test(block) &&
    /Note = \$\(if \(\$isVercel\)/.test(d1Section(src, 'Resolve-DoctorGrep429')) &&
    /'Vercel Security Checkpoint'/.test(d1Section(src, 'Resolve-DoctorGrep429'));
}

test('Doctor keeps single-attempt/5s probes; grep 429 inspects body and Sourcegraph 429 is reachable', () => {
  assert.ok(guardsPass(remoteProbeBlock(source)), 'R-3 Doctor wiring/Note contract is missing');
  assert.match(harness, /Resolve-DoctorGrep429 -ResponseBody '<html>Vercel Security Checkpoint<\/html>'/);
  assert.match(harness, /Resolve-DoctorGrep429 -ResponseBody '\{\"error\":\"rate limited\"\}'/);
  assert.match(harness, /R-3 Vercel 429/);
  assert.match(harness, /R-3 pure 429/);
});

test('negative control: restoring a blanket unreachable 429 fails the executed probe; an uncalled helper fails after split', () => {
  const reverted = source.replace('Resolve-DoctorGrep429 -ResponseBody $probeBody', "[PSCustomObject]@{ Engine = 'grep.app'; Reachable = $false }");
  assert.notEqual(reverted, source, 'the negative control must actually change the branch');
  assert.ok(guardsPass(remoteProbeBlock(source)), 'positive Doctor probe must pass before mutation');
  assert.equal(guardsPass(remoteProbeBlock(reverted), reverted), false);
  if (source.includes('function Get-DoctorRemoteCodeHealth {')) {
    const uncalled = source.replace('$codeHealth = Get-DoctorRemoteCodeHealth -VERSION $VERSION -ghTok $ghTok -glTok $glTok', '$codeHealth = $null');
    assert.notEqual(uncalled, source);
    assert.throws(() => remoteProbeBlock(uncalled), /R-3 Doctor must call/);
  }
});

test('R-3 D1 pre-move synthetic control: called probe passes; disconnecting or breaking its helper fails', () => {
  const fixture = [
    'function Resolve-DoctorGrep429 {',
    "    $isVercel = ($ResponseBody -match 'Vercel Security Checkpoint')",
    "    Note = $(if ($isVercel) { 'Vercel Security Checkpoint' } else { '429 rate-limited' })",
    '}',
    'function Get-DoctorRemoteCodeHealth {',
    '    Invoke-ApiRequest -MaxAttempts 1 -NodeDeadlineSec 5',
    '    $remoteEngines += Resolve-DoctorGrep429 -ResponseBody $probeBody',
    '    [System.IO.File]::ReadAllText($tmp)',
    '    try { } finally { Remove-Item -LiteralPath $tmp -Force }',
    '    $sg = Invoke-DoctorStreamProbe -Uri $sgUri -UserAgent $UA -TimeoutSec 6',
    '    $sgCode = $sg.Http',
    '    $sgReachable = [bool](($null -ne $sgCode -and $sgCode -ge 200 -and $sgCode -lt 300) -or $sgCode -eq 429)',
    "    $remoteEngines += [PSCustomObject]@{ Engine = 'Sourcegraph'; Reachable = $sgReachable }",
    '}',
    'function Invoke-DoctorReport {',
    '    $codeHealth = Get-DoctorRemoteCodeHealth -VERSION $VERSION -ghTok $ghTok -glTok $glTok',
    '    $remoteEngines = @($codeHealth.RemoteEngines)',
    "    $doctorReport['remoteEngines'] = $remoteEngines",
    '}'
  ].join('\n');
  assert.ok(guardsPass(remoteProbeBlock(fixture), fixture), 'positive R-3 split fixture must pass');
  const uncalled = fixture.replace('$codeHealth = Get-DoctorRemoteCodeHealth -VERSION $VERSION -ghTok $ghTok -glTok $glTok', '$codeHealth = $null');
  assert.notEqual(uncalled, fixture);
  assert.throws(() => remoteProbeBlock(uncalled), /R-3 Doctor must call/);
  const broken = fixture.replace('Resolve-DoctorGrep429 -ResponseBody $probeBody', 'Resolve-DoctorGrep429 -ResponseBody $null');
  assert.notEqual(broken, fixture);
  assert.equal(guardsPass(remoteProbeBlock(broken), broken), false);
});

// ---------- U-13 / U-26 / U-27 (2026-09-26): Doctor research-source health, key matrix, proxy state ----------
function guardU13(src) {
  const split = src.includes('function Get-DoctorResearchHealth {');
  const caller = split ? d1Section(src, 'Invoke-DoctorReport') : src;
  if (split && !caller.includes('$researchState = Get-DoctorResearchHealth -VERSION $VERSION'))
    throw new Error('U-13 Doctor must call Get-DoctorResearchHealth');
  if (split && !caller.includes('$researchHealth = @($researchState.ResearchHealth)'))
    throw new Error('U-13 Doctor must use returned research health');
  const b = caller.indexOf("$doctorReport['remoteEngines'] = $remoteEngines");
  const e = caller.indexOf("$doctorReport['disabledEngines']", b);
  if (b < 0 || e < b) throw new Error('U-13 doctor block anchors missing');
  const blk = caller.slice(b, e);
  // P1（2026-10-19）：探针执行器与分类器已各自拆成独立函数（并行化 + U-163 行数上限）⇒
  //   门按**真实调用图**拼接，否则「合法搬移」会被误判成「删掉了」（与下方 Get-DoctorKeyMatrix 同一形态）。
  const probeParts = [split ? d1Section(src, 'Get-DoctorResearchHealth') : blk];
  for (const fn of ['Invoke-ResearchProbeBatch', 'ConvertFrom-ResearchProbeOutcome'])
    if (src.includes(`function ${fn} {`)) probeParts.push(d1Section(src, fn));
  const probe = probeParts.join('\n');
  for (const key of ['researchSources', 'researchProbeSkipped', 'keyMatrix', 'proxyState']) {
    if (!blk.includes("$doctorReport['" + key + "']")) throw new Error('U-13 doctorReport missing ' + key);
  }
  // ★2026-10-09 批次2 校准：源名从 'npm (npms.io)' 改为 'npm'——探针端点同时从第三方 npms.io
  //   换成官方 registry.npmjs.org（npms.io 是单点第三方依赖，且其 popularity 语义与 registry 不同）。
  //   源名只是人读标签、端点才是语义，标签跟着端点一起校准，不保留已不存在的 host 字样。
  for (const src9 of ['Semantic Scholar', 'MCP Registry', 'Glama', 'Stack Exchange', 'arXiv', 'Hugging Face', 'npm', 'crates.io', 'Maven Central']) {
    if (!probe.includes("Source = '" + src9 + "'")) throw new Error('U-13 research probe missing ' + src9);
  }
  if (!/-MaxAttempts 1/.test(probe)) throw new Error('U-13 probes must be single-attempt (false-positive/perf criterion)');
  if (!/MCPS_DOCTOR_RESEARCH/.test(probe)) throw new Error('U-13 probes must be skippable');
  if (!/'rate-limited'/.test(probe) || !/'needs-key'/.test(probe)) throw new Error('U-13 429 / 401-403 must not be reported as unreachable');
  // ★2026-10-10 批次3 校准：keyMatrix 的 6 行字面量已从 `Invoke-DoctorReport` 体内抽成
  //   `Get-DoctorKeyMatrix` 函数（该函数当时把 Invoke-DoctorReport 顶到 112 行、触红 U-163-2）。
  //   门要认两种形态：内联（blk 里有）或外置（函数在主脚本里）——与上面 Get-DoctorResearchHealth
  //   的 split 处理同一形态。只认一种形态会让"合法搬移"被误判成"删掉了"。
  const keyBlk = (split && src.includes('function Get-DoctorKeyMatrix {'))
    ? blk + '\n' + d1Section(src, 'Get-DoctorKeyMatrix')
    : blk;
  for (const k of ['GITHUB_TOKEN', 'GITEE_TOKEN', 'GITLAB_TOKEN', 'S2_API_KEY', 'GLAMA_API_KEY', 'SE_KEY']) {
    if (!keyBlk.includes("Var = '" + k + "'")) throw new Error('U-27 key matrix missing ' + k);
  }
  if (/(Write-ColorOutput|Write-PayloadOutput)[^\n]*\$kv\b/.test(keyBlk)) throw new Error('U-27 must never print key values');
  if (!/Get-ProcessProxyEnvSummary/.test(blk) || !/NoProxyDirectMode/.test(blk)) throw new Error('U-13 proxy state must include process env + direct mode');
  return true;
}
test('U-13/U-26/U-27: Doctor reports research-source health (9 sources, 1 attempt, skippable), key matrix and 3-layer proxy state', () => {
  assert.ok(guardU13(source));
});
test('U-13 negative control: treating 429 as unreachable and disconnecting the research helper are detected', () => {
  const reverted = source.replace("$status = 'rate-limited'; $code = 429", "$status = 'unreachable'; $code = 429");
  assert.notEqual(reverted, source, 'the negative control must actually change the rate-limited branch');
  assert.ok(guardU13(source), 'positive U-13 source must pass before mutation');
  assert.throws(() => guardU13(reverted), /429 \/ 401-403/);
  if (source.includes('function Get-DoctorResearchHealth {')) {
    const uncalled = source.replace('$researchState = Get-DoctorResearchHealth -VERSION $VERSION', '$researchState = $null');
    assert.notEqual(uncalled, source);
    assert.throws(() => guardU13(uncalled), /U-13 Doctor must call/);
  }
});
test('U-13 D1 pre-move synthetic control: called research helper passes; disconnected probe and 429 regression fail', () => {
  const sources = ['Semantic Scholar', 'MCP Registry', 'Glama', 'Stack Exchange', 'arXiv', 'Hugging Face', 'npm', 'crates.io', 'Maven Central'];
  const keys = ['GITHUB_TOKEN', 'GITEE_TOKEN', 'GITLAB_TOKEN', 'S2_API_KEY', 'GLAMA_API_KEY', 'SE_KEY'];
  const fixture = [
    'function Get-DoctorResearchHealth {',
    ...sources.map(name => `    @{ Source = '${name}' }`),
    '    Invoke-ApiRequest -MaxAttempts 1',
    '    $doResearch = -not $env:MCPS_DOCTOR_RESEARCH',
    "    $status = 'rate-limited'; $code = 429",
    "    $status = 'needs-key'",
    '}',
    'function Invoke-DoctorReport {',
    '    $researchState = Get-DoctorResearchHealth -VERSION $VERSION',
    '    $researchHealth = @($researchState.ResearchHealth)',
    "    $doctorReport['remoteEngines'] = $remoteEngines",
    "    $doctorReport['researchSources'] = @($researchHealth)",
    "    $doctorReport['researchProbeSkipped'] = -not $doResearch",
    "    $doctorReport['keyMatrix'] = $keyMatrix",
    "    $doctorReport['proxyState'] = $proxyState",
    ...keys.map(name => `    @{ Var = '${name}'; Present = $false }`),
    '    $proxyState = Get-ProcessProxyEnvSummary; $proxyState.NoProxyDirectMode = $false',
    "    $doctorReport['disabledEngines'] = @()",
    '}'
  ].join('\n');
  assert.ok(guardU13(fixture), 'positive research split fixture must pass');
  const uncalled = fixture.replace('$researchState = Get-DoctorResearchHealth -VERSION $VERSION', '$researchState = $null');
  assert.notEqual(uncalled, fixture);
  assert.throws(() => guardU13(uncalled), /U-13 Doctor must call/);
  const reverted = fixture.replace("$status = 'rate-limited'; $code = 429", "$status = 'unreachable'; $code = 429");
  assert.notEqual(reverted, fixture);
  assert.throws(() => guardU13(reverted), /429 \/ 401-403/);
});
test('changelog has no duplicate top-level version headings (U-13 T2-6)', () => {
  const log = fs.readFileSync(path.join(root, 'references/变更历史.md'), 'utf8');
  // a range heading like `## v1.28.0–v1.32.0 摘要回填` is not a duplicate of `## v1.28.0 …`
  const heads = log.split(/\r?\n/).filter(l => /^## v\d+\.\d+\.\d+(?=[\s（(])/.test(l)).map(l => l.match(/^## (v\d+\.\d+\.\d+)/)[1]);
  const dup = heads.filter((h, i) => heads.indexOf(h) !== i);
  assert.deepEqual(dup, [], 'duplicate top-level version headings: ' + dup.join(','));
});
