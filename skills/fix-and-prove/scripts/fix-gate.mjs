// Usage: node fix-gate.mjs --gaps <yes|no> --auto <off|low|medium|high|very-high> --code <code path> [--ledger <dir> --feature <f> --files <a,b>] --plan <risk> <in production: yes|no> '<source>' <bug folder>
//        node fix-gate.mjs --gaps <yes|no> --auto <off|low|medium|high|very-high> --code <code path> [--ledger <dir> --feature <f> --fix-run <fix run>] <bug folder> ...
//        node fix-gate.mjs --suspects <verify run> <claim ids> --fix-run <fix run> [--code <code path>] <bug folder> ...
// The one place FIXER.md's rules on risk, gaps, sources and proven ledger claims are checked. With --plan, before an edit:
// prints "allowed", then "keep <id>: ..." for each proven claim of the feature on the files the fix will change; or
// "needs-decision: <decision>" and exits 1. Without it, after the fixers: one line per fixed or partly fixed record,
// "BUG-NNN ok" or "BUG-NNN undo | <decision>"; a patch that removes text a proven claim of the feature quotes is undone,
// unless the record's "changesClaims" names that claim. --suspects: per claim of the verify run, first the fixes whose
// patch adds text its failing cases show and their expect does not, best first, then the fixes whose patch touches a
// file it names or text its given and expect quote, oldest first: "<id>: BUG-NNN shows "<text>" | BUG-MMM BUG-KKK", with
// "none" for an empty side ("<id>: none | BUG-MMM", "<id>: none | none"). A bug claim's id is followed by its bugs.
// With --code, last "Not undone alone: BUG-NNN ..." names each fix whose patch no longer reverses on the working tree.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EMAIL } from '../../show-your-work/scripts/build-proof.mjs';
import { readLedger, select } from '../../show-your-work/scripts/ledger.mjs';

const RISKS = ['low', 'medium', 'high', 'very-high'];
const read = (file) => { try { return readFileSync(file, 'utf8'); } catch { return ''; } };

// Where a source sentence may come from: the briefs, the documents they name, and the feature's answers.
function sourcesText(bugFolder, code) {
  const step = dirname(dirname(bugFolder));
  const request = dirname(step);
  const briefs = [join(request, 'brief.md'), join(step, 'brief.md')].map(read);
  const roots = [code, dirname(dirname(dirname(request)))].filter(Boolean);
  // A request appended to an earlier brief adds its own ## Documents: read every one.
  const docs = briefs.flatMap((t) => [...t.matchAll(/^## Documents\n([\s\S]*?)(?=^## |(?![\s\S]))/gm)].flatMap((m) => m[1].split('\n')))
    .map((l) => l.replace(/^\s*-\s*/, '').replace(/`/g, '').trim()).filter(Boolean)
    .map((p) => (isAbsolute(p) ? p : roots.map((r) => join(r, p)).find(existsSync))).filter(Boolean).map(read);
  return [...briefs, ...docs, read(join(dirname(request), 'answers.jsonl'))].join('\n');
}

// Low and medium always; any risk on a bug the user decided (they answered a question that named it); else up to the run's
// Auto fixes level.
export const riskAllowed = (risk, auto, decided) => RISKS.indexOf(risk) <= 1 || Boolean(decided) || (auto !== 'off' && RISKS.indexOf(risk) <= RISKS.indexOf(auto));

// Why a fix may not be made, or null. `plan` is what the fixer means to do: { risk, inProduction, source }.
function blocked(b, plan, { gaps, auto, code, bugFolder }) {
  const { risk, inProduction, source = '' } = plan;
  if (!riskAllowed(risk, auto, b.fix?.decided)) return 'risk';
  if ((b.kind === 'gap' || source.startsWith('gap:')) && gaps !== 'yes') return 'source';
  if (inProduction === false) return null;
  if (/^(broken|decided):/.test(source) || (source.startsWith('gap:') && gaps === 'yes') || (source.startsWith('auto:') && auto !== 'off')) return null;
  const sentence = source.trim().replace(/^["“'](.*)["”']$/, '$1').trim();
  return sentence && sourcesText(bugFolder, code).includes(sentence) ? null : 'source';
}

// What a patch changes: the files it touches, and its removed and added lines (header lines left out).
export function patchParts(text) {
  const parts = { files: [], removed: [], added: [] };
  let header = false;
  for (const line of String(text ?? '').split('\n')) {
    const file = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (file) { parts.files.push(...new Set([file[1], file[2]])); header = true; }
    else if (line.startsWith('@@')) header = false;
    else if (!header && line.startsWith('-')) parts.removed.push(line.slice(1));
    else if (!header && line.startsWith('+')) parts.added.push(line.slice(1));
  }
  return parts;
}

const quoted = (text) => [...String(text ?? '').matchAll(/"([^"]+)"|“([^”]+)”/g)].map((m) => m[1] ?? m[2]);
const quotes = (claim) => [claim.given, ...(claim.cases ?? []).map((c) => c.expect)].flatMap(quoted);
// Quoted text cut where it varies (an address, a number, a <placeholder>, a line break or an ellipsis), as code would hold it.
// ponytail: plain substring match; text split over lines or kept in a translation file is left to the proof.
const VARIES = new RegExp(`${EMAIL.source}|<[^>]*>|\\d+|\\\\n|\\n|…|\\.\\.\\.`, 'i');
const cut = (text, min) => text.split(VARIES).map((s) => s.trim()).filter((s) => s.length >= min);
const pieces = (claim) => quotes(claim).flatMap((q) => cut(q, 8));
const count = (lines, s) => lines.reduce((n, l) => n + l.split(s).length - 1, 0);
// The quoted text a patch takes away: more of it on removed lines than on added ones.
export const removedText = (claim, parts) => pieces(claim).find((s) => count(parts.removed, s) > count(parts.added, s)) ?? null;
// The patch changes a line that holds text the claim quotes, even one it puts back changed: the code that shows it.
const edits = (claim, parts) => pieces(claim).some((s) => count(parts.removed, s) + count(parts.added, s) > 0);
const touches = (claim, parts) => select([{ ...claim, tags: claim.tags ?? [] }], { files: parts.files }).length > 0;

// What a failing case shows that its expect does not: its actual's quoted text, cut where it varies, 12 characters or more.
const shown = (line) => quoted(line.actual).flatMap((q) => cut(q, 12));
// The longest run of words of that text, 12 characters or more and not in the expect, that a patch adds: more of it
// on added lines than on removed ones. ponytail: tries every run of words; failure texts are a few lines long.
export function addedText(text, expect, parts) {
  const words = text.split(/\s+/);
  const lower = String(expect ?? '').toLowerCase();
  for (let n = words.length; n > 0; n--) {
    for (let i = 0; i + n <= words.length; i++) {
      const run = words.slice(i, i + n).join(' ');
      if (run.length >= 12 && !lower.includes(run.toLowerCase()) && count(parts.added, run) > count(parts.removed, run)) return run;
    }
  }
  return null;
}
// The failing case lines provers logged in a run's sessions: one per attempt, setup lines left out.
const failures = (run) => {
  const dir = join(run, 'sessions');
  return (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.jsonl')) : []).flatMap((f) => readFileSync(join(dir, f), 'utf8').split('\n'))
    .flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } })
    .filter((l) => l.result === 'fail' && l.case && l.claim);
};
// The ledger claims a fix must keep: those of the feature that last held, as fix-claims.mjs re-checks them.
const held = (dir, feature) => readLedger(dir).claims.filter((c) => c.tags.includes(feature) && ['active', 'changed'].includes(c.status) && c.verdict === 'proven');
const patchOf = (fixRun, f) => (fixRun && f.patch && existsSync(join(fixRun, f.patch)) ? join(fixRun, f.patch) : null);

export function gate(bugFolders, { gaps = 'no', auto = 'off', code = null, plan = null, ledger = null, feature = null, files = [], fixRun = null } = {}) {
  if (!RISKS.includes(auto) && auto !== 'off') throw new Error(`--auto must be off or a risk, not ${auto}`);
  if (ledger && !feature) throw new Error('--ledger needs --feature');
  const claims = ledger ? held(ledger, feature) : [];
  const bugs = bugFolders.map((dir) => ({ dir, b: JSON.parse(readFileSync(join(dir, 'bug.json'), 'utf8')) }));
  const ask = (b) => `Production does ${b.actual}. Change it to ${b.expected}?`;
  if (plan) {
    const [{ dir, b }] = bugs;
    const why = blocked(b, plan, { gaps, auto, code, bugFolder: dir });
    if (why) return { ok: false, out: `needs-decision: ${ask(b)}${why === 'risk' ? ` (a ${plan.risk}-risk change)` : ''}` };
    // A claim that names no file may rest on any of them.
    const keep = claims.filter((c) => touches(c, { files }) || !c.files?.length).map((c) => `keep ${c.id}: ${c.statement}${quotes(c).length ? ` | quotes ${quotes(c).map((q) => `"${q}"`).join(', ')}` : ''}`);
    return { ok: true, out: ['allowed', ...keep].join('\n') };
  }
  const lines = bugs.filter(({ b }) => ['fixed', 'partly-fixed'].includes(b.fix?.status) && !/^Fixed with /.test(b.fix.summary ?? '')).map(({ dir, b }) => {
    const f = b.fix;
    const why = blocked(b, { risk: f.risk, inProduction: f.inProduction !== false, source: f.source ?? '' }, { gaps, auto, code, bugFolder: dir });
    const change = f.patch ?? `commit ${f.commit}`;
    if (why) return `${b.id} ${why === 'risk' ? `undo | Fixed at ${f.risk} risk, then undone: ${f.summary}. Apply ${change}?`
      : `undo | Production does ${b.actual}. Change it as ${change} does: ${f.summary}?`}`;
    const patch = patchOf(fixRun, f);
    const parts = patch && patchParts(readFileSync(patch, 'utf8'));
    const broken = parts ? claims.filter((c) => !(f.changesClaims ?? []).includes(c.id)).map((c) => [c, removedText(c, parts)]).filter(([, t]) => t) : [];
    return `${b.id} ${!broken.length ? 'ok' : `undo | ${broken.map(([c, t]) => `${c.id} proved: ${c.statement} This fix removes "${t}".`).join(' ')} Apply ${change} and change ${broken.map(([c]) => c.id).join(', ')}?`}`;
  });
  return { ok: true, out: lines.join('\n') };
}

// The fixes that may have broken each claim. First those whose patch adds text a failing case shows and its expect does
// not, longest text first: that text points at the culprit. Then, oldest patch first, those whose patch touches a file
// the claim names, or changes a line with text it quotes. The claims come from the verify run, so a spec claim and a bug
// claim are matched as a ledger one is.
export function suspects(verifyRun, ids, fixRun, bugFolders, code = null) {
  const claims = JSON.parse(readFileSync(join(verifyRun, 'claims.json'), 'utf8')).claims ?? [];
  const failed = failures(verifyRun);
  const links = existsSync(join(verifyRun, 'fix-claims.json')) ? JSON.parse(readFileSync(join(verifyRun, 'fix-claims.json'), 'utf8')) : [];
  const bugOf = (dir) => { try { return JSON.parse(readFileSync(join(dir, 'bug.json'), 'utf8')).id; } catch { return null; } };
  const fixes = bugFolders.map((dir) => JSON.parse(readFileSync(join(dir, 'bug.json'), 'utf8')))
    // A "Fixed with BUG-NNN" record shares that bug's patch, and follows it.
    .map((b) => ({ id: b.id, patch: ['fixed', 'partly-fixed'].includes(b.fix?.status) && !/^Fixed with /.test(b.fix.summary ?? '') ? patchOf(fixRun, b.fix) : null }))
    .filter((x) => x.patch)
    .map((x) => ({ ...x, at: statSync(x.patch).mtimeMs, parts: patchParts(readFileSync(x.patch, 'utf8')) }))
    .sort((a, b) => a.at - b.at);
  const lines = ids.map((id) => {
    const c = claims.find((k) => k.id === id);
    if (!c) throw new Error(`${id}: not a claim of ${verifyRun}`);
    const lines = failed.filter((l) => l.claim === id);
    const text = fixes.map((x) => ({ ...x, run: lines.flatMap((l) => shown(l).map((s) => addedText(s, l.expected, x.parts)))
      .filter(Boolean).sort((a, b) => b.length - a.length)[0] }))
      .filter((x) => x.run).sort((a, b) => b.run.length - a.run.length);
    const other = fixes.filter((x) => !text.some((t) => t.id === x.id) && (touches(c, x.parts) || removedText(c, x.parts) || edits(c, x.parts))).map((x) => x.id);
    const owners = links.filter((l) => l.claim === id).map((l) => bugOf(l.bug)).filter(Boolean);
    const head = `${id}${owners.length ? ` (${owners.join(', ')})` : ''}`;
    return `${head}: ${text.length ? `${text.map((x) => x.id).join(' ')} shows "${text[0].run}"` : 'none'} | ${other.join(' ') || 'none'}`;
  });
  // Later fixes changed its lines: it cannot be undone alone, so the rollback undoes the round's fixes together.
  const stuck = code ? fixes.filter((x) => spawnSync('git', ['-C', code, 'apply', '-R', '--check', resolve(x.patch)], { stdio: 'ignore' }).status !== 0).map((x) => x.id) : [];
  return [...lines, ...(stuck.length ? [`Not undone alone: ${stuck.join(' ')}`] : [])].join('\n');
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i < 0 ? null : args.splice(i, 2)[1]; };
  try {
    const gaps = opt('--gaps') ?? 'no', auto = opt('--auto') ?? 'off', code = opt('--code'), feature = opt('--feature'), fixRun = opt('--fix-run');
    const ledger = ((l) => (l === 'none' ? null : l))(opt('--ledger'));
    const files = (opt('--files') ?? '').split(',').map((f) => f.trim()).filter(Boolean);
    const s = args.indexOf('--suspects');
    if (s >= 0) {
      const [run, ids] = args.splice(s, 3).slice(1);
      if (!run || !ids || !fixRun || !args.length) throw new Error('Usage: node fix-gate.mjs --suspects <verify run> <claim ids> --fix-run <fix run> [--code <code path>] <bug folder> ...');
      console.log(suspects(run, ids.split(',').map((i) => i.trim()).filter(Boolean), fixRun, args, code));
      process.exit(0);
    }
    const p = args.indexOf('--plan');
    const plan = p < 0 ? null : (([risk, prod, source]) => ({ risk, inProduction: prod !== 'no', source }))(args.splice(p, 4).slice(1));
    if (!args.length || (plan && (args.length !== 1 || !RISKS.includes(plan.risk)))) throw new Error('Usage: node fix-gate.mjs --gaps <yes|no> --auto <off|risk> --code <code path> [--ledger <dir> --feature <f> (--files <a,b> | --fix-run <fix run>)] [--plan <risk> <yes|no> \'<source>\'] <bug folder> ...');
    const r = gate(args, { gaps, auto, code, plan, ledger, feature, files, fixRun });
    if (r.out) console.log(r.out);
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
}
