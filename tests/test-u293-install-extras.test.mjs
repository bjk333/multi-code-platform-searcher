// U-293（v1.73.0，2026-10-28 全量验收 F3 的结构性缺口）：**A 副本只能有"已声明的"清单外文件**。
//
// 病在哪（2026-10-28 全量验收实测，两例同一形态）：
//   ① `说明书.md`：源仓明确不随发（U-39），A 副本却带一份 10-20 的旧版（19,016 B；源仓 46,507 B）——
//      门读到的文档能与仓内事实差一个月。v1.72.0 加了根级退役（U-292）才清掉。
//   ② `.github/workflows/skill-regression.yml`：`.yml` 不在 `$PUB_INCLUDE_EXT` ⇒ **从来不是发货资产**，
//      A 副本却留着 10-13 的旧版（CI 口径停在两周前）。本次手工删掉，规则未扩（扩 = 扩大删除面，要人裁决）。
//
// 为什么现有门看不见：`publish` 只 copy 不 delete；U-138 只查"清单 → A"（发全了没）；
//   U-279/U-292 只在**受管目录内**或**已登记根级**动手。于是"A 上多了个文件"这件事
//   **不报错、不影响哈希、不进任何报告** —— 它是本仓唯一一个没有观测面的方向。
//
// 做法：不扩删除面，只把"多余"变成**可观测**：
//   ① 声明一张带理由的白名单（本文件 ALLOW）—— 每一项都是"装好的副本上本来就该有、且永远不该发"；
//   ② 真遍历 A：`清单外文件 ⊆ ALLOW`，否则按名字报红（附处置建议）；
//   ③ 白名单自身有守卫：与清单不得有交集、每项必须有理由、会"被当资产"的项必须在发布器的
//      `$PUB_EXCLUDE_NAMES` 里登记过（两处事实必须对得上，带负例）；
//   ④ 通过路径也留执行标记：遍历到的文件数 ≥ 清单条目数 —— 否则空目录/走错路径也会"绿"。
//
// gate-profile: installed —— 本门是**唯一**应该在安装副本上跑的形态：漂移发生在副本，不在仓内。
//   清单来源按位置切换（仓内读 reports/ 镜像，副本读自带的 skill-assets.json），所以两边都成立。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIRROR = path.join(root, 'reports/_skill-assets.root.json');
const PUB = path.join(root, 'scripts/publish-skill.ps1');

/**
 * 已声明"副本独有"的文件：**永远不该随发**，但装好的副本上本就该有。
 * kind 决定守卫口径（四种排除机制，别混着写）：
 *   - `excluded`  ：发布器把它列在 `$PUB_EXCLUDE_NAMES`（**必须**对得上，见 U-293-D）
 *   - `exact`     ：发布器把它列在 `$PUB_EXCLUDE_EXACT`（带 why 的整路径表）
 *   - `neverCand` ：发布器连候选都不收（扩展名不在 `$PUB_INCLUDE_EXT` / 无扩展名 / 临时物规则）
 *   - `protected` ：发布器的保护名单（`skill-assets.json` 这类"删了会痛"的）
 */
export const ALLOW = {
  '.env': { kind: 'excluded', why: '本机凭据（GITHUB_TOKEN/GITLAB_TOKEN/DEEPSEEK_API_KEY）；同时在保护名单里（删了不可再生）' },
  '.gitignore': { kind: 'neverCand', why: '参与父级大仓 ~/.workbuddy/skills 的忽略规则；扩展名不在 $PUB_INCLUDE_EXT ⇒ 从不入候选' },
  '.audit-lock': { kind: 'neverCand', why: 'U-246 测量互斥锁：跑门期间存在、跑完消失；无扩展名 ⇒ 从不入候选' },
  'skill-assets.json': { kind: 'protected', why: '本机安装清单（publish 每次重写）；保护名单第二档，且非发货资产' },
  '.gate-green.json': { kind: 'excluded', why: 'U-247 门禁凭证：本机最近一次 Node 门读数，跑过门就出现（不是资产）' },
  '.ps-gate.json': { kind: 'excluded', why: 'U-291 PS 套件凭证：本机最近一次 PS 回归读数（不是资产）' },
  'search_cache.json': { kind: 'excluded', why: '检索缓存（运行期产物）：发出去等于把发布者的缓存塞给用户' },
  'source-health.json': { kind: 'excluded', why: 'U-242 跨运行源健康记忆：按机器记"哪些源连不上"，发出去会继承发布者的网络问题' },
  'smart-search_cache.json': { kind: 'exact', why: '检索缓存（smart 一族）：在 $PUB_EXCLUDE_EXACT 登记，源仓可能残留' },
  'run.log': { kind: 'excluded', why: '运行日志（运行期产物，随 CLI 调试调用产生）' },
  '_user_meta.json': { kind: 'excluded', why: '本机用户元数据（安装者信息，绝不能发出去）' },
  'plan_custom_model_eval.json': { kind: 'excluded', why: '本机模型评测计划（U-14x 运行期产物）' },
};

/** 纯函数：把"清单外的相对路径"分成 已声明 / 意外。`\\` 统一成 `/` 再比。 */
export function classifyExtras(extras, allow = ALLOW) {
  const nor = (s) => String(s).replace(/\\/g, '/');
  const allowSet = new Set(Object.keys(allow).map(nor));
  const out = { allowed: [], unexpected: [] };
  for (const e of extras) (allowSet.has(nor(e)) ? out.allowed : out.unexpected).push(nor(e));
  return out;
}

/** 纯函数：解析发布器的 `$PUB_EXCLUDE_NAMES`（去注释后取单引号串）。 */
export function parseExcludeNames(src) {
  const m = /\[string\[\]\]\$PUB_EXCLUDE_NAMES\s*=\s*@\(([\s\S]*?)\)/.exec(src) || /\$PUB_EXCLUDE_NAMES\s*=\s*@\(([\s\S]*?)\)/.exec(src);
  if (!m) return null;
  const body = m[1].split(/\r?\n/).filter(l => !/^\s*#/.test(l)).join('\n');
  return [...body.matchAll(/'([^']+)'/g)].map(x => x[1]);
}

/** 纯函数：解析发布器的 `$PUB_EXCLUDE_EXACT` 键（去注释后取 `'name' =` 左侧）。 */
export function parseExcludeExact(src) {
  const m = /\$PUB_EXCLUDE_EXACT\s*=\s*@\{([\s\S]*?)\n\}/.exec(src);
  if (!m) return null;
  const body = m[1].split(/\r?\n/).filter(l => !/^\s*#/.test(l)).join('\n');
  return [...body.matchAll(/'([^']+)'\s*=/g)].map(x => x[1]);
}

/** 纯函数：解析 `$PUB_INCLUDE_EXT`（收录形态的扩展名白名单）。 */
export function parseIncludeExt(src) {
  const m = /\$PUB_INCLUDE_EXT\s*=\s*@\(([\s\S]*?)\)/.exec(src);
  if (!m) return null;
  return [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
}

/** 纯函数：ALLOW 里 kind=excluded 的项必须都在 `$PUB_EXCLUDE_NAMES` 里。返回缺失项（空 = 一致）。 */
export function excludeGaps(allow = ALLOW, excludeNames = []) {
  const have = new Set(excludeNames);
  return Object.entries(allow)
    .filter(([, v]) => (v.kind || '') === 'excluded')
    .map(([k]) => k)
    .filter(k => !have.has(k));
}

/** 纯函数：kind=exact 的项必须都在 `$PUB_EXCLUDE_EXACT` 里。 */
export function exactGaps(allow = ALLOW, exactKeys = []) {
  const have = new Set(exactKeys);
  return Object.entries(allow)
    .filter(([, v]) => v.kind === 'exact')
    .map(([k]) => k)
    .filter(k => !have.has(k));
}

/** 纯函数：kind=neverCand 的项必须真的"进不了候选"（扩展名不在收录形态里）。 */
export function neverCandViolations(allow = ALLOW, includeExt = []) {
  const ext = new Set(includeExt.map(e => e.toLowerCase()));
  return Object.entries(allow)
    .filter(([, v]) => v.kind === 'neverCand')
    .map(([k]) => k)
    .filter(k => ext.has(path.extname(k).toLowerCase()))
    .map(k => `${k}（扩展名 ${path.extname(k)} 在 $PUB_INCLUDE_EXT 里 ⇒ 它会被当候选，不能算 neverCand）`);
}

export function readManifestKeys(file = MIRROR) {
  const m = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  const a = m.assets ? m.assets[0] : m.files[0];
  return new Set(Object.keys(a.fileHashes || {}));
}

/**
 * 到哪去读"这份副本按哪张清单装的"。
 *   仓内（B）：`reports/_skill-assets.root.json`（父清单镜像，-RegenerateMirror 生成）
 *   副本（A）：**没有** reports/ 镜像（它不在发货清单里）⇒ 退到副本自带的 `skill-assets.json`
 *   ★这个 fallback 是实测撞出来的：本门第一版只读镜像，在 A 上直接跑就 ENOENT 红 ——
 *     "发货的测试在副本上跑不过"正是本仓反复要消灭的那类自相矛盾。
 */
export function manifestFor(aDir) {
  if (fs.existsSync(MIRROR)) return MIRROR;
  const own = path.join(aDir, 'skill-assets.json');
  if (fs.existsSync(own)) return own;
  return null;
}

/** 真遍历：A 副本里所有文件的相对路径（`/` 分隔）。目录不存在 ⇒ null（不是空数组，别把"没装"当"干净"）。 */
export function walk(aDir) {
  if (!aDir || !fs.existsSync(aDir)) return null;
  const out = [];
  for (const ent of fs.readdirSync(aDir, { withFileTypes: true })) {
    const p = path.join(aDir, ent.name);
    if (ent.isDirectory()) {
      const sub = walk(p);
      for (const s of sub) out.push(ent.name + '/' + s);
    } else if (ent.isFile()) out.push(ent.name);
  }
  return out;
}

export function installDir() {
  return path.join(os.homedir(), '.workbuddy', 'skills', 'multi-code-platform-searcher');
}

test('U-293-A: A 副本上每个"清单外文件"都必须是已声明的', (t) => {
  const aDir = installDir();
  const files = walk(aDir);
  if (!files) {
    // 不是"绿"：本机没装 A 副本时这条门没有观测对象，必须**说出来**（假绿比红更危险）
    console.error(`[U-293] skip: 未找到安装副本 ${aDir}（本机无 A 副本 ⇒ 本门无观测对象，非通过）`);
    t.skip('A 副本不存在');
    return;
  }
  const mf = manifestFor(aDir);
  if (!mf) {
    console.error(`[U-293] skip: A 副本 ${aDir} 既无 reports/ 镜像也无自带 skill-assets.json ⇒ 判不了"多余"，非通过`);
    t.skip('清单不存在');
    return;
  }
  const keys = readManifestKeys(mf);
  const extras = files.filter(f => !keys.has(f));
  const { allowed, unexpected } = classifyExtras(extras);
  // ④ 执行标记：走到的文件数必须 ≥ 清单条目数（否则"空目录/走错路径"也会绿）
  console.error(`[U-293] A files=${files.length} manifest=${keys.size} extras=${extras.length} declared=${allowed.length} unexpected=${unexpected.length}`);
  assert.ok(files.length >= keys.size, `A 只走到 ${files.length} 个文件 < 清单 ${keys.size} 项 —— 遍历路径可疑，不许当作通过`);
  assert.deepEqual(unexpected, [],
    'A 副本有清单外文件（既不在清单、也不在已声明白名单）：' + unexpected.join(', ') +
    ' —— 处置二选一：① 它该随发 ⇒ 加进清单并重新发布；② 它不该存在 ⇒ 删掉（若是"有意不随发且永不该有"，登记进 $PUB_EXCLUDE_EXACT 让 U-292 退役它）');
});

test('U-293-B 负例：合成一份"多余文件"，必须按名字报出来（两向，且不落地任何文件）', () => {
  const keys = new Set(['SKILL.md', 'lib/http.ps1']);
  const extras = ['说明书.md', '.github/workflows/skill-regression.yml', '.env', 'search_cache.json'];
  const { allowed, unexpected } = classifyExtras(extras);
  assert.deepEqual(unexpected.sort(), ['.github/workflows/skill-regression.yml', '说明书.md']);
  assert.deepEqual(allowed.sort(), ['.env', 'search_cache.json']);
  // 反向：全部已声明 ⇒ 不该报红（否则门会因为"白名单没生效"而常年红）
  assert.deepEqual(classifyExtras(['.env', '.gitignore']).unexpected, []);
  assert.equal(keys.size, 2);
});

test('U-293-C 守卫：白名单与清单不得有交集，且每项都要有理由', () => {
  const keys = readManifestKeys(manifestFor(installDir()) || MIRROR);
  const both = Object.keys(ALLOW).filter(k => keys.has(k));
  assert.deepEqual(both, [], '同一个文件既是发货资产又是"副本独有" ⇒ 两处事实打架：' + both.join(', '));
  for (const [k, v] of Object.entries(ALLOW)) {
    assert.ok(typeof v.why === 'string' && v.why.length >= 8, `白名单 ${k} 缺理由（排除不留理由 = 下次没人敢删也不敢留）`);
    assert.ok(['excluded', 'exact', 'neverCand', 'protected'].includes(v.kind), `白名单 ${k} 的 kind 不在四档里`);
  }
});

test('U-293-D 守卫：白名单的每项都必须在发布器里找得到对应机制（两处事实对得上，带负例）', () => {
  const src = fs.readFileSync(PUB, 'utf8');
  const names = parseExcludeNames(src);
  const exact = parseExcludeExact(src);
  const incExt = parseIncludeExt(src);
  assert.ok(Array.isArray(names) && names.length >= 5, `解析不到 $PUB_EXCLUDE_NAMES（得到 ${JSON.stringify(names)}）—— 解析器失效时本门必须红，不能静默通过`);
  assert.ok(Array.isArray(exact) && exact.length >= 5, `解析不到 $PUB_EXCLUDE_EXACT（得到 ${JSON.stringify(exact)}）`);
  assert.ok(Array.isArray(incExt) && incExt.length >= 5, `解析不到 $PUB_INCLUDE_EXT（得到 ${JSON.stringify(incExt)}）`);
  assert.deepEqual(excludeGaps(ALLOW, names), [], '这些白名单项会被发布器当成资产候选，却没登记进 $PUB_EXCLUDE_NAMES');
  assert.deepEqual(exactGaps(ALLOW, exact), [], '这些白名单项声明走 -Exact 表，但表里没有');
  assert.deepEqual(neverCandViolations(ALLOW, incExt), [], '这些白名单项声明"进不了候选"，但扩展名其实在收录形态里');
  // 负例：从各自的表里抠掉一项 ⇒ 守卫必须报出来（证明三条都不是恒真）
  assert.deepEqual(excludeGaps(ALLOW, names.filter(n => n !== '.ps-gate.json')), ['.ps-gate.json']);
  assert.deepEqual(exactGaps(ALLOW, exact.filter(n => n !== 'smart-search_cache.json')), ['smart-search_cache.json']);
  // neverCand 的负例用合成表：`.json` 在收录形态里 ⇒ 它不可能是 neverCand
  assert.equal(neverCandViolations({ 'x.json': { kind: 'neverCand' } }, incExt).length, 1);
  assert.equal(neverCandViolations({ 'x.log': { kind: 'neverCand' } }, incExt).length, 0);
});

test('U-293-E 接线：本门真的遍历了磁盘（不是只测了纯函数）', () => {
  const self = fs.readFileSync(new URL(import.meta.url), 'utf8');
  assert.match(self, /walk\(aDir\)/, '必须真遍历 A 副本');
  assert.match(self, /readManifestKeys\(mf\)/, '必须以清单为基准判"多余"（且清单可回退到副本自带的 skill-assets.json）');
  assert.match(self, /manifestFor\(aDir\)/, '清单定位必须是显式函数（仓内读镜像 / 副本读自带清单）');
  // 纯函数被"真实调用"过：A 存在时上面已经用真数据跑过；这里只挡"函数写了没人用"
  assert.match(self, /const \{ allowed, unexpected \} = classifyExtras\(extras\)/);
});

test('U-293-F 负例：走错路径必须返回 null（不是空数组），否则"没装"会被读成"干净"', () => {
  assert.equal(walk(path.join(root, '__definitely_not_here__')), null);
  assert.deepEqual(walk(root)?.includes('SKILL.md'), true);
});
