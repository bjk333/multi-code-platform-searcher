// U-202（2026-10-21，v1.46.7）：仓库发现质量过滤（T1-1/T1-2）。
//
// 事实：`-MinStars` 只能筛热度，筛不掉"归档的死项目/两年前最后提交/许可证不明"的仓库；
//   而"许可证"直接决定能不能复用代码，是仓库发现阶段就该有的过滤。
//
// 口径（四源字段能力实测 2026-10-21，不翻译成上游限定符）：
//   · GitHub archived/license/updated；Codeberg archived/updated；Gitee(so) license/last_push_at；
//     **GitLab /projects 列表三样都不返回**；
//   · 缺字段 ⇒ **不剔除**该条，并在 warnings/filterNotes 明说"<源> 不返回 X ⇒ 未过滤（N 条无法判断）"；
//   · `-License` 下"无 license 信息"的条目会被剔除并单列计数（null ≠ 不匹配）；
//   · 过滤后 0 条必须说"这是过滤结果，不是源无命中"（否则又是一次假零命中）。

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

test('U-202 A: 静态接线 —— 参数/纯函数/接线/字段透出/MCP 白名单', () => {
  assert.match(MAIN_SRC, /\[ValidateRange\(0, 36500\)\]\s*\n\s*\[int\]\$ActiveWithin = 0/, '缺 -ActiveWithin 参数');
  assert.match(MAIN_SRC, /\[switch\]\$ExcludeArchived/, '缺 -ExcludeArchived 参数');
  assert.match(MAIN_SRC, /\[string\]\$License = ''/, '缺 -License 参数');
  for (const fn of ['ConvertTo-RepoUpdatedAt', 'ConvertTo-RepoLicenseSet', 'Select-RepoQualityResults', 'Get-RepoQualityNotes', 'Write-RepoQualityWarnings']) {
    assert.match(MAIN_SRC, new RegExp('function ' + fn + ' \\{'), '缺纯函数 ' + fn);
  }
  // 接线：repo 分支必须真的调用（否则参数是装饰）
  // 主脚本里有多个 `if ($runModes -contains 'repo')` 块（执行/coverage 各一），按**调用点**定位更稳：
  const callAt = MAIN_SRC.indexOf('$qf = Select-RepoQualityResults -Results $modeResults');
  assert.ok(callAt > 0, '★ repo 分支没有调用质量过滤');
  const tail = MAIN_SRC.slice(callAt, callAt + 1800);
  assert.match(tail, /Write-RepoQualityWarnings -Stats \$qf\.Stats/, '★ 过滤结果没有进 warnings');
  assert.match(tail, /检索成功但质量过滤剔除全部/, '★ 被过滤光时必须改状态（不能留 ok 让调用方以为有结果）');
  assert.match(MAIN_SRC, /if \(\$ActiveWithin -gt 0 -or \$ExcludeArchived -or -not \[string\]::IsNullOrWhiteSpace\(\$License\)\) \{/, '★ 三个开关都没开时不得进入过滤分支');
  // 字段来源：GitHub/Codeberg 必须透出 Archived；缺失写 $null（未知），不伪造 false
  const gh = fs.readFileSync(path.join(ROOT, 'engines', 'github.ps1'), 'utf8');
  const archExpr = /Archived = \$\(if \(\$null -ne \$item\.archived\) \{ \[bool\]\$item\.archived \} else \{ \$null \}\)/;
  assert.match(gh, archExpr, '★ GitHub 结果必须透出 Archived，且缺失写 $null（不能写 false）');
  const cb = fs.readFileSync(path.join(ROOT, 'engines', 'codeberg.ps1'), 'utf8');
  assert.match(cb, archExpr, '★ Codeberg 结果必须透出 Archived，且缺失写 $null');
  // Serve/MCP：过滤 + filtered/filterNotes（Serve 不输出 warnings，只能靠这两个字段可见）
  assert.match(MAIN_SRC, /Select-RepoQualityResults -Results \$res -ActiveWithin \$aw/, '★ Serve repo op 没接质量过滤');
  assert.match(MAIN_SRC, /filterNotes = @\(\$fNotes\)/, '★ MCP 响应必须带 filterNotes（否则看不到"某源不支持该过滤"）');
  const py = fs.readFileSync(path.join(ROOT, 'mcps.py'), 'utf8');
  assert.match(py, /"search_repositories": \("repo", \{"keyword", "limit", "maxResults", "platforms", "language", "minStars",\s*\n\s*"activeWithin", "excludeArchived", "license"\}\)/, 'MCP_TOOL_OPS 缺三参数');
  for (const k of ['activeWithin', 'excludeArchived', 'license']) {
    assert.match(py, new RegExp('"' + k + '": \\{"type"'), 'search_repositories schema 缺 ' + k);
  }
});

test('U-202 B: 行为 —— 三类过滤的计数/保留集/未知字段告警（含变异：去掉任一判据必须红）', async () => {
  const probe = `
$ErrorActionPreference = 'Stop'
$now = [datetime]::UtcNow
$rows = @(
  [pscustomobject]@{Platform='GitHub'; Name='a/arch';  License='mit';        Updated=$now.AddDays(-5).ToString('o'); Archived=$true},
  [pscustomobject]@{Platform='GitHub'; Name='b/stale'; License='mit';        Updated='2021-01-01T00:00:00Z'; Archived=$false},
  [pscustomobject]@{Platform='GitHub'; Name='c/gpl';   License='gpl-3.0';    Updated=$now.AddDays(-3).ToString('o'); Archived=$false},
  [pscustomobject]@{Platform='GitHub'; Name='d/mit';   License='MIT';        Updated=$now.AddDays(-2).ToString('o'); Archived=$false},
  [pscustomobject]@{Platform='GitLab'; Name='g/nolic'; License=$null;        Updated=$now.AddDays(-1).ToString('o')},
  [pscustomobject]@{Platform='Gitee';  Name='e/apache'; License='Apache-2.0'; Updated=$null}
)
$out = [ordered]@{}
$q = Select-RepoQualityResults -Results $rows -ActiveWithin 365 -ExcludeArchived -License 'mit,apache-2.0'
$out.kept = @($q.Kept | ForEach-Object { $_.Name })
$out.archived = $q.Stats.Archived
$out.stale = $q.Stats.Stale
$out.licMiss = $q.Stats.LicenseMismatch
$out.licNone = $q.Stats.LicenseMissing
$out.archUnknown = @($q.Stats.ArchivedUnknown.Keys | Sort-Object)
$out.updUnknown = @($q.Stats.UpdatedUnknown.Keys | Sort-Object)
$out.notes = @(Get-RepoQualityNotes -Stats $q.Stats -ActiveWithin 365 -ExcludeArchived -License 'mit,apache-2.0')
# 默认路径：三个开关都不开 ⇒ 一条不剔、一句不说
$q0 = Select-RepoQualityResults -Results $rows
$out.plainKept = @($q0.Kept).Count
$out.plainNotes = @(Get-RepoQualityNotes -Stats $q0.Stats).Count
# 全部被剔除 ⇒ 必须明说"是过滤结果，不是源无命中"
$q3 = Select-RepoQualityResults -Results $rows -License 'wtfpl'
$out.zeroKept = @($q3.Kept).Count
$out.zeroNotes = @(Get-RepoQualityNotes -Stats $q3.Stats -License 'wtfpl')
# 非结果对象（没有 Name）不应被当成"无 license ⇒ 剔除"的来源，也不该改变计数语义
$out
`;
  const r = await probeWithMutants(probe, [
    { name: 'no-archived-drop', fn: 'Select-RepoQualityResults', find: 'elseif ($prop.Value -eq $true) { $stats.Archived++; continue }', replace: 'elseif ($false) { $stats.Archived++; continue }' },
    { name: 'archived-unknown-as-false', fn: 'Select-RepoQualityResults', find: 'if ($null -eq $prop -or $null -eq $prop.Value) { $stats.ArchivedUnknown[$p] = 1 + [int]$stats.ArchivedUnknown[$p] }', replace: 'if ($false) { $stats.ArchivedUnknown[$p] = 1 + [int]$stats.ArchivedUnknown[$p] }' },
    { name: 'license-missing-as-mismatch', fn: 'Select-RepoQualityResults', find: 'if (-not $l -or $l -eq \'noassertion\' -or $l -eq \'other\') {', replace: 'if ($false) {' },
    { name: 'no-zero-note', fn: 'Get-RepoQualityNotes', find: 'if ($Stats.Input -gt 0 -and $left -eq 0) {', replace: 'if ($false) {' },
  ], { timeoutMs: 180000 });

  const o = r.real;
  assert.deepEqual(o.kept, ['d/mit', 'e/apache'], '★ 保留集必须精确（归档/过期/许可证不符/无许可证 四类都要剔）');
  assert.equal(o.archived, 1);
  assert.equal(o.stale, 1);
  assert.equal(o.licMiss, 1);
  assert.equal(o.licNone, 1);
  assert.deepEqual(o.archUnknown, ['Gitee', 'GitLab'], '★ Gitee/GitLab 不返回 archived ⇒ 必须记为"无法判断"');
  assert.deepEqual(o.updUnknown, ['Gitee'], '★ Gitee 该条无更新时间 ⇒ 必须记为"无法判断"');
  assert.ok(o.notes.some(n => n.includes('GitLab 不返回 archived') && n.includes('1 条无法判断')), '★ 缺字段要在告警里点名到源、且给出条数');
  assert.ok(o.notes.some(n => n.includes('Gitee 不返回 archived')), '★ Gitee 也不返回 archived，必须同样点名');
  assert.ok(o.notes.some(n => n.includes('Gitee 不返回 更新时间')), '★ 更新时间缺失也要点名');
  assert.equal(o.plainKept, 6, '默认路径（不传过滤）必须原样返回');
  assert.equal(o.plainNotes, 0, '默认路径不许有噪音');
  assert.equal(o.zeroKept, 0);
  assert.ok(o.zeroNotes.some(n => n.includes('这是过滤结果，不是源无命中')), '★ 过滤到 0 必须与"零命中"区分开');

  // 变异：去掉 archived 判据 ⇒ 保留集变化 + 计数为 0
  assert.notDeepEqual(r.mutants['no-archived-drop'].kept, o.kept, '★ 变异后仍剔归档 ⇒ 这道门测不到 archived 分支');
  assert.equal(r.mutants['no-archived-drop'].archived, 0);
  // 变异：把"未知"当成已归档=false ⇒ 告警里的 GitLab 消失
  assert.deepEqual(r.mutants['archived-unknown-as-false'].archUnknown, [], '★ 变异后仍报 GitLab 未知 ⇒ 未知分支没被测到');
  // 变异：无 license 当成不匹配 ⇒ licNone 归零、licMiss 变大
  assert.equal(r.mutants['license-missing-as-mismatch'].licNone, 0);
  // 变异：删掉"过滤到 0"提示 ⇒ 必须没人再说这句话
  assert.ok(!r.mutants['no-zero-note'].zeroNotes.some(n => n.includes('这是过滤结果')), '★ 变异后仍出现该提示 ⇒ 这道门测不到');
});

test('U-202 C: Python 契约 —— 三参数透传；布尔/字符串类型必须严格（不静默转换）', async () => {
  const out = await runPy(`
import json, mcps
tools = {t["name"]: t for t in mcps.mcp_tools()}
out = {}
out["props"] = sorted(tools["search_repositories"]["inputSchema"]["properties"])
req = mcps.build_tool_request("search_repositories", {"keyword": "redis", "activeWithin": 180, "excludeArchived": True, "license": "mit"})
out["req"] = {k: req[k] for k in ("activeWithin", "excludeArchived", "license")}
for bad in ({"keyword": "x", "excludeArchived": "true"}, {"keyword": "x", "license": 3}, {"keyword": "x", "activeWithin": "180"}):
    try:
        mcps.build_tool_request("search_repositories", bad)
        out.setdefault("errs", []).append("NO-ERROR")
    except ValueError as e:
        out.setdefault("errs", []).append(str(e))
print(json.dumps(out, ensure_ascii=False))
`);
  assert.deepEqual(out.props, ['activeWithin', 'excludeArchived', 'keyword', 'language', 'license', 'limit', 'maxResults', 'minStars', 'platforms']);
  assert.deepEqual(out.req, { activeWithin: 180, excludeArchived: true, license: 'mit' });
  assert.equal(out.errs.length, 3);
  assert.match(out.errs[0], /excludeArchived must be a boolean/, '★ "true" 字符串必须拒绝（静默转换会把 false 变 True）');
  assert.match(out.errs[1], /license must be a string/);
  assert.match(out.errs[2], /activeWithin must be an integer/);
});
