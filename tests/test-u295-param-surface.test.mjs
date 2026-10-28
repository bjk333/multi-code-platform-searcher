// U-295（v1.75.0，全量验收后续）：**参数的"集合"口径** —— 旧判据只比计数，改名与对换全能混过。
//
// 病灶（实证，不是假想）：
//   `test-docs` 9d 与 Node 侧 U-60 量的都是「参数速查声明的个数 == param 块实际个数」。
//   计数相等挡不住下面三种改动，而它们每一种都会让**文档与产品说的不是同一套参数**：
//     ① 文档把 `-UseRegexp` 写成 `-UseRegex`（个数不变 ⇒ 旧判据全绿，用户照着写就是参数错误）
//     ② 删掉一行、再补一行不存在的参数（个数不变、两向都错）
//     ③ 代码里加一条新开关却不登记（个数变了才被发现；若同一批里删掉一条，又看不见）
//   Cfg 键（U-54）早就是集合口径 —— 同一类不变量在参数上一直是计数口径，这是强度不一致，不是风格问题。
//
// 本门分五层：
//   A 真仓集合相等 + **与 PS 侧独立取样一致**（两处实现不许漂移）
//   A-neg 三条可执行变异：每条都构造成"计数相等但集合不等"，旧口径必绿、新口径必红
//   B 死参数：声明的每个参数在实现体（主脚本 param 块之后 + lib/ + engines/）至少被读一次
//   C 接线：9d 真的调用这个纯函数，且带两向自检；旧计数话术不得残留
//   D 跨实现等价：同一批合成输入喂 JS 与 PS 两边，逐条判定必须相同；再把 PS 侧的差集判据反向变异，两边必须分歧
//
//   E 层（v1.76.0）：参数面还有**第三份拷贝** —— MCP 包装层。`mcps.py` 的 `MCP_TOOL_OPS` 白名单、
//     各工具 `inputSchema.properties`、以及 `build_tool_request` 里三张**硬编码类型表**（int/str/bool），
//     与 PS 侧 `-Serve` 里 `$req.<key>` 的读取集是四个必须对齐的集合。
//     最危险的一格：往白名单加一个键、却忘了把它加进类型表 —— 白名单校验会放行，`req` 里却没有它，
//     **MCP 客户端传了等于没传，且不报错**（就是 F8 那个"静默丢弃"在 MCP 层重演）。
//     所以 E 层不只比文本，还要**真跑 `build_tool_request`**。
//
//   F 层（v1.77.0）：还有**第四份拷贝** —— 文档里那张「接受参数（白名单，多一个就 -32602）」的表。
//     它自称权威却从没有门读过：只列 4 个工具、少 6 个键，而 SKILL.md 的同一张表是全的。
//     F 层把表读回来与 `MCP_TOOL_OPS` 比"工具 / op / 键"三项，并给四条文档变异（少键 / 编键 / 缺工具 / op 改名）。
//
//   H 层（v1.79.0）：`additionalProperties: false` 也只被 MCP 层执行 —— `-Serve` 按分支逐个取 `$req.<key>`、
//     其余键**静默丢弃**。于是 `{"op":"repo","keyword":"x","minStar":5}`（少一个 s）会安静地按默认
//     minStars=100 检索、返回 0 条且无告警（与 v1.74.0 的「拼错的开关」同类，只是发生在 JSON 层）。
//     H1 把 PS 侧那张白名单（`Get-ServeKeyPolicy`，第五份拷贝）与 `MCP_TOOL_OPS` **逐 op 两向**对账；
//     H2 **真起 `-Serve`** 喂三行（未知键 / 合规 / 拼错键），要求"拒 + 点名 + 回显 allowed"，
//     且"合规那行必须过"（否则"永远拒"也能满足前两条），拼错那行还要求 `ms` 极小（证明没触网）。
//   H3（v1.80.0）：**键名大小写**。白名单曾用 `-notcontains`（大小写不敏感）⇒ 同一个 `MinStars`，
//     mcps.py 判 "unexpected arguments"、`-Serve` 却放行（PS 属性读取也不敏感 ⇒ 值真的被用上）。
//     现 PS 侧 `-cnotcontains` 逐字匹配；H3 要求两层对同一批变体**同判**，并给"全小写必须一条都不报"的阴性对照。
//
// gate-profile: installed —— 只读随包发货的文件（入口 / 参数速查 / mcps.py / run-tests.ps1 / u295 harness）+ 临时目录。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runPwsh } from './r2-ps-run.mjs';
import { PY } from './lib/interp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(ROOT, 'multi-platform-searcher.ps1');
const DOC_PATH = path.join(ROOT, 'references', '参数速查.md');
const RUN_TESTS_PATH = path.join(ROOT, 'tests', 'run-tests.ps1');
const HARNESS = path.join(ROOT, 'tests', 'u295-param-truth.ps1');

const RUN_TESTS = fs.readFileSync(RUN_TESTS_PATH, 'utf8');
const DOC = fs.readFileSync(DOC_PATH, 'utf8');
const ENTRY_SRC = fs.readFileSync(ENTRY, 'utf8');

// ---------- 取样（与 9d 同口径，但**独立实现**：取样一旦不一致，A 层的等价断言会立刻炸） ----------
/** param 块里的声明名。锚行首 `param(` —— 头部散文里的 "param()" 字样不是声明（v1.74.0 踩过）。 */
function declaredOf(src) {
  const start = src.search(/^param\(/m);
  assert.notEqual(start, -1, '找不到行首 param( —— 入口参数块形状变了');
  const end = src.indexOf('\n)\n', start);
  assert.ok(end > start, '找不到 param 块的结束行（孤立的 `)`）');
  const block = src.slice(start, end);
  return [...block.matchAll(/^\s*\[[^\]\n]+\]\s*\$([A-Za-z_][A-Za-z0-9_]*)/gm)].map((m) => m[1]);
}
/** 参数速查「参数」表首列。只认 `| \`-Name\` |` 这种行，散文里的开关名不算登记。 */
function documentedOf(md) {
  return [...md.matchAll(/^\|\s*`-([A-Za-z0-9]+)`/gm)].map((m) => m[1]);
}
/** 集合判据本体（JS 侧）。语义与 PS 的 Compare-ParamSurface 必须逐字对应。 */
function compare(declared, documented) {
  const d = new Set(declared);
  const o = new Set(documented);
  const missing = [...d].filter((x) => !o.has(x));  // 代码有、文档没登记
  const extra = [...o].filter((x) => !d.has(x));    // 文档登记了、代码没有
  return { ok: missing.length === 0 && extra.length === 0, missing, extra, declared: d.size, documented: o.size };
}

const realDeclared = declaredOf(ENTRY_SRC);
const realDocumented = documentedOf(DOC);
/** `-Serve` 里被读取的请求键（入口文件内的 `$req.<key>`；注释里没有这种写法，见下） */
const ENTRY_REQ_KEYS = new Set([...ENTRY_SRC.matchAll(/\$req\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]));

// ---------- A ----------
test('U-295-A: param 块与参数速查表格是同一个集合（双向），且与 PS 侧独立取样一致', async () => {
  const js = compare(realDeclared, realDocumented);
  assert.deepEqual(js.missing, [], '代码里有、参数速查没登记：' + js.missing.join(','));
  assert.deepEqual(js.extra, [], '参数速查登记了、代码里没有：' + js.extra.join(','));
  // 防"两边都抽到空集也算相等"：真仓至少 40 个参数、且无重名（重名会让集合口径悄悄变小）
  assert.ok(js.declared >= 40, `只抽到 ${js.declared} 个声明，取样正则可能失效`);
  assert.equal(realDeclared.length, js.declared, 'param 块里有重复声明（Sort/Set 把它吃掉了一个）');
  assert.equal(realDocumented.length, js.documented, '参数速查表格里有重复行');

  const r = await runPwsh(['-File', HARNESS], { timeoutMs: 180000 });
  assert.equal(r.status, 0, `harness rc=${r.status}: ${(r.stderr || '').slice(-500)}`);
  const line = (r.stdout || '').split(/\r?\n/).filter((l) => l.trim().startsWith('{"ok"')).pop();
  assert.ok(line, `harness 未输出 JSON：${(r.stdout || '').slice(-300)}`);
  const { real } = JSON.parse(line);
  assert.equal(real.ok, true, `PS 侧判定不一致：missing=[${real.missing}] extra=[${real.extra}]`);
  // 独立取样一致：两侧对"声明集合/文档集合"必须给出同一份名字表（顺序无关）
  assert.deepEqual([...real.declaredNames].sort(), [...new Set(realDeclared)].sort(), 'PS 与 JS 抽到的**声明**集合不同');
  assert.deepEqual([...real.documentedNames].sort(), [...new Set(realDocumented)].sort(), 'PS 与 JS 抽到的**文档**集合不同');
});

// ---------- A-neg ----------
test('U-295-A-neg: 三条"计数相等但集合不等"的变异，旧口径必绿、新口径必红', () => {
  const base = compare(realDeclared, realDocumented);

  // ① 文档里把一个名字改错（个数不变）
  const renamedDoc = DOC.replace(/^\|\s*`-UseRegexp`/m, '| `-UseRegex`');
  assert.notEqual(renamedDoc, DOC, '变异①未生效（锚点漂了）');
  const m1 = compare(realDeclared, documentedOf(renamedDoc));
  assert.equal(documentedOf(renamedDoc).length, realDocumented.length, '变异①意外改变了行数 —— 那就不是"计数看不见"的场景了');
  assert.deepEqual(m1.missing, ['UseRegexp'], '改名后没报出"代码有文档缺"');
  assert.deepEqual(m1.extra, ['UseRegex'], '改名后没报出"文档有代码缺"');
  assert.equal(m1.ok, false);

  // ② 删一行、补一行不存在的参数（行数完全不变）
  const swappedDoc = DOC.replace(/^\|\s*`-UseRegexp`[^\n]*$/m, '| `-BrandNewKnob` | switch | 关 | 只有文档里有。 |');
  assert.notEqual(swappedDoc, DOC, '变异②未生效');
  const m2 = compare(realDeclared, documentedOf(swappedDoc));
  assert.equal(documentedOf(swappedDoc).length, realDocumented.length, '变异②行数变了');
  assert.deepEqual(m2.missing, ['UseRegexp']);
  assert.deepEqual(m2.extra, ['BrandNewKnob']);
  assert.equal(m2.ok, false, '删一行补一行居然判绿 ⇒ 判据仍是计数口径');

  // ③ 代码里加一条新开关却不登记（真实风险：发了开关，文档没有）
  const addedSrc = ENTRY_SRC.replace(/^param\(\n/m, 'param(\n    [switch]$BrandNewKnob,\n');
  assert.notEqual(addedSrc, ENTRY_SRC, '变异③未生效');
  const m3 = compare(declaredOf(addedSrc), realDocumented);
  assert.deepEqual(m3.missing, ['BrandNewKnob'], '新增未登记的参数没被点名');
  assert.equal(m3.ok, false);

  // 反向控制：真仓本身必须是绿的（否则上面三条都在测一个恒红的判据）
  assert.equal(base.ok, true, '真仓自己就红了 —— 先修真仓再看负例');
});

// ---------- B ----------
test('U-295-B: 没有"死后台"参数 —— 每个声明的参数在实现体里至少被读一次', () => {
  const body = (() => {
    const end = ENTRY_SRC.indexOf('\n)\n', ENTRY_SRC.search(/^param\(/m));
    let s = ENTRY_SRC.slice(end);
    for (const dir of ['lib', 'engines']) {
      const d = path.join(ROOT, dir);
      if (!fs.existsSync(d)) continue;
      for (const f of fs.readdirSync(d).filter((x) => x.endsWith('.ps1')).sort()) s += '\n' + fs.readFileSync(path.join(d, f), 'utf8');
    }
    return s;
  })();
  const reads = (name) => (body.match(new RegExp('\\$' + name + '(?![A-Za-z0-9_])', 'g')) || []).length;
  const dead = realDeclared.filter((p) => reads(p) === 0);
  assert.deepEqual(dead, [], '声明了但实现体从不读取（死参数，文档却在教用户用）：' + dead.join(','));
  // 阳性对照：已知被大量读取的参数必须数得出来（否则说明正文取样失败，上面那句"0 个死参数"毫无意义）
  assert.ok(reads('Keyword') > 10, `正样本 $Keyword 只数到 ${reads('Keyword')} 次 —— 实现体取样失效`);
  // 阴性对照：不存在的名字必须报 0
  assert.equal(reads('BrandNewKnob'), 0, '不存在的名字也数出了读取 ⇒ 正则过宽');
});

// ---------- C ----------
test('U-295-C: 接线 —— 9d 调用 Compare-ParamSurface，带两向自检，旧的纯计数话术不得残留', () => {
  const bad = [];
  if (!/^function Compare-ParamSurface \{/m.test(RUN_TESTS)) bad.push('run-tests.ps1 缺 Compare-ParamSurface 纯函数');
  if (!/Compare-ParamSurface -Declared \$t_paramVars -Documented \$t_docNames/.test(RUN_TESTS)) bad.push('9d 没把两侧名字喂给集合判据');
  if (!/U-295 自检：改名\/对换未被判红/.test(RUN_TESTS)) bad.push('缺"能红"的自检（判据可能恒绿）');
  if (!/U-295 自检：同一集合换序被误判/.test(RUN_TESTS)) bad.push('缺"能绿"的自检（判据可能恒红）');
  if (/参数计数不一致: 参数速查声明/.test(RUN_TESTS)) bad.push('旧的"只比计数"话术仍在（会让人以为计数就是判据）');
  // 表格必须真的被读成名字，而不是只读 header 那个数字
  if (!/\$t_docNames = @\(\[regex\]::Matches\(\$t_csDocText/.test(RUN_TESTS)) bad.push('9d 没有从表格抽名字');
  assert.deepEqual(bad, [], bad.join('; '));
});

// ---------- D ----------
const CASES = [
  { id: 'clean', declared: ['Alpha', 'Beta'], documented: ['Beta', 'Alpha'] },          // 顺序不同，集合相同
  { id: 'renamed', declared: ['Alpha', 'Beta'], documented: ['Alpha', 'Gamma'] },      // 计数相等、改名
  { id: 'swapped', declared: ['Alpha', 'Beta', 'Delta'], documented: ['Alpha', 'Beta', 'Epsilon'] }, // 计数相等、对换
  { id: 'added-in-code', declared: ['Alpha', 'Beta', 'Zeta'], documented: ['Alpha', 'Beta'] },
  { id: 'docs-only', declared: ['Alpha'], documented: ['Alpha', 'Zeta'] },
  { id: 'empty-both', declared: [], documented: [] },
  { id: 'dup-order', declared: ['Beta', 'Alpha', 'Beta'], documented: ['Alpha', 'Beta'] }, // 重复声明不影响集合
];

function normalize(v) { return Array.isArray(v) ? v : (v == null ? [] : [v]); }

async function runHarness(extraArgs = []) {
  const r = await runPwsh(['-File', HARNESS, ...extraArgs], { timeoutMs: 180000 });
  const line = (r.stdout || '').split(/\r?\n/).filter((l) => l.trim().startsWith('{"ok"')).pop();
  return { r, data: line ? JSON.parse(line) : null };
}

test('U-295-D: 同一批输入喂 JS 与 PS，逐条判定必须相同（两处实现不许漂移）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'u295-'));
  try {
    const casesFile = path.join(tmp, 'cases.json');
    fs.writeFileSync(casesFile, JSON.stringify(CASES), 'utf8');
    const { r, data } = await runHarness(['-CasesJson', casesFile]);
    assert.equal(r.status, 0, `harness rc=${r.status}: ${(r.stderr || '').slice(-500)}`);
    assert.ok(data, `harness 未输出 JSON：${(r.stdout || '').slice(-300)}`);
    assert.deepEqual(data.rows.map((x) => x.id).sort(), CASES.map((c) => c.id).sort(), '用例集在 PS 侧丢了');
    const mismatch = [];
    for (const c of CASES) {
      const js = compare(c.declared, c.documented);
      const ps = data.rows.find((x) => x.id === c.id);
      const a = { ok: js.ok, missing: [...js.missing].sort(), extra: [...js.extra].sort() };
      const b = { ok: ps.ok, missing: normalize(ps.missing).sort(), extra: normalize(ps.extra).sort() };
      if (JSON.stringify(a) !== JSON.stringify(b)) mismatch.push(`${c.id}: JS=${JSON.stringify(a)} PS=${JSON.stringify(b)}`);
    }
    assert.deepEqual(mismatch, [], '两处实现对同一输入判定不同：\n' + mismatch.join('\n'));

    // 变异：把 PS 侧的差集判据反过来（-notcontains → -contains）。等价性断言必须因此炸开，
    // 否则 D 层只是"两边都跑了一遍"的仪式 —— 它并不真的比较任何东西。
    const flipped = RUN_TESTS.replace('$missing = @($d | Where-Object { $o -notcontains $_ })', '$missing = @($d | Where-Object { $o -contains $_ })');
    assert.notEqual(flipped, RUN_TESTS, '变异未生效（PS 判据的锚点漂了）');
    const altPath = path.join(tmp, 'run-tests-flipped.ps1');
    fs.writeFileSync(altPath, flipped, 'utf8');
    const alt = await runHarness(['-CasesJson', casesFile, '-RunTestsPath', altPath]);
    assert.ok(alt.data, `变异副本的 harness 未输出 JSON：${(alt.r.stdout || '').slice(-300)}`);
    const altDiff = CASES.filter((c) => {
      const js = compare(c.declared, c.documented);
      const ps = alt.data.rows.find((x) => x.id === c.id);
      return js.ok !== ps.ok || JSON.stringify([...js.missing].sort()) !== JSON.stringify(normalize(ps.missing).sort());
    });
    assert.ok(altDiff.length > 0, '把 PS 的差集判据反转后判定居然没变 —— D 层没有真的比较两边');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------- E：MCP 包装层是参数面的第三份拷贝（v1.76.0） ----------
const MCP_PY = path.join(ROOT, 'mcps.py');
const PROBE = {
  limit: 3, maxResults: 5, minStars: 10, activeWithin: 30, excludeArchived: true,
  platforms: 'GitHub', language: 'python', site: 'stackoverflow', repoScope: 'a/b', pathFilter: 'src/', license: 'mit', packages: 'npm:left-pad',
};

/** 起 python 跑一段脚本并取回它对 stdout 打印的 JSON。rc≠0 一律当红 —— 不是"没输出就当通过"。 */
function runPy(code, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn(PY, ['-c', code], { cwd: ROOT, windowsHide: true });
    let out = '', err = '';
    const t = setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } reject(new Error('python timeout')); }, timeoutMs);
    child.stdout.on('data', (b) => { out += b.toString('utf8'); });
    child.stderr.on('data', (b) => { err += b.toString('utf8'); });
    child.once('error', (e) => { clearTimeout(t); reject(e); });
    child.once('close', (status) => {
      clearTimeout(t);
      if (status !== 0) return reject(new Error('python exit ' + status + ': ' + err.slice(0, 400)));
      try { resolve(JSON.parse(out.trim())); } catch { reject(new Error('bad json: ' + out.slice(0, 400))); }
    });
  });
}

/** 从指定 mcps.py 副本里读出四件事：白名单 / 各工具 op / schema 属性 / 真函数是否把每个白名单键带进 req */
function mcpProbeScript(modulePath) {
  return `
import importlib.util, json
spec = importlib.util.spec_from_file_location('mcps_probe', r'''${modulePath}''')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
PROBE = json.loads(r'''${JSON.stringify(PROBE)}''')
out = {"whitelist": {}, "ops": {}, "props": {}, "dropped": [], "threw": [], "types": {}}
for t, pair in m.MCP_TOOL_OPS.items():
    out["whitelist"][t] = sorted(pair[1])
    out["ops"][t] = pair[0]
tools = {x["name"]: x for x in m.mcp_tools()}
for t, x in tools.items():
    out["props"][t] = sorted((x.get("inputSchema") or {}).get("properties", {}))
for t, pair in m.MCP_TOOL_OPS.items():
    op, allowed = pair[0], pair[1]
    if op == "ping":
        continue
    for k in sorted(allowed):
        base = {"packages": PROBE["packages"]} if op == "package" else {"keyword": "x"}
        if k in base:
            continue
        args = dict(base); args[k] = PROBE.get(k, "x")
        try:
            req = m.build_tool_request(t, args)
        except Exception as e:
            out["threw"].append([t, k, str(e)]); continue
        if k not in req:
            out["dropped"].append([t, k])
for k, v in (("excludeArchived", "true"), ("license", 3), ("activeWithin", "180")):
    try:
        m.build_tool_request("search_repositories", {"keyword": "x", k: v}); out["types"][k] = "NO-ERROR"
    except ValueError as e:
        out["types"][k] = str(e)
print(json.dumps(out, ensure_ascii=False))
`;
}

/** 四个集合的四条判据（真仓与变异副本都用同一份实现，避免"两套判据"） */
function mcpVerdicts(d, serveOps) {
  const notRead = [];
  for (const [tool, keys] of Object.entries(d.whitelist)) for (const k of keys) if (!ENTRY_REQ_KEYS.has(k)) notRead.push(`${tool}.${k}`);
  const schemaDrift = [];
  for (const [tool, keys] of Object.entries(d.whitelist)) {
    const props = new Set(d.props[tool] || []);
    const missing = keys.filter((k) => !props.has(k));
    const extra = [...props].filter((k) => !keys.includes(k));
    if (missing.length || extra.length) schemaDrift.push(`${tool}: schema 缺 [${missing.join(',')}] / 多 [${extra.join(',')}]`);
  }
  const badOps = Object.entries(d.ops).filter(([, op]) => !serveOps.has(op)).map(([t, op]) => `${t}→${op}`);
  return { notRead, schemaDrift, badOps, threw: d.threw, dropped: d.dropped, types: d.types };
}

const SERVE_OPS = new Set([...ENTRY_SRC.matchAll(/^\s+'([a-z]+)' \{/gm)].map((m) => m[1]));

test('U-295-E: MCP 请求面四向对齐（白名单 / inputSchema / -Serve 读取集 / 真函数）', async () => {
  assert.ok(SERVE_OPS.size >= 6, `只抽到 ${SERVE_OPS.size} 个 -Serve 分支，取样正则可能已失效`);
  const d = await runPy(mcpProbeScript(MCP_PY));
  const v = mcpVerdicts(d, SERVE_OPS);
  assert.deepEqual(v.notRead, [], 'MCP 白名单允许、但 -Serve 从不读取（客户端传了等于没传）：' + v.notRead.join(','));
  assert.deepEqual(v.schemaDrift, [], v.schemaDrift.join('; '));
  assert.deepEqual(v.badOps, [], 'MCP 工具的 op 在 -Serve 里没有对应分支：' + v.badOps.join(','));
  assert.deepEqual(v.threw, [], '合法类型的白名单键被拒：' + JSON.stringify(v.threw));
  // ★这一条专抓"加了白名单、忘了加类型表"：白名单放行 → req 里却没有 → 静默丢弃
  assert.deepEqual(v.dropped, [], '白名单放行但 req 里没有（静默丢弃）：' + JSON.stringify(v.dropped));
  assert.match(v.types.excludeArchived || '', /must be a boolean/);
  assert.match(v.types.license || '', /must be a string/);
  assert.match(v.types.activeWithin || '', /must be an integer/);
});

test('U-295-E-neg: 四个变异各红一层 —— 白名单加键 / 全局改名 / 删类型表项 / 白名单少一项', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'u295e-'));
  try {
    const original = fs.readFileSync(MCP_PY, 'utf8');
    const originalV = mcpVerdicts(await runPy(mcpProbeScript(MCP_PY)), SERVE_OPS);
    assert.deepEqual([originalV.notRead, originalV.schemaDrift, originalV.badOps, originalV.dropped], [[], [], [], []], '真仓自己就红了');
    const run = async (name, mutate) => {
      const src = mutate(original);
      assert.notEqual(src, original, `变异 ${name} 未生效（锚点漂了）`);
      const p = path.join(tmp, `${name}.py`);
      fs.writeFileSync(p, src, 'utf8');
      return mcpVerdicts(await runPy(mcpProbeScript(p)), SERVE_OPS);
    };

    // ① 白名单里加一个 Serve 不读的键 ⇒ notRead 点名，且真函数把它丢了
    const m1 = await run('add-key', (s) => s.replace('"activeWithin", "excludeArchived", "license"}),', '"activeWithin", "excludeArchived", "license", "bogus"}),'));
    assert.deepEqual(m1.notRead, ['search_repositories.bogus'], '白名单加键后没点名 —— 这条判据看不见"新键没接线"');
    assert.deepEqual(m1.dropped, [['search_repositories', 'bogus']], '白名单放行的新键居然进了 req（说明类型表也被人手改过）');

    // ② 全局把 license 改名 licence（白名单 + 类型表 + schema 一起改）⇒ PS 仍读 license ⇒ notRead 红，另三条保持绿
    const m2 = await run('rename', (s) => s.split('"license"').join('"licence"'));
    assert.deepEqual(m2.notRead, ['search_repositories.licence'], '改名后没点名');
    assert.deepEqual([m2.schemaDrift, m2.dropped], [[], []], '改名是"两侧齐步改"的场景，schema 与类型表不该跟着红 —— 否则这条负例分不清是哪一层在报');

    // ③ 只把 activeWithin 从 int 类型表里删掉（白名单与 schema 不动）⇒ 只有"静默丢弃"这一层红
    const m3 = await run('drop-int', (s) => s.replace('for k in ("limit", "maxResults", "minStars", "activeWithin"):', 'for k in ("limit", "maxResults", "minStars"):'));
    assert.deepEqual([m3.notRead, m3.schemaDrift], [[], []], '类型表变异不该影响前两条判据');
    assert.deepEqual(m3.dropped, [['search_repositories', 'activeWithin']], '删掉类型表项后没报"静默丢弃" —— 这一层就白写了');

    // ④ 白名单少一项（schema 仍有）⇒ schemaDrift 报"多"，另三条不该红
    const m4 = await run('schema-extra', (s) => s.replace('"research": ("research", {"keyword", "limit", "maxResults", "site"}),', '"research": ("research", {"keyword", "limit", "maxResults"}),'));
    assert.deepEqual(m4.notRead, [], '白名单少一项不该触发"传了没读"');
    assert.equal(m4.schemaDrift.length, 1, 'schema 比白名单多一项必须被点名');
    assert.match(m4.schemaDrift[0], /research: schema 缺 \[\] \/ 多 \[site\]/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------- F：参数面的第四份拷贝 —— 文档里那张「MCP 白名单」表（v1.77.0） ----------
//
// v1.76.0 的 E 层对齐了四处：mcps.py 白名单 / inputSchema.properties / build_tool_request / -Serve 读到的键。
// 但它们都只是**代码内部**自洽 —— 对外承诺的那份表在 references/参数速查.md，从来没有任何门读它：
//   表头自称「接受参数（白名单，多一个就 -32602）」，实际只列 4 个工具（少了 search_auto / package_lookup），
//   且 search_repositories 少 3 个键、search_code 少 3 个键；SKILL.md 的同一张表是全的 ⇒ **两份文档各说一套**。
// 后果不是"少写一行"：用户照这份权威表调 MCP，`license`/`activeWithin`/`excludeArchived`/`repoScope`/`pathFilter`
// 会被当成"不认识的参数"（`-32602`），而 search_auto / package_lookup 在这份表里根本不存在。
//
// 判据：把表读回来，与 MCP_TOOL_OPS 比三项 —— 工具集合 / op / 每个工具的键集合（双向点名）。
//   SKILL.md 那张表第三列自述是「关键参数」（非穷尽）⇒ 只比**工具名集合**，不越界比键。

const MCP_DOC_HEAD = '| 工具 | `-Serve` op | 接受参数（白名单，多一个就 `-32602`） |';
const SKILL_TOOL_HEAD = '| 工具 | 作用 | 关键参数 |';

/** 从 markdown 表格里取行。锚表头文本；表头不在就认红 —— 判据不许静默匹配 0 行。 */
function docTableRows(md, headText, parseRow, label) {
  const lines = md.split(/\r?\n/);
  const at = lines.indexOf(headText);
  assert.notEqual(at, -1, `找不到${label}的表头（锚文本变了？）：${headText}`);
  const rows = [];
  for (let i = at + 2; i < lines.length; i++) {      // at+1 是 |---| 分隔行
    const line = lines[i];
    if (!line.startsWith('|')) break;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    assert.equal(cells.length, 3, `${label}第 ${i + 1} 行不是 3 列：${line.slice(0, 80)}`);
    rows.push(parseRow(cells, i + 1));
  }
  // 下限只用来证明"表真的被解析到了"（3 行足够），精确条数由用例自己断言 —— 否则"删一行"的负例没法构造。
  assert.ok(rows.length >= 3, `${label}只解析出 ${rows.length} 行 —— 表格结构变了，判据会静默变绿`);
  return rows;
}

const BARE = /^`([A-Za-z][A-Za-z0-9_]*)`$/;
/** 「参数」单元格 → 参数名数组。只收 ASCII 标识符形状的反引号名：`生态:包名` 是说明，不是参数。 */
function cellKeys(cell) {
  return [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]).filter((x) => /^[A-Za-z][A-Za-z0-9]*$/.test(x));
}

function mcpDocRows(md) {
  return docTableRows(md, MCP_DOC_HEAD, (c, ln) => {
    const t = BARE.exec(c[0]);
    const o = BARE.exec(c[1]);
    assert.ok(t, `参数速查第 ${ln} 行首列不是 \`工具名\`：${c[0]}`);
    assert.ok(o, `参数速查第 ${ln} 行 op 列不是 \`op\`：${c[1]}`);
    return { tool: t[1], op: o[1], keys: cellKeys(c[2]), line: ln };
  }, '参数速查 MCP 工具表');
}

function skillToolNames(md) {
  return docTableRows(md, SKILL_TOOL_HEAD, (c, ln) => {
    const t = BARE.exec(c[0]);
    assert.ok(t, `SKILL.md 第 ${ln} 行首列不是 \`工具名\`：${c[0]}`);
    return t[1];
  }, 'SKILL.md MCP 工具表');
}

/** 三项对齐。纯函数，真仓与文档变异共用同一份实现 —— 免得"两套判据各说一套"。 */
function mcpDocVerdict(rows, real) {
  const docTools = new Set(rows.map((r) => r.tool));
  const realTools = new Set(Object.keys(real));
  const missingTools = [...realTools].filter((t) => !docTools.has(t));
  const extraTools = [...docTools].filter((t) => !realTools.has(t));
  const opDrift = [];
  const keyMissing = [];
  const keyExtra = [];
  for (const r of rows) {
    const w = real[r.tool];
    if (!w) continue;
    if (w.op !== r.op) opDrift.push(`${r.tool}: 文档 op=${r.op} / 代码 op=${w.op}`);
    for (const k of w.keys) if (!r.keys.includes(k)) keyMissing.push(`${r.tool}.${k}`);
    for (const k of r.keys) if (!w.keys.includes(k)) keyExtra.push(`${r.tool}.${k}`);
  }
  return { missingTools, extraTools, opDrift, keyMissing, keyExtra };
}

/** python 侧真白名单 → { 工具: {op, keys} } */
async function realMCP() {
  const d = await runPy(mcpProbeScript(MCP_PY));
  const out = {};
  for (const [t, keys] of Object.entries(d.whitelist)) out[t] = { op: d.ops[t], keys };
  return out;
}

const REQUIRED_KEY = {
  search_repositories: 'keyword', search_auto: 'keyword', search_code: 'keyword',
  research: 'keyword', package_lookup: 'packages',
};

test('U-295-F: 参数速查的 MCP 白名单表 == MCP_TOOL_OPS（工具 / op / 键，三向）', async () => {
  const real = await realMCP();
  const rows = mcpDocRows(DOC);
  assert.equal(rows.length, Object.keys(real).length, `文档 ${rows.length} 行 vs 代码 ${Object.keys(real).length} 个工具`);
  assert.equal(new Set(rows.map((r) => r.tool)).size, rows.length, '工具表里有重复行');
  const v = mcpDocVerdict(rows, real);
  assert.deepEqual(v.missingTools, [], '代码里有、参数速查没登记（用户不知道有这个工具）：' + v.missingTools.join(','));
  assert.deepEqual(v.extraTools, [], '参数速查登记了、代码里没有：' + v.extraTools.join(','));
  assert.deepEqual(v.opDrift, [], v.opDrift.join('; '));
  assert.deepEqual(v.keyMissing, [], '白名单接受、文档没写（用户以为会 -32602 而不敢用）：' + v.keyMissing.join(','));
  assert.deepEqual(v.keyExtra, [], '文档承诺、白名单会拒（照文档写就报错）：' + v.keyExtra.join(','));
  for (const [t, k] of Object.entries(REQUIRED_KEY)) {
    const r = rows.find((x) => x.tool === t);
    assert.ok(r && r.keys.includes(k), `${t} 的必填键 ${k} 没写进文档`);
  }
  // SKILL.md 是同一事实的第二处登记（只承诺"关键参数"，故只比工具名集合）
  const skillNames = skillToolNames(fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf8'));
  assert.deepEqual([...skillNames].sort(), Object.keys(real).sort(), 'SKILL.md 的工具表与代码工具集合不一致');
});

test('U-295-F-neg: 四条文档变异各红一项，其余保持绿', async () => {
  const real = await realMCP();
  const clean = mcpDocVerdict(mcpDocRows(DOC), real);
  assert.deepEqual([clean.missingTools, clean.extraTools, clean.opDrift, clean.keyMissing, clean.keyExtra],
    [[], [], [], [], []], '真仓自己就红了');
  const run = (name, mutate) => {
    const md = mutate(DOC);
    assert.notEqual(md, DOC, `变异 ${name} 未生效（锚点漂了）`);
    return mcpDocVerdict(mcpDocRows(md), real);
  };

  // ① 少写一个键（行数、工具数、op 都不变）
  const m1 = run('drop-key', (s) => s.replace(/(\| `search_repositories` \| `repo` \|[^\n]*?) \/ `license`/, '$1'));
  assert.deepEqual(m1.keyMissing, ['search_repositories.license'], '文档删掉 license 后没点名');
  assert.deepEqual([m1.missingTools, m1.extraTools, m1.opDrift, m1.keyExtra], [[], [], [], []], '变异①只该触发"文档缺键"');

  // ② 写一个代码不接受的键
  const m2 = run('add-bogus', (s) => s.replace(/(\| `ping` \| `ping` \| )—/, '$1`verbose`'));
  assert.deepEqual(m2.keyExtra, ['ping.verbose'], '文档编出一个键后没点名');
  assert.deepEqual([m2.missingTools, m2.extraTools, m2.opDrift, m2.keyMissing], [[], [], [], []]);

  // ③ 删掉一整行工具（v1.77.0 之前 search_auto 就是这样缺席的）
  const m3 = run('drop-tool', (s) => s.split(/\r?\n/).filter((l) => !l.startsWith('| `search_auto` |')).join('\n'));
  assert.deepEqual(m3.missingTools, ['search_auto'], '删掉一整行后没报"工具缺席"');
  assert.deepEqual([m3.extraTools, m3.opDrift, m3.keyMissing, m3.keyExtra], [[], [], [], []]);

  // ④ op 改名（键全对，只有 op 错）
  const m4 = run('op-drift', (s) => s.replace('| `search_code` | `code` |', '| `search_code` | `codes` |'));
  assert.deepEqual(m4.opDrift, ['search_code: 文档 op=codes / 代码 op=code']);
  assert.deepEqual([m4.missingTools, m4.extraTools, m4.keyMissing], [[], [], []]);
});

// ---------- G：schema 声明的数值边界必须被两层兑现（v1.78.0） ----------
//
// 边界写在 mcps.py 的 `inputSchema` 里，真正生效的却是两处：python 的 build_tool_request（第一层）
// 与 -Serve 的数值解析（第二层）。v1.77.0 之前两层各缺一半：
//   · python 只校验**类型**，不看 min/max ⇒ `minStars=-1`、`activeWithin=40000` 原样进 req
//   · -Serve 只对 limit/maxResults 夹紧，minStars/activeWithin 是裸 `[int]`
// 于是"绕开 MCP 层、直接往 -Serve 的 stdin 写一行 JSON"的客户端能把越界值塞进去 ——
// 声明写在那儿，两条路径都不管。现统一为 clamp（越界夹到边界，不报错），schema description 也写明。
//
// G1（两层真跑）：同一批边界值分别喂 python 与 PS 纯函数 `Get-ServeBoundedInt`，要求
//   ① 结果落在 [lo, hi]；② **合法值原样**（阳性对照：否则"永远返回下限"的实现也能满足 ①）；
//   ③ 传 null 得到 default。
// G2（三方对账）：schema 的 minimum/maximum/default ↔ 入口调用点的 `-Min/-Max/-Default` 实参，**严格相等**。
//   这一层不可省：G1 只能证明"纯函数按它拿到的参数夹紧"，拿 `-Min 0` 去夹一个 schema 写着 min=10 的键
//   也满足 G1。且严格相等（而非"实现更严即可"）：客户端按 schema 传 55 是合法的，实现却夹到 50 就是静默改值。
//   另要求**每个有边界的键都被接线**——少接一个就是这条链断在那一格。

/** 每个工具的数值边界 + 每个边界值喂进 build_tool_request 的实际结果 */
function rangeProbeScript(modulePath) {
  return `
import importlib.util, json
spec = importlib.util.spec_from_file_location('mcps_probe', r'''${modulePath}''')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
out = {"ranges": {}, "cases": [], "defaults": {}}
for t in m.mcp_tools(output_schemas={}):
    name = t["name"]
    props = (t.get("inputSchema") or {}).get("properties") or {}
    rng = {}
    for k, sp in props.items():
        if sp.get("type") == "integer" and (sp.get("minimum") is not None or sp.get("maximum") is not None):
            rng[k] = [sp.get("minimum"), sp.get("maximum")]
            if sp.get("default") is not None:
                out["defaults"].setdefault(name, {})[k] = sp["default"]
    out["ranges"][name] = rng
    if name == "ping":
        continue
    base = {"packages": "npm:x"} if name == "package_lookup" else {"keyword": "x"}
    for k, pair in rng.items():
        lo, hi = pair
        probes = []
        if lo is not None:
            probes += [lo - 7, lo, lo + 1]
        if hi is not None:
            probes += [hi + 7, hi, hi - 1 if hi - 1 >= (lo if lo is not None else hi - 1) else hi]
        for v in probes:
            args = dict(base); args[k] = v
            try:
                got = m.build_tool_request(name, args).get(k, "<MISSING>")
            except Exception as e:
                got = "RAISE:" + str(e)
            out["cases"].append([name, k, v, got])
print(json.dumps(out, ensure_ascii=False))
`;
}

/** PS 侧的边界值组合：按 (lo,hi,default) 去重，每个组合加一条"不传"（null）+ 两侧越界 + 边界与内侧 */
function boundCases(d) {
  const combos = new Map();
  for (const [tool, rng] of Object.entries(d.ranges)) {
    for (const key of Object.keys(rng)) {
      const [lo, hi] = rng[key];
      const dv = (d.defaults[tool] || {})[key];
      const def = dv === undefined ? null : dv;
      combos.set(JSON.stringify([lo, hi, def]), { tool, key, lo, hi, def });
    }
  }
  const out = [];
  for (const c of combos.values()) {
    const probes = [null];
    if (c.lo !== null) probes.push(c.lo - 7, c.lo, c.lo + 1);
    if (c.hi !== null) probes.push(c.hi + 7, c.hi, c.hi - 1);
    for (const given of probes) out.push({ ...c, given });
  }
  return out;
}

/** 起 PS dot-source 入口后调纯函数 —— 断言的是**产品里那个函数**，不是 JS 复刻 */
function psBoundScript(entryPath, cases) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'u295g-ps-'));
  const casesPath = path.join(tmp, 'cases.json');
  fs.writeFileSync(casesPath, JSON.stringify(cases), 'utf8');
  const probe = path.join(tmp, 'probe.ps1');
  fs.writeFileSync(probe, [
    '$env:MCPS_NO_MAIN = "1"',
    `. '${entryPath.replace(/'/g, "''")}'`,
    `$cases = @(Get-Content -Raw -LiteralPath '${casesPath.replace(/'/g, "''")}' | ConvertFrom-Json)`,
    '$out = @()',
    'foreach ($c in $cases) {',
    '    $r = Get-ServeBoundedInt -Value $c.given -Min $c.lo -Max $c.hi -Default $c.def',
    '    $out += [PSCustomObject]@{ tool = $c.tool; key = $c.key; given = $c.given; lo = $c.lo; hi = $c.hi; def = $c.def; got = $r }',
    '}',
    'ConvertTo-Json -InputObject @($out) -Compress',
    '',
  ].join('\r\n'), 'utf8');
  return { tmp, probe };
}

/** 从入口源码抠每个 `$req.<key>` 的调用点实参；返回 key → [{tool?, min, max, def, line}] */
function serveCallSites(src) {
  const out = new Map();
  const lines = src.split(/\r?\n/);
  lines.forEach((line, i) => {
    const m = /Get-ServeBoundedInt\s+-Value\s+\$req\.(\w+)(.*)$/.exec(line);
    if (!m) return;
    const rest = m[2];
    const num = (flag) => {
      const r = new RegExp('-' + flag + '\\s+(-?\\d+)').exec(rest);
      return r ? Number(r[1]) : null;
    };
    if (!out.has(m[1])) out.set(m[1], []);
    out.get(m[1]).push({ min: num('Min'), max: num('Max'), def: num('Default'), line: i + 1 });
  });
  return out;
}

/** G2 判定（纯函数，真仓与变异共用） */
function callSiteViolations(d, src) {
  const sites = serveCallSites(src);
  const bad = [];
  for (const [tool, kv] of Object.entries(d.ranges)) {
    for (const [key, [lo, hi]] of Object.entries(kv)) {
      const here = sites.get(key);
      if (!here || !here.length) { bad.push(`${tool}.${key}: schema 声明了 [${lo},${hi === null ? '∞' : hi}]，但入口没有 Get-ServeBoundedInt -Value $req.${key} 调用点（这一层没接线）`); continue; }
      if (here.length > 1) {
        const sigs = new Set(here.map((h) => JSON.stringify([h.min, h.max, h.def])));
        if (sigs.size > 1) { bad.push(`${tool}.${key}: 入口有 ${here.length} 个调用点且实参不一致（${[...sigs].join(' / ')}）`); continue; }
      }
      const c = here[0];
      if (c.min !== lo) bad.push(`${tool}.${key}: schema minimum=${lo} vs 调用点 -Min ${c.min}（第 ${c.line} 行）`);
      if (c.max !== hi) bad.push(`${tool}.${key}: schema maximum=${hi} vs 调用点 ${c.max === null ? '未写 -Max' : '-Max ' + c.max}（第 ${c.line} 行）`);
      const dv = (d.defaults[tool] || {})[key];
      if (dv !== undefined && c.def !== dv) bad.push(`${tool}.${key}: schema default=${dv} vs 调用点 -Default ${c.def}（第 ${c.line} 行）`);
    }
  }
  return bad;
}

/** G1 判定（纯函数，两层共用一套规则） */
function clampViolations(rows) {
  const bad = [];
  for (const r of rows) {
    const given = r.given, got = r.got, lo = r.lo, hi = r.hi;
    if (given === null || given === undefined) {
      if (r.def === null || r.def === undefined) continue;   // 没声明 default 的键，不传时的行为不归本门管
      if (got !== r.def) bad.push(`${r.tool}.${r.key}: 传 null 应得 default=${r.def}，实得 ${got}`);
      continue;
    }
    if (typeof got !== 'number') { bad.push(`${r.tool}.${r.key}: 传 ${given} 得到非数字 ${got}`); continue; }
    if (lo !== null && got < lo) bad.push(`${r.tool}.${r.key}: 传 ${given} → ${got}，低于下限 ${lo}`);
    if (hi !== null && got > hi) bad.push(`${r.tool}.${r.key}: 传 ${given} → ${got}，高于上限 ${hi}`);
    const inRange = (lo === null || given >= lo) && (hi === null || given <= hi);
    if (inRange && got !== given) bad.push(`${r.tool}.${r.key}: 传 ${given} 是合法值却被改成 ${got}`);
  }
  return bad;
}

test('U-295-G1: 越界夹紧 + 合法值原样 —— python 与 -Serve 纯函数两层都跑', async () => {
  const d = await runPy(rangeProbeScript(MCP_PY));
  const cases = boundCases(d);
  const keys = Object.values(d.ranges).reduce((n, r) => n + Object.keys(r).length, 0);
  assert.ok(keys >= 4, `只抽到 ${keys} 个有边界的数值参数`);
  assert.ok(cases.length >= 12, `去重后只剩 ${cases.length} 个边界组合`);
  // 上下限两种形态都要覆盖（否则这条判据会退化成"只看下界"）
  assert.ok(cases.some((c) => c.hi !== null) && cases.some((c) => c.lo !== null), '上限/下限至少各有一个键声明');
  // ① python 层
  assert.deepEqual(clampViolations(d.cases.map(([tool, key, given, got]) => {
    const [lo, hi] = d.ranges[tool][key];
    const dv = (d.defaults[tool] || {})[key];
    return { tool, key, given, got, lo, hi, def: dv === undefined ? null : dv };
  })), [], 'python 层（build_tool_request）没有兑现边界');
  // ② PS 层：dot-source 真入口，调产品里那个纯函数
  const { tmp, probe } = psBoundScript(ENTRY, cases);
  try {
    const r = await runPwsh(['-File', probe], { timeoutMs: 180000 });
    assert.equal(r.status, 0, `PS 探针 status=${r.status}：${(r.stderr || '').slice(0, 400)}`);
    const line = (r.stdout || '').split(/\r?\n/).filter((x) => x.trim().startsWith('[') || x.trim().startsWith('{')).pop();
    assert.ok(line, `PS 探针没有输出 JSON：${(r.stdout || '').slice(0, 400)}`);
    const rows = JSON.parse(line);
    assert.equal(rows.length, cases.length, `PS 只回了 ${rows.length} 条，期望 ${cases.length}`);
    assert.deepEqual(clampViolations(rows), [], '-Serve 层（Get-ServeBoundedInt）没有兑现边界');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('U-295-G2: schema 的 min/max/default ↔ 入口调用点实参，三方严格相等且全覆盖', async () => {
  const d = await runPy(rangeProbeScript(MCP_PY));
  const sites = serveCallSites(ENTRY_SRC);
  assert.ok(sites.size >= 4, `只从入口抠到 ${sites.size} 个边界调用点 —— 正则锚点可能已漂`);
  assert.deepEqual(callSiteViolations(d, ENTRY_SRC), [], '声明与接线不一致：\n  ' + callSiteViolations(d, ENTRY_SRC).join('\n  '));
});

test('U-295-G-neg: 拆夹紧 / 收窄声明 / 删调用点 三种变异必红，只改说明文字必不红', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'u295g-'));
  try {
    const original = fs.readFileSync(MCP_PY, 'utf8');
    const base = await runPy(rangeProbeScript(MCP_PY));
    assert.deepEqual(callSiteViolations(base, ENTRY_SRC), [], '真仓自己就红了');

    const mutPy = async (name, from, to) => {
      assert.ok(original.includes(from), `变异 ${name} 锚点漂了`);
      const p = path.join(tmp, `${name}.py`);
      fs.writeFileSync(p, original.replace(from, to), 'utf8');
      return runPy(rangeProbeScript(p));
    };

    // ① 纯函数拆掉下限夹紧 ⇒ G1 的 PS 层必须红（python 层不受影响）
    const probeSrc = fs.readFileSync(ENTRY, 'utf8');
    const libSrc0 = fs.readFileSync(path.join(ROOT, 'lib', 'serve.ps1'), 'utf8');
    assert.ok(libSrc0.includes('if ($d -lt [decimal]$Min) { return $Min }'), '纯函数锚点漂了（lib/serve.ps1 里的下限夹紧语句已改写法）');
    const broken = fs.mkdtempSync(path.join(os.tmpdir(), 'u295g-broken-'));
    try {
      const brokenLib = path.join(broken, 'lib');
      fs.mkdirSync(brokenLib, { recursive: true });
      // 复制入口同目录的 lib/*.ps1，只把 serve.ps1 里的下限夹紧拆掉
      for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) {
        const src = fs.readFileSync(path.join(ROOT, 'lib', f), 'utf8');
        fs.writeFileSync(path.join(brokenLib, f), f === 'serve.ps1' ? src.replace('if ($d -lt [decimal]$Min) { return $Min }', 'if ($false) { return $Min }') : src, 'utf8');
      }
      const entryCopy = path.join(broken, 'multi-platform-searcher.ps1');
      fs.writeFileSync(entryCopy, probeSrc, 'utf8');
      for (const f of ['VERSION', 'skill-assets.json']) {
        if (fs.existsSync(path.join(ROOT, f))) fs.copyFileSync(path.join(ROOT, f), path.join(broken, f));
      }
      const cases = boundCases(base);
      const { tmp: t2, probe } = psBoundScript(entryCopy, cases);
      try {
        const r = await runPwsh(['-File', probe], { timeoutMs: 180000 });
        const line = (r.stdout || '').split(/\r?\n/).filter((x) => x.trim().startsWith('[') || x.trim().startsWith('{')).pop();
        const rows = line ? JSON.parse(line) : [];
        const v = clampViolations(rows);
        assert.ok(v.length > 0, '拆掉下限夹紧后 G1 仍然全绿 —— 这一层没有真的在跑产品函数');
      } finally {
        fs.rmSync(t2, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(broken, { recursive: true, force: true });
    }

    // ② 声明收窄（0 → 10）但入口仍写 -Min 0 ⇒ G2 红（"实现比声明更严"也是静默改值）
    const d2 = await mutPy('tighten', '"minimum": 0, "default": 100,\n                                 "description": "最小 star 阈值（默认 100，与 CLI 一致；0 = 不过滤）。负值按 0 处理。"',
      '"minimum": 10, "default": 100,\n                                 "description": "最小 star 阈值（默认 100，与 CLI 一致；0 = 不过滤）。负值按 0 处理。"');
    const v2 = callSiteViolations(d2, ENTRY_SRC);
    assert.ok(v2.some((s) => s.includes('minStars') && s.includes('minimum=10')), '收窄声明后 G2 没红：' + v2.join(' | '));

    // ③ 入口删掉 activeWithin 的调用点（退回裸 [int]）⇒ G2 报"未接线"
    const src3 = ENTRY_SRC.replace('$aw = Get-ServeBoundedInt -Value $req.activeWithin -Min 0 -Max 36500 -Default 0',
      '$aw = if ($null -ne $req.activeWithin) { [int]$req.activeWithin } else { 0 }');
    assert.notEqual(src3, ENTRY_SRC, '删调用点的变异锚点漂了');
    const v3 = callSiteViolations(base, src3);
    assert.ok(v3.some((s) => s.includes('activeWithin') && s.includes('没有 Get-ServeBoundedInt')), '删掉调用点后没报"未接线"：' + v3.join(' | '));

    // ④ 只改 schema 的 description 文字 ⇒ **不该红**（判据只看结构化字段，不跟文本变）
    const d4 = await mutPy('desc-only', '"description": "最小 star 阈值（默认 100，与 CLI 一致；0 = 不过滤）。负值按 0 处理。"',
      '"description": "（改写过的说明文字）"');
    assert.deepEqual(callSiteViolations(d4, ENTRY_SRC), [], '只改说明文字不该判红 —— 否则这条门只是在比字符串');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------- H：-Serve 的请求键白名单（v1.79.0） ----------
//
// 病灶：schema 写着 `additionalProperties: false`，MCP 层（`build_tool_request`）真的拒，但 `-Serve` 这一层
//   按分支逐个 `$req.<key>` 取值、剩下的键**静默丢弃**。手写客户端（不经 mcps.py、直接写 stdin）走的就是这条路：
//   `{"op":"repo","keyword":"x","minStar":5}` 少一个 s ⇒ 按默认 minStars=100 检索、返回 0 条、无任何告警。
//   实测（把入口那行拦截删掉的副本）：同一行请求真的发了网络请求，15.7s 后回了 25 条 —— 拼错的键从未被看见。
// 两层判据：
//   H1 集合：PS 的 `Get-ServeKeyPolicy`（参数面的第五份拷贝）与 mcps.py 的 `MCP_TOOL_OPS` 逐 op **两向**对账。
//     只验"会不会拒"不够：表里少一个键 ⇒ 合法请求被拒；多一个键 ⇒ 拼错的键被放行。
//   H2 行为：真起 `-Serve` 喂三行 —— 未知键(拒+点名+allowed 空) / 合规(必须过) / 拼错键(拒+点名+未触网)。
//     "合规那行必须过"是阴性对照：没有它，"一律拒掉"也能满足另外两条。

const KEY_LINE = ENTRY_SRC.split(/\r?\n/).find((l) => l.includes('Get-ServeRequestRejection -Req'));

/** op → python 侧白名单（{op: [keys]}），由 realMCP() 的 {tool: {op, keys}} 反转而来 */
async function opsOfMcp() {
  const real = await realMCP();
  const byOp = {};
  for (const w of Object.values(real)) byOp[w.op] = [...w.keys].sort();
  return byOp;
}

/** dot-source 入口后逐 op 取 PS 侧白名单 */
function psKeyScript(entryPath, ops) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'u295h-ps-'));
  const probe = path.join(tmp, 'probe.ps1');
  const list = ops.map((o) => `'${o}'`).join(', ');
  // ★BOM 不是装饰：探针里要点源**带中文路径**的入口，PS 5.1 读无 BOM 的 .ps1 会按 GBK 解码 ⇒
  //   路径变乱码、点源失败、函数全都不存在，探针会"安静地"返回一堆 $null（v1.81.0 实测踩到）。
  fs.writeFileSync(probe, '\uFEFF' + [
    '$env:MCPS_NO_MAIN = "1"',
    `. '${entryPath.replace(/'/g, "''")}'`,
    '$out = [ordered]@{}',
    `foreach ($o in @(${list})) { $p = Get-ServeKeyPolicy -Op $o; $out[$o] = [PSCustomObject]@{ known = [bool]$p.Known; keys = @($p.Keys) } }`,
    'ConvertTo-Json -InputObject $out -Compress -Depth 4',
    '',
  ].join('\r\n'), 'utf8');
  return { tmp, probe };
}

/** H1 判定（纯函数，真仓与变异共用） */
function keyViolations(psMap, pyByOp) {
  const bad = [];
  const ops = new Set([...Object.keys(psMap || {}), ...Object.keys(pyByOp || {})]);
  for (const op of [...ops].sort()) {
    const p = (psMap || {})[op];
    const q = (pyByOp || {})[op];
    if (!p || !p.known) { bad.push(`${op}: -Serve 白名单里没有这个 op`); continue; }
    if (!q) { bad.push(`${op}: -Serve 有、mcps.py 没有（多出来的分支）`); continue; }
    const a = [...p.keys].map(String).sort();
    const b = [...q].map(String).sort();
    const missing = b.filter((k) => !a.includes(k));
    const extra = a.filter((k) => !b.includes(k));
    if (missing.length) bad.push(`${op}: -Serve 缺 [${missing.join(',')}]（客户端合法传了会被拒）`);
    if (extra.length) bad.push(`${op}: -Serve 多 [${extra.join(',')}]（拼错的键被放行）`);
  }
  return bad;
}

async function readPsKeys(entryPath, ops) {
  const { tmp, probe } = psKeyScript(entryPath, ops);
  try {
    const r = await runPwsh(['-File', probe], { timeoutMs: 180000 });
    assert.equal(r.status, 0, `PS 白名单探针 status=${r.status}: ${(r.stderr || '').slice(0, 400)}`);
    const line = (r.stdout || '').split(/\r?\n/).filter((x) => x.trim().startsWith('{')).pop();
    assert.ok(line, `PS 白名单探针没有输出 JSON：${(r.stdout || '').slice(0, 300)}`);
    return JSON.parse(line);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

/** 真起一次 -Serve，喂若干行（pwsh 优先，回退 Windows PowerShell） */
function serveLines(entryPath, lines, timeoutMs = 180000, only = null) {
  const once = (exe) => new Promise((resolve, reject) => {
    const child = spawn(exe, ['-NoProfile', '-NonInteractive', '-File', entryPath, '-NoEnvFile', '-Serve'], {
      cwd: path.dirname(entryPath), windowsHide: true,
      env: { ...process.env, MCPS_SERVE_CACHE: '0' },
    });
    let out = '', err = '';
    child.stdout.on('data', (b) => { out += b.toString('utf8'); });
    child.stderr.on('data', (b) => { err += b.toString('utf8'); });
    child.once('error', reject);
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } }, timeoutMs);
    child.once('close', (st) => { clearTimeout(t); resolve({ st, out, err }); });
    child.stdin.write(lines.join('\n') + '\n');
    child.stdin.end();
  });
  return (async () => {
    let last = null;
    for (const exe of (only ? [only] : ['pwsh', 'powershell'])) {
      try { return await once(exe); } catch (e) { last = e; }
    }
    throw last;
  })();
}

function rowsOf(out) {
  return (out || '').split(/\r?\n/).filter((l) => l.trim().startsWith('{')).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

const H2_LINES = ['{"op":"ping","verbose":true}', '{"op":"ping"}', '{"op":"repo","keyword":"x","minStar":5}'];

/** H2 判定（纯函数）：三行响应 + python 侧 repo 白名单 */
function serveKeyVerdict(rows, repoKeys) {
  const bad = [];
  if (rows.length !== 3) return [`响应行数 ${rows.length} ≠ 3（进程没跑完 / 少了一行响应）`];
  const [unknown, ok, typo] = rows;
  if (unknown.ok !== false) bad.push('ping 带未知键 verbose 居然 ok=true（静默忽略）');
  if (!/verbose/.test(String(unknown.error || ''))) bad.push('未知键没有被点名：' + JSON.stringify(unknown.error));
  if (!Array.isArray(unknown.allowed) || unknown.allowed.length !== 0) bad.push('ping 的 allowed 必须是空数组，实得 ' + JSON.stringify(unknown.allowed));
  if (ok.ok !== true) bad.push('合规的 ping 被拒了（判据不能是"一律拒"）：' + JSON.stringify(ok.error));
  if (typo.ok !== false) bad.push('repo 带拼错的键 minStar 居然 ok=true（按默认值检索了）');
  if (!/minStar\b/.test(String(typo.error || ''))) bad.push('拼错的键没有被点名：' + JSON.stringify(typo.error));
  const allowed = Array.isArray(typo.allowed) ? typo.allowed.map(String).sort() : [];
  if (!allowed.includes('minStars')) bad.push('拒绝时没有回显正确拼写 minStars：' + JSON.stringify(allowed));
  if (JSON.stringify(allowed) !== JSON.stringify([...repoKeys].sort())) bad.push('回显的 allowed 与 schema 的 repo 键集合不一致：[' + allowed + '] vs [' + [...repoKeys].sort() + ']');
  if (!(typeof typo.ms === 'number' && typo.ms < 5000)) bad.push('拼错的键居然走到了检索（ms=' + typo.ms + '），必须在分发前拒');
  return bad;
}

test('U-295-H1: -Serve 的请求键白名单 == MCP_TOOL_OPS（逐 op 两向）', async () => {
  assert.ok(KEY_LINE, '入口里找不到 Get-ServeKeyRejection 调用点 —— 白名单没有被接线');
  const pyByOp = await opsOfMcp();
  assert.ok(Object.keys(pyByOp).length >= 6, `python 侧只抽到 ${Object.keys(pyByOp).length} 个 op`);
  const ops = [...new Set([...SERVE_OPS, ...Object.keys(pyByOp)])];
  const ps = await readPsKeys(ENTRY, ops);
  const v = keyViolations(ps, pyByOp);
  assert.deepEqual(v, [], '-Serve 白名单与 MCP 层不一致：\n  ' + v.join('\n  '));
  // ping 必须"已知且不接受任何键" —— 与"未知 op"是两件事（裸 @() 会被 PS 展开成 $null，两者就混了）
  assert.equal(ps.ping.known, true, 'ping 必须被认得');
  assert.deepEqual(ps.ping.keys, [], 'ping 不接受任何请求键');
});

test('U-295-H2: 真起 -Serve —— 未知键被拒并点名、合规请求照过、拼错的键在分发前被拒', async () => {
  const pyByOp = await opsOfMcp();
  const r = await serveLines(ENTRY, H2_LINES);
  assert.equal(r.st, 0, `-Serve rc=${r.st}: ${(r.err || '').slice(-500)}`);
  const v = serveKeyVerdict(rowsOf(r.out), pyByOp.repo);
  assert.deepEqual(v, [], '白名单在真进程里没有生效：\n  ' + v.join('\n  '));
});

test('U-295-H-neg: 拆接线 / 表里拼错 / 表比代码宽 三种变异必红，只改注释必不红', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'u295h-neg-'));
  const lib0 = fs.readFileSync(path.join(ROOT, 'lib', 'serve.ps1'), 'utf8');
  /** 复制一份可跑的副本（入口 + lib + engines），lib/serve.ps1 可被改写 */
  const clone = (name, patchEntry, patchLib) => {
    const dst = path.join(tmp, name);
    fs.mkdirSync(path.join(dst, 'lib'), { recursive: true });
    fs.mkdirSync(path.join(dst, 'engines'), { recursive: true });
    const src = patchEntry ? patchEntry(ENTRY_SRC) : ENTRY_SRC;
    fs.writeFileSync(path.join(dst, 'multi-platform-searcher.ps1'), src, 'utf8');
    for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) {
      const s = fs.readFileSync(path.join(ROOT, 'lib', f), 'utf8');
      fs.writeFileSync(path.join(dst, 'lib', f), f === 'serve.ps1' && patchLib ? patchLib(s) : s, 'utf8');
    }
    for (const f of fs.readdirSync(path.join(ROOT, 'engines'))) fs.copyFileSync(path.join(ROOT, 'engines', f), path.join(dst, 'engines', f));
    return path.join(dst, 'multi-platform-searcher.ps1');
  };
  const PING2 = ['{"op":"ping","verbose":true}', '{"op":"ping"}'];
  try {
    // 真仓基线：同一批 ping 行在真仓上必须是"拒 + 过"
    const realRows = rowsOf((await serveLines(ENTRY, PING2)).out);
    assert.equal(realRows.length, 2, '真仓 ping 探针没回两行');
    assert.equal(realRows[0].ok, false, '真仓居然放行了未知键 —— 后面的变异对比没有基准');

    // ① 拆接线：删掉入口那行 ⇒ 未知键重新被静默忽略（H2 的第一条断言必红）
    assert.ok(KEY_LINE, '接线行锚点漂了');
    const noWire = clone('nowire', (s) => s.split(KEY_LINE).join(''));
    const mut1 = rowsOf((await serveLines(noWire, PING2)).out);
    assert.equal(mut1.length, 2, '拆接线后的副本没回两行');
    assert.equal(mut1[0].ok, true, '删掉接线后未知键仍被拒 ⇒ 说明拒绝不是那行代码干的（H2 在量别的）');

    // ② 表里拼错一个键（minStars → minStar）⇒ H1 的"缺"必须点名
    const typoEntry = clone('typo', null, (s) => {
      assert.ok(s.includes("platforms = 'str'; language = 'str'; minStars = 'int'"), '白名单锚点漂了');
      return s.replace("platforms = 'str'; language = 'str'; minStars = 'int'", "platforms = 'str'; language = 'str'; minStar = 'int'");
    });
    const pyByOp = await opsOfMcp();
    const ops = [...new Set([...SERVE_OPS, ...Object.keys(pyByOp)])];
    const v2 = keyViolations(await readPsKeys(typoEntry, ops), pyByOp);
    assert.ok(v2.some((x) => x.includes('repo') && x.includes('缺') && x.includes('minStars')), '表里拼错后 H1 没点名：' + v2.join(' | '));

    // ③ 表比代码宽（给 ping 加一个 verbose）⇒ H1 的"多"必须点名
    const wideEntry = clone('wide', null, (s) => {
      assert.ok(s.includes("'ping'     = @{}"), 'ping 白名单锚点漂了');
      return s.replace("'ping'     = @{}", "'ping'     = @{ verbose = 'str' }");
    });
    const v3 = keyViolations(await readPsKeys(wideEntry, ops), pyByOp);
    assert.ok(v3.some((x) => x.startsWith('ping') && x.includes('多') && x.includes('verbose')), '表比代码宽时 H1 没点名：' + v3.join(' | '));

    // ④ 只改注释文字 ⇒ 不该红（判据只看结构化内容，不跟文本变）
    const noteEntry = clone('note', null, (s) => s.replace('**请求键白名单** —— schema 里写着', '**请求键白名单（改写过）** —— schema 里写着'));
    assert.notEqual(fs.readFileSync(path.join(path.dirname(noteEntry), 'lib', 'serve.ps1'), 'utf8'), lib0, '注释变异没生效');
    assert.deepEqual(keyViolations(await readPsKeys(noteEntry, ops), pyByOp), [], '只改注释不该判红');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------- H3：键名大小写 —— 两层对同一输入必须同判（v1.80.0） ----------
//
// v1.79.0 的白名单用 `-notcontains`（大小写不敏感），于是同一个 `MinStars`：
//   · mcps.py  → "unexpected arguments for search_repositories: MinStars"（拒）
//   · -Serve   → 放行；而 PS 的属性读取同样大小写不敏感 ⇒ **值真的被用上了**（实测 ok:true / count:27 / ms:11908）
// 同一份输入，客户端换个入口就换一套契约；对着 `-Serve` 开发的客户端搬到 MCP 层会突然报错。
// JSON 的成员名本来就是大小写敏感的（schema properties 全小写）⇒ PS 侧按 python 口径对齐（`-cnotcontains`）。
// 判据三层：① python 对每个键的首字母大写变体必须拒；② 真起 `-Serve`，同一批变体必须拒并**逐字点名**；
//   ③ 阴性对照：同一批键全小写时必须一条都不报（否则"一律当未知键"也能满足 ①②，那就成了另一种错）。

const SAMPLE_VALUE = {
  keyword: 'x', limit: 3, maxResults: 5, minStars: 10, activeWithin: 30, excludeArchived: true,
  license: 'mit', platforms: 'GitHub', language: 'python', site: 'stackoverflow', repoScope: 'a/b',
  pathFilter: 'src/', packages: 'npm:x',
};

/** 每个 op 的每个白名单键 → 首字母大写变体（必然与原键不同名） */
function caseVariants(pyByOp) {
  const out = [];
  for (const op of Object.keys(pyByOp)) {
    for (const k of pyByOp[op]) {
      const variant = k[0].toUpperCase() + k.slice(1);
      if (variant !== k) out.push({ op, key: k, variant });
    }
  }
  return out;
}

/** 工具名 → op 的反查（python 侧调用要工具名） */
async function toolByOp() {
  const real = await realMCP();
  const map = {};
  for (const [tool, w] of Object.entries(real)) map[w.op] = tool;
  return map;
}

function caseProbeScript(modulePath, cases) {
  return `
import importlib.util, json
spec = importlib.util.spec_from_file_location('mcps_probe', r'''${modulePath}''')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
cases = json.loads(r'''${JSON.stringify(cases)}''')
out = []
for c in cases:
    try:
        m.build_tool_request(c["tool"], c["args"]); out.append([c["variant"], "ACCEPTED"])
    except Exception as e:
        out.append([c["variant"], str(e)])
print(json.dumps(out, ensure_ascii=False))
`;
}

/** dot-source 入口后调纯函数：一批 {id, op, req} → {id: unknown[]}（真仓与变异共用） */
function unknownProbeScript(entryPath, cases) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'u295h3-ps-'));
  const casesPath = path.join(tmp, 'cases.json');
  fs.writeFileSync(casesPath, JSON.stringify(cases), 'utf8');
  const probe = path.join(tmp, 'probe.ps1');
  fs.writeFileSync(probe, [
    '$env:MCPS_NO_MAIN = "1"',
    `. '${entryPath.replace(/'/g, "''")}'`,
    `$cases = @(Get-Content -Raw -LiteralPath '${casesPath.replace(/'/g, "''")}' | ConvertFrom-Json)`,
    '$out = @()',
    'foreach ($c in $cases) { $out += [PSCustomObject]@{ id = [string]$c.id; unknown = @(Get-ServeUnknownKeys -Req $c.req -Op ([string]$c.op)) } }',
    'ConvertTo-Json -InputObject @($out) -Compress -Depth 5',
    '',
  ].join('\r\n'), 'utf8');
  return { tmp, probe };
}

async function readUnknowns(entryPath, cases) {
  const { tmp, probe } = unknownProbeScript(entryPath, cases);
  try {
    const r = await runPwsh(['-File', probe], { timeoutMs: 180000 });
    assert.equal(r.status, 0, `纯函数探针 status=${r.status}: ${(r.stderr || '').slice(0, 400)}`);
    const line = (r.stdout || '').split(/\r?\n/).filter((x) => x.trim().startsWith('[') || x.trim().startsWith('{')).pop();
    assert.ok(line, `纯函数探针没有输出 JSON：${(r.stdout || '').slice(0, 300)}`);
    const rows = JSON.parse(line);
    return Object.fromEntries(rows.map((x) => [x.id, Array.isArray(x.unknown) ? x.unknown.map(String) : []]));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

test('U-295-H3: 键名大小写 —— -Serve 与 MCP 层对同一批变体必须同判，全小写必须一条都不报', async () => {
  const pyByOp = await opsOfMcp();
  const tools = await toolByOp();
  const cases = caseVariants(pyByOp);
  assert.ok(cases.length >= 20, `只生成 ${cases.length} 个大小写变体 —— 白名单解析可能失效`);

  // ① python 侧：每个变体都必须被拒，且错误里逐字点名
  const pyCases = cases.map((c) => ({ tool: tools[c.op], variant: c.variant, args: { [c.variant]: SAMPLE_VALUE[c.key] } }));
  const pyOut = await runPy(caseProbeScript(MCP_PY, pyCases));
  assert.equal(pyOut.length, cases.length, `python 只回了 ${pyOut.length}/${cases.length} 条判定`);
  const pyRejected = new Set();
  cases.forEach((c, i) => {
    const [variant, msg] = pyOut[i];
    assert.equal(variant, c.variant, `第 ${i} 条变体串了：${variant} ≠ ${c.variant}`);
    assert.notEqual(msg, 'ACCEPTED', `python 居然接受了大小写变体 ${c.op}.${variant}`);
    assert.match(msg, /unexpected arguments/, `${c.op}.${variant} 的拒绝理由不是"多余参数"：${msg}`);
    assert.ok(msg.includes(variant), `${c.op}.${variant} 没有被逐字点名：${msg}`);
    // ★键名作键会去重：`keyword`/`limit`/`minStars` 等 6 个键在多个 op 里重复出现，
    //   用裸变体当集合元素会把 26 个用例悄悄压成 13 个（首版就这么"全绿"过一次）
    pyRejected.add(`${c.op}.${variant}`);
  });
  assert.equal(pyRejected.size, cases.length, `python 只拒了 ${pyRejected.size}/${cases.length} 个 (op, 变体)`);

  // ② 真起 -Serve：同一批变体，逐行喂进去（全部在分发前被拒 ⇒ 不触网）
  const lines = cases.map((c) => JSON.stringify({ op: c.op, [c.variant]: SAMPLE_VALUE[c.key] }));
  const r = await serveLines(ENTRY, lines);
  assert.equal(r.st, 0, `-Serve rc=${r.st}: ${(r.err || '').slice(-400)}`);
  const rows = rowsOf(r.out);
  assert.equal(rows.length, cases.length, `响应行数 ${rows.length} ≠ ${cases.length}`);
  const psRejected = new Set();
  cases.forEach((c, i) => {
    const row = rows[i];
    assert.equal(row.ok, false, `${c.op} 的 ${c.variant} 居然被 -Serve 放行（与 MCP 层判定相反）`);
    assert.equal(String(row.error), `unexpected request keys: ${c.variant}`, `${c.variant} 的点名不对：${row.error}`);
    psRejected.add(`${c.op}.${c.variant}`);
  });
  assert.deepEqual([...psRejected].sort(), [...pyRejected].sort(), '两层拒掉的 (op, 变体) 集合不同');

  // ③ 阴性对照：同一批键**全小写**时，纯函数必须一条都不报（否则"一律当未知键"也能过 ①②）
  const lowerCases = Object.keys(pyByOp).filter((op) => pyByOp[op].length > 0).map((op) => ({
    id: `lower-${op}`,
    op,
    req: Object.fromEntries([['op', op], ...pyByOp[op].map((k) => [k, SAMPLE_VALUE[k]])]),
  }));
  const lower = await readUnknowns(ENTRY, lowerCases);
  for (const c of lowerCases) assert.deepEqual(lower[c.id], [], `${c.op} 的全小写请求被误判成未知键：${JSON.stringify(lower[c.id])}`);

  // ④ 反向控制：把 `-cnotcontains` 退回 `-notcontains`，同一个 MinStars 必须重新变成"不报"
  const upper = await readUnknowns(ENTRY, [{ id: 'u', op: 'repo', req: { op: 'repo', MinStars: 5 } }]);
  assert.deepEqual(upper.u, ['MinStars'], '真仓没有把 MinStars 判成未知键');
  const libSrc = fs.readFileSync(path.join(ROOT, 'lib', 'serve.ps1'), 'utf8');
  assert.ok(libSrc.includes('-cnotcontains $_'), '白名单比较符锚点漂了（应为 -cnotcontains）');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'u295h3-mut-'));
  try {
    const dst = path.join(tmp, 'm');
    fs.mkdirSync(path.join(dst, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(dst, 'multi-platform-searcher.ps1'), ENTRY_SRC, 'utf8');
    for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) {
      const s = fs.readFileSync(path.join(ROOT, 'lib', f), 'utf8');
      fs.writeFileSync(path.join(dst, 'lib', f), f === 'serve.ps1' ? s.replace('-cnotcontains $_', '-notcontains $_') : s, 'utf8');
    }
    const mut = await readUnknowns(path.join(dst, 'multi-platform-searcher.ps1'), [{ id: 'u', op: 'repo', req: { op: 'repo', MinStars: 5 } }]);
    assert.deepEqual(mut.u, [], '退回大小写不敏感后 MinStars 仍被判未知键 ⇒ 这条判据没在量比较符');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------- I：值的类型 —— 两层对同一输入必须同判（v1.81.0） ----------
//
// 病灶：v1.79/1.80 只对账了"键名在不在"，值的类型全靠 PS 强转兜 ——
//   `{"limit":"5"}` 收下当 5 用；`{"excludeArchived":"false"}` 更糟，`[bool]"false"` 是 $True，
//   客户端说"别排除归档"被读成"排除归档"；`{"keyword":5}` 把 5 当关键词**真的发了一轮检索**
//   （实测 ok:true / count:27 / 11.9s）。mcps.py 对这三例自 v1.46.7 起就抛 ValueError
//   （U-202 C 也断言了「"true" 字符串必须拒绝，静默转换会把 false 变 True」），但那条门只测了 python
//   那一半 —— 同一条纪律在一个入口生效、在另一个入口躺了 34 个版本。实测 13 例里 12 例两层判定相反。
//
// 判据：
//   I1 矩阵：27 个 (op, 请求) 同时喂 python 的 `build_tool_request` 与 PS 的 `Get-ServeTypeRejection`，
//     **判决与文案都要求相等**；两个运行时各跑一遍 —— 类型映射本来就不同（5.1 给 Int32/Decimal、
//     7 给 Int64/BigInteger），只跑一个运行时的绿没有覆盖域（纪律 #9；本层首版就因为这个让 20 位整数
//     在 5.1 被误判、在 7 被放行 —— 27 例里只错 1 例，单运行时看不出来）。
//   I2 行为：真起 `-Serve` 五行，全在**分发前**被判 ⇒ 零网络（每行还要求 ms<5000，真发请求要 10s+）。
//     第 2 行是阴性对照：类型合法 ⇒ 必须走到分发并报 "unknown platforms"。
//     没有它，"一律拒"也能满足另外四行。
//   I-neg：整数判定退回 `[int]$v` 强转 / 表里把 bool 改成 str 必红；只改注释不红。

const TYPE_TOOL = { repo: 'search_repositories', auto: 'search_auto', code: 'search_code', research: 'research', package: 'package_lookup', ping: 'ping' };

/** 27 个 (op, 请求)。每一条都是"手写客户端可能发出来的形状"，不是凭空造的类型。 */
const TYPE_CASES = [
  { id: 'limit-str', op: 'repo', req: { keyword: 'x', limit: '5' } },
  { id: 'limit-float', op: 'repo', req: { keyword: 'x', limit: 5.0 } },
  { id: 'limit-bool', op: 'repo', req: { keyword: 'x', limit: true } },
  { id: 'maxresult-str', op: 'repo', req: { keyword: 'x', maxResults: '0' } },
  { id: 'minstars-str', op: 'repo', req: { keyword: 'x', minStars: '5' } },
  { id: 'minstars-bool', op: 'repo', req: { keyword: 'x', minStars: true } },
  { id: 'activewithin-str', op: 'repo', req: { keyword: 'x', activeWithin: '30' } },
  { id: 'excl-strfalse', op: 'repo', req: { keyword: 'x', excludeArchived: 'false' } },
  { id: 'excl-num', op: 'repo', req: { keyword: 'x', excludeArchived: 0 } },
  { id: 'keyword-num', op: 'repo', req: { keyword: 5 } },
  { id: 'keyword-empty', op: 'repo', req: { keyword: '' } },
  { id: 'keyword-blank', op: 'repo', req: { keyword: '   ' } },
  { id: 'keyword-missing', op: 'repo', req: { platforms: 'GitHub' } },
  { id: 'platforms-num', op: 'repo', req: { keyword: 'x', platforms: 5 } },
  { id: 'language-bool', op: 'repo', req: { keyword: 'x', language: false } },
  { id: 'reposcope-num', op: 'code', req: { keyword: 'x', repoScope: 5 } },
  { id: 'pathfilter-num', op: 'code', req: { keyword: 'x', pathFilter: 5 } },
  { id: 'autosite-num', op: 'auto', req: { keyword: 'x', site: 5 } },
  { id: 'ressite-num', op: 'research', req: { keyword: 'x', site: 5 } },
  { id: 'packages-num', op: 'package', req: { packages: 5 } },
  { id: 'packages-missing', op: 'package', req: {} },
  { id: 'limit-huge', op: 'repo', req: { keyword: 'x', limit: 99999999999999999999 } },
  { id: 'limit-neg', op: 'repo', req: { keyword: 'x', limit: -3 } },
  { id: 'ok-full', op: 'repo', req: { keyword: 'x', limit: 5, maxResults: 0, minStars: 0, activeWithin: 0, excludeArchived: true, platforms: 'GitHub', language: 'Go', license: 'mit' } },
  { id: 'ok-auto', op: 'auto', req: { keyword: 'x' } },
  { id: 'ok-code', op: 'code', req: { keyword: 'x', repoScope: 'owner/repo', pathFilter: 'src/' } },
  { id: 'ok-package', op: 'package', req: { packages: 'npm:express' } },
];

/** python 侧判决（{id: {ok, err}}）。跑的是真 `build_tool_request`，不是复述它的规则。 */
async function readPyTypeVerdicts() {
  const payload = TYPE_CASES.map((c) => ({ id: c.id, tool: TYPE_TOOL[c.op], req: c.req }));
  const rows = await runPy(`
import json, sys
sys.path.insert(0, ${JSON.stringify(ROOT)})
import mcps
cases = json.loads(r'''${JSON.stringify(payload)}''')
out = []
for c in cases:
    try:
        r = mcps.build_tool_request(c["tool"], c["req"])
        out.append({"id": c["id"], "ok": True, "err": "", "limit": r.get("limit")})
    except Exception as e:
        out.append({"id": c["id"], "ok": False, "err": str(e)})
print(json.dumps(out, ensure_ascii=False))
`);
  assert.equal(rows.length, TYPE_CASES.length, `python 只回了 ${rows.length}/${TYPE_CASES.length} 条判定`);
  return Object.fromEntries(rows.map((r) => [r.id, r]));
}

/** PS 侧：dot-source 入口后逐例调 `Get-ServeTypeRejection`（不触网、不起进程池）。 */
async function readPsTypeVerdicts(entryPath, exe) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'u295i-'));
  try {
    const casesFile = path.join(tmp, 'cases.json');
    fs.writeFileSync(casesFile, JSON.stringify(TYPE_CASES.map((c) => ({ id: c.id, op: c.op, req: { op: c.op, ...c.req } }))), 'utf8');
    const probe = path.join(tmp, 'probe.ps1');
    // ★BOM：探针里点源带中文路径的入口，PS 5.1 读无 BOM 的 .ps1 会按 GBK 解码 ⇒ 点源失败、函数全不存在
    fs.writeFileSync(probe, '\uFEFF' + [
      '$env:MCPS_NO_MAIN = "1"',
      `. '${entryPath.replace(/'/g, "''")}'`,
      `$cases = Get-Content -Raw -Encoding UTF8 '${casesFile.replace(/'/g, "''")}' | ConvertFrom-Json`,
      '$out = @()',
      'foreach ($c in $cases) {',
      '  $r = Get-ServeTypeRejection -Req $c.req -Op $c.op -Ms 0',
      '  $out += [PSCustomObject]@{ id = $c.id; ok = [bool]($null -eq $r); err = $(if ($null -eq $r) { "" } else { [string]$r.error }) }',
      '}',
      'ConvertTo-Json -InputObject $out -Compress -Depth 4',
      '',
    ].join('\r\n'), 'utf8');
    const r = await runPsExe(exe, ['-NoProfile', '-NonInteractive', '-File', probe]);
    assert.equal(r.st, 0, `${exe} 类型探针 rc=${r.st}: ${(r.err || '').slice(0, 400)}`);
    const line = (r.out || '').split(/\r?\n/).filter((x) => x.trim().startsWith('[')).pop();
    assert.ok(line, `${exe} 类型探针没有输出 JSON：${(r.out || '').slice(0, 300)}`);
    return Object.fromEntries(JSON.parse(line).map((x) => [x.id, x]));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

/** 起指定可执行文件（I 层要分别跑 5.1 与 7；runPwsh 只会挑一个） */
function runPsExe(exe, args, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd: ROOT, windowsHide: true });
    let out = '', err = '';
    child.stdout.on('data', (b) => { out += b.toString('utf8'); });
    child.stderr.on('data', (b) => { err += b.toString('utf8'); });
    child.once('error', (e) => reject(new Error(`spawn ${exe} 失败：${e.message}`)));
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } }, timeoutMs);
    child.once('close', (st) => { clearTimeout(t); resolve({ st, out, err }); });
  });
}

/** I1 判定（纯函数，真仓与变异共用）：判决 + 文案，逐例相等 */
function typeViolations(pyRows, psRows) {
  const bad = [];
  for (const c of TYPE_CASES) {
    const py = pyRows[c.id];
    const ps = psRows[c.id];
    if (!py) { bad.push(`${c.id}: python 没回判定`); continue; }
    if (!ps) { bad.push(`${c.id}: PS 没回判定`); continue; }
    if (Boolean(py.ok) !== Boolean(ps.ok)) {
      bad.push(`${c.id}: 判决相反 —— python ${py.ok ? 'ACCEPT' : `REJECT(${py.err})`} / -Serve ${ps.ok ? 'ACCEPT' : `REJECT(${ps.err})`}`);
      continue;
    }
    if (!py.ok && String(py.err) !== String(ps.err)) bad.push(`${c.id}: 文案不同 —— python "${py.err}" / -Serve "${ps.err}"`);
  }
  return bad;
}

const I2_LINES = [
  '{"op":"repo","keyword":"x","limit":"5","platforms":"NOPE"}',                    // 类型错：必须压过平台校验
  '{"op":"repo","keyword":"x","limit":5,"platforms":"NOPE"}',                       // 阴性对照：类型合法 ⇒ 走到分发
  '{"op":"repo","keyword":"x","excludeArchived":"false","platforms":"NOPE"}',       // 最贵的一格：false 曾被读成 true
  '{"op":"repo","keyword":5,"platforms":"NOPE"}',                                   // 5 曾被当关键词真的去搜
  '{"op":"repo","keyword":"x","limit":99999999999999999999,"platforms":"NOPE"}',    // 20 位整数：5.1 曾误判成非整数
];

/** I2 判定（纯函数）：五行响应必须"四拒 + 一放行到分发"，且全都没触网 */
function serveTypeVerdict(rows) {
  const bad = [];
  if (rows.length !== I2_LINES.length) return [`响应行数 ${rows.length} ≠ ${I2_LINES.length}（进程没跑完 / 少了一行响应）`];
  const [limStr, ok, excl, kwNum, huge] = rows;
  if (limStr.ok !== false || String(limStr.error) !== 'limit must be an integer') bad.push('limit:"5" 没在分发前被拒：' + JSON.stringify(limStr).slice(0, 140));
  if (ok.ok !== false || !/^unknown platforms/.test(String(ok.error))) bad.push('合法类型没走到分发（阴性对照失败）：' + JSON.stringify(ok).slice(0, 140));
  if (excl.ok !== false || String(excl.error) !== 'excludeArchived must be a boolean') bad.push('excludeArchived:"false" 没被拒：' + JSON.stringify(excl).slice(0, 140));
  if (kwNum.ok !== false || String(kwNum.error) !== 'keyword is required (non-empty string)') bad.push('keyword:5 没被拒：' + JSON.stringify(kwNum).slice(0, 140));
  if (huge.ok !== false || !/^unknown platforms/.test(String(huge.error))) bad.push('20 位整数被误判成"不是整数"：' + JSON.stringify(huge).slice(0, 140));
  rows.forEach((r, i) => { if (!(typeof r.ms === 'number' && r.ms < 5000)) bad.push(`第 ${i} 行 ms=${r.ms} —— 类型闸没在分发前拦（真发请求要 10s+）`); });
  return bad;
}

test('U-295-I1: 值的类型 —— python 与 -Serve 的判决和文案逐例相等（5.1 / 7 各跑一遍）', async () => {
  const py = await readPyTypeVerdicts();
  for (const exe of ['powershell', 'pwsh']) {
    const ps = await readPsTypeVerdicts(ENTRY, exe);
    const v = typeViolations(py, ps);
    assert.deepEqual(v, [], `${exe} 与 python 的类型判定不一致：\n  ${v.join('\n  ')}`);
  }
  // 阳性对照：矩阵里必须有真被 python 拒的用例，否则"两边都 ACCEPT"也能全绿
  const rejected = Object.values(py).filter((x) => !x.ok).length;
  assert.ok(rejected >= 15, `python 只拒了 ${rejected}/${TYPE_CASES.length} 例 —— 矩阵退化了`);
});

test('U-295-I2: 真起 -Serve —— 类型错在分发前被拒（零网络），类型合法必须走到分发', async () => {
  for (const exe of ['powershell', 'pwsh']) {
    const r = await serveLines(ENTRY, I2_LINES, 180000, exe);
    assert.equal(r.st, 0, `${exe} -Serve rc=${r.st}: ${(r.err || '').slice(-400)}`);
    const v = serveTypeVerdict(rowsOf(r.out));
    assert.deepEqual(v, [], `${exe} 的类型闸没在真进程里生效：\n  ${v.join('\n  ')}`);
  }
});

test('U-295-I-neg: 整数判定退回强转 / 表里把 bool 写成 str 必红，只改注释不红', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'u295i-neg-'));
  const lib0 = fs.readFileSync(path.join(ROOT, 'lib', 'serve.ps1'), 'utf8');
  const clone = (name, patchLib) => {
    const dst = path.join(tmp, name);
    fs.mkdirSync(path.join(dst, 'lib'), { recursive: true });
    fs.mkdirSync(path.join(dst, 'engines'), { recursive: true });
    fs.writeFileSync(path.join(dst, 'multi-platform-searcher.ps1'), ENTRY_SRC, 'utf8');
    for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) {
      const s = fs.readFileSync(path.join(ROOT, 'lib', f), 'utf8');
      fs.writeFileSync(path.join(dst, 'lib', f), f === 'serve.ps1' ? patchLib(s) : s, 'utf8');
    }
    for (const f of fs.readdirSync(path.join(ROOT, 'engines'))) fs.copyFileSync(path.join(ROOT, 'engines', f), path.join(dst, 'engines', f));
    return path.join(dst, 'multi-platform-searcher.ps1');
  };
  try {
    const py = await readPyTypeVerdicts();

    // ① 退回旧口径：整数判定 = "PS 能强转成 int 就算"（v1.78 之前就是这样）
    const GOOD_LINE = "$good = if ($kind -eq 'int') { Test-ServeIntegral -Value $v }";
    const castEntry = clone('cast', (s) => {
      assert.ok(s.includes(GOOD_LINE), '整数判定锚点漂了');
      return s.replace(GOOD_LINE, "$good = if ($kind -eq 'int') { try { $null = [int]$v; $true } catch { $false } }");
    });
    const v1 = typeViolations(py, await readPsTypeVerdicts(castEntry, 'powershell'));
    assert.ok(v1.some((x) => x.startsWith('limit-str')), '退回强转后 limit:"5" 仍被判类型错 ⇒ I1 没在量类型判定：' + v1.join(' | '));
    // 同一条变异在真进程里也要看得到：那行不再被类型闸拒，而是走到分发
    const castRows = rowsOf((await serveLines(castEntry, I2_LINES.slice(0, 1), 180000, 'powershell')).out);
    assert.equal(castRows.length, 1, '变异副本没回一行响应');
    assert.equal(castRows[0].ok, false, '变异副本没回拒绝（应被平台校验拒，而不是类型闸）');
    assert.match(String(castRows[0].error), /^unknown platforms/, '退回强转后 limit:"5" 仍被拦在类型闸 ⇒ 拒绝不是类型闸干的：' + castRows[0].error);

    // ② 表里把 excludeArchived 的类型写成 str ⇒ "false" 字符串被放行，判决与 python 相反
    const KIND_LINE = "excludeArchived = 'bool'";
    const strEntry = clone('kind', (s) => {
      assert.ok(s.includes(KIND_LINE), 'excludeArchived 类型锚点漂了');
      return s.replace(KIND_LINE, "excludeArchived = 'str'");
    });
    const v2 = typeViolations(py, await readPsTypeVerdicts(strEntry, 'powershell'));
    assert.ok(v2.some((x) => x.startsWith('excl-strfalse')), '把 bool 改成 str 后 excl-strfalse 没变红：' + v2.join(' | '));

    // ③ 只改注释 ⇒ 不该红（判据只看结构化内容，不跟文本变）
    const noteEntry = clone('note', (s) => s.replace('v1.81.0：**值的类型**也要两层同判', 'v1.81.0：（改写过的说明）值的类型也要两层同判'));
    assert.notEqual(fs.readFileSync(path.join(path.dirname(noteEntry), 'lib', 'serve.ps1'), 'utf8'), lib0, '注释变异没生效');
    assert.deepEqual(typeViolations(py, await readPsTypeVerdicts(noteEntry, 'powershell')), [], '只改注释不该判红');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
