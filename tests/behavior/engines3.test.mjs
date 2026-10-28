// U-280（v1.62.0）：第三批行为臂 —— 传输方式与前面 15 个都不同的四个引擎。
//
//   GrepApp（MCP JSON-RPC + SSE）· StackExchange（AND 语义的 JSON）· DepsDev（两请求串联）
//   + LocalCode（**根本没有网络**：读本机磁盘、调外部二进制）
//
// 前三个走通用执行器（cases-3.mjs）。LocalCode 单独写：它不发请求，夹具那套"必须有 hits"的通则不适用，
// 而它自己的坑恰恰在"没有结果"与"没跑成"的分界上 —— 三种结局（ok / empty / tool_missing / error）
// 必须**互不冒充**，这正是 2026-10-09 那次静默假阴性的形状。
//
// ★LocalCode 的夹具是**一个假的 rg 脚本**（真的会打印、真的会收到参数），不是桩函数：
//   要测的正是"产品怎么调外部命令、怎么解析它的 stdout"，把这一步桩掉就没什么可测了。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineEngineCases } from './lib/define.mjs';
import { CASES3 } from './lib/cases-3.mjs';
import { runEngine } from './lib/engine-probe.mjs';

defineEngineCases(CASES3, 'U-280');

// ─────────────────────────── LocalCode ───────────────────────────

function mkTempDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `u280-${tag}-`));
}

/** 造一个"假 rg"：把收到的参数写进 log，并按 lines 打印 grep 形状的输出 */
function makeFakeRg(dir, lines) {
  const log = path.join(dir, 'args.log');
  const bin = path.join(dir, 'fake-rg.ps1');
  // 无 param 块 ⇒ `-n --color=never` 这类参数会原样进 $args（产品就是这么调的）
  const body = [
    `$ErrorActionPreference = 'Stop'`,
    `(@($args) -join ' ') | Set-Content -LiteralPath ${JSON.stringify(log)} -Encoding utf8`,
    // ★必须用**单引号**的 PS 字符串：JSON.stringify 会把路径里的反斜杠写成双份（JSON 转义），
    //   而 PowerShell 双引号串不认反斜杠转义 ⇒ 夹具吐出的路径会多一倍反斜杠，产品照原样解析，
    //   断言就会红在"路径多了个反斜杠"上 —— 那红的是夹具，不是产品。
    ...lines.map((l) => `Write-Output '${String(l).replace(/'/g, "''")}'`),
    '',
  ].join('\n');
  fs.writeFileSync(bin, body, 'utf8');
  return { bin, log };
}

/** 点源产品后把 Find-LocalSearchBinary 换成夹具（接缝③：必须在产品定义之后） */
function overrideBin(p) {
  return `function Find-LocalSearchBinary { return '${String(p).replace(/'/g, "''")}' }`;
}

function readArgs(log) {
  try { return fs.readFileSync(log, 'utf8').trim(); } catch { return ''; }
}

test('U-280-LC-A LocalCode：命中两条 ⇒ 状态 ok，且**真的**用 -n 调了外部检索', async () => {
  const dir = mkTempDir('ok');
  try {
    const target = path.join(dir, 'src');
    fs.mkdirSync(target, { recursive: true });
    const file = path.join(target, 'app.js');
    fs.writeFileSync(file, 'const foo = 1\nconst bar = 2\n', 'utf8');
    const { bin, log } = makeFakeRg(dir, [`${file}:1:const foo = 1`, `${file}:2:const bar = 2`]);

    const r = await runEngine({
      fn: 'Search-LocalCode',
      params: { Keyword: 'const', LocalPath: target, Limit: 5, __statusName: 'LocalCode' },
      port: 0,
      overrides: overrideBin(bin),
    });
    assert.ok(r.payload, '探针没吐 JSON：' + r.stderr.slice(-500));
    assert.equal(r.payload.ok, true, '引擎抛了未捕获异常：' + r.payload.error);
    assert.equal(r.payload.count, 2, '两条 grep 行应解析成两条结果');
    assert.equal(r.payload.status, 'ok');
    assert.equal(r.payload.result[0].Platform, 'Local');
    assert.equal(r.payload.result[0].Line, 1);
    assert.equal(r.payload.result[0].File, file);
    assert.equal(r.payload.result[0].Preview, 'const foo = 1');

    const args = readArgs(log);
    for (const m of ['-n', '--color=never', '-e', 'const', target]) {
      assert.ok(args.includes(m), `调用外部检索时缺少参数 ${m}；实际：${args}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('U-280-LC-B LocalCode：检索成功但没命中 ⇒ empty（可信零命中）', async () => {
  const dir = mkTempDir('zero');
  try {
    const target = path.join(dir, 'src');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'a.js'), 'nothing here\n', 'utf8');
    const { bin } = makeFakeRg(dir, []);

    const r = await runEngine({
      fn: 'Search-LocalCode',
      params: { Keyword: 'zzz', LocalPath: target, Limit: 5, __statusName: 'LocalCode' },
      port: 0,
      overrides: overrideBin(bin),
    });
    assert.equal(r.payload.ok, true, r.payload.error);
    assert.equal(r.payload.count, 0);
    assert.equal(r.payload.status, 'empty', '检索跑过了、确实没有 ⇒ empty');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('U-280-LC-C LocalCode：外部二进制缺失 ⇒ tool_missing，不许冒充 empty', async () => {
  const dir = mkTempDir('missing');
  try {
    const target = path.join(dir, 'src');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'a.js'), 'const x = 1\n', 'utf8');

    const r = await runEngine({
      fn: 'Search-LocalCode',
      params: { Keyword: 'const', LocalPath: target, Limit: 5, __statusName: 'LocalCode' },
      port: 0,
      overrides: 'function Find-LocalSearchBinary { return $null }',
    });
    assert.equal(r.payload.ok, true, r.payload.error);
    assert.equal(r.payload.count, 0);
    assert.equal(r.payload.status, 'tool_missing', '没安装 ripgrep 却报 empty，等于把"没跑"说成"没有"');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('U-280-LC-D LocalCode：-LocalPath 不存在 ⇒ error（不是 0 命中，也不崩）', async () => {
  const r = await runEngine({
    fn: 'Search-LocalCode',
    params: { Keyword: 'const', LocalPath: path.join(os.tmpdir(), 'u280-definitely-not-here'), Limit: 5, __statusName: 'LocalCode' },
    port: 0,
    overrides: 'function Find-LocalSearchBinary { return $null }',
  });
  assert.equal(r.payload.ok, true, r.payload.error);
  assert.equal(r.payload.count, 0);
  assert.equal(r.payload.status, 'error');
});

test('U-280-LC-E LocalCode：外部命令输出**不含** line 段的行必须被丢掉（不许瞎猜行号）', async () => {
  const dir = mkTempDir('garbage');
  try {
    const target = path.join(dir, 'src');
    fs.mkdirSync(target, { recursive: true });
    const file = path.join(target, 'app.js');
    fs.writeFileSync(file, 'x\n', 'utf8');
    // 第一行是合法 grep 输出；第二行是 rg 的进度/警告类噪声（没有 :line: 段）
    const { bin } = makeFakeRg(dir, [`${file}:7:const ok = 1`, `warning: some ripgrep notice`]);

    const r = await runEngine({
      fn: 'Search-LocalCode',
      params: { Keyword: 'const', LocalPath: target, Limit: 5, __statusName: 'LocalCode' },
      port: 0,
      overrides: overrideBin(bin),
    });
    assert.equal(r.payload.ok, true, r.payload.error);
    assert.equal(r.payload.count, 1, '噪声行被当成了命中：' + JSON.stringify(r.payload.result));
    assert.equal(r.payload.result[0].Line, 7);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
