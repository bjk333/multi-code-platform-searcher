// U-276（v1.58.0，验收 B3-5）：**变异抽检** —— 只打变更行，回答"行为门看得见这次改动吗"。
//
// 用法（月度/发版前）：
//   node tests/mutation-sweep.mjs --base-git <ref> --max 6          # 与某个历史点比
//   node tests/mutation-sweep.mjs --base <dir> --max 6              # 与某个目录比（如上一版发布副本）
//   node tests/mutation-sweep.mjs --base <dir> --dry-run            # 只列候选，不跑门
//
// 判据（设计文档 §5 规则 6）：变更行的变体**一个都没杀掉** ⇒ `invalid-green`（无效绿），退出码 1。
// 其余判决见 tests/lib/mutation.mjs 的 verdictOf；`no-candidates` 明确打印"这不是绿"。
//
// 与行为层的关系：默认门集就是 `tests/behavior/`（48 条臂）。这是刻意的 ——
//   静态门靠"源码里有这行"杀变体，把它算进分数等于让文本匹配给行为测试背书。
//   代价：只测行为层覆盖到的部分，所以报告里**必须**写清用了哪些门（`gates` 字段），
//   分数只对这个门集有效，不能当成"产品整体质量"。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

import { changedLines, mutantsFor, applyMutants, scoreResults, verdictOf, exitCodeForVerdict } from './lib/mutation.mjs';
import { runGates } from './run-node-gates.mjs';

const TESTS = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TESTS, '..');

const PRODUCT = ['multi-platform-searcher.ps1', 'lib', 'engines'];
const COPY_SKIP = new Set(['_verify', 'reports', 'node_modules', '.git', '.audit-lock', '.gate-green.json', 'search_cache.json', 'source-health.json', 'dist']);

function parseArgs(argv) {
  const a = { max: 6, minScore: 0.5, dryRun: false, out: null, base: null, baseGit: null, gates: null, paths: PRODUCT };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    if (k === '--base') a.base = next();
    else if (k === '--base-git') a.baseGit = next();
    else if (k === '--max') a.max = Number(next());
    else if (k === '--min-score') a.minScore = Number(next());
    else if (k === '--out') a.out = next();
    else if (k === '--gates') a.gates = next().split(',');
    else if (k === '--paths') a.paths = next().split(',');
    else if (k === '--dry-run') a.dryRun = true;
    else if (k === '--help' || k === '-h') { console.log('usage: node tests/mutation-sweep.mjs --base <dir> | --base-git <ref> [--max N] [--dry-run] [--out f.json] [--gates a.test.mjs,b.test.mjs] [--min-score 0.5]'); process.exit(0); }
    else throw new Error('未知参数：' + k);
  }
  return a;
}

/** 产品文件清单（相对路径） */
function productFiles(root, paths = PRODUCT) {
  const out = [];
  for (const p of paths) {
    const abs = path.join(root, p);
    if (!fs.existsSync(abs)) continue;
    if (fs.statSync(abs).isFile()) { out.push(p); continue; }
    for (const f of fs.readdirSync(abs)) if (f.endsWith('.ps1')) out.push(p + '/' + f);
  }
  return out.sort();
}

/** 取 base 文本：目录，或 git ref（逐文件 `git show`；ref 里没有该文件 ⇒ 空串）
 *
 *  ★全部用**异步** child_process。R2 的卫生门（test-r2-spawn-hygiene）有一条硬规矩：
 *    做变异/击杀计数的文件不得用同步 spawn —— 宿主垫片会让 `spawnSync` 恒 EBUSY、`status=null`，
 *    于是"没跑成"会被读成"变异被杀了"，凭空加分。这条规矩正好戳中本工具的要害，所以这里不留例外。
 */
async function readBase(a, root, files) {
  const map = new Map();
  const run = async (args, opts) => (await promisify(execFile)('git', args, { encoding: 'utf8', maxBuffer: 32 << 20, ...opts })).stdout;
  if (a.base) {
    const dir = path.resolve(a.base);
    if (!fs.existsSync(dir)) throw new Error('--base 目录不存在：' + dir);
    for (const rel of files) {
      const p = path.join(dir, rel);
      map.set(rel, fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');
    }
    return { kind: 'dir', where: dir, map };
  }
  if (a.baseGit) {
    // `git show <ref>:<path>` 的路径要相对**仓库根**（本仓的仓库根是 skill/，产品在子目录里）。
    let prefix = '';
    try {
      const top = (await run(['rev-parse', '--show-toplevel'], { cwd: root })).trim();
      prefix = path.relative(top, root).replace(/\\/g, '/');
      if (prefix) prefix += '/';
    } catch { prefix = ''; }
    for (const rel of files) {
      try {
        map.set(rel, await run(['show', `${a.baseGit}:${prefix}${rel}`], { cwd: root }));
      } catch { map.set(rel, ''); }   // ref 里没有这个文件（新增）⇒ 空基线
    }
    return { kind: 'git', where: a.baseGit, map };
  }
  throw new Error('必须给 --base <dir> 或 --base-git <ref>（没有基线就没有"变更行"，不能默认全量跑）');
}

function collectCandidates({ root, baseInfo, files, max }) {
  const out = [];
  for (const rel of files) {
    const headText = fs.readFileSync(path.join(root, rel), 'utf8');
    const baseText = baseInfo.map.get(rel) ?? '';
    if (headText === baseText) continue;
    const lines = changedLines(baseText, headText);
    if (!lines.length) continue;
    out.push(...mutantsFor({ file: rel, headText, changeLines: lines, max: max - out.length }));
    if (out.length >= max) break;
  }
  return out;
}

function copyTree(src, dst) {
  fs.cpSync(src, dst, {
    recursive: true,
    filter: (s) => !COPY_SKIP.has(path.basename(s)),
  });
}

/** 语法自检：变体必须能被 PS 解析（否则它"杀掉"所有门只是因为语法坏了）
 *  ★异步（理由同 readBase）：这里的结果直接决定 stillborn / killed，绝不能让 EBUSY 之类的
 *    "没跑成"变成一次带分数的判定。没有解释器 ⇒ 返回 null，调用方记 error。
 */
export function parsesOk(file) {
  const ps = process.env.MCPS_PWSH || 'pwsh';
  const script = `$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${file.replace(/'/g, "''")}', [ref]$null, [ref]$e); if ($e -and $e.Count) { exit 1 }`;
  return new Promise((resolve) => {
    const c = spawn(ps, ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore' });
    c.once('error', () => resolve(null));
    c.once('exit', (code) => resolve(code === 0));
  });
}

function gatesIn(root, a) {
  if (a.gates) return a.gates.map((g) => path.resolve(root, g));
  // 默认只跑引擎行为臂（engines*.test.mjs）。刻意排除 `mutants.test.mjs`：
  //   它自己就是个变异夹具（复制产品 + 打补丁），算进门集会双重计分，而且慢一倍。
  const dir = path.join(root, 'tests', 'behavior');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /^engines.*\.test\.mjs$/.test(f)).sort().map((f) => path.join(dir, f));
}

/**
 * 跑一次抽检。**不写盘、不读全局状态**，便于门直接调用（U-276-D）。
 * @returns {Promise<object>} report
 */
export async function sweep({ root = ROOT, base = null, baseGit = null, max = 6, minScore = 0.5, gates = null, dryRun = false, paths = PRODUCT, log = () => {} } = {}) {
  const a = { base, baseGit, max, minScore, gates, dryRun };
  const files = productFiles(root, paths);
  const baseInfo = await readBase(a, root, files);
  const candidates = collectCandidates({ root, baseInfo, files, max });
  const report = {
    schema: 'u276-mutation/1',
    at: new Date().toISOString(),
    base: { kind: baseInfo.kind, where: baseInfo.where },
    head: root,
    gates: [],
    max, minScore,
    candidates: candidates.length,
    baseline: null,
    results: [],
    score: scoreResults([]),
    verdict: null,
  };
  if (dryRun || !candidates.length) {
    report.verdict = dryRun
      ? { verdict: 'not-run', why: 'dry-run：只列候选，没跑门（不是任何结论）' }
      : verdictOf(report.score, { minScore, candidates: 0 });
    report.results = candidates.map((c) => ({ ...pick(c), status: 'not-run' }));
    return report;
  }

  const gateList = gatesIn(root, a);
  if (!gateList.length) throw new Error('门集为空：' + path.join(root, 'tests', 'behavior'));
  report.gates = gateList.map((g) => path.relative(root, g).replace(/\\/g, '/'));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'u276-sweep-'));
  try {
    // ① 基线：未变异必须绿。否则任何"变红"都可能与变异无关（这是最容易造出假分数的地方）。
    const clean = path.join(tmp, 'clean');
    copyTree(root, clean);
    const env = { ...process.env, NODE_OPTIONS: '' };
    const baseRun = await runGates({ files: gatesIn(clean, a), cwd: clean, stdio: 'pipe', env, mode: 'serial', metaFiles: new Set() });
    report.baseline = { productRed: baseRun.summary.productRed, envRed: baseRun.summary.envRed, rc: baseRun.rc };
    if (baseRun.summary.productRed > 0 || baseRun.summary.envRed > 0) {
      report.verdict = { verdict: 'inconclusive', why: `基线不绿（product_red=${baseRun.summary.productRed} env_red=${baseRun.summary.envRed}）—— 先让行为层绿再抽检` };
      report.results = candidates.map((c) => ({ ...pick(c), status: 'error', why: 'baseline-red' }));
      report.score = scoreResults(report.results);
      return report;
    }

    // ② 逐个变体：复制整棵树 → 打一个补丁 → 串行跑门。
    //    ★串行是必须的：并行下的偶发红会被记成"killed"，等于凭空加分。
    for (const [i, c] of candidates.entries()) {
      const one = path.join(tmp, 'm' + i);
      copyTree(root, one);
      const target = path.join(one, c.file);
      const headText = fs.readFileSync(target, 'utf8');
      const mutated = applyMutants(headText, [c]);
      const rec = pick(c);
      if (mutated === headText) { report.results.push({ ...rec, status: 'error', why: 'mutation-did-not-bite' }); log(`  ${i + 1}/${candidates.length} ${c.file}:${c.line} ${c.op} ⇒ 没咬到（记账为 error）`); continue; }
      fs.writeFileSync(target, mutated, 'utf8');

      const parsed = await parsesOk(target);
      if (parsed === null) { report.results.push({ ...rec, status: 'error', why: 'no-pwsh' }); log(`  ${i + 1}/${candidates.length} ${c.file}:${c.line} ${c.op} ⇒ 无 pwsh，测不了`); continue; }
      if (!parsed) { report.results.push({ ...rec, status: 'stillborn' }); log(`  ${i + 1}/${candidates.length} ${c.file}:${c.line} ${c.op} ⇒ stillborn（语法坏）`); continue; }

      const r = await runGates({ files: gatesIn(one, a), cwd: one, stdio: 'pipe', env, mode: 'serial', metaFiles: new Set() });
      const killed = r.summary.productRed > 0;
      const status = killed ? 'killed' : (r.summary.envRed > 0 || r.hung ? 'error' : 'survived');
      report.results.push({ ...rec, status, reds: r.summary.product.slice(0, 3).map((x) => x.name) });
      log(`  ${i + 1}/${candidates.length} ${c.file}:${c.line} ${c.op} ⇒ ${status}${killed ? '（' + r.summary.product[0].name + '）' : ''}`);
    }
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* 留不下也就算了 */ }
  }

  report.score = scoreResults(report.results);
  report.verdict = verdictOf(report.score, { minScore, candidates: report.candidates });
  return report;
}

const pick = (c) => ({ file: c.file, line: c.line, column: c.column, op: c.op, from: c.from, to: c.to });

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const a = parseArgs(process.argv.slice(2));
  const report = await sweep({ ...a, log: (m) => console.error(m) });
  const v = report.verdict;
  const out = a.out || path.join(ROOT, 'reports', 'mutation', `${report.at.slice(0, 10)}-${report.at.slice(11, 16).replace(':', '')}.json`);
  if (!a.dryRun) { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n', 'utf8'); }
  const o = report.score.overall;
  console.error(`[U-276] 候选 ${report.candidates}，跑成 ${o.total}（killed ${o.killed} / survived ${o.survived}），stillborn ${o.stillborn}，error ${o.error}`);
  console.error(`[U-276] 门集：${report.gates.length ? report.gates.join(', ') : '(dry-run/未跑)'}`);
  console.error(`[U-276] 判决：${v.verdict} —— ${v.why}`);
  if (report.verdict.verdict === 'no-candidates') console.error('[U-276] ★no-candidates **不是绿**：这一版产品代码没有可抽的变更行（或基线选错了）');
  if (!a.dryRun) console.error('[U-276] 报告：' + out);
  process.exitCode = exitCodeForVerdict(v.verdict);
}
