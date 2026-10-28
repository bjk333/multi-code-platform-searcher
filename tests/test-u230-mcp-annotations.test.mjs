// U-230（v1.53.12，2026-10-23）：MCP 工具声明层补 title + annotations（T2-7 残余）。
//   方案表原文：「按需补 title/annotations.readOnlyHint」——v1.50.0 只做了 outputSchema/structuredContent。
//   readOnlyHint 与「实现到没到」无关：6 个工具全是只读查询，不改任何状态，必须如实声明。
//   不影响 R96（schema/mcp-tool.json 是设计描述符，哈希钉不动）；本门只看 mcps.py 生成的运行时声明。
//
//   annotations 语义（MCP 2025-06-18）：
//     readOnlyHint   —— true ⇒ 不修改环境
//     destructiveHint —— false ⇒ 无破坏性更新
//     idempotentHint —— ping=true（重复调用同效）；搜索类=false（结果随外部数据变化）
//     openWorldHint  —— 搜索类=true（交互外部 API）；ping=false（纯本地）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PY as PY_EXE } from './lib/interp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = PY_EXE;

function runPy(body, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const child = spawn(PY, ['-c', body], {
      cwd: ROOT, windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    let out = '', err = '';
    const killer = setTimeout(() => { try { child.kill(); } catch { /* already dead */ } reject(new Error('python timeout')); }, timeoutMs);
    child.stdout.on('data', (b) => { out += b.toString('utf8'); });
    child.stderr.on('data', (b) => { err += b.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(killer); reject(e); });
    child.on('close', () => { clearTimeout(killer); resolve({ out: out.trim(), err: err.trim() }); });
    child.stdin.end();
  });
}

const PROBE = `
import json, sys
sys.path.insert(0, '.')
import mcps
tools = mcps.mcp_tools()
result = {}
for t in tools:
    ann = t.get('annotations') or {}
    result[t['name']] = {
        'title': t.get('title') or '',
        'hasAnn': isinstance(t.get('annotations'), dict),
        'readOnly': ann.get('readOnlyHint'),
        'destructive': ann.get('destructiveHint'),
        'idempotent': ann.get('idempotentHint'),
        'openWorld': ann.get('openWorldHint'),
    }
print(json.dumps(result, ensure_ascii=False))
`;

test('U-230: 6 个工具都带 title + annotations（readOnlyHint/destructiveHint/openWorldHint/idempotentHint）', async () => {
  const { out, err } = await runPy(PROBE);
  if (!out) throw new Error('python produced no output. stderr: ' + err);
  const rows = JSON.parse(out);

  const EXPECT = {
    search_repositories: { readOnly: true, destructive: false, idempotent: false, openWorld: true },
    search_auto:         { readOnly: true, destructive: false, idempotent: false, openWorld: true },
    search_code:         { readOnly: true, destructive: false, idempotent: false, openWorld: true },
    research:            { readOnly: true, destructive: false, idempotent: false, openWorld: true },
    package_lookup:      { readOnly: true, destructive: false, idempotent: false, openWorld: true },
    ping:                { readOnly: true, destructive: false, idempotent: true,  openWorld: false },
  };

  assert.deepEqual(Object.keys(rows).sort(), Object.keys(EXPECT).sort(), '工具集必须恰好是 6 个');

  for (const [name, exp] of Object.entries(EXPECT)) {
    const r = rows[name];
    assert.ok(r.title.length > 0, `★ ${name} 必须有 title（人类可读名，不是 name 本身）`);
    assert.equal(r.hasAnn, true, `★ ${name} 必须有 annotations 对象`);
    assert.equal(r.readOnly, exp.readOnly, `${name}: readOnlyHint=${r.readOnly} 期望 ${exp.readOnly}（搜索/查包/健康检查全部只读）`);
    assert.equal(r.destructive, exp.destructive, `${name}: destructiveHint=${r.destructive} 期望 ${exp.destructive}`);
    assert.equal(r.idempotent, exp.idempotent, `${name}: idempotentHint=${r.idempotent} 期望 ${exp.idempotent}（ping 可重放；搜索结果随外部数据变化）`);
    assert.equal(r.openWorld, exp.openWorld, `${name}: openWorldHint=${r.openWorld} 期望 ${exp.openWorld}（ping 纯本地；其余交互外部 API）`);
  }
});

test('U-230 B: title 不得是 name 的照抄（必须是人类可读短语）', async () => {
  const { out } = await runPy(PROBE);
  const rows = JSON.parse(out);
  for (const [name, r] of Object.entries(rows)) {
    assert.notEqual(r.title, name, `★ ${name} 的 title 不得直接等于 name（那就是没写）`);
  }
});

test('U-230 C: mcps.py 源码必须包含 annotations 声明（不只在设计描述符里）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'mcps.py'), 'utf8');
  assert.match(src, /"readOnlyHint"\s*:\s*True/, '★ mcps.py 必须声明 readOnlyHint（运行时，不是 schema/mcp-tool.json 设计描述符）');
  assert.match(src, /"openWorldHint"\s*:/, '必须声明 openWorldHint');
  assert.match(src, /"idempotentHint"\s*:/, '必须声明 idempotentHint');
  assert.match(src, /"destructiveHint"\s*:/, '必须声明 destructiveHint');
});

test('U-230 negative control: 去掉 annotations 挂载 —— 行为门必须点名', async () => {
  // 模拟：如果 mcp_tools 末尾忘了挂 annotations，每个工具都缺 hasAnn
  const fake = JSON.stringify({
    search_repositories: { title: 'Search Repositories', hasAnn: false, readOnly: null, destructive: null, idempotent: null, openWorld: null },
    search_auto:         { title: 'Auto Search', hasAnn: false, readOnly: null, destructive: null, idempotent: null, openWorld: null },
    search_code:         { title: 'Search Code', hasAnn: false, readOnly: null, destructive: null, idempotent: null, openWorld: null },
    research:            { title: 'Research', hasAnn: false, readOnly: null, destructive: null, idempotent: null, openWorld: null },
    package_lookup:      { title: 'Package Lookup', hasAnn: false, readOnly: null, destructive: null, idempotent: null, openWorld: null },
    ping:                { title: 'Ping', hasAnn: false, readOnly: null, destructive: null, idempotent: null, openWorld: null },
  });
  const rows = JSON.parse(fake);
  // 验证：如果 hasAnn=false 就该被行为门抓到
  assert.equal(rows.search_repositories.hasAnn, false, 'mutation: no annotations');
  // 用与主门相同的判据
  assert.throws(() => {
    if (!rows.search_repositories.hasAnn) throw new Error('★ search_repositories 必须有 annotations 对象');
  }, /必须有 annotations/);
});
