// U-288（B3-17，v1.70.0）：**查询规划器的判词**从"grep 源码"改成"真跑规划器"。
//
// 被替换的门（`test-t2-8-planner.test.mjs`）断言的是：
//   ① `query-planner.ps1` 里有 `\u6280\u80fd` / `\u5206\u53d1` / `'CI'` 这几个字面量；
//   ② `tests-query-planner.ps1`（夹具文件）里有 `... Expected = 'integrated_research_and_code'` 这一行。
// 它证明不了任何**行为**：词在词表里 ≠ 词生效（大小写、词边界、被 replace 掉、被后面的分支抢先）；
//   夹具里写着 Expected ≠ 规划器真的给出那个值（夹具是另一个进程，没人跑它时它只是文本）。
// 现在每条臂都真跑 `query-planner.ps1`，断言它吐出的 `queryType` 与 `engineCandidates`。
//
// ★为什么 `engineCandidates` 也要断言：`queryType` 正确但候选池错（比如 code 模式仍带 repo 池）
//   在用户侧就是"多跑一轮、结果里混进仓库条目"，而 `queryType` 一个字都不差 —— 只看前者分不开。
import test from 'node:test';
import assert from 'node:assert/strict';
import { runPlanner } from './lib/cli-replay.mjs';

// 三个池的**契约**（与 `query-planner.ps1` 里的三个数组同义）。
// 加引擎 = 改契约：这里要一起改。故意不用"从源码正则数个数"那种派生法 ——
// 派生能让门永远绿（源码改了门自己跟着改），而本门要钉的是"用户这次会打哪些源"。
const REPO = ['GitHub', 'Gitee', 'GitLab', 'Codeberg'];
const CODE = ['GitHubCode', 'GitLabBlobs', 'GrepApp', 'SEExcerpts', 'Sourcegraph'];
const RESEARCH = ['HF', 'Npm', 'Crates', 'Maven', 'RubyGems', 'NuGet', 'Packagist', 'DockerHub', 'arXiv', 'OpenAlex', 'MCPRegistry', 'HackerNews', 'SE', 'DeepSeek'];
const POOLS = {
  repository_only: REPO,
  code_evidence_only: CODE,
  research_only: RESEARCH,
  integrated_research_and_code: [...REPO, ...CODE, ...RESEARCH],
};

async function plan(query) {
  const r = await runPlanner(query);
  assert.ok(r.plan, `规划器没吐 JSON（rc=${r.status}）：` + String(r.stdout).slice(-400) + String(r.stderr).slice(-400));
  return r.plan;
}

/** 断言"判词 + 候选池"两件事，并把两者的一致性也钉住 */
function expectPlan(p, mode, label) {
  assert.equal(p.queryType, mode, `${label}：判词；实际 ${p.queryType}（confidence=${p.confidence}）`);
  assert.deepEqual(
    [...p.engineCandidates].sort(),
    [...POOLS[mode]].sort(),
    `${label}：候选池必须正好是 ${mode} 的那一组（多一个 = 多打一个源，少一个 = 静默少查）`
  );
  // 负控：判词与候选池不许"各自对、彼此不对"。上面两条已经蕴含，但这条在**错配**时给出更直白的理由。
  for (const [other, pool] of Object.entries(POOLS)) {
    if (other === mode) continue;
    const foreign = pool.filter((x) => !POOLS[mode].includes(x));
    for (const name of foreign) {
      assert.ok(!p.engineCandidates.includes(name),
        `${label}：判成 ${mode} 却带了 ${other} 的候选 ${name} —— 判词与候选池打架`);
    }
  }
}

test('U-288-A 工程信号词：调研 + 技能/CI/分发 ⇒ integrated（不是只查资料）', async () => {
  // 病灶（v1.2.0 P1-9）：「调研 技能 CI 分发」曾判 research_only ⇒ 只打资料源，
  //   而用户问的是"技能怎么发出去"——repo 池与 code 池压根不跑。
  // 变异检验（**实测过的，不是推断**）：把 $engineeringTerms 里的「技能 / 分发 / CI」**三个全删** ⇒
  //   本臂变 research_only（实测）；只删其中一个则**仍绿** —— 这句话是某句查询里三个词互为兜底的事实，
  //   第一版注释写成"删任一即红"是错的，已按实测改正。
  expectPlan(await plan('调研 技能 CI 分发'), 'integrated_research_and_code', '技能/CI/分发');
});

test('U-288-B 单字「类」的误伤：找类似项目 / 同类开源项目 ⇒ repository_only', async () => {
  // code 词表含单字「类」(class)。匹配前必须先剔除「类似」「同类」，否则这两句会命中 code
  //   ⇒ 判成 code_evidence_only（用户想找项目，却拿到代码片段）。
  // 变异检验：把 `.Replace((U '类似'), '').Replace((U '同类'), '')` 去掉，两臂都会红。
  expectPlan(await plan('找类似项目'), 'repository_only', '类似项目');
  expectPlan(await plan('同类开源项目'), 'repository_only', '同类开源项目');
});

test('U-288-C 动词原形：how to implement / implementing ⇒ code_evidence_only', async () => {
  // 病灶（v1.48.0 P2-2）：$codeTerms 只有名词 `implementation`，词边界匹配下
  //   "implement" / "implementing" 一个都不命中 ⇒ 判 research_only ⇒ 拿不到代码证据。
  // 变异检验：把 'implement', 'implementing' 从 $codeTerms 删掉，两臂变 research_only。
  expectPlan(await plan('how to implement binary search in go'), 'code_evidence_only', 'implement');
  expectPlan(await plan('implementing a rate limiter in rust'), 'code_evidence_only', 'implementing');
});

test('U-288-D 纯资料查询：官方文档 + 最佳实践 ⇒ research_only，且不许带 repo 候选', async () => {
  // 这一臂是 A/B/C 的**反向控制**：如果规划器把所有查询都判成前三种之一，上面几条也会绿。
  expectPlan(await plan('查官方文档和最佳实践'), 'research_only', '官方文档');
});
