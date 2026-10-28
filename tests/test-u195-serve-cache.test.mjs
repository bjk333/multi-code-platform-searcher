// U-195（2026-10-21，v1.46.4）：`-Serve`/MCP 查询级缓存。
//
// 事实（2026-10-21 实测，同一 -Serve 进程、同一参数连发两次）：
//   repo 12.08s → 11.48s；research 14.43s → 10.96s；而 CLI 同请求 18.98s → 3.91s（磁盘缓存命中）。
//   原因：Serve 的 repo/research 分支直接调 Invoke-Concurrent*，绕过了主流程的 LRU/磁盘缓存。
//
// 口径：只缓存**有结果**的原始结果（空/失败不缓存，避免把一次限流固化 15 分钟）；
//       键含 op/keyword/limit/platforms/language/minStars/site；MCPS_SERVE_CACHE=0 可关。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { probeWithMutants, rootDir, MAIN } from './r94-ps-probe.mjs';
import { sourceAll } from './lib/source.mjs';

const read = (p) => fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
const SRC = sourceAll(rootDir);   // v1.54.0（B3-2）：读加载后视图
const CODE = SRC.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');

test('U-195 A: 源码契约 —— 三个 op 都走缓存，且响应带 cached 字段', () => {
  const at = CODE.lastIndexOf('if ($Serve) {');
  assert.ok(at > 0, '找不到 -Serve 块');
  const block = CODE.slice(at);
  for (const factory of [
    /Invoke-ServeCached -Key \$ck -Factory \{ @\(Invoke-ConcurrentResearchSearch/,
    /Invoke-ServeCached -Key \$ck -Factory \{ @\(Invoke-ConcurrentPlatformSearch/,
    // U-201：code 分支的 factory 现在先建参数表再调用（作用域参数要按需拼）
    /Invoke-ServeCached -Key \$ck -Factory \{[\s\S]{0,400}?Invoke-ConcurrentCodeSearch/,
    /Invoke-ServeCached -Key \$ck -Factory \{ \$buf = @\(\); foreach \(\$p in \$pkgList\)/,
  ]) {
    assert.match(block, factory, '★ -Serve 的某个 op 分支没有接 Invoke-ServeCached：' + factory);
  }
  const cachedHits = block.match(/cached = \$sc\.Cached/g) || [];
  assert.ok(cachedHits.length >= 4, '★ 四个 op 的响应都必须带 cached 字段（可观测），实际 ' + cachedHits.length);
  // 键必须含影响结果的参数（漏一个就会串结果）；U-201 起 code 还含 repoScope/pathFilter
  assert.match(CODE, /function Get-ServeCacheKey[\s\S]{0,600}\$Op, \$kw, \$Limit, \$Platforms, \$Language, \$MinStars, \$Site/, '缓存键字段不完整');
  assert.match(CODE, /\$Op, \$kw, \$Limit, \$Platforms, \$Language, \$MinStars, \$Site, \$RepoScope, \$PathFilter/, '★ 缓存键必须含 repoScope/pathFilter（否则跨仓库串结果）');
  assert.match(CODE, /MCPS_SERVE_CACHE/, '必须提供关闭开关');
  // 空结果不缓存
  assert.match(CODE, /\$data\.Count -gt 0\) \{ Set-LruResult/, '★ 只缓存有结果的调用（空/失败不缓存）');
});

test('U-195 B/C: 命中/键隔离/开关/空结果 + 变异（去掉早退 ⇒ 第二次仍 miss）', async () => {
  const probe = `
$ErrorActionPreference = 'Stop'
$out = [ordered]@{}
$script:_lruCache = [ordered]@{}
$script:_cacheDirty = $false
$script:CacheFile = Join-Path ([System.IO.Path]::GetTempPath()) ('u195-' + [guid]::NewGuid().ToString('N') + '.json')
$script:n = 0
$f = { $script:n++; @([PSCustomObject]@{ Name = 'x' }) }
$k = Get-ServeCacheKey -Op 'repo' -Keyword ' JWT ' -Limit 3 -Platforms 'GitHub,Gitee' -Language 'python' -MinStars 100 -Site ''
$r1 = Invoke-ServeCached -Key $k -Factory $f
$r2 = Invoke-ServeCached -Key $k -Factory $f
$out.cached1 = [bool]$r1.Cached
$out.cached2 = [bool]$r2.Cached
$out.calls = [int]$script:n
$out.kSame = [bool]($k -eq (Get-ServeCacheKey -Op 'repo' -Keyword 'jwt' -Limit 3 -Platforms 'GitHub,Gitee' -Language 'python' -MinStars 100 -Site ''))
$out.kLang = [bool]($k -ne (Get-ServeCacheKey -Op 'repo' -Keyword 'jwt' -Limit 3 -Platforms 'GitHub,Gitee' -Language 'go' -MinStars 100 -Site ''))
$out.kPlat = [bool]($k -ne (Get-ServeCacheKey -Op 'repo' -Keyword 'jwt' -Limit 3 -Platforms 'GitHub' -Language 'python' -MinStars 100 -Site ''))

# 空结果不缓存
$script:n = 0
$emptyFactory = { $script:n++; @() }
$e1 = Invoke-ServeCached -Key 'serve#empty#x#1####0#' -Factory $emptyFactory
$e2 = Invoke-ServeCached -Key 'serve#empty#x#1####0#' -Factory $emptyFactory
$out.emptyCalls = [int]$script:n
$out.emptyCached = ([bool]($e1.Cached) -or [bool]($e2.Cached))

# 开关关闭 ⇒ 每次都回源
$env:MCPS_SERVE_CACHE = '0'
$script:n = 0
$null = Invoke-ServeCached -Key $k -Factory $f
$null = Invoke-ServeCached -Key $k -Factory $f
$out.offCalls = [int]$script:n
Remove-Item Env:MCPS_SERVE_CACHE -ErrorAction SilentlyContinue
$out
`;
  const r = await probeWithMutants(probe, [
    {
      name: 'no-early-return',
      fn: 'Invoke-ServeCached',
      find: 'if ($null -ne $hit) { return [PSCustomObject]@{ Cached = $true; Data = @($hit) } }',
      replace: '$null = $hit',
    },
  ], { timeoutMs: 180000 });

  const o = r.real;
  assert.equal(o.cached1, false, '第一次必须 miss');
  assert.equal(o.cached2, true, '★ 第二次必须命中');
  assert.equal(o.calls, 1, '★ 两次调用只应执行一次 factory');
  assert.equal(o.kSame, true, 'keyword 归一化（trim + 小写）后必须同键');
  assert.equal(o.kLang, true, '★ language 必须进键');
  assert.equal(o.kPlat, true, '★ platforms 必须进键');
  assert.equal(o.emptyCalls, 2, '★ 空结果不得缓存');
  assert.equal(o.emptyCached, false);
  assert.equal(o.offCalls, 2, '★ MCPS_SERVE_CACHE=0 时不得走缓存');

  const m = r.mutants['no-early-return'];
  assert.equal(m.cached2, false, '★ 变异后第二次仍命中 ⇒ 早退没被真正测到');
});
