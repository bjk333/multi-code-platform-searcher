// B3-3 行为层夹具：一个**真 HTTP 服务器**，按 (host, path) 返回预置响应，并记录产品实际发出的请求。
//
// 为什么用真服务器而不是桩函数：
//   · 桩 `Invoke-ApiRequest` 会把"产品怎么拼 URL / 怎么带 header / 怎么翻页"一起桩掉 —— 那正是引擎层最容易错的地方；
//   · 真服务器能同时断言两件事：**你问了什么**（URL/header/方法）与**你从回答里读出了什么**（结果条目/状态判定）。
//   · 状态码/响应头由 Node 真实产生，异常类型与生产一致（PS 侧在 `Invoke-WebRequestDirect` 里自然抛出）。
//
// 路由形状：{ host, path, method?, status?, headers?, body?, delayMs?, times? }
//   · path 支持字符串（精确）或 RegExp；host 必须精确匹配（产品用 Host 前缀路由到本地）。
//   · times：只命中前 N 次，之后落到下一条路由（用于"先 429 再 200"这类重试臂）。
//   · 未命中 ⇒ 404 + JSON 说明，且会记进 `unmatched`（测试应断言它为空：空白 404 会把"URL 拼错"伪装成"源没数据"）。

import http from 'node:http';

export async function startFixture(routes) {
  const state = { routes: [...routes], hits: [], unmatched: [] };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://placeholder');
    const host = req.headers['x-mcps-fixture-host'] || url.pathname.split('/')[1] || '';
    // 产品侧把 `https://host/path` 重写成 `http://127.0.0.1:port/host/path`：
    // Host 从路径第一段取，其余是原 path+query。
    const rest = url.pathname.replace(/^\/[^/]+/, '') || '/';
    const hit = {
      method: req.method,
      host,
      path: rest + url.search,
      rawUrl: req.url,
      headers: { ...req.headers },
      body: '',            // U-280：POST 的正文 —— JSON-RPC 这类引擎"问得对不对"全在 body 里
      at: Date.now(),
    };
    state.hits.push(hit);

    // 正文要读完再回，否则客户端发完就等响应、服务器没消费流，POST 会僵在写一半。
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      hit.body = Buffer.concat(chunks).toString('utf8');

      const idx = state.routes.findIndex((r) => {
        if (r.host && r.host !== host) return false;
        if (r.method && r.method.toUpperCase() !== req.method) return false;
        if (r.times !== undefined && (r._used || 0) >= r.times) return false;
        return typeof r.path === 'string' ? r.path === rest : r.path.test(rest);
      });

      if (idx < 0) {
        state.unmatched.push(hit);
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'no fixture route', host, path: hit.path }));
        return;
      }

      const r = state.routes[idx];
      r._used = (r._used || 0) + 1;
      // U-286（v1.68.0）：把**实际服务这条请求的路由**挂回 hit —— CLI 回放要按它重建响应。
      //   不记这个，录制方只能自己再实现一遍路由匹配；而"两处匹配逻辑"正是本项目反复踩的坑
      //   （U-284：夹具与产品各有一套 URL 改写，谁不同步谁就成了"源没数据"）。
      hit.route = r;
      const send = () => {
        res.writeHead(r.status || 200, { 'content-type': 'application/json', ...(r.headers || {}) });
        res.end(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
      };
      if (r.delayMs) setTimeout(send, r.delayMs); else send();
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    port,
    hits: state.hits,
    unmatched: state.unmatched,
    reset() { state.hits.length = 0; state.unmatched.length = 0; for (const r of state.routes) r._used = 0; },
    async close() { await new Promise((r) => server.close(r)); },
  };
}
