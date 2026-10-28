// N-8 offline structural gate. The actual PS 5.1/PS 7 behavior must be rechecked on host.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceAll } from './lib/source.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// U-100 C-1 门跟随（2026-09-28，先于搬迁落地）：引擎实现允许外置到 engines/*.ps1，
// 因此"按函数名/函数体"做的断言必须在 **主脚本 + engines/** 的合并源上做。
//   · engines/ 不存在或为空时，合并源 === 原源 ⇒ **惰性**，不影响现状；
//   · 搬迁后断言强度**不变**（搬迁是位移，不是放宽）。
//   · 仍按"主文件"单独读取的门（如 guardU23 读 Cfg）保持只读主脚本 —— 见各门自身。
const enginesDir = path.join(root, 'engines');
const engineSrc = fs.existsSync(enginesDir)
  ? fs.readdirSync(enginesDir).filter((f) => f.endsWith('.ps1')).sort()
      .map((f) => fs.readFileSync(path.join(enginesDir, f), 'utf8')).join('\n')
  : '';
const source = sourceAll(path.join(root));
// D4（2026-09-30，U-100）：Invoke-ApiRequest 拆成 11 个顶层 helper（全部为 Get-HttpLayerClosure 成员）。
//   本文件所有"HTTP 层"断言改在 **真实调用图** 上做：request = Invoke-ApiRequest + 它传递调用的 D4 helper 的函数体拼接
//   （按函数名取体，不再取"从 Invoke-ApiRequest 到 Wait-RateLimitToken 的宽切片"——宽切片会把陈旧副本也算进去）。
//   D4_HELPERS 是白名单：每个都必须 (a) 顶层定义 (b) 被 Invoke-ApiRequest 传递调用 (c) 在闭包内 —— 见下方 D4 门。
const D4_HELPERS = ['Write-TlsTrace', 'Get-TraceUri', 'Get-RetryBackoff', 'Get-ApiRequestRouteContext', 'Invoke-ApiSocksOnce', 'Invoke-ApiWebOnce', 'Invoke-ApiNodeFallback',
  'Resolve-ApiHttpFailure', 'Get-ApiNodePaths', 'Invoke-ApiNodeOnce', 'Update-ApiRetryCounters', 'Test-ApiRetryBudget', 'Get-ApiWallBudget'];
function httpLayerText(text) {
  return ['Invoke-ApiRequest', ...D4_HELPERS].map((n) => psFunctionBody(text, n)).join('\n');
}
const begin = source.indexOf('function Invoke-ApiRequest {');
const end = source.indexOf('function Wait-RateLimitToken {', begin);
assert.ok(begin > 0 && end > begin);
const request = httpLayerText(source);

test('Invoke-ApiRequest handles PS5 WebException and PS7 HttpRequestException explicitly', () => {
  assert.match(request, /catch\s*\[System\.Exception\]\s*\{/);
  assert.doesNotMatch(request, /catch\s*\[System\.Net\.WebException\]/);
  assert.match(request, /System\.Net\.Http\.HttpRequestException/);
  assert.match(request, /Microsoft\.PowerShell\.Commands\.HttpResponseException/);
  assert.match(request, /\$httpErr\s*-is\s*\[System\.Net\.WebException\]/);
  assert.match(request, /\$resp\s*=\s*\$httpErr\.Response/);
});

test('non-HTTP exceptions immediately rethrow before TLS fallback or retry handling', () => {
  assert.match(request, /if\s*\(-not\s*\$isHttpFailure\)\s*\{\s*throw\s*\}/);
  const harness = fs.readFileSync(path.join(root, 'tests/run-tests.ps1'), 'utf8');
  assert.match(harness, /n8-non-http/);
  assert.match(harness, /function global:Invoke-WebRequest\s*\{\s*throw/);
  assert.match(harness, /Remove-Item\s+Function:global:Invoke-WebRequest/);
});

// Static mutation controls complement (never replace) host PS 5.1 + PS 7 functional gates.
function guardU01(text) {
  // D4：异常链分类/传输失败置空在 Resolve-ApiHttpFailure；node 兜底守卫在 Invoke-ApiRequest —— 顺序断言改为"公有函数先调 Resolve 再判 -not $resp"。
  const body = psFunctionBody(text, 'Resolve-ApiHttpFailure');
  assert.ok(body.includes("GetType().FullName -eq 'System.Net.Http.HttpRequestException'"), 'U-01 transport chain');
  const reset = body.indexOf('if ($isTransport) { $resp = $null }');
  assert.ok(reset >= 0, 'U-01 transport must clear response before node fallback');
  const pub = psFunctionBody(text, 'Invoke-ApiRequest');
  const resolve = pub.indexOf('$fail = Resolve-ApiHttpFailure -ErrorRecord $_ -reqSw $reqSw');
  const fallback = pub.indexOf('if (-not $resp) {', resolve);
  assert.ok(resolve >= 0 && fallback > resolve, 'U-01 transport must clear response before node fallback');
}
test('U-01 negative control: reverting transport reset makes the static gate fail', () => {
  guardU01(source);
  const broken = source.replace('if ($isTransport) { $resp = $null }', 'if ($isTransport) { $resp = $httpErr.Response }');
  assert.notEqual(broken, source);
  assert.throws(() => guardU01(broken), /U-01 transport must clear response/);
});

function guardU02(text) {
  const body = httpLayerText(text);   // D4：正规化在 Resolve-ApiHttpFailure（真实调用图）
  assert.ok(body.includes('$resp = [PSCustomObject]@{ StatusCode = $httpCode; Headers = $httpHeaders; Body = $httpBody }'), 'U-02 normalized HTTP response');
  assert.ok(body.includes('$httpBody = $errorBody }'), 'U-02 consumed PS7 body fallback');
  // U-41 (2026-09-26): both closures now derive from the single source Get-HttpLayerClosure, which must list Test-RateLimit403.
  assert.ok(/function Get-HttpLayerClosure \{[\s\S]*?'Test-RateLimit403'[\s\S]*?\}/.test(text), 'U-02 Runspace dependency closure (single source lists Test-RateLimit403)');
  assert.ok((text.match(/foreach \(\$fn in \(Get-HttpLayerClosure\)\)/g) || []).length >= 2, 'U-02 nested Runspace closure (both consumers derive from single source)');
}
test('U-02 negative control: reverting normalized/body-only response makes the static gate fail', () => {
  guardU02(source);
  const oldShape = source.replace('Body = $httpBody }', 'Body = $null }');
  assert.notEqual(oldShape, source);
  assert.throws(() => guardU02(oldShape), /U-02 normalized HTTP response/);
  const droppedBody = source.replace('$httpBody = $errorBody }', '$httpBody = $httpBody }');
  assert.notEqual(droppedBody, source);
  assert.throws(() => guardU02(droppedBody), /U-02 consumed PS7 body fallback/);
});

// ---------- U-40 / U-15 / U-23 (2026-09-26, R13 batch 1): offline structural gates ----------
// Real PS 5.1 / PS 7 behaviour (with and without HTTP_PROXY) must still be recorded on host (N-16 rule).
function guardU40(src) {
  const fnBegin = src.indexOf('function Invoke-WebRequestDirect {');
  const fnEnd = src.indexOf('function Get-ProcessProxyEnvSummary {', fnBegin);
  if (fnBegin < 0 || fnEnd < fnBegin) throw new Error('U-40 Invoke-WebRequestDirect missing');
  const fn = src.slice(fnBegin, fnEnd);
  if (!/PSEdition -eq 'Core'/.test(fn) || !/\$Params\['NoProxy'\] = \$true/.test(fn)) throw new Error('U-40 Core path must set Invoke-WebRequest -NoProxy');
  if (!/GetEmptyWebProxy\(\)/.test(fn) || !/finally\s*\{[\s\S]*DefaultWebProxy = \$prevProxy/.test(fn)) throw new Error('U-40 Desktop path must swap DefaultWebProxy and restore in finally');
  const req = httpLayerText(src);   // D4：IWR 调用在 Invoke-ApiWebOnce（真实调用图）
  if (!/Invoke-WebRequestDirect -Params \$reqParams -Direct:\$NoProxy/.test(req)) throw new Error('U-40 Invoke-ApiRequest direct path must go through Invoke-WebRequestDirect');
  // v1.53.7：本断言只锚**语义**（调用必须传 -NoProxy:$NoProxy + -reqSw），不锚 `return (` 字面形状 ——
  //   成功路径要登记代理熔断，必须先接住返回值（`$webRes = Invoke-ApiWebOnce ...`）；死锚会把正确实现判红
  //   （与 U-188 B 同类）。$ 一律写成 [$] 字符类，避免正则转义在某些编辑链路上被吃掉。
  if (!/Invoke-ApiWebOnce -Uri [$]Uri [^\n]*-NoProxy:[$]NoProxy -reqSw [$]reqSw/.test(psFunctionBody(src, 'Invoke-ApiRequest'))) throw new Error('U-40 Invoke-ApiRequest must call Invoke-ApiWebOnce with -NoProxy:$NoProxy');
  if (/\$r = Invoke-WebRequest @reqParams/.test(req)) throw new Error('U-40 bare Invoke-WebRequest @reqParams still present');
  return true;
}
function guardU15(src) {
  const cfg = src.indexOf('$script:Cfg = @{');
  const retry = src.indexOf('$script:_retryBudget = ');
  const rate = src.indexOf('$ghSearchRate = ');
  if (!(cfg > 0 && cfg < retry && cfg < rate)) throw new Error('U-15 Cfg must be defined before top-level _retryBudget/ghSearchRate (else they evaluate to $null)');
  if (/\$ghSearchRate = 10\.0\/60/.test(src) || /\$script:_retryBudget = 6\b/.test(src)) throw new Error('U-15 magic rate/budget literal still present');
  for (const key of ['TimeBudgetDefaultSec', 'RetryBudget', 'GhSearchRateAnonPerMin', 'GhSearchRateAuthPerMin', 'GiteeSoPageMin', 'GiteeSoPageMax', 'GhCodeOverfetchFactor', 'GhCodeOverfetchMax', 'NpmPopularityScale', 'DoctorResearchProbeSec', 'EngineDeadlineByEngine', 'EngineDeadlineCodeSec', 'EngineDeadlineRepoSec']) {
    if (!new RegExp('^\\s*' + key + '\\s*=', 'm').test(src)) throw new Error('U-15/U-23 Cfg key missing: ' + key);
  }
  const tb = src.slice(src.indexOf('function Get-TimeBudgetSec {'), src.indexOf('}', src.indexOf('function Get-TimeBudgetSec {')) + 1);
  if (/return 120/.test(tb)) throw new Error('U-15 Get-TimeBudgetSec still returns literal 120');
  return true;
}
function guardU23(src) {
  const b = src.indexOf('function Invoke-EnginePool {');
  if (b < 0) throw new Error('Invoke-EnginePool missing');
  const pool = src.slice(b, b + 12000);
  if (!/EngineDeadlineByEngine/.test(pool) || !/\$dlSec = \$EngineDeadlineSec/.test(pool)) throw new Error('U-23 per-engine deadline lookup missing in Invoke-EnginePool');
  if (/\$remainMs = \[int\]\(\$EngineDeadlineSec \* 1000/.test(pool)) throw new Error('U-23 remainMs must use per-engine $dlSec');
  if (!/并发代码检索' -TrackStatus -EngineDeadlineSec \$script:Cfg\.EngineDeadlineCodeSec/.test(src)) throw new Error('U-17 code path must pass Cfg.EngineDeadlineCodeSec');
  // U-63：repo 路径也必须接线（此前 Cfg.EngineDeadlineRepoSec 定义了但没人用）；U-62/U-63：置值后不得再回到 0
  if (!/并发搜索' -TrackStatus -EngineDeadlineSec \$script:Cfg\.EngineDeadlineRepoSec/.test(src)) throw new Error('U-63 repo path must pass Cfg.EngineDeadlineRepoSec');
  const code = src.match(/EngineDeadlineCodeSec = (\d+)/), repo = src.match(/EngineDeadlineRepoSec = (\d+)/);
  if (!code || +code[1] < 10 || !repo || +repo[1] < 10) throw new Error('U-63 deadlines must be set (>=10s) from the measured p95, not 0');
  // U-62/U-63 重定值（2026-09-27，U-87 两轮上包络分档）：表内 8 源必须有正值，且不得低于分档下限 —— 退回旧值/清零直接红。
  // ★U-243（v1.53.25，验收 B1-7）：`Packages = 28` 拆成 Npm(11) / Crates(10) / Maven(8)。
  //   28 原本是"一个引擎串行跑三个上游"的总预算；拆开后每个上游各自测、各自定值（实测 npm 0.85–3.04s、
  //   crates 0.53–1.14s、Maven 0.65–1.97s，均见 06-实施记录-B1.md §B1-7）。
  //   floor 取**当前值本身**：本门从此守"不许再调小"，而不是替新源编造一个没测过的下限。
  const table = src.match(/EngineDeadlineByEngine = @\{([^}]*)\}/);
  if (!table) throw new Error('U-62 per-engine deadline table missing');
  const dl = Object.fromEntries([...table[1].matchAll(/([A-Za-z0-9]+)\s*=\s*(\d+)/g)].map(m => [m[1], +m[2]]));
  const floors = { Npm: 13, Crates: 10, Maven: 8, SE: 25, HackerNews: 22, DockerHub: 29, NuGet: 27, arXiv: 26 };
  for (const [name, floor] of Object.entries(floors)) {
    if (!(dl[name] >= floor)) throw new Error(`U-62/U-63 deadline for ${name} must be >= ${floor}s (two-round envelope tiering), got ${dl[name]}`);
  }
  // A 档同档抬值：默认研究截止须覆盖 HF 15.22s / RubyGems 15.15s；code 须覆盖 GitHubCode 15.03s；repo 须覆盖 Codeberg 26.16s
  const dflt = src.match(/^\s*EngineDeadlineSec = (\d+)/m);
  if (!dflt || +dflt[1] < 17) throw new Error('U-62 A-档 default research deadline must clear the 15.22s envelope (>=17s)');
  if (+code[1] < 17) throw new Error('U-63 A-档 code deadline must clear the 15.03s GitHubCode envelope (>=17s)');
  if (+repo[1] < 29) throw new Error('U-63 A-档 repo deadline must clear the 26.16s Codeberg envelope (>=29s)');
  return true;
}

test('U-40: -NoProxy is a real direct connection on both runtimes (Core -NoProxy / Desktop empty DefaultWebProxy)', () => {
  assert.ok(guardU40(source));
});
test('U-40 negative control: reverting to bare Invoke-WebRequest is detected', () => {
  const reverted = source.replace('$r = Invoke-WebRequestDirect -Params $reqParams -Direct:$NoProxy', '$r = Invoke-WebRequest @reqParams');
  assert.notEqual(reverted, source);
  assert.throws(() => guardU40(reverted), /U-40/);
});
test('U-15: Cfg is defined before top-level consumers and strategy literals are gone', () => {
  assert.ok(guardU15(source));
});
test('U-15 negative control: moving Cfg back below _retryBudget is detected', () => {
  const cfgStart = source.indexOf('$script:Cfg = @{');
  const cfgEnd = source.indexOf('\n}\n', cfgStart) + 3;
  const block = source.slice(cfgStart, cfgEnd);
  const without = source.slice(0, cfgStart) + source.slice(cfgEnd);
  // v1.54.0（B3-2）：函数已搬进 lib/，「插到某个函数之前」不再等于"插到顶层求值之后"。
  //   负例的语义是"Cfg 定义晚于 _retryBudget/ghSearchRate 的求值" ⇒ 锚点改为主流程起始行（必在其后）。
  const anchor = without.indexOf('# ---------- 主流程（dot-source 时跳过');
  assert.ok(anchor > without.indexOf('$script:_retryBudget = '), '锚点必须在 _retryBudget 之后，否则负例形同虚设');
  const movedBack = without.slice(0, anchor) + block + without.slice(anchor);
  assert.notEqual(movedBack, source);
  assert.throws(() => guardU15(movedBack), /U-15 Cfg must be defined before/);
});
test('U-23/U-17: per-engine deadline lookup and code-path wiring', () => {
  assert.ok(guardU23(source));
});
test('12e prints proxy environment and asserts the direct mode (N-16b)', () => {
  const harness = fs.readFileSync(path.join(root, 'tests/run-tests.ps1'), 'utf8');
  assert.match(harness, /\[test-inject\/12e\] env-proxy=\$t_proxyEnv edition=/);
  assert.match(harness, /LastRequestProxyMode -ne \$t_expectMode/);
});

// ---------- U-40 runspace dependency + N-17 header guards (2026-09-26) ----------
test('U-40: Get-EngineNeeds injects Invoke-WebRequestDirect wherever Invoke-ApiRequest is needed (U-02 typology)', () => {
  const b = source.indexOf('function Get-EngineNeeds {');
  const blk = source.slice(b, source.indexOf('function Get-DisabledEngineSpecs {', b));
  // U-41: derived from Get-HttpLayerClosure (single source) instead of a per-function hand-written line
  assert.match(blk, /foreach \(\$fn in \(Get-HttpLayerClosure\)\) \{ if \(\$needs -notcontains \$fn\) \{ \$needs \+= \$fn \} \}/);
  assert.ok(closureList(source).includes('Invoke-WebRequestDirect'));
});
test('N-17: GitHubCode reads Deprecation/Sunset headers and lists Get-HeaderValue in Needs', () => {
  assert.match(source, /Get-HeaderValue -Headers \$ghResp\.Headers -Name 'Sunset'/);
  assert.match(source, /Name = 'GitHubCode'[^\n]*'Get-HeaderValue'\)/);
  assert.match(source, /function Get-HeaderValue \{/);
});
test('N-17 negative control: dropping Get-HeaderValue from GitHubCode Needs is detected', () => {
  const reverted = source.replace(",'Get-HeaderValue') },", ") },");
  assert.notEqual(reverted, source);
  assert.doesNotMatch(reverted, /Name = 'GitHubCode'[^\n]*'Get-HeaderValue'\)/);
});

// ---------- U-41 (N-18): HTTP-layer closure must be single-sourced and complete ----------
function psFunctionBody(src, name) {
  const i = src.indexOf('function ' + name + ' {');
  if (i < 0) throw new Error('function missing: ' + name);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(i, j + 1); }
  }
  throw new Error('unbalanced: ' + name);
}
function closureList(src) {
  const body = psFunctionBody(src, 'Get-HttpLayerClosure');
  const m = body.match(/return @\(([^)]*)\)/);
  if (!m) throw new Error('U-41 Get-HttpLayerClosure must return a literal array');
  return m[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
}
// U-41/U-74: mutate the member inside the actual single-source closure, not a stale adjacent-name literal.
function withoutClosureMember(src, member) {
  const body = psFunctionBody(src, 'Get-HttpLayerClosure');
  assert.ok(closureList(src).includes(member), 'closure member missing before mutation: ' + member);
  const changed = body.replace(`'${member}', `, '');
  assert.notEqual(changed, body, 'mutation must remove the named member from the real closure: ' + member);
  return src.replace(body, changed);
}
function psStripLineComments(text) {
  return String(text).split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');
}
function transitiveCustomCalls(src, root) {
  const defs = new Set([...src.matchAll(/^function\s+([A-Za-z][\w-]+)/gm)].map(m => m[1]));
  const seen = new Set(); const stack = [root];
  while (stack.length) {
    const n = stack.pop(); if (seen.has(n)) continue; seen.add(n);
    // v1.68.0（U-286）：**整行注释不算调用**。此前把函数体原样丢给正则，于是一句
    //   "它不在 Get-HttpLayerClosure 里" 的注释就能让 BFS 走进那个函数，再顺着它的字符串清单
    //   把 50 个闭包成员全算成"可达" —— 下面那条"删掉调用 ⇒ 报 not reachable"的负控就是这么变绿的。
    //   只剔**整行**注释（`^\s*#`），不碰行尾 `#`：后者在 URL/颜色值里合法（`#L42`、`'#F00'`），
    //   按行尾切会把真代码吃掉。
    const body = psStripLineComments(psFunctionBody(src, n));
    for (const tok of body.matchAll(/(?<![\w$-])([A-Z][a-z]+-[A-Za-z0-9]+)/g)) {
      if (defs.has(tok[1]) && !seen.has(tok[1])) stack.push(tok[1]);
    }
  }
  return [...seen];
}
function guardU41(src) {
  const closure = closureList(src);
  if (!closure.includes('Get-HttpLayerClosure')) throw new Error('U-41 closure must include itself (it is dot-sourced into runspaces)');
  if (/\$script:HttpLayerClosure/.test(psFunctionBody(src, 'Get-HttpLayerClosure'))) throw new Error('U-41 closure must not read $script: variables');
  const needed = transitiveCustomCalls(src, 'Invoke-ApiRequest');
  const missing = needed.filter(n => !closure.includes(n));
  if (missing.length) throw new Error('U-41 HTTP-layer closure is missing: ' + missing.join(', '));
  // both consumers derive from the single source
  const needs = psFunctionBody(src, 'Get-EngineNeeds');
  if (!/foreach \(\$fn in \(Get-HttpLayerClosure\)\)/.test(needs)) throw new Error('U-41 Get-EngineNeeds must derive from Get-HttpLayerClosure');
  // U-167（2026-10-04）：GitLab 嵌套池已从 `Search-GitLabBlobs` **抽到** `Invoke-GitLabProjectBlobSearch`
  //   （逐字搬运，仍从单源派生）。⇒ 判据从「钉在某个函数里」改为**扫全部函数**，且比原来**更严**：
  //   ① 仍必须存在「从 Get-HttpLayerClosure 派生」的池子（意图不许丢）；
  //   ② **任何**函数都不得再出现手工列表（原判据只查一个函数 ⇒ 换个函数就能绕过）。
  const allFns = [...src.matchAll(/^function\s+([A-Za-z][\w-]+)/gm)].map(m => m[1]);
  const hosts = allFns.filter(n => /foreach \(\$fn in \(Get-HttpLayerClosure\)\)/.test(psFunctionBody(src, n)));
  if (!hosts.length) throw new Error('U-41 GitLab nested pool must derive from Get-HttpLayerClosure (nowhere found)');
  const handWritten = allFns.filter(n => /@\('Get-ApiHeaders', 'Test-RateLimit403', 'Invoke-ApiRequest'\)/.test(psFunctionBody(src, n)));
  if (handWritten.length) throw new Error('U-41 GitLab nested pool still has the hand-written list in: ' + handWritten.join(', '));
  return { closure, needed, poolHosts: hosts };
}
test('U-41: HTTP-layer closure is single-sourced and covers every custom command Invoke-ApiRequest transitively calls', () => {
  const r = guardU41(source);
  assert.ok(r.needed.includes('Invoke-WebRequestDirect') && r.needed.includes('Test-RateLimit403') && r.needed.includes('Write-ColorOutput'));
});
test('U-41 negative control: removing Invoke-WebRequestDirect from the closure names the missing function', () => {
  const reverted = withoutClosureMember(source, 'Invoke-WebRequestDirect');
  assert.notEqual(reverted, source);
  assert.throws(() => guardU41(reverted), /missing: .*Invoke-WebRequestDirect/);
});
test('U-41 negative control: restoring the hand-written nested-pool list is detected', () => {
  const reverted = source.replace("foreach ($fn in (Get-HttpLayerClosure)) {\n                    if (Test-Path \"function:$fn\") { $defs2", "foreach ($fn in @('Get-ApiHeaders', 'Test-RateLimit403', 'Invoke-ApiRequest')) {\n                    if (Test-Path \"function:$fn\") { $defs2");
  assert.notEqual(reverted, source);
  assert.throws(() => guardU41(reverted), /GitLab nested pool/);
});

// ---------- U-42 (N-19) / U-43 (N-20) offline guards (2026-09-26) ----------
test('U-42: test-retry readiness probe and all localhost stub calls bypass process proxies; SKIP carries a reason', () => {
  const harness = fs.readFileSync(path.join(root, 'tests/run-tests.ps1'), 'utf8');
  assert.match(harness, /Invoke-WebRequestDirect -Params @\{ Uri = "http:\/\/127\.0\.0\.1:\$t_portA\/probe"/, 'probe must be a real direct request');
  assert.doesNotMatch(harness, /\$null = Invoke-WebRequest -Uri "http:\/\/127\.0\.0\.1:\$t_portA\/probe"/, 'bare Invoke-WebRequest probe must be gone');
  const stubCalls = harness.match(/Invoke-ApiRequest -Uri "http:\/\/127\.0\.0\.1:\$t_port[A-Z]\/[^"]*"[^\n]*/g) || [];
  assert.ok(stubCalls.length >= 3, 'expected the three stub calls');
  for (const c of stubCalls) assert.match(c, /-NoProxy/, 'localhost stub call must be -NoProxy: ' + c);
  assert.match(harness, /\[test-retry\] TEST_SKIP \(\$t_skipReason\)/, 'SKIP must carry a reason');
  assert.match(harness, /\$t_skipReason = \("python mock unavailable: probe-error=/, 'reason must include probe error + env-proxy');
});
test('U-43: GitHub code search has its own 10/min bucket and GitHubCode lists Wait-RateLimitToken in Needs', () => {
  assert.match(source, /GhCodeSearchRatePerMin = 10/);
  assert.match(source, /"github-code"\s*=\s*@\{[^\n]*GhCodeSearchRatePerMin \/ 60\.0/);
  const code = psFunctionBody(source, 'Search-GitHubCode');
  assert.match(code, /Wait-RateLimitToken -Bucket "github-code"/);
  assert.match(source, /Name = 'GitHubCode'[^\n]*'Wait-RateLimitToken'/);
  assert.doesNotMatch(source, /code search 可用' \}/, 'keyMatrix wording must not claim 10→30 for code search');
});
test('U-43 negative control: pointing code search at the 30/min repo bucket is detected', () => {
  const reverted = source.replace('Wait-RateLimitToken -Bucket "github-code"', 'Wait-RateLimitToken -Bucket "github-search"');
  assert.notEqual(reverted, source);
  assert.doesNotMatch(psFunctionBody(reverted, 'Search-GitHubCode'), /Wait-RateLimitToken -Bucket "github-code"/);
});

// ================= Wave A (R16, 2026-09-26): U-49 mirror / U-50 / U-52 / U-53 =================
const harnessSrc = fs.readFileSync(path.join(root, 'tests/run-tests.ps1'), 'utf8');
const definedFns = new Set([...source.matchAll(/^function\s+([A-Za-z][\w-]+)/gm)].map(m => m[1]));
function stripPsComments(s) { return s.split('\n').map(l => l.replace(/(^|\s)#.*$/, '$1')).join('\n'); }
function customCallsIn(body) {
  const b = stripPsComments(body);
  return new Set([...b.matchAll(/(?<![\w$-])([A-Z][a-z]+-[A-Za-z0-9]+)/g)].map(m => m[1]).filter(n => definedFns.has(n)));
}
function registry(src) {
  const rows = [...src.matchAll(/@\{ Name = '([^']+)';[^\n]*?Func = '([^']+)';\s*Needs = @\(([^)]*)\)/g)];
  return rows.map(m => ({ name: m[1], func: m[2], needs: m[3].split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean) }));
}
// U-49 (offline mirror of the runtime Assert-EngineDeps extension): three-way check, report engine + function.
function guardU49(src) {
  const closure = closureList(src);
  const problems = [];
  for (const e of registry(src)) {
    if (!definedFns.has(e.func)) { problems.push(`${e.name}: Func ${e.func} not defined`); continue; }
    const set = new Set([e.func, ...e.needs]);
    const usesHttp = set.has('Invoke-ApiRequest');
    // U-74 (N-22): the old `!set.has(fn) && !closure.includes(fn)` was vacuously false for fn ∈ closure (dead assertion).
    // Real assertion = the ACTUAL injection path: Get-EngineNeeds expands HTTP engines with the closure, so its text must derive from it
    // and the expanded set (needs ∪ closure) must ⊇ closure. Mirror of the runtime check (which now calls Get-EngineNeeds).
    if (usesHttp) {
      const needsFn = psFunctionBody(src, 'Get-EngineNeeds');
      if (!/foreach \(\$fn in \(Get-HttpLayerClosure\)\)/.test(needsFn)) problems.push(`${e.name}: Get-EngineNeeds no longer expands the HTTP closure`);
      const expanded = new Set([...set, ...(/foreach \(\$fn in \(Get-HttpLayerClosure\)\)/.test(needsFn) ? closure : [])]);
      for (const fn of closure) if (!expanded.has(fn)) problems.push(`${e.name}: expanded needs lack closure member ${fn}`);
    }
    const effective = new Set([...set, ...(usesHttp ? closure : [])]);
    // D4（2026-09-30）：与运行时 Assert-EngineDeps 同步 —— 扫 Func+Needs+闭包 全部成员的函数体（闭包成员之间的调用，如 Invoke-ApiWebOnce → Invoke-WebRequestDirect，否则漏检）。
    for (const fn of [...effective]) {
      if (!definedFns.has(fn)) continue;
      for (const c of customCallsIn(psFunctionBody(src, fn))) {
        if (!effective.has(c)) problems.push(`${e.name}: ${fn} calls ${c} (not in Func+Needs+closure)`);
      }
    }
  }
  return problems;
}
test('U-49 (mirror): every engine Func exists and Func+Needs(+HTTP closure) covers all custom commands in their bodies', () => {
  const p = guardU49(source);
  assert.deepEqual(p, [], 'engine dependency gaps: ' + p.join(' | '));
});
test('U-74 negative control: removing Invoke-WebRequestDirect from the closure makes assertion ③ report "Invoke-ApiWebOnce calls Invoke-WebRequestDirect" (D4: the real caller)', () => {
  const reverted = withoutClosureMember(source, 'Invoke-WebRequestDirect');
  assert.notEqual(reverted, source);
  const p = guardU49(reverted);
  assert.ok(p.some(x => /Invoke-ApiWebOnce calls Invoke-WebRequestDirect/.test(x)), p.join(' | '));
  // D4：闭包成员之间的调用也在扫描范围内 —— 去掉 Resolve-ApiHttpFailure 必须报 "Invoke-ApiRequest calls Resolve-ApiHttpFailure"
  const p2 = guardU49(withoutClosureMember(source, 'Resolve-ApiHttpFailure'));
  assert.ok(p2.some(x => /Invoke-ApiRequest calls Resolve-ApiHttpFailure/.test(x)), p2.join(' | '));
});
test('U-74 negative control: Get-EngineNeeds that stops expanding the closure is reported', () => {
  const reverted = source.replace('foreach ($fn in (Get-HttpLayerClosure)) { if ($needs -notcontains $fn) { $needs += $fn } }', '# expansion removed');
  assert.notEqual(reverted, source);
  const p = guardU49(reverted);
  assert.ok(p.some(x => /Get-EngineNeeds no longer expands the HTTP closure/.test(x)), p.join(' | '));
});
test('U-49 negative control: dropping Get-HeaderValue from GitHubCode Needs is reported as "GitHubCode: Search-GitHubCode calls Get-HeaderValue"', () => {
  const reverted = source.replace(",'Get-HeaderValue') },", ") },");
  assert.notEqual(reverted, source);
  const p = guardU49(reverted);
  assert.ok(p.some(x => /^GitHubCode: Search-GitHubCode calls Get-HeaderValue/.test(x)), p.join(' | '));
});
// U-50: every defined Search-* is either registered or explicitly declared top-level-only.
const TOP_LEVEL_ONLY = ['Search-LocalCode', 'Search-SearchCodeRepo', 'Search-DepsDevPackage'];   // +v1.46.3 Search-DepsDevPackage（deps.dev 精确包，主进程串行、不进 Runspace、不需要 Keyword）   // local ripgrep/ugrep, no network, called directly from the main flow (:3231), never inside a Runspace；+v1.39.0 Search-SearchCodeRepo（searchcode 仓库级，-RepoScope 条件通道，主进程串行调用）
test('U-50: every Search-* function is registered as an engine Func or listed in TOP_LEVEL_ONLY', () => {
  const funcs = new Set(registry(source).map(e => e.func));
  const missing = [...definedFns].filter(n => n.startsWith('Search-') && !funcs.has(n) && !TOP_LEVEL_ONLY.includes(n));
  assert.deepEqual(missing, [], 'unregistered Search-*: ' + missing.join(','));
  for (const n of TOP_LEVEL_ONLY) assert.ok(definedFns.has(n) && new RegExp(n + ' -(Keyword|PackageSpec)').test(source), n + ' must exist and be called at top level');
});
// U-52: loopback / private-address requests must go through the direct path.
function guardU52(files) {
  const bad = [];
  const loop = /(127\.0\.0\.1|localhost|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)/;
  for (const [name, text] of files) {
    text.split('\n').forEach((line, i) => {
      const code = line.replace(/(^|\s)#.*$/, '');
      if (!loop.test(code)) return;
      if (/Invoke-WebRequest\b/.test(code) && !/Invoke-WebRequestDirect/.test(code) && !/function global:Invoke-WebRequest/.test(code) && !/-NoProxy/.test(code)) bad.push(`${name}:${i + 1}: bare Invoke-WebRequest to loopback`);
      if (/Invoke-ApiRequest\b/.test(code) && !/-NoProxy/.test(code) && !/function Invoke-ApiRequest/.test(code)) bad.push(`${name}:${i + 1}: Invoke-ApiRequest to loopback without -NoProxy`);
    });
  }
  return bad;
}
test('U-52: no loopback/private-address request bypasses the direct path (reports line numbers)', () => {
  const bad = guardU52([['multi-platform-searcher.ps1', source], ['tests/run-tests.ps1', harnessSrc]]);
  assert.deepEqual(bad, [], bad.join(' | '));
});
test('U-52 negative control: restoring the bare readiness probe is reported with its line number', () => {
  const reverted = harnessSrc.replace(/Invoke-WebRequestDirect -Params @\{ Uri = "http:\/\/127\.0\.0\.1:\$t_portA\/probe"[^\n]*/, '$null = Invoke-WebRequest -Uri "http://127.0.0.1:$t_portA/probe" -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop } catch { }');
  assert.notEqual(reverted, harnessSrc);
  const bad = guardU52([['tests/run-tests.ps1', reverted]]);
  assert.ok(bad.length === 1 && /tests\/run-tests\.ps1:\d+: bare Invoke-WebRequest to loopback/.test(bad[0]), bad.join(' | '));
});
// U-53: _injectVars must (a) only name variables that exist at top level and (b) cover every external variable engines reference.
function injectVars(src) {
  const m = src.match(/^\$script:_injectVars = @\(([^)]*)\)/m);
  return m[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
}
const PS_AUTO = new Set(['_', 'args', 'matches', 'Matches', 'sender', 'EventArgs', 'null', 'true', 'false', 'this', 'input', 'Matches', 'LASTEXITCODE', 'ErrorActionPreference', 'Host', 'PSScriptRoot', 'PSCommandPath', 'MyInvocation', 'PWD', 'PID', 'HOME', 'env', 'script', 'global', 'using', 'PSVersionTable', 'IsWindows', 'IsLinux', 'IsMacOS', 'Error', 'PSItem', 'ExecutionContext', 'PSCulture', 'OutputEncoding', 'ProgressPreference', 'VerbosePreference', 'WarningPreference', 'InformationPreference', 'ConfirmPreference', 'PSDefaultParameterValues', 'PSBoundParameters', 'PSCmdlet', 'foreach', 'switch', 'StackTrace', 'NestedPromptLevel', 'PSHOME', 'ShellId']);
// F4/U-53: a param block can contain attribute calls (ValidateSet), quoted commas/parentheses,
// and nested defaults. Match its balanced parentheses and split only at top-level commas.
function psParamNames(body) {
  const names = new Set();
  const add = field => {
    const bare = field.replace(/^\s*(?:\[[^\]]*\]\s*)*/, ''); // attributes and type annotations
    const m = bare.match(/^\$([A-Za-z_]\w*)\b/);
    if (m) names.add(m[1]);
  };
  for (const m of body.matchAll(/\bparam\s*\(/g)) {
    let parens = 1, brackets = 0, quote = null, field = '';
    for (let i = m.index + m[0].length; i < body.length; i++) {
      const ch = body[i];
      if (quote !== null) {
        field += ch;
        if (ch === '`' && i + 1 < body.length) { field += body[++i]; continue; }
        if (ch === quote) {
          if (body[i + 1] === quote) field += body[++i]; // PowerShell doubled quote
          else quote = null;
        }
        continue;
      }
      if (ch === "'" || ch === '"') { quote = ch; field += ch; continue; }
      if (ch === '[') brackets++;
      else if (ch === ']') brackets--;
      else if (ch === '(') parens++;
      else if (ch === ')') { if (--parens === 0) { add(field); break; } }
      if (ch === ',' && parens === 1 && brackets === 0) { add(field); field = ''; }
      else field += ch;
    }
    if (parens !== 0) throw new Error('U-53 unterminated param(...) block');
  }
  return names;
}
function externalVarsOf(src, fnName) {
  const body = stripPsComments(psFunctionBody(src, fnName));
  const params = psParamNames(body);
  // assignments (incl. `$script:x = …`, which merely creates the variable inside the runspace) and foreach variables are local
  const locals = new Set([...body.matchAll(/\$(?:script:)?([A-Za-z_]\w*)\s*(?:=|\+=|-=)/g)].map(m => m[1]).concat([...body.matchAll(/foreach \(\$([A-Za-z_]\w*) in/g)].map(m => m[1])));
  const out = new Set();
  for (const m of body.matchAll(/\$(?:script:)?([A-Za-z_]\w*)(?![\w:])/g)) {
    const v = m[1];
    if (PS_AUTO.has(v) || params.has(v) || locals.has(v)) continue;
    out.add(v);
  }
  return out;
}
test('U-53: _injectVars names real top-level variables and covers every external variable referenced by engine Func+Needs', () => {
  const iv = injectVars(source);
  const undeclared = iv.filter(v => !new RegExp('^\\$(?:script:)?' + v.replace(/[$]/g, '\\$') + '\\s*=', 'm').test(source) && !new RegExp('^\\s*\\[[^\\]]*\\]\\$' + v + '\\b', 'm').test(source) && !new RegExp('^\\s*\\$' + v + '\\s*[,=)]', 'm').test(source));
  assert.deepEqual(undeclared, [], 'injectVars entries with no top-level definition: ' + undeclared.join(','));
  const missing = new Set();
  const closure = closureList(source);
  for (const e of registry(source)) {
    const fns = new Set([e.func, ...e.needs, ...(e.needs.includes('Invoke-ApiRequest') ? closure : [])]);
    for (const fn of fns) if (definedFns.has(fn)) for (const v of externalVarsOf(source, fn)) if (!iv.includes(v)) missing.add(`${e.name}:${fn} -> $${v}`);
  }
  assert.deepEqual([...missing], [], 'external variables not injected: ' + [...missing].join(' | '));
});
test('U-53 negative control: removing _rlBuckets from _injectVars names the variable', () => {
  const reverted = source.replace("'_rlBuckets', ", '');
  assert.notEqual(reverted, source);
  const iv = injectVars(reverted);
  assert.ok(!iv.includes('_rlBuckets'));
  const missing = [];
  for (const e of registry(reverted)) for (const fn of [e.func, ...e.needs]) if (definedFns.has(fn)) for (const v of externalVarsOf(reverted, fn)) if (!iv.includes(v)) missing.push(v);
  assert.ok(missing.includes('_rlBuckets'), 'expected _rlBuckets to be reported, got: ' + missing.join(','));
});
test('U-53/F4: decorated parameters and nested defaults are local; a truly missing parameter remains external', () => {
  const fixture = [
    'function Test-DecoratedParam {',
    "  param([uri]$Target, $Route, [ValidateSet('HEAD','GET')][string]$Method, [string]$Tail = (Get-Date -Format 'hh)mm,ss'), [string]$After)",
    '  $Target; $Route; $Method; $Tail; $After; $script:_rlBuckets',
    '}'
  ].join('\n');
  assert.deepEqual([...externalVarsOf(fixture, 'Test-DecoratedParam')], ['_rlBuckets']);
  assert.ok(!externalVarsOf(source, 'Invoke-NetworkProbeOnce').has('Method'), 'actual ValidateSet $Method is a formal parameter');
  const reverted = fixture.replace("][string]$Method, ", "][string]$Alternative, ");
  assert.notEqual(reverted, fixture);
  assert.deepEqual([...externalVarsOf(reverted, 'Test-DecoratedParam')].sort(), ['Method', '_rlBuckets'].sort());
});

// N-25（R19 §3，2026-09-26）：最后一次尝试不得白等退避。Invoke-ApiRequest 的 while 内共 3 处 `Start-Sleep -Seconds $wait`
// （代理路径 / node TLS 兜底路径 / 主路径），每处在"算出 $wait"之后、"Start-Sleep"之前必须有 `if ($attempt -ge $maxAttempts) { break }`。
// 行为判据在 run-tests.ps1 第 5 组 U-24(b)（<900ms）由宿主实跑；这里只守"三处判定都在"，防止下次有人只修一处。
// U-83（R24 §4，2026-09-26）：退避策略**单源** —— 策略只允许存在于内嵌函数 Get-RetryBackoff（WaitSec / TooLong / HasNext），
// 三个调用点（代理 / node TLS 兜底 / 主路径）只做 `if (-not $bo.HasNext) { break }` + `Start-Sleep -Seconds $bo.WaitSec`。
// 门形态从"数 3 处判定"改为"数 1 处策略 + 每个 sleep 都按 HasNext 判定"。
// （复用上方 stripPsComments）
function assertNoIdleBackoffOnLastAttempt(code) {
  const plain = stripPsComments(code);
  // ① 策略单源：RetryBaseSec 幂、Retry-After 取 max、HasNext 判定都只在 Get-RetryBackoff 里出现一次
  const helperMatches = [...plain.matchAll(/function Get-RetryBackoff \{/g)];
  assert.equal(helperMatches.length, 1, 'exactly one Get-RetryBackoff definition inside Invoke-ApiRequest');
  const helper = psFunctionBody(plain, 'Get-RetryBackoff');
  // U-160 L3：退避改 AWS Full Jitter ⇒ 上限 Uₙ = min(cap, base·2ⁿ) 在 Get-RetryBackoff 内算一次
  //（封顶从"事后 TooLong 判定"变为"公式内封顶"；这是策略变更，期望随之下调/上调到新形状，不弱化）
  assert.match(helper, /\[math\]::Min\(\[double\]\$script:Cfg\.MaxRetryWaitSec, \[math\]::Pow\(\[double\]\$script:Cfg\.RetryBaseSec, \$Attempt\)\)/);
  // U-160 L3：Retry-After 作为**下限**的 max 移入纯函数 Get-FullJitterWait（随机以参数注入，便于确定性验证）
  assert.match(helper, /-RetryAfterSec \$RetryAfterHeader/, 'Retry-After 必须作为下限转交纯函数（其 max 语义由 test-u160b 行为实测）');
  //（原 RetryMinWaitSec 下限断言已由上面的 Get-FullJitterWait 断言承接）
  assert.match(helper, /TooLong = \(\$w -gt \$script:Cfg\.MaxRetryWaitSec\)/);
  assert.match(helper, /HasNext = \(\$Attempt -lt \$MaxAttempts\)/);
  assert.doesNotMatch(helper, /\b(break|continue)\b/, 'helper must only return a decision; break/continue would cross the function boundary');
  const outside = plain.replace(helper, '');
  assert.equal((outside.match(/RetryBaseSec/g) || []).length, 0, 'backoff formula duplicated outside Get-RetryBackoff');
  assert.equal((outside.match(/if \(\$attempt -ge \$maxAttempts\)/g) || []).length, 0, 'last-attempt decision duplicated outside Get-RetryBackoff');   // while ($attempt -lt $maxAttempts) 是循环条件，不算
  // ② 每个退避 sleep 都取自 $bo.WaitSec，且从最近一次 Get-RetryBackoff 调用到 sleep 之间有 HasNext 判定
  assert.equal((outside.match(/Start-Sleep -Seconds \$wait\b/g) || []).length, 0, 'legacy $wait sleep found');
  const sleeps = [...outside.matchAll(/Start-Sleep -Seconds \$bo\.WaitSec/g)].map(m => m.index);
  assert.equal(sleeps.length, 3, 'expected exactly the 3 known retry-sleep sites in Invoke-ApiRequest');
  for (const at of sleeps) {
    const call = outside.lastIndexOf('= Get-RetryBackoff -Attempt $attempt -MaxAttempts $maxAttempts', at);
    assert.ok(call > 0, 'each sleep must follow a Get-RetryBackoff call');
    const between = outside.slice(call, at);
    assert.match(between, /if \(-not \$bo\.HasNext\) \{ (?:break|return)/, 'sleep site lacks the HasNext guard: ' + between.slice(0, 120));
  }
  assert.equal((outside.match(/= Get-RetryBackoff -Attempt/g) || []).length, 3, 'exactly 3 call sites');
}
test('N-25/U-83: backoff policy is single-sourced in Get-RetryBackoff and every retry sleep is guarded by HasNext', () => {
  assertNoIdleBackoffOnLastAttempt(request);
});
// N-26（R20 §2）：harness 向主脚本传具名参数必须用哈希表 splat；数组 splat 会被当位置参数（repo 报错、code 静默退化 rc=0）。
// 同时守"语义级验收"存在：每轮核对 coverage.Executed 的 Kind、失败则 exit 2（否则 rc=0 又会把静默错放过去）。
const harnessPath = path.join(root, 'reports/gates/measure-latency.ps1');
function assertHarnessSplatAndSemantics(code) {
  const sw = code.match(/\$modeArgs = switch \(\$mode\) \{([\s\S]*?)\n\s*\}/);
  assert.ok(sw, 'harness must build $modeArgs via switch');
  const branches = [...sw[1].matchAll(/'(repo|code|research)'\s*\{\s*([^}]*\})\s*\}/g)];
  assert.equal(branches.length, 3, 'expected repo/code/research branches');
  for (const b of branches) assert.match(b[2], /^@\{\s*\w+\s*=/, `${b[1]} branch must be a hashtable splat, got: ${b[2]}`);
  assert.doesNotMatch(sw[1], /@\(\s*'-/, 'array splat of -Xxx strings is forbidden (positional-binding trap)');
  // N-28：必须是子进程调用（-File $main）且 rc 取自其后的 $LASTEXITCODE；同进程 `& $main` 会让 $LASTEXITCODE 恒空 ⇒ 恒 exit 2
  assert.doesNotMatch(code, /& \$main\b/, 'in-process call of the main script is forbidden (no $LASTEXITCODE, exit bleeds through)');
  assert.match(code, /'-File', \$main/);
  assert.match(code, /& \$exe @argv[^\n]*\n[\s\S]{0,200}\$rc = \$LASTEXITCODE/);
  // N-27：-Modes 必须是单字符串并自行切分（[string[]] 经 -File 不切分）
  assert.match(code, /\[string\]\$Modes\s*=/);
  assert.doesNotMatch(code, /\[string\[\]\]\$Modes/);
  assert.match(code, /\$Modes -split/);
  // U-92：拒绝裸位置参数 —— 必须声明 PositionalBinding=$false（否则 `-Modes a b c` 的 b/c 会静默落进 $Keyword/$Rounds）
  assert.match(code, /\[CmdletBinding\(PositionalBinding\s*=\s*\$false\)\]\s*\r?\nparam\(/, 'harness must reject positional arguments explicitly');
  assert.match(code, /coverage\.Executed/);
  assert.match(code, /\$kindOf\[\$_\] -ne \$mode/);
  assert.match(code, /semanticFailures\.Count -gt 0[\s\S]{0,400}exit 2/);
  // U-109：空轮必须带机器可读原因 + 每轮记录 blocked/degraded/reasons/exitCode（N-43 同型纪律）
  assert.match(code, /function Get-EmptyRoundReasonClass/, 'U-109 empty-round classifier must exist');
  for (const cls of ['deadline', 'rate-limited', 'blocked', 'degraded', 'unclassified']) {
    assert.match(code, new RegExp(`return '${cls}'`), `U-109 classifier must be able to emit ${cls}`);
  }
  assert.match(code, /coverage\.PSObject\.Properties\['Blocked'\]/);
  assert.match(code, /coverage\.PSObject\.Properties\['Degraded'\]/);
  assert.match(code, /coverage\.PSObject\.Properties\['Reasons'\]/);
  assert.match(code, /metrics\.PSObject\.Properties\['ExitCode'\]/);
  assert.match(code, /\$emptyReason = if \(\$executed\.Count -eq 0\)/);
  assert.match(code, /blocked = \$blocked; degraded = \$degraded; reasons = \$reasons; exitCode = \$exitCode; emptyReason = \$emptyReason/);
  assert.match(code, /exit=\{7\} why=\{8\}/, 'semantic failure line must name the empty-round reason');
  assert.match(code, /why=\$emptyReason/, 'per-round Write-Host line must name the empty-round reason');
  assert.match(code, /## 空轮粗分类/, 'human-readable empty-round section must be written to the .md');
}
test('N-26: measure-latency.ps1 uses hashtable splat for mode switches and enforces Executed-Kind semantics with exit 2', () => {
  assertHarnessSplatAndSemantics(fs.readFileSync(harnessPath, 'utf8'));
});
test('U-109: empty rounds carry a machine-readable coarse reason (blocked/degraded/reasons/exitCode per round)', () => {
  const code = fs.readFileSync(harnessPath, 'utf8');
  assertHarnessSplatAndSemantics(code);   // 抛错即红；本函数无返回值，勿用 assert.ok 包（N-26 正例同款）
});
test('U-109 negative control: dropping the reason fields, the classifier or a tier floor is detected', () => {
  const code = fs.readFileSync(harnessPath, 'utf8');
  const mut = (from, to) => { const out = code.split(from).join(to); assert.notEqual(out, code, from); return out; };
  for (const cls of ['deadline', 'rate-limited', 'blocked', 'degraded', 'unclassified']) {
    assert.throws(() => assertHarnessSplatAndSemantics(mut(`return '${cls}'`, "return ''")), assert.AssertionError, cls);
  }
  assert.throws(() => assertHarnessSplatAndSemantics(mut(/if \(\$json\.coverage\.PSObject\.Properties\['Reasons'\]\) \{ foreach \(\$rp in \$json\.coverage\.Reasons\.PSObject\.Properties\) \{ \$reasons\[\$rp\.Name\] = \[string\]\$rp\.Value \} \}/, '')), assert.AssertionError);
  assert.throws(() => assertHarnessSplatAndSemantics(mut(/blocked = \$blocked; degraded = \$degraded; reasons = \$reasons; exitCode = \$exitCode; emptyReason = \$emptyReason/, '')), assert.AssertionError);
  assert.throws(() => assertHarnessSplatAndSemantics(mut('exit={7} why={8}', 'exit={7}')), assert.AssertionError);
  assert.throws(() => assertHarnessSplatAndSemantics(mut('why=$emptyReason', 'why=$none')), assert.AssertionError);
  // U-62/U-63 分档下限：退回旧值/清零 ⇒ guardU23 红
  const mainSrc = sourceAll(path.join(root));
  assert.ok(guardU23(mainSrc));
  const m = (from, to) => { const out = mainSrc.split(from).join(to); assert.notEqual(out, mainSrc, from); return out; };
  // guardU23 抛的是普通 Error（不是 AssertionError）⇒ 按消息钉住，比断言类更严
  assert.throws(() => guardU23(m('EngineDeadlineByEngine = @{ Npm = 13; Crates = 10; Maven = 8; DockerHub = 29; arXiv = 26; HackerNews = 22; SE = 25; NuGet = 27; RubyGems = 8; HF = 8; MCPRegistry = 8; OpenAlex = 8 }', 'EngineDeadlineByEngine = @{ Npm = 5; SE = 25; HackerNews = 22 }')), /Npm must be >= 13/);
  assert.throws(() => guardU23(m('DockerHub = 29', 'DockerHub = 0')), /DockerHub must be >= 29/);
  assert.throws(() => guardU23(m('EngineDeadlineCodeSec = 17', 'EngineDeadlineCodeSec = 15')), /code deadline must clear the 15\.03s/);
  assert.throws(() => guardU23(m('EngineDeadlineRepoSec = 29', 'EngineDeadlineRepoSec = 26')), /repo deadline must clear the 26\.16s/);
  assert.throws(() => guardU23(m('EngineDeadlineSec = 17', 'EngineDeadlineSec = 15')), /default research deadline must clear the 15\.22s/);
});
test('N-26 negative control: reverting to array splat, or dropping the semantic exit, is detected', () => {
  const code = fs.readFileSync(harnessPath, 'utf8');
  const mut = (from, to) => { const out = code.split(from).join(to); assert.notEqual(out, code, from); return out; };
  assert.throws(() => assertHarnessSplatAndSemantics(mut("@{ Platform = 'All' }", "@('-Platform', 'All')")), assert.AssertionError);
  assert.throws(() => assertHarnessSplatAndSemantics(mut("@{ CodeEvidence = $true }", "@('-CodeEvidence')")), assert.AssertionError);
  assert.throws(() => assertHarnessSplatAndSemantics(mut('exit 2', 'exit 0')), assert.AssertionError);
  assert.throws(() => assertHarnessSplatAndSemantics(mut('$kindOf[$_] -ne $mode', '$false')), assert.AssertionError);
  // N-28/N-27 负例：改回同进程调用 / 改回 [string[]]
  assert.throws(() => assertHarnessSplatAndSemantics(mut('$raw = & $exe @argv', '$raw = & $main @argv')), assert.AssertionError);
  assert.throws(() => assertHarnessSplatAndSemantics(mut('[string]$Modes =', '[string[]]$Modes =')), assert.AssertionError);
  // U-92 负例：去掉 PositionalBinding=$false（或改成 $true）⇒ 红
  assert.throws(() => assertHarnessSplatAndSemantics(mut('[CmdletBinding(PositionalBinding = $false)]', '[CmdletBinding()]')), assert.AssertionError);
  assert.throws(() => assertHarnessSplatAndSemantics(mut('PositionalBinding = $false', 'PositionalBinding = $true')), assert.AssertionError);
});

// ---------- U-90（R24/R25）：双运行时验收 runner 的静态门 ----------
// 语义只有宿主真跑才能验；这里守"判据内建"：两运行时格都在、漏测必须标 uncovered 且 exit 3、任一 fail ⇒ exit 1 并点名格、
// 两运行时 ParseFile、N-30 桩端口隔离（跑前探测 + 跑后残留）、-Repeat 一致性判 flaky、子进程 -File 调用、拒绝位置参数、UTF-8 BOM。
const matrixPath = path.resolve(import.meta.dirname, '..', 'reports/gates/run-acceptance-matrix.ps1');
const matrixBytes = fs.readFileSync(matrixPath);
const matrixSrc = matrixBytes.toString('utf8').replace(/^\uFEFF/, '');
function assertAcceptanceMatrix(code, bytes) {
  if (bytes) assert.ok(bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF, 'runner must start with UTF-8 BOM (N-29: PS 5.1 decodes BOM-less files as ANSI)');
  assert.match(code, /\[CmdletBinding\(PositionalBinding\s*=\s*\$false\)\]\s*\r?\nparam\(/, 'U-92: reject bare positional args');
  // 两运行时都是一等格（不能只跑 PS7）
  assert.match(code, /n = 'ps51'; exe = \(Resolve-Exe \$Ps51\)/, 'ps51 runtime cell');
  assert.match(code, /n = 'ps7'; exe = \(Resolve-Exe \$Pwsh7\)/, 'ps7 runtime cell');
  // 漏测不沉默：运行时缺失 ⇒ uncovered + 原因；exit 3（除非 -AllowUncovered）
  assert.ok((code.match(/\$c\.status = 'uncovered'; \$c\.reason = /g) || []).length >= 3, 'every runtime-dependent cell marks uncovered with a reason');
  assert.match(code, /\$exitCode = if \(\$failed\.Count -gt 0\) \{ 1 \} elseif \(\$uncovered\.Count -gt 0 -and -not \$AllowUncovered\) \{ 3 \} else \{ 0 \}/, 'exit code ladder 1/3/0');
  assert.match(code, /UNCOVERED CELLS/, 'uncovered cells are printed');
  assert.match(code, /FAILED CELLS/, 'failed cells are named');
  assert.match(code, /exit \$exitCode\s*$/, 'must exit with the computed code');
  // 被测全部走子进程 -File（U-84：不与驾驶员进程共享状态、被调方 exit 不连坐）
  assert.match(code, /'-File', \$runTests/, 'run-tests via subprocess -File');
  assert.match(code, /'-File', \$parseFile/, 'parse probe via subprocess -File');
  assert.doesNotMatch(code, /(^|[^$\w])\. \$runTests|& \$runTests/m, 'must not dot-source or in-process invoke run-tests');
  // 两运行时 ParseFile 且报文件名
  assert.match(code, /\[System\.Management\.Automation\.Language\.Parser\]::ParseFile/);
  assert.match(code, /parse errors in: /);
  // N-30：桩端口隔离 —— 跑前探测（污染 ⇒ 不跑、判 fail 并说明）+ 跑后残留 warning
  assert.match(code, /\$StubPorts = @\(18986, 18987, 18988\)/);
  assert.match(code, /\$pre = Get-StaleStubs[\s\S]*stale U-24 stub listening before run[\s\S]*cell not executed/, 'pre-run stale-stub detection must fail the cell explicitly');
  assert.match(code, /\$post = Get-StaleStubs[\s\S]*leftover stub after run/, 'post-run leftover detection');
  // -Repeat 一致性：rc/RESULT/逐组必须一致，否则 flaky 并指出组
  assert.match(code, /\$c\.status = 'flaky'; \$c\.reason = "inconsistent across/, 'repeat inconsistency => flaky');
  assert.match(code, /group \[\$\(\$g\.group\)\] run1=/, 'names the first differing group');
  // 机器可读产物
  assert.match(code, /ConvertTo-Json -Depth 7 \| Set-Content -LiteralPath \$jsonPath/);
  assert.match(code, /failedCells = @\(\$failed/); assert.match(code, /uncoveredCells = @\(\$uncovered/);
}
test('U-90: run-acceptance-matrix.ps1 has both runtimes, uncovered-marking, cell-naming failure, dual-runtime ParseFile, stub isolation and repeat-consistency built in', () => {
  assertAcceptanceMatrix(matrixSrc, matrixBytes);
});
// ---------- Wave D（U-66…U-72）备料：脚本存在、拒绝位置参数、只列不动（不含 Remove-Item/轮换/push）、报告落盘前自扫令牌形状 ----------
test('Wave D: U-66/U-67/U-68/U-69 helper scripts exist, are read-only by construction and never write unmasked token-shaped text', () => {
  const files = { 'u66-leak-surface-scan.ps1': /refusing to write/, 'u67-history-rewrite-dryrun.ps1': /clone --mirror/, 'u69-quarantine-inventory.ps1': /refusing to write/, 'u68-tls-fixture.ps1': /TLS fallback: node --use-system-ca/ };
  for (const [f, must] of Object.entries(files)) {
    const s = stripPsComments(fs.readFileSync(path.join(root, 'reports/gates', f), 'utf8').replace(/^\uFEFF/, ''));
    assert.match(s, /\[CmdletBinding\(PositionalBinding = \$false\)\]/, f + ' U-92');
    assert.match(s, must, f + ' core behaviour');
    assert.doesNotMatch(s, /git push|Remove-Item -LiteralPath \$f\b|Remove-Item -LiteralPath \$Quarantine/, f + ' must not push or delete inventoried files');
    if (f === 'u67-history-rewrite-dryrun.ps1') assert.ok(s.indexOf('Push-Location $tmp') < s.indexOf('Invoke-Expression $cmd'), 'rewrite only runs inside the temp mirror');
  }
  assert.ok(fs.existsSync(path.join(root, 'reports/gates/u68-tls-fixture.py')));
  const doc = fs.readFileSync(path.join(root, 'reports/WaveD-授权前置备料-2026-09-26.md'), 'utf8');
  for (const u of ['U-66', 'U-67', 'U-68', 'U-69', 'U-70', 'U-71', 'U-72']) assert.ok(doc.includes('## ' + u), 'Wave D doc section ' + u);
});

// ---------- U-79：响应头例行观察命令 —— 子进程 -File 调主脚本、快照 + diff、敏感头双保险、退出码梯子 ----------
test('U-79: observe-headers-routine.ps1 runs the main script as a subprocess per endpoint, snapshots governance headers, diffs against the previous snapshot and refuses sensitive headers', () => {
  const s = stripPsComments(fs.readFileSync(path.join(root, 'reports/gates/observe-headers-routine.ps1'), 'utf8').replace(/^\uFEFF/, ''));
  assert.match(s, /\[CmdletBinding\(PositionalBinding = \$false\)\]/);
  assert.match(s, /& \$Pwsh -NoProfile -ExecutionPolicy Bypass -File \$main -ObserveHeaders \$u -AsJson/, 'subprocess -File per endpoint');
  assert.match(s, /\$sensitive = @\('authorization', 'set-cookie', 'cookie', 'x-auth-token', 'private-token'/, 'sensitive list');
  assert.match(s, /refusing to record sensitive header/); assert.match(s, /refusing to write/);
  assert.match(s, /headers-snapshot-\$stamp\.json/); assert.match(s, /Filter 'headers-snapshot-\*\.json'/, 'previous snapshot lookup');
  assert.match(s, /NEW \$k = \$nowV/, 'new Deprecation/Sunset => alert');
  assert.match(s, /\$exitCode = if \(\$alerts\.Count\) \{ 2 \} elseif \(\$unreachable\.Count -and -not \$AllowUnreachable\) \{ 3 \} else \{ 0 \}/);
  assert.ok((s.match(/https:\/\/[^'\s]+/g) || []).length >= 6, 'default endpoint list');
  assert.doesNotMatch(s, /GITHUB_TOKEN|GITLAB_TOKEN|\.env/, 'routine must not touch credentials itself');
  // N-33：摘要必须由计算值组成，不得再出现"0 ok / 2 … / 3 …"式的字面量数字冒充计数
  assert.match(s, /summary: endpoints=\{0\} reachable=\{1\} unreachable=\{2\} alerts=\{3\} changes=\{4\} exit=\{5\}" -f \$entries\.Count, \$reachableN, \$unreachable\.Count, \$alerts\.Count, \$changes\.Count, \$exitCode/, 'summary line is computed from the real counters');
  assert.doesNotMatch(s, /\[U-79\] exit \$exitCode \(0 ok \/ 2 /, 'legacy literal summary must be gone');
});
test('N-33 negative control: a summary with literal counts is detected', () => {
  const s = stripPsComments(fs.readFileSync(path.join(root, 'reports/gates/observe-headers-routine.ps1'), 'utf8').replace(/^\uFEFF/, ''));
  const bad = s.replace('alerts={3} changes={4} exit={5}" -f $entries.Count, $reachableN, $unreachable.Count, $alerts.Count, $changes.Count, $exitCode', 'alerts=2 changes={4} exit={5}" -f $entries.Count, $reachableN, $unreachable.Count, $changes.Count, $exitCode');
  assert.notEqual(bad, s);
  assert.doesNotMatch(bad, /alerts=\{3\} changes=\{4\} exit=\{5\}" -f \$entries\.Count, \$reachableN, \$unreachable\.Count, \$alerts\.Count/);
});
test('N-31/N-32: u84 probe self-asserts (non-zero on mismatch) and u94 tolerates zero-result modes', () => {
  const probe = stripPsComments(fs.readFileSync(path.join(root, 'reports/gates/u84-exit-bleed-probe.ps1'), 'utf8').replace(/^\uFEFF/, ''));
  assert.match(probe, /exit \$\(if \(\$fail\) \{ 1 \} else \{ 0 \}\)/, 'probe must fail on mismatch');
  assert.doesNotMatch(probe, /\(UNEXPECTED\)/, 'no report-only UNEXPECTED path');
  assert.match(probe, /-File \$caller/, 'third segment tests dot-source inside a script FILE');
  assert.match(probe, /-File \$caller2/, 'N-38: fourth segment measures bare dot-source (no pipeline)');
  assert.match(probe, /MEASURE bare-dot/, 'bare-dot is a measurement with both outcomes printed');
  assert.match(probe, /PASS file-dot\(piped\)/, 'expectation follows host-measured F3');
  const u94 = stripPsComments(fs.readFileSync(path.join(root, 'reports/gates/u94-fillrate.ps1'), 'utf8').replace(/^\uFEFF/, ''));
  assert.match(u94, /filled = \$\(if \(\$n -gt 0\) \{ \[int\]\(\$row\[\$_\] -split '\/'\)\[0\] \} else \{ \$null \}\)/, 'zero-result modes must not hit the int conversion');
  assert.match(u94, /modes with 0 results/);
});

// ---------- U-91：reports/gates 证据再生索引 —— 每个文件必须匹配索引 §2 的某条正则；不匹配 ⇒ 报文件名 ----------
// U-276（v1.59.0，B3-6）：§2 只到 `## 2b.` 为止 —— 2b 是"已外置规则"，
//   两节的读法**相反**（2 必须命中在仓文件；2b 不得命中在仓文件），混在一起读等于两边都废掉。
function regenRules(indexMd) {
  // ★规则块**不止 §2 一处**：§3..§10 也各有一张同格式的表（按批次追加），原实现从 §2 切到 EOF 一并收。
  //   所以这里不能"切到 2b 为止"，只能**把 2b 那一段挖掉**，其余保持原样。
  let sec = indexMd.slice(indexMd.indexOf('## 2. 规则块'));
  const stop = sec.indexOf('## 2b.');
  if (stop >= 0) {
    const resume = sec.indexOf('\n## ', stop + 5);
    sec = sec.slice(0, stop) + (resume >= 0 ? sec.slice(resume) : '');
  }
  const rules = [...sec.matchAll(/^\| `([^`]+)` \| ([^|]+) \| ([^|]+) \|$/gm)].map(m => ({ re: new RegExp(m[1].replace(/\\\|/g, '|')), cat: m[2].trim(), how: m[3].trim() }));
  assert.ok(rules.length >= 12, 'rule block parsed: ' + rules.length);
  return rules;
}
function listGates(dir, base = dir, acc = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) listGates(p, base, acc); else acc.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return acc;
}
function assertEvidenceIndexed(files, rules) {
  const orphans = files.filter(f => !rules.some(r => r.re.test(f)));
  assert.deepEqual(orphans, [], 'U-91 evidence files not covered by README-证据再生索引 §2: ' + orphans.join(', '));
  for (const f of files) assert.ok(!/^_|\.log$/.test(path.basename(f)), 'D-03/N-21 naming: ' + f);
}
function archivedRules(indexMd) {
  const at = indexMd.indexOf('## 2b.');
  if (at < 0) return [];
  const stop = indexMd.indexOf('\n## ', at + 5);
  const sec = indexMd.slice(at, stop > at ? stop : undefined);
  return [...sec.matchAll(/^\| `([^`]+)` \| ([^|]+) \| ([^|]+) \|$/gm)]
    .map(m => ({ re: new RegExp(m[1].replace(/\\\|/g, '|')), cat: m[2].trim(), how: m[3].trim() }));
}
/** 2b 的规则**不得**命中仓内文件：命中了说明该文件没被外置干净，或规则被复用到了在仓证据上。 */
function assertArchivedRulesAbsent(files, rules) {
  const leaked = rules.filter(r => files.some(f => r.re.test(f))).map(r => r.re.source);
  assert.deepEqual(leaked, [], 'U-91 2b：登记为"已外置"的规则仍命中仓内文件（外置不干净）：' + leaked.join(', '));
}
const gatesDir = path.join(root, 'reports/gates');
const regenIndexPath = path.join(gatesDir, 'README-证据再生索引.md');
test('U-91: every file under reports/gates/** is covered by a regeneration rule (command or explicit one-off)', () => {
  const rules = regenRules(fs.readFileSync(regenIndexPath, 'utf8'));
  const files = listGates(gatesDir);
  assert.ok(files.length >= 100, 'expected the evidence corpus, got ' + files.length);
  assertEvidenceIndexed(files, rules);
  // 自动产物类必须给出具体命令（含 .ps1）
  for (const r of rules.filter(r => r.cat === '自动产物')) assert.match(r.how, /\.ps1/, 'auto-generated category must name the tool: ' + r.re);
});
test('U-91 negative control: a new evidence file with no rule is reported by name', () => {
  const rules = regenRules(fs.readFileSync(regenIndexPath, 'utf8'));
  assert.throws(() => assertEvidenceIndexed(['brand-new-evidence-2026-10-01.txt'], rules), /brand-new-evidence-2026-10-01\.txt/);
  assert.throws(() => assertEvidenceIndexed(['_underscore-prefixed.txt'], rules), assert.AssertionError);
});

// ★U-91 反向（2026-10-26）：索引 §2 **每条规则都必须匹配到至少一个证据文件**。
//   原判据只有「文件 ⇒ 规则」一个方向，于是「索引登记了证据、证据根本没进仓」是静默的：
//   u264-real-402.json / u265-real-code.json 两批都只写在已安装副本（reports 不进发货清单），
//   源仓与 git 从未有过，而索引早已登记，全绿。这条反向断言就是为此设的。
//   瞬态产物规则（跑完即删 / 仅在调试路径生成）必须**显式列白**，不能靠"反正没人查"。
const TRANSIENT_RULES = new Set([
  '^WORK_IN_PROGRESS\\.md$',
  '^pester/_out/.*',
]);
// 索引表里的正则在 Markdown 里写成 `pester\/_out`（`\/` 转义），`RegExp.source` 会原样保留它——
// 直接拿 source 比字符串会漏掉豁免。归一化后再比，两种写法都认。
const normRuleSource = re => re.source.replace(/\\\//g, '/');
function assertNoDanglingRules(files, rules) {
  const dangling = rules
    .filter(r => !TRANSIENT_RULES.has(normRuleSource(r.re)))
    .filter(r => !files.some(f => r.re.test(f)))
    .map(r => normRuleSource(r.re));
  assert.deepEqual(dangling, [],
    'U-91 反向：索引 §2 登记了规则但没有任何证据文件匹配（证据没落进源仓？）：' + dangling.join(', '));
}
// A 副本（~/.workbuddy/skills/...）**不含 reports**（不进发货清单）⇒ 在副本里跑反向断言毫无意义：
// 大部分规则必然悬空。与 test-u120b 同一约定：用同一个哨兵目录判断"这是副本"，**显式 skip**。
// 不这么做的话，本门会在 A 副本自测里恒红，而恒红的门会训练人忽略红。
const NO_EVID = fs.existsSync(path.join(gatesDir, 'u120-c8')) ? false
  : 'A 副本不含 reports/gates/u120-c8（证据目录不进发货清单）；反向断言只在源仓有意义';
test('U-91 reverse: every index rule matches at least one evidence file (dangling rule = evidence never landed)',
  { skip: NO_EVID }, () => {
    const rules = regenRules(fs.readFileSync(regenIndexPath, 'utf8'));
    assertNoDanglingRules(listGates(gatesDir), rules);
  });
// U-276（v1.59.0，B3-6）：**第三档** —— 证据不在仓里，但也不是"从没落地"：它落过、后来被外置了。
//   §2b 就是这笔账。两条方向相反的断言：
//     · §2 的规则必须命中在仓文件（证据在，规则也在）；
//     · §2b 的规则**不得**命中在仓文件（说了外置就该真的不在了）。
//   只留前一条，"外置"会变成把人看不见的东西从账上抹掉；只有后一条，在仓证据会失去再生命令。
test('U-91 reverse-2: §2b（已外置）规则不得命中仓内文件；负向控制：塞一条在仓规则必须被抓', { skip: NO_EVID }, () => {
  const md = fs.readFileSync(regenIndexPath, 'utf8');
  const files = listGates(gatesDir);
  const arch = archivedRules(md);
  assert.ok(arch.length >= 1, '§2b 为空：B3-6 之后不该为空（外置过的规则必须在账上）');
  assertArchivedRulesAbsent(files, arch);
  const inTree = regenRules(md).find(r => files.some(f => r.re.test(f)));
  assert.ok(inTree, '§2 里至少要有命中在仓文件的规则');
  assert.throws(() => assertArchivedRulesAbsent(files, [inTree]), /外置不干净/);
});
test('U-91 reverse negative control: a dangling rule is reported by name, transient rules are exempt', () => {
  const rules = regenRules(fs.readFileSync(regenIndexPath, 'utf8'));
  let msg = null;
  try { assertNoDanglingRules(['unrelated-evidence.txt'], rules); } catch (e) { msg = e.message; }
  assert.ok(msg, '存在悬空规则时必须抛断言');
  assert.match(msg, /u264-real-402/, '必须点名缺文件的那条规则');
  assert.doesNotMatch(msg, /WORK_IN_PROGRESS/, '瞬态规则应被显式豁免，不参与反向断言');
});

// ---------- U-88：-ObserveHeaders 凭据泄漏负例 —— 白名单静态守 + run-tests 第 5 组桩负例 ----------
function observeWatchList(src) {
  const m = src.match(/\$watch = @\(([^)]*)\)/);
  assert.ok(m, '$watch whitelist must exist in the -ObserveHeaders path');
  return m[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
}
function assertObserveWhitelist(src) {
  const w = observeWatchList(src);
  const forbidden = ['authorization', 'set-cookie', 'cookie', 'x-auth-token', 'private-token', 'proxy-authorization', 'x-api-key'];
  const leaks = w.filter(h => forbidden.includes(h.toLowerCase()));
  assert.deepEqual(leaks, [], 'U-88 whitelist must never include credential-bearing headers: ' + leaks.join(','));
  for (const must of ['Deprecation', 'Sunset', 'Link', 'X-RateLimit-Limit', 'Retry-After']) assert.ok(w.includes(must), 'whitelist must keep ' + must);
  // 只输出白名单里的头：循环必须是 foreach ($w in $watch)，而不是遍历响应的全部头
  assert.match(src, /foreach \(\$w in \$watch\) \{ \$v = Get-HeaderValue -Headers \$r\.Headers -Name \$w;/, 'output loop must iterate the whitelist, not the response headers');
  assert.doesNotMatch(src, /foreach \(\$w in @\(\$r\.Headers\.Keys\)\)/, 'iterating all response headers would leak');
}
test('U-88: -ObserveHeaders only emits whitelisted governance headers; run-tests has the stub leak negative', () => {
  assertObserveWhitelist(source);
  const plain = stripPsComments(harnessSrc);
  assert.match(plain, /if self\.path == '\/observe':/, 'stub route');
  assert.match(plain, /\('Authorization', 'Bearer leak-me-if-you-can'\)/, 'stub injects Authorization');
  assert.match(plain, /foreach \(\$t_leak in @\('Authorization', 'Set-Cookie', 'X-Auth-Token', 'PRIVATE-TOKEN', 'leak-me-if-you-can'/, 'harness asserts no leak by name and by value');
  assert.match(plain, /X-RateLimit-Limit 应为 10/, 'positive: whitelisted header must still come through');
});
test('U-88 negative control: widening the whitelist with Authorization, or iterating all response headers, is detected', () => {
  const widened = source.replace("$watch = @('Deprecation',", "$watch = @('Authorization', 'Deprecation',");
  assert.notEqual(widened, source);
  assert.throws(() => assertObserveWhitelist(widened), /Authorization/);
  const iterAll = source.replace('foreach ($w in $watch) { $v = Get-HeaderValue -Headers $r.Headers -Name $w;', 'foreach ($w in @($r.Headers.Keys)) { $v = Get-HeaderValue -Headers $r.Headers -Name $w;');
  assert.notEqual(iterAll, source);
  assert.throws(() => assertObserveWhitelist(iterAll), assert.AssertionError);
});

// ---------- U-93：门 × 触发条件覆盖表 —— run-tests 每组必须在表中有行；-LocalOnly 下 SKIP 的组必须标 slow；-LocalOnly 汇总行必须存在 ----------
test('U-93: gate-coverage table lists every run-tests group with a trigger, LocalOnly-skipped groups are marked slow, and run-tests prints the skipped-groups summary', () => {
  const table = fs.readFileSync(path.join(root, 'reports/gates/gate-coverage-2026-09-26.md'), 'utf8');
  const plain = stripPsComments(harnessSrc);
  const groups = [...new Set([...plain.matchAll(/\[(test-[a-z0-9-]+)\] TEST_(?:PASS|FAIL|SKIP)/g)].map(m => m[1]))];
  assert.ok(groups.length >= 12, 'groups found: ' + groups.length);
  const localSkipped = [...new Set([...plain.matchAll(/if \(\$LocalOnly\) \{ \$lines\.Add\("\[(test-[a-z0-9-]+)\] TEST_SKIP \(LocalOnly(?:; network required)?\)"\)/g)].map(m => m[1]))];
  assert.ok(localSkipped.length >= 5);
  const rows = Object.fromEntries([...table.matchAll(/^\| `(test-[a-z0-9-]+)` \| (fast|slow|host) \|/gm)].map(m => [m[1], m[2]]));
  const missing = groups.filter(g => !(g in rows));
  assert.deepEqual(missing, [], 'groups missing from coverage table: ' + missing.join(','));
  const wrong = localSkipped.filter(g => rows[g] !== 'slow');
  assert.deepEqual(wrong, [], 'LocalOnly-skipped groups must be marked slow: ' + wrong.join(','));
  const fastWrong = groups.filter(g => !localSkipped.includes(g) && rows[g] !== 'fast');
  assert.deepEqual(fastWrong, [], 'groups that run under -LocalOnly must be marked fast: ' + fastWrong.join(','));
  // 契约/语义类慢路径门必须写明快路径廉价版或"仅慢路径"
  for (const g of ['test-contract', 'test-sorting', 'test-endpoints', 'test-observe']) {
    const line = table.split('\n').find(l => l.startsWith('| `' + g + '` |'));
    assert.ok(/廉价版 =|仅慢路径|覆盖/.test(line), g + ' row must declare a cheap fast-path counterpart or 仅慢路径');
  }
  assert.match(plain, /\[localonly\] skipped-groups=\{0\}: \{1\}/, 'run-tests prints the LocalOnly skipped-groups summary line');
  // N-34 首例：自指门规则必须写在表里，且解析主判据指向独立于被检文件的矩阵格
  assert.match(table, /规则 2（自指门，N-34 首例/);
  assert.match(table, /parse-ps51\/parse-ps7|parse-ps51\/ps7/);
  // N-42：$PSScriptRoot 现取分支的形态依赖必须在表里，且 u68 探针按值注入两路径
  assert.match(table, /## 3\.1 形态依赖（N-42/);
  const u68 = stripPsComments(fs.readFileSync(path.join(root, 'reports/gates/u68-tls-fixture.ps1'), 'utf8').replace(/^\uFEFF/, ''));
  assert.match(u68, /\$script:NodeExePath = '\$nodeExe'; `\$script:NodeEnginePath = '\$nodeEngine'; /, 'u68 injects node paths before dot-sourcing');
  assert.match(u68, /UNCOVERED\(prereq: node/, 'missing node is reported, not silently skipped');
  // N-43：E2 以 trace 文件为判据（机器可读），主脚本含 opt-in 事件写入；表里有规则 3
  assert.match(u68, /\$env:MCPS_TLS_TRACE='\$traceFile'/, 'probe sets the trace file for the callee');
  assert.match(u68, /ok = \(\$entered -ge 1\)/, 'E2 judged by fallback-enter events, not stdout text');
  assert.match(u68, /\| ForEach-Object \{ if \(`\$_ -is \[string\]\)/, 'stdout captured streaming (no assignment that drops output on throw)');
  assert.match(table, /## 3\.2 判据可观测性（N-43/);
  const iar = httpLayerText(source);   // D4：Write-TlsTrace/Get-TraceUri 外提为顶层闭包成员；trace 调用分布在公有函数与 node 兜底 helper
  assert.match(iar, /function Write-TlsTrace \{\s*param\(\[string\]\$TraceEvent\)/, 'trace helper is a top-level HTTP-layer function');
  assert.ok(closureList(source).includes('Write-TlsTrace') && closureList(source).includes('Get-TraceUri'), 'trace helpers must be closure members (they run inside runspaces)');
  for (const ev of ['attempt {0}/{1}', 'fallback-guard nodeExe=', 'fallback-enter {0}', 'fallback-node-result {0} {1}']) assert.ok(iar.includes(ev), 'trace event: ' + ev);
  assert.match(iar, /if \(\$env:MCPS_TLS_TRACE\) \{ try \{ \[System\.IO\.File\]::AppendAllText/, 'trace is opt-in and never throws');
  // U-99（N-44）：trace 事件只能带 $traceUri（query 已遮蔽），不得带 $Uri；表里有规则 4
  const traceCalls = [...iar.matchAll(/Write-TlsTrace \(([^\n]*)\)/g)].map(m => m[1]);
  assert.ok(traceCalls.length >= 4);
  for (const c of traceCalls) { assert.ok(/\$traceUri/.test(c) && !/[^\w]\$Uri\b/.test(c), 'trace event must use $traceUri, not $Uri: ' + c); }
  assert.match(iar, /function Get-TraceUri \{[\s\S]*?'\?<query-masked>'/, 'query is masked');
  assert.match(table, /规则 4：打点须走信息流或文件/);
});
test('U-99 negative control: a trace event that logs the raw $Uri (with query) is detected', () => {
  const iar = httpLayerText(source);
  const bad = iar.replace('Write-TlsTrace ("fallback-enter {0}" -f $traceUri)', 'Write-TlsTrace ("fallback-enter {0}" -f $Uri)');
  assert.notEqual(bad, iar);
  const calls = [...bad.matchAll(/Write-TlsTrace \(([^\n]*)\)/g)].map(m => m[1]);
  assert.ok(calls.some(c => !/\$traceUri/.test(c)));
});
test('U-93 negative control: a run-tests group absent from the table, or a LocalOnly-skipped group marked fast, is named', () => {
  const table = fs.readFileSync(path.join(root, 'reports/gates/gate-coverage-2026-09-26.md'), 'utf8');
  const rowsOf = t => Object.fromEntries([...t.matchAll(/^\| `(test-[a-z0-9-]+)` \| (fast|slow|host) \|/gm)].map(m => [m[1], m[2]]));
  const t1 = table.replace('| `test-contract` | slow |', '| `test-contract` | fast |');
  assert.notEqual(t1, table); assert.equal(rowsOf(t1)['test-contract'], 'fast');
  const t2 = table.replace('| `test-inject` | fast |', '| `test-injectX` | fast |');
  assert.notEqual(t2, table); assert.ok(!('test-inject' in rowsOf(t2)));
});

// ---------- U-84：exit 连坐审计 —— 被调脚本的 exit 只允许出现在主流程守卫块内；同进程调用点逐个登记 ----------
// 语义（宿主可用 reports/gates/u84-exit-bleed-probe.ps1 复核）：`& script` 里的 exit 只结束被调脚本；`. script`（点源）里的 exit 会结束调用方。
// 所以真正的连坐面 = 点源 + 被调方在守卫块**外**的 exit。门：主脚本全部 exit 必须在 `if (-not $env:MCPS_NO_MAIN …) {` … `} # end main-flow guard` 之间。
function exitAudit(mainSource, callers) {
  const rawLines = mainSource.split('\n');
  const guardStart = rawLines.findIndex(l => l.startsWith("if (-not $env:MCPS_NO_MAIN -and ($MyInvocation.InvocationName -ne '.') -and ($MyInvocation.Line -ne $null)) {"));
  const guardEnd = rawLines.findIndex(l => l.startsWith('} # end main-flow guard'));
  assert.ok(guardStart > 0 && guardEnd > guardStart, 'main-flow guard block must exist (dot-source safety)');
  const exits = [];
  const re = /(^|[;{]\s*|\s)exit(\s+\d+|\s+\$[\w:]+)?\s*(?=$|\}|;)/;
  rawLines.forEach((raw, i) => {
    if (/^\s*#/.test(raw)) return;
    const l = raw.replace(/\s#.*$/, '');
    if (re.test(l)) exits.push({ line: i + 1, inGuard: i > guardStart && i < guardEnd });
  });
  const outside = exits.filter(e => !e.inGuard);
  const sites = [];
  for (const [name, src] of Object.entries(callers)) {
    const p = stripPsComments(src);
    for (const mm of p.matchAll(/^\s*\. \$mainScript\b.*$/gm)) sites.push({ caller: name, kind: 'dot-source', line: mm[0].trim() });
    for (const mm of p.matchAll(/& \$mainScript\b[^\n|)]*/g)) sites.push({ caller: name, kind: 'in-process &', line: mm[0].trim() });
  }
  return { exits: exits.length, outside: outside.length, sites };
}
const evalsSrc = fs.readFileSync(path.join(root, 'evals/run-evals.ps1'), 'utf8').replace(/^\uFEFF/, '');
test('U-84: every exit in the main script sits inside the main-flow guard; in-process call sites are enumerated (audit table in reports/gates/u84-exit-bleed-audit-2026-09-26.md)', () => {
  const a = exitAudit(source, { 'tests/run-tests.ps1': harnessSrc, 'evals/run-evals.ps1': evalsSrc });
  assert.equal(a.outside, 0, 'exit outside the main-flow guard would fire when dot-sourced by run-tests/evals');
  assert.equal(a.exits, 6, 'known exit sites: Download / -ObserveHeaders / -Doctor / -Version banner / -Serve / 主流程收尾(v1.47.2 进程退出码) (update the audit if this changes)');
  assert.equal(a.sites.filter(s => s.kind === 'dot-source').length, 2, 'run-tests + evals dot-source the main script once each');
  assert.ok(a.sites.filter(s => s.kind === 'in-process &').length >= 10);
  // 点源者必须要么设 MCPS_NO_MAIN，要么依赖守卫；两者都在 ⇒ 记录即可。gates 侧不得同进程调 run-tests / main（U-84 已改子进程）
  assert.match(evalsSrc, /\$env:MCPS_NO_MAIN = '1'/);
  const audit = fs.readFileSync(path.join(root, 'reports/gates/u84-exit-bleed-audit-2026-09-26.md'), 'utf8');
  assert.match(audit, /exit 站点数.*5/, 'audit must state the exit-site count');   // 2026-10-19：站点 4→5（新增 -Serve）
  for (const f of ['reports/gates/measure-latency.ps1', 'reports/gates/run-acceptance-matrix.ps1', 'reports/gates/pester/RunTests.Tests.ps1']) {
    const g = stripPsComments(fs.readFileSync(path.join(root, f), 'utf8'));
    assert.doesNotMatch(g, /& \$main(Script)?\b|\. \$main(Script)?\b|& \$runTests\b|\. \$runTests\b/, f + ' must invoke callees as subprocesses');
  }
});
test('U-84 negative control: an exit placed outside the guard (top level, fires on dot-source) is detected', () => {
  const bad = source.replace("if (-not $env:MCPS_NO_MAIN -and ($MyInvocation.InvocationName -ne '.') -and ($MyInvocation.Line -ne $null)) {", "if ($env:FOO) { exit 9 }\nif (-not $env:MCPS_NO_MAIN -and ($MyInvocation.InvocationName -ne '.') -and ($MyInvocation.Line -ne $null)) {");
  assert.notEqual(bad, source);
  const a = exitAudit(bad, {});
  assert.equal(a.outside, 1);
});

// ---------- U-80：组结果单源 —— 组行只解析一次（$GroupLinePattern），JUnit 与 JSON 都派生；Pester 只读 JSON；不一致 ⇒ rc=1 ----------
const pesterAdapterSrc = fs.readFileSync(path.join(root, 'reports/gates/pester/RunTests.Tests.ps1'), 'utf8').replace(/^\uFEFF/, '');
function assertSingleSourceGroupResults(runTests, pester) {
  const plain = stripPsComments(runTests);
  const defs = plain.match(/\$GroupLinePattern = '[^']+'/g) || [];
  assert.equal(defs.length, 1, 'exactly one group-line pattern definition');
  assert.match(defs[0], /TEST_\(\?<v>PASS\|FAIL\|SKIP\)/, 'pattern must cover TEST_SKIP (the old JUnit regex missed it)');
  assert.match(plain, /if \(\$ln -match \$GroupLinePattern\) \{ \$groupResults \+= /, 'groups are parsed once into $groupResults');
  assert.doesNotMatch(plain, /TEST_PASS\|TEST_FAIL\|SKIP/, 'legacy second parser must be gone');
  assert.match(plain, /foreach \(\$gr in \$groupResults\) \{/, 'JUnit derives from $groupResults');
  assert.match(plain, /\$resultMismatch = \(\$gPass -ne \$pass -or \$gFail -ne \$failC -or \$gSkip -ne \$skipC\)/, 'derived counts are checked against the counters');
  assert.match(plain, /\$exitCodeFinal = if \(\$failC -gt 0 -or \$resultMismatch\) \{ 1 \} else \{ 0 \}/, 'mismatch => rc 1');
  assert.match(plain, /if \(\$exitCodeFinal -ne 0\) \{ exit \$exitCodeFinal \}\s*$/, 'final exit uses the computed code');
  assert.match(plain, /groups = @\(\$groupResults\)/, 'JSON carries the same groups');
  assert.match(plain, /WriteAllText\(\$ResultJsonPath/, 'JSON sidecar written when requested');
  // Pester 适配层：只读 JSON，不再自己解析 stdout 组行
  const p = stripPsComments(pester);
  assert.match(p, /'-ResultJsonPath', \$script:resultJson/, 'adapter requests the JSON');
  assert.match(p, /\$script:groups = @\(\$script:resultDoc\.groups/, 'adapter groups come from the JSON');
  assert.doesNotMatch(p, /\$line -match '\^\\\[\(test-\[a-z0-9-\]\+\)\\\] TEST_/, 'adapter must not re-parse stdout group lines');
  assert.match(p, /\[bool\]\$script:resultDoc\.mismatch \| Should -BeFalse/, 'adapter surfaces the mismatch flag');
}
test('U-80: group results are parsed once in run-tests.ps1; JUnit and the Pester adapter derive from the same record; mismatch is red', () => {
  assertSingleSourceGroupResults(harnessSrc, pesterAdapterSrc);
});
test('U-80 negative control: a second stdout parser (in JUnit or in the Pester adapter), or downgrading mismatch to a warning, is detected', () => {
  const mutH = (a, b) => { const m = harnessSrc.split(a).join(b); assert.notEqual(m, harnessSrc); return m; };
  assert.throws(() => assertSingleSourceGroupResults(mutH('foreach ($gr in $groupResults) {', "foreach ($ln in $lines) { if ($ln -match '^\\[(?<g>[^\\]/]+)\\]\\s*(?<verdict>TEST_PASS|TEST_FAIL|SKIP)\\b(?<rest>.*)') {"), pesterAdapterSrc), assert.AssertionError);
  assert.throws(() => assertSingleSourceGroupResults(mutH('$exitCodeFinal = if ($failC -gt 0 -or $resultMismatch) { 1 } else { 0 }', '$exitCodeFinal = if ($failC -gt 0) { 1 } else { 0 }'), pesterAdapterSrc), assert.AssertionError);
  const mutP = pesterAdapterSrc.replace('$script:groups = @($script:resultDoc.groups', "foreach ($line in $script:runnerOutput) { if ($line -match '^\\[(test-[a-z0-9-]+)\\] TEST_(PASS|FAIL|SKIP)\\b(.*)') { } }\n    $script:groups = @($script:resultDoc.groups");
  assert.notEqual(mutP, pesterAdapterSrc);
  assert.throws(() => assertSingleSourceGroupResults(harnessSrc, mutP), assert.AssertionError);
});

// ---------- U-81：_verify/ 卫生 —— 门临时目录自清 + 残留可列（Node 侧在 run-node-gates.mjs 收尾清点；PS 侧在 run-tests 9i） ----------
test('U-81: node launcher and run-tests both list _verify residue and fail on un-cleaned gate temp dirs; temp dirs use retrying rmSync', () => {
  const launcher = fs.readFileSync(path.join(root, 'tests/run-node-gates.mjs'), 'utf8');
  assert.match(launcher, /const TEMP_PREFIX = \/\^\(n9\|n9neg\|r2\|r2neg\|u58\)-\//);
  assert.match(launcher, /has un-cleaned test temp dirs[\s\S]*process\.exitCode = 1/);
  assert.match(launcher, /residue \(informational/);
  const plain = stripPsComments(harnessSrc);
  assert.match(plain, /\$t_vTemp = @\(\$t_vAll \| Where-Object \{ \$_ -match '\^\(n9\|n9neg\|r2\|r2neg\|u58\)-' \}\)/);
  // U-98：合成令牌样本不得再落在会被备份/跟踪的目录
  const r4 = fs.readFileSync(path.join(root, 'tests/test-r4-docs.test.mjs'), 'utf8');
  assert.doesNotMatch(r4, /path\.join\(rootDir, 'tests', 'u58-synthetic\.tmp'\)/, 'U-98: synthetic token sample must not live under tests/');
  assert.match(r4, /path\.join\(rootDir, '_verify', 'u58-synthetic\.tmp'\)/);
  assert.match(plain, /U-81 _verify\/ 有未自清的门临时目录/);
  for (const f of ['tests/test-n9-cross-platform.test.mjs', 'tests/test-r2-post-fallback.test.mjs']) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    const mk = (src.match(/mkdtempSync\(path\.join\(root, '_verify'/g) || []).length;
    const rm = (src.match(/rmSync\(tmp, \{ recursive: true, force: true, maxRetries: 5, retryDelay: 100 \}\)/g) || []).length;
    assert.ok(mk >= 1 && rm === mk, f + ': every mkdtemp has a retrying rmSync in finally (mk=' + mk + ' rm=' + rm + ')');
  }
});

// ---------- U-85（N-29）：.ps1 编码约定 —— 凡 .ps1 必须 UTF-8 BOM（含 reports/**），并由 run-tests 在两运行时各做 ParseFile ----------
function listPs1(dir, acc = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['_verify', '_archive', 'node_modules', '.git'].includes(ent.name)) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) listPs1(p, acc); else if (ent.name.toLowerCase().endsWith('.ps1')) acc.push(p);
  }
  return acc;
}
function assertBomEverywhere(files, readBytes) {
  const missing = files.filter(f => { const b = readBytes(f); return !(b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF); });
  assert.ok(files.length >= 10, 'expected to enumerate the repo .ps1 files, got ' + files.length);
  assert.equal(missing.length, 0, 'U-85 .ps1 without UTF-8 BOM: ' + missing.map(f => path.relative(root, f)).join(', '));
}
test('U-85: every .ps1 in the repo (manifest + reports/** + tests/**) starts with a UTF-8 BOM', () => {
  assertBomEverywhere(listPs1(root), f => fs.readFileSync(f));
});
test('U-85: run-tests.ps1 asserts BOM + ParseFile(0 errors, names the file) over all .ps1 in the current runtime', () => {
  const plain = stripPsComments(harnessSrc);
  assert.match(plain, /Get-ChildItem -LiteralPath \$t_repoRoot -Recurse -Filter \*\.ps1 -File/);
  assert.match(plain, /\$t_head\[0\] -eq 0xEF -and \$t_head\[1\] -eq 0xBB -and \$t_head\[2\] -eq 0xBF/);
  assert.match(plain, /\[System\.Management\.Automation\.Language\.Parser\]::ParseFile\(\$t_f\.FullName/);
  assert.match(plain, /U-85 缺 UTF-8 BOM：/); assert.match(plain, /U-85 ParseFile 有错/);
  assert.match(plain, /\[test-docs\/U-85\] ps1=\{0\} bom-missing=\{1\} parse-errors=\{2\} runtime=PS \{3\}/);
});
test('U-85 negative control: a BOM-less .ps1 is reported by name (synthetic)', () => {
  const files = listPs1(root);
  const victim = files.find(f => f.endsWith('measure-latency.ps1'));
  assert.ok(victim);
  assert.throws(() => assertBomEverywhere(files, f => f === victim ? Buffer.from(fs.readFileSync(f).toString('utf8').replace(/^\uFEFF/, ''), 'utf8') : fs.readFileSync(f)), /measure-latency\.ps1/);
});

// ---------- N-34（R32）：容器无 PS 运行时 ⇒ 用"单引号奇偶"启发式在 Node 侧独立守 .ps1 的字符串闭合（自指门规则 2 的落实）----------
// 口径：逐行；跳过注释行与 here-string 体；去掉双引号字符串后，剩余单引号数为奇数 ⇒ 疑似未闭合（N-34 的两行都会命中）。
// 全仓 40+ 个 .ps1 实测 0 误报（2026-09-26）；若将来出现合理误报，用行尾 `# ps-quote-ok` 豁免。
function oddQuoteLines(text) {
  const bad = []; let here = null;
  text.split('\n').forEach((raw, idx) => {
    const st = raw.replace(/\r$/, '');
    if (here) { if (st.startsWith(here)) here = null; return; }
    if (/@['"]\s*$/.test(st)) { here = st.trimEnd().endsWith("@'") ? "'@" : '"@'; return; }
    if (/^\s*#/.test(st) || /#\s*ps-quote-ok\s*$/.test(st)) return;
    let t = st.replace(/"(?:`.|[^"`])*"/g, '""');
    const m = t.match(/\s#[^'"]*$/); if (m) t = t.slice(0, m.index);
    if ((t.match(/'/g) || []).length % 2 === 1) bad.push({ line: idx + 1, text: st.trim().slice(0, 100) });
  });
  return bad;
}
test('N-34: no .ps1 in the repo has a line with an unbalanced single quote (independent of any PowerShell runtime)', () => {
  const problems = [];
  for (const f of listPs1(root)) {
    const bad = oddQuoteLines(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
    for (const b of bad) problems.push(path.relative(root, f) + ':' + b.line + ' ' + b.text);
  }
  assert.deepEqual(problems, [], 'suspected unclosed single-quoted strings: ' + problems.join(' | '));
});
test('N-34 negative control: the two lines that broke run-tests.ps1 are flagged', () => {
  const broken = "$GroupLinePattern = '^\\[(?<g>test-[a-z0-9-]+)\\] TEST_(?<v>PASS|FAIL|SKIP)\\b(?<rest>.*)\n" +
                 "if ($ln -match '^\\[(?<g>[^\\]/]+)(?:/(?<sub>[^\\]]+))?\\]\\s*(?<rest>.*)) {\n" +
                 "$ok = 'closed'\n";
  const bad = oddQuoteLines(broken);
  assert.deepEqual(bad.map(b => b.line), [1, 2]);
});

// ---------- U-96（N-30）：U-24 桩的状态隔离 + 实例校验 ----------
// 行为只能宿主真跑；这里守形态：无固定端口默认值、桩响应带 run-id、探测断言 run-id 一致且不一致 ⇒ 明确 FAIL（非 SKIP）、
// 端口来自就绪文件、停止文件 + Stop-Process + WaitForExit 回收。
function assertStubIsolation(code) {
  const plain = stripPsComments(code);
  assert.doesNotMatch(plain, /\$t_portA = 18986/, 'hard-coded stub ports must be gone (N-30)');
  assert.match(plain, /\$t_portA = 0; \$t_portB = 0; \$t_portC = 0/, 'ports default to OS-assigned');
  assert.match(plain, /\$t_runId = \[guid\]::NewGuid\(\)/, 'per-run id');
  assert.match(plain, /self\.send_header\('X-MCPS-Stub-Run', RUN_ID\)/, 'every stub response carries the run id');
  assert.match(plain, /class RL\(Tagged\)[\s\S]*class Plain\(Tagged\)[\s\S]*class BodyRL\(Tagged\)/, 'all three handlers derive from the tagging base');
  assert.match(plain, /HTTPServer\(\('127\.0\.0\.1', WANT\[i\]\), h\)/, 'servers bind the requested (0 = free) ports');
  assert.match(plain, /json\.dump\(info, f\)/, 'stub writes the ready file');
  assert.match(plain, /\$t_portA = \[int\]\$t_ready\.ports\[0\]/, 'harness takes the ports from the ready file');
  assert.match(plain, /\$t_instanceOk = \(\$t_seenRun -eq \$t_runId\)/, 'instance check compares run id');
  assert.match(plain, /elseif \(-not \$t_instanceOk\) \{[\s\S]*?\$t_ok = \$false[\s\S]*?stub instance mismatch/, 'mismatch => explicit FAIL with reason (not SKIP, not a silent backoff assertion)');
  assert.match(plain, /os\.path\.exists\(STOP\)/, 'stub exits on stop file');
  assert.match(plain, /WriteAllText\(\$t_stopFile, 'stop'\)[\s\S]*Stop-Process -Id \$t_p\.Id -Force[\s\S]*WaitForExit\(3000\)/, 'cleanup = stop file + Stop-Process + wait');
  assert.match(plain, /instance-verified=True/, 'positive path reports the verified instance');
}
test('U-96: test-retry stub uses OS-assigned ports, tags every response with a run id, fails explicitly on a foreign instance and cleans up', () => {
  assertStubIsolation(harnessSrc);
});
test('U-96 negative control: fixed ports, dropping the run-id tag, or turning the mismatch into SKIP is detected', () => {
  const mut = (a, b) => { const m = harnessSrc.split(a).join(b); assert.notEqual(m, harnessSrc, 'mutation must apply: ' + a); return m; };
  assert.throws(() => assertStubIsolation(mut('$t_portA = 0; $t_portB = 0; $t_portC = 0', '$t_portA = 18986; $t_portB = 18987; $t_portC = 18988')), assert.AssertionError);
  assert.throws(() => assertStubIsolation(mut("self.send_header('X-MCPS-Stub-Run', RUN_ID)", 'pass')), assert.AssertionError);
  assert.throws(() => assertStubIsolation(mut('class Plain(Tagged)', 'class Plain(BaseHTTPRequestHandler)')), assert.AssertionError);
  assert.throws(() => assertStubIsolation(mut('$t_instanceOk = ($t_seenRun -eq $t_runId)', '$t_instanceOk = $true')), assert.AssertionError);
  assert.throws(() => assertStubIsolation(mut('elseif (-not $t_instanceOk) {\n        # U-96：连到了**非本次实例**（陈旧桩 / 别的进程）⇒ 明确失败并说明，绝不继续跑退避断言（那会产出 N-30 那种假红/假绿）\n        $t_ok = $false', 'elseif (-not $t_instanceOk) {\n        $t_skipped = $true')), assert.AssertionError);
  assert.throws(() => assertStubIsolation(mut('while time.time() < deadline and not os.path.exists(STOP):', 'while time.time() < deadline:')), assert.AssertionError);
});

test('U-90 negative control: silencing uncovered cells, dropping a runtime, dropping stub isolation or repeat-consistency is detected', () => {
  const mut = (a, b) => { const m = matrixSrc.split(a).join(b); assert.notEqual(m, matrixSrc, 'mutation must apply: ' + a); return m; };   // 全部出现处都替换（跑前探测有两处）
  // 漏测变沉默：把 exit 3 改成 0
  assert.throws(() => assertAcceptanceMatrix(mut('elseif ($uncovered.Count -gt 0 -and -not $AllowUncovered) { 3 }', 'elseif ($uncovered.Count -gt 0 -and -not $AllowUncovered) { 0 }')), assert.AssertionError);
  // 只跑 PS7：去掉 ps51 格
  assert.throws(() => assertAcceptanceMatrix(mut("@{ n = 'ps51'; exe = (Resolve-Exe $Ps51); want = $Ps51 }, ", '')), assert.AssertionError);
  // 去掉跑前桩探测
  assert.throws(() => assertAcceptanceMatrix(mut('$pre = Get-StaleStubs', '$pre = @()')), assert.AssertionError);
  // 去掉 flaky 判定
  assert.throws(() => assertAcceptanceMatrix(mut("$c.status = 'flaky'; $c.reason = \"inconsistent across", "$c.status = 'pass'; $c.reason = \"inconsistent across")), assert.AssertionError);
  // 改成同进程调用 run-tests
  assert.throws(() => assertAcceptanceMatrix(mut("'-File', $runTests", "'-Command', \"& $runTests\"")), assert.AssertionError);
  // 去掉 BOM
  assert.throws(() => assertAcceptanceMatrix(matrixSrc, Buffer.from(matrixSrc, 'utf8')), assert.AssertionError);
});

test('N-25/U-83 negative control: removing any HasNext guard, re-inlining the formula, or a helper that breaks is detected', () => {
  // v1.51.0：node 兜底段抽成 Invoke-ApiNodeFallback 后，第三处守卫在 helper 里是 **return 形态**
  //   （helper 不得 break/continue，D4 规则）⇒ 正例的 HasNext 守卫断言已兼容两种形态，这里同样两种都变异。
  const guardBreak = 'if (-not $bo.HasNext) { break }';
  const guardReturn = 'if (-not $bo.HasNext) { return';
  const positions = [];
  for (let i = request.indexOf(guardBreak); i >= 0; i = request.indexOf(guardBreak, i + 1)) positions.push([i, guardBreak.length]);
  for (let i = request.indexOf(guardReturn); i >= 0; i = request.indexOf(guardReturn, i + 1)) positions.push([i, guardReturn.length]);
  positions.sort((a, b) => a[0] - b[0]);
  assert.equal(positions.filter(([, l]) => l === guardBreak.length).length, 2, '公有函数里应有 2 处 break 形态守卫');
  assert.equal(positions.filter(([, l]) => l === guardReturn.length).length, 1, 'Invoke-ApiNodeFallback 里应有 1 处 return 形态守卫');
  for (const [p, len] of positions) {
    const mutated = request.slice(0, p) + '# guard removed' + request.slice(p + len);
    assert.notEqual(mutated, request);
    assert.throws(() => assertNoIdleBackoffOnLastAttempt(mutated), assert.AssertionError);
  }
  // 把 sleep 挪到判定之前（判定失效的另一种写法）同样要红
  const first = positions[0][0];
  const sleepAfter = request.indexOf('Start-Sleep -Seconds $bo.WaitSec', first);
  const swapped = request.slice(0, first) + 'Start-Sleep -Seconds $bo.WaitSec\n' + request.slice(first, sleepAfter) + '# moved' + request.slice(sleepAfter + 'Start-Sleep -Seconds $bo.WaitSec'.length);
  assert.throws(() => assertNoIdleBackoffOnLastAttempt(swapped), assert.AssertionError);
  // 有人把公式再抄回某个调用点 ⇒ 单源被破坏 ⇒ 红
  const reinlined = request.replace(guardBreak, guardBreak + '\n$wait = [math]::Pow($script:Cfg.RetryBaseSec, $attempt)');
  assert.notEqual(reinlined, request);
  assert.throws(() => assertNoIdleBackoffOnLastAttempt(reinlined), assert.AssertionError);
  // 判定条件被改弱（-lt → -le：最后一次也会睡）⇒ 红
  const weakened = request.replace('HasNext = ($Attempt -lt $MaxAttempts)', 'HasNext = ($Attempt -le $MaxAttempts)');
  assert.notEqual(weakened, request);
  assert.throws(() => assertNoIdleBackoffOnLastAttempt(weakened), assert.AssertionError);
  // helper 里出现 break（会穿透函数边界）⇒ 红
  const breaking = request.replace('return [PSCustomObject]@{ WaitSec = $w;', 'if (-not ($Attempt -lt $MaxAttempts)) { break }\n        return [PSCustomObject]@{ WaitSec = $w;');
  assert.notEqual(breaking, request);
  assert.throws(() => assertNoIdleBackoffOnLastAttempt(breaking), assert.AssertionError);
});

// ---------- D4（2026-09-30，U-100）：Invoke-ApiRequest 拆分门 —— 跟随真实调用图，不靠旧切片 ----------
function d4Report(src) {
  const defs = new Set([...src.matchAll(/^function\s+([A-Za-z][\w-]+)\s*\{/gm)].map((m) => m[1]));
  const reach = new Set(transitiveCustomCalls(src, 'Invoke-ApiRequest'));
  const closure = closureList(src);
  const problems = [];
  const lineCounts = {};
  for (const h of D4_HELPERS) {
    if (!defs.has(h)) { problems.push(`${h}: not a top-level function`); continue; }
    if (!reach.has(h)) problems.push(`${h}: not reachable from Invoke-ApiRequest (dead helper)`);
    if (!closure.includes(h)) problems.push(`${h}: missing from Get-HttpLayerClosure`);
    const body = psFunctionBody(src, h);
    if (/(?<![\w-])(break|continue)(?![\w-])/.test(stripPsComments(body))) problems.push(`${h}: helper contains break/continue (crosses the function boundary)`);
    lineCounts[h] = body.split(/\r?\n/).length;
  }
  const pub = psFunctionBody(src, 'Invoke-ApiRequest');
  lineCounts['Invoke-ApiRequest'] = pub.split(/\r?\n/).length;
  for (const [n, c] of Object.entries(lineCounts)) if (c > 100) problems.push(`${n}: ${c} lines > 100`);
  // 控制流归属：break/continue/2xx return/耗尽 throw 都在公有函数
  const pubPlain = stripPsComments(pub);
  if ((pubPlain.match(/if \(-not \$bo\.HasNext\) \{ break \}/g) || []).length !== 2) problems.push('Invoke-ApiRequest: expected 2 HasNext break sites (node 兜底段 v1.51.0 抽出为 Invoke-ApiNodeFallback，用动作对象回传)');
  if ((pubPlain.match(/^\s*continue\s*$/gm) || []).length !== 2) problems.push('Invoke-ApiRequest: expected 2 continue sites (同上)');
  if (!pubPlain.includes('throw "重试次数耗尽: $Uri (last HTTP $lastHttpCode)"')) problems.push('Invoke-ApiRequest: exhausted throw missing');
  // Write-ColorOutput 写成功管道 ⇒ 不得出现在"结果被赋值"的 helper 里
  for (const h of D4_HELPERS) if (/Write-ColorOutput/.test(stripPsComments(psFunctionBody(src, h)))) problems.push(`${h}: Write-ColorOutput inside a value-returning helper`);
  return { problems, lineCounts, closureCount: closure.length, reach: [...reach] };
}
test('D4: every helper is top-level, reachable from Invoke-ApiRequest, in the closure, break/continue-free, and all bodies are <= 100 lines', () => {
  const r = d4Report(source);
  assert.deepEqual(r.problems, [], r.problems.join(' | '));
  // U-256（B1-6）：43 = 41 + Add-ApiRequestStat / Get-ApiRequestStats —— 请求账本的写入与聚合都在
  //   Invoke-ApiRequest 内同步调用，按 U-41 的规矩必须进闭包（漏一项 test-n8 会直接报函数名）。
  // U-261（B2-6）：47 = 43 + Get-ApiLedgerVerdict / Set-ApiLedgerStatus / Close-ApiLedgerRow / Add-ApiLedgerRow
  //   —— 成本账本的开口/盖状态码/结行都在 Invoke-ApiRequest 与 Resolve-ApiHttpFailure 内同步调用。
  // U-267（B3-1 第一步）：50 = 47 + Get-ApiReplayKey / Invoke-ApiReplayOnce / Save-ApiReplayFixture
  //   —— 离线回放接缝就在 Invoke-ApiWebOnce 内同步调用（查录制 → 命中即返回；未命中走原路并录制）。
  assert.equal(r.closureCount, 50, 'closure 12 -> 23 -> 24 -> 25 -> 26 -> 30 -> 31 -> 34 -> 35 -> 36 -> 43 -> 47 -> 50（U-267 加回放三件：Get-ApiReplayKey / Invoke-ApiReplayOnce / Save-ApiReplayFixture —— 回放与录制都在 Invoke-ApiWebOnce 内同步调用，按 U-41 的规矩必须进闭包）');
  assert.ok(r.lineCounts['Invoke-ApiRequest'] <= 100, 'Invoke-ApiRequest lines=' + r.lineCounts['Invoke-ApiRequest']);
  console.log('[D4] closure=' + r.closureCount + ' lines=' + JSON.stringify(r.lineCounts));
});
test('D4 negative control: removing a new helper from the closure is named by U-41 and by the D4 gate', () => {
  for (const h of ['Resolve-ApiHttpFailure', 'Write-TlsTrace']) {
    const reverted = withoutClosureMember(source, h);
    assert.throws(() => guardU41(reverted), new RegExp('missing: .*' + h));
    assert.ok(d4Report(reverted).problems.some((p) => p === `${h}: missing from Get-HttpLayerClosure`));
  }
});
test('D4 negative control: a break smuggled into a helper, or a helper no longer called, is red', () => {
  const body = psFunctionBody(source, 'Test-ApiRetryBudget');
  const withBreak = source.replace(body, body.replace('    return $budgetExhausted', '    if ($budgetExhausted) { break }\n    return $budgetExhausted'));
  assert.notEqual(withBreak, source);
  assert.ok(d4Report(withBreak).problems.some((p) => /Test-ApiRetryBudget: helper contains break/.test(p)));
  const uncalled = source.replace('$budgetExhausted = Test-ApiRetryBudget', '$budgetExhausted = $false');
  assert.notEqual(uncalled, source);
  assert.ok(d4Report(uncalled).problems.some((p) => /Test-ApiRetryBudget: not reachable/.test(p)));
});
test('D4 negative control: Write-ColorOutput moved into a value-returning helper is red', () => {
  const body = psFunctionBody(source, 'Invoke-ApiSocksOnce');
  const bad = source.replace(body, body.replace('    $reqSw.Stop()', '    $reqSw.Stop()\n    Write-ColorOutput "leak" "Gray"'));
  assert.notEqual(bad, source);
  assert.ok(d4Report(bad).problems.some((p) => /Invoke-ApiSocksOnce: Write-ColorOutput/.test(p)));
});

// U-104 / M1-C prerequisite. This is a static wiring prediction (evidence layer 1),
// not a claim about an executed runspace. r46-engine-audit.ps1 measures the real
// production assembler + loader in a fresh runspace (layer 2), without searches.
export function assertU104Wiring(src, observedNames = null) {
  const rows = registry(src);
  if (!rows.length) throw new Error('U-104: empty/unreadable engine registry');
  const defs = new Set([...src.matchAll(/^function\s+([A-Za-z][\w-]+)\s*\{/gm)].map(m => m[1]));
  const lineCounts = {};
  for (const e of rows) {
    if (!defs.has(e.func)) throw new Error(`U-104: ${e.name} Func ${e.func} does not exist`);
    const body = psFunctionBody(src, e.func);
    const content = stripPsComments(body.slice(body.indexOf('{') + 1, -1)).trim();
    if (!content) throw new Error(`U-104: ${e.name} Func ${e.func} has zero body lines`);
    lineCounts[e.func] = body.split(/\r?\n/).length;
  }
  const funcs = new Set(rows.map(e => e.func));
  const needs = new Set(rows.flatMap(e => e.needs));
  if (needs.has('Invoke-ApiRequest')) {
    if (!/foreach \(\$fn in \(Get-HttpLayerClosure\)\)/.test(psFunctionBody(src, 'Get-EngineNeeds'))) {
      throw new Error('U-104: Get-EngineNeeds no longer expands HTTP closure');
    }
    for (const n of closureList(src)) needs.add(n);
  }
  for (const n of needs) if (!defs.has(n)) throw new Error(`U-104: effective Needs ${n} does not exist`);
  if (funcs.size !== rows.length || [...funcs].some(f => needs.has(f))) {
    throw new Error('U-104: Func uniqueness/disjointness required for registry-count + deduplicated-Needs formula');
  }
  const pool = psFunctionBody(src, 'Invoke-EnginePool');
  // D2（2026-09-30）：handle 组装外提为 Start-EnginePoolHandles；装配仍在 public，
  // loader 串改到「被 public 调用的 helper」里核，并核 public 真的调了它（跟随调用链，不靠旧切片）。
  const splitPool = src.includes('function Start-EnginePoolHandles {');
  const loader = splitPool ? psFunctionBody(src, 'Start-EnginePoolHandles') : pool;
  // B2-5（U-260）：`$defs` 组装外提为 Get-EnginePoolDefs —— 起因是 Invoke-EnginePool 被 U-163-2 的 100 行红线顶住
  //   （加 execution 记账后 120 行）。跟随调用链核：装配核 helper，public 里核"确实调了 helper"。
  const asmSplit = src.includes('function Get-EnginePoolDefs {');
  const assembler = asmSplit ? psFunctionBody(src, 'Get-EnginePoolDefs') : pool;
  if (!assembler.includes('$needed = Get-EngineNeeds -Engines $Engines') ||
      !assembler.includes('foreach ($fn in $needed)') ||
      !assembler.includes('$defs += "function $fn { $((Get-Item function:$fn).Definition) }"') ||
      !assembler.includes('foreach ($e in $Engines)') ||
      !assembler.includes('$defs += "function $($e.Func) { $((Get-Item "function:$($e.Func)").Definition) }"') ||
      (asmSplit && !pool.includes('Get-EnginePoolDefs -Engines $Engines')) ||
      (splitPool && !pool.includes('$handles = @(Start-EnginePoolHandles -Engines $Engines -EngineArgs $EngineArgs -TrackStatus:$TrackStatus -pool $pool -defs $defs -inject $inject)')) ||
      !loader.includes('foreach ($d in $Defs) { . ([scriptblock]::Create($d)) }')) {
    throw new Error('U-104: production pool assembler/loader changed; revalidate actual injection');
  }
  const expected = new Set([...funcs, ...needs]);
  const observed = new Set(observedNames ?? [...expected].filter(n => defs.has(n)));
  const missing = [...expected].filter(n => !observed.has(n));
  const extra = [...observed].filter(n => !expected.has(n));
  const expectedCount = rows.length + needs.size;
  if (observed.size !== expectedCount || missing.length || extra.length) {
    throw new Error(`U-104: pool function set/count mismatch; actual=${observed.size}; expected=${expectedCount}; missing=${missing.join(',')}; extra=${extra.join(',')}`);
  }
  return { registeredCount: rows.length, effectiveNeedsCount: needs.size, expectedCount, names: [...expected].sort(), lineCounts };
}
test('U-104: every registered Func exists and has nonzero body lines', () => {
  const r = assertU104Wiring(source);
  assert.equal(Object.keys(r.lineCounts).length, registry(source).length);
  assert.ok(Object.values(r.lineCounts).every(n => n > 0));
});
test('U-104: predicted pool set equals registry count plus deduplicated effective Needs (HTTP closure included)', () => {
  const r = assertU104Wiring(source);
  assert.equal(r.names.length, r.registeredCount + r.effectiveNeedsCount);
  assert.ok(r.names.includes('Invoke-WebRequestDirect'));
});
test('U-104 negative: nonexistent Func is mandatory red and names engine + function', () => {
  const bad = source.replace("Func = 'Search-GitHub';", "Func = 'Search-R46Missing';");
  assert.notEqual(bad, source);
  assert.throws(() => assertU104Wiring(bad), /U-104: GitHub Func Search-R46Missing does not exist/);
});
test('U-104 negative: an empty Func body is red', () => {
  const bad = source.replace(psFunctionBody(source, 'Search-Codeberg'), 'function Search-Codeberg {\n # empty\n}');
  assert.notEqual(bad, source);
  assert.throws(() => assertU104Wiring(bad), /U-104: Codeberg Func Search-Codeberg has zero body lines/);
});
test('U-104 negative: a nonexistent Needs definition is red', () => {
  const bad = source.replace("Needs = @('Write-ColorOutput'", "Needs = @('R46-MissingNeed','Write-ColorOutput'");
  assert.notEqual(bad, source);
  assert.throws(() => assertU104Wiring(bad), /U-104: effective Needs R46-MissingNeed does not exist/);
});
test('U-104 negative: dropping one pool-visible function names the missing member', () => {
  const r = assertU104Wiring(source);
  assert.throws(() => assertU104Wiring(source, r.names.filter(n => n !== 'Search-Codeberg')), /missing=Search-Codeberg/);
});
test('U-104 negative: an unexpected pool-visible function is red', () => {
  const r = assertU104Wiring(source);
  assert.throws(() => assertU104Wiring(source, [...r.names, 'R46-Unexpected']), /extra=R46-Unexpected/);
});
test('U-104 negative: losing the registered-Func injection statement is red', () => {
  const needle = '$defs += "function $($e.Func) { $((Get-Item "function:$($e.Func)").Definition) }"';
  const bad = source.replace(needle, '# lost registered function injection');
  assert.notEqual(bad, source);
  assert.throws(() => assertU104Wiring(bad), /U-104: production pool assembler\/loader changed/);
});

// U-107: static lifecycle guard; runtime cleanup witnesses are separate evidence.
export function assertU107ProbeLifecycle(src) {
  const s = src.slice(src.indexOf('$parseScript = '), src.indexOf('# ---------- 4)'));
  const need = (yes, why) => { if (!yes) throw new Error('U-107: ' + why); };
  need(/\$parseTempDir = Join-Path \(\[System\.IO\.Path\]::GetTempPath\(\)\)/.test(s) &&
       /\$parseFile = Join-Path \$parseTempDir 'parse-probe\.ps1'/.test(s) &&
       !/\$parseFile\s*=\s*Join-Path \$OutDir/.test(s), 'probe must use an isolated system temporary directory, never OutDir');
  need(/\[guid\]::NewGuid\(\)\.ToString\('N'\)/.test(s) &&
       /\$parseTempOwned = \$false/.test(s) && /\$parseTempOwned = \$true/.test(s), 'unique path and explicit ownership are required');
  need(/try\s*\{[\s\S]*New-Item -ItemType Directory[\s\S]*WriteAllText\(\$parseFile[\s\S]*foreach \(\$rt in \$runtimes\)[\s\S]*\}\s*finally\s*\{\s*if \(\$parseTempOwned\)\s*\{\s*Remove-Item -LiteralPath \$parseTempDir -Recurse -Force -ErrorAction Stop/.test(s), 'write and execution must be protected by finally cleanup; cleanup failure must not be silent');
  need(s.includes("'[\\\\/](_verify|node_modules|\\.git)[\\\\/]'"), 'parse exclusions must handle Windows and POSIX separators');
  need(/WriteAllText\(\$parseFile, \$parseScript, \(New-Object System.Text.UTF8Encoding \$true\)\)/.test(s), 'temporary probe must retain UTF-8 BOM');
}
test('U-107: matrix probe has isolated temporary ownership and finally cleanup', () => assertU107ProbeLifecycle(matrixSrc));
test('U-107 negative: placing the probe back in OutDir is red', () => {
  const bad = matrixSrc.replace("$parseFile = Join-Path $parseTempDir 'parse-probe.ps1'", "$parseFile = Join-Path $OutDir 'parse-probe.ps1'");
  assert.notEqual(bad, matrixSrc); assert.throws(() => assertU107ProbeLifecycle(bad), /U-107: probe must use/);
});
test('U-107 negative: losing finally cleanup is red', () => {
  const bad = matrixSrc.replace('} finally {\n    if ($parseTempOwned)', '} catch {\n    if ($parseTempOwned)');
  assert.notEqual(bad, matrixSrc); assert.throws(() => assertU107ProbeLifecycle(bad), /U-107: write and execution/);
});
test('U-107 negative: a fixed directory or unowned cleanup is red', () => {
  for (const [a,b] of [["[guid]::NewGuid().ToString('N')", "'fixed'"], ['$parseTempOwned = $true', '$parseTempOwned = $false']]) {
    const bad = matrixSrc.replace(a,b); assert.notEqual(bad,matrixSrc);
    assert.throws(() => assertU107ProbeLifecycle(bad), /U-107: unique path/);
  }
});
test('U-107 negative: Windows-only parse exclusions are red', () => {
  const bad=matrixSrc.replace("'[\\\\/](_verify|node_modules|\\.git)[\\\\/]'", "'\\\\(_verify|node_modules|\\.git)\\\\'");
  assert.notEqual(bad,matrixSrc); assert.throws(() => assertU107ProbeLifecycle(bad), /U-107: parse exclusions/);
});

export function assertU108Coverage(table) {
  const row5=table.split(/\r?\n/).find(l=>l.startsWith('| SOP 5 / 规则6 |'));
  const row7=table.split(/\r?\n/).find(l=>l.startsWith('| SOP 7 / 规则7 |'));
  if (!row5 || !/抖动的指标不能当判据/.test(row5) || !/源码 SHA-256/.test(row5) || !/参考/.test(row5)) throw new Error('U-108: missing SOP 5 jitter / code identity / reference-only rule');
  if (!/样本量/.test(row5) || !/0 结果.*INCONCLUSIVE/.test(row5) || !/不得.*不一致/.test(row5)) throw new Error('U-108: zero-result sample must be INCONCLUSIVE, not a mismatch');
  if (!row7 || !/报数字须报口径与边界/.test(row7)) throw new Error('U-108: missing SOP 7 numeric boundary rule');
  for (const term of ['对象','边界','纳入','排除','单位','源码']) if (!row7.includes(term)) throw new Error('U-108: numeric boundary row missing '+term);
}
const u108Table = () => fs.readFileSync(path.join(root, 'reports/gates/gate-coverage-2026-09-26.md'),'utf8');
test('U-108: coverage includes SOP 5 and SOP 7 with their required boundaries',()=>assertU108Coverage(u108Table()));
test('U-108 negative: removing SOP 5 is red',()=>{
  const s=u108Table(),bad=s.replace(/^\| SOP 5 \/ 规则6 \|.*\r?\n/m,'');assert.notEqual(bad,s);
  assert.throws(()=>assertU108Coverage(bad),/U-108: missing SOP 5/);
});
test('U-108 negative: treating zero results as PASS is red',()=>{
  const s=u108Table(),bad=s.replace(/(^\| SOP 5 \/ 规则6 \|.*)INCONCLUSIVE/m,'$1PASS');assert.notEqual(bad,s);
  assert.throws(()=>assertU108Coverage(bad),/U-108: zero-result sample/);
});
test('U-108 negative: removing SOP 7 is red',()=>{
  const s=u108Table(),bad=s.replace(/^\| SOP 7 \/ 规则7 \|.*\r?\n/m,'');assert.notEqual(bad,s);
  assert.throws(()=>assertU108Coverage(bad),/U-108: missing SOP 7/);
});
test('U-108 negative: dropping the exclusion boundary is red',()=>{
  const s=u108Table(),bad=s.replace(/(^\| SOP 7 \/ 规则7 \|.*)排除/m,'$1省略');assert.notEqual(bad,s);
  assert.throws(()=>assertU108Coverage(bad),/U-108: numeric boundary row missing 排除/);
});
