// U-248（v1.53.26，验收 B1-4 后半）：发布副本的残留清理 —— **白名单式**，绝不反选。
//
// 为什么不能反选（2026-10-25 只读盘点，A 副本实测）：
//   `manifest=224 / actual=1139 / extra=915`，extra 里包括
//     · `.env`（用户凭据，1 份）—— 反选式删除会**删掉凭据**；
//     · `reports/**` 证据 886 份 —— 反选会把证据当垃圾；
//     · `tools/audit/*`（疑似漏登记）—— 反选会把"该发没发"静默成"没有这个东西"。
//   真正该清的是 28 项（下划线临时物 8 + `_verify` 17 + 缓存/备份 3），所以清理只能是**白名单**。
//
// 门分三层：
//   A 合成目录真值表：该删的 5 类全删、凭据/证据/工具/文档一个不动；
//   B 接线：`-NoPrune` 开关、调用点、保护名单 throw、`-WhatIf` 只打印；
//   C 可执行变异：把白名单改宽到能吃 `.env` ⇒ 必须抛"保护名单被命中"（真跑，不是看源码）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPwsh } from './r2-ps-run.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB_PATH = path.join(ROOT, 'scripts', 'publish-skill.ps1');
const PUB = fs.readFileSync(PUB_PATH, 'utf8');
const HARNESS = path.join(ROOT, 'tests', 'u248-prune-truth.ps1');

async function runHarness(extraArgs = []) {
  return runPwsh(['-File', HARNESS, ...extraArgs], { timeoutMs: 180000 });
}
function jsonLine(r) {
  return r.stdout.split(/\r?\n/).filter(l => l.trim().startsWith('{"')).pop();
}

test('U-248-A: 合成目录 —— 白名单 5 类全删，凭据/证据/工具/文档一个不动', async () => {
  const r = await runHarness();
  assert.equal(r.status, 0, `harness rc=${r.status}: ${(r.stderr || '').slice(-400)}`);
  const { removed, remain } = JSON.parse(jsonLine(r));
  // 该删的
  for (const p of ['reports/_tmp/a.json', '_verify/probe.txt', 'reports/gates/.cache/c.json', 'search_cache.json', 'SKILL.md.bak-fm']) {
    assert.ok(removed.includes(p), `白名单内未删：${p}`);
  }
  assert.equal(removed.length, 5, '只允许删白名单命中项，实删 ' + removed.length);
  // 绝不能删的（用 ASCII 路径断言，避免中文文件名在控制台码页下的比较问题）
  for (const p of ['.env', 'skill-assets.json', 'reports/gates/keep.md', 'reports/evidence-2026-10-20/x.json', 'tools/audit/audit-run.ps1', 'SKILL.md', 'tests/test-x.mjs']) {
    assert.ok(remain.includes(p), `✦ 受保护文件被删了：${p}`);
  }
  assert.ok(!remain.some(p => p.startsWith('_verify/') || p.startsWith('reports/_')), '白名单项仍有残留');
  // U-255：删完文件不能留空目录壳（真 A 上实测留过 `reports/_smoke-u240/{,agents,raw}`）。
  //   目录规则必须与文件白名单同源 —— 第一次修时漏了 `**/.cache`，`.cache` 空壳留在原地。
  const { dirs } = JSON.parse(jsonLine(r));
  const shells = dirs.filter(d => /^reports\/_/.test(d) || d === '_verify' || /(^|\/)\.cache$/.test(d));
  assert.deepEqual(shells, [], '清理后留下空目录壳：' + shells.join(', '));
  // 非空目录必须留着（不能为了"干净"把还有内容的目录也删了）
  for (const d of ['reports', 'reports/gates', 'reports/evidence-2026-10-20']) {
    assert.ok(dirs.includes(d), `非空目录被误删：${d}`);
  }
  // U-255 关键一条：**没有文件可删、只剩空壳**时也必须清（真 A 的 `reports/_smoke-u240` 就是这个形态）。
  //   第一版把这段挂在 victims 上 ⇒ `$victims.Count === 0` 提前 return，空壳永远清不掉。
  const { shell } = JSON.parse(jsonLine(r));
  assert.ok(shell, 'harness 未产出空壳用例');
  assert.deepEqual(shell.removed, [], '空壳用例不该删任何文件');
  assert.deepEqual(shell.removedDirs, ['reports/_shell2', 'reports/_shell2/deep'], '无 victims 时空壳未被清');
  assert.ok(!shell.remainDirs.some(d => d.startsWith('reports/_')), '空壳仍在：' + shell.remainDirs.join(', '));
});

test('U-248-A2: 否决权（U-254）—— 源仓也有的即使命中白名单也不许删', async () => {
  const r = await runHarness();
  assert.equal(r.status, 0, `harness rc=${r.status}: ${(r.stderr || '').slice(-400)}`);
  const { veto } = JSON.parse(jsonLine(r));
  assert.ok(veto, 'harness 未产出 veto 用例');
  assert.deepEqual(veto.removed, [], '源仓也存在的文件被删了 —— 这正是 dry-run 抓到的那个缺陷（会删掉被引用的裁决记录）');
  assert.deepEqual(veto.skipped, ['reports/_tmp/a.json'], '否决权未生效（应跳过并记账）');
  assert.ok(veto.remain.includes('reports/_tmp/a.json'), '文件确实被删了');
});

test('U-248-B: 接线 —— 默认开、-NoPrune 关、调用点在复制后、-WhatIf 只打印', () => {
  const bad = [];
  if (!/\[switch\]\$NoPrune/.test(PUB)) bad.push('缺 -NoPrune 开关');
  if (!/if \(-not \$NoPrune\) \{/.test(PUB)) bad.push('清理未被 -NoPrune 守卫（等于无法关闭）');
  // v1.61.0（U-279）：调用点还要传两个集合 —— 漏传时退役是死代码，而本条若只匹配旧前缀就会漏看
  // v1.72.0（U-292）：允许再带 `-NotShippedFiles <集合>`（根级已登记不随发的退役来源）
  if (!/Remove-PublishResidue -TargetDir \$t -CanonicalDir \$canonicalDir -ManifestFiles \$manifestPaths -OwnedDirs \$ownedDirs (?:-NotShippedFiles \$notShippedRoot )?-WhatIf:\$WhatIf/.test(PUB)) bad.push('调用点未传 -CanonicalDir / -ManifestFiles / -OwnedDirs / -WhatIf');
  if (!/\$isProtected =[\s\S]{0,400}?\.env[\s\S]{0,200}?skill-assets\.json/.test(PUB)) bad.push('保护名单缺 .env / skill-assets.json');
  if (!/if \(\$allowed\) \{/.test(PUB)) bad.push('白名单闸门不见了（会走进"反选"老路）');
  if (!/\$manifestSet\.Count -eq 0 -or \$ownedSet\.Count -eq 0/.test(PUB)) bad.push('退役缺 fail-closed：没有清单/受管目录时必须一条都不删');
  const iCall = PUB.indexOf('Remove-PublishResidue -TargetDir $t');
  const iMirror = PUB.indexOf('Tier1-3 收口①：镜像刷');
  if (!(iCall > 0 && iMirror > 0 && iCall < iMirror)) bad.push('清理必须在复制之后、镜像刷之前');
  // U-254 的**判据顺序**是语义而非风格：.env 在源仓里也存在，若"源仓也有"排在保护名单之前，
  //   .env 会被静静跳过 —— 保护名单就从"炸"退化成"豁免"，而豁免凭据正是它要防的。
  const iProt = PUB.indexOf('if ($isProtected) { throw');
  const iVeto = PUB.indexOf('if ($CanonicalDir -and (Test-Path -LiteralPath (Join-Path $CanonicalDir $rel)))');
  if (!(iProt > 0 && iVeto > 0 && iProt < iVeto)) bad.push('保护名单必须先于"源仓也有"否决权（否则 .env 被豁免而非炸）');
  assert.deepEqual(bad, [], bad.join('; '));
});

test('U-248-C: 可执行变异 —— 白名单一旦放宽到能吃 .env，必须抛"保护名单被命中"', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u248m-'));
  // 变异：把"不在白名单就跳过"改成"什么都算白名单" ⇒ .env 会进 victims ⇒ 保护名单那行必须拦住
  const mutated = PUB.replace('        if ($allowed) {', '        $allowed = $true\n        if ($allowed) {');
  assert.notEqual(mutated, PUB, '变异未生效（锚点变了？）');
  const p = path.join(dir, 'publish-skill.mutated.ps1');
  fs.writeFileSync(p, mutated, 'utf8');
  const r = await runHarness(['-PubPath', p]);
  assert.notEqual(r.status, 0, '白名单被放宽后居然还成功 —— 保护名单形同虚设');
  assert.match(r.stdout + r.stderr, /保护名单被命中|U-248/, '失败原因必须点名保护名单');
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { }
});

test('U-248-D: 可执行变异 —— 去掉否决权 ⇒ 该文件必须被删（证明 A2 不是恒绿）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u248v-'));
  // v1.61.0（U-279）：否决权被嵌进 `if ($allowed) { … }` 里，缩进变了一层 ⇒ 锚点改成缩进无关的正则。
  //   定长字符串那种写法一改缩进就"锚点变了"，而这条变异是**证明 A2 不恒绿**的唯一手段，不能靠人记着改。
  const VETO_RE = /\n[ \t]*if \(\$CanonicalDir -and \(Test-Path -LiteralPath \(Join-Path \$CanonicalDir \$rel\)\)\) \{\r?\n[ \t]*\$skipped \+= \[PSCustomObject\]@\{ Rel = \$rel; Full = \$f\.FullName \}\r?\n[ \t]*continue\r?\n[ \t]*\}/;
  assert.ok(VETO_RE.test(PUB), '否决权锚点变了 —— 本变异要跟着更新（否则变异打不上、负例是假的）');
  const mutated = PUB.replace(VETO_RE, '');
  assert.notEqual(mutated, PUB, '变异未生效');
  const p = path.join(dir, 'publish-skill.noveto.ps1');
  fs.writeFileSync(p, mutated, 'utf8');
  const r = await runHarness(['-PubPath', p]);
  assert.equal(r.status, 0, `harness 应正常退出（本条不改保护名单）：${(r.stderr || '').slice(-300)}`);
  const { veto } = JSON.parse(jsonLine(r));
  assert.ok(veto.removed.includes('reports/_tmp/a.json'), '去掉否决权后仍不删 —— A2 的断言可能恒真');
  assert.deepEqual(veto.skipped, [], '去掉否决权后不该有跳过项');
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { }
});
