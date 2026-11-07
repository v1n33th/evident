import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const AGENTS = join(ROOT, 'agents');
// Claude Code ignores a frontmatter field it does not know without a word, so a typo (disallowed-tools) silently drops a
// restriction. These are the documented subagent fields.
const FIELDS = new Set(['name', 'description', 'tools', 'disallowedTools', 'model', 'permissionMode', 'maxTurns', 'skills', 'mcpServers', 'hooks', 'memory', 'background', 'omitClaudeMd', 'effort', 'isolation', 'color', 'initialPrompt']);

test('each agent file has only known frontmatter fields, its file name as name, the parent\'s model, a body, and a guard hook that exists (the fixer edits code and has none)', () => {
  const files = readdirSync(AGENTS).filter((f) => f.endsWith('.md'));
  assert.deepEqual(files.sort(), ['evident-checker.md', 'evident-explorer.md', 'evident-fixer.md', 'evident-prover-shell.md', 'evident-prover.md']);
  for (const file of files) {
    const text = readFileSync(join(AGENTS, file), 'utf8');
    const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
    assert.ok(m, `${file}: no frontmatter`);
    const keys = m[1].split('\n').filter((line) => /^\S/.test(line)).map((line) => line.split(':')[0]);
    for (const key of keys) assert.ok(FIELDS.has(key), `${file}: unknown field ${key}`);
    assert.ok(keys.includes('description'), file);
    assert.ok(m[2].trim().length > 0, `${file}: no body`);
    // The fixer changes the app's code and records with node -e, which the guard refuses every role: no hook.
    if (file === 'evident-fixer.md') { assert.match(m[1], /^tools: Read, Edit, Write, Bash$/m, 'the fixer carries no MCP tool list'); assert.match(m[1], /^model: inherit$/m); continue; }
    assert.ok(keys.includes('hooks'), file);
    assert.match(m[1], new RegExp(`^name: ${file.replace(/\.md$/, '')}$`, 'm'));
    assert.match(m[1], /^model: inherit$/m, `${file}: a model switch is tested in an eval first`);
    assert.ok(m[2].trim().length > 0, `${file}: no body`);
    const hook = /command: '?node "\$HOME\/\.claude\/skills\/([^"]+)" --role (\w+)/.exec(m[1]);
    assert.ok(hook, `${file}: no guard hook command`);
    assert.ok(existsSync(join(ROOT, 'skills', hook[1])), `${file}: skills/${hook[1]} does not exist`);
    assert.ok([`evident-${hook[2]}.md`, `evident-${hook[2]}-shell.md`].includes(file), `${file}: guard role ${hook[2]}`);
    assert.match(m[1], /matcher: "Read\|Bash"/);
  }
  assert.match(readFileSync(join(AGENTS, 'evident-prover-shell.md'), 'utf8'), /^tools: Read, Bash$/m, 'the shell prover carries no MCP tool list');
});

test('the plugin manifests name evident, the marketplace lists it at the root, and its hook runs a guard that exists', () => {
  const plugin = JSON.parse(readFileSync(join(ROOT, '.claude-plugin/plugin.json'), 'utf8'));
  assert.equal(plugin.name, 'evident');
  const market = JSON.parse(readFileSync(join(ROOT, '.claude-plugin/marketplace.json'), 'utf8'));
  assert.deepEqual(market.plugins.map((p) => [p.name, p.source]), [['evident', './']]);
  const [entry] = JSON.parse(readFileSync(join(ROOT, 'hooks/hooks.json'), 'utf8')).hooks.PreToolUse;
  assert.equal(entry.matcher, 'Read|Bash');
  const m = /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/([^"]+)" --role agent$/.exec(entry.hooks[0].command);
  assert.ok(m && existsSync(join(ROOT, m[1])), entry.hooks[0].command);
});

test('plugin.json has a semver version no older than the newest release tag', async () => {
  const { execFileSync } = await import('node:child_process');
  const { version } = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.match(version ?? '', /^\d+\.\d+\.\d+$/);
  const n = (v) => v.split('.').map(Number);
  const newer = (a, b) => n(a).reduce((r, x, i) => r || Math.sign(x - n(b)[i]), 0) > 0;
  // A clone without tags (a shallow copy) checks only the form.
  const tags = execFileSync('git', ['tag', '--list', 'v*'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter((t) => /^v\d+\.\d+\.\d+$/.test(t));
  for (const t of tags) assert.ok(!newer(t.slice(1), version), `tag ${t} is newer than plugin.json's ${version}: bump it`);
});
