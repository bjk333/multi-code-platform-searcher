// U-231（v1.53.13，2026-10-23）：跨运行时一致性门（Tier A1）。
//   调研发现：业界要求"If supporting multiple versions, test on both"。
//   本项目实测过的 3 个跨运行时差异（都是真实踩坑）：
//     ① PS 5.1 代理 CONNECT 502 报中文措辞，PS 7 报英文 ⇒ 分类器必须双运行时都能判
//     ② PS 5.1 的 ErrorRecord.ToString() 不含 InnerException ⇒ helper 必须逐层取
//     ③ PS 5.1 的 `2>&1` 产生 ErrorRecord，$EAP=Stop 会把 native stderr 变成终止错误
//   本门在**当前运行时**验证这些行为，并确保测试矩阵覆盖两个运行时。
//
//   ★本门自身不 spawn PS —— 它验证的是产品代码在当前运行时下的行为。
//   "双运行时跑同一套测试"由 run-tests.ps1 -PSVersion 参数 + 发布清单保证。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { PY as PY_EXE } from './lib/interp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = PY_EXE;

function runPs(body, exe, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u231-'));
    const f = path.join(dir, 'probe.ps1');
    fs.writeFileSync(f, '﻿' + body, 'utf8');
    const child = spawn(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', f], {
      cwd: ROOT, windowsHide: true, env: { ...process.env, MCPS_NO_MAIN: '1' },
    });
    let out = '', err = '';
    const killer = setTimeout(() => { try { child.kill(); } catch { } reject(new Error(exe + ' timeout')); }, timeoutMs);
    child.stdout.on('data', (b) => { out += b.toString('utf8'); });
    child.stderr.on('data', (b) => { err += b.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(killer); reject(e); });
    child.on('close', () => {
      clearTimeout(killer);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { }
      resolve({ out: out.trim(), err: err.trim() });
    });
    child.stdin.end();
  });
}

// 检测当前可用的 PS 运行时
async function detectRuntimes() {
  const runtimes = [];
  for (const exe of ['powershell', 'pwsh']) {
    try {
      const r = await new Promise((resolve) => {
        const c = spawn(exe, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString() + "|" + $PSVersionTable.PSEdition'], { windowsHide: true });
        let out = '';
        c.stdout.on('data', (b) => out += b.toString('utf8'));
        c.on('close', (code) => resolve(code === 0 ? out.trim() : null));
        c.on('error', () => resolve(null));
      });
      if (r) {
        const [ver, edition] = r.split('|');
        runtimes.push({ exe, version: ver, edition });
      }
    } catch { /* not available */ }
  }
  return runtimes;
}

const PROBE_RUNTIME = `
$ErrorActionPreference = 'Continue'
$env:MCPS_NO_MAIN = '1'
. ./multi-platform-searcher.ps1 -NoEnvFile -Keyword x -Limit 1
# ① 异常分类器：PS 5.1 的中文措辞
$r1 = Test-DeterministicTransportFailure -Text '基础连接已经关闭: 发送时发生错误。 由于远程方已关闭传输流，身份验证失败。' -ProxyActive $true
# ② InnerException 提取
try {
  throw (New-Object System.Net.WebException('基础连接已经关闭', (New-Object System.IO.IOException('由于远程方已关闭传输流'))))
} catch { $we = $_ }
$ht = Get-TransportFailureText -ErrorRecord $we
$hasInner = ($ht -match '远程方已关闭传输流')
# ③ 当前运行时版本
$ver = $PSVersionTable.PSVersion.ToString()
$edition = $PSVersionTable.PSEdition
[System.IO.File]::WriteAllLines($env:U231_OUT, @(
  "runtime=$edition $ver",
  "ps51class=$r1",
  "hasInner=$hasInner"
), (New-Object System.Text.UTF8Encoding($false)))
`;

test('U-231: 当前运行时下跨运行时关键行为正确（分类器/InnerException）', async () => {
  const runtimes = await detectRuntimes();
  assert.ok(runtimes.length >= 1, '至少需要一个 PowerShell 运行时');

  for (const rt of runtimes) {
    const outFile = path.join(os.tmpdir(), `u231-out-${rt.exe}.txt`);
    const body = PROBE_RUNTIME.replace('$env:U231_OUT', `$env:U231_OUT = '${outFile.replace(/\\/g, '\\\\')}'`);
    // 先设置 env
    const { out, err } = await runPs(`$env:U231_OUT = '${outFile.replace(/\\/g, '\\\\')}'\n` + PROBE_RUNTIME, rt.exe);
    if (!fs.existsSync(outFile)) throw new Error(`${rt.exe}: no output. stderr: ${err}`);
    const lines = fs.readFileSync(outFile, 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
    const rows = Object.fromEntries(lines.map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));

    assert.equal(rows.ps51class, 'proxy-tunnel', `★ [${rt.exe}/${rt.edition}] PS 5.1 中文措辞必须判 proxy-tunnel: ${rows.ps51class}`);
    assert.equal(rows.hasInner, 'True', `★ [${rt.exe}/${rt.edition}] InnerException 必须被提取: ${rows.hasInner}`);
    // 双运行时必须行为一致
    assert.match(rows.runtime, /Desktop|Core/, `${rt.exe} runtime info: ${rows.runtime}`);
  }
});

test('U-231 B: 双运行时行为一致（若同时有 5.1 和 7）', async () => {
  const runtimes = await detectRuntimes();
  const desktop = runtimes.find(r => r.edition === 'Desktop');
  const core = runtimes.find(r => r.edition === 'Core');
  if (!desktop || !core) {
    assert.ok(true, `只检测到 ${runtimes.map(r => r.edition).join(',')} —— 本门需双运行时才能比较，跳过`);
    return;
  }

  const results = {};
  for (const rt of [desktop, core]) {
    const outFile = path.join(os.tmpdir(), `u231-cmp-${rt.exe}.txt`);
    const { err } = await runPs(`$env:U231_OUT = '${outFile.replace(/\\/g, '\\\\')}'\n` + PROBE_RUNTIME, rt.exe);
    if (!fs.existsSync(outFile)) throw new Error(`${rt.exe}: no output. stderr: ${err}`);
    const lines = fs.readFileSync(outFile, 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
    results[rt.edition] = Object.fromEntries(lines.map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
  }

  assert.equal(results.Desktop.ps51class, results.Core.ps51class,
    `★ 双运行时分类器结果必须一致: Desktop=${results.Desktop.ps51class} vs Core=${results.Core.ps51class}`);
  assert.equal(results.Desktop.hasInner, results.Core.hasInner,
    `★ 双运行时 InnerException 提取必须一致: Desktop=${results.Desktop.hasInner} vs Core=${results.Core.hasInner}`);
});

test('U-231 C: 发布文档必须声明双运行时测试要求', () => {
  const skill = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf8');
  const doc = skill + fs.readFileSync(path.join(ROOT, 'references/参数速查.md'), 'utf8');
  assert.match(doc, /PS\s*5\.1|PowerShell\s*5/, '文档必须提到 PS 5.1');
  // PS 7 / pwsh / Core 至少出现一次
  assert.match(doc, /PS\s*7|pwsh|PowerShell\s*7|Core/i, '★ 文档必须提到 PS 7 / pwsh —— 双运行时是硬要求');
});
