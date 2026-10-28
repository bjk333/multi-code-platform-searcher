// U-285（v1.67.0）：**证据外置工具**的真值表 + 保留策略。
//
// 病在哪：`tests/reports-quota.json` 把 `reports/` 钉在 546 个文件，而每个版本必然 +1 张门日志、+1 份 Statement
//   ⇒ 每次发版都要手工"挑两旧的外置"。2026-10-27 一天之内手工做了五次，其中**一次挑中了被 08-实施记录 引用的日志** ——
//   删完才想起去 grep。手工流程没有拒绝条件，就会删掉还被引用的东西。
//
// 这个门守两件事：
//   ① `scripts/archive-reports.ps1` 的四条安全边界（只收 reports/ 下 · 保护名单 · 被引用即拒绝 · 先校验后删源）；
//   ② **保留策略**：`reports/provenance/statement-*.json` 只留最近 3 份，且当前版本的那份必须在。
//      没有 ②，① 就只是个"更方便的删除命令"—— 没有任何东西阻止证据无限堆积。
//
// 归档根默认在仓外（CI 上不存在）⇒ 所有"归档内容"的检查都在临时目录里做，不依赖那台机器的路径。
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPwsh } from './r2-ps-run.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'scripts', 'archive-reports.ps1');

/** 造一个最小仓库：reports/ + references/ + scripts/ */
function mkRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u285-'));
  fs.mkdirSync(path.join(dir, 'repo', 'reports', 'x'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'repo', 'references'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'repo', 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'arch'), { recursive: true });
  fs.copyFileSync(TOOL, path.join(dir, 'repo', 'scripts', 'archive-reports.ps1'));
  const put = (rel, text) => fs.writeFileSync(path.join(dir, 'repo', rel), text, 'utf8');
  put('reports/x/clean.txt', 'evidence A\n');
  put('reports/x/cited.txt', 'evidence B\n');
  put('reports/note.md', '记录里引用 x/cited.txt 这份证据\n');
  put('reports/x/.env', 'TOKEN=secret\n');
  return {
    dir,
    repo: path.join(dir, 'repo'),
    arch: path.join(dir, 'arch'),
    tool: path.join(dir, 'repo', 'scripts', 'archive-reports.ps1'),
    manifest: path.join(dir, 'arch', 'MANIFEST.tsv'),
    rm: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

const rows = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#')) : []);
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

test('U-285-A 干净文件：复制 → 校验 → 追加 MANIFEST → 删源', async () => {
  const t = mkRepo();
  try {
    const r = await runPwsh(['-File', t.tool, '-Path', 'x/clean.txt', '-ArchiveRoot', t.arch]);
    assert.equal(r.status, 0, 'rc 应为 0：' + r.stdout + r.stderr);
    assert.equal(fs.existsSync(path.join(t.repo, 'reports', 'x', 'clean.txt')), false, '源文件必须已删');
    const dst = path.join(t.arch, 'x', 'clean.txt');
    assert.equal(fs.existsSync(dst), true, '归档副本必须存在');
    assert.equal(sha(dst), sha(path.join(t.arch, 'x', 'clean.txt')), '副本哈希自洽');
    const rs = rows(t.manifest);
    assert.equal(rs.length, 1, 'MANIFEST 应恰好多一行：' + JSON.stringify(rs));
    const cols = rs[0].split('\t');
    assert.equal(cols.length, 4, 'MANIFEST 四列：路径 / size / sha256 / mtime');
    assert.equal(cols[0], 'x/clean.txt');
    assert.match(cols[2], /^[a-f0-9]{64}$/, 'sha256 必须是小写 64 位');
  } finally { t.rm(); }
});

test('U-285-B ★ 被文档引用 ⇒ 拒绝（rc=3，源文件原样保留，MANIFEST 不增行）', async () => {
  const t = mkRepo();
  try {
    const r = await runPwsh(['-File', t.tool, '-Path', 'x/cited.txt', '-ArchiveRoot', t.arch]);
    assert.equal(r.status, 3, '拒绝时 rc 必须是 3（与"跑失败"区分）：' + r.stdout + r.stderr);
    assert.match(r.stdout, /拒绝/, '输出必须说清为什么拒绝：' + r.stdout);
    assert.equal(fs.existsSync(path.join(t.repo, 'reports', 'x', 'cited.txt')), true, '被拒的文件必须还在');
    assert.equal(rows(t.manifest).length, 0, '拒绝时不许写 MANIFEST');
  } finally { t.rm(); }
});

test('U-285-C 保护名单（.env）⇒ 抛错拒绝，源文件保留', async () => {
  const t = mkRepo();
  try {
    const r = await runPwsh(['-File', t.tool, '-Path', 'x/.env', '-ArchiveRoot', t.arch]);
    assert.notEqual(r.status, 0, '保护名单必须拒绝');
    assert.match(r.stdout + r.stderr, /保护名单/, '理由要指名保护名单');
    assert.equal(fs.existsSync(path.join(t.repo, 'reports', 'x', '.env')), true);
  } finally { t.rm(); }
});

test('U-285-D -DryRun：只打印计划，一个字节都不动', async () => {
  const t = mkRepo();
  try {
    const r = await runPwsh(['-File', t.tool, '-Path', 'x/clean.txt', '-ArchiveRoot', t.arch, '-DryRun']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /预演/);
    assert.equal(fs.existsSync(path.join(t.repo, 'reports', 'x', 'clean.txt')), true, '预演不许删源');
    assert.equal(fs.existsSync(path.join(t.arch, 'x', 'clean.txt')), false, '预演不许写归档');
    assert.equal(rows(t.manifest).length, 0, '预演不许写 MANIFEST');
  } finally { t.rm(); }
});

test('U-285-E -AllowCited：显式放行，但要留可见告警（"-已放行"必须出现）', async () => {
  const t = mkRepo();
  try {
    const r = await runPwsh(['-File', t.tool, '-Path', 'x/cited.txt', '-ArchiveRoot', t.arch, '-AllowCited']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout + r.stderr, /AllowCited|放行/, '放行必须在输出里留痕');
    assert.equal(fs.existsSync(path.join(t.repo, 'reports', 'x', 'cited.txt')), false);
    assert.equal(rows(t.manifest).length, 1);
  } finally { t.rm(); }
});

test('U-285-F MANIFEST 是**追加**：已有的行一个都不许被重写', async () => {
  const t = mkRepo();
  try {
    const old = 'old/keep.txt\t11\t' + 'a'.repeat(64) + '\t2020-01-01T00:00:00.000Z';
    fs.writeFileSync(t.manifest, '# 相对 reports/ 的路径\tsize\tsha256\tmtime\n' + old + '\n', 'utf8');
    await runPwsh(['-File', t.tool, '-Path', 'x/clean.txt', '-ArchiveRoot', t.arch]);
    const rs = rows(t.manifest);
    assert.equal(rs.length, 2, '旧行 + 新行：' + JSON.stringify(rs));
    assert.equal(rs[0], old, '旧行必须逐字节保留');
  } finally { t.rm(); }
});

test('U-285-G ★ 保留策略：provenance 只留最近 3 份 Statement，且当前版本必须在', () => {
  const dir = path.join(ROOT, 'reports', 'provenance');
  const have = fs.readdirSync(dir).filter((f) => /^statement-\d+\.\d+\.\d+\.json$/.test(f));
  const ver = [...have].sort((a, b) => {
    const va = a.match(/(\d+)\.(\d+)\.(\d+)/).slice(1).map(Number);
    const vb = b.match(/(\d+)\.(\d+)\.(\d+)/).slice(1).map(Number);
    return va[0] - vb[0] || va[1] - vb[1] || va[2] - vb[2];
  });
  assert.ok(ver.length <= 3, `provenance 里留了 ${ver.length} 份 Statement（${ver.join(', ')}）—— 只许留最近 3 份；用 scripts/archive-reports.ps1 把旧的移出去`);
  const scriptVer = (fs.readFileSync(path.join(ROOT, 'multi-platform-searcher.ps1'), 'utf8').match(/^\$VERSION = "([\d.]+)"/m) || [])[1];
  assert.ok(scriptVer, '没读到 $VERSION');
  assert.ok(ver.some((f) => f === `statement-${scriptVer}.json`), `当前版本 ${scriptVer} 的 Statement 必须在场（否则 U-158 会红）`);
});
