import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chatSummary, claimVerdicts, fixProblems, fixReport } from '../../skills/fix-and-prove/scripts/build-fix-report.mjs';

const sha = (text) => createHash('sha256').update(text).digest('hex');
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const write = (root, files) => {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return root;
};
const tmp = () => mkdtempSync(join(tmpdir(), 'fix-'));

// A proof run: each claim has one case "a"; verdict proven (pass with evidence), disproved (fail) or not-proven (blocked).
const proofRun = (claims) => {
  const steps = { proven: 'pass', disproved: 'fail', 'not-proven': 'blocked' };
  const files = {};
  const evidence = [];
  for (const c of claims) {
    const file = `evidence/${c.id}-a.txt`;
    files[file] = `${c.id} text`;
    if (c.verdict !== 'not-proven') evidence.push({ claim: c.id, case: 'a', target: 'api', method: 'curl', at: 't', commit: 'abc', file, sha256: sha(`${c.id} text`), note: '' });
  }
  return write(tmp(), {
    ...files,
    'claims.json': JSON.stringify({ title: 'Invites', claims: claims.map((c) => ({ id: c.id, target: 'api', statement: `The app keeps ${c.id}`, status: 'active', rank: 'headline', source: c.source ?? 'the user\'s words', fromLedger: c.fromLedger ?? false, cases: [{ id: 'a', do: 'x', expect: 'y' }] })) }),
    'sessions/s1.jsonl': jsonl(claims.map((c) => ({ claim: c.id, case: 'a', result: steps[c.verdict], ...(c.actual && { actual: c.actual }) }))),
    'evidence.jsonl': jsonl(evidence),
  });
};

const fixed = (extra = {}) => ({
  status: 'fixed', summary: 'Refuses the 11th invite', rootCause: 'off by one', files: ['src/invites.mjs:36'], differs: 'Production allows 11',
  impact: { existingUsers: 'Nothing visible', storedData: 'Not affected', otherConsumers: 'None', migration: 'none' },
  risk: 'low', riskReason: 'Fixes broken behaviour only', gap: false, inProduction: false, source: 'broken: the 11th invite is sent', patch: 'fixes/1-BUG-001.patch', commit: null, checks: 'none', ...extra,
});

// An explore run: bugs with fix records, and one evidence file per bug.
const exploreRun = (bugs) => {
  const files = { 'charters/T1.jsonl': '' };
  const evidence = [];
  for (const b of bugs) {
    const dir = `bugs/${b.id}-x`;
    files[`${dir}/bug.json`] = JSON.stringify({ id: b.id, title: b.title ?? `Bug ${b.id}`, severity: 'major', kind: 'bug', target: 'api', expected: 'e', actual: 'a', ...(b.fix && { fix: b.fix }) });
    files[`${dir}/body.txt`] = `${b.id} before`;
    evidence.push({ bug: b.id, target: 'api', method: 'curl', at: 't', commit: 'abc', file: `${dir}/body.txt`, sha256: sha(`${b.id} before`), note: '' });
  }
  return write(tmp(), { ...files, 'evidence.jsonl': jsonl(evidence) });
};

// What fix-claims.mjs writes: which claim proves each bug folder.
const link = (verify, explore, pairs) => {
  writeFileSync(join(verify, 'fix-claims.json'), JSON.stringify(Object.entries(pairs).map(([bug, claim]) => ({ bug: join(explore, `bugs/${bug}-x`), claim }))));
  return verify;
};

const fixRun = (rounds, { baseline = null } = {}) => write(tmp(), {
  'rounds.json': JSON.stringify({ feature: 'invite-limit', production: 'main', baseline, rounds }),
});

test('claimVerdicts returns each claim with its verdict and evidence', () => {
  const run = proofRun([{ id: 'C1', verdict: 'proven', source: 'found: BUG-001' }, { id: 'C2', verdict: 'disproved', fromLedger: true }]);
  const v = claimVerdicts(run);
  assert.deepEqual(v.map((c) => [c.id, c.verdict, c.fromLedger]), [['C2', 'disproved', true], ['C1', 'proven', false]]);
  assert.equal(v.find((c) => c.id === 'C1').evidence.length, 1);
});

test('fixProblems names missing records and missing fields', () => {
  assert.deepEqual(fixProblems({ id: 'BUG-001' }), ['BUG-001: no fix record']);
  const { patch, risk, ...partial } = fixed();
  assert.deepEqual(fixProblems({ id: 'BUG-002', fix: partial }), ['BUG-002: fix record misses risk, patch']);
  assert.deepEqual(fixProblems({ id: 'BUG-003', fix: { status: 'needs-decision', summary: 's' } }), ['BUG-003: fix record misses decision']);
  assert.deepEqual(fixProblems({ id: 'BUG-004', fix: fixed() }), []);
});

test('fixProblems: a bug fixed with another bug needs only summary, risk, riskReason and patch', () => {
  const shared = { status: 'fixed', summary: 'Fixed with BUG-004', risk: 'low', riskReason: 'r', patch: 'fixes/1-BUG-004.patch' };
  assert.deepEqual(fixProblems({ id: 'BUG-006', fix: shared }), []);
  const { patch, ...noPatch } = shared;
  assert.deepEqual(fixProblems({ id: 'BUG-006', fix: noPatch }), ['BUG-006: fix record misses patch']);
});

test('fixProblems flags a fix made at high or very-high risk', () => {
  assert.deepEqual(fixProblems({ id: 'BUG-005', fix: fixed({ risk: 'very-high' }) }), ['BUG-005: fixed at very-high risk; FIXER.md fixes only low and medium']);
  assert.deepEqual(fixProblems({ id: 'BUG-006', fix: fixed({ status: 'partly-fixed', risk: 'high' }) }), ['BUG-006: fixed at high risk; FIXER.md fixes only low and medium']);
  assert.deepEqual(fixProblems({ id: 'BUG-007', fix: { status: 'needs-decision', summary: 's', decision: 'd', risk: 'very-high' } }), []);
  assert.deepEqual(fixProblems({ id: 'BUG-008', fix: fixed({ risk: 'high', decided: 'Yes, change it' }) }), [], 'your decision allows high');
});

test('fixProblems allows what the run\'s Auto fixes level allows', () => {
  assert.deepEqual(fixProblems({ id: 'BUG-020', fix: fixed({ risk: 'very-high' }) }, 'very-high'), []);
  assert.deepEqual(fixProblems({ id: 'BUG-020', fix: fixed({ risk: 'very-high' }) }, 'high'), ['BUG-020: fixed at very-high risk; FIXER.md fixes only low and medium, and up to high in auto mode']);
});

test('fixReport reads Auto fixes from rounds.json, and an auto run without it allows very-high, auto mode\'s default', () => {
  const explore = exploreRun([{ id: 'BUG-020', fix: fixed({ risk: 'very-high' }) }]);
  const verify = link(proofRun([{ id: 'C1', verdict: 'proven', source: 'found: BUG-020' }]), explore, { 'BUG-020': 'C1' });
  const run = (doc) => fixReport(write(tmp(), { 'rounds.json': JSON.stringify({ feature: 'invite-limit', rounds: [{ n: 1, explore, verify }], ...doc }) })).problems;
  assert.deepEqual(run({ auto: true }), []);
  assert.deepEqual(run({ auto: true, autoFixes: 'medium' }), ['round 1: BUG-020: fixed at very-high risk; FIXER.md fixes only low and medium, and up to medium in auto mode']);
  assert.deepEqual(run({ auto: false }), ['round 1: BUG-020: fixed at very-high risk; FIXER.md fixes only low and medium']);
});

test('fixReport joins fix records with the verify run', () => {
  const explore = exploreRun([{ id: 'BUG-001', fix: fixed() }, { id: 'BUG-002', fix: fixed({ patch: 'fixes/1-BUG-002.patch' }) }]);
  const verify = proofRun([
    { id: 'C5', verdict: 'proven', source: 'found: BUG-001' },
    { id: 'C6', verdict: 'not-proven', source: 'found: BUG-002' },
    { id: 'C1', verdict: 'proven', fromLedger: true },
  ]);
  link(verify, explore, { 'BUG-001': 'C5', 'BUG-002': 'C6' });
  const { data, problems } = fixReport(fixRun([{ n: 1, explore, verify }]));
  const [b1, b2] = data.rounds[0].bugs;
  assert.equal(b1.shownStatus, 'fixed');
  // Evidence lives in other run folders, so the report links it by absolute path.
  assert.deepEqual(b1.after.map((e) => e.file), [join(verify, 'evidence/C5-a.txt')]);
  assert.deepEqual(b1.before.map((e) => e.file), [join(explore, 'bugs/BUG-001-x/body.txt')]);
  assert.equal(b2.shownStatus, 'fixed-not-proven');
  assert.deepEqual(data.attention.map((b) => b.id), ['BUG-002']);
  assert.deepEqual(data.holds.map((c) => [c.id, c.verdict]), [['C1', 'proven']]);
  assert.deepEqual(data.counts, { fixed: 1, notProven: 1, notFixed: 0, decisions: 0 });
  assert.deepEqual(problems, []);
});

test('fixReport: a claim several bugs share gives each its verdict', () => {
  const explore = exploreRun([{ id: 'BUG-001', fix: fixed() }, { id: 'BUG-003', fix: fixed({ patch: 'fixes/1-BUG-003.patch' }) }]);
  const verify = link(proofRun([{ id: 'C5', verdict: 'proven', source: 'found: BUG-001, BUG-003' }]), explore, { 'BUG-001': 'C5', 'BUG-003': 'C5' });
  const { data } = fixReport(fixRun([{ n: 1, explore, verify }]));
  assert.deepEqual(data.rounds[0].bugs.map((b) => [b.id, b.shownStatus, b.after.length]), [['BUG-001', 'fixed', 1], ['BUG-003', 'fixed', 1]]);
});

test('fixReport: a round with no verify run shows its fixes as not verified', () => {
  const explore = exploreRun([{ id: 'BUG-001', fix: fixed() }]);
  const { data } = fixReport(fixRun([{ n: 1, explore, verify: null }]));
  assert.equal(data.rounds[0].bugs[0].shownStatus, 'not-verified');
  assert.deepEqual(data.attention.map((b) => b.id), ['BUG-001']);
});

test('fixReport: fixes with no verify run are a problem, unless the run stopped', () => {
  const explore = exploreRun([{ id: 'BUG-001', fix: fixed() }]);
  assert.deepEqual(fixReport(fixRun([{ n: 1, explore, verify: null }])).problems, ['round 1: fixes but no verify run; prove them as SKILL.md §5 says']);
  const stopped = write(tmp(), { 'rounds.json': JSON.stringify({ feature: 'f', stopped: 'The app did not change', rounds: [{ n: 1, explore, verify: null }] }) });
  assert.deepEqual(fixReport(stopped).problems, []);
});

test('fixReport: a bug with no fix record is a problem, and the report still builds', () => {
  const explore = exploreRun([{ id: 'BUG-001' }]);
  const { data, problems } = fixReport(fixRun([{ n: 1, explore, verify: null }]));
  assert.equal(data.rounds[0].bugs.length, 1);
  assert.deepEqual(problems, ['round 1: BUG-001: no fix record']);
});

test('fixReport: before and after of the feature come from the baseline and the last verify run', () => {
  const baseline = proofRun([{ id: 'C1', verdict: 'proven', fromLedger: true }]);
  const explore = exploreRun([{ id: 'BUG-001', fix: fixed() }]);
  const verify = proofRun([{ id: 'C1', verdict: 'proven', fromLedger: true }]);
  const { data } = fixReport(fixRun([{ n: 1, explore, verify }], { baseline }));
  assert.equal(data.featureBeforeAfter.length, 1);
  assert.equal(data.featureBeforeAfter[0].id, 'C1');
  assert.ok(data.featureBeforeAfter[0].before[0].file.startsWith(baseline));
  assert.ok(data.featureBeforeAfter[0].after[0].file.startsWith(verify));
});

test('chatSummary leads with the counts and ends with the page', () => {
  const explore = exploreRun([{ id: 'BUG-001', fix: fixed() }, { id: 'BUG-002', fix: fixed({ patch: 'fixes/1-BUG-002.patch' }) }]);
  const verify = link(proofRun([{ id: 'C5', verdict: 'proven', source: 'found: BUG-001' }, { id: 'C6', verdict: 'not-proven', source: 'found: BUG-002' }]), explore, { 'BUG-001': 'C5', 'BUG-002': 'C6' });
  const { data } = fixReport(fixRun([{ n: 1, explore, verify }]));
  const text = chatSummary(data, 'file:///x');
  assert.match(text, /^Fix: invite-limit: 1 fixed · 1 fixed, not proven · 0 not fixed · 0 need a decision/);
  assert.match(text, /Open: file:\/\/\/x$/);
});

test('chatSummary leads with the page\'s own headline when it has one, never a count of its own', () => {
  const explore = exploreRun([{ id: 'BUG-001', fix: fixed() }]);
  const verify = link(proofRun([{ id: 'C5', verdict: 'proven', source: 'found: BUG-001' }]), explore, { 'BUG-001': 'C5' });
  const { data } = fixReport(fixRun([{ n: 1, explore, verify }]));
  const lines = chatSummary(data, 'file:///x', ['1 decision waits for you before you ship.', '- Review 1 fix']).split('\n');
  assert.deepEqual(lines.slice(0, 2), ['1 decision waits for you before you ship.', '- Review 1 fix']);
  assert.doesNotMatch(lines.join('\n'), /^Fix: /m);
});

const SCRIPT = fileURLToPath(new URL('../../skills/fix-and-prove/scripts/build-fix-report.mjs', import.meta.url));
const cli = (...args) => execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8' });
const sampleRun = (title = 'Bug BUG-001') => {
  const baseline = proofRun([{ id: 'C1', verdict: 'proven', fromLedger: true }]);
  const explore = exploreRun([{ id: 'BUG-001', title, fix: fixed() }, { id: 'BUG-002', fix: { status: 'needs-decision', summary: 's', decision: 'Change the plan?' } }]);
  const verify = link(proofRun([{ id: 'C5', verdict: 'proven', source: 'found: BUG-001' }, { id: 'C1', verdict: 'proven', fromLedger: true }]), explore, { 'BUG-001': 'C5' });
  return fixRun([{ n: 1, explore, verify }], { baseline });
};

test('CLI writes result.json, no fix-report.html, and prints the summary', () => {
  const run = sampleRun();
  const out = cli(run);
  assert.match(out.split('\n')[0], /^Fix: /);
  assert.ok(JSON.parse(readFileSync(join(run, 'result.json'), 'utf8')).data.counts);
  assert.ok(!existsSync(join(run, 'fix-report.html')));
});

test('CLI --verdicts prints one JSON line per claim', () => {
  const verify = proofRun([{ id: 'C5', verdict: 'proven', source: 'found: BUG-001' }]);
  const lines = cli(sampleRun(), '--verdicts', verify).trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines, [{ id: 'C5', source: 'found: BUG-001', fromLedger: false, verdict: 'proven', bugs: [] }]);
  const failed = proofRun([{ id: 'C6', verdict: 'disproved', actual: '201, the invite was sent' }]);
  assert.deepEqual(JSON.parse(cli(sampleRun(), '--verdicts', failed).trim()).actual, ['201, the invite was sent'], 'a disproved claim shows what its failing cases saw');
});

test('CLI without rounds.json exits with a usage line', () => {
  assert.throws(() => execFileSync('node', [SCRIPT, tmp()], { stdio: 'pipe' }), /Usage: node build-fix-report.mjs/);
});



test('fixReport: only fix-claims.json links a claim to a bug; a source naming the bug is not enough', () => {
  const explore = exploreRun([{ id: 'BUG-002', fix: fixed({ patch: 'fixes/1-BUG-002.patch' }) }]);
  // C1 is a ledger copy whose source names BUG-002 of an earlier run; C7 is this run's claim for BUG-002.
  const verify = link(proofRun([{ id: 'C1', verdict: 'disproved', fromLedger: true, source: 'found: BUG-002' }, { id: 'C7', verdict: 'proven', source: 'found: BUG-002' }]), explore, { 'BUG-002': 'C7' });
  const { data } = fixReport(fixRun([{ n: 1, explore, verify }]));
  assert.deepEqual(data.rounds[0].bugs.map((b) => [b.shownStatus, b.claims]), [['fixed', ['C7']]]);
});

test('fixReport: a verify run without fix-claims.json leaves its fixes not proven', () => {
  const explore = exploreRun([{ id: 'BUG-001', fix: fixed() }]);
  const verify = proofRun([{ id: 'C5', verdict: 'proven', source: 'found: BUG-001' }]);
  const { data } = fixReport(fixRun([{ n: 1, explore, verify }]));
  assert.deepEqual(data.rounds[0].bugs.map((b) => [b.shownStatus, b.claims]), [['fixed-not-proven', []]]);
});

test('fixReport: a fixed security bug is no problem, and always needs your attention', () => {
  const explore = exploreRun([{ id: 'BUG-008', fix: fixed() }]);
  writeFileSync(join(explore, 'bugs/BUG-008-x/bug.json'), JSON.stringify({ id: 'BUG-008', title: 'Members can revoke', severity: 'major', kind: 'security', target: 'api', expected: 'e', actual: 'a', fix: fixed() }));
  const verify = link(proofRun([{ id: 'C5', verdict: 'proven', source: 'found: BUG-008' }]), explore, { 'BUG-008': 'C5' });
  const { data, problems } = fixReport(fixRun([{ n: 1, explore, verify }]));
  assert.deepEqual(problems, []);
  assert.deepEqual(data.attention.map((b) => [b.id, b.shownStatus]), [['BUG-008', 'fixed']]);
});

test('fixReport: a proven fix of production behaviour, and a wont-fix, need your attention', () => {
  const explore = exploreRun([
    { id: 'BUG-001', fix: fixed({ inProduction: true, source: 'A revoked invite does not count.' }) },
    { id: 'BUG-002', fix: { status: 'wont-fix', summary: 's', decision: 'd' } },
    { id: 'BUG-003', fix: fixed({ patch: 'fixes/1-BUG-003.patch' }) },
  ]);
  const verify = link(proofRun([{ id: 'C5', verdict: 'proven' }, { id: 'C6', verdict: 'proven' }]), explore, { 'BUG-001': 'C5', 'BUG-003': 'C6' });
  const { data } = fixReport(fixRun([{ n: 1, explore, verify }]));
  assert.deepEqual(data.attention.map((b) => [b.id, b.shownStatus]), [['BUG-001', 'fixed'], ['BUG-002', 'wont-fix']]);
});

test('fixReport: a disproved fix still marked fixed is a problem', () => {
  const explore = exploreRun([{ id: 'BUG-001', fix: fixed() }]);
  const verify = link(proofRun([{ id: 'C5', verdict: 'disproved', source: 'found: BUG-001' }]), explore, { 'BUG-001': 'C5' });
  const { problems } = fixReport(fixRun([{ n: 1, explore, verify }]));
  assert.deepEqual(problems, ['round 1: BUG-001: claim C5 disproved but the fix is still fixed; undo it as SKILL.md §5 step 4 says']);
});

test('fixReport: a commit under Fix commits: none is a problem', () => {
  const explore = exploreRun([{ id: 'BUG-001', fix: fixed({ commit: 'e2541f9' }) }]);
  const run = write(tmp(), { 'rounds.json': JSON.stringify({ feature: 'f', fixCommits: 'none', baseline: null, rounds: [{ n: 1, explore, verify: null }] }) });
  assert.ok(fixReport(run).problems.includes('round 1: BUG-001: committed as e2541f9 although Fix commits is none'));
});

test('fixReport: a round\'s extra bug folders, filed by the previous verify for spec claims, join that round with their own claims', () => {
  const verify1 = write(proofRun([{ id: 'C1', verdict: 'disproved' }]), {
    'bugs/BUG-001-y/bug.json': JSON.stringify({ id: 'BUG-001', title: 'Spec bug', severity: 'major', kind: 'bug', target: 'api', claim: 'C1', expected: 'e', actual: 'a', fix: fixed({ patch: 'fixes/2-BUG-001.patch' }) }),
  });
  const explore1 = exploreRun([{ id: 'BUG-001', fix: fixed() }]);
  const explore2 = exploreRun([{ id: 'BUG-001', fix: fixed({ patch: 'fixes/2-BUG-001b.patch' }) }]);
  const verify2 = proofRun([{ id: 'C5', verdict: 'proven' }, { id: 'C9', verdict: 'proven' }]);
  writeFileSync(join(verify2, 'fix-claims.json'), JSON.stringify([{ bug: join(verify1, 'bugs/BUG-001-y'), claim: 'C9' }, { bug: join(explore2, 'bugs/BUG-001-x'), claim: 'C5' }]));
  const { data, problems } = fixReport(fixRun([{ n: 1, explore: explore1, verify: verify1 }, { n: 2, explore: explore2, verify: verify2, extra: [join(verify1, 'bugs/BUG-001-y')] }]));
  assert.deepEqual(data.rounds[1].bugs.map((b) => [b.title, b.shownStatus, b.claims]), [['Bug BUG-001', 'fixed', ['C5']], ['Spec bug', 'fixed', ['C9']]]);
  assert.ok(data.rounds[1].bugs[1].before.every((e) => e.file.startsWith(verify1)));
  assert.deepEqual(problems, []);
});

test('fixReport: still holds lists the last verify\'s claims that prove no bug, spec and ledger alike', () => {
  const explore = exploreRun([{ id: 'BUG-001', fix: fixed() }]);
  const verify = link(proofRun([{ id: 'C5', verdict: 'proven' }, { id: 'C1', verdict: 'proven', fromLedger: true }, { id: 'C2', verdict: 'disproved' }]), explore, { 'BUG-001': 'C5' });
  const { data } = fixReport(fixRun([{ n: 1, explore, verify }], { baseline: proofRun([]) }));
  assert.deepEqual(data.holds.map((c) => [c.id, c.verdict]), [['C2', 'disproved'], ['C1', 'proven']]);
  // An unproven baseline has no evidence, so there is no feature-level before.
  assert.deepEqual(data.featureBeforeAfter, []);
});

test('fixReport: with no baseline, a claim has no before: the ledger keeps only its verdict', () => {
  const explore = exploreRun([{ id: 'BUG-001', fix: fixed() }]);
  const verify = proofRun([{ id: 'C-0001', verdict: 'proven', fromLedger: true }]);
  const { data } = fixReport(fixRun([{ n: 1, explore, verify }]));
  assert.deepEqual(data.featureBeforeAfter, []);
});

test('CLI --verdicts names the bug folders each claim proves', () => {
  const explore = exploreRun([{ id: 'BUG-001', fix: fixed() }]);
  const verify = link(proofRun([{ id: 'C5', verdict: 'proven', source: 'found: BUG-001' }]), explore, { 'BUG-001': 'C5' });
  const [line] = cli(sampleRun(), '--verdicts', verify).trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(line.bugs, [join(explore, 'bugs/BUG-001-x')]);
});

test('fixReport carries the explorers\' questions, and the summary lists them', () => {
  const explore = exploreRun([{ id: 'BUG-001', fix: fixed() }]);
  writeFileSync(join(explore, 'charters/T1.jsonl'), jsonl([
    { n: 1, charter: 'T1', action: 'a', result: 'as-expected' },
    { n: 2, charter: 'T1', action: 'Send the 10th invite', result: 'question', note: 'Is a limit of 10 intended for Free?' },
  ]));
  const { data } = fixReport(fixRun([{ n: 1, explore, verify: null }]));
  assert.deepEqual(data.questions.map(({ id, ...q }) => q), [{ round: 1, charter: 'T1', note: 'Is a limit of 10 intended for Free?', answers: [] }]);
  assert.match(chatSummary(data, 'file:///x'), new RegExp(`\\n\\? ${data.questions[0].id} round 1 T1: Is a limit of 10 intended for Free\\?\\nAnswer one in chat: answer <Q-id>: <your answer>\\n`));
});

test("BUG-011: the summary marks a question's possible answers as the skill's suggestion", () => {
  const explore = exploreRun([{ id: 'BUG-001', fix: fixed() }]);
  writeFileSync(join(explore, 'charters/T1.jsonl'), jsonl([
    { n: 1, charter: 'T1', action: 'Send the 10th invite', result: 'question', note: 'Is a limit of 10 intended for Free?', answers: ['Yes: Free stops at 10', 'No: Free has no limit'] },
  ]));
  const { data } = fixReport(fixRun([{ n: 1, explore, verify: null }]));
  assert.deepEqual(data.questions[0].answers, ['Yes: Free stops at 10', 'No: Free has no limit']);
  assert.match(chatSummary(data, 'file:///x'), /\n\? Q-[0-9a-f]{4} round 1 T1: Is a limit of 10 intended for Free\? \(suggested by the skill: Yes: Free stops at 10 \| No: Free has no limit\)\n/);
});

test('a run stopped for an app that did not change says so first, in the summary and the page', () => {
  const explore = exploreRun([{ id: 'BUG-001', fix: fixed() }]);
  const run = write(tmp(), { 'rounds.json': JSON.stringify({ feature: 'f', stopped: 'The app did not change after 3 fixes and a restart.', rounds: [{ n: 1, explore, verify: null }] }) });
  const { data } = fixReport(run);
  assert.equal(data.stopped, 'The app did not change after 3 fixes and a restart.');
  assert.match(chatSummary(data, 'file:///x').split('\n')[1], /^Stopped: The app did not change after 3 fixes and a restart\.$/);
});

test('a flaky claim shows in the summary, with its round', () => {
  const explore = exploreRun([{ id: 'BUG-001', fix: fixed() }]);
  const run = write(tmp(), { 'rounds.json': JSON.stringify({ feature: 'f', stopped: 'x', rounds: [{ n: 1, explore, verify: null, flaky: ['C-bbea'] }] }) });
  const { data } = fixReport(run);
  assert.deepEqual(data.flaky, [{ id: 'C-bbea', round: 1 }]);
  assert.match(chatSummary(data, 'file:///x'), /\n! round 1 C-bbea flaky: it held and failed on the same code; nothing was undone for it\n/);
});

test('fixReport: a round with only lists just the bug folders the user picked, from any run, and its extra ones', () => {
  const older = exploreRun([{ id: 'BUG-001', title: 'Picked old', fix: fixed() }, { id: 'BUG-002', title: 'Not fixed before', fix: fixed({ patch: 'fixes/1-BUG-002.patch' }) }]);
  const newer = exploreRun([{ id: 'BUG-001', title: 'Picked new', fix: fixed({ patch: 'fixes/1-BUG-001b.patch' }) }, { id: 'BUG-003', title: 'Left new' }]);
  const only = [join(newer, 'bugs/BUG-001-x'), join(older, 'bugs/BUG-001-x')];
  const { data, problems } = fixReport(fixRun([{ n: 1, explore: newer, only, extra: [join(older, 'bugs/BUG-002-x')], verify: null }]));
  assert.deepEqual(data.rounds[0].bugs.map((b) => b.title), ['Picked new', 'Picked old', 'Not fixed before']);
  assert.deepEqual(problems, ['round 1: fixes but no verify run; prove them as SKILL.md §5 says']);
});

test('fixReport takes a claim the rollback re-proved from its re-proofs: a kept fix whose claim held once the culprit was undone is fixed', () => {
  const explore = exploreRun([{ id: 'BUG-028', fix: fixed() }]);
  const verify = link(proofRun([{ id: 'C-7ab1', verdict: 'disproved', source: 'found: BUG-028' }, { id: 'C-ca45', verdict: 'disproved', fromLedger: true }]), explore, { 'BUG-028': 'C-7ab1' });
  const bisect = proofRun([{ id: 'C-7ab1', verdict: 'disproved' }, { id: 'C-ca45', verdict: 'not-proven' }]);
  const last = proofRun([{ id: 'C-7ab1', verdict: 'proven' }]);
  const { data, problems } = fixReport(fixRun([{ n: 1, explore, verify, reproofs: [bisect, last] }]));
  const [b] = data.rounds[0].bugs;
  assert.deepEqual([b.shownStatus, b.after.map((e) => e.file)], ['fixed', [join(last, 'evidence/C-7ab1-a.txt')]]);
  // A blocked re-proof says nothing: verify's verdict stands.
  assert.deepEqual(data.holds.map((c) => [c.id, c.verdict]), [['C-ca45', 'disproved']]);
  assert.deepEqual(problems, []);
});
