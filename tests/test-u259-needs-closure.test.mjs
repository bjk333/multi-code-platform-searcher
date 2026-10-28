// U-259（B2-4，2026-10-26）：Needs 由 **AST 传递闭包** 校验 —— 漏登记即红。
//
// 为什么需要它：`Needs` 是本仓最容易漏的一处事实，历史上漏过两次，两次都是**静默**的：
//   · U-02 漏 `Test-RateLimit403`（只补了一处）；
//   · U-40 漏 `Invoke-WebRequestDirect` ⇒ GitLab blobs 的并行路径**静默 0 命中**（N-18）。
//   共同点：漏了不会报错，Runspace 里调用未定义命令会被 catch 吞成"没结果"，看起来像零命中。
//
// 判据方向只有一个：**漏登记**。引擎（含传递闭包）引用到的本仓函数，必须 ∈ 手写 `Needs` ∪ `Get-HttpLayerClosure`。
// 反方向（手写但不可达 = 多余注入）只做**棘轮**：总数不得高于当前值（现在 8），只许降不许升。
//
// ★一条被实测否掉的实现（写在这里防止后人重蹈）：起初用 `Test-Path "function:X"` 判"是不是本仓函数"，
//   结果本机宿主的 safe-delete 垫片把 `Remove-Item` 变成了函数 ⇒ 每个引擎凭空多出 8 个 `*-SafeDelete*` 依赖。
//   现在改成「从 AST 收集 FunctionDefinitionAst」，与宿主装了什么模块无关。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPwsh } from './r2-ps-run.mjs';
import { sourceAll } from './lib/source.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HARNESS = path.join(ROOT, 'tests', 'u259-needs-closure-harness.ps1');
const MAIN = path.join(ROOT, 'multi-platform-searcher.ps1');
const SRC = sourceAll(ROOT);
// ★B2-1/U-265（v1.53.34）：8 → 6。GitLabBlobs 迁封套后 `Get-EngineStatus` 与 `Add-EngineWarning`
//   都成了真依赖（不再调 Set-EngineStatus，改写 failure.reasonCode）⇒ 那两项从"多余注入"里消失。
const REDUNDANT_CAP = 6;   // 棘轮：当前实测 6 项多余注入；只能降

let cache = null;
async function facts(dir) {
  const args = dir ? ['-File', HARNESS, '-SkillDir', dir] : ['-File', HARNESS];
  const r = await runPwsh(args, { timeoutMs: 240000 });
  const line = (r.stdout || '').split(/\r?\n/).filter(l => l.trim().startsWith('{"ok"')).pop();
  assert.ok(line, `harness 未输出 JSON 事实行（rc=${r.status}）；tail=${(r.stdout || '').slice(-400)}`);
  return JSON.parse(line);
}

test('U-259-A: 23 个引擎的传递引用全部已登记（手写 Needs ∪ HTTP 闭包）', async () => {
  if (!cache) cache = await facts();
  const f = cache;
  // 先证"门没瞎"：解析不到函数 = 静默全绿，这是本门最危险的失败模式
  assert.deepEqual(f.parseErrors, [], '有文件解析失败 ⇒ 闭包会算空，门会假绿');
  assert.ok(f.funcCount > 200, `本仓函数表太小（${f.funcCount}）⇒ 解析没读到东西`);
  assert.equal(f.httpCount, 50, `HTTP 闭包应为 50 项（实得 ${f.httpCount}）—— 变了就要同步改本断言与文档`);   // U-267：47 → 50（回放三件）
  assert.equal(f.engineCount, 23, `注册表引擎应为 23（实得 ${f.engineCount}）`);
  assert.deepEqual(f.fails, [], '漏登记：\n  ' + f.fails.join('\n  '));
  for (const e of f.engines) assert.deepEqual(e.missing, [], `${e.name}: 漏登记 ${e.missing.join(',')}`);
});

test('U-259-B: 多余注入棘轮 —— 只能降不许升（当前 6 项）', async () => {
  if (!cache) cache = await facts();
  const total = cache.engines.reduce((n, e) => n + e.redundant.length, 0);
  assert.ok(total <= REDUNDANT_CAP, `多余注入 ${total} 项 > 上限 ${REDUNDANT_CAP}：新登记前先确认它真的被引用（否则每个 runspace 都多注入一份）`);
  // 冻结现状明细，避免"总数没变但换了地方"
  const byEngine = Object.fromEntries(cache.engines.filter(e => e.redundant.length).map(e => [e.name, e.redundant]));
  assert.deepEqual(byEngine, {
    GitHubCode: ['Get-EngineStatus'],
    GrepApp: ['Get-EngineStatus'],
    Sourcegraph: ['Get-EngineStatus'],
    Npm: ['Set-EngineStatus'],
    Crates: ['Set-EngineStatus'],
    Maven: ['Set-EngineStatus'],
  }, '多余注入明细变了：少了就更新本快照（收紧），多了要先解释为什么');
});

test('U-259-C: 可执行变异 —— 删掉任一 Needs 项，门必须指名道姓', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u259m-'));
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
    ['①Gitee 漏 Invoke-GiteeV5Fallback（U-02 同型：回退路径）', ",'Invoke-GiteeV5Fallback'", '', 'Gitee', 'Invoke-GiteeV5Fallback'],
    ['②HF 漏 New-EngineEnvelope（新契约构造器）', ",'New-EngineEnvelope'", '', 'HF', 'New-EngineEnvelope'],
  ];
  for (const [name, from, to, engine, want] of muts) {
    const m = SRC.split(from).join(to);
    assert.notEqual(m, SRC, `${name}: 变异未生效（锚点变了？）`);
    fs.writeFileSync(mainPath, m, 'utf8');
    const f = await facts(dir);
    const row = f.engines.find(e => e.name === engine);
    assert.ok(row, `${name}: 找不到引擎 ${engine}`);
    assert.ok(row.missing.includes(want), `${name}: 应报 ${engine} 漏 ${want}，实得 [${row.missing.join(',')}]`);
    assert.equal(f.ok, false, `${name}: 漏登记却仍是 ok`);
  }
  fs.writeFileSync(mainPath, SRC, 'utf8');
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { }
});
