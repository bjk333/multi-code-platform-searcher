// U-196（2026-10-21，v1.46.4）：MCP 工具面补齐 `package_lookup`（v1.46.3 的 -Package 在 MCP 侧够不到）。
//
// 事实：2026-10-21 实测 `tools/call name=package_lookup` →
//   {"code":-32602,"message":"unknown tool: package_lookup"}
//   而 CLI 的 `-Package "npm:express,pypi:requests"` 已可用（15.99s / 2 条 / full）。
//
// 门结构：A 静态接线（Serve op + Python 映射表）；B 纯函数契约（真跑 python 导入 mcps.py，不发网络）；C 负例。

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceAll } from './lib/source.mjs';
import { PY as PY_EXE } from './lib/interp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = sourceAll(path.join(ROOT)).replace(/^\uFEFF/, '');
const PY = PY_EXE;
const CODE = MAIN.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');

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

test('U-196 A: 静态接线 —— Serve 有 package op，且调用现有 DepsDev 引擎', () => {
  const at = CODE.lastIndexOf('if ($Serve) {');
  const block = CODE.slice(at);
  assert.match(block, /'package' \{/, "★ -Serve 缺 op 'package'");
  assert.match(block, /Search-DepsDevPackage -PackageSpec \$p/, '★ package op 必须复用现有引擎（不要重写解析）');
  assert.match(block, /DepsDevMaxSpecs/, '必须沿用包数上限');
  const py = fs.readFileSync(path.join(ROOT, 'mcps.py'), 'utf8');
  assert.match(py, /"package_lookup": \("package", \{"packages"\}\)/, 'MCP_TOOL_OPS 缺 package_lookup 映射');
  assert.match(py, /if op == "package":/, 'build_tool_request 缺 package 分支');
});

test('U-196 B/C: 工具清单/纯函数映射/负例（缺 packages、多余参数）', async () => {
  const code = `
import json, mcps
tools = {t["name"]: t for t in mcps.mcp_tools()}
out = {}
out["names"] = sorted(tools)
out["required"] = tools["package_lookup"]["inputSchema"]["required"]
out["props"] = sorted(tools["package_lookup"]["inputSchema"]["properties"])
out["req"] = mcps.build_tool_request("package_lookup", {"packages": "npm:express"})
out["codeLang"] = "language" in tools["search_code"]["inputSchema"]["properties"]
def bad(a):
    try:
        mcps.build_tool_request("package_lookup", a)
        return "NO-RAISE"
    except ValueError as e:
        return str(e)
out["missing"] = bad({})
out["extra"] = bad({"packages": "npm:x", "keyword": "x"})
print(json.dumps(out))
`;
  const o = await runPy(code);
  assert.ok(o.names.includes('package_lookup'), '工具清单必须含 package_lookup');
  assert.deepEqual(o.required, ['packages'], 'package_lookup 必填键必须是 packages（不是 keyword）');
  assert.deepEqual(o.props, ['packages']);
  assert.deepEqual(o.req, { op: 'package', packages: 'npm:express' });
  assert.equal(o.codeLang, true, 'search_code 必须暴露 language（U-197）');
  assert.match(o.missing, /packages is required/);
  assert.match(o.extra, /unexpected arguments/);
});
