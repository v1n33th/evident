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

// Files that change no verdict: the result itself, a bug's record (a fixer or a decision writes its fix into bug.json after
// the check) and a bug number's reservation (.BUG-NNN). A bug filed later with only its record so leaves the result fresh;
// evidence added to it does not.
const inert = (name) => name === 'result.json' || name === 'bug.json' || /^\.BUG-\d+$/.test(name);

// Newest modified time of any file in a folder tree, inert files left out.
const newest = (dir) => readdirSync(dir, { withFileTypes: true }).reduce((max, e) => {
  if (inert(e.name)) return max;
  const path = join(dir, e.name);
  return Math.max(max, e.isDirectory() ? newest(path) : statSync(path).mtimeMs);
}, 0);

const listed = (step, dir = step) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (inert(e.name) ? []
  : e.isDirectory() ? listed(step, join(dir, e.name)) : [relative(step, join(dir, e.name))])).sort();

// A step's checked data, while no file in it changed, came or went after the check.
export function readResult(step) {
  const file = join(step, 'result.json');
  if (!existsSync(file)) return null;
  try {
    const { newest: then, files, data } = JSON.parse(readFileSync(file, 'utf8'));
    // An older result may list inert files too: compare without them.
    const kept = (files ?? []).filter((f) => !inert(f.split('/').pop()));
    return typeof then === 'number' && newest(step) <= then && String(kept) === String(listed(step)) ? data : null;
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
    // Once the run is over, a proof that never finished could not prove the fix.
    const open = live ? 'checking' : 'not-proven';
    return { verdict: !p || !p.checked ? open : p.data.claims.find((c) => c.id === link.claim)?.verdict ?? open, at: valid(at), claim: link.claim };
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
  // One change can fix several bugs ("Fixed with BUG-010"): a decision on one covers the others, decided before or after.
  const decidedBy = new Map();
  for (const f of folders) { try { const x = readJson(join(f, 'bug.json')).fix; const k = x?.patch || x?.commit; if (k && x.decided && !decidedBy.has(k)) decidedBy.set(k, x); } catch {} }
  const bugs = folders.filter((f) => existsSync(join(f, 'bug.json')) && !seen.has(real(f)) && seen.add(real(f))).flatMap((folder) => {
    let b;
    try { b = readJson(join(folder, 'bug.json')); } catch (error) { problems.push(`${rel(folder)}/bug.json: ${error.message}`); return []; }
    // A fix run that finished after your answer and still asks has asked again: your answer is the earlier one, the new question is open.
    const ranAt = fixSteps.filter((s) => roundBugFolders(s.dir).some((x) => real(x) === real(folder))).map((s) => Date.parse(readResult(s.dir)?.generatedAt ?? '') || 0);
    if (b.fix?.decided && ['needs-decision', 'not-fixed'].includes(b.fix.status) && Math.max(0, ...ranAt) > (Date.parse(b.fix.decidedAt ?? '') || Infinity)) {
      const { decided, decidedAt, ...rest } = b.fix;
      b.fix = { ...rest, earlier: decided };
    }
    const twin = !b.fix?.decided && decidedBy.get(b.fix?.patch || b.fix?.commit);
    if (twin) b.fix = { ...b.fix, decided: twin.decided, ...(twin.status === 'wont-fix' ? { status: 'wont-fix' } : {}), ...(twin.invalid ? { invalid: twin.invalid } : {}) };
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
      state: b.fix?.invalid ? 'Not a bug' : lost ? 'Fix made, change missing' : stateOf(status, proven, fixAsked),
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

  // Each round numbers its bugs from BUG-001: a later bug with a taken id says its round, so every id on the page is unique.
  const taken = new Set(); const used = new Set();
  for (const b of bugs) {
    const twin = taken.has(b.id);
    taken.add(b.id);
    let label = twin ? `${b.id} (round ${b.round}${/^proof/.test(b.step) ? ', from a test' : ''})` : b.id;
    if (used.has(label)) label = `${b.id} (${b.step})`;
    used.add(label);
    Object.assign(b, { label, anchor: twin ? `${b.id}-${b.step}` : b.id });
  }

  // Checks proving a fix are counted with their bug; the others (a proof of a change, ledger re-checks) need you themselves.
  const linked = new Set(steps.filter((s) => s.kind === 'proof').flatMap((s) => { try { return readJson(join(s.dir, 'fix-claims.json')).map((l) => l.claim); } catch { return []; } }));
  const answered = answersOf(dirname(request));
  const all = steps.filter((s) => (s.kind === 'proof' || s.kind === 'spec') && s.data?.claims).flatMap((s) => s.data.claims.map((c) => ({
    // Where a "decide <id> of <step>" line points, and the user's decision on a check that failed or could not be proven.
    at: relative(dirname(dirname(dirname(request))), s.dir), decided: answered.get(`${basename(request)}/${s.name}/${c.id}`)?.answer ?? null,
    id: c.id, statement: c.statement, verdict: s.checked ? c.verdict : live ? 'checking' : 'not-run', cases: c.cases ?? [],
    // Each file keeps its case, device and note, so the page shows it under the case it proves.
    evidence: (c.evidence ?? []).map((l) => ({ ...l, file: `${s.name}/${l.file}` })), proof: c.proof ?? null, step: s.name, fixesBug: linked.has(c.id),
  })));
  // A check proven again in a later step shows once, with its latest verdict; a later step still checking never hides one.
  const latest = new Map();
  const open = (v) => v === 'checking' || v === 'not-run';
  for (const p of all) { const prev = latest.get(p.id); if (!prev || !open(p.verdict) || open(prev.verdict)) latest.set(p.id, p); }
  const promises = [...latest.values()];
  const checks = (v) => promises.filter((p) => p.verdict === v).length;
  // A check you decided on is in the skill's hands, not yours.
  // What each item asks of you. `decide`: only a person can answer it. `retest`: the tool's own unfinished work (a test that could
  // not run, a fix whose test did not finish), all answered at once by testing again. `optional`: settled, open to change
  // (a bug left as it is). Counted as you would count them: each decision once, and the retests as one.
  for (const b of bugs) b.ask = !b.needsYou ? null : /^Fix made, (could not be proven|waiting for proof)$/.test(b.state) ? 'retest'
    : b.state === 'Fix made, being checked' ? null : b.state === "Won't fix" ? 'optional' : 'decide';
  for (const p of promises) p.ask = p.fixesBug || p.decided ? null : p.verdict === 'disproved' ? 'decide' : p.verdict === 'not-proven' ? 'retest' : null;
  const items = [...bugs, ...promises];
  const checksNeed = items.filter((x) => x.ask === 'decide').length + (items.some((x) => x.ask === 'retest') ? 1 : 0);

  // Each question with the user's answer, when the feature's answers.jsonl has one.
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
    counts: { found: bugs.filter((b) => b.kind !== 'gap' && !b.unconfirmed && !b.withdrawn).length, gaps: bugs.filter((b) => b.kind === 'gap' && !b.unconfirmed && !b.withdrawn).length, unconfirmed: bugs.filter((b) => b.unconfirmed).length, fixed: bugs.filter((b) => b.fixed).length, proven: bugs.filter((b) => b.proven === 'proven').length, needsYou: checksNeed, questions: steps.flatMap(questions).filter((q) => !q.answer).length,
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
const VERDICT = { proven: 'Passed', disproved: 'Failed', 'not-proven': 'No result', checking: 'Running', 'not-run': 'Not run' };
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
  return `${esc(what.charAt(0).toUpperCase() + what.slice(1))}${tag}${said ? `<br><span class="muted">Why: ${esc(why)}</span>` : ''}${cost && !/^none\.?$/i.test(cost.trim()) ? `<br><span class="muted">If that was wrong: ${esc(cost)}</span>` : ''}`; };

// brief.md in plain words: its headings as labels, without the # marks.
const plainBrief = (md) => md.trim().split('\n').map((l) => { const h = l.match(/^#+\s+(.*)$/); return h ? `<b>${esc(h[1])}</b>` : esc(l); }).join('\n');
const clock = (t) => (t ? new Date(t).toTimeString().slice(0, 5) : '');
const span = (ms) => { const m = Math.max(1, Math.round(ms / 60e3)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };
// A long note shows its first sentence; the rest opens on a click.
const brief = (text) => { const t = String(text ?? ''); const m = /^(.{40,180}?[.;:])\s+(.+)$/s.exec(t);
  return t.length > 180 && m ? `${esc(m[1])} <details class="more-note"><summary>More</summary>${esc(m[2])}</details>` : esc(t); };
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const SEVERITY_ORDER = ['critical', 'major', 'minor', 'cosmetic'];
const worstFirst = (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || String(a.id).localeCompare(String(b.id), undefined, { numeric: true });
// Red only for what failed; amber for what waits on a person; indigo for work under way.
// The words a reader sees for each state; the data keeps its own names, which other scripts read.
const SAY = { 'Fixed and proven': 'Fixed and verified', 'Fix did not hold': "Fix didn't work", 'Fix made, being checked': 'Fixed, being tested',
  'Fix made, waiting for proof': 'Fixed, waiting for its test', 'Fix made, could not be proven': "Fixed, test didn't finish", 'Fix made, change missing': 'Fixed, change missing', 'Fix not requested': 'Not fixed' };
const said = (state) => SAY[state] ?? state;
// The filter's groups, by what you do with a bug.
const statusOf = (b) => (b.ask === 'retest' ? 'retest' : b.state === 'Fixed and proven' && !b.needsYou ? 'fixed' : /^Fix made|^Not attempted/.test(b.state) ? 'work' : b.ask === 'decide' ? 'need' : 'left');
const KIND_SAY = { bug: 'Broken', usability: 'Hard to use', visual: 'Looks wrong', copy: 'Wording', accessibility: 'Accessibility', performance: 'Slow', security: 'Security', gap: 'Missing feature' };
// A row of buttons that shows only some cards: by what you do with them, and by kind when there is more than one.
function filterBar(d) {
  // Only what is not one of your decisions: those are above, one at a time.
  const bugs = d.bugs.filter((b) => b.ask !== 'decide'); const tests = d.promises.filter((p) => p.ask !== 'decide');
  const count = (st) => bugs.filter((b) => statusOf(b) === st).length;
  const rows = [['all', 'All', bugs.length + tests.length], ['fixed', 'Fixed', count('fixed')], ['work', 'In progress', count('work')],
    ['retest', "Couldn't be checked", count('retest')], ['left', 'Not fixed', count('left')], ['test', 'Tests', tests.length]].filter(([v, , k]) => k || v === 'all');
  const kinds = [...new Set(bugs.map((b) => b.kind ?? 'bug'))];
  const button = (f, v, label, k) => `<button type="button" data-f="${f}" data-v="${esc(v)}" aria-pressed="${v === 'all'}">${esc(label)}${k === null ? '' : ` <span class="n">${k}</span>`}</button>`;
  if (rows.length < 3 && kinds.length < 2) return '';
  return `<nav class="filter" aria-label="Show only">${rows.map(([v, label, k]) => button('status', v, label, k)).join('')}${kinds.length > 1
    ? `<span class="by">Kind:</span>${button('kind', 'all', 'Any', null)}${kinds.map((x) => button('kind', x, KIND_SAY[x] ?? x, bugs.filter((b) => (b.kind ?? 'bug') === x).length)).join('')}` : ''}</nav>`;
}
// One decision at a time: Back and Next move through them, and the place survives the live page's refresh. "Show all at once"
// lists them all. Without scripts, they are all listed.
const STEP_SCRIPT = `<script>
(function () {
  var sec = document.getElementById('decisions'); if (!sec) return;
  var li = [].slice.call(sec.querySelectorAll('.todo > li')); if (li.length < 2) return;
  var key = 'step:' + location.pathname, at = 0, all = false, prog = sec.querySelector('.progress'), nav = sec.querySelector('.step-nav');
  try { at = Number(sessionStorage.getItem(key)) || 0; } catch (e) {}
  var show = function () {
    at = Math.max(0, Math.min(at, li.length - 1));
    li.forEach(function (x, i) { x.hidden = !all && i !== at; var d = x.querySelector('details.bug'); if (d && i === at) d.open = true; });
    prog.hidden = all; nav.hidden = false; prog.querySelector('.at').textContent = at + 1;
    nav.querySelector('.back').disabled = all || at === 0;
    var next = nav.querySelector('.next'); next.hidden = all; next.textContent = at === li.length - 1 ? 'Done: copy your answers' : 'Next decision';
    nav.querySelector('.all').textContent = all ? 'One at a time' : 'Show all at once';
    try { sessionStorage.setItem(key, String(at)); } catch (e) {}
  };
  nav.addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    if (b.classList.contains('back')) at -= 1;
    else if (b.classList.contains('next')) { if (at === li.length - 1) { var c = document.getElementById('copy-answers'); if (c) { c.click(); c.focus(); } return; } at += 1; sec.scrollIntoView({ block: 'start' }); }
    else all = !all;
    show();
  });
  show();
})();
</script>`;
const FILTER_SCRIPT = `<script>
(function () {
  var bar = document.querySelector('.filter'); if (!bar) return;
  var key = 'filter:' + location.pathname, st = { status: 'all', kind: 'all' };
  try { st = JSON.parse(sessionStorage.getItem(key)) || st; } catch (e) {}
  var all = function (q) { return [].slice.call(document.querySelectorAll(q)); };
  var apply = function () {
    all('.rest details.bug').forEach(function (c) { c.hidden = !((st.status === 'all' || c.dataset.status === st.status) && (st.kind === 'all' || c.dataset.kind === st.kind)); });
    var on = st.status !== 'all' || st.kind !== 'all';
    all('.rest details.group').forEach(function (g) { var any = g.querySelector('details.bug:not([hidden])'); g.hidden = !any; if (on && any && g.tagName === 'DETAILS') g.open = true; });
    all('.filter button').forEach(function (b) { b.setAttribute('aria-pressed', String(st[b.dataset.f] === b.dataset.v)); });
    try { sessionStorage.setItem(key, JSON.stringify(st)); } catch (e) {}
  };
  bar.addEventListener('click', function (e) { var b = e.target.closest('button'); if (!b) return; st[b.dataset.f] = b.dataset.v; apply(); });
  apply();
})();
</script>`;
const STATE_TONE = (b) => (b.state === 'Fix did not hold' ? 'need' : b.needsYou ? 'wait' : b.state === 'Fixed and proven' ? 'good' : /^Fix made/.test(b.state) ? 'run' : 'idle');
const CHECK_TONE = { proven: 'good', disproved: 'need', 'not-proven': 'wait', checking: 'run' };
const CASE_TONE = { pass: 'good', fail: 'need', blocked: 'wait' };
// What blocks shipping first: a bug new on this branch, then one already in production, then one left as it is, then a failed
// test, then one that could not run. Within each, a failed fix before a waiting one, then the worst.
const rank = (x) => (x.state === undefined ? (x.verdict === 'disproved' ? 3 : 4) : x.state === "Won't fix" ? 2 : x.fix?.inProduction === true ? 1 : 0);
const urgentFirst = (a, b) => rank(a.item) - rank(b.item) || ['need', 'wait'].indexOf(a.tone) - ['need', 'wait'].indexOf(b.tone) || worstFirst(a.item, b.item);

// A bug's road as events: found, the fix, the proof, and a decision still open. Each has a tone and, when known, a time.
function events(b) {
  const fix = b.fix ?? {};
  const t = b.times ?? {};
  const out = [{ tone: 'good', text: 'Found', short: 'found', at: t.found }];
  if (DONE.includes(fix.status)) out.push({ tone: 'good', text: 'Fix made', short: 'fixed', at: t.fixed, by: true });
  else if (fix.status === 'not-fixed') out.push({ tone: 'need', text: 'Tried, then undone', short: 'fix undone', at: t.fixed });
  else if (fix.status === 'needs-decision') out.push({ tone: 'wait', text: 'Waiting for your decision', short: 'waiting for your decision', open: true });
  else if (fix.status === 'wont-fix') out.push({ tone: 'idle', text: "Won't fix", short: "won't fix" });
  else if (b.state === 'Not attempted yet') out.push({ tone: 'idle', text: 'Not attempted yet', short: 'not attempted yet', open: true });
  const proof = { proven: ['good', 'Test passed', 'test passed'], disproved: ['need', 'Test failed', 'test failed'], checking: ['run', 'Being tested', 'being tested'], 'not-proven': ['wait', "Test didn't finish", "test didn't finish"] }[b.proven];
  if (proof) out.push({ tone: proof[0], text: proof[1], short: proof[2], at: b.proven === 'checking' ? null : t.proof, claim: b.proofClaim });
  if (fix.decision && fix.status !== 'needs-decision') out.push({ tone: 'wait', text: 'Waiting for you', short: 'waiting for you', open: true });
  return out;
}
// The road in its own order: an undone fix comes after the proof that judged it, and a fix time later than its proof (the
// change was put back after a search) shows no time, so no step reads as coming before its cause.
const inOrder = (list) => { const undo = list.find((e) => e.short === 'fix undone'); const proof = list.find((e) => /^test |^being tested/.test(e.short));
  const out = list.filter((e) => e !== undo).map((e) => (e.short === 'fixed' && proof?.at && e.at && new Date(e.at) > new Date(proof.at) ? { ...e, at: null } : e));
  if (undo) out.splice(out.findIndex((e) => e.open) === -1 ? out.length : out.findIndex((e) => e.open), 0, undo);
  return out; };
const trail = (b) => (b.state === 'Fix not requested' ? '' : `<span class="trail">${inOrder(events(b)).map((e) => `<span class="${e.tone}">${esc(e.short)}${e.at ? ` ${e.by ? 'by ' : ''}${clock(e.at)}` : ''}</span>`).join('<span class="arrow" aria-hidden="true"> → </span>')}</span>`);

// One bug: a summary line with its road, opening into what to decide, how to see it, the change, what users get and what happened.
// "1", "1 and 2", "1, 2 and 3".
const joined = (xs) => (xs.length < 2 ? `${xs[0] ?? ''}` : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

function bugRow(b, unchecked, open = false, rounds = false) {
  const fix = b.fix ?? {};
  const t = STATE_TONE(b);
  const tried = ['fixed', 'partly-fixed', 'not-fixed'].includes(fix.status);
  // A record that names a change file which is not on disk says so, rather than hiding the change.
  const missing = fix.patch && !b.patch ? `the change file the record names, <code>${esc(b.patchNamed ?? fix.patch)}</code>, is missing` : '';
  const where = fix.status === 'not-fixed' ? (b.patch ? `Undone; the change is saved: <a href="${esc(b.patch)}" target="_blank" rel="noopener">see it</a>.` : missing ? `Undone; ${missing}.` : 'Undone; no change is left in the code.')
    : fix.commit ? `Committed as <code>${esc(fix.commit)}</code>.` : b.patch ? `Not committed yet: <a href="${esc(b.patch)}" target="_blank" rel="noopener">see the change</a>.` : missing ? `Not committed; ${missing}.` : '';
  // A recording shows the bug happen; a screenshot only where there is none.
  const shot = b.evidence.find((f) => VIDEO.test(f)) ?? b.evidence.find((f) => PICTURE.test(f));
  const others = b.evidence.filter((f) => f !== shot);
  const why = [fix.inProduction === true && 'it changes what production does', b.kind === 'security' && 'it is a security fix',
    ['medium', 'high', 'very-high'].includes(fix.risk) && `${fix.risk.replace('-', ' ')} risk${fix.riskReason ? ` (${fix.riskReason.replace(/\.$/, '').replace(/^./, (x) => x.toLowerCase())})` : ''}`].filter(Boolean);
  const kind = decideKind(b);
  const picks = kind ? field(`decide ${b.id} of ${b.at}`, `d-${b.anchor}`, `<legend class="sr">Decision for ${esc(b.label ?? b.id)}</legend>`, CHOICES[kind], '', kind === 'chosen' || b.ask !== 'decide') : '';
  const decided = fix.decided && !kind ? `<p>You decided: <b>${esc(fix.decided)}</b></p>` : '';
  const how = /^auto:/.test(fix.source ?? '') ? 'Decided automatically' : 'Added as a missing feature';
  const chose = b.chosen && !b.needsYou ? `<div class="ask asks"><b>Decided without you</b><p>${how}: <b>${esc(fix.source.replace(/^(auto|gap):\s*/, ''))}</b></p>${decided || picks}</div>` : '';
  const review = b.needsYou && b.state === 'Fixed and proven' ? `<div class="ask asks"><b>Your call</b><p>${esc(`Review this fix before you ship.${why.map((w) => ` ${w.charAt(0).toUpperCase()}${w.slice(1).replace(/\.$/, '')}.`).join('')}`)}</p>${picks}</div>` : '';
  const doubt = b.withdrawn ? `<div class="ask asks"><b>Withdrawn</b><p>${esc(`Its tester withdrew it: ${b.withdrawn}`)}</p></div>`
    : b.unconfirmed ? `<div class="ask asks"><b>Not confirmed</b><p>Its screenshot doesn't show the bug. ${brief(`Why: ${b.unconfirmed}`)}</p>${b.needsYou ? `<p>${esc(fix.decision ?? ASKED[kind] ?? '')}</p>${decided || picks}` : ''}</div>` : '';
  const question = (fix.status === 'not-fixed' && undone(fix.decision)) || (fix.decision && kind !== 'unproven' ? fix.decision : ASKED[kind]);
  const asked = question ?? fix.decision;
  const ask = doubt || review || chose || (asked || decided ? `<div class="ask asks"><b>Your call</b>${asked ? `<p>${esc(asked)}</p>` : ''}${fix.earlier && picks ? `<p class="muted">You answered before: ${esc(fix.earlier)}</p>` : ''}${picks || decided}${fix.status === 'needs-decision' ? '<p class="muted">Until you decide, it stays as it is.</p>' : ''}</div>` : '');
  const lead = fix.status === 'needs-decision' ? 'No fix made' : fix.status === 'not-fixed' ? 'Tried, then undone' : 'The fix';
  const change = b.fix ? `<section class="sec"><h4>What was changed</h4><div>
<p><b>${lead}:</b> ${esc(fix.summary)}${fix.status === 'not-fixed' && b.patch ? ` <a href="${esc(b.patch)}" target="_blank" rel="noopener">See the change</a>` : ''}</p>
${fix.files?.length ? `<p class="chips">${fix.files.map((f) => `<code>${esc(f)}</code>`).join('')}</p>` : ''}
${fix.status === 'needs-decision' || !(fix.rootCause || fix.risk || (where && tried)) ? '' : `<div class="facts">${fix.rootCause ? `<div><small>Cause</small>${esc(fix.rootCause)}</div>` : ''}
${fix.risk ? `<div><small>Risk</small>${esc(fix.risk)}${fix.riskReason ? `: ${esc(fix.riskReason)}` : ''}</div>` : ''}
${where && tried && fix.status !== 'not-fixed' ? `<div><small>Where the change is</small>${where}</div>` : ''}</div>`}
${fix.impact?.existingUsers ? `<p><b>What current users will notice:</b> ${esc(fix.impact.existingUsers)}</p>` : ''}
${b.fixedIn ? `<p>Worked on in <a href="../${esc(b.fixedIn)}/report.html">${esc(b.fixedIn)}</a>.</p>` : ''}</div></section>`
    : b.fixedIn ? `<section class="sec"><h4>What was changed</h4><p>Worked on in <a href="../${esc(b.fixedIn)}/report.html">${esc(b.fixedIn)}</a>.</p></section>` : '';
  // Whether it blocks shipping, in words near the top: a skimmer misses a chip. A new bug stops saying so once its fix is proven.
  const ships = fix.inProduction === true ? '<p class="ships">Already in the live app, so it doesn\'t block this release.</p>'
    : fix.inProduction === false && b.state !== 'Fixed and proven' ? '<p class="ships">New in this change: shipping now would add it.</p>' : '';
  const proved = b.proofClaim ? `<p>Its test: <a href="#${esc(b.proofClaim)}">${esc(b.proofClaim)}</a>.</p>` : '';
  // Open, a card is what you decide and how to see the bug; the rest waits under Details. The row's trail says what happened.
  return `<details class="bug ${t}" id="${esc(b.anchor)}" data-status="${statusOf(b)}" data-kind="${esc(b.kind ?? 'bug')}"${open ? ' open' : ''}><summary>
<span class="head"><span class="title">${esc(b.title)}</span>
<span class="id">${esc(b.label ?? b.id)}</span>${b.surface ? `<span class="where">${esc(b.surface)}</span>` : ''}${fix.inProduction === true ? '<span class="prod">already live</span>' : ''}<span class="sev ${esc(b.severity)}">${esc(b.severity ?? '')}</span>
${b.state === 'Fix not requested' ? '' : `<span class="state ${t}">${esc(said(b.state))}</span>`}</span>
${trail(b)}</summary>
<div class="file">${ask}${ships}${b.again ? `<p class="muted">Found in round ${b.round} as ${esc(b.id)}, and again in ${joined(b.again.map((a) => `round ${a.round} as ${esc(a.id)}`))}.</p>` : ''}
<details class="see"><summary>How it happens</summary><section class="sec"><div class="repro${shot ? '' : ' bare'}">
${shot ? `<figure class="shot">${shown(shot)}<figcaption>${esc(shot.split('/').pop())}${b.times?.found ? `, ${clock(b.times.found)}` : ''}</figcaption></figure>` : ''}
<div>${b.seenAs ? `<p class="seen">Seen as ${esc(b.seenAs)}</p>` : ''}${b.evidence.length ? '' : '<p class="muted">No screenshots or files were saved for this bug.</p>'}
<ol class="steps">${b.steps.map((x) => `<li>${esc(x)}</li>`).join('')}</ol></div>
<div class="vs"><div class="e"><small>Expected</small>${esc(b.expected)}</div><div class="a"><small>Actual</small>${esc(b.actual)}</div></div></div></section></details>
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
  // Counts, not case letters: a letter means nothing until the card is open.
  const why = p.cases.find((c) => c.result === 'blocked')?.note;
  const line = p.verdict === 'not-proven' && !failed.length ? `Couldn't run${why ? `: ${String(why).split(/(?<=[.;])\s/)[0].replace(/[.;]$/, '')}` : ''}`
    : [failed.length && `${failed.length} of ${p.cases.length} ${p.cases.length === 1 ? 'step' : 'steps'} failed`, blocked.length && `${blocked.length} couldn't run`, p.verdict === 'checking' && `${passed} passed so far`].filter(Boolean).join(' · ') || `${passed} of ${p.cases.length} passed`;
  const notTested = p.verdict === 'not-proven' && /^will not:/i.test(p.proof ?? '') ? `<p class="why">Not tested: ${esc(p.proof.replace(/^will not:\s*/i, '').replace(/\.?$/, '.'))}</p>` : '';
  const row = (c) => { const tone = CASE_TONE[c.result] ?? 'idle'; const files = p.evidence.filter((f) => f.case === c.id);
    return `<li><details class="case ${tone}"${['fail', 'blocked'].includes(c.result) ? ' open' : ''}><summary><b class="mark"></b>${esc(c.id)}. ${esc(c.do ?? '')}${c.bug ? ` <span class="bugid">${esc(c.bug)}</span>` : ''}</summary>
${c.expect || c.actual ? `<dl class="vs2">${c.expect ? `<dt>Expected</dt><dd>${esc(c.expect)}</dd>` : ''}${c.actual ? `<dt>Got</dt><dd class="got">${esc(c.actual)}</dd>` : ''}</dl>` : ''}${
      c.note ? `<div class="note">${c.result === 'blocked' ? 'Why it could not run' : "Tester's note"}: ${brief(c.note)}</div>` : ''}${caseEvidence(files)}</details></li>`; };
  return `<details class="bug check ${t}" id="${esc(p.id)}" data-status="${p.ask === 'decide' ? 'need' : 'test'}" data-kind="test"${open ? ' open' : ''}><summary><span class="head"><span class="state ${t}">${esc(VERDICT[p.verdict] ?? p.verdict)}</span><span class="title">${esc(p.statement)}</span><span class="id">${esc(p.id)}</span>
${p.cases.length > 1 ? `<span class="pips" role="img" aria-label="${passed} of ${p.cases.length} cases passed">${pips}</span>` : ''}</span><span class="trail">${esc(line)}</span></summary>
<div class="file">${checkAsk(p)}${notTested}<ol class="cases">${p.cases.map(row).join('')}</ol></div></details>`;
}

// The tool's unfinished work as one decision: test everything that could not be checked again, in one click.
function retestAsk(items) {
  if (!items.length) return '';
  const fixes = items.filter((x) => x.state !== undefined).length, tests = items.length - fixes;
  const what = [tests && plural(tests, "test that couldn't run", "tests that couldn't run"), fixes && plural(fixes, "fix whose test didn't finish", "fixes whose tests didn't finish")].filter(Boolean).join(' and ');
  const lines = items.map((x) => `decide ${x.id} of ${x.at}`).join('\n');
  return `<div class="ask asks retest"><b>Test again?</b><p>${esc(`${what.charAt(0).toUpperCase()}${what.slice(1)}. Nothing is wrong with them that we know of; they just need another run.`)}</p>
<fieldset data-line="retest" data-lines="${esc(lines)}"><legend class="sr">Test them again</legend>${['Test again', 'Not now'].map((a) => `<label class="pick"><input type="radio" name="retest" value="${a}"><span>${a === 'Test again' ? `Test all ${items.length} again` : 'Not now'}</span></label>`).join('')}</fieldset></div>`;
}

// A check of its own that failed or could not be proven waits on you like a bug: each choice is a chat line decide.mjs acts on.
const CHECK_CHOICES = { disproved: ['Fix the app', 'Test again', 'Drop this test'], 'not-proven': ['Test again', 'Drop this test'] };
const checkAsk = (p) => (p.fixesBug || !CHECK_CHOICES[p.verdict] ? '' : p.decided ? `<div class="ask asks"><b>Your call</b><p>You decided: <b>${esc(p.decided)}</b></p></div>`
  : `<div class="ask asks"><b>Your call</b><p>${p.verdict === 'disproved' ? 'This test failed. Fix the app, test again, or drop the test if it is wrong?' : 'This test gave no result. Test again, or drop it?'}</p>${
    field(`decide ${p.id} of ${p.at}`, `d-${p.step}-${p.id}`, `<legend class="sr">Decision for ${esc(p.id)}</legend>`, CHECK_CHOICES[p.verdict], '', p.ask !== 'decide')}</div>`);

// The page's first answer, in sentences: what happened, and whether anything waits on you.
function answer(d) {
  const c = d.counts;
  const say = [];
  const n = (state) => d.bugs.filter((b) => b.state === state).length;
  if (d.bugs.some((b) => b.state !== 'Fix not requested')) {
    // What the run got done, in one sentence: what waits on you is the list above.
    say.push(`Found ${plural(d.bugs.length, 'bug', 'bugs')}; ${n('Fixed and proven')} fixed and verified so far.`);
    if (d.live && n('Fix made, being checked')) say.push(`${plural(n('Fix made, being checked'), 'fix is', 'fixes are')} still being tested.`);
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
  // A proof with no bugs says how its tests went; a run that fixed bugs counts its tests in the list of what needs you.
  if (c.checks && !d.bugs.length) say.push(`${c.checksProven} of ${plural(c.checks, 'test', 'tests')} passed.`);
  if (!say.length) say.push(d.steps.length ? 'Nothing found yet.' : 'Nothing has run yet.');
  const asked = d.steps.flatMap((s) => s.questions).filter((q) => !q.answer).length;
  // A live run says what already waits on you, then that it is still running.
  // The decisions, each once and in the reader's words; the tool's unfinished work is one decision; a settled bug is optional.
  const decide = d.bugs.filter((b) => b.ask === 'decide'); const tests = d.promises.filter((p) => p.ask === 'decide');
  const retest = [...d.bugs, ...d.promises].filter((x) => x.ask === 'retest'); const optional = d.bugs.filter((b) => b.ask === 'optional');
  const by = (test) => decide.filter(test).length;
  const parts = [[by((b) => b.state === 'Fixed and proven'), (k) => `Review ${plural(k, 'fix', 'fixes')}`],
    [by((b) => b.state === 'Fix did not hold'), (k) => `Retry or leave ${plural(k, "fix that didn't work", "fixes that didn't work")}`],
    [by((b) => b.state === 'Fix made, change missing'), (k) => `Redo or drop ${plural(k, 'fix whose change is missing', 'fixes whose changes are missing')}`],
    [by((b) => !['Fixed and proven', 'Fix did not hold', 'Fix made, change missing'].includes(b.state)), (k) => `Decide what to do with ${plural(k, 'bug', 'bugs')}`],
    [tests.length, (k) => `Fix, retest or drop ${plural(k, 'failed test', 'failed tests')}`],
    [asked, (k) => `Answer ${plural(k, 'question', 'questions')}`],
    [retest.length, (k) => `Test again ${k === 1 ? "the 1 thing that couldn't be checked" : `the ${k} things that couldn't be checked`} (one click)`]].filter(([k]) => k).map(([k, say]) => say(k));
  // One number, the same one the answer bar counts.
  const total = c.needsYou + asked;
  const waiting = total ? `${plural(total, 'decision waits', 'decisions wait')} for you${d.live ? '' : ' before you ship'}.` : '';
  const later = optional.length ? `Optional: ${plural(optional.length, 'bug was', 'bugs were')} left as ${optional.length === 1 ? 'it is' : 'they are'}; you can still ask for a fix.` : '';
  const need = d.live ? [waiting, 'Still running.'].filter(Boolean).join(' ') : waiting || 'Ready to ship: nothing needs you.';
  const failed = d.bugs.some((b) => b.state === 'Fix did not hold') || (c.checksFailed > 0 && d.promises.some((p) => !p.fixesBug && p.verdict === 'disproved'));
  return { text: say.join(' '), need, parts: total ? parts : [], later, tone: d.live ? (waiting ? 'wait' : 'run') : failed ? 'need' : total ? 'wait' : 'good' };
}

// The page's headline as chat lines, so what a run says in chat is what its page says, count for count.
export async function headline(request) {
  const a = answer(await requestData(request));
  return [a.need, ...a.parts.map((p) => `- ${p}`), a.later].filter(Boolean);
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
    const words = `${sized ? `<span>${span(b.ms)}${b.running ? ' so far' : ''}</span>` : ''}${b.from ? `<span class="clock">${clock(b.from)}–${b.running ? 'now' : clock(b.to)}</span>` : ''}`;
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



// The answer form's fields: the skill's suggestions to pick and a field for the person's own words. Each field carries the start
// of its chat line ("answer Q-1a2b", "decide BUG-003 of <step folder>"), which the skill records. The page itself writes nothing back.
// An optional field (undoing a choice made without you) is copied like the others but never counted as waiting on you.
const field = (line, name, legend, picks, hint, optional = false) => `<fieldset data-line="${esc(line)}"${optional ? ' data-optional' : ''}>${legend}${picks.length
  ? `${hint}${picks.map((a) => `<label class="pick"><input type="radio" name="${esc(name)}" value="${esc(a)}"><span>${esc(a)}</span></label>`).join('')}` : ''}<input type="text" name="${esc(name)}-own" placeholder="${picks.length ? 'Or write your own answer' : 'Your answer'}" aria-label="Your answer to ${esc(name)}"></fieldset>`;
// A question that opens with where it comes from ("Owner decision docs/x.md:105: ...") shows the question first, the source after.
const SOURCE = /^(?:Owner decisions? )?((?:\S+\.md|spec):\d+(?: \([^)]*\))?(?:,? and (?:\S+\.md|spec):\d+(?: \([^)]*\))?)*)(?::\s*|\s+name this\.\s*)/;
const question = (note) => { const m = SOURCE.exec(note ?? ''); if (!m) return esc(note);
  const rest = note.slice(m[0].length); return `${esc(rest.charAt(0).toUpperCase() + rest.slice(1))} <span class="muted">(${esc(m[1])})</span>`; };
const askForm = (questions) => `<div class="asks">${questions.map((q) => field(`answer ${q.id}`, q.id, `<legend><code>${esc(q.id)}</code> ${question(q.note)}</legend>`, q.answers, '<p class="suggest">Suggested answers, not decided:</p>')).join('')}</div>`;
// What you can answer on a bug that waits on you; each choice is a chat line fix-and-prove acts on.
// "Not a bug" is on every bug: it works as intended. Your words in the box beside it become the reason, which later runs follow.
const CHOICES = { 'needs-decision': ['Yes, change it', 'No, keep it as it is', 'Not a bug'], 'not-fixed': ['Try again', 'Leave it as it is', 'Not a bug'], 'wont-fix': ['Fix it anyway', 'Leave it as it is', 'Not a bug'], review: ['Ship it', 'Undo the fix', 'Not a bug'], chosen: ['Undo the fix'],
  unproven: ['Test again', 'Ship it', 'Undo the fix', 'Not a bug'], other: ['Fix it', 'Leave it as it is', 'Not a bug'] };
// Every bug that waits on you gets choices, so the page never counts something you cannot answer.
// A decision answers the question it was asked: once a fix you asked for is made, its review is a new question.
const answered = (b) => b.fix?.decided && !(/^Fix(ed and proven| made)/.test(b.state) && !['Ship it', 'Undo the fix'].includes(b.fix.decided));
const decideKind = (b) => (answered(b) ? null : !b.needsYou ? (b.chosen && b.state === 'Fixed and proven' ? 'chosen' : null) : b.state === 'Fixed and proven' ? 'review'
  : b.state === 'Fix made, change missing' ? 'not-fixed' : /^Fix made/.test(b.state) ? 'unproven' : CHOICES[b.fix?.status] ? b.fix.status : 'other');
// The fixer's "The fix did not hold: <a test it broke>. Fix by hand?" in plain words, asked the way the buttons answer it.
// "The fix did not hold: X" means its own test still failed; "Broke X" means it broke another one.
const undone = (d) => { const m = /^(The fix did not hold|Broke)[:\s]+(.*?)\.?\s*(?:Fix (?:it )?by hand\?)?$/s.exec(d ?? ''); if (!m) return null;
  const what = m[2].replace(/\.$/, '');
  return m[1] === 'Broke' ? `The fix broke something else, so it was undone: "${what}". Try the fix again, or leave it?` : `The fix didn't work: its test still fails ("${what}"). Try again, or leave it?`; };
const ASKED = { unproven: 'The fix is in, but its test gave no result. Test again, ship it, or undo it?', 'wont-fix': 'It was left as it is. Fix it anyway, or leave it?',
  'not-fixed': 'No fix is in the code. Try again, or leave it?', other: 'Fix it, or leave it as it is?' };
// One bar for every answer on the page: it stays at the bottom of the screen while you pick.
const SEND = `<div class="asks send"><p class="copy"><button type="button" id="copy-answers">Copy answers</button> <span class="muted" id="copy-state" role="status">Pick answers, then copy them into chat.</span></p>
<textarea id="answer-lines" readonly rows="2" aria-label="Answers to paste in chat" placeholder="The lines to paste in chat show here."></textarea></div>`;

// Keeps picks across the live page's 5-second refresh; browser storage can be missing, so every use is guarded.
const ASK_SCRIPT = `<script>
(function () {
  var qs = [].slice.call(document.querySelectorAll('[data-line]')); if (!qs.length) return;
  var out = document.getElementById('answer-lines'), state = document.getElementById('copy-state'), key = 'answers:' + location.pathname;
  var own = function (f) { return f.querySelector('input[type=text]') || { value: '' }; };
  var radios = function (f) { return [].slice.call(f.querySelectorAll('input[type=radio]')); };
  var valueOf = function (f) { var r = f.querySelector('input[type=radio]:checked'), t = own(f).value.trim();
    if (r && r.value === 'Not a bug') return t ? 'Not a bug: ' + t : 'Not a bug';
    return t || (r ? r.value : ''); };
  var render = function () {
    // A bundle (data-lines) answers each of its lines at once; "Not now" adds none.
    out.value = qs.filter(valueOf).reduce(function (a, f) { var v = valueOf(f); return a.concat(f.dataset.lines ? (v === 'Not now' ? [] : f.dataset.lines.split('\\n').map(function (l) { return l + ': ' + v; })) : [f.dataset.line + ': ' + v]); }, []).join('\\n');
    var n = out.value ? out.value.split('\\n').length : 0;
    var need = qs.filter(function (f) { return !('optional' in f.dataset); }), done = need.filter(valueOf).length, extra = n - done;
    extra = qs.filter(valueOf).length - done;
    state.textContent = done || extra ? done + ' of ' + need.length + ' decided' + (extra ? ' (and ' + extra + ' optional)' : '') + '. Copy, then paste in chat.' : 'Pick answers, then copy them into chat.';
    var saved = {}; qs.forEach(function (f) { saved[f.dataset.line] = valueOf(f); });
    try { localStorage.setItem(key, JSON.stringify(saved)); } catch (e) {}
  };
  document.addEventListener('input', function (e) {
    var f = e.target.closest('[data-line]'); if (!f) return;
    // Words beside "Not a bug" are its reason; beside any other choice they replace it.
    var bug = f.querySelector('input[value="Not a bug"]:checked');
    if (e.target.type === 'radio') { if (e.target.value !== 'Not a bug') own(f).value = ''; } else if (!bug) radios(f).forEach(function (r) { r.checked = false; });
    var box = f.querySelector('input[type=text]'); if (box) box.placeholder = f.querySelector('input[value="Not a bug"]:checked') ? 'Why it is not a bug (optional)' : 'Or write your own answer';
    render();
  });
  try {
    var saved = JSON.parse(localStorage.getItem(key) || '{}');
    qs.forEach(function (f) { var v = saved[f.dataset.line]; if (!v) return; var m = /^Not a bug(?:: ([\\s\\S]*))?$/.exec(v); if (m) { v = 'Not a bug'; own(f).value = m[1] || ''; }
      var r = radios(f).filter(function (x) { return x.value === v; })[0]; if (r) r.checked = true; else own(f).value = v; });
  } catch (e) {}
  render();
  document.getElementById('copy-answers').addEventListener('click', function () {
    if (!out.value) { state.textContent = 'Pick or write an answer first.'; return; }
    var n = out.value.split('\\n').length, done = function () { state.textContent = 'Copied ' + n + (n === 1 ? ' answer' : ' answers') + ': paste them in chat.'; };
    var fallback = function () { out.select(); try { document.execCommand('copy'); done(); } catch (e) { out.parentNode.classList.add('show'); state.textContent = 'Select the lines below and copy them.'; } };
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
  const from = (s) => ` <span class="muted">(while ${esc({ spec: 'planning', explore: 'exploring', fix: 'fixing', proof: 'testing' }[s.kind] ?? s.name)})</span>`;
  // Each once, without tester codes ("N1: ") or a batch's leftovers, which say nothing about the app.
  const seen = new Set();
  const once = (n) => { const k = n.toLowerCase().replace(/\W+/g, ' ').trim(); if (seen.has(k)) return false; seen.add(k); return true; };
  const tested = d.steps.flatMap((s) => (s.tested ?? []).filter(once).map((n) => `${esc(n)}${from(s)}`));
  const notTested = d.steps.flatMap((s) => [...s.notCovered.map((n) => n.replace(/^[A-Z]+\d+: /, '')), ...(s.willNotProve ? [s.willNotProve] : [])]
    .filter((n) => !/^not run: batch full$/i.test(n.trim())).filter(once).map((n) => `${esc(n)}${from(s)}`));
  const list = (items) => { const ul = `<ul>${items.map((n) => `<li>${n}</li>`).join('')}</ul>`; return items.length > 4 ? `<details><summary>${items.length} items</summary>${ul}</details>` : ul; };
  const questions = d.steps.flatMap((s) => s.questions).filter((q) => !q.answer);
  const yours = d.steps.flatMap((s) => s.questions).filter((q) => q.answer);
  const asking = questions.length > 0 || d.bugs.some(decideKind) || d.promises.some((p) => p.ask);
  // Auto mode's choices are the run's, not any bug's: they fold into the banner at the top.
  // Each change auto mode chose for a bug is a choice too, linked to its card.
  const fixesChosen = d.bugs.filter((b) => /^auto:/.test(b.fix?.source ?? '')).map((b) => `<li><a href="#${esc(b.anchor)}">${esc(b.label ?? b.id)}</a>: ${esc(b.fix.source.replace(/^auto:\s*/, ''))}</li>`);
  const made = d.decisions.defaults.length + fixesChosen.length;
  const chosen = made
    ? `<details class="banner"><summary>${plural(made, 'choice', 'choices')} made automatically, without you</summary><ul>${d.decisions.defaults.map((x) => `<li>${ruling(x.text, x.kind || x.step ? from({ kind: x.kind, name: x.step }) : '')}</li>`).join('')}${fixesChosen.join('')}</ul></details>`
    : '<p class="banner">Run in auto mode: the skill made its choices without you.</p>';
  const notes = [
    d.stopped && ['The run stopped', `<p>${esc(d.stopped)}</p>`, 'need'],
    d.flaky?.length && ['Unreliable tests', `<p>Each passed once and failed once on the same code, so no fix was undone for it: ${esc(d.flaky.join(', '))}. Test it again before you trust it.</p>`, 'need'],
    yours.length && ['Your answers', `<ul>${yours.map((q) => `<li><code>${esc(q.id)}</code> ${esc(q.note)}<br>You said: <b>${esc(q.answer)}</b></li>`).join('')}</ul>`],
    tested.length && ['Tested', list(tested)],
    notTested.length && ['Not tested', list(notTested)],
  ].filter(Boolean);
  // A stopped run shows above Start here; the other notes below it, so Start here is on a phone's first screen.
  const dl = (list) => (list.length ? `<dl class="notes">${list.map(([dt, dd, cls, id]) => `<dt${id ? ` id="${id}"` : ''}${cls ? ` class="${cls}"` : ''}>${esc(dt)}</dt><dd>${dd}</dd>`).join('')}</dl>` : '');

  // What needs you, most urgent first: bugs, then checks that are not a fix's proof. One to start with, five next, the rest folded.
  // With more than one round, each card names the rounds that found its bug.
  const rounds = d.bugs.some((b) => b.round > 1 || b.again);
  const urgent = [...d.bugs.filter((b) => b.ask === 'decide').map((b) => ({ item: b, tone: STATE_TONE(b), row: (open) => bugRow(b, d.unchecked, open, rounds) })),
    ...d.promises.filter((p) => p.ask === 'decide').map((p) => ({ item: p, tone: CHECK_TONE[p.verdict], row: (open) => checkRow(p, open) }))].sort(urgentFirst);
  const retesting = [...d.bugs, ...d.promises].filter((x) => x.ask === 'retest');
  // Every decision as one step: the bugs and tests, worst first, then the questions, then the one retest. One shows at a time.
  const steps = [...urgent.map((u) => u.row(true)), ...questions.map((q) => `<div class="ask asks question">${askForm([q])}</div>`), retestAsk(retesting)].filter(Boolean);
  const decisions = steps.length ? `<section class="decisions" id="decisions"><h2>Your decisions</h2><p class="progress" hidden>Decision <b class="at">1</b> of ${steps.length}</p>
<ol class="todo">${steps.map((x, i) => `<li${i ? '' : ' class="now"'}>${x}</li>`).join('\n')}</ol>
<p class="step-nav" hidden><button type="button" class="back">Back</button> <button type="button" class="next">Next decision</button> <button type="button" class="all">Show all at once</button></p>
${questions.length ? `<p class="muted">Pick or write answers, then Copy answers and paste them in chat, or reply <code>answer ${esc(questions[0].id)}: your answer</code>. Later runs of this feature follow them.</p>` : ''}</section>` : '';
  const group = (label, rows, open = false) => (rows.length ? `<details class="group"${open ? ' open' : ''}><summary>${esc(label)} <span class="n">${rows.length}</span></summary>${rows.join('\n')}</details>` : '');
  const calm = !urgent.length;
  const rest = d.bugs.filter((b) => b.ask !== 'decide');
  // Being worked on also takes any state no other group names, so every bug has a card.
  const settled = ['Fixed and proven', 'Fix not requested', "Won't fix", 'Not a bug'];
  const restGroups = [
    ['In progress', rest.filter((b) => !settled.includes(b.state) && b.ask !== 'retest'), true],
    ["Couldn't be checked", rest.filter((b) => b.ask === 'retest'), false],
    ['Fixed and verified', rest.filter((b) => b.state === 'Fixed and proven'), false],
    ['Not fixed (no fix asked for)', rest.filter((b) => b.state === 'Fix not requested' && b.kind !== 'gap' && !b.unconfirmed && !b.withdrawn), calm],
    ['Missing features', rest.filter((b) => b.state === 'Fix not requested' && b.kind === 'gap' && !b.unconfirmed && !b.withdrawn), calm],
    ["Not confirmed (screenshot doesn't show it)", rest.filter((b) => b.state === 'Fix not requested' && b.unconfirmed && !b.withdrawn), false],
    ['Withdrawn', rest.filter((b) => b.state === 'Fix not requested' && b.withdrawn), false],
    ["Won't fix", rest.filter((b) => b.state === "Won't fix"), false],
    ['Not a bug', rest.filter((b) => b.state === 'Not a bug'), false],
  ].map(([label, list, open]) => [label, list.sort(worstFirst), open]);
  const bugGroups = restGroups.map(([label, list, open]) => group(label, list.map((b) => bugRow(b, d.unchecked, false, rounds)), open)).join('\n');
  const otherChecks = d.promises.filter((p) => !urgent.some((u) => u.item === p));
  const checkGroups = [
    ['Running', otherChecks.filter((p) => p.verdict === 'checking'), true],
    ['Not run', otherChecks.filter((p) => p.verdict === 'not-run'), false],
    ["Couldn't run", otherChecks.filter((p) => p.ask === 'retest'), false],
    ['Tests of the fixes', otherChecks.filter((p) => p.fixesBug && p.verdict !== 'checking'), false],
    ['Passed', otherChecks.filter((p) => !p.fixesBug && p.verdict === 'proven'), calm && !d.bugs.length],
    ['You decided', otherChecks.filter((p) => p.decided && p.verdict !== 'proven' && p.verdict !== 'checking'), false],
  ].map(([label, list, open]) => group(label, list.map((p) => checkRow(p)), open)).join('\n');

  const items = d.bugs.length ? [...urgent.filter((u) => u.item.state !== undefined).map((u) => u.item), ...restGroups.flatMap(([, list]) => list)].map((b) => [b.anchor, STATE_TONE(b), b.title, b.label])
    : d.promises.filter((p) => !p.fixesBug).sort((x, y) => ['need', 'wait', 'run', 'good', 'idle'].indexOf(CHECK_TONE[x.verdict] ?? 'idle') - ['need', 'wait', 'run', 'good', 'idle'].indexOf(CHECK_TONE[y.verdict] ?? 'idle')).map((p) => [p.id, CHECK_TONE[p.verdict] ?? 'idle', p.statement]);
  // Past 20, a cell is a small mark without its id, so a long list stays a few rows on a phone; it still links to its bug.
  const marks = items.length > 20;
  const strip = items.length ? `<div class="strip${marks ? ' marks' : ''}">${items.map(([id, t, name, label]) => { const said = esc(`${label ?? id}: ${name}`);
    return `<a class="cell ${t}${urgent[0] && (urgent[0].item.anchor ?? urgent[0].item.id) === id ? ' first' : ''}" href="#${esc(id)}" title="${said}"${marks ? ` aria-label="${said}"></a>` : `><span>${esc(label ?? id)}</span></a>`}`; }).join('')}</div>
` : '';

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
.filter{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:0 0 22px}.filter button{padding:4px 11px;border:1px solid var(--line);border-radius:999px;background:var(--sheet);color:var(--ink-2);font:600 13px/1.6 var(--sans);cursor:pointer}.filter button[aria-pressed=true]{border-color:var(--ink);background:var(--ink);color:var(--sheet)}.filter .n{font-weight:400;opacity:.75}.filter .by{margin-left:10px;color:var(--ink-3);font-size:13px}
.todo{list-style:none;margin:0;padding:0}.todo > li{margin:0 0 14px}.progress{margin:0 0 8px;color:var(--ink-2);font-weight:600}
.step-nav{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0 0}.step-nav button{padding:7px 14px;border:1px solid var(--line);border-radius:8px;background:var(--sheet);color:var(--ink);font:600 14px var(--sans);cursor:pointer}.step-nav .next{border-color:var(--run);background:var(--run);color:var(--on-run)}.step-nav button:disabled{opacity:.4;cursor:default}
.retest,.question{padding:14px 16px;border:1px solid var(--line);border-radius:12px;background:var(--sheet)}
.later{margin:4px 0 0;color:var(--ink-3);font-size:14px}
.parts{margin:6px 0 0;font-size:17px;font-weight:600;color:var(--ink)}.counts{margin:8px 0 0;font-size:14px;font-weight:600;color:var(--ink-2)}.meta{margin:10px 0 0;color:var(--ink-3);font-size:13px}.band .clock{display:block;font-size:11px}.none{color:var(--ink-3);font-style:italic}.back{margin:0 0 6px;font-size:14px}
.notes{display:grid;grid-template-columns:10em 1fr;gap:10px 20px;margin:28px 0 0;padding:16px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
.notes dt{font-weight:650}.notes dt.need{color:var(--need)}.notes dt.wait{color:var(--wait)}.notes dd{margin:0}.notes p{margin:4px 0 0}.notes ul{margin:0;padding-left:18px}.notes .suggest{color:var(--ink-3);font-size:.9em;font-style:italic}
.asks fieldset{border:0;margin:0 0 18px;padding:0;min-width:0}.asks legend{padding:0}.asks .pick{display:flex;gap:8px;align-items:baseline;margin:6px 0;padding:6px 10px;border:1px solid var(--line);border-radius:8px;background:var(--sheet);cursor:pointer}.asks .pick:has(:checked){border-color:var(--run);background:color-mix(in srgb,var(--run) 7%,var(--sheet))}.asks .pick input{flex:none;margin:0}
.asks input[type=text],.asks textarea{display:block;width:100%;margin:6px 0 0;padding:7px 10px;border:1px solid var(--line);border-radius:8px;background:var(--sheet);color:var(--ink);font:inherit}.asks textarea{font:13px/1.5 var(--mono);resize:vertical}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}.ask .asks,.ask fieldset{margin:8px 0 0}
.send{position:sticky;bottom:0;margin:24px 0 0;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--sheet);box-shadow:0 -2px 10px rgb(0 0 0/.06)}.send textarea{margin-top:8px}.send textarea{display:none}.send.show textarea{display:block}
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
.see .sec{grid-template-columns:1fr}.sec>h4{margin:0;padding-top:2px;font:650 14px var(--sans);color:var(--ink-3)}.sec p{margin:0 0 6px}
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
.ships{margin:12px 0 0;font-weight:650}details.more{border-top:1px solid var(--line);margin:0}details.see>summary,details.more>summary{display:flex;align-items:center;gap:8px;width:fit-content;padding:10px 0;font-weight:650;color:var(--run)}details.see>summary:hover,details.more>summary:hover{text-decoration:underline;text-underline-offset:3px}details.see>summary::before,details.more>summary::before{content:"";width:6px;height:6px;margin:0 2px;border:solid currentColor;border-width:0 2px 2px 0;transform:rotate(-45deg);transition:transform .15s}details.see[open]>summary::before,details.more[open]>summary::before{transform:rotate(45deg)}details.more>.sec:first-of-type{border-top:0}details.more>p{margin:0 0 8px}
.check .file>p{margin:10px 0 0}.why{color:var(--ink-2)}
ol.cases{list-style:none;margin:10px 0 4px;padding:0}ol.cases>li{border-top:1px solid var(--line)}ol.cases>li:first-child{border-top:0}
details.case{margin:0}details.case>summary{display:flex;gap:8px;align-items:baseline;padding:10px 0;font-weight:600}details.case[open]>summary{padding-bottom:4px}
.mark{flex:none;width:16px;height:16px;border-radius:50%;background:var(--tone);color:#fff;font:700 11px/16px var(--sans);text-align:center;align-self:center}.good .mark::before{content:"✓"}.need .mark::before{content:"✕"}.wait .mark::before,.idle .mark::before{content:"–"}.idle .mark{background:var(--line);color:var(--ink-3)}
.bugid{margin-left:auto;font:600 12px var(--mono);color:var(--need);white-space:nowrap}
dl.vs2{display:grid;grid-template-columns:max-content 1fr;gap:4px 12px;margin:6px 0 0 24px;font-size:15px}dl.vs2 dt{color:var(--ink-3);font-size:13px;font-weight:650;padding-top:2px}dl.vs2 dd{margin:0}details.case.need dd.got{color:var(--need)}
.case .note{margin:10px 0 0 24px;padding:8px 12px;border-radius:8px;background:var(--tint-wait);font-size:14px}.more-note{display:inline}.more-note summary{display:inline;cursor:pointer;color:var(--run)}.more-note[open] summary{display:none}
.calls-head,.console{margin:10px 0 0 24px;font-size:13px;color:var(--ink-3)}ul.calls{margin:4px 0 0 24px;padding:0;list-style:none;font:13px/1.5 var(--mono)}ul.calls li{padding:2px 0}
figure.ev{margin:10px 0 0 24px}figure.ev img,figure.ev video{display:block;width:100%;max-height:420px;object-fit:contain;border:1px solid var(--line);border-radius:8px;background:var(--soft)}figure.ev figcaption{margin-top:4px;font-size:13px;color:var(--ink-3)}
details.files{margin:8px 0 10px 24px}details.files>summary{font-size:13px;color:var(--ink-3)}details.files>summary::before{content:"+ "}details.files[open]>summary::before{content:"− "}details.files ul{margin:4px 0 0;padding-left:18px;font-size:13px}details.files img,details.files video{max-width:160px;max-height:100px;vertical-align:middle}
footer{margin-top:40px}footer details{border-top:1px solid var(--line);margin:0}footer summary{padding:12px 0;font-weight:650;color:var(--ink-2)}footer summary::before{content:"+";display:inline-block;width:1.2em;color:var(--ink-3)}footer details[open]>summary::before{content:"−"}footer ul{margin:0 0 12px;padding-left:20px}
.brief{white-space:pre-line;margin:0 0 12px}.muted{color:var(--ink-3)}
@media (max-width:640px){.sec{grid-template-columns:1fr}.repro{grid-template-columns:1fr}.repro .shot{order:3}.shot img,.shot video{height:160px;width:auto;max-width:100%}.vs{grid-template-columns:1fr}.notes{grid-template-columns:1fr}.band span,.band .clock{display:none}.file{padding:4px 14px 14px}}
</style></head><body><main>
<header>
${d.hasIndex ? '<p class="back"><a href="../../index.html">All requests</a></p>\n' : ''}<p class="kick"><b>${esc(d.feature)}</b>, ${esc((KIND[d.kind] ?? d.kind ?? '').toLowerCase())}, started ${esc(started)}${d.testedOn?.env ? `, on ${esc(d.testedOn.env)}` : ''}.</p>
${!d.auto && d.approvedByPerson ? '<p class="kick">The tests were approved by a person before testing.</p>\n' : ''}<h1 class="${a.tone}">${esc(a.need)}</h1>
${a.parts.length ? `<ul class="parts">${a.parts.map((x) => `<li>${/^Answer \d/.test(x) ? `<a href="#decisions">${esc(x)}</a>` : esc(x)}</li>`).join('')}</ul>\n` : ''}${a.later ? `<p class="later">${esc(a.later)}</p>\n` : ''}<p class="sub">${esc(a.text)}</p>
${strip}
${d.live ? ribbon(d) : ''}
<p class="meta"${d.testedOn?.commit ? ` title="Code tested: ${esc(d.testedOn.commit)}"` : ''}>${d.live ? `Live · updated ${esc(clock(d.updatedAt))}` : `Updated ${esc(when(d.updatedAt))}`}</p>
</header>
${dl(notes.filter(([, , cls]) => cls === 'need'))}
${decisions}
${d.auto ? `${chosen}\n` : ''}${dl(notes.filter(([, , cls]) => cls !== 'need'))}
${bugGroups.trim() || checkGroups.trim() ? `<section class="rest"><h2>${steps.length ? 'Everything else' : d.bugs.length ? 'Bugs' : 'Tests'}</h2>${filterBar(d)}${bugGroups}\n${checkGroups}</section>` : ''}
<footer>
${d.releaseNotes.length ? `<details><summary>For the release notes</summary><ul>${d.releaseNotes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></details>` : ''}
${d.learnings.length ? `<details><summary>What the testers learned about the app (${d.learnings.length})</summary><ul>${d.learnings.map((l) => `<li>${esc(l.learning)}<br><span class="muted">${[l.by, l.source].filter(Boolean).map(esc).join(' · ')}</span></li>`).join('')}</ul></details>` : ''}
${d.live ? '' : `<details><summary>How long each stage took</summary>${ribbon(d)}</details>`}
${d.brief ? `<details><summary>What was asked</summary><p class="brief">${plainBrief(d.brief)}</p></details>` : ''}
${d.problems.length ? `<details><summary>Run log (${plural(d.problems.length, 'note', 'notes')})</summary><p class="muted">For auditing the run; the results above already allow for these.</p><ul>${d.problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></details>` : ''}
</footer>
${asking ? SEND : ''}
</main>${asking ? `\n${ASK_SCRIPT}` : ''}${filterBar(d) ? `\n${FILTER_SCRIPT}` : ''}${steps.length > 1 ? `\n${STEP_SCRIPT}` : ''}${d.live ? `\n${LIVE_SCRIPT}` : ''}</body></html>
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
