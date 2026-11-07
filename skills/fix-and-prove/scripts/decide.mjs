// Usage: node decide.mjs <step folder> <BUG-NNN> <decision>   (one "decide BUG-NNN of <step folder>: <decision>" line from a page)
// Records the user's decision on the bug as fix.decided, and in the feature's answers.jsonl so later runs know it, then
// rewrites the request's page. Prints what is left: "Fix:" (a fixer acts on it), "Undo:" (revert the fix), or nothing to do.
import { appendFileSync, existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const KEEP = ['No, keep it as it is', 'Leave it as it is'];

// A patch path is relative to the fix step that wrote it (fix, fix-2, ...): the absolute path of the one that holds it.
const patchPath = (request, patch) => readdirSync(request).filter((n) => /^fix(-\d+)?$/.test(n)).map((n) => join(request, n, patch)).find(existsSync) ?? patch;

export async function decide(stepDir, id, words) {
  const step = resolve(stepDir);
  const name = existsSync(join(step, 'bugs')) && readdirSync(join(step, 'bugs')).find((n) => n === id || n.startsWith(`${id}-`));
  if (!name) return { ok: false, out: `Problem: no ${id} in ${stepDir}` };
  const folder = join(step, 'bugs', name);
  const b = JSON.parse(readFileSync(join(folder, 'bug.json'), 'utf8'));
  const fix = { ...(b.fix ?? {}), decided: words, decidedAt: new Date().toISOString() };
  let out;
  if (KEEP.includes(words)) { fix.status = 'wont-fix'; out = `Kept: ${id} won't be fixed`; }
  else if (words === 'Ship it') out = `Shipped: ${id}`;
  else if (words === 'Undo the fix') { fix.status = 'wont-fix'; out = `Undo: ${id} ${fix.commit ? `commit ${fix.commit}` : `patch ${patchPath(dirname(step), fix.patch)}`}`; }
  else {
    // A fix asked for on a bug left wont-fix ("Fix it anyway") is pending again, or the fix run would skip it.
    if (fix.status === 'wont-fix') fix.status = 'needs-decision';
    out = `Fix: ${relative(process.cwd(), folder)}`;
  }
  writeFileSync(join(folder, 'bug.json'), `${JSON.stringify({ ...b, fix }, null, 2)}\n`);
  const request = dirname(step);
  appendFileSync(join(dirname(request), 'answers.jsonl'), `${JSON.stringify({ id: `${basename(request)}/${basename(step)}/${id}`,
    question: `${b.title}${b.fix?.decision ? `: ${b.fix.decision}` : ''}`, answer: words, request: basename(request), at: fix.decidedAt })}\n`);
  const { writeReport } = await import('../../show-your-work/scripts/report.mjs');
  await writeReport(request);
  return { ok: true, out };
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  const [step, id, ...words] = process.argv.slice(2);
  if (!step || !id || !words.length) { console.error('Usage: node decide.mjs <step folder> <BUG-NNN> <decision>'); process.exit(2); }
  const r = await decide(step, id, words.join(' ').trim());
  console.log(r.out);
  if (!r.ok) process.exit(1);
}
