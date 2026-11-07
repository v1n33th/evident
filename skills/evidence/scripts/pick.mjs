// Usage: node pick.mjs <JSON file, or - for stdin> [--in <key>] [<key>=<value> | <key>~<text> ...] [--fields <key>,<key>] [--count]
// Reads a captured JSON file (a mail API's response, an API body) so testers never need `node -e` or `python`.
// The items are the file's array, the array at --in <key>, or the file's one object. Each filter keeps the items whose
// <key> equals <value> (=) or contains <text> (~). A key may be nested with dots (To.Address), through arrays too.
// Prints each kept item as one JSON line; with --fields, its values, tab-separated (a string as it is); with --count,
// only how many were kept.
//   node pick.mjs evidence/C5-c-mail.json --in messages To.Address=qa+1793287335@acme.test --fields ID,Subject
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Every value at a dotted key, stepping into arrays on the way.
export function values(item, key) {
  let found = [item];
  for (const part of key.split('.')) {
    found = found.flatMap((v) => (Array.isArray(v) ? v : [v])).filter((v) => v && typeof v === 'object' && part in v).map((v) => v[part]);
  }
  return found.flatMap((v) => (Array.isArray(v) ? v : [v]));
}

const text = (v) => (typeof v === 'string' ? v : JSON.stringify(v));

export function pick(data, args) {
  let items = data, fields, count = false;
  const filters = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--in') items = values(data, args[++i] ?? '');
    else if (arg === '--fields') fields = (args[++i] ?? '').split(',').filter(Boolean);
    else if (arg === '--count') count = true;
    else {
      const at = arg.search(/[=~]/);
      if (at < 1) throw new Error(`"${arg}" is not <key>=<value> or <key>~<text>`);
      filters.push({ key: arg.slice(0, at), op: arg[at], want: arg.slice(at + 1) });
    }
  }
  if (!Array.isArray(items)) items = items === undefined ? [] : [items];
  const kept = items.filter((item) => filters.every(({ key, op, want }) =>
    values(item, key).some((v) => (op === '=' ? text(v) === want : text(v).includes(want)))));
  if (count) return String(kept.length);
  return kept.map((item) => (fields ? fields.map((f) => values(item, f).map(text).join(',')).join('\t') : JSON.stringify(item))).join('\n');
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  const [file, ...args] = process.argv.slice(2);
  if (!file) {
    console.error('Usage: node pick.mjs <JSON file, or -> [--in <key>] [<key>=<value> | <key>~<text> ...] [--fields <key>,<key>] [--count]');
    process.exit(1);
  }
  try {
    const data = JSON.parse(readFileSync(file === '-' ? 0 : file, 'utf8'));
    // A JSON string alone (a tool's eval result) prints as its text.
    const out = typeof data === 'string' && !args.length ? data : pick(data, args);
    if (out) console.log(out);
  } catch (error) {
    console.error(`Problem: ${error.message}`);
    process.exit(1);
  }
}
