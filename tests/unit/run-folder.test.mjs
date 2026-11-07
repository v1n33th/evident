import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newRequest, newStep, where } from '../../skills/show-your-work/scripts/run-folder.mjs';

const script = fileURLToPath(new URL('../../skills/show-your-work/scripts/run-folder.mjs', import.meta.url));

test('newRequest names the folder by local date, time and kind, and adds -2 in the same minute', () => {
  const p = mkdtempSync(join(tmpdir(), 'project-'));
  const now = new Date(2026, 10, 1, 9, 5);
  assert.equal(newRequest(p, 'team-invites', 'explore', now), join(p, 'team-invites', '2026-11-01-0905-explore'));
  assert.equal(newRequest(p, 'team-invites', 'explore', now), join(p, 'team-invites', '2026-11-01-0905-explore-2'));
  assert.throws(() => newRequest(p, 'ledger', 'explore', now));
  assert.throws(() => newRequest(p, 'Terms', 'explore', now));
  assert.throws(() => newRequest(p, 'terms', 'explore', now));
  assert.throws(() => newRequest(p, 'targets', 'explore', now), /not ledger, terms, targets or drivers/);
  assert.throws(() => newRequest(p, 'drivers', 'explore', now));
});

test('newStep makes only the folders asked for, numbers a second step, and copies nothing from the project', () => {
  const p = mkdtempSync(join(tmpdir(), 'project-'));
  writeFileSync(join(p, 'issue-types.json'), '{"types":[]}');
  const req = newRequest(p, 'invites', 'prove');
  const first = newStep(req, 'proof');
  assert.equal(first, join(req, 'proof'));
  assert.equal(newStep(req, 'proof'), join(req, 'proof-2'));
  assert.deepEqual(readdirSync(first).sort(), ['evidence', 'sessions']);
  assert.deepEqual(readdirSync(newStep(req, 'fix', ['fixes'])), ['fixes']);
});

test('where goes from a step back to its project, feature and request, and refuses other folders', () => {
  const request = '/a/.evident/invites/2026-11-01-0905-explore-and-fix';
  assert.deepEqual(where(`${request}/proof-2`), { project: '/a/.evident', feature: 'invites', request, step: `${request}/proof-2` });
  assert.equal(where('/a/.evident/apps-web/invites'), null);
  assert.equal(where('/tmp/r'), null);
});

test('the CLI prints the folders it made', () => {
  const p = mkdtempSync(join(tmpdir(), 'project-'));
  const out = execFileSync('node', [script, p, 'invites', 'explore', 'explore'], { encoding: 'utf8' });
  assert.match(out, /^Request folder: .*-explore$/m);
  assert.match(out, /^Step folder: .*\/explore$/m);
  const request = out.match(/^Request folder: (.*)$/m)[1];
  assert.deepEqual(readdirSync(join(request, 'explore')).sort(), ['charters', 'evidence']);
  const more = execFileSync('node', [script, '--in', request, 'proof'], { encoding: 'utf8' });
  assert.equal(more, `Step folder: ${join(request, 'proof')}\n`);
  assert.deepEqual(readdirSync(join(request, 'proof')).sort(), ['evidence', 'sessions']);
});

test('a new request takes the run lock, and a lock another unfinished run holds stops it unless --take-lock', () => {
  const p = mkdtempSync(join(tmpdir(), 'project-'));
  const first = execFileSync('node', [script, p, 'invites', 'explore', 'explore'], { encoding: 'utf8' });
  const step = first.match(/^Step folder: (.*)$/m)[1];
  const [named, pid] = readFileSync(join(p, 'run.lock'), 'utf8').split('\n');
  assert.equal(named, step);
  assert.match(pid, /^\d+$/, 'the lock names the agent that runs the step');
  const held = spawnSync('node', [script, p, 'billing', 'prove', 'proof'], { encoding: 'utf8' });
  assert.equal(held.status, 2);
  assert.equal(held.stdout, `Lock: held by ${step}\n`);
  assert.equal(existsSync(join(p, 'billing')), false);
  const taken = execFileSync('node', [script, p, 'billing', 'prove', 'proof', '--take-lock'], { encoding: 'utf8' });
  assert.equal(readFileSync(join(p, 'run.lock'), 'utf8').split('\n')[0], taken.match(/^Step folder: (.*)$/m)[1]);
  // A finished run, or a step made inside a request (--in), leaves the lock to its owner.
  writeFileSync(join(taken.match(/^Step folder: (.*)$/m)[1], 'result.json'), '{}');
  const after = execFileSync('node', [script, p, 'invites', 'explore', 'explore'], { encoding: 'utf8' });
  const lock = readFileSync(join(p, 'run.lock'), 'utf8');
  execFileSync('node', [script, '--in', after.match(/^Request folder: (.*)$/m)[1], 'proof']);
  assert.equal(readFileSync(join(p, 'run.lock'), 'utf8'), lock);
  // A step in a request whose run is over (a re-prove) takes the lock, and stops on one another request holds.
  const done = after.match(/^Request folder: (.*)$/m)[1];
  writeFileSync(join(after.match(/^Step folder: (.*)$/m)[1], 'result.json'), '{}');
  const again = execFileSync('node', [script, '--in', done, 'proof'], { encoding: 'utf8' }).match(/^Step folder: (.*)$/m)[1];
  assert.equal(readFileSync(join(p, 'run.lock'), 'utf8').split('\n')[0], again);
  const other = spawnSync('node', [script, '--in', taken.match(/^Request folder: (.*)$/m)[1], 'proof'], { encoding: 'utf8' });
  assert.equal(other.status, 2);
  assert.equal(other.stdout, `Lock: held by ${again}\n`);
});

test('a lock whose agent is gone is taken, and says so', () => {
  const p = mkdtempSync(join(tmpdir(), 'project-'));
  const first = execFileSync('node', [script, p, 'invites', 'explore', 'explore'], { encoding: 'utf8' });
  const step = first.match(/^Step folder: (.*)$/m)[1];
  const gone = spawnSync('true').pid;
  writeFileSync(join(p, 'run.lock'), `${step}\n${gone}\n`);
  const next = execFileSync('node', [script, p, 'billing', 'prove', 'proof'], { encoding: 'utf8' });
  assert.match(next, new RegExp(`^Lock: taken from ${step}: its run stopped$`, 'm'));
  assert.equal(readFileSync(join(p, 'run.lock'), 'utf8').split('\n')[0], next.match(/^Step folder: (.*)$/m)[1]);
});

test('--release stops the process run.awake names and deletes the file', () => {
  const p = mkdtempSync(join(tmpdir(), 'project-'));
  const sleeper = spawn('sleep', ['60'], { stdio: 'ignore' });
  writeFileSync(join(p, 'run.awake'), String(sleeper.pid));
  const gone = new Promise((done) => sleeper.on('exit', (code, signal) => done(signal)));
  execFileSync('node', [script, '--release', p]);
  assert.equal(existsSync(join(p, 'run.awake')), false);
  return gone.then((signal) => assert.equal(signal, 'SIGTERM'));
});

test('newStep writes targets.json from the project environment.md, and none without one', () => {
  const p = mkdtempSync(join(tmpdir(), 'project-'));
  const req = newRequest(p, 'invites', 'prove');
  assert.ok(!existsSync(join(newStep(req, 'a'), 'targets.json')));
  writeFileSync(join(p, 'environment.md'), '## Targets\n- Web: http://localhost:1\n- CLI: x\n');
  const step = newStep(req, 'b');
  assert.equal(JSON.parse(readFileSync(join(step, 'targets.json'), 'utf8')).targets.web.address, 'http://localhost:1');
});

test('a definition the snapshot cannot read still makes the step, and the Problem line names the file', () => {
  const p = mkdtempSync(join(tmpdir(), 'project-'));
  writeFileSync(join(p, 'environment.md'), '## Targets\n- Web: http://localhost:1\n');
  mkdirSync(join(p, 'targets'));
  writeFileSync(join(p, 'targets', 'web.md'), '---\nname: web\nproven_by: file\n---\n');
  const r = spawnSync('node', [script, p, 'invites', 'prove', 'proof'], { encoding: 'utf8', env: { ...process.env, HOME: mkdtempSync(join(tmpdir(), 'home-')) } });
  const step = r.stdout.match(/^Step folder: (.*)$/m)[1];
  assert.deepEqual(readdirSync(step).sort(), ['evidence', 'sessions']);
  assert.match(r.stderr, new RegExp(`^Problem: ${join(p, 'targets', 'web.md').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: unknown key "proven_by"`, 'm'));
});
