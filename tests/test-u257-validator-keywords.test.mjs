// U-257（2026-10-26，B2-7）：契约校验器补 pattern / minLength / maxLength。
//
// 由来（实测，不是推测）：`schema/asjson.schema.json` 的 `unreachable[].path` 与 `errors[].path` 用了 `pattern`、
// `errors[].message` 用了 `maxLength`，而 `tests/asjson-validator.mjs` 的 KNOWN 遇未实现关键字**直接抛**：
//     $.errors[0].path: validator does not implement keyword pattern
// 于是"载荷违约"与"校验器有洞"**报同一句话**（都是 throw）—— 这不是少个关键字，是把实现的洞伪装成数据的洞。
// 此前没暴露的唯一原因是样本 `reports/gates/u89-real-asjson.json` 的 errors[] 恰好为空（空数组不访问 items，故不触关键字）。
// 4 份真实能力探针（repo / code / research / auto）**每一份**都带非空 errors[]，在本轮之前**一份也校验不了**。
//
// 判据（B2-7）：4 份真实探针全部可校验；负例必红。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { schema, validate } from './asjson-validator.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = p => JSON.parse(fs.readFileSync(path.join(rootDir, p), 'utf8'));

// 与 README「怎么复现」四条探针一一对应；路径固定，缺文件即硬红（证据不许静默消失）
const PROBES = [
  'reports/gates/accept-2026-10-26/repo-all.json',
  'reports/gates/accept-2026-10-26/code-evidence.json',
  'reports/gates/accept-2026-10-26/research.json',
  'reports/gates/accept-2026-10-26/auto-zh.json',
];

test('U-257-A: 4 份真实探针全部通过 schema —— 且错误路径的 pattern 真的跑到了（非空 errors[] 是前提，不是巧合）', () => {
  const loaded = PROBES.map(p => ({ p, j: readJson(p) }));
  for (const { p, j } of loaded) {
    validate(schema, j);   // 抛即红：这条断言在修复前对 4 份中每一份都会抛 "does not implement keyword pattern"
  }
  // 反空转：若某次重生成后所有探针 errors[] 全空，本门就再也测不到 pattern 分支 —— 那它就成了假门。
  const withErrors = loaded.filter(({ j }) => (j.errors ?? []).length > 0);
  assert.ok(withErrors.length > 0, '四份探针的 errors[] 全为空 ⇒ pattern 分支未被真实数据覆盖（门失效，须换查询或补失败臂）');
  // 真实数据里的 path 形状必须全部命中 schema 的 pattern；不命中说明主脚本发出的 path 与契约不一致（真违约，该红）
  for (const { p, j } of withErrors) {
    for (const e of j.errors) assert.match(e.path, /^engines\.[A-Za-z0-9_-]+$/, `${p}: errors[].path 形状违约`);
  }
});

test('U-257-B: pattern 是「部分匹配」语义且路径不匹配必红（负例）', () => {
  const base = readJson(PROBES[0]);
  const mutate = f => { const o = structuredClone(base); f(o); return o; };
  // 1) 多一段：`engines.HF/../x` —— 旧行为是**根本没校验**（关键字未实现直接抛，报错文案还指向校验器自己的洞）
  assert.throws(() => validate(schema, mutate(o => { o.errors = [{ path: 'engines.HF/../x', code: 'error', message: 'x' }]; })),
    /does not match pattern/);
  // 2) 少一段：`engines.` 空名
  assert.throws(() => validate(schema, mutate(o => { o.errors = [{ path: 'engines.', code: 'error', message: 'x' }]; })),
    /does not match pattern/);
  // 3) unreachable[] 用同一个 pattern，也必须同样把守（两处都改，不许只补一处）
  assert.throws(() => validate(schema, mutate(o => { o.unreachable = [{ path: 'src/engines.HF' }]; })),
    /does not match pattern/);
  // 4) 合法值仍然过（否则上面三条可以用"永远抛"伪造）
  validate(schema, mutate(o => { o.errors = [{ path: 'engines.GitLabBlobs', code: 'network-unavailable', message: 'x' }]; }));
  // 5) pattern 本身写坏 ⇒ 报"schema 的错"，不得与"数据的错"混为一谈
  assert.throws(() => validate({ type: 'string', pattern: '([' }, 'x'), /schema pattern is not a valid RegExp/);
});

test('U-257-C: maxLength 按「码点」计且超长必红（emoji 不得被算成 2 个字符）', () => {
  const base = readJson(PROBES[0]);
  const withMsg = m => { const o = structuredClone(base); o.errors = [{ path: 'engines.HF', code: 'error', message: m }]; return o; };
  // 200 恰好过 / 201 必红（边界两侧各一条，防"只判 >="或"只判 >"的 off-by-one）
  validate(schema, withMsg('m'.repeat(200)));
  assert.throws(() => validate(schema, withMsg('m'.repeat(201))), /string length 201 > maxLength 200/);
  // 码点语义：2 个 emoji = 2 个字符（UTF-16 长度是 4）。若实现用 s.length，这条会被误判超长。
  validate({ type: 'string', maxLength: 2 }, '😀😀');
  assert.throws(() => validate({ type: 'string', maxLength: 2 }, '😀😀😀'), /string length 3 > maxLength 2/);
  validate({ type: 'string', minLength: 2 }, '😀😀');
  assert.throws(() => validate({ type: 'string', minLength: 2 }, '😀'), /string length 1 < minLength 2/);
});

test('U-257-D: 未实现关键字仍然硬抛 —— 补关键字不等于打开放行闸', () => {
  // 若有人把 KNOWN 变成"未知关键字跳过"，这条会失败：本校验器的价值就在"未实现即报名"，不是"尽量宽容"。
  assert.throws(() => validate({ type: 'string', format: 'uri' }, 'x'), /validator does not implement keyword format/);
  assert.throws(() => validate({ type: 'number', multipleOf: 2 }, 4), /validator does not implement keyword multipleOf/);
});
