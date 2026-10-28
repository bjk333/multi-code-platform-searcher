// U-292（v1.72.0，2026-10-28 全量验收 F2/F3）：两处"判据与要防的事不是一回事"。
//
// F2 —— `test-docs` 的字面转义判据：旧写法是全文 `Contains('\'+'n')`，它分不清
//   ① 文档在**描述**一条正则（合法，且往往必须写）② 换行真被替换成了两个字符（损伤）。
//   代价是实证的：v1.70.0 于 10-27 带着第 171 行的"描述"红发布；10-28 整改时写注释又踩一次。
//   新判据带上下文：围栏代码块内 / 行内 `代码段` 内 = 示例；正文里出现 = 损伤。
//   本门用 **AST 抠出 PS 函数跑同一张真值表**，并做三条**可执行变异**证明判据不是摆设。
//
// F3 —— 发布器只 copy 不 delete，而 U-279 明确只碰受管目录内 ⇒ **根级**"已登记不随发"的文件
//   永远留在目标侧（实证：A 的 说明书.md 停在 10-20 / 19 KB，源仓 10-28 / 46 KB）。
//   U-292 给 Remove-PublishResidue 加了 `-NotShippedFiles`（根级 + 登记过 + 保护名单优先），
//   真值表在 u248-prune-truth.ps1 的用例 3；这里守接线与"缺省不变"。
//
// gate-profile: installed —— v1.73.0 实测：本门只读**随包发货**的文件（SKILL.md / publish-skill.ps1 /
//   run-tests.ps1 / u248-prune-truth.ps1）与临时合成目录，在 A 副本上直接跑 4/4 通过。
//   原来它被 installed 剖面的启发式误排除（源码里出现 `skill-assets.json` 字样 ⇒ 被当成"读父仓清单"），
//   于是"新判据在安装副本上跑没跑"这件事根本没人知道。显式标注后口径与实测一致。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPwsh } from './r2-ps-run.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUN_TESTS_PATH = path.join(ROOT, 'tests', 'run-tests.ps1');
const RUN_TESTS = fs.readFileSync(RUN_TESTS_PATH, 'utf8');
const PUB = fs.readFileSync(path.join(ROOT, 'scripts', 'publish-skill.ps1'), 'utf8');
const HARNESS = path.join(ROOT, 'tests', 'u292-literal-nl-truth.ps1');

async function runHarness(extraArgs = []) {
  const r = await runPwsh(['-File', HARNESS, ...extraArgs], { timeoutMs: 180000 });
  const line = (r.stdout || '').split(/\r?\n/).filter(l => l.trim().startsWith('{"ok"')).pop();
  return { r, data: line ? JSON.parse(line) : null };
}

test('U-292-A: 判据真值表（正文红 / 代码段绿 / 围栏绿）', async () => {
  const { r, data } = await runHarness();
  assert.equal(r.status, 0, `harness rc=${r.status}: ${(r.stderr || '').slice(-500)}`);
  assert.ok(data, `harness 未输出 JSON：${(r.stdout || '').slice(-300)}`);
  const want = { 'prose-artifact': 1, 'codespan-ok': 0, 'fence-ok': 0, 'two-artifacts': 2, 'clean-doc': 0 };
  assert.deepEqual(data.rows.map(x => x.id).sort(), Object.keys(want).sort(), '用例集不一致');
  for (const row of data.rows) {
    assert.equal(row.hits, want[row.id], `${row.id}: hits=${row.hits} want=${want[row.id]}`);
    assert.ok(row.ok, `${row.id}: 判据自评 ${row.ok} ≠ 期望`);
  }
  // 真仓文件：现在是干净的；同一份内容插一条正文工件 ⇒ 必须红（否则等于"这门永远不会红"）
  assert.ok(data.real, '未读到 SKILL.md');
  assert.equal(data.real.hits, 0, `SKILL.md 正文仍有 ${data.real.hits} 处字面工件`);
  assert.ok(data.real.injectedHits > data.real.hits, '往真文件里注入工件后判据没有变红 ⇒ 判据已失效');
});

test('U-292-A 变异：拆掉"代码段豁免" / 拆掉"围栏豁免" / 拆掉检出面 —— 真值表各自崩', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'u292-'));
  const variants = {
    // ① 允许代码段内命中 ⇒ codespan-ok 应从 0 变正
    noCodespan: src => src.replace('            if ($inCode) { continue }\n', ''),
    // ② 允许围栏内命中 ⇒ fence-ok 应从 0 变正
    noFence: src => src.replace('        if ($inFence) { continue }\n', ''),
    // ③ 检出面失效 ⇒ prose-artifact 应从 1 变 0
    blind: src => src.replace('if ($ch -eq $bs -and ($j + 1) -lt $ln.Length -and $ln[$j + 1] -eq $nn)', 'if ($false)'),
  };
  const seen = {};
  for (const [id, mut] of Object.entries(variants)) {
    const src = mut(RUN_TESTS);
    assert.notEqual(src, RUN_TESTS, `变异 ${id} 未生效（锚点漂了）`);
    const f = path.join(tmp, `rt-${id}.ps1`);
    fs.writeFileSync(f, src, 'utf8');
    const { data } = await runHarness(['-RunTestsPath', f]);
    assert.ok(data, `变异 ${id} 的 harness 未输出 JSON`);
    seen[id] = Object.fromEntries(data.rows.map(x => [x.id, x.hits]));
  }
  assert.ok(seen.noCodespan['codespan-ok'] > 0, '拆掉代码段豁免后 codespan 仍绿 ⇒ 该豁免是装饰');
  assert.ok(seen.noFence['fence-ok'] > 0, '拆掉围栏豁免后 fence 仍绿 ⇒ 该豁免是装饰');
  assert.equal(seen.blind['prose-artifact'], 0, '检出面失效后正文工件仍被判红 ⇒ 判据不靠自己检出');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('U-292-B: 接线 —— test-docs 用新判据且两向自检；发布器按登记表退役根级残留', () => {
  const bad = [];
  if (!/Test-LiteralNewlineArtifact -Lines \$t_skillLines/.test(RUN_TESTS)) bad.push('test-docs 没接新判据');
  if (!/U-292 自检：正文里的字面工件未被判红/.test(RUN_TESTS)) bad.push('缺"能红"的自检');
  if (!/U-292 自检：代码段\/围栏内的合法示例被误判/.test(RUN_TESTS)) bad.push('缺"能绿"的自检');
  if (/Contains\(\$t_BS \+ 'n'\)/.test(RUN_TESTS)) bad.push('旧的全文 Contains 判据仍在（会再次误伤"描述正则"）');
  // 发布器：参数在、调用点传了、登记表里有那两个根级文件、保护名单仍优先
  if (!/\[string\[\]\]\$NotShippedFiles = @\(\)/.test(PUB)) bad.push('Remove-PublishResidue 缺 -NotShippedFiles');
  if (!/-NotShippedFiles \$notShippedRoot/.test(PUB)) bad.push('调用点没传 -NotShippedFiles');
  for (const k of ['说明书.md', 'stress-frontend-ui.ps1']) {
    if (!new RegExp(`'${k.replace('.', '\\.')}'\\s*=`).test(PUB)) bad.push(`登记表缺 ${k}`);
  }
  if (!/if \(\$isProtected\) \{ throw "\[U-292\] 保护名单被命中/.test(PUB)) bad.push('U-292 未做保护名单优先');
  if (!/\$notShippedSet\.Count -gt 0 -and \$rel -notmatch '\/'/.test(PUB)) bad.push('U-292 未限制在根级');
  assert.deepEqual(bad, [], bad.join('; '));
});

test('U-292-C: 根级退役真跑 —— 只退役登记过的，未登记的根级文件一个不动', async () => {
  const r = await runPwsh(['-File', path.join(ROOT, 'tests', 'u248-prune-truth.ps1')], { timeoutMs: 180000 });
  assert.equal(r.status, 0, `harness rc=${r.status}: ${(r.stderr || '').slice(-400)}`);
  const line = (r.stdout || '').split(/\r?\n/).filter(l => l.trim().startsWith('{"')).pop();
  assert.ok(line, 'u248 harness 未输出 JSON');
  const { notShipped } = JSON.parse(line);
  assert.ok(notShipped, 'u248 harness 缺 not-shipped 用例');
  // 排序口径不同（PS 用文化比较、JS 用码元）⇒ 两侧都按 JS 排序后比集合
  assert.deepEqual([...notShipped.retired].sort(), ['stress-frontend-ui.ps1', '说明书.md'].sort(), `退役集合不对：${JSON.stringify(notShipped.retired)}`);
  for (const keep of ['notes.md', '.env', 'skill-assets.json']) {
    assert.ok(notShipped.remain.includes(keep), `未登记/受保护文件被误删：${keep}`);
  }
});
