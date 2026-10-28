// U-177：403 必须区分「配额耗尽（rate-limited）」与「能力关闭（forbidden）」—— 跨层不得丢语义
//   背景（2026-10-19）：Invoke-ApiRequest 在 403 限流且重试耗尽后重抛 "重试次数耗尽: … (last HTTP 403)"
//   ⇒「这是限流」在层边界被丢弃 ⇒ 引擎只能看到 403 ⇒ 误判成 forbidden / error。
//   修法：边界消息带 ', rate-limit' 标记；引擎按标记分流；GitLab 的 Forbidden 判定排除限流。
//
//   三条证据臂（都不打外网）：
//     A · 桩跑两个引擎的 catch（tests/u177-ratelimit-classify-harness.ps1）
//     B · **本地 403 服务器**真跑 Invoke-ApiRequest（验证边界标记本身，非源码推断）
//     C · 源码契约（标记只对 403/429、GitLab 排除限流、D4 仍 ≤100 行）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runPwsh } from './r2-ps-run.mjs';
import { sourceAll } from './lib/source.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HARNESS = path.join(ROOT, 'tests', 'u177-ratelimit-classify-harness.ps1');
const MAIN = sourceAll(path.join(ROOT));
const GHCODE = fs.readFileSync(path.join(ROOT, 'engines', 'github-code.ps1'), 'utf8');
const GLBLOBS = fs.readFileSync(path.join(ROOT, 'engines', 'gitlab-blobs.ps1'), 'utf8');

test('U-177 A: 桩跑引擎 catch —— 限流报 rate_limited，真 403 报 error（两向）', async () => {
  const r = await runPwsh(['-File', HARNESS], { cwd: ROOT, timeoutMs: 180000 });
  const out = (r.stdout || '') + (r.stderr || '');
  assert.equal(r.status, 0, `夹具必须 rc=0，实际 ${r.status}\n${out.slice(-600)}`);
  assert.match(out, /U177 A_ghcode_ratelimit=rate_limited/, 'GitHubCode + 限流标记 ⇒ rate_limited');
  assert.match(out, /U177 B_ghcode_plain403=error/, '★ 负例：GitHubCode + 无标记 403 ⇒ 不得说成限流');
  assert.match(out, /U177 C_gitlab_ratelimit=rate_limited/, 'GitLabBlobs + 限流标记 ⇒ rate_limited');
  assert.match(out, /U177 D_gitlab_forbidden=error/, '★ 负例：GitLab 真 403 ⇒ 仍 error（能力关闭未被吞成限流）');
  assert.match(out, /U177_PASS/);
});

// ───────────────────────── B · 本地 403 服务器 ─────────────────────────
let server;
let port;
const hits = [];

before(async () => {
  server = http.createServer((req, res) => {
    hits.push(req.url);
    if (req.url === '/rl') {
      res.writeHead(403, { 'x-ratelimit-remaining': '0', 'content-type': 'application/json' });
      res.end('{"message":"API rate limit exceeded"}');
    } else if (req.url === '/retryafter') {
      res.writeHead(403, { 'x-ratelimit-remaining': '0', 'Retry-After': '3600', 'content-type': 'application/json' });
      res.end('{"message":"API rate limit exceeded"}');
    } else {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end('{"message":"Forbidden"}');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(() => { try { server.close(); } catch {} });

function runPs(code) {
  const f = path.join(os.tmpdir(), `u177-${process.pid}-${Math.random().toString(36).slice(2)}.ps1`);
  fs.writeFileSync(f, code, 'utf8');
  return new Promise((resolve) => {
    const p = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-File', f], { cwd: ROOT, windowsHide: true });
    let out = '';
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; try { fs.unlinkSync(f); } catch {} resolve(v); } };
    const t = setTimeout(() => { try { p.kill(); } catch {} done(out + '\n[timeout]'); }, 180000);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('error', (e) => { clearTimeout(t); done('spawn error: ' + e.message); });
    p.on('close', () => { clearTimeout(t); done(out); });
  });
}

test('U-177 B: 真跑 Invoke-ApiRequest —— 403+配额头 ⇒ 消息带 rate-limit；无头 ⇒ 不带', async () => {
  const code = [
    "$env:MCPS_NO_MAIN = '1'",
    `. "${path.join(ROOT, 'multi-platform-searcher.ps1').replace(/\\/g, '\\\\')}"`,
    'function MsgOf($u) { try { $null = Invoke-ApiRequest -Uri $u -Headers @{} -TimeoutSec 5 -MaxAttempts 1 -NoProxy } catch { return "$_" } return "" }',
    `Write-Output ("RL=" + (MsgOf 'http://127.0.0.1:${port}/rl'))`,
    `Write-Output ("PLAIN=" + (MsgOf 'http://127.0.0.1:${port}/plain'))`,
    `Write-Output ("RA=" + (MsgOf 'http://127.0.0.1:${port}/retryafter'))`,
  ].join('\n');
  const out = await runPs(code);
  const line = (p) => (out.split(/\r?\n/).find((l) => l.startsWith(p)) || '');
  const rl = line('RL=');
  const plain = line('PLAIN=');
  const ra = line('RA=');
  assert.ok(rl, `未取到 RL 行（脚本可能没跑起来）\n${out.slice(-500)}`);
  assert.match(rl, /rate-limit/, '★ 403 + x-ratelimit-remaining:0 且重试耗尽 ⇒ 消息必须带 rate-limit 标记');
  assert.doesNotMatch(plain, /rate-limit/, '★ 负例：无配额头的 403 不得被标成限流');
  assert.match(ra, /Retry-After|rate-limit/, 'Retry-After 路径必须保留限流语义（TooLong 或标记）');
});

test('U-177 C: 源码契约 —— 标记只对 403/429；GitLab Forbidden 排除限流；D4 仍 ≤100 行', () => {
  // 标记只对 403/429（5xx 不得带限流语义）
  assert.match(MAIN, /if \(\$isRetryable -and \[int\]\$resp\.StatusCode -in @\(403, 429\)\) \{ \$lastRl = \$true \}/, '必须仅在 403/429 置标记');
  // 限流单独抛带标记的消息；**其余情况保持 D4 钉住的原文**（不改门去迁就实现）
  assert.match(MAIN, /if \(\$lastRl\) \{ throw "重试次数耗尽: \$Uri \(last HTTP \$lastHttpCode, rate-limit\)" \}/, '限流必须抛带 rate-limit 的消息');
  assert.ok(MAIN.includes('throw "重试次数耗尽: $Uri (last HTTP $lastHttpCode)"'), '★ 非限流分支必须保留 D4 钉住的原文');
  // 引擎分流
  assert.match(GHCODE, /isRl.*rate-limit/, 'GitHubCode 必须按 rate-limit 标记分流');
  assert.match(GHCODE, /'rate_limited'/, 'GitHubCode 必须报 rate_limited');
  assert.match(GLBLOBS, /if \(-not \$is429\) \{ \$is429 = \("\$_"\) -match 'rate-limit' \}/, 'GitLabBlobs 必须在原正则**之外**补 rate-limit（保住 M4 变异夹具的原文锚点）');
  // GitLab 的 Forbidden 不得吞掉限流
  assert.match(MAIN, /\$isRlErr = \("\$_"\) -match 'rate-limit\|\\b429\\b\|限流'/, '必须先判定是否限流');
  assert.match(MAIN, /if \(-not \$isRlErr -and \("\$_" -match '\\b403\\b\|forbidden\|禁止\|disabled for this scope'\)\) \{ \$St\.Forbidden = \$true \}/, '★ 403 若是限流则不得标 Forbidden');
  // D4：Invoke-ApiRequest 仍 ≤100 行
  const lines = MAIN.split(/\r?\n/);
  const i = lines.findIndex((l) => l.startsWith('function Invoke-ApiRequest'));
  let end = -1;
  for (let j = i + 1; j < lines.length; j++) { if (lines[j] === '}') { end = j; break; } }
  assert.ok(i > 0 && end > i, '定位 Invoke-ApiRequest 失败');
  assert.ok(end - i <= 100, `D4：Invoke-ApiRequest 不得超过 100 行，实际 ${end - i}`);
});
