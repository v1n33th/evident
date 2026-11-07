// Usage: node setup.mjs <run folder> <claim>-<case> | <charter>-groundwork | - <folder> '<command>'
// Runs one setup command from <folder> under `set -C`, so its redirects overwrite no file, with stderr in stdout.
// Saves the command, its exit code and full output as <run folder>/evidence/<claim>-<case>-setup.txt, or the next free
// -setup-2.txt, -setup-3.txt, ... "-" (the sign-in command) saves nothing. The saved file has cookie and authorization
// values and bearer tokens as <redacted>, so its hash and the proof never hold a session. Prints the file, the exit code
// and the output as it came, and exits with the command's code.
import { spawnSync } from 'node:child_process';
import { realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactSessions } from '../../show-your-work/scripts/build-proof.mjs';

export function runSetup(run, name, folder, command) {
  const r = spawnSync('/bin/sh', ['-c', `set -C; exec 2>&1; ${command}`], { cwd: folder, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const code = r.status ?? 1;
  const output = (r.stdout ?? '') + (r.error ? `${r.error.message}\n` : '');
  if (name === '-') return { code, output, file: null };
  // Never overwrite an earlier setup file: a rerun is a new record.
  for (let n = 1; ; n++) {
    const file = `evidence/${name}-setup${n > 1 ? `-${n}` : ''}.txt`;
    try {
      writeFileSync(join(run, file), redactSessions(`Command: ${command}\nFolder: ${folder}\nExit code: ${code}\n\n${output}`), { flag: 'wx' });
      return { code, output, file };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  const [run, name, folder, command] = process.argv.slice(2);
  if (!command || !(name === '-' || /^([A-Z]+\d+|C-[0-9a-f]{4,})-[\w]+$/.test(name))) {
    console.error("Usage: node setup.mjs <run folder> <claim>-<case> | <charter>-groundwork | - <folder> '<command>'");
    process.exit(1);
  }
  const { code, output, file } = runSetup(run, name, folder, command);
  if (file) console.log(`File: ${file}`);
  console.log(`Exit code: ${code}\n${output}`);
  process.exit(code);
}
