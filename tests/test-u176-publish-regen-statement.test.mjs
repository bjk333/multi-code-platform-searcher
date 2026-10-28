// U-176：发布即"声明发货集合" ⇒ publish 末尾必须**自动重生成** in-toto Statement
//   背景（2026-10-19 两次实测）：改了清单内文件 → publish 只更新哈希 → Statement 陈旧 ⇒ U-158 A 假红，
//   需要人工想起来跑 `U158_REGEN=1`。这是**流程税**，不是产品缺陷 ⇒ 由发布器收口。
//
//   本条门的 5 个契约（都不联网、不跑 publish）：
//     ① 块存在且会打印成功信息      ② 只在真实发布执行（-WhatIf 不得写盘）
//     ③ **不得让发布失败**（无 throw/exit）——发布的职责是复制，不是跑门
//     ④ 必须恢复/清除 U158_REGEN    ⑤ 不得自引用（statement 目录不在清单里）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = fs.readFileSync(path.join(ROOT, 'scripts', 'publish-skill.ps1'), 'utf8');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'reports', '_skill-assets.root.json'), 'utf8').replace(/^\uFEFF/, ''));

// 截出 U-176 块（注释头 → 发布完成汇总之前）
const START = '# ---- U-176';
const END = 'Write-Host "发布完成';
const i0 = PUB.indexOf(START);
const i1 = PUB.indexOf(END);
const BLOCK = i0 >= 0 && i1 > i0 ? PUB.slice(i0, i1) : '';

test('U-176-1: publish 末尾存在 Statement 重生成块，且会报告结果', () => {
  assert.ok(BLOCK, '必须存在 # ---- U-176 块（到「发布完成」汇总之前）');
  assert.match(BLOCK, /U158_REGEN/, '必须设置 U158_REGEN');
  assert.match(BLOCK, /in-toto Statement 已按当前工作树重生成/, '成功时必须打印可核对的提示');
  assert.match(BLOCK, /test-u158-provenance\.test\.mjs/, '必须调用既有 provenance 测试（不复制一套生成逻辑）');
});

test('U-176-2: 只在真实发布执行（-WhatIf 不得写盘）', () => {
  assert.match(BLOCK, /if \(-not \$WhatIf\)/, '整块必须被 -not $WhatIf 守卫');
});

test('U-176-3: 不得让发布失败（块内无 throw / exit）', () => {
  const code = BLOCK.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.doesNotMatch(code, /\bthrow\b/, '★ 块内不得 throw —— Statement 失败不应阻断发布（职责是复制，不是跑门）');
  assert.doesNotMatch(code, /\bexit\b/, '★ 块内不得 exit —— 同上');
  assert.match(code, /Write-Warning/, '失败路径必须是告警而非中断');
});

test('U-176-4: 必须恢复或清除 U158_REGEN（不得污染后续进程）', () => {
  assert.match(BLOCK, /Remove-Item Env:\\U158_REGEN/, '必须清除 U158_REGEN');
  assert.match(BLOCK, /\$prevRegen/, '必须保存并在需要时恢复原值（而不是无条件删除）');
});

test('U-176-5: 不得自引用（statement 目录不在清单 fileHashes 内）', () => {
  const keys = Object.keys(MANIFEST.assets[0].fileHashes || {});
  const hit = keys.filter((k) => k.startsWith('reports/provenance'));
  assert.deepEqual(hit, [], `★ reports/provenance 不得入库（否则哈希与 Statement 互相引用、永远无法收敛），实际: ${hit.join(',')}`);
});

test('U-176-6: native stderr 不得被 Stop 当成终止错误（否则重生成静默失效）', () => {
  // v1.53.3 实测：本脚本开头 $ErrorActionPreference='Stop'，而 native 命令的 stderr 经 `2>&1`
  //   会变成 ErrorRecord ⇒ 第一行 stderr 即抛终止错误。node 每次启动都打 `[UNDICI-EHPA] Warning`，
  //   于是这段重生成**从未成功过**——症状是 publish 报「Statement 重生成失败」，而告警里贴的
  //   "最后 4 行"是 node 的 warning 文本，不是断言差异。⇒ 调 node 前必须临时放开 EAP、finally 恢复。
  assert.match(BLOCK, /\$ErrorActionPreference\s*=\s*'Continue'/, '★ 调 node 前必须把 EAP 临时设为 Continue');
  const iContinue = BLOCK.indexOf("$ErrorActionPreference = 'Continue'");
  const iNode = BLOCK.indexOf('& node');
  assert.ok(iContinue > 0 && iNode > iContinue, 'EAP 放开必须位于 node 调用之前（否则不生效）');
  assert.match(BLOCK, /\$ErrorActionPreference\s*=\s*\$prevEap/, '必须在 finally 里恢复原 EAP（不得污染后续发布步骤）');
  const iRestore = BLOCK.indexOf('$ErrorActionPreference = $prevEap');
  assert.ok(iRestore > iNode, '恢复必须位于 node 调用之后');
});
