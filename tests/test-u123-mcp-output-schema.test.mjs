// U-123（2026-09-28）：MCP outputSchema 对齐门。
// 依据：MCP 规范 2025-06-18 server/tools（Tool = name/title/description/inputSchema/outputSchema/annotations；structuredContent MUST conform to outputSchema；
// 执行失败用 isError，协议错误用 JSON-RPC error）。本门：① schema/mcp-tool.json 结构；② outputSchema $ref 落到 asjson.schema.json；
// ③ 真实样本 reports/gates/u89-real-asjson.json 能通过 outputSchema（轻量校验器：type/required/properties/additionalProperties/enum/items）；
// ④ x-ps-param 全部对应脚本 param；⑤ 引擎链.md 有字段对照且写明 degraded/partial 不用 isError。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(rootDir, p), 'utf8').replace(/^\uFEFF/, '');
const tool = JSON.parse(read('schema/mcp-tool.json'));
const asjson = JSON.parse(read('schema/asjson.schema.json'));
const mainSrc = read('multi-platform-searcher.ps1');
const chainDoc = read('references/引擎链.md');
const sample = JSON.parse(read('reports/gates/u89-real-asjson.json'));

function miniValidate(schema, data, where = '$') {
  if (schema.$ref) {
    if (schema.$ref === 'asjson.schema.json') return miniValidate(asjson, data, where);
    assert.match(schema.$ref, /^#\//, 'only the asjson file ref or internal JSON-pointer refs are supported: ' + schema.$ref);
    const target = schema.$ref.slice(2).split('/').reduce((o, k) => o[k], asjson);
    return miniValidate(target, data, where);
  }
  const types = [].concat(schema.type || []);
  const jsType = data === null ? 'null' : Array.isArray(data) ? 'array' : typeof data === 'number' ? (Number.isInteger(data) ? 'integer' : 'number') : typeof data;
  if (types.length) assert.ok(types.includes(jsType) || (jsType === 'integer' && types.includes('number')), `${where}: type ${jsType} not in [${types}]`);
  if (schema.enum) assert.ok(schema.enum.includes(data), `${where}: value ${JSON.stringify(data)} not in enum`);
  // R95（2026-09-30）：schema 迁 2020-12 后用到 const / minimum / maxItems / oneOf / anyOf / not —— 轻量校验器同批补齐（不实现即漏判）
  if ('const' in schema) assert.ok(schema.const === data, `${where}: value ${JSON.stringify(data)} != const`);
  if (schema.minimum !== undefined && typeof data === 'number') assert.ok(data >= schema.minimum, `${where}: below minimum`);
  if (jsType === 'array' && schema.maxItems !== undefined) assert.ok(data.length <= schema.maxItems, `${where}: more than ${schema.maxItems} items`);
  const passes = n => { try { miniValidate(n, data, where); return true; } catch { return false; } };
  if (schema.oneOf) { const n = schema.oneOf.filter(passes).length; assert.equal(n, 1, `${where}: oneOf matched ${n} branches`); }
  if (schema.anyOf) assert.ok(schema.anyOf.some(passes), `${where}: anyOf matched none`);
  if (schema.not) assert.ok(!passes(schema.not), `${where}: matched a forbidden (not) schema`);
  if (jsType === 'object') {
    for (const r of schema.required || []) assert.ok(r in data, `${where}: missing required ${r}`);
    for (const [k, v] of Object.entries(data)) {
      if (schema.properties && k in schema.properties) miniValidate(schema.properties[k], v, `${where}.${k}`);
      else if (schema.additionalProperties === false) assert.fail(`${where}: unexpected key ${k}`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') miniValidate(schema.additionalProperties, v, `${where}.${k}`);
    }
  }
  if (jsType === 'array' && schema.items) data.forEach((it, i) => miniValidate(schema.items, it, `${where}[${i}]`));
}
function checkTool(t) {
  assert.match(t.name, /^[A-Za-z0-9_-]{1,64}$/, 'tool name');
  for (const k of ['description', 'inputSchema', 'outputSchema']) assert.ok(t[k], `tool.${k} missing`);
  assert.equal(t.inputSchema.type, 'object');
  assert.ok(t.inputSchema.required.includes('keyword'));
  assert.deepEqual(t.outputSchema, { $ref: 'asjson.schema.json' }, 'outputSchema must reference the -AsJson contract file');
  assert.ok(t.annotations && t.annotations.readOnlyHint === true && t.annotations.openWorldHint === true);
  const paramBlock = mainSrc.slice(0, mainSrc.indexOf('$script:Cfg = @{'));
  for (const [k, p] of Object.entries(t.inputSchema.properties)) {
    assert.ok(p['x-ps-param'], `inputSchema.${k} lacks x-ps-param`);
    for (const ps of p['x-ps-param'].split('|')) assert.ok(new RegExp('\\$' + ps + '\\b').test(paramBlock), `inputSchema.${k}: script has no param -${ps}`);
  }
  assert.equal(t.inputSchema.properties.minStars.default, 0, 'MCP default minStars must be 0 (r60 root cause)');
}

test('U-123: schema/mcp-tool.json is a well-formed MCP Tool whose outputSchema is the -AsJson contract, and the real sample validates against it', () => {
  checkTool(tool);
  miniValidate(tool.outputSchema, sample);
  assert.ok(asjson.properties.coverage.properties.ReasonCodes, 'outputSchema must carry coverage.ReasonCodes (U-120b)');
});

test('U-123: 引擎链.md carries the MCP field mapping and the isError rule (degraded/partial are not tool errors)', () => {
  assert.match(chainDoc, /## MCP 字段对照（U-123/);
  assert.match(chainDoc, /structuredContent/);
  assert.match(chainDoc, /`Verdict=partial\/degraded\/none`[^\n]*`isError:false`/, 'doc must state partial/degraded/none ⇒ isError:false');
});

test('U-123 negative controls: an extra top-level key in the payload, a wrong Verdict value, and a dropped outputSchema are all rejected by name', () => {
  const extra = structuredClone(sample); extra.phantom = 1;
  assert.throws(() => miniValidate(tool.outputSchema, extra), /unexpected key phantom/);
  const badVerdict = structuredClone(sample); badVerdict.coverage.Verdict = 'ok';
  assert.throws(() => miniValidate(tool.outputSchema, badVerdict), /coverage\.Verdict: value "ok" not in enum/);
  const mixed = structuredClone(sample); mixed._schemaError = 'x';
  assert.throws(() => miniValidate(tool.outputSchema, mixed), /oneOf matched 0 branches/, 'R95: payload + _schemaError must match neither oneOf branch');
  const noFile = structuredClone(sample); delete noFile.results[0].Stars;
  assert.throws(() => miniValidate(tool.outputSchema, noFile), /results\[0\]: oneOf matched 0 branches/, 'R95: repo item without Stars and without File is rejected');
  const noOut = structuredClone(tool); delete noOut.outputSchema;
  assert.throws(() => checkTool(noOut), /tool\.outputSchema missing/);
  const badParam = structuredClone(tool); badParam.inputSchema.properties.keyword['x-ps-param'] = 'Keywordz';
  assert.throws(() => checkTool(badParam), /no param -Keywordz/);
});
