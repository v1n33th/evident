import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../skills/fix-and-prove/scripts/fix-patch.mjs', import.meta.url));

test('fix-patch: the patch holds only the named files, and undoes the fix', () => {
  const repo = mkdtempSync(join(tmpdir(), 'repo-'));
  const run = mkdtempSync(join(tmpdir(), 'fix-'));
  mkdirSync(join(run, 'fixes'));
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo, encoding: 'utf8' });
  const cli = (...a) => execFileSync('node', [SCRIPT, ...a], { cwd: repo, encoding: 'utf8' });
  git('init', '-q');
  writeFileSync(join(repo, 'a.js'), 'limit > 10\n');
  writeFileSync(join(repo, 'b.js'), 'other\n');
  git('add', '-A'); git('commit', '-qm', 'base');

  cli('before', run, 'BUG-001', 'a.js');
  writeFileSync(join(repo, 'a.js'), 'limit >= 10\n');
  writeFileSync(join(repo, 'b.js'), 'another fixer\n');
  const out = cli('after', run, '1', 'BUG-001', 'a.js').trim();

  assert.equal(out, join(run, 'fixes', '1-BUG-001.patch'));
  const patch = readFileSync(out, 'utf8');
  assert.match(patch, /\+limit >= 10/);
  assert.doesNotMatch(patch, /another fixer/);
  assert.deepEqual(readdirSync(join(run, 'fixes')), ['1-BUG-001.patch']);
  git('apply', '-R', out);
  assert.equal(readFileSync(join(repo, 'a.js'), 'utf8'), 'limit > 10\n');
});

test('fix-patch: a second bug with the same number gets its own patch, never overwriting the first', () => {
  const repo = mkdtempSync(join(tmpdir(), 'repo-'));
  const run = mkdtempSync(join(tmpdir(), 'fix-'));
  mkdirSync(join(run, 'fixes'));
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo, encoding: 'utf8' });
  const cli = (...a) => execFileSync('node', [SCRIPT, ...a], { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q');
  writeFileSync(join(repo, 'a.js'), 'one\n');
  git('add', '-A'); git('commit', '-qm', 'base');
  cli('before', run, 'BUG-008', 'a.js');
  writeFileSync(join(repo, 'a.js'), 'two\n');
  const first = cli('after', run, '1', 'BUG-008', 'a.js');
  cli('before', run, 'BUG-008', './a.js');
  writeFileSync(join(repo, 'a.js'), 'three\n');
  const second = cli('after', run, '1', 'BUG-008', 'a.js');
  assert.equal(second, join(run, 'fixes', '1-BUG-008-2.patch'));
  assert.match(readFileSync(first, 'utf8'), /\+two/);
  assert.match(readFileSync(second, 'utf8'), /\+three/);
});

test('fix-patch commit: fixers that ran at once leave patches; commit makes one commit per bug in patch order and records it', () => {
  const repo = mkdtempSync(join(tmpdir(), 'repo-'));
  const run = mkdtempSync(join(tmpdir(), 'fix-'));
  mkdirSync(join(run, 'fixes'));
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo, encoding: 'utf8' });
  const cli = (...a) => execFileSync('node', [SCRIPT, ...a], { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  git('init', '-q');
  writeFileSync(join(repo, 'a.js'), 'a\n');
  writeFileSync(join(repo, 'b.js'), 'b\n');
  git('add', '-A'); git('commit', '-qm', 'base');
  // Two fixers at once, on different files.
  cli('before', run, 'BUG-010', 'b.js'); cli('before', run, 'BUG-002', 'a.js');
  writeFileSync(join(repo, 'b.js'), 'b fixed\n');
  writeFileSync(join(repo, 'a.js'), 'a fixed\n');
  cli('after', run, '1', 'BUG-010', 'b.js'); cli('after', run, '1', 'BUG-002', 'a.js');
  const bugs = join(run, 'bugs');
  const bug = (id, fix) => { const dir = join(bugs, `${id}-x`); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'bug.json'), JSON.stringify({ id, title: `title ${id}`, fix })); return dir; };
  const dirs = [
    bug('BUG-010', { status: 'fixed', patch: 'fixes/1-BUG-010.patch', commit: null }),
    bug('BUG-002', { status: 'fixed', patch: 'fixes/1-BUG-002.patch', commit: null }),
    bug('BUG-003', { status: 'fixed', summary: 'Fixed with BUG-002', patch: 'fixes/1-BUG-002.patch', commit: null }),
    bug('BUG-004', { status: 'needs-decision' }),
  ];
  const out = cli('commit', run, 'invites', ...dirs).trim().split('\n');
  assert.deepEqual(out.map((l) => l.split(' ')[0]), ['BUG-010', 'BUG-002'], 'the order the patches were written');
  assert.deepEqual(git('log', '--format=%s', '-2').trim().split('\n'), ['fix(invites): BUG-002 title BUG-002', 'fix(invites): BUG-010 title BUG-010']);
  const commit = (id) => JSON.parse(readFileSync(join(bugs, `${id}-x`, 'bug.json'), 'utf8')).fix.commit;
  assert.equal(commit('BUG-002'), out[1].split(' ')[1]);
  assert.equal(commit('BUG-003'), commit('BUG-002'), 'a bug fixed with another takes its commit');
  assert.equal(commit('BUG-004'), undefined);
  assert.equal(git('status', '--porcelain').trim(), '', 'the working tree matches the commits');
});

test('fix-patch: two fixers never change one file at once, and a patch takes only the files its snapshot claimed', () => {
  const repo = mkdtempSync(join(tmpdir(), 'repo-'));
  const run = mkdtempSync(join(tmpdir(), 'fix-'));
  mkdirSync(join(run, 'fixes'));
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo, encoding: 'utf8' });
  const cli = (...a) => spawnSync('node', [SCRIPT, ...a], { cwd: repo, encoding: 'utf8' });
  git('init', '-q');
  writeFileSync(join(repo, 'blocks.tsx'), 'a\nb\n');
  writeFileSync(join(repo, 'other.ts'), 'o\n');
  git('add', '-A'); git('commit', '-qm', 'base');
  assert.equal(cli('before', run, 'BUG-002', 'blocks.tsx').status, 0);
  // While BUG-002's snapshot claims the file, a second fixer waits for it, then gives up (here at once).
  const waited = spawnSync('node', ['-e', `import(${JSON.stringify(SCRIPT)}).then((m) => m.before(${JSON.stringify(run)}, 'BUG-006', ['blocks.tsx'], 0))`], { cwd: repo, encoding: 'utf8' });
  assert.match(waited.stderr, /blocks\.tsx is being changed for BUG-002 by another fixer/);
  assert.equal(cli('before', run, 'BUG-007', 'other.ts').status, 0, 'another file is free');
  writeFileSync(join(repo, 'blocks.tsx'), 'a2\nb\n');
  writeFileSync(join(repo, 'other.ts'), 'o2\n');
  assert.match(cli('after', run, '3', 'BUG-007', 'other.ts', 'blocks.tsx').stderr, /BUG-007: blocks\.tsx not named at "before"/);
  assert.equal(cli('after', run, '3', 'BUG-002', 'blocks.tsx').status, 0);
  assert.equal(cli('before', run, 'BUG-006', 'blocks.tsx').status, 0, 'free once BUG-002\'s patch is written');
  writeFileSync(join(repo, 'blocks.tsx'), 'a2\nb2\n');
  const patch = readFileSync(cli('after', run, '3', 'BUG-006', 'blocks.tsx').stdout.trim(), 'utf8');
  assert.match(patch, /\+b2/);
  assert.doesNotMatch(patch, /\+a2/, 'BUG-002\'s line is not in BUG-006\'s patch');
});

test('fix-patch live: a changed file whose compiled twin is older is Stale; a newer twin is Live; no twin, no line', () => {
  const repo = mkdtempSync(join(tmpdir(), 'repo-'));
  const run = mkdtempSync(join(tmpdir(), 'fix-'));
  mkdirSync(join(run, 'fixes'));
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo, encoding: 'utf8' });
  const cli = (...a) => spawnSync('node', [SCRIPT, ...a], { cwd: repo, encoding: 'utf8' });
  mkdirSync(join(repo, 'backend', 'src', 'quotes'), { recursive: true });
  mkdirSync(join(repo, 'backend', 'dist', 'quotes'), { recursive: true });
  mkdirSync(join(repo, 'web', 'src'), { recursive: true });
  mkdirSync(join(repo, 'web', 'dist', 'assets'), { recursive: true });
  writeFileSync(join(repo, 'backend', 'package.json'), '{}');
  writeFileSync(join(repo, 'web', 'package.json'), '{}');
  writeFileSync(join(repo, 'backend', 'src', 'quotes', 'links.ts'), 'a\n');
  writeFileSync(join(repo, 'web', 'src', 'blocks.tsx'), 'a\n');
  writeFileSync(join(repo, 'web', 'dist', 'assets', 'index-1a2b.js'), 'bundle\n');
  git('init', '-q'); git('add', '-A'); git('commit', '-qm', 'base');
  cli('before', run, 'BUG-001', 'backend/src/quotes/links.ts', 'web/src/blocks.tsx');
  writeFileSync(join(repo, 'backend', 'src', 'quotes', 'links.ts'), 'b\n');
  writeFileSync(join(repo, 'web', 'src', 'blocks.tsx'), 'b\n');
  const patch = cli('after', run, '1', 'BUG-001', 'backend/src/quotes/links.ts', 'web/src/blocks.tsx').stdout.trim();
  const twin = join(repo, 'backend', 'dist', 'quotes', 'links.js');
  writeFileSync(twin, 'old\n');
  utimesSync(twin, new Date(Date.now() - 60000), new Date(Date.now() - 60000));
  const stale = cli('live', patch);
  assert.equal(stale.status, 3);
  assert.equal(stale.stdout.trim(), 'Stale: backend/src/quotes/links.ts changed after backend/dist/quotes/links.js was built');
  const other = join(repo, 'backend', 'dist', 'quotes', 'other.js');
  writeFileSync(join(repo, 'backend', 'src', 'quotes', 'other.ts'), 'x\n');
  writeFileSync(other, 'old\n');
  utimesSync(other, new Date(Date.now() - 60000), new Date(Date.now() - 60000));
  assert.match(cli('live', patch).stdout, /^Unknown: backend\/src\/quotes\/links\.ts: other files of backend are newer than their build too/, 'a build already behind before the fix is no evidence');
  writeFileSync(twin, 'rebuilt\n');
  const fresh = cli('live', patch);
  assert.equal(fresh.status, 0);
  assert.match(fresh.stdout, /^Live: backend\/src\/quotes\/links\.ts/);
});

test('fix-patch reapply: a patch built on an undone fix comes back three-way; one on the same lines is a Conflict that changes nothing', () => {
  const repo = mkdtempSync(join(tmpdir(), 'repo-'));
  const run = mkdtempSync(join(tmpdir(), 'fix-'));
  mkdirSync(join(run, 'fixes'));
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo, encoding: 'utf8' });
  const cli = (...a) => spawnSync('node', [SCRIPT, ...a], { cwd: repo, encoding: 'utf8' });
  const a = (lines) => writeFileSync(join(repo, 'a.js'), lines.join('\n') + '\n');
  const base = ['one', 'two', 'three', 'four', 'five', 'six', 'seven'];
  git('init', '-q');
  a(base);
  git('add', '-A'); git('commit', '-qm', 'base');
  // BUG-001 changes line 3; BUG-002 then changes line 5, its context holding BUG-001's line; BUG-003 changes line 3 again.
  const fix = (bug, lines) => { cli('before', run, bug, 'a.js'); a(lines); return cli('after', run, '1', bug, 'a.js').stdout.trim(); };
  const p1 = fix('BUG-001', ['one', 'two', 'THREE', 'four', 'five', 'six', 'seven']);
  const p2 = fix('BUG-002', ['one', 'two', 'THREE', 'four', 'FIVE', 'six', 'seven']);
  const p3 = fix('BUG-003', ['one', 'two', 'Three!', 'four', 'FIVE', 'six', 'seven']);
  git('apply', '-R', p3); git('apply', '-R', p2); git('apply', '-R', p1);
  assert.notEqual(spawnSync('git', ['apply', '--check', p2], { cwd: repo }).status, 0, 'plain apply fails without BUG-001');

  const res = cli('reapply', p2, p3);
  assert.equal(res.status, 4);
  assert.equal(res.stdout, 'Reapplied 1-BUG-002.patch (three-way)\nConflict 1-BUG-003.patch\n');
  assert.equal(readFileSync(join(repo, 'a.js'), 'utf8'), ['one', 'two', 'three', 'four', 'FIVE', 'six', 'seven'].join('\n') + '\n');
  assert.equal(git('diff', '--cached', '--name-only'), '', 'git\'s own index is untouched');
  assert.deepEqual(readdirSync(join(run, 'fixes')).filter((f) => f.startsWith('.')), [], 'no scratch index is left');
  // BUG-001 back on top: its context now holds BUG-002's line, so it too comes back three-way.
  assert.equal(cli('reapply', p1).stdout, 'Reapplied 1-BUG-001.patch (three-way)\n');
  assert.equal(readFileSync(join(repo, 'a.js'), 'utf8'), ['one', 'two', 'THREE', 'four', 'FIVE', 'six', 'seven'].join('\n') + '\n');
});
