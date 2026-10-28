// U-234（v1.53.17，2026-10-24）：跨平台补洞批 —— Linux/macOS 实测暴露的四处 Windows 假设。
//   背景（Linux 容器实测，见 reports/跨平台可行性评估-2026-10-24.md）：
//     · 核心检索在 Debian 12 + pwsh 7.4 上已可用（jwt → exit 0 / 4.8s / Verdict=full）
//     · 但 `-Download` 硬编码 `& curl.exe` ⇒ 非 Windows 直接失效
//     · `-Interactive` 硬编码 `& fzf.exe` ⇒ 装了 fzf 也用不上
//     · 只读安装目录下缓存在写失败时被 `catch { }` 静默吞掉（结果正常、warnings 为空）
//     · `-Doctor` 缺工具只说"请安装 ripgrep"，非 Windows 上没有任何可执行指向
//
// 本门只钉**确定性行为**与源码契约，不联网。

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

// 取某个顶层函数的函数体（到下一个顶层 function 或文件尾）
function fnBody(name) {
  const start = SRC.indexOf(`function ${name} {`);
  if (start < 0) throw new Error(`找不到函数 ${name}`);
  const rest = SRC.slice(start + 10);
  const next = rest.search(/\nfunction [A-Za-z]/);
  return next < 0 ? rest : rest.slice(0, next);
}

const PROBE = `
$ErrorActionPreference = 'Stop'
. ./multi-platform-searcher.ps1 -NoEnvFile -Keyword x -Limit 1
$rows = @()

# C：缓存不可写必须进 warnings（此前 catch{} 静默吞）
$dir = Join-Path $env:TEMP ('u234-no-such-dir-' + $PID)
$script:CacheFile = Join-Path $dir 'cache.json'
Set-LruResult -Key 'u234-probe' -Data @{ probe = 1 } | Out-Null
Flush-LruCache
$w = @(Get-EngineWarnings)
$hit = @($w | Where-Object { $_ -like '*缓存不可写*' })
$rows += 'cache_warn=' + $(if ($hit.Count -gt 0) { 'yes' } else { 'no' })
$rows += 'cache_warn_text=' + $(if ($hit.Count -gt 0) { $hit[0] } else { '' })

# D：安装提示按平台给可执行命令
foreach ($p in 'win','linux','mac') { $rows += "hint_$p=" + (Get-ToolInstallHint -Tool 'ripgrep' -Platform $p) }
$rows += 'hint_unknown=[' + (Get-ToolInstallHint -Tool 'not-a-tool' -Platform 'linux') + ']'
$missing = @()
foreach ($t in 'ripgrep','ugrep','ast-grep','aria2','fzf') {
  foreach ($p in 'win','linux','mac') { if (-not (Get-ToolInstallHint -Tool $t -Platform $p)) { $missing += ($t + '/' + $p) } }
}
$rows += 'hint_missing=' + ($missing -join ',')

[System.IO.File]::WriteAllLines($env:U234_OUT, $rows, (New-Object System.Text.UTF8Encoding($false)))
`;

let cache = null;
function probe() {
  if (cache) return cache;
  cache = new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u234-'));
    const outFile = path.join(dir, 'out.txt');
    const f = path.join(dir, 'probe.ps1');
    const prelude = `$env:U234_OUT = '${outFile.replace(/\\/g, '\\\\')}'\n`;
    fs.writeFileSync(f, '\ufeff' + prelude + PROBE, 'utf8');
    const child = spawn(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', f], { cwd: ROOT, windowsHide: true, env: { ...process.env, MCPS_NO_MAIN: '1' } });
    let out = '', err = '';
    const killer = setTimeout(() => { try { child.kill(); } catch { } reject(new Error('U-234 probe timeout')); }, 120000);
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

test('U-234 A: 下载不得再用裸命令名（Linux/macOS 上没有 curl.exe / aria2c.exe）', () => {
  const body = fnBody('Invoke-DownloadFile');
  assert.ok(!/&\s*curl\.exe\b/.test(body), '★ Invoke-DownloadFile 仍在裸调 curl.exe（非 Windows 必失败）');
  assert.ok(!/&\s*aria2c\.exe\b/.test(body), '★ Invoke-DownloadFile 仍在裸调 aria2c.exe');
  assert.match(body, /@\(\s*'curl\.exe'\s*,\s*'curl'\s*\)/, '★ 必须按平台候选名择一（curl.exe / curl）');
  assert.match(body, /@\(\s*'aria2c\.exe'\s*,\s*'aria2c'\s*\)/, '★ 必须按平台候选名择一（aria2c.exe / aria2c）');
  assert.match(body, /Invoke-WebRequest/, '★ 连 curl 都没有时必须用 .NET 原生下载兜底（否则 -Download 全灭）');
});

test('U-234 B: fzf 必须用探测结果，不得写死 fzf.exe', () => {
  const body = fnBody('Select-Interactive');
  assert.ok(!/&\s*fzf\.exe\b/.test(body), '★ 仍在裸调 fzf.exe（Linux/macOS 装了 fzf 也用不上）');
  assert.match(body, /@\(\s*'fzf\.exe'\s*,\s*'fzf'\s*\)/, '★ 必须按平台候选名择一（fzf.exe / fzf）');
});

test('U-234 C: 缓存写失败必须进 warnings（只读安装下不再静默无缓存）', async () => {
  const m = await probe();
  assert.equal(m.get('cache_warn'), 'yes', '★ 写失败被静默吞了：只读安装下用户永远不知道缓存不生效');
  const text = m.get('cache_warn_text') || '';
  assert.match(text, /缓存不可写/, '★ 告警必须点名"缓存不可写"');
  assert.match(text, /u234-no-such-dir|\.json/, '★ 告警必须带路径，否则无法诊断（path=' + text + '）');
});

test('U-234 D: 缺工具的安装提示必须按平台给可执行命令', async () => {
  const m = await probe();
  const win = m.get('hint_win') || '';
  const linux = m.get('hint_linux') || '';
  const mac = m.get('hint_mac') || '';
  console.log(`  win=${win} | linux=${linux} | mac=${mac}`);
  assert.match(win, /winget/i, '★ Windows 提示必须是 winget（不是"请安装"）');
  assert.match(linux, /apt|dnf|pacman|snap/i, '★ Linux 提示必须是发行版包管理器');
  assert.match(mac, /brew/i, '★ macOS 提示必须是 brew');
  assert.notEqual(win, linux, '★ 三平台提示不能相同（否则等于没按平台给）');
  assert.notEqual(linux, mac, '★ Linux 与 macOS 提示不能相同');
  assert.equal(m.get('hint_unknown'), '[]', '★ 未知工具必须返回空串，不能编命令');
  assert.equal(m.get('hint_missing'), '', '★ 每个已登记工具都必须有三平台提示：' + m.get('hint_missing'));
});

test('U-234 E: Doctor 的代码证据建议必须接上安装提示', () => {
  assert.match(SRC, /Get-ToolInstallHint -Tool 'ripgrep'/, '★ Doctor 未调用安装提示函数');
  assert.match(SRC, /\$rgHint/, '★ 建议文案必须引用 $rgHint，否则提示生成了也没人看');
  // 两条分支都要能给出安装入口：无 token 与有 token 但无本地工具
  const rec = SRC.slice(SRC.indexOf("$doctorReport['recommendation']"), SRC.indexOf('$codeHealth = '));
  const hits = (rec.match(/rgHint/g) || []).length;
  assert.ok(hits >= 2, `★ 至少"无 token"与"仅有远程"两条分支都要带安装提示，实际引用 ${hits} 处`);
});

test('U-234 F: 本地引擎缺工具文案不得再写死 .exe（非 Windows 读起来像另装一个东西）', () => {
  const eng = fs.readFileSync(path.join(ROOT, 'engines', 'local-code.ps1'), 'utf8');
  assert.ok(!/ripgrep\(rg\.exe\)/.test(eng), '★ engines/local-code.ps1 文案仍写死 rg.exe');
});
