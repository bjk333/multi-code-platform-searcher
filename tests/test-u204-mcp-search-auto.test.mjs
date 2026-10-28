// U-204（2026-10-21，v1.46.8）：MCP 够不到 planner —— 新增 `search_auto`（等价 CLI `-Auto`）。
//
// 事实：CLI 有 `-Auto`（planner 判 queryType → repo/code/research 并集），MCP 只能让 Agent 自己猜
//   该调 `search_repositories` / `search_code` / `research`；猜错就是整轮空跑，而 Agent 无法自诊断。
//
// 口径：
//   · `search_auto` 返回 `modes` + `queryType` + `planSource` + `counts`（不是只回一个结果数组）——
//     "为什么跑这几种模式"必须可见，否则分类错了只能看到"结果不像"；
//   · 关键词分工与 CLI 一致：repo/code 用 `Get-AutoSearchKeyword`（抽技术词），research 用**原句**；
//   · Serve 的每个检索 op 都带 `reasons{引擎: "<status>: <reason>"}` —— 0 条要能区分"真的没有"与"限流/截止/令牌"。

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

test('U-204 A: 静态接线 —— auto op / 计划对象 / 关键词分工 / 每 op 的 reasons / MCP 白名单', () => {
  assert.match(MAIN_SRC, /function Get-AutoPlan \{/, '缺 Get-AutoPlan（MCP 需要 queryType/planSource）');
  assert.match(MAIN_SRC, /function Get-AutoModes \{[\s\S]{0,300}Get-AutoPlan -Keyword \$Keyword/, '★ Get-AutoModes 必须委托给 Get-AutoPlan（否则两套分类口径）');
  const autoAt = MAIN_SRC.indexOf("'auto' {");
  assert.ok(autoAt > 0, 'Serve 缺 auto op');
  // v1.49.0：auto 分支为 coverage 多算了 $plan0/$autoNames，字符窗口会截断 ⇒ 改用下一个 case 作结束锚点
  const autoEnd = MAIN_SRC.indexOf("'repo' {", autoAt);
  const auto = MAIN_SRC.slice(autoAt, autoEnd > autoAt ? autoEnd : autoAt + 6000);
  assert.match(auto, /\$p = Get-AutoPlan -Keyword \$kw/, '★ auto op 必须调用 planner');
  assert.match(auto, /Invoke-ConcurrentPlatformSearch -Platforms \$names -Keyword \$ak/, '★ repo 模式要用改写后的关键词');
  assert.match(auto, /Invoke-ConcurrentCodeSearch -Keyword \$ak/, '★ code 模式要用改写后的关键词');
  assert.match(auto, /Invoke-ConcurrentResearchSearch -Keyword \$kw /, '★ research 必须用原句（与 CLI 一致）');
  assert.match(auto, /modes = @\(\$bag\.modes\)/, '响应必须回 modes');
  assert.match(auto, /queryType = \$bag\.queryType/, '响应必须回 queryType（分类错了要能看出来）');
  assert.match(auto, /counts = \[PSCustomObject\]@\{ repo = @\(\$bag\.repo\)\.Count/, '响应必须回每模式条数');
  assert.match(auto, /Get-ServeCacheKey -Op 'auto'/, 'auto 必须进 Serve 缓存键');
  // v1.48.2：repo op 的 reasons 要带上被 MCPS_DISABLE 挡在池外的源 ⇒ 调用形态多一个可选参数；
  //   这里放宽**参数**，不放宽"必须有 reasons"—— 漏掉任何一处仍会少一条命中。
  const reasonHits = MAIN_SRC.match(/reasons = \(Get-ServeReasons(?: -Disabled \$disabledNames)?\)/g) || [];
  assert.ok(reasonHits.length >= 5, '★ 四个检索 op + package 都必须带 reasons，实际 ' + reasonHits.length);
  const py = fs.readFileSync(path.join(ROOT, 'mcps.py'), 'utf8');
  assert.match(py, /"search_auto": \("auto", \{"keyword", "limit", "maxResults", "language", "minStars", "site"\}\)/, 'MCP_TOOL_OPS 缺 search_auto');
  assert.match(py, /"name": "search_auto"/, 'tools/list 缺 search_auto');
});

test('U-204 B: 行为 —— 计划对象与 reasons 过滤（含变异：不叠加 research 必须红）', async () => {
  const probe = `
$ErrorActionPreference = 'Stop'
$out = [ordered]@{}
$p1 = Get-AutoPlan -Keyword 'Find-LocalSearchBinary function implementation'
$out.t1 = $p1.QueryType; $out.m1 = @($p1.Modes)
$p2 = Get-AutoPlan -Keyword 'best practices refactoring large legacy codebase into modules'
$out.t2 = $p2.QueryType; $out.m2 = @($p2.Modes)
$p3 = Get-AutoPlan -Keyword 'refactoring modules (methodological review)'
$out.t3 = $p3.QueryType; $out.m3 = @($p3.Modes)
$out.src = $p1.Source
# Get-AutoModes 兼容（U-143 依赖它）
$out.modesCompat = @(Get-AutoModes -Keyword 'Find-LocalSearchBinary function implementation') -join ','
# reasons：只列非 ok/empty
foreach ($pair in @(@('A','ok',''), @('B','empty','检索成功但 0 命中'), @('C','error','boom'), @('D','rate_limited','429'))) {
  Set-EngineStatus -Name $pair[0] -Status $pair[1] -Reason $pair[2]
}
$out.reasons = Get-ServeReasons
$out
`;
  const r = await probeWithMutants(probe, [
    { name: 'no-research-augment', fn: 'Get-AutoPlan', find: '$plan.Modes = @(Add-AutoResearchMode -Modes $modes -Keyword $Keyword)', replace: '$plan.Modes = @($modes)' },
  ], { timeoutMs: 180000 });

  const o = r.real;
  assert.equal(o.t1, 'code_evidence_only');
  assert.deepEqual(o.m1, ['code']);
  assert.equal(o.t2, 'integrated_research_and_code');
  assert.deepEqual(o.m2, ['repo', 'code', 'research']);
  assert.equal(o.t3, 'code_evidence_only');
  assert.deepEqual(o.m3, ['code', 'research'], '★ 方法论口吻必须叠加 research（Add-AutoResearchMode）');
  assert.equal(o.src, 'planner');
  assert.equal(o.modesCompat, 'code');
  assert.deepEqual(Object.keys(o.reasons), ['C', 'D'], '★ reasons 只列非 ok/empty');
  assert.equal(o.reasons.C, 'error: boom');
  assert.equal(o.reasons.D, 'rate_limited: 429');

  assert.deepEqual(r.mutants['no-research-augment'].m3, ['code'], '★ 变异后仍带 research ⇒ 这道门测不到 Add-AutoResearchMode');
});

test('U-204 C: Python 契约 —— tools/list 六件套、op=auto、未知键拒绝', async () => {
  const out = await runPy(`
import json, mcps
tools = {t["name"]: t for t in mcps.mcp_tools()}
out = {}
out["names"] = sorted(tools)
out["props"] = sorted(tools["search_auto"]["inputSchema"]["properties"])
out["req"] = mcps.build_tool_request("search_auto", {"keyword": "jwt", "limit": 3, "minStars": 0, "language": "go", "site": "serverfault"})
try:
    mcps.build_tool_request("search_auto", {"keyword": "jwt", "repoScope": "a/b"})
    out["bad"] = "NO-ERROR"
except ValueError as e:
    out["bad"] = str(e)
print(json.dumps(out, ensure_ascii=False))
`);
  assert.deepEqual(out.names, ['package_lookup', 'ping', 'research', 'search_auto', 'search_code', 'search_repositories']);
  assert.deepEqual(out.props, ['keyword', 'language', 'limit', 'maxResults', 'minStars', 'site']);
  assert.equal(out.req.op, 'auto');
  assert.equal(out.req.limit, 3);
  assert.equal(out.req.minStars, 0);
  assert.equal(out.req.language, 'go');
  assert.equal(out.req.site, 'serverfault');
  assert.match(out.bad, /unexpected arguments for search_auto: repoScope/, '★ auto 不接受仓库作用域（那是 search_code 的参数）');
});
