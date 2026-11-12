import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync, renameSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { addresses, helperOf, start, writeHelper } from '../../skills/bug-bash/scripts/start.mjs';
import { addStep, finish, left } from '../../skills/bug-bash/scripts/step.mjs';
import { addMissing, checkDecisions } from '../../skills/bug-bash/scripts/decisions.mjs';
import { execFileSync } from 'node:child_process';
import { finishBug, listBugs, newBug, withdrawBug } from '../../skills/evidence/scripts/new-bug.mjs';
import { findDefinition, writeSnapshot } from '../../skills/evidence/scripts/definitions.mjs';
import { logFiles, logLate, logLines } from '../../skills/evidence/scripts/log.mjs';

const PNG = Buffer.from('89504e470d0a1a0a0000', 'hex');
const jsonl = (file) => readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

// <project>/<feature>/<request>/explore, with one blind charter, one owner decision and one fact.
function makeRun() {
  const project = join(mkdtempSync(join(tmpdir(), 'explorer-')), '.evident');
  const run = join(project, 'quotes', '2026-11-03-1404-explore', 'explore');
  mkdirSync(join(run, 'charters'), { recursive: true });
  mkdirSync(join(run, 'evidence'));
  writeFileSync(join(project, 'environment.md'), [
    '# Env', '## Target', '- App: https://app.localhost', '- Also allowed: https://api.app.localhost', '- Never open: https://app.io',
    '## Targets', '- Web: https://app.localhost', '## Browser', '`agent-browser --session x-<session>`',
    '## Evidence', '- Web: screenshots', '- Strength: cross-checked',
    '## Accounts', '| key | email |', '|---|---|', '| owner | o@example.com |', '', 'New accounts: qa+<unix-time>@example.com', 'Sign in: form https://app.localhost/login',
    '## Rules', '- Only the test store.', '## Preferences', '- Viewports: desktop 1440×900, mobile 390×844',
  ].join('\n'));
  writeFileSync(join(project, 'tester-profiles.json'), JSON.stringify({ profiles: [{ id: 'phisher', name: 'Phisher', who: 'A spammer', knows: 'Phishing', focus: ['abuse'], does: ['Pastes look-alike links'], judges: 'Any copied brand' }] }));
  writeFileSync(join(run, '..', 'brief.md'), '## Request\nQuote pages.\n\n## Documents\nspec.md\n');
  writeFileSync(join(run, 'charters.json'), JSON.stringify({ charters: [{ id: 'T5', mission: 'Explore links', profile: 'phisher', pass: 'blind', target: 'web', account: 'owner of a new Free org', viewports: ['desktop', 'mobile'], budget: 20, heuristics: ['boundaries'], docs: [], leads: [] }] }));
  writeFileSync(join(run, 'learnings.jsonl'), [
    { by: 'planner', learning: 'Owner decision: Text block links get no extra editor warning.', source: 'spec.md:57' },
    { by: 'planner', learning: 'The server rejects a business name with a link.', source: 'svc.ts:427' },
  ].map((l) => JSON.stringify(l)).join('\n'));
  writeFileSync(join(run, 'leads.jsonl'), JSON.stringify({ by: 'planner', learning: 'Risky: social links' }));
  return run;
}

test('start prints the charter, owner decisions apart from facts, the lookFor lists and addresses, and saves the fields', () => {
  const run = makeRun();
  const out = start(run, 'T5', { commit: 'abc1234', now: 1793287335000 });
  assert.match(out, /^# Charter T5/);
  assert.match(out, /## Request\nQuote pages\./);
  assert.doesNotMatch(out, /## Documents/, 'only the brief\'s first section');
  assert.match(out, /## Owner decisions[^\n]*\n- Text block links get no extra editor warning\. \(spec\.md:57\)/);
  assert.match(out, /## How the app works[^\n]*\n- The server rejects a business name with a link\./);
  assert.match(out, /your focus first: security\)\n[^\n]*\(kind "security"\)/, 'abuse is the security type, listed first');
  assert.match(out, /\(kind "gap"\)/, 'every type is listed');
  assert.doesNotMatch(out, /Risky: social links/, 'a blind charter sees no leads');
  assert.match(out, /qa\+1793292335@example\.com, qa\+1793292336@example\.com/, 'addresses offset by 1000 per charter number');
  assert.match(out, /## Log: no steps yet/);
  assert.deepEqual(JSON.parse(readFileSync(join(run, 'charters', '.T5.json'), 'utf8')),
    { target: 'web', tool: 'agent-browser', strength: 'cross-checked', commit: 'abc1234', env: 'https://app.localhost', log: 'evidence.jsonl', account: 'owner of a new Free org', pass: 'blind', browserSession: 'x-T5' });
  assert.deepEqual(addresses('qa@example.com', 'T1'), [], 'a pattern with no <unix-time> gives none');
});

test('step numbers each step, logs its captures with its actual as note, and refuses a question with no owner decision', () => {
  const run = makeRun();
  start(run, 'T5', { commit: 'abc1234' });
  writeFileSync(join(run, 'evidence', 'T5-links.png'), PNG);
  // A saved request in the scratch folder is redacted at the step; a picture there is left alone.
  mkdirSync(join(run, 'charters', '.T5'), { recursive: true });
  writeFileSync(join(run, 'charters', '.T5', 'req.json'), '{"headers":{"authorization":"Bearer eyJabcdefghij.eyJklmnopqrst.sig"}}');
  writeFileSync(join(run, 'charters', '.T5', 'c.png'), PNG);
  assert.equal(addStep(run, 'T5', JSON.stringify({ viewport: 'desktop', action: 'Save a userinfo link', expected: 'Refused', actual: 'Saved as typed', result: 'as-expected', files: ['evidence/T5-links.png'] })),
    'Step 1 at desktop: 1 of 20 steps. Viewports with no step yet: mobile. Heuristics with no step yet: boundaries.');
  assert.equal(readFileSync(join(run, 'charters', '.T5', 'req.json'), 'utf8'), '{"headers":{"authorization":"<redacted>"}}');
  assert.deepEqual(readFileSync(join(run, 'charters', '.T5', 'c.png')), PNG);
  const [line] = jsonl(join(run, 'evidence.jsonl'));
  assert.equal(line.note, 'Saved as typed');
  assert.equal(line.role, 'picture');
  assert.equal(line.method, 'agent-browser screenshot');
  assert.ok(line.sha256);
  assert.throws(() => addStep(run, 'T5', JSON.stringify({ viewport: 'desktop', action: 'a', actual: 'b', result: 'question' })), /cites the owner decision/);
  assert.throws(() => addStep(run, 'T5', JSON.stringify({ viewport: 'desktop', action: 'a', actual: 'b', result: 'bug', bug: 'BUG-009' })), /has no folder/);
  assert.throws(() => addStep(run, 'T5', JSON.stringify({ viewport: 'desktop', action: 'a', actual: 'b', result: 'as-expected', note: 'odd spacing, minor, not filed' })), /the note or actual names a problem \("odd"\)/);
  assert.throws(() => addStep(run, 'T5', JSON.stringify({ viewport: 'desktop', action: 'a', actual: 'PATCH 400; shows no error message', result: 'as-expected', note: 'toast gone?' })), /\("no error message"\)/);
  assert.throws(() => addStep(run, 'T5', JSON.stringify({ viewport: 'desktop', action: 'a', actual: 'odd spacing', result: 'as-expected', note: 'right per spec: editor is desktop work' })), /right per <doc>:<line>/, '"right per" needs a line');  assert.throws(() => addStep(run, 'T5', JSON.stringify({ viewport: 'desktop', heuristic: 'tours', action: 'a', actual: 'b', result: 'as-expected' })), /heuristic must be one of the charter's: boundaries/);
  assert.throws(() => addStep(run, 'T5', JSON.stringify({ viewport: 'desktop', action: 'Back', actual: 'not run', result: 'blocked', note: 'needs time: skipped for budget' })), /not blocked: leave it out and name it under Not covered/);
  addStep(run, 'T5', JSON.stringify({ viewport: 'mobile', action: 'a', actual: 'b', result: 'question', note: 'Owner decision: no warning' }));
  assert.deepEqual(jsonl(join(run, 'charters', 'T5.jsonl')).map((s) => s.n), [1, 2]);
});

test('return refuses under 80% of the budget unless stopped; retries see what is left', () => {
  const run = makeRun();
  start(run, 'T5', { commit: 'abc1234' });
  addStep(run, 'T5', JSON.stringify({ viewport: 'desktop', action: 'a', actual: 'b', result: 'as-expected' }));
  assert.throws(() => finish(run, 'T5'), /not done: 1 of 20 steps\. Viewports with no step yet: mobile\. Heuristics with no step yet: boundaries\. Keep exploring until step 16/);
  assert.match(finish(run, 'T5', 'app down'), /Stopped: app down/);
  assert.match(start(run, 'T5', { commit: 'abc1234' }), /## Resume: .*Heuristics with no step yet: boundaries\./);
  addStep(run, 'T5', JSON.stringify({ viewport: 'mobile', heuristic: 'Boundaries', action: 'a', actual: 'b', result: 'as-expected', note: 'right per spec.md:9, minor wording' }));
  assert.deepEqual(left(run, 'T5'), { budget: 20, steps: 2, viewports: [], heuristics: [] });
  assert.throws(() => finish(run, 'T5'), /not done: 2 of 20 steps\./, 'every heuristic and viewport tried is not the target');
  for (let i = 0; i < 14; i++) addStep(run, 'T5', JSON.stringify({ viewport: 'desktop', action: 'a', actual: 'b', result: 'as-expected' }));
  assert.match(finish(run, 'T5'), /^0 files logged late\. 16 of 20 steps\.$/);
});

test('decisions.mjs checks each quote at its line and lists rule lines and table rows no decision quotes', () => {
  const run = makeRun();
  const code = mkdtempSync(join(tmpdir(), 'code-'));
  writeFileSync(join(code, 'spec.md'), ['# Spec', '## Goals', '- Faster quotes.', '## Rules', '- **Links:** https only, no extra editor warning.', '- Business name: no links.', '| Block | Text | Look |', '|---|---|---|', '| Items | **Heading** | – |', '1. **Logos** come from the media library.', '## Left to the builder', '- How links are entered.'].join('\n'));
  writeFileSync(join(run, 'learnings.jsonl'), [
    { by: 'planner', learning: 'Owner decision: links get no warning', quote: 'Links: https only, no extra editor warning.', source: 'spec.md:5' },
    { by: 'planner', learning: 'Owner decision: names', quote: 'Business name: links allowed', source: 'spec.md:6' },
    { by: 'planner', learning: 'Owner decision: none quoted', source: 'spec.md:2' },
  ].map((l) => JSON.stringify(l)).join('\n'));
  const { problems, missing } = checkDecisions(run, code);
  assert.deepEqual(problems.map((p) => p.split(':').slice(0, 2).join(':')), ['spec.md:6', 'spec.md:2']);
  assert.deepEqual(missing, [
    { source: 'spec.md:9', quote: '| Items | **Heading** | – |', learning: 'Items. Text: **Heading**' },
    { source: 'spec.md:10', quote: '**Logos** come from the media library.', learning: '**Logos** come from the media library.' },
    { source: 'spec.md:12', quote: 'How links are entered.', learning: 'Left to the builder: How links are entered.' },
  ], 'only rule headings; a quoted or cited line, a table header and an empty cell are not listed');
  addMissing(run, missing);
  assert.deepEqual(jsonl(join(run, 'learnings.jsonl')).slice(-3).map((l) => l.learning), ['Owner decision: Items. Text: Heading', 'Owner decision: Logos come from the media library.', 'Owner decision: Left to the builder: How links are entered.']);
  assert.deepEqual(jsonl(join(run, 'learnings.jsonl')).at(-2), { by: 'planner', learning: 'Owner decision: Logos come from the media library.', quote: '**Logos** come from the media library.', source: 'spec.md:10' });
  assert.equal(checkDecisions(run, code).missing.length, 0, 'an added line passes the check');
});

test('new-bug --done for a prover, whose session saved no fields: checks bug.json and that its copies are logged, and logs nothing', () => {
  const run = makeRun();
  const { id, folder } = newBug(run, 'hex-not-expanded');
  writeFileSync(join(folder, 'bug.json'), JSON.stringify({ id, title: 'Short hex kept', impact: 'owner-only', severity: 'minor', kind: 'bug', session: '03-web-free-owner', target: 'web', account: 'free-owner', steps: ['a'], expected: 'If a typed hex color is short, then the field expands it.', actual: '#abc kept' }));
  writeFileSync(join(folder, 'C5-a-step-01.png'), PNG);
  assert.throws(() => finishBug(run, id), new RegExp(`not logged yet: bugs/${id}-hex-not-expanded/C5-a-step-01\\.png: log each as CAPTURE\\.md §1 says`));
  logLines(run, 'evidence-03-web-free-owner.jsonl', [JSON.stringify({ bug: id, file: `bugs/${id}-hex-not-expanded/C5-a-step-01.png`, note: 'copy' })]);
  assert.equal(finishBug(run, id).length, 0, 'no found.png needed: the case\'s own picture is the bug\'s');
  assert.equal(JSON.parse(readFileSync(join(folder, 'bug.json'), 'utf8')).account, 'free-owner');
});

test('new-bug --done checks bug.json, fills session fields and logs the folder; log --late logs what is left', () => {
  const run = makeRun();
  start(run, 'T5', { commit: 'abc1234' });
  const { id, folder } = newBug(run, 'social-links-any-host');
  const bug = { title: 'Social links take any host', impact: 'owner-only', severity: 'minor', kind: 'security', session: 'T5', viewport: 'desktop', steps: ['a'], expected: 'Social links take any host.', actual: 'PUT 200 stored https://paypal.com@evil.example/x' };
  writeFileSync(join(folder, 'bug.json'), JSON.stringify(bug));
  assert.throws(() => finishBug(run, id), /expected must start .*; no found\.png/);
  writeFileSync(join(folder, 'bug.json'), JSON.stringify({ ...bug, impact: 'hurts', severity: 'huge', expected: 'The app refuses a social link whose host is not the network it names, whatever the user types, on the profile page and on every quote page that shows it.' }));
  assert.throws(() => finishBug(run, id), /^Error: BUG-001: severity must be one of critical, major, minor, cosmetic\. Major: .*; impact must be one of: bypasses-named-guard .*; no found\.png/, 'a long expected passes');
  const guarded = { ...bug, expected: 'The app refuses a social link whose host is not the network it names.' };
  writeFileSync(join(folder, 'bug.json'), JSON.stringify({ ...guarded, impact: 'harms-others', severity: 'minor' }));
  assert.throws(() => finishBug(run, id), /impact harms-others .* is major at least/);
  writeFileSync(join(folder, 'bug.json'), JSON.stringify({ ...guarded, impact: 'bypasses-named-guard', severity: 'minor' }));
  assert.throws(() => finishBug(run, id), /a bypassed guard is major when .*"severityWhy"/);
  writeFileSync(join(folder, 'bug.json'), JSON.stringify({ ...guarded, impact: 'bypasses-named-guard', severity: 'minor', severityWhy: 'only the owner sees it, on their own page' }));
  assert.throws(() => finishBug(run, id), /^Error: BUG-001: no found\.png/, 'a reason keeps a low severity on a bypassed guard');
  writeFileSync(join(folder, 'bug.json'), JSON.stringify({ ...guarded, impact: 'bypasses-named-guard', severity: 'major' }));
  assert.throws(() => finishBug(run, id), /a major bypassed guard needs "severityWhy": the guard that was got around .*, then what the person it reaches sees against what the record/);
  writeFileSync(join(folder, 'bug.json'), JSON.stringify({ ...guarded, impact: 'customer-sees', severity: 'major' }));
  assert.throws(() => finishBug(run, id), /impact customer-sees .* is minor at most: a major needs a guard got around/);
  writeFileSync(join(folder, 'bug.json'), JSON.stringify({ ...guarded, severity: 'major' }));
  writeFileSync(join(folder, 'found.png'), PNG);
  writeFileSync(join(folder, 'step-01.png'), PNG);
  writeFileSync(join(folder, 'console.txt'), 'no errors\n');
  assert.equal(finishBug(run, id).length, 3, 'any severity with any impact, and a replay picture like found.png');
  rmSync(join(folder, 'step-01.png'));
  const done = JSON.parse(readFileSync(join(folder, 'bug.json'), 'utf8'));
  assert.deepEqual([done.target, done.origin, done.account], ['web', 'blind', 'owner of a new Free org']);
  const found = jsonl(join(run, 'evidence.jsonl')).find((l) => l.file.endsWith('/found.png'));
  assert.equal(found.note, `As found: ${bug.actual}`);
  assert.equal(found.bug, id);
  assert.equal(finishBug(run, id).length, 0, 'a second --done logs nothing twice');
  writeFileSync(join(folder, 'console.txt'), 'rewritten after --done\n');
  assert.equal(finishBug(run, id).length, 1, 'a file rewritten since it was logged is logged again');
  assert.equal(jsonl(join(run, 'evidence.jsonl')).filter((l) => l.file.endsWith('/console.txt')).length, 2);
  copyFileSync(join(folder, 'found.png'), join(run, 'evidence', 'T5-late.png'));
  copyFileSync(join(folder, 'found.png'), join(run, 'evidence', 'T6-other.png'));
  assert.equal(logLate(run, 'T5').length, 1, 'only the session\'s own unlogged files');
  assert.equal(jsonl(join(run, 'evidence.jsonl')).at(-1).note, 'logged late');
  assert.throws(() => withdrawBug(run, id), /is logged: to withdraw it, say why/);
  withdrawBug(run, id, 'the editor warns first');
  assert.equal(JSON.parse(readFileSync(join(folder, 'bug.json'), 'utf8')).withdrawn, 'the editor warns first', 'a logged bug stays on disk, marked');
  assert.deepEqual(listBugs(run), { lines: ['0 bugs (1 withdrawn not counted)'], counted: 0 });
  const second = newBug(run, 'same-picture');
  writeFileSync(join(second.folder, 'bug.json'), JSON.stringify({ ...bug, expected: 'The app refuses a social link whose host is not the network it names.' }));
  writeFileSync(join(second.folder, 'found.png'), PNG);
  assert.throws(() => finishBug(run, second.id), /found\.png is the same picture as bugs\/BUG-001-social-links-any-host\/[\w-]+\.png of BUG-001/);
  const shot = Buffer.concat([PNG, Buffer.from('tagline')]);
  writeFileSync(join(run, 'evidence', 'T5-tagline.png'), shot);
  addStep(run, 'T5', JSON.stringify({ viewport: 'desktop', action: 'long tagline', actual: 'kept', result: 'as-expected', files: ['evidence/T5-tagline.png'] }));
  writeFileSync(join(second.folder, 'found.png'), shot);
  assert.throws(() => finishBug(run, second.id), /found\.png is the same picture as evidence\/T5-tagline\.png of an as-expected step/);
  rmSync(join(second.folder, 'found.png'));
  writeFileSync(join(second.folder, 'found.txt'), 'POST /media 201\n');
  finishBug(run, second.id);
  assert.equal(jsonl(join(run, 'evidence.jsonl')).find((l) => l.file.endsWith(`${second.id}-same-picture/found.txt`)).note, `As found: ${bug.actual}`, 'found.txt stands for found.png, and the checker compares it with actual');
});

test('new-bug --withdraw removes an unlogged bug and keeps its number taken', () => {
  const run = makeRun();
  start(run, 'T5', { commit: 'abc1234' });
  const other = newBug(run, 'by-design');
  withdrawBug(run, other.id);
  assert.equal(existsSync(other.folder), false);
  assert.equal(newBug(run, 'next').id, 'BUG-002', 'the number stays taken');
});

test('start writes a helper every command sources: R, ab with the session, step, bug and pick', () => {
  const run = makeRun();
  assert.match(start(run, 'T5', { commit: 'abc1234' }), /Helper: start every command with `\. '.*\/charters\/\.T5\.sh';`/);
  const printed = start(run, 'T5', { commit: 'abc1234' });
  assert.match(printed, /defines ab \(the browser, with your session\), snap \(/);
  assert.match(printed, /## Capture \(your tool's rules[^]*### Connect\n- Use your driver's command under `## Drivers`[^]*### Drive\n[^]*### agent-browser\n- Weak spots/, 'the web capture rules and the tool file are printed');
  const helper = join(run, 'charters', '.T5.sh');
  const out = execFileSync('bash', ['-c', `. '${helper}'; echo "$R"; echo "$S"; type ab | grep agent-browser; step '{"result":"x"}' 2>&1 || true`], { encoding: 'utf8' });
  assert.ok(out.startsWith(`${run}\n${join(run, 'charters', '.T5')}\n`), out);
  assert.ok(existsSync(join(run, 'charters', '.T5')), 'the scratch folder exists once the helper is sourced');
  assert.match(out, /agent-browser --session x-T5 "\$@"/);
  assert.match(out, /result must be one of/, 'step runs step.mjs for T5');
  start(run, 'T5', { commit: 'abc1234', session: 'eval-7-T5' });
  assert.match(readFileSync(helper, 'utf8'), /--session x-eval-7-T5 /, '--session names the browser session; the charter id stays');
  start(run, 'T5', { commit: 'abc1234' });
});

test('start names charters.json written one level up, and keeps the Before-you section under the cap', () => {
  const run = makeRun();
  renameSync(join(run, 'charters.json'), join(run, '..', 'charters.json'));
  assert.throws(() => start(run, 'T5', { commit: 'abc1234' }), /charters\.json is in .*2026-11-03-1404-explore, the request folder, not in .*\/explore: the planner wrote there\. Move charters\.json, leads\.jsonl and learnings\.jsonl into/);
  renameSync(join(run, '..', 'charters.json'), join(run, 'charters.json'));
  const charters = JSON.parse(readFileSync(join(run, 'charters.json'), 'utf8'));
  for (const id of ['T6', 'T7', 'T8', 'T9']) charters.charters.push({ ...charters.charters[0], id });
  writeFileSync(join(run, 'charters.json'), JSON.stringify(charters));
  for (const id of ['T6', 'T7', 'T8', 'T9']) for (let n = 1; n <= 40; n++) addStep(run, id, JSON.stringify({ viewport: 'desktop', action: `Step ${n} of ${id}: ${'try a long input '.repeat(12)}`, actual: 'kept', result: 'as-expected' }));
  const { folder } = newBug(run, 'long-name', 'T6');
  writeFileSync(join(folder, 'bug.json'), JSON.stringify({ title: 'A long name is kept', expected: `The app ${'cuts it '.repeat(20)}`, actual: 'kept whole' }));
  const printed = start(run, 'T5', { commit: 'abc1234' });
  assert.ok(printed.length <= 28000, `${printed.length} characters`);
  assert.match(printed, /^Capture rules: /m, 'the capture rules went to their file first');
  assert.match(printed, /## Before you[^]*### T6 \(phisher, your profile, 40 steps\)\n- 1 as-expected: Step 1 of T6[^]*### T9 \(phisher, your profile, 40 steps\)\n[^]*Bugs so far:\n- BUG-001 A long name is kept\n- 1 bugs/, 'every charter keeps its heading; a bug keeps its id and title');
  assert.doesNotMatch(printed, /expected: The app cuts/, 'the bug line is cut to its title (--list has the rest)');
  assert.doesNotMatch(printed, /Step 40 of T9/, 'the last charter\'s last steps go first');
});

test('start over 28,000 characters moves the capture rules to charters/.<id>/capture.md and names the file', () => {
  const run = makeRun();
  const env = join(run, '..', '..', '..', 'environment.md');
  writeFileSync(env, `${readFileSync(env, 'utf8')}\n## Gotchas\n${'- A long gotcha line the planner wrote.\n'.repeat(800)}`);
  const printed = start(run, 'T5', { commit: 'abc1234' });
  const file = join(run, 'charters', '.T5', 'capture.md');
  assert.match(printed, new RegExp(`^Capture rules: ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: read it whole in your next call`, 'm'));
  assert.doesNotMatch(printed, /### Drive/, 'the rules are not printed too');
  assert.match(readFileSync(file, 'utf8'), /^## Capture \(your tool's rules[^]*### Drive\n[^]*### agent-browser\n- Weak spots/);
});

test('the helper ab drops agent-browser restore lines and keeps its exit code; api sends from inside the page', () => {
  const run = makeRun();
  start(run, 'T5', { commit: 'abc1234' });
  const bin = mkdtempSync(join(tmpdir(), 'ab-'));
  writeFileSync(join(bin, 'agent-browser'), '#!/bin/sh\necho "[agent-browser] restore: loaded; save: saved" >&2\necho "args: $*"\n[ "$3" = fail ] && exit 3\nexit 0\n');
  chmodSync(join(bin, 'agent-browser'), 0o755);
  const sh = (cmd) => execFileSync('bash', ['-c', `. '${join(run, 'charters', '.T5.sh')}'; ${cmd}`], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  assert.equal(sh('echo $AGENT_BROWSER_MAX_OUTPUT'), '8000\n', 'page output is capped');
  assert.equal(sh('ab open x; echo "s=$?"'), 'args: --session x-T5 open x\ns=0\n');
  assert.equal(sh('ab fail; echo "s=$?"'), 'args: --session x-T5 fail\ns=3\n');
  const out = sh(`api POST '/a?b=it'"'"'s' '{"n":"Café"}' 2`);
  assert.match(out, /--session x-T5 eval \(async/);
  assert.ok(out.includes(Buffer.from("/a?b=it's").toString('base64')) && out.includes(Buffer.from('{"n":"Café"}').toString('base64')), out);
  assert.match(out, /credentials:'include'/);
  assert.match(out, /length:2/);
  assert.match(out, /const b=d\(/);
  assert.doesNotMatch(out, /h=\{'content-type'/, 'a request with no body sends no content type');
  assert.equal(sh('snap -s main'), 'args: --session x-T5 snapshot -i --delta -s main\n');
  assert.equal(sh('setopt 2>/dev/null; echo ===== "a?b"'), '===== a?b\n', 'the helper survives zsh word expansion');
});

test('a bug folder belongs to the session that made it; a 500 in setup and a "right per" with no line are refused', () => {
  const run = makeRun();
  start(run, 'T5', { commit: 'abc1234' });
  const out = execFileSync('bash', ['-c', `. '${join(run, 'charters', '.T5.sh')}'; bug my-first; echo "B=$B"; bug --list > /dev/null; echo "B=$B"`], { encoding: 'utf8' });
  assert.match(out, /^BUG-001 /, 'the helper files through new-bug.mjs');
  const folderLine = `B=${join(run, 'bugs', 'BUG-001-my-first')}`;
  assert.deepEqual(out.split('\n').filter((l) => l.startsWith('B=')), [folderLine, folderLine], 'bug <slug> sets B to its folder; --list leaves it');
  assert.equal(readFileSync(join(run, 'bugs', '.BUG-001'), 'utf8'), 'T5', 'the helper passes its session');
  execFileSync('bash', ['-c', `. '${join(run, 'charters', '.T5.sh')}'; bug my-second --session eval-bb16-T5`]);
  execFileSync('node', [new URL('../../skills/evidence/scripts/new-bug.mjs', import.meta.url).pathname, run, 'my-third', '--session', 'eval-bb16-T5']);
  for (const n of ['002', '003']) assert.equal(readFileSync(join(run, 'bugs', `.BUG-${n}`), 'utf8'), 'T5', 'a browser session name that ends in the charter id is the charter');
  const { id, folder } = newBug(run, 'other', 'T9');
  assert.equal(readFileSync(join(run, 'bugs', `.${id}`), 'utf8'), 'T9');
  writeFileSync(join(folder, 'bug.json'), JSON.stringify({ title: 'x', impact: 'looks', severity: 'minor', kind: 'bug', session: 'T5', viewport: 'desktop', steps: ['a'], expected: 'The app x.', actual: 'y' }));
  assert.throws(() => finishBug(run, id), /BUG-004 is T9's bug, not T5/);
  assert.throws(() => logFiles(run, 'T5', [`bugs/${basename(folder)}/found.png`]), /is in T9's bug folder/);
  assert.throws(() => addStep(run, 'T5', JSON.stringify({ viewport: 'desktop', action: 'Sign up', actual: 'done', result: 'as-expected', note: 'setup: sign-up needed retry after a 500' })), /names a problem \("needed retry"\)/);
  assert.throws(() => addStep(run, 'T5', JSON.stringify({ viewport: 'desktop', action: 'Read the record', actual: 'outsideLinkDomains absent', result: 'as-expected', note: 'right per brief: recorded on save' })), /"right per" names the line/);
});

test('start makes the browser session name safe, and shows a later charter what the earlier ones did and found', () => {
  const run = makeRun();
  const text = helperOf(findDefinition('driver', 'agent-browser', { project: '/x' }));
  const ab = (command) => ({ name: 'agent-browser', command });
  const helper = writeHelper(run, 'T5', ab('agent-browser --session <app-name>-<session>'), '/x/acme.app/.evident', 'eval.7-T5', text);
  assert.match(readFileSync(helper, 'utf8'), /--session acme-app-eval-7-T5 /, 'a dot becomes a hyphen in both names');
  const env = join(run, '..', '..', '..', 'environment.md');
  writeFileSync(env, readFileSync(env, 'utf8').replace('`agent-browser --session x-<session>`', 'agent-browser --session x-<session>\n`<session>` is filled per session.'));
  start(run, 'T5', { commit: 'abc1234' });
  assert.match(readFileSync(helper, 'utf8'), /o=\$\(agent-browser --session x-T5 /, 'the first line is the command, with or without backticks');
  writeHelper(run, 'T5', ab('agent-browser --session qa-acme.app-<session>'), '/x/acme.app/.evident', 'eval-7-T5', text);
  assert.match(readFileSync(helper, 'utf8'), /--session qa-acme-app-eval-7-T5 /, 'a dot the environment spells out goes too');
  assert.doesNotMatch(start(run, 'T5', { commit: 'abc1234' }), /## Before you/, 'no other charter has a log yet');
  const charters = JSON.parse(readFileSync(join(run, 'charters.json'), 'utf8'));
  charters.charters.push({ ...charters.charters[0], id: 'T6', mission: 'Explore names' }, { ...charters.charters[0], id: 'T7', profile: 'noob', mission: 'Explore setup' });
  writeFileSync(join(run, 'charters.json'), JSON.stringify(charters));
  const profiles = join(run, '..', '..', '..', 'tester-profiles.json');
  writeFileSync(profiles, JSON.stringify({ profiles: [...JSON.parse(readFileSync(profiles, 'utf8')).profiles, { id: 'noob', name: 'Noob', focus: [] }] }));
  addStep(run, 'T5', JSON.stringify({ viewport: 'desktop', action: 'Paste a look-alike link into the tagline and save', actual: 'refused', result: 'as-expected' }));
  newBug(run, 'name-link', 'T5');
  addStep(run, 'T5', JSON.stringify({ viewport: 'desktop', action: 'Save a name with a link', actual: 'stored', result: 'bug', bug: 'BUG-001' }));
  start(run, 'T7', { commit: 'abc1234' });
  addStep(run, 'T7', JSON.stringify({ viewport: 'desktop', action: 'Sign up', actual: 'ok', result: 'as-expected' }));
  const printed = start(run, 'T6', { commit: 'abc1234' });
  assert.match(printed, /## Before you: what the other charters did and found[^]*### T5 \(phisher, your profile, 2 steps\)\n- 1 as-expected: Paste a look-alike link into the tagline and save\n- 2 bug BUG-001: Save a name with a link\n### T7 \(noob, 1 steps\)\n- 1 as-expected: Sign up\nBugs so far:\n- BUG-001 \(being filed: name-link\)\n- 1 bugs/, 'the same profile first, then the rest, then the bugs');
  assert.match(printed, /Browser session: x-T6\n/, 'the session name the helper holds is printed');
  assert.equal(JSON.parse(readFileSync(join(run, 'charters', '.T6.json'), 'utf8')).browserSession, 'x-T6', 'and kept in the fields');
  writeFileSync(join(run, 'charters.json'), JSON.stringify({ ...charters, parts: ['tagline', 'logo upload'] }));
  assert.match(start(run, 'T6', { commit: 'abc1234' }), /## Before you[^\n]*\nParts of the feature: tagline; logo upload\. Make one that no step above reached your first target/, 'a later wave starts on a part no step reached');
});

test('new-bug --done needs the target\'s found file, and none when the target lists none', () => {
  const run = makeRun();
  start(run, 'T5', { commit: 'abc1234' });
  const queue = (found) => writeFileSync(join(run, 'targets.json'), JSON.stringify({ targets: { queue: { label: 'Queue', provenBy: 'file', viewports: false, found } } }));
  const { id, folder } = newBug(run, 'stuck-job');
  writeFileSync(join(folder, 'bug.json'), JSON.stringify({ title: 'Job stuck', impact: 'owner-only', severity: 'minor', kind: 'bug', session: 'T5', target: 'queue', steps: ['a'], expected: 'When a job fails, the app retries it.', actual: 'Stuck' }));
  queue(['found.txt']);
  assert.throws(() => finishBug(run, id), /^Error: BUG-001: no found\.txt: capture the failure as you found it\. Nothing logged/);
  writeFileSync(join(folder, 'found.txt'), 'queue says stuck');
  assert.doesNotThrow(() => finishBug(run, id));
  const { id: id2, folder: f2 } = newBug(run, 'no-file-needed');
  writeFileSync(join(f2, 'bug.json'), JSON.stringify({ title: 'Job stuck', impact: 'owner-only', severity: 'minor', kind: 'bug', session: 'T5', target: 'queue', steps: ['a'], expected: 'When a job fails, the app retries it.', actual: 'Stuck' }));
  queue([]);
  assert.doesNotThrow(() => finishBug(run, id2));
});

test('start prints a custom target\'s sections and its driver\'s forms', () => {
  const run = makeRun();
  const project = join(run, '..', '..', '..');
  mkdirSync(join(project, 'targets')); mkdirSync(join(project, 'drivers'));
  writeFileSync(join(project, 'targets', 'queue.md'), '---\nname: queue\nlabel: Queue\naddress: Queue\ndrivers: qcli\nmethods: text\ndefault-methods: text\nproven-by: file\nviewports: no\nsession-cases: 1\nfound: none\nevidence-summary: saved output\n---\n\n## Connect\n\n- Queue connect rule.\n\n## Drive\n\n- Queue drive rule.\n');
  writeFileSync(join(project, 'drivers', 'qcli.md'), '---\nname: qcli\ntargets: queue\nmethods: text\nshell: yes\ncheck: qcli --version\nparallel: yes\ncommand: qcli --as <session>\n---\n\n## Weak spots\n\nDrops messages over 1 MB.\n\n## Forms\n\n`qcli peek <topic>`\n');
  writeFileSync(join(project, 'environment.md'), '## Target\n- App: amqp://q\n## Targets\n- Queue: amqp://q\n');
  writeFileSync(join(run, 'charters.json'), JSON.stringify({ charters: [{ id: 'T5', mission: 'Peek', profile: 'phisher', target: 'queue', account: 'a', budget: 5 }] }));
  writeSnapshot(run, project, { home: project });
  const out = start(run, 'T5', { commit: 'abc1234' });
  assert.match(out, /### Connect\n- Queue connect rule\.\n\n### Drive\n- Queue drive rule\.\n\n### qcli\n- Weak spots: Drops messages over 1 MB\.\n- Forms: `qcli peek <topic>`/);
  assert.match(out, /Driver: qcli --as <session>/);
  assert.doesNotMatch(out, /Viewports, the first/, 'a target with no viewports prints no Viewports line');
  assert.match(out, /defines step \(/, 'a driver with no helper defines nothing of its own');
  assert.equal(JSON.parse(readFileSync(join(run, 'charters', '.T5.json'), 'utf8')).tool, 'qcli');
  assert.equal(JSON.parse(readFileSync(join(run, 'charters', '.T5.json'), 'utf8')).env, 'amqp://q');
});

test('start stops for a charter whose target has no definition', () => {
  const run = makeRun();
  writeFileSync(join(run, 'charters.json'), JSON.stringify({ charters: [{ id: 'T5', mission: 'Peek', profile: 'phisher', target: 'queue', account: 'a', budget: 5 }] }));
  assert.throws(() => start(run, 'T5', { commit: 'abc1234' }), /^Error: no definition for target queue: ask for evidence setup to define it$/);
  assert.ok(!existsSync(join(run, 'charters', '.T5.json')), 'nothing written for the explorer');
});

test('start writes agent-browser\'s helper from its definition', () => {
  const run = makeRun();
  const printed = start(run, 'T5', { commit: 'abc1234' });
  assert.match(printed, /Driver: agent-browser --session x-<session>/);
  const text = readFileSync(join(run, 'charters', '.T5.sh'), 'utf8');
  for (const fn of ['ab', 'snap', 'api']) assert.match(text, new RegExp(`^${fn}\\(\\) \\{`, 'm'));
  assert.match(text, /o=\$\(agent-browser --session x-T5 "\$@" 2>&1\)/);
  assert.match(text, /node '.*\/skills\/evidence\/scripts\/pick\.mjs' -/, 'api pipes through pick.mjs where it is');
  assert.doesNotMatch(text, /<command>|<evidence directory>/);
});

test('a browser command with no definition still gets ab, and its target sections print without driver forms', () => {
  const run = makeRun();
  const env = join(run, '..', '..', '..', 'environment.md');
  writeFileSync(env, readFileSync(env, 'utf8').replace('`agent-browser --session x-<session>`', 'mybrowser --x --session <app-name>-<session>'));
  const out = start(run, 'T5', { commit: 'abc1234' });
  assert.match(readFileSync(join(run, 'charters', '.T5.sh'), 'utf8'), /^ab\(\) \{ mybrowser --x --session explorer-[A-Za-z0-9]+-T5 "\$@"; \}$/m);
  assert.doesNotMatch(readFileSync(join(run, 'charters', '.T5.sh'), 'utf8'), /^(snap|api)\(\)/m);
  assert.match(out, /defines ab \(the browser, with your session\), step \(/);
  assert.match(out, /change ab in that file once/);
  assert.match(out, /### Connect\n[^]*### Drive\n/);
  assert.doesNotMatch(out, /### mybrowser|Weak spots|- Forms:/);
});

test('start tells explorers to record each bug\'s retry as video when the environment picks video and the driver records it', () => {
  const run = makeRun();
  const env = join(run, '..', '..', '..', 'environment.md');
  assert.doesNotMatch(start(run, 'T5', { commit: 'abc1234', now: 1793287335000 }), /Record each bug's retry/, 'screenshots only: no video asked');
  writeFileSync(env, readFileSync(env, 'utf8').replace('- Web: screenshots', '- Web: video, text'));
  assert.match(start(run, 'T5', { commit: 'abc1234', now: 1793287335000 }), /### Bugs\nRecord each bug's retry \(Bugs step 4\) as `\$B\/repro\.webm`/);
});
