// U-250（2026-10-25，P0-1 收尾）：质量基线必须**外部硬超时**，否则一条挂死的查询能吃掉整轮测量。
//
// 为什么这条门必须存在（实测）：
//   · 第三次 60 条全量跑，在单条查询上挂死 **27 分钟**，被人工 Ctrl-C——那一轮没有任何读数；
//   · 脚本内 deadline 只约束"网络等待"，不约束进程：DNS 卡住、子进程死锁、退出时 flush 卡住，都不受它管；
//   · 更要命的是"半途而废"没有痕迹：只看到 30 多条输出就断了，无法判断是挂了还是慢了。
//   ⇒ 判据只有一条：**单条查询必须有外部钟**，超时就杀，且不许冒充 miss。
//
// 门分两层（不联网：全量跑一次 10 分钟，网络抖动会让门假红）：
//   A 结构：显式进程 + WaitForExit(秒×1000)；超时 taskkill /T（cmd 的子进程是孙子进程，只杀 cmd 会留孤儿）；
//     超时后**不重试**（重试只会把墙钟翻倍）；超时行 verdict 为空 ⇒ 不进分母；落盘失败必须非 0 退出。
//   B 变异：分别删掉/削弱上述四处，各自必须判红——否则这些断言只是"文本恰好存在"。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'evals', 'quality-baseline.ps1');
const SRC = fs.existsSync(SCRIPT) ? fs.readFileSync(SCRIPT, 'utf8') : '';

const hasTimeoutWait = (s) => /WaitForExit\(\s*\$QueryTimeoutSec\s*\*\s*1000\s*\)/.test(s);
const hasTreeKill = (s) => /taskkill\s+\/T\s+\/F\s+\/PID/.test(s);
const noRetryOnTimeout = (s) => /if\s*\(\s*-not\s*\$timedOut\s*-and\s*\(/.test(s);
const timeoutNotScorable = (s) => /\$scorable\s*=\s*\(\s*\$verdict\s*-eq\s*'full'\s*-or\s*\$verdict\s*-eq\s*'partial'\s*\)/.test(s);
const writeSelfCheck = (s) => /落盘失败/.test(s) && /exit\s+3/.test(s);

test('U-250 A: 硬超时的四个要件必须同时在位', () => {
  assert.ok(SRC, '★ 缺 evals/quality-baseline.ps1');
  assert.ok(hasTimeoutWait(SRC), '★ 缺 WaitForExit($QueryTimeoutSec * 1000)：没有外部钟，挂死就没人管');
  assert.ok(hasTreeKill(SRC), '★ 缺 taskkill /T：cmd 的子进程是孙子进程，只杀 cmd 会留孤儿继续占着 out 文件');
  assert.ok(noRetryOnTimeout(SRC), '★ 超时后仍会重试：挂死的查询再跑一遍只会把墙钟翻倍（27 分钟 ×2）');
  assert.ok(timeoutNotScorable(SRC), '★ 超时行可能被计入分母：没跑成 ≠ 判失败，必须单列 timeout');
  assert.ok(writeSelfCheck(SRC), '★ 缺落盘自检：OutDir 不可写时脚本会打印"报告: <path>"并 exit 0（实测踩过）');
});

test('U-250 B: 变异（把机制削掉）必须判红', () => {
  // B1：去掉毫秒参数 → 变成无参 WaitForExit()（无限等）
  assert.ok(!hasTimeoutWait(SRC.replace('WaitForExit($QueryTimeoutSec * 1000)', 'WaitForExit()')), '★ 变异 B1 未被检出：把超时等待改回无限等，门应红');
  // B2：去掉 /T → 只杀 cmd
  assert.ok(!hasTreeKill(SRC.replace('taskkill /T /F /PID', 'taskkill /F /PID')), '★ 变异 B2 未被检出：只杀 cmd 不杀树，门应红');
  // B3：去掉"超时不重试"守卫
  assert.ok(!noRetryOnTimeout(SRC.replace('if (-not $timedOut -and (', 'if (')), '★ 变异 B3 未被检出：超时也重试，门应红');
  // B4：把可评分判据放宽成"有结果就算" → 引擎失败/超时都会被计进分母
  assert.ok(!timeoutNotScorable(SRC.replace("$scorable = ($verdict -eq 'full' -or $verdict -eq 'partial')", '$scorable = $true')), '★ 变异 B4 未被检出：分母口径放宽，门应红');
});

test('U-250 C: 超时必须留痕（报告与 JSON 都要能看出被杀了）', () => {
  assert.match(SRC, /\$timeouts\+\+/, '★ 缺超时计数');
  assert.match(SRC, /timeouts\s*=\s*\$timeouts/, '★ JSON 未落 timeouts');
  assert.match(SRC, /queryTimeoutSec\s*=\s*\$QueryTimeoutSec/, '★ JSON 未落实际使用的超时值：复核方无法判断阈值');
  assert.match(SRC, /status=timeout|'(timeout)'/, '★ 明细里没有 timeout 状态，超时会被读成 miss');
  // 0/0 不许写成 0%
  assert.match(SRC, /n\/a/, '★ n=0 时把 0% 当读数：0/0 的商不是 0%，必须写 n/a');
});
