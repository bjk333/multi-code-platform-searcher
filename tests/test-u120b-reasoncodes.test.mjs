// U-120b（C8，2026-09-28）：coverage.ReasonCodes —— 逐引擎机器可读原因码，且 MCPS_DISABLE 引擎以 user-disabled 进 ReasonCodes、不进 Requested（宿主 R64 §1.2）。
// 运行时证据：reports/gates/u120-c8/post-b-*.json（容器实跑，见 post-b-runs.txt）。本门只做静态一致性 + 对留档样本做判据断言。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceAll } from './lib/source.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mainSrc = sourceAll(path.join(rootDir));
const schema = JSON.parse(fs.readFileSync(path.join(rootDir, 'schema/asjson.schema.json'), 'utf8').replace(/^\uFEFF/, ''));
// ★B2-1（U-264，v1.53.33）：13 值 = 原 12 + `quota-exhausted`（v2 新增：402 / 余额不足）。
//   这条门的题目就是「脚本发出的码集 == schema 描述的码集」—— 只加 schema 或只加脚本都必须红。
const CODES = ['missing-credential', 'tool-missing', 'network-unavailable', 'forbidden', 'rate-limited', 'deadline', 'error', 'budget-truncated', 'filtered', 'zero-hit', 'not-run', 'user-disabled', 'quota-exhausted'];

// ★A 副本（C://Users//<u>//.workbuddy//skills//...）**不含** reports/gates/u120-c8 —— reports 不进发货清单。
//   本门的两条"证据型"用例（对历史留档样本做断言）在那里必然 ENOENT。做法是**显式 skip** 而不是让它红：
//   一条恒红的门会训练人忽略红，比没有门更糟。★B 侧（源仓）证据一定在 ⇒ 这里 skip 不会让门假绿。
const EVID_DIR = path.join(rootDir, 'reports/gates/u120-c8');
const NO_EVID = fs.existsSync(EVID_DIR) ? false : 'A 副本不含 reports/gates/u120-c8（证据目录不进发货清单）；源仓必跑';

function checkSource(src) {
  assert.match(src, /^\s*ReasonCodes\s*=\s*\$reasonCodes\s*$/m, 'coverage literal must carry ReasonCodes = $reasonCodes');
  for (const c of CODES) assert.ok(src.includes(`'${c}'`), `source must emit code '${c}'`);
  // user-disabled 只对"未被请求"的引擎写入（Requested 语义不动）
  assert.match(src, /if \(\$requestedEngines -notcontains \$e\.Name\) \{ \$reasonCodes\[\$e\.Name\] = 'user-disabled' \}/, 'user-disabled must be gated on NOT in Requested');
}

test('U-120b: ReasonCodes is emitted by the script and described by the schema with the same code set', () => {
  checkSource(mainSrc);
  const rc = schema.properties.coverage.properties.ReasonCodes;
  assert.ok(rc, 'schema coverage.ReasonCodes missing');
  assert.deepEqual([...rc.additionalProperties.enum].sort(), [...CODES].sort());
  assert.ok(schema.properties.coverage.required.includes('ReasonCodes'));
});

test('U-120b: recorded runs — disabled engines appear in ReasonCodes as user-disabled and never in Requested; blocked engines map to missing-credential', { skip: NO_EVID }, () => {
  const load = f => JSON.parse(fs.readFileSync(path.join(rootDir, 'reports/gates/u120-c8', f), 'utf8').replace(/^\uFEFF/, '')).coverage;
  const w4 = load('post-b-W4-repo-disabled.json');   // MCPS_DISABLE=gitee,codeberg -Platform All
  for (const e of ['Gitee', 'Codeberg']) {
    assert.equal(w4.ReasonCodes[e], 'user-disabled');
    assert.ok(!w4.Requested.includes(e), `${e} must not be in Requested`);
  }
  const w5 = load('post-b-W5-research-disabled.json'); // MCPS_DISABLE=arxiv
  assert.equal(w5.ReasonCodes.arXiv, 'user-disabled');
  assert.ok(!w5.Requested.includes('arXiv'));
  const w6 = load('post-b-W6-code.json');              // 容器无令牌
  assert.equal(w6.Verdict, 'none');
  for (const e of w6.Blocked) assert.equal(w6.ReasonCodes[e], 'missing-credential');
  // 负例样本：-Platform GitHub + MCPS_DISABLE=gitee ⇒ Gitee 本就不会被请求，不得被当成 user-disabled 混入
  const neg = load('post-b-neg-platform-github.json');
  assert.deepEqual(neg.ReasonCodes, {});
  // 通用：ReasonCodes 里的值都在枚举内；Executed 且 ok 的引擎不出现
  for (const c of [w4, w5, w6, neg]) for (const [k, v] of Object.entries(c.ReasonCodes)) assert.ok(CODES.includes(v), `${k}:${v}`);
});

test('U-120b negative control (host R65 §3.1): a ReasonCodes value outside the schema enum is rejected by name', { skip: NO_EVID }, () => {
  const enumSet = schema.properties.coverage.properties.ReasonCodes.additionalProperties.enum;
  const sample = JSON.parse(fs.readFileSync(path.join(rootDir, 'reports/gates/u89-real-asjson.json'), 'utf8').replace(/^\uFEFF/, ''));
  const validate = cov => { for (const [k, v] of Object.entries(cov.ReasonCodes)) assert.ok(enumSet.includes(v), `ReasonCodes[${k}]='${v}' not in schema enum`); };
  validate(sample.coverage);
  const bad = structuredClone(sample.coverage); bad.ReasonCodes.Gitee = 'timeout';
  assert.throws(() => validate(bad), /ReasonCodes\[Gitee\]='timeout' not in schema enum/);
});

test('U-120b negative control: dropping the user-disabled branch (or the not-in-Requested guard) is detected', () => {
  const guard = "if ($requestedEngines -notcontains $e.Name) { $reasonCodes[$e.Name] = 'user-disabled' }";
  assert.ok(mainSrc.includes(guard));
  const mutated = mainSrc.replace(guard, "$reasonCodes[$e.Name] = 'user-disabled'");
  assert.notEqual(mutated, mainSrc);
  assert.throws(() => checkSource(mutated), assert.AssertionError);
});
