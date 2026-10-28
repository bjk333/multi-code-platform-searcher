// U-260（B2-5，2026-10-26）：`execution` 块（RunEnvelope v2 §3.3）。
//
// 为什么要有它：现在能把"结果"说清楚，但说不清"**这些结果是怎么被生产出来的**"——
//   预算花在哪、哪些源压根没跑、哪个池早停了。缺这三样，Agent 只能从 `warnings[]` 的散文里猜。
//
// 三条设计约束（都写进断言）：
//   ① `budgetMs=0` 表示**未设预算**，不许编一个默认值（编了就没法和真实墙钟对账）；
//   ② `skipped[]` 与 `coverage.ReasonCodes` **同一份事实**（复用索引器，不另起判定），不一致即红；
//   ③ `sufficient` 只放**逐池**，不放顶层（放顶层会掩盖"repo 够了、code 不够"）。
//
// 附带抓到的一件事：单平台直连走的是 `& ("Search-$pf")` 动态调用，绕过并发池 —— 既没有 pools 记录，
//   也不认 B2-1 的封套。U-260 把它改走 `Invoke-EngineSerial`（同一归一点）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPwsh } from './r2-ps-run.mjs';
import { sourceAll } from './lib/source.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HARNESS = path.join(ROOT, 'tests', 'u260-execution-harness.ps1');
const MAIN = path.join(ROOT, 'multi-platform-searcher.ps1');
const SRC = sourceAll(ROOT);
const SCHEMA = JSON.parse(fs.readFileSync(path.join(ROOT, 'schema', 'asjson.schema.json'), 'utf8'));

let cache = null;
async function facts(dir) {
  const args = dir ? ['-File', HARNESS, '-SkillDir', dir] : ['-File', HARNESS];
  const r = await runPwsh(args, { timeoutMs: 240000 });
  const line = (r.stdout || '').split(/\r?\n/).filter(l => l.trim().startsWith('{"ok"')).pop();
  assert.ok(line, `harness 未输出 JSON 事实行（rc=${r.status}）；tail=${(r.stdout || '').slice(-400)}`);
  return JSON.parse(line);
}

test('U-260-A: 七个臂 —— 未设预算=0 / 池早停 / deadline / 预算跳过 / 未执行码 / 排序 / 负数夹 0', async () => {
  if (!cache) cache = await facts();
  const by = Object.fromEntries(cache.arms.map(a => [a.id, a]));
  assert.deepEqual(cache.fails, [], cache.fails.join('; '));
  // A：没跑任何东西时不许编预算
  assert.deepEqual([by.A.budgetMs, by.A.spentMs, by.A.reserveMs, by.A.truncated], [0, 0, 1500, false]);
  assert.deepEqual(by.A.pools, []);
  // B：池早停 ⇒ truncated，且 pools 原样透传（字段不丢）
  assert.equal(by.B.budgetMs, 40000);
  assert.equal(by.B.spentMs, 12345);
  assert.equal(by.B.truncated, true);
  assert.equal(by.B.poolCount, 1);
  assert.deepEqual(by.B.pool0, { mode: 'repo', budgetMs: 8000, spentMs: 7900, earlyStop: true, sufficient: false });
  // C：没有池早停，但引擎自己报 deadline ⇒ 仍算截断；且它**跑了**，不许进 skipped
  assert.equal(by.C.truncated, true);
  assert.deepEqual(by.C.skipped, []);
  // D：预算整段跳过 —— 历史码是 error、文案写着"未执行"，skipped 必须点名并改判 budget-truncated
  assert.equal(by.D.truncated, true);
  assert.deepEqual(by.D.skipped, ['Gitee=budget-truncated', 'GitHub=budget-truncated']);
  // E：五类未执行码原样保留（不许被"统一成一个码"抹平）
  assert.deepEqual(by.E.skipped, ['Gh=missing-credential', 'HF=health-skip', 'Old=user-disabled', 'SG=tool-missing', 'X=not-run']);
  // F：排序稳定（同一轮两次跑出不同顺序会让 diff 噪音压过变化）
  assert.deepEqual(by.F.order, ['Alpha', 'Mike', 'Zebra']);
  // G：负数夹到 0（schema 是 minimum:0，不能靠"调用方不会传负的"）
  assert.deepEqual([by.G.budgetMs, by.G.spentMs, by.G.reserveMs], [0, 0, 0]);
});

test('U-260-B: schema 已闭合并要求全字段；MCP 仍 $ref 同一份（所以 structuredContent 自动同步）', () => {
  const ex = SCHEMA.properties.execution;
  assert.ok(ex, 'asjson.schema.json 缺 properties.execution');
  assert.equal(ex.additionalProperties, false, 'execution 必须是闭合对象（否则"多塞一个字段"永远测不出来）');
  assert.deepEqual([...ex.required].sort(), ['budgetMs', 'ledger', 'pools', 'reserveMs', 'skipped', 'spentMs', 'truncated']);
  // B2-6（U-261）：账本汇总也必须是闭合对象 —— 否则"多塞一个字段"在它身上永远测不出来
  const lg = ex.properties.ledger;
  assert.deepEqual([...lg.type].sort(), ['null', 'object'], 'ledger 可空（null = 调用点未提供）');
  assert.equal(lg.additionalProperties, false);
  assert.deepEqual([...lg.required].sort(), ['error', 'path', 'rows', 'runId', 'written']);
  assert.ok(SCHEMA.oneOf[0].required.includes('execution'), 'oneOf[0].required 必须列 execution（R95-A 的 full-required 纪律）');
  for (const k of ['budgetMs', 'spentMs', 'reserveMs']) assert.equal(ex.properties[k].minimum, 0, `${k} 必须有 minimum:0`);
  const pool = ex.properties.pools.items;
  assert.equal(pool.additionalProperties, false);
  assert.deepEqual([...pool.required].sort(), ['budgetMs', 'earlyStop', 'mode', 'spentMs', 'sufficient']);
  const skip = ex.properties.skipped.items;
  assert.equal(skip.additionalProperties, false);
  assert.deepEqual([...skip.required].sort(), ['engine', 'reasonCode']);
  // MCP 侧：outputSchema 仍是 $ref asjson ⇒ 不需要第二份手写事实
  const tool = JSON.parse(fs.readFileSync(path.join(ROOT, 'schema', 'mcp-tool.json'), 'utf8'));
  const tools = Array.isArray(tool) ? tool : [tool];
  for (const t of tools) if (t.outputSchema) assert.deepEqual(t.outputSchema, { $ref: 'asjson.schema.json' }, `${t.name}: outputSchema 漂移`);
});

test('U-260-C: 可执行变异 —— 拆任一处，观测值必须按预测变', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u260m-'));
  const copyDir = (src, dst) => {
    fs.mkdirSync(dst, { recursive: true });
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, e.name), d = path.join(dst, e.name);
      if (e.isDirectory()) copyDir(s, d);
      else if (e.name.endsWith('.ps1')) fs.copyFileSync(s, d);
    }
  };
  copyDir(path.join(ROOT, 'engines'), path.join(dir, 'engines'));
  const mainPath = path.join(dir, 'multi-platform-searcher.ps1');
  const muts = [
    ['①不认"未执行"文案 ⇒ 4 个没跑的源从 skipped 里消失',
      "$notRun = ($why -match '未执行（不是 0 命中）')", '$notRun = $false',
      async f => { assert.equal(f.arms.find(a => a.id === 'D').skipped.length, 0); }],
    ['②预算跳过不触发截断 ⇒ execution.truncated 说"没截断"',
      "    if (-not $truncated -and @($skipped | Where-Object { $_.reasonCode -eq 'budget-truncated' }).Count -gt 0) { $truncated = $true }", '',
      async f => { assert.equal(f.arms.find(a => a.id === 'D').truncated, false); }],
    ['③负数不夹 ⇒ budgetMs 可能为负（schema minimum:0 会红但载荷已发出）',
      'budgetMs  = [int]([Math]::Max(0, $TotalBudgetSec) * 1000)', 'budgetMs  = [int]($TotalBudgetSec * 1000)',
      async f => { assert.equal(f.arms.find(a => a.id === 'G').budgetMs, -3000); assert.ok(f.fails.some(x => x.startsWith('G.'))); }],
    ['④排序反了 ⇒ 输出顺序不再稳定可复现',
      // ★对着"去掉 Sort-Object"写过一版，结果不可断言：函数内部把入参拷进普通 @{}，
      //   哈希序逐进程随机化 ⇒ 去掉排序后的顺序无法预测（全量并发下这条变异会偶发通过）。
      //   改成"排成倒序"：确定性的错，才证明排序这一行是承重的。
      '$codes.Keys | Sort-Object', '$codes.Keys | Sort-Object -Descending',
      async f => { assert.deepEqual(f.arms.find(a => a.id === 'F').order, ['Zebra', 'Mike', 'Alpha']); }],
  ];
  for (const [name, from, to, expect] of muts) {
    const m = SRC.split(from).join(to);
    assert.notEqual(m, SRC, `${name}: 变异未生效（锚点变了？）`);
    fs.writeFileSync(mainPath, m, 'utf8');
    const f = await facts(dir);
    try { await expect(f); }
    catch (e) { e.message = `${name}: ${e.message}`; throw e; }
  }
  fs.writeFileSync(mainPath, SRC, 'utf8');
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { }
});
