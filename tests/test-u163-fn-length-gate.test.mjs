// U-163 · 「函数体 >100 行」常驻门（AST）
//
// ★为什么要有这道门：任务书通则 #1 要求「改完重取 AST（防 >100 回潮）」，但本仓一直没有这条门
//   ⇒ 回潮只能靠人记得（R3 宿主验收与整技能验收两次都只能人工重取并手工记录）。
//
// 判据（只做**结构不变量** ⇒ 可 hard-fail，符合本仓"误报不对称"纪律）：
//   ① 主脚本 parseErrors == 0
//   ② **没有任何函数体 >100 行**
//   ③ 负例：一个 130 行的合成函数必须被量出来（证明尺子能量到，而不是恒绿）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(testsDir, '..');
const AUDIT = path.join(testsDir, 'u163-fn-length-audit.ps1');
const MAIN = path.join(root, 'multi-platform-searcher.ps1');
// v1.54.0（B3-2）：函数按领域搬进 lib/ ⇒ "没有任何函数 >100 行"这条通则必须覆盖全部产品文件，
//   否则门只量到入口（0 函数）然后**在空集上判绿** —— 这类绿是假绿里最难发现的一种。
const LIB = fs.existsSync(path.join(root, 'lib'))
  ? fs.readdirSync(path.join(root, 'lib')).filter((f) => f.endsWith('.ps1')).sort().map((f) => path.join(root, 'lib', f))
  : [];
const TARGETS = [MAIN, ...LIB];

async function auditProduct(limit = 100, names = []) {
  let functions = 0;
  const over = [], top = [];
  const named = new Map();
  for (const t of TARGETS) {
    const r = await audit(t, limit, names);
    assert.equal(r.code, 0, `审计脚本必须跑通（${path.basename(t)}）: ` + r.err);
    assert.ok(r.j, `必须拿到 JSON（${path.basename(t)}）: ` + r.err);
    assert.equal(r.j.parseErrors, 0, `${path.basename(t)} parseErrors 必须为 0，实得 ${r.j.parseErrors}`);
    functions += r.j.functions || 0;
    for (const o of r.j.over || []) over.push({ ...o, file: path.basename(t) });
    for (const x of r.j.top5 || []) top.push({ ...x, file: path.basename(t) });
    for (const n of r.j.named || []) if (n.found || !named.has(n.name)) named.set(n.name, n);
  }
  top.sort((a, b) => b.bodyLines - a.bodyLines);
  return { limit, functions, over, over100: over.length, top5: top.slice(0, 5), named: [...named.values()] };
}

function audit(target, limit = 100, names = []) {
  return new Promise(resolve => {
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; delete env.NODE_OPTIONS;
    const a = ['-NoProfile', '-File', AUDIT, '-Path', target, '-Limit', String(limit)];
    // ★[string[]] 数组参数在 `pwsh -File` 下必须**一次传逗号分隔**（多个 -Names 会被拒：
    //   "无法将参数绑定到参数 'Names'，因为它是数组类型"）
    if (names.length) a.push('-Names', names.join(','));
    const c = spawn('pwsh', a, { cwd: root, env, windowsHide: true });
    let o = '', e = '';
    c.stdout.on('data', d => { o += d; }); c.stderr.on('data', d => { e += d; });
    c.once('close', code => {
      let j = null, err = null;
      const line = o.trim().split(/\r?\n/).filter(Boolean).pop() || '';
      try { j = JSON.parse(line); } catch (x) { err = (e || o || x.message).slice(0, 300); }
      resolve({ code, j, err });
    });
    c.once('error', err => resolve({ code: null, j: null, err: err.message }));
  });
}

let rep = null;
test('U-163-1（前置）: AST 审计器可跑，且主脚本 parseErrors=0', async () => {
  assert.ok(fs.existsSync(AUDIT), '审计脚本必须存在（tests/u163-fn-length-audit.ps1）');
  rep = await auditProduct();
  assert.ok(rep.functions > 50, `产品函数数应 >50，实得 ${rep.functions}（尺子没量到东西？）`);
});

test('U-163-2（主判据）: **没有任何函数体 >100 行**（通则 #1 的防回潮）', () => {
  assert.equal(rep.limit, 100, '阈值必须是 100');
  assert.equal(rep.over100, 0,
    '有函数体超过 100 行：' + (rep.over || []).map(o => `${o.name}(start=${o.start}, bodyLines=${o.bodyLines})`).join(', '));
  // 顺带把最长的几个记下来，便于人工盯趋势
  console.log(`[U-163] functions=${rep.functions} parseErrors=${rep.parseErrors} over100=${rep.over100} ` +
    `最长5: ${(rep.top5 || []).map(t => `${t.name}=${t.bodyLines}`).join(', ')}`);
});

test('U-163-3（负例 · 尺子必须能量到）: 造一个 130 行函数 ⇒ 必须被报为 over100', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'u163-'));
  try {
    const p = path.join(tmp, 'synthetic.ps1');
    const body = Array.from({ length: 130 }, (_, i) => `    $x${i} = ${i}`).join('\n');
    fs.writeFileSync(p, 'function Test-Synthetic {\n' + body + '\n}\n', 'utf8');
    const r = await audit(p);
    assert.equal(r.code, 0, '审计脚本必须跑通: ' + r.err);
    assert.equal(r.j.functions, 1, '应量到 1 个函数');
    assert.equal(r.j.over100, 1, '★130 行函数必须被判 over100 —— 否则本门是恒绿的（空转）');
    assert.equal(r.j.over[0].name, 'Test-Synthetic');
    assert.ok(r.j.over[0].bodyLines >= 130, `量到的长度应 ≥130，实得 ${r.j.over[0].bodyLines}`);
    // 反证：把阈值抬到 200 ⇒ 同一文件不再超限（证明 over100 是**算出来的**不是写死的）
    const r2 = await audit(p, 200);
    assert.equal(r2.j.over100, 0, '阈值 200 时同一函数不该超限 ⇒ 说明判定随阈值变化');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('U-163-4（本轮新增函数的长度被钉住 · U-165 修实）: 指定函数**必须量到**且 ≤100 行', async () => {
  const watch = ['Get-ContractStatus', 'Get-FullJitterWait', 'Get-RetryBackoff', 'Wait-RateLimitToken'];
  const r = await auditProduct(100, watch);
  assert.equal(r.named.length, watch.length, '每个点名函数都必须有一行读数');
  for (const n of r.named) {
    // ★U-165：原判据是「只对出现在 top5 的函数断言」⇒ 本轮那 4 个都没进 top5 ⇒ **一条都没断言到**（近乎空转）。
    //   现在改成**按名字点量**：量不到就红（found=false ⇒ bodyLines=-1 ⇒ 下面必然红）。
    assert.ok(n.found, `★点名函数 ${n.name} 必须量到 —— 量不到说明它被改名/删了，或测量器坏了（这条取代原来的"量不到不算失败"）`);
    assert.ok(n.bodyLines > 0 && n.bodyLines <= 100, `${n.name} 体长 ${n.bodyLines} 越界（须 1..100）`);
  }
  const rows = r.named.map(n => `${n.name}=${n.bodyLines}`).join(', ');
  console.log(`[U-163] 点名量到: ${rows}`);
  // 负例：点名一个**不存在**的函数必须 found=false ⇒ 证明"量到"不是恒真
  const bad = await auditProduct(100, ['No-Such-Function-XYZ']);
  assert.equal(bad.named[0].found, false, '★点名不存在的函数必须 found=false（否则"量到"是恒真的）');
  assert.equal(bad.named[0].bodyLines, -1, '量不到时必须给 -1，而不是编一个数');
});

// ---------- U-165 · engines/ 渐进门（ratchet：只许变好，不许变坏）----------
// 量到的**真实现状**（2026-10-04 实测，19 文件 / 19 函数 / **3 个 >100**）：
//   Search-GitLabBlobs 126（gitlab-blobs.ps1）· Search-GitHub 105（github.ps1）· Search-PackageRegistries 104
// ⇒ **不能**把主脚本那套「一律 ≤100」硬套到 engines/（会立刻红 3 条，而拆这三个核心引擎是真重构）。
// ⇒ 本门用**渐进**：名单**只许缩短不许变长**。拆了谁 ⇒ 解冻（红，须同步更新基线）；新增超标 ⇒ 红。
// ★U-167（2026-10-04）：三个存量超标函数**已全部拆完**（Search-GitLabBlobs 126 / Search-GitHub 105 /
//   Search-PackageRegistries 104）⇒ 基线**清空**。这是本门最强的形式：从此刻起**任何** engines/ 里
//   出现 >100 行的函数都直接红（不再有"基线 grandfather"）。
const ENGINES_BASELINE = [];

test('U-163-5（渐进门 · engines/）: >100 的函数**名单只许缩短不许变长**', async () => {
  const engDir = path.join(root, 'engines');
  const r = await audit(engDir, 100);
  assert.equal(r.code, 0, '审计目录必须跑通: ' + r.err);
  assert.ok(r.j, '必须拿到 JSON: ' + r.err);
  assert.equal(r.j.parseErrors, 0, `engines/ 必须 parseErrors=0，实得 ${r.j.parseErrors}（${JSON.stringify(r.j.parseErrorFiles)}）`);
  assert.ok(r.j.files >= 19, `engines 文件数应 ≥19，实得 ${r.j.files}`);
  console.log(`[U-163] engines: files=${r.j.files} functions=${r.j.functions} >100=${r.j.over100} ` +
    `名单=${(r.j.over || []).map(o => o.name + '(' + o.bodyLines + ')').join(',') || '(无)'}`);
  for (const o of (r.j.over || [])) {
    assert.ok(ENGINES_BASELINE.includes(o.name),
      '★新增超标函数 ' + o.name + '(' + o.bodyLines + ' 行, ' + o.file + ') —— 基线里没有它。' +
      '要么拆它，要么（若确有必要）显式更新 ENGINES_BASELINE 并写清理由；**不许悄悄多一个**');
  }
  assert.ok(r.j.over100 <= ENGINES_BASELINE.length,
    `超标函数数 ${r.j.over100} > 基线 ${ENGINES_BASELINE.length} —— 只许变少`);
  // 负例：把基线清空再比 ⇒ 现有超标必须立刻被抓（证明这不是恒真的摆设）
  const caught = (r.j.over || []).filter(o => !ENGINES_BASELINE.includes(o.name));
  assert.equal(caught.length, 0, '自检：本实现下不该有基线外的超标（若红了说明基线已过期，须复核）');
  const hypothetical = (r.j.over || []).filter(o => ![].includes(o.name));
  assert.equal(hypothetical.length, r.j.over100, '★若基线为空则全部超标都应被抓 —— 证明该门会因新增超标而红');
});
