import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixClaims, patchedFiles } from '../../skills/fix-and-prove/scripts/fix-claims.mjs';
import { writeClaims } from '../../skills/show-your-work/scripts/ledger.mjs';
import { approvalView } from '../../skills/show-your-work/scripts/build-proof.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'fixclaims-'));
const write = (root, files) => {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), typeof text === 'string' ? text : JSON.stringify(text));
  }
  return root;
};
const bug = (id, extra = {}) => ({
  id, kind: 'bug', title: `Title ${id}`, severity: 'major', target: 'web', account: 'free-owner', viewport: 'desktop',
  steps: ['Sign in as free-owner', 'Send an invite to qa+1793287335@acme.test'], expected: 'When an invite is revoked, the app refuses its accept link.',
  actual: 'Accepted', fix: { status: 'fixed' }, ...extra,
});
const explore = (bugs) => write(tmp(), Object.fromEntries(bugs.map((b) => [`bugs/${b.id}-x/bug.json`, b])));
const ledger = (claims) => { const dir = tmp(); writeClaims(dir, 'f', claims); return dir; };
const ledgerClaim = (id, extra = {}) => ({ id, tags: ['f'], target: 'web', statement: `The app keeps ${id}.`, status: 'active', rank: 'headline', verdict: 'proven', given: 'g', setup: 'UI only', cases: [{ id: 'a', do: 'x', expect: 'y' }], evidence: 'e', proof: 'will', source: 's', ...extra });

test('fixClaims writes one claim per fixed bug from its expected and steps, numbered C1, C2 for approval to give ledger ids', () => {
  const run = explore([bug('BUG-003'), bug('BUG-007', { severity: 'minor', target: 'api', viewport: undefined })]);
  const { doc, map } = fixClaims({ feature: 'invite-limit', ledgerDir: ledger([ledgerClaim('C-0001'), ledgerClaim('C-0004')]), bugDirs: [join(run, 'bugs/BUG-003-x'), join(run, 'bugs/BUG-007-x')] });
  const fresh = doc.claims.filter((c) => !c.fromLedger);
  assert.deepEqual(fresh.map((c) => [c.id, c.target, c.rank, c.source]), [['C1', 'web', 'headline', 'found: BUG-003'], ['C2', 'api', 'routine', 'found: BUG-007']]);
  assert.equal(fresh[0].statement, 'When an invite is revoked, the app refuses its accept link.');
  // The explorer's account has used up its limits: the prover starts from a new account of the same kind.
  assert.deepEqual(fresh[0].cases, [{ id: 'a', do: 'Sign in as the new account; then Send an invite to a new address', expect: 'When an invite is revoked, the app refuses its accept link.' }]);
  assert.equal(fresh[0].given, 'A new account of the same kind as `free-owner`, signed up today; the steps start there.');
  assert.deepEqual(map, [{ bug: join(run, 'bugs/BUG-003-x'), claim: 'C1' }, { bug: join(run, 'bugs/BUG-007-x'), claim: 'C2' }]);
});

test('fixClaims copies every active ledger claim as a routine re-check', () => {
  const run = explore([bug('BUG-003')]);
  const { doc } = fixClaims({ feature: 'f', ledgerDir: ledger([ledgerClaim('C1'), ledgerClaim('C2', { status: 'retired' })]), bugDirs: [join(run, 'bugs/BUG-003-x')] });
  const copied = doc.claims.filter((c) => c.fromLedger);
  assert.deepEqual(copied.map((c) => [c.id, c.rank, c.status, c.changed, c.check, 'verdict' in c, 'home' in c]), [['C1', 'routine', 'active', null, null, false, false]]);
});

test('fixClaims gives a bug fixed with another bug that bug\'s claim', () => {
  const run = explore([bug('BUG-003'), bug('BUG-005', { fix: { status: 'fixed', summary: 'Fixed with BUG-003' } })]);
  const dirs = [join(run, 'bugs/BUG-003-x'), join(run, 'bugs/BUG-005-x')];
  const { doc, map } = fixClaims({ feature: 'f', ledgerDir: null, bugDirs: dirs });
  assert.deepEqual(doc.claims.map((c) => [c.id, c.source]), [['C1', 'found: BUG-003, BUG-005']]);
  assert.deepEqual(map.map((m) => m.claim), ['C1', 'C1']);
});

test('fixClaims brings along bugs fixed with a named bug, each with its own case', () => {
  const run = explore([
    bug('BUG-008', { expected: 'If a Free org has sent 10 invites today, then the app refuses the 11th.' }),
    bug('BUG-010', { expected: 'The app shows "Daily invite limit reached. Try again tomorrow."', fix: { status: 'fixed', summary: 'Fixed with BUG-008' } }),
    bug('BUG-012', { fix: { status: 'needs-decision', summary: 'Fixed with BUG-008' } }),
  ]);
  const { doc, map, writer } = fixClaims({ feature: 'f', ledgerDir: null, bugDirs: [join(run, 'bugs/BUG-008-x')] });
  assert.deepEqual(doc.claims.map((c) => [c.id, c.source]), [['C1', 'found: BUG-008, BUG-010']]);
  assert.deepEqual(doc.claims[0].cases.map((k) => [k.id, k.expect]), [['a', 'If a Free org has sent 10 invites today, then the app refuses the 11th.'], ['b', 'The app shows "Daily invite limit reached. Try again tomorrow."']]);
  assert.deepEqual(map, [{ bug: join(run, 'bugs/BUG-008-x'), claim: 'C1' }, { bug: join(run, 'bugs/BUG-010-x'), claim: 'C1' }]);
  assert.deepEqual(writer, [join(run, 'bugs/BUG-008-x'), join(run, 'bugs/BUG-010-x')]);
});

test('fixClaims keeps at most 7 headline claims, the most severe first', () => {
  const bugs = Array.from({ length: 9 }, (_, i) => bug(`BUG-0${10 + i}`, { severity: i === 8 ? 'critical' : 'major' }));
  const run = explore(bugs);
  const { doc } = fixClaims({ feature: 'f', ledgerDir: null, bugDirs: bugs.map((b) => join(run, `bugs/${b.id}-x`)) });
  const headline = doc.claims.filter((c) => c.rank === 'headline');
  assert.equal(headline.length, 7);
  assert.ok(headline.some((c) => c.source === 'found: BUG-018'));
});

test('fixClaims output is a draft the approval view sends to the writer, and passes once the writer deletes draft', () => {
  const run = explore([bug('BUG-003', { viewport: 'mobile' })]);
  const { doc } = fixClaims({ feature: 'f', ledgerDir: ledger([ledgerClaim('C1')]), bugDirs: [join(run, 'bugs/BUG-003-x')] });
  const fresh = doc.claims.find((c) => !c.fromLedger);
  assert.deepEqual(fresh.viewports, ['mobile']);
  const opts = { targets: ['web', 'api'], viewports: ['desktop', 'mobile'] };
  assert.deepEqual(approvalView(doc, opts).problems, ['C2: a draft from the bug\'s steps: finish it as CLAIMS-findings.md says, then delete "draft"']);
  delete fresh.draft;
  assert.deepEqual(approvalView(doc, opts).problems, []);
});

test('fixClaims keeps no address from a bad actor\'s steps, so --plan flags only the draft', () => {
  const run = explore([bug('BUG-003', { steps: ['Invite qa+<b>1</b>@acme.test', "Invite o'brien@аcme.test"] })]);
  const { doc } = fixClaims({ feature: 'f', ledgerDir: null, bugDirs: [join(run, 'bugs/BUG-003-x')] });
  assert.equal(doc.claims[0].cases[0].do, 'Invite a new address; then Invite a new address');
  assert.ok(!approvalView(doc).problems.some((p) => p.includes('email address')));
});

test('CLI writes claims.json and fix-claims.json into the verify run', () => {
  const run = explore([bug('BUG-003')]);
  const verify = write(tmp(), {});
  const script = fileURLToPath(new URL('../../skills/fix-and-prove/scripts/fix-claims.mjs', import.meta.url));
  execFileSync('node', [script, verify, 'none', join(run, 'bugs/BUG-003-x')], { encoding: 'utf8' });
  assert.equal(JSON.parse(readFileSync(join(verify, 'claims.json'), 'utf8')).claims[0].id, 'C1');
  assert.deepEqual(JSON.parse(readFileSync(join(verify, 'fix-claims.json'), 'utf8')), [{ bug: join(run, 'bugs/BUG-003-x'), claim: 'C1' }]);
});

test('the CLI takes the feature from the request folder\'s parent', () => {
  const run = explore([bug('BUG-003')]);
  const verify = join(tmp(), 'invites', '2026-11-01-0900-explore-and-fix', 'proof');
  mkdirSync(verify, { recursive: true });
  const script = fileURLToPath(new URL('../../skills/fix-and-prove/scripts/fix-claims.mjs', import.meta.url));
  execFileSync('node', [script, verify, 'none', join(run, 'bugs/BUG-003-x')], { encoding: 'utf8' });
  assert.equal(JSON.parse(readFileSync(join(verify, 'claims.json'), 'utf8')).feature, 'invites');
});

test('fixClaims copies the baseline\'s unproven spec claims that the ledger does not hold yet, and numbers after them', () => {
  const run = explore([bug('BUG-003')]);
  const spec = write(tmp(), { 'claims.json': { title: 'Invites', claims: [ledgerClaim('C1', { fromLedger: false, rank: 'headline' }), ledgerClaim('C2', { fromLedger: false })] } });
  const { doc } = fixClaims({ feature: 'f', ledgerDir: null, specRun: spec, bugDirs: [join(run, 'bugs/BUG-003-x')] });
  assert.deepEqual(doc.claims.map((c) => [c.id, c.fromLedger, c.rank, c.source]), [['C3', false, 'headline', 'found: BUG-003'], ['C1', false, 'routine', 's'], ['C2', false, 'routine', 's']]);
  assert.deepEqual(doc.covers.map((c) => c.area), ['fixed bugs', 'spec, first proof']);
});

test('CLI takes --spec before the bug folders', () => {
  const run = explore([bug('BUG-003')]);
  const spec = write(tmp(), { 'claims.json': { claims: [ledgerClaim('C1')] } });
  const verify = write(tmp(), {});
  const script = fileURLToPath(new URL('../../skills/fix-and-prove/scripts/fix-claims.mjs', import.meta.url));
  execFileSync('node', [script, verify, 'none', '--spec', spec, join(run, 'bugs/BUG-003-x')], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(readFileSync(join(verify, 'claims.json'), 'utf8')).claims.map((c) => c.id), ['C2', 'C1']);
});

test('CLI with --spec and no bug folders proves only the spec claims', () => {
  const spec = write(tmp(), { 'claims.json': { claims: [ledgerClaim('C1')] } });
  const verify = write(tmp(), {});
  const script = fileURLToPath(new URL('../../skills/fix-and-prove/scripts/fix-claims.mjs', import.meta.url));
  execFileSync('node', [script, verify, 'none', '--spec', spec], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(readFileSync(join(verify, 'claims.json'), 'utf8')).claims.map((c) => c.id), ['C1']);
  assert.deepEqual(JSON.parse(readFileSync(join(verify, 'fix-claims.json'), 'utf8')), []);
});

test('fixClaims re-checks only ledger claims that last held', () => {
  const run = explore([bug('BUG-003')]);
  const { doc } = fixClaims({ feature: 'f', ledgerDir: ledger([ledgerClaim('C1'), ledgerClaim('C2', { verdict: 'disproved' }), ledgerClaim('C3', { verdict: 'not-proven' })]), bugDirs: [join(run, 'bugs/BUG-003-x')] });
  assert.deepEqual(doc.claims.filter((c) => c.fromLedger).map((c) => c.id), ['C1']);
  assert.equal(doc.claims.find((c) => !c.fromLedger).id, 'C4');
});

test('fixClaims re-checks only ledger claims tagged with the feature or touching a patched file', () => {
  const run = explore([bug('BUG-003')]);
  const dir = ledger([ledgerClaim('C1'), ledgerClaim('C2', { tags: ['g'], files: ['src/a.mjs'] }), ledgerClaim('C3', { tags: ['g'], files: ['src/b.mjs'] })]);
  const { doc } = fixClaims({ feature: 'f', ledgerDir: dir, files: ['src/a.mjs'], bugDirs: [join(run, 'bugs/BUG-003-x')] });
  assert.deepEqual(doc.claims.filter((c) => c.fromLedger).map((c) => c.id), ['C2', 'C1']);
});

test('patchedFiles reads the files a round\'s patches touch, from the fix step next to the verify run', () => {
  const request = join(tmp(), 'invites', '2026-11-01-0900-explore');
  write(request, {
    'fix/fixes/1-BUG-003.patch': 'diff --git a/src/a.mjs b/src/a.mjs\n--- a/src/a.mjs\n+++ b/src/a.mjs\n@@ -1 +1 @@\n-x\n+y\n',
    'explore/bugs/BUG-003-x/bug.json': bug('BUG-003', { fix: { status: 'fixed', patch: 'fixes/1-BUG-003.patch' } }),
  });
  assert.deepEqual(patchedFiles([join(request, 'explore/bugs/BUG-003-x')], join(request, 'proof')), ['src/a.mjs']);
});

test('fixClaims with only writes just the named ledger claims, for a re-check after an undo', () => {
  const { doc, map } = fixClaims({ feature: 'f', ledgerDir: ledger([ledgerClaim('C1'), ledgerClaim('C2')]), only: ['C2'], bugDirs: [] });
  assert.deepEqual(doc.claims.map((c) => c.id), ['C2']);
  assert.deepEqual(map, []);
});

test('CLI takes --only with no bug folders', () => {
  const verify = write(tmp(), {});
  const script = fileURLToPath(new URL('../../skills/fix-and-prove/scripts/fix-claims.mjs', import.meta.url));
  execFileSync('node', [script, verify, ledger([ledgerClaim('C1'), ledgerClaim('C2')]), '--only', 'C1'], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(readFileSync(join(verify, 'claims.json'), 'utf8')).claims.map((c) => c.id), ['C1']);
});

test('fixClaims makes a fix that changed production on the user\'s sentence a changed claim; a broken: fix stays active', () => {
  const run = explore([
    bug('BUG-003', { fix: { status: 'fixed', inProduction: true, source: 'Revoked invites never count.' } }),
    bug('BUG-004', { fix: { status: 'fixed', inProduction: true, source: 'broken: the page crashes' } }),
  ]);
  const { doc } = fixClaims({ feature: 'f', ledgerDir: null, bugDirs: [join(run, 'bugs/BUG-003-x'), join(run, 'bugs/BUG-004-x')] });
  const [changed, plain] = doc.claims;
  assert.equal(changed.status, 'changed');
  assert.deepEqual([changed.changed.from, changed.changed.why], ['Accepted', 'your words: "Revoked invites never count."']);
  assert.deepEqual([plain.status, plain.changed], ['active', null]);
  for (const c of doc.claims) delete c.draft;
  assert.deepEqual(approvalView(doc).problems, []);
});

test('fixClaims proves a bug reproduced only by API calls on the API target, when ## Targets lists one', () => {
  const steps = ['Sign in as free-owner', 'GET /api/orgs/2/invites'];
  const run = explore([bug('BUG-007', { steps })]);
  const dirs = [join(run, 'bugs/BUG-007-x')];
  assert.equal(fixClaims({ feature: 'f', ledgerDir: null, bugDirs: dirs, targets: ['web', 'api'] }).doc.claims[0].target, 'api');
  assert.equal(fixClaims({ feature: 'f', ledgerDir: null, bugDirs: dirs, targets: ['web'] }).doc.claims[0].target, 'web');
});

test('fixClaims gives spec and ledger claims the standard evidence text', () => {
  const spec = write(tmp(), { 'claims.json': { claims: [ledgerClaim('C2', { evidence: 'GIF of the 10th send' })] } });
  const { doc } = fixClaims({ feature: 'f', ledgerDir: ledger([ledgerClaim('C1', { target: 'api' })]), specRun: spec, bugDirs: [] });
  assert.deepEqual(doc.claims.map((c) => [c.id, c.evidence]), [['C1', 'saved response of each call'], ['C2', 'each method `## Evidence` picks for web, of every step; text on screen']]);
});

test('CLI prints the claim writer\'s prompt for every drafted bug claim', () => {
  const run = explore([bug('BUG-003', { expected: 'Revoked invites should be refused.' }), bug('BUG-004')]);
  const verify = write(tmp(), {});
  const script = fileURLToPath(new URL('../../skills/fix-and-prove/scripts/fix-claims.mjs', import.meta.url));
  const out = execFileSync('node', [script, verify, 'none', join(run, 'bugs/BUG-003-x'), join(run, 'bugs/BUG-004-x')], { encoding: 'utf8' });
  assert.match(out, /^Writer: /m);
  assert.match(out, /show-your-work\/CLAIMS\.md and \S+show-your-work\/CLAIMS-findings\.md and follow them\./);
  assert.match(out, /^Diff command: none$/m);
  assert.ok(out.includes(`Findings: ${join(run, 'bugs/BUG-003-x')}, ${join(run, 'bugs/BUG-004-x')}\n`));
  assert.match(out, /^Auto: no$/m);
});

test('CLI tells the claim writer when the fix run is in auto mode, so it may change a conflicting ledger claim', () => {
  const run = explore([bug('BUG-003')]);
  const request = write(tmp(), { 'fix/rounds.json': { feature: 'f', auto: true, rounds: [] } });
  const verify = join(request, 'proof');
  mkdirSync(verify);
  const script = fileURLToPath(new URL('../../skills/fix-and-prove/scripts/fix-claims.mjs', import.meta.url));
  assert.match(execFileSync('node', [script, verify, 'none', join(run, 'bugs/BUG-003-x')], { encoding: 'utf8' }), /^Auto: yes$/m);
});

test('fixClaims re-checks every claim on a patched file but at most 8 others, and says how many it left', () => {
  const run = explore([bug('BUG-003')]);
  const tagged = Array.from({ length: 25 }, (_, i) => ledgerClaim(`C-${String(i + 1).padStart(4, '0')}`, { rank: i < 3 ? 'headline' : 'routine' }));
  const onFile = [ledgerClaim('C-0100', { tags: ['g'], files: ['src/a.mjs'] }), ledgerClaim('C-0101', { tags: ['g'], files: ['src/a.mjs'] })];
  const { doc } = fixClaims({ feature: 'f', ledgerDir: ledger([...tagged, ...onFile]), files: ['src/a.mjs'], bugDirs: [join(run, 'bugs/BUG-003-x')] });
  const copied = doc.claims.filter((c) => c.fromLedger).map((c) => c.id);
  assert.equal(copied.length, 10);
  assert.deepEqual(copied.slice(0, 5), ['C-0100', 'C-0101', 'C-0001', 'C-0002', 'C-0003']);
  assert.match(doc.willNotProve, /17 more ledger claims tagged f, not on the changed files/);
  const withFiles = fixClaims({ feature: 'f', ledgerDir: null, bugFiles: (dirs) => (dirs.some((d) => d.endsWith('BUG-003-x')) ? ['src/a.mjs'] : []), bugDirs: [join(run, 'bugs/BUG-003-x')] }).doc;
  assert.deepEqual(withFiles.claims[0].files, ['src/a.mjs'], 'a bug claim carries its patch\'s files, so the ledger learns them');
});

test('fixClaims refuses a ledger with problems instead of re-checking nothing', () => {
  const run = explore([bug('BUG-003')]);
  const dir = tmp();
  writeFileSync(join(dir, 'f.jsonl'), '<<<<<<< ours\n{"id":"C-0001"}\n');
  assert.throws(() => fixClaims({ feature: 'f', ledgerDir: dir, bugDirs: [join(run, 'bugs/BUG-003-x')] }), /f\.jsonl: has git conflict markers/);
});

test('fixClaims with ledger none and --spec <verify run> --only re-proves those claims of the verify run as they are', () => {
  const verify = write(tmp(), { 'claims.json': { claims: [
    ledgerClaim('C-ca45', { fromLedger: true, status: 'changed', statement: 'While a Free org has 0 sends left, the app disables Send invite.', changed: { from: 'old', at: '2026-11-02', why: 'your words: "gap: x"' } }),
    ledgerClaim('C-7ab1', { fromLedger: false, status: 'changed', source: 'found: BUG-028', changed: { from: 'a', at: '2026-11-02', why: 'w' } }),
    ledgerClaim('C-0001'),
    ledgerClaim('C-0002', { status: 'retired' }),
  ] } });
  const { doc, map } = fixClaims({ feature: 'f', ledgerDir: null, specRun: verify, only: ['C-ca45', 'C-7ab1', 'C-0002'], bugDirs: [] });
  // A changed ledger claim keeps its new wording, not the ledger's old one; a bug claim comes along without its bug folder.
  assert.deepEqual(doc.claims.map((c) => [c.id, c.status, c.fromLedger, c.statement]), [
    ['C-ca45', 'changed', true, 'While a Free org has 0 sends left, the app disables Send invite.'],
    ['C-7ab1', 'changed', false, 'The app keeps C-7ab1.'],
  ]);
  assert.deepEqual(map, []);
});

test('fixClaims writes a custom target\'s evidence summary and no viewports', () => {
  const run = explore([bug('BUG-003', { target: 'queue', viewport: 'mobile' })]);
  const rules = { queue: { label: 'Queue', provenBy: 'file', viewports: false, evidenceSummary: 'the queue log of each job' } };
  const { doc } = fixClaims({ feature: 'f', ledgerDir: null, bugDirs: [join(run, 'bugs/BUG-003-x')], targets: ['queue'], rules });
  const c = doc.claims[0];
  assert.deepEqual([c.target, c.evidence, c.setup, c.viewports], ['queue', 'the queue log of each job', 'the steps only', undefined]);
});
