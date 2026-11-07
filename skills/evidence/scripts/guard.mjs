// Usage, as a PreToolUse hook (Claude Code's evident-prover, evident-checker and evident-explorer agents, matcher
// "Read|Bash"; Codex's hooks.json sends the same JSON for its shell tool, Bash):
//   node guard.mjs --role prover|checker|explorer   < the hook's JSON on stdin: cwd, tool_name, tool_input
// As the evident plugin's hook, which runs on every Read and Bash call of the session, subagents included:
//   node guard.mjs --role agent   < the same JSON; the role comes from its agent_type (evident:evident-prover is the
//   prover, evident:evident-checker the checker, evident:evident-explorer the explorer), and any other call, the main
//   session's too, exits 0.
// Or from any other harness's hook or a wrapper, one call at a time:
//   node guard.mjs --role prover|checker --command '<shell command>' [--cwd <dir>]
//   node guard.mjs --role prover|checker --read <path> [--cwd <dir>]
// Blocks a call that breaks the role's rules with exit 2 and a one-line reason on stderr; the agent sees the reason.
// Fails open: input it cannot parse, a tool it does not know, or an error of its own exits 0. A plain call with no
// known role exits 1.
// Every role: Bash may not run python or node with inline code (-e, --eval, -p, --print, code on stdin), also inside
// bash -c and eval. The checker may not read an evidence log (evidence.jsonl, evidence-<id>.jsonl): listing.mjs does.
// The prover may not read claims.json, fix-claims.json, ledger.html, the ledger or the app's code (Read, or a reading
// command such as cat, grep, sed or cp in Bash), read the diff with git, or list (ls, find, tree, du) the run folder, its
// sessions/, or any folder of the project folder but a run folder's evidence/ and bugs/.
// The explorer may not read leads.jsonl (start.mjs prints its own leads) or a picture outside a bugs/ folder (the page's
// text is the check), name another charter's bug folder (bugs/.BUG-NNN holds its session; the explorer's charter is the
// helper it sources, charters/.<id>.sh), nor write a file (>, >>) outside a run folder
// (a folder that holds charters.json), so no token or cookie lands in /tmp; $R and the helper's other variables count,
// read from the file the command sources.
// The folders are found from the paths themselves, so no prompt or setting has to name them:
//   run folder: a folder that holds sessions/.   project folder: a folder that holds environment.md; its ledger/ is the ledger.
//   code path: a git repo (a folder that holds .git) that holds .evident/ or the hook's cwd, except its .evident/ and
//   any skill directory in it (a folder that holds SKILL.md).
// Paths come from the call: Read's file_path, and each word of a Bash command that names a file or folder that exists,
// after the command's own VAR=value and cd, ~ and $HOME. A glob is matched against its folder's files.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', '{', '}', '!', 'time', 'export', 'local', 'readonly', 'declare']);
const PREFIXES = new Set(['env', 'command', 'exec', 'nohup', 'sudo', 'nice', 'time']);
const READERS = new Set(['cat', 'head', 'tail', 'less', 'more', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'sed', 'awk', 'wc', 'cut', 'sort', 'uniq', 'strings', 'xxd', 'od', 'hexdump', 'diff', 'cmp', 'jq', 'cp', 'rsync', 'tar', 'zip', 'base64', 'bat', 'nl', 'tac', 'paste', 'column']);
const PATTERN_FIRST = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'sed', 'awk', 'jq']); // their first argument is no file
const LISTERS =new Set(['ls', 'find', 'tree', 'du', 'fd']);
const GIT_READS = new Set(['diff', 'show', 'log', 'blame', 'grep', 'cat-file', 'ls-files', 'ls-tree', 'whatchanged']);
const HIDDEN = new Set(['claims.json', 'fix-claims.json', 'ledger.html']);
const EVIDENCE_LOG = /^evidence(-.+)?\.jsonl$/;

// Splits a shell command into simple commands: { words, reads } each, reads being `< file` targets. Expands $VAR from
// the command's own earlier assignments (vars, changed in place), the VAR=value lines of a file it sources (`. file`),
// and $HOME; a value from a substitution (`B=$(ls ...)`) stays unknown. Skips comments and heredoc bodies.
export function commands(cmd, vars = {}, cwd = process.cwd()) {
  const out = [];
  let words = [], reads = [], writes = [], word = null, redirect = null, heredocs = [], i = 0;
  const unknown = new Set();
  const value = (name, raw) => (name in vars ? vars[name] : name === 'HOME' ? homedir() : raw);
  const at = (w) => resolve(cwd, w.startsWith('~/') || w === '~' ? homedir() + w.slice(1) : w);
  const sourced = (file) => {
    // An explorer sources its charter's helper, charters/.<id>.sh: that names the charter.
    const id = /\/charters\/\.([^/]+)\.sh$/.exec(file)?.[1];
    if (id) vars.__charter = id;
    try {
      for (const m of readFileSync(file, 'utf8').matchAll(/^(\w+)=(.*)$/gm)) vars[m[1]] = m[2].replace(/^'(.*)'$/s, '$1').replaceAll(`'\\''`, "'");
    } catch {}
  };
  const variable = (j) => {
    const m = /^\$(?:\{(\w+)\}|(\w+))/.exec(cmd.slice(j));
    return m && { length: m[0].length, text: value(m[1] ?? m[2], m[0]) };
  };
  const endWord = () => {
    if (word === null) return;
    if (redirect === '<') reads.push(word);
    else if (redirect === '>' || redirect === '>>' || redirect === '>|') writes.push(word);
    else if (redirect?.startsWith('<<') && redirect !== '<<<') heredocs.push({ end: word, strip: redirect === '<<-' });
    else if (!redirect) words.push(word);
    word = null; redirect = null;
  };
  const endCommand = () => {
    endWord();
    for (const w of words) {
      const m = /^(\w+)=(.*)$/s.exec(w);
      if (m && unknown.has(m[1])) delete vars[m[1]];
      else if (m) vars[m[1]] = m[2];
      else if (!KEYWORDS.has(w)) break;
    }
    const first = words.find((w) => !/^\w+=/.test(w) && !KEYWORDS.has(w));
    if (first === 'cd') cwd = at(words[words.indexOf('cd') + 1] ?? '~');
    if (first === '.' || first === 'source') sourced(at(words[words.indexOf(first) + 1] ?? ''));
    if (words.length || reads.length || writes.length) out.push({ words, reads, writes });
    words = []; reads = []; writes = [];
  };
  while (i < cmd.length) {
    const ch = cmd[i];
    if (ch === "'") {
      const k = cmd.indexOf("'", i + 1);
      word = (word ?? '') + cmd.slice(i + 1, k < 0 ? undefined : k);
      i = k < 0 ? cmd.length : k + 1;
    } else if (ch === '"') {
      let j = i + 1, s = '';
      while (j < cmd.length && cmd[j] !== '"') {
        const v = cmd[j] === '$' && variable(j);
        if (cmd[j] === '\\' && j + 1 < cmd.length) { s += cmd[j + 1]; j += 2; } else if (v) { s += v.text; j += v.length; } else s += cmd[j++];
      }
      word = (word ?? '') + s; i = j + 1;
    } else if (ch === '\\') {
      if (cmd[i + 1] !== '\n') word = (word ?? '') + (cmd[i + 1] ?? '');
      i += 2;
    } else if (ch === '$' && cmd[i + 1] === '(') {
      if (word && /^\w+=$/.test(word)) unknown.add(word.slice(0, -1));
      endCommand(); i += 2;
    } else if (ch === '$' && variable(i)) {
      const v = variable(i);
      word = (word ?? '') + v.text; i += v.length;
    } else if (ch === '#' && word === null) {
      while (i < cmd.length && cmd[i] !== '\n') i++;
    } else if (ch === ' ' || ch === '\t') {
      endWord(); i++;
    } else if (ch === '<' || ch === '>') {
      if (word !== null && /^\d+$/.test(word)) word = null; // 2> file: the 2 is not a word
      endWord();
      const m = /^(<<<|<<-|<<|<|>>|>\||>&|>)/.exec(cmd.slice(i));
      redirect = m[0]; i += m[0].length;
      if (redirect === '>&') { redirect = null; while (/[\d-]/.test(cmd[i] ?? '')) i++; }
    } else if (ch === '\n') {
      endCommand(); i++;
      for (const { end, strip } of heredocs) {
        while (i < cmd.length) {
          const k = cmd.indexOf('\n', i), line = cmd.slice(i, k < 0 ? undefined : k);
          i = k < 0 ? cmd.length : k + 1;
          if ((strip ? line.replace(/^\t+/, '') : line) === end) break;
        }
      }
      heredocs = [];
    } else if (';&|()`'.includes(ch)) {
      if (ch === '&' && cmd[i + 1] === '>') { endWord(); redirect = '>'; i += 2; continue; }
      endCommand(); i++;
    } else {
      word = (word ?? '') + ch; i++;
    }
  }
  endCommand();
  return out;
}

const within = (path, dir) => path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);
const ancestors = (path) => { const list = [path]; while (dirname(list.at(-1)) !== list.at(-1)) list.push(dirname(list.at(-1))); return list; };
const isDir = (path) => { try { return statSync(path).isDirectory(); } catch { return false; } };
const real = (path) => { try { return realpathSync(path); } catch { return path; } };

const globRe = (glob) => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
// The existing paths a word names: itself, or for a glob in its last part the files it matches.
// ponytail: a glob in a middle part (a/*/b) names nothing, so it is not checked.
function paths(word, cwd) {
  if (!word || word.startsWith('-')) return [];
  const full = resolve(cwd, word.startsWith('~/') || word === '~' ? homedir() + word.slice(1) : word);
  if (!/[*?]/.test(full)) return existsSync(full) ? [real(full)] : [];
  const dir = dirname(full);
  if (/[*?]/.test(dir) || !isDir(dir)) return [];
  const re = globRe(basename(full));
  return readdirSync(dir).filter((name) => re.test(name)).map((name) => real(join(dir, name)));
}

const gitRoot = (path) => ancestors(path).find((a) => existsSync(join(a, '.git')));

// Why the prover may not read this path, or null.
// A fix's record: its patch, the fix run's rounds and result, or a bug.json that holds a fix (root cause, files).
const fixRecord = (path) => /\.patch$/.test(path) || ['rounds.json', 'result.json'].includes(basename(path)) || ancestors(dirname(path)).some((a) => basename(a) === 'fixes')
  || (basename(path) === 'bug.json' && (() => { try { return Boolean(JSON.parse(readFileSync(path, 'utf8')).fix); } catch { return false; } })());

function proverRead(path, cwd) {
  if (HIDDEN.has(basename(path))) return `never read ${basename(path)}: your claims are in sessions/<session id>.claims.json`;
  if (fixRecord(path)) return 'never read a fix or a run\'s result: you prove the app blind';
  if (ancestors(path).some((a) => basename(a) === 'ledger' && existsSync(join(dirname(a), 'environment.md')))) return 'never read the ledger';
  const root = gitRoot(path);
  if (!root || !(existsSync(join(root, '.evident')) || root === gitRoot(real(cwd)))) return null;
  if (within(path, join(root, '.evident'))) return null;
  if (ancestors(path).some((a) => within(a, root) && existsSync(join(a, 'SKILL.md')))) return null;
  return `never read the app's code or the Code path (${root}): run setup commands only through setup.mjs`;
}

// Why the prover may not list this folder, or null.
function proverList(path) {
  if (!isDir(path)) return null;
  const run = ancestors(path).find((a) => isDir(join(a, 'sessions')));
  if (run && ['evidence', 'bugs'].some((sub) => within(path, join(run, sub)))) return null;
  if (run || basename(path) === 'sessions' || ancestors(path).some((a) => existsSync(join(a, 'environment.md')))) {
    return 'never list the run, request or project folder or sessions/: Read your own sessions/<session id>.jsonl, and list only <run folder>/evidence/ or bugs/';
  }
  return null;
}

const IMAGE = /\.(png|jpe?g|gif|webp|webm|mp4|mov)$/i;
// Why the explorer may not read this path, or null. A screenshot read back costs a turn and stays in the context: the
// page's text (snap, get text) is the check; a bug's own picture under bugs/ is the one it opens, as EXPLORER.md says.
const explorerRead = (path) => (basename(path) === 'leads.jsonl' ? 'never read leads.jsonl: start.mjs printed your leads'
  : IMAGE.test(path) && !ancestors(dirname(path)).some((a) => basename(a) === 'bugs') ? 'never read a screenshot back: check the page by its text (snap, get text); open only a bug\'s own picture under bugs/' : null);
// Why the explorer may not write this redirect target, or null.
function explorerWrite(word, cwd) {
  if (/\$\{?\w/.test(word)) return null; // a variable the guard cannot know: it fails open, as on anything it cannot parse
  const path = resolve(cwd, word.startsWith('~/') ? homedir() + word.slice(1) : word);
  if (within(path, '/dev')) return null;
  // The tool notes the target definitions (targets/web.md, targets/api.md) say to append to: a line about the tool, no token.
  if (path === join(homedir(), '.evident', 'tool-notes.md')) return null;
  if (ancestors(dirname(path)).some((a) => existsSync(join(a, 'charters.json')))) return null;
  return `write files only under your run folder, never ${path}: keep tokens and cookies out of files`;
}

const checkerRead = (path) => (EVIDENCE_LOG.test(basename(path)) ? 'never read the evidence log itself: run listing.mjs once' : null);

// Why the explorer of charter `id` may not name this word, or null: a bug folder another charter made (bugs/.BUG-NNN
// holds its session) is not its to write, read or log into; explorers running at once have overwritten one another's.
function otherBugFolder(word, cwd, id) {
  if (/\$\{?\w/.test(word)) return null;
  const path = resolve(cwd, word.startsWith('~/') ? homedir() + word.slice(1) : word);
  // BUG-007-slug, and BUG-007* or BUG-007? (a number guessed and globbed): one explorer wrote into another's that way.
  const m = /^(.*\/bugs)\/(BUG-\d+)(?:[-*?][^/]*)?(\/|$)/.exec(path);
  if (!m) return null;
  let owner = '';
  try { owner = readFileSync(join(m[1], `.${m[2]}`), 'utf8').trim(); } catch { return null; }
  return owner && owner !== id ? `${m[2]} is ${owner}'s bug folder: write, read and log only in the folders new-bug.mjs made for ${id}` : null;
}

// Why this Bash command is blocked for the role, or null.
export function checkBash(command, role, cwd, vars = {}) {
  const parsed = commands(command, vars, cwd);
  if (role === 'explorer' && vars.__charter) {
    for (const { words, reads, writes } of parsed) for (const word of [...words, ...reads, ...writes]) { const why = otherBugFolder(word, cwd, vars.__charter); if (why) return why; }
  }
  for (const { words: all, reads, writes } of parsed) {
    if (role === 'explorer') for (const word of writes) { const why = explorerWrite(word, cwd); if (why) return why; }
    let w = all.slice();
    while (w.length && (KEYWORDS.has(w[0]) || /^\w+=/.test(w[0]))) w.shift();
    if (w[0] === 'for' || w[0] === 'case') continue;
    while (w.length > 1 && PREFIXES.has(w[0])) { w.shift(); while (w.length > 1 && (w[0].startsWith('-') || /^\w+=/.test(w[0]))) w.shift(); }
    if (w[0] === 'timeout' && w.length > 2) w = w.slice(2);
    if (w[0] === 'xargs') { w.shift(); while (w.length && w[0].startsWith('-')) { if (/^-[IinPLdsE]$/.test(w[0])) w.shift(); w.shift(); } }
    const name = basename(w[0] ?? '');
    if (name === 'cd') { const to = paths(w[1] ?? '~', cwd)[0]; if (to) cwd = to; continue; }
    if (/^python[\d.]*$/.test(name)) return 'python is not an allowed command: read JSON with node <evidence directory>/scripts/pick.mjs';
    if (name === 'node') {
      const args = w.slice(1);
      const script = args.findIndex((a) => !a.startsWith('-'));
      const options = script < 0 ? args : args.slice(0, script);
      if (options.some((a) => /^-(e|p|pe|ep)$|^--(eval|print)(=|$)/.test(a))) return 'node -e is not an allowed command: read JSON with node <evidence directory>/scripts/pick.mjs';
      if (script < 0 && !options.some((a) => /^(-v|--version|-h|--help)$/.test(a))) return 'node runs only script files: read JSON with node <evidence directory>/scripts/pick.mjs';
    }
    if (['bash', 'sh', 'zsh'].includes(name) && w.includes('-c')) {
      const why = checkBash(w[w.indexOf('-c') + 1] ?? '', role, cwd, vars);
      if (why) return why;
    }
    if (name === 'eval') { const why = checkBash(w.slice(1).join(' '), role, cwd, vars); if (why) return why; }
    const reader = READERS.has(name), lister = LISTERS.has(name);
    if (role === 'prover' && name === 'git' && w.slice(1).some((a) => GIT_READS.has(a))) return 'never read the code or the diff';
    if (!reader && !lister && !reads.length) continue;
    let args = reader || lister ? w.slice(1) : [];
    if (PATTERN_FIRST.has(name)) args = args.filter((a, k) => k !== args.findIndex((b) => !b.startsWith('-')));
    const targets = [...args, ...reads].flatMap((word) => paths(word, cwd));
    if (lister && !w.slice(1).some((a) => !a.startsWith('-'))) targets.push(real(cwd));
    for (const path of targets) {
      const why = role === 'prover' ? proverRead(path, cwd) ?? (lister ? proverList(path) : null) : role === 'explorer' ? explorerRead(path) : checkerRead(path);
      if (why) return why;
    }
  }
  return null;
}

// The role of an agent type: the name after the last `:`, so the plugin's evident:evident-prover and a copy installed
// as evident-prover are both the prover; so is evident-prover-shell, the Read-and-Bash prover.
export const roleOf = (type) => ({ 'evident-prover': 'prover', 'evident-prover-shell': 'prover', 'evident-checker': 'checker', 'evident-explorer': 'explorer' })[String(type ?? '').split(':').pop()];

// Why the hook call is blocked, or null.
export function check(input, role) {
  const cwd = input.cwd || process.cwd();
  const tool = input.tool_input ?? {};
  if (input.tool_name === 'Bash' && typeof tool.command === 'string') return checkBash(tool.command, role, cwd);
  if (input.tool_name === 'Read' && typeof tool.file_path === 'string') {
    const path = real(resolve(cwd, tool.file_path));
    return role === 'prover' ? proverRead(path, cwd) : role === 'explorer' ? explorerRead(path) : checkerRead(path);
  }
  return null;
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  const arg = (name) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1] ?? ''; };
  let role = arg('--role');
  const command = arg('--command'), file = arg('--read');
  const known = ['prover', 'checker', 'explorer', 'agent'].includes(role);
  const plain = command !== undefined || file !== undefined;
  if (plain && !known) {
    console.error("Usage: node guard.mjs --role prover|checker|explorer (--command '<shell command>' | --read <path>) [--cwd <dir>]");
    process.exit(1);
  }
  let why = null;
  try {
    const input = !plain ? JSON.parse(readFileSync(0, 'utf8'))
      : command !== undefined ? { cwd: arg('--cwd'), tool_name: 'Bash', tool_input: { command } }
      : { cwd: arg('--cwd'), tool_name: 'Read', tool_input: { file_path: file } };
    if (role === 'agent') role = roleOf(input.agent_type);
    if (['prover', 'checker', 'explorer'].includes(role)) why = check(input, role);
  } catch { why = null; }
  if (why) {
    console.error(`evident guard (${role}): ${why}. Do not work around this; follow your instructions file.`);
    process.exit(2);
  }
}
