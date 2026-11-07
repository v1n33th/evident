import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { answersOf, stepQuestions } from '../../skills/show-your-work/scripts/questions.mjs';
import { newRequest, newStep } from '../../skills/show-your-work/scripts/run-folder.mjs';

const SCRIPT = fileURLToPath(new URL('../../skills/show-your-work/scripts/questions.mjs', import.meta.url));
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

const explored = () => {
  const project = mkdtempSync(join(tmpdir(), 'questions-'));
  const request = newRequest(project, 'invites', 'explore', new Date(2026, 10, 1, 9, 0));
  const step = newStep(request, 'explore', ['charters', 'evidence']);
  writeFileSync(join(step, 'charters', 'T1.jsonl'), jsonl([
    { n: 1, charter: 'T1', action: 'Send 10', result: 'as-expected' },
    { n: 2, charter: 'T1', action: 'Ask', result: 'question', note: 'Per org or per owner?', answers: ['Per org: shared', 'Per owner: each'] },
  ]) + 'not json\n');
  writeFileSync(join(step, 'charters', 'T2.jsonl'), jsonl([{ n: 4, charter: 'T2', action: 'Ask', result: 'question', note: 'Is 10 the limit?' }]));
  return { project, request, step };
};

test('each question gets a short id that stays the same, and two questions never share one', () => {
  const { step } = explored();
  const qs = stepQuestions(step);
  assert.deepEqual(qs.map((q) => [q.charter, q.note, q.answers.length]), [['T1', 'Per org or per owner?', 2], ['T2', 'Is 10 the limit?', 0]]);
  for (const q of qs) assert.match(q.id, /^Q-[0-9a-f]{4}$/);
  assert.notEqual(qs[0].id, qs[1].id);
  assert.deepEqual(stepQuestions(step).map((q) => q.id), qs.map((q) => q.id));
});

test('answer records the user\'s answer for the feature, and a later answer to the same question wins', () => {
  const { project, request, step } = explored();
  const [q] = stepQuestions(step);
  let r = spawnSync('node', [SCRIPT, project, q.id, 'Per', 'org'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`^Answered: ${q.id} \\(invites\\): Per org or per owner\\?\\nYou said: Per org\\nOpen: file://`));
  r = spawnSync('node', [SCRIPT, project, q.id.toUpperCase().replace('Q-', 'q-'), 'Per owner'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const answers = answersOf(join(project, 'invites'));
  assert.equal(answers.get(q.id).answer, 'Per owner');
  assert.equal(answers.get(q.id).question, 'Per org or per owner?');
  const page = readFileSync(join(request, 'report.html'), 'utf8');
  assert.match(page, /Your answers/);
  assert.match(page, /Per owner/);
});

test('answer names an unknown question and records nothing', () => {
  const { project } = explored();
  const r = spawnSync('node', [SCRIPT, project, 'Q-ffff', 'yes'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^Problem: no question Q-ffff in /);
  assert.equal(answersOf(join(project, 'invites')).size, 0);
});

test('answer without an answer says how to call it', () => {
  const { project, step } = explored();
  const r = spawnSync('node', [SCRIPT, project, stepQuestions(step)[0].id], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Usage: node questions\.mjs <project folder> <Q-id> <answer>/);
});

test('an answer rewrites every page of the feature that asked the same question, and opens the newest', () => {
  const { project, request, step } = explored();
  const later = newRequest(project, 'invites', 'explore-and-fix', new Date(2026, 10, 1, 13, 0));
  const again = newStep(later, 'explore', ['charters', 'evidence']);
  writeFileSync(join(again, 'charters', 'T1.jsonl'), readFileSync(join(step, 'charters', 'T1.jsonl')));
  const [q] = stepQuestions(step);
  const r = spawnSync('node', [SCRIPT, project, q.id, 'Per org'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Open: file:\/\/.*explore-and-fix\/report\.html/);
  for (const dir of [request, later]) assert.match(readFileSync(join(dir, 'report.html'), 'utf8'), /You said: <b>Per org<\/b>/);
});

test('answer runs when the skills folder is a link, as in a .claude/skills install', () => {
  const { project, step } = explored();
  const [q] = stepQuestions(step);
  const linked = join(mkdtempSync(join(tmpdir(), 'skills-link-')), 'scripts');
  symlinkSync(dirname(SCRIPT), linked);
  const r = spawnSync('node', [join(linked, 'questions.mjs'), project, q.id, 'Per org'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`^Answered: ${q.id} `));
});
