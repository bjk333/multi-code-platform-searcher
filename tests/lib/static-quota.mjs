// U-275（v1.57.0，验收 B3-4）：**静态断言配额** —— 只降不升。
// U-276（v1.58.0，B3-5）：**口径修正** —— 配额只压"主体是产品"的静态门；登记为 meta 的度量/记账门另计。
//
// 为什么需要它：`tests/lib/test-shape.mjs` 能回答"有多少门是静态的"，但**回答不了"是不是又多了几个"**。
//   现实路径很清楚：改一个引擎 → 顺手加一条"源码里有这行"的断言（比写行为臂便宜一个数量级）→
//   门数 +1、行为占比 -ε，而每一轮的单次改动都小到不会被注意。棘轮要挡的是这种**逐个累积**。
//
// ★口径修正（v1.58.0，不是放宽，是把两种东西分开）：
//   B3-4 的配额把"度量/记账门"也算进了静态配额。于是每造一个**测量工具**（U-275 自己、U-276 抽检门）
//   都要先删掉一条产品断言 —— 这会把棘轮变成"别做度量"的压力，方向是错的：
//     · `meta`（主体是仓库记账/度量自身）的红**不代表**产品覆盖被稀释；
//     · 真正要压的是**对产品下了断言、却只读文本**的门。
//   所以 `productStatic = static − meta` 才受上限约束；`static` 全量仍进名单（改名/漏登记照样红），
//   且每条 meta 必须带**登记理由**（`{file: why}`），使"把产品门改名叫 meta"这件事在 diff 里刺眼。
//
// 口径（数据在 `tests/static-quota.json`）：
//   · `static`：**冻结名单**（全量静态门 basename）。集合相等是硬判据 ——
//     新加静态门 ⇒ "没入册"；把静态门改成行为门 ⇒ "册子里这条已不存在"，两条都红。
//   · `meta`：`{basename: 理由}`，必须是 `static` 的子集。只有这些门的红记 `meta_red`。
//   · `history`：每次真的减了**产品静态门**，就追加一条并把数字下调。`productStatic` 必须单调不增，
//     最后一条必须与当前一致 —— 于是"今天先改成 96、明天再说"这条路走不通。
//
// 为什么还要一个模块常量 `FROZEN_PRODUCT_STATIC_CEILING`（与 history[0] 冗余）：
//   单看 JSON，"把 history[0] 改成 96"和"合法的历史"长得一模一样。常量把同一个数记在**代码**里，
//   于是一次放行要同时改两个不同性质的文件（数据 + 代码），且两处不一致本身就会红。
//   这不是防恶意（防不住），是防"顺手"。
import fs from 'node:fs';
import path from 'node:path';

export const QUOTA_SCHEMA = 'u275-static-quota/2';
export const QUOTA_REL = 'tests/static-quota.json';
export const FROZEN_PRODUCT_STATIC_CEILING = 95;   // 2026-10-27（v1.58.0）冻结：114 静态门 − 19 meta

const isStr = (x) => typeof x === 'string' && x.trim().length > 0;
const uniq = (arr) => [...new Set(arr)];

/** 三个计数（全量静态 / 其中 meta / 计入配额的产品静态） */
export function countsOf(quota) {
  const meta = Object.keys(quota?.meta || {});
  const staticAll = Array.isArray(quota?.static) ? quota.static : [];
  return { static: staticAll.length, meta: meta.length, productStatic: staticAll.length - meta.length };
}

/**
 * @param {any} quota  static-quota.json 的内容
 * @param {{static: string[]}} actual 实测：当前被判为静态的门 basename
 * @returns {{ok: boolean, problems: string[], notes: string[]}}
 */
export function quotaVerdict(quota, actual, { ceiling = FROZEN_PRODUCT_STATIC_CEILING } = {}) {
  const problems = []; const notes = [];
  const bad = (m) => problems.push(m);
  if (!quota || typeof quota !== 'object') return { ok: false, problems: ['没有 tests/static-quota.json（先跑 node -e 或按 U-275 的提示生成）'], notes };
  if (quota.schema !== QUOTA_SCHEMA) bad(`schema 不认识（${quota.schema ?? 'missing'}）`);
  if (!Array.isArray(quota.static)) bad('`static` 必须是数组');
  if (!quota.meta || typeof quota.meta !== 'object' || Array.isArray(quota.meta)) bad('`meta` 必须是 {文件: 理由} 对象');
  if (!Array.isArray(quota.history) || !quota.history.length) bad('`history` 至少一条');
  if (problems.length) return { ok: false, problems, notes };

  const frozen = quota.static;
  const metaList = Object.keys(quota.meta);
  const hist = quota.history;
  const cur = countsOf(quota);

  if (!frozen.every(isStr)) bad('`static` 里有非字符串/空串');
  if (uniq(frozen).length !== frozen.length) bad('`static` 有重复项（重复 ⇒ 计数不可信）');
  for (const [k, v] of Object.entries(quota.meta)) {
    if (!isStr(k)) bad('`meta` 里有空文件名');
    if (!isStr(v)) bad(`\`meta\` 的 ${k} 没写理由 —— 登记必须说明"主体为什么是记账/度量"（否则它看起来像在给产品门开后门）`);
  }
  const notFrozen = metaList.filter((m) => !frozen.includes(m));
  if (notFrozen.length) bad(`\`meta\` 里有门不在 \`static\` 名单：${notFrozen.join(', ')}（meta 必须是静态门的子集）`);

  // ---- 集合相等（两个方向都必须说清楚该改哪边）----
  const actualSet = new Set(actual.static || []);
  const frozenSet = new Set(frozen);
  const missing = [...actualSet].filter((f) => !frozenSet.has(f)).sort();     // 实测有、册上无
  const stale = [...frozenSet].filter((f) => !actualSet.has(f)).sort();       // 册上有、实测无
  if (missing.length) bad(`新增静态门没入册：${missing.join(', ')} —— 配额只降不升；要加就先减一个（把旧的改成行为门，或删掉）`);
  if (stale.length) bad(`册子里的静态门已不存在/已被升级为行为门：${stale.join(', ')} —— 删掉这行，并追加一条 history`);
  if (!missing.length && !stale.length) notes.push(`静态门集合与册子一致：${frozen.length} 个`);

  // ---- 棘轮：productStatic 单调不增 + 末条与当前一致 + 常量与首条一致 ----
  for (const [i, h] of hist.entries()) {
    if (!h || typeof h !== 'object') { bad(`history[${i}] 不是对象`); continue; }
    if (!isStr(h.version)) bad(`history[${i}].version 缺失`);
    for (const k of ['static', 'meta', 'productStatic']) if (!Number.isInteger(h[k])) bad(`history[${i}].${k} 不是整数`);
  }
  for (let i = 1; i < hist.length; i++) {
    if (Number(hist[i].productStatic) > Number(hist[i - 1].productStatic)) {
      bad(`history[${i}] 把产品静态配额从 ${hist[i - 1].productStatic} 抬到 ${hist[i].productStatic} —— 只许降（要加对产品的静态断言，先减一个）`);
    }
  }
  const last = hist[hist.length - 1];
  if (Number(last.static) !== cur.static) bad(`history 末条 static=${last.static} ≠ 当前名单 ${cur.static}（改了名单就必须追加一条）`);
  if (Number(last.meta) !== cur.meta) bad(`history 末条 meta=${last.meta} ≠ 当前 meta 名单 ${cur.meta}`);
  if (Number(last.productStatic) !== cur.productStatic) bad(`history 末条 productStatic=${last.productStatic} ≠ 当前 ${cur.productStatic}`);
  if (Number(hist[0].productStatic) !== ceiling) bad(`history[0].productStatic=${hist[0].productStatic} ≠ 冻结上限 ${ceiling}（首条是冻结时的读数，不许回头改；要下调请追加新条目）`);
  if (cur.productStatic > ceiling) bad(`对产品的静态门 ${cur.productStatic} 个 > 冻结上限 ${ceiling} —— 这是"净增"，不是配额内调整`);

  notes.push(`静态 ${cur.static} 个（其中 meta ${cur.meta}）⇒ 计入配额 ${cur.productStatic}/${ceiling}；余量 ${ceiling - cur.productStatic}`);
  return { ok: problems.length === 0, problems, notes };
}

/** 从仓库根读出 quota（坏 JSON ⇒ null，由 quotaVerdict 报"没有"） */
export function readQuota(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, QUOTA_REL), 'utf8')); } catch { return null; }
}

/** meta 名单（runner 用它决定哪些门的红记 meta_red） */
export function metaNames(quota) { return new Set(Object.keys(quota?.meta || {})); }
