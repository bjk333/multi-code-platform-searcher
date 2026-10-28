// U-115（2026-09-28；**v1.68.0 / B3-15 改写为行为门**）：缺凭据源单列。
//
// 契约：`auth_missing`（连请求都没发）与"已请求但失败"（error/rate_limited/deadline）必须**分开报**；
//   coverage 键集不许扩（U-89 样本门）；逐引擎码走 `ReasonCodes`。
//
// 为什么改写：
//   原门分两半 —— 一半 grep 源码正则，一半读 2026-09-28 录下的 `reports/gates/u115-b7/code-no-token.json`。
//   后者是**当时的产物**：产品今天把两段合并成一行，那份 JSON 也不会变，门照样绿。
//   现在改成跑整个 CLI（离线回放，`lib/cli-replay.mjs`），断言落在本次运行的 `coverage` / `warnings` 上。
//
// 断言（与改写前逐条对应，且更强）：
//   A. 缺凭据源进"因缺凭据未请求"，且**不在**"已请求但失败"里（两表不相交）
//   B. "已请求但失败"恒等于 `coverage.Degraded`，且其中没有 `missing-credential` 码
//   C. 负例：什么都不缺、什么都不失败 ⇒ **不许**有这一行（否则"永远打印"也能过 A/B）
//   D. coverage 键集不变（U-89 样本门的口径，此前只能靠 grep）
//   E. 非 AsJson 的三段健康度：控制台必须分别出现两段（用户读的是控制台，不是 JSON）
//
// ★"合并两表"这个变异不需要改源码就能被抓：B 要求 failed === Degraded，
//   而 Degraded 里从来没有 auth_missing 的源 ⇒ 把 miss 也塞进 failed 立刻违反等式。
//
// ★写这条门时抓到的一件事（v1.68.0 已修）：回放接缝此前把录制到的 **500 当 200 返回** ——
//   引擎拿到空正文后报"检索成功但 0 命中"，`Degraded` 是空的。也就是说，**在修之前，这条门的 B 臂
//   会以"源没数据"的形式假绿**（第一版实跑就是 `Retry-After`/`StatusCode` 全丢）。修法见 lib/http.ps1。

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeReplayDir, recordFromFixture, readReplay, writeReplay, runCli, requirePayload } from './behavior/lib/cli-replay.mjs';

const KW = 'zzzero';
const ARGS = ['-NoEnvFile', '-CodeEvidence', '-Keyword', KW, '-Limit', '5', '-AsJson', '-NoCache'];
const CONSOLE_ARGS = ARGS.filter((a) => a !== '-AsJson');
const DISABLE_GREP = 'SEExcerpts';   // 三源：GitHubCode / GitLabBlobs（缺凭据）+ GrepApp（成败由语料定）
const DISABLE_ALL = 'GrepApp,SEExcerpts,GitHubCode,GitLabBlobs';   // 只剩 Sourcegraph

const LINE_RE = /^\[coverage\] 因缺凭据未请求: (.+); 已请求但失败: (.+)$/;
const parseLine = (warnings) => {
  const line = (warnings || []).find((w) => LINE_RE.test(String(w)));
  if (!line) return null;
  const [, miss, failed] = String(line).match(LINE_RE);
  const toList = (s) => (s === '(无)' ? [] : s.split(', '));
  return { line, miss: toList(miss), failed: toList(failed) };
};

const SG_EMPTY = 'event: progress\ndata: {"done":true}\n\n';
const SG_ONE = 'event: matches\ndata: ' + JSON.stringify([
  { type: 'content', repository: 'github.com/a/b', path: 'src/x.go', lineMatches: [{ lineNumber: 3, line: 'func main() {}' }] },
]) + '\n\n';
const SG_ROUTE = { host: 'sourcegraph.com', path: /^\/\.api\/search\/stream$/, headers: { 'content-type': 'text/event-stream' }, body: SG_EMPTY };
// GrepApp 是 MCP over JSON-RPC，响应是 SSE；"空结果"= result.content[0].text 为空串
const GA_EMPTY = 'event: message\ndata: ' + JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '' }] } }) + '\n\n';

const dirOk = makeReplayDir('u115-ok');
const dirErr = makeReplayDir('u115-err');
const dirConsole = makeReplayDir('u115-console');
const runs = {};

function dupRows(dir, times = 3) {
  const rows = readReplay(dir);
  const out = [];
  for (const r of rows) for (let i = 0; i < times; i++) out.push({ ...r });
  writeReplay(dir, out);
}

before(async () => {
  // ① 成功路径的语料：Sourcegraph 200 空流 + GrepApp 200 空结果
  await recordFromFixture({ fn: 'Search-Sourcegraph', status: 'Sourcegraph', params: { Keyword: KW, Limit: 5 }, routes: [SG_ROUTE] }, dirOk);
  await recordFromFixture({
    fn: 'Search-GrepApp', status: 'GrepApp', params: { Keyword: KW, Limit: 5 },
    routes: [{ host: 'mcp.grep.app', path: '/', method: 'POST', headers: { 'content-type': 'text/event-stream' }, body: GA_EMPTY }],
  }, dirOk);
  // ② 失败路径的语料：Sourcegraph 200 空流 + GrepApp 500
  await recordFromFixture({ fn: 'Search-Sourcegraph', status: 'Sourcegraph', params: { Keyword: KW, Limit: 5 }, routes: [SG_ROUTE] }, dirErr);
  await recordFromFixture({
    fn: 'Search-GrepApp', status: 'GrepApp', params: { Keyword: KW, Limit: 5 },
    routes: [{ host: 'mcp.grep.app', path: '/', method: 'POST', status: 500, body: { message: 'boom' } }],
  }, dirErr);
  // 5xx 会重试（CodeRequestMaxAttempts=2）。回放游标"逐次取下一行" ⇒ 把每行复制成 3 份，
  //   让重试也拿到同一个 500（否则第二次尝试撞 replay-exhausted，那也是一种失败，但不是这条臂要测的分档）。
  dupRows(dirErr, 3);

  // ③ 控制台臂：在 dirErr 基础上把 Sourcegraph 换成"1 条命中" ⇒ 有结果、有降级源、有缺凭据源，三段齐活
  fs.cpSync(dirErr, dirConsole, { recursive: true });
  const rows = readReplay(dirConsole);
  let patched = 0;
  for (const r of rows) {
    if (!/^https:\/\/sourcegraph\.com\//.test(r.uri)) continue;
    r.content = SG_ONE; patched++;
  }
  assert.ok(patched >= 1, '控制台臂没改到 Sourcegraph 语料 —— 它会因为"没有结果"提前返回，三段健康度一段都看不到');
  writeReplay(dirConsole, rows);

  runs.plain = await runCli({ replayDir: dirOk, args: ARGS, env: { MCPS_DISABLE: DISABLE_GREP } });
  runs.failed = await runCli({ replayDir: dirErr, args: ARGS, env: { MCPS_DISABLE: DISABLE_GREP } });
  runs.clean = await runCli({ replayDir: dirOk, args: ARGS, env: { MCPS_DISABLE: DISABLE_ALL } });
  runs.console = await runCli({ replayDir: dirConsole, args: CONSOLE_ARGS, env: { MCPS_DISABLE: DISABLE_GREP } });
  for (const k of ['plain', 'failed', 'clean']) requirePayload(runs[k], `U-115 ${k}`);
});

test('U-115 A: 缺凭据源进"因缺凭据未请求"，且绝不出现在"已请求但失败"里', () => {
  const p = requirePayload(runs.plain, 'A');
  const s = parseLine(p.warnings);
  assert.ok(s, '必须有一条 [coverage] 汇总行；实际告警：' + JSON.stringify(p.warnings));
  assert.deepEqual([...s.miss].sort(), ['GitHubCode', 'GitLabBlobs'], '缺凭据的是这两个（本轮无令牌）');
  assert.deepEqual(s.failed, [], '这一轮没有任何失败源 ⇒ 第二段必须是 (无)，不许把缺凭据的塞进来');
  for (const e of s.miss) {
    assert.equal(p.coverage.ReasonCodes[e], 'missing-credential', `${e} 的逐引擎码必须是 missing-credential`);
    assert.ok(!s.failed.includes(e), `${e} 同时出现在两段里 —— 两表被合并了`);
  }
});

test('U-115 B: "已请求但失败"恒等于 coverage.Degraded，且不含 missing-credential', () => {
  const p = requirePayload(runs.failed, 'B');
  const s = parseLine(p.warnings);
  assert.ok(s, '有失败源时必须给出汇总行');
  assert.deepEqual([...s.failed].sort(), [...p.coverage.Degraded].sort(), '第二段的来源必须就是 Degraded（不许另起一套判定）');
  assert.ok(s.failed.includes('GrepApp'), '500 的源必须出现在"已请求但失败"里；实际：' + JSON.stringify(s));
  assert.equal(p.coverage.ReasonCodes.GrepApp, 'error', '500 的逐引擎码是 error');
  for (const e of s.failed) assert.notEqual(p.coverage.ReasonCodes[e], 'missing-credential', `${e} 是失败源，不该带缺凭据码`);
  assert.deepEqual([...s.miss].sort(), ['GitHubCode', 'GitLabBlobs'], '缺凭据的两个仍在第一段，且没有被"失败"吞掉');
  assert.ok(!s.failed.some((e) => s.miss.includes(e)), '同一个源不许同时是"没请求"和"请求了但失败"');
});

test('U-115 C: 负例 —— 不缺凭据、也没有失败源 ⇒ 不许出现这一行', () => {
  const p = requirePayload(runs.clean, 'C');
  assert.deepEqual(p.coverage.Blocked, [], '前提：本轮没有阻塞源');
  assert.deepEqual(p.coverage.Degraded, [], '前提：本轮没有失败源');
  assert.equal(parseLine(p.warnings), null, '什么都没有却打印汇总行 ⇒ 用户会以为出事了；实际：' + JSON.stringify(p.warnings));
});

test('U-115 D: coverage 键集不变（U-89：不许为这件事新开键）', () => {
  const p = requirePayload(runs.failed, 'D');
  assert.deepEqual(Object.keys(p.coverage).sort(), ['Blocked', 'Degraded', 'ReasonCodes', 'Reasons', 'Requested', 'Verdict', 'Executed'].sort(),
    'coverage 键集被改了 —— 消费方按固定键集解析，新增/改名都是破坏性变更');
});

test('U-115 E: 非 AsJson 的三段健康度里，两段必须分别出现（用户读的是控制台）', () => {
  const r = runs.console;
  assert.equal(r.status, 0, '控制台跑必须 rc=0：' + String(r.stderr).slice(-400));
  // ★健康度/告警走 **stderr**（U-266：成功流只放"产物"，进度与提示一律 stderr；重定向时 Write-ColorOutput 写 Error 流）。
  //   所以这里必须两股合起来看 —— 只查 stdout 会得出"产品没有健康度输出"的错误结论（第一版就是这么红的）。
  const out = r.stdout + '\n' + r.stderr;
  assert.match(out, /因缺凭据未请求: GitHubCode, GitLabBlobs/, '控制台必须列出缺凭据的源（顺序按注册表）');
  assert.match(out, /已请求但失败\(降级\): GrepApp/, '控制台必须把失败源单列一段');
});
