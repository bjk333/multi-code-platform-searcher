// R94/R95 远端 R1（2026-09-30）：PowerShell 纯函数探针 + 源内变异（mutation）驱动器。
// 目的（任务书 §〇-8 / K）：新门必须"能弄红"。PowerShell 无原生变异工具 ⇒ 在**同一 pwsh 进程**里：
//   ① dot-source 主脚本（MCPS_NO_MAIN=1），跑 probe 得 real；
//   ② 对每个 mutant：从主脚本 AST 取目标函数原文 → 做一处字面替换 → Invoke-Expression 重定义 → 跑同一 probe → 恢复原定义。
// 替换未命中（find 不在函数体内）⇒ 该 mutant 记 _notApplied，调用方必须判红（防"变异写错了却显示被杀"）。
// 结果经 UTF-8 无 BOM 临时文件回传（避开控制台编码），临时文件用后即删。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sourceAll } from './lib/source.mjs';

export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MAIN = path.join(rootDir, 'multi-platform-searcher.ps1');

// v1.54.0（B3-2）：产品源码按「加载后视图」读（主脚本 + lib/*.ps1 + engines/*.ps1）。
//   静态门断言的是"产品里有没有这段逻辑"，不是"它在哪个文件"；只读主脚本会在拆分后变成永远匹配不到的假红/假绿。
export function PRODUCT_SRC() { return sourceAll(rootDir); }

function runPs(exe, script, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, ['-NoProfile', '-NonInteractive', '-Command', script], { cwd: rootDir, env: { ...process.env, MCPS_NO_MAIN: '1' } });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', c => { stdout += c; }); child.stderr.on('data', c => { stderr += c; });
    child.once('error', e => { clearTimeout(timer); reject(e); });
    child.once('close', status => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

const q = s => "'" + String(s).replace(/'/g, "''") + "'";

// probe: PowerShell 脚本体（返回一个可序列化对象）；mutants: [{ name, fn, find, replace }]
export async function probeWithMutants(probe, mutants = [], { timeoutMs = 120000 } = {}) {
  const tag = crypto.randomBytes(6).toString('hex');
  const specPath = path.join(os.tmpdir(), `r94probe-${tag}.json`);
  const outPath = path.join(os.tmpdir(), `r94probe-${tag}.out.json`);
  fs.writeFileSync(specPath, JSON.stringify({ probe, mutants }), 'utf8');
  const script = `
$ErrorActionPreference = 'Stop'
. ${q(MAIN)} -NoEnvFile -AsJson -Keyword x -Limit 1
$spec = [System.IO.File]::ReadAllText(${q(specPath)}) | ConvertFrom-Json
$src = [System.IO.File]::ReadAllText(${q(MAIN)})
# v1.54.0（B3-2）：函数已搬进 lib/ ⇒ 变异取函数原文的 AST 必须建在"主脚本 + lib/*.ps1"上，
#   否则 __FnText 一律取不到 ⇒ 所有变异记为 _notApplied（门会红在"mutants not applied"）。
$__lib = Join-Path (Split-Path -Parent ${q(MAIN)}) 'lib'
if (Test-Path -LiteralPath $__lib -PathType Container) { foreach ($__f in (Get-ChildItem -LiteralPath $__lib -Filter '*.ps1' -File | Sort-Object Name)) { $src += ([string][char]10) + [System.IO.File]::ReadAllText($__f.FullName) } }
$ast = [System.Management.Automation.Language.Parser]::ParseInput($src, [ref]$null, [ref]$null)
function __FnText([string]$n) { $f = $ast.FindAll({ param($x) $x -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $x.Name -eq $n }, $true) | Select-Object -First 1; if ($f) { $f.Extent.Text } else { $null } }
$probeSb = [scriptblock]::Create([string]$spec.probe)
$out = [ordered]@{ real = (& $probeSb); mutants = [ordered]@{} }
foreach ($m in @($spec.mutants)) {
  $orig = __FnText $m.fn
  if (-not $orig -or -not $orig.Contains([string]$m.find)) { $out.mutants[$m.name] = [ordered]@{ _notApplied = $true }; continue }
  $mut = $orig.Replace([string]$m.find, [string]$m.replace)
  Invoke-Expression $mut
  try { $out.mutants[$m.name] = (& $probeSb) } catch { $out.mutants[$m.name] = [ordered]@{ _threw = $_.Exception.Message } }
  Invoke-Expression $orig
}
[System.IO.File]::WriteAllText(${q(outPath)}, ($out | ConvertTo-Json -Depth 12), [System.Text.UTF8Encoding]::new($false))
'R94PROBE-DONE'
`;
  let last = null, r = null;
  try {
    for (const exe of ['pwsh', 'powershell']) { try { r = await runPs(exe, script, timeoutMs); break; } catch (e) { last = e; } }
    if (!r) assert.fail('no PowerShell found: ' + (last && last.message));
    assert.equal(r.status, 0, 'pwsh probe failed: ' + r.stderr.slice(0, 800));
    assert.match(r.stdout, /R94PROBE-DONE/, 'probe did not finish: ' + r.stdout.slice(-400));
    return JSON.parse(fs.readFileSync(outPath, 'utf8'));
  } finally {
    for (const p of [specPath, outPath]) { try { fs.unlinkSync(p); } catch {} }
  }
}

// 每个 mutant 必须 (a) 真的被施加 (b) 让 check 抛错 —— 返回 { killed, survived, notApplied } 供回报计数
export function assertMutantsKilled(result, check) {
  const tally = { killed: [], survived: [], notApplied: [] };
  // 基线必须先过：否则所有 mutant 都会『被杀』，击杀数是空转（R1 实测踩过：bigram 基线红时 12/12 照样全杀）
  check(result.real, '(baseline)');
  for (const [name, val] of Object.entries(result.mutants || {})) {
    if (val && val._notApplied) { tally.notApplied.push(name); continue; }
    let threw = false;
    try { check(val, name); } catch { threw = true; }
    (threw ? tally.killed : tally.survived).push(name);
  }
  assert.deepEqual(tally.notApplied, [], 'mutants not applied (find text missing): ' + tally.notApplied.join(','));
  assert.deepEqual(tally.survived, [], 'mutants SURVIVED (gate cannot turn red): ' + tally.survived.join(','));
  console.log(`[R94-mutation] killed=${tally.killed.length}/${Object.keys(result.mutants || {}).length} ${tally.killed.join(',')}`);
  return tally;
}
