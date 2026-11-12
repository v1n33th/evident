import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { readResult, writeResult } from '../../skills/show-your-work/scripts/report.mjs';

test('readResult returns the checked data until a file in the step changes', () => {
  const step = mkdtempSync(join(tmpdir(), 'step-'));
  mkdirSync(join(step, 'evidence'));
  writeFileSync(join(step, 'evidence', 'C1-a.png'), 'png');
  const past = new Date(Date.now() - 60_000);
  utimesSync(join(step, 'evidence', 'C1-a.png'), past, past);
  assert.equal(readResult(step), null);
  writeResult(step, { x: 1 });
  assert.deepEqual(readResult(step), { x: 1 });
  const { newest } = JSON.parse(readFileSync(join(step, 'result.json'), 'utf8'));
  const later = new Date(newest + 1000);
  utimesSync(join(step, 'evidence', 'C1-a.png'), later, later);
  assert.equal(readResult(step), null);
});

test('readResult stays fresh when a bug is filed with only its record, and goes stale when evidence comes', () => {
  const step = mkdtempSync(join(tmpdir(), 'step-'));
  mkdirSync(join(step, 'evidence'));
  writeFileSync(join(step, 'evidence', 'C1-a.png'), 'png');
  writeResult(step, { x: 1 });
  mkdirSync(join(step, 'bugs', 'BUG-009-x'), { recursive: true });
  writeFileSync(join(step, 'bugs', '.BUG-009'), '');
  writeFileSync(join(step, 'bugs', 'BUG-009-x', 'bug.json'), '{}');
  assert.deepEqual(readResult(step), { x: 1 }, 'a record and its number change no verdict');
  writeFileSync(join(step, 'bugs', 'BUG-009-x', 'found.png'), 'png');
  assert.equal(readResult(step), null, 'evidence does');
  // A result an older version wrote lists the reservation files: it still reads as fresh.
  const old = mkdtempSync(join(tmpdir(), 'step-'));
  mkdirSync(join(old, 'bugs'));
  writeFileSync(join(old, 'bugs', '.BUG-001'), '');
  writeResult(old, { y: 1 });
  const stored = JSON.parse(readFileSync(join(old, 'result.json'), 'utf8'));
  writeFileSync(join(old, 'result.json'), JSON.stringify({ ...stored, files: [...stored.files, 'bugs/.BUG-001'].sort() }));
  assert.deepEqual(readResult(old), { y: 1 });
});

import { headline, requestData } from '../../skills/show-your-work/scripts/report.mjs';
import { newRequest, newStep } from '../../skills/show-your-work/scripts/run-folder.mjs';

const put = (dir, files) => { for (const [name, text] of Object.entries(files)) { mkdirSync(join(dir, name, '..'), { recursive: true }); writeFileSync(join(dir, name), typeof text === 'string' ? text : JSON.stringify(text)); } };
const bug = (id, extra = {}) => ({ id, title: `Title ${id}`, severity: 'major', target: 'web', steps: ['Do it'], expected: 'It works', actual: 'It breaks', ...extra });
const project = () => mkdtempSync(join(tmpdir(), 'project-'));
const explore = (p, name = 'invites', when = new Date(2026, 10, 1, 9, 0)) => {
  const request = newRequest(p, name, 'explore', when);
  const step = newStep(request, 'explore', ['charters', 'evidence']);
  put(request, { 'brief.md': '## Request\nexplore invites\n' });
  put(step, { 'charters.json': { charters: [] }, 'bugs/BUG-001-a/bug.json': bug('BUG-001'), 'bugs/BUG-001-a/found.png': 'png', 'bugs/BUG-002-b/bug.json': bug('BUG-002') });
  return { request, step };
};

test('requestData of an explore request lists its bugs, found and nothing more', async () => {
  const { request } = explore(project());
  const data = await requestData(request);
  assert.deepEqual(data.stages.map((s) => s.label), ['Plan', 'Explore', 'Done']);
  assert.equal(data.counts.found, 2);
  assert.ok(data.bugs.every((b) => b.fixed === null && b.proven === null));
  assert.deepEqual(data.bugs[0].evidence, ['explore/bugs/BUG-001-a/found.png']);
});

const grown = (p, { checked = true, when } = {}) => {
  const { request, step } = explore(p, 'invites', when);
  const fix = newStep(request, 'fix', ['fixes']);
  put(step, { 'bugs/BUG-001-a/bug.json': bug('BUG-001', { fix: { status: 'fixed', summary: 'Refuse it', risk: 'low', patch: 'fixes/1-BUG-001.patch' } }),
    'bugs/BUG-002-b/bug.json': bug('BUG-002', { fix: { status: 'needs-decision', summary: 'Asks you', decision: 'Change it?' } }) });
  put(fix, { 'rounds.json': { feature: 'invites', rounds: [{ n: 1, explore: step, verify: join(request, 'proof') }] }, 'fixes/1-BUG-001.patch': '+++ b/src/a.mjs\n' });
  const proof = newStep(request, 'proof');
  put(proof, { 'claims.json': { title: 'Fixes', claims: [{ id: 'C-0001', statement: 'It works', status: 'active', rank: 'headline', target: 'web', cases: [{ id: 'a', do: 'Do it', expect: 'It works' }] }] },
    'fix-claims.json': [{ bug: join(step, 'bugs/BUG-001-a'), claim: 'C-0001' }] });
  if (checked) writeResult(proof, { claims: [{ id: 'C-0001', statement: 'It works', verdict: 'proven', cases: [], evidence: [] }], problems: [] });
  return { request, step, fix, proof };
};

test('requestData of a grown request joins found, fixed and proven per bug', async () => {
  const { request } = grown(project());
  const data = await requestData(request);
  const [one, two] = data.bugs;
  assert.deepEqual([one.id, one.fixed, one.proven, one.needsYou], ['BUG-001', true, 'proven', false]);
  assert.deepEqual([two.id, two.fixed, two.needsYou], ['BUG-002', false, true]);
  assert.deepEqual(data.counts, { found: 2, gaps: 0, unconfirmed: 0, fixed: 1, proven: 1, needsYou: 1, questions: 0, checks: 1, ownChecks: 0, checksProven: 1, checksFailed: 0, checksUnproven: 0 });
  assert.deepEqual(data.stages.map((s) => s.label), ['Plan', 'Explore', 'Fix', 'Prove', 'Done']);
});

test('a proof step without a fresh result shows checking while the run goes, and could not be proven once it is over', async () => {
  const p = project();
  const { request, proof } = grown(p, { checked: false });
  assert.equal((await requestData(request)).bugs[0].proven, 'not-proven');
  writeFileSync(join(p, 'run.lock'), `${proof}\n`);
  assert.equal((await requestData(request)).bugs[0].proven, 'checking');
});

test('live while run.lock names a step here and is fresh, done otherwise', async () => {
  const p = project();
  const { request, proof } = grown(p);
  writeFileSync(join(p, 'run.lock'), `${proof}\n`);
  assert.equal((await requestData(request)).live, true);
  const other = explore(p, 'billing');
  writeFileSync(join(p, 'run.lock'), `${other.step}\n`);
  assert.equal((await requestData(request)).live, false);
  writeFileSync(join(p, 'run.lock'), `${proof}\n`);
  const old = new Date(Date.now() - 13 * 3600e3);
  utimesSync(join(p, 'run.lock'), old, old);
  assert.equal((await requestData(request)).live, false);
});

test('a request with only brief.md is a page at Plan', async () => {
  const request = newRequest(project(), 'invites', 'explore');
  put(request, { 'brief.md': '## Request\nx\n' });
  const data = await requestData(request);
  assert.equal(data.stages[0].state, 'now');
  assert.deepEqual(data.bugs, []);
});

test('a half-written log line is a problem, not a crash', async () => {
  const { request, proof } = grown(project(), { checked: false });
  put(proof, { 'sessions/01-web.jsonl': '{"claim":"C-0001","case":"a","result":"pass"}\n{"claim":"C-0001","ca' });
  const data = await requestData(request);
  assert.ok(data.problems.some((p) => p.includes('sessions/01-web.jsonl')), data.problems.join('; '));
});

test('a fix request shows bugs from the explores it fixed, and the origin shows where it was fixed', async () => {
  const p = project();
  const a = explore(p);
  const b = newRequest(p, 'invites', 'fix', new Date(2026, 10, 2, 9, 0));
  const fix = newStep(b, 'fix', ['fixes']);
  put(fix, { 'rounds.json': { feature: 'invites', rounds: [{ n: 1, explore: a.step, verify: null }] } });
  const data = await requestData(b);
  assert.deepEqual(data.bugs.map((x) => x.id), ['BUG-001', 'BUG-002']);
  assert.ok(data.bugs[0].dir.startsWith('../'));
  assert.equal((await requestData(a.request)).bugs[0].fixedIn, '2026-11-02-0900-fix');
});

import { existsSync } from 'node:fs';
import { pageHtml, writeReport, writeReportFor } from '../../skills/show-your-work/scripts/report.mjs';

const sample = async () => requestData(grown(project()).request);

test('pageHtml reloads only while live', async () => {
  const data = await sample();
  // A script reloads it and keeps your place, open sections and video times; it waits while a video plays or you type.
  // Without scripts, the plain refresh still runs.
  const live = pageHtml({ ...data, live: true });
  assert.match(live, /<noscript><meta http-equiv="refresh" content="5"><\/noscript>/);
  assert.doesNotMatch(live.replace(/<noscript>.*?<\/noscript>/g, ''), /http-equiv="refresh"/);
  assert.match(live, /<script>[\s\S]*sessionStorage[\s\S]*scrollY[\s\S]*currentTime[\s\S]*location\.reload\(\)[\s\S]*<\/script>/);
  assert.doesNotMatch(pageHtml({ ...data, live: false }), /http-equiv="refresh"|location\.reload/);
  // The start and update times name their zone.
  assert.match(pageHtml({ ...data, live: false }), /started [^<]* at \d\d:\d\d (UTC|GMT[+-][\d:]+)[,.][\s\S]*Updated [^<]*\d\d:\d\d:\d\d (UTC|GMT[+-][\d:]+)/);
  // While live, the headline still says what already waits on you.
  assert.match(pageHtml({ ...data, live: true }), /<h1 class="wait">\d+ decisions? waits? for you\. Still running\.<\/h1>/);
  assert.match(pageHtml({ ...data, live: true, counts: { ...data.counts, needsYou: 0 } }), /<h1 class="run">Still running\.<\/h1>/);
});

test('pageHtml escapes text, and has no answer script when nothing waits for an answer', async () => {
  const data = await sample();
  data.bugs[0].title = '<b>x</b>';
  for (const b of data.bugs) b.needsYou = false;
  const html = pageHtml(data);
  assert.doesNotMatch(html, /copy-answers|answer-lines/);
  assert.match(html, /&#60;b&#62;x&#60;\/b&#62;/);
});

test('pageHtml links text evidence and never inlines it', async () => {
  const { request, step } = grown(project());
  put(step, { 'bugs/BUG-001-a/network.txt': 'TOKEN=abc' });
  const html = pageHtml(await requestData(request));
  assert.match(html, /href="explore\/bugs\/BUG-001-a\/network\.txt"/);
  assert.doesNotMatch(html, /TOKEN=abc/);
});

test('writeReport writes the page and summary in place', async () => {
  const { request } = grown(project());
  await writeReport(request);
  assert.ok(existsSync(join(request, 'report.html')));
  assert.ok(!existsSync(join(request, 'report.html.tmp')));
  const summary = JSON.parse(readFileSync(join(request, 'summary.json'), 'utf8'));
  assert.deepEqual(summary.counts, { found: 2, gaps: 0, unconfirmed: 0, fixed: 1, proven: 1, needsYou: 1, questions: 0, checks: 1, ownChecks: 0, checksProven: 1, checksFailed: 0, checksUnproven: 0 });
  assert.equal(summary.name, '2026-11-01-0900-explore');
  assert.deepEqual(summary.bugs.map((b) => [b.id, b.needsYou, b.state]), [['BUG-001', false, 'Fixed and proven'], ['BUG-002', true, 'Waiting for your decision']], 'the index names each bug and where it stands');
});

test('writeReportFor finds the request from a bug folder, and never throws', async () => {
  const { request, step } = grown(project());
  await writeReportFor(join(step, 'bugs', 'BUG-001-a'));
  assert.ok(existsSync(join(request, 'report.html')));
  const outside = project();
  await writeReportFor(outside);
  assert.ok(!existsSync(join(outside, 'report.html')));
});

import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const SCRIPTS = fileURLToPath(new URL('../../skills/', import.meta.url));
const node = (script, ...args) => spawnSync('node', [join(SCRIPTS, script), ...args], { encoding: 'utf8' });

const waitFor = async (check) => { for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 100)); return check(); };

test('log.mjs logs first, then rebuilds the request page in the background at most once per REBUILD_EVERY seconds, and logs even when it cannot', async () => {
  const { request, proof } = grown(project(), { checked: false });
  put(proof, { 'evidence/C-0001-a.txt': 'ok' });
  const log = (note) => node('evidence/scripts/log.mjs', proof, 'evidence.jsonl', JSON.stringify({ claim: 'C-0001', case: 'a', file: 'evidence/C-0001-a.txt', method: 'text', note }));
  assert.ok(!existsSync(join(request, 'report.html')));
  assert.equal(log('ok').status, 0);
  assert.ok(await waitFor(() => existsSync(join(request, 'report.html'))), 'the page follows the capture');
  rm(join(request, 'report.html'));
  assert.equal(log('again').status, 0);
  await new Promise((r) => setTimeout(r, 1500));
  assert.ok(!existsSync(join(request, 'report.html')), 'a second call within the window builds nothing');
  rm(join(request, '.report-started'));
  mkdirSync(join(request, 'report.html', 'x'), { recursive: true });
  assert.equal(log('third').status, 0);
  assert.equal(readFileSync(join(proof, 'evidence.jsonl'), 'utf8').trim().split('\n').length, 3);
});

test('report.mjs --if-page keeps a page written after the build was asked for', () => {
  const { request } = grown(project());
  writeFileSync(join(request, 'report.html'), 'newer');
  assert.equal(node('show-your-work/scripts/report.mjs', request, '--if-page', '0').status, 0);
  assert.equal(readFileSync(join(request, 'report.html'), 'utf8'), 'newer');
  node('show-your-work/scripts/report.mjs', request, '--if-page', String(statSync(join(request, 'report.html')).mtimeMs));
  assert.match(readFileSync(join(request, 'report.html'), 'utf8'), /^<!doctype html>/i);
  assert.equal(node('show-your-work/scripts/report.mjs', request, '--if-page').status, 1);
});

test('writeReportFor builds each request once, however many of its paths it is given', async () => {
  const { request, step } = grown(project());
  mkdirSync(join(request, 'report.html', 'x'), { recursive: true });
  const said = [];
  const error = console.error;
  console.error = (m) => said.push(m);
  try { await writeReportFor(join(step, 'bugs', 'BUG-001-a'), join(step, 'bugs', 'BUG-002-b'), step); } finally { console.error = error; }
  assert.equal(said.filter((m) => /^Report: not written/.test(m)).length, 1);
});

test('build-proof --session leaves the page alone: a session file shows nowhere on it', () => {
  const { request, proof } = grown(project(), { checked: false });
  const id = JSON.parse(readFileSync(join(proof, 'claims.json'), 'utf8')).claims[0].id;
  assert.equal(node('show-your-work/scripts/build-proof.mjs', proof, '--session', '01-web-owner', id).status, 0);
  assert.ok(!existsSync(join(request, 'report.html')));
});

test('run-folder --release deletes the lock and writes a done page', () => {
  const p = project();
  const { request, proof } = grown(p);
  writeFileSync(join(p, 'run.lock'), `${proof}\n`);
  const res = node('show-your-work/scripts/run-folder.mjs', '--release', p);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /^Released: .*proof$/m);
  assert.ok(!existsSync(join(p, 'run.lock')));
  assert.doesNotMatch(readFileSync(join(request, 'report.html'), 'utf8'), /http-equiv="refresh"/);
  assert.match(node('show-your-work/scripts/run-folder.mjs', '--release', p).stdout, /^Released: no lock was held$/m);
});

test('run-folder writes the first page when it makes a request', () => {
  const p = project();
  const out = node('show-your-work/scripts/run-folder.mjs', p, 'invites', 'explore', 'explore').stdout;
  const request = out.match(/^Request folder: (.*)$/m)[1];
  assert.ok(existsSync(join(request, 'report.html')));
});

test('the page shows an auto-mode request, what was decided without you, a stop and release notes', async () => {
  const { request, fix } = grown(project());
  put(request, { 'decisions.md': 'Ruling: default: approved 5 claims as written — auto mode — a wrong claim proved\n' });
  put(fix, { 'rounds.json': { feature: 'invites', auto: true, stopped: 'The app did not change after 3 fixes and a restart.', rounds: [{ n: 1, flaky: ['C-bbea'] }] } });
  writeResult(fix, { releaseNotes: { migrations: [], existingUsers: ['BUG-001: Free orgs can no longer send an 11th invite.'] } });
  const html = pageHtml(await requestData(request));
  assert.match(html, /<details class="banner"><summary>1 choice made automatically, without you<\/summary>/);
  assert.match(html, /Approved 5 claims as written/);
  assert.match(html, /The app did not change after 3 fixes and a restart\./);
  assert.match(html, /Free orgs can no longer send an 11th invite\./);
  assert.match(html, /Unreliable tests<\/dt><dd><p>Each passed once and failed once on the same code, so no fix was undone for it: C-bbea \(round 1\)\./);
  // A stopped run comes before your decisions; the auto choices fold into a banner after them.
  assert.ok(html.indexOf('The run stopped') < html.indexOf('id="decisions"') && html.indexOf('id="decisions"') < html.indexOf('class="banner"'));
  assert.doesNotMatch(html, /Decided without you/);
});

test('the page opens with a plain result line, and each bug has one plain state', async () => {
  const { request, step, proof } = grown(project());
  put(step, { 'bugs/BUG-002-b/bug.json': bug('BUG-002', { fix: { status: 'not-fixed', summary: 'Wrap the form', decision: 'The fix did not hold. Fix by hand?' } }) });
  put(join(step, '..'), {});
  writeResult(proof, { claims: [{ id: 'C-0001', statement: 'It works', verdict: 'proven', cases: [], evidence: [] }], problems: [] });
  const data = await requestData(request);
  const html = pageHtml(data);
  assert.match(html, /<p class="sub">Found 2 bugs; 1 fixed and verified so far\.<\/p>/);
  assert.match(html, /1 decision waits for you before you ship\.[\s\S]*<ul class="parts"><li>Retry or leave 1 fix that didn&#39;t work<\/li><\/ul>/);
  assert.doesNotMatch(html, /<p class="sub">[^<]*did not hold/, 'said once, in the parts line');
  assert.deepEqual(data.bugs.map((b) => b.state), ['Fixed and proven', 'Fix did not hold']);
});

test('a bug waits for a decision, or its fix was never requested, in plain words', async () => {
  const { request } = grown(project());
  assert.equal((await requestData(request)).bugs[1].state, 'Waiting for your decision');
  const { request: explored } = explore(project());
  assert.equal((await requestData(explored)).bugs[0].state, 'Fix not requested');
});

test('a proof request counts its checks, and failed or unproven checks need you', async () => {
  const p = project();
  const request = newRequest(p, 'billing', 'prove', new Date(2026, 10, 3, 14, 30));
  const proof = newStep(request, 'proof');
  put(proof, { 'claims.json': { claims: [] } });
  writeResult(proof, { claims: [
    { id: 'C-0001', statement: 'A', verdict: 'proven', cases: [{ id: 'a', result: 'pass' }], evidence: [] },
    { id: 'C-0002', statement: 'B', verdict: 'disproved', cases: [{ id: 'a', result: 'fail', actual: 'The 51st seat was added.' }], evidence: [] },
    { id: 'C-0003', statement: 'C', verdict: 'not-proven', cases: [{ id: 'a', result: 'blocked', note: 'No way to make a plan lapse' }], evidence: [] }], problems: [] });
  const data = await requestData(request);
  assert.deepEqual(data.counts, { found: 0, gaps: 0, unconfirmed: 0, fixed: 0, proven: 0, needsYou: 2, questions: 0, checks: 3, ownChecks: 3, checksProven: 1, checksFailed: 1, checksUnproven: 1 });
  const html = pageHtml(data);
  assert.match(html, /<p class="sub">1 of 3 tests passed\.<\/p>/);
  assert.match(html, /2 decisions wait for you before you ship\.[\s\S]*<ul class="parts"><li>Fix, retest or drop 1 failed test<\/li><li>Test again the 1 thing that couldn&#39;t be checked \(one click\)<\/li><\/ul>/);
  assert.match(html, /Why it could not run: No way to make a plan lapse/);
  assert.match(html, /<dt>Got<\/dt><dd class="got">The 51st seat was added\.<\/dd>/);
  assert.doesNotMatch(html, /approved by a person/);
  put(proof, { 'claims.json': { approvedBy: 'user', claims: [] } });
  writeResult(proof, { approvedBy: 'user', claims: [], problems: [] });
  assert.match(pageHtml(await requestData(request)), /The tests were approved by a person before testing\./);
});

test('a check shows its cases in order, each with its own evidence: the failed one open, calls as one line each, pictures with their device', async () => {
  const request = newRequest(project(), 'billing', 'prove', new Date(2026, 10, 3, 14, 30));
  const proof = newStep(request, 'proof');
  put(proof, { 'claims.json': { claims: [] } });
  const ev = (k, file, role, note, viewport) => ({ claim: 'C-0002', case: k, file: `evidence/${file}`, role, note, viewport });
  const call = (k, n, req, res) => ['request', 'response', 'headers', 'body'].map((part) => ev(k, `C-0002-${k}-${n}-${part}.txt`, 'raw', part === 'request' ? req : part === 'response' ? res : 'x'));
  writeResult(proof, { claims: [
    { id: 'C-0002', statement: 'B', verdict: 'disproved', evidence: [
      ev('a', 'C-0002-a-setup.txt', 'measure', 'exit 0'), ...call('a', 1, 'POST /api/seats', 'HTTP/1.1 201 Created'),
      ...[1, 2, 3, 4].flatMap((n) => call('b', n, `POST /api/seats (${n})`, n === 4 ? 'HTTP/1.1 201 Created; seat 51' : 'HTTP/1.1 201 Created')),
      ev('b', 'C-0002-b-mobile.png', 'picture', 'Team page shows 51 seats', 'mobile'), ev('b', 'C-0002-b.webm', 'picture', 'Measured: Add stays enabled', 'desktop'),
      ev('b', 'C-0002-b-console.txt', 'raw', 'empty: no console messages')],
    cases: [{ id: 'a', result: 'pass', do: 'Add the 50th seat', expect: 'Added' },
      { id: 'b', result: 'fail', bug: 'BUG-002', do: 'Add the 51st seat', expect: 'Refused', actual: 'The 51st seat was added.', note: 'Used a fresh org' }] },
    { id: 'C-0004', statement: 'D', verdict: 'not-proven', proof: 'will not: needs a setup command that moves the clock', evidence: [], cases: [{ id: 'a', result: 'not-run', do: 'Wait a day' }] }], problems: [] });
  const html = pageHtml(await requestData(request));
  const card = html.match(/<details class="bug check [^"]*" id="C-0002"[\s\S]*?<\/ol><\/div><\/details>/)[0];
  assert.match(card, /<span class="trail">1 of 2 steps failed<\/span>/);
  assert.match(card, /<details class="case good"><summary><b class="mark"><\/b>a\. Add the 50th seat<\/summary>/, 'a passed case folds to one line');
  assert.match(card, /<details class="case need" open><summary><b class="mark"><\/b>b\. Add the 51st seat <span class="bugid">BUG-002<\/span><\/summary>/);
  const b = card.slice(card.indexOf('<details class="case need"'));
  assert.match(b, /<dl class="vs2"><dt>Expected<\/dt><dd>Refused<\/dd><dt>Got<\/dt><dd class="got">The 51st seat was added\.<\/dd><\/dl>/);
  assert.match(b, /<div class="note">Tester's note: Used a fresh org<\/div>/);
  assert.match(b, /<p class="calls-head">Last 3 of 4 calls<\/p><ul class="calls">[\s\S]*<a href="proof\/evidence\/C-0002-b-4-response\.txt" target="_blank" rel="noopener">POST \/api\/seats \(4\) → HTTP\/1\.1 201 Created; seat 51<\/a>/);
  assert.doesNotMatch(b.slice(0, b.indexOf('<details class="files">')), /C-0002-b-1-|headers\.txt|body\.txt/, 'older calls and the split files wait under All files');
  assert.match(b, /<figure class="ev">[\s\S]*?C-0002-b-mobile\.png[\s\S]*?<figcaption>Phone · Team page shows 51 seats<\/figcaption><\/figure>/);
  assert.match(b, /<figcaption>Desktop · Measured: Add stays enabled<\/figcaption>/);
  assert.match(b, /<p class="console">Console: no errors<\/p>/);
  assert.match(b, /<details class="files"><summary>All files \(19\)<\/summary>/);
  assert.ok(card.indexOf('C-0002-a-setup.txt') > card.indexOf('<details class="files">'), 'setup output, with its password, only under All files');
  assert.doesNotMatch(html, /scenarios|fail-note|Failed: the app does not do this today/);
  assert.match(html, /id="C-0004"[\s\S]*?<p class="why">Not tested: needs a setup command that moves the clock\.<\/p>/);
});

test('the page names what it tested on, marks unchecked files, and says what happens if nobody acts', async () => {
  const { request, step, proof } = grown(project());
  put(step, { 'bugs/BUG-001-a/network.txt': 'x' });
  writeResult(step, { claims: [], bugs: [], problems: ['bugs/BUG-001-a/network.txt: not in evidence.jsonl'], subject: { commit: 'abc1234', env: 'http://localhost:4173' } });
  put(step, { 'bugs/BUG-002-b/bug.json': bug('BUG-002', { fix: { status: 'needs-decision', summary: 's', decision: 'Change it?', inProduction: true } }) });
  writeResult(step, { claims: [], bugs: [], problems: ['bugs/BUG-001-a/network.txt: not in evidence.jsonl'], subject: { commit: 'abc1234', env: 'http://localhost:4173' } });
  const html = pageHtml(await requestData(request));
  assert.match(html, /, on http:\/\/localhost:4173\.<\/p>/);
  assert.match(html, /<p class="meta" title="Code tested: abc1234">/, 'the commit once, on hover');
  assert.match(html, /network\.txt<\/a> <span class="muted">\(not checked: no tester logged this file, so nothing ties it to the test\)<\/span>/);
  assert.match(html, /Until you decide, it stays as it is\./);
  assert.match(html, /Already in the live app, so it doesn't block this release\./);
});

test('a fix record written into a bug.json later does not make the explore step\'s check stale', () => {
  const { step } = explore(project());
  writeResult(step, { x: 1 });
  const later = new Date(Date.now() + 5000);
  writeFileSync(join(step, 'bugs', 'BUG-001-a', 'bug.json'), JSON.stringify(bug('BUG-001', { fix: { status: 'fixed' } })));
  utimesSync(join(step, 'bugs', 'BUG-001-a', 'bug.json'), later, later);
  assert.deepEqual(readResult(step), { x: 1 });
  utimesSync(join(step, 'bugs', 'BUG-001-a', 'found.png'), later, later);
  assert.equal(readResult(step), null);
});

test('a calm page for whoever fixes: open questions are named, idle rows carry no state chip, production bugs say so on the row', async () => {
  const { request, step } = explore(project());
  put(step, { 'charters/T1.jsonl': `${JSON.stringify({ result: 'question', note: 'Per org or per owner?' })}\n` });
  let html = pageHtml(await requestData(request));
  assert.match(html, /<li><a href="#decisions">Answer 1 question<\/a><\/li>/);
  assert.doesNotMatch(html, /nothing needs you/);
  assert.doesNotMatch(html, /class="state[^"]*">Fix not requested/);
  assert.match(html, /class="cell idle/, 'a bug with no fix requested is an idle cell in the strip');
  const { request: grownRequest, step: s2 } = grown(project());
  put(s2, { 'bugs/BUG-002-b/bug.json': bug('BUG-002', { fix: { status: 'needs-decision', summary: 'Old copy', inProduction: true } }) });
  html = pageHtml(await requestData(grownRequest));
  assert.match(html, /<summary>[\s\S]*?already live[\s\S]*?<\/summary>/);
  assert.match(html, /<p class="ships">Already in the live app, so it doesn't block this release\.<\/p>/, 'said in words where a skimmer looks, not only in a chip');
});

import * as R from '../../skills/show-your-work/scripts/report.mjs';
import { execFileSync as run } from 'node:child_process';
import { existsSync as exists, renameSync as mv, rmSync as rm } from 'node:fs';
import { dirname as up } from 'node:path';
import { fileURLToPath as pathOf } from 'node:url';
const folderScript = pathOf(new URL('../../skills/show-your-work/scripts/run-folder.mjs', import.meta.url));

test('review C1: a broken rounds.json or fix-claims.json is a note naming the file, never a crash', async () => {
  const p = project();
  const { request } = explore(p, 'other');
  const { fix, proof } = grown(p);
  put(fix, { 'rounds.json': '{"rounds":[' });
  put(proof, { 'fix-claims.json': '{}' });
  await R.requestData(request);
  const d = await R.requestData(up(fix));
  assert.ok(d.problems.some((x) => /rounds\.json/.test(x)), d.problems.join('\n'));
  assert.ok(d.problems.some((x) => /fix-claims\.json/.test(x)), d.problems.join('\n'));
});

test('review I1: the first page a new request gets is live, and Done is not done', () => {
  const p = project();
  const out = run('node', [folderScript, p, 'invites', 'explore', 'explore'], { encoding: 'utf8' });
  const html = readFileSync(join(out.match(/^Request folder: (.*)$/m)[1], 'report.html'), 'utf8');
  assert.match(html, /http-equiv="refresh"/);
  assert.doesNotMatch(html, /class="done">Done/);
});

test('review I2: taking the lock, or a stale one, rewrites the old request page as finished', () => {
  const p = project();
  const first = run('node', [folderScript, p, 'invites', 'explore', 'explore'], { encoding: 'utf8' }).match(/^Request folder: (.*)$/m)[1];
  run('node', [folderScript, p, 'billing', 'prove', 'proof', '--take-lock']);
  assert.doesNotMatch(readFileSync(join(first, 'report.html'), 'utf8'), /http-equiv="refresh"/);
  assert.equal(JSON.parse(readFileSync(join(first, 'summary.json'), 'utf8')).live, false);
});

test('review I2a: deleting or renaming a file after the check makes the step unchecked', () => {
  const step = mkdtempSync(join(tmpdir(), 'step-'));
  put(step, { 'evidence/a.txt': 'a', 'evidence/b.txt': 'b', 'sessions/S1.jsonl': '{}\n' });
  writeResult(step, { x: 1 });
  assert.deepEqual(readResult(step), { x: 1 });
  rm(join(step, 'evidence/a.txt'));
  assert.equal(readResult(step), null);
  writeResult(step, { x: 2 });
  mv(join(step, 'sessions/S1.jsonl'), join(step, 'sessions/S1.bak'));
  assert.equal(readResult(step), null);
});

test('review I3: a later re-proof that fails the fix claim wins over the first proof', async () => {
  const { request } = grown(project());
  const proof2 = newStep(request, 'proof-2');
  put(proof2, { 'claims.json': { claims: [{ id: 'C-0001', statement: 'It works', cases: [] }] } });
  writeResult(proof2, { claims: [{ id: 'C-0001', statement: 'It works', verdict: 'disproved', cases: [], evidence: [] }], problems: [] });
  const d = await R.requestData(request);
  assert.equal(d.bugs[0].state, 'Fix did not hold');
  assert.ok(d.bugs[0].needsYou);
});

test('review I4: the page flags what the fix summary flags: risky, production-changing, security and unproven fixes', async () => {
  const { request, step } = grown(project());
  put(step, { 'bugs/BUG-001-a/bug.json': bug('BUG-001', { fix: { status: 'fixed', summary: 'Refuse it', risk: 'medium', patch: 'fixes/1-BUG-001.patch' } }) });
  assert.ok((await R.requestData(request)).bugs[0].needsYou);
  put(step, { 'bugs/BUG-001-a/bug.json': bug('BUG-001', { fix: { status: 'fixed', summary: 'Refuse it', risk: 'low', inProduction: true } }) });
  assert.ok((await R.requestData(request)).bugs[0].needsYou);
  put(step, { 'bugs/BUG-001-a/bug.json': bug('BUG-001', { kind: 'security', fix: { status: 'fixed', summary: 'Refuse it', risk: 'low' } }) });
  assert.ok((await R.requestData(request)).bugs[0].needsYou);
  put(step, { 'bugs/BUG-001-a/bug.json': bug('BUG-001', { fix: { status: 'fixed', summary: 'Refuse it', risk: 'low' } }) });
  assert.equal((await R.requestData(request)).bugs[0].needsYou, false);
});

test('review I6: a leftover temp file from another writer does not stop the page', async () => {
  const { request } = explore(project());
  mkdirSync(join(request, 'report.html.tmp'));
  await R.writeReport(request);
  assert.ok(exists(join(request, 'report.html')));
});

test('a bug opens short: your call and how to reproduce it, with the cause, the change and the files folded under Details', async () => {
  const html = pageHtml(await R.requestData(grown(project()).request));
  const card = html.match(/<details class="bug [^"]*" id="BUG-002"[\s\S]*?<\/div><\/details>/)[0];
  const at = (s) => card.indexOf(s);
  assert.ok(at('<div class="ask asks"><b>Your call</b>') > 0 && at('<div class="ask asks">') < at('<summary>How it happens</summary>') && at('<summary>How it happens</summary>') < at('<details class="more"><summary>Details</summary>'));
  assert.ok(at('<details class="more">') < at('<h4>What was changed</h4>') && at('<details class="more">') < at('full bug record'), 'the rest is folded');
  assert.doesNotMatch(html, /What users get|What happened|class="story"/, 'the trail on the row already tells what happened');
  assert.doesNotMatch(html, /For the tester|For the developer|For product/);
  const fixed = html.match(/<details class="bug [^"]*" id="BUG-001"[\s\S]*?<\/div><\/details>/)[0];
  assert.match(fixed, /<p>Its test: <a href="#C-0001">C-0001<\/a>\.<\/p>/, 'the proof of a fix is named on its bug');
  assert.match(html, /@media \(max-width:640px\)\{[^\n]*\.repro \.shot\{order:3\}\.shot img,\.shot video\{height:160px;width:auto;max-width:100%\}/, 'on a phone the screenshot is a thumbnail after the steps');
});

test('a new bug says shipping would add it, until its fix is proven', async () => {
  const { request, step } = grown(project());
  put(step, { 'bugs/BUG-002-b/bug.json': bug('BUG-002', { fix: { status: 'needs-decision', summary: 'Asks you', decision: 'Change it?', inProduction: false } }),
    'bugs/BUG-001-a/bug.json': bug('BUG-001', { fix: { status: 'fixed', summary: 'Refuse it', risk: 'low', patch: 'fixes/1-BUG-001.patch', inProduction: false } }) });
  const html = pageHtml(await R.requestData(request));
  assert.match(html.match(/id="BUG-002"[\s\S]*?<\/div><\/details>/)[0], /<p class="ships">New in this change: shipping now would add it\.<\/p>/);
  assert.doesNotMatch(html.match(/id="BUG-001"[\s\S]*?<\/div><\/details>/)[0], /New on this branch/);
});

const hhmm = (t) => new Date(t).toTimeString().slice(0, 5);
const timedRun = () => {
  const t0 = new Date(Date.now() - 3600e3); t0.setSeconds(0, 0);
  const { request, step, fix, proof } = grown(project(), { when: t0 });
  const found = t0.getTime() + 5 * 60e3; const proved = t0.getTime() + 30 * 60e3;
  put(step, { 'evidence.jsonl': `${JSON.stringify({ bug: 'BUG-001', file: 'bugs/BUG-001-a/found.png', at: new Date(found).toISOString() })}\n` });
  put(proof, { 'evidence.jsonl': `${JSON.stringify({ claim: 'C-0001', case: 'a', file: 'evidence/C-0001-a.png', at: new Date(proved).toISOString() })}\n` });
  writeResult(proof, { claims: [{ id: 'C-0001', statement: 'It works', verdict: 'proven', cases: [], evidence: [] }], problems: [] });
  writeResult(fix, { releaseNotes: { migrations: [], existingUsers: [] } });
  return { request, found, proved };
};

test("times: found at the first capture, fixed when the fix step finished, proven at the claim's last capture", async () => {
  const { request, found, proved } = timedRun();
  const d = await R.requestData(request);
  assert.equal(d.bugs[0].times.found, found);
  assert.equal(d.bugs[0].times.proof, proved);
  assert.ok(d.bugs[0].times.fixed >= proved);
  const explore = d.steps.find((s) => s.kind === 'explore');
  assert.equal(explore.start, found);
});

test('times: a time from before the request started, or a request dated in the future, is left out', async () => {
  const { request } = grown(project(), { when: new Date(Date.now() + 86400e3) });
  const d = await R.requestData(request);
  assert.ok(d.steps.every((s) => s.start === null && s.end === null));
  assert.equal(d.bugs[0].times.found, null);
});

test('the page leads with what needs you: a headline, your decisions, then the rest folded', async () => {
  const { request, found, proved } = timedRun();
  const html = pageHtml(await R.requestData(request));
  assert.match(html, /<h1[^>]*>1 decision waits for you before you ship\.<\/h1>/);
  assert.match(html, /id="decisions"[\s\S]*Title BUG-002/);
  assert.match(html, /<details class="group"><summary>[^<]*Fixed and verified/);
  assert.match(html, new RegExp(`found ${hhmm(found)}`));
  assert.match(html, new RegExp(`test passed ${hhmm(proved)}`));
  assert.match(html, /class="ribbon"/);
  assert.match(html, /Explore<\/b>/);
});

test('times: a step with no end of its own ends where the next step starts', async () => {
  const { request } = timedRun();
  const fixDir = join(request, 'fix');
  rm(join(fixDir, 'result.json'));
  const d = await R.requestData(request);
  const [fix, proof] = ['fix', 'proof'].map((k) => d.steps.find((s) => s.kind === k));
  assert.equal(fix.end, proof.start);
});

test('times: a bug with no log line was found when its folder was made', async () => {
  const { request } = explore(project(), 'invites', new Date(Date.now() - 3600e3));
  const d = await R.requestData(request);
  assert.ok(d.bugs[1].times.found, 'BUG-002 has no evidence, yet a found time');
});

test('a missing change file is named by its path from the request folder', async () => {
  const { request, fix } = grown(project());
  rm(join(fix, 'fixes', '1-BUG-001.patch'));
  assert.match(pageHtml(await R.requestData(request)), /the change file the record names, <code>fix\/fixes\/1-BUG-001\.patch<\/code>, is missing/);
});


test('what was asked reads as plain text, its headings without # marks', async () => {
  const html = pageHtml(await R.requestData(explore(project()).request));
  assert.match(html, /What was asked<\/summary><p class="brief"><b>Request<\/b>\nexplore invites<\/p>/);
});

test('the page says what was tested beside what was not, and which step each comes from', async () => {
  const { request, step } = explore(project());
  put(step, { 'charters.json': { charters: [{ id: 'T1', mission: 'Explore invites as an owner', notCovered: 'Password reset emails' }] } });
  const html = pageHtml(await R.requestData(request));
  assert.match(html, /<dt>Tested<\/dt><dd><ul><li>Explore invites as an owner <span class="muted">\(while exploring\)<\/span><\/li>/);
  assert.match(html, /<dt>Not tested<\/dt><dd><ul><li>Password reset emails <span class="muted">\(while exploring\)<\/span><\/li>/);
});

test('the page lists a part of the feature no charter aimed at, with why, under Not tested', async () => {
  const { request, step } = explore(project());
  put(step, { 'charters.json': { charters: [{ id: 'T1', mission: 'Explore invites as an owner' }], untested: ['Paid-plan page: needs an org on a paid plan; no setup command makes one'] } });
  const html = pageHtml(await R.requestData(request));
  assert.match(html, /<dt>Not tested<\/dt><dd><ul><li>Paid-plan page: needs an org on a paid plan; no setup command makes one <span class="muted">\(while exploring\)/);
});


test('the header counts once: no second line of counters and no legend repeating the numbers', async () => {
  const html = pageHtml(await R.requestData(grown(project()).request));
  assert.doesNotMatch(html, /<p class="counts">|<p class="key">/);
  assert.doesNotMatch(html, /prefers-color-scheme|light dark/, 'light only');
});

import { indexHtml as indexOf } from '../../skills/show-your-work/scripts/build-proof.mjs';

test('expert review: each step in the timeline shows its clock times; the commit shows once, in the meta line', async () => {
  const { request, found } = timedRun();
  put(join(request, 'explore'), { 'evidence.jsonl': `${JSON.stringify({ bug: 'BUG-001', file: 'bugs/BUG-001-a/found.png', commit: 'abc1234', env: 'local', at: new Date(found).toISOString() })}\n` });
  const html = pageHtml(await R.requestData(request));
  const explore = html.match(/<li class="band[^"]*"[^>]*><b>Explore<\/b>[\s\S]*?<\/li>/)[0];
  assert.match(explore, new RegExp(`${hhmm(found)}–`));
  assert.doesNotMatch(explore, /abc1234/);
});

test('expert review: auto mode says what it decided, and a ruling shows why and the cost on their own lines', async () => {
  const { request } = grown(project());
  put(request, { 'decisions.md': 'Ruling: default: approved 5 claims as written — auto mode — a wrong claim proved\n' });
  const html = pageHtml(await R.requestData(request));
  assert.doesNotMatch(html, /not by a person/);
  assert.match(html, /1 choice made automatically, without you/);
  assert.match(html, /<li>Approved 5 claims as written<br><span class="muted">If that was wrong: a wrong claim proved<\/span><\/li>/);
});

test('a missing fact is left out', async () => {
  const { request } = grown(project());
  const html = pageHtml(await R.requestData(request));
  assert.doesNotMatch(html, /Not recorded by the fixer|<small>Cause<\/small>/, 'a fact nobody recorded is left out, not shown as missing');
});

test('gap BUG-015: a fix whose change file is missing and is not committed is its own state, and needs you', async () => {
  const { request, step } = grown(project());
  put(step, { 'bugs/BUG-001-a/bug.json': bug('BUG-001', { fix: { status: 'fixed', summary: 'Refuse it', risk: 'low', patch: 'fixes/gone.patch' } }) });
  const b = (await R.requestData(request)).bugs[0];
  assert.equal(b.state, 'Fix made, change missing');
  assert.ok(b.needsYou);
});

test('gap BUG-001: a finished request page links back to the index of requests', async () => {
  const { request } = explore(project());
  await R.writeReport(request);
  assert.match(readFileSync(join(request, 'report.html'), 'utf8'), /<a href="..\/..\/index.html">All requests<\/a>/);
});

test('gaps BUG-004 and BUG-019: the index shows questions apart from need-you, and colours each count by its state', () => {
  const html = indexOf('acme', [{ name: '2026-10-05-0900-explore-and-fix', feature: 'invites', kind: 'explore-and-fix', date: '2026-10-05', live: false, updatedAt: '2026-10-05T10:00:00Z',
    counts: { found: 3, fixed: 2, proven: 2, needsYou: 2, questions: 1 } }]);
  assert.match(html, /<span class="k good">2&nbsp;proven<\/span>/);
  assert.match(html, /<span class="chip">2 need you<\/span>/);
  assert.match(html, /<span class="k wait">1&nbsp;question<\/span>/);
});

test('bugs with the same id from two rounds get their own anchors, and the later one is labelled with its round', async () => {
  const { request } = grown(project());
  const second = newStep(request, 'explore-2', ['charters', 'evidence']);
  put(second, { 'charters.json': { charters: [] }, 'bugs/BUG-001-z/bug.json': bug('BUG-001') });
  const d = await R.requestData(request);
  const anchors = d.bugs.map((b) => b.anchor);
  assert.equal(new Set(anchors).size, anchors.length);
  const html = pageHtml(d);
  for (const a of anchors) assert.equal(html.split(`id="${a}"`).length, 2, `one row with id ${a}`);
  assert.match(html, /<span>BUG-001 \(round 2\)<\/span>/);
  assert.match(html, /<span class="id">BUG-001 \(round 2\)<\/span>/, 'the card shows the unique id too');
});

test("BUG-011: a question's possible answers show as the skill's suggestion, never as a decision", async () => {
  const { request, step } = explore(project());
  put(step, { 'charters/T1.jsonl': `${JSON.stringify({ result: 'question', note: 'Per org or per owner?', answers: ['Per org: one limit shared by every owner', 'Per owner: each owner gets the full limit'] })}\n${JSON.stringify({ result: 'question', note: 'Is 10 the limit?' })}\n` });
  const html = pageHtml(await requestData(request));
  assert.match(html, /<legend><code>Q-[0-9a-f]{4}<\/code> Per org or per owner\?<\/legend><p class="suggest">Suggested answers, not decided:<\/p><label class="pick"><input type="radio" name="Q-[0-9a-f]{4}" value="Per org: one limit shared by every owner"><span>Per org: one limit shared by every owner<\/span><\/label><label class="pick"><input type="radio" name="Q-[0-9a-f]{4}" value="Per owner: each owner gets the full limit">/);
  assert.match(html, /<legend><code>Q-[0-9a-f]{4}<\/code> Is 10 the limit\?<\/legend><input type="text" name="Q-[0-9a-f]{4}-own" placeholder="Your answer"/);
  assert.doesNotMatch(html, /<input type="radio"[^>]* checked/, 'nothing is picked for the person');
  assert.match(html, /<a href="#decisions">Answer 2 questions<\/a>/);
});

test('questions: the form copies one "answer <Q-id>: ..." line per answered question, own words before a pick', async () => {
  const { request, step } = explore(project());
  put(step, { 'charters/T1.jsonl': `${JSON.stringify({ n: 1, result: 'question', note: 'Per org or per owner?', answers: ['Per org', 'Per owner'] })}\n${JSON.stringify({ n: 2, result: 'question', note: 'Is 10 the limit?' })}\n${JSON.stringify({ n: 3, result: 'question', note: 'Count revoked?', answers: ['Yes', 'No'] })}\n` });
  const html = pageHtml(await requestData(request));
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  // A small stand-in for the page: three fieldsets, the first picked, the second written, the third left empty.
  const field = (id, own, picked) => ({ dataset: { line: `answer ${id}` }, own: { type: 'text', value: own }, radio: picked && { type: 'radio', checked: true, value: picked },
    querySelector(s) { return s === 'input[type=text]' ? this.own : s === 'input[type=radio]:checked' ? this.radio : null; }, querySelectorAll() { return this.radio ? [this.radio] : []; } });
  const qs = [field('Q-1111', '', 'Per org'), field('Q-2222', '  Yes, 10  ', null), field('Q-3333', '', null)];
  const els = { 'answer-lines': { value: '' }, 'copy-state': {}, 'copy-answers': { addEventListener() {} } };
  new Function('document', 'location', 'localStorage', 'navigator', script)({ getElementById: (id) => els[id], querySelectorAll: () => qs, addEventListener() {} }, { pathname: '/r' }, { getItem: () => null, setItem() {} }, {});
  assert.equal(els['answer-lines'].value, 'answer Q-1111: Per org\nanswer Q-2222: Yes, 10');
  assert.equal(html.match(/id="copy-answers"/g).length, 1);
  const none = explore(project());
  assert.doesNotMatch(pageHtml(await requestData(none.request)), /copy-answers/, 'a page with no open question has no answer bar');
});

test('a step folder made again after the run (a copy or a checkout) never shows a start after its end', async () => {
  const { request } = timedRun();
  const fix = join(request, readdirSync(request).find((n) => /fix/.test(n)));
  const doc = JSON.parse(readFileSync(join(fix, 'result.json'), 'utf8'));
  const ended = Date.now() - 50 * 60e3;
  writeFileSync(join(fix, 'result.json'), JSON.stringify({ ...doc, writtenAt: new Date(ended).toISOString() }));
  const s = (await R.requestData(request)).steps.find((x) => x.kind === 'fix');
  assert.equal(s.end, ended);
  assert.ok(s.start === null || s.start <= s.end, `start ${s.start} after end ${s.end}`);
});

test('review: auto choices fold into the banner, each with its step and a real reason, and the run notes never split the bug queue', async () => {
  const { request, step, proof } = grown(project());
  put(step, { 'bugs/BUG-002-b/bug.json': bug('BUG-002', { fix: { status: 'needs-decision', decision: 'Keep the limit?' } }), 'bugs/BUG-003-c/bug.json': bug('BUG-003', { fix: { status: 'needs-decision', decision: 'Keep the copy?' } }), 'charters/T1.jsonl': `${JSON.stringify({ result: 'question', note: 'Per org or per owner?' })}\n` });
  put(proof, { 'decisions.md': 'Ruling: default: approved 2 claims as written — auto mode — a wrong claim proved\nRuling: default: used Chrome — the only browser connected — another browser untested\n' });
  const html = pageHtml(await requestData(request));
  const banner = html.match(/<details class="banner">[\s\S]*?<\/details>/)[0];
  assert.match(banner, /<summary>2 choices made automatically, without you<\/summary>/);
  assert.match(banner, /<li>Approved 2 claims as written <span class="muted">\(while testing\)<\/span><br><span class="muted">If that was wrong: a wrong claim proved<\/span><\/li>/);
  assert.match(banner, /<li>Used Chrome <span class="muted">\(while testing\)<\/span><br><span class="muted">Why: the only browser connected<\/span>/);
  assert.ok(html.indexOf('id="decisions"') < html.indexOf('class="banner"'), 'run notes come after the decisions');
});

test("review: each card shows its bug id, and the page draws no position numbers that look like ids", async () => {
  const { request, step } = grown(project());
  put(step, { 'bugs/BUG-002-b/bug.json': bug('BUG-002', { fix: { status: 'needs-decision', decision: 'Keep it?' } }), 'bugs/BUG-003-c/bug.json': bug('BUG-003', { fix: { status: 'needs-decision', decision: 'Keep the copy?' } }) });
  const html = pageHtml(await requestData(request));
  for (const id of ['BUG-001', 'BUG-002', 'BUG-003']) assert.match(html, new RegExp(`<summary>\\s*<span class="head"><span class="title">[^<]*</span>\\s*<span class="id">${id}</span>`));
  assert.doesNotMatch(html, /content:"1"|counter\(q\)/);
});

test('review: the bug strip lists bugs in the order the page shows their cards, and every cell has a card', async () => {
  const { request, step } = grown(project());
  put(step, { 'bugs/BUG-002-b/bug.json': bug('BUG-002', { severity: 'minor', fix: { status: 'fixed', summary: 'Wrap it' } }), 'bugs/BUG-003-c/bug.json': bug('BUG-003', { severity: 'critical' }),
    'bugs/BUG-004-d/bug.json': bug('BUG-004', { severity: 'minor', fix: { status: 'something-new' } }) });
  const html = pageHtml(await requestData(request));
  const strip = [...html.match(/<div class="strip">[\s\S]*?<\/div>/)[0].matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
  const cards = [...html.matchAll(/<details class="bug (?!check)[^"]*" id="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(strip, cards);
});

test('past 20 bugs the strip draws small marks without labels, each still a link to its bug', async () => {
  const many = async (n) => {
    const { request, step } = explore(project());
    put(step, Object.fromEntries(Array.from({ length: n - 2 }, (_, i) => { const id = `BUG-${String(i + 3).padStart(3, '0')}`; return [`bugs/${id}-x/bug.json`, bug(id)]; })));
    return pageHtml(await requestData(request)).match(/<div class="strip[^"]*">[\s\S]*?<\/div>/)[0];
  };
  const marks = await many(21);
  assert.match(marks, /^<div class="strip marks">/);
  assert.equal(marks.match(/<a class="cell /g).length, 21);
  assert.match(marks, /<a class="cell idle" href="#BUG-001" title="BUG-001: Title BUG-001" aria-label="BUG-001: Title BUG-001"><\/a>/);
  assert.match(await many(20), /^<div class="strip"><a class="cell idle" href="#BUG-001" title="BUG-001: Title BUG-001"><span>BUG-001<\/span><\/a>/, 'up to 20, each says its id');
});

test('questions: the headline links to them, each says how to answer, and an answered one moves to your answers', async () => {
  const { request, step } = explore(project());
  put(step, { 'charters/T1.jsonl': `${JSON.stringify({ n: 2, result: 'question', note: 'Per org or per owner?' })}\n${JSON.stringify({ n: 5, result: 'question', note: 'Is 10 the limit?' })}\n` });
  const [q1, q2] = (await import('../../skills/show-your-work/scripts/questions.mjs')).stepQuestions(step);
  let html = pageHtml(await requestData(request));
  assert.match(html, /<h1[^>]*>2 decisions wait for you before you ship\.<\/h1>\n<ul class="parts"><li><a href="#decisions">Answer 2 questions<\/a><\/li><\/ul>/);
  assert.match(html, /<div class="ask asks question">/, 'each question is one of your decisions');
  assert.match(html, new RegExp(`or reply <code>answer ${q1.id}: your answer</code>`));
  put(join(request, '..'), { 'answers.jsonl': `${JSON.stringify({ id: q1.id, question: q1.note, answer: 'Per org', at: '2026-11-01T10:00:00Z' })}\n` });
  const d = await requestData(request);
  html = pageHtml(d);
  assert.equal(d.counts.questions, 1);
  assert.match(html, /<a href="#decisions">Answer 1 question<\/a>/);
  const asked = html.slice(html.indexOf('id="decisions"'), html.indexOf('Your answers'));
  assert.ok(asked.includes(q2.id) && !asked.includes(q1.id), 'only the open question waits');
  assert.match(html, new RegExp(`<dt>Your answers</dt><dd><ul><li><code>${q1.id}</code> Per org or per owner\\?<br>You said: <b>Per org</b></li></ul>`));
});

test("a fix's failed check sits in a group whose name does not promise proof", async () => {
  const { request } = grown(project());
  const html = pageHtml(await requestData(request));
  assert.doesNotMatch(html, /Checks that prove the fixes/);
  assert.match(html, /<summary>Tests of the fixes/);
});

test("a request page folds in its runs' learnings, each once, with who wrote it and its source", async () => {
  const { request, step } = grown(project());
  put(step, { 'learnings.jsonl': [{ by: 'planner', learning: 'Free plans stop at <10> invites.', source: 'src/plans.ts:12' }, { by: 'T1', learning: 'Revoked invites stay listed.', source: 'src/invites.ts:40' }].map((l) => JSON.stringify(l)).join('\n') + '\nnot json\n' });
  put(join(step, '..', 'explore-2'), { 'learnings.jsonl': `${JSON.stringify({ by: 'planner', learning: 'Free plans stop at <10> invites.', source: 'src/plans.ts:12' })}\n` });
  const html = pageHtml(await requestData(request));
  assert.match(html, /<details><summary>What the testers learned about the app \(2\)<\/summary><ul><li>Free plans stop at &#60;10&#62; invites\.<br><span class="muted">planner · src\/plans\.ts:12<\/span><\/li><li>Revoked invites stay listed\.<br><span class="muted">T1 · src\/invites\.ts:40<\/span><\/li><\/ul><\/details>/);
  const { request: bare } = explore(project());
  assert.doesNotMatch(pageHtml(await requestData(bare)), /Learnings from/);
});

test('each bug card says where the bug shows: web with its device, or API', async () => {
  const { request, step } = explore(project());
  put(step, { 'bugs/BUG-010-w/bug.json': bug('BUG-010', { viewport: 'mobile' }), 'bugs/BUG-011-a/bug.json': bug('BUG-011', { target: 'api', viewport: 'mobile' }),
    'bugs/BUG-013-n/bug.json': bug('BUG-013', { target: undefined }) });
  const html = pageHtml(await requestData(request));
  const head = (id) => html.match(new RegExp(`<span class="id">${id}</span>(<span class="where">[^<]*</span>)?`))[1] ?? '';
  assert.equal(head('BUG-010'), '<span class="where">Web · Phone</span>');
  assert.equal(head('BUG-011'), '<span class="where">API</span>', 'a device names only a web bug');
  assert.equal(head('BUG-013'), '', 'no target, no chip');
});

test('a proven fix that changes production or carries risk is named as one to review, in the answer and on its card', async () => {
  const { request, step } = grown(project());
  put(step, { 'bugs/BUG-001-a/bug.json': bug('BUG-001', { fix: { status: 'fixed', summary: 'Reload the list', risk: 'medium', riskReason: 'Visible on the Team page', inProduction: true, patch: 'fixes/1-BUG-001.patch' } }) });
  const d = await R.requestData(request);
  assert.deepEqual([d.bugs[0].state, d.bugs[0].needsYou], ['Fixed and proven', true]);
  const html = pageHtml(d);
  assert.match(html, /<ul class="parts"><li>Review 1 fix<\/li><li>Decide what to do with 1 bug<\/li><\/ul>/);
  assert.match(html, /Review this fix before you ship\. It changes what production does\. Medium risk \(visible on the Team page\)\./);
});

test('a decision box offers choices and copies a "decide <bug> of <step folder>: ..." line, with or without open questions', async () => {
  const p = project();
  const { request } = grown(p);
  const html = pageHtml(await requestData(request));
  const where = `${basename(p)}/invites/${basename(request)}/explore`;
  assert.match(html, new RegExp(`<fieldset data-line="decide BUG-002 of ${where}">`));
  assert.match(html, /<input type="radio" name="d-BUG-002" value="Yes, change it">[\s\S]*?<input type="radio" name="d-BUG-002" value="No, keep it as it is">/);
  assert.match(html, /<button type="button" id="copy-answers">Copy answers<\/button>/);
  assert.match(html, /id="copy-answers"/, 'the answer script runs for decisions alone');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const field = (line, own, picked) => ({ dataset: { line }, own: { type: 'text', value: own }, radio: picked && { type: 'radio', checked: true, value: picked },
    querySelector(s) { return s === 'input[type=text]' ? this.own : s === 'input[type=radio]:checked' ? this.radio : null; }, querySelectorAll() { return this.radio ? [this.radio] : []; } });
  const qs = [field('answer Q-1111', '', 'Per org'), field(`decide BUG-002 of ${where}`, '', 'Yes, change it'), field('decide BUG-003 of x', '', null)];
  const els = { 'answer-lines': { value: '' }, 'copy-state': {}, 'copy-answers': { addEventListener() {} } };
  new Function('document', 'location', 'localStorage', 'navigator', script)({ getElementById: (id) => els[id], querySelectorAll: () => qs, addEventListener() {} }, { pathname: '/r' }, { getItem: () => null, setItem() {} }, {});
  assert.equal(els['answer-lines'].value, `answer Q-1111: Per org\ndecide BUG-002 of ${where}: Yes, change it`);
});

test('a proven fix to review offers Ship it or Undo the fix; a decided bug shows your words and stops needing you', async () => {
  const { request, step } = grown(project());
  put(step, { 'bugs/BUG-001-a/bug.json': bug('BUG-001', { fix: { status: 'fixed', summary: 'Reload', risk: 'medium', patch: 'fixes/1-BUG-001.patch' } }) });
  let html = pageHtml(await requestData(request));
  assert.match(html, /name="d-BUG-001" value="Ship it">[\s\S]*?name="d-BUG-001" value="Undo the fix">/);
  put(step, { 'bugs/BUG-001-a/bug.json': bug('BUG-001', { fix: { status: 'fixed', summary: 'Reload', risk: 'medium', patch: 'fixes/1-BUG-001.patch', decided: 'Ship it' } }),
    'bugs/BUG-002-b/bug.json': bug('BUG-002', { fix: { status: 'wont-fix', summary: 'Asks you', decision: 'Change it?', decided: 'No, keep it as it is' } }) });
  const d = await requestData(request);
  assert.deepEqual(d.bugs.map((b) => b.needsYou), [false, false]);
  html = pageHtml(d);
  assert.doesNotMatch(html, /data-line="decide/);
  assert.match(html, /You decided: <b>No, keep it as it is<\/b>/);
});

test('evidence and record files open in a new tab, so the page stays where you were', async () => {
  const { request } = grown(project());
  const html = pageHtml(await requestData(request));
  const files = [...html.matchAll(/<a href="([^"#][^"]*\.(?:json|png|patch|txt))"([^>]*)>/g)];
  assert.ok(files.some(([, href]) => href.endsWith('bug.json')) && files.some(([, href]) => href.endsWith('.png')));
  for (const [, href, rest] of files) assert.equal(rest, ' target="_blank" rel="noopener"', href);
});

test('a bug card shows its recording when it has one, else its screenshot', async () => {
  const { request, step } = explore(project());
  put(step, { 'bugs/BUG-001-a/repro.webm': 'webm' });
  const html = pageHtml(await requestData(request));
  const card = html.match(/<details class="bug [^"]*" id="BUG-001"[\s\S]*?<\/details>\n?<\/details>|<details class="bug [^"]*" id="BUG-001"[\s\S]*?<p class="foot">/)[0];
  assert.ok(card.indexOf('<video src="explore/bugs/BUG-001-a/repro.webm"') > -1 && card.indexOf('<video') < card.indexOf('found.png'), 'the recording comes first');
});

test('a check case shows the recording for a device when there is one, and the screenshot only where there is none', async () => {
  const request = newRequest(project(), 'billing', 'prove', new Date(2026, 10, 3, 14, 30));
  const proof = newStep(request, 'proof');
  put(proof, { 'claims.json': { claims: [] } });
  const ev = (file, viewport) => ({ claim: 'C-0002', case: 'a', file: `evidence/${file}`, role: 'picture', note: file, viewport });
  writeResult(proof, { claims: [{ id: 'C-0002', statement: 'B', verdict: 'proven', cases: [{ id: 'a', result: 'pass', do: 'Do it', expect: 'Done' }],
    evidence: [ev('C-0002-a-desktop.png', 'desktop'), ev('C-0002-a-desktop.webm', 'desktop'), ev('C-0002-a-mobile.png', 'mobile')] }], problems: [] });
  const html = pageHtml(await requestData(request));
  const figures = [...html.matchAll(/<figure class="ev">(<video src|<a href)="proof\/evidence\/([^"]+)"/g)].map((m) => m[2]);
  assert.deepEqual(figures, ['C-0002-a-desktop.webm', 'C-0002-a-mobile.png']);
});

test('a bug a later round found again is counted once: the first card says where it was found again', async () => {
  const { request } = grown(project());
  const second = newStep(request, 'explore-2', ['charters', 'evidence']);
  put(second, { 'charters.json': { charters: [] }, 'bugs/BUG-001-z/bug.json': bug('BUG-001', { fix: { status: 'needs-decision', summary: 'Same as round 1 BUG-002', decision: 'Change it?' } }) });
  const d = await requestData(request);
  assert.deepEqual([d.counts.found, d.counts.needsYou, d.bugs.length], [2, 1, 2]);
  assert.deepEqual(d.bugs.map((b) => [b.id, b.round, b.again?.map((a) => [a.id, a.round])]), [['BUG-001', 1, undefined], ['BUG-002', 1, [['BUG-001', 2]]]]);
  // Each card names the rounds that found its bug, in its head and, when found again, with each round's bug id.
  const html = pageHtml(d);
  const card = (id) => html.match(new RegExp(`<details class="bug [^"]*" id="${id}"[\\s\\S]*?</details>\\n</div></details>`))[0];
  assert.doesNotMatch(html, /class="round"/, 'the unique id and the found-again line say the round');
  assert.match(card('BUG-002'), /Found in round 1 as BUG-002, and again in round 2 as BUG-001\./);
  // Two testers of one round can find it too: the head names each round once.
  put(request, { 'explore/bugs/BUG-003-c/bug.json': bug('BUG-003', { fix: { status: 'needs-decision', summary: 'Same as round 1 BUG-002', decision: 'Change it?' } }) });
  assert.match(pageHtml(await requestData(request)), /Found in round 1 as BUG-002, and again in round 1 as BUG-003 and round 2 as BUG-001\./);
  // A repeat whose first bug is not on this page still shows.
  put(second, { 'bugs/BUG-001-z/bug.json': bug('BUG-001', { fix: { status: 'needs-decision', summary: 'Same as round 4 BUG-009', decision: 'Change it?' } }) });
  assert.equal((await requestData(request)).counts.found, 3);
});

test('a proven fix auto mode or gap mode chose at low or medium risk does not wait on you: the page names the choice and offers to undo it', async () => {
  const { request, step } = grown(project());
  const put1 = (fix, kind) => put(step, { 'bugs/BUG-001-a/bug.json': bug('BUG-001', { kind, fix: { status: 'fixed', summary: 'Refuse other orgs', risk: 'medium', inProduction: true, patch: 'fixes/1-BUG-001.patch', ...fix } }) });
  put1({ source: 'auto: refuse ids of other orgs with 404' });
  const d = await requestData(request);
  assert.equal(d.bugs[0].needsYou, false);
  const html = pageHtml(d);
  assert.match(html, /1 choice made automatically, without you/);
  assert.match(html, /<a href="#BUG-001">BUG-001<\/a>: refuse ids of other orgs with 404/);
  assert.match(html, /Decided automatically: <b>refuse ids of other orgs with 404<\/b>/);
  assert.match(html, /name="d-BUG-001" value="Undo the fix">/);
  put1({ source: 'gap: an empty-list message' });
  assert.equal((await requestData(request)).bugs[0].needsYou, false);
  assert.match(pageHtml(await requestData(request)), /Added as a missing feature: <b>an empty-list message<\/b>/);
  // At high risk, as a security fix, or before it is proven, it still waits for you.
  put1({ source: 'auto: refuse ids of other orgs', risk: 'high' });
  assert.equal((await requestData(request)).bugs[0].needsYou, true);
  put1({ source: 'auto: refuse ids of other orgs' }, 'security');
  assert.equal((await requestData(request)).bugs[0].needsYou, true);
});

test('a report card is labelled with its target\'s label, and shows a device only for a target with viewports', async () => {
  const { request, step } = explore(project());
  put(step, { 'targets.json': { targets: { queue: { label: 'Queue', provenBy: 'file', viewports: false, found: [] } } }, 'bugs/BUG-020-q/bug.json': bug('BUG-020', { target: 'queue', viewport: 'mobile' }) });
  const html = pageHtml(await requestData(request));
  assert.match(html, /<span class="id">BUG-020<\/span><span class="where">Queue<\/span>/);
});

test('a failed or unproven check of its own gets an answer box; a decided one shows the decision and no longer needs you', async () => {
  const p = project();
  const request = newRequest(p, 'billing', 'prove', new Date(2026, 10, 3, 14, 30));
  const proof = newStep(request, 'proof');
  put(proof, { 'claims.json': { claims: [] } });
  writeResult(proof, { claims: [
    { id: 'C-0002', statement: 'B', verdict: 'disproved', cases: [{ id: 'a', result: 'fail', actual: 'No.' }], evidence: [] },
    { id: 'C-0003', statement: 'C', verdict: 'not-proven', cases: [{ id: 'a', result: 'blocked' }], evidence: [] }], problems: [] });
  const at = `billing/${basename(request)}/proof`;
  let html = pageHtml(await requestData(request));
  assert.match(html, new RegExp(`data-line="decide C-0002 of [^"]*${at}"`));
  assert.match(html, /value="Fix the app"[\s\S]*value="Test again"[\s\S]*value="Drop this test"/);
  const c3 = html.slice(html.indexOf('id="C-0003"'));
  assert.match(c3, /data-line="decide C-0003 of /);
  assert.doesNotMatch(c3.slice(0, c3.indexOf('</details>\n')), /value="Fix the app"/, 'nothing failed, so nothing to fix yet');
  writeFileSync(join(p, 'billing', 'answers.jsonl'), `${JSON.stringify({ id: `${basename(request)}/proof/C-0002`, answer: 'Leave it as it is' })}\n`);
  const data = await requestData(request);
  assert.equal(data.counts.needsYou, 1);
  html = pageHtml(data);
  assert.match(html, /You decided: <b>Leave it as it is<\/b>/);
  assert.doesNotMatch(html, /data-line="decide C-0002 of /);
});

test('every bug that waits on you can be answered: a fix whose proof never finished, and a kept bug with no question', async () => {
  const { request, step } = explore(project());
  put(step, { 'bugs/BUG-001-a/bug.json': bug('BUG-001', { fix: { status: 'fixed', summary: 'Fixed', risk: 'low' } }),
    'bugs/BUG-002-b/bug.json': bug('BUG-002', { fix: { status: 'wont-fix', summary: 'Kept' } }) });
  const html = pageHtml(await requestData(request));
  const card = (id) => html.slice(html.indexOf(`id="${id}"`), html.indexOf('</details>\n', html.indexOf(`id="${id}"`)));
  assert.match(card('BUG-001'), /data-line="decide BUG-001 of [^"]+"[\s\S]*value="Test again"[\s\S]*value="Ship it"[\s\S]*value="Undo the fix"/);
  assert.match(card('BUG-002'), /It was left as it is\. Fix it anyway, or leave it\?[\s\S]*value="Fix it anyway"/);
});

test('a check proven again in a later step shows once, with its latest verdict', async () => {
  const p = project();
  const request = newRequest(p, 'billing', 'prove', new Date(2026, 10, 3, 14, 30));
  const one = newStep(request, 'proof');
  put(one, { 'claims.json': { claims: [] } });
  writeResult(one, { claims: [{ id: 'C-0002', statement: 'B', verdict: 'disproved', cases: [], evidence: [] }], problems: [] });
  const two = newStep(request, 'proof');
  put(two, { 'claims.json': { claims: [] } });
  writeResult(two, { claims: [{ id: 'C-0002', statement: 'B', verdict: 'proven', cases: [], evidence: [] }], problems: [] });
  const data = await requestData(request);
  assert.deepEqual([data.counts.checks, data.counts.checksProven, data.counts.needsYou], [1, 1, 0]);
});

test('a finished report says Not run for a check no proof finished, never Being checked', async () => {
  const p = project();
  const request = newRequest(p, 'billing', 'prove', new Date(2026, 10, 3, 14, 30));
  const proof = newStep(request, 'proof');
  put(proof, { 'claims.json': { claims: [{ id: 'C-0009', statement: 'Z', cases: [{ id: 'a', do: 'Do it', expect: 'It works' }] }] } });
  const data = await requestData(request);
  assert.equal(data.live, false);
  assert.equal(data.promises[0].verdict, 'not-run');
  assert.doesNotMatch(pageHtml(data), /Being checked/);
});

test('a fix you asked for asks again once it is made: an old decision never hides the new question', async () => {
  const { request, step } = grown(project(), { checked: false });
  put(step, { 'bugs/BUG-001-a/bug.json': bug('BUG-001', { fix: { status: 'fixed', summary: 'Refuse it', risk: 'high', decided: 'Yes, change it', patch: 'fixes/1-BUG-001.patch' } }) });
  const html = pageHtml(await requestData(request));
  const card = html.slice(html.indexOf('id="BUG-001"'), html.indexOf('</details>\n', html.indexOf('id="BUG-001"')));
  assert.match(card, /data-line="decide BUG-001 of [^"]+"[\s\S]*value="Ship it"/);
  assert.doesNotMatch(card, /You decided/);
  assert.doesNotMatch(card, /<p><\/p>/);
});

test('plain reading: a long note folds after its first sentence, a question comes before its source, and lists say each thing once', async () => {
  const { request, step } = explore(project());
  put(step, { 'charters/T1.jsonl': `${JSON.stringify({ result: 'question', note: 'Owner decision docs/spec.md:105: the invoice keeps the old address. Resend it as it is?' })}\n`,
    'charters.json': { untested: ['Google Calendar: no account', 'Google Calendar: no account'], charters: [{ id: 'N1', mission: 'M', notCovered: 'not run: batch full' }, { id: 'P1', mission: 'M2', notCovered: 'Legacy checkout' }] } });
  const html = pageHtml(await requestData(request));
  assert.match(html, /<legend><code>Q-[0-9a-f]{4}<\/code> The invoice keeps the old address\. Resend it as it is\? <span class="muted">\(docs\/spec\.md:105\)<\/span><\/legend>/);
  const notTested = html.slice(html.indexOf('<dt>Not tested</dt>'));
  assert.equal(notTested.split('Google Calendar: no account').length, 2, 'once');
  assert.doesNotMatch(notTested, /batch full|P1: /);
  assert.match(notTested, /<li>Legacy checkout /);
  const long = `Needs a store using the built-in default template; this store has custom defaults. ${'QA Quote Branded, '.repeat(8)}and more.`;
  const p = project();
  const req = newRequest(p, 'billing', 'prove', new Date(2026, 10, 3, 14, 30));
  const proof = newStep(req, 'proof');
  put(proof, { 'claims.json': { claims: [] } });
  writeResult(proof, { claims: [{ id: 'C-0003', statement: 'C', verdict: 'not-proven', cases: [{ id: 'a', result: 'blocked', note: long }], evidence: [] }], problems: [] });
  assert.match(pageHtml(await requestData(req)), /Why it could not run: Needs a store using the built-in default template; <details class="more-note"><summary>More<\/summary>this store has custom defaults/);
});

test('the timeline runs in time order: a fix undone after its proof passed reads found, proof passed, fix undone', async () => {
  const { request, found, proved } = timedRun();
  const html = pageHtml(await R.requestData(request));
  for (const t of html.match(/<span class="trail">[\s\S]*?<\/span><\/summary>/g) ?? []) {
    const times = [...t.matchAll(/(\d\d:\d\d)/g)].map((m) => m[1]);
    assert.deepEqual(times, [...times].sort(), t);
  }
  assert.ok(found && proved);
});

test('a fix undone because its test still failed, or because it broke another, asks in plain words, the way its buttons answer', async () => {
  const { request, step } = grown(project());
  put(step, { 'bugs/BUG-002-b/bug.json': bug('BUG-002', { fix: { status: 'not-fixed', summary: 'Fixed with BUG-008', decision: 'The fix did not hold: Where the selected country is Canada, checkout asks for a province. Fix by hand?' } }) });
  const html = pageHtml(await requestData(request));
  assert.match(html, /The fix didn&#39;t work: its test still fails \(&#34;Where the selected country is Canada, checkout asks for a province&#34;\)\. Try again, or leave it\?/);
  assert.doesNotMatch(html, /Fix by hand\?/);
  put(step, { 'bugs/BUG-002-b/bug.json': bug('BUG-002', { fix: { status: 'not-fixed', summary: 'x', decision: 'Broke The invite list shows 10 rows. Fix by hand?' } }) });
  assert.match(pageHtml(await requestData(request)), /The fix broke something else, so it was undone: &#34;The invite list shows 10 rows&#34;\. Try the fix again, or leave it\?/);
});

test('your decisions open on what blocks shipping: a bug new on this branch before a worse-looking one already in production', async () => {
  const { request, step } = grown(project());
  put(step, { 'bugs/BUG-001-a/bug.json': bug('BUG-001', { severity: 'minor', fix: { status: 'not-fixed', summary: 'x', inProduction: true, decision: 'The fix did not hold: A. Fix by hand?' } }),
    'bugs/BUG-002-b/bug.json': bug('BUG-002', { severity: 'minor', fix: { status: 'needs-decision', summary: 'y', inProduction: false, decision: 'Change it?' } }) });
  const html = pageHtml(await requestData(request));
  assert.match(html.slice(html.indexOf('id="decisions"')), /^[^]*?id="BUG-002"/);
});

test('a finished run with nothing to decide says it is ready to ship; the stage bar moves to the footer', async () => {
  const { request } = grown(project());
  const p = dirname(dirname(request));
  put(join(request, 'explore'), { 'bugs/BUG-002-b/bug.json': bug('BUG-002') });
  const html = pageHtml(await requestData(request));
  assert.match(html, /<h1 class="good">Ready to ship: nothing needs you\.<\/h1>/);
  assert.match(html, /<summary>How long each stage took<\/summary><ol class="ribbon">/);
  assert.ok(p);
});

test('a filter shows only some cards: by what you do with them, and by kind when there is more than one', async () => {
  const { request, step } = grown(project());
  put(step, { 'bugs/BUG-003-c/bug.json': bug('BUG-003', { kind: 'copy' }) });
  const html = pageHtml(await requestData(request));
  const bar = html.match(/<nav class="filter"[\s\S]*?<\/nav>/)[0];
  // Your decisions are above, one at a time: the filter covers everything else.
  assert.match(bar, /data-v="all" aria-pressed="true">All <span class="n">3<\/span>/);
  assert.doesNotMatch(bar, /Needs you/);
  assert.match(bar, /data-v="fixed"[^>]*>Fixed <span class="n">1<\/span>/);
  assert.match(bar, /Kind:[\s\S]*data-v="copy"[^>]*>Wording <span class="n">1<\/span>/);
  assert.match(html, /id="BUG-003" data-status="work" data-kind="copy"/);
  assert.match(html, /<script>[\s\S]*sessionStorage[\s\S]*dataset\.status[\s\S]*<\/script>/);
});

test('a short list of real decisions: the tool’s unfinished work is one retest, a bug left as it is is optional, and they show one at a time', async () => {
  const p = project();
  const request = newRequest(p, 'billing', 'prove', new Date(2026, 10, 3, 14, 30));
  const proof = newStep(request, 'proof');
  put(proof, { 'claims.json': { claims: [] } });
  writeResult(proof, { claims: [
    { id: 'C-0001', statement: 'A', verdict: 'disproved', cases: [{ id: 'a', result: 'fail' }], evidence: [] },
    { id: 'C-0002', statement: 'B', verdict: 'not-proven', cases: [{ id: 'a', result: 'blocked', note: 'needs setup: a lapsed plan' }], evidence: [] },
    { id: 'C-0003', statement: 'C', verdict: 'not-proven', cases: [{ id: 'a', result: 'blocked' }], evidence: [] }], problems: [] });
  const d = await requestData(request);
  assert.equal(d.counts.needsYou, 2, 'one failed test and one retest for both tests that could not run');
  const html = pageHtml(d);
  assert.match(html, /<h1[^>]*>2 decisions wait for you before you ship\.<\/h1>/);
  // The chat says what the page says, in the same words and counts.
  assert.deepEqual(await headline(request), ['2 decisions wait for you before you ship.', '- Fix, retest or drop 1 failed test', "- Test again the 2 things that couldn't be checked (one click)"]);
  assert.match(html, /<fieldset data-line="retest" data-lines="decide C-0002 of [^"]+\ndecide C-0003 of [^"]+">/);
  assert.match(html, /Test all 2 again/);
  assert.match(html, /<p class="progress" hidden>Decision <b class="at">1<\/b> of 2<\/p>/);
  const todo = html.match(/<ol class="todo">([\s\S]*?)<\/ol>\n<p class="step-nav"/)[1];
  assert.equal(todo.split(/\n<li[ >]/).length + (todo.startsWith('<li') ? 0 : -1), 2, 'one list item per decision, whatever lists the cards hold');
  assert.match(html, /<script>[\s\S]*Next decision[\s\S]*Show all at once[\s\S]*<\/script>/);
  // Each test that could not run keeps its own optional box under Everything else.
  assert.match(html, /<summary>Couldn&#39;t run <span class="n">2<\/span><\/summary>/);
  assert.match(html.slice(html.indexOf('class="rest"')), /data-line="decide C-0002 of [^"]+" data-optional/);

  // A bug auto mode left as it is is optional: it is out of the count, and the headline says you can still ask for a fix.
  const { request: r2, step } = grown(project());
  put(step, { 'bugs/BUG-002-b/bug.json': bug('BUG-002', { fix: { status: 'wont-fix', summary: 'Kept', decision: 'Change it?' } }) });
  const d2 = await requestData(r2);
  assert.equal(d2.counts.needsYou, 0);
  const html2 = pageHtml(d2);
  assert.match(html2, /<p class="later">Optional: 1 bug was left as it is; you can still ask for a fix\.<\/p>/);
});

test('every bug offers Not a bug, with your words as its reason; a bug you called not a bug sits in its own group with the reason', async () => {
  const { request, step } = grown(project());
  let html = pageHtml(await requestData(request));
  const card = (h, id) => h.slice(h.indexOf(`id="${id}"`), h.indexOf('</details>\n', h.indexOf(`id="${id}"`)));
  assert.match(card(html, 'BUG-002'), /value="Yes, change it"[\s\S]*value="Not a bug"/);
  assert.match(html, /return t \? 'Not a bug: ' \+ t : 'Not a bug'/, 'the words beside Not a bug are its reason');
  put(step, { 'bugs/BUG-002-b/bug.json': bug('BUG-002', { fix: { status: 'wont-fix', summary: 'Asks you', decided: 'Not a bug: the country follows the org', invalid: 'the country follows the org' } }) });
  const d = await requestData(request);
  assert.deepEqual([d.bugs[1].state, d.bugs[1].needsYou, d.counts.needsYou], ['Not a bug', false, 0]);
  html = pageHtml(d);
  assert.match(html, /<summary>Not a bug <span class="n">1<\/span><\/summary>[\s\S]*You decided: <b>Not a bug: the country follows the org<\/b>/);
});

test('a decision on one bug covers a bug fixed by the same change, even one decided before that rule', async () => {
  const { request, step, proof } = grown(project());
  put(proof, { 'fix-claims.json': [{ bug: join(step, 'bugs/BUG-001-a'), claim: 'C-0001' }, { bug: join(step, 'bugs/BUG-002-b'), claim: 'C-0001' }] });
  writeResult(proof, { claims: [{ id: 'C-0001', statement: 'It works', verdict: 'proven', cases: [], evidence: [] }], problems: [] });
  put(step, { 'bugs/BUG-001-a/bug.json': bug('BUG-001', { fix: { status: 'fixed', summary: 'Refuse it', risk: 'high', patch: 'fixes/1-BUG-001.patch', decided: 'Ship it' } }),
    'bugs/BUG-002-b/bug.json': bug('BUG-002', { fix: { status: 'fixed', summary: 'Fixed with BUG-001', risk: 'high', patch: 'fixes/1-BUG-001.patch' } }) });
  const d = await requestData(request);
  assert.deepEqual(d.bugs.map((b) => [b.id, b.needsYou]), [['BUG-001', false], ['BUG-002', false]]);
});

test('a fix run that ends after your answer and still asks has asked again: the box comes back, with your earlier answer', async () => {
  const p = project();
  const request = newRequest(p, 'pay-page', 'improve', new Date(2026, 10, 10, 0, 11));
  const step = newStep(request, 'explore');
  const fix = newStep(request, 'fix');
  const asked = (decidedAt) => bug('BUG-017', { fix: { status: 'needs-decision', summary: 'No code changed.', decision: 'Change those lines?', decided: 'make sure it holds', decidedAt } });
  put(step, { 'charters.json': { charters: [] }, 'bugs/BUG-017-a/bug.json': asked('2026-11-10T16:19:59.000Z') });
  put(fix, { 'rounds.json': { feature: 'pay-page', rounds: [{ n: 1, explore: step, verify: null }] } });
  writeResult(fix, { generatedAt: '2026-11-10T17:10:32.000Z' });
  let d = await requestData(request);
  let html = pageHtml(d);
  assert.equal(d.bugs[0].needsYou, true);
  assert.match(html, /Change those lines\?<\/p><p class="muted">You answered before: make sure it holds<\/p><fieldset data-line="decide BUG-017 of /);
  // An answer given after the fix run is still waiting for the next one: no box until then.
  put(step, { 'bugs/BUG-017-a/bug.json': asked('2026-11-10T17:30:00.000Z') });
  html = pageHtml(await requestData(request));
  assert.match(html, /You decided: <b>make sure it holds<\/b>/);
  assert.doesNotMatch(html, /<fieldset data-line="decide BUG-017 of /);
});

test('How it happens has no label column, so its steps get the full width', async () => {
  const { request } = grown(project());
  const html = pageHtml(await requestData(request));
  assert.match(html, /<details class="see"><summary>How it happens<\/summary><section class="sec">/);
  assert.match(html, /\.see \.sec\{grid-template-columns:1fr\}/, 'a section with no h4 would put its content in the 9.5em label column');
});

test('How it happens and Details look like controls: link colour and an arrow that turns when open', async () => {
  const { request } = grown(project());
  const html = pageHtml(await requestData(request));
  assert.match(html, /details\.see>summary,details\.more>summary\{[^}]*color:var\(--run\)/);
  assert.match(html, /details\.see\[open\]>summary::before,details\.more\[open\]>summary::before\{transform:rotate\(45deg\)\}/);
});
