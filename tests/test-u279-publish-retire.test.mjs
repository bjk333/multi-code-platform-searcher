// U-279（v1.61.0，B3-8）：**退役** —— 清单不再发货的文件要从安装副本里撤下。
//
// 病在哪（2026-10-27 实测 A 副本）：
//   `manifest=308 / actual=1200 / extra=892`，其中 `reports/**` 880、`tools/audit/*` 3。
//   发布只做"复制 + 覆盖"，**从不撤下已删文件** ⇒ 副本是历次发布的**并集**，不是"这一版的安装"。
//   后果不只是占空间：`--profile=installed` 跑的是另一套目录树，U-277/U-278 那两条记录类门在副本里
//   只能靠 skip 保命；"装好的副本 === 清单"这句话根本没法成立。
//
// 为什么仍不"反选整棵树"（U-248 的结论没变）：
//   目标里躺着 `.env`（凭据）与用户自己放的文件。反选会连它们一起删。
//   所以退役是**声明式**的三条同时成立（受管目录内 + 不在清单 + 非保护名单），根级散文件一律不碰。
//
// 本门分四层：
//   A 真值表（合成目录，真跑 PS）：5 条退役 / 1 条残留 / 其余 11 条一个不动 / 空壳收尾
//   B fail-closed：不给清单 ⇒ 0 退役；不给受管目录 ⇒ 0 退役；`-WhatIf` 只打印
//   C 保护名单按**文件名**判（`lib/.env` 也得留住）+ **逐文件**判（清单点名的 `reports/keep.md` 必须活）
//   D 接线：publish 真的传了两个参数、`-NoPrune` 一并关、清单里 `reports/**` 为 0（这条是"能退役"的前提）
//
// ★D 的最后一条是**产品决定**，不是实现细节：证据不进安装副本。哪天要发一份样本报告，
//   这条会红 —— 那时该做的是改口径并保留 `reports` 的受管声明，而不是把这条断言删掉。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPwsh } from './r2-ps-run.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(ROOT, 'scripts', 'publish-skill.ps1');
const HARNESS = path.join(ROOT, 'tests', 'u279-retire-truth.ps1');

let cache = null;
async function truth() {
  if (cache) return cache;
  const r = await runPwsh(['-File', HARNESS], { timeoutMs: 180000 });
  assert.equal(r.status, 0, `harness rc=${r.status}: ${(r.stderr || '').slice(-500)}`);
  const line = r.stdout.split(/\r?\n/).filter((l) => l.trim().startsWith('{"')).pop();
  assert.ok(line, 'harness 没有输出 JSON 行：' + r.stdout.slice(-400));
  cache = JSON.parse(line);
  return cache;
}

test('U-279-A 真值表：受管目录内的 5 条退役、1 条残留、其余一个不动，空壳一并收尾', async () => {
  const t = await truth();
  assert.deepEqual(t.retired.slice().sort(), [
    'lib/old-engine.ps1', 'reports/gates/2019.log', 'reports/legacy-root.md',
    'tests/gone.test.mjs', 'tools/audit/audit-old.ps1',
  ], '退役集合必须精确（多删=误删，少删=漏删）');
  assert.deepEqual(t.removed, ['reports/_tmp/scratch.json'], '白名单残留仍走 U-248 分支（不是退役分支）');

  const remain = new Set(t.remain);
  for (const p of ['SKILL.md', 'lib/keeper.ps1', 'tests/keeper.test.mjs', 'tools/audit/parity-check.ps1']) {
    assert.ok(remain.has(p), `清单内的文件被删了：${p}`);
  }
  for (const p of ['.env', 'skill-assets.json', 'my-notes.md', 'stress-old.ps1', 'custom/stuff.txt', 'lib/.env', 'lib/.gate-green.json']) {
    assert.ok(remain.has(p), `受保护/根级/不受管文件被删了：${p}`);
  }
  assert.equal(t.remain.length, 11, '剩下的必须恰好 11 条：' + t.remain.join(', '));

  // 退役 + 残留都删完后，`reports/` 整棵树（含顶级目录本身）不能留空壳
  assert.ok(!t.dirs.includes('reports'), '空壳 reports/ 没被收尾：' + t.dirs.join(', '));
  // 非空目录必须留着（绝不为删目录去删文件）
  for (const d of ['lib', 'tests', 'tools', 'tools/audit', 'custom']) {
    assert.ok(t.dirs.includes(d), `非空目录被误删：${d}`);
  }
});

test('U-279-B fail-closed：不给清单 / 不给受管目录 ⇒ 一条都不退役；-WhatIf 不落盘', async () => {
  const t = await truth();
  assert.equal(t.noManifest.retired, 0, '没有清单就不能猜"哪些该退役"');
  assert.equal(t.noManifest.remain, 6, '没清单时 6 个文件必须原样');
  assert.equal(t.noOwned.retired, 0, '清单不能单独当许可证：没有受管目录声明就什么都不删');
  assert.equal(t.noOwned.remain, 6);
  assert.equal(t.whatIf.retired, 1, '-WhatIf 仍要**算出**将退役的集合（否则预演没有意义）');
  assert.equal(t.whatIf.remain, 1, '-WhatIf 绝不能真的删');
});

test('U-279-C 保护名单按文件名判 + 逐文件判（不是按目录整棵删）', async () => {
  const t = await truth();
  assert.deepEqual(t.protectedKept.slice().sort(), ['lib/.env', 'lib/skill-assets.json'],
    '受管目录里的 .env / 清单同样不许删（保护名单要按 basename 匹配）');
  assert.deepEqual(t.perFile.retired, ['reports/other.md']);
  assert.deepEqual(t.perFile.remain, ['reports/keep.md'],
    '清单点名的 reports/keep.md 必须活 —— 退役是按文件判，不是按目录');
});

test('U-279-D 接线：publish 传参、-NoPrune 一并关闭、清单里 reports/** 为 0', () => {
  const src = fs.readFileSync(PUB, 'utf8');

  // ① 调用点必须把两个集合真的传进去（漏传 = 退役永不发生，且门在自己的真值表里还是绿的）
  assert.match(src, /Remove-PublishResidue\s+-TargetDir\s+\$t\s+-CanonicalDir\s+\$canonicalDir\s+-ManifestFiles\s+\$manifestPaths\s+-OwnedDirs\s+\$ownedDirs/,
    '调用点没传 -ManifestFiles / -OwnedDirs ⇒ 退役是死代码');
  // ② 受管目录 = 清单顶层目录 + 声明式的 reports
  assert.match(src, /\$ownedDirs\s*=\s*@\([^\n]*\+ @\('reports'\)\)/, '受管目录必须显式包含 reports（它不进清单但属于包）');
  // ③ 与残留清理同一个开关：-NoPrune 时两件事都不做（否则"我不想要清理"会变成"只清了残留"）
  const block = src.slice(src.indexOf('# ---- U-248：发布后清残留'), src.indexOf('# ---- Tier1-3 收口①'));
  assert.match(block, /if \(-not \$NoPrune\)/, '-NoPrune 必须同时关掉退役与残留');
  assert.match(block, /\[U-279\]/, '退役必须自己报数（混在 U-248 的行里就分不清删的是临时物还是产品文件）');

  // ④ 活体：清单里不能有 reports/** —— 证据不进安装副本。这是"整棵 reports 可退役"的前提。
  //   ★清单找两处：仓里是父仓的 `../skill-assets.json`，安装副本里是自己那份 `skill-assets.json`
  //     （发布器写给 target 的，形状相同）。只认父仓的话，本门在副本里会因为"文件不存在"而红，
  //     而那不是产品缺陷 —— 与 U-277/U-278 的"非仓库则跳过"是同一类问题，这里能真读就不该跳过。
  const manPaths = [path.join(ROOT, '..', 'skill-assets.json'), path.join(ROOT, 'skill-assets.json')];
  const manPath = manPaths.find((p) => fs.existsSync(p));
  assert.ok(manPath, '两处都找不到 skill-assets.json：' + manPaths.join(' / '));
  const man = JSON.parse(fs.readFileSync(manPath, 'utf8').replace(/^\uFEFF/, ''));
  const asset = (man.assets || []).find((a) => a.name === 'multi-code-platform-searcher');
  assert.ok(asset, '清单里找不到本 asset：' + manPath);
  const reports = Object.keys(asset.fileHashes).filter((p) => p.startsWith('reports/'));
  assert.deepEqual(reports, [],
    `清单里出现了 ${reports.length} 个 reports/**（${reports.slice(0, 3).join(', ')}）—— ` +
    '要发证据就得改口径：保留 reports 受管声明、同时把这条断言改成"清单内的 reports 文件必须活"');
});
