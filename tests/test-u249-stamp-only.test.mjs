// U-249（v1.53.26，B1-4 收口）：`-StampOnly` —— **只盖戳，不发布**。
//
// 为什么这条门必须存在（U-139 的结构性死锁，2026-10-25 实测）：
//   · `reports/_skill-assets.root.json`（镜像）是**根清单的镜像**，根清单只在发布流程第 8 步回写；
//   · U-139 要求「镜像非空哈希 == 当前字节」且「镜像 version == $VERSION」；
//   · ⇒ 改了树但没发布时 U-139 **必然红** ⇒ product_red≠0 ⇒ U-247 的 gate-green 拒发 ⇒ **永远发不出去**。
//   解法：把"盖戳"从"发布"里拆出来。本门守的就是"拆得干净"—— 它一旦开始复制文件，就退化成"悄悄发布"。
//
// 门分三层：
//   A 结构：参数存在；复制循环里 `if ($StampOnly) { continue }` **必须早于** `Copy-Item`；
//     退出点必须在"回写根清单"之后、"写 target 侧清单"之前；镜像必须复用 `Write-SkillMirror`；
//   B 不撒谎：`publishedAt` / `buildSummary` 的赋值必须在 `if (-not $StampOnly)` 内（没发布就不许盖发布戳）；
//   C 可执行变异（4 个）：把 continue 删掉 / 把退出点挪到复制前 / 把 publishedAt 挪出守卫 / 镜像改自写一份 ⇒ 各自判红。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { rootDir } from './r2-ps-run.mjs';

const PUB_REL = 'scripts/publish-skill.ps1';
const PUB = fs.readFileSync(path.join(rootDir, PUB_REL), 'utf8');

/** 取 param(...) 块 */
function paramBlock(src) {
  const i = src.indexOf('param(');
  assert.ok(i > 0, 'param 块缺失');
  // 括号配平（param 块内没有字符串里的裸括号会让它错，但本文件里没有）
  let d = 0, j = i + 5;
  for (; j < src.length; j++) {
    if (src[j] === '(') d++;
    else if (src[j] === ')') { d--; if (d === 0) break; }
  }
  return src.slice(i, j + 1);
}

/** A+B 的判据（可对任意源码跑，供变异使用） */
function stampFindings(src) {
  const bad = [];
  const p = paramBlock(src);
  if (!/\[switch\]\$StampOnly/.test(p)) bad.push('参数缺 [switch]$StampOnly');

  // ① 复制循环里的 continue 必须存在，且**在 Copy-Item 之前**
  const guard = 'if ($StampOnly) { continue }';
  const gi = src.indexOf(guard);
  if (gi < 0) bad.push('复制循环里缺 `if ($StampOnly) { continue }`（否则 -StampOnly 会复制文件 = 悄悄发布）');
  const ci = src.indexOf('Copy-Item -LiteralPath $src -Destination $dst');
  if (ci < 0) bad.push('找不到 Copy-Item（判据锚点失效）');
  if (gi >= 0 && ci >= 0 && gi > ci) bad.push('`if ($StampOnly) { continue }` 在 Copy-Item **之后**（起不到拦截作用）');

  // ② 退出点：必须在根清单回写之后、target 侧清单写入之前
  const exitAt = src.indexOf('if ($StampOnly) {', gi + guard.length);
  if (exitAt < 0) bad.push('缺少 -StampOnly 的退出段');
  const written = src.indexOf('清单已更新: $manifestPath');
  const tgtWrite = src.indexOf("Write-Host \"目标清单已写入");
  if (exitAt >= 0 && written >= 0 && exitAt < written) bad.push('退出段在"回写根清单"之前（镜像会拿到旧哈希）');
  if (exitAt >= 0 && tgtWrite >= 0 && exitAt > tgtWrite) bad.push('退出段在"写 target 侧清单"之后（已经碰了目标目录）');

  // ③ 镜像必须复用 Write-SkillMirror（不许第二份镜像生成逻辑）
  const exitBody = exitAt >= 0 ? src.slice(exitAt, src.indexOf('\n}', exitAt)) : '';
  if (!/Write-SkillMirror/.test(exitBody)) bad.push('退出段未复用 Write-SkillMirror（另写了一份镜像生成逻辑？）');

  // ④ 不许撒谎：publishedAt / buildSummary 必须在 `if (-not $StampOnly)` 内
  const pubIdx = src.indexOf('$asset.publishedAt = ');
  const guardNot = 'if (-not $StampOnly) {';
  const gni = src.indexOf(guardNot);
  if (gni < 0) bad.push('缺 `if (-not $StampOnly) {` 守卫');
  if (pubIdx >= 0 && gni >= 0 && pubIdx < gni) bad.push('publishedAt 在 -StampOnly 守卫之外（没发布却盖了发布时间戳）');
  if (!/\$asset\.buildSummary/.test(src.slice(gni, gni + 400))) bad.push('buildSummary 未与 publishedAt 同处守卫内');

  // ⑤ U-289（v1.70.0，B3-17 实测）：`-StampOnly` 与镜像/示例开关**必须互斥**。
  //   病灶：`if ($RegenerateMirror -or $SyncExampleFromMirror)` 那块在「算哈希 / 回写根清单」之前就 `exit 0`，
  //   所以 `-StampOnly -RegenerateMirror` 一个哈希都不算，而输出三行绿字 + rc=0 看起来像成功
  //   （实测：清单 version 还是旧的、新文件没登记，手工比对才发现）。
  //   ★这条检查的是"有没有拒绝"，不是"拒绝文案好不好" —— 文案会漂，语义不会。
  const exBlockAt = src.indexOf('if ($RegenerateMirror -or $SyncExampleFromMirror) {');
  if (exBlockAt < 0) bad.push('找不到镜像/示例块（判据锚点失效）');
  else {
    // ★别用 `indexOf('exit 0')`：守卫自己的**注释里**就写着「exit 0」（说明它为什么危险），
    //   于是切出来的块只到注释那一行为止 —— 守卫看起来"不存在"，门红得莫名其妙（本门第一版就这样红了一次）。
    //   这和 B3-15 的 D4 负控是同一个坑：**注释参与了代码分析**。只认行首的 `exit 0` 语句。
    const sub = src.slice(exBlockAt);
    const mExit = /^[ \t]*exit 0[ \t]*$/m.exec(sub);
    const exBlock = mExit ? sub.slice(0, mExit.index) : sub.slice(0, 2000);
    if (!/\$StampOnly/.test(exBlock) || !/throw/.test(exBlock)) {
      bad.push('-StampOnly 与 -RegenerateMirror/-SyncExampleFromMirror 未互斥（组合会静默变成空操作）');
    }
  }
  return bad;
}

test('U-249-A/B: -StampOnly 不复制、不写 target、不盖发布戳、镜像复用同一函数', () => {
  const bad = stampFindings(PUB);
  assert.deepEqual(bad, [], 'U-249 结构问题：' + bad.join(' | '));
});

test('U-249-C: 变异负例（4 个：删 continue / 挪退出点 / 挪 publishedAt / 自写镜像）', () => {
  // ① 删掉复制循环里的 continue ⇒ 会复制文件
  const m1 = PUB.replace('    if ($StampOnly) { continue }\n', '');
  assert.notEqual(m1, PUB, '变异①未生效');
  assert.ok(stampFindings(m1).some(x => x.includes('缺 `if ($StampOnly) { continue }`')), '删 continue 未被判红');

  // ② 把 continue 挪到 Copy-Item 之后（形式上有、实际拦不住）
  const m2 = PUB.replace(
    '    if ($StampOnly) { continue }\n',
    '').replace(
    '            $synced++\n',
    '            $synced++\n    if ($StampOnly) { continue }\n');
  assert.notEqual(m2, PUB, '变异②未生效');
  assert.ok(stampFindings(m2).some(x => x.includes('**之后**')), 'continue 位置错误未被判红');

  // ③ 把 publishedAt 挪出 -StampOnly 守卫 ⇒ 没发布也盖时间戳
  const m3 = PUB.replace('if (-not $StampOnly) {\n    # U-249：`-StampOnly` **不更新**', 'if ($true) {\n    # U-249：`-StampOnly` **不更新**');
  assert.notEqual(m3, PUB, '变异③未生效');
  assert.ok(stampFindings(m3).some(x => x.includes('缺 `if (-not $StampOnly) {` 守卫')), 'publishedAt 挪出守卫未被判红');

  // ④ 镜像改成自己拼（= 第二份生成逻辑）。★定位纪律：`Write-SkillMirror -ManifestObj $manifest` 在
  //   本文件里有**三处**（-RegenerateMirror / -StampOnly 退出段 / 发布流程末尾的最后一次刷镜像），
  //   所以既不能用 `replace`（只打第一处），也不能用 `lastIndexOf`（打到第三处）—— 两者都"变异生效了但打偏了"。
  //   唯一正确的定位是：**先框定退出段，再在段内找**。
  const wsm = 'Write-SkillMirror -ManifestObj $manifest';
  assert.ok(PUB.split(wsm).length - 1 >= 3, `预期至少三处 Write-SkillMirror，实得 ${PUB.split(wsm).length - 1}`);
  const g2 = 'if ($StampOnly) { continue }';
  const gi2 = PUB.indexOf(g2);
  const exitAt2 = PUB.indexOf('if ($StampOnly) {', gi2 + g2.length);
  const end2 = PUB.indexOf('\n}', exitAt2);
  const rel = PUB.slice(exitAt2, end2).indexOf(wsm);
  assert.ok(rel > 0, '锚点缺失：退出段内的 Write-SkillMirror');
  const at4 = exitAt2 + rel;
  const m4 = PUB.slice(0, at4) + '$null = 1' + PUB.slice(at4 + wsm.length);
  assert.notEqual(m4, PUB, '变异④未生效');
  assert.ok(stampFindings(m4).some(x => x.includes('未复用 Write-SkillMirror')), '自写镜像未被判红');

  // ⑤ U-289：删掉互斥守卫 ⇒ 退回"静默空操作"
  const guardAt = PUB.indexOf('    if ($StampOnly) {\n        throw (\'[U-289]');
  assert.ok(guardAt > 0, '锚点缺失：U-289 互斥守卫');
  const guardEnd = PUB.indexOf('\n    }\n', guardAt);
  assert.ok(guardEnd > guardAt, '互斥守卫的花括号不配对');
  const m5 = PUB.slice(0, guardAt) + PUB.slice(guardEnd + '\n    }\n'.length);
  assert.notEqual(m5, PUB, '变异⑤未生效');
  assert.ok(stampFindings(m5).some(x => x.includes('静默变成空操作')), '删掉互斥守卫未被判红');
});
