import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeSessions, orphanPids, recordedSessions, stopOrphans } from '../../skills/evidence/scripts/sessions.mjs';
import { writeSnapshot } from '../../skills/evidence/scripts/definitions.mjs';

// A project folder (app name "acme"), a request and a step folder, with a fake driver whose list prints a file and whose
// close appends the session it closes to closed.txt, so no real browser is touched.
function makeRun({ listed = [], close = true, command = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sessions-'));
  const project = join(root, 'acme');
  const run = join(project, 'invites', '2026-11-05-1200-prove', 'proof');
  mkdirSync(join(run, 'sessions'), { recursive: true });
  mkdirSync(join(project, 'drivers'), { recursive: true });
  const listFile = join(root, 'listed.txt');
  const closed = join(root, 'closed.txt');
  writeFileSync(listFile, ['Active sessions:', ...listed.map((n) => `  ${n}`)].join('\n') + '\n');
  writeFileSync(join(project, 'drivers', 'fakeb.md'), [
    '---', 'name: fakeb', 'targets: web', 'methods: screenshots', 'shell: yes', 'check: true', 'parallel: yes with --session',
    'command: fakeb --session <app-name>-<session>', `list: cat '${listFile}'`,
    ...(close ? [`close: printf '%s\\n' <name> >> '${closed}'`] : []),
    'orphans: agent-browser-chrome-', '---', '## Weak spots', 'none', '## Forms', 'none', '',
  ].join('\n'));
  writeFileSync(join(project, 'environment.md'), `## Targets\n- Web: http://localhost:3000\n\n## Evidence\n- Web: screenshots · driver: fakeb\n${command ? `\n## Drivers\n- fakeb: ${command}\n` : ''}`);
  writeSnapshot(run, project, { home: root });
  const read = () => (existsSync(closed) ? readFileSync(closed, 'utf8').trim().split('\n') : []);
  return { root, project, run, read };
}

const noOrphans = { ps: () => '', kill: () => assert.fail('no process may be signalled') };

test('recordedSessions reads every session id the step folder holds, once each', () => {
  const { run } = makeRun();
  writeFileSync(join(run, 'charters.json'), JSON.stringify({ charters: [{ id: 'T1' }, { id: 'T2' }] }));
  mkdirSync(join(run, 'charters'));
  writeFileSync(join(run, 'charters', 'T1.jsonl'), '');
  writeFileSync(join(run, 'sessions', '01-web-owner.jsonl'), '');
  writeFileSync(join(run, 'sessions', '02-web-member.claims.json'), '{}');
  writeFileSync(join(run, 'evidence-03-api-owner.jsonl'), '');
  writeFileSync(join(run, 'evidence-check.jsonl'), '');
  writeFileSync(join(run, 'evidence.jsonl'), '');
  assert.deepEqual(recordedSessions(run), ['01-web-owner', '02-web-member', '03-api-owner', 'T1', 'T2']);
});

test('close with no ids closes this run\'s listed sessions only', () => {
  const { run, read } = makeRun({ listed: ['acme-T1', 'acme-01-web-owner', 'acme-eval-r2-T1', 'other-T1'] });
  writeFileSync(join(run, 'charters.json'), JSON.stringify({ charters: [{ id: 'T1' }, { id: 'T2' }] }));
  writeFileSync(join(run, 'sessions', '01-web-owner.jsonl'), '');
  const lines = closeSessions(run, null, noOrphans);
  assert.deepEqual(read(), ['acme-01-web-owner', 'acme-T1'], 'T2 is not open, and another run\'s sessions stay');
  assert.deepEqual(lines, ['Closed acme-01-web-owner', 'Closed acme-T1']);
});

test('close with ids closes just those, and skips one that is not open', () => {
  const { run, read } = makeRun({ listed: ['acme-T1', 'acme-T2'] });
  assert.deepEqual(closeSessions(run, ['T2', 'T9'], noOrphans), ['Closed acme-T2']);
  assert.deepEqual(read(), ['acme-T2']);
});

test('a driver with no close form closes nothing', () => {
  const { run, read } = makeRun({ listed: ['acme-T1'], close: false });
  assert.deepEqual(closeSessions(run, ['T1'], noOrphans), []);
  assert.deepEqual(read(), []);
});

test('the session name and the close come from the run\'s own command, not the definition\'s', () => {
  const { run, read } = makeRun({ listed: ['acme-app-T1'], command: 'fakeb --no-x --session acme.app-<session>' });
  assert.deepEqual(closeSessions(run, ['T1'], noOrphans), ['Closed acme-app-T1']);
  assert.deepEqual(read(), ['acme-app-T1']);
});

test('an explorer\'s named session comes from its saved fields', () => {
  const { run, read } = makeRun({ listed: ['acme-eval-r3-T1', 'acme-T1'] });
  writeFileSync(join(run, 'charters.json'), JSON.stringify({ charters: [{ id: 'T1' }] }));
  mkdirSync(join(run, 'charters'));
  writeFileSync(join(run, 'charters', '.T1.json'), JSON.stringify({ browserSession: 'acme-eval-r3-T1' }));
  closeSessions(run, null, noOrphans);
  assert.deepEqual(read(), ['acme-T1', 'acme-eval-r3-T1']);
});

test('with a run name, a run-wide close also closes every listed session with its prefix, and no other', () => {
  const { run, read } = makeRun({ listed: ['acme-eval-r3-P1', 'acme-eval-r3-N2', 'acme-eval-r2-P1', 'acme-eval-r30-P1'] });
  closeSessions(run, null, { ...noOrphans, name: 'eval-r3' });
  assert.deepEqual(read().sort(), ['acme-eval-r3-N2', 'acme-eval-r3-P1']);
});

test('orphanPids takes only a main test browser with an agent-browser profile whose parent is gone', () => {
  const app = '/Users/x/.agent-browser/browsers/chrome-153/Google Chrome for Testing.app/Contents';
  const ps = [
    `  101     1 ${app}/MacOS/Google Chrome for Testing --remote-debugging-port=0 --user-data-dir=/var/T/agent-browser-chrome-aa`,
    `  102   900 ${app}/MacOS/Google Chrome for Testing --user-data-dir=/var/T/agent-browser-chrome-bb`,
    `  103     1 ${app}/Frameworks/Helpers/chrome_crashpad_handler --monitor-self --database=/var/T/agent-browser-chrome-bb/Crashpad`,
    `  104     1 ${app}/Frameworks/Helpers/Google Chrome for Testing Helper (Renderer) --type=renderer --user-data-dir=/var/T/agent-browser-chrome-aa`,
    '  105     1 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/Users/x/Library/Chrome',
    '  106     1 /Users/x/.nvm/bin/agent-browser-darwin-arm64',
  ].join('\n');
  assert.deepEqual(orphanPids(ps, 'agent-browser-chrome-'), [101]);
});

test('stopOrphans sends TERM, then KILL to one that outlives the wait', () => {
  const sent = [];
  const alive = new Set([101, 102]);
  const kill = (pid, signal) => {
    if (signal === 0) { if (!alive.has(pid)) throw new Error('ESRCH'); return true; }
    sent.push([pid, signal]);
    if (signal === 'SIGTERM' && pid === 101) alive.delete(101);
    if (signal === 'SIGKILL') alive.delete(pid);
    return true;
  };
  assert.deepEqual(stopOrphans([101, 102], { kill, wait: 50 }), ['Stopped orphan browser 101', 'Killed orphan browser 102']);
  assert.deepEqual(sent, [[101, 'SIGTERM'], [102, 'SIGTERM'], [102, 'SIGKILL']]);
});

test('close with no ids also stops orphan browsers; with ids it leaves them', () => {
  const { run } = makeRun();
  const ps = () => '  101     1 /x/MacOS/Google Chrome for Testing --user-data-dir=/var/T/agent-browser-chrome-aa\n';
  const gone = new Set();
  const kill = (pid, signal) => { if (signal === 0) { if (gone.has(pid)) throw new Error('ESRCH'); return true; } gone.add(pid); return true; };
  assert.deepEqual(closeSessions(run, ['T1'], { ps, kill }), []);
  assert.deepEqual(closeSessions(run, null, { ps, kill }), ['Stopped orphan browser 101']);
});
