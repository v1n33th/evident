import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../skills/fix-and-prove/scripts/fix-list.mjs', import.meta.url));

test('fix-list: one line per bug, with the fix once a fixer wrote it', () => {
  const run = mkdtempSync(join(tmpdir(), 'list-'));
  const bug = (id, extra) => {
    const dir = join(run, 'bugs', `${id}-x`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'bug.json'), JSON.stringify({ id, kind: 'bug', severity: 'major', title: `Title ${id}`, url: '/team', actual: 'counts revoked', ...extra }));
    return dir;
  };
  const a = bug('BUG-001');
  const b = bug('BUG-002', { hypothesis: 'limit query', fix: { status: 'fixed', risk: 'low', inProduction: true, source: 'A revoked invite does not count.', patch: 'fixes/1-BUG-002.patch' } });
  const lines = execFileSync('node', [SCRIPT, a, b], { encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(lines, [
    'BUG-001 bug major | Title BUG-001 | /team | actual: counts revoked | hypothesis: -',
    'BUG-002 bug major | Title BUG-002 | /team | actual: counts revoked | hypothesis: limit query | fix: fixed low inProduction=true fixes/1-BUG-002.patch | source: A revoked invite does not count.',
  ]);
});

test('fix-list: a bug whose own picture the evidence check contradicts ends "not confirmed"', () => {
  const run = mkdtempSync(join(tmpdir(), 'list-'));
  const dir = join(run, 'bugs', 'BUG-001-x');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'bug.json'), JSON.stringify({ id: 'BUG-001', kind: 'bug', severity: 'minor', title: 'T', actual: 'a' }));
  writeFileSync(join(run, 'evidence.jsonl'), `${JSON.stringify({ bug: 'BUG-001', file: 'bugs/BUG-001-x/found.png', sha256: 'aa' })}\n`);
  writeFileSync(join(run, 'evidence-check.jsonl'), `${JSON.stringify({ file: 'bugs/BUG-001-x/found.png', sha256: 'aa', verdict: 'mismatch', why: 'no error shown' })}\n`);
  assert.equal(execFileSync('node', [SCRIPT, dir], { encoding: 'utf8' }).trim(), 'BUG-001 bug minor | T | - | actual: a | hypothesis: - | not confirmed: no error shown');
});
