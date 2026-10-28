// U-278（v1.60.0，B3-7）：**跨平台实跑记录** —— 把"在哪个平台上跑过"变成一份可核对的文件。
//
// 病在哪（B3-7 计划原文）："`crossplat.yml` 本地/容器跑一次，落 `reports/crossplat-<date>.json`；
//   否则 SKILL.md 标'未验证'"。当时的实际状态是：CI 只有 windows-latest（`.github/workflows/skill-regression.yml`），
//   `crossplat.yml` **不存在**，而 SKILL.md 的 compatibility 写的是
//   "Windows PowerShell 5.1 或 PowerShell 7+（pwsh）" —— 这句话读起来像"跨平台可用"，
//   但**没有任何一次实跑**支持它。文字承诺与实测证据之间隔着一条没人跨过的缝。
//
// 做法：不写"我相信它在 Linux 上能跑"，而是**跑一次并把环境事实一起记下来**。
//   `--profile=installed` 的子集（不读 reports/、不读 .gitignore/.github/父仓清单）是唯一
//   在"装好的副本"和"CI 容器"里都成立的门集，所以跨平台记录就用它 —— 口径与 CI 一致。
//
// ★记录里必须有三样东西，缺一样这张纸就不值钱：
//   ① **环境事实**（os/arch/node/pwsh 版本、路径分隔符、文件系统大小写敏感性）——
//      否则"绿"无法复现，也无法解释"为什么 Linux 红而 Windows 绿"。
//   ② **实际跑的命令与门数**——否则不知道"绿"覆盖了多少。
//   ③ **红的分区**（product / meta / env）——否则把"平台缺个二进制"读成"产品坏了"。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { GATE_FILES, META_FILES, runGates, mergeRecheck } from './run-node-gates.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 异步跑一条命令，拿 stdout（同步 spawn 在本仓是禁的：r2-spawn-hygiene 有明确理由） */
function run(cmd, args, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try { child = spawn(cmd, args, { windowsHide: true }); } catch (e) { return resolve({ ok: false, out: '', why: e.message }); }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { } }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    child.once('error', (e) => { clearTimeout(timer); resolve({ ok: false, out, why: e.message }); });
    child.once('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, out: out.trim(), code }); });
  });
}

/** 文件系统是否大小写敏感 —— 这是 Windows/Linux 最容易咬人的一处，必须实测而不是假设 */
function caseSensitivity() {
  const probe = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'u278-case-')), 'CaseProbe.txt');
  try {
    fs.writeFileSync(probe, 'x');
    return !fs.existsSync(probe.toLowerCase()) || probe.toLowerCase() === probe;
  } catch { return null; } finally {
    try { fs.rmSync(path.dirname(probe), { recursive: true, force: true }); } catch { }
  }
}

function factOf(pattern, text) {
  const m = String(text || '').match(pattern);
  return m ? m[1].trim() : null;
}

async function facts() {
  const ps = process.env.MCPS_PWSH || 'pwsh';
  const psVer = await run(ps, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()']);
  const gitVer = await run('git', ['--version']);
  return {
    os: { platform: process.platform, arch: process.arch, release: os.release() },
    node: process.version,
    pwsh: { cmd: ps, version: factOf(/^(\d+\.\d+\.\d+)/m, psVer.out), raw: psVer.ok ? null : psVer.out.slice(0, 200) },
    git: factOf(/git version ([0-9.]+)/, gitVer.out),
    pathSeparator: path.sep,
    caseSensitiveFs: caseSensitivity(),
    tmp: os.tmpdir(),
  };
}

function counts(output) {
  const grab = (label) => {
    const m = String(output).match(new RegExp('(?:^|\\n)(?:ℹ|#) ' + label + ' (\\d+)'));
    return m ? Number(m[1]) : null;
  };
  return { pass: grab('pass'), fail: grab('fail'), skipped: grab('skipped'), tests: grab('tests') };
}

/**
 * @param {{out?:string, mode?:string, gates?:string[], profile?:string}} opts
 */
export async function record({ out = null, mode = 'parallel', gates = null, profile = 'installed' } = {}) {
  const list = gates && gates.length ? gates.map((g) => path.resolve(ROOT, g)) : GATE_FILES;
  const f = await facts();
  const startedAt = new Date().toISOString();
  const first = await runGates({ files: list, cwd: ROOT, stdio: 'pipe', mode, metaFiles: META_FILES });
  let summary = first.summary;
  let recheck = null;

  // 与仓里的纪律一致：并行红只把失败文件串行复核一次（否则平台腔调与并发抖动分不开）
  let merged = null;
  if (mode !== 'serial' && (summary.product || []).length) {
    const files = [...new Set((summary.product || []).map((r) => r.file).filter(Boolean))];
    if (files.length) {
      recheck = await runGates({ files, cwd: ROOT, stdio: 'pipe', mode: 'serial', metaFiles: META_FILES });
      // ★`mergeRecheck` 返回的是 `{summary, rc, moved, kept}` **包装**，不是 summary。
      //   第一版直接 `summary = mergeRecheck(...)`，于是 productRed/metaRed/envRed 全是 undefined，
      //   而 verdict 里的 `?? 0` 把"没有数字"读成了 green —— 一次货真价实的**假绿**。
      //   这条错误是"用真实全量跑记录"时才暴露的：单门跑不会进复核分支。
      merged = mergeRecheck(first, recheck, { metaFiles: META_FILES });
      summary = merged.summary;
    }
  }

  // ★fail-closed：三个计数必须都是整数。缺一个就抛，绝不默认成 0 ——
  //   记录的价值全在"数字是真的"，宁可让采集器崩掉。
  for (const k of ['productRed', 'metaRed', 'envRed']) {
    if (!Number.isInteger(summary[k])) throw new Error(`采集器内部错误：summary.${k} 不是整数（${summary[k]}）—— 拒绝写出一份无法核对的记录`);
  }

  const c = counts(first.output);
  const verdict = summary.productRed > 0 ? 'red' : (summary.metaRed > 0 ? 'meta-red' : (summary.envRed > 0 ? 'env-red' : 'green'));
  const doc = {
    schema: 'u278-crossplat/1',
    at: startedAt,
    finishedAt: new Date().toISOString(),
    profile,
    command: `node tests/run-node-gates.mjs --profile=${profile}`,
    facts: f,
    gates: list.length,
    runMode: summary.runMode,
    concurrency: summary.concurrency ?? null,
    counts: c,
    summary: {
      productRed: summary.productRed,
      metaRed: summary.metaRed ?? null,
      envRed: summary.envRed,
      envByKind: summary.envByKind || {},
      voided: !!summary.voided,
      hung: !!summary.hung,
    },
    verdict,
    reds: {
      product: (summary.product || []).map((r) => ({ name: r.name, file: r.file ? path.basename(r.file) : null, why: r.why })),
      meta: (summary.meta || []).map((r) => ({ name: r.name, file: r.file ? path.basename(r.file) : null, why: r.why })),
      env: (summary.env || []).map((r) => ({ name: r.name, file: r.file ? path.basename(r.file) : null, kind: r.kind, why: r.why })),
    },
    rechecked: merged
      ? {
        ran: true,
        movedToEnv: merged.moved || [],
        kept: merged.kept || [],
        note: '并行红已按仓里纪律串行复核一次；movedToEnv 是"并行红、单跑绿"，kept 是复核后仍红',
      }
      : null,
  };
  if (out) {
    fs.mkdirSync(path.dirname(path.resolve(ROOT, out)), { recursive: true });
    fs.writeFileSync(path.resolve(ROOT, out), JSON.stringify(doc, null, 2) + '\n', 'utf8');
  }
  return doc;
}

// ---- CLI ----
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const arg = (k, d = null) => {
    const i = argv.indexOf('--' + k);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
  };
  const out = arg('out', null);
  const mode = arg('mode', 'parallel');
  const gates = arg('gates', null);
  record({ out, mode, gates: gates ? gates.split(',') : null }).then((doc) => {
    console.error(`[U-278] ${doc.facts.os.platform}/${doc.facts.os.arch} node ${doc.facts.node} pwsh ${doc.facts.pwsh.version} ⇒ ${doc.verdict}` +
      `（product=${doc.summary.productRed} meta=${doc.summary.metaRed} env=${doc.summary.envRed}, gates=${doc.gates}）`);
    for (const r of doc.reds.product) console.error('  product: ' + r.name + (r.file ? ' @ ' + r.file : '') + ' — ' + r.why);
    if (out) console.error('[U-278] 写入 ' + out);
    process.exitCode = doc.verdict === 'green' ? 0 : (doc.verdict === 'red' ? 1 : 3);
  });
}
