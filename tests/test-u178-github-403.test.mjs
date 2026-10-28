// U-178：GitHub 的 403 必须区分「配额耗尽」与「权限不足」—— 与 U-177 互为镜像
//   背景（2026-10-19）：`engines/github.ps1` 旧写法 `$msg = '403 禁止'` **覆盖了原文**，
//     抹掉 U-177 带出的 ', rate-limit' 标记 ⇒ 403 一律报 rate_limited
//     ⇒「token 缺 scope」被说成「限流」，用户会去等而不是去修 token。
//   本门两条臂：
//     A · 桩跑 Search-GitHub 的 catch（三向：限流 / 权限 / 401）
//     B · 源码契约（不覆盖原文、限流先判、forbidden ⇒ error）+ **状态互换不改变 Verdict 的证明**
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPwsh } from './r2-ps-run.mjs';
import { sourceAll } from './lib/source.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HARNESS = path.join(ROOT, 'tests', 'u178-github-403-harness.ps1');
const GH = fs.readFileSync(path.join(ROOT, 'engines', 'github.ps1'), 'utf8');
const MAIN = sourceAll(path.join(ROOT));

test('U-178 A: 桩跑 Search-GitHub —— 限流⇒rate_limited / 权限⇒error / 401⇒auth_missing', async () => {
  const r = await runPwsh(['-File', HARNESS], { cwd: ROOT, timeoutMs: 180000 });
  const out = (r.stdout || '') + (r.stderr || '');
  assert.equal(r.status, 0, `夹具必须 rc=0，实际 ${r.status}\n${out.slice(-600)}`);
  assert.match(out, /U178 A_ratelimit=rate_limited/, '403 + rate-limit 标记 ⇒ rate_limited');
  assert.match(out, /U178 B_forbidden=error/, '★ 负例：403 + 权限文案 ⇒ 不得说成限流');
  assert.match(out, /U178 C_auth=auth_missing/, '401 ⇒ auth_missing');
  assert.match(out, /U178_PASS/);
});

test('U-178 B: 源码契约 —— 不覆盖原文、限流先判、forbidden 落 error', () => {
  // 只看可执行行（注释里会引用旧写法，不能算违规）
  const code = GH.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');
  // 关键：原消息必须保留（append 而非覆盖）
  assert.match(code, /if \(\$sc -eq 403\) \{ \$msg = "403 禁止: \$msg" \}/, '★ 403 必须 **追加** 而非覆盖原文（否则 rate-limit 标记被抹掉）');
  assert.doesNotMatch(code, /\$msg = '403 禁止'/, '★ 不得回到覆盖式写法');
  // 限流先判
  const rlIdx = code.indexOf("$authFail = 'ratelimit'");
  const fbIdx = code.indexOf("$authFail = 'forbidden'");
  assert.ok(rlIdx > 0 && fbIdx > 0, '必须同时存在 ratelimit 与 forbidden 两条判定');
  assert.ok(rlIdx < fbIdx, '限流判定必须**先于** forbidden');
  // forbidden ⇒ error（能力问题），ratelimit ⇒ rate_limited
  // ★B2-1（U-263）：三类映射已从 if/elseif 链收进 `$failMap`（函数顶在 U-163 的 100 行红线上）。
  //   这里改钉**表里的值**；"再映回 rate_limited / error"由 A 臂（走生产同一条 L1 链路）证明。
  assert.match(code, /ratelimit = @\{ code = 'rate-limited'/, 'ratelimit ⇒ rate-limited（L1 映回 rate_limited，见 A 臂）');
  assert.match(code, /forbidden = @\{ code = 'forbidden'/, 'forbidden ⇒ forbidden（L1 映回 error，见 A 臂）');
});

test('U-178 C: 状态互换不改变 Verdict（error 与 rate_limited 同属 degraded）', () => {
  // 这是"改分类不改契约"的依据：主线把两者都并入 degradedEngines
  assert.match(MAIN, /elseif \(\$st -eq 'error' -or \$st -eq 'rate_limited'\) \{ \$degradedEngines \+= \$en \}/,
    '★ error 与 rate_limited 必须同属 degraded —— 否则本轮换分类会悄悄改 Verdict');
});
