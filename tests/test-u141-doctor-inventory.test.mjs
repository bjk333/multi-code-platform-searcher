// R90 D / U-141: Doctor must use neutral candidate names for all five tools and probe before declaring Present.
// The only-.exe negative fixture lives in OS temp, never in bline or reports/gates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sourceAll } from './lib/source.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = sourceAll(path.join(root));
const bases = ['rg', 'ugrep', 'ast-grep', 'aria2c', 'fzf'];

function catalog(s) {
  const block = s.match(/\$script:doctorTools = @\(([\s\S]*?)\n\)/)?.[1];
  assert.ok(block, 'doctorTools catalog missing');
  const rows = block.split('\n').filter(x => /^\s*@\{/.test(x));
  return rows.map(row => ({
    name: row.match(/\bNames = @\(([^)]*)\)/)?.[1].match(/'[^']+'/g)?.map(x => x.slice(1, -1)) ?? [],
    row,
  }));
}

test('U-141: all five Doctor tool candidates are platform-neutral and probe before Present/Status', () => {
  const rows = catalog(source);
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.map(x => x.name[0]), bases);
  for (const x of rows) {
    assert.ok(x.name.length >= 1, x.row);
    assert.ok(x.name.every(n => !n.endsWith('.exe')), x.row);
  }
  assert.deepEqual(rows[2].name, ['ast-grep', 'sg']);
  assert.match(source, /function Get-DoctorToolInventory\s*\{/);
  assert.match(source, /\$isWin[\s\S]*\$t\.Names/);
  assert.match(source, /Test-LocalBinaryAlive -Path \$candidate/);
  assert.match(source, /Status = \$\(if \(\$chosen\) \{ 'ok' \} else \{ 'tool_missing' \}\)/);
  assert.match(source, /\$tools = @\(Get-DoctorToolInventory\)/);
});

test('U-141 negative guard: an all-.exe candidate table is rejected before runtime', () => {
  const bad = source.replace("Names = @('rg')", "Names = @('rg.exe')");
  assert.notEqual(bad, source);
  const row = catalog(bad)[0];
  assert.ok(row.name.some(n => n.endsWith('.exe')));
});

// This dynamic test is POSIX-only: its version-capable stub is a shell script.
// Windows has the static catalog gate above and the R90 host PS regression.
test('U-141 isolated negative only rg.exe => tool_missing; live rg --version => ok', { skip: process.platform === 'win32' }, () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcps-u141-'));
  try {
    assert.deepEqual(fs.readdirSync(temp), []); // zero baseline for injected candidates
    const exe = path.join(temp, 'rg.exe');
    fs.writeFileSync(exe, '#!/bin/sh\necho exe-only\n', { mode: 0o755 });
    const pwsh = (process.env.PATH || '').split(path.delimiter).map(x => path.join(x, 'pwsh')).find(p => fs.existsSync(p));
    assert.ok(pwsh, 'PowerShell executable must be available for this gate');
    const psPath = path.join(root, 'multi-platform-searcher.ps1').replaceAll("'", "''");
    const td = temp.replaceAll("'", "''");
    const run = (tag) => {
      const script = `$ErrorActionPreference='Stop'; $env:MCPS_NO_MAIN='1'; . '${psPath}' -NoEnvFile -AsJson; $rows=@(Get-DoctorToolInventory -PlatformWindows $false -CandidateDirs @('${td}')); $rg=@($rows | Where-Object Tool -eq 'ripgrep')[0]; if ($rows.Count -ne 5) { throw 'catalog not five' }; '${tag}='+$rg.Status+':'+$rg.Exe+':'+[int]$rg.Present`;
      const r = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
        cwd: root, env: { ...process.env, PATH: temp, MCPS_NO_MAIN: '1' }, encoding: 'utf8', timeout: 15000,
      });
      assert.equal(r.status, 0, `PowerShell failure: ${r.error?.message || r.stderr?.slice(0, 350)}`);
      return r.stdout.trim();
    };
    const negative = run('U141_NEG_ONLY_EXE');
    assert.match(negative, /U141_NEG_ONLY_EXE=tool_missing:rg:0/);
    const bare = path.join(temp, 'rg');
    fs.writeFileSync(bare, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "rg-stub 1.0"; exit 0; fi\nexit 1\n', { mode: 0o755 });
    fs.chmodSync(bare, 0o755);
    const positive = run('U141_POS_BASE');
    assert.match(positive, /U141_POS_BASE=ok:rg:1/);
    console.log(negative);
    console.log(positive);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
