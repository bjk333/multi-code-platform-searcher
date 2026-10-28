// U-265（B2-1 4/4，2026-10-26）：GitLabBlobs 迁 EngineContract v1 —— 自设预算的口径 + 账本派生的请求账。
//
// 这个引擎和前三个不同，两件事必须单独钉：
//   ① **自设预算耗尽必须判 empty 而不是 error**。它默认只发 4 次请求/查询，有 token 时预算通常在项目搜索后
//      就用光 ⇒ 这条路径是**常态**而非边角。判 error ⇒ legacy Degraded ⇒ 从 coverage 的 executed 组掉出
//      ⇒ Verdict 可能落 none（"请求了引擎但全未执行"）—— U-158E A-2 对照臂实测抓到的正是这个。
//   ② `requests` **不是引擎自己数的**，而是从 B2-6 的账本按 engine 聚合来的（它的请求散在 4 个辅助函数
//      + 一个嵌套 runspace 池里，逐点手写必然有漏 —— DeepSeek 那轮就漏过 `$req.failed++`）。
//      所以本门额外断言「封套 attempted == 账本行数」：同一份事实，两处看必须一致。
//
// 四层：
//   A 十臂真相（ok/zero/forbidden/budget/budgetPartial/nokey/repoOk/repoZero/auth401/rate429）
//   B 形状 + 请求账精确数字
//   C 源码不变量：引擎与 RepoScoped 都**不再**写状态（判定只有一个真源）
//   D 可执行变异 5 条
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPwsh } from './r2-ps-run.mjs';
import { sourceAll, findOwner } from './lib/source.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HARNESS = path.join(ROOT, 'tests', 'u265-gitlab-blobs-contract-harness.ps1');
const MAIN_PATH = path.join(ROOT, 'multi-platform-searcher.ps1');
const MAIN = sourceAll(ROOT);   // v1.54.0（B3-2）：读加载后视图
const GL = fs.readFileSync(path.join(ROOT, 'engines', 'gitlab-blobs.ps1'), 'utf8');
const FIELDS = ['contract', 'elapsedMs', 'engine', 'failure', 'kind', 'partial', 'quota', 'requests', 'results'];

let cache = null;
async function facts(skillDir) {
  // ★变异臂必须用**副本里的** harness 路径。实测：`-File <源仓>/tests/... -SkillDir <副本>` 时，
  //   写在副本里的变异**不生效**（观测值仍是原始行为，而磁盘上的确已改）；同一份代码用独立脚本
  //   指向副本路径跑就一定生效。根因未定位（不是 BOM、不是编码、不是路径空格），但差异只有这一处，
  //   所以按"能稳定复现的写法"固定下来。**这条不许回退成源仓路径** —— 那会让 D 层静默失去判别力。
  const script = skillDir ? path.join(skillDir, 'tests', 'u265-gitlab-blobs-contract-harness.ps1') : HARNESS;
  const args = skillDir ? ['-File', script, '-SkillDir', skillDir] : ['-File', HARNESS];
  const r = await runPwsh(args, { timeoutMs: 180000 });
  const line = (r.stdout || '').split(/\r?\n/).filter(l => l.trim().startsWith('{"ok"')).pop();
  assert.ok(line, `harness 未输出 JSON 事实行（rc=${r.status}）；tail=${(r.stdout || '').slice(-400)}`);
  return JSON.parse(line);
}
async function base() { if (!cache) cache = await facts(); return cache; }
const arm = (f, id) => f.arms.find(a => a.id === id);

test('U-265-A: 十臂 —— 预算是"我方主动放弃"（empty），403/401/429 各自落对格', async () => {
  const f = await base();
  assert.deepEqual(f.fails, [], f.fails.join('; '));
  // ok：全局 2 条 + 项目路径 1 次 GET
  const ok = arm(f, 'ok');
  assert.equal(ok.n, 2);
  assert.equal(ok.hasFailure, false);
  assert.equal(ok.vStatus, 'ok');
  // zero：全局 [] + 项目搜索 [] ⇒ 无 failure ⇒ empty/zero-hit
  const z = arm(f, 'zero');
  assert.equal(z.n, 0);
  assert.equal(z.hasFailure, false, '真零命中不许挂 failure');
  assert.equal(z.vCode, 'zero-hit');
  // forbidden：全局 403（能力关闭）⇒ forbidden；不许说成限流或预算
  const fb = arm(f, 'forbidden');
  assert.equal(fb.failureCode, 'forbidden');
  assert.equal(fb.vStatus, 'error');
  assert.equal(fb.legacy, 'error');
  // ★budget：预算耗尽 + 0 条 ⇒ empty/budget-truncated（**不是 error**）
  const bg = arm(f, 'budget');
  assert.equal(bg.failureCode, 'budget-truncated');
  assert.equal(bg.vStatus, 'empty', '★预算耗尽是我方主动放弃 ⇒ empty；判 error 会让引擎从 executed 组掉出，Verdict 可能落 none');
  assert.equal(bg.legacy, 'empty');
  // ★budgetPartial：有产出 + 预算截断 ⇒ degraded（legacy ok：有产出就是有产出）
  const bp = arm(f, 'budgetPartial');
  assert.equal(bp.n, 2);
  assert.equal(bp.failureCode, 'budget-truncated');
  assert.equal(bp.vStatus, 'degraded');
  assert.equal(bp.legacy, 'ok');
  // nokey：缺 token ⇒ blocked/auth_missing，**零请求**
  const nk = arm(f, 'nokey');
  assert.equal(nk.failureCode, 'missing-credential');
  assert.equal(nk.legacy, 'auth_missing');
  assert.deepEqual([nk.rAttempted, nk.rSucceeded, nk.rFailed], [0, 0, 0]);
  assert.equal(nk.quotaClass, 'none');
  // RepoScope 两支
  assert.equal(arm(f, 'repoOk').n, 2);
  assert.equal(arm(f, 'repoOk').hasFailure, false);
  assert.equal(arm(f, 'repoZero').vCode, 'zero-hit');
  // ★auth401：PS7 下旧判据（只认 WebException）恒 false ⇒ 401 被回退成 error。消息判据补上后才对。
  const a4 = arm(f, 'auth401');
  assert.equal(a4.failureCode, 'missing-credential');
  assert.equal(a4.legacy, 'auth_missing', '★401 报成 error 会让用户去查网络，而该做的是换 token');
  // rate429 ⇒ legacy rate_limited（健康记忆靠这个串判"短 TTL 冷却"）
  const rl = arm(f, 'rate429');
  assert.equal(rl.failureCode, 'rate-limited');
  assert.equal(rl.legacy, 'rate_limited');
  // 不自报：十臂跑完状态表里都不该出现 GitLabBlobs
  for (const x of f.arms) assert.equal(x.selfReport, 'unknown', `${x.id}: 引擎自报了 status`);
});

test('U-265-B: 形状 + 请求账 —— 9 字段、每臂精确数字，且封套 attempted == 账本行数', async () => {
  const f = await base();
  for (const x of f.arms) {
    assert.deepEqual([...x.fields].sort(), FIELDS, `${x.id}: 封套字段集不符`);
    assert.equal(x.contract, 'engine/1', `${x.id}: contract 必须 engine/1`);
    assert.equal(x.engine, 'GitLabBlobs');
    assert.equal(x.kind, 'code');
    assert.equal(x.elapsedOk, true, `${x.id}: elapsedMs 必须是非负整数`);
    // ★账本交叉核对：requests 是**派生**的，必须与账本行数逐臂相等
    assert.equal(x.rAttempted, x.ledgerRows, `${x.id}: 封套 attempted(${x.rAttempted}) != 账本行数(${x.ledgerRows})`);
  }
  const expect = {
    ok: [2, 2, 0], zero: [2, 2, 0], forbidden: [2, 0, 2], budget: [1, 1, 0],
    budgetPartial: [1, 1, 0], nokey: [0, 0, 0], repoOk: [1, 1, 0], repoZero: [1, 1, 0],
    auth401: [2, 0, 2], rate429: [2, 0, 2],
  };
  for (const [id, [at, su, fa]] of Object.entries(expect)) {
    const x = arm(f, id);
    assert.deepEqual([x.rAttempted, x.rSucceeded, x.rFailed], [at, su, fa], `${id}: 请求账不符`);
    assert.equal(x.rSucceeded + x.rFailed, x.rAttempted, `${id}: 恒等式不成立`);
  }
  // ★forbidden 臂的两次请求 vs 预算计数 1：403 那次被 `$St.Calls--` 从**预算**里扣掉（不耗配额），
  //   但它**确实发了**（账本有行）。两个数不同是设计，不是 bug —— 这条断言把它钉住，防止有人"顺手对齐"。
  assert.equal(arm(f, 'forbidden').rAttempted, 2);
});

// 剥掉行首注释再断言：本仓注释里会**解释**"原来自报 ok/empty"，那是给人看的历史，不是代码。
//   U-41 踩过相反方向的坑（注释里的函数名被当成调用）—— 这里主动剥掉，免得同一类措辞把门绊成假红。
const stripComments = t => String(t).split(/\r?\n/).filter(l => !/^\s*#/.test(l)).join('\n');

test('U-265-C: 源码不变量 —— 引擎与 RepoScoped 都不许再写状态（判定只有一个真源）', () => {
  assert.doesNotMatch(stripComments(GL), /Set-EngineStatus/, 'Search-GitLabBlobs 不得自报状态：判定归 L1 的 Resolve-EngineVerdict');
  const start = MAIN.indexOf('function Invoke-GitLabRepoScopedBlobs {');
  assert.ok(start > 0, 'Invoke-GitLabRepoScopedBlobs 必须存在');
  // ★边界不能写 `\nfunction `：主脚本里下一个函数前带一个缩进空格（` function Invoke-GitLabProjectBlobSearch {`），
  //   那样切出来的是"从这里到文件末尾"，断言会撞上别的函数里的 Set-EngineStatus（第一版就这么假红的）。
  const next = MAIN.indexOf('function Invoke-GitLabProjectBlobSearch', start + 10);
  const rsFn = MAIN.slice(start, next > 0 ? next : undefined);
  assert.ok(rsFn.length > 200, 'RepoScoped 函数体截取异常（锚点变了？）');
  assert.doesNotMatch(stripComments(rsFn), /Set-EngineStatus/, 'RepoScoped 也不得写状态：它原来自报 ok/empty，与 L1 派生是两份事实');
  // 派生它的账本函数必须真的按 engine 过滤（否则 requests 会变成全局行数）。
  //   ★用函数体切片而不是「函数头 + N 个字符」：那个函数的头注就有 700+ 字符，
  //   写死窗口长度会在"注释加两行"时假红（第一版写了 600）。
  const ls = MAIN.indexOf('function Get-ApiRequestLedgerByEngine {');
  const le = MAIN.indexOf('function Reset-ApiLedger', ls);
  assert.ok(ls > 0 && le > ls, '账本聚合函数的边界取不到（锚点变了？）');
  assert.match(MAIN.slice(ls, le), /\[string\]\$_\.engine -eq \$Engine/,
    'Get-ApiRequestLedgerByEngine 必须按 engine 过滤');
});

test('U-265-D: 可执行变异 —— 拆任一处，观测值必须按预测变', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u265m-'));
  const copyDir = (src, dst) => {
    fs.mkdirSync(dst, { recursive: true });
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, e.name), d = path.join(dst, e.name);
      if (e.isDirectory()) copyDir(s, d);
      else if (e.name.endsWith('.ps1')) fs.copyFileSync(s, d);
    }
  };
  copyDir(path.join(ROOT, 'engines'), path.join(dir, 'engines'));
  // v1.54.0（B3-2）：函数在 lib/ ⇒ 夹具目录必须带上，否则点源出来的产品只剩入口。
  copyDir(path.join(ROOT, 'lib'), path.join(dir, 'lib'));
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  fs.copyFileSync(HARNESS, path.join(dir, 'tests', 'u265-gitlab-blobs-contract-harness.ps1'));
  const mainPath = path.join(dir, 'multi-platform-searcher.ps1');
  const glPath = path.join(dir, 'engines', 'gitlab-blobs.ps1');
  fs.copyFileSync(MAIN_PATH, mainPath);

  const muts = [
    ['①预算耗尽归成 error ⇒ 从 executed 组掉出', 'gl', { from: "$code = 'budget-truncated'", to: "$code = 'error'" },
      async f => {
        const x = arm(f, 'budget');
        assert.equal(x.failureCode, 'error');
        assert.equal(x.vStatus, 'error', '★"我方主动放弃"被报成"源失败" ⇒ coverage 的 executed 组少一个');
        assert.notEqual(x.legacy, 'empty');
      }],
    ['②去掉 401 的消息判据 ⇒ PS7 下恒 false', 'gl', { from: " -or ($m -match '\\b401\\b|Unauthorized|未经授权')", to: '' },
      async f => {
        const x = arm(f, 'auth401');
        assert.notEqual(x.failureCode, 'missing-credential', '401 不再被识别');
        assert.notEqual(x.legacy, 'auth_missing', '失效 token 会被报成"执行了但失败" ⇒ 用户去查网络');
      }],
    ['③恢复成员枚举守卫 ⇒ 2 条以上命中被当成错误体', 'main', { from: '$isErrBody = ($data -isnot [System.Array]) -and ($data.PSObject.Properties.Name -contains \'message\')', to: '$isErrBody = [bool]($data -and $data.message)' },
      async f => {
        const x = arm(f, 'ok');
        assert.equal(x.n, 0, '★多元素数组的 .message 是 @($null,$null) ⇒ truthy ⇒ 2 条真实命中被整段丢弃');
      }],
    ['④无 token 报 not-run ⇒ "没打算用"变"没跑"', 'gl', { from: "reasonCode = 'missing-credential'; reason = '需要 GITLAB_TOKEN", to: "reasonCode = 'not-run'; reason = '需要 GITLAB_TOKEN" },
      async f => {
        assert.equal(arm(f, 'nokey').failureCode, 'not-run');
        assert.equal(arm(f, 'nokey').legacy, 'unknown', '缺凭据被记成"没跑"，用户看不到要配 token');
      }],
    ['⑤账本过滤失效 ⇒ requests 变假零', 'main', { from: '$rows = @(Get-ApiLedgerRows | Where-Object { [string]$_.engine -eq $Engine })', to: '$rows = @()' },
      async f => {
        const x = arm(f, 'ok');
        assert.deepEqual([x.rAttempted, x.rSucceeded, x.rFailed], [0, 0, 0], 'requests 恒 0 而结果照常返回 —— 这正是"假零"最难发现的地方');
        assert.notEqual(x.rAttempted, x.ledgerRows);
      }],
  ];
  try {
    for (const [name, which, m, expect] of muts) {
      // v1.54.0（B3-2）：函数已搬进 lib/ ⇒ 按**锚点实际所在的文件**变异，不再假设"一定在主脚本里"。
      const target = which === 'gl' ? glPath : (findOwner(dir, m.from) || mainPath);
      const src = fs.readFileSync(target, 'utf8');
      const mutated = src.split(m.from).join(m.to);
      assert.notEqual(mutated, src, `${name}: 变异未生效（锚点变了？）`);
      fs.writeFileSync(target, mutated, 'utf8');
      // 落盘确认：变异"未生效"在上一批骗过一次（replace 只换第一处）。这里核**磁盘上**真的变了。
      assert.ok(fs.readFileSync(target, 'utf8').includes(m.to), `${name}: 变异未落盘`);
      const f = await facts(dir);
      try { await expect(f); }
      catch (e) { e.message = `${name}: ${e.message}`; throw e; }
      fs.writeFileSync(target, src, 'utf8');   // 逐条还原（回到锚点所在文件）
    }
  } finally {
    fs.writeFileSync(glPath, GL, 'utf8');
    fs.writeFileSync(mainPath, MAIN, 'utf8');
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { }
  }
});
