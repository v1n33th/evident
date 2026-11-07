// Drives each skill's real scripts in run order and checks the request's report.html after every command.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const S = (p) => fileURLToPath(new URL(`../../skills/${p}`, import.meta.url));
const RUN_FOLDER = S('show-your-work/scripts/run-folder.mjs');
const BUILD_PROOF = S('show-your-work/scripts/build-proof.mjs');
const LOG = S('evidence/scripts/log.mjs');
const NEW_BUG = S('evidence/scripts/new-bug.mjs');
const FIX_SETUP = S('fix-and-prove/scripts/fix-setup.mjs');
const FIX_LIST = S('fix-and-prove/scripts/fix-list.mjs');
const FIX_CLAIMS = S('fix-and-prove/scripts/fix-claims.mjs');
const BUILD_FIX = S('fix-and-prove/scripts/build-fix-report.mjs');

const put = (dir, files) => {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), typeof text === 'string' ? text : JSON.stringify(text));
  }
};
const projectDir = () => mkdtempSync(join(tmpdir(), 'pages-'));
const line = (out, name) => out.match(new RegExp(`^${name}: (.+)$`, 'm'))?.[1];

// The shared page check: runs after every command, against the request folder.
function checkPage(request, what = '') {
  const at = `${what} -> ${request}`;
  const html = readFileSync(join(request, 'report.html'), 'utf8');
  assert.ok(html.toLowerCase().startsWith('<!doctype html>'), `${at}: no doctype`);
  assertHtml(html, request, at);
  const project = dirname(dirname(request));
  const lock = existsSync(join(project, 'run.lock')) ? readFileSync(join(project, 'run.lock'), 'utf8').trim() : '';
  const live = lock !== '' && (lock + sep).startsWith(request + sep);
  const refresh = /<meta[^>]+http-equiv=["']?refresh/i.test(html);
  assert.equal(refresh, live, `${at}: meta refresh ${refresh} but run.lock names "${lock}"`);
  JSON.parse(readFileSync(join(request, 'summary.json'), 'utf8'));
}

// Tag balance, visible text and links; shared by report.html and the project index.html.
function assertHtml(html, base, at) {
  for (const tag of ['details', 'section']) {
    const open = (html.match(new RegExp(`<${tag}[\\s>]`, 'g')) ?? []).length;
    const close = (html.match(new RegExp(`</${tag}>`, 'g')) ?? []).length;
    assert.equal(open, close, `${at}: <${tag}> opens ${open}, closes ${close}`);
  }
  const text = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<[^>]*>/g, ' ');
  for (const bad of [/\bundefined\b/, /\bNaN\b/, /\[object Object\]/, /\bnull\b/]) {
    const m = text.match(bad);
    assert.ok(!m, `${at}: visible text has ${bad}: ...${m && text.slice(Math.max(0, m.index - 40), m.index + 40).replace(/\s+/g, ' ')}...`);
  }
  for (const [, , , raw] of html.matchAll(/\b(href|src)=(["'])(.*?)\2/g)) {
    const v = raw.replace(/&amp;/g, '&');
    if (v.startsWith('#') || /^(https?:|mailto:|data:|javascript:)/i.test(v) || v === '') continue;
    const path = decodeURIComponent((v.startsWith('file://') ? v.slice(7) : v).split('#')[0].split('?')[0]);
    assert.ok(existsSync(resolve(base, path)), `${at}: dead link ${v}`);
  }
}

function checkIndex(project, what = '') {
  assert.ok(existsSync(join(project, 'index.html')), `${what}: no index.html`);
  assertHtml(readFileSync(join(project, 'index.html'), 'utf8'), project, `${what} index`);
}

const node = (script, ...args) => execFileSync('node', [script, ...args], { encoding: 'utf8', stdio: 'pipe' });
const claim = (id, extra = {}) => ({
  id, tags: ['f'], target: 'api', statement: `The app keeps ${id}`, status: 'active', rank: 'headline', given: 'G', setup: 'UI only',
  cases: [{ id: 'a', do: 'Do it', expect: 'It works' }], evidence: 'A capture', proof: 'will', risk: 'R', source: 'the user\'s words', check: null, changed: null, ...extra,
});
const bugJson = (id, extra = {}) => ({ id, title: `Title ${id}`, severity: 'major', kind: 'bug', target: 'api', steps: ['Do it'], expected: 'It works', actual: 'It breaks', ...extra });
const fixRecord = (extra = {}) => ({
  status: 'fixed', summary: 'Refuses the 11th invite', rootCause: 'off by one', files: ['src/invites.mjs:36'], differs: 'Production allows 11',
  impact: { existingUsers: 'Nothing visible', storedData: 'Not affected', otherConsumers: 'None', migration: 'none' },
  risk: 'low', riskReason: 'Fixes broken behaviour only', gap: false, inProduction: false, source: 'broken: the 11th invite is sent', patch: 'fixes/1-BUG-001.patch', commit: null, checks: 'none', ...extra,
});

// A capture file for a claim case, logged through log.mjs (it hashes the file).
const capture = (run, claimId, caseId, extra = {}) => {
  const file = `evidence/${claimId}-${caseId}.txt`;
  put(run, { [file]: `${claimId} ${caseId} response` });
  node(LOG, run, 'evidence.jsonl', JSON.stringify({ claim: claimId, case: caseId, target: 'api', method: 'curl', commit: 'abc123', file, note: 'saw it', ...extra }));
};

const gitApp = () => {
  const code = join(projectDir(), 'app');
  mkdirSync(code);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: code });
  writeFileSync(join(code, 'a.txt'), 'v1\n');
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base', '--allow-empty'], { cwd: code });
  return code;
};

test('page: explore request, bug-bash', () => {
  const p = projectDir();
  const out = node(RUN_FOLDER, p, 'invites', 'explore', 'explore');
  const request = line(out, 'Request folder');
  const step = line(out, 'Step folder');
  checkPage(request, 'run-folder');
  put(step, { 'charters.json': { charters: [{ id: 'T1', mission: 'Try the invite limit', notCovered: 'parallel sends' }] }, 'charters/T1.jsonl': `${JSON.stringify({ result: 'ok', action: 'Opened the invite form', note: 'form loads' })}\n${JSON.stringify({ result: 'question', note: 'Per org or per owner?' })}\n` });
  checkPage(request, 'charters');
  node(NEW_BUG, step, 'limit-off-by-one');
  checkPage(request, 'new-bug');
  const dir = join(step, 'bugs', readdirSync(join(step, 'bugs')).find((d) => d.startsWith('BUG-001')));
  put(dir, { 'bug.json': bugJson('BUG-001'), 'found.txt': '11 invites sent' });
  checkPage(request, 'bug.json');
  node(LOG, step, 'evidence.jsonl', JSON.stringify({ bug: 'BUG-001', target: 'api', method: 'curl', commit: 'abc123', file: `bugs/${dir.split('/').pop()}/found.txt`, note: 'sent' }));
  checkPage(request, 'log');
  node(BUILD_PROOF, step);
  checkPage(request, 'build-proof');
  node(RUN_FOLDER, '--release', p);
  checkPage(request, 'release');
  checkIndex(p, 'release');
});

test('page: prove request, show-your-work', () => {
  const p = projectDir();
  const out = node(RUN_FOLDER, p, 'invites', 'prove', 'proof');
  const request = line(out, 'Request folder');
  const run = line(out, 'Step folder');
  checkPage(request, 'run-folder');
  put(run, { 'claims.json': { title: 'Invite limit', input: 'main at abc', willNotProve: 'parallel sends', areas: [], claims: [claim('C1'), claim('C2', { cases: [{ id: 'a', do: 'Do it', expect: 'It works' }, { id: 'b', do: 'Again', expect: 'Same' }] })] } });
  checkPage(request, 'claims.json');
  node(BUILD_PROOF, run, '--approve');
  checkPage(request, '--approve');
  // Approval gives the new claims their ledger ids.
  const [one, two] = JSON.parse(readFileSync(join(run, 'claims.json'), 'utf8')).claims.map((c) => c.id);
  node(BUILD_PROOF, run, '--session', 's1', one, two);
  checkPage(request, '--session');
  const keys = [[one, 'a'], [two, 'a'], [two, 'b']];
  put(run, { 'sessions/s1.jsonl': keys.map(([c, k]) => JSON.stringify({ claim: c, case: k, result: 'pass' })).join('\n') + '\n' });
  for (const [c, k] of keys) { capture(run, c, k); checkPage(request, `log ${c}${k}`); }
  node(BUILD_PROOF, run);
  checkPage(request, 'build-proof');
  node(RUN_FOLDER, '--release', p);
  checkPage(request, 'release');
  checkIndex(p, 'release');
});

test('page: fix-and-prove explore-and-fix', () => {
  const p = projectDir();
  const code = gitApp();
  const setup = node(FIX_SETUP, p, 'invites', code);
  const request = line(setup, 'Request folder');
  const fix = line(setup, 'Fix run');
  const spec = line(setup, 'Baseline run');
  checkPage(request, 'fix-setup');
  const explore = line(node(RUN_FOLDER, '--in', request, 'explore'), 'Step folder') ?? join(request, 'explore');
  checkPage(request, 'run-folder --in explore');
  put(explore, { 'charters.json': { charters: [] } });
  node(NEW_BUG, explore, 'limit');
  const bugDir = join(explore, 'bugs', readdirSync(join(explore, 'bugs')).find((d) => d.startsWith('BUG-001')));
  put(bugDir, { 'bug.json': bugJson('BUG-001'), 'body.txt': '11 sent' });
  node(LOG, explore, 'evidence.jsonl', JSON.stringify({ bug: 'BUG-001', target: 'api', method: 'curl', commit: 'abc123', file: `bugs/${bugDir.split('/').pop()}/body.txt`, note: 'sent' }));
  checkPage(request, 'explore bug');
  // The fixer's record and patch.
  put(bugDir, { 'bug.json': bugJson('BUG-001', { fix: fixRecord() }) });
  put(fix, { 'fixes/1-BUG-001.patch': '--- a/src/invites.mjs\n+++ b/src/invites.mjs\n@@ -1 +1 @@\n-x\n+y\n' });
  checkPage(request, 'fix record');
  node(FIX_LIST, bugDir);
  checkPage(request, 'fix-list');
  const proof = line(node(RUN_FOLDER, '--in', request, 'proof'), 'Step folder') ?? join(request, 'proof');
  checkPage(request, 'run-folder --in proof');
  node(FIX_CLAIMS, proof, 'none', '--spec', spec, bugDir);
  checkPage(request, 'fix-claims');
  // The claim writer finishes the draft claims.
  const drafted = JSON.parse(readFileSync(join(proof, 'claims.json'), 'utf8'));
  drafted.claims = drafted.claims.map((c) => ({ ...claim(c.id), ...c, draft: undefined, given: 'A new account', setup: 'UI only', evidence: 'A capture', proof: 'will', risk: 'R', cases: [{ id: 'a', do: 'Send 11 invites', expect: 'The 11th is refused' }] }));
  put(proof, { 'claims.json': drafted });
  const id = drafted.claims[0].id;
  put(proof, { 'sessions/s1.jsonl': `${JSON.stringify({ claim: id, case: 'a', result: 'pass' })}\n` });
  capture(proof, id, 'a');
  checkPage(request, 'proof capture');
  node(BUILD_PROOF, proof);
  checkPage(request, 'build-proof');
  put(fix, { 'rounds.json': { feature: 'invites', production: 'main', fixCommits: [], baseline: spec, rounds: [{ n: 1, explore, verify: proof }] } });
  node(BUILD_FIX, fix);
  checkPage(request, 'build-fix-report');
  node(RUN_FOLDER, '--release', p);
  checkPage(request, 'release');
  checkIndex(p, 'release');
});

for (const [flag, kind] of [['--report', '2026-10-29-0900-explore'], ['--improve', 'improve']]) {
  test(`page: fix-and-prove ${flag} (${kind})`, () => {
    const p = projectDir();
    const code = gitApp();
    if (flag === '--report') {
      // Pending bugs in two finished explore requests: --report grows the newer one.
      for (const day of ['28', '29']) {
        const step = join(p, 'invites', `2026-10-${day}-0900-explore`, 'explore');
        put(step, { 'charters.json': { charters: [] }, 'charters/T1.jsonl': '', 'bugs/BUG-001-limit/bug.json': bugJson('BUG-001'), 'bugs/BUG-001-limit/body.txt': 'sent' });
        node(LOG, step, 'evidence.jsonl', JSON.stringify({ bug: 'BUG-001', target: 'api', method: 'curl', commit: 'abc123', file: 'bugs/BUG-001-limit/body.txt', note: 'sent' }));
        node(BUILD_PROOF, step);
      }
    }
    const setup = node(FIX_SETUP, p, 'invites', code, flag);
    const request = line(setup, 'Request folder');
    assert.ok(request.endsWith(`-${kind}`) || request.endsWith(`/${kind}`), request);
    checkPage(request, `fix-setup ${flag}`);
    node(RUN_FOLDER, '--in', request, 'proof');
    checkPage(request, 'run-folder --in');
    node(RUN_FOLDER, '--release', p);
    checkPage(request, 'release');
    checkIndex(p, 'release');
  });
}
