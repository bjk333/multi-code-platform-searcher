// U-263（B2-1 2/4，2026-10-26）：GitHub 迁 EngineContract v1 —— 封套契约 + 逐引擎请求账 + 不自报 status。
//
// 为什么独立于 U-178：U-178 只问「403 是限流还是权限」；本门问**封套本身**——
//   字段集恰好 9 个、contract=engine/1、`requests` 三格与真实发包次数对得上、`quota.class` 是已知事实、
//   且**引擎不再自报 status**（自报与派生只能有一个真源，否则又是"同一事实两处说不同话"）。
//
// 四层：
//   A 六臂真相：ok / zero / auth401 / forbid403 / stale / anon
//   B 封套形状：9 个字段、contract/engine/kind 逐字
//   C 请求账：每臂精确数字（不是只验恒等式 —— 恒等式在"两边一起错"时仍然成立）
//   D 可执行变异 5 条
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPwsh } from './r2-ps-run.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HARNESS = path.join(ROOT, 'tests', 'u263-github-contract-harness.ps1');
const MAIN = path.join(ROOT, 'multi-platform-searcher.ps1');
const GH = fs.readFileSync(path.join(ROOT, 'engines', 'github.ps1'), 'utf8');
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

test('U-263-A: 六臂 —— 0 命中是成功、401 是缺凭据、403 是权限、陈旧缓存是有产出', async () => {
  const f = await base();
  assert.deepEqual(f.fails, [], f.fails.join('; '));
  const ok = arm(f, 'ok');
  assert.equal(ok.n, 1);
  assert.equal(ok.hasFailure, false);
  assert.equal(ok.vStatus, 'ok');
  assert.equal(ok.legacy, 'ok');
  // 0 命中：**无 failure** ⇒ empty/zero-hit（"搜了没结果"是成功，这是 U-155/U-157 反复踩的那条线）
  const z = arm(f, 'zero');
  assert.equal(z.n, 0);
  assert.equal(z.hasFailure, false, '0 命中不许挂 failure —— 那会把"搜了没结果"说成"失败"');
  assert.equal(z.vStatus, 'empty');
  assert.equal(z.vCode, 'zero-hit');
  assert.equal(z.legacy, 'empty');
  // 401：缺凭据 ⇒ blocked（用户该去配 key，不是查网络）
  const a = arm(f, 'auth401');
  assert.equal(a.failureCode, 'missing-credential');
  assert.equal(a.vStatus, 'blocked');
  assert.equal(a.legacy, 'auth_missing');
  // 403 无标记：权限 ⇒ error（U-178 的负例方向不变）
  const b = arm(f, 'forbid403');
  assert.equal(b.failureCode, 'forbidden');
  assert.equal(b.vStatus, 'error');
  assert.equal(b.legacy, 'error');
  // 陈旧缓存：有产出 ⇒ ok；陈旧事实由行上的 Stale 与 warnings[] 承载（不是靠改判定）
  const s = arm(f, 'stale');
  assert.equal(s.n, 2);
  assert.equal(s.hasFailure, false);
  assert.equal(s.vStatus, 'ok');
  // 配额类别是已知事实
  assert.equal(arm(f, 'anon').quotaClass, 'anonymous');
  assert.equal(ok.quotaClass, 'authenticated');
  // 不自报：六臂跑完状态表里都不该出现 GitHub
  for (const x of f.arms) assert.equal(x.selfReport, 'unknown', `${x.id}: 引擎自报了 status`);
});

test('U-263-B: 封套形状 —— 恰好 9 个字段，contract/engine/kind 逐字', async () => {
  const f = await base();
  for (const x of f.arms) {
    assert.deepEqual([...x.fields].sort(), FIELDS, `${x.id}: 封套字段集不符`);
    assert.equal(x.contract, 'engine/1', `${x.id}: contract 必须 engine/1`);
    assert.equal(x.engine, 'GitHub');
    assert.equal(x.kind, 'repo');
    assert.equal(x.elapsedOk, true, `${x.id}: elapsedMs 必须是非负整数（不许 null/编 0）`);
  }
});

test('U-263-C: 请求账 —— 每臂精确数字（恒等式在"两边一起错"时照样成立，抓不到少记）', async () => {
  const f = await base();
  const expect = {
    ok: [1, 1, 0], zero: [1, 1, 0], auth401: [1, 0, 1],
    forbid403: [1, 0, 1], stale: [1, 0, 1], anon: [1, 1, 0],
  };
  for (const [id, [at, su, fa]] of Object.entries(expect)) {
    const x = arm(f, id);
    assert.deepEqual([x.rAttempted, x.rSucceeded, x.rFailed], [at, su, fa], `${id}: 请求账不符`);
    assert.equal(x.rSucceeded + x.rFailed, x.rAttempted, `${id}: 恒等式不成立`);
  }
});

test('U-263-D: 可执行变异 —— 拆任一处，观测值必须按预测变', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u263m-'));
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
  // ★主脚本必须**显式拷贝**：本门的变异只改 engines/github.ps1，没有"写主脚本"这一步顺手创建它
  //   （U-261 那边是靠变异时 `write(main)` 意外建出来的 —— 这种"靠副作用碰巧成立"的夹具不能复制）。
  fs.copyFileSync(MAIN, path.join(dir, 'multi-platform-searcher.ps1'));
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  fs.copyFileSync(HARNESS, path.join(dir, 'tests', 'u263-github-contract-harness.ps1'));
  const ghPath = path.join(dir, 'engines', 'github.ps1');
  const muts = [
    ['①成功出口返回数组而不是封套', { from: "return New-EngineEnvelope -Engine 'GitHub' -Kind 'repo' -Results $results -Requests $req -Quota $quota -StartedAt $t0", to: 'return $results' },
      async f => {
        const x = arm(f, 'ok');
        assert.equal(x.contract, '', '没有封套 ⇒ contract 应为空');
        assert.ok(x.fields.includes('Name'), '捕获到的是**裸结果对象**（字段名是 Name），不是封套');
      }],
    ['②失败不记 failed ⇒ 请求账变小', { from: '$lastErr = $_; $req.failed++', to: '$lastErr = $_' },
      async f => { assert.deepEqual([arm(f, 'auth401').rAttempted, arm(f, 'auth401').rSucceeded, arm(f, 'auth401').rFailed], [1, 0, 0]); }],
    ['③401 归成 error ⇒ 缺凭据不再 blocked', { from: "auth      = @{ code = 'missing-credential';", to: "auth      = @{ code = 'error';" },
      async f => { assert.equal(arm(f, 'auth401').failureCode, 'error'); assert.equal(arm(f, 'auth401').legacy, 'error', '用户会被引去查网络而不是配 key'); }],
    ['④配额类别写死 anonymous', { from: "$(if ($env:GITHUB_TOKEN) { 'authenticated' } else { 'anonymous' })", to: "'anonymous'" },
      async f => { assert.equal(arm(f, 'ok').quotaClass, 'anonymous', '有令牌却报匿名'); }],
    ['⑤0 命中被挂上 failure', { from: '} elseif (-not $gotResponse) {', to: '} else {' },
      async f => { assert.equal(arm(f, 'zero').hasFailure, true, '0 命中被说成失败'); assert.equal(arm(f, 'zero').vStatus, 'error'); }],
  ];
  for (const [name, m, expect] of muts) {
    const mutated = GH.split(m.from).join(m.to);
    assert.notEqual(mutated, GH, `${name}: 变异未生效（锚点变了？）`);
    fs.writeFileSync(ghPath, mutated, 'utf8');
    const f = await facts(dir);
    try { await expect(f); }
    catch (e) { e.message = `${name}: ${e.message}`; throw e; }
    fs.writeFileSync(ghPath, GH, 'utf8');   // 逐条还原：否则上一条变异会污染下一条的读数
  }
  fs.writeFileSync(ghPath, GH, 'utf8');
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { }
});
