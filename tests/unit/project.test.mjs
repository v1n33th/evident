import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appName, prepare, projectFolder } from '../../skills/evidence/scripts/project.mjs';

const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const ignored = (dir, path) => { try { git(dir, 'check-ignore', '-q', path); return true; } catch { return false; } };
const repo = (name = 'shop') => {
  const dir = join(realpathSync(mkdtempSync(join(tmpdir(), 'project-'))), name);
  mkdirSync(dir);
  git(dir, 'init', '-q');
  return dir;
};
const GITIGNORE = '*\n!.gitignore\n!ledger/\n!ledger/**\n!*/\n!*/ledger/\n!*/ledger/**\n!targets/\n!targets/*.md\n!drivers/\n!drivers/*.md\n!*/targets/\n!*/targets/*.md\n!*/drivers/\n!*/drivers/*.md\n';

test('appName joins owner-repo and the app path, hashes a deep remote, and falls back to the folder or the domain', () => {
  const r = repo();
  assert.equal(appName({ repoRoot: r, appDir: r }), 'shop');
  git(r, 'remote', 'add', 'origin', 'git@github.com:acme/acme-invites.git');
  assert.equal(appName({ repoRoot: r, appDir: r }), 'acme-acme-invites');
  assert.equal(appName({ repoRoot: r, appDir: join(r, 'apps', 'web') }), 'acme-acme-invites-apps-web');
  git(r, 'remote', 'set-url', 'origin', 'https://gitlab.com/group/sub/repo.git');
  assert.match(appName({ repoRoot: r, appDir: r }), /^sub-repo-[0-9a-f]{6}$/);
  assert.equal(appName({ repoRoot: null, appDir: null, given: 'example.com' }), 'example.com');
});

test('projectFolder picks named, then a per-app .evident, then the repo root, then ~/evident', () => {
  const r = repo();
  const web = join(r, 'apps', 'web');
  mkdirSync(join(web, 'src'), { recursive: true });
  assert.deepEqual(projectFolder({ appDir: r, named: '/g' }), { folder: '/g/shop', mode: 'named', evident: null, shared: null });
  assert.deepEqual(projectFolder({ appDir: web }), { folder: join(r, '.evident', 'apps-web'), mode: 'repo', evident: join(r, '.evident'), shared: null });
  assert.deepEqual(projectFolder({ appDir: r }), { folder: join(r, '.evident'), mode: 'repo', evident: join(r, '.evident'), shared: null });
  mkdirSync(join(web, '.evident'));
  assert.deepEqual(projectFolder({ appDir: join(web, 'src') }), { folder: join(web, '.evident'), mode: 'app', evident: join(web, '.evident'), shared: null });
  assert.deepEqual(projectFolder({ appDir: null, given: 'example.com', home: '/h' }), { folder: '/h/evident/example.com', mode: 'none', evident: null, shared: null });
});

test('prepare writes .gitignore once, never over an edited one, and stops when environment.md would be committed', () => {
  const r = repo();
  const at = projectFolder({ appDir: r });
  assert.equal(prepare({ ...at, appDir: r }).exit, 0);
  assert.equal(readFileSync(join(r, '.evident', '.gitignore'), 'utf8'), GITIGNORE);
  assert.ok(ignored(r, '.evident/environment.md'));
  assert.ok(ignored(r, '.evident/invites/2026-11-01-0900-explore/explore/sessions/s1.jsonl'));
  assert.ok(!ignored(r, '.evident/ledger/f/claims.json'));
  assert.ok(!ignored(r, '.evident/apps-web/ledger/f/claims.json'));
  assert.ok(!ignored(r, '.evident/.gitignore'));
  // Only definition files are shared: a run under a feature named targets or drivers keeps its evidence ignored.
  assert.ok(!ignored(r, '.evident/targets/x.md'));
  assert.ok(!ignored(r, '.evident/apps-web/drivers/x.md'));
  assert.ok(ignored(r, '.evident/targets/2026-11-05-0900-prove/proof/evidence/x.png'));
  assert.ok(ignored(r, '.evident/targets/2026-11-05-0900-prove/proof/sessions/s.jsonl'));
  assert.ok(ignored(r, '.evident/apps-web/drivers/2026-11-05-0900-prove/proof/evidence/e.webm'));

  const edited = repo();
  mkdirSync(join(edited, '.evident'));
  writeFileSync(join(edited, '.evident', '.gitignore'), 'ledger/\n');
  const { lines, exit } = prepare({ ...projectFolder({ appDir: edited }), appDir: edited });
  assert.equal(exit, 1);
  assert.match(lines.join('\n'), /^Problem: .*not git-ignored/m);
  assert.equal(readFileSync(join(edited, '.evident', '.gitignore'), 'utf8'), 'ledger/\n');
});

test('a worktree shares environment.md and tester-profiles.json from the main checkout', () => {
  const main = repo();
  writeFileSync(join(main, 'app.txt'), 'v1');
  git(main, 'add', '-A');
  git(main, '-c', 'user.name=qa', '-c', 'user.email=qa@acme.test', 'commit', '-qm', 'base');
  prepare({ ...projectFolder({ appDir: main }), appDir: main });
  writeFileSync(join(main, '.evident', 'environment.md'), '## Target\n');
  const wt = join(main, '..', 'wt');
  git(main, 'worktree', 'add', '-q', wt);
  const at = projectFolder({ appDir: wt });
  assert.equal(at.folder, join(wt, '.evident'));
  assert.equal(at.shared, join(main, '.evident'));
  assert.equal(prepare({ ...at, appDir: wt }).exit, 0);
  assert.ok(lstatSync(join(wt, '.evident', 'environment.md')).isSymbolicLink());
  assert.equal(readlinkSync(join(wt, '.evident', 'environment.md')), join(main, '.evident', 'environment.md'));
  assert.equal(existsSync(join(wt, '.evident', 'tester-profiles.json')), false);
});

test('prepare notes a Dockerfile without .evident in .dockerignore, only when it creates .evident', () => {
  const r = repo();
  writeFileSync(join(r, 'Dockerfile'), 'FROM node\n');
  const at = projectFolder({ appDir: r });
  assert.ok(prepare({ ...at, appDir: r }).lines.includes('Note: Add .evident to .dockerignore, or images will copy test passwords and videos.'));
  assert.ok(!prepare({ ...at, appDir: r }).lines.some((l) => l.startsWith('Note:')));
});

test('projectFolder resolves an app dir reached through a symlink, so the search never climbs above the repo', () => {
  const r = repo();
  const web = join(r, 'apps', 'web');
  mkdirSync(web, { recursive: true });
  mkdirSync(join(r, '..', '.evident'));
  const link = join(r, '..', 'link');
  symlinkSync(r, link);
  assert.equal(projectFolder({ appDir: join(link, 'apps', 'web') }).folder, join(r, '.evident', 'apps-web'));
  assert.equal(projectFolder({ appDir: link }).folder, join(r, '.evident'));
});

test('prepare stops when an edited .gitignore leaves evidence or profiles committable', () => {
  const r = repo();
  mkdirSync(join(r, '.evident'));
  writeFileSync(join(r, '.evident', '.gitignore'), 'environment.md\n');
  const { lines, exit } = prepare({ ...projectFolder({ appDir: r }), appDir: r });
  assert.equal(exit, 1);
  assert.match(lines.join('\n'), /^Problem: /m);
});

test('a new .gitignore keeps targets/ and drivers/ committable', () => {
  const r = repo();
  const { exit } = prepare({ ...projectFolder({ appDir: r }), appDir: r });
  assert.equal(exit, 0);
  const ignored = (p) => { try { execFileSync('git', ['-C', r, 'check-ignore', '-q', '--no-index', p]); return 0; } catch (e) { return e.status; } };
  assert.equal(ignored('.evident/targets/x.md'), 1);
  assert.equal(ignored('.evident/drivers/x.md'), 1);
  assert.equal(ignored('.evident/environment.md'), 0);
  assert.equal(ignored('.evident/tester-profiles.json'), 0);
});
