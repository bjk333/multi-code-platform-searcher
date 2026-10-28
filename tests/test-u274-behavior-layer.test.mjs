// U-274（B3-3）：行为层自身的守门人 —— 三件事必须被钉住，否则这一层会退化成"看起来有行为测试"。
//
//   ① 接线：`tests/behavior/*.test.mjs` 必须真的在 runner 的枚举里。门写了没人跑，是最常见的一种假绿
//      （本仓有过先例：新门随包发出去，但 runner 只扫 `tests/test-*`）。
//   ② 尺子：行为/静态的分类判据必须能被四个人造样例验证 —— 判据自己腐烂时，占比会变成自欺的数字。
//   ③ 棘轮：行为门数量与占比**只许升**。目标 50%，当前远低于它；把"现在还差多少"写进断言，
//      比在报告里写一句"继续努力"有用。
//
// 另附一条结构断言：每个引擎的 case 必须三臂齐全（ok/zero/fail），且函数名在加载后视图里真的存在
//   —— 防止"表里写了引擎、产品里改名的函数"这种静默跳过。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GATE_FILES } from './run-node-gates.mjs';
import { share, executesProduct } from './lib/test-shape.mjs';
import { CASES } from './behavior/lib/cases.mjs';
import { CASES2 } from './behavior/lib/cases-2.mjs';
import { CASES3 } from './behavior/lib/cases-3.mjs';
import { CASES4 } from './behavior/lib/cases-4.mjs';
import { sourceAll } from './lib/source.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('U-274-D 接线：runner 的枚举里必须有 tests/behavior/*.test.mjs', () => {
  const beh = GATE_FILES.filter((f) => /[\\/]behavior[\\/].*\.test\.mjs$/.test(f));
  assert.ok(beh.length >= 1, 'runner 没把 tests/behavior/ 收进来 —— 行为门写了也不会被执行');
});

test('U-274-E 尺子自检：四段人造样例（两行为两静态）+ 一层导入追踪', () => {
  // 行为：dot-source 约定
  assert.equal(executesProduct("$env:MCPS_NO_MAIN = '1'\n. $main -NoEnvFile"), true, 'dot-source 产品必须判 behavior');
  // 行为：CLI 约定
  assert.equal(executesProduct("spawn('pwsh', ['-NoProfile', '-File', MAIN, '-Keyword', 'x', '-AsJson'])"), true, '跑 CLI 必须判 behavior');
  // 静态：只是"提到"这个字符串（u100-d1 就是这种：它在源码里搜这句话）
  assert.equal(executesProduct("const gi = src.indexOf(\"if (-not $env:MCPS_NO_MAIN\");"), false, '只提到 MCPS_NO_MAIN 不算执行');
  // 静态：spawn 一个只解析 AST 的探针
  assert.equal(executesProduct("const r = spawn('pwsh', ['-File', audit, '-Path', 'multi-platform-searcher.ps1']);"), false, '只解析源码必须判 static');

  // ★v1.63.0（U-281）：判据 ⑤ —— 经**执行器**执行产品。
  //   `engines*.test.mjs` 自己既不 dot-source 也不 spawn：它 import 的 `lib/define.mjs` 才 spawn。
  //   只认"直接 import 探针"的话，这些入口全被判成静态（实测漏了两个），占比被系统性低估。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u281-ruler-'));
  try {
    fs.mkdirSync(path.join(dir, 'lib'));
    fs.writeFileSync(path.join(dir, 'lib', 'engine-probe.mjs'), "export const runEngine = 1;\n");
    fs.writeFileSync(path.join(dir, 'lib', 'define.mjs'), "import { runEngine } from './engine-probe.mjs';\nexport const x = runEngine;\n");
    fs.writeFileSync(path.join(dir, 'via-executor.test.mjs'), "import { x } from './lib/define.mjs';\n");
    fs.writeFileSync(path.join(dir, 'inert.mjs'), "export const y = 1;\n");
    fs.writeFileSync(path.join(dir, 'via-inert.test.mjs'), "import { y } from './inert.mjs';\n");
    assert.equal(executesProduct(fs.readFileSync(path.join(dir, 'via-executor.test.mjs'), 'utf8'), dir), true,
      '只 import 执行器（不直接 import 探针）也必须判 behavior');
    assert.equal(executesProduct(fs.readFileSync(path.join(dir, 'via-inert.test.mjs'), 'utf8'), dir), false,
      'import 一个不执行产品的模块仍判 static —— 否则"认识执行产品的人"会被算成"执行产品"');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('U-274-F 三臂齐全：每个引擎都有 ok/zero/fail，且函数在加载后视图里存在', () => {
  const src = sourceAll(ROOT);
  // v1.62.0（U-280）：第三批是**传输方式不同**的三个（MCP JSON-RPC+SSE / AND 语义 JSON / 两请求串联）；
  //   LocalCode 不走这张表（它没有网络请求，执行器那套"必须有 hits"的通则不适用），由 engines3 里五条自证。
  // v1.63.0（U-281）：第四批把最后三个"同形"引擎也接了进来 —— 实跑后它们并不与已覆盖者同形
  //   （SSE 双字段 / 多取后客户端重排 / POST 仓库级），详情见 cases-4.mjs 头注。
  const ALL = [...CASES, ...CASES2, ...CASES3, ...CASES4];
  assert.ok(ALL.length >= 21, `至少要覆盖 21 个引擎，实得 ${ALL.length}`);
  for (const c of ALL) {
    assert.match(c.fn, /^Search-[A-Za-z]+$/, `${c.name}: 函数名形状`);
    assert.ok(src.includes(`function ${c.fn} {`), `${c.name}: 产品里找不到 ${c.fn}（改名了？）`);
    for (const arm of ['ok', 'zero', 'fail']) {
      assert.ok(Array.isArray(c[arm]) && c[arm].length >= 1, `${c.name}: ${arm} 臂缺夹具路由`);
      assert.ok(c.expect && c.expect[arm], `${c.name}: ${arm} 臂缺判据`);
    }
    assert.ok(c.expect.ok.count >= 1, `${c.name}: 成功臂必须至少断言 1 条结果`);
    assert.equal(c.expect.zero.count, 0, `${c.name}: 零命中臂必须断言 0 条`);
    assert.equal(c.expect.fail.count, 0, `${c.name}: 失败臂必须断言 0 条`);
    // "你问了什么"那一半：URL 或**正文**。POST 类引擎（JSON-RPC）的问题全在 body 里 ——
    //   只要求 urlHas 会逼着人为一个永远为空的列表写占位符，那比不写更糟。
    const asked = [...(c.expect.ok.urlHas || []), ...(c.expect.ok.bodyHas || [])];
    assert.ok(asked.length >= 1, `${c.name}: 成功臂必须断言请求参数（URL 或正文，"你问了什么"那一半）`);
  }
});

test('U-274-G 棘轮：行为门数量与占比只许升（当前读数见断言消息）', async () => {
  const s = share(ROOT);
  const { readQuota, countsOf, FROZEN_PRODUCT_STATIC_CEILING } = await import('./lib/static-quota.mjs');
  const c = countsOf(readQuota(ROOT));
  const msg = `行为门 ${s.behavior}/${s.total} = ${(s.ratio * 100).toFixed(1)}%；` +
    `对产品下断言的门里：${s.behavior}/(${s.behavior}+${c.productStatic}) = ${((s.behavior / (s.behavior + c.productStatic)) * 100).toFixed(1)}%（目标 50%）`;
  // v1.57.0（B3-4）：占比下限 = 两个冻结常数的商，不是手调的小数。
  // v1.58.0（B3-5）：分母改成 **行为 + 产品静态**（`meta` 门不计）—— 测量/记账工具有自己的配额，
  //   把它们算进分母，等于"每造一个测量工具就压低一次覆盖率"，方向是错的。
  //   ★两个读数都打在消息里：总占比（${s.total} 为分母）仍可见，改口径不是为了让数字好看。
  // v1.63.0（U-281）：44 —— 新增 engines4，另有两个**一直就在跑产品**的入口（engines/engines2）
  //   被尺子漏判成静态（它们只 import 执行器，不直接 import 探针）⇒ 尺子补了一层导入追踪，两个归位。
  // v1.68.0（U-286）：49 —— U-182/U-115 两条**主流程**静态门改写成 CLI 级行为门（跑整个产品，离线回放），
  //   另加 replay-seam（回放接缝保真性）。不是拆文件凑数：三条各自的断言都换成了"本次运行的产品输出"。
  // v1.70.0（U-288）：53 —— T2-8（规划器判词）、T2-7（Gitee 相关度地板）、T1-5（源码优先/文档兜底）
  //   三条静态门改跑产品：规划器真跑 6 次、Gitee 加 2 条夹具臂、T1-5 走 CLI 离线回放。
  const BEHAVIOR_FLOOR = 53;
  assert.ok(s.behavior >= BEHAVIOR_FLOOR, `${msg}；行为门数量不得低于 ${BEHAVIOR_FLOOR}（只许升）`);
  const floor = BEHAVIOR_FLOOR / (BEHAVIOR_FLOOR + FROZEN_PRODUCT_STATIC_CEILING);
  const productRatio = s.behavior / (s.behavior + c.productStatic);
  assert.ok(productRatio >= floor - 1e-9,
    `${msg}；对产品的行为占比不得低于 ${(floor * 100).toFixed(2)}%（= ${BEHAVIOR_FLOOR}/(${BEHAVIOR_FLOOR}+${FROZEN_PRODUCT_STATIC_CEILING})，只许升）`);
  // 静态全量（含 meta）也必须被记账：万一有人把产品门登记成 meta 来"降分母"，
  //   productStatic 会掉、总静态不会掉 —— 这条把总量钉住（U-275 的集合相等是第二道）。
  assert.equal(c.static, s.total - s.behavior, '总静态门数必须等于 总数 − 行为数（分类器与账本不许各说各话）');
});

test('U-274-H 全覆盖：engines/ 里每个 Search-* 都必须被某条行为用例点名', () => {
  // 为什么需要这条：U-274-F 只数**表内**引擎（cases*.mjs），而封套类（engines5/6）与 LocalCode
  //   是独立文件、不进表 ⇒ "覆盖了 24 个"其实没人算得出来。这条从**产品侧**枚举函数名，
  //   要求每个名字都在行为层的某处以字面量出现（表里的 `fn:` 或直接调用的函数名）。
  const src = sourceAll(ROOT);
  const fns = [...src.matchAll(/^function (Search-[A-Za-z]+)/gm)].map((m) => m[1]);
  // 反向保证：正则若因改名/换行匹配不到，fns 会变空 ⇒ 下面的断言会"全绿"。所以先钉住规模。
  assert.ok(fns.length >= 26, `产品里应至少有 26 个 Search-* 引擎函数，实得 ${fns.length}（正则失效？）`);
  const dirs = [path.join(ROOT, 'tests', 'behavior'), path.join(ROOT, 'tests', 'behavior', 'lib')];
  const text = dirs.flatMap((d) => fs.readdirSync(d).filter((f) => f.endsWith('.mjs')).map((f) => fs.readFileSync(path.join(d, f), 'utf8'))).join('\n');
  const missing = fns.filter((fn) => !text.includes(`'${fn}'`));
  assert.deepEqual(missing, [], '这些引擎没有任何行为用例点名（改了名？还是压根没测？）：' + missing.join(', '));
  // 负控：同一条判据必须能认出"不存在的引擎名"——否则 include 写错也会绿。
  assert.deepEqual(['Search-ThisDoesNotExist'].filter((fn) => !text.includes(`'${fn}'`)), ['Search-ThisDoesNotExist']);
});
