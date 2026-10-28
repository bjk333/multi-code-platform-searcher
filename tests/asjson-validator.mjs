// R2 远端（2026-09-30）：-AsJson 契约校验助手（从 test-r95-asjson-contract 抽出，零依赖 2020-12 子集校验器 + 严格字符门）。
// 被 test-r95-asjson-contract 与 test-r96-live-payload 共用；本文件不注册任何测试。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const schema = JSON.parse(fs.readFileSync(path.join(rootDir, 'schema/asjson.schema.json'), 'utf8'));

// B2-7（2026-10-26）：补 pattern / minLength / maxLength。
//   为什么必须补：schema 的 unreachable[].path 与 errors[].path 用了 pattern、errors[].message 用了 maxLength，
//   而 KNOWN 遇未实现关键字**直接抛**。此前没暴露，只因为样本里这两个数组恰好为空——一旦真出现失败源，
//   校验器抛的是"validator does not implement keyword pattern"，与"载荷违约"**完全无法区分**：
//   把"实现的洞"报成了"数据的洞"。（实测：给 u89 样本塞一条 errors[] 即抛。）
const KNOWN = new Set(['$schema', '$id', '$ref', '$defs', 'title', 'description', 'type', 'required', 'properties', 'additionalProperties', 'items', 'enum', 'const',
  'oneOf', 'anyOf', 'not', 'minimum', 'minItems', 'maxItems', 'uniqueItems', 'pattern', 'minLength', 'maxLength']);
// 字符串长度按 **码点** 计（2020-12 §6.3.1 "number of characters"，不是 UTF-16 code unit）；
// 用 [...s].length 而非 s.length，否则 emoji / 增补平面字符会被算成 2。
const cpLen = s => [...s].length;
export function validate(node, data, where = '$', root = schema) {
  for (const k of Object.keys(node)) if (!KNOWN.has(k)) throw new Error(`${where}: validator does not implement keyword ${k}`);
  if (node.$ref) return validate(node.$ref.slice(2).split('/').reduce((o, k) => o[k], root), data, where, root);
  const t = data === null ? 'null' : Array.isArray(data) ? 'array' : typeof data === 'number' ? (Number.isInteger(data) ? 'integer' : 'number') : typeof data;
  const types = [].concat(node.type ?? []);
  if (types.length && !(types.includes(t) || (t === 'integer' && types.includes('number')))) throw new Error(`${where}: type ${t} not in [${types}]`);
  if (node.enum && !node.enum.some(e => e === data)) throw new Error(`${where}: value ${JSON.stringify(data)} not in enum`);
  if ('const' in node && node.const !== data) throw new Error(`${where}: value ${JSON.stringify(data)} != const ${JSON.stringify(node.const)}`);
  if (node.minimum !== undefined && typeof data === 'number' && data < node.minimum) throw new Error(`${where}: ${data} < minimum ${node.minimum}`);
  // pattern 是**部分匹配**语义（2020-12 §6.3.3），锚定与否由正则自身决定；本仓 schema 里的都自带 ^...$。
  if (typeof data === 'string') {
    if (node.pattern !== undefined) {
      let re;
      try { re = new RegExp(node.pattern, 'u'); }
      catch (e) { throw new Error(`${where}: schema pattern is not a valid RegExp (${e.message})`); }
      if (!re.test(data)) throw new Error(`${where}: ${JSON.stringify(data)} does not match pattern ${node.pattern}`);
    }
    if (node.minLength !== undefined && cpLen(data) < node.minLength) throw new Error(`${where}: string length ${cpLen(data)} < minLength ${node.minLength}`);
    if (node.maxLength !== undefined && cpLen(data) > node.maxLength) throw new Error(`${where}: string length ${cpLen(data)} > maxLength ${node.maxLength}`);
  }
  if (t === 'object') {
    for (const r of node.required ?? []) if (!(r in data)) throw new Error(`${where}: missing required ${r}`);
    for (const [k, v] of Object.entries(data)) {
      if (node.properties && k in node.properties) validate(node.properties[k], v, `${where}.${k}`, root);
      else if (node.additionalProperties === false) throw new Error(`${where}: unexpected key ${k}`);
      else if (node.additionalProperties && typeof node.additionalProperties === 'object') validate(node.additionalProperties, v, `${where}.${k}`, root);
    }
  }
  if (t === 'array') {
    if (node.minItems !== undefined && data.length < node.minItems) throw new Error(`${where}: fewer than ${node.minItems} items`);
    if (node.maxItems !== undefined && data.length > node.maxItems) throw new Error(`${where}: more than ${node.maxItems} items`);
    if (node.uniqueItems && new Set(data.map(x => JSON.stringify(x))).size !== data.length) throw new Error(`${where}: items not unique`);
    if (node.items) data.forEach((it, i) => validate(node.items, it, `${where}[${i}]`, root));
  }
  const passes = n => { try { validate(n, data, where, root); return true; } catch { return false; } };
  if (node.oneOf) { const ok = node.oneOf.filter(passes).length; if (ok !== 1) throw new Error(`${where}: oneOf matched ${ok} branches (need exactly 1)`); }
  if (node.anyOf && !node.anyOf.some(passes)) throw new Error(`${where}: anyOf matched none`);
  if (node.not && passes(node.not)) throw new Error(`${where}: matched a forbidden (not) schema`);
}

// R2：补 U+2066–2069（双向隔离）/ 061C / 180E —— 与 R96 扩面后的 Remove-InvisibleChars 同口径（Tag 块已在）
export const FORBIDDEN = /[\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u{E0000}-\u{E007F}]/u;
export function assertStrictJsonText(text, label = 'payload') {
  assert.ok(!text.startsWith('\uFEFF'), `${label}: leading BOM (RFC 8259 §8.1 MUST NOT)`);
  let obj;
  try { obj = JSON.parse(text); } catch (e) { throw new assert.AssertionError({ message: `${label}: not strict JSON (${e.message})` }); }
  const bad = [];
  const walk = (v, p) => {
    if (typeof v === 'string') { const m = v.match(FORBIDDEN); if (m) bad.push(`${p} U+${m[0].codePointAt(0).toString(16).toUpperCase()}`); }
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (FORBIDDEN.test(k)) bad.push(`${p}.<key>`); walk(x, `${p}.${k}`); }
  };
  walk(obj, '$');
  assert.deepEqual(bad, [], `${label}: invisible/bidi code points survive JSON.parse: ${bad.join(', ')}`);
  return obj;
}
