// U-122（2026-09-28）：SKILL.md frontmatter 对 agentskills.io 规范核对门。
// 依据（直读公开文档 https://agentskills.io/specification，r61 调研 W2）：
//   name 必填 1–64 字符、仅小写字母/数字/连字符、不得首尾连字符、须与 skill 目录名一致；description 必填 ≤1024；
//   可选 license / compatibility（≤500）/ metadata（字符串映射）/ allowed-tools；正文建议 <500 行；引用文件一级目录、必须存在。
// 目录名：容器里挂载点是 /w（非真实目录名），因此以 skill-assets.json 的 canonicalPath/name 作为“目录名”的事实源（宿主发布也按它）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skillText = fs.readFileSync(path.join(rootDir, 'SKILL.md'), 'utf8').replace(/^\uFEFF/, '');
// v1.45.3（2026-10-20）：清单解析改为**优先本地、回退 workspace 根**。
//   由来：技能目录内那份 `skill-assets.json` 曾是 v1.41.0 的空哈希残留（与本批 canonical 1.45.3 不同步），
//   本批把它删了 —— 结果本门 ENOENT 整文件失败（删除前只 grep 了 ps1/py，漏了 tests/，教训记在报告里）。
//   本门只需要 `name` / `canonicalPath` 作"目录名事实源"，用 workspace 根清单（唯一事实源）更正确；
//   安装副本（A）自带发布器写的清单，仍优先用本地那份。
function resolveManifest() {
  const local = path.join(rootDir, 'skill-assets.json');
  if (fs.existsSync(local)) return local;
  const wsRoot = path.resolve(rootDir, '..', 'skill-assets.json');
  if (fs.existsSync(wsRoot)) return wsRoot;
  throw new Error('skill-assets.json not found: neither <skill>/skill-assets.json nor <workspace>/skill-assets.json');
}
const manifest = JSON.parse(fs.readFileSync(resolveManifest(), 'utf8').replace(/^\uFEFF/, '')).assets[0];
const ALLOWED = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);

function parseFrontmatter(text) {
  const lines = text.split(/\r?\n/);
  assert.equal(lines[0], '---', 'frontmatter must open on line 1');
  const end = lines.indexOf('---', 1);
  assert.ok(end > 0, 'frontmatter must be closed');
  const fm = {}; let cur = null;
  for (const raw of lines.slice(1, end)) {
    if (!raw.trim()) continue;
    const nested = raw.match(/^\s+([A-Za-z0-9_-]+):\s*(.*)$/);
    const top = raw.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    const unq = v => v.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
    if (top) { cur = top[1]; fm[cur] = top[2] === '' ? {} : unq(top[2]); }
    else if (nested && cur && typeof fm[cur] === 'object') fm[cur][nested[1]] = unq(nested[2]);
    else assert.fail('unparsable frontmatter line: ' + raw);
  }
  return { fm, body: lines.slice(end + 1) };
}
function checkAgentSkills(text, dirName) {
  const { fm, body } = parseFrontmatter(text);
  for (const k of Object.keys(fm)) assert.ok(ALLOWED.has(k), `unknown frontmatter key: ${k}`);
  assert.ok(typeof fm.name === 'string' && fm.name.length >= 1 && fm.name.length <= 64, 'name 1–64 chars');
  assert.match(fm.name, /^[a-z0-9]+(-[a-z0-9]+)*$/, 'name: lowercase letters/digits/hyphens, no leading/trailing/double hyphen');
  assert.equal(fm.name, dirName, 'name must equal the skill directory name');
  assert.ok(typeof fm.description === 'string' && fm.description.trim().length > 0 && fm.description.length <= 1024, 'description 1–1024 chars');
  assert.ok(typeof fm.compatibility === 'string' && fm.compatibility.trim().length > 0 && fm.compatibility.length <= 500, 'compatibility present and ≤500 chars (U-122)');
  if (fm.metadata) for (const [k, v] of Object.entries(fm.metadata)) assert.equal(typeof v, 'string', `metadata.${k} must be a string`);
  assert.ok(body.length < 500, `body must stay under 500 lines (now ${body.length})`);
  // referenced local files must exist and be at most one directory deep
  for (const m of text.matchAll(/\]\(((?:references|scripts|tests|schema|tools|engines)\/[^)#\s]+)\)/g)) {
    assert.ok(fs.existsSync(path.join(rootDir, m[1])), 'referenced file missing: ' + m[1]);
    assert.ok(m[1].split('/').length <= 2, 'reference deeper than one level: ' + m[1]);
  }
  return fm;
}

test('U-122: SKILL.md frontmatter satisfies the agentskills.io specification (name/description/compatibility/metadata/body size/references)', () => {
  const fm = checkAgentSkills(skillText, manifest.canonicalPath || manifest.name);
  assert.equal(fm.name, manifest.name, 'frontmatter name must equal manifest asset name');
  assert.match(fm.compatibility, /PowerShell/, 'compatibility should state the runtime requirement');
});

test('U-122 negative controls: an uppercase name, an over-long compatibility, or a dropped compatibility line is detected by name', () => {
  const up = skillText.replace('name: "multi-code-platform-searcher"', 'name: "Multi-Code-Platform-Searcher"');
  assert.notEqual(up, skillText);
  assert.throws(() => checkAgentSkills(up, manifest.canonicalPath), /lowercase/);
  const noCompat = skillText.replace(/^compatibility:.*\r?\n/m, '');
  assert.notEqual(noCompat, skillText);
  assert.throws(() => checkAgentSkills(noCompat, manifest.canonicalPath), /compatibility present/);
  const long = skillText.replace(/^compatibility:.*$/m, 'compatibility: "' + 'x'.repeat(501) + '"');
  assert.throws(() => checkAgentSkills(long, manifest.canonicalPath), /≤500/);
  const unknownKey = skillText.replace(/^license: MIT$/m, 'license: MIT\nauthor: someone');
  assert.throws(() => checkAgentSkills(unknownKey, manifest.canonicalPath), /unknown frontmatter key: author/);
});
