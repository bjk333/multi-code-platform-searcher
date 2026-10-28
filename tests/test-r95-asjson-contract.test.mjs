// R95（远端 R1，2026-09-30）：机器可消费契约门 —— schema/asjson.schema.json 迁 JSON Schema 2020-12 + 严格字符门 + MCP 双写一致 + PS 三坑。
// 判据来源：reports/任务书-远端3轮-R94-R97-v2-2026-09-30.md §R95 A–D + PS 三坑。结构不变量可 hard-fail（§〇-6）。
// 轻量 2020-12 校验器只实现本 schema 用到的关键字；遇到未实现的关键字直接报名（不静默放行）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(rootDir, p), 'utf8');
const schemaText = read('schema/asjson.schema.json');
const schema = JSON.parse(schemaText);
const sampleText = read('reports/gates/u89-real-asjson.json');
// v1.54.0（B3-2）：函数在 lib/ ⇒ 读展开源码；但本门历史上**不扫 engines/**（那里是引擎实现，
//   有自己的坑位门），保持原范围，用 engines:false。
const mainSrc = sourceAll(rootDir, { engines: false });

// R2（2026-09-30）：validate / assertStrictJsonText 抽到 tests/asjson-validator.mjs（活体门 test-r96-live-payload 复用；直接 import 本测试文件会重复注册本文件的测试）
import { validate, assertStrictJsonText } from './asjson-validator.mjs';
import { sourceAll } from './lib/source.mjs';
export { validate, assertStrictJsonText };

// ---- A：2020-12 结构不变量 ----
export function assertDraft202012(s) {
  assert.equal(s.$schema, 'https://json-schema.org/draft/2020-12/schema', '$schema must be 2020-12');
  assert.ok(s.$id, '$id required');
  const text = JSON.stringify(s);
  assert.ok(!/"definitions"\s*:/.test(text), 'definitions must be migrated to $defs');
  assert.ok(!/"nullable"\s*:/.test(text), 'nullable is not JSON Schema; use type:["T","null"]');
  assert.ok(s.$defs && s.$defs.researchBatch, '$defs.researchBatch must exist');
  const walk = (node, where) => {
    if (!node || typeof node !== 'object') return;
    if (node.properties) {
      assert.equal(node.additionalProperties, false, `${where}: object with properties must be closed (additionalProperties:false)`);
      // 根：完整 required 落在 oneOf[0]（正常包）；_schemaError 是条件字段。结果项：双模条件字段（File/Stars/Line…）由 item oneOf 判别，只要求三件公共必填。
      const req = new Set([...(node.required ?? []), ...(where === '#' ? (node.oneOf?.[0]?.required ?? []) : [])]);
      const exempt = k => (where === '#' && k === '_schemaError') || where === '#/properties/results/items';
      const missing = Object.keys(node.properties).filter(k => !req.has(k) && !exempt(k));
      assert.deepEqual(missing, [], `${where}: required must list every property (conditional fields go through oneOf)`);
    }
    for (const [k, v] of Object.entries(node.properties ?? {})) walk(v, `${where}/properties/${k}`);
    if (node.items) walk(node.items, `${where}/items`);
  };
  walk(s, '#');
  assert.equal(s.oneOf?.length, 2, 'top-level oneOf must split payload vs _schemaError fallback');
  assert.equal(s.properties.results.items.oneOf?.length, 2, 'results items must discriminate code (File) vs repo/research');
}
test('R95-A: asjson.schema.json is JSON Schema 2020-12 ($schema/$defs, closed objects, full required, no nullable, top-level + item oneOf)', () => {
  assertDraft202012(schema);
});
test('R95-A negative: legacy definitions, nullable, an open object, or a dropped required are each rejected by name', () => {
  const a = structuredClone(schema); a.definitions = a.$defs; assert.throws(() => assertDraft202012(a), /definitions must be migrated/);
  const b = structuredClone(schema); b.properties.context.nullable = true; assert.throws(() => assertDraft202012(b), /nullable/);
  const c = structuredClone(schema); delete c.properties.completeness.additionalProperties; assert.throws(() => assertDraft202012(c), /completeness: object with properties must be closed/);
  const d = structuredClone(schema); d.properties.metrics.required = d.properties.metrics.required.filter(k => k !== 'Requests'); assert.throws(() => assertDraft202012(d), /metrics: required must list every property/);
  const e = structuredClone(schema); e.$schema = 'http://json-schema.org/draft-07/schema#'; assert.throws(() => assertDraft202012(e), /2020-12/);
});

// ---- B：oneOf 双模（真实样本通过；合成违约逐一报名） ----
test('R95-B: the real -AsJson sample validates; the _schemaError fallback shape validates; mixing them or breaking item discrimination is rejected', () => {
  const sample = JSON.parse(sampleText);
  validate(schema, sample);
  validate(schema, { version: sample.version, _schemaError: 'results[1] 缺字段 Stars', results: [], metrics: sample.metrics });
  const mixed = structuredClone(sample); mixed._schemaError = 'x';
  assert.throws(() => validate(schema, mixed), /oneOf matched 0 branches/);
  const fbWithCov = { version: '1', _schemaError: 'x', results: [], metrics: sample.metrics, coverage: sample.coverage };
  assert.throws(() => validate(schema, fbWithCov), /oneOf matched 0/);
  const noStars = structuredClone(sample); delete noStars.results[0].Stars;
  assert.throws(() => validate(schema, noStars), /results\[0\]: oneOf matched 0/);
  const codeItem = { Name: 'o/r', Platform: 'grep.app', Url: 'https://github.com/o/r/blob/main/a.go', File: 'a.go', Line: null, Preview: 'x', Flags: [] };   // R2：Flags 恒在（R96）
  const withCode = structuredClone(sample); withCode.results = [codeItem]; validate(schema, withCode);
  // 判别必须互斥：仓库项混入 File（或代码项混入 Stars）不得被任何一支接住（python-jsonschema 官方读数同口径，见 reports/gates/r94-remote-r1/）
  const repoWithFile = structuredClone(sample); repoWithFile.results[0].File = 'a.go';
  assert.throws(() => validate(schema, repoWithFile), /results\[0\]: oneOf matched 0/);
  const codeWithStars = structuredClone(sample); codeWithStars.results = [{ ...codeItem, Stars: 5 }];
  assert.throws(() => validate(schema, codeWithStars), /results\[0\]: oneOf matched 0/);
  const extraItemKey = structuredClone(sample); extraItemKey.results[0].Phantom = 1;
  assert.throws(() => validate(schema, extraItemKey), /unexpected key Phantom/);
  const noCompleteness = structuredClone(sample); delete noCompleteness.completeness;
  assert.throws(() => validate(schema, noCompleteness), /oneOf matched 0/);
});

// ---- C：严格字符门（JSON.parse 能过 ≠ 可安全消费） ----
test('R95-C: the real sample passes the strict character gate (no BOM, strict JSON, no zero-width/bidi/tag code points in any string)', () => {
  assertStrictJsonText(sampleText, 'u89-real-asjson.json');
});
test('R95-C negatives: bare newline in Reasons, leading BOM, and U+200B / U+202E / U+E0041 each turn the gate red', () => {
  const s = JSON.parse(sampleText);
  const key = Object.keys(s.coverage.Reasons)[0] ?? 'GitHub';
  const bare = JSON.stringify({ ...s, coverage: { ...s.coverage, Reasons: { [key]: 'MARK' } } }).replace('MARK', 'line1\nline2');
  assert.throws(() => assertStrictJsonText(bare), /not strict JSON/);
  assert.throws(() => assertStrictJsonText('\uFEFF' + sampleText), /leading BOM/);
  for (const cp of ['\u200B', '\u202E', '\u{E0041}']) {
    const t = JSON.stringify({ ...s, coverage: { ...s.coverage, Reasons: { [key]: 'ok' + cp + 'evil' } } });
    JSON.parse(t); // 说明：JSON.parse 本身放行
    assert.throws(() => assertStrictJsonText(t), /invisible\/bidi/);
  }
});
test('R95-C source: Reasons and warnings are sanitized at the -AsJson exit (upstream error text is not trusted)', () => {
  assert.match(mainSrc, /\$statusReasons\[\$en\] = \(Remove-InvisibleChars -Text \$reason\)/);
  assert.match(mainSrc, /\$warningsOut = @\(Get-EngineWarnings \| ForEach-Object \{ if \(\$_ -is \[string\]\) \{ Remove-InvisibleChars -Text \$_ \}/);
});

// ---- D：MCP 双写一致（content[0].text 解析 ≡ structuredContent）----
// 事实：本仓内尚无 MCP 包装器（grep structuredContent 只命中文档）⇒ 本门落成**包装器一致性校验函数** + 合成负例，供将来的包装器接入；不是端到端证据。
export function assertMcpDualWrite(result) {
  assert.ok(Array.isArray(result.content) && result.content[0]?.type === 'text', 'content[0] must be a text block');
  const parsed = assertStrictJsonText(result.content[0].text, 'content[0].text');
  assert.deepEqual(parsed, result.structuredContent, 'content[0].text must deep-equal structuredContent');
  validate(schema, result.structuredContent);
  assert.equal(result.isError ?? false, false, 'degraded/partial/none are not tool errors (U-123)');
}
test('R95-D: an MCP tool result built from the real sample dual-writes consistently; drift / non-text / isError are rejected', () => {
  const sc = JSON.parse(sampleText);
  const ok = { content: [{ type: 'text', text: sampleText }], structuredContent: sc, isError: false };
  assertMcpDualWrite(ok);
  const drift = structuredClone(ok); drift.structuredContent.metrics.ResultCount += 1;
  assert.throws(() => assertMcpDualWrite(drift), /deep-equal structuredContent/);
  assert.throws(() => assertMcpDualWrite({ ...ok, content: [{ type: 'image', data: '' }] }), /text block/);
  assert.throws(() => assertMcpDualWrite({ ...ok, isError: true }), /not tool errors/);
});

// ---- PS 三坑：-Depth 全出口显式 / 禁 -EscapeHandling（PS5.1 无此参数）/ JSON 写盘无 BOM ----
export function assertPsPitfalls(src) {
  const code = src.split('\n').filter(l => !/^\s*#/.test(l)).join('\n');
  const noDepth = [...code.matchAll(/ConvertTo-Json(?![^\n|)]*-Depth)[^\n|)]*/g)].map(m => m[0].trim());
  assert.deepEqual(noDepth, [], 'every ConvertTo-Json must pass -Depth explicitly: ' + noDepth.join(' ; '));
  assert.doesNotMatch(code, /-EscapeHandling/, 'PS 5.1 has no -EscapeHandling');
  const bomWrites = [...code.matchAll(/ConvertTo-Json[^\n]*\|\s*(?:Set-Content|Out-File)[^\n]*-Encoding\s+UTF8\b/g)].map(m => m[0]);
  assert.deepEqual(bomWrites, [], 'JSON written with Set-Content/Out-File -Encoding UTF8 gets a BOM on PS 5.1: ' + bomWrites.join(' ; '));
  assert.match(code, /WriteAllText\(\$CacheFile, \(\$out \| ConvertTo-Json -Depth 8\), \[System\.Text\.UTF8Encoding\]::new\(\$false\)\)/, 'cache JSON must be written BOM-less');
  assert.match(code, /Get-Content -LiteralPath \$CacheFile -Raw -Encoding UTF8/, 'cache must be read as UTF-8 explicitly (PS 5.1 defaults to ANSI for BOM-less files)');
}
test('R95 PS pitfalls: explicit -Depth on every ConvertTo-Json, no -EscapeHandling, BOM-less JSON cache writes with explicit UTF-8 reads', () => {
  assertPsPitfalls(mainSrc);
});
test('R95 PS pitfalls negatives: a depth-less ConvertTo-Json, -EscapeHandling, and a BOM-writing Set-Content are each reported', () => {
  const a = mainSrc.replace('ConvertTo-Json -Depth 3 -Compress', 'ConvertTo-Json -Compress'); assert.notEqual(a, mainSrc);
  assert.throws(() => assertPsPitfalls(a), /-Depth explicitly/);
  const b = mainSrc.replace('ConvertTo-Json -Depth 3 -Compress', 'ConvertTo-Json -Depth 3 -Compress -EscapeHandling EscapeNonAscii');
  assert.throws(() => assertPsPitfalls(b), /EscapeHandling/);
  const c = mainSrc.replace("[System.IO.File]::WriteAllText($CacheFile, ($out | ConvertTo-Json -Depth 8), [System.Text.UTF8Encoding]::new($false))", '$out | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $CacheFile -Encoding UTF8');
  assert.notEqual(c, mainSrc); assert.throws(() => assertPsPitfalls(c), /BOM/);
});
