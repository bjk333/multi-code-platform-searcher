// U-128（2026-09-28）：Relevance 精度 —— haystack 去 Url、整词匹配、词形归一（预注册：reports/U-128-预注册判据-2026-09-28.md）。
// 证据：reports/gates/u128-b8/{pre,post}-W1q2.json（真实 research 运行）、harness-post.json（离线 P2–P5）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceAll } from './lib/source.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mainSrc = sourceAll(path.join(rootDir));
const ev = f => JSON.parse(fs.readFileSync(path.join(rootDir, 'reports/gates/u128-b8', f), 'utf8').replace(/^\uFEFF/, ''));

function checkSource(src) {
  // ★2026-10-10 批次3 校准（两处失配，都属"门与实现长期不一致"，非放宽判据）：
  //   ① 范围：haystack 构造与 IDF 权重已从 `Set-UnifiedScore` 抽到前置助手 `Get-TermWeights`
  //      （拆分起因：Set-UnifiedScore 涨到 124 行触红 U-163-2）。取"评分区域"最早的那个锚点起算。
  //   ② 写法：本门原先钉的字面量 `$hay = "$($r.Name) $($r.Desc)".ToLower()` 早已不存在——
  //      U-169 把 `.ToLower()` 去掉了（改由 Normalize-MatchText 内部做，驼峰拆词必须在低化之前），
  //      且闭包内变量名是 `$h`（Name+Desc）与 `$hn`（归一后），不是 `$hay`/`$hayNorm`。
  //      ⇒ 原断言在基线即为假红，本门实际只剩 3 条生效，而失效的恰是"haystack 不含 Url"这条核心判据。
  //      现改为**显式负向断言**（比"匹配某个字面写法"更强，不会因变量改名再次静默失效）。
  const anchors = ['function Get-MaxPlatformPopularity {', 'function Get-TermWeights {', 'function Set-UnifiedScore {'];
  const starts = anchors.map(a => src.indexOf(a)).filter(i => i >= 0);
  const fn = src.slice(Math.min.apply(null, starts), src.indexOf('function Build-RagContext {'));
  assert.doesNotMatch(fn, /\$hay\.Contains\(/, 'substring Contains() matching must be gone');
  assert.match(fn, /\$h = "\$\(\$rr?\.Name\) \$\(\$rr?\.Desc\)"/, 'haystack must be built from Name + Desc');
  assert.doesNotMatch(fn, /\$h = [^\n]*\.(Url|File)\b/, 'haystack must be Name+Desc only (no Url/File)');
  assert.match(fn, /Test-WholeTermMatch -HayNorm \$\w+ -TermNorm \$kwTermsNorm\[\$ti\]/, 'keyword hits must use whole-term matching');
  assert.match(fn, /Test-WholeTermMatch -HayNorm \$\w+ -TermNorm \$focusTermsNorm\[\$fi\]/, 'FocusTerms must use the same matcher');
  assert.match(src, /function Normalize-MatchText[\s\S]*'isation\\z', 'ization'[\s\S]*function Test-WholeTermMatch[\s\S]*\(\?<!\[a-z0-9\]\)/, 'normaliser + boundary primitives');
}

test('U-128: Set-UnifiedScore matches whole normalised terms over Name+Desc (Url excluded)', () => checkSource(mainSrc));

test('U-128 offline harness (P2–P5): spelling/plural normalise, substring and url-only hits are gone, whole-word hits are kept', () => {
  const h = Object.fromEntries(ev('harness-post.json').map(x => [x.Id, x]));
  assert.equal(h['P3-spelling-plural'].Relevance, 1.0);           // serialisation benchmarks ⇐ serialization benchmark
  assert.deepEqual(h['P3-spelling-plural'].MatchTerms, ['serialization', 'benchmark']);
  assert.equal(h['P3b-reverse'].Relevance, 1.0);                  // serialization ⇐ serialisation
  assert.equal(h['P4-substring'].Relevance, 0.0);                 // "unicode" must not hit 'code'
  assert.deepEqual(h['P4-substring'].MatchTerms, []);
  assert.equal(h['P5-url-only'].Relevance, 0.0);                  // term only in Url ⇒ no relevance
  assert.equal(h['P2-wholeword-keeps'].Relevance, 1.0);
});

test('U-128 real pre/post (P1/P2): unicode-ident drops to Relevance 0 while whole-word hits do not lose relevance', () => {
  const pre = ev('pre-W1q2.json').results, post = ev('post-W1q2.json').results;
  const preU = pre.find(r => r.Name === 'unicode-ident'), postU = post.find(r => r.Name === 'unicode-ident');
  assert.ok(preU && preU.Relevance > 0, 'pre must show the false hit');
  if (postU) { assert.equal(postU.Relevance, 0); assert.deepEqual(postU.MatchTerms, []); }
  const byName = new Map(post.map(r => [r.Platform + '|' + r.Name, r]));
  for (const r of pre) {
    const p = byName.get(r.Platform + '|' + r.Name); if (!p) continue;
    const text = (r.Name + ' ' + (r.Desc || '')).toLowerCase();
    const wholeHits = r.MatchTerms.filter(t => new RegExp('(?<![a-z0-9])' + t + 's?(?![a-z0-9])').test(text));
    if (wholeHits.length === r.MatchTerms.length) assert.ok(p.Relevance >= r.Relevance - 1e-9, `${r.Name}: whole-word relevance must not drop (${r.Relevance} → ${p.Relevance})`);
  }
});

test('U-128 negative control: restoring substring Contains() matching is detected', () => {
  // ★2026-10-10 校准：变异目标原为 v1.37.x 的形态 `{ $hitTerms += $kwTerms[$ti] } }`——
  //   v1.38.0 引入 IDF 后在体内加了 `; $hitIdf += $idfArr[$ti]`，目标串不再存在 ⇒ replace 空转
  //   ⇒ `assert.notEqual` 先失败（本负例在基线即为假红）。改用当前真实文本，
  //   且变异体仍注入 `$hay.Contains(` —— 那是本门 L15 的核心负例信号。
  const mutated = mainSrc.replace(
    'if (Test-WholeTermMatch -HayNorm $hayNorm -TermNorm $kwTermsNorm[$ti]) { $hitTerms += $kwTerms[$ti]; $hitIdf += $idfArr[$ti] }',
    'if ($hay.Contains($kwTerms[$ti])) { $hitTerms += $kwTerms[$ti]; $hitIdf += $idfArr[$ti] }');
  assert.notEqual(mutated, mainSrc);
  assert.throws(() => checkSource(mutated), assert.AssertionError);
});
