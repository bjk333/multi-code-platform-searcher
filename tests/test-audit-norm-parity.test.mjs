// 批 A · A-6 把「0-6 同源门」接进全量门（此前它只是**孤立脚本**，CI 不跑 ⇒ 形同没有）
//
// 背景（2026-10-10 自查）：
//   `tools/audit/parity-check.ps1` 的头部自称"**产品语义被人改动必红**"，但它的入口**不在 `tests/`**，
//   ⇒ 全量门（`tests/run-node-gates.mjs`）**永远不会跑它**。更糟的是：**样本集覆盖不到"大写复数缩写"这族**
//   ⇒ 当天 R94 修复（`APIs→ap is` 改 `api`）**没有被它抓住**。
//
// 本门做两件事：
//   ① **行为**：真跑 parity-check，必须 PASS（腿①同源 PS↔Python / 腿①b期望 / 腿②未漂移）；
//   ② **守护判据**：样本集必须仍含那 7 条 `[A-Z]s` 一族样本且**带 expect**
//      —— 防有人删样本把门的"抓漂移"能力悄悄削弱（这正是当天发生的事的反面）。
//      ★这一条比 ① 更关键：门跑绿 ≠ 门有能力；**能力取决于样本覆盖**。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(testsDir, '..');
const SAMPLES = JSON.parse(fs.readFileSync(path.join(root, 'tools/audit/norm-samples.json'), 'utf8').replace(/^\uFEFF/, ''));

test('A-6a（能力守护）: 样本集必须含 [A-Z]s 一族且带 expect —— 否则门抓不住这类语义改动', () => {
  const MUST = [
    ['APIs', 'api'], ['UUIDs', 'uuid'], ['XMLs', 'xml'],          // 误伤族：大写复数缩写
    ['IOError', 'io error'], ['XMLHttpRequest', 'xml http request'], // 本意族：规则②不许被收紧坏
    ['retrievalAugmented', 'retrieval augmented'], ['MyClass', 'my class'], // 规则①族
  ];
  const byInput = new Map();
  for (const s of SAMPLES.normSamples) {
    if (typeof s === 'string') byInput.set(s, null);
    else byInput.set(s.input, s.expect ?? null);
  }
  const missing = [];
  for (const [input, expect] of MUST) {
    if (!byInput.has(input)) missing.push(`${input}（样本缺失）`);
    else if (byInput.get(input) !== expect) missing.push(`${input}（expect=${JSON.stringify(byInput.get(input))}，应为 ${JSON.stringify(expect)}）`);
  }
  console.log(`[A-6] 样本集 normSamples=${SAMPLES.normSamples.length} 条；[A-Z]s 一族 ${MUST.length - missing.length}/${MUST.length} 到位`);
  assert.deepEqual(missing, [],
    '★样本覆盖被削弱 —— 门会跑绿但抓不住这类改动（2026-10-10 当天的真实教训）:\n  ' + missing.join('\n  '));
  assert.match(String(SAMPLES._covers), /大写复数缩写/, '_covers 必须声明覆盖"大写复数缩写"');
});

test('A-6b（行为）: parity-check 必须 PASS（腿①同源 / 腿①b期望 / 腿②未漂移）', async () => {
  const script = path.join(root, 'tools/audit/parity-check.ps1');
  assert.ok(fs.existsSync(script), '同源门脚本必须存在: ' + script);
  const r = await new Promise(res => {
    const c = spawn('pwsh', ['-NoProfile', '-File', script], { cwd: root, windowsHide: true });
    let o = '', e = '';
    c.stdout.on('data', d => { o += d; }); c.stderr.on('data', d => { e += d; });
    c.on('error', x => { e += 'spawn: ' + x.message; });
    const t = setTimeout(() => c.kill('SIGKILL'), 180000);
    c.once('close', code => { clearTimeout(t); res({ code, o, e }); });
  });
  assert.equal(r.code, 0, '同源门必须 rc=0；实得 ' + r.code + '\n' + (r.o || r.e).slice(-600));
  const line = (r.o.split(/\r?\n/).find(l => /^RESULT:/.test(l)) || '').trim();
  assert.match(line, /^RESULT: PASS/, '结果行必须 PASS；实得: ' + line);
  assert.match(r.o, /\[0-6\] RESULT: PASS/, '必须出现 [0-6] RESULT: PASS');
  const norm = /norm=(\d+)/.exec(r.o);
  assert.ok(norm, '必须能解析出 norm 样本数（否则本门是空跑）');
  assert.ok(Number(norm[1]) >= 47, `norm 样本数应 ≥47（含本批新增 7 条），实得 ${norm[1]}`);
  console.log(`[A-6] ${line}；norm=${norm[1]}`);
});
