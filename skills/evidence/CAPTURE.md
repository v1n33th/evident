# Capture evidence

Read this file, then your target's definition and your driver's, at the paths your prompt's `Target file:` and `Driver file:` lines give. An explorer has no such lines: it reads them from the `## Capture` section `start.mjs` printed instead. With `Driver file: none`, use your driver's own commands by these rules and your target's. `<evidence directory>` is the folder that holds this file.

## 1. Log

Right after you capture each evidence file, log one line for it in `<run folder>/evidence.jsonl` with `node '<evidence directory>/scripts/log.mjs' '<run folder>' evidence.jsonl '<line>' ['<line>' ...]`, never with `echo`, `printf` or a heredoc. Log all of a case's files in one call. On a `Problem:` it writes nothing: fix the line and run it again. A line:

```json
{"claim": "C5", "case": "c", "target": "web", "method": "Claude in Chrome gif_creator", "strength": "cross-checked", "role": "picture", "commit": "acf66736+dirty:3f9a01c2", "env": "http://localhost:3000", "by": "01-web-free-owner", "file": "evidence/C5-c.gif", "note": "11th invite: \"Daily invite limit reached.\""}
```

- `claim` and `case` ids, or `bug` (the bug id), never both.
- `target`: your target's `name`. `method`: the tool and command that made the file. `strength`: from `## Evidence`. `role`: `picture`, `measure` or `raw`.
- `commit`: your prompt's `Commit:` line.
- `env`: the base URL or working folder you drove. `by`: your `Session id`. `file`: relative to the run folder.
- `sha256` and `at`: leave them out; the script adds them. Never write, recompute or edit them.
- `note`: the value or text the file shows that the case's `expect` asks about, and nothing more, in one line, copied from the file or the tool's output (a status code from the network log, text from the page text), never written from memory or from what you expected. For a picture, look at it first and write what it shows, naming anything that covers the state the case expects (a browser bubble, a dialog, a cookie banner): a note that claims covered text is a mismatch and fails the case. `log.mjs` refuses a note whose `METHOD /path status` is on no line of its network log. A request file's note says only what was sent (method, path, the body's fields); the status and what came back go in the response file's note.

Capture with every method `## Evidence` picks for your target, and no other. Setup-command output and emails from the mail API stay allowed. `Custom:`: capture as its words describe, by the same rules; if they are unclear, log a `failed: custom: <why>` line. A failed method gets a line with `"method": "failed: <tool>: <why>"` and no `file` or `sha256`.

Save files in `<run folder>/evidence/` as `<claim>-<case>.<ext>` (at a named viewport, `<claim>-<case>-<viewport>.<ext>`), with your target file's suffixes. Use absolute paths. Move capture output that lands elsewhere into it before you log it.

## 2. Rules

- Open or call only the App, the `## Targets` URLs and the "Also allowed" hosts in `environment.md`, never a "Never open" URL.
- Never restart, stop or reset the app, and never run its `Restart:` line, even when `environment.md` says a restart restores its data. For a fresh starting state, use a new account or a setup command.
- Allowed commands: those your target file lists; `node` with the scripts in `<evidence directory>/scripts/`; `date`; and the driver `## Evidence` names for your target, in the Forms of its definition. Nothing else, even to look around: never `node -e` or `python`. To read a JSON file you saved (a mail API's response, an API body), use `node '<evidence directory>/scripts/pick.mjs' '<file>' [--in <key>] [<key>=<value> | <key>~<text> ...] [--fields <key>,<key>] [--count]`: it keeps the items whose key equals the value (`=`) or contains the text (`~`), nested keys with dots (`To.Address`), and prints them, their fields or their count. Read files with your own tools. In the run folder you may create, write, move and delete your own files, with file tools or `mv`, `rm`, `cat` and redirects. Never move or copy files out of the app's working folder or repository.
- Never redact evidence files yourself. The scripts do: `setup.mjs` in the setup files it saves, and `log.mjs` in each text file it logs (and in `note` and `actual`) before it hashes the file, with cookie and authorization values, bearer tokens and the `## Accounts` emails as `<redacted>`. Pictures and videos stay as captured. In what you write yourself (log lines, notes, bug text such as `steps` and `actual`), write each password, token, cookie, key or account email as `<redacted>`.
- Never edit a file after capture, and never retouch, crop or re-encode one. Never reuse a file name: to change a capture, capture again under a new name and keep both.
- Sign up, and send emails, invites and shares, only with an account in `## Accounts` or an address that fits the `New accounts` pattern exactly. For each new address, a sign-up's too, fill the pattern's placeholder with a new value of the kind it names and nothing else: for `qa+<unix-time>@acme.test`, run `date +%s` once (say it prints 1793287335), then write `qa+1793287335@acme.test`, `qa+1793287336@acme.test`, ...; when your prompt has an `Evidence log:` line, first add 1000 times the first number in your `Session id` (`02-web-free-owner`: 1793287335 + 2000 = 1793289335): digits only, in full, never in exponent form. Never add letters, words or symbols to the value, and never make up another address, not even one that reads better, fills a limit or tests the app. Exception: a session whose profile is `bad-actor` may also send to the addresses an attack needs (markup, look-alike or Unicode domains, odd characters), and so may a case that says how its address differs from a `New accounts` address: take the pattern's next address and make exactly that change. Write each such address in full in the step's log line. Pay only with a test card or sandbox that `## Rules` names; else log the case blocked with `needs payment`.
- Any target may read `## Emails` as it says, with `curl`: save the response with `-o`, then read it with `pick.mjs` (`node '<evidence directory>/scripts/pick.mjs' '<file>' to=<address> --fields subject,links`).
- Sign in as `Sign in:` under `## Accounts` says, as your account, once at the start of your session, and stay signed in. With two or more accounts (an `Account:` line with several keys), sign in as the one your first case acts as. No line: the app's own sign-in page.
  - `email code` or `email link`: ask the app for it, then read it as `## Emails` says.
  - `setup <key>`: run that setup command in the §4 form, with `-` for `<claim>-<case>` and your account key, even when your instructions name no setup command: it saves no evidence file. Then do what your target's `## Sign in` says.
  - `SSO <host>`: sign in on that host only; it must be under "Also allowed".
  - A step the line does not cover (a second factor, a CAPTCHA): log it blocked with `needs sign-in: <what>`. Never get past a CAPTCHA.
  - To change account, for a case that acts as another of your accounts, sign out as `Sign out:` says, else clear the session's cookies and storage, then sign in as that one.
- Measure the state (text, computed style, status code, exit code) and put the value in `note`.
- A case whose `expect` is a value no screen shows (a status code, a stored value, an email, a size in px): save the file that shows it (the response, the measure, the email from the mail API) under the case's name, with a note that quotes the value. That file proves the case; a picture still shows what a person saw.
- Prefer files a tool writes: a capture tool's picture, then `curl -o`, a shell redirect or a raw email from the mail API. Text you type or copy into a file supports a case but never replaces the tool's file.
- Keep GIFs and videos short and under 10 MB. Show the URL or command in the evidence where you can.
- Before a case's picture or recording ends, scroll every value its `expect` names into view and hold it about a second: a file that does not show it proves nothing.
- A state shorter than one frame of your recording (40 ms at 10 fps) is in no frame. Save the timestamped log of the observer that caught it as a file, logged with `role` `measure` and a note that quotes the lines showing the state. The recording's note names only what its frames show. When a case acts in two tabs or as two accounts, record the tab where the expected result shows.
- A 429 is not a bug unless the limit is wrong for a real user. Never poll a limited endpoint in a loop.

## 3. Parallel sessions

When your prompt has an `Evidence log:` line, log to the file it names in the run folder (`evidence-<session id>.jsonl`), never to `evidence.jsonl`.

## 4. Setup commands

For a setup command in your instructions (a key from `## Setup commands` with placeholder values):

- Run it only where its "allowed on" lists this environment. Fill only the placeholders.
- Run it exactly as `node '<evidence directory>/scripts/setup.mjs' '<run folder>' <claim>-<case> '<folder>' '<command>'`, with no other commands, pipes or redirects. `<folder>` is the Code path in your prompt, else the `Code` line of `environment.md`, else the run folder. `<claim>-<case>` is the first case it serves.
- The script saves `<claim>-<case>-setup.txt` in `<run folder>/evidence/`: the command, its exit code and full output. A later setup command for the same case, a rerun included, gets the next number: `-setup-2.txt`, `-setup-3.txt`, ... Log the file as §1 says, with `"method": "setup command <key>"`, `"role": "measure"` and the exit code in `note`. It does not replace the case's own evidence.

## 5. Bugs

When a case fails, file its bug before any retry:

1. First run `node '<evidence directory>/scripts/new-bug.mjs' '<run folder>' --list`: the bugs filed so far, by you and the testers running beside you. When one shows your failure (its `expected` broken the way you saw it), file nothing: on another page, account or viewport it is still that bug. Write its id where you would write yours, and go on. A second folder for one failure is fixed and proven twice and uses up the batch. Else run `node '<evidence directory>/scripts/new-bug.mjs' '<run folder>' <slug>`, with a slug of lowercase words and hyphens. It takes the next free number, creates `bugs/BUG-NNN-<slug>/` and prints the id and folder. Never pick a number or create a bug folder yourself.
2. Copy the failing case's evidence files into that folder, keeping their names. Log each copy as §1 says, with `"bug": "BUG-NNN"` and its new path. The copies are the bug's repro and network and console logs, at every strength, even when the case has none: record no separate repro.
3. Write `bug.json`. Write `title` from what you saw (`actual`), never from a guessed cause; put a guessed cause only in `hypothesis`, or omit it. Write `expected` as a claim a prover could test later: one sentence of at most 20 words, in the present tense, starting "The app", "When", "While", "Where" or "If ... then", naming no code ("If a Free org has sent 10 invites today, then the app refuses the 11th."). Take `kind` as an id from `<project folder>/issue-types.json` if it exists, else from `issue-types.json` next to this file:
   `{"id": "BUG-NNN", "claim": "<id>", "case": "<id>", "kind": "<id>", "title": "...", "severity": "critical|major|minor|cosmetic", "impact": "<one new-bug.mjs printed>", "session": "<Session id>", "target": "<your target's name>", "account": "<the account key you used>", "viewport": "<name, only when your target has viewports>", "url": "<page, or the URL called>", "steps": ["...", "..."], "expected": "...", "actual": "...", "hypothesis": "optional"}`
4. Run `node '<evidence directory>/scripts/new-bug.mjs' '<run folder>' --done BUG-NNN`. It checks `bug.json` and that every file in the folder is logged. Fix what it names, and run it again.
