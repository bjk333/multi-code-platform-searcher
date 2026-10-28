// R90 F / U-143: -Auto must not drop research for methodology queries that contain no code identifier.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { envFailIfInterpBroken } from './gate-partition.mjs';
import { sourceAll } from './lib/source.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = sourceAll(path.join(root));
const docs = fs.readFileSync(path.join(root, 'references/引擎链.md'), 'utf8');

async function runPwshEncoded(script) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await new Promise(resolve => {
      let stdout = '', stderr = '', done = false;
      const child = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
        { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, MCPS_NO_MAIN: '1' }, windowsHide: true });
      const finish = (status, error) => {
        if (done) return;
        done = true; clearTimeout(timer);
        resolve({ status, error, stdout, stderr });
      };
      child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
      child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
      child.once('error', error => finish(null, error));
      child.once('close', status => finish(status, null));
      const timer = setTimeout(() => { child.kill(); finish(null, new Error('pwsh planner timeout (15s)')); }, 15000);
    });
    if (!['EBUSY', 'ETXTBSY', 'EAGAIN'].includes(result.error?.code) || attempt === 2) return result;
    await delay(200 * (attempt + 1));
  }
}

function guard(s) {
  const issues = [];
  if (!/function Test-AutoCodeIdentifier\s*\{/.test(s)) issues.push('identifier detector missing');
  if (!/function Add-AutoResearchMode\s*\{/.test(s)) issues.push('research fallback missing');
  const classifier = s.match(/^\s*\$syntax = '([^']+)'/m)?.[1] ?? '';
  if (classifier.includes(String.raw`\s*\(`)) issues.push('prose before ( mistaken for a call');
  if (classifier.includes(String.raw`\b[A-Z][A-Za-z0-9]*-[A-Z]`)) issues.push('prose Title-Case mistaken for Verb-Noun');
  if (!/if \(-not \(Test-AutoCodeIdentifier -Keyword \$Keyword\) -and \$Modes -notcontains 'research'\)/.test(s)) issues.push('no-code queries can silently omit research');
  // U-204（v1.46.8）：三处 fallback 随逻辑迁到 `Get-AutoPlan`（MCP search_auto 需要 queryType/planSource），
  //   `Get-AutoModes` 只剩一行委托 ⇒ 守卫锚点必须跟着搬：否则实现搬走了、守卫还在看空壳（恒绿）。
  const m = s.match(/function Get-AutoPlan\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
  if ((m.match(/Add-AutoResearchMode/g) ?? []).length < 3) issues.push('planner success/missing/error need fallback');
  return issues;
}

test('U-143: code identifier detector and Auto fallback are wired in planner success and failure paths', () => {
  assert.deepEqual(guard(source), []);
  assert.match(docs, /强于找代码\/库、弱于找方法论/);
});

test('U-143 negative mutation guard: dropping research fallback is detected', () => {
  const bad = source.replace("-and $Modes -notcontains 'research'", "-and $false");
  assert.notEqual(bad, source);
  assert.notDeepEqual(guard(bad), []);
});

test('U-143 negative: restoring whitespace-before-parenthesis or unrestricted Title-Case makes the classifier guard red', () => {
  const looseCall = source.replace(String.raw`[A-Za-z0-9_]*\(`, String.raw`[A-Za-z0-9_]*\s*\(`);
  assert.notEqual(looseCall, source);
  assert.ok(guard(looseCall).some(x => /prose before/.test(x)));
  const looseHyphen = source.replace(String.raw`\b(?:Get|Set|New|Invoke|Test|Find|Remove|Add|Resolve|Search|Write|Read|Convert|Import|Export)-[A-Z]`, String.raw`\b[A-Z][A-Za-z0-9]*-[A-Z]`);
  assert.notEqual(looseHyphen, source);
  assert.ok(guard(looseHyphen).some(x => /Title-Case/.test(x)));
});

test('U-143 offline runtime: methodology gains research, explicit code identifier keeps code-only', async () => {
  const main = path.join(root, 'multi-platform-searcher.ps1').replaceAll("'", "''");
  const planner = path.join(root, 'query-planner.ps1').replaceAll("'", "''");
  const script = `$ErrorActionPreference='Stop'; $env:MCPS_NO_MAIN='1'; . '${main}' -NoEnvFile -AsJson; foreach ($q in @('powershell module dot sourcing refactor monolithic script','best practices refactoring large legacy codebase into modules','refactoring modules (methodological review)','designing Large-Scale Multi-Agent systems (best practices)','Find-LocalSearchBinary function implementation','Invoke-ApiRequest function implementation')) { $p = & '${planner}' -Query $q | ConvertFrom-Json; $m=@(Get-AutoModes -Keyword $q); 'U143_CASE='+$q+' TYPE='+$p.queryType+' MODES='+($m -join ',') }`;
  const r = await runPwshEncoded(script);
  // U-153（2026-10-20）：解释器起不来（CoreCLR OOM / CoreLib 载入失败）⇒ 本门一行没跑，记 env:interp-oom；
  //   高并发下实测 `Failed to create CoreCLR, HRESULT: 0x8007000E`，旧口径把它记成 product 断言失败。
  envFailIfInterpBroken(String(r.error?.message ?? '') + '\n' + String(r.stderr ?? ''));
  assert.equal(r.status, 0, r.error?.message ?? r.stderr?.slice(0, 500));
  assert.match(r.stdout, /U143_CASE=powershell module dot sourcing refactor monolithic script TYPE=code_evidence_only MODES=code,research/);
  assert.match(r.stdout, /U143_CASE=best practices refactoring large legacy codebase into modules TYPE=integrated_research_and_code MODES=repo,code,research/);
  for (const q of ['refactoring modules (methodological review)', 'designing Large-Scale Multi-Agent systems (best practices)']) {
    const line = r.stdout.split(/\r?\n/).find(x => x.startsWith(`U143_CASE=${q} `));
    assert.ok(line, 'missing offline classifier case: ' + q);
    assert.match(line, /(?:MODES=|,)research(?:,|$)/, 'prose punctuation must not suppress research: ' + line);
  }
  assert.match(r.stdout, /^U143_CASE=Find-LocalSearchBinary function implementation TYPE=code_evidence_only MODES=code$/m);
  assert.match(r.stdout, /^U143_CASE=Invoke-ApiRequest function implementation TYPE=code_evidence_only MODES=code$/m);
  console.log(r.stdout.trim());
});
