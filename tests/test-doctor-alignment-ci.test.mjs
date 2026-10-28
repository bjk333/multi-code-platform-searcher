// 批次B 债（2026-10-11）：tests/test-doctor-alignment.ps1 自 10-09 起是独立离线门，**未纳入任何 CI 组**。
//   本门把它接进 run-node-gates（N-12 自动发现 test-*.test.mjs），并按 U-159 K1 范式用变异证明它**不是假门**：
//   A 绿臂（CI 覆盖）：真仓跑 PS 门 ⇒ rc=0 + TEST_PASS，且 C0..C5 判据行都在。
//   B 变异臂：临时副本上逐锚点字节变异 ⇒ PS 门必须判红，且红在**对应 C 判据**；还原后再验绿。
//     锚点来源：交接文档 §3 批 B 负例列（B-1 npm 改回 npms.io / B-2 用 availableCount 冒充 / B-3 漏一个探针）
//     + C3 标注、C5 限流归类各一条（批2 README §C 表记录过的红位）。
//   C 卫生：全程只动副本，真仓目标文件 sha 不变。
// 写法同 test-gitlab-budget-ci.test.mjs（u159 两条本机经验：不用 spawnSync / 不用 fs.cpSync）。
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { rootDir, runPwsh, assertRanGreen } from './r2-ps-run.mjs';

const PS_GATE = 'tests/test-doctor-alignment.ps1';
const PASS_MARK = /TEST_PASS test-doctor-alignment \(C1\.\.C5 offline\)/;
const FAIL_MARK = 'TEST_FAIL test-doctor-alignment';
const CHECK_LINES = ['[C0]', '[C1]', '[C2]', '[C3]', '[C4a]', '[C4b]', '[C5]'];
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


const MUTATIONS = [
  { id: 'M1', expect: 'C1', file: 'lib/doctor.ps1',
    label: 'B-1 负例：npm 探针端点改回 api.npms.io（与引擎 registry.npmjs.org 不同源）',
    find: "'https://registry.npmjs.org/-/v1/search?text=__mcps_probe__&size=1'",
    replace: "'https://api.npms.io/v2/search?q=__mcps_probe__&size=1'" },
  { id: 'M2', expect: 'C2', file: 'lib/doctor.ps1',
    label: 'B-3 负例：NuGet 探针指向不存在的引擎 ⇒ NuGet 引擎失去同源探针（漏一个）',
    find: "'https://azuresearch-usnc.nuget.org/query?q=__mcps_probe__&take=1'; Engine = 'NuGet'",
    replace: "'https://azuresearch-usnc.nuget.org/query?q=__mcps_probe__&take=1'; Engine = 'NuGetXX'" },
  { id: 'M3', expect: 'C3', file: 'lib/doctor.ps1',
    label: '标注负例：extra 探针（Semantic Scholar）被挂上 Engine ⇒ 会被误当引擎口径',
    find: "KeyHeader = 'x-api-key' }", replace: "KeyHeader = 'x-api-key'; Engine = 'SE' }" },
  { id: 'M4', expect: 'C4', file: 'lib/doctor.ps1',
    label: 'B-2 负例：effectiveCount 不再扣 remoteBlocked（用 availableCount 冒充）',
    find: '$effectiveCount = $codeAvail.Count - $rcsBlockedAvail.Count', replace: '$effectiveCount = $codeAvail.Count' },
  { id: 'M5', expect: 'C5', file: 'engines/open-alex.ps1',
    label: 'OpenAlex 限流分支写错引擎名 ⇒ OpenAlex 状态留 unknown（批2 修前的假阴性形状）',
    find: "Set-EngineStatus -Name 'OpenAlex' -Status 'rate_limited'", replace: "Set-EngineStatus -Name 'OpenAlexZZ' -Status 'rate_limited'" },
];

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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daci-'));
  copyRoot = path.join(tmp, 'repo');
  copyTree(rootDir, copyRoot);
  cacheFile = path.join(tmp, 'gate-cache.json');   // U-166
});
after(() => { if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* 留由系统清 */ } } });

function runGate(root) {
  return runPwsh(['-File', path.join(root, PS_GATE), '-SkillDir', root], { cwd: root, env: { MCPS_CACHE_FILE: cacheFile } });
}
function assertRedAt(r, cTag, label) {
  assert.equal(typeof r.status, 'number', `${label}: process did not run to an exit code (status=${r.status}, signal=${r.signal})`);
  assert.notEqual(r.status, 0, `${label}: 变异后门仍绿 ⇒ 该判据是假门\n` + tail(r));
  const failLine = (r.stdout + '\n' + r.stderr).split(/\r?\n/).find(l => l.includes(FAIL_MARK));
  assert.ok(failLine, `${label}: rc=${r.status} 但没有 ${FAIL_MARK} 行 —— 红的是崩溃不是判据\n` + tail(r));
  assert.ok(failLine.includes(cTag + ' '), `${label}: 红了但不在 ${cTag}（红的理由不对）—— ${failLine}`);
}

test('批B-CI A: 真仓跑 test-doctor-alignment.ps1 ⇒ TEST_PASS C1..C5（CI 覆盖臂）', async () => {
  const r = await runGate(rootDir);
  assertRanGreen(r, PASS_MARK, 'real repo');
  for (const t of CHECK_LINES) assert.ok(r.stdout.includes(t), `缺少判据行 ${t}：门可能提前退出冒充通过\n` + tail(r));
});

test('批B-CI B0: 副本基线绿（否则下面的变异对照不成立）', async () => {
  // U-243（v1.53.25）：包注册表拆成三个单一上游引擎，`engines/package-registries.ps1` 已删除 ——
  //   副本基线必须检查**现存**的三个文件，否则这条断言会因一个合法的删除而判红（门比事实更严也是缺陷）。
  for (const f of ['multi-platform-searcher.ps1', 'engines/open-alex.ps1', 'engines/npm-registry.ps1', 'engines/crates-io.ps1', 'engines/maven-central.ps1', PS_GATE])
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
    finally { fs.writeFileSync(target, res.original); }
    shaStable(target, before, `${m.id}: 还原必须是字节级还原`);
    assertRedAt(red, m.expect, m.id);
    const green = await runGate(copyRoot);
    assertRanGreen(green, PASS_MARK, `${m.id} restored`);
  });
}

test('批B-CI C: 全程只动副本 —— 真仓目标文件 sha 不变', () => {
  for (const [f, s] of realSha) shaStable(path.join(rootDir, f), s, `真仓 ${f} 被改动了（本门绝不允许写真仓）`);
});
