// U-247（v1.53.26，验收 B1-4 前半）：`gate-green.json` 前置 —— **带红不许发布**。
//
// 病灶（F18）：发布器此前只看"清单哈希 == 当前字节"，与门禁结果毫无关系。
//   2026-10-25 实测：707 用例 2 条红仍然发布成功 —— "红"只活在人的记忆里，不在产物里。
//
// 判据（每条对应一种已知的假绿手法）：
//   缺文件/坏 JSON/缺字段 ⇒ 拒；product_red≠0 ⇒ 拒；voided ⇒ 拒；**run_mode=parallel ⇒ 拒**（并行绿不算绿）；
//   versionAtStart≠versionAtEnd ⇒ 拒；-Version 对不上 ⇒ 拒；超龄 24h ⇒ 拒。
//
// 门分三层：A JS 真值表；B **两侧同表**（AST 抠出 PS 的 Test-GateGreen 跑同一批用例，只比布尔）；
//   C 接线与 2 条变异。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPwsh } from './r2-ps-run.mjs';
import { gateGreenVerdict, buildGateGreen, GATE_GREEN_SCHEMA, GATE_GREEN_REL, GATE_GREEN_MAX_AGE_MS } from './gate-green.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER = fs.readFileSync(path.join(ROOT, 'tests', 'run-node-gates.mjs'), 'utf8');
const PUB = fs.readFileSync(path.join(ROOT, 'scripts', 'publish-skill.ps1'), 'utf8');
const GI = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');

const good = (over = {}) => ({
  schema: GATE_GREEN_SCHEMA, version: '1.2.3', versionAtStart: '1.2.3', versionAtEnd: '1.2.3',
  runMode: 'serial', productRed: 0, metaRed: 0, envRed: 0, voided: false, finishedAt: new Date().toISOString(), ...over,
});

test('U-247-A: JS 判据真值表（13 例，含"并行绿不算绿"、meta_red 与超龄）', () => {
  const now = Date.now();
  const V = { version: '1.2.3', now };
  const cases = [
    ['missing', null, false],
    ['bad-schema', good({ schema: 'x/1' }), false],
    ['product-red', good({ productRed: 2 }), false],
    // U-275（v1.57.0）：meta_red 是"记账要修"，不是产品结论 —— 但发布同样拒绝；缺字段也拒（fail-closed）
    ['meta-red', good({ metaRed: 1 }), false],
    ['meta-missing', good({ metaRed: undefined }), false],
    ['voided', good({ voided: true }), false],
    ['parallel', good({ runMode: 'parallel' }), false],
    ['unknown-mode', good({ runMode: 'whatever' }), false],
    ['version-drift', good({ versionAtEnd: '9.9.9' }), false],
    ['ok-serial', good(), true],
    ['ok-recheck', good({ runMode: 'parallel+serial-recheck' }), true],
    ['stale', good({ finishedAt: new Date(now - GATE_GREEN_MAX_AGE_MS - 60000).toISOString() }), false],
    ['no-finishedAt', good({ finishedAt: undefined }), false],
  ];
  for (const [id, obj, want] of cases) assert.equal(gateGreenVerdict(obj, V).ok, want, `${id}: want ${want}, got ${gateGreenVerdict(obj, V).why}`);
  // version 对不上
  assert.equal(gateGreenVerdict(good(), { version: '9.9.9', now }).ok, false);
  // buildGateGreen 必须把判据需要的字段都带上（少一个 ⇒ 将来判据会静默通过）
  const g = buildGateGreen({ runMode: 'serial', productRed: 0, envRed: 1, envByKind: { timing: 1 }, versionAtStart: '1.2.3', versionAtEnd: '1.2.3', movedToEnv: ['x'] }, { version: '1.2.3', files: ['tests/b.test.mjs', 'tests/a.test.mjs'] });
  assert.equal(g.schema, GATE_GREEN_SCHEMA);
  assert.deepEqual(g.gateFiles, ['a.test.mjs', 'b.test.mjs'], 'gateFiles 必须排序（否则同一轮两次跑出的凭证不可比）');
  for (const k of ['version', 'versionAtStart', 'versionAtEnd', 'runMode', 'productRed', 'metaRed', 'voided', 'finishedAt']) {
    assert.ok(k in g, `buildGateGreen 缺字段 ${k}`);
  }
});

test('U-247-B: 两侧同表 —— PS 的 Test-GateGreen 与 JS 判据逐例同布尔', async () => {
  const r = await runPwsh(['-File', path.join(ROOT, 'tests', 'u247-gategreen-truth.ps1')], { timeoutMs: 180000 });
  assert.equal(r.status, 0, `harness rc=${r.status}: ${(r.stderr || '').slice(-500)}`);
  const line = r.stdout.split(/\r?\n/).filter(l => l.trim().startsWith('{"ok"')).pop();
  assert.ok(line, `harness 未输出 JSON：${(r.stdout || '').slice(-300)}`);
  const got = JSON.parse(line).rows;
  const want = { missing: false, 'bad-schema': false, 'product-red': false, 'meta-red': false, 'meta-missing': false, voided: false, parallel: false, 'version-drift': false, 'version-mismatch': false, 'ok-serial': true, 'ok-recheck': true, 'bad-json': false };
  assert.deepEqual(got.map(x => x.id).sort(), Object.keys(want).sort(), '两侧用例集不一致');
  for (const row of got) assert.equal(row.ok, want[row.id], `${row.id}: PS=${row.ok} JS=${want[row.id]}（${row.why}）`);
  // JS 侧对同一批用例的布尔必须与上表一致（防"只测了 PS"）
  for (const [id, obj, expected] of [
    ['missing', null, false], ['bad-schema', good({ schema: 'x/1' }), false], ['product-red', good({ productRed: 2 }), false],
    ['meta-red', good({ metaRed: 1 }), false], ['meta-missing', good({ metaRed: undefined }), false],
    ['voided', good({ voided: true }), false], ['parallel', good({ runMode: 'parallel' }), false],
    ['version-drift', good({ versionAtEnd: '9.9.9' }), false], ['ok-serial', good(), true],
    ['ok-recheck', good({ runMode: 'parallel+serial-recheck' }), true], ['bad-json', null, false],
  ]) assert.equal(gateGreenVerdict(obj, { version: '1.2.3' }).ok, expected, `JS 侧 ${id} 与 PS 不一致`);
});

test('U-247-C: 接线 —— 跑完落凭证（作废不落）/ 发布器默认拒绝 / 凭证不入库', () => {
  const bad = [];
  if (!/if \(!summary\.voided\) \{/.test(RUNNER)) bad.push('作废的一轮也写了凭证');
  // 开跑即作废旧凭证：崩掉的一轮不能把上一次的绿留在盘上（否则发布器读到旧绿 = 带红发布）
  if (!/rmSync\(gateGreenPath\(root\), \{ force: true \}\)/.test(RUNNER)) bad.push('开跑未作废旧凭证（崩掉后旧绿会冒充本轮）');
  if (!/buildGateGreen\(summary, \{ version: versionAtEnd, files \}\)/.test(RUNNER)) bad.push('runner 未落 gate-green');
  if (!new RegExp('GATE_GREEN_REL = \'\\.gate-green\\.json\'').test(fs.readFileSync(path.join(ROOT, 'tests/gate-green.mjs'), 'utf8'))) bad.push('凭证路径不在项目根（会被 U-73 或脏工作树夹住）');
  if (!/function Test-GateGreen/.test(PUB)) bad.push('发布器缺判据函数');
  if (!/if \(-not \$SkipGateGreen\) \{ throw/.test(PUB)) bad.push('发布器默认不拒绝（带红发布仍可过）');
  if (!/^\.gate-green\.json$/m.test(GI)) bad.push('.gitignore 未忽略凭证（会进库）');
  assert.deepEqual(bad, [], bad.join('; '));
  assert.equal(GATE_GREEN_REL, '.gate-green.json');
});

test('U-247-C 负例：作废也写 / 去掉默认拒绝 —— 各自判红', () => {
  const badOf = (runner, pub) => {
    const out = [];
    if (!/if \(!summary\.voided\) \{/.test(runner)) out.push('voided');
    if (!/if \(-not \$SkipGateGreen\) \{ throw/.test(pub)) out.push('refuse');
    return out;
  };
  assert.deepEqual(badOf(RUNNER, PUB), []);
  const alwaysWrite = RUNNER.replace('if (!summary.voided) {', 'if (true) {');
  assert.notEqual(alwaysWrite, RUNNER, '变异①未生效');
  assert.ok(badOf(alwaysWrite, PUB).includes('voided'), '作废轮也写凭证未被判红');
  // U-291（v1.71.0）：发布器现在有**两处**同形拒绝（Test-GateGreen / Test-PsGate）
  //   ⇒ 只改第一处的话第二处仍能命中，变异会假绿。这里改成全局替换：判据是"发布器还会不会拒绝"，
  //   而不是"某一行还在不在"。
  const noRefuse = PUB.split('if (-not $SkipGateGreen) { throw').join('if ($false) { throw');
  assert.notEqual(noRefuse, PUB, '变异②未生效');
  assert.ok(badOf(RUNNER, noRefuse).includes('refuse'), '发布器放行未被判红');
});
