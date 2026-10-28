// M-15: root manifest is outside authorized bline; checked against its path list in reports/M15-清单对照.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const mirrorPath = path.join(root, 'reports/_skill-assets.root.json');
function assertManifestParity(example, mirror) {
  const examplePaths = Object.keys(example.fileHashes).sort();
  const mirrorPaths = Object.keys(mirror.fileHashes).sort();
  // 2026-09-28：去掉硬编码 36 —— 清单条目会随合法新增（如新增 LICENSE）增长，
  // 写死的数字会像"陈旧标题"一样变成假警报。改为：① 下限（防悄悄缩水）② 与镜像逐路径相等（下面一行）。
  assert.ok(examplePaths.length >= 30, `U-04/N-14/N-15 example path count too small: ${examplePaths.length}`);
  assert.deepEqual(examplePaths, mirrorPaths, 'example/mirrored root manifest paths must match (host U-05 sync required)');
  // N-14/N-15 negative control anchors: each is a hard dependency of an already-published entry.
  for (const dep of ['tests-query-planner.ps1', 'validate-query-plan.ps1', 'tests-acceptance-5triggers.ps1']) {
    assert.ok(examplePaths.includes(dep), `N-14/N-15 missing ${dep}`);
  }
}

test('example manifest matches the host-provided root manifest mirror and current script version', () => {
  const asset = JSON.parse(fs.readFileSync(path.join(root, 'scripts/skill-assets.example.json'), 'utf8')).assets[0];
  // This is a host-provided MIRROR, not proof that the live parent manifest has not changed.
  const mirror = JSON.parse(fs.readFileSync(mirrorPath, 'utf8')).assets[0];
  const script = fs.readFileSync(path.join(root, 'multi-platform-searcher.ps1'), 'utf8');
  const version = /^\$VERSION = "([0-9.]+)"$/m.exec(script)?.[1];
  assert.ok(version, 'cannot find script version');
  assert.equal(asset.version, version);
  assertManifestParity(asset, mirror);
  assert.equal(Object.values(asset.fileHashes).filter(hash => hash !== '').length, 0, 'publishing owns hash backfill');
  assert.match(JSON.stringify(asset.fileHashes), /tools\/fetch-ripgrep\.ps1/);
  // N-10 negative control: removing one path from the ROOT mirror must fail parity.
  const tampered = structuredClone(mirror);
  delete tampered.fileHashes[Object.keys(tampered.fileHashes)[0]];
  assert.throws(() => assertManifestParity(asset, tampered), assert.AssertionError);
});

// ================= Wave A (R16, 2026-09-26): U-51 / U-73 / U-46 =================
const exampleAsset = JSON.parse(fs.readFileSync(path.join(root, 'scripts/skill-assets.example.json'), 'utf8')).assets[0];
const manifestPaths = new Set(Object.keys(exampleAsset.fileHashes));
// U-51: files that gates/entries/scripts READ must be in the manifest, or explicitly registered here with a reason.
const INTENTIONALLY_UNLISTED = {
  'reports/_skill-assets.root.json': 'M-15 host-provided mirror of the parent manifest (git-ignored on purpose; regenerate via publish-skill.ps1 -RegenerateMirror)',
  'tests/test-results.log': 'runtime output of run-tests.ps1',
  '.env': 'credentials, never shipped', '.env.example': 'template only',
  'skill-assets.json': 'parent workspace manifest (outside the skill directory)',
  'search_cache.json': 'runtime cache',
  'smart-search_cache.json': 'runtime cache of the deprecated smart-project-searcher.ps1 (git-ignored, regenerated on demand)',
  // U-242（v1.53.24）跨运行源健康记忆：**运行时状态**，与 search_cache.json 同类
  //   ⇒ 已进项目 .gitignore（U-242 那行）与 publish-skill.ps1 的 $PUB_EXCLUDE_NAMES（不是漏发，是刻意不发）。
  //   为什么必须登记：B1-2 上线后本机会真实落盘它，写入点 `Get-HealthStore` 读同一个路径 ⇒ U-51 的
  //   "被脚本读取的路径"扫描从"文件不存在所以扫不到"变成"扫到了但没登记"（2026-10-25 实测报红）。
  'source-health.json': 'runtime state (cross-run source health), never shipped (U-242; PUB_EXCLUDE_NAMES + .gitignore)',
  // U-249（v1.53.26）门禁凭证：与 source-health.json **完全同类**的运行时状态。
  //   ★这里记一笔结构账（2026-10-25，同一个坑第三次踩）：一个"运行时状态文件"要在**四处**登记才不红 ——
  //     ① `.gitignore`（不入库）② `publish-skill.ps1` 的 `$PUB_EXCLUDE_NAMES`（不发布）
  //     ③ 本表（U-51 门豁免）④ 若它落在 tests/ 还要进 `tests/release-exclude.txt`（U-138 门）。
  //   四处语义确实不同（不入库 ≠ 不发布 ≠ 免门），所以不能合成一张表；但**漏一处就换一种红**，
  //   而且每次都是"补登记"而不是"设计时就想全"。这是验收报告里 EngineMeta/单一事实源那条的最强论据。
  '.gate-green.json': 'runtime state (gate credential, rewritten every run), never shipped (U-247/U-249; PUB_EXCLUDE_NAMES + .gitignore)',
  // U-291（v1.71.0）：PS 套件凭证，与 .gate-green.json 同类（四处登记的第二次实测 —— 见上面那段结构账）。
  '.ps-gate.json': 'runtime state (PS suite credential, rewritten every full run), never shipped (U-291; PUB_EXCLUDE_NAMES + .gitignore)',
  // v1.52.0：publish-skill.ps1 的 Tier1-3 排除表（$PUB_EXCLUDE_EXACT）以**字符串**列出"有意不发"的文件
  //   ⇒ 本门的引用扫描会把它们当成"被读取"。这些是本地审计工具（无 tests/脚本引用，不随发）；
  //   要随发就登记进 skill-assets.json，并从 publish-skill.ps1 的排除表移除（两处同时改，不留歧义）。
  'tools/audit/audit-analyze.py': 'local audit tooling, not shipped (publish-skill.ps1 PUB_EXCLUDE_EXACT)',
  'tools/audit/audit-driver.ps1': 'local audit tooling, not shipped (publish-skill.ps1 PUB_EXCLUDE_EXACT)',
  'tools/audit/audit-run.ps1': 'local audit tooling, not shipped (publish-skill.ps1 PUB_EXCLUDE_EXACT)',
  'tools/audit/battery.json': 'local audit tooling, not shipped (publish-skill.ps1 PUB_EXCLUDE_EXACT)',
  'tools/audit/battery.schema.json': 'local audit tooling, not shipped (publish-skill.ps1 PUB_EXCLUDE_EXACT)',
  'tools/audit/export-norm-fixture.ps1': 'local audit tooling, not shipped (publish-skill.ps1 PUB_EXCLUDE_EXACT)',
  'tools/audit/paired-variants.mjs': 'local audit tooling, not shipped (publish-skill.ps1 PUB_EXCLUDE_EXACT)',
};
const REF_RE = /(?<![\w/.-])((?:\.\.\/|\.\/)?(?:[\w.-]+\/)*[\w.-]+\.(?:ps1|mjs|md|json|py|cmd|txt))(?![\w/])/g;
function scanReferencedFiles() {
  const readers = [...manifestPaths].filter(p => /\.(ps1|mjs|py)$/.test(p) && fs.existsSync(path.join(root, p)));
  const found = new Map();
  for (const rp of readers) {
    const text = fs.readFileSync(path.join(root, rp), 'utf8');
    text.split('\n').forEach((line, i) => {
      if (/^\s*(#|\/\/)/.test(line)) return;
      for (const m of line.matchAll(REF_RE)) {
        let rel = m[1].replace(/^\.\//, '');
        // resolve '../x' written from tests/ or scripts/ back to the skill root
        while (rel.startsWith('../')) rel = rel.slice(3);
        if (!/^(tests|scripts|references|tools|evals|reports)\/|^[\w.-]+\.(ps1|mjs|md|json|py|cmd)$/.test(rel)) continue;
        if (!fs.existsSync(path.join(root, rel))) continue;
        if (!found.has(rel)) found.set(rel, `${rp}:${i + 1}`);
      }
    });
  }
  return found;
}
function guardU51(paths, unlisted) {
  const found = scanReferencedFiles();
  const violations = [];
  for (const [rel, where] of found) {
    if (paths.has(rel) || unlisted[rel] || rel.startsWith('reports/')) continue;
    violations.push(`${rel} (read at ${where})`);
  }
  return violations;
}
test('U-51: every skill file read by a gate/entry/script is in the manifest or explicitly registered as unlisted', () => {
  const v = guardU51(manifestPaths, INTENTIONALLY_UNLISTED);
  assert.deepEqual(v, [], 'read but not in manifest: ' + v.join(' | '));
});
test('U-51 negative control: removing tests-query-planner.ps1 from the manifest names the file', () => {
  const paths = new Set(manifestPaths); paths.delete('tests-query-planner.ps1');
  const v = guardU51(paths, INTENTIONALLY_UNLISTED);
  assert.ok(v.some(x => x.startsWith('tests-query-planner.ps1 (read at ')), v.join(' | '));
});
// U-73: evidence under reports/ must not be swallowed by .gitignore (except explicitly registered, with a reason).
//
// U-248b（v1.53.26，B1-4 后半）：本表原为裸 `Set`，只能回答"放不放行"，回答不了"为什么放行"。
//   2026-10-25 实测红：`reports/r4/*.log` 共 12 份被**父工作区** `.gitignore:17 (*.log)` 吞掉。
//   查清性质后决定**登记为例外而不是加进清单**：
//     · 它们是 R4 多轮调研的**运行日志**（`[lane 1] rc=0 12948ms count=0` 这种），每次跑都重写；
//     · 同一批 lane 耗时/verdict 已完整并入同目录 `report.md` §2（"每 lane 产出"表）⇒ 日志是**冗余过程输出**；
//     · 入库只会每跑一次脏一次树，而它提供不了 report.md 之外的任何事实。
//   ★**路径必须限定到具体目录**，绝不允许 `*.log` / `reports/**` 这种全域通配 ——
//     `reports/gates/**` 是真证据区，那里的 `.log` 被吞**必须照报**（负向控制里
//     `reports/gates/publish-v1.37.8.log` 就是守这条的钉子，删了它等于把门挖空）。
const IGNORE_EXCEPTIONS = new Map([
  ['reports/_skill-assets.root.json', 'M-15 父级清单镜像：故意不入库，用 publish-skill.ps1 -RegenerateMirror 再生'],
  ['reports/r4/*.log', 'R4 多轮调研的运行日志（每次跑都重写）；lane 耗时与 verdict 已并入同目录 report.md §2，日志本身无额外事实'],
]);
/** 命中例外表则返回理由（null = 不在例外表） */
function exceptionFor(rel) {
  for (const [pat, why] of IGNORE_EXCEPTIONS) {
    if (pat === rel) return why;
    if (pat.includes('*')) {
      const re = new RegExp('^' + pat.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + '$');
      if (re.test(rel)) return why;
    }
  }
  return null;
}
// The skill dir sits inside a parent workspace whose .gitignore (not visible in the container) also applies (that is how
// publish-v1.37.8.log got swallowed by a parent `*.log`). The host mirrors the parent rules into reports/gates/parent-gitignore.snapshot.txt.
function gitignoreRules() {
  const own = fs.readFileSync(path.join(root, '.gitignore'), 'utf8').split('\n').map((l, i) => ({ line: i + 1, pat: l.trim(), src: '.gitignore' }));
  const snap = path.join(root, 'reports/gates/parent-gitignore.snapshot.txt');
  const parent = fs.existsSync(snap) ? fs.readFileSync(snap, 'utf8').split('\n').map((l, i) => ({ line: i + 1, pat: l.trim(), src: 'parent' })) : [];
  return [...own, ...parent].filter(r => r.pat && !r.pat.startsWith('#') && !r.pat.startsWith('!'));
}
function globToRe(pat) {
  let p = pat.replace(/^\//, '');
  const anchored = pat.startsWith('/') || p.includes('/');
  const dirOnly = p.endsWith('/'); if (dirOnly) p = p.slice(0, -1);
  const re = p.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*');
  return { re: new RegExp((anchored ? '^' : '(^|/)') + re + (dirOnly ? '(/|$)' : '$')), dirOnly };
}
function ignoredBy(rel) {
  for (const r of gitignoreRules()) {
    const { re, dirOnly } = globToRe(r.pat);
    const parts = rel.split('/');
    if (dirOnly) { if (parts.slice(0, -1).some((_, i) => re.test(parts.slice(0, i + 1).join('/')))) return r; continue; }
    if (re.test(rel) || re.test(parts[parts.length - 1])) return r;
    if (!r.pat.includes('/') && parts.slice(0, -1).some(seg => re.test(seg))) return r;
  }
  return null;
}
function walk(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]); }
function guardU73(files) {
  const bad = [];
  for (const abs of files) {
    const rel = path.relative(root, abs).split(path.sep).join('/');
    if (exceptionFor(rel)) continue;
    const r = ignoredBy(rel);
    if (r) bad.push(`${rel} <- ${r.src === 'parent' ? 'parent-gitignore' : '.gitignore'}:${r.line} (${r.pat})`);
  }
  return bad;
}
test('U-73: no evidence file under reports/ is swallowed by .gitignore (only registered exceptions may be)', () => {
  const bad = guardU73(walk(path.join(root, 'reports')));
  assert.deepEqual(bad, [], bad.join(' | '));
});
test('U-73a: every ignore-exception is really matched by some rule, and carries a non-trivial reason (stale entries must go)', () => {
  const stale = [];
  for (const [pat, why] of IGNORE_EXCEPTIONS) {
    // 用一条示例路径问 ignoredBy：不依赖文件当前是否存在（r4 是活目录，随时可能被清）
    const probe = pat.replace('*', 'probe');
    if (!ignoredBy(probe)) stale.push(`${pat}: 没有任何 gitignore 规则命中它（例外已失效，删掉这条）`);
    if (!why || why.length < 12) stale.push(`${pat}: 理由缺失/过短（必须说明"为什么它不该入库"）`);
  }
  assert.deepEqual(stale, [], stale.join(' | '));
});
test('U-73b: exceptions must be path-scoped — a bare `*.log` / `reports/**` would hollow the gate out', () => {
  const loose = [...IGNORE_EXCEPTIONS.keys()].filter(p => !p.includes('/'));   // 无目录段 ⇒ 全域通配
  assert.deepEqual(loose, [], '例外必须限定到具体目录（如 reports/r4/*.log），不得用 *.log 这类全域通配: ' + loose.join(', '));
  // 钉子：真证据区（reports/gates）的 .log 不得被任何例外覆盖
  assert.equal(exceptionFor('reports/gates/publish-v1.37.8.log'), null, 'reports/gates 下的 .log 绝不能被例外放行');
});
test('U-73 negative control: a _-prefixed .txt (own rules) and, when the parent snapshot exists, a .log are reported with the rule line', () => {
  const bad = guardU73([path.join(root, 'reports/_evidence.txt')]);
  assert.equal(bad.length, 1, bad.join(' | '));
  assert.match(bad[0], /_evidence\.txt <- \.gitignore:\d+ \(_\*\.txt\)/);
  if (fs.existsSync(path.join(root, 'reports/gates/parent-gitignore.snapshot.txt'))) {
    const log = guardU73([path.join(root, 'reports/gates/publish-v1.37.8.log')]);
    assert.ok(log.length === 1 && /\.log <- parent-gitignore:\d+ \(\*\.log\)/.test(log[0]), 'parent *.log rule must be detected: ' + log.join(' | '));
  }
});
// U-46: the example manifest path set must be DERIVED from the mirror; publish-skill.ps1 must be able to regenerate the mirror.
// U-75 (N-23): JS twin of publish-skill.ps1's Sync-FileHashesBlock — in-place rewrite of the fileHashes block only; must be idempotent.
function syncFileHashesBlock(text, paths, nl) {
  const m = /("fileHashes"\s*:\s*\{)([\s\S]*?)(\r?\n)([ \t]*)\}/.exec(text);
  if (!m) throw new Error('fileHashes block not found');
  const body = m[2];
  const existing = [...body.matchAll(/"((?:[^"\\]|\\.)*)"\s*:\s*"[^"]*"/g)].map(x => x[1]);
  const indent = (/^([ \t]+)"/m.exec(body) || [null, m[4] + '  '])[1];
  const ordered = [];
  for (const k of existing) if (paths.includes(k) && !ordered.includes(k)) ordered.push(k);
  for (const k of paths) if (!ordered.includes(k)) ordered.push(k);
  const newBody = nl + ordered.map(k => `${indent}"${k}": ""`).join(',' + nl);
  const start = m.index + m[1].length;
  return text.slice(0, start) + newBody + text.slice(start + body.length);
}
test('U-75: in-place example sync is a no-op when path sets match, is idempotent, and never touches bytes outside the fileHashes block', () => {
  const examplePath = path.join(root, 'scripts/skill-assets.example.json');
  const text = fs.readFileSync(examplePath, 'utf8');
  const mirror = JSON.parse(fs.readFileSync(mirrorPath, 'utf8')).assets[0];
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const once = syncFileHashesBlock(text, Object.keys(mirror.fileHashes), nl);
  assert.equal(once, text, 'sync must be a zero-diff no-op when the path sets already match');
  const twice = syncFileHashesBlock(once, Object.keys(mirror.fileHashes), nl);
  assert.equal(twice, once, 'idempotent');
  // simulate a mirror with one extra path: only the block changes, _comment stays where it is, no \u003c escapes appear
  const plus = syncFileHashesBlock(text, [...Object.keys(mirror.fileHashes), 'tests/new-gate.test.mjs'], nl);
  assert.notEqual(plus, text);
  assert.equal(plus.indexOf('"_comment"') > plus.indexOf('"fileHashes"'), text.indexOf('"_comment"') > text.indexOf('"fileHashes"'), '_comment position preserved');
  assert.doesNotMatch(plus, /\\u003c|\\u003e/);
  assert.equal(plus.replace(/"fileHashes"[\s\S]*?\n\s*\}/, '').length, text.replace(/"fileHashes"[\s\S]*?\n\s*\}/, '').length, 'bytes outside the block unchanged');
  assert.match(plus, /"tests\/new-gate\.test\.mjs": ""/);
  // the PowerShell twin must self-check idempotency (exit 3 on mismatch) and must not use ConvertTo-Json for the example
  const pub = fs.readFileSync(path.join(root, 'scripts/publish-skill.ps1'), 'utf8');
  // v1.52.0：幂等自检随 Sync-ExamplePathSet 抽成函数（发布收口会在哈希前调用它）⇒ 断言范围从"开关块"改到"函数体"。
  //   注意锚定到函数的**结束**（下一个顶层 function），不要用 SwitchExample 块 —— 那里现在只有调用。
  const fnStart = pub.indexOf('function Sync-ExamplePathSet');
  assert.ok(fnStart > 0, 'Sync-ExamplePathSet function missing');
  //   ★按花括号配平取函数体（下一个顶层 function 会把后面的清单回写段也圈进来 —— 那里合法地有 ConvertTo-Json，会假红）
  let depth = 0, syncBlock = '';
  for (let j = fnStart; j < pub.length; j++) {
    if (pub[j] === '{') depth++;
    else if (pub[j] === '}') { depth--; if (depth === 0) { syncBlock = pub.slice(fnStart, j + 1); break; } }
  }
  assert.ok(syncBlock, 'Sync-ExamplePathSet body must be balanced');
  assert.match(syncBlock, /\$pass1 -ne \$pass2/);
  assert.doesNotMatch(syncBlock.split('\n').filter(l => !/^\s*#/.test(l)).join('\n'), /ConvertTo-Json/, 'example must not be re-serialized (comments excluded)');
});
test('U-75: example _comment version prefix tracks the asset version (both live in the same file)', () => {
  const ex = JSON.parse(fs.readFileSync(path.join(root, 'scripts/skill-assets.example.json'), 'utf8'));
  const v = ex.assets[0].version;
  assert.match(String(ex._comment), new RegExp('^v' + v.replace(/\./g, '\\.') + '[（(]'), '_comment must start with v' + v);
});
test('U-46: example manifest path set equals the mirror and publish-skill.ps1 offers -RegenerateMirror / -SyncExampleFromMirror', () => {
  const mirror = JSON.parse(fs.readFileSync(mirrorPath, 'utf8')).assets[0];
  assert.deepEqual([...manifestPaths].sort(), Object.keys(mirror.fileHashes).sort());
  const pub = fs.readFileSync(path.join(root, 'scripts/publish-skill.ps1'), 'utf8');
  assert.match(pub, /\[switch\]\$RegenerateMirror/);
  assert.match(pub, /\[switch\]\$SyncExampleFromMirror/);
  assert.match(pub, /reports[\\/'"+ ]*_skill-assets\.root\.json/);
});

test('U-290: 清单里不得有临时物；发布器把这条写成排除规则（调试脚本长得像资产）', () => {
  // 病灶（2026-10-27 实测）：`-RegisterMissing` 收的是"符合收录形态的新文件"，而**自己刚写的调试脚本完全符合**。
  //   `.tmp-seam.mjs`（B3-15 的临时验证脚本）就这样进了清单、发到 A；而根级文件**不在退役规则**里
  //   （U-279 刻意只碰受管目录）⇒ 它会永久留在安装副本里，且没人会想到去删。
  const isTemp = (p) => /(^|\/)(\.tmp|tmp-)/.test(p) || /\.bak-/.test(p) || /\.tmp\./.test(p);
  const bad = [...manifestPaths].filter(isTemp);
  assert.deepEqual(bad, [], '清单里出现临时物（调试脚本不该当资产发出去）：' + bad.join(', '));
  const pub = fs.readFileSync(path.join(root, 'scripts/publish-skill.ps1'), 'utf8');
  assert.match(pub, /-like '\.tmp\*'/, '发布器的候选过滤必须显式排除 .tmp*（否则下一次 -RegisterMissing 又会收进来）');
  // 负控：同一个判据必须能认出真实临时名，否则正则写错也会"全绿"。
  assert.equal(isTemp('.tmp-seam.mjs'), true);
  assert.equal(isTemp('tests/behavior/planner.test.mjs'), false);
});
