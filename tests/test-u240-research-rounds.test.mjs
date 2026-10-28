// U-240（2026-10-25）：多轮调研编排器的离线门。
// 判据：① 编排器存在且自测通过；② SKILL.md 有入口与边界（不调用 LLM / --merge）；
//       ③ 工单生成不联网、产出 plan.json + agents/*.md；④ 清单登记；⑤ 源码形态守卫有负例。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PY as PY_EXE } from './lib/interp.mjs';

// ★v1.53.24（2026-10-25 验收 F18）：初版用 spawnSync ⇒ 被 R2 spawn hygiene 判红且已随 v1.53.23 发布。
//   宿主 NODE_OPTIONS 垫片让 spawnSync 恒 EBUSY/status=null ⇒ rc≠0 断言把“没跑”记成“跑红”。
//   改异步 spawn（形态同 tests/r2-ps-run.mjs）+ 失败关闭：没有数字 status 一律抛错。
const root = path.resolve(import.meta.dirname, '..');
const orchestrator = path.join(root, 'research_rounds.py');
const skill = fs.readFileSync(path.join(root, 'SKILL.md'), 'utf8');
const py = PY_EXE;

function run(args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_OPTIONS;
    const child = spawn(py, ['-X', 'utf8', '-B', orchestrator, ...args], { cwd: root, env, windowsHide: true });
    const out = [], err = [];
    let settled = false;
    const settle = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); fn(v); };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
      settle(resolve, { status: null, signal: 'SIGKILL-after-timeout', stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    }, timeoutMs);
    child.stdout.on('data', c => out.push(c));
    child.stderr.on('data', c => err.push(c));
    child.once('error', e => settle(reject, e));
    child.once('close', (status, signal) => settle(resolve, {
      status, signal, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'),
    }));
  });
}

// 失败关闭：status 必须是数字，否则这条门**没跑成**，不能算过。
function assertRan(r, where) {
  if (typeof r.status !== 'number') {
    throw new Error(`${where}: 子进程没有数字退出码（status=${r.status} signal=${r.signal}）—— 这是“没跑”而不是“跑过”，必须判失败。stderr=${(r.stderr || '').slice(0, 400)}`);
  }
  return r;
}

test('U-240 A: 编排器存在且 --self-test 通过', async () => {
  assert.ok(fs.existsSync(orchestrator), 'research_rounds.py 缺失');
  const r = assertRan(await run(['--self-test']), 'U-240 A');
  assert.equal(r.status, 0, (r.stderr || '') + (r.stdout || ''));
  assert.match(r.stdout, /SELFTEST PASS/);
});

test('U-240 B: SKILL.md 有入口、合并方式与边界', () => {
  assert.match(skill, /research_rounds\.py/);
  assert.match(skill, /--merge/);
  assert.match(skill, /不调用 LLM/);
  assert.match(skill, /Relaxed/);
});

test('U-240 C: 工单生成不联网且产出 plan.json + agents/*.md', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'u240-'));
  try {
    const r = assertRan(await run(['--brief', 'agent skill registry', '--out', out, '--lanes', '2']), 'U-240 C');
    assert.equal(r.status, 0, (r.stderr || '') + (r.stdout || ''));
    assert.ok(fs.existsSync(path.join(out, 'plan.json')), 'plan.json 缺失');
    assert.ok(fs.existsSync(path.join(out, 'agents', 'lane-1.md')), 'lane-1.md 缺失');
    assert.ok(fs.existsSync(path.join(out, 'agents', 'lane-2.md')), 'lane-2.md 缺失');
    const plan = JSON.parse(fs.readFileSync(path.join(out, 'plan.json'), 'utf8'));
    assert.equal(plan.lanes.length, 2);
    assert.equal(plan.meta.execute, false);
    // 负例：删掉 plan 后同一断言必须失败
    fs.rmSync(path.join(out, 'plan.json'));
    assert.throws(() => assert.ok(fs.existsSync(path.join(out, 'plan.json'))));
  } finally {
    fs.rmSync(out, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('U-240 D: 发布清单登记了编排器', () => {
  const manifestPath = path.resolve(root, '..', 'skill-assets.json');
  assert.ok(fs.existsSync(manifestPath), 'skill-assets.json 缺失');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
  const files = Object.keys(manifest.assets?.[0]?.fileHashes || {});
  assert.ok(files.some(f => f.endsWith('research_rounds.py')), '清单未登记 research_rounds.py');
});

test('U-240 E: 源码形态守卫（含负例）', () => {
  const src = fs.readFileSync(orchestrator, 'utf8');
  const guard = body => ['def build_lanes', 'def merge_candidates', 'def gap_axes', 'def merge_coverage']
    .every(name => body.includes(name));
  assert.equal(guard(src), true);
  assert.equal(guard(src.replace('def merge_candidates', 'def _removed')), false);
});
