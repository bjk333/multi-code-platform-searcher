// U-286（B3-15，v1.68.0）：**CLI 级**行为臂的底座 —— 把夹具跑出来的响应重建成回放语料，再让整个产品跑一遍。
//
// 为什么需要这一层（先量后写）：
//   行为层（engines*.test.mjs）点源产品、直接调 `Search-X`。它能证明"引擎怎么读响应"，
//   但证明不了**主流程怎么汇总**：零产出覆盖率、缺凭据单列、慢源标注、门禁文案 —— 这些都在
//   `multi-platform-searcher.ps1` 里，只有**跑整个 CLI** 才看得见。此前这些契约只能用静态门
//   （grep 源码里的 `-ge 3`、`Add-EngineWarning`）守，而静态门恰好看不见"跑起来到底告警了没有"。
//
// 怎么做到离线且确定：
//   `lib/http.ps1` 早有一条回放接缝（U-267）：`MCPS_REPLAY_DIR` 非空 ⇒ `Invoke-ApiWebOnce` 先查
//   `responses.jsonl`（键 = sha256(method \n uri \n body) 前 16 位），命中就返回录制内容，一个字节都不打网。
//   于是：**夹具跑一次引擎 → 按夹具记录重建 responses.jsonl → 跑 CLI**。三件事都不用改产品。
//
// 为什么"重建"而不是"录制"：
//   产品的录制口（`Save-ApiReplayFixture`）只在**成功出口**写盘（`Invoke-WebRequestDirect` 返回之后），
//   4xx/5xx 走的是异常路径 ⇒ 录不到。而这一层最想测的恰恰是失败分档。
//   夹具记录里已经有"这条请求被哪条路由服务"（`hit.route`），状态码/头/正文都在，重建比录制更完整。
//
// 重建的自证（★这一条最重要）：
//   原 URI 由 `https://{host}{path}` 反推。反推错了会怎样？回放键不匹配 ⇒ `replay-miss` ⇒ 引擎
//   被 catch 成 0 命中 ⇒ **看起来像"源没数据"**（U-284 刚因为这个白查了半天）。
//   所以探针把改写前的 URI 原样带回来（`payload.uris`），这里逐条对账：反推值必须与原始值全等，
//   长度也必须一致。对不上就当场报错，绝不把"键不匹配"降级成"零命中"。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { startFixture } from './fixture-server.mjs';
import { runEngine, ROOT } from './engine-probe.mjs';
import { runPwsh } from '../../r2-ps-run.mjs';

const MAIN = path.join(ROOT, 'multi-platform-searcher.ps1');
const PLANNER = path.join(ROOT, 'query-planner.ps1');

/** 与产品 `Get-ApiReplayKey` 同构：sha256(method \n uri \n body) 的前 16 位十六进制 */
export function replayKey(method, uri, body = '') {
  const raw = `${String(method || 'GET').toUpperCase()}\n${uri}\n${body || ''}`;
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 16);
}

/** 建一个临时回放目录（调用方负责在用完后 rm -rf，或交给 OS 清理） */
export function makeReplayDir(tag = 'cli') {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mcps-replay-${tag}-`));
}

/**
 * 用真夹具跑一遍引擎，把它发出的每个请求**重建成一行回放记录**。
 *
 * @param {object} spec  { fn, params, status, routes, scheme? }
 * @param {string} dir   回放目录（可多次追加，最终写一份 responses.jsonl）
 * @returns {{rows: object[], hits: object[], payload: object}}  便于调用方复算断言
 */
export async function recordFromFixture(spec, dir) {
  const scheme = spec.scheme || 'https';
  const fx = await startFixture(spec.routes);
  let payload = null;
  try {
    const r = await runEngine({
      fn: spec.fn,
      params: { ...spec.params, __statusName: spec.status },
      port: fx.port,
      env: spec.env || {},
      // 探针模板会把令牌清空（臂的判据不许随本机 .env 漂移）；要"带令牌"的分支只能在这里显式设回。
      preamble: spec.preamble || '',
    });
    payload = r.payload;
    if (!payload) throw new Error(`探针没吐 JSON（${spec.fn}）：` + String(r.stderr).slice(-600));
  } finally {
    await fx.close();
  }

  if (fx.unmatched.length) {
    throw new Error(`有请求没打到夹具路由，重建会漏行：${JSON.stringify(fx.unmatched.map((h) => h.host + h.path))}`);
  }
  const uris = payload.uris || [];
  if (uris.length !== fx.hits.length) {
    // 一个"逐次调用"的计数对不上，说明有一侧在偷偷合并/丢弃请求 —— 那会让重建的语料与真实请求错位。
    throw new Error(`原始 URI 数 ${uris.length} 与夹具命中数 ${fx.hits.length} 不一致（${spec.fn}）`);
  }

  const rows = [];
  fx.hits.forEach((h, i) => {
    const rebuilt = `${scheme}://${h.host}${h.path}`;
    if (rebuilt !== uris[i]) {
      throw new Error(
        `原 URI 反推不一致（${spec.fn} 第 ${i + 1} 次）：\n  原始=${uris[i]}\n  反推=${rebuilt}\n` +
        '  ⇒ 回放键会算错；别把这条当成"源没数据"。'
      );
    }
    const route = h.route;
    if (!route) throw new Error(`第 ${i + 1} 次请求没有记录服务它的路由（${spec.fn}）`);
    rows.push({
      key: replayKey(h.method, rebuilt, h.body),
      method: h.method,
      uri: rebuilt,
      status: route.status || 200,
      headers: normalizeHeaders(route.headers),
      content: typeof route.body === 'string' ? route.body : JSON.stringify(route.body ?? {}),
    });
  });

  // 追加写：一次 CLI 可能由多个引擎的语料拼成
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'responses.jsonl');
  fs.appendFileSync(file, rows.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8');
  return { rows, hits: fx.hits, payload };
}

function normalizeHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h || {})) out[k.toLowerCase()] = String(v);
  return out;
}

/** 读回放语料（改一改再写回去，用于"同一请求换个响应"的臂） */
export function readReplay(dir) {
  const file = path.join(dir, 'responses.jsonl');
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
}

export function writeReplay(dir, rows) {
  fs.writeFileSync(path.join(dir, 'responses.jsonl'), rows.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8');
}

/**
 * 按 host 改响应（只改匹配到的行）。用于构造"同一个查询、某个源换结局"的臂：
 * 语料形状仍来自真夹具，改的只是那一个源的字节。
 */
export function patchByHost(dir, hostRe, patch) {
  const rows = readReplay(dir);
  let n = 0;
  for (const r of rows) {
    const host = new URL(r.uri).host;
    if (!hostRe.test(host)) continue;
    n++;
    if (patch.status !== undefined) r.status = patch.status;
    if (patch.headers) r.headers = { ...(r.headers || {}), ...normalizeHeaders(patch.headers) };
    if (patch.content !== undefined) r.content = typeof patch.content === 'string' ? patch.content : JSON.stringify(patch.content);
  }
  if (!n) throw new Error(`patchByHost 一条也没改到（${hostRe}）—— 语料里没有这个 host？`);
  writeReplay(dir, rows);
  return n;
}

/** 只保留匹配 host 的行（其余删掉）—— 用于"这个源不该被请求"的负例 */
export function pruneHosts(dir, keepRe) {
  const rows = readReplay(dir).filter((r) => keepRe.test(new URL(r.uri).host));
  writeReplay(dir, rows);
  return rows.length;
}

/**
 * 跑整个 CLI（离线回放）并解析 JSON 载荷。
 * ★`MCPS_REPLAY_DIR` 非空时探活被冻结成 direct/reachable（lib/net.ps1），所以连"可达性"都可复现。
 */
export async function runCli({ replayDir, args, env = {}, timeoutMs = 240000, healthFile, streakFile }) {
  const e = {
    MCPS_REPLAY_DIR: replayDir,
    MCPS_HEALTH: '0',
    MCPS_FIXED_NOW: '2026-10-26T00:00:00Z',
    MCPS_PROXY: '',
    // 令牌一律清空：否则"缺凭据"这类臂会随本机 .env / 宿主环境漂移
    GITHUB_TOKEN: '', GITLAB_TOKEN: '', GITEE_TOKEN: '', SE_KEY: '', SRC_TOKEN: '',
    MCPS_OPENALEX_API_KEY: '', MCPS_OPENALEX_MAILTO: '', MCPS_SE_SITE: '', DEEPSEEK_API_KEY: '',
    // 健康/连击状态都在临时目录：断言"没写状态"时不能受上一次跑影响
    MCPS_HEALTH_FILE: healthFile || path.join(os.tmpdir(), `mcps-cli-health-${process.pid}-${Math.random().toString(36).slice(2)}.json`),
    MCPS_ZERO_STREAK_FILE: streakFile || path.join(os.tmpdir(), `mcps-cli-streak-${process.pid}-${Math.random().toString(36).slice(2)}.json`),
    ...env,
  };
  const t0 = Date.now();
  const r = await runPwsh(['-File', MAIN, ...args], { env: e, timeoutMs });
  let payload = null;
  try { payload = JSON.parse(r.stdout); } catch { /* 下面用 ok=false 报 */ }
  return { ...r, payload, ok: !!payload, env: e, stdout: r.stdout, ms: Date.now() - t0 };
}

/**
 * 跑**查询规划器**（`query-planner.ps1`，产品的第二个入口）。
 *
 * 为什么它也算"执行产品"：规划器的输出（`queryType` / `engineCandidates`）决定主脚本跑哪几个池，
 *   是用户可见行为的上游。此前它的词表与夹具只被静态门 grep（"源码里有没有 implement 这个词"），
 *   而那恰好是**改词表最容易假绿**的地方：词在、但没生效（大小写、词边界、被 strip 掉）。
 *
 * ★不设 `MCPS_NO_ENVFILE` 之类：规划器是纯本地计算，不读 .env、不打网、不落盘（不给 `-OutputPath`）。
 */
export async function runPlanner(query, { timeoutMs = 60000, extraArgs = [] } = {}) {
  const r = await runPwsh(['-File', PLANNER, '-Query', query, ...extraArgs], { timeoutMs });
  let plan = null;
  try { plan = JSON.parse(r.stdout); } catch { /* 下面用 ok=false 报 */ }
  return { ...r, plan, ok: !!plan };
}

/** 找告警（payload.warnings 是字符串数组；不假设顺序） */
export function warningMatching(payload, re) {
  return (payload?.warnings || []).filter((w) => re.test(String(w)));
}

/** 断言产物是合法 JSON（否则"解析失败"会被读成"某字段为空"） */
export function requirePayload(r, label) {
  if (!r.payload) {
    throw new Error(`${label}: CLI 没吐出可解析的 JSON（rc=${r.status}）\nSTDOUT:${String(r.stdout).slice(-800)}\nSTDERR:${String(r.stderr).slice(-800)}`);
  }
  return r.payload;
}
