// A-11（任务书 §3 批 A，2026-10-11）：Doctor 单列「限流源」`doctor.rateLimitedSources`。
//   判据（原文）：人为触发限流 ⇒ 该源出现在表里。
//   A 臂：真仓跑 tests/a11-ratelimited-harness.ps1（零网络：Invoke-ApiRequest 桩按 URL 抛 429 / TooLong，**真跑**
//        Get-DoctorResearchHealth 的探针循环与分类，再汇入 Get-DoctorRateLimitedSources）⇒ A11_PASS，且三族各有一源在表、对照臂为空。
//   B 臂（U-159 K1 范式）：副本上逐锚点变异 ⇒ 夹具必须 A11_FAIL 在对应理由；还原后再绿。
//     M1 研究探针分类丢 TooLong 形状（批次2 修过的缺口回潮）⇒ DockerHub 不在表
//     M2 Get-DoctorRateLimitedSources 不再认 rate-limited ⇒ OpenAlex/DockerHub 都不在表
//     M3 Invoke-DoctorReport 不再落 rateLimitedSources 键 ⇒ 由 A-7 活体门的形状判据接住（本门用源码锚点 + A-7 共同覆盖）
//   C 卫生：只动副本，真仓 sha 不变。写法同 test-gitlab-budget-ci（不用 spawnSync / fs.cpSync）。
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { rootDir, runPwsh, assertRanGreen } from './r2-ps-run.mjs';
import { sourceAll } from './lib/source.mjs';

const HARNESS = 'tests/a11-ratelimited-harness.ps1';
const sha = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const tail = r => (r.stdout + '\n' + r.stderr).slice(-1000);

const MUTATIONS = [
  { id: 'M1', file: 'lib/doctor.ps1', expect: /A11_FAIL DockerHub \(TooLong shape\) missing/,
    label: '研究探针分类退回只认 429 字面量 ⇒ TooLong 形状被报成 unreachable ⇒ DockerHub 不在限流表',
    find: String.raw`if ($msg -match '\b429\b|rate.?limit|限流等待过长') { $status = 'rate-limited'; $code = 429 }`,
    replace: String.raw`if ($msg -match '\b429\b|rate.?limit') { $status = 'rate-limited'; $code = 429 }` },
  { id: 'M2', file: 'lib/doctor.ps1', expect: /A11_FAIL OpenAlex \(429\) missing/,
    label: 'Get-DoctorRateLimitedSources 不再认研究探针的 rate-limited ⇒ 研究族整族缺席',
    find: "if ([string]$rh.Status -eq 'rate-limited') {", replace: "if ([string]$rh.Status -eq 'rate-limited-never') {" },
  { id: 'M3', file: 'lib/doctor.ps1', expect: /A11_FAIL grep\.app \(remoteEngines Note 429\) missing/,
    label: '代码引擎族的 429 识别被去掉 ⇒ grep.app 不在表',
    find: String.raw`if (("$($re.Note)") -match '\b429\b|限流等待过长') {`, replace: String.raw`if ($false) {` },
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
  const b = fs.readFileSync(file); const find = Buffer.from(findStr, 'utf8'); const i = b.indexOf(find);
  if (i < 0) return { ok: false, original: b };
  fs.writeFileSync(file, Buffer.concat([b.subarray(0, i), Buffer.from(replStr, 'utf8'), b.subarray(i + find.length)]));
  return { ok: true, original: b };
}

let tmp = null, copyRoot = null;
const realSha = new Map();
before(() => {
  for (const f of new Set(MUTATIONS.map(m => m.file))) realSha.set(f, sha(path.join(rootDir, f)));
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'a11-')); copyRoot = path.join(tmp, 'repo'); copyTree(rootDir, copyRoot);
});
after(() => { if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* 留由系统清 */ } } });

function runHarness(root) {
  // ★timeoutMs=300000（2026-10-12 宿主收口）：本 harness 单跑 ~66s，但**全量套件下多个门并行起 pwsh** 时
  //   实测会 >120s（撞 r2-ps-run 的默认超时）⇒ 绿臂被误判红（观察到 A/B0 两个"应绿"臂红）。
  //   提高超时不改判据语义（超时仍会被兜底 settle 成 status=null ⇒ 明确失败，不冒充红/绿）。
  return runPwsh(['-File', path.join(root, HARNESS), '-SkillDir', root], { cwd: root, env: { MCPS_CACHE_FILE: path.join(tmp, 'gate-cache.json') }, timeoutMs: 300000 });
}
function parseA11(stdout) {
  const m = stdout.match(/^A11 research=([^ ]*) code=([^ ]*) token=([^ ]*) total=(\d+) probes=(\d+)/m);
  assert.ok(m, 'A11 读数行缺失\n' + stdout.slice(-600));
  const split = s => s ? s.split(',') : [];
  return { research: split(m[1]), code: split(m[2]), token: split(m[3]), total: +m[4], probes: +m[5] };
}

test('A-11 A: 人为触发限流（429 + TooLong 两种形状）⇒ 研究/代码/令牌三族各自的源都出现在 rateLimitedSources；对照臂为空', async () => {
  const r = await runHarness(rootDir);
  assertRanGreen(r, 'A11_PASS', 'real repo');
  const a = parseA11(r.stdout);
  assert.ok(a.probes >= 10, `探针循环未真跑（probes=${a.probes}）`);
  assert.deepEqual(a.research, ['DockerHub', 'OpenAlex'], '研究族应恰为 DockerHub(TooLong) + OpenAlex(429)，且按 Source 排序');
  assert.deepEqual(a.code, ['grep.app']); assert.deepEqual(a.token, ['GITLAB_TOKEN']); assert.equal(a.total, 4);
  assert.match(r.stdout, /^A11-CTRL total=0$/m, '对照臂（全 200）必须为空');
});

test('A-11 B0: 副本基线绿', async () => { assertRanGreen(await runHarness(copyRoot), 'A11_PASS', 'copy baseline'); });

for (const m of MUTATIONS) {
  test(`A-11 ${m.id}: 变异「${m.label}」⇒ 夹具必须红在对应理由；还原后绿`, async () => {
    const target = path.join(copyRoot, m.file); const before = sha(target);
    const res = replaceBytes(target, m.find, m.replace);
    assert.ok(res.ok, `${m.id}: 锚点找不到 ⇒ mutant-noop: ${m.find}`);
    let red; try { red = await runHarness(copyRoot); } finally { fs.writeFileSync(target, res.original); }
    assert.equal(sha(target), before, `${m.id}: 必须字节级还原`);
    assert.equal(typeof red.status, 'number', `${m.id}: 进程没跑到退出码`);
    assert.notEqual(red.status, 0, `${m.id}: 变异后仍绿 ⇒ 假门\n` + tail(red));
    assert.match(red.stdout, m.expect, `${m.id}: 红了但理由不对\n` + tail(red));
    assertRanGreen(await runHarness(copyRoot), 'A11_PASS', `${m.id} restored`);
  });
}

test('A-11 源码锚点: Invoke-DoctorReport 落 rateLimitedSources 键，且文本输出有「限流源」行（活体形状由 test-a7-doctor-smoke 断言）', () => {
  const src = sourceAll(path.join(rootDir));
  const code = src.split(/\r?\n/).filter(l => !/^\s*#/.test(l)).join('\n');   // 剔注释行：门扫代码不扫注释
  assert.match(code, /\$doctorReport\['rateLimitedSources'\]\s*=\s*@\(Get-DoctorRateLimitedSources /);
  assert.match(code, /限流源\(本次探测\)/);
});

test('A-11 C: 全程只动副本 —— 真仓 sha 不变', () => {
  for (const [f, s] of realSha) assert.equal(sha(path.join(rootDir, f)), s, `真仓 ${f} 被改动了`);
});
