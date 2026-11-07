// Usage: node fix-list.mjs <bug folder> ...   Prints one line per bug: id, kind, severity, title, url, actual, hypothesis,
//                                               and its fix status, risk, inProduction, patch and source once a fixer wrote them.
//                                               A bug whose own picture the evidence check contradicts ends "not confirmed".
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contradicted } from '../../show-your-work/scripts/build-proof.mjs';

export function fixList(dirs) {
  const checks = new Map();
  return dirs.map((dir) => {
    const b = JSON.parse(readFileSync(join(dir, 'bug.json'), 'utf8'));
    const run = dirname(dirname(resolve(dir)));
    if (!checks.has(run)) checks.set(run, contradicted(run));
    const why = checks.get(run).get(b.id);
    const f = b.fix;
    const fix = f ? ` | fix: ${f.status} ${f.risk ?? '-'} inProduction=${f.inProduction ?? '-'} ${f.patch ?? '-'}${f.source ? ` | source: ${f.source}` : ''}` : '';
    return `${b.id} ${b.kind} ${b.severity} | ${b.title} | ${b.url ?? '-'} | actual: ${b.actual} | hypothesis: ${b.hypothesis ?? '-'}${fix}${why ? ` | not confirmed: ${why}` : ''}`;
  }).join('\n');
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    if (process.argv.length < 3) throw new Error('Usage: node fix-list.mjs <bug folder> ...');
    console.log(fixList(process.argv.slice(2)));
    // The pages of the requests these bugs live in show their fix records.
    const { writeReportFor } = await import('../../show-your-work/scripts/report.mjs');
    await writeReportFor(...process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
