// U-278（v1.60.0，B3-7）：**跨平台实跑** —— 记录与文档承诺必须互相对得上。
//
// 病（验收问题 F14）：`SKILL.md` 的 compatibility 写着「Windows PowerShell 5.1 或 PowerShell 7+（pwsh）」，
//   读起来像"跨平台可用"；而事实是：CI 只有 windows-latest、`crossplat.yml` 不存在、
//   **没有任何一次实跑**。文字承诺与实测证据之间隔着一条没人跨过的缝。
//
// 这一批的做法不是"再写一句更谨慎的话"，而是：
//   ① 真的在 Linux 容器里跑一遍（镜像 `SHIMS=0`，不靠别名换绿），落 `reports/crossplat-<日期>-<平台>.json`；
//   ② 让门把 **文档承诺** 与 **有记录的平台集合** 钉成等式 —— 以后谁想加一句"支持 macOS"，
//      必须先有一份 macOS 的绿记录。
//
// 判据（lib/crossplat-record.mjs）分三层：
//   A 纯函数：记录结构与自洽（手写 green 而 productRed=3 必须红）+ verdictOf 三档与优先级
//   B 活体：每份记录都过 A；`跨平台实跑：已验证 …` 的平台集合 === 有记录且 product/meta 全绿 的平台集合
//   C 采集器真能产出：用**一个快门**跑一次 `record()`，证明这条链没断（facts → runGates → JSON）
//
// ★为什么 env 红不算失败、但必须记录：它意味着"这门在这台机器上没跑成"（缺外部二进制/无网络）。
//   当失败 ⇒ Linux 永远验不过；丢掉 ⇒ 撒谎。判定看 product/meta，env 数照抄在记录里。
//
// ★自举顺序（B 的四态）：这一版之前既无记录也无承诺行。若"没有记录"直接判红，
//   第一份记录永远产不出来（产生它的那次跑分会被这道门自己判红）。所以：
//     无记录 + 无承诺 ⇒ 合法起点（打印提示）；一旦有了一边，另一边必须在。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RECORD_SCHEMA, CLAIM_PREFIX, PLATFORM_TOKENS, verdictOf, verifiedPlatforms, checkRecord, parseClaim,
} from './lib/crossplat-record.mjs';
import { record } from './crossplat-run.mjs';
import { hasRepoEvidence } from './lib/reports-quota.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPORTS = path.join(ROOT, 'reports');
const SKILL = path.join(ROOT, 'SKILL.md');
// 安装副本不随包发证据树（B3-6 §9 的口径：证据留仓内，包只装运行时 + 测试套件）。
// 判定锚点是 `reports/provenance/`（只有仓库每次发版才会重生成 Statement），不是 `reports/` 本身 ——
// 副本里那棵是历史遗留的旧 evidence，拿它当"仓库"会把副本判红。
// 跳过与 U-91 的 NO_EVID 同款：不跳过就会把"副本里没有证据"记成"文档撒谎"。
const NO_EVID = !hasRepoEvidence(ROOT);

function loadRecords() {
  if (!fs.existsSync(REPORTS)) return [];
  return fs.readdirSync(REPORTS)
    .filter((f) => /^crossplat-.*\.json$/.test(f))
    .sort()
    .map((f) => ({ file: f, doc: JSON.parse(fs.readFileSync(path.join(REPORTS, f), 'utf8')) }));
}

const TEMPLATE = {
  schema: RECORD_SCHEMA,
  facts: { os: { platform: 'linux', arch: 'x64' }, node: 'v22.0.0', pwsh: { version: '7.4.6' }, caseSensitiveFs: true, pathSeparator: '/' },
  gates: 85, runMode: 'parallel', summary: { productRed: 0, metaRed: 0, envRed: 0 }, verdict: 'green',
};

test('U-278-A: 记录判据真值表 —— verdict 由三个计数算出，结构缺一不可', () => {
  assert.equal(checkRecord(TEMPLATE).ok, true, checkRecord(TEMPLATE).problems.join(' | '));

  // 三种撒谎方式，判据必须每次都咬到
  assert.equal(checkRecord({ ...TEMPLATE, verdict: 'green', summary: { productRed: 3, metaRed: 0, envRed: 0 } }).ok, false,
    '手写 verdict=green 而 productRed=3 必须红');
  assert.equal(checkRecord({ ...TEMPLATE, verdict: 'green', summary: { productRed: 0, metaRed: 2, envRed: 0 } }).ok, false,
    'meta 红被写成 green 同样必须红');
  assert.equal(checkRecord({ ...TEMPLATE, gates: 0 }).ok, false, '0 个门的记录等于没跑');
  const noFacts = { ...TEMPLATE }; delete noFacts.facts;
  assert.equal(checkRecord(noFacts).ok, false, '没有环境事实的记录无法复现，必须红');
  assert.equal(checkRecord({ ...TEMPLATE, summary: { productRed: 0, envRed: 0 } }).ok, false,
    '缺 metaRed 的老记录不可引用（那时的 meta 红被记进了 product）');
  assert.equal(checkRecord({ ...TEMPLATE, facts: { ...TEMPLATE.facts, pwsh: { version: null } } }).ok, false,
    '连解释器版本都没记 ⇒ 红');

  // verdictOf 是纯函数：三档 + 优先级（product > meta > env）
  assert.equal(verdictOf({ productRed: 0, metaRed: 0, envRed: 0 }), 'green');
  assert.equal(verdictOf({ productRed: 0, metaRed: 0, envRed: 2 }), 'env-red');
  assert.equal(verdictOf({ productRed: 0, metaRed: 1, envRed: 5 }), 'meta-red');
  assert.equal(verdictOf({ productRed: 1, metaRed: 1, envRed: 1 }), 'red');
});

test('U-278-B: 活体 —— 每份记录都自洽，且文档承诺 === 有绿记录的平台集合', { skip: NO_EVID && '安装副本没有 reports/：记录类判据只在仓库里跑' }, () => {
  const recs = loadRecords();
  for (const { file, doc } of recs) {
    const r = checkRecord(doc, file);
    assert.equal(r.ok, true, r.problems.join(' | '));
  }

  const skillText = fs.readFileSync(SKILL, 'utf8');
  const hasClaim = skillText.includes(CLAIM_PREFIX);
  const got = verifiedPlatforms(recs.map((r) => r.doc));
  const name = (k) => Object.keys(PLATFORM_TOKENS).find((n) => PLATFORM_TOKENS[n] === k) || k;

  if (!recs.length && !hasClaim) {
    console.error('[U-278] 还没有任何跨平台记录，也没有承诺行 —— 合法起点（一旦落第一份记录，SKILL.md 必须补承诺行）');
    return;
  }
  assert.ok(hasClaim, `有 ${recs.length} 份记录却没有「${CLAIM_PREFIX} …」承诺行 —— 有证据不说，文档就会继续含糊`);

  const claim = parseClaim(skillText);
  for (const p of claim.problems) assert.fail(p);

  const a = [...claim.platforms].sort();
  const b = [...got].sort();
  assert.deepEqual(a, b,
    `SKILL.md 的「${CLAIM_PREFIX}」与记录不一致：文档写 [${a.map(name).join('、') || '（无）'}]，` +
    `实际有绿记录的是 [${b.map(name).join('、') || '（无）'}] —— ` +
    '要么补记录（`node tests/crossplat-run.mjs --profile=installed --out reports/crossplat-<日期>-<平台>.json`），要么改文档');

  // 负向控制：承诺里塞一个没有记录的平台 ⇒ 必须不相等（证明这条断言不是恒真）
  const fake = new Set([...claim.platforms, 'darwin']);
  assert.notDeepEqual([...fake].sort(), b, '承诺里多一个平台却仍然相等 ⇒ 判据没接上');
  // 未识别的平台名必须报出来，不许静默忽略
  const bogus = parseClaim('> ' + CLAIM_PREFIX + ' Windows、Solaris');
  assert.equal(bogus.ok, false);
  assert.match(bogus.problems.join('|'), /无法识别的平台名：Solaris/);
  // 括号后的解释不参与平台解析（否则日期/日志路径会被当成平台名）
  const withNote = parseClaim('> ' + CLAIM_PREFIX + ' Windows、Linux（2026-10-27，日志见 reports/）');
  assert.deepEqual([...withNote.platforms].sort(), ['linux', 'win32'], '括号里的解释被当成平台名了');
});

test('U-278-C: 采集器能真产出 —— 一个快门跑一次 record()，字段必须齐全', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'u278-rec-'));
  const out = path.join(tmp, 'rec.json');
  try {
    const doc = await record({ gates: ['tests/test-u277-reports-ratchet.test.mjs'], mode: 'serial', out });
    assert.ok(fs.existsSync(out), 'record() 没写文件');
    const disk = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(disk.schema, RECORD_SCHEMA);
    assert.equal(disk.gates, 1);
    assert.equal(disk.runMode, 'serial');
    assert.equal(disk.facts.os.platform, process.platform);
    assert.ok(disk.facts.node && disk.facts.pwsh && disk.facts.pwsh.version, 'facts 不齐（跨平台记录的核心就是环境事实）');
    assert.equal(typeof disk.facts.caseSensitiveFs, 'boolean', '文件系统大小写敏感性必须实测并被记下来');
    // 环境事实要与本机一致：这条把"记录是编的"挡在门外
    assert.equal(disk.facts.pathSeparator, path.sep);
    assert.equal(disk.verdict, verdictOf(disk.summary));
    // ★三个计数必须是**整数**：这一条是"假绿"的直接防线。第一版采集器把
    //   `mergeRecheck` 的包装对象当成了 summary，计数全 undefined，而 verdict 的 `?? 0`
    //   把"没有数字"读成了 green —— 单门跑不进复核分支，只有真跑全量才暴露。
    for (const k of ['productRed', 'metaRed', 'envRed']) {
      assert.ok(Number.isInteger(disk.summary[k]), `summary.${k} 必须是整数（实得 ${disk.summary[k]}）—— 记录里没有数字就等于没有结论`);
    }
    // 采的是一条绿门 ⇒ product 必须是 0（否则采集器会把红的门记成绿）
    assert.equal(disk.summary.productRed, 0, '采的是一条绿门，product_red 却是 ' + disk.summary.productRed);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
