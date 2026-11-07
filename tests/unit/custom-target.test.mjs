import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { start } from '../../skills/bug-bash/scripts/start.mjs';
import { logFiles } from '../../skills/evidence/scripts/log.mjs';
import { buildProof } from '../../skills/show-your-work/scripts/build-proof.mjs';
import { pageHtml, requestData, writeResult } from '../../skills/show-your-work/scripts/report.mjs';
import { newRequest, newStep } from '../../skills/show-your-work/scripts/run-folder.mjs';

// newStep takes no home: point HOME at an empty folder so the real ~/.evident never reaches these tests.
const realHome = process.env.HOME;
const status = () => execFileSync('git', ['status', '--porcelain', 'skills'], { encoding: 'utf8' });
let statusBefore;
before(() => { statusBefore = status(); process.env.HOME = mkdtempSync(join(tmpdir(), 'home-')); });
after(() => { process.env.HOME = realHome; });

const put = (dir, files) => { for (const [name, text] of Object.entries(files)) { mkdirSync(dirname(join(dir, name)), { recursive: true }); writeFileSync(join(dir, name), typeof text === 'string' ? text : JSON.stringify(text)); } };
const sha = (text) => createHash('sha256').update(text).digest('hex');

const QUEUE = '---\nname: queue\nlabel: Queue\naddress: Queue\ndrivers: qcli\nmethods: text\ndefault-methods: text\nproven-by: file\nviewports: no\nsession-cases: 1\nfound: found.txt\nevidence-summary: saved output\n---\n\n## Connect\n\n- Queue connect rule.\n\n## Drive\n\n- Queue drive rule.\n';
const QCLI = '---\nname: qcli\ntargets: queue\nmethods: text\nshell: yes\ncheck: qcli --version\nparallel: yes\ncommand: qcli --vhost qa\n---\n\n## Forms\n\n`qcli peek <topic>`\n';
const CURL = '---\nname: curl\ntargets: api\nmethods: readable\nshell: yes\ncheck: curl --version\nparallel: yes\ncommand: curl --project-flag\n---\n\n## Forms\n\n`curl -s <url>`\n';

// A project folder with a request in it; `extra` adds files (project definitions) before any step is made.
function makeProject(env, extra = {}) {
  const project = join(mkdtempSync(join(tmpdir(), 'custom-')), '.evident');
  put(project, { 'environment.md': env, ...extra });
  return { project, request: newRequest(project, 'jobs', 'prove', new Date(2026, 10, 5, 9, 0)) };
}
const QUEUE_ENV = '## Target\n- App: amqp://localhost:5672\n## Targets\n- Queue: amqp://localhost:5672\n## Evidence\n- Queue: text · driver: qcli\n## Drivers\n- qcli: qcli --vhost qa\n';
const queueDefs = { 'targets/queue.md': QUEUE, 'drivers/qcli.md': QCLI, 'drivers/curl.md': CURL };
const targetsJson = (step) => JSON.parse(readFileSync(join(step, 'targets.json'), 'utf8'));

// The proof step of a request, with one claim whose one case passed with one text file.
function proofStep(request, target) {
  const step = newStep(request, 'proof');
  const text = 'out';
  put(step, {
    'claims.json': { title: 'T', input: 'in', willNotProve: 'x', areas: [], claims: [{ id: 'C1', tags: ['f'], area: null, rank: 'headline', status: 'active', target, statement: 'The app keeps C1', given: 'G', setup: 'UI only', evidence: 'E', proof: 'will', cases: [{ id: 'a', do: 'd', expect: 'e' }], check: null, changed: null, retiredReason: null }] },
    'sessions/s1.jsonl': JSON.stringify({ claim: 'C1', case: 'a', result: 'pass' }),
    'evidence/C1-a.txt': text,
    'evidence.jsonl': JSON.stringify({ claim: 'C1', case: 'a', target, method: 'text', commit: 'abc123', env: 'e', at: 't', by: 's', file: 'evidence/C1-a.txt', sha256: sha(text), note: '' }),
  });
  return step;
}

test('a queue run is judged by its definition', async () => {
  const { project, request } = makeProject(QUEUE_ENV, queueDefs);
  // Explore: the snapshot, start's printout and a logged text file.
  const run = newStep(request, 'explore', ['charters', 'evidence']);
  assert.ok(targetsJson(run).targets.queue);
  put(project, { 'tester-profiles.json': { profiles: [{ id: 'p', name: 'P', who: 'w', knows: 'k', focus: [], does: [], judges: 'j' }] } });
  put(request, { 'brief.md': '## Request\nJobs.\n' });
  put(run, { 'charters.json': { charters: [{ id: 'T1', mission: 'Peek', profile: 'p', target: 'queue', account: 'a', budget: 5 }] } });
  const out = start(run, 'T1', { commit: 'abc1234' });
  assert.match(out, /### Connect\n- Queue connect rule\./);
  assert.match(out, /`qcli peek <topic>`/);
  assert.match(out, /Driver: qcli --vhost qa/);
  put(run, { 'evidence/C1-a.txt': 'peeked' });
  const [line] = logFiles(run, 'T1', ['evidence/C1-a.txt']);
  assert.match(line, /evidence\/C1-a\.txt/);
  // Prove: a text file is enough for a file-proven target.
  const proof = proofStep(request, 'queue');
  assert.equal(buildProof(proof).data.claims[0].verdict, 'proven');
  // Report: the card names the target by its label.
  put(run, { 'bugs/BUG-001-q/bug.json': { id: 'BUG-001', title: 'Stuck', severity: 'major', target: 'queue', steps: ['a'], expected: 'Retried', actual: 'Stuck' } });
  assert.match(pageHtml(await requestData(request)), /<span class="id">BUG-001<\/span><span class="where">Queue<\/span>/);
});

test('a project override of a built-in wins', () => {
  const { request } = makeProject('## Targets\n- API: http://localhost:3000\n## Evidence\n- API: readable · tool: curl\n', queueDefs);
  const t = targetsJson(newStep(request, 'proof')).targets.api;
  assert.match(t.files.driver, /\.evident\/drivers\/curl\.md$/);
  assert.equal(t.driver.command, 'curl --project-flag');
});

test('a project web.md loosening proof decides verdicts silently', async () => {
  const web = '---\nname: web\nlabel: Web\naddress: Web\ndrivers: agent-browser\nmethods: text\ndefault-methods: text\nproven-by: file\nviewports: no\nsession-cases: 1\nfound: found.txt\nevidence-summary: text\n---\n\n## Connect\n\n- Open it.\n';
  const { request } = makeProject('## Targets\n- Web: http://localhost:1\n', { 'targets/web.md': web });
  const proof = proofStep(request, 'web');
  const { data } = buildProof(proof);
  assert.equal(data.claims[0].verdict, 'proven');
  writeResult(proof, data);
  assert.doesNotMatch(pageHtml(await requestData(request)), /loosened|project definition/i);
});

test('no evident file changed', () => {
  assert.equal(status(), statusBefore);
});
