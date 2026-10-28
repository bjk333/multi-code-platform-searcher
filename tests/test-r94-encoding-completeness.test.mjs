// R94 v2 新增维（远端 R1，2026-09-30）：G 编码正确性 + CJK 检索 / H 不完整要自曝。
// 判据来源：reports/任务书-远端3轮-R94-R97-v2-2026-09-30.md §G（≥4 条落成断言）、§H（截断却无 returned/total/omitted ⇒ 红）。
// fixture 由 Node 独立生成（TextDecoder 'windows-1252' 即 WHATWG 的 sloppy 映射；latin1 用 Buffer 'latin1'），与 PS 实现互证；每个 PS 纯函数做源内变异，mutant 必须被杀。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { rootDir, probeWithMutants, assertMutantsKilled } from './r94-ps-probe.mjs';

const read = p => fs.readFileSync(path.join(rootDir, p), 'utf8').replace(/^\uFEFF/, '');
const GOOD = '京东零售';
const MOJI_1252 = new TextDecoder('windows-1252').decode(Buffer.from(GOOD, 'utf8'));
const MOJI_LATIN1 = Buffer.from(GOOD, 'utf8').toString('latin1');
const psStr = s => '(-join @(' + [...s].map(c => `[char]0x${c.codePointAt(0).toString(16)}`).join(',') + '))';

const PROBE = String.raw`
[ordered]@{
  label = [ordered]@{ latin1 = (Resolve-EncodingLabel 'latin1'); iso = (Resolve-EncodingLabel 'ISO-8859-1'); ascii = (Resolve-EncodingLabel ' ascii '); gb2312 = (Resolve-EncodingLabel 'gb2312'); utf16 = (Resolve-EncodingLabel 'utf-16'); sjis = (Resolve-EncodingLabel 'MS932'); unknown = (Resolve-EncodingLabel 'klingon') }
  bomVsCt = (Resolve-TextEncoding -Bytes ([byte[]](0xFF,0xFE,0x41,0x00)) -ContentType 'text/plain; charset=utf-8')
  bomUtf8Json = (Resolve-TextEncoding -Bytes ([byte[]](0xEF,0xBB,0xBF,0x7B,0x7D)) -ContentType 'application/json; charset=iso-8859-1')
  jsonNoBom = (Resolve-TextEncoding -Bytes ([byte[]](0x7B,0x7D)) -ContentType 'application/vnd.api+json; charset=windows-1252')
  labelGb = (Resolve-TextEncoding -Bytes ([byte[]](0x41)) -ContentType 'text/html; charset="GB2312"')
  noHints = (Resolve-TextEncoding -Bytes ([byte[]](0x41)) -ContentType '')
  repair1252 = (Repair-Cp1252Mojibake -Text ${psStr(MOJI_1252)})
  repairGood = (Repair-Cp1252Mojibake -Text ${psStr(GOOD)})
  repairLatin1 = (Repair-Latin1Mojibake -Text ${psStr(MOJI_LATIN1)})
  repairAscii = (Repair-Cp1252Mojibake -Text 'plain ascii')
  bigrams = @(Get-CjkBigrams -Text ${psStr('我是中国人')})
  mixed = @(Get-CjkBigrams -Text ${psStr('Ｒｅｄｉｓ 分布式锁 lock 中')})
  mt = [ordered]@{ wide = (Normalize-MatchText -Text ${psStr('Ｒｅｄｉｓ分布式锁')}); kana = (Normalize-MatchText -Text ${psStr('ロック機構')}); hwKana = (Normalize-MatchText -Text ${psStr('ﾛｯｸ')}); hangul = (Normalize-MatchText -Text ${psStr('분산 락')}); extA = (Normalize-MatchText -Text ${psStr('\u3400字')}); en = (Normalize-MatchText -Text 'Organisations, APIs & caching'); hitMixed = (Test-WholeTermMatch -HayNorm (Normalize-MatchText -Text ${psStr('Redis 分布式锁实现')}) -TermNorm (Normalize-MatchText -Text ${psStr('redis分布式锁')})); hitKana = (Test-WholeTermMatch -HayNorm (Normalize-MatchText -Text ${psStr('分散ロックの実装')}) -TermNorm (Normalize-MatchText -Text ${psStr('ﾛｯｸ')})); noSub = (Test-WholeTermMatch -HayNorm (Normalize-MatchText -Text 'unicode ident') -TermNorm 'code') }
  dk = [ordered]@{ a = (Get-DedupKey 'File.txt'); b = (Get-DedupKey 'file.txt'); wide = (Get-DedupKey ${psStr('Ａ')}); zw = (Get-DedupKey ${psStr('a\u200Bb')}) }
  comp = [ordered]@{
    full = (New-CompletenessInfo -Returned 3 -Candidates 3 -PerSourceCount @{ GitHub = 2 } -PerSourceLimit 5 -ContextTopK 5)
    omitted = (New-CompletenessInfo -Returned 3 -Candidates 5 -PerSourceCount @{ GitHub = 2 } -PerSourceLimit 5 -ContextTopK 2)
    atLimit = (New-CompletenessInfo -Returned 5 -Candidates 5 -PerSourceCount @{ GitHub = 5; Gitee = 1 } -PerSourceLimit 5 -ContextTopK 5) }
}
`;

function checkReal(o) {
  // G-1 标签解析走 WHATWG label 表（不是按名字相等）
  assert.deepEqual(o.label, { latin1: 'windows-1252', iso: 'windows-1252', ascii: 'windows-1252', gb2312: 'gbk', utf16: 'utf-16le', sjis: 'shift_jis', unknown: null });
  // G-2 BOM 高于 Content-Type；JSON 缺 BOM 时按 RFC 8259 恒 UTF-8（忽略 charset 标签）
  assert.deepEqual([o.bomVsCt.Encoding, o.bomVsCt.Source, o.bomVsCt.BomLength], ['utf-16le', 'bom', 2]);
  assert.deepEqual([o.bomUtf8Json.Encoding, o.bomUtf8Json.Source], ['utf-8', 'bom']);
  assert.deepEqual([o.jsonNoBom.Encoding, o.jsonNoBom.Source], ['utf-8', 'json-rfc8259']);
  assert.deepEqual([o.labelGb.Encoding, o.labelGb.Source], ['gbk', 'label']);
  assert.deepEqual([o.noHints.Encoding, o.noHints.Source], ['utf-8', 'default']);
  // G-3 mojibake 往返（windows-1252 sloppy 路径 + 既有 Latin-1 路径），正确文本不被破坏
  assert.equal(o.repair1252, GOOD); assert.equal(o.repairGood, GOOD); assert.equal(o.repairLatin1, GOOD); assert.equal(o.repairAscii, 'plain ascii');
  // G-4 CJK bigram + 宽度归一
  assert.deepEqual(new Set(o.bigrams), new Set(['我是', '是中', '中国', '国人'])); assert.equal(o.bigrams.length, 4);
  assert.deepEqual(o.mixed, ['redis', '分布', '布式', '式锁', 'lock', '中']);
  // 注：'redis'→'redi' 是 U-128 既有去尾 s 规则（查询与正文两侧同函数，对称无害），此处如实断言，不在 R1 改
  // G-4b 检索侧同一条链（Set-UnifiedScore 的命中原语）：NFKC 宽度归一、假名/韩文/扩展 A 不被抹掉、拉丁↔CJK 边界切分；U-128 整词语义不回退
  assert.deepEqual(o.mt, { wide: 'redi 分布式锁', kana: 'ロック機構', hwKana: 'ロック', hangul: '분산 락', extA: '\u3400字', en: 'organization api caching', hitMixed: true, hitKana: true, noSub: false });
  // G-5 去重键 NFKC + casefold
  assert.equal(o.dk.a, o.dk.b); assert.equal(o.dk.wide, 'a'); assert.equal(o.dk.zw, 'ab');
  // H 不完整自曝
  assertCompleteness(o.comp.full, { returned: 3 }); assert.equal(o.comp.full.truncated, false); assert.equal(o.comp.full.cursor, null);
  assertCompleteness(o.comp.omitted, { returned: 3 }); assert.deepEqual([o.comp.omitted.total_count, o.comp.omitted.omitted_count, o.comp.omitted.truncated], [5, 2, true]);
  assert.deepEqual(o.comp.omitted.context, { mode: 'extract', returned_count: 2, total_count: 3, omitted_count: 1, truncated: true });
  assertCompleteness(o.comp.atLimit, { returned: 5 }); assert.equal(o.comp.atLimit.truncated, true); assert.deepEqual(o.comp.atLimit.sources_at_limit, ['GitHub']);
  assert.deepEqual(o.comp.atLimit.cursor, { kind: 'requery', param: 'Limit', value: 10 });
}

// H 的结构判据（真实样本与合成负例共用）
export function assertCompleteness(c, { returned } = {}) {
  assert.ok(c && typeof c === 'object', 'completeness block missing (truncation must never be silent)');
  for (const k of ['returned_count', 'total_count', 'omitted_count', 'mode', 'truncated', 'cursor', 'total_scope'])
    assert.ok(k in c, `completeness.${k} missing`);
  assert.ok(['raw', 'extract', 'summary'].includes(c.mode), 'mode must be raw|extract|summary');
  assert.equal(c.omitted_count, c.total_count - c.returned_count, 'omitted = total - returned');
  if (returned !== undefined) assert.equal(c.returned_count, returned, 'returned_count must equal results.length');
  const shouldTruncate = c.omitted_count > 0 || (c.sources_at_limit ?? []).length > 0;
  assert.equal(c.truncated, shouldTruncate, 'truncated must be true iff something was omitted or a source hit its per-source cap');
  assert.equal(c.cursor !== null, (c.sources_at_limit ?? []).length > 0, 'a continuation cursor is required exactly when a source hit its cap');
}

let cache = null;
async function probe() {
  if (cache) return cache;
  cache = await probeWithMutants(PROBE, [
    { name: 'label-name-equality', fn: 'Resolve-EncodingLabel', find: "'windows-1252' = @('windows-1252', 'latin1', 'iso-8859-1'", replace: "'iso-8859-1' = @('iso-8859-1', 'latin1'); 'windows-1252' = @('windows-1252'" },
    { name: 'label-gb2312-own', fn: 'Resolve-EncodingLabel', find: "'gbk', 'gb2312',", replace: "'gbk'," },
    { name: 'bom-after-ct', fn: 'Resolve-TextEncoding', find: 'if ($bom) {', replace: 'if ($bom -and -not $ContentType) {' },
    { name: 'json-honours-label', fn: 'Resolve-TextEncoding', find: "^\\s*application/(?:[a-z0-9.+-]*\\+)?json\\b", replace: '^NEVER$' },
    { name: 'repair-latin1-only', fn: 'Repair-Cp1252Mojibake', find: 'elseif ($hi.ContainsKey($c)) { $bytes[$i] = [byte]$hi[$c] }', replace: '' },
    { name: 'repair-lenient-decode', fn: 'Repair-Cp1252Mojibake', find: 'else { return $Text }', replace: 'else { $bytes[$i] = [byte]0x3F }' },
    { name: 'cjk-unigram', fn: 'Get-CjkBigrams', find: 'for ($i = 0; $i -lt $run.Length - 1; $i++) { $tokens.Add($run.Substring($i, 2)) }', replace: 'foreach ($ch in $run.ToCharArray()) { $tokens.Add([string]$ch) }' },
    { name: 'cjk-no-width-fold', fn: 'Get-CjkBigrams', find: 'try { $t = $t.Normalize([System.Text.NormalizationForm]::FormKC) } catch { }', replace: '' },
    { name: 'match-no-nfkc', fn: 'Normalize-MatchText', find: 'try { $t = $t.Normalize([System.Text.NormalizationForm]::FormKC) } catch { }', replace: '' },
    { name: 'match-han-only', fn: 'Normalize-MatchText', find: "$cjk = '\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uac00-\\ud7af\\uf900-\\ufaff'", replace: "$cjk = '\\u4e00-\\u9fff'" },
    { name: 'match-no-script-split', fn: 'Normalize-MatchText', find: '$t = [regex]::Replace($t, "(?<=[a-z0-9])(?=[$cjk])|(?<=[$cjk])(?=[a-z0-9])", \' \')', replace: '' },
    { name: 'dedup-case-sensitive', fn: 'Get-DedupKey', find: 'return $t.ToLowerInvariant()', replace: 'return $t' },
    { name: 'comp-silent-truncation', fn: 'New-CompletenessInfo', find: '$truncated = ($omitted -gt 0) -or ($atLimit.Count -gt 0)', replace: '$truncated = $false' },
    { name: 'comp-no-cursor', fn: 'New-CompletenessInfo', find: "$cursor = [PSCustomObject]@{ kind = 'requery'", replace: "$cursor = $null; $null = [PSCustomObject]@{ kind = 'requery'" },
    { name: 'comp-context-unbounded', fn: 'New-CompletenessInfo', find: '$ctxReturned = [math]::Min([math]::Max($ContextTopK, 0), $Returned)', replace: '$ctxReturned = $Returned' },
  ]);
  return cache;
}

test('R94-G/H: encoding labels, BOM priority, JSON UTF-8 rule, mojibake round-trips, CJK bigrams, match-text normalisation, dedup key and completeness agree with Node-generated fixtures', async () => {
  assert.equal(MOJI_1252, 'äº¬ä¸œé›¶å”®', 'fixture sanity: Node windows-1252 decode');
  checkReal((await probe()).real);
});
test('R94-G/H mutation: each injected encoding / tokenizer / completeness bug turns this gate red', async () => {
  const tally = assertMutantsKilled(await probe(), v => checkReal(v));
  assert.equal(tally.killed.length, 15);
});

test('R94-H on the real -AsJson sample: completeness is present, self-consistent, and agrees with results/context', () => {
  const s = JSON.parse(read('reports/gates/u89-real-asjson.json'));
  assertCompleteness(s.completeness, { returned: s.results.length });
  const perSrc = s.metrics.PerPlatformCount;
  const atLimit = Object.keys(perSrc).filter(k => perSrc[k] >= s.completeness.per_source_limit).sort();
  assert.deepEqual([...s.completeness.sources_at_limit].sort(), atLimit, 'sources_at_limit must be derived from PerPlatformCount vs per_source_limit');
  console.log(`[R94-H sample] returned=${s.completeness.returned_count} total=${s.completeness.total_count} omitted=${s.completeness.omitted_count} truncated=${s.completeness.truncated} at_limit=[${s.completeness.sources_at_limit}] cursor=${JSON.stringify(s.completeness.cursor)} context=${JSON.stringify(s.completeness.context)}`);
});
test('R94-H negatives: a truncated payload reported as plain success without counts, with a wrong omitted count, or without a cursor is rejected', () => {
  assert.throws(() => assertCompleteness(undefined), /truncation must never be silent/);
  assert.throws(() => assertCompleteness({ status: 'success', truncated: true, mode: 'raw' }), /returned_count missing/);
  const base = { returned_count: 3, total_count: 5, omitted_count: 2, total_scope: 'local-candidates', mode: 'raw', truncated: true, cursor: null, sources_at_limit: [] };
  assertCompleteness(base);
  assert.throws(() => assertCompleteness({ ...base, omitted_count: 0 }), /omitted = total - returned/);
  assert.throws(() => assertCompleteness({ ...base, truncated: false }), /truncated must be true/);
  assert.throws(() => assertCompleteness({ ...base, sources_at_limit: ['GitHub'] }), /continuation cursor/);
  assert.throws(() => assertCompleteness({ ...base, mode: 'partial' }), /raw\|extract\|summary/);
});

test('R94-H source: the -AsJson payload carries completeness built from real counts (candidates before post-filters, per-source counts, -Limit, context top-K)', () => {
  const src = read('multi-platform-searcher.ps1');
  assert.match(src, /\$candidateCount = @\(\$allResults\)\.Count\n/, 'candidate count must be taken right after scoring, before NoiseFloor/code filter');
  assert.match(src, /\$completeness = New-CompletenessInfo -Returned @\(\$cleanResults\)\.Count -Candidates \$candidateCount -PerSourceCount \$perPlatformCount -PerSourceLimit \$Limit -ContextTopK \$ragTopK/);
  assert.match(src, /warnings = \$warningsOut; completeness = \$completeness; context = \$ragContext;/);
  assert.ok(src.indexOf('$candidateCount = @($allResults).Count') < src.indexOf('if ($NoiseFloor -gt 0) {'), 'candidate count must precede the NoiseFloor filter');
});
