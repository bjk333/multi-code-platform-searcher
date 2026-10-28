// U-203（2026-10-21，v1.46.7）：陈旧缓存兜底返回的是**条目包装体**，不是结果数组。
//
// 事实（实网验证 v1.46.7 时撞到）：磁盘缓存条目形如 `{expires, data:[...]}`；旧写法
//   `if ($disk -and $disk.ContainsKey($Key)) { return $disk[$Key] }` 让 Get-GitHubStaleFallback 拿到 1 个
//   只有 expires/data 两个属性的对象 —— 下游 `Where-Object { ... -contains 'Name' }` 把它扔掉，
//   于是载荷 0 条，却写着 "已回退陈旧缓存" + 引擎状态 ok ⇒ `coverage.Verdict=full`。
//   这是一次"不是零命中却报成零命中"的假阴性；更糟的是误命中会把这个包装体再写回缓存（实测已套娃 3 层）。
//
// 口径：拆到 data；对历史套娃按"里面有 data 且自己没有 Name"下钻（≤8 层）；只返回带 Name 的结果；否则 $null。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { probeWithMutants, MAIN, PRODUCT_SRC } from './r94-ps-probe.mjs';

const MAIN_SRC = PRODUCT_SRC().replace(/^\uFEFF/, '');

test('U-203 A: 静态 —— 不得直接返回磁盘条目包装体', () => {
  const at = MAIN_SRC.indexOf('function Get-StaleCacheResult');
  assert.ok(at > 0, 'Get-StaleCacheResult 不存在');
  const body = MAIN_SRC.slice(at, at + 2200);
  assert.doesNotMatch(body, /if \(\$disk -and \$disk\.ContainsKey\(\$Key\)\) \{ return \$disk\[\$Key\] \}/, '★ 仍在直接返回包装体（就是这条 bug）');
  assert.match(body, /\$data = \$disk\[\$Key\]/, '必须先取条目再拆 data');
  assert.match(body, /\$props -contains 'data'/, '★ 历史套娃必须能下钻（否则旧缓存仍会漏包装体）');
  assert.match(body, /\$props -contains 'Name'/, '必须用 Name 判断"已经是结果"');
  assert.match(body, /if \(\$arr\.Count -eq 0\) \{ return \$null \}/, '★ 没有有效结果时必须回 $null（不能把空数组当"有陈旧缓存"）');
});

test('U-203 B: 行为 —— 正常条目/套娃/非结果对象/空 data/缺键（变异：退回直接返回包装体必须红）', async () => {
  const probe = `
$ErrorActionPreference = 'Stop'
function global:Get-Cache {
  return @{
    'k1' = [pscustomobject]@{ expires = '2026-10-21T00:00:00Z'; data = @([pscustomobject]@{ Name = 'a/b'; Platform = 'GitHub' }) }
    'k2' = [pscustomobject]@{ expires = 'x'; data = [pscustomobject]@{ expires = 'y'; data = @([pscustomobject]@{ Name = 'c/d'; Platform = 'GitHub' }) } }
    'k3' = 'GitHub 找到 12 个结果（显示前 5）'
    'k4' = [pscustomobject]@{ expires = 'x'; data = @() }
    'k5' = [pscustomobject]@{ expires = 'x'; data = @('状态字符串', [pscustomobject]@{ Name = 'e/f' }) }
  }
}
# ★不能写 @(Get-StaleCacheResult ...).Count —— 本仓已有教训：@($null).Count == 1（$null 被当成一个元素），
#   会让"返回 $null"看起来像"返回 1 条"。必须先判 $null。
function __Cnt($v) { if ($null -eq $v) { return 0 } return @($v).Count }
function __Name($v) { if ($null -eq $v) { return $null } return @($v)[0].Name }
$out = [ordered]@{}
$r1 = Get-StaleCacheResult -Key 'k1'
$out.k1n = __Cnt $r1
$out.k1name = __Name $r1
$out.k2n = __Cnt (Get-StaleCacheResult -Key 'k2')
$out.k2name = __Name (Get-StaleCacheResult -Key 'k2')
$out.k3 = __Cnt (Get-StaleCacheResult -Key 'k3')
$out.k4 = __Cnt (Get-StaleCacheResult -Key 'k4')
$out.k5n = __Cnt (Get-StaleCacheResult -Key 'k5')
$out.k5name = __Name (Get-StaleCacheResult -Key 'k5')
$out.kx = __Cnt (Get-StaleCacheResult -Key 'nope')
$out
`;
  const r = await probeWithMutants(probe, [
    { name: 'return-wrapper', fn: 'Get-StaleCacheResult', find: '$data = $disk[$Key]', replace: 'return $disk[$Key]' },
    { name: 'no-name-guard', fn: 'Get-StaleCacheResult', find: "$arr = @($data | Where-Object { $_ -and ($_.PSObject.Properties.Name -contains 'Name') })", replace: '$arr = @($data)' },
  ], { timeoutMs: 180000 });

  const o = r.real;
  assert.equal(o.k1n, 1);
  assert.equal(o.k1name, 'a/b', '★ 正常条目必须拆出 data 并保留结果字段');
  assert.equal(o.k2n, 1);
  assert.equal(o.k2name, 'c/d', '★ 历史套娃必须下钻到真结果');
  assert.equal(o.k3, 0, '★ 状态字符串不是陈旧结果');
  assert.equal(o.k4, 0, '★ 空 data 不算"有陈旧缓存"');
  assert.equal(o.k5n, 1, '混合载荷只保留带 Name 的条目');
  assert.equal(o.k5name, 'e/f');
  assert.equal(o.kx, 0);

  assert.ok(r.mutants['return-wrapper'].k1name == null, '★ 变异后仍能拿到结果名 ⇒ 这道门测不到包装体 bug');
  assert.equal(r.mutants['return-wrapper'].k3, 1, '★ 变异后状态字符串会被当成陈旧结果');
  assert.equal(r.mutants['no-name-guard'].k5n, 2, '★ 去掉 Name 守卫后非结果对象会被放行');
});
