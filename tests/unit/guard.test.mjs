import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../skills/evidence/scripts/guard.mjs', import.meta.url));

// An app repo laid out as a real run leaves it: project folder .evident/, a request with a proof step, project skills.
function layout() {
  const app = join(mkdtempSync(join(tmpdir(), 'guard-')), 'acme-invites');
  const run = join(app, '.evident/invite-limit/2026-11-02-1006-improve/proof');
  const skills = join(app, '.claude/skills');
  for (const [file, text] of Object.entries({
    '.git/HEAD': 'ref: refs/heads/next',
    'src/invites.js': 'export const LIMIT = 10;',
    '.evident/environment.md': '## Target\nlocal',
    '.evident/ledger.html': '<p>ledger</p>',
    '.evident/ledger/invite-limit.jsonl': '{"id":"C1"}',
    '.evident/invite-limit/2026-11-02-1006-improve/brief.md': '# Brief',
    '.claude/skills/evidence/SKILL.md': '# Evidence',
    '.claude/skills/evidence/CAPTURE.md': '# Capture',
    '.claude/skills/evidence/scripts/log.mjs': '',
    '.claude/skills/show-your-work/SKILL.md': '# Show your work',
  })) {
    mkdirSync(dirname(join(app, file)), { recursive: true });
    writeFileSync(join(app, file), text);
  }
  for (const [file, text] of Object.entries({
    'claims.json': '[]',
    'fix-claims.json': '[]',
    'sessions/01-api-free-owner.claims.json': '[]',
    'sessions/01-api-free-owner.jsonl': '',
    'evidence/C1-a-body.txt': '[{"email":"qa+1793287335@acme.test"}]',
    'evidence-01-api-free-owner.jsonl': '',
    'bugs/BUG-001-limit/bug.json': '{}',
  })) {
    mkdirSync(dirname(join(run, file)), { recursive: true });
    writeFileSync(join(run, file), text);
  }
  return { app, run, skills };
}

function guard(role, input, raw) {
  const r = spawnSync('node', [SCRIPT, ...(role ? ['--role', role] : [])], { input: raw ?? JSON.stringify(input), encoding: 'utf8' });
  return { status: r.status, stderr: r.stderr };
}
const bash = (role, cwd, command) => guard(role, { cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });
const read = (role, cwd, file_path) => guard(role, { cwd, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path } });

test('guard.mjs lets a prover run the commands its run used: curl, agent-browser, the evidence scripts, date, its own files', () => {
  const { app, run, skills } = layout();
  const E = `${skills}/show-your-work/../evidence`;
  for (const command of [
    `curl -sS -D '${run}/evidence/C1-a-headers.txt' -o '${run}/evidence/C1-a-body.txt' -w '%{http_code} %{time_total}' -X POST -H 'Authorization: Bearer <redacted>' -H 'Content-Type: application/json' -d '{"email":"qa+1793287335@acme.test"}' http://localhost:4173/api/invites`,
    `ab(){ agent-browser --no-auto-dialog --session acme-invites-02-web-free-owner "$@"; }; ab open http://localhost:4173/team && ab snapshot -i`,
    `R='${run}'; ab() { agent-browser --session x "$@"; }; ab record start "$R/evidence/C1-b.webm" --fps 10 && sleep 1 && ab click @e864 && sleep 2; ab record stop && ab network requests > "$R/evidence/C1-b-network.txt"; ls -la "$R/evidence/" | grep C1-b`,
    `node '${E}/scripts/log.mjs' '${run}' sessions/01-api-free-owner.jsonl '{"n": 1, "claim": "C1", "case": "a", "action": "ls sessions; node -e; python3", "expected": "201", "actual": "201 0.01s", "result": "pass"}'`,
    `node '${E}/scripts/pick.mjs' '${run}/evidence/C1-a-body.txt' email~qa+ --count`,
    `curl -sS http://localhost:4174/mail -o '${run}/evidence/C1-a-mail.json' && node '${E}/scripts/pick.mjs' '${run}/evidence/C1-a-mail.json' to=qa+1793287335@acme.test --fields subject`,
    `node '${E}/scripts/new-bug.mjs' '${run}' --list`,
    `node '${E}/scripts/setup.mjs' '${run}' C1-a '${app}' 'node cli.mjs reset-limit --org acme'`,
    `date +%s`,
    `cat '${run}/sessions/01-api-free-owner.claims.json'; awk '/^## /{c++} c<2' '${run}/../brief.md'; cat '${app}/.evident/environment.md'`,
    `cp '${run}/evidence/C1-a-body.txt' '${run}/bugs/BUG-001-limit/' && ls '${run}/bugs/BUG-001-limit'`,
    `cat '${run}/evidence/C1-a-headers.txt' '${run}/evidence/C1-a-body.txt' > '${run}/evidence/C1-a-response.txt'; grep -c . '${run}/evidence/C1-a-body.txt'`,
    `cat > '${run}/bugs/BUG-001-limit/bug.json' <<'EOF'\n{"id": "BUG-001", "steps": ["ls ${run}", "python3 x.py"]}\nEOF\necho done`,
  ]) {
    const r = bash('prover', app, command);
    assert.equal(r.status, 0, `${command}\n${r.stderr}`);
  }
  for (const file of [`${run}/sessions/01-api-free-owner.claims.json`, `${run}/../brief.md`, `${app}/.evident/environment.md`, `${skills}/evidence/CAPTURE.md`, `${run}/evidence/C1-a-body.txt`]) {
    assert.equal(read('prover', app, file).status, 0, file);
  }
});

test('guard.mjs blocks a prover listing the run folder or sessions/, running node -e or python, and reading claims, the ledger or code', () => {
  const { app, run } = layout();
  for (const [command, reason] of [
    [`ls ${run}`, /never list/],
    [`ls '${run}/sessions'`, /never list/],
    [`R=${run}; ls $R/sessions/`, /never list/],
    [`cd ${run} && ls`, /never list/],
    [`find ${run}/.. -name '*.jsonl'`, /never list/],
    [`ls ${app}/.evident`, /never list/],
    [`node -e 'const a=JSON.parse(require("fs").readFileSync(process.argv[1]));console.log(a.length)' ${run}/evidence/C1-a-body.txt`, /node -e/],
    [`curl -sS http://localhost:4174/mail | node --eval "process.stdin.on('data',d=>console.log(d+''))"`, /node -e/],
    [`node <<'EOF'\nconsole.log(1)\nEOF`, /only script files/],
    [`curl -sS http://localhost:4174/mail | python3 -c 'import json,sys; print(json.load(sys.stdin))'`, /python/],
    [`python3 -I - <<'EOF'\nimport json\nEOF`, /python/],
    [`bash -c 'python3 x.py'`, /python/],
    [`cat ${run}/claims.json`, /claims\.json/],
    [`cd ${run}; cat claims.json`, /claims\.json/],
    [`cat ${run}/*.json`, /claims\.json/],
    [`head ${run}/fix-claims.json`, /fix-claims\.json/],
    [`cat ${app}/.evident/ledger/invite-limit.jsonl`, /ledger/],
    [`cat ${app}/src/invites.js`, /code/],
    [`grep -rn LIMIT src`, /code/],
    [`ls ${app}`, /code/],
    [`git -C ${app} diff HEAD`, /diff/],
  ]) {
    const r = bash('prover', app, command);
    assert.equal(r.status, 2, command);
    assert.match(r.stderr, reason, command);
    assert.equal(r.stderr.trim().split('\n').length, 1);
  }
  for (const file of [`${run}/claims.json`, `${run}/fix-claims.json`, `${app}/.evident/ledger.html`, `${app}/.evident/ledger/invite-limit.jsonl`, `${app}/src/invites.js`]) {
    assert.equal(read('prover', app, file).status, 2, file);
  }
});

test('guard.mjs blocks a checker running node -e or python or reading the evidence log, and nothing else', () => {
  const { app, run, skills } = layout();
  for (const command of [
    `node '${skills}/evidence/scripts/listing.mjs' '${run}' evidence-01-api-free-owner.jsonl`,
    `node '${skills}/evidence/scripts/log.mjs' '${run}' check-01-api-free-owner.jsonl '{"file": "evidence/C1-a-body.txt", "verdict": "matches", "why": "201"}'`,
    `T=$(mktemp -d) && ffmpeg -i '${run}/evidence/C1-b.webm' -vf fps=1 "$T/f-%03d.png"`,
    `ls ${run}`,
  ]) assert.equal(bash('checker', app, command).status, 0, command);
  assert.equal(bash('checker', app, `node -e 'console.log(1)'`).status, 2);
  assert.equal(bash('checker', app, `python3 -c 'print(1)'`).status, 2);
  assert.match(bash('checker', app, `cat ${run}/evidence-01-api-free-owner.jsonl`).stderr, /listing\.mjs/);
  assert.equal(read('checker', app, `${run}/evidence-01-api-free-owner.jsonl`).status, 2);
  assert.equal(read('checker', app, `${run}/evidence/C1-a-body.txt`).status, 0);
});

test('guard.mjs blocks an explorer writing outside a run folder or reading leads.jsonl, and lets it drive and log', () => {
  const { app } = layout();
  const run = join(app, '.evident/quotes/2026-11-03-1739-explore/explore');
  mkdirSync(join(run, 'evidence'), { recursive: true });
  mkdirSync(join(run, 'charters'));
  writeFileSync(join(run, 'charters.json'), '{"charters":[]}');
  writeFileSync(join(run, 'leads.jsonl'), '');
  for (const command of [
    `agent-browser --session x screenshot '${run}/evidence/T4-save.png'`,
    `curl -s https://app.localhost/api/x -H "Authorization: Bearer $T" > '${run}/evidence/T4-body.txt' 2>/dev/null`,
    `cat > '${run}/bugs/BUG-001-x/bug.json' <<'EOF'\n{}\nEOF`,
    `cat '${app}/src/invites.js' | head -c 2000`,
  ]) assert.equal(bash('explorer', app, command).status, 0, command);
  assert.match(bash('explorer', app, `echo "$TOKEN" > /private/tmp/tok`).stderr, /write files only under your run folder/);
  writeFileSync(join(run, 'charters', '.T4.sh'), `R='${run}'\nab() { echo ab; }\n`);
  for (const command of [
    `cd '${join(run, 'charters')}'; . ./.T4.sh; ab screenshot $R/evidence/T4-a.png > $R/evidence/T4-net.txt`,
    `. '${join(run, 'charters', '.T4.sh')}'; B=$(ls -d $R/bugs/BUG-002*); ab console > $B/console.txt`,
  ]) assert.equal(bash('explorer', app, command).status, 0, command);
  assert.match(bash('explorer', app, `. '${join(run, 'charters', '.T4.sh')}'; X=/private/tmp; curl -s https://app.localhost/x > $X/tok`).stderr, /never \/private\/tmp\/tok/);
  mkdirSync(join(run, 'bugs', 'BUG-003-x'), { recursive: true });
  writeFileSync(join(run, 'bugs', '.BUG-003'), 'T7');
  assert.match(bash('explorer', app, `. '${join(run, 'charters', '.T4.sh')}'; ab screenshot $R/bugs/BUG-003-x/found.png`).stderr, /BUG-003 is T7's bug folder/);
  assert.match(bash('explorer', app, `. '${join(run, 'charters', '.T4.sh')}'; cat > $R/bugs/BUG-003-x/bug.json <<'EOF'\n{}\nEOF`).stderr, /BUG-003 is T7's bug folder/);
  assert.match(bash('explorer', app, `. '${join(run, 'charters', '.T4.sh')}'; B=$(ls -d $R/bugs/BUG-003*); ab screenshot $B/found.png`).stderr, /BUG-003 is T7's bug folder/, 'a guessed number with a glob names the folder too');
  writeFileSync(join(run, 'charters', '.T7.sh'), `R='${run}'\nab() { echo ab; }\n`);
  assert.equal(bash('explorer', app, `. '${join(run, 'charters', '.T7.sh')}'; ab screenshot $R/bugs/BUG-003-x/found.png`).status, 0, 'its own bug folder');
  writeFileSync(join(run, 'charters', '.T9.sh'), `R='/private/tmp'\n`);
  assert.match(bash('explorer', app, `. '${join(run, 'charters', '.T9.sh')}'; curl -s https://app.localhost/x > $R/tok`).stderr, /never \/private\/tmp\/tok/, 'a sourced R outside a run folder is read too');
  assert.equal(bash('explorer', app, `curl -s https://app.localhost/api/login >> ~/cookies.txt`).status, 2);
  assert.equal(bash('explorer', app, `printf '%s\\n' '- snapshot -i drops iframes' >> ~/.evident/tool-notes.md`).status, 0, 'the tool notes targets/web.md says to append to');
  assert.equal(bash('explorer', app, `python3 -c 'print(1)'`).status, 2);
  assert.match(read('explorer', app, `${run}/leads.jsonl`).stderr, /start\.mjs printed your leads/);
  assert.equal(read('explorer', app, `${app}/src/invites.js`).status, 0, 'an explorer may read the code');
  assert.match(read('explorer', app, `${run}/evidence/T4-save.png`).stderr, /never read a screenshot back/);
  assert.match(read('explorer', app, `${run}/charters/.T4/s.png`).stderr, /never read a screenshot back/);
  assert.equal(read('explorer', app, `${run}/bugs/BUG-001-x/found.png`).status, 0, 'a bug\'s own picture may be opened');
  assert.equal(read('explorer', app, `${run}/evidence/T4-body.txt`).status, 0);
});

test('guard.mjs fails open on input it cannot parse, an unknown tool or no role', () => {
  const { app, run } = layout();
  assert.equal(guard('prover', null, 'not json').status, 0);
  assert.equal(guard('prover', { cwd: app, tool_name: 'Write', tool_input: { file_path: `${run}/claims.json` } }).status, 0);
  assert.equal(guard(null, { cwd: app, tool_name: 'Bash', tool_input: { command: `ls ${run}` } }).status, 0);
  assert.equal(bash('prover', app, `echo 'unterminated`).status, 0);
});

test('guard.mjs takes one call as plain arguments, for any harness: exit 2 and the reason on a block, 0 otherwise', () => {
  const { app, run } = layout();
  const cli = (...args) => spawnSync('node', [SCRIPT, ...args], { input: '', encoding: 'utf8' });
  const blocked = cli('--role', 'prover', '--command', 'ls sessions', '--cwd', run);
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /^evident guard \(prover\): never list/);
  assert.equal(cli('--role', 'prover', '--command', `curl -sS http://localhost:4173/api/invites`, '--cwd', app).status, 0);
  assert.equal(cli('--role', 'prover', '--read', 'claims.json', '--cwd', run).status, 2);
  assert.equal(cli('--role', 'prover', '--read', `${run}/sessions/01-api-free-owner.claims.json`).status, 0);
  assert.equal(cli('--role', 'prover', '--read', `${run}/bugs/BUG-001-limit/bug.json`).status, 0, 'a bug with no fix record');
  mkdirSync(join(run, '..', 'fix', 'fixes'), { recursive: true });
  writeFileSync(join(run, '..', 'fix', 'fixes', '1-BUG-001.patch'), '');
  writeFileSync(join(run, '..', 'fix', 'rounds.json'), '{}');
  writeFileSync(join(run, 'bugs', 'BUG-001-limit', 'bug.json'), '{"fix":{"rootCause":"x"}}');
  for (const file of ['../fix/fixes/1-BUG-001.patch', '../fix/rounds.json', 'bugs/BUG-001-limit/bug.json']) {
    assert.match(cli('--role', 'prover', '--read', join(run, file)).stderr, /never read a fix/, file);
  }
  assert.equal(cli('--role', 'checker', '--read', `${run}/evidence-01-api-free-owner.jsonl`).status, 2);
  assert.equal(cli('--role', 'checker', '--command', `python3 -c 'print(1)'`).status, 2);
  assert.equal(cli('--role', 'checker', '--command', `ls ${run}`).status, 0);
  const usage = cli('--command', 'ls');
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /^Usage:/);
});

test('guard.mjs blocks on the PreToolUse JSON Codex sends for its shell tool', () => {
  const { app, run } = layout();
  const codex = (command) => guard('prover', {
    session_id: 's', transcript_path: null, cwd: app, hook_event_name: 'PreToolUse', model: 'gpt-5', permission_mode: 'default',
    turn_id: 't', tool_name: 'Bash', tool_use_id: 'call_1', tool_input: { command },
  });
  assert.equal(codex(`cat ${run}/claims.json`).status, 2);
  assert.equal(codex(`date +%s`).status, 0);
});

test('guard.mjs --role agent, the plugin hook, guards only the evident agents, by the agent_type of the call', () => {
  const { app, run } = layout();
  const call = (agent_type) => guard('agent', { cwd: app, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `ls ${run}` }, ...(agent_type ? { agent_type } : {}) });
  assert.equal(call('evident:evident-prover').status, 2);
  assert.equal(call('evident-prover').status, 2);
  assert.equal(call(undefined).status, 0, 'the main session');
  assert.equal(call('general-purpose').status, 0);
  const checker = guard('agent', { cwd: app, tool_name: 'Read', tool_input: { file_path: `${run}/evidence.jsonl` }, agent_type: 'evident:evident-checker' });
  assert.equal(checker.status, 2);
  assert.match(checker.stderr, /evident guard \(checker\)/);
});
