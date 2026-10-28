// U-275（v1.57.0，验收 B3-4）：**门的分层记账** —— meta_red / product_red 分列 + 静态断言配额只降不升。
//
// 病在哪（B3-4 前）：
//   · `product_red` 里混着两类完全不同的东西：「引擎崩了」和「隐私文档少登记一个域名」。
//     两者都要修，但看数的人分不出哪条该去查网络、哪条该去改文件；113 个静态门里还有一堆
//     "读源码断言某行存在"的门 —— 它们红了，可能是文件漂了，**也可能是那段防守代码被删了**，
//     证据本身分不出来。这就是静态断言的固有代价，不是实现问题。
//   · 配额没有上限：加一条"源码里有这行"的断言比写行为臂便宜一个数量级，
//     每次改动都小到不值得反对，累积起来就把行为层的占比稀释掉了（B3-3 时行为门 26%）。
//
// 这一批只做两件事，都不改变"能不能发布"：
//   ① `meta_red` 单列（退出码 5）。**仍是红**：`.gate-green.json` 里 product_red 与 meta_red 都必须为 0，
//      发布器拒、凭证判据拒。变的只是"该谁去看"。
//   ② 静态门做成**冻结名单**（tests/static-quota.json）：集合相等 + history 单调不增 + 上限常量。
//      新加静态门 ⇒ 红；把静态门改成行为门 ⇒ 也必须改名单（逼着下调配额）。
//
// 本门分五层：
//   A 配额判据真值表（纯函数，8 例）
//   B 活体：仓里的名单 == 实测分类（这是真正守纪律的那条）
//   C 归类：meta 门红记 meta；静态但未登记的红仍记 product；env 永远优先
//   D 退出码与凭证：product=1 / meta=5 / env=3；凭证拒 meta≠0 与缺字段
//   E 接线：tests/static/ 被枚举；runner 真的把名单传进分区；沙盒里真跑一轮（rc=5 与 rc=1）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { classify, gateFiles, share } from './lib/test-shape.mjs';
import { quotaVerdict, readQuota, countsOf, metaNames, QUOTA_SCHEMA, FROZEN_PRODUCT_STATIC_CEILING } from './lib/static-quota.mjs';
import { repartition, exitCodeFor, META_EXIT } from './gate-partition.mjs';
import { gateGreenVerdict } from './gate-green.mjs';
import { runGates, GATE_FILES, META_FILES } from './run-node-gates.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TESTS = path.join(ROOT, 'tests');
const RUNNER_SRC = fs.readFileSync(path.join(TESTS, 'run-node-gates.mjs'), 'utf8');

/** 仓里实测的静态门 basename 列表 */
function actualStatic() {
  return classify(ROOT).filter((r) => r.shape === 'static').map((r) => r.file.split('/').pop()).sort();
}

test('U-275-A: 配额判据真值表 —— 净增/未下调/越界/meta 未入册，五种走法各自红在哪一句', () => {
  // v1.58.0（U-276）：`meta` 改成 {文件: 理由}；上限压的是 productStatic = static − meta。
  const q = (over = {}) => ({
    schema: QUOTA_SCHEMA,
    static: ['a.test.mjs', 'b.test.mjs', 'c.test.mjs'],
    meta: { 'a.test.mjs': '记账' },
    history: [{ version: '1.0.0', static: 3, meta: 1, productStatic: 2 }],
    ...over,
  });
  const act = (names) => ({ static: names });
  const CEIL = 2;                       // 3 个静态门 − 1 个 meta
  const ALL = ['a.test.mjs', 'b.test.mjs', 'c.test.mjs'];

  // ① 一致 ⇒ 绿
  let r = quotaVerdict(q(), act(ALL), { ceiling: CEIL });
  assert.equal(r.ok, true, r.problems.join(' | '));
  assert.match(r.notes.join('|'), /计入配额 2\/2/);

  // ② 多了一个静态门 ⇒ 点名是哪一个，并说明"要加就先减一个"
  r = quotaVerdict(q(), act([...ALL, 'd.test.mjs']), { ceiling: CEIL });
  assert.equal(r.ok, false);
  assert.match(r.problems.join('|'), /新增静态门没入册：d\.test\.mjs/);
  assert.match(r.problems.join('|'), /只降不升/);

  // ③ 改成行为门但没改名单 ⇒ 报"册上有、实测无"
  r = quotaVerdict(q(), act(['a.test.mjs', 'b.test.mjs']), { ceiling: CEIL });
  assert.equal(r.ok, false);
  assert.match(r.problems.join('|'), /已不存在\/已被升级为行为门：c\.test\.mjs/);

  // ④ history 把**产品静态**配额抬高 ⇒ 红（"今天先改成 3、明天再说"这条路走不通）
  r = quotaVerdict(q({ history: [{ version: '1.0.0', static: 3, meta: 1, productStatic: 2 }, { version: '1.1.0', static: 4, meta: 1, productStatic: 3 }] }),
    act(ALL), { ceiling: CEIL });
  assert.equal(r.ok, false);
  assert.match(r.problems.join('|'), /抬到 3 —— 只许降/);

  // ⑤ 常量与 history[0] 不一致 ⇒ 红（两处记账必须对得上）
  r = quotaVerdict(q(), act(ALL), { ceiling: 99 });
  assert.equal(r.ok, false);
  assert.match(r.problems.join('|'), /≠ 冻结上限 99/);

  // ⑥ meta 不在 static 里 ⇒ 红（不能凭空给一个行为门发 meta 资格）
  r = quotaVerdict(q({ meta: { 'zzz.test.mjs': '凭空' } }), act(ALL), { ceiling: CEIL });
  assert.equal(r.ok, false);
  assert.match(r.problems.join('|'), /meta` 里有门不在 `static` 名单：zzz\.test\.mjs/);

  // ⑦ 没有账本 ⇒ 红（不是"默认通过"）
  assert.equal(quotaVerdict(null, act([])).ok, false);

  // ⑧ 重复项 ⇒ 红（重复会让计数不可信）
  r = quotaVerdict(q({ static: ['a.test.mjs', 'a.test.mjs', 'b.test.mjs'] }), act(['a.test.mjs', 'b.test.mjs']), { ceiling: CEIL });
  assert.equal(r.ok, false);
  assert.match(r.problems.join('|'), /重复/);

  // ⑨ 登记没写理由 ⇒ 红（"把产品门改名叫 meta"必须留下解释）
  r = quotaVerdict(q({ meta: { 'a.test.mjs': '' } }), act(ALL), { ceiling: CEIL });
  assert.equal(r.ok, false);
  assert.match(r.problems.join('|'), /没写理由/);

  // ⑩ ★口径（v1.58.0）：多登记一个 **meta** 门**不占**产品配额 —— 否则每造一个测量工具
  //    都要先删一条产品断言，棘轮会变成"别做度量"的压力。这条钉住它。
  r = quotaVerdict(q({ static: [...ALL, 'meter.test.mjs'], meta: { 'a.test.mjs': '记账', 'meter.test.mjs': '度量自身' },
    history: [{ version: '1.0.0', static: 4, meta: 2, productStatic: 2 }] }), act([...ALL, 'meter.test.mjs']), { ceiling: CEIL });
  assert.equal(r.ok, true, '加 meta 门不该占产品配额：' + r.problems.join(' | '));
});

test('U-275-B: 活体 —— tests/static-quota.json 与实测分类一致（这才是守纪律的那条）', () => {
  const quota = readQuota(ROOT);
  assert.ok(quota, 'tests/static-quota.json 读不到');
  const verdict = quotaVerdict(quota, { static: actualStatic() });
  assert.equal(verdict.ok, true, '\n' + verdict.problems.join('\n'));
  // 上限常量与名单的关系必须自我一致（防止有人只改 JSON 不改常量）
  assert.equal(quota.history[0].productStatic, FROZEN_PRODUCT_STATIC_CEILING, 'history[0].productStatic 必须等于冻结上限常量');
  // meta 的门必须真的是静态门（否则"给行为门发 meta 资格"只差一次改名）
  const shapes = new Map(classify(ROOT).map((r) => [r.file.split('/').pop(), r.shape]));
  for (const m of metaNames(quota)) assert.equal(shapes.get(m), 'static', `${m} 登记为 meta 但它执行产品（行为证据 ⇒ 必须记 product）`);
  // 至少有一条 meta、且 meta ⊂ static：全空的名单会让这套机制变成装饰
  const c = countsOf(quota);
  assert.ok(c.meta > 0, 'meta 名单为空 ⇒ meta_red 永远是 0，等同没做');
  assert.ok(c.meta < c.static, 'meta == static ⇒ 全部静态门都被赦免，这不是分层是放行');
  console.error(`[U-275] 静态 ${c.static} 个（其中 meta ${c.meta}）⇒ 计入配额 ${c.productStatic}/${FROZEN_PRODUCT_STATIC_CEILING}；行为门 ${share(ROOT).behavior}/${share(ROOT).total}`);
});

test('U-275-C: 归类 —— meta 门红记 meta，未登记的静态门仍记 product，env 永远优先', () => {
  const quota = readQuota(ROOT);
  const metaFiles = metaNames(quota);
  const metaGate = path.join(TESTS, [...metaFiles][0]);
  // 找一个"静态但没登记 meta"的门当对照（不是硬编码文件名，避免改名即失效）
  const notMeta = classify(ROOT).find((r) => r.shape === 'static' && !metaFiles.has(r.file.split('/').pop()));
  assert.ok(notMeta, '找不到"静态但未登记 meta"的对照组 —— 说明 meta 已经把全部静态门吃掉了');
  const notMetaAbs = path.join(TESTS, notMeta.file);
  const behaviorAbs = path.join(TESTS, 'behavior', 'engines.test.mjs');

  const red = (file, extra = {}) => ({ name: 'x', file, message: 'boom', ...extra });

  let s = repartition([red(metaGate)], {}, { metaFiles });
  assert.equal(s.metaRed, 1); assert.equal(s.productRed, 0); assert.equal(s.meta[0].cls, 'meta');
  assert.match(s.meta[0].why, /修文件即可/);

  s = repartition([red(notMetaAbs)], {}, { metaFiles });
  assert.equal(s.productRed, 1, '未登记的静态门必须仍记 product（默认不放行）'); assert.equal(s.metaRed, 0);

  s = repartition([red(behaviorAbs)], {}, { metaFiles });
  assert.equal(s.productRed, 1, '行为门红永远是 product'); assert.equal(s.metaRed, 0);

  // ★env 优先：同一句话，环境症状在 meta 门里也必须记 env（"机器没测成" ≠ "文件要改"）
  s = repartition([red(metaGate, { cls: 'env', kind: 'no-network' })], {}, { metaFiles });
  assert.equal(s.envRed, 1); assert.equal(s.metaRed, 0);
  assert.equal(s.envByKind['no-network'], 1);

  // 名单缺省 ⇒ 全部 product（fail-closed）
  s = repartition([red(metaGate)], {}, {});
  assert.equal(s.productRed, 1); assert.equal(s.metaRed, 0);

  // 重分区时漏传名单，已归好的 meta 不许被降级成 product（反方向的假账）
  s = repartition([{ name: 'x', file: metaGate, cls: 'meta', why: 'already' }], {}, {});
  assert.equal(s.metaRed, 1); assert.equal(s.productRed, 0);
});

test('U-275-D: 退出码与凭证 —— product=1 > meta=5 > env=3；凭证拒 meta≠0 与缺字段', () => {
  assert.equal(exitCodeFor({ productRed: 1, metaRed: 1, envRed: 1 }, 0), 1, 'product 最强，不许被 meta 降级');
  assert.equal(exitCodeFor({ productRed: 0, metaRed: 1, envRed: 0 }, 0), META_EXIT);
  assert.equal(META_EXIT, 5, '5 是设计文档 §5 指定的 meta 退出码（避开产品 4=degraded）');
  assert.equal(exitCodeFor({ productRed: 0, metaRed: 0, envRed: 2 }, 1), 3);
  assert.equal(exitCodeFor({ productRed: 0, metaRed: 0, envRed: 0 }, 0), 0);
  assert.equal(exitCodeFor({ productRed: 0, metaRed: 0, envRed: 0 }, 7), 1, '子进程非 0 无可归类红 ⇒ product');

  const base = {
    schema: 'mcps/gate-green/1', version: '1.2.3', versionAtStart: '1.2.3', versionAtEnd: '1.2.3',
    runMode: 'serial', productRed: 0, metaRed: 0, envRed: 0, voided: false, finishedAt: new Date().toISOString(),
  };
  assert.equal(gateGreenVerdict(base, { version: '1.2.3' }).ok, true);
  assert.equal(gateGreenVerdict({ ...base, metaRed: 1 }, { version: '1.2.3' }).ok, false, 'meta 红不是绿');
  assert.equal(gateGreenVerdict({ ...base, metaRed: undefined }, { version: '1.2.3' }).ok, false, '缺字段必须拒（fail-closed）');
});

test('U-275-E: 接线 —— tests/static/ 被枚举、runner 用同一份枚举与名单、沙盒里真跑出 rc=5/rc=1', async () => {
  // ① 枚举：设计文档 §5 说"静态检查放 tests/static/"，那就必须真的会被跑到（B3-3 的老坑：
  //    写了一批永远不会执行的门）。用临时根目录验证，不动仓。
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'u275-enum-'));
  try {
    fs.mkdirSync(path.join(tmp, 'tests', 'static'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'tests', 'behavior'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'tests', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'tests', 'test-top.test.mjs'), '// top\n');
    fs.writeFileSync(path.join(tmp, 'tests', 'static', 'x.static.test.mjs'), '// static\n');
    fs.writeFileSync(path.join(tmp, 'tests', 'behavior', 'y.test.mjs'), '// behavior\n');
    fs.writeFileSync(path.join(tmp, 'tests', 'lib', 'helper.test.mjs'), '// lib 里的不是门\n');
    fs.writeFileSync(path.join(tmp, 'tests', 'notes.mjs'), '// 不是门\n');
    const got = gateFiles(tmp).map((p) => path.relative(path.join(tmp, 'tests'), p).replace(/\\/g, '/')).sort();
    assert.deepEqual(got, ['behavior/y.test.mjs', 'static/x.static.test.mjs', 'test-top.test.mjs'], '枚举必须收 static/，且不把 lib/ 与普通 .mjs 当门');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }

  // ② 真仓：runner 的枚举里必须有 static/（现在还没有文件，所以断言的是"枚举函数被用上了"）
  assert.match(RUNNER_SRC, /gateFiles\(root\)/, 'runner 必须用 lib/test-shape 的唯一枚举（两份 readdir 必然漂移）');
  assert.ok(GATE_FILES.length >= 150, `runner 枚举到 ${GATE_FILES.length} 个门（>=150）`);
  assert.ok(META_FILES.size > 0, 'runner 没读到 meta 名单 ⇒ 本轮所有红都会记 product（U-275 失效）');
  assert.match(RUNNER_SRC, /summarize\(report, events, \{ metaFiles: metaSet \}\)/, '首跑的分区必须带名单');
  assert.match(RUNNER_SRC, /mergeRecheck\(first, recheck, \{ metaFiles/, '复核重分区必须带名单（漏传 ⇒ meta 红被降级成 product）');

  // ③ 沙盒真跑：两个都会失败的门，一个登记为 meta、一个不登记。
  //    断言的不是"归类的实现"，而是"整条链（reporter → summarize → 退出码）真的按登记走"。
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'u275-run-'));
  try {
    fs.mkdirSync(path.join(sb, 'tests'), { recursive: true });
    const mk = (name) => {
      const f = path.join(sb, 'tests', name);
      fs.writeFileSync(f, "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('boom', () => { assert.equal(1, 2, 'U275FX boom'); });\n");
      return f;
    };
    const metaGate = mk('test-meta-x.test.mjs');
    const prodGate = mk('test-prod-y.test.mjs');
    const quiet = { cwd: sb, stdio: 'pipe', env: { ...process.env, NODE_OPTIONS: '', U153_NETWORK: 'online' } };

    const both = await runGates({ files: [metaGate, prodGate], metaFiles: new Set(['test-meta-x.test.mjs']), ...quiet });
    assert.equal(both.summary.metaRed, 1, both.output.slice(-600));
    assert.equal(both.summary.productRed, 1, both.output.slice(-600));
    assert.equal(both.rc, 1, 'product 与 meta 同时红 ⇒ 1（product 优先）');

    const metaOnly = await runGates({ files: [metaGate], metaFiles: new Set(['test-meta-x.test.mjs']), ...quiet });
    assert.equal(metaOnly.summary.metaRed, 1, metaOnly.output.slice(-600));
    assert.equal(metaOnly.summary.productRed, 0);
    assert.equal(metaOnly.rc, META_EXIT, '只有 meta 红 ⇒ 5（红，但不是产品结论）');

    const asProduct = await runGates({ files: [metaGate], metaFiles: new Set(), ...quiet });
    assert.equal(asProduct.summary.productRed, 1, '不登记就必须回落到 product（默认不放行）');
    assert.equal(asProduct.rc, 1);
  } finally { fs.rmSync(sb, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
