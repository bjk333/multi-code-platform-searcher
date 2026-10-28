// U-224（v1.53.2，T2-6 残余）：403 的"替代源建议"必须指向**真实存在**的 code 引擎。
//
// 为什么要有这道门：
//   方案表（调研产物）写的是「建议替代（grep.app/searchcode）」—— 落地前核对注册表发现
//   `searchcode` 在本仓**不是独立 code 引擎**（它只作为 -RepoScope 的仓库级源出现）。
//   把建议写成不存在的引擎名，比不给建议更糟：Agent 会照着一个不存在的名字去改配置。
//   ⇒ 建议文案收敛成 `Cfg.CodeFallbackHint`（单一事实源），实体名由本门对着注册表逐个校验。
//
// 判据三层：
//   ① 格式：hint 必须形如「仍可查：A / B / C（…）」——门要能解析出实体名，纯散文无法校验；
//   ② 实体：每个名字必须 ∈ 注册表里 Kind='code' 的 Name；
//   ③ 接线：Sourcegraph 的三处 403 分支都必须引用该常量（不许各自硬编码一份，否则必然漂移）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sourceAll } from './lib/source.mjs';

const root = path.resolve(import.meta.dirname, '..');
const MAIN = sourceAll(path.join(root));
const ENGINE = fs.readFileSync(path.join(root, 'engines', 'sourcegraph.ps1'), 'utf8');

/** 从主脚本取 Cfg.CodeFallbackHint 的值。 */
function parseHint(src) {
  const m = /CodeFallbackHint\s*=\s*'((?:[^']|'')+)'/.exec(src);
  assert.ok(m, 'Cfg.CodeFallbackHint 必须存在（403 的替代建议只有这一份事实源）');
  return m[1];
}

/** 从 hint 解析出被推荐的引擎名（格式：「仍可查：A / B / C（…）」）。 */
function hintNames(hint) {
  const m = /仍可查：([^（(]+)[（(]/.exec(hint);
  assert.ok(m, 'hint 必须用「仍可查：A / B / C（…）」格式 —— 门要解析实体名，纯散文无法校验。实得：' + hint);
  return m[1].split('/').map((s) => s.trim()).filter(Boolean);
}

/** 注册表里 Kind='code' 的引擎名。 */
function codeEngineNames(src) {
  const out = [];
  for (const m of src.matchAll(/@\{\s*Name\s*=\s*'([^']+)';\s*Kind\s*=\s*'code'/g)) out.push(m[1]);
  return out;
}

test('U-224 A: 替代建议里的每个引擎名都必须真实存在于注册表（Kind=code）', () => {
  const hint = parseHint(MAIN);
  const names = hintNames(hint);
  const real = codeEngineNames(MAIN);
  assert.ok(real.length >= 5, '注册表 code 引擎应 ≥5，实得 ' + real.length);
  const ghosts = names.filter((n) => !real.includes(n));
  assert.deepEqual(ghosts, [],
    '★ 建议里出现不存在的 code 引擎：' + ghosts.join(',') +
    '（真实：' + real.join('/') + '）—— 照抄不存在的名字比不给建议更糟');
  assert.deepEqual(names.filter((n) => n === 'Sourcegraph'), [],
    '★ 不许建议 Sourcegraph 自己（它已经 403 失败了）');
  assert.ok(names.length >= 2, '至少给两个替代（只给一个等于没得选）');
});

test('U-224 B: Sourcegraph 三处 403 分支都引用同一常量（不许各自硬编码）', () => {
  const refs = (ENGINE.match(/-f \$script:Cfg\.CodeFallbackHint/g) || []).length;
  assert.equal(refs, 3, '403 的三个分支（Firewall Block / 匿名 / 带令牌）必须各引用一次，实得 ' + refs);
  // 反面：分支里不许再出现写死的引擎清单（出现即说明有人绕过常量又抄了一份）
  const hardcoded = /其他 code 源|仍可查：/.test(ENGINE.replace(/\$script:Cfg\.CodeFallbackHint/g, ''));
  assert.equal(hardcoded, false, '★ 引擎文件里不许写死替代清单 —— 必须只引用 Cfg.CodeFallbackHint');
});

test('U-224 C 负例（变异控制）：写错引擎名 / 少引用一处 —— 必须被点名', () => {
  // ① 把 hint 换成不存在的引擎名 ⇒ A 必红
  const ghost = MAIN.replace(
    "CodeFallbackHint = '本轮其他 code 源仍可查：GitHubCode / GrepApp / GitLabBlobs（-CodeEvidence 用法不变）'",
    "CodeFallbackHint = '本轮其他 code 源仍可查：GitHubCode / SearchCodeRepo / GitLabBlobs（-CodeEvidence 用法不变）'");
  assert.notEqual(ghost, MAIN, '变异必须真的改到 hint');
  assert.throws(() => {
    const h = parseHint(ghost);
    const ghosts = hintNames(h).filter((n) => !codeEngineNames(ghost).includes(n));
    assert.deepEqual(ghosts, [], '★ 建议里出现不存在的 code 引擎：' + ghosts.join(','));
  }, /不存在的 code 引擎/);

  // ② 某个分支不引用常量 ⇒ B 必红
  const missingRef = ENGINE.replace(
    "-Reason ('Sourcegraph 403（带 SRC_TOKEN）：令牌无该范围/已吊销，或出口 IP 被拦 —— 先换令牌，再换网络；{0}' -f $script:Cfg.CodeFallbackHint)",
    "-Reason 'Sourcegraph 403（带 SRC_TOKEN）：令牌无该范围/已吊销，或出口 IP 被拦 —— 先换令牌，再换网络'");
  assert.notEqual(missingRef, ENGINE, '变异必须真的改到分支');
  assert.equal((missingRef.match(/-f \$script:Cfg\.CodeFallbackHint/g) || []).length, 2,
    '★ 少引用一处必须能被计数抓到');
});
