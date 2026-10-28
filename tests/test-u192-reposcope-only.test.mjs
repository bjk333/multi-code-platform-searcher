// U-192（2026-10-21，v1.46.5）：`-RepoScope` 必须真的是"仓库级"。
//
// 事实（2026-10-21 实测）：`-CodeEvidence -RepoScope https://github.com/redis/redis -Keyword expire` 返回 9 条，
//   其中 3 条来自 openclaw/openclaw（grep.app）、3 条来自 SEExcerpts —— 旧实现只是把 searchcode 结果**追加**到全局池结果后面。
//
// 口径（本门锁定）：
//   · `-RepoScopeMode only`（默认）= 只跑 SupportsRepoScope 的源 + 按仓库身份**二次过滤**（上游忽略限定符也剔掉）；
//   · `-RepoScopeMode add` = 旧行为（全局池 + 追加 searchcode），显式选择才用；
//   · 身份解析：git URL / git@scp / owner/repo / 带 .git / 尾斜杠 都归一成 host + slug；
//   · 无法解析 ⇒ 退回 add 并告警（绝不"过滤成 0 条"当作答案）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { probeWithMutants, MAIN, PRODUCT_SRC } from './r94-ps-probe.mjs';

const MAIN_SRC = PRODUCT_SRC().replace(/^\uFEFF/, '');

test('U-192 A: 源码契约 —— 默认 only、可选 add；二次过滤与 Requested 同源', () => {
  assert.match(MAIN_SRC, /\[ValidateSet\('only', 'add'\)\]\s*\n\s*\[string\]\$RepoScopeMode = 'only'/, '★ -RepoScopeMode 默认必须是 only');
  assert.match(MAIN_SRC, /SupportsRepoScope = \$true/, '注册表必须声明哪些源支持仓库过滤');
  assert.match(MAIN_SRC, /Select-RepoScopedResults -Results \$modeResults -Identity \$scopePlan\.Identity/, '★ only 模式必须做库外结果二次过滤');
  assert.match(MAIN_SRC, /Get-CodeScopePlan -RepoScope \$RepoScope -RepoScopeMode \$RepoScopeMode/, '作用域计划必须由参数驱动');
  assert.match(MAIN_SRC, /_codeScopePlan\.Mode -eq 'only'[\s\S]{0,200}Engines/, '★ Requested 必须只取作用域内引擎（否则被排除源记 not-run ⇒ 假 degraded）');
  assert.match(MAIN_SRC, /-RepoScope "\{0\}" 无法解析/, '解析失败必须有告警');
  assert.match(MAIN_SRC, /\$cacheKey = "evidence#\$AutoKeyword#\$Language#\$Limit#\$RepoScope#\$RepoScopeMode#\$PathFilter/, '★ 作用域必须进代码缓存键');
});

test('U-192 B: 身份解析 / 匹配 / 计划（变异：only 退化成 add ⇒ 计划变空）', async () => {
  const probe = `
$ErrorActionPreference = 'Stop'
$out = [ordered]@{}
$out.url   = Get-RepoIdentity -Repository 'https://github.com/redis/redis'
$out.git   = Get-RepoIdentity -Repository 'git@github.com:redis/redis.git'
$out.short = Get-RepoIdentity -Repository 'redis/redis'
$out.gl    = Get-RepoIdentity -Repository 'https://gitlab.com/group/sub/proj.git'
$out.bad   = Get-RepoIdentity -Repository 'not-a-repo'
$id = $out.url
$out.inScope  = Test-RepoScopeMatch -Result ([pscustomobject]@{ Name = 'redis/redis'; Url = 'https://github.com/redis/redis/blob/x/src/expire.c' }) -Identity $id
$out.outScope = Test-RepoScopeMatch -Result ([pscustomobject]@{ Name = 'openclaw/openclaw'; Url = 'https://github.com/openclaw/openclaw/blob/x/a.ts' }) -Identity $id
$out.sgHost   = Test-RepoScopeMatch -Result ([pscustomobject]@{ Name = 'gitlab.com/redis/redis'; Url = '' }) -Identity $id
$out.sgOk     = Test-RepoScopeMatch -Result ([pscustomobject]@{ Name = 'github.com/redis/redis'; Url = '' }) -Identity $id
$sel = Select-RepoScopedResults -Identity $id -Results @(
  ([pscustomobject]@{ Name = 'redis/redis'; Url = 'https://github.com/redis/redis/blob/x/a.c' }),
  ([pscustomobject]@{ Name = 'openclaw/openclaw'; Url = 'https://github.com/openclaw/openclaw/blob/x/a.ts' }),
  ([pscustomobject]@{ Name = 'https://github.com/redis/redis'; Url = 'https://github.com/redis/redis/blob/abc/src/b.c#L3' })
)
$out.kept = @($sel.Kept).Count
$out.dropped = $sel.Dropped
$out.planOnly = @((Get-CodeScopePlan -RepoScope 'https://github.com/redis/redis' -RepoScopeMode 'only').Engines | ForEach-Object { $_.Name })
$out.planGitlab = @((Get-CodeScopePlan -RepoScope 'https://gitlab.com/g/r' -RepoScopeMode 'only').Engines | ForEach-Object { $_.Name })
$out.excluded = @((Get-CodeScopePlan -RepoScope 'https://gitlab.com/g/r' -RepoScopeMode 'only').Excluded)
$out.excludedGh = @((Get-CodeScopePlan -RepoScope 'https://github.com/redis/redis' -RepoScopeMode 'only').Excluded)
$out.planAdd = (Get-CodeScopePlan -RepoScope 'https://github.com/redis/redis' -RepoScopeMode 'add').Mode
$out.planBad = (Get-CodeScopePlan -RepoScope 'not-a-repo' -RepoScopeMode 'only').Mode
$out
`;
  const r = await probeWithMutants(probe, [
    { name: 'only-downgraded', fn: 'Get-CodeScopePlan', find: "if ($RepoScopeMode -ne 'only') { return $plan }", replace: 'if ($true) { return $plan }' },
  ], { timeoutMs: 180000 });

  const o = r.real;
  assert.equal(o.url.Slug, 'redis/redis');
  assert.equal(o.git.Slug, 'redis/redis', 'git@ 形态必须等价');
  assert.equal(o.short.Slug, 'redis/redis');
  assert.equal(o.gl.Slug, 'group/sub/proj', 'GitLab 子组必须保留全路径');
  assert.equal(o.bad, null, '解析不了必须返回 null（由调用方告警并退回 add）');

  assert.equal(o.inScope, true);
  assert.equal(o.outScope, false, '★ 库外结果必须判 false（openclaw/openclaw 是实测混进来的那条）');
  assert.equal(o.sgHost, false, '★ 同名仓库但 host 不同必须判 false');
  assert.equal(o.sgOk, true, 'Sourcegraph 形态（host/owner/repo）必须认');
  assert.equal(o.kept, 2, '库内两条要保留（含 searchcode 的 URL 形态）');
  assert.equal(o.dropped, 1);

  assert.deepEqual(o.planOnly.slice().sort(), ['GitHubCode', 'GrepApp', 'Sourcegraph'], 'github 仓库 ⇒ 三个支持仓库过滤的源');
  // v1.46.9（U-205）：gitlab 宿主多了 GitLabBlobs 的**项目级**通道（/projects/:id/search?scope=blobs）；
  //   github 宿主仍必须排除它（拿 github slug 去查 gitlab 只会 404，还会被读成"仓库不存在"）。
  assert.deepEqual(o.planGitlab.slice().sort(), ['GitLabBlobs', 'Sourcegraph'], 'gitlab 仓库 ⇒ GitHub/GrepApp 排除；GitLabBlobs 以项目级参与');
  assert.ok(!o.planOnly.includes('GitLabBlobs'), '★ github 仓库不得让 GitLabBlobs 参与');
  assert.ok(o.excludedGh.some(x => x.startsWith('GitLabBlobs') && x.includes('只能按 GitLab 项目作用域检索')), '★ 非 gitlab 宿主的排除原因要写明');
  assert.ok(o.excluded.some(x => x.startsWith('GitHubCode')), '被排除的源必须给出原因');
  assert.equal(o.planAdd, 'add', 'add 模式保留旧行为');
  assert.equal(o.planBad, 'add', '解析失败退回 add（不假装过滤）');

  assert.equal(r.mutants['only-downgraded'].planOnly.length, 0, '★ 变异后仍是 only ⇒ 这道门测不到默认语义');
});
