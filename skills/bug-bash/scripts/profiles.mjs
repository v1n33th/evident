// Usage: node profiles.mjs <project folder>/tester-profiles.json <skill directory>/tester-profiles.json [--merge]
// The project's copy of the profiles is made once and never updated. Prints what the skill's file has that the copy lacks:
// a `does` line or `focus` type of a profile in both, or a whole profile. Prints `Profiles: up to date` when nothing is.
// --merge adds them to the copy: lines and types at the end of their lists, a missing profile with "optIn": true.
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function profileDrift(copy, skill) {
  const lines = [];
  const merged = structuredClone(copy);
  for (const p of skill.profiles ?? []) {
    const mine = merged.profiles.find((m) => m.id === p.id);
    if (!mine) {
      lines.push(`New profile: ${p.id} (${p.name})`);
      merged.profiles.push({ ...p, optIn: true });
      continue;
    }
    const does = (p.does ?? []).filter((d) => !(mine.does ?? []).includes(d));
    const focus = (p.focus ?? []).filter((f) => !(mine.focus ?? []).includes(f));
    lines.push(...focus.map((f) => `${p.id}: new focus: ${f}`), ...does.map((d) => `${p.id}: new habit: ${d}`));
    if (does.length) mine.does = [...(mine.does ?? []), ...does];
    if (focus.length) mine.focus = [...(mine.focus ?? []), ...focus];
  }
  return { lines, merged };
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  const [copyFile, skillFile, flag] = process.argv.slice(2);
  if (!copyFile || !skillFile || (flag && flag !== '--merge')) {
    console.error('Usage: node profiles.mjs <project tester-profiles.json> <skill tester-profiles.json> [--merge]');
    process.exit(1);
  }
  const { lines, merged } = profileDrift(JSON.parse(readFileSync(copyFile, 'utf8')), JSON.parse(readFileSync(skillFile, 'utf8')));
  if (!lines.length) console.log('Profiles: up to date');
  else if (flag) {
    writeFileSync(copyFile, `${JSON.stringify(merged, null, 2)}\n`);
    console.log(`Merged into ${copyFile}:\n${lines.join('\n')}`);
  } else console.log(`Profiles: your copy lacks what the skill added since:\n${lines.join('\n')}`);
}
