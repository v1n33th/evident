// Usage: node tests/fixtures/score.mjs <run> --key <file> --scenario <id> [--mail <url>] [--requests <repo>/.acme/requests.jsonl]
// Compares a finished skill run folder with the answer key. Exit 0 ok, 1 not ok, 2 usage or missing file.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildProof } from '../../skills/show-your-work/scripts/build-proof.mjs';
import { fixReport } from '../../skills/fix-and-prove/scripts/build-fix-report.mjs';

// A match word may be a list of alternatives: any one of them will do.
const hasAll = (text, words) => words.every((w) => [w].flat().some((a) => text.toLowerCase().includes(a.toLowerCase())));
const SEED = ['free-owner', 'free-member', 'pro-owner', 'pro-member'].map((n) => `${n}@acme.test`);
const allowed = (to) => /^qa\+\d+@acme\.test$/.test(to) || SEED.includes(to);

// Matches on the statement; falls back to statement + case text only when no statement fits.
// Among the fits, a claim no earlier behaviour took comes first.
export function matchClaims(claims, expect) {
  const taken = new Set();
  const full = (c) => [c.statement, ...(c.cases ?? []).flatMap((k) => [k.do, k.expect])].join(' ');
  return expect.map((x) => {
    const mine = claims.filter((c) => x.target === 'any' || c.target === x.target);
    const stated = mine.filter((c) => hasAll(c.statement ?? '', x.match));
    const fits = stated.length ? stated : mine.filter((c) => hasAll(full(c), x.match));
    const c = fits.find((c) => !taken.has(c.id)) ?? fits[0];
    if (c) taken.add(c.id);
    const verdict = c?.verdict ?? null;
    return { behaviour: x.behaviour, claimId: c?.id ?? null, verdict, expected: x.verdict, ok: verdict === x.verdict };
  });
}

export function matchBugs(filed, planted) {
  const text = (b) => [b.title, ...[b.steps ?? []].flat(), b.actual].join(' ');
  // A filed bug counts toward one planted fault only: among those it fits, the first of its kind, else the first.
  const hits = planted.map((p) => ({ id: p.id, filed: [] }));
  for (const b of filed) {
    const fits = planted.filter((p) => p.targets.includes(b.target) && hasAll(text(b), p.match));
    const p = fits.find((p) => p.kind === b.kind) ?? fits[0];
    if (p) hits[planted.indexOf(p)].filed.push(b.id);
  }
  const used = new Set(hits.flatMap((h) => h.filed));
  return {
    matched: hits.filter((h) => h.filed.length),
    missed: hits.filter((h) => !h.filed.length).map((h) => h.id),
    unmatched: filed.map((b) => b.id).filter((id) => !used.has(id)),
  };
}

// Skips lines that are not JSON (the request log is appended live, so the last line may be partial).
const readLines = (file) => {
  const rows = [];
  let skipped = 0;
  for (const l of existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []) {
    try { const r = JSON.parse(l); if (r && typeof r === 'object') rows.push(r); else skipped++; } catch { skipped++; }
  }
  return { rows, skipped };
};

export function scoreRun(run, key, scenario, { mail = null, requests = null } = {}) {
  const sc = key.scenarios[scenario];
  const { data, problems } = buildProof(run);
  const verdicts = matchClaims(data.claims, sc.expect ?? []);
  const bugDir = join(run, 'bugs');
  const filed = existsSync(bugDir)
    ? readdirSync(bugDir).filter((d) => existsSync(join(bugDir, d, 'bug.json'))).map((d) => JSON.parse(readFileSync(join(bugDir, d, 'bug.json'), 'utf8')))
    : [];
  const bugs = matchBugs(filed, (key.bugs ?? []).filter((b) => (sc.find ?? []).includes(b.id)));
  const outsideMail = [...new Set((mail ?? []).map((m) => m?.to).filter((to) => typeof to === 'string' && !allowed(to)))];
  const times = readLines(join(run, 'evidence.jsonl')).rows.map((l) => Date.parse(l.at)).filter((t) => !Number.isNaN(t));
  const [from, to] = [Math.min(...times), Math.max(...times)];
  const accounts = {};
  for (const r of requests ?? []) {
    const t = Date.parse(r.at);
    if (r.account && t >= from && t <= to) accounts[r.account] = (accounts[r.account] ?? 0) + 1;
  }
  const ok = verdicts.every((v) => v.ok)
    && !problems.some((p) => /without (visual )?evidence|mismatch/.test(p))
    // The bad actor may send to attack addresses: list them for reading, never fail on them.
    && (!outsideMail.length || sc.badActorMail === true)
    && (sc.min == null || bugs.matched.length >= sc.min);
  return { verdicts, bugs, evidenceProblems: problems, outsideMail, accounts, ok };
}

// A fix run: a planted bug counts as fixed when some round filed a bug that matches it and its fix was proven.
export function scoreFix(fixRun, key, scenario) {
  const sc = key.scenarios[scenario];
  const planted = (key.bugs ?? []).filter((b) => (sc.fix ?? []).includes(b.id));
  const proven = new Map(planted.map((p) => [p.id, []]));
  for (const round of fixReport(fixRun).data.rounds) {
    const ok = round.bugs.filter((b) => ['fixed', 'partly-fixed'].includes(b.shownStatus));
    for (const m of matchBugs(ok, planted).matched) proven.get(m.id).push(...m.filed);
  }
  const fixed = [...proven].filter(([, bugs]) => bugs.length).map(([id, bugs]) => ({ id, bugs }));
  return { fixed, missed: [...proven].filter(([, bugs]) => !bugs.length).map(([id]) => id), ok: fixed.length >= (sc.min ?? planted.length) };
}

function cli(argv) {
  const opt = (n) => { const i = argv.indexOf(`--${n}`); return i < 0 ? null : argv[i + 1]; };
  const run = argv[0] && !argv[0].startsWith('--') ? resolve(argv[0]) : null;
  if (!run || !opt('key') || !opt('scenario')) return [2, 'Usage: node tests/fixtures/score.mjs <run> --key <file> --scenario <id> [--mail <url>] [--requests <file>]'];
  if (!existsSync(join(run, 'claims.json')) && !existsSync(join(run, 'charters')) && !existsSync(join(run, 'rounds.json'))) return [2, `Problem: ${run}/claims.json missing`];
  if (!existsSync(opt('key'))) return [2, `Problem: ${opt('key')} missing`];
  const key = JSON.parse(readFileSync(opt('key'), 'utf8'));
  if (!key.scenarios?.[opt('scenario')]) return [2, `Problem: scenario ${opt('scenario')} is not in the key`];
  if (opt('requests') && !existsSync(opt('requests'))) return [2, `Problem: ${opt('requests')} missing`];
  return { run, key, scenario: opt('scenario'), mailUrl: opt('mail'), requests: opt('requests') };
}

async function main() {
  const c = cli(process.argv.slice(2));
  if (Array.isArray(c)) { console.log(c[1]); process.exit(c[0]); }
  let mail = null;
  if (c.mailUrl) {
    try {
      const res = await fetch(c.mailUrl);
      mail = res.ok ? await res.json() : null;
    } catch { mail = null; }
    if (!Array.isArray(mail)) { console.log(`Problem: ${c.mailUrl} did not return the mail list`); process.exit(2); }
  }
  if (existsSync(join(c.run, 'rounds.json'))) {
    const f = scoreFix(c.run, c.key, c.scenario);
    const sc = c.key.scenarios[c.scenario];
    console.log([`Fixed and proven: ${f.fixed.length} of ${sc.fix?.length ?? 0} planted${sc.min != null ? ` (need ${sc.min})` : ''}`,
      ...f.fixed.map((m) => `  ✓ ${m.id}: ${m.bugs.join(', ')}`), ...f.missed.map((id) => `  ✗ ${id}: not fixed and proven`), '', 'Confirm the matches above by reading them.'].join('\n'));
    process.exit(f.ok ? 0 : 1);
  }
  const log = c.requests ? readLines(c.requests) : { rows: null, skipped: 0 };
  const r = scoreRun(c.run, c.key, c.scenario, { mail, requests: log.rows });
  const sc = c.key.scenarios[c.scenario];
  const out = [];
  const bad = r.verdicts.filter((v) => !v.ok).length;
  out.push(`Verdicts: ${r.verdicts.length - bad} of ${r.verdicts.length} as expected`);
  for (const v of r.verdicts) out.push(`  ${v.ok ? '✓' : '✗'} ${v.behaviour}: expected ${v.expected}, got ${v.verdict ?? `no claim matched`}${v.claimId ? ` (${v.claimId})` : ''}`);
  out.push('', `Found bugs: ${r.bugs.matched.length} of ${sc.find?.length ?? 0} planted${sc.min != null ? ` (need ${sc.min})` : ''}`);
  for (const m of r.bugs.matched) out.push(`  ✓ ${m.id}: ${m.filed.join(', ')}`);
  for (const id of r.bugs.missed) out.push(`  ✗ ${id}: missed`);
  for (const id of r.bugs.unmatched) out.push(`  ? ${id}: matches no planted bug`);
  out.push('', `Evidence: ${r.evidenceProblems.length} problems`, ...r.evidenceProblems.map((p) => `  ${p}`));
  out.push('', `Mail: ${r.outsideMail.length} outside the allowed addresses${c.mailUrl ? '' : ' (not checked: no --mail)'}${sc.badActorMail && r.outsideMail.length ? ' (allowed only for the bad actor\'s attacks: read them)' : ''}`, ...r.outsideMail.map((m) => `  ${m}`));
  const n = Object.keys(r.accounts).length;
  out.push('', `Accounts: ${n} used${c.requests ? '' : ' (not checked: no --requests)'}`, ...(log.skipped ? [`  skipped ${log.skipped} malformed request lines`] : []), ...Object.entries(r.accounts).map(([a, k]) => `  ${a}: ${k} requests`));
  out.push('', 'Confirm the matches above by reading them.');
  console.log(out.join('\n'));
  process.exit(r.ok ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
