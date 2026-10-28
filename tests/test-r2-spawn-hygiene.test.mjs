// R2 远端（2026-09-30）：spawnSync 卫生门（宿主收口 §5.5 发现 2 / 开场指令 §3-3）。
//   事实：宿主 WorkBuddy 的 NODE_OPTIONS 垫片让 spawnSync 恒 EBUSY、status=null。凡以"rc≠0"判红的门/抽检器，都会把"没跑"记成"跑红"（假绿）。
//   判据：① tests/*.mjs 里用 spawnSync/execSync/execFileSync 的文件 ⊆ 白名单；新文件一律只许异步 spawn；
//         ② 白名单里每个文件必须带"失败关闭"证据字面量（EBUSY/无 status ⇒ 抛错/判红，绝不当成通过），缺了即红；
//         ③ 做变异/击杀计数的文件（含 killed/CAUGHT/mutant 字样）一律不得用同步 spawn，且必须先断言基线。
//   不改 test-u100-d1：U-153 P2 就是用它的 spawnSync 建模"纯 env 红"，改成异步会让那条宿主门失去被测对象（宿主已做项，不重复、不回退）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { rootDir } from './r2-ps-run.mjs';

export const ALLOW = {
  'test-u100-d1-no-exit-in-functions.test.mjs': { why: 'U-153 P2 的被测对象；EBUSY/超时/错误 ⇒ unverifiable 抛错（env:spawnsync-ebusy / interp-timeout），不会假绿', evidence: ['if (r.error) throw r.error;', "(code === 'EBUSY' || code === 'ETIMEDOUT') && n < attempts", "return { state: 'unverifiable'"] },
  'test-u141-doctor-inventory.test.mjs': { why: 'win32 上 skip；非 win32 断言 status===0，status=null 即红', evidence: ["assert.equal(r.status, 0, `PowerShell failure:", "{ skip: process.platform === 'win32' }"] },
  'test-r2-spawn-hygiene.test.mjs': { why: '本门自身（只做文本扫描）', evidence: ['export const ALLOW'] },
  'test-u208-contract-batch.test.mjs': {
    why: 'U-208 契约批：静态接线 4 条 + 两次一次性探针。EBUSY/超时 ⇒ r.error 抛错，或 stdout 为空导致解析/断言失败 ⇒ 判红，不会把"没跑"读成通过',
    evidence: ['if (r.error) throw r.error;', 'assert.equal(r.code, 0,', "assert.ok(fs.existsSync(out) || (r.stdout || '').length > 0"],
  },
};
// 只认真实用法：从 child_process 导入同步 API，或 xx.spawnSync( 形式调用；注释/说明文字里提到不算
const SYNC = /import\s*\{[^}]*\b(?:spawnSync|execSync|execFileSync)\b[^}]*\}\s*from\s*['"](?:node:)?child_process['"]|\b(?:child_process|cp|childProcess)\.(?:spawnSync|execSync|execFileSync)\s*\(|require\(['"](?:node:)?child_process['"]\)\.(?:spawnSync|execSync|execFileSync)/;
const MUTATION = /\b(?:killed|CAUGHT|mutants?)\b/;

export function audit(files) {
  const bad = [];
  for (const [name, src] of files) {
    const usesSync = SYNC.test(src);
    if (usesSync && !ALLOW[name]) bad.push(`${name}: uses a synchronous child_process API but is not allowlisted (use async spawn; see tests/r2-ps-run.mjs)`);
    if (usesSync && ALLOW[name]) for (const ev of ALLOW[name].evidence) if (!src.includes(ev)) bad.push(`${name}: allowlisted but fail-closed evidence is gone: ${ev}`);
    if (MUTATION.test(src) && usesSync && name !== 'test-r2-spawn-hygiene.test.mjs') bad.push(`${name}: mutation/kill counting over spawnSync (EBUSY ⇒ status=null ⇒ fake kills)`);
  }
  return bad;
}
const read = () => fs.readdirSync(path.join(rootDir, 'tests')).filter(f => f.endsWith('.mjs')).map(f => [f, fs.readFileSync(path.join(rootDir, 'tests', f), 'utf8')]);

test('R2 spawn hygiene: only allowlisted, fail-closed files use synchronous child_process APIs', () => {
  const files = read();
  const bad = audit(files);
  assert.deepEqual(bad, []);
  const users = files.filter(([, s]) => SYNC.test(s)).map(([n]) => n).sort();
  console.log(`[R2 spawn] sync users=${users.length} [${users.join(', ')}] allowlist=${Object.keys(ALLOW).length}`);
});
test('R2 spawn hygiene negatives: a new spawnSync user, a removed fail-closed guard, and spawnSync-based kill counting are each reported', () => {
  const files = read();
  const withNew = [...files, ['test-zz-new.test.mjs', "import { spawnSync } from 'node:child_process';\nconst r = spawnSync('pwsh', []);"]];
  assert.match(audit(withNew).join('\n'), /test-zz-new\.test\.mjs: uses a synchronous/);
  const noGuard = files.map(([n, s]) => [n, n === 'test-u100-d1-no-exit-in-functions.test.mjs' ? s.replace('if (r.error) throw r.error;', '') : s]);
  assert.match(audit(noGuard).join('\n'), /fail-closed evidence is gone: if \(r\.error\) throw r\.error;/);
  const kills = [...files.filter(([n]) => n !== 'test-u141-doctor-inventory.test.mjs'), ['test-u141-doctor-inventory.test.mjs', files.find(([n]) => n === 'test-u141-doctor-inventory.test.mjs')[1] + '\n// mutants killed\n']];
  assert.match(audit(kills).join('\n'), /mutation\/kill counting over spawnSync/);
});
