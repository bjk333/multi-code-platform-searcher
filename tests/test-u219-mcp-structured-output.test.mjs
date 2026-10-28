// U-219（2026-10-22，v1.50.0）：MCP 的**声明层**接线 —— tools/list 带 outputSchema，tools/call 带 structuredContent。
//
// 事实（v1.48.2 实测，报告 §5 一直挂着）：tools/list 只回 name/description/inputSchema；
//   tools/call 只回 content+isError。`schema/mcp-tool.json` 里那份 outputSchema 是**未接线的设计描述符**
//   （且描述的是 CLI 的 -AsJson 形状，与 Serve 响应不是一回事）。
//
// 本门三层：
//   A 纯数据（真跑 python 导入 mcps.py，不发网络）：6 个工具都有 outputSchema；schema 文件的 x-tools 键集
//     必须与 MCP_TOOL_OPS 完全一致（多一个少一个都红 —— 否则就是"声明了不存在的工具"或"工具没有契约"）。
//   B 端到端（真起 -Serve，引擎全禁、不出网）：structuredContent 存在、与 content[0].text 同源、且过 schema。
//   C 负例：缺 required / const 不符 / 类型不符 必须被校验器点名；源码里两处接线被拆也必须红。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PY as PY_EXE } from './lib/interp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = PY_EXE;
const PY_SRC = fs.readFileSync(path.join(ROOT, 'mcps.py'), 'utf8');
const SCHEMA_DOC = JSON.parse(fs.readFileSync(path.join(ROOT, 'schema/mcp-output.schema.json'), 'utf8').replace(/^\uFEFF/, ''));

function runPy(code, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const child = spawn(PY, ['-c', code], { cwd: ROOT, windowsHide: true });
    let out = '', err = '';
    const t = setTimeout(() => { try { child.kill(); } catch { } reject(new Error('python timeout')); }, timeoutMs);
    child.stdout.on('data', (b) => { out += b.toString('utf8'); });
    child.stderr.on('data', (b) => { err += b.toString('utf8'); });
    child.once('error', (e) => { clearTimeout(t); reject(e); });
    child.once('close', (status) => {
      clearTimeout(t);
      if (status !== 0) return reject(new Error('python exit ' + status + ': ' + err.slice(0, 400)));
      try { resolve(JSON.parse(out.trim())); } catch (e) { reject(new Error('bad json: ' + out.slice(0, 300))); }
    });
  });
}

// 轻量校验器：只实现本仓 schema 用到的关键字 + 文件内 `#/$defs/...` 引用。
// （$ref 只在**同一份**下发的 schema 内解析 —— 这正是 mcps.py 把 $defs 一起塞进 outputSchema 的原因。）
function miniValidate(root, schema, data, where = '$') {
  if (schema.$ref) {
    assert.match(schema.$ref, /^#\//, 'only internal refs are allowed: ' + schema.$ref);
    const target = schema.$ref.slice(2).split('/').reduce((o, k) => o[k], root);
    return miniValidate(root, target, data, where);
  }
  const types = [].concat(schema.type || []);
  const jsType = data === null ? 'null' : Array.isArray(data) ? 'array'
    : typeof data === 'number' ? (Number.isInteger(data) ? 'integer' : 'number') : typeof data;
  if (types.length) {
    assert.ok(types.includes(jsType) || (jsType === 'integer' && types.includes('number')),
      `${where}: type ${jsType} not in [${types}]`);
  }
  if ('const' in schema) assert.equal(data, schema.const, `${where}: value ${JSON.stringify(data)} != const`);
  if (schema.enum) assert.ok(schema.enum.includes(data), `${where}: value ${JSON.stringify(data)} not in enum`);
  if (schema.minimum !== undefined && typeof data === 'number') assert.ok(data >= schema.minimum, `${where}: below minimum`);
  if (jsType === 'object') {
    for (const r of schema.required || []) assert.ok(r in data, `${where}: missing required ${r}`);
    for (const [k, v] of Object.entries(data)) {
      if (schema.properties && k in schema.properties) miniValidate(root, schema.properties[k], v, `${where}.${k}`);
      else if (schema.additionalProperties === false) assert.fail(`${where}: unexpected key ${k}`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') miniValidate(root, schema.additionalProperties, v, `${where}.${k}`);
    }
  }
  if (jsType === 'array' && schema.items) data.forEach((it, i) => miniValidate(root, schema.items, it, `${where}[${i}]`));
}

test('U-219 A: 六个工具都声明 outputSchema，且 schema 文件的工具键集与 MCP 映射表完全一致', async () => {
  const r = await runPy(`
import json, mcps
out = {}
out["mapped"] = sorted(mcps.MCP_TOOL_OPS)
out["tools"] = {t["name"]: {"has": bool(t.get("outputSchema")),
                            "required": (t.get("outputSchema") or {}).get("required", []),
                            "defs": sorted(((t.get("outputSchema") or {}).get("$defs") or {}).keys())}
                 for t in mcps.mcp_tools()}
out["schemaFile"] = sorted(mcps.load_output_schemas().keys())
print(json.dumps(out, ensure_ascii=False))
`);
  assert.deepEqual(r.schemaFile, r.mapped, 'schema 文件的 x-tools 必须与 MCP_TOOL_OPS 一一对应（多/少都红）');
  for (const name of r.mapped) {
    assert.equal(r.tools[name].has, true, `${name}: 缺 outputSchema（工具已声明却没有响应契约）`);
    assert.ok(r.tools[name].required.length > 0, `${name}: outputSchema.required 为空 —— 等于没承诺`);
    assert.ok(r.tools[name].defs.includes('coverage'), `${name}: $defs 必须随 schema 下发（否则 #/$defs/coverage 无处解析）`);
  }
  // ping 不含 coverage（它不是检索），其余五个必须含
  for (const name of r.mapped.filter((n) => n !== 'ping')) {
    assert.ok(r.tools[name].required.includes('coverage'), `${name}: 检索类工具必须承诺 coverage`);
    assert.ok(r.tools[name].required.includes('results'), `${name}: 必须承诺 results`);
  }
  assert.ok(!r.tools.ping.required.includes('coverage'), 'ping 不该承诺 coverage');
});

// ★R2 卫生门：tests/*.mjs 里**新文件一律只许异步 spawn**（宿主 NODE_OPTIONS 垫片让 spawnSync 恒 EBUSY、
//   status=null ⇒ "没跑"会被读成"跑红"）。这里用 spawn + 手动写 stdin，EBUSY/超时都会以 launchError 暴露。
function serve(msgs, disable, timeout = 180000) {
  return new Promise((resolve, reject) => {
    const child = spawn(PY, ['mcps.py', '--mcp'], {
      cwd: ROOT, windowsHide: true,
      env: { ...process.env, MCPS_DISABLE: disable, MCPS_SERVE_CACHE: '0' },
    });
    let out = '', err = '';
    const t = setTimeout(() => { try { child.kill(); } catch { } reject(new Error('serve timeout')); }, timeout);
    child.stdout.on('data', (b) => { out += b.toString('utf8'); });
    child.stderr.on('data', (b) => { err += b.toString('utf8'); });
    child.once('error', (e) => { clearTimeout(t); reject(e); });
    child.once('close', () => {
      clearTimeout(t);
      const lines = out.trim().split(/\r?\n/).filter(Boolean);
      if (!lines.length) return reject(new Error('serve produced no output: ' + err.slice(0, 300)));
      try { resolve(lines.map((l) => JSON.parse(l))); } catch (e) { reject(new Error('bad json: ' + out.slice(0, 300))); }
    });
    child.stdin.end(msgs.map((m) => JSON.stringify(m) + '\n').join(''));
  });
}

test('U-219 B: structuredContent 与 content[0].text 同源，且通过各自 outputSchema（真起 -Serve，引擎全禁）', async () => {
  const lines = await serve([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'u219', version: '0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_repositories', arguments: { keyword: 'vector database', limit: 1 } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'ping', arguments: {} } },
  ], 'GitHub,Gitee,GitLab,Codeberg');
  const byId = Object.fromEntries(lines.filter((l) => l.id !== undefined).map((l) => [l.id, l]));
  const tools = Object.fromEntries((byId[2].result.tools || []).map((t) => [t.name, t]));
  assert.deepEqual(Object.keys(tools).sort(), Object.keys(SCHEMA_DOC['x-tools']).sort(),
    'tools/list 的工具集变了 ⇒ 同步改 schema 文件');

  for (const [id, name] of [[3, 'search_repositories'], [4, 'ping']]) {
    const res = byId[id].result;
    assert.equal(res.isError, false, `${name}: 引擎被禁不是工具错误`);
    assert.ok(res.structuredContent && typeof res.structuredContent === 'object', `${name}: 缺 structuredContent`);
    const text = JSON.parse(res.content[0].text);
    assert.deepEqual(res.structuredContent, text, `${name}: structuredContent 与 content[0].text 必须是同一份对象`);
    miniValidate(tools[name].outputSchema, tools[name].outputSchema, res.structuredContent, name);
  }
  // 全禁 ⇒ 契约里的 Verdict 分支要真的走到 no-engines（证明覆盖率字段不是常量摆件）
  assert.equal(byId[3].result.structuredContent.coverage.Verdict, 'no-engines');
});

test('U-219 C: 负例 —— 少 required / const 不符 / 类型不符 都被点名；两处接线被拆也红', async () => {
  const schema = SCHEMA_DOC['x-tools'].search_repositories;
  const rootSchema = { ...schema, $defs: SCHEMA_DOC.$defs };
  const good = { op: 'repo', count: 0, platforms: [], coverage: { Requested: [], Executed: 0, Blocked: 0, Degraded: 0, NotRun: 0, Verdict: 'no-engines' }, results: [] };
  miniValidate(rootSchema, rootSchema, good, 'good');   // 先自证：合法样本能过
  // ★这条是给**校验器自己**的负例：本门第一版把参数顺序写错（schema 与 data 互换），
  //   校验器对"字符串 vs 对象 schema"静默通过 ⇒ B 段假绿。这条保证那种错法必然红。
  assert.throws(() => miniValidate(rootSchema, rootSchema, 'not-an-object', 'self'), /type string not in/, '参数顺序错了必须红，不能空过');
  const noCov = structuredClone(good); delete noCov.coverage;
  assert.throws(() => miniValidate(rootSchema, rootSchema, noCov, 'noCov'), /missing required coverage/);
  const wrongOp = structuredClone(good); wrongOp.op = 'code';
  assert.throws(() => miniValidate(rootSchema, rootSchema, wrongOp, 'wrongOp'), /!= const/);
  const wrongType = structuredClone(good); wrongType.count = '0';
  assert.throws(() => miniValidate(rootSchema, rootSchema, wrongType, 'wrongType'), /type string not in/);
  const badVerdict = structuredClone(good); badVerdict.coverage.Verdict = 'ok';
  assert.throws(() => miniValidate(rootSchema, rootSchema, badVerdict, 'badVerdict'), /not in enum/);

  // 源码接线：① 只对 ok 加 structuredContent；② 逐个工具挂 outputSchema
  const checkWiring = (src) => {
    assert.match(src, /if ok and isinstance\(payload, dict\):\s*\n\s*result\["structuredContent"\] = payload/,
      '★ structuredContent 必须只在 ok 且为对象时添加（isError 结果不承诺符合 outputSchema）');
    assert.match(src, /for t in tools:\s*\n\s*sc = schemas\.get\(t\["name"\]\)\s*\n\s*if sc:\s*\n\s*t\["outputSchema"\] = sc/,
      '★ outputSchema 必须逐个工具挂上（否则 tools/list 又回到"只有 inputSchema"）');
  };
  checkWiring(PY_SRC);
  const noGuard = PY_SRC.replace('        if ok and isinstance(payload, dict):\n            result["structuredContent"] = payload\n',
    '        result["structuredContent"] = payload\n');
  assert.notEqual(noGuard, PY_SRC, 'mutation must hit the guard');
  assert.throws(() => checkWiring(noGuard), /只在 ok 且为对象时添加/);
  const noLoop = PY_SRC.replace('    for t in tools:\n        sc = schemas.get(t["name"])\n        if sc:\n            t["outputSchema"] = sc\n', '');
  assert.notEqual(noLoop, PY_SRC, 'mutation must hit the loop');
  assert.throws(() => checkWiring(noLoop), /必须逐个工具挂上/);
});
