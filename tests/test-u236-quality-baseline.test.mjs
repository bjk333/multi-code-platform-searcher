// U-236（v1.53.19，2026-10-24）：质量基线要"可复算"，且**不许被当成金标**。
//   背景：付费上架需要一句可承诺的话，而当时的答案是"取决于你怎么写查询"。
//   做法：evals/quality-baseline.ps1 —— 12 个典型查询 × 每个 3–5 个生态公认仓库，算 Hit@3 / Hit@K / MRR@K。
//   本门只钉**契约与口径**，不联网（联网跑一次要 1 分钟，且网络抖动会让门假红）：
//     ① 用例数 ≥10、每个查询的期望集 ≥3 项、期望项必须是 ASCII 小写 repo 名；
//     ② 三项指标真的被计算（不是只打印查询）；
//     ③ 口径必须写明"弱标注、非人工金标、只证明主流答案进没进前 K"；
//     ④ 基线报告必须留档（reports/quality-baseline-*.md 存在且含读数）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'evals', 'quality-baseline.ps1');
const SRC = fs.existsSync(SCRIPT) ? fs.readFileSync(SCRIPT, 'utf8') : '';

test('U-236 A: 质量基线的用例集必须够用（≥10 查询，每个期望集 ≥3 项）', () => {
  assert.ok(fs.existsSync(SCRIPT), '★ 缺 evals/quality-baseline.ps1');
  const cases = [...SRC.matchAll(/@\{\s*q\s*=\s*'([^']+)'\s*;\s*want\s*=\s*@\(([^)]*)\)/g)]
    .map((m) => ({ q: m[1], want: [...m[2].matchAll(/'([^']*)'/g)].map((x) => x[1]) }));
  assert.ok(cases.length >= 10, `★ 用例太少（${cases.length}）：样本少于 10 个，命中率没有统计意义`);
  const bad = [];
  for (const c of cases) {
    if (c.want.length < 3) bad.push(`"${c.q}" 期望集只有 ${c.want.length} 项（≥3 才有容错）`);
    for (const w of c.want) if (!/^[a-z0-9._-]+$/.test(w)) bad.push(`"${c.q}" 的期望项 "${w}" 不是小写 ASCII repo 名`);
  }
  assert.deepEqual(bad, [], '★ 用例集不合格：\n' + bad.join('\n'));
});

test('U-236 B: 三项指标必须真的被计算（Hit@3 / Hit@K / MRR@K）', () => {
  assert.match(SRC, /hit3/, '★ 缺 Hit@3 计算');
  assert.match(SRC, /\$hit3Rate/, '★ 缺 Hit@3 百分比');
  assert.match(SRC, /mrrSum/, '★ 缺 MRR 累加');
  assert.match(SRC, /1\.0\s*\/\s*\$rank|1\/\$rank/, '★ MRR 必须是 1/rank，不是 1/命中数');
});

test('U-236 C: 口径必须写明"弱标注、非人工金标"（否则数字会被当成质量结论）', () => {
  assert.match(SRC, /弱标注/, '★ 缺"弱标注"声明');
  assert.match(SRC, /不是人工金标|非人工金标/, '★ 必须明说不是人工金标');
  assert.match(SRC, /主流答案/, '★ 必须限定"只证明主流答案有没有进前 K"');
  // 报告正文也要带同一口径（读者只看报告）
  const reports = fs.readdirSync(path.join(ROOT, 'reports')).filter((f) => /^quality-baseline-.*\.md$/.test(f));
  assert.ok(reports.length > 0, '★ 缺 reports/quality-baseline-*.md：基线必须留档，否则无法对比回退');
  const md = fs.readFileSync(path.join(ROOT, 'reports', reports.sort().pop()), 'utf8');
  assert.match(md, /弱标注/, '★ 报告正文缺"弱标注"口径');
  assert.match(md, /Hit@3/, '★ 报告正文缺 Hit@3 读数');
});

test('U-236 D: 基线必须能判"回退"（报告里要有可对比的读数与用法）', () => {
  const reports = fs.readdirSync(path.join(ROOT, 'reports')).filter((f) => /^quality-baseline-.*\.md$/.test(f)).sort();
  const md = fs.readFileSync(path.join(ROOT, 'reports', reports[reports.length - 1]), 'utf8');
  assert.match(md, /n=\d+/, '★ 报告缺样本数 n');
  assert.match(md, /MRR@\d/, '★ 报告缺 MRR 读数');
  assert.match(md, /回退|下降/, '★ 报告缺"怎么判回退"的用法说明');
});
