import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SETUP = fileURLToPath(new URL('../../setup', import.meta.url));
const CLONE = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');

function setup(config, input, ...args) {
  return run({ CLAUDE_SKILLS_DIR: mkdtempSync(join(tmpdir(), 'skills-')), CLAUDE_AGENTS_DIR: mkdtempSync(join(tmpdir(), 'agents-')), CLAUDE_CONFIG_DIR: config }, input, ...args);
}
function run(dirs, input, ...args) {
  return spawnSync(SETUP, args, { input, env: { ...process.env, ...dirs }, encoding: 'utf8' });
}

test('setup offers to add the clone to additionalDirectories, keeps other settings, asks once, and --remove takes it back', () => {
  const config = mkdtempSync(join(tmpdir(), 'config-'));
  const file = join(config, 'settings.json');
  writeFileSync(file, JSON.stringify({ model: 'x', permissions: { allow: ['Read(//a/**)'], additionalDirectories: ['/other'] } }));
  const yes = setup(config, 'y\n');
  assert.equal(yes.status, 0, yes.stderr);
  assert.match(yes.stdout, /\[y\/N\] settings: added /);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {
    model: 'x', permissions: { allow: ['Read(//a/**)'], additionalDirectories: ['/other', CLONE] },
  });
  const again = setup(config, 'y\n');
  assert.doesNotMatch(again.stdout, /\[y\/N\]/);
  setup(config, '', '--remove');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).permissions.additionalDirectories, ['/other']);
});

test('setup changes nothing on no, on no answer, or when settings.json is not valid JSON', () => {
  const config = mkdtempSync(join(tmpdir(), 'config-'));
  const file = join(config, 'settings.json');
  assert.match(setup(config, 'n\n').stdout, /settings: not changed/);
  assert.match(setup(config, '').stdout, /settings: not changed/);
  assert.equal(existsSync(file), false);
  writeFileSync(file, '{ broken');
  const bad = setup(config, 'y\n');
  assert.match(bad.stderr, /is not valid JSON/);
  assert.equal(readFileSync(file, 'utf8'), '{ broken');
});

test('setup writes each agent with this clone\'s guard.mjs path, keeps a file it did not write, and --remove takes its own back', () => {
  const dirs = { CLAUDE_SKILLS_DIR: mkdtempSync(join(tmpdir(), 'skills-')), CLAUDE_AGENTS_DIR: mkdtempSync(join(tmpdir(), 'agents-')), CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'config-')) };
  const agents = dirs.CLAUDE_AGENTS_DIR;
  writeFileSync(join(agents, 'evident-checker.md'), 'my own');
  const r = run(dirs, 'n\n');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /skipped evident-checker: .* was not written by this setup/);
  const prover = readFileSync(join(agents, 'evident-prover.md'), 'utf8');
  assert.ok(prover.includes(`node "${CLONE}/skills/evidence/scripts/guard.mjs" --role prover`));
  assert.ok(!prover.includes('$HOME'));
  assert.equal(readFileSync(join(agents, 'evident-checker.md'), 'utf8'), 'my own');
  run(dirs, '', '--remove');
  assert.deepEqual(readdirSync(agents), ['evident-checker.md']);
});

test('setup --agents <folder> writes only the agents there, with absolute paths, and asks nothing', () => {
  const skills = mkdtempSync(join(tmpdir(), 'skills-'));
  const folder = join(mkdtempSync(join(tmpdir(), 'project-')), '.claude/agents');
  const r = run({ CLAUDE_SKILLS_DIR: skills }, '', '--agents', folder);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /\[y\/N\]|linked/);
  assert.deepEqual(readdirSync(skills), []);
  assert.deepEqual(readdirSync(folder).sort(), ['evident-checker.md', 'evident-explorer.md', 'evident-fixer.md', 'evident-prover-shell.md', 'evident-prover.md']);
  assert.ok(readFileSync(join(folder, 'evident-fixer.md'), 'utf8').includes(`${CLONE}/skills/fix-and-prove/FIXER.md`), 'the fixer names its file by the clone\'s path');
  assert.doesNotMatch(run({ CLAUDE_SKILLS_DIR: skills }, '', '--agents', folder).stderr, /skipped/, 'a second setup rewrites every agent it wrote, the fixer too');
  assert.ok(readFileSync(join(folder, 'evident-checker.md'), 'utf8').includes(`node "${CLONE}/skills/evidence/scripts/guard.mjs" --role checker`));
  assert.match(readFileSync(join(folder, 'evident-prover-shell.md'), 'utf8'), /^model: inherit$/m);
  assert.equal(run({}, '', '--agents').status, 1);
});

test('setup --model writes the named roles\' agents with that model, both prover files for prover, and leaves the rest inherit', () => {
  const folder = join(mkdtempSync(join(tmpdir(), 'project-')), '.claude/agents');
  const r = run({}, '', '--model', 'checker=haiku,prover=sonnet', '--agents', folder);
  assert.equal(r.status, 0, r.stderr);
  const model = (name) => /^model: (.*)$/m.exec(readFileSync(join(folder, `${name}.md`), 'utf8'))[1];
  assert.deepEqual(['evident-checker', 'evident-prover', 'evident-prover-shell', 'evident-explorer'].map(model), ['haiku', 'sonnet', 'sonnet', 'inherit']);
  assert.match(r.stdout, /evident-checker\.md \(model: haiku\)/);
  assert.equal(run({}, '', '--model').status, 1);
});

test('setup --codex links each skill into $CODEX_HOME/skills, writes no agents or settings, and --remove takes them back', () => {
  const home = mkdtempSync(join(tmpdir(), 'codex-'));
  const dirs = { CODEX_HOME: home, CLAUDE_SKILLS_DIR: mkdtempSync(join(tmpdir(), 'skills-')), CLAUDE_AGENTS_DIR: mkdtempSync(join(tmpdir(), 'agents-')), CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'config-')) };
  const r = run(dirs, '', '--codex');
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /\[y\/N\]|wrote/);
  const skills = readdirSync(join(CLONE, 'skills')).sort();
  assert.deepEqual(readdirSync(join(home, 'skills')).sort(), skills);
  assert.equal(realpathSync(join(home, 'skills', 'evidence')), realpathSync(join(CLONE, 'skills', 'evidence')));
  for (const dir of [dirs.CLAUDE_SKILLS_DIR, dirs.CLAUDE_AGENTS_DIR, dirs.CLAUDE_CONFIG_DIR]) assert.deepEqual(readdirSync(dir), []);
  run(dirs, '', '--codex', '--remove');
  assert.deepEqual(readdirSync(join(home, 'skills')), []);
});
