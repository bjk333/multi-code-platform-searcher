// U-227（v1.53.6，2026-10-23）：发布器自动改写"纯版本锚点"。
//
// 动机：v1.53.4 与 v1.53.5 连续两批都栽在 `$VERSION` 变量漏改（门 U-139 的 `u139ScriptVersion()`
//   真正读的就是它）⇒ "8 处手工版本戳"靠人记不可行。把**只含版本号**的 7 处交给发布器。
//
// 判据（三层）：
//   ① 行为：把函数体抠出来在临时目录里跑 —— 7 处全部改成目标版本；
//      ★ 正文里的**历史版本引用**（如 `（v0.9.0）`）必须原样不动（这就是"按行定位 + 行内替换"的意义，
//      全文批量替换会把文档里的历史记录改烂，而门抓不住这种"改对了但改多了"）；
//   ② 幂等：同版本再跑一次返回空；
//   ③ 接线：调用必须早于"复制+算哈希"（否则改动不进本次哈希）；负例：删调用 / 挪到哈希后 ⇒ 红。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sourceAll } from './lib/source.mjs';
import { PS as PS_EXE, PS_ARGS } from './lib/interp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = fs.readFileSync(path.join(ROOT, 'scripts', 'publish-skill.ps1'), 'utf8');
const MAIN_SRC = sourceAll(path.join(ROOT));

// 函数体：从函数头到下一个顶层注释块（'# ---- U-46'）之间
const FN_START = 'function Sync-VersionAnchors {';
const FN_END = '# ---- U-46：镜像再生成';
function extractFn(src) {
  const i = src.indexOf(FN_START);
  const j = src.indexOf(FN_END, i);
  assert.ok(i >= 0 && j > i, '锚点缺失：Sync-VersionAnchors 函数体');
  return src.slice(i, j);
}

function runPs(body, tmpDir, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u227-'));
    const f = path.join(dir, 'probe.ps1');
    const outFile = path.join(dir, 'out.txt');
    fs.writeFileSync(f, '\ufeff' + body, 'utf8');
    // U-278：壳名与参数都按平台取（POSIX 上只有 pwsh，且它不认 -ExecutionPolicy）
    const c = spawn(PS_EXE, [...PS_ARGS, '-File', f], {
      windowsHide: true, env: { ...process.env, U227_OUT: outFile, U227_TMP: tmpDir },
    });
    let err = '';
    const killer = setTimeout(() => { try { c.kill(); } catch { /* 已退出 */ } reject(new Error('timeout')); }, timeoutMs);
    c.stderr.on('data', (b) => { err += b.toString('utf8'); });
    c.on('error', (e) => { clearTimeout(killer); reject(e); });
    c.on('close', () => {
      clearTimeout(killer);
      let out = '';
      try { out = fs.readFileSync(outFile, 'utf8'); } catch { /* 探针崩溃 */ }
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 系统清 */ }
      resolve({ out: out.trim(), err: err.trim() });
    });
    c.stdin.end();
  });
}

// 临时目录里造 7 个最小文件；正文明含"历史版本引用"作为诱饵
const FIXTURE = {
  'SKILL.md': '---\nname: fixture\n  version: "1.0.0"\n---\n\n- 历史：v0.9.0 的旧行为（（v0.9.0）不得被改）\n',
  'multi-platform-searcher.ps1': '# Multi-Code-Platform Searcher PowerShell Tool（起版 v1.7.0 · 当前 v1.0.0）\n$VERSION = "1.0.0"\n# 历史锚点（v0.9.0）不得被改\n',
  'references/参数速查.md': '# multi-code-platform-searcher 参数速查（v1.0.0）\n\n| 旧项 | 说明（v0.9.0） |\n',
  'references/引擎链.md': '# multi-code-platform-searcher 引擎链与输出契约（v1.0.0）\n\n历史（v0.9.0）\n',
  'references/故障排查.md': '# multi-code-platform-searcher 故障排查（v1.0.0）\n\n历史（v0.9.0）\n',
  '说明书.md': '# 说明书\n\n- 目录树格式约定：主脚本（vX；唯一 canonical B）\n├── multi-platform-searcher.ps1   # 主脚本（v1.0.0；唯一 canonical B）\n\n历史（v0.9.0）\n',
};

function buildProbe(fnBody, version, extra = '') {
  return `
$ErrorActionPreference = 'Stop'
$tmp = Join-Path $env:U227_TMP 'tree'
${fnBody}
$changed1 = @(Sync-VersionAnchors -Version '${version}' -CanonicalDir $tmp)
$changed2 = @(Sync-VersionAnchors -Version '${version}' -CanonicalDir $tmp)
$rows = @()
$rows += 'changed1=' + ($changed1 -join '|')
$rows += 'changed2=' + ($changed2 -join '|')
${Object.keys(FIXTURE).map((rel) => `$rows += '${rel}=' + ((Get-Content -LiteralPath (Join-Path $tmp '${rel}') -Raw -Encoding UTF8) -replace "\`r?\`n", '\\n')`).join('\n')}
${extra}
[System.IO.File]::WriteAllLines($env:U227_OUT, $rows, (New-Object System.Text.UTF8Encoding($false)))
`;
}

test('U-227 A: 7 处纯版本锚点全部改写；正文历史引用（v0.9.0）原样不动；二次调用幂等', async () => {
  const fnBody = extractFn(PUB);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u227fix-'));
  try {
    for (const [rel, body] of Object.entries(FIXTURE)) {
      const p = path.join(dir, 'tree', rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, body, 'utf8');
    }
    const { out, err } = await runPs(buildProbe(fnBody, '2.0.0'), dir, 120000);
    // 覆盖 U227_TMP：探针需要知道 fixture 根
    assert.ok(out, 'probe 无输出；stderr=' + err.slice(0, 300));
    const rows = Object.fromEntries(out.split(/\r?\n/).filter(Boolean).map((l) => {
      const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)];
    }));
    assert.equal(rows.changed1.split('|').length, 7, '7 处都必须被改写：' + rows.changed1);
    assert.equal(rows.changed2, '', '★ 同版本二次调用必须幂等（返回空）');

    // 正面：目标行已更新
    assert.match(rows['SKILL.md'], /version: "2\.0\.0"/, 'frontmatter 必须改');
    assert.match(rows['multi-platform-searcher.ps1'], /\$VERSION = "2\.0\.0"/, '★ $VERSION 变量必须改（连续两批栽在这）');
    assert.match(rows['multi-platform-searcher.ps1'], /当前 v2\.0\.0/, '主脚本第 1 行必须改');
    assert.match(rows['references/参数速查.md'], /参数速查（v2\.0\.0）/, '参数速查首行必须改');
    assert.match(rows['references/引擎链.md'], /（v2\.0\.0）/, '引擎链首行必须改');
    assert.match(rows['references/故障排查.md'], /（v2\.0\.0）/, '故障排查首行必须改');
    assert.match(rows['说明书.md'], /主脚本（v2\.0\.0/, '说明书目录树必须改');

    // 反面（本门重点）：正文里的历史版本引用不得被改
    assert.match(rows['SKILL.md'], /（v0\.9\.0）不得被改/, '★ 正文历史引用被误改 ⇒ 全文替换的典型事故');
    assert.match(rows['references/参数速查.md'], /说明（v0\.9\.0）/, '★ 表格里的历史引用不得被改');
    assert.match(rows['references/引擎链.md'], /历史（v0\.9\.0）/, '★ 历史行不得被改');
    assert.match(rows['references/故障排查.md'], /历史（v0\.9\.0）/, '★ 历史行不得被改');
    assert.match(rows['说明书.md'], /历史（v0\.9\.0）/, '★ 说明书历史行不得被改');
    // ★模板占位符（vX）与实例行同文件共存 —— LineMatch 写成 `主脚本（v` 会先命中占位符（本函数第一版即如此）
    assert.match(rows['说明书.md'], /主脚本（vX；/, '★ 模板占位符「主脚本（vX；」不得被改（它讲的是格式，不是实例）');
    assert.match(rows['multi-platform-searcher.ps1'], /历史锚点（v0\.9\.0）/, '★ 脚本注释里的历史引用不得被改');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 系统清 */ }
  }
});

function checkWiring(src) {
  assert.match(src, /function Sync-VersionAnchors\s*\{/, '必须存在 Sync-VersionAnchors');
  const iCall = src.indexOf('Sync-VersionAnchors -Version $Version -CanonicalDir $canonicalDir');
  assert.ok(iCall > 0, '★ 发布主流程必须调用 Sync-VersionAnchors（否则 7 处锚点又回到手工）');
  const iHash = src.indexOf('$updatedHashes[$fileName] = Get-Sha256 $src');
  assert.ok(iHash > 0 && iCall < iHash, '★ 调用必须早于"复制+算哈希"—— 否则改动不进本次哈希（U-139 漂移）');
}

test('U-227 B: 调用点在"复制+算哈希"之前（否则改动不进本次哈希）', () => {
  checkWiring(PUB);
});

test('U-227 negative control: 删掉调用 / 挪到哈希之后 —— 都必须被点名', () => {
  const noCall = PUB.replace('Sync-VersionAnchors -Version $Version -CanonicalDir $canonicalDir', '');
  assert.notEqual(noCall, PUB);
  assert.throws(() => checkWiring(noCall), /必须调用 Sync-VersionAnchors/);

  const line = PUB.match(/\n\s*\$anchorChanged = @\(Sync-VersionAnchors -Version \$Version -CanonicalDir \$canonicalDir\)[^\n]*\n(\s*if \(\$anchorChanged\.Count[^\n]*\n)?/);
  assert.ok(line, '锚点缺失：调用行');
  const moved = PUB.replace(line[0], '\n').replace(
    '$updatedHashes[$fileName] = Get-Sha256 $src',
    '$updatedHashes[$fileName] = Get-Sha256 $src' + line[0]);
  assert.notEqual(moved, PUB);
  assert.throws(() => checkWiring(moved), /必须早于/);
});

test('U-227 C: 主脚本确实带 $VERSION（锚点必需项）', () => {
  assert.match(MAIN_SRC, /^\$VERSION\s*=\s*"[^"]+"/m, '主脚本必须有 $VERSION 赋值（分类器与 U-139 都读它）');
});
