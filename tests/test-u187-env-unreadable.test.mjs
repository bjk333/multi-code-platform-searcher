// U-187（2026-10-20）：`.env` **存在但读不到**时必须自曝 —— 从一次真实事故倒推的回归门。
//
// 事故：收紧 `.env` 的 ACL 时 DACL 被清空（0 条 ACE），9 个令牌全部失效，而 CLI 一个字都没提：
//   `Load-EnvFile` 的 `catch { }` 把读取异常吞了，`-Doctor` 只显示 `tokens[].Present=false` ——
//   与"没配置"完全不可区分，会把"权限坏了"引向"去申请新令牌"这条错路。
//
// 口径（三处接线，缺一即门红）：
//   ① 函数层：读失败记 { Path, Error } 到 `$script:EnvLoadErrors`（不再静默）；
//   ② CLI 层：非 `-AsJson` 打一行 `[env] .env 存在但不可读…`，且**退出码不变**（匿名检索仍可用）；
//   ③ 契约层：顶层 warnings[] 置顶一条，`-Doctor` 增 `doctor.envFile.Unreadable[]`。
//
// 模拟手法：**用目录冒充 `.env`** —— `Test-Path` 为真，`[IO.File]::ReadAllLines` 必抛
//   UnauthorizedAccessException。这样不需要真的破坏 ACL，任何机器任何账户都能稳定复现"在但读不到"。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { probeWithMutants, assertMutantsKilled, MAIN, PRODUCT_SRC } from './r94-ps-probe.mjs';
import { runPwsh } from './r2-ps-run.mjs';

const SRC = PRODUCT_SRC();

const PROBE = `
$script:EnvLoadErrors = @()
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('mcps-u187-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
$dirAsEnv = Join-Path $tmp '.env'
New-Item -ItemType Directory -Path $dirAsEnv -Force | Out-Null
$ignored = @(Load-EnvFile -Path $dirAsEnv)
$errs = @($script:EnvLoadErrors)
$isDir = Test-Path -LiteralPath $dirAsEnv -PathType Container
Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
[ordered]@{
  count        = $errs.Count
  path         = $(if ($errs.Count) { [string]$errs[0].Path } else { '' })
  msg          = $(if ($errs.Count) { [string]$errs[0].Error } else { '' })
  fixtureIsDir = $isDir
  ignoredCount = @($ignored).Count
}
`;

function check(r, label) {
  assert.equal(r.fixtureIsDir, true, `${label} 夹具失效：目录没有建出来`);
  assert.equal(r.count, 1, `${label} 目录冒充 .env 应恰好记 1 条读失败，实得 ${r.count}`);
  assert.ok(String(r.path).endsWith('.env'), `${label} 记录必须带出问题的路径，实得 "${r.path}"`);
  assert.ok(String(r.msg).length > 0, `${label} 记录必须带异常信息（否则定位不到"权限/占用"）`);
}

test('U-187 函数层：.env 在但读不到 ⇒ 记 {Path,Error}，不再静默吞异常', async () => {
  const result = await probeWithMutants(PROBE, [
    {
      name: 'M1-退回静默 catch',
      fn: 'Load-EnvFile',
      find: '        $script:EnvLoadErrors += [PSCustomObject]@{ Path = $Path; Error = "$($_.Exception.Message)" }',
      replace: '        # mutant: 静默吞掉',
    },
    {
      name: 'M2-记了但丢路径',
      fn: 'Load-EnvFile',
      find: '{ Path = $Path; Error = "$($_.Exception.Message)" }',
      replace: "{ Path = 'x'; Error = \"$($_.Exception.Message)\" }",
    },
  ]);
  check(result.real, '(baseline)');
  assertMutantsKilled(result, check);
});

test('U-187 接线：启动提示 / warnings[] / Doctor envFile 三处都读 EnvLoadErrors', () => {
  assert.match(SRC, /\[env\] \.env 存在但不可读（权限\/占用？）/, '启动提示缺失（非 AsJson 必须打出来）');
  assert.match(SRC, /\$envFileWarnings = @\(\$script:EnvLoadErrors/, 'warnings[] 未合并 EnvLoadErrors');
  assert.match(SRC, /\$warningsOut = @\(\$envFileWarnings \+ \$warningsOut\)/, 'warnings[] 未置于最前');
  assert.match(SRC, /\$doctorReport\['envFile'\] = \[PSCustomObject\]@\{/, 'doctor.envFile 字段缺失');
});

test('U-187 live：cwd 的 .env 是目录时无参调用打警告且 rc 仍为 0（原写作 -Help —— 那个开关从来不存在）', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcps-u187-live-'));
  fs.mkdirSync(path.join(tmp, '.env'));
  let r = null;
  try {
    // 子进程强制 UTF-8 输出：`-File` 模式下 5.1/7 会按控制台代码页写管道，中文断言必乱码。
    // ★v1.74.0（F8，U-294）：这里原来传 `-Help` —— 主脚本从来没有这个参数，它能"跑得过"纯粹是因为
    //   简单 param 块把未知具名参数丢进 $args 后静默丢弃（随后因无关键词落到用法横幅、exit 0）。
    //   现在未知参数会在绑定阶段失败，故改为**真的无参调用**：同一路径（用法横幅 + rc 0），不靠静默行为。
    const cmd = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & '" + MAIN.replace(/'/g, "''") + "'; exit $LASTEXITCODE";
    r = await runPwsh(['-Command', cmd], { cwd: tmp, timeoutMs: 120000 });
  } catch (e) {
    t.skip('PowerShell 不可用：跳过 live 臂（函数层与接线仍已覆盖）: ' + e.message);
    return;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 由系统清 */ }
  }

  assert.equal(r.status, 0, '读不到 .env 不得改变退出码（匿名检索仍可用）: ' + String(r.stderr || '').slice(0, 400));
  const out = String(r.stdout || '') + String(r.stderr || '');
  assert.match(out, /\[env\] \.env 存在但不可读/, '未打印读失败提示');
  assert.ok(out.includes(tmp), '提示里应带出问题的路径（cwd 那份 .env）');
});

test('U-187 负例：.env 不存在时不得报"不可读"（否则每台新机器都有一条假警告）', async () => {
  const probe = `
$script:EnvLoadErrors = @()
$missing = Join-Path ([System.IO.Path]::GetTempPath()) ('mcps-u187-none-' + [Guid]::NewGuid().ToString('N') + '.env')
$ignored = @(Load-EnvFile -Path $missing)
[ordered]@{ count = @($script:EnvLoadErrors).Count; ignoredCount = @($ignored).Count }
`;
  const result = await probeWithMutants(probe, []);
  assert.equal(result.real.count, 0, '文件不存在属于"未配置"，不得记读失败');
  assert.equal(result.real.ignoredCount, 0, '文件不存在时 ignored 也应为空');
});
