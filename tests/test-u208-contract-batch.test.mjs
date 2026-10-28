// U-208 · v1.47.2「契约可信批」常驻门：四项**对外承诺**是否真的落地
//
// 为什么需要这道门（都来自 v1.47.0 全模块审计，报告在 reports/审计-全模块验收-v1.47.0-2026-10-21.md）：
//   ① 进程退出码：`metrics.ExitCode` 算了 0/2/3/4，但全脚本只有 `exit 0` ⇒ 进程 rc 恒 0，
//      "一个源都没查成"在 Agent/CI 眼里是**成功**（文档却承诺了 0/2/3/4）。
//   ② `-LocalCodeSearch` 单用：dispatch 只判 `$CodeEvidence` ⇒ 落到 repo 模式，实发 4 个远程请求、
//      0 条、零告警；说明书 §4 的官方示例就踩这条。
//   ③ 磁盘缓存：`Flush-LruCache` 是"内存 LRU 全集重写"，而内存从空起步 ⇒ 每轮删光旧键（entries 恒为 1）。
//   ④ deadline：`Stop()` 打不断同步探活 ⇒ `_networkFailures` 连键都没有，只剩一句"超 Ns 截止"。
//
// 判据分两层：**静态接线**（必须能变异成红）+ **真跑**（pure：不联网；live：本地检索）。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sourceAll } from './lib/source.mjs';

const root = path.resolve(import.meta.dirname, '..');
const mainPath = path.join(root, 'multi-platform-searcher.ps1');
const SRC = sourceAll(root);   // v1.54.0（B3-2）：函数在 lib/，静态断言读"加载后视图"

function pwsh(script, timeout = 120000) {
  const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], {
    cwd: root, encoding: 'utf8', timeout, windowsHide: true,
  });
  if (r.error) throw r.error;
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

// ---------- ① 进程退出码 ----------
function checkExitWiring(src) {
  const at = src.indexOf('} # end main-flow guard');
  assert.ok(at > 0, 'main-flow guard 收尾标记不见了');
  const tail = src.slice(Math.max(0, at - 1200), at);
  assert.match(tail, /\$processExitCode = 0/, '收尾必须先把进程码置 0');
  assert.match(tail, /if \(\$coverage\.Verdict -in @\('none', 'no-engines'\)\)/,
    '只有"一个引擎都没查成"才允许非 0（partial/degraded 必须保持 0）');
  assert.match(tail, /exit \$processExitCode/, '★ 必须真的 exit —— 只写 metrics 不算落地');
  assert.doesNotMatch(tail, /\[Environment\]::ExitCode\s*=/, '★ 不能用 [Environment]::ExitCode = … ：同会话调用方会把该码继承过去');
}
test('U-208 A: 主流程收尾把退出码落到进程，且只对 none/no-engines 非 0', () => {
  checkExitWiring(SRC);
});
test('U-208 A negative control: 删掉 exit / 放宽到 partial / 换成 Environment::ExitCode 都必须被点名', () => {
  // ★只能删**真正的收尾行**：`exit $processExitCode` 在顶部注释里也出现过，按首处替换会打空（假绿）
  const noExit = SRC.replace(/^exit \$processExitCode$/m, '');
  assert.notEqual(noExit, SRC);
  assert.throws(() => checkExitWiring(noExit), /必须真的 exit/);
  const loose = SRC.replace("@('none', 'no-engines')", "@('none', 'no-engines', 'partial')");
  assert.notEqual(loose, SRC);
  assert.throws(() => checkExitWiring(loose), /只有"一个引擎都没查成"/);
  const env = SRC.replace(/^exit \$processExitCode$/m, '[Environment]::ExitCode = $processExitCode');
  assert.notEqual(env, SRC);
  assert.throws(() => checkExitWiring(env), /\[Environment\]::ExitCode|必须真的 exit/);
});

// ---------- ② -LocalCodeSearch 自足 ----------
function checkLocalDispatch(src) {
  assert.match(src, /elseif \(\$CodeEvidence -or \$LocalCodeSearch\) \{ \$runModes = @\('code'\) \}/,
    '★ -LocalCodeSearch 必须参与模式选择（否则开关空转、落到 repo 模式）');
  // elseif 链的最后一支必须紧跟 else；中间插任何语句都会把 `else` 抢走（实测：单用开关仍跑 repo）
  assert.match(src, /elseif \(\$CodeEvidence -or \$LocalCodeSearch\) \{ \$runModes = @\('code'\) \}\r?\nelse \{ \$runModes = @\('repo'\) \}/,
    '★ elseif 链必须连续到 else —— 中间插语句会把 else 抢走');
  assert.match(src, /本地检索未接管（\{0\}）：已降级到远程 code 引擎/, '降级必须留痕（否则用户以为结果来自本机）');
  // v1.47.8：原因必须照抄引擎 reason，不能三种情况共用一句"0 命中"
  assert.match(src, /\$localWhy = \[string\]\$localReasonTmp/, '★ 降级原因必须取自 _engineStatusReason，不能写死文案');
  assert.match(src, /TryGetValue\('LocalCode'/, '降级原因必须读 LocalCode 的状态');
}
test('U-208 B: -LocalCodeSearch 参与模式分派，降级远程时留痕', () => {
  checkLocalDispatch(SRC);
});
test('U-208 B negative control: 退回只判 $CodeEvidence、或在链中插语句都必须被点名', () => {
  const reverted = SRC.replace('elseif ($CodeEvidence -or $LocalCodeSearch)', 'elseif ($CodeEvidence)');
  assert.notEqual(reverted, SRC);
  assert.throws(() => checkLocalDispatch(reverted), /必须参与模式选择/);
  // ★行尾不能写死：主脚本是 LF（写入过 CRLF 的机器上此臂会恒等于 SRC ⇒ 假绿）
  const broken = SRC.replace(
    /(elseif \(\$CodeEvidence -or \$LocalCodeSearch\) \{ \$runModes = @\('code'\) \})(\r?\n)(else \{ \$runModes = @\('repo'\) \})/,
    '$1$2if ($Auto) { }$2$3');
  assert.notEqual(broken, SRC, 'the mutation must hit the real chain');
  assert.throws(() => checkLocalDispatch(broken), /elseif 链必须连续到 else/);
});

// ---------- ③ / ④ 真跑（pure：不联网） ----------
const PURE = `
$ErrorActionPreference = 'Stop'
$env:MCPS_NO_MAIN = '1'
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("u208_cache_" + $PID + ".json")
$seed = '{"k1":{"expires":"2099-01-01T00:00:00.0000000Z","data":[1]},"k2":{"expires":"2099-01-01T00:00:00.0000000Z","data":[2]}}'
[System.IO.File]::WriteAllText($tmp, $seed, (New-Object System.Text.UTF8Encoding($false)))
$env:MCPS_CACHE_FILE = $tmp   # 缓存文件是脚本级变量（不是参数），只能由环境变量改
. ./multi-platform-searcher.ps1 -NoEnvFile -Keyword x -Limit 1
$plain = Join-EngineNetworkReason -Reason 'A' -EngineName 'no-such-engine'
$script:_networkFailures['E1'] = 'network-route-unproven: h'
$joined = Join-EngineNetworkReason -Reason 'A' -EngineName 'E1'
$env:MCPS_ENGINE_DEADLINE = 'HF=30,DockerHub=0'   # U-243：Packages 已拆，采样锚点改用同为 research 的 DockerHub(29)
$d1 = Get-EngineDeadlineOverride -EngineName 'HF'
$d2 = Get-EngineDeadlineOverride -EngineName 'DockerHub'
$d3 = Get-EngineDeadlineOverride -EngineName 'SE'
$env:MCPS_ENGINE_DEADLINE = ''
$d4 = Get-EngineDeadlineOverride -EngineName 'HF'
# v1.47.9：单源硬上限默认已关 ⇒ 默认采样先清掉宿主可能存在的同名环境变量
$env:MCPS_ENGINE_HARD_CAP_SEC = ''
$dpDefault = Get-DoctorDeadlinePolicy
$env:MCPS_ENGINE_HARD_CAP_SEC = '10'
$dpCap = Get-DoctorDeadlinePolicy
$env:MCPS_ENGINE_HARD_CAP_SEC = ''
$env:MCPS_ENGINE_DEADLINE = 'HF=30'
$dpEnv = Get-DoctorDeadlinePolicy
$env:MCPS_ENGINE_DEADLINE = ''
$pickRow = { param($dp, $n) @($dp.Resolved | Where-Object { $_.Engine -eq $n })[0] }
$hfDef = & $pickRow $dpDefault 'HF'
$pkDef = & $pickRow $dpDefault 'DockerHub'
$hfEnv = & $pickRow $dpEnv 'HF'
$ghDef = & $pickRow $dpDefault 'GitHub'
$pkCap = & $pickRow $dpCap 'DockerHub'
$env:MCPS_TIME_BUDGET_SEC = ''
$bpDef = Get-DoctorBudgetPolicy
$env:MCPS_TIME_BUDGET_SEC = '30'
$bpEnv = Get-DoctorBudgetPolicy
$env:MCPS_TIME_BUDGET_SEC = ''
Set-LruResult -Key 'k3' -Data @(3)
Flush-LruCache
$obj = [System.IO.File]::ReadAllText($tmp) | ConvertFrom-Json
$keys = @($obj.PSObject.Properties.Name | Sort-Object)
Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
# ★只回 ASCII：pwsh -Command 的 stdout 在 GBK 控制台会被转码，中文断言会假红
[PSCustomObject]@{
    plain   = $plain
    joined  = ($joined -replace '[^\x20-\x7E]', '?')
    sepCode = [int][char]$joined.Substring(1, 1)
    keys    = $keys
    dl      = @($d1, $d2, $d3, $d4)
    dp      = [PSCustomObject]@{
        hfSec = $hfDef.Seconds; hfSrc = $hfDef.Source
        pkSec = $pkDef.Seconds; pkSrc = $pkDef.Source; pkTable = $pkDef.TableSeconds
        hfEnvSec = $hfEnv.Seconds; hfEnvSrc = $hfEnv.Source
        capped = $dpDefault.CappedCount
        ghTable = $ghDef.TableSeconds; ghSec = $ghDef.Seconds; ghSrc = $ghDef.Source
        repoDefault = $dpDefault.PathDefaults.Repo
        hardCap = $dpDefault.HardCapSec
        capSec = $pkCap.Seconds; capSrc = $pkCap.Source; capCount = $dpCap.CappedCount
        capAdviceCap = [bool]($dpCap.Advice -like '*MCPS_ENGINE_HARD_CAP_SEC=0*')
        capAdvicePer = [bool]($dpCap.Advice -like '*MCPS_ENGINE_DEADLINE*')
        budgetPer = $bpDef.PerPoolSec; budgetPools = $bpDef.PoolsInAuto
        budgetWorst = $bpDef.WorstCaseSec; budgetShared = $bpDef.SharedAcrossPools
        budgetEnvPer = $bpEnv.PerPoolSec; budgetEnvWorst = $bpEnv.WorstCaseSec
        adviceLen = $dpDefault.Advice.Length
        adviceCap = [bool]($dpDefault.Advice -like '*MCPS_ENGINE_HARD_CAP_SEC=0*')
        advicePer = [bool]($dpDefault.Advice -like '*MCPS_ENGINE_DEADLINE*')
    }
} | ConvertTo-Json -Compress
`;

test('U-208 C/D: 缓存回灌保住旧键 + deadline 归因是追加语义（真跑，不联网）', () => {
  const r = pwsh(PURE);
  assert.equal(r.code, 0, 'probe failed: ' + (r.err || r.out).slice(0, 400));
  const line = r.out.split(/\r?\n/).filter(Boolean).pop();
  const j = JSON.parse(line);
  // C：磁盘已有 k1/k2，本轮只写 k3 ⇒ Flush 后必须三条都在（旧实现只留 k3）
  assert.deepEqual(j.keys, ['k1', 'k2', 'k3'], '★ 缓存回灌失效：Flush 把上一轮的键删了（got ' + JSON.stringify(j.keys) + '）');
  // D：追加语义
  assert.equal(j.plain, 'A', '没有网络证据时不得凭空追加');
  // 分隔符必须是全角'；'（U+FF1B）—— 用码点判，避免控制台转码把断言变成假红
  assert.equal(j.sepCode, 0xFF1B, '★ 追加时必须用全角分号分隔（got code ' + j.sepCode + '）');
  assert.match(j.joined, /^A\?network-route-unproven: h$/, '★ deadline/预算必须**追加**网络证据，不能顶掉原文');
  // E：逐源截止覆盖（v1.47.4）—— 设了取值 / 0 表示关闭 / 未列出的源保持 null / 清空后回到 null
  assert.deepEqual(j.dl, [30, 0, null, null],
    '★ MCPS_ENGINE_DEADLINE 取值错误（got ' + JSON.stringify(j.dl) + '；期望 [30,0,null,null]）');
  // F：Doctor 的逐源生效截止必须与真实执行同源
  assert.equal(j.dp.hfSec, 8, '默认 HF 应等 8s（表值）');
  assert.equal(j.dp.hfSrc, 'table', '默认 HF 的来源应为 table');
  assert.equal(j.dp.pkTable, 29, 'DockerHub 表值应为 29（U-243 后 Packages 已拆，采样锚点换成它）');
  // v1.47.9：默认 cap 关闭 —— 表值必须**真的**生效（此前 28/29 被 cap=10 夹成 10，表形同虚设）
  assert.equal(j.dp.hardCap, 0, '★ 默认 EngineHardCapSec 必须是 0（否则 17/21 引擎的表值再次失效）');
  assert.equal(j.dp.pkSec, 29, '★ 默认下 DockerHub 必须真的等 29s（got ' + j.dp.pkSec + '）');
  assert.equal(j.dp.pkSrc, 'table', '默认下 DockerHub 来源应为 table（不是 cap）');
  assert.equal(j.dp.capped, 0, '默认下不应有任何源被硬上限夹住');
  assert.equal(j.dp.adviceLen, 0, '没有源被夹住时不得凭空给 Advice');
  assert.equal(j.dp.hfEnvSec, 30, '★ 设了 MCPS_ENGINE_DEADLINE=HF=30 后 Doctor 必须显示 30（数字不同源就会显示 8）');
  assert.equal(j.dp.hfEnvSrc, 'env', '显式覆盖的来源应为 env');
  // G：repo 路径的默认截止是 EngineDeadlineRepoSec=29，不是 research 的 17
  assert.equal(j.dp.repoDefault, 29, 'PathDefaults.Repo 必须是 Cfg.EngineDeadlineRepoSec');
  assert.equal(j.dp.ghTable, 29, '★ repo 引擎 GitHub 的 TableSeconds 必须是 29（上一版一律取 17，被 cap 夹后看不出来）');
  assert.equal(j.dp.ghSec, 29, '默认 cap 关闭时 GitHub 必须真的等 29s');
  assert.equal(j.dp.ghSrc, 'default', 'GitHub 不在逐源表里 ⇒ 来源应为路径默认（default），不是 cap');
  // ★Advice 分支不能因为默认关 cap 就失去覆盖：显式设 10 时必须夹住 + 给出两个旋钮
  assert.equal(j.dp.capSec, 10, '★ MCPS_ENGINE_HARD_CAP_SEC=10 必须夹住 DockerHub 的 29s');
  assert.equal(j.dp.capSrc, 'cap', '显式 cap 下来源应为 cap');
  assert.ok(j.dp.capCount >= 1, '显式 cap=10 时 CappedCount 必须 ≥1（否则 Advice 分支无覆盖）');
  assert.equal(j.dp.capAdviceCap, true, 'Advice 必须提到 MCPS_ENGINE_HARD_CAP_SEC=0');
  assert.equal(j.dp.capAdvicePer, true, 'Advice 必须提到 MCPS_ENGINE_DEADLINE');
  // H：预算口径（每池各算）必须报出来，且随环境变量变
  assert.equal(j.dp.budgetPer, 120, '默认每池预算应为 120s');
  assert.equal(j.dp.budgetPools, 3, '-Auto 是三池');
  assert.equal(j.dp.budgetWorst, 360, '★ 最坏值必须等于 3×每池（否则现场会按 120s 预期）');
  assert.equal(j.dp.budgetShared, false, '当前是每池独立计预算（shared 必须为 false，改了语义才允许 true）');
  assert.equal(j.dp.budgetEnvPer, 30, 'MCPS_TIME_BUDGET_SEC=30 必须生效');
  assert.equal(j.dp.budgetEnvWorst, 90, '最坏值必须跟着环境变量走');
  // I：Advice 的覆盖已上移（默认不夹 ⇒ 空；显式 cap=10 ⇒ 两个旋钮都在）
});

// ---------- ③ 逐源截止显式覆盖（v1.47.4，审计 P2-7） ----------
function fnBodyOf(src, name) {
  const marker = 'function ' + name + ' {';
  const i = src.indexOf(marker);
  assert.ok(i >= 0, 'function missing: ' + name);
  const rest = src.slice(i + marker.length);
  const m = /^function [A-Za-z][\w-]* \{/m.exec(rest);
  return rest.slice(0, m ? m.index : rest.length);
}
function checkDeadlineOverride(src) {
  assert.ok(src.includes('function Get-EngineDeadlineOverride {'),
    '★ 必须有独立解析函数（不要在调用点内联：顺序与缓存都要可测）');
  // ★只看解析函数体内：v1.47.5 起 Doctor 也会读同一个变量，按全文断言会让"解析函数不读了"漏网
  const ovBody = fnBodyOf(src, 'Get-EngineDeadlineOverride');
  assert.match(ovBody, /\$env:MCPS_ENGINE_DEADLINE\b/, '★ 必须真的读环境变量（否则文档承诺的旋钮是空的）');
  // 池必须把引擎名传进来，否则覆盖永远匹配不到（静默失效比没有更坏）
  assert.match(src, /\$dlSec = Get-EngineDeadlineSec -DeadlineSec \$dlSec -EngineName \$h\.Engine\.Name/,
    '★ 池必须把引擎名传给 Get-EngineDeadlineSec（否则覆盖永远不生效）');
  const body = fnBodyOf(src, 'Get-EngineDeadlineSec');
  const iCap = body.indexOf('if ($hc -gt 0');
  const iOv = body.indexOf('Get-EngineDeadlineOverride');
  assert.ok(iCap > 0, '单源硬上限（min）不见了');
  assert.ok(iOv > 0, '★ 覆盖必须在 Get-EngineDeadlineSec 里接线');
  assert.ok(iOv > iCap, '★ 覆盖必须在硬上限之后生效（顺序即语义：用户拍板 > Auto 倍数 > 硬上限）');
}
test('U-210: MCPS_ENGINE_DEADLINE 逐源覆盖，且顺序上压过硬上限', () => {
  checkDeadlineOverride(SRC);
});
test('U-210 negative control: 不接读环境变量 / 池不传引擎名 / 覆盖挪到硬上限之前 都必须被点名', () => {
  // 两处读（解析函数 + Doctor）都要改掉，否则按全文断言的旧写法会假绿
  const noRead = SRC.replaceAll(/\$env:MCPS_ENGINE_DEADLINE\b/g, '$env:MCPS_ENGINE_DEADLINE_DISABLED');
  assert.notEqual(noRead, SRC);
  assert.throws(() => checkDeadlineOverride(noRead), /必须真的读环境变量/);

  const noName = SRC.replace('-DeadlineSec $dlSec -EngineName $h.Engine.Name', '-DeadlineSec $dlSec');
  assert.notEqual(noName, SRC);
  assert.throws(() => checkDeadlineOverride(noName), /池必须把引擎名传给 Get-EngineDeadlineSec/);

  // 把「注释 + if ($EngineName) { … }」整块挪到函数开头（硬上限之前）
  const blockRe = /[ \t]*# v1\.47\.4：显式逐源覆盖[\s\S]*?\n[ \t]*\}\r?\n/;
  const m = blockRe.exec(SRC);
  assert.ok(m, 'override block missing');
  const without = SRC.replace(m[0], '');
  const anchor = '$d = $DeadlineSec';
  const idx = without.indexOf(anchor);
  assert.ok(idx > 0);
  const movedSrc = without.slice(0, idx + anchor.length) + '\n' + m[0] + without.slice(idx + anchor.length);
  assert.notEqual(movedSrc, SRC);
  assert.throws(() => checkDeadlineOverride(movedSrc), /覆盖必须在硬上限之后生效/);
});
// ---------- ④ Doctor：逐源生效截止（v1.47.5，P2-7 的可观测面） ----------
function checkDeadlinePolicy(src) {
  assert.match(src, /\$doctorReport\['deadlinePolicy'\] = Get-DoctorDeadlinePolicy/,
    '★ Doctor 必须输出逐源生效截止（否则现场只能读代码猜"为什么只等 N 秒"）');
  const body = fnBodyOf(src, 'Get-DoctorDeadlinePolicy');
  assert.match(body, /Get-EngineDeadlineSec -DeadlineSec \$base -EngineName \$n/,
    '★ 数字必须与真实执行同源（复制一份公式 = 两处会漂）');
  assert.match(body, /Get-EngineDeadlineOverride -EngineName \$n/,
    '来源标注必须读显式覆盖（否则 env 覆盖显示成 table）');
  // v1.47.6：默认值必须按 Kind 分路径取（repo=29 / code=17 / research=17）
  assert.match(body, /PathDefaults/, '必须输出 PathDefaults（否则说不清某个源的默认值来自哪条路径）');
  // ★必须钉住"repo 这一行"：PathDefaults 里也出现 EngineDeadlineRepoSec，只查名字会假绿（本臂第一版就这么假绿的）
  assert.match(body, /repo\s*=\s*\[int\]\$script:Cfg\.EngineDeadlineRepoSec/, '★ repo 引擎必须用 EngineDeadlineRepoSec 作默认（一律用 research 的 17 会标错）');
  assert.match(body, /Advice\s+= \$advice/, '必须输出 Advice 字段（且值来自计算，不是空串）');
  assert.match(body, /MCPS_ENGINE_HARD_CAP_SEC=0/, 'Advice 必须指向真实的旋钮（写错名字等于没给）');
  // v1.47.6：预算口径
  assert.match(src, /\$doctorReport\['budgetPolicy'\] = Get-DoctorBudgetPolicy/, '★ Doctor 必须输出预算口径');
  const bBody = fnBodyOf(src, 'Get-DoctorBudgetPolicy');
  assert.match(bBody, /Get-TimeBudgetSec/, '★ 每池预算必须读 Get-TimeBudgetSec（不要自己读环境变量）');
  assert.match(bBody, /WorstCaseSec/, '必须给出最坏值');
}
test('U-211: Doctor 输出逐源生效截止，且数字与执行同源', () => {
  checkDeadlinePolicy(SRC);
});
test('U-211 negative control: 不接 Doctor / 自己算一份公式 都必须被点名', () => {
  const noWire = SRC.replace("$doctorReport['deadlinePolicy'] = Get-DoctorDeadlinePolicy", '');
  assert.notEqual(noWire, SRC);
  assert.throws(() => checkDeadlinePolicy(noWire), /Doctor 必须输出逐源生效截止/);

  const flatDefault = SRC.replace(/repo     = \[int\]\$script:Cfg\.EngineDeadlineRepoSec/, 'repo     = [int]$script:Cfg.EngineDeadlineSec');
  assert.notEqual(flatDefault, SRC);
  assert.throws(() => checkDeadlinePolicy(flatDefault), /repo 引擎必须用 EngineDeadlineRepoSec/);

  const noAdvice = SRC.replace('        Advice              = $advice', '        Advice              = \'\'');
  assert.notEqual(noAdvice, SRC);
  assert.throws(() => checkDeadlinePolicy(noAdvice), /必须输出 Advice|Advice 必须指向/);

  const ownMath = SRC.replace('$final = Get-EngineDeadlineSec -DeadlineSec $base -EngineName $n', '$final = $base');
  assert.notEqual(ownMath, SRC);
  assert.throws(() => checkDeadlinePolicy(ownMath), /数字必须与真实执行同源/);
});

// ---------- ② live：单用开关必须落在 LocalCode ----------
test('U-212 live: -LocalPath 不存在时，降级告警必须点名"路径"而不是"0 命中"（真跑，远程引擎全禁）', () => {
  const out = path.join(root, 'tests', '_u212_badpath.json');
  const env = { ...process.env, MCPS_DISABLE: 'GitHubCode,GitLabBlobs,GrepApp,SEExcerpts,Sourcegraph' };
  const r = spawnSync('pwsh', [
    '-NoProfile', '-NonInteractive', '-File', mainPath,
    '-NoEnvFile', '-LocalCodeSearch', '-LocalPath', 'Z:/no/such/dir', '-Keyword', 'foo',
    '-Limit', '1', '-NoCache', '-AsJson',
  ], { cwd: root, encoding: 'utf8', timeout: 120000, windowsHide: true, env });
  try {
    const raw = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : (r.stdout || '');
    assert.ok(raw.length > 0, 'no output: ' + (r.stderr || '').slice(0, 300));
    const doc = JSON.parse(raw.replace(/^\uFEFF/, ''));
    const warns = (doc.warnings || []).join('\n');
    assert.match(warns, /本地检索未接管/, '降级必须留痕');
    assert.match(warns, /LocalPath/, '★ 告警必须点出"-LocalPath"这个真实原因（got: ' + warns.slice(0, 160) + '）');
    assert.doesNotMatch(warns, /0 命中（或二进制缺失）/, '★ 旧文案必须消失（它把路径错误说成 0 命中）');
  } finally {
    try { fs.rmSync(out, { force: true }); } catch { }
  }
});

test('U-213: -ResearchBatch 输入错误给 JSON 信封（真跑，非法 JSON）', () => {
  const bad = path.join(root, 'tests', '_u213_bad.json');
  const out = path.join(root, 'tests', '_u213_out.json');
  fs.writeFileSync(bad, 'not-json', 'utf8');
  const r = spawnSync('pwsh', [
    '-NoProfile', '-NonInteractive', '-File', mainPath,
    '-ResearchBatch', bad, '-AsJson',
  ], { cwd: root, encoding: 'utf8', timeout: 120000, windowsHide: true });
  try {
    assert.notEqual(r.status, 0, '非法输入必须非零退出');
    const raw = (r.stdout || '').trim();
    assert.ok(raw.startsWith('{'), '★ stdout 必须是 JSON 信封，而不是 PowerShell 原生报错（got: ' + raw.slice(0, 120) + '）');
    // ConvertTo-Json 是多行美化输出 ⇒ 取首个 { 到末个 } 整段解析（按最后一行解析会得到 "}"）
    const j = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    assert.equal(j.error, 'invalid-batch-input', '错误码必须稳定');
    assert.ok((j.warnings || []).join('').includes('未执行任何检索'), '必须说清"未执行任何检索"');
    assert.match(j.message, /valid UTF-8 JSON/, '必须保留原始判据');
  } finally {
    for (const f of [bad, out]) { try { fs.rmSync(f, { force: true }); } catch { } }
  }
});

test('U-208 B live: -LocalCodeSearch 单用的 Requested 只含 LocalCode（真跑本地检索）', () => {
  const out = path.join(root, 'tests', '_u208_local.json');
  const r = spawnSync('pwsh', [
    '-NoProfile', '-NonInteractive', '-File', mainPath,
    '-NoEnvFile', '-LocalCodeSearch', '-LocalPath', root, '-Keyword', 'Join-EngineNetworkReason',
    '-Limit', '2', '-NoCache', '-AsJson',
  ], { cwd: root, encoding: 'utf8', timeout: 180000, windowsHide: true });
  try {
    assert.ok(fs.existsSync(out) || (r.stdout || '').length > 0, 'no output: ' + (r.stderr || '').slice(0, 300));
    const raw = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : (r.stdout || '');
    const doc = JSON.parse(raw.replace(/^\uFEFF/, ''));
    assert.deepEqual(doc.coverage.Requested, ['LocalCode'],
      '★ 单用 -LocalCodeSearch 仍走了别的模式：Requested=' + JSON.stringify(doc.coverage.Requested));
    assert.ok(doc.results.length > 0, '本地检索应当有命中（关键字取自本文件）');
  } finally {
    try { fs.rmSync(out, { force: true }); } catch { }
  }
});

// ---------- ⑤ 单源硬上限默认值（v1.47.9） ----------
// 为什么单独立门：默认值 10 曾让 21 个引擎里的 17 个被夹住，`EngineDeadlineByEngine` 的 22–29
// 与 `EngineDeadlineRepoSec=29` 在单模式下**从未生效**。改回 10 不会有任何运行时告警（静默退化），
// 只能靠静态门盯住。
function checkDefaultCap(src) {
  const m = /^    EngineHardCapSec = (\d+)$/m.exec(src);
  assert.ok(m, '★ Cfg 里必须保留 EngineHardCapSec 字面定义（0 = 关闭，不是删掉这段逻辑）');
  assert.equal(m[1], '0', '★ 默认必须是 0：cap=10 会把 21 个引擎里的 17 个夹住 ⇒ 逐源表 22–29 形同虚设');
  // 0 必须是"关闭"而不是"立刻超时"：夹的逻辑必须带 > 0 的守卫
  assert.ok(src.includes('if ($hc -gt 0 -and ($d -le 0 -or $d -gt $hc)) { $d = $hc }'),
    '★ 0 必须走"关闭"分支（缺 $hc -gt 0 守卫会让所有源 0s 超时）');
  const mm = /^    EngineHardCapMultiModeSec = (\d+)$/m.exec(src);
  assert.ok(mm, 'EngineHardCapMultiModeSec 必须还在');
  assert.notEqual(mm[1], '0', '★ -Auto 仍要走 25s 上限（本批只改单模式默认，不动多模式）');
}
test('U-214: 单源硬上限默认关闭，且 0 的语义是"关闭"而非"0 秒超时"', () => {
  checkDefaultCap(SRC);
});
test('U-214 negative control: 改回 10 / 去掉 >0 守卫 / 顺手关掉 -Auto 上限 都必须被点名', () => {
  const back = SRC.replace(/^    EngineHardCapSec = 0$/m, '    EngineHardCapSec = 10');
  assert.notEqual(back, SRC);
  assert.throws(() => checkDefaultCap(back), /默认必须是 0/);
  const noGuard = SRC.replace('if ($hc -gt 0 -and ($d -le 0 -or $d -gt $hc))', 'if ($d -le 0 -or $d -gt $hc)');
  assert.notEqual(noGuard, SRC);
  assert.throws(() => checkDefaultCap(noGuard), /必须走"关闭"分支/);
  const autoOff = SRC.replace(/^    EngineHardCapMultiModeSec = 25$/m, '    EngineHardCapMultiModeSec = 0');
  assert.notEqual(autoOff, SRC);
  assert.throws(() => checkDefaultCap(autoOff), /只改单模式默认/);
});

// ---------- ⑥ RepoScope 计划：无宿主时不得跨宿主误查（v1.48.1） ----------
// 事实：`-RepoScope "owner/repo"` 是文档支持的形式，但它拿不到 host（`$h=''`）。
//   旧守卫 `$h -and $h -notmatch 'gitlab'` 在 `$h=''` 时整条失效 ⇒ 一个 GitHub 仓库的检索
//   把 GitLabBlobs 拉进 Requested 并记 Blocked（实测 requested 里确实出现它）。
const SCOPE = `
$ErrorActionPreference = 'Stop'
$env:MCPS_NO_MAIN = '1'
. ./multi-platform-searcher.ps1 -NoEnvFile -Keyword x -Limit 1
$cases = @(
  @{ n = 'urlGithub'; r = 'https://github.com/redis/redis' },
  @{ n = 'scpGitlab'; r = 'git@gitlab.com:group/sub/proj.git' },
  @{ n = 'bare';      r = 'redis/redis' },
  @{ n = 'gitee';     r = 'https://gitee.com/mirrors/redis' },
  @{ n = 'bad';       r = 'not-a-repo' }
)
$out = foreach ($c in $cases) {
  $p = Get-CodeScopePlan -RepoScope $c.r -RepoScopeMode 'only'
  # ★只回 ASCII：pwsh -Command 的 stdout 在 GBK 控制台会把中文转成 '?'，断言会假红。
  #   用 IndexOf 截断而不是正则 —— JS 模板串会把 '\(...' 里的反斜杠吃掉，正则就坏了。
  $names = foreach ($x in @($p.Excluded)) { $i = ([string]$x).IndexOf('('); if ($i -gt 0) { ([string]$x).Substring(0, $i) } else { [string]$x } }
  [PSCustomObject]@{ n = $c.n; mode = [string]$p.Mode; engines = @($p.Engines | ForEach-Object { $_.Name }); excludedNames = @($names) }
}
$out | ConvertTo-Json -Depth 5 -Compress
`;
function checkScopeGuard(src) {
  assert.match(src, /if \(\$e\.Name -eq 'GitLabBlobs' -and \(\(-not \$h\) -or \(\$h -notmatch 'gitlab'\)\)\)/,
    '★ GitLabBlobs 的排除条件必须覆盖"无宿主"（否则 owner/repo 形式会跨宿主误查）');
}
test('U-215: RepoScope 计划 —— 无宿主不跨宿主、GitLab 宿主只走项目级、Gitee 无可执行源', () => {
  const r = pwsh(SCOPE);
  assert.equal(r.code, 0, 'probe failed: ' + (r.err || r.out).slice(0, 400));
  const line = r.out.split(/\r?\n/).filter(Boolean).pop();
  const rows = JSON.parse(line);
  const by = Object.fromEntries(rows.map((x) => [x.n, x]));
  // bare：文档支持的形式，但宿主未知 ⇒ GitLabBlobs 不得参与（GitHubCode/GrepApp 假定 GitHub，保留）
  assert.deepEqual([...by.bare.engines].sort(), ['GitHubCode', 'GrepApp', 'Sourcegraph'],
    '★ 无宿主的 owner/repo 只能保留 GitHub 系与 Sourcegraph（got ' + JSON.stringify(by.bare.engines) + '）');
  assert.deepEqual([...by.bare.excludedNames].sort(), ['GitLabBlobs', 'SEExcerpts'],
    '★ 无宿主时必须排除 GitLabBlobs（未指定宿主，无法判定是 GitLab 项目）—— got ' + JSON.stringify(by.bare.excludedNames));
  // GitHub 宿主：不得有 GitLabBlobs
  assert.ok(!by.urlGithub.engines.includes('GitLabBlobs'), 'GitHub 仓库不得把 GitLabBlobs 拉进来');
  // GitLab 宿主：只留能按 GitLab 项目检索的源
  assert.deepEqual([...by.scpGitlab.engines].sort(), ['GitLabBlobs', 'Sourcegraph']);
  // Gitee：没有可用的仓库作用域引擎 ⇒ 必须空（调用方据此告警）
  assert.equal(by.gitee.engines.length, 0, '★ Gitee 仓库在 only 模式下必须没有可执行源');
  assert.equal(by.gitee.excludedNames.length, 5, 'Gitee 应排除全部 5 个 code 引擎并逐条给原因');
  // 解析失败：退回 add，交给调用方告警，不得静默过滤
  assert.equal(by.bad.mode, 'add', '解析失败必须退回 add');
});
test('U-215 negative control: 守卫退回 $h -and 必须被点名', () => {
  checkScopeGuard(SRC);
  const old = SRC.replace("if ($e.Name -eq 'GitLabBlobs' -and ((-not $h) -or ($h -notmatch 'gitlab')))",
    "if ($e.Name -eq 'GitLabBlobs' -and $h -and ($h -notmatch 'gitlab'))");
  assert.notEqual(old, SRC, 'mutation must hit the real guard');
  assert.throws(() => checkScopeGuard(old), /必须覆盖"无宿主"/);
});

// ---------- ⑦ Serve/MCP 的 repo op 必须认 MCPS_DISABLE（v1.48.2） ----------
// 事实：CLI 主流程在派生 platformsToSearch 时统一过滤禁用源，而 `Invoke-ConcurrentPlatformSearch`
//   的注释明说"按传入名单取引擎、不自己过滤"；Serve 的 repo op 却直接把注册表全量名单传进去
//   ⇒ `MCPS_DISABLE` 在 MCP 侧完全失效：实测 `search_repositories` 仍返回 5 条、reasons 里是 GitHub 的 error。
//   `MCPS_DISABLE` 是合规/配额开关，不能只在一个入口生效。
function checkServeDisable(src) {
  assert.match(src, /\$enabled = @\(\$repoEngines \| Where-Object \{ -not \(Test-EngineDisabled -Engine \$_\) \}/,
    '★ Serve 的 repo 名单必须按 MCPS_DISABLE 过滤（否则 MCP 侧禁用失效）');
  assert.ok(src.includes('reasons = (Get-ServeReasons -Disabled $disabledNames)'),
    '★ reasons 必须补上被禁源（它们没有 _engineStatus，不补就是静默空洞）');
}
function serveRepo(disable, req) {
  const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', mainPath, '-NoEnvFile', '-Serve'], {
    cwd: root, encoding: 'utf8', timeout: 180000, windowsHide: true,
    input: JSON.stringify(req) + '\n__EXIT__\n',
    env: { ...process.env, MCPS_DISABLE: disable, MCPS_SERVE_CACHE: '0' },
  });
  if (r.error) throw r.error;
  const lines = (r.stdout || '').trim().split(/\r?\n/).filter(Boolean);
  assert.ok(lines.length > 0, 'serve produced no output: ' + (r.stderr || '').slice(0, 300));
  return JSON.parse(lines[lines.length - 1]);
}
test('U-216: Serve 的 repo op 认 MCPS_DISABLE，并在 reasons 里说清为什么没跑', () => {
  checkServeDisable(SRC);
  const all = serveRepo('GitHub,Gitee,GitLab,Codeberg', { op: 'repo', keyword: 'vector database', limit: 1 });
  assert.equal(all.count, 0, '★ 四个 repo 源全禁时不得有任何结果（got ' + all.count + '）');
  assert.deepEqual(all.platforms, [], '★ 全禁时实际执行名单必须为空');
  assert.deepEqual([...(all.disabledPlatforms || [])].sort(), ['Codeberg', 'GitHub', 'GitLab', 'Gitee'],
    '★ 必须回显被禁的平台');
  assert.deepEqual(Object.keys(all.reasons || {}).sort(), ['Codeberg', 'GitHub', 'GitLab', 'Gitee'],
    '★ 被禁的源必须在 reasons 里说明（got ' + JSON.stringify(Object.keys(all.reasons || {})) + '）');
  assert.match(String(all.reasons.GitHub), /^user-disabled:/, '禁用原因必须是机器可判读的前缀');
});
test('U-216 negative control: 名单不过滤 / reasons 不补禁用项 都必须被点名', () => {
  const noFilter = SRC.replace('$enabled = @($repoEngines | Where-Object { -not (Test-EngineDisabled -Engine $_) } | ForEach-Object { [string]$_.Name })',
    '$enabled = @($repoEngines | ForEach-Object { [string]$_.Name })');
  assert.notEqual(noFilter, SRC, 'mutation must hit the filter');
  assert.throws(() => checkServeDisable(noFilter), /必须按 MCPS_DISABLE 过滤/);
  const noReason = SRC.replace('reasons = (Get-ServeReasons -Disabled $disabledNames)', 'reasons = (Get-ServeReasons)');
  assert.notEqual(noReason, SRC);
  assert.throws(() => checkServeDisable(noReason), /reasons 必须补上被禁源/);
});

// ---------- ⑧ Serve 每个 op 都要带 coverage（v1.49.0） ----------
// 事实：MCP 侧此前只有 count/reasons，没有 coverage/Verdict —— Agent 要判断"这轮到底查成了没有"
//   得逐条读 reasons。CLI 有 Verdict=no-engines 一眼可见。本批把 Verdict 抽成 Get-CoverageVerdict
//   （CLI 与 Serve 共用同一套顺序），5 个 op 都回 coverage。
function checkServeCoverage(src) {
  const hits = src.match(/coverage = \(Get-ServeCoverage -Requested/g) || [];
  assert.ok(hits.length >= 5, '★ repo/code/research/auto/package 五个 op 都必须带 coverage，实际 ' + hits.length);
}
test('U-217: Serve 各 op 带 coverage —— 全禁 no-engines、部分禁只剩启用源', () => {
  checkServeCoverage(SRC);
  const all = serveRepo('GitHub,Gitee,GitLab,Codeberg', { op: 'repo', keyword: 'vector database', limit: 1 });
  assert.equal(all.coverage.Verdict, 'no-engines', '★ 全禁时 Verdict 必须是 no-engines（got ' + all.coverage.Verdict + '）');
  assert.deepEqual(all.coverage.Requested, [], '被禁源不进 Requested（与 CLI 同口径）');
  assert.equal(all.coverage.Executed, 0);
  const half = serveRepo('GitHub,Gitee', { op: 'repo', keyword: 'vector database', limit: 1 });
  assert.deepEqual([...half.coverage.Requested].sort(), ['Codeberg', 'GitLab'],
    '★ Requested 只含真正参与的源（got ' + JSON.stringify(half.coverage.Requested) + '）');
  assert.ok(['full', 'degraded', 'partial', 'none'].includes(half.coverage.Verdict),
    '部分禁时 Verdict 必须是四态之一（got ' + half.coverage.Verdict + '）');
});
test('U-217 negative control: 少一个 op 带 coverage 必须被点名', () => {
  const dropped = SRC.replace('coverage = (Get-ServeCoverage -Requested $plat); ', '');
  assert.notEqual(dropped, SRC, 'mutation must hit the repo op');
  assert.throws(() => checkServeCoverage(dropped), /五个 op/);
});

// ---------- ⑨ 网络占位必须随「探活成功」撤回（v1.49.1） ----------
// 事实（v1.49.0 全量门实测）：`Get-ApiRequestRouteContext` 在探活**之前**先写占位
//   `network-route-unproven: <host>（探活未完成即被打断）`，探活确认可达后却**不撤回** ⇒
//   一个「路由正常、请求挂死」的 deadline 也会挂着「探活未完成」的句子，下游（含验收门）无从区分。
// 判据分两层：纯函数真值表（dot-source 直测）+ 接线静态断言（撤回必须发生在 reachable 分支）。
function pwshFile(script, timeout = 120000) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u218-'));
  const f = path.join(dir, 'probe.ps1');
  fs.writeFileSync(f, '\uFEFF' + script, 'utf8');   // BOM：-File 下让 pwsh 按 UTF-8 读中文断言
  const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', f], { cwd: root, encoding: 'utf8', timeout, windowsHide: true });
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 系统清 */ }
  if (r.error) throw r.error;
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
const PLACEHOLDER_PROBE = `
$ErrorActionPreference = 'Stop'
$env:MCPS_NO_MAIN = '1'
. ./multi-platform-searcher.ps1 -NoEnvFile -Keyword x -Limit 1
$cases = @(
  @{ n = 'placeholder'; r = 'network-route-unproven: gitlab.com（探活未完成即被打断）' },
  @{ n = 'unconfirmed'; r = 'network-route-unproven: gitlab.com（未确认的路由：direct）' },
  @{ n = 'deadlineOnly'; r = '单引擎超 17s 截止，已停止' },
  @{ n = 'empty'; r = '' }
)
$out = foreach ($c in $cases) {
  [PSCustomObject]@{ n = $c.n; hit = [bool](Test-NetworkPlaceholderReason -Reason $c.r) }
}
$out | ConvertTo-Json -Depth 4 -Compress
`;
function checkPlaceholderRetraction(src) {
  assert.match(src, /Test-NetworkPlaceholderReason\s+-Reason\s+\(\[string\]\$curNet\)/,
    '★ reachable 分支必须用 Test-NetworkPlaceholderReason 判定占位（不能整键乱删）');
  assert.match(src, /\[void\]\$script:_networkFailures\.TryRemove\(\$networkEngine, \[ref\]\$gone\)/,
    '★ 探活确认可达后必须撤回占位（否则「探活未完成」会贴在正常路由上）');
  assert.match(src, /return \(\$Reason -like 'network-route-unproven:\*探活未完成即被打断\*'\)/,
    '★ 占位判定只认占位文案本身（放宽成「任意 route-unproven」会把真·未确认路由也删掉）');
}
test('U-218: 占位只在探活真的没结论时保留 —— 真值表 + 撤回接线', () => {
  checkPlaceholderRetraction(SRC);
  const r = pwshFile(PLACEHOLDER_PROBE);
  assert.equal(r.code, 0, 'probe failed: ' + (r.err || r.out).slice(0, 400));
  const rows = JSON.parse(r.out.split(/\r?\n/).filter(Boolean).pop());
  const by = Object.fromEntries(rows.map((x) => [x.n, x.hit]));
  assert.equal(by.placeholder, true, '★ 占位（探活被打断）必须判真');
  assert.equal(by.unconfirmed, false, '★ 「未确认的路由」不是占位 —— 删了它就丢了真实归因');
  assert.equal(by.deadlineOnly, false, '裸 deadline 不得判占位');
  assert.equal(by.empty, false, '空原因不得判占位');
});
test('U-218 negative control: 删掉撤回 / 放宽判定 都必须被点名', () => {
  const noRemove = SRC.replace('            [void]$script:_networkFailures.TryRemove($networkEngine, [ref]$gone)\n', '');
  assert.notEqual(noRemove, SRC, 'mutation must hit the retraction line');
  assert.throws(() => checkPlaceholderRetraction(noRemove), /必须撤回占位/);
  const loose = SRC.replace("return ($Reason -like 'network-route-unproven:*探活未完成即被打断*')",
    "return ($Reason -like 'network-route-unproven:*')");
  assert.notEqual(loose, SRC, 'mutation must hit the predicate');
  assert.throws(() => checkPlaceholderRetraction(loose), /只认占位文案/);
});
