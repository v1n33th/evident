// Usage: node ledger.mjs <ledger dir> [--tags a,b] [--files f,g] [--ids C-7f3a,C-91bd] [--retired]
// The ledger is one file per feature, <ledger dir>/<feature>.jsonl: the claims that feature's runs wrote, one per line,
// sorted by id, each with tags naming every feature it belongs to. Plus terms.json. A merge conflict is whole lines, which
// the user resolves by keeping the lines they want. AIs read the ledger only through this command:
// first `Tags: <tag> (<n>), ...`, then one line per matching claim (at most 60), or with --ids those claims whole,
// then Problem lines. A claim matches when one of its files is in --files, a tag is in --tags or its id is in --ids.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ID = /^C-[0-9a-f]{4,}$/;
// A feature is a lowercase slug, the name of its ledger file; `ledger` and `terms` are the ledger's own names, and `targets`
// and `drivers` the project folder's shared definition folders.
export const FEATURE = /^(?!(?:ledger|terms|targets|drivers)$)[a-z0-9][a-z0-9-]*$/;
const KEYS = ['id', 'tags', 'rank', 'target', 'statement', 'given', 'setup', 'cases', 'viewports', 'evidence', 'files', 'status', 'retiredReason', 'approvedBy', 'verdict'];
// A key holding its default is left out of the file, so a claim read whole costs only what it says; reading fills it back.
const DEFAULTS = { rank: 'routine', status: 'active', approvedBy: 'user', retiredReason: null, verdict: null };
const MAX_LINES = 60;
const MAX_TAGS = 100;
const MAX_PROBLEMS = 10;

export function readLedger(dir) {
  const out = { claims: [], terms: [], problems: [] };
  if (!existsSync(dir)) return out;
  // The oldest layout kept one ledger per feature folder: say so instead of ignoring it.
  for (const sub of readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(join(dir, e.name, 'claims.json')))) {
    out.problems.push(`${sub.name}/claims.json: old ledger layout, not read: its claims need proving again`);
  }
  const seen = new Map();
  for (const name of readdirSync(dir).sort()) {
    if (name.endsWith('.json') && name !== 'terms.json') { out.problems.push(`${name}: older layout, not read: move its claims into a <feature>.jsonl, one per line`); continue; }
    if (name !== 'terms.json' && !name.endsWith('.jsonl')) continue;
    const text = readFileSync(join(dir, name), 'utf8');
    if (/^<<<<<<< /m.test(text)) { out.problems.push(`${name}: has git conflict markers`); continue; }
    if (name === 'terms.json') {
      try { const doc = JSON.parse(text); out.terms = Array.isArray(doc) ? doc : []; } catch { out.problems.push(`${name}: not valid JSON`); }
      continue;
    }
    const home = name.slice(0, -'.jsonl'.length);
    text.split('\n').forEach((line, i) => {
      if (!line.trim()) return;
      let c;
      try { c = JSON.parse(line); } catch { out.problems.push(`${name} line ${i + 1}: not valid JSON`); return; }
      if (!c || typeof c !== 'object' || !c.id) { out.problems.push(`${name} line ${i + 1}: a claim with no id`); return; }
      if (seen.has(c.id)) { out.problems.push(seen.get(c.id) === home ? `${c.id}: twice in ${name}` : `${c.id}: in ${seen.get(c.id)}.jsonl and ${name}`); return; }
      seen.set(c.id, home);
      out.claims.push({ ...DEFAULTS, ...c, tags: Array.isArray(c.tags) ? c.tags : [], home });
    });
  }
  return out;
}

const byId = (a, b) => a.id.localeCompare(b.id);
const hits = (c, tags) => c.tags.filter((t) => tags.includes(t)).length;
const pathOf = (p) => String(p ?? '').trim().replace(/^\.\//, '');

// The files a claim's source names, by the shapes CLAIMS.md gives it: `<sha> <path>`, `found: BUG-002; <sha> <path>`,
// `the code only: <sha> <path>`, `docs/x.md: "<sentence>"`; the user's words name no file. Quoted text, bug ids and
// commit ids are dropped: what is left is paths, whatever characters a framework puts in them.
export function filesOf(source) {
  const s = String(source ?? '').trim();
  if (/^the user's words/i.test(s)) return [];
  const rest = s.replace(/"[^"]*"|“[^”]*”/g, ' ').replace(/^found:[^;]*;?/i, ' ').replace(/^the code only:/i, ' ');
  return [...new Set(rest.split(/[\s,;]+/).map((t) => pathOf(t.replace(/:$/, ''))).filter((t) => t && !/^[0-9a-f]{3,40}$/.test(t)))];
}
// A file given as an absolute path, or from another folder, still matches by its end.
const sameFile = (given, path) => given === path || given.endsWith(`/${path}`);

// Claims matched by file first, then by tag, then by id; retired ones only with `retired`. Tag matches come by how many
// of the tags they carry, then headline before routine, so a cut list keeps the claims that matter most.
export function select(claims, { tags = [], files = [], ids = [], retired = false } = {}) {
  const live = claims.filter((c) => retired || c.status !== 'retired').sort(byId);
  const wanted = files.map(pathOf).filter(Boolean);
  const groups = [
    // A claim written before files existed still has a source: match on the paths it names.
    live.filter((c) => (c.files ?? filesOf(c.source)).some((p) => wanted.some((f) => sameFile(f, pathOf(p))))),
    live.filter((c) => c.tags.some((t) => tags.includes(t)))
      .sort((a, b) => hits(b, tags) - hits(a, tags) || (a.rank === 'headline' ? 0 : 1) - (b.rank === 'headline' ? 0 : 1) || byId(a, b)),
    live.filter((c) => ids.includes(c.id)),
  ];
  return [...new Set(groups.flat())];
}

export function tagCounts(claims) {
  const counts = new Map();
  for (const c of claims) if (c.status !== 'retired') for (const t of c.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export function duplicates(claims) {
  const first = new Map();
  const pairs = [];
  for (const c of claims.filter((k) => k.status !== 'retired').sort(byId)) {
    if (first.has(c.statement)) pairs.push([first.get(c.statement), c.id]);
    else first.set(c.statement, c.id);
  }
  return pairs;
}

// C- and 4 hex characters; 5 once more than half the 4-character ids are taken. Draws again on a clash.
export function mintId(taken, random = (n) => randomBytes(n)) {
  const short = [...taken].filter((id) => /^C-[0-9a-f]{4}$/.test(id)).length;
  const digits = short > 0x8000 ? 5 : 4;
  for (;;) {
    const id = `C-${random(3).toString('hex').slice(0, digits).padStart(digits, '0')}`;
    if (!taken.has(id)) return id;
  }
}

// A claim as stored: keys in order, none holding its default, no `home` (the file name says it).
export const stored = (c) => Object.fromEntries([...KEYS.filter((k) => k in c), ...Object.keys(c).filter((k) => !KEYS.includes(k))]
  .filter((k) => k !== 'home' && !(k in DEFAULTS && c[k] === DEFAULTS[k])).map((k) => [k, c[k]]));

// Writes a feature's whole file: the claims given, one per line, sorted by id.
export function writeClaims(dir, home, claims) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${home}.jsonl`), claims.sort(byId).map((c) => `${JSON.stringify(stored(c))}\n`).join(''));
}

export const lineOf = (c) => `${c.id} ${c.status === 'retired' ? 'retired' : c.verdict ?? 'unproven'} [${c.tags.join(',')}] ${c.statement}`;

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  const [dir, ...rest] = process.argv.slice(2);
  const list = (flag) => { const i = rest.indexOf(flag); return i >= 0 ? String(rest[i + 1] ?? '').split(',').map((s) => s.trim()).filter(Boolean) : []; };
  const usage = 'Usage: node ledger.mjs <ledger dir> [--tags a,b] [--files f,g] [--ids C-7f3a,C-91bd] [--retired]';
  const unknown = rest.find((a) => a.startsWith('--') && !['--tags', '--files', '--ids', '--retired'].includes(a));
  if (!dir || dir.startsWith('--') || unknown) {
    console.error(unknown ? `Unknown flag ${unknown}. ${usage}` : usage);
    process.exit(1);
  }
  const { claims, problems } = readLedger(dir);
  const counts = tagCounts(claims);
  const tagText = counts.slice(0, MAX_TAGS).map(([t, n]) => `${t} (${n})`).join(', ');
  console.log(`Tags: ${tagText || 'none'}${counts.length > MAX_TAGS ? `, +${counts.length - MAX_TAGS} more tags` : ''}`);
  const ids = list('--ids');
  const found = select(claims, { tags: list('--tags'), files: list('--files'), ids, retired: rest.includes('--retired') || ids.length > 0 });
  if (ids.length) console.log(JSON.stringify(found.filter((c) => ids.includes(c.id)).map(stored), null, 2));
  else {
    for (const c of found.slice(0, MAX_LINES)) console.log(lineOf(c));
    if (found.length > MAX_LINES) console.log(`+${found.length - MAX_LINES} more: narrow with fewer tags or --files`);
  }
  for (const p of problems) console.log(`Problem: ${p}`);
  const twins = duplicates(claims);
  for (const [a, b] of twins.slice(0, MAX_PROBLEMS)) console.log(`Problem: ${a} and ${b} have the same statement`);
  if (twins.length > MAX_PROBLEMS) console.log(`Problem: +${twins.length - MAX_PROBLEMS} more claims with a statement another claim has`);
  for (const id of ids.filter((i) => !claims.some((c) => c.id === i))) console.log(`Problem: ${id}: no such claim`);
}
