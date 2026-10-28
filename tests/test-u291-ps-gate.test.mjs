// U-291（v1.71.0，2026-10-28 全量验收 F1）：`.ps-gate.json` 前置 —— **PS 套件红也不许发布**。
//
// 病灶（实证，不是推演）：发布器只问 Node 门的绿。2026-10-28 全量验收实测：
//   `test-docs` 判 `SKILL.md` 含字面 `\n`（第 171 行，描述正则用），该行 2026-10-26 20:48 进树，
//   v1.70.0 于 10-27 16:58 **带着这条红发布**。原因不是门写错，而是这张凭证从来没人要。
//
// 门分三层（与 U-247 同构）：
//   A JS 真值表；B **两侧同表**（AST 抠出 PS 的 Test-PsGate 跑同一批用例，只比布尔）；C 接线 + 变异负例。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPwsh } from './r2-ps-run.mjs';
import { psGateVerdict, PS_GATE_SCHEMA, PS_GATE_REL, PS_GATE_MAX_AGE_MS } from './ps-gate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = fs.readFileSync(path.join(ROOT, 'scripts', 'publish-skill.ps1'), 'utf8');
const RUN_TESTS = fs.readFileSync(path.join(ROOT, 'tests', 'run-tests.ps1'), 'utf8');
const GI = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
// 只认 `$psGateObj` 那段 —— `exitCode = $exitCodeFinal` 在 `$resultObj` 里也有一份，
//   全文件匹配会让"把凭证里的 exitCode 写死 0"这种变异漏网（第一版就漏了）。
const psBlock = src => {
  const i = src.indexOf('$psGateObj');
  return i < 0 ? '' : src.slice(i, i + 1600);
};

const good = (over = {}) => ({
  schema: PS_GATE_SCHEMA, version: '1.2.3', runtime: 'PS 5.1.0 / Desktop', runtimeMajor: 5,
  localOnly: false, passed: 12, failed: 0, skipped: 0, exitCode: 0, mismatch: false,
  finishedAt: new Date().toISOString(), groups: ['test-dedup:PASS'], ...over,
});

test('U-291-A: JS 判据真值表（11 例，含 fail-closed 的缺 failed、-LocalOnly、超龄）', () => {
  const now = Date.now();
  const V = { version: '1.2.3', now };
  const cases = [
    ['missing', null, false],
    ['bad-schema', good({ schema: 'x/1' }), false],
    ['no-failed', good({ failed: undefined }), false],       // ★[int]$null=0 ⇒ 不显式判空就会 fail-open
    ['failed', good({ failed: 1 }), false],
    ['exit-nonzero', good({ exitCode: 1 }), false],
    ['local-only', good({ localOnly: true }), false],
    ['version-mismatch', good(), false],
    ['stale', good({ finishedAt: new Date(now - PS_GATE_MAX_AGE_MS - 60000).toISOString() }), false],
    ['bad-finishedAt', good({ finishedAt: 'not-a-date' }), false],
    ['ok', good(), true],
    ['ok-skip', good({ skipped: 2 }), true],                 // 跳过是环境（网络不可用），不是红
  ];
  for (const [id, obj, want] of cases) {
    const v = psGateVerdict(obj, id === 'version-mismatch' ? { version: '9.9.9', now } : V);
    assert.equal(v.ok, want, `${id}: want ${want}, got ${v.why}`);
  }
  assert.equal(PS_GATE_REL, '.ps-gate.json');
  assert.equal(PS_GATE_SCHEMA, 'mcps/ps-gate/1');
});

test('U-291-B: 两侧同表 —— PS 的 Test-PsGate 与 JS 判据逐例同布尔', async () => {
  const r = await runPwsh(['-File', path.join(ROOT, 'tests', 'u291-psgate-truth.ps1')], { timeoutMs: 180000 });
  assert.equal(r.status, 0, `harness rc=${r.status}: ${(r.stderr || '').slice(-500)}`);
  const line = r.stdout.split(/\r?\n/).filter(l => l.trim().startsWith('{"ok"')).pop();
  assert.ok(line, `harness 未输出 JSON：${(r.stdout || '').slice(-300)}`);
  const rows = JSON.parse(line).rows;
  const want = {
    missing: false, 'bad-json': false, 'bad-schema': false, 'no-failed': false, failed: false,
    'exit-nonzero': false, 'local-only': false, 'version-mismatch': false, stale: false,
    ok: true, 'ok-skip': true,
  };
  assert.deepEqual(rows.map(x => x.id).sort(), Object.keys(want).sort(), '两侧用例集不一致');
  for (const row of rows) assert.equal(row.ok, want[row.id], `${row.id}: PS=${row.ok} JS=${want[row.id]}（${row.why}）`);
});

test('U-291-C: 接线 —— run-tests 落 PS 凭证 / 发布器默认拒绝 / 凭证不入库也不随发', () => {
  const bad = [];
  // run-tests.ps1 必须真的写凭证（路径 + schema + 写盘），而不是只 README 里写了
  if (!/\.ps-gate\.json/.test(RUN_TESTS)) bad.push('run-tests 没有写 .ps-gate.json');
  if (!/schema = 'mcps\/ps-gate\/1'/.test(RUN_TESTS)) bad.push('凭证 schema 未落');
  if (!/\[System\.IO\.File\]::WriteAllText\(\$psGateFile/.test(RUN_TESTS)) bad.push('凭证未落盘');
  if (!/exitCode = \$exitCodeFinal/.test(psBlock(RUN_TESTS))) bad.push('凭证缺 exitCode（只看 failed 会漏"组行与计数不一致"）');
  if (!/localOnly = \[bool\]\$LocalOnly/.test(psBlock(RUN_TESTS))) bad.push('凭证缺 localOnly（-LocalOnly 会被当成全量背书）');
  // 发布器：函数在、调用在、默认拒绝在
  if (!/function Test-PsGate/.test(PUB)) bad.push('发布器缺 Test-PsGate');
  if (!/Test-PsGate -Path \(Join-Path \$canonicalDir '\.ps-gate\.json'\)/.test(PUB)) bad.push('发布器没有调用 Test-PsGate');
  if (!/if \(-not \$SkipGateGreen\) \{ throw/.test(PUB)) bad.push('发布器默认不拒绝（带红发布仍可过）');
  if (!/PUB_EXCLUDE_NAMES[\s\S]{0,900}'\.ps-gate\.json'/.test(PUB)) bad.push('凭证未登记进发布排除名单（Tier1-3 会 fail-closed）');
  if (!/^\.ps-gate\.json$/m.test(GI)) bad.push('.gitignore 未忽略凭证（会进库）');
  assert.deepEqual(bad, [], bad.join('; '));
});

test('U-291-C 负例：不落凭证 / 不校验 / 只记 failed / 不排除 —— 各自判红', () => {
  const badOf = (pub, rt, gi) => {
    const out = [];
    if (!/\.ps-gate\.json/.test(rt)) out.push('write');
    if (!/Test-PsGate -Path \(Join-Path \$canonicalDir '\.ps-gate\.json'\)/.test(pub)) out.push('call');
    if (!/exitCode = \$exitCodeFinal/.test(psBlock(rt))) out.push('exit');
    if (!/PUB_EXCLUDE_NAMES[\s\S]{0,900}'\.ps-gate\.json'/.test(pub)) out.push('exclude');
    if (!/^\.ps-gate\.json$/m.test(gi)) out.push('ignore');
    return out;
  };
  assert.deepEqual(badOf(PUB, RUN_TESTS, GI), []);
  const noWrite = RUN_TESTS.replace(/\.ps-gate\.json/g, '.ps-gate-disabled.json');
  assert.notEqual(noWrite, RUN_TESTS, '变异①未生效');
  assert.ok(badOf(PUB, noWrite, GI).includes('write'), '不落凭证未被判红');
  const noCall = PUB.replace("Test-PsGate -Path (Join-Path $canonicalDir '.ps-gate.json')", 'Test-PsGate -Path $null');
  assert.notEqual(noCall, PUB, '变异②未生效');
  assert.ok(badOf(noCall, RUN_TESTS, GI).includes('call'), '发布器不校验未被判红');
  const noExit = RUN_TESTS.replace(/(\$psGateObj[\s\S]{0,800}?)exitCode = \$exitCodeFinal/, '$1exitCode = 0');
  assert.notEqual(noExit, RUN_TESTS, '变异③未生效');
  assert.ok(badOf(PUB, noExit, GI).includes('exit'), '只记 failed 未被判红');
  const noIgnore = GI.replace(/^\.ps-gate\.json$/m, '');
  assert.notEqual(noIgnore, GI, '变异④未生效');
  assert.ok(badOf(PUB, RUN_TESTS, noIgnore).includes('ignore'), '凭证进库未被判红');
});
