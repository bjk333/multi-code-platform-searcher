// U-244（v1.53.26，验收 B1-3）：`-Doctor` 的**逐引擎代理覆盖**（proxyCoverage）。
//
// 为什么要有这条门（事实依据，2026-10-25 本机实测）：
//   · `.env`: `MCPS_PROXY=socks5://127.0.0.1:7897;api.github.com,github.com,raw.githubusercontent.com`
//     ⇒ **gitlab.com 不在白名单**，GitLab / GitLabBlobs 只能走其余候选，实测等满 12.1s / 17.1s 截止；
//   · `-Doctor` 此前只打印"MCPS_PROXY 白名单域 3 个"，**没有任何一处说得出"这个域被排除了"**
//     ⇒ 用户看到"某源超时"只能反推，且极易误判成源侧故障（F6 的成因）。
//
// 门分四层：
//   A 结构：注册表每个引擎都有 Host、形态合法、且该主机名**在源码里逐字存在**（防手抄错域）；
//   B 真值表：8 个注入用例（被排除但另有代理 / 被排除且只剩直连 / 补齐后放行 / 无白名单 /
//     fallback 生效 / NO_PROXY 命中 / NO_PROXY 未命中 / http 形态 spec 的已记录现状）；
//     ★每一条都对应一个具体误判形态 —— 负例能力由真值表本身承担，不做可执行变异；
//   C 接线：Doctor 报告与文本输出都接上；路由结论必须**取自 Get-NetworkCandidates**（不得另写一份白名单解析）；
//   D 可执行变异：A/C 两层用字符串变异验证"改坏了会红"（4 个负例）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runPwsh, rootDir } from './r2-ps-run.mjs';
import { sourceAll } from './lib/source.mjs';

const MAIN = path.join(rootDir, 'multi-platform-searcher.ps1');
const SRC = sourceAll(rootDir);
const ENG_DIR = path.join(rootDir, 'engines');
const ENG_SRC = fs.readdirSync(ENG_DIR).filter(f => f.endsWith('.ps1'))
  .map(f => fs.readFileSync(path.join(ENG_DIR, f), 'utf8')).join('\n');

/** 注册表里的一行 → { name, kind, host } */
function regRows(src) {
  const i = src.indexOf('$script:_engineRegistry = @(');
  assert.ok(i > 0, '锚点缺失：_engineRegistry');
  const j = src.indexOf('\n)', i);
  const out = [];
  for (const line of src.slice(i, j).split('\n')) {
    const m = line.match(/Name\s*=\s*'([^']+)'\s*;\s*Kind\s*=\s*'([^']+)'(.*)$/);
    if (!m) continue;
    const hm = m[3].match(/Host\s*=\s*'([^']*)'/);
    out.push({ name: m[1], kind: m[2], host: hm ? hm[1] : '' });
  }
  return out;
}

/** 取函数体（`function X {` 到列 0 的 `}`） */
function fnBody(src, name) {
  const i = src.indexOf(`function ${name} {`);
  assert.ok(i > 0, `函数缺失：${name}`);
  const j = src.indexOf('\n}', i);
  assert.ok(j > i, `函数体未闭合：${name}`);
  return src.slice(i, j);
}

/** 剥掉**整行**注释（PowerShell `#`）后再量代码。
 *  为什么要这一步：本文件的函数头注里会**引用反例写法**（"不得用 `$null -ne $Spec`"），
 *  直接对原文 `doesNotMatch` 会被自己写的注释绊住 —— 本门第一版就栽在这里（U-244-E 与变异⑤同红）。
 *  同类坑：§10.7 里"全文件禁词被历史注释绊住"。判据只能量**代码**，不能量**说明代码为什么错**的那段话。 */
function codeOnly(body) {
  return body.split('\n').filter(l => !/^\s*#/.test(l)).join('\n');
}

/** A 层的判据（可对任意源码跑，供变异使用） */
function structureBad(src, repo) {
  const bad = [];
  const rows = regRows(src);
  if (rows.length === 0) bad.push('注册表解析为空');
  for (const r of rows) {
    if (!r.host) { bad.push(`${r.name}: 缺 Host`); continue; }
    if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(r.host)) bad.push(`${r.name}: Host 形态非法(${r.host})`);
    if (!repo.includes(r.host)) bad.push(`${r.name}: Host 在源码里找不到逐字出现(${r.host}) —— 手抄错域？`);
  }
  return bad;
}

/** C 层的判据 */
function wiringBad(src) {
  const bad = [];
  if (!/^\s*\$doctorReport\['proxyCoverage'\]\s*=\s*Get-DoctorProxyCoverage/m.test(src)) bad.push('doctorReport 未接 proxyCoverage');
  const cov = fnBody(src, 'Get-DoctorProxyCoverage');
  if (!/Get-NetworkCandidates\s+-Target/.test(cov)) bad.push('Get-DoctorProxyCoverage 未取自 Get-NetworkCandidates（另写了选路？）');
  const pure = fnBody(src, 'Resolve-ProxyCoverage');
  if (/-split\s+';'/.test(pure) || /-split\s+','/.test(pure)) bad.push('Resolve-ProxyCoverage 自己解析白名单（U-207 单一来源被破坏）');
  if (!/Get-McpsProxySpec/.test(pure)) bad.push('Resolve-ProxyCoverage 未用 Get-McpsProxySpec');
  if (!/\[hosts\]/.test(src)) bad.push('文本输出缺 hosts 提示行');
  if (!/OnlyDirect/.test(src)) bad.push('文本输出未按 OnlyDirect 收窄（会 cry wolf）');
  return bad;
}

let cache = null;
async function facts() {
  if (cache) return cache;
  const r = await runPwsh(['-File', path.join(rootDir, 'tests/u244-proxy-coverage-harness.ps1')], { timeoutMs: 180000 });
  assert.equal(r.status, 0, `harness rc=${r.status}: ${(r.stderr || '').slice(-800)}`);
  const line = r.stdout.split(/\r?\n/).filter(l => l.trim().startsWith('{"ok"')).pop();
  assert.ok(line, `harness 未输出 JSON 事实行；stdout=${(r.stdout || '').slice(-500)}`);
  cache = JSON.parse(line);
  return cache;
}

test('U-244-A: 注册表每个引擎都有合法 Host，且该主机名在源码里逐字存在', async () => {
  const f = await facts();
  const rows = regRows(SRC);
  // ★不写死引擎数（那是"第二份清单"）：只要求"文本解析得到的每一行都在 harness 里出现"，
  //   引擎增删由 U-100-B（注册表 ↔ catalog 双向）负责 —— 本门只管 **Host 这一列**是否齐全可信。
  assert.ok(rows.length > 0, '注册表解析为空');
  const bad = structureBad(SRC, ENG_SRC + '\n' + SRC);
  assert.deepEqual(bad, [], 'Host 结构/溯源问题：' + bad.join('; '));
  // harness 侧独立复算一遍（两边口径必须一致，防"门自己算错了"）
  assert.equal(f.registry.length, rows.length, 'harness 与文本解析的引擎数不一致');
  assert.deepEqual(f.fails, [], 'harness 自检失败：' + f.fails.join('; '));
});

test('U-244-B: 覆盖分类真值表（8 例，含"只剩直连才报红"与 fallback 负例）', async () => {
  const f = await facts();
  const want = {
    'excluded-but-other-proxy': { Route: 'env-proxy', Whitelist: 'excluded', Excluded: true, OnlyDirect: false, NoProxy: false },
    'excluded-direct-only': { Route: 'direct', Whitelist: 'excluded', Excluded: true, OnlyDirect: true, NoProxy: false },
    'covered': { Route: 'mcps-proxy', Whitelist: 'allowed', Excluded: false, OnlyDirect: false, NoProxy: false },
    'no-whitelist': { Route: 'mcps-proxy', Whitelist: 'all', Excluded: false, OnlyDirect: false, NoProxy: false },
    // fallback 生效时 Excluded 必须为 false —— 否则"已放行"会被报成"被排除"
    'fallback-active': { Route: 'mcps-proxy-fallback', Whitelist: 'excluded', Excluded: false, OnlyDirect: false, NoProxy: false },
    'no-proxy-hit': { Route: 'direct', Whitelist: 'excluded', Excluded: true, OnlyDirect: true, NoProxy: true },
    'no-proxy-miss': { Route: 'direct', Whitelist: 'excluded', Excluded: true, OnlyDirect: true, NoProxy: false },
    // ★已记录现状（非期望）：http:// 形态的 MCPS_PROXY 不被识别 ⇒ 白名单整段失效
    'http-spec-ignored-documented': { Route: 'env-proxy', Whitelist: 'n/a', Excluded: false, OnlyDirect: false, NoProxy: false }
  };
  assert.deepEqual(f.cases.map(c => c.id).sort(), Object.keys(want).sort(), '用例集不一致');
  for (const c of f.cases) {
    const w = want[c.id];
    for (const k of Object.keys(w)) assert.equal(c[k], w[k], `${c.id}.${k}: got=${c[k]} want=${w[k]}`);
  }
});

test('U-244-C: 接线 —— 报告/文本/单一选路来源', () => {
  assert.deepEqual(wiringBad(SRC), [], '接线问题：' + wiringBad(SRC).join('; '));
});

test('U-244-E: ★生产路径回归 —— 不传 -Spec 必须读环境（B1-3 曾把 NO_PROXY 整体弄失效）', async () => {
  const f = await facts();
  // 2026-10-25 第一轮全量：`U-156 NO_PROXY ignored`。根因是 `param([string]$Spec = $null)` 在 PowerShell 里
  //   落成**空串** ⇒ `$null -ne $Spec` 恒真 ⇒ 生产路径（不传 -Spec）被判成"明确没有 NO_PROXY"。
  //   ★上面 B 层 8 个用例全部显式传 -Spec，**一条都测不到这个 bug** —— 这就是本用例存在的唯一理由：
  //   负例必须覆盖"调用方什么也没传"的那条路，因为那才是用户每天走的路。
  assert.equal(f.prodPath, true, '不传 -Spec 时必须读进程环境 NO_PROXY（false ⇒ 用户的 NO_PROXY 被整体忽略）');
  assert.equal(f.prodPathNoSpec, false, '显式传空串必须表示"没有 NO_PROXY"，不得回落读环境');
  // 结构层钉子：判据必须是 $PSBoundParameters，不是值比较
  const body = codeOnly(fnBody(SRC, 'Test-NetworkNoProxy'));
  assert.match(body, /\$PSBoundParameters\.ContainsKey\('Spec'\)/, '必须用 $PSBoundParameters 判"传没传"（值比较分不出"没传"与"传空串"）');
  assert.doesNotMatch(body, /\$null\s+-ne\s+\$Spec/, '不得用 `$null -ne $Spec` 判——[string] 形参的 $null 默认值会落成空串');
});

test('U-244-D: 变异负例（5 个：删 Host / 抄错域 / 另写选路 / 自己解析白名单 / 退回值比较）', () => {
  const repo = ENG_SRC + '\n' + SRC;
  // ① 删掉一个 Host（★按"字段片段"定位，不假设它与 Platforms 的先后顺序 —— 本门第一版就假设了顺序，
  //   后来为了不碰 G2 的既有解析器把 Host 挪到 Platforms 之后，变异随即"未生效"）
  const hostFrag = "Host = 'gitlab.com';";
  const hAt = SRC.indexOf(hostFrag);
  assert.ok(hAt > 0, '锚点缺失：Host = gitlab.com');
  const m1 = SRC.slice(0, hAt) + SRC.slice(hAt + hostFrag.length);
  assert.notEqual(m1, SRC, '变异①未生效');
  assert.ok(structureBad(m1, repo).some(x => x.includes('GitLab')), '删 Host 未被判红');
  // ② 把域抄错
  const m2 = SRC.split("Host = 'gitlab.com';").join("Host = 'gitlab.io';");
  assert.notEqual(m2, SRC, '变异②未生效');
  assert.ok(structureBad(m2, repo).some(x => x.includes('找不到逐字出现')), '抄错域未被判红');
  // ③ 不再取自 Get-NetworkCandidates
  // ★必须全量替换：这个片段在别的函数里也出现，只替第一处会打在别的函数上 ⇒ 变异没落到被测函数（本门自己踩过）
  const m3 = SRC.split('Get-NetworkCandidates -Target').join('Get-MyOwnRoute -Target');
  assert.notEqual(m3, SRC, '变异③未生效');
  assert.ok(wiringBad(m3).some(x => x.includes('未取自 Get-NetworkCandidates')), '另写选路未被判红');
  // ④ 自己在分类器里解析白名单
  const m4 = SRC.replace("    $spec = Get-McpsProxySpec -HostName $h -ProxySpec $ProxySpec",
    "    $raw = [string]$ProxySpec -split ';'\n    $spec = Get-McpsProxySpec -HostName $h -ProxySpec $ProxySpec");
  assert.notEqual(m4, SRC, '变异④未生效');
  assert.ok(wiringBad(m4).some(x => x.includes('自己解析白名单')), '第二份白名单解析未被判红');
  // ⑤ 判据退回**值比较**（= B1-3 的真 bug 形态）。这是本门里唯一"变异还原历史故障"的一条：
  //   它证明 U-244-E 的结构钉子真的会在旧写法上响。
  const pb = "$hasSpec = $PSBoundParameters.ContainsKey('Spec')";
  assert.ok(SRC.includes(pb), '锚点缺失：$PSBoundParameters 判据');
  const m5 = SRC.replace(pb, '$hasSpec = ($null -ne $Spec)');
  assert.notEqual(m5, SRC, '变异⑤未生效');
  const b5 = codeOnly(fnBody(m5, 'Test-NetworkNoProxy'));
  assert.doesNotMatch(b5, /\$PSBoundParameters/, '退回值比较后必须不再含 $PSBoundParameters');
  assert.match(b5, /\$null\s+-ne\s+\$Spec/, '退回值比较后必须呈现旧写法');
});