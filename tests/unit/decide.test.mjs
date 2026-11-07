import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../skills/fix-and-prove/scripts/decide.mjs', import.meta.url));

function setup() {
  const app = mkdtempSync(join(tmpdir(), 'app-'));
  const step = join(app, '.evident/invites/2026-11-01-0900-explore-and-fix/explore');
  const put = (id, fix) => { mkdirSync(join(step, 'bugs', `${id}-x`), { recursive: true }); writeFileSync(join(step, 'bugs', `${id}-x`, 'bug.json'), JSON.stringify({ id, title: `Title ${id}`, fix })); };
  put('BUG-001', { status: 'needs-decision', decision: 'Change it?', risk: 'high' });
  put('BUG-002', { status: 'needs-decision', decision: 'Keep it?', risk: 'medium' });
  put('BUG-003', { status: 'fixed', risk: 'medium', patch: 'fixes/1-BUG-003.patch' });
  put('BUG-004', { status: 'fixed', risk: 'medium', commit: 'abc1234' });
  put('BUG-005', { status: 'wont-fix', decision: 'Keep it?', risk: 'medium' });
  mkdirSync(join(step, '..', 'fix-2', 'fixes'), { recursive: true });
  writeFileSync(join(step, '..', 'fix-2', 'fixes', '1-BUG-003.patch'), '');
  const decide = (bug, ...words) => spawnSync('node', [SCRIPT, '.evident/invites/2026-11-01-0900-explore-and-fix/explore', bug, ...words], { cwd: app, encoding: 'utf8' });
  const fix = (id) => JSON.parse(readFileSync(join(step, 'bugs', `${id}-x`, 'bug.json'), 'utf8')).fix;
  return { app, decide, fix };
}

test('decide.mjs records each decision on its bug and in answers.jsonl, and says what is left to do', () => {
  const { app, decide, fix } = setup();
  assert.match(decide('BUG-001', 'Yes,', 'change', 'it').stdout, /^Fix: \.evident\/invites\/2026-11-01-0900-explore-and-fix\/explore\/bugs\/BUG-001-x\n/);
  assert.deepEqual([fix('BUG-001').status, fix('BUG-001').decided, fix('BUG-001').decision], ['needs-decision', 'Yes, change it', 'Change it?']);
  assert.match(decide('BUG-002', 'No, keep it as it is').stdout, /^Kept: BUG-002 won't be fixed\n/);
  assert.equal(fix('BUG-002').status, 'wont-fix');
  assert.match(decide('BUG-003', 'Ship it').stdout, /^Shipped: BUG-003\n/);
  assert.equal(fix('BUG-003').status, 'fixed');
  assert.match(decide('BUG-004', 'Undo the fix').stdout, /^Undo: BUG-004 commit abc1234\n/);
  assert.match(decide('BUG-003', 'Undo the fix').stdout, /^Undo: BUG-003 patch \/.+\/2026-11-01-0900-explore-and-fix\/fix-2\/fixes\/1-BUG-003\.patch\n/, 'the patch in the fix step that holds it');
  assert.match(decide('BUG-005', 'Fix it anyway').stdout, /^Fix: /);
  assert.equal(fix('BUG-005').status, 'needs-decision', 'pending again, so the fix run takes it');
  assert.equal(fix('BUG-004').status, 'wont-fix');
  // Own words are a request to change it: the fixer reads them.
  assert.match(decide('BUG-002', 'Only for Free orgs').stdout, /^Fix: /);
  const answers = readFileSync(join(app, '.evident/invites/answers.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(answers.map((a) => [a.id, a.answer]).at(0), ['2026-11-01-0900-explore-and-fix/explore/BUG-001', 'Yes, change it']);
  assert.equal(answers[0].question, 'Title BUG-001: Change it?');
  assert.ok(existsSync(join(app, '.evident/invites/2026-11-01-0900-explore-and-fix/report.html')), 'the page shows the decision');
});

test('decide.mjs refuses a bug it cannot find', () => {
  const { decide } = setup();
  const res = decide('BUG-009', 'Ship it');
  assert.equal(res.status, 1);
  assert.match(res.stdout, /^Problem: no BUG-009 in /);
});
