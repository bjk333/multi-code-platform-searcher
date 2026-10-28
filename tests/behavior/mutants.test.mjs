// U-274-H（B3-3 变异臂）：证明这一层"能红"。
//
// 一个永绿的行为测试比没有更坏：它会让"行为覆盖"变成一张自签的证书。
// 所以这条门把产品复制到临时目录，按**预测**打断两处（状态出口、URL 参数），
// 断言刚才那两条判据真的会失败：
//   ① 把 Codeberg 成功出口的 `-Status 'ok'` 改成 `'empty'` ⇒ 状态判据必须不成立；
//   ② 把 `sort=stars` 从 URL 里删掉 ⇒ "请求参数"判据必须不成立（而结果仍然解析出 2 条）。
// 注意 ② 是关键：它证明"结果对"与"问得对"是两条独立判据 —— 只断言条数的测试抓不到 URL 漂移。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFixture } from './lib/fixture-server.mjs';
import { runEngine, ROOT } from './lib/engine-probe.mjs';
import { CASES } from './lib/cases.mjs';

const codeberg = CASES.find((c) => c.status === 'Codeberg');

function copyProduct(dst) {
  fs.copyFileSync(path.join(ROOT, 'multi-platform-searcher.ps1'), path.join(dst, 'multi-platform-searcher.ps1'));
  for (const d of ['lib', 'engines']) {
    fs.mkdirSync(path.join(dst, d), { recursive: true });
    for (const f of fs.readdirSync(path.join(ROOT, d))) {
      if (f.endsWith('.ps1')) fs.copyFileSync(path.join(ROOT, d, f), path.join(dst, d, f));
    }
  }
}

async function withMutatedProduct(mutator, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'u274-mut-'));
  try {
    copyProduct(tmp);
    mutator(tmp);
    // ★必须 await：只 `return fn(tmp)` 时 finally 会在探针还没 dot-source 之前就把临时目录删掉，
    //   症状是"探针没有任何输出"（payload=null），而不是一条能读懂的失败 —— 本项目踩过同类。
    return await fn(tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function patch(file, from, to) {
  const s = fs.readFileSync(file, 'utf8');
  assert.ok(s.includes(from), '变异锚点不存在：' + from);
  fs.writeFileSync(file, s.split(from).join(to), 'utf8');
}

test('U-274-H1 变异：成功出口的状态改错 ⇒ 状态判据必须失败（结果条数不受影响）', async () => {
  await withMutatedProduct((tmp) => {
    patch(path.join(tmp, 'engines', 'codeberg.ps1'), "Set-EngineStatus -Name 'Codeberg' -Status 'ok'", "Set-EngineStatus -Name 'Codeberg' -Status 'empty'");
  }, async (root) => {
    const fx = await startFixture(codeberg.ok);
    try {
      const r = await runEngine({ fn: codeberg.fn, params: { ...codeberg.params, __statusName: 'Codeberg' }, port: fx.port, root });
      assert.equal(r.payload.count, 2, '变异只动状态，不该影响解析结果（否则说明变异打歪了）');
      assert.notEqual(r.payload.status, 'ok', '状态被改成 empty，判据却仍满足 —— 这条断言是空的');
    } finally { await fx.close(); }
  });
});

test('U-274-H2 变异：URL 少一个参数 ⇒ 请求参数判据必须失败（结果仍对）', async () => {
  await withMutatedProduct((tmp) => {
    patch(path.join(tmp, 'engines', 'codeberg.ps1'), '`&sort=stars`&order=desc', '`&order=desc');
  }, async (root) => {
    const fx = await startFixture(codeberg.ok);
    try {
      const r = await runEngine({ fn: codeberg.fn, params: { ...codeberg.params, __statusName: 'Codeberg' }, port: fx.port, root });
      assert.equal(r.payload.count, 2, '夹具不按参数筛，结果仍应是 2 条');
      const asked = fx.hits.map((h) => h.path).join('\n');
      assert.ok(!asked.includes('sort=stars'), 'URL 里已经删掉 sort=stars，判据却仍成立 —— 说明它没在断言请求');
    } finally { await fx.close(); }
  });
});
