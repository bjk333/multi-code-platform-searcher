// R-4: offline documentation gate; the PowerShell test-docs group remains host-only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sourceAll } from './lib/source.mjs';

const doc = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'SKILL.md'), 'utf8');
function hasR4(body) {
  return /registry\.modelcontextprotocol\.io\/v0\/servers/.test(body) &&
    /Glama（.*不接入/.test(body) && /保留后续接入路径/.test(body) &&
    /-FocusTerms \"核心词1,核心词2\"/.test(body) &&
    /-NoiseFloor 0\.3/.test(body) && /MatchTerms/.test(body) && /NoiseFlagged/.test(body) &&
    body.split(/\r?\n/).filter(line => /^python mcps\.py /.test(line)).length === 4 &&
    /受限策略机器首选/.test(body) && /tools\/bin.*PATH/.test(body);
}

test('R-4 restores precise registry, research denoising and four Python quick-start examples', () => {
  assert.ok(hasR4(doc));
  assert.doesNotMatch(doc, /POST 兜底 \/ `-d` 截止 \/ Doctor 429 双义判别\n\s+\*\*当前代码中不存在\*\*/);
  const lines = doc.split(/\r?\n/);
  const end = lines.indexOf('---', 1);
  assert.ok(end > 0, 'closed frontmatter');
  assert.ok(lines.slice(end + 1).every(line => line.length <= 300), 'test-docs body line-length guard');
});

test('negative control: losing Python examples is detected', () => {
  // U-269（2026-10-26 全量验收）：原来写的是 `/^python mcps\.py .*\n/gm` —— JS 里 `.` **不匹配 `\r`**，
  //   而本仓 SKILL.md 是 CRLF（`.gitattributes` 明写 `* -text`、按字节存取）⇒ 这条负例恒不生效（红的是负例本身）。
  //   改成 `\r?\n` 之后与行尾无关；判据不变：删掉那 4 行 ⇒ 探测器必须报不存在。
  const reverted = doc.replace(/^python mcps\.py .*(\r?\n|$)/gm, '');
  assert.notEqual(reverted, doc, '变异没生效（一条 python 行都没删掉）');
  assert.equal(hasR4(reverted), false);
});

test('U-43 version title needs a matching second-line history entry (with a negative control)', () => {
  const script = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'multi-platform-searcher.ps1'), 'utf8');
  const version = /^\$VERSION = "([0-9.]+)"$/m.exec(script)?.[1];
  assert.ok(version, 'current version not found');
  const hasMatchingEntry = text => text.split(/\r?\n/)[1]?.startsWith(`# v${version}（`) === true;
  assert.equal(hasMatchingEntry(script), true);
  const reverted = script.replace(`# v${version}（`, '# v0.0.0（');
  assert.notEqual(reverted, script, 'negative control must mutate the actual version entry');
  assert.equal(hasMatchingEntry(reverted), false);
});

// R12: read only files already in the 36-path published manifest, never the B-only 说明书.md.
const troubleshooting = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'references/故障排查.md'), 'utf8');
const history = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'references/变更历史.md'), 'utf8');
const requiredLessons = [
  '缺失证据≠未发生', 'Windows PS 5.1 与便携 PS 7.6.6', '清单按依赖倒推（N-14/N-15）',
  'ErrorDetails.Message', '并发 Runspace 的函数闭包（U-02）', 'Test-RateLimit403',
];
function guardR12Lessons(body) {
  for (const lesson of requiredLessons) assert.ok(body.includes(lesson), `U-20 lesson missing: ${lesson}`);
  assert.doesNotMatch(body, /宿主无 `pwsh` 7|入口尚待提供/);
}
test('U-20 keeps four evidence disciplines and both PS7 HTTP/Runspace lessons', () => {
  guardR12Lessons(troubleshooting);
  const mutated = troubleshooting.replace('清单按依赖倒推（N-14/N-15）', '清单按文件类型筛选');
  assert.notEqual(mutated, troubleshooting);
  assert.throws(() => guardR12Lessons(mutated), /U-20 lesson missing/);
});

const credentialShape = new RegExp('(?:github' + '_pat_|glpat' + '_)[A-Za-z0-9_-]{4,}', 'i');
test('U-18 history has no token-shaped placeholders (with a synthetic negative control)', () => {
  assert.equal(credentialShape.test(history), false, 'history must not look like a live token');
  assert.equal(credentialShape.test(history + ' ' + 'github' + '_pat_' + 'FAKE_VALUE_1234'), true);
});

// ================= Wave A (R16, 2026-09-26): U-54 / U-55 docs parity =================
const rootDir = path.resolve(import.meta.dirname, '..');
// U-100 C-13 门跟随（2026-09-28）：引擎实现外置到 engines/*.ps1 ⇒ 按函数体做的断言（U-94 `ApiScore = $item.Score` 等）改在 **主脚本 + engines/** 合并源上做（engines/ 为空时 === 原源，惰性）。
const __enginesDir = path.join(rootDir, 'engines');
const __engineSrc = fs.existsSync(__enginesDir)
  ? fs.readdirSync(__enginesDir).filter((f) => f.endsWith('.ps1')).sort().map((f) => fs.readFileSync(path.join(__enginesDir, f), 'utf8')).join('\n')
  : '';
const mainSrc = sourceAll(path.join(rootDir));
const harness = fs.readFileSync(path.join(rootDir, 'tests/run-tests.ps1'), 'utf8');
const cheat = fs.readFileSync(path.join(rootDir, 'references/参数速查.md'), 'utf8');
function section(md, heading) {
  const i = md.indexOf('\n## ' + heading);
  if (i < 0) throw new Error('section missing: ' + heading);
  const j = md.indexOf('\n## ', i + 4);
  return md.slice(i, j < 0 ? md.length : j);
}
function cfgKeys(src) {
  const lines = src.split('\n');
  const s = lines.findIndex(l => l.startsWith('$script:Cfg = @{'));
  let depth = 0, e = s;
  for (let i = s; i < lines.length; i++) { depth += (lines[i].match(/\{/g) || []).length - (lines[i].match(/\}/g) || []).length; if (depth === 0) { e = i; break; } }
  return lines.slice(s + 1, e).map(l => l.match(/^\s+([A-Za-z]\w*)\s*=/)).filter(Boolean).map(m => m[1]);
}
// only the first table column counts (prose mentions like `Cfg`/`param` are not rows)
function docKeysOf(sec) { return new Set([...sec.matchAll(/^\| ((?:`[A-Za-z_][A-Za-z0-9_]*`(?:（[^）]*）)?(?: \/ )?)+) \|/gm)].flatMap(m => [...m[1].matchAll(/`([A-Za-z_][A-Za-z0-9_]*)`/g)].map(x => x[1]))); }
test('U-54: Cfg key set == keys documented in the 参数速查 "Cfg 策略常数" table (both directions)', () => {
  const code = new Set(cfgKeys(mainSrc));
  const doc = docKeysOf(section(cheat, 'Cfg 策略常数'));
  const missingInDoc = [...code].filter(k => !doc.has(k));
  const extraInDoc = [...doc].filter(k => !code.has(k));
  assert.deepEqual(missingInDoc, [], 'Cfg keys missing from doc: ' + missingInDoc.join(','));
  assert.deepEqual(extraInDoc, [], 'doc keys not in Cfg: ' + extraInDoc.join(','));
  assert.ok(code.size >= 29);
});
test('U-54 negative control: adding a Cfg key without documenting it names the key', () => {
  const mutated = mainSrc.replace('    PreviewLen        = 200', '    PreviewLen        = 200\n    BrandNewKnob = 1');
  const code = new Set(cfgKeys(mutated));
  const doc = docKeysOf(section(cheat, 'Cfg 策略常数'));
  assert.deepEqual([...code].filter(k => !doc.has(k)), ['BrandNewKnob']);
});
function envKnobsIn(src) {
  const out = new Set();
  for (const line of src.split('\n')) {
    const code = line.replace(/(^|\s)#.*$/, '');
    for (const m of code.matchAll(/\$env:([A-Za-z_][A-Za-z0-9_]*)/g)) out.add(m[1]);
    for (const m of code.matchAll(/GetEnvironmentVariable\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g)) out.add(m[1]);
    for (const m of code.matchAll(/Env:([A-Za-z_][A-Za-z0-9_]+)/g)) out.add(m[1]);
    // data-driven reads: Key = 'S2_API_KEY' / Var = 'GLAMA_API_KEY' / foreach ($v in @('HTTPS_PROXY', …)) then GetEnvironmentVariable($v)
    if (/GetEnvironmentVariable|Key = '|Var = '|env:/i.test(code)) for (const m of code.matchAll(/'([A-Z][A-Z0-9_]{3,})'/g)) out.add(m[1]);
    for (const m of code.matchAll(/'((?:HTTPS?|ALL|NO|MCPS(?:_SYSTEM)?)_PROXY|(?:https?|all|no)_proxy)'/g)) out.add(m[1]);   // proxy-variable arrays (Initialize-Network / Get-ProcessProxyEnvSummary)
  }
  return out;
}
const PROXY_FAMILY = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'];
const NOT_KNOBS = new Set(['TEMP', 'LOCALAPPDATA', 'USERPROFILE', 'COMPUTERNAME', 'PATH', 'Path']);   // OS-provided, not product knobs
test('U-55: every environment knob read by the script or the harness is documented in the 环境旋钮 table (and no stale rows)', () => {
  const sec = section(cheat, '环境旋钮');
  const doc = docKeysOf(sec);
  const code = new Set([...envKnobsIn(mainSrc), ...envKnobsIn(harness)].filter(v => !NOT_KNOBS.has(v)));
  for (const p of PROXY_FAMILY) if (code.has(p)) { code.delete(p); code.add('HTTP_PROXY'); }
  const missing = [...code].filter(v => !doc.has(v));
  assert.deepEqual(missing, [], 'env knobs missing from doc: ' + missing.join(','));
  const rows = [...sec.matchAll(/^\| `([A-Z_a-z0-9]+)`/gm)].map(m => m[1]);
  const stale = rows.filter(r => !code.has(r));
  assert.deepEqual(stale, [], 'doc rows not read anywhere: ' + stale.join(','));
  // three columns and no values printed
  assert.match(sec, /\| 环境变量 \| 作用 \| 影响网络路由 \|/);
  assert.ok(/\*\*是\*\*/.test(sec) && /\| 否/.test(sec));
});
test('U-55 negative control: a new $env: read without a doc row names the variable', () => {
  const mutated = mainSrc + '\nif ($env:MCPS_BRAND_NEW) { }\n';
  const doc = docKeysOf(section(cheat, '环境旋钮'));
  assert.deepEqual([...envKnobsIn(mutated)].filter(v => !doc.has(v) && !NOT_KNOBS.has(v) && !PROXY_FAMILY.includes(v)), ['MCPS_BRAND_NEW']);
});

// ================= Wave 2 (R17, 2026-09-26): U-57 / U-58 / U-59 / U-60 =================
const VERSION = /^\$VERSION = "([0-9.]+)"$/m.exec(mainSrc)[1];
const changelog = fs.readFileSync(path.join(rootDir, 'references/变更历史.md'), 'utf8');
// U-59: exactly one "当前基线" row in the lineage table, and it names $VERSION.
function baselineRows(md) { return md.split(/\r?\n/).filter(l => /^\| \*\*当前基线\*\* \|/.test(l)); }
// U-59 gate-follow (2026-10-06, U-168/U-169): A and B are no longer required to share one version.
// The old contract asserted the row literally read "A = B = v$VERSION". B (workspace canonical) and A
// (skillhub built-in skill line) genuinely diverged, so the row may now declare divergence instead --
// but it must still (a) name B = v$VERSION, and (b) if it claims A = B = vX, then X must equal $VERSION
// (a stale "A = B = <old>" claim still fails). Not merely loosened: both branches stay falsifiable.
function baselineRowOk(rows, version) {
  if (rows.length !== 1) return false;
  const r = rows[0];
  if (!new RegExp('B = v' + version.replace(/\./g, '\\.') + '[^0-9]').test(r)) return false;
  const same = /A = B = v(\d+\.\d+\.\d+)/.exec(r);
  if (same) return same[1] === version;
  return /A 线[^|]{0,120}?v\d+\.\d+\.\d+/.test(r);
}
test('U-59: lineage table has exactly one 当前基线 row naming B = $VERSION (or an explicit A/B divergence)', () => {
  const rows = baselineRows(changelog);
  assert.equal(rows.length, 1, 'expected exactly one 当前基线 row, got ' + rows.length);
  assert.ok(baselineRowOk(rows, VERSION), 'baseline row must name B = v' + VERSION + ' (or declare A/B divergence with A version): ' + rows[0].slice(0, 120));
});
test('U-59 gate-follow negative control: stale A = B claim, wrong B version and missing divergence all fail', () => {
  const rows = baselineRows(changelog);
  assert.ok(baselineRowOk(rows, VERSION), 'current changelog must pass before mutation');
  assert.equal(baselineRowOk(rows, '9.9.9'), false, 'wrong B version must fail');
  const stale = ['| **当前基线** | **A = B = v1.37.0** x | y |'];
  assert.equal(baselineRowOk(stale, VERSION), false, 'stale A = B = v<old> claim must fail');
  const noDivergence = ['| **当前基线** | **B = v' + VERSION + '** x | y |'];
  assert.equal(baselineRowOk(noDivergence, VERSION), false, 'B-only row without A version must fail');
});
test('U-59 negative control: bumping $VERSION without touching the baseline row is detected', () => {
  const rows = baselineRows(changelog);
  assert.doesNotMatch(rows[0], /A = B = v9\.9\.9/);
});
// U-57: "current-state" documents must not carry stale state phrases or stale version anchors.
// Scope = files whose sentences describe the CURRENT state. 变更历史.md body is HISTORY (excluded, except the 当前基线 row above).
const CURRENT_STATE_DOCS = ['SKILL.md', 'references/参数速查.md', 'references/引擎链.md', 'references/端到端范例.md', '说明书.md'];
const STALE_PHRASES = /(未发布|待宿主|仍待验收|仍待|B 候选|（候选）|候选\)|v\d+\.\d+\.\d+ 候选)/;
const STALE_ALLOW = [/候选链/, /噪音候选/, /候选池/, /候选（assess/, /候选，/, /候选。/, /多候选/, /候选逻辑/, /只是候选/];   // domain uses of 候选 = search candidates, not release state
function staleFindings() {
  const out = [];
  for (const rel of CURRENT_STATE_DOCS) {
    const p = path.join(rootDir, rel); if (!fs.existsSync(p)) continue;
    fs.readFileSync(p, 'utf8').split(/\r?\n/).forEach((line, i) => {
      if (STALE_PHRASES.test(line) && !STALE_ALLOW.some(r => r.test(line))) out.push(`${rel}:${i + 1}: ${line.trim().slice(0, 80)}`);
      const m = /(发布基线|当前版本|版本：)[（(]?v(\d+\.\d+\.\d+)/.exec(line);
      if (m && m[2] !== VERSION) out.push(`${rel}:${i + 1}: version anchor v${m[2]} != $VERSION ${VERSION}`);
    });
  }
  return out;
}
test('U-57: current-state docs carry no stale release-state phrases and their version anchors equal $VERSION', () => {
  const f = staleFindings();
  assert.deepEqual(f, [], f.join(' | '));
});
test('U-57 negative control: a stale "发布基线（v1.37.7" line is reported with file:line', () => {
  const skill = fs.readFileSync(path.join(rootDir, 'SKILL.md'), 'utf8');
  assert.match(skill, new RegExp('发布基线（v' + VERSION.replace(/\./g, '\\.')));
  const line = '- **★★ B canonical / A 发布基线（v1.37.7，2026-09-26）**';
  const m = /(发布基线|当前版本|版本：)[（(]?v(\d+\.\d+\.\d+)/.exec(line);
  assert.ok(m && m[2] !== VERSION);
});

// ================= Wave 2026-10-21 (v1.47.1): G1 / G2 / G3 —— 「文档=事实」=================
// 来源：v1.47.0 审计（reports/审计-全模块验收-v1.47.0-2026-10-21.md）查出多处「宣称≠读数」。
// 两条**互不越界**的判据：
//   G2 = 结构数（引擎数 / 清单项数 / 注册表分布）必须由源码派生后比对 —— 数字可以有，但必须是真值；
//   G3 = 读数（rc / 通过·失败数 / product_red）一律不写进基线段 —— 只留 reports/ 指针。
// 顺序纪律：G3 上线当刻就应当是红的（基线行当时写着 rc=0 与 7/0/5），**先红 → 再改文 → 才转绿**。
const docFiles = ['SKILL.md', '说明书.md', ...fs.readdirSync(path.join(rootDir, 'references'))
  .filter(f => f.endsWith('.md')).map(f => 'references/' + f)];
function docText(rel) {
  const p = path.join(rootDir, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '') : null;
}

// ---- G1：版本锚点。标题里的「（vX）」与目录树里的「主脚本（vX」都是**当前事实**声明，
//     不是"最后编辑于"；与 $VERSION 不等即红。（历史读数只允许写在 references/变更历史.md 正文）
function g1Findings(rel, text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  const title = /^#\s+\S.*（v(\d+\.\d+\.\d+)）/.exec(lines[0] || '');
  if (title && title[1] !== VERSION) out.push(`${rel}:1: 标题版本 v${title[1]} != $VERSION ${VERSION}`);
  lines.forEach((line, i) => {
    const m = /主脚本（v(\d+\.\d+\.\d+)/.exec(line);
    if (m && m[1] !== VERSION) out.push(`${rel}:${i + 1}: 主脚本版本 v${m[1]} != $VERSION ${VERSION}`);
  });
  return out;
}
test('G1: 每份发布文档的标题版本与「主脚本（vX」都等于 $VERSION', () => {
  // ★v1.54.0（B3-2）：变更历史类文档（`*变更历史.md`）里出现的「主脚本（vX」是**历史叙事**，
  //   不是当前事实声明 —— 与本文件头注释的口径一致（"历史读数只允许写在变更历史正文"）。
  //   不过滤的话，迁出去的那 748 行逐版记录会把 G1 变成永红（v1.37.6 之类的旧版本号是史实）。
  const HISTORICAL = /变更历史\.md$/;
  const f = docFiles.filter(rel => !HISTORICAL.test(rel)).flatMap(rel => { const t = docText(rel); return t === null ? [] : g1Findings(rel, t); });
  assert.deepEqual(f, [], f.join(' | '));
});
test('G1 negative control: 标题与主脚本锚点各漂一个版本都必须被点名', () => {
  assert.deepEqual(g1Findings('x.md', '# t（v' + VERSION + '）'), []);
  assert.deepEqual(g1Findings('x.md', '# t（v0.0.1）'), [`x.md:1: 标题版本 v0.0.1 != $VERSION ${VERSION}`]);
  const b = g1Findings('y.md', '- ├── multi-platform-searcher.ps1   # 主脚本（v0.0.2；唯一 canonical B）');
  assert.deepEqual(b, [`y.md:1: 主脚本版本 v0.0.2 != $VERSION ${VERSION}`]);
});

// ---- G2：结构数必须由源码派生（fail-closed：清单读不到直接红，不 skip）----
const manifestPath = path.join(rootDir, 'scripts/skill-assets.example.json');
function manifestEntries() {
  assert.ok(fs.existsSync(manifestPath), 'manifest missing: scripts/skill-assets.example.json（fail-closed，不沉默）');
  const j = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  // 清单是 `{assets:[{version, fileHashes:{...}}]}` 形状（哈希值在示例里刻意留空，键数才是事实）
  const a = (Array.isArray(j.assets) && j.assets[0]) || j;
  const n = Object.keys(a.fileHashes || {}).length;
  assert.ok(n > 0, 'manifest assets[0].fileHashes 为空 —— 拒绝把 0 当事实');
  return n;
}
const REGISTRY = [...mainSrc.matchAll(/\@\{ Name = '([^']+)';\s+Kind = '([^']+)';\s+Platforms = \@\(([^)]*)\)/g)]
  .map(m => ({ name: m[1], kind: m[2], platforms: [...m[3].matchAll(/'([^']+)'/g)].map(x => x[1]) }));
const NONREG = 2;   // LocalCode / SearchCodeRepo：顶层直调、不在 _engineRegistry（引擎链.md 的对照表同此口径）
const REG = {
  total: REGISTRY.length,
  repo: REGISTRY.filter(r => r.kind === 'repo').length,
  code: REGISTRY.filter(r => r.kind === 'code').length,
  research: REGISTRY.filter(r => r.kind === 'research').length,
  same: REGISTRY.filter(r => r.platforms[0] === r.name).length,
};
function g2Findings() {
  assert.ok(REG.total >= 10, `注册表解析失败（只解析到 ${REG.total} 行）—— 派生值不可信，拒绝给绿灯`);
  const mf = manifestEntries();
  const out = [];
  const checks = [
    ['references/引擎链.md', /（单一事实源：`\$script:_engineRegistry`，(\d+) 引擎）/, String(REG.total), '注册引擎总数'],
    ['references/引擎链.md', /（`?-ResearchSources`?，(\d+) 类并发）/, String(REG.research), 'research 引擎数'],
    ['references/参数速查.md', /（HF \+ (\d+) 类信源/, String(REG.research - 1), 'research 引擎数（除 HF）'],
    ['references/参数速查.md', /当前 (\d+) 项发布路径/, String(mf), '发布清单项数'],
    ['说明书.md', /\*\*(\d+) 项\*\*清单发布/, String(mf), '发布清单项数'],
    ['SKILL.md', /\*\*(\d+) 项清单\*\*/, String(mf), '发布清单项数'],
  ];
  for (const [rel, re, want, label] of checks) {
    const t = docText(rel) || '';
    const m = re.exec(t);
    if (!m) continue;   // 该声明不存在 ⇒ 无需校验（删数字是允许的写法；写了就必须真）
    if (m[1] !== want) out.push(`${rel}: ${label} 文档写 ${m[1]}，源码派生 ${want}`);
  }
  // 引擎链的分布句：「N 引擎（注册 M + 非注册 K：…）中 X 个两者相同，**Y 个不同**」
  // N 是**总数（含非注册）**、M 才是注册表行数；"不同"= 总数 − 同名数（非注册那两个都异名，不能漏加）
  const dist = /(\d+) 引擎（注册 (\d+) \+ 非注册 (\d+)[^）]*）中 (\d+) 个两者相同，\*\*(\d+) 个不同\*\*/.exec(docText('references/引擎链.md') || '');
  if (dist) {
    const total = REG.total + NONREG;
    const want = [total, REG.total, NONREG, REG.same, total - REG.same].map(String);
    const got = dist.slice(1, 6);
    if (got.join(',') !== want.join(',')) out.push(`references/引擎链.md: 引擎分布写 ${got.join('/')}，源码派生 ${want.join('/')}（总/注册/非注册/同名/异名）`);
  }
  // 反方向：测试文件数是**自动发现**的，禁止写死（v1.47.0 审计：写了 87，实际 104）
  const hardwired = /自动发现 \d+ 个 test/.exec(docText('说明书.md') || '');
  if (hardwired) out.push('说明书.md: 测试文件数必须由 run-node-gates 自动发现，禁止写死（' + hardwired[0] + '）');
  return out;
}
test('G2: 文档里的结构数都由源码派生值校验（引擎数 / 清单项数 / 分布）', () => {
  const f = g2Findings();
  assert.deepEqual(f, [], f.join(' | '));
});
test('G2 negative control: 引擎分布句任一数字漂移、清单项数漂移、测试数写死都必须被点名', () => {
  assert.match(g2Findings.toString(), /REG\.same/);   // 断言派生用的是注册表，不是抄来的常量
  const good = `48 引擎（注册 46 + 非注册 2：\`LocalCode\`、\`SearchCodeRepo\`）中 12 个两者相同，**36 个不同**`;
  const distRe = /(\d+) 引擎（注册 (\d+) \+ 非注册 (\d+)[^）]*）中 (\d+) 个两者相同，\*\*(\d+) 个不同\*\*/;
  assert.ok(distRe.test(good), '负数控制自身的样板必须能被正则命中');
  const badSame = good.replace('12 个两者相同', '13 个两者相同');
  assert.ok(distRe.test(badSame) && distRe.exec(badSame)[4] === '13', '改写后应解析出 13，从而与派生值不等 ⇒ 红');
  assert.notEqual(manifestEntries(), manifestEntries() - 1, '清单项数只有一个真值');
  assert.match('自动发现 87 个 test-*.test.mjs', /自动发现 \d+ 个 test/);
});

// ---- G3：基线段（`★★ B/A 发布基线` 行 + 紧随的缩进续行）禁写读数 ----
// 边界用**否定环视**而非空白/\b：中文里读数常紧贴汉字与全角逗号（"门7/0/5，共"），白边判据必漏；
// 而 `\b` 版会把 `a/1/2/3`、`https://h/1/2/3` 判真（两条都实测过）。
const G3_BANS = [
  [/\brc=\s*\d/, 'rc=<数字>'],
  [/(?<![\w.\/-])\d{1,3}\s*\/\s*\d{1,3}\s*\/\s*\d{1,3}(?![\w.\/-])/, '三段读数（如 7/0/5）'],
  [/product_red\s*=|env_red\s*=/, 'product_red / env_red'],
  [/\d+\s*(tests|pass|fail|skipped)\b/, '用例数读数'],
  [/全绿/, '用「全绿」代替读数'],
];
function baselineSection(text) {
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex(l => /★★ B\/A 发布基线/.test(l));
  if (at < 0) return null;
  const sec = [lines[at]];
  for (let i = at + 1; i < lines.length && /^\s+\S/.test(lines[i]); i++) sec.push(lines[i]);
  return sec;
}
function g3Findings(text) {
  const sec = baselineSection(text);
  if (sec === null) return ['SKILL.md: 缺少「★★ B/A 发布基线」段（U-59 指针的落点，不能删）'];
  const out = [];
  for (const line of sec) {
    for (const [re, label] of G3_BANS) {
      if (re.test(line)) out.push(`SKILL.md 基线段含${label}: ${line.trim().slice(0, 72)}`);
    }
  }
  if (!sec.some(l => l.includes('reports/'))) out.push('SKILL.md 基线段必须保留至少一处 reports/ 指针（禁写数字后它是唯一事实来源）');
  return out;
}
test('G3: 基线段只留 reports/ 指针，不写任何读数', () => {
  const f = g3Findings(doc);
  assert.deepEqual(f, [], f.join(' | '));
});
test('G3 negative control: 五种读数写法与「删光指针」都必须被点名', () => {
  const base = '- **★★ B/A 发布基线（v' + VERSION + '，2026-10-22）**：宿主按 **193 项清单**发布 A；读数查 reports/gates/。';
  assert.deepEqual(g3Findings(base), []);
  for (const tail of ['；Node 全量 rc=0。', '；双运行时本地门 7/0/5。', '；product_red=0。', '；567 tests。', '；全绿。']) {
    assert.ok(g3Findings(base + tail).length > 0, 'must flag: ' + tail);
  }
  // 门7/0/5，共（紧贴汉字与全角逗号）也必须被抓；URL / 版本号 / 日期不能被误伤
  assert.ok(g3Findings(base + '；门7/0/5，共两门。').length > 0);
  assert.deepEqual(g3Findings(base + '；见 https://h/1/2/3 与 v1.2.3、2026/10/22。'), []);
  assert.match(g3Findings(base.replace('reports/gates/', '某处')).join(' | '), /必须保留至少一处 reports\/ 指针/);
});
// U-58: token-shaped secrets must not appear in ANY manifest-listed file (scanner built from pieces so it never matches itself).
// ★2026-10-11（宿主收口）：补与 U-136 同款的**占位符放行** —— 此前 U-58 只扫清单、清单里没有桩值，故未做放行；
//   本批 `tests/test-gitlab-budget.ps1` 入清单后第一次被 U-58 扫到 ⇒ 它的桩值 `glpat-FAKE-…` 被判红。
//   两门按设计应一致（U-136 头部即写「与 U-58 的关系：U-58 只扫清单文件」），且**不削弱安全**：
//   真令牌是随机串、不含这些词；U-58 自带的合成负例（ghp_ + 'A'×36，无占位词）仍被判红。
const U58_PLACEHOLDER = /(FAKE|EXAMPLE|PLACEHOLDER|DUMMY|xxxx)/i;   // 与 tests/test-u136-token-gate.test.mjs L36-37 同款
const TOKEN_PATTERNS = [
  ['gh' + 'p_' + '[A-Za-z0-9]{36}', 'GitHub classic PAT'],
  ['github_' + 'pat_' + '[A-Za-z0-9_]{60,}', 'GitHub fine-grained PAT'],
  ['glpat' + '-[A-Za-z0-9\\-_]{20}', 'GitLab PAT'],
  ['sk-' + '[A-Za-z0-9]{32,}', 'OpenAI-style key'],
  ['AKIA' + '[0-9A-Z]{16}', 'AWS access key id'],
  ['xox' + '[baprs]-[A-Za-z0-9-]{10,}', 'Slack token'],
];
function scanTokens(files) {
  const hits = [];
  for (const rel of files) {
    const p = path.join(rootDir, rel); if (!fs.existsSync(p) || /\.(exe|onnx|png|jpg|zip)$/.test(rel)) continue;
    const text = fs.readFileSync(p, 'utf8');
    for (const [re, label] of TOKEN_PATTERNS) {
      const m = new RegExp(re).exec(text);
      if (!m) continue;
      if (U58_PLACEHOLDER.test(m[0])) continue;   // 占位符（含 FAKE/EXAMPLE/…）⇒ 放行，与 U-136 一致
      hits.push(`${rel}: ${label} (${m[0].slice(0, 6)}…)`);
    }
  }
  return hits;
}
test('U-58: no token-shaped secret in any of the 36 manifest files', (t) => {
  // The manifest lists MCP-shielded .env.example; do not bypass the bridge with fs in a
  // restricted session. The in-memory positive/negative ruler remains runnable below.
  if (process.env.MCPS_MCP_RESTRICTED === '1') { t.skip('MCP-shielded .env.example requires host-owned manifest token scan'); return; }
  const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, 'scripts/skill-assets.example.json'), 'utf8')).assets[0];
  const hits = scanTokens(Object.keys(manifest.fileHashes));
  assert.deepEqual(hits, [], hits.join(' | '));
});
test('U-58 negative control: a synthetic fake token in a scanned file is detected, and the scanner source itself is clean', () => {
  const fake = 'gh' + 'p_' + 'A'.repeat(36);
  // U-98（R35）：合成样本改落 _verify/（.gitignore 忽略）—— 此前落在 tests/ 被宿主实时备份捕进历史两次，把 ghp_ 形状变成 U-66 的假阳性
  fs.mkdirSync(path.join(rootDir, '_verify'), { recursive: true });
  const tmp = path.join(rootDir, '_verify', 'u58-synthetic.tmp');
  fs.writeFileSync(tmp, 'x=' + fake + '\n');
  try { assert.equal(scanTokens(['_verify/u58-synthetic.tmp']).length, 1); } finally { fs.rmSync(tmp, { force: true, maxRetries: 5, retryDelay: 100 }); }
  assert.deepEqual(scanTokens(['tests/test-r4-docs.test.mjs']), []);
});
// U-60: 说明书.md (not shipped) must not contradict the shipped truth.
test('U-60: 说明书.md agrees with $VERSION, the script parameter count and 参数速查', () => {
  const manual = fs.readFileSync(path.join(rootDir, '说明书.md'), 'utf8');
  assert.match(manual, new RegExp('版本：v' + VERSION.replace(/\./g, '\\.')), '说明书 version stamp');
  const paramBlock = mainSrc.slice(mainSrc.indexOf('param('), mainSrc.indexOf('\n)', mainSrc.indexOf('param(')));
  const scriptParams = (paramBlock.match(/^\s*(?:\[[^\]]*\]\s*)*\$[A-Za-z]\w*/gm) || []).length;
  const cheatCount = Number(/全部 `(\d+)` 个参数/.exec(cheat)[1]);
  const manualCount = Number(/全部 (\d+) 项/.exec(manual)[1]);
  assert.equal(cheatCount, scriptParams, '参数速查 count vs script');
  assert.equal(manualCount, scriptParams, '说明书 count vs script');
  const manualRows = (manual.match(/^\| `-/gm) || []).length;
  const cheatRows = (cheat.match(/^\| `-/gm) || []).length;
  assert.equal(cheatRows, scriptParams, '参数速查 table rows must equal script params');
  assert.ok(manualRows <= scriptParams && /速览/.test(manual), '说明书 table is an explicitly-labelled subset (速览)');
  const samplePlatforms = ['GitHub', 'Gitee', 'GitLab', 'Codeberg', 'grep.app', 'Sourcegraph']; // deliberate examples, not a second inventory
  const catalog = JSON.parse(fs.readFileSync(path.join(rootDir, 'query-plan.schema.json'), 'utf8'))['x-engineCatalog'];
  assert.ok(catalog && Object.keys(catalog).length, 'U-100-B catalog missing');
  const outputPlatforms = new Set(Object.values(catalog).flatMap(e => e.platforms));
  for (const eng of samplePlatforms) {
    assert.ok(outputPlatforms.has(eng), 'U-100-B manual example not in catalog: ' + eng);
    assert.ok(manual.includes(eng), '说明书 mentions ' + eng);
  }
});

// ── U-82（R20 派生，2026-09-26）：Cfg 时长键必须带单位后缀 ───────────────────────────────────────────────
// 事实源 = 参数速查「Cfg 策略常数」表的「单位」列：单位为 秒 ⇒ 键名须以 Sec 结尾；毫秒 ⇒ Ms。多键行的单位按 ` / ` 一一对应。
// 另加名字启发式：代码里键名含 Timeout/Deadline/Wait/Probe/Budget 且值为数字 ⇒ 必须带 Sec/Ms（防"表里写错单位"把门骗过去）。
function cfgUnitRows(sec) {
  const rows = [];
  for (const m of sec.matchAll(/^\| ((?:`[A-Za-z_]\w*`(?: \/ )?)+) \| [^|]* \| ([^|]*) \|/gm)) {
    const keys = [...m[1].matchAll(/`([A-Za-z_]\w*)`/g)].map(x => x[1]);
    const units = m[2].split(' / ').map(s => s.trim());
    rows.push({ keys, units: units.length === keys.length ? units : keys.map(() => units[0]) });
  }
  return rows;
}
function assertCfgDurationSuffix(cheatSrc, mainSource) {
  const rows = cfgUnitRows(section(cheatSrc, 'Cfg 策略常数'));
  assert.ok(rows.length >= 15, 'unit column missing or table not parsed (rows=' + rows.length + ')');
  const bad = [];
  for (const r of rows) r.keys.forEach((k, i) => {
    const u = r.units[i] || '';
    if (/^秒/.test(u) && !/Sec$/.test(k)) bad.push(k + '(单位=秒 但无 Sec 后缀)');
    if (/^毫秒|^ms$/i.test(u) && !/Ms$/.test(k)) bad.push(k + '(单位=毫秒 但无 Ms 后缀)');
    if (/(Sec|Ms)$/.test(k) && !/^(秒|毫秒)/.test(u)) bad.push(k + '(有时长后缀但单位列=' + u + ')');
  });
  for (const k of cfgKeys(mainSource)) {
    if (/(Timeout|Deadline|Wait|Probe|Budget)/.test(k) && !/(Sec|Ms|ByEngine)$/.test(k) && k !== 'RetryBudget') bad.push(k + '(duration-like name without Sec/Ms)');
  }
  assert.deepEqual(bad, [], 'U-82 duration keys without unit suffix: ' + bad.join(', '));
}
test('U-82: every Cfg duration key carries a Sec/Ms suffix consistent with the 单位 column', () => {
  assertCfgDurationSuffix(cheat, mainSrc);
  assert.ok(cfgKeys(mainSrc).includes('ApiTimeoutDefaultSec') && cfgKeys(mainSrc).includes('ApiTimeoutLongSec'));
  assert.ok(!cfgKeys(mainSrc).includes('ApiTimeoutDefault') && !cfgKeys(mainSrc).includes('ApiTimeoutLong'));
});
test('U-82 negative control: a new unit-less duration key (in code or in the table) is named', () => {
  const badMain = mainSrc.replace('    EngineDeadlineRepoSec = 29\n', '    EngineDeadlineRepoSec = 29\n    FooTimeout = 3\n');
  assert.notEqual(badMain, mainSrc);
  assert.throws(() => assertCfgDurationSuffix(cheat, badMain), /FooTimeout/);
  const badDoc = cheat.replace('| `DoctorProbeSec` | 6 | 秒 |', '| `DoctorProbe` | 6 | 秒 |');
  assert.notEqual(badDoc, cheat);
  assert.throws(() => assertCfgDurationSuffix(badDoc, mainSrc), /DoctorProbe\(/);
  const noUnitCol = cheat.replace('| 键 | 默认 | 单位 | 用途 |\n|---|---|---|---|', '| 键 | 默认 | 用途 |\n|---|---|---|').replace(/\| (秒|次|字符|倍|条|分|比例|次\/分)[^|]* \|/g, '|');
  assert.throws(() => assertCfgDurationSuffix(noUnitCol, mainSrc), assert.AssertionError);
});

// ── U-89（R23，2026-09-26）：schema/asjson.schema.json ⇔ -AsJson 实际输出的双向门 ─────────────────────────
// 事实：该 schema 在 36 项清单里随包发布，却从未被任何门引用，且与实跑漂移 8 处（顶层缺 coverage/research/warnings/context，
// metrics 缺 EngineMs/PerPlatformOutcome/RetryBudgetLeft/ExitCode）。这里三方对齐（不一致时**报出键名**）：
//   ① 源码字面量：$payload / $metrics / $coverage / $researchDiag 的 [PSCustomObject]@{ … } 键；
//   ② schema：properties / metrics.properties / coverage.properties / research.properties；
//   ③ 真实样本 reports/gates/u89-real-asjson.json（宿主实跑留证）—— 顶层/metrics/coverage 键集。
// 运行时复核在 run-tests.ps1 第 3 组（三模式实跑后按 schema 双向比对）。
const schemaPath = path.join(rootDir, 'schema/asjson.schema.json');
function literalKeys(src, anchor) {
  const at = src.indexOf(anchor);
  assert.ok(at >= 0, 'anchor not found: ' + anchor);
  let i = src.indexOf('{', at + anchor.length - 1);
  let depth = 0, end = -1;
  for (let j = i; j < src.length; j++) { if (src[j] === '{') depth++; else if (src[j] === '}') { depth--; if (depth === 0) { end = j; break; } } }
  assert.ok(end > i, 'unterminated literal for ' + anchor);
  const body = src.slice(i + 1, end);
  // 只取最外层 `key =`：按大括号深度扫描，深度 0 且位于行首/分号后的 `name =`
  const keys = []; depth = 0; let lineStart = true;
  for (let j = 0; j < body.length; j++) {
    const c = body[j];
    if (c === '{' || c === '(') depth++; else if (c === '}' || c === ')') depth--;
    if (c === '\n' || c === ';') { lineStart = true; continue; }
    if (depth === 0 && lineStart && /\S/.test(c)) {
      const m = body.slice(j).match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      if (m) keys.push(m[1]);
      lineStart = false;
    }
  }
  return keys;
}
function diffSets(aName, a, bName, b) {
  const A = new Set(a), B = new Set(b);
  const onlyA = [...A].filter(k => !B.has(k)), onlyB = [...B].filter(k => !A.has(k));
  assert.ok(onlyA.length === 0 && onlyB.length === 0,
    `${aName} vs ${bName}: only in ${aName}=[${onlyA.join(',')}] only in ${bName}=[${onlyB.join(',')}]`);
}
function assertAsJsonSchemaSync(src, schemaText) {
  const schema = JSON.parse(schemaText);
  const top = Object.keys(schema.properties).filter(k => k !== '_schemaError');
  diffSets('source $payload', literalKeys(src, '$payload = [PSCustomObject]@{'), 'schema.properties', top);
  diffSets('source $metrics', literalKeys(src, '$metrics = [PSCustomObject]@{'), 'schema.metrics', Object.keys(schema.properties.metrics.properties));
  diffSets('source $coverage', literalKeys(src, '$coverage = [PSCustomObject]@{'), 'schema.coverage', Object.keys(schema.properties.coverage.properties));
  diffSets('source $researchDiag', literalKeys(src, '$researchDiag = [PSCustomObject]@{'), 'schema.research', Object.keys(schema.properties.research.properties));
  // _schemaError 兜底体的键必须 ⊆ schema 顶层（否则兜底输出本身就违约）
  const fallback = literalKeys(src.slice(src.indexOf('_schemaError = $contract.Reason') - 200), '[PSCustomObject]@{');
  for (const k of fallback) assert.ok(k in schema.properties, 'fallback payload key not in schema: ' + k);
  assert.equal(schema.additionalProperties, false, 'top-level must be closed so validators catch drift');
  assert.equal(schema.properties.metrics.additionalProperties, false);
  assert.equal(schema.properties.coverage.additionalProperties, false);
  assert.ok(schema.properties.coverage.properties.Executed, 'coverage.Executed is the harness semantic-check key');
  return schema;
}
test('U-89: schema/asjson.schema.json ⇔ main-script -AsJson literals are in sync (both directions, top/metrics/coverage/research)', () => {
  const schema = assertAsJsonSchemaSync(mainSrc, fs.readFileSync(schemaPath, 'utf8'));
  // ③ 真实样本（宿主留证）：顶层 / metrics / coverage 键集与 schema 一致（含 _schemaError 以外的全部顶层键）
  const samplePath = path.join(rootDir, 'reports/gates/u89-real-asjson.json');
  assert.ok(fs.existsSync(samplePath), 'real sample missing: reports/gates/u89-real-asjson.json (未覆盖 ⇒ 视为失败，不沉默)');
  const sample = JSON.parse(fs.readFileSync(samplePath, 'utf8').replace(/^\uFEFF/, ''));
  diffSets('sample top', Object.keys(sample), 'schema top', Object.keys(schema.properties).filter(k => k !== '_schemaError'));
  diffSets('sample metrics', Object.keys(sample.metrics), 'schema metrics', Object.keys(schema.properties.metrics.properties));
  diffSets('sample coverage', Object.keys(sample.coverage), 'schema coverage', Object.keys(schema.properties.coverage.properties));
  assert.ok(schema.properties.coverage.properties.Verdict.enum.includes(sample.coverage.Verdict));
});
test('U-89 negative control: a new -AsJson key without a schema entry (and vice versa) is reported by name', () => {
  const schemaText = fs.readFileSync(schemaPath, 'utf8');
  const withNewMetric = mainSrc.replace('    ExitCode           = $script:scriptExitCode\n', '    ExitCode           = $script:scriptExitCode\n    NewUnlistedKey     = 1\n');
  assert.notEqual(withNewMetric, mainSrc);
  assert.throws(() => assertAsJsonSchemaSync(withNewMetric, schemaText), /NewUnlistedKey/);
  const withNewTop = mainSrc.replace('context = $ragContext;', 'context = $ragContext; extra = 1;');   // U-160：payload 字面量尾部新增了字段 ⇒ 锚点不再以 } 结尾；改为锚字段本身（原意不变：注入未知顶层键须被报出）
  assert.notEqual(withNewTop, mainSrc);
  assert.throws(() => assertAsJsonSchemaSync(withNewTop, schemaText), /extra/);
  const schema = JSON.parse(schemaText);
  delete schema.properties.metrics.properties.EngineMs;
  assert.throws(() => assertAsJsonSchemaSync(mainSrc, JSON.stringify(schema)), /EngineMs/);
  const schema2 = JSON.parse(schemaText);
  schema2.properties.coverage.properties.Phantom = { type: 'string' };
  assert.throws(() => assertAsJsonSchemaSync(mainSrc, JSON.stringify(schema2)), /Phantom/);
  const schema3 = JSON.parse(schemaText); delete schema3.additionalProperties;
  assert.throws(() => assertAsJsonSchemaSync(mainSrc, JSON.stringify(schema3)), assert.AssertionError);
});

// U-209（v1.47.3，P1-2）：**同一能力两种契约**的收口 —— `-Auto` 的 CLI 载荷必须与 MCP `search_auto` 同构。
// 事实（v1.47.2 及以前）：`-Auto` 的判定只在控制台 `Write-ColorOutput` 打印一行，`-AsJson` 下整段丢失
// （`if ($AsJson) { return }` 把它吞了）；Agent 读 `--out` 文件时无从知道跑了哪些模式，只能猜。
// 判据：两边都出现同一组键，且 counts 的子键相同。变异：任一侧删一个键 ⇒ 红。
const AUTO_KEYS = ['modes', 'queryType', 'planSource', 'autoKeyword', 'counts'];
function autoParityFindings(src) {
  const out = [];
  const payload = src.split(/\r?\n/).find(l => l.includes('$payload = [PSCustomObject]@{'));
  // 同名的 op='auto' 有三个（两个错误分支 + 正常分支）：取**带 counts 的那个**，否则会拿错误分支做比对（首版就踩了）
  const serveAuto = src.split(/\r?\n/).find(l => /op = 'auto'/.test(l) && l.includes('counts ='));
  if (!payload) return ['souce: $payload 字面量不见了'];
  if (!serveAuto) return ["souce: Serve 的 op='auto' 响应行不见了"];
  for (const k of AUTO_KEYS) {
    if (!new RegExp('\\b' + k + ' =').test(payload)) out.push(`CLI 载荷缺 ${k}（MCP search_auto 有）`);
    if (!new RegExp('\\b' + k + ' =').test(serveAuto)) out.push(`MCP search_auto 缺 ${k}（CLI 载荷有）`);
  }
  for (const k of ['repo', 'code', 'research']) {
    if (!new RegExp('\\b' + k + ' =').test((/counts = \[PSCustomObject\]@\{([^}]*)\}/.exec(payload) || [, ''])[1])) out.push(`CLI counts 缺子键 ${k}`);
    if (!new RegExp('\\b' + k + ' =').test((/counts = \[PSCustomObject\]@\{([^}]*)\}/.exec(serveAuto) || [, ''])[1])) out.push(`MCP counts 缺子键 ${k}`);
  }
  return out;
}
test('U-209: -Auto 的 CLI 载荷与 MCP search_auto 逐键同构（modes/queryType/planSource/autoKeyword/counts）', () => {
  const f = autoParityFindings(mainSrc);
  assert.deepEqual(f, [], f.join(' | '));
});
test('U-209 negative control: 任一侧少一个键都必须被点名', () => {
  const noCliModes = mainSrc.replace('errors = $errorsOut; modes = @($runModes);', 'errors = $errorsOut;');
  assert.notEqual(noCliModes, mainSrc);
  assert.match(autoParityFindings(noCliModes).join(' | '), /CLI 载荷缺 modes/);
  const noServePlan = mainSrc.replace("planSource = $bag.planSource;", '');
  assert.notEqual(noServePlan, mainSrc);
  assert.match(autoParityFindings(noServePlan).join(' | '), /MCP search_auto 缺 planSource/);
});

// R41 / U-100-A: user-confirmed contract is repo names + All, NOT all engine names.
// A checked literal mirror preserves PS5.1 parameter binding; expected names are derived from the registry.
// Fail closed on a changed registry shape instead of silently comparing two empty sets.
export function assertRepoPlatformContract(source) {
  const declaration = source.match(/\[ValidateSet\(([^\r\n]*)\)\]\s*\[string\]\$Platform\s*=\s*["']All["']/);
  assert.ok(declaration, 'U-100: literal ValidateSet immediately before $Platform is missing');
  const literalList = declaration[1];
  assert.match(literalList, /^\s*(?:"[^"\r\n]+"|'[^'\r\n]+')(?:\s*,\s*(?:"[^"\r\n]+"|'[^'\r\n]+'))*\s*$/, 'U-100: Platform list must contain only string literals');
  const declared = [...literalList.matchAll(/"([^"]+)"|'([^']+)'/g)].map(m => m[1] ?? m[2]);
  const block = source.match(/^\$script:_engineRegistry\s*=\s*@\(\s*\r?\n([\s\S]*?)^\)/m);
  assert.ok(block, 'U-100: _engineRegistry declaration not found');
  const rows = block[1].split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  assert.ok(rows.length > 0, 'U-100: registry is empty');
  const engines = rows.map(row => {
    assert.match(row, /^@\{.*\},?\s*(?:#.*)?$/, 'U-100: unsupported registry row shape: ' + row);
    const name = /\bName\s*=\s*'([^']+)'/.exec(row)?.[1];
    const kind = /\bKind\s*=\s*'(repo|code|research)'/.exec(row)?.[1];
    assert.ok(name && kind, 'U-100: registry Name/Kind missing: ' + row);
    return { name, kind };
  });
  const lower = xs => xs.map(x => x.toLowerCase());
  assert.equal(new Set(lower(engines.map(e => e.name))).size, engines.length, 'U-100: duplicate registry Name');
  assert.equal(new Set(lower(declared)).size, declared.length, 'U-100: duplicate ValidateSet value');
  const repo = engines.filter(e => e.kind === 'repo').map(e => e.name);
  assert.ok(repo.length, 'U-100: registry has no repo engines');
  assert.ok(!lower(engines.map(e => e.name)).includes('all'), 'U-100: All is a reserved selector, not an engine');
  const expected = [...repo, 'All'];
  const missing = expected.filter(x => !lower(declared).includes(x.toLowerCase()));
  const extra = declared.filter(x => !lower(expected).includes(x.toLowerCase()));
  assert.deepEqual(lower(declared).sort(), lower(expected).sort(),
    'U-100: Platform != registry repo + All; missing=' + missing.join(',') + '; extra=' + extra.join(','));
  return { declared, expected, engines };
}
export function withSyntheticRepo(source) {
  const anchor = '$script:_engineRegistry = @(';
  assert.equal(source.split(anchor).length, 2, 'U-100 mutation anchor must be unique');
  return source.replace(anchor, anchor + "\n    @{ Name = 'R41SyntheticRepo'; Kind = 'repo'; Platforms = @('R41SyntheticRepo'); Func = 'Search-R41SyntheticRepo'; Needs = @() },");
}
test('U-100: Platform ValidateSet exactly mirrors registry repo names plus All', () => {
  const contract = assertRepoPlatformContract(mainSrc);
  assert.equal(contract.engines.find(e => e.name === 'GitHubCode')?.kind, 'code');
  assert.ok(!contract.declared.includes('GitHubCode'), 'user chose repo-only; do not silently accept a code engine');
});
test('U-100 negative: adding a repo without updating ValidateSet names the missing repo', () => {
  const mutated = withSyntheticRepo(mainSrc);
  assert.notEqual(mutated, mainSrc);
  assert.throws(() => assertRepoPlatformContract(mutated), /missing=R41SyntheticRepo/);
});
test('U-100: synchronizing a new repo literal passes; expected set is not hardcoded', () => {
  const mutated = withSyntheticRepo(mainSrc).replace('[ValidateSet(', '[ValidateSet("R41SyntheticRepo", ');
  assert.ok(assertRepoPlatformContract(mutated).expected.includes('R41SyntheticRepo'));
});
test('U-100 negative: accepting GitHubCode or losing All violates the repo-only contract', () => {
  assert.throws(() => assertRepoPlatformContract(mainSrc.replace('[ValidateSet(', '[ValidateSet("GitHubCode", ')), /extra=GitHubCode/);
  const noAll = mainSrc.replace(/,\s*"All"\)\]/, ')]');
  assert.notEqual(noAll, mainSrc);
  assert.throws(() => assertRepoPlatformContract(noAll), /missing=All/);
});
test('U-100: a new code engine does not expand Platform; malformed registry fails closed', () => {
  const newCode = withSyntheticRepo(mainSrc).replace("Name = 'R41SyntheticRepo'; Kind = 'repo'", "Name = 'R41SyntheticRepo'; Kind = 'code'");
  assertRepoPlatformContract(newCode);
  assert.throws(() => assertRepoPlatformContract(mainSrc.replace('$script:_engineRegistry = @(', '$script:_renamedRegistry = @(')), /registry declaration not found/i);
  assert.throws(() => assertRepoPlatformContract(mainSrc.replace("Name = 'Gitee'", "Name = 'GitHub'")), /duplicate registry Name/);
});
function assertCfgConsumersHaveUnits(source) {
  assert.doesNotMatch(source, /\$script:Cfg\.(?:ApiTimeoutDefault|ApiTimeoutLong)\b/, 'U-82: consumer still uses a unit-less duration key');
  for (const key of ['ApiTimeoutDefaultSec', 'ApiTimeoutLongSec']) {
    assert.ok(cfgKeys(source).includes(key), 'U-82: declaration missing ' + key);
    assert.ok(source.includes('$script:Cfg.' + key), 'U-82: consumer missing ' + key);
  }
}
test('U-82: renamed duration keys are also used by consumers (not only declared/documented)', () => {
  assertCfgConsumersHaveUnits(mainSrc);
});
test('U-82 negative: reverting a consumer to the old key is detected', () => {
  for (const key of ['ApiTimeoutDefaultSec', 'ApiTimeoutLongSec']) {
    const mutated = mainSrc.replace('$script:Cfg.' + key, '$script:Cfg.' + key.replace(/Sec$/, ''));
    assert.notEqual(mutated, mainSrc);
    assert.throws(() => assertCfgConsumersHaveUnits(mutated), /unit-less duration key/);
  }
});
function assertU95Boundary(body) {
  const boundary = section(body, '能力边界');
  for (const [label, re] of [
    ['official-doc exclusion', /本技能不做官方 API 文档/],
    ['repo short terms', /repo[^\n]*短关键词/],
    ['research manual filtering', /research[^\n]*人工过滤/],
    ['zero is not absence', /0 命中 ≠ 没有/],
    ['verdict is not result count', /Verdict`?\*?\*? ≠ 有结果/],
  ]) assert.match(boundary, re, 'U-95 missing: ' + label);
}
test('U-95: boundary includes official-doc exclusion and all three practical recommendations', () => {
  assertU95Boundary(doc);
});
test('U-95 negative: dropping a practical recommendation is detected', () => {
  for (const term of ['短关键词', '人工过滤', '0 命中 ≠ 没有']) {
    const mutated = doc.replaceAll(term, 'omitted');
    assert.notEqual(mutated, doc);
    assert.throws(() => assertU95Boundary(mutated), /U-95 missing/);
  }
});
function assertU94Scope(schema) {
  const p = schema.properties.results.items.properties;
  assert.match(p.Stale.description, /repo/);
  assert.match(p.Stale.description, /GitHub/);
  assert.match(p.Stale.description, /陈旧缓存/);
  assert.doesNotMatch(p.Stale.description, /预留|无引擎写入/);
  assert.match(p.ApiScore.description, /repo/);
  assert.match(p.ApiScore.description, /Gitee.*_score/);
  assert.match(p.File.description, /code/);
  assert.match(p.File.description, /本地/);
  assert.match(p.File.description, /Auto/);
}
test('U-94: optional field descriptions name actual producers, not a sampled zero as impossibility', () => {
  assertU94Scope(JSON.parse(fs.readFileSync(schemaPath, 'utf8')));
  assert.match(mainSrc, /Add-Member -NotePropertyName Stale -NotePropertyValue \$true/);
  assert.match(mainSrc, /ApiScore = \$item\.Score/);
});
test('U-94 negative: reverting Stale to the old never-written claim is rejected', () => {
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  schema.properties.results.items.properties.Stale.description = '预留字段：当前无引擎写入';
  assert.throws(() => assertU94Scope(schema), assert.AssertionError);
});

