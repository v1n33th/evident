// Usage: node project.mjs <app dir | none> [<app's main domain>] [--folder <path>]
// Prints the project folder, as SKILL.md defines it, the first that applies:
//   1. --folder (an `Evident folder:` line), else $EVIDENT_HOME: <path>/<app-name>/ (global mode);
//   2. a .evident/ in the app dir or a folder above it, below the repo root (a per-app folder the user asked for);
//   3. <repo root>/.evident/, plus /<app path with - for /> when the app is below the root;
//   4. no repo: ~/evident/<app-name>/.
// Makes it, writes .evident/.gitignore when missing (never over one), and stops with a Problem line when environment.md
// there would not be git-ignored. In a worktree, links environment.md and tester-profiles.json to the main checkout's.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const GITIGNORE = '*\n!.gitignore\n!ledger/\n!ledger/**\n!*/\n!*/ledger/\n!*/ledger/**\n!targets/\n!targets/*.md\n!drivers/\n!drivers/*.md\n!*/targets/\n!*/targets/*.md\n!*/drivers/\n!*/drivers/*.md\n';
const SHARED = ['environment.md', 'tester-profiles.json'];
// Paths that must be ignored: setup, profiles, and a step's sessions and evidence, which keep secrets as captured.
const SECRET = ['environment.md', 'tester-profiles.json', 'f/2000-01-01-0000-prove/proof/sessions/s.jsonl', 'f/2000-01-01-0000-prove/proof/evidence/e.webm'];

const git = (dir, ...a) => { try { return execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
const appPath = (root, dir) => (root && dir ? relative(root, resolve(dir)).split('/').filter(Boolean).join('-') : '');
const repoRoot = (dir) => (dir && existsSync(dir) ? git(dir, 'rev-parse', '--show-toplevel') || null : null);

export function appName({ repoRoot: root, appDir, given = null }) {
  if (!root) return given ?? basename(resolve(appDir));
  const url = git(root, 'remote', 'get-url', 'origin');
  const path = url.replace(/\.git\/?$|\/$/g, '').replace(/^[^:]+:\/\/[^/]+\/|^[^@]+@[^:]+:/, '').split('/').filter(Boolean);
  const name = path.length >= 2
    ? [...path.slice(-2), ...(path.length >= 3 ? [createHash('sha1').update(url).digest('hex').slice(0, 6)] : [])].join('-')
    : basename(root);
  return [name, appPath(root, appDir)].filter(Boolean).join('-');
}

export function projectFolder({ appDir, given = null, named = null, home = homedir() }) {
  // git prints real paths, so a symlinked app dir must be real too, or the walk below never meets the root.
  if (appDir && existsSync(appDir)) appDir = realpathSync(appDir);
  const root = repoRoot(appDir);
  if (named) return { folder: join(resolve(named), appName({ repoRoot: root, appDir, given })), mode: 'named', evident: null, shared: null };
  if (!root) return { folder: join(home, 'evident', appName({ repoRoot: null, appDir, given })), mode: 'none', evident: null, shared: null };
  let at = null;
  for (let dir = resolve(appDir); dir !== root && !relative(root, dir).startsWith('..'); dir = dirname(dir)) {
    if (existsSync(join(dir, '.evident'))) { at = { folder: join(dir, '.evident'), mode: 'app', evident: join(dir, '.evident') }; break; }
  }
  at ??= { folder: join(root, '.evident', appPath(root, appDir)), mode: 'repo', evident: join(root, '.evident') };
  // A worktree's git dir differs from the common one; the main checkout is the common dir's parent.
  const common = git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const own = git(root, 'rev-parse', '--path-format=absolute', '--git-dir');
  const shared = common && own && common !== own ? join(dirname(common), relative(root, at.folder)) : null;
  return { ...at, shared };
}

export function prepare({ folder, evident = null, shared = null, appDir = null }) {
  const lines = [];
  const created = evident && !existsSync(evident);
  mkdirSync(folder, { recursive: true });
  if (evident && !existsSync(join(evident, '.gitignore'))) writeFileSync(join(evident, '.gitignore'), GITIGNORE);
  for (const f of SHARED) {
    const here = join(folder, f);
    let taken = true;
    try { lstatSync(here); } catch { taken = false; }
    if (shared && existsSync(join(shared, f)) && !taken) symlinkSync(join(shared, f), here);
  }
  if (git(folder, 'rev-parse', '--is-inside-work-tree') === 'true') {
    for (const path of SECRET) {
      try { execFileSync('git', ['-C', folder, 'check-ignore', '-q', '--no-index', path], { stdio: 'ignore' }); } catch {
        return { lines: [...lines, `Problem: ${folder} is not git-ignored (${path} would be committed). Its .gitignore must ignore everything but ledger/.`], exit: 1 };
      }
    }
  }
  if (created && appDir && existsSync(join(appDir, 'Dockerfile'))) {
    const ignore = existsSync(join(appDir, '.dockerignore')) ? readFileSync(join(appDir, '.dockerignore'), 'utf8') : '';
    if (!/^\/?\.evident\/?$/m.test(ignore)) lines.push('Note: Add .evident to .dockerignore, or images will copy test passwords and videos.');
  }
  return { lines, exit: 0 };
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--folder');
  const named = i >= 0 ? args.splice(i, 2)[1] : process.env.EVIDENT_HOME || null;
  const [dir, given = null] = args;
  const appDir = dir && dir !== 'none' ? resolve(dir) : null;
  if (!dir || (i >= 0 && !named) || (!appDir && !given && !named)) {
    console.error('Usage: node project.mjs <app dir | none> [<app\'s main domain>] [--folder <path>]; with no app dir, give the app\'s main domain');
    process.exit(1);
  }
  const at = projectFolder({ appDir, given, named });
  console.log(`Project folder: ${at.folder}`);
  if (at.shared) console.log(`Setup shared from: ${at.shared}`);
  const { lines, exit } = prepare({ ...at, appDir });
  if (lines.length) console.log(lines.join('\n'));
  process.exit(exit);
}
