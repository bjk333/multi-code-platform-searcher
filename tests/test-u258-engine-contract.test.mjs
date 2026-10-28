// U-258（B2-1 + B2-2，2026-10-26）：EngineContract v1 封套 + 兼容层。
//
// ★先记一条**事实纠正**（它改的是理由，不是任务）：源码 L1193 断言"引擎在 runspace 内的 Set-EngineStatus
//   写不进父作用域"，B2 的方案正是建立在它上面。2026-10-26 实测**不成立**：
//   `_engineStatus` 是 ConcurrentDictionary 且在 `_injectVars` 里（注入的是引用），runspace 内写入父侧立即可见。
//   ⇒ 封套要解决的其实是另外三件：状态是**旁路**（引擎早退就没人写，池尾只能按条数猜）、
//     reasonCode 靠**文案正则**反推、requests/quota/partial/elapsedMs 没有逐引擎口径。
//
// 门分三层：
//   A **执行**真函数：HF 三臂（成功/零命中/失败）、兼容层三形态、verdict 矩阵 10 行、混跑真池（1 新 + 1 旧）、串行回退、per-round 重置
//   B 不变量：封套字段集恰好 9 个；engine/0 **不带**判定材料（保证旧引擎行为不变）；混跑时封套不许漏进结果集
//   C 可执行变异：拆掉任一处 ⇒ 观测值必须按预测变（证明 A 不是恒真），共 5 条
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPwsh } from './r2-ps-run.mjs';
import { sourceAll } from './lib/source.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HARNESS = path.join(ROOT, 'tests', 'u258-engine-contract-harness.ps1');
const MAIN = path.join(ROOT, 'multi-platform-searcher.ps1');
const SRC = sourceAll(ROOT);

let cache = null;
async function facts(skillDir) {
  const args = skillDir ? ['-File', HARNESS, '-SkillDir', skillDir] : ['-File', HARNESS];
  const r = await runPwsh(args, { timeoutMs: 240000 });
  const line = (r.stdout || '').split(/\r?\n/).filter(l => l.trim().startsWith('{"ok"')).pop();
  assert.ok(line, `harness 未输出 JSON 事实行（rc=${r.status}）；tail=${(r.stdout || '').slice(-400)}`);
  return JSON.parse(line);
}
async function base() { if (!cache) cache = await facts(); return cache; }

test('U-258-A: HF 三臂 —— 成功/零命中/失败都必须各自说清（零命中不是失败，失败不冒充零命中）', async () => {
  const f = await base();
  const by = Object.fromEntries(f.hf.map(a => [a.id, a]));
  assert.deepEqual(f.fails, [], f.fails.join('; '));
  // A 成功臂：3 个 kind 各 1 条
  assert.equal(by.A.contract, 'engine/1');
  assert.equal(by.A.n, 3);
  assert.equal(by.A.vStatus, 'ok');
  assert.equal(by.A.attempted, 3);
  assert.equal(by.A.succeeded, 3);
  assert.equal(by.A.failed, 0);
  // B 零命中：请求**全部成功**、结果 0 条 ⇒ empty/zero-hit。这条是 U-155/U-157 反复踩的那条界线：
  //   把 empty 写成 error 会让用户去查网络；把 error 写成 empty 会让人以为"库里没有"。
  assert.equal(by.B.n, 0);
  assert.equal(by.B.vStatus, 'empty');
  assert.equal(by.B.vCode, 'zero-hit');
  assert.equal(by.B.succeeded, 3);
  // C 全失败：3 次尝试 0 成功 3 失败 ⇒ error
  assert.equal(by.C.n, 0);
  assert.equal(by.C.hasFailure, true);
  assert.equal(by.C.attempted, 3);
  assert.equal(by.C.succeeded, 0);
  assert.equal(by.C.failed, 3);
  assert.equal(by.C.vStatus, 'error');
});

test('U-258-B: 封套字段集恰好 9 个 + 兼容层不改行为（engine/0 不带判定材料）', async () => {
  const f = await base();
  const want = ['contract', 'elapsedMs', 'engine', 'failure', 'kind', 'partial', 'quota', 'requests', 'results'];
  for (const a of f.hf) assert.deepEqual(a.fields, want, `${a.id}: 封套字段集变了（新增字段必须同时改 schema/文档，否则先在这里红）`);
  // 兼容层：数组/空/单对象三形态都归一到 engine/0，条数逐一对应
  const c = f.compat[0];
  assert.equal(c.arr, 2);
  assert.equal(c.empty, 0);
  assert.equal(c.one, 1, '单个 PSCustomObject 被误判成封套会丢掉这条结果');
  assert.equal(c.passThrough, 'engine/1', '已是 engine/1 的必须原样透传（不能二次包裹）');
  // engine/0 的判定材料必须为空：兼容层**不派生** verdict，旧引擎继续走状态表 + 池尾兜底。
  //   若这里被填上，22 个未迁移引擎的行为会同时改变 —— 那就不是"兼容层"，是"静默换语义"。
  assert.deepEqual(f.fails, [], f.fails.join('; '));
});

test('U-258-C: verdict 矩阵 10 行（纯函数）—— blocked 与 error 的界线、degraded 不抬高 coverage', async () => {
  const f = await base();
  const by = Object.fromEntries(f.matrix.map(r => [r.id, r]));
  const want = {
    E1: ['ok', '', 'ok'],
    E2: ['empty', 'zero-hit', 'empty'],
    // 有产出 + 有失败 ⇒ degraded，但**旧状态仍是 ok**：coverage 的三分类只看 ok/empty/blocked/error，
    //   degraded 若映射成 error，会把"部分成功"整源记成失败（Verdict 从 full 掉到 degraded）。
    E3: ['degraded', 'rate-limited', 'ok'],
    E4: ['blocked', 'missing-credential', 'auth_missing'],
    E5: ['blocked', 'tool-missing', 'tool_missing'],
    // health-skip 是"没执行"，不是"失败" ⇒ blocked，且旧状态 unknown（让 coverage 记 not-run 而不是 error）
    E6: ['blocked', 'health-skip', 'unknown'],
    E7: ['error', 'rate-limited', 'rate_limited'],
    E8: ['error', 'network-unavailable', 'network_unavailable'],
    E9: ['error', 'deadline', 'error'],
    // 无 reasonCode 的失败必须兜底成 'error'，不许留空串（空串会被 coverage 当成"没问题"）
    E10: ['error', 'error', 'error'],
  };
  for (const [id, [st, rc, legacy]] of Object.entries(want)) {
    assert.ok(by[id], `缺矩阵行 ${id}`);
    assert.deepEqual([by[id].status, by[id].code, by[id].legacy], [st, rc, legacy], `${id}`);
  }
});

test('U-258-D: 混跑真池（1 个 engine/1 + 1 个 engine/0）—— 封套不许漏进结果集', async () => {
  const f = await base();
  assert.equal(f.mixed.n, 3, '结果并集应为 2（旧引擎）+ 1（新引擎）');
  // 这条是本次最容易犯的错：`$all += $res` 在引擎返回封套时会把**封套对象**当成一条结果。
  //   泄漏后 total 仍可能是 3（1 封套 + 2），所以必须单独断言 leak===0 而不是只看总数。
  assert.equal(f.mixed.leak, 0, '封套对象混进了结果集');
  assert.equal(f.mixed.fake1, 'ok');
  assert.equal(f.mixed.fake2, 'ok', '旧引擎的状态路径必须逐位不变');
  assert.equal(f.serial, 1, '串行回退路径返回的必须是 results（1 条），不是封套');
});

test('U-258-E: 可执行变异 —— 拆任一处，观测值必须按预测变', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u258m-'));
  // ★不能用 `fs.cpSync(..., {recursive:true})`：本机 node 的 fs 代理垫片在这个调用上会**原生崩溃**
  //   （0xC0000409 / STATUS_STACK_BUFFER_OVERRUN，实测 `_verify/diag-cp.mjs` 复现，rc=127 无输出）。
  //   手动递归复制，顺带只拷 .ps1（engines/ 之外的东西主脚本不需要）。
  const copyDir = (src, dst) => {
    fs.mkdirSync(dst, { recursive: true });
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, e.name), d = path.join(dst, e.name);
      if (e.isDirectory()) copyDir(s, d);
      else if (e.name.endsWith('.ps1')) fs.copyFileSync(s, d);
    }
  };
  copyDir(path.join(ROOT, 'engines'), path.join(dir, 'engines'));
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  fs.copyFileSync(HARNESS, path.join(dir, 'tests', 'u258-engine-contract-harness.ps1'));
  const mainPath = path.join(dir, 'multi-platform-searcher.ps1');
  const write = s => fs.writeFileSync(mainPath, s, 'utf8');
  const muts = [
    ['①归一后不取 results ⇒ 封套漏进结果集', 'return @($envl.results)', 'return $envl',
      // 期望值是 2 而不是 1：**两个引擎都会漏** —— Fake1 漏 engine/1 封套，Fake2 漏 engine/0 包装。
      //   这条恰好说明"兼容层也会被漏"，即这个错误不是"只影响新引擎"，而是"新旧一起坏、且原始结果全被吞进包装里"。
      async f => { assert.equal(f.mixed.leak, 2, '把封套直接累加后未观察到泄漏 —— D 层断言可能恒真'); assert.equal(f.mixed.n, 2, '原始结果被吞进包装，总数从 3 掉到 2'); }],
    ['②blocked 名单去掉 missing-credential ⇒ 缺凭据被报成失败', "'missing-credential', 'tool-missing'", "'tool-missing'",
      async f => {
        const e4 = f.matrix.find(r => r.id === 'E4');
        assert.equal(e4.status, 'error', '缺凭据不再 blocked ⇒ 用户会去查网络而不是配 key');
        assert.equal(e4.legacy, 'error');
      }],
    ['③兼容层不滤 $null ⇒ 一个 $null 被当成一条结果', '@($Result | Where-Object { $null -ne $_ })', '@($Result)',
      async f => { assert.ok(f.fails.some(x => x.startsWith('D.$null')), '空数组与 $null 又混为一谈'); }],
    ['④串行回退绕过归一点', 'return @(Resolve-EngineResultEnvelope -Engine $Engine -Raw (& $Engine.Func @EngineArgs))', 'return (& $Engine.Func @EngineArgs)',
      async f => { assert.ok(f.fails.some(x => x.startsWith('G.')), '串行路径把封套当结果返回了'); }],
    ['⑤每轮不清 verdict ⇒ 上轮的码冒充这轮的证据', '    try { $script:_engineVerdict.Clear() } catch { }', '    # mutated: no reset',
      async f => { assert.ok(f.fails.some(x => x.startsWith('H.')), 'stale verdict 未被清掉'); }],
  ];
  for (const [name, from, to, expect] of muts) {
    const m = SRC.split(from).join(to);
    assert.notEqual(m, SRC, `${name}: 变异未生效（锚点变了？）`);
    write(m);
    const f = await facts(dir);
    try { await expect(f); }
    catch (e) { e.message = `${name}: ${e.message}`; throw e; }
  }
  write(SRC);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { }
});
