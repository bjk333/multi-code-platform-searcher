// 批次B 债（2026-10-11）：tests/test-gitlab-budget.ps1 自 10-09 起是独立离线门，**未纳入任何 CI 组**（批1 README §八 待办）。
//   本门把它接进 run-node-gates（N-12 自动发现 test-*.test.mjs），并按 U-159 K1 范式用变异证明它**不是假门**：
//   A 绿臂（CI 覆盖）：真仓跑 PS 门 ⇒ rc=0 + TEST_PASS 10/10，且 10 条判据行都在（防"提前退出冒充通过"）。
//   B 变异臂：临时副本上逐锚点字节变异 ⇒ PS 门必须判红，且红在**对应 C 判据**（TEST_FAIL 行里出现该 C 号，不是任意崩溃）；
//     每臂还原后再验绿（对照）。锚点来源：交接文档 §3 批 B 负例列（B-4「超 2 次」/ B-5「文案退回检索失败」）
//     + 批1 README §六.2 记录过的假门场景（Cfg→999）+ 本批 C7 新增的三条语义（blobs 429 上抛 / TooLong 形状）。
//   C 卫生：全程只动副本，真仓目标文件 sha 不变。
//
// 写法沿用本仓两条本机经验（u159 头注）：不用 spawnSync（宿主 node 垫片恒 EBUSY）、不用 fs.cpSync（非 ASCII 路径崩）。
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { rootDir, runPwsh, assertRanGreen } from './r2-ps-run.mjs';

const PS_GATE = 'tests/test-gitlab-budget.ps1';
const PASS_MARK = /TEST_PASS test-gitlab-budget \(11\/11 offline\)/;
const FAIL_MARK = 'TEST_FAIL test-gitlab-budget';
const CHECK_LINES = ['[C1]', '[C2]', '[C3]', '[C4]', '[C5]', '[C6]', '[C7]', '[C8]', '[C9]', '[C10]', '[C11]'];
const sha = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

// ---- 并行容忍（2026-10-12 宿主收口）----
//   本门只在**副本**上变异；但**并行的他门**会在其窗口内临时改真仓再还原 ⇒ "真仓 sha 不变"类断言
//   可能撞上他门的变异窗口 ⇒ 非确定性假红（全量套件复现、单跑不复现）。
//   改为**短暂重试**（等他门还原）后仍不符才判红 —— **不削弱检测力**（持久改动重试后仍红）。
const sleepSync = ms => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
function shaStable(p, expect, label, tries = 8, gapMs = 400) {
  for (let i = 0; i < tries; i++) {
    if (sha(p) === expect) return;
    sleepSync(gapMs);
  }
  assert.equal(sha(p), expect, label);
}


// ---------- 变异集：每条 = 一个真实负例；find 必须在目标文件里**唯一**（replaceBytes 只改首个命中） ----------
const MUTATIONS = [
  { id: 'M1', expect: 'C7a', file: 'engines/search-gitlab.ps1',
    label: 'B-5 负例：429 warning 文案退回通用「检索失败」',
    find: '限流 429：配额用尽', replace: '[GitLab] 检索失败' },
  { id: 'M2', expect: 'C7b', file: 'lib/engines.ps1',
    label: '项目搜索级 429 上抛被去掉 ⇒ blobs 的 429 又被吞成 empty + 假文案（2026-10-11 探针实证的原缺陷）',
    find: String.raw`if ("$_" -match '\b429\b|限流等待过长') { throw }`, replace: 'if ($false) { throw }' },
  { id: 'M3', expect: 'C7c', file: 'engines/search-gitlab.ps1',
    label: 'repo 引擎 is429 退回只匹配 429 字面量 ⇒ TooLong 形状落成 error',
    find: String.raw`$is429 = ("$_") -match '\b429\b|限流等待过长'`, replace: String.raw`$is429 = ("$_") -match '429'` },
  { id: 'M4', expect: 'C7c', file: 'engines/gitlab-blobs.ps1',
    label: 'blobs 引擎 is429 退回只匹配 429 字面量 ⇒ TooLong 形状落成 error',
    find: String.raw`$is429 = ("$_") -match '\b429\b|限流等待过长'`, replace: String.raw`$is429 = ("$_") -match '429'` },
  { id: 'M5', expect: 'C2', file: 'lib/engines.ps1',
    label: 'B-4 负例：预算=2 时剩余预算判定被绕过 ⇒ 仍发起逐项目 blobs（超 2 次）',
    find: 'if ($remaining -le 0) {', replace: 'if ($false) {' },
  { id: 'M8', expect: 'C10', file: 'lib/engines.ps1',
    label: '2026-10-19 原缺陷回归：逐项目 blobs 页大小写死 3 ⇒ -Limit 在回退路径被静默忽略',
    // ★锚点必须钉住 GitLab 那一条 URL：`per_page=$PerPage` 在文件里共 3 处（头注 1 + GitLab 1 + Gitee 1），
    //   而 replaceBytes 只改**首个**命中 ⇒ 锚点太短时变异会打到注释或 Gitee 上，代码没变、门仍绿（实测踩过）。
    find: 'scope=blobs&search=$([uri]::EscapeDataString($Keyword))&per_page=$PerPage',
    replace: 'scope=blobs&search=$([uri]::EscapeDataString($Keyword))&per_page=3' },
  { id: 'M7', expect: 'C8', file: 'lib/engines.ps1',
    label: '2026-10-19 原缺陷回归：403 计入预算（退款被去掉）⇒ 免费版回退路径结构性走不到 blobs',
    find: '$St.Calls--', replace: '$St.Calls++' },
  { id: 'M6', expect: 'C5', file: 'lib/config.ps1',
    label: '批1 §六.2 假门场景：Cfg.GitLabMaxCallsPerQuery 改成 999（有 C5 之前门全绿）',
    // 锚点与具体默认值解耦（v1.45.2：默认 2→4 时旧锚点 `= 2` 失配 ⇒ 变异空转 ⇒ 本门假红）。
    // 替换后为 `GitLabMaxCallsPerQuery = 999 # <原值>`，原数字进注释，语义只剩 999。
    find: 'GitLabMaxCallsPerQuery = ', replace: 'GitLabMaxCallsPerQuery = 999 # ' },
];

// ---------- 工具（与 u159 同款：手动递归复制 + 字节级替换/还原） ----------
// _vendor：16MB 第三方源码，两道 PS 门只 dot-source 主脚本与 engines/，不读它 ⇒ 跳过（其余跳过项同 u159）。
const SKIP_DIRS = new Set(['reports', '_verify', '.git', 'node_modules', '__pycache__', '_vendor']);
function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) { if (SKIP_DIRS.has(e.name)) continue; copyTree(s, d); }
    else if (e.isFile()) {
      if (e.name === '.env' || e.name.startsWith('.env.')) continue;   // 本地凭据文件不入临时副本（卫生 + 门不依赖本机令牌配置）
      // 读不了的本机文件（权限/占用）不该让整个副本崩：副本不是被测物，真树完整性由 U-138/U-139 另管。
      try { fs.copyFileSync(s, d); } catch (err) { if (err.code !== 'EPERM' && err.code !== 'EACCES') throw err; console.error('[copy] skip unreadable: ' + s); }
    }
  }
}
function replaceBytes(file, findStr, replStr) {
  const b = fs.readFileSync(file);
  const find = Buffer.from(findStr, 'utf8');
  const i = b.indexOf(find);
  if (i < 0) return { ok: false, original: b };
  const out = Buffer.concat([b.subarray(0, i), Buffer.from(replStr, 'utf8'), b.subarray(i + find.length)]);
  fs.writeFileSync(file, out);
  return { ok: true, original: b, mutated: out };
}
const tail = r => (r.stdout + '\n' + r.stderr).slice(-1200);

let tmp = null, copyRoot = null, cacheFile = null;
const realSha = new Map();
before(() => {
  for (const f of new Set(MUTATIONS.map(m => m.file))) realSha.set(f, sha(path.join(rootDir, f)));
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gbci-'));
  copyRoot = path.join(tmp, 'repo');
  copyTree(rootDir, copyRoot);
  cacheFile = path.join(tmp, 'gate-cache.json');   // U-166：门不跑主流程，但缓存一律重定向到临时目录（不写真仓）
});
after(() => { if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* 留由系统清 */ } } });

function runGate(root) {
  return runPwsh(['-File', path.join(root, PS_GATE), '-SkillDir', root], { cwd: root, env: { MCPS_CACHE_FILE: cacheFile } });
}
// 红必须"红在对的地方"：进程真的跑了、rc≠0、有 TEST_FAIL 行、且该行点名了期望的 C 判据
function assertRedAt(r, cTag, label) {
  assert.equal(typeof r.status, 'number', `${label}: process did not run to an exit code (status=${r.status}, signal=${r.signal})`);
  assert.notEqual(r.status, 0, `${label}: 变异后门仍绿 ⇒ 该判据是假门\n` + tail(r));
  const failLine = (r.stdout + '\n' + r.stderr).split(/\r?\n/).find(l => l.includes(FAIL_MARK));
  assert.ok(failLine, `${label}: rc=${r.status} 但没有 ${FAIL_MARK} 行 —— 红的是崩溃不是判据\n` + tail(r));
  assert.ok(failLine.includes(cTag + ' '), `${label}: 红了但不在 ${cTag}（红的理由不对）—— ${failLine}`);
}

test('批B-CI A: 真仓跑 test-gitlab-budget.ps1 ⇒ TEST_PASS 10/10（CI 覆盖臂）', async () => {
  const r = await runGate(rootDir);
  assertRanGreen(r, PASS_MARK, 'real repo');
  for (const t of CHECK_LINES) assert.ok(r.stdout.includes(t), `缺少判据行 ${t}：门可能提前退出冒充通过\n` + tail(r));
});

test('批B-CI B0: 副本基线绿（否则下面的变异对照不成立）', async () => {
  for (const f of ['multi-platform-searcher.ps1', 'engines/search-gitlab.ps1', 'engines/gitlab-blobs.ps1', PS_GATE])
    assert.ok(fs.existsSync(path.join(copyRoot, f)), `副本缺 ${f}`);
  const r = await runGate(copyRoot);
  assertRanGreen(r, PASS_MARK, 'copy baseline');
});

for (const m of MUTATIONS) {
  test(`批B-CI ${m.id}: 变异「${m.label}」⇒ 门必须红在 ${m.expect}；还原后绿`, async () => {
    const target = path.join(copyRoot, m.file);
    const before = sha(target);
    const res = replaceBytes(target, m.find, m.replace);
    assert.ok(res.ok, `${m.id}: 锚点找不到 ⇒ mutant-noop（锚点文本被改过？）: ${m.find}`);
    assert.notEqual(sha(target), before, `${m.id}: 变异后 sha 必须变化`);
    let red;
    try { red = await runGate(copyRoot); }
    finally { fs.writeFileSync(target, res.original); }   // 无条件字节级还原
    shaStable(target, before, `${m.id}: 还原必须是字节级还原`);
    assertRedAt(red, m.expect, m.id);
    const green = await runGate(copyRoot);
    assertRanGreen(green, PASS_MARK, `${m.id} restored`);
  });
}

test('批B-CI C: 全程只动副本 —— 真仓目标文件 sha 不变', () => {
  for (const [f, s] of realSha) shaStable(path.join(rootDir, f), s, `真仓 ${f} 被改动了（本门绝不允许写真仓）`);
});
