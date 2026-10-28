// U-173：DockerHub 研究源质量门槛（v4 P1-a）—— 契约锁 + 规则表
//   背景：Docker Hub 的 /v2/search/repositories 是**模糊匹配**；长查询会返回与主题无关的镜像。
//   实测（2026-10-19，query=Model Context Protocol MCP registry server provenance verification）：
//     返回 5 条 → 门槛后保留 3 条（全部相关：grafana/mcp-grafana、mcp/context7、acuvity/mcp-server-context-7），丢弃 2 条。
//   ★注意：这条门**不联网**（离线契约锁）。行为证据见 reports/gates/p1a-dockerhub-filter-2026-10-19/。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'engines', 'docker-hub.ps1'), 'utf8');

// 与引擎同构的**独立实现**（用于钉规则，而不是读取引擎的中间结果）
const STOP = new Set(('the and for with from into that this what how why when where which are was were has have had ' +
  'not but all any can may use used using via per than then also its their there these those about over under ' +
  'between within without against during before after above below more most less least best better good new old ' +
  'first last next one two three four five six seven eight nine ten').split(' '));
const termsOf = q => [...new Set((String(q).toLowerCase().match(/[a-z0-9][a-z0-9._-]{2,}/g) || []).filter(t => !STOP.has(t)))];
const minTermsOf = q => Math.max(1, Math.ceil(termsOf(q).length / 3));
const hitsOf = (q, name, desc) => {
  const hay = (String(name) + ' ' + String(desc)).toLowerCase();
  return termsOf(q).filter(t => hay.includes(t)).length;
};
const keep = (q, name, desc, override) => {
  const terms = termsOf(q);
  if (!terms.length) return true;                    // 无 ASCII 词 ⇒ 不过滤（不误杀中文查询）
  const need = override ?? minTermsOf(q);
  return hitsOf(q, name, desc) >= need;
};

test('U-173-1: 引擎里存在门槛（词切分 / 停用词 / minTerms / 两个旋钮）', () => {
  assert.match(SRC, /\$terms\s*=\s*@\(\[regex\]::Matches/, '必须有查询词切分');
  assert.match(SRC, /\$stop\s*=\s*@\('the','and'/, '必须有停用词表');
  assert.match(SRC, /\$minTerms\s*=\s*\[int\]\[Math\]::Max\(1, \[Math\]::Ceiling\(\$terms\.Count \/ 3\.0\)\)/, '默认门槛必须是 max(1, ceil(n/3))');
  assert.match(SRC, /\$env:MCPS_DOCKERHUB_MIN_TERMS/, '必须支持覆盖门槛');
  assert.match(SRC, /\$env:MCPS_DOCKERHUB_FILTER/, '必须支持关闭');
  assert.match(SRC, /if \(\$hit -lt \$minTerms\) \{ \$dropped\+\+; continue \}/, '必须有丢弃分支');
});

test('U-173-2: 全丢时必须写「已丢弃」reason（否则会被映射成 zero-hit，与 filtered 同族坑）', () => {
  assert.match(SRC, /全部与查询词无交集，已丢弃/, '全部丢弃时的 reason 必须含「已丢弃」');
  assert.match(SRC, /Add-EngineWarning -Engine 'DockerHub'[^\n]*filtered/, '必须发 filtered 警告');
});

test('U-173-3: 规则表（真实样本）', () => {
  const q = 'Model Context Protocol MCP registry server provenance verification';
  assert.equal(termsOf(q).length, 8, '该查询应切出 8 个词');
  assert.equal(minTermsOf(q), 3, '门槛应为 3');
  // 真实保留下来的三条（2026-10-19 实测）
  assert.equal(keep(q, 'grafana/mcp-grafana', 'Grafana MCP (Model Context Protocol) server'), true);
  assert.equal(keep(q, 'mcp/context7', 'Context7 MCP Server -- Up-to-date code documentation'), true);
  assert.equal(keep(q, 'acuvity/mcp-server-context-7', 'Context7 MCP - Up-to-date Docs'), true);
  // 典型噪声（模糊匹配到单个词）
  assert.equal(keep(q, 'registry', ''), false, '裸 "registry" 只有 1 命中 ⇒ 必须丢');
  assert.equal(keep(q, 'library/nginx', 'Official build of Nginx'), false);
});

test('U-173-4: 单关键词查询不得被误杀（grafana）', () => {
  assert.equal(minTermsOf('grafana'), 1);
  assert.equal(keep('grafana', 'grafana/grafana', 'The open observability platform'), true);
  assert.equal(keep('grafana', 'library/nginx', 'Official build of Nginx'), false);
});

test('U-173-5: 纯中文查询 ⇒ 不过滤（不能因无法判定而误杀）', () => {
  assert.equal(termsOf('容器镜像 监控').length, 0, '中文查询应切不出 ASCII 词');
  assert.equal(keep('容器镜像 监控', 'library/nginx', 'x'), true, '无词可判时必须放行');
});

test('U-173-6 负例（门自检）：删掉丢弃分支必须被本门抓住', () => {
  const broken = SRC.replace(/\s*if \(\$hit -lt \$minTerms\) \{ \$dropped\+\+; continue \}/, '');
  assert.notEqual(broken, SRC, '负例必须真的改到源码');
  assert.doesNotMatch(broken, /if \(\$hit -lt \$minTerms\) \{ \$dropped\+\+; continue \}/);
});
