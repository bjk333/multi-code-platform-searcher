// U-134（2026-09-29）：-AsJson 产物必须是严格可解析的 UTF-8 JSON（≥3 份真实样本，strict decode + JSON.parse），
// 并带两条负例：① 人造"半个 UTF-8 字符"必被 strict 解码拒绝；② 宿主 R73 那种"UTF-8 字节被按 GBK 读"的产物必被拒绝（它不是产品缺陷，是捕获段误读，见 reports/gates/u134/）。
// 另：Preview 截断不得切开 UTF-16 代理对（emoji）—— 静态钉住主脚本里的保护。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceAll } from './lib/source.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLES = [
  'reports/gates/u134/auto-json-parser.json',          // -Auto 'json parser' -Limit 5（宿主 R73 报错的同一查询）
  'reports/gates/u132/post-gitee.json',                // Gitee 中文仓库名（U-132 修后）
  'reports/gates/u100-c14-16/post-c16-code.json',      // code 模式 verdict=none 样本
  'reports/gates/u128-b8/post-W1q2.json',              // research 样本
];
const strict = new TextDecoder('utf-8', { fatal: true });

test('U-134: at least 3 real -AsJson samples are strict UTF-8 and strict JSON', () => {
  let n = 0;
  for (const rel of SAMPLES) {
    const p = path.join(root, rel);
    if (!fs.existsSync(p)) continue;
    const bytes = fs.readFileSync(p);
    const text = strict.decode(bytes).replace(/^\uFEFF/, '');   // throws on any half character
    const obj = JSON.parse(text);
    assert.ok(obj && obj.coverage && Array.isArray(obj.results), rel + ': not an -AsJson payload');
    for (const r of obj.results) for (const k of ['Name', 'Desc', 'Preview']) {
      const v = r[k]; if (typeof v !== 'string') continue;
      assert.doesNotMatch(v, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/, rel + ': lone surrogate in ' + k);
    }
    n++;
  }
  assert.ok(n >= 3, 'need >= 3 samples on disk, found ' + n);
});

test('U-134 negative control ①: a byte-truncated multibyte char is rejected by strict decoding', () => {
  const good = Buffer.from('{"Preview":"nicer…"}', 'utf8');
  const half = Buffer.concat([good.subarray(0, good.length - 3), Buffer.from('"}')]);   // cut inside E2 80 A6
  assert.throws(() => strict.decode(half), /valid|decode|malformed/i);   // TextDecoder(fatal): 'The encoded data was not valid for encoding utf-8'
});

test('U-134 negative control ②: the R73 host artefact shape (UTF-8 read as GBK ⇒ 鈥? swallowed the closing quote) is rejected', () => {
  const bad = Buffer.from('{"Preview":"nicer鈥?,\n"x":1}', 'utf8');   // exactly the bytes seen at host-code-positive.json L241
  assert.throws(() => JSON.parse(strict.decode(bad)), /JSON|token|Unexpected|control/i);
});

test('U-134: Preview truncation does not split a UTF-16 surrogate pair (static)', () => {
  const src = sourceAll(path.join(root));
  assert.match(src, /function Get-SafePreview/);
  assert.match(src, /IsHighSurrogate/);
  assert.doesNotMatch(src, /\$txt\.Substring\(0, \$script:Cfg\.PreviewLen\) \+ '…'/, 'raw Substring truncation must go through Get-SafePreview');
});
