// P1-1 门：`python mcps.py -Verify` 的四态必须可判且**退出码正确**
//   为什么需要这道门：-Verify 是"对外自证"能力（P1-3 让安装副本带清单）。它若**误判 PASS**，
//   用户就会以为"文件是发布者发的那份"——这与 budget-truncated/forbidden/filtered 同型的"假绿"。
//   本仓经验（u159）：**不用 spawnSync**（宿主 node 垫片恒 EBUSY、rc=null）、**不用 fs.cpSync**（非 ASCII 路径崩）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PY as PY_EXE } from './lib/interp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'mcps.py');
const PY = PY_EXE;
const sha256 = s => crypto.createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');

function runVerify(args, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(PY, [CLI, '-Verify', ...args], { cwd: ROOT, windowsHide: true });
    const out = [], err = [];
    let settled = false;
    const settle = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); fn(v); };
    const timer = setTimeout(() => { try { child.kill(); } catch { } settle(resolve, { rc: null, out: '', err: 'timeout' }); }, timeoutMs);
    child.stdout.on('data', b => out.push(b));
    child.stderr.on('data', b => err.push(b));
    child.on('error', e => settle(reject, e));
    child.on('close', rc => settle(resolve, { rc, out: Buffer.concat(out).toString('utf8'), err: Buffer.concat(err).toString('utf8') }));
  });
}

function makeTree({ files = {}, hashes = {} }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcps-vgate-'));
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body, 'utf8');
  }
  const manifest = { assets: [{ name: 'gate-fixture', version: '0.0.1', fileHashes: hashes }] };
  fs.writeFileSync(path.join(dir, 'skill-assets.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return dir;
}

const clean = d => { try { fs.rmSync(d, { recursive: true, force: true }); } catch { } };

test('V1: 全一致 ⇒ PASS + rc=0', async () => {
  const d = makeTree({ files: { 'a.txt': 'hello', 'sub/b.txt': 'world' },
                       hashes: { 'a.txt': sha256('hello'), 'sub/b.txt': sha256('world') } });
  try {
    const r = await runVerify(['-Root', d]);
    assert.equal(r.rc, 0, 'rc 必须 0，实际 ' + r.rc + ' | ' + (r.out + r.err).slice(0, 300));
    assert.match(r.out, /RESULT: PASS/);
    assert.match(r.out, /files\s+= 2/);
  } finally { clean(d); }
});

test('V2: 一个字节不同 ⇒ DRIFT 点名 + rc=1', async () => {
  const d = makeTree({ files: { 'a.txt': 'hello' }, hashes: { 'a.txt': sha256('hellp') } });
  try {
    const r = await runVerify(['-Root', d]);
    assert.equal(r.rc, 1, 'rc 必须 1，实际 ' + r.rc);
    assert.match(r.out, /DRIFT\s+a\.txt/);
    assert.match(r.out, /RESULT: FAIL/);
  } finally { clean(d); }
});

test('V3: 清单有、文件没有 ⇒ MISSING 点名 + rc=1', async () => {
  const d = makeTree({ files: { 'a.txt': 'hello' }, hashes: { 'a.txt': sha256('hello'), 'gone.txt': sha256('x') } });
  try {
    const r = await runVerify(['-Root', d]);
    assert.equal(r.rc, 1, 'rc 必须 1，实际 ' + r.rc);
    assert.match(r.out, /MISSING\s+gone\.txt/);
  } finally { clean(d); }
});

test('V4: ★空 hash 清单 ⇒ UNKNOWN + rc=2（**不得**判 PASS）', async () => {
  const d = makeTree({ files: { 'a.txt': 'hello' }, hashes: { 'a.txt': '', 'b.txt': '' } });
  try {
    const r = await runVerify(['-Root', d]);
    assert.equal(r.rc, 2, 'rc 必须 2（UNKNOWN），实际 ' + r.rc + ' —— 0 个可比对文件判 PASS 就是假绿');
    assert.match(r.out, /RESULT: UNKNOWN/);
    assert.doesNotMatch(r.out, /RESULT: PASS/);
    assert.match(r.out, /拒绝判定 PASS/);
  } finally { clean(d); }
});

test('V5 负例（门自检）：把 UNKNOWN 当 PASS 会被本门抓住', async () => {
  const d = makeTree({ files: { 'a.txt': 'hello' }, hashes: { 'a.txt': '' } });
  try {
    const r = await runVerify(['-Root', d]);
    // 若实现回归成"0 文件也 PASS"，下面这条必炸（这就是负例的意义）
    assert.notEqual(r.rc, 0, '空 hash 不得 rc=0');
    assert.throws(() => { assert.match(r.out, /RESULT: PASS/); }, /RESULT: PASS/);
  } finally { clean(d); }
});
