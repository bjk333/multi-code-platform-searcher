// R2-M（2026-09-30）：唯一外部二进制 ripgrep 的依赖台账门。
//   ① 台账字段齐全、口径正确（git-tagged-only / attested=false / tag_signer.scope=git-tag-only / 升级流程两步都在）；
//   ② 台账 ≡ tools/fetch-ripgrep.ps1 常量（版本、URL、zip/exe sha256、4 218 880 B）——两处不一致即红；
//   ③ 脚本结构：长度先于哈希、URL 前缀白名单先于联网、重定向主机白名单且取不到即失败关闭、解包后 exe 必校验、校验先于落盘；
//   ④ 活体（离线）：临时副本 + 伪 rg.exe 跑 -Check（缺失 / 长度不符 / 长度对但哈希不符 ⇒ rc=1 且带 MISS/DIFF 标记）；
//      URL 改成非白名单 ⇒ 联网前抛错；宿主有真 rg.exe 时再跑一次正例（rc=0 + OK）。
//   ⑤ 3 个源码负例（任务书 M 的三条"勿回退"）必须被 ③ 判红。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rootDir, runPwsh, assertRanRed, assertRanGreen } from './r2-ps-run.mjs';

const lock = JSON.parse(fs.readFileSync(path.join(rootDir, 'tools', 'ripgrep.lock.json'), 'utf8'));
const script = fs.readFileSync(path.join(rootDir, 'tools', 'fetch-ripgrep.ps1'), 'utf8');
const constOf = (src, name) => { const m = src.match(new RegExp(`^\\$${name}\\s*=\\s*'?([^'\\r\\n]+?)'?\\s*$`, 'm')); return m ? m[1] : null; };

export function assertLockShape(l) {
  for (const k of ['name', 'version', 'url', 'zip_sha256', 'unpacked', 'source', 'tag_signer', 'retrieved_at', 'upgrade', 'url_allow_prefix', 'redirect_allow_hosts'])
    assert.ok(k in l, `lock.${k} missing`);
  assert.match(l.zip_sha256, /^[0-9a-f]{64}$/);
  assert.ok(Array.isArray(l.unpacked) && l.unpacked.length >= 1);
  for (const u of l.unpacked) { assert.match(u.sha256, /^[0-9a-f]{64}$/); assert.ok(Number.isInteger(u.size) && u.size > 0, 'unpacked[].size must be an integer byte count'); }
  assert.equal(l.source.immutable, 'git-tagged-only');
  assert.equal(l.source.attested, false, 'upstream publishes no attestation — attested must be false');
  assert.equal(l.tag_signer.scope, 'git-tag-only', 'tag signature proves the source tag only, never the binary');
  assert.ok(l.url.startsWith(l.url_allow_prefix), 'url must be under url_allow_prefix');
  const up = l.upgrade.join('\n');
  assert.match(up, /\.sha256/); assert.match(up, /git verify-tag/);
}
export function assertLockMatchesScript(l, src) {
  assert.equal(constOf(src, 'Version'), l.version, 'version drift (lock vs script)');
  assert.equal(constOf(src, 'ZipSha'), l.zip_sha256, 'zip sha256 drift');
  assert.equal(constOf(src, 'ExeSha'), l.unpacked[0].sha256, 'exe sha256 drift');
  assert.equal(Number(constOf(src, 'ExeSize')), l.unpacked[0].size, 'exe size drift (size assertion must be code)');
  assert.equal(constOf(src, 'UrlPrefix'), l.url_allow_prefix, 'url prefix drift');
  assert.equal(l.url, `${l.url_allow_prefix}${l.version}/ripgrep-${l.version}-${l.platform}.zip`, 'lock url must be prefix + version + asset name');
  assert.equal(constOf(src, 'ZipName'), `"ripgrep-$Version-${l.platform}.zip"`, 'asset name drift');
  assert.equal(constOf(src, 'ZipUrl'), '"https://github.com/BurntSushi/ripgrep/releases/download/$Version/$ZipName"', 'url template drift');
  assert.ok(`https://github.com/BurntSushi/ripgrep/releases/download/`.startsWith(l.url_allow_prefix), 'script url must sit under the lock prefix');
  for (const h of l.redirect_allow_hosts) assert.ok(src.includes(`'${h}'`), `redirect host ${h} missing in script`);
}
export function assertScriptStructure(src) {
  const idx = s => { const i = src.indexOf(s); assert.ok(i >= 0, 'missing: ' + s); return i; };
  assert.doesNotMatch(src, /Invoke-WebRequest[^\n]*\.sha256/i, 'never fetch the .sha256 at run time (same-origin tamper ⇒ zero verification)');
  assert.ok(idx('$curLen -ne $ExeSize') < idx('Get-FileSha256 $dst }'), 'length check must precede hashing of the installed exe');
  assert.ok(idx('$ZipUrl.StartsWith($UrlPrefix') < idx('Invoke-WebRequest -Uri $ZipUrl'), 'URL allowlist must be enforced before any network call');
  assert.match(src, /if \(-not \$final\) \{ throw/, 'unknown final URL must fail closed');
  assert.match(src, /\$RedirectHosts -notcontains \(\[uri\]\$final\)\.Host\) \{ throw/, 'redirect host allowlist must throw');
  const exeLen = idx('$exe.Length -ne $ExeSize'), exeSha = idx('$es = Get-FileSha256 $exe.FullName'), exeCmp = idx('if ($es -ne $ExeSha) { throw'), copy = idx('Copy-Item -LiteralPath $exe.FullName');
  assert.ok(exeLen < exeSha && exeSha < exeCmp && exeCmp < copy, 'unpacked exe must be size- and hash-checked before it is copied into place');
  assert.ok(idx('if ($zs -ne $ZipSha) { throw') < idx('Expand-Archive'), 'zip must be verified before expansion');
}

test('R2-M: ripgrep lock has every field with the right provenance claims (git-tagged-only, attested=false, tag scope)', () => {
  assertLockShape(lock);
  assert.throws(() => assertLockShape({ ...lock, source: { ...lock.source, attested: true } }), /attested must be false/);
  assert.throws(() => assertLockShape({ ...lock, tag_signer: { ...lock.tag_signer, scope: 'binary' } }), /source tag only/);
  assert.throws(() => assertLockShape({ ...lock, upgrade: ['download and go'] }), /sha256/);
});
test('R2-M: lock ≡ fetch-ripgrep.ps1 constants (version / url / zip+exe sha256 / 4 218 880 B)', () => {
  assertLockMatchesScript(lock, script);
  assert.equal(lock.unpacked[0].size, 4218880);
  assert.throws(() => assertLockMatchesScript({ ...lock, unpacked: [{ ...lock.unpacked[0], size: 4218881 }] }, script), /size drift/);
  assert.throws(() => assertLockMatchesScript(lock, script.replace("$ExeSha    = '1423", "$ExeSha    = '0423")), /exe sha256 drift/);
});
test('R2-M: script structure — length before hash, URL allowlist before network, redirect allowlist fails closed, exe checked before copy', () => {
  assertScriptStructure(script);
});
test('R2-M negatives (task book "do not regress" ×3 + size): each mutation is reported by name', () => {
  const dyn = script.replace("$ZipSha    = '71b2", "$ZipSha    = (Invoke-WebRequest -Uri \"$ZipUrl.sha256\" -UseBasicParsing).Content.Split(' ')[0] # '71b2");
  assert.throws(() => assertScriptStructure(dyn), /never fetch the \.sha256/);
  const noExe = script.replace('    if ($es -ne $ExeSha) { throw', '    if ($false) { throw');
  assert.throws(() => assertScriptStructure(noExe), /missing: if \(\$es -ne \$ExeSha\)/);
  const copyFirst = script.replace('    New-Item -ItemType Directory -Path $binDir -Force | Out-Null\n    Copy-Item -LiteralPath $exe.FullName -Destination $dst -Force\n', '').replace('    if ($exe.Length -ne $ExeSize)', '    Copy-Item -LiteralPath $exe.FullName -Destination $dst -Force\n    if ($exe.Length -ne $ExeSize)');
  assert.notEqual(copyFirst, script, 'copy-first mutation must apply');
  assert.throws(() => assertScriptStructure(copyFirst), /before it is copied/);
  const noSize = script.replace('$cur = if ($curLen -ne $ExeSize) { "size=$curLen≠$ExeSize" } else { Get-FileSha256 $dst }', '$cur = Get-FileSha256 $dst');
  assert.throws(() => assertScriptStructure(noSize), /missing: \$curLen -ne \$ExeSize/);
});

test('R2-M live (offline): -Check on a temp copy — missing / wrong size / right size wrong hash ⇒ rc=1 with MISS/DIFF; off-list URL ⇒ throws before network', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r2m-'));
  try {
    const tools = path.join(tmp, 'tools'); fs.mkdirSync(path.join(tools, 'bin'), { recursive: true });
    const copy = path.join(tools, 'fetch-ripgrep.ps1'); fs.copyFileSync(path.join(rootDir, 'tools', 'fetch-ripgrep.ps1'), copy);
    const rg = path.join(tools, 'bin', 'rg.exe');
    const miss = await runPwsh(['-File', copy, '-Check']);
    assertRanRed(miss, /MISS .*rg\.exe/, 'missing exe');
    fs.writeFileSync(rg, 'not ripgrep');
    const small = await runPwsh(['-File', copy, '-Check']);
    assertRanRed(small, /DIFF .*size=11≠4218880/, 'wrong size');
    fs.writeFileSync(rg, Buffer.alloc(4218880));
    const sameSize = await runPwsh(['-File', copy, '-Check']);
    assertRanRed(sameSize, /DIFF .*sha256=[0-9a-f]{64} ≠/, 'right size, wrong hash');
    fs.rmSync(rg);
    const evil = path.join(tools, 'fetch-evil.ps1');
    fs.writeFileSync(evil, fs.readFileSync(copy, 'utf8').replace('$ZipUrl    = "https://github.com/BurntSushi/ripgrep/releases/download/$Version/$ZipName"', '$ZipUrl    = "https://evil.example/$ZipName"'), 'utf8');
    assert.notEqual(fs.readFileSync(evil, 'utf8'), fs.readFileSync(copy, 'utf8'), 'evil-URL mutation must apply');
    const bad = await runPwsh(['-File', evil]);
    assertRanRed(bad, /下载 URL 不在白名单/, 'off-list URL');
    assert.doesNotMatch(bad.stdout, /^GET /m, 'must throw before any GET');
    console.log(`[R2-M live] missing rc=${miss.status} | size rc=${small.status} | hash rc=${sameSize.status} | evil-url rc=${bad.status}`);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
test('R2-M live positive: the real tools/bin/rg.exe (host only; not in repo) passes -Check', async (t) => {
  if (!fs.existsSync(path.join(rootDir, 'tools', 'bin', 'rg.exe'))) { t.skip('tools/bin/rg.exe absent here (binary is not committed; host-only positive)'); return; }
  const r = await runPwsh(['-File', path.join(rootDir, 'tools', 'fetch-ripgrep.ps1'), '-Check']);
  assertRanGreen(r, /OK .*sha256 一致/, 'real rg.exe');
});
