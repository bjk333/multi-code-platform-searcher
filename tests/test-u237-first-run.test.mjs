// U-237（v1.53.20，2026-10-24）：零配置首跑 —— **裸装第一次用**不该只看到技术性 warnings。
//   病灶：没有任何令牌 + 没有本地检索工具时，匿名限速（GitHub 10 次/分）会显著压低召回；
//   用户看到的是"结果很少/0 条 + 一堆 [query]/[engine] 告警"，不知道下一步该做什么。
//   设计：只在**完全裸装**时给 ≤3 条可执行建议（先 -Doctor / 配 GITHUB_TOKEN / 装 ripgrep）。
//   刻意不做"只缺一项"的提示 —— 那种情形在 -Doctor 的 recommendation 里已有专门分支，
//   主流程每次都唠叨反而是噪音（这是产品决策，门要钉住"不打扰老用户"）。
//
// 纯函数测试，不联网。

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
const SRC = sourceAll(path.join(ROOT));

const PROBE = `
$ErrorActionPreference = 'Stop'
. ./multi-platform-searcher.ps1 -NoEnvFile -Keyword x -Limit 1
$rows = @()
$all4 = @('GITHUB_TOKEN','GITLAB_TOKEN','GITEE_TOKEN','SRC_TOKEN')
$all3 = @('GITLAB_TOKEN','GITEE_TOKEN','SRC_TOKEN')
foreach ($p in @('win','linux','mac')) {
  $a = @(Get-FirstRunAdvice -MissingTokens $all4 -MissingTools @('ripgrep','ugrep') -Platform $p)
  $rows += 'bare_' + $p + '=' + $a.Count + '||' + ($a -join ' >> ')
}
# 有任意令牌（只缺 3 个）⇒ 不打扰
$rows += 'with_token=' + @(Get-FirstRunAdvice -MissingTokens $all3 -MissingTools @('ripgrep') -Platform 'linux').Count
# 有本地工具 ⇒ 不打扰（显式传空数组，函数必须据此判定"不缺"）
$rows += 'with_tool=' + @(Get-FirstRunAdvice -MissingTokens $all4 -MissingTools @() -Platform 'linux').Count
[System.IO.File]::WriteAllLines($env:U237_OUT, $rows, (New-Object System.Text.UTF8Encoding($false)))
`;

let cache = null;
function probe() {
  if (cache) return cache;
  cache = new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u237-'));
    const outFile = path.join(dir, 'out.txt');
    const f = path.join(dir, 'probe.ps1');
    const prelude = `$env:U237_OUT = '${outFile.replace(/\\/g, '\\\\')}'\n`;
    fs.writeFileSync(f, '\ufeff' + prelude + PROBE, 'utf8');
    const child = spawn(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', f], { cwd: ROOT, windowsHide: true, env: { ...process.env, MCPS_NO_MAIN: '1' } });
    let out = '', err = '';
    const killer = setTimeout(() => { try { child.kill(); } catch { } reject(new Error('U-237 probe timeout')); }, 120000);
    child.stdout.on('data', (b) => { out += b.toString('utf8'); });
    child.stderr.on('data', (b) => { err += b.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(killer); reject(e); });
    child.on('close', () => {
      clearTimeout(killer);
      try {
        const m = new Map();
        for (const line of fs.readFileSync(outFile, 'utf8').split('\n')) {
          const s = line.replace(/\r$/, '');
          if (!s) continue;
          const i = s.indexOf('=');
          m.set(s.slice(0, i), s.slice(i + 1));
        }
        resolve(m);
      } catch (e) {
        reject(new Error(`probe failed: ${String(e).slice(0, 200)} / ${out.slice(0, 200)} / ${err.slice(0, 200)}`));
      } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { } }
    });
    child.stdin.end();
  });
  return cache;
}

test('U-237 A: 完全裸装必须给出三条可执行建议（含 -Doctor / 令牌 / 本地工具）', async () => {
  const m = await probe();
  for (const p of ['win', 'linux', 'mac']) {
    const raw = m.get(`bare_${p}`) || '';
    const count = parseInt(raw.split('||')[0], 10);
    const text = raw.split('||')[1] || '';
    assert.equal(count, 3, `★ ${p} 平台裸装应给 3 条建议，实得 ${count}`);
    assert.match(text, /-Doctor/, `★ ${p} 缺"先跑 -Doctor"`);
    assert.match(text, /GITHUB_TOKEN/, `★ ${p} 缺"配 GITHUB_TOKEN"`);
    assert.match(text, /ripgrep/, `★ ${p} 缺"装 ripgrep"`);
  }
});

test('U-237 B: 安装命令必须按平台不同（win=winget / linux=apt / mac=brew）', async () => {
  const m = await probe();
  const pick = (p) => (m.get(`bare_${p}`) || '').split('||')[1] || '';
  assert.match(pick('win'), /winget/i, '★ Windows 建议缺 winget');
  assert.match(pick('linux'), /apt/i, '★ Linux 建议缺 apt');
  assert.match(pick('mac'), /brew/i, '★ macOS 建议缺 brew');
});

test('U-237 C: 有任意令牌时不得打扰（只缺一项交给 -Doctor）', async () => {
  const m = await probe();
  assert.equal(Number(m.get('with_token')), 0, '★ 已有令牌仍弹首跑建议 —— 老用户会被天天唠叨');
});

test('U-237 D: 有本地检索工具时不得打扰', async () => {
  const m = await probe();
  assert.equal(Number(m.get('with_tool')), 0, '★ 有 ripgrep 仍弹首跑建议');
});

test('U-237 E: 建议必须同时进 warnings[] 与人读输出（-AsJson 不得被污染）', () => {
  // 入队必须在取 warnings 之前
  const iWarn = SRC.indexOf('$warningsOut = @(Get-EngineWarnings');
  const iAdvice = SRC.indexOf('$firstRunAdvice = @(Get-FirstRunAdvice)');
  assert.ok(iAdvice > 0, '★ 主流程没有调用 Get-FirstRunAdvice');
  assert.ok(iAdvice < iWarn, '★ 首跑建议在 warnings 取值之后才入队 —— 进不了本次载荷');
  assert.match(SRC, /-Engine 'first-run'/, '★ 告警必须用 [first-run] 前缀，便于调用方过滤');
  // 人读输出必须在非 AsJson 分支，且带保护
  const iElse = SRC.indexOf('# v1.53.20：裸装首跑引导（-AsJson 走 warnings[]');
  assert.ok(iElse > 0, '★ 缺人读输出分支');
  assert.match(SRC.slice(iElse, iElse + 400), /foreach \(\$a in \$firstRunAdvice\)/, '★ 人读分支没有遍历建议');
});
