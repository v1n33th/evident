// Usage: node decisions.mjs <run folder> <code path> [--add]
// Checks the planner's owner decisions in learnings.jsonl: each has a "quote" found word for word within two lines of its
// "source" (path:line under the code path). Refuses (exit 1) on any that does not. Then lists each bullet and numbered
// item and table row under a heading of a cited document named for owner decisions, rules, non-goals, settled details or
// what is left to the builder that no decision quotes or cites; --add appends each as an owner decision in its own words,
// a table row as "<column>: <cell>" pairs.
import { appendFileSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HEADING = /owner|decision|rule|non-goal|settled|my call|out of scope|left to/i;
const ITEM = /^\s*(?:[-*]|\d+\.)\s+/;
const norm = (s) => String(s).toLowerCase().replace(/[*`_]/g, '').replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();

export function checkDecisions(run, code) {
  const file = join(run, 'learnings.jsonl');
  const decisions = (existsSync(file) ? readFileSync(file, 'utf8') : '').split('\n')
    .flatMap((l) => { try { return l.trim() ? [JSON.parse(l)] : []; } catch { return []; } })
    .filter((l) => /^Owner decision:/.test(l.learning ?? ''));
  const docs = new Map();
  const doc = (path) => {
    if (!docs.has(path)) docs.set(path, existsSync(join(code, path)) ? readFileSync(join(code, path), 'utf8').split('\n') : null);
    return docs.get(path);
  };
  const problems = [];
  const cited = [];
  for (const d of decisions) {
    const [, path, n] = String(d.source ?? '').match(/^(.+?):(\d+)$/) ?? [];
    const lines = path && doc(path);
    if (!lines) { problems.push(`${d.source ?? '(no source)'}: no such document line under ${code}: "${d.learning}"`); continue; }
    cited.push({ path, n: Number(n), quote: norm(d.quote ?? '') });
    if (!d.quote) { problems.push(`${d.source}: no "quote": copy the sentence it rests on, word for word`); continue; }
    if (!norm(lines.slice(Math.max(0, n - 3), Number(n) + 2).join(' ')).includes(norm(d.quote))) problems.push(`${d.source}: the quote is not at that line: "${d.quote}"`);
  }
  const missing = [];
  const cells = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const SEPARATOR = /^\s*\|?[\s:|-]+\|[\s:|-]*$/;
  for (const path of new Set(cited.map((c) => c.path))) {
    let under = false;
    let left = '';
    let header = null;
    const lines = doc(path);
    lines.forEach((text, i) => {
      if (/^#+\s/.test(text)) { under = HEADING.test(text); left = /left to/i.test(text) ? `${text.replace(/^#+\s*/, '').trim()}: ` : ''; return; }
      if (!/^\s*\|/.test(text)) header = null;
      if (!under) return;
      let learning;
      if (/^\s*\|/.test(text)) {
        if (SEPARATOR.test(text)) return;
        if (SEPARATOR.test(lines[i + 1] ?? '')) { header = cells(text); return; }
        // A row reads as its cells under their column names; an empty cell ("–") is left out.
        learning = cells(text).map((c, k) => (c && !/^[–-]$/.test(c) ? (k === 0 || !header?.[k] ? c : `${header[k]}: ${c}`) : null)).filter(Boolean).join('. ');
      } else if (ITEM.test(text)) learning = text.replace(ITEM, '').trim();
      if (!learning) return;
      const covered = cited.some((c) => c.path === path && (c.n === i + 1 || (c.quote && norm(text).includes(c.quote))));
      // What a document leaves to the builder is the owner's choice too: any answer to it is by design.
      if (!covered) missing.push({ source: `${path}:${i + 1}`, quote: text.replace(ITEM, '').trim(), learning: left + learning });
    });
  }
  return { count: decisions.length, problems, missing };
}

export function addMissing(run, missing) {
  if (!missing.length) return;
  const file = join(run, 'learnings.jsonl');
  // A file the planner wrote without a last newline would glue the first added line onto its last one.
  const gap = existsSync(file) && !/(^|\n)$/.test(readFileSync(file, 'utf8')) ? '\n' : '';
  appendFileSync(file, gap + missing.map(({ source, quote, learning = quote }) => `${JSON.stringify({ by: 'planner', learning: `Owner decision: ${learning.replace(/[*`]/g, '')}`, quote, source })}\n`).join(''));
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  const [run, code, flag] = process.argv.slice(2);
  if (!run || !code || (flag && flag !== '--add')) {
    console.error('Usage: node decisions.mjs <run folder> <code path> [--add]');
    process.exit(1);
  }
  const { count, problems, missing } = checkDecisions(resolve(run), resolve(code));
  for (const p of problems) console.log(`Problem: ${p}`);
  if (flag) addMissing(resolve(run), missing);
  else for (const m of missing) console.log(`Not quoted: ${m.source}: ${m.quote.slice(0, 160)}`);
  console.log(`${count} owner decisions, ${problems.length} problems, ${missing.length} rule lines no decision quotes${flag && missing.length ? ': added' : ''}.`);
  process.exit(problems.length ? 1 : 0);
}
