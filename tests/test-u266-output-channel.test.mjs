// U-266（2026-10-26）：输出通道纪律 —— 进度串不许进"值"的通道。
//
// 病灶（B2 期间被三条夹具各撞一次）：`Write-ColorOutput` 在输出被重定向时走 `Write-Output`，即**成功流**。
//   在 runspace 池里，成功流就是 `Invoke()` 的返回集合 ⇒ 引擎返回封套后集合变成 `[string, 封套]`
//   ⇒ `ConvertTo-EngineEnvelope` 见数组即判 `engine/0`。后果不是"多一行日志"，而是：
//     · 引擎成功却被记成旧契约（状态/原因码全丢）；
//     · 下游可能把 string 当结果项（某源贡献一条空壳的另一种形态）。
//   当时的处置是"夹具把 Write-ColorOutput 桩掉"——桩掉等于把被测路径换了一条，这类绿不算数。
//
// 修法：重定向时写 stderr（`[Console]::Error.WriteLine`）。成功流只承载值（封套 / JSON 载荷）。
//
// 门分三层（与 U-258 同构）：
//   A 静态：函数体里没有 `Write-Output`，有 `[Console]::Error.WriteLine`；`$AsJson` 早退保留
//   B 执行：探针**从产品文件里取函数原文**在 runspace 里跑（不是复制），读数必须 pollutions=0 且封套完整
//   C 变异：把那一行改回 `Write-Output` ⇒ 探针必须读到 pollutions=1（证明 B 不是恒真）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPwsh } from './r2-ps-run.mjs';
import { sourceAll } from './lib/source.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = path.join(ROOT, 'multi-platform-searcher.ps1');
const PROBE = path.join(ROOT, 'tests', 'u266-probe-output-channel.ps1');
const SRC = sourceAll(ROOT);

/** 去注释（只去整行 # 与行尾 #，够用且不误伤字符串里的 # —— 本函数体内没有）。 */
function stripPsComments(s) {
  return s.split(/\r?\n/).map((l) => l.replace(/(^|\s)#.*$/, '')).join('\n');
}

function fnBody(src, name) {
  const m = new RegExp('^function ' + name + '\\s*\\{', 'm').exec(src);
  if (!m) return null;
  const start = m.index;
  let i = src.indexOf('{', start), depth = 0, end = -1;
  for (let p = i; p < src.length; p++) {
    if (src[p] === '{') depth++;
    else if (src[p] === '}') { depth--; if (depth === 0) { end = p; break; } }
  }
  return end < 0 ? null : src.slice(start, end + 1);
}

async function probe(mainPath) {
  const args = ['-File', PROBE];
  if (mainPath) args.push('-Main', mainPath);
  const r = await runPwsh(args, { timeoutMs: 120000 });
  const lines = (r.stdout || '').split(/\r?\n/).filter((l) => l.trim().startsWith('{"redirected"'));
  assert.ok(lines.length, `探针未输出事实行（rc=${r.status}）；stdout=${(r.stdout || '').slice(-400)}；stderr=${(r.stderr || '').slice(-400)}`);
  return { facts: JSON.parse(lines[lines.length - 1]), rc: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

test('U-266-A 静态：Write-ColorOutput 只写 stderr，成功流不承载进度', () => {
  const body = fnBody(SRC, 'Write-ColorOutput');
  assert.ok(body, '找不到 Write-ColorOutput');
  const plain = stripPsComments(body);
  assert.match(plain, /\[Console\]::Error\.WriteLine\(\$Text\)/, '重定向分支必须写 stderr');
  assert.doesNotMatch(plain, /Write-Output/, '成功流里不许出现 Write-Output（它是 Invoke() 的返回值集合）');
  assert.match(plain, /if \(\$AsJson\) \{ return \}/, '-AsJson 必须仍然整段静音');
  assert.match(plain, /Write-Host \$Text -ForegroundColor \$Color/, '交互终端分支保持彩色 Write-Host');
});

test('U-266-A2 静态：产物走 Write-PayloadOutput；它不许出现在引擎与 HTTP 层（那里成功流=返回值）', () => {
  const body = fnBody(SRC, 'Write-PayloadOutput');
  assert.ok(body, '找不到 Write-PayloadOutput（产物/进度的分工不能只剩一半）');
  const plain = stripPsComments(body);
  assert.match(plain, /if \(\[Console\]::IsOutputRedirected\) \{ Write-Output \$Text \}/, '产物在重定向时必须进成功流，否则 > out.txt 是空文件');
  assert.match(plain, /if \(\$AsJson\) \{ return \}/, '-AsJson 下产物也不许混进 JSON');
  // 反向：引擎文件里出现它就会重演 U-266 的污染（引擎跑在 runspace 里，成功流=返回值）。
  const engines = fs.readdirSync(path.join(ROOT, 'engines')).filter((f) => f.endsWith('.ps1'));
  const offenders = engines.filter((f) => /Write-PayloadOutput/.test(fs.readFileSync(path.join(ROOT, 'engines', f), 'utf8')));
  assert.deepEqual(offenders, [], 'engines/** 不许用 Write-PayloadOutput: ' + offenders.join(','));
});

test('U-266-B 执行：runspace 内打一行进度后返回封套 —— 集合必须恰好一个封套', async () => {
  const { facts, stderr, stdout } = await probe();
  assert.equal(facts.redirected, true, '本门要求子进程 stdout 被重定向（否则测的是另一条分支）');
  assert.equal(facts.pollutions, 0, `进度串污染了结果集：${JSON.stringify(facts)}`);
  assert.equal(facts.outputCount, 1, 'runspace 输出集合必须只有一个对象');
  assert.equal(facts.envelopeIntact, true, '封套必须原样到达（否则 ConvertTo-EngineEnvelope 会判 engine/0）');
  assert.match(stderr, /PROGRESS-U266/, '进度串必须出现在 stderr（不许被吞掉）');
  assert.doesNotMatch(stdout, /PROGRESS-U266/, '进度串不许出现在 stdout');
  assert.equal(stdout.trim().split(/\r?\n/).filter((l) => l.trim()).length, 1, '探针自身 stdout 也只能有那一行 JSON');
});

test('U-266-C 变异：改回 Write-Output ⇒ 探针必须读到污染（证明 B 有判别力）', async () => {
  const patched = /if \(\[Console\]::IsOutputRedirected\) \{ \[Console\]::Error\.WriteLine\(\$Text\) \}/;
  assert.equal(SRC.match(new RegExp(patched.source, 'g')).length, 1, '锚点必须唯一命中，否则变异打在别处');
  const mutated = SRC.replace(patched, 'if ([Console]::IsOutputRedirected) { Write-Output $Text }');
  assert.notEqual(mutated, SRC, '变异没生效');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u266-'));
  const tmp = path.join(dir, 'mutant.ps1');
  fs.writeFileSync(tmp, mutated, 'utf8');
  try {
    const { facts } = await probe(tmp);
    assert.equal(facts.pollutions, 1, '变异后必须恰好一条字符串输出');
    assert.equal(facts.outputCount, 2, '变异后集合是 [string, 封套]');
    assert.equal(facts.envelopeIntact, false, '变异后封套不再"恰好一个" ⇒ 生产会判 engine/0');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
