// U-273（B3-2，v1.54.0）：模块拆分的**形状契约**。
//
// 为什么需要它：拆分本身不是目的。没有这条门，"模块化"会在三个月内退化回一个 8000 行脚本 ——
//   因为往主流程里加 20 行永远不会有人拦你，而"新建一个模块"需要一次决定。
//   本门把计划里的判据（入口 ≤1,500 行；模块各 ≤2,000 行）变成会红的东西，
//   并且双向校验"入口声明 ↔ 磁盘文件"，防止出现「写了模块但没加载」或「声明了但文件不在」。
//
// ★本门读**入口原文**（readMain），不读 sourceAll：入口瘦身这条判据若用展开后的文本判，会被自己骗过去。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMain, libOrder } from './lib/source.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY_MAX = 1500;
const MODULE_MAX = 2000;

const entry = readMain(ROOT);
const entryLines = entry.split(/\r?\n/).length;
const order = libOrder(entry);

test('U-273-A 入口 ≤1,500 行（超出就把逻辑放进 lib/，不要放宽本门）', () => {
  assert.ok(entryLines > 200, `入口只剩 ${entryLines} 行 —— 解析可能没读到真文件`);
  assert.ok(entryLines <= ENTRY_MAX, `入口 ${entryLines} 行 > ${ENTRY_MAX}：新逻辑应放进 lib/ 对应模块，或把主流程段落抽成函数`);
});

test('U-273-B 每个模块 ≤2,000 行', () => {
  assert.ok(Array.isArray(order) && order.length >= 5, `入口声明的模块太少（${order && order.length}）—— 加载器被改坏了？`);
  const tooBig = [];
  for (const name of order) {
    const p = path.join(ROOT, 'lib', `${name}.ps1`);
    assert.ok(fs.existsSync(p), `入口声明了 lib/${name}.ps1，但文件不存在（点源会静默跳过 ⇒ 运行时才炸）`);
    const n = fs.readFileSync(p, 'utf8').split(/\r?\n/).length;
    if (n > MODULE_MAX) tooBig.push(`${name}=${n}`);
  }
  assert.deepEqual(tooBig, [], `模块超 ${MODULE_MAX} 行：${tooBig.join(', ')} —— 按领域再分一个模块，不要放宽`);
});

test('U-273-C 双向：磁盘上的每个模块都被入口加载，顺序以 config 开头（数据先于一切）', () => {
  const onDisk = fs.readdirSync(path.join(ROOT, 'lib')).filter((f) => f.endsWith('.ps1')).map((f) => f.replace(/\.ps1$/, '')).sort();
  const declared = [...order].sort();
  assert.deepEqual(declared, onDisk, '入口声明与 lib/ 实际文件不一致（多写、少写、或改名没同步）');
  assert.equal(order[0], 'config', `加载顺序第一个必须是 config（Cfg/注册表要在任何顶层求值之前），实为 ${order[0]}`);
});

test('U-273-D 模块只定义、不执行：顶层语句只允许函数定义、$script: 赋值与表字面量', () => {
  // 允许：函数定义（可带同行 param）、块收尾、$script: 赋值、表/数组字面量的续行、以及数据初始化的 try/catch。
  const ALLOWED = [/^function\s+[A-Za-z][\w-]*\s*\{/, /^\}$/, /^\)$/, /^\$script:[\w]+\s*=/, /^@\{/, /^@\(/, /^try\s*\{$/, /^\}\s*catch\b/, /^\}\s*finally\b/];
  const bad = [];
  for (const name of order) {
    const p = path.join(ROOT, 'lib', `${name}.ps1`);
    const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
    let here = null;                       // 正在 here-string 里：'@ 或 "@ 结束
    lines.forEach((l, i) => {
      const t = l.replace(/\r$/, '');
      if (here) { if (t.trim() === here) here = null; return; }
      const open = /@(['"])\s*$/.exec(t);
      if (open) { here = open[1] + '@'; return; }
      if (!t || /^\s/.test(t) || t.startsWith('#')) return;   // 空行 / 缩进行（函数体内）/ 注释
      if (ALLOWED.some((re) => re.test(t))) return;
      bad.push(`${name}:${i + 1}: ${t.slice(0, 80)}`);
    });
    assert.equal(here, null, `${name}: here-string 未闭合（本门的行扫描会失真）`);
  }
  assert.deepEqual(bad, [], '模块顶层出现了"执行"语句（改写成函数，由主流程调用）：\n  ' + bad.join('\n  '));
});
