// U-153（A5，2026-09-30）：由 tests/run-node-gates.mjs 以 --import 挂进每个门子进程。
// 目的：宿主 sandbox 的 safe-delete shim 会让门 finally 里的清理 rmSync 抛 `[safe-delete] …`；
//      这类异常一旦出现在 finally，会**顶掉**测试体里真实的断言失败（product 红被 env 报文掩盖）。
// 做法：只拦报文以 `[safe-delete]` 开头的清理异常 ⇒ 记一条 env 事件（写到 U153_ENV_EVENTS 指向的 JSONL，由启动器计入 env 红）
//      并且不再抛出，让测试体自己的结论（通过 / 断言失败）如实浮出。其它任何异常原样抛出。
// 未设 U153_ENV_EVENTS（例如有人单独 `node --test` 某个门）⇒ 本文件什么都不做，异常原样抛出。
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const sink = process.env.U153_ENV_EVENTS;
export const SAFE_DELETE = /^\[safe-delete\]/;
if (sink) {
  for (const op of ['rmSync', 'rmdirSync', 'unlinkSync']) {
    const orig = fs[op];
    if (typeof orig !== 'function') continue;
    fs[op] = function u153Guarded(target, ...rest) {
      try { return orig.call(this, target, ...rest); }
      catch (e) {
        const msg = String(e && e.message || '');
        if (!SAFE_DELETE.test(msg)) throw e;
        try {
          fs.appendFileSync(sink, JSON.stringify({ kind: 'safe-delete-shim', op, target: String(target), file: process.argv[1] || null, message: msg.slice(0, 400) }) + '\n');
        } catch { throw e; }   // 记不下来就不吞：宁可红
        return undefined;
      }
    };
  }
  syncBuiltinESMExports();
}
