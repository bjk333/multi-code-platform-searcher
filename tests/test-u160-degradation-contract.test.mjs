// U-160 · R3-L「降级语义」契约层（L1 四态派生 + L2 unreachable/errors）
//
// 本批**只做 L1/L2**（对外契约）；**L3 Full Jitter 与 L4 每源桶是行为变更**（动退避与限流，波及 timing 敏感门），
// 留独立批次 —— 见 reports/U-160-预注册判据-2026-10-03.md §5。
//
// 设计要点（外部模型协作 + 我核实后采纳）：
//   ★**四态只许由 5 值 Verdict 机械派生，不得独立赋值** —— 从根上避免"同一事实两处说法"
//     （本仓曾因 results=20 与 ReasonCodes=zero-hit 并存而自相矛盾）。
//   ★`errors[].code` **引用**既有 ReasonCodes，**本 schema 刻意不复制该枚举**（复制必漂移）⇒ 由本门做交叉核对。
//   ★**成功的零命中（zero-hit）绝不得进 unreachable[]，也不得进 errors[]**（否则即"空跑冒充成功"）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceAll } from './lib/source.mjs';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(testsDir, '..');
const MAIN = sourceAll(path.join(root));
const SCHEMA = JSON.parse(fs.readFileSync(path.join(root, 'schema/asjson.schema.json'), 'utf8').replace(/^\uFEFF/, ''));
const SAMPLE = JSON.parse(fs.readFileSync(path.join(root, 'reports/gates/u89-real-asjson.json'), 'utf8').replace(/^\uFEFF/, ''));

// ---------- 派生表（本门独立实现一份，用来**交叉核对**主脚本的 switch） ----------
const DERIVE = { full: 'ok', partial: 'partial', degraded: 'partial', none: 'failed', 'no-engines': 'empty' };
const VERDICT_ENUM = ['full', 'partial', 'degraded', 'none', 'no-engines'];
const derive = v => DERIVE[v] ?? 'failed';

// 从主脚本 switch 里解析实际映射（不信任注释；只认 `'x' { return 'y' }` 形状）
function parsePsSwitch(src) {
  const fn = /function Get-ContractStatus \{[\s\S]*?switch \(\$Verdict\) \{([\s\S]*?)\n    \}/.exec(src);
  assert.ok(fn, 'Get-ContractStatus 必须存在且为 switch 形状（锚点变了要同步改本门）');
  const map = {};
  for (const m of fn[1].matchAll(/'([a-z-]+)'\s*\{\s*return\s*'([a-z]+)'\s*\}/g)) map[m[1]] = m[2];
  return map;
}
const PS_MAP = parsePsSwitch(MAIN);

// 从主脚本解析 ReasonCodes 的**唯一真源**（switch ($st) { 'x' { 'code' } } + error 分支的 deadline|error）
function parseReasonCodes(src) {
  const fn = /switch \(\$st\) \{([\s\S]*?)\n    \}/.exec(src);
  assert.ok(fn, 'ReasonCodes switch 必须存在');
  const codes = new Set();
  for (const m of fn[1].matchAll(/'([a-z_]+)'\s*\{\s*'([a-z-]+)'\s*\}/g)) codes.add(m[2]);
  // error 分支：if (... 超时词 ...) { 'deadline' } else { 'error' }
  for (const m of fn[1].matchAll(/'(deadline|error)'/g)) codes.add(m[1]);
  // user-disabled 由 MCPS_DISABLE 路径单独写入
  if (/user-disabled/.test(src)) codes.add('user-disabled');
  return codes;
}
const REASON_CODES = parseReasonCodes(MAIN);

test('U-160 L1-a: 四态派生表与主脚本 switch 逐项一致，且恰好覆盖 5 个 Verdict 取值', () => {
  assert.deepEqual(PS_MAP, DERIVE, '主脚本 switch 必须与本门独立实现的派生表逐项相同');
  for (const v of VERDICT_ENUM) assert.ok(v in PS_MAP, `Verdict 取值 ${v} 必须在派生表里有落点`);
  assert.equal(Object.keys(PS_MAP).length, VERDICT_ENUM.length, '不得有多余或缺失的 Verdict 分支');
  // 四态取值必须恰好是契约这四个
  assert.deepEqual([...new Set(Object.values(PS_MAP))].sort(), ['empty', 'failed', 'ok', 'partial']);
});

test('U-160 L1-b: schema 的 status 枚举 = 四态；且与派生产物同域', () => {
  assert.deepEqual(SCHEMA.properties.status.enum, ['ok', 'partial', 'empty', 'failed']);
  assert.deepEqual([...new Set(Object.values(DERIVE))].sort(), [...SCHEMA.properties.status.enum].sort());
});

test('U-160 L1-c: 真样本上 status 必须等于由 coverage.Verdict 派生之值（且不得为 null/缺省）', () => {
  assert.ok('status' in SAMPLE, '真样本必须含 status');
  assert.equal(SAMPLE.status, derive(SAMPLE.coverage.Verdict),
    `status(${SAMPLE.status}) 必须等于 derive(${SAMPLE.coverage.Verdict})=${derive(SAMPLE.coverage.Verdict)}`);
});

test('U-160 L1-负例: 与派生值不符的 status、以及把 none 错映射成 empty，都必须被判红', () => {
  const check = (payload, map) => {
    const want = map[payload.coverage.Verdict] ?? 'failed';
    return payload.status === want;
  };
  const bad = { ...SAMPLE, status: SAMPLE.coverage.Verdict === 'full' ? 'failed' : 'ok' };
  assert.equal(check(bad, DERIVE), false, '手写不符的 status 必须被判红');
  // ★最要命的一种：把 none（有请求零执行=失败）错映射成 empty（"搜了没结果"）
  const wrongMap = { ...DERIVE, none: 'empty' };
  assert.notDeepEqual(wrongMap, DERIVE);
  assert.equal(check({ coverage: { Verdict: 'none' }, status: 'empty' }, wrongMap), true, '错误映射在此实现下会"通过"');
  assert.equal(check({ coverage: { Verdict: 'none' }, status: 'empty' }, DERIVE), false, '本仓正确映射必须判红它');
});

test('U-160 L2-a: unreachable 只许由 network_unavailable 构造（成功的零命中绝不得进入）', () => {
  // 构造块跨多行（管道 + Where-Object + ForEach-Object）⇒ 截到下一个同级语句为止，别只取首行
  const block = /(\$unreachableOut = @\([\s\S]*?)\n    \$errorsOut/.exec(MAIN)?.[1] ?? '';
  assert.ok(block, 'unreachable 的构造块必须存在');
  assert.match(block, /network_unavailable/, '必须按 network_unavailable 过滤');
  assert.doesNotMatch(block, /'ok'|'empty'|zero-hit/, '★不得把 ok/empty/zero-hit 纳入 unreachable');
  // 真样本侧：unreachable 每个 path 必须有 engines/ 前缀
  for (const u of SAMPLE.unreachable) assert.match(u.path, /^engines\./, 'path 形状必须是 engines.<名>');
});

test('U-160 L2-b: errors 只收「未成功」的引擎，且 code ∈ 主脚本 ReasonCodes 唯一真源', () => {
  const block = /(\$errorsOut = @\([\s\S]*?\n    \}\)\n)/.exec(MAIN)?.[1] ?? '';
  assert.ok(block, 'errors 的构造块必须存在');
  assert.match(block, /-notin @\('ok', 'empty'\)/, '★必须排除 ok|empty（即 zero-hit 不得进 errors）');
  assert.match(block, /reasonCodes/, 'code 必须取自既有 ReasonCodes（引用，不复制）');
  // 真样本侧
  for (const e of SAMPLE.errors) {
    assert.ok(REASON_CODES.has(e.code), `errors[].code=${e.code} 必须在主脚本 ReasonCodes 枚举内`);
    assert.notEqual(e.code, 'zero-hit', '★zero-hit 是**成功**，绝不得出现在 errors');
  }
});

test('U-160 L2-c: schema 对 unreachable/errors 项封闭（additionalProperties:false + 完整 required），且**不复制** ReasonCodes 枚举', () => {
  for (const k of ['unreachable', 'errors']) {
    const it = SCHEMA.properties[k].items;
    assert.equal(it.additionalProperties, false, `${k} 项必须封闭`);
    assert.ok(Array.isArray(it.required) && it.required.length > 0, `${k} 项必须给 required`);
  }
  // ★本仓纪律：closed + **完整 required** ⇒ 直接校验该**不变式**，而不是硬编码字段名单。
  //   硬编码名单有两个毛病：① 有人加字段时假红（R4-F1-c 加 errors[].message 即如此，且加的是**必填**字段、
  //   完全符合本纪律）② 它其实**没检查"完整"**——名单写死就永远"完整"，加了字段反而漏检。
  //   ⇒ 改为 required ≡ properties 的键集（更强，且与 R95-A 的 closed+full-required 口径一致）。
  for (const k of ['unreachable', 'errors']) {
    const it = SCHEMA.properties[k].items;
    assert.deepEqual(it.required.slice().sort(), Object.keys(it.properties).sort(),
      `${k} 项必须 closed + 完整 required（required 必须恰好等于全部属性键）`);
  }
  // ★单源纪律：errors[].code 不得内联枚举（复制即漂移）
  assert.equal(SCHEMA.properties.errors.items.properties.code.enum, undefined,
    'errors[].code 不得在 schema 里内联枚举（唯一真源在主脚本 switch，由本门交叉核对）');
  assert.ok(REASON_CODES.size >= 5, 'ReasonCodes 真源应至少 5 个码，实得 ' + REASON_CODES.size);
});

test('U-160 L2-负例: zero-hit 混进 unreachable / errors，或 code 超出枚举，都必须被判红', () => {
  const checkPayload = (p) => {
    for (const u of p.unreachable) if (!/^engines\./.test(u.path)) return false;
    for (const e of p.errors) {
      if (e.code === 'zero-hit') return false;                 // 成功不得进 errors
      if (!REASON_CODES.has(e.code)) return false;             // 必须 ∈ 枚举
    }
    return true;
  };
  assert.equal(checkPayload({ unreachable: [], errors: [] }), true);
  assert.equal(checkPayload({ unreachable: [], errors: [{ path: 'engines/GitLab', code: 'zero-hit' }] }), false,
    '★把成功的零命中记成错误必须判红');
  assert.equal(checkPayload({ unreachable: [], errors: [{ path: 'engines/X', code: 'made-up-code' }] }), false,
    '枚举外的码必须判红');
  assert.equal(checkPayload({ unreachable: [{ path: 'GitLab@zero-hit' }], errors: [] }), false,
    'path 形状不对必须判红');
});

test('U-160 L2-d: 顶层三字段已纳入 schema 的 payload 分支 required（且兜底分支显式互斥）', () => {
  const req = SCHEMA.oneOf[0].required;
  for (const k of ['status', 'unreachable', 'errors']) assert.ok(req.includes(k), `payload 分支 required 必须含 ${k}`);
  const notAny = SCHEMA.oneOf[1].not.anyOf;
  for (const k of ['status', 'unreachable', 'errors']) {
    assert.ok(notAny.some(x => (x.required || []).includes(k)), `兜底分支必须显式排斥 ${k}`);
  }
});

// ---------- L2-e：★跨源交叉核对（补洞）----------
// 背景（整技能验收实测）：samples 里 unreachable/errors 恰为空 ⇒ 上面那些基于**样本**的 path 形状断言
//   **一条都没真正执行**，于是"代码发点号、schema 写斜杠"的不一致藏了整整一轮，直到端到端模式矩阵才暴露。
//   ⇒ 这里不看样本，直接对**源码构造的字面量前缀** 与 **schema pattern 的前缀** 做交叉核对。
test('U-160 L2-e: ★源码里 path 的字面量前缀 == schema pattern 的前缀（空样本藏不住不一致）', () => {
  const lit = /path = "(engines[./])/.exec(MAIN)?.[1];
  assert.ok(lit, '必须能从源码构造里抽出 path 的字面量前缀（锚点变了要同步改本门）');
  const pat = SCHEMA.properties.errors.items.properties.path.pattern;
  assert.ok(pat && pat.startsWith('^'), 'schema 必须给 path 一个带 ^ 的 pattern');
  // 逐字符取"字面量前缀"：普通字面量字符累加；\x 转义还原成字面量 x；遇到元字符即止。
  // （首版用 split 字符类，把 . 也当分隔符 ⇒ 只得到 "engines"，自伤一次，已改。）
  let s = pat.replace(/^\^/, ""); let patPrefix = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\") { patPrefix += s[i + 1]; i++; continue; }
    if (/[A-Za-z0-9_/.\-]/.test(ch)) { patPrefix += ch; continue; }
    break;
  }
  assert.equal(patPrefix, lit,
    `★源码发 "${lit}" 而 schema 期望 "${patPrefix}" ⇒ 路径形状不一致（实测踩过：样本数组为空时无人察觉）`);
});

// ---------- L3-a / L3-b（U-164，2026-10-04）：另两个顶层包要不要四态 ----------
test('U-160 L3-a: -ResearchBatch 顶层包也带 status，且**与主载荷同一套四态、同一份派生表**', () => {
  const rb = SCHEMA.$defs.researchBatch;
  assert.ok(rb, 'schema 必须有 #/$defs/researchBatch');
  assert.ok(rb.required.includes('status'), 'researchBatch.required 必须含 status');
  assert.ok(rb.properties.status, 'researchBatch.properties 必须有 status');
  assert.deepEqual(rb.properties.status.enum, SCHEMA.properties.status.enum,
    '★四态枚举必须与主载荷**完全一致**（不许各搞一套）');
  // PS 侧：必须**复用** Get-ContractStatus，而不是给 batch 另写一份映射
  assert.match(MAIN, /status = Get-ContractStatus -Verdict \$batchVerdict/,
    'batch 必须复用主载荷那份派生函数');
  // 负例：给 batch 独立写映射（形如 status = if (...)）⇒ 必须被判红
  const independent = /status\s*=\s*if\s*\(/.test(MAIN);
  assert.equal(independent, false, '★不得给 batch 独立写映射（会与主载荷漂移）');
});

test('U-160 L3-b（决策落成断言）: doctor 顶层包**不**带 status —— 它没有 Verdict ⇒ 无派生源', () => {
  // doctor 响应是 [PSCustomObject]@{ version; mode='doctor'; doctor=... }，**没有 coverage/Verdict**
  const m = /\$doctorOut = \[PSCustomObject\]@\{([^}]*)\}/.exec(MAIN);
  assert.ok(m, '必须能找到 doctor 响应的构造（锚点变了要同步改本门）');
  assert.doesNotMatch(m[1], /status/i, '★doctor 不得带 status：没有 Verdict 可派生，' +
    '硬给就是"编一个状态"（本仓纪律：宁可不给，也不假装有）');
  // 并且 doctor 确实没有 coverage/Verdict —— 这是"不补"的**依据**，必须成立
  assert.doesNotMatch(m[1], /coverage|Verdict/i, 'doctor 若将来有了 Verdict，本断言会失败并要求重新决策');
});
