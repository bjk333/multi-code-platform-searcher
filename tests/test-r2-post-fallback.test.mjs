// R-2 + X-3: exercise the real Node engine against localhost only; no external network.
// PowerShell fallback wiring is inspected here but requires PS5.1/PS7 host tests for acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sourceAll } from './lib/source.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const engine = path.join(root, 'tools/node-https-engine.mjs');

// U-76（Wave C，2026-09-26）：run() 可指定引擎副本与挂起阈值 —— 负例把**变异后的引擎副本**写进 _verify 临时目录实跑，
// 证明每条正例断言在对应破坏下会红（不是只测"引擎现在能用"）。引擎无相对 import，复制到别处可直接运行。
// v1.45.9：hangMs 是「挂死探测」不是「时延断言」——引擎的 usage/参数错误应在几十毫秒内退出。
//   实测全量并发下同一个子进程要 4263ms（520 用例同时 spawn 多个 node/pwsh），4s 门槛会给出**假产品红**；
//   放到 15s 仍能抓住真挂死（正常路径 100ms 量级），也不再受并发调度影响。
function run(args, engineFile = engine, hangMs = 15000) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [engineFile, ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    p.stdout.setEncoding('utf8'); p.stderr.setEncoding('utf8');
    p.stdout.on('data', s => { stdout += s; });
    p.stderr.on('data', s => { stderr += s; });
    const timer = setTimeout(() => { p.kill(); reject(new Error(`engine hung for >${hangMs}ms`)); }, hangMs);
    p.on('error', e => { clearTimeout(timer); reject(e); });
    p.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}
async function withServer(handler, body) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/fixture`;
  try { return await body(url); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
const engineSource = fs.readFileSync(engine, 'utf8');
function mutate(text, from, to) {
  const out = text.split(from).join(to);
  assert.notEqual(out, text, `negative control must actually mutate: ${from}`);
  return out;
}
function withMutatedEngine(mutations, body) {
  const tmp = fs.mkdtempSync(path.join(root, '_verify', 'r2neg-'));
  const file = path.join(tmp, 'node-https-engine.mjs');
  let src = engineSource;
  for (const [from, to] of mutations) src = mutate(src, from, to);
  fs.writeFileSync(file, src, 'utf8');
  return Promise.resolve(body(file, tmp)).finally(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
}

test('-d validates positive milliseconds and bounds a never-ending local response', async () => {
  const bad = await run(['-d', '0', 'http://127.0.0.1:1/fixture']);
  assert.equal(bad.code, 2, bad.stderr);
  const result = await withServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' }); res.write('partial');
  }, url => run(['-d', '1200', url]));   // 2026-10-20：130ms 在并发负载下常"没等到响应头就截止" ⇒ stdout 空 ⇒ 假红（实测 8.3s 超时红）。1200ms 仍验证"到点自行收尾"；定时器被删的负例用 1500ms 挂死阈值另测，不受影响。
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /STATUS 200/);
  assert.match(result.stdout, /partial/);
});

test('-X POST -b keeps the literal body (including leading @)', async () => {
  let received;
  const result = await withServer(async (req, res) => {
    let data = '';
    for await (const chunk of req) data += chunk.toString('utf8');
    received = { method: req.method, data };
    res.writeHead(200); res.end('ok');
  }, url => run(['-X', 'POST', '-b', '@literal-body', url]));
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(received, { method: 'POST', data: '@literal-body' });
});

test('-X POST -B reads UTF-8 body from a file, preserving bytes and output file', async () => {
  const tmp = fs.mkdtempSync(path.join(root, '_verify', 'r2-'));
  try {
    const text = JSON.stringify({ title: '京东零售', query: 'RunspacePool', payload: 'a'.repeat(80000) });
    const input = path.join(tmp, 'request.json'), output = path.join(tmp, 'response.txt');
    fs.writeFileSync(input, text, 'utf8');
    let received;
    const result = await withServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      received = { method: req.method, bytes: Buffer.concat(chunks), type: req.headers['content-type'] };
      res.writeHead(200); res.end('收到了');
    }, url => run(['-o', output, '-d', '2000', '-X', 'POST', '-B', input, url]));
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /STATUS 200/);
    assert.equal(received.method, 'POST');
    assert.deepEqual(received.bytes, fs.readFileSync(input));
    assert.match(received.type, /application\/json/);
    assert.equal(fs.readFileSync(output, 'utf8'), '收到了');
  } finally { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('-B points to a missing file => usage error (exit 2) before transport', async () => {
  const absent = path.join(root, '_verify', 'no-such-r2-body.json');
  assert.equal(fs.existsSync(absent), false);
  const result = await run(['-X', 'POST', '-B', absent, 'http://127.0.0.1:1/fixture']);
  assert.equal(result.code, 2, result.stderr);
  assert.match(result.stderr, /-B|body file|ENOENT/i);
});

test('U-76 negative control: dropping -d validation or the deadline timers is detected by the -d gate', async () => {
  await withMutatedEngine([['if (!(v > 0))', 'if (false)']], async file => {
    const bad = await run(['-d', '0', 'http://127.0.0.1:1/fixture'], file);
    assert.notEqual(bad.code, 2, 'without validation, -d 0 no longer yields usage error 2');
  });
  await withMutatedEngine([
    ['const deadlineTimer = setTimeout(finalize, deadlineMs)', 'const deadlineTimer = null'],
    ['req.setTimeout(deadlineMs, finalize)', '// req.setTimeout removed'],
  ], async file => {
    await withServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.write('partial'); },
      url => assert.rejects(run(['-d', '130', url], file, 1500), /engine hung/));
  });
});

test('U-76 negative control: stripping the leading @ from -b is detected', async () => {
  await withMutatedEngine([['body = rest[1]\n', "body = rest[1].replace(/^@/, '')\n"]], async file => {
    let received;
    await withServer(async (req, res) => {
      let data = '';
      for await (const chunk of req) data += chunk.toString('utf8');
      received = data; res.writeHead(200); res.end('ok');
    }, url => run(['-X', 'POST', '-b', '@literal-body', url], file));
    assert.notEqual(received, '@literal-body');
  });
});

test('U-76 negative control: truncating the -B file body or changing its Content-Type is detected', async () => {
  await withMutatedEngine([
    ['body = fs.readFileSync(bodyFile) }', 'body = fs.readFileSync(bodyFile).subarray(0, 16) }'],
    ["headers['Content-Type'] = 'application/json'", "headers['Content-Type'] = 'text/plain'"],
  ], async (file, tmp) => {
    const input = path.join(tmp, 'request.json');
    fs.writeFileSync(input, JSON.stringify({ title: '京东零售', payload: 'a'.repeat(2000) }), 'utf8');
    let received;
    await withServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      received = { bytes: Buffer.concat(chunks), type: req.headers['content-type'] };
      res.writeHead(200); res.end('ok');
    }, url => run(['-d', '2000', '-X', 'POST', '-B', input, url], file));
    assert.notDeepEqual(received.bytes, fs.readFileSync(input));
    assert.doesNotMatch(received.type, /application\/json/);
  });
});

test('U-76 negative control: swallowing an unreadable -B file is detected (no usage error 2)', async () => {
  await withMutatedEngine([["catch (e) { console.error('usage: -B body file unreadable: ' + e.message); process.exit(2) }", "catch (e) { body = '' }"]], async file => {
    const absent = path.join(root, '_verify', 'no-such-r2-body.json');
    const result = await run(['-X', 'POST', '-B', absent, 'http://127.0.0.1:1/fixture'], file);
    assert.notEqual(result.code, 2);
    assert.doesNotMatch(result.stderr, /-B|body file|ENOENT/i);
  });
});

test('PowerShell fallback has no GET-only guard and sends method plus file body', () => {
  const src = sourceAll(path.join(root));
  // D4（2026-09-30）：node 兜底命令/临时文件在 Invoke-ApiNodeOnce，决策在 Invoke-ApiRequest —— 按函数体取（真实调用图），并核公有函数真的调了它。
  const fnBody = (name) => {
    const i = src.indexOf('function ' + name + ' {');
    assert.ok(i >= 0, 'function missing: ' + name);
    let depth = 0;
    for (let j = i; j < src.length; j++) { if (src[j] === '{') depth++; else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(i, j + 1); } }
    throw new Error('unbalanced: ' + name);
  };
  const pub = fnBody('Invoke-ApiRequest');
  // v1.51.0：node 兜底段抽出为 Invoke-ApiNodeFallback（D4 ≤100 行）—— 接线断言随之迁移：
  //   公有函数必须调 helper，helper 必须带 method + body 调 Invoke-ApiNodeOnce（GET-only 守卫仍然禁止）。
  const fallback = fnBody('Invoke-ApiNodeFallback');
  assert.match(pub, /Invoke-ApiNodeFallback -Uri \$Uri/, 'Invoke-ApiRequest must call the node fallback helper');
  assert.match(fallback, /\$nr = Invoke-ApiNodeOnce -nodeExe \$np\.NodeExe -engine \$np\.Engine -Uri \$Uri -Headers \$Headers -Method \$Method -Body \$Body -NodeDeadlineSec \$NodeDeadlineSec -traceUri \$traceUri/, 'fallback helper must call Invoke-ApiNodeOnce with method + body');
  const request = fnBody('Invoke-ApiNodeOnce') + '\n' + fallback + '\n' + pub;
  // U-76：接线断言收成函数，下面用变异文本证明"GET-only 守卫回归 / 丢 -X / 丢 -B / 不清临时文件"都会红。
  const assertFallbackWiring = code => {
    assert.doesNotMatch(code, /\$tlsFallbackUsed/);
    assert.doesNotMatch(code, /-and\s+\$Method\s+-eq\s+'GET'/);
    assert.match(code, /\$nodeArgs\s*\+=\s*'-X',\s*\$Method/);
    assert.match(code, /\$nodeArgs\s*\+=\s*'-B',\s*\$tmpPostFile/);
    assert.match(code, /Remove-Item\s+-LiteralPath\s+\$tmpPostFile/);
  };
  assertFallbackWiring(request);
  for (const [from, to] of [
    ["$nodeArgs += '-X', $Method", "$nodeArgs += '-X', 'GET'"],
    ["$nodeArgs += '-B', $tmpPostFile", "# -B dropped"],
    ['Remove-Item -LiteralPath $tmpPostFile', '# leak $tmpPostFile'],
  ]) {
    const mutated = request.split(from).join(to);
    assert.notEqual(mutated, request, `negative control must actually mutate: ${from}`);
    assert.throws(() => assertFallbackWiring(mutated), assert.AssertionError);
  }
  assert.throws(() => assertFallbackWiring(request + "\nif ($useNode -and $Method -eq 'GET') { }"), assert.AssertionError);
  // R-2b regression: a [string] default null becomes '', so GET must not receive -B.
  const assertGetBodyGuard = code => {
    assert.match(code, /if \(-not \[string\]::IsNullOrEmpty\(\$Body\)\) \{/);
    assert.doesNotMatch(code, /if \(\$null -ne \$Body\) \{/);
  };
  assertGetBodyGuard(request);
  const reverted = request.replace('if (-not [string]::IsNullOrEmpty($Body)) {', 'if ($null -ne $Body) {');
  assert.notEqual(reverted, request, 'negative control must mutate the actual guard');
  assert.throws(() => assertGetBodyGuard(reverted), assert.AssertionError);
  assert.match(request, /Remove-Item\s+-LiteralPath\s+\$tmpPostFile/);
  const harness = fs.readFileSync(path.join(root, 'tests/run-tests.ps1'), 'utf8');
  assert.match(harness, /K = 'post'; A = @\{ Method = 'POST'/);
  assert.match(harness, /\$t_status12\['post'\] -ne 200/);
  assert.match(harness, /R-2 GET 兜底不应携带 POST 参数/);
});
