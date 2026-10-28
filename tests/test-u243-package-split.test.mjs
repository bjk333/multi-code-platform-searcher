// U-243（v1.53.25，验收 B1-7）：包注册表拆成 npm / crates.io / Maven **三个单一上游引擎**。
//
// 为什么要有这条门（事实依据，全部实测于 2026-10-25 同一台机器）：
//   · 旧 `Search-PackageRegistries` 在**一个引擎内串行**请求 npm → crates.io → Maven，
//     实测 npm search 十轮里 2 次挂满 15.01s（TCP 层，非源侧错误码），而它排在最前
//     ⇒ 后面两个 0.5–2s 就返回的子源被迫一起等，整引擎 20.6–21.3s，独占 research 墙钟 94%。
//   · 拆分后池并行调度：Crates/Maven 稳定 1.1–1.9s，Npm 池内 6.7–9.9s，墙钟由 21.9 降到 11.6–16.8s。
//   · 顺带治掉"装饰挤掉主结果"：下载量补全（纯增强）原来用 20s×3 次，现在 3s×1 且 search 超时过半就跳过。
//
// 门分四层：
//   ① 结构：注册表三项、Kind=research、Platforms 各只有一个上游、旧 Packages 名彻底消失；
//   ② 取值：三引擎各有表值且不低于 floor（不许再并回去用一个"总预算"糊住）；
//   ③ 接线：npm 的下载量补全必须用 NpmDownloadTimeoutSec + 单次，且有"search 用太久就跳过"的守卫；
//   ④ 负例：把三引擎并回一个、把短超时改回 ApiTimeoutSec、把告警引擎名写错 —— 都必须被点名。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceAll } from './lib/source.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = sourceAll(path.join(ROOT));
const ENGINES = ['npm-registry.ps1', 'crates-io.ps1', 'maven-central.ps1'];

function regRows(src) {
  const i = src.indexOf('$script:_engineRegistry = @(');
  assert.ok(i > 0, '锚点缺失：_engineRegistry');
  const j = src.indexOf('\n)', i);
  return src.slice(i, j);
}

function engineSource(name) {
  return fs.readFileSync(path.join(ROOT, 'engines', name), 'utf8');
}

/** 把注册表文本解析成 [{name, kind, platforms, func, needs}] —— 只认单行形态（本项目注册表就是一行一项） */
function parseRows(src) {
  const block = regRows(src);
  const out = [];
  for (const line of block.split('\n')) {
    const m = line.match(/Name\s*=\s*'([^']+)'\s*;\s*Kind\s*=\s*'([^']+)'(.*)$/);
    if (!m) continue;
    const rest = m[3];
    const pl = rest.match(/Platforms\s*=\s*@\(([^)]*)\)/);
    const fn = rest.match(/Func\s*=\s*'([^']+)'/);
    out.push({
      name: m[1],
      kind: m[2],
      platforms: pl ? [...pl[1].matchAll(/'([^']*)'/g)].map((x) => x[1]) : [],
      func: fn ? fn[1] : '',
    });
  }
  return out;
}

function deadlineTable(src) {
  const t = src.match(/EngineDeadlineByEngine = @\{([^}]*)\}/);
  assert.ok(t, 'EngineDeadlineByEngine 表缺失');
  return Object.fromEntries([...t[1].matchAll(/([A-Za-z0-9]+)\s*=\s*(\d+)/g)].map((m) => [m[1], +m[2]]));
}

const FLOORS = { Npm: 13, Crates: 10, Maven: 8 };

function checkStructure(src) {
  const rows = parseRows(src);
  const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
  for (const [name, func] of [['Npm', 'Search-NpmRegistry'], ['Crates', 'Search-CratesIo'], ['Maven', 'Search-MavenCentral']]) {
    const r = byName[name];
    assert.ok(r, `★ 注册表缺少引擎 ${name}（拆开后必须各自成项，不许并回一个多上游引擎）`);
    assert.equal(r.kind, 'research', `${name} 的 Kind 必须是 research`);
    assert.equal(r.func, func, `${name} 的 Func 必须是 ${func}`);
    assert.equal(r.platforms.length, 1, `★ ${name} 的 Platforms 必须只有一个上游（一个引擎 = 一个上游），got ${JSON.stringify(r.platforms)}`);
  }
  assert.equal(byName.Packages, undefined, '★ 旧 `Packages` 引擎必须已从注册表移除（否则同一个上游会被请求两次）');
  assert.equal(byName.Npm.platforms[0], 'npm');
  assert.equal(byName.Crates.platforms[0], 'crates.io');
  assert.equal(byName.Maven.platforms[0], 'Maven');

  // 表值：三引擎各自有，且不低于 floor（防止"并回去用一个总预算"或悄悄清零）
  const dl = deadlineTable(src);
  for (const [name, floor] of Object.entries(FLOORS)) {
    assert.ok(dl[name] >= floor, `★ ${name} 的逐源截止必须 >= ${floor}s（got ${dl[name]}）`);
  }
  assert.equal(dl.Packages, undefined, '★ 表里不该再有 Packages（拆开后它是死键，留着会让人以为还在用）');
}

/** 取主脚本里某个函数的函数体（按下一个 \nfunction 收尾） */
function mainFn(src, name) {
  const i = src.indexOf('function ' + name + ' {');
  assert.ok(i > 0, '锚点缺失：' + name);
  const j = src.indexOf('\nfunction ', i + 10);
  return src.slice(i, j > i ? j : undefined);
}

function checkWiring(src) {
  const npm = engineSource('npm-registry.ps1');
  // ★下载量补全的实现（Set-NpmDownloadStats）在**主脚本**里，不在引擎文件里 —— 这一点本身值得记：
  //   拆引擎时容易以为"跟着引擎走了"，实际它是被注册表 Needs 注入 runspace 的共享函数。
  const dl = mainFn(src, 'Set-NpmDownloadStats');
  assert.match(dl, /-TimeoutSec \$script:Cfg\.NpmDownloadTimeoutSec -MaxAttempts 1/,
    '★ 下载量补全必须用 NpmDownloadTimeoutSec + MaxAttempts 1（它是增强，不该等 20s×3）');
  assert.doesNotMatch(dl, /-TimeoutSec \$script:Cfg\.ApiTimeoutSec/,
    '★ 下载量补全不得再用 ApiTimeoutSec(20s)');
  // 两处（批量 + scoped 逐个）都要换 —— 只改一处会留下一条 20s 的漏网路径
  const batchHits = (dl.match(/NpmDownloadTimeoutSec/g) || []).length;
  assert.ok(batchHits >= 2, '★ 批量与 scoped 两处查询都必须用短超时（got ' + batchHits + ' 处）');
  // 预算守卫：search 用太久就跳过补全
  assert.match(npm, /\$spentSec = \$sw\.Elapsed\.TotalSeconds/,
    'npm 引擎必须给 search 计时（否则无法判断还有没有余量做补全）');
  assert.match(npm, /if \(@\(\$results\)\.Count -gt 0 -and \$spentSec -lt \$budgetSec\)/,
    '★ 必须有"主结果优先"守卫：search 用掉过半预算时跳过下载量补全');
  // ★U-253（2026-10-26）：**两个相反目标的冲突要用旋钮解，不能用改代码解**。
  //   实测经过（别删）：2026-10-25 23:07 并行会话为了让质量基线的 downloads 字段完整，
  //   把上面的 `-and $spentSec -lt $budgetSec` 直接删了 ⇒ 本门当场判红，而它那边也认为自己没错。
  //   两边都对：B1-7 要速度（实测 npm search 十轮里 2 次挂满 15.01s），评测要完整字段（缺字段会改排序）。
  //   处置：加 `NpmDownloadPolicy = fast|full`，**full 通过"预算=无穷"实现**，守卫形态一字不动 ——
  //   这样"主结果优先"这条契约在两种模式下都还在，本门也不需要放宽任何一个字符。
  assert.match(npm, /MCPS_NPM_DOWNLOAD_POLICY/, '★ 必须有 fast/full 策略旋钮（环境变量优先，评测脚本可单次覆盖）');
  assert.match(npm, /\$budgetSec = if \(\$dlPolicy -eq 'full'\)/,
    '★ full 模式必须通过「预算=无穷」实现，而不是删掉守卫（删守卫 = 换回"为了补全可以拖死主结果"）');
  assert.match(src, /NpmDownloadPolicy\s*=\s*'fast'/,
    '★ Cfg 默认必须是 fast（主结果优先）；改成 full 等于把 B1-7 的实测结论作废');
  assert.doesNotMatch(npm, /if \(@\(\$results\)\.Count -gt 0\) \{\s*\r?\n\s*try \{ Set-NpmDownloadStats/,
    '★ 不得退回"无条件补全"（2026-10-25 那次的形态）—— 那条路径下 npm 挂死时连主结果都拿不到');
  // 跳过要留痕（否则 Unit 全变 popularity 会被当成接口退化）
  assert.match(npm, /跳过下载量补全以保主结果/, '跳过补全必须写 warnings 留痕');

  // ★同一类缺陷的第二处：arXiv 引用数富化（也是纯增强）原本用 ApiTimeoutLongSec(25s) × 3 次 = 最坏 75s。
  //   治 npm 下载量时顺手收口；这条断言防它退回去。
  const enrich = mainFn(src, 'Enrich-ArxivCitations');
  assert.match(enrich, /-TimeoutSec \$script:Cfg\.ArxivEnrichTimeoutSec -MaxAttempts 1/,
    '★ arXiv 引用数富化必须用 ArxivEnrichTimeoutSec + 单次（它是增强，不该占 25s×3）');
  assert.doesNotMatch(enrich, /ApiTimeoutLongSec/,
    '★ 富化不得再用 ApiTimeoutLongSec(25s)');

  // 每个引擎的告警必须用**自己的**引擎名（写错会让 coverage 把 A 的失败记到 B 头上）
  const cases = [['npm-registry.ps1', 'Npm'], ['crates-io.ps1', 'Crates'], ['maven-central.ps1', 'Maven']];
  for (const [file, name] of cases) {
    const s2 = engineSource(file);
    assert.match(s2, new RegExp(`Add-EngineWarning -Engine '${name}'`), `${file} 的告警引擎名必须是 ${name}`);
    assert.doesNotMatch(s2, /Add-EngineWarning -Engine 'Packages'/, `${file} 不得再上报到已删除的 Packages`);
  }
  // 引擎文件必须只有一个函数（一个引擎 = 一个上游，不是"一个文件塞三个"）
  for (const file of ENGINES) {
    const n = (engineSource(file).match(/^function /gm) || []).length;
    assert.equal(n, 1, `${file} 必须只定义一个函数（got ${n}）—— 多上游塞一个引擎就是这次要拆掉的形态`);
  }
  // 旧文件必须删掉（留着会被自动 dot-source，等于把拆开的又装回去）
  assert.equal(fs.existsSync(path.join(ROOT, 'engines', 'package-registries.ps1')), false,
    '★ engines/package-registries.ps1 必须已删除（engines/*.ps1 会被全量 dot-source）');
  // 只禁**注册表/调用点**引用；历史注释里提旧函数名是合法记录，不该判红
  //（本门第一版就是全文件禁词，结果被 U-167 的搬运行注释绊住 —— 门比事实更严也是缺陷）
  assert.doesNotMatch(src, /Func\s*=\s*'Search-PackageRegistries'/, '★ 注册表不得再有 Func = Search-PackageRegistries');
  assert.doesNotMatch(src, /Search-PackageRegistries\s+-Keyword/, '不得再直接调用 Search-PackageRegistries');
}

test('U-243 结构：npm/crates.io/Maven 各自成引擎，旧 Packages 彻底消失', () => {
  checkStructure(MAIN);
});

test('U-243 接线：下载量补全短超时 + 主结果优先守卫 + 各引擎自报名', () => {
  checkWiring(MAIN);
});

test('U-243 负例：并回一个引擎 / 改回长超时 / 去掉守卫 / 告警写错名 —— 都必须被判红', () => {
  // ① 把三行并回一个多上游引擎
  const merged = MAIN.replace(
    /    @\{ Name = 'Npm';.*?\n    @\{ Name = 'Crates';.*?\n    @\{ Name = 'Maven';.*?\n/s,
    "    @{ Name = 'Packages';    Kind = 'research'; Platforms = @('npm','crates.io','Maven'); Func = 'Search-NpmRegistry'; Needs = @() },\n",
  );
  assert.notEqual(merged, MAIN, 'mutation 必须生效（并回一个引擎）');
  assert.throws(() => checkStructure(merged), /缺少引擎 Npm|Packages/, '并回一个引擎必须判红');

  // ② 把某个引擎的 Platforms 写成多个上游（等于"一引擎多源"）
  const multi = MAIN.replace("Platforms = @('crates.io')", "Platforms = @('crates.io','Maven')");
  assert.notEqual(multi, MAIN);
  assert.throws(() => checkStructure(multi), /Platforms 必须只有一个上游/, '一引擎多上游必须判红');

  // ③ 表值清零（退回"不限"或并回总预算）
  const zeroed = MAIN.replace('Npm = 13;', 'Npm = 0;');
  assert.notEqual(zeroed, MAIN);
  assert.throws(() => checkStructure(zeroed), /Npm 的逐源截止必须 >= 13/, '清零必须判红');

  // ④ 下载量补全改回 ApiTimeoutSec（在主脚本里变异，不动磁盘）
  const slow = MAIN.split('-TimeoutSec $script:Cfg.NpmDownloadTimeoutSec -MaxAttempts 1').join('-TimeoutSec $script:Cfg.ApiTimeoutSec');
  assert.notEqual(slow, MAIN, 'mutation 必须生效（下载量补全改回长超时）');
  assert.throws(() => checkWiring(slow), /NpmDownloadTimeoutSec|不得再用 ApiTimeoutSec/, '改回长超时必须判红');

  // ⑤ 只改一处（批量换了、scoped 漏了）—— 这是最容易发生的半吊子改动
  const half = MAIN.replace(
    'https://api.npmjs.org/downloads/point/last-week/$sn" -Headers $ua -TimeoutSec $script:Cfg.NpmDownloadTimeoutSec -MaxAttempts 1',
    'https://api.npmjs.org/downloads/point/last-week/$sn" -Headers $ua -TimeoutSec $script:Cfg.ApiTimeoutSec',
  );
  assert.notEqual(half, MAIN, 'mutation 必须生效（只改批量一处）');
  assert.throws(() => checkWiring(half), /不得再用 ApiTimeoutSec|两处查询都必须用短超时/, '两处只改一处必须判红');

  // ⑥ 去掉"主结果优先"守卫
  const noGuard = engineSource('npm-registry.ps1').split('if (@($results).Count -gt 0 -and $spentSec -lt $budgetSec)').join('if (@($results).Count -gt 0)');
  const origNpm = engineSource('npm-registry.ps1');
  assert.notEqual(noGuard, origNpm, 'mutation 必须生效（去掉守卫）');
  try {
    fs.writeFileSync(path.join(ROOT, 'engines', 'npm-registry.ps1'), noGuard, 'utf8');
    assert.throws(() => checkWiring(MAIN), /主结果优先/, '去掉守卫必须判红');
  } finally {
    fs.writeFileSync(path.join(ROOT, 'engines', 'npm-registry.ps1'), origNpm, 'utf8');
  }
});
