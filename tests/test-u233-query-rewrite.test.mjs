// U-233（v1.53.16，2026-10-23）：repo/code 检索式的两处**准确度**修复。
//   病灶 1（打包词稀释）：GitHub 搜索是 AND，`rust http client library` 四词全中才算 ——
//     reqwest 描述是 "An easy and powerful Rust HTTP Client"（无 library）⇒ 出局。
//     实测（本机 GitHub，-Limit 5 -NoCache）：
//       "rust http client library" ⇒ rust-http(已废弃 ★390) / nyquest / libsql-client-rs / vaultrs / databento-rs
//       "rust http client"         ⇒ reqwest ★11885 / h2 ★1556 / ureq ★2215
//   病灶 2（中文主题词抽不出来）：v1.45.3 只抽 ASCII 词，主题词是中文时 repo 检索式只剩语言名 ⇒ 按 star 泛化。
//     实测："向量数据库" ⇒ document.ai / funNLP / x86-bare-metal-examples（与主题无关）
//           "vector database" ⇒ milvus ★46462 / tidb / redis / quivr
//           "分布式锁" ⇒ Some-Many-Books / x86-bare-metal-examples
//           "distributed lock" ⇒ ShedLock / redsync / redisson / rueidis
//
//   本门只钉**确定性行为**（改写是纯字符串函数，不依赖网络）；召回改善的实测读数在
//   reports/调研能力验收-准确性效率归因-2026-10-23.md 与 v1.53.16 报告里。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { sourceAll } from './lib/source.mjs';
import { PS as PS_EXE, PS_ARGS } from './lib/interp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PS = PS_EXE;
const SRC = sourceAll(path.join(ROOT));

// 一次探针跑完全部用例（点源 7000 行脚本约 1-2s，逐条起进程没必要）。
const QUERIES = [
  'rust http client library',
  'rust http client',
  'rust library',
  'library',
  'benchmark',
  'stripe api',
  'jwt',
  'python web framework benchmark',
  'tokio vs async-std',
  '调研 rust 生态的异步运行时选型',
  '分布式锁的几种实现方式',
  '向量数据库',
  '中文分词开源库',
  'kafka 消息积压怎么办',
  '怎么学习 k8s',
  '检索增强生成 RAG',
  '如何设计限流',
];

const PROBE = `
$ErrorActionPreference = 'Stop'
. ./multi-platform-searcher.ps1 -NoEnvFile -Keyword x -Limit 1
$rows = @()
foreach ($q in [System.IO.File]::ReadAllLines($env:U233_IN, [System.Text.Encoding]::UTF8)) {
  if (-not $q) { continue }
  $rows += ($q + "\`t" + (Get-AutoSearchKeyword -Keyword $q))
}
[System.IO.File]::WriteAllLines($env:U233_OUT, $rows, (New-Object System.Text.UTF8Encoding($false)))
`;

let cache = null;
function rewriteAll() {
  if (cache) return cache;
  cache = new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u233-'));
    const inFile = path.join(dir, 'in.txt');
    const outFile = path.join(dir, 'out.txt');
    const f = path.join(dir, 'probe.ps1');
    fs.writeFileSync(inFile, QUERIES.join('\n'), 'utf8');
    const prelude = `$env:U233_IN = '${inFile.replace(/\\/g, '\\\\')}'\n$env:U233_OUT = '${outFile.replace(/\\/g, '\\\\')}'\n`;
    fs.writeFileSync(f, '\ufeff' + prelude + PROBE, 'utf8');
    const child = spawn(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', f], { cwd: ROOT, windowsHide: true, env: { ...process.env, MCPS_NO_MAIN: '1' } });
    let out = '', err = '';
    const killer = setTimeout(() => { try { child.kill(); } catch { } reject(new Error('U-233 probe timeout')); }, 120000);
    child.stdout.on('data', (b) => { out += b.toString('utf8'); });
    child.stderr.on('data', (b) => { err += b.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(killer); reject(e); });
    child.on('close', () => {
      clearTimeout(killer);
      try {
        const map = new Map();
        for (const line of fs.readFileSync(outFile, 'utf8').split('\n')) {
          const s = line.replace(/\r$/, '');
          if (!s) continue;
          const [q, kw] = s.split('\t');
          map.set(q, kw);
        }
        resolve(map);
      } catch (e) {
        reject(new Error(`probe failed: ${String(e).slice(0, 200)} / ${out.slice(0, 200)} / ${err.slice(0, 200)}`));
      } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { } }
    });
    child.stdin.end();
  });
  return cache;
}

test('U-233 A: 打包词必须从 repo/code 检索式里剥掉（AND 稀释的主流库出局）', async () => {
  const m = await rewriteAll();
  const got = m.get('rust http client library');
  console.log(`  "rust http client library" → "${got}"`);
  assert.equal(got, 'rust http client', '★ library 这类打包词必须剥掉，否则主流库被 AND 滤掉');
});

test('U-233 B: 剥词不得把检索式削到 1 个词（宁可不改，也不能更泛）', async () => {
  const m = await rewriteAll();
  const cases = [
    ['rust library', 'rust library'],
    ['library', 'library'],
    ['benchmark', 'benchmark'],
    ['stripe api', 'stripe api'],
    ['jwt', 'jwt'],
  ];
  const bad = [];
  for (const [q, want] of cases) {
    const got = m.get(q);
    if (got !== want) bad.push(`"${q}" → "${got}"（期望原样 "${want}"）`);
  }
  assert.deepEqual(bad, [], '★ 去停用词后不足 2 个词时必须整批保留：\n' + bad.join('\n'));
});

test('U-233 C: 中文主题词必须映射成英文（否则 repo 只剩语言名，按 star 泛化）', async () => {
  const m = await rewriteAll();
  const cases = [
    ['调研 rust 生态的异步运行时选型', 'rust async runtime'],
    ['分布式锁的几种实现方式', 'distributed lock'],
    ['向量数据库', 'vector database'],
    ['如何设计限流', 'rate limit'],
  ];
  const bad = [];
  for (const [q, want] of cases) {
    const got = m.get(q);
    if (got !== want) bad.push(`"${q}" → "${got}"（期望 "${want}"）`);
  }
  assert.deepEqual(bad, [], '★ 中文主题词映射未生效：\n' + bad.join('\n'));
});

test('U-233 D: 映射必须最长匹配，且不得对无关中文乱猜', async () => {
  const m = await rewriteAll();
  // 最长匹配：「中文分词」不能被「分词」截胡（截胡会丢掉 chinese，检索式变成泛词）
  assert.equal(m.get('中文分词开源库'), 'chinese word segmentation', '★ 「中文分词」必须优先于「分词」');
  // 未覆盖的中文不猜：命不中映射表时保留 ASCII 词，不臆造英文
  assert.equal(m.get('kafka 消息积压怎么办'), 'kafka', '★ 未收录的主题词不得臆造英文');
  assert.equal(m.get('怎么学习 k8s'), 'k8s', '★ 纯工具名查询不得被改写');
});

test('U-233 E: 查询自带缩写时不得再把全称 AND 进去（避免二次稀释）', async () => {
  const m = await rewriteAll();
  assert.equal(m.get('检索增强生成 RAG'), 'RAG', '★ 已有 RAG 时再加 retrieval augmented generation 只会更窄');
});

test('U-233 F: 停用词/打包词剥离对英文同样生效（不再对纯英文原样放行）', async () => {
  const m = await rewriteAll();
  assert.equal(m.get('python web framework benchmark'), 'python web benchmark', '★ framework 属打包词');
  assert.equal(m.get('tokio vs async-std'), 'tokio async-std', '★ vs 属停用词');
});

test('U-233 G: 映射表契约（键含中文、值是小写 ASCII 检索词、无空值）', () => {
  const block = SRC.slice(SRC.indexOf('$script:ZhTopicTermMap'), SRC.indexOf('function Get-ZhTopicExpansion'));
  assert.ok(block.length > 0, '★ 找不到 ZhTopicTermMap 定义');
  const entries = [...block.matchAll(/^\s*'([^']+)'\s*=\s*'([^']*)'/gm)].map((m) => [m[1], m[2]]);
  assert.ok(entries.length >= 40, `★ 映射表条目过少（${entries.length}）：覆盖不到常见中文主题词等于没修`);
  const bad = [];
  for (const [k, v] of entries) {
    if (!/[\u4e00-\u9fff]/.test(k)) bad.push(`键「${k}」不含中文`);
    if (!v) bad.push(`键「${k}」值为空`);
    if (/[^a-z0-9 .+#_-]/.test(v)) bad.push(`键「${k}」值「${v}」不是小写 ASCII 检索词`);
    if (v.split(/\s+/).some((w) => w.length === 0)) bad.push(`键「${k}」值有多余空格`);
  }
  assert.deepEqual(bad, [], '★ 映射表格式违规：\n' + bad.join('\n'));
  // 反例：映射值不能只是泛词（等于把查询换成别的泛词，召回不会变准）
  const generic = new Set(['library', 'framework', 'tool', 'tools', 'code', 'project', 'api', 'sdk']);
  const weak = entries.filter(([, v]) => generic.has(v)).map(([k]) => k);
  assert.deepEqual(weak, [], '★ 以下键映射成了泛词（等于没映射）：' + weak.join(', '));
});

test('U-233 H: 改写原因必须可审计（进 warnings，且区分映射与剥词）', () => {
  assert.match(SRC, /中文主题词→英文/, '★ 告警必须点名「中文主题词→英文」，否则用户不知道检索式怎么来的');
  assert.match(SRC, /去停用\/打包词/, '★ 告警必须点名「去停用/打包词」');
  // 研究源必须仍用原句（改写只对 repo/code）
  assert.match(SRC, /research 仍用原句|原句留给研究源/, '★ 必须明示 research 用原句，不能被改写污染');
});
