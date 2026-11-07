import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../skills/evidence/scripts/pick.mjs', import.meta.url));
const pick = (...args) => execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8' }).trimEnd();

test('pick.mjs filters a mail list by exact and substring values, nested keys and arrays, and prints fields or a count', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pick-'));
  const list = join(dir, 'mail.json'), mailpit = join(dir, 'mailpit.json'), one = join(dir, 'one.json');
  writeFileSync(list, JSON.stringify([
    { to: 'qa+1793287335@acme.test', subject: 'You are invited', links: ['http://localhost:4173/join?t=a'] },
    { to: 'qa+1793287336@acme.test', subject: 'You are invited', links: ['http://localhost:4173/join?t=b'] },
    { to: 'owner@acme.test', subject: 'Limit reached', links: [] },
  ]));
  writeFileSync(mailpit, JSON.stringify({ total: 2, messages: [
    { ID: 'm1', To: [{ Address: 'qa+1@acme.test' }, { Address: 'cc@acme.test' }], Subject: 'Hi' },
    { ID: 'm2', To: [{ Address: 'qa+2@acme.test' }], Subject: 'Hi again' },
  ] }));
  writeFileSync(one, JSON.stringify({ Text: 'Join:\nhttp://localhost:4173/join?t=c', Size: 40 }));

  assert.equal(pick(list, 'to=qa+1793287336@acme.test', '--fields', 'links'), 'http://localhost:4173/join?t=b');
  assert.equal(pick(list, 'subject~invited', '--count'), '2');
  assert.equal(pick(list, 'to~@acme.test', 'subject=Limit reached', '--fields', 'to,subject'), 'owner@acme.test\tLimit reached');
  assert.equal(pick(list, 'to=nobody@acme.test', '--count'), '0');
  assert.equal(pick(list, 'to=nobody@acme.test'), '');
  assert.equal(pick(mailpit, '--in', 'messages', 'To.Address=cc@acme.test', '--fields', 'ID'), 'm1');
  assert.equal(pick(mailpit, '--in', 'messages', '--count'), '2');
  assert.equal(pick(mailpit, '--fields', 'total'), '2');
  assert.equal(pick(one, '--fields', 'Text'), 'Join:\nhttp://localhost:4173/join?t=c');
  assert.deepEqual(JSON.parse(pick(list, 'to=owner@acme.test')), { to: 'owner@acme.test', subject: 'Limit reached', links: [] });
  assert.equal(execFileSync('node', [SCRIPT, '-', '--count'], { input: '[1,2,3]', encoding: 'utf8' }).trim(), '3');

  const bad = spawnSync('node', [SCRIPT, list, 'subject'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /^Problem: "subject" is not/);
});
