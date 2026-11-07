// Usage: node new-bug.mjs <run folder> <slug>
//        node new-bug.mjs <run folder> --list
//        node new-bug.mjs <run folder> --duplicate <BUG-NNN> <of BUG-NNN>
//        node new-bug.mjs <run folder> --done <BUG-NNN>
//        node new-bug.mjs <run folder> --withdraw <BUG-NNN> ['<why>']
// Takes the lowest free bug number and creates <run folder>/bugs/BUG-NNN-<slug>/. Prints its id and folder.
// The number is reserved with an exclusive create of bugs/.BUG-NNN, so testers running in parallel never share one.
// --list prints the bugs filed so far, to compare with before filing, and how many count: a duplicate never does.
// --duplicate marks a bug as the same failure as an earlier one.
// --done checks bug.json (expected's shape, kind, impact, severity, found.png or found.txt for web, no picture another bug or
// an as-expected step logged),
// fills session, target, account and origin from the session's fields, and logs every file in the folder no log has yet:
// a picture or recording with the bug's actual as its note, so the evidence check compares the two. A session with no
// saved fields (a prover's) logs its files itself: --done then only checks bug.json and that every file is logged.
// --withdraw removes a bug folder --done has not logged (its number stays taken); a logged one it keeps, marked
// withdrawn with the why, for a finding the tester then saw the app discloses or a rule allows.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { notAStep, projectDir, runTargets, SHAPE } from '../../show-your-work/scripts/build-proof.mjs';
import { bugOwner, loggedFiles, loggedShas, logFiles, readFields } from './log.mjs';

// The reservation file holds the session that made the bug, so no other session writes or logs into its folder.
export function newBug(run, slug, session = '') {
  const bugs = join(run, 'bugs');
  mkdirSync(bugs, { recursive: true });
  // The same session asking again for the same slug before writing bug.json gets its own folder back, not a new number.
  const again = session && readdirSync(bugs).find((f) => f.match(/^BUG-\d+-(.+)$/)?.[1] === slug && !existsSync(join(bugs, f, 'bug.json'))
    && existsSync(join(bugs, `.${f.match(/^BUG-\d+/)[0]}`)) && readFileSync(join(bugs, `.${f.match(/^BUG-\d+/)[0]}`), 'utf8') === session);
  if (again) return { id: again.match(/^BUG-\d+/)[0], folder: join(bugs, again) };
  const taken = new Set(readdirSync(bugs).map((f) => f.match(/^\.?BUG-(\d+)/)?.[1]).filter(Boolean).map(Number));
  for (let n = 1; ; n++) {
    if (taken.has(n)) continue;
    const id = `BUG-${String(n).padStart(3, '0')}`;
    try {
      writeFileSync(join(bugs, `.${id}`), session, { flag: 'wx' });
    } catch (e) {
      if (e.code === 'EEXIST') continue;
      throw e;
    }
    const folder = join(bugs, `${id}-${slug}`);
    mkdirSync(folder);
    return { id, folder };
  }
}

const folders = (run) => existsSync(join(run, 'bugs'))
  ? readdirSync(join(run, 'bugs'), { withFileTypes: true }).filter((e) => e.isDirectory() && /^BUG-\d+/.test(e.name)).map((e) => e.name).sort()
  : [];
const readBug = (run, name) => { try { return JSON.parse(readFileSync(join(run, 'bugs', name, 'bug.json'), 'utf8')); } catch { return null; } };
const cut = (s, n = 160) => (String(s ?? '').length > n ? `${String(s).slice(0, n)}...` : String(s ?? ''));

export function listBugs(run) {
  const lines = [];
  let counted = 0;
  let duplicates = 0;
  let withdrawn = 0;
  for (const name of folders(run)) {
    const id = name.match(/^BUG-\d+/)[0];
    const bug = readBug(run, name);
    if (bug?.duplicateOf) { duplicates++; continue; }
    if (bug?.withdrawn) { withdrawn++; continue; }
    counted++;
    lines.push(bug ? `${id} ${bug.title} | expected: ${cut(bug.expected)} | actual: ${cut(bug.actual)}` : `${id} (being filed: ${name.slice(id.length + 1)})`);
  }
  const apart = [duplicates && `${duplicates} duplicate${duplicates > 1 ? 's' : ''}`, withdrawn && `${withdrawn} withdrawn`].filter(Boolean);
  lines.push(`${counted} bugs${apart.length ? ` (${apart.join(', ')} not counted)` : ''}`);
  return { lines, counted };
}

export function markDuplicate(run, id, of) {
  const name = folders(run).find((f) => f.startsWith(`${id}-`));
  const original = folders(run).find((f) => f.startsWith(`${of}-`));
  if (!name || !original || id === of) throw new Error(`no bug folder for ${!name ? id : of}, or the same bug twice`);
  const bug = readBug(run, name);
  if (!bug) throw new Error(`${name}/bug.json is missing or broken`);
  if (readBug(run, original)?.duplicateOf) throw new Error(`${of} is itself a duplicate: name the bug it duplicates`);
  writeFileSync(join(run, 'bugs', name, 'bug.json'), JSON.stringify({ ...bug, duplicateOf: of }, null, 2) + '\n');
}

const SEVERITIES = ['critical', 'major', 'minor', 'cosmetic'];
const LOW = ['minor', 'cosmetic'];
// Who the failure hurts: a label for the reader. Severity is the tester's own call.
export const IMPACTS = {
  'bypasses-named-guard': 'a refusal, limit or record an owner decision keeps is got around',
  'harms-others': 'customers, other orgs or the platform are hurt without the user choosing it; data or money lost',
  'blocks-task': 'a task the brief names cannot be done at all, with no other way',
  workaround: 'another way exists, or the app says to use another device or page',
  'owner-only': 'only the user who set it up meets it, on their own page or data',
  'customer-sees': 'customers see it look or read wrong; nothing is lost or blocked',
  looks: 'how the editor looks or reads to the user who set it up; nothing is lost or blocked',
};
const impactList = Object.entries(IMPACTS).map(([k, what]) => `${k} (${what})`).join('; ');
const SEVERITY_GUIDE = 'Major: data, money or another person is hurt, or a guard the docs keep is bypassed at real cost, or a link, file or text an outsider can put in front of customers sends them to another host or runs in their browser. Minor: a user is misled or slowed. Cosmetic: looks only. Else, when unsure, pick the lower';
const VISUAL = /\.(gif|png|jpe?g|webp|webm|mp4|mov)$/i;
const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const lines = (file) => readFileSync(file, 'utf8').split('\n').flatMap((l) => { try { return l.trim() ? [JSON.parse(l)] : []; } catch { return []; } });
// The pictures the run's logs hold for other bugs and for as-expected steps (they showed nothing wrong), by sha256.
const otherPictures = (run, id) => {
  const charters = join(run, 'charters');
  const fine = new Set((existsSync(charters) ? readdirSync(charters).filter((f) => f.endsWith('.jsonl')) : [])
    .flatMap((f) => lines(join(charters, f))).filter((s) => s.result === 'as-expected').flatMap((s) => s.files ?? []));
  return new Map(readdirSync(run).filter((f) => /^evidence(-.+)?\.jsonl$/.test(f) && f !== 'evidence-check.jsonl')
    .flatMap((f) => lines(join(run, f))).filter((r) => VISUAL.test(r.file) && (r.bug ? r.bug !== id : fine.has(r.file))).map((r) => [r.sha256, r]));
};

// The issue type ids: the project's issue-types.json, else the evidence skill's.
export function issueTypes(run) {
  const own = join(projectDir(run), 'issue-types.json');
  const file = existsSync(own) ? own : fileURLToPath(new URL('../issue-types.json', import.meta.url));
  return JSON.parse(readFileSync(file, 'utf8')).types ?? [];
}

export function finishBug(run, id) {
  const name = folders(run).find((f) => f.startsWith(`${id}-`));
  if (!name) throw new Error(`no bug folder for ${id}`);
  const bug = readBug(run, name);
  if (!bug) throw new Error(`bugs/${name}/bug.json is missing or broken`);
  const owner = bugOwner(run, id);
  if (owner && owner !== bug.session) throw new Error(`${id} is ${owner}'s bug, not ${bug.session ?? 'yours'}: file yours with new-bug.mjs <slug>, in the folder it makes`);
  if (!bug.session) throw new Error('bug.json has no session');
  // A prover's session has no fields (start.mjs saves them for explorers): its bug.json names target and account, and it
  // logs its copies itself (CAPTURE.md §5).
  let fields = null;
  try { fields = readFields(run, bug.session); } catch {}
  const done = { ...bug, id, session: bug.session, target: bug.target ?? fields?.target, account: bug.account ?? fields?.account, origin: bug.origin ?? fields?.pass };
  const found = runTargets(run)[done.target]?.found ?? [];
  const files = readdirSync(join(run, 'bugs', name)).filter((f) => f !== 'bug.json' && !f.startsWith('.'));
  const folder = join(run, 'bugs', name);
  // A file not logged yet, or rewritten since (the replay saved after --done ran): its line would not match the file.
  const logged = loggedShas(run);
  const todo = files.map((f) => `bugs/${name}/${f}`).filter((f) => logged.get(f) !== sha(join(run, f)));
  const others = otherPictures(run, id);
  const pictures = files.filter((f) => VISUAL.test(f)).map((f) => ({ f, sha: sha(join(folder, f)) }));
  const problems = [
    !done.title && 'no title',
    !done.actual && 'no actual',
    !SHAPE.test(String(done.expected ?? '')) && 'expected must start "The app", "When", "While", "Where" or "If ... then"',
    !SEVERITIES.includes(done.severity) && `severity must be one of ${SEVERITIES.join(', ')}. ${SEVERITY_GUIDE}`,
    !IMPACTS[done.impact] && `impact must be one of: ${impactList}`,
    done.impact === 'harms-others' && LOW.includes(done.severity) && `impact harms-others (${IMPACTS['harms-others']}) is major at least`,
    done.impact === 'bypasses-named-guard' && LOW.includes(done.severity) && !String(done.severityWhy ?? '').trim() && 'a bypassed guard is major when what got through reaches a customer, another org or money, also when the user who got it through is the one the guard or record exists to catch (an owner it logs for review): set severity major, or keep it with "severityWhy": one line naming who it reaches and why the guard is not there to stop the user who did it',
    done.impact === 'bypasses-named-guard' && !LOW.includes(done.severity) && !String(done.severityWhy ?? '').trim() && 'a major bypassed guard needs "severityWhy": the guard that was got around (a refusal, limit or record the docs keep), then what the person it reaches sees against what the record or log shows a reviewer (a record that shows them what that person sees catches it: minor)',
    ['customer-sees', 'looks'].includes(done.impact) && !LOW.includes(done.severity) && `impact ${done.impact} (${IMPACTS[done.impact]}) is minor at most: a major needs a guard got around (bypasses-named-guard, naming it in "severityWhy"), harm to others or a blocked task`,
    ...pictures.filter((p) => others.has(p.sha)).map((p) => `${p.f} is the same picture as ${others.get(p.sha).file} of ${others.get(p.sha).bug ?? 'an as-expected step'}: capture this bug's own`),
    !fields && todo.length && `not logged yet: ${todo.join(', ')}: log each as CAPTURE.md §1 says, with "bug": "${id}"`,
    !issueTypes(run).some((t) => t.id === done.kind) && `kind must be an issue type id: ${issueTypes(run).map((t) => t.id).join(', ')}`,
    fields && found.length && !found.some((f) => files.includes(f)) && `no ${found.join(' or ')}: capture the failure as you found it`,
  ].filter(Boolean);
  if (problems.length) throw new Error(`${id}: ${problems.join('; ')}. Nothing logged: fix bug.json and run --done again`);
  writeFileSync(join(run, 'bugs', name, 'bug.json'), JSON.stringify(done, null, 2) + '\n');
  if (!fields) return [];
  const note = (file) => (/\/found\./.test(file) ? `As found: ${done.actual}` : VISUAL.test(file) ? `Replay: ${done.actual}` : `${basename(file)} saved with the bug`);
  return logFiles(run, done.session, todo, { bug: id, note, viewport: done.viewport });
}

// A logged bug's evidence lines are append-only, so its folder stays: `why` goes into bug.json as `withdrawn`, and the
// list, the report and the chat summary leave it out of the counts and show it apart with the why.
export function withdrawBug(run, id, why = '') {
  const name = folders(run).find((f) => f.startsWith(`${id}-`));
  if (!name) throw new Error(`no bug folder for ${id}`);
  const logged = loggedFiles(run);
  if (![...logged].some((f) => f.startsWith(`bugs/${name}/`))) { rmSync(join(run, 'bugs', name), { recursive: true }); return; }
  if (!String(why).trim()) throw new Error(`${id} is logged: to withdraw it, say why: --withdraw ${id} '<what the app discloses, or the rule that allows it>'`);
  const bug = readBug(run, name);
  if (!bug) throw new Error(`bugs/${name}/bug.json is missing or broken`);
  writeFileSync(join(run, 'bugs', name, 'bug.json'), JSON.stringify({ ...bug, withdrawn: String(why).trim() }, null, 2) + '\n');
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  // --session <id> (the helper's bug passes it, last) names the session a new bug belongs to.
  const argv = process.argv.slice(2);
  const sessions = [];
  for (let s; (s = argv.indexOf('--session')) >= 0;) sessions.push(argv.splice(s, 2)[1]);
  const [run, arg, ...rest] = argv;
  // One key everywhere, the charter id: a browser session name (eval-7-Q1) that ends in a charter's id is that charter.
  let charters = [];
  try { charters = JSON.parse(readFileSync(join(resolve(run), 'charters.json'), 'utf8')).charters.map((c) => c.id); } catch {}
  const named = sessions.at(-1) ?? '';
  const session = charters.includes(named) ? named : (charters.find((c) => named.endsWith(`-${c}`)) ?? named);
  try {
    if (run && notAStep(run)) throw new Error(notAStep(run));
    if (arg === '--list' && run) console.log(listBugs(resolve(run)).lines.join('\n'));
    else if (arg === '--done' && run && rest.length === 1) {
      // A prover logs its files itself, so a count of 0 would read like a failure.
      const n = finishBug(resolve(run), rest[0]).length;
      console.log(n ? `${rest[0]}: ${n} files logged` : `${rest[0]}: done`);
    }
    else if (arg === '--withdraw' && run && (rest.length === 1 || rest.length === 2)) { withdrawBug(resolve(run), rest[0], rest[1]); console.log(`${rest[0]} withdrawn${rest[1] ? `: ${rest[1]}` : ''}`); }
    else if (arg === '--duplicate' && run && rest.length === 2) { markDuplicate(resolve(run), ...rest); console.log(`${rest[0]} is a duplicate of ${rest[1]}`); }
    else if (run && /^[a-z0-9][a-z0-9-]*$/.test(arg ?? '')) {
      const { id, folder } = newBug(resolve(run), arg, session);
      console.log(`${id} ${folder}`);
      const done = `node ${fileURLToPath(import.meta.url)} ${resolve(run)} --done ${id}`;
      // An explorer's helper names its session; a prover files from a failed case (CAPTURE.md §5).
      let foundHint = 'the failure as you found it';
      try { const f = runTargets(resolve(run))[readFields(resolve(run), session).target]?.found ?? []; if (f.length) foundHint = f.join(' or '); } catch {}
      console.log(session ? `Save ${foundHint} (the failure as you found it), network.txt and console.txt there now, and open the picture, when there is one: file only if it shows your actual, after the failure (a revert, an error) has happened. Then write bug.json, with "impact" one of: ${impactList}. Severity: ${SEVERITY_GUIDE}. Replay, and run: ${done}`
        : `Copy and log the failing case's files there, and write bug.json, as CAPTURE.md §5 says, with "impact" one of: ${impactList}. Severity: ${SEVERITY_GUIDE}. Then run: ${done}`);
      // The request's page shows the new bug; a page that cannot be written never fails the filing.
      try { await (await import(new URL('../../show-your-work/scripts/report.mjs', import.meta.url))).writeReportFor(folder); } catch {}
    }
    else {
      console.error('Usage: node new-bug.mjs <run folder> <slug of lowercase letters, digits and hyphens> [--session <id>] | --list | --duplicate <BUG-NNN> <of BUG-NNN> | --done <BUG-NNN> | --withdraw <BUG-NNN> [<why>]');
      process.exit(1);
    }
  } catch (e) {
    console.error(`Problem: ${e.message}`);
    process.exit(1);
  }
}
