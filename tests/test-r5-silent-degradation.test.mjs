// R5-TLS · 「静默假阴性」门（引擎吞掉失败 ⇒ 被池尾兜成成功 ⇒ Verdict 仍 full）
//
// 机制（本门要防的就是它）：
//   引擎内部 catch 吞掉异常 → `return @()` 且**不设引擎状态** → 状态停留 `unknown`
//   → 主脚本池尾兜底（L3056-3057）：`unknown` + 0 结果 ⇒ 判 `empty`（"检索成功但 0 命中"）
//   → 该引擎不进 blocked/degraded ⇒ `coverage.Verdict` 仍是 **full**
//   → 调用方看到 full + 0 条 ⇒ 得出"这个源确实没东西"的错误结论。
//
// ★A/B 实测（2026-10-10，同一故障注入=把 codeberg 域名改成不可达）：
//     旧版：Verdict=full   status=ok     results=0  errors=[]                      ← 静默假阴性
//     修后：Verdict=none   status=failed            errors=["engines.Codeberg:error"]
//   证据：reports/gates/r5-tls-2026-10-10/silent-degradation-ab.json
//
// 同族前科：search-gitlab.ps1（U-157，2026-10-02 已修，其头部注释记着同款病灶）。
// 本门把「catch 吞失败」钉成全引擎级禁止项，防新增引擎重犯。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceAll } from './lib/source.mjs';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(testsDir, '..');
const ENGINES = fs.readdirSync(path.join(root, 'engines')).filter(f => f.endsWith('.ps1'));

// 取每个 catch 块（按花括号配平），判块内是否「return @() 且无 Set-EngineStatus」
function catchBlocks(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/catch\s*\{/.test(lines[i])) continue;
    let depth = 0, started = false, body = [];
    for (let j = i; j < lines.length; j++) {
      const seg = lines[j];
      for (const ch of seg) { if (ch === '{') { depth++; started = true; } else if (ch === '}') { depth--; } }
      body.push(seg);
      if (started && depth <= 0) break;
    }
    out.push({ at: i + 1, body: body.join('\n') });
  }
  return out;
}

test('R5-TLS-1（全引擎扫描）: 禁止「catch 里 return @() 却不设引擎状态」', () => {
  const offenders = [];
  for (const f of ENGINES) {
    const raw = fs.readFileSync(path.join(root, 'engines', f), 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
    const lines = raw.map(l => (/^\s*#/.test(l) ? '' : l));   // ★剔注释（本仓已多次栽在"门匹配到注释"）
    for (const cb of catchBlocks(lines)) {
      if (!/return\s+@\(\)/.test(cb.body)) continue;
      if (/Set-EngineStatus/.test(cb.body)) continue;
      offenders.push(`${f}:${cb.at}`);
    }
  }
  console.log(`[R5-TLS] 扫描 ${ENGINES.length} 个引擎，catch 吞失败处 ${offenders.length} 处`);
  assert.deepEqual(offenders, [],
    '★这些 catch 吞掉失败且不设状态 ⇒ 会被池尾兜成 empty ⇒ Verdict 仍 full（静默假阴性）:\n  ' + offenders.join('\n  '));
});

test('R5-TLS-2（负例自检）: 把已修引擎的显式上报去掉，本门必须能识别', () => {
  // 用内存改写模拟"回退到旧写法"，不触碰磁盘
  const src = fs.readFileSync(path.join(root, 'engines/codeberg.ps1'), 'utf8').replace(/^\uFEFF/, '');
  const broken = src
    .replace(/Set-EngineStatus -Name 'Codeberg' -Status 'error'[\s\S]{0,120}?\n/, '\n')
    .replace(/Add-EngineWarning -Engine 'Codeberg'[\s\S]{0,120}?\n/, '\n');
  const lines = broken.split(/\r?\n/).map(l => (/^\s*#/.test(l) ? '' : l));
  const hit = catchBlocks(lines).some(cb => /return\s+@\(\)/.test(cb.body) && !/Set-EngineStatus/.test(cb.body));
  assert.ok(hit, '★负例自检失败：去掉显式上报后本应可识别出违规');
});

test('R5-TLS-5（同族形态 · kind 循环）: 多子源循环里的 catch 不许"只打印/continue 不记账"', () => {
  // 由来：hugging-face.ps1 的 models/datasets/spaces 三 kind 循环，catch 只打印、`if (-not $data) { continue }` 不记账
  //   ⇒ 「三个都连不上」与「都搜了没结果」在载荷里无法区分（实测隔离后 ReasonCodes 报 zero-hit 且 errors[] 无它）。
  //   判定：文件里若出现 `catch { ... continue 或仅 Write-ColorOutput ... }` **且全文无 Set-EngineStatus** ⇒ 红。
  const offenders = [];
  for (const f of ENGINES) {
    const raw = fs.readFileSync(path.join(root, 'engines', f), 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
    const lines = raw.map(l => (/^\s*#/.test(l) ? '' : l));
    const whole = lines.join('\n');
    // ★B2-1（U-258）：记账形态多了一种 —— engine/1 封套把"失败事实"记在 `failure` / 请求账上（`$req.failed++`），
    //   由池侧派生 status。所以"整文件不设状态"不再等于"不记账"；判定改为"没有任何一种记账形态"。
    //   注意这不是放宽：下面逐 catch 的允许清单同样要认这几种形态，否则 HF 的新写法会被判成"只打印"。
    const hasStatus = /Set-EngineStatus|New-EngineEnvelope/.test(whole) && /failure\s*=|Set-EngineStatus|\$failedKinds \+=/.test(whole);
    if (hasStatus) continue;                      // 已显式记账的文件跳过（本形态专抓"整文件不设状态"）
    for (const cb of catchBlocks(lines)) {
      const prints = /Write-ColorOutput/.test(cb.body);
      const cont = /\bcontinue\b/.test(cb.body);
      if ((prints || cont) && !/Set-EngineStatus|Add-EngineWarning|throw|\$req\.failed\+\+|\$failedKinds \+=|failure\s*=/.test(cb.body)) {
        offenders.push(`${f}:${cb.at}`);
      }
    }
  }
  console.log(`[R5-TLS] kind 循环同族形态：${offenders.length} 处`);
  assert.deepEqual(offenders, [],
    '★这些 catch 只打印/continue 且不记账，且该文件全文不设引擎状态 ⇒ 失败会被兜成"搜了没结果":\n  ' + offenders.join('\n  '));
});

test('R5-TLS-6（HF 回归）: 全部 kind 失败必须显式失败，且引擎名用注册表 Name', () => {
  const HF = fs.readFileSync(path.join(root, 'engines/hugging-face.ps1'), 'utf8').replace(/^\uFEFF/, '');
  assert.match(HF, /\$failedKinds\s*=\s*@\(\)/, 'HF 必须按 kind 记账');
  assert.match(HF, /\$failedKinds \+= \$k\.label/, 'catch 必须把失败的 kind 记进列表');
  // ★B2-1（U-258）后本引擎改为返回 engine/1 封套：失败事实进 `failure`，status 由池侧派生。
  //   判据因此从"必须写 Set-EngineStatus -Status 'error'"改为"必须把全部失败显式写进 failure"，
  //   意图不变（失败不许被兜成"搜了没结果"），但不再钉死某一种实现。
  assert.match(HF, /failedKinds\.Count -ge \$kinds\.Count[\s\S]{0,160}?\$failure = @\{ reasonCode = 'error'[\s\S]{0,80}?全部 kind/, '全部 kind 失败必须显式进 failure（含 reasonCode）');
  assert.match(HF, /New-EngineEnvelope -Engine 'HF'/, '必须走 engine/1 封套返回');
  assert.match(HF, /Add-EngineWarning -Engine 'HF'/, '必须带 warning（可审计）');
  // ★引擎名必须是注册表 Name（'HF'），不是 Platforms 显示名（'HuggingFace'）——
  //   写错会让状态/封套落到一个不存在的键上 ⇒ 状态仍是 unknown ⇒ 又被兜成 empty。
  assert.doesNotMatch(HF, /-Engine 'HuggingFace'/, '★引擎名必须用注册表 Name=HF，不是显示名');
  assert.doesNotMatch(HF, /Set-EngineStatus -Name 'HuggingFace'/, '★引擎名必须用注册表 Name=HF，不是显示名');
});

test('R5-TLS-3（机制守卫）: 池尾兜底必须仍在（它是必要的），且只对真正的 unknown 生效', () => {
  const MAIN = sourceAll(path.join(root)).replace(/^\uFEFF/, '');
  assert.match(MAIN, /Get-EngineStatus -Name \$h\.Engine\.Name\) -eq 'unknown'/,
    '池尾的 unknown 兜底必须仍在（有些引擎确实不设状态，删了会退化）');
  assert.match(MAIN, /Status 'empty' -Reason '检索成功但 0 命中'/, '兜底语义应保持');
  // 本门的存在意义：兜底只应对"真·没设状态"生效 —— 而引擎自己 catch 掉的失败**必须**显式上报（R5-TLS-1 守）
  assert.match(MAIN, /Resolve-EngineStatusFromResults/, '按结果纠正状态的纯函数应仍在（反向纠正路径）');
});
