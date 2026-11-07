// Usage: node build-proof.mjs <run-folder> --plan   Prints the approval view of <run-folder>/claims.json.
//        node build-proof.mjs <run-folder> --approve [--by user|auto]  Sets approvedAt and approvedBy, if the plan has no problems.
//        node build-proof.mjs <run-folder> --session <id> <claim ids...>  Writes sessions/<id>.claims.json with test fields only.
//        node build-proof.mjs <run-folder> --ledger <dir> [<re-proof run> ...]  Writes this run's claims into <dir>/<feature>.jsonl and terms.json;
//                                                   in <project>/ledger/, also rebuilds the project's index.html, which shows the ledger.
//                                                   After a rollback (fix-and-prove): a claim of a fix that was undone is not-proven, a claim
//                                                   an undone fix changed keeps its ledger line, and a claim a re-proof run covered takes its
//                                                   verdict from the re-proofs.
//        node build-proof.mjs <run-folder>          Checks every capture, writes <run-folder>/result.json and the request's
//                                                   report.html, rebuilds the project's index.html, and prints the chat summary.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FEATURE, filesOf, ID, mintId, readLedger, writeClaims } from './ledger.mjs';
import { answersOf, openQuestionLines, stepQuestions } from './questions.mjs';

const HEADLINE_LIMIT = 7;
// Claims name an account key or how an address differs from a New accounts address, never an address: they go to the committed ledger.
export const EMAIL = /[^\s@"]+@[^\s@"]+\.[a-z]{2,}/i;
const VISUAL = /\.(gif|png|jpe?g|webp|webm|mp4|mov)$/i;
const MOTION = /\.(gif|webm|mp4|mov)$/i;
// Words that let a prover pass a case on judgment; quoted UI text is exempt.
const VAGUE = /\b(clear|clearly|proper|properly|appropriate|appropriately|correct|correctly|nice|good|friendly|reasonable)\b/i;
const rank = { fail: 3, pass: 2, blocked: 1 };
// The EARS shapes of CLAIMS.md §3, and signs of code in a statement.
export const SHAPE = /^(The app\b|When\b|While\b|Where\b|If\b.*\bthen\b)/;
const CODE = /`|\w\.(tsx?|jsx?|mjs|py|rb|go|java)\b|\w\(\)/;
// High-confidence secret shapes; a line that already says <redacted> passes.
export const SECRETS = [
  ['authorization header', /^(?:proxy-)?authorization:(?![^\n]*<redacted>)[ \t]*\S/im],
  ['cookie header', /^(?:set-)?cookie:(?![^\n]*<redacted>)[ \t]*\S/im],
  ['authorization or cookie field', /"(?:authorization|cookie|set-cookie)"\s*:\s*"(?!<redacted>)[^"]+"/i],
  ['token or password field', /"(?:token|access_token|refresh_token|id_token|api_key|apiKey|password|secret)"\s*:\s*"(?!<redacted>)[^"]+"/i],
  ['JSON web token', /\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['API key', /\b(?:sk|pk|rk)_(?:live|test)_[0-9a-zA-Z]{16,}|\bsk-[\w-]{20,}|\bgh[pousr]_[A-Za-z0-9]{30,}|\bxox[abp]-[\w-]{20,}/],
];
// What setup.mjs blanks in the output it saves: the values of the header and field shapes above that sign a session
// in (curl -v's "> " and "< " too), JSON fields named for a token, password, secret or key (a sign-in response's
// accessToken), signed tokens (JWTs) and bearer tokens anywhere.
export const redactSessions = (text) => String(text)
  .replace(/^((?:[<>] )?(?:(?:proxy-)?authorization|(?:set-)?cookie):)(?![^\n]*<redacted>)[ \t]*\S.*$/gim, '$1 <redacted>')
  .replace(/("(?:authorization|cookie|set-cookie|[\w-]*(?:token|password|secret|api[_-]?key))"\s*:\s*)"(?!<redacted>)[^"]+"/gi, '$1"<redacted>"')
  .replace(/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]+/g, '<redacted>')
  .replace(/\b(bearer[ \t]+)(?!<redacted>)[\w.~+/-]+=*/gi, '$1<redacted>');
// Provers see only these fields of a claim.
const TEST_FIELDS = ['id', 'statement', 'given', 'setup', 'cases', 'evidence', 'viewports'];

// A request folder's name: <YYYY-MM-DD>-<HHMM>-<kind>[-n] (run-folder.mjs makes them).
export const REQUEST = /^(\d{4}-\d{2}-\d{2})-(\d{4})-([a-z][a-z-]*?)(?:-(\d+))?$/;

// A step's project, feature and request, or null for a folder outside <project>/<feature>/<request>/<step>/.
export function where(step) {
  const s = resolve(step);
  const request = dirname(s);
  if (!REQUEST.test(basename(request))) return null;
  return { project: dirname(dirname(request)), feature: basename(dirname(request)), request, step: s };
}

// A request folder given where its step belongs: the run's files would land beside its steps, and its page would show none.
// Scripts that write into a run refuse it with this problem; null for any other folder.
// Folders a run keeps inside itself, never steps.
const RUN_DIRS = ['bugs', 'charters', 'evidence', 'sessions', 'fixes'];
export function notAStep(run) {
  const r = resolve(run);
  if (!REQUEST.test(basename(r))) return null;
  const steps = existsSync(r) ? readdirSync(r, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.') && !RUN_DIRS.includes(e.name)).map((e) => e.name) : [];
  return `${r} is a request folder, not a run folder: use its step${steps.length ? `, ${steps.map((s) => join(r, s)).join(' or ')}` : ''}`;
}

// A run is a step folder, <project>/<feature>/<request>/<step>/; a folder outside that layout is its parent's.
export function projectDir(run) {
  return where(run)?.project ?? dirname(resolve(run));
}

// The targets environment.md lists under ## Targets ("- Web: <url>", "- API: none"), or null without that section.
export function listedTargets(text) {
  const section = text.split(/^## /m).find((s) => s.startsWith('Targets'));
  if (!section) return null;
  return [...section.matchAll(/^- (Web|API):[ \t]*(.*)$/gim)].filter((m) => m[2].trim() && !/^none\b/i.test(m[2].trim())).map((m) => m[1].toLowerCase());
}

// True when the Web line under ## Evidence picks a recording ("- Web: video, text"): then a still alone does not show a case happen.
export function picksMotion(text) {
  const line = String(text ?? '').split(/^## /m).find((s) => s.startsWith('Evidence'))?.match(/^- Web:[ \t]*(.*)$/im)?.[1];
  return /\b(gif|video)\b/i.test(line ?? '');
}

// What judging a claim needs of its target: provenBy 'picture' wants a picture of its own (a recording when motion), 'file' any
// logged file; viewports says whether a claim may name them. A step's targets.json holds these per target (definitions.mjs writes it).
const legacy = (motion) => ({
  web: { label: 'Web', provenBy: 'picture', viewports: true, motion, found: ['found.png', 'found.txt'], evidenceSummary: 'each method `## Evidence` picks for web, of every step; text on screen' },
  api: { label: 'API', provenBy: 'file', viewports: false, motion: false, found: [], evidenceSummary: 'saved response of each call' },
});
const FILE_RULE = { provenBy: 'file', viewports: false, motion: false };
// The rules of a step with no targets.json: the only place scripts still spell web and api. Direct callers of
// claimVerdict, checkEvidence and approvalView that pass no rules get them too.
export const LEGACY_TARGETS = (envText) => legacy(picksMotion(envText));

// The rules of a run's targets: its targets.json over LEGACY_TARGETS, so an old environment.md without ## Targets still needs
// pictures for web claims. A missing or unreadable targets.json leaves the legacy rules alone.
export function runTargets(run) {
  const env = readText(projectDir(run), 'environment.md');
  let found = {};
  try { found = JSON.parse(readText(run, 'targets.json') ?? '{}').targets ?? {}; } catch { /* unreadable: legacy rules */ }
  return { ...LEGACY_TARGETS(env), ...found };
}

// Whether `## Evidence` turns the evidence check on (`- Check: on`).
export const checksOn = (text) => /^- Check:[ \t]*on\b/im.test(String(text ?? '').split(/^## /m).find((s) => s.startsWith('Evidence')) ?? '');

// The viewport names under Viewports in ## Preferences ("desktop 1440×900, mobile 390×844"), or null.
export function listedViewports(text) {
  const line = text.split(/^## /m).find((s) => s.startsWith('Preferences'))?.match(/^- Viewports:[ \t]*(.*)$/im)?.[1];
  return line ? line.replace(/\(.*?\)/g, '').split(',').map((v) => v.trim().split(/\s+/)[0]).filter(Boolean) : null;
}

// In the order given: the orchestrator puts claims that change what later claims rely on last.
export const sessionClaims = (doc, ids) => [...new Set(ids)].map((id) => (doc.claims ?? []).find((c) => c.id === id)).filter(Boolean).map((c) => Object.fromEntries(TEST_FIELDS.map((f) => [f, c[f]])));

export function caseResults(sessions) {
  const map = new Map();
  const last = new Map();
  const failed = new Set();
  for (const session of sessions) {
    for (const step of session.steps) {
      if (!step.case || !step.claim || !rank[step.result]) continue;
      const at = `${step.claim}:${step.case}${step.viewport ? `@${step.viewport}` : ''}`;
      last.set(at, step.result);
      if (step.result === 'fail') failed.add(at);
      // Each attempt also counts for its viewport, so a claim can need a pass at every width it names.
      for (const key of [`${step.claim}:${step.case}`, ...(step.viewport ? [`${step.claim}:${step.case}@${step.viewport}`] : [])]) {
        const old = map.get(key);
        if (old && rank[old.result] >= rank[step.result]) continue;
        map.set(key, { result: step.result, session: session.id, ...(step.bug && { bug: step.bug }), ...(step.note && { note: step.note }) });
      }
    }
  }
  // A fail that a later pass of the same case and viewport follows is flaky: not proven, never disproved.
  const flaky = new Set([...failed].filter((k) => last.get(k) === 'pass'));
  for (const [key, r] of map) {
    const fails = [...failed].filter((k) => k === key || k.startsWith(`${key}@`));
    if (r.result === 'fail' && fails.every((k) => flaky.has(k))) map.set(key, { ...r, result: 'blocked', note: 'flaky: failed once, then passed' });
  }
  return map;
}

export function claimVerdict(claim, results, evidenceKeys, rule) {
  // Without a rule (or with a bare motion flag, as older callers pass) the claim's target is judged by the legacy rules.
  if (typeof rule !== 'object' || rule === null) rule = legacy(rule === true)[claim.target] ?? FILE_RULE;
  if (claim.status === 'retired') return null;
  const notRun = String(claim.proof ?? '').startsWith('will not');
  const viewports = rule.viewports && Array.isArray(claim.viewports) && claim.viewports.length ? claim.viewports : null;
  const cases = (claim.cases ?? []).map((c) => {
    const key = `${claim.id}:${c.id}`;
    const found = notRun ? null : results.get(key);
    const base = { id: c.id, result: found?.result ?? 'not-run', ...(found?.bug && { bug: found.bug }), hasEvidence: evidenceKeys.has(key) };
    if (!viewports) return base;
    // A case passes only if it passes, with evidence, at every viewport the claim names; any fail disproves it.
    const at = Object.fromEntries(viewports.map((v) => [v, (!notRun && results.get(`${key}@${v}`)?.result) || 'not-run']));
    const all = Object.values(at);
    const result = base.result === 'fail' || all.includes('fail') ? 'fail' : all.every((r) => r === 'pass') ? 'pass' : all.includes('blocked') ? 'blocked' : 'not-run';
    const missing = viewports.filter((v) => !evidenceKeys.has(`${key}@${v}`));
    return { ...base, result, hasEvidence: !missing.length, viewports: at, ...(missing.length && { missing }) };
  });
  if (notRun) return { verdict: 'not-proven', cases, problems: [] };
  const kind = rule.provenBy !== 'picture' ? 'evidence' : rule.motion ? 'a recording' : 'visual evidence';
  const without = (c) => `${claim.id} case ${c.id}: ${c.result === 'fail' ? 'failed' : 'passed'} without ${kind}${c.missing ? ` at ${c.missing.join(', ')}` : ''}`;
  if (cases.some((c) => c.result === 'fail')) {
    // The counterexample still stands; the problem asks for a picture of it.
    const bare = rule.provenBy === 'picture' ? cases.filter((c) => c.result === 'fail' && !c.hasEvidence) : [];
    return { verdict: 'disproved', cases, problems: bare.map(without) };
  }
  const unproven = cases.filter((c) => c.result === 'pass' && !c.hasEvidence);
  const problems = unproven.map(without);
  const proven = cases.length > 0 && cases.every((c) => c.result === 'pass') && !unproven.length;
  return { verdict: proven ? 'proven' : 'not-proven', cases, problems };
}

export function areaVerdict(verdicts) {
  if (verdicts.includes('disproved')) return 'disproved';
  return verdicts.length && verdicts.every((v) => v === 'proven') ? 'proven' : 'not-proven';
}

export function approvalView(doc, { targets = null, viewports = null, ledger = null, rules = legacy(false) } = {}) {
  const problems = [];
  const claims = doc.claims ?? [];
  const areas = doc.areas ?? [];
  const headline = claims.filter((c) => c.status === 'active' && c.rank === 'headline');
  const changes = claims.filter((c) => c.status === 'changed' || c.status === 'retired');
  const routine = claims.filter((c) => c.status === 'active' && c.rank === 'routine').length;
  for (const c of claims) {
    if (!/^C\d+$/.test(c.id) && !ID.test(c.id)) problems.push(`${c.id}: id is not C<number> or a ledger id`);
    if (c.status !== 'retired' && !c.tags?.length) problems.push(`${c.id}: no tags`);
    // Claims written in this run; copied ledger claims keep their wording.
    if ((!c.fromLedger || c.status === 'changed') && c.status !== 'retired') {
      const missing = ['target', 'statement', 'given', 'setup', 'evidence', 'proof'].filter((f) => !c[f]);
      if (!c.cases?.length) missing.push('cases');
      if (missing.length) problems.push(`${c.id}: missing ${missing.join(', ')}`);
      // Quoted UI text does not count toward the 20 words.
      const words = String(c.statement ?? '').replace(/"[^"]*"|“[^”]*”/g, ' ').split(/\s+/).filter(Boolean).length;
      if (words > 20) problems.push(`${c.id}: statement has ${words} words; the limit is 20`);
      if (c.statement && !SHAPE.test(c.statement)) problems.push(`${c.id}: statement starts with none of "The app", "When", "While", "If ... then", "Where"`);
      if (CODE.test(c.statement ?? '')) problems.push(`${c.id}: statement names code`);
      if (targets && c.target && !targets.includes(c.target)) problems.push(`${c.id}: target ${c.target} has no definition or is not under ## Targets: ask for evidence setup to define it`);
      if (c.viewports != null) {
        if (!Array.isArray(c.viewports) || !c.viewports.every((v) => typeof v === 'string' && v.trim())) problems.push(`${c.id}: viewports is not a list of names`);
        else if (c.target && !rules[c.target]?.viewports) problems.push(`${c.id}: viewports on a ${c.target} claim; only targets with viewports have them`);
        else for (const v of c.viewports.filter((v) => viewports && !viewports.includes(v))) problems.push(`${c.id}: viewport ${v} is not under Viewports in environment.md Preferences`);
      }
    }
    if (c.draft) problems.push(`${c.id}: a draft from the bug's steps: finish it as CLAIMS-findings.md says, then delete "draft"`);
    if (!['active', 'changed', 'retired'].includes(c.status)) problems.push(`${c.id}: unknown status ${c.status}`);
    else if (c.status === 'active' && !['headline', 'routine'].includes(c.rank)) problems.push(`${c.id}: unknown rank ${c.rank}`);
    else if (c.status === 'changed' && !c.changed?.why) problems.push(`${c.id}: changed without changed.why: the user's words that ask for it, or "the code only: <commit> <file>"`);
    if (EMAIL.test(JSON.stringify(c))) problems.push(`${c.id}: contains an email address: name an account key, or how the address differs from a New accounts address`);
    for (const k of c.cases ?? []) {
      const word = String(k.expect ?? '').replace(/"[^"]*"|'[^']*'/g, '').match(VAGUE)?.[1];
      if (word) problems.push(`${c.id} case ${k.id}: vague expected result "${word}": name the exact text, status or count`);
    }
  }
  // One word, one meaning across the app: a term the ledger already defines keeps its meaning.
  for (const t of doc.terms ?? []) {
    const known = (ledger?.terms ?? []).find((k) => k.term === t.term);
    if (known && known.means !== t.means) problems.push(`term "${t.term}": the ledger means "${known.means}", this run says "${t.means}"`);
  }
  const lines = [`Proof plan: ${doc.title} (${doc.input})`, 'C1, C2, ... are this run\'s new claims; approval gives them ledger ids (C-7f3a).', ''];
  let n = 0;
  const widths = (c) => (Array.isArray(c.viewports) && c.viewports.length ? ` [${c.viewports.join(', ')}]` : '');
  const numbered = (list) => list.map((c) => `${++n}. ${c.id} ${c.statement}${widths(c)}${c.check ? `   ⚠ ${c.check}` : ''}`);

  const changeLines = (list, indent = '') => list.map((c) => `${indent}${c.status === 'retired' ? `- ${c.id}: retired: ${c.retiredReason}` : `- ${c.id}: ${c.statement} (was: ${c.changed?.from})${c.changed?.why ? ` · from ${c.changed.why}` : ''}`}`);
  const limit = (label, count, hint = '') => count > HEADLINE_LIMIT && problems.push(`${label}${count} headline lines; the limit is ${HEADLINE_LIMIT}${hint}`);
  const known = new Set(areas.map((a) => a.id));
  let globalChanges = changes;

  if (areas.length) {
    if (areas.length > HEADLINE_LIMIT) problems.push(`${areas.length} areas; the limit is ${HEADLINE_LIMIT}: propose phases`);
    for (const area of areas) {
      const list = headline.filter((c) => c.area === area.id);
      const own = changes.filter((c) => c.area === area.id);
      limit(`area ${area.id}: `, list.length + own.length);
      lines.push(`${area.id}. ${area.title}`, ...numbered(list).map((l) => `  ${l}`));
      if (own.length) lines.push('  Changes earlier claims:', ...changeLines(own, '  '));
    }
    const other = headline.filter((c) => !known.has(c.area));
    for (const c of other) problems.push(`${c.id}: ${c.area ? `unknown area ${c.area}` : 'no area'}`);
    if (other.length) lines.push('Other:', ...numbered(other).map((l) => `  ${l}`));
    globalChanges = changes.filter((c) => !known.has(c.area));
    limit('', globalChanges.length + other.length, ': move some to routine or split into areas');
  } else {
    lines.push(...numbered(headline));
    limit('', headline.length + changes.length, ': move some to routine or split into areas');
  }
  if (globalChanges.length) lines.push('', 'Changes earlier claims:', ...changeLines(globalChanges));
  lines.push('', `+ ${routine} routine checks: run, shown only if they fail.`);
  // A warning the approver never sees is a hidden claim; these do not count toward the limit.
  const marked = claims.filter((c) => c.status === 'active' && c.rank === 'routine' && c.check);
  if (marked.length) lines.push('Routine checks the code check marks:', ...marked.map((c) => `- ${c.id} ${c.statement}   ⚠ ${c.check}`));
  const newTags = newTagsOf(claims, ledger);
  if (newTags.length) lines.push(`New tags: ${newTags.join(', ')}`);
  if (doc.covers?.length) lines.push(`Covers: ${doc.covers.map((c) => `${c.area} (${c.claims.join(', ')})`).join(' · ')}`);
  if (doc.willNotProve) lines.push(`Will not prove: ${doc.willNotProve}`);
  return { text: lines.join('\n'), problems };
}

const readText = (run, path) => (existsSync(join(run, path)) ? readFileSync(join(run, path), 'utf8') : null);
// decisions.md: one "Ruling:" line per decision (a default's starts "Ruling: default: "), "Stop:" for a hard stop.
export function readDecisions(text) {
  const lines = (text ?? '').split('\n');
  const rulings = lines.filter((l) => l.startsWith('Ruling: '));
  const stops = lines.filter((l) => l.startsWith('Stop: '));
  return {
    count: rulings.length,
    defaults: rulings.filter((l) => l.startsWith('Ruling: default: ')).map((l) => l.slice('Ruling: default: '.length)),
    stop: stops.length ? stops.at(-1).slice('Stop: '.length) : null,
  };
}

const entries = (run, dir) => (existsSync(join(run, dir)) ? readdirSync(join(run, dir), { withFileTypes: true }) : []);

function readJson(run, path, problems) {
  const text = readText(run, path);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    problems.push(`${path}: ${error.message}`);
    return null;
  }
}

function readJsonl(run, path, problems) {
  return (readText(run, path) ?? '').split('\n').flatMap((line, index) => {
    if (!line.trim()) return [];
    try {
      const row = JSON.parse(line);
      if (row && typeof row === 'object' && !Array.isArray(row)) return [{ row, n: index + 1 }];
      problems.push(`${path} line ${index + 1}: not a JSON object`);
    } catch (error) {
      problems.push(`${path} line ${index + 1}: ${error.message}`);
    }
    return [];
  });
}

// Bugs whose own picture or recording the evidence checker says does not show what was logged: id → the checker's why.
// Such a bug is "not confirmed": it is listed apart and never counted.
// Only the picture or recording of the failure as found (found.*, repro.*) can un-confirm a bug: a replay still may be
// taken a moment too early or late. A found file that matches (found.txt with the request, for a failure only a request
// shows) keeps the bug confirmed beside a screenshot that shows nothing.
// A prover's bug names its claim and case: a mismatch on any of its copies, or on the file one was copied from (same
// fingerprint), contradicts the fail it came from.
const AS_FOUND = /(^|\/)(found|repro)\.[a-z0-9]+$/i;
const PICTURE = /\.(gif|png|jpe?g|webp|webm|mp4|mov)$/i;
export function contradicted(run) {
  const ignore = [];
  const checks = new Map(readJsonl(run, 'evidence-check.jsonl', ignore).map(({ row }) => [`${row.file}\n${row.sha256}`, row]));
  const out = new Map();
  const fine = new Set();
  const bad = new Map([...checks.values()].filter((c) => c.verdict === 'mismatch').map((c) => [c.sha256, c.why ?? 'its evidence does not show it']));
  const cases = new Map();
  for (const { row } of readJsonl(run, 'evidence.jsonl', ignore)) {
    const check = checks.get(`${row.file}\n${row.sha256}`);
    if (row.bug && bad.has(row.sha256) && !cases.has(row.bug)) cases.set(row.bug, bad.get(row.sha256));
    if (!row.bug || !AS_FOUND.test(String(row.file))) continue;
    if (check?.verdict === 'matches') fine.add(row.bug);
    else if (check?.verdict === 'mismatch' && PICTURE.test(String(row.file)) && !out.has(row.bug)) out.set(row.bug, check.why ?? 'its picture does not show it');
  }
  for (const e of entries(run, 'bugs').filter((e) => e.isDirectory())) {
    const bug = readJson(run, `bugs/${e.name}/bug.json`, ignore);
    const why = bug?.claim && cases.get(bug.id);
    if (why && !out.has(bug.id)) out.set(bug.id, why);
  }
  return new Map([...out].filter(([bug]) => !fine.has(bug)));
}

const walk = (run, dir) => entries(run, dir).flatMap((e) => (e.name.startsWith('.') ? [] : e.isDirectory() ? walk(run, `${dir}/${e.name}`) : [`${dir}/${e.name}`]));

// Evidence files keep their secrets, so name the ones to redact before sharing; a log line testers write must hold none. Never prints the secret.
function secretProblems(run, lines, verify = true) {
  const problems = [];
  const kindOf = (text) => SECRETS.find(([, re]) => re.test(text))?.[0];
  for (const l of lines) {
    const kind = kindOf(Object.values(l).filter((v) => typeof v === 'string').join('\n'));
    if (kind) problems.push(`evidence.jsonl line ${l.n}: a secret in a log line (${kind}); write it as <redacted>`);
  }
  // A quick mid-run build reads no capture: the final build names the files that hold one.
  if (!verify) return problems;
  for (const file of new Set(lines.filter((l) => l.file && !String(l.method).startsWith('failed:') && !VISUAL.test(String(l.file))).map((l) => String(l.file)))) {
    const path = resolve(run, file);
    if (!path.startsWith(resolve(run) + sep) || !existsSync(path) || !statSync(path).isFile() || statSync(path).size > 5e6) continue;
    const kind = kindOf(readFileSync(path, 'utf8'));
    if (kind) problems.push(`${file}: holds a secret (${kind}); redact it before you share it`);
  }
  return problems;
}

const knownCases = (claims) => new Set(claims.flatMap((c) => (c.cases ?? []).map((k) => `${c.id}:${k.id}`)));

export function checkEvidence(run, lines, claims, checks = [], { rules = null, motion = false, verify = true, checkOn = false } = {}) {
  rules ??= legacy(motion);
  const checked = new Map(checks.map((c) => [`${c.file}\n${c.sha256}`, c]));
  const known = knownCases(claims);
  const pictured = new Set(claims.filter((c) => rules[c.target]?.provenBy === 'picture').map((c) => c.id));
  // A case whose expect no screen shows (a status, a stored value, an email, a size) is proven by a text file the check
  // marks "proves"; a picture of it that the check finds not showing that value is then no problem.
  const byFile = new Set(lines.filter((l) => l.claim && checked.get(`${l.file}\n${l.sha256}`)?.proves === true).map((l) => `${l.claim}:${l.case}`));
  const motionOf = new Map(claims.map((c) => [c.id, rules[c.target]?.motion]));
  const keys = new Set();
  const ok = new Set();
  const mismatched = new Set();
  // Bugs whose own copies (or the file a copy was made from) the check says mismatch, with its why: the fail is
  // contradicted by its own evidence. A retry's or another viewport's file is not the fail's evidence.
  const contradicts = new Map();
  const badSha = new Map(checks.filter((c) => c.verdict === 'mismatch').map((c) => [c.sha256, c.why ?? 'it does not show what its note says']));
  for (const l of lines) if (l.bug && badSha.has(l.sha256) && !contradicts.has(l.bug)) contradicts.set(l.bug, badSha.get(l.sha256));
  const problems = [];
  const unchecked = [];
  // The code the run last captured on; evidence from older code is stale.
  const latest = lines.filter((l) => l.commit && l.at).reduce((a, l) => (!a || String(l.at) > String(a.at) ? l : a), null)?.commit;
  lines.forEach((line, index) => {
    const at = `evidence.jsonl line ${line.n ?? index + 1}`;
    const key = `${line.claim}:${line.case}`;
    // A failed capture attempt is a record, not a file.
    if (String(line.method).startsWith('failed:')) return;
    // A bug's or an explorer's file is checked like any other, but is evidence for no case.
    const record = !line.claim;
    const path = resolve(run, String(line.file));
    if (!record && !known.has(key)) return problems.push(`${at}: unknown claim or case ${key}`);
    if (!line.file || !(path.startsWith(resolve(run) + sep))) return problems.push(`${at}: file outside run folder ${line.file}`);
    if (!existsSync(path) || !statSync(path).isFile()) return problems.push(`${at}: file missing ${line.file}`);
    // Mid-run builds read no capture: fingerprints are checked once, by the step's final build.
    if (verify && createHash('sha256').update(readFileSync(path)).digest('hex') !== line.sha256) return problems.push(`${at}: hash mismatch ${line.file}`);
    if (latest && line.commit && line.commit !== latest) {
      mismatched.add(key);
      return problems.push(`${at}: captured on ${line.commit}, but the run's latest code is ${latest}: capture it again`);
    }
    const check = checked.get(`${line.file}\n${line.sha256}`);
    if (check?.verdict === 'mismatch') {
      mismatched.add(key);
      return problems.push(`${at}: check says mismatch ${line.file}: ${check.why}`);
    }
    if (check?.verdict === 'unclear') problems.push(`${at}: check unclear ${line.file}: ${check.why}`);
    if (check?.verdict === 'not-shown' && !byFile.has(key)) problems.push(`${at}: check says not shown ${line.file}: ${check.why}`);
    // With the check on, a file no checker wrote a row for was never opened: a checker stopped or wrote no check file.
    if (checkOn && verify && !check) unchecked.push(line.n ?? index + 1);
    ok.add(line);
    // Setup output shows the starting state, not the case's result; a file that does not show the expected value
    // (off screen, in another tab) proves nothing, but puts no doubt on the case's other files.
    if (record || String(line.method).startsWith('setup command') || check?.verdict === 'not-shown') return;
    // A picture-proven case is proven by what a person can see in its own file (a recording when its target's rule says motion):
    // text the tester saved only supports it, and a file named for another case shows that case.
    const name = basename(String(line.file));
    const own = name.startsWith(`${line.claim}-${line.case}`) && /^[.-]/.test(name.slice(`${line.claim}-${line.case}`.length));
    const proves = check?.proves === true && check.verdict === 'matches';
    if (pictured.has(line.claim) && !proves && (!own || !(motionOf.get(line.claim) ? MOTION : VISUAL).test(String(line.file)))) return;
    keys.add(key);
    if (line.viewport) keys.add(`${key}@${line.viewport}`);
  });
  // One file that does not show what its note says, or was captured on older code, puts the whole case in doubt.
  // Its viewport keys go too, or a case run at a named viewport would survive the mismatch.
  for (const key of [...keys]) if (mismatched.has(key.split('@')[0])) keys.delete(key);
  if (unchecked.length) problems.push(`evidence.jsonl ${unchecked.length === 1 ? 'line' : 'lines'} ${unchecked.join(', ')}: not checked: no row in evidence-check.jsonl`);
  return { keys, ok, problems, unchecked: unchecked.length, contradicts };
}

const verdictOrder = { disproved: 0, 'not-proven': 1, checking: 1, proven: 2 };

// With verify false (a mid-run build), no capture is read and every verdict is 'checking'.
export function buildProof(run, { verify = true } = {}) {
  const problems = [];
  // Only an exploring run has charters/ (the explorers' logs): it reports bugs, and has claims only from older runs that proved them.
  const explored = existsSync(join(run, 'charters'));
  const doc = readJson(run, 'claims.json', problems) ?? {};
  const charters = explored ? readJson(run, 'charters.json', problems) ?? {} : {};
  const claims = doc.claims ?? [];
  const known = knownCases(claims);
  const sessions = ['sessions', 'charters'].flatMap((dir) => entries(run, dir)
    .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
    .map((e) => ({ id: basename(e.name, '.jsonl'), file: `${dir}/${e.name}` })))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(({ id, file }) => {
      const steps = readJsonl(run, file, problems).filter(({ row, n }) => {
        if (!row.case || known.has(`${row.claim}:${row.case}`)) return true;
        problems.push(`${file} line ${n}: unknown claim or case ${row.claim}:${row.case}`);
        return false;
      }).map(({ row }) => row);
      return { id, steps };
    });
  const lines = readJsonl(run, 'evidence.jsonl', problems).map(({ row, n }) => ({ ...row, n }));
  const checks = readJsonl(run, 'evidence-check.jsonl', problems).map(({ row }) => row);
  const env = readText(projectDir(run), 'environment.md');
  const rules = runTargets(run);
  const evidence = checkEvidence(run, lines, claims, checks, { rules, verify, checkOn: checksOn(env) });
  problems.push(...evidence.problems);
  // A failed capture proves nothing, but the person must see that it was tried.
  for (const l of lines) {
    const method = String(l.method);
    if (method.startsWith('failed:') && known.has(`${l.claim}:${l.case}`)) problems.push(`${l.claim} case ${l.case}: capture failed: ${method.slice('failed:'.length).trim()}`);
  }
  // Every capture is logged: a file nobody logged may be a silent re-capture.
  const logged = new Set(lines.map((l) => relative(resolve(run), resolve(run, String(l.file))).split(sep).join('/')));
  for (const file of [...walk(run, 'evidence'), ...walk(run, 'bugs')]) {
    if (/^bugs\/[^/]+\/bug\.json$/.test(file) || logged.has(file)) continue;
    problems.push(`${file}: not in evidence.jsonl`);
    // An unlogged file named for a case may be a failed first attempt: it puts that case in doubt.
    const [, id, c] = file.match(/^evidence\/(C-[0-9a-f]{4,}|C\d+)-([^-.]+)[-.]/) ?? [];
    if (id) for (const key of [...evidence.keys]) if (key === `${id}:${c}` || key.startsWith(`${id}:${c}@`)) evidence.keys.delete(key);
  }
  problems.push(...secretProblems(run, lines, verify));
  const joined = new Set(lines.map((l) => `${l.file}\n${l.sha256}`));
  entries(run, '')
    .filter((e) => e.isFile() && /^evidence-.+\.jsonl$/.test(e.name) && e.name !== 'evidence-check.jsonl')
    .forEach((e) => readJsonl(run, e.name, problems).forEach(({ row, n }) => {
      if (!joined.has(`${row.file}\n${row.sha256}`)) problems.push(`${e.name} line ${n}: not joined into evidence.jsonl`);
    }));
  const unconfirmed = verify ? contradicted(run) : new Map();
  const bugs = entries(run, 'bugs')
    .filter((e) => e.isDirectory())
    .flatMap((e) => {
      const bug = readJson(run, `bugs/${e.name}/bug.json`, problems);
      return bug ? [{ ...bug, dir: `bugs/${e.name}`, evidence: lines.filter((l) => l.bug === bug.id && evidence.ok.has(l)), ...(unconfirmed.has(bug.id) && { unconfirmed: unconfirmed.get(bug.id) }) }] : [];
    });
  const results = caseResults(sessions);
  // A fail its own evidence contradicts (the note says no message, the recording shows it) disproves nothing: unclear.
  for (const [key, r] of results) {
    const why = r.bug && evidence.contradicts.get(r.bug);
    if (!why || r.result !== 'fail') continue;
    results.set(key, { ...r, result: 'blocked', note: `unclear: the evidence contradicts the fail: ${why}` });
    if (!key.includes('@')) problems.push(`${key.replace(':', ' case ')}: unclear: failed, but its evidence contradicts the note: ${why}`);
  }
  const steps = sessions.flatMap((s) => s.steps);
  // In an exploring run, a proven claim from a finding means the bug did not happen again.
  const rows = claims.flatMap((claim) => {
    const v = claimVerdict(claim, results, evidence.keys, rules[claim.target] ?? FILE_RULE);
    if (!v) return [];
    problems.push(...v.problems);
    const cases = v.cases.map((c) => {
      const def = (claim.cases ?? []).find((k) => k.id === c.id);
      const step = steps.findLast((x) => x.claim === claim.id && x.case === c.id && x.result === c.result);
      return { ...c, do: def?.do, expect: def?.expect, actual: step?.actual, note: results.get(`${claim.id}:${c.id}`)?.note };
    });
    // Why a claim is not proven: a case blocked (a fixture, a setup, the tool, flaky) or a pass no file shows.
    const cause = v.verdict !== 'not-proven' ? null : cases.some((c) => c.result === 'blocked') ? 'blocked'
      : cases.some((c) => c.result === 'pass' && !c.hasEvidence) ? 'no evidence' : 'not run';
    return [{
      ...claim, verdict: verify ? v.verdict : 'checking', cases, ...(cause && { cause }),
      ...(explored && v.verdict === 'proven' && String(claim.source ?? '').startsWith('found:') && { notReproduced: true }),
      evidence: lines.filter((l) => l.claim === claim.id && evidence.ok.has(l)),
      bugs: bugs.filter((b) => b.claim === claim.id),
    }];
  });
  rows.sort((a, b) => verdictOrder[a.verdict] - verdictOrder[b.verdict] || (a.rank === 'headline' ? 0 : 1) - (b.rank === 'headline' ? 0 : 1) || a.id.localeCompare(b.id, undefined, { numeric: true }));
  const count = (v) => rows.filter((c) => c.verdict === v).length;
  const data = {
    run: basename(resolve(run)),
    kind: explored && !claims.length ? 'explore' : 'proof',
    questions: explored ? openQuestions(run) : [],
    newTags: newTagsOf(claims, ledgerOf(run)),
    generatedAt: new Date().toISOString(),
    title: doc.title ?? charters.title ?? null,
    approvedBy: doc.approvedBy ?? charters.approvedBy ?? (doc.approvedAt ? 'user' : null),
    decisions: readDecisions(readText(run, 'decisions.md') ?? (where(run) ? readText(dirname(resolve(run)), 'decisions.md') : null)),
    input: doc.input ?? null,
    subject: lines[0] ? { commit: lines[0].commit, env: lines[0].env } : null,
    willNotProve: doc.willNotProve ?? null,
    tally: { proven: count('proven'), disproved: count('disproved'), notProven: count('not-proven'), checking: count('checking') },
    claims: rows,
    areas: (doc.areas ?? []).map((a) => ({ ...a, verdict: areaVerdict(rows.filter((c) => c.area === a.id).map((c) => c.verdict)) })),
    bugs: [...bugs].sort((a, b) => SEVERITY.indexOf(a.severity) - SEVERITY.indexOf(b.severity) || byId(a, b)),
    sessions,
    notChecked: evidence.unchecked,
    problems,
  };
  return { data, problems };
}

const SEVERITY = ['critical', 'major', 'minor', 'cosmetic'];
const severityText = (bugs) => SEVERITY.map((s) => [s, bugs.filter((b) => b.severity === s).length]).filter(([, n]) => n).map(([s, n]) => `${n} ${s}`).join(' · ');

export function chatSummary(data, openUrl) {
  const { proven, disproved, notProven } = data.tally;
  const line = (mark, c) => `${mark} ${c.id} ${c.statement}${c.bugs?.length ? ` (${c.bugs.map((b) => b.id).join(', ')})` : ''}`;
  const open = data.claims.filter((c) => c.verdict !== 'proven');
  // A gap (a missing feature) is listed apart and never counted as a bug. `origin`: the pass that found it.
  // A bug its tester withdrew (the app discloses it, or a rule allows it) or marked a duplicate is listed apart too.
  const apart = (b) => b.withdrawn ?? (b.duplicateOf ? `a duplicate of ${b.duplicateOf}` : null);
  const bugs = data.bugs.filter((b) => b.kind !== 'gap' && !b.unconfirmed && !apart(b));
  const gaps = data.bugs.filter((b) => b.kind === 'gap' && !b.unconfirmed && !apart(b));
  const unconfirmed = data.bugs.filter((b) => b.unconfirmed && !apart(b));
  const withdrawn = data.bugs.filter(apart);
  const by = bugs.some((b) => b.origin) ? ['blind', 'lead'].map((o) => `${bugs.filter((b) => b.origin === o).length} ${o}`).join(', ') : '';
  if (data.kind === 'explore') return [
    `Explore: ${data.title}: ${bugs.length} bugs${bugs.length ? ` (${[severityText(bugs), by].filter(Boolean).join('; ')})` : ''}${gaps.length ? `, ${gaps.length} ${gaps.length === 1 ? 'gap' : 'gaps'}` : ''}`,
    ...bugs.map((b) => `✗ ${b.id} [${b.severity}] ${b.title}`),
    ...gaps.map((b) => `+ ${b.id} [gap] ${b.title}`),
    ...unconfirmed.map((b) => `? ${b.id} not confirmed: ${b.unconfirmed}`),
    ...withdrawn.map((b) => `- ${b.id} withdrawn: ${apart(b)}`),
    ...openQuestionLines(data.questions ?? [], (q) => q.charter),
    ...notCheckedLines(data),
    ...autoLines(data),
    `Open: ${openUrl}`,
    ...tagLines(data),
  ].join('\n');
  const causes = ['no evidence', 'blocked', 'not run'].map((k) => [k, data.claims.filter((c) => c.verdict === 'not-proven' && c.cause === k).length]).filter(([, n]) => n);
  const why = causes.length ? ` (${causes.map(([k, n]) => `${n} ${k === 'no evidence' ? 'passed, no file shows it' : k}`).join(' · ')})` : '';
  const out = [`Proof: ${data.title}: ${proven} proven · ${disproved} disproved · ${notProven} not proven${why}`];
  // Inputs testers had no file for, named once, so the user can add them to Fixtures: in environment.md.
  const fixtures = [...new Set(data.claims.flatMap((c) => c.cases ?? []).map((c) => String(c.note ?? '').match(/^needs fixture: (.+)$/)?.[1]).filter(Boolean))];
  if (fixtures.length) out.push(`Add to the Fixtures: folder in environment.md: ${fixtures.join('; ')}`);
  const mark = (c) => (c.verdict === 'disproved' ? '✗' : '?');
  out.push(...open.filter((c) => c.verdict === 'disproved').map((c) => line('✗', c)));
  out.push(...open.filter((c) => c.verdict !== 'disproved' && c.rank === 'headline').map((c) => line(mark(c), c)));
  out.push(...open.filter((c) => c.verdict !== 'disproved' && c.rank !== 'headline').map((c) => line(mark(c), c)));
  out.push(...data.claims.filter((c) => c.notReproduced).map((c) => `? ${c.id} ${c.statement} (${c.source}; not reproduced)`));
  if (data.willNotProve) out.push(`Will not prove: ${data.willNotProve}`);
  out.push(...notCheckedLines(data), ...autoLines(data), `Open: ${openUrl}`, ...tagLines(data));
  return out.join('\n');
}

// The run's questions the user has not answered yet; answers live in the feature folder, two above the run.
const openQuestions = (run) => { const answered = answersOf(join(run, '..', '..')); return stepQuestions(run).filter((q) => !answered.has(q.id)); };

// Tags no ledger claim has yet, so a stray one is seen in auto mode too, where nobody reads --plan.
const newTagsOf = (claims, ledger) => {
  if (!ledger) return [];
  const known = new Set(ledger.claims.flatMap((c) => c.tags));
  return [...new Set(claims.flatMap((c) => c.tags ?? []))].filter((t) => !known.has(t));
};
const tagLines = (data) => (data.newTags?.length ? [`New tags: ${data.newTags.join(', ')}`] : []);

const notCheckedLines = (data) => (data.notChecked ? [`Not checked: ${data.notChecked} evidence ${data.notChecked === 1 ? 'file' : 'files'} no checker opened (see the Problem lines)`] : []);

function autoLines(data) {
  if (data.approvedBy !== 'auto' && !(data.decisions.count > 0)) return [];
  return [`Auto mode: ${data.decisions.count} decisions, see decisions.md`,
    ...(data.decisions.defaults.length ? ['Decided without you:', ...data.decisions.defaults.map((d) => `- ${d}`)] : [])];
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// The project's index.html: features with their latest run, the bugs in those runs, then every run, newest first.
const KINDS = { explore: 'Explore', prove: 'Proof', 'explore-and-fix': 'Explore and fix', improve: 'Self-improvement', fix: 'Fix' };
// The counts as the request page says them, without the zeros and without need-you, which the card says on its own.
// Each count is in the colour of its state, and a line breaks only at a dot, so a number stays with its label.
const countsHtml = (c) => {
  const checks = c.ownChecks ? [[`${c.checksProven ?? 0} proven`, c.checksProven && 'good', `${c.checks} checks: `], [`${c.checksFailed} failed`, 'need'], [`${c.checksUnproven} not proven`, 'wait']] : [];
  const list = [...(c.found || !c.ownChecks ? [[`${c.found ?? 0} found`], [`${c.fixed} fixed`], [`${c.proven} proven`, 'good']] : []), ...checks,
    [`${c.questions} ${c.questions === 1 ? 'question' : 'questions'}`, 'wait']].filter(([text], i) => i === 0 || !/^(0|undefined) /.test(text));
  const nb = (t) => esc(t).replace(/ /g, '&nbsp;');
  // Spaced, not dotted: the coloured marks already part them.
  return list.map(([text, cls, pre = '']) => `${nb(pre)}<span class="k${cls ? ` ${cls}` : ''}">${nb(text)}</span>`).join(' ');
};
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
// "2026-10-05T14:30" → "5 Oct at 14:30", with the year only when it is not this one.
const dayAt = (t) => { const [, y, m, d, hm] = t.match(/^(\d{4})-(\d\d)-(\d\d)T(\d\d:\d\d)/) ?? [];
  return y ? `${Number(d)} ${MONTHS[m - 1]}${y === String(new Date().getUTCFullYear()) ? '' : ` ${y}`} at ${hm}` : ''; };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// A request starts when its folder is named: 2026-10-05-1430-explore.
const startedAt = (name) => dayAt(String(name).replace(/^(\d{4}-\d\d-\d\d)-(\d\d)(\d\d).*/, '$1T$2:$3'));
// The tones the request page uses: red for what failed, amber for what waits on a person, indigo for a run, green when nothing does.
const toneOf = (r) => { const c = r.counts ?? {}; const waits = c.needsYou || c.questions;
  return r.live ? (waits ? 'wait' : 'run') : c.checksFailed || (r.bugs ?? []).some((b) => b.state === 'Fix did not hold') ? 'need' : waits ? 'wait' : 'good'; };
const TONES = ['need', 'wait', 'run', 'good'];
// A bug's tone as the request page gives it.
const bugTone = (b) => (b.state === 'Fix did not hold' ? 'need' : b.needsYou ? 'wait' : b.state === 'Fixed and proven' ? 'good' : /^Fix made/.test(b.state ?? '') ? 'run' : 'idle');
// One mark per bug, or per check for a proof, from proven to failed. A summary written before bugs had a state
// is marked from its counts.
const tally = (r) => { const c = r.counts ?? {}; const n = (k) => Math.max(0, k || 0);
  const marks = r.bugs?.length ? r.bugs.map(bugTone)
    : c.found ? [...Array(n(c.proven)).fill('good'), ...Array(n(c.fixed - c.proven)).fill('run'), ...Array(n(c.found - Math.max(c.fixed ?? 0, c.proven ?? 0))).fill('idle')]
    : c.ownChecks ? [...Array(n(c.checksProven)).fill('good'), ...Array(n(c.checksUnproven)).fill('wait'), ...Array(n(c.checksFailed)).fill('need')] : [];
  const order = ['good', 'run', 'idle', 'wait', 'need'];
  return marks.length ? `<div class="tally" aria-hidden="true">${marks.sort((a, b) => order.indexOf(a) - order.indexOf(b)).map((t, i) => `<i class="${t}" style="--i:${i}"></i>`).join('')}</div>` : ''; };
// The evident mark: a lens with a check in it. The check draws itself when the page opens.
const LOGO = '<svg class="logo" viewBox="0 0 32 32" width="26" height="26" aria-hidden="true"><circle cx="14" cy="14" r="10"/><path class="handle" d="M21.5 21.5 29 29"/><path class="check" d="M9.5 14.5l3 3 6-6.5"/></svg>';

// The project's index.html: what needs you, one card per feature with its latest request and that request's bugs,
// most urgent first, then the earlier requests and the ledger, folded.
export function indexHtml(app, summaries, ledger = null) {
  const requests = [...summaries].sort((a, b) => String(b.name).localeCompare(String(a.name)));
  const latest = [...new Map([...requests].reverse().map((r) => [r.feature, r])).values()]
    .sort((a, b) => TONES.indexOf(toneOf(a)) - TONES.indexOf(toneOf(b)) || a.feature.localeCompare(b.feature));
  const older = requests.filter((r) => !latest.includes(r));
  const href = (r) => esc(`${r.feature}/${r.name}/report.html`);
  const kind = (r) => KINDS[r.kind] ?? r.kind;
  const need = latest.reduce((n, r) => n + (r.counts?.needsYou ?? 0), 0);
  const asked = latest.reduce((n, r) => n + (r.counts?.questions ?? 0), 0);
  const where = latest.filter((r) => r.counts?.needsYou).map((r) => r.feature);
  const headline = need ? `${plural(need, 'thing needs', 'things need')} you, in ${where.length === 1 ? where[0] : `${where.length} features`}.`
    : asked ? `${plural(asked, 'question waits', 'questions wait')} for you.` : requests.length ? 'Nothing needs you.' : 'Nothing has run yet.';
  const tone = latest.some((r) => toneOf(r) === 'need') ? 'need' : need || asked ? 'wait' : 'good';
  const running = requests.filter((r) => r.live).map((r) => r.feature);
  // Under the headline: questions, when the headline is about what needs you, and what runs now.
  const sub = [need && asked && `${plural(asked, 'question waits', 'questions wait')} for you.`,
    running.length && `${running.join(' and ')} ${running.length === 1 ? 'is' : 'are'} running now.`].filter(Boolean);
  const card = (r, i) => { const c = r.counts ?? {}; const counts = countsHtml(c);
    const chip = r.live ? 'Running now' : c.needsYou ? `${c.needsYou} ${c.needsYou === 1 ? 'needs' : 'need'} you` : '';
    return `<a class="feat ${toneOf(r)}" href="${href(r)}" style="--c:${i}"><div class="top"><span class="name">${esc(r.feature)}</span>${chip ? `<span class="chip">${chip}</span>` : ''}</div>
<div class="what">${esc(kind(r))}${r.auto ? ', auto' : ''}, ${esc(startedAt(r.name))}</div>
${tally(r)}${counts ? `<p class="counts">${counts}</p>` : ''}</a>`; };
  const claims = (ledger?.claims ?? []).filter((c) => c.status !== 'retired');
  const disproved = claims.filter((c) => c.verdict === 'disproved').length;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
${running.length ? '<meta http-equiv="refresh" content="30">\n' : ''}<title>${esc(app)} requests</title>
${INDEX_STYLE}</head><body${running.length ? ' class="live"' : ''}><main>
<header class="brand">${LOGO}<b>evident</b><span>${esc(app)}</span></header>
<h1 class="${tone}">${esc(headline)}</h1>
${sub.length ? `<p class="sub">${esc(sub.join(' '))}</p>\n` : ''}<p class="kick">${plural(requests.length, 'request', 'requests')}, updated ${dayAt(new Date().toISOString())} UTC.</p>
<div class="feats">${latest.map(card).join('\n')}</div>
${older.length ? `<details><summary>Earlier requests <span class="n">${older.length}</span></summary><ol class="older">${older.map((r) => {
    const counts = countsHtml(r.counts ?? {});
    return `<li><a href="${href(r)}">${esc(r.feature)}, ${esc(kind(r).toLowerCase())}</a>${r.auto ? ', auto' : ''}, ${esc(startedAt(r.name))}${counts ? ` · ${counts}` : ''}${r.live ? ' <span class="k run">Running now</span>' : ''}</li>`; }).join('\n')}</ol></details>\n` : ''}${
    claims.length || ledger?.problems?.length ? `${(ledger.problems ?? []).map((p) => `<p class="bad">Problem: ${esc(p)}</p>\n`).join('')}<p class="ledger-link"><a href="ledger.html">Ledger</a> <span class="n">${plural(claims.length, 'claim', 'claims')}${disproved ? `, ${disproved} disproved` : ''}</span></p>\n` : ''}</main></body></html>
`;
}

// Light only. Text stays in ink; colour marks state only, as dots, chips and the tally, so every line reads.
const INDEX_STYLE = `<style>:root{--paper:#f4f5f7;--sheet:#fff;--ink:#15171c;--ink-2:#434852;--ink-3:#6b717d;--line:#e2e5ea;--good:#1f9d55;--need:#e5484d;--wait:#f0a020;--run:#6366f1;--idle:#cfd3da;--serif:Charter,"Bitstream Charter","Iowan Old Style",Georgia,serif;--sans:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color-scheme:light}
*{box-sizing:border-box}html{background:var(--paper)}body{margin:0;color:var(--ink);font:16px/1.55 var(--sans);font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
main{max-width:920px;margin:0 auto;padding:24px 16px 72px}a{color:var(--ink);text-underline-offset:3px}
.good{--tone:var(--good)}.need{--tone:var(--need)}.wait{--tone:var(--wait)}.run{--tone:var(--run)}.idle,.retired{--tone:var(--idle)}
.brand{display:flex;align-items:center;gap:8px;font-size:15px}.brand b{font-weight:750;letter-spacing:-.01em}.brand span{color:var(--ink-3)}.brand span::before{content:"/";margin-right:8px;color:var(--ink-3);opacity:.5}
.logo{fill:none;stroke:var(--ink);stroke-width:2.6;stroke-linecap:round;stroke-linejoin:round}.logo .check{stroke:var(--good);stroke-dasharray:16;animation:draw .7s .2s ease-out both}
h1{margin:36px 0 8px;font:700 clamp(30px,7vw,46px)/1.08 var(--serif);letter-spacing:-.02em;text-wrap:balance}
.sub{margin:0 0 4px;color:var(--ink-2);font-size:17px}.kick{margin:0;color:var(--ink-3);font-size:13px}
.feats{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,290px),1fr));gap:12px;margin:28px 0 36px}
.feat{display:flex;flex-direction:column;gap:6px;padding:16px 18px;background:var(--sheet);border:1px solid var(--line);border-radius:14px;color:inherit;text-decoration:none;box-shadow:0 1px 2px rgb(16 24 40/.05);transition:border-color .15s,transform .15s;animation:rise .5s calc(var(--c)*90ms) ease-out both}
.feat:hover{border-color:var(--ink-3);transform:translateY(-1px)}.feat:focus-visible{outline:2px solid var(--run);outline-offset:2px}
.top{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center}.name{font:700 21px/1.2 var(--serif)}
.chip{margin-left:auto;display:inline-flex;align-items:center;gap:6px;padding:2px 10px;border-radius:999px;font-size:12.5px;font-weight:650;white-space:nowrap;background:color-mix(in srgb,var(--tone) 16%,var(--sheet))}
.chip::before,.k:is(.good,.need,.wait,.run)::before,p.bad::before{content:"";display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--tone)}
.run .chip::before{animation:pulse 1.6s ease-in-out infinite}
.what{font-size:14px;color:var(--ink-3)}
.tally{display:flex;gap:3px;margin:6px 0 2px}.tally i{flex:0 1 28px;height:10px;border-radius:3px;background:var(--tone);transform-origin:left;animation:grow .4s calc(var(--c)*90ms + 300ms + var(--i)*45ms) cubic-bezier(.2,.8,.2,1) both}
.counts{margin:0;font-size:14px;font-weight:500;color:var(--ink-2)}.k{margin-right:10px}.k:last-child{margin-right:0}.k::before{margin-right:5px;vertical-align:1px}
details{border-top:1px solid var(--line)}details+details,p.bad+details{margin-top:0}summary{list-style:none;cursor:pointer;padding:14px 0;font-weight:650}summary::-webkit-details-marker{display:none}summary::before{content:"+";display:inline-block;width:1.2em;color:var(--ink-3)}details[open]>summary::before{content:"−"}
.n{font-size:12px;font-weight:600;color:var(--ink-3);border:1px solid var(--line);border-radius:999px;padding:1px 8px;margin-left:4px;white-space:nowrap}
.ledger-link{margin:0;padding:14px 0;border-top:1px solid var(--line);font-weight:650}.ledger-link a{color:var(--ink)}
ol.older{list-style:none;margin:0 0 12px;padding:0}ol.older li{padding:8px 0;border-top:1px solid var(--line);font-size:14px;color:var(--ink-2)}ol.older li:first-child{border-top:0}
.terms{color:var(--ink-3);font-size:14px;margin:0 0 8px}
dl{display:grid;grid-template-columns:max-content 1fr;gap:2px 12px;margin:0 0 10px 1.2em;font-size:14px}dt{color:var(--ink-3)}dd{margin:0}
p.bad{--tone:var(--need);margin:0;padding:12px 0;border-top:1px solid var(--line)}p.bad::before{margin-right:8px}
@keyframes rise{from{opacity:0;transform:translateY(6px)}}@keyframes grow{from{transform:scaleX(0)}}@keyframes draw{from{stroke-dashoffset:16}}@keyframes pulse{50%{opacity:.35}}
.live .feat,.live .tally i,.live .check{animation:none}@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}</style>`;

// Rebuilds <project>/index.html from every <feature>/<request>/summary.json. Only request folders count, so
// ledger/ and a monorepo's per-app folders are never taken for features.
export function writeIndex(project) {
  const subdirs = (dir) => readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(dir, e.name));
  const requests = subdirs(project).filter((f) => basename(f) !== 'ledger')
    .flatMap((f) => subdirs(f).filter((r) => REQUEST.test(basename(r))));
  const summaries = requests
    .map((r) => join(r, 'summary.json'))
    .filter((file) => existsSync(file))
    .flatMap((file) => {
      try { return [JSON.parse(readFileSync(file, 'utf8'))]; } catch { return []; }
    });
  const out = join(project, 'index.html');
  // The app is the folder .evident sits in.
  const app = basename(project) === '.evident' ? basename(dirname(resolve(project))) : basename(project);
  const ledger = readLedger(join(project, 'ledger'));
  writeFileSync(out, indexHtml(app, summaries, ledger));
  // The ledger has its own page once it holds anything; a page left from an emptied ledger goes.
  const page = join(project, 'ledger.html');
  if (ledger?.claims.length || ledger?.problems?.length) writeFileSync(page, ledgerPage(app, ledger));
  else rmSync(page, { force: true });
  return out;
}

const byId = (a, b) => a.id.localeCompare(b.id, undefined, { numeric: true });
const verdictText = { proven: 'Proven on the cases run', disproved: 'Disproved', 'not-proven': 'Not proven' };

// The app's ledger as an HTML section of the project index: every claim with its tags, retired ones last.
export function ledgerHtml({ claims = [], terms = [] }) {
  const field = (label, text) => (text == null || text === '' ? '' : `<dt>${label}</dt><dd>${esc(text)}</dd>`);
  const block = (c) => {
    const verdict = c.verdict ? verdictText[c.verdict] ?? c.verdict : null;
    const css = c.status === 'retired' ? 'retired' : { proven: 'good', disproved: 'need', 'not-proven': 'wait' }[c.verdict] ?? '';
    const shown = c.status === 'retired' ? 'Retired' : verdict ?? 'Not proven yet';
    return `<details><summary><b>${esc(c.id)}</b> ${esc(c.statement)} <span class="${css}">${esc(shown)}</span></summary><dl>${[
      field('Tags', (c.tags ?? []).join(', ')),
      field('Given', c.given), field('Setup', c.setup),
      field('Cases', (c.cases ?? []).map((k) => `${k.id}. ${k.do} → ${k.expect}`).join(' · ')),
      field('Viewports', c.viewports?.length ? c.viewports.join(', ') : null),
      field('Evidence', c.evidence), field('Proof', c.proof), field('Files', (c.files ?? []).join(', ')),
      c.approvedBy === 'auto' ? field('Approved', 'by auto mode') : '',
      c.status === 'retired' ? field('Status', `retired: ${c.retiredReason}`) : '',
    ].join('')}</dl></details>`;
  };
  // One list, worst first and retired last, each claim tagged with every feature it belongs to. A radio per verdict and per
  // tag hides the other claims with CSS alone, so the filters work where no script runs.
  const tone = (c) => (c.status === 'retired' ? 'retired' : { proven: 'good', disproved: 'need' }[c.verdict] ?? 'wait');
  const order = ['need', 'wait', 'good', 'retired'];
  // A claim's feature file counts as one of its tags, so filtering by a feature always finds the claims filed under it.
  const tagsOf = (c) => [...new Set([...(c.tags ?? []), ...(c.home ? [c.home] : [])])];
  const tags = [...new Set(claims.flatMap(tagsOf))].sort();
  const sorted = [...claims].sort((a, b) => order.indexOf(tone(a)) - order.indexOf(tone(b)) || byId(a, b));
  const radio = (name, id, label, checked = false) => `<input type="radio" name="${name}" id="${id}"${checked ? ' checked' : ''}><label for="${id}">${label}</label>`;
  const count = (t) => claims.filter((c) => tone(c) === t).length;
  const verdicts = [['need', 'Disproved'], ['wait', 'Not proven'], ['good', 'Proven'], ['retired', 'Retired']].filter(([t]) => count(t));
  return `<style>${[...verdicts.map(([t]) => `v-${t}`), ...tags.map((_, i) => `t-${i}`)].map((k) => `body:has(#${k}:checked) .claim:not(.${k}){display:none}`).join('')}</style>
<div class="filters"><div>${radio('v', 'v-all', `All ${claims.length}`, true)}${verdicts.map(([t, label]) => radio('v', `v-${t}`, `${label} ${count(t)}`)).join('')}</div>
${tags.length > 1 ? `<div>${radio('t', 't-all', 'All features', true)}${tags.map((t, i) => radio('t', `t-${i}`, `${esc(t)} ${claims.filter((c) => tagsOf(c).includes(t)).length}`)).join('')}</div>` : ''}</div>
<ul class="claims">${sorted.map((c) => `<li class="claim v-${tone(c)}${tagsOf(c).map((t) => ` t-${tags.indexOf(t)}`).join('')}">${block(c).replace('</span></summary>', `</span>${tagsOf(c).map((t) => ` <span class="tag">${esc(t)}</span>`).join('')}</summary>`)}</li>`).join('\n')}</ul>
${terms.length ? `<p class="terms">Words used here: ${terms.map((t) => `<b>${esc(t.term)}</b>, ${esc(t.means)}`).join('; ')}.</p>` : ''}`;
}

// The ledger's own page, next to index.html: filters for verdict and feature, and a search box where a script may run.
export function ledgerPage(app, ledger) {
  const claims = ledger.claims ?? [];
  const live = claims.filter((c) => c.status !== 'retired').length;
  const tags = new Set(claims.flatMap((c) => [...(c.tags ?? []), ...(c.home ? [c.home] : [])])).size;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(app)} ledger</title>
${INDEX_STYLE}${LEDGER_STYLE}</head><body><main>
<header class="brand">${LOGO}<b>evident</b><span>${esc(app)}</span></header>
<p class="back"><a href="index.html">All requests</a></p>
<h1>Ledger</h1>
<p class="sub">What the app should do, with each claim's latest verdict. ${plural(live, 'claim', 'claims')}${claims.length > live ? `, ${claims.length - live} retired` : ''}, tagged with ${plural(tags, 'feature', 'features')}.</p>
${(ledger.problems ?? []).map((p) => `<p class="bad">Problem: ${esc(p)}</p>\n`).join('')}<input type="search" id="q" placeholder="Search claims, ids and tags" hidden>
${ledgerHtml(ledger)}
</main>
<script>
// Search hides the claims whose text does not hold every word typed; the filters above still apply.
const q = document.getElementById('q');
q.hidden = false;
q.addEventListener('input', () => {
  const words = q.value.toLowerCase().split(/\\s+/).filter(Boolean);
  for (const li of document.querySelectorAll('.claim')) li.classList.toggle('miss', !words.every((w) => li.textContent.toLowerCase().includes(w)));
});
</script>
</body></html>
`;
}

const LEDGER_STYLE = `<style>.back{margin:14px 0 0;font-size:14px}.back a{color:var(--ink-3)}main>h1{margin-top:12px}
#q{display:block;width:100%;margin:20px 0 0;padding:10px 14px;font:16px var(--sans);color:var(--ink);background:var(--sheet);border:1px solid var(--line);border-radius:10px}#q[hidden]{display:none}#q:focus{outline:2px solid var(--run);outline-offset:1px}
.filters{margin:14px 0 18px}.filters div{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 8px}.filters input{position:absolute;opacity:0;pointer-events:none}
.filters label{padding:4px 12px;border:1px solid var(--line);border-radius:999px;background:var(--sheet);font-size:13px;font-weight:600;color:var(--ink-2);cursor:pointer}.filters input:checked+label{background:var(--ink);border-color:var(--ink);color:var(--sheet)}.filters input:focus-visible+label{outline:2px solid var(--run);outline-offset:2px}
ul.claims{list-style:none;margin:0;padding:0;background:var(--sheet);border:1px solid var(--line);border-radius:14px}ul.claims>li{border-top:1px solid var(--line);padding:0 16px}ul.claims>li:first-child{border-top:0}ul.claims>li.miss{display:none}
.claims details>summary{list-style:none;cursor:pointer;padding:12px 0}.claims details>summary::-webkit-details-marker{display:none}.claims summary b{font:600 12px var(--mono);color:var(--ink-3);margin-right:6px}
.claims summary span[class]:not(.tag){margin-left:6px;font-size:13px;font-weight:600;color:var(--ink-2);white-space:nowrap}.claims summary span[class]:not(.tag)::before{content:"";display:inline-block;width:7px;height:7px;margin-right:5px;border-radius:50%;background:var(--tone);vertical-align:1px}
.tag{display:inline-block;margin:4px 4px 0 0;padding:0 8px;border-radius:999px;background:var(--paper);font-size:12px;color:var(--ink-3)}.claims dl{margin:0 0 12px}.retired{color:var(--ink-3)}</style>`;

// Fields that belong to one run, not to the ledger.
const RUN_ONLY = ['check', 'fromLedger', 'area', 'draft', 'notReproduced', 'source', 'changed', 'risk'];

// The ledger outlives the run: (new) and (unchanged) after quoted UI text are relative to one diff, so they are dropped.
const plain = (s) => (s == null ? s : String(s).replace(/(?<=["”])\s*\((?:new|unchanged)\)/gi, ''));

// This run's claims as ledger files. A claim whose file a later run changed (reworded it, or retired it) is kept as it is.
export function ledgerFiles(doc, data, ledger) {
  const files = new Map(ledger.claims.map((c) => [c.id, c]));
  const claims = [];
  const kept = [];
  for (const run of doc.claims ?? []) {
    const old = files.get(run.id);
    const reworded = old && run.status !== 'retired' && plain(old.statement) !== plain(run.statement) && !(run.status === 'changed' && plain(old.statement) === plain(run.changed?.from));
    if (reworded || (old?.status === 'retired' && run.status !== 'retired')) {
      kept.push({ id: run.id, why: 'changed since this run' });
      continue;
    }
    // An auto run's unchanged copy of a ledger claim keeps whoever approved it before; missing means user.
    // So does a retirement already in the ledger. A re-prove reuses the old run's claims.json, so it lands on the same marks.
    const copied = doc.approvedBy === 'auto' && run.fromLedger && run.status === 'active';
    const carried = run.status === 'retired' && old?.status === 'retired';
    const approvedBy = copied || carried ? (old?.approvedBy ?? 'user') : (doc.approvedBy ?? 'user');
    const tags = [...new Set([...(run.tags ?? []), ...(old?.tags ?? [])])];
    if (run.status === 'retired') {
      // A tombstone: enough to show what was retired and to stop a re-prove from bringing it back.
      claims.push({ id: run.id, tags, statement: plain(old?.statement ?? run.statement), status: 'retired', retiredReason: run.retiredReason ?? old?.retiredReason ?? null, approvedBy });
      continue;
    }
    const c = Object.fromEntries(Object.entries(run).filter(([k]) => !RUN_ONLY.includes(k)));
    // A run copies ledger claims as routine; the ledger keeps the rank the claim was written with.
    const rank = run.fromLedger ? (old?.rank ?? run.rank) : run.rank;
    const claimFiles = [...new Set([...(old?.files ?? filesOf(old?.source)), ...(run.files ?? []).flatMap(filesOf), ...filesOf(run.source)])];
    const verdict = data.claims.find((r) => r.id === run.id)?.verdict ?? null;
    // Only a proof that is not plain `will` says something lasting: why the claim cannot be proven here.
    if (!c.proof || c.proof === 'will') delete c.proof;
    claims.push({ ...c, statement: plain(c.statement), rank, tags, files: claimFiles, status: 'active', approvedBy, verdict });
  }
  const terms = [...new Map([...ledger.terms, ...(doc.terms ?? [])].map((t) => [t.term, t])).values()].sort((a, b) => a.term.localeCompare(b.term));
  return { claims, terms, kept };
}

// The verdict a claim ends with after a rollback re-proved it in later runs: the last of them that proved or disproved it
// (the rollback's final re-proof runs on the code that stays), else the run's own.
export const settled = (own, later) => later.filter((v) => v === 'proven' || v === 'disproved').at(-1) ?? own;

// What a fix-and-prove rollback undid, from the run's fix-claims.json and each bug's fix record: the claims of fixes
// that are no longer applied, and the ledger claims those fixes changed on purpose (changesClaims), by bug id.
export function undoneFixes(run) {
  const file = join(run, 'fix-claims.json');
  const links = existsSync(file) ? readDoc(file) : [];
  const bugs = links.map((l) => { try { return { ...l, b: readDoc(join(l.bug, 'bug.json')) }; } catch { return { ...l, b: null }; } });
  const kept = (b) => ['fixed', 'partly-fixed'].includes(b?.fix?.status);
  const claims = new Set(bugs.filter((l) => !bugs.some((o) => o.claim === l.claim && kept(o.b))).map((l) => l.claim));
  const changed = new Map(bugs.filter((l) => l.b && !kept(l.b)).flatMap((l) => (l.b.fix?.changesClaims ?? []).map((id) => [id, l.b.id])));
  return { claims, changed };
}

function writeLedger(run, dir, later = []) {
  if (!dir || dir.startsWith('--')) {
    console.error('Usage: node build-proof.mjs <run> --ledger <dir>');
    process.exit(1);
  }
  if (!existsSync(join(run, 'claims.json'))) {
    console.error('  Problem: claims.json: missing');
    process.exit(1);
  }
  const { data } = buildProof(run);
  const ledger = readLedger(dir);
  if (ledger.problems.length) {
    for (const problem of ledger.problems) console.error(`  Problem: ${problem}: resolve it in ${dir}, then run --ledger again`);
    process.exit(1);
  }
  const doc = readDoc(join(run, 'claims.json'));
  // Only approved runs reach the ledger: approval mints the id, and a claim with no tags could never be selected.
  const refused = (doc.claims ?? []).filter((c) => c.status !== 'retired').flatMap((c) => [
    ...(ID.test(c.id) ? [] : [`${c.id}: not a ledger id: approve the run first (re-prove an older run as a new proof)`]),
    ...(c.tags?.length ? [] : [`${c.id}: no tags`]),
  ]);
  if (refused.length) {
    for (const problem of refused) console.error(`  Problem: ${problem}`);
    process.exit(1);
  }
  // A claim stays in the feature file it lives in; a new one goes to this run's feature.
  const feature = where(run)?.feature ?? doc.feature;
  if (!FEATURE.test(feature ?? '')) {
    console.error(`  Problem: claims.json: feature ${JSON.stringify(feature ?? null)} is not a lowercase slug (a-z, 0-9, -; not ledger, terms, targets or drivers) to file new claims under`);
    process.exit(1);
  }
  const undone = undoneFixes(run);
  const again = later.map((r) => buildProof(r).data.claims);
  const final = { ...data, claims: data.claims.map((c) => ({ ...c, verdict: undone.claims.has(c.id) ? 'not-proven'
    : settled(c.verdict, again.map((cs) => cs.find((k) => k.id === c.id)?.verdict).filter(Boolean)) })) };
  const { claims, terms, kept: reworded } = ledgerFiles({ ...doc, claims: (doc.claims ?? []).filter((c) => !undone.changed.has(c.id)) }, final, ledger);
  const kept = [...[...undone.changed].filter(([id]) => (doc.claims ?? []).some((c) => c.id === id)).map(([id, bug]) => ({ id, why: `changed by ${bug}, whose fix was undone` })), ...reworded];
  const homeOf = new Map(ledger.claims.map((c) => [c.id, c.home]));
  mkdirSync(dir, { recursive: true });
  // Each touched feature file is written whole: its claims as read, with this run's in their place.
  const written = new Map(claims.map((c) => [c.id, c]));
  for (const home of new Set(claims.map((c) => homeOf.get(c.id) ?? feature))) {
    const kept = ledger.claims.filter((c) => c.home === home && !written.has(c.id));
    writeClaims(dir, home, [...kept, ...claims.filter((c) => (homeOf.get(c.id) ?? feature) === home)]);
  }
  writeFileSync(join(dir, 'terms.json'), `${JSON.stringify(terms, null, 2)}\n`);
  // The evidence problems were shown by the step's own build: here they would read as if the ledger was not written.
  console.log(`Ledger: ${claims.length} claims written to ${dir}`);
  for (const k of kept) console.log(`  Kept: ${k.id} ${k.why}`);
  if (basename(resolve(dir)) === 'ledger') console.log(`Index: ${pathToFileURL(writeIndex(dirname(resolve(dir)))).href}`);
}

// The step's final build: every capture checked, the result kept as result.json, the request's page rewritten from it.
async function writeProof(run) {
  if (!existsSync(join(run, 'claims.json')) && !existsSync(join(run, 'charters'))) {
    console.error('Problem: claims.json: missing');
    process.exit(1);
  }
  const { data, problems } = buildProof(run);
  const report = await import('./report.mjs');
  const result = report.writeResult(run, data);
  const page = where(run) ? (await report.writeReportFor(where(run).request), join(where(run).request, 'report.html')) : result;
  console.log(chatSummary(data, pathToFileURL(resolve(page)).href));
  // Only a step in a request folder joins the project index.
  if (where(run)) console.log(`Index: ${pathToFileURL(writeIndex(projectDir(run))).href}`);
  for (const problem of problems) console.log(`  Problem: ${problem}`);
}

// Reads a JSON file or exits with a Problem line; a git conflict leaves markers that are not JSON.
function readDoc(file, hint) {
  if (!existsSync(file)) {
    console.error(`  Problem: ${file}: missing`);
    process.exit(1);
  }
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    const conflict = /^<<<<<<< /m.test(readFileSync(file, 'utf8'));
    console.error(`  Problem: ${file}: ${conflict ? 'has git conflict markers' : `not valid JSON: ${error.message}`}${hint ? `: ${hint}` : ''}`);
    process.exit(1);
  }
}

// A step's targets.json names the allowed targets (its keys drop "none" ones); without one, environment.md's ## Targets does.
export function allowedTargets(run, text) {
  let snap = [];
  try { snap = Object.keys(JSON.parse(readText(run, 'targets.json') ?? '{}').targets ?? {}); } catch { /* unreadable: ## Targets */ }
  return snap.length ? snap : text && listedTargets(text);
}

function plan(run) {
  const doc = readDoc(join(run, 'claims.json'));
  const env = join(projectDir(run), 'environment.md');
  const text = existsSync(env) ? readFileSync(env, 'utf8') : null;
  return approvalView(doc, { targets: allowedTargets(run, text), viewports: text && listedViewports(text), ledger: ledgerOf(run), rules: runTargets(run) });
}

// The project's ledger for a step in a request folder; none for a folder outside the layout.
const ledgerOf = (run) => (where(run) ? readLedger(join(where(run).project, 'ledger')) : null);

function main(run) {
  const view = plan(run);
  console.log(view.text);
  for (const problem of view.problems) console.log(`  Problem: ${problem}`);
}

function approve(run, by = 'user') {
  const { problems } = plan(run);
  if (problems.length) {
    for (const problem of problems) console.error(`  Problem: ${problem}`);
    console.error('Not approved: fix the problems first.');
    process.exit(1);
  }
  const file = join(run, 'claims.json');
  const doc = readDoc(file);
  // New claims get their ledger ids now, so the run, its sessions, its page and the ledger all use one id.
  const taken = new Set([...(ledgerOf(run)?.claims ?? []).map((c) => c.id), ...(doc.claims ?? []).map((c) => c.id)]);
  const minted = new Map();
  for (const c of doc.claims ?? []) {
    if (ID.test(c.id)) continue;
    const id = mintId(taken);
    taken.add(id);
    minted.set(c.id, id);
    c.id = id;
  }
  for (const cover of doc.covers ?? []) cover.claims = (cover.claims ?? []).map((id) => minted.get(id) ?? id);
  // fix-claims.json maps each fixed bug to its claim: it follows the rename.
  const map = join(run, 'fix-claims.json');
  if (minted.size && existsSync(map)) writeFileSync(map, `${JSON.stringify(readDoc(map).map((m) => ({ ...m, claim: minted.get(m.claim) ?? m.claim })), null, 2)}\n`);
  if (minted.size) console.log(`Ids: ${[...minted].map(([from, to]) => `${from} is ${to}`).join(', ')}`);
  doc.approvedAt = new Date().toISOString();
  doc.approvedBy = by;
  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`Approved: ${doc.approvedAt}`);
}

function writeSession(run, id, ids) {
  if (!id || id.startsWith('--') || !ids.length) {
    console.error('Usage: node build-proof.mjs <run> --session <session-id> <claim ids...>');
    process.exit(1);
  }
  const doc = readDoc(join(run, 'claims.json'));
  const unknown = ids.filter((c) => !(doc.claims ?? []).some((k) => k.id === c));
  if (unknown.length) {
    console.error(`  Problem: unknown claim ids ${unknown.join(', ')}`);
    process.exit(1);
  }
  mkdirSync(join(run, 'sessions'), { recursive: true });
  const out = join(run, 'sessions', `${id}.claims.json`);
  writeFileSync(out, JSON.stringify(sessionClaims(doc, ids), null, 2));
  console.log(`Session: ${out} (${ids.length} claims)`);
}

// report.mjs imports this file, so the page is written from a promise, never a top-level await: an await here would wait
// for this module to finish loading, which waits on the await.
const refreshReport = (run) => import('./report.mjs').then((m) => m.writeReportFor(run));

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  const [run, flag, ...rest] = process.argv.slice(2);
  if (!run || run.startsWith('--')) {
    console.error('Usage: node build-proof.mjs <run-folder> [--plan | --approve | --session <id> <claim ids...> | --ledger <dir>]');
    process.exit(1);
  }
  if (notAStep(run)) {
    console.error(`  Problem: ${notAStep(run)}`);
    process.exit(1);
  }
  if (flag === '--ledger') writeLedger(run, rest[0], rest.slice(1));
  // A session's claims file shows nowhere on the page, so it is not rebuilt: on a big request that takes minutes.
  else if (flag === '--session') writeSession(run, rest[0], rest.slice(1).flatMap((c) => c.split(',')).filter(Boolean));
  else if (flag === '--approve') {
    const by = rest[0] === '--by' ? rest[1] : 'user';
    if (rest.length && (rest[0] !== '--by' || rest.length !== 2 || !['user', 'auto'].includes(by))) {
      console.error('Usage: node build-proof.mjs <run> --approve [--by user|auto]');
      process.exit(1);
    }
    approve(run, by);
    refreshReport(run);
  }
  else if (flag === '--plan') main(run);
  else writeProof(run).catch((error) => { console.error(`Problem: ${error.message}`); process.exitCode = 1; });
}
