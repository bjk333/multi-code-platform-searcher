// U-136（2026-09-29，宿主 R75/R77 请求）：令牌门禁门 —— 仓库内**任何**文本文件（不限清单，排除 _verify/_archive/node_modules/.git 与本门自身）出现「provider 前缀 + 真值形态」即红。
// 与 U-58 的关系：U-58 只扫清单文件；U-136 把网撒到整个仓（reports/**、references/**、tests/** 等）。模式由片段拼接，避免自匹配。
//
// v1.77.0（本轮全量跑抓到的真缺陷）：扫描面**不该包含运行期产物**。
//   实证：`search_cache.json`（.gitignore 第 11 行，既不进库也不进清单）里出现了 `AKIA` + 16 位的
//   「公开 S3 预签名 URL 里的 access key id」（Stack Exchange 一条 SQL dump 结果、2021 年的 snort 手册 PDF，
//   只有 id、没有 secret）。它是**检索结果的正文**，不是我们的凭据；
//   而这个文件是"今天这次活网检索"写出来的 ⇒ 同一份源码，昨天绿、今天红，取决于网上回了什么。
//   那是把外部输入当成了本仓的判据（"门不得被新敏感源污染"）。
//   ★注意：本文件里**不许**出现那条 20 字符的全长值 —— 上面「自己不许匹配到自己」那条负例就是钉这个的。
//   现改为：扫描面 = 仓内文件 **减去 `.gitignore` 宣告的运行期产物**；`.gitignore` 缺失时**一条规则都不跳过**（fail-closed）。
//   防"用 .gitignore 把源文件扫出视野"：U-136-B 钉死 MUST_SCAN 名单，并证明"删掉那条规则 ⇒ 该文件重新进入扫描面"。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = 'tests/test-u136-token-gate.test.mjs';
/** 这些文件无论 .gitignore 怎么写都必须留在扫描面里（否则"跳过运行期产物"就成了缩小扫描面的后门） */
const MUST_SCAN = ['SKILL.md', 'multi-platform-searcher.ps1', 'mcps.py', 'references/参数速查.md', 'lib/http.ps1', SELF];
const SHAPES = [
  ['GitHub classic PAT', 'gh' + '[pousr]_' + '[A-Za-z0-9]{36}'],
  ['GitHub fine-grained PAT', 'github' + '_pat_' + '[A-Za-z0-9_]{22,}'],
  ['GitLab PAT', 'glpat' + '-' + '[A-Za-z0-9\\-_]{20}'],
  ['Sourcegraph token', 'sgp' + '_' + '[A-Za-z0-9_]{20,}'],
  ['HuggingFace token', 'hf' + '_' + '[A-Za-z0-9]{30,}'],
  ['npm token', 'npm' + '_' + '[A-Za-z0-9]{36}'],
  ['Slack token', 'xox' + '[baprs]-' + '[A-Za-z0-9-]{10,}'],
  ['AWS access key', 'AKIA' + '[0-9A-Z]{16}'],
  ['OpenAI key', 'sk-' + '[A-Za-z0-9]{32,}'],
].map(([n, s]) => [n, new RegExp(s, 'g')]);
const EXTS = ['.ps1', '.psm1', '.psd1', '.md', '.json', '.mjs', '.js', '.py', '.txt', '.yml', '.yaml', '.sh', '.cmd', '.bat', '.ini', '.log', '.example'];

/** `.gitignore` 的**子集**语义：本仓实际只用得到这几种形态 —— 注释/空行、`!` 反向、目录结尾 `/`、
 *  无斜杠 ⇒ 只比 basename（glob），有斜杠 ⇒ 比相对路径（glob）。**后出现的规则覆盖前面的**（git 的规则）。
 *  刻意不实现 `**` 与字符类：真出现那些形态时，下面的 U-136-B 会因为"没被认出来"而红，不会静默放过。 */
export function ignoredBy(rel, lines) {
  let ignored = false;
  for (const raw of lines) {
    const line = String(raw).trim();
    if (!line || line.startsWith('#')) continue;
    const neg = line.startsWith('!');
    const pat = (neg ? line.slice(1) : line).replace(/^\/+/, '').replace(/\/+$/, '');
    if (!pat) continue;
    const segs = rel.split('/');
    const re = new RegExp('^' + pat.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + '$');
    const hit = pat.includes('/')
      ? re.test(rel)
      : re.test(segs[segs.length - 1]) || segs.slice(0, -1).some((d) => re.test(d));
    if (hit) ignored = !neg;
  }
  return ignored;
}

/** 读 `.gitignore`。**读不到就返回空规则集** ⇒ 一个文件都不跳过（fail-closed；沙盒里没有 .gitignore 时仍是老行为）。 */
export function readIgnoreLines(rootDir) {
  try { return fs.readFileSync(path.join(rootDir, '.gitignore'), 'utf8').split(/\r?\n/); } catch { return []; }
}

export function listRepoTextFiles(rootDir, ignoreLines = []) {
  const out = [];
  (function walk(rel) {
    for (const ent of fs.readdirSync(path.join(rootDir, rel), { withFileTypes: true })) {
      const r = rel ? rel + '/' + ent.name : ent.name;
      if (ent.isDirectory()) { if (!['_verify', '_archive', 'node_modules', '.git'].includes(ent.name)) walk(r); continue; }
      if (r === SELF) continue;
      if (ignoreLines.length && ignoredBy(r, ignoreLines)) continue;
      if (EXTS.some(e => ent.name.toLowerCase().endsWith(e))) out.push(r);
    }
  })('');
  return out.sort();
}
// 占位符放行：值体内含 FAKE/EXAMPLE/PLACEHOLDER/DUMMY/xxxx（真令牌为随机串，不含这些词）⇒ 记为 placeholder 只打印，不判红
const PLACEHOLDER = /(FAKE|EXAMPLE|PLACEHOLDER|DUMMY|xxxx)/i;
export function scanFiles(rootDir, files, placeholders = null) {
  const hits = [];
  for (const f of files) {
    let s; try { s = fs.readFileSync(path.join(rootDir, f), 'utf8'); } catch { continue; }
    for (const [name, re] of SHAPES) { re.lastIndex = 0; let m; while ((m = re.exec(s))) { const tag = `${f}: ${name} (${m[0].slice(0, 6)}…len=${m[0].length})`; if (PLACEHOLDER.test(m[0]) && placeholders) placeholders.push(tag); else hits.push(tag); } }
  }
  return hits;
}
test('U-136: no provider-prefixed real-shaped token anywhere in the repository text files (beyond the manifest scope of U-58)', (t) => {
  // A complete scan would open MCP-shielded .env.example / credential-named fixtures.
  // Restricted sessions must SKIP, not route around the bridge or report a false clean count.
  if (process.env.MCPS_MCP_RESTRICTED === '1') { t.skip('MCP-shielded files require host-owned full-text token scan'); return; }
  const ignoreLines = readIgnoreLines(root);
  const files = listRepoTextFiles(root, ignoreLines);
  assert.ok(files.length > 100, 'scanner must see the whole repo, saw ' + files.length);
  assert.ok(files.some(f => f.startsWith('reports/')) && files.some(f => f.startsWith('references/')), 'reports/ and references/ must be in scope');
  // 跳过面**点名打印**（不静默）：哪些运行期产物被 .gitignore 挡在扫描面外，一眼能看见
  const skipped = listRepoTextFiles(root, []).filter(f => !files.includes(f));
  // 源文件一个都不许被"排除"掉 —— 否则跳过机制就成了缩小扫描面的后门
  for (const f of MUST_SCAN) assert.equal(ignoredBy(f, ignoreLines), false, `.gitignore 把源文件 ${f} 排除了 —— 扫描面被悄悄缩小`);
  const placeholders = [];
  const hits = scanFiles(root, files, placeholders);
  console.error(`[U-136] scanned=${files.length} skipped(runtime)=${skipped.length}${skipped.length ? ' [' + skipped.join(' | ') + ']' : ''} hits=${hits.length} placeholders=${placeholders.length}${placeholders.length ? ' [' + placeholders.join(' | ') + ']' : ''}`);
  assert.deepEqual(hits, [], 'token-shaped values found: ' + hits.join(' | '));
});

test('U-136-B: 运行期产物按 .gitignore 跳过，源文件不许被跳过（双向 + 变异）', (t) => {
  if (process.env.MCPS_MCP_RESTRICTED === '1') { t.skip('MCP-shielded files require host-owned full-text token scan'); return; }
  const L = readIgnoreLines(root);
  assert.ok(L.length > 10, '没读到 .gitignore 规则（跳过面会退回全扫 = fail-closed，但这条用例也就空转了）');
  // ① 真仓里踩过雷的那个运行期产物必须被判为"不扫"
  assert.equal(ignoredBy('search_cache.json', L), true, '.gitignore 少了 search_cache.json ⇒ 缓存重新进入扫描面，下一次活网检索就可能把门弄红');
  assert.equal(ignoredBy('source-health.json', L), true);
  assert.equal(ignoredBy('.gate-green.json', L), true);
  // ② 删掉那条规则 ⇒ 它必须**重新**进入扫描面（证明"跳过"不是写死在代码里）
  const without = L.filter((x) => !/^search_cache\.json\s*$/.test(x));
  assert.equal(without.length, L.length - 1, '没删到那条规则，变异无效');
  assert.equal(ignoredBy('search_cache.json', without), false, '规则删了却还在跳过 ⇒ 跳过面与 .gitignore 已经脱钩');
  // ③ 源文件必须一个都跳不过去；把 tests/ 塞进 .gitignore ⇒ 立刻被认出来（反向守卫不是空的）
  for (const f of MUST_SCAN) assert.equal(ignoredBy(f, L), false, `.gitignore 把源文件 ${f} 排除了`);
  assert.equal(ignoredBy('tests/test-u136-token-gate.test.mjs', [...L, 'tests/']), true, '整目录被 ignore 却没认出来');
  // ④ 端到端：真仓扫描面里不含运行期产物，且没有被跳空
  const files = listRepoTextFiles(root, L);
  assert.ok(!files.includes('search_cache.json'), 'search_cache.json 仍在扫描面里');
  assert.ok(files.length > 100, '跳过之后扫描面只剩 ' + files.length + ' 个文件');
  // ⑤ 没被声明排除的文件仍要照扫（跳过的只该是"写过规则"的那些）
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'u136b-'));
  try {
    fs.writeFileSync(path.join(sb, 'leak.json'), '{"k":"' + 'AKIA' + 'Z'.repeat(16) + '"}');
    assert.equal(scanFiles(sb, ['leak.json']).length, 1, '未声明的文件必须照扫');
  } finally { fs.rmSync(sb, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
test('U-136 negative control: synthetic tokens of each shape in a sandbox file are detected, and the scanner never matches itself', () => {
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'u136-'));
  try {
    const fake = ['gh' + 'p_' + 'A'.repeat(36), 'github' + '_pat_' + 'B'.repeat(24), 'glpat' + '-' + 'C'.repeat(20), 'sgp' + '_' + 'D'.repeat(20),
      'hf' + '_' + 'E'.repeat(30), 'npm' + '_' + 'F'.repeat(36), 'xox' + 'b-' + '1234567890ab', 'AKIA' + 'G'.repeat(16), 'sk-' + 'H'.repeat(32)];
    fs.writeFileSync(path.join(sb, 'leak.md'), fake.join('\n'));
    const hits = scanFiles(sb, ['leak.md']);
    assert.equal(hits.length, SHAPES.length, hits.join(' | '));
    assert.deepEqual(scanFiles(root, [SELF]), [], 'scanner source must not match its own pieces');
    // 占位符只在显式传入收集器时放行；FAKE 串必须被识别为 placeholder 而非漏掉
    fs.writeFileSync(path.join(sb, 'doc.md'), 'PRIVATE-TOKEN: glpat' + '-FAKE' + 'x'.repeat(16));
    const ph = []; assert.deepEqual(scanFiles(sb, ['doc.md'], ph), []); assert.equal(ph.length, 1);
    assert.equal(scanFiles(sb, ['doc.md']).length, 1, 'without a collector a placeholder is still a hit');
  } finally { fs.rmSync(sb, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
