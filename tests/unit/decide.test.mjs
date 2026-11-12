import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readResult, writeResult } from '../../skills/show-your-work/scripts/report.mjs';

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
  assert.match(decide('BUG-003', 'Prove it again').stdout, /^Prove: BUG-003 of \.evident\/invites\/2026-11-01-0900-explore-and-fix\/explore\n/);
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

test('decide.mjs on a check: fixing it hands its bug to the fixer, filing one from the failed case when there is none', () => {
  const { app } = setup();
  const step = join(app, '.evident/invites/2026-11-01-0900-explore-and-fix/proof');
  mkdirSync(join(step, 'bugs', 'BUG-001-x'), { recursive: true });
  writeFileSync(join(step, 'bugs', 'BUG-001-x', 'bug.json'), JSON.stringify({ id: 'BUG-001', claim: 'C-0001', title: 'Breaks', fix: { status: 'not-fixed' } }));
  writeResult(step, { claims: [
    { id: 'C-0001', statement: 'It works', verdict: 'disproved', cases: [] },
    { id: 'C-0002', statement: 'Seats stop at 50', verdict: 'disproved', cases: [{ id: 'a', result: 'pass' }, { id: 'b', result: 'fail', do: 'Add a 51st seat', expect: 'It is refused', actual: 'It was added' }] },
    { id: 'C-0003', statement: 'Lapsed plans lock', verdict: 'not-proven', cases: [] }] });
  const decide = (id, words) => spawnSync('node', [SCRIPT, '.evident/invites/2026-11-01-0900-explore-and-fix/proof', id, words], { cwd: app, encoding: 'utf8' });
  assert.match(decide('C-0001', 'Fix it').stdout, /^Fix: \.evident\/invites\/2026-11-01-0900-explore-and-fix\/proof\/bugs\/BUG-001-x\n/);
  assert.equal(JSON.parse(readFileSync(join(step, 'bugs', 'BUG-001-x', 'bug.json'), 'utf8')).fix.decided, 'Fix it');
  assert.match(decide('C-0002', 'Fix it').stdout, /^Fix: \.evident\/invites\/2026-11-01-0900-explore-and-fix\/proof\/bugs\/BUG-002-seats-stop-at-50\n/);
  const filed = JSON.parse(readFileSync(join(step, 'bugs', 'BUG-002-seats-stop-at-50', 'bug.json'), 'utf8'));
  assert.ok(readResult(step), 'filing a bug for a decision keeps the proof\'s verdicts current');
  assert.deepEqual([filed.claim, filed.case, filed.steps, filed.expected, filed.actual, filed.fix.decided], ['C-0002', 'b', ['Add a 51st seat'], 'It is refused', 'It was added', 'Fix it']);
  assert.match(decide('C-0003', 'Test again').stdout, /^Prove: C-0003 of \.evident\/invites\/2026-11-01-0900-explore-and-fix\/proof\n/);
  mkdirSync(join(app, '.evident/ledger'), { recursive: true });
  writeFileSync(join(app, '.evident/ledger/invites.jsonl'), `${JSON.stringify({ id: 'C-0003', tags: ['invites'], statement: 'Lapsed plans lock', verdict: 'not-proven' })}\n`);
  assert.match(decide('C-0003', 'Leave it as it is').stdout, /^Kept: C-0003 stays as it is\nRetired: C-0003 in the ledger\n/);
  const ledger = JSON.parse(readFileSync(join(app, '.evident/ledger/invites.jsonl'), 'utf8'));
  assert.equal(ledger.status, 'retired');
  assert.match(ledger.retiredReason, /^You left it as it is on the page of 2026-11-01-0900-explore-and-fix, \d{4}-\d{2}-\d{2}$/);
  assert.match(decide('C-0002', 'Leave it as it is').stdout, /^Kept: C-0002 stays as it is\n$/, 'not in the ledger: nothing to retire');
  writeFileSync(join(app, '.evident/ledger/invites.jsonl'), `${JSON.stringify({ id: 'C-0001', tags: ['invites'], statement: 'It works', verdict: 'disproved' })}\n`);
  assert.match(decide('C-0001', 'Drop this test: the state is mandatory for US').stdout, /^Kept: C-0001 stays as it is\nRetired: C-0001 in the ledger\n/, 'a reason after the choice');
  assert.match(JSON.parse(readFileSync(join(app, '.evident/ledger/invites.jsonl'), 'utf8')).retiredReason, /: the state is mandatory for US$/);
  assert.match(decide('C-0009', 'Fix it').stdout, /^Problem: no C-0009 in /);
  const answers = readFileSync(join(app, '.evident/invites/answers.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const c3 = answers.findLast((a) => a.id.endsWith('/C-0003'));
  assert.deepEqual([c3.id, c3.answer, c3.question], ['2026-11-01-0900-explore-and-fix/proof/C-0003', 'Leave it as it is', 'Lapsed plans lock']);
});

test('decide.mjs: a decision on a bug covers every bug fixed by the same change', () => {
  const { app } = setup();
  const req = join(app, '.evident/invites/2026-11-01-0900-explore-and-fix');
  mkdirSync(join(req, 'proof/bugs/BUG-002-y'), { recursive: true });
  writeFileSync(join(req, 'explore/bugs/BUG-003-x/bug.json'), JSON.stringify({ id: 'BUG-003', title: 'T3', fix: { status: 'fixed', risk: 'high', patch: 'fixes/1-BUG-003.patch' } }));
  writeFileSync(join(req, 'proof/bugs/BUG-002-y/bug.json'), JSON.stringify({ id: 'BUG-002', title: 'T2', fix: { status: 'fixed', summary: 'Fixed with BUG-003', risk: 'high', patch: 'fixes/1-BUG-003.patch' } }));
  const res = spawnSync('node', [SCRIPT, '.evident/invites/2026-11-01-0900-explore-and-fix/explore', 'BUG-003', 'Ship it'], { cwd: app, encoding: 'utf8' });
  assert.match(res.stdout, /^Shipped: BUG-003\nAlso BUG-002 of \.evident\/invites\/2026-11-01-0900-explore-and-fix\/proof: the same change\n/);
  assert.equal(JSON.parse(readFileSync(join(req, 'proof/bugs/BUG-002-y/bug.json'), 'utf8')).fix.decided, 'Ship it');
});

test('decide.mjs: Not a bug keeps it as it is, undoes a fix made for it, and retires its tests with the reason', () => {
  const { app } = setup();
  const req = join(app, '.evident/invites/2026-11-01-0900-explore-and-fix');
  const folder = join(req, 'explore/bugs/BUG-004-x');
  writeFileSync(join(folder, 'bug.json'), JSON.stringify({ id: 'BUG-004', title: 'Country locked', claim: 'C-0001', fix: { status: 'fixed', risk: 'medium', commit: 'abc1234' } }));
  mkdirSync(join(req, 'proof'), { recursive: true });
  writeFileSync(join(req, 'proof/fix-claims.json'), JSON.stringify([{ bug: folder, claim: 'C-0002' }]));
  mkdirSync(join(app, '.evident/ledger'), { recursive: true });
  writeFileSync(join(app, '.evident/ledger/invites.jsonl'), ['C-0001', 'C-0002', 'C-0003'].map((id) => JSON.stringify({ id, tags: ['invites'], statement: id })).join('\n') + '\n');
  const res = spawnSync('node', [SCRIPT, '.evident/invites/2026-11-01-0900-explore-and-fix/explore', 'BUG-004', 'Not a bug: the country follows the org'], { cwd: app, encoding: 'utf8' });
  assert.match(res.stdout, /^Not a bug: BUG-004\nUndo: BUG-004 commit abc1234\nRetired: C-0001, C-0002 in the ledger\n/);
  const fix = JSON.parse(readFileSync(join(folder, 'bug.json'), 'utf8')).fix;
  assert.deepEqual([fix.status, fix.invalid], ['wont-fix', 'the country follows the org']);
  const ledger = readFileSync(join(app, '.evident/ledger/invites.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(ledger.map((c) => c.status ?? 'active'), ['retired', 'retired', 'active']);
  assert.match(ledger[0].retiredReason, /Not a bug: the country follows the org$/);
  const answer = readFileSync(join(app, '.evident/invites/answers.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-1);
  assert.equal(answer.answer, 'Not a bug: the country follows the org', 'later runs learn the rule');
});
