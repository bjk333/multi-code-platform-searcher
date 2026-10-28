// U-235（v1.53.18，2026-10-24）：跨平台冒烟的**门本身**要有人守。
//   背景：v1.53.17 修了四处 Windows 假设，但验证只靠一次性 Docker 手工跑；没有入口 = 下次改动没人知道有没有回退。
//   本门钉四件事：
//     ① tests/crossplat-smoke.ps1 存在，且覆盖 Doctor / 真实检索 / 缓存告警 / 安装提示；
//     ② 脚本**不得 dot-source 主脚本**（实测：-File 模式下 `$MyInvocation.MyCommand.Definition` 指向调用者
//        ⇒ 主脚本 `$ScriptDir` 落到 tests/ ⇒ engines 找不到 ⇒ 检索静默 0 条，且没有任何报错）；
//     ③ 必须走平台 shell 重定向（cmd /c、bash -c）而不是 PowerShell 管道（PS 的 `>` 按宿主编码写，中文 JSON 必坏；
//        .NET ReadToEnd 又会因主脚本末尾 `exit` 拿到 0 字节）；
//     ④ CI 矩阵覆盖 ubuntu + macos，并真的调用该脚本。
//
// 只测契约与可执行性，不联网。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PS as PS_EXE, PS_ARGS } from './lib/interp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SMOKE = path.join(ROOT, 'tests', 'crossplat-smoke.ps1');
const WORKFLOW = path.resolve(ROOT, '..', '.github', 'workflows', 'crossplat.yml');
const PS = PS_EXE;

test('U-235 A: 跨平台冒烟脚本必须存在且覆盖四项关键检查', () => {
  assert.ok(fs.existsSync(SMOKE), '★ 缺 tests/crossplat-smoke.ps1（跨平台没有可复跑入口）');
  const src = fs.readFileSync(SMOKE, 'utf8');
  const required = [
    ['doctor', /'-Doctor'/],
    ['search', /-Keyword/],
    ['cache_warn', /缓存不可写/],
    ['install_hint', /install_hint/],
    ['platform', /platform/],
  ];
  const missing = required.filter(([, re]) => !re.test(src)).map(([n]) => n);
  assert.deepEqual(missing, [], '★ 冒烟脚本缺检查项：' + missing.join(', '));
});

test('U-235 B: 冒烟不得 dot-source 主脚本（会静默 0 条，且不报错）', () => {
  const src = fs.readFileSync(SMOKE, 'utf8');
  // 允许注释里提到，但不得出现真正的 dot-source 调用
  const code = src.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.ok(!/^\s*\.\s+\$main/m.test(code), '★ 脚本里出现了 `. $main`：-File 模式下 $ScriptDir 会落到 tests/，检索静默 0 条');
  assert.ok(!/^\s*\.\s+\(Join-Path/m.test(code), '★ 脚本里出现了 dot-source 主脚本的写法');
});

test('U-235 C: 必须走平台 shell 重定向（PowerShell 管道会坏编码/丢输出）', () => {
  const src = fs.readFileSync(SMOKE, 'utf8');
  assert.match(src, /cmd(\.exe)?\s+\/c|ComSpec/, '★ 缺 Windows 侧 shell 重定向（cmd /c）');
  assert.match(src, /bash\s+-c/, '★ 缺 Unix 侧 shell 重定向（bash -c）');
  // 负向：不得再用 PowerShell 的 `>` 直接接脚本调用捕获 JSON
  assert.ok(!/&\s*\$hostExe[^\n]*>\s*\$/.test(src), '★ 仍在用 PowerShell 归接捕获 CLI 输出');
});

test('U-235 D: CI 必须覆盖 ubuntu 与 macos，并真的调用冒烟脚本', () => {
  assert.ok(fs.existsSync(WORKFLOW), '★ 缺 .github/workflows/crossplat.yml');
  const yml = fs.readFileSync(WORKFLOW, 'utf8');
  assert.match(yml, /ubuntu-latest/, '★ 矩阵缺 ubuntu-latest');
  assert.match(yml, /macos-latest/, '★ 矩阵缺 macos-latest');
  assert.match(yml, /crossplat-smoke\.ps1/, '★ workflow 没有调用跨平台冒烟脚本');
  assert.match(yml, /PWSH:\s*pwsh/, '★ 必须给 Node 门注入 PWSH=pwsh（runner 上没有叫 powershell 的可执行）');
});

test('U-235 E: 冒烟脚本自身在当前离线模式可跑通（-SkipNetwork）', async () => {
  const rc = await new Promise((resolve, reject) => {
    const child = spawn(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SMOKE, '-SkipNetwork'], { cwd: ROOT, windowsHide: true });
    let out = '', err = '';
    const killer = setTimeout(() => { try { child.kill(); } catch { } reject(new Error('U-235 smoke timeout')); }, 120000);
    child.stdout.on('data', (b) => { out += b.toString('utf8'); });
    child.stderr.on('data', (b) => { err += b.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(killer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(killer);
      console.log(out.split('\n').filter((l) => l.startsWith('[crossplat]')).join('\n'));
      if (code !== 0) reject(new Error(`smoke rc=${code} / ${out.slice(-400)} / ${err.slice(-200)}`));
      else resolve(code);
    });
  });
  assert.equal(rc, 0);
});
