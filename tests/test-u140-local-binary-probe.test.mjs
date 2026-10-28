// U-140（2026-09-29，预注册 reports/U-140-预注册判据-2026-09-29.md）：本地检索二进制选择器跨平台 —— 非 Windows 不找 .exe；选中前 --version 探活；探活失败继续；全败 ⇒ $null ⇒ tool_missing。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceAll } from './lib/source.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = sourceAll(path.join(root));
function fnBody(s, name) { const i = s.indexOf('function ' + name + ' {'); assert.ok(i >= 0, name + ' must exist'); const j = s.indexOf('\nfunction ', i + 1); return s.slice(i, j < 0 ? undefined : j); }
export function guardU140(s) {
  const p = []; const f = fnBody(s, 'Find-LocalSearchBinary');
  if (!/\$isWin = if \(\$null -ne \$IsWindows\) \{ \[bool\]\$IsWindows \} else \{ \$true \}/.test(f)) p.push('platform switch missing');
  if (!/\$names = if \(\$isWin\) \{ @\('rg\.exe', 'ugrep\.exe'\) \} else \{ @\('rg', 'ugrep'\) \}/.test(f)) p.push('non-Windows candidates must be rg/ugrep without .exe');
  if (!/\(Test-Path \$candidate -PathType Leaf\) -and \(Test-LocalBinaryAlive -Path \$candidate\)/.test(f)) p.push('bundled candidate must be probed before use');
  if (!/if \(\$p -and \(Test-LocalBinaryAlive -Path \$p\.Source\)\) \{ return \$p\.Source \}/.test(f)) p.push('PATH candidate must be probed before use');
  const t = fnBody(s, 'Test-LocalBinaryAlive');
  if (!/& \$Path --version 2>\$null/.test(t) || !/return \(\$LASTEXITCODE -eq 0\)/.test(t) || !/catch \{ return \$false \}/.test(t)) p.push('probe must run --version and treat non-zero/throw as dead');
  return p;
}
test('U-140: local search binary selector is platform-aware and probes every candidate before returning it', () => {
  assert.deepEqual(guardU140(src), []);
  // 调用方语义不变：$null ⇒ tool_missing（在 engines/local-code.ps1）
  const eng = fs.readFileSync(path.join(root, 'engines/local-code.ps1'), 'utf8');
  assert.match(eng, /\$bin = Find-LocalSearchBinary\s*\n\s*if \(-not \$bin\) \{[\s\S]*?-Status 'tool_missing'/);
});
test('U-140 negative control: dropping the probe from the bundled-dir branch is reported', () => {
  const bad = src.replace("(Test-Path $candidate -PathType Leaf) -and (Test-LocalBinaryAlive -Path $candidate)", "Test-Path $candidate -PathType Leaf");
  assert.notEqual(bad, src);
  assert.ok(guardU140(bad).some(x => /bundled candidate must be probed/.test(x)));
  const bad2 = src.replace("@('rg', 'ugrep') }", "@('rg.exe', 'ugrep.exe') }");
  assert.ok(guardU140(bad2).some(x => /without \.exe/.test(x)));
});
