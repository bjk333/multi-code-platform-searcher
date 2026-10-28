// U-132：Invoke-ApiRequest 的 Latin-1→UTF-8 重解码只对"确为 Latin-1 解码产物"的文本生效；已正确解码的 CJK 不得被折成 '?'。
// 预注册：reports/U-132-预注册判据-2026-09-28.md P1–P3 + 负例。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sourceAll } from './lib/source.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = path.join(rootDir, 'multi-platform-searcher.ps1');
const mainSrc = sourceAll(rootDir);

// ★2026-10-25（全量门禁三次"在 256/337 绿处挂住"的**真因**，与本门的断言内容无关）：
//   原实现只 `setTimeout(() => child.kill('SIGKILL'), 90000)` 然后等 `child.once('close')`。
//   在 Windows 上这有两个叠加的坑：
//     ① `kill('SIGKILL')` 只杀 **pwsh 本身**，杀不掉它起的孙进程（主脚本里的 curl/node 请求）；
//     ② `close` 事件等的是 **stdio 管道关闭**，而管道会被孙进程继承 ⇒ 孙进程活着，`close` 永不触发；
//   结果：`runPs` 返回的 Promise **永远 pending** ⇒ 这个用例永不完成 ⇒ 该文件的 node 子进程永不退出
//   ⇒ `node --test` 等它 ⇒ **整个全量 run 挂住**（实测 CPU 零增长、无子进程，纯等）。
//   实测对照：同一文件单跑 2.8s / 4 用例全绿；全量并发时挂 20 分钟以上。
//   修法：超时时用 `taskkill /T /F` **杀整棵进程树**，并且**主动 settle**（reject），不再依赖 close 事件。
//   为什么这点很重要：门禁的"卡住"被反复归因为"网络慢/环境抖动"，实际是**测试自己的进程管理有洞** ——
//   而这类洞只在并发 + 网络受限时显形，单跑永远复现不了。
function runPs(exe, script, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, ['-NoProfile', '-NonInteractive', '-Command', script], { cwd: rootDir, env: { ...process.env, MCPS_NO_MAIN: '1' } });
    let stdout = '', stderr = '';
    let settled = false;
    const finish = (fn, arg) => { if (settled) return; settled = true; clearTimeout(timer); fn(arg); };
    const timer = setTimeout(() => {
      // 先杀整棵树（/T），再兜底 kill 自己；无论 close 是否触发，都必须 settle
      try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).unref(); } catch { }
      try { child.kill('SIGKILL'); } catch { }
      const e = new Error(`${exe} timed out after ${timeoutMs}ms (process tree killed)`);
      e.code = 'ETIMEDOUT';
      finish(reject, e);
    }, timeoutMs);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', c => { stdout += c; }); child.stderr.on('data', c => { stderr += c; });
    child.once('error', e => { finish(reject, e); });
    child.once('close', status => { finish(resolve, { status, stdout, stderr }); });
  });
}
async function runAny(script) {
  let last = null;
  for (const exe of ['pwsh', 'powershell']) {
    try { return await runPs(exe, script); }
    catch (e) {
      // ★超时**不换 exe**：慢/挂来自环境与进程树，换一个解释器只会把 90s 变成 180s。
      if (e.code === 'ETIMEDOUT') throw e;
      last = e;   // 只有"这个 exe 根本起不来"（ENOENT 等）才换
    }
  }
  assert.fail('no PowerShell found: ' + (last && last.message));
}
// 结果经 -OutFile 风格直写 UTF-8 文件再读，避免控制台编码干扰（R69 A1 同口径）
const SCRIPT = `
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
. '${MAIN.replace(/'/g, "''")}' -NoEnvFile -AsJson -Keyword x -Limit 1
$good = [string]::Join('', [char]0x4EAC, [char]0x4E1C, [char]0x96F6, [char]0x552E)   # 京东零售
$moji = [System.Text.Encoding]::GetEncoding(28591).GetString([System.Text.Encoding]::UTF8.GetBytes($good))  # PS5.1 式乱码
$latin = 'caf' + [char]0xE9
$old = [System.Text.Encoding]::UTF8.GetString([System.Text.Encoding]::GetEncoding(28591).GetBytes($good))   # 旧无条件逻辑
$o = [ordered]@{ p1 = (Repair-Latin1Mojibake -Text $good); p2 = (Repair-Latin1Mojibake -Text $moji); p3 = (Repair-Latin1Mojibake -Text $latin); neg_old = $old; good = $good; latin = $latin }
$tmp = [System.IO.Path]::GetTempFileName(); [System.IO.File]::WriteAllText($tmp, ($o | ConvertTo-Json -Compress), [System.Text.UTF8Encoding]::new($false)); $tmp
`;
let cache = null;
async function results() {
  if (cache) return cache;
  const r = await runAny(SCRIPT);
  assert.equal(r.status, 0, 'pwsh failed: ' + r.stderr.slice(0, 600));
  const tmp = r.stdout.trim().split(/\r?\n/).pop();
  cache = JSON.parse(fs.readFileSync(tmp, 'utf8')); try { fs.unlinkSync(tmp); } catch {}
  return cache;
}

test('U-132: Invoke-ApiRequest routes its Latin-1 repair through Repair-Latin1Mojibake (static)', () => {
  assert.match(mainSrc, /function Repair-Latin1Mojibake/);
  assert.match(mainSrc, /Content = \(Repair-Latin1Mojibake -Text \$r\.Content\)/);
  assert.doesNotMatch(mainSrc, /\$rawBytes = \$latin1\.GetBytes\(\$r\.Content\)/, 'the unconditional re-decode must be gone from Invoke-ApiRequest');
});
test('U-132 P1: already-decoded CJK is returned unchanged (old unconditional logic folded it to ????)', async () => {
  const o = await results();
  assert.equal(o.p1, o.good);
  assert.equal(o.neg_old, '????', 'negative control: the old logic must demonstrably destroy CJK, got ' + JSON.stringify(o.neg_old));
});
test('U-132 P2: PS5.1-style Latin-1 mojibake of UTF-8 bytes is still repaired to CJK', async () => {
  const o = await results();
  assert.equal(o.p2, o.good);
});
test('U-132 P3: genuine Latin-1 text (café) is left alone, no U+FFFD introduced', async () => {
  const o = await results();
  assert.equal(o.p3, o.latin);
  assert.doesNotMatch(o.p3, /\uFFFD/);
});
