// U-190（2026-10-20，v1.46.3）：`-Package` 精确包元数据（deps.dev）—— 契约 + 行为 + 引擎内变异自证。
//
// 依据：reports/升级空间调研-2026-10-20.md 的负清单「deps.dev 不能做关键词搜索」，以及
//   reports/v1.46.1-上游少命中可见-2026-10-20.md §六「正确形态是 -Package <system:name> 精确入口」。
// 为什么要有门：
//   ① `@types/node` 不编码必 404（实测）—— 编码这件事只能靠门钉住，靠人记不住；
//   ② PS 7 的 ConvertFrom-Json 会把 ISO 串自动转成 [datetime]，直接 [string] 会输出本地化格式（跨运行时不可比）；
//   ③ 「包不存在（404）」必须是 empty（执行过、零命中），不能是 error（那是"没查成"）—— 否则 verdict/退出码全错。
//
// 门结构：A 源码契约；B 行为（桩 Invoke-ApiRequest）+ 引擎内变异（改坏默认版本选择 / 去掉编码 ⇒ 读数必须变）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { probeWithMutants, rootDir } from './r94-ps-probe.mjs';

const read = (p) => fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
const ENGINE_PATH = path.join(rootDir, 'engines', 'deps-dev.ps1');
const ENGINE = read(ENGINE_PATH);
const MAIN = read(path.join(rootDir, 'multi-platform-searcher.ps1'));
const stripComments = (src) => src.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');
const ENGINE_CODE = stripComments(ENGINE);

test('U-190 A: -Package 走独立模式，且不需要 -Keyword（两处守卫都必须豁免）', () => {
  assert.match(MAIN, /\[string\]\$Package = ''/, '缺少 -Package 参数');
  assert.match(MAIN, /\$runModes = @\('package'\)/, '未把 -Package 接成独立模式');
  assert.match(MAIN, /if \(\$runModes -contains 'package'\) \{\s*\r?\n\s*# v1\.46\.3：非注册表源/, 'coverage.Requested 未登记 DepsDev');
  // 两处"空 Keyword"守卫：U-142（AsJson 早失败）与用法横幅分支。漏掉任一处 ⇒ -Package -AsJson 静默 0 字节。
  const guardHits = MAIN.match(/IsNullOrWhiteSpace\(\$Package\)/g) || [];
  assert.ok(guardHits.length >= 2, '★ 两处空关键词守卫都必须豁免 -Package（漏一处就静默退出、0 字节 stdout）: 命中 ' + guardHits.length);

  // 包名必须编码：npm 作用域包 `@types/node` 不编码实测 404
  assert.match(ENGINE_CODE, /\[uri\]::EscapeDataString\(\$pkgName\)/, '★ 包名必须 EscapeDataString（@types/node 不编码 404）');
  // 日期跨运行时归一（PS7 自动转 DateTime）
  assert.match(ENGINE_CODE, /ToUniversalTime\(\)\.ToString\('yyyy-MM-ddTHH:mm:ssZ'\)/, '★ 日期必须归一成 ISO（PS7 的 ConvertFrom-Json 会转 DateTime）');
  // 不做关键词搜索（deps.dev 无该端点）
  assert.doesNotMatch(ENGINE_CODE, /v3alpha\/search/, 'deps.dev 没有关键词检索端点（/v3alpha/search 实测 404）');
});

test('U-190 B/C: 默认版本/许可证/公告/404 语义（含引擎内变异自证）', async () => {
  const probe = `
$ErrorActionPreference = 'Stop'
$out = [ordered]@{}
$global:__uris = @()
$global:__mode = 'ok'

function global:Invoke-ApiRequest {
  param($Uri, $Headers, $TimeoutSec, $Method, $Body, $MaxAttempts, [switch]$NoProxy, $DeadlineSec, $NodeDeadlineSec)
  $global:__uris += [string]$Uri
  if ($global:__mode -eq 'notfound') { throw 'package not found' }
  if ([string]$Uri -match '/versions/') { return [PSCustomObject]@{ Content = $global:__detail; StatusCode = 200; Headers = @{} } }
  return [PSCustomObject]@{ Content = $global:__pkg; StatusCode = 200; Headers = @{} }
}

$global:__pkg = '{"packageKey":{"system":"NPM","name":"express"},"purl":"pkg:npm/express","versions":[{"versionKey":{"system":"NPM","name":"express","version":"0.14.0"},"publishedAt":"2010-12-29T19:38:25Z","isDefault":false,"isDeprecated":true,"deprecatedReason":"0.x series"},{"versionKey":{"system":"NPM","name":"express","version":"5.3.0"},"publishedAt":"2026-10-09T12:56:54Z","isDefault":true,"isDeprecated":false}]}'
$global:__detail = '{"versionKey":{"system":"NPM","name":"express","version":"5.3.0"},"publishedAt":"2026-10-09T12:56:54Z","isDefault":true,"isDeprecated":false,"licenses":["MIT"],"licenseDetails":[{"license":"MIT","spdx":"MIT"}],"advisoryKeys":[{"id":"GHSA-aaaa-bbbb-cccc"},{"id":"GHSA-dddd-eeee-ffff"}],"links":[{"label":"HOMEPAGE","url":"https://expressjs.com"}]}'

$r = @(Search-DepsDevPackage -PackageSpec 'npm:express')
$out.name = [string]$r[0].Name
$out.lic = [string]$r[0].License
$out.updated = [string]$r[0].Updated
$out.desc = [string]$r[0].Desc
$out.url = [string]$r[0].Url
$out.status = [string](Get-EngineStatus -Name 'DepsDev')
$out.warn = (@(Get-EngineWarnings) -join ' | ')
$out.uris = ($global:__uris -join '|')

# 作用域包：必须编码成 %40types%2Fnode（不编码实测 404）
$global:__uris = @()
$null = @(Search-DepsDevPackage -PackageSpec 'npm:@types/node')
$out.scopedUri = ($global:__uris -join '|')

# 无 isDefault ⇒ 退化为列表末项 + 告警（不得静默）
$global:__pkg = '{"versions":[{"versionKey":{"version":"1.0.0"},"publishedAt":"2020-01-01T00:00:00Z","isDefault":false},{"versionKey":{"version":"2.0.0"},"publishedAt":"2021-01-01T00:00:00Z","isDefault":false}]}'
$global:__detail = '{"licenses":[],"licenseDetails":[{"license":"Apache-2.0"}],"advisoryKeys":[],"links":[]}'
$r2 = @(Search-DepsDevPackage -PackageSpec 'npm:nodflt')
$out.noDefaultVer = [string]$r2[0].Version
$out.noDefaultName = [string]$r2[0].Name
$out.noDefaultLic = [string]$r2[0].License
$out.noDefaultWarn = (@(Get-EngineWarnings) -join ' | ')

# 404 ⇒ empty（执行过、零命中）；不能记 error
$global:__mode = 'notfound'
$r3 = @(Search-DepsDevPackage -PackageSpec 'npm:zzz-none')
$out.nfCount = @($r3).Count
$out.nfStatus = [string](Get-EngineStatus -Name 'DepsDev')
$out.nfReason = [string]$script:_engineStatusReason['DepsDev']

# 未知生态 ⇒ error（用法错，不是"没找到"）
$global:__mode = 'ok'
$null = @(Search-DepsDevPackage -PackageSpec 'maven2:foo')
$out.badSysStatus = [string](Get-EngineStatus -Name 'DepsDev')
$out.badSysReason = [string]$script:_engineStatusReason['DepsDev']

# ---- 变异①：默认版本选择退回"取第一条"（旧写法）⇒ 版本应变成 0.14.0 ----
$eng = [System.IO.File]::ReadAllText('__ENG_PATH__').TrimStart([char]0xFEFF)
$mut1 = $eng.Replace('$pick = @($vers | Where-Object { $_.isDefault } | Select-Object -First 1)', '$pick = @($vers | Select-Object -First 1)')
if ($mut1 -eq $eng) { throw 'mutation1 anchor missing' }
Invoke-Expression $mut1
$global:__mode = 'ok'
$global:__pkg = '{"versions":[{"versionKey":{"version":"0.14.0"},"publishedAt":"2010-12-29T19:38:25Z","isDefault":false},{"versionKey":{"version":"5.3.0"},"publishedAt":"2026-10-09T12:56:54Z","isDefault":true}]}'
$global:__detail = '{"licenses":["MIT"],"advisoryKeys":[],"links":[]}'
$r4 = @(Search-DepsDevPackage -PackageSpec 'npm:express')
$out.mutVer = [string]$r4[0].Url
Invoke-Expression $eng

# ---- 变异②：去掉包名编码 ⇒ URI 里不应再有 %40/%2F ----
$oldU = @'
'https://api.deps.dev/v3alpha/systems/{0}/packages/{1}' -f $sys, [uri]::EscapeDataString($pkgName)
'@
$newU = @'
'https://api.deps.dev/v3alpha/systems/{0}/packages/{1}' -f $sys, $pkgName
'@
$mut2 = $eng.Replace($oldU.Trim(), $newU.Trim())
if ($mut2 -eq $eng) { throw 'mutation2 anchor missing' }
Invoke-Expression $mut2
$global:__uris = @()
$null = @(Search-DepsDevPackage -PackageSpec 'npm:@types/node')
$out.mutScopedUri = ($global:__uris -join '|')
Invoke-Expression $eng

$out
`.replace('__ENG_PATH__', ENGINE_PATH.replace(/\\/g, '\\\\'));

  const r = await probeWithMutants(probe, [], { timeoutMs: 180000 });
  const o = r.real;

  // 默认版本 = isDefault（不是第一条、也不是最后一条）
  assert.equal(o.name, 'npm/express');
  assert.equal(o.lic, 'MIT', '★ 许可证必须从版本详情取（licenses）');
  assert.equal(o.updated, '2026-10-09T12:56:54Z', '★ 日期必须是 ISO（跨运行时一致）');
  assert.match(o.desc, /default 5\.3\.0/, '★ 必须取 isDefault 的那个版本');
  assert.match(o.desc, /2 个版本/, 'Desc 必须带版本总数');
  assert.match(o.desc, /2 条安全公告/, 'Desc 必须带公告数');
  assert.equal(o.status, 'ok');
  assert.equal(o.url, 'https://deps.dev/npm/express/5.3.0', 'Url 必须是版本级 deps.dev 链接');
  assert.match(o.warn, /GHSA-aaaa-bbbb-cccc/, '★ 安全公告必须进 warnings（少报比漏报更糟）');
  assert.match(o.warn, /未做可利用性判定/, '公告只是存在性，不得暗示已判定可利用');

  // 作用域包必须编码
  assert.match(o.scopedUri, /%40types%2Fnode/, '★ npm 作用域包必须编码（实测不编码 404）');

  // 无 isDefault：退化为末项 + 显式告警
  assert.match(o.noDefaultWarn, /没有 isDefault/, '★ 退化必须告警（不得静默换版本）');
  assert.match(o.noDefaultWarn, /2\.0\.0/, '退化选的是列表末项');
  assert.equal(o.noDefaultLic, 'Apache-2.0', 'licenses 为空时必须回落到 licenseDetails');

  // 404 ⇒ empty
  assert.equal(o.nfCount, 0);
  assert.equal(o.nfStatus, 'empty', '★ 404 是「执行过且没有」，必须 empty（记 error 会让 verdict=none/退出码 4）');
  assert.match(o.nfReason, /包不存在/);

  // 未知生态 ⇒ error
  assert.equal(o.badSysStatus, 'error', '未知生态是用法错，必须 error');
  assert.match(o.badSysReason, /不支持的生态/);

  // 变异①：取第一条 ⇒ 版本变成 0.14.0
  assert.match(o.mutVer, /0\.14\.0/, '★ 变异后仍取到 5.3.0 ⇒ B 臂没测到默认版本逻辑');
  // 变异②：不编码 ⇒ URI 里没有 %40
  assert.doesNotMatch(o.mutScopedUri, /%40/, '★ 变异后仍编码 ⇒ 编码断言没测到真逻辑');
});
