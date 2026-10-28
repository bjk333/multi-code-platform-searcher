// A-7（交接文档 §3 批 A，2026-10-11）：`-Doctor` **非空冒烟门**。
//   判据（交接原文）：stdout 非空 + JSON 可解析 + doctor.remoteCodeSources 在；空 stdout ⇒ 红；
//   **注入 MCPS_NO_MAIN=1 的臂必须报红**（反向自检：证明判据不是"什么都过"）。
//   为什么是新门：R-3（test-r3-doctor-probes）是静态接线门、不跑活体 Doctor；R96 活体门跑的是检索模式、不跑 -Doctor
//   ⇒ 此前没有任何门证明「-Doctor -AsJson 真的会产出一份可解析的报告」。
//   隔离（R96 同款）：os.tmpdir 副本（不写真仓）、-NoEnvFile（不读 .env ⇒ 无令牌校验外呼、输出确定）、-NoCache、
//        MCPS_DOCTOR_RESEARCH=0（跳过 14 个研究信源探针：那是 U-13 的事；本门只问"Doctor 有没有产出"）。
//   仍会发生的外呼：Get-DoctorRemoteCodeHealth 的 grep.app MCP / Sourcegraph 可达性 ping（各 ≤ DoctorProbeSec、1 次）——
//        无网时它们落成 Reachable=false，**不影响**本门判据（本门不问可达性，只问报告在不在、形状对不对）。
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rootDir, runPwsh } from './r2-ps-run.mjs';
import { assertStrictJsonText } from './asjson-validator.mjs';

// ---------- 判据：纯函数（K2 风格 —— 下面每条都配能弄红的负例） ----------
export function validateDoctorStdout(stdout, label = 'doctor stdout') {
  const text = String(stdout ?? '');
  assert.ok(text.trim().length > 0, `${label}: stdout 为空 —— Doctor 没有产出（主流程未执行或提前退出）`);
  const p = assertStrictJsonText(text.trim(), label);
  assert.equal(p.mode, 'doctor', `${label}: mode 应为 doctor，实得 ${JSON.stringify(p.mode)}`);
  assert.ok(typeof p.version === 'string' && p.version.length > 0, `${label}: 缺 version`);
  assert.ok(p.doctor && typeof p.doctor === 'object' && !Array.isArray(p.doctor), `${label}: 缺 doctor 包`);
  assert.ok(Object.hasOwn(p.doctor, 'remoteCodeSources'), `${label}: doctor.remoteCodeSources 不在`);
  const rcs = p.doctor.remoteCodeSources;
  assert.ok(rcs && typeof rcs === 'object' && !Array.isArray(rcs), `${label}: doctor.remoteCodeSources 不是对象`);
  for (const k of ['total', 'availableCount', 'effectiveCount'])
    assert.ok(Number.isInteger(rcs[k]) && rcs[k] >= 0, `${label}: remoteCodeSources.${k} 不是非负整数（B-2 判据字段）`);
  assert.ok(rcs.effectiveCount <= rcs.availableCount && rcs.availableCount <= rcs.total,
    `${label}: 应有 effectiveCount(${rcs.effectiveCount}) ≤ availableCount(${rcs.availableCount}) ≤ total(${rcs.total})（B-2：effective = available − 凭据阻塞）`);
  assert.ok(Array.isArray(rcs.blockedByCredential), `${label}: remoteCodeSources.blockedByCredential 不是数组`);
  assert.equal(typeof rcs.singlePoint, 'boolean', `${label}: remoteCodeSources.singlePoint 不是布尔`);
  assert.equal(rcs.singlePoint, rcs.effectiveCount <= 1, `${label}: singlePoint 必须由 effectiveCount ≤ 1 派生（不许独立赋值）`);
  for (const k of ['tools', 'tokens', 'remoteBlocked', 'remoteEngines', 'keyMatrix', 'proxyState'])
    assert.ok(Object.hasOwn(p.doctor, k), `${label}: doctor.${k} 不在`);
  // A-11（2026-10-11）：限流源单列与 remoteCodeSources 并列 —— 必须是数组（可空），每行带 Source/Kind
  assert.ok(Array.isArray(p.doctor.rateLimitedSources), `${label}: doctor.rateLimitedSources 不在或不是数组（A-11）`);
  for (const row of p.doctor.rateLimitedSources)
    assert.ok(row && typeof row.Source === 'string' && ['research', 'code', 'token'].includes(row.Kind), `${label}: rateLimitedSources 行形状错：${JSON.stringify(row)}`);
  return p;
}

// ---------- 隔离副本（与 r96 / 批B-CI 同款：手动递归复制，跳过与 Doctor 无关的大目录） ----------
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
let tmp = null, dir = null;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'a7doc-')); dir = path.join(tmp, 'repo'); copyTree(rootDir, dir); });
after(() => { if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* 留由系统清 */ } } });

function runDoctor(extraEnv = {}) {
  return runPwsh(['-File', path.join(dir, 'multi-platform-searcher.ps1'), '-Doctor', '-AsJson', '-NoEnvFile', '-NoCache'], {
    cwd: dir, timeoutMs: 180000,
    // MCPS_NO_MAIN 显式清空：R2 spawn 卫生 —— 不让父进程偶然带着 NO_MAIN 把本门变成"空跑冒充通过"
    env: { MCPS_DOCTOR_RESEARCH: '0', MCPS_NO_MAIN: '', MCPS_CACHE_FILE: path.join(tmp, 'gate-cache.json'), ...extraEnv },
  });
}

test('A-7 live: -Doctor -AsJson ⇒ rc=0、stdout 非空、严格 JSON、mode=doctor、doctor.remoteCodeSources 在且形状成立', async () => {
  const r = await runDoctor();
  assert.equal(typeof r.status, 'number', `Doctor 进程没有跑到退出码（status=${r.status}, signal=${r.signal}）`);
  assert.equal(r.status, 0, `-Doctor 应 exit 0，实得 ${r.status}；stderr 尾部：${(r.stderr || '').slice(-600)}`);
  const p = validateDoctorStdout(r.stdout, 'A-7 live');
  const rcs = p.doctor.remoteCodeSources;
  console.log(`[A-7] version=${p.version} tools=${p.doctor.tools.length} remoteEngines=${p.doctor.remoteEngines.length} ` +
    `rcs total/available/effective=${rcs.total}/${rcs.availableCount}/${rcs.effectiveCount} blocked=[${rcs.blockedByCredential.join(',')}] ` +
    `rateLimitedSources=[${p.doctor.rateLimitedSources.map(x => x.Source).join(',')}] ` +
    `researchProbeSkipped=${p.doctor.researchProbeSkipped} stdout=${r.stdout.length}B`);
});

test('A-7 反向自检: 注入 MCPS_NO_MAIN=1 ⇒ 主流程被守卫跳过 ⇒ stdout 为空 ⇒ 本门判据必须报红', async () => {
  const r = await runDoctor({ MCPS_NO_MAIN: '1' });
  assert.equal(typeof r.status, 'number', `进程没有跑到退出码（status=${r.status}, signal=${r.signal}）`);
  // 夹具成立：守卫真的跳过了主流程（-NoEnvFile 下顶层也不再打印令牌文案）
  assert.equal(r.stdout.trim(), '', `MCPS_NO_MAIN=1 下 stdout 应为空（否则守卫失效或顶层有副作用输出）：${r.stdout.slice(0, 300)}`);
  // 判据必须对它报红 —— 这就是"空跑冒充通过"要被挡住的那一类
  assert.throws(() => validateDoctorStdout(r.stdout, 'A-7 no-main'), /stdout 为空/);
});

test('A-7 判据负例（纯函数，不起进程）：空 / 非 JSON / mode 不对 / 缺 remoteCodeSources / 字段形状错 ⇒ 各自红在对的理由；最小合法样本 ⇒ 过', () => {
  const ok = { version: '1.39.0', mode: 'doctor', doctor: { tools: [], tokens: [], remoteBlocked: [], remoteEngines: [], keyMatrix: [], proxyState: {}, rateLimitedSources: [],
    remoteCodeSources: { total: 5, available: ['a', 'b', 'c'], disabled: [], availableCount: 3, effectiveCount: 1, blockedByCredential: ['b', 'c'], singlePoint: true, warning: 'x' } } };
  assert.doesNotThrow(() => validateDoctorStdout(JSON.stringify(ok)));
  const noRls = structuredClone(ok); delete noRls.doctor.rateLimitedSources;   // A-11 负例：键被去掉
  assert.throws(() => validateDoctorStdout(JSON.stringify(noRls)), /rateLimitedSources 不在/);
  const badRls = structuredClone(ok); badRls.doctor.rateLimitedSources = [{ Source: 'OpenAlex', Kind: 'misc' }];
  assert.throws(() => validateDoctorStdout(JSON.stringify(badRls)), /rateLimitedSources 行形状错/);
  assert.throws(() => validateDoctorStdout(''), /stdout 为空/);
  assert.throws(() => validateDoctorStdout('   \n'), /stdout 为空/);
  assert.throws(() => validateDoctorStdout('已加载 GitHub 令牌\n' + JSON.stringify(ok)), /not strict JSON/, '前置噪音行会破坏严格 JSON —— 必须红');
  assert.throws(() => validateDoctorStdout(JSON.stringify({ ...ok, mode: 'search' })), /mode 应为 doctor/);
  const noRcs = structuredClone(ok); delete noRcs.doctor.remoteCodeSources;
  assert.throws(() => validateDoctorStdout(JSON.stringify(noRcs)), /remoteCodeSources 不在/);
  const strEff = structuredClone(ok); strEff.doctor.remoteCodeSources.effectiveCount = '1';
  assert.throws(() => validateDoctorStdout(JSON.stringify(strEff)), /effectiveCount 不是非负整数/);
  const fakeEff = structuredClone(ok); fakeEff.doctor.remoteCodeSources.effectiveCount = 3;   // B-2 负例：用 availableCount 冒充
  assert.throws(() => validateDoctorStdout(JSON.stringify(fakeEff)), /singlePoint 必须由 effectiveCount/);
  const badOrder = structuredClone(ok); badOrder.doctor.remoteCodeSources.effectiveCount = 4;
  assert.throws(() => validateDoctorStdout(JSON.stringify(badOrder)), /effectiveCount\(4\) ≤ availableCount/);
});
