// 产品源码的「加载后视图」——供静态门使用。
//
// 为什么需要（B3-2，v1.54.0）：
//   v1.54.0 把 237 个函数从 `multi-platform-searcher.ps1` 搬进了 `lib/*.ps1`（按领域分 8 个模块）。
//   静态门断言的是「产品里有没有这段逻辑 / 这条不变量」，**不是**「它在哪个文件里」。若让 50 多个门
//   继续只读主脚本，拆分就等于把门一起拆瞎（要么假绿：断言在空字符串上通过；要么假红：找不到函数）。
//
// 做法：按主脚本**真实的加载顺序**把 lib 模块展开回主脚本的加载点（`foreach ($__m in @(...))` 那块），
//   engines/*.ps1 追加在末尾（与 v1.38.0 抽出引擎时的口径一致）。
//   ⇒ 展开后的文本 == 运行时"函数表 + 顶层语句"的书写顺序，`indexOf('function X')` 这类切片仍然成立。
//
// 纪律：
//   · 需要「入口文件本身」的判据（行数上限、版本锚点、模块地图、加载器存在性）请用 readMain()，
//     不要用 sourceAll() —— 否则"入口瘦身"这条判据会被展开后的文本自己骗过去。
//   · 展开失败必须**抛错**，不许静默退回主脚本（那会让 50 多个门一起变瞎）。
import fs from 'node:fs';
import path from 'node:path';

const LOADER_BLOCK = /(\r?\n)# -+ B3-2（v[\d.]+）：模块加载 -+\r?\n(?:[^\n]*\r?\n)*?foreach \(\$__m in @\(([^)]*)\)\) \{\r?\n(?:[^\n]*\r?\n)*?\}\r?\n/;

export function mainFile(root) {
  return path.join(root, 'multi-platform-searcher.ps1');
}

export function readMain(root) {
  return fs.readFileSync(mainFile(root), 'utf8');
}

/** 主脚本声明的模块加载顺序（单一事实源：直接读加载器那一行） */
export function libOrder(entrySrc) {
  const m = LOADER_BLOCK.exec(entrySrc);
  if (!m) return null;
  return [...m[2].matchAll(/'([\w.-]+)'/g)].map((x) => x[1]);
}

export function readLib(root, name) {
  const p = path.join(root, 'lib', `${name}.ps1`);
  if (!fs.existsSync(p)) throw new Error(`lib 模块缺失：${p}（入口声明了 ${name}，但没有这个文件）`);
  return fs.readFileSync(p, 'utf8');
}

/**
 * 展开后的产品源码 = 主脚本（加载器块被各模块内容替换）+ engines/*.ps1
 * @param {string} root 技能根目录
 * @param {{engines?: boolean}} [opts] engines:false = 不追加 engines/*.ps1（保留"只扫主脚本"类判据的原有范围）
 */
export function sourceAll(root, opts = {}) {
  const withEngines = opts.engines !== false;
  const entry = readMain(root);
  const order = libOrder(entry);
  if (!order || !order.length) {
    throw new Error('主脚本里找不到模块加载器（`foreach ($__m in @(...))`）—— 门无法还原产品源码，拒绝静默降级');
  }
  const libText = order.map((n) => `\n# ===== lib/${n}.ps1 =====\n${readLib(root, n)}`).join('\n');
  const m = LOADER_BLOCK.exec(entry);
  const expanded = entry.slice(0, m.index) + '\n' + libText + '\n' + entry.slice(m.index + m[0].length);
  const enginesDir = path.join(root, 'engines');
  const engineSrc = withEngines && fs.existsSync(enginesDir)
    ? fs.readdirSync(enginesDir).filter((f) => f.endsWith('.ps1')).sort()
      .map((f) => fs.readFileSync(path.join(enginesDir, f), 'utf8')).join('\n')
    : '';
  return engineSrc ? `${expanded}\n${engineSrc}` : expanded;
}

/** 取一个函数的函数体（含签名），按「下一个顶层 function 之前」切 —— 与旧门同一口径 */
export function psFunctionBody(src, name) {
  const marker = `function ${name} {`;
  const at = src.indexOf(marker);
  if (at < 0) return '';
  const tail = src.slice(at);
  const next = /\nfunction [A-Za-z][\w-]* \{/.exec(tail);
  return next ? tail.slice(0, next.index) : tail;
}

/** 产品源码文件清单（入口 + lib/*.ps1 + engines/*.ps1），按加载顺序 */
export function productFiles(root) {
  const files = [mainFile(root)];
  const order = libOrder(readMain(root)) || [];
  for (const n of order) files.push(path.join(root, 'lib', `${n}.ps1`));
  const enginesDir = path.join(root, 'engines');
  if (fs.existsSync(enginesDir)) {
    for (const f of fs.readdirSync(enginesDir).filter((x) => x.endsWith('.ps1')).sort()) files.push(path.join(enginesDir, f));
  }
  return files;
}

/**
 * 找出**含有这段文本的那个产品文件** —— 供"按锚点做字节变异"的门使用。
 * B3-2 之后函数会继续搬家，所以变异门不该再写死 `file: '主脚本'`。
 * 找不到返回 null（调用方必须判红：锚点漂了就是门失效，不许静默跳过）。
 */
export function findOwner(root, text) {
  return productFiles(root).find((p) => fs.existsSync(p) && fs.readFileSync(p, 'utf8').includes(text)) || null;
}
