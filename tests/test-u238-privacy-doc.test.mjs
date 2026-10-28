// U-238（v1.53.21 上架材料批）：**隐私声明与商品页不能是自由散文**。
//   ① 域名清单必须覆盖 `engines/*.ps1` + 主脚本里出现的**每一个** `https://` 主机（新增引擎不登记即红）；
//   ② 每个注册引擎都要在隐私表里有落点（不能只写"若干公开源"）；
//   ③ 几条会直接影响用户决策的表述必须存在：无遥测 / 按成功请求计费 / Doctor 探针占位词 / 缓存语义；
//   ④ SKILL.md 必须有一个**已发布入口**指向它（否则文档等于不存在，U-39 同源判据）；
//   ⑤ 商品页数字必须等于**最新**质量基线报告，且不得出现无依据的"准确率 N%"。
// 设计口径：全部从源码/报告**派生**后比对，不写死清单；负例保证"检查器本身能红"。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sourceAll } from './lib/source.mjs';

const root = path.resolve(import.meta.dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/^\uFEFF/, '');

const privacy = read('references/数据与隐私.md');
const skill = read('SKILL.md');
const listing = read('reports/上架材料-商品页-2026-10-25.md');
const mainSrc = sourceAll(root);   // v1.54.0（B3-2）：读加载后视图

const engines = [...mainSrc.matchAll(/@\{ Name = '([^']+)';\s+Kind = '([^']+)';/g)].map(m => m[1]);

function codeHosts() {
  const files = [
    'multi-platform-searcher.ps1',
    ...fs.readdirSync(path.join(root, 'engines')).filter(f => f.endsWith('.ps1')).map(f => 'engines/' + f),
  ];
  const set = new Set();
  for (const rel of files) {
    for (const m of read(rel).matchAll(/https:\/\/([a-zA-Z0-9._-]+)/g)) set.add(m[1]);
  }
  return [...set].sort();
}

function missingHosts(doc, hosts) { return hosts.filter(h => !doc.includes(h)); }
function missingEngines(doc) {
  return engines.filter(n => !new RegExp('\\|\\s*' + n + '\\s*\\|').test(doc));
}

test('U-238 A: 每个注册引擎在隐私表里都有落点（不接受"若干公开源"式概括）', () => {
  assert.ok(engines.length >= 15, `注册表只解析到 ${engines.length} 行，派生值不可信`);
  assert.deepEqual(missingEngines(privacy), [], '隐私文档缺引擎：' + missingEngines(privacy).join(','));
});

test('U-238 B: 代码里出现的每个域名都在隐私文档登记', () => {
  const hosts = codeHosts();
  assert.ok(hosts.length >= 25, `只枚举到 ${hosts.length} 个域名，派生值不可信`);
  assert.deepEqual(missingHosts(privacy, hosts), [], '隐私文档缺域名：' + missingHosts(privacy, hosts).join(','));
});

test('U-238 C: 关键表述必须存在（无遥测 / 计费归属 / Doctor 探针 / 缓存语义 / 令牌只进请求头）', () => {
  const must = [
    [/无遥测|没有遥测/, '无遥测声明'],
    [/按成功请求计费/, 'DeepSeek 计费归属'],
    [/__mcps_probe__/, 'Doctor 探针占位词（说明 -Doctor 会外发）'],
    [/MCPS_CACHE_FILE/, '缓存位置可覆盖'],
    [/-NoCache/, '-NoCache 语义'],
    [/只跳过读取|跳过读/, '-NoCache 仍写入的刷新语义'],
    [/请求头/, '令牌仅请求头'],
    [/不上传/, '不上传本地内容'],
  ];
  const bad = must.filter(([re]) => !re.test(privacy)).map(([, label]) => label);
  assert.deepEqual(bad, [], '隐私文档缺表述：' + bad.join('、'));
});

test('U-238 D: SKILL.md 有已发布入口指向隐私文档', () => {
  assert.match(skill, /references\/数据与隐私\.md/, 'SKILL.md 必须链接 references/数据与隐私.md');
  assert.match(skill, /无遥测/, 'SKILL.md 入口句应直接说明无遥测');
});

test('U-238 E: 隐私文档已登记进发布清单（示例清单同源）', () => {
  const j = JSON.parse(read('scripts/skill-assets.example.json'));
  const a = (Array.isArray(j.assets) && j.assets[0]) || j;
  const keys = Object.keys(a.fileHashes || {});
  assert.ok(keys.includes('references/数据与隐私.md'), '示例清单缺 references/数据与隐私.md —— 发布后它必须随技能下发');
});

test('U-238 F: 负例 —— 检查器对缺失域名/引擎必须报红', () => {
  const hosts = codeHosts();
  assert.deepEqual(missingHosts(privacy, hosts), []);
  assert.equal(missingHosts('只有 api.github.com', hosts).includes('api.deepseek.com'), true);
  assert.deepEqual(missingEngines('| GitHub | x |'), engines.filter(n => n !== 'GitHub'));
  assert.equal(missingEngines(privacy).length, 0);
});

// ---- 商品页：数字必须等于最新基线；不得出现无依据的"准确率 N%" ----
function latestBaseline() {
  const files = fs.readdirSync(path.join(root, 'reports'))
    .filter(f => /^quality-baseline-\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort();
  assert.ok(files.length > 0, '找不到质量基线报告');
  return read('reports/' + files[files.length - 1]);
}
function listingNumberFindings(text, baseline) {
  const pick = (re) => { const m = re.exec(baseline); return m ? m[1] : null; };
  const want = { 'Hit@3': pick(/Hit@3=([\d.]+)%/), 'Hit@5': pick(/Hit@5=([\d.]+)%/), 'MRR@5': pick(/MRR@5=([\d.]+)/) };
  assert.ok(want['Hit@3'] && want['Hit@5'] && want['MRR@5'], '基线报告缺少三项指标');
  const norm = text.replace(/\s+/g, '');
  const out = [];
  if (!norm.includes(`Hit@3=${want['Hit@3']}%`)) out.push(`Hit@3 应写 ${want['Hit@3']}%`);
  if (!norm.includes(`Hit@5=${want['Hit@5']}%`)) out.push(`Hit@5 应写 ${want['Hit@5']}%`);
  if (!norm.includes(`MRR@5=${want['MRR@5']}`)) out.push(`MRR@5 应写 ${want['MRR@5']}`);
  return out;
}
function bareAccuracyClaims(text) {
  return text.split(/\r?\n/).filter(l => /准确率\s*\d/.test(l) && !/(不能|不得|禁止|不代表|不要写|不承诺)/.test(l));
}

test('U-238 G: 商品页三项数字等于最新质量基线，且不含无依据的准确率', () => {
  assert.deepEqual(listingNumberFindings(listing, latestBaseline()), []);
  assert.deepEqual(bareAccuracyClaims(listing), [], '商品页出现无依据的准确率表述：' + bareAccuracyClaims(listing).join(' | '));
  assert.match(listing, /不代表正确率/, '商品页必须带口径声明');
  assert.match(listing, /不承诺/, '商品页必须有"不承诺"段');
});

test('U-238 H: 商品页/隐私文档都不得把"只加 -LocalCodeSearch"说成零外发', () => {
  // 事实（代码 6996-7016 行）：本地 0 命中会降级远程 code 引擎；要零外发必须显式禁用。
  assert.match(privacy, /MCPS_DISABLE=GitHubCode/, '零外发做法必须写出需要禁用的 code 引擎');
  assert.match(privacy, /降级远程/, '必须说明本地 0 命中会降级远程');
  const row = privacy.split(/\r?\n/).find(l => /零外发/.test(l)) || '';
  assert.match(row, /MCPS_DISABLE/, '零外发那行必须带 MCPS_DISABLE，不能只写 -LocalCodeSearch');
});

test('U-238 G negative control: 数字漂移与裸准确率都必须被点名', () => {
  const baseline = latestBaseline();
  assert.deepEqual(listingNumberFindings(listing, baseline), []);
  const drift = listing.replace(/Hit@3\s*=\s*[\d.]+%/, 'Hit@3 = 99%');
  assert.ok(listingNumberFindings(drift, baseline).length > 0, '数字漂移必须被抓到');
  assert.equal(bareAccuracyClaims('结果准确率 92%，值得购买').length, 1);
  assert.equal(bareAccuracyClaims('不承诺固定准确率（不写 92% 这种数）').length, 0);
});
