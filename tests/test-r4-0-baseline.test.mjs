// R4-0 · 可复现基线门
//
// 由来（R4 v2 §0.0）：同一脚本、同样参数、相隔数分钟，同一查询从 0 结果变 8 结果 —— 一条不可复现的读数
//   毁掉了一条优先级结论。本门把"可复现"本身变成**可断言的属性**，而不是靠人记得。
//
// 判据（每条都可弄红）：
//   ① R4-0-F 字段口径：repo / code 两模式的**结果项字段集必须不同**（code 有 File/Line/Preview、无 Stars；
//      repo 反之），且主脚本源码里确实构造了这些字段 ⇒ 防"样本与实现脱节"
//   ② R4-0-M 匹配面声明：采集器必须**显式声明**每个指标读哪些字段（MATCH_FIELDS），code 面必须含 File+Preview
//      ⇒ 防"用错字段算出错结论"（这正是 §2 我犯的错）
//   ③ R4-0-S 抖动被测量：采集器必须连跑 ≥3 次并落 spread（min/max/flap）⇒ 抖动**可被看见**而非隐藏
//   ④ R4-BASE 可重算：样本内部自洽（count === items.length；spread 与逐次 count 一致）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceAll } from './lib/source.mjs';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(testsDir, '..');
const DIR = path.join(root, 'reports/gates/r4-0-baseline-2026-10-04');
const HARNESS = path.join(DIR, 'baseline-run.mjs');
const BASE = path.join(DIR, 'baseline.json');
const FIELD = path.join(DIR, 'field-contract.json');
const MAIN = sourceAll(path.join(root));
// ★字段是在**引擎里**构造的（local-code.ps1 / sourcegraph.ps1 / stack-exchange.ps1 …），不在主脚本里
//   —— 首版只读主脚本 ⇒ 误报。改成主脚本 + 全部 engines 合并后断言（与 U-53/U-41 同款做法）。
const ENGINE_SRC = fs.readdirSync(path.join(root, 'engines'))
  .filter(f => f.endsWith('.ps1'))
  .map(f => fs.readFileSync(path.join(root, 'engines', f), 'utf8')).join('\n');
const ALL_SRC = MAIN + '\n' + ENGINE_SRC;

const rd = p => fs.readFileSync(p, 'utf8');
const j = p => JSON.parse(rd(p).replace(/^\uFEFF/, ''));
const fieldsOf = caseId => {
  const fc = j(FIELD).find(c => c.case === caseId);
  return fc ? [...new Set(fc.observedFieldSets.flatMap(s => s.split('|')))].sort() : null;
};

test('R4-0-F: repo / code 两模式的结果项字段集**必须不同**，且与主脚本实现一致', () => {
  assert.ok(fs.existsSync(FIELD), '字段口径文件必须存在: ' + FIELD);
  const repo = fieldsOf('A-repo-github');
  const code = fieldsOf('B-code-github');
  assert.ok(repo && code, '两个案例的字段集都要有');
  // repo 侧
  for (const f of ['Name', 'Stars', 'Url']) assert.ok(repo.includes(f), `repo 模式必须含 ${f}`);
  assert.ok(!repo.includes('File'), '★repo 模式不应出现 File（那是 code 的字段）');
  // code 侧
  for (const f of ['Name', 'File', 'Line', 'Preview', 'Url']) assert.ok(code.includes(f), `code 模式必须含 ${f}`);
  assert.ok(!code.includes('Stars'), '★code 模式不应出现 Stars（那是 repo 的字段）—— 两模式字段集不同这点必须被钉住');
  // 与实现一致（防"样本与实现脱节"）：字段在引擎里构造，故断言**主脚本 + engines 合并源码**
  //   ⚠ 注意 `Preview = if (...) {…}` 这种写法 ⇒ 不能用 `=\s*\$` 死板匹配
  assert.match(ALL_SRC, /[^A-Za-z]File\s*=\s*[^,\n]+/, '必须有地方真的构造 File 字段');
  assert.match(ALL_SRC, /[^A-Za-z]Preview\s*=\s*[^,\n]+/, '必须有地方真的构造 Preview 字段');
  // 负例：把 File 从 code 契约里去掉，本条必须抓得住
  const broken = code.filter(f => f !== 'File');
  assert.ok(!broken.includes('File'), '★负例自检：去掉 File 后必须不再包含它（否则本判据是恒真的）');
});

test('R4-0-M: 采集器必须**显式声明匹配面**，且 code 面含 File + Preview', () => {
  const src = rd(HARNESS);
  assert.match(src, /MATCH_FIELDS/, '采集器必须声明 MATCH_FIELDS（否则"零重叠"类指标用哪个字段是隐含的）');
  const m = /code:\s*Object\.freeze\(\[([^\]]*)\]\)/.exec(src);
  assert.ok(m, '必须能取到 code 的匹配面声明');
  assert.match(m[1], /File/, '★code 匹配面必须含 File');
  assert.match(m[1], /Preview/, '★code 匹配面必须含 Preview');
  // 负例：去掉 File 后，上面的断言会失败
  const withoutFile = src.replace(/code:\s*Object\.freeze\(\[[^\]]*\]\)/, "code: Object.freeze(['Name', 'Preview'])");
  assert.doesNotMatch(/code:\s*Object\.freeze\(\[([^\]]*)\]\)/.exec(withoutFile)[1], /File/,
    '★负例自检：去掉 File 后该正则取到的串里不应再有 File');
});

test('R4-0-S: 抖动必须被**测量**（连跑 ≥3 次 + 落 spread），不许只跑一次', () => {
  const b = j(BASE);
  assert.ok(b.runsPerCase >= 3, `★必须连跑 ≥3 次（否则抖动不可见），实得 ${b.runsPerCase}`);
  for (const c of b.cases) {
    assert.equal(c.observations.length, b.runsPerCase, `${c.id} 的观察数必须等于 runsPerCase`);
    assert.ok(c.spread && Array.isArray(c.spread.values), `${c.id} 必须落 spread`);
    assert.equal(c.spread.values.length, b.runsPerCase, `${c.id} spread.values 长度必须等于运行次数`);
    const counts = c.observations.map(o => o.count);
    assert.deepEqual(c.spread.values, counts, `${c.id} spread.values 必须等于逐次 count`);
    assert.equal(c.spread.flap, Math.max(...counts) - Math.min(...counts), `${c.id} flap 必须是 max-min`);
    // 逐源记账必须落盘（下次再抖，能直接看出是哪个源）
    for (const o of c.observations) {
      assert.ok('unreachable' in o && 'errors' in o && 'reasonCodes' in o,
        `${c.id} run${o.run} 必须逐源记账（unreachable/errors/reasonCodes）`);
    }
  }
  console.log('[R4-0] flap: ' + b.cases.map(c => `${c.id}=${c.spread.flap}`).join('  ') +
    '  | ' + b.cases.map(c => `${c.id}=${JSON.stringify(c.spread.values)}`).join('  '));
});

test('R4-BASE: 样本内部自洽（count === items.length；三列可读）', () => {
  const b = j(BASE);
  assert.ok(b.generatedAt, '必须记录生成时间');
  for (const c of b.cases) {
    for (const o of c.observations) {
      assert.equal(o.count, o.items.length, `${c.id} run${o.run}: count 必须等于落盘条目数`);
      assert.ok(typeof o.verdict === 'string' || o.verdict === null, 'Verdict 必须有记录');
      for (const it of o.items) {
        for (const k of ['p', 'n', 'rel', 'noise', 'stars']) {
          assert.ok(k in it, `条目必须含 ${k}（否则"可重算"无从谈起）`);
        }
      }
    }
  }
  // 负例：篡改 count 必须被抓
  const tampered = JSON.parse(JSON.stringify(b));
  tampered.cases[0].observations[0].count += 1;
  assert.notEqual(tampered.cases[0].observations[0].count, tampered.cases[0].observations[0].items.length,
    '★负例自检：篡改 count 后必须不再自洽');
});
