import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { duplicates, FEATURE, filesOf, lineOf, mintId, readLedger, select, tagCounts, writeClaims } from '../../skills/show-your-work/scripts/ledger.mjs';

const script = fileURLToPath(new URL('../../skills/show-your-work/scripts/ledger.mjs', import.meta.url));
const claim = (id, extra = {}) => ({ id, tags: ['t'], target: 'web', statement: `The app keeps ${id}.`, status: 'active', verdict: 'proven', ...extra });
const ledger = (claims) => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
  writeClaims(dir, 'f', claims);
  return dir;
};
const ids = (claims) => claims.map((c) => c.id);
const lines = (text) => text.trim().split('\n').map((l) => JSON.parse(l));
const git = (dir, ...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' });

test('readLedger reads each feature file and terms, and reports conflicted, broken, id-less and twice-held claims', () => {
  const dir = ledger([claim('C-0001'), claim('C-0002'), claim('C-0003')]);
  writeClaims(dir, 'g', [{ id: 'C-0006', statement: 'No tags.' }]);
  writeFileSync(join(dir, 'h.jsonl'), '<<<<<<< HEAD\n{"id":"C-0007"}\n');
  writeFileSync(join(dir, 'i.jsonl'), '{\n');
  writeFileSync(join(dir, 'j.jsonl'), `${JSON.stringify(claim('C-0001', { statement: 'Other.' }))}\n{"statement":"no id"}\n`);
  writeFileSync(join(dir, 'terms.json'), JSON.stringify([{ term: 'seat', means: 'a paid member' }]));
  const { claims, terms, problems } = readLedger(dir);
  assert.deepEqual(ids(claims), ['C-0001', 'C-0002', 'C-0003', 'C-0006']);
  assert.equal(claims.find((c) => c.id === 'C-0001').home, 'f');
  assert.deepEqual(claims.find((c) => c.id === 'C-0006'), { id: 'C-0006', statement: 'No tags.', status: 'active', rank: 'routine', approvedBy: 'user', retiredReason: null, verdict: null, tags: [], home: 'g' });
  assert.deepEqual(terms, [{ term: 'seat', means: 'a paid member' }]);
  assert.deepEqual(problems.sort(), ['C-0001: in f.jsonl and j.jsonl', 'h.jsonl: has git conflict markers', 'i.jsonl line 1: not valid JSON', 'j.jsonl line 2: a claim with no id']);
  assert.deepEqual(readLedger(join(dir, 'missing')), { claims: [], terms: [], problems: [] });
});

test('select matches by file, then tag, then id, leaves out retired, and normalizes paths', () => {
  const claims = [
    claim('C-0002', { tags: ['y'] }),
    claim('C-0001', { tags: ['x'], files: ['src/a.mjs'] }),
    claim('C-0003', { tags: ['y'], status: 'retired' }),
    claim('C-0004', { tags: ['z'] }),
  ];
  assert.deepEqual(ids(select(claims, { tags: ['y'], files: ['./src/a.mjs'] })), ['C-0001', 'C-0002']);
  assert.deepEqual(ids(select(claims, { files: [join(process.cwd(), 'src/a.mjs')] })), ['C-0001']);
  assert.deepEqual(ids(select(claims, { tags: ['y'], retired: true })), ['C-0002', 'C-0003']);
  assert.deepEqual(ids(select(claims, { tags: ['y'], ids: ['C-0004'] })), ['C-0002', 'C-0004']);
  assert.deepEqual(select(claims, {}), []);
});

test('tagCounts and duplicates', () => {
  const claims = [claim('C-0001', { tags: ['x', 'y'] }), claim('C-0002', { tags: ['y'] }), claim('C-0004', { statement: 'The app keeps C-0001.', tags: [] }), claim('C-0005', { statement: 'The app keeps C-0001.', status: 'retired' })];
  assert.deepEqual(tagCounts(claims), [['y', 2], ['x', 1]]);
  assert.deepEqual(duplicates(claims), [['C-0001', 'C-0004']]);
});

test('mintId makes C- and 4 hex, draws again on a clash, and grows to 5 when crowded', () => {
  const draws = [Buffer.from([0x7f, 0x3a]), Buffer.from([0x91, 0xbd])];
  assert.equal(mintId(new Set(['C-7f3a']), () => draws.shift()), 'C-91bd');
  const crowded = new Set(Array.from({ length: 32769 }, (_, i) => `C-${i.toString(16).padStart(4, '0')}`));
  assert.match(mintId(crowded), /^C-[0-9a-f]{5}$/);
  assert.match(mintId(new Set()), /^C-[0-9a-f]{4}$/);
});

test('writeClaims writes a feature file as one claim per line, sorted by id, keys in order', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
  writeClaims(dir, 'invites', [claim('C-0002'), claim('C-0001', { verdict: 'proven', statement: 'S.', tags: ['t'], rank: 'headline', target: 'web', given: 'g', setup: 's', cases: [], viewports: ['desktop'], evidence: 'e', files: ['a.mjs'], home: 'invites' })]);
  const text = readFileSync(join(dir, 'invites.jsonl'), 'utf8');
  assert.deepEqual(lines(text).map((c) => c.id), ['C-0001', 'C-0002']);
  assert.deepEqual(Object.keys(lines(text)[0]), ['id', 'tags', 'rank', 'target', 'statement', 'given', 'setup', 'cases', 'viewports', 'evidence', 'files', 'verdict']);
  assert.ok(text.endsWith('}\n'));
});

test('a merge conflict in a feature file is whole lines: dropping the marker lines leaves a valid file, and a claim kept twice is reported', () => {
  const repo = mkdtempSync(join(tmpdir(), 'repo-'));
  git(repo, 'init', '-q', '-b', 'main');
  writeClaims(repo, 'f', [claim('C-0001'), claim('C-0005')]);
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'base');
  git(repo, 'switch', '-qc', 'a');
  writeClaims(repo, 'f', [claim('C-0001'), claim('C-0002'), claim('C-0005', { verdict: 'disproved' })]);
  git(repo, 'commit', '-qam', 'a');
  git(repo, 'switch', '-q', 'main');
  writeClaims(repo, 'f', [claim('C-0001'), claim('C-0003'), claim('C-0005', { verdict: 'not-proven' })]);
  git(repo, 'commit', '-qam', 'b');
  assert.throws(() => git(repo, 'merge', '-q', 'a', '-m', 'merge'));
  assert.deepEqual(readLedger(repo).problems, ['f.jsonl: has git conflict markers']);
  const file = join(repo, 'f.jsonl');
  writeFileSync(file, readFileSync(file, 'utf8').split('\n').filter((l) => !/^(<<<<<<<|=======|>>>>>>>)/.test(l)).join('\n'));
  const { claims, problems } = readLedger(repo);
  assert.deepEqual([...new Set(ids(claims))].sort(), ['C-0001', 'C-0002', 'C-0003', 'C-0005']);
  assert.deepEqual(problems, ['C-0005: twice in f.jsonl']);
});

test('feature names are lowercase slugs, and not the ledger\'s own file names', () => {
  for (const ok of ['team-invites', 'billing2']) assert.ok(FEATURE.test(ok), ok);
  for (const bad of ['Terms', 'terms', 'ledger', 'targets', 'drivers', 'a/b', '../x', '', '-x']) assert.ok(!FEATURE.test(bad), bad);
});

test('the CLI prints the tags line, at most 60 lines, and full claims only for --ids', () => {
  const dir = ledger(Array.from({ length: 70 }, (_, i) => claim(`C-${String(i + 1).padStart(4, '0')}`)));
  const run = (...a) => execFileSync('node', [script, dir, ...a], { encoding: 'utf8' });
  const out = run('--tags', 't').trimEnd().split('\n');
  assert.equal(out[0], 'Tags: t (70)');
  assert.equal(out.filter((l) => /^C-[0-9a-f]{4} proven \[t\] /.test(l)).length, 60);
  assert.equal(out.at(-1), '+10 more: narrow with fewer tags or --files');
  assert.deepEqual(run().trimEnd().split('\n'), ['Tags: t (70)']);
  const ids = run('--ids', 'C-0001,C-zzzz');
  assert.deepEqual(JSON.parse(ids.slice(ids.indexOf('['), ids.lastIndexOf(']') + 1)).map((c) => c.id), ['C-0001']);
  assert.match(ids, /^Problem: C-zzzz: no such claim$/m);
});

test('select matches any of a claim\'s files, and an absolute path by its end', () => {
  const claims = [claim('C-0001', { files: ['src/y.mjs', 'src/x.mjs'] }), claim('C-0002', { files: ['src/a.mjs'] })];
  assert.deepEqual(ids(select(claims, { files: ['src/x.mjs'] })), ['C-0001']);
  assert.deepEqual(ids(select(claims, { files: ['/somewhere/else/repo/src/a.mjs'] })), ['C-0002']);
  assert.deepEqual(ids(select(claims, { files: ['b/src/a.mjs.bak'] })), []);
});

test('duplicates stays fast on a huge ledger', () => {
  const claims = Array.from({ length: 20000 }, (_, i) => claim(`C-${i.toString(16).padStart(5, '0')}`));
  claims.push(claim('C-fffff', { statement: 'The app keeps C-00001.' }));
  const start = Date.now();
  assert.deepEqual(duplicates(claims), [['C-00001', 'C-fffff']]);
  assert.ok(Date.now() - start < 500, `${Date.now() - start} ms`);
});

test('the CLI prints at most 10 duplicate problems', () => {
  const dir = ledger(Array.from({ length: 16 }, (_, i) => claim(`C-${String(i + 1).padStart(4, '0')}`, { statement: 'Same.' })));
  const out = execFileSync('node', [script, dir], { encoding: 'utf8' }).trimEnd().split('\n');
  assert.equal(out.filter((l) => / have the same statement$/.test(l)).length, 10);
  assert.equal(out.at(-1), 'Problem: +5 more claims with a statement another claim has');
});

test('readLedger reports the two older layouts without crashing', () => {
  const dir = ledger([claim('C-0001')]);
  writeFileSync(join(dir, 'C-0002.json'), JSON.stringify(claim('C-0002')));
  writeFileSync(join(dir, 'invites.json'), JSON.stringify([claim('C-0003')]));
  mkdirSync(join(dir, 'invites'));
  writeFileSync(join(dir, 'invites', 'claims.json'), '{"claims":[]}');
  const { claims, problems } = readLedger(dir);
  assert.deepEqual(ids(claims), ['C-0001']);
  assert.deepEqual(problems.sort(), ['C-0002.json: older layout, not read: move its claims into a <feature>.jsonl, one per line', 'invites.json: older layout, not read: move its claims into a <feature>.jsonl, one per line', 'invites/claims.json: old ledger layout, not read: its claims need proving again']);
});

test('the CLI refuses a flag it does not know', () => {
  const res = spawnSync('node', [script, ledger([claim('C-0001')]), '--tag', 't'], { encoding: 'utf8' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /^Unknown flag --tag\. Usage:/);
});

test('select ranks tag matches by how many tags match, then headline before routine', () => {
  const claims = [
    claim('C-0001', { tags: ['roles'], rank: 'headline' }),
    claim('C-0002', { tags: ['f'], rank: 'routine' }),
    claim('C-0003', { tags: ['f'], rank: 'headline' }),
    claim('C-0004', { tags: ['f', 'roles'], rank: 'routine' }),
  ];
  assert.deepEqual(ids(select(claims, { tags: ['f', 'roles'] })), ['C-0004', 'C-0001', 'C-0003', 'C-0002']);
});

test('filesOf reads the paths a source names, framework paths included, and nothing from words or quotes', () => {
  assert.deepEqual(filesOf('abc123 src/routes/invites/+page.svelte'), ['src/routes/invites/+page.svelte']);
  assert.deepEqual(filesOf('abc123 app/invites/[id]/page.tsx'), ['app/invites/[id]/page.tsx']);
  assert.deepEqual(filesOf('abc123 app/(dashboard)/settings/page.tsx'), ['app/(dashboard)/settings/page.tsx']);
  assert.deepEqual(filesOf('abc123 packages/@acme/ui/button.tsx'), ['packages/@acme/ui/button.tsx']);
  assert.deepEqual(filesOf('abc123 Dockerfile'), ['Dockerfile']);
  assert.deepEqual(filesOf('found: BUG-002, BUG-005; abc123 ./src/x.mjs'), ['src/x.mjs']);
  assert.deepEqual(filesOf('docs/limits.md: "Free orgs on v1.2 send 10 a day."'), ['docs/limits.md']);
  assert.deepEqual(filesOf('docs/limits.md: “Free orgs on v1.2 send 10 a day.”'), ['docs/limits.md']);
  assert.deepEqual(filesOf('the user\'s words: "Free orgs on v1.2"'), []);
  assert.deepEqual(filesOf('the code only: abc123 src/a.ts'), ['src/a.ts']);
  assert.deepEqual(filesOf('found: BUG-002'), []);
  assert.deepEqual(filesOf(null), []);
});

test('select matches an older claim that has a source and no files', () => {
  assert.deepEqual(ids(select([claim('C-0001', { source: 'abc123 src/a.mjs' })], { files: ['src/a.mjs'] })), ['C-0001']);
});

test('a retired claim\'s select line says retired', () => {
  assert.equal(lineOf({ id: 'C-0002', tags: ['f'], statement: 'Gone.', status: 'retired' }), 'C-0002 retired [f] Gone.');
});

test('writeClaims leaves out keys that hold their default, and readLedger fills them back', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
  writeClaims(dir, 'f', [{ id: 'C-0001', tags: ['f'], rank: 'routine', statement: 'S.', status: 'active', retiredReason: null, approvedBy: 'user', verdict: 'proven' },
    { id: 'C-0002', tags: ['f'], rank: 'headline', statement: 'T.', status: 'active', approvedBy: 'auto', verdict: null }]);
  const file = lines(readFileSync(join(dir, 'f.jsonl'), 'utf8'));
  assert.deepEqual(file, [{ id: 'C-0001', tags: ['f'], statement: 'S.', verdict: 'proven' }, { id: 'C-0002', tags: ['f'], rank: 'headline', statement: 'T.', approvedBy: 'auto' }]);
  const [one] = readLedger(dir).claims;
  assert.deepEqual([one.status, one.rank, one.approvedBy], ['active', 'routine', 'user']);
});
