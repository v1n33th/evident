// Usage: node log.mjs <run folder> <log file> '<json line>' ['<json line>' ...]
//        node log.mjs <run folder> --late <session id>
// Appends each line to <log file> in the run folder (evidence.jsonl, evidence-<session id>.jsonl, a session log, a check file).
// A line with a "file" gets that file's "sha256" and the time as "at", taken now, right after capture. Every line is checked
// first: one that is not a JSON object, names a file that is missing or outside the run folder, or whose note names a request
// and status that no line of its network log has, writes nothing at all. Before hashing, a text file (no NUL byte in its
// first 8 KB) and each line's note and actual get authorization and cookie values, bearer tokens and the emails of
// environment.md's ## Accounts as <redacted>: the hash is of the redacted file, which nothing may change after.
// --late logs each file in evidence/ named for the session (<session id>-...) that no log has yet, with the note "logged late",
// from the fields bug-bash's start.mjs saved for the session.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { notAStep, projectDir, redactSessions } from '../../show-your-work/scripts/build-proof.mjs';

// Seconds between two builds of the request's page from log calls.
export const REBUILD_EVERY = 30;
const REQUEST = /\b(GET|POST|PUT|PATCH|DELETE) \S*\//;
// Each "METHOD /path STATUS" a note names, with the status when it gives one; a path cut short with "..." keeps its start.
export const noteRequests = (note) => [...note.matchAll(/\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[^\s?<{]*)\S*(?:\s+([1-5]\d\d)(?!\w))?/g)]
  .map(([text, method, path, status]) => ({ text, method, path: path.replace(/\.+$/, ''), status }));
// The request the note names is one line of the network log, status included: one written from memory fails the case later.
export const missingRequests = (note, text) => {
  if (!REQUEST.test(text)) return [];
  const lines = text.split('\n');
  return noteRequests(note).filter((r) => !lines.some((l) => l.includes(`${r.method} `) && l.includes(r.path) && (!r.status || new RegExp(`\\b${r.status}\\b`).test(l)))).map((r) => r.text);
};

// The emails in the table rows of environment.md's ## Accounts; invitee addresses elsewhere stay.
export const accountEmails = (env) => (env.split(/^## /m).find((s) => s.startsWith('Accounts')) ?? '').split('\n')
  .filter((l) => l.startsWith('|')).flatMap((l) => l.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) ?? []);
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function logLines(run, log, texts) {
  const root = resolve(run);
  if (notAStep(root)) throw new Error(notAStep(root));
  const env = join(projectDir(root), 'environment.md');
  const emails = existsSync(env) ? accountEmails(readFileSync(env, 'utf8')) : [];
  const email = emails.length ? new RegExp(`(?<![\\w.+-])(?:${emails.map(escape).join('|')})(?![\\w-]|\\.\\w)`, 'gi') : null;
  const redact = (text) => (email ? redactSessions(text).replace(email, '<redacted>') : redactSessions(text));
  const inRun = (p) => {
    const full = resolve(root, String(p));
    if (!full.startsWith(root + sep)) throw new Error(`not in the run folder: ${p}`);
    return full;
  };
  const redacted = [];
  const rows = texts.map((text, i) => {
    let row;
    try { row = JSON.parse(text); } catch (e) { throw new Error(`line ${i + 1} is not JSON: ${e.message}`); }
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`line ${i + 1} is not a JSON object`);
    for (const k of ['note', 'actual']) if (typeof row[k] === 'string') row[k] = redact(row[k]);
    if (row.file != null) {
      const path = inRun(row.file);
      if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`line ${i + 1}: file missing ${row.file}`);
      let body = readFileSync(path);
      if (!body.subarray(0, 8192).includes(0)) {
        const text = redact(body.toString('utf8'));
        if (text !== body.toString('utf8')) { redacted.push([path, text]); body = Buffer.from(text); }
      }
      const absent = typeof row.note === 'string' ? missingRequests(row.note, body.toString('utf8')) : [];
      if (absent.length) throw new Error(`line ${i + 1}: note says ${absent.join('; ')}, but no line of ${row.file} does: copy the request and status from the file`);
      // Never a hash or time someone typed: the script takes both from the file and the clock.
      row.sha256 = createHash('sha256').update(body).digest('hex');
      row.at = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    }
    return JSON.stringify(row);
  });
  // A check file holds one row per file and hash: a second verdict for the same capture is refused.
  if (/^(check-.+|evidence-check)\.jsonl$/.test(String(log))) {
    const seen = new Set(existsSync(inRun(log)) ? readFileSync(inRun(log), 'utf8').split('\n').flatMap((l) => { try { const r = JSON.parse(l); return [`${r.file}\n${r.sha256}`]; } catch { return []; } }) : []);
    for (const text of rows) {
      const r = JSON.parse(text);
      if (!r.file) continue;
      if (seen.has(`${r.file}\n${r.sha256}`)) throw new Error(`${log} already has a row for ${r.file}: write each file's row once`);
      seen.add(`${r.file}\n${r.sha256}`);
    }
  }
  for (const [path, text] of redacted) writeFileSync(path, text);
  appendFileSync(inRun(log), rows.join('\n') + '\n');
  return rows;
}

// What every line of a session's captures shares (target, method's tool, strength, commit, env, by, its log), saved once
// at the session's start, so the scripts that log for it need only the files.
export const fieldsFile = (run, session) => join(run, 'charters', `.${session}.json`);
export function readFields(run, session) {
  try { return JSON.parse(readFileSync(fieldsFile(run, session), 'utf8')); } catch { throw new Error(`no fields saved for ${session}: run start.mjs first`); }
}
const VISUAL = /\.(gif|png|jpe?g|webp|webm|mp4|mov)$/i;
const MOTION = /\.(gif|webm|mp4|mov)$/i;
const methodOf = (tool, file) => (MOTION.test(file) ? `${tool} record` : VISUAL.test(file) ? `${tool} screenshot`
  : /network/.test(file) ? `${tool} network requests` : /console/.test(file) ? `${tool} console` : tool);
const roleOf = (file) => (VISUAL.test(file) ? 'picture' : /measure/.test(file) ? 'measure' : 'raw');
// Every file already in one of the run's evidence logs.
const loggedRows = (run) => readdirSync(run).filter((f) => /^evidence(-.+)?\.jsonl$/.test(f) && f !== 'evidence-check.jsonl')
  .flatMap((f) => readFileSync(join(run, f), 'utf8').split('\n')).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
export const loggedFiles = (run) => new Set(loggedRows(run).map((r) => r.file));
// Each logged file's latest sha256, so a file rewritten after it was logged is logged again.
export const loggedShas = (run) => new Map(loggedRows(run).map((r) => [r.file, r.sha256]));

// Logs files (relative to the run folder) for a session, each with its note, in the session's evidence log.
// The session a bug belongs to: what new-bug.mjs wrote into bugs/.BUG-NNN, or '' for a bug made with no session.
export function bugOwner(run, id) {
  try { return readFileSync(join(run, 'bugs', `.${id}`), 'utf8').trim(); } catch { return ''; }
}

export function logFiles(run, session, files, { note, bug, viewport } = {}) {
  for (const file of files) {
    const id = /^bugs\/(BUG-\d+)-/.exec(file)?.[1];
    const owner = id && bugOwner(run, id);
    if (owner && owner !== session) throw new Error(`${file} is in ${owner}'s bug folder: ${session} logs only files of its own bugs`);
  }
  const f = readFields(run, session);
  const lines = files.map((file) => JSON.stringify({
    ...(bug && { bug }), target: f.target, method: methodOf(f.tool, file), strength: f.strength, role: roleOf(file),
    commit: f.commit, env: f.env, by: session, file, ...(viewport && { viewport }), note: typeof note === 'function' ? note(file) : note,
  }));
  return lines.length ? logLines(run, f.log, lines) : [];
}

export function logLate(run, session) {
  const done = loggedFiles(run);
  const dir = join(run, 'evidence');
  const files = (existsSync(dir) ? readdirSync(dir) : []).filter((n) => n.startsWith(`${session}-`)).map((n) => `evidence/${n}`).filter((f) => !done.has(f));
  return logFiles(run, session, files, { note: 'logged late' });
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  const [run, log, ...texts] = process.argv.slice(2);
  if (run && log === '--late' && texts.length === 1) {
    try { console.log(`${logLate(resolve(run), texts[0]).length} files logged late`); } catch (e) { console.error(`Problem: ${e.message}`); process.exit(1); }
    process.exit(0);
  }
  if (!run || !log || !texts.length) {
    console.error("Usage: node log.mjs <run folder> <log file> '<json line>' ['<json line>' ...]");
    process.exit(1);
  }
  try {
    console.log(logLines(run, log, texts).join('\n'));
  } catch (e) {
    console.error(`Problem: ${e.message}. Nothing written: fix the line and run it again.`);
    process.exit(1);
  }
  await refreshReport(run);
}

// The request's page follows the captures. A build of a big request takes minutes, so it runs in the background, at most
// once per REBUILD_EVERY seconds: the page refreshes itself, and the run's final build writes it anyway. A page that
// cannot be written never fails the log.
async function refreshReport(path) {
  try {
    const report = new URL('../../show-your-work/scripts/report.mjs', import.meta.url);
    const request = (await import(report)).requestOf(path);
    if (!request) return;
    const stamp = join(request, '.report-started');
    if (existsSync(stamp) && Date.now() - statSync(stamp).mtimeMs < REBUILD_EVERY * 1000) return;
    writeFileSync(stamp, '');
    const page = join(request, 'report.html');
    const at = existsSync(page) ? statSync(page).mtimeMs : 0;
    spawn(process.execPath, [fileURLToPath(report), request, '--if-page', String(at)], { detached: true, stdio: 'ignore' }).unref();
  } catch {}
}
