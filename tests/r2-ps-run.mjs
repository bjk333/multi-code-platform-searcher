// R2 远端（2026-09-30）：门用的 PowerShell 子进程助手 —— 只用异步 spawn（宿主 node 垫片让 spawnSync 恒 EBUSY、rc=null，
//   会把"根本没跑"误判成"跑红了"；宿主收口 §5.5 发现 2）。判红一律"rc≠0 且出现约定失败标记"，判绿一律"rc=0 且出现完成标记"。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 宿主收口（2026-10-02）：控制台码页不是 UTF-8 的机器上（中文 Windows = cp936/GBK），PowerShell 子进程写往管道的
//   非 ASCII 输出是 GBK 字节；原先一律 setEncoding('utf8') 会把 `≠`/`一致`/`不在白名单` 这类**标记**打成 U+FFFD，
//   于是 rc 明明正确、标记却比不中 ⇒ 判红理由写成 "red for the wrong reason"（实测：r2m 两条例项假红）。
//   修法：收原始 Buffer，优先按 UTF-8 解；出现替换符再依次试 GBK 系码页（纯 ASCII 输出走第一条，行为不变）。
//   注意：主脚本 -AsJson 已在 main:3175 显式设 [Console]::OutputEncoding=UTF8，JSON 路径不受影响；此处只保护标记文本。
function decodeChildOutput(buf) {
  const utf8 = buf.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;
  for (const enc of ['gbk', 'big5', 'shift_jis']) {
    try { const t = new TextDecoder(enc).decode(buf); if (!t.includes('\uFFFD')) return t; } catch { /* 该 ICU 码页不可用 */ }
  }
  return utf8;
}

function once(exe, args, { cwd = rootDir, env = {}, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd, env: { ...process.env, ...env }, windowsHide: true });
    const out = [], err = [];
    let settled = false;
    const settle = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); fn(v); };
    // 超时：kill（尽力）→ **兜底 settle**（2026-10-12 宿主收口）
    //   背景：`close` 要等 stdio 管道**全部关闭**。若 pwsh 起了**孙进程**（node/python/网络等待）并继承管道，
    //   则父进程即使被杀，`close` 也**可能永不触发** ⇒ 本 Promise 悬挂 ⇒ 门在 `await` 处**永久挂死**
    //   （症状与 U-168「活体门挂死」、以及全量套件下 A-11 门卡在同一位置一致：进程无输出、字节数不再增长）。
    //   兜底：kill 后 5s 仍无 close ⇒ 强制 settle，**status 置 null** ⇒ 下游 assertRanRed/Green 会按
    //   "进程没跑完"处理（`typeof status !== 'number'` ⇒ 明确判红/失败），**不会冒充红或绿**。
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
      const grace = setTimeout(() => {
        settle(resolve, { exe, status: null, signal: 'SIGKILL-after-timeout', stdout: decodeChildOutput(Buffer.concat(out)), stderr: decodeChildOutput(Buffer.concat(err)) });
      }, 5000);
      if (typeof grace.unref === 'function') grace.unref();
    }, timeoutMs);
    child.stdout.on('data', c => { out.push(c); }); child.stderr.on('data', c => { err.push(c); });
    child.once('error', e => settle(reject, e));
    child.once('close', (status, signal) => {
      settle(resolve, { exe, status, signal, stdout: decodeChildOutput(Buffer.concat(out)), stderr: decodeChildOutput(Buffer.concat(err)) });
    });
  });
}

// pwsh 优先，回退 powershell；两者都起不来 ⇒ 明确失败（不静默跳过）
export async function runPwsh(args, opts = {}) {
  let last = null;
  for (const exe of ['pwsh', 'powershell']) {
    try { return await once(exe, ['-NoProfile', '-NonInteractive', ...args], opts); } catch (e) { last = e; }
  }
  assert.fail('no PowerShell (pwsh/powershell) could be spawned: ' + (last && last.message));
}

// 红：进程真的跑了（status 为数字，不是 null/信号）、rc≠0、且输出里有约定的失败标记
export function assertRanRed(r, marker, label = '') {
  assert.equal(typeof r.status, 'number', `${label}: process did not run to an exit code (status=${r.status}, signal=${r.signal}) — not evidence of red`);
  assert.notEqual(r.status, 0, `${label}: expected rc≠0`);
  const all = r.stdout + '\n' + r.stderr;
  assert.ok(marker instanceof RegExp ? marker.test(all) : all.includes(marker), `${label}: rc=${r.status} but failure marker ${marker} missing — red for the wrong reason?\n${all.slice(-600)}`);
}
// 绿：rc=0 且有完成标记
export function assertRanGreen(r, marker, label = '') {
  assert.equal(r.status, 0, `${label}: expected rc=0, got ${r.status}: ${(r.stderr || '').slice(-600)}`);
  const all = r.stdout + '\n' + r.stderr;
  assert.ok(marker instanceof RegExp ? marker.test(all) : all.includes(marker), `${label}: rc=0 but completion marker ${marker} missing`);
}
