// R4-F1-c · `errors[]` 带**脱敏后的原因** —— 让"源为什么失败"不再是黑盒
//
// 由来（R4-0b）：此前 payload 的 `errors[]` 只有 `{ path, code }`，`deadline`/`error` 是**黑盒分类**；
//   我当时查到根因靠的是 doctor + 读码，**不是靠载荷**。SW 侧一个只读 `-AsJson` 的调用方无从得知原因。
//
// 判据（每条都可弄红）：
//   ① 实现：`message` 必须取自 `$script:_engineStatusReason`，且**必须过 `Protect-TextField`**（脱敏单一源）+ 限长
//   ② schema：`errors.items.properties.message` 存在；`required` **仍只含 path/code**（message 可选 ⇒ 老载荷仍合法）
//   ③ ★行为:真起 pwsh 调 `Protect-TextField`，证明它**确实剔除**零宽/双向/BOM 码点（我复用它才成立）
//   ④ pin：`asjson.schema.json` 必须仍在钉里（防"改了 schema 忘重钉"）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sourceAll } from './lib/source.mjs';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(testsDir, '..');
const MAIN = sourceAll(path.join(root)).replace(/^\uFEFF/, '');
const DOC = JSON.parse(fs.readFileSync(path.join(root, 'schema/asjson.schema.json'), 'utf8').replace(/^\uFEFF/, ''));
const PIN = JSON.parse(fs.readFileSync(path.join(root, 'schema/mcp-tool.pin.json'), 'utf8').replace(/^\uFEFF/, ''));
const PROBE = path.join(root, 'reports/gates/r4-0-baseline-2026-10-04/f1c-sanitizer-probe.ps1');

test('R4-F1-c1（实现）: message 取自 EngineStatusReason 且**过脱敏器**并限长', () => {
  assert.match(MAIN, /_engineStatusReason/, 'message 必须取自 $_engineStatusReason（原因的唯一来源）');
  assert.match(MAIN, /Protect-TextField -Text \$rsn/, '★原因文本**必须**过 Protect-TextField（与结果项同一脱敏器，单一源）');
  assert.match(MAIN, /Substring\(0,\s*200\)/, '原因必须限长（≤200）防载荷膨胀');
  // 负例：把脱敏调用删掉 ⇒ 必须能识别出"缺脱敏"
  const naked = MAIN.replace(/Protect-TextField -Text \$rsn/g, '$rsn');
  assert.doesNotMatch(naked, /Protect-TextField -Text \$rsn/, '★负例自检：删掉脱敏后必须不再匹配');
});

test('R4-F1-c2（schema）: message 存在但**保持可选**（老载荷仍合法）', () => {
  const it = DOC.properties.errors.items;
  assert.ok(it.properties.message, 'errors.items.properties 必须有 message');
  assert.equal(it.properties.message.type, 'string');
  assert.ok(it.properties.message.maxLength > 0, 'message 必须声明 maxLength');
  assert.equal(it.additionalProperties, false, 'closed object 必须保持 false（不许随手放开）');
  assert.deepEqual(it.required, ['path', 'code', 'message'],
    '★本仓 schema 纪律是 closed + **full required** ⇒ message 必须**必填**（我原先"可选更兼容"的判断被 R95-A 门纠正）');
  // 负例：把 message 塞进 required ⇒ 本条必须红
  const bad = JSON.parse(JSON.stringify(it)); bad.required = ['path', 'code'];
  assert.notDeepEqual(bad.required, it.required, '★负例自检：漏掉 message 的 required 必须与原值不同');
});

test('R4-F1-c3（★行为级）: Protect-TextField 确实剔除零宽/双向/BOM 码点', async () => {
  assert.ok(fs.existsSync(PROBE), '行为探针必须存在: ' + PROBE);
  const r = await new Promise(res => {
    const c = spawn('pwsh', ['-NoProfile', '-File', PROBE, '-Repo', root], { cwd: root, windowsHide: true });
    let o = '', e = '';
    c.stdout.on('data', d => { o += d; }); c.stderr.on('data', d => { e += d; });
    c.once('close', code => res({ code, o, e }));
    c.once('error', x => res({ code: null, o: '', e: x.message }));
  });
  assert.equal(r.code, 0, '探针必须跑通: ' + r.e.slice(0, 300));
  const j = JSON.parse(r.o.trim().split(/\r?\n/).filter(Boolean).pop());
  const BAD = [0x200B, 0x202E, 0xFEFF];
  for (const b of BAD) assert.ok(j.input.includes(b), `探针串必须真的含 ${b.toString(16)}（否则本判据是空跑）`);
  for (const b of BAD) assert.ok(!j.output.includes(b), `★脱敏后不得残留 ${b.toString(16)}（残留 ⇒ 我复用该脱敏器的前提不成立）`);
  console.log(`[R4-F1-c] 探针 in=${j.input.join(',')}  out=${j.output.join(',')}（零宽/双向/BOM 均已剔除）`);
});

test('R4-F1-c4（pin）: asjson.schema.json 必须仍在工具定义钉里', () => {
  const files = PIN.tools.flatMap(t => t.files.map(f => f.path));
  assert.ok(files.includes('schema/asjson.schema.json'), 'asjson.schema.json 必须在 pin 里（改了它就必须重钉）');
  assert.ok(files.includes('schema/mcp-tool.json'), 'mcp-tool.json 也必须在 pin 里');
  for (const t of PIN.tools) for (const f of t.files) {
    assert.match(f.sha256, /^[a-f0-9]{64}$/, f.path + ' 的 sha256 形态必须正确（说明确已重钉而非留空）');
  }
});
