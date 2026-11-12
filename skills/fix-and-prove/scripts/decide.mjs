// Usage: node decide.mjs <step folder> <BUG-NNN or C-id> <decision>   (one "decide <id> of <step folder>: <decision>" line from a page)
// Records the user's decision on the bug as fix.decided, and in the feature's answers.jsonl so later runs know it, then
// rewrites the request's page. Prints what is left: "Fix:" (a fixer acts on it), "Undo:" (revert the fix), or nothing to do.
// On a check that failed or could not be proven: "Prove:" (prove that run again), "Kept:", or "Fix:" for each bug filed for
// it, filing one from its failed case when there is none, so the fix run has a bug folder to work on.
import { appendFileSync, existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const KEEP = ['No, keep it as it is', 'Leave it as it is'];

// A patch path is relative to the fix step that wrote it (fix, fix-2, ...): the absolute path of the one that holds it.
const patchPath = (request, patch) => readdirSync(request).filter((n) => /^fix(-\d+)?$/.test(n)).map((n) => join(request, n, patch)).find(existsSync) ?? patch;

// Retires ledger claims with a reason; prints which. A claim already retired, or not in the ledger, is left alone.
async function retire(step, ids, reason) {
  const { readLedger, writeClaims } = await import('../../show-your-work/scripts/ledger.mjs');
  const dir = join(dirname(dirname(dirname(step))), 'ledger');
  const { claims } = readLedger(dir);
  const mine = claims.filter((x) => ids.includes(x.id) && x.status !== 'retired');
  for (const c of mine) Object.assign(c, { status: 'retired', retiredReason: reason });
  for (const home of new Set(mine.map((c) => c.home))) writeClaims(dir, home, claims.filter((x) => x.home === home));
  return mine.length ? `Retired: ${mine.map((c) => c.id).join(', ')} in the ledger` : '';
}

// Every bug folder of the request, with its record.
const requestBugs = (request) => readdirSync(request, { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(join(request, e.name, 'bugs')))
  .flatMap((e) => readdirSync(join(request, e.name, 'bugs')).filter((n) => existsSync(join(request, e.name, 'bugs', n, 'bug.json')))
    .map((n) => ({ step: join(request, e.name), folder: join(request, e.name, 'bugs', n) })));

const record = async (step, entry) => {
  const request = dirname(step);
  appendFileSync(join(dirname(request), 'answers.jsonl'), `${JSON.stringify({ ...entry, id: `${basename(request)}/${basename(step)}/${entry.id}`, request: basename(request) })}\n`);
  const { writeReport } = await import('../../show-your-work/scripts/report.mjs');
  await writeReport(request);
};

async function decideCheck(step, stepDir, id, words) {
  let claims = [];
  try { claims = JSON.parse(readFileSync(join(step, 'result.json'), 'utf8')).data?.claims ?? []; } catch {}
  const c = claims.find((x) => x.id === id);
  if (!c) return { ok: false, out: `Problem: no ${id} in ${stepDir}` };
  const at = new Date().toISOString();
  let out;
  // "Leave it as it is: <why>" carries the user's reason, which the retired claim keeps.
  // The page's words and the older ones: "Drop this test" was "Leave it as it is", "Test again" was "Prove it again".
  const [, why] = /^(?:Leave it as it is|Drop this test)(?::\s*(.+))?$/s.exec(words) ?? [];
  if (/^(Leave it as it is|Drop this test)(:|$)/.test(words)) {
    out = `Kept: ${id} stays as it is`;
    // Leaving a failed check means the claim was wrong, not the app: retire it, so later proofs stop re-checking it.
    const line = await retire(step, [id], `You left it as it is on the page of ${basename(dirname(step))}, ${at.slice(0, 10)}${why ? `: ${why.trim()}` : ''}`);
    if (line) out += `\n${line}`;
  }
  else if (words === 'Prove it again' || words === 'Test again') out = `Prove: ${id} of ${relative(process.cwd(), step)}`;
  else {
    const bugs = join(step, 'bugs');
    const read = (n) => JSON.parse(readFileSync(join(bugs, n, 'bug.json'), 'utf8'));
    let names = existsSync(bugs) ? readdirSync(bugs).filter((n) => existsSync(join(bugs, n, 'bug.json')) && read(n).claim === id) : [];
    if (!names.length) {
      // No prover filed one: the check's failed case is the bug.
      const f = c.cases?.find((x) => x.result === 'fail') ?? c.cases?.find((x) => x.result !== 'pass') ?? {};
      // A decision changes no verdict: keep the step's checked result current, or its checks would show as still being checked.
      const { readResult, writeResult } = await import('../../show-your-work/scripts/report.mjs');
      const fresh = readResult(step);
      const { newBug } = await import('../../evidence/scripts/new-bug.mjs');
      const slug = c.statement.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40).replace(/-$/, '');
      const { id: bugId, folder } = newBug(step, slug);
      writeFileSync(join(folder, 'bug.json'), `${JSON.stringify({ id: bugId, claim: id, case: f.id ?? null, kind: 'bug', title: `Does not hold: ${c.statement}`,
        steps: f.do ? [f.do] : [], expected: f.expect ?? c.statement, actual: f.actual ?? f.note ?? 'The check did not hold.' }, null, 2)}\n`);
      names = [basename(folder)];
      if (fresh) writeResult(step, fresh);
    }
    for (const n of names) {
      const b = read(n);
      const fix = { ...(b.fix ?? {}), decided: words, decidedAt: at };
      if (fix.status === 'wont-fix') fix.status = 'needs-decision';
      writeFileSync(join(bugs, n, 'bug.json'), `${JSON.stringify({ ...b, fix }, null, 2)}\n`);
    }
    out = names.map((n) => `Fix: ${relative(process.cwd(), join(bugs, n))}`).join('\n');
  }
  await record(step, { id, question: c.statement, answer: words, at });
  return { ok: true, out };
}

export async function decide(stepDir, id, words) {
  const step = resolve(stepDir);
  if (/^C-/.test(id)) return decideCheck(step, stepDir, id, words);
  const name = existsSync(join(step, 'bugs')) && readdirSync(join(step, 'bugs')).find((n) => n === id || n.startsWith(`${id}-`));
  if (!name) return { ok: false, out: `Problem: no ${id} in ${stepDir}` };
  const folder = join(step, 'bugs', name);
  const b = JSON.parse(readFileSync(join(folder, 'bug.json'), 'utf8'));
  const fix = { ...(b.fix ?? {}), decided: words, decidedAt: new Date().toISOString() };
  const request = dirname(step);
  const undo = () => `Undo: ${id} ${fix.commit ? `commit ${fix.commit}` : `patch ${patchPath(request, fix.patch)}`}`;
  const [, invalid] = /^Not a bug(?::\s*(.+))?$/s.exec(words) ?? [];
  let out;
  if (/^Not a bug(:|$)/.test(words)) {
    // Not a bug: it works as intended. Kept as it is, a fix made for it undone, and its tests retired with the reason, so later
    // runs neither test nor file it again; the reason goes to answers.jsonl, which testers and claim writers read.
    const made = ['fixed', 'partly-fixed'].includes(fix.status) && (fix.commit || fix.patch);
    Object.assign(fix, { status: 'wont-fix', invalid: invalid?.trim() || true });
    const proofs = readdirSync(request).filter((n) => existsSync(join(request, n, 'fix-claims.json')))
      .flatMap((n) => { try { return JSON.parse(readFileSync(join(request, n, 'fix-claims.json'), 'utf8')); } catch { return []; } })
      .filter((l) => { try { return realpathSync(l.bug) === realpathSync(folder); } catch { return false; } }).map((l) => l.claim);
    const line = await retire(step, [...new Set([b.claim, ...proofs].filter(Boolean))], `Not a bug${invalid ? `: ${invalid.trim()}` : ''}`);
    out = [`Not a bug: ${id}`, made && undo(), line].filter(Boolean).join('\n');
  }
  else if (KEEP.includes(words)) { fix.status = 'wont-fix'; out = `Kept: ${id} won't be fixed`; }
  else if (words === 'Ship it') out = `Shipped: ${id}`;
  else if (words === 'Prove it again' || words === 'Test again') out = `Prove: ${id} of ${relative(process.cwd(), step)}`;
  else if (words === 'Undo the fix') { fix.status = 'wont-fix'; out = undo(); }
  else {
    // A fix asked for on a bug left wont-fix ("Fix it anyway") is pending again, or the fix run would skip it.
    if (fix.status === 'wont-fix') fix.status = 'needs-decision';
    out = `Fix: ${relative(process.cwd(), folder)}`;
  }
  writeFileSync(join(folder, 'bug.json'), `${JSON.stringify({ ...b, fix }, null, 2)}\n`);
  // One change can fix several bugs ("Fixed with BUG-010"): the decision covers each, so none asks again.
  const same = (o) => (b.fix?.patch && o.fix?.patch === b.fix.patch) || (b.fix?.commit && o.fix?.commit === b.fix.commit);
  for (const o of requestBugs(request).filter((x) => x.folder !== folder)) {
    const ob = JSON.parse(readFileSync(join(o.folder, 'bug.json'), 'utf8'));
    if (!same(ob)) continue;
    writeFileSync(join(o.folder, 'bug.json'), `${JSON.stringify({ ...ob, fix: { ...ob.fix, decided: words, decidedAt: fix.decidedAt, ...(fix.status !== b.fix?.status ? { status: fix.status } : {}), ...(fix.invalid ? { invalid: fix.invalid } : {}) } }, null, 2)}\n`);
    out += `\nAlso ${ob.id} of ${relative(process.cwd(), o.step)}: the same change`;
  }
  await record(step, { id, question: `${b.title}${b.fix?.decision ? `: ${b.fix.decision}` : ''}`, answer: words, at: fix.decidedAt });
  return { ok: true, out };
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  const [step, id, ...words] = process.argv.slice(2);
  if (!step || !id || !words.length) { console.error('Usage: node decide.mjs <step folder> <BUG-NNN or C-id> <decision>'); process.exit(2); }
  const r = await decide(step, id, words.join(' ').trim());
  console.log(r.out);
  if (!r.ok) process.exit(1);
}
