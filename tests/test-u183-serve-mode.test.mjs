// U-183（2026-10-19）：`-Serve` 常驻模式的四条硬契约
//
// 为什么要有这个门：本轮实现时**踩了两个顺序坑**，两个都表现为"看起来跑了，其实没进服务模式"——
//   ① 静音块放在 serve 循环里（L4116），而 L382 的「已加载令牌」提示走 if (-not $AsJson) ⇒ 先打了一行 GBK 中文到 stdout
//      ⇒ 协议流首行不是 JSON ⇒ 调用方 parse 失败。
//   ② 空关键词守卫（L4063）没排除 -Serve ⇒ serve 模式被 throw，调用方看到"缺 Keyword"。
// 这两条都是**静态可检查的**，锁进来源码级门比留报告更可靠。
//
// 实测（reports/gates/p1-serve-2026-10-19/README.md）：
//   首行 1020ms · 预热后 7.4/8.8s（CLI 21.2s ⇒ 2.6×）· 51 条/10 源 · 中文与错误路径均正常

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceAll } from './lib/source.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const MAIN = sourceAll(path.join(ROOT)).replace(/^\uFEFF/, '');
const REPORT = path.join(ROOT, 'reports', 'gates', 'p1-serve-2026-10-19', 'README.md');
const DOC = fs.readFileSync(path.join(ROOT, 'references', '参数速查.md'), 'utf8');

const lines = MAIN.split(/\r?\n/);
const code = lines.filter((l) => !/^\s*#/.test(l)).join('\n');

test('U-183 A: -Serve 参数存在，且是 switch', () => {
  assert.match(code, /\[switch\]\$Serve/, '必须有 [switch]$Serve');
});

test('U-183 B: ★ 静音必须在**任何输出之前**（本轮踩坑①）', () => {
  const muteIdx = MAIN.indexOf('if ($Serve) { $AsJson = $true');
  assert.ok(muteIdx > 0, '必须有 `if ($Serve) { $AsJson = $true ... }` 前置块');

  // 该块必须早于首个可能输出的语句
  const firstOut = MAIN.indexOf('Write-ColorOutput "已加载 GitHub 令牌');
  assert.ok(firstOut > 0, '应能找到首个输出语句作为参照');
  assert.ok(muteIdx < firstOut,
    '★ 静音块必须早于首个 Write-ColorOutput（实测：晚于它 ⇒ 协议流被 GBK 中文污染，调用方 parse 失败）');

  // 必须设 UTF-8（Windows 控制台默认 GBK）
  assert.match(MAIN.slice(muteIdx, muteIdx + 500), /\[Console\]::OutputEncoding = \[System\.Text\.Encoding\]::UTF8/,
    '★ 静音块必须同时设 UTF-8，否则中文结果往返即乱码');
});

test('U-183 C: ★ 空关键词守卫必须排除 -Serve（本轮踩坑②）', () => {
  assert.match(code, /if \(\$AsJson -and \[string\]::IsNullOrWhiteSpace\(\$Keyword\) -and\n\s*-not \$Serve -and -not \$Doctor/,
    '★ 守卫必须含 `-not $Serve`（实测：漏了它 ⇒ serve 被 throw「缺 Keyword」，服务根本起不来）');
});

test('U-183 D: 协议契约 —— 单行请求/单行响应、__EXIT__ 退出、异常也回 JSON', () => {
  // 读一行 / 写一行
  assert.match(code, /\[Console\]::In\.ReadLine\(\)/, '必须逐行读 stdin');
  assert.match(code, /\[Console\]::Out\.WriteLine\(\(\$Obj \| ConvertTo-Json -Depth 6 -Compress\)\)/, '响应必须 -Compress 单行');
  assert.match(code, /\[Console\]::Out\.Flush\(\)/, '必须 Flush（否则调用方永久等待）');
  // 退出
  assert.match(code, /\$line -eq '__EXIT__'/, '必须支持 __EXIT__ 退出');
  // 异常必须回一行 JSON，不得让调用方等空
  // 注：切片用 **lastIndexOf('if ($Serve) {')** —— 文件里有两处该串（L132 静音块 + serve 循环），
  //     且 `exit 0` 在 serve 块之前也出现过 ⇒ 首版用 indexOf('exit 0') 切出了空串（门自己写错，非实现问题）。
  const serveBlockStart = code.lastIndexOf('if ($Serve) {');
  assert.ok(serveBlockStart > 0, '必须能定位 serve 循环块');
  const block = code.slice(serveBlockStart);
  assert.match(block, /catch \{[\s\S]{0,300}Write-ServeLine/, '★ catch 内必须仍写一行响应（否则调用方会永久等一行永不出现的响应）');
});

test('U-183 E: 文档与证据齐备', () => {
  assert.match(DOC, /-Serve/, '参数速查必须登记 -Serve');
  assert.ok(fs.existsSync(REPORT), '证据报告必须存在：' + REPORT);
  const r = fs.readFileSync(REPORT, 'utf8');
  assert.match(r, /1020|1,020|1\.0\s*s/, '必须记录首行往返（含 parse）');
  assert.match(r, /2\.6×|2\.6x/, '必须记录相对 CLI 的提速倍数');
  assert.match(r, /51/, '必须记录预热后的条数（证明不是"快但少"）');
});
