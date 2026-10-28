// U-166 · 缓存文件路径可覆盖（MCPS_CACHE_FILE）—— U-162 门间竞态的**一处修复**
//
// 起因（U-162 已定位的机制）：`-NoCache` 的语义是「跳过读、照写（刷新语义）」⇒ **任何**跑完主流程的门
//   都会写 `$ScriptDir/search_cache.json`；而某道门断言「真仓缓存未被碰」⇒ 只要有别的门并发跑就**假红**。
//   本门把「测试期间不写真仓」从"每个门自己记得"改成**门运行器统一保证**。
//
// 判据：
//   ① 源码层：默认分支**仍**是 `Join-Path $ScriptDir "search_cache.json"` ⇒ **向后兼容**（不设 env 时行为不变）
//   ② runner 层：`runGates` 往 childEnv 注入 `MCPS_CACHE_FILE` ⇒ 门内部再起的 pwsh 全部继承
//   ③ 行为层（最强）：设 `MCPS_CACHE_FILE=<临时>` 真跑一次主脚本 ⇒ **临时文件被写**、**真仓缓存戳不变**
//   ④ 且：同一次运行**没有**在 $ScriptDir 旁边留下别的缓存文件（"只写该写的那一个"）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sourceAll } from './lib/source.mjs';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(testsDir, '..');
const MAIN = path.join(root, 'multi-platform-searcher.ps1');
const SRC = sourceAll(root);
const RUNNER = fs.readFileSync(path.join(root, 'tests/run-node-gates.mjs'), 'utf8');
const REAL_CACHE = path.join(root, 'search_cache.json');
const stamp = () => { try { const s = fs.statSync(REAL_CACHE); return `${s.size}@${s.mtimeMs}`; } catch { return 'absent'; } };

test('U-166-1（向后兼容）: 未设 MCPS_CACHE_FILE 时，缓存路径**仍**是 $ScriptDir/search_cache.json', () => {
  assert.match(SRC, /\$env:MCPS_CACHE_FILE/, '主脚本必须读 MCPS_CACHE_FILE');
  // ★U-53 门按「顶层单条赋值」识别变量定义 ⇒ 覆盖必须写成**追加的一条顶层语句**，不能把默认赋值包进 if/else
  assert.match(SRC, /^\$CacheFile = Join-Path \$ScriptDir "search_cache\.json"$/m,
    '★默认赋值必须仍是原样那条顶层语句（不设 env 时行为与改动前完全一致）');
  assert.match(SRC, /if \(\$env:MCPS_CACHE_FILE\) \{ \$CacheFile = \$env:MCPS_CACHE_FILE \}/,
    '覆盖必须是追加语句，且只覆盖 $CacheFile 本身');
});

test('U-166-2（runner 统一注入）: runGates 往 childEnv 注入 MCPS_CACHE_FILE，且尊重外部显式设置', () => {
  assert.match(RUNNER, /if \(!childEnv\.MCPS_CACHE_FILE\)[\s\S]{0,200}childEnv\.MCPS_CACHE_FILE = path\.join\(work,/, 
    'runGates 必须在 childEnv 里注入 MCPS_CACHE_FILE（门内部再起的 pwsh 靠继承拿到）');
  assert.match(RUNNER, /if \(!childEnv\.MCPS_CACHE_FILE\)/, '必须尊重外部已显式设置（便于定点调试）');
});

test('U-166-3（行为级 · 核心）: 设 MCPS_CACHE_FILE 后真跑一次 ⇒ 只写临时文件，**真仓缓存戳不变**', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'u166-'));
  const fixture = path.join(tmp, 'fixture');
  fs.mkdirSync(fixture, { recursive: true });
  fs.writeFileSync(path.join(fixture, 'probe.txt'), 'U166PROBE one\nU166PROBE two\n', 'utf8');
  const tmpCache = path.join(tmp, 'redirected-cache.json');
  const before = stamp();
  try {
    const env = { ...process.env, MCPS_CACHE_FILE: tmpCache };
    delete env.NODE_TEST_CONTEXT; delete env.NODE_OPTIONS;
    const args = ['-NoProfile', '-File', MAIN, '-NoEnvFile', '-LocalCodeSearch', '-LocalPath', fixture,
      '-Keyword', 'U166PROBE', '-Limit', '5', '-NoCache', '-AsJson'];
    const r = await new Promise(res => {
      const c = spawn('pwsh', args, { cwd: root, env, windowsHide: true });
      let o = '', e = '';
      c.stdout.on('data', d => { o += d; }); c.stderr.on('data', d => { e += d; });
      c.once('close', code => res({ code, o, e }));
      c.once('error', err => res({ code: null, o, e: err.message }));
    });
    assert.equal(r.code, 0, '主脚本必须跑通: ' + r.e.slice(0, 300));
    // ③ 临时缓存被写
    assert.ok(fs.existsSync(tmpCache), '★设了 MCPS_CACHE_FILE 就必须写它（否则这条判据是恒绿的）');
    // ③ 真仓缓存戳不变
    assert.equal(stamp(), before, '★真仓 search_cache.json 不得被碰（这正是 U-162 假红的根源）');
    // ④ 没在真仓旁边留下别的缓存文件
    const stray = fs.readdirSync(root).filter(f => /search_cache/i.test(f) && !fs.statSync(path.join(root, f)).isFile());
    assert.deepEqual(stray, [], '真仓根目录不该出现额外缓存产物: ' + stray.join(','));
    console.log(`[U-166] 真仓缓存戳 ${before} → ${stamp()}（不变）；临时缓存 ${tmpCache} 已写 ${fs.statSync(tmpCache).size} 字节`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('U-166-4（负例 · 可证伪）: 去掉覆盖逻辑后，上面那条行为判据会红（注入前先自检机制非恒真）', () => {
  // 证明 ③ 依赖的机制是"真的会因为改动而变"：若主脚本忽略 env，它就会写回 $ScriptDir（戳必变）
  const stripped = SRC.replace(/if \(\$env:MCPS_CACHE_FILE\)[\s\S]*?\n\s*\}\n/, '\n');
  assert.notEqual(stripped, SRC, '自检：模拟"去掉覆盖分支"应产生不同的源码');
  assert.doesNotMatch(stripped, /\$env:MCPS_CACHE_FILE/, '去掉后源码里不应再读该 env ⇒ 真跑就会写真仓 ⇒ 行为判据会红');
});
