---
name: agent-browser
targets: web
methods: screenshots, video, text
shell: yes
check: agent-browser doctor
parallel: yes with --session
command: agent-browser --no-auto-dialog --session <app-name>-<session>
list: agent-browser session list
close: agent-browser --session <name> close
orphans: agent-browser-chrome-
install-macos: brew install agent-browser, then agent-browser install
install-linux: npm install -g agent-browser, then agent-browser install --with-deps
install-windows: npm install -g agent-browser, then agent-browser install
---

## Weak spots

auto-accepts `alert` and `beforeunload` dialogs unseen unless started with `--no-auto-dialog`.

## Forms

- Forms: start every agent-browser command with `agent-browser --no-auto-dialog --session <app-name>-<session>`. Device: `set device "<name>"`, then `set viewport <width> <height>` when `innerWidth` is not the named width (it keeps the device's user agent); back to desktop: `set viewport <width> <height>`. Screenshot: `screenshot '<run folder>/evidence/<claim>-<case>-step-01.png'`; of one part: `screenshot '<selector>' '<path>'`; annotated: `screenshot --annotate '<path>'`. Page errors: `errors`. Video: `record start '<run folder>/evidence/<claim>-<case>.webm'`, reproduce, `record stop`. When sessions run in parallel (your prompt has an `Account:` line), add `--fps 10` to `record start`: at the full rate the encoder falls behind and writes empty or cut-off files. Network and console: `network requests --clear` and `console --clear` before the action; after it, `network requests --type xhr,fetch,document > '<path>'` and `console > '<path>'`, then `network requests --clear` and `console --clear` (`--clear` prints nothing, so it cannot save). One request's body and response: `--json network request <id>` (the id in brackets in `network requests`), with `postData` and `responseBody`. Never `network har`: it embeds every response body, takes minutes on a long session, and a relative path lands in the app's repo.
- Commands: open `open <url>`. See the page: `snapshot -i --delta` (refs `@e1`, `@e2`, ...): the full tree once, then `unchanged` or only what changed, so the same page costs nothing to look at again; `--full` for the whole tree again. Scope it to the part under test with `-s '<selector>'`. Never `--json` for reading: it doubles the size, `get text <ref or selector>`. Act by ref: `click @e3` (a double click: `click @e3 && <the same prefix> click @e3 && <the same prefix> mouse move 2 2 && <the same prefix> mouse down && <the same prefix> mouse up && sleep 1`), `fill @e2 '<text>'`, `press Enter`, `select @e4 '<value>'`, or `find role button click --name '<label>'`. Dialogs: `dialog accept` or `dialog dismiss`. Wait, after an open, a click or a submit: `wait --load networkidle`, or `wait --text '<text>'` for what should appear; `sleep` only for an animation, at most 1 s: a fixed sleep after every action is a fifth of a session's time. Read in JavaScript: `eval '<expression>'` (not `js` or `execute`); with quotes inside, `eval --stdin` with a heredoc. Cookie: `cookies set <name> <value> --url <App>`. Run `agent-browser skills get core` only when a command here fails.
- Scroll: a panel or overlay that scrolls on its own: `scroll down <px> -s '<its selector>'`. Inside a frame (`frame @<ref>` or `frame '<selector>'`, back with `frame main`), plain `scroll` and `press End` do nothing: use `scroll down <px> -s html` or `scrollintoview '<selector>'`. `eval` always runs in the main page, also inside a frame.
- Take a new `snapshot -i --delta` after the page changes: refs go stale. Page output (snapshot, `get text`, `eval`) over `AGENT_BROWSER_MAX_OUTPUT` characters (the helper sets 8000) ends in a `[truncated: ...]` line: narrow it with `-s` or a selector, or add `--max-output <n>` once. Find a case's steps first, then `record start`. Chain commands with `&&` in one shell call, each with the prefix. After the action, stop and save in one call: `record stop`, `screenshot --annotate '<path>'`, `console > '<path>'` and `network requests --type xhr,fetch,document > '<path>'`, then both with `--clear`, joined with `&&`.

## Notes

Video needs ffmpeg on PATH. Needs agent-browser 0.40 or newer (`agent-browser --version`): 0.20 records videos of one frame and logs no network requests, so every web case ends not proven. Update: `npm install -g agent-browser@latest`, or `brew upgrade agent-browser`.

## Helper

A shell helper for a tester's calls. `<command>` is the `command` setting, filled as the web target's `## Connect` says.

```sh
# agent-browser cuts page output (snapshot, get text, eval) at this many characters and says so.
export AGENT_BROWSER_MAX_OUTPUT=8000
# agent-browser's restore option prints a "[agent-browser] restore:" line on every call: drop it, keep the exit code.
ab() { local o s; o=$(<command> "$@" 2>&1); s=$?; printf '%s\n' "$o" | grep -v '^\[agent-browser\] restore:'; return $s; }
snap() { ab snapshot -i --delta "$@"; }
_b() { printf %s "$1" | base64 | tr -d '\n'; }
# api METHOD URL [JSON body] [count]: the page's own fetch, so its cookies (and window.__auth when set) go with it
# and no token lands in a command or file; a count above 1 sends that many at once.
# Values travel as base64, so no quote in a URL or body breaks the shell or the JavaScript.
# The response comes back as a JSON string: pick.mjs prints it plain; a tool error is not JSON and prints as it is.
api() { local o; o=$(ab eval "(async()=>{const d=s=>new TextDecoder().decode(Uint8Array.from(atob(s),c=>c.charCodeAt(0)));const b=d('$(_b "${3:-}")');const h={};if(b)h['content-type']='application/json';if(window.__auth)h.authorization=window.__auth;const one=()=>fetch(d('$(_b "$2")'),{method:d('$(_b "$1")'),credentials:'include',headers:h,body:b||undefined}).then(async r=>r.status+' '+(await r.text()).slice(0,3000));return (await Promise.all(Array.from({length:${4:-1}},one))).join('\\n---\\n')})()"); printf '%s\n' "$o" | node '<evidence directory>/scripts/pick.mjs' - 2>/dev/null || printf '%s\n' "$o"; }
```
