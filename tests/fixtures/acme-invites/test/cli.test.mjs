import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { startServer } from '../app/server.mjs';

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'cli.mjs');
let dir, server, token;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'acme-cli-'));
  server = await startServer({ dir, port: 0, adminPort: 0 });
  const r = await fetch(`http://localhost:${server.adminPort}/admin/login`, { method: 'POST', body: JSON.stringify({ account: 'free-owner' }) });
  token = (await r.json()).token;
});
after(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

// async spawn: the server lives in this process, so the event loop must stay free
const run = (...args) =>
  new Promise((resolve) =>
    execFile('node', [cli, ...args], { env: { ...process.env, ACME_URL: `http://localhost:${server.port}` } }, (err, stdout, stderr) =>
      resolve({ code: err ? err.code : 0, stdout, stderr })));

test('invite then list', async () => {
  const r = await run('invite', 'a@example.com', '--token', token);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^Invite sent to a@example\.com \(id \S+\)\n$/);
  const l = await run('invites', 'list', '--token', token);
  assert.match(l.stdout, /a@example\.com {2}sent/);
  const j = await run('invites', 'list', '--json', '--token', token);
  assert.equal(JSON.parse(j.stdout).length, 1);
});

test('a bad token fails on stderr with exit 1', async () => {
  const r = await run('invites', 'list', '--token', 'nope');
  assert.equal(r.code, 1);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr.trim(), 'Sign in first.');
});

test('missing token fails', async () => {
  const r = await run('invites', 'list');
  assert.equal(r.code, 1);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr.trim(), 'Pass --token <token>.');
});

test('revoke', async () => {
  const sent = await run('invite', 'b@example.com', '--token', token);
  const id = /id (\S+)\)/.exec(sent.stdout)[1];
  const r = await run('invites', 'revoke', id, '--token', token);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, `Revoked ${id}\n`);
  const l = await run('invites', 'list', '--token', token);
  assert.match(l.stdout, new RegExp(`${id} {2}b@example\\.com {2}revoked`));
});

test('an empty list prints nothing', async () => {
  const r = await fetch(`http://localhost:${server.adminPort}/admin/login`, { method: 'POST', body: JSON.stringify({ account: 'pro-owner' }) });
  const t = (await r.json()).token;
  const l = await run('invites', 'list', '--token', t);
  assert.equal(l.code, 0);
  assert.equal(l.stdout, '');
  assert.equal((await run('invites', 'list', '--json', '--token', t)).stdout.trim(), '[]');
});
