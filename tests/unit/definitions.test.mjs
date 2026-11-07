import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { driverFor, findDefinition, listDefinitions, methodsFor, parseDefinition, snapshot, targetsIn, writeSnapshot } from '../../skills/evidence/scripts/definitions.mjs';

const target = (name, over = {}) => {
  const s = { name, label: 'A queue', address: 'a url', drivers: 'curl, agent-browser', methods: 'a, b', 'default-methods': 'a', 'proven-by': 'file', viewports: 'no', 'session-cases': '6', found: 'found.txt', 'evidence-summary': 'text', ...over };
  return `---\n${Object.entries(s).filter(([, v]) => v !== null).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n\n## Try\nTry it.\n\n## Other\nMore.\n`;
};
const driver = (name, parallel = 'no') => `---\nname: ${name}\ntargets: api\nmethods: a\nshell: yes\ncheck: ${name} --version\nparallel: ${parallel}\ncommand: ${name} <url>\n---\n## Use\nx\n`;
const dirs = () => ({ project: mkdtempSync(join(tmpdir(), 'def-p-')), home: mkdtempSync(join(tmpdir(), 'def-h-')) });
const put = (root, kind, name, text) => { mkdirSync(join(root, kind), { recursive: true }); writeFileSync(join(root, kind, `${name}.md`), text); };

test('parseDefinition reads settings and sections', () => {
  const d = parseDefinition(target('queue'), '/x/queue.md', 'target');
  assert.equal(d.settings.provenBy, 'file');
  assert.equal(d.settings.viewports, false);
  assert.equal(d.settings.sessionCases, 6);
  assert.deepEqual(d.settings.found, ['found.txt']);
  assert.deepEqual(d.settings.drivers, ['curl', 'agent-browser']);
  assert.match(d.sections.Try, /Try it/);
  assert.deepEqual(parseDefinition(target('queue', { found: 'none' }), '/x/queue.md', 'target').settings.found, []);
});

test('parseDefinition refuses an unknown key', () => {
  assert.throws(() => parseDefinition(target('queue', { proven_by: 'file' }), '/x/queue.md', 'target'), /unknown key "proven_by"/);
});

test('parseDefinition refuses a missing key and a wrong name', () => {
  assert.throws(() => parseDefinition(target('queue', { label: null }), '/x/queue.md', 'target'), /queue\.md: missing label/);
  assert.throws(() => parseDefinition(target('queue'), '/x/other.md', 'target'), /name queue does not match the file name/);
  assert.throws(() => parseDefinition(target('queue', { 'proven-by': 'vibes' }), '/x/queue.md', 'target'), /proven-by must be picture or file/);
});

test('parseDefinition refuses a session-cases that is not a whole number of 1 or more', () => {
  for (const bad of ['', '0', '1e1', '-1', '2.5']) assert.throws(() => parseDefinition(target('queue', { 'session-cases': bad }), '/x/queue.md', 'target'), /queue\.md: session-cases must be a whole number of 1 or more/, bad);
  assert.equal(parseDefinition(target('queue', { 'session-cases': '10' }), '/x/queue.md', 'target').settings.sessionCases, 10);
});

test('parseDefinition reads parallel', () => {
  const p = (v) => parseDefinition(driver('curl', v), '/x/curl.md', 'driver').settings.parallel;
  assert.equal(p('no'), false);
  assert.equal(p('yes'), true);
  assert.equal(p('yes with --session'), '--session');
});

test('parseDefinition skips comment lines', () => {
  const text = target('queue').replace('label:', '# what this key means\n\nlabel:');
  assert.equal(parseDefinition(text, '/x/queue.md', 'target').settings.label, 'A queue');
});

test('findDefinition prefers project, then home, then built-in', () => {
  const { project, home } = dirs();
  put(join(home, '.evident'), 'targets', 'queue', target('queue', { label: 'home' }));
  put(project, 'targets', 'queue', target('queue', { label: 'project' }));
  const a = findDefinition('target', 'queue', { project, home });
  assert.equal(a.settings.label, 'project');
  assert.equal(a.source, 'project');
  rmSync(join(project, 'targets', 'queue.md'));
  const b = findDefinition('target', 'queue', { project, home });
  assert.equal(b.settings.label, 'home');
  assert.equal(b.source, 'user');
  assert.equal(findDefinition('target', 'nope', { project, home }), null);
});

test('listDefinitions marks an override of a user definition', () => {
  const { project, home } = dirs();
  put(join(home, '.evident'), 'targets', 'queue', target('queue'));
  put(project, 'targets', 'queue', target('queue', { label: 'mine' }));
  const queue = listDefinitions('target', { project, home }).filter((d) => d.name === 'queue');
  assert.equal(queue.length, 1);
  assert.equal(queue[0].source, 'project');
  assert.equal(queue[0].overrides, 'user');
});

test('listDefinitions marks an override of a built-in', () => {
  const { project, home } = dirs();
  put(project, 'targets', 'web', target('web', { label: 'mine' }));
  const web = listDefinitions('target', { project, home }).find((d) => d.name === 'web');
  assert.equal(web.source, 'project');
  assert.equal(web.overrides, 'built-in');
});

const EVIDENCE = new URL('../../skills/evidence/', import.meta.url).pathname;
const rd = (p) => readFileSync(join(EVIDENCE, p), 'utf8');

test('every built-in definition parses and has its sections', () => {
  const { project, home } = dirs();
  const targets = listDefinitions('target', { project, home });
  const drivers = listDefinitions('driver', { project, home });
  assert.deepEqual(targets.map((d) => d.name), ['api', 'web']);
  assert.deepEqual(drivers.map((d) => d.name), ['agent-browser', 'claude-in-chrome', 'curl', 'hurl']);
  for (const t of targets) for (const s of ['Connect', 'Drive', 'Capture', 'Try', 'Sign in']) assert.ok(t.sections[s], `${t.name}: ${s}`);
  for (const d of drivers) for (const s of ['Weak spots', 'Forms']) assert.ok(d.sections[s], `${d.name}: ${s}`);
  assert.ok(drivers[0].sections.Helper);
  assert.equal(drivers[0].settings.parallel, '--session');
  assert.equal(drivers[1].settings.shell, false);
});

test('templates and examples parse', () => {
  for (const [kind, files] of [['target', ['templates/target.md', 'examples/targets/cli.md']], ['driver', ['templates/driver.md', 'examples/drivers/asciinema.md']]]) {
    for (const f of files) {
      const base = f.split('/').pop().replace('.md', '');
      const text = rd(f).replace('<name>', base);
      assert.doesNotThrow(() => parseDefinition(text, join('/x', f.startsWith('templates') ? `${kind}.md` : `${base}.md`), kind), f);
    }
  }
});

// ---- environment.md snapshot ----

const cli = fileURLToPath(new URL('../../skills/evidence/scripts/definitions.mjs', import.meta.url));
const web = { name: 'web', label: 'Web' };
const api = { name: 'api', label: 'API' };

test('targetsIn matches labels and keeps unknown lines', () => {
  const o = dirs();
  const r = targetsIn('## Targets\n- Web: http://localhost:3000\n- API: none\n- CLI: acme\n\n## Browser\nx', o);
  assert.deepEqual(r.targets, [{ name: 'web', label: 'Web', address: 'http://localhost:3000' }]);
  assert.deepEqual(r.unknown, ['CLI']);
});

test('targetsIn matches ## Targets lines on each definition\'s address, not its label', () => {
  const o = dirs();
  put(o.project, 'targets', 'queue', target('queue', { label: 'Message queue', address: 'Queue' }));
  const r = targetsIn('## Targets\n- Queue: amqp://q\n- Message queue: amqp://x\n- web: http://w\n', o);
  assert.deepEqual(r.targets, [{ name: 'queue', label: 'Message queue', address: 'amqp://q' }, { name: 'web', label: 'Web', address: 'http://w' }]);
  assert.deepEqual(r.unknown, ['Message queue']);
});

test('driverFor reads the old ## Browser and tool: forms', () => {
  const o = dirs();
  const b = driverFor(web, '## Browser\n`agent-browser --no-auto-dialog --session <app-name>-<session>`\n', o);
  assert.equal(b.name, 'agent-browser');
  assert.equal(b.shell, true);
  assert.equal(b.parallel, '--session');
  assert.match(b.command, /--no-auto-dialog/);
  assert.equal(driverFor(api, '## Evidence\n- API: readable · tool: curl\n', o).name, 'curl');
  assert.equal(driverFor(api, '', o).name, 'curl');
});

test('driverFor uses a driver: line and ## Drivers', () => {
  const o = dirs();
  put(o.project, 'drivers', 'pw', driver('pw').replace('targets: api', 'targets: web'));
  const d = driverFor(web, '## Evidence\n- Web: gif, text · driver: pw\n\n## Drivers\n- pw: npx pw-cli --app <app-name>\n', o);
  assert.equal(d.name, 'pw');
  assert.equal(d.command, 'npx pw-cli --app <app-name>');
  assert.equal(methodsFor('web', '## Evidence\n- Web: gif, text · driver: pw\n').join(), 'gif,text');
});

test('driverFor accepts a browser command with no definition', () => {
  const d = driverFor(web, '## Browser\nmybrowser --x\n', dirs());
  assert.deepEqual({ ...d }, { name: 'mybrowser', command: 'mybrowser --x', shell: true, parallel: false, definition: null });
});

test('snapshot stops only for a used target with no definition', () => {
  const o = dirs();
  writeFileSync(join(o.project, 'environment.md'), '## Target\n- App: http://a\n\n## Targets\n- Web: http://a\n- CLI: acme\n');
  assert.throws(() => snapshot(o.project, { ...o, uses: ['cli'] }), /no definition for target cli/);
  const s = snapshot(o.project, o);
  assert.deepEqual(s.unknown, ['CLI']);
  assert.equal(s.targets.web.driver.name, 'agent-browser');
  assert.equal(snapshot(o.project, { ...o, uses: ['api'] }).targets.api.address, 'http://a');
});

test('snapshot motion follows ## Evidence', () => {
  const o = dirs();
  const at = (line) => { writeFileSync(join(o.project, 'environment.md'), `## Targets\n- Web: http://a\n\n## Evidence\n${line}\n`); return snapshot(o.project, o).targets.web; };
  assert.equal(at('- Web: video, text').motion, true);
  assert.equal(at('- Web: screenshots, text').motion, false);
  assert.equal(at('- Web: GIF, text').motion, true, 'the same rule as picksMotion: any case, a word anywhere');
  assert.equal(at('- Web: video (720p), text').motion, true);
  assert.equal(at('- Web: gifs, text').motion, false);
});

test('writeSnapshot and the CLI', () => {
  const o = dirs();
  writeFileSync(join(o.project, 'environment.md'), '## Targets\n- Web: http://a\n- CLI: acme\n');
  const step = mkdtempSync(join(tmpdir(), 'step-'));
  assert.equal(writeSnapshot(step, o.project, o), join(step, 'targets.json'));
  assert.equal(JSON.parse(readFileSync(join(step, 'targets.json'), 'utf8')).targets.web.label, 'Web');
  const list = execFileSync('node', [cli, o.project, '--list', 'targets'], { encoding: 'utf8' });
  assert.match(list, /^web  Web  built-in/m);
  assert.match(list, /^Warning: no definition for the ## Targets line "CLI"$/m);
  assert.doesNotMatch(execFileSync('node', [cli, o.project, '--list', 'drivers'], { encoding: 'utf8' }), /Warning/);
  assert.match(execFileSync('node', [cli, o.project, '--show', 'driver', 'curl'], { encoding: 'utf8' }), /curl\.md/);
  assert.equal(execFileSync('node', [cli, o.project, '--snapshot', step], { encoding: 'utf8' }).trim(), join(step, 'targets.json'));
  assert.equal(spawnSync('node', [cli, o.project, '--check']).status, 0);
  put(o.project, 'targets', 'bad', 'no settings');
  const bad = spawnSync('node', [cli, o.project, '--check'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /^Problem: .*bad\.md/m);
});

test('the built-in web definition keeps the legacy web rules\' evidence text', async () => {
  const { LEGACY_TARGETS } = await import('../../skills/show-your-work/scripts/build-proof.mjs');
  assert.equal(findDefinition('target', 'web', dirs()).settings.evidenceSummary, LEGACY_TARGETS('').web.evidenceSummary);
});
