// U-267（B3-1，2026-10-26）：离线回放基线（多语料）。
//
// 为什么要它（先量后写）：
//   同一查询活网跑两次，实测差异**不是**"多几个字节"，而是分类会变：
//     · `coverage.ReasonCodes.GitHub: error → deadline`（引擎截止 vs 失败，谁先到就报谁）
//     · `coverage.Verdict: partial → degraded`，`Executed` 成员跟着变
//     · crates 的 `Stars` 其实是**实时下载量**，两次差 ±50
//   ⇒ 活网不可能有稳定基线；B3-2（模块拆分）要求"拆分前后 100% 一致"，所以必须先有回放。
//
// 语料表在 `tests/fixtures/replay/corpora.json`（单一事实源：录制器与门读同一份，避免参数漂移）。
// 回放边界（写在门口，免得被当成万能）：
//   · 只覆盖 **2xx**（接缝在 `Invoke-ApiWebOnce`，成功出口）。失败路径由 u177/u263/u264/u265 各自守。
//   · 只覆盖 **web 路径**；socks 路径回放期直接抛 `replay-unsupported-route`（宁红不静默打网）。
//   · **探活也被冻结**（`MCPS_REPLAY_DIR` 非空 ⇒ 路由直接判 direct/reachable）：否则 `blocked/executed`
//     仍由当前网络决定 —— 这是串行实测抓到的（MCPRegistry 两态翻转）。
//   · 基线只含**录全了**的引擎；本机不可达/403/超时的源在语料表里用 `MCPS_DISABLE` 显式排除。
//
// 四层：
//   A 每份语料：回放两次 ⇒ 差异全部落在已声明时序字段内；遮蔽后逐字节相等；与 baseline 相同；expect 对得上
//   A' 声明表不许腐烂：每条声明至少在一份基线里真实存在
//   B 接缝真的在用：空目录回放必须 loud 失败（读**载荷里的** metrics.ExitCode，不是进程 rc）
//   C 语料驱动：改一个响应 ⇒ 输出必须跟着变
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPwsh } from './r2-ps-run.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = path.join(ROOT, 'multi-platform-searcher.ps1');
const FIXROOT = path.join(ROOT, 'tests', 'fixtures', 'replay');
const TABLE = JSON.parse(fs.readFileSync(path.join(FIXROOT, 'corpora.json'), 'utf8'));
const SCRIPT_VERSION = /^\$VERSION = "([0-9.]+)"$/m.exec(fs.readFileSync(MAIN, 'utf8'))?.[1] ?? '';

// ★已声明的不稳定字段（严格按路径前缀）。多一条未声明 ⇒ 红；声明了在所有基线里都没有 ⇒ 红（防"声明表变垃圾桶"）。
const VOLATILE = [
  '/execution/ledger/runId',   // 每次进程一个 runId（账本主键）
  '/execution/spentMs',        // 墙钟
  '/execution/pools/0/spentMs',
  '/metrics/ElapsedMs',
  '/metrics/EngineMs/',        // 逐引擎耗时（前缀）
  '/metrics/WorkingSetMB',     // 进程内存
];
function isVolatile(p) {
  return VOLATILE.some((v) => (v.endsWith('/') ? p.startsWith(v) : p === v));
}
// ★`/version` 归一化：它是**发版戳**，不是行为。不归一化的话每次 bump 都会让四份基线同时失效
//   —— 那种维护税最后一定会被"重录一下算了"绕过，等于把基线当橡皮。归一化不放松判据：
//   下面额外断言 `payload.version === 脚本 $VERSION`（版本漂移仍会被抓，只是不再冒充"行为变了"）。
const NORMALIZED = ['/version'];
function isNormalized(p) {
  return NORMALIZED.some((v) => (v.endsWith('/') ? p.startsWith(v) : p === v));
}
function isMasked(p) { return isVolatile(p) || isNormalized(p); }

// ---- 平台归一（U-278，v1.60.0：B3-7 跨平台实跑实测出来的两条）----
//  ① **换行风格**：Windows 录制时 `context` 是 CRLF（18 处），同一份输入在 Linux 上是 LF。
//     这是**平台事实**，不是行为差异 —— 归一后两份逐字节相等（实测）。
//     不归一的代价不是"更严格"，而是"基线只能在录像那台机器上绿"，下一个人只会 `-Force` 重录。
//  ② **首次运行提示**：`[first-run] 裸装…` 只在"零令牌 **且** 没有 ripgrep/ugrep"时出现
//     （`lib/doctor.ps1:Get-FirstRunAdvice`）。容器里没有 rg ⇒ 它出现；录制机上 tools/bin 有 rg.exe ⇒ 没出现。
//     这条行为的归属是 **U-237**（三档：裸装 / 有令牌 / 有本地工具），不是回放基线 ——
//     让基线去断言"本机装了什么"只会把环境写进行为证据。
//     ★过滤是**窄**的：只丢以 `[first-run]` 开头的那一条，其余 warning 照样逐字节比（下面 A3 钉住）。
const FIRST_RUN_PREFIX = '[first-run]';

/** 递归把字符串里的 CRLF 归一成 LF */
function canonNewlines(v) {
  if (typeof v === 'string') return v.replace(/\r\n/g, '\n');
  if (Array.isArray(v)) return v.map(canonNewlines);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = canonNewlines(x);
    return out;
  }
  return v;
}

/** 载荷归一：换行 + 去掉环境相关的首次运行提示（其余一律不动） */
function canonPayload(payload) {
  const c = canonNewlines(payload);
  if (c && Array.isArray(c.warnings)) {
    c.warnings = c.warnings.filter((w) => !String(w).startsWith(FIRST_RUN_PREFIX));
  }
  return c;
}
/** 差异路径归一：去掉数组下标与长度标记。 */
function normPath(p) {
  return p.replace(/#len$/, '').replace(/\/\d+$/, '');
}

function diffPaths(a, b) {
  const raw = [];
  const walk = (x, y, p) => {
    if (typeof x !== typeof y) { raw.push(p); return; }
    if (x && y && typeof x === 'object' && typeof y === 'object') {
      if (Array.isArray(x) !== Array.isArray(y)) { raw.push(p); return; }
      if (Array.isArray(x)) {
        if (x.length !== y.length) { raw.push(p); return; }
        x.forEach((_, i) => walk(x[i], y[i], p + '/' + i));
        return;
      }
      for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) walk(x[k], y[k], p + '/' + k);
      return;
    }
    if (x !== y) raw.push(p);
  };
  walk(a, b, '');
  return [...new Set(raw)];
}

function mask(obj) {
  // ★键序也算"不稳定"：`metrics.EngineMs` 是按**完成顺序**插入的（并行池），值一样、顺序按调度变。
  //   对象内键序在 JSON 里没有语义 ⇒ 逐键排序后再比；**数组顺序仍严格比较**（warnings/Executed 的先后是语义）。
  const rec = (v, p) => {
    if (isMasked(p)) return '<volatile>';
    if (Array.isArray(v)) return v.map((it, i) => rec(it, p + '/' + i));
    if (v && typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v).sort()) o[k] = rec(v[k], p + '/' + k);
      return o;
    }
    return v;
  };
  return JSON.stringify(rec(obj, ''));
}

function envFor(spec, extra = {}) {
  const base = {};
  for (const [k, v] of Object.entries(TABLE.commonEnv)) base[k] = v;
  for (const [k, v] of Object.entries(spec.env)) base[k] = v;
  return { ...base, ...extra };
}

async function runCorpus(spec, extraEnv = {}, args = spec.args) {
  const r = await runPwsh(['-File', MAIN, ...args], { timeoutMs: 300000, env: envFor(spec, extraEnv) });
  let payload = null;
  try { payload = JSON.parse((r.stdout || '').trim()); } catch { /* 断言里会打印 */ }
  return { rc: r.status, stdout: r.stdout || '', stderr: r.stderr || '', payload };
}

function loadBaseline(spec) {
  const p = path.join(FIXROOT, spec.name, 'baseline.json');
  assert.ok(fs.existsSync(p), `缺少基线 ${spec.name}/baseline.json（用 tests/u267-record-replay-corpus.ps1 生成）`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

for (const spec of TABLE.corpora) {
  test(`U-267-A[${spec.name}] 两次回放逐字节一致（除已声明时序字段）且与基线一致`, async () => {
    const a = await runCorpus(spec, { MCPS_REPLAY_DIR: path.join(FIXROOT, spec.name) });
    const b = await runCorpus(spec, { MCPS_REPLAY_DIR: path.join(FIXROOT, spec.name) });
    assert.equal(a.rc, 0, `${spec.name} 回放 A rc=${a.rc} stderr=${a.stderr.slice(0, 300)}`);
    assert.equal(b.rc, 0, `${spec.name} 回放 B rc=${b.rc} stderr=${b.stderr.slice(0, 300)}`);
    assert.ok(a.payload && b.payload, `${spec.name} 回放必须产出可解析 JSON`);
    assert.doesNotMatch(a.stderr + b.stderr, /replay-(miss|exhausted|unsupported)/, `${spec.name} 语料不完整或引擎集合变了`);
    // 回放期零探活：探活是真网络请求，决定 blocked/executed（串行实测 MCPRegistry 两态翻转）
    assert.doesNotMatch(a.stdout, /network-(unavailable|route-unproven)/, `${spec.name} 回放期出现探活结论 —— 探活没被冻结`);

    // 期望值（语料表里钉死，防"基线悄悄漂了还以为一致"）
    assert.equal(a.payload.coverage.Verdict, spec.expect.verdict, `${spec.name} Verdict 变了`);
    assert.equal(a.payload.results.length, spec.expect.results, `${spec.name} 结果数变了`);
    assert.deepEqual(a.payload.coverage.Executed, spec.expect.executed, `${spec.name} Executed 变了`);

    const undeclared = diffPaths(a.payload, b.payload).map(normPath).filter((p) => !isMasked(p));
    assert.deepEqual([...new Set(undeclared)], [], `${spec.name} 出现未声明的不稳定字段：` + undeclared.join(', '));
    assert.equal(mask(a.payload), mask(b.payload), `${spec.name} 遮蔽时序字段后两次必须完全相等`);

    const vsBase = diffPaths(canonPayload(a.payload), canonPayload(loadBaseline(spec))).map(normPath).filter((p) => !isMasked(p));
    assert.deepEqual([...new Set(vsBase)], [], `${spec.name} 与基线不一致（确认后用录制器 -Force 重生成）：` + vsBase.join(', '));
    // 版本戳归一化后仍要单独钉一次：载荷自称的版本必须等于脚本 $VERSION（防"基线里冻着一个旧版本"）
    assert.equal(a.payload.version, SCRIPT_VERSION, `${spec.name} 载荷 version ≠ 脚本 $VERSION`);
  });
}

test('U-267-A3 平台归一必须窄：只吃掉换行与 [first-run]，其余 warning 一条都不许吞', () => {
  // 换行：两种写法归一后相同
  assert.equal(canonPayload({ context: 'a\r\nb' }).context, 'a\nb');
  assert.equal(canonPayload({ context: 'a\nb' }).context, 'a\nb');
  // ★只丢 [first-run]：别的 warning（哪怕长得像）必须原样留下，顺序不变
  const w = ['[first-run] 裸装…', '[Gitee] 检索失败：replay-miss', '[coverage] 因缺凭据未请求: (无)'];
  assert.deepEqual(canonPayload({ warnings: w }).warnings, w.slice(1));
  assert.deepEqual(canonPayload({ warnings: ['[first-runner] 不是那个前缀'] }).warnings, ['[first-runner] 不是那个前缀'],
    '前缀匹配不许贪心：`[first-runner]` 不是首次运行提示');
  // 嵌套结构里的换行也要归一（context 在顶层，但别赌它永远在顶层）
  assert.deepEqual(canonPayload({ a: { b: ['x\r\ny'] } }), { a: { b: ['x\ny'] } });
  // 数字/布尔/空值原样
  assert.deepEqual(canonPayload({ n: 1, f: false, z: null }), { n: 1, f: false, z: null });
});

test('U-267-A2 声明表不许腐烂：每条声明至少在一份基线里真实存在', () => {
  const flat = TABLE.corpora.map((s) => JSON.stringify(loadBaseline(s))).join('\n');
  for (const v of VOLATILE) {
    const key = v.replace(/\/$/, '').split('/').pop();
    assert.ok(flat.includes('"' + key + '"'), '声明了但所有基线里都没有这个字段：' + v);
  }
});

test('U-267-B 接缝真的在用：空目录回放必须 loud 失败，不许悄悄打真网', async () => {
  const spec = TABLE.corpora[0];
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'u267-empty-'));
  try {
    const r = await runCorpus(spec, { MCPS_REPLAY_DIR: empty });
    // ★进程 rc 不适用：本项目**故意**只在 Verdict ∈ {none,no-engines} 时让进程非 0
    //   （partial/degraded 表示"查到了但有源被挡"，多源聚合下几乎每轮成立，一律非 0 会变噪声）。
    //   这里要判的是"回放没生效"，所以读**载荷里的** metrics.ExitCode（0/2/3/4 语义）：
    assert.equal(r.payload.metrics.ExitCode, 4, '空语料却报 ExitCode≠4 —— 回放可能没生效');
    assert.match(r.stdout, /replay-miss/, '必须点名 replay-miss');
    assert.equal((r.payload.results || []).length, 0, '没有语料就不该产出结果（产出了说明打了真网或读了缓存）');
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test('U-267-D 固定时钟真的接线：换一个 MCPS_FIXED_NOW ⇒ recency 必须跟着变', async () => {
  // U-268：`recency = exp(−ageDays/365)` 用的是"现在"。不钉住时钟，基线隔几小时就会自己漂
  //   （2026-10-26 全量验收实测：`/results/14/ScoreParts/recency` 在 17:5x 与 19:5x 两份之间不同）。
  //   这条反向断言防的是"加了 env 但函数根本没读"——那种情况下面 A 臂照样绿，问题被掩盖到明天。
  const spec = TABLE.corpora.find((s) => s.name === 'repo-gitee');
  assert.ok(spec, '语料表里应有 repo-gitee');
  const dir = path.join(FIXROOT, spec.name);
  const at = (iso) => runCorpus(spec, { MCPS_REPLAY_DIR: dir, MCPS_FIXED_NOW: iso });
  const old = await at('2020-01-01T00:00:00Z');
  const now = await at('2026-10-26T00:00:00Z');
  const recOf = (p) => (p.results || []).map((r) => r.ScoreParts && r.ScoreParts.recency);
  assert.notDeepEqual(recOf(old.payload), recOf(now.payload), '换了固定时钟但 recency 没变 —— MCPS_FIXED_NOW 没接线');
});

test('U-267-C 语料驱动：把一个响应换成空数组 ⇒ 输出必须跟着变', async () => {
  const spec = TABLE.corpora.find((s) => s.name === 'research-serde');
  assert.ok(spec, '语料表里应有 research-serde');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u267-mut-'));
  try {
    const lines = fs.readFileSync(path.join(FIXROOT, spec.name, 'responses.jsonl'), 'utf8').split('\n').filter((l) => l.trim());
    const idx = lines.findIndex((l) => l.includes('rubygems.org/api/v1/search.json'));
    assert.ok(idx >= 0, '语料里找不到 rubygems 搜索行');
    const row = JSON.parse(lines[idx]);
    assert.notEqual(row.content, '[]', '原语料已经是空数组，变异无意义');
    row.content = '[]';
    lines[idx] = JSON.stringify(row);
    fs.writeFileSync(path.join(dir, 'responses.jsonl'), lines.join('\n') + '\n', 'utf8');

    const base = await runCorpus(spec, { MCPS_REPLAY_DIR: path.join(FIXROOT, spec.name) });
    const mut = await runCorpus(spec, { MCPS_REPLAY_DIR: dir });
    assert.equal(mut.rc, 0, `变异语料回放 rc=${mut.rc} stderr=${mut.stderr.slice(0, 300)}`);
    const names = (p) => (p.results || []).filter((x) => x.Platform === 'RubyGems').map((x) => x.Name);
    assert.notDeepEqual(names(mut.payload), names(base.payload), '改了语料但 RubyGems 结果没变 —— 结果不是从这份语料来的');
    assert.equal(names(mut.payload).length, 0, '空数组应当让 RubyGems 0 条');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
