import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { areaVerdict, readDecisions, approvalView, buildProof, caseResults, chatSummary, checkEvidence, claimVerdict, contradicted, indexHtml, ledgerFiles, ledgerHtml, ledgerPage, listedTargets, listedViewports, notAStep, picksMotion, projectDir, sessionClaims, settled, writeIndex } from '../../skills/show-your-work/scripts/build-proof.mjs';

const claim = (id, extra = {}) => ({
  id, tags: ['f'], area: null, rank: 'headline', status: 'active', statement: `The app keeps ${id}`, given: 'G', setup: 'UI only', evidence: 'E', proof: 'will',
  cases: [{ id: 'a' }, { id: 'b' }], check: null, changed: null, retiredReason: null, ...extra,
});
const results = (entries) => new Map(Object.entries(entries).map(([k, result]) => [k, { result, session: 's' }]));

test('caseResults: a fail a later pass follows is flaky (not proven); a third run that fails again settles it as a fail', () => {
  const flaky = caseResults([{ id: 's', steps: [
    { claim: 'C1', case: 'a', result: 'fail', bug: 'BUG-001' },
    { claim: 'C1', case: 'a', result: 'pass' },
  ] }]).get('C1:a');
  assert.equal(flaky.result, 'blocked');
  assert.equal(flaky.note, 'flaky: failed once, then passed');
  assert.equal(flaky.bug, 'BUG-001');
  const settled = caseResults([{ id: 's', steps: [
    { claim: 'C1', case: 'a', result: 'fail', bug: 'BUG-001' },
    { claim: 'C1', case: 'a', result: 'pass' },
    { claim: 'C1', case: 'a', result: 'fail', bug: 'BUG-001' },
  ] }]).get('C1:a');
  assert.equal(settled.result, 'fail');
  // A pass at another viewport is not a rerun of the fail.
  const widths = caseResults([{ id: 's', steps: [
    { claim: 'C1', case: 'a', viewport: 'desktop', result: 'fail' },
    { claim: 'C1', case: 'a', viewport: 'mobile', result: 'pass' },
  ] }]);
  assert.equal(widths.get('C1:a').result, 'fail');
  assert.equal(widths.get('C1:a@desktop').result, 'fail');
});

test('caseResults ignores setup lines', () => {
  const map = caseResults([{ id: 's', steps: [{ claim: 'C1', setup: 'set-plan', result: 'pass' }] }]);
  assert.equal(map.size, 0);
});

test('settled: a claim the rollback re-proved ends with its last re-proof, which ran on the code that stays', () => {
  assert.equal(settled('disproved', ['proven', 'disproved']), 'disproved');
  assert.equal(settled('disproved', ['disproved', 'not-proven', 'proven']), 'proven');
  assert.equal(settled('disproved', ['not-proven']), 'disproved');
});

test('claimVerdict proven needs every case passed with evidence', () => {
  const v = claimVerdict(claim('C1'), results({ 'C1:a': 'pass', 'C1:b': 'pass' }), new Set(['C1:a', 'C1:b']));
  assert.equal(v.verdict, 'proven');
});

test('claimVerdict needs evidence for every passing case', () => {
  const v = claimVerdict(claim('C1'), results({ 'C1:a': 'pass', 'C1:b': 'pass' }), new Set(['C1:a']));
  assert.equal(v.verdict, 'not-proven');
  assert.deepEqual(v.problems, ['C1 case b: passed without evidence']);
});

test('claimVerdict disproved by one failing case', () => {
  const v = claimVerdict(claim('C1'), results({ 'C1:a': 'pass', 'C1:b': 'fail' }), new Set(['C1:a']));
  assert.equal(v.verdict, 'disproved');
  assert.equal(v.cases[1].result, 'fail');
});

test('claimVerdict blocked or unrun case is not proven', () => {
  const v = claimVerdict(claim('C1'), results({ 'C1:a': 'pass' }), new Set(['C1:a']));
  assert.equal(v.verdict, 'not-proven');
  assert.equal(v.cases[1].result, 'not-run');
});

test('claimVerdict will-not claim is not proven without running', () => {
  const v = claimVerdict(claim('C1', { proof: 'will not: needs a clock change' }), results({ 'C1:a': 'pass' }), new Set(['C1:a']));
  assert.equal(v.verdict, 'not-proven');
  assert.ok(v.cases.every((c) => c.result === 'not-run'));
});

test('claimVerdict skips retired claims', () => {
  assert.equal(claimVerdict(claim('C1', { status: 'retired' }), new Map(), new Set()), null);
});

test('areaVerdict', () => {
  assert.equal(areaVerdict(['proven', 'proven']), 'proven');
  assert.equal(areaVerdict(['proven', 'disproved']), 'disproved');
  assert.equal(areaVerdict(['proven', 'not-proven']), 'not-proven');
  assert.equal(areaVerdict([]), 'not-proven');
});

const doc = (claims, extra = {}) => ({ title: 'Email limits', input: 'main at abc', covers: [], willNotProve: '', areas: [], claims: claims.map((c) => ({ target: 'web', ...c })), ...extra });

test('approvalView lists headline claims numbered with routine count, covers and will-not-prove', () => {
  const { text } = approvalView(doc([
    claim('C1', { check: 'likely fails: slot taken first' }),
    claim('C2'),
    claim('C3', { rank: 'routine' }), claim('C4', { rank: 'routine' }), claim('C5', { rank: 'routine' }),
    claim('C6', { status: 'retired', retiredReason: 'gone' }),
  ], { covers: [{ area: 'daily limits', claims: ['C2', 'C3'] }], willNotProve: 'parallel sends' }));
  assert.ok(text.startsWith('Proof plan: Email limits (main at abc)\nC1, C2, ... are this run\'s new claims; approval gives them ledger ids (C-7f3a).\n\n'));
  assert.match(text, /1\. C1 The app keeps C1 +⚠ likely fails/);
  assert.match(text, /2\. C2 The app keeps C2/);
  assert.match(text, /\+ 3 routine checks/);
  assert.match(text, /Covers: daily limits \(C2, C3\)/);
  assert.match(text, /Will not prove: parallel sends/);
  assert.doesNotMatch(text, /The app keeps C6/);
});

test('approvalView names new ids and flags claims with no tags', () => {
  const { text, problems } = approvalView(doc([claim('C-7f3a', { fromLedger: true, rank: 'routine' }), claim('C1', { tags: [] })]));
  assert.match(text, /^C1, C2, \.\.\. are this run's new claims; approval gives them ledger ids \(C-7f3a\)\.$/m);
  assert.ok(problems.includes('C1: no tags'));
  assert.ok(!problems.some((p) => p.startsWith('C-7f3a: id')));
});

test('approvalView lists tags the ledger does not have, and a term that changes meaning', () => {
  const ledger = { claims: [{ id: 'C-0001', tags: ['x'], status: 'active' }], terms: [{ term: 'seat', means: 'a paid member' }] };
  const { text, problems } = approvalView(doc([claim('C1', { tags: ['x', 'y'] })], { terms: [{ term: 'seat', means: 'any member' }] }), { ledger });
  assert.match(text, /^New tags: y$/m);
  assert.ok(problems.includes('term "seat": the ledger means "a paid member", this run says "any member"'));
});

test('--approve mints ledger ids, rewrites covers, and mints nothing the second time', () => {
  const project = mkdtempSync(join(tmpdir(), 'project-'));
  mkdirSync(join(project, 'ledger'));
  writeFileSync(join(project, 'ledger', 'f.jsonl'), `${JSON.stringify(full('C-0001', { target: 'web' }))}\n`);
  const run = join(project, 'f', '2026-11-01-0900-prove', 'proof');
  mkdirSync(run, { recursive: true });
  writeFileSync(join(run, 'claims.json'), JSON.stringify({ title: 'T', input: 'in', willNotProve: 'x', areas: [], covers: [{ area: 'a', claims: ['C1', 'C-0001'] }],
    claims: [full('C1', { target: 'web' }), full('C2', { target: 'web', statement: 'The app keeps C2 too' }), full('C-0001', { target: 'web', fromLedger: true, rank: 'routine' })] }));
  const out = cli([run, '--approve']);
  assert.match(out, /^Ids: C1 is C-[0-9a-f]{4}, C2 is C-[0-9a-f]{4}$/m);
  const after = JSON.parse(readFileSync(join(run, 'claims.json'), 'utf8'));
  assert.ok(after.claims.every((c) => /^C-[0-9a-f]{4,}$/.test(c.id)));
  assert.ok(after.claims.some((c) => c.id === 'C-0001'));
  assert.equal(after.covers[0].claims[0], out.match(/C1 is (C-[0-9a-f]{4})/)[1]);
  assert.doesNotMatch(cli([run, '--approve']), /^Ids:/m);
  assert.deepEqual(JSON.parse(readFileSync(join(run, 'claims.json'), 'utf8')).claims.map((c) => c.id), after.claims.map((c) => c.id));
});

test('an unlogged evidence file named after a ledger id puts its case in doubt', () => {
  const run = makeRun({
    claims: [claim('C-7f3a', { cases })],
    sessions: { s1: [{ claim: 'C-7f3a', case: 'a', result: 'pass' }] },
    evidence: [ev('C-7f3a', 'a', 'evidence/C-7f3a-a.png', 'png')],
    files: { 'evidence/C-7f3a-a.png': 'png', 'evidence/C-7f3a-a-old.png': 'old' },
  });
  const { data, problems } = buildProof(run);
  assert.ok(problems.includes('evidence/C-7f3a-a-old.png: not in evidence.jsonl'));
  assert.equal(data.claims[0].verdict, 'not-proven');
});

test('approvalView shows changed earlier claims under their own heading', () => {
  const { text, problems } = approvalView(doc([claim('C1', { status: 'changed', changed: { from: 'old text', at: 'x', why: 'the code only: abc a.ts' } })]));
  assert.match(text, /Changes earlier claims:/);
  assert.match(text, /- C1: The app keeps C1 \(was: old text\) · from the code only: abc a\.ts/);
  assert.deepEqual(problems, []);
});

test('approvalView flags a changed claim that does not say where the change came from', () => {
  const { problems } = approvalView(doc([claim('C1', { status: 'changed', changed: { from: 'old text', at: 'x' } })]));
  assert.match(problems[0], /^C1: changed without changed\.why/);
});

test('approvalView flags more than 7 headline lines', () => {
  const claims = [1, 2, 3, 4, 5, 6].map((n) => claim(`C${n}`));
  claims.push(claim('C7', { status: 'changed', changed: { from: 'x' } }), claim('C8', { status: 'changed', changed: { from: 'y' } }));
  assert.ok(approvalView(doc(claims)).problems.includes('8 headline lines; the limit is 7: move some to routine or split into areas'));
});

test('approvalView groups by area', () => {
  const claims = Array.from({ length: 8 }, (_, i) => claim(`C${i + 1}`, { area: 'A' }));
  claims.push(claim('C9', { area: 'B' }));
  const { text, problems } = approvalView(doc(claims, { areas: [{ id: 'A', title: 'Limits' }, { id: 'B', title: 'Other' }] }));
  assert.ok(text.indexOf('A. Limits') < text.indexOf('The app keeps C1'));
  assert.ok(text.indexOf('B. Other') > text.indexOf('The app keeps C8'));
  assert.ok(problems.includes('area A: 8 headline lines; the limit is 7'));
  const many = Array.from({ length: 8 }, (_, i) => ({ id: String.fromCharCode(65 + i), title: 't' }));
  assert.ok(approvalView(doc([], { areas: many })).problems.includes('8 areas; the limit is 7: propose phases'));
});

test('approvalView flags a headline claim in an unknown area', () => {
  const claims = [claim('C1', { area: 'A' }), claim('C2', { area: 'Z' }), claim('C3', { area: null })];
  const { text, problems } = approvalView(doc(claims, { areas: [{ id: 'A', title: 'Limits' }] }));
  assert.match(text, /Other:\n {2}2\. C2 The app keeps C2\n {2}3\. C3 The app keeps C3/);
  assert.ok(problems.includes('C2: unknown area Z'));
  assert.ok(problems.includes('C3: no area'));
});

test('approvalView counts changed claims toward their area limit', () => {
  const claims = [1, 2, 3, 4, 5, 6].map((n) => claim(`C${n}`, { area: 'A' }));
  claims.push(claim('C7', { area: 'A', status: 'changed', changed: { from: 'x' } }), claim('C8', { area: 'A', status: 'retired', retiredReason: 'gone' }));
  const { text, problems } = approvalView(doc(claims, { areas: [{ id: 'A', title: 'Limits' }] }));
  assert.ok(problems.includes('area A: 8 headline lines; the limit is 7'));
  assert.match(text, /A\. Limits[\s\S]*Changes earlier claims:\n {2}- C7: .*\n {2}- C8: retired: gone/);
});

const script = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills', 'show-your-work', 'scripts', 'build-proof.mjs');
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const makeRun = ({ claims, sessions = {}, evidence = [], bugs = {}, files = {}, extra = {} }) => {
  const run = mkdtempSync(join(tmpdir(), 'proof-'));
  writeFileSync(join(run, 'claims.json'), JSON.stringify({ title: 'T', input: 'in', willNotProve: 'parallel sends', areas: [], claims, ...extra }));
  for (const [name, rows] of Object.entries(sessions)) {
    mkdirSync(join(run, 'sessions'), { recursive: true });
    writeFileSync(join(run, 'sessions', `${name}.jsonl`), jsonl(rows));
  }
  if (evidence.length) writeFileSync(join(run, 'evidence.jsonl'), jsonl(evidence));
  for (const [dir, bug] of Object.entries(bugs)) {
    mkdirSync(join(run, 'bugs', dir), { recursive: true });
    writeFileSync(join(run, 'bugs', dir, 'bug.json'), JSON.stringify(bug));
  }
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(run, name)), { recursive: true });
    writeFileSync(join(run, name), text);
  }
  return run;
};
const sha = (text) => createHash('sha256').update(text).digest('hex');
const ev = (claimId, caseId, file, text, extra = {}) => ({ claim: claimId, case: caseId, target: 'browser', method: 'screenshot', commit: 'abc123', env: 'staging', at: 't', by: 's', file, sha256: sha(text), note: '', ...extra });
const cases = [{ id: 'a', do: 'd', expect: 'e' }];

test('checkEvidence flags hash mismatch and missing file', () => {
  const run = makeRun({ claims: [claim('C1', { cases })], files: { 'evidence/a.png': 'good', 'evidence/b.png': 'real' } });
  const lines = [
    ev('C1', 'a', 'evidence/a.png', 'good'),
    ev('C1', 'a', 'evidence/b.png', 'other'),
    ev('C1', 'a', 'evidence/gone.png', 'x'),
    ev('C9', 'a', 'evidence/a.png', 'good'),
  ];
  const { keys, problems } = checkEvidence(run, lines, [claim('C1', { cases })]);
  assert.deepEqual([...keys], ['C1:a']);
  assert.equal(problems.length, 3);
  assert.match(problems.join('\n'), /hash mismatch/);
  assert.match(problems.join('\n'), /file missing/);
  assert.match(problems.join('\n'), /unknown claim or case C9:a/);
});

test('buildProof reports unknown claim ids', () => {
  const run = makeRun({ claims: [claim('C1', { cases })] });
  mkdirSync(join(run, 'sessions'));
  writeFileSync(join(run, 'sessions', 's1.jsonl'), `${JSON.stringify({ claim: 'C1', case: 'a', result: 'pass' })}\n\n${JSON.stringify({ claim: 'C15', case: 'a', result: 'pass' })}\n`);
  const { data, problems } = buildProof(run);
  assert.match(problems.join('\n'), /sessions\/s1\.jsonl line 3: unknown claim or case C15:a/);
  assert.equal(data.tally.proven, 0);
});

test('buildProof on a run with no sessions', () => {
  const claims = [claim('C1', { cases }), claim('C2', { cases }), claim('C3', { status: 'retired' })];
  const { data } = buildProof(makeRun({ claims }));
  assert.ok(data.claims.every((c) => c.verdict === 'not-proven'));
  assert.equal(data.tally.notProven, 2);
});

test('buildProof sorts disproved first and attaches bugs', () => {
  const claims = [claim('C1', { cases }), claim('C2', { cases })];
  const run = makeRun({
    claims,
    sessions: { s1: [{ claim: 'C1', case: 'a', result: 'pass' }, { claim: 'C2', case: 'a', result: 'fail', bug: 'BUG-001' }] },
    evidence: [ev('C1', 'a', 'e.png', 'x')],
    files: { 'e.png': 'x' },
    bugs: { 'BUG-001-x': { id: 'BUG-001', claim: 'C2', title: 'bad' } },
  });
  const { data } = buildProof(run);
  assert.equal(data.claims[0].id, 'C2');
  assert.equal(data.claims[0].bugs[0].id, 'BUG-001');
  assert.equal(data.claims[1].verdict, 'proven');
  assert.equal(data.subject.commit, 'abc123');
});

const failingRun = () => makeRun({
  claims: [claim('C1', { cases }), claim('C2', { cases, statement: 'Bad </script> claim' })],
  sessions: { s1: [{ claim: 'C1', case: 'a', result: 'pass' }, { claim: 'C2', case: 'a', result: 'fail', bug: 'BUG-001' }] },
  evidence: [ev('C1', 'a', 'e.png', 'x')],
  files: { 'e.png': 'x' },
  bugs: { 'BUG-001-x': { id: 'BUG-001', claim: 'C2' } },
});

test('chatSummary leads with failures and ends with the open link', () => {
  const lines = chatSummary(buildProof(failingRun()).data, 'file:///x/proof.html').split('\n');
  assert.match(lines[0], /^Proof: T: 1 proven · 1 disproved · 0 not proven/);
  assert.match(lines[1], /^✗ C2 /);
  assert.match(lines[1], /\(BUG-001\)/);
  assert.equal(lines.at(-1), 'Open: file:///x/proof.html');
  assert.ok(lines.includes('Will not prove: parallel sends'));
});

test('default CLI writes result.json, never proof.html', () => {
  const run = makeRun({ claims: [claim('C1', { cases })] });
  cli([run]);
  assert.equal(JSON.parse(readFileSync(join(run, 'result.json'), 'utf8')).data.claims[0].id, 'C1');
  assert.ok(!existsSync(join(run, 'proof.html')));
});

test('checkEvidence rejects paths outside the run folder and directories', () => {
  const run = makeRun({ claims: [claim('C1', { cases })], files: { 'outside.txt': 'x', 'run/sub/f': 'y' } });
  const inner = join(run, 'run');
  writeFileSync(join(inner, 'claims.json'), '{}');
  const lines = [ev('C1', 'a', '../outside.txt', 'x'), ev('C1', 'a', 'sub', 'y')];
  const { keys, problems } = checkEvidence(inner, lines, [claim('C1', { cases })]);
  assert.equal(keys.size, 0);
  assert.match(problems[0], /line 1: file outside run folder \.\.\/outside\.txt/);
  assert.match(problems[1], /line 2: file missing sub/);
});

test('buildProof turns non-object lines into problems', () => {
  const run = makeRun({ claims: [claim('C1', { cases })] });
  mkdirSync(join(run, 'sessions'));
  writeFileSync(join(run, 'sessions', 's1.jsonl'), 'null\n');
  writeFileSync(join(run, 'evidence.jsonl'), '\n5\n');
  const { problems } = buildProof(run);
  assert.ok(problems.includes('sessions/s1.jsonl line 1: not a JSON object'));
  assert.ok(problems.includes('evidence.jsonl line 2: not a JSON object'));
});

const full = (id, extra = {}) => claim(id, {
  given: 'G', setup: 'UI only', cases: [{ id: 'a', do: 'Do it', expect: 'It works' }], evidence: 'Text', risk: 'R', source: 'abc file.ts', check: 'likely fails: x', ...extra,
});
const runData = (claims) => ({ generatedAt: '2026-10-25T10:00:00.000Z', claims: claims.map((c) => ({ id: c.id, verdict: c.verdict })) });
const L = (claims = [], terms = []) => ({ claims, terms });
const ldoc = { feature: 'f', title: 'Feat', terms: [{ term: 'customer email', means: 'm' }], claims: [] };
const run1 = (claims, ledger = L()) => ledgerFiles({ ...ldoc, claims: claims.map(({ verdict, ...c }) => c) }, runData(claims), ledger);
const runWith = (approvedBy, claims, ledger = L()) => ledgerFiles({ ...ldoc, approvedBy, claims: claims.map(({ verdict, ...c }) => c) }, runData(claims), ledger);
const page = (claims) => ledgerHtml(L(claims));
const readLines = (file) => readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const one = (r, id) => r.claims.find((c) => c.id === id);

test('ledgerFiles writes this run\'s claims with tags and the verdict word', () => {
  const r = run1([{ ...full('C1', { fromLedger: false }), verdict: 'proven' }]);
  const c = r.claims[0];
  assert.equal(c.verdict, 'proven');
  assert.deepEqual(c.tags, ['f']);
  for (const key of ['lastVerdict', 'check', 'fromLedger', 'area', 'source', 'proof', 'changed', 'risk']) assert.ok(!(key in c), key);
  assert.deepEqual(c.files, ['file.ts']);
  assert.equal(c.rank, 'headline');
  assert.deepEqual(r.terms, [{ term: 'customer email', means: 'm' }]);
  assert.deepEqual(r.kept, []);
  const html = page(r.claims);
  assert.match(html, /<dt>Tags<\/dt><dd>f<\/dd>/);
  assert.match(html, /<b>C1<\/b> The app keeps C1 <span class="good">Proven on the cases run<\/span>/);
});

test('ledger claims without approvedBy read as user', () => {
  const r = run1([{ ...full('C1'), verdict: 'proven' }, { ...full('C2'), verdict: 'proven' }], L([full('C1', { verdict: 'proven' })]));
  assert.deepEqual(r.claims.map((c) => c.approvedBy), ['user', 'user']);
  assert.doesNotMatch(page(r.claims), /Approved/);
});

test('an auto run marks its claims and the ledger page says so', () => {
  const r = runWith('auto', [{ ...full('C1'), verdict: 'proven' }]);
  assert.equal(r.claims[0].approvedBy, 'auto');
  assert.match(page(r.claims), /<dt>Approved<\/dt><dd>by auto mode<\/dd>/);
});

test('an ask-mode run turns an auto claim into user', () => {
  const r = runWith('user', [{ ...full('C1'), verdict: 'proven' }], L([full('C1', { approvedBy: 'auto', verdict: 'proven' })]));
  assert.equal(r.claims[0].approvedBy, 'user');
});

test('a re-prove keeps the auto mark', () => {
  const first = runWith('auto', [{ ...full('C1'), verdict: 'proven' }]).claims;
  assert.equal(runWith('auto', [{ ...full('C1'), verdict: 'proven' }], L(first)).claims[0].approvedBy, 'auto');
});

test('an auto run keeps a user claim it copied unchanged', () => {
  const ledger = L([full('C1', { verdict: 'proven' }), full('C2', { approvedBy: 'auto', verdict: 'proven' })]);
  const r = runWith('auto', [{ ...full('C1', { fromLedger: true, status: 'active' }), verdict: 'proven' }, { ...full('C2', { fromLedger: true, status: 'active' }), verdict: 'proven' }, { ...full('C3'), verdict: 'proven' }], ledger);
  assert.deepEqual(r.claims.map((c) => c.approvedBy), ['user', 'auto', 'auto']);
});

test('an auto run that retires a user claim marks it auto, and a re-prove keeps the mark', () => {
  const retire = [{ ...full('C1', { fromLedger: true, status: 'retired', retiredReason: 'gone' }), verdict: undefined }];
  const r = runWith('auto', retire, L([full('C1', { verdict: 'proven' })]));
  assert.equal(r.claims[0].status, 'retired');
  assert.equal(r.claims[0].approvedBy, 'auto');
  assert.match(page(r.claims), /<dt>Approved<\/dt><dd>by auto mode<\/dd>/);
  assert.equal(runWith('auto', retire, L(r.claims)).claims[0].approvedBy, 'auto');
});

test('an ask-mode run that retires an auto claim marks it user', () => {
  const r = runWith('user', [{ ...full('C1', { fromLedger: true, status: 'retired', retiredReason: 'gone' }), verdict: undefined }], L([full('C1', { approvedBy: 'auto', verdict: 'proven' })]));
  assert.equal(r.claims[0].approvedBy, 'user');
});

test('a retirement carried over keeps its approvedBy', () => {
  const r = runWith('auto', [{ ...full('C1', { fromLedger: true, status: 'retired', retiredReason: 'gone' }), verdict: undefined }], L([full('C1', { status: 'retired', retiredReason: 'gone', verdict: 'proven' })]));
  assert.equal(r.claims[0].status, 'retired');
  assert.equal(r.claims[0].approvedBy, 'user');
});

test('ledgerFiles returns only this run\'s claims', () => {
  const r = run1([{ ...full('C2'), verdict: 'disproved' }], L([full('C1', { verdict: 'proven' }), full('C2', { verdict: 'proven' })]));
  assert.deepEqual(r.claims.map((c) => c.id), ['C2']);
  assert.equal(r.claims[0].verdict, 'disproved');
});

test('ledgerFiles writes a retired claim as a tombstone', () => {
  const ledger = L([full('C2', { verdict: 'proven' })]);
  const r = run1([{ ...full('C2', { status: 'retired', retiredReason: 'gone', statement: null }), verdict: undefined }], ledger);
  assert.deepEqual(r.claims[0], { id: 'C2', tags: ['f'], statement: 'The app keeps C2', status: 'retired', retiredReason: 'gone', approvedBy: 'user' });
  assert.match(page(r.claims), /C2 <span class="retired">Retired<\/span>/);
});

test('ledgerFiles drops check', () => {
  const r = run1([{ ...full('C1'), verdict: 'proven' }]);
  assert.ok(!JSON.stringify(r.claims).includes('"check"'));
  assert.ok(!page(r.claims).includes('Check'));
});

test('ledgerFiles keeps the files a claim had, adds the run\'s, and strips (new) and (unchanged)', () => {
  const r = run1([{ ...full('C-0001', { statement: 'The app shows "Limit reached" (unchanged) and "Try tomorrow" (new).', source: 'found: BUG-002; abc123 src/b.mjs' }), verdict: 'proven' }],
    L([full('C-0001', { statement: 'The app shows "Limit reached" and "Try tomorrow".', files: ['src/a.mjs'], verdict: 'proven' })]));
  assert.deepEqual(r.kept, []);
  assert.equal(r.claims[0].statement, 'The app shows "Limit reached" and "Try tomorrow".');
  assert.deepEqual(r.claims[0].files, ['src/a.mjs', 'src/b.mjs']);
  const doc = run1([{ ...full('C2', { source: 'docs/limits.md: "Free orgs send at most 10 invites a day, e.g. 10."' }), verdict: 'proven' }]);
  assert.deepEqual(doc.claims[0].files, ['docs/limits.md']);
  assert.deepEqual(run1([{ ...full('C3', { source: 'the user\'s words: "x"' }), verdict: 'proven' }]).claims[0].files, []);
});

test('ledgerFiles keeps the retired reason when a later run has none', () => {
  const r = run1([{ ...full('C2', { status: 'retired', retiredReason: null }), verdict: undefined }], L([full('C2', { status: 'retired', retiredReason: 'Feature removed', verdict: 'proven' })]));
  assert.equal(r.claims[0].retiredReason, 'Feature removed');
  assert.match(page(r.claims), /<dt>Status<\/dt><dd>retired: Feature removed<\/dd>/);
});

test('ledgerFiles keeps a claim a later run reworded, and writes the rest', () => {
  const r = run1([{ ...full('C-0001', { statement: 'Old words' }), verdict: 'proven' }, { ...full('C-0002'), verdict: 'proven' }], L([full('C-0001', { statement: 'New words', verdict: 'proven' })]));
  assert.deepEqual(r.kept, [{ id: 'C-0001', why: 'changed since this run' }]);
  assert.deepEqual(r.claims.map((c) => c.id), ['C-0002']);
});

test('ledgerFiles writes a changed claim whose old wording is the ledger\'s', () => {
  const r = run1([{ ...full('C-0001', { status: 'changed', statement: 'New', changed: { from: 'Old', at: '2026-11-01' } }), verdict: 'proven' }], L([full('C-0001', { statement: 'Old', verdict: 'proven' })]));
  assert.deepEqual(r.kept, []);
  assert.equal(r.claims[0].statement, 'New');
});

test('ledgerFiles keeps a claim the ledger retired', () => {
  const r = run1([{ ...full('C-0001'), verdict: 'proven' }], L([full('C-0001', { status: 'retired', retiredReason: 'gone' })]));
  assert.deepEqual(r.kept, [{ id: 'C-0001', why: 'changed since this run' }]);
  assert.deepEqual(r.claims, []);
});

test('--ledger writes the run\'s feature file and terms.json, is idempotent, and rebuilds the index', () => {
  const run = makeRun({ claims: [full('C-0001')], extra: { feature: 'invites', terms: [{ term: 'seat', means: 'a paid member' }] } });
  const project = mkdtempSync(join(tmpdir(), 'ledger-'));
  const dir = join(project, 'ledger');
  const go = () => execFileSync(process.execPath, [script, run, '--ledger', dir], { encoding: 'utf8' });
  const out = go();
  assert.match(out, new RegExp(`^Ledger: 1 claims written to ${dir}$`, 'm'));
  assert.match(out, /^Index: file:.*index\.html$/m);
  const first = [readFileSync(join(dir, 'invites.jsonl'), 'utf8'), readFileSync(join(dir, 'terms.json'), 'utf8')];
  assert.deepEqual(readLines(join(dir, 'invites.jsonl')).map((c) => c.id), ['C-0001']);
  assert.ok(!existsSync(join(dir, 'claims.json')));
  assert.ok(!first[0].includes('"check"'));
  go();
  assert.deepEqual([readFileSync(join(dir, 'invites.jsonl'), 'utf8'), readFileSync(join(dir, 'terms.json'), 'utf8')], first);
  assert.ok(!existsSync(join(run, 'proof.html')));
  assert.match(readFileSync(join(project, 'index.html'), 'utf8'), /<a href="ledger\.html">Ledger<\/a>/);
  assert.match(readFileSync(join(project, 'ledger.html'), 'utf8'), /<dt>Tags<\/dt>/);
});

test('--ledger writes nothing when a feature file has git conflict markers', () => {
  const run = makeRun({ claims: [full('C-0003', { target: 'web' })], extra: { feature: 'invites' } });
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
  writeFileSync(join(dir, 'billing.jsonl'), '<<<<<<< ours\n{"id": "C-0001"}\n=======\n{"id": "C-0009"}\n>>>>>>> theirs\n');
  writeFileSync(join(dir, 'invites.jsonl'), `${JSON.stringify(full('C-0002'))}\n`);
  cliFails([run, '--ledger', dir], /Problem: billing\.jsonl: has git conflict markers/);
  assert.equal(readFileSync(join(dir, 'invites.jsonl'), 'utf8'), `${JSON.stringify(full('C-0002'))}\n`);
});

test('--ledger checks its arguments', () => {
  const run = makeRun({ claims: [full('C1')] });
  const fail = (args) => assert.throws(() => execFileSync(process.execPath, [script, ...args], { encoding: 'utf8', stdio: 'pipe' }), (e) => e.status === 1 && /Usage|claims.json: missing/.test(e.stderr));
  fail([run, '--ledger']);
  fail([mkdtempSync(join(tmpdir(), 'empty-')), '--ledger', join(tmpdir(), 'x')]);
});


test('a web claim with a ledger id is proven by a screenshot named after it', () => {
  const run = makeRun({
    claims: [claim('C-7f3a', { target: 'web', cases })],
    sessions: { s1: [{ claim: 'C-7f3a', case: 'a', result: 'pass' }] },
    evidence: [ev('C-7f3a', 'a', 'evidence/C-7f3a-a.png', 'png')],
    files: { 'evidence/C-7f3a-a.png': 'png' },
  });
  assert.equal(buildProof(run).data.claims[0].verdict, 'proven');
});

test('--approve renames the claims fix-claims.json points at', () => {
  const project = mkdtempSync(join(tmpdir(), 'project-'));
  const run = join(project, 'f', '2026-11-01-0900-explore-and-fix', 'proof');
  mkdirSync(run, { recursive: true });
  writeFileSync(join(run, 'claims.json'), JSON.stringify({ title: 'T', input: 'in', willNotProve: 'x', areas: [], covers: [], claims: [full('C1', { target: 'web' })] }));
  writeFileSync(join(run, 'fix-claims.json'), JSON.stringify([{ bug: '/b/BUG-001-x', claim: 'C1' }]));
  const id = cli([run, '--approve']).match(/C1 is (C-[0-9a-f]{4})/)[1];
  assert.deepEqual(JSON.parse(readFileSync(join(run, 'fix-claims.json'), 'utf8')), [{ bug: '/b/BUG-001-x', claim: id }]);
});

test('--ledger refuses a claim that was never approved into a ledger id, or has no tags', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
  cliFails([makeRun({ claims: [full('C1')], extra: { feature: 'f' } }), '--ledger', dir], /Problem: C1: not a ledger id: approve the run first/);
  cliFails([makeRun({ claims: [full('C-0001', { tags: [] })], extra: { feature: 'f' } }), '--ledger', dir], /Problem: C-0001: no tags/);
  cliFails([makeRun({ claims: [full('C-0001')] }), '--ledger', dir], /Problem: claims\.json: feature null is not a lowercase slug/);
  cliFails([makeRun({ claims: [full('C-0001')], extra: { feature: 'Terms' } }), '--ledger', dir], /Problem: claims\.json: feature "Terms" is not a lowercase slug/);
  assert.deepEqual(readdirSync(dir), []);
});

test('ledgerFiles keeps tags a later run added when a re-prove writes the claim', () => {
  const r = run1([{ ...full('C-0001'), verdict: 'proven' }], L([full('C-0001', { tags: ['f', 'roles'], verdict: 'proven' })]));
  assert.deepEqual(r.claims[0].tags, ['f', 'roles']);
});
test('ledgerFiles keeps a copied claim\'s ledger rank: a run copies claims as routine', () => {
  const r = run1([{ ...full('C-0001', { fromLedger: true, rank: 'routine' }), verdict: 'proven' }], L([full('C-0001', { rank: 'headline', verdict: 'proven' })]));
  assert.equal(r.claims[0].rank, 'headline');
});

test('ledgerFiles rewrites an older claim whose statement still has markers, instead of keeping it', () => {
  const old = 'The app shows "Limit reached" (unchanged).';
  const r = run1([{ ...full('C-0001', { statement: old, fromLedger: true }), verdict: 'disproved' }], L([full('C-0001', { statement: old, verdict: 'proven' })]));
  assert.deepEqual(r.kept, []);
  assert.equal(r.claims[0].statement, 'The app shows "Limit reached".');
  assert.equal(r.claims[0].verdict, 'disproved');
});

test('ledgerFiles keeps a proof that is not "will", stores changed claims as active, and stores paths without ./', () => {
  const r = run1([
    { ...full('C-0001', { proof: 'will not: needs a setup command for a lapsed org', source: 'abc ./src/a.mjs' }), verdict: 'not-proven' },
    { ...full('C-0002', { proof: 'will', status: 'changed', changed: { from: 'The app keeps C-0002', at: 'x', why: 'y' }, statement: 'New words' }), verdict: 'proven' },
  ], L([full('C-0002', { verdict: 'proven' })]));
  assert.equal(one(r, 'C-0001').proof, 'will not: needs a setup command for a lapsed org');
  assert.deepEqual(one(r, 'C-0001').files, ['src/a.mjs']);
  assert.ok(!('proof' in one(r, 'C-0002')));
  assert.equal(one(r, 'C-0002').status, 'active');
});

test('markers are stripped only after quoted UI text, and a retired claim reads retired', () => {
  const r = run1([{ ...full('C-0001', { statement: 'The app labels the tab "Inbox (new)" (new).' }), verdict: 'proven' }]);
  assert.equal(r.claims[0].statement, 'The app labels the tab "Inbox (new)".');
  assert.match(page([{ id: 'C-0002', tags: ['f'], statement: 'Gone.', status: 'retired', retiredReason: 'removed' }]), /Gone\. <span class="retired">Retired<\/span>/);
});

test('--ledger keeps a claim in the feature file it lives in and files new claims under the run\'s feature', () => {
  const project = mkdtempSync(join(tmpdir(), 'project-'));
  const dir = join(project, 'ledger');
  mkdirSync(dir);
  writeFileSync(join(dir, 'billing.jsonl'), `${JSON.stringify(full('C-0001', { tags: ['billing'], verdict: 'proven' }))}\n${JSON.stringify(full('C-0009', { tags: ['billing'], verdict: 'proven' }))}\n`);
  const run = makeRun({ claims: [full('C-0001', { tags: ['billing'], fromLedger: true, rank: 'routine' }), full('C-0002')], extra: { feature: 'invites' },
    sessions: { s1: [{ claim: 'C-0001', case: 'a', result: 'fail' }] } });
  cli([run, '--ledger', dir]);
  assert.deepEqual(readLines(join(dir, 'billing.jsonl')).map((c) => c.id), ['C-0001', 'C-0009']);
  assert.deepEqual(readLines(join(dir, 'invites.jsonl')).map((c) => c.id), ['C-0002']);
  const page = readFileSync(join(project, 'ledger.html'), 'utf8');
  assert.match(page, /<li class="claim [^"]*"[^>]*>[\s\S]*?<b>C-0001<\/b>[\s\S]*?<span class="tag">billing<\/span>/);
  assert.match(page, /<b>C-0002<\/b>[\s\S]*?<span class="tag">invites<\/span>/);
});

test('the index says when the ledger has problems, instead of dropping a feature silently', () => {
  assert.match(indexHtml('acme', [], { claims: [full('C-0001')], terms: [], problems: ['billing.jsonl: has git conflict markers'] }), /Problem: billing\.jsonl: has git conflict markers[\s\S]*<a href="ledger\.html">Ledger<\/a>/);
});

test('buildProof with verify false reads no capture and marks verdicts checking', () => {
  const run = makeRun({
    claims: [claim('C1', { target: 'api', cases })],
    sessions: { s1: [{ claim: 'C1', case: 'a', result: 'pass' }] },
    evidence: [ev('C1', 'a', 'evidence/C1-a.txt', 'not what is on disk')],
    files: { 'evidence/C1-a.txt': 'what is on disk' },
  });
  assert.equal(buildProof(run).data.claims[0].verdict, 'not-proven');
  const quick = buildProof(run, { verify: false }).data.claims[0];
  assert.equal(quick.verdict, 'checking');
  assert.equal(quick.cases[0].result, 'pass');
});

test('the chat summary lists new tags', () => {
  const project = mkdtempSync(join(tmpdir(), 'project-'));
  mkdirSync(join(project, 'ledger'));
  writeFileSync(join(project, 'ledger', 'x.jsonl'), `${JSON.stringify(full('C-0001', { tags: ['x'] }))}\n`);
  const run = join(project, 'f', '2026-11-01-0900-prove', 'proof');
  mkdirSync(run, { recursive: true });
  writeFileSync(join(run, 'claims.json'), JSON.stringify({ title: 'T', claims: [claim('C1', { cases, tags: ['x', 'y'] })] }));
  const out = execFileSync('node', [script, run], { encoding: 'utf8' });
  assert.match(out, /^New tags: y$/m);
});

test('approvalView flags unknown status and rank', () => {
  const claims = [claim('C1', { status: 'draft' }), claim('C2', { rank: 'top' }), claim('C3', { rank: undefined }), claim('C4', { status: 'changed', rank: undefined, changed: { from: 'x', why: 'the code only: abc a.ts' } })];
  const { problems } = approvalView(doc(claims));
  assert.deepEqual(problems, ['C1: unknown status draft', 'C2: unknown rank top', 'C3: unknown rank undefined']);
});

test('approvalView flags an email address in any claim field', () => {
  const claims = [claim('C1', { given: 'Owner of a Free org' }), claim('C2', { cases: [{ id: 'a', do: 'Sign in as qa@example.com', expect: 'e' }] }), claim('C3', { source: 'the user\'s words: ask a.b@corp.io' })];
  const { problems } = approvalView(doc(claims));
  assert.deepEqual(problems, ['C2: contains an email address: name an account key, or how the address differs from a New accounts address', 'C3: contains an email address: name an account key, or how the address differs from a New accounts address']);
});

test('approvalView takes a bad actor\'s address written as a change from New accounts, never the address', () => {
  const send = (to) => claim('C1', { cases: [{ id: 'a', do: `Invite ${to}`, expect: 'The invite is refused' }] });
  assert.deepEqual(approvalView(doc([send('a `New accounts` address with `<b>` before the @')])).problems, []);
  assert.deepEqual(approvalView(doc([send('qa+<b>1</b>@acme.test')])).problems, ['C1: contains an email address: name an account key, or how the address differs from a New accounts address']);
});

test('approvalView shows routine claims the code check marks, outside the limit', () => {
  const headline = Array.from({ length: 7 }, (_, i) => claim(`C${i + 1}`));
  const { text, problems } = approvalView(doc([
    ...headline,
    claim('C8', { rank: 'routine', check: 'likely fails: slot taken first' }),
    claim('C9', { rank: 'routine' }),
  ]));
  assert.match(text, /\+ 2 routine checks: run, shown only if they fail\.\nRoutine checks the code check marks:\n- C8 The app keeps C8   ⚠ likely fails: slot taken first/);
  assert.doesNotMatch(text, /C9 The app keeps C9/);
  assert.deepEqual(problems, []);
});

test('approvalView flags vague expected results', () => {
  const { problems } = approvalView(doc([
    claim('C1', { cases: [{ id: 'a', do: 'd', expect: 'A clear message, no crash' }, { id: 'b', do: 'd', expect: 'Shows "Not allowed"' }] }),
    claim('C2', { cases: [{ id: 'a', do: 'd', expect: 'Works properly' }] }),
  ]));
  assert.deepEqual(problems, [
    'C1 case a: vague expected result "clear": name the exact text, status or count',
    'C2 case a: vague expected result "properly": name the exact text, status or count',
  ]);
});

test('buildProof: a web case needs a picture or video, text alone does not prove it', () => {
  const run = makeRun({
    claims: [claim('C1', { target: 'web', cases }), claim('C2', { target: 'web', cases }), claim('C3', { target: 'api', cases })],
    sessions: { s1: ['C1', 'C2', 'C3'].map((id) => ({ claim: id, case: 'a', result: 'pass' })) },
    evidence: [ev('C1', 'a', 'evidence/C1-a.txt', 'dom'), ev('C2', 'a', 'evidence/C2-a.txt', 'dom2'), ev('C2', 'a', 'evidence/C2-a.png', 'img'), ev('C3', 'a', 'evidence/C3-a.txt', 'http')],
    files: { 'evidence/C1-a.txt': 'dom', 'evidence/C2-a.txt': 'dom2', 'evidence/C2-a.png': 'img', 'evidence/C3-a.txt': 'http' },
  });
  const { data, problems } = buildProof(run);
  const verdict = (id) => data.claims.find((c) => c.id === id).verdict;
  assert.equal(verdict('C1'), 'not-proven');
  assert.equal(verdict('C2'), 'proven');
  assert.equal(verdict('C3'), 'proven');
  assert.ok(problems.includes('C1 case a: passed without visual evidence'));
});

test('buildProof: a failed web case without a picture or video is flagged', () => {
  const run = makeRun({
    claims: [claim('C1', { target: 'web', cases })],
    sessions: { s1: [{ claim: 'C1', case: 'a', result: 'fail' }] },
    evidence: [ev('C1', 'a', 'evidence/C1-a.txt', 'dom')],
    files: { 'evidence/C1-a.txt': 'dom' },
  });
  const { data, problems } = buildProof(run);
  assert.equal(data.claims[0].verdict, 'disproved');
  assert.ok(problems.includes('C1 case a: failed without visual evidence'));
});

test('buildProof: setup evidence alone does not prove a case', () => {
  const run = makeRun({
    claims: [claim('C1', { cases })],
    sessions: { s1: [{ claim: 'C1', case: 'a', result: 'pass' }] },
    evidence: [ev('C1', 'a', 'evidence/C1-a-setup.txt', 'exit 0', { method: 'setup command set-plan' })],
    files: { 'evidence/C1-a-setup.txt': 'exit 0' },
  });
  const { data, problems } = buildProof(run);
  assert.equal(data.claims[0].verdict, 'not-proven');
  assert.ok(problems.includes('C1 case a: passed without evidence'));
  assert.equal(data.claims[0].evidence.length, 1);
});

test('buildProof: evidence with a bad hash does not prove a case', () => {
  const run = makeRun({
    claims: [claim('C1', { cases })],
    sessions: { s1: [{ claim: 'C1', case: 'a', result: 'pass' }] },
    evidence: [ev('C1', 'a', 'evidence/C1-a.png', 'other')],
    files: { 'evidence/C1-a.png': 'real' },
  });
  const { data, problems } = buildProof(run);
  assert.equal(data.claims[0].verdict, 'not-proven');
  assert.ok(problems.includes('C1 case a: passed without evidence'));
  assert.equal(data.claims[0].evidence.length, 0);
});

test('approvalView checks the claims this run writes: shape, length, code, fields, id and target', () => {
  const { problems } = approvalView(doc([
    claim('C1', { statement: 'Invites are refused after twenty' }),
    claim('C2', { statement: 'The app refuses a name with a web link even when the name is long and has many many words in it' }),
    claim('C8', { statement: 'When an org has sent its 10th invite today, the app shows "You have reached the daily invite limit for your plan, try again tomorrow."' }),
    claim('C3', { statement: 'The app calls sendInvite() for each invite' }),
    claim('C4', { given: '' }),
    claim('X5'),
    claim('C6', { target: 'api' }),
    claim('C7', { statement: 'Old wording that broke the rules', fromLedger: true, rank: 'routine' }),
  ]), { targets: ['web'] });
  assert.deepEqual(problems, [
    'C1: statement starts with none of "The app", "When", "While", "If ... then", "Where"',
    'C2: statement has 22 words; the limit is 20',
    'C3: statement names code',
    'C4: missing given',
    'X5: id is not C<number> or a ledger id',
    'C6: target api has no definition or is not under ## Targets: ask for evidence setup to define it',
  ]);
});

test('listedTargets reads ## Targets and skips none', () => {
  assert.deepEqual(listedTargets('# E\n## Targets\n- Web: https://a.localhost\n- API: http://a.localhost/api, auth: none\n\n## Browser\n- Web: x'), ['web', 'api']);
  assert.equal(listedTargets('# E\n## Browser\n'), null);
});

test('sessionClaims keeps only the test fields', () => {
  const [c] = sessionClaims({ claims: [full('C1'), full('C2')] }, ['C2']);
  assert.deepEqual(Object.keys(c), ['id', 'statement', 'given', 'setup', 'cases', 'evidence', 'viewports']);
  assert.equal(c.id, 'C2');
});

test('sessionClaims keeps the order given, so claims that change shared state can run last', () => {
  const doc = { claims: [full('C1'), full('C2'), full('C3')] };
  assert.deepEqual(sessionClaims(doc, ['C3', 'C1', 'C3']).map((c) => c.id), ['C3', 'C1']);
});

const cli = (args) => execFileSync(process.execPath, [script, ...args], { encoding: 'utf8', stdio: 'pipe' });
const cliFails = (args, pattern) => assert.throws(() => cli(args), (e) => e.status === 1 && pattern.test(e.stderr));

test('--session writes the test fields of the named claims and refuses unknown ids', () => {
  const run = makeRun({ claims: [full('C1'), full('C2', { target: 'web' })] });
  assert.match(cli([run, '--session', '01-web-owner', 'C1,C2']), /Session: .*01-web-owner\.claims\.json \(2 claims\)/);
  const written = JSON.parse(readFileSync(join(run, 'sessions', '01-web-owner.claims.json'), 'utf8'));
  assert.deepEqual(written.map((c) => Object.keys(c).join()), ['id,statement,given,setup,cases,evidence', 'id,statement,given,setup,cases,evidence']);
  cliFails([run, '--session', '02', 'C9'], /unknown claim ids C9/);
  cliFails([run, '--session'], /Usage/);
});

test('--approve sets approvedAt only when the plan has no problems', () => {
  const bad = makeRun({ claims: [full('C1', { statement: 'no shape here', target: 'web' })] });
  cliFails([bad, '--approve'], /statement starts with none/);
  assert.equal(JSON.parse(readFileSync(join(bad, 'claims.json'), 'utf8')).approvedAt, undefined);
  const good = makeRun({ claims: [full('C1', { target: 'web' })] });
  assert.match(cli([good, '--approve']), /^Approved: \d{4}-/m);
  assert.match(JSON.parse(readFileSync(join(good, 'claims.json'), 'utf8')).approvedAt, /^\d{4}-\d\d-\d\dT/);
});

// The README's Security section promises these; this test keeps the promise true.
test('build-proof.mjs uses only node:crypto, node:fs, node:path and node:url, and no processes or network', () => {
  const source = readFileSync(script, 'utf8');
  const imports = [...source.matchAll(/\bimport\s*(?:[^'"()]*?\bfrom\s*)?['"]([^'"]+)['"]|\bimport\s*\(\s*['"]?([^'")]+)|\brequire\s*\(\s*['"]?([^'")]+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
  assert.deepEqual([...new Set(imports)].sort(), ['./ledger.mjs', './questions.mjs', './report.mjs', 'node:crypto', 'node:fs', 'node:path', 'node:url']);
  for (const banned of [/child_process/, /\bnode:(net|http|https|http2|dgram|dns|tls|worker_threads|vm)\b/, /\bfetch\s*\(/, /\bWebSocket\b/, /\beval\s*\(/, /\bnew Function\b/, /\bprocess\.(binding|dlopen)\b/]) {
    assert.doesNotMatch(source, banned);
  }
});

test('questions.mjs uses only node modules and the report writer, and no processes or network', () => {
  const source = readFileSync(fileURLToPath(new URL('../../skills/show-your-work/scripts/questions.mjs', import.meta.url)), 'utf8');
  const imports = [...source.matchAll(/\bimport\s*(?:[^'"()]*?\bfrom\s*)?['"]([^'"]+)['"]|\bimport\s*\(\s*['"]?([^'")]+)|\brequire\s*\(\s*['"]?([^'")]+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
  assert.deepEqual([...new Set(imports)].sort(), ['./report.mjs', 'node:crypto', 'node:fs', 'node:path', 'node:url']);
  for (const banned of [/child_process/, /\bnode:(net|http|https|http2|dgram|dns|tls|worker_threads|vm)\b/, /\bfetch\s*\(/, /\bWebSocket\b/, /\beval\s*\(/]) {
    assert.doesNotMatch(source, banned);
  }
});

test('ledger.mjs uses only node:crypto, node:fs, node:path and node:url, and no processes or network', () => {
  const source = readFileSync(fileURLToPath(new URL('../../skills/show-your-work/scripts/ledger.mjs', import.meta.url)), 'utf8');
  const imports = [...source.matchAll(/\bimport\s*(?:[^'"()]*?\bfrom\s*)?['"]([^'"]+)['"]|\bimport\s*\(\s*['"]?([^'")]+)|\brequire\s*\(\s*['"]?([^'")]+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
  assert.deepEqual([...new Set(imports)].sort(), ['node:crypto', 'node:fs', 'node:path', 'node:url']);
  for (const banned of [/child_process/, /\bnode:(net|http|https|http2|dgram|dns|tls|worker_threads|vm)\b/, /\bfetch\s*\(/, /\bWebSocket\b/, /\beval\s*\(/]) {
    assert.doesNotMatch(source, banned);
  }
});

const mismatchSetup = (verdict, why) => {
  const run = makeRun({ claims: [claim('C1', { cases })], files: { 'evidence/a.png': 'img' } });
  const lines = [{ ...ev('C1', 'a', 'evidence/a.png', 'img'), n: 1 }];
  const checks = [{ file: 'evidence/a.png', sha256: sha('img'), verdict, why }];
  return checkEvidence(run, lines, [claim('C1', { cases })], checks);
};

test('checkEvidence: a mismatch does not count and is listed', () => {
  const { keys, ok, problems } = mismatchSetup('mismatch', 'shows the sign-in page');
  assert.equal(keys.size, 0);
  assert.equal(ok.size, 0);
  assert.deepEqual(problems, ['evidence.jsonl line 1: check says mismatch evidence/a.png: shows the sign-in page']);
});

test('checkEvidence: one mismatch file takes the whole case out', () => {
  const run = makeRun({ claims: [claim('C1', { cases })], files: { 'evidence/a.png': 'img', 'evidence/a-2.png': 'img2' } });
  const lines = [{ ...ev('C1', 'a', 'evidence/a.png', 'img'), n: 1 }, { ...ev('C1', 'a', 'evidence/a-2.png', 'img2'), n: 2 }];
  const checks = [{ file: 'evidence/a-2.png', sha256: sha('img2'), verdict: 'mismatch', why: 'shows the sign-in page' }];
  const { keys, problems } = checkEvidence(run, lines, [claim('C1', { cases })], checks);
  assert.equal(keys.has('C1:a'), false);
  assert.deepEqual(problems, ['evidence.jsonl line 2: check says mismatch evidence/a-2.png: shows the sign-in page']);
});

test('checkEvidence: a mismatch takes out a case run at a viewport, every viewport key included', () => {
  const run = makeRun({ claims: [wide({ cases })], files: { 'evidence/C1-a-mobile.webm': 'vid', 'evidence/C1-a-mobile-step-05.png': 'png' } });
  const lines = [
    { ...ev('C1', 'a', 'evidence/C1-a-mobile.webm', 'vid', { viewport: 'mobile' }), n: 1 },
    { ...ev('C1', 'a', 'evidence/C1-a-mobile-step-05.png', 'png', { viewport: 'mobile' }), n: 2 },
  ];
  const checks = [{ file: 'evidence/C1-a-mobile-step-05.png', sha256: sha('png'), verdict: 'mismatch', why: 'shows the mail page' }];
  const { keys } = checkEvidence(run, lines, [wide({ cases })], checks);
  assert.deepEqual([...keys], []);
});

test('checkEvidence: unclear still counts and is listed', () => {
  const { keys, ok, problems } = mismatchSetup('unclear', 'cannot view video');
  assert.ok(keys.has('C1:a'));
  assert.equal(ok.size, 1);
  assert.deepEqual(problems, ['evidence.jsonl line 1: check unclear evidence/a.png: cannot view video']);
});

test('checkEvidence: a not-shown file proves nothing, but leaves the case\'s other files', () => {
  const { keys, ok, problems } = mismatchSetup('not-shown', 'the totals are off screen');
  assert.equal(keys.size, 0);
  assert.equal(ok.size, 1);
  assert.deepEqual(problems, ['evidence.jsonl line 1: check says not shown evidence/a.png: the totals are off screen']);
  const run = makeRun({ claims: [claim('C1', { target: 'api', cases })], files: { 'evidence/C1-a.txt': 'body', 'evidence/C1-a.png': 'img' } });
  const lines = [{ ...ev('C1', 'a', 'evidence/C1-a.txt', 'body'), n: 1 }, { ...ev('C1', 'a', 'evidence/C1-a.png', 'img'), n: 2 }];
  const checks = [{ file: 'evidence/C1-a.png', sha256: sha('img'), verdict: 'not-shown', why: 'other tab' }];
  assert.ok(checkEvidence(run, lines, [claim('C1', { target: 'api', cases })], checks).keys.has('C1:a'));
});

test('checkEvidence: a web case whose expect no screen shows is proven by a text file the check marks proves', () => {
  const run = makeRun({ claims: [claim('C1', { target: 'web', cases })], files: { 'evidence/C1-a-response.txt': '201', 'evidence/C1-a.webm': 'vid' } });
  const lines = [{ ...ev('C1', 'a', 'evidence/C1-a-response.txt', '201'), n: 1 }, { ...ev('C1', 'a', 'evidence/C1-a.webm', 'vid'), n: 2 }];
  const notShown = { file: 'evidence/C1-a.webm', sha256: sha('vid'), verdict: 'not-shown', why: 'no status on screen' };
  const without = checkEvidence(run, lines, [claim('C1', { target: 'web', cases })], [{ file: 'evidence/C1-a-response.txt', sha256: sha('201'), verdict: 'matches', why: 'raw capture' }, notShown]);
  assert.equal(without.keys.has('C1:a'), false);
  const proved = checkEvidence(run, lines, [claim('C1', { target: 'web', cases })], [{ file: 'evidence/C1-a-response.txt', sha256: sha('201'), verdict: 'matches', proves: true, why: 'status 201' }, notShown]);
  assert.ok(proved.keys.has('C1:a'));
  assert.deepEqual(proved.problems, []);
});

test('chatSummary splits not proven by cause and names missing fixtures once', () => {
  const data = { kind: 'proof', title: 'Quotes', tally: { proven: 0, disproved: 0, notProven: 3 }, bugs: [], decisions: { count: 0, defaults: [] }, claims: [
    { id: 'C1', statement: 'a', verdict: 'not-proven', cause: 'no evidence', cases: [{ id: 'a', result: 'pass' }] },
    { id: 'C2', statement: 'b', verdict: 'not-proven', cause: 'blocked', cases: [{ id: 'a', result: 'blocked', note: 'needs fixture: a HEIC camera photo' }] },
    { id: 'C3', statement: 'c', verdict: 'not-proven', cause: 'blocked', cases: [{ id: 'a', result: 'blocked', note: 'needs fixture: a HEIC camera photo' }] },
  ] };
  const lines = chatSummary(data, 'file:///x').split('\n');
  assert.equal(lines[0], 'Proof: Quotes: 0 proven · 0 disproved · 3 not proven (1 passed, no file shows it · 2 blocked)');
  assert.equal(lines[1], 'Add to the Fixtures: folder in environment.md: a HEIC camera photo');
});

test('a fail its own evidence contradicts disproves nothing, and its bug is not confirmed', () => {
  const run = makeRun({
    claims: [claim('C1', { target: 'api', cases })],
    sessions: { s1: [{ claim: 'C1', case: 'a', result: 'fail', bug: 'BUG-001' }] },
    evidence: [ev('C1', 'a', 'evidence/C1-a.txt', 'no toast'), { ...ev(undefined, undefined, 'bugs/BUG-001-x/C1-a.txt', 'no toast'), claim: undefined, case: undefined, bug: 'BUG-001' }],
    bugs: { 'BUG-001-x': { id: 'BUG-001', claim: 'C1', case: 'a', title: 'No message', severity: 'minor' } },
    files: { 'evidence/C1-a.txt': 'no toast', 'bugs/BUG-001-x/C1-a.txt': 'no toast', 'evidence-check.jsonl': jsonl([{ file: 'evidence/C1-a.txt', sha256: sha('no toast'), verdict: 'mismatch', why: 'frames 5 to 9 show the toast' }]) },
  });
  const { data, problems } = buildProof(run);
  assert.equal(data.claims[0].verdict, 'not-proven');
  assert.equal(data.claims[0].cases[0].result, 'blocked');
  assert.ok(problems.includes('C1 case a: unclear: failed, but its evidence contradicts the note: frames 5 to 9 show the toast'));
  assert.deepEqual([...contradicted(run)], [['BUG-001', 'frames 5 to 9 show the toast']]);
});

test('a fail stands when only a retry\'s file is a mismatch: its bug copies match', () => {
  const run = makeRun({
    claims: [claim('C1', { target: 'api', cases })],
    sessions: { s1: [{ claim: 'C1', case: 'a', result: 'fail', bug: 'BUG-001' }] },
    evidence: [ev('C1', 'a', 'evidence/C1-a.txt', 'error'), ev('C1', 'a', 'evidence/C1-a-2.txt', 'retry'), { ...ev(undefined, undefined, 'bugs/BUG-001-x/C1-a.txt', 'error'), claim: undefined, case: undefined, bug: 'BUG-001' }],
    bugs: { 'BUG-001-x': { id: 'BUG-001', claim: 'C1', case: 'a', title: 'Error', severity: 'minor' } },
    files: { 'evidence/C1-a.txt': 'error', 'evidence/C1-a-2.txt': 'retry', 'bugs/BUG-001-x/C1-a.txt': 'error', 'evidence-check.jsonl': jsonl([{ file: 'evidence/C1-a-2.txt', sha256: sha('retry'), verdict: 'mismatch', why: 'stopped early' }]) },
  });
  const { data } = buildProof(run);
  assert.equal(data.claims[0].verdict, 'disproved');
  assert.deepEqual([...contradicted(run)], []);
});

test('checkEvidence applies a check only to the file and hash it names', () => {
  const run = makeRun({ claims: [claim('C1', { cases })], files: { 'evidence/a.png': 'new' } });
  const lines = [{ ...ev('C1', 'a', 'evidence/a.png', 'new'), n: 1 }];
  const checks = [{ file: 'evidence/a.png', sha256: sha('old'), verdict: 'mismatch', why: 'x' }];
  const { keys, problems } = checkEvidence(run, lines, [claim('C1', { cases })], checks);
  assert.ok(keys.has('C1:a'));
  assert.deepEqual(problems, []);
});

test('checkEvidence skips failed-method lines', () => {
  const run = makeRun({ claims: [claim('C1', { cases })] });
  const lines = [{ claim: 'C1', case: 'a', method: 'failed: Claude in Chrome gif_creator: no download', n: 1 }];
  const { keys, problems } = checkEvidence(run, lines, [claim('C1', { cases })]);
  assert.equal(keys.size, 0);
  assert.deepEqual(problems, []);
});

test('checkEvidence checks bug and explorer lines but counts them for no case', () => {
  const run = makeRun({ claims: [claim('C1', { cases })], files: { 'bugs/BUG-001-x/repro.gif': 'g', 'evidence/T1-3.png': 'p' } });
  const lines = [
    { bug: 'BUG-001', file: 'bugs/BUG-001-x/repro.gif', sha256: sha('g'), method: 'gif', n: 1 },
    { by: 'T1', file: 'evidence/T1-3.png', sha256: sha('p'), method: 'screenshot', n: 2 },
    { bug: 'BUG-002', file: 'bugs/BUG-002-y/repro.gif', sha256: sha('h'), method: 'gif', n: 3 },
  ];
  const { keys, ok, problems } = checkEvidence(run, lines, [claim('C1', { cases })]);
  assert.equal(keys.size, 0);
  assert.equal(ok.size, 2);
  assert.deepEqual(problems, ['evidence.jsonl line 3: file missing bugs/BUG-002-y/repro.gif']);
});

test('buildProof: an exploring run with no claims reports its bugs, worst first, with their evidence', () => {
  const run = makeRun({
    evidence: [{ bug: 'BUG-002', file: 'bugs/BUG-002-b/repro.gif', sha256: sha('g'), method: 'gif', at: '2026-10-29T00:00:00Z' }],
    files: {
      'charters/T1.jsonl': jsonl([{ n: 1, charter: 'T1', action: 'send 11 invites', result: 'bug', bug: 'BUG-002' }]),
      'charters.json': JSON.stringify({ title: 'Team invites', approvedBy: 'auto', charters: [] }),
      'bugs/BUG-001-a/bug.json': JSON.stringify({ id: 'BUG-001', title: 'Typo on the team page', severity: 'cosmetic' }),
      'bugs/BUG-002-b/bug.json': JSON.stringify({ id: 'BUG-002', title: 'The 11th invite goes out', severity: 'major' }),
      'bugs/BUG-002-b/repro.gif': 'g',
    },
  });
  rmSync(join(run, 'claims.json'), { force: true });
  const { data, problems } = buildProof(run);
  assert.deepEqual(problems, []);
  assert.equal(data.kind, 'explore');
  assert.equal(data.title, 'Team invites');
  assert.deepEqual(data.bugs.map((b) => b.id), ['BUG-002', 'BUG-001']);
  assert.equal(data.bugs[0].evidence.length, 1);
  assert.equal(data.sessions[0].id, 'T1');
  assert.equal(chatSummary(data, 'file:///x'), [
    'Explore: Team invites: 2 bugs (1 major · 1 cosmetic)',
    '✗ BUG-002 [major] The 11th invite goes out',
    '✗ BUG-001 [cosmetic] Typo on the team page',
    'Auto mode: 0 decisions, see decisions.md',
    'Open: file:///x',
  ].join('\n'));
});

test('chatSummary lists gaps apart from bugs, and says which pass found the bugs', () => {
  const data = { kind: 'explore', title: 'Quotes', questions: [], claims: [], tally: {}, decisions: { count: 0, defaults: [] }, bugs: [
    { id: 'BUG-001', title: 'Save error names no field', severity: 'minor', origin: 'blind' },
    { id: 'BUG-002', title: 'Asterisks show in bold italic', severity: 'cosmetic', origin: 'lead' },
    { id: 'BUG-003', title: 'No switch to hide the deposit line', severity: 'minor', kind: 'gap', origin: 'blind' },
  ] };
  assert.equal(chatSummary(data, 'file:///x'), [
    'Explore: Quotes: 2 bugs (1 minor · 1 cosmetic; 1 blind, 1 lead), 1 gap',
    '✗ BUG-001 [minor] Save error names no field',
    '✗ BUG-002 [cosmetic] Asterisks show in bold italic',
    '+ BUG-003 [gap] No switch to hide the deposit line',
    'Open: file:///x',
  ].join('\n'));
});

test('a bug whose own picture the check contradicts is not confirmed, and not counted', () => {
  const run = mkdtempSync(join(tmpdir(), 'unconfirmed-'));
  writeFileSync(join(run, 'evidence.jsonl'), [
    { bug: 'BUG-001', file: 'bugs/BUG-001-x/found.png', sha256: 'a' },
    { bug: 'BUG-001', file: 'bugs/BUG-001-x/network.txt', sha256: 'b' },
    { bug: 'BUG-002', file: 'bugs/BUG-002-y/network.txt', sha256: 'c' },
    { bug: 'BUG-003', file: 'bugs/BUG-003-z/step-01.png', sha256: 'd' },
    { bug: 'BUG-004', file: 'bugs/BUG-004-w/found.png', sha256: 'e' },
    { bug: 'BUG-004', file: 'bugs/BUG-004-w/found.txt', sha256: 'f' },
  ].map((l) => JSON.stringify(l)).join('\n'));
  writeFileSync(join(run, 'evidence-check.jsonl'), [
    { file: 'bugs/BUG-001-x/found.png', sha256: 'a', verdict: 'mismatch', why: 'shows a red toast' },
    { file: 'bugs/BUG-002-y/network.txt', sha256: 'c', verdict: 'mismatch', why: 'no 400' },
    { file: 'bugs/BUG-003-z/step-01.png', sha256: 'd', verdict: 'mismatch', why: 'taken before the save' },
    { file: 'bugs/BUG-004-w/found.png', sha256: 'e', verdict: 'mismatch', why: 'shows the dashboard' },
    { file: 'bugs/BUG-004-w/found.txt', sha256: 'f', verdict: 'matches', why: 'PUT 200 with the html body' },
  ].map((l) => JSON.stringify(l)).join('\n'));
  assert.deepEqual([...contradicted(run)], [['BUG-001', 'shows a red toast']], 'only the picture or recording of the failure as found decides, never a replay still; a matching found.txt keeps the bug');
  const data = { kind: 'explore', title: 'Quotes', questions: [], claims: [], tally: {}, decisions: { count: 0, defaults: [] }, bugs: [
    { id: 'BUG-001', title: 'Save refused with no message', severity: 'major', unconfirmed: 'shows a red toast' },
    { id: 'BUG-002', title: 'Decline sticks out', severity: 'minor' },
    { id: 'BUG-003', title: 'Deleting the default leaves none', severity: 'minor', withdrawn: 'the editor warns first' },
    { id: 'BUG-004', title: 'Decline sticks out', severity: 'minor', duplicateOf: 'BUG-002' },
  ] };
  assert.equal(chatSummary(data, 'file:///x'), [
    'Explore: Quotes: 1 bugs (1 minor)',
    '✗ BUG-002 [minor] Decline sticks out',
    '? BUG-001 not confirmed: shows a red toast',
    '- BUG-003 withdrawn: the editor warns first',
    '- BUG-004 withdrawn: a duplicate of BUG-002',
    'Open: file:///x',
  ].join('\n'));
});

test('buildProof reads evidence-check.jsonl', () => {
  const run = makeRun({
    claims: [claim('C1', { target: 'api', cases })],
    sessions: { s1: [{ claim: 'C1', case: 'a', result: 'pass' }] },
    evidence: [ev('C1', 'a', 'evidence/C1-a.txt', 'http')],
    files: { 'evidence/C1-a.txt': 'http', 'evidence-check.jsonl': jsonl([{ file: 'evidence/C1-a.txt', sha256: sha('http'), verdict: 'mismatch', why: 'wrong page' }]) },
  });
  const { data, problems } = buildProof(run);
  assert.equal(data.claims[0].verdict, 'not-proven');
  assert.ok(problems.includes('evidence.jsonl line 1: check says mismatch evidence/C1-a.txt: wrong page'));
  assert.ok(problems.includes('C1 case a: passed without evidence'));
});

test('buildProof flags a per-session evidence log that was not joined', () => {
  const x = ev('C1', 'a', 'evidence/x.txt', 'x');
  const y = ev('C1', 'a', 'evidence/y.txt', 'y');
  const base = { claims: [claim('C1', { target: 'api', cases })], files: { 'evidence/x.txt': 'x', 'evidence/y.txt': 'y' } };
  const bad = buildProof(makeRun({ ...base, evidence: [x], files: { ...base.files, 'evidence-s2.jsonl': jsonl([y]) } }));
  assert.ok(bad.problems.includes('evidence-s2.jsonl line 1: not joined into evidence.jsonl'));
  const good = buildProof(makeRun({ ...base, evidence: [x], files: { ...base.files, 'evidence-s2.jsonl': jsonl([x]) } }));
  assert.ok(!good.problems.some((p) => p.includes('not joined')));
});

test('buildProof: a run with no evidence check gives the same result as before', () => {
  const run = makeRun({
    claims: [claim('C1', { target: 'web', cases }), claim('C2', { target: 'web', cases }), claim('C3', { target: 'api', cases })],
    sessions: { s1: ['C1', 'C2', 'C3'].map((id) => ({ claim: id, case: 'a', result: 'pass' })) },
    evidence: [ev('C1', 'a', 'evidence/C1-a.txt', 'dom'), ev('C2', 'a', 'evidence/C2-a.txt', 'dom2'), ev('C2', 'a', 'evidence/C2-a.png', 'img'), ev('C3', 'a', 'evidence/C3-a.txt', 'http')],
    files: { 'evidence/C1-a.txt': 'dom', 'evidence/C2-a.txt': 'dom2', 'evidence/C2-a.png': 'img', 'evidence/C3-a.txt': 'http' },
  });
  const { data, problems } = buildProof(run);
  const verdict = (id) => data.claims.find((c) => c.id === id).verdict;
  assert.deepEqual(['C1', 'C2', 'C3'].map(verdict), ['not-proven', 'proven', 'proven']);
  assert.ok(!problems.some((p) => p.includes('check')));
});

test('buildProof lists a failed capture as a problem', () => {
  const run = makeRun({
    claims: [claim('C1', { target: 'web', cases })],
    evidence: [{ claim: 'C1', case: 'a', method: 'failed: Claude in Chrome gif_creator: no download' }],
  });
  const { problems } = buildProof(run);
  assert.ok(problems.includes('C1 case a: capture failed: Claude in Chrome gif_creator: no download'));
});

const wide = (extra = {}) => claim('C1', { target: 'web', viewports: ['desktop', 'mobile'], cases: [{ id: 'a' }], ...extra });

test('caseResults also keys each attempt by its viewport', () => {
  const map = caseResults([{ id: 's', steps: [
    { claim: 'C1', case: 'a', viewport: 'desktop', result: 'pass' },
    { claim: 'C1', case: 'a', viewport: 'mobile', result: 'fail', bug: 'BUG-001' },
  ] }]);
  assert.equal(map.get('C1:a@desktop').result, 'pass');
  assert.equal(map.get('C1:a@mobile').result, 'fail');
  assert.equal(map.get('C1:a').result, 'fail');
});

test('claimVerdict with viewports: proven only with a pass and evidence at every one', () => {
  const all = results({ 'C1:a': 'pass', 'C1:a@desktop': 'pass', 'C1:a@mobile': 'pass' });
  assert.equal(claimVerdict(wide(), all, new Set(['C1:a', 'C1:a@desktop', 'C1:a@mobile'])).verdict, 'proven');
  const v = claimVerdict(wide(), all, new Set(['C1:a', 'C1:a@desktop']));
  assert.equal(v.verdict, 'not-proven');
  assert.deepEqual(v.problems, ['C1 case a: passed without visual evidence at mobile']);
  assert.deepEqual(v.cases[0].viewports, { desktop: 'pass', mobile: 'pass' });
});

test('claimVerdict with viewports: a viewport not run leaves the case not run', () => {
  const v = claimVerdict(wide(), results({ 'C1:a': 'pass', 'C1:a@desktop': 'pass' }), new Set(['C1:a', 'C1:a@desktop']));
  assert.equal(v.verdict, 'not-proven');
  assert.equal(v.cases[0].result, 'not-run');
  assert.deepEqual(v.cases[0].viewports, { desktop: 'pass', mobile: 'not-run' });
});

test('claimVerdict with viewports: a fail at one viewport, or a fail logged without one, disproves', () => {
  const v = claimVerdict(wide(), results({ 'C1:a': 'fail', 'C1:a@desktop': 'pass', 'C1:a@mobile': 'fail' }), new Set(['C1:a', 'C1:a@desktop', 'C1:a@mobile']));
  assert.equal(v.verdict, 'disproved');
  assert.equal(claimVerdict(wide(), results({ 'C1:a': 'fail' }), new Set()).verdict, 'disproved');
});

test('checkEvidence also keys a line by its viewport', () => {
  const run = makeRun({ claims: [wide({ cases })], files: { 'evidence/C1-a-mobile.png': 'png' } });
  const { keys } = checkEvidence(run, [ev('C1', 'a', 'evidence/C1-a-mobile.png', 'png', { viewport: 'mobile' })], [wide({ cases })]);
  assert.deepEqual([...keys].sort(), ['C1:a', 'C1:a@mobile']);
});

test('approvalView shows viewports and checks them', () => {
  const { text, problems } = approvalView(doc([
    claim('C1', { viewports: ['desktop', 'mobile'] }),
    claim('C2', { target: 'api', viewports: ['mobile'] }),
    claim('C3', { viewports: ['watch'] }),
    claim('C4', { viewports: 'mobile' }),
  ]), { viewports: ['desktop', 'tablet', 'mobile'] });
  assert.match(text, /1\. C1 The app keeps C1 \[desktop, mobile\]/);
  assert.deepEqual(problems, [
    'C2: viewports on a api claim; only targets with viewports have them',
    'C3: viewport watch is not under Viewports in environment.md Preferences',
    'C4: viewports is not a list of names',
  ]);
});

test('listedViewports reads the names from Preferences', () => {
  assert.deepEqual(listedViewports('# E\n## Preferences\n- Viewports: desktop 1440×900, tablet 768×1024, mobile 390×844 (the first is primary)\n'), ['desktop', 'tablet', 'mobile']);
  assert.equal(listedViewports('# E\n## Targets\n'), null);
});

test('ledgerFiles writes the viewports of a claim', () => {
  assert.match(page(run1([{ ...full('C1', { viewports: ['desktop', 'mobile'] }), verdict: 'proven' }]).claims), /<dt>Viewports<\/dt><dd>desktop, mobile<\/dd>/);
});

test('buildProof: evidence from an older commit than the run\'s latest does not count', () => {
  const run = makeRun({
    claims: [claim('C1', { target: 'api', cases }), claim('C2', { target: 'api', cases })],
    sessions: { s1: [{ claim: 'C1', case: 'a', result: 'pass' }, { claim: 'C2', case: 'a', result: 'pass' }] },
    evidence: [
      ev('C1', 'a', 'evidence/C1-a.txt', 'old', { commit: 'abc123+dirty:1111', at: '2026-10-27T10:00:00Z' }),
      ev('C2', 'a', 'evidence/C2-a.txt', 'new', { commit: 'abc123+dirty:2222', at: '2026-10-27T11:00:00Z' }),
    ],
    files: { 'evidence/C1-a.txt': 'old', 'evidence/C2-a.txt': 'new' },
  });
  const { data, problems } = buildProof(run);
  assert.equal(data.claims.find((c) => c.id === 'C1').verdict, 'not-proven');
  assert.equal(data.claims.find((c) => c.id === 'C2').verdict, 'proven');
  assert.ok(problems.includes('evidence.jsonl line 1: captured on abc123+dirty:1111, but the run\'s latest code is abc123+dirty:2222: capture it again'));
});

test('buildProof: a file in evidence/ or a bug folder that no log line names is a problem', () => {
  const run = makeRun({
    claims: [claim('C1', { target: 'api', cases })],
    evidence: [ev('C1', 'a', 'evidence/C1-a.txt', 'x')],
    bugs: { 'BUG-001-x': { id: 'BUG-001' } },
    files: { 'evidence/C1-a.txt': 'x', 'evidence/C1-a-2.txt': 'y', 'bugs/BUG-001-x/repro.gif': 'g', 'bugs/.BUG-001': '', 'evidence/.marker-C1-a': '' },
  });
  const { problems } = buildProof(run);
  assert.ok(problems.includes('evidence/C1-a-2.txt: not in evidence.jsonl'));
  assert.ok(problems.includes('bugs/BUG-001-x/repro.gif: not in evidence.jsonl'));
  assert.equal(problems.filter((p) => p.endsWith('not in evidence.jsonl')).length, 2);
});

test('buildProof: names evidence files that hold a secret, and flags a secret in a log line, without printing either', () => {
  const token = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
  const files = {
    'evidence/C1-a-request.txt': `GET /x\nAuthorization: Bearer ${token}\n`,
    'evidence/C1-a-response.txt': 'HTTP/1.1 200\ncontent-type: application/json\n',
    'evidence/C1-a-body.txt': '{"org": "org-1", "token": "c42c6a90-f8d3-4d9e-bb6f-2d0e7857182b"}',
  };
  const evidence = Object.entries(files).map(([f, text]) => ev('C1', 'a', f, text, { target: 'api', note: 'token <redacted>' }));
  evidence[1].note = `200 with ${token}`;
  const run = makeRun({ claims: [claim('C1', { target: 'api', cases })], evidence, files });
  const { problems } = buildProof(run);
  assert.deepEqual(problems.filter((p) => p.includes('secret')), [
    'evidence.jsonl line 2: a secret in a log line (JSON web token); write it as <redacted>',
    'evidence/C1-a-request.txt: holds a secret (authorization header); redact it before you share it',
    'evidence/C1-a-body.txt: holds a secret (token or password field); redact it before you share it',
  ]);
  assert.ok(!problems.some((p) => p.includes(token) || p.includes('c42c6a90')));
});

test('buildProof: a quick build (verify false) reads no capture for secrets, only the log lines', () => {
  const files = { 'evidence/C1-a-body.txt': '{"org": "org-1", "token": "c42c6a90-f8d3-4d9e-bb6f-2d0e7857182b"}' };
  const evidence = Object.entries(files).map(([f, text]) => ev('C1', 'a', f, text, { target: 'api' }));
  const run = makeRun({ claims: [claim('C1', { target: 'api', cases })], evidence, files });
  assert.ok(!buildProof(run, { verify: false }).problems.some((p) => p.includes('holds a secret')));
});

test('buildProof: in an exploring run, a proven claim from a finding is marked not reproduced', () => {
  const mk = (explore) => {
    const run = makeRun({
      claims: [claim('C1', { target: 'api', cases, source: 'found: BUG-001' }), claim('C2', { target: 'api', cases, source: 'the user\'s words' })],
      sessions: { s1: [{ claim: 'C1', case: 'a', result: 'pass' }, { claim: 'C2', case: 'a', result: 'pass' }] },
      evidence: [ev('C1', 'a', 'evidence/C1-a.txt', 'x'), ev('C2', 'a', 'evidence/C2-a.txt', 'y')],
      files: { 'evidence/C1-a.txt': 'x', 'evidence/C2-a.txt': 'y', ...(explore && { 'charters/T1.jsonl': '' }) },
    });
    return buildProof(run).data;
  };
  const explored = mk(true);
  const c1 = explored.claims.find((c) => c.id === 'C1');
  assert.equal(c1.verdict, 'proven');
  assert.equal(c1.notReproduced, true);
  assert.equal(explored.claims.find((c) => c.id === 'C2').notReproduced, undefined);
  assert.equal(explored.tally.proven, 2);
  assert.match(chatSummary(explored, 'file:///x'), /^\? C1 The app keeps C1 \(found: BUG-001; not reproduced\)$/m);
  // A re-prove run has no charters/ folder: a fixed bug is plainly proven.
  assert.equal(mk(false).claims.find((c) => c.id === 'C1').notReproduced, undefined);
});

test('listedViewports ignores a device note in brackets', () => {
  assert.deepEqual(listedViewports('## Preferences\n- Viewports: desktop 1440×900, mobile 390×844 (device: iPhone 14) (the first is primary)\n'), ['desktop', 'mobile']);
});

test('projectDir goes three folders up from a step, and to the parent of a folder outside the layout', () => {
  assert.equal(projectDir('/p/.evident/invites/2026-10-27-0900-prove/proof'), '/p/.evident');
  assert.equal(projectDir('/p/app/r'), '/p/app');
});

test('the index opens with what needs you, then one card per feature, most urgent first, each with a mark per bug or check', () => {
  const req = (feature, name, counts, extra = {}) => ({ name, feature, kind: name.replace(/^[\d-]{16}/, ''), date: name.slice(0, 10), live: false, counts, ...extra });
  const html = indexHtml('acme', [
    req('invites', '2026-10-01-0900-prove', { needsYou: 2, checks: 3, ownChecks: 3, checksProven: 1, checksFailed: 1, checksUnproven: 1 }),
    req('invites', '2026-10-05-1430-explore-and-fix', { found: 3, fixed: 2, proven: 2, needsYou: 1, questions: 1 }, { auto: true, bugs: [
      { id: 'BUG-001', anchor: 'BUG-001', severity: 'minor', title: 'Small', state: 'Fixed and proven' },
      { id: 'BUG-002', anchor: 'BUG-002', severity: 'major', title: 'Card <saved> twice', needsYou: true, state: 'Waiting for your decision' }] }),
    req('billing', '2026-10-03-0900-explore', { found: 1, fixed: 0, proven: 0, needsYou: 0 }, { live: true, bugs: [{ id: 'BUG-001', severity: 'critical', title: 'Paid twice', state: 'Fix not requested' }] }),
    req('search', '2026-10-02-0900-prove', { needsYou: 0, checks: 2, ownChecks: 2, checksProven: 2, checksFailed: 0, checksUnproven: 0 }),
  ]);
  assert.match(html, /<h1 class="wait">1 thing needs you, in invites\.<\/h1>/);
  assert.match(html, /<p class="sub">1 question waits for you\. billing is running now\.<\/p>/);
  assert.match(indexHtml('acme', [req('a', '2026-10-05-1430-explore', { found: 0, questions: 2 })]), /<h1 class="wait">2 questions wait for you\.<\/h1>/);
  assert.match(html, /<meta http-equiv="refresh" content="30">/, 'a running request reloads the index');
  assert.match(html, /<header class="brand"><svg class="logo"[^>]*>[\s\S]*?<\/svg><b>evident<\/b><span>acme<\/span><\/header>/, 'the logo stands next to the name');
  assert.match(html, /<body class="live">/, 'a page that reloads does not replay its opening');
  const cards = html.match(/<a class="feat [a-z]+"[^>]*>[\s\S]*?<\/a>/g);
  assert.deepEqual(cards.map((c) => c.match(/class="name">([^<]+)/)[1]), ['invites', 'billing', 'search'], 'what waits on you, then what runs, then the rest');
  assert.deepEqual(cards.map((c) => c.match(/class="feat ([a-z]+)"/)[1]), ['wait', 'run', 'good']);
  const [invites, billing, search] = cards;
  assert.match(invites, /^<a class="feat wait" href="invites\/2026-10-05-1430-explore-and-fix\/report\.html" style="--c:0">/);
  assert.match(invites, /<div class="what">Explore and fix, auto, 5 Oct at 14:30<\/div>/);
  assert.match(invites, /<span class="chip">1 needs you<\/span>/);
  assert.match(invites, /<div class="tally" aria-hidden="true"><i class="good" style="--i:0"><\/i><i class="wait" style="--i:1"><\/i><\/div>/, 'one mark per bug, from proven to what waits on you');
  assert.doesNotMatch(invites, /BUG-00|Card/, 'the bugs are on the request page, not here');
  const plain = (s) => s.replace(/<[^>]+>/g, '').replace(/&nbsp;| /g, ' ');
  assert.match(plain(invites.match(/<p class="counts">[\s\S]*?<\/p>/)[0]), /^3 found 2 fixed 2 proven 1 question$/);
  assert.match(invites, /<span class="k good">2&nbsp;proven<\/span> <span class="k wait">1&nbsp;question<\/span>/, 'a line breaks only between counts, never between a number and its label');
  assert.match(billing, /<span class="chip">Running now<\/span>/);
  assert.match(billing, /<div class="tally" aria-hidden="true"><i class="idle" style="--i:0"><\/i><\/div>/);
  assert.match(billing, /<span class="k">1&nbsp;found<\/span><\/p>/, 'zero counts are left out');
  assert.match(search, /2&nbsp;checks:&nbsp;<span class="k good">2&nbsp;proven<\/span><\/p>/, 'the colour is the count\'s, not the label\'s');
  assert.match(search, /<i class="good" style="--i:0"><\/i><i class="good" style="--i:1"><\/i><\/div>/, 'a proof marks each check');
  assert.doesNotMatch(search, /class="chip"/, 'a calm card has no state to say');
  const old = indexHtml('acme', [req('a', '2026-10-05-1430-explore-and-fix', { found: 3, fixed: 2, proven: 1, needsYou: 0 })]);
  assert.match(old, /<i class="good" style="--i:0"><\/i><i class="run" style="--i:1"><\/i><i class="idle" style="--i:2"><\/i>/, 'a summary without its bugs still marks them from its counts');
  assert.match(old, /<body>/);
  const older = html.slice(html.indexOf('<summary>Earlier requests'));
  assert.match(older, /^<summary>Earlier requests <span class="n">1<\/span><\/summary>/);
  assert.match(older, /<a href="invites\/2026-10-01-0900-prove\/report\.html">invites, proof<\/a>, 1 Oct at 09:00/);
  assert.match(plain(older), /3 checks: 1 proven 1 failed 1 not proven/);
  assert.doesNotMatch(html, /<table|<script|proof\.html|Ledger/);
  assert.doesNotMatch(html, /prefers-color-scheme|light dark/, 'light only');
});

test('the index names the app the .evident folder sits in', () => {
  const project = join(mkdtempSync(join(tmpdir(), 'app-')), 'acme-web', '.evident');
  mkdirSync(project, { recursive: true });
  assert.match(readFileSync(writeIndex(project), 'utf8'), /<b>evident<\/b><span>acme-web<\/span>/);
});

test('the index of a project with nothing in it says so', () => {
  assert.match(indexHtml('acme', []), /<h1 class="good">Nothing has run yet\.<\/h1>/);
  assert.doesNotMatch(indexHtml('acme', []), /refresh|Earlier requests/);
});

test('the index links to the ledger page in one line, and names its problems', () => {
  const html = indexHtml('acme', [], { terms: [], problems: ['billing.jsonl: has git conflict markers'],
    claims: [full('C1', { verdict: 'proven' }), full('C2', { verdict: 'disproved' }), full('C3', { status: 'retired', retiredReason: 'gone' })] });
  assert.match(html, /<p class="bad">Problem: billing\.jsonl: has git conflict markers<\/p>\n<p class="ledger-link"><a href="ledger\.html">Ledger<\/a> <span class="n">2 claims, 1 disproved<\/span><\/p>/);
  assert.doesNotMatch(html, /<b>C1<\/b>|<dt>/, 'the claims are on their own page');
});

test('the ledger page filters by verdict and by feature without a script, and searches with one', () => {
  const html = ledgerPage('acme', { terms: [{ term: 'seat', means: 'a <paid> member' }], problems: ['billing.jsonl: has git conflict markers'],
    claims: [full('C1', { tags: ['invites', 'limits'], verdict: 'proven' }), full('C2', { tags: ['invites'], verdict: 'disproved' }), full('C3', { tags: ['billing'], status: 'retired', retiredReason: 'gone' }), full('C4', { tags: ['billing'] })] });
  assert.match(html, /<header class="brand"><svg class="logo"[\s\S]*?<b>evident<\/b><span>acme<\/span><\/header>\n<p class="back"><a href="index\.html">All requests<\/a><\/p>\n<h1>Ledger<\/h1>/);
  assert.match(html, /<p class="sub">What the app should do, with each claim's latest verdict\. 3 claims, 1 retired, tagged with 3 features\.<\/p>/);
  assert.match(html, /<p class="bad">Problem: billing\.jsonl: has git conflict markers<\/p>/);
  for (const [id, label] of [['v-all', 'All 4'], ['v-need', 'Disproved 1'], ['v-wait', 'Not proven 1'], ['v-good', 'Proven 1'], ['v-retired', 'Retired 1']]) assert.match(html, new RegExp(`<input type="radio" name="v" id="${id}"[^>]*><label for="${id}">${label}</label>`));
  assert.match(html, /<input type="radio" name="t" id="t-all" checked><label for="t-all">All features<\/label><input type="radio" name="t" id="t-0"><label for="t-0">billing 2<\/label><input type="radio" name="t" id="t-1"><label for="t-1">invites 2<\/label><input type="radio" name="t" id="t-2"><label for="t-2">limits 1<\/label>/);
  assert.match(html, /body:has\(#v-need:checked\) \.claim:not\(\.v-need\)\{display:none\}/);
  assert.match(html, /body:has\(#t-1:checked\) \.claim:not\(\.t-1\)\{display:none\}/);
  const order = [...html.matchAll(/<li class="claim ([^"]+)"[^>]*>[\s\S]*?<b>(C\d)<\/b>/g)].map((m) => [m[2], m[1]]);
  assert.deepEqual(order, [['C2', 'v-need t-1'], ['C4', 'v-wait t-0'], ['C1', 'v-good t-1 t-2'], ['C3', 'v-retired t-0']], 'disproved first, retired last');
  assert.match(html, /<input type="search" id="q" placeholder="Search claims, ids and tags" hidden>/, 'the box shows only where the script runs');
  assert.match(html, /<script>[\s\S]*q\.hidden = false[\s\S]*<\/script>/);
  assert.match(html, /Words used here: <b>seat<\/b>, a &#60;paid&#62; member\./);
  assert.doesNotMatch(html, /<dt>Verdict<\/dt>|<h4>Retired/);
});

test('a step\'s final build writes the request page, its summary and the project index; a folder outside the layout writes no index', () => {
  const project = mkdtempSync(join(tmpdir(), 'project-'));
  const request = join(project, 'invites', '2026-10-27-0900-prove');
  const run = join(request, 'proof');
  mkdirSync(run, { recursive: true });
  writeFileSync(join(run, 'claims.json'), JSON.stringify({ title: 'T', claims: [claim('C1', { cases })] }));
  const out = execFileSync('node', [script, run], { encoding: 'utf8' });
  assert.match(out, /^Open: file:.*\/2026-10-27-0900-prove\/report\.html$/m);
  assert.match(out, /^Index: file:.*index\.html$/m);
  const summary = JSON.parse(readFileSync(join(request, 'summary.json'), 'utf8'));
  assert.deepEqual([summary.feature, summary.kind, summary.date], ['invites', 'prove', '2026-10-27']);
  assert.ok(!existsSync(join(run, 'summary.json')));
  assert.match(readFileSync(join(project, 'index.html'), 'utf8'), /"invites\/2026-10-27-0900-prove\/report\.html"/);
  const flat = makeRun({ claims: [claim('C1', { cases })] });
  assert.doesNotMatch(execFileSync('node', [script, flat], { encoding: 'utf8' }), /Index:/);
});

test('the project index skips ledger/ and per-app folders', () => {
  const project = mkdtempSync(join(tmpdir(), 'project-'));
  mkdirSync(join(project, 'ledger', 'invites'), { recursive: true });
  writeFileSync(join(project, 'ledger', 'invites', 'claims.json'), '{}');
  const other = join(project, 'apps-web', 'invites', '2026-10-27-0900-prove');
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, 'summary.json'), JSON.stringify({ name: 'x', feature: 'apps-web', kind: 'prove', updatedAt: '', counts: {} }));
  const run = join(project, 'billing', '2026-10-28-0900-prove', 'proof');
  mkdirSync(run, { recursive: true });
  writeFileSync(join(run, 'claims.json'), JSON.stringify({ title: 'T', claims: [claim('C1', { cases })] }));
  execFileSync('node', [script, run], { encoding: 'utf8' });
  const index = readFileSync(join(project, 'index.html'), 'utf8');
  assert.match(index, /1 request, updated /);
  assert.doesNotMatch(index, /apps-web/);
});

test('decisions.md in the request folder counts when the step has none', () => {
  const project = mkdtempSync(join(tmpdir(), 'project-'));
  const request = join(project, 'invites', '2026-10-27-0900-prove');
  const run = join(request, 'proof');
  mkdirSync(run, { recursive: true });
  writeFileSync(join(request, 'decisions.md'), `Ruling: ${DEFAULT_RULING}\nRuling: picked the slug invites — rule\n`);
  writeFileSync(join(run, 'claims.json'), JSON.stringify({ title: 'T', claims: [claim('C1', { cases })] }));
  assert.equal(buildProof(run).data.decisions.count, 2);
});

const approved = { approvedAt: '2026-10-27T10:00:00Z' };
const DEFAULT_RULING = 'approved 5 claims as written — auto mode — a wrong claim proved';

test('readDecisions counts only Ruling and Stop lines', () => {
  const text = `# Decisions\n\nRuling: slug invite-limit — matched — wrong folder\nRuling: default: ${DEFAULT_RULING}\na note\nStop: run lock held by 2026-10-28-proof\n`;
  assert.deepEqual(readDecisions(text), { count: 2, defaults: [DEFAULT_RULING], stop: 'run lock held by 2026-10-28-proof' });
  assert.deepEqual(readDecisions(null), { count: 0, defaults: [], stop: null });
});

test('a run with no approvedBy and no decisions.md shows nothing about auto mode', () => {
  const run = makeRun({ claims: [claim('C1', { cases })], extra: approved });
  const { data } = buildProof(run);
  assert.equal(data.approvedBy, 'user');
  assert.equal(data.decisions.count, 0);
  assert.doesNotMatch(chatSummary(data, 'x'), /^Auto mode:/m);
});

test('an auto run shows the banner, the section and the summary lines', () => {
  const run = makeRun({ claims: [claim('C1', { cases })], extra: { ...approved, approvedBy: 'auto' }, files: { 'decisions.md': `Ruling: default: ${DEFAULT_RULING}\n` } });
  const summary = chatSummary(buildProof(run).data, 'x');
  assert.match(summary, /Auto mode: 1 decisions, see decisions\.md\nDecided without you:\n- approved 5 claims/);
});

test('--approve --by auto sets approvedBy', () => {
  const read = (r) => JSON.parse(readFileSync(join(r, 'claims.json'), 'utf8'));
  const auto = makeRun({ claims: [full('C1', { target: 'web' })] });
  cli([auto, '--approve', '--by', 'auto']);
  assert.equal(read(auto).approvedBy, 'auto');
  assert.ok(read(auto).approvedAt);
  const plain = makeRun({ claims: [full('C1', { target: 'web' })] });
  cli([plain, '--approve']);
  assert.equal(read(plain).approvedBy, 'user');
});

test('--approve --by bogus is refused and changes nothing', () => {
  const run = makeRun({ claims: [full('C1', { target: 'web' })] });
  const before = readFileSync(join(run, 'claims.json'));
  cliFails([run, '--approve', '--by', 'bogus'], /Usage: node build-proof\.mjs <run> --approve \[--by user\|auto\]/);
  cliFails([run, '--approve', 'foo', 'bar'], /Usage: node build-proof\.mjs <run> --approve \[--by user\|auto\]/);
  assert.ok(readFileSync(join(run, 'claims.json')).equals(before));
});

test('the index marks auto requests and only them', () => {
  const req = (name, auto) => ({ name, feature: 'f', kind: 'prove', date: name.slice(0, 10), live: false, counts: { found: 0, fixed: 0, proven: 0, needsYou: 0 }, updatedAt: name, ...auto });
  const html = indexHtml('app', [req('2026-10-03-0900-prove', { auto: true }), req('2026-10-02-0900-prove', { auto: false }), req('2026-10-01-0900-prove', {})]);
  assert.equal(html.match(/(>Proof|f, proof<\/a>), auto,/g).length, 1);
});

test('picksMotion reads the Web line under ## Evidence', () => {
  assert.equal(picksMotion('## Evidence\n- Web: video, text\n- API: readable'), true);
  assert.equal(picksMotion('## Evidence\n- Web: gif, text'), true);
  assert.equal(picksMotion('## Evidence\n- Web: screenshots, text\n- API: video'), false);
  assert.equal(picksMotion(null), false);
});

test('checkEvidence: a web case counts only its own file, and only a recording when environment.md picks one', () => {
  const web = [claim('C1', { target: 'web', cases: [{ id: 'a' }, { id: 'b' }] })];
  const files = { 'evidence/C1-a.png': 'png', 'evidence/C1-b.webm': 'vid' };
  const run = makeRun({ claims: web, files });
  // A recording of case b logged for case a too shows case b.
  const lines = [ev('C1', 'a', 'evidence/C1-a.png', 'png'), ev('C1', 'b', 'evidence/C1-b.webm', 'vid'), ev('C1', 'a', 'evidence/C1-b.webm', 'vid')];
  assert.deepEqual([...checkEvidence(run, lines, web).keys].sort(), ['C1:a', 'C1:b']);
  assert.deepEqual([...checkEvidence(run, lines, web, [], { motion: true }).keys], ['C1:b']);
  const v = claimVerdict(web[0], results({ 'C1:a': 'pass', 'C1:b': 'pass' }), new Set(['C1:b']), true);
  assert.deepEqual(v.problems, ['C1 case a: passed without a recording']);
});

test('buildProof: an unlogged file named for a case puts that case in doubt', () => {
  const run = makeRun({
    claims: [claim('C1', { target: 'web', cases })],
    sessions: { s1: [{ claim: 'C1', case: 'a', result: 'pass' }] },
    evidence: [ev('C1', 'a', 'evidence/C1-a-2.png', 'second')],
    files: { 'evidence/C1-a.png': 'first', 'evidence/C1-a-2.png': 'second' },
  });
  const { data, problems } = buildProof(run);
  assert.equal(data.claims[0].verdict, 'not-proven');
  assert.ok(problems.includes('evidence/C1-a.png: not in evidence.jsonl'));
});

test('buildProof flags evidence no checker opened when environment.md turns the check on, and only then', () => {
  const build = (check, rows) => {
    const project = mkdtempSync(join(tmpdir(), 'project-'));
    writeFileSync(join(project, 'environment.md'), `## Evidence\n- API: readable · tool: curl\n- Check: ${check}\n`);
    const run = join(project, 'f', '2026-10-30-0900-prove', 'proof');
    mkdirSync(join(run, 'sessions'), { recursive: true });
    mkdirSync(join(run, 'evidence'));
    writeFileSync(join(run, 'claims.json'), JSON.stringify({ title: 'T', claims: [claim('C1', { target: 'api', cases })] }));
    writeFileSync(join(run, 'sessions', 's1.jsonl'), JSON.stringify({ claim: 'C1', case: 'a', result: 'pass' }) + '\n');
    for (const f of ['x', 'y']) writeFileSync(join(run, 'evidence', `C1-a-${f}.txt`), f);
    writeFileSync(join(run, 'evidence.jsonl'), jsonl([ev('C1', 'a', 'evidence/C1-a-x.txt', 'x'), ev('C1', 'a', 'evidence/C1-a-y.txt', 'y')]));
    if (rows) writeFileSync(join(run, 'evidence-check.jsonl'), jsonl(rows));
    return buildProof(run);
  };
  const row = (f) => ({ file: `evidence/C1-a-${f}.txt`, sha256: sha(f), verdict: 'matches', why: 'ok' });
  const none = build('on');
  assert.ok(none.problems.includes('evidence.jsonl lines 1, 2: not checked: no row in evidence-check.jsonl'));
  assert.match(chatSummary(none.data, 'x'), /^Not checked: 2 evidence files no checker opened/m);
  assert.ok(build('on', [row('x')]).problems.includes('evidence.jsonl line 2: not checked: no row in evidence-check.jsonl'));
  const all = build('on', [row('x'), row('y')]);
  assert.ok(!all.problems.some((p) => p.includes('not checked')));
  assert.doesNotMatch(chatSummary(all.data, 'x'), /Not checked/);
  assert.ok(!build('off').problems.some((p) => p.includes('not checked')));
});

test('buildProof asks for a recording when environment.md picks video', () => {
  const project = mkdtempSync(join(tmpdir(), 'project-'));
  writeFileSync(join(project, 'environment.md'), '## Evidence\n- Web: video, text\n');
  const run = join(project, 'f', '2026-10-30-0900-prove', 'proof');
  mkdirSync(join(run, 'sessions'), { recursive: true });
  mkdirSync(join(run, 'evidence'));
  writeFileSync(join(run, 'claims.json'), JSON.stringify({ title: 'T', claims: [claim('C1', { target: 'web', cases })] }));
  writeFileSync(join(run, 'sessions', 's1.jsonl'), JSON.stringify({ claim: 'C1', case: 'a', result: 'pass' }) + '\n');
  writeFileSync(join(run, 'evidence', 'C1-a.png'), 'png');
  writeFileSync(join(run, 'evidence.jsonl'), JSON.stringify(ev('C1', 'a', 'evidence/C1-a.png', 'png')) + '\n');
  const { data, problems } = buildProof(run);
  assert.equal(data.claims[0].verdict, 'not-proven');
  assert.ok(problems.includes('C1 case a: passed without a recording'));
});

test('the index has no learnings page: learnings live on each request page', () => {
  const project = mkdtempSync(join(tmpdir(), 'learn-'));
  const dir = join(project, 'invites', '2026-10-01-0900-explore');
  mkdirSync(join(dir, 'explore'), { recursive: true });
  writeFileSync(join(dir, 'summary.json'), JSON.stringify({ name: '2026-10-01-0900-explore', feature: 'invites', kind: 'explore', date: '2026-10-01', live: false, counts: {} }));
  writeFileSync(join(dir, 'explore', 'learnings.jsonl'), `${JSON.stringify({ by: 'planner', learning: 'Free plans stop at 10.', source: 'src/plans.ts:12' })}\n`);
  writeIndex(project);
  assert.doesNotMatch(readFileSync(join(project, 'index.html'), 'utf8'), /learning/i);
  assert.equal(existsSync(join(project, 'learnings.html')), false);
});

test('an explore summary lists each open question with its id, and how to answer one', () => {
  const run = makeRun({ files: {
    'charters/T1.jsonl': jsonl([{ n: 3, charter: 'T1', action: 'Ask', result: 'question', note: 'Per org or per owner?', answers: ['Per org: shared'] }]),
    'charters.json': JSON.stringify({ title: 'Team invites', charters: [] }),
  } });
  rmSync(join(run, 'claims.json'), { force: true });
  const { data } = buildProof(run);
  assert.match(data.questions[0].id, /^Q-[0-9a-f]{4}$/);
  const summary = chatSummary(data, 'file:///x');
  assert.match(summary, new RegExp(`\\n\\? ${data.questions[0].id} T1: Per org or per owner\\? \\(suggested by the skill: Per org: shared\\)\\nAnswer one in chat: answer <Q-id>: <your answer>\\n`));
});

// Modelled on run 2026-11-02-1006-improve: the rollback undid BUG-015 and BUG-027 and kept BUG-028, and the last
// re-proof (proof-15) held the ledger claims verify had disproved.
test('--ledger after a rollback: an undone fix\'s claim is not proven, and a re-proven claim takes the re-proofs\' verdict', () => {
  const web = (id, extra = {}) => full(id, { target: 'web', tags: ['invites'], cases, ...extra });
  const passed = (id) => ({ sessions: [{ claim: id, case: 'a', result: 'pass' }], evidence: [ev(id, 'a', `evidence/${id}-a.png`, 'png')], files: { [`evidence/${id}-a.png`]: 'png' } });
  const merge = (...runs) => ({ sessions: { s1: runs.flatMap((r) => r.sessions) }, evidence: runs.flatMap((r) => r.evidence), files: Object.assign({}, ...runs.map((r) => r.files)) });
  const failed = (id) => ({ sessions: [{ claim: id, case: 'a', result: 'fail', expected: 'x', actual: 'y' }], evidence: [ev(id, 'a', `evidence/${id}-a.png`, 'png')], files: { [`evidence/${id}-a.png`]: 'png' } });
  const verify = makeRun({
    claims: [web('C-6a5f'), web('C-755f'), web('C-7ab1'), web('C-ca45', { fromLedger: true }),
      web('C-c733', { fromLedger: true, status: 'changed', statement: 'When an owner resends, the app says "Invite resent to".', changed: { from: 'The app keeps C-c733', at: '2026-11-02', why: 'w' } })],
    ...merge(passed('C-6a5f'), passed('C-755f'), failed('C-7ab1'), failed('C-ca45'), passed('C-c733')),
    extra: { feature: 'invites' },
  });
  const bugs = mkdtempSync(join(tmpdir(), 'bugs-'));
  const bug = (id, fix) => { mkdirSync(join(bugs, id)); writeFileSync(join(bugs, id, 'bug.json'), JSON.stringify({ id, fix })); return join(bugs, id); };
  writeFileSync(join(verify, 'fix-claims.json'), JSON.stringify([
    { bug: bug('BUG-015', { status: 'not-fixed', decision: 'Broke C-ca45: ...' }), claim: 'C-6a5f' },
    { bug: bug('BUG-027', { status: 'not-fixed', changesClaims: ['C-c733'] }), claim: 'C-755f' },
    { bug: bug('BUG-028', { status: 'fixed' }), claim: 'C-7ab1' },
  ]));
  const bisect = makeRun({ claims: [web('C-ca45'), web('C-7ab1')], ...merge(failed('C-ca45'), failed('C-7ab1')) });
  const last = makeRun({ claims: [web('C-ca45'), web('C-7ab1')], ...merge(passed('C-ca45'), passed('C-7ab1')) });
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
  writeFileSync(join(dir, 'invites.jsonl'), `${JSON.stringify(full('C-ca45', { tags: ['invites'], verdict: 'proven' }))}\n${JSON.stringify(full('C-c733', { tags: ['invites'], verdict: 'proven' }))}\n`);
  const out = execFileSync(process.execPath, [script, verify, '--ledger', dir, bisect, last], { encoding: 'utf8' });
  assert.match(out, /^ {2}Kept: C-c733 changed by BUG-027, whose fix was undone$/m);
  const lines = Object.fromEntries(readLines(join(dir, 'invites.jsonl')).map((c) => [c.id, [c.verdict, c.statement]]));
  assert.deepEqual(lines, {
    // Disproved in verify and in a bisect step, proven by the last re-proof.
    'C-ca45': ['proven', 'The app keeps C-ca45'],
    // Its fix was undone, so the old wording and verdict stand.
    'C-c733': ['proven', 'The app keeps C-c733'],
    'C-6a5f': ['not-proven', 'The app keeps C-6a5f'],
    'C-755f': ['not-proven', 'The app keeps C-755f'],
    // BUG-028's claim failed on another fix's text, and held once that fix was undone.
    'C-7ab1': ['proven', 'The app keeps C-7ab1'],
  });
});

test('notAStep refuses a request folder and names its steps', () => {
  const request = join(mkdtempSync(join(tmpdir(), 'req-')), 'feature', '2026-11-03-1404-explore');
  mkdirSync(join(request, 'explore'), { recursive: true });
  mkdirSync(join(request, 'charters'));
  assert.equal(notAStep(request), `${request} is a request folder, not a run folder: use its step, ${join(request, 'explore')}`);
  assert.equal(notAStep(join(request, 'explore')), null);
});

const kiosk = { provenBy: 'picture', viewports: false, motion: false };

test('claimVerdict with a file-proven target passes a case whose evidence is a text file', () => {
  const v = claimVerdict(claim('C1', { target: 'queue', cases: [{ id: 'a' }] }), results({ 'C1:a': 'pass' }), new Set(['C1:a']), { provenBy: 'file', viewports: false, motion: false });
  assert.equal(v.verdict, 'proven');
});

test('claimVerdict with a picture-proven custom target needs its own picture', () => {
  const k = claim('C1', { target: 'kiosk', cases: [{ id: 'a' }] });
  assert.deepEqual(claimVerdict(k, results({ 'C1:a': 'pass' }), new Set(), kiosk).problems, ['C1 case a: passed without visual evidence']);
  assert.deepEqual(claimVerdict(k, results({ 'C1:a': 'fail' }), new Set(), kiosk).problems, ['C1 case a: failed without visual evidence']);
  assert.equal(claimVerdict(k, results({ 'C1:a': 'pass' }), new Set(['C1:a']), kiosk).verdict, 'proven');
});

test('buildProof uses targets.json', () => {
  const run = makeRun({
    claims: [claim('C1', { target: 'queue', cases })],
    sessions: { s1: [{ claim: 'C1', case: 'a', result: 'pass' }] },
    evidence: [ev('C1', 'a', 'evidence/C1-a.txt', 'out', { method: 'text' })],
    files: { 'evidence/C1-a.txt': 'out', 'targets.json': JSON.stringify({ targets: { queue: { provenBy: 'file', viewports: false, motion: false } }, unknown: [] }) },
  });
  assert.equal(buildProof(run).data.claims[0].verdict, 'proven');
});

test('buildProof without targets.json, or with an empty one, judges web and api as before', () => {
  const web = (files) => makeRun({
    claims: [claim('C1', { target: 'web', cases })],
    sessions: { s1: [{ claim: 'C1', case: 'a', result: 'pass' }] },
    evidence: [ev('C1', 'a', 'evidence/C1-a.txt', 'out', { method: 'text' })],
    files: { 'evidence/C1-a.txt': 'out', ...files },
  });
  assert.equal(buildProof(web({})).data.claims[0].verdict, 'not-proven');
  assert.equal(buildProof(web({ 'targets.json': JSON.stringify({ targets: {}, unknown: [] }) })).data.claims[0].verdict, 'not-proven');
  assert.equal(buildProof(web({ 'targets.json': '{broken' })).data.claims[0].verdict, 'not-proven');
});

test('buildProof: targets.json can make a web case provable by a text file', () => {
  const web = (files) => makeRun({
    claims: [claim('C1', { target: 'web', cases })],
    sessions: { s1: [{ claim: 'C1', case: 'a', result: 'pass' }] },
    evidence: [ev('C1', 'a', 'evidence/C1-a.txt', 'out', { method: 'text' })],
    files: { 'evidence/C1-a.txt': 'out', ...files },
  });
  assert.equal(buildProof(web({})).data.claims[0].verdict, 'not-proven');
  assert.equal(buildProof(web({ 'targets.json': JSON.stringify({ targets: { web: { provenBy: 'file', viewports: false, motion: false } }, unknown: [] }) })).data.claims[0].verdict, 'proven');
});

test('--plan accepts a claim for a target in targets.json and refuses one it does not list', () => {
  const run = makeRun({
    claims: [full('C1', { target: 'queue' }), full('C2', { target: 'api', statement: 'The app keeps C2 too' })],
    files: { 'targets.json': JSON.stringify({ targets: { queue: { provenBy: 'file', viewports: false, motion: false } }, unknown: [] }) },
  });
  const out = cli([run, '--plan']);
  assert.doesNotMatch(out, /C1: target/);
  assert.match(out, /C2: target api has no definition or is not under ## Targets: ask for evidence setup to define it/);
});
