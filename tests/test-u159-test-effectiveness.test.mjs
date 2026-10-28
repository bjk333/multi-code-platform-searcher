// U-159 · K「测试有效性」—— 通则 #8：**门数量是覆盖率式指标（会骗你）；门有效性要用变异测试证**。
//
// 本门三组：
//   K1 门有效性自检 —— **真改盘 + 真跑门**：在**临时副本**上注入变异 ⇒ 断言该门判红；还原 ⇒ 断言判绿。
//                      断言真仓目标文件 sha 全程不变（副本操作，绝不碰真仓）。
//   K2 属性测试     —— 对 gate-partition 的纯函数给**性质**（非举例），每条配"能弄红"的负例。
//   K3 flaky 政策   —— quarantine 优于 skip；retry 不当第一响应。机制用**副本上的合成条目**做行为级验证
//                      （真仓隔离表保持空是正确状态，但不能因此"机制从没跑过"）。
//
// 两条本机经验决定的写法：
//   ① **不用 spawnSync** —— 宿主 node 垫片让它恒 EBUSY（r2-ps-run.mjs 头注同款）；一律异步 spawn + process.execPath。
//   ② **不用 fs.cpSync** —— 本机实测它在非 ASCII 源路径（`<workspace>\…`）上崩；改逐文件 copyFileSync 递归复制。
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { classifyFailure, uncaughtLine, summarize, exitCodeFor, envFailIfTiming, timingDeclared, GateEnvError, deadlineRouteEvidence } from './gate-partition.mjs';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(testsDir, '..');
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


// ---------- 工具：异步跑一个门；手动递归复制（不用 cpSync） ----------
function runNodeOnce(args, cwd, timeoutMs = 180000) {
  return new Promise(resolve => {
    const t0 = Date.now();
    // ★必须删 NODE_TEST_CONTEXT：本门由 `node --test` 运行，若把它继承给子进程，node:test 认为
    //   "递归调用 run()" 而 **跳过所有文件** ⇒ 子进程零输出且 rc=0 —— 这正是"空跑冒充通过"那一类
    //   （首跑实测：三条变异全部"rc=0"，看着像"门不变红"，实则是子进程压根没跑）。
    //   run-node-gates.mjs 里已有同款注释与处置，此处照办。
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const c = spawn(process.execPath, args, { cwd, windowsHide: true, env });
    let out = '', err = '';
    c.stdout.on('data', d => { out += d; });
    c.stderr.on('data', d => { err += d; });
    const t = setTimeout(() => c.kill('SIGKILL'), timeoutMs);
    c.once('error', e => { clearTimeout(t); resolve({ code: null, out, err, launchError: e.message, ms: Date.now() - t0 }); });
    c.once('close', code => { clearTimeout(t); resolve({ code, out, err, ms: Date.now() - t0 }); });
  });
}
const SKIP_DIRS = new Set(['reports', '_verify', '.git', 'node_modules', '__pycache__']);
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
// 字节级替换（BOM 安全：全程 Buffer，不用 utf8 字符串往返）
function replaceBytes(file, findStr, replStr) {
  const b = fs.readFileSync(file);
  const find = Buffer.from(findStr, 'utf8');
  const i = b.indexOf(find);
  if (i < 0) return { ok: false, original: b };
  const out = Buffer.concat([b.subarray(0, i), Buffer.from(replStr, 'utf8'), b.subarray(i + find.length)]);
  fs.writeFileSync(file, out);
  return { ok: true, original: b, mutated: out };
}

// ---------- K1 变异集：每条都对应一个**真实出现过**的缺陷，或本批新增的结构不变量 ----------
const MUTATIONS = [
  {
    id: 'M1', label: 'U-157 的"有结果不许记 zero-hit"纠正调用点被换成恒等',
    gate: 'tests/test-u157-source-health.test.mjs', file: 'multi-platform-searcher.ps1',
    find: 'Resolve-EngineStatusFromResults -Status $stBefore -HasResults $hasRes',
    replace: '$stBefore',
    expectMarker: 'U-157 B 源码锚点',
  },
  {
    id: 'M2', label: 'GitLab order_by 回退为 stars（历史真缺陷：GitLab 判 400 ⇒ 静默零命中）',
    gate: 'tests/test-u157-source-health.test.mjs', file: 'engines/search-gitlab.ps1',
    find: 'order_by=star_count', replace: 'order_by=stars',
    expectMarker: 'U-157 A1',
  },
  {
    id: 'M3', label: '注册表删掉一行引擎（防"引擎文件还在但注册表漏了"）',
    gate: 'tests/test-u157-source-health.test.mjs', file: 'lib/config.ps1',
    find: "@{ Name = 'DockerHub';", replace: "@{ Name = 'DockerHubXX';",
    expectMarker: 'U-157 C',
  },
  // ---- R3 宿主验收 第4项「变异抽检」：本轮新增/改动的纯函数（持久化，不再是一次性抽检）----
  {
    id: 'M4', label: 'U-160 L1 四态映射写错：none（有请求零执行=失败）被映射成 empty（搜了没结果）',
    gate: 'tests/test-u160-degradation-contract.test.mjs', file: 'lib/core.ps1',
    find: "'none'       { return 'failed' }", replace: "'none'       { return 'empty' }",
    expectMarker: 'U-160 L1-a',
  },
  {
    id: 'M5', label: 'U-160 L3 Full Jitter 退化成固定退避（忽略 Rand01）',
    gate: 'tests/test-u160b-retry-jitter.test.mjs', file: 'lib/http.ps1',
    find: '$local = [math]::Round($r * $u, 3)', replace: '$local = [math]::Round($u, 3)',
    expectMarker: 'U-160 L3-1',
  },
  {
    id: 'M6', label: 'U-160 L4 桶构造丢掉 headroom（客户端速率回退成观测限值）',
    gate: 'tests/test-u160c-source-buckets.test.mjs', file: 'multi-platform-searcher.ps1',
    find: '(($script:Cfg.GhCodeSearchRatePerMin / 60.0) * $rlHeadroom)', replace: '($script:Cfg.GhCodeSearchRatePerMin / 60.0)',
    expectMarker: 'U-160 L4-②',
  },
];

let tmpRoot = null;          // 副本根（<tmp>/repo）
const realShasBefore = new Map();

before(() => {
  // 真仓指纹（跑完必须一致）
  for (const f of new Set(MUTATIONS.map(m => m.file))) realShasBefore.set(f, sha(path.join(root, f)));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'u159-'));
  tmpRoot = path.join(tmp, 'repo');
  copyTree(root, tmpRoot);
  // reports/ 被 copyTree 跳过，但**有门要读**其中的留档 —— 逐个带上（漏一个，变异跑就会因缺文件而“红”，
  //   那是**假阳性**：M4 首跑即被 K1-b 的“必须红在本门判据”记号断言抓住，见 R3 验收报告）。
  const NEEDED = ['reports/_skill-assets.root.json', 'reports/gates/u89-real-asjson.json'];
  for (const rel of NEEDED) {
    const src = path.join(root, rel);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(tmpRoot, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
});
after(() => { if (tmpRoot) { try { fs.rmSync(path.dirname(tmpRoot), { recursive: true, force: true }); } catch { /* 临时目录留由系统清 */ } } });

test('U-159 K1-i: 副本可用（含 engines/schema/清单镜像，且基线门为绿）', async () => {
  assert.ok(tmpRoot && fs.existsSync(path.join(tmpRoot, 'multi-platform-searcher.ps1')), '副本必须含主脚本');
  assert.ok(fs.existsSync(path.join(tmpRoot, 'engines/search-gitlab.ps1')), '副本必须含 engines/');
  assert.ok(fs.existsSync(path.join(tmpRoot, 'reports/_skill-assets.root.json')), '副本必须带 M-15 镜像');
  // 基线：未变异时该门必须绿（否则 K1-b/K1-c 的对照不成立）
  const r = await runNodeOnce(['--test', MUTATIONS[0].gate], tmpRoot);
  assert.equal(r.code, 0, '副本基线必须绿（否则下面是假对照）:\n' + (r.out + r.err).slice(-1200));
});

for (const m of MUTATIONS) {
  test(`U-159 K1 ${m.id}: 变异「${m.label}」必须让门判红，且还原后判绿`, async () => {
    const target = path.join(tmpRoot, m.file);
    const before = sha(target);
    const res = replaceBytes(target, m.find, m.replace);
    assert.ok(res.ok, `${m.id}: 变异必须真的改到字节（找不到锚点 ⇒ mutant-noop）`);
    assert.notEqual(sha(target), before, `${m.id}: 变异后 sha 必须变化`);

    let red;
    try {
      red = await runNodeOnce(['--test', m.gate], tmpRoot);
    } finally {
      fs.writeFileSync(target, res.original);            // 无条件还原（字节级）
    }
    shaStable(target, before, `${m.id}: 还原必须是字节级还原`);

    // K1-b：必须判红，且红的是**这条门自己的判据**（不是任意崩溃）
    assert.notEqual(red.code, 0, `${m.id}: 变异后该门必须判红，实得 rc=${red.code}\n` + (red.out + red.err).slice(-1200));
    const all = red.out + red.err;
    assert.ok(all.includes(m.expectMarker), `${m.id}: 红的应是本门判据（期望记号「${m.expectMarker}」），实得输出里没有它：\n` + all.slice(-1200));

    // K1-c：还原后必须判绿
    const green = await runNodeOnce(['--test', m.gate], tmpRoot);
    assert.equal(green.code, 0, `${m.id}: 还原后必须判绿，实得 rc=${green.code}\n` + (green.out + green.err).slice(-1200));
  });
}

test('U-159 K1-e: 全程只动副本 —— 真仓目标文件 sha 不变', () => {
  for (const [f, s] of realShasBefore) {
    shaStable(path.join(root, f), s, `真仓 ${f} 被改动了（本门绝不允许写真仓）`);
  }
});

// ---------- K2 属性测试（纯函数不变量；每条配能弄红的负例） ----------
test('U-159 K2-a 属性：uncaughtLine 只认「行首错误形状」，诊断里提及 EBUSY 不算', () => {
  // 性质 1：整段没有"行首错误形状"的行 ⇒ null（注意：输入里【不能】有真的 Error: 行，否则返回它才是对的）
  assert.equal(uncaughtLine('some diagnostic mentioning EBUSY\nanother line with Error inside'), null);
  // 性质 2：取**最后一条**匹配行（Node 打印多行时后者更靠近真相）
  const two = uncaughtLine('Error: first\nmiddle\nTypeError [ERR_X]: second\n');
  assert.match(two, /second/);
  // 性质 3：形状限定 —— 行首必须是 Error / XxxError / 带 [CODE]，缩进或夹在句中不算
  assert.equal(uncaughtLine('  Error: indented is not an uncaught line'), null);
  assert.equal(uncaughtLine('see Error: described inline'), null);
  // 负例（能弄红的对照）：把"含 Error 就算"放宽 ⇒ 性质 1 必红
  const loose = (s) => (String(s || '').split(/\r?\n/).find(l => /Error/.test(l)) ?? null);
  assert.equal(loose('middle Error text'), 'middle Error text', '宽容版会把诊断行当异常行 —— 这正是本性质要挡的');
  assert.equal(uncaughtLine('middle Error text'), null);
});

test('U-159 K2-b 属性（★断言优先不变式）：AssertionError 一律 product，报文里出现 env 关键词也不改判', () => {
  const envish = 'spawnSync powershell EBUSY: resource busy or locked; timings off; ENOENT';
  for (const shape of [{ isAssertion: true, message: envish }, { code: 'ERR_ASSERTION', message: envish }, { name: 'AssertionError', message: envish }]) {
    const r = classifyFailure(shape);
    assert.equal(r.cls, 'product', `断言必须记 product（fail-closed），实得 ${JSON.stringify(r)}`);
    assert.equal(r.why, 'assertion');
  }
  // 反证：非断言且带环境签名 ⇒ 才允许 env（说明上面的 product 不是"什么都说 product"）
  const envOk = classifyFailure({ message: 'spawnSync x EBUSY' });
  assert.equal(envOk.cls, 'env');
  // 负例（能弄红的对照）：把判定顺序反过来（先看签名）⇒ 上面第一条必红
  const reversed = (e) => (/EBUSY/.test(String(e?.message || '')) ? { cls: 'env' } : { cls: 'product' });
  assert.equal(reversed({ isAssertion: true, message: envish }).cls, 'env', '顺序反了就会把断言记成 env —— 这正是本不变式要挡的');
});

test('U-159 K2-c 属性：envFailIfTiming 两向（有/无 U153_TIMING 凭据）', () => {
  // 有凭据 ⇒ 抛 GateEnvError(kind=timing)
  let thrown = null;
  try { envFailIfTiming('demo timing detail', { U153_TIMING: '1' }); } catch (e) { thrown = e; }
  assert.ok(thrown, '有凭据时必须抛');
  assert.equal(thrown.name, 'GateEnvError');
  assert.equal(thrown.envKind, 'timing');
  // 无凭据 ⇒ 抛普通 Error（product），不得给产品挂死开后门
  let prod = null;
  try { envFailIfTiming('demo timing detail', {}); } catch (e) { prod = e; }
  assert.ok(prod && prod.name !== 'GateEnvError', '无凭据时必须按 product 抛，实得 ' + (prod && prod.name));
  // 凭据识别口径
  assert.equal(timingDeclared({ U153_TIMING: 'confirmed' }), true);
  assert.equal(timingDeclared({ U153_TIMING: '0' }), false);
});

test('U-159 K2-e 属性：deadline 的**环境证据**必须两条件合取（code=deadline ∧ 同引擎的 route-unproven）', () => {
  const mk = (code, reason, engine = 'GitLabBlobs') => ({ ReasonCodes: { [engine]: code }, Reasons: { [engine]: reason } });
  // 真实载荷（2026-10-22 实测，`MCPS_ENGINE_DEADLINE=GitLabBlobs=2` 复现）：只有占位，没有 hosts/白名单提示
  const PLACEHOLDER = '单引擎超 2s 截止，已停止；network-route-unproven: gitlab.com（探活未完成即被打断）';
  const UNCONFIRMED = '单引擎超 17s 截止，已停止；network-route-unproven: gitlab.com（未确认的路由：direct）；选路：direct';
  // 正例（探活的两种"没结论"形态）
  const h1 = deadlineRouteEvidence(mk('deadline', PLACEHOLDER));
  assert.equal(h1.length, 1); assert.equal(h1[0].engine, 'GitLabBlobs'); assert.equal(h1[0].host, 'gitlab.com');
  assert.equal(deadlineRouteEvidence(mk('deadline', UNCONFIRMED)).length, 1);
  // 负例 1：裸 deadline（=探活确认可达后请求挂死，可能是产品挂死）⇒ 不得记 env
  assert.deepEqual(deadlineRouteEvidence(mk('deadline', '单引擎超 17s 截止，已停止')), []);
  // 负例 2：凭据类状态即使带着同样的网络文案也**不得**洗成 env（那是真产品问题：令牌失效）
  assert.deepEqual(deadlineRouteEvidence(mk('auth_missing', PLACEHOLDER)), []);
  assert.deepEqual(deadlineRouteEvidence(mk('missing-credential', PLACEHOLDER)), []);
  // 负例 3：证据必须落在**同一个引擎**上（不能拿 A 的文案给 B 背书）
  assert.deepEqual(deadlineRouteEvidence({ ReasonCodes: { GitLabBlobs: 'deadline' }, Reasons: { GitHubCode: PLACEHOLDER } }), []);
  // 负例 4：host 必须像主机名（拒绝把散文里的下一位词当 host）
  assert.deepEqual(deadlineRouteEvidence(mk('deadline', '单引擎超 2s 截止；network-route-unproven: 见文档')), []);
  // 空/畸形输入不得抛
  for (const junk of [null, undefined, {}, { ReasonCodes: null }, { ReasonCodes: { X: 'deadline' }, Reasons: null }]) {
    assert.deepEqual(deadlineRouteEvidence(junk), []);
  }
});

test('U-159 K2-d 属性：分区与退出码单调（product⇒1 / env-only⇒3 / 全清⇒0）', () => {
  const rProduct = summarize({ reds: [{ name: 'a', cls: 'product' }, { name: 'b', cls: 'env', kind: 'timing' }] }, []);
  assert.equal(rProduct.productRed, 1); assert.equal(rProduct.envRed, 1);
  assert.equal(exitCodeFor(rProduct, 1), 1);
  const rEnvOnly = summarize({ reds: [{ name: 'b', cls: 'env', kind: 'timing' }] }, []);
  assert.equal(rEnvOnly.productRed, 0);
  assert.equal(exitCodeFor(rEnvOnly, 3), 3, '只有 env 红必须给 3（env 红仍是红，但不计 product）');
  const rClean = summarize({ reds: [] }, []);
  assert.equal(exitCodeFor(rClean, 0), 0);
  // 负例：把 env-only 判成 1 ⇒ 与既有口径冲突（会掩盖"环境噪音 vs 产品回归"的区分）
  assert.notEqual(exitCodeFor(rEnvOnly, 3), 1);
  // fail-closed：子进程非 0 但无可归类红 ⇒ 记 product
  assert.equal(exitCodeFor(rClean, 7), 1);
});

// ---------- K3 flaky 政策 ----------
const QUARANTINE = path.join(root, 'tests/flaky-quarantine.json');
test('U-159 K3-a: quarantine 表存在且机器可读（空表也是合法状态）', () => {
  assert.ok(fs.existsSync(QUARANTINE), 'tests/flaky-quarantine.json 必须存在（空数组也是合法状态，但文件要在）');
  const q = JSON.parse(fs.readFileSync(QUARANTINE, 'utf8'));
  assert.ok(Array.isArray(q.entries), 'quarantine 必须是 {entries:[…]}');
});
test('U-159 K3-b/c: 每条隔离项必须指向真实存在的门，且必须带 ticket（隔离 ≠ 遗忘）', () => {
  const q = JSON.parse(fs.readFileSync(QUARANTINE, 'utf8'));
  for (const e of q.entries) {
    assert.ok(e.gate && fs.existsSync(path.join(root, e.gate)), `隔离的 gate 必须真实存在: ${e.gate}`);
    assert.ok(e.ticket && String(e.ticket).trim(), `隔离项必须带 ticket（否则就是遗忘）: ${e.gate}`);
    assert.ok(e.since, `隔离项必须记 since: ${e.gate}`);
  }
});
test('U-159 K3-d（行为级）: 隔离一个门 ⇒ 它退出阻塞集（用副本上的合成条目验证，真仓表保持空）', async () => {
  // 真仓当前无 flaky ⇒ entries 应为空；机制必须用合成条目在**副本**上验
  const qReal = JSON.parse(fs.readFileSync(QUARANTINE, 'utf8'));
  assert.deepEqual(qReal.entries, [], '真仓隔离表应为空（当前无已知 flaky）；若不为空，须确认 K3-b/c 通过');
  // 收集器：用**仓根**做基准比对（早前用 testsDir 拼 e.gate 会得到 tests/tests/… ⇒ skip 永不命中）
  const collector = `import { readdirSync, readFileSync } from 'node:fs';\nimport path from 'node:path';\nconst repo = process.argv[2];\nconst d = path.join(repo, 'tests');\nconst q = JSON.parse(readFileSync(path.join(d, 'flaky-quarantine.json'), 'utf8'));\nconst skip = new Set(q.entries.map(e => path.resolve(repo, e.gate)));\nconst files = readdirSync(d).filter(n => /^test-.*\\.test\\.mjs$/.test(n)).map(n => path.join(d, n)).filter(f => !skip.has(path.resolve(f)));\nconsole.log('COLLECTED=' + files.length);\nconsole.log('EXCLUDED=' + skip.size);\n`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'u159q-'));
  const script = path.join(tmpDir, 'collect.mjs');
  fs.writeFileSync(script, collector, 'utf8');
  const base = await runNodeOnce([script, root], tmpDir);
  assert.equal(base.code, 0, '收集器必须能跑通: ' + (base.out + base.err));
  const c0 = Number(/COLLECTED=(\d+)/.exec(base.out)?.[1]);
  assert.ok(c0 > 10, '基线收集数应 >10，实得 ' + c0);

  // 合成条目：把 U-157 门隔离掉 ⇒ 收集数必须 -1（机制真的起作用）
  const tmpRepo = path.join(tmpDir, 'repo');
  copyTree(root, tmpRepo);
  const qPath = path.join(tmpRepo, 'tests/flaky-quarantine.json');
  fs.writeFileSync(qPath, JSON.stringify({ entries: [{ gate: 'tests/test-u157-source-health.test.mjs', ticket: 'SYNTHETIC', since: '2026-10-03', reason: 'K3-d 合成验证' }] }), 'utf8');
  const withQ = await runNodeOnce([script, tmpRepo], tmpDir);
  assert.equal(withQ.code, 0, '合成隔离下收集器仍须跑通: ' + (withQ.out + withQ.err));
  const c1 = Number(/COLLECTED=(\d+)/.exec(withQ.out)?.[1]);
  assert.equal(c1, c0 - 1, `隔离 1 个门后收集数必须 -1（${c0} ⇒ ${c1}）`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 临时目录留由系统清 */ }
});
test('U-159 K3-e/f: 不许 skip 冒充隔离；retry 不是第一响应', () => {
  // e：被隔离的门（当前为空）不得在文件里整体 skip
  const q = JSON.parse(fs.readFileSync(QUARANTINE, 'utf8'));
  for (const e of q.entries) {
    const src = fs.readFileSync(path.join(root, e.gate), 'utf8');
    assert.doesNotMatch(src, /\{\s*skip\s*:\s*(true|['"])/, `被隔离的门不得用整体 skip 冒充: ${e.gate}`);
  }
  // f：runner 不得对失败做无条件重跑（retry 不当第一响应）
  //    口径：先**剥掉清理参数**（rmSync 的 maxRetries/retryDelay 是删除重试，与"测试重试"无关 ——
  //    首跑实测朴素 /retry/i 会被它误伤，这正是本仓"区分同名不同物"的老坑），再断言整体无重试语义。
  const runner = fs.readFileSync(path.join(root, 'tests/run-node-gates.mjs'), 'utf8');
  // U-245（v1.53.27，B1-5）：**允许恰好两次调用** —— 一次首跑、一次"并行红 ⇒ 失败文件串行复核"。
  // U-272（2026-10-26 全量验收）：**三条** —— 首跑 + product 红复核 + env-only 轮次的复核
  //   （env 红此前永不复核 ⇒ runMode 停在 parallel ⇒ 产品全绿也发不了版）。
  //   ★这里改的是**判据的粒度**，不是放宽：数量只是代理，真正的事实由下面几条守 ——
  //   每次额外调用都必须"有条件（早退）+ 串行 + 结果记账"，任一条被拆都会被点名。
  const calls = [...runner.matchAll(/(?<!function\s)runGates\s*\(/g)].length;   // 排除 `export function runGates(` 本身
  assert.equal(calls, 3, `runGates 允许"首跑 + 两条条件复核"，实得 ${calls}（>3 即无条件重跑/循环）`);
  const verified = runner.slice(runner.indexOf('export async function runGatesVerified('));
  assert.ok(verified.length > 0, 'runGatesVerified 缺失：额外调用必须被"复核"这个语义包住');
  assert.match(verified, /summary\.productRed === 0\) return first/, '复核必须先在没有 product 红时早退（不许无条件重跑）');
  assert.match(verified, /productRed === 0 && \(first\.summary\.env \|\| \[\]\)\.length/, 'env-only 复核必须有前置条件（没有 env 红就不许跑）');
  assert.match(verified, /summary\.envRecheck\s*=/, 'env-only 复核的结果必须记账（不许偷偷把红转绿）');
  assert.match(verified, /mode: 'serial'/, '复核必须串行（否则只是把并行再跑一遍）');
  assert.match(verified, /mergeRecheck/, '复核结果必须经 mergeRecheck 记账（不许偷偷把红转绿）');
  const stripped = runner
    .replace(/maxRetries\s*:\s*\d+/gi, '')      // 连键名一起剥 —— 只剥值的话 `retryDelay` 这个名字仍会被下面的 /retry/ 命中（首跑实测）
    .replace(/retryDelay\s*:\s*\d+/gi, '');
  assert.match(runner, /maxRetries\s*:\s*\d+/i, '本仓 runner 确有清理用 maxRetries —— 上面的剥离必须真的改到东西');
  assert.doesNotMatch(stripped, /retry|rerun|secondPass|\battempts?\b/i, '剥掉清理参数后，runner 内不得再有测试级重试语义（retry 不当第一响应；要重试须显式 opt-in 并计数）');
});
