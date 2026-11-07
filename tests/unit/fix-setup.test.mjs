import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeClaims } from '../../skills/show-your-work/scripts/ledger.mjs';

const SCRIPT = fileURLToPath(new URL('../../skills/fix-and-prove/scripts/fix-setup.mjs', import.meta.url));

const DAY = /\d{4}-\d{2}-\d{2}-\d{4}/.source;

function project() {
  const root = mkdtempSync(join(tmpdir(), 'setup-'));
  const proj = join(root, 'proj');
  const code = join(root, 'app');
  const bug = (step, dir, json) => {
    mkdirSync(join(proj, step, 'bugs', dir), { recursive: true });
    writeFileSync(join(proj, step, 'bugs', dir, 'bug.json'), JSON.stringify(json));
  };
  bug('invites/2026-10-28-0900-explore/explore', 'BUG-001-a', { id: 'BUG-001', severity: 'minor', title: 'Old' });
  bug('invites/2026-10-28-0900-explore/explore', 'BUG-002-b', { id: 'BUG-002', severity: 'major', title: 'Fixed', fix: { status: 'fixed' } });
  bug('invites/2026-10-29-0900-explore-2/explore', 'BUG-001-c', { id: 'BUG-001', severity: 'critical', title: 'New' });
  bug('billing/2026-10-29-0900-explore/explore', 'BUG-001-d', { id: 'BUG-001', severity: 'minor', title: 'Other feature' });
  bug('ledger/2026-10-01-0900-explore/explore', 'BUG-009-z', { id: 'BUG-009', severity: 'minor', title: 'Not a feature' });
  writeFileSync(join(proj, 'issue-types.json'), '[]\n');
  mkdirSync(code);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: code });
  writeFileSync(join(code, 'a.txt'), 'v1\n');
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base', '--allow-empty'], { cwd: code });
  return { proj, code };
}
const run = (...a) => spawnSync('node', [SCRIPT, ...a], { encoding: 'utf8' });
const line = (out, name) => out.match(new RegExp(`^${name}: (.+)$`, 'm'))?.[1];

test('fix-setup: lists the pending bugs of the newest run that has any, -explore-2 included, the older runs as counts, and skips fixed bugs, other features and ledger/', () => {
  const { proj, code } = project();
  const out = run(proj, 'invites', code).stdout;
  assert.match(out, /Pending bugs: 1\n  invites\/2026-10-29-0900-explore-2\/explore BUG-001 critical New\nOlder run: invites\/2026-10-28-0900-explore\/explore 1 pending, fixed only when named\n/);
  assert.doesNotMatch(out, /Fixed|Other feature/);
  assert.match(out, /Branch: main at \w+; main branch: main; uncommitted work: yes/);
  const all = run(proj, 'invites', code, '--all-features').stdout;
  assert.match(all, /Pending bugs: 1\n/);
  assert.equal(all.match(/^Older run: /gm).length, 2);
  assert.doesNotMatch(all, /Not a feature/);
});

test('fix-setup --batch: keeps the most severe up to the batch, and skips duplicates and withdrawn bugs', () => {
  const { proj, code } = project();
  const step = join(proj, 'invites', '2026-10-29-0900-explore-2', 'explore');
  for (const [dir, extra] of [['BUG-002-m', { severity: 'minor' }], ['BUG-003-j', { severity: 'major' }], ['BUG-004-d', { severity: 'critical', duplicateOf: 'BUG-001' }], ['BUG-005-w', { severity: 'critical', withdrawn: 'allowed' }]]) {
    mkdirSync(join(step, 'bugs', dir), { recursive: true });
    writeFileSync(join(step, 'bugs', dir, 'bug.json'), JSON.stringify({ id: dir.slice(0, 7), title: dir, ...extra }));
  }
  const out = run(proj, 'invites', code, '--batch', '2').stdout;
  assert.match(out, /Pending bugs: 2\n  \S+ BUG-001 critical New\n  \S+ BUG-003 major BUG-003-j\nLeft out by Batch: 2: BUG-002\n/);
});

test('fix-setup --improve: names the bugs earlier fix runs left not-fixed, but not needs-decision ones, which wait for the user', () => {
  const { proj, code } = project();
  const step = join(proj, 'invites', '2026-10-29-0900-explore-2', 'explore');
  for (const [dir, status] of [['BUG-003-n', 'not-fixed'], ['BUG-004-d', 'needs-decision']]) {
    mkdirSync(join(step, 'bugs', dir), { recursive: true });
    writeFileSync(join(step, 'bugs', dir, 'bug.json'), JSON.stringify({ id: dir.slice(0, 7), severity: 'major', title: `Was ${status}`, fix: { status } }));
  }
  const out = run(proj, 'invites', code, '--improve').stdout;
  assert.match(out, /Pending bugs: 1\n/);
  assert.equal(out.match(/^Not fixed before: .+$/gm).join('\n'), `Not fixed before: ${join(step, 'bugs', 'BUG-003-n')} Was not-fixed`);
  assert.doesNotMatch(run(proj, 'invites', code, '--take-lock').stdout, /Not fixed before/);
});

test('fix-setup: with no ledger, makes an explore-and-fix request with the fix run, the lock and the spec step', () => {
  const { proj, code } = project();
  execFileSync('git', ['add', 'a.txt'], { cwd: code });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'a'], { cwd: code });
  writeFileSync(join(code, 'a.txt'), 'mine\n');
  const listed = run(proj, 'invites', code, '--list');
  assert.match(listed.stdout, /^Pending bugs: 1$/m);
  assert.equal(line(listed.stdout, 'Fix run'), undefined, '--list creates nothing');
  assert.equal(existsSync(join(proj, 'run.lock')), false);
  const res = run(proj, 'invites', code);
  assert.equal(res.status, 0);
  const request = line(res.stdout, 'Request folder');
  assert.match(request, new RegExp(`/proj/invites/${DAY}-explore-and-fix$`));
  assert.equal(line(res.stdout, 'Fix run'), join(request, 'fix'));
  assert.equal(line(res.stdout, 'Baseline run'), join(request, 'spec'));
  assert.deepEqual(readdirSync(join(request, 'fix')).sort(), ['fixes', 'user.diff']);
  assert.match(readFileSync(join(request, 'fix', 'user.diff'), 'utf8'), /^\+mine$/m, 'the user\'s uncommitted edits, so fixers tell them from earlier fixes');
  assert.deepEqual(readdirSync(join(request, 'spec')), []);
  assert.equal(readFileSync(join(proj, 'run.lock'), 'utf8').split('\n')[0], join(request, 'fix'));
  assert.match(res.stdout, /^Ledger: none$/m);
  assert.match(line(run(proj, 'invites', code, '--improve', '--take-lock').stdout, 'Request folder'), new RegExp(`${DAY}-improve$`));
});

test('fix-setup: fixing a report grows the explore\'s request folder, named by its step or by itself', () => {
  const { proj, code } = project();
  const request = join(proj, 'invites', '2026-10-28-0900-explore');
  const res = run(proj, 'invites', code, join(request, 'explore'), '--report');
  assert.equal(res.status, 0);
  assert.equal(line(res.stdout, 'Request folder'), request);
  assert.equal(line(res.stdout, 'Fix run'), join(request, 'fix'));
  assert.deepEqual(readdirSync(request).sort(), ['explore', 'fix', 'report.html', 'spec', 'summary.json']);
  const again = run(proj, 'invites', code, request, '--report', '--take-lock');
  assert.equal(line(again.stdout, 'Request folder'), request);
  assert.equal(line(again.stdout, 'Fix run'), join(request, 'fix-2'));
});

test('fix-setup: a report with no named run grows the request of the newest run with pending bugs', () => {
  const { proj, code } = project();
  const one = run(proj, 'billing', code, '--report');
  assert.equal(line(one.stdout, 'Request folder'), join(proj, 'billing', '2026-10-29-0900-explore'));
  const two = run(proj, 'invites', code, '--report', '--take-lock');
  assert.equal(line(two.stdout, 'Request folder'), join(proj, 'invites', '2026-10-29-0900-explore-2'));
  assert.doesNotMatch(two.stdout, /^From: /m);
});

test('fix-setup: with claims tagged with the feature, makes no spec step', () => {
  const { proj, code } = project();
  const claim = { id: 'C-0001', tags: ['invites'], statement: 'S.', status: 'active', verdict: 'proven' };
  writeClaims(join(proj, 'ledger'), 'invites', [claim, { ...claim, id: 'C-0002', tags: ['billing'] }]);
  const res = run(proj, 'invites', code);
  const request = line(res.stdout, 'Request folder');
  assert.equal(existsSync(join(request, 'fix', 'ledger-before.json')), false);
  assert.match(res.stdout, /^Ledger: 1 claims tagged invites$/m);
  assert.equal(existsSync(join(request, 'spec')), false);
  assert.equal(line(res.stdout, 'Baseline run'), undefined);
});

test('fix-setup: a ledger with no claim tagged with the feature makes the baseline', () => {
  const { proj, code } = project();
  writeClaims(join(proj, 'ledger'), 'billing', [{ id: 'C-0002', tags: ['billing'], statement: 'S.', status: 'active', verdict: 'proven' }]);
  const res = run(proj, 'invites', code);
  assert.match(res.stdout, /^Ledger: none$/m);
  assert.ok(line(res.stdout, 'Baseline run'));
});
test('fix-setup: a held lock creates nothing; one on a finished run does not hold', () => {
  const { proj, code } = project();
  const other = join(proj, 'invites', '2026-10-29-0900-prove', 'proof');
  mkdirSync(other, { recursive: true });
  writeFileSync(join(proj, 'run.lock'), `${other}\n`);
  const before = readdirSync(join(proj, 'invites')).sort();
  const res = run(proj, 'invites', code);
  assert.equal(res.status, 2);
  assert.match(res.stdout, /Pending bugs: 1/);
  assert.match(res.stdout, new RegExp(`Lock: held by ${other}$`, 'm'));
  assert.deepEqual(readdirSync(join(proj, 'invites')).sort(), before);

  writeFileSync(join(other, 'result.json'), '{}');
  assert.equal(run(proj, 'invites', code).status, 0);
});

test('fix-setup: the app\'s own .evident/ is not uncommitted work', () => {
  const { proj, code } = project();
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'clean', '--allow-empty'], { cwd: code });
  execFileSync('git', ['add', 'a.txt'], { cwd: code });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'a'], { cwd: code });
  mkdirSync(join(code, '.evident', 'ledger', 'invites'), { recursive: true });
  writeFileSync(join(code, '.evident', '.gitignore'), '*\n!.gitignore\n!ledger/\n!ledger/**\n');
  writeFileSync(join(code, '.evident', 'ledger', 'invites', 'claims.json'), '{}');
  assert.match(run(proj, 'invites', code).stdout, /uncommitted work: no/);
});

test('fix-setup: a ledger with problems stops the run and creates nothing', () => {
  const { proj, code } = project();
  writeFileSync(join(proj, 'ledger', 'invites.jsonl'), '<<<<<<< ours\n{"id":"C-0001"}\n=======\n{"id":"C-0002"}\n>>>>>>> theirs\n');
  const before = readdirSync(join(proj, 'invites')).sort();
  const res = run(proj, 'invites', code);
  assert.equal(res.status, 4);
  assert.match(res.stdout, /^Problem: invites\.jsonl: has git conflict markers$/m);
  assert.match(res.stdout, /^Ledger: resolve the problems above in .*ledger, then run again$/m);
  assert.deepEqual(readdirSync(join(proj, 'invites')).sort(), before);
  assert.equal(existsSync(join(proj, 'run.lock')), false);
});

test('fix-setup --improve: carries not-fixed bugs from the newest request that explored only', () => {
  const { proj, code } = project();
  for (const [req, dir] of [['2026-10-28-0900-explore', 'BUG-003-old'], ['2026-10-29-0900-improve', 'BUG-001-new']]) {
    const bug = join(proj, 'invites', req, 'explore', 'bugs', dir);
    mkdirSync(bug, { recursive: true });
    writeFileSync(join(bug, 'bug.json'), JSON.stringify({ id: dir.slice(0, 7), severity: 'minor', title: dir, fix: { status: 'not-fixed' } }));
  }
  const out = run(proj, 'invites', code, '--improve').stdout;
  assert.deepEqual(out.match(/^Not fixed before: .+$/gm).map((l) => l.split(' ').pop()), ['BUG-001-new']);
});

test('fix-setup: leaves out a bug whose own picture the evidence check contradicts, and says why', () => {
  const { proj, code } = project();
  const step = join(proj, 'invites/2026-10-29-0900-explore-2/explore');
  writeFileSync(join(step, 'evidence.jsonl'), `${JSON.stringify({ bug: 'BUG-001', file: 'bugs/BUG-001-c/found.png', sha256: 'aa' })}\n`);
  writeFileSync(join(step, 'evidence-check.jsonl'), `${JSON.stringify({ file: 'bugs/BUG-001-c/found.png', sha256: 'aa', verdict: 'mismatch', why: 'the list shows 3 rows' })}\n`);
  const out = run(proj, 'invites', code).stdout;
  assert.match(out, /Pending bugs: 1\n  invites\/2026-10-28-0900-explore\/explore BUG-001 minor Old\nNot confirmed, left out: invites\/2026-10-29-0900-explore-2\/explore BUG-001 New: the list shows 3 rows\n/);
});

test('fix-setup: a named run\'s bug the page decided to fix is pending again; a kept one is not', () => {
  const { proj, code } = project();
  const step = join(proj, 'invites', '2026-10-28-0900-explore', 'explore');
  const set = (dir, fix) => writeFileSync(join(step, 'bugs', dir, 'bug.json'), JSON.stringify({ id: dir.slice(0, 7), severity: 'minor', title: dir, fix }));
  set('BUG-001-a', { status: 'needs-decision', decided: 'Yes, change it' });
  set('BUG-002-b', { status: 'wont-fix', decided: 'No, keep it as it is' });
  const res = run(proj, 'invites', code, step, '--report');
  assert.equal(res.status, 0);
  assert.equal(line(res.stdout, 'Pending bugs'), '1');
  assert.match(res.stdout, /BUG-001 minor BUG-001-a/);
});
