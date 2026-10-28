// R90 K: C18's authoritative AST length and U-130's S7 output discipline.
// S7 has not yet been migrated: the function guard automatically activates if/when Invoke-SearchModes is introduced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const main = read('multi-platform-searcher.ps1');
const history = read('references/变更历史.md');
const c18 = read('reports/U-100-C17-19-预研-2026-09-29.md');
const oldR75 = read('reports/远端回报-2026-09-29-R75-C17.md');
const manual = read('reports/U-100-C-搬迁手册.md');

function staleEstimate(s) { return /Search-GitLabBlobs.{0,24}~320 行/.test(s); }
function swallowed(s) {
  const start = s.indexOf('function Invoke-SearchModes {');
  if (start < 0) return null;  // not implemented; prereg and manual still bind the acceptance rule
  const next = s.indexOf('\nfunction ', start + 1);
  return /\$null\s*=/.test(s.slice(start, next < 0 ? undefined : next));
}

test('R90 K: C18 is 126 AST lines in current docs, not an unqualified ~320 assertion', () => {
  assert.match(history, /C18[^\n]*L1564–1689（\*\*126 行\*\*，权威 AST 实测/);
  assert.match(c18, /Search-GitLabBlobs[^\n]*126 行[^\n]*AST 实测 L1564–1689/);
  assert.match(oldR75, /Search-GitLabBlobs[^\n]*126 行[^\n]*旧估约 320 行已订正/);
  assert.equal(staleEstimate(oldR75), false);
});

test('R90 K negative: restoring the unqualified ~320 line is caught', () => {
  const bad = oldR75.replace('**126 行**；AST 实测 L1564–1689；本轮旧估约 320 行已订正', '~320 行');
  assert.notEqual(bad, oldR75);
  assert.equal(staleEstimate(bad), true);
});

test('R90 K: manual binds U-130 to S7 body and call-site; guard auto-activates on migration', () => {
  assert.match(manual, /\*\*12（U-130；D\/S7 输出）\*\*/);
  assert.match(manual, /函数体内任何会产生既有成功管道\/stdout 输出的语句，不得被 `\$null =` 包住/);
  assert.match(manual, /调用点必须是裸 `Invoke-SearchModes/);
  assert.match(read('reports/U-100-D2-预注册判据-2026-09-29.md'), /S7 函数体内任何会产生既有 stdout\/管道输出的 helper/);
  assert.equal(swallowed('function Invoke-SearchModes { Write-Output "ok" }'), false);
  assert.equal(swallowed('function Invoke-SearchModes { $null = Write-Output "lost" }'), true);
  if (swallowed(main) !== null) assert.equal(swallowed(main), false, 'active S7 function swallows stdout');
  else {
    assert.match(main, /if \(\$runModes -contains 'research'\)/, 'S7 still exists as a main-flow block');
    console.log('S7_ACTIVE_FUNCTION_COUNT=0; future function guard is armed');
  }
});
