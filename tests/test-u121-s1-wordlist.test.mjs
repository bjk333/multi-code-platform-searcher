// U-121（S1）低区分度词表 + U-113 MinStars 分档告警（2026-09-28）。
// 判据：词表含 serialization/benchmark（r61 撞词）；查询侧告警走 warnings[]（[query] 前缀）；高门槛 + 低区分度词 ⇒ U-113 警告；负例：去词/去守卫即红。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceAll } from './lib/source.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mainSrc = sourceAll(path.join(rootDir));

function wordList(src) {
  const m = src.match(/^\s*LowDiscriminationTerms\s*=\s*@\(([^)]*)\)/m);
  assert.ok(m, 'Cfg.LowDiscriminationTerms not found');
  return m[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
}
function checkS1(src) {
  const words = wordList(src);
  for (const w of ['marketplace', 'spec', 'standard', 'serialization', 'serialisation', 'benchmark']) assert.ok(words.includes(w), `S1 word list must contain '${w}'`);
  for (const w of words) assert.equal(w, w.toLowerCase(), `word list must be lowercase: ${w}`);
  assert.match(src, /Add-EngineWarning -Engine 'query' -Message \('低区分度词: \{0\}/, 'S1 hit must enter warnings[] with [query] prefix');
}
function checkU113(src) {
  assert.match(src, /^\s*MinStarsHighThreshold\s*=\s*\d+/m, 'Cfg.MinStarsHighThreshold missing');
  assert.match(src, /if \(\$minStarsTier -eq 'high' -and \$lowDiscTerms\.Count -gt 0\) \{\s*\n\s*Add-EngineWarning -Engine 'query' -Message \('MinStars=\{0\} 为高门槛档/, 'U-113 warning must require high tier AND low-discrimination hit');
}

test('U-121: S1 low-discrimination word list contains the round-2 collision words and feeds warnings[]', () => { checkS1(mainSrc); });
test('U-113: MinStars tiering warns only for high tier + low-discrimination keyword', () => { checkU113(mainSrc); });

test('U-121/U-113 recorded runs: warnings[] carries the [query] lines (and a clean query carries none)', () => {
  const dir = path.join(rootDir, 'reports/gates/u121-b1');
  const load = f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8').replace(/^\uFEFF/, ''));
  const hit = load('run-s1-high.json');      // "serialization benchmark" -MinStars 100
  assert.ok(hit.warnings.some(w => /^\[query\] 低区分度词: .*serialization/.test(w)), 'S1 warning missing');
  assert.ok(hit.warnings.some(w => /^\[query\] MinStars=100 为高门槛档/.test(w)), 'U-113 warning missing');
  const low = load('run-s1-minstars0.json'); // same keyword -MinStars 0 ⇒ S1 yes, U-113 no
  assert.ok(low.warnings.some(w => /^\[query\] 低区分度词/.test(w)));
  assert.ok(!low.warnings.some(w => /^\[query\] MinStars=/.test(w)), 'U-113 must not fire at MinStars 0');
  const clean = load('run-clean.json');      // "redis distributed lock" -MinStars 100 ⇒ neither
  assert.ok(!clean.warnings.some(w => /^\[query\]/.test(w)), 'clean keyword must not produce [query] warnings');
});

test('U-121/U-113 negative controls: dropping serialization from the list, or the low-discrimination guard, is detected', () => {
  const noWord = mainSrc.replace("'serialization',", '');
  assert.notEqual(noWord, mainSrc);
  assert.throws(() => checkS1(noWord), assert.AssertionError);
  const noGuard = mainSrc.replace("if ($minStarsTier -eq 'high' -and $lowDiscTerms.Count -gt 0) {", "if ($minStarsTier -eq 'high') {");
  assert.notEqual(noGuard, mainSrc);
  assert.throws(() => checkU113(noGuard), assert.AssertionError);
});
