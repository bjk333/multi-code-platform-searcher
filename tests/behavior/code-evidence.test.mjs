// U-288（B3-17，v1.70.0）：**源码优先/文档兜底**从"grep 三行源码"改成"跑整个 CLI 看结果集"。
//
// 被替换的门（`test-t1-5-code-evidence.test.mjs`）断言的是：
//   ① 源码里存在 `function Select-CodeEvidenceSourceFiles`、`$docExt = '...md...txt...json'`；
//   ② 主流程里有一行 `Select-CodeEvidenceSourceFiles -Results @($allResults)`；
//   ③ `tests/run-tests.ps1` 里有 `T1-5 source-first code evidence` 与 `RunspacePool SessionStateProxy` 两行文本。
// 三条加起来只证明"**这些字**在文件里"。它分不开下面三种世界：
//   · 函数定义了但没接线（静态门靠"那行调用在不在"勉强能分，但改个变量名就失明）；
//   · 接了线但阈值/正则写错（`$docExt` 少一个扩展名 ⇒ 文档没被过滤，静态门照样绿）；
//   · 过滤发生了，但**告警没发**（用户看到少了两条却不知道为什么）。
//
// 这里换成三个臂，全部跑整个 CLI（离线回放，一个字节都不打网）：
//   A 混合命中（源码 1 + 文档 2）⇒ 结果只剩源码那 1 条，且告警**说清剔了几条**；
//   B 只有文档命中 ⇒ 2 条**全部保留**，但告警明说"兜底、不能当源码证据"（不许静默当证据）；
//   C 同一个混合语料换成 `-Auto`（多模式）⇒ 3 条全留，且**不出现**这两个告警（闸只在纯代码模式生效）。
//      ★C 是 A/B 的**范围控制**：没有它，把闸改成"永远过滤"也能让 A 绿。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeReplayDir, recordFromFixture, runCli, requirePayload, warningMatching } from './lib/cli-replay.mjs';

const DOC_EXT = /\.(md|markdown|txt|rst|adoc|html?|json|ya?ml|csv|log|ipynb)$/i;
const sse = (blocks) => blocks.map(([ev, data]) => `event: ${ev}\ndata: ${data}\n\n`).join('');
const mk = (file, line) => ({ type: 'content', repository: 'github.com/x/y', path: file, lineMatches: [{ lineNumber: 3, line }] });

const MIXED = [
  mk('src/server.go', 'redis dial timeout'),
  mk('README.md', 'redis usage docs'),
  mk('config.json', '{"redis": "yes"}'),
];
const DOCS_ONLY = [mk('README.md', 'redis usage docs'), mk('config.json', '{"redis": "yes"}')];

// 纯代码模式只让 Sourcegraph 跑：其余四个 code 源显式禁用（否则它们会因为没有语料而 replay-miss，
//   被 catch 成 0 命中 —— 那种"红"与本门要测的东西无关，会掩盖真正的失败）。
const CODE_ONLY = 'GrepApp,SEExcerpts,GitHubCode,GitLabBlobs';
// `-Auto` 下规划器会同时要 repo / code / research 三个池 ⇒ 除 Sourcegraph 外全禁，语料只需要一份。
const AUTO_OTHERS = 'GrepApp,SEExcerpts,GitHubCode,GitLabBlobs,GitHub,Gitee,GitLab,Codeberg,HF,Npm,Crates,Maven,RubyGems,NuGet,Packagist,DockerHub,arXiv,OpenAlex,MCPRegistry,HackerNews,SE,DeepSeek';

const dirs = {};
async function corpus(tag, matches) {
  if (dirs[tag]) return dirs[tag];
  const dir = makeReplayDir('t15' + tag);
  await recordFromFixture({
    fn: 'Search-Sourcegraph', status: 'Sourcegraph',
    params: { Keyword: 'redis', Limit: 5 },
    routes: [{
      host: 'sourcegraph.com',
      path: /^\/\.api\/search\/stream$/,
      headers: { 'content-type': 'text/event-stream' },
      body: sse([['matches', JSON.stringify(matches)]]),
    }],
  }, dir);
  dirs[tag] = dir;
  return dir;
}

test.after(() => {
  for (const d of Object.values(dirs)) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* OS 清理 */ } }
});

test('U-288-E 纯代码模式：混合命中 ⇒ 文档被过滤，告警说清剔了几条', async () => {
  const dir = await corpus('mixed', MIXED);
  const r = await runCli({
    replayDir: dir,
    args: ['-NoEnvFile', '-CodeEvidence', '-Keyword', 'redis', '-Limit', '5', '-AsJson', '-NoCache'],
    env: { MCPS_DISABLE: CODE_ONLY },
  });
  const p = requirePayload(r, 'T1-5 混合命中');
  assert.equal(p.results.length, 1, '应当只剩源码那 1 条；实际：' + JSON.stringify(p.results.map((x) => x.File)));
  for (const it of p.results) {
    assert.ok(!DOC_EXT.test(String(it.File || '')), '结果里残留文档/数据项：' + it.File);
  }
  // ★"剔了几条"必须对：只剔 1 条也满足"没有文档残留"，但用户会以为还有一条文档没被处理。
  const w = warningMatching(p, /优先源码文件/);
  assert.equal(w.length, 1, '必须有一条且只有一条"优先源码文件"告警；实际：' + JSON.stringify(p.warnings));
  assert.match(w[0], /过滤 2 条文档\/数据项/, '告警里的条数就是被剔掉的条数（2），不是"有过滤"就算；实际：' + w[0]);
});

test('U-288-F 纯代码模式：只有文档命中 ⇒ 全部保留，但明说"兜底、不能当源码证据"', async () => {
  const dir = await corpus('docs', DOCS_ONLY);
  const r = await runCli({
    replayDir: dir,
    args: ['-NoEnvFile', '-CodeEvidence', '-Keyword', 'redis', '-Limit', '5', '-AsJson', '-NoCache'],
    env: { MCPS_DISABLE: CODE_ONLY },
  });
  const p = requirePayload(r, 'T1-5 只有文档');
  // 两个方向都要钉：静默丢弃（少了结果）与静默当成证据（多一句都没有）都是错的。
  assert.equal(p.results.length, 2, '只有文档命中时必须原样保留 2 条（兜底），不许静默丢弃；实际：' + JSON.stringify(p.results.map((x) => x.File)));
  for (const it of p.results) {
    assert.ok(DOC_EXT.test(String(it.File || '')), '这条臂的语料全是文档，结果里却出现非文档项：' + it.File);
  }
  const w = warningMatching(p, /已保留兜底/);
  assert.equal(w.length, 1, '必须有一条"已保留兜底"告警；实际：' + JSON.stringify(p.warnings));
  assert.match(w[0], /不能当作源码证据/, '兜底必须带警示语 —— 否则用户会把 README 当实现证据；实际：' + w[0]);
  // 反向：这条臂不该出现"过滤 N 条"（一条都没剔）
  assert.equal(warningMatching(p, /优先源码文件/).length, 0, '没有可剔的项时不该报"过滤"');
});

test('U-288-G 范围控制：同一混合语料走 -Auto（多模式）⇒ 3 条全留，闸不生效', async () => {
  const dir = await corpus('mixed', MIXED);
  const r = await runCli({
    replayDir: dir,
    args: ['-NoEnvFile', '-Auto', '-Keyword', '调研 redis 开源项目和代码实现', '-Limit', '5', '-AsJson', '-NoCache'],
    env: { MCPS_DISABLE: AUTO_OTHERS },
  });
  const p = requirePayload(r, '-Auto 混合模式');
  assert.equal(p.results.length, 3, '多模式混合排序不该套用源码闸（文档在 repo/research 语境里是合理条目）；实际：' + JSON.stringify(p.results.map((x) => x.File)));
  assert.equal(warningMatching(p, /优先源码文件|已保留兜底/).length, 0,
    '闸只在纯代码模式生效；多模式下出现这两条告警说明闸被放到了全局；实际：' + JSON.stringify(p.warnings));
});
