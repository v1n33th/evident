// Usage: node sessions.mjs <run folder> close [--name <browser session name>] [<Session id> ...]
// Closes browser sessions, so a run leaves no browser open to fill memory. With Session ids, closes those (a tester's
// last step). With none, closes every session the step folder records (charters.json, sessions/, the session logs, an
// explorer's saved browser session) and, with --name (the request's browser session name), every open session whose
// name starts with this run's prefix; then stops orphan browsers: a driver's main browser process whose profile matches
// its `orphans` setting and whose parent is gone (parent PID 1), so its own close cannot reach it: TERM, then KILL.
// Each driver of the step's targets.json says how, in its definition: `list` prints the open sessions, `close` closes the
// one named <name>. A session's name is what the run's own driver command gives it (its value after the parallel flag),
// and only a listed one is closed, so another run's sessions are never touched. A driver with no close form is skipped.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { notAStep, projectDir } from '../../show-your-work/scripts/build-proof.mjs';
import { fillCommand, findDefinition, parseDefinition, snapshot } from './definitions.mjs';

const json = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const names = (dir, pattern) => (existsSync(dir) ? readdirSync(dir).map((f) => f.match(pattern)?.[1]).filter(Boolean) : []);

// Every Session id the step folder holds: its charters, its provers' logs and claims, and the per-session evidence logs.
export function recordedSessions(run) {
  return [...new Set([
    ...(json(join(run, 'charters.json'))?.charters ?? []).map((c) => c.id),
    ...names(join(run, 'charters'), /^([^.].*)\.jsonl$/),
    ...names(join(run, 'sessions'), /^([^.].*?)(?:\.claims\.json|\.jsonl)$/),
    ...names(run, /^evidence-(.+)\.jsonl$/).filter((id) => id !== 'check'),
  ])].filter(Boolean).sort();
}

// The step's drivers that can close sessions, each once: its command (as the run fills it) and its definition.
function drivers(run, project, home) {
  const targets = json(join(run, 'targets.json'))?.targets ?? snapshot(project, { home }).targets;
  const seen = new Map();
  for (const t of Object.values(targets)) {
    const d = t.driver;
    if (!d?.name || seen.has(`${d.name}\n${d.command}`)) continue;
    const file = t.files?.driver;
    const def = file && existsSync(file) ? parseDefinition(readFileSync(file, 'utf8'), file, 'driver') : findDefinition('driver', d.name, { project, home });
    if (def) seen.set(`${d.name}\n${d.command}`, { ...d, settings: def.settings });
  }
  return [...seen.values()];
}

// The session's name as the run's driver command spells it: the value after its parallel flag (--session), else
// <app-name>-<session>.
const sessionName = (driver, project, id) => {
  const flag = typeof driver.settings.parallel === 'string' ? driver.settings.parallel : null;
  const filled = fillCommand(driver.command ?? driver.settings.command, project, id);
  const at = flag && filled?.match(new RegExp(`${escape(flag)}[ =](\\S+)`));
  return at ? at[1].replace(/^['"]|['"]$/g, '') : fillCommand('<app-name>-<session>', project, id);
};

// An explorer's browser session as start.mjs filled it (charters/.<id>.json), which carries a run name its id lacks.
const savedSessions = (run) => names(join(run, 'charters'), /^\.(.+)\.json$/)
  .map((id) => json(join(run, 'charters', `.${id}.json`))?.browserSession).filter(Boolean);

const sh = (command) => spawnSync('sh', ['-c', command], { encoding: 'utf8', timeout: 30000 });

// Main browser processes (no --type=, so no renderer or GPU helper; crashpad's --database is no profile) whose
// --user-data-dir matches the pattern and whose parent is PID 1.
export function orphanPids(psText, pattern) {
  return String(psText).split('\n').map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
    .filter(([, , ppid, cmd]) => ppid === '1' && !/\s--type=/.test(cmd) && new RegExp(`--user-data-dir=\\S*${escape(pattern)}`).test(cmd))
    .map(([, pid]) => Number(pid));
}

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// EPERM: the process lives but is not ours (ps -x lists only our own, so this is a reused PID): count it alive, never stopped.
const isAlive = (kill, pid) => { try { kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; } };

export function stopOrphans(pids, { kill = process.kill.bind(process), wait = 3000 } = {}) {
  for (const pid of pids) { try { kill(pid, 'SIGTERM'); } catch {} }
  for (let t = 0; t < wait && pids.some((pid) => isAlive(kill, pid)); t += 100) pause(Math.min(100, wait));
  return pids.map((pid) => {
    if (!isAlive(kill, pid)) return `Stopped orphan browser ${pid}`;
    try { kill(pid, 'SIGKILL'); } catch {}
    return `Killed orphan browser ${pid}`;
  });
}

export function closeSessions(run, ids = null, {
  home = homedir(),
  name: runName = null,
  // Only this user's processes (-x without -a): another user's browser is never a candidate.
  ps = () => spawnSync('ps', ['-xo', 'pid=,ppid=,command='], { encoding: 'utf8' }).stdout,
  kill,
} = {}) {
  const project = projectDir(run);
  const runWide = !ids?.length;
  const wanted = runWide ? recordedSessions(run) : ids;
  const lines = [];
  const patterns = new Set();
  for (const driver of drivers(run, project, home)) {
    const { list, close, orphans } = driver.settings;
    if (orphans) patterns.add(orphans);
    if (!close || !list) continue;
    const open = sh(list).stdout?.split('\n').map((l) => l.trim()).filter(Boolean) ?? [];
    const prefix = runWide && runName ? sessionName(driver, project, `${runName}-`) : null;
    const targets = new Set([...wanted.map((id) => sessionName(driver, project, id)), ...(runWide ? savedSessions(run) : []),
      ...(prefix ? open.filter((n) => n.startsWith(prefix)) : [])]);
    for (const name of [...targets].filter((n) => open.includes(n))) {
      const r = sh(fillCommand(close.replaceAll('<name>', name), project, ''));
      lines.push(r.status === 0 ? `Closed ${name}` : `Problem: ${driver.name} could not close ${name}: ${(r.stderr || r.stdout || '').trim().split('\n')[0]}`);
    }
  }
  // Only a run-wide close (no ids) stops orphans: a tester's own close leaves the other testers' browsers alone.
  if (runWide) for (const pattern of patterns) lines.push(...stopOrphans(orphanPids(ps(), pattern), kill ? { kill } : {}));
  return lines.sort((a, b) => Number(/^(Stopped|Killed)/.test(a)) - Number(/^(Stopped|Killed)/.test(b)) || a.localeCompare(b));
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  const [run, action, ...rest] = process.argv.slice(2);
  const at = rest.indexOf('--name');
  const name = at >= 0 ? rest[at + 1] : null;
  const ids = at >= 0 ? rest.filter((_, i) => i !== at && i !== at + 1) : rest;
  if (!run || action !== 'close' || (at >= 0 && !name)) {
    console.error('Usage: node sessions.mjs <run folder> close [--name <browser session name>] [<Session id> ...]');
    process.exit(1);
  }
  try {
    if (notAStep(run)) throw new Error(notAStep(run));
    const lines = closeSessions(resolve(run), ids, { name });
    const looked = ids.length ? ids : recordedSessions(resolve(run));
    console.log(lines.length ? lines.join('\n') : `No open sessions for ${basename(resolve(run))}: ${looked.length} looked for${looked.length ? ` (${looked.join(', ')})` : ''}, none open`);
    if (lines.some((l) => l.startsWith('Problem:'))) process.exit(1);
  } catch (e) {
    console.error(`Problem: ${e.message}`);
    process.exit(1);
  }
}
