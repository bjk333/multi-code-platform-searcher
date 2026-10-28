// U-120（C8，2026-09-28；**v1.69.0 / B3-16 改写为行为门**）：零执行必须单列为 verdict=none，不得被 hasBlocked 抢先判成 partial。
//
// 背景：r61-research-R2 W6（容器无令牌 -CodeEvidence）Executed=[] 却报 partial，L1456 注释早自承同类"静默假阴性"。
//
// 为什么改写：原门读源码，断言"`return 'none'` 出现在 `return 'partial'` 之前"。
//   顺序确实重要，但**用户看到的是 verdict 这个词**，不是源码里的行号。把两句换个位置，
//   行为就变成"一个都没查成，却告诉你'部分成功'"—— 这种错只有跑起来才抓得到（而且它不会报错，只会骗人）。
//   现在三条臂各自跑一次 CLI，断言落在 `coverage.Verdict` 与**进程退出码**上。
//
// 顺带补上原门没有的一条：**进程 rc 只回答"这次有没有结论"**。
//   verdict=partial（有结论，但有源被挡）⇒ rc=0；verdict=none/no-engines ⇒ rc≠0。
//   把 partial 也算失败的话，多源聚合下几乎每轮都非 0，rc 就成了常量噪声。

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReplayDir, recordFromFixture, runCli, requirePayload } from './behavior/lib/cli-replay.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SCHEMA = path.join(ROOT, 'schema', 'asjson.schema.json');

const KW = 'zzzero';
const ARGS = ['-NoEnvFile', '-CodeEvidence', '-Keyword', KW, '-Limit', '5', '-AsJson', '-NoCache'];
const ALL_CODE = ['GitHubCode', 'GitLabBlobs', 'GrepApp', 'SEExcerpts', 'Sourcegraph'];

const dirBlocked = makeReplayDir('u120-blocked');   // 一个请求都不发（GH/GL 缺凭据在请求前就退出）
const dirPartial = makeReplayDir('u120-partial');   // Sourcegraph 跑通（200 + 空流）
const runs = {};

before(async () => {
  await recordFromFixture({
    fn: 'Search-Sourcegraph', status: 'Sourcegraph', params: { Keyword: KW, Limit: 5 },
    routes: [{ host: 'sourcegraph.com', path: /^\/\.api\/search\/stream$/, headers: { 'content-type': 'text/event-stream' }, body: 'event: progress\ndata: {"done":true}\n\n' }],
  }, dirPartial);

  // A：只剩两个"没令牌就不发请求"的引擎 ⇒ Executed=[] + Blocked=2
  runs.blocked = await runCli({ replayDir: dirBlocked, args: ARGS, env: { MCPS_DISABLE: 'GrepApp,SEExcerpts,Sourcegraph' } });
  // B：Sourcegraph 跑通 + 两个阻塞 ⇒ Executed=1 + Blocked=2
  runs.partial = await runCli({ replayDir: dirPartial, args: ARGS, env: { MCPS_DISABLE: 'GrepApp,SEExcerpts' } });
  // C：一个引擎都没请求（全禁用）
  runs.none = await runCli({ replayDir: dirBlocked, args: ARGS, env: { MCPS_DISABLE: ALL_CODE.join(',') } });
  for (const k of Object.keys(runs)) requirePayload(runs[k], `U-120 ${k}`);
});

test('U-120 A: Executed=0 且有阻塞 ⇒ verdict=none（不是 partial），进程 rc≠0', () => {
  const p = requirePayload(runs.blocked, 'A');
  assert.deepEqual(p.coverage.Executed, [], '前提：一个引擎都没执行');
  assert.ok(p.coverage.Blocked.length > 0, '前提：有源被阻塞（缺凭据）');
  assert.equal(p.coverage.Verdict, 'none',
    "★ 零执行必须是 'none'：报 'partial' 等于告诉调用方「部分成功」，而实际是一条结果都没有 —— 这正是 C8 那个静默假阴性");
  assert.notEqual(runs.blocked.status, 0, '一个都没查成时进程 rc 必须非 0（否则 CI/Agent 会把空结果当成功）');
  assert.equal(runs.blocked.status, 3, '缺凭据造成的零执行 ⇒ rc=3（与 metrics.ExitCode 同语义）');
});

test('U-120 B: 有执行 + 有阻塞 ⇒ verdict=partial，且进程 rc=0（"有结论"就算成功）', () => {
  const p = requirePayload(runs.partial, 'B');
  assert.deepEqual(p.coverage.Executed, ['Sourcegraph'], '前提：一个引擎真的跑通了');
  assert.ok(p.coverage.Blocked.length >= 1, '前提：仍有源被阻塞');
  assert.equal(p.coverage.Verdict, 'partial', '有产出 + 有源被挡 ⇒ partial');
  assert.equal(runs.partial.status, 0,
    '★ partial 不许让 rc 非 0：多源聚合下几乎每轮都有源被挡，rc 一旦跟着变就是常量噪声，反而看不见真失败');
});

test('U-120 C: 一个引擎都没请求 ⇒ verdict=no-engines（不是 none），rc=4', () => {
  const p = requirePayload(runs.none, 'C');
  assert.deepEqual(p.coverage.Requested, [], '前提：Requested 为空（全禁用）');
  assert.equal(p.coverage.Verdict, 'no-engines',
    "'none' 指「请求了但一个都没查成」；'no-engines' 指「压根没请求」。两者对用户的指令不同（去配置 vs 去换网络）");
  assert.equal(runs.none.status, 4, '没有引擎可请求 ⇒ rc=4');
});

test('U-120 D: schema 的 Verdict 枚举必须同时含 none 与 no-engines', () => {
  const schema = JSON.parse(fs.readFileSync(SCHEMA, 'utf8').replace(/^\uFEFF/, ''));
  const en = schema.properties.coverage.properties.Verdict.enum;
  assert.ok(en.includes('none'), 'schema Verdict enum 必须含 none');
  assert.ok(en.includes('no-engines'), 'no-engines 必须保留（"什么都没请求"是另一回事）');
  // 负控：枚举匹配本身要能判错 —— 否则上面两条在 enum 写错时也会绿
  assert.ok(!en.includes('definitely-not-a-verdict'), '负控：不该存在的枚举值居然被判为存在');
});
