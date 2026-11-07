import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listBugs, markDuplicate, newBug } from '../../skills/evidence/scripts/new-bug.mjs';

test('newBug takes the lowest number no folder or reservation holds, and never one twice', () => {
  const run = mkdtempSync(join(tmpdir(), 'bugs-'));
  mkdirSync(join(run, 'bugs', 'BUG-001-old'), { recursive: true });
  writeFileSync(join(run, 'bugs', '.BUG-002'), '');
  const a = newBug(run, 'limit-off-by-one');
  const b = newBug(run, 'double-click');
  assert.equal(a.id, 'BUG-003');
  assert.equal(b.id, 'BUG-004');
  assert.deepEqual(readdirSync(join(run, 'bugs')).filter((f) => !f.startsWith('.')).sort(), ['BUG-001-old', 'BUG-003-limit-off-by-one', 'BUG-004-double-click']);
});

test('newBug gives a session its own folder back when it asks again for the same slug before writing bug.json', () => {
  const run = mkdtempSync(join(tmpdir(), 'bugs-'));
  const a = newBug(run, 'zwsp-link', 'T9');
  assert.deepEqual(newBug(run, 'zwsp-link', 'T9'), a, 'the same charter, the same slug: the same number');
  assert.equal(newBug(run, 'zwsp-link', 'T4').id, 'BUG-002', 'another charter gets its own');
  writeFileSync(join(a.folder, 'bug.json'), '{}');
  assert.equal(newBug(run, 'zwsp-link', 'T9').id, 'BUG-003', 'once bug.json is written, a second finding gets a new number');
});

test('--list counts filed bugs but no duplicate, and --duplicate marks one', () => {
  const run = mkdtempSync(join(tmpdir(), 'bugs-'));
  const write = (folder, bug) => writeFileSync(join(folder, 'bug.json'), JSON.stringify(bug));
  const a = newBug(run, 'limit');
  const b = newBug(run, 'limit-again');
  newBug(run, 'filing');
  write(a.folder, { id: a.id, title: '11th invite sent', expected: 'The app refuses the 11th.', actual: 'It sent it.' });
  write(b.folder, { id: b.id, title: 'Limit is 11', expected: 'The app refuses the 11th.', actual: 'Sent.' });
  assert.equal(listBugs(run).counted, 3);
  markDuplicate(run, b.id, a.id);
  const { lines, counted } = listBugs(run);
  assert.equal(counted, 2);
  assert.match(lines[0], /^BUG-001 11th invite sent \| expected: The app refuses the 11th\./);
  assert.equal(lines[1], 'BUG-003 (being filed: filing)');
  assert.equal(lines.at(-1), '2 bugs (1 duplicate not counted)');
  assert.throws(() => markDuplicate(run, a.id, b.id), /itself a duplicate/);
});
