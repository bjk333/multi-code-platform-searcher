// R4-F1-d · 代码证据通道「自曝」门
//
// 由来（R4-0b/0c）：唯一在产出的代码源偶发失败 ⇒ 整条代码证据通道 0 条，而调用方**只看 count**
//   分不清「源失败」与「确实没有」。此前**没有任何地方**说出"这条通道有几个源"。
//
// ★本件同时纠正了我一个不准确的说法：
//   我原先讲"**单源单点**"，实测 doctor 的自曝显示 `total=4 / available=2`（GitHubCode + GitLabBlobs），
//   **名义上不是 1 个源**。真实情形是：`GitLabBlobs` **长期 zero-hit** ⇒ 「**2 个可用 / 1 个在产出**」。
//   ⇒ 所以本门**同时钉住两件事**：
//     ① 通道自曝必须存在且自洽（doctor 能做的那一半）
//     ② **可用 ≠ 有效**：`availableCount` **不得**被当作"有几个源在产出"——「可用却零命中」只能由
//        `coverage.ReasonCodes` 的 `zero-hit` 表达（这是运行期事实，doctor 无状态，抓不到）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceAll } from './lib/source.mjs';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(testsDir, '..');
const MAIN = sourceAll(path.join(root)).replace(/^\uFEFF/, '');
const DOC = fs.readFileSync(path.join(root, 'references/参数速查.md'), 'utf8');
const EVID = path.join(root, 'reports/gates/r4-0-baseline-2026-10-04/f1-doctor-probe.json');

// 从源码抽 doctorReport['remoteCodeSources'] 的字面形状声明
test('R4-F1-d1（存在性）: doctor 必须自曝代码证据通道构成', () => {
  assert.match(MAIN, /\$doctorReport\['remoteCodeSources'\]/, 'doctor 必须输出 remoteCodeSources');
  for (const k of ['total', 'available', 'disabled', 'availableCount', 'singlePoint', 'warning']) {
    assert.match(MAIN, new RegExp('\\b' + k + '\\s*='), `remoteCodeSources 必须含字段 ${k}`);
  }
  // 负例：若把 singlePoint 去掉，本判据必须红
  const broken = MAIN.replace(/\bsinglePoint\s*=/g, 'xSinglePoint =');
  assert.doesNotMatch(broken, /\bsinglePoint\s*=/, '★负例自检：改名后必须不再匹配');
});

test('R4-F1-d2（自洽 + 单点判据）: availableCount + disabled == total；≤1 时必须给 warning', () => {
  assert.match(MAIN, /availableCount\s*=\s*\$codeAvail\.Count/, 'availableCount 必须来自实际可用源计数');
  // ★2026-10-09 批次2 语义修正（刻意，非放宽）：判据从 `availableCount` 改为 **`effectiveCount`**。
  //   病灶：availableCount 只扣了 MCPS_DISABLE，没扣 remoteBlocked（缺 token / token 无效 / 不可达）。
  //   实测 GITLAB_TOKEN 缺失时 GitLabBlobs 仍在 available[] 里 ⇒ 报 availableCount=5，而同一份 Doctor 的
  //   remoteBlocked 却写着它「需 GITLAB_TOKEN」——同一报告自相矛盾，且单点会判错（标称 2 个、实际 1 个可用时仍报"不是单点"）。
  //   ⇒ 判据钉在"实际可用"上，并**新增自洽断言**（effectiveCount 必须由 availableCount 减去被凭据阻塞数推出）。
  assert.match(MAIN, /effectiveCount\s*=\s*\$codeAvail\.Count\s*-\s*\$rcsBlockedAvail\.Count/, 'effectiveCount 必须 = 实际可用数 − 被凭据阻塞数（自洽）');
  assert.match(MAIN, /singlePoint\s*=\s*\(\$effectiveCount\s*-le\s*1\)/, 'singlePoint 必须由**实际可用**源数 ≤1 判定');
  // 单点分支必须真的写 warning（不是空分支）
  assert.match(MAIN, /if\s*\(\$effectiveCount\s*-le\s*1\)\s*\{[\s\S]{0,120}?\$rcsWarning\s*=/, '单点分支必须真的设置 warning 文案');
  // 负例：把阈值改成 <0（永假）⇒ 判据应能识别出"单点分支永不触发"
  const never = MAIN.replace(/\(\$effectiveCount\s*-le\s*1\)/g, '($effectiveCount -le -1)');
  assert.doesNotMatch(never, /\(\$effectiveCount\s*-le\s*1\)/, '★负例自检：改成永假后必须不再匹配原阈值');
});

test('R4-F1-d3（★可用 ≠ 有效）: 不得把 availableCount 当"在产出的源数"', () => {
  // 事实依据：实测 available=2（GitHubCode + GitLabBlobs），但 GitLabBlobs 长期 zero-hit
  //   ⇒ doctor 能说的只是"谁被启用/禁用"；"谁真的在产出"只能由运行期的 reasonCodes 表达。
  assert.match(MAIN, /'zero-hit'/, '运行期必须仍以 zero-hit 表达"可用却无命中"');
  assert.match(MAIN, /'user-disabled'/, '运行期必须仍以 user-disabled 表达"被 MCPS_DISABLE 跳过"');
  // 文案里不得声称"在产出"（避免把"可用"读成"有效"）
  const rcsBlock = /\$rcsWarning\s*=\s*"([^"]*)"/.exec(MAIN);
  assert.ok(rcsBlock, '必须能取到单点告警文案');
  assert.doesNotMatch(rcsBlock[1], /在产出/, '★告警文案不得把"可用源数"说成"在产出源数"（那是两回事）');
  assert.match(rcsBlock[1], /可用/, '告警文案应明确说的是"可用远程源"');
});

test('R4-F1-d4（实测读数留证）: 证据文件必须显示 total/available/disabled 的真实构成', () => {
  assert.ok(fs.existsSync(EVID), '必须留有 doctor 取证文件: ' + EVID);
  const arr = JSON.parse(fs.readFileSync(EVID, 'utf8').replace(/^\uFEFF/, ''));
  assert.ok(Array.isArray(arr) && arr.length >= 1, '取证文件必须至少含 1 次 doctor 运行');
  const hit = arr.find(x => /remoteCodeSources/.test(x.remoteCodeSources || x.snippet || ''));
  assert.ok(hit, '取证文件里必须出现 remoteCodeSources 的读数（否则本判据是空跑）');
  // ★优先用专用窗口字段（remoteCodeSources 排在 remoteBlocked 之前，主 snippet 以 GitHubCode 为锚截不到它）
  const blob = hit.remoteCodeSources || hit.snippet;
  const m = /"available":\[(.*?)\],\s*"disabled":\[(.*?)\]/.exec(blob);
  assert.ok(m, '必须能解析出 available / disabled 名单');
  const avail = m[1].split(',').filter(Boolean).map(s => s.replace(/"/g, ''));
  const dis = m[2].split(',').filter(Boolean).map(s => s.replace(/"/g, ''));
  console.log(`[R4-F1-d] 实测：可用=${avail.join('/')}（${avail.length}）  禁用=${dis.join('/')}（${dis.length}）`);
  assert.deepEqual(dis, ['GrepApp', 'Sourcegraph'], '禁用名单应来自 MCPS_DISABLE（用户配置，本件不动它）');
  assert.ok(avail.length >= 2, '★名义可用应 ≥2（GitHubCode + GitLabBlobs）—— 这正是"单源单点"说法需要被修正的原因');
  assert.ok(avail.includes('GitHubCode'), 'GitHubCode 必须在可用名单里');
  // 与文档口径一致：MCPS_DISABLE 是用户配置，不是技能硬禁
  assert.match(DOC, /MCPS_DISABLE/, '参数速查必须仍记录 MCPS_DISABLE（用户可配置）');
});
