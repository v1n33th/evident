import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SECRETS } from '../../skills/show-your-work/scripts/build-proof.mjs';

const SCRIPT = fileURLToPath(new URL('../../skills/evidence/scripts/setup.mjs', import.meta.url));

test('setup.mjs saves each run as the next setup file, overwrites nothing, and saves nothing for sign-in', () => {
  const run = mkdtempSync(join(tmpdir(), 'setup-'));
  const app = mkdtempSync(join(tmpdir(), 'app-'));
  mkdirSync(join(run, 'evidence'));
  writeFileSync(join(app, 'kept.txt'), 'old');
  const setup = (name, command) => spawnSync('node', [SCRIPT, run, name, app, command], { encoding: 'utf8' });
  const first = setup('C1-a', 'echo out; echo err >&2');
  assert.equal(first.status, 0);
  assert.match(first.stdout, /^File: evidence\/C1-a-setup\.txt\nExit code: 0\nout\nerr\n/);
  assert.match(readFileSync(join(run, 'evidence/C1-a-setup.txt'), 'utf8'), /^Command: echo out; echo err >&2\nFolder: .*\nExit code: 0\n\nout\nerr\n$/);
  // set -C: the command's own redirect cannot overwrite a file.
  const second = setup('C1-a', 'echo new > kept.txt');
  assert.notEqual(second.status, 0);
  assert.equal(readFileSync(join(app, 'kept.txt'), 'utf8'), 'old');
  assert.match(second.stdout, /^File: evidence\/C1-a-setup-2\.txt/);
  const signIn = setup('-', 'echo link');
  assert.equal(signIn.stdout, 'Exit code: 0\nlink\n\n');
  // An explorer's shortcut names its file after the charter.
  assert.match(setup('T2-groundwork', 'echo seeded').stdout, /^File: evidence\/T2-groundwork-setup\.txt\n/);
  assert.deepEqual(readdirSync(join(run, 'evidence')).sort(), ['C1-a-setup-2.txt', 'C1-a-setup.txt', 'T2-groundwork-setup.txt']);
  assert.equal(setup('../x', 'true').status, 1);
});

test('setup.mjs takes a claim with a ledger id', () => {
  const run = mkdtempSync(join(tmpdir(), 'setup-'));
  const app = mkdtempSync(join(tmpdir(), 'app-'));
  mkdirSync(join(run, 'evidence'));
  const res = spawnSync('node', [SCRIPT, run, 'C-7f3a-a', app, 'echo ok'], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /^File: evidence\/C-7f3a-a-setup\.txt\n/);
});

test('setup.mjs saves cookie and authorization values and bearer tokens as <redacted>, and prints them as they came', () => {
  const run = mkdtempSync(join(tmpdir(), 'setup-'));
  const app = mkdtempSync(join(tmpdir(), 'app-'));
  mkdirSync(join(run, 'evidence'));
  const out = [
    'Set-Cookie: sid=s3cr3t; HttpOnly', 'cookie: a=1', 'Authorization: Bearer tok.en-1', '< set-cookie: sid=v3rb0se',
    '{"token_type":"bearer","authorization":"Bearer abc123","cookie":"sid=x"}', 'export TOKEN="Bearer zzz999"', 'Signed in as owner',
  ].join('\n');
  writeFileSync(join(app, 'out.txt'), `${out}\n`);
  const res = spawnSync('node', [SCRIPT, run, 'C1-a', app, "cat out.txt; echo 'curl -H \"Authorization: Bearer cmd-token\"'"], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /sid=s3cr3t/, 'the caller still gets the output');
  const saved = readFileSync(join(run, 'evidence/C1-a-setup.txt'), 'utf8');
  for (const secret of ['s3cr3t', 'a=1', 'tok.en-1', 'v3rb0se', 'abc123', 'sid=x', 'zzz999', 'cmd-token']) assert.ok(!saved.includes(secret), secret);
  assert.match(saved, /^Set-Cookie: <redacted>$/m);
  assert.match(saved, /"authorization":"<redacted>"/);
  assert.match(saved, /^Signed in as owner$/m);
  for (const [kind, re] of SECRETS.slice(0, 3)) assert.doesNotMatch(saved, re, `build-proof would still flag a ${kind}`);
});
