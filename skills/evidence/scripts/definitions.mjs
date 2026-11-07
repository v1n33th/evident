// Usage: import { findDefinition, listDefinitions, parseDefinition, snapshot, writeSnapshot } from './definitions.mjs';
//        node definitions.mjs <project folder> --list targets|drivers     One line each: name, label, source, overrides.
//        node definitions.mjs <project folder> --show target|driver <name>   The file's path and body.
//        node definitions.mjs <project folder> --check                    Parses every definition on the lookup path; exit 1 on a problem.
//        node definitions.mjs <project folder> --snapshot <step folder>   Writes <step folder>/targets.json from environment.md.
// Reads target and driver definitions: Markdown files that open with a `key: value` settings block between two `---` lines,
// then `## ` sections of prose for the testers. A target says what is tested (web, api, ...); a driver, the tool that drives it.
// Lookup order, first wins: <project folder>/{targets,drivers}/<name>.md, ~/.evident/{targets,drivers}/<name>.md, then the
// ones that ship in the evidence directory. A missing folder holds no definitions; it is not an error.
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TARGET_KEYS = ['name', 'label', 'address', 'drivers', 'methods', 'default-methods', 'proven-by', 'viewports', 'session-cases', 'found', 'evidence-summary'];
export const DRIVER_KEYS = ['name', 'targets', 'methods', 'shell', 'check', 'parallel', 'command'];
// list, close and orphans: how a run closes its sessions and stops browsers left behind (sessions.mjs).
const DRIVER_OPTIONAL = ['install-macos', 'install-linux', 'install-windows', 'list', 'close', 'orphans'];

const BUILT_IN = fileURLToPath(new URL('../', import.meta.url));

const list = (v) => v.split(',').map((s) => s.trim()).filter(Boolean);
const yesNo = (v, file, key) => {
  if (v === 'yes') return true;
  if (v === 'no') return false;
  throw new Error(`${file}: ${key} must be yes or no`);
};

// The settings block, as [key, value] pairs. A `#` line is a comment (the templates explain each key that way).
function readSettings(text, file) {
  const lines = text.split(/\r?\n/);
  const end = lines[0] === '---' ? lines.indexOf('---', 1) : -1;
  if (end < 0) throw new Error(`${file}: no settings block between two --- lines at the top`);
  const pairs = [];
  for (const line of lines.slice(1, end)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const at = line.indexOf(':');
    if (at < 0) throw new Error(`${file}: not a key: value line: ${line}`);
    pairs.push([line.slice(0, at).trim(), line.slice(at + 1).trim()]);
  }
  return { pairs, rest: lines.slice(end + 1).join('\n') };
}

export function parseDefinition(text, file, kind) {
  const allowed = kind === 'target' ? TARGET_KEYS : [...DRIVER_KEYS, ...DRIVER_OPTIONAL];
  const required = kind === 'target' ? TARGET_KEYS : DRIVER_KEYS;
  const { pairs, rest } = readSettings(text, file);
  const raw = {};
  for (const [k, v] of pairs) {
    if (!allowed.includes(k)) throw new Error(`${file}: unknown key "${k}"`);
    raw[k] = v;
  }
  const missing = required.filter((k) => !(k in raw));
  if (missing.length) throw new Error(`${file}: missing ${missing.join(', ')}`);
  if (raw.name !== basename(file, '.md')) throw new Error(`${file}: name ${raw.name} does not match the file name`);

  let settings;
  if (kind === 'target') {
    if (!['picture', 'file'].includes(raw['proven-by'])) throw new Error(`${file}: proven-by must be picture or file`);
    if (!/^[1-9]\d*$/.test(raw['session-cases'])) throw new Error(`${file}: session-cases must be a whole number of 1 or more`);
    const cases = Number(raw['session-cases']);
    settings = {
      name: raw.name, label: raw.label, address: raw.address, drivers: list(raw.drivers), methods: list(raw.methods),
      defaultMethods: list(raw['default-methods']), provenBy: raw['proven-by'], viewports: yesNo(raw.viewports, file, 'viewports'),
      sessionCases: cases, found: raw.found === 'none' ? [] : list(raw.found), evidenceSummary: raw['evidence-summary'],
    };
  } else {
    const p = raw.parallel.match(/^yes with (\S+)$/);
    const install = {};
    for (const os of ['macos', 'linux', 'windows']) if (raw[`install-${os}`]) install[os] = raw[`install-${os}`];
    settings = {
      name: raw.name, targets: list(raw.targets), methods: list(raw.methods), shell: yesNo(raw.shell, file, 'shell'), check: raw.check,
      parallel: p ? p[1] : yesNo(raw.parallel, file, 'parallel'), command: raw.command, install,
      list: raw.list, close: raw.close, orphans: raw.orphans,
    };
  }

  // Sections: everything after the settings block, split on `## ` headings. Text before the first heading is the body's start.
  const sections = {};
  const [, ...parts] = rest.split(/^## /m);
  for (const part of parts) {
    const nl = part.indexOf('\n');
    sections[(nl < 0 ? part : part.slice(0, nl)).trim()] = (nl < 0 ? '' : part.slice(nl + 1)).trim();
  }
  return { kind, name: raw.name, file, settings, sections, body: rest.trim() };
}

// A driver command with <session> and <app-name> filled for one session. agent-browser takes only letters, digits,
// hyphens and underscores in a session name (a dot, as in acme.app, fails), so the whole --session value is made safe.
const safe = (s) => String(s).replace(/[^A-Za-z0-9_-]+/g, '-');
export const appName = (project) => safe(basename(project) === '.evident' ? basename(dirname(project)) : basename(project));
export const fillCommand = (command, project, session) => command?.replaceAll('<session>', safe(session)).replaceAll('<app-name>', appName(project))
  .replace(/(--session[ =])(\S+)/, (_, f, v) => f + safe(v));

export function definitionDirs({ project, home = homedir() }) {
  return [
    { source: 'project', dir: project },
    { source: 'user', dir: join(home, '.evident') },
    { source: 'built-in', dir: BUILT_IN },
  ];
}

const folder = (dir, kind) => join(dir, `${kind}s`);

export function findDefinition(kind, name, { project, home = homedir() }) {
  for (const { source, dir } of definitionDirs({ project, home })) {
    const file = join(folder(dir, kind), `${name}.md`);
    if (existsSync(file)) return { ...parseDefinition(readFileSync(file, 'utf8'), file, kind), source };
  }
  return null;
}

// One entry per name: the winning one, and which lower source it hides, if any.
export function listDefinitions(kind, { project, home = homedir() }) {
  const found = new Map();
  for (const { source, dir } of definitionDirs({ project, home })) {
    const at = folder(dir, kind);
    if (!existsSync(at)) continue;
    for (const f of readdirSync(at).filter((n) => n.endsWith('.md')).sort()) {
      const name = basename(f, '.md');
      const hidden = found.get(name);
      if (hidden) { hidden.overrides ??= source; continue; }
      found.set(name, { ...parseDefinition(readFileSync(join(at, f), 'utf8'), join(at, f), kind), source });
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ---- environment.md resolved against the definitions ----

// The `- ` lines under a `## <heading>` of environment.md.
const linesOf = (env, heading) => {
  const m = env.match(new RegExp(`^## ${heading}[ \\t]*\\r?\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm'));
  return m ? m[1].split(/\r?\n/) : [];
};
const bullets = (env, heading) => linesOf(env, heading).filter((l) => l.startsWith('- ')).map((l) => l.slice(2).trim());
const unTick = (s) => s.replace(/`/g, '').trim();
const labelOf = (line) => line.slice(0, Math.max(line.indexOf(':'), 0)).trim();
const valueOf = (line) => line.slice(line.indexOf(':') + 1).trim();
const evidenceLine = (label, env) => bullets(env, 'Evidence').find((l) => labelOf(l).toLowerCase() === label.toLowerCase());

export function targetsIn(env, opts) {
  const defs = listDefinitions('target', opts);
  const targets = [];
  const unknown = [];
  for (const line of bullets(env, 'Targets')) {
    const label = labelOf(line);
    const address = valueOf(line);
    const def = defs.find((d) => d.settings.address.toLowerCase() === label.toLowerCase());
    if (!def) unknown.push(label);
    else if (address && address.toLowerCase() !== 'none') targets.push({ name: def.name, label: def.settings.label, address });
  }
  return { targets, unknown };
}

export function methodsFor(label, env) {
  const line = evidenceLine(label, env);
  return line ? valueOf(line).split('·')[0].split(',').map((s) => s.trim()).filter(Boolean) : [];
}

export function driverFor(target, env, opts) {
  const def = findDefinition('target', target.name, opts);
  const label = def?.settings.label ?? target.label;
  const marks = Object.fromEntries((evidenceLine(label, env)?.split('·').slice(1) ?? []).map((p) => { const [k, ...v] = p.trim().split(':'); return [k.trim(), v.join(':').trim()]; }));
  let name = marks.driver || '';
  let command = null;
  if (name) {
    const line = bullets(env, 'Drivers').find((l) => labelOf(l) === name);
    if (line) command = unTick(valueOf(line));
  } else if (target.name === 'web' && linesOf(env, 'Browser').some((l) => l.trim())) {
    command = unTick(linesOf(env, 'Browser').find((l) => l.trim()));
    name = command.split(/\s+/)[0];
  } else if (target.name === 'api' && marks.tool) name = marks.tool;
  else name = def?.settings.drivers[0] ?? '';
  const driver = name ? findDefinition('driver', name, opts) : null;
  return {
    name, command: command ?? driver?.settings.command ?? name,
    shell: driver ? driver.settings.shell : true, parallel: driver ? driver.settings.parallel : false, definition: driver,
  };
}

export function snapshot(project, { home = homedir(), uses = null } = {}) {
  const opts = { project, home };
  const file = join(project, 'environment.md');
  const env = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const { targets: found, unknown } = targetsIn(env, opts);
  const app = bullets(env, 'Target').map((l) => [labelOf(l), valueOf(l)]).find(([k]) => k === 'App')?.[1];
  const wanted = new Map(found.map((t) => [t.name, t]));
  for (const name of uses ?? []) {
    const def = findDefinition('target', name, opts);
    if (wanted.has(name)) continue;
    if (!def || !app) throw new Error(`no definition for target ${name}: ask for evidence setup to define it`);
    wanted.set(name, { name, label: def.settings.label, address: app });
  }
  const out = {};
  for (const t of wanted.values()) {
    const def = findDefinition('target', t.name, opts);
    const driver = driverFor(t, env, opts);
    const methods = methodsFor(t.label, env);
    out[t.name] = {
      label: t.label, address: t.address, provenBy: def.settings.provenBy, viewports: def.settings.viewports,
      sessionCases: def.settings.sessionCases, found: def.settings.found, evidenceSummary: def.settings.evidenceSummary,
      methods, motion: methods.some((m) => /\b(gif|video)\b/i.test(m)),
      driver: { name: driver.name, command: driver.command, shell: driver.shell, parallel: driver.parallel },
      files: { target: def.file, driver: driver.definition?.file ?? null },
    };
  }
  return { targets: out, unknown };
}

export function writeSnapshot(step, project, opts = {}) {
  const file = join(step, 'targets.json');
  writeFileSync(file, `${JSON.stringify(snapshot(project, opts), null, 2)}\n`);
  return file;
}

// Every definition on the lookup path, hidden ones too: the problems, as lines.
function check(opts) {
  const problems = [];
  for (const kind of ['target', 'driver']) {
    for (const { dir } of definitionDirs(opts)) {
      const at = folder(dir, kind);
      if (!existsSync(at)) continue;
      for (const f of readdirSync(at).filter((n) => n.endsWith('.md')).sort()) {
        try { parseDefinition(readFileSync(join(at, f), 'utf8'), join(at, f), kind); } catch (e) { problems.push(e.message); }
      }
    }
  }
  return problems;
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  const [project, flag, a, b] = process.argv.slice(2);
  const usage = 'Usage: node definitions.mjs <project folder> --list targets|drivers | --show target|driver <name> | --check | --snapshot <step folder>';
  try {
    if (!project || !flag) throw new Error(usage);
    const opts = { project: resolve(project) };
    if (flag === '--list' && ['targets', 'drivers'].includes(a)) {
      for (const d of listDefinitions(a.slice(0, -1), opts)) console.log(`${d.name}  ${d.kind === 'target' ? d.settings.label : d.settings.command}  ${d.source}${d.overrides ? `  overrides ${d.overrides}` : ''}`);
      const env = join(opts.project, 'environment.md');
      if (a === 'targets' && existsSync(env)) for (const label of targetsIn(readFileSync(env, 'utf8'), opts).unknown) console.log(`Warning: no definition for the ## Targets line "${label}"`);
    } else if (flag === '--show' && ['target', 'driver'].includes(a) && b) {
      const d = findDefinition(a, b, opts);
      if (!d) throw new Error(`no ${a} named ${b}`);
      console.log(`${d.file}\n\n${d.body}`);
    } else if (flag === '--check') {
      const problems = check(opts);
      for (const p of problems) console.log(`Problem: ${p}`);
      if (problems.length) process.exit(1);
    } else if (flag === '--snapshot' && a) {
      console.log(writeSnapshot(resolve(a), opts.project));
    } else throw new Error(usage);
  } catch (e) {
    console.error(`Problem: ${e.message}`);
    process.exit(1);
  }
}
