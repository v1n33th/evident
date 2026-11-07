// Usage: node fix-patch.mjs before <fix run> <BUG-NNN> <file> ...           Snapshots the code (the current folder) before a fix, claiming the files it will change.
//        node fix-patch.mjs after <fix run> <round> <BUG-NNN> <file> ...   Writes <fix run>/fixes/<round>-BUG-NNN.patch (-2, -3 ... when taken) and prints it: what changed since `before`.
//        node fix-patch.mjs commit <fix run> <feature> <bug folder> ...      Commits each fixed bug's patch, in the order written, one commit per bug (exit 4 on a Conflict line), and writes its id into bug.json.
//        node fix-patch.mjs live <patch> ...                                 Says whether the app rebuilt each file the patches change (exit 3 when one is Stale).
//        node fix-patch.mjs reapply <patch> ...                              Re-applies each patch, oldest first, three-way when it no longer applies as it is (exit 4 on a Conflict line).
// Each snapshot uses its own index file, so fixers running in parallel never share git's index. Fixers running at once
// never change one file together: a patch would hold the other fixer's lines, and its undo would undo both fixes. So
// `before` waits while another bug's open snapshot claims one of its files, and `after` takes only claimed files.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function tree(fixRun, bug) {
  const env = { ...process.env, GIT_INDEX_FILE: join(fixRun, 'fixes', `.index-${bug}`) };
  try {
    execFileSync('git', ['add', '-A'], { env });
    return execFileSync('git', ['write-tree'], { env, encoding: 'utf8' }).trim();
  } finally {
    rmSync(env.GIT_INDEX_FILE, { force: true });
  }
}

const mark = (fixRun, bug) => join(fixRun, 'fixes', `.before-${bug}`);
// A snapshot file: the tree on its first line, then each file it claims. One older than STALE is a fixer that died.
const STALE_MS = 60 * 60 * 1000;
const WAIT_MS = 90 * 1000;
// Files as paths from the code path (the current folder), so `./a.js` and `a.js` are one file.
const norm = (files) => files.map((f) => relative(process.cwd(), resolve(f)));
const readMark = (file) => { const [tree, ...files] = readFileSync(file, 'utf8').split('\n').filter(Boolean); return { tree, files }; };

// The first other open snapshot, oldest first (then by name), that claims one of these files.
function holder(fixRun, bug, files) {
  const dir = join(fixRun, 'fixes');
  const mine = statSync(mark(fixRun, bug)).mtimeMs;
  return readdirSync(dir).filter((n) => n.startsWith('.before-') && n !== `.before-${bug}`).flatMap((n) => {
    try { const at = statSync(join(dir, n)).mtimeMs; return Date.now() - at < STALE_MS ? [{ bug: n.slice(8), at, file: readMark(join(dir, n)).files.find((f) => files.includes(f)) }] : []; } catch { return []; }
  }).filter((o) => o.file && (o.at < mine || (o.at === mine && o.bug < bug)))[0];
}

// Writes the snapshot first and then looks: of two fixers that claim one file at the same moment, the newer gives way.
export function before(fixRun, bug, named = [], wait = WAIT_MS) {
  const files = norm(named);
  const end = Date.now() + wait;
  for (;;) {
    writeFileSync(mark(fixRun, bug), [tree(fixRun, bug), ...files].join('\n') + '\n');
    const other = holder(fixRun, bug, files);
    if (!other) return;
    rmSync(mark(fixRun, bug));
    if (Date.now() > end) throw new Error(`${other.file} is being changed for ${other.bug} by another fixer: change nothing, then run this again`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
  }
}

export function after(fixRun, round, bug, files) {
  if (!existsSync(mark(fixRun, bug))) throw new Error(`no snapshot for ${bug}: run "before" first`);
  const snap = readMark(mark(fixRun, bug));
  const unclaimed = files.filter((f, i) => !snap.files.includes(norm(files)[i]));
  if (unclaimed.length) throw new Error(`${bug}: ${unclaimed.join(', ')} not named at "before", so another fixer may have changed it too. Put back every change for ${bug}, run "before" again naming every file, then make them again`);
  const patch = execFileSync('git', ['diff', snap.tree, tree(fixRun, bug), '--', ...files], { encoding: 'utf8' });
  if (!patch) throw new Error(`${bug}: no change in ${files.join(', ')}`);
  // A bug carried from an earlier request can share its number with a new one: never overwrite a patch, take the next free name.
  let out = join(fixRun, 'fixes', `${round}-${bug}.patch`);
  for (let i = 2; existsSync(out); i++) out = join(fixRun, 'fixes', `${round}-${bug}-${i}.patch`);
  writeFileSync(out, patch);
  rmSync(mark(fixRun, bug));
  return out;
}

// Re-applies patches after an earlier fix was undone, in the order given (oldest first), on the working tree only. A patch
// that no longer applies as it is gets a three-way merge from the file versions its index lines name (`after` stored them
// in git), tried on a scratch index first, so a conflict leaves the code and git's own index untouched.
export function reapply(patches) {
  const git = (a, env) => spawnSync('git', a, { encoding: 'utf8', env: { ...process.env, ...env } });
  return patches.map((p) => {
    const name = basename(p);
    if (git(['apply', '--check', p]).status === 0) { git(['apply', p]); return `Reapplied ${name}`; }
    const env = { GIT_INDEX_FILE: join(dirname(p), `.index-reapply-${name}`) };
    try {
      if (git(['add', '-A'], env).status !== 0 || git(['apply', '--cached', '-3', p], env).status !== 0) return `Conflict ${name}`;
      for (const [, file] of readFileSync(p, 'utf8').matchAll(/^diff --git a\/.+ b\/(.+)$/gm)) {
        if (git(['ls-files', '--cached', '--', file], env).stdout.trim()) git(['checkout-index', '-f', '--', file], env);
        else rmSync(file, { force: true });
      }
      return `Reapplied ${name} (three-way)`;
    } finally {
      rmSync(env.GIT_INDEX_FILE, { force: true });
    }
  });
}

// Fixers that ran at once with commits deferred leave patches only: commit them as each fixer would have (FIXER.md step 6),
// in the order they were written, so each patch's context is the tree it was made on. A bug "Fixed with" another takes
// that one's commit. A patch that does not apply stops the commits there: it and the ones after stay patches.
export function commitPatches(fixRun, feature, bugDirs) {
  const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim();
  const read = (dir) => ({ dir, bug: JSON.parse(readFileSync(join(dir, 'bug.json'), 'utf8')) });
  const bugs = bugDirs.map(read).filter(({ bug }) => ['fixed', 'partly-fixed'].includes(bug.fix?.status) && bug.fix.patch && !bug.fix.commit);
  const own = bugs.filter(({ bug }) => !/^Fixed with BUG-\d+/.test(bug.fix.summary ?? ''))
    .sort((a, b) => statSync(join(fixRun, a.bug.fix.patch)).mtimeMs - statSync(join(fixRun, b.bug.fix.patch)).mtimeMs);
  const done = new Map();
  const lines = [];
  for (const { dir, bug } of own) {
    try { git('diff', '--cached', '--quiet'); } catch { throw new Error(`staged changes that are not a fix: commit or unstage them, then run commit again (${done.size} committed)`); }
    try { git('apply', '--cached', join(fixRun, bug.fix.patch)); } catch { lines.push(`Conflict ${bug.fix.patch}: it and the patches after it stay uncommitted`); break; }
    git('commit', '-q', '-m', `fix(${feature}): ${bug.id} ${bug.title}`);
    done.set(bug.id, git('rev-parse', '--short', 'HEAD'));
    writeFileSync(join(dir, 'bug.json'), JSON.stringify({ ...bug, fix: { ...bug.fix, commit: done.get(bug.id) } }, null, 2) + '\n');
  }
  for (const { dir, bug } of bugs) {
    const with_ = /^Fixed with (BUG-\d+)/.exec(bug.fix.summary ?? '')?.[1];
    if (with_ && done.has(with_)) writeFileSync(join(dir, 'bug.json'), JSON.stringify({ ...bug, fix: { ...bug.fix, commit: done.get(with_) } }, null, 2) + '\n');
  }
  return [...[...done].map(([id, commit]) => `${id} ${commit}`), ...lines];
}

// The compiled twin of each changed file (src/a/b.ts as dist/a/b.js, in its package's dist, build or out), when the app
// builds one: older than the file means the app did not rebuild after the change or its undo, so it serves old code.
// A bundler's output has no twin, and a file with none is not checked. When another source of the package, which no patch
// changed, is newer than its own twin too, the build was not kept current before this fix either (a leftover build while
// the app runs from source): Unknown, not Stale.
const walk = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.name === 'node_modules' ? []
  : e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])) : []);
const SOURCE = /\.[cm]?[jt]sx?$/;
export function live(patches) {
  const files = [...new Set(patches.flatMap((p) => [...readFileSync(p, 'utf8').matchAll(/^(?:\+\+\+|---) [ab]\/(.+)$/gm)].map((m) => m[1])))];
  return files.flatMap((file) => {
    if (!existsSync(file) || !SOURCE.test(file)) return [];
    let pkg = dirname(file);
    while (pkg !== '.' && !existsSync(join(pkg, 'package.json'))) pkg = dirname(pkg);
    const built = ['dist', 'build', 'out'].flatMap((d) => walk(join(pkg, d)));
    const twinOf = (f) => { const stem = relative(pkg, f).replace(/^src\//, '').replace(/\.[^.]+$/, ''); return built.find((b) => b.endsWith(`/${stem}.js`)); };
    const older = (f) => { const t = twinOf(f); return Boolean(t) && statSync(t).mtimeMs < statSync(f).mtimeMs; };
    const twin = twinOf(file);
    if (!twin) return [];
    if (!older(file)) return [`Live: ${file} (${twin})`];
    const leftover = walk(join(pkg, 'src')).some((f) => SOURCE.test(f) && !files.includes(f) && older(f));
    return [leftover ? `Unknown: ${file}: other files of ${pkg} are newer than their build too, so the app may not run ${twin}` : `Stale: ${file} changed after ${twin} was built`];
  });
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  const [step, run, ...rest] = process.argv.slice(2);
  try {
    if (step === 'before' && run && rest.length >= 2) before(resolve(run), rest[0], rest.slice(1));
    else if (step === 'after' && run && rest.length >= 3) console.log(after(resolve(run), rest[0], rest[1], rest.slice(2)));
    else if (step === 'live' && run) {
      const lines = live([run, ...rest].map((p) => resolve(p)));
      console.log(lines.join('\n') || 'No compiled file to check');
      if (lines.some((l) => l.startsWith('Stale:'))) process.exit(3);
    }
    else if (step === 'reapply' && run) {
      const lines = reapply([run, ...rest].map((p) => resolve(p)));
      console.log(lines.join('\n'));
      if (lines.some((l) => l.startsWith('Conflict'))) process.exit(4);
    }
    else if (step === 'commit' && run && rest.length >= 2) {
      const lines = commitPatches(resolve(run), rest[0], rest.slice(1).map((d) => resolve(d)));
      console.log(lines.join('\n') || 'nothing to commit');
      if (lines.some((l) => l.startsWith('Conflict'))) process.exit(4);
    }
    else throw new Error('Usage: node fix-patch.mjs before <fix run> <BUG-NNN> <file> ... | after <fix run> <round> <BUG-NNN> <file> ... | commit <fix run> <feature> <bug folder> ... | live <patch> ... | reapply <patch> ...');
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
