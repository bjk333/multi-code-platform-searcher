// U-251（v1.53.26，B1-4 收口）：**整轮墙钟兜底** —— 门禁可以红，但不许无限等。
//
// 病灶（2026-10-25 本会话实测，反复四次，每次停在不同位置）：
//   `node --test` 为**每个测试文件**起一个子进程；某文件的用例全部完成后，若进程因未释放的 handle 不退，
//   **主 runner 会一直等它**。`--test-force-exit` 只作用于主 runner，**不传给每文件的子进程** ⇒ 治不了。
//   证据链：日志停在 256 / 337 / 477 个 ✔ 处不动 ≥7 分钟；卡住的 pid CPU 零增长、无子进程；
//   而被指认的文件单跑全部是秒级全绿（`test-u132` 2.8s / `test-u175` 0.5s）。
//   ⇒ 结论：这不是"某条门慢"，是 **worker 不退**；不能靠逐个修测试来保证，必须有整轮兜底。
//
// 本门验四件事（缺一条都会让兜底变成摆设）：
//   A 真的会停：一个"永不完成的用例"必须在墙钟到点后被杀，而不是被等到天荒地老；
//   B 不冒充绿：`summary.hung === true` 且 `productRed >= 1` 且 `rc === 1`；
//   C 本轮作废：`summary.voided === true` —— 否则残缺的一轮会产出**可引用**的 `.gate-green.json`；
//   D 跨复核传播：`mergeRecheck` 不得在重分区时把 `voided`/`hung` 洗掉（它 `...extra` 造新对象，
//     漏传就等于"复核把一轮不完整的测量洗成了干净 summary"）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runGates, mergeRecheck } from './run-node-gates.mjs';

// ★探针设计的一次修正（留作教训）：第一版用 `test('永不完成', () => new Promise(() => {}))`，
//   结果 runGates 380ms 就返回、hung=false —— 因为 **node 对 pending Promise 不等**：它当作"没有活跃测试"，
//   直接 rc=1 退出（实测：带/不带 `--test-force-exit` 都是 rc=1 / pass 1 / fail 0）。
//   同理，`setTimeout(()=>{},600000)` 这类 handle 泄漏也被 `--test-force-exit` 吞掉了（多文件 worker 也生效，实测 rc=0）。
//   ⇒ 想稳定地触发"整轮超墙钟"，只能用**真的会跑很久的用例**，并把墙钟设得比它短。
//   这也说明 U-251 兜的是**最后一道防线**：它不该被日常用到，但一旦用到必须判红而不是冒充绿。
const PROBE = `import test from 'node:test';
test('慢用例：5 秒', async () => { await new Promise(r => setTimeout(r, 5000)); });
`;

test('U-251-E: 并发可压缩且必须被记账（32 核 × 全部门文件 ⇒ node 默认开 32 个 worker）', () => {
  const ROOT = path.resolve(import.meta.dirname, '..');
  const runner = fs.readFileSync(path.join(ROOT, 'tests/run-node-gates.mjs'), 'utf8');
  const gg = fs.readFileSync(path.join(ROOT, 'tests/gate-green.mjs'), 'utf8');
  // 为什么这条断言必须存在：挂住的位置每次都不同、单跑永远复现不了 —— 而"并发数"是唯一
  //   在该事故里被忽略的变量（本机 32 核，node 默认就开 32 个 worker，每个还可能再 spawn pwsh）。
  assert.match(runner, /U153_CONCURRENCY/, '必须有并发放开/收紧的入口（环境变量 + 形参）');
  assert.match(runner, /--test-concurrency=\$\{conc\}/, 'conc 必须真的传给 node（只记变量不发参数 = 摆设）');
  assert.match(runner, /summary\.concurrency = conc > 0 \? conc : null/, '实际并发必须记进 summary');
  assert.match(gg, /concurrency: summary\.concurrency \?\? null/, '凭证必须记录并发（否则 32 并发的绿与 4 并发的绿长得一样）');
  // 默认必须有上限（2026-10-26 实测：32 核 ⇒ 32 worker ⇒ 四次挂在 256/326/337/477 个 ✔；压到 4 才跑完）
  assert.match(runner, /Math\.min\(4, Math\.max\(1, os\.cpus\(\)\.length \|\| 1\)\)/,
    '默认并发必须封顶（不封顶 = 核数，本机 32 核实测必挂）');
  assert.doesNotMatch(runner, /\?\s*32\b/, '不得把 32 写成默认值（那是"核数"，不是"可用的并发"）');
});

test('U-251-A/B/C: 整轮超墙钟 ⇒ 杀进程树 + 判红 + 作废，且不被无限等', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u251-'));
  const slow = path.join(dir, 'hang.test.mjs');
  fs.writeFileSync(slow, PROBE, 'utf8');
  const sw = Date.now();
  let r;
  try {
    r = await runGates({ files: [slow], stdio: 'pipe', env: { ...process.env, NODE_OPTIONS: '', U153_MAX_WALL_MS: '1200' } });
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { }
  }
  const ms = Date.now() - sw;
  assert.ok(ms < 60000, `必须在墙钟到点后很快返回，实际等了 ${ms}ms（兜底没生效）`);
  assert.equal(r.hung, true, '必须标记 hung=true（否则调用方看不出"这轮没跑完"）');
  assert.equal(r.summary.voided, true, '挂住的一轮必须 voided=true（否则残缺读数会被写进 gate-green 并被发布引用）');
  assert.ok(r.summary.productRed >= 1, `必须进 product 账，实得 productRed=${r.summary.productRed}（不许冒充绿）`);
  assert.equal(r.rc, 1, `rc 必须是 1，实得 ${r.rc}`);
  assert.ok(r.summary.product.some(p => /hung/.test(String(p.name))), '红项里必须有一条具名的 "gate run hung"');
  assert.match(String(r.summary.product.find(p => /hung/.test(String(p.name))).why), /不完整|不可引用/, 'why 必须说清"不完整/不可引用"，不能只说超时');
});

test('U-251-D: 复核重分区不得洗掉 voided / hung / concurrency', () => {
  const first = {
    code: 1, signal: null, hung: true,
    summary: { runMode: 'parallel', voided: true, hung: true, concurrency: 4, productRed: 1, envRed: 0, envByKind: {},
      product: [{ name: 'gate run hung', file: 'x.test.mjs', cls: 'product', why: 'x' }], env: [] },
  };
  const merged = mergeRecheck(first, { summary: { product: [{ name: 'gate run hung', file: 'x.test.mjs', cls: 'product', why: 'x' }], env: [], envByKind: {} }, code: 1 });
  assert.equal(merged.summary.voided, true, 'voided 被重分区洗掉了 —— 复核会把不完整的一轮变成可引用凭证');
  assert.equal(merged.summary.hung, true, 'hung 被重分区洗掉了');
  // ★2026-10-26 实测漏过这一条：`--test-concurrency=4` 跑完，凭证里却是 `concurrency: null` ——
  //   因为 repartition 是新造对象，漏传即丢。而这条断言当时只挑了 voided/hung 两个"代表"。
  //   教训：断言"不得洗掉字段"时不要挑代表作 —— 漏掉的正好是没被挑中的那个。
  assert.equal(merged.summary.concurrency, 4, 'concurrency 被重分区洗掉了');
  assert.equal(merged.summary.runMode, 'parallel+serial-recheck', 'runMode 仍应标为复核后');
});
