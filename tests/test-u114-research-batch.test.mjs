// R90 A / U-114: in-process multi-query research batch, per-query parity, timing and explicit failures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { envFailIfTiming } from './gate-partition.mjs';
import { sourceAll } from './lib/source.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = sourceAll(path.join(root));
const schema = JSON.parse(fs.readFileSync(path.join(root, 'schema/asjson.schema.json'), 'utf8'));

// Async spawn: host Windows may raise transient EBUSY from spawnSync under concurrent gates.
// Keep a bounded retry only for process-creation errors; test failures never get retried away.
async function runHarness() {
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await new Promise(resolve => {
      let stdout = '', stderr = '', done = false;
      const child = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-File', path.join(root, 'tests/u114-batch-harness.ps1')],
        { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      const finish = (status, error) => {
        if (done) return;
        done = true; clearTimeout(timer);
        resolve({ status, error, stdout, stderr });
      };
      child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
      child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
      child.once('error', error => finish(null, error));
      child.once('close', status => finish(status, null));
      const timer = setTimeout(() => { child.kill(); finish(null, new Error('pwsh harness timeout (40s)')); }, 40000);
    });
    if (!['EBUSY', 'ETXTBSY', 'EAGAIN'].includes(result.error?.code) || attempt === 2) return result;
    await delay(200 * (attempt + 1));
  }
}

function guard(s) {
  const bad = [];
  if (!/\[string\]\$ResearchBatch\s*=/.test(s)) bad.push('CLI file parameter absent');
  if (!/function Invoke-ResearchBatch\s*\{/.test(s)) bad.push('in-process batch function absent');
  if (!/CreateRunspacePool/.test(s.slice(s.indexOf('function Invoke-ResearchBatch')))) bad.push('no in-process runspace pool');
  if (!/\$ps\.BeginInvoke\(\)/.test(s.slice(s.indexOf('function Invoke-ResearchBatch')))) bad.push('queries not submitted concurrently');
  if (!/ReasonCodes/.test(s.slice(s.indexOf('function Invoke-ResearchBatch')))) bad.push('no failure reason codes');
  return bad;
}

test('U-114: -ResearchBatch file is wired to an in-process runspace pool with per-query ReasonCodes', () => {
  assert.deepEqual(guard(src), []);
  assert.doesNotMatch(src.slice(src.indexOf('function Invoke-ResearchBatch')), /Start-Process\s+(?:pwsh|powershell)|ProcessStartInfo|&\s+pwsh\s/, 'batch may not spawn a new PowerShell process for every query');
});

test('U-114 negative guard: removing per-query failure codes is detected', () => {
  const bad = src.replaceAll('ReasonCodes', 'HiddenCause');
  assert.notEqual(bad, src);
  assert.ok(guard(bad).some(x => /reason codes/.test(x)));
});

function assertBatchContract(source, spec) {
  const fail = source.slice(source.indexOf('function New-ResearchBatchFailure'), source.indexOf('function Invoke-ResearchBatch'));
  const batch = source.slice(source.indexOf('function Invoke-ResearchBatch'), source.indexOf('# ---------- 主流程'));
  assert.match(fail, /reasonCode\s*=\s*\$Code/, 'early failure must expose a scalar code');
  assert.match(batch, /elseif \(\$verdict -eq 'none'\) \{ 'none' \}/, 'coverage none must not be degraded');
  assert.match(batch, /reasonCode\s*=\s*\$reasonCode/, 'successful query item lacks scalar code');
  assert.match(batch, /\$entry\.reasonCode/, 'aggregate must derive from the same scalar');
  assert.ok(batch.includes("Status -in @('ok', 'degraded') }).Count -eq 0) { 'none' }"),
    'all-failed batch must be none; a real executed zero-hit stays full');
  const contract = spec.$defs?.researchBatch;
  assert.ok(contract && contract.properties.mode.const === 'research-batch', 'batch fragment missing');
  const q = contract.properties.queries.items;
  assert.ok(q.required.includes('reasonCode') && q.properties.reasonCode.enum.includes(null) &&
    q.properties.reasonCode.enum.includes('zero-hit') && q.properties.reasonCode.enum.includes('missing-credential'),
    'batch reasonCode must be required and use the existing ReasonCodes enum');
  assert.ok(q.required.includes('ReasonCodes'), 'engine-level map must not be removed');
  assert.ok(contract.properties.coverage.properties.Verdict.enum.includes('none'));
}

test('U-151/U-152: batch none/failure scalar and the standalone batch schema are mutually consistent', () => {
  assertBatchContract(src, schema);
});

test('U-151/U-152 negative controls: dropping scalar, none branch, or schema enum is detected by name', () => {
  assert.throws(() => assertBatchContract(src.replace('reasonCode = $reasonCode', 'missingScalar = $reasonCode'), schema), /scalar code/);
  assert.throws(() => assertBatchContract(src.replace("elseif ($verdict -eq 'none') { 'none' }", ''), schema), /none must not be degraded/);
  const bad = structuredClone(schema); bad.$defs.researchBatch.properties.queries.items.required =
    bad.$defs.researchBatch.properties.queries.items.required.filter(x => x !== 'reasonCode');
  assert.throws(() => assertBatchContract(src, bad), /reasonCode must be required/);
});

test('U-114 deterministic 9-query benchmark: <= serial p95 / 2, every count matches, failure is visible', async () => {
  const r = await runHarness();
  // U-153 Q2（2026-09-30）：harness 超时是**时序**症状（单跑绿）。有 U153_TIMING 凭据 ⇒ env:timing；否则按 product 抛。
  if (r.error && /harness timeout/.test(String(r.error.message))) envFailIfTiming('U-114 batch harness: ' + r.error.message);
  // U-153（2026-10-20）：时延断言与条数断言已在 harness 内拆开；只有 elapsed 那句可凭 U153_TIMING 记 env:timing。
  //   条数/错误不符的报文（...: counts/errors differ）刻意**不**走这里 —— 任何负载下都该绿，仍是 product。
  const harnessOut = String(r.stderr ?? '') + '\n' + String(r.stdout ?? '');
  if (r.status !== 0 && /U-114 acceptance failed: batch elapsed/.test(harnessOut)) envFailIfTiming('U-114 batch elapsed: ' + (harnessOut.match(/U-114 acceptance failed: batch elapsed[^\r\n]*/) || [''])[0]);
  assert.equal(r.status, 0, `PowerShell batch harness: ${r.error?.message ?? r.stderr?.slice(0, 900)}`);
  for (const token of ['A_MATCHES=9/9', 'A_ERROR_BASELINE=0', 'A_SUCCESS_NULL_CODES=9',
    // U-114（2026-10-20）：能力断言取三次最好的一次，三个采样必须打出来（可审计，且防止"只跑一次悄悄变绿"）
    'A_BATCH_SAMPLES=[', 'A_BATCH_BEST=', 'A_BATCH_RATIO=',
    'A_FAILURE_REASON=error', 'A_FAILURE_SCALAR=error', 'A_FAILURE_VERDICT=none', 'A_FAILURE_WAS_RUN=True',
    'A_ZERO_HIT_VERDICT=full', 'A_ZERO_HIT_RESULTS=0', 'A_ZERO_HIT_SCALAR=zero-hit', 'A_ZERO_HIT_FAILED=0',
    'A_ALL_FAILED_VERDICT=none', 'A_ALL_FAILED_COUNT=2', 'A_ALL_FAILED_SCALAR=deadline', 'A_ALL_FAILED_MAP=deadline',
    // U-243（v1.53.25）：research 引擎由 12 增到 14（Packages 拆成 Npm/Crates/Maven）⇒ 禁用 13 个后
    //   ReasonCodes 数 = 13。**这个数字与 u114-batch-harness.ps1 的 `$known -ne 13` 是同一个事实**，
    //   改一处不改另一处就是"门自己和自己打架"（v1.53.25 实测：harness 改对了、这里还留着 11 ⇒ 恒红）。
    'A_CLI_SINGLETON=no-engines', 'A_CLI_REASONS=13', 'A_CLI_SCALAR=user-disabled', 'A_TEMP_REMOVED=True', 'A_PERFORMANCE_PASS=True']) {
    assert.ok(r.stdout.includes(token), `${token}: ${r.stdout.slice(0, 900)}`);
  }
  console.log(r.stdout.trim());
});
