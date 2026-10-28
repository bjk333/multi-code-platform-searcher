// U-276（v1.58.0，验收 B3-5）：**变异抽检** —— 证明"行为绿"到底是不是"无效绿"。
//
// 病在哪：行为门全绿有两种含义 —— "行为对"或"门看不见这段代码"。日志里两者一模一样。
//   设计文档 §5 规则 6 要求月度抽检：往产品里注入小改动，门**仍然全绿** ⇒ 判 `invalid-green`。
//
// 本门分五层：
//   A 变更行：行集合差（口径与已知盲区都钉住）
//   B 变体生成：只在代码位下手（字符串/注释里的算子不算），一行一个，确定性
//   C 打分与判决：stillborn / error / 空候选 / 零杀 各自归哪一档
//   D **活体**：一个真产品（tiny.ps1）+ 一条真门（spawn 它），跑完整条链 ——
//      零杀 ⇒ invalid-green；杀掉一半 ⇒ weak；基线不绿 ⇒ inconclusive
//   E 诚实边界：没有基线就拒绝跑、语法自检真的能认出坏文件、报告里必须写清用了哪些门
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { changedLines, mutantsFor, codeMask, applyMutants, scoreResults, verdictOf, exitCodeForVerdict, PS_MUTATORS } from './lib/mutation.mjs';
import { sweep, parsesOk } from './mutation-sweep.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('U-276-A: 变更行 = 行集合差（多报无害，漏报才是致命的；已知盲区钉住）', () => {
  assert.deepEqual(changedLines('a\nb\nc', 'a\nb\nc'), [], '同一份文本 ⇒ 没有变更行');
  assert.deepEqual(changedLines('a\nb\nc', 'a\nB\nc'), [2], '改一行 ⇒ 只报那一行');
  assert.deepEqual(changedLines('a\nb', 'a\nb\nc\nd'), [3, 4], '尾部新增 ⇒ 报新增行');
  assert.deepEqual(changedLines('', 'x\ny'), [1, 2], '空基线（新文件）⇒ 全部是变更行');
  // 已知盲区：与基线**完全相同**的新行不会被认成变更（多半是 `}`、空行）。
  //   钉住它，是为了让"为什么这条改动没被抽到"有据可查，而不是等到某天发现漏测。
  assert.deepEqual(changedLines('a\nb', 'a\nb\nb'), [], '重复了基线里已有的行 ⇒ 盲区（不报）');
  // 空行不参与
  assert.deepEqual(changedLines('a', 'a\n\n\n'), []);
  // CRLF：按 trimEnd 归一，不许因为行尾把整份文件判成"全变了"
  assert.deepEqual(changedLines('a\r\nb', 'a\nb'), []);
});

test('U-276-B: 变体只在代码位下手（注释/字符串里的算子必须跳过），一行一个', () => {
  // codeMask：引号内与 # 之后都是 0，代码位是 1
  const line = `if ($a -eq 'x') { }  # 这里写 -ne`;
  const m = codeMask(line);
  assert.equal(m[line.indexOf('-eq')], 1, '-eq 在代码位');
  assert.equal(m[line.indexOf("'x'") + 1], 0, '单引号字符串里的字符不算代码位');
  assert.equal(m[line.indexOf('这里写')], 0, '注释里的字符不算代码位');
  assert.equal(m[line.indexOf('{')], 1, '字符串之后回到代码位');

  const one = (l) => mutantsFor({ file: 'x.ps1', headText: 'p\n' + l + '\nz', changeLines: [2] });

  let r = one('if ($a -eq $b) { }');
  assert.equal(r.length, 1); assert.equal(r[0].op, 'eq-ne'); assert.equal(r[0].to, '-ne');
  assert.equal(r[0].after, 'if ($a -ne $b) { }');

  assert.deepEqual(one("$s = '-eq'"), [], '字符串里的 -eq 不是算子');
  assert.deepEqual(one('# 整行注释：-eq'), [], '整行注释里没有代码位');
  assert.equal(one('if ($a -eq $b) { }  # 这里写 -ne').length, 1, '注释里再写一个算子也只出一个');
  assert.deepEqual(one('$x = $y -notlike "a*"'), [], '-notlike 不是 -not（正则必须带空白）');
  assert.equal(one('$x = -not $y')[0].op, 'not-drop');

  // 一行两个算子 ⇒ 只出第一个（确定性，不随机）
  r = one('if (($a -eq $b) -and ($c -gt $d)) { }');
  assert.equal(r.length, 1); assert.equal(r[0].op, 'eq-ne');

  // 上限与顺序：按变更行顺序、最多 max 个
  const head = 'l1\nif ($a -eq $b) {}\nif ($c -gt $d) {}\nif ($e -and $f) {}\n';
  const all = mutantsFor({ file: 'x.ps1', headText: head, changeLines: [2, 3, 4] });
  assert.deepEqual(all.map((x) => [x.line, x.op]), [[2, 'eq-ne'], [3, 'gt-ge'], [4, 'and-or']]);
  assert.equal(mutantsFor({ file: 'x.ps1', headText: head, changeLines: [2, 3, 4], max: 2 }).length, 2);

  // 每个算子都必须真的咬到（不是"表里写了但正则永远不匹配"）。
  //   ★样本里只能有**这一个**算子：一行只出一个变体，混进别的算子会测到错的那条。
  const SAMPLES = {
    'eq-ne': 'if ($a -eq $b) { }', 'ne-eq': 'if ($a -ne $b) { }',
    'gt-ge': 'if ($a -gt $b) { }', 'ge-gt': 'if ($a -ge $b) { }',
    'lt-le': 'if ($a -lt $b) { }', 'le-lt': 'if ($a -le $b) { }',
    'and-or': 'if ($a -and $b) { }', 'or-and': 'if ($a -or $b) { }',
    'true-false': '$x = $true', 'false-true': '$x = $false', 'not-drop': '$x = -not $y',
  };
  assert.deepEqual(PS_MUTATORS.map((o) => o.id).sort(), Object.keys(SAMPLES).sort(), '算子表与样本表必须一一对应（加了算子就要给样本）');
  for (const op of PS_MUTATORS) {
    const hit = one(SAMPLES[op.id]);
    assert.equal(hit.length, 1, `算子 ${op.id} 在样本上没有命中：${SAMPLES[op.id]}`);
    assert.equal(hit[0].op, op.id, `样本 ${SAMPLES[op.id]} 命中的是 ${hit[0].op}，不是 ${op.id}`);
  }

  // applyMutants 只改那一行，其余原样
  const src = 'line1\nif ($a -eq $b) { }\nline3';
  assert.equal(applyMutants(src, mutantsFor({ file: 'x.ps1', headText: src, changeLines: [2] })), 'line1\nif ($a -ne $b) { }\nline3');
});

test('U-276-C: 打分与判决 —— 空候选/零杀/语法坏/跑不成，四档必须分开', () => {
  const k = (n) => Array.from({ length: n }, (_, i) => ({ file: 'a.ps1', line: i + 1, op: 'x', status: 'killed' }));
  const s = (n) => Array.from({ length: n }, (_, i) => ({ file: 'a.ps1', line: i + 1, op: 'x', status: 'survived' }));

  let sc = scoreResults([...k(1), ...s(1)]);
  assert.equal(sc.overall.total, 2); assert.equal(sc.overall.killed, 1); assert.equal(sc.overall.score, 0.5);

  // 零杀 ⇒ invalid-green（设计文档 §5 规则 6 点名的那一档）
  assert.equal(verdictOf(scoreResults(s(2)), {}).verdict, 'invalid-green');
  // 空候选 ⇒ 不是绿
  assert.equal(verdictOf(scoreResults([]), { candidates: 0 }).verdict, 'no-candidates');
  // 语法坏 ⇒ 算子 bug（**不许**算成 killed；否则语法错误会让分数虚高）
  assert.equal(verdictOf(scoreResults([{ file: 'a', line: 1, op: 'x', status: 'stillborn' }, ...k(1)]), {}).verdict, 'mutator-bug');
  // 跑不成 ⇒ 不可用
  assert.equal(verdictOf(scoreResults([...k(1), { file: 'a', line: 2, op: 'x', status: 'error' }]), {}).verdict, 'inconclusive');
  // 分数低 ⇒ weak（但仍是绿：退出码 0）
  assert.equal(verdictOf(scoreResults([...k(1), ...s(3)]), { minScore: 0.5 }).verdict, 'weak');
  assert.equal(verdictOf(scoreResults([...k(3), ...s(1)]), { minScore: 0.5 }).verdict, 'ok');

  // stillborn / error 不进分母
  sc = scoreResults([...k(1), ...s(1), { file: 'a', line: 3, op: 'x', status: 'stillborn' }, { file: 'a', line: 4, op: 'x', status: 'error' }]);
  assert.equal(sc.overall.total, 2); assert.equal(sc.overall.stillborn, 1); assert.equal(sc.overall.error, 1);

  // 退出码：只有 invalid-green 及以上算"不许过"
  assert.equal(exitCodeForVerdict('ok'), 0);
  assert.equal(exitCodeForVerdict('weak'), 0);
  assert.equal(exitCodeForVerdict('no-candidates'), 0, '空候选退出码 0，但会大声打印"这不是绿"');
  assert.equal(exitCodeForVerdict('invalid-green'), 1);
  assert.equal(exitCodeForVerdict('mutator-bug'), 2);
  assert.equal(exitCodeForVerdict('inconclusive'), 3);
});

// ---- D/E 的夹具：一个真产品 + 一条真门（spawn 它跑） ----
const BASE_TINY = [
  'param([int]$N = 5)',
  '$limit = 10',
  "if ($N -ge $limit) { $tag = 'over' } else { $tag = 'under' }",
  'if ($N -eq 4) { $tag = "$tag/five" } else { $tag = "$tag/other" }',
  'Write-Output $tag',
  '',
].join('\n');
const HEAD_TINY = BASE_TINY.replace('$N -ge $limit', '$N -gt $limit').replace('$N -eq 4', '$N -eq 5');

// 夹具门也**用异步 spawn**：R2 卫生门有一条硬规矩 —— 做击杀计数的文件不得出现同步 spawn
// （宿主垫片让 spawnSync 恒 EBUSY、status=null ⇒ "没跑成"会被读成"变异被杀"，凭空加分）。
// 夹具是这门课的一部分，不能自己先违规。
const TINY_GATE = `import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const run = (args) => new Promise((resolve, reject) => {
  const c = spawn(process.env.MCPS_PWSH || 'pwsh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  c.stdout.on('data', (d) => { out += d; });
  c.stderr.on('data', (d) => { err += d; });
  c.once('error', reject);
  c.once('exit', (code) => resolve({ code, out, err }));
});
test('tiny 产品输出', async () => {
  const r = await run(['-NoProfile', '-NonInteractive', '-File', path.join(here, '..', 'tiny.ps1')]);
  assert.equal(String(r.out || '').trim(), 'under/five');
});
`;

function makeFixture({ headTiny = HEAD_TINY, gate = TINY_GATE } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'u276-'));
  const head = path.join(root, 'head'); const base = path.join(root, 'base');
  fs.mkdirSync(path.join(head, 'tests'), { recursive: true });
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(head, 'tiny.ps1'), headTiny);
  fs.writeFileSync(path.join(base, 'tiny.ps1'), BASE_TINY);
  fs.writeFileSync(path.join(head, 'tests', 'tiny-gate.test.mjs'), gate);
  return { root, head, base };
}
const OPTS = (fx, extra = {}) => ({ root: fx.head, base: fx.base, paths: ['tiny.ps1'], gates: ['tests/tiny-gate.test.mjs'], ...extra });

test('U-276-D: 活体 —— 零杀判 invalid-green，杀掉一半判 weak（整条链真跑，含基线）', async () => {
  const fx = makeFixture();
  try {
    // max=1 ⇒ 只抽到第 3 行的 `-gt`→`-ge`。测试对 N=5 断言 under/five，-ge 与 -gt 在这一输入下等价
    //   ⇒ 门**看不见**这次改动 ⇒ invalid-green。
    const r1 = await sweep(OPTS(fx, { max: 1 }));
    assert.equal(r1.candidates, 1);
    assert.equal(r1.baseline.productRed, 0, '基线必须绿：' + JSON.stringify(r1.baseline));
    assert.equal(r1.results[0].status, 'survived', JSON.stringify(r1.results));
    assert.equal(r1.verdict.verdict, 'invalid-green', r1.verdict.why);
    assert.equal(exitCodeForVerdict(r1.verdict.verdict), 1);

    // max=2 ⇒ 第二个变体（`-eq 5`→`-ne`）会让输出变 other ⇒ 必被那条门杀掉。
    const r2 = await sweep(OPTS(fx, { max: 2, minScore: 0.8 }));
    assert.equal(r2.candidates, 2);
    assert.deepEqual(r2.results.map((x) => x.status), ['survived', 'killed'], JSON.stringify(r2.results));
    assert.equal(r2.score.overall.killed, 1);
    assert.equal(r2.verdict.verdict, 'weak', r2.verdict.why);
    assert.equal(r2.gates.length, 1, '报告必须写清用了哪些门（分数只对这个门集有效）');
    assert.match(r2.gates[0], /tiny-gate\.test\.mjs$/);
  } finally { fs.rmSync(fx.root, { recursive: true, force: true, maxRetries: 5 }); }
});

test('U-276-D2: 基线不绿就拒绝给分（否则任何"变红"都可能是变异之外的既有失败）', async () => {
  // ★注入点必须**唯一**：第一版写成 replace('under/five', …)，命中的是上面那条用例标题，
  //   断言里的 'under/five' 没被换掉 ⇒ 门照样绿 ⇒ 这个测试测的是「夹具没坏」而不是「基线红会被拒」。
  const badGate = TINY_GATE.replace("trim(), 'under/five'", "trim(), 'never-matches'");
  assert.notEqual(badGate, TINY_GATE, '变异必须真的咬到断言（否则下面测的是别的东西）');
  const fx = makeFixture({ gate: badGate });
  try {
    const r = await sweep(OPTS(fx, { max: 1 }));
    assert.equal(r.verdict.verdict, 'inconclusive');
    assert.match(r.verdict.why, /基线不绿/);
    assert.equal(r.results[0].status, 'error');
    assert.equal(r.results[0].why, 'baseline-red');
  } finally { fs.rmSync(fx.root, { recursive: true, force: true, maxRetries: 5 }); }
});

test('U-276-E: 诚实边界 —— 没有基线不许跑、语法自检认得坏文件、空候选不是绿', async () => {
  const fx = makeFixture();
  try {
    await assert.rejects(() => sweep({ root: fx.head, paths: ['tiny.ps1'], gates: ['tests/tiny-gate.test.mjs'] }), /必须给 --base/);

    // 语法自检：坏文件必须被判 stillborn，否则"语法坏 ⇒ 所有门都红 ⇒ 全部 killed"会让分数虚高
    const bad = path.join(fx.root, 'bad.ps1');
    fs.writeFileSync(bad, 'if ($a -eq ) {\n', 'utf8');
    assert.equal(await parsesOk(bad), false);
    assert.equal(await parsesOk(path.join(fx.head, 'tiny.ps1')), true);

    // 基线 == head ⇒ 没有变更行 ⇒ no-candidates（不是绿，也不跑门）
    const r = await sweep({ root: fx.head, base: fx.head, paths: ['tiny.ps1'], gates: ['tests/tiny-gate.test.mjs'] });
    assert.equal(r.candidates, 0);
    assert.equal(r.verdict.verdict, 'no-candidates');
    assert.equal(r.gates.length, 0, '没跑门就不许在报告里写门集（否则读起来像"跑过了"）');
  } finally { fs.rmSync(fx.root, { recursive: true, force: true, maxRetries: 5 }); }
});
