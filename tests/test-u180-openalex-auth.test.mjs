// U-180（2026-10-19）：OpenAlex 凭据优先级与文案准确性
//
// 背景（有实测证据，见 reports/gates/p01-openalex-mailto-2026-10-19/README.md）：
//   OpenAlex 已改为**按网络 IP 共享免费额度**，用尽即 429（Retry-After ≈ 12h，UTC 午夜重置）。
//   `mailto`（旧 polite pool）**实测已不生效** —— 带与不带同为 429。
//   **免费 API key 自带独立预算**，是唯一有效修法。
//
// 本门锁三条真契约：
//   A. key 必须**优先于** mailto；两者皆空 ⇒ **不加任何参数**（零行为变更）
//   B. reason 必须写出准确事实（IP 共享 / API key / UTC 重置）
//   C. reason **不得**再声称「加 mailto 可提升配额」（过时政策，会误导用户白折腾）
//
// 为什么是源码级门：真实 429/401 依赖网络与 IP 状态，不可离线复现；
//   但「凭据优先级」与「文案是否与实测一致」是纯静态契约，锁它能防回归。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ENGINE = path.join(ROOT, 'engines', 'open-alex.ps1');
const DOC = path.join(ROOT, 'references', '参数速查.md');
const REPORT = path.join(ROOT, 'reports', 'gates', 'p01-openalex-mailto-2026-10-19', 'README.md');

const raw = fs.readFileSync(ENGINE, 'utf8').replace(/^\uFEFF/, '');
// 剔除注释行后再做「不得出现」类断言（U-178 教训：注释里引用旧写法会被误伤）
const code = raw.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');

test('U-180 A: api_key 优先于 mailto，且两者皆空时不加任何参数', () => {
  // 必须同时读取两个环境变量
  assert.match(code, /\[string\]\$env:MCPS_OPENALEX_API_KEY/, '必须读取 MCPS_OPENALEX_API_KEY');
  assert.match(code, /\[string\]\$env:MCPS_OPENALEX_MAILTO/, '必须保留 MCPS_OPENALEX_MAILTO（旧机制兼容）');

  // 分支必须是 `if ($oaKey) {...} elseif ($oaMail) {...}` —— key 在前
  const keyIdx = code.indexOf('if ($oaKey)');
  const mailIdx = code.indexOf('elseif ($oaMail)');
  assert.ok(keyIdx > 0, '必须有 `if ($oaKey)` 分支');
  assert.ok(mailIdx > keyIdx, 'mailto 必须是 elseif（key 优先）');

  // 追加到 uri，而不是覆盖
  assert.match(code, /\$uri \+= "`&api_key=" \+ \[uri\]::EscapeDataString\(\$oaKey\)/, 'api_key 必须**追加**到 uri 并转义');
  assert.match(code, /\$uri \+= "`&mailto=" \+ \[uri\]::EscapeDataString\(\$oaMail\)/, 'mailto 必须**追加**到 uri 并转义');

  // 零行为变更：两处追加**必须各自被 if/elseif 的 {} 守卫**（实现压在同一行，故按行内结构断言）
  // 注：首版这里先用「下一行是否含 if」的 lookahead ⇒ 误判「同一行前置 if」的正确写法（门写错，非实现问题）。
  const addLines = code.split(/\r?\n/).filter((l) => /\$uri \+= "`&(api_key|mailto)=/.test(l));
  assert.equal(addLines.length, 1, '两处追加应在同一行（压缩写法，避免撑大函数体）');
  const line = addLines[0];
  assert.match(line, /if \(\$oaKey\) \{ \$uri \+= "`&api_key=" \+ \[uri\]::EscapeDataString\(\$oaKey\) \}/, '★ api_key 追加必须在 `if ($oaKey) { }` 内（两者皆空时不得追加）');
  assert.match(line, /elseif \(\$oaMail\) \{ \$uri \+= "`&mailto=" \+ \[uri\]::EscapeDataString\(\$oaMail\) \}/, '★ mailto 追加必须在 `elseif ($oaMail) { }` 内');
});

test('U-180 B: reason 必须写出实测事实（IP 共享 / API key / UTC 重置）', () => {
  assert.match(raw, /按【网络 IP 共享】|按「网络 IP」共享|网络 IP.*共享/, 'reason 必须说明「按网络 IP 共享」—— 这是 429 的真实原因');
  assert.match(raw, /MCPS_OPENALEX_API_KEY/, 'reason 必须指向已实现的环境变量');
  assert.match(raw, /UTC 午夜重置/, 'reason 必须给出重置时间（用户据此判断要不要等）');
  assert.match(raw, /help\.openalex\.org\/api\/auth/, 'reason 必须给出申请地址（可操作）');
});

test('U-180 C: ★ reason 不得再声称「加 mailto 可提升配额」（过时政策）', () => {
  // 旧文案：「或为请求加上 OpenAlex 要求的 mailto 联络参数/API key 以提升配额」
  assert.ok(
    !/加上 OpenAlex 要求的 mailto/.test(code),
    '★ 不得再建议「加上 mailto 提升配额」—— 实测带与不带同为 429，该建议会误导用户白折腾',
  );
  // 必须显式声明 mailto 已不生效（避免下一个人「顺手修回去」）
  assert.match(raw, /mailto 已不生效|mailto.*已不生效/, '必须显式写明 mailto 已不生效及其实测依据');
});

test('U-180 D: 文档必须登记两个旋钮（U-55 联动）', () => {
  const doc = fs.readFileSync(DOC, 'utf8');
  assert.match(doc, /\| `MCPS_OPENALEX_API_KEY` \|/, '环境旋钮表必须有 MCPS_OPENALEX_API_KEY');
  assert.match(doc, /\| `MCPS_OPENALEX_MAILTO` \|/, '环境旋钮表必须有 MCPS_OPENALEX_MAILTO（并注明已不生效）');
  assert.match(doc, /已不生效/, 'mailto 行必须注明实测已不生效');
});

test('U-180 E: 证据报告必须留下三向实测（含 401 决定性证据）', () => {
  assert.ok(fs.existsSync(REPORT), '证据报告必须存在：' + REPORT);
  const r = fs.readFileSync(REPORT, 'utf8');
  assert.match(r, /401/, '★ 必须记录「假 key ⇒ 401」这一决定性证据（证明参数真的传到了服务器）');
  assert.match(r, /429/, '必须记录默认路径的 429 读数');
  assert.match(r, /mailto/i, '必须记录 mailto 的对照结果');
});
