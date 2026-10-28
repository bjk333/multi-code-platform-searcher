// U-182（2026-10-19；**v1.68.0 / B3-15 改写为行为门**）：零产出必须被「说出来」，但不得自动降级。
//
// 背景：批模式 8 查询实测 7/11 源零产出，而输出只有**逐源** reason，用户看不到"整体覆盖"。
//
// 为什么改写（不是"为了让占比好看"）：
//   原门 grep 源码：`if ($zeroNames.Count -ge 3)`、`Add-EngineWarning ... 本轮 {0}/{1} 源零产出`。
//   它能证明"代码里写着 3"，却证明不了**跑到 3 个源时真的告警、2 个时不告警** ——
//   而后者才是用户看到的东西。四种结局（3/3、2 个不告警、3/4、跨运行不自禁用）用源码正则**都验不了**。
//   现在改成跑整个 CLI（离线回放，见 `lib/cli-replay.mjs`）：断言落在 `payload.warnings` /
//   `payload.coverage` 上 —— 那是调用方真正读到的字段。
//
// 契约（与改写前逐条对应）：
//   A. 有聚合告警，且门槛 ≥3（3 个源 ⇒ 告警；2 个源 ⇒ 不告警）
//   B. 零产出按**引擎产出**判定：4 个源里 1 个有结果 ⇒ 告警说 `3/4`
//   C. ★ 只 warnings，**不得**自动改默认阈值/自动禁用源（Executed 恒为全部；streak 状态不落盘）
//   D. 文案必须给可操作项（并发旋钮 / streak 阈值 / 实测收益）
//   E. 证据报告仍在（原始实测记录，不是本门生成物）

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReplayDir, recordFromFixture, runCli, requirePayload, warningMatching } from './behavior/lib/cli-replay.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const REPORT = path.join(ROOT, 'reports', 'gates', 'p03-zero-coverage-2026-10-19', 'README.md');

const KW = 'zzzero';                     // 一个在任何真实源里都不存在的词：零命中必须是"结构性"的
const LIMIT = 5;
const ZERO_WARN = /源零产出/;
// 除这四个之外的研究源全部关掉 —— 关掉的源**不会**进 $engines（`Get-EnabledEngines` 已过滤），
//   所以分母就是"本轮真正参与的源数"，正好用来测门槛。
const OTHERS = 'HF,Npm,Crates,DockerHub,arXiv,OpenAlex,MCPRegistry,HackerNews,SE,DeepSeek';

const ARGS = ['-NoEnvFile', '-ResearchSources', '-Keyword', KW, '-Limit', String(LIMIT), '-AsJson', '-NoCache'];
const NO_DEADLINE = 'Maven=0,RubyGems=0,Packagist=0,NuGet=0';

let dir3 = '';          // 三源全空
let dir2 = '';          // 两源全空
let dir4 = '';          // 四源，其中一个有 1 条结果
let dir4b = '';
const runs = {};

function routesFor() {
  return [
    { fn: 'Search-RubyGems', status: 'RubyGems', routes: [{ host: 'rubygems.org', path: /^\/api\/v1\/search\.json/, body: [] }] },
    { fn: 'Search-Packagist', status: 'Packagist', routes: [{ host: 'packagist.org', path: /^\/search\.json/, body: { results: [], total: 0 } }] },
    { fn: 'Search-MavenCentral', status: 'Maven', routes: [{ host: 'search.maven.org', path: /^\/solrsearch\/select/, body: { response: { docs: [] } } }] },
    { fn: 'Search-NuGet', status: 'NuGet', routes: [{ host: 'azuresearch-usnc.nuget.org', path: /^\/query/, body: { data: [] } }] },
  ];
}

before(async () => {
  dir3 = makeReplayDir('u182-3');
  dir2 = makeReplayDir('u182-2');
  dir4 = makeReplayDir('u182-4');
  dir4b = makeReplayDir('u182-4b');
  for (const s of routesFor()) {
    const spec = { fn: s.fn, status: s.status, params: { Keyword: KW, Limit: LIMIT }, routes: s.routes };
    // 同一批语料写进三个目录：录一次，三份副本（避免每份各跑一遍探针）
    const { rows } = await recordFromFixture(spec, dir3);
    for (const d of [dir2, dir4, dir4b]) fs.appendFileSync(path.join(d, 'responses.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  }

  // dir4b：Packagist 换成"有 1 条结果"，其余仍空 ⇒ 零产出 3 / 参与 4
  const file = path.join(dir4b, 'responses.jsonl');
  const rows = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  let patched = 0;
  for (const r of rows) {
    if (!/^https:\/\/packagist\.org\//.test(r.uri)) continue;
    r.content = JSON.stringify({
      results: [{ name: 'acme/one', description: 'only one', downloads: 5, favers: 1, url: 'https://packagist.org/packages/acme/one' }],
      total: 1,
    });
    patched++;
  }
  assert.ok(patched >= 1, 'Packagist 语料没改到 —— 后面那条 3/4 的臂会假绿');
  fs.writeFileSync(file, rows.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8');

  const streak3 = path.join(os.tmpdir(), `mcps-u182-streak-${process.pid}-3.json`);
  const streak2 = path.join(os.tmpdir(), `mcps-u182-streak-${process.pid}-2.json`);
  const streak4 = path.join(os.tmpdir(), `mcps-u182-streak-${process.pid}-4.json`);
  for (const f of [streak3, streak2, streak4]) { try { fs.unlinkSync(f); } catch { } }

  runs.three = await runCli({ replayDir: dir3, args: ARGS, env: { MCPS_DISABLE: OTHERS + ',NuGet', MCPS_ENGINE_DEADLINE: NO_DEADLINE }, streakFile: streak3 });
  runs.two = await runCli({ replayDir: dir2, args: ARGS, env: { MCPS_DISABLE: OTHERS + ',NuGet,Packagist', MCPS_ENGINE_DEADLINE: NO_DEADLINE }, streakFile: streak2 });
  runs.four = await runCli({ replayDir: dir4b, args: ARGS, env: { MCPS_DISABLE: OTHERS, MCPS_ENGINE_DEADLINE: NO_DEADLINE }, streakFile: streak4 });
  // 第三跑：与第一次同参数、同状态文件（验证"上一轮零产出不会把源关掉"）
  runs.threeAgain = await runCli({ replayDir: dir3, args: ARGS, env: { MCPS_DISABLE: OTHERS + ',NuGet', MCPS_ENGINE_DEADLINE: NO_DEADLINE }, streakFile: streak3 });

  runs.streakFile = streak3;
  for (const [k, r] of Object.entries(runs)) {
    if (r && r.payload) requirePayload(r, `U-182 ${k}`);
  }
});

test('U-182 A: 3 个源全零 ⇒ 聚合告警说 "3/3"（门槛不是 1，也不是 2）', () => {
  const p = requirePayload(runs.three, 'A');
  const hits = warningMatching(p, ZERO_WARN);
  assert.equal(hits.length, 1, '应恰好一条聚合告警；实际：' + JSON.stringify(p.warnings.filter((w) => /零产出|zero/.test(w))));
  assert.match(hits[0], /3\/3 源零产出/, '文案必须同时给出"零产出数/参与数"，否则用户看不出比例');
  for (const n of ['Maven', 'RubyGems', 'Packagist']) {
    assert.ok(hits[0].includes(n), `告警必须点名零产出的源：缺 ${n}；实际：${hits[0]}`);
  }
  assert.equal(p.results.length, 0, '这条臂的前提是"真的一条结果都没有"');
});

test('U-182 A-（负例）: 只有 2 个源参与 ⇒ 不许告警（单源/双源研究不该被说成"大范围零产出"）', () => {
  const p = requirePayload(runs.two, 'A-');
  assert.deepEqual(p.coverage.Executed.sort(), ['Maven', 'RubyGems'], '前提：本轮只有两个源参与');
  assert.equal(warningMatching(p, ZERO_WARN).length, 0, '2 个源零产出也告警 ⇒ 阈值被降到了 1/2：' + JSON.stringify(p.warnings));
});

test('U-182 B: 零产出按**引擎产出**判定 —— 4 源里 1 源有结果 ⇒ 告警说 "3/4"', () => {
  const p = requirePayload(runs.four, 'B');
  assert.equal(p.results.length, 1, '前提：Packagist 那条结果必须真的产出');
  assert.equal(p.results[0].Platform, 'Packagist');
  const hits = warningMatching(p, ZERO_WARN);
  assert.equal(hits.length, 1, '3 个源仍零产出 ⇒ 仍应告警；实际：' + JSON.stringify(p.warnings));
  assert.match(hits[0], /3\/4 源零产出/, '分子=零产出源数、分母=参与源数；写成 4/4 或 3/3 都说明它没按产出计数：' + hits[0]);
  assert.ok(!/Packagist/.test(hits[0].split('。')[0]), 'Packagist 有产出，不该被列进零产出名单：' + hits[0]);
});

test('U-182 C: ★ 只告警，不得自动降级/自动禁用源（跨运行也不许）', () => {
  const p = requirePayload(runs.three, 'C');
  assert.equal(p.coverage.Verdict, 'full', '3 个源都执行成功（只是没搜到）⇒ Verdict 必须是 full；判 degraded 就是把"没有"说成"坏了"');
  assert.deepEqual(p.coverage.Executed.sort(), ['Maven', 'Packagist', 'RubyGems'], '零产出不得把源自禁用');
  assert.deepEqual(p.coverage.Degraded, [], '零产出不是降级');
  assert.equal(fs.existsSync(runs.streakFile), false, '默认（阈值=0）不许写 streak 状态 —— 写了就是在替用户记"该降级了"');

  const again = requirePayload(runs.threeAgain, 'C-again');
  assert.deepEqual(again.coverage.Executed.sort(), ['Maven', 'Packagist', 'RubyGems'],
    '上一轮零产出后，下一轮仍必须有这三个源（否则就是"零产出 ⇒ 自动禁用"）');
  assert.equal(again.coverage.Requested.length, 3, 'Requested 也不许缩水');
});

test('U-182 D: 文案必须给可操作项（并发旋钮 / streak 阈值 / 实测收益）', () => {
  const p = requirePayload(runs.three, 'D');
  const w = warningMatching(p, ZERO_WARN)[0] || '';
  assert.match(w, /MCPS_BATCH_MAX_PARALLEL=1/, '必须给出并发旋钮的具体用法');
  assert.match(w, /MCPS_ZERO_STREAK_THRESHOLD=5/, '必须给出降级阈值的具体用法');
  assert.match(w, /15\.8/, '必须带上实测收益（否则用户不知道为什么值得等 2.8×）');
});

test('U-182 E: 证据报告仍在（原始实测记录，不是本门生成物）', () => {
  assert.ok(fs.existsSync(REPORT), '证据报告必须存在：' + REPORT);
  const r = fs.readFileSync(REPORT, 'utf8');
  assert.match(r, /3\/11|源零产出/, '必须记录触发时的实际告警文本');
  assert.match(r, /单源/, '必须记录单源不触发的负例');
});
