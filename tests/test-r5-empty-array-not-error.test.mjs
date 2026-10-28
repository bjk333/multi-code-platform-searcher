// R5 · 「0 命中 ≠ 故障」门（PS7 空数组语义坑）
//
// 根因（R5 多路调研实测，铁证）：
//   GitLab 对无匹配的查询返回 **200 + `[]`**（body 仅 2 字节，实测）。
//   而 **PS 7.6.6 里 `'[]' | ConvertFrom-Json` 得到 `$null`**（不是空数组！实测）。
//   ⇒ `search-gitlab.ps1` 原来的 `if ($null -eq $data) { throw 'GitLab 返回空响应' }` 把
//     **「检索成功但 0 命中」误报成「失败」** ⇒ code=error + Verdict 降级 ⇒ 调用方以为链路故障
//     （修前实测 `-Platform GitLab` 5/5 全红；修后同一查询 `Verdict=full · ReasonCodes={"GitLab":"zero-hit"}`）。
//
// 判据（每条可弄红）：
//   ① 把 PS7 的这个语义坑钉成**可执行事实**（不是注释）
//   ② 该引擎必须**先看原始 body** 再解析；真·空 body 才算异常
//   ③ 爆炸半径：全 engines/ 不得再出现"ConvertFrom-Json 之后立刻 $null 即 throw"的同族写法
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(testsDir, '..');
const GL = fs.readFileSync(path.join(root, 'engines/search-gitlab.ps1'), 'utf8').replace(/^\uFEFF/, '');
const ENGINES = fs.readdirSync(path.join(root, 'engines')).filter(f => f.endsWith('.ps1'));

test('R5-1（★事实）: PS 里 `\'[]\' | ConvertFrom-Json` 得到 $null —— 空数组≠$null', async () => {
  const probe = [
    "$d = '[]' | ConvertFrom-Json",
    "[PSCustomObject]@{ isNull = ($null -eq $d); isArray = ($d -is [System.Array]); count = @($d).Count; ps = $PSVersionTable.PSVersion.ToString() } | ConvertTo-Json -Compress",
  ].join('; ');
  const r = await new Promise(res => {
    const c = spawn('pwsh', ['-NoProfile', '-Command', probe], { cwd: root, windowsHide: true });
    let o = '', e = ''; c.stdout.on('data', d => { o += d; }); c.stderr.on('data', d => { e += d; });
    c.once('close', code => res({ code, o, e }));
    c.once('error', x => res({ code: null, o: '', e: x.message }));
  });
  assert.equal(r.code, 0, '探针必须跑通: ' + r.e.slice(0, 200));
  const j = JSON.parse(r.o.trim().split(/\r?\n/).filter(Boolean).pop());
  console.log(`[R5] PS ${j.ps}: '[]' → isNull=${j.isNull} isArray=${j.isArray} count=${j.count}`);
  assert.equal(j.isNull, true, '★本项的整个判据建立在"[] 解析成 $null"上；若某天 PS 改了语义，本门会红 ⇒ 提示复核修复必要性');
  assert.equal(j.isArray, false, '[] 解析后不是数组 —— 这正是"看起来像空结果、实则是 $null"的坑');
});

test('R5-2（源码守卫）: search-gitlab 必须**先判原始 body**，真·空 body 才算异常', () => {
  assert.match(GL, /\$rawText\s*=/, '必须先取原始 body 文本再解析（不能直接 ConvertFrom-Json 就看 $null）');
  assert.match(GL, /if \(\$rawText\.Trim\(\)\.Length -eq 0\) \{ throw/, '真·空 body 才允许 throw');
  assert.match(GL, /-eq '\[\]'\) \{ \$data = @\(\) \}/, "★`[]` 必须被显式还原为**空数组**（= 成功但空）");
  // 负例：旧写法（裸 $null 守卫）不得再出现
  assert.doesNotMatch(GL, /if \(\$null -eq \$data\) \{ throw 'GitLab 返回空响应' \}/,
    '★旧的裸 $null 守卫必须已移除（它就是误报源）');
});

test('R5-3（爆炸半径）: 全 engines/ 不得有同族的"ConvertFrom-Json 后立刻 $null 即 throw"', () => {
  const offenders = [];
  for (const f of ENGINES) {
    const raw = fs.readFileSync(path.join(root, 'engines', f), 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
    // ★先剔注释再扫：本轮首版就栽在这 —— 我在新注释里**原样引用了旧写法**做对照说明，
    //   而扫描器把注释当代码 ⇒ 假红。（同类今天第三次：门要明确"扫代码还是扫注释"。）
    const lines = raw.map(l => (/^\s*#/.test(l) ? '' : l));
    for (let i = 0; i < lines.length; i++) {
      if (!/ConvertFrom-Json/.test(lines[i])) continue;
      const next = (lines[i + 1] || '') + ' ' + (lines[i + 2] || '');
      if (!/\$null -eq (\\?\$)?\w+\s*\)\s*\{\s*throw/.test(next)) continue;
      const hasRawGuard = /rawText|\$raw\b/.test(lines[i]) || /rawText|\$raw\b/.test(next);
      if (!hasRawGuard) offenders.push(`${f}:${i + 1}`);
    }
  }
  assert.deepEqual(offenders, [], '★同族写法（会把"合法空结果"当失败）:\n  ' + offenders.join('\n  '));
  console.log(`[R5] 扫描 ${ENGINES.length} 个引擎：同族写法 ${offenders.length} 处（0 = 干净）`);
});
