// U-158 · R97「溯源 + 自证」—— A 信封 / B 诚实边界+篡改必红 / C 确定性重建 / D 白名单差分
//
// 设计取舍（先写清，免得后面被自己的实现绕进去）：
//  · "构建物" = **发货集合的确定性 tar.gz**（发货集合取自 M-15 镜像 `reports/_skill-assets.root.json`，
//    即"会被发布出去的 116 个文件"）。tar 与 gzip 都**在 Node 内自建**（零外部依赖、零基建），
//    因此字节完全由我们掌控 —— 这是"两次独立构建逐字节相等"能成立的前提。
//  · **不写时间戳进 statement**：SLSA 常见字段 `startedOn/finishedOn` 会让 statement 每次不同（不可复现）。
//    本件把时间统一钉在 `SOURCE_DATE_EPOCH` 上（默认固定常数，env 可覆盖），并**在文档里写明**。
//  · **B 的核心**：statement 是对**工作树**的声明 ⇒ 复验 = **重新推导** predicate（逐文件 sha256）并与
//    statement 比对。因此**篡改 predicate 必红**，而且不是靠"签名"，是靠"重新算得出来"。
//  · **静态签名只证身份与字节未被改动，不证明结论为真** —— 这句必须写在交付物里（B 的文档要求）。
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(testsDir, '..');
const MIRROR = path.join(root, 'reports/_skill-assets.root.json');
const PROVDIR = path.join(root, 'reports/provenance');
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');

// 确定性时间锚：默认固定常数（可 env 覆盖）。**statement 与 tar 都用它** ⇒ 重跑逐字节一致。
const SDE = Number(process.env.SOURCE_DATE_EPOCH || 1700000000);
const BUILD_TYPE = 'mcps/deterministic-tar-gz/v1';

function shippedPaths() {
  const m = JSON.parse(fs.readFileSync(MIRROR, 'utf8').replace(/^\uFEFF/, ''));
  return Object.keys(m.assets[0].fileHashes).sort();     // 已排序 ⇒ 归档顺序确定
}
function version() {
  const s = fs.readFileSync(path.join(root, 'multi-platform-searcher.ps1'), 'utf8');
  const v = /^\$VERSION = "([0-9.]+)"$/m.exec(s)?.[1];
  assert.ok(v, '取不到 $VERSION');
  return v;
}

// ---------- 最小 USTAR 写入（512 对齐；mode/uid/gid/mtime 全固定 ⇒ 确定性） ----------
function tarHeader(name, size) {
  const b = Buffer.alloc(512);
  const put = (off, s) => { b.write(s, off, 'utf8'); };
  put(0, name);
  put(100, '0000644\0');                                     // mode
  put(108, '0000000\0');                                     // uid
  put(116, '0000000\0');                                     // gid
  put(124, size.toString(8).padStart(11, '0') + '\0');       // size
  put(136, SDE.toString(8).padStart(11, '0') + '\0');        // mtime = SOURCE_DATE_EPOCH
  put(148, '        ');                                      // 校验和先填空格
  b[156] = 0x30;                                             // typeflag '0' = 普通文件
  put(257, 'ustar\0'); put(263, '00');
  let sum = 0; for (const x of b) sum += x;
  put(148, sum.toString(8).padStart(6, '0') + '\0 ');        // 校验和
  return b;
}
function buildTar(paths) {
  const parts = [];
  for (const p of paths) {
    const data = fs.readFileSync(path.join(root, p));
    parts.push(tarHeader(p, data.length));
    parts.push(data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(1024));                            // 两个全零块收尾
  return Buffer.concat(parts);
}
// gzip：固定头（MTIME=0、OS=0xff）+ 固定压缩级别 ⇒ 同一输入必得同一字节
function gzipDeterministic(buf) {
  const gz = zlib.gzipSync(buf, { level: 9 });
  gz[4] = gz[5] = gz[6] = gz[7] = 0;                          // MTIME = 0
  gz[9] = 0xff;                                              // OS = unknown
  return gz;
}
function buildBundle() {
  const paths = shippedPaths();
  const tar = buildTar(paths);
  const gz = gzipDeterministic(tar);
  return { paths, tar, gz, digest: sha256(gz) };
}

// ---------- predicate（= 对工作树的声明）与 verification（= 重新推导后比对） ----------
function derivePredicate(paths) {
  const files = {};
  for (const p of paths) files[p] = sha256(fs.readFileSync(path.join(root, p)));   // paths 已排序 ⇒ 键序确定
  return {
    buildType: BUILD_TYPE,
    externalParameters: { sourceDateEpoch: SDE, version: version(), fileCount: paths.length },
    files,
  };
}
function makeStatement(bundle) {
  return {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [{ name: `multi-code-platform-searcher-${version()}`, digest: { sha256: bundle.digest } }],
    predicateType: 'https://slsa.dev/provenance/v1',
    predicate: derivePredicate(bundle.paths),
  };
}
// 复验：① 重新构建 ⇒ subject.digest 必须相等 ② 重新推导 predicate ⇒ 必须与声明逐字段相等
function verifyStatement(stmt, opts = {}) {
  const reasons = [];
  const paths = opts.paths || shippedPaths();
  const rebuilt = opts.digest || buildBundle().digest;
  if (stmt?.subject?.[0]?.digest?.sha256 !== rebuilt) reasons.push('subject.digest 与本次重建不一致');
  const want = derivePredicate(paths);
  if (JSON.stringify(stmt?.predicate?.files) !== JSON.stringify(want.files)) reasons.push('predicate.files 与工作树重新推导结果不一致');
  if (stmt?.predicate?.externalParameters?.fileCount !== want.externalParameters.fileCount) reasons.push('predicate.fileCount 不一致');
  return { ok: reasons.length === 0, reasons };
}

// ---------- D：白名单字段差分 ----------
const DIFF_WHITELIST = ['at', 'root', 'durationSec', 'log', 'ElapsedMs', 'P95LatencyMs', 'WorkingSetMB', 'EngineMs'];
function diffPaths(a, b, p = '', out = []) {
  if (a === b) return out;
  const bothObj = a && b && typeof a === 'object' && typeof b === 'object';
  if (!bothObj) { out.push(p || '<root>'); return out; }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) diffPaths(a?.[k], b?.[k], p ? p + '.' + k : k, out);
  return out;
}
function whitelistDiff(a, b, wl = DIFF_WHITELIST) {
  return diffPaths(a, b).filter(p => !wl.includes(p.split('.').pop()));
}

let bundle1, bundle2, stmt, stmtPath, tmp;
before(() => {
  bundle1 = buildBundle();
  bundle2 = buildBundle();             // 独立第二次构建
  stmt = makeStatement(bundle1);
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'u158-'));
  stmtPath = path.join(PROVDIR, `statement-${version()}.json`);
});
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 由系统清 */ } });

// ================= C · 确定性重建 =================
test('U-158 C: 两次独立构建逐字节 SHA-256 相等（tar 内建 + gzip 固定头）', () => {
  assert.equal(bundle1.gz.length, bundle2.gz.length, '两次构建字节数必须相等');
  assert.equal(bundle1.digest, bundle2.digest, '两次构建 sha256 必须相等');
  assert.ok(bundle1.paths.length >= 100, '发货集合应 ≥100，实得 ' + bundle1.paths.length);
  // 反证：改动一个"活"字段（MTIME）必须导致字节变化 —— 说明上面相等不是"怎么改都一样"
  const gzMut = Buffer.from(bundle1.gz);
  gzMut[4] = 1;
  assert.notEqual(sha256(gzMut), bundle1.digest, 'MTIME 变了 sha 必须变（证明显式固定 MTIME 是有效手段）');
});
test('U-158 C 负例: 归档顺序若被打破（改成非排序）⇒ sha 必须变', () => {
  const unsorted = [...bundle1.paths].reverse();
  const alt = gzipDeterministic(buildTar(unsorted));
  assert.notEqual(sha256(alt), bundle1.digest, '顺序敏感 ⇒ 排序是确定性的必要成分');
});

// ================= A · in-toto Statement =================
test('U-158 A: 生成最小 in-toto Statement（单机零基建）并落盘 reports/provenance/', () => {
  assert.equal(stmt._type, 'https://in-toto.io/Statement/v1');
  assert.equal(stmt.predicateType, 'https://slsa.dev/provenance/v1');
  assert.match(stmt.subject[0].digest.sha256, /^[a-f0-9]{64}$/);
  assert.equal(stmt.predicate.buildType, BUILD_TYPE);
  fs.mkdirSync(PROVDIR, { recursive: true });
  const bytes = JSON.stringify(stmt, null, 2) + '\n';
  const prev = fs.existsSync(stmtPath) ? fs.readFileSync(stmtPath, 'utf8') : null;
  if (prev === null) {
    fs.writeFileSync(stmtPath, bytes, 'utf8');                     // 首次生成
  } else if (process.env.U158_REGEN === '1') {
    fs.writeFileSync(stmtPath, bytes, 'utf8');                     // 显式重生（确认是发货集合合法变更后）
  } else {
    // ★默认**不静默自愈**：落盘 statement 与当前工作树不符（陈旧或被篡改）⇒ 判红。
    //   否则"篡改必红"只在内存里成立，落盘那份照样可以被改掉而无人知。
    assert.equal(prev, bytes,
      'Statement 与当前工作树不一致（陈旧或被篡改）⇒ 判红。若确为发货集合的合法变更，用 U158_REGEN=1 重新生成。');
  }
  // 幂等第二证：再造一次陈述并比对（不依赖上一次落盘）
  assert.equal(JSON.stringify(makeStatement(buildBundle())), JSON.stringify(stmt), 'Statement 构造必须确定性');
});

// ================= B · 诚实边界 + 篡改必红 =================
test('U-158 B1: 未篡改时复验通过（重新推导 predicate 与重建 digest 都对得上）', () => {
  const r = verifyStatement(stmt);
  assert.equal(r.ok, true, '干净声明必须复验通过，实得 reasons=' + JSON.stringify(r.reasons));
});
test('U-158 B2: ★篡改 predicate ⇒ 复验必红', () => {
  const tampered = JSON.parse(JSON.stringify(stmt));
  const firstKey = Object.keys(tampered.predicate.files)[0];
  tampered.predicate.files[firstKey] = 'f'.repeat(64);
  const r = verifyStatement(tampered);
  assert.equal(r.ok, false, '篡改 predicate 必须被判红');
  assert.match(r.reasons.join(' '), /predicate\.files/, '红的原因必须是 predicate 被改动');
  // 反向：篡改 subject.digest 也必须红
  const t2 = JSON.parse(JSON.stringify(stmt));
  t2.subject[0].digest.sha256 = 'a'.repeat(64);
  assert.equal(verifyStatement(t2).ok, false, '篡改 subject.digest 必须红');
});
test('U-158 B3: 诚实边界成文 —— 「签名/哈希只证身份与字节未改动，不证明结论为真」', () => {
  const dir = path.join(root, 'reports/provenance');
  const doc = path.join(dir, 'README-边界说明.md');
  assert.ok(fs.existsSync(doc), '必须随 statement 交付边界说明（reports/provenance/README-边界说明.md）');
  const t = fs.readFileSync(doc, 'utf8');
  assert.match(t, /不证明.{0,6}为真|不证明结论/, '边界说明必须写明"不证明结论为真"');
  assert.match(t, /身份|签发者/, '边界说明必须写明其能证明的是身份/字节未被改动');
});

// ================= D · 白名单字段差分 =================
test('U-158 D1: 只差白名单字段 ⇒ 视为通过；差非白名单字段 ⇒ 判红（并定位到字段）', () => {
  const base = { at: 1, root: '/a', durationSec: 600, cells: [{ k: 'x', status: 'pass', rc: 0, result: 'ok', log: 'l1' }] };
  const same = JSON.parse(JSON.stringify(base));
  assert.deepEqual(whitelistDiff(base, same), []);
  const volatileOnly = JSON.parse(JSON.stringify(base));
  volatileOnly.at = 999; volatileOnly.root = '/b'; volatileOnly.durationSec = 700; volatileOnly.cells[0].log = 'l2';
  assert.deepEqual(whitelistDiff(base, volatileOnly), [], '白名单字段变化不得判红');
  const real = JSON.parse(JSON.stringify(base));
  real.cells[0].status = 'fail';
  const d = whitelistDiff(base, real);
  assert.deepEqual(d, ['cells.0.status'], '非白名单差异必须被判出并定位（实得 ' + JSON.stringify(d) + '）');
  const rc = JSON.parse(JSON.stringify(base)); rc.cells[0].rc = 1;
  assert.deepEqual(whitelistDiff(base, rc), ['cells.0.rc']);
});
test('U-158 D2: 对真实产物做差分 —— 两次构建的 predicate 不得有非白名单差异', () => {
  const p1 = derivePredicate(bundle1.paths);
  const p2 = derivePredicate(bundle2.paths);
  assert.deepEqual(whitelistDiff(p1, p2), [], '两次独立推导的 predicate 必须无差异');
  // 正例锚点：把 subject.digest 抽出来单独比（这正是 prediff 里"只比 subject.digest/cells 字段"的落点）
  assert.equal(stmt.subject[0].digest.sha256, bundle2.digest);
});
