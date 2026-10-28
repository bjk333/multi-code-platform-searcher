// U-206/U-207（2026-10-21）：**网络失败必须可归因**。
// 实网病灶（本机 2026-10-21）：hosts 把 api.github.com/huggingface.co 等 100+ 域指向 127.0.0.1（`#S302`），
//   宿主又注入了一个已死的 HTTPS_PROXY=127.0.0.1:50955；而唯一可用的 socks5://127.0.0.1:7897 因
//   `MCPS_PROXY` 白名单只含 github 域，对 gitlab.com 从未被尝试。最终用户只看到「单引擎超 10s 截止」，
//   既不知道是 hosts、也不知道是白名单，更不知道有个能用的代理没被用上。
// 本门钉住三件事：
//   1. 白名单判定单源（Get-McpsProxySpec），被排除 ⇒ 候选里没有它，但**证据留下**；
//   2. `MCPS_PROXY_FALLBACK=1` ⇒ 忽略白名单且**排在最前**（否则死路由先耗光引擎预算）；
//   3. 失败提示的对象形状：`Get-HostsOverride` 返回 PSCustomObject，只能用 `.Loopback` 判（踩过一次）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { probeWithMutants, rootDir, MAIN, assertMutantsKilled, PRODUCT_SRC } from './r94-ps-probe.mjs';

const MAIN_SRC = PRODUCT_SRC();

test('U-206-A 接线：选路证据、默认预算、提示函数都进了闭包/注入表', () => {
  assert.match(MAIN_SRC, /_routeTrace = \[System\.Collections\.Concurrent\.ConcurrentDictionary\[string,object\]\]::new\(\)/, '选路证据容器缺失');
  assert.match(MAIN_SRC, /_injectVars = @\([^)]*'_routeTrace'/, '★ _routeTrace 必须注入并发 Runspace（否则引擎内写不进证据）');
  assert.match(MAIN_SRC, /_routeTrace = \$script:_routeTrace; _networkEngine = 'GitLabBlobs'/, '★ GitLabBlobs 嵌套池的 inject2 也要共享 _routeTrace');

  const closure = MAIN_SRC.match(/function Get-HttpLayerClosure[\s\S]*?return @\(([\s\S]*?)\)\n}/)[1];
  for (const fn of ['Get-McpsProxySpec', 'Get-NetworkRouteHint', 'Get-HostsOverride', 'Test-LoopbackAddress']) {
    assert.ok(closure.includes(`'${fn}'`), `★ HTTP 闭包缺 ${fn}（Runspace 内调用会 $null 崩）`);
  }

  assert.match(MAIN_SRC, /NetworkRouteBudgetMs = 4000/, '★ 需要默认总预算：每候选各 2×2.5s 会超过引擎 10s 截止，归因就丢了');
  assert.match(MAIN_SRC, /if \(\$BudgetMs -le 0\) \{ try \{ \$BudgetMs = \[int\]\$script:Cfg\.NetworkRouteBudgetMs \}/, '默认预算没被 Get-NetworkRoute 使用');
  assert.match(MAIN_SRC, /ExcludedProxy = \$\(if \(\$excluded\)/, '被白名单排除的代理必须留证据');
});

test('U-206-B 行为：白名单/兜底顺序 + 提示只读对象属性 + 变异可红', async () => {
  const probe = `
$out = [ordered]@{}
$env:MCPS_PROXY = 'socks5://127.0.0.1:7897;api.github.com,github.com'
$env:MCPS_PROXY_FALLBACK = ''
$out.gitlab = @(@(Get-NetworkCandidates -Target ([uri]'https://gitlab.com/api/v4/version')) | ForEach-Object { $_.Source })
$out.gh = @(@(Get-NetworkCandidates -Target ([uri]'https://api.github.com/rate_limit')) | ForEach-Object { $_.Source })
$env:MCPS_PROXY_FALLBACK = '1'
$out.gitlabFb = @(@(Get-NetworkCandidates -Target ([uri]'https://gitlab.com/api/v4/version')) | ForEach-Object { $_.Source })
$env:MCPS_PROXY_FALLBACK = ''
$out.specGitlab = (Get-McpsProxySpec -HostName 'gitlab.com').Allowed
$out.specGh = (Get-McpsProxySpec -HostName 'api.github.com').Allowed
# 白名单 + 选路证据 ⇒ 提示必须同时说清"没试哪个代理"和"试过哪些路由"
$script:_routeTrace['gitlab.com'] = [pscustomobject]@{ Trace = @('HTTPS_PROXY→unknown'); ExcludedProxy = 'socks5://127.0.0.1:7897'; Whitelist = @('api.github.com','github.com'); Route = 'HTTPS_PROXY' }
$out.hintWl = Get-NetworkRouteHint -Uri 'https://gitlab.com/api/v4/version' -HostsOverride $null
# hosts 证据：传**对象**（真实返回值形状），不是字符串行
$fake = [pscustomobject]@{ Host = 'api.github.com'; Ip = '127.0.0.1'; Line = '127.0.0.1 api.github.com #S302'; Loopback = $true }
$out.hintHosts = Get-NetworkRouteHint -Uri 'https://api.github.com/rate_limit' -HostsOverride $fake
$fake2 = [pscustomobject]@{ Host = 'cdn.example'; Ip = '203.0.113.9'; Line = '203.0.113.9 cdn.example'; Loopback = $false }
$out.hintPublic = Get-NetworkRouteHint -Uri 'https://cdn.example/x' -HostsOverride $fake2
$out.hintNone = Get-NetworkRouteHint -Uri 'https://nohost.invalid/x' -HostsOverride $null
$out.cfgBudget = [int]$script:Cfg.NetworkRouteBudgetMs
$out
`;
  const r = await probeWithMutants(probe, [
    // 白名单失效（把"允许"写成恒真）⇒ gitlab 也会拿到 MCPS_PROXY 候选
    { name: 'whitelist-always-allowed', fn: 'Get-NetworkCandidates', find: 'if ($ms.Allowed) {', replace: 'if ($true) {' },
    // 兜底开关失效 ⇒ 开了也拿不到候选
    { name: 'fallback-ignored', fn: 'Get-NetworkCandidates', find: "elseif ($env:MCPS_PROXY_FALLBACK -eq '1') {", replace: 'elseif ($false) {' },
    // 提示丢掉白名单那条（用户就永远不知道该加哪个域）
    { name: 'hint-drop-whitelist', fn: 'Get-NetworkRouteHint', find: 'if ($tr.ExcludedProxy) {', replace: 'if ($false) {' },
    // 判反了（把劫持当正常、把公网 IP 当劫持）⇒ 两个提示都会对不上
    { name: 'hint-invert-loopback', fn: 'Get-NetworkRouteHint', find: 'if ($ov -and $ov.Loopback) {', replace: 'if ($ov -and -not $ov.Loopback) {' },
  ], { timeoutMs: 180000 });

  const o = r.real;
  assert.equal(o.specGitlab, false, 'gitlab.com 不在白名单 ⇒ Allowed=false');
  assert.equal(o.specGh, true, 'api.github.com 在白名单 ⇒ Allowed=true');

  assert.ok(!o.gitlab.includes('MCPS_PROXY'), '★ 白名单外的域不得直接拿到 MCPS_PROXY 候选（凭据外流风险）');
  assert.ok(o.gitlab.includes('direct'), 'direct 必须始终是候选（最后一根稻草）');
  assert.equal(o.gitlabFb[0], 'MCPS_PROXY(fallback)', '★ 开了兜底必须排最前：死路由先跑会把引擎预算耗光（实测 5s+5s > 10s）');
  assert.equal(o.gh[0], 'MCPS_PROXY', '白名单内仍优先走 MCPS_PROXY');

  assert.match(o.hintWl, /MCPS_PROXY 白名单未包含该域/, '★ 必须说清"哪个代理没被尝试"');
  assert.match(o.hintWl, /MCPS_PROXY_FALLBACK=1/, '★ 必须给出可执行开关');
  assert.match(o.hintWl, /选路：HTTPS_PROXY→unknown/, '★ 必须给出选路结论（哪个候选、什么结论）');
  assert.match(o.hintHosts, /hosts 把它指向 127\.0\.0\.1/, '★ 劫持证据必须出现');
  assert.match(o.hintHosts, /#S302/, '★ 要带原始 hosts 行，用户才能定位是谁写的');
  assert.equal(o.hintPublic, '', 'hosts 指向公网 IP 不是劫持 ⇒ 不得乱报');
  assert.equal(o.hintNone, '', '没有任何证据时提示必须为空（失败路径不加噪音）');
  assert.equal(o.cfgBudget, 4000);

  assertMutantsKilled(r, (v, tag) => {
    if (v === undefined) assert.fail(tag + ': undefined');
    assert.ok(!(v.gitlab || []).includes('MCPS_PROXY'), tag + ': 白名单外仍给了代理候选');
    assert.equal((v.gitlabFb || [])[0], 'MCPS_PROXY(fallback)', tag + ': 兜底候选丢失');
    assert.match(v.hintWl || '', /白名单未包含该域/, tag + ': 白名单提示丢失');
    assert.match(v.hintHosts || '', /hosts 把它指向/, tag + ': hosts 证据丢失');
  });
});
