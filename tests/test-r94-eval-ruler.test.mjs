// R94（远端 R1，2026-09-30）：评测标尺门 —— A 可复现骨架 / B 指标 / C 公平三指标 + ScoreParts / D 实体键 / E 端点生命周期 / F 可观测三元组。
// 判据来源：reports/任务书-远端3轮-R94-R97-v2-2026-09-30.md §R94 A–F + reports/派工-R94-可验证评测口径-2026-09-30.md。
// 有效性（§〇-8）：每个 PS 纯函数都在同一 pwsh 进程里做源内变异（tests/r94-ps-probe.mjs），每个 mutant 必须被本门杀死；静态断言另附源码变异负例。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { rootDir, probeWithMutants, assertMutantsKilled } from './r94-ps-probe.mjs';
import { sourceAll } from './lib/source.mjs';

const read = p => fs.readFileSync(path.join(rootDir, p), 'utf8').replace(/^\uFEFF/, '');
const mainSrc = sourceAll(rootDir);   // v1.54.0（B3-2）：读加载后视图
const qrelsPath = path.join(rootDir, 'evals/qrels-r94.json');
const qrels = JSON.parse(read('evals/qrels-r94.json'));

// ---------- JS 参考实现（与 PS 独立实现互证；口径写死：指数增益 2^rel−1，折扣 log2(i+1)，IDCG=0 ⇒ null） ----------
export function ndcgRef(gains, k, mode = 'exponential', ideal = gains) {
  const g = r => (mode === 'linear' ? r : 2 ** r - 1);
  const dcg = xs => xs.slice(0, k).reduce((a, r, i) => a + g(r) / Math.log2(i + 2), 0);
  const idcg = dcg([...ideal].sort((a, b) => b - a));
  return idcg <= 0 ? null : +(dcg(gains) / idcg).toFixed(6);
}
const pAtK = (rel, k) => +(rel.slice(0, k).filter(Boolean).length / k).toFixed(6);
const rr = rel => { const i = rel.findIndex(Boolean); return i < 0 ? 0 : +(1 / (i + 1)).toFixed(6); };
export function perSourceRef(ranked, k) {
  const best = {}, act = {}, rs = {}; let vT = 0, rT = 0;
  ranked.forEach((it, i) => {
    const v = 1 / Math.log2(Math.max(i + 1, 2));
    if (!(it.Source in best)) { best[it.Source] = null; act[it.Source] = 0; rs[it.Source] = 0; }
    if (it.Rel > 0 && best[it.Source] === null) best[it.Source] = i + 1;
    act[it.Source] += v; rs[it.Source] += it.Rel; vT += v; rT += it.Rel;
  });
  const withRel = Object.keys(best).filter(s => best[s] !== null);
  const share = withRel.length ? +(withRel.filter(s => best[s] <= k).length / withRel.length).toFixed(6) : null;
  const delta = rT > 0 ? +Object.keys(best).reduce((a, s) => a + Math.abs(act[s] / vT - rs[s] / rT), 0).toFixed(6) : null;
  return { best, share, delta };
}
// 分桶报告的结构判据（负例：合并成单一均值 ⇒ 红）
export function assertBucketed(report, sources) {
  assert.ok(report && report.Buckets && typeof report.Buckets === 'object', 'report must carry per-source Buckets (single aggregate forbidden)');
  assert.deepEqual(Object.keys(report.Buckets).sort(), [...sources].sort(), 'one bucket per source with results');
  assert.ok(report.Overall && report.Overall.Aggregate === 'micro-reference', 'overall must be labelled micro-reference, not the verdict');
  for (const [s, b] of Object.entries(report.Buckets)) {
    assert.ok(b.NdcgAtK === null || Number.isFinite(b.NdcgAtK), `bucket ${s}: nDCG must be finite or null (IDCG=0), never NaN`);
    if (b.NdcgAtK === null) assert.ok(report.ExcludedFromNdcgMean.includes(s), `bucket ${s}: IDCG=0 must be listed as excluded`);
  }
}

const PROBE = String.raw`
$fx = @(
  [pscustomobject]@{ Name = 'foo/bar'; Platform = 'GitHub'; Url = 'https://github.com/Foo/Bar.git' },
  [pscustomobject]@{ Name = 'foo/bar'; Platform = 'Gitee';  Url = 'https://gitee.com/foo/bar' },
  [pscustomobject]@{ Name = 'baz/bar'; Platform = 'GitHub'; Url = 'https://github.com/baz/bar' },
  [pscustomobject]@{ Name = 'Group/Sub/Proj'; Platform = 'GitLab'; Url = 'https://gitlab.com/Group/Sub/Proj' },
  [pscustomobject]@{ Name = 'left-pad'; Platform = 'npm'; Url = 'https://www.npmjs.com/package/left-pad' })
$pool = Merge-EntityPool -Results $fx
$ranked = @(
  [pscustomobject]@{ Source = 'a'; Rel = 2; Stars = 900 }, [pscustomobject]@{ Source = 'b'; Rel = 0; Stars = 5 },
  [pscustomobject]@{ Source = 'a'; Rel = 1; Stars = 800 }, [pscustomobject]@{ Source = 'c'; Rel = 2; Stars = 0 },
  [pscustomobject]@{ Source = 'b'; Rel = 1; Stars = 1 },  [pscustomobject]@{ Source = 'c'; Rel = 0; Stars = 0 },
  [pscustomobject]@{ Source = 'd'; Rel = 0; Stars = 99999 })
$now = [datetime]::SpecifyKind([datetime]'2026-09-30T00:00:00', 'Utc')
$q = [System.IO.File]::ReadAllText('${qrelsPath.replace(/'/g, "''")}') | ConvertFrom-Json
[ordered]@{
  keys = [ordered]@{
    gh = (Get-CanonicalRepoKey -Url 'https://github.com/Foo_Bar/My.Repo.git')
    gitee = (Get-CanonicalRepoKey -Url 'https://gitee.com/foo-bar/my-repo')
    glNested = (Get-CanonicalRepoKey -Url 'https://gitlab.com/Group/Sub/Proj/-/blob/main/a.py')
    sgCode = (Get-CanonicalRepoKey -Url 'https://sourcegraph.com/github.com/foo/bar/-/blob/x.go')
    ghBlob = (Get-CanonicalRepoKey -Url 'https://github.com/foo/bar/blob/main/src/x.py')
    npm = (Get-CanonicalRepoKey -Url 'https://www.npmjs.com/package/@a/b' -Name '@a/b')
    hf = (Get-CanonicalRepoKey -Url 'https://huggingface.co/foo/bar' -Name 'foo/bar')
    nameWide = (Get-CanonicalRepoKey -Url '' -Name ('Ｆｏｏ/b' + [char]0x200B + 'ar'))
    ownerA = (Get-CanonicalRepoKey -Url 'https://github.com/alice/utils')
    ownerB = (Get-CanonicalRepoKey -Url 'https://github.com/bob/utils')
  }
  pool = [ordered]@{ keys = @($pool.Entities | ForEach-Object { $_.Key }); platforms = @($pool.Entities | ForEach-Object { $_.Platforms.Count }); evidence = @($pool.Entities | ForEach-Object { $_.Evidence.CrossHostEquivalence }); unkeyed = @($pool.Unkeyed).Count }
  ndcg = [ordered]@{ e = (Get-NdcgAtK -Gains @(3,2,0,1) -K 4); l = (Get-NdcgAtK -Gains @(3,2,0,1) -K 4 -GainMode linear); k2 = (Get-NdcgAtK -Gains @(0,2,1) -K 2); ideal = (Get-NdcgAtK -Gains @(1,0) -K 2 -IdealGains @(2,1,0)); zero = (Get-NdcgAtK -Gains @(0,0,0) -K 5) }
  p = (Get-PrecisionAtK -Relevant @($true,$false,$true) -K 5); rr = (Get-ReciprocalRank -Relevant @($false,$false,$true)); rr0 = (Get-ReciprocalRank -Relevant @($false))
  sc = (Get-SourceCoverageAtK -Ranked $ranked -Sources @('a','b','c','d') -K 3)
  sc2 = (Get-SourceCoverageAtK -Ranked $ranked -Sources @('a','b') -K 5)
  pb = (Apply-PerSourceBest -Ranked $ranked -K 3)
  pin = [ordered]@{ sha = (Test-PinnedRevision ('0123456789abcdef0123456789abcdef01234567')).Ok; main = (Test-PinnedRevision 'main').Ok; master = (Test-PinnedRevision 'master').Ok; empty = (Test-PinnedRevision '').Ok; short = (Test-PinnedRevision 'abc1234').Ok; upper = (Test-PinnedRevision ('0123456789ABCDEF0123456789ABCDEF01234567')).Ok }
  life = [ordered]@{
    passed = (Get-EndpointLifecycle -Deprecation '@1767225600' -Sunset 'Sun, 27 Sep 2026 00:00:00 GMT' -Now $now)
    sched = (Get-EndpointLifecycle -Deprecation 'true' -Sunset 'Sun, 01 Nov 2026 00:00:00 GMT' -Now $now)
    dep = (Get-EndpointLifecycle -Deprecation '@1767225600' -Sunset '' -Now $now)
    none = (Get-EndpointLifecycle -Deprecation '' -Sunset '' -Now $now) }
  span = [ordered]@{ fullZero = (Get-SpanStatus -Verdict 'full' -ResultCount 0); full = (Get-SpanStatus -Verdict 'full' -ResultCount 3); partial = (Get-SpanStatus -Verdict 'partial' -ResultCount 0); degraded = (Get-SpanStatus -Verdict 'degraded' -ResultCount 0); none = (Get-SpanStatus -Verdict 'none' -ResultCount 0); noEngines = (Get-SpanStatus -Verdict 'no-engines' -ResultCount 0) }
  parts = (Get-ScoreParts -Relevance 0.5 -Popularity 1 -Updated '2025-09-30T00:00:00Z' -Now $now)
  partsNull = (Get-ScoreParts -Relevance 0.5 -Popularity 0 -Updated $null -Now $now)
  bucket = (Get-BucketedEvalReport -Items @($q.items) -Sources @($q.sources_with_results) -K 5)
}
`;

const RANKED = [
  { Source: 'a', Rel: 2 }, { Source: 'b', Rel: 0 }, { Source: 'a', Rel: 1 }, { Source: 'c', Rel: 2 },
  { Source: 'b', Rel: 1 }, { Source: 'c', Rel: 0 }, { Source: 'd', Rel: 0 }];

function checkReal(o) {
  // D：实体键
  assert.equal(o.keys.gh, 'foo-bar/my-repo'); assert.equal(o.keys.gitee, 'foo-bar/my-repo', 'fold [-_.]+ and drop .git ⇒ same key across hosts');
  assert.equal(o.keys.glNested, 'group/sub/proj', 'GitLab keeps the full nested namespace');
  assert.equal(o.keys.sgCode, 'foo/bar'); assert.equal(o.keys.ghBlob, 'foo/bar');
  assert.equal(o.keys.npm, null, 'non-forge hosts are not repo identities'); assert.equal(o.keys.hf, null);
  assert.equal(o.keys.nameWide, 'foo/bar', 'NFKC (full-width) + zero-width strip');
  assert.notEqual(o.keys.ownerA, o.keys.ownerB, 'two different owners with the same repo name must NOT merge');
  assert.deepEqual(o.pool.keys, ['foo/bar', 'baz/bar', 'group/sub/proj']);
  assert.deepEqual(o.pool.platforms, [2, 1, 1]); assert.deepEqual(o.pool.evidence, ['unverified', 'n/a', 'n/a'], 'cross-host merge is only a candidate');
  assert.equal(o.pool.unkeyed, 1);
  // B：指标 vs JS 参考
  assert.equal(o.ndcg.e, ndcgRef([3, 2, 0, 1], 4)); assert.equal(o.ndcg.l, ndcgRef([3, 2, 0, 1], 4, 'linear'));
  assert.equal(o.ndcg.k2, ndcgRef([0, 2, 1], 2)); assert.equal(o.ndcg.ideal, ndcgRef([1, 0], 2, 'exponential', [2, 1, 0]));
  assert.equal(o.ndcg.zero, null, 'IDCG@k=0 must be null (excluded), never NaN or a silent 1');
  assert.equal(o.p, pAtK([true, false, true], 5)); assert.equal(o.rr, rr([false, false, true])); assert.equal(o.rr0, 0);
  // C：公平三指标
  assert.deepEqual([o.sc.Covered, o.sc.Total, o.sc.Value, o.sc.Threshold, o.sc.Pass], [2, 4, 0.5, 0.75, false]);
  assert.deepEqual([o.sc2.Covered, o.sc2.Threshold, o.sc2.Pass], [2, 1, true]);
  const ref = perSourceRef(RANKED, 3);
  assert.deepEqual(o.pb.BestRank, ref.best); assert.equal(o.pb.ShareBestWithinK, ref.share); assert.equal(o.pb.ExposureDelta, ref.delta);
  // A：revision 钉死
  assert.deepEqual(o.pin, { sha: true, main: false, master: false, empty: false, short: false, upper: false });
  // E：生命周期
  assert.equal(o.life.passed.State, 'sunset-passed'); assert.equal(o.life.passed.DaysLeft, -3); assert.equal(o.life.passed.Deprecated, true);
  assert.equal(o.life.sched.State, 'sunset-scheduled'); assert.equal(o.life.sched.DaysLeft, 32);
  assert.equal(o.life.dep.State, 'deprecated'); assert.equal(o.life.none.State, 'active');
  // F：零结果 = unset
  assert.deepEqual(o.span, { fullZero: 'unset', full: 'unset', partial: 'unset', degraded: 'unset', none: 'error', noEngines: 'unset' });
  // C：ScoreParts
  assert.deepEqual(o.parts, { relevance: 0.5, popularity: 1, recency: +Math.exp(-365 / 365).toFixed(3) });
  assert.equal(o.partsNull.recency, null);
  // A：分桶报告（qrels 冻结快照）
  assertBucketed(o.bucket, qrels.sources_with_results);
  for (const s of qrels.sources_with_results) {
    const mine = qrels.items.filter(i => i.source === s).sort((a, b) => a.rank - b.rank);
    const b = o.bucket.Buckets[s];
    assert.equal(b.N, mine.length); assert.equal(b.PAtK, pAtK(mine.map(i => i.rel > 0), 5));
    assert.equal(b.NdcgAtK, ndcgRef(mine.map(i => i.rel), 5), 'bucket nDCG ' + s); assert.equal(b.RR, rr(mine.map(i => i.rel > 0)));
  }
  const all = [...qrels.items].sort((a, b) => a.rank - b.rank);
  const fr = perSourceRef(all.map(i => ({ Source: i.source, Rel: i.rel })), 5);
  assert.equal(o.bucket.Fairness.PerSourceBest.ExposureDelta, fr.delta);
}

let cache = null;
async function probe() {
  if (cache) return cache;
  cache = await probeWithMutants(PROBE, [
    { name: 'ndcg-discount', fn: 'Get-NdcgAtK', find: '[math]::Log($i + 2, 2)', replace: '[math]::Log($i + 3, 2)' },
    { name: 'ndcg-silent-1', fn: 'Get-NdcgAtK', find: 'if ($idcg -le 0) { return $null }', replace: 'if ($idcg -le 0) { return 1.0 }' },
    { name: 'ndcg-no-ideal-sort', fn: 'Get-NdcgAtK', find: '$ideal = @($IdealGains | Sort-Object -Descending)', replace: '$ideal = @($IdealGains)' },
    { name: 'p-denominator', fn: 'Get-PrecisionAtK', find: '$hits / [double]$K', replace: '$hits / [double][math]::Max(1, @($Relevant).Count)' },
    { name: 'sc-threshold-no-min', fn: 'Get-SourceCoverageAtK', find: '[math]::Min($n, $K)', replace: '$n' },
    { name: 'fair-star-weight', fn: 'Apply-PerSourceBest', find: '$rel = [double]$items[$i].Rel', replace: '$rel = [double]$items[$i].Rel * (1 + [double]$items[$i].Stars)' },
    { name: 'fair-exposure', fn: 'Apply-PerSourceBest', find: '[math]::Max($i + 1, 2)', replace: '($i + 2)' },
    { name: 'key-keep-git', fn: 'Get-CanonicalRepoKey', find: "-replace '(?i)\\.git$', ''", replace: "-replace 'NOPE$', ''" },
    { name: 'key-name-only', fn: 'Get-CanonicalRepoKey', find: "return ($out -join '/')", replace: 'return $out[$out.Count - 1]' },
    { name: 'key-gitlab-2seg', fn: 'Get-CanonicalRepoKey', find: "$host0 -notmatch 'gitlab' -and $segs.Count -gt 2", replace: '$segs.Count -gt 2' },
    { name: 'key-no-nfkc', fn: 'Get-DedupKey', find: '$t = $t.Normalize([System.Text.NormalizationForm]::FormKC)', replace: '$t = $t' },
    { name: 'pool-claims-verified', fn: 'Merge-EntityPool', find: "{ 'unverified' }", replace: "{ 'verified' }" },
    { name: 'pin-accepts-branch', fn: 'Test-PinnedRevision', find: "-cmatch '^[0-9a-f]{40}$'", replace: "-match '^[0-9a-zA-Z]+$'" },
    { name: 'span-zero-is-error', fn: 'Get-SpanStatus', find: "if ($Verdict -eq 'none')", replace: "if ($Verdict -eq 'none' -or $ResultCount -eq 0)" },
    { name: 'life-no-sunset-parse', fn: 'Get-EndpointLifecycle', find: '$sun = & $parse $Sunset', replace: '$sun = $null' },
    { name: 'life-inverted', fn: 'Get-EndpointLifecycle', find: '$Now -ge $sun', replace: '$Now -lt $sun' },
    { name: 'bucket-single-mean', fn: 'Get-BucketedEvalReport', find: 'foreach ($s in $Sources) {', replace: 'foreach ($s in @($Sources[0])) {' },
    { name: 'parts-recency-linear', fn: 'Get-ScoreParts', find: '[math]::Exp(-$age / 365.0)', replace: '(1 - $age / 3650.0)' },
  ]);
  return cache;
}

test('R94 A–F: pure functions agree with independent JS references on fixed fixtures (keys / nDCG / P@k / MRR / SC@k / bestRank / Δ / pin / lifecycle / span / ScoreParts / buckets)', async () => {
  const r = await probe();
  checkReal(r.real);
  const b = r.real.bucket;
  console.log('[R94 readings qrels] ' + Object.entries(b.Buckets).map(([s, x]) => `${s}:n=${x.N},P@5=${x.PAtK},nDCG@5=${x.NdcgAtK ?? 'excluded'},RR=${x.RR}`).join(' | ') +
    ` || macro-nDCG(included)=${b.MacroNdcgOverIncluded} excluded=[${b.ExcludedFromNdcgMean}] SC@5=${b.Fairness.SourceCoverage.Value}/${b.Fairness.SourceCoverage.Threshold} bestRank<=5 share=${b.Fairness.PerSourceBest.ShareBestWithinK} delta=${b.Fairness.PerSourceBest.ExposureDelta}`);
});

test('R94 mutation: every injected bug in the new PS pure functions turns this gate red (no survivors, no unapplied mutants)', async () => {
  const r = await probe();
  const tally = assertMutantsKilled(r, v => checkReal(v));
  assert.equal(tally.killed.length, 18);
});

// ---------- 静态：接线与禁用信号 ----------
function fnBody(src, name) {
  const at = src.indexOf('function ' + name + ' {');
  assert.ok(at >= 0, 'function missing: ' + name);
  const next = src.indexOf('\nfunction ', at + 10);
  return src.slice(at, next < 0 ? undefined : next);
}
export function assertWiring(src) {
  for (const f of ['Get-SourceCoverageAtK', 'Apply-PerSourceBest', 'Get-NdcgAtK', 'Get-BucketedEvalReport'])
    assert.doesNotMatch(fnBody(src, f).replace(/^\s*#.*$/gm, ''), /Stars|Popularity|ApiScore/, `${f}: star/popularity must not weight sources`);
  assert.match(fnBody(src, 'Set-UnifiedScore'), /NotePropertyName ScoreParts -NotePropertyValue \(Get-ScoreParts -Relevance \$relevance -Popularity \$popularity/, 'ScoreParts must be attached from the same relevance/popularity');
  assert.match(src, /NotePropertyName EntityKey -NotePropertyValue \(Get-CanonicalRepoKey /, 'EntityKey annotation missing');
  assert.match(src, /Deprecation = \(Get-HeaderValue -Headers \$ghProbe\.Headers -Name 'Deprecation'\); Sunset = \(Get-HeaderValue -Headers \$ghProbe\.Headers -Name 'Sunset'\)/, 'Doctor must parse Deprecation/Sunset headers');
  assert.match(src, /Get-EndpointLifecycle -Deprecation \$ghCodeDeprecation\.Deprecation -Sunset \$ghCodeDeprecation\.Sunset/, 'Doctor must derive lifecycle from the parsed headers');
  // U-256（B1-6）：Requests 语义由"延迟袋条数"改为 **attempted**（含传输失败与 node 兜底），
  //   并新增 Succeeded/Failed；旧的"延迟袋条数"改名为 RequestsReturned 保留一个版本。
  //   ★这里断的是**恒等式的来源**：四个字段必须都从同一本账派生，否则 `Requests = Succeeded + Failed` 只是巧合。
  assert.match(src, /Requests\s+= \$reqStats\.Attempted\n\s+RequestsSucceeded\s+= \$reqStats\.Succeeded\n\s+RequestsFailed\s+= \[Math\]::Max\(0, \$reqStats\.Attempted - \$reqStats\.Succeeded\)\n\s+RequestsReturned\s+= \$requestsN\n\s+Tokens\s+= \$null.*\n\s+SpanStatus\s+= \(Get-SpanStatus -Verdict \$coverage\.Verdict -ResultCount \$allResults\.Count\)/, 'metrics accounting wiring (U-256)');
  assert.match(src, /if \(\$bag\) \{ \$requestsN = \[int\]\$bag\.Count \}/, 'RequestsReturned/P95 must still come from the shared per-request latency bag');
}
test('R94 static: fairness functions never read Stars/Popularity/ApiScore; ScoreParts / EntityKey / lifecycle / metrics triple are wired', () => {
  assertWiring(mainSrc);
});
test('R94 static negative controls: star-weighting, dropped header parsing, and zero-result-as-error wiring are each reported', () => {
  const m1 = mainSrc.replace('$rel = [double]$items[$i].Rel', '$rel = [double]$items[$i].Rel * [double]$items[$i].Stars');
  assert.notEqual(m1, mainSrc); assert.throws(() => assertWiring(m1), /Apply-PerSourceBest: star\/popularity/);
  const m2 = mainSrc.replace("Sunset = (Get-HeaderValue -Headers $ghProbe.Headers -Name 'Sunset')", 'Sunset = $null');
  assert.notEqual(m2, mainSrc); assert.throws(() => assertWiring(m2), /parse Deprecation\/Sunset/);
  const m3 = mainSrc.replace('(Get-SpanStatus -Verdict $coverage.Verdict -ResultCount $allResults.Count)', "$(if ($allResults.Count -eq 0) { 'error' } else { 'unset' })");
  assert.notEqual(m3, mainSrc); assert.throws(() => assertWiring(m3), /metrics accounting/);   // U-256：断言消息由 'metrics triple' 改为 'metrics accounting wiring'
});

// ---------- A：run-evals 表头 ----------
export function assertEvalHeader(src) {
  assert.match(src, /^param\(\[string\]\$Revision = ''\)/m, 'run-evals must accept -Revision');
  assert.match(src, /Test-PinnedRevision -Revision \$Revision/, 'run-evals must validate the revision');
  assert.match(src, /> revision：/, 'report header must carry revision');
  assert.match(src, /judgments_sha256：\$judgmentsSha/, 'report header must carry judgments_sha256');
  assert.match(src, /Result = if \(\$pin\.Ok\) \{ 'PASS' \} else \{ 'FAIL' \}/, 'unpinned revision must FAIL, not SKIP');
}
test('R94-A: evals/run-evals.ps1 header carries revision + judgments_sha256 and fails closed on an unpinned revision', () => {
  const src = read('evals/run-evals.ps1');
  assertEvalHeader(src);
  assert.throws(() => assertEvalHeader(src.replace("Result = if ($pin.Ok) { 'PASS' } else { 'FAIL' }", "Result = if ($pin.Ok) { 'PASS' } else { 'SKIP' }")), /must FAIL/);
  assert.throws(() => assertEvalHeader(src.replace('judgments_sha256：$judgmentsSha', '')), /judgments_sha256/);
});

// ---------- A 负例：合并单一均值 ⇒ 红（结构判据本身的负例） ----------
test('R94-A negative: a report collapsed into a single mean (no buckets) or with NaN is rejected by name', () => {
  assert.throws(() => assertBucketed({ Overall: { Aggregate: 'micro-reference', PAtK: 0.4 } }, ['a', 'b']), /per-source Buckets/);
  assert.throws(() => assertBucketed({ Buckets: { all: { NdcgAtK: 0.5 } }, Overall: { Aggregate: 'micro-reference' }, ExcludedFromNdcgMean: [] }, ['a', 'b']), /one bucket per source/);
  assert.throws(() => assertBucketed({ Buckets: { a: { NdcgAtK: NaN }, b: { NdcgAtK: 1 } }, Overall: { Aggregate: 'micro-reference' }, ExcludedFromNdcgMean: [] }, ['a', 'b']), /never NaN/);
});

// ---------- F / C：真实样本（reports/gates/u89-real-asjson.json）上的读数 ----------
test('R94 F/C on the real -AsJson sample: SpanStatus stays unset despite zero-hit engines; ScoreParts mirror Relevance/Popularity; popularity inversions are reported (annotation only)', () => {
  const s = JSON.parse(read('reports/gates/u89-real-asjson.json'));
  assert.equal(s.metrics.SpanStatus, s.coverage.Verdict === 'none' ? 'error' : 'unset');
  assert.ok(Number.isInteger(s.metrics.Requests) && s.metrics.Requests >= 0); assert.equal(s.metrics.Tokens, null);
  for (const r of s.results) { assert.equal(r.ScoreParts.relevance, r.Relevance); assert.equal(r.ScoreParts.popularity, r.Popularity); }
  let inv = 0; for (let i = 1; i < s.results.length; i++) if (s.results[i].Relevance > s.results[i - 1].Relevance) inv++;
  const zeroHit = Object.values(s.coverage.ReasonCodes).filter(c => c === 'zero-hit').length;
  console.log(`[R94 readings sample] results=${s.results.length} requests=${s.metrics.Requests} zero-hit engines=${zeroHit} span=${s.metrics.SpanStatus} adjacent popularity-inversions=${inv}`);
});
