// U-261（B2-6，2026-10-26）：成本账本 v0。
//
// 账本唯一要保证的事：**一行 = 一次线上尝试**，且 `行数 == metrics.Requests`。
//   为什么这条比"字段齐全"重要：账本悄悄丢行比没有账本更坏 —— 它会让人得出"402 之后没重试"这种结论，
//   而那个结论恰好是账本要回答的问题。
//
// 门分四层：
//   A **执行**真 `Invoke-ApiRequest`（只桩发包）：6 臂——ok / 402 / 429-stopt / 429-retry / 500 / transport(node 兜底)
//   B 纯函数真值表：outcome/reasonCode/quotaClass 只由 (是否成功, 状态码) 决定，闭集
//   C 落盘：真写 JSONL 再读回来（written / 行数 / (runId,seq) 唯一 / 字段集 11 个 / 追加而非覆盖）
//   D 真跑 CLI：`execution.ledger.rows == metrics.Requests`，且文件行数与之一致（网络通不通都要成立）
//   E 可执行变异 5 条：拆任一处，观测值必须按预测变
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPwsh } from './r2-ps-run.mjs';
import { validate } from './asjson-validator.mjs';
import { sourceAll } from './lib/source.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HARNESS = path.join(ROOT, 'tests', 'u261-cost-ledger-harness.ps1');
const MAIN = path.join(ROOT, 'multi-platform-searcher.ps1');
const SRC = sourceAll(ROOT);
const ROW_KEYS = ['attempt', 'engine', 'httpStatus', 'latencyMs', 'mode', 'outcome', 'quotaClass', 'reasonCode', 'runId', 'seq', 'ts'];

let cache = null;
async function facts(skillDir) {
  const args = skillDir ? ['-File', HARNESS, '-SkillDir', skillDir] : ['-File', HARNESS];
  const r = await runPwsh(args, { timeoutMs: 240000 });
  const line = (r.stdout || '').split(/\r?\n/).filter(l => l.trim().startsWith('{"ok"')).pop();
  assert.ok(line, `harness 未输出 JSON 事实行（rc=${r.status}）；tail=${(r.stdout || '').slice(-400)}`);
  return JSON.parse(line);
}
async function base() { if (!cache) cache = await facts(); return cache; }
const arm = (f, id) => f.arms.find(a => a.id === id);

test('U-261-A: 六臂 —— 每次线上尝试一行；422/429/500/transport 各按状态码归因', async () => {
  const f = await base();
  assert.deepEqual(f.fails, [], f.fails.join('; '));
  // ① ok：1 行、200、ok
  const ok = arm(f, 'ok');
  assert.equal(ok.count, 1);
  assert.equal(ok.rows[0].httpStatus, 200);
  assert.equal(ok.rows[0].outcome, 'ok');
  assert.equal(ok.rows[0].reasonCode, null);
  assert.equal(ok.rows[0].quotaClass, 'none');
  // ② 402：**1 行且不重试** —— 这就是"402 行 retryIndex=0"的可执行版本
  const q = arm(f, 'http402');
  assert.equal(q.count, 1, '402 竟然被重试了（账本行数 >1）');
  assert.equal(q.rows[0].httpStatus, 402);
  assert.equal(q.rows[0].outcome, 'failure');
  assert.equal(q.rows[0].reasonCode, 'quota-exhausted');
  assert.equal(q.rows[0].quotaClass, 'quota');
  assert.equal(q.rows[0].attempt, 1);
  // ③ 429 停：1 行
  const s429 = arm(f, 'http429stop');
  assert.equal(s429.count, 1);
  assert.equal(s429.rows[0].reasonCode, 'rate-limited');
  assert.equal(s429.rows[0].quotaClass, 'rate-limit');
  // ④ 429 重试：**2 行**，attempt 1/2（重试不是"一次尝试记两遍"，是两次）
  const r429 = arm(f, 'http429retry');
  assert.equal(r429.count, 2, '重试后应有两行');
  assert.deepEqual(r429.rows.map(r => r.attempt), [1, 2]);
  assert.deepEqual(r429.rows.map(r => r.httpStatus), [429, 429]);
  // ⑤ 500
  const e5 = arm(f, 'http500');
  assert.equal(e5.count, 1);
  assert.equal(e5.rows[0].reasonCode, 'http-5xx');
  // ⑥ transport：web + node 兜底 = 2 行，且**都没有状态码**（不编一个）
  const t = arm(f, 'transport');
  assert.equal(t.count, 2, 'node 兜底也是一次线上尝试（Requests 口径相同）');
  assert.deepEqual(t.rows.map(r => r.httpStatus), [null, null]);
  assert.deepEqual(t.rows.map(r => r.reasonCode), ['transport', 'transport']);
  // 每臂的硬恒等式
  for (const a of f.arms) assert.equal(a.count, a.attempted, `${a.id}: 行数 ${a.count} != Requests ${a.attempted}`);
  // 归属：engine/mode 来自上下文，不是猜的
  for (const a of f.arms) for (const r of a.rows) {
    assert.equal(r.engine, 'FakeEngine', `${a.id}: engine 丢失`);
    assert.equal(r.mode, 'code', `${a.id}: mode 丢失`);
  }
  // 重置：0 行 + runId 换新
  assert.equal(f.reset.rowsAfterReset, 0);
  assert.equal(f.reset.runIdChanged, true);
});

test('U-261-B: 纯函数真值表 —— 判定只看 (是否成功, 状态码)，闭集，2xx 一律 ok', async () => {
  const f = await base();
  const by = Object.fromEntries(f.verdicts.map(v => [String(v.status), v]));
  // 2xx 无论有没有 -Ok 都是成功（第一版把"2xx 没传 -Ok"归成 transport —— 知道状态码却报成不知道）
  for (const s of ['200', '201', '204']) assert.equal(by[s].outcome, 'ok', `${s} 应为 ok`);
  assert.equal(by['402'].reasonCode, 'quota-exhausted');
  assert.equal(by['402'].quotaClass, 'quota');
  assert.equal(by['429'].reasonCode, 'rate-limited');
  assert.equal(by['429'].quotaClass, 'rate-limit');
  assert.equal(by['403'].reasonCode, 'http-4xx', '403 不冒充限流（限流要 429 或 403+限流头，后者在请求层已单独判）');
  assert.equal(by['404'].reasonCode, 'http-4xx');
  assert.equal(by['500'].reasonCode, 'http-5xx');
  assert.equal(by['503'].reasonCode, 'http-5xx');
  assert.equal(by['0'].reasonCode, 'transport');
  assert.equal(by['null'].reasonCode, 'transport', 'null 状态码 ⇒ transport，不猜具体原因');
  assert.equal(by['ok'].outcome, 'ok');
  // 闭集：不允许出现没登记过的码（出现即说明有人往账本里写了自由文本）
  const OUT = new Set(['ok', 'failure']);
  const RC = new Set([null, 'quota-exhausted', 'rate-limited', 'http-5xx', 'http-4xx', 'transport']);
  const QC = new Set(['none', 'quota', 'rate-limit']);
  for (const v of f.verdicts) {
    assert.ok(OUT.has(v.outcome), `outcome 越界: ${v.outcome}`);
    assert.ok(RC.has(v.reasonCode), `reasonCode 越界: ${v.reasonCode}`);
    assert.ok(QC.has(v.quotaClass), `quotaClass 越界: ${v.quotaClass}`);
  }
});

test('U-261-C: 落盘 —— written 与文件行数都对得上；(runId,seq) 唯一；追加不是覆盖', async () => {
  const f = await base();
  const c = f.file;
  assert.equal(c.error, '', `落盘报错: ${c.error}`);
  assert.equal(c.pathSet, true);
  assert.deepEqual(c.written, [2, 2], '两轮各写 2 行（每轮 2 次请求）');
  assert.equal(c.lines, 4, '两轮必须**追加**成 4 行（覆盖的话是 2 行）');
  assert.equal(c.parsed, 4);
  assert.equal(c.uniqRunIds, 2, '两轮 runId 必须不同（runId 每轮换新）');
  assert.equal(c.uniqPairs, 4, '(runId,seq) 必须唯一 —— 每轮内 2 行，seq 必须 1/2');
  assert.deepEqual([...c.keys].sort(), ROW_KEYS, '账本行字段集必须恰好 11 个（多一个就是没约定的私货）');
  assert.notEqual(c.sample, null);
  assert.equal(c.sample.outcome, 'ok');
  assert.equal(c.sample.engine, 'FileEngine');
  assert.equal(c.sample.mode, 'research');
});

test('U-261-D: 真跑 CLI —— `execution.ledger.rows == metrics.Requests`，文件行数同值', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u261live-'));
  const led = path.join(dir, 'ledger.jsonl');
  try {
    const r = await runPwsh(['-File', path.join(ROOT, 'multi-platform-searcher.ps1'),
      '-Platform', 'Codeberg', '-Keyword', 'vector database', '-Limit', '2', '-AsJson', '-NoCache'],
      { timeoutMs: 240000, cwd: ROOT, env: { ...process.env, MCPS_LEDGER: led, MCPS_HEALTH: '0' } });
    const out = r.stdout || '';
    const i = out.indexOf('{');
    assert.ok(i >= 0, `没有 JSON 输出（rc=${r.status}）: ${out.slice(-300)}`);
    let payload = null;
    try { payload = JSON.parse(out.slice(i)); }
    catch (e) {
      // 结尾可能混入进度/提示行：退一步，取最后一个 } 之前
      const j = out.lastIndexOf('}');
      payload = JSON.parse(out.slice(i, j + 1));
    }
    const lg = payload.execution?.ledger;
    assert.ok(lg && typeof lg === 'object', 'execution.ledger 必须存在（接线断了）');
    assert.equal(typeof lg.runId, 'string');
    assert.ok(lg.runId.length >= 8, `runId 太短: ${lg.runId}`);
    assert.ok(lg.rows >= 1, `一次真跑至少 1 次尝试（实得 ${lg.rows}）—— 0 说明引擎压根没发请求`);
    assert.equal(lg.rows, payload.metrics.Requests, `行数 ${lg.rows} != metrics.Requests ${payload.metrics.Requests}`);
    assert.equal(lg.error, null, `落盘报错: ${lg.error}`);
    assert.equal(lg.written, lg.rows, 'written 必须等于 rows');
    assert.ok(lg.path && fs.existsSync(lg.path), `账本文件不存在: ${lg.path}`);
    const lines = fs.readFileSync(lg.path, 'utf8').split(/\r?\n/).filter(Boolean);
    assert.equal(lines.length, lg.rows, '文件行数必须等于 rows');
    const rows = lines.map(l => JSON.parse(l));
    for (const row of rows) {
      assert.deepEqual(Object.keys(row).sort(), ROW_KEYS, `行字段集不符: ${Object.keys(row).join(',')}`);
      assert.equal(row.runId, lg.runId, '文件里的 runId 必须与汇总一致');
      assert.notEqual(row.outcome, 'open', '落到文件的行业必须是已结的（open = 没收尾）');
      assert.equal(row.engine, 'Codeberg');
      assert.equal(row.mode, 'repo');
    }
    // schema：ledger 是闭合对象，行级字段不该出现在载荷里
    const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'schema', 'asjson.schema.json'), 'utf8').replace(/^\uFEFF/, ''));
    validate(schema, payload);
    const bad = JSON.parse(JSON.stringify(payload));
    delete bad.execution.ledger;
    assert.throws(() => validate(schema, bad), /missing required ledger/, '缺 ledger 必须红（否则 schema 的 required 是摆设）');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { }
  }
});

test('U-261-E: 可执行变异 —— 拆任一处，观测值必须按预测变', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u261m-'));
  // 手动递归复制（`fs.cpSync(...,{recursive:true})` 在本机 node 垫片上会原生崩溃，见 U-258-E）
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
  fs.copyFileSync(HARNESS, path.join(dir, 'tests', 'u261-cost-ledger-harness.ps1'));
  const mainPath = path.join(dir, 'multi-platform-searcher.ps1');
  const write = s => fs.writeFileSync(mainPath, s, 'utf8');
  const muts = [
    ['①attempt 不建行 ⇒ 行数少于 Requests', "if ($Kind -eq 'attempt') { $null = Add-ApiLedgerRow -Attempt $Attempt -Sw $Sw }", 'if ($false) { }',
      async f => { assert.equal(arm(f, 'ok').count, 0); assert.equal(arm(f, 'ok').identity, false); }],
    ['②402 归成普通 4xx ⇒ 配额耗尽不可见', "if ($s -eq 402) { return [PSCustomObject]@{ Outcome = 'failure'; ReasonCode = 'quota-exhausted'; QuotaClass = 'quota' } }",
      "if ($s -eq 402) { return [PSCustomObject]@{ Outcome = 'failure'; ReasonCode = 'http-4xx'; QuotaClass = 'none' } }",
      async f => {
        assert.equal(arm(f, 'http402').rows[0].reasonCode, 'http-4xx');
        assert.equal(f.verdicts.find(v => v.status === 402).quotaClass, 'none');
      }],
    ['③结行不写 outcome ⇒ 行永远 open', '        $Row.outcome = $v.Outcome', '        # mutated: outcome 不写',
      async f => { assert.equal(arm(f, 'ok').rows[0].outcome, 'open'); }],
    ['④不落盘 ⇒ written 恒 0', '    if ($path -and -not $NoWrite) {', '    if ($false) {',
      async f => { assert.deepEqual(f.file.written, [0, 0]); assert.equal(f.file.lines, 0); }],
    ['⑤seq 不递增 ⇒ (runId,seq) 不唯一', "        if ($ctr) { $seq = [int]$ctr.AddOrUpdate('n', 1, { param($k, $v) $v + 1 }) }",
      '        if ($ctr) { $seq = 1 }',
      async f => {
        assert.equal(f.file.uniqPairs, 2, '每轮 2 行都写成 seq=1 ⇒ 唯一键从 4 掉到 2');
        assert.notEqual(f.file.uniqPairs, f.file.parsed);
      }],
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
