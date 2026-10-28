// U-286（B3-15，v1.68.0）：**回放接缝的保真性** —— 录到的非 2xx 必须当失败，且响应头要传下去。
//
// 为什么要单开一条门：
//   写 U-115 的 B 臂（"500 的源必须进 Degraded"）时，第一版实跑得到的是
//   `ReasonCodes.Sourcegraph = zero-hit`、`Degraded = []` —— 看上去像"源没数据"。
//   查下去不是产品错，是**接缝撒谎**：`Invoke-ApiReplayOnce` 把录制到的 500 原样
//   `return @{Content;StatusCode;Headers}` 给了 `Invoke-ApiRequest`，而后者在 web 路径上
//   默认"非 2xx 早在 cmdlet 里抛了"，于是 500 被当成 200 —— 正文被当空，引擎报"检索成功但 0 命中"。
//
//   这条门把这件事故钉成两条可执行事实：
//     ① 状态码：录 500 ⇒ 引擎必须 `error`（不是 `empty`/`zero-hit`）
//     ② 响应头：录 429 + `Retry-After: 999` ⇒ 必须走"限流等待过长"的**快速失败**，
//        而不是丢了头之后"照常重试、耗尽再报错"（两条路的终态都是 rate_limited，只有理由分得开）
//
//   ★为什么不用"重试次数"当判据：游标是逐次取行的，重试次数靠"补几行语料"来喂 ——
//     那是**测试自己造出来的**，不是产品事实。理由文案才是产品自己写的。

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { makeReplayDir, recordFromFixture, readReplay, writeReplay, runCli, requirePayload } from './lib/cli-replay.mjs';

const KW = 'zzzero';
const ARGS = ['-NoEnvFile', '-CodeEvidence', '-Keyword', KW, '-Limit', '5', '-AsJson', '-NoCache'];
const DISABLE = 'GitHubCode,GitLabBlobs,GrepApp,SEExcerpts';   // 只留 Sourcegraph：一条臂只测一件事

const dirOk = makeReplayDir('seam-ok');
const dir500 = makeReplayDir('seam-500');
const dir429 = makeReplayDir('seam-429');
const runs = {};

const SG_ROUTE = {
  host: 'sourcegraph.com', path: /^\/\.api\/search\/stream$/,
  headers: { 'content-type': 'text/event-stream' },
  body: 'event: progress\ndata: {"done":true}\n\n',
};

before(async () => {
  await recordFromFixture({ fn: 'Search-Sourcegraph', status: 'Sourcegraph', params: { Keyword: KW, Limit: 5 }, routes: [SG_ROUTE] }, dirOk);

  const clone = (to, patch) => {
    const rows = readReplay(dirOk).map((r) => ({ ...r, ...patch }));
    writeReplay(to, rows);
  };
  // 5xx 会重试（CodeRequestMaxAttempts=2）⇒ 语料必须够重试吃（否则第二次撞 replay-exhausted，
  //   终态是 error 但理由变成"回放耗尽"，测不到状态码本身）。
  clone(dir500, { status: 500, content: JSON.stringify({ message: 'boom' }) });
  writeReplay(dir500, readReplay(dir500).flatMap((r) => [r, { ...r }, { ...r }]));
  clone(dir429, { status: 429, headers: { 'retry-after': '999' }, content: JSON.stringify({ message: 'slow down' }) });
  writeReplay(dir429, readReplay(dir429).flatMap((r) => [r, { ...r }]));

  runs.ok = await runCli({ replayDir: dirOk, args: ARGS, env: { MCPS_DISABLE: DISABLE } });
  runs.err500 = await runCli({ replayDir: dir500, args: ARGS, env: { MCPS_DISABLE: DISABLE } });
  runs.err429 = await runCli({ replayDir: dir429, args: ARGS, env: { MCPS_DISABLE: DISABLE } });
  for (const [k, r] of Object.entries(runs)) requirePayload(r, `U-286 ${k}`);
});

test('U-286 前提: 同一份语料录成 200 时是干净的零命中（否则下面两条红说明不了问题）', () => {
  const p = requirePayload(runs.ok, 'ok');
  assert.equal(p.coverage.ReasonCodes.Sourcegraph, 'zero-hit', '200 + 空流 ⇒ zero-hit');
  assert.deepEqual(p.coverage.Degraded, [], '200 + 空流不是降级');
});

test('U-286 ①: 录到 500 ⇒ 必须 error（不许被当成 200 后报 "检索成功但 0 命中"）', () => {
  const p = requirePayload(runs.err500, '500');
  assert.notEqual(p.coverage.ReasonCodes.Sourcegraph, 'zero-hit',
    '录到 500 却报零命中 —— 接缝把失败当成功了（这正是修之前的行为）');
  assert.equal(p.coverage.ReasonCodes.Sourcegraph, 'error', '500 的逐引擎码必须是 error；实际理由：' + p.coverage.Reasons.Sourcegraph);
  assert.deepEqual(p.coverage.Degraded, ['Sourcegraph'], '"已请求但失败"要能看见它');
  assert.match(String(p.coverage.Reasons.Sourcegraph), /last HTTP 500/,
    '理由里必须带状态码（重试耗尽后的 `last HTTP 500`），否则用户不知道是源挂了还是查询没结果；实际：' + p.coverage.Reasons.Sourcegraph);
});

test('U-286 ②: 录到 429 + Retry-After: 999 ⇒ 限流快速失败（响应头必须穿过接缝）', () => {
  const p = requirePayload(runs.err429, '429');
  // 码用**产品自己的拼法**：`rate-limited`（连字符）。写成 `rate_limited` 会永远红 ——
  //   而那种红会被误读成"归因变了"，实际是断言写错了（第一版就这么红的）。
  assert.equal(p.coverage.ReasonCodes.Sourcegraph, 'rate-limited', '429 是限流，不是 error；实际：' + p.coverage.Reasons.Sourcegraph);
  assert.match(String(p.coverage.Reasons.Sourcegraph), /限流/, '归因要指向限流');
  // ★判据用**账本行数**，不用文案：`-AsJson` 下 `Write-ColorOutput` 直接 return（U-266 的分工），
  //   "(HTTP 429) Retry-After 999s 超过上限" 这句根本不会出现在任何流里 —— 第一版就是去 grep 它，白红一次。
  //   头到达 ⇒ `Get-RetryBackoff -RetryAfterHeader 999` 判 TooLong ⇒ **一次都不重试**（ledger.rows=1）；
  //   头丢了 ⇒ 退避后重试（rows=2，实测耗时 2.4s vs 1.0s）。
  //   两条路的终态都是 `rate-limited`，所以只有"试了几次"分得开 —— 那是产品自己记的账。
  assert.equal(p.execution.ledger.rows, 1,
    '录到 Retry-After: 999 却重试了 —— 头没穿过接缝（账本行数=尝试次数，实测丢头时是 2）');
  assert.equal(p.metrics.RateLimitedCount, 1, '限流计数也应是 1（丢头时会累加两次）');
});
