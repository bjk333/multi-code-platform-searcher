// U-125（2026-09-28）：令牌粒度登记（tokens[].MinScope）+ 到期告警（≤ Cfg.TokenExpiryWarnDays 天 ⇒ doctor.tokenExpiryWarnings[] + 控制台 ⏰）。
// 到期来源：MCPS_TOKEN_EXPIRES 登记表（只读，不输出值）或 GitHub /user 响应头 github-authentication-token-expiration。
// 实测（容器，假令牌 ⇒ HTTP 401，仍能换算到期）：reports/gates/u125-b6/doctor-expiring.json（3 天后到期 ⇒ 告警）、doctor-far.json（90 天 ⇒ 不告警）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceAll } from './lib/source.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mainSrc = sourceAll(path.join(rootDir));
const load = f => JSON.parse(fs.readFileSync(path.join(rootDir, 'reports/gates/u125-b6', f), 'utf8').replace(/^\uFEFF/, '')).doctor;

// D1: match expiry logic in the called token helper, never merely somewhere in the script.
function doctorSection(src, name) {
  const mark = `function ${name} {`;
  const at = src.indexOf(mark);
  assert.ok(at >= 0, 'U-125 D1 function missing: ' + name);
  const tail = src.slice(at);
  const next = /^function [A-Za-z][\w-]* \{/gm;
  next.lastIndex = mark.length;
  return tail.slice(0, next.exec(tail)?.index ?? tail.length);
}
function checkSource(src) {
  const publicDoctor = doctorSection(src, 'Invoke-DoctorReport');
  const split = src.includes('function Get-DoctorTokens {');
  const tokenBody = split ? doctorSection(src, 'Get-DoctorTokens') : publicDoctor;
  if (split) {
    assert.match(publicDoctor, /\$tokenState = Get-DoctorTokens -VERSION \$VERSION/, 'U-125 Doctor must invoke token helper');
    assert.match(publicDoctor, /\$tokens = @\(\$tokenState\.Tokens\)/, 'U-125 Doctor must use returned token list');
    assert.match(publicDoctor, /\$tokenExpiryWarnings = @\(\$tokenState\.TokenExpiryWarnings\)/, 'U-125 Doctor must use returned warnings');
  }
  assert.match(src, /^\s*TokenExpiryWarnDays\s*=\s*7/m, 'Cfg.TokenExpiryWarnDays must be 7');
  assert.match(tokenBody, /\$env:MCPS_TOKEN_EXPIRES/, 'registry knob must be read in the executed token path (U-55)');
  assert.match(tokenBody, /github-authentication-token-expiration/, 'GitHub expiry header must be honoured');
  assert.match(tokenBody, /elseif \(\$tk\.DaysLeft -le \$script:Cfg\.TokenExpiryWarnDays\) \{ \$tokenExpiryWarnings \+= /, 'warning must be gated on DaysLeft <= threshold');
  assert.match(publicDoctor, /\$doctorReport\['tokenExpiryWarnings'\] = @\(\$tokenExpiryWarnings\)/);
  for (const v of ['GITHUB_TOKEN', 'GITLAB_TOKEN', 'GITEE_TOKEN', 'SRC_TOKEN']) assert.match(tokenBody, new RegExp(`Var = '${v}'[^\\n]*MinScope = '[^']+'`), `${v} needs a MinScope entry`);
  assert.match(tokenBody, /MinScope = 'fine-grained PAT[^']*read-only/, 'GitHub minimum scope must be read-only');
}
function checkExpiring(d) {
  const gh = d.tokens.find(t => t.Var === 'GITHUB_TOKEN');
  assert.ok(gh.Present && gh.ExpiresAt && Number.isInteger(gh.DaysLeft) && gh.DaysLeft <= 7, 'GITHUB_TOKEN must resolve DaysLeft <= 7');
  assert.ok(d.tokenExpiryWarnings.some(w => /^GITHUB_TOKEN 将于 \d{4}-\d{2}-\d{2} 到期（剩 \d+ 天，阈值 ≤7 天）/.test(w)), 'expiry warning missing');
  const gl = d.tokens.find(t => t.Var === 'GITLAB_TOKEN');
  if (gl.Present) assert.ok(!d.tokenExpiryWarnings.some(w => w.startsWith('GITLAB_TOKEN')), 'a far-away GITLAB expiry must not warn');
  for (const t of d.tokens) assert.ok(typeof t.MinScope === 'string' && t.MinScope.length > 0, `${t.Var}.MinScope`);
  assert.ok(!JSON.stringify(d).includes('U125FAKE'), 'token value must never appear in doctor output');
}

test('U-125: source registers minimum scopes and computes expiry warnings from registry/header', () => checkSource(mainSrc));
test('U-125 D1 pre-move synthetic control: called token helper passes; disconnected warnings or threshold fail', () => {
  const fixture = [
    'TokenExpiryWarnDays = 7',
    'function Get-DoctorTokens {',
    '    $registry = $env:MCPS_TOKEN_EXPIRES',
    '    $expiry = github-authentication-token-expiration',
    "    [PSCustomObject]@{ Var = 'GITHUB_TOKEN'; MinScope = 'fine-grained PAT read-only' }",
    ...['GITLAB_TOKEN', 'GITEE_TOKEN', 'SRC_TOKEN'].map(name => `    [PSCustomObject]@{ Var = '${name}'; MinScope = 'read-only' }`),
    '    elseif ($tk.DaysLeft -le $script:Cfg.TokenExpiryWarnDays) { $tokenExpiryWarnings += $tk.Var }',
    '}',
    'function Invoke-DoctorReport {',
    '    $tokenState = Get-DoctorTokens -VERSION $VERSION',
    '    $tokens = @($tokenState.Tokens)',
    '    $tokenExpiryWarnings = @($tokenState.TokenExpiryWarnings)',
    "    $doctorReport['tokenExpiryWarnings'] = @($tokenExpiryWarnings)",
    '}'
  ].join('\n');
  assert.doesNotThrow(() => checkSource(fixture), 'positive split fixture must satisfy U-125 source gate');
  const uncalled = fixture.replace('$tokenState = Get-DoctorTokens -VERSION $VERSION', '$tokenState = $null');
  assert.notEqual(uncalled, fixture);
  assert.throws(() => checkSource(uncalled), /U-125 Doctor must invoke token helper/);
  const dropped = fixture.replace('$tokenExpiryWarnings = @($tokenState.TokenExpiryWarnings)', '$tokenExpiryWarnings = @()');
  assert.notEqual(dropped, fixture);
  assert.throws(() => checkSource(dropped), /U-125 Doctor must use returned warnings/);
  const noGate = fixture.replace('elseif ($tk.DaysLeft -le $script:Cfg.TokenExpiryWarnDays)', 'elseif ($false)');
  assert.notEqual(noGate, fixture);
  assert.throws(() => checkSource(noGate), /warning must be gated/);
});
test('U-125: recorded -Doctor runs — a token expiring in ≤7 days warns, a 90-day token does not', () => {
  checkExpiring(load('doctor-expiring.json'));
  const far = load('doctor-far.json');
  assert.deepEqual(far.tokenExpiryWarnings, []);
  assert.ok(far.tokens.find(t => t.Var === 'GITHUB_TOKEN').DaysLeft > 7);
});
test('U-125 negative controls: omitted warning, disabled threshold or disconnected token helper are detected', () => {
  const d = load('doctor-expiring.json');
  const silent = structuredClone(d); silent.tokenExpiryWarnings = [];
  assert.throws(() => checkExpiring(silent), /expiry warning missing/);
  assert.doesNotThrow(() => checkSource(mainSrc), 'positive source must pass before mutation');
  const noGate = mainSrc.replace('elseif ($tk.DaysLeft -le $script:Cfg.TokenExpiryWarnDays) { $tokenExpiryWarnings += ', 'elseif ($false) { $tokenExpiryWarnings += ');
  assert.notEqual(noGate, mainSrc);
  assert.throws(() => checkSource(noGate), /warning must be gated/);
  if (mainSrc.includes('function Get-DoctorTokens {')) {
    const uncalled = mainSrc.replace('$tokenState = Get-DoctorTokens -VERSION $VERSION', '$tokenState = $null');
    assert.notEqual(uncalled, mainSrc);
    assert.throws(() => checkSource(uncalled), /U-125 Doctor must invoke token helper/);
  }
});
