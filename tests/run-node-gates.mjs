// N-12: one cross-platform entry for all offline Node gates (no shell glob / no directory-as-entry).
import { readdirSync, existsSync, statSync, rmSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { summarize, exitCodeFor, repartition, RECHECK_KIND } from './gate-partition.mjs';
import { auditLockPath, readAuditLock, auditLockActive, writeAuditLock, clearAuditLock, readScriptVersion } from './audit-lock.mjs';
import { buildGateGreen, gateGreenPath } from './gate-green.mjs';
// v1.57.0（B3-4）：门文件的**唯一**枚举处 + 静态配额。runner 不再自己 readdir ——
//   两份枚举必然漂移（一处在 tests/static/ 加目录、另一处忘了 ⇒ 新门永远不跑）。
import { gateFiles } from './lib/test-shape.mjs';
import { readQuota, metaNames } from './lib/static-quota.mjs';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(testsDir, '..');
// U-269（2026-10-26 全量验收）：**两种运行面**，别把"仓库侧门"当"安装副本门"跑。
//   验收实测：在 A 副本（%USERPROFILE%\.workbuddy\skills\...）跑全量门 ⇒ product_red=81，
//   但根因只有 **18 个缺失路径**，全是 `reports/` 下的仓库侧证据（预注册判据、probe 输出、质量基线）
//   与 `reports/_skill-assets.root.json`（gitignore 的镜像，本就要 `-RegenerateMirror` 再生成）。
//   ⇒ 不是 81 个产品缺陷，是**运行面搞错了**。这里按"测试源码是否引用 reports/"自动分类（不手写名单，避免名单腐烂）：
//     --profile=repo（默认，仓库内）       ：全部 148 个
//     --profile=installed（安装副本/CI 冒烟）：只跑不读 reports/ 的那些
const PROFILE = (process.argv.find((a) => a.startsWith('--profile=')) || '').split('=')[1] || 'repo';
const repoOnly = [];
// v1.55.0（B3-3）：门文件有两个来源 —— tests/test-*.test.mjs（契约/静态）与 tests/behavior/*.test.mjs（行为层）。
//   行为层的门命名不带 test- 前缀（它们是"同一层的一族用例"），必须显式收进来，否则新写的门永远不会被跑到 ——
//   那正是"门存在但没人执行"的假绿。
// v1.57.0（B3-4）：枚举收敛到 `tests/lib/test-shape.mjs` 的 `gateFiles()`（三处来源：顶层 / behavior / static）。
const files = gateFiles(root)
  .map(abs => ({ abs, name: path.relative(testsDir, abs).replace(/\\/g, '/') }))
  .filter(({ abs, name }) => {
    if (PROFILE !== 'installed') return true;
    const src = readFileSync(abs, 'utf8');
    // 允许显式标注：`// gate-profile: installed` 的门即使提到 reports/ 也照跑（例如只做字符串匹配的）
    if (/gate-profile:\s*installed/.test(src)) return true;
    // 判定"仓库侧门"的实测依据（不是猜的）：安装副本上缺的东西只有四类 ——
    //   ① reports/ 下的证据（含 path.join(root,'reports',...) 这种不带斜杠的写法）
    //   ② .gitignore（发布清单不收仓库级文件）
    //   ③ .github/（同上）
    //   ④ 父工作区清单 <root>/../skill-assets.json（副本没有父目录）
    const needsRepoArtifacts = /reports[\\/]|['"]reports['"]/.test(src)
      || /['"]\.gitignore['"]|\\\\\.gitignore/.test(src)
      || /\.github[\\/]|['"]\.github['"]/.test(src)
      || /skill-assets\.json/.test(src)
      || /tools[\\/]audit[\\/]/.test(src);   // 审计工具组在 $PUB_EXCLUDE_EXACT 里显式不随发
    if (needsRepoArtifacts) repoOnly.push(name);
    return !needsRepoArtifacts;
  })
  .map(({ abs }) => abs);
// 供元门断言"新门真的被接线了"（U-274-D）：门存在但 runner 不跑 = 假绿，必须能被静态发现。
export const GATE_FILES = files;
// U-275（v1.57.0，B3-4）：**哪些门的红记 meta_red** —— 只认 `tests/static-quota.json` 的登记。
//   缺文件/坏 JSON ⇒ 空集 ⇒ 全部按 product（fail-closed；U-275 会红，但红的是"账本没了"，
//   不是把产品红悄悄改个名字）。
export const META_FILES = metaNames(readQuota(root));
if (!readQuota(root)) console.error('[U-275] 未读到 tests/static-quota.json ⇒ 本轮所有红都按 product 记账（fail-closed）');
// U-133（2026-09-29，预注册 reports/U-133-预注册判据-2026-09-29.md）：启动自清 —— 只删白名单形状、且 mtime 早于本次启动 ≥10 分钟的门临时**目录**；
// 永不触碰 U133_KEEP；U133_WHATIF=1 只打印不删。U-81 收尾检测原样保留（新鲜目录不会被自清 ⇒ U-81 仍红）。
export const U133_TEMP_DIR = /^(n9|n9neg|r2|r2neg)-[A-Za-z0-9]{6}$/;
export const U133_MIN_AGE_MS = 10 * 60 * 1000;
export const U133_KEEP = ['r2', 'u119', 'u120', 'u134-specimen'];
export function clearStaleGateTemp(rootDir, opts = {}) {
  const now = opts.now ?? Date.now(); const whatIf = !!opts.whatIf; const log = opts.log ?? (m => console.error(m));
  const dir = path.join(rootDir, '_verify'); const removed = [];
  if (!existsSync(dir)) return removed;
  for (const name of readdirSync(dir)) {
    if (U133_KEEP.includes(name) || !U133_TEMP_DIR.test(name)) continue;
    const full = path.join(dir, name); let st;
    try { st = statSync(full); } catch { continue; }
    if (!st.isDirectory() || (now - st.mtimeMs) < U133_MIN_AGE_MS) continue;
    if (whatIf) { log('[U-133] 预演(不删): ' + name); continue; }
    try { rmSync(full, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); removed.push(name); log('[U-133] 启动自清: ' + name); } catch (e) { log('[U-133] 自清失败: ' + name + ' ' + e.message); }
  }
  return removed;
}
// U-153（A5，2026-09-30，预注册 reports/U-153-预注册判据-2026-09-30.md）：门输出分区 —— 每条红标 product 或 env:<kind> 并分别计数。
// 子进程 = node --import gate-env-preload.mjs --test（spec 照旧打到 stdout）+ gate-partition.mjs reporter（机读分区写临时文件）。
// 退出码：product 红 ⇒ 1；只有 env 红 ⇒ 3（env 红仍是红，只是不计入 product）；全清 ⇒ 0。U-81 残留判红（rc=1）照旧。
export function runGates({ files: list, cwd = root, env = process.env, stdio = 'inherit', extraExecArgv = [], mode = null, concurrency = null, metaFiles = null } = {}) {
  const runMode = mode || (String(env.U153_SERIAL || process.env.U153_SERIAL || '') === '1' ? 'serial' : 'parallel');
  // U-275：meta 名单可被调用方显式覆盖（门要对"红该记哪一栏"做真值表，不能靠改仓里的账本）；
  //   缺省用仓里的登记。空集 = 全部 product。
  const metaSet = metaFiles instanceof Set ? metaFiles : (metaFiles ? new Set(metaFiles) : META_FILES);
  // U-253（v1.53.26，2026-10-26）：**并发上限** —— 默认交给 node（= CPU 核数）。
  //   为什么需要它（实测）：本机 **32 核 + 137 个门文件** ⇒ node 默认开 **32 个** worker 进程，
  //   每个 worker 还可能再 spawn pwsh/powershell。于是：
  //     · 每次挂住的位置都不同（256 / 326 / 337 / 477 个 ✔），单跑永远复现不了；
  //     · 现场特征一致：日志不再增长、被指认的 worker CPU 零增长且无子进程（在等，不在算）；
  //     · 墙钟兜底（U-251）能在 20 分钟把"无限等"变成明确判红，但**兜底不等于能跑完**。
  //   `U153_CONCURRENCY=N` 把并发压到 N（仍 > 1，保留 U-245 的"并行红/串行复核"价值）。
  //   ★**默认取 min(4, 核数)**（2026-10-26 实测后定）：不设上限时本机 32 核 ⇒ 32 个 worker ⇒ 必挂；
  //     压到 4 后同一批 137 个门 4m32s 跑完、product_red=0（32 并发时四次挂在 256/326/337/477 个 ✔）。
  //     代价是比"理论最快"慢一倍，但"能跑完"优先于"跑得快" —— 跑不完的一轮连读数都没有。
  //     想更宽/更窄都显式传 `U153_CONCURRENCY`；`U153_SERIAL=1` 仍强制 1。
  const explicit = Number(concurrency ?? env.U153_CONCURRENCY ?? process.env.U153_CONCURRENCY ?? 0);
  const conc = explicit > 0 ? explicit : Math.min(4, Math.max(1, os.cpus().length || 1));
  return new Promise(resolve => {
    const work = mkdtempSync(path.join(os.tmpdir(), 'u153-'));
    const partFile = path.join(work, 'partition.json'); const eventsFile = path.join(work, 'env-events.jsonl');
    const args = [...extraExecArgv, '--import', pathToFileURL(path.join(testsDir, 'gate-env-preload.mjs')).href, '--test',
      // U-251 配套（v1.53.26，2026-10-25）：**用例跑完就退出，不等 handle 释放**。
      //   代价换来的确定性：`test-u132-latin1-repair` 的 `runPs` 只 `kill('SIGKILL')` 然后等 `child.once('close')`；
      //   Windows 上 kill 不掉 pwsh 的**孙进程**，而 `close` 要等 **stdio 管道**全部关闭 —— 管道被孙进程继承
      //   ⇒ `close` 永不触发 ⇒ 该文件的用例全绿、进程却永不退出 ⇒ `node --test` 等它 ⇒ **整个全量 run 挂住**
      //   （实测：日志停在 256 / 337 个 ✔ 不动，CPU 零增长，无子进程；单跑同一文件 2.8s 全绿）。
      //   ★可执行验证（不是"加个 flag 希望它管用"）：临时写一个"用例立即完成 + 留一个 10 分钟不释放的 handle"的
      //     探针，`node --test` 8 秒被 timeout 杀（rc=124，且报告记 1 fail）；加本 flag 后 rc=0、1 pass 0 fail。
      //   ★边界：它只治「**用例全部完成**但进程不退」。用例内部 await 悬挂（u132 那个 Promise 永不 settle）
      //     它管不到 —— 那要在源头修（u132 已改成超时即 `taskkill /T /F` 并主动 settle）。
      '--test-force-exit',
      // U-172（2026-10-19）：**确定性开关** —— 门之间存在已知竞态（见 test-u166-cache-override 头注：
      //   `search_cache.json` 断言 与 并发跑真查询的门 会非确定性假红）。默认并行；U153_SERIAL=1 时串行，
      //   用于产出**可复现**的全量证据（代价：耗时上升）。
      ...(runMode === 'serial' ? ['--test-concurrency=1'] : (conc > 0 ? [`--test-concurrency=${conc}`] : [])),
      '--test-reporter=spec', '--test-reporter-destination=stdout',
      '--test-reporter=' + pathToFileURL(path.join(testsDir, 'gate-partition.mjs')).href, '--test-reporter-destination=' + partFile, ...list];
    const childEnv = { ...env, U153_ENV_EVENTS: eventsFile }; delete childEnv.NODE_TEST_CONTEXT;   // 自检门里嵌套调用时，否则 node:test 会跳过文件
    if (runMode === 'serial') { childEnv.U153_SERIAL = '1'; }
    // U-166（2026-10-04）：把缓存文件重定向到临时目录 —— 门运行器**统一保证**"测试期间不写真仓"。
    //   起因（U-162）：`-NoCache` 只跳过读、照写（刷新语义）⇒ 任何跑完主流程的门都会写 $ScriptDir/search_cache.json
    //   ⇒ 与"真仓缓存未被碰"的断言冲突，全量门会**非确定性**假红。注入到 childEnv ⇒ 门内部再起的 pwsh 全部继承。
    //   ★尊重外部显式设置：已在 env 里就不覆盖（便于定点调试）。
    if (!childEnv.MCPS_CACHE_FILE) {
      childEnv.MCPS_CACHE_FILE = path.join(work, 'gate-cache.json');
    }
    // U-242（v1.53.24）：**源健康记忆也要隔离**。理由同 U-166：`source-health.json` 是跨运行状态，
    //   若门跑在真仓上，第一条写入门就会把 GitLab/HF 打成"冷源"，后面所有门的等待预算变成 1s ⇒
    //   门之间互相污染、结果不可复现（这正是"并行红不可复现"的同一类病灶）。
    if (!childEnv.MCPS_HEALTH_FILE) {
      childEnv.MCPS_HEALTH_FILE = path.join(work, 'gate-health.json');
    }
    const child = spawn(process.execPath, args, { cwd, stdio, env: childEnv });
    let out = '';
    if (stdio === 'pipe') { child.stdout.on('data', c => { out += c; }); child.stderr.on('data', c => { out += c; }); }
    // U-251（v1.53.26，2026-10-25）：**整轮墙钟兜底** —— 门禁可以红，但不许无限等。
    //
    //   病灶（本次会话实测，反复四次）：`node --test` 会为**每个测试文件**起一个子进程；某个文件的用例
    //   全部完成、但进程因未释放的 handle 不退时，**主 runner 会一直等它**。`--test-force-exit` 只作用于
    //   主 runner，**不传给每文件的子进程** ⇒ 治不了这种情况（2026-10-25 第 4 次全量 3m38s 成功、
    //   第 5 次挂在 `test-u175` —— 而 u175 单跑 0.5s / 6 用例全绿，纯静态、无 spawn 无网络）。
    //   这就是"全量在 256 / 337 / 477 个 ✔ 处挂住"的完整解释：**不是某个门慢，是某个 worker 不退**。
    //
    //   处置原则（与全仓 fail-closed 一致）：
    //     ① 超时 ⇒ `taskkill /T /F` 杀**整棵**进程树（kill 单个 pid 留下的孙进程会继续持有管道）；
    //     ② 结果**明确判红**、绝不冒充绿：`summary.hung = true`，`product_red` 至少 +1，且 `voided = true`
    //        （跑不完的一轮**不能**产出可引用的凭证 —— 与 U-246 的版本漂移作废同一语义）；
    //     ③ 不重试（重试会把"偶发挂"变成"偶发绿"，U-159 K3-f 明令禁止）。
    //   默认 20 分钟：本机全量实测 2m20s–3m38s，留 5 倍余量；`U153_MAX_WALL_MS` 可覆盖（调试用）。
    //   ★读 **传入的 `env`** 优先（门要能用它构造"故意超时"的负例），其次才是 `process.env`。
    const maxWallMs = Number((env && env.U153_MAX_WALL_MS) || process.env.U153_MAX_WALL_MS || 20 * 60 * 1000);
    let hung = false;
    const hangTimer = setTimeout(() => {
      hung = true;
      // ★平台分叉（U-278，v1.60.0）：`taskkill` 是 Windows 专有。在 POSIX 上无条件 spawn 它，
      //   返回的 child 会以 `ENOENT` 抛 **未处理的 'error' 事件** —— 整轮 gate 进程直接崩掉，
      //   而不是"杀掉挂住的子进程再判红"。实测（Linux 容器，B3-7）：U-251 的墙钟门当场红在
      //   `spawn taskkill ENOENT`，也就是**watchdog 自己先死了**，那正是它要防的场景。
      //   POSIX 侧退到 `child.kill('SIGKILL')`（只杀直接子进程，不杀整棵树；组播要 detached，
      //   而 detached 会改变 stdio/TTY 行为，不在这一批里动）。
      if (process.platform === 'win32') {
        try {
          const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
          killer.on('error', () => { });       // 不挂 error 监听 = 未处理事件 = 整轮崩
          killer.unref();                      // 别为了杀人把事件循环留住
        } catch { }
      }
      try { child.kill('SIGKILL'); } catch { }
    }, maxWallMs);
    if (typeof hangTimer.unref === 'function') hangTimer.unref();
    const finish = (code, signal, launchError) => {
      clearTimeout(hangTimer);
      let report = null; let events = [];
      try { report = JSON.parse(readFileSync(partFile, 'utf8').trim().split(/\r?\n/).pop()); } catch { }
      try { events = readFileSync(eventsFile, 'utf8').split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l)); } catch { }
      try { rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { }
      const summary = summarize(report, events, { metaFiles: metaSet });
      // U-245（B1-5）：**每条红都必须带 run_mode** —— 没有它，"product_red=0" 可以被一次并行跑伪造出来，
      //   也可以被一次并行跑冤枉掉（2026-10-25 实测：11 红里 8 条单跑全绿）。
      summary.runMode = runMode;
      // U-253：把**实际并发**也记下来 —— 不记的话，"product 红为 0"在一份 32 并发跑出来的凭证
      //   和一份 4 并发跑出来的凭证里长得一模一样，而两者的可信度显然不同。
      summary.concurrency = conc > 0 ? conc : null;
      // v1.53.1：无报告时把最有用的两个字段带进 why —— 2026-10-22 全量实红过一次（U-153 P1 的子进程
      //   3.5s 收工、报告为空），当时的 why 只有 "reporter produced no output"，无法区分
      //   「被信号杀（资源）」/「exit≠0（崩溃）」/「exit=0 但 reporter 静默（真故障）」。fail-closed 不变。
      if (!report) summary.productRed++, summary.product.push({ name: 'partition report missing', cls: 'product', why: (launchError ? 'launcher failed: ' + launchError : 'reporter produced no output (fail-closed)') + ' [exit=' + code + ' signal=' + signal + ']' });
      if (hung) {
        // ★绝不冒充绿：挂住的一轮 = 结果不可用。它同时进 product 账（必须有人看见）与 voided 账（凭证作废）。
        summary.hung = true;
        summary.voided = true;
        summary.productRed++;
        summary.product.push({
          name: 'gate run hung', cls: 'product',
          why: `整轮超过 ${Math.round(maxWallMs / 60000)} 分钟未结束 ⇒ 已杀进程树；本轮结果**不完整且不可引用**（不是某条门红，是没跑完）`,
        });
      }
      resolve({ code, signal, summary, rc: exitCodeFor(summary, code), output: out, hung });
    };
    child.once('error', e => finish(1, null, e.message));
    child.once('exit', (code, signal) => finish(code ?? 1, signal));
  });
}
// U-245（v1.53.26，验收 B1-5）：**并行红不许直接算 product** —— 只把失败的文件串行复核一次。
//   病灶（2026-10-25 B1-3 实测）：一次全量并行跑 11 条红，其中 8 条同文件单跑全绿（并发/环境），
//   而 `product_red` 是"能不能发布"的唯一判据 ⇒ 要么被迫放行真红，要么永远发不了版。
//   判据（两侧都保持可证伪）：
//     · 同文件串行**过** ⇒ 记 `env:flaky-parallel`（rc 仍非 0，不冒充绿）；
//     · 同文件串行**又红** ⇒ 保持 product（真回归不因"复核过一次"被洗白）；
//     · 复核**没跑成**（报告缺失）⇒ 一律按复现处理（fail-closed）。
//   `mergeRecheck` 是纯函数：输入两次 run 的结果，输出合并后的分区 —— 门可以对它直接做真值表。
export function mergeRecheck(first, recheck, { metaFiles = null } = {}) {
  const keyOf = r => r.file || '(unknown)';
  const recheckProduct = [...(recheck?.summary?.product || [])];
  // 复核不可用（reporter 没产出）⇒ 不能拿"没红"当"通过"
  const recheckUnusable = recheckProduct.some(r => /partition report missing/.test(String(r.name || '')));
  const reproducedFiles = new Set(recheckProduct.map(keyOf));
  const moved = []; const kept = []; const reds = [];
  for (const r of (first?.summary?.product || [])) {
    const k = keyOf(r);
    if (recheckUnusable || reproducedFiles.has(k)) {
      reds.push(r); kept.push(r.name);
    } else {
      reds.push({ ...r, cls: 'env', kind: RECHECK_KIND, why: '并行红 → 同文件串行复核通过（' + (r.why || 'unknown') + '）' });
      moved.push(r.name);
    }
  }
  for (const e of (first?.summary?.env || [])) reds.push(e);
  // U-275：meta 红**原样带上**（它们不是"复核的对象"——静态门的红是确定性的，没有并行抖动可言；
  //   漏带就会在"有 product 红 + 有 meta 红"的一轮里把 meta 静默吞掉，凭证上的 meta_red 变 0）。
  for (const m of (first?.summary?.meta || [])) reds.push(m);
  // 复核里**新冒出来**的红也要带上：否则"并行没红、串行红"会被吞掉（反方向的假绿）
  //   ★复核**没跑成**时不带：那是"复核这件事失败了"，不是"多了一条红门"——
  //     把它算成第 3 条 product 红会虚增红数（本门第一版就这样，真值表当场抓住）。
  for (const r of (recheck?.summary?.product || [])) {
    if (recheckUnusable) break;
    if ((first?.summary?.product || []).some(x => keyOf(x) === keyOf(r))) continue;
    reds.push(r); kept.push(r.name);
  }
  // U-275：复核里的 meta 红**不带**（首跑已经记过，同一文件同一句话再记一次只会虚增计数）。
  //   静态门的红是确定性的：并行红与串行红若是同一个门，归类必然相同 —— 除非它在并行下根本没红，
  //   那就是"少一条红"，不需要补。
  for (const e of (recheck?.summary?.env || [])) reds.push(e);
  const summary = repartition(reds, {
    runMode: 'parallel+serial-recheck',
    // U-251：**作废/挂住必须跨复核传播**。否则 `repartition` 会现场造一个干净的 summary，
    //   把"这一轮不完整"这件事洗掉 —— 那正好是"带红发布"想要的假象。
    voided: !!first?.summary?.voided,
    hung: !!first?.summary?.hung,
    // U-253：并发也必须传播。★这条是实测漏掉的：加了 `--test-concurrency=4` 跑完后凭证里
    //   `concurrency: null` —— 因为 repartition 是新造对象，漏传即丢。而 U-251-D 当时只测了
    //   voided/hung 两个字段，正好漏掉这第三个（"测两个代表性字段"这种做法本身就是漏的来源）。
    concurrency: first?.summary?.concurrency ?? null,
  }, { metaFiles });
  summary.movedToEnv = moved;
  summary.recheckKept = kept;
  if (recheckUnusable) summary.recheckError = '串行复核未产出报告（复核本身失败，原 product 红全部保留）';
  return { summary, rc: exitCodeFor(summary, first?.code), moved, kept };
}

// CLI 用这个：并行跑 → 有 product 红就把**失败文件**串行复核 → 合并。
// （库调用仍走 runGates：单次、语义不变 —— 测试夹具不该因为多跑一遍而改变断言。）
export async function runGatesVerified(opts = {}) {
  const first = await runGates(opts);
  // U-251：挂住的一轮**不做串行复核** —— 复核的前提是"第一次跑完了、只是红的归属可疑"；
  //   没跑完的时候去复核失败文件，等于拿一个残缺清单当全集，结论比不复核更假。
  if (first.hung) return first;
  if (first.summary.runMode !== 'parallel') return first;

  // U-272（2026-10-26 全量验收）：**env-only 的轮次也要复核**。
  //   病灶：`no-network` 这类 env 红不走复核 ⇒ runMode 停在 `parallel` ⇒ 凭证判据直接拒绝整轮，
  //   于是"产品全绿、只有环境红"的机器**永远发不了版**；而同一条失败若归成 product 就会复核并转成
  //   `flaky-parallel` ⇒ 同一个事实，凭"归类"决定能不能发布，这不是纪律是漏洞。
  //   口径：只补事实（这些文件串行跑是什么结果），不动分区、不洗白（env 红仍计数，rc 仍非 0）。
  if (first.summary.productRed === 0 && (first.summary.env || []).length) {
    const envFiles = [...new Set(first.summary.env.map(r => r.file).filter(Boolean))];
    if (!envFiles.length) return first;
    const rc2 = await runGates({ files: envFiles, cwd: opts.cwd, env: opts.env, stdio: 'pipe', mode: 'serial' });
    const stillRed = new Set([...(rc2.summary.product || []), ...(rc2.summary.env || [])].map(r => r.file).filter(Boolean));
    const passFiles = envFiles.filter(f => !stillRed.has(f));
    // U-275：meta 红必须一起重分区 —— 这里只传 product+env 会把一整个类别的红凭空丢掉
    //   （U-253 的 concurrency 漏传是同一个坑：repartition 是新造对象，漏传即丢）。
    const summary = repartition([...first.summary.product, ...first.summary.env, ...(first.summary.meta || [])], {
      // ★复核**跑过了**就记 `parallel+serial-recheck`，不管结果是通过还是仍然红：
      //   runMode 要回答的是"这一轮有没有串行复核过"，不是"复核有没有变绿"。
      //   写成 `passFiles.length ? ... : 'parallel'` 会把"已串行确认的环境红"退化成"没验证过"，
      //   于是产品全绿的机器照样发不了版（2026-10-26 实测：两条 no-network 串行复现 ⇒ 凭证被拒）。
      //   红不红由 env/product 计数回答，rc 仍非 0 —— 这一条只补"复核发生过"。
      runMode: 'parallel+serial-recheck',
      voided: !!first.summary.voided,
      hung: !!first.summary.hung,
      concurrency: first.summary.concurrency ?? null,
    }, { metaFiles: opts.metaFiles ?? undefined });
    summary.movedToEnv = [];
    summary.envRecheck = { files: envFiles.map(f => path.basename(f)), pass: passFiles.map(f => path.basename(f)), stillRed: [...stillRed].map(f => path.basename(f)) };
    return { ...first, summary, rc: exitCodeFor(summary, first.code), recheck: { files: envFiles, rc: rc2.rc, moved: [], kept: [] } };
  }

  if (first.summary.productRed === 0) return first;
  const files = [...new Set(first.summary.product.map(r => r.file).filter(Boolean))];
  if (!files.length) return first;   // 红没有归属文件（partitioner 崩了）⇒ 无处复核，保持 product（fail-closed）
  const recheck = await runGates({ files, cwd: opts.cwd, env: opts.env, stdio: 'pipe', mode: 'serial' });
  const merged = mergeRecheck(first, recheck, { metaFiles: opts.metaFiles ?? null });
  return { ...first, summary: merged.summary, rc: merged.rc, recheck: { files, rc: recheck.rc, moved: merged.moved, kept: merged.kept } };
}
export function printPartition(summary, log = m => console.error(m)) {
  for (const r of summary.product) log(`[U-153] product: ${r.name}${r.file ? ' @ ' + path.basename(r.file) : ''} — ${r.message || r.why}`);
  // U-275：meta 单列（并显式说明"它不是产品结论，但仍是红"），避免有人把 product_red=0 读成"全绿"。
  for (const r of (summary.meta || [])) log(`[U-275] meta: ${r.name}${r.file ? ' @ ' + path.basename(r.file) : ''} — ${r.message || r.why}`);
  for (const r of summary.env) log(`[U-153] env:${r.kind}: ${r.name}${r.file ? ' @ ' + path.basename(r.file) : ''} — ${r.message || r.why}`);
  const kinds = Object.entries(summary.envByKind).map(([k, n]) => k + '=' + n).join(' ');
  // U-245：run_mode 是结论的一部分 —— 没有它，同一份代码的红/绿无法被复核。
  const mode = summary.runMode ? ` run_mode=${summary.runMode}` : '';
  const metaRed = summary.metaRed ?? 0;
  log(`[U-153] product_red=${summary.productRed} meta_red=${metaRed} env_red=${summary.envRed}${mode}${kinds ? ' (' + kinds + ')' : ''}`);
  if (metaRed) log(`[U-275] meta_red=${metaRed}：都不是产品结论 —— 改对应的文件/账本即可（但发布同样拒绝：product_red 与 meta_red 都必须为 0）`);
  if (Array.isArray(summary.movedToEnv) && summary.movedToEnv.length) {
    log(`[U-153] 串行复核：${summary.movedToEnv.length} 条并行红在同文件串行跑通过 ⇒ env:flaky-parallel（未洗白成绿）`);
  }
}
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (!isMain) { /* imported by a gate: expose helpers only */ }
else if (!files.length) { console.error('No Node gate files found'); process.exitCode = 2; }
else {
  if (PROFILE === 'installed') {
    console.error(`[profile] installed：跳过 ${repoOnly.length} 个依赖 reports/ 的仓库侧门（缺证据不是产品缺陷；仓库内请用 --profile=repo）`);
    for (const n of repoOnly) console.error('[profile]   skip: ' + n);
  }
  // U-271（2026-10-26 全量验收）：`_verify/` 是**运行时临时目录**（gitignore，不随包），
  //   但不少门直接 `mkdtemp('<root>/_verify/...')` ⇒ 在新克隆 / 安装副本上首跑就是 ENOENT
  //   （实测 A 副本上 7 条门全红在这一个 mkdir 上）。由 runner 兜底创建，比逐个门补 mkdir 可靠。
  try { mkdirSync(path.join(root, '_verify'), { recursive: true }); } catch (e) { console.error('[U-271] 无法创建 _verify/：' + e.message); }
  clearStaleGateTemp(root, { whatIf: process.env.U133_WHATIF === '1' });
  // U-246（B1-5 后半）：**测量与发布互斥** —— 开跑前写 `.audit-lock`（version+pid+startedAt），
  //   跑完（含异常）只删**自己写的那把**；起止版本不一致 ⇒ 该轮作废（不许当绿用）。
  //   ★已有活锁时不覆盖也不删（并发跑合法，但"谁的锁"必须分得清，否则两次跑会互删）。
  const lockFile = auditLockPath(root);
  const versionAtStart = readScriptVersion(root);
  const held = auditLockActive(readAuditLock(lockFile));
  if (held) console.error(`[U-246] 已有测量在进行（version=${held.version} pid=${held.pid} startedAt=${held.startedAt}）⇒ 本次不写锁、也不删别人的锁`);
  else writeAuditLock(lockFile, { version: versionAtStart });
  const lockMine = !held;
  // U-247：**开跑即作废旧凭证** —— 否则一轮崩掉后会留着上一次的绿，发布器读到它就会"带红发布"。
  //   崩掉 ⇒ 没有新凭证 ⇒ 发布被拒（fail-closed）；这比"旧绿兜底"正确。
  try { rmSync(gateGreenPath(root), { force: true }); } catch { /* 本来就没有 */ }
  (async () => {
    let result;
    try {
      result = await runGatesVerified({ files });
    } finally {
      if (lockMine) clearAuditLock(lockFile, process.pid);
    }
    const { signal, summary, rc } = result;
    const versionAtEnd = readScriptVersion(root);
    summary.versionAtStart = versionAtStart;
    summary.versionAtEnd = versionAtEnd;
    if (versionAtStart !== versionAtEnd) {
      summary.voided = true;
      console.error(`[U-246] 起止版本不一致（${versionAtStart} → ${versionAtEnd}）：本轮**作废**，不得作为发布证据`);
    }
    if (signal) console.error('Node gates interrupted:', signal);
    printPartition(summary);
    // U-247（B1-4 前半）：**只有可复核的绿才落凭证**。product 红 / 作废的一轮不写（写了就是"上一次的绿"冒充这一次）；
    //   `parallel` 也写 —— 但 `gateGreenVerdict` 会判它不可用，这样"跑过但不算绿"这件事本身是可见的。
    try {
      if (!summary.voided) {
        writeFileSync(gateGreenPath(root), JSON.stringify(buildGateGreen(summary, { version: versionAtEnd, files }), null, 2) + '\n', 'utf8');
      }
    } catch (e) { console.error('[U-247] gate-green 写入失败: ' + e.message); }
    process.exitCode = summary.voided ? 1 : rc;
    // U-81（2026-09-26）：_verify/ 卫生 —— 全部门跑完后清点残留。测试自建的临时目录（n9-*/n9neg-*/r2-*/r2neg-*）必须已自清，
    // 否则 rc=1 并列出（"改了但没清"要被看见）；其它文件（宿主留下的 tests*.txt 等）只列出不判红——按 D-03，留档证据应落 reports/。
    const residue = listVerifyResidue(root);
    if (residue.temp.length) { console.error('[U-81] _verify/ has un-cleaned test temp dirs: ' + residue.temp.join(', ')); process.exitCode = 1; }
    if (residue.other.length) console.error('[U-81] _verify/ residue (informational, not created by gates): ' + residue.other.join(', '));
    if (!residue.temp.length && !residue.other.length) console.error('[U-81] _verify/ clean');
  })();
}
function listVerifyResidue(rootDir) {
  const dir = path.join(rootDir, '_verify');
  const out = { temp: [], other: [] };
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (TEMP_PREFIX.test(name)) out.temp.push(name); else out.other.push(name);
  }
  return out;
}
const TEMP_PREFIX = /^(n9|n9neg|r2|r2neg|u58)-/;   // U-98：u58-synthetic.tmp 也算门临时物
