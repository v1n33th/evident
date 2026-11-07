// Usage: node questions.mjs <project folder> <Q-id> <answer>
// Product questions explorers logged, each with a short id that never changes, and the user's answers to them.
// The answer command records an answer in <project folder>/<feature>/answers.jsonl, the latest answer to a question
// winning, and rewrites that request's report.html. Explorers and the claims writer read answers.jsonl.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const lines = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').flatMap((l) => { try { const r = JSON.parse(l); return r && typeof r === 'object' ? [r] : []; } catch { return []; } }) : []);
const dirs = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(dir, e.name)).sort() : []);

// A step's questions, in charter order. The id rests on the step, the charter, the step number and the words,
// none of which change once logged, so it stays the same on every page and in every chat summary.
export function stepQuestions(step) {
  const dir = join(step, 'charters');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort().flatMap((f) => lines(join(dir, f)).filter((r) => r.result === 'question').map((r) => {
    const charter = r.charter ?? f.replace(/\.jsonl$/, '');
    const note = String(r.note ?? r.action ?? '');
    const id = `Q-${createHash('sha256').update(`${basename(step)}/${charter}/${r.n ?? ''}/${note}`).digest('hex').slice(0, 4)}`;
    return { id, charter, note, answers: Array.isArray(r.answers) ? r.answers.map(String) : [] };
  }));
}

// The feature's answers by question id; a later answer replaces an earlier one.
export const answersOf = (feature) => new Map(lines(join(feature, 'answers.jsonl')).filter((a) => a.id && a.answer).map((a) => [a.id, a]));

// Chat summary lines for open questions, each with its id, and once how to answer one.
export const openQuestionLines = (questions, where) => (questions.length ? [
  ...questions.map((q) => `? ${q.id} ${where(q)}: ${q.note}${q.answers?.length ? ` (suggested by the skill: ${q.answers.join(' | ')})` : ''}`),
  'Answer one in chat: answer <Q-id>: <your answer>',
] : []);

async function main([project, id, ...words]) {
  if (!project || !id || !words.length) { console.error('Usage: node questions.mjs <project folder> <Q-id> <answer>'); process.exit(2); }
  const want = `Q-${id.slice(2).toLowerCase()}`;
  // The same question can sit in several requests of a feature; one answer counts for all, so every such page is rewritten.
  for (const feature of dirs(resolve(project)).filter((f) => basename(f) !== 'ledger')) {
    const asked = dirs(feature).filter((r) => /^\d{4}-\d{2}-\d{2}-\d{4}-/.test(basename(r)))
      .map((r) => [r, dirs(r).flatMap(stepQuestions).find((x) => x.id === want)]).filter(([, q]) => q);
    if (!asked.length) continue;
    const [newest, q] = asked.at(-1);
    const answer = words.join(' ').trim();
    appendFileSync(join(feature, 'answers.jsonl'), `${JSON.stringify({ id: want, question: q.note, answer, request: basename(newest), at: new Date().toISOString() })}\n`);
    const { writeReport } = await import('./report.mjs');
    for (const [r] of asked) await writeReport(r);
    console.log(`Answered: ${want} (${basename(feature)}): ${q.note}\nYou said: ${answer}\nOpen: ${pathToFileURL(join(newest, 'report.html')).href}`);
    return;
  }
  console.log(`Problem: no question ${want} in ${resolve(project)}`);
  process.exit(1);
}

// Not awaited: report.mjs imports this module back, and a top-level await would never settle.
// realpath: an install that links the skills folder (.claude/skills -> repo) must still run main.
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) main(process.argv.slice(2));
