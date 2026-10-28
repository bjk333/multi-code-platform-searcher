// U-232（v1.53.15，2026-10-23）：调研选型类查询必须同时跑 repo + research。
//   实测病灶（本机，acc_* 采样）：
//     「调研 rust 生态的异步运行时选型」→ queryType=research_only ⇒ repo 池压根没跑
//     「rust async runtime comparison」  → research_only（无信号词命中，走默认兜底）
//     「tokio vs async-std」             → research_only（同上）
//   结果：DockerHub 的 rust 语言镜像 + 4 篇编译器论文 + 无关 npm 包，而 tokio/async-std/smol
//   全在 GitHub 上（星数/活跃度是选型的核心依据）。
//
//   根因：planner 的 researchTerms 有「调研」，但 engineeringTerms 里没有「选型/对比/替代/vs/comparison」，
//   且**无信号词时默认 research_only**。选型类查询的正确模式是 integrated（repo 看星数活跃度 + research 看资料）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { sourceAll } from './lib/source.mjs';
import { PS as PS_EXE, PS_ARGS } from './lib/interp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PS = PS_EXE;

// ★断言的是**实际模式**（Get-AutoPlan.Modes），不是标签 ——
//   因为 Add-AutoResearchMode 会在"关键词无代码标识符"时自动追加 research，
//   所以 repository_only 的真实模式就是 repo+research（本仓已有文档说明）。
const PROBE_TMPL = `
$ErrorActionPreference = 'Continue'
$env:MCPS_NO_MAIN = '1'
. ./multi-platform-searcher.ps1 -NoEnvFile -Keyword x -Limit 1
$rows = @()
foreach ($q in @(__QUERIES__)) {
  $p = Get-AutoPlan -Keyword $q
  $rows += ('{0}|{1}|{2}' -f $q, $p.QueryType, ($p.Modes -join '+'))
}
[System.IO.File]::WriteAllLines($env:U232_OUT, $rows, (New-Object System.Text.UTF8Encoding($false)))
`;

function planFor(query, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u232-'));
    const body = PROBE_TMPL.replace('__QUERIES__', JSON.stringify([query]).replace(/^\[|\]$/g, ''));
    const f = path.join(dir, 'probe.ps1');
    const outFile = path.join(dir, 'out.txt');
    const prelude = `$env:U232_OUT = '${outFile.replace(/\\/g, '\\\\')}'\n`;
    fs.writeFileSync(f, '\ufeff' + prelude + body, 'utf8');
    const child = spawn(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', f], { cwd: ROOT, windowsHide: true, env: { ...process.env, MCPS_NO_MAIN: '1' } });
    let out = '', err = '';
    const killer = setTimeout(() => { try { child.kill(); } catch { } reject(new Error('planner timeout: ' + query)); }, timeoutMs);
    child.stdout.on('data', (b) => { out += b.toString('utf8'); });
    child.stderr.on('data', (b) => { err += b.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(killer); reject(e); });
    child.on('close', () => {
      clearTimeout(killer);
      try {
        const line = fs.readFileSync(outFile, 'utf8').split('\n').map(s => s.trim()).filter(Boolean)[0];
        const [q, queryType, modes] = line.split('|');
        resolve({ query: q, queryType, modes: String(modes || '').split('+').filter(Boolean) });
      } catch (e) { reject(new Error(`probe failed for "${query}": ${String(e).slice(0, 160)} / ${out.slice(0, 160)} / ${err.slice(0, 160)}`)); }
      finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { } }
    });
    child.stdin.end();
  });
}

// ★选型/对比类：必须 integrated（repo + research 都要跑），不得 research_only
const SELECTION_QUERIES = [
  '调研 rust 生态的异步运行时选型',
  'rust async runtime comparison',
  'tokio vs async-std',
  '选一个 rust 的 http 客户端',
  'redis 替代方案对比',
];

test('U-232: 选型/对比类查询必须判 integrated（repo 池必须跑）', async () => {
  const problems = [];
  for (const q of SELECTION_QUERIES) {
    const p = await planFor(q);
    console.log(`  [${q}] → ${p.queryType} | modes=${p.modes.join('+')}`);
    if (!p.modes.includes('repo')) problems.push(`"${q}" → modes=${p.modes.join('+')}（缺 repo：拿不到星数/活跃度）`);
    if (!p.modes.includes('research')) problems.push(`"${q}" → modes=${p.modes.join('+')}（缺 research：拿不到资料）`);
  }
  assert.deepEqual(problems, [], '★ 选型类查询必须同时跑 repo + research：\n' + problems.join('\n'));
});

test('U-232 B: 选型查询不得额外跑 code 池（效率）', async () => {
  const p = await planFor('tokio vs async-std');
  assert.equal(p.modes.includes('repo'), true, '必须有 repo，实得: ' + p.modes.join('+'));
  assert.equal(p.modes.includes('research'), true, '必须有 research，实得: ' + p.modes.join('+'));
  assert.equal(p.modes.includes('code'), false, '★ 选型不需要代码片段池（省一轮池开销），实得: ' + p.modes.join('+'));
});

test('U-232 C: 纯资料类查询不得被误改成 integrated（不得过度扩张）', async () => {
  // 这些是真正的"只要资料"，加选型词不能把它们带偏
  const PURE_RESEARCH = ['BERT 论文原文', '什么是 CAP 定理', 'RFC 9110 标准文档'];
  const bad = [];
  for (const q of PURE_RESEARCH) {
    const p = await planFor(q);
    if (p.modes.includes('repo')) bad.push(`"${q}" → modes=${p.modes.join('+')}（纯资料查询不该跑 repo）`);
  }
  assert.deepEqual(bad, [], '纯资料查询不得被选型词带偏:\n' + bad.join('\n'));
});

test('U-232 D: planner 词表必须包含选型/对比类信号词（源码契约）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'query-planner.ps1'), 'utf8');
  // 中文：选型 对比 比较 替代 哪个好
  const cn = ['选型', '对比', '比较', '替代'];
  for (const w of cn) {
    const escaped = '\\u' + w.charCodeAt(0).toString(16).padStart(4, '0') +
      [...w.slice(1)].map((c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')).join('');
    assert.ok(src.includes(escaped) || src.includes(w), `★ planner 词表缺中文选型词「${w}」（期望 U 转义 ${escaped} 或字面量）`);
  }
  // 英文：vs comparison alternative
  for (const w of ['comparison', 'alternative']) {
    assert.ok(new RegExp(w, 'i').test(src), `★ planner 词表缺英文选型词「${w}」`);
  }
  assert.match(src, /(^|[^A-Za-z0-9])vs([^A-Za-z0-9]|$)|'vs'|\\bvs\\b/i, '★ planner 词表缺「vs」');
});

test('U-232 E: 检索式只剩语言名时必须如实告警（不假装能切中文）', () => {
  const src = sourceAll(path.join(ROOT));
  // 告警必须点名"只剩语言/工具名"的实测后果，并给出可执行改法（英文主题词）
  assert.match(src, /检索式只剩语言\/工具名/, '★ 缺"检索式只剩语言名"的告警（实测会返回无关高星项目）');
  assert.match(src, /rust async runtime|英文主题词/, '★ 告警必须给可执行改法（英文主题词），不能只说"结果不好"');
  // 必须只在"中文查询 + 语言名"时触发，不能对英文查询误报
  assert.match(src, /\[\\u4e00-\\u9fff\]/, '★ 告警必须限定中文查询（英文查询不该误报）');
});
