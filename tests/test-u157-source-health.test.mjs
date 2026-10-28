// U-157（2026-10-02）信源健康门 —— 由「全信源端到端体检」沉淀而成。
//
// 背景（实测，非推断）：隔离跑 19 个引擎后抓��两类**载荷自相矛盾/静默假阴性**：
//   ① GitLab：/projects?order_by=stars 被 GitLab 判 HTTP 400 {"error":"order_by does not have a valid value"}
//      （合法值含 star_count，不含 stars）；而引擎 catch 又把失败吞成空数组
//      ⇒ 报成"检索成功但 0 命中"。静默假阴性：请求压根没成功，却长得像"这个源没内容"。
//   ② Gitee/Codeberg：results=20/3、metrics.PerPlatformCount=20/3、completeness.returned_count=20/3，
//      但 coverage.ReasonCodes=zero-hit、Reasons="检索成功但 0 命中"。
//      （成因在 runspace 状态写回与父侧 $res 兜底，不在本门解决；本门锁的是**纠正规则**本身。）
//
// 本门三件事，每件都带**变异对照**（改了源码就必须红），不做只会"看着绿"的装饰断言：
//   A. GitLab 引擎不得再用 GitLab 不认识的 order_by 取值（stars）；失败必须显式上报而非静默空数组。
//   B. Resolve-EngineStatusFromResults 的判定表：有结果 ⇒ empty/unknown 改判 ok；其余状态一律不动。
//   C. 注册表自洽：每个引擎都有 Kind/Platforms/Func，且 Needs 里的函数真实存在（runspace 注入不到就是静默失能）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceAll } from './lib/source.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mainSrc = sourceAll(path.join(root));
const glSrc = fs.readFileSync(path.join(root, 'engines/search-gitlab.ps1'), 'utf8');

// ---------- A. GitLab 引擎：order_by 合法 + 失败显式上报 ----------
// GitLab /projects 的 order_by 合法取值（2026-10-02 实测：stars 被 400 拒，star_count 通过）
const GITLAB_ORDER_BY = new Set(['id', 'name', 'path', 'created_at', 'last_activity_at', 'star_count', 'forks_count']);
export function parseOrderBy(src) {
  // 只看真正的代码行：注释里为了说明故障会写 order_by=stars，不能被当成实现
  const code = src.split(/\r?\n/).filter(l => !/^\s*#/.test(l)).join('\n');
  const m = /order_by=([A-Za-z_]+)/.exec(code);
  return m ? m[1] : null;
}
test('U-157 A1: GitLab 引擎的 order_by 必须是 GitLab /projects 认识的取值（实测 stars 被 400 拒）', () => {
  const ob = parseOrderBy(glSrc);
  assert.ok(ob, 'GitLab 引擎必须显式给出 order_by');
  assert.ok(GITLAB_ORDER_BY.has(ob), `order_by=${ob} 不在合法集合 {${[...GITLAB_ORDER_BY].join(',')}}`);
});
test('U-157 A1 变异对照：把 star_count 改回 stars 必须被本门抓住', () => {
  const mutant = glSrc.replace('order_by=star_count', 'order_by=stars');
  assert.notEqual(mutant, glSrc, '变异必须真的改到源码');
  assert.equal(GITLAB_ORDER_BY.has(parseOrderBy(mutant)), false);
  assert.throws(() => assert.ok(GITLAB_ORDER_BY.has(parseOrderBy(mutant))), assert.AssertionError);
});
test('U-157 A2: GitLab 引擎失败必须显式 Set-EngineStatus error，不得静默返回空数组（旧写法会把 400 报成零命中）', () => {
  const catchBlock = glSrc.slice(glSrc.indexOf('catch {'));
  assert.match(catchBlock, /Set-EngineStatus\s+-Name\s+'GitLab'\s+-Status\s+'error'/, 'catch 分支必须显式记 error');
  assert.match(catchBlock, /Add-EngineWarning/, 'catch 分支必须留下可审计 warning');
  // 变异对照：去掉显式上报（还原成静默 return @()）必须被抓住
  const mutant = glSrc.replace(/Set-EngineStatus\s+-Name\s+'GitLab'\s+-Status\s+'error'\s+-Reason[^\n]*\n/, '')
    .replace(/Add-EngineWarning[^\n]*\n/, '');
  assert.doesNotMatch(mutant.slice(mutant.indexOf('catch {')), /Set-EngineStatus\s+-Name\s+'GitLab'\s+-Status\s+'error'/);
});
test('U-157 A3: GitLab 引擎对非数组响应（GitLab 的 4xx 错误体也是 JSON）必须显式失败，不能当数组遍历', () => {
  assert.match(glSrc, /\$data\s+-isnot\s+\[System\.Array\]/, '必须有形状守卫');
  assert.match(glSrc, /order_by does not have|返回非数组/, '守卫必须说明原因');
  const mutant = glSrc.replace(/\$data\s+-isnot\s+\[System\.Array\][\s\S]*?\n\s*\}\n/, '');
  assert.doesNotMatch(mutant, /\$data\s+-isnot\s+\[System\.Array\]/);
});

// ---------- B. 有结果就不许记 zero-hit（纠正规则的判定表） ----------
export function resolveStatusFromResults(status, hasResults) {
  if (hasResults && (status === 'empty' || status === 'unknown')) return 'ok';
  return status;
}
test('U-157 B: Resolve-EngineStatusFromResults 判定表 —— 有结果时 empty/unknown ⇒ ok，其余状态不动', () => {
  // 正例
  assert.equal(resolveStatusFromResults('empty', true), 'ok');
  assert.equal(resolveStatusFromResults('unknown', true), 'ok');
  // 反例：缺凭据/不可达/错误/限流**不能**被"有结果"掩盖
  for (const s of ['auth_missing', 'tool_missing', 'network_unavailable', 'error', 'rate_limited']) {
    assert.equal(resolveStatusFromResults(s, true), s, s + ' 不得被改判');
    assert.equal(resolveStatusFromResults(s, false), s, s + ' 无结果时也不得改判');
  }
  // 无结果时 empty/unknown 保持原样
  assert.equal(resolveStatusFromResults('empty', false), 'empty');
  assert.equal(resolveStatusFromResults('unknown', false), 'unknown');
});
test('U-157 B 变异对照：把 empty 从判定表里删掉必须被抓住', () => {
  const mutant = (status, hasResults) => (hasResults && status === 'unknown' ? 'ok' : status);
  assert.equal(mutant('empty', true), 'empty', '变异体不再纠正 empty');
  assert.notEqual(mutant('empty', true), resolveStatusFromResults('empty', true));
});
test('U-157 B 源码锚点：主脚本里必须有该纯函数 + 汇总前的纠正循环（否则门锁的是另一个实现）', () => {
  assert.match(mainSrc, /function Resolve-EngineStatusFromResults \{/);
  assert.match(mainSrc, /Resolve-EngineStatusFromResults -Status \$stBefore -HasResults \$hasRes/);
  // 纠正必须发生在 executed/ReasonCodes 汇总**之前**
  const callIdx = mainSrc.indexOf('Resolve-EngineStatusFromResults -Status $stBefore');
  const sumIdx = mainSrc.indexOf('$reasonCodes = [ordered]@{}');
  assert.ok(callIdx > 0 && sumIdx > callIdx, '纠正循环必须早于 ReasonCodes 汇总');
  // 变异对照：把调用换成恒等（不纠正）必须被锚点抓住
  const mutant = mainSrc.replace('Resolve-EngineStatusFromResults -Status $stBefore -HasResults $hasRes', '$stBefore');
  assert.doesNotMatch(mutant, /Resolve-EngineStatusFromResults -Status \$stBefore/);
});

// ---------- C. 注册表自洽：Needs 里的函数必须真实存在 ----------
// 按行解析（整行正则在字段顺序/空格一变就全灭 ⇒ 那种门等于没有）
function parseRegistry(src) {
  return src.split(/\r?\n/)
    .filter(l => /^\s*@\{ Name = '/.test(l))
    .map(line => ({
      line,
      name: /Name = '([A-Za-z]+)'/.exec(line)?.[1] ?? null,
      kind: /Kind = '([a-z]+)'/.exec(line)?.[1] ?? null,
      platforms: /Platforms = @\(([^)]*)\)/.exec(line)?.[1] ?? null,
      func: /Func = '([A-Za-z0-9_-]+)'/.exec(line)?.[1] ?? null,
      needs: (/Needs = @\(([^)]*)\)/.exec(line)?.[1] ?? '')
        .split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean),
    }));
}
test('U-157 C: 引擎注册表每项都有 Kind/Platforms/Func，且 Func 真的有实现、Needs 列出的函数真实存在', () => {
  const reg = parseRegistry(mainSrc);
  assert.ok(reg.length >= 18, '注册表应至少 18 个引擎，实际 ' + reg.length);
  // 权威口径：**哪个文件定义了 Func** —— 不靠"文件名像不像"（Search-HuggingFace 在 hugging-face.ps1，
  // Search-PackageRegistries 在 package-registries.ps1，按名字猜会全判错）
  const engineSrcs = fs.readdirSync(path.join(root, 'engines'))
    .filter(f => f.endsWith('.ps1'))
    .map(f => ({ f, s: fs.readFileSync(path.join(root, 'engines', f), 'utf8') }));
  const problems = [];
  for (const e of reg) {
    if (!e.kind) problems.push(`${e.name}: 缺 Kind`);
    if (!e.platforms || !e.platforms.trim()) problems.push(`${e.name}: 缺 Platforms`);
    if (!e.func) { problems.push(`${e.name}: 缺 Func`); continue; }
    const inEngine = engineSrcs.filter(x => new RegExp('function\\s+' + e.func + '\\s*\\{').test(x.s)).map(x => x.f);
    const inMain = new RegExp('function\\s+' + e.func + '\\s*\\{').test(mainSrc);
    if (!inEngine.length && !inMain) problems.push(`${e.name}: Func ${e.func} 没有任何实现（engines/* 与主脚本都没有）`);
    for (const n of e.needs) {
      // v1.53.1：Needs 的存在性口径与 Func 一致 —— **主脚本 ∪ engines/*.ps1**。
      //   旧断言只查主脚本，其假设「Needs 全指向主脚本函数」在 v1.38.0 引擎外置后不再成立：
      //   主脚本 top-level dot-source engines/*.ps1 ⇒ 引擎文件里的函数同样在池运行前已定义，
      //   `(Get-Item "function:X").Definition` 拿得到（实测 ConvertFrom-GrepAppText defLen=1738）。
      //   仍必须"真实存在"：Needs 写了不存在的函数 ⇒ 注入拿到空 Definition ⇒ 池内静默失能。
      const inMain = new RegExp('function\\s+' + n + '\\s*\\{').test(mainSrc);
      const inEngineFiles = engineSrcs.filter(x => new RegExp('function\\s+' + n + '\\s*\\{').test(x.s)).map(x => x.f);
      if (!inMain && !inEngineFiles.length) {
        problems.push(`${e.name} 需要 ${n}，但主脚本与 engines/ 里都没有该函数（注入链拿不到 Definition ⇒ 池内静默失能）`);
      }
    }
  }
  assert.deepEqual(problems, [], problems.join(' | '));
});
test('U-157 C 变异对照：从注册表里删掉一个引擎必须被门抓住（防"引擎文件还在但注册表漏了"）', () => {
  const mutant = mainSrc.replace(/^\s*@\{ Name = 'DockerHub';.*$/m, '');
  assert.notEqual(mutant, mainSrc, '变异必须真的改到源码');
  assert.ok(parseRegistry(mutant).length < parseRegistry(mainSrc).length, '删掉一项后引擎数必须变少');
});

test('U-157 C 变异对照（v1.53.1 门扩围后的自身负例）：Needs 写不存在的函数仍必须被抓住', () => {
  // 门的存在性检查扩到 engines/ 后，必须证明"写谁都过"的假绿没混进来：
  //   ① Needs 加一个**两处都没有**的函数名 ⇒ 必红；
  //   ② Needs 加一个**只在 engines/** 的函数名（真值，ConvertFrom-GrepAppText）⇒ 必绿（这就是本次扩围的动机）。
  const checkNeeds = (src) => {
    const reg = parseRegistry(src);
    const engineSrcs = fs.readdirSync(path.join(root, 'engines'))
      .filter(f => f.endsWith('.ps1'))
      .map(f => ({ f, s: fs.readFileSync(path.join(root, 'engines', f), 'utf8') }));
    const problems = [];
    for (const e of reg) {
      for (const n of e.needs) {
        const inMain = new RegExp('function\\s+' + n + '\\s*\\{').test(src);
        const inEng = engineSrcs.some(x => new RegExp('function\\s+' + n + '\\s*\\{').test(x.s));
        if (!inMain && !inEng) problems.push(e.name + ' 需要 ' + n);
      }
    }
    return problems;
  };
  // ① 假函数名 ⇒ 必被点名
  const ghost = mainSrc.replace(
    "Needs = @('Write-ColorOutput','Get-ApiHeaders','Invoke-ApiRequest','Set-EngineStatus','Get-EngineStatus','Add-EngineWarning','Get-CodeRequestBudget','Get-EngineDeadlineOverride','ConvertFrom-GrepAppText') },",
    "Needs = @('Write-ColorOutput','Get-ApiHeaders','Invoke-ApiRequest','Set-EngineStatus','Get-EngineStatus','Add-EngineWarning','Get-CodeRequestBudget','Get-EngineDeadlineOverride','ConvertFrom-GrepAppText','NoSuchFn-XYZ') },");
  assert.notEqual(ghost, mainSrc, '变异必须真的改到 Needs');
  assert.ok(checkNeeds(ghost).some(p => p.includes('NoSuchFn-XYZ')),
    '★ Needs 写不存在的函数必须被抓住（否则扩围后的门是"写谁都过"的假绿）');
  // ② 真实的 engines/ 函数 ⇒ 必须通过（负负得正：证明扩围不是"直接放行"）
  assert.deepEqual(checkNeeds(mainSrc), [], '真实 Needs 必须全通过');
});
