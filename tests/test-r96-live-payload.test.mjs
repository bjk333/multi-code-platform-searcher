// R2 远端（2026-09-30）：活体 payload 门 —— 真跑主脚本 -AsJson，拿**进程 stdout** 做 schema + 严格字符 + completeness 自洽 + 键集覆盖。
//   动因（宿主收口 §4 变异抽检）：删掉 completeness 接线后，u123/u130/u134 全绿，只有 H 门（源码字面量）红 ⇒ 静态门看不见运行时漂移。
//   隔离：在 os.tmpdir 副本里跑（search_cache.json 写 ScriptDir，不能落进真实树）；-NoEnvFile -NoCache；MCPS_DISABLE=全部注册引擎 ⇒ 不触网。
//   L1 离线 repo 模式（零结果路径，Verdict=none 也必须合约）；L2 本地代码证据（有 rg 才跑，fixture 带 ZW/双向隔离/Tag 字符）。
//   变异体（临时副本注入、并发跑）：M1 删 completeness 接线 / M2 删 metrics.SpanStatus / M3 Local 条目混入 Stars / M4 completeness 候选数写死 0。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rootDir, runPwsh } from './r2-ps-run.mjs';
import { schema, validate, assertStrictJsonText } from './asjson-validator.mjs';
import { sourceAll } from './lib/source.mjs';

// u159 本机经验：**不用 fs.cpSync** —— 非 ASCII 源路径（`<workspace>/…`）上 node 原生崩溃（0xC0000409），
//   会把「门没跑」伪装成产品红。改逐文件递归复制（与 test-gitlab-budget-ci / test-u158e 同一写法）。
function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyTree(s, d);
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}
const mainSrc = sourceAll(path.join(rootDir));
const localSrc = fs.readFileSync(path.join(rootDir, 'engines', 'local-code.ps1'), 'utf8');
const reg = mainSrc.slice(mainSrc.indexOf('$script:_engineRegistry = @('), mainSrc.indexOf('\n)\n', mainSrc.indexOf('$script:_engineRegistry = @(')));
export const ENGINE_NAMES = [...reg.matchAll(/@\{ Name = '([A-Za-z]+)';/g)].map(m => m[1]);
const payloadLine = mainSrc.split('\n').find(l => l.includes('$payload = [PSCustomObject]@{'));
// v1.47.3：键集必须**按大括号深度**切分 —— 旧实现用 `(?:^|;)\s*name =` 裸匹配，
//   于是 `counts = [PSCustomObject]@{ repo = …; code = …; research = … }` 里的子键被当成顶层键，
//   活体门报 "payload keys missing vs source literal: code"（子键当然不在顶层）。与 U-89 的 literalKeys 同口径。
export function topLevelKeys(expr) {
  const parts = []; let depth = 0, start = 0;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') { depth--; if (depth < 0) break; }
    else if (c === ';' && depth === 0) { parts.push(expr.slice(start, i)); start = i + 1; }
  }
  parts.push(expr.slice(start));
  return parts.map(p => (/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(p) || [])[1]).filter(Boolean);
}
export const PAYLOAD_KEYS = topLevelKeys(payloadLine.slice(payloadLine.indexOf('@{') + 2));
{
  // 自检：子键不得泄漏进顶层；新增的 5 个载荷键必须都在
  // 只能用 counts 独有的子键判定（research 同时也是顶层键，不能当泄漏指标）
  const leaked = PAYLOAD_KEYS.filter(k => ['repo', 'code'].includes(k));
  if (leaked.length) throw new Error('PAYLOAD_KEYS 解析把 counts 子键当成了顶层键: ' + leaked.join(','));
  for (const k of ['modes', 'queryType', 'planSource', 'autoKeyword', 'counts', 'coverage', 'metrics']) {
    if (!PAYLOAD_KEYS.includes(k)) throw new Error('PAYLOAD_KEYS 缺顶层键: ' + k);
  }
}

function makeTree(tag, edits = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `r96live-${tag}-`));
  for (const d of ['engines', 'schema']) copyTree(path.join(rootDir, d), path.join(dir, d));
  for (const f of ['query-planner.ps1']) if (fs.existsSync(path.join(rootDir, f))) fs.copyFileSync(path.join(rootDir, f), path.join(dir, f));
  fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
  if (fs.existsSync(path.join(rootDir, 'tools', 'node-https-engine.mjs'))) fs.copyFileSync(path.join(rootDir, 'tools', 'node-https-engine.mjs'), path.join(dir, 'tools', 'node-https-engine.mjs'));
  if (fs.existsSync(path.join(rootDir, 'tools', 'bin'))) copyTree(path.join(rootDir, 'tools', 'bin'), path.join(dir, 'tools', 'bin'));
  const files = { 'multi-platform-searcher.ps1': mainSrc, 'engines/local-code.ps1': localSrc };
  for (const [rel, [from, to]] of Object.entries(edits)) { assert.ok(files[rel].includes(from), `mutation anchor missing in ${rel} (${tag}): ${from}`); files[rel] = files[rel].replace(from, to); }
  for (const [rel, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, rel), text.startsWith('\uFEFF') ? text : '\uFEFF' + text, 'utf8');
  return dir;
}
const cacheStamp = () => { try { const st = fs.statSync(path.join(rootDir, 'search_cache.json')); return `${st.size}@${st.mtimeMs}`; } catch { return 'absent'; } };
function fixtureDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'r96fix-'));
  const zw = '\u200B', iso = '\u2066', pdi = '\u2069', tag = String.fromCodePoint(0xE0049, 0xE0047);
  fs.writeFileSync(path.join(d, 'a.txt'), [`R96LIVEPROBE one${zw} hidden`, `R96LIVEPROBE two ${iso}rtl${pdi}`, `R96LIVEPROBE three ${tag} tag`, 'R96LIVEPROBE four', 'R96LIVEPROBE five'].join('\n') + '\n', 'utf8');
  return d;
}
async function runTree(dir, args) {
  const r = await runPwsh(['-File', path.join(dir, 'multi-platform-searcher.ps1'), ...args, '-AsJson', '-NoEnvFile', '-NoCache'],
    { cwd: dir, env: { MCPS_DISABLE: ENGINE_NAMES.join(','), MCPS_NO_MAIN: '' }, timeoutMs: 180000 });
  assert.equal(typeof r.status, 'number', `pwsh did not exit normally (signal=${r.signal})`);
  return r;
}
export function payloadViolations(stdout, { expectLocal = false } = {}) {
  const bad = [];
  let p;
  try { p = assertStrictJsonText(stdout.trim(), 'stdout'); } catch (e) { return [`strict-json: ${e.message.split('\n')[0]}`]; }
  try { validate(schema, p); } catch (e) { bad.push(`schema: ${e.message}`); }
  if (!p._schemaError) {
    const missingKeys = PAYLOAD_KEYS.filter(k => !(k in p)); if (missingKeys.length) bad.push(`payload keys missing vs source literal: ${missingKeys}`);
    const c = p.completeness;
    if (c) {
      if (c.returned_count !== p.results.length) bad.push(`completeness.returned_count ${c.returned_count} ≠ results ${p.results.length}`);
      if (c.omitted_count !== c.total_count - c.returned_count) bad.push('completeness.omitted_count ≠ total − returned');
      if (c.truncated !== (c.omitted_count > 0 || c.sources_at_limit.length > 0)) bad.push('completeness.truncated inconsistent');
      if ((c.cursor === null) !== (c.sources_at_limit.length === 0)) bad.push('completeness.cursor inconsistent with sources_at_limit');
    }
    if (expectLocal) {
      const loc = p.results.filter(r => r.Platform === 'Local');
      if (loc.length === 0) bad.push('no Local results');
      for (const r of loc) for (const k of ['Name', 'File', 'Preview']) if (/[\u200B\u2066-\u2069]|[\u{E0000}-\u{E007F}]/u.test(r[k] ?? '')) bad.push(`invisible residue in Local.${k}`);
    }
  }
  return bad;
}

test('R96 live payload L1 (offline repo mode, every engine disabled): stdout is strict JSON, validates, completeness self-consistent, key set ⊇ source literal; M1/M2 go red', async () => {
  assert.ok(ENGINE_NAMES.length >= 15, 'engine registry parse');
  assert.ok(PAYLOAD_KEYS.includes('completeness') && PAYLOAD_KEYS.includes('context'), 'payload literal parse: ' + PAYLOAD_KEYS);
  const args = ['-Keyword', 'R96LIVEPROBE', '-Limit', '3'];
  const stamp0 = cacheStamp();
  const trees = {
    base: makeTree('base'),
    M1: makeTree('m1', { 'multi-platform-searcher.ps1': ['; completeness = $completeness', ''] }),
    M2: makeTree('m2', { 'multi-platform-searcher.ps1': ['    SpanStatus         = (Get-SpanStatus', '    __r96_m2         = (Get-SpanStatus'] }),
  };
  try {
    const out = Object.fromEntries(await Promise.all(Object.entries(trees).map(async ([k, d]) => [k, await runTree(d, args)])));
    const base = payloadViolations(out.base.stdout);
    assert.deepEqual(base, [], `baseline must be clean (rc=${out.base.status}); stderr tail: ${out.base.stderr.slice(-400)}`);
    const p = JSON.parse(out.base.stdout);
    assert.equal(p.results.length, 0); assert.ok(['none', 'no-engines'].includes(p.coverage.Verdict), 'all engines disabled ⇒ Verdict none/no-engines, got ' + p.coverage.Verdict);
    assert.equal(cacheStamp(), stamp0, 'real-tree search_cache.json must not be touched (runs happen in a temp copy)');
    const m1 = payloadViolations(out.M1.stdout), m2 = payloadViolations(out.M2.stdout);
    assert.match(m1.join('\n'), /completeness/, 'M1 (completeness unwired) must be caught: ' + m1);
    assert.match(m2.join('\n'), /SpanStatus|__r96_m2|schema/, 'M2 (SpanStatus dropped) must be caught: ' + m2);
    console.log(`[R96 live L1] base rc=${out.base.status} violations=0 keys=${Object.keys(p).length} | M1 rc=${out.M1.status} caught=${m1.length} (${m1[0]}) | M2 rc=${out.M2.status} caught=${m2.length} (${m2[0]})`);
  } finally { for (const d of Object.values(trees)) fs.rmSync(d, { recursive: true, force: true }); }
});

test('R96 live payload L2 (local code evidence, remote engines disabled): Local entries validate with zero invisible residue; M3/M4/M5', async (t) => {
  const fix = fixtureDir();
  const args = ['-Keyword', 'R96LIVEPROBE', '-Limit', '3', '-LocalCodeSearch', '-CodeEvidence', '-LocalPath', fix];
  const trees = {
    base: makeTree('l2base'),
    M3: makeTree('m3', { 'engines/local-code.ps1': ['Platform = "Local"; Name = $file;', 'Platform = "Local"; Stars = 0; Name = $file;'] }),
    M4: makeTree('m4', { 'multi-platform-searcher.ps1': ['-Candidates $candidateCount', '-Candidates 0'] }),
    M5: makeTree('m5', { 'engines/local-code.ps1': ["$lineNo = [int]$matches['line']", "$lineNo = $matches['line']"] }),   // = R2 前的原件行为（Line 为字符串）
  };
  try {
    const out = Object.fromEntries(await Promise.all(Object.entries(trees).map(async ([k, d]) => [k, await runTree(d, args)])));
    let p; try { p = JSON.parse(out.base.stdout); } catch { assert.fail('L2 baseline stdout is not JSON: ' + out.base.stderr.slice(-400)); }
    if (!p.results.some(r => r.Platform === 'Local')) {
      const why = JSON.stringify(p.warnings ?? p.coverage).slice(0, 300);
      t.skip(`no Local results — ripgrep not available here (tool_missing); host runs this leg. evidence: ${why}`); return;
    }
    assert.deepEqual(payloadViolations(out.base.stdout, { expectLocal: true }), []);
    const m3 = payloadViolations(out.M3.stdout, { expectLocal: true });
    assert.match(m3.join('\n'), /schema: .*results\[\d+\]: oneOf matched 0/, 'M3 (Stars on a code item) must be caught: ' + m3);
    const m5 = payloadViolations(out.M5.stdout, { expectLocal: true });
    assert.match(m5.join('\n'), /\.Line: type string not in/, 'M5 (pre-R2 string Line) must be caught: ' + m5);
    const c = p.completeness, m4 = payloadViolations(out.M4.stdout, { expectLocal: true });
    const m4Killable = c.total_count > c.returned_count;
    if (m4Killable) assert.ok(m4.length > 0 || JSON.parse(out.M4.stdout).completeness.total_count !== c.total_count, 'M4 must be caught when candidates > returned');
    console.log(`[R96 live L2] base violations=0 local=${p.results.filter(r => r.Platform === 'Local').length} | M3 caught=${m3.length} | M5(pre-R2 Line) caught=${m5.length} | M4 ${m4Killable ? 'caught' : 'NOT killable by this fixture (total_count == returned_count; honest gap)'}`);
  } finally { for (const d of Object.values(trees)) fs.rmSync(d, { recursive: true, force: true }); fs.rmSync(fix, { recursive: true, force: true }); }
});
