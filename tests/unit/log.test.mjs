import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../skills/evidence/scripts/log.mjs', import.meta.url));

test('log.mjs hashes and times lines with a file, and writes nothing when any line is bad', () => {
  const run = mkdtempSync(join(tmpdir(), 'log-'));
  mkdirSync(join(run, 'evidence'));
  writeFileSync(join(run, 'evidence/C1-a.png'), 'png');
  const log = (...lines) => spawnSync('node', [SCRIPT, run, 'evidence.jsonl', ...lines], { encoding: 'utf8' });
  // A typed hash is replaced by the file's own.
  const ok = log('{"claim":"C1","case":"a","file":"evidence/C1-a.png","sha256":"$(shasum x)"}', '{"n":1,"result":"pass"}');
  assert.equal(ok.status, 0, ok.stderr);
  const [first, second] = readFileSync(join(run, 'evidence.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(first.sha256, createHash('sha256').update('png').digest('hex'));
  assert.match(first.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.deepEqual(second, { n: 1, result: 'pass' });
  for (const bad of [['{"note": "a \\"quote}'], ['{"file":"evidence/gone.png"}'], ['{"file":"../outside.png"}'], ['[1]']]) {
    const r = log('{"n":2}', ...bad);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /^Problem: .*Nothing written/);
  }
  assert.equal(readFileSync(join(run, 'evidence.jsonl'), 'utf8').trim().split('\n').length, 2);
  assert.equal(spawnSync('node', [SCRIPT, run, '../escape.jsonl', '{}']).status, 1);
  assert.equal(existsSync(join(run, '../escape.jsonl')), false);
});

test('log.mjs refuses a note whose request and status are on no line of the network log', () => {
  const run = mkdtempSync(join(tmpdir(), 'log-'));
  mkdirSync(join(run, 'evidence'));
  writeFileSync(join(run, 'evidence/C1-a-network.txt'), '[1] GET http://x/api/invites (Fetch) 200\n[2] POST http://x/api/invites (Fetch) 201\n[3] DELETE http://x/api/invites/abc (Fetch) 200\n');
  const log = (note) => spawnSync('node', [SCRIPT, run, 'evidence.jsonl', JSON.stringify({ claim: 'C1', case: 'a', file: 'evidence/C1-a-network.txt', note })], { encoding: 'utf8' });
  for (const note of ['POST /api/invites 201 then GET /api/invites 200', 'DELETE /api/invites/<id> 200', 'DELETE /api/invites/abc... returned 200', 'no errors']) assert.equal(log(note).status, 0, note);
  // 200 is in the file, but not on the POST's line; the path was never called.
  for (const note of ['POST /api/invites 200', 'POST /api/team/invite 201']) assert.match(log(note).stderr, /^Problem: .*copy the request and status from the file/, note);
});

test('log.mjs redacts tokens and account emails in text files and notes before hashing, and leaves binary files', () => {
  const project = mkdtempSync(join(tmpdir(), 'log-'));
  const run = join(project, 'invite-limit/2026-11-02-1759-improve/proof');
  mkdirSync(join(run, 'evidence'), { recursive: true });
  writeFileSync(join(project, 'environment.md'), '## Accounts\n| key | purpose | email | password | role |\n|---|---|---|---|---|\n| owner | owner | owner@acme.test | x | owner |\n\nNew accounts: qa+<unix-time>@acme.test\n');
  writeFileSync(join(run, 'evidence/C1-a-request.txt'), 'POST /api/invites\nAuthorization: Bearer abc.def\n\n{"email":"qa+123@acme.test","by":"owner@acme.test"}\n');
  writeFileSync(join(run, 'evidence/C1-a.png'), Buffer.from([0, 1, 2, 0x42, 0x65, 0x61, 0x72, 0x65, 0x72]));
  writeFileSync(join(run, 'evidence/C1-a-login.json'), '{"accessToken":"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.c2lnbmF0dXJl","refresh_token":"r1","user":{"password":"p","name":"Ann"},"next":"?t=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig"}');
  const line = (file) => JSON.stringify({ claim: 'C1', case: 'a', file, note: 'as owner@acme.test with Bearer abc.def, invited qa+123@acme.test' });
  const r = spawnSync('node', [SCRIPT, run, 'evidence.jsonl', line('evidence/C1-a-request.txt'), line('evidence/C1-a.png'), line('evidence/C1-a-login.json')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const text = readFileSync(join(run, 'evidence/C1-a-request.txt'), 'utf8');
  assert.equal(text, 'POST /api/invites\nAuthorization: <redacted>\n\n{"email":"qa+123@acme.test","by":"<redacted>"}\n');
  assert.equal(readFileSync(join(run, 'evidence/C1-a-login.json'), 'utf8'), '{"accessToken":"<redacted>","refresh_token":"<redacted>","user":{"password":"<redacted>","name":"Ann"},"next":"?t=<redacted>"}');
  const [request, png] = readFileSync(join(run, 'evidence.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(request.sha256, createHash('sha256').update(text).digest('hex'));
  assert.equal(request.note, 'as <redacted> with Bearer <redacted>, invited qa+123@acme.test');
  assert.equal(png.sha256, createHash('sha256').update(readFileSync(join(run, 'evidence/C1-a.png'))).digest('hex'));
  assert.equal(readFileSync(join(run, 'evidence/C1-a.png')).length, 9);
});
