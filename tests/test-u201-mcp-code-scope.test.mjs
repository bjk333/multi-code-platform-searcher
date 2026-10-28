// U-201（2026-10-21，v1.46.6）：MCP `search_code` 够不到 v1.46.5 的仓库作用域。
//
// 事实：CLI 已有 `-RepoScope`（默认 only），但 `tools/call name=search_code` 只接受
//   keyword/limit/maxResults/language —— repoScope 会被 `additionalProperties:false` 拒掉，
//   等于"CLI 能限定仓库、Agent 不能"。
//
// 口径（与 CLI only 模式一致，不另造语义）：
//   · `repoScope` 接受 git URL / `owner/repo`；解析失败 ⇒ **直接报参数错**（不退回全局检索，否则承诺是空的）；
//   · `pathFilter` 透传到 GitHub `path:` / grep.app `path` / Sourcegraph `path:`；
//   · `-Serve` 缓存键含 repoScope/pathFilter（否则 A 仓库结果会被 B 仓库复用）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeWithMutants, MAIN, PRODUCT_SRC } from './r94-ps-probe.mjs';
import { PY as PY_EXE } from './lib/interp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN_SRC = PRODUCT_SRC().replace(/^\uFEFF/, '');
const PY = PY_EXE;

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
      try { resolve(JSON.parse(out.trim())); } catch { reject(new Error('bad json: ' + out.slice(0, 300))); }
    });
  });
}

test('U-201 A: 静态接线 —— Serve code op 用作用域解析 + 二次过滤 + 缓存键含作用域', () => {
  const at = MAIN_SRC.lastIndexOf('if ($Serve) {');
  const block = MAIN_SRC.slice(at);
  assert.match(block, /Resolve-ServeCodeScope -RepoScope \$repo/, '★ code op 必须解析 repoScope');
  assert.match(block, /repoScope must be a git URL or owner\/repo/, '★ 解析失败要报参数错（不得静默退回全局）');
  assert.match(block, /Select-RepoScopedResults -Results \$r -Identity \$plan\.Identity/, '★ 必须做库外结果二次过滤');
  assert.match(block, /Search-SearchCodeRepo -Keyword \$kw -Repository \$repo/, '必须保留 searchcode 仓库级通道');
  assert.match(block, /-RepoScope \$repo -PathFilter \$pathF/, '★ Serve 缓存键必须含作用域');
  const py = fs.readFileSync(path.join(ROOT, 'mcps.py'), 'utf8');
  assert.match(py, /"search_code": \("code", \{"keyword", "limit", "maxResults", "language", "repoScope", "pathFilter"\}\)/, 'MCP_TOOL_OPS 缺 repoScope/pathFilter');
  assert.match(py, /"repoScope": \{"type": "string"/, 'search_code schema 缺 repoScope');
  assert.match(py, /"pathFilter": \{"type": "string"/, 'search_code schema 缺 pathFilter');
});

test('U-201 B: Python 契约 —— schema 暴露两键、映射透传、错类型/未知键被拒', async () => {
  const code = `
import json, mcps
tools = {t["name"]: t for t in mcps.mcp_tools()}
out = {}
sc = tools["search_code"]["inputSchema"]
out["props"] = sorted(sc["properties"])
out["req"] = mcps.build_tool_request("search_code", {"keyword": "expire", "repoScope": "https://github.com/redis/redis", "pathFilter": "src"})
def bad(a):
    try:
        mcps.build_tool_request("search_code", a)
        return "NO-RAISE"
    except ValueError as e:
        return str(e)
out["badType"] = bad({"keyword": "x", "repoScope": 5})
out["unknown"] = bad({"keyword": "x", "repoFull": "a/b"})
print(json.dumps(out))
`;
  const o = await runPy(code);
  assert.deepEqual(o.props, ['keyword', 'language', 'limit', 'maxResults', 'pathFilter', 'repoScope']);
  assert.deepEqual(o.req, { op: 'code', keyword: 'expire', repoScope: 'https://github.com/redis/redis', pathFilter: 'src' });
  assert.match(o.badType, /repoScope must be a string/);
  assert.match(o.unknown, /unexpected arguments/);
});

test('U-201 C: PS 作用域解析（变异：去掉 Valid 守卫 ⇒ 非法 repoScope 被放过）', async () => {
  const probe = `
$ErrorActionPreference = 'Stop'
$out = [ordered]@{}
$ok = Resolve-ServeCodeScope -RepoScope 'https://github.com/redis/redis'
$out.valid = $ok.Valid
$out.slug = $ok.Slug
$out.mode = $ok.Plan.Mode
$out.engines = @($ok.Plan.Engines | ForEach-Object { $_.Name })
$bad = Resolve-ServeCodeScope -RepoScope 'not-a-repo'
$out.badValid = $bad.Valid
$out.badSlug = $bad.Slug
$none = Resolve-ServeCodeScope -RepoScope ''
$out.noneValid = $none.Valid
$out.noneMode = $none.Plan.Mode
$out
`;
  const r = await probeWithMutants(probe, [
    {
      name: 'no-valid-guard',
      fn: 'Resolve-ServeCodeScope',
      find: 'if (-not [string]::IsNullOrWhiteSpace($RepoScope) -and -not $plan.Identity) { $valid = $false }',
      replace: '# mutated: guard removed',
    },
  ], { timeoutMs: 180000 });

  const o = r.real;
  assert.equal(o.valid, true);
  assert.equal(o.slug, 'redis/redis');
  assert.equal(o.mode, 'only');
  assert.deepEqual(o.engines.slice().sort(), ['GitHubCode', 'GrepApp', 'Sourcegraph']);
  assert.equal(o.badValid, false, '★ 非法 repoScope 必须 Valid=false');
  assert.equal(o.badSlug, null);
  assert.equal(o.noneValid, true, '不传 repoScope ⇒ 合法（走全局）');
  assert.equal(o.noneMode, 'add');
  assert.equal(r.mutants['no-valid-guard'].badValid, true, '★ 变异后仍判非法 ⇒ 守卫没被测到');
});
