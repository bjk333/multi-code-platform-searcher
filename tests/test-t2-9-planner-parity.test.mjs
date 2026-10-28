// T2-9 / U-100-B: catalog is the sole editable inventory; PS declarations are checked mirrors.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sourceAll } from './lib/source.mjs';
const root = path.resolve(import.meta.dirname, '..');
const main = sourceAll(path.join(root));
const planner = fs.readFileSync(path.join(root, 'query-planner.ps1'), 'utf8');
const schema = JSON.parse(fs.readFileSync(path.join(root, 'query-plan.schema.json'), 'utf8'));
const kinds = ['repo', 'code', 'research'];
export function readCatalog(document) {
  const catalog = document['x-engineCatalog'];
  assert.ok(catalog && typeof catalog === 'object' && !Array.isArray(catalog), 'U-100-B: missing x-engineCatalog');
  const keys = Object.keys(catalog);
  assert.ok(keys.length, 'U-100-B: empty catalog');
  assert.equal(new Set(keys.map(n => n.toLowerCase())).size, keys.length, 'U-100-B: case-colliding catalog names');
  const aliases = new Map();
  for (const [name, e] of Object.entries(catalog)) {
    assert.match(name, /^[A-Za-z][A-Za-z0-9]*$/, 'catalog Name ' + name);
    assert.notEqual(name.toLowerCase(), 'all', 'All is a selector, not an engine');
    assert.deepEqual(Object.keys(e).sort(), ['func', 'kind', 'needs', 'platforms'], 'catalog fields: ' + name);
    assert.ok(kinds.includes(e.kind), 'catalog Kind: ' + name);
    assert.match(e.func, /^Search-[A-Za-z][A-Za-z0-9-]*$/, 'catalog Func: ' + name);
    if (e.kind === 'repo') assert.equal(e.func, 'Search-' + name, 'U-100-B: current single-repo dispatch requires Search-Name: ' + name);
    for (const key of ['platforms', 'needs']) {
      assert.ok(Array.isArray(e[key]), 'catalog array ' + name + '.' + key);
      assert.equal(new Set(e[key]).size, e[key].length, 'catalog duplicate ' + name + '.' + key);
      for (const v of e[key]) assert.match(v, /^[A-Za-z][A-Za-z0-9.-]*$/, 'catalog value ' + name + '.' + key);
    }
    assert.ok(e.platforms.length, 'catalog Platforms empty: ' + name);
    for (const alias of [name, ...e.platforms]) {
      const key = alias.toLowerCase();
      assert.ok(!aliases.has(key) || aliases.get(key) === name, 'catalog alias collision: ' + alias);
      aliases.set(key, name);
    }
  }
  for (const kind of kinds) assert.ok(keys.some(n => catalog[n].kind === kind), 'catalog missing Kind: ' + kind);
  return catalog;
}
const names = (catalog, kind) => Object.keys(catalog).filter(n => !kind || catalog[n].kind === kind);
const orderedNames = catalog => kinds.flatMap(k => names(catalog, k));
const strings = source => [...source.matchAll(/'([^']+)'/g)].map(m => m[1]);
export function registryRows(source) {
  const block = source.match(/^\$script:_engineRegistry\s*=\s*@\(\s*\r?\n([\s\S]*?)^\)/m);
  assert.ok(block, 'U-100-B: registry block not found');
  const rows = block[1].split(/\r?\n/).filter(l => l.trim() && !l.trim().startsWith('#'));
  const result = {};
  for (const row of rows) {
    assert.match(row.trim(), /^@\{.*\},?$/, 'U-100-B: unsupported registry row shape');
    const scalar = key => row.match(new RegExp('\\b' + key + "\\s*=\\s*'([^']+)'"))?.[1];
    const array = key => {
      const m = row.match(new RegExp('\\b' + key + '\\s*=\\s*@\\(([^)]*)\\)'));
      assert.ok(m, 'U-100-B: missing ' + key + ' in registry row');
      return strings(m[1]);
    };
    const name = scalar('Name');
    assert.ok(name && !Object.hasOwn(result, name), 'U-100-B: missing/duplicate registry Name');
    result[name] = { kind: scalar('Kind'), platforms: array('Platforms'), func: scalar('Func'), needs: array('Needs') };
  }
  return result;
}
export function assertCatalogRegistry(source, document) {
  const catalog = readCatalog(document), registry = registryRows(source);
  const missing = names(catalog).filter(n => !Object.hasOwn(registry, n));
  const extra = names(registry).filter(n => !Object.hasOwn(catalog, n));
  assert.deepEqual(names(registry).sort(), names(catalog).sort(),
    'U-100-B: registry != catalog; missing=' + missing.join(',') + '; extra=' + extra.join(','));
  assert.deepEqual(names(registry), orderedNames(catalog), 'U-100-B: registry order drift');
  for (const name of names(catalog)) assert.deepEqual(registry[name], catalog[name], 'U-100-B metadata: ' + name);
  return catalog;
}
function namesFromPlanner(source, kind) {
  const body = source.match(new RegExp('\\$' + kind + 'EngineCandidates\\s*=\\s*@\\(([^)]+)\\)'))?.[1];
  assert.ok(body, 'planner declaration missing: ' + kind);
  return strings(body);
}
export function assertPlanner(source, document) {
  const catalog = readCatalog(document);
  for (const kind of kinds) assert.deepEqual(namesFromPlanner(source, kind), names(catalog, kind), 'planner Kind: ' + kind);
  for (const [mode, selectedKinds] of [['repository_only', ['repo']], ['code_evidence_only', ['code']], ['integrated_research_and_code', ['repo', 'code']]]) {
    const body = source.match(new RegExp("'" + mode + "' \\{([\\s\\S]*?)\\n    \\}"))?.[1];
    assert.ok(body, 'planner mode: ' + mode);
    const actual = strings(body.match(/\$plan\.repositories = @\(([^)]*)\)/)?.[1] || '');
    const expected = selectedKinds.flatMap(k => names(catalog, k).flatMap(n => catalog[n].platforms));
    assert.deepEqual(actual, expected, 'planner output aliases: ' + mode);
  }
}
export function assertCatalogDocs(source, document) {
  const catalog = readCatalog(document);
  const m = source.match(/<!-- engine-catalog:start -->([\s\S]*?)<!-- engine-catalog:end -->/);
  assert.ok(m, 'U-100-B: parameter reference catalog section missing');
  const rows = [...m[1].matchAll(/^\| `([A-Za-z][A-Za-z0-9]*)` \| `(repo|code|research)` \| (.+) \| `(Search-[A-Za-z0-9-]+)` \|$/gm)];
  assert.ok(rows.length, 'U-100-B: empty documentation catalog');
  const ids = rows.map(r => r[1]);
  assert.equal(new Set(ids).size, ids.length, 'duplicate documented engine');
  for (const r of rows) {
    assert.ok(Object.hasOwn(catalog, r[1]), 'U-100-B undocumented catalog id: ' + r[1]);
    assert.equal(r[2], catalog[r[1]].kind, 'doc Kind: ' + r[1]);
    assert.deepEqual([...r[3].matchAll(/`([^`]+)`/g)].map(x => x[1]), catalog[r[1]].platforms, 'doc Platforms: ' + r[1]);
    assert.equal(r[4], catalog[r[1]].func, 'doc Func: ' + r[1]);
  }
  if (!m[1].includes('引擎清单（节选）')) assert.deepEqual(ids, orderedNames(catalog), 'U-100-B: full doc inventory != catalog');
  const row = source.match(/^\| `-Platform` .*$/m)?.[0];
  assert.ok(row, 'Platform parameter row missing');
  const platformList = row.match(/目标平台：([^。]+)。/)?.[1];
  assert.ok(platformList, 'Platform parameter choices missing');
  assert.deepEqual([...platformList.matchAll(/`([^`]+)`/g)].map(x => x[1]), [...names(catalog, 'repo'), 'All']);
}
// Engine-bearing fixture positions only, NOT a guess from arbitrary prose or Name='foo' result fixtures.
export function assertFixtureReferences(sources, document) {
  const catalog = readCatalog(document);
  const allowed = new Set(names(catalog).flatMap(n => [n, ...catalog[n].platforms]).map(n => n.toLowerCase()));
  for (const [file, source] of Object.entries(sources)) {
    const refs = [];
    if (file.endsWith('.ps1')) {
      const code = source.split(/\r?\n/).filter(l => !l.trim().startsWith('#')).join('\n');
      for (const m of code.matchAll(/\bPlatform\s*=\s*['"]([^'"]+)['"]|-(?:Platform|Engine)\s+(?:['"]([^'"]+)['"]|([A-Za-z][\w.]*))|(?:Get|Set)-EngineStatus\s+-Name\s+['"]([^'"]+)['"]|coverage\.Blocked\s+-notcontains\s+['"]([^'"]+)['"]/g)) refs.push(m.slice(1).find(Boolean));
      for (const m of code.matchAll(/\$env:MCPS_DISABLE\s*=\s*['"]([^'"]+)['"]/g)) refs.push(...m[1].split(/[,;\s]+/).filter(Boolean));
    } else {
      const sample = source.match(/^\s*const samplePlatforms = \[([^\]]+)\]/m)?.[1];
      if (sample) refs.push(...strings(sample));
      for (const m of source.matchAll(/e\.name === '([^']+)'|contract\.declared\.includes\('([^']+)'\)/g)) refs.push(m[1] || m[2]);
    }
    for (const ref of refs) assert.ok(ref === 'All' || allowed.has(ref.toLowerCase()), 'U-100-B fixture engine not in catalog: ' + file + ': ' + ref);
  }
}
const fixtureSources = () => Object.fromEntries(['tests/test-r4-docs.test.mjs', 'tests/test-t2-9-planner-parity.test.mjs', 'tests/run-tests.ps1'].map(p => [p, fs.readFileSync(path.join(root, p), 'utf8')]));
const cheat = () => fs.readFileSync(path.join(root, 'references/参数速查.md'), 'utf8');

test('planner names and order equal the canonical catalog engine IDs', () => {
  assertPlanner(planner, schema);
  assert.match(planner, /engineCandidates = @\(\)/);
  assert.match(planner, /\$plan\.engineCandidates = @\(\$repoEngineCandidates\) \+ @\(\$codeEngineCandidates\) \+ @\(\$researchEngineCandidates\)/);
  assert.deepEqual(schema.properties.engineCandidates.type, 'array');
});
test('negative control: removing a research engine fails parity', () => {
  const first = names(readCatalog(schema), 'research')[0];
  const reverted = planner.replace("'" + first + "', ", '');
  assert.notEqual(reverted, planner);
  assert.throws(() => assertPlanner(reverted, schema), /planner Kind/);
});
test('U-100-B: registry names, order and all metadata equal the catalog', () => assertCatalogRegistry(main, schema));
test('U-100-B negative: repo Func aliases incompatible with current serial dispatch are rejected', () => {
  const mutated = structuredClone(schema), first = names(readCatalog(schema), 'repo')[0];
  mutated['x-engineCatalog'][first].func = 'Search-DifferentName';
  assert.throws(() => readCatalog(mutated), /single-repo dispatch requires Search-Name/);
});
test('U-100-B negative: a new catalog key without a registry row is red and names the key', () => {
  const mutated = structuredClone(schema);
  mutated['x-engineCatalog'].R43SyntheticEngine = { kind: 'research', platforms: ['R43SyntheticEngine'], func: 'Search-R43SyntheticEngine', needs: [] };
  assert.throws(() => assertCatalogRegistry(main, mutated), /missing=R43SyntheticEngine/);
});
test('U-100-B negative: losing Needs or output aliases is detected even with equal names', () => {
  for (const key of ['needs', 'platforms']) {
    const mutated = structuredClone(schema), first = names(readCatalog(schema))[0];
    mutated['x-engineCatalog'][first][key] = key === 'needs' ? [] : ['ChangedOutputAlias'];
    assert.throws(() => assertCatalogRegistry(main, mutated), /U-100-B metadata/);
  }
});
test('U-100-B: engine-bearing fixture references are a catalog subset (IDs or output aliases)', () => assertFixtureReferences(fixtureSources(), schema));
test('U-100-B negative: an unknown Platform/disable fixture or manual example is reported', () => {
  for (const source of ["$r = & $mainScript -Platform R43Unknown -Keyword 'x'", "$env:MCPS_DISABLE = 'R43Unknown'"]) {
    assert.throws(() => assertFixtureReferences({ 'fixture.ps1': source }, schema), /R43Unknown/);
  }
  assert.throws(() => assertFixtureReferences({ 'fixture.mjs': "const samplePlatforms = ['R43Unknown'];" }, schema), /R43Unknown/);
});
test('U-100-B: parameter reference engine list equals catalog unless explicitly marked subset', () => assertCatalogDocs(cheat(), schema));
test('U-100-B negative: missing a full-list doc row is red; an explicitly labelled subset is allowed', () => {
  const original = cheat(), first = names(readCatalog(schema))[0];
  const mutated = original.replace(new RegExp('^\\| `' + first + '` \\| `repo`.*\\r?\\n', 'm'), '');
  assert.notEqual(mutated, original);
  assert.throws(() => assertCatalogDocs(mutated, schema), /full doc inventory/);
  assertCatalogDocs(mutated.replace('引擎清单（完整）', '引擎清单（节选）'), schema);
});
test('U-100-B: PS main harness uses the catalog rather than fixed inventory counts', () => {
  for (const file of ['tests/run-tests.ps1']) {
    const source = fixtureSources()[file];
    assert.match(source, /x-engineCatalog/, file + ' must read catalog');
    assert.doesNotMatch(source, /(?:registryNames|candidateNames)\.Count -ne 18|\$code\.Count -ne 4|\$enabled\.Count -ne 2/);
  }
});
