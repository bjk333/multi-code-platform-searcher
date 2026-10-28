// U-294（v1.74.0，2026-10-28 全量验收 F8）：**拼错的开关不许被静默忽略**。
//
// 病在哪（本轮验收实测，我自己先中了一次）：
//   主脚本原来是简单 `param()` 块（没有 `[CmdletBinding()]`）⇒ **未声明的具名参数会落进 `$args` 然后被丢掉**：
//     `-CodeSearch`（这个开关根本不存在）⇒ rc=0、`modes=['repo']`；
//     `-Zzzz` ⇒ rc=0，`$ErrorActionPreference` + try/catch 也抓不到。
//   于是"我把 repo 模式的结果当成了 code 语义的结论" —— 静默错比响亮错危险，这类错误没有任何观测面。
//   讽刺的是本仓**已经**给测试 harness 强制了 `[CmdletBinding(PositionalBinding = $false)]`（U-92，
//   理由正是"拒绝裸位置参数"），主脚本自己没享受同一条纪律。
//
// 做法（四层，缺一层都不算守住）：
//   ① 声明层：入口必须是 `[CmdletBinding(PositionalBinding = $false)]` **紧接** `param(` —— 锚定在声明位置，
//      不是"全文出现过这个字符串"（v1.74.0 的头部注释里就写着这个词；负例专门拆掉真声明、只留注释 ⇒ 必红）。
//   ② 行为层：**双运行时真起子进程**（PS 5.1 与 pwsh 7），三类非法输入各自钉死结果：
//      未知具名 / 历史踩过的具体拼写 / 裸位置参数 ⇒ 非零退出且 stderr 点名绑定失败。
//   ③ 阳性对照：合法参数（`-Keyword '' -AsJson`）⇒ 仍然非零退出，但**理由是产品自己的参数校验**
//      （stdout JSON `missing-required-parameter`、stderr 是 U-142 throw），不是绑定失败 —— 证明"没把正常绑定搞坏"，
//      同时它证明主流程真的执行了（body 被执行过，才可能吐出这个信封）。
//   ④ 运行面：`Get-Command <入口>` 的参数表必须同时含 **Verbose/ErrorAction**（CmdletBinding 真的生效）
//      与源码 param 块里解析出的**全部**参数名（逐个断言，避免"加了声明却绑不上"）。
//   另有 dot-source 探针（整仓 PS 用例都靠 dot-source 跑，这是本改动唯一可能打断的那条路）与反向控制。
//
// ★为什么全程 async spawn（R2 卫生门）：本仓禁止在门里用 spawnSync —— 宿主垫片下它会恒 EBUSY、status=null，
//   而 `null !== 0` 会让"没跑起来"被读成"绑定拒绝了"（假绿）。异步 spawn 没有这个失败模式；真失败用 reject 暴露。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(root, 'multi-platform-searcher.ps1');
const ENTRY_SRC = fs.readFileSync(ENTRY, 'utf8');

// 声明必须紧接 param(：全文包含不算（头部注释里就有这个词）。
const DECL = /\[CmdletBinding\(PositionalBinding\s*=\s*\$false\)\]\s*\r?\nparam\(/;
// 版本从入口读，不写死（写死会在下一次升版时变成假红/假绿）。
const VERSION = (ENTRY_SRC.match(/^\$VERSION = "([0-9][0-9.]*)"/m) || [])[1];
const VERSION_RE = new RegExp(String(VERSION || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

/** 起一个子进程并收集 stdout/stderr；没有退出码（被信号杀掉）⇒ 抛错，绝不当成"拒绝了" */
function run(exe, args, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const p = spawn(exe, args, { windowsHide: true });
    let out = '';
    let err = '';
    let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v); } };
    const timer = setTimeout(() => { done(reject, new Error(`timeout ${timeoutMs}ms: ${exe} ${args.join(' ')}`)); try { p.kill(); } catch { /* 已退出 */ } }, timeoutMs);
    p.stdout.setEncoding('utf8');
    p.stderr.setEncoding('utf8');
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => done(reject, e));
    p.on('close', (rc, signal) => {
      if (rc === null) return done(reject, new Error(`子进程没有退出码（signal=${signal}）—— 不能把"没跑完"读成"绑定拒绝了"`));
      done(resolve, { rc, out, err });
    });
  });
}

/** -File 语义 = 生产调用方式 */
const runFile = (exe, file, args) => run(exe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, ...args]);

/** 可用运行时（PS 5.1 只在 Windows 存在；pwsh 走 PATH 或 MCPS_PWSH7）
 *  ★两种拼写都试：本机 PATHEXT 曾被裁成 `.CPL`（宿主注入），此时裸名 `pwsh` 解析不了、
 *    带扩展名的 `pwsh.exe` 反而能起 —— 少试一种就会静默退化成"只覆盖 PS 5.1"。
 */
async function runtimes() {
  const out = [];
  const ps51 = process.env.MCPS_PS51
    || (process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : '');
  if (ps51 && fs.existsSync(ps51)) out.push({ name: 'ps51', exe: ps51 });
  const cands = [process.env.MCPS_PWSH7, 'pwsh', process.platform === 'win32' ? 'pwsh.exe' : null].filter(Boolean);
  for (const exe of [...new Set(cands)]) {
    try {
      const probe = await run(exe, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], 60000);
      if (probe.rc === 0) { out.push({ name: 'ps7', exe }); break; }
    } catch { /* 这个拼写起不来，试下一个 */ }
  }
  return out;
}

/** 断言：这次调用必须**在绑定阶段**失败，且 stderr 点名原因 */
function assertBindingRejected(r, label, pattern) {
  assert.ok(r.rc > 0, `${label}: rc=${r.rc} —— 未声明的开关没有被拒绝（F8 回归）`);
  assert.match(r.err, pattern, `${label}: rc≠0 但不是绑定失败 ⇒ 失败原因不对。stderr=${r.err.slice(0, 200)}`);
  assert.equal(/missing-required-parameter|U-142/.test(r.err + r.out), false, `${label}: 走到了产品参数校验（说明绑定没拒绝），口径不对`);
}

/** 源码 param 块里声明的参数名（每行形如 `[string]$Keyword,`）
 *  ★起点锚**行首** `param(`：头部注释里出现"简单 `param()` 块"这类散文是合法的，
 *    用 indexOf 全文找会从注释开始切，把 `$args` 之类算进来（run-tests.ps1 的 test-docs 就踩过这个坑）。
 */
function declaredParams(src) {
  const m = /^param\(/m.exec(src);
  if (!m) throw new Error('找不到行首 param( —— 入口参数块形状变了');
  const start = m.index;
  const end = src.indexOf('\n)\n', start);
  const block = src.slice(start, end);
  return [...block.matchAll(/^\s*\[[^\]\n]+\]\s*\$([A-Za-z_][A-Za-z0-9_]*)/gm)].map((m2) => m2[1]);
}

test('U-294-A 声明层：入口以 [CmdletBinding(PositionalBinding=$false)] 紧接 param(（注释里提到不算）', () => {
  assert.match(ENTRY_SRC, DECL, '入口缺 CmdletBinding(PositionalBinding=$false)：未声明的开关会再次静默落进 $args');
  // 负例①：拆掉真声明（头部注释里的那处字样仍在）⇒ 判据必须红
  const noDecl = ENTRY_SRC.replace(DECL, 'param(');
  assert.notEqual(noDecl, ENTRY_SRC, '变异未生效（DECL 没匹配到真声明）');
  assert.doesNotMatch(noDecl, DECL, '★判据被头部注释骗过：只留注释也能绿 ⇒ 判据锚错了位置');
  // 负例②：退化成 [CmdletBinding()]（放开位置绑定）⇒ 判据必须红
  const loose = ENTRY_SRC.replace('[CmdletBinding(PositionalBinding = $false)]\r\nparam(', '[CmdletBinding()]\r\nparam(')
    .replace('[CmdletBinding(PositionalBinding = $false)]\nparam(', '[CmdletBinding()]\nparam(');
  assert.notEqual(loose, ENTRY_SRC, '变异未生效（换行不可识别）');
  assert.doesNotMatch(loose, DECL);
  // 参数表解析自身要有执行标记：42 个不是硬编码，是"读出来的"（解析坏了要红，不能静默返回 0）
  const names = declaredParams(ENTRY_SRC);
  assert.ok(names.length >= 30, `param 块只解析出 ${names.length} 个参数 —— 解析可能失效（静默空表会让"逐个断言"变成空转）`);
  assert.ok(names.includes('Keyword') && names.includes('Serve'), 'param 解析结果里连 Keyword/Serve 都没有 ⇒ 解析锚错了');
});

test('U-294-B 行为层：双运行时下未知具名 / 历史拼写 / 裸位置参数一律在绑定阶段失败', async (t) => {
  const rts = await runtimes();
  assert.ok(rts.length > 0, '没有可用的 PowerShell 运行时（PS 5.1 / pwsh 都缺）⇒ 本门无法下结论');
  if (rts.length < 2) t.diagnostic(`仅 ${rts.map((r) => r.name).join(',')} 可用：本轮结论只覆盖该运行时`);
  for (const rt of rts) {
    assertBindingRejected(await runFile(rt.exe, ENTRY, ['-Zzzz']), `${rt.name}/-Zzzz`, /NamedParameterNotFound|parameter name 'Zzzz'/i);
    assertBindingRejected(await runFile(rt.exe, ENTRY, ['-CodeSearch']), `${rt.name}/-CodeSearch`, /NamedParameterNotFound|parameter name 'CodeSearch'/i);
    assertBindingRejected(await runFile(rt.exe, ENTRY, ['jwt']), `${rt.name}/裸位置参数`, /PositionalParameterNotFound|positional parameter cannot be found/i);
  }
});

test('U-294-C 阳性对照：合法参数照样绑得上，且主流程真的执行了（不是把绑定搞坏）', async (t) => {
  const rts = await runtimes();
  assert.ok(rts.length > 0, '没有可用的 PowerShell 运行时 ⇒ 本门无法下结论');
  if (rts.length < 2) t.diagnostic(`仅 ${rts.map((r) => r.name).join(',')} 可用：本轮结论只覆盖该运行时`);
  for (const rt of rts) {
    const r = await runFile(rt.exe, ENTRY, ['-Keyword', '', '-AsJson']);
    assert.ok(r.rc > 0, `${rt.name}: -Keyword '' -AsJson 应当按产品口径非零退出（缺关键词），实为 ${r.rc}`);
    assert.doesNotMatch(r.err, /NamedParameterNotFound|PositionalParameterNotFound|cannot be found/i,
      `${rt.name}: 合法参数被判成绑定失败 ⇒ 声明加错了（eg. 参数名拼错/被 common parameter 吃掉）`);
    const m = r.out.match(/\{[\s\S]*\}/);
    assert.ok(m, `${rt.name}: stdout 没有 JSON 信封 ⇒ 主流程没执行（body 被 CmdletBinding 打断了？）out=${r.out.slice(0, 120)}`);
    let env = null;
    try { env = JSON.parse(m[0]); } catch (e) { assert.fail(`${rt.name}: stdout 信封不是合法 JSON：${e.message}`); }
    assert.equal(env.error, 'missing-required-parameter', `${rt.name}: 信封 error 应为 missing-required-parameter，实为 ${env.error}`);
    assert.ok(VERSION, '入口里读不到 $VERSION（解析坏了 ⇒ 下一条断言会空转）');
    assert.match(String(env.version), VERSION_RE, `${rt.name}: 信封 version 应等于入口 $VERSION=${VERSION}（$ScriptDir/VERSION 解析被 CmdletBinding 影响？）`);
  }
});

test('U-294-D 运行面：Get-Command 参数表含 common 参数（CmdletBinding 生效）且覆盖 param 块全部声明', async (t) => {
  const rts = await runtimes();
  assert.ok(rts.length > 0, '没有可用的 PowerShell 运行时 ⇒ 本门无法下结论');
  if (rts.length < 2) t.diagnostic(`仅 ${rts.map((r) => r.name).join(',')} 可用：本轮结论只覆盖该运行时`);
  const declared = declaredParams(ENTRY_SRC);
  for (const rt of rts) {
    const r = await run(rt.exe, ['-NoProfile', '-Command', `(Get-Command -Name '${ENTRY.replace(/'/g, "''")}').Parameters.Keys -join ','`]);
    assert.equal(r.rc, 0, `${rt.name}: Get-Command 对入口失败：${String(r.err).slice(0, 200)}`);
    const keys = String(r.out).trim().split(',').filter(Boolean);
    assert.ok(keys.length >= declared.length, `${rt.name}: 只列出 ${keys.length} 个参数，少于源码声明 ${declared.length} 个`);
    // ① CmdletBinding 真的生效：common 参数在表里（简单 param 块没有它们）
    for (const c of ['Verbose', 'ErrorAction', 'WarningAction']) {
      assert.ok(keys.includes(c), `${rt.name}: 参数表缺 common 参数 ${c} ⇒ CmdletBinding 没生效（声明在注释里？）`);
    }
    // ② 每个声明都能绑：漏一个就是"声明了但绑不上"
    const missing = declared.filter((n) => !keys.includes(n));
    assert.deepEqual(missing, [], `${rt.name}: 源码声明了但运行时绑不上：${missing.join(', ')}`);
    // ③ 没有多出非 common 的未知参数（多出来说明有重复声明/脏 param 块）
    const COMMON = new Set(['Verbose', 'Debug', 'ErrorAction', 'WarningAction', 'InformationAction', 'ProgressAction',
      'ErrorVariable', 'WarningVariable', 'InformationVariable', 'OutVariable', 'OutBuffer', 'PipelineVariable']);
    const extra = keys.filter((k) => !COMMON.has(k) && !declared.includes(k));
    assert.deepEqual(extra, [], `${rt.name}: 参数表多出来源里没有的项：${extra.join(', ')}`);
  }
});

test('U-294-E dot-source 未受影响：MCPS_NO_MAIN=1 下点源入口仍能看见 lib 函数（620+ 个 PS 用例靠这条路）', async (t) => {
  const rts = await runtimes();
  assert.ok(rts.length > 0, '没有可用的 PowerShell 运行时 ⇒ 本门无法下结论');
  if (rts.length < 2) t.diagnostic(`仅 ${rts.map((r) => r.name).join(',')} 可用：本轮结论只覆盖该运行时`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'u294-'));
  const probe = path.join(tmp, 'ds.ps1');
  // ★路径**不写进探针正文**：本仓路径含中文，PS 5.1 对无 BOM 的 .ps1 按 ANSI 解码 ⇒ 中文字面量会烂成乱码
  //   （首次版本就这么红的：`. <乱码路径>` ⇒ CommandNotFound）。改成 -Target 传参，正文全 ASCII，不依赖 BOM 习惯。
  fs.writeFileSync(probe, [
    'param([string]$Target)',
    '$env:MCPS_NO_MAIN = "1"',
    '. $Target',
    '"DS_FN=" + [bool](Get-Command -Name \'Get-CoverageVerdict\' -ErrorAction SilentlyContinue)',
    '"DS_VER=" + $VERSION',
    '',
  ].join('\r\n'), 'utf8');
  try {
    for (const rt of rts) {
      const r = await runFile(rt.exe, probe, ['-Target', ENTRY]);
      assert.match(r.out, /DS_FN=True/, `${rt.name}: dot-source 后看不见 lib 函数 ⇒ 入口被 CmdletBinding 打断了。stderr=${r.err.slice(0, 300)}`);
      assert.ok(VERSION, '入口里读不到 $VERSION（解析坏了 ⇒ 下一条断言会空转）');
      assert.match(r.out, new RegExp('DS_VER=' + VERSION_RE.source), `${rt.name}: dot-source 后 $VERSION 不可见（作用域被改坏？）`);
    }
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 临时目录清不掉不影响结论 */ }
  }
});

test('U-294-F 负例（判据不是恒真）：同一套断言喂给没有 CmdletBinding 的最小脚本必须判红', async () => {
  const rts = await runtimes();
  assert.ok(rts.length > 0, '没有可用的 PowerShell 运行时 ⇒ 本门无法下结论');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'u294neg-'));
  const plain = path.join(tmp, 'plain.ps1');
  fs.writeFileSync(plain, ['param([string]$Keyword)', 'exit 0', ''].join('\r\n'), 'utf8');
  try {
    for (const rt of rts) {
      const r = await runFile(rt.exe, plain, ['-Zzzz']);
      assert.equal(r.rc, 0, `${rt.name}: 对照组（无 CmdletBinding）竟然非零退出 ⇒ 断言失去区分力，本门变成恒真`);
      assert.throws(() => assertBindingRejected(r, `${rt.name}/对照`, /NamedParameterNotFound/), assert.AssertionError,
        `${rt.name}: assertBindingRejected 对"没声明 CmdletBinding"的脚本没有报错 ⇒ 判据恒真`);
    }
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 同上 */ }
  }
});
