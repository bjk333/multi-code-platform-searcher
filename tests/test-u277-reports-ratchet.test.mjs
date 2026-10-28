// U-277（v1.60.0，B3-6 欠账收口）：**证据目录棘轮** —— `reports/` 只许降。
//
// 病在哪（B3-6 之后仍然存在）：
//   B3-6 把 2,071 个过程产物移到外部归档，仓内留 541 —— 但**没有任何东西阻止它长回去**。
//   实测：B3 这一批自己写了 4 张全量门日志，每跑一次 +1；而且全仓**没有一行代码写 reports/**
//   （`grep writeFileSync.*reports` 为空），全是人工重定向 ⇒ 没有任何机制会因为"又多了一张"而响。
//   没有棘轮，541 只是那一天的快照，不是上界。
//
// 判据在 `lib/reports-quota.mjs`，本门分四层：
//   A 真值表（纯函数，10 例）：越界 / 超字节 / **上限离开现实太远** / history 抬高 / 常量漂移 / 末条不符 / 缺账本
//   B 活体：仓里实测 == 账本（这一层才是真守纪律的）
//   C 收紧链：归档一批 ⇒ 必须下调 cap（否则红）⇒ 下调后绿 ⇒ 想抬回去 ⇒ 红
//   D 负向控制（用真实数字）：cap 比现实少 1 ⇒ 必须红
//
// ★为什么"上限离开现实太远"也要红（第 ② 条互锁）：
//   只写 `total ≤ cap` 的话，`cap = 99999` 是一次性动作，之后永远绿 —— 那是**装饰**，不是棘轮。
//   要求 `cap − total ≤ 8`，天花板就必须贴着现实走：真减了却不下调 ⇒ 红；于是每减一次，
//   棘轮自己往下走一格。这条同时堵住了"反正还有余量"这个念头。
//
// ★它**不**管什么：某个具体证据文件还在不在。那是 U-91 索引门的活（规则块必须命中仓内文件）。
//   本门只管总量 —— "该留哪些"是人的判断，"总量有没有失控"是能算的。两件事分开，各自可审。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  scan, reportsVerdict, readLedger, hasRepoEvidence, REPORTS_SCHEMA, REPORTS_REL,
  FROZEN_FILES, FROZEN_BYTES, MAX_HEADROOM_FILES, MAX_HEADROOM_BYTES,
} from './lib/reports-quota.mjs';
import { gateFiles } from './lib/test-shape.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 安装副本不随包发证据树（发布清单里 reports/ 条目为 0）⇒ 这条棘轮只对**仓库**有意义。
// 不跳过的话，副本里那 250 个历史遗留证据文件会被当成"仓库膨胀了"，而那是环境差异。
const SKIP = !hasRepoEvidence(ROOT) && '安装副本没有仓库证据树（reports/provenance/）：总量棘轮只在仓库里跑';

/** 造一份合法账本；over 覆盖 cap / history，便于逐条打靶 */
const ledger = (over = {}) => {
  const cap = { files: FROZEN_FILES, bytes: FROZEN_BYTES, ...(over.cap || {}) };
  return {
    schema: REPORTS_SCHEMA,
    cap,
    history: over.history || [{ version: '1.60.0', files: cap.files, bytes: cap.bytes }],
  };
};
// ★夹具也必须"贴着上限"：默认 bytes 若给个小数字，会被第 ② 条判据（上限离开现实太远）打红 ——
//   这是它第一次咬人，咬的是我自己写的夹具，不是产品。留着这条注释：夹具不真实时，红的是夹具。
const actual = (files, bytes = FROZEN_BYTES - 4096, dirs = { gates: files }) => ({ files, bytes, dirs });

test('U-277-A: 配额真值表 —— 十种走法各自红在哪一句（含"上限离开现实太远"）', { skip: SKIP }, () => {
  // ① 贴着上限 ⇒ 绿
  let r = reportsVerdict(actual(FROZEN_FILES), ledger());
  assert.equal(r.ok, true, r.problems.join(' | '));

  // ② 多一个文件 ⇒ 点名"要加就先外置同量的旧证据"
  r = reportsVerdict(actual(FROZEN_FILES + 1), ledger());
  assert.equal(r.ok, false);
  assert.match(r.problems.join('|'), /个 > 上限/);
  assert.match(r.problems.join('|'), /先把同量的旧证据外置/);

  // ③ 文件数没超但字节超了 ⇒ 另一条轴（"合并成一个大文件"不算瘦身）
  r = reportsVerdict(actual(FROZEN_FILES - 2, FROZEN_BYTES + 1), ledger());
  assert.equal(r.ok, false);
  assert.match(r.problems.join('|'), /B > 上限/);
  assert.match(r.problems.join('|'), /两个轴分开记/);

  // ④ ★关键：真减了但不下调上限 ⇒ 红（否则 cap=99999 之后永远绿）
  r = reportsVerdict(actual(500, 1000), ledger());
  assert.equal(r.ok, false, '归档 48 个却没下调 cap，必须红');
  assert.match(r.problems.join('|'), /上限比现实高 48 个/);
  assert.match(r.problems.join('|'), /请把 cap 调到 500~508/);

  // ⑤ history 抬高 ⇒ 红（"今天先抬到 600"）
  r = reportsVerdict(actual(500), ledger({ cap: { files: 600 }, history: [{ version: 'a', files: 500, bytes: FROZEN_BYTES }, { version: 'b', files: 600, bytes: FROZEN_BYTES }] }));
  assert.equal(r.ok, false);
  assert.match(r.problems.join('|'), /抬到 600/);

  // ⑥ 首条 ≠ 冻结常量 ⇒ 红（改数据不改代码）
  //    注意 shape：`[600, 548]` 是**合法下降**，`cap=548` 与末条一致，唯一的毛病就是首条漂了 ——
  //    这样才能证明 ④ 那条互锁单独生效，而不是被"单调/末条"顺带抓出来。
  r = reportsVerdict(actual(FROZEN_FILES), ledger({
    cap: { files: FROZEN_FILES },
    history: [{ version: 'a', files: 600, bytes: FROZEN_BYTES }, { version: 'b', files: FROZEN_FILES, bytes: FROZEN_BYTES }],
  }));
  assert.equal(r.ok, false);
  assert.match(r.problems.join('|'), /≠ 冻结常量/);

  // ⑦ 末条 ≠ cap ⇒ 红（改了 cap 不记账）
  //    shape：history 只有首条（= 常量，合法），cap 却写成 547 —— 唯一毛病是"改上限没留痕"。
  r = reportsVerdict(actual(FROZEN_FILES), ledger({
    cap: { files: FROZEN_FILES - 1 },
    history: [{ version: 'a', files: FROZEN_FILES, bytes: FROZEN_BYTES }],
  }));
  assert.equal(r.ok, false);
  assert.match(r.problems.join('|'), /末条 files=.* ≠ cap\.files/);

  // ⑧ 没有账本 ⇒ 红（不是"默认通过"）
  assert.equal(reportsVerdict(actual(0), null).ok, false);

  // ⑨ schema 不认识 ⇒ 红
  r = reportsVerdict(actual(FROZEN_FILES), { ...ledger(), schema: 'other/1' });
  assert.equal(r.ok, false);
  assert.match(r.problems.join('|'), /schema 不认识/);

  // ⑩ history 空 ⇒ 红
  r = reportsVerdict(actual(FROZEN_FILES), ledger({ history: [] }));
  assert.equal(r.ok, false);
  assert.match(r.problems.join('|'), /history` 至少一条/);

  // 上限必须非负整数（`-1` 或 `"548"` 都别想过）
  r = reportsVerdict(actual(0), ledger({ cap: { files: -1 } }));
  assert.equal(r.ok, false);
  assert.match(r.problems.join('|'), /非负整数/);
});

test('U-277-B: 活体 —— 仓内实测 == 账本，且账本上限 == 代码常量', { skip: SKIP }, () => {
  const a = scan(ROOT);
  const led = readLedger(ROOT);
  assert.ok(led, `读不到 ${REPORTS_REL}`);
  const r = reportsVerdict(a, led);
  assert.equal(r.ok, true, r.problems.join(' | '));
  // ★两处记账对得上：常量钉的是 **history[0]**（冻结时的读数），
  //   不是当前 cap —— 下调 cap 是棘轮该走的路（本批就调过：548→546），
  //   把它写成“必须等于常量”等于把棘轮钉死在冻结那一天。
  assert.equal(led.history[0].files, FROZEN_FILES, 'history[0].files 与 FROZEN_FILES 不一致');
  assert.equal(led.history[0].bytes, FROZEN_BYTES, 'history[0].bytes 与 FROZEN_BYTES 不一致');
  // 改上限必须留痕：cap 必须等于 history 末条
  assert.equal(led.cap.files, led.history[led.history.length - 1].files, 'cap.files 必须等于 history 末条');
  // 余量按**当前 cap**算（不是冻结常量）：棘轮要求上限贴着现实，而"现实"在下调后就变了。
  assert.ok(led.cap.files - a.files <= MAX_HEADROOM_FILES, '余量超了：真的减了就该下调 cap');
  assert.ok(led.cap.bytes - a.bytes <= MAX_HEADROOM_BYTES, '字节余量超了：同样要下调 cap.bytes');
  // 冻结时的读数只解释来源，不参与判据；但它必须 ≥ 当时的 cap（否则记账时就已经超了）
  if (led.measuredAtFreeze) {
    assert.equal(led.measuredAtFreeze.files, 542, '冻结读数被改了（它只是"当时多少"，改它等于抹掉起点）');
    assert.ok(led.measuredAtFreeze.files <= led.cap.files);
  }
  for (const n of r.notes) console.error('[U-277] ' + n);
});

test('U-277-C: 收紧链 —— 归档一批必须下调上限，下调后绿，想抬回去必须红', { skip: SKIP }, () => {
  // 起点：贴着上限
  const a0 = actual(FROZEN_FILES);
  assert.equal(reportsVerdict(a0, ledger()).ok, true);

  // 归档 40 个（B3-6 那种操作的日常版）
  const a1 = actual(FROZEN_FILES - 40);
  let r = reportsVerdict(a1, ledger());
  assert.equal(r.ok, false, '减了不下调 = 白减（cap 变成永久余量）');

  // 按提示下调并追加 history ⇒ 绿
  const lowered = {
    ...ledger(),
    cap: { files: a1.files, bytes: FROZEN_BYTES },
    history: [
      { version: '1.60.0', files: FROZEN_FILES, bytes: FROZEN_BYTES },
      { version: '1.61.0', files: a1.files, bytes: FROZEN_BYTES },
    ],
  };
  r = reportsVerdict(a1, lowered);
  assert.equal(r.ok, true, r.problems.join(' | '));

  // ★抬回去：单调不增，必须红
  const raised = {
    ...lowered,
    cap: { files: FROZEN_FILES, bytes: FROZEN_BYTES },
    history: [...lowered.history, { version: '1.62.0', files: FROZEN_FILES, bytes: FROZEN_BYTES }],
  };
  r = reportsVerdict(actual(FROZEN_FILES), raised);
  assert.equal(r.ok, false);
  assert.match(r.problems.join('|'), /抬到 548|抬到/);

  // 新的这一格可以继续往下降（棘轮单向），但降完同样要贴住现实
  const lowered2 = {
    ...lowered,
    cap: { files: a1.files - 60, bytes: FROZEN_BYTES },
    history: [...lowered.history, { version: '1.62.0', files: a1.files - 60, bytes: FROZEN_BYTES }],
  };
  assert.equal(reportsVerdict(actual(a1.files - 60), lowered2).ok, true);
});

test('U-277-D: 负向控制 —— 用真实读数把上限压到现实之下，判据必须真的咬', { skip: SKIP }, () => {
  const a = scan(ROOT);
  const led = readLedger(ROOT);
  assert.ok(a.files > 0, '扫不到 reports/ 里的任何文件：scan 坏了，那么"绿"没有意义');
  // 只把上限少写 1（其它全合法），必须红 —— 证明今天的绿不是"还有余量"换来的
  const tight = { ...led, cap: { ...led.cap, files: a.files - 1 } };
  tight.history = [{ ...led.history[0], files: a.files - 1 }];
  const r = reportsVerdict(a, tight);
  assert.equal(r.ok, false, '上限比现实少 1 却还是绿 ⇒ 判据没接上');
  assert.match(r.problems.join('|'), /个 > 上限/);

  // 接线：本门必须在 runner 的枚举里（不在 = 写了永远不跑的门）
  const listed = gateFiles(ROOT).map((p) => path.basename(p));
  assert.ok(listed.includes('test-u277-reports-ratchet.test.mjs'), 'U-277 没被 runner 枚举 ⇒ 这道棘轮不存在');
  assert.ok(fs.existsSync(path.join(ROOT, REPORTS_REL)), `${REPORTS_REL} 不在仓里`);
});
