// U-179：R94 必须报**不确定性**，而不是一个看起来精确的单点分数（P2-5）
//   背景：`evals/qrels-r94.json` 是冻结快照（1 个 query / 24 条 / **6 源各 4 条**），
//         跑两次读数完全相同 ⇒「多次跑取 std」恒为 0，没有信息量。
//         真正的问题是**每桶样本极小**：P@5 分母恒为 5（TREC 口径）而每桶只有 4 条
//         ⇒ 结构上限 0.8；且 DockerHub / crates.io / npm 三桶**全为 0 相关**（不是"排序差"，是"没有相关标注"）。
//   做法：`evals/r94-variance.ps1` 用**固定种子自助法**给出 mean±std 与 95% 区间，并对 N<5 标 insufficient。
//   本门（全离线，不联网）：
//     A 同种子 ⇒ 逐字节可复现；B 换种子 ⇒ 必须不同（证明重采样真的发生）
//     C 输出形状（每桶 N/P5/ceiling/flag + 汇总 + 告警）
//     D 复用主脚本指标函数，**不重写指标**（两套实现必然漂移）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPwsh } from './r2-ps-run.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'evals', 'r94-variance.ps1');
const SRC = fs.readFileSync(SCRIPT, 'utf8');

const onlyR94V = (r) => ((r.stdout || '') + (r.stderr || '')).split(/\r?\n/).filter((l) => l.startsWith('R94V')).join('\n');

test('U-179 A: 同种子逐字节可复现（否则"方差"本身就是噪声）', async () => {
  const a = await runPwsh(['-File', SCRIPT], { cwd: ROOT, timeoutMs: 300000 });
  const b = await runPwsh(['-File', SCRIPT], { cwd: ROOT, timeoutMs: 300000 });
  assert.equal(a.status, 0, `run A 必须 rc=0，实际 ${a.status}`);
  assert.equal(b.status, 0, `run B 必须 rc=0，实际 ${b.status}`);
  assert.equal(onlyR94V(a), onlyR94V(b), '★ 固定种子必须逐字节一致');
  assert.match(onlyR94V(a), /R94V_OK/, '必须以 R94V_OK 收尾');
});

test('U-179 B: 换种子必须不同（证明重采样真的发生，不是把点估计抄一遍）', async () => {
  const a = await runPwsh(['-File', SCRIPT, '-Seed', '1'], { cwd: ROOT, timeoutMs: 300000 });
  const b = await runPwsh(['-File', SCRIPT, '-Seed', '2'], { cwd: ROOT, timeoutMs: 300000 });
  assert.notEqual(onlyR94V(a), onlyR94V(b), '★ 不同种子输出必须不同');
});

test('U-179 C: 输出形状 —— 每桶带 N / mean±std[CI] / ceiling / flag，且 N<5 必须标 insufficient', async () => {
  const r = await runPwsh(['-File', SCRIPT], { cwd: ROOT, timeoutMs: 300000 });
  const out = onlyR94V(r);
  const buckets = out.split(/\r?\n/).filter((l) => /^R94V \S+ N=/.test(l));
  assert.equal(buckets.length, 6, `必须有 6 个桶，实际 ${buckets.length}`);
  for (const line of buckets) {
    assert.match(line, /N=\d+/, '缺 N');
    assert.match(line, /P5=-?[\d.]+±[\d.]+\[[\d.,]+\]/, `缺 mean±std[CI]：${line}`);
    assert.match(line, /flag=(ok|insufficient)/, `缺 flag：${line}`);
  }
  const points = out.split(/\r?\n/).filter((l) => /^R94V-POINT /.test(l));
  assert.equal(points.length, 6, '必须有 6 行点估计');
  for (const p of points) assert.match(p, /ceiling=[\d.]+/, `点估计必须带结构上限：${p}`);
  assert.match(out, /R94V_SUMMARY buckets=6 insufficient=6/, '当前 qrels 每桶 N=4 ⇒ 6/6 insufficient');
  assert.match(out, /R94V_WARN 6\/6 buckets have N<5/, '★ 必须显式告警"每桶排序不可解释"');
});

test('U-179 D: 复用主脚本指标函数，不得重写指标', () => {
  assert.match(SRC, /Get-PrecisionAtK/, '必须调用 Get-PrecisionAtK');
  assert.match(SRC, /Get-NdcgAtK/, '必须调用 Get-NdcgAtK');
  assert.match(SRC, /Get-ReciprocalRank/, '必须调用 Get-ReciprocalRank');
  assert.match(SRC, /MCPS_NO_MAIN/, '必须 dot-source 主脚本（只取函数）');
  // 不得自带一份指标实现（nDCG 增益/折损公式是最容易分叉的地方）
  const code = SRC.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.doesNotMatch(code, /\[math\]::Pow\(2,\s*\$?rel/, '★ 不得自行实现 nDCG 增益（会造成两套指标漂移）');
  assert.doesNotMatch(code, /\[math\]::Log\(/, '★ 不得自行实现折损函数');
});
