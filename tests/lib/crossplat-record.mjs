// U-278（v1.60.0，B3-7）：**跨平台实跑记录**的判据 —— 记录与文档承诺必须对得上。
//
// 病：`SKILL.md` 的 compatibility 写着「Windows PowerShell 5.1 或 PowerShell 7+（pwsh）」，
//   读起来像"跨平台可用"，但 CI 只有 windows-latest，`crossplat.yml` 根本不存在 ——
//   文字承诺没有任何一次实跑支撑（验收问题 F14）。
//
// 判据分两层，缺一层都能自欺：
//   ① **记录本身自洽**：`verdict` 必须与三个计数（product / meta / env）一致。
//      允许"手写 verdict=green 而 productRed=3"这种事存在，就等于记录是装饰。
//   ② **文档 = 记录投影**：`SKILL.md` 里那行「跨平台实跑：已验证 …」列出的平台集合，
//      必须**恰好等于**有记录且 product/meta 全绿（env 红不算失败）的平台集合。
//      多写一个平台 ⇒ 没有证据的承诺；少写一个 ⇒ 有证据不敢说（逼着把实测结果写进文档）。
//
// ★`env` 红不参与"是否已验证"的判定，但**必须记录**：它意味着"这门在这台机器上没跑成"
//   （缺外部二进制、无网络、清理被拦）。把它当失败会让 Linux 永远验不过；把它丢掉就是撒谎。
//   所以：判定看 product/meta，报告里 env 数照抄。

export const RECORD_SCHEMA = 'u278-crossplat/1';
export const CLAIM_PREFIX = '跨平台实跑：已验证';

/** Windows 名称 → Node 的 process.platform 值 */
export const PLATFORM_TOKENS = Object.freeze({ Windows: 'win32', Linux: 'linux', macOS: 'darwin' });

/** 三计数 → verdict（单一实现：记录生成与判据读同一个函数，否则两边会各说各话） */
export function verdictOf(summary) {
  const p = Number(summary?.productRed ?? 0);
  const m = Number(summary?.metaRed ?? 0);
  const e = Number(summary?.envRed ?? 0);
  if (p > 0) return 'red';
  if (m > 0) return 'meta-red';
  if (e > 0) return 'env-red';
  return 'green';
}

/** 记录是否"验证了这个平台"：product 与 meta 都必须为 0（env 红不算失败，但见文件头的说明） */
export function verifiedPlatforms(records) {
  const out = new Set();
  for (const r of records) {
    const s = r?.summary || {};
    if (Number(s.productRed ?? -1) === 0 && Number(s.metaRed ?? -1) === 0 && r?.facts?.os?.platform) {
      out.add(r.facts.os.platform);
    }
  }
  return out;
}

/**
 * 单份记录的结构与自洽。
 * @returns {{ok: boolean, problems: string[]}}
 */
export function checkRecord(doc, name = '(record)') {
  const problems = [];
  const bad = (m) => problems.push(`${name}: ${m}`);
  if (!doc || typeof doc !== 'object') return { ok: false, problems: [name + ': 不是对象'] };
  if (doc.schema !== RECORD_SCHEMA) bad(`schema=${doc.schema ?? 'missing'}（要 ${RECORD_SCHEMA}）`);
  if (!doc.facts || typeof doc.facts !== 'object') bad('缺 facts（没有环境事实的"绿"无法复现）');
  else {
    if (!doc.facts.os || typeof doc.facts.os.platform !== 'string') bad('facts.os.platform 缺失');
    if (!doc.facts.node) bad('facts.node 缺失');
    if (!doc.facts.pwsh || !doc.facts.pwsh.version) bad('facts.pwsh.version 缺失（连解释器版本都没记）');
    if (!doc.facts.os || typeof doc.facts.os.arch !== 'string') bad('facts.os.arch 缺失');
  }
  if (!Number.isInteger(doc.gates) || doc.gates <= 0) bad('gates 必须是正整数（0 个门的"绿"等于没跑）');
  if (!doc.runMode) bad('runMode 缺失（并行绿与串行绿的可信度不同，必须区分）');
  const s = doc.summary || {};
  for (const k of ['productRed', 'envRed']) {
    if (!Number.isInteger(s[k])) bad(`summary.${k} 必须是整数`);
  }
  if (!Number.isInteger(s.metaRed)) bad('summary.metaRed 必须是整数（缺字段的老记录不可引用）');
  const want = verdictOf(s);
  if (doc.verdict !== want) bad(`verdict=${doc.verdict ?? 'missing'} 与计数不符（product=${s.productRed} meta=${s.metaRed} env=${s.envRed} ⇒ 应为 ${want}）`);
  return { ok: problems.length === 0, problems };
}

/**
 * 从 SKILL.md 正文解析「跨平台实跑：已验证 …」那一行。
 * @returns {{ok:boolean, platforms:Set<string>, problems:string[]}}
 */
export function parseClaim(text) {
  const problems = [];
  const platforms = new Set();
  const line = String(text || '').split(/\r?\n/).find((l) => l.includes(CLAIM_PREFIX));
  if (!line) return { ok: false, platforms, problems: [`SKILL.md 里没有「${CLAIM_PREFIX} …」这一行（没有承诺面就无法核对）`] };
  const tail = line.slice(line.indexOf(CLAIM_PREFIX) + CLAIM_PREFIX.length).replace(/[\s。.；;]+$/, '');
  // 括号之后是解释（日期、日志路径、"macOS 未跑"），不参与平台解析 ——
  //   否则"（2026-10-27；记录 …）"里的词会被当成平台名而报"无法识别"。
  const head = tail.split(/[（(]/)[0];
  // 允许用 、 ， 和空格分隔；只认已知平台名，别的一律报出来（防"写了却没解析到"）
  const tokens = head.split(/[、，,;；\s]+/).map((t) => t.trim()).filter(Boolean);
  for (const t of tokens) {
    if (t === '（无）' || t === '(无)' || t === 'none') continue;
    if (PLATFORM_TOKENS[t]) platforms.add(PLATFORM_TOKENS[t]);
    else problems.push(`承诺行里有无法识别的平台名：${t}（只认 ${Object.keys(PLATFORM_TOKENS).join(' / ')}）`);
  }
  return { ok: problems.length === 0, platforms, problems };
}
