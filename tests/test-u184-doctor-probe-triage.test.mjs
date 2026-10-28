// U-184（2026-10-20）：Doctor 令牌探针的**失败分档**门。
//
// 背景（2026-10-20 全面检测 P1-2）：同一构建、同一端点，`-Doctor` 时而报 `HTTP 200`、时而报
// `unreachable`；而 curl 直打该端点时的 stderr 是 `schannel: CRYPT_E_NO_REVOCATION_CHECK`
// （本机取不到证书吊销列表）。也就是说旧实现把「TLS 握手失败 / 超时 / DNS 失败 / 连接被拒」
// 四种处置方式完全不同的情形压成一档 `unreachable`，用户得到的唯一建议是「换令牌」。
//
// 本门守两件事：
//   ① `Get-CurlFailureHint` 把 curl 的退出码 + stderr 判读成带机器可判读前缀的文案；
//   ② `ConvertFrom-TokenProbeFailure` 据此分档，且**绝不把 `HTTP 0` 当成 HTTP 状态码**
//      （`HTTP 0` 是 curl `%{http_code}` 的"没拿到响应"占位，不是 4xx/5xx）。
// 三个变异臂保证门能弄红（沿用 R94 的 dot-source + AST 重定义驱动器）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { probeWithMutants, assertMutantsKilled } from './r94-ps-probe.mjs';

const PROBE = `
$h = [ordered]@{
  tls35    = Get-CurlFailureHint -ExitCode 35 -ErrorText ''
  tlsSchan = Get-CurlFailureHint -ExitCode 0  -ErrorText 'schannel: CRYPT_E_NO_REVOCATION_CHECK'
  to28     = Get-CurlFailureHint -ExitCode 28 -ErrorText 'Operation timed out after 20001 ms'
  refuse7  = Get-CurlFailureHint -ExitCode 7  -ErrorText 'Failed to connect to 127.0.0.1'
  dns6     = Get-CurlFailureHint -ExitCode 6  -ErrorText 'Could not resolve host'
  nullrc   = Get-CurlFailureHint -ExitCode $null -ErrorText ''
}
$p = [ordered]@{
  http401 = ConvertFrom-TokenProbeFailure -ErrorText 'proxy fail: https://api.github.com/user (HTTP 401)'
  tls     = ConvertFrom-TokenProbeFailure -ErrorText 'proxy fail: x (HTTP 0; TLS 握手失败 tls-error: schannel: CRYPT_E_NO_REVOCATION_CHECK)'
  budget  = ConvertFrom-TokenProbeFailure -ErrorText '探测预算耗尽: https://gitlab.com/api/v4/user (10s 内未完成)'
  refused = ConvertFrom-TokenProbeFailure -ErrorText 'proxy fail: x (curl 无状态码输出; 连接被拒（curl rc=7）)'
  http0   = ConvertFrom-TokenProbeFailure -ErrorText 'proxy fail: x (HTTP 0)'
  http403 = ConvertFrom-TokenProbeFailure -ErrorText 'Response status code does not indicate success: 403 (Forbidden)'
}
[ordered]@{ hints = $h; probes = $p }
`;

function check(r, label) {
  const { hints: h, probes: p } = r;
  // ① curl 退出码/stderr 判读：前缀必须能被机器识别（不靠猜中文）
  assert.match(h.tls35, /tls-error/, `${label} curl rc=35 应判 TLS`);
  assert.match(h.tlsSchan, /tls-error/, `${label} schannel/CRYPT_E 应判 TLS`);
  assert.match(h.to28, /timeout/, `${label} curl rc=28 应判超时`);
  assert.doesNotMatch(h.refuse7, /tls-error|timeout/, `${label} 连接被拒既不是 TLS 也不是超时`);
  assert.match(h.dns6, /DNS/, `${label} curl rc=6 应判 DNS`);
  assert.match(h.nullrc, /unknown/, `${label} 退出码未知时不能输出空值`);

  // ② 令牌探针分档：HTTP 码优先；401/403 是唯一能证明"令牌无效"的
  assert.equal(p.http401, 'HTTP 401', `${label} HTTP 401`);
  assert.equal(p.http403, 'HTTP 403', `${label} 文本里的 403 也要认出`);
  assert.equal(p.tls, 'tls-error', `${label} TLS 形状 ⇒ tls-error`);
  assert.equal(p.budget, 'timeout', `${label} 预算耗尽 ⇒ timeout`);
  assert.equal(p.refused, 'unreachable', `${label} 连接被拒 ⇒ unreachable`);
  // ★ 本门存在的理由：HTTP 0 是"没拿到响应"的占位，绝不能被当成 HTTP 状态码
  assert.equal(p.http0, 'unreachable', `${label} HTTP 0 不得被当作 HTTP 码`);
}

test('U-184 Doctor 令牌探针：传输失败必须分档（tls-error / timeout / unreachable）', async () => {
  const result = await probeWithMutants(PROBE, [
    {
      name: 'M1-去掉 TLS 分支',
      fn: 'ConvertFrom-TokenProbeFailure',
      find: "if ($m -match 'tls-error|TLS 握手失败|schannel|CRYPT_E|certificate|证书') { return 'tls-error' }",
      replace: '',
    },
    {
      name: 'M2-HTTP 码放宽到 \\d+（会让 HTTP 0 冒充状态码）',
      fn: 'ConvertFrom-TokenProbeFailure',
      find: "if ($m -match 'HTTP (\\d{3})') { return \"HTTP $($Matches[1])\" }",
      replace: "if ($m -match 'HTTP (\\d+)') { return \"HTTP $($Matches[1])\" }",
    },
    {
      // 必须整行删：只改 `$rc -eq 28` 的话，夹具文本 'Operation timed out' 仍命中同一行的
      // `-match 'timed?\s?out|timeout|超时'` ⇒ 变异臂存活（本门第一次跑就是这样，M3 存活被抓出来）
      name: 'M3-rc28 与文本超时都不再判超时',
      fn: 'Get-CurlFailureHint',
      find: "if ($rc -eq 28 -or $t -match 'timed?\\s?out|timeout|超时') { return ('超时 timeout: {0}' -f $brief) }",
      replace: '',
    },
  ]);

  check(result.real, '(baseline)');
  assertMutantsKilled(result, check);
});
