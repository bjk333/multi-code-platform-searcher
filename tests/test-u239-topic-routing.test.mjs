// U-239（v1.53.22 主题词路由）：**已知技术主题不该只查资料**。
//   病灶（v1.53.16 记录、v1.53.21 复现）：`-Auto "向量数据库"` / "分布式锁" / "中文分词" 全落 research_only
//   ⇒ repo 池压根不跑，而主脚本的 ZhTopicTermMap 已能把它们映成 vector database / distributed lock。
//   修法（刻意收窄，四条同时成立才改判）：命中已知主题词 + 无研究专用信号 + 非提问/教程形状 + 无否定 ⇒ repository_only
//   （主脚本 Add-AutoResearchMode 追加 research ⇒ 实际 repo+research；不跑 code 池）。
// 本门守四件事：
//   A 词表**双向一致** —— planner 的 $topicTerms 与主脚本 ZhTopicTermMap 键集完全相同（各自加词会漂）；
//   B 分类真值表 —— 主题词查询改判、纯问题/无关/研究信号查询**不变**、code/selection 语义不被抢；
//   C 分支顺序与守卫 —— 必须在 hasSelection 之后、hasRepository 之前，且带 -not $hasResearch 与无否定；
//   D 负例 —— 词表漂一个词、真值表错一行都必须被点名。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPwsh, rootDir } from './r2-ps-run.mjs';
import { sourceAll } from './lib/source.mjs';

const root = rootDir;
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/^\uFEFF/, '');
const plannerSrc = read('query-planner.ps1');
const mainSrc = sourceAll(root);   // v1.54.0（B3-2）：读加载后视图

function mapKeys(src) {
  const start = src.indexOf('$script:ZhTopicTermMap = [ordered]@{');
  assert.ok(start > 0, '主脚本找不到 ZhTopicTermMap');
  const end = src.indexOf('\n}', start);
  assert.ok(end > start, 'ZhTopicTermMap 块未闭合');
  return [...src.slice(start, end).matchAll(/^\s+'([^']+)'\s*=/gm)].map(m => m[1]).sort();
}
function plannerKeys(src) {
  const start = src.indexOf('$topicTerms = @(');
  assert.ok(start > 0, 'planner 找不到 $topicTerms');
  const end = src.indexOf('\n)', start);
  assert.ok(end > start, '$topicTerms 块未闭合');
  return [...src.slice(start, end).matchAll(/\(U '((?:\\u[0-9a-fA-F]{4})+)'\)/g)]
    .map(m => JSON.parse('"' + m[1] + '"')).sort();
}

const MAIN_KEYS = mapKeys(mainSrc);
const PLAN_KEYS = plannerKeys(plannerSrc);

test('U-239 A: planner 主题词表与主脚本 ZhTopicTermMap 键集完全一致', () => {
  assert.ok(MAIN_KEYS.length >= 60, `主题词表只有 ${MAIN_KEYS.length} 条，派生值不可信`);
  assert.deepEqual(PLAN_KEYS, MAIN_KEYS, '两份词表不一致（多：' + PLAN_KEYS.filter(k => !MAIN_KEYS.includes(k)).join(',') +
    '；少：' + MAIN_KEYS.filter(k => !PLAN_KEYS.includes(k)).join(',') + '）');
});

// ---- 分类真值表：一次子进程跑完，避免 14 次启动开销 ----
const CASES = [
  // 已知中文主题：必须改判 repository_only（⇒ repo+research）
  ['向量数据库', 'repository_only'],
  ['分布式锁', 'repository_only'],
  ['中文分词', 'repository_only'],
  ['检索增强生成 RAG', 'repository_only'],
  ['微服务架构', 'repository_only'],
  // 提问/教程形状：即使命中主题词也不补 repo（问的是解释，不是项目）
  ['什么是向量数据库', 'research_only'],
  ['如何设计限流', 'research_only'],
  ['消息队列入门教程', 'research_only'],
  // 研究专用信号 ⇒ 保持 research_only（不得因主题词扩张）
  ['RAG 论文', 'research_only'],
  ['k8s 官方文档', 'research_only'],
  // 纯问题 / 无关查询 ⇒ 保持 research_only（U-158E 的"无关查询"口径）
  ['什么是 CAP 定理', 'research_only'],
  ['今天天气怎么样', 'research_only'],
  ['如何做红烧肉', 'research_only'],
  ['asdfghjkl zzzz', 'research_only'],
  ['不要找项目 只要文档', 'research_only'],
  // 既有语义不被抢
  ['tokio vs async-std', 'repository_only'],
  ['how to implement binary search in go', 'code_evidence_only'],
];

async function classify(queries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u239-'));
  const qf = path.join(dir, 'q.json');
  const rf = path.join(dir, 'r.json');
  fs.writeFileSync(qf, JSON.stringify(queries), 'utf8');
  const planner = path.join(root, 'query-planner.ps1');
  const ps = [
    // ★不要写成 @(Get-Content | ConvertFrom-Json)：PS 5.1 会把数组当成**单个**管道对象再包一层，
    //   循环只跑一次且 $q 变成整条数组（本门第一版就是这么假红的）。
    `$qs = Get-Content -LiteralPath '${qf}' -Raw -Encoding UTF8 | ConvertFrom-Json`,
    `$out = @()`,
    `foreach ($q in $qs) { $p = ((& '${planner}' -Query $q) | Out-String | ConvertFrom-Json); $out += [pscustomobject]@{ q = $q; t = $p.queryType; v = $p.plannerVersion } }`,
    `$out | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath '${rf}' -Encoding UTF8`,
  ].join('; ');
  // R2 卫生门：新文件只用异步 spawn（spawnSync 在本宿主会被垫片打成 EBUSY ⇒ rc=null ⇒ 假红）
  const r = await runPwsh(['-Command', ps], { timeoutMs: 120000 });
  assert.equal(typeof r.status, 'number', `planner 子进程没跑完（signal=${r.signal || '-'}）：${String(r.stderr || '').slice(0, 200)}`);
  assert.equal(r.status, 0, `planner 子进程 rc≠0：${String(r.stderr || '').slice(0, 300)}`);
  try {
    const rows = JSON.parse(fs.readFileSync(rf, 'utf8').replace(/^\uFEFF/, ''));
    return Array.isArray(rows) ? rows : [rows];
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function mismatches(rows, table) {
  const byQuery = new Map(rows.map(r => [r.q, r.t]));
  return table.filter(([q, want]) => byQuery.get(q) !== want)
    .map(([q, want]) => `${q}: 期望 ${want}，实际 ${byQuery.get(q)}`);
}

test('U-239 B: 分类真值表（主题词改判；问题/无关/研究信号/code/selection 语义不变）', async () => {
  const rows = await classify(CASES.map(([q]) => q));
  assert.deepEqual(mismatches(rows, CASES), []);
  const versions = [...new Set(rows.map(r => r.v))];
  assert.deepEqual(versions, ['1.5.0'], 'plannerVersion 应为 1.5.0');
});

test('U-239 C: 分支顺序与守卫（selection → topic → repository；topic 必须排除研究信号与提问形状）', () => {
  const idxSelection = plannerSrc.indexOf('elseif ($hasSelection');
  const idxTopic = plannerSrc.indexOf('elseif ($hasTopic');
  const idxRepository = plannerSrc.indexOf('elseif ($hasRepository)');
  assert.ok(idxSelection > 0 && idxTopic > 0 && idxRepository > 0);
  assert.ok(idxSelection < idxTopic, 'topic 分支必须在 selection 之后（选型语义优先）');
  assert.ok(idxTopic < idxRepository, 'topic 分支必须在 repository 之前');
  assert.match(plannerSrc, /elseif \(\$hasTopic -and -not \$hasResearch -and -not \$hasQuestion -and \$negations\.Count -eq 0\)/,
    'topic 分支必须同时要求「无研究信号」「非提问形状」「无否定」');
  const idxDef = plannerSrc.indexOf('$hasTopic = Has-Term $Query $topicTerms');
  assert.ok(idxDef > 0 && idxDef < idxTopic, '$hasTopic 必须先定义后使用');
  const idxQ = plannerSrc.indexOf('$hasQuestion = Has-Term $Query $questionTerms');
  assert.ok(idxQ > 0 && idxQ < idxTopic, '$hasQuestion 必须先定义后使用');
});

test('U-239 D: 模式映射支撑「repo+research」的文档口径', () => {
  assert.match(mainSrc, /'repository_only'\s*\{\s*return @\('repo'\)\s*\}/);
  const add = mainSrc.slice(mainSrc.indexOf('function Add-AutoResearchMode'), mainSrc.indexOf('function Get-AutoPlan'));
  assert.match(add, /\+ @\('research'\)/, 'Add-AutoResearchMode 必须追加 research（否则主题查询会丢掉资料池）');
});

test('U-239 负例: 词表漂一个词、真值表错一行都必须被点名', () => {
  assert.deepEqual(mismatches([{ q: '向量数据库', t: 'repository_only' }], [['向量数据库', 'repository_only']]), []);
  assert.equal(mismatches([{ q: '向量数据库', t: 'research_only' }], [['向量数据库', 'repository_only']]).length, 1);
  const drifted = plannerSrc.replace(/(U '\\u5411\\u91cf\\u6570\\u636e\\u5e93'\))/, "$1, (U '\\u5047\\u8bcd\\u6761')");
  assert.notEqual(drifted, plannerSrc, '变异必须命中词表');
  assert.deepEqual(plannerKeys(drifted).filter(k => !MAIN_KEYS.includes(k)), ['假词条']);
});
