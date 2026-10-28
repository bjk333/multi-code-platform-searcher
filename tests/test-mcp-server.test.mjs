// v1.43.0（2026-10-19，P1 第二项）：MCP stdio 服务端门。
//
// 为什么需要它：`--mcp` 是本技能**对外唯一的协议面**。协议面的失败模式都很"安静"：
//   ① stdout 混进一行人类日志 ⇒ 客户端 parse 失败（整个连接报废，但服务端自己以为正常）；
//   ② 工具名映射错/参数白名单缺失 ⇒ 客户端把 `-Keyword` 之外的任意参数塞进 ps1；
//   ③ 错误不回 JSON-RPC error ⇒ 客户端永久等待。
// 所以门分两层：**协议帧（真跑进程）** + **工具契约（纯函数，可离线变异）**。
//
// 本仓经验（u159）：不用 spawnSync（宿主垫片恒 EBUSY）、不用 fs.cpSync（非 ASCII 路径崩）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceAll } from './lib/source.mjs';
import { PY as PY_EXE } from './lib/interp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'mcps.py');
const MAIN = path.join(ROOT, 'multi-platform-searcher.ps1');
const PY = PY_EXE;
const VERSION = /^\$VERSION = "([0-9.]+)"$/m.exec(fs.readFileSync(MAIN, 'utf8'))?.[1];

// ---------- 纯函数：判据（每条都配能弄红的负例） ----------
export function validateTools(tools) {
  const bad = [];
  if (!Array.isArray(tools) || tools.length === 0) return ['tools must be a non-empty array'];
  const names = new Set();
  for (const t of tools) {
    if (!t || typeof t !== 'object') { bad.push('tool is not an object'); continue; }
    if (typeof t.name !== 'string' || !/^[a-z][a-z0-9_]{2,}$/.test(t.name)) bad.push('bad tool name: ' + JSON.stringify(t.name));
    if (names.has(t.name)) bad.push('duplicate tool name: ' + t.name);
    names.add(t.name);
    if (typeof t.description !== 'string' || t.description.length < 20) bad.push(t.name + ': description missing/too short');
    const s = t.inputSchema;
    if (!s || typeof s !== 'object' || s.type !== 'object') { bad.push(t.name + ': inputSchema.type must be object'); continue; }
    if (!s.properties || typeof s.properties !== 'object') bad.push(t.name + ': inputSchema.properties missing');
    const req = s.required || [];
    if (!Array.isArray(req)) bad.push(t.name + ': required must be an array');
    for (const r of req) if (!s.properties || !(r in s.properties)) bad.push(`${t.name}: required '${r}' not in properties`);
    // U-196：package_lookup 的必填键是 packages（精确包查询没有 keyword）；其余非 ping 工具仍必须是 keyword。
    const requiredKey = t.name === 'package_lookup' ? 'packages' : 'keyword';
    if (t.name !== 'ping' && !req.includes(requiredKey)) bad.push(t.name + ': ' + requiredKey + ' must be required');
    if (s.additionalProperties !== false) bad.push(t.name + ': additionalProperties must be false（参数白名单）');
  }
  for (const need of ['search_repositories', 'search_code', 'research', 'package_lookup', 'ping'])
    if (!names.has(need)) bad.push('missing tool: ' + need);
  return bad;
}

export function checkStdoutPurity(lines) {
  // 每一行都必须是合法 JSON 且带 jsonrpc 字段 —— 混进一行日志就必须红。
  const bad = [];
  lines.forEach((l, i) => {
    if (!l.trim()) return;
    try {
      const j = JSON.parse(l);
      if (j.jsonrpc !== '2.0') bad.push(`line ${i + 1}: jsonrpc != 2.0`);
    } catch { bad.push(`line ${i + 1}: not JSON: ${l.slice(0, 80)}`); }
  });
  return bad;
}

// ---------- 进程夹具 ----------
function startServer(args = ['--mcp']) {
  const child = spawn(PY, [CLI, ...args], { cwd: ROOT, windowsHide: true });
  const lines = [], errs = [], waiters = [];
  let buf = '';
  const api = {
    child,
    lines,
    stderr: () => Buffer.concat(errs).toString('utf8'),
    send(obj) {
      child.stdin.write((typeof obj === 'string' ? obj : JSON.stringify(obj)) + '\n');
    },
    next(timeoutMs = 60000) {
      return new Promise((resolve, reject) => {
        const hit = lines.shift();
        if (hit !== undefined) return resolve(hit);
        const t = setTimeout(() => reject(new Error('timeout waiting for response; stderr=' + api.stderr().slice(-400))), timeoutMs);
        waiters.push((line) => { clearTimeout(t); resolve(line); });
      });
    },
    async close() {
      try { child.stdin.end(); } catch { }
      await new Promise((r) => { const t = setTimeout(() => { try { child.kill(); } catch { } r(); }, 8000); child.once('close', () => { clearTimeout(t); r(); }); });
    },
  };
  child.stdout.on('data', (b) => {
    buf += b.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      // ★有等待者时**直接交付、不入队** —— 否则同一行既被消费又留在队列里，下一个 next() 会拿到上一条响应
      //   （实测症状：tools/call 的断言拿到 initialize 的 result）。
      const w = waiters.shift();
      if (w) w(line); else lines.push(line);
    }
  });
  child.stderr.on('data', (b) => errs.push(b));
  return api;
}

test('MCP-1 握手：initialize 回协议版本/能力/serverInfo，tools/list 给 6 个合法工具', async () => {
  const s = startServer();
  try {
    s.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'gate', version: '0' } } });
    const init = JSON.parse(await s.next());
    assert.equal(init.id, 1);
    assert.equal(init.result.protocolVersion, '2024-11-05');
    assert.equal(init.result.capabilities.tools.listChanged, false);
    assert.equal(init.result.serverInfo.name, 'multi-code-platform-searcher');
    assert.equal(init.result.serverInfo.version, VERSION, 'serverInfo.version 必须等于主脚本 $VERSION（单一事实源）');
    s.send({ jsonrpc: '2.0', method: 'notifications/initialized' });   // 通知不得有响应
    s.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const list = JSON.parse(await s.next());
    assert.equal(list.id, 2, '通知不应产生响应（否则这里会拿到 id 缺失的消息）');
    assert.deepEqual(validateTools(list.result.tools), []);
    assert.deepEqual(list.result.tools.map(t => t.name).sort(), ['package_lookup', 'ping', 'research', 'search_auto', 'search_code', 'search_repositories']);
  } finally { await s.close(); }
});

test('MCP-2 tools/call ping：往返可达且 isError=false；stdout 全是 JSON-RPC 行', async () => {
  const s = startServer();
  try {
    s.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
    await s.next();
    s.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ping', arguments: {} } });
    const r = JSON.parse(await s.next());
    assert.equal(r.id, 2);
    assert.equal(r.result.isError, false);
    const payload = JSON.parse(r.result.content[0].text);
    assert.equal(payload.ok, undefined, 'payload 里不该再带 ok（由 isError 表达）');
    assert.equal(payload.version, VERSION);
    assert.ok(Number.isInteger(payload.pid) && payload.pid > 0, 'ping 必须回常驻进程 PID');
    assert.deepEqual(checkStdoutPurity(s.lines), [], 'stdout 混入非 JSON 行 ⇒ 客户端 parse 失败');
  } finally { await s.close(); }
});

test('MCP-3 错误面：未知方法 -32601 / 未知工具 -32602 / 坏 JSON -32700，且服务不退出', async () => {
  const s = startServer();
  try {
    s.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await s.next();
    s.send({ jsonrpc: '2.0', id: 2, method: 'no/such' });
    const m = JSON.parse(await s.next());
    assert.equal(m.error.code, -32601);
    s.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'nope', arguments: {} } });
    const t = JSON.parse(await s.next());
    assert.equal(t.error.code, -32602);
    s.send('{not json}');
    const p = JSON.parse(await s.next());
    assert.equal(p.error.code, -32700);
    assert.equal(p.id, null, 'parse error 的 id 必须是 null');
    s.send({ jsonrpc: '2.0', id: 4, method: 'ping' });
    const alive = JSON.parse(await s.next());
    assert.equal(alive.id, 4, '错误之后必须仍能服务（否则一次坏输入就废掉连接）');
    assert.deepEqual(checkStdoutPurity(s.lines), []);
  } finally { await s.close(); }
});

test('MCP-4 参数白名单：多余参数/缺 keyword/非整数 ⇒ -32602（不允许透传到 ps1）', async () => {
  const s = startServer();
  try {
    s.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await s.next();
    const cases = [
      { name: 'search_repositories', arguments: { keyword: 'x', NoProxy: true } },
      { name: 'search_code', arguments: {} },
      { name: 'research', arguments: { keyword: 'x', limit: '5' } },
      { name: 'package_lookup', arguments: {} },                    // U-196：缺 packages
      { name: 'package_lookup', arguments: { packages: 'npm:x', keyword: 'x' } },  // 多余参数
    ];
    for (let i = 0; i < cases.length; i++) {
      s.send({ jsonrpc: '2.0', id: 10 + i, method: 'tools/call', params: cases[i] });
      const r = JSON.parse(await s.next());
      assert.equal(r.error?.code, -32602, 'case ' + i + ' must be rejected: ' + JSON.stringify(r));
    }
  } finally { await s.close(); }
});

test('MCP-5 接线（静态）：每个工具映射的 op 必须在 -Serve 的 switch 里真实存在', () => {
  const src = sourceAll(ROOT).replace(/^\uFEFF/, '');
  const at = src.lastIndexOf('if ($Serve) {');
  assert.ok(at > 0, '找不到 -Serve 块');
  const block = src.slice(at);
  for (const op of ['repo', 'code', 'research', 'package', 'ping'])
    assert.match(block, new RegExp(`'${op}' \\{`), `-Serve 缺 op '${op}' —— MCP 工具会映射到不存在的分支`);
  for (const t of ['search_repositories', 'search_code', 'research', 'package_lookup', 'ping'])
    assert.ok(src.length > 0 && fs.readFileSync(CLI, 'utf8').includes('"' + t + '"'), 'mcps.py 缺工具名 ' + t);
});

test('MCP 负例（门自检）：缺 required / additionalProperties 放宽 / stdout 混日志，都必须被抓住', () => {
  // 内联最小合法夹具（**不落盘**：tests/ 下多一个文件就要进清单或排除表，负例不值得占名额）
  const mk = (name, required, key = 'keyword') => ({
    name,
    description: 'fixture tool for ' + name + ' (valid description length)',
    inputSchema: {
      type: 'object',
      properties: required.length ? { [key]: { type: 'string' }, limit: { type: 'integer' } } : {},
      required,
      additionalProperties: false,
    },
  });
  const tools = [mk('search_repositories', ['keyword']), mk('search_code', ['keyword']), mk('research', ['keyword']),
    mk('package_lookup', ['packages'], 'packages'), mk('ping', [])];
  assert.deepEqual(validateTools(tools), [], '夹具本身必须合法');
  const noReq = structuredClone(tools); noReq[0].inputSchema.required = [];
  assert.match(validateTools(noReq).join('|'), /keyword must be required/);
  const loose = structuredClone(tools); loose[0].inputSchema.additionalProperties = true;
  assert.match(validateTools(loose).join('|'), /additionalProperties must be false/);
  const noTool = structuredClone(tools).filter(t => t.name !== 'ping');
  assert.match(validateTools(noTool).join('|'), /missing tool: ping/);
  assert.match(checkStdoutPurity(['{"jsonrpc":"2.0","id":1}', '[mcps] ready']).join('|'), /line 2: not JSON/);
});
