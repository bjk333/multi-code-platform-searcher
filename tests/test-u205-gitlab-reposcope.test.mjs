// U-205（2026-10-21，v1.46.9）：`-RepoScope` 指向 GitLab 时没有**项目级** blob 检索。
//
// 事实：only 模式此前把 GitLabBlobs 整源排除（"源不支持仓库过滤"），于是 gitlab 宿主的仓库作用域
//   只能靠 searchcode 一条外部通道；而 GitLab 自己就有 `GET /projects/{group%2Fproject}/search?scope=blobs`
//   （2026-10-21 实测：token 认证 200，1.6–2.1s，返回 path/startline/data/ref）。
//
// 口径：
//   · 给了 RepoScope 且宿主是 gitlab ⇒ **只查这一个项目**（1 次请求），不跑"全局→项目搜索→逐项目"发现链；
//   · 路径 URL-编码进 `:id`（`group%2Fproject`）；不编码会被当成两个路径段 ⇒ 404；
//   · 404 ⇒ `error` + 可读原因（项目不存在/私有），不能报成"项目内无命中"；
//   · 非 gitlab 宿主 ⇒ 计划里显式排除 GitLabBlobs（否则会拿 github slug 去查 gitlab，404 被读成"仓库不存在"）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeWithMutants, MAIN, PRODUCT_SRC } from './r94-ps-probe.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN_SRC = PRODUCT_SRC().replace(/^\uFEFF/, '');

test('U-205 A: 静态 —— 项目级函数/接线/注册表/宿主排除/行锚点', () => {
  assert.match(MAIN_SRC, /function Invoke-GitLabRepoScopedBlobs \{/, '缺项目级检索函数');
  assert.match(MAIN_SRC, /\/projects\/\$\(\[uri\]::EscapeDataString\(\$RepoSlug\)\)\/search\?scope=blobs/, '★ 项目路径必须编码后进 :id');
  const line = MAIN_SRC.split('\n').find(l => l.includes("Name = 'GitLabBlobs'"));
  assert.ok(line, 'GitLabBlobs 注册项缺失');
  assert.match(line, /SupportsRepoScope = \$true/, '★ GitLabBlobs 必须声明支持仓库作用域');
  assert.match(line, /Invoke-GitLabRepoScopedBlobs/, '★ Needs 必须注入新函数（否则池内 CommandNotFound）');
  const eng = fs.readFileSync(path.join(ROOT, 'engines', 'gitlab-blobs.ps1'), 'utf8');
  assert.match(eng, /if \(-not \[string\]::IsNullOrWhiteSpace\(\$RepoScope\)\) \{[\s\S]{0,200}Invoke-GitLabRepoScopedBlobs/, '★ 引擎必须先走项目级分支');
  assert.match(MAIN_SRC, /GitLabBlobs\(只能按 GitLab 项目作用域检索\)/, '★ 非 gitlab 宿主必须在计划里排除它');
  assert.match(MAIN_SRC, /if \(\$ns -and \$item\.startline\) \{ \$blobUrl = "\$blobUrl#L\$\(\$item\.startline\)" \}/, '★ 结果链接必须带行锚点');
});

test('U-205 B: 行为 —— URL 编码/映射/状态/404/空结果/计划（变异：不编码 ⇒ 红）', async () => {
  const probe = `
$ErrorActionPreference = 'Stop'
$env:GITLAB_TOKEN = 'fake-token'
$global:__url = ''
$global:__payload = '[{"basename":"cache","data":"def expire","path":"lib/cache.rb","id":null,"ref":"main","startline":42,"project_id":123}]'
function global:Invoke-ApiRequest { param($Uri, $Headers, $TimeoutSec, $MaxAttempts, $Method, $Body) $global:__url = [string]$Uri; [pscustomobject]@{ Content = $global:__payload; StatusCode = 200 } }
# ★B2-1（U-265）：引擎已改返回**封套**、不再自报状态 ⇒ 结果从 .results 取，状态走生产同一条 L1 链路派生。
#   另：★U-266 起**不再桩掉** Write-ColorOutput —— 它已改走 stderr，进度串进不了封套。
#   保留桩就等于把被测路径换一条（这类绿不算数）；本条行为臂现在用产品原函数跑。
#   ★本段是 JS 模板字符串 ⇒ 注释里**不许出现反引号**（会把模板提前闭合，报 Unexpected identifier）。
function global:Get-Derived($Envelope) {
    $v = Resolve-EngineVerdict -Envelope (ConvertTo-EngineEnvelope -Engine 'GitLabBlobs' -Kind 'code' -Result $Envelope)
    return [pscustomobject]@{ Status = [string](ConvertTo-LegacyEngineStatus -Verdict $v); Reason = [string]$v.Reason }
}
$out = [ordered]@{}
$envl = Search-GitLabBlobs -Keyword 'expire' -Limit 3 -RepoScope 'group/proj'
$d = Get-Derived $envl
$out.url = $global:__url
$out.count = @($envl.results).Count
$out.name = $envl.results[0].Name
$out.file = $envl.results[0].File
$out.line = $envl.results[0].Line
$out.resultUrl = $envl.results[0].Url
$out.preview = $envl.results[0].Preview
$out.status = $d.Status
$out.reason = $d.Reason
# PS7 会把**单元素数组**展开成单个对象（PS5.1 保持数组）⇒ 有 path 的单条仍必须算 1 条
$global:__payload = '{"path":"single.rb","startline":7,"ref":"main","data":"x = 1"}'
$out.singleCount = @((Search-GitLabBlobs -Keyword 'x' -Limit 1 -RepoScope 'group/proj').results).Count
# 空数组 ⇒ empty（PS7 把 '[]' 解析成 $null，不得当成失败）
$global:__payload = '[]'
$eE = Search-GitLabBlobs -Keyword 'x' -Limit 1 -RepoScope 'group/proj'
$out.emptyCount = @($eE.results).Count
$out.emptyStatus = (Get-Derived $eE).Status
# 404 ⇒ error + 可读原因（不能报成"项目内无命中"）
function global:Invoke-ApiRequest { param($Uri, $Headers, $TimeoutSec, $MaxAttempts, $Method, $Body) throw 'HTTP 404 Not Found (gitlab.com)' }
$nE = Search-GitLabBlobs -Keyword 'x' -Limit 1 -RepoScope 'group/missing'
$out.nfCount = @($nE.results).Count
$out.nfStatus = (Get-Derived $nE).Status
$out.nfReason = (Get-Derived $nE).Reason
# 计划：gitlab 宿主包含 / github 宿主排除
$pg = Get-CodeScopePlan -RepoScope 'https://gitlab.com/group/proj' -RepoScopeMode 'only'
$out.glEngines = @($pg.Engines | ForEach-Object { $_.Name })
$ph = Get-CodeScopePlan -RepoScope 'https://github.com/o/r' -RepoScopeMode 'only'
$out.ghExcluded = @($ph.Excluded)
$out
`;
  const r = await probeWithMutants(probe, [
    { name: 'no-escape', fn: 'Invoke-GitLabRepoScopedBlobs', find: '[uri]::EscapeDataString($RepoSlug)', replace: '$RepoSlug' },
  ], { timeoutMs: 180000 });

  const o = r.real;
  assert.equal(o.count, 1);
  assert.match(o.url, /projects\/group%2Fproj\/search\?scope=blobs/, '★ 项目路径必须编码成 group%2Fproj');
  assert.match(o.url, /search=expire/);
  assert.match(o.url, /per_page=3/, 'per_page 必须跟随 -Limit');
  assert.equal(o.name, 'group/proj', 'Name 用仓库路径（供作用域二次过滤匹配）');
  assert.equal(o.file, 'lib/cache.rb');
  assert.equal(o.line, 42);
  assert.equal(o.resultUrl, 'https://gitlab.com/group/proj/-/blob/main/lib/cache.rb#L42');
  assert.equal(o.preview, 'def expire');
  assert.equal(o.status, 'ok');
  // ★B2-1（U-265）：成功路径的 verdict.Reason 是空的 —— **ok 不需要"为什么"**（那是失败/降级才需要的）。
  //   "查的是哪个仓库"只在零命中时以 warning 形式出现（U-265 harness 的 repoZero 臂钉住）。这里只断言它不为失败。
  assert.equal(o.reason, '', 'ok 不该带 reason：Reason 是给失败/降级用的，不是给成功加注解的');
  assert.equal(o.singleCount, 1, '★ PS7 展开单元素数组后仍必须算 1 条（不能报"返回非数组"）');
  assert.equal(o.emptyCount, 0);
  assert.equal(o.emptyStatus, 'empty', '★ 空数组是 empty，不是 error');
  assert.equal(o.nfCount, 0);
  assert.equal(o.nfStatus, 'error', '★ 404 必须记 error');
  assert.match(o.nfReason, /项目不存在或无权访问/, '★ 404 的原因必须可读（别只说 HTTP 404）');
  assert.ok(o.glEngines.includes('GitLabBlobs'), '★ gitlab 宿主必须让 GitLabBlobs 参与');
  assert.ok(o.ghExcluded.some(x => x.includes('只能按 GitLab 项目作用域检索')), '★ github 宿主必须排除 GitLabBlobs 并说明原因');

  assert.doesNotMatch(r.mutants['no-escape'].url || '', /%2F/, '★ 变异后仍编码 ⇒ 这道门测不到路径编码');
});
