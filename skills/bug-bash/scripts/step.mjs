// Usage: node step.mjs <run folder> <charter id> '<step json>'
//        node step.mjs <run folder> <charter id> --left
//        node step.mjs <run folder> <charter id> --return [--stopped '<reason>']
// Appends one step to charters/<charter id>.jsonl, numbered after the last, and logs the files in its "files" (paths in
// the run folder) as evidence, each with the step's "actual" as its note: the evidence check compares the two. Checks
// the result, that a "bug" names a bug folder, that a question cites an owner decision, that a "heuristic" is the
// charter's, that an as-expected step does not hide a problem in its note, and that a blocked step is no budget skip. Prints the step's number against the
// budget and the charter's viewports and heuristics with no step yet.
// --left prints what the charter has left. --return logs the session's unlogged captures and refuses (exit 1) while the
// charter is under 80% of its budget, unless --stopped names why the explorer stops early.
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { notAStep, redactSessions } from '../../show-your-work/scripts/build-proof.mjs';
import { logFiles, logLate, logLines } from '../../evidence/scripts/log.mjs';

const RESULTS = ['as-expected', 'bug', 'question', 'blocked'];
// An as-expected step whose note or actual names a problem: the problem goes unreported.
const HIDDEN = /not filed|\bminor\b|\bcosmetic\b|unclear|confusing|no (error |success )?(message|toast|feedback)|\bodd\b|recheck|may have|(?<!no )off.screen|cut off|overlap|unreadable|\bnan\b|\b(a|an|status|http|returned|got|gave|with|after) 5\d\d\b|(needed|after|on) (a |one )?retry/i;
const TARGET = 0.8;
const jsonl = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').flatMap((l) => { try { return l.trim() ? [JSON.parse(l)] : []; } catch { return []; } }) : []);
const charterOf = (run, id) => {
  const charter = (JSON.parse(readFileSync(join(run, 'charters.json'), 'utf8')).charters ?? []).find((c) => c.id === id);
  if (!charter) throw new Error(`no charter ${id} in charters.json`);
  return charter;
};
const same = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

// What the charter has left: steps, and the viewports and heuristics no step names yet.
export function left(run, id) {
  const charter = charterOf(run, id);
  const steps = jsonl(join(run, 'charters', `${id}.jsonl`));
  const budget = charter.budget ?? 0;
  return {
    budget, steps: steps.length,
    viewports: (charter.viewports ?? []).filter((v) => !steps.some((s) => same(s.viewport ?? '', v))),
    heuristics: (charter.heuristics ?? []).filter((h) => !steps.some((s) => same(s.heuristic ?? '', h))),
  };
}

export function leftLine(l) {
  return [
    `${l.steps} of ${l.budget} steps.`,
    l.viewports.length && `Viewports with no step yet: ${l.viewports.join(', ')}.`,
    l.heuristics.length && `Heuristics with no step yet: ${l.heuristics.join('; ')}.`,
  ].filter(Boolean).join(' ');
}

// The charter's scratch folder holds whatever the explorer saved (a network request with its Authorization header):
// its text files are redacted like logged files, at every step and at --return.
export function redactScratch(run, id) {
  const dir = join(run, 'charters', `.${id}`);
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    if (!f.isFile() || /\.(png|jpe?g|gif|webp|webm|mp4|pdf)$/i.test(f.name)) continue;
    const path = join(dir, f.name);
    const text = readFileSync(path, 'utf8');
    const redacted = redactSessions(text);
    if (redacted !== text) writeFileSync(path, redacted);
  }
}

export function addStep(run, id, text) {
  redactScratch(run, id);
  let step;
  try { step = JSON.parse(text); } catch (e) { throw new Error(`the step is not JSON: ${e.message}`); }
  if (!step || typeof step !== 'object' || Array.isArray(step)) throw new Error('the step is not a JSON object');
  const charter = charterOf(run, id);
  const problems = [
    !RESULTS.includes(step.result) && `result must be one of ${RESULTS.join(', ')}`,
    !step.action && 'no action', !step.actual && 'no actual',
    step.result === 'bug' && !(existsSync(join(run, 'bugs')) && readdirSync(join(run, 'bugs')).some((f) => f.startsWith(`${step.bug}-`))) && `bug ${step.bug ?? '(none)'} has no folder: file it with new-bug.mjs first`,
    step.result === 'question' && !/owner decision/i.test(`${step.note ?? ''}`) && 'a question cites the owner decision it is about in its note; else it is a bug of the closest lookFor kind, or as-expected',
    step.result === 'as-expected' && HIDDEN.test(`${step.note ?? ''} ${step.actual ?? ''}`) && !/right per \S+:\d+|BUG-\d+/i.test(`${step.note ?? ''}`) && `the note or actual names a problem ("${`${step.note ?? ''} ${step.actual ?? ''}`.match(HIDDEN)[0]}"): file it (minor or cosmetic is fine), log it as a question when an owner decision names it, or write "right per <doc>:<line>" in note only when that line names this result as right or outside scope`,
    step.result === 'as-expected' && /right per/i.test(`${step.note ?? ''}`) && !/right per \S+:\d+/i.test(`${step.note ?? ''}`) && '"right per" names the line: "right per <doc>:<line>", and only a line that names this result as right or outside scope; a value you could not read back is blocked ("needs read-back: <what>"), not as-expected',
    step.result === 'blocked' && /\bbudget\b|\bskipped\b/i.test(`${step.note ?? ''} ${step.actual ?? ''}`) && 'a step skipped for the budget is not blocked: leave it out and name it under Not covered in your return',
    (charter.viewports?.length ?? 0) > 1 && !step.viewport && 'no viewport',
    step.heuristic && !(charter.heuristics ?? []).some((h) => same(h, step.heuristic)) && `heuristic must be one of the charter's: ${(charter.heuristics ?? []).join('; ')}`,
  ].filter(Boolean);
  if (problems.length) throw new Error(`${problems.join('; ')}. Nothing written`);
  const log = join(run, 'charters', `${id}.jsonl`);
  const steps = jsonl(log);
  const files = (step.files ?? []).map((f) => relative(run, resolve(run, f)));
  const row = { n: (steps.at(-1)?.n ?? 0) + 1, charter: id, ...step, ...(files.length && { files }) };
  // Captures first: a file that cannot be logged writes no step either.
  if (files.length) logFiles(run, id, files, { note: step.actual, viewport: step.viewport });
  logLines(run, `charters/${id}.jsonl`, [JSON.stringify(row)]);
  return `Step ${row.n}${row.viewport ? ` at ${row.viewport}` : ''}: ${leftLine(left(run, id))}`;
}

// The explorer's last command: the budget is the target, so under 80% of it the charter is not done.
export function finish(run, id, stopped) {
  redactScratch(run, id);
  const late = logLate(run, id).length;
  const l = left(run, id);
  if (!stopped && l.steps < Math.ceil(l.budget * TARGET)) {
    throw new Error(`not done: ${leftLine(l)} Keep exploring until step ${Math.ceil(l.budget * TARGET)}: what is left first, then a heuristic again on a part, state or input you have not tried, as your person. Only a blocker, a full batch or the time ends it early: --stopped '<reason>'`);
  }
  return `${late} files logged late. ${leftLine(l)}${stopped ? ` Stopped: ${stopped}` : ''}`;
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  const [run, id, text, ...rest] = process.argv.slice(2);
  if (!run || !id || !text) {
    console.error("Usage: node step.mjs <run folder> <charter id> '<step json>' | --left | --return [--stopped '<reason>']");
    process.exit(1);
  }
  try {
    if (notAStep(run)) throw new Error(notAStep(run));
    if (text === '--left') console.log(`${id}: ${leftLine(left(resolve(run), id))}`);
    else if (text === '--return') console.log(finish(resolve(run), id, rest[0] === '--stopped' ? rest[1] : undefined));
    else console.log(addStep(resolve(run), id, text));
  } catch (e) {
    console.error(`Problem: ${e.message}`);
    process.exit(1);
  }
}
