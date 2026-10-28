// node-https-engine.mjs — system-CA-aware HTTPS engine for multi-platform-searcher.
// Reason: on hosts where an HTTPS-intercepting proxy signs with a root that is only
// present in the Windows system store (not in node/.NET default bundles), the skill's
// PowerShell Invoke-WebRequest TLS handshake fails ("基础连接已经关闭"). Node launched
// with --use-system-ca verifies against the Windows system store and succeeds.
//
// v2.1 (v1.34.1): 支持 POST——`-X <method>`（默认 GET）+ `-b <body>`（自动 application/json 头）。
//   动机：Semantic Scholar batch 引用补全走 POST，MITM 环境下 .NET POST 同样握手失败
//   （ETF 只读链路无 POST 兜底会静默跳过）；POST 走同一 TLS 系统 CA 兜底后补齐该链路。
// v2.2: -B <file> 按原始字节读取请求体；-b <body> 保留原来的字面量语义（@ 开头也不特殊）。
//
// Usage:
//   node --use-system-ca node-https-engine.mjs <url> [Header:Value...]            # body -> stdout
//   node --use-system-ca node-https-engine.mjs -o <outfile> <url> [Header:Value...] # body -> file (UTF-8, recommended)
//   node --use-system-ca node-https-engine.mjs [-o <outfile>] [-d <ms>] [-X <method>] [-b <body> | -B <file>] <url> [Header:Value...]
// Output: first line  "STATUS <code>"   (always on stdout, printed on response headers)
//         remainder   raw response body (UTF-8; to file if -o given)
// Exit:   0 ok (完整 body 或截止收尾), 1 transport/HTTP error, 2 bad usage
import https from 'node:https'
import http from 'node:http'
import fs from 'node:fs'

let outFile = null
let deadlineMs = 25000
let method = 'GET'
let body = null
let rest = process.argv.slice(2)
if (rest[0] === '-o') {
  outFile = rest[1]
  if (!outFile) { console.error('usage: -o <outfile> required'); process.exit(2) }
  rest = rest.slice(2)
}
if (rest[0] === '-d') {
  const v = parseInt(rest[1], 10)
  if (!(v > 0)) { console.error('usage: -d <ms> must be a positive integer'); process.exit(2) }
  deadlineMs = v
  rest = rest.slice(2)
}
if (rest[0] === '-X') {
  method = (rest[1] || 'GET').toUpperCase()
  rest = rest.slice(2)
}
if (rest[0] === '-b') {
  body = rest[1]
  rest = rest.slice(2)
} else if (rest[0] === '-B') {
  const bodyFile = rest[1]
  if (!bodyFile) { console.error('usage: -B <body file> required'); process.exit(2) }
  try { body = fs.readFileSync(bodyFile) }
  catch (e) { console.error('usage: -B body file unreadable: ' + e.message); process.exit(2) }
  rest = rest.slice(2)
}
const url = rest[0]
if (!url) { console.error('usage: node --use-system-ca node-https-engine.mjs [-o <outfile>] [-d <ms>] [-X <method>] [-b <body> | -B <file>] <url> [Header:Value...]'); process.exit(2) }
const headers = { 'User-Agent': 'multi-code-platform-searcher' }
for (const a of rest.slice(1)) {
  const i = a.indexOf(':')
  if (i > 0) headers[a.slice(0, i).trim()] = a.slice(i + 1).trim()
}
const u = new URL(url)
const lib = u.protocol === 'http:' ? http : https
if (body !== null) {
  if (!Object.keys(headers).some(k => k.toLowerCase() === 'content-type')) {
    headers['Content-Type'] = 'application/json'
  }
  if (!Object.keys(headers).some(k => k.toLowerCase() === 'content-length')) {
    headers['Content-Length'] = Buffer.isBuffer(body) ? body.length : Buffer.byteLength(body, 'utf8')
  }
}
const opts = {
  hostname: u.hostname,
  port: u.port || (u.protocol === 'http:' ? 80 : 443),
  path: u.pathname + u.search,
  method,
  headers,
}

// 收尾：把已收集的 body 落盘/输出后正常退出；幂等（截止与 'end' 竞争安全）。
let chunks = []
let total = 0
let finalized = false
function finalize() {
  if (finalized) return
  finalized = true
  clearTimeout(deadlineTimer)
  const buf = Buffer.concat(chunks)
  try {
    if (outFile) { fs.writeFileSync(outFile, buf) }
    else { process.stdout.write(buf.toString('utf8')) }
  } catch (e) { console.error('ERR finalize: ' + e.message); process.exit(1) }
  process.exit(0)
}
// v2: 总时长硬截止（从现在起算）——到点收尾已收 body 正常退出，杜绝永久挂死。
const deadlineTimer = setTimeout(finalize, deadlineMs)

const req = lib.request(opts, (res) => {
  // v2: STATUS 在响应头到达时立即输出，不等 body 结束 —— SSE 长流可能永不 close。
  console.log('STATUS ' + res.statusCode)
  res.on('data', (c) => {
    chunks.push(c); total += c.length
    if (total > 8_000_000) { console.error('ERR body-too-large'); req.destroy(); process.exit(1) }
  })
  res.on('end', finalize)
  res.on('error', (e) => { console.error('ERR ' + (e.code || e.message)); process.exit(1) })
})
req.on('error', (e) => { console.error('ERR ' + (e.code || e.message)); process.exit(1) })
// 空闲超时兜底：连接阶段无响应 / 响应阶段久无数据 → 收尾退出（而非旧版无 STATUS 干等）。
req.setTimeout(deadlineMs, finalize)
if (body !== null) { req.write(body) }
req.end()