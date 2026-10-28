// U-264（B2-1 3/4，2026-10-26）：DeepSeek 迁 EngineContract v1 —— 封套契约 + 请求账 + **配额口径**。
//
// 为什么单独立门（而不是并进 U-263）：DeepSeek 是唯一会走 **402** 的付费源。402 一旦落错格子，
//   载荷就会写出两种相反的话：`ReasonCodes=quota-exhausted`（没钱）而 `NotRun`（这个源没跑）。
//   本门钉住三层各自的落点，并额外把「引擎写的 reasonCode 必须在 schema 枚举内」变成可执行断言 ——
//   B2-1 之后 reasonCode 的真源从「主脚本一处 switch」散到了「每个引擎的 failure 字符串」，
//   没有这条门，写个下划线版本（quota_exhausted）不会有任何东西变红。
//
// 四层：
//   A 八臂真相：ok / zero / filtered / auth401 / quota402 / rate429 / forbid403 / nokey
//   B 封套形状 + 请求账精确数字（恒等式抓不到"两边一起错"）
//   C verdict 规则表：filtered ⇒ empty（不是 error）、quota ⇒ legacy=error（不是 unknown）
//   D 可执行变异 5 条
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPwsh } from './r2-ps-run.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HARNESS = path.join(ROOT, 'tests', 'u264-deepseek-contract-harness.ps1');
const MAIN = path.join(ROOT, 'multi-platform-searcher.ps1');
const DS = fs.readFileSync(path.join(ROOT, 'engines', 'deepseek-search.ps1'), 'utf8');
const FIELDS = ['contract', 'elapsedMs', 'engine', 'failure', 'kind', 'partial', 'quota', 'requests', 'results'];

let cache = null;
async function facts(skillDir) {
  const args = skillDir ? ['-File', HARNESS, '-SkillDir', skillDir] : ['-File', HARNESS];
  const r = await runPwsh(args, { timeoutMs: 180000 });
  const line = (r.stdout || '').split(/\r?\n/).filter(l => l.trim().startsWith('{"ok"')).pop();
  assert.ok(line, `harness 未输出 JSON 事实行（rc=${r.status}）；tail=${(r.stdout || '').slice(-400)}`);
  return JSON.parse(line);
}
async function base() { if (!cache) cache = await facts(); return cache; }
const arm = (f, id) => f.arms.find(a => a.id === id);

test('U-264-A: 八臂 —— 0 命中/被门槛丢弃都算成功，401/402/429/403 各自落对格', async () => {
  const f = await base();
  assert.deepEqual(f.fails, [], f.fails.join('; '));
  // ok：3 条里 2 条过门槛、1 条被丢 ⇒ 有产出仍是 ok（dropped>0 不是 failure）
  const ok = arm(f, 'ok');
  assert.equal(ok.n, 2, '2 条过门槛、1 条被丢');
  assert.equal(ok.hasFailure, false, '有产出时 dropped>0 不该挂 failure');
  assert.equal(ok.vStatus, 'ok');
  // zero：源返回 0 条 ⇒ 无 failure ⇒ empty/zero-hit（"搜了没结果"是成功）
  const z = arm(f, 'zero');
  assert.equal(z.n, 0);
  assert.equal(z.hasFailure, false, '源返回 0 条不许挂 failure');
  assert.equal(z.vStatus, 'empty');
  assert.equal(z.vCode, 'zero-hit');
  // filtered：返回 2 条但全低于门槛 ⇒ filtered（**不是** zero-hit：源健康，是我们自己丢的）
  const fl = arm(f, 'filtered');
  assert.equal(fl.n, 0);
  assert.equal(fl.failureCode, 'filtered', '全被门槛丢掉必须报 filtered，不许混成 zero-hit');
  assert.equal(fl.vStatus, 'empty', '★filtered 必须算成功（empty），归成 error 会把"我们丢了"报成"源坏了"');
  assert.equal(fl.legacy, 'empty');
  // 401：缺凭据 ⇒ blocked（用户该去配 key，不是查网络）
  const a = arm(f, 'auth401');
  assert.equal(a.failureCode, 'missing-credential');
  assert.equal(a.vStatus, 'blocked');
  assert.equal(a.legacy, 'auth_missing');
  // 402：配额耗尽 ⇒ quota-exhausted（v2 新枚举）+ blocked；★legacy 必须是 error（⇒ Degraded），
  //   不能是 unknown —— 那会让它落进 coverage 的 NotRun，等于说"这个源压根没跑"。
  const q = arm(f, 'quota402');
  assert.equal(q.failureCode, 'quota-exhausted');
  assert.equal(q.vStatus, 'blocked', '402 的 actionable 是充值/换 key，与 auth_missing 同类');
  assert.equal(q.legacy, 'error', '★quota 压成 unknown 会被记进 NotRun —— 那是谎称"这个源没跑"');
  // 429：可恢复限流 ⇒ rate-limited ⇒ legacy rate_limited（健康记忆靠这个串判"短 TTL 冷却"）
  const r = arm(f, 'rate429');
  assert.equal(r.failureCode, 'rate-limited');
  assert.equal(r.vStatus, 'error');
  assert.equal(r.legacy, 'rate_limited');
  // 403：权限 ⇒ forbidden ⇒ error（与 U-178 同口径：不许说成限流）
  const b = arm(f, 'forbid403');
  assert.equal(b.failureCode, 'forbidden');
  assert.equal(b.legacy, 'error');
  // 无 key：可选付费源未配置 ⇒ not-run，**零请求**；且不许报成 missing-credential
  //   （后者会让人去查"key 是不是失效了"，而事实是"你没打算用这个源"）
  const nk = arm(f, 'nokey');
  assert.equal(nk.failureCode, 'not-run');
  assert.deepEqual([nk.rAttempted, nk.rSucceeded, nk.rFailed], [0, 0, 0], '无 key 必须零请求（付费源！）');
  assert.equal(nk.quotaClass, 'none');
  // 不自报：八臂跑完状态表里都不该出现 DeepSeek
  for (const x of f.arms) assert.equal(x.selfReport, 'unknown', `${x.id}: 引擎自报了 status`);
});

test('U-264-B: 封套形状与请求账 —— 9 字段、prepaid、每臂精确数字', async () => {
  const f = await base();
  for (const x of f.arms) {
    assert.deepEqual([...x.fields].sort(), FIELDS, `${x.id}: 封套字段集不符`);
    assert.equal(x.contract, 'engine/1', `${x.id}: contract 必须 engine/1`);
    assert.equal(x.engine, 'DeepSeek');
    assert.equal(x.kind, 'research');
    assert.equal(x.elapsedOk, true, `${x.id}: elapsedMs 必须是非负整数（不许 null/编 0）`);
  }
  const expect = {
    ok: [1, 1, 0], zero: [1, 1, 0], filtered: [1, 1, 0],
    auth401: [1, 0, 1], quota402: [1, 0, 1], rate429: [1, 0, 1], forbid403: [1, 0, 1],
    nokey: [0, 0, 0],
  };
  for (const [id, [at, su, fa]] of Object.entries(expect)) {
    const x = arm(f, id);
    assert.deepEqual([x.rAttempted, x.rSucceeded, x.rFailed], [at, su, fa], `${id}: 请求账不符`);
    assert.equal(x.rSucceeded + x.rFailed, x.rAttempted, `${id}: 恒等式不成立`);
  }
  // quota.class：DeepSeek 是预付费余额（不是 anonymous 也不是 token 配额桶）
  for (const id of ['ok', 'zero', 'filtered', 'auth401', 'quota402']) {
    assert.equal(arm(f, id).quotaClass, 'prepaid', `${id}: 有 key 时配额类别必须是 prepaid`);
  }
});

test('U-264-C: verdict 规则表 —— filtered 是 empty 不是 error；quota 的 legacy 是 error 不是 unknown', async () => {
  const f = await base();
  const R = f.rules;
  assert.deepEqual([R.n0NoFail.status, R.n0NoFail.code], ['empty', 'zero-hit']);
  assert.deepEqual([R.n0Filtered.status, R.n0Filtered.code], ['empty', 'filtered'], '★被门槛丢掉 = 成功但没有可用结果');
  assert.deepEqual([R.n0Quota.status, R.n0Quota.legacy], ['blocked', 'error'], '★quota：verdict blocked 但 legacy error');
  assert.deepEqual([R.n0NotRun.status, R.n0NotRun.legacy], ['blocked', 'unknown'], 'not-run 才是真的"没跑"');
  assert.deepEqual([R.n2NoFail.status, R.n2NoFail.code], ['ok', '']);
  // 有产出 + 有 failure ⇒ degraded（保留首因，不假装完整成功）
  assert.deepEqual([R.n2Filtered.status, R.n2Filtered.code], ['degraded', 'filtered']);
  // ★负例方向：zero-hit 若被引擎当成 failure 报上来，必须落 error —— 它是 L1 派生的码，引擎不许自己写
  assert.equal(R.n0ZeroHit.status, 'error', 'zero-hit 作为 failure 出现时必须报错（引擎不该写它）');
});

test('U-264-D: 源码不变量 —— 引擎写的 reasonCode 必须 ∈ schema 枚举（B2-1 之后真源散到了引擎里）', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'schema/asjson.schema.json'), 'utf8').replace(/^\uFEFF/, ''));
  const ENUM = schema.properties.coverage.properties.ReasonCodes.additionalProperties.enum;
  assert.ok(ENUM.includes('quota-exhausted'), 'schema 必须收录 v2 新码 quota-exhausted');
  assert.equal(ENUM.length, 13, `reasonCode 枚举应为 13 值（12 + quota-exhausted），实得 ${ENUM.length}`);

  const files = fs.readdirSync(path.join(ROOT, 'engines')).filter(f => f.endsWith('.ps1'))
    .map(f => [`engines/${f}`, fs.readFileSync(path.join(ROOT, 'engines', f), 'utf8')]);
  // v1.54.0（B3-2）：reasonCode 的真源现在也散在 lib/*.ps1（引擎封套、HTTP 层、健康记忆都在那儿）。
  //   不把 lib 纳进来 = 门只扫到一半源码却在"没发现非法码"上变绿（假绿）。
  const libDir = path.join(ROOT, 'lib');
  if (fs.existsSync(libDir)) {
    for (const f of fs.readdirSync(libDir).filter(f => f.endsWith('.ps1')).sort())
      files.push([`lib/${f}`, fs.readFileSync(path.join(libDir, f), 'utf8')]);
  }
  files.push(['multi-platform-searcher.ps1', fs.readFileSync(MAIN, 'utf8')]);
  const seen = new Map();
  for (const [file, src] of files) {
    for (const raw of src.split(/\r?\n/)) {
      if (/^\s*#/.test(raw)) continue;                    // 行首注释不算（U-41 的老坑：注释绊住正则）
      // 两个真源：① 引擎直接写的 reasonCode ② failMap 表里的 code（`\bcode` 不会误中 statusCode）
      for (const m of raw.matchAll(/(?:reasonCode|\bcode|code)\s*=\s*'([A-Za-z0-9_-]+)'/g)) {
        const c = m[1];
        if (!seen.has(c)) seen.set(c, new Set());
        seen.get(c).add(file);
      }
    }
  }
  // 防假绿：一条都没扫到 ⇒ 正则坏了，门会全绿
  assert.ok(seen.size >= 5, `只扫到 ${seen.size} 个码 —— 正则失效了？（本仓至少 5 个）`);
  const bad = [...seen.keys()].filter(c => !ENUM.includes(c));
  assert.deepEqual(bad, [], `引擎写了 schema 枚举外的码：${bad.map(c => `${c}(${[...seen.get(c)].join(',')})`).join('; ')}`);
  // 具体钉住本批新增的那个（否则"扫描正则把 DeepSeek 整段跳过"也能绿）
  assert.ok(seen.has('quota-exhausted'), '扫不到 quota-exhausted ⇒ 扫描没覆盖 deepseek-search.ps1');
});

test('U-264-E: 可执行变异 —— 拆任一处，观测值必须按预测变', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u264m-'));
  const copyDir = (src, dst) => {
    fs.mkdirSync(dst, { recursive: true });
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, e.name), d = path.join(dst, e.name);
      if (e.isDirectory()) copyDir(s, d);
      else if (e.name.endsWith('.ps1')) fs.copyFileSync(s, d);
    }
  };
  copyDir(path.join(ROOT, 'engines'), path.join(dir, 'engines'));
  // v1.54.0（B3-2）：函数搬进 lib/ ⇒ 夹具目录必须带上 lib，否则点源出来的产品只剩入口。
  copyDir(path.join(ROOT, 'lib'), path.join(dir, 'lib'));
  fs.copyFileSync(MAIN, path.join(dir, 'multi-platform-searcher.ps1'));
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  fs.copyFileSync(HARNESS, path.join(dir, 'tests', 'u264-deepseek-contract-harness.ps1'));
  const dsPath = path.join(dir, 'engines', 'deepseek-search.ps1');
  const muts = [
    ['①失败不记 failed ⇒ 请求账变小', { from: '$msg = "$($_.Exception.Message)"; $req.failed++', to: '$msg = "$($_.Exception.Message)"' },
      async f => {
        const x = arm(f, 'auth401');
        assert.deepEqual([x.rAttempted, x.rSucceeded, x.rFailed], [1, 0, 0]);
        assert.notEqual(x.rSucceeded + x.rFailed, x.rAttempted, '恒等式必须破');
      }],
    ['②402 归成普通 error ⇒ 余额不足不再精确', { from: "= @{ code = 'quota-exhausted';", to: "= @{ code = 'error';" },
      async f => {
        assert.equal(arm(f, 'quota402').failureCode, 'error');
        assert.equal(arm(f, 'quota402').vStatus, 'error', '402 会被当成"执行了但失败"，用户看不出该充值');
      }],
    ['③filtered 归成 error ⇒ "我们丢的"被报成"源坏了"', { from: "reasonCode = 'filtered'; reason", to: "reasonCode = 'error'; reason" },
      async f => {
        const x = arm(f, 'filtered');
        assert.equal(x.failureCode, 'error');
        assert.equal(x.vStatus, 'error', '用户会去查网络，而该做的是调 MCPS_DEEPSEEK_MIN_SCORE');
      }],
    ['④无 key 报 missing-credential ⇒ 语义从"没打算用"变"key 失效"', { from: "reasonCode = 'not-run'; reason = 'DEEPSEEK_API_KEY 未配置", to: "reasonCode = 'missing-credential'; reason = 'DEEPSEEK_API_KEY 未配置" },
      async f => {
        assert.equal(arm(f, 'nokey').failureCode, 'missing-credential');
        assert.equal(arm(f, 'nokey').legacy, 'auth_missing', '可选源的"没配"被报成"配错了"');
      }],
    // ★锚点不要跨换行：本仓 ps1 是 CRLF，JS 字符串里写 `\n` 匹配不到（变异"未生效"就是这么来的）
    ['⑤配额类别写死 anonymous ⇒ 付费源被报成匿名', { from: "class = 'prepaid';", to: "class = 'anonymous';" },
      async f => { assert.equal(arm(f, 'ok').quotaClass, 'anonymous', '带 key 却报匿名 ⇒ "这源在烧钱"这件事看不见'); }],
  ];
  try {
    for (const [name, m, expect] of muts) {
      const mutated = DS.split(m.from).join(m.to);
      assert.notEqual(mutated, DS, `${name}: 变异未生效（锚点变了？）`);
      fs.writeFileSync(dsPath, mutated, 'utf8');
      const f = await facts(dir);
      try { await expect(f); }
      catch (e) { e.message = `${name}: ${e.message}`; throw e; }
      fs.writeFileSync(dsPath, DS, 'utf8');   // 逐条还原：否则上一条变异会污染下一条的读数
    }
  } finally {
    fs.writeFileSync(dsPath, DS, 'utf8');
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { }
  }
});
