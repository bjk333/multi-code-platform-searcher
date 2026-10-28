// R5-P1-1 · 「问答证据**可辨**」门
//
// 背景（本轮量化，见 reports/gates/r5-research-2026-10-10/p11-*.json）：
//   `-CodeEvidence` 下 `SEExcerpts`（Stack Exchange 社区实现证据）会占相当比例，
//   它的 `File` **装的是问题 ID**（`q19657361`），而其他源 `File` 是**文件路径**（`src/utils/render_retry.c`）。
//   ⇒ **同名不同义**。但**它并非不可辨** —— 实测三处独立特征：
//     ① `Line` **恒空**（真代码源必带行号，实测 grep.app 有 `Line=1`）
//     ② `Desc` **含 `answers:`**（问答独有；`score: N; answers: M; tags: …`）
//     ③ `Url` 指向 `stackoverflow.com/questions/`（域与路径都不同）
//
// 本门做什么：**不为了好看改契约**（改 `File` 的值会连带改去重键 L1239、文档分类 L1352、展示 L2098），
//   而是把"可辨性"钉成**可断言**的 —— 防将来有人把 `Line` 填上、或去掉 `answers:`，
//   那时问答才**真的**变得不可辨。
//
// 判据：① 源码：`File=q$qid` 与 `Line=$null` 并存、`Desc` 构造含 answers
//       ② 行为：真跑一条 code 查询，SEExcerpts 条目**必须**同时满足 Line 空 + Desc 含 answers + Url 域正确
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(testsDir, '..');
const SRC = fs.readFileSync(path.join(root, 'engines/se-excerpts.ps1'), 'utf8').replace(/^\uFEFF/, '');

test('P1-1a（源码）: 问题 ID 塞进 File 的同时，必须显式 Line=$null 且 Desc 带 answers', () => {
  assert.match(SRC, /\$file\s*=\s*"q\$qid"/, 'File 目前装的是问题 ID（q<id>）—— 本门据此断言可辨性');
  assert.match(SRC, /Line\s*=\s*\$null/, '★必须显式置 Line=$null（这是"非源码"的第一判据）');
  assert.match(SRC, /Desc\s*=\s*\("score: \{0\}; answers: \{1\}/, '★Desc 必须含 answers（问答独有的第二判据）');
  assert.match(SRC, /Url\s*=\s*\[string\]\$item\.link/, 'Url 必须来自 SE 的 link（stackoverflow.com/questions/…）');
});

test('P1-1b（行为 · 真跑）: SEExcerpts 条目必须三特征齐备，否则问答将真的不可辨', async () => {
  const r = await new Promise(res => {
    const c = spawn('pwsh', ['-NoProfile', '-File', 'multi-platform-searcher.ps1',
      '-Keyword', 'retry backoff implementation', '-CodeEvidence', '-Limit', '12', '-MinStars', '0', '-NoCache', '-AsJson'],
      { cwd: root, windowsHide: true });
    let o = ''; c.stdout.on('data', d => { o += d; });
    const t = setTimeout(() => c.kill('SIGKILL'), 180000);
    c.once('close', code => { clearTimeout(t); res({ code, o }); });
    c.once('error', x => res({ code: null, o: '', e: x.message }));
  });
  let j = null; try { j = JSON.parse(r.o.slice(r.o.indexOf('{'))); } catch { }
  assert.ok(j, '真跑必须能解析出 JSON（否则本门是空跑）');
  const se = ((j.results) || []).filter(x => x.Platform === 'SEExcerpts');
  if (!se.length) {
    console.log('[P1-1] 本次真跑没有 SEExcerpts 条目（可能限流/超时）—— 源码判据仍生效，行为判据本轮跳过');
    return;
  }
  const bad = se.filter(x => {
    const lineEmpty = (x.Line === null || x.Line === undefined || x.Line === '');
    const descHasAnswers = /answers:/.test(String(x.Desc || ''));
    const urlOk = /stack(overflow|exchange)\.com\/questions\//.test(String(x.Url || ''));
    return !(lineEmpty && descHasAnswers && urlOk);
  });
  console.log(`[P1-1] SEExcerpts 条目 ${se.length} 条，三特征不全的 ${bad.length} 条`);
  assert.equal(bad.length, 0,
    '★这些条目**无法**与真代码区分（Line 非空 / Desc 无 answers / Url 非 SE 域）:\n  ' +
    bad.slice(0, 3).map(x => `${x.Name} | Line=${x.Line} | Desc=${String(x.Desc).slice(0, 40)} | Url=${String(x.Url).slice(0, 50)}`).join('\n  '));
});
