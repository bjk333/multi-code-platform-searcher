// 门的形态尺子（B3-3）：判"这个门到底有没有**执行产品**"，而不是"它有没有 spawn"。
//
// 为什么不用"是否 spawn"当判据：本仓有 20+ 个门 spawn 探针只为 readFile/AST 解析源码（u100-d1/u163/…）。
//   按 spawn 计数会把静态门算成行为门 —— 比不统计更坏（给自己发假证书）。
//
// 三个判据（任一成立即 behavior）：
//   ① dot-source 约定：源码里**赋值** `MCPS_NO_MAIN = 1`（只是"提到"这个字符串不算 —— u100-d1 就是在找它）；
//   ② CLI 约定：spawn 的参数里出现产品 CLI 的开关字面量（-Keyword / -AsJson / -Doctor / -Platform / -ResearchSources）；
//   ③ 经由探针：它 spawn 的 `tests/*.ps1` 满足 ①。
// 其余一律 static（只读文本 / 只解析 AST / 只查清单）。
//
// 尺子自身由 U-274-E 的四个人造样例守着（两个必须 behavior、两个必须 static）：
//   判据腐烂是这类项目最常见的"假绿"，不能只靠眼睛。

import fs from 'node:fs';
import path from 'node:path';

const PRODUCT = 'multi-platform-searcher.ps1';
const CLI_FLAGS = /['"]\-(Keyword|AsJson|Doctor|Platform|ResearchSources|CodeEvidence|Auto|Package)['"]/;

/** 该文本是否执行产品（dot-source 或 CLI）
 *
 *  @param text     测试源码
 *  @param baseDir  （可选）该文件所在目录；给了才会做 ⑤ 的**一层导入**追踪。
 *                  不给 ⇒ 只按 ①②④ 判（U-274-E 的纯文本样例就是这么用的）。
 */
export function executesProduct(text, baseDir = null) {
  if (/MCPS_NO_MAIN\s*[:=]\s*['"]?1/.test(text)) return true;       // ① dot-source 前必设
  if (/\b(spawn|spawnSync|execFile|execFileSync)\s*\(/.test(text) && CLI_FLAGS.test(text)) return true;  // ② 跑 CLI
  // ④ 行为层夹具：import 了引擎探针 = 这条用例会起子进程跑产品函数。判据不靠目录名（目录名可以随便挪），
  //   靠它真的引了什么。
  if (fromBehaviorLib(text)) return true;
  // ⑤ 经由**执行器**（v1.63.0，U-281）：`engines*.test.mjs` 只 import `lib/define.mjs`，spawn 发生在
  //   define → engine-probe 那一层。只认 ④ 的话，这些**真的在跑产品**的入口会被判成静态 ——
  //   实测就漏了 engines.test.mjs / engines2.test.mjs 两个（占比被低估 2 个门）。
  //   ★只追**一层相对导入**：追整张图会把"import 了一个恰好 import 了测试工具的模块"也算进来，
  //     判据就从"它执行产品"漂移成"它认识执行产品的人"。
  if (baseDir && importsExecutor(text, baseDir)) return true;
  return false;
}

/** 是否 import 了一个**直接** import 引擎探针的仓内模块（执行器） */
export function importsExecutor(text, baseDir) {
  for (const m of text.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
    const target = path.resolve(baseDir, m[1]);
    if (!fs.existsSync(target)) continue;
    if (fromBehaviorLib(fs.readFileSync(target, 'utf8'))) return target;
  }
  return null;
}

function fromBehaviorLib(text) {
  // 只认 basename：探针从 `tests/behavior/lib/` 被直接 import（`./lib/engine-probe.mjs`），
  //   也从**执行器内部**被 import（`./engine-probe.mjs`）—— 要求出现 `lib/` 前缀会漏掉后者，
  //   而 ⑤ 的一层追踪正是靠"执行器 import 了它"来认执行器。
  return /from\s+['"][^'"]*engine-probe\.mjs['"]/.test(text);
}

/** 从测试源码里找出它引用的、仓内存在的 .ps1 探针 */
function referencedProbes(src, testsDir) {
  const names = new Set();
  for (const m of src.matchAll(/['"]([A-Za-z0-9_.\-]+\.ps1)['"]/g)) names.add(m[1]);
  return [...names].filter((n) => fs.existsSync(path.join(testsDir, n)));
}

/** 枚举门文件：tests/test-*.test.mjs + tests/behavior/*.test.mjs + tests/static/*.test.mjs
 *
 *  v1.57.0（B3-4）：加 `tests/static/` —— 设计文档 §5 规定"确需静态检查的放 tests/static/ 并在文件名带 .static."。
 *  ★枚举必须与规则同时落地：只写规则不接枚举，等于让第一个照规则办事的人写出一条**永远不会被执行**的门
 *    （B3-3 已经踩过：行为层写好了但 runner 只扫 tests/test-*）。
 *  ★这是唯一的枚举处：runner 直接用它（v1.57.0 之前 runner 自己写了一份 readdir，
 *    「两份实现」必然漂移 —— 一处在行为层加目录，另一处忘了，新门就静默不跑）。
 */
export function gateFiles(rootDir) {
  const testsDir = path.join(rootDir, 'tests');
  const out = [];
  const walk = (dir, rel) => {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, name.name);
      const r = rel ? rel + '/' + name.name : name.name;
      if (name.isDirectory()) { if (name.name !== 'lib') walk(abs, r); continue; }
      if (!/\.test\.mjs$/.test(name.name)) continue;
      // 顶层沿用 `test-` 前缀约定（`lib/` 已排除）；子目录（behavior/ static/）整目录收
      if (!rel && !/^test-.*\.test\.mjs$/.test(name.name)) continue;
      out.push(abs);
    }
  };
  walk(testsDir, '');
  return out.sort();
}

/** @returns {{file:string, shape:'behavior'|'static', why:string}[]} */
export function classify(rootDir) {
  const testsDir = path.join(rootDir, 'tests');
  return gateFiles(rootDir).map((abs) => {
    const file = path.relative(testsDir, abs).replace(/\\/g, '/');
    const src = fs.readFileSync(abs, 'utf8');
    if (executesProduct(src, path.dirname(abs))) return { file, shape: 'behavior', why: 'test 自身执行产品' };
    for (const p of referencedProbes(src, testsDir)) {
      if (executesProduct(fs.readFileSync(path.join(testsDir, p), 'utf8'))) {
        return { file, shape: 'behavior', why: `经探针 ${p} 执行产品` };
      }
    }
    return { file, shape: 'static', why: '只读文本/解析 AST' };
  });
}

export function share(rootDir) {
  const rows = classify(rootDir);
  const behavior = rows.filter((r) => r.shape === 'behavior').length;
  return { total: rows.length, behavior, static: rows.length - behavior, ratio: behavior / rows.length, rows };
}

