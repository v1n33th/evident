import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const key = JSON.parse(readFileSync(new URL('./answer-keys/acme-invites.json', import.meta.url), 'utf8'));

test('answer key is complete', () => {
  // P3 comes first: a report of the shortened refusal also mentions the 11th invite.
  // P2 comes last: its words ("twice", "duplicate") also turn up in reports of other faults.
  assert.deepEqual(key.bugs.map((b) => b.id), ['P3', 'P1', 'P4', 'P5', 'P6', 'P7', 'P8', 'P2']);
  for (const b of key.bugs) for (const f of ['targets', 'kind', 'steps', 'match']) assert.ok(b[f]?.length, `${b.id}.${f}`);
  assert.equal(key.bugs.find((b) => b.id === 'P4').viewport, 'mobile');
  // A phone-layout bug can be filed as "covered" or "cannot be tapped", not only "off screen".
  assert.deepEqual(matchBugs([{ id: 'BUG-004', title: 'Send invite button is covered by email input and cannot be tapped on mobile', target: 'web', kind: 'visual', actual: '' }], key.bugs.filter((b) => b.id === 'P4')).matched.map((m) => m.id), ['P4']);
  // The 11th-invite bug need not say "limit", and the refusal-text bug may say "try again" for "tomorrow".
  const limitBugs = [
    { id: 'BUG-008', title: 'A new Free org can send an 11th invite on the same UTC day', target: 'web', kind: 'bug', actual: 'The 11th invite is sent' },
    { id: 'BUG-010', title: 'At the daily limit the refusal says only "Daily invite limit reached." and not when to try again', target: 'web', kind: 'copy', actual: 'POST 429 after invite 11' },
  ];
  assert.deepEqual(matchBugs(limitBugs, key.bugs).matched.map((m) => [m.id, m.filed]), [['P3', ['BUG-010']], ['P1', ['BUG-008']]]);
  // A page-load error report may name the error, not the console.
  assert.deepEqual(matchBugs([{ id: 'BUG-003', title: 'Team page throws "ReferenceError: renderBadge is not defined" on every load', target: 'web', kind: 'bug', actual: '' }], key.bugs.filter((b) => b.id === 'P8')).matched.map((m) => m.id), ['P8']);
  const ids = new Set(key.bugs.map((b) => b.id));
  for (const s of ['S1', 'S2', 'S3', 'S4', 'F1']) assert.ok(key.scenarios[s], s);
  assert.deepEqual(Object.values(key.scenarios).map((s) => s.branch), ['main', 'next', 'next', 'next', 'next']);
  for (const s of ['S3', 'S4']) for (const id of key.scenarios[s].find) assert.ok(ids.has(id), id);
  for (const id of key.scenarios.F1.fix) assert.ok(ids.has(id), id);
  const expects = [...key.scenarios.S1.expect, ...key.scenarios.S2.expect];
  for (const x of [...key.bugs, ...expects]) assert.ok(x.match.length >= 1 && x.match.length <= 3, 'match size');
  const text = JSON.stringify(key);
  for (const w of ['.js', '.mjs', '=>', 'function', 'src/']) assert.ok(!text.includes(w), w);
});

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchClaims, matchBugs, scoreFix, scoreRun } from './score.mjs';

const script = join(dirname(fileURLToPath(import.meta.url)), 'score.mjs');
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const sha = (t) => createHash('sha256').update(t).digest('hex');
const dirs = [];
process.on('exit', () => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const mkClaim = (id, statement, target = 'api') => ({
  id, area: null, rank: 'headline', status: 'active', statement, given: 'G', setup: 'UI only', evidence: 'E', proof: 'will', target,
  cases: [{ id: 'a', do: `Send ${statement}`, expect: 'Status 429' }],
});
// One api claim C1 with a passing (or failing) case a, evidence at the given times.
const makeRun = ({ result = 'pass', statement = 'The app limits a Free org to 10 invites a day', at = ['2026-10-27T10:00:00Z', '2026-10-27T10:10:00Z'], bugs = {} } = {}) => {
  const run = mkdtempSync(join(tmpdir(), 'score-'));
  dirs.push(run);
  writeFileSync(join(run, 'claims.json'), JSON.stringify({ title: 'T', input: 'in', areas: [], claims: [mkClaim('C1', statement)] }));
  mkdirSync(join(run, 'sessions'));
  writeFileSync(join(run, 'sessions', 's1.jsonl'), jsonl([{ claim: 'C1', case: 'a', result }]));
  mkdirSync(join(run, 'evidence'));
  writeFileSync(join(run, 'evidence', 'a.txt'), 'x');
  writeFileSync(join(run, 'evidence.jsonl'), jsonl(at.map((t) => ({ claim: 'C1', case: 'a', target: 'api', method: 'http', commit: 'abc', env: 'local', at: t, by: 's', file: 'evidence/a.txt', sha256: sha('x'), note: '' }))));
  for (const [d, bug] of Object.entries(bugs)) {
    mkdirSync(join(run, 'bugs', d), { recursive: true });
    writeFileSync(join(run, 'bugs', d, 'bug.json'), JSON.stringify(bug));
  }
  return run;
};
const k = { scenarios: { S: { expect: [{ behaviour: 'limit', target: 'any', match: ['limit', 'free'], verdict: 'proven' }] } } };

test('matchClaims finds the limit claim by target and words', () => {
  const claims = [mkClaim('C1', 'The app lets anyone in'), mkClaim('C2', 'The app limits a Free org to 10 invites', 'web')];
  const [r] = matchClaims(claims.map((c) => ({ ...c, verdict: 'proven' })), [{ behaviour: 'limit', target: 'any', match: ['LIMIT', 'free'], verdict: 'proven' }]);
  assert.deepEqual([r.claimId, r.ok], ['C2', true]);
  const [none] = matchClaims(claims, [{ behaviour: 'x', target: 'any', match: ['paid'], verdict: 'proven' }]);
  assert.equal(none.claimId, null);
  assert.equal(none.ok, false);
  const [t] = matchClaims(claims, [{ behaviour: 'x', target: 'cli', match: ['limit'], verdict: 'proven' }]);
  assert.equal(t.claimId, null);
});

test('a wrong verdict makes the run fail', () => {
  const run = makeRun({ result: 'fail' });
  const r = scoreRun(run, k, 'S');
  assert.equal(r.verdicts[0].verdict, 'disproved');
  assert.equal(r.ok, false);
  assert.equal(scoreRun(makeRun(), k, 'S').ok, true);
});

test('matchBugs matches by target and words and lists the rest', () => {
  const planted = [
    { id: 'P1', targets: ['web', 'api'], match: ['11', 'limit'] },
    { id: 'P2', targets: ['web'], match: ['double', 'click'] },
  ];
  const filed = [
    { id: 'BUG-1', target: 'api', title: 'Limit off by one', steps: ['send the 11th'], actual: 'accepted' },
    { id: 'BUG-2', target: 'web', title: 'Odd colour', steps: [], actual: 'blue' },
  ];
  assert.deepEqual(matchBugs(filed, planted), { matched: [{ id: 'P1', filed: ['BUG-1'] }], missed: ['P2'], unmatched: ['BUG-2'] });
});

test('S3 needs min matched bugs', () => {
  const planted = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6'].map((id, i) => ({ id, targets: ['api'], match: [`w${i}`] }));
  const key = { bugs: planted, scenarios: { S3: { find: planted.map((p) => p.id), min: 5 } } };
  const bug = (i) => ({ id: `BUG-${i}`, target: 'api', title: `w${i}`, steps: [], actual: '' });
  const bugs = Object.fromEntries([0, 1, 2, 3].map((i) => [`BUG-${i}`, bug(i)]));
  const r = scoreRun(makeRun({ bugs }), key, 'S3');
  assert.equal(r.bugs.matched.length, 4);
  assert.equal(r.ok, false);
  bugs['BUG-4'] = bug(4);
  assert.equal(scoreRun(makeRun({ bugs }), key, 'S3').ok, true);
});

test('mail outside the pattern fails', () => {
  const run = makeRun();
  const mail = [{ to: 'qa+1761580000@acme.test' }, { to: 'pro-owner@acme.test' }, { to: 'someone@gmail.com' }];
  const r = scoreRun(run, k, 'S', { mail });
  assert.deepEqual(r.outsideMail, ['someone@gmail.com']);
  assert.equal(r.ok, false);
  const lenient = { ...k, scenarios: { S: { ...k.scenarios.S, badActorMail: true } } };
  assert.equal(scoreRun(run, lenient, 'S', { mail }).ok, true);
});

test('accounts count requests in the run window only', () => {
  const run = makeRun();
  const requests = [
    { at: '2026-10-27T09:00:00Z', account: 'free-owner', path: '/a' },
    { at: '2026-10-27T10:01:00Z', account: 'free-owner', path: '/a' },
    { at: '2026-10-27T10:02:00Z', account: 'free-owner', path: '/a' },
    { at: '2026-10-27T10:03:00Z', account: 'qa+1761580000', path: '/a' },
    { at: '2026-10-27T10:04:00Z', account: null, path: '/a' },
    { at: '2026-10-27T11:00:00Z', account: 'free-owner', path: '/a' },
  ];
  assert.deepEqual(scoreRun(run, k, 'S', { requests }).accounts, { 'free-owner': 2, 'qa+1761580000': 1 });
});

test('score reports a run with no claims', () => {
  const run = mkdtempSync(join(tmpdir(), 'score-'));
  dirs.push(run);
  const r = spawnSync(process.execPath, [script, run, '--key', join(dirname(script), 'answer-keys', 'acme-invites.json'), '--scenario', 'S1'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.equal(r.stdout.trim(), `Problem: ${run}/claims.json missing`);
});

test('one filed bug matches one planted fault only', () => {
  const planted = [{ id: 'P1', targets: ['api'], match: ['limit'] }, { id: 'P2', targets: ['api'], match: ['limit'] }];
  const filed = [{ id: 'BUG-1', target: 'api', title: 'limit', steps: [], actual: '' }];
  assert.deepEqual(matchBugs(filed, planted), { matched: [{ id: 'P1', filed: ['BUG-1'] }], missed: ['P2'], unmatched: [] });
});

const keyFile = join(dirname(script), 'answer-keys', 'acme-invites.json');

test('a malformed request line is skipped', () => {
  const run = makeRun();
  const log = join(run, 'requests.jsonl');
  writeFileSync(log, `${JSON.stringify({ at: '2026-10-27T10:01:00Z', account: 'free-owner' })}\n{"at":"2026-10-27T10:0`);
  const r = spawnSync(process.execPath, [script, run, '--key', keyFile, '--scenario', 'S3', '--requests', log], { encoding: 'utf8' });
  assert.match(r.stdout, /free-owner: 1 requests/);
  assert.match(r.stdout, /skipped 1 malformed request lines/);
  assert.equal(r.stderr, '');
});

test('a mail error body exits 2', async () => {
  const server = createServer((_, res) => { res.statusCode = 500; res.end('{"error":"x"}'); });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${server.address().port}/mail`;
  const run = makeRun();
  const r = await promisify(execFile)(process.execPath, [script, run, '--key', keyFile, '--scenario', 'S3', '--mail', url]).catch((e) => e);
  server.close();
  assert.equal(r.code, 2);
  assert.equal(r.stdout.trim(), `Problem: ${url} did not return the mail list`);
});

const real = (ids) => key.bugs.filter((b) => ids.includes(b.id));

test('a filed bug goes to the planted fault of its kind', () => {
  const filed = [
    { id: 'BUG-1', target: 'api', kind: 'bug', title: 'A Free org can send an 11th invite', steps: ['Send 10 invites', 'Send an 11th'], actual: '201 instead of the "Try again tomorrow." refusal; the limit starts at the 12th' },
    { id: 'BUG-2', target: 'api', kind: 'copy', title: "Daily limit refusal leaves out 'Try again tomorrow.'", steps: ['Send 11 invites', 'Send a 12th'], actual: 'Daily invite limit reached.' },
  ];
  const r = matchBugs(filed, real(['P1', 'P2', 'P3']));
  assert.deepEqual(r.matched, [{ id: 'P3', filed: ['BUG-2'] }, { id: 'P1', filed: ['BUG-1'] }]);
  assert.deepEqual(r.unmatched, []);
});

test('P2 matches a web double click and an API double send', () => {
  const filed = [
    { id: 'BUG-1', target: 'web', kind: 'bug', title: 'Double-click on Send invite creates two invites', steps: ['Type an email', 'Double-click Send invite'], actual: 'Two rows for one address' },
    { id: 'BUG-2', target: 'api', kind: 'bug', title: 'The same POST /api/invites sent twice at once creates two invites', steps: ['Send two identical requests in parallel'], actual: 'Both 201' },
    { id: 'BUG-3', target: 'cli', kind: 'bug', title: 'Running invite for one address twice in parallel makes a duplicate', steps: ['node cli.mjs invite a@acme.test twice at once'], actual: 'Two invites listed' },
  ];
  const r = matchBugs(filed, real(['P1', 'P2', 'P3']));
  assert.deepEqual(r.matched, [{ id: 'P2', filed: ['BUG-1', 'BUG-2', 'BUG-3'] }]);
});

test('reports of other faults that say "twice" or "duplicate" do not go to P2', () => {
  const filed = [
    { id: 'BUG-1', target: 'web', kind: 'bug', title: 'Team page logs a console error on load', steps: ['Sign in', 'Open the team page'], actual: 'renderBadge is not defined, logged twice; the invite list still loads' },
    { id: 'BUG-2', target: 'web', kind: 'bug', title: 'A revoked invite can still be accepted', steps: ['Revoke an invite', 'Open the accept link twice'], actual: 'Invite accepted.' },
    { id: 'BUG-3', target: 'web', kind: 'bug', title: 'Re-inviting a revoked address creates a duplicate invite row', steps: ['Revoke an invite', 'Invite the same address'], actual: 'A new row next to the revoked one' },
  ];
  const r = matchBugs(filed, real(['P2', 'P6', 'P8']));
  assert.deepEqual(r.matched, [{ id: 'P6', filed: ['BUG-2'] }, { id: 'P8', filed: ['BUG-1'] }]);
  assert.deepEqual(r.missed, ['P2']);
  assert.deepEqual(r.unmatched, ['BUG-3']);
});

test('matchClaims matches statements before case text and prefers untaken claims', () => {
  const claim = (id, statement, verdict, cases) => ({ id, statement, target: 'api', verdict, cases });
  // Ordered as build-proof sorts them: disproved first.
  const claims = [
    claim('C1', 'A Free org is limited to 10 invites a day; the 11th is refused', 'disproved', [{ id: 'a', do: 'Count the invites sent today, then send one more', expect: '429' }]),
    claim('C2', 'At the limit the refusal says "Daily invite limit reached. Try again tomorrow."', 'disproved', [{ id: 'a', do: 'Send past the limit', expect: 'Try again tomorrow' }]),
    claim('C3', 'A paid org has no daily limit', 'proven', [{ id: 'a', do: 'Send 15 invites', expect: '201 each' }]),
    claim('C4', 'Refused invites do not count toward the daily limit', 'proven', [{ id: 'a', do: 'Send a bad address, then 10 good ones', expect: '201 each' }]),
  ];
  const r = matchClaims(claims, key.scenarios.S2.expect);
  assert.deepEqual(r.map((v) => [v.claimId, v.ok]), [['C1', true], ['C2', true], ['C3', true], ['C4', true]]);
  const twice = { behaviour: 'x', target: 'any', match: ['limit'], verdict: 'proven' };
  assert.deepEqual(matchClaims(claims, [twice, twice]).map((v) => v.claimId), ['C1', 'C2']);
  const caseOnly = { behaviour: 'y', target: 'any', match: ['bad address'], verdict: 'proven' };
  assert.equal(matchClaims(claims, [caseOnly])[0].claimId, 'C4');
});

test('a web case without visual evidence fails the run', () => {
  // The verdict is as expected; only the missing picture fails the run.
  const run = makeRun({ result: 'fail' });
  const claims = JSON.parse(readFileSync(join(run, 'claims.json'), 'utf8'));
  claims.claims[0].target = 'web';
  writeFileSync(join(run, 'claims.json'), JSON.stringify(claims));
  const disproved = { scenarios: { S: { expect: [{ ...k.scenarios.S.expect[0], verdict: 'disproved' }] } } };
  const r = scoreRun(run, disproved, 'S');
  assert.equal(r.verdicts[0].ok, true);
  assert.ok(r.evidenceProblems.some((p) => /without visual evidence/.test(p)), r.evidenceProblems.join('\n'));
  assert.equal(r.ok, false);
});

test('scoreFix counts a planted bug as fixed only when its fix is proven', () => {
  const root = mkdtempSync(join(tmpdir(), 'scorefix-'));
  dirs.push(root);
  const put = (name, text) => { mkdirSync(dirname(join(root, name)), { recursive: true }); writeFileSync(join(root, name), text); };
  put('explore/charters/T1.jsonl', '');
  put('explore/bugs/BUG-001-x/bug.json', JSON.stringify({ id: 'BUG-001', target: 'web', kind: 'bug', severity: 'major', title: 'The 11th invite is sent past the limit', steps: [], actual: 'sent', fix: { status: 'fixed' } }));
  put('explore/bugs/BUG-002-y/bug.json', JSON.stringify({ id: 'BUG-002', target: 'web', kind: 'copy', severity: 'minor', title: 'The limit message leaves out Try again tomorrow', steps: [], actual: 'short', fix: { status: 'fixed' } }));
  put('verify/evidence/C5-a.txt', 'ok');
  put('verify/fix-claims.json', JSON.stringify([{ bug: join(root, 'explore/bugs/BUG-001-x'), claim: 'C5' }, { bug: join(root, 'explore/bugs/BUG-002-y'), claim: 'C6' }]));
  put('verify/claims.json', JSON.stringify({ claims: [
    { id: 'C5', target: 'api', statement: 'If a Free org has sent 10 invites today, then the app refuses the 11th.', status: 'active', rank: 'headline', source: 'found: BUG-001', cases: [{ id: 'a' }] },
    { id: 'C6', target: 'api', statement: 'If the limit is reached, then the message says Try again tomorrow.', status: 'active', rank: 'headline', source: 'found: BUG-002', cases: [{ id: 'a' }] },
  ] }));
  put('verify/sessions/s1.jsonl', jsonl([{ claim: 'C5', case: 'a', result: 'pass' }, { claim: 'C6', case: 'a', result: 'fail' }]));
  put('verify/evidence.jsonl', jsonl([{ claim: 'C5', case: 'a', target: 'api', method: 'curl', at: 't', commit: 'c', file: 'evidence/C5-a.txt', sha256: sha('ok') }]));
  put('fix/rounds.json', JSON.stringify({ feature: 'invite-limit', rounds: [{ n: 1, explore: join(root, 'explore'), verify: join(root, 'verify') }] }));
  const k = { bugs: key.bugs, scenarios: { F: { fix: ['P1', 'P3'], min: 1 } } };
  const r = scoreFix(join(root, 'fix'), k, 'F');
  assert.deepEqual(r.fixed, [{ id: 'P1', bugs: ['BUG-001'] }]);
  assert.deepEqual(r.missed, ['P3']);
  assert.equal(r.ok, true);
});
