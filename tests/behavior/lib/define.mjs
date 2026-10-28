// 行为臂的**执行器**：把一张 case 表登记成 node:test 用例（A 成功 / B 合法零命中 / C 失败 / D 附加）。
// 表在 cases*.mjs，执行在这里 —— 两张表共用一套判据，避免"每个引擎一套写法"漂移。
//
// 判据的三条通则（每个引擎都必须满足，与引擎能力无关）：
//   1. 三臂都必须 `ok=true`：引擎自己归因，不许把异常抛给调用方；
//   2. 失败臂必须**真的发出过请求**（否则测的是"没跑"，不是"跑失败"）；
//   3. 夹具不许有未命中的请求：URL 拼错会变成 404，而 404 在引擎眼里也是"失败"——
//      不额外断言的话，"URL 拼错"与"源报错"会长得一模一样。

import assert from 'node:assert/strict';
import test from 'node:test';
import { startFixture } from './fixture-server.mjs';
import { runEngine } from './engine-probe.mjs';

async function withFixture(routes, fn) {
  const fx = await startFixture(routes);
  try {
    return await fn(fx);
  } finally {
    await fx.close();
  }
}

function checkRequest(fx, musts, bodyMusts, headerMusts) {
  assert.equal(fx.unmatched.length, 0, '有请求没打到夹具路由（URL 拼错了？）：' + JSON.stringify(fx.unmatched.map((h) => h.host + h.path)));
  assert.ok(fx.hits.length >= 1, '一条请求都没发出 —— 引擎在请求前就退出了');
  const all = fx.hits.map((h) => h.host + h.path).join('\n');
  for (const m of musts || []) {
    assert.ok(all.includes(m), `请求里缺少 ${m}；实际：\n${all}`);
  }
  // U-280：POST 类引擎（JSON-RPC）"问得对不对"在正文里 —— 只看 URL 会让"方法名写错"照样绿。
  //   ★断言的是**子串**而不是整段 JSON：键序、空白都由两端的序列化决定，逐字节比对会把
  //     "格式变了" 和 "内容错了" 混成一件事。要钉结构的地方用 expect 里的字段断言。
  if (bodyMusts && bodyMusts.length) {
    const bodies = fx.hits.map((h) => h.body || '').join('\n');
    for (const m of bodyMusts) {
      assert.ok(bodies.includes(m), `请求正文里缺少 ${m}；实际：\n${bodies}`);
    }
  }
  // U-281（v1.63.0）：**请求头**也是"你问了什么"的一部分。
  //   写这批臂时才发现的空洞：夹具只会照给定响应回，不看 Accept/Authorization ⇒
  //   "没带 text-match 媒体类型"与"带了"在之前的判据下**完全同形**，而 Preview 恒为 null 正是这个形状。
  //   头名按 Node 的口径小写比对（HTTP 头不区分大小写，断言不该反过来要求大小写）。
  for (const [name, needle] of Object.entries(headerMusts || {})) {
    const got = fx.hits.map((h) => h.headers[name.toLowerCase()] || '').join('\n');
    assert.ok(got.includes(needle), `请求头 ${name} 里缺少 ${needle}；实际：${got || '(空)'}`);
  }
}

function assertFirst(result, first) {
  for (const [k, v] of Object.entries(first || {})) {
    assert.equal(result[0][k], v, `首条 ${k}`);
  }
}

export function defineEngineCases(cases, tag = 'U-274') {
  for (const c of cases) {
    // 前置段（U-281）：有的引擎在**发请求前**就按"有没有令牌"分流，而探针默认把令牌清空。
    //   要让同一张表的成功臂能跑，必须能在点源之后、调用之前给它一个令牌 —— 这就是 preamble。
    //   臂级 preamble 一旦给出（含空串）就整体覆盖 case 级，不再合并："没令牌"这条臂必须真的**没**令牌。
    const preOf = (x) => (x && Object.prototype.hasOwnProperty.call(x, 'preamble') ? x.preamble : c.preamble);

    test(`${tag}-A ${c.name}：200 + 两条 ⇒ 解析出两条，且请求参数正确`, async () => {
      await withFixture(c.ok, async (fx) => {
        const r = await runEngine({ fn: c.fn, params: { ...c.params, __statusName: c.status }, port: fx.port, preamble: preOf(null) });
        assert.ok(r.payload, '探针没吐 JSON：' + r.stderr.slice(-500));
        assert.equal(r.payload.ok, true, '引擎抛了未捕获异常：' + r.payload.error);
        const e = c.expect.ok;
        assert.equal(r.payload.count, e.count, `结果数应为 ${e.count}`);
        if (e.status) assert.equal(r.payload.status, e.status, '引擎状态（理由：' + (r.payload.reason || '—') + '）');
        if (e.reasonHas) assert.ok(String(r.payload.reason || '').includes(e.reasonHas), '状态理由应包含 ' + e.reasonHas + '；实际：' + r.payload.reason);
        assertFirst(r.payload.result, e.first);
        if (e.noHtml) {
          for (const it of r.payload.result) {
            assert.ok(!/[<>]/.test(String(it.Preview || '')), 'Preview 里残留 HTML 标签：' + it.Preview);
            assert.ok(!/&(lt|gt|quot|#39|amp);/.test(String(it.Name || '')), 'Name 里残留实体：' + it.Name);
          }
        }
        if (e.descHas) assert.ok(String(r.payload.result[0].Desc || '').includes(e.descHas), '首条 Desc 应包含 ' + e.descHas + '；实际：' + r.payload.result[0].Desc);
        if (e.warnHas) {
          assert.ok(r.payload.warnings.join('\n').includes(e.warnHas), '缺少预期告警：' + e.warnHas + '；实际：' + r.payload.warnings.join(' | '));
        }
        checkRequest(fx, e.urlHas, e.bodyHas, e.headersHas);
      });
    });

    test(`${tag}-B ${c.name}：合法空集合 ⇒ 0 条，不许冒充成功`, async () => {
      await withFixture(c.zero, async (fx) => {
        const r = await runEngine({ fn: c.fn, params: { ...c.params, __statusName: c.status }, port: fx.port, preamble: preOf(null) });
        assert.ok(r.payload, '探针没吐 JSON：' + r.stderr.slice(-500));
        assert.equal(r.payload.ok, true, '空集不该抛异常：' + r.payload.error);
        const e = c.expect.zero;
        assert.equal(r.payload.count, e.count, '零命中臂必须 0 条');
        if (e.status) assert.equal(r.payload.status, e.status, '零命中臂状态（理由：' + (r.payload.reason || '—') + '）');
        else assert.notEqual(r.payload.status, 'ok', '零命中却报 ok —— 把"没结果"说成"成功取到"');
        if (e.warnHas) assert.ok(r.payload.warnings.join('\n').includes(e.warnHas), '缺少预期告警：' + e.warnHas + '；实际：' + r.payload.warnings.join(' | '));
        checkRequest(fx, []);
      });
    });

    test(`${tag}-C ${c.name}：429 ⇒ 0 条、不抛未捕获，并按该引擎能力归因`, async () => {
      await withFixture(c.fail, async (fx) => {
        const r = await runEngine({ fn: c.fn, params: { ...c.params, __statusName: c.status }, port: fx.port, preamble: preOf(null) });
        assert.ok(r.payload, '探针没吐 JSON：' + r.stderr.slice(-500));
        assert.equal(r.payload.ok, true, '429 必须在引擎内被归因，不许抛到调用方：' + r.payload.error);
        const e = c.expect.fail;
        assert.equal(r.payload.count, e.count, '失败臂必须 0 条（真实原因写状态/warning）');
        if (e.status) assert.equal(r.payload.status, e.status, '失败臂状态（归因；理由：' + (r.payload.reason || '—') + '）');
        if (e.statusNot) assert.notEqual(r.payload.status, e.statusNot, '失败被记成了成功状态');
        if (e.warnHas) {
          assert.ok(r.payload.warnings.join('\n').includes(e.warnHas), '缺少预期告警：' + e.warnHas + '；实际：' + r.payload.warnings.join(' | '));
        }
        assert.ok(fx.hits.length >= 1, '失败臂必须真的发出过请求（否则测的是"没跑"）');
      });
    });

    for (const x of c.extra || []) {
      test(`${tag}-D ${c.name}：${x.name}`, async () => {
        await withFixture(x.routes, async (fx) => {
          const r = await runEngine({ fn: c.fn, params: { ...c.params, ...(x.params || {}), __statusName: c.status }, port: fx.port, preamble: preOf(x) });
          assert.ok(r.payload, '探针没吐 JSON：' + r.stderr.slice(-500));
          assert.equal(r.payload.ok, true, '附加臂不该抛未捕获：' + r.payload.error);
          const e = x.expect;
          if (e.count !== undefined) assert.equal(r.payload.count, e.count, '附加臂结果数');
          if (e.status) assert.equal(r.payload.status, e.status, '附加臂状态（理由：' + (r.payload.reason || '—') + '）');
          if (e.reasonHas) assert.ok(String(r.payload.reason || '').includes(e.reasonHas), '附加臂状态理由应包含 ' + e.reasonHas + '；实际：' + r.payload.reason);
          if (e.statusNot) assert.notEqual(r.payload.status, e.statusNot, '附加臂状态不该是 ' + e.statusNot);
          if (e.warnHas) assert.ok(r.payload.warnings.join('\n').includes(e.warnHas), '缺少预期告警：' + e.warnHas + '；实际：' + r.payload.warnings.join(' | '));
          if (e.warnNotHas) assert.ok(!r.payload.warnings.join('\n').includes(e.warnNotHas), '不该出现告警：' + e.warnNotHas + '；实际：' + r.payload.warnings.join(' | '));
          if (e.first) assertFirst(r.payload.result, e.first);
          if (e.descHas) assert.ok(String(r.payload.result[0].Desc || '').includes(e.descHas), '首条 Desc 应包含 ' + e.descHas + '；实际：' + r.payload.result[0].Desc);
          // "一条都不许发"（U-281）：`auth_missing` 这类**发请求前就分流**的臂，用 hits>0 那套通则判不了 ——
          //   它反过来要求 0 请求（花的配额是实打实的）。不写这条，短路"提前退出"与"退化成发请求再失败"同形。
          if (e.noRequest) {
            assert.equal(fx.hits.length, 0, '这条臂不该发出任何请求；实际：' + JSON.stringify(fx.hits.map((h) => h.host + h.path)));
          }
          else if (e.urlHas || e.bodyHas || e.headersHas) checkRequest(fx, e.urlHas, e.bodyHas, e.headersHas);
        });
      });
    }
  }
}
