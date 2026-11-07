// Usage: node fix-claims.mjs <verify run> <ledger dir | none> [--spec <baseline run>] [--only <ids>] <bug folder>...
// Writes <verify run>/claims.json: one claim per fixed bug, from its expected and steps, plus every ledger claim that last
// held, to re-check, plus the baseline's spec claims the ledger does not hold yet, for their first proof. --only C3,C5 keeps
// just those copied claims (a re-check after an undo). With ledger none, --spec <verify run> --only <ids> copies those
// claims of the verify run as they are, ledger copies and bug claims too: a re-proof of exactly what verify proved.
// Writes <verify run>/fix-claims.json: [{ bug: <bug folder>, claim: <id> }], so the fix report never guesses.
// Each bug claim is a draft ("draft": true): its steps are how a tester found the bug, before any fix, and its expected is
// a tester's guess. It prints "Writer:" and the claim writer's prompt, filled in, so the writer finishes them.
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EMAIL as ADDRESS, allowedTargets, approvalView, LEGACY_TARGETS, listedViewports, projectDir, runTargets, where } from '../../show-your-work/scripts/build-proof.mjs';
import { readLedger, select } from '../../show-your-work/scripts/ledger.mjs';

const SEVERITY = ['critical', 'major', 'minor', 'cosmetic'];
const HEADLINE_LIMIT = 7;
// Claims go to the committed ledger, so no address from a bug's steps is kept: every address --plan would refuse,
// a bad actor's attack address included, becomes "a new address", and the writer describes it (CLAIMS-findings.md).
const EMAIL = new RegExp(ADDRESS.source, 'gi');
const clean = (text) => String(text ?? '').replace(EMAIL, 'a new address');
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
// Found in the browser but reproduced only by calling the API: a picture of a page shows nothing of it.
const call = (step) => /\b(GET|POST|PUT|PATCH|DELETE) (\/|https?:\/\/)/.test(step);
const apiOnly = (b) => (b.steps ?? []).some(call) && (b.steps ?? []).every((s) => call(s) || /^sign in\b/i.test(s));
// The fix changed what production does, on a sentence the user wrote: the claim is new behaviour, shown as a change.
const designed = (b) => b.fix?.inProduction === true && Boolean(b.fix?.source) && !/^broken:/.test(b.fix.source);

// Re-checks of a feature's claims that no patched file touches, per round. Bug claims carry their patch's files, so the
// ledger learns which code each claim rests on and the claims on a patched file are found by file, not by this cap.
const MAX_RECHECK = 8;

// The fix steps of the verify run's request folder.
const fixSteps = (verifyRun) => {
  const request = dirname(resolve(verifyRun));
  return existsSync(request) ? readdirSync(request).filter((d) => /^fix(-\d+)?$/.test(d)).map((d) => join(request, d)) : [];
};
// In auto mode a fix may change what a proven ledger claim says, and the writer writes that claim as changed (CLAIMS-findings.md).
export const autoOf = (verifyRun) => fixSteps(verifyRun).some((s) => { try { return readJson(join(s, 'rounds.json')).auto === true; } catch { return false; } });

// The files the bugs' patches touch: each patch's +++ b/ lines, the patch found in a fix step of the verify run's request folder.
export function patchedFiles(bugDirs, verifyRun) {
  const steps = fixSteps(verifyRun);
  const files = bugDirs.flatMap((dir) => {
    const patch = readJson(join(dir, 'bug.json')).fix?.patch;
    const file = patch && steps.map((s) => join(s, patch)).find((f) => existsSync(f));
    return file ? [...readFileSync(file, 'utf8').matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1].trim()) : [];
  });
  return [...new Set(files)];
}

export function fixClaims({ feature, ledgerDir, specRun = null, only = null, bugDirs, files = [], bugFiles = () => [], targets = null, rules = LEGACY_TARGETS(''), viewports = null }) {
  const evidence = (target) => rules[target]?.evidenceSummary;
  // Only the claims tagged with the feature or touching a patched file: never the whole ledger.
  const read = ledgerDir ? readLedger(ledgerDir) : { claims: [], problems: [] };
  // A conflicted ledger file would hide its claims and re-check nothing: refuse instead.
  if (read.problems.length) throw new Error(`the ledger has problems: ${read.problems.join('; ')}. Resolve them, then run again.`);
  const ledger = select(read.claims, { tags: [feature], files, ids: only ?? [] });
  // A claim that last failed would only fail again: its bug is already reported.
  const held = ledger.filter((c) => ['active', 'changed'].includes(c.status) && c.verdict === 'proven' && (!only || only.includes(c.id)));
  // Every claim on a patched file is re-checked; of the feature's others, the first MAX_RECHECK as select ranks them,
  // so a round's cost follows what the fixes touched, not the size of the feature.
  const onFiles = new Set(select(held, { files }).map((c) => c.id));
  const others = held.filter((c) => !onFiles.has(c.id));
  const left = only ? 0 : Math.max(0, others.length - MAX_RECHECK);
  const copied = (only ? held : [...held.filter((c) => onFiles.has(c.id)), ...others.slice(0, MAX_RECHECK)]).map(({ verdict, home, ...c }) => ({ ...c, area: null, rank: 'routine', fromLedger: true, status: 'active', changed: null, check: null, evidence: evidence(c.target) }));
  // Spec claims were approved but never proven: they keep their wording and are checked like this run's own claims.
  // A verify run's claims, re-proven after an undo, keep theirs too: a changed claim, and whether it came from the ledger.
  const specFile = specRun && join(specRun, 'claims.json');
  const spec = (specFile && existsSync(specFile) ? readJson(specFile).claims ?? [] : [])
    .filter((c) => c.status !== 'retired' && !ledger.some((l) => l.id === c.id) && (!only || only.includes(c.id)))
    .map((c) => ({ ...c, rank: 'routine', fromLedger: Boolean(c.fromLedger), check: null, evidence: evidence(c.target) }));
  let next = Math.max(0, ...[...ledger, ...spec].map((c) => Number(String(c.id).slice(1)) || 0)) + 1;

  const sharedWith = (b) => String(b.fix?.summary ?? '').match(/^Fixed with (BUG-\d+)/)?.[1];
  const named = bugDirs.map((dir) => ({ dir: resolve(dir), ...readJson(join(dir, 'bug.json')) }));
  // A bug fixed with another bug ("Fixed with BUG-003") is proven by that bug's claim, so it comes along even when not named.
  const along = named.flatMap((b) => readdirSync(dirname(b.dir), { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dirname(b.dir), d.name, 'bug.json')))
    .map((d) => ({ dir: join(dirname(b.dir), d.name), ...readJson(join(dirname(b.dir), d.name, 'bug.json')) }))
    .filter((o) => sharedWith(o) === b.id && ['fixed', 'partly-fixed'].includes(o.fix?.status)));
  const bugs = [...named, ...along].filter((b, i, all) => all.findIndex((o) => o.dir === b.dir) === i);
  const owner = (b) => bugs.find((o) => o.id === sharedWith(b) && dirname(o.dir) === dirname(b.dir)) ?? b;
  const own = bugs.filter((b) => owner(b) === b);
  const byBug = new Map(own.map((b) => [b, { id: `C${next++}`, sharers: [b, ...bugs.filter((o) => o !== b && owner(o) === b)] }]));
  const headline = new Set([...own].filter((b) => ['critical', 'major'].includes(b.severity))
    .sort((a, b) => SEVERITY.indexOf(a.severity) - SEVERITY.indexOf(b.severity)).slice(0, Math.max(0, HEADLINE_LIMIT - own.filter(designed).length)));

  const fresh = own.map((b) => {
    const { id, sharers } = byBug.get(b);
    const target = apiOnly(b) && targets?.includes('api') ? 'api' : b.target ?? 'web';
    // The explorer's account has used up its limits, so the prover starts from a new account of the same kind.
    const key = b.account && b.account !== 'signed out' ? b.account : null;
    const step = (o) => (text) => (o.account && o.account !== 'signed out' ? clean(text).split(o.account).join('the new account') : clean(text));
    // The files its patch touches: the ledger keeps them, so a later round re-checks this claim when one of them changes.
    const patched = bugFiles(sharers.map((o) => o.dir));
    return {
      id, tags: [feature], area: null, target, rank: headline.has(b) ? 'headline' : 'routine', status: designed(b) ? 'changed' : 'active', fromLedger: false,
      statement: clean(b.expected),
      given: key ? `A new account of the same kind as \`${clean(key)}\`, signed up today; the steps start there.` : 'As the bug\'s steps start.',
      setup: rules[target]?.provenBy === 'picture' ? 'UI only' : 'the steps only',
      // One patch can fix different failures: each bug it fixes gets its own case.
      cases: sharers.map((o, i) => ({ id: String.fromCharCode(97 + i), do: (o.steps ?? []).map(step(o)).join('; then '), expect: clean(o.expected) })),
      evidence: evidence(target),
      ...(rules[target]?.viewports && b.viewport && b.viewport !== 'desktop' && { viewports: [b.viewport] }),
      proof: 'will',
      risk: clean(`${b.severity} ${b.kind} comes back: ${b.title}`),
      source: `found: ${sharers.map((s) => s.id).join(', ')}`,
      ...(patched.length && { files: patched }),
      check: null, retiredReason: null, draft: true,
      changed: designed(b) ? { from: clean(b.actual), at: new Date().toISOString().slice(0, 10), why: `your words: "${clean(b.fix.source)}"` } : null,
    };
  });
  const doc = {
    feature, title: `Fixes of ${feature}`, input: `fixed bugs ${bugs.map((b) => b.id).join(', ')}`, approvedAt: null, terms: [],
    covers: [
      { area: 'fixed bugs', claims: fresh.map((c) => c.id) },
      ...(copied.length ? [{ area: 'ledger re-check', claims: copied.map((c) => c.id) }] : []),
      ...(spec.length ? [{ area: 'spec, first proof', claims: spec.map((c) => c.id) }] : []),
    ],
    willNotProve: `behaviour the fixed bugs, the ledger and the spec do not name${left ? `; ${left} more ledger claims tagged ${feature}, not on the changed files` : ''}`, areas: [], claims: [...fresh, ...copied, ...spec],
  };
  // The claim writer rewords what --plan would refuse; nobody else writes claim text.
  const problems = approvalView(doc, { targets, viewports, rules }).problems;
  const writer = own.filter((b) => problems.some((p) => p.startsWith(`${byBug.get(b).id}:`) || p.startsWith(`${byBug.get(b).id} case`))).flatMap((b) => byBug.get(b).sharers.map((o) => o.dir));
  return { doc, map: bugs.map((b) => ({ bug: b.dir, claim: byBug.get(owner(b)).id })), writer };
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  const [run, ledgerDir, ...rest] = process.argv.slice(2);
  const flags = {};
  while (['--spec', '--only'].includes(rest[0])) flags[rest.shift()] = rest.shift();
  const specRun = flags['--spec'] ?? null;
  const only = flags['--only']?.split(',').map((id) => id.trim()).filter(Boolean) ?? null;
  const bugDirs = rest;
  // --spec (round 1 with no fix) and --only (a re-check) may come without bug folders.
  if (!run || !ledgerDir || (!bugDirs.length && !specRun && !only) || Object.values(flags).some((v) => !v)) {
    console.error('Usage: node fix-claims.mjs <verify run> <ledger dir | none> [--spec <baseline run>] [--only <ids>] <bug folder>...');
    process.exit(1);
  }
  const project = projectDir(run);
  const env = existsSync(join(project, 'environment.md')) ? readFileSync(join(project, 'environment.md'), 'utf8') : '';
  let result;
  try {
    result = fixClaims({ feature: where(run)?.feature ?? basename(dirname(resolve(run))), ledgerDir: ledgerDir === 'none' ? null : ledgerDir, specRun, only, bugDirs, files: patchedFiles(bugDirs, run), bugFiles: (dirs) => patchedFiles(dirs, run), targets: allowedTargets(run, env), rules: runTargets(run), viewports: listedViewports(env) });
  } catch (error) {
    console.error(`  Problem: ${error.message}`);
    process.exit(1);
  }
  const { doc, map, writer } = result;
  writeFileSync(join(run, 'claims.json'), JSON.stringify(doc, null, 2) + '\n');
  writeFileSync(join(run, 'fix-claims.json'), JSON.stringify(map, null, 2) + '\n');
  console.log(`Wrote ${doc.claims.length} claims: ${doc.covers.map((c) => `${c.claims.length} ${c.area}`).join(', ')}`);
  // The verify run's request and the requests its bugs came from show the new claims and links.
  const { writeReportFor } = await import('../../show-your-work/scripts/report.mjs');
  await writeReportFor(run, ...bugDirs);
  if (writer.length) {
    const code = env.match(/^- Code:[ \t]*(.+)$/m)?.[1].trim();
    console.log([
      'Writer: the bug claims are drafts. Dispatch the claim writer once with exactly this prompt:',
      `Read ${resolve(dirname(fileURLToPath(import.meta.url)), '../../show-your-work/CLAIMS.md')} and ${resolve(dirname(fileURLToPath(import.meta.url)), '../../show-your-work/CLAIMS-findings.md')} and follow them.`,
      `Run folder: ${resolve(run)}`, `Project folder: ${project}`, `Skill directory: ${resolve(dirname(fileURLToPath(import.meta.url)), '../../show-your-work')}`,
      `Code path: ${!code || /^none\b/i.test(code) ? 'none' : code}`, 'Diff command: none', `Ledger dir: ${ledgerDir}`, `Findings: ${writer.join(', ')}`, `Auto: ${autoOf(run) ? 'yes' : 'no'}`,
    ].join('\n'));
  }
}
