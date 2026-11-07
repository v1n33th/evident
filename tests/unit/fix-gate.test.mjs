import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeClaims } from '../../skills/show-your-work/scripts/ledger.mjs';

const SCRIPT = fileURLToPath(new URL('../../skills/fix-and-prove/scripts/fix-gate.mjs', import.meta.url));

function setup() {
  const app = mkdtempSync(join(tmpdir(), 'app-'));
  const feature = join(app, '.evident/invites');
  const request = join(feature, '2026-11-01-0900-explore-and-fix');
  const step = join(request, 'explore');
  mkdirSync(join(app, 'docs'), { recursive: true });
  writeFileSync(join(app, 'docs/invites.md'), 'Only owners can revoke an invite.\n');
  mkdirSync(step, { recursive: true });
  writeFileSync(join(request, 'brief.md'), '## Request\nexplore invites\n\n## Documents\n- docs/invites.md\n');
  writeFileSync(join(feature, 'answers.jsonl'), `${JSON.stringify({ id: 'Q-1', answer: 'Resends count toward the limit' })}\n`);
  const put = (id, b) => { const dir = join(step, 'bugs', `${id}-x`); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'bug.json'), JSON.stringify({ id, kind: 'bug', title: `Title ${id}`, expected: 'It is refused', actual: 'It goes through', ...b })); return dir; };
  const gate = (...args) => spawnSync('node', [SCRIPT, ...args], { cwd: app, encoding: 'utf8' });
  return { app, put, gate };
}

test('fix-gate --plan allows a fix the rules allow, before any edit, and says why not otherwise', () => {
  const { app, put, gate } = setup();
  const bug = put('BUG-001', {});
  const plan = (risk, prod, source, gaps = 'no', auto = 'off') => gate('--gaps', gaps, '--auto', auto, '--code', app, '--plan', risk, prod, source, bug);
  assert.equal(plan('low', 'no', '').stdout, 'allowed\n', 'a bug this branch added needs no source');
  assert.equal(plan('medium', 'yes', 'broken: the page crashes').status, 0);
  // A source is a sentence from the brief, a document it names or an answer, word for word, quoted or not.
  assert.equal(plan('medium', 'yes', '"Only owners can revoke an invite."').status, 0);
  assert.equal(plan('medium', 'yes', 'Resends count toward the limit').status, 0);
  const made = plan('medium', 'yes', 'Owners alone may revoke invites.');
  assert.equal(made.status, 1);
  assert.equal(made.stdout, 'needs-decision: Production does It goes through. Change it to It is refused?\n');
  // gap: and auto: count only in their modes.
  assert.equal(plan('medium', 'yes', 'gap: an empty-list message').status, 1);
  assert.equal(plan('medium', 'yes', 'gap: an empty-list message', 'yes').status, 0);
  assert.equal(plan('medium', 'yes', 'auto: refuse it').status, 1);
  assert.equal(plan('medium', 'yes', 'auto: refuse it', 'no', 'very-high').status, 0);
  // Risk: high and very-high need your decision, or auto mode up to that level.
  assert.match(plan('high', 'no', '').stdout, /^needs-decision: Production does It goes through\. Change it to It is refused\? \(a high-risk change\)\n$/);
  assert.equal(plan('high', 'no', '', 'no', 'high').status, 0);
  assert.equal(plan('very-high', 'no', '', 'no', 'high').status, 1);
  assert.equal(plan('very-high', 'no', '', 'no', 'very-high').status, 0);
  assert.equal(plan('very-high', 'no', '').status, 1, 'no decision, no auto mode: very-high is refused');
  const decided = put('BUG-002', { fix: { decided: 'Yes, change it' } });
  assert.equal(gate('--gaps', 'no', '--auto', 'off', '--code', app, '--plan', 'high', 'yes', 'decided: Yes, change it', decided).status, 0);
  assert.equal(gate('--gaps', 'no', '--auto', 'off', '--code', app, '--plan', 'very-high', 'yes', 'decided: Yes, change it', decided).status, 0, 'your answer to a question that named the risk allows any risk');
  // A request appended to the brief adds its own ## Documents.
  writeFileSync(join(app, 'docs/limits.md'), 'Resent invites never count twice.\n');
  writeFileSync(join(app, '.evident/invites/2026-11-01-0900-explore-and-fix/brief.md'), '## Request\nexplore invites\n\n## Documents\n- docs/invites.md\n\n## Request\nfix them\n\n## Documents\n- docs/limits.md\n');
  assert.equal(plan('medium', 'yes', 'Resent invites never count twice.').status, 0, 'the second request\'s document is a source');
  // A gap is built only in gap mode.
  const gap = put('BUG-003', { kind: 'gap' });
  assert.equal(gate('--gaps', 'no', '--auto', 'off', '--code', app, '--plan', 'low', 'no', '', gap).status, 1);
});

test('fix-gate checks fix records after the fact by the same rules, naming what to undo', () => {
  const { app, put, gate } = setup();
  const ok = put('BUG-001', { fix: { status: 'fixed', risk: 'medium', inProduction: true, source: 'Only owners can revoke an invite.', summary: 'Refuse members', patch: 'fixes/1-BUG-001.patch' } });
  const bad = put('BUG-002', { fix: { status: 'fixed', risk: 'medium', inProduction: true, source: 'gap: an undo', summary: 'Adds undo', commit: 'abc1234' } });
  const asks = put('BUG-003', { fix: { status: 'needs-decision', risk: 'high', decision: 'Change it?' } });
  const res = gate('--gaps', 'no', '--auto', 'off', '--code', app, ok, bad, asks);
  assert.equal(res.status, 0);
  assert.equal(res.stdout, 'BUG-001 ok\nBUG-002 undo | Production does It goes through. Change it as commit abc1234 does: Adds undo?\n');
  const risky = put('BUG-004', { fix: { status: 'partly-fixed', risk: 'very-high', inProduction: false, summary: 'Rotate tokens', patch: 'fixes/1-BUG-004.patch' } });
  assert.equal(gate('--gaps', 'yes', '--auto', 'high', '--code', app, risky).stdout, 'BUG-004 undo | Fixed at very-high risk, then undone: Rotate tokens. Apply fixes/1-BUG-004.patch?\n');
  assert.equal(gate('--gaps', 'yes', '--auto', 'very-high', '--code', app, risky).stdout, 'BUG-004 ok\n');
});

// A patch as fix-patch.mjs writes it: git diff between two trees.
const patch = (file, minus, plus) => `diff --git a/${file} b/${file}\nindex 1111111..2222222 100644\n--- a/${file}\n+++ b/${file}\n@@ -1,2 +1,2 @@\n ctx\n${minus.map((l) => `-${l}\n`).join('')}${plus.map((l) => `+${l}\n`).join('')}`;
const proven = (id, extra) => ({ id, tags: ['invites'], target: 'web', statement: `The app keeps ${id}.`, verdict: 'proven', files: ['src/page.js'], ...extra });

function withLedger() {
  const s = setup();
  const ledger = mkdtempSync(join(tmpdir(), 'ledger-'));
  writeClaims(ledger, 'invites', [
    proven('C-0001', { cases: [{ id: 'a', do: 'Send the 21st invite', expect: 'A toast reads "Daily invite limit reached. Try again tomorrow."' }] }),
    proven('C-0002', { files: ['src/api.js'], cases: [{ id: 'a', do: 'Resend', expect: 'A toast reads "Invite sent to member1@acme.test"' }] }),
    proven('C-0003', { verdict: 'disproved', cases: [{ id: 'a', do: 'x', expect: '"Daily invite limit reached. Try again tomorrow."' }] }),
    proven('C-0004', { tags: ['billing'], cases: [{ id: 'a', do: 'x', expect: '"Invite sent to a@b.test"' }] }),
  ]);
  const fixRun = join(s.app, 'fix');
  mkdirSync(join(fixRun, 'fixes'), { recursive: true });
  return { ...s, ledger, fixRun };
}

test('fix-gate --plan names the proven claims of the feature on the files the fix will change', () => {
  const { app, put, gate, ledger } = withLedger();
  const bug = put('BUG-001', {});
  const res = gate('--gaps', 'no', '--auto', 'off', '--code', app, '--ledger', ledger, '--feature', 'invites', '--files', 'src/page.js', '--plan', 'low', 'no', '', bug);
  assert.equal(res.status, 0);
  assert.equal(res.stdout, 'allowed\nkeep C-0001: The app keeps C-0001. | quotes "Daily invite limit reached. Try again tomorrow."\n', 'not the disproved claim, not another feature\'s');
  assert.equal(gate('--gaps', 'no', '--auto', 'off', '--code', app, '--ledger', 'none', '--feature', 'invites', '--files', 'src/page.js', '--plan', 'low', 'no', '', bug).stdout, 'allowed\n');
});

test('fix-gate undoes a fix whose patch removes text a proven claim quotes, unless the record names the claim', () => {
  const { app, put, gate, ledger, fixRun } = withLedger();
  writeFileSync(join(fixRun, 'fixes/1-BUG-001.patch'), patch('src/api.js', ['  toast(`Invite sent to ${email}`);'], ['  toast(`Invite resent to ${email}.`);']));
  writeFileSync(join(fixRun, 'fixes/1-BUG-002.patch'), patch('src/page.js', ["  if (res.status === 429) toast('Daily invite limit reached. Try again tomorrow.');"], ["  if (res.status === 429 && !atLimit) toast('Daily invite limit reached. Try again tomorrow.');"]));
  const rec = (n, extra = {}) => ({ fix: { status: 'fixed', risk: 'low', inProduction: false, summary: `Fix ${n}`, patch: `fixes/1-BUG-00${n}.patch`, ...extra } });
  const resend = put('BUG-001', rec(1));
  const kept = put('BUG-002', rec(2));
  const args = ['--gaps', 'no', '--auto', 'off', '--code', app, '--ledger', ledger, '--feature', 'invites', '--fix-run', fixRun];
  assert.equal(gate(...args, resend, kept).stdout, 'BUG-001 undo | C-0002 proved: The app keeps C-0002. This fix removes "Invite sent to". Apply fixes/1-BUG-001.patch and change C-0002?\nBUG-002 ok\n', 'the address varies, the words around it do not; text kept on an added line is not removed');
  const named = put('BUG-003', rec(1, { changesClaims: ['C-0002'] }));
  assert.equal(gate(...args, named).stdout, 'BUG-003 ok\n');
  assert.equal(gate('--gaps', 'no', '--auto', 'off', '--code', app, resend).stdout, 'BUG-001 ok\n', 'with no ledger, the old rules alone');
});

test('fix-gate --suspects lists, per claim, the fixes that touch its files or remove its text, oldest first', () => {
  const { app, put, gate, fixRun } = withLedger();
  const verify = join(app, 'verify');
  mkdirSync(verify);
  writeFileSync(join(verify, 'claims.json'), JSON.stringify({ claims: [
    proven('C-0001', { cases: [{ id: 'a', do: 'x', expect: '"Daily invite limit reached. Try again tomorrow."' }] }),
    { id: 'C9', statement: 'Spec.', source: 'docs/invites.md: "Only owners can revoke an invite."', cases: [{ id: 'a', do: 'x', expect: '"Only owners can revoke."' }] },
    proven('C-0005', { files: ['src/other.js'] }),
  ] }));
  const files = { 1: patch('src/page.js', ['a'], ['b']), 2: patch('src/api.js', ["  msg = 'Only owners can revoke.';"], ['  msg = null;']), 3: patch('src/page.js', ['c'], ['d']) };
  // BUG-003's patch was written first.
  for (const [n, text] of Object.entries(files)) writeFileSync(join(fixRun, `fixes/1-BUG-00${n}.patch`), text);
  utimesSync(join(fixRun, 'fixes/1-BUG-003.patch'), new Date(1000), new Date(1000));
  const dirs = [1, 2, 3].map((n) => put(`BUG-00${n}`, { fix: { status: 'fixed', patch: `fixes/1-BUG-00${n}.patch` } }));
  dirs.push(put('BUG-004', { fix: { status: 'fixed', summary: 'Fixed with BUG-001', patch: 'fixes/1-BUG-001.patch' } }));
  const res = gate('--suspects', verify, 'C-0001,C9,C-0005', '--fix-run', fixRun, ...dirs);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, 'C-0001: none | BUG-003 BUG-001\nC9: none | BUG-002\nC-0005: none | none\n');
  assert.equal(gate('--suspects', verify, 'C-0009', '--fix-run', fixRun, ...dirs).status, 2);
});

test('fix-gate --plan also names the proven claims that name no file: they may rest on any', () => {
  const { app, put, gate } = withLedger();
  const ledger = mkdtempSync(join(tmpdir(), 'ledger-'));
  writeClaims(ledger, 'invites', [proven('C-df53', { files: [], cases: [{ id: 'a', do: 'Tap Resend at 0 sends left', expect: '"Daily invite limit reached. Try again tomorrow." lies inside the visible screen' }] })]);
  const res = gate('--gaps', 'yes', '--auto', 'off', '--code', app, '--ledger', ledger, '--feature', 'invites', '--files', 'public/app.js', '--plan', 'low', 'no', '', put('BUG-015', {}));
  assert.equal(res.stdout, 'allowed\nkeep C-df53: The app keeps C-df53. | quotes "Daily invite limit reached. Try again tomorrow."\n');
});

// Modelled on run 2026-11-02-1006-improve: BUG-015 turned Send invite and Resend off at the limit, BUG-019 then named
// the reset time, BUG-027 reworded the resend toast, and BUG-011 put an Accept invite button on every accept page.
const LIMIT = "  $('limit-note').textContent = `${left} of ${limit} invite sends left today. Each new invite and each resend uses one, and revoking an invite does not give it back.";
const RUN = {
  15: [patch('public/app.js', [`${LIMIT}\`;`], ['  const atLimit = left === 0;', "  $('invite-fields').disabled = atLimit;", `${LIMIT}\${atLimit ? ' Send invite and Resend are off until sends come back.' : ''}\`;`]),
    patch('public/team.html', [], ['<fieldset id="invite-fields">'])].join(''),
  19: patch('public/app.js', [`${LIMIT}\${atLimit ? ' Send invite and Resend are off until sends come back.' : ''}\`;`], [`${LIMIT} Sends come back at \${back} (your time).\${atLimit ? ' Send invite and Resend are off until then.' : ''}\`;`]),
  27: patch('public/app.js', ['          toast(`Invite sent to ${invite.email}`);'], ['          toast(`Invite resent to ${invite.email}.`);']),
  11: patch('public/accept.html', [], ['<button id="accept" type="button">Accept invite</button>']),
  28: patch('public/app.js', ["    toast('Invite not found.');"], ["    toast('Invite not found. Ask the person who invited you for a new link.');", "    $('home').hidden = false;"]),
};

test('fix-gate --suspects puts first the fixes whose added text the failing case shows, as one re-proof can settle it', () => {
  const { app, put, gate, fixRun } = withLedger();
  const verify = join(app, 'verify');
  mkdirSync(join(verify, 'sessions'), { recursive: true });
  const ledgerClaim = (id, files, expect) => proven(id, { files, cases: [{ id: 'b', do: 'x', expect }] });
  writeFileSync(join(verify, 'claims.json'), JSON.stringify({ claims: [
    ledgerClaim('C-ca45', ['public/app.js'], 'The page shows "Daily invite limit reached. Try again tomorrow." (new); the list still shows 10 rows'),
    ledgerClaim('C-24e8', [], 'The page also shows "Each new invite and each resend uses one, and revoking an invite does not give it back."'),
    ledgerClaim('C-3322', [], 'The page shows "Invite sent to <the address>"'),
    { id: 'C-7ab1', statement: 'If an invite link is not found, then its page says what to do next.', cases: [{ id: 'a', do: 'Open /accept/old-link-from-chat', expect: 'The page has 1 or more links into the app' }] },
  ] }));
  const fail = (claim, c, expected, actual) => JSON.stringify({ n: 4, claim, case: c, action: 'x', expected, actual, result: 'fail' });
  writeFileSync(join(verify, 'sessions/01-web-free-owner.jsonl'), [
    JSON.stringify({ n: 1, claim: 'C-ca45', setup: 'new-org', action: 'x', expected: 'exit 0', actual: 'exit 1: "Invite resent to"', result: 'fail' }),
    fail('C-ca45', 'b', 'The page shows "Daily invite limit reached. Try again tomorrow."; the list still shows 10 rows', 'Email field and Send invite are disabled; page shows no "Daily invite limit reached. Try again tomorrow." (only "0 of 10 invite sends left today ... Send invite and Resend are off until then." and the old "Invite sent to qa+1793657877@acme.test"); 10 rows'),
    fail('C-3322', 'c', 'The page shows "Invite sent to qa+1793666054@acme.test"', 'POST /api/invites/<id>/resend 200; the page shows "Invite resent to qa+1793666054@acme.test." and no "Invite sent to" text'),
    'not json',
  ].join('\n'));
  writeFileSync(join(verify, 'sessions/02-web-free-member.jsonl'), `${fail('C-7ab1', 'a', 'The page has 1 or more links into the app', 'Page text "Accept invite\\nAccept invite" with a visible Accept invite button. The only link "Go to Acme" (/team) is hidden.')}\n`);
  // Written in the run's order: 11, 28, 15, 19, 27.
  const dirs = {};
  [11, 28, 15, 19, 27].forEach((n, i) => {
    writeFileSync(join(fixRun, `fixes/1-BUG-0${n}.patch`), RUN[n]);
    utimesSync(join(fixRun, `fixes/1-BUG-0${n}.patch`), new Date(1000 * (i + 1)), new Date(1000 * (i + 1)));
    dirs[n] = put(`BUG-0${n}`, { fix: { status: 'fixed', patch: `fixes/1-BUG-0${n}.patch` } });
  });
  writeFileSync(join(verify, 'fix-claims.json'), JSON.stringify([{ bug: dirs[28], claim: 'C-7ab1' }]));
  const res = gate('--suspects', verify, 'C-ca45,C-24e8,C-3322,C-7ab1', '--fix-run', fixRun, ...Object.values(dirs));
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, [
    // BUG-019 added the whole sentence, BUG-015 its first words; every app.js fix touches C-ca45's file.
    'C-ca45: BUG-019 BUG-015 shows "Send invite and Resend are off until then." | BUG-028 BUG-027',
    // No failing line for C-24e8: its given and expect quote the sends-left note, which both patches rewrite.
    'C-24e8: none | BUG-015 BUG-019',
    // "Invite sent to" is in the expect, so only the "re" text points: at BUG-027.
    'C-3322: BUG-027 shows "Invite resent to" | none',
    // A bug claim fails on another fix's text: BUG-011's button, not BUG-028's own change.
    'C-7ab1 (BUG-028): BUG-011 shows "Accept invite" | none',
    '',
  ].join('\n'));
});

test('fix-gate --suspects --code names the fixes whose patch a later fix changed, so they cannot be undone alone', () => {
  const { app, put, gate, fixRun } = withLedger();
  const code = mkdtempSync(join(tmpdir(), 'code-'));
  const git = (...a) => execFileSync('git', a, { cwd: code, encoding: 'utf8' });
  git('init', '-q');
  writeFileSync(join(code, 'app.js'), 'one\ntwo\nthree\n');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
  // BUG-001 changes line two; BUG-002 then changes that line again; BUG-003 adds a file.
  writeFileSync(join(code, 'app.js'), 'one\nTWO\nthree\n');
  writeFileSync(join(fixRun, 'fixes/1-BUG-001.patch'), git('diff'));
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'fix 1');
  writeFileSync(join(code, 'app.js'), 'one\nTwo!\nthree\n');
  writeFileSync(join(fixRun, 'fixes/1-BUG-002.patch'), git('diff'));
  writeFileSync(join(code, 'new.js'), 'x\n');
  git('add', '-N', 'new.js');
  writeFileSync(join(fixRun, 'fixes/1-BUG-003.patch'), git('diff', '--', 'new.js'));
  const verify = join(app, 'verify');
  mkdirSync(verify);
  writeFileSync(join(verify, 'claims.json'), JSON.stringify({ claims: [proven('C-0001', { files: ['app.js'] })] }));
  const dirs = [1, 2, 3].map((n) => put(`BUG-00${n}`, { fix: { status: 'fixed', patch: `fixes/1-BUG-00${n}.patch` } }));
  const res = gate('--suspects', verify, 'C-0001', '--fix-run', fixRun, '--code', code, ...dirs);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /\nNot undone alone: BUG-001\n$/);
  assert.doesNotMatch(gate('--suspects', verify, 'C-0001', '--fix-run', fixRun, ...dirs).stdout, /Not undone alone/, 'only with --code');
  assert.ok(readFileSync(join(code, 'app.js'), 'utf8').includes('Two!'), 'the check changes nothing');
});
