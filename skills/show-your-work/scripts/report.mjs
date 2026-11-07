// Usage: node report.mjs <request folder> [--if-page <mtime ms>]
// Writes the request's one page, report.html: every step of the request, each bug's way from found to fixed to proven.
// A step's final build writes <step>/result.json, its checked data; until then, and after any of its files changes,
// its verdicts show as checking.
import { existsSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildProof, contradicted, readDecisions, REQUEST, runTargets, writeIndex } from './build-proof.mjs';
import { answersOf, stepQuestions } from './questions.mjs';

// `newest` is the newest file time in the step when the result was written: comparing file times with file times keeps
// the check free of the clock skew between the filesystem and Date.
// `files` lists the step's files, so a deleted or renamed capture also makes the result stale.
export function writeResult(step, data) {
  const file = join(step, 'result.json');
  writeFileSync(file, `${JSON.stringify({ writtenAt: new Date().toISOString(), newest: newest(step), files: listed(step), data })}\n`);
  return file;
}

// Newest modified time of any file in a folder tree, result.json left out.
const newest = (dir) => readdirSync(dir, { withFileTypes: true }).reduce((max, e) => {
  // A fixer writes its fix record into bug.json after the explore is checked: that is not a change to the evidence.
  if (e.name === 'result.json' || e.name === 'bug.json') return max;
  const path = join(dir, e.name);
  return Math.max(max, e.isDirectory() ? newest(path) : statSync(path).mtimeMs);
}, 0);

const listed = (step, dir = step) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.name === 'result.json' || e.name === 'bug.json' ? []
  : e.isDirectory() ? listed(step, join(dir, e.name)) : [relative(step, join(dir, e.name))])).sort();

// A step's checked data, while no file in it changed, came or went after the check.
export function readResult(step) {
  const file = join(step, 'result.json');
  if (!existsSync(file)) return null;
  try {
    const { newest: then, files, data } = JSON.parse(readFileSync(file, 'utf8'));
    return typeof then === 'number' && newest(step) <= then && String(files) === String(listed(step)) ? data : null;
  } catch {
    return null;
  }
}

const STEP = /^(spec|explore|fix|proof)(?:-(\d+))?$/;
const KIND_ORDER = ['spec', 'explore', 'fix', 'proof'];
const DONE = ['fixed', 'partly-fixed'];
const LOCK_HOURS = 12;
const real = (path) => { try { return realpathSync(path); } catch { return resolve(path); } };
const inside = (path, folder) => real(path) === real(folder) || real(path).startsWith(real(folder) + sep);
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const subdirs = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(dir, e.name)) : []);
const filesIn = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesIn(join(dir, e.name)) : [join(dir, e.name)]));

// A request's steps in the order they happened: by round (the -n), then spec, explore, fix, proof.
function stepsOf(request) {
  return subdirs(request).filter((d) => STEP.test(basename(d))).map((dir) => {
    const [, kind, n] = basename(dir).match(STEP);
    return { dir, name: basename(dir), kind, n: Number(n ?? 1) };
  }).sort((a, b) => a.n - b.n || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
}

// A step's data: its checked result while fresh, else a quick build that reads no capture.
function stepData(step, problems) {
  const checked = readResult(step.dir);
  if (checked) {
    problems.push(...(checked.problems ?? []).map((p) => `${step.name}: ${p}`));
    return { data: checked, checked: true };
  }
  if (step.kind === 'fix') return { data: null, checked: false };
  if (!existsSync(join(step.dir, 'claims.json')) && !existsSync(join(step.dir, 'charters'))) return { data: null, checked: false };
  try {
    // A running step's problems are mostly "not logged yet" and wait for its check; a broken line shows at once.
    const { data } = buildProof(step.dir, { verify: false });
    problems.push(...data.problems.filter((p) => /\.jsonl? line \d+: (?!unknown claim)|not valid JSON|conflict markers/.test(p)).map((p) => `${step.name}: ${p}`));
    return { data, checked: false };
  } catch (error) {
    problems.push(`${step.name}: ${error.message}`);
    return { data: null, checked: false };
  }
}

// The bug folders a fix step's rounds take bugs from: each round's explore run, and its `only` and `extra` folders.
function roundBugFolders(fixStep, problems = []) {
  const file = join(fixStep, 'rounds.json');
  if (!existsSync(file)) return [];
  let rounds;
  try { rounds = readJson(file).rounds ?? []; } catch (error) { problems.push(`${basename(fixStep)}/rounds.json: ${error.message}`); return []; }
  if (!Array.isArray(rounds)) return [];
  return rounds.flatMap((r) => [...(r.only ?? (r.explore ? subdirs(join(r.explore, 'bugs')) : [])), ...(r.extra ?? [])]);
}

// Requests elsewhere in the project whose fix steps took bugs from this request.
function fixingRequests(request) {
  const project = dirname(dirname(request));
  return subdirs(project).flatMap(subdirs).filter((r) => REQUEST.test(basename(r)) && real(r) !== real(request))
    .filter((r) => stepsOf(r).some((s) => s.kind === 'fix' && roundBugFolders(s.dir).some((b) => inside(b, request))));
}

// run.lock names the step that holds it, then the pid of the agent running it. `fresh`: under 12 hours old, and that agent
// is still running (a lock with no pid counts by age alone), so a run that was stopped or crashed stops holding it.
export function readLock(project) {
  const file = join(project, 'run.lock');
  if (!existsSync(file)) return null;
  const [step, pid] = readFileSync(file, 'utf8').split('\n').map((l) => l.trim());
  if (!step) return null;
  let alive = true;
  if (Number(pid) > 0) try { process.kill(Number(pid), 0); } catch (error) { alive = error.code === 'EPERM'; }
  return { step, fresh: alive && Date.now() - statSync(file).mtimeMs < LOCK_HOURS * 3600e3 };
}

// Live while the project's run.lock names a step of this request and is fresh.
function isLive(request) {
  const lock = readLock(dirname(dirname(request)));
  return Boolean(lock?.fresh) && inside(lock.step, request);
}

// A bug's state in one plain phrase, from its fix record and the proof of its fix.
function stateOf(status, proven, fixAsked) {
  if (!status) return fixAsked ? 'Not attempted yet' : 'Fix not requested';
  if (status === 'needs-decision') return 'Waiting for your decision';
  if (status === 'not-fixed') return 'Fix did not hold';
  if (status === 'wont-fix') return "Won't fix";
  if (!DONE.includes(status)) return status;
  return { proven: 'Fixed and proven', disproved: 'Fix did not hold', checking: 'Fix made, being checked', 'not-proven': 'Fix made, could not be proven' }[proven] ?? 'Fix made, waiting for proof';
}

// Every `at` a step's logs carry (captures, session and charter lines), with what each line names.
function logLines(dir) {
  const files = [...readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => join(dir, f)),
    ...['sessions', 'charters'].flatMap((sub) => (existsSync(join(dir, sub)) ? readdirSync(join(dir, sub)).filter((f) => f.endsWith('.jsonl')).map((f) => join(dir, sub, f)) : []))];
  return files.flatMap((f) => readFileSync(f, 'utf8').split('\n').flatMap((line) => {
    try { const r = JSON.parse(line); const t = Date.parse(r.at); return Number.isFinite(t) ? [{ t, bug: r.bug ?? null, claim: r.claim ?? null, file: r.file ?? null }] : []; } catch { return []; }
  }));
}
const writtenAt = (dir) => { try { const t = Date.parse(readJson(join(dir, 'result.json')).writtenAt); return Number.isFinite(t) ? t : null; } catch { return null; } };

const STAGES = { explore: ['Plan', 'Explore', 'Done'], prove: ['Plan', 'Prove', 'Done'] };
const STAGE_OF = { spec: 'Plan', explore: 'Explore', fix: 'Fix', proof: 'Prove' };

export async function requestData(request) {
  const [, date, time, kind] = basename(request).match(REQUEST) ?? [];
  const problems = [];
  const steps = stepsOf(request).map((s) => ({ ...s, ...stepData(s, problems) }));
  const live = isLive(request);
  const rel = (path) => relative(request, path).split(sep).join('/');
  // Times: a time before the request started or after now counts as missing, so a wrong clock never draws a false timeline.
  const now = Date.now();
  const begun = date ? new Date(`${date}T${time.slice(0, 2)}:${time.slice(2)}:00`).getTime() : 0;
  const valid = (t) => (t && t >= begun - 60e3 && t <= now + 60e3 ? t : null);
  const timed = (s) => {
    const lines = logLines(s.dir);
    const ats = lines.map((l) => l.t);
    const born = statSync(s.dir).birthtimeMs || null;
    const start = valid(Math.min(...[born, ...ats].filter((t) => valid(t))));
    const end = valid(Math.max(...[writtenAt(s.dir), ...ats].filter((t) => valid(t))));
    // A folder copied or checked out again is born after its step ended: that start is no time at all.
    const ok = (t) => (Number.isFinite(t) ? t : null);
    return { lines, start: ok(start) !== null && ok(end) !== null && start > end ? null : ok(start), end: ok(end) };
  };
  for (const s of steps) Object.assign(s, timed(s));
  // A step that logged nothing borrows its edges from its neighbours: it ran between the step before and the one after.
  steps.forEach((s, i) => {
    if (!s.end && !(live && i === steps.length - 1)) s.end = steps[i + 1]?.start ?? null;
    if (!s.start) s.start = steps[i - 1]?.end ?? null;
  });

  // Bugs: this request's explore steps, and the folders its fix steps' rounds name (other requests' too).
  const folders = [...steps.filter((s) => s.kind === 'explore').flatMap((s) => subdirs(join(s.dir, 'bugs'))),
    ...steps.filter((s) => s.kind === 'fix').flatMap((s) => roundBugFolders(s.dir, problems))];
  const seen = new Set();
  const fixers = fixingRequests(request);
  // Proof steps that prove fixes: this request's and those of the requests that fixed its bugs.
  const proofs = [...steps, ...fixers.flatMap((r) => stepsOf(r).map((s) => ({ ...s, ...stepData(s, []), ...timed(s) })))].filter((s) => s.kind === 'proof');
  const links = proofs.flatMap((p) => {
    const map = join(p.dir, 'fix-claims.json');
    if (!existsSync(map)) return [];
    try { const list = readJson(map); if (Array.isArray(list)) return list; throw new Error('not a list'); } catch (error) { if (steps.includes(p)) problems.push(`${p.name}/fix-claims.json: ${error.message}`); return []; }
  });
  // A re-proof (proof-2, ...) of the same claim is newer evidence than the proof that came with the fix.
  // The proof of a bug's fix: its verdict, and the time of the last capture of its claim.
  const proofOf = (folder) => {
    const link = links.find((l) => real(l.bug) === real(folder));
    if (!link) return { verdict: null, at: null };
    const p = [...proofs].reverse().find((s) => s.data?.claims?.some((c) => c.id === link.claim));
    const at = p ? Math.max(0, ...p.lines.filter((l) => l.claim === link.claim).map((l) => l.t)) || null : null;
    return { verdict: !p || !p.checked ? 'checking' : p.data.claims.find((c) => c.id === link.claim)?.verdict ?? 'checking', at: valid(at), claim: link.claim };
  };
  // When a bug was found: its first capture in the step that filed it. When it was fixed: its fix step's finish.
  const stepLines = new Map();
  const foundAt = (folder, id) => {
    const step = dirname(dirname(folder));
    if (!stepLines.has(step)) stepLines.set(step, existsSync(step) ? logLines(step) : []);
    const mine = stepLines.get(step).filter((l) => l.bug === id || (l.file && inside(join(step, l.file), folder))).map((l) => l.t);
    // A bug with no log line was found when new-bug.mjs made its folder.
    return valid(mine.length ? Math.min(...mine) : statSync(folder).birthtimeMs || null);
  };
  // A fix record's patch path is relative to the fix step that wrote it: find that step here or in a fixing request.
  const fixSteps = [...steps, ...fixers.flatMap(stepsOf)].filter((s) => s.kind === 'fix');
  const patchOf = (patch) => { const at = patch && fixSteps.find((s) => existsSync(join(s.dir, patch))); return at ? rel(join(at.dir, patch)) : null; };
  const fixAsked = steps.some((s) => s.kind === 'fix') || fixers.length > 0;
  const bugs = folders.filter((f) => existsSync(join(f, 'bug.json')) && !seen.has(real(f)) && seen.add(real(f))).flatMap((folder) => {
    let b;
    try { b = readJson(join(folder, 'bug.json')); } catch (error) { problems.push(`${rel(folder)}/bug.json: ${error.message}`); return []; }
    const proof = proofOf(folder);
    const proven = proof.verdict;
    const status = b.fix?.status;
    const fixedIn = inside(folder, request) ? (fixers.find((r) => stepsOf(r).some((s) => s.kind === 'fix' && roundBugFolders(s.dir).some((x) => real(x) === real(folder)))) ?? null) : null;
    const fixStep = fixSteps.find((s) => roundBugFolders(s.dir).some((x) => real(x) === real(folder)));
    // A fix that names a change file which is not on disk, and no commit, has nothing to ship: say so instead of "fix made".
    const lost = DONE.includes(status) && Boolean(b.fix.patch) && !patchOf(b.fix.patch) && !b.fix.commit && proven !== 'disproved';
    // A change auto mode or gap mode chose, at low or medium risk and not to security, ships once proven, without your review.
    const chosen = /^(auto|gap):/.test(b.fix?.source ?? '') && ['low', 'medium'].includes(b.fix?.risk) && b.kind !== 'security';
    return [{
      id: b.id ?? basename(folder), title: b.title ?? '', severity: b.severity ?? null, kind: b.kind ?? null, origin: b.origin ?? null,
      // Its own picture, by the evidence check, does not show it: listed apart, never counted.
      unconfirmed: contradicted(dirname(dirname(folder))).get(b.id) ?? null,
      // Its tester withdrew it (the app discloses it, or a rule allows it) or marked it a duplicate: listed apart, never counted.
      withdrawn: b.withdrawn ?? (b.duplicateOf ? `a duplicate of ${b.duplicateOf}` : null),
      // Its step folder as the chat line names it, from the folder that holds the project folder: ".evident/<feature>/<request>/explore".
      at: relative(dirname(dirname(dirname(request))), dirname(dirname(folder))), dir: rel(folder), found: true, step: basename(dirname(dirname(folder))),
      fixed: b.fix ? DONE.includes(status) : null, proven,
      state: lost ? 'Fix made, change missing' : stateOf(status, proven, fixAsked),
      // The same rules as the fix summary's `!` lines, so the page and the chat never disagree.
      // Once you decide (keep it, or ship a fix to review), the bug stops waiting on you.
      needsYou: !(b.fix?.decided && (status === 'wont-fix' || proven === 'proven')) && (lost || ['needs-decision', 'not-fixed', 'wont-fix'].includes(status) || proven === 'disproved' || Boolean(b.fix?.needsAttention)
        || (Boolean(b.fix) && !(chosen && proven === 'proven') && (b.fix.inProduction === true || b.kind === 'security' || ['very-high', 'high', 'medium'].includes(b.fix.risk)))
        || (!live && DONE.includes(status) && proven !== 'proven')),
      seenAs: [b.account, b.viewport].filter(Boolean).join(' on '),
      // Where it shows, for the card's head: the surface, and the device a web bug was seen on.
      surface: (() => { const rule = runTargets(dirname(dirname(folder)))[b.target]; return [rule?.label ?? b.target, rule?.viewports && (DEVICE[b.viewport] ?? b.viewport)].filter(Boolean).join(' · ') || null; })(),
      steps: b.steps ?? [], expected: b.expected ?? null, actual: b.actual ?? null,
      evidence: filesIn(folder).filter((f) => basename(f) !== 'bug.json').map(rel).sort(),
      fix: b.fix ?? null, chosen, fixedIn: fixedIn && basename(fixedIn), patch: patchOf(b.fix?.patch),
      // The change file's path from this request folder, where the fix step that took the bug keeps it, found or not.
      patchNamed: b.fix?.patch ? (fixStep ? rel(join(fixStep.dir, b.fix.patch)) : b.fix.patch) : null,
      times: { found: foundAt(folder, b.id), fixed: b.fix && fixStep ? valid(writtenAt(fixStep.dir)) : null, proof: proof.at }, proofClaim: proof.claim ?? null,
    }];
  });

  // A bug a later round found again ("Same as round <n> BUG-NNN") is counted once, on the card of the round that found it first.
  const roundExplore = new Map(steps.filter((s) => s.kind === 'fix').flatMap((s) => { try { return readJson(join(s.dir, 'rounds.json')).rounds ?? []; } catch { return []; } })
    .filter((r) => r.explore).map((r) => [r.n, real(r.explore)]));
  // The round that found a bug: the round whose explore run holds it, else the number in its step's name (explore-2 is round 2).
  const roundOf = new Map([...roundExplore].map(([n, dir]) => [dir, n]));
  for (const b of bugs) { const dir = real(join(request, b.dir, '..', '..')); b.round = roundOf.get(dir) ?? Number(/^explore-(\d+)$/.exec(b.step)?.[1] ?? 1); }
  for (const b of [...bugs]) {
    const [, n, id] = /^Same as round (\d+) (BUG-\d+)/.exec(b.fix?.summary ?? '') ?? [];
    const first = n && bugs.find((o) => o !== b && o.id === id && o.round === Number(n));
    if (!first) continue;
    (first.again ??= []).push({ id: b.id, round: b.round });
    bugs.splice(bugs.indexOf(b), 1);
  }

  // Each round numbers its bugs from BUG-001: a later bug with a taken id is told apart by its step, in its label and its anchor.
  const taken = new Set();
  for (const b of bugs) {
    const twin = taken.has(b.id);
    taken.add(b.id);
    Object.assign(b, { label: twin ? `${b.id} (${b.step})` : b.id, anchor: twin ? `${b.id}-${b.step}` : b.id });
  }

  // Checks proving a fix are counted with their bug; the others (a proof of a change, ledger re-checks) need you themselves.
  const linked = new Set(steps.filter((s) => s.kind === 'proof').flatMap((s) => { try { return readJson(join(s.dir, 'fix-claims.json')).map((l) => l.claim); } catch { return []; } }));
  const promises = steps.filter((s) => (s.kind === 'proof' || s.kind === 'spec') && s.data?.claims).flatMap((s) => s.data.claims.map((c) => ({
    id: c.id, statement: c.statement, verdict: s.checked ? c.verdict : 'checking', cases: c.cases ?? [],
    // Each file keeps its case, device and note, so the page shows it under the case it proves.
    evidence: (c.evidence ?? []).map((l) => ({ ...l, file: `${s.name}/${l.file}` })), proof: c.proof ?? null, step: s.name, fixesBug: linked.has(c.id),
  })));
  const checks = (v) => promises.filter((p) => p.verdict === v).length;
  const checksNeed = promises.filter((p) => !p.fixesBug && ['disproved', 'not-proven'].includes(p.verdict)).length;

  // Each question with the user's answer, when the feature's answers.jsonl has one.
  const answered = answersOf(dirname(request));
  const questions = (s) => stepQuestions(s.dir).map((q) => ({ ...q, answer: answered.get(q.id)?.answer ?? null }));
  // What a step tested: each charter's mission, and a proof's or spec's checks.
  const tested = (s) => { let missions = []; try { missions = (readJson(join(s.dir, 'charters.json')).charters ?? []).filter((c) => c.mission).map((c) => c.mission); } catch {}
    return [...missions, ...(s.data?.claims?.length ? [`${plural(s.data.claims.length, 'check', 'checks')}, each shown on this page`] : [])]; };
  // The parts of the feature the planner aimed no charter at (a paid plan no account has), first, then each charter's notCovered.
  const notCovered = (s) => { try { const c = readJson(join(s.dir, 'charters.json'));
    return [...(c.untested ?? []).map(String), ...(c.charters ?? []).filter((t) => t.notCovered).map((t) => `${t.id}: ${t.notCovered}`)]; } catch { return []; } };

  // An explore request that a fix grew shows every stage.
  const grew = kind === 'explore' && steps.some((s) => s.kind === 'fix' || s.kind === 'proof');
  const labels = (!grew && STAGES[kind]) || ['Plan', 'Explore', 'Fix', 'Prove', 'Done'];
  const started = labels.map((l) => steps.some((s) => STAGE_OF[s.kind] === l));
  const stages = labels.map((label, i) => {
    if (label === 'Done') return { label, state: !live && steps.length ? 'done' : 'todo' };
    const later = started.slice(i + 1).some(Boolean);
    if (label === 'Plan') return { label, state: steps.some((s) => s.kind !== 'spec') || later ? 'done' : 'now' };
    if (!started[i]) return { label, state: later ? 'done' : 'todo' };
    const all = steps.filter((s) => STAGE_OF[s.kind] === label);
    return { label, state: later || (all.every((s) => s.checked) && !live) ? 'done' : 'now' };
  });

  // What auto mode decided, a run that stopped, and release notes from a finished fix report.
  // Each choice keeps the step that made it, so the page can say "(while proving)".
  const decisions = [[join(request, 'decisions.md'), null], ...steps.map((s) => [join(s.dir, 'decisions.md'), s])].filter(([f]) => existsSync(f))
    .map(([f, s]) => [readDecisions(readFileSync(f, 'utf8')), s])
    .reduce((a, [d, s]) => ({ count: a.count + d.count, defaults: [...a.defaults, ...d.defaults.map((text) => ({ text, kind: s?.kind ?? null, step: s?.name ?? null }))] }), { count: 0, defaults: [] });
  const rounds = steps.filter((s) => s.kind === 'fix' && existsSync(join(s.dir, 'rounds.json'))).map((s) => { try { return readJson(join(s.dir, 'rounds.json')); } catch { return {}; } });
  const auto = decisions.count > 0 || rounds.some((r) => r.auto) || steps.some((s) => s.data?.approvedBy === 'auto') || bugs.some((b) => /^auto:/.test(b.fix?.source ?? ''));
  const stopped = rounds.find((r) => r.stopped)?.stopped ?? null;
  const flaky = rounds.flatMap((r) => (r.rounds ?? []).flatMap((x) => (x.flaky ?? []).map((id) => `${id} (round ${x.n})`)));
  const notes = steps.filter((s) => s.kind === 'fix' && s.checked).flatMap((s) => [...(s.data?.releaseNotes?.existingUsers ?? []),
    ...(s.data?.releaseNotes?.migrations ?? []).map((b) => `${b.id}: migration: ${b.fix?.impact?.migration}`)]);

  return {
    name: basename(request), feature: basename(dirname(request)), date: date ?? null, time: time ?? null, kind: kind ?? null,
    live, updatedAt: new Date().toISOString(),
    brief: existsSync(join(request, 'brief.md')) ? readFileSync(join(request, 'brief.md'), 'utf8') : null,
    // What the planner and testers learned from the code and docs; a fact a later round copied shows once.
    // The planner's suspects (leads.jsonl) show with the facts.
    learnings: [...new Map(steps.flatMap((s) => ['learnings.jsonl', 'leads.jsonl'].flatMap((f) => (existsSync(join(s.dir, f)) ? readFileSync(join(s.dir, f), 'utf8').split('\n') : []))
      .flatMap((line) => { try { const l = JSON.parse(line); return l?.learning ? [[l.learning, l]] : []; } catch { return []; } }))).values()],
    stages,
    // A gap (a missing feature) is not a bug: it has its own count and group.
    counts: { found: bugs.filter((b) => b.kind !== 'gap' && !b.unconfirmed && !b.withdrawn).length, gaps: bugs.filter((b) => b.kind === 'gap' && !b.unconfirmed && !b.withdrawn).length, unconfirmed: bugs.filter((b) => b.unconfirmed).length, fixed: bugs.filter((b) => b.fixed).length, proven: bugs.filter((b) => b.proven === 'proven').length, needsYou: bugs.filter((b) => b.needsYou).length + checksNeed, questions: steps.flatMap(questions).filter((q) => !q.answer).length,
      checks: promises.length, ownChecks: promises.filter((p) => !p.fixesBug).length, checksProven: checks('proven'), checksFailed: checks('disproved'), checksUnproven: checks('not-proven') },
    bugs, promises, auto, decisions, stopped, flaky, releaseNotes: notes,
    // Who approved what to check, when not auto mode: a person approved some proof's or spec's checks.
    approvedByPerson: !auto && steps.some((s) => ['proof', 'spec'].includes(s.kind) && s.data?.approvedBy === 'user'),
    // What the run tested on, from the first step that captured anything.
    testedOn: steps.map((s) => s.data?.subject).find((x) => x?.env || x?.commit) ?? null,
    // Files the evidence check found but no tester logged: shown, but marked as not checked.
    unchecked: problems.flatMap((p) => { const m = p.match(/^([^:]+): (.+): not in evidence\.jsonl$/); return m ? [`${m[1]}/${m[2]}`] : []; }),
    begun: begun || null,
    steps: steps.map((s, i) => ({ name: s.name, kind: s.kind, checked: s.checked, running: live && i === steps.length - 1, start: s.start, end: s.end, commit: s.data?.subject?.commit ?? null, willNotProve: s.data?.willNotProve ?? null, notCovered: notCovered(s), tested: tested(s), questions: questions(s) })),
    problems,
  };
}

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const KIND = { explore: 'Explore', prove: 'Proof', 'explore-and-fix': 'Explore and fix', improve: 'Self-improvement', fix: 'Fix' };
const VERDICT = { proven: 'Proven', disproved: 'Failed', 'not-proven': 'Could not be proven', checking: 'Being checked' };
const CASE = { pass: 'passed', fail: 'failed', blocked: 'could not run', 'not-run': 'not run yet' };
const PICTURE = /\.(png|jpe?g|gif|webp)$/i;
const VIDEO = /\.(webm|mp4)$/i;

// A capture as a person sees it: pictures and videos shown, everything else (text can hold secrets) only linked.
const shown = (path) => (PICTURE.test(path) ? `<a href="${esc(path)}" target="_blank" rel="noopener"><img src="${esc(path)}" alt="${esc(path.split('/').pop())}" loading="lazy"></a>`
  : VIDEO.test(path) ? `<video src="${esc(path)}" controls preload="metadata"></video>`
  : `<a href="${esc(path)}" target="_blank" rel="noopener">${esc(path.split('/').pop())}</a>`);
// A file the evidence check found but no tester logged, in words.
const UNCHECKED = ' <span class="muted">(not checked: no tester logged this file, so nothing ties it to the test)</span>';
const when = (iso) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short' });
// The page is written in the writer's zone: the start and update times name it, as the index names UTC.
const zone = (t) => new Date(t).toLocaleTimeString('en-GB', { timeZoneName: 'short' }).split(' ').pop();
// A decisions.md ruling, "<what> — <why> — <cost if wrong>", in words.
// "Why: auto mode" says nothing every choice does not already say, so it is left out.
const ruling = (r, tag = '') => { const [what, why, cost] = String(r).split(' — '); const said = why && !/^auto mode$/i.test(why.trim());
  return `${esc(what.charAt(0).toUpperCase() + what.slice(1))}${tag}${said ? `<br><span class="muted">Why: ${esc(why)}</span>` : ''}${cost ? `<br><span class="muted">If that was wrong: ${esc(cost)}</span>` : ''}`; };

// brief.md in plain words: its headings as labels, without the # marks.
const plainBrief = (md) => md.trim().split('\n').map((l) => { const h = l.match(/^#+\s+(.*)$/); return h ? `<b>${esc(h[1])}</b>` : esc(l); }).join('\n');
const clock = (t) => (t ? new Date(t).toTimeString().slice(0, 5) : '');
const span = (ms) => { const m = Math.max(1, Math.round(ms / 60e3)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const SEVERITY_ORDER = ['critical', 'major', 'minor', 'cosmetic'];
const worstFirst = (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || String(a.id).localeCompare(String(b.id), undefined, { numeric: true });
// Red only for what failed; amber for what waits on a person; indigo for work under way.
const STATE_TONE = (b) => (b.state === 'Fix did not hold' ? 'need' : b.needsYou ? 'wait' : b.state === 'Fixed and proven' ? 'good' : /^Fix made/.test(b.state) ? 'run' : 'idle');
const CHECK_TONE = { proven: 'good', disproved: 'need', 'not-proven': 'wait', checking: 'run' };
const CASE_TONE = { pass: 'good', fail: 'need', blocked: 'wait' };
const urgentFirst = (a, b) => ['need', 'wait'].indexOf(a.tone) - ['need', 'wait'].indexOf(b.tone) || worstFirst(a.item, b.item);

// A bug's road as events: found, the fix, the proof, and a decision still open. Each has a tone and, when known, a time.
function events(b) {
  const fix = b.fix ?? {};
  const t = b.times ?? {};
  const out = [{ tone: 'good', text: 'Found', short: 'found', at: t.found }];
  if (DONE.includes(fix.status)) out.push({ tone: 'good', text: 'Fix made', short: 'fixed', at: t.fixed, by: true });
  else if (fix.status === 'not-fixed') out.push({ tone: 'need', text: 'Tried, then undone', short: 'fix undone', at: t.fixed, by: true });
  else if (fix.status === 'needs-decision') out.push({ tone: 'wait', text: 'Waiting for your decision', short: 'waiting for your decision', open: true });
  else if (fix.status === 'wont-fix') out.push({ tone: 'idle', text: "Won't fix", short: "won't fix" });
  else if (b.state === 'Not attempted yet') out.push({ tone: 'idle', text: 'Not attempted yet', short: 'not attempted yet', open: true });
  const proof = { proven: ['good', 'Proof passed', 'proof passed'], disproved: ['need', 'Proof failed', 'proof failed'], checking: ['run', 'Being proven', 'being proven'], 'not-proven': ['wait', 'Could not be proven', 'could not be proven'] }[b.proven];
  if (proof) out.push({ tone: proof[0], text: proof[1], short: proof[2], at: b.proven === 'checking' ? null : t.proof, claim: b.proofClaim });
  if (fix.decision && fix.status !== 'needs-decision') out.push({ tone: 'wait', text: 'Waiting for you', short: 'waiting for you', open: true });
  return out;
}
const trail = (b) => (b.state === 'Fix not requested' ? '' : `<span class="trail">${events(b).map((e) => `<span class="${e.tone}">${esc(e.short)}${e.at ? ` ${e.by ? 'by ' : ''}${clock(e.at)}` : ''}</span>`).join('<span class="arrow" aria-hidden="true"> → </span>')}</span>`);

// One bug: a summary line with its road, opening into what to decide, how to see it, the change, what users get and what happened.
// "1", "1 and 2", "1, 2 and 3".
const joined = (xs) => (xs.length < 2 ? `${xs[0] ?? ''}` : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

function bugRow(b, unchecked, open = false, rounds = false) {
  const fix = b.fix ?? {};
  const t = STATE_TONE(b);
  const tried = ['fixed', 'partly-fixed', 'not-fixed'].includes(fix.status);
  // A record that names a change file which is not on disk says so, rather than hiding the change.
  const missing = fix.patch && !b.patch ? `the change file the record names, <code>${esc(b.patchNamed ?? fix.patch)}</code>, is missing` : '';
  const where = fix.status === 'not-fixed' ? (b.patch ? `Undone; the change file is kept: <a href="${esc(b.patch)}" target="_blank" rel="noopener">see the change</a>.` : missing ? `Undone; ${missing}.` : 'Undone; no change is left in the code.')
    : fix.commit ? `Committed as <code>${esc(fix.commit)}</code>.` : b.patch ? `Kept as a change file, not committed: <a href="${esc(b.patch)}" target="_blank" rel="noopener">see the change</a>.` : missing ? `Not committed; ${missing}.` : '';
  // A recording shows the bug happen; a screenshot only where there is none.
  const shot = b.evidence.find((f) => VIDEO.test(f)) ?? b.evidence.find((f) => PICTURE.test(f));
  const others = b.evidence.filter((f) => f !== shot);
  const why = [fix.inProduction === true && 'it changes what production does', b.kind === 'security' && 'it is a security fix',
    ['medium', 'high', 'very-high'].includes(fix.risk) && `${fix.risk} risk${fix.riskReason ? `: ${fix.riskReason.replace(/\.$/, '')}` : ''}`].filter(Boolean);
  const kind = decideKind(b);
  const picks = kind ? field(`decide ${b.id} of ${b.at}`, `d-${b.anchor}`, `<legend class="sr">Your decision on ${esc(b.label ?? b.id)}</legend>`, CHOICES[kind], '') : '';
  const decided = fix.decided ? `<p>You decided: <b>${esc(fix.decided)}</b></p>` : '';
  const how = /^auto:/.test(fix.source ?? '') ? 'Auto mode decided' : 'Added in gap mode';
  const chose = b.chosen && !b.needsYou ? `<div class="ask asks"><b>Chosen without you</b><p>${how}: <b>${esc(fix.source.replace(/^(auto|gap):\s*/, ''))}</b></p>${decided || picks}</div>` : '';
  const review = b.needsYou && b.state === 'Fixed and proven' ? `<div class="ask asks"><b>Your call</b><p>${esc(`Review this fix before shipping${why.length ? `: ${why.join('; ')}` : ''}.`)}</p>${picks}</div>` : '';
  const doubt = b.withdrawn ? `<div class="ask asks"><b>Withdrawn</b><p>${esc(`Its tester withdrew it: ${b.withdrawn}`)}</p></div>`
    : b.unconfirmed ? `<div class="ask asks"><b>Not confirmed</b><p>${esc(`The evidence check says its own picture does not show it: ${b.unconfirmed}`)}</p></div>` : '';
  const ask = doubt || review || chose || (fix.decision ? `<div class="ask asks"><b>Your call</b><p>${esc(fix.decision)}</p>${decided || picks}<p class="muted">${fix.status === 'needs-decision' ? 'Until you decide, it stays as it is.' : 'Until someone fixes it by hand, the bug stays.'}</p></div>` : '');
  const lead = fix.status === 'needs-decision' ? 'No fix made' : fix.status === 'not-fixed' ? 'What the fixer tried, then undid' : 'The fix';
  const change = b.fix ? `<section class="sec"><h4>Cause and change</h4><div>
<p><b>${lead}:</b> ${esc(fix.summary)}</p>
${fix.files?.length ? `<p class="chips">${fix.files.map((f) => `<code>${esc(f)}</code>`).join('')}</p>` : ''}
${fix.status === 'needs-decision' || !(fix.rootCause || fix.risk || (where && tried)) ? '' : `<div class="facts">${fix.rootCause ? `<div><small>Cause</small>${esc(fix.rootCause)}</div>` : ''}
${fix.risk ? `<div><small>Risk of the change</small>${esc(fix.risk)}${fix.riskReason ? `: ${esc(fix.riskReason)}` : ''}</div>` : ''}
${where && tried ? `<div><small>State of the code</small>${where}</div>` : ''}</div>`}
${fix.impact?.existingUsers ? `<p><b>For people already using it:</b> ${esc(fix.impact.existingUsers)}</p>` : ''}
${b.fixedIn ? `<p>Worked on in <a href="../${esc(b.fixedIn)}/report.html">${esc(b.fixedIn)}</a>.</p>` : ''}</div></section>`
    : b.fixedIn ? `<section class="sec"><h4>Cause and change</h4><p>Worked on in <a href="../${esc(b.fixedIn)}/report.html">${esc(b.fixedIn)}</a>.</p></section>` : '';
  // Whether it blocks shipping, in words near the top: a skimmer misses a chip. A new bug stops saying so once its fix is proven.
  const ships = fix.inProduction === true ? '<p class="ships">Already in production: it does not block shipping.</p>'
    : fix.inProduction === false && b.state !== 'Fixed and proven' ? '<p class="ships">New on this branch: shipping now would add it.</p>' : '';
  const proved = b.proofClaim ? `<p>Proved by check <a href="#${esc(b.proofClaim)}">${esc(b.proofClaim)}</a>.</p>` : '';
  // Open, a card is what you decide and how to see the bug; the rest waits under Details. The row's trail says what happened.
  return `<details class="bug ${t}" id="${esc(b.anchor)}"${open ? ' open' : ''}><summary>
<span class="head"><span class="title">${esc(b.title)}</span>
<span class="id">${esc(rounds ? b.id : b.label ?? b.id)}</span>${rounds ? `<span class="round">${((r) => (r.length > 1 ? `Rounds ${joined(r)}` : `Round ${r[0]}`))([...new Set([b.round, ...(b.again ?? []).map((a) => a.round)])].sort((x, y) => x - y))}</span>` : ''}${b.surface ? `<span class="where">${esc(b.surface)}</span>` : ''}${fix.inProduction === true ? '<span class="prod">already in production</span>' : ''}<span class="sev ${esc(b.severity)}">${esc(b.severity ?? '')}</span>
${b.state === 'Fix not requested' ? '' : `<span class="state ${t}">${esc(b.state)}</span>`}</span>
${trail(b)}</summary>
<div class="file">${ask}${ships}${b.again ? `<p class="muted">Found in round ${b.round} as ${esc(b.id)}, and again in ${joined(b.again.map((a) => `round ${a.round} as ${esc(a.id)}`))}.</p>` : ''}
<section class="sec"><h4>Reproduce</h4><div class="repro${shot ? '' : ' bare'}">
${shot ? `<figure class="shot">${shown(shot)}<figcaption>${esc(shot.split('/').pop())}${b.times?.found ? `, ${clock(b.times.found)}` : ''}</figcaption></figure>` : ''}
<div>${b.seenAs ? `<p class="seen">Seen as ${esc(b.seenAs)}</p>` : ''}${b.evidence.length ? '' : '<p class="muted">No screenshots or files were saved for this bug.</p>'}
<ol class="steps">${b.steps.map((x) => `<li>${esc(x)}</li>`).join('')}</ol></div>
<div class="vs"><div class="e"><small>Expected</small>${esc(b.expected)}</div><div class="a"><small>Actual</small>${esc(b.actual)}</div></div></div></section>
<details class="more"><summary>Details</summary>
${change}${proved}
<p class="foot">${esc(b.label ?? b.id)}: <a href="${esc(b.dir)}/bug.json" target="_blank" rel="noopener">full bug record</a>${others.length ? `. Other files: ${others.map((f) => `${shown(f)}${unchecked.includes(f) ? UNCHECKED : ''}`).join(', ')}` : ''}</p>
</details>
</div></details>`;
}

const DEVICE = { desktop: 'Desktop', tablet: 'Tablet', mobile: 'Phone' };
const CALL = /-(\d+)-(request|response|headers|body)\.txt$/;
// One case's evidence: what it proves, not a heap of files. Calls read as one line each (the request, then what came back),
// newest three; pictures and recordings show with their device and what the tester measured; a clean console is one line.
// Everything, setup output with its password included, stays under All files.
function caseEvidence(files) {
  const calls = [...files.reduce((m, f) => { const k = f.file.match(CALL); if (k) { const key = f.file.replace(CALL, `-${k[1]}`); m.set(key, { ...m.get(key), [k[2]]: f }); } return m; }, new Map()).values()];
  const shownCalls = calls.slice(-3).map((c) => { const to = c.response ?? c.request ?? c.body ?? c.headers;
    return `<li><a href="${esc(to.file)}" target="_blank" rel="noopener">${esc([c.request?.note, c.response?.note].filter(Boolean).join(' → ') || to.file.split('/').pop())}</a></li>`; });
  // Per device, its recording when it has one, else its screenshots; every file stays under All files.
  const recorded = new Set(files.filter((f) => VIDEO.test(f.file)).map((f) => f.viewport));
  const pictures = files.filter((f) => VIDEO.test(f.file) || (PICTURE.test(f.file) && !recorded.has(f.viewport)));
  const consoles = files.filter((f) => /console\.txt$/.test(f.file));
  const clean = consoles.length && consoles.every((f) => /^empty\b/i.test(f.note ?? ''));
  return [
    calls.length ? `<p class="calls-head">${calls.length > 3 ? `Last 3 of ${calls.length} calls` : plural(calls.length, 'call', 'calls')}</p><ul class="calls">${shownCalls.join('')}</ul>` : '',
    ...pictures.map((f) => `<figure class="ev">${shown(f.file)}<figcaption>${esc([DEVICE[f.viewport] ?? f.viewport, f.note].filter(Boolean).join(' · '))}</figcaption></figure>`),
    clean ? '<p class="console">Console: no errors</p>' : consoles.map((f) => `<p class="console">Console: ${esc(f.note ?? '')}</p>`).join(''),
    files.length ? `<details class="files"><summary>All files (${files.length})</summary><ul>${files.map((f) => `<li>${shown(f.file)}${f.note ? ` <span class="muted">${esc(f.note)}</span>` : ''}</li>`).join('')}</ul></details>` : '',
  ].join('');
}

// A check: its cases in order, the failed ones open with their evidence, the passed ones one line each.
function checkRow(p, open = false) {
  const passed = p.cases.filter((c) => c.result === 'pass').length;
  const t = CHECK_TONE[p.verdict] ?? 'idle';
  const pips = p.cases.map((c) => `<i class="${CASE_TONE[c.result] ?? 'idle'}"></i>`).join('');
  const failed = p.cases.filter((c) => c.result === 'fail').map((c) => c.id);
  const blocked = p.cases.filter((c) => c.result === 'blocked').map((c) => c.id);
  const line = [failed.length && `fails at ${failed.join(', ')}`, blocked.length && `could not run ${blocked.join(', ')}`, p.verdict === 'checking' ? `${passed} passed so far` : `${passed} of ${p.cases.length} passed`].filter(Boolean).join(' · ');
  const notTested = p.verdict === 'not-proven' && /^will not:/i.test(p.proof ?? '') ? `<p class="why">Not tested: ${esc(p.proof.replace(/^will not:\s*/i, '').replace(/\.?$/, '.'))}</p>` : '';
  const row = (c) => { const tone = CASE_TONE[c.result] ?? 'idle'; const files = p.evidence.filter((f) => f.case === c.id);
    return `<li><details class="case ${tone}"${['fail', 'blocked'].includes(c.result) ? ' open' : ''}><summary><b class="mark"></b>${esc(c.id)}. ${esc(c.do ?? '')}${c.bug ? ` <span class="bugid">${esc(c.bug)}</span>` : ''}</summary>
${c.expect || c.actual ? `<dl class="vs2">${c.expect ? `<dt>Expected</dt><dd>${esc(c.expect)}</dd>` : ''}${c.actual ? `<dt>Got</dt><dd class="got">${esc(c.actual)}</dd>` : ''}</dl>` : ''}${
      c.note ? `<p class="note">${c.result === 'blocked' ? 'Why it could not run' : "Tester's note"}: ${esc(c.note)}</p>` : ''}${caseEvidence(files)}</details></li>`; };
  return `<details class="bug check ${t}" id="${esc(p.id)}"${open ? ' open' : ''}><summary><span class="head"><span class="state ${t}">${esc(VERDICT[p.verdict] ?? p.verdict)}</span><span class="title">${esc(p.statement)}</span><span class="id">${esc(p.id)}</span>
${p.cases.length > 1 ? `<span class="pips" role="img" aria-label="${passed} of ${p.cases.length} cases passed">${pips}</span>` : ''}</span><span class="trail">${esc(line)}</span></summary>
<div class="file">${notTested}<ol class="cases">${p.cases.map(row).join('')}</ol></div></details>`;
}

// The page's first answer, in sentences: what happened, and whether anything waits on you.
function answer(d) {
  const c = d.counts;
  const say = [];
  const n = (state) => d.bugs.filter((b) => b.state === state).length;
  if (d.bugs.some((b) => b.state !== 'Fix not requested')) {
    say.push(`${n('Fixed and proven')} of ${plural(d.bugs.length, 'bug', 'bugs')} fixed and proven.`);
    if (n('Fix did not hold')) say.push(`${n('Fix did not hold')} ${n('Fix did not hold') === 1 ? 'fix' : 'fixes'} did not hold.`);
    // A proven fix still needs you when it changes what production does or carries risk: name them, so the count adds up.
    const review = d.bugs.filter((b) => b.needsYou && b.state === 'Fixed and proven').length;
    if (review) say.push(`${plural(review, 'proven fix waits', 'proven fixes wait')} for your review.`);
    if (n('Waiting for your decision')) say.push(`${n('Waiting for your decision')} ${n('Waiting for your decision') === 1 ? 'waits' : 'wait'} for your decision.`);
    if (n('Fix made, being checked')) say.push(`${plural(n('Fix made, being checked'), 'fix is', 'fixes are')} being checked.`);
    if (n('Fix made, waiting for proof')) say.push(`${plural(n('Fix made, waiting for proof'), 'fix waits', 'fixes wait')} for proof.`);
    if (n('Fix made, could not be proven')) say.push(`${plural(n('Fix made, could not be proven'), 'fix', 'fixes')} could not be proven.`);
    if (n('Fix made, change missing')) say.push(`${plural(n('Fix made, change missing'), 'fix has', 'fixes have')} no change to ship: the change file is missing.`);
    if (n('Not attempted yet')) say.push(`${n('Not attempted yet')} not attempted yet.`);
  } else if (d.bugs.length) {
    const found = d.bugs.filter((b) => b.kind !== 'gap' && !b.unconfirmed && !b.withdrawn);
    const sev = SEVERITY_ORDER.map((x) => [x, found.filter((b) => b.severity === x).length]).filter(([, k]) => k).map(([x, k]) => `${k} ${x}`);
    // Which pass found them: testers who saw no suspects (blind), or testers sent after the planner's leads.
    const by = found.some((b) => b.origin) ? ['blind', 'lead'].map((o) => [o, found.filter((b) => b.origin === o).length]).filter(([, k]) => k).map(([o, k]) => (o === 'blind' ? `${k} by blind testers` : `${k} from leads`)) : [];
    if (found.length) say.push(`${plural(found.length, 'bug', 'bugs')} found${sev.length ? `: ${sev.join(', ')}` : ''}${by.length ? ` (${by.join(', ')})` : ''}.`);
    if (c.gaps) say.push(`${plural(c.gaps, 'missing feature', 'missing features')} filed as ${c.gaps === 1 ? 'a gap' : 'gaps'}.`);
    if (c.unconfirmed) say.push(`${plural(c.unconfirmed, 'bug is', 'bugs are')} not confirmed: ${c.unconfirmed === 1 ? 'its own picture does' : 'their own pictures do'} not show it.`);
    const withdrawn = d.bugs.filter((b) => b.withdrawn).length;
    if (withdrawn) say.push(`${plural(withdrawn, 'bug was', 'bugs were')} withdrawn by ${withdrawn === 1 ? 'its' : 'their'} tester.`);
  }
  if (c.checks && d.promises.some((p) => !p.fixesBug)) {
    say.push(`${c.checksProven} of ${plural(c.checks, 'check', 'checks')} proven.`);
    if (c.checksFailed) say.push(`${c.checksFailed} failed.`);
    if (c.checksUnproven) say.push(`${c.checksUnproven} could not be proven.`);
  }
  if (!say.length) say.push(d.steps.length ? 'Nothing found yet.' : 'Nothing has run yet.');
  const asked = d.steps.flatMap((s) => s.questions).filter((q) => !q.answer).length;
  // A live run says what already waits on you, then that it is still running.
  const waiting = [c.needsYou && `${plural(c.needsYou, 'thing needs', 'things need')} you${d.live ? '' : ' before shipping'}.`,
    asked && `${plural(asked, 'question waits', 'questions wait')} for you.`].filter(Boolean).join(' ');
  const need = d.live ? [waiting, 'Still running.'].filter(Boolean).join(' ') : waiting || 'Nothing needs you.';
  const failed = d.bugs.some((b) => b.state === 'Fix did not hold') || (c.checksFailed > 0 && d.promises.some((p) => !p.fixesBug && p.verdict === 'disproved'));
  return { text: say.join(' '), need, tone: d.live ? (waiting ? 'wait' : 'run') : failed ? 'need' : c.needsYou || asked ? 'wait' : 'good' };
}

// The run to scale: one band per stage, as long as its steps took. With a time missing, equal bands and no minutes.
function ribbon(d) {
  const now = Date.parse(d.updatedAt);
  const bands = d.stages.map((st) => {
    const mine = d.steps.filter((s) => STAGE_OF[s.kind] === st.label);
    const starts = mine.map((s) => s.start); const ends = mine.map((s) => (s.running ? now : s.end));
    const known = mine.length > 0 && starts.every(Boolean) && ends.every(Boolean);
    return { ...st, steps: mine.length, ms: known ? Math.max(...ends) - Math.min(...starts) : null, running: mine.some((s) => s.running),
      from: known ? Math.min(...starts) : null, to: known ? Math.max(...ends) : null, commits: [...new Set(mine.map((s) => s.commit).filter(Boolean))] };
  });
  const toScale = bands.every((b) => !b.steps || b.ms !== null);
  return `<ol class="ribbon">${bands.map((b) => {
    const sized = toScale && b.steps && b.label !== 'Done';
    // Clock times and the commit each step ran on, so every verdict traces to the code and the hour it was seen.
    const words = `${sized ? `<span>${span(b.ms)}${b.running ? ' so far' : ''}</span>` : ''}${b.from ? `<span class="clock">${clock(b.from)}–${b.running ? 'now' : clock(b.to)}</span>` : ''}${b.commits.length ? `<span class="clock">${b.commits.map(esc).join(', ')}</span>` : ''}`;
    return `<li class="band ${esc(b.state)}${b.running ? ' running' : ''}${sized ? '' : ' fixed'}" style="${sized ? `flex:${Math.max(1, Math.round(b.ms / 60e3))} 1 0` : ''}"><b>${esc(b.label)}</b>${words}</li>`;
  }).join('')}</ol>`;
}

// The step bar's counters: found, fixed and proven as far as the request's stages go, then what needs you.
function counters(d) {
  const c = d.counts;
  const has = (label) => d.stages.some((s) => s.label === label);
  const list = d.bugs.length || has('Explore') ? [`${c.found} found`, has('Fix') && `${c.fixed} fixed`, has('Prove') && `${c.proven} proven`]
    : c.checks ? [`${c.checksProven} of ${plural(c.checks, 'check', 'checks')} proven`] : [];
  return `<p class="counts">${[...list, `${c.needsYou} ${c.needsYou === 1 ? 'needs' : 'need'} you`].filter(Boolean).map(esc).join(' · ')}</p>`;
}

const STRIP_WORDS = { bug: { need: 'Fix did not hold', wait: 'Waiting for you', run: 'In progress', good: 'Fixed and proven', idle: 'No fix requested' },
  check: { need: 'Failed', wait: 'Could not be proven', run: 'Being checked', good: 'Proven', idle: 'Not run' } };

// The answer form's fields: the skill's suggestions to pick and a field for the person's own words. Each field carries the start
// of its chat line ("answer Q-1a2b", "decide BUG-003 of <step folder>"), which the skill records. The page itself writes nothing back.
const field = (line, name, legend, picks, hint) => `<fieldset data-line="${esc(line)}">${legend}${picks.length
  ? `${hint}${picks.map((a) => `<label class="pick"><input type="radio" name="${esc(name)}" value="${esc(a)}"><span>${esc(a)}</span></label>`).join('')}` : ''}<input type="text" name="${esc(name)}-own" placeholder="${picks.length ? 'Or write your own answer' : 'Your answer'}" aria-label="Your answer to ${esc(name)}"></fieldset>`;
const askForm = (questions) => `<div class="asks">${questions.map((q) => field(`answer ${q.id}`, q.id, `<legend><code>${esc(q.id)}</code> ${esc(q.note)}</legend>`, q.answers, '<p class="suggest">Possible answers, suggested by the skill, not decided:</p>')).join('')}</div>`;
// What you can answer on a bug that waits on you; each choice is a chat line fix-and-prove acts on.
const CHOICES = { 'needs-decision': ['Yes, change it', 'No, keep it as it is'], 'not-fixed': ['Try again', 'Leave it as it is'], 'wont-fix': ['Fix it anyway', 'Leave it as it is'], review: ['Ship it', 'Undo the fix'], chosen: ['Undo the fix'] };
const decideKind = (b) => (b.fix?.decided ? null : !b.needsYou ? (b.chosen && b.state === 'Fixed and proven' ? 'chosen' : null) : b.state === 'Fixed and proven' ? 'review' : CHOICES[b.fix?.status] ? b.fix.status : null);
// One bar for every answer on the page: it stays at the bottom of the screen while you pick.
const SEND = `<div class="asks send"><p class="copy"><button type="button" id="copy-answers">Copy answers</button> <span class="muted" id="copy-state" role="status">Pick answers above, then copy them into chat.</span></p>
<textarea id="answer-lines" readonly rows="2" aria-label="Answers to paste in chat" placeholder="The lines to paste in chat show here."></textarea></div>`;

// Keeps picks across the live page's 5-second refresh; browser storage can be missing, so every use is guarded.
const ASK_SCRIPT = `<script>
(function () {
  var qs = [].slice.call(document.querySelectorAll('[data-line]')); if (!qs.length) return;
  var out = document.getElementById('answer-lines'), state = document.getElementById('copy-state'), key = 'answers:' + location.pathname;
  var own = function (f) { return f.querySelector('input[type=text]'); };
  var radios = function (f) { return [].slice.call(f.querySelectorAll('input[type=radio]')); };
  var valueOf = function (f) { var r = f.querySelector('input[type=radio]:checked'); return own(f).value.trim() || (r ? r.value : ''); };
  var render = function () {
    out.value = qs.filter(valueOf).map(function (f) { return f.dataset.line + ': ' + valueOf(f); }).join('\\n');
    var saved = {}; qs.forEach(function (f) { saved[f.dataset.line] = valueOf(f); });
    try { localStorage.setItem(key, JSON.stringify(saved)); } catch (e) {}
  };
  document.addEventListener('input', function (e) {
    var f = e.target.closest('[data-line]'); if (!f) return;
    if (e.target.type === 'radio') own(f).value = ''; else radios(f).forEach(function (r) { r.checked = false; });
    state.textContent = ''; render();
  });
  try {
    var saved = JSON.parse(localStorage.getItem(key) || '{}');
    qs.forEach(function (f) { var v = saved[f.dataset.line]; if (!v) return; var r = radios(f).filter(function (x) { return x.value === v; })[0]; if (r) r.checked = true; else own(f).value = v; });
  } catch (e) {}
  render();
  document.getElementById('copy-answers').addEventListener('click', function () {
    if (!out.value) { state.textContent = 'Pick or write an answer first.'; return; }
    var n = out.value.split('\\n').length, done = function () { state.textContent = 'Copied ' + n + (n === 1 ? ' answer' : ' answers') + ': paste them in chat.'; };
    var fallback = function () { out.select(); try { document.execCommand('copy'); done(); } catch (e) { state.textContent = 'Select the lines below and copy them.'; } };
    if (navigator.clipboard) navigator.clipboard.writeText(out.value).then(done, fallback); else fallback();
  });
})();
</script>`;

// While a run goes, the page reloads every 5 seconds and keeps your place: scroll, open sections and video times.
// It waits while a video plays or you type. Browser storage can be missing, so every use is guarded.
const LIVE_SCRIPT = `<script>
(function () {
  var key = 'place:' + location.pathname, all = function (s) { return [].slice.call(document.querySelectorAll(s)); };
  // A section is known by its id, else by the card it sits in and its own title (many are just "Details").
  var name = function (d, i) { return d.id || ((d.parentElement.closest('[id]') || {}).id || '') + '/' + ((d.querySelector('summary') || {}).textContent || i); };
  history.scrollRestoration = 'manual';
  try {
    var p = JSON.parse(sessionStorage.getItem(key) || 'null');
    if (p) {
      all('details').forEach(function (d, i) { var n = name(d, i); if (n in p.open) d.open = p.open[n]; });
      all('video').forEach(function (v) { var t = p.videos[v.getAttribute('src')]; if (t) v.currentTime = t; });
      scrollTo(0, p.y); addEventListener('load', function () { scrollTo(0, p.y); });
    }
  } catch (e) {}
  var busy = function () { var a = document.activeElement;
    return all('video').some(function (v) { return !v.paused && !v.ended; }) || (a && /^(INPUT|TEXTAREA)$/.test(a.tagName) && a.type !== 'radio'); };
  setInterval(function () {
    if (busy()) return;
    var p = { y: scrollY, open: {}, videos: {} };
    all('details').forEach(function (d, i) { p.open[name(d, i)] = d.open; });
    all('video').forEach(function (v) { if (v.currentTime) p.videos[v.getAttribute('src')] = v.currentTime; });
    try { sessionStorage.setItem(key, JSON.stringify(p)); } catch (e) {}
    location.reload();
  }, 5000);
})();
</script>`;

export function pageHtml(d) {
  const title = `${d.feature}: ${KIND[d.kind] ?? d.kind ?? ''}`;
  const started = d.begun ? `${new Date(d.begun).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} at ${clock(d.begun)} ${zone(d.begun)}` : d.date ?? '';
  const a = answer(d);
  // What was and was not tested, each with the step it comes from.
  const from = (s) => ` <span class="muted">(while ${esc({ spec: 'planning', explore: 'exploring', fix: 'fixing', proof: 'proving' }[s.kind] ?? s.name)})</span>`;
  const tested = d.steps.flatMap((s) => (s.tested ?? []).map((n) => `${esc(n)}${from(s)}`));
  const notTested = d.steps.flatMap((s) => [...s.notCovered.map((n) => n.replace(/^T\d+: /, '')), ...(s.willNotProve ? [s.willNotProve] : [])].map((n) => `${esc(n)}${from(s)}`));
  const questions = d.steps.flatMap((s) => s.questions).filter((q) => !q.answer);
  const yours = d.steps.flatMap((s) => s.questions).filter((q) => q.answer);
  const asking = questions.length > 0 || d.bugs.some(decideKind);
  // Auto mode's choices are the run's, not any bug's: they fold into the banner at the top.
  // Each change auto mode chose for a bug is a choice too, linked to its card.
  const fixesChosen = d.bugs.filter((b) => /^auto:/.test(b.fix?.source ?? '')).map((b) => `<li><a href="#${esc(b.anchor)}">${esc(b.label ?? b.id)}</a>: ${esc(b.fix.source.replace(/^auto:\s*/, ''))}</li>`);
  const made = d.decisions.defaults.length + fixesChosen.length;
  const chosen = made
    ? `<details class="banner"><summary>Auto mode made ${plural(made, 'choice', 'choices')} for this whole run, without you</summary><ul>${d.decisions.defaults.map((x) => `<li>${ruling(x.text, x.kind || x.step ? from({ kind: x.kind, name: x.step }) : '')}</li>`).join('')}${fixesChosen.join('')}</ul></details>`
    : '<p class="banner">Run in auto mode: the skill made its choices without you.</p>';
  const notes = [
    d.stopped && ['The run stopped', `<p>${esc(d.stopped)}</p>`, 'need'],
    d.flaky?.length && ['Flaky checks', `<p>Each held in one proof and failed in another on the same code, so no fix was undone for it: ${esc(d.flaky.join(', '))}. Prove it again before you trust it.</p>`, 'need'],
    questions.length && ['Questions for you', `${askForm(questions)}<p class="muted">An answer may change what counts as a bug. Pick or write answers, press Copy answers and paste the lines in chat; or reply in chat yourself: <code>answer ${esc(questions[0].id)}: your answer</code>. The skill keeps them for this feature: explorers stop asking, and the next proof checks the app against them.</p>`, '', 'questions'],
    yours.length && ['Your answers', `<ul>${yours.map((q) => `<li><code>${esc(q.id)}</code> ${esc(q.note)}<br>You said: <b>${esc(q.answer)}</b></li>`).join('')}</ul>`],
    tested.length && ['Tested', `<ul>${tested.map((n) => `<li>${n}</li>`).join('')}</ul>`],
    notTested.length && ['Not tested', `<ul>${notTested.map((n) => `<li>${n}</li>`).join('')}</ul>`],
  ].filter(Boolean);
  // A stopped run shows above Start here; the other notes below it, so Start here is on a phone's first screen.
  const dl = (list) => (list.length ? `<dl class="notes">${list.map(([dt, dd, cls, id]) => `<dt${id ? ` id="${id}"` : ''}${cls ? ` class="${cls}"` : ''}>${esc(dt)}</dt><dd>${dd}</dd>`).join('')}</dl>` : '');

  // What needs you, most urgent first: bugs, then checks that are not a fix's proof. One to start with, five next, the rest folded.
  // With more than one round, each card names the rounds that found its bug.
  const rounds = d.bugs.some((b) => b.round > 1 || b.again);
  const urgent = [...d.bugs.filter((b) => b.needsYou).map((b) => ({ item: b, tone: STATE_TONE(b), row: (open) => bugRow(b, d.unchecked, open, rounds) })),
    ...d.promises.filter((p) => !p.fixesBug && ['disproved', 'not-proven'].includes(p.verdict)).map((p) => ({ item: p, tone: CHECK_TONE[p.verdict], row: (open) => checkRow(p, open) }))].sort(urgentFirst);
  const [first, ...next] = urgent;
  const group = (label, rows, open = false) => (rows.length ? `<details class="group"${open ? ' open' : ''}><summary>${esc(label)} <span class="n">${rows.length}</span></summary>${rows.join('\n')}</details>` : '');
  const calm = !urgent.length;
  const rest = d.bugs.filter((b) => !b.needsYou);
  // Being worked on also takes any state no other group names, so every bug has a card.
  const settled = ['Fixed and proven', 'Fix not requested', "Won't fix"];
  const restGroups = [
    ['Being worked on', rest.filter((b) => !settled.includes(b.state)), true],
    ['Fixed and proven', rest.filter((b) => b.state === 'Fixed and proven'), false],
    ['Found, no fix requested', rest.filter((b) => b.state === 'Fix not requested' && b.kind !== 'gap' && !b.unconfirmed && !b.withdrawn), calm],
    ['Missing features (gaps)', rest.filter((b) => b.state === 'Fix not requested' && b.kind === 'gap' && !b.unconfirmed && !b.withdrawn), calm],
    ['Not confirmed: its own picture does not show it', rest.filter((b) => b.state === 'Fix not requested' && b.unconfirmed && !b.withdrawn), false],
    ['Withdrawn by their tester', rest.filter((b) => b.state === 'Fix not requested' && b.withdrawn), false],
    ["Won't fix", rest.filter((b) => b.state === "Won't fix"), false],
  ].map(([label, list, open]) => [label, list.sort(worstFirst), open]);
  const bugGroups = restGroups.map(([label, list, open]) => group(label, list.map((b) => bugRow(b, d.unchecked, false, rounds)), open)).join('\n');
  const otherChecks = d.promises.filter((p) => !urgent.some((u) => u.item === p));
  const checkGroups = [
    ['Being checked', otherChecks.filter((p) => p.verdict === 'checking'), true],
    ['Checks of the fixes', otherChecks.filter((p) => p.fixesBug && p.verdict !== 'checking'), false],
    ['Proven', otherChecks.filter((p) => !p.fixesBug && p.verdict === 'proven'), calm && !d.bugs.length],
  ].map(([label, list, open]) => group(label, list.map((p) => checkRow(p)), open)).join('\n');

  const items = d.bugs.length ? [...urgent.filter((u) => u.item.state !== undefined).map((u) => u.item), ...restGroups.flatMap(([, list]) => list)].map((b) => [b.anchor, STATE_TONE(b), b.title, b.label])
    : d.promises.filter((p) => !p.fixesBug).sort((x, y) => ['need', 'wait', 'run', 'good', 'idle'].indexOf(CHECK_TONE[x.verdict] ?? 'idle') - ['need', 'wait', 'run', 'good', 'idle'].indexOf(CHECK_TONE[y.verdict] ?? 'idle')).map((p) => [p.id, CHECK_TONE[p.verdict] ?? 'idle', p.statement]);
  const words = STRIP_WORDS[d.bugs.length ? 'bug' : 'check'];
  const key = ['need', 'wait', 'run', 'good', 'idle'].map((t) => [t, items.filter(([, x]) => x === t).length]).filter(([, k]) => k);
  // Past 20, a cell is a small mark without its id, so a long list stays a few rows on a phone; it still links to its bug.
  const marks = items.length > 20;
  const strip = items.length ? `<div class="strip${marks ? ' marks' : ''}">${items.map(([id, t, name, label]) => { const said = esc(`${label ?? id}: ${name}`);
    return `<a class="cell ${t}${first && (first.item.anchor ?? first.item.id) === id ? ' first' : ''}" href="#${esc(id)}" title="${said}"${marks ? ` aria-label="${said}"></a>` : `><span>${esc(label ?? id)}</span></a>`}`; }).join('')}</div>
<p class="key">${key.map(([t, k]) => `<span><i class="${t}"></i>${words[t]}: ${k}</span>`).join('')}</p>` : '';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
${d.live ? '<noscript><meta http-equiv="refresh" content="5"></noscript>\n' : ''}<title>${esc(title)}</title>
<style>
:root{--paper:#f4f2ee;--sheet:#fff;--soft:#f7f6f3;--ink:#1c1b18;--ink-2:#4d4a44;--ink-3:#635f57;--line:#e3dfd7;--good:#2a7049;--need:#b23a0a;--wait:#8f5a00;--run:#4f46e5;--on-run:#fff;--idle:#9a9388;
--tint-need:color-mix(in srgb,var(--need) 10%,var(--sheet));--tint-wait:color-mix(in srgb,var(--wait) 11%,var(--sheet));--tint-good:color-mix(in srgb,var(--good) 9%,var(--sheet));
--serif:Charter,"Bitstream Charter","Iowan Old Style",Georgia,serif;--sans:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;--mono:ui-monospace,Menlo,Consolas,monospace;color-scheme:light}
*{box-sizing:border-box}html{background:var(--paper)}body{margin:0;color:var(--ink);font:16px/1.55 var(--sans);font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
main{max-width:820px;margin:0 auto;padding:32px 16px 72px}a{color:var(--run);text-underline-offset:2px}:focus-visible{outline:2px solid var(--run);outline-offset:2px}
.good{--tone:var(--good);--tint:var(--tint-good)}.need{--tone:var(--need);--tint:var(--tint-need)}.wait{--tone:var(--wait);--tint:var(--tint-wait)}.run{--tone:var(--run);--tint:var(--soft)}.idle{--tone:var(--idle);--tint:var(--soft)}
.kick{margin:0;color:var(--ink-3);font-size:14px}.kick b{color:var(--ink);font-weight:650}
h1{margin:10px 0 8px;font:700 clamp(28px,6vw,40px)/1.1 var(--serif);letter-spacing:-.02em;text-wrap:balance}h1.good{color:var(--good)}h1 a{color:inherit;text-decoration-thickness:2px}
.sub{margin:0 0 22px;color:var(--ink-2);font-size:17px;max-width:44em}
.strip{display:flex;flex-wrap:wrap;gap:3px;margin:0 0 8px}.cell{display:block;min-width:24px;padding:0 8px 0 11px;border-radius:4px;background:var(--tint);box-shadow:inset 4px 0 0 var(--tone);color:var(--ink);font:600 12px/24px var(--sans);text-decoration:none}.cell.first{outline:2px solid var(--tone);outline-offset:2px}.cell:hover{opacity:1}
.strip.marks .cell{min-width:0;width:16px;height:16px;padding:0;border-radius:3px;background:var(--tone);box-shadow:none}
.key{display:flex;flex-wrap:wrap;gap:4px 16px;margin:0 0 22px;font-size:13px;color:var(--ink-3)}.key i{display:inline-block;width:9px;height:9px;border-radius:2px;background:var(--tone);margin-right:6px}
.ribbon{display:flex;gap:3px;list-style:none;margin:0;padding:0}.band{flex:1 1 0;min-width:min-content;padding:7px 10px;border-radius:6px;background:var(--line);color:var(--ink-2);font-size:12px;line-height:1.3;overflow:hidden;white-space:nowrap}
.band b{display:block;font-weight:650}.band span{color:var(--ink-3)}.band.fixed{flex:0 0 auto}
.band.done{background:color-mix(in srgb,var(--good) 16%,var(--sheet));color:var(--ink);box-shadow:inset 0 -3px 0 var(--good)}
.band.now{background:var(--run);color:var(--on-run)}.band.now span{color:inherit}.band.running{background:repeating-linear-gradient(135deg,var(--run) 0 8px,color-mix(in srgb,var(--run) 88%,var(--sheet)) 8px 16px)}
.band.todo{background:none;border:1.5px dashed var(--line);color:var(--ink-3)}
.counts{margin:8px 0 0;font-size:14px;font-weight:600;color:var(--ink-2)}.meta{margin:10px 0 0;color:var(--ink-3);font-size:13px}.band .clock{display:block;font-size:11px}.none{color:var(--ink-3);font-style:italic}.back{margin:0 0 6px;font-size:14px}
.notes{display:grid;grid-template-columns:10em 1fr;gap:10px 20px;margin:28px 0 0;padding:16px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
.notes dt{font-weight:650}.notes dt.need{color:var(--need)}.notes dt.wait{color:var(--wait)}.notes dd{margin:0}.notes p{margin:4px 0 0}.notes ul{margin:0;padding-left:18px}.notes .suggest{color:var(--ink-3);font-size:.9em;font-style:italic}
.asks fieldset{border:0;margin:0 0 18px;padding:0;min-width:0}.asks legend{padding:0}.asks .pick{display:flex;gap:8px;align-items:baseline;margin:6px 0;padding:6px 10px;border:1px solid var(--line);border-radius:8px;background:var(--sheet);cursor:pointer}.asks .pick:has(:checked){border-color:var(--run);background:color-mix(in srgb,var(--run) 7%,var(--sheet))}.asks .pick input{flex:none;margin:0}
.asks input[type=text],.asks textarea{display:block;width:100%;margin:6px 0 0;padding:7px 10px;border:1px solid var(--line);border-radius:8px;background:var(--sheet);color:var(--ink);font:inherit}.asks textarea{font:13px/1.5 var(--mono);resize:vertical}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}.ask .asks,.ask fieldset{margin:8px 0 0}
.send{position:sticky;bottom:0;margin:24px 0 0;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--sheet);box-shadow:0 -2px 10px rgb(0 0 0/.06)}.send textarea{margin-top:8px}.send textarea:placeholder-shown{display:none}
.asks .copy{margin:0}.asks button{padding:7px 16px;border:0;border-radius:8px;background:var(--run);color:var(--on-run);font:650 14px var(--sans);cursor:pointer}
.banner{display:inline-block;margin:10px 0 0;padding:4px 12px;border-radius:8px;background:var(--tint-wait);border-left:4px solid var(--wait);font-size:14px;font-weight:650}details.banner{display:block;width:fit-content;max-width:100%;box-sizing:border-box;margin:10px 0 0}details.banner>summary::before{content:"+";display:inline-block;width:1.1em;color:var(--wait)}details.banner[open]>summary::before{content:"−"}details.banner ul{margin:6px 0 4px;padding-left:18px;font-weight:400}details.banner li{margin:0 0 6px}
h2{margin:40px 0 12px;font:650 14px var(--sans);color:var(--ink-3)}
.start{margin:30px 0 0}.start>p{margin:0 0 8px;font:650 14px var(--sans);color:var(--tone)}
.start details.bug{border-left-width:8px;border-radius:14px}.start summary .title{font:700 clamp(20px,4vw,24px)/1.2 var(--serif);flex-basis:100%}.queue .head .title{font-size:17px;font-weight:650}
.queue{list-style:none;margin:0;padding:0}.head .id{font:600 12px/1.5 var(--mono);color:var(--ink-3);white-space:nowrap}
details{margin:8px 0}details>summary{list-style:none;cursor:pointer}details>summary::-webkit-details-marker{display:none}
details.bug{background:var(--sheet);border:1px solid var(--line);border-left:5px solid var(--tone);border-radius:10px;overflow:hidden}
details.bug>summary{padding:13px 16px;display:grid;gap:4px}details.bug>summary:hover{background:var(--soft)}
.head{display:flex;flex-wrap:wrap;gap:6px 12px;align-items:baseline}.head .title{flex:1 1 100%;font-weight:650}
.sev{font-size:13px;color:var(--ink-3)}.sev.critical,.sev.major{color:var(--ink);font-weight:650}
.where,.round{font-size:12px;font-weight:600;color:var(--ink-2);background:var(--soft);border:1px solid var(--line);border-radius:999px;padding:0 8px;white-space:nowrap}
.prod{font-size:12px;color:var(--ink-2);border:1px dashed var(--ink-3);border-radius:999px;padding:0 8px}
.state{font-size:13px;font-weight:650;padding:1px 10px;border-radius:999px;color:var(--tone);background:var(--tint);white-space:nowrap}
.trail{font-size:13px;color:var(--ink-3)}.trail .need,.trail .wait{color:var(--tone);font-weight:600}.arrow{opacity:.6}
.pips{display:inline-flex;gap:3px}.pips i{width:8px;height:14px;border-radius:2px;background:var(--tone)}
details.group{border-top:1px solid var(--line);margin:0}details.group>summary{padding:14px 0;font-weight:650;color:var(--ink-2)}details.group>summary::before{content:"+";display:inline-block;width:1.2em;color:var(--ink-3)}details.group[open]>summary::before{content:"−"}
.n{font-size:12px;font-weight:600;color:var(--ink-3);border:1px solid var(--line);border-radius:999px;padding:0 7px;margin-left:4px}
.file{border-top:1px solid var(--line);padding:4px 18px 16px}
.ask{margin:14px 0 4px;padding:12px 16px;border-radius:10px;background:var(--tint-wait);border-left:4px solid var(--wait)}.need .ask{background:var(--tint-need);border-color:var(--need)}
.ask b{color:var(--tone,var(--wait))}.ask p{margin:4px 0 0}
.sec{display:grid;grid-template-columns:9.5em 1fr;gap:6px 22px;padding:16px 0;border-top:1px solid var(--line)}.ask+.sec{border-top:0}
.sec>h4{margin:0;padding-top:2px;font:650 14px var(--sans);color:var(--ink-3)}.sec p{margin:0 0 6px}
.repro{display:grid;grid-template-columns:minmax(0,200px) 1fr;gap:16px 22px;align-items:start}.repro.bare{grid-template-columns:1fr}
.shot{margin:0}.shot img,.shot video{display:block;width:100%;max-height:340px;object-fit:contain;border-radius:8px;border:1px solid var(--line);background:var(--soft)}.shot figcaption{font-size:12px;color:var(--ink-3);margin-top:6px}
.seen{font-size:14px;color:var(--ink-3)}
ol.steps{margin:0 0 12px;padding:0;list-style:none;counter-reset:s}ol.steps li{counter-increment:s;display:grid;grid-template-columns:28px 1fr;padding:2px 0}
ol.steps li::before{content:counter(s);width:21px;height:21px;border-radius:50%;background:var(--soft);border:1px solid var(--line);font:600 12px/19px var(--sans);text-align:center}
.vs{grid-column:1/-1;display:grid;grid-template-columns:1fr 1fr;gap:10px}.vs div{border-radius:8px;padding:10px 12px;background:var(--soft);border-top:3px solid var(--c);font-size:15px}.vs .e{--c:var(--good)}.vs .a{--c:var(--need)}
.vs small,.facts small{display:block;font-size:12px;font-weight:650;color:var(--ink-3);margin-bottom:2px}
.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:8px;margin:8px 0 0}.facts div{background:var(--soft);border-radius:8px;padding:9px 12px;font-size:14px}
.chips{display:flex;flex-wrap:wrap;gap:6px}code{font:13px var(--mono);background:var(--soft);border:1px solid var(--line);border-radius:5px;padding:1px 6px}


.state.idle,.when{color:var(--ink-3);font-size:13px;margin-left:4px}
.foot{margin:6px 0 0;font-size:13px;color:var(--ink-3)}
.ships{margin:12px 0 0;font-weight:650}details.more{border-top:1px solid var(--line);margin:0}details.more>summary{padding:12px 0;font-weight:650;color:var(--ink-2)}details.more>summary::before{content:"+";display:inline-block;width:1.2em;color:var(--ink-3)}details.more[open]>summary::before{content:"−"}details.more>.sec:first-of-type{border-top:0}details.more>p{margin:0 0 8px}
.check .file>p{margin:10px 0 0}.why{color:var(--ink-2)}
ol.cases{list-style:none;margin:10px 0 4px;padding:0}ol.cases>li{border-top:1px solid var(--line)}ol.cases>li:first-child{border-top:0}
details.case{margin:0}details.case>summary{display:flex;gap:8px;align-items:baseline;padding:10px 0;font-weight:600}details.case[open]>summary{padding-bottom:4px}
.mark{flex:none;width:16px;height:16px;border-radius:50%;background:var(--tone);color:#fff;font:700 11px/16px var(--sans);text-align:center;align-self:center}.good .mark::before{content:"✓"}.need .mark::before{content:"✕"}.wait .mark::before,.idle .mark::before{content:"–"}.idle .mark{background:var(--line);color:var(--ink-3)}
.bugid{margin-left:auto;font:600 12px var(--mono);color:var(--need);white-space:nowrap}
dl.vs2{display:grid;grid-template-columns:max-content 1fr;gap:4px 12px;margin:6px 0 0 24px;font-size:15px}dl.vs2 dt{color:var(--ink-3);font-size:13px;font-weight:650;padding-top:2px}dl.vs2 dd{margin:0}details.case.need dd.got{color:var(--need)}
.case .note{margin:10px 0 0 24px;padding:8px 12px;border-radius:8px;background:var(--tint-wait);font-size:14px}
.calls-head,.console{margin:10px 0 0 24px;font-size:13px;color:var(--ink-3)}ul.calls{margin:4px 0 0 24px;padding:0;list-style:none;font:13px/1.5 var(--mono)}ul.calls li{padding:2px 0}
figure.ev{margin:10px 0 0 24px}figure.ev img,figure.ev video{display:block;width:100%;max-height:420px;object-fit:contain;border:1px solid var(--line);border-radius:8px;background:var(--soft)}figure.ev figcaption{margin-top:4px;font-size:13px;color:var(--ink-3)}
details.files{margin:8px 0 10px 24px}details.files>summary{font-size:13px;color:var(--ink-3)}details.files>summary::before{content:"+ "}details.files[open]>summary::before{content:"− "}details.files ul{margin:4px 0 0;padding-left:18px;font-size:13px}details.files img,details.files video{max-width:160px;max-height:100px;vertical-align:middle}
footer{margin-top:40px}footer details{border-top:1px solid var(--line);margin:0}footer summary{padding:12px 0;font-weight:650;color:var(--ink-2)}footer summary::before{content:"+";display:inline-block;width:1.2em;color:var(--ink-3)}footer details[open]>summary::before{content:"−"}footer ul{margin:0 0 12px;padding-left:20px}
.brief{white-space:pre-line;margin:0 0 12px}.muted{color:var(--ink-3)}
@media (max-width:640px){.sec{grid-template-columns:1fr}.repro{grid-template-columns:1fr}.repro .shot{order:3}.shot img,.shot video{height:160px;width:auto;max-width:100%}.vs{grid-template-columns:1fr}.notes{grid-template-columns:1fr}.band span{display:none}.file{padding:4px 14px 14px}}
</style></head><body><main>
<header>
${d.hasIndex ? '<p class="back"><a href="../../index.html">All requests</a></p>\n' : ''}<p class="kick"><b>${esc(d.feature)}</b>, ${esc((KIND[d.kind] ?? d.kind ?? '').toLowerCase())}, started ${esc(started)}. ${d.live ? 'Running now.' : 'Finished.'}${d.testedOn ? ` Tested on ${esc(d.testedOn.env ?? 'an unnamed environment')}${d.testedOn.commit ? ` at ${esc(d.testedOn.commit)}` : ''}.` : ''}</p>
${d.auto ? `${chosen}\n` : d.approvedByPerson ? '<p class="kick">The checks were approved by a person before testing.</p>\n' : ''}<h1 class="${a.tone}">${esc(a.need).replace(/\d+ questions? waits? for you\./, (m) => `<a href="#questions">${m}</a>`)}</h1>
<p class="sub">${esc(a.text)}</p>
${strip}
${ribbon(d)}
${counters(d)}
<p class="meta">${d.live ? `Updated ${esc(when(d.updatedAt))}. This page refreshes itself every 5 seconds, except while a video plays; if this time stops moving, the run may have stopped.` : `Last updated ${esc(when(d.updatedAt))}.`}</p>
</header>
${dl(notes.filter(([, , cls]) => cls === 'need'))}
${first ? `<section class="start ${first.tone}"><p>Start here</p>${first.row(true)}</section>` : ''}
${next.length ? `<h2>Then, in this order</h2><ol class="queue">${next.slice(0, 5).map((u) => `<li>${u.row(false)}</li>`).join('')}</ol>${group(`${plural(next.length - 5, 'more needs', 'more need')} you`, next.slice(5).map((u) => u.row(false)))}` : ''}
${dl(notes.filter(([, , cls]) => cls !== 'need'))}
${bugGroups.trim() || checkGroups.trim() ? `<h2>${urgent.length ? 'Everything else' : d.bugs.length ? 'Bugs' : 'Checks'}</h2>${bugGroups}\n${checkGroups}` : ''}
<footer>
${d.releaseNotes.length ? `<details><summary>For the release notes</summary><ul>${d.releaseNotes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></details>` : ''}
${d.learnings.length ? `<details><summary>Learnings from the code and docs (${d.learnings.length})</summary><ul>${d.learnings.map((l) => `<li>${esc(l.learning)}<br><span class="muted">${[l.by, l.source].filter(Boolean).map(esc).join(' · ')}</span></li>`).join('')}</ul></details>` : ''}
${d.brief ? `<details><summary>What was asked</summary><p class="brief">${plainBrief(d.brief)}</p></details>` : ''}
${d.problems.length ? `<details><summary>${plural(d.problems.length, 'note', 'notes')} from the evidence check</summary><p class="muted">For whoever audits this run; the results above already take these into account.</p><ul>${d.problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></details>` : ''}
</footer>
${asking ? SEND : ''}
</main>${asking ? `\n${ASK_SCRIPT}` : ''}${d.live ? `\n${LIVE_SCRIPT}` : ''}</body></html>
`;
}

const mtime = (file) => (existsSync(file) ? statSync(file).mtimeMs : 0);

// With `ifPage` (the page's mtime when this build was asked for, 0 for none), a page someone wrote meanwhile is newer
// than what this build read, so it is kept: a slow background build never overwrites the final one.
export async function writeReport(request, { ifPage = null } = {}) {
  const data = await requestData(request);
  const page = join(request, 'report.html');
  if (ifPage !== null && mtime(page) !== ifPage) return page;
  // Each writer its own temp file, renamed into place: parallel writers never share one, and a reader never sees half a file.
  const atomic = (file, text) => { const tmp = `${file}.${process.pid}.tmp`; writeFileSync(tmp, text); renameSync(tmp, file); };
  const { name, feature, kind, date, live, counts, updatedAt, auto } = data;
  const bugs = data.bugs.map(({ id, label, anchor, title, severity, needsYou, state }) => ({ id, label, anchor, title, severity, needsYou, state }));
  atomic(join(request, 'summary.json'), `${JSON.stringify({ name, feature, kind, date, live, counts, updatedAt, auto, bugs })}\n`);
  // A request that just finished changes the index; a running one shows there as running from the last finished write.
  // The index goes first, so the page can link back to it.
  if (!live) writeIndex(dirname(dirname(request)));
  atomic(page, pageHtml({ ...data, hasIndex: existsSync(join(dirname(dirname(request)), 'index.html')) }));
  return page;
}

// The request folder a path is in, or null.
export function requestOf(path) {
  for (let dir = resolve(path); dir !== dirname(dir); dir = dirname(dir)) if (REQUEST.test(basename(dir))) return dir;
  return null;
}

// Rewrites the page of each request the paths are in, once per request; a page that cannot be written never fails the caller.
export async function writeReportFor(...paths) {
  for (const request of new Set(paths.map(requestOf).filter(Boolean))) {
    try {
      await writeReport(request);
    } catch (error) {
      console.error(`Report: not written: ${error.message}`);
    }
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  const [request, flag, at] = process.argv.slice(2);
  if (!request || !REQUEST.test(basename(resolve(request))) || (flag && (flag !== '--if-page' || !Number.isFinite(Number(at))))) {
    console.error('Usage: node report.mjs <request folder> [--if-page <mtime ms>]');
    process.exit(1);
  }
  console.log(`Open: ${pathToFileURL(await writeReport(resolve(request), { ifPage: flag ? Number(at) : null })).href}`);
}
