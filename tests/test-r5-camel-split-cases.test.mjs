// R5 · 驼峰拆词「本意 vs 误伤」回归门
//
// 病灶（2026-10-10 修）：规则② `(?<=[A-Z])(?=[A-Z][a-z])` 本意是 `HTTPServer → HTTP Server`，
//   但它把**复数缩写的尾巴**也当新词：`APIs` → `AP Is` → 小写后 `ap is`
//   ⇒ **查 `api` 匹配不到 `APIs`**（R94-G/H 实测红：actual 'organization ap is caching'）。
//   修法：要求「大写 + **≥2 个小写**」⇒ `APIs`/`UUIDs`/`XMLs` 不再拆，`HTTPServer`/`IOError` 照拆。
//
// 为什么要单独一道门：R94 的 fixture 只覆盖了 `APIs` 这一个形状，
//   **规则②的本意场景（HTTPServer 类）没有被任何门覆盖** ⇒ 收紧正则时**无人拦回归**。
//   本门把「本意」与「误伤」两侧一起钉住（9 例，全部行为级实测）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(testsDir, '..');
const PROBE = path.join(root, 'reports/gates/r5-research-2026-10-10/probe-camel-regression.ps1');

test('R5-camel: 拆词「本意」与「误伤」两侧共 9 例全部成立', async () => {
  assert.ok(fs.existsSync(PROBE), '行为探针必须存在: ' + PROBE);
  const r = await new Promise(res => {
    const c = spawn('pwsh', ['-NoProfile', '-File', PROBE, '-Repo', root], { cwd: root, windowsHide: true });
    let o = '', e = '';
    c.stdout.on('data', d => { o += d; }); c.stderr.on('data', d => { e += d; });
    c.on('error', x => { e += 'spawn: ' + x.message; });
    c.once('close', code => res({ code, o, e }));
  });
  assert.equal(r.code, 0, '探针必须跑通: ' + r.e.slice(0, 300));
  // ★探针输出**全 ASCII**（`键==值`）：首版探针打印中文，在控制台代码页下乱码 ⇒ 本门解析空跑。
  //   教训：**门的解析不得依赖控制台代码页**。
  const m = /BAD=(\d+)\s+TOTAL=(\d+)/.exec(r.o);
  assert.ok(m, '必须能从探针输出解析出计数（否则本门是空跑）；实得输出: ' + r.o.slice(0, 200));
  const bad = Number(m[1]), total = Number(m[2]);
  // 三例本意（若被误伤 ⇒ 收紧过头）
  assert.match(r.o, /CASE PASS HTTPServer==http server/, '★规则②本意：HTTPServer 必须拆成 http server');
  assert.match(r.o, /CASE PASS IOError==io error/, '★规则②本意：IOError 必须拆成 io error');
  assert.match(r.o, /CASE PASS XMLHttpRequest==xml http request/, '★规则②本意：XMLHttpRequest 必须拆成 xml http request');
  // 三例误伤（若回退 ⇒ 复数缩写又被拆）
  assert.match(r.o, /CASE PASS APIs==api/, '★误伤修复：APIs 必须归一为 api（不是 ap is）');
  assert.match(r.o, /CASE PASS UUIDs==uuid/, '★同类：UUIDs 必须归一为 uuid');
  assert.match(r.o, /CASE PASS XMLs==xml/, '★同类：XMLs 必须归一为 xml');
  assert.equal(bad, 0, `★9 例必须全过，实得不合期望 ${bad}/${total}`);
  console.log(`[R5-camel] 本意 3 + 误伤 3 + 规则①3 = ${total} 例，不合期望 ${bad}`);
});
