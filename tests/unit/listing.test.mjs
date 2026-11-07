import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../skills/evidence/scripts/listing.mjs', import.meta.url));

test('listing.mjs prints each line with a file and its case\'s expect, the text of text files, and broken lines', () => {
  const run = mkdtempSync(join(tmpdir(), 'listing-'));
  mkdirSync(join(run, 'evidence'));
  writeFileSync(join(run, 'evidence/C1-a.png'), 'png');
  writeFileSync(join(run, 'evidence/C1-a-network.txt'), 'POST /api/invites 429');
  writeFileSync(join(run, 'evidence/C1-a-console.txt'), 'x'.repeat(4100));
  writeFileSync(join(run, 'claims.json'), JSON.stringify({ claims: [{ id: 'C1', cases: [{ id: 'a', expect: 'shows "Limit reached"' }] }] }));
  const line = (o) => JSON.stringify({ target: 'web', commit: 'abc', at: 't', sha256: 'h', ...o });
  writeFileSync(join(run, 'evidence-01.jsonl'), [
    line({ claim: 'C1', case: 'a', role: 'picture', file: 'evidence/C1-a.png', note: 'limit reached' }),
    line({ claim: 'C1', case: 'a', role: 'raw', file: 'evidence/C1-a-network.txt' }),
    line({ claim: 'C1', case: 'a', role: 'raw', file: 'evidence/C1-a-console.txt' }),
    line({ claim: 'C1', case: 'a', method: 'failed: gif: none' }),
    '{"broken',
  ].join('\n') + '\n');
  const out = execFileSync('node', [SCRIPT, run, 'evidence-01.jsonl'], { encoding: 'utf8' }).split('\n');
  assert.equal(out[0], '{"file":"evidence/C1-a.png","role":"picture","claim":"C1","case":"a","expect":"shows \\"Limit reached\\"","note":"limit reached"}');
  assert.equal(out[1], '{"file":"evidence/C1-a-network.txt","role":"raw","claim":"C1","case":"a","expect":"shows \\"Limit reached\\""}');
  assert.deepEqual(out.slice(2, 4), ['POST /api/invites 429', '---']);
  assert.equal(out[5], 'x'.repeat(1500));
  assert.equal(out[6], '(cut at 1500 of 4100 characters)');
  assert.equal(out[8], 'BROKEN {"broken');
  assert.ok(!out.join('\n').includes('"sha256"'));
});

test('log.mjs refuses a second check row for the same file and hash', () => {
  const run = mkdtempSync(join(tmpdir(), 'listing-'));
  mkdirSync(join(run, 'evidence'));
  writeFileSync(join(run, 'evidence/C1-a.png'), 'png');
  const LOG = fileURLToPath(new URL('../../skills/evidence/scripts/log.mjs', import.meta.url));
  const row = JSON.stringify({ file: 'evidence/C1-a.png', verdict: 'matches', why: 'ok' });
  execFileSync('node', [LOG, run, 'check-01.jsonl', row]);
  assert.throws(() => execFileSync('node', [LOG, run, 'check-01.jsonl', row], { stdio: 'pipe' }), /already has a row for evidence\/C1-a.png/);
});

test('make-image.mjs writes a PNG of the size asked', async () => {
  const { png } = await import('../../skills/evidence/scripts/make-image.mjs');
  const buf = png(600, 200);
  assert.equal(buf.subarray(1, 4).toString(), 'PNG');
  assert.equal(buf.readUInt32BE(16), 600);
  assert.equal(buf.readUInt32BE(20), 200);
});
