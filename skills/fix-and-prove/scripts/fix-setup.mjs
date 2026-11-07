// Usage: node fix-setup.mjs <project folder> <feature> <code path> [<run>] [--report] [--improve] [--take-lock] [--all-features] [--batch <n>] [--list]
// fix-and-prove §1's checks and run folders in one call. Prints the pending bugs (in <run>, a request folder or its explore step,
// else in the newest of the feature's explore steps that has one, every feature's with --all-features; the older steps as
// Older run: counts; with --batch, the most severe that many), the branch, the main branch and whether there is
// uncommitted work; with --improve, also the bugs earlier fix runs left not-fixed, as Not fixed before: lines. Then picks the request folder: with --report, the one its bugs are in (grown);
// else a new -improve (--improve) or -explore-and-fix one. Makes the fix step in it (fix/, fix-2/, ...,
// with fixes/), writes run.lock and, with no claim tagged with the feature, makes the spec step (the baseline).
// Saves the user's uncommitted edits as <fix run>/user.diff, so fixers tell them from earlier fixes. --list prints and
// creates nothing. Creates nothing when another run holds the lock (exit 2), with --report and no pending bug (exit 3), or when the ledger
// has problems such as git conflict markers (exit 4).
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lockHeld, newRequest, newStep, REQUEST, takeLock as writeLock } from '../../show-your-work/scripts/run-folder.mjs';
import { readLedger, select } from '../../show-your-work/scripts/ledger.mjs';
import { contradicted } from '../../show-your-work/scripts/build-proof.mjs';

const dirs = (d) => (existsSync(d) ? readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(d, e.name)) : []);

export function fixSetup({ project, feature, code, run = null, report = false, improve = false, takeLock = false, allFeatures = false, batch = null, list = false }) {
  const lines = [];
  const git = (...a) => { try { return execFileSync('git', ['-C', code, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };

  // §1 step 1: bugs with no fix, newest request first, from explore steps (explore, explore-2, ...) of request folders.
  // Only request folders count, so ledger/ and a monorepo's per-app folders are never taken for features.
  const isExplore = (d) => /^explore(-\d+)?$/.test(basename(d));
  const named = run && resolve(run);
  const steps = named ? (REQUEST.test(basename(named)) ? dirs(named).filter(isExplore) : [named])
    : (allFeatures ? dirs(project).filter((f) => basename(f) !== 'ledger') : [join(project, feature)])
      .flatMap(dirs).filter((r) => REQUEST.test(basename(r))).flatMap(dirs).filter(isExplore)
      .sort((a, b) => `${basename(dirname(b))}/${basename(b)}`.localeCompare(`${basename(dirname(a))}/${basename(a)}`));
  // With no run named, only the newest explore step with a bug to fix: an older run's bugs are mostly the same defects
  // filed again, so they are fixed when the request names that run. Duplicates and withdrawn bugs are no bugs of their own.
  const checked = new Map();
  const why = (step, bug) => { if (!checked.has(step)) checked.set(step, contradicted(step)); return !bug.fix && checked.get(step).get(bug.id); };
  const all = steps.map((step) => ({ step, bugs: dirs(join(step, 'bugs')).sort().flatMap((dir) => {
    try { return [{ dir, bug: JSON.parse(readFileSync(join(dir, 'bug.json'), 'utf8')) }]; } catch { return []; }
  }).filter(({ bug }) => !bug.duplicateOf && !bug.withdrawn) }));
  // A decision from the page that asks for a fix ("Yes, change it", "Try again") makes a named run's bug pending again.
  const asked = (fix) => fix.decided && fix.decided !== 'Ship it' && !['fixed', 'partly-fixed', 'wont-fix'].includes(fix.status);
  const pick = named ? null : all.find(({ step, bugs }) => bugs.some(({ bug }) => !bug.fix && !why(step, bug)))?.step;
  const pending = [];
  const older = new Map();
  const notFixed = [];
  const unconfirmed = [];
  for (const { step, bugs } of all) for (const { dir, bug } of bugs) {
    const mine = named || step === pick;
    // A bug whose own picture the evidence check contradicts is not counted, so it is not fixed either.
    if (why(step, bug)) unconfirmed.push(`Not confirmed, left out: ${relative(project, step)} ${bug.id ?? basename(dir)} ${bug.title}: ${why(step, bug)}`);
    else if (!bug.fix || (named && asked(bug.fix))) { if (mine) pending.push({ request: dirname(step), bug, line: `  ${relative(project, step)} ${bug.id ?? basename(dir)} ${bug.severity} ${bug.title}` }); else older.set(step, (older.get(step) ?? 0) + 1); }
    // Self-improvement carries these into round 1, from the newest request that explored only: its explorers saw the
    // older ones again. needs-decision bugs wait for the user, so they stay out.
    else if (bug.fix.status === 'not-fixed' && dirname(step) === dirname(steps[0])) notFixed.push(`Not fixed before: ${dir} ${bug.title}`);
  }
  // --batch: the most severe first, as many as the batch; the rest wait for a later request.
  const RANK = ['critical', 'major', 'minor', 'cosmetic'];
  const kept = batch && pending.length > batch ? [...pending].sort((a, b) => RANK.indexOf(a.bug.severity) - RANK.indexOf(b.bug.severity)).slice(0, batch) : pending;
  lines.push(`Pending bugs: ${kept.length}`, ...kept.map((p) => p.line),
    ...(kept.length < pending.length ? [`Left out by Batch: ${batch}: ${pending.filter((p) => !kept.includes(p)).map((p) => p.bug.id).join(' ')}`] : []),
    ...unconfirmed, ...[...older].map(([step, n]) => `Older run: ${relative(project, step)} ${n} pending, fixed only when named`));
  pending.splice(0, pending.length, ...kept);
  if (improve) lines.push(...notFixed);

  const main = git('symbolic-ref', '--short', 'refs/remotes/origin/HEAD').replace(/^origin\//, '')
    || ['main', 'master'].find((b) => git('rev-parse', '--verify', '--quiet', b)) || 'none';
  lines.push(`Branch: ${git('branch', '--show-current') || 'detached'} at ${git('rev-parse', '--short', 'HEAD')}; main branch: ${main}; uncommitted work: ${git('status', '--porcelain', '--', '.', ':(exclude,glob)**/.evident/**') ? 'yes' : 'no'}`);

  if (list) return { lines, exit: 0 };
  // RUN.md step 3: a lock under 12 hours old on a run that has not finished and whose agent still runs.
  const { held, stale } = lockHeld(project);
  if (held && !takeLock) return { lines: [...lines, `Lock: held by ${held}`], exit: 2 };
  if (report && !pending.length) return { lines, exit: 3 };
  // A conflicted or broken ledger file hides its feature's claims: stop before anything is made, never fix as if they were gone.
  const ledger = readLedger(join(project, 'ledger'));
  if (ledger.problems.length) return { lines: [...lines, ...ledger.problems.map((p) => `Problem: ${p}`), `Ledger: resolve the problems above in ${join(project, 'ledger')}, then run again`], exit: 4 };

  // Fixing a report grows the request folder its bugs are in: one, since they come from one explore step.
  const request = report ? (named && REQUEST.test(basename(named)) ? named : pending[0].request)
    : newRequest(project, feature, improve ? 'improve' : 'explore-and-fix');
  lines.push(`Request folder: ${request}`);
  const fixRun = newStep(request, 'fix', ['fixes']);
  writeLock(project, fixRun);
  writeFileSync(join(fixRun, 'user.diff'), `${git('diff', '-U0')}\n`);
  if (stale) lines.push(`Lock: taken from ${stale}: its run stopped`);
  lines.push(`Fix run: ${fixRun}`);
  // No claim tagged with the feature yet: the spec gives the first claims, in a baseline step.
  const tagged = select(ledger.claims, { tags: [feature] });
  if (tagged.length) lines.push(`Ledger: ${tagged.length} claims tagged ${feature}`);
  else lines.push('Ledger: none', `Baseline run: ${newStep(request, 'spec', [])}`);
  return { lines, exit: 0, fixRun };
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const b = args.indexOf('--batch');
  const batch = b >= 0 ? Number(args.splice(b, 2)[1]) || null : null;
  const [project, feature, code, run] = args.filter((a) => !a.startsWith('--'));
  if (!project || !feature || !code) {
    console.error('Usage: node fix-setup.mjs <project folder> <feature> <code path> [<run>] [--report] [--improve] [--take-lock] [--all-features] [--batch <n>] [--list]');
    process.exit(1);
  }
  const { lines, exit, fixRun } = fixSetup({ project, feature, code, run, report: args.includes('--report'), improve: args.includes('--improve'), takeLock: args.includes('--take-lock'), allFeatures: args.includes('--all-features'), batch, list: args.includes('--list') });
  console.log(lines.join('\n'));
  if (fixRun) await (await import('../../show-your-work/scripts/report.mjs')).writeReportFor(fixRun);
  process.exit(exit);
}
