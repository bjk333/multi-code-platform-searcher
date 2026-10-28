// U-186（2026-10-20 审计 P2）：`-LocalCodeSearch` 命中时的 **coverage 口径**门。
//
// 病灶：本地通道命中后远端 code 源**根本没有被调用**（见主脚本 code 分支的 else），却仍进 `Requested`
// ⇒ 被记 `not-run` ⇒ `Verdict=degraded` / `exit 4`。实测（本地 3 条命中）：
//   Requested 5 / Executed ['LocalCode'] / Degraded [] / Verdict degraded / exit 4
// —— 用户会以为"本地结果不可信"，而实际上本地是成功的。
//
// 修法：`$localCodeTookOver` 记录"本地通道确实接管"这一事实，`Requested` 据此过滤远端 code 源。
// ⚠ 不是把 `not-run` 一律不计降级 —— 那是 P0-D 为「池提前收工静默丢源」设的防线（真实缺陷），
//   本门只保证"本地接管"这一条路径上 Requested 如实反映实际参与者。
//
// 本门是回归锚：无变异臂（守卫点是一段控制流，mutate 需要跑整条端到端链路，代价远大于收益）。
// 纯函数级守卫见 U-184 / U-185。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PY as PY_EXE } from './lib/interp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'mcps.py');
const PY = PY_EXE;

function runCli(args, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const child = spawn(PY, [CLI, ...args], { cwd: ROOT, windowsHide: true });
    let out = '', err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', c => { out += c; });
    child.stderr.on('data', c => { err += c; });
    child.once('error', e => { clearTimeout(timer); reject(e); });
    child.once('close', status => { clearTimeout(timer); resolve({ status, out, err }); });
  });
}

test('U-186 -LocalCodeSearch 命中时 Requested 只含 LocalCode、Verdict=full、exit=0', async (t) => {
  const tag = crypto.randomBytes(4).toString('hex');
  const outPath = path.join(os.tmpdir(), `u186-${tag}.json`);
  try {
    const r = await runCli([
      '-LocalCodeSearch', '-CodeEvidence',
      '-LocalPath', path.join(ROOT, 'engines'),
      '-Keyword', 'Set-EngineStatus',
      '-Limit', '2', '-AsJson', '-NoCache',
      '--out', outPath,
    ]);
    assert.ok(fs.existsSync(outPath), `CLI 未产出 JSON（rc=${r.status}）: ${r.err.slice(0, 400)}`);
    const doc = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    const cov = doc.coverage;
    const executed = (cov.Executed || []).map(String);

    // 本地通道没跑起来（rg/ugrep 缺失、或路径不可读）⇒ 本门不适用，跳过而不是假绿
    if (!executed.includes('LocalCode')) {
      t.skip(`LocalCode 未执行（Executed=${executed.join(',') || '(空)'}），本门跳过`);
      return;
    }
    // 本地 0 命中时会**主动降级远端**，那是另一条路径（远端真的参与），不属本门断言范围
    if (!(doc.results || []).length) {
      t.skip('本地 0 命中（会降级远端），本门只守"本地命中"路径');
      return;
    }

    assert.deepEqual(
      (cov.Requested || []).map(String), ['LocalCode'],
      `本地命中时 Requested 必须只含 LocalCode，实得 ${JSON.stringify(cov.Requested)}`
    );
    assert.equal(cov.Verdict, 'full', `本地命中应判 full，实得 ${cov.Verdict}`);
    assert.equal(doc.metrics?.ExitCode, 0, `本地命中应 exit 0，实得 ${doc.metrics?.ExitCode}`);
    assert.ok(
      (doc.warnings || []).some(w => /远端 code 源本次未参与/.test(String(w))),
      'warnings 里应有「远端 code 源本次未参与」的说明（不静默跳过）'
    );
  } finally {
    try { fs.unlinkSync(outPath); } catch { /* 不存在即忽略 */ }
  }
});
