// Usage: node start.mjs <run folder> <charter id> --commit <Commit line> [--log <Evidence log file>] [--session <Session id>]
// Prints what an explorer needs before its first step, in one place: the brief's first section, the charter, the
// profile, the owner decisions apart from the other learnings, the user's answers, the lookFor items of the profile's
// focus types, the charter's leads, the parts of environment.md a tester acts by, ready email addresses, and where the
// log resumes. Saves the fields every capture line of the session shares (charters/.<id>.json) for step.mjs, log.mjs
// --late and new-bug.mjs --done.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { notAStep, projectDir, runTargets } from '../../show-your-work/scripts/build-proof.mjs';
import { driverFor, fillCommand, findDefinition, methodsFor, parseDefinition } from '../../evidence/scripts/definitions.mjs';
import { fieldsFile } from '../../evidence/scripts/log.mjs';
import { issueTypes, listBugs } from '../../evidence/scripts/new-bug.mjs';
import { left, leftLine } from './step.mjs';

const read = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : null);
const jsonl = (file) => (read(file) ?? '').split('\n').flatMap((l) => { try { return l.trim() ? [JSON.parse(l)] : []; } catch { return []; } });
const section = (env, name) => env.split(/^## /m).find((s) => s.startsWith(`${name}\n`))?.slice(name.length + 1).trim() ?? '';
const line = (text, key) => text.match(new RegExp(`^- ${key}:[ \\t]*(.*)$`, 'im'))?.[1].trim() ?? null;
// A profile's focus may say `abuse`: the issue types call it `security`.
const ALIAS = { abuse: 'security' };

const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
// A tool result over 30,000 characters is written to a file in Claude Code: stay under it, or the explorer reads it back.
const MAX_OUTPUT = 28000;
// What the Helper sentence says of the web helper's functions; any other function is named only.
const DESCRIBED = {
  ab: 'ab (the browser, with your session)',
  snap: "snap (see the page: only what changed since your last look; snap -s '<selector>' for one part)",
  api: 'api (METHOD URL [JSON body] [count]: a request sent from inside the page, with its sign-in)',
};
const CAPTURE = Symbol('capture');
const BEFORE = Symbol('before');
// The ```sh block of a driver definition's `## Helper` section, or null.
export const helperOf = (definition) => definition?.sections.Helper?.match(/```sh\n([\s\S]*?)\n```/)?.[1] ?? null;

// A shell file each command of the charter sources: R (the run folder), S, the driver's own helper (its `## Helper` text,
// with <command> filled), step (step.mjs for this charter), bug (new-bug.mjs) and pick (pick.mjs), so no command repeats them.
export function writeHelper(run, id, driver, project, session = id, helper = null) {
  const scripts = fileURLToPath(new URL('.', import.meta.url));
  const evidence = fileURLToPath(new URL('../../evidence/', import.meta.url)).replace(/\/$/, '');
  const file = join(run, 'charters', `.${id}.sh`);
  // The whole session value, as environment.md may spell the app name out (acme.app-<session>).
  const command = fillCommand(driver?.command, project, session);
  writeFileSync(file, [
    `R=${sq(run)}`,
    // S: the charter's scratch folder (scripts, saved responses), so the run folder's root holds only the run's own files.
    `S=${sq(join(run, 'charters', `.${id}`))}; mkdir -p "$S"`,
    // zsh: an unquoted URL with ? and a word starting with = kill the whole chained call. bash has no setopt: ignored.
    'setopt nonomatch noequals 2>/dev/null',
    helper && helper.replaceAll('<command>', () => command).replaceAll('<evidence directory>', () => evidence),
    `step() { node ${sq(join(scripts, 'step.mjs'))} "$R" ${sq(id)} "$@"; }`,
    // bug <slug> sets B to the folder new-bug.mjs made (the first line it prints is "BUG-NNN <folder>"), so no explorer
    // names a number itself: numbers are shared by every charter running at once, and T1 has written into T9's folder.
    `bug() { local o s; o=$(node ${sq(join(evidence, 'scripts', 'new-bug.mjs'))} "$R" "$@" --session ${sq(id)}); s=$?; printf '%s\\n' "$o"; case "$1" in -*) ;; *) [ $s -eq 0 ] && B=\${o%%$'\\n'*} && B=\${B#* };; esac; return $s; }`,
    `pick() { node ${sq(join(evidence, 'scripts', 'pick.mjs'))} "$@"; }`,
  ].filter(Boolean).join('\n') + '\n');
  return file;
}

// Addresses for new accounts and invites: the pattern's <unix-time> filled with consecutive values, offset per charter so
// explorers running at once never share one.
export function addresses(pattern, charter, now = Date.now(), count = 5) {
  if (!pattern || !pattern.includes('<unix-time>')) return [];
  const base = Math.floor(now / 1000) + 1000 * Number(charter.match(/\d+/)?.[0] ?? 0);
  return Array.from({ length: count }, (_, i) => pattern.replace('<unix-time>', String(base + i)));
}

// The target a charter works on, from the step's targets.json (a step made before it, or a legacy entry, has no `files`:
// the definitions are looked up by name): its entry, the target definition, the driver ({ name, command }) and its definition.
function resolveTarget(run, project, env, target) {
  const entry = runTargets(run)[target] ?? {};
  const named = (file, kind, name) => (file && existsSync(file) ? parseDefinition(read(file), file, kind) : name ? findDefinition(kind, name, { project }) : null);
  const targetDef = named(entry.files?.target, 'target', target);
  const found = entry.driver ?? driverFor({ name: target, label: entry.label ?? targetDef?.settings.label ?? target }, env, { project });
  const driver = found.name ? { name: found.name, command: found.command } : null;
  return { entry, targetDef, driver, driverDef: driver && named(entry.files?.driver, 'driver', driver.name) };
}

// The capture rules the explorer needs: the target's Connect, Drive, Capture and Sign in, then the driver's Weak spots and Forms.
// `moving`: video or gif when the environment picks it for this target and the driver records it; each bug's retry is recorded then.
function capture(targetDef, driver, driverDef, moving) {
  const own = driverDef && [driverDef.sections['Weak spots'] && `- Weak spots: ${driverDef.sections['Weak spots']}`, driverDef.sections.Forms && (driverDef.sections.Forms.startsWith('- ') ? driverDef.sections.Forms : `- Forms: ${driverDef.sections.Forms}`)].filter(Boolean).join('\n');
  const parts = ['Connect', 'Drive', 'Capture', 'Sign in'].filter((n) => targetDef?.sections[n]).map((n) => `### ${n}\n${targetDef.sections[n]}`);
  if (own) parts.push(`### ${driver.name}\n${own}`);
  if (moving) parts.push(`### Bugs\nRecord each bug's retry (Bugs step 4) as \`$B/repro.${moving === 'gif' ? 'gif' : 'webm'}\` with your tool's ${moving} form: start just before the retry's first action, and stop once the failure has been on screen for about 2 s. Keep \`found.png\` too: it is the still a reader sees first.`);
  return parts.join('\n\n') || 'none';
}

// What the other charters did before this one started: each one with a log, the same profile's first, one line per
// step, and the bugs filed so far, so a later charter tries other parts instead of the same ones. Over `budget`
// characters the bug lines keep only their id and title (--list has the rest), then the step lines go, last charter
// first (the other profiles come last); the headings stay.
function before(run, id, profile, budget = Infinity) {
  const plan = JSON.parse(read(join(run, 'charters.json')) ?? '{}');
  const charters = (plan.charters ?? []).filter((c) => c.id !== id);
  const done = charters.map((c) => ({ c, steps: jsonl(join(run, 'charters', `${c.id}.jsonl`)) })).filter((x) => x.steps.length);
  if (!done.length) return null;
  done.sort((a, b) => Number(b.c.profile === profile) - Number(a.c.profile === profile));
  const cut = (s, n = 120) => (String(s ?? '').length > n ? `${String(s).slice(0, n)}...` : String(s ?? ''));
  const lines = done.flatMap(({ c, steps }) => [`### ${c.id} (${c.profile}${c.profile === profile ? ', your profile' : ''}, ${steps.length} steps)`,
    ...steps.map((s) => `- ${s.n} ${s.result}${s.bug ? ` ${s.bug}` : ''}: ${cut(s.action)}`)]);
  let bugs = listBugs(run).lines;
  // The planner's parts: a later charter starts on one no step above reached, so waves spread into the corners.
  const parts = plan.parts?.length ? `Parts of the feature: ${plan.parts.join('; ')}. Make one that no step above reached your first target, named in that step's action.` : null;
  const render = () => ['', '## Before you: what the other charters did and found (try other parts, states and inputs)', parts, ...lines, `Bugs so far:\n${bugs.map((l) => `- ${l}`).join('\n')}`].filter((x) => x != null).join('\n');
  if (render().length > budget) bugs = bugs.map((l) => l.replace(/ \| expected: .*$/, ''));
  for (let i = lines.length - 1; i >= 0 && render().length > budget; i--) if (lines[i].startsWith('- ')) lines.splice(i, 1);
  return render();
}

export function start(run, id, { commit, log = 'evidence.jsonl', session = id, now = Date.now() } = {}) {
  const project = projectDir(run);
  // The planner was given the step folder and wrote one level up: say where the files are and what to do, once.
  if (!existsSync(join(run, 'charters.json')) && existsSync(join(run, '..', 'charters.json'))) {
    throw new Error(`charters.json is in ${resolve(run, '..')}, the request folder, not in ${run}: the planner wrote there. Move charters.json, leads.jsonl and learnings.jsonl into ${run} and send the explorers again`);
  }
  const charter = (JSON.parse(read(join(run, 'charters.json')) ?? '{}').charters ?? []).find((c) => c.id === id);
  if (!charter) throw new Error(`no charter ${id} in charters.json`);
  const profile = (JSON.parse(read(join(project, 'tester-profiles.json')) ?? '{}').profiles ?? []).find((p) => p.id === charter.profile);
  if (!profile) throw new Error(`no profile ${charter.profile} in ${join(project, 'tester-profiles.json')}`);
  const env = read(join(project, 'environment.md')) ?? '';
  const target = charter.target ?? 'web';
  const brief = read(join(run, 'brief.md')) ?? read(join(run, '..', 'brief.md')) ?? '';
  const learnings = jsonl(join(run, 'learnings.jsonl'));
  const leads = jsonl(join(run, 'leads.jsonl'));
  const answers = [...new Map(jsonl(join(run, '..', '..', 'answers.jsonl')).filter((a) => a.id && a.answer).map((a) => [a.id, a])).values()];
  const focus = (profile.focus ?? []).map((f) => ALIAS[f] ?? f);
  // Every type's list: a match is a bug whatever the focus. The focus types come first, where most time goes.
  const types = issueTypes(run).sort((a, b) => Number(focus.includes(b.id)) - Number(focus.includes(a.id)));
  const steps = jsonl(join(run, 'charters', `${id}.jsonl`));
  const targetSection = section(env, 'Target');
  const accounts = section(env, 'Accounts');
  const { entry, targetDef, driver, driverDef } = resolveTarget(run, project, env, target);
  if (!targetDef) throw new Error(`no definition for target ${target}: ask for evidence setup to define it`);
  const tool = driver?.name ?? 'shell';
  const label = entry.label ?? targetDef?.settings.label ?? target;
  const moving = ['video', 'gif'].find((m) => methodsFor(label, env).includes(m) && driverDef?.settings.methods.includes(m));
  const url = entry.address ?? line(section(env, 'Targets'), label) ?? line(targetSection, label) ?? (target === 'web' ? line(targetSection, 'App') : null);
  // A command with no definition (a user's own `## Browser` line) still gets ab, wrapping it as it is.
  const helperText = helperOf(driverDef) ?? (!driverDef && driver?.command ? 'ab() { <command> "$@"; }' : null);
  const helper = writeHelper(run, id, driver, project, session, helperText);
  // The browser session name as the helper wrote it, kept in the fields and printed, so a run shows what each charter used.
  const browserSession = read(helper).match(/--session[ =]([^\s"')]+)/)?.[1];
  writeFileSync(fieldsFile(run, id), `${JSON.stringify({ target, tool, strength: line(section(env, 'Evidence'), 'Strength') ?? 'cross-checked', commit, env: url, log, account: charter.account, pass: charter.pass ?? 'lead', ...(browserSession && { browserSession }) })}\n`);

  const list = (items) => (items.length ? items.map((x) => `- ${x}`).join('\n') : '- none');
  const decisions = learnings.filter((l) => /^Owner decision:/.test(l.learning ?? ''));
  const facts = learnings.filter((l) => !decisions.includes(l));
  const mail = addresses(accounts.match(/^New accounts:\s*(\S+)/m)?.[1], id, now);
  const out = [
    `# Charter ${id}`,
    `Mission: ${charter.mission}`,
    `Profile: ${charter.profile} · pass: ${charter.pass ?? 'lead'} · target: ${target} · account: ${charter.account} · budget: ${charter.budget} steps`,
    entry.viewports && `Viewports, the first in full, each other in at most 5 steps: ${(charter.viewports ?? []).join(', ') || 'as the page is'}`,
    `Heuristics, one named in each step's "heuristic": ${(charter.heuristics ?? []).join('; ')}`,
    `Docs, read before your first step: ${(charter.docs ?? []).join(', ') || 'none'}`,
    charter.groundwork && `Groundwork: ${charter.groundwork}${charter.shortcut ? ' (shortcut allowed: read SHORTCUT.md next to EXPLORER.md)' : ''}`,
    '', brief.split(/^(?=## )/m).filter((s) => s.startsWith('## ')).slice(0, 1).join('').trim() || '## Brief\nnone',
    '', `## You are: ${profile.name ?? charter.profile}`,
    profile.who && `Who: ${profile.who}`, profile.knows && `Knows: ${profile.knows}`,
    profile.does?.length && `Does:\n${list(profile.does)}`, profile.judges && `Judges a problem: ${profile.judges}`,
    '', '## Owner decisions (a behaviour one names is a question, never a bug)', list(decisions.map((l) => `${l.quote ? `"${l.quote}"` : l.learning.replace(/^Owner decision:\s*/, '')} (${l.source})`)),
    '', '## How the app works (facts; they never make a behaviour right)', list(facts.map((l) => `${l.learning} (${l.source})`)),
    answers.length && `\n## The user's answers to earlier questions\n${list(answers.map((a) => `${a.note ?? a.question ?? a.id}: ${a.answer}`))}`,
    '', `## Look for: anything on these lists is a bug of that kind, unless an owner decision above names it (your focus first: ${focus.join(', ') || 'none'})`,
    ...types.map((t) => `${t.name ?? t.id} (kind "${t.id}"):\n${list(t.lookFor ?? [])}`),
    charter.leads?.length && `\n## Your leads (suspects, not bugs: try each, log its step with "lead": <n>)\n${list(charter.leads.map((n) => `${n}: ${leads[n - 1]?.learning ?? 'missing from leads.jsonl'}`))}`,
    '', '## Environment',
    `Helper: start every command with \`. ${sq(helper)};\`. It sets R (your run folder), S (your scratch folder: scripts, saved responses) and defines ${[...(helperText ?? '').matchAll(/^([A-Za-z]\w*)\(\) \{/gm)].map(([, n]) => DESCRIBED[n] ?? n).join(', ')}${helperText ? ', ' : ''}step (step.mjs for ${id}), bug (new-bug.mjs; bug <slug> sets B to the bug folder it made) and pick (pick.mjs).${/^ab\(\) \{/m.test(helperText ?? '') ? ' When your prompt or brief names another browser command, change ab in that file once, never per command.' : ''}`,
    ...['App', 'Also allowed', 'Never open'].map((k) => line(targetSection, k) && `${k}: ${line(targetSection, k)}`),
    driver?.command && `Driver: ${driver.command}`,
    browserSession && `Browser session: ${browserSession}`,
    `Accounts:\n${accounts}`,
    mail.length && `Addresses for new accounts and invites: ${mail.join(', ')}`,
    section(env, 'Emails') && `Emails:\n${section(env, 'Emails')}`,
    section(env, 'Rules') && `Rules:\n${section(env, 'Rules')}`,
    section(env, 'Gotchas') && `Gotchas:\n${section(env, 'Gotchas')}`,
    (charter.shortcut || /^Sign in:\s*setup\b/im.test(accounts)) && `Setup commands:\n${section(env, 'Setup commands')}`,
    '', CAPTURE, BEFORE,
    '', steps.length ? `## Resume: your log has ${steps.length} steps (last n ${steps.at(-1).n}). Keep its bugs and spend the rest on what is left: ${leftLine(left(run, id))}` : '## Log: no steps yet.',
  ];
  const render = (cap, bef) => out.map((x) => (x === CAPTURE ? cap : x === BEFORE ? bef : x)).filter((x) => x !== false && x != null && x !== 0 && x !== undefined).join('\n');
  const cap = `## Capture (your tool's rules; read no other capture file)\n${capture(targetDef, driver, driverDef, moving)}`;
  const bef = before(run, id, charter.profile);
  const text = render(cap, bef);
  if (text.length <= MAX_OUTPUT) return text;
  // Over the harness's cap the whole output lands in a file the explorer reads back in pieces, paying it twice: print
  // the capture rules' file instead, one read.
  const file = join(run, 'charters', `.${id}`, 'capture.md');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${cap}\n`);
  const note = `Capture rules: ${file}: read it whole in your next call, before any step; read no other capture file.`;
  if (render(note, bef).length <= MAX_OUTPUT) return render(note, bef);
  // Still over (a later wave sees every earlier charter's steps): the Before-you section keeps what fits.
  return render(note, before(run, id, charter.profile, MAX_OUTPUT - render(note, null).length));
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  const [run, id, ...rest] = process.argv.slice(2);
  const opt = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
  if (!run || !id || !opt('--commit')) {
    console.error('Usage: node start.mjs <run folder> <charter id> --commit <Commit line> [--log <Evidence log file>] [--session <Session id>]');
    process.exit(1);
  }
  try {
    if (notAStep(run)) throw new Error(notAStep(run));
    console.log(start(resolve(run), id, { commit: opt('--commit'), log: opt('--log'), session: opt('--session') }));
  } catch (e) {
    console.error(`Problem: ${e.message}`);
    process.exit(1);
  }
}
