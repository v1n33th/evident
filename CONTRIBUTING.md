# Contributing

## Layout

```
evident/
├── setup             links each skills/<name>/ into ~/.claude/skills/<name>, writes agents/ into ~/.claude/agents/;
│                     --codex links the skills into ${CODEX_HOME:-~/.codex}/skills/ instead
├── skills/           what ships to every agent: show-your-work/, bug-bash/, fix-and-prove/, evidence/
├── agents/           optional Claude Code agents for explorers, provers, evidence checkers and fixers
├── .claude-plugin/   the Claude Code plugin and marketplace manifests; hooks/ holds the plugin's guard hook
├── tests/
│   ├── unit/         one test file per script
│   ├── evals/        each skill's eval cases, by skill
│   └── fixtures/     the acme-invites app with planted bugs, its answer key, score.mjs
└── .workspaces/      git-ignored output of eval iterations
```

The skills run in any coding agent that can start subagents, so their files name no Claude Code-only tool, setting or path except in a Claude Code note: after "Claude Code" in the same sentence ("Claude Code: `/add-dir`"), or under a heading that says "Claude Code only". `tests/unit/portability.test.mjs` fails on any other, and on a `SKILL.md` frontmatter field the [Agent Skills spec](https://agentskills.io/specification) does not define.

Only `skills/` and `agents/` are installed. `agents/` sits beside `skills/`, not in it, because agent files are Claude Code's alone: the Skills CLI and other agents install `skills/` and never see them, and `setup` writes them to `~/.claude/agents/` (as a plugin, Claude Code drops an agent's own hooks, so `hooks/hooks.json` runs the guard instead). Anything a user should not get, such as tests, eval cases or fake `environment.md` files, goes in `tests/`. A new skill is a folder in `skills/` with a `SKILL.md`; `setup` picks it up.

## Files

`skills/evidence/`:

| File | Purpose |
|------|---------|
| `SKILL.md` | The caller contract and the evidence check |
| `environment-template.md` | The per-project configuration (`environment.md`) that runs fill in with you on the first run |
| `PARALLEL.md` | When sessions may run in parallel, their accounts and the join; read only for runs with two or more sessions |
| `SETUP.md` | Setup of the `## Evidence` config, read only when it is missing or a run needs a target it lacks |
| `CAPTURE.md` | How testers drive the app and capture evidence: the record in `evidence.jsonl`, safety rules, setup commands and filing bugs |
| `issue-types.json` | The kinds a filed bug can have |
| `CHECK.md` | What each evidence checker does: for each session log it is given, check that each evidence file shows what its log line says |
| `targets/<name>.md` | The built-in target definitions (`web`, `api`): the settings scripts read (label, address, drivers, methods, what proves a case, viewports, cases per session, a bug's found files), then each target's connect, drive, capture, test ideas and sign-in rules, which testers read |
| `drivers/<name>.md` | The built-in driver definitions (`agent-browser`, `claude-in-chrome`, `curl`, `hurl`): targets, methods, install check and commands, parallel safety and command, then weak spots, forms, notes and an explorer's shell helper; a tester reads only its own |
| `templates/target.md`, `templates/driver.md` | Blank definitions with every setting explained, which setup's interview fills; a user's own definitions go in the project folder's `targets/` and `drivers/`, or in `~/.evident/` for every app |
| `scripts/project.mjs` | Finds or makes the project folder (`--folder`, `EVIDENT_HOME`, the repo's `.evident/`, or `~/evident/<app>/`), writes its `.gitignore`, and links a worktree's `environment.md` to the main checkout's |
| `scripts/make-image.mjs` | Writes a plain PNG of a given size, for a case that uploads a generic image |
| `examples/` | The old CLI target and its asciinema driver as definitions, never tested and not on the lookup path |
| `scripts/definitions.mjs` | The only code that finds and parses definitions (the project folder's, then `~/.evident/`'s, then the built-ins): `--list targets\|drivers`, `--show target\|driver <name>` (the path, then the prose), `--check`, and `--snapshot <step folder>`, which `run-folder.mjs` runs to freeze each step's target rules and drivers in `targets.json` |
| `scripts/log.mjs` | Appends checked JSON lines to a log in the run folder, adding `sha256` and `at` to each line with a file, then rebuilds the request's page in the background, at most once every 30 seconds |
| `scripts/setup.mjs` | Runs one setup command under `set -C` and saves its `-setup.txt` evidence in one call, with cookie and authorization values, token and password fields, signed tokens and bearer tokens redacted |
| `scripts/new-bug.mjs` | Takes the next free bug number and creates the bug's folder in one call, so parallel testers never share a number, and writes the charter (`--session`; a browser session name ending in a charter id counts as that charter) into `bugs/.BUG-NNN`, so no other charter logs into or finishes that folder; `--done` checks `bug.json` (expected's shape, kind, impact, severity, the target's `found` files, no picture another bug or an as-expected step logged) and logs the folder, again for a file rewritten since; `--withdraw` removes an unlogged bug, and keeps a logged one marked `withdrawn` with the why, which `--list`, the report and the chat summary leave out of the counts (a `duplicateOf` bug too) |
| `scripts/listing.mjs` | Prints one session log's lines with a file, and the text of its text files, for the evidence checker |
| `scripts/pick.mjs` | Reads a saved JSON file (a mail API's response, an API body) for testers: filters items by `key=value` or `key~text`, nested keys with dots, and prints them, chosen fields or a count, so no tester needs `node -e` or `python` |
| `scripts/sessions.mjs` | Closes browser sessions: with Session ids, those (a tester's last step); with none, every session the step folder records (and, with `--name`, every open session with the run's prefix), then stops orphan browsers (a driver's main browser process matching its `orphans` profile, with parent PID 1: TERM, then KILL). Closes only sessions the driver's `list` shows, by the names the run's own driver command gives them, so it never touches another run's; only this user's processes are signalled |
| `scripts/guard.mjs` | The `PreToolUse` hook of the `evident-prover`, `evident-prover-shell`, `evident-explorer` and `evident-checker` agents (`--role prover\|checker\|explorer`, or `agent` to take it from the call's `agent_type`), which also reads Codex's hook JSON, and a plain check for any other harness (`--command '<shell command>'` or `--read <path>`, `--cwd <dir>`): blocks `node -e` and `python`, a checker reading its evidence log, an explorer writing a file outside a run folder (but `~/.evident/tool-notes.md`), reading `leads.jsonl`, reading a picture outside `bugs/` or naming another charter's bug folder, and a prover listing the run folder or `sessions/` or reading `claims.json`, the ledger, a fix (a patch, `rounds.json`, `result.json`, a `bug.json` with a fix) or the app's code; exit 2 with a one-line reason, exit 0 on input it cannot parse |

`agents/` (optional: each skill dispatches a plain subagent with the same prompt when the platform lists no such agent type):

| File | Purpose |
|------|---------|
| `evident-prover.md` | A prover: inherits the parent's model, has no Agent, Edit, Glob, Grep, Skill or web tools (it keeps the browser's MCP tools), runs `guard.mjs --role prover` before each Read and Bash call; its body says to follow the `PROVER.md` its prompt names |
| `evident-prover-shell.md` | The prover for a session that drives the app from the shell (a driver with `shell: yes`, such as agent-browser or curl): `Read` and `Bash` only, so no MCP tool list rides on every turn, same guard; `PROOF.md` picks it over `evident-prover` for such a session |
| `evident-explorer.md` | A bug-bash explorer that drives the app from the shell: `Read` and `Bash` only, on the parent's model, with `guard.mjs --role explorer` (no file written outside a run folder, no `leads.jsonl`); its body says to follow the `EXPLORER.md` its prompt names |
| `evident-checker.md` | An evidence checker: `Read` and `Bash` only, on the parent's model, with `guard.mjs --role checker`; its body says to follow the `CHECK.md` its prompt names |
| `evident-fixer.md` | A fixer: `Read`, `Edit`, `Write` and `Bash` only, on the parent's model, with no guard hook (it edits the app's code and records with `node -e`); its body names `FIXER.md`, which also marks it as written by `setup` |

Their hook runs `$HOME/.claude/skills/evidence/scripts/guard.mjs`; `setup` writes each with this clone's absolute path instead. As a plugin (`.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`), Claude Code ignores an agent's `hooks`, so `hooks/hooks.json` runs `guard.mjs --role agent` on every Read and Bash call, which takes the role from the call's `agent_type`. Check the plugin with `claude plugin validate .claude-plugin/plugin.json`. `tests/unit/agents.test.mjs` fails on a frontmatter field Claude Code does not document, since it ignores unknown ones silently.

`skills/show-your-work/`:

| File | Purpose |
|------|---------|
| `SKILL.md` | The orchestrator: input, the claim writer, and its own auto mode rows |
| `RUN.md` | Run setup shared with bug-bash: dispatch, environment, run lock, brief, issue types, ledger folder |
| `PROOF.md` | Approval loop, proof sessions, report and ledger |
| `AUTO.md` | Auto mode: how each step decides instead of asking, `decisions.md`, and where a run stops |
| `REPROVE.md` | Re-prove mode: prove an earlier run's approved claims again without rolling the ledger back; its own auto mode rows |
| `CLAIMS.md` | What the claim writer does: claim format, sentence shapes, writing rules, ranking and setup |
| `CLAIMS-findings.md` | Findings mode, read with `CLAIMS.md` when the prompt has a `Findings:` line: claims from bug-bash's bugs |
| `CLAIMS-change.md` | Read with `CLAIMS.md` for a diff or a ledger: copying ledger claims, and the required claims |
| `CODE-CHECK.md` | What the code check does: mark claims the code likely breaks |
| `PROVER.md` | What each prover does: decide the expected result, run each case at its viewports, judge it literally and log it; it drives the app, captures and files bugs as the evidence skill says |
| `scripts/build-proof.mjs` | Zero-dependency builder: the approval view and its checks (`--plan`), approval (`--approve`), each session's test-fields-only claims (`--session`), the step's `result.json`, the request's `report.html` and the chat summary, and the ledger (`--ledger <dir>`; with fix-and-prove's re-proof runs after it, the verdicts the rollback ends with) |
| `scripts/report.mjs` | Writes the request's one page, `report.html`, from every step's files, live while the run holds the lock, and the project's `index.html` |
| `scripts/ledger.mjs` | The only reader of the ledger: prints the claims of the tags, files or ids asked for, one line each, and writes it for `--ledger` |
| `scripts/run-folder.mjs` | Makes a request folder and its steps, takes and releases `run.lock` |
| `scripts/questions.mjs` | Records your answer to a question a run asked, in the feature's `answers.jsonl` |

`skills/bug-bash/`:

| File | Purpose |
|------|---------|
| `SKILL.md` | The orchestrator: profiles, charters, explorers, bugs to claims |
| `QUICKSTART.md` | The quick start with no `environment.md`, and its auto mode rows |
| `CHARTERS.md` | What the planner does: learnings from the code, and charters with a profile, target, account, heuristics, viewports and step budget |
| `EXPLORER.md` | What each explorer does: act as the profile, log each step, file and replay bugs; the scripts below do the evidence mechanics |
| `SHORTCUT.md` | How an explorer reaches a charter's groundwork by a shortcut, read only when the charter allows one |
| `scripts/start.mjs` | Everything an explorer needs before its first step, printed in one place (over 28,000 characters, the capture rules go to `charters/.<id>/capture.md` and a `Capture rules:` line names it, since the harness writes a longer result to a file the explorer reads back in pieces; still over, the `## Before you` section drops step lines from the end), a `charters.json` found in the parent folder named as the planner's slip, the fields its captures share, and a shell helper (`charters/.<id>.sh`: `R`, `S` (the charter's scratch folder), `ab` (the browser, with `--session`'s name), `snap`, `api`, `step`, `bug` (`bug <slug>` sets `B` to the folder it made), `pick`) each command sources |
| `scripts/step.mjs` | Appends one step to the charter's log, logs its captures with the step's `actual` as their note, redacts the charter's scratch files, and names the viewports and heuristics left; `--left` for the orchestrator's retry, `--return` refuses an explorer under 80% of its budget |
| `scripts/decisions.mjs` | The planner's check of its owner decisions: each quote at its cited line; `--add` records every rule line and table row under a decision or left-to-the-builder heading that no decision quotes |
| `scripts/profiles.mjs` | What the skill's profiles added since the project's copy was made, and `--merge` |
| `tester-profiles.json` | The default profiles, copied to the project and tailored on its first run |

`skills/fix-and-prove/`:

| File | Purpose |
|------|---------|
| `SKILL.md` | The orchestrator: modes, baseline, rounds of explore, fix and verify, rollback, report |
| `FIXER.md` | What each fixer does: the confidence rules, the fix, its patch and commit, and the `fix` record |
| `scripts/fix-setup.mjs` | §1's checks and run folders in one call: pending bugs, git, the lock, the fix run with `user.diff` (your uncommitted edits), and the baseline run; `--list` only prints |
| `scripts/fix-patch.mjs` | A fixer's snapshot before a fix and its patch after, in two commands, each on its own git index so fixers run at once; `commit` then commits a round's patches, one per bug in the order they were written, stopping at one that does not apply, and records each commit in `bug.json`; `live` says whether the app rebuilt the changed files; `reapply` puts patches back after an undo, three-way when one no longer applies as it is, and names each that conflicts |
| `scripts/fix-gate.mjs` | The rules on risk, gaps, sources and proven ledger claims in one place: a fixer runs it before an edit (`--plan`), §4 runs it on the fix records and patches after, and §5's rollback asks it which fixes may have broken a claim, those whose added text the failure shows first (`--suspects`) |
| `scripts/decide.mjs` | Records a decision pasted from a page on its bug and in `answers.jsonl`, and says what is left to do |
| `scripts/fix-list.mjs` | §4's fix list in one call: one line per bug, with its fix status, risk, `inProduction`, patch and source once a fixer wrote them, and `not confirmed` when the evidence check contradicts its own picture |
| `scripts/fix-claims.mjs` | Writes a verify run's claims: one per fixed bug from its `expected`, the ledger claims to re-check and the baseline's spec claims (`--only` for a re-proof), and prints the claim writer's prompt when a fix may conflict with a proven claim |
| `scripts/build-fix-report.mjs` | Writes the fix step's `result.json` and the request's `report.html` from `rounds.json`, the fix records and the proof runs, a re-proved claim with its last re-proof's verdict; `--verdicts` prints a proof run's claim verdicts, with a disproved claim's failing `actual` |


## Testing the skills

Run every test from the repository root:

```bash
node --test 'tests/**/*.test.mjs'
```

`tests/fixtures/acme-invites/README.md` is a small app with planted bugs and an answer key, for checking the skills end to end; scenario F1 checks fix-and-prove's fixes. `tests/evals/<skill>/` holds each skill's own eval cases. Write eval iteration output to `.workspaces/`, never into `skills/`.

## Releasing

Development and its history live in a private repository (`origin`). The public repository (`public`, github.com/v1n33th/evident) gets one commit per release, made from main's files, with no history between releases. For each release, from the private clone:

1. Set `version` in `.claude-plugin/plugin.json` to the new release, update the tags in README.md's install commands, and commit on main. `tests/unit/agents.test.mjs` fails while a tag is newer than the version.
2. Make the release commit on the `public` branch and tag it:
   ```bash
   git branch -f public "$(git commit-tree 'main^{tree}' -p public -m 'evident v<version>')" && git tag v<version> public
   ```
3. Push: `git push origin main --tags`, then `git push public public:main v<version>`.

## Design principles

- **No hidden knowledge.** The orchestrator sends the agents only the brief and fixed prompt templates: no suspected bugs, no implementation notes. Provers get only the claims, never the code or the diff. Explorers may learn from the code, but only through `learnings.jsonl`, each fact with its source (lead testers also through `leads.jsonl`, the planner's suspects), and file only what the app shows.
- **Agree on the evidence first.** You approve the claims and the evidence each needs before anything is tested.
- **Expected before actual.** Testers decide the expected result before each action and log each attempt once, so the log is the real test path.
- **One session at a time by default.** Sessions share the browser, the app's data and the accounts; they run in parallel only when the evidence skill's conditions hold and you say yes.

