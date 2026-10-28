// U-256（v1.53.27，验收 B1-6 / F10）：**请求入账**。
//
// 病灶（验收报告实测）：`metrics.Requests` 取的是"共享延迟袋条数" —— 只数**拿到响应的**那几次。
//   repo 模式 4 个引擎都真的发了请求，读数却常是 2（`:7180` 注释 + 探针）。拿它当分母算失败率会得出错的结论。
//
// 新口径（`Requests` 语义已变更，v1.53.27 起）：
//   Requests          = attempted —— 每一次真正走到发送的请求（含重试与 node 兜底；预算早退 / 主机已死不算）
//   RequestsSucceeded = 拿到 2xx
//   RequestsFailed    = attempted − succeeded（**派生**，不单独计数）
//   RequestsReturned  = 旧口径（延迟袋条数），保留一个版本
//
// 门分三层：
//   A **执行**真 `Invoke-ApiRequest`（只桩传输层），三个臂的数字必须精确：
//       ok        → 1/1/0   （一次 Web 成功）
//       transport → 2/0/2   （Web 失败 + node 兜底也失败 = **两次真实请求**）
//       http500   → 1/0/1   （上游答了 5xx，退避判定不再重试）
//   B 接线：helper、每轮重置、四处记账、闭包、schema 四字段、文档
//   C 可执行变异：拆掉任一记账点 ⇒ 对应臂的数字必须变（证明 A 不是恒真）
//
// ★A 层的恒等式 `attempted = succeeded + failed` **本身是代数恒等**（failed 由减法得到），
//   所以 harness 额外要求 `failed ≥ 0`；真正的判别力在"每臂 attempted 的精确值"。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPwsh } from './r2-ps-run.mjs';
import { sourceAll } from './lib/source.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = path.join(ROOT, 'multi-platform-searcher.ps1');
const SRC = sourceAll(ROOT);
const SCHEMA = JSON.parse(fs.readFileSync(path.join(ROOT, 'schema', 'asjson.schema.json'), 'utf8'));
const HARNESS = path.join(ROOT, 'tests', 'u256-request-ledger-harness.ps1');

function fnBody(src, name) {
  const i = src.indexOf(`function ${name} {`);
  assert.ok(i > 0, `函数缺失：${name}`);
  const j = src.indexOf('\n}', i);
  assert.ok(j > i, `函数体未闭合：${name}`);
  return src.slice(i, j);
}

let cache = null;
async function arms(extraArgs = []) {
  if (cache && extraArgs.length === 0) return cache;
  const r = await runPwsh(['-File', HARNESS, ...extraArgs], { timeoutMs: 240000 });
  const line = (r.stdout || '').split(/\r?\n/).filter(l => l.trim().startsWith('{"ok"')).pop();
  assert.ok(line, `harness 未输出 JSON 事实行（rc=${r.status}）；stdout=${(r.stdout || '').slice(-400)}`);
  const facts = JSON.parse(line);
  if (extraArgs.length === 0) cache = facts;
  return facts;
}

test('U-256-A: 真 Invoke-ApiRequest 三臂账本（ok 1/1/0 · transport 2/0/2 · http500 1/0/1）', async () => {
  const f = await arms();
  const byId = Object.fromEntries(f.arms.map(a => [a.id, a]));
  const want = {
    // 一次 Web 成功：1 次尝试、1 次成功
    ok: { attempted: 1, succeeded: 1, failed: 0, threw: false },
    // 传输失败：Web 那次 + node 兜底那次 = **两次真实请求**，零成功。
    //   ★这条最容易记错：只记 Web 不记兜底 ⇒ attempted=1，恒等式照样成立（failed=1），
    //     所以"数字精确"是这层唯一的判别力。
    transport: { attempted: 2, succeeded: 0, failed: 2, threw: true },
    // 上游答了 5xx：算一次请求、零成功
    http500: { attempted: 1, succeeded: 0, failed: 1, threw: true },
  };
  for (const [id, w] of Object.entries(want)) {
    const a = byId[id];
    assert.ok(a, `缺臂：${id}`);
    for (const k of Object.keys(w)) assert.equal(a[k], w[k], `${id}.${k}: got=${a[k]} want=${w[k]}`);
    assert.equal(a.identity, true, `${id}: 账本不自洽（failed=${a.failed} 为负说明"成功了却没记 attempt"）`);
  }
  assert.deepEqual(f.fails, [], f.fails.join('; '));
});

test('U-256-B: 接线 —— helper / 每轮重置 / 四处记账 / 闭包 / schema / 文档', () => {
  const bad = [];
  const add = fnBody(SRC, 'Add-ApiRequestStat');
  const get = fnBody(SRC, 'Get-ApiRequestStats');
  if (!/ValidateSet\('attempt', 'ok'\)/.test(add)) bad.push('Add-ApiRequestStat 未限定 Kind 取值');
  if (!/ConcurrentBag\[string\]/.test(add)) bad.push('账本未用跨 Runspace 共享容器（AppDomain + ConcurrentBag）');
  if (!/Attempted = \$a; Succeeded = \$o; Failed = \(\$a - \$o\)/.test(get.replace(/\s+/g, ' ').replace(/ /g, ' '))) {
    // 允许换行排版：退化为逐段断言
    if (!/Attempted = \$a/.test(get) || !/Failed = \(\$a - \$o\)/.test(get)) bad.push('Get-ApiRequestStats 未按 attempted/succeeded 聚合且 failed 派生');
  }
  // 每轮重置：否则 -Serve 长驻进程里会跨请求累加
  if (!/SetData\('mcps_reqstats', \(New-Object 'System\.Collections\.Concurrent\.ConcurrentBag\[string\]'\)\)/.test(SRC)) bad.push('缺少每轮重置 mcps_reqstats');
  // 记账点：attempt 至少 2 处（主发送 + node 兜底）、ok 3 处（socks / web / node）
  const attempts = [...SRC.matchAll(/Add-ApiRequestStat -Kind 'attempt'/g)].length;
  const oks = [...SRC.matchAll(/Add-ApiRequestStat -Kind 'ok'/g)].length;
  if (attempts < 2) bad.push(`attempt 记账点不足（${attempts} < 2：主发送 + node 兜底）`);
  if (oks < 3) bad.push(`ok 记账点不足（${oks} < 3：socks / web / node 兜底）`);
  // 闭包：Invoke-ApiRequest 体内新调的自定义命令必须在 Get-HttpLayerClosure 里（U-41 的教训）
  const closure = fnBody(SRC, 'Get-HttpLayerClosure');
  for (const f of ['Add-ApiRequestStat', 'Get-ApiRequestStats']) {
    if (!closure.includes(`'${f}'`)) bad.push(`${f} 未进 HTTP 层闭包（Runspace 里会找不到它）`);
  }
  // metrics：四字段同源
  for (const [label, re] of [
    ['Requests', /Requests\s+= \$reqStats\.Attempted/],
    ['RequestsSucceeded', /RequestsSucceeded\s+= \$reqStats\.Succeeded/],
    ['RequestsFailed', /RequestsFailed\s+= \[Math\]::Max\(0, \$reqStats\.Attempted - \$reqStats\.Succeeded\)/],
    ['RequestsReturned', /RequestsReturned\s+= \$requestsN/],
  ]) {
    if (!re.test(SRC)) bad.push(`metrics 缺字段或口径不对：${label}`);
  }
  // schema：四字段进 properties 且进 required（U-95 要求 required 列全）
  const props = SCHEMA.properties.metrics.properties;
  const req = SCHEMA.properties.metrics.required;
  for (const k of ['Requests', 'RequestsSucceeded', 'RequestsFailed', 'RequestsReturned']) {
    if (!props[k]) bad.push(`schema.properties.metrics 缺 ${k}`);
    if (!req.includes(k)) bad.push(`schema.required.metrics 缺 ${k}`);
  }
  if (!/attempted/.test(props.Requests?.description || '')) bad.push('schema 未说明 Requests 已改为 attempted');
  assert.deepEqual(bad, [], bad.join('; '));
});

test('U-256-C: 可执行变异 —— 拆掉任一记账点，对应臂的数字必须变', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u256m-'));
  const mainPath = path.join(dir, 'multi-platform-searcher.ps1');
  const harnessInDir = path.join(dir, 'tests');
  fs.mkdirSync(harnessInDir, { recursive: true });
  // harness 用 `-SkillDir` 指向变异副本；其余依赖（engines/ 等）不需要 —— harness 只 dot-source 主脚本
  fs.copyFileSync(HARNESS, path.join(harnessInDir, 'u256-request-ledger-harness.ps1'));

  // ① 拆掉主发送的 attempt 记账 ⇒ ok 臂 attempted 0、succeeded 1 ⇒ failed=-1 ⇒ identity 假
  //   ★锚点随 B2-6 更新：attempt 记账那行现在带 `-Attempt/-Sw`，且秒表先建（顺序本身有语义：
  //     反了就把上一次的秒表传给账本）。
  const m1 = SRC.replace("$reqSw = [System.Diagnostics.Stopwatch]::StartNew(); Add-ApiRequestStat -Kind 'attempt' -Attempt $attempt -Sw $reqSw", '$reqSw = [System.Diagnostics.Stopwatch]::StartNew()');
  assert.notEqual(m1, SRC, '变异①未生效（锚点变了？）');
  fs.writeFileSync(mainPath, m1, 'utf8');
  const f1 = await arms(['-SkillDir', dir]);
  const ok1 = f1.arms.find(a => a.id === 'ok');
  assert.equal(ok1.attempted, 0, '拆掉 attempt 记账后 ok 臂仍记了 attempt —— A 层断言可能恒真');
  assert.equal(ok1.identity, false, 'failed 为负时必须自报不自洽');

  // ② 拆掉 node 兜底的 attempt 记账 ⇒ transport 臂 attempted 由 2 变 1（**恒等式照样成立**，
  //   只有"精确数字"能抓到 —— 这正是 A 层不只断恒等式的原因）
  const m2 = SRC.replace("Add-ApiRequestStat -Kind 'attempt' -Attempt $attempt -Sw ([System.Diagnostics.Stopwatch]::StartNew()); $fb = Invoke-ApiNodeFallback", '$fb = Invoke-ApiNodeFallback');
  assert.notEqual(m2, SRC, '变异②未生效');
  fs.writeFileSync(mainPath, m2, 'utf8');
  const f2 = await arms(['-SkillDir', dir]);
  const tr2 = f2.arms.find(a => a.id === 'transport');
  assert.equal(tr2.attempted, 1, '拆掉兜底记账后 transport 臂仍记 2 次');
  assert.equal(tr2.identity, true, '这条恒等式本就抓不到该缺陷（所以 A 层必须断精确数字）');
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { }
});
