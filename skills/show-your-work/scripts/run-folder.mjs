// Usage: node run-folder.mjs <project folder> <feature> <request kind> <step> [--take-lock]
//        node run-folder.mjs --in <request folder> <step> [--take-lock]
//        node run-folder.mjs --release <project folder>   Deletes run.lock and marks the request it named as done.
// Makes a request folder, <project folder>/<feature>/<YYYY-MM-DD>-<HHMM>-<kind>/, and a step folder in it: explore with
// charters/ (the explorers' logs) and evidence/; proof with sessions/ and evidence/. A taken name gets -2, -3, ...
// Prints `Request folder:` and `Step folder:`, and writes the step and the agent's pid to run.lock. While run.lock names
// another step that has no result.json, is under 12 hours old and whose agent still runs, makes nothing and prints
// `Lock: held by <step>` (exit 2), unless --take-lock. A lock whose agent is gone is taken, with a `Lock: taken from` line.
// --in makes a step inside a request. When a step of that request holds the lock (an inner run), it leaves the lock alone;
// else (a re-prove) it takes the lock as a new request does, and stops on one another run holds.
// On macOS, taking the lock also starts `caffeinate -i -w <agent pid>` (pid in run.awake) so idle sleep cannot pause a long
// run; it ends with the agent, and --release and the next take stop it.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeSnapshot } from '../../evidence/scripts/definitions.mjs';
import { REQUEST, where } from './build-proof.mjs';
import { FEATURE } from './ledger.mjs';
import { readLock } from './report.mjs';

export { REQUEST, where };

const free = (base) => {
  let dir = base;
  for (let n = 2; existsSync(dir); n++) dir = `${base}-${n}`;
  return dir;
};

export function newRequest(project, feature, kind, now = new Date()) {
  if (!FEATURE.test(feature)) throw new Error(`feature "${feature}" is not a lowercase slug (a-z, 0-9, -; not ledger, terms, targets or drivers): pick another`);
  const time = [now.getHours(), now.getMinutes()].map((n) => String(n).padStart(2, '0')).join('');
  const dir = free(join(resolve(project), feature, `${now.toLocaleDateString('en-CA')}-${time}-${kind}`));
  mkdirSync(dir, { recursive: true });
  return dir;
}

// A step gets only the folders it uses (and targets.json); bugs/ is made by new-bug.mjs with the first bug.
export function newStep(request, name, subs = ['sessions', 'evidence']) {
  const dir = free(join(resolve(request), name));
  mkdirSync(dir, { recursive: true });
  for (const sub of subs) mkdirSync(join(dir, sub));
  // The targets this run resolved from environment.md, for the scripts that read them. No environment.md, no snapshot.
  const project = where(dir)?.project;
  if (project && existsSync(join(project, 'environment.md'))) {
    try { writeSnapshot(dir, project); } catch (e) { console.error(`Problem: ${e.message}`); }
  }
  return dir;
}
const folders = (step) => (step === 'explore' ? ['charters', 'evidence'] : undefined);

export function stopAwake(project) {
  const file = join(resolve(project), 'run.awake');
  if (!existsSync(file)) return;
  try { process.kill(Number(readFileSync(file, 'utf8')), 'SIGTERM'); } catch {}
  rmSync(file, { force: true });
}
// The agent this run belongs to: the first ancestor that is not a shell (the agent's shell tool sits in between).
// ponytail: `ps`, so null on Windows; the lock then falls back to its age alone.
export function agentPid(pid = process.ppid) {
  for (let i = 0; i < 8 && pid > 1; i++) {
    let out;
    try { out = execFileSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
    const [, parent, command] = out.match(/^(\d+)\s+(.+)$/) ?? [];
    if (!command) return null;
    if (!/^-?(sh|bash|zsh|dash|ksh|fish)$/.test(basename(command))) return pid;
    pid = Number(parent);
  }
  return null;
}
// ponytail: a 12-hour cap, the lock's own age limit, in case the agent's pid is unknown and no run releases it.
function keepAwake(project, agent) {
  stopAwake(project);
  if (process.platform !== 'darwin' || process.env.NODE_TEST_CONTEXT) return;
  const child = spawn('caffeinate', ['-i', '-t', String(12 * 3600), ...(agent ? ['-w', String(agent)] : [])], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
  if (child.pid) writeFileSync(join(resolve(project), 'run.awake'), String(child.pid));
}
// Writes run.lock for a step and keeps the machine awake while its agent runs.
export function takeLock(project, step) {
  const agent = agentPid();
  writeFileSync(join(resolve(project), 'run.lock'), `${step}\n${agent ?? ''}\n`);
  keepAwake(project, agent);
}
// The step another unfinished run holds the lock for, else null; `stale` names a lock left by a run whose agent is gone.
export function lockHeld(project) {
  const lock = readLock(resolve(project));
  if (!lock || existsSync(join(lock.step, 'result.json'))) return { held: null, stale: null, last: lock?.step ?? null };
  return lock.fresh ? { held: lock.step, stale: null, last: lock.step } : { held: null, stale: lock.step, last: lock.step };
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const { writeReportFor } = await import('./report.mjs');
  if (args[0] === '--in' && (args.length === 3 || (args.length === 4 && args[3] === '--take-lock'))) {
    // A folder that is not a request (no project above it) takes no lock.
    const project = where(join(args[1], args[2]))?.project;
    const { held, stale } = project ? lockHeld(project) : {};
    const own = held && resolve(held).startsWith(resolve(args[1]) + sep);
    if (held && !own && !args[3]) {
      console.log(`Lock: held by ${held}`);
      process.exit(2);
    }
    const step = newStep(args[1], args[2], folders(args[2]));
    if (project && !own) takeLock(project, step);
    if (stale) console.log(`Lock: taken from ${stale}: its run stopped`);
    console.log(`Step folder: ${step}`);
    await writeReportFor(step);
  } else if (args[0] === '--release' && args.length === 2) {
    // The run's last word: the lock goes, and the request's page is written once more, as done.
    const held = readLock(resolve(args[1]))?.step ?? '';
    rmSync(join(resolve(args[1]), 'run.lock'), { force: true });
    stopAwake(args[1]);
    console.log(held ? `Released: ${held}` : 'Released: no lock was held');
    if (held) await writeReportFor(held);
  } else if ((args.length === 4 || (args.length === 5 && args[4] === '--take-lock')) && !args[0].startsWith('--')) {
    const { held, stale, last } = lockHeld(args[0]);
    if (held && !args[4]) {
      console.log(`Lock: held by ${held}`);
      process.exit(2);
    }
    const request = newRequest(args[0], args[1], args[2]);
    const step = newStep(request, args[3], folders(args[3]));
    takeLock(args[0], step);
    if (stale) console.log(`Lock: taken from ${stale}: its run stopped`);
    console.log(`Request folder: ${request}\nStep folder: ${step}`);
    await writeReportFor(step);
    // The run that held the lock is over (finished, crashed or taken over): its page stops refreshing.
    if (last) await writeReportFor(last);
  } else {
    console.error('Usage: node run-folder.mjs <project folder> <feature> <request kind> <step> [--take-lock]\n       node run-folder.mjs --in <request folder> <step> [--take-lock]\n       node run-folder.mjs --release <project folder>');
    process.exit(1);
  }
}
