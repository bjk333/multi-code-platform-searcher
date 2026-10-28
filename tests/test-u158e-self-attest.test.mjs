// U-158E · `pass^5` 自证清单（R97-E）
//
// 判据以 `reports/U-158E-预注册判据-2026-10-03.md` §2 为准，**未事后放宽**。
// 三条实测决定（都写进注释，免得后人重走）：
//   ① A 的前置条件：**极小预算不成立**（budget=1 ⇒ Verdict=degraded，2 个引擎 1s 内跑完）；
//      **死代理不成立**（HTTP_PROXY 指向关闭端口**被实现忽略**，读数与正常逐字节一致）。
//      成立的是第三条：**引擎被请求、但在"发请求之前"就因缺凭据被判 auth_missing**
//      ⇒ Requested>0 且 Executed==0 ⇒ Verdict=none（离线、~2s、确定）。
//   ② 外部模型建议的"无关查询不发起调用"**不成立**（实测 planner 把无关查询全分 research_only，
//      ValidateSet 只有 4 类+auto、无弃权类）⇒ A 用预注册判据的 (b) 口径。
//   ③ 判据里凡比对**中文查询串**都会被控制台编码咬（实测：两条中文查询取回后 `undefined`）
//      ⇒ B 改用**序号**作键，不比字符串。
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { envFailIfTiming, envFail, deadlineRouteEvidence, formatRouteEvidence } from './gate-partition.mjs';
import { sourceAll } from './lib/source.mjs';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(testsDir, '..');
const REG = JSON.parse(fs.readFileSync(path.join(root, 'reports/gates/source-audit-2026-10-02/engine-registry.json'), 'utf8').replace(/^\uFEFF/, ''));
// v1.39.0（A 线归并批）：引擎集取"快照 ∪ 当前 catalog"——快照（2026-10-02）随注册表演进会过期
//（SEExcerpts 曾不在快照 ⇒ 未被禁用 ⇒ 匿名执行 ⇒ A-1 假红："全未执行"场景里漏禁了新引擎）。
const CATALOG_ENGINES = Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'query-plan.schema.json'), 'utf8').replace(/^\uFEFF/, ''))['x-engineCatalog']);
const ALL_ENGINES = [...new Set([...REG.engines.map(e => e.Name), ...CATALOG_ENGINES])];

// ★必须在**临时副本**里跑技能：`$CacheFile = Join-Path $ScriptDir "search_cache.json"` 是写死在脚本同目录的，
//   无论 cwd 是什么都会落到真仓 ⇒ 会被 R96 的真树卫生门抓到（实测踩过：真仓 search_cache.json 被改）。
//   隔离方式沿用本仓既有做法（U-159 K1 同款）：逐文件 copyFileSync 递归复制（**不用 fs.cpSync**，它在非 ASCII 源路径上崩）。
let WORKROOT = null, MAIN = null, PLANNER = null;
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
before(() => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'u158e-'));
  WORKROOT = path.join(tmp, 'repo');
  copyTree(root, WORKROOT);
  MAIN = path.join(WORKROOT, 'multi-platform-searcher.ps1');
  PLANNER = path.join(WORKROOT, 'query-planner.ps1');
  assert.ok(fs.existsSync(MAIN) && fs.existsSync(PLANNER), '副本必须含主脚本与 planner');
});
after(() => { if (WORKROOT) { try { fs.rmSync(path.dirname(WORKROOT), { recursive: true, force: true }); } catch { /* 由系统清 */ } } });


// ---------- 工具 ----------
function runPwsh(args, extraEnv = {}, timeoutMs = 180000) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const env = { ...process.env, ...extraEnv };
    delete env.NODE_TEST_CONTEXT;                       // 本门由 node --test 跑；不删会让子进程跳过一切并 rc=0
    const c = spawn('pwsh', ['-NoProfile', '-File', MAIN, ...args], { cwd: WORKROOT, env, windowsHide: true });
    const out = [], err = [];
    c.stdout.on('data', d => out.push(d));
    c.stderr.on('data', d => err.push(d));
    const t = setTimeout(() => c.kill('SIGKILL'), timeoutMs);
    c.once('close', code => {
      clearTimeout(t);
      const buf = Buffer.concat(out);
      let txt = null; try { txt = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { /* 非 UTF-8 */ }
      let j = null, parseErr = null;
      if (txt === null) parseErr = 'not valid UTF-8';
      else { const i = txt.indexOf('{'); if (i < 0) parseErr = 'no JSON found'; else { try { j = JSON.parse(txt.slice(i)); } catch (e) { parseErr = e.message; } } }
      resolve({ code, ms: Date.now() - t0, j, parseErr, bytes: buf.length, stderr: Buffer.concat(err).toString('utf8').slice(0, 300) });
    });
    c.once('error', e => { clearTimeout(t); resolve({ launchError: e.message }); });
  });
}
// 凭据只从 .env 取（**不打印值**）；本门用 `-NoEnvFile`，故必须显式喂给子进程
function envValue(name) {
  try {
    const t = fs.readFileSync(path.join(root, '.env'), 'utf8');
    const m = new RegExp('^' + name + '=(.*)$', 'm').exec(t);
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
  } catch { return ''; }
}
const GITLAB_TOKEN = process.env.GITLAB_TOKEN || envValue('GITLAB_TOKEN');

// ---------- A 的两臂：同一切，只差凭据 ----------
const ONLY_GITLABBLOBS = ALL_ENGINES.filter(n => n !== 'GitLabBlobs').join(',');
const A_ARGS = ['-NoEnvFile', '-Keyword', 'agent', '-Limit', '3', '-NoCache', '-AsJson', '-CodeEvidence'];
// v1.45.2（2026-10-20 全量验收 P1-1）：两臂都关掉**单源硬上限** —— 本门测的是「abstain 语义」
//   （缺凭据 ⇒ Requested>0 且 Executed=0 ⇒ Verdict=none），不是性能。v1.42.0 的 `EngineHardCapSec=10`
//   与 GitLab 回退路径（项目搜索 + 逐项目 blobs，实测 ~19s）天然冲突 ⇒ A-2 对照臂恒 deadline ⇒ 单跑也红
//   （实测：全量与单跑均 10 pass / 2 fail，门自己写的"单跑可复验"不成立）。
//   把上限与语义解耦后，失败只可能来自真产品问题（令牌失效 ⇒ missing-credential）。
// v1.70.0（B3-17 实测）：还要**把逐源截止放开**。`MCPS_ENGINE_HARD_CAP_SEC=0` 只是解开单源硬上限，
//   而引擎级截止仍是默认 17s —— 本机的 gitlab.com 路由探活要吃掉 8–11s，剩下 6s 连
//   「全局 blobs(403) → 项目搜索 → 逐项目 blobs」都跑不完 ⇒ deadline ⇒ A-2 恒红（实测：单跑 3 次 1 绿 2 红）。
//   放开后同一台机器 11s 拿回 1 条结果、Verdict=full。这仍是**解耦**（本门测 abstain 语义，不测性能），
//   不是放宽断言：有凭据 ⇒ Verdict 非 none 这条一个字没改。
// v1.70.0（B3-17 实测，第二次修）：**还要关掉源健康记忆**。
//   `Get-HealthProbedDeadlineSec` 对"冷源"只给 `HealthProbeSec=6s` 半开探测 —— 而 6s 连探活都不够，
//   于是它必红、红了又把自己记成冷源 ⇒ **自锁**。实测：仓根 `source-health.json` 里 GitLab* 系列
//   都是 deadline，此后每条臂都只拿到 6s（reason 里那句"单引擎超 6s 截止"就是它，不是 17s）。
//   这与本门要测的"有凭据 ⇒ Verdict 非 none"无关 ⇒ 关掉（`MCPS_HEALTH=0`），并给独立的状态文件，
//   免得上一次跑的红写进下一次跑的前提（测试不该依赖运行时残留）。
const A_ENV = { MCPS_DISABLE: ONLY_GITLABBLOBS, GITLAB_TOKEN: '', GITHUB_TOKEN: '', MCPS_TIME_BUDGET_SEC: '60', MCPS_ENGINE_HARD_CAP_SEC: '0', MCPS_ENGINE_DEADLINE: 'GitLabBlobs=60', MCPS_HEALTH: '0' };

let noTokenRun = null, withTokenRun = null;

test('U-158E A-0（前置）: 缺凭据注入成立 —— 拿到可解析载荷', async () => {
  noTokenRun = await runPwsh(A_ARGS, A_ENV);
  assert.ok(!noTokenRun.launchError, 'pwsh 必须能起: ' + noTokenRun.launchError);
  assert.equal(noTokenRun.parseErr, null, '载荷必须能解析: ' + noTokenRun.parseErr);
});

test('U-158E A-1（abstain 主判据）: 引擎被请求但全未执行 ⇒ Verdict=none、Executed 空、results 空', () => {
  const c = noTokenRun.j.coverage;
  assert.ok((c.Requested || []).length > 0, '必须是"有请求"（否则测的是 no-engines，不是 abstain）');
  assert.equal((c.Executed || []).length, 0, 'Executed 必须为空');
  assert.equal(c.Verdict, 'none', `全不执行必须记 none，实得 ${c.Verdict}`);
  assert.notEqual(c.Verdict, 'full', '★不得冒充 full');
  assert.equal((noTokenRun.j.results || []).length, 0, '无执行 ⇒ 结果必须为空');
});

test('U-158E A-2（对照 · 证明 A-1 非恒真）: 同参数**有凭据**时 Verdict 必须不是 none', async (t) => {
  if (!GITLAB_TOKEN) { t.skip('无 GITLAB_TOKEN ⇒ 对照做不了；**按预注册判据，skip 不得计为通过**'); return; }
  withTokenRun = await runPwsh(A_ARGS, { ...A_ENV, GITLAB_TOKEN });
  assert.equal(withTokenRun.parseErr, null, '对照载荷必须能解析: ' + withTokenRun.parseErr);
  const c = withTokenRun.j.coverage;
  if (c.Verdict === 'none') {
    // ★加载敏感：全量门并发时 60s 预算可能不够 ⇒ 引擎超预算被 Stop（ReasonCode=deadline）⇒ Executed=0 ⇒ none。
    //   这与"令牌失效"是两件事，**必须分开**：令牌失效 ⇒ missing-credential（那是真产品问题）；
    //   超预算 ⇒ deadline（环境/时序）。照本仓既有词汇走 envFailIfTiming，**不得**把时序问题记成 product
    //   （这正是我在 U-114/N-1 上指出过的"门红要归因正确"，现在轮到自己的门）。
    const code = (c.ReasonCodes || {})['GitLabBlobs'];
    const reasons = JSON.stringify(c.Reasons || {});
    if (code === 'deadline' || /超预算|截止|超时|timed out|timeout/i.test(reasons)) {
      // ① v1.49.1：先看 **payload 自带**的环境证据（三条件合取：deadline ∧ route-unproven ∧ 本地成因）。
      //    这种证据比宿主声明 U153_TIMING 更硬 —— 它是产品自己写的"本机 hosts 劫持 / 代理白名单缺域"。
      const ev = deadlineRouteEvidence(c);
      if (ev.length) {
        envFail('no-network', `A-2 对照臂：引擎在逐域探活未完成时被截止（${formatRouteEvidence(ev)}）—— 本机路由问题，不是产品回归，也不是令牌失效`);
      }
      // ② 没有路由证据时退回宿主声明口径（U153_TIMING=1|confirmed）；两者都没有 ⇒ 按 product 抛（fail-closed）。
      //   ★v1.70.0（B3-17 实测）：**「直连但太慢」这一档没有证据** —— `deadlineRouteEvidence` 只认
      //     `network-route-unproven:` 标记，而"本机探测无结论 ⇒ 6s 封顶"那一支的 reason 里没有标记
      //     （实测本机：清掉 HTTPS_PROXY 后 `单引擎超 6s 截止，已停止`，无标记 ⇒ 只能靠宿主声明）。
      //     所以这条 throw 的文案现在把 reason 一起带出来 —— 否则日志里只有 `code=deadline`，
      //     下一次还是要靠人肉复现才知道是"探不透"还是"真挂死"。
      envFailIfTiming(`A-2 对照臂在全量并发下超预算（GitLabBlobs=${code}；reasons=${String(reasons).slice(0, 160)}）——单跑可复验；不是产品回归`);
    }
    //   v1.53.14：403 forbidden（账号权限，如 GitLab 全局搜索对账号层级关闭）是**环境/账号配置**问题，
    //   不是产品缺陷 —— 引擎已正确归因 + 回退项目级。与 missing-credential（令牌失效，真产品问题）分开。
    if (code === 'forbidden' || /403|forbidden|disabled.*scope|全局搜索.*关闭/i.test(reasons)) {
      envFail('account-permission', `A-2 对照臂：GitLabBlobs 判 ${code}（${reasons.substring(0, 120)}）——账号权限/配置问题，不是产品回归，也不是令牌失效`);
    }
    assert.fail(`有凭据时 GitLabBlobs 仍判 ${code}（Reasons=${reasons}）——若为 missing-credential 则是**真产品问题**（令牌失效），须修令牌而非放宽本门`);
  }
  assert.notEqual(c.Verdict, 'none');
});

test('U-158E A-3（负例 · 源码敏感度）: none 分支必须早于 partial', () => {
  const src = sourceAll(WORKROOT);   // v1.54.0（B3-2）：函数在 lib/，必须读展开源码
  // 锚点：内联 `Verdict = $(if (Requested>0 && Executed==0) { 'none' } elseif (hasBlocked) { 'partial' } …)`
  //   v1.49.0 起抽成 function Get-CoverageVerdict { if (…) { return 'none' } if ($HasBlocked) { return 'partial' } … }
  const line = src.split(/\r?\n/).find(l => /Verdict\s*=\s*\$\(if\s*\(/.test(l))
    || (src.match(/function Get-CoverageVerdict \{[\s\S]*?\n\}/) || [])[0];
  assert.ok(line, '必须找到 Verdict 的派生处（内联表达式或 Get-CoverageVerdict；锚点变了就要同步改本门）');
  const iNone = line.indexOf("'none'"), iPartial = line.indexOf("'partial'");
  assert.ok(iNone >= 0 && iPartial >= 0, 'Verdict 表达式必须同时含 none 与 partial');
  assert.ok(iNone < iPartial, 'none 必须在 partial 之前判定（U-120 同款不变量）');
  // 弄红对照：交换两者位置 ⇒ 断言必红
  const swapped = line.replace("'none'", "'@@'").replace("'partial'", "'none'").replace("'@@'", "'partial'");
  assert.ok(swapped.indexOf("'none'") > swapped.indexOf("'partial'"), '交换后顺序反转 ⇒ 上面的顺序断言确实依赖顺序');
});

// ---------- B · tool-awareness（0 次选错） ----------
// 期望来源：① 前 3 条本项目 2026-10-03 实测（reports/gates/u158e-delegation-*/planner-classification-probe.txt）
//           ② 后 2 条取自既有门 tests/test-u143-auto-research.test.mjs 的断言字面量
const LABELED = [
  { q: '今天天气怎么样', expect: 'research_only' },
  { q: 'asdfghjkl zzzz', expect: 'research_only' },
  { q: '如何做红烧肉', expect: 'research_only' },
  { q: 'powershell module dot sourcing refactor monolithic script', expect: 'code_evidence_only' },
  { q: 'best practices refactoring large legacy codebase into modules', expect: 'integrated_research_and_code' },
];
// 用**序号**比对（不比查询串 —— 中文经控制台会失真，实测过）
function compareLabels(labels, actualById) {
  const bad = [];
  labels.forEach((l, i) => { if (actualById[i] !== l.expect) bad.push(`#${i}: 期望 ${l.expect} 实得 ${actualById[i]}`); });
  return bad;
}
let actualTypes = {};
test('U-158E B-1（tool-awareness 主判据）: 标注查询集分类错选数 = 0', async () => {
  const list = LABELED.map(l => `'${l.q.replace(/'/g, "''")}'`).join(',');
  const script = `$ErrorActionPreference='Stop'; $i=0; foreach ($q in @(${list})) { $p = & '${PLANNER.replace(/'/g, "''")}' -Query $q | ConvertFrom-Json; 'U158E_TYPE='+$i+'|'+$p.queryType; $i++ }`;
  const r = await new Promise(resolve => {
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const c = spawn('pwsh', ['-NoProfile', '-Command', script], { cwd: WORKROOT, env, windowsHide: true });
    let o = '', e = '';
    c.stdout.on('data', d => { o += d; }); c.stderr.on('data', d => { e += d; });
    c.once('close', code => resolve({ code, o, e }));
    c.once('error', err => resolve({ code: null, o, e: err.message }));
  });
  assert.equal(r.code, 0, 'planner 必须能跑: ' + r.e.slice(0, 300));
  for (const line of r.o.split(/\r?\n/)) {
    const m = /^U158E_TYPE=(\d+)\|([a-z_]+)$/.exec(line.trim());
    if (m) actualTypes[Number(m[1])] = m[2];
  }
  assert.equal(Object.keys(actualTypes).length, LABELED.length, `应拿到 ${LABELED.length} 条分类，实得 ${Object.keys(actualTypes).length}: ${r.o.slice(0, 300)}`);
  assert.deepEqual(compareLabels(LABELED, actualTypes), [], '错选必须为 0');
});
test('U-158E B-2（负例）: 改错一条期望 ⇒ 比较器必须报出恰好 1 条不符', () => {
  const corrupted = LABELED.map((l, i) => (i === 0 ? { ...l, expect: '__WRONG__' } : l));
  const bad = compareLabels(corrupted, actualTypes);
  assert.equal(bad.length, 1, '必须恰好 1 条不符，实得 ' + bad.length);
  assert.match(bad[0], /^#0:/, '且必须点名是哪一条');
});

// ---------- C · 轨迹级（含静默零命中反例） ----------
test('U-158E C-1（静默假阴性反例）: 缺凭据必须记 missing-credential，不得记 zero-hit', () => {
  const c = noTokenRun.j.coverage;
  const code = (c.ReasonCodes || {})['GitLabBlobs'];
  assert.equal(code, 'missing-credential', `缺凭据必须记 missing-credential，实得 ${code}`);
  assert.notEqual(code, 'zero-hit', '★绝不可把"没执行"记成"检索成功但 0 命中"（N-18 同族）');
  const reason = (c.Reasons || {})['GitLabBlobs'] || '';
  assert.ok(reason.length > 0, '必须给出人读理由');
  assert.doesNotMatch(reason, /0 命中/, '理由不得写"0 命中"（与 missing-credential 自相矛盾）');
});
// ★B2-1（U-263）：engine/1 引擎**不自报 status** —— 它把"没执行"写成 `failure.reasonCode='missing-credential'`，
//   由 L1 映回 `auth_missing`。所以判据从"必须出现 auth_missing 字符串"放宽成"必须留下**可映回**的证据"，
//   否则会把已经正确的迁移判红（假红比漏判更贵：它会教人去改对的东西）。
const AUTH_EVIDENCE = /auth_missing|missing-credential/;
test('U-158E C-2（源码不变量 · 跨全部引擎）: 代码里处理 401 的引擎，必须留下可映回 auth_missing 的证据', () => {
  const dir = path.join(root, 'engines');
  const offenders = [];
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.ps1'))) {
    // ★先剥注释：实测 mcp-registry.ps1 的 "401" 只出现在注释里（讲 Glama 永久 401），
    //   不剥注释就会把"注释提到 401"误判成"处理了 401"——那是我上一版检查的错，不是引擎的错。
    const code = fs.readFileSync(path.join(dir, f), 'utf8')
      .split(/\r?\n/).filter(l => !/^\s*#/.test(l)).join('\n');
    if (!/\b401\b/.test(code)) continue;
    if (!AUTH_EVIDENCE.test(code)) offenders.push(`${f}: 代码里提到 401，但既不记 auth_missing 也不报 missing-credential`);
  }
  assert.deepEqual(offenders, [], offenders.join(' | '));
  // 弄红对照：找一个真带 401 判定的引擎，把 auth_missing 全替换掉 ⇒ 上面的检查必报它
  const victim = fs.readdirSync(dir).filter(x => x.endsWith('.ps1'))
    .map(f => ({ f, code: fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/).filter(l => !/^\s*#/.test(l)).join('\n') }))
    .find(x => /\b401\b/.test(x.code) && AUTH_EVIDENCE.test(x.code));
  assert.ok(victim, '应至少有一个引擎同时含 401 判定与可映回证据（否则本检查无样本）');
  const mutated = victim.code.replace(/auth_missing|missing-credential/g, 'empty');
  assert.ok(!AUTH_EVIDENCE.test(mutated), '变异必须真的改到字节');
  assert.ok(/\b401\b/.test(mutated) && !AUTH_EVIDENCE.test(mutated), '变异后该文件必须落在 offenders 的判据里');
});

// ---------- D · pass^5 聚合（SKIP ≠ PASS） ----------
function aggregatePass5(checks) {
  const required = checks.filter(c => c.required !== false);
  const anyNotPass = required.some(c => c.status !== 'pass');
  return { pass: required.filter(c => c.status === 'pass').length, total: required.length, value: anyNotPass ? 0 : 1 };
}
const ALL_PASS = ['A', 'B', 'C', 'D', 'E'].map(id => ({ id, status: 'pass' }));
test('U-158E D-1（聚合）: 五项全 pass ⇒ 1；任一项 fail/skip ⇒ 不得为 1', () => {
  assert.deepEqual(aggregatePass5(ALL_PASS), { pass: 5, total: 5, value: 1 });
  for (const st of ['fail', 'skip']) {
    const r = aggregatePass5(ALL_PASS.map(x => (x.id === 'C' ? { ...x, status: st } : x)));
    assert.equal(r.value, 0, `C=${st} 时聚合值不得为 1（★skip 不得计为通过）`);
  }
});
test('U-158E D-2（负例）: 聚合器漏掉一项必需检查却仍报 1 ⇒ 必判红', () => {
  const droppy = (checks) => {
    const req = checks.filter(c => c.required !== false).slice(0, 4);   // 变异：悄悄只看前 4 项
    return { value: req.every(c => c.status === 'pass') ? 1 : 0 };
  };
  const c = ALL_PASS.map(x => (x.id === 'E' ? { ...x, status: 'fail' } : x));
  assert.equal(aggregatePass5(c).value, 0, '正确聚合器必须报 0');
  assert.equal(droppy(c).value, 1, '变异聚合器会漏掉第 5 项报 1 —— 这正是 D-2 要抓的');
});

// ---------- E · 负例 5/5 红（互补；每条都是"把对应检查的原断言作用在损坏世界上"⇒ 必须抛） ----------
const NEGATIVES = [
  { id: 'n1', about: 'A', label: '全不执行却被报成 full', red: () => assert.equal('full', 'none') },
  { id: 'n2', about: 'B', label: '路由错选未被发现（期望被改错）', red: () => assert.deepEqual(compareLabels(LABELED.map((l, i) => (i === 0 ? { ...l, expect: '__X__' } : l)), actualTypes), []) },
  { id: 'n3', about: 'C', label: '缺凭据被记成 zero-hit', red: () => assert.equal('zero-hit', 'missing-credential') },
  { id: 'n4', about: 'D', label: '聚合器漏项仍报 pass^5=1', red: () => { const c = ALL_PASS.map(x => (x.id === 'E' ? { ...x, status: 'fail' } : x)); assert.equal((c.every(x => x.status === 'pass') ? 1 : 0), 1); } },
  { id: 'n5', about: 'E', label: '运行器吞掉失败退出码却仍报 5/5 红', red: () => assert.equal(3, 5, '★吞掉失败后观测数必然 <5，报 5/5 即说谎') },
];
test('U-158E E-1: 五条负例逐条可弄红，且覆盖五个不同项', () => {
  for (const n of NEGATIVES) assert.throws(() => n.red(), assert.AssertionError, `负例 ${n.id}(${n.label}) 必须能弄红`);
  assert.equal(new Set(NEGATIVES.map(n => n.about)).size, 5, '五条必须覆盖五个不同项，不得同一故障换说法');
});

// ---------- pass^5 · 对**本门自身**的聚合（skip 不得计为通过） ----------
test('U-158E pass^5: 由实际读数聚合 —— 任一项 skip/fail ⇒ 值不得为 1', () => {
  const status = (ok) => (ok ? 'pass' : 'fail');
  // A-ctrl 三态：pass / **env**（超预算等已知时序类，**既不算 pass 也不算产品 fail**）/ fail / skip
  let ctrl = 'skip';
  if (withTokenRun?.j) {
    const v = withTokenRun.j.coverage?.Verdict;
    // v1.49.1：只有**带路由证据**的 deadline 才算 env；裸 deadline 可能是产品挂死 ⇒ fail（fail-closed）。
    //   v1.53.14：403 forbidden（账号权限，GitLab 全局搜索对账号层级关闭）也归 env —— 引擎行为正确，是账号配置问题。
    const gc = withTokenRun.j.coverage || {};
    const isForbidden = (gc.ReasonCodes || {})['GitLabBlobs'] === 'forbidden' ||
      /403|forbidden|disabled.*scope|全局搜索.*关闭/i.test(JSON.stringify(gc.Reasons || {}));
    ctrl = (v !== 'none') ? 'pass' : (deadlineRouteEvidence(gc).length || isForbidden ? 'env' : 'fail');
  }
  const checks = [
    { id: 'A', status: (noTokenRun && noTokenRun.j?.coverage?.Verdict === 'none') ? 'pass' : 'fail' },
    { id: 'A-ctrl', status: ctrl },
    { id: 'B', status: status(Object.keys(actualTypes).length === LABELED.length && compareLabels(LABELED, actualTypes).length === 0) },
    { id: 'C', status: status(noTokenRun?.j?.coverage?.ReasonCodes?.GitLabBlobs === 'missing-credential') },
    { id: 'E', status: status(NEGATIVES.every(n => { try { n.red(); return false; } catch { return true; } })) },
  ];
  for (const c of checks) console.log(`[U-158E] check ${c.id} = ${c.status}`);
  const envChecks = checks.filter(c => c.status === 'env');
  const agg = aggregatePass5(checks.map(c => (c.status === 'env' ? { ...c, status: 'skip' } : c)));   // env 视作非 pass
  console.log(`[U-158E] pass^5 = ${agg.value} (${agg.pass}/${agg.total})  env=${envChecks.map(c => c.id).join(',') || 'none'}`);
  // ★env 类先报（照本仓口径：env 红仍是红，但不计 product）；env 不得被当成 pass
  if (envChecks.length) {
    const gc = withTokenRun?.j?.coverage || {};
    const ev = deadlineRouteEvidence(gc);
    const isForbidden = (gc.ReasonCodes || {})['GitLabBlobs'] === 'forbidden' ||
      /403|forbidden|disabled.*scope|全局搜索.*关闭/i.test(JSON.stringify(gc.Reasons || {}));
    if (ev.length) envFail('no-network', `pass^5 有 env 类检查未通过: ${envChecks.map(c => c.id).join(',')}（${formatRouteEvidence(ev)}；单跑可复验）`);
    if (isForbidden) envFail('account-permission', `pass^5 有 env 类检查未通过: ${envChecks.map(c => c.id).join(',')}（403 forbidden：账号权限/配置问题，不是产品回归）`);
    envFailIfTiming(`pass^5 有 env 类检查未通过: ${envChecks.map(c => c.id).join(',')}（单跑可复验；不是产品回归）`);
  }
  assert.equal(agg.value, 1, `pass^5 必须为 1，实得 ${agg.value}；明细: ${checks.map(c => c.id + '=' + c.status).join(', ')}`);
});
