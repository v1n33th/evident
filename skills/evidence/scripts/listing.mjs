// Usage: node listing.mjs <run folder> <log file>
// Prints, for the evidence checker, one JSON line per line of <log file> that names a file: its file, role, method, claim,
// case, bug, viewport and note, and the case's expect from the run's claims.json. Under a text file, its first 1500 characters, and how long it is when that cuts it.
// A line that is not JSON prints as "BROKEN <line>".
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PICTURE = /\.(gif|png|jpe?g|webp|webm|mp4|mov|pdf)$/i;
const LIMIT = 1500;

export function listing(run, log) {
  const out = [];
  let claims = [];
  try { claims = JSON.parse(readFileSync(join(run, 'claims.json'), 'utf8')).claims ?? []; } catch { /* an explore run: no claims */ }
  const expectOf = (claim, c) => claims.find((x) => x.id === claim)?.cases?.find((x) => x.id === c)?.expect;
  for (const text of readFileSync(join(run, log), 'utf8').split('\n')) {
    if (!text.trim()) continue;
    let row;
    try { row = JSON.parse(text); } catch { out.push(`BROKEN ${text}`); continue; }
    if (!row.file) continue;
    const { file, role, method, claim, case: c, bug, viewport, note } = row;
    out.push(JSON.stringify({ file, role, method, claim, case: c, bug, viewport, expect: expectOf(claim, c), note }));
    const path = join(run, String(file));
    if (PICTURE.test(String(file)) || !existsSync(path)) continue;
    const body = readFileSync(path, 'utf8');
    out.push(body.slice(0, LIMIT), ...(body.length > LIMIT ? [`(cut at ${LIMIT} of ${body.length} characters)`] : []), '---');
  }
  return out.join('\n');
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  const [run, log] = process.argv.slice(2);
  if (!run || !log) {
    console.error('Usage: node listing.mjs <run folder> <log file>');
    process.exit(1);
  }
  console.log(listing(run, log));
}
