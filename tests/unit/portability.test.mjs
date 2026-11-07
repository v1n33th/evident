import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILLS = fileURLToPath(new URL('../../skills', import.meta.url));
const skills = readdirSync(SKILLS, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
// The Agent Skills spec's frontmatter fields (agentskills.io/specification): any other agent may reject or drop the rest.
const FIELDS = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);
// What only Claude Code has. A skill may name one only in a Claude Code note: after "Claude Code" in the same sentence,
// or under a heading that says "Claude Code only".
const CLAUDE_ONLY = [/subagent_type/, /run_in_background/, /CLAUDE_[A-Z_]+/, /\/add-dir\b/, /~\/\.claude\b/, /\.claude\//,
  /mcp__claude-in-chrome/, /(^|[\s`(])\/chrome\b/, /\bclaude (--chrome|mcp)\b/, /\bevident-(prover|checker)\b/,
  /\b(Agent|Task|Read|Bash|Skill) tool\b/, /\b(TodoWrite|AskUserQuestion|ToolSearch|SendMessage|TaskOutput)\b/, /general-purpose/];

test('each SKILL.md uses only Agent Skills spec frontmatter fields, with its folder name as name', () => {
  for (const skill of skills) {
    const m = /^---\n([\s\S]*?)\n---\n/.exec(readFileSync(join(SKILLS, skill, 'SKILL.md'), 'utf8'));
    assert.ok(m, `${skill}: no frontmatter`);
    const keys = m[1].split('\n').filter((line) => /^\S/.test(line)).map((line) => line.split(':')[0]);
    for (const key of keys) assert.ok(FIELDS.has(key), `${skill}/SKILL.md: ${key} is not an Agent Skills field`);
    assert.match(m[1], new RegExp(`^name: ${skill}$`, 'm'));
    assert.match(m[1], /^description: \S/m);
  }
});

// Lines of one file that name a Claude Code-only thing outside a Claude Code note.
function claudeOnlyLines(text, label) {
  const found = [];
  let marked = 0; // the level of the heading that says "Claude Code only", or 0
  let noted = false; // the line before is a settings comment that names Claude Code: it covers the setting under it
  const lines = text.split('\n');
  const end = lines[0] === '---' ? lines.indexOf('---', 1) : -1; // a definition's settings block ends here
  lines.forEach((line, n) => {
    const settings = n > 0 && n < end;
    if (settings) {
      const covered = noted;
      noted = line.startsWith('#') && line.includes('Claude Code');
      if (covered && !line.startsWith('#')) return;
    }
    const heading = !settings && /^(#+) /.exec(line); // a `#` line in the settings block is a comment, not a heading
    if (heading) {
      if (marked && heading[1].length <= marked) marked = 0;
      if (!marked && line.includes('Claude Code only')) marked = heading[1].length;
    }
    if (marked) return;
    for (const re of CLAUDE_ONLY) {
      const m = re.exec(line);
      if (m && !/Claude Code(?:(?!\. ).)*$/.test(line.slice(0, m.index))) found.push(`${label}:${n + 1}: ${m[0].trim()}`);
    }
  });
  return found;
}

test('no instruction file requires a Claude Code-only tool, setting or path outside a Claude Code note', () => {
  const found = [];
  for (const skill of skills) {
    const files = readdirSync(join(SKILLS, skill)).filter((f) => f.endsWith('.md'));
    // Definitions (targets, drivers, templates, examples) are tester instructions too.
    for (const dir of ['targets', 'drivers', 'templates', 'examples']) {
      const at = join(SKILLS, skill, dir);
      if (!existsSync(at)) continue;
      for (const f of readdirSync(at, { recursive: true })) if (f.endsWith('.md')) files.push(join(dir, f));
    }
    for (const file of files) found.push(...claudeOnlyLines(readFileSync(join(SKILLS, skill, file), 'utf8'), `${skill}/${file}`));
  }
  assert.deepEqual(found, []);
});

test('a settings comment is scanned like any line; a Claude Code note covers only the setting under it', () => {
  const def = (comment) => `---\nname: x\n${comment}\ncheck: tools: mcp__claude-in-chrome__\nparallel: no\n---\n`;
  assert.ok(claudeOnlyLines(def('# see ~/.claude/settings.json'), 'x').some((l) => l.startsWith('x:3:')));
  assert.deepEqual(claudeOnlyLines(def('# Claude Code only: these tools'), 'x'), []);
  assert.ok(claudeOnlyLines(def('# Claude Code only: x\n# ~/.claude/a'), 'x').some((l) => l.startsWith('x:4:')));
});
