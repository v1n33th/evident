// Usage: node build-fix-report.mjs <fix-run>                        Writes <fix-run>/result.json and the request's report.html, and prints the chat summary.
//        node build-fix-report.mjs <fix-run> --verdicts <proof-run>  Prints one JSON line per claim of a proof run: id, source, fromLedger, verdict, and the bug folders it proves.
// A fix run holds rounds.json: { feature, production, auto, autoFixes, fixCommits, baseline, rounds: [{ n, explore, verify, extra?, only?, reproofs?, flaky? }] }, each a run folder path;
// reproofs are the rollback's re-proof runs, oldest first.
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildProof, settled, where } from '../../show-your-work/scripts/build-proof.mjs';
import { answersOf, openQuestionLines, stepQuestions } from '../../show-your-work/scripts/questions.mjs';
import { riskAllowed } from './fix-gate.mjs';

const RISK = ['very-high', 'high', 'medium', 'low'];
const DONE = ['fixed', 'partly-fixed'];
const NEEDS = {
  fixed: ['summary', 'rootCause', 'files', 'differs', 'impact', 'risk', 'riskReason', 'patch'],
  'partly-fixed': ['summary', 'rootCause', 'files', 'differs', 'impact', 'risk', 'riskReason', 'patch'],
  'needs-decision': ['summary', 'decision'],
  'not-fixed': ['summary', 'decision'],
  'wont-fix': ['summary', 'decision'],
};
// A bug fixed with another bug ("Fixed with BUG-003") keeps only these; the full record is on that bug.
const SHARED = ['summary', 'risk', 'riskReason', 'patch'];
const sharedFix = (fix) => DONE.includes(fix.status) && /^Fixed with BUG-\d+/.test(String(fix.summary ?? ''));
// The worst verdict wins when several claims name one bug.
const WORST = ['disproved', 'not-proven', 'proven'];

// Evidence of another run folder, with its file as an absolute path, so the report can link it from the fix run.
const absolute = (run, list) => list.map((e) => ({ ...e, file: resolve(run, String(e.file)) }));

// Bug folder → claim id, as fix-claims.mjs wrote it into the verify run. Paths compare after resolving links (/tmp, /private/tmp).
const real = (path) => { try { return realpathSync(path); } catch { return resolve(path); } };
const linksOf = (verifyRun) => { const file = join(verifyRun, 'fix-claims.json'); return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : []; };
const claimOf = (verifyRun) => new Map(linksOf(verifyRun).map((l) => [real(l.bug), l.claim]));

// A claim the rollback re-proved ends with the re-proofs' verdict, as the ledger records it, and that run's evidence.
export function claimVerdicts(proofRun, later = []) {
  const again = later.map((run) => ({ run, claims: buildProof(run).data.claims }));
  return buildProof(proofRun).data.claims.map((c) => {
    const hits = again.map(({ run, claims }) => ({ run, k: claims.find((k) => k.id === c.id) })).filter(({ k }) => k);
    const verdict = settled(c.verdict, hits.map(({ k }) => k.verdict));
    const from = verdict !== c.verdict && hits.reverse().find(({ k }) => k.verdict === verdict);
    return {
      id: c.id, statement: c.statement, source: c.source ?? null, fromLedger: Boolean(c.fromLedger), verdict, evidence: from ? absolute(from.run, from.k.evidence) : absolute(proofRun, c.evidence),
    };
  });
}

// autoFixes: the run's Auto fixes level, as rounds.json records it (SKILL.md §1 step 7).
export function fixProblems(bug, autoFixes = 'off') {
  if (!bug.fix) return [`${bug.id}: no fix record`];
  const needs = sharedFix(bug.fix) ? SHARED : NEEDS[bug.fix.status];
  if (!needs) return [`${bug.id}: unknown fix status ${bug.fix.status}`];
  const missing = needs.filter((f) => bug.fix[f] == null || bug.fix[f] === '' || (Array.isArray(bug.fix[f]) && !bug.fix[f].length));
  const problems = missing.length ? [`${bug.id}: fix record misses ${missing.join(', ')}`] : [];
  if (DONE.includes(bug.fix.status) && !riskAllowed(bug.fix.risk, autoFixes, bug.fix.decided)) {
    problems.push(`${bug.id}: fixed at ${bug.fix.risk} risk; FIXER.md fixes only low and medium${autoFixes === 'off' ? '' : `, and up to ${autoFixes} in auto mode`}`);
  }
  return problems;
}

function shownStatus(bug, verified, verdict) {
  if (!bug.fix) return 'no-record';
  if (!DONE.includes(bug.fix.status)) return bug.fix.status;
  if (!verified) return 'not-verified';
  if (verdict === 'disproved') return 'not-fixed';
  if (verdict !== 'proven') return 'fixed-not-proven';
  return bug.fix.status;
}

const ATTENTION = ['fixed-not-proven', 'not-verified', 'needs-decision', 'not-fixed', 'wont-fix', 'no-record'];
// A security fix, and a fix that changes what production does, is always shown to the user, whatever its risk.
const needsAttention = (b) => b.fix?.needsAttention || b.fix?.inProduction === true || b.kind === 'security' || ATTENTION.includes(b.shownStatus) || ['very-high', 'high', 'medium'].includes(b.fix?.risk);
const riskRank = (b) => { const i = RISK.indexOf(b.fix?.risk); return i < 0 ? RISK.length : i; };

// Product questions explorers logged and the user has not answered: they never become bugs, so the fix report is
// where the user sees them. Answers live in the feature folder, two above the explore run.
const questionsOf = (n, run) => { const answered = answersOf(join(run, '..', '..')); return stepQuestions(run).filter((q) => !answered.has(q.id)).map((q) => ({ ...q, round: n })); };

export function fixReport(fixRun) {
  const problems = [];
  const doc = JSON.parse(readFileSync(join(fixRun, 'rounds.json'), 'utf8'));
  // A rounds.json from before autoFixes was recorded: auto mode's default, very-high.
  const autoFixes = doc.autoFixes ?? (doc.auto ? 'very-high' : 'off');
  // A round's bugs: its explore run's, or, with `only`, just the bug folders the user picked from earlier bug-bash runs;
  // plus `extra` bug folders from another run (the previous verify's spec bugs, or earlier requests' not-fixed bugs).
  // Each keeps the run it lives in, so its evidence and its link in fix-claims.json resolve there.
  const bugsIn = (run) => buildProof(run).data.bugs.map((b) => ({ ...b, root: run }));
  const extraBug = (folder) => bugsIn(dirname(dirname(folder))).find((b) => real(join(b.root, b.dir)) === real(folder));
  const roundBugs = (r) => [...(r.only ? r.only.map(extraBug) : bugsIn(r.explore)), ...(r.extra ?? []).map(extraBug)].filter(Boolean);
  const order = (doc.rounds ?? []).map((r) => ({ ...r, bugs: roundBugs(r) }));
  const rounds = order.map((r) => {
    const claims = r.verify ? claimVerdicts(r.verify, r.reproofs ?? []) : null;
    const links = r.verify ? claimOf(r.verify) : new Map();
    const bugs = r.bugs.map((bug) => {
      problems.push(...fixProblems(bug, autoFixes).map((p) => `round ${r.n}: ${p}`));
      if (doc.fixCommits === 'none' && bug.fix?.commit) problems.push(`round ${r.n}: ${bug.id}: committed as ${bug.fix.commit} although Fix commits is none`);
      const linked = links.get(real(join(bug.root, bug.dir)));
      const mine = (claims ?? []).filter((c) => c.id === linked);
      const verdict = WORST.find((v) => mine.some((c) => c.verdict === v)) ?? null;
      const disproved = mine.find((c) => c.verdict === 'disproved');
      if (disproved && DONE.includes(bug.fix?.status)) problems.push(`round ${r.n}: ${bug.id}: claim ${disproved.id} disproved but the fix is still ${bug.fix.status}; undo it as SKILL.md §5 step 4 says`);
      const { root, ...rest } = bug;
      return {
        ...rest, round: r.n, verdict, claims: mine.map((c) => c.id),
        shownStatus: shownStatus(bug, Boolean(claims), verdict),
        before: absolute(root, bug.evidence ?? []),
        after: mine.flatMap((c) => c.evidence),
      };
    });
    // Every fix is proven before the report, unless §5 step 3 stopped the run.
    if (!r.verify && !doc.stopped && r.bugs.some((b) => DONE.includes(b.fix?.status))) problems.push(`round ${r.n}: fixes but no verify run; prove them as SKILL.md §5 says`);
    return { n: r.n, explore: r.explore, verify: r.verify ?? null, bugs, claims };
  });
  const all = rounds.flatMap((r) => r.bugs);
  const lastVerified = [...rounds].reverse().find((r) => r.claims);
  // Claims that prove no bug: the ledger's and the spec's, re-checked after the last round's fixes.
  const proving = new Set(lastVerified ? claimOf(lastVerified.verify).values() : []);
  const holds = (lastVerified?.claims ?? []).filter((c) => !proving.has(c.id));
  // Before: a proven baseline's evidence. A writer-only baseline has none, and the ledger keeps only a verdict word, so neither gives a before.
  const runs = new Map();
  const verdictsOf = (run) => { if (!runs.has(run)) runs.set(run, existsSync(join(run, 'claims.json')) ? claimVerdicts(run) : []); return runs.get(run); };
  const beforeOf = (id) => (doc.baseline ? verdictsOf(doc.baseline).find((b) => b.id === id && b.evidence.length) : undefined);
  const count = (...states) => all.filter((b) => states.includes(b.shownStatus)).length;
  const data = {
    feature: doc.feature, production: doc.production ?? null, auto: Boolean(doc.auto), stopped: doc.stopped ?? null, generatedAt: new Date().toISOString(),
    // Claims that held and failed on the same code in one round: §5 step 4 undid nothing for them.
    flaky: (doc.rounds ?? []).flatMap((r) => (r.flaky ?? []).map((id) => ({ id, round: r.n }))),
    counts: { fixed: count(...DONE), notProven: count('fixed-not-proven', 'not-verified'), notFixed: count('not-fixed', 'wont-fix'), decisions: count('needs-decision') },
    attention: all.filter(needsAttention).sort((a, b) => riskRank(a) - riskRank(b) || a.round - b.round || a.id.localeCompare(b.id, undefined, { numeric: true })),
    rounds: rounds.map(({ claims, ...r }) => r),
    questions: (doc.rounds ?? []).flatMap((r) => questionsOf(r.n, r.explore)),
    holds,
    featureBeforeAfter: holds.flatMap((c) => {
      const before = beforeOf(c.id);
      return before ? [{ id: c.id, statement: c.statement, before: before.evidence, after: c.evidence }] : [];
    }),
    releaseNotes: {
      migrations: all.filter((b) => DONE.includes(b.shownStatus) && !['', 'none'].includes(String(b.fix?.impact?.migration ?? 'none').trim().toLowerCase())),
      existingUsers: all.filter((b) => DONE.includes(b.shownStatus) && b.fix?.impact?.existingUsers && !/^nothing visible/i.test(b.fix.impact.existingUsers))
        .map((b) => `${b.id}: ${b.fix.impact.existingUsers}`),
    },
  };
  return { data, problems };
}

// `lead`: the request page's own headline; a fix step outside a request has none and counts its bugs instead.
export function chatSummary(data, openUrl, lead) {
  const { fixed, notProven, notFixed, decisions } = data.counts;
  return [
    ...(lead ?? [`Fix: ${data.feature}: ${fixed} fixed · ${notProven} fixed, not proven · ${notFixed} not fixed · ${decisions} need a decision`]),
    ...(data.stopped ? [`Stopped: ${data.stopped}`] : []),
    ...(data.flaky ?? []).map((f) => `! round ${f.round} ${f.id} flaky: it held and failed on the same code; nothing was undone for it`),
    ...data.attention.map((b) => `! round ${b.round} ${b.id} [${b.shownStatus}${b.fix?.risk ? `, ${b.fix.risk} risk` : ''}] ${b.title}${b.fix?.decision ? `: ${b.fix.decision}` : ''}`),
    ...openQuestionLines(data.questions ?? [], (q) => `round ${q.round} ${q.charter}`),
    `Open: ${openUrl}`,
  ].join('\n');
}

// The fix step's final build: its result kept as result.json, the request's page rewritten from it.
async function writeReport(fixRun) {
  const { data, problems } = fixReport(fixRun);
  const report = await import('../../show-your-work/scripts/report.mjs');
  const result = report.writeResult(fixRun, { ...data, problems });
  const request = where(fixRun)?.request;
  const page = request ? (await report.writeReportFor(request), join(request, 'report.html')) : result;
  console.log(chatSummary(data, pathToFileURL(resolve(page)).href, request ? await report.headline(request) : undefined));
  for (const problem of problems) console.log(`  Problem: ${problem}`);
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  const [run, flag, proofRun] = process.argv.slice(2);
  if (!run || !existsSync(join(run, 'rounds.json')) || (flag && (flag !== '--verdicts' || !proofRun))) {
    console.error('Usage: node build-fix-report.mjs <fix-run> [--verdicts <proof-run>]   (the fix run must hold rounds.json)');
    process.exit(1);
  }
  if (flag) {
    const links = linksOf(proofRun);
    // A disproved claim's failing cases, as the provers saw them: compared with each bug's actual (SKILL.md §5 step 3).
    const failing = new Map(buildProof(proofRun).data.claims.map((c) => [c.id, (c.cases ?? []).filter((k) => k.result === 'fail').map((k) => k.actual).filter(Boolean)]));
    for (const { id, source, fromLedger, verdict } of claimVerdicts(proofRun)) {
      console.log(JSON.stringify({ id, source, fromLedger, verdict, bugs: links.filter((l) => l.claim === id).map((l) => l.bug), ...(verdict === 'disproved' && { actual: failing.get(id) ?? [] }) }));
    }
  }
  else await writeReport(run);
}
