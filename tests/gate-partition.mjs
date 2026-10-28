// U-153（A5，2026-09-30）：门输出分区 —— 每条红标 env:<kind> 或 product，分别计数。
// 预注册：reports/U-153-预注册判据-2026-09-30.md。
// 原则（fail-closed）：
//   · 缺省 = product。只有命中下面白名单签名（或门显式抛 GateEnvError 且 kind 在白名单内）才记 env。
//   · AssertionError（ERR_ASSERTION）一律 product —— 断言失败从不因报文里恰好出现 EBUSY/ENOENT 而改记 env。
//   · 文件级失败（整文件崩溃、无子测试失败）只看该文件 stderr 里「未捕获异常」那一行，不看诊断输出。
//   · env 红不下调判据：它仍是红（启动器 rc=3），只是不计入 product 红。
// 本文件同时是 node:test 的自定义 reporter（default export），由 tests/run-node-gates.mjs 挂载。

// U-245（v1.53.26，验收 B1-5）：`flaky-parallel` = **并行跑红、同文件串行复核通过**。
//   ★刻意**不**加进 ENV_KINDS：那张表是「门可以显式声明哪些环境症状」的白名单（`[gate-env:kind]`），
//     而本 kind 只由 `runGatesVerified` 的复核结果产生，任何门都不许自己声明成它。
//     单列一个常量，是为了让"字符串只有一处"这条纪律不因为"没进那张表"而破。
export const RECHECK_KIND = 'flaky-parallel';
export const ENV_KINDS = Object.freeze(['spawnsync-ebusy', 'interp-timeout', 'interp-oom', 'safe-delete-shim', 'no-powershell', 'no-network', 'timing']);

// 每条签名只描述「本机已知环境症状」（派工 §1.4）；no-network 没有报文签名 —— 只能由门在取证后显式声明（见 envFailIfOffline）。
export const ENV_SIGNATURES = Object.freeze([
  { kind: 'spawnsync-ebusy', re: /\bspawn(?:Sync)?\b[^\n]*\bEBUSY\b/, note: 'WorkBuddy NODE_OPTIONS shim 拦 spawnSync ⇒ EBUSY' },
  { kind: 'spawnsync-ebusy', re: /\((?:[^()\n]*,)?-(?:Command|File):EBUSY\b/, note: 'U-144 解释器探活全部 EBUSY（D1 文件级：pwsh(-Command:EBUSY)）' },
  // 2026-10-19（全量并发实测）：同一探活在高负载下超时 ⇒ 报文是 `pwsh(-Command:ETIMEDOUT) | powershell(-File:ETIMEDOUT)`。
  //   旧白名单只认 EBUSY ⇒ 落 product ⇒ 把"解释器没验成功、测试一行都没跑"记成产品回归（假红）。
  //   签名刻意收窄到 U-144 的 `${mode}:${code}` 形状（`-(Command|File):CODE`），**不**匹配通用
  //   `{code:'ETIMEDOUT', syscall:'spawnSync pwsh'}` —— 后者可能是门自己挂死，仍应 product（fail-closed）。
  { kind: 'interp-timeout', re: /\((?:[^()\n]*,)?-(?:Command|File):ETIMEDOUT\b/, note: 'U-144 解释器探活超时（高并发/重载；单跑绿）' },
  { kind: 'safe-delete-shim', re: /^\[safe-delete\]/m, note: 'sandbox safe-delete shim（genie-trash ETIMEDOUT / SAFE_DELETE_BULK_CONFIRM_REQUIRED）' },
  { kind: 'no-powershell', re: /\bspawn(?:Sync)? (?:powershell|pwsh)(?:\.exe)? ENOENT\b/i, note: '无 powershell.exe / pwsh（如 Linux 容器）' },
  { kind: 'no-powershell', re: /^not-found: no PowerShell executable found\b/m, note: 'U-144 发现不到任何 PowerShell' },
]);

export const ENV_MARKER = /^\[gate-env:([a-z0-9-]+)\] /;

// U-153 Q2（宿主裁定，2026-09-30）：时序类 —— 与 no-network 同口径，**须凭据**才记 env，否则仍 product。
//   凭据 = 宿主显式声明本次为高并发/重载（U153_TIMING=1|confirmed），或门在取证后抛 GateEnvError('timing')。
//   命中的是**已知的时序信号字串**（单独跑复验为绿的那两条），不是任意超时 —— 以免把真正的产品挂死改记 env。
export const TIMING_SIGNATURES = Object.freeze([
  { re: /\bharness timeout\s*\(\s*\d+\s*s\s*\)/i, note: 'U-114 批量 harness 并发下 40s 超时（单跑绿）' },
  // 2026-10-20：U-114 的**时延断言**（elapsed > 半 p95）原与「条数/错误数不符」共用同一句 throw ⇒ 分不开。
  //   harness 已拆成两句（§38 起）：条数/错误仍 product；只有 elapsed 这句进时序白名单（仍须 U153_TIMING 凭据）。
  { re: /\bU-114 acceptance failed: batch elapsed\b/i, note: 'U-114 批时延超半 p95（并发/重载；单跑绿）' },
  { re: /\bengine hung for >\s*\d+\s*ms\b/i, note: '-d 死线测并发下挂起（单跑绿）' },
]);
export function timingDeclared(env = process.env) {
  const v = String(env.U153_TIMING || '').toLowerCase();
  return v === '1' || v === 'confirmed' || v === 'overload';
}
// 门在「疑似时序超时」处调用（断言之前）：有按时序凭据 => env:timing；否则按 product 抛（不开后门）。
export function envFailIfTiming(detail, env = process.env) {
  if (timingDeclared(env)) envFail('timing', detail + ' [U153_TIMING=' + env.U153_TIMING + ' declared]');
  const e = new Error(detail + ' [no timing evidence => product]'); e.code = 'GATE_PRODUCT_TIMEOUT'; throw e;
}

// U-158E A-2（2026-10-22 v1.49.1）：**payload 自带的环境证据**，不需要宿主声明 U153_TIMING。
//   场景：本机 hosts 把 gitlab.com 指向 127.0.0.1 ⇒ 逐域探活卡住 ⇒ 引擎被截止 ⇒ Executed=[] ⇒ Verdict=none。
//   这与「令牌失效」是两件事：后者是 missing-credential（真产品问题），前者是网络/环境。
// **两条件合取**（缺一不可，fail-closed 的关键）：
//   ① 该引擎的 ReasonCodes 恰为 'deadline'；
//   ② 原因里出现产品自己写的 `network-route-unproven: <host>` —— 且该标记自 v1.49.1 起**只在探活真的没有结论时**保留
//      （v1.49.1 之前占位符在"探活已确认可达"后不撤回，标记贴在正常路由上 ⇒ 当时不敢认它，只能靠 hosts/白名单提示兜底）。
// 为什么不写成"任何 deadline 都算 env"：
//   探活**确认可达**后请求挂死留下的也是 deadline，但那时 reason 里**没有**该标记（探活可达即撤回占位）⇒ 仍是 product。
//   实测依据：`MCPS_ENGINE_DEADLINE=GitLabBlobs=2` 复现的 deadline 原因只有「单引擎超 2s 截止，已停止；network-route-unproven: gitlab.com（探活未完成即被打断）」，
//   而同一台机器探活成功的那次（Verdict=full）reason 是「项目级回退成功（全局搜索 403：该账号层级已关闭）」。
//   两者的差别正是"探活有没有结论"，所以这个标记是产品行为级证据，不是文案巧合。
// 证据必须落在**同一引擎**上：不做跨键拼接（拿 A 的文案给 B 背书是假的归因）。
export const ROUTE_UNPROVEN = /network-route-unproven:\s*([A-Za-z0-9][A-Za-z0-9.-]*)/;
export function deadlineRouteEvidence(coverage) {
  const codes = (coverage && coverage.ReasonCodes) || {};
  const reasons = (coverage && coverage.Reasons) || {};
  const hits = [];
  for (const [engine, code] of Object.entries(codes)) {
    if (String(code) !== 'deadline') continue;
    const r = String(reasons[engine] || '');
    const m = ROUTE_UNPROVEN.exec(r);
    if (!m) continue;
    hits.push({ engine, host: m[1], reason: r });
  }
  return hits;
}
export function formatRouteEvidence(hits) {
  return (hits || []).map(h => h.engine + '@' + h.host).join(',');
}

// 解释器「起不来」与「找不到」是两类症状：ENOENT 是没装/不在 PATH；这里说的是装了但 CoreCLR 载入失败
// （高并发/低可用内存下常见，报文 `Failed to create CoreCLR, HRESULT: 0x8007000E` / `Out Of Memory`）。
// 两者都意味着**测试一行都没跑**，故记 env；但必须由门在拿到子进程输出后**显式声明**，不写进报文签名表 ——
// 否则任何断言里恰好出现 "Out Of Memory" 都会被洗成 env（违背 fail-closed）。
export const INTERP_BROKEN = /Failed to load System\.Private\.CoreLib\.dll|Failed to create CoreCLR|HRESULT:\s*0x8007000E|Out Of Memory/i;
export function envFailIfInterpBroken(detail) {
  const s = String(detail || '');
  if (INTERP_BROKEN.test(s)) envFail('interp-oom', s.split('\n').map(x => x.trim()).filter(Boolean).slice(0, 2).join(' | ').slice(0, 240));
}

export class GateEnvError extends Error {
  constructor(kind, detail) {
    if (!ENV_KINDS.includes(kind)) throw new Error('U-153: unknown env kind "' + kind + '" (allowed: ' + ENV_KINDS.join(', ') + ')');
    super('[gate-env:' + kind + '] ' + detail);
    this.name = 'GateEnvError'; this.code = 'GATE_ENV'; this.envKind = kind;
  }
}
export function envFail(kind, detail) { throw new GateEnvError(kind, detail); }

// 网络取证：宿主显式声明 U153_NETWORK=offline，或 DNS 解析已知可达域名失败（R94 教训：探针目标必须已知可达；不用 baidu）。
export async function networkOffline({ env = process.env, host = 'www.qq.com', lookup, timeoutMs = 3000 } = {}) {
  if ((env.U153_NETWORK || '').toLowerCase() === 'offline') return { offline: true, evidence: 'U153_NETWORK=offline' };
  if ((env.U153_NETWORK || '').toLowerCase() === 'online') return { offline: false, evidence: 'U153_NETWORK=online' };
  const doLookup = lookup ?? (await import('node:dns')).promises.lookup;
  try {
    await Promise.race([doLookup(host), new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('dns timeout'), { code: 'ETIMEOUT' })), timeoutMs).unref?.())]);
    return { offline: false, evidence: 'dns ' + host + ' ok' };
  } catch (e) {
    const code = e && e.code;
    if (['ENOTFOUND', 'EAI_AGAIN', 'ETIMEOUT', 'ECONNREFUSED'].includes(code)) return { offline: true, evidence: 'dns ' + host + ' ' + code };
    return { offline: false, evidence: 'dns ' + host + ' ' + (code || 'error') + ' (not an offline signature)' };
  }
}
// 门在「疑似无出网」处调用：有离线证据 ⇒ env 红；否则按 product 红抛出（不给产品挂死开后门）。
export async function envFailIfOffline(detail, opts) {
  const n = await networkOffline(opts);
  if (n.offline) envFail('no-network', detail + ' [' + n.evidence + ']');
  const e = new Error(detail + ' [network reachable: ' + n.evidence + ' ⇒ product]'); e.code = 'GATE_PRODUCT_TIMEOUT'; throw e;
}

// U-275（v1.57.0，验收 B3-4）：**第三类红 `meta`** —— 红了，但红在"仓库记账/度量自身"上，不是产品结论。
//
// 病灶（B3-4 前的口径）：113 个静态门（只读源码/清单/文档断言）里，有一小撮的主体根本不是产品行为，
//   而是**本仓自己的账**：发布清单是否覆盖全、版本锚点是否同步、Statement 是否重生成、锁文件是否互斥、
//   docs 与代码的锚点是否对上。这些门红了，十有八九是"某个文件要改"，但记账时一律算 product ⇒
//   product_red 里混着"文档落后"和"引擎真崩了"两种东西，读的人只能一条条点开看。
//
// 判据（三条，缺一不可 —— 这是**分类**不是**放行**）：
//   ① 只有**显式登记**在 `tests/static-quota.json` 的 `meta` 名单里的门才可能是 meta。
//      默认 = product。登记是人的判断（"这个门红了我先去改文件"），不是读报文猜的 —— 报文可以被改，
//      文件名也可以被改，但"谁进了名单"是能审的。
//   ② **env 优先**：环境症状（no-network / EBUSY / 解释器没起来）在**任何**门里都先记 env，
//      不许因为门恰好在 meta 名单里就把"机器没测成"记成"文件要改"。
//   ③ meta 红**仍然是红**：退出码 5（避开产品 4=degraded），发布器同样拒绝。分层改的是"谁去看"，
//      不是"能不能发"。`.gate-green.json` 里 product_red 与 meta_red 分列，两个都必须为 0。
//
// 为什么 meta 名单只能缩不能长（`tests/static-quota.json` + U-275）：这些门的存在本身是笔账 ——
//   静态断言便宜、但证据弱（"文本里有这句"不等于"行为正确"，也不等于"缺陷不存在"）。
//   名单能悄悄变长，就等于给自己发了一张"把产品红改叫 meta 红"的许可。
export const META_EXIT = 5;
const basename = (p) => String(p || '').replace(/\\/g, '/').split('/').pop();

// 输入：错误形状 { message, code, name, syscall, cause, isAssertion } 或字符串。输出 { cls: 'env'|'product', kind, why }。
export function classifyFailure(input) {
  const e = typeof input === 'string' ? { message: input } : (input || {});
  const cause = e.cause && typeof e.cause === 'object' ? e.cause : null;
  const code = (cause && cause.code) || e.code || '';
  const name = (cause && cause.name) || e.name || '';
  const msg = String((cause && cause.message) || e.message || '');
  const syscall = String((cause && cause.syscall) || e.syscall || '');
  const marker = ENV_MARKER.exec(msg);
  if (marker) {
    return ENV_KINDS.includes(marker[1])
      ? { cls: 'env', kind: marker[1], why: 'explicit GateEnvError' }
      : { cls: 'product', kind: null, why: 'unknown env marker "' + marker[1] + '" ⇒ product (fail-closed)' };
  }
  if (e.isAssertion || code === 'ERR_ASSERTION' || name === 'AssertionError') return { cls: 'product', kind: null, why: 'assertion' };
  if (code === 'EBUSY' && /^spawn/.test(syscall)) return { cls: 'env', kind: 'spawnsync-ebusy', why: 'code EBUSY syscall ' + syscall };
  if (code === 'ENOENT' && /^spawn(?:Sync)? (?:powershell|pwsh)(?:\.exe)?$/i.test(syscall)) return { cls: 'env', kind: 'no-powershell', why: 'code ENOENT syscall ' + syscall };
  // 裸命令名找不到 ⇒ 环境（U-278）。带分隔符的 syscall 不在此列：那是脚本路径错了，仍是 product。
  for (const s of ENV_SIGNATURES) if (s.re.test(msg)) return { cls: 'env', kind: s.kind, why: 'signature ' + s.re };
  for (const s of TIMING_SIGNATURES) if (s.re.test(msg)) {
    if (timingDeclared()) return { cls: 'env', kind: 'timing', why: 'timing signature + U153_TIMING declared: ' + s.re };
    return { cls: 'product', kind: null, why: 'timing signature without U153_TIMING evidence (fail-closed ⇒ product): ' + s.re };
  }
  return { cls: 'product', kind: null, why: 'no env signature' };
}

// 文件级失败：从 stderr 取「未捕获异常」行（Node 打印的 `Error: …` / `XxxError [CODE]: …`），只用它分类。
export function uncaughtLine(stderr) {
  const lines = String(stderr || '').split(/\r?\n/);
  let hit = null;
  for (const l of lines) if (/^(?:[A-Z][A-Za-z]*)?Error(?: \[[A-Z0-9_]+\])?: /.test(l)) hit = l;
  return hit;
}

function errShape(err) {
  if (!err || typeof err !== 'object') return { message: String(err ?? '') };
  const c = err.cause && typeof err.cause === 'object' ? err.cause : null;
  return {
    message: err.message, code: err.code, name: err.name, syscall: err.syscall,
    cause: c ? { message: c.message, code: c.code, name: c.name, syscall: c.syscall } : null,
  };
}

// node:test 自定义 reporter：收集失败 ⇒ 结束时输出一行 JSON（写到 --test-reporter-destination 指定的文件）。
export default async function* gatePartitionReporter(source) {
  const stderrByFile = new Map(); const fails = []; let passes = 0; let skips = 0;
  for await (const ev of source) {
    const d = ev.data || {};
    if (ev.type === 'test:stderr' && d.file) stderrByFile.set(d.file, (stderrByFile.get(d.file) || '') + (d.message || ''));
    else if (ev.type === 'test:pass') { if (d.skip) skips++; else if (!d.details?.type || d.details.type === 'test') passes++; }
    else if (ev.type === 'test:fail') {
      const err = d.details?.error; const ft = err?.failureType;
      if (ft === 'subtestsFailed' || ft === 'cancelledByParent') continue;   // 父节点/连带取消：只计真正失败的叶子
      fails.push({ name: d.name, file: d.file || null, line: d.line ?? null, fileLevel: !!(d.file && d.name === d.file), err: errShape(err) });
    }
  }
  const reds = fails.map(f => {
    let c;
    if (f.fileLevel) {
      const line = uncaughtLine(stderrByFile.get(f.file));
      c = line ? classifyFailure({ message: line.replace(/^(?:[A-Z][A-Za-z]*)?Error(?: \[[A-Z0-9_]+\])?: /, ''), name: /^AssertionError/.test(line) ? 'AssertionError' : '' })
        : { cls: 'product', kind: null, why: 'file-level failure without an uncaught error line' };
      if (line) c.evidence = line.slice(0, 300);
    } else c = classifyFailure(f.err);
    return { ...f, ...c, message: String(f.err.cause?.message || f.err.message || '').split('\n')[0].slice(0, 300) };
  });
  yield JSON.stringify({ schema: 'u153-gate-partition/1', passes, skips, reds }) + '\n';
}

// 汇总：把 reporter 输出与 preload 记下的 env 事件（被 shim 拦下的清理）合成最终分区。
// U-245：抽出 `repartition` —— **串行复核后要用同一把尺子重新计数**（复核把某条从 product 挪到 env，
//   计数、byKind、退出码必须一起变）。两处各写一遍计数，就是又一次"两份实现"。
// U-275：`metaFiles` 是**门文件 basename 的集合**（来自 tests/static-quota.json 的 meta 名单）。
//   缺省 `null` ⇒ 没有 meta，全部按 product —— fail-closed。用 basename 而不是绝对路径，
//   是因为复核会拿沙盒副本里的同名门重跑（U-153 就是这么干的），按相对路径匹配会让副本静默变成 product。
export function repartition(reds, extra = {}, { metaFiles = null } = {}) {
  const metaKeys = metaFiles instanceof Set ? metaFiles : new Set(metaFiles || []);
  // `cls === 'meta'` 也算：这个值只可能由本函数产生（reporter 只会给 env/product），
  //   于是"重分区时漏传名单"不会把已经归好的 meta 红悄悄降级成 product（反方向的假账）。
  const isMeta = (r) => r.cls !== 'env' && (r.cls === 'meta' || (metaKeys.size > 0 && metaKeys.has(basename(r.file))));
  const product = reds.filter((r) => r.cls !== 'env' && !isMeta(r));
  const meta = reds.filter(isMeta).map((r) => ({
    ...r, cls: 'meta',
    why: 'L1 记账门（tests/static-quota.json 已登记：修文件即可，但不是产品结论）' + (r.why ? '；原归类 ' + r.why : ''),
  }));
  const env = reds.filter((r) => r.cls === 'env');
  const byKind = {};
  for (const r of env) byKind[r.kind] = (byKind[r.kind] || 0) + 1;
  return { ...extra, productRed: product.length, envRed: env.length, metaRed: meta.length, envByKind: byKind, product, env, meta };
}
export function summarize(report, envEvents = [], opts = {}) {
  const reds = [...(report?.reds || [])];
  for (const ev of envEvents) reds.push({ name: ev.op + ' ' + (ev.target || ''), file: ev.file || null, cls: 'env', kind: ev.kind, why: 'preload intercepted cleanup (' + ev.op + ')', message: String(ev.message || '').split('\n')[0].slice(0, 300) });
  return repartition(reds, {}, opts);
}
// 退出码：product 红 ⇒ 1；只有 meta 红 ⇒ 5（修文件）；只有 env 红 ⇒ 3（仍非 0：env 红不是绿）；全清 ⇒ 0。
//   ★优先级 product > meta > env：product 是最强的结论，不能被"同轮还有一个文档红"降级成 5。
export function exitCodeFor(summary, childCode) {
  if (summary.productRed > 0) return 1;
  if (summary.metaRed > 0) return META_EXIT;
  if (summary.envRed > 0) return 3;
  return childCode === 0 ? 0 : 1;   // 子进程非 0 却没有任何可归类的红 ⇒ 视作 product（fail-closed）
}
