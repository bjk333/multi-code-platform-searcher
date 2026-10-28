// U-276（v1.58.0，验收 B3-5）：**变异抽检**的核心 —— 纯函数，能被门直接做真值表。
//
// 为什么要有这一层（设计文档 §5 规则 6）：行为门全绿可以有两种含义 —— "行为对"或"门看不见这段代码"。
//   两者在日志里长得一模一样。变异抽检是唯一能把它们分开的机械手段：往产品里注入一个小改动，
//   如果门**仍然全绿**，说明它看不见这段代码（"无效绿"）。
//
// 三条自我约束（都不是"实现细节"，是防止这套东西变成新的假绿来源）：
//   ① **只打变更行**：全量变异跑不起（本仓 24 个引擎 × 若干算子 = 上千个变体）。抽检的口径是
//      "这一版改动的地方，门看不看得见"，不是"整个产品有多强"。
//   ② **算子必须保语法**：只改比较/逻辑算子与布尔字面量。否则大量变体是语法错误 ⇒ 所有门都"红"⇒
//      分数虚高（这叫 stillborn，必须单列，且算**算子 bug**，不是门变强了）。
//   ③ **空候选不是绿**：没有变更行 ⇒ `no-candidates`。把它算成 100% 是把"没测"包装成"全过"。
//
// 变更行的口径：**行集合差**（head 里不出现在 base 里的非空行）。
//   刻意不用 LCS：抽样工具只需要"不漏语义改动"，多抽几行无害；而行集合差对"移动/重排"会多报，
//   方向是安全的（多测，不会漏测）。已知盲区：与基线完全相同的**新行**（多半是 `}`、空行）不会成为候选。

/** 变异算子表。每条都要求：只在**代码位**命中（不在字符串/注释里），且替换后语法不变。 */
export const PS_MUTATORS = Object.freeze([
  { id: 'eq-ne', re: /-eq\b/g, to: '-ne', note: '-eq → -ne' },
  { id: 'ne-eq', re: /-ne\b/g, to: '-eq', note: '-ne → -eq' },
  { id: 'gt-ge', re: /-gt\b/g, to: '-ge', note: '-gt → -ge（边界偏移）' },
  { id: 'ge-gt', re: /-ge\b/g, to: '-gt', note: '-ge → -gt' },
  { id: 'lt-le', re: /-lt\b/g, to: '-le', note: '-lt → -le' },
  { id: 'le-lt', re: /-le\b/g, to: '-lt', note: '-le → -lt' },
  { id: 'and-or', re: /-and\b/g, to: '-or', note: '-and → -or' },
  { id: 'or-and', re: /-or\b/g, to: '-and', note: '-or → -and' },
  { id: 'true-false', re: /\$true\b/g, to: '$false', note: '$true → $false' },
  { id: 'false-true', re: /\$false\b/g, to: '$true', note: '$false → $true' },
  { id: 'not-drop', re: /-not\s+/g, to: '', note: '-not → 去掉（条件取反）' },
]);

/**
 * 代码位掩码：1 = 该字符处于代码区（不在字符串/注释里）。
 * 只处理到"不会把代码误判成字符串"的程度就够了 —— 判错的代价是多一个/少一个候选，
 * 而"在注释里变异"必须避免（那种变体永远不会被杀掉，会污染分数）。
 */
export function codeMask(line) {
  const s = String(line ?? '');
  const mask = new Uint8Array(s.length);
  let i = 0; let st = 'code';
  while (i < s.length) {
    const c = s[i];
    if (st === 'code') {
      if (c === "'") { st = 'sq'; i++; continue; }
      if (c === '"') { st = 'dq'; i++; continue; }
      if (c === '#') break;                       // 余下全是注释
      mask[i] = 1; i++; continue;
    }
    if (st === 'sq') { if (c === "'") { if (s[i + 1] === "'") { i += 2; continue; } st = 'code'; } i++; continue; }
    if (c === '`') { i += 2; continue; }                                   // 双引号内的转义
    if (c === '"') { if (s[i + 1] === '"') { i += 2; continue; } st = 'code'; }
    i++;
  }
  return mask;
}

/** head 里有、base 里没有的非空行（1-based 行号，按出现顺序） */
export function changedLines(baseText, headText) {
  const norm = (t) => String(t ?? '').split(/\r?\n/).map((l) => l.trimEnd());
  const base = new Set(norm(baseText));
  const out = [];
  norm(headText).forEach((l, i) => { if (l.trim() && !base.has(l)) out.push(i + 1); });
  return out;
}

/**
 * 从变更行里抽候选变异（每行最多一个，按行号顺序）。
 * @returns {{file:string,line:number,column:number,op:string,from:string,to:string,before:string,after:string}[]}
 */
export function mutantsFor({ file, headText, changeLines, max = Infinity }) {
  const lines = String(headText ?? '').split(/\r?\n/);
  const out = [];
  for (const ln of changeLines) {
    if (out.length >= max) break;
    const line = lines[ln - 1];
    if (line == null || !line.trim()) continue;
    const mask = codeMask(line);
    for (const m of PS_MUTATORS) {
      const re = new RegExp(m.re.source, 'g');
      let hit;
      while ((hit = re.exec(line))) {
        if (!mask[hit.index]) continue;                       // 落在字符串/注释里 ⇒ 跳过
        out.push({
          file, line: ln, column: hit.index + 1, op: m.id,
          from: hit[0], to: m.to,
          before: line, after: line.slice(0, hit.index) + m.to + line.slice(hit.index + hit[0].length),
        });
        break;
      }
      if (out.length && out[out.length - 1].line === ln) break;   // 一行只出一个
    }
  }
  return out.slice(0, max === Infinity ? undefined : max);
}

/** 把变异应用回全文（按行替换，只改 after 那一行） */
export function applyMutants(headText, mutants) {
  const lines = String(headText ?? '').split(/\r?\n/);
  for (const m of mutants) lines[m.line - 1] = m.after;
  return lines.join('\n');
}

/**
 * 打分。status: killed（至少一条门红）/ survived（门全绿）/ stillborn（语法坏）/ error（跑不起来/env）。
 * ★stillborn 与 error **不进分母**：它们说明的是"这次测量无效"，不是"门变强/变弱"。
 */
export function scoreResults(results) {
  const byFile = {};
  for (const r of results) {
    const f = (byFile[r.file] ||= { file: r.file, total: 0, killed: 0, survived: 0, stillborn: 0, error: 0, score: 0 });
    if (r.status === 'killed') { f.total++; f.killed++; }
    else if (r.status === 'survived') { f.total++; f.survived++; }
    else if (r.status === 'stillborn') f.stillborn++;
    else f.error++;
  }
  let total = 0; let killed = 0; let survived = 0; let stillborn = 0; let error = 0;
  for (const f of Object.values(byFile)) {
    f.score = f.total ? f.killed / f.total : 0;
    total += f.total; killed += f.killed; survived += f.survived; stillborn += f.stillborn; error += f.error;
  }
  return {
    overall: { total, killed, survived, stillborn, error, score: total ? killed / total : 0 },
    byFile,
  };
}

/**
 * 判决。**只有 ok 是绿**；其余都要人看（由 CLI 映射成不同的退出码）。
 *   no-candidates : 没有变更行 ⇒ 没测（不是绿）
 *   mutator-bug   : 有 stillborn ⇒ 算子把语法弄坏了，分数无意义
 *   inconclusive  : 有 error ⇒ 有变体没跑成
 *   invalid-green : 一条都没杀掉 ⇒ 门看不见这些改动（设计文档 §5 规则 6 点名的那种）
 *   weak          : 分数低于门槛（默认 0.5）
 */
export function verdictOf(score, { minScore = 0.5, candidates = null } = {}) {
  const o = score?.overall || { total: 0, killed: 0, survived: 0, stillborn: 0, error: 0, score: 0 };
  const n = candidates == null ? o.total + o.stillborn + o.error : candidates;
  if (o.stillborn > 0) return { verdict: 'mutator-bug', why: `${o.stillborn} 个变体语法就不合法（算子 bug，不是门强）` };
  if (n === 0) return { verdict: 'no-candidates', why: '没有变更行可抽 —— 这不是绿，是没测' };
  if (o.error > 0) return { verdict: 'inconclusive', why: `${o.error} 个变体没跑成（infra/超时），分数不可用` };
  if (o.total === 0) return { verdict: 'inconclusive', why: '有候选但一个都没跑成' };
  if (o.killed === 0) return { verdict: 'invalid-green', why: `行为全绿但 ${o.total} 个变体一个都没杀掉 ⇒ 门看不见这些改动（无效绿）` };
  if (o.score < minScore) return { verdict: 'weak', why: `变异分数 ${(o.score * 100).toFixed(1)}% < 门槛 ${(minScore * 100).toFixed(0)}%` };
  return { verdict: 'ok', why: `变异分数 ${(o.score * 100).toFixed(1)}%（${o.killed}/${o.total}），${o.survived} 个存活` };
}

/** 判决 → 退出码（0 只给 ok 与 no-candidates；no-candidates 会大声打印，不会被误读成绿） */
export function exitCodeForVerdict(v) {
  return ({ ok: 0, 'no-candidates': 0, weak: 0, 'not-run': 0, 'invalid-green': 1, 'mutator-bug': 2, inconclusive: 3 })[v] ?? 3;
}
