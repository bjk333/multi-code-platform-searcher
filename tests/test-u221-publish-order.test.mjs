// U-221（2026-10-22，v1.52.0）：发布收口顺序（Tier1-3）—— "新文件漏发 / 示例改动不进哈希 / 镜像没最后刷" 三类事故的机器闸。
//
// 动机（v1.51.0 一批里连踩三次）：
//   ① 新文件忘登记进 skill-assets.json ⇒ A 副本拿不到（MCP outputSchema 曾静默消失）；
//   ② -SyncExampleFromMirror 改了清单内文件却没重算哈希 ⇒ U-139 漂移；
//   ③ 镜像在最后一次哈希之前生成 ⇒ U-139 红。
// 判据（顺序即语义，故用 index 先后断言而不是"存在即过"）：
//   A 预检 fail-closed：命中收录形态但不在清单 ⇒ exit 2，且有意不发的文件必须在排除表里带 why；
//   B 示例派生必须发生在**哈希回写之前**（示例改动自动进哈希，一条命令即正确）；
//   C 镜像重生成必须发生在**哈希回写之后**（镜像 = 最终清单）；
//   D 变异：任一顺序/闸被拆必须红。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'scripts', 'publish-skill.ps1'), 'utf8');

function checkOrder(src) {
  // A 预检：fail-closed + 排除表带 why + 显式放行开关
  assert.match(src, /\$pubMissing = @\(\$pubCandidates \| Where-Object \{ -not \$asset\.fileHashes\.PSObject\.Properties\[\$_\] \}\)/,
    '★ 必须有"清单外新文件"预检（否则新文件静默漏发）');
  assert.match(src, /if \(-not \$RegisterMissing\) \{[\s\S]{0,900}exit 2/,
    '★ 预检命中必须 fail-closed 阻断（-RegisterMissing 才放行）');
  assert.match(src, /\$PUB_EXCLUDE_EXACT = @\{[\s\S]{0,600}?=\s*'[^']{8,}'/,
    '★ 有意不发的文件必须在排除表里登记理由（排除不留理由 = 下次没人敢删也不敢留）');

  // B/C 顺序：示例派生 < 哈希回写 < 镜像重生成（用出现位置比先后）
  const iExample = src.indexOf('Sync-ExamplePathSet -Paths @($asset.fileHashes');   // 锚定发布路径那次调用（开关块里还有一次同名调用）
  const iHash = src.indexOf('$updatedHashes[$fileName] = Get-Sha256 $src');
  const iMirrorEnd = src.lastIndexOf('Write-SkillMirror -ManifestObj $manifest -MirrorPath');
  assert.ok(iExample > 0 && iHash > 0 && iMirrorEnd > 0, '三个关键调用都必须存在');
  assert.ok(iExample < iHash,
    '★ 示例派生必须在哈希回写之前（在之后 ⇒ 示例改动不进哈希 ⇒ U-139 漂移；这正是 v1.51.0 踩的坑）');
  assert.ok(iMirrorEnd > iHash,
    '★ 镜像重生成必须在哈希回写之后（镜像 = 最终清单；先刷后改哈希 ⇒ U-139 红）');

  // 镜像终刷不得被 WhatIf 之外的条件跳过（收口必须真的跑）
  assert.match(src, /Tier1-3 收口①：镜像刷/, '收口段必须在（注释即锚点，防整段被删；v1.53.8 起镜像刷提前到 Statement 之前）');
}

test('U-221: 发布收口顺序 —— 预检 fail-closed、示例先派生、镜像在哈希之后', () => {
  checkOrder(SRC);
});

test('U-221 negative control: 预检闸被拆 / 顺序被打乱 / 收口被删 都必须红', () => {
  const noGate = SRC.split('exit 2').join('exit 0');
  assert.notEqual(noGate, SRC, 'mutation must hit the fail-closed exit');
  assert.throws(() => checkOrder(noGate), /fail-closed 阻断/);

  // 顺序打乱：把示例派生调用挪到哈希回写之后
  // ★移的是**调用行**不是变量声明行：两者都含 $pubExamplePath，移错对象会让顺序断言假绿（本门第一版就踩了）
  const exLine = SRC.split('\n').find((l) => l.includes('Sync-ExamplePathSet -Paths @($asset.fileHashes'));
  const swapped = SRC.replace(exLine + '\n', '').replace(
    '$updatedHashes[$fileName] = Get-Sha256 $src',
    '$updatedHashes[$fileName] = Get-Sha256 $src\n' + exLine);
  assert.notEqual(swapped, SRC, 'mutation must actually move the example sync');
  assert.throws(() => checkOrder(swapped), /示例派生必须在哈希回写之前/);

  // 收口整段删掉
  const noTail = SRC.replace(/# ---- Tier1-3 收口[\s\S]*?Tier1-3\] 发布收口完成[^\n]*\n/, '');
  assert.notEqual(noTail, SRC, 'mutation must remove the final mirror refresh');
  assert.throws(() => checkOrder(noTail), /镜像重生成必须在哈希回写之后|收口段必须在/);
});

// ---- v1.53.2：文档里的「N 项」由清单实际条目数自动同步（Tier1-3 延伸）----
//   动机：SKILL / 说明书 / 参数速查 三处写死清单项数，每加文件都要手改三处；
//   v1.53.0 与 v1.53.2 各漏过一次（G2 报「文档写 200，源码派生 201」）。项数是发布产物，不该手写。
//   ★顺序契约：同步必须在**哈希回写之前** —— 否则改完的文档不会进哈希，B/A 立刻漂移。
function checkCountSync(src) {
  assert.match(src, /\$manifestCount = @\(\$asset\.fileHashes\.PSObject\.Properties\)\.Count/,
    '★ 项数必须由清单实际条目数派生（不许在脚本里写死数字）');
  for (const anchor of ['宿主按 \\*\\*)\\d+( 项清单', '（当前 )\\d+( 项，由 G2 从清单派生校验）', '(当前 )\\d+( 项发布路径']) {
    assert.ok(src.includes(anchor), '★ 缺一处已知句式的同步锚点：' + anchor + '（三处都要，否则 G2 会红）');
  }
  const iSync = src.indexOf('清单项数已同步为 ');
  const iExample = src.indexOf('Sync-ExamplePathSet -Paths @($asset.fileHashes');
  const iHash = src.indexOf('$updatedHashes[$fileName] = Get-Sha256 $src');
  assert.ok(iSync > 0 && iExample > 0 && iHash > 0, '锚点缺失：sync/example/hash 之一找不到');
  assert.ok(iSync < iExample, '★ 项数同步必须早于示例派生');
  assert.ok(iSync < iHash, '★ 项数同步必须早于哈希回写 —— 否则文档改动不进哈希，B/A 必漂');
}
test('U-221b: 文档清单项数由清单派生并自动同步（且早于哈希）', () => {
  checkCountSync(SRC);
});
test('U-221b negative control: 去掉同步块 / 把同步挪到哈希之后 —— 必须被点名', () => {
  const noSync = SRC.replace(/# ---- Tier1-3 延伸（v1\.53\.2）[\s\S]*?清单项数已同步为[^\n]*\n/, '');
  assert.notEqual(noSync, SRC, 'mutation must remove the count-sync block');
  assert.throws(() => checkCountSync(noSync), /项数必须由清单实际条目数派生|缺一处已知句式/);

  // ★整块**移动**而不是重写：重写容易漏掉句式，先撞"缺锚点"就测不到顺序（本门第一版踩过）
  const blockRe = /# ---- Tier1-3 延伸（v1\.53\.2）[\s\S]*?清单项数已同步为[^\n]*\n/;
  const block = SRC.match(blockRe)[0];
  const moved = SRC.replace(block, '').replace(
    '$updatedHashes[$fileName] = Get-Sha256 $src',
    '$updatedHashes[$fileName] = Get-Sha256 $src\n' + block);
  assert.notEqual(moved, SRC, 'mutation must move the block');
  assert.throws(() => checkCountSync(moved), /项数同步必须早于/);
});

// U-221c（v1.53.3，2026-10-23）：示例清单的 version 必须与 `-Version` 同源。
//   实测缺口：`-Version` 只写根清单，`scripts/skill-assets.example.json` 的 version 靠手改 ⇒
//   门 U-139 root version（镜像+示例 version == 脚本 $VERSION）会在下次全量时红，而发布者以为"已收口"。
//   示例是发布派生物 ⇒ 版本随发布走，且必须在算哈希之前改（否则本次哈希不含这次改动）。
function checkExampleVersionSync(src) {
  assert.match(src, /function Sync-ExampleVersion\s*\{/, '必须存在 Sync-ExampleVersion（示例 version 是发布派生物）');
  const iCall = src.indexOf('Sync-ExampleVersion -Version $Version -ExamplePath $pubExamplePath');
  assert.ok(iCall > 0, '★ 发布主流程必须调用 Sync-ExampleVersion —— 否则示例 version 与根清单漂移');
  const iHash = src.indexOf('$updatedHashes[$fileName] = Get-Sha256 $src');
  assert.ok(iHash > 0 && iCall < iHash, '★ 同步必须早于哈希计算 —— 否则示例的版本改动不进本次哈希');
}
test('U-221c: 示例清单 version 与 -Version 同源（且早于哈希）', () => {
  checkExampleVersionSync(SRC);
});
test('U-221c negative control: 去掉同步调用 —— 必须被点名', () => {
  const mutant = SRC.replace('$exVerChanged = Sync-ExampleVersion -Version $Version -ExamplePath $pubExamplePath', '');
  assert.notEqual(mutant, SRC, 'mutation must remove the call');
  assert.throws(() => checkExampleVersionSync(mutant), /必须调用 Sync-ExampleVersion/);
});

// U-221d（v1.53.8，2026-10-23）：Statement 在**镜像之后**生成。
//   病灶（实测）：Statement 的发货集合取自 `reports/_skill-assets.root.json`（镜像），而旧顺序是
//   「Statement 重生成 → 镜像最后刷」⇒ 任何**新增**文件的版本里 Statement 都滞后一版：
//   v1.53.8 发布后 fileCount 204（记录）vs 205（实际），U-158 A 立刻红。
//   镜像刷新只写 reports/、不碰任何哈希 ⇒ 放 Statement 之前是安全的（此时哈希已定稿）。
function checkStatementAfterMirror(src) {
  // ★必须 lastIndexOf：`Write-SkillMirror -ManifestObj` 的**第一次**出现是函数**定义**（实测踩过，假绿）
  const iMirror = src.lastIndexOf('Write-SkillMirror -ManifestObj $manifest -MirrorPath');
  assert.ok(iMirror > 0, '锚点缺失：镜像刷新调用');
  const iStmt = src.indexOf('$stmtTest = Join-Path $canonicalDir');
  assert.ok(iStmt > 0, '★ 发布主流程必须重生成 in-toto Statement');
  assert.ok(iMirror < iStmt, '★★ 镜像必须先刷、Statement 后生成 —— Statement 读的就是镜像，反了就会滞后一版（新增文件时必红）');
}
test('U-221d: 镜像刷新早于 Statement 重生成（Statement 的发货集合取自镜像）', () => {
  checkStatementAfterMirror(SRC);
});
test('U-221d negative control: 把镜像挪回 Statement 之后 —— 必须被点名', () => {
  const iMirror = SRC.indexOf("# ---- Tier1-3 收口①：镜像刷");
  const iStmt = SRC.indexOf('# ---- U-176（v1.42.0）：发布末尾重生成 in-toto Statement ----');
  const block = SRC.slice(iMirror, iStmt);
  const moved = SRC.replace(block, '').trimEnd() + '\n' + block;
  assert.notEqual(moved, SRC, 'mutation must move the mirror block to the end');
  assert.throws(() => checkStatementAfterMirror(moved), /镜像必须先刷、Statement 后生成/);
});

// U-221e（v1.53.11，2026-10-23）：示例清单是**派生 JSON**，两个同步函数都按文本改字节，
//   谁也发现不了"改完不是合法 JSON"。实测 v1.53.10：`_comment` 里两个未转义直引号把文件写坏，
//   publish 一路绿（复制 / 算哈希 / 刷镜像），只有门 U-139 事后红。派生物坏了就不该发。
function checkExampleJsonGuard(src) {
  const iGuard = src.indexOf('[U-221e] 示例清单不是合法 JSON');
  assert.ok(iGuard > 0, '★ 发布前必须校验示例清单是合法 JSON（fail-closed）');
  const iHash = src.indexOf('$updatedHashes[$fileName] = Get-Sha256 $src');
  assert.ok(iHash > 0 && iGuard < iHash, '★ 校验必须早于哈希回写 —— 否则坏字节已进清单');
}
test('U-221e: 示例清单 JSON 损坏时发布必须中止（且早于哈希）', () => {
  checkExampleJsonGuard(SRC);
});
test('U-221e negative control: 去掉校验 —— 必须被点名', () => {
  const mutant = SRC.replace('catch { throw "[U-221e] 示例清单不是合法 JSON，发布中止（派生阶段就已损坏）：$($_.Exception.Message)" }', 'catch { }');
  assert.notEqual(mutant, SRC, 'mutation must drop the guard');
  assert.throws(() => checkExampleJsonGuard(mutant), /必须校验示例清单是合法 JSON/);
});
