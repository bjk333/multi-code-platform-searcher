// U-199（2026-10-21，v1.46.5）：新增 Packagist（PHP/Composer）研究源。
//
// 依据（调研当日实测）：`GET https://packagist.org/search.json?q=redis&per_page=15` = 200 / 0.74s / 15 条（total 6453），
//   免 key；同期候选 DBLP(202 Anubis) / PapersWithCode(302) / Bitbucket(404) / Debian(HTML) / grep.ai(401) 全出局。
//
// 口径：注册表新增 `Packagist` 引擎（Kind=research）；结果 Platform='Packagist'、Stars=downloads；
//   `abandoned` 必须透出（直接决定能不能用）；total>本次条数要告警（少命中可见）；
//   429 记 rate_limited（不是 error），其余失败 error；成功 0 条才是 empty。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { probeWithMutants, MAIN, rootDir, PRODUCT_SRC } from './r94-ps-probe.mjs';

const MAIN_SRC = PRODUCT_SRC().replace(/^\uFEFF/, '');
const ENGINE = path.join(rootDir, 'engines', 'packagist.ps1');

test('U-199 A: 源码契约 —— 注册表/引擎/Doctor 探针三处齐', () => {
  assert.ok(fs.existsSync(ENGINE), 'engines/packagist.ps1 必须存在');
  const src = fs.readFileSync(ENGINE, 'utf8');
  assert.match(src, /function Search-Packagist/, '引擎函数名必须是 Search-Packagist（注册表按名调用）');
  assert.match(src, /packagist\.org\/search\.json/, '必须打实测过的 search.json 端点');
  assert.match(src, /\[abandoned\]/, '★ abandoned 必须透出');
  assert.match(MAIN_SRC, /Name = 'Packagist';[\s\S]{0,160}Kind = 'research'[\s\S]{0,160}Func = 'Search-Packagist'/, '★ 注册表必须登记 Packagist');
  assert.match(MAIN_SRC, /Source = 'Packagist';[\s\S]{0,200}Engine = 'Packagist'/, 'Doctor 必须有同源探针');
});

test('U-199 B: 正常/截断/abandoned/429 四路（变异：去掉 abandoned 标记 ⇒ 红）', async () => {
  const probe = `
$ErrorActionPreference = 'Stop'
$global:__payload = '{"results":[{"name":"predis/predis","description":"A flexible PHP client","url":"https://packagist.org/packages/predis/predis","downloads":123456,"favers":9000,"abandoned":false},{"name":"old/pkg","description":"legacy","url":"https://packagist.org/packages/old/pkg","downloads":10,"favers":1,"abandoned":true}],"total":6453}'
function global:Invoke-ApiRequest { param($Uri, $Headers, $TimeoutSec, $MaxAttempts, $Method, $Body) [pscustomobject]@{ Content = $global:__payload; StatusCode = 200 } }
$out = [ordered]@{}
$r = @(Search-Packagist -Keyword 'redis' -Limit 2)
$out.count = $r.Count
$out.first = $r[0]
$out.second = $r[1]
$out.status = Get-EngineStatus -Name 'Packagist'
$out.warnings = @($script:_engineWarnings.ToArray())
# 429 分档
function global:Invoke-ApiRequest { param($Uri, $Headers, $TimeoutSec, $MaxAttempts, $Method, $Body) throw 'HTTP 429 Too Many Requests (packagist)' }
$out.rl = @(Search-Packagist -Keyword 'x' -Limit 1).Count
$out.rlStatus = Get-EngineStatus -Name 'Packagist'
# ---- 引擎内变异：去掉 abandoned 标记 ⇒ 弃用包必须失去标记（证明门测的是真逻辑）----
$eng = [System.IO.File]::ReadAllText('__ENG_PATH__').TrimStart([char]0xFEFF)
$anchor = 'if ($p.abandoned) { $desc = "[abandoned] " + $desc }'
$mut = $eng.Replace($anchor, 'if ($false) { $desc = "[abandoned] " + $desc }')
if ($mut -eq $eng) { throw 'mutation anchor missing' }
Invoke-Expression $mut
function global:Invoke-ApiRequest { param($Uri, $Headers, $TimeoutSec, $MaxAttempts, $Method, $Body) [pscustomobject]@{ Content = $global:__payload; StatusCode = 200 } }
$mr = @(Search-Packagist -Keyword 'redis' -Limit 2)
$out.mutDesc = [string]$mr[1].Desc
Invoke-Expression $eng
$out
`.replace('__ENG_PATH__', ENGINE.replace(/\\/g, '\\\\'));

  const r = await probeWithMutants(probe, [], { timeoutMs: 180000 });
  const o = r.real;

  assert.equal(o.count, 2);
  assert.equal(o.first.Platform, 'Packagist');
  assert.equal(o.first.Name, 'predis/predis');
  assert.equal(o.first.Stars, 123456, 'downloads ⇒ Stars');
  assert.equal(o.first.Unit, 'downloads');
  assert.equal(o.status, 'ok');
  assert.ok(o.warnings.some(w => w.includes('total=6453')), '★ 截断必须告警（少命中可见）');
  assert.match(o.second.Desc, /\[abandoned\]/, '★ 弃用包必须带标记');
  assert.equal(o.rl, 0);
  assert.equal(o.rlStatus, 'rate_limited', '429 记 rate_limited，不是 error');
  assert.doesNotMatch(o.mutDesc, /\[abandoned\]/, '★ 变异后仍有标记 ⇒ 这道门测不到 abandoned 分支');
});
