// U-174：DeepSeek `rerank_score` 阈值标定契约（v4 P1-b）
//   背景：`engines/deepseek-search.ps1` 的默认门槛 `$minScore = 1.0` 原为手写值，
//         与官方口径（≥1.5 为高质量）不一致，且无实测依据。
//   实测（2026-10-19，两次独立采样一致）：正常查询 39 条最低 1.703 / 无意义查询 30 条最高 0.317
//         ⇒ 分离带 1.386，算术中点 1.010 ⇒ **建议默认 1.0 = 现值**（maximin 最优）。详见
//         reports/gates/p1b-rerank-calibration-2026-10-19/README.md
//   ★ 本门**不联网**：靠 ① 标定器 --self-test（合成数据）② 默认值 == 报告建议值 ③ 报告含实测带
//     行为证据见上述报告目录（samples.json / samples2.json）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = fs.readFileSync(path.join(ROOT, 'engines', 'deepseek-search.ps1'), 'utf8');
const CALIBRATOR = path.join(ROOT, 'reports', 'health', 'rerank-calibrate.mjs');
const REPORT = path.join(ROOT, 'reports', 'gates', 'p1b-rerank-calibration-2026-10-19', 'README.md');

// 引擎默认门槛（`$minScore = 1.0`，且可被 MCPS_DEEPSEEK_MIN_SCORE 覆盖）
function engineDefault() {
  const m = ENGINE.match(/\$minScore\s*=\s*([\d.]+)\s*$/m);
  return m ? Number(m[1]) : NaN;
}

// 报告里的「建议默认 X」—— 标定结果必须与引擎默认值同源
function reportRecommendation(text) {
  const m = String(text).match(/建议默认\s*([\d.]+)/);
  return m ? Number(m[1]) : NaN;
}

// 纯函数：判定「默认值是否与标定建议一致」（供负例单测，不触碰磁盘）
function consistent(engineValue, reportValue) {
  return Number.isFinite(engineValue) && Number.isFinite(reportValue) && Math.abs(engineValue - reportValue) < 1e-9;
}

function runSelfTest() {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CALIBRATOR, '--self-test'], { cwd: ROOT, windowsHide: true });
    let out = '';
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const timer = setTimeout(() => { try { p.kill(); } catch {} done({ code: null, out: out + '\n[timeout]' }); }, 120000);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('error', (e) => { clearTimeout(timer); done({ code: null, out: 'spawn error: ' + e.message }); });
    p.on('close', (c) => { clearTimeout(timer); done({ code: c, out }); });
  });
}

test('U-174-1: 标定器存在且 --self-test 4/4 通过（含空样本拒绝判定）', async () => {
  assert.ok(fs.existsSync(CALIBRATOR), '标定器 reports/health/rerank-calibrate.mjs 必须存在');
  const r = await runSelfTest();
  assert.equal(r.code, 0, `self-test 必须 rc=0，实际 ${r.code}\n${r.out.slice(-600)}`);
  assert.match(r.out, /self-test: 4\/4 PASS/, '必须 4/4 全过');
  assert.match(r.out, /PASS\s+空样本必须 refused/, '★ 空样本拒绝判定这条用例不得缺失（否则回到「0 样本也算通过」）');
});

test('U-174-2: 空样本短路必须存在（源码级防回归）', () => {
  const src = fs.readFileSync(CALIBRATOR, 'utf8');
  assert.match(src, /if \(L\.length === 0 \|\| N\.length === 0\)/, 'analyze() 必须在 L/N 为空时短路');
  assert.match(src, /refused: true/, '必须返回 refused 标记（而不是继续扫描）');
  assert.match(src, /process\.exitCode = 2/, '空样本必须以 rc=2 退出，不得 rc=0');
});

test('U-174-3: 引擎默认门槛 == 标定报告建议值（改默认必须同步重标定）', () => {
  assert.ok(fs.existsSync(REPORT), '标定报告必须存在');
  const e = engineDefault();
  const r = reportRecommendation(fs.readFileSync(REPORT, 'utf8'));
  assert.ok(Number.isFinite(e), `引擎里必须能读到 $minScore 默认值，实际 ${e}`);
  assert.ok(Number.isFinite(r), `报告里必须写明「建议默认 X」，实际 ${r}`);
  assert.equal(e, r, `引擎默认 ${e} 与标定建议 ${r} 不一致 —— 改默认值必须重新标定并更新报告`);
});

test('U-174-4: 报告必须留实测分离带（防止只写结论不写依据）', () => {
  const t = fs.readFileSync(REPORT, 'utf8');
  assert.match(t, /1\.703/, '必须记录 L 组最低分 1.703');
  assert.match(t, /0\.317/, '必须记录 N 组最高分 0.317');
  assert.match(t, /1\.386/, '必须记录分离带宽 1.386');
  assert.match(t, /maximin/i, '必须写明选点规则（maximin）');
  assert.match(t, /authority/i, '必须记录 authority 不可用作过滤条件的结论');
});

test('U-174-5: 负例 —— 默认值与建议值不一致时必须判为不一致', () => {
  assert.equal(consistent(1.0, 1.0), true, '相同值应一致');
  assert.equal(consistent(1.0, 1.7), false, '★ 若把建议值写成 1.7 而引擎仍 1.0，必须判为不一致');
  assert.equal(consistent(1.7, 1.0), false, '★ 反向同理');
  assert.equal(consistent(NaN, 1.0), false, '缺值必须判为不一致（不得默认通过）');
  // 并确认真实文件走的是同一判定
  const e = engineDefault();
  const r = reportRecommendation(fs.readFileSync(REPORT, 'utf8'));
  assert.equal(consistent(e, r), true, '当前仓库状态必须自洽');
});
