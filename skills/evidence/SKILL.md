---
name: evidence
description: Use when the user asks to set up or change how evidence is captured for the running app (web, API, or a target you define) as GIF, video, screenshots or readable API text, or its evidence strength, asks to define a target or a driver, or when another skill's instructions point here to drive an app, capture evidence or file bugs.
license: MIT
compatibility: Needs an agent that can start subagents, Node.js 18+, git and `shasum`.
---

# Evidence

- **Evidence directory**: the absolute folder that holds this `SKILL.md`.
- **Subagent**: a fresh agent from your platform's delegation tool that does not inherit this conversation. Never a fork.
- **Auto mode**: the calling skill says the run asks the user nothing. The calling skill's rules decide; this skill only follows the lines marked auto mode.
- **Stop** (auto mode): end the run and give the calling skill the reason in one line; write nothing more.
- **Local host**: `localhost`, `127.0.0.1`, `[::1]`, or a name ending in `.localhost` or `.test`.
- **App dir**: the folder the request names for the app ("test the web app in apps/web"), else the folder you were started in; `none` for a URL-only target with no code.
- **Project folder**: what `scripts/project.mjs` prints, the first that applies:
  1. An `Evident folder: <path>` line in the user's instructions (`CLAUDE.md`, `AGENTS.md` or the request; pass it as `--folder`), or `EVIDENT_HOME`: `<path>/<app-name>/`, one folder for every app. Its ledger is then outside the repo, so it is not versioned with the code.
  2. A `.evident/` in the app dir or a folder above it, below the repo root: one the user asked for ("keep evident results in apps/web"). Create it only then.
  3. `<repo root>/.evident/`, plus `<app path>` with `-` for `/` when the app dir is below the root (`.evident/apps-web/`). The default, monorepos included; never ask.
  4. No repo: `~/evident/<app-name>/`.

  `<app-name>`: the repo's Git remote as `<owner>-<repo>` (plus the app path in a monorepo), else the repo folder, else the app's main domain; never a per-deploy URL. `.evident/` ignores everything but its `ledger/` through its own `.gitignore`, which the script writes once and never overwrites, because `environment.md` holds passwords. When the folder would not be git-ignored, the script prints a `Problem:` line and nothing is written there.
- **Request folder**: one per user request, `<project folder>/<feature>/<YYYY-MM-DD>-<HHMM>-<kind>/`, holding `brief.md`, `decisions.md` and a step folder per part (`explore/`, `spec/`, `fix/`, `proof/`, `proof-2/`, ...). Fixing an explore's bugs adds its steps to that explore's request folder. `show-your-work/scripts/run-folder.mjs` makes them.
- **Ledger dir**: `<project folder>/ledger/`, committed with the code: one file per feature, `<feature>.jsonl`, one claim per line, holding the claims that feature's runs wrote, each with tags naming every feature it belongs to; plus `terms.json`. Read it only through `show-your-work/scripts/ledger.mjs`, which prints the matching claims one line each; never read the folder or a claim file.
- **Config**: the `## Evidence` section of `<project folder>/environment.md`.
- **environment.md**: made from `<evidence directory>/environment-template.md`, which defines every section the testers read.
- **Missing**: `## Evidence` is missing when the section is not there, or holds only the template's placeholder line, which starts `<written by the evidence skill's setup`.

When the user asks to set up or change `## Evidence`, or to define a target or a driver, follow `<evidence directory>/SETUP.md`.

## For calling skills

A calling skill:

1. Before the run, has its orchestrator read `## Evidence`, and follow `<evidence directory>/SETUP.md` if it is missing, or its line for a target the run uses is missing or `none`.
2. Has each tester follow `<evidence directory>/CAPTURE.md`; its prompt names each capture, never how to make it. Its `Target file:` and `Driver file:` lines are its target's `files.target` and `files.driver` in the step's `targets.json` (`none` for no driver file). An explorer's prompt has neither: it reads them from the `## Capture` section `start.mjs` prints instead. When they are missing (a step made before them), each is the path `node <evidence directory>/scripts/definitions.mjs <project folder> --show target|driver <name>` prints first.
3. With two or more sessions, follows `<evidence directory>/PARALLEL.md` before dispatching them.
4. Right before dispatching the first tester, runs this once: `git -C '<code path>' rev-parse --short HEAD; test -z "$(git -C '<code path>' status --porcelain)" || (git -C '<code path>' diff HEAD; cd '<code path>' && git ls-files --others --exclude-standard -z | xargs -0 shasum -a 256) | shasum -a 256 | cut -c1-8`. The value is the first line, plus `+dirty:<second line>` when there is one; with no code path, or `Code` is `none`, it is `none`. Gives every tester the value as a `Commit:` prompt line. Its orchestrator never reads `CAPTURE.md` or a target's `## Connect`, `## Drive` and `## Capture`: they are the testers'.
5. After the last session, does the join in `PARALLEL.md` (when sessions logged to their own `evidence-<session id>.jsonl`) and `## Check`, in that order, before its report script.
6. Closes the run's browser sessions with `node '<evidence directory>/scripts/sessions.mjs' '<run folder>' close`, adding `--name <it>` when the request names a browser session name (it then also closes every open session with this run's prefix): right before dispatching the first tester (it closes what an earlier attempt left), each time a batch of testers returns, a tester that crashed or stopped on a blocker included, and before the report script. It closes only the sessions the step folder records, and stops orphan browsers (a driver's browser whose tool is gone). Show its `Problem:` lines; they stop nothing.

The config decides the methods. A case whose picked methods all failed has no evidence: treat it as missing evidence.

## Check

When `Check: on`, dispatch checkers: fresh subagents (in Claude Code, of the `evident:evident-checker` or `evident-checker` agent type when it is listed; the evident plugin or evident's `setup` installs it). With `evidence-<session id>.jsonl` files in the run folder, count each one's lines (`wc -l`), then group them in session order into batches of about 50 lines, never splitting a log; when that makes more than 10 batches, make 10 of near-equal lines. Dispatch one checker per batch, all in one message, in the foreground. With none (sessions ran one at a time), dispatch one, for `evidence.jsonl`. Each gets exactly this prompt, filled in:

```
Read <evidence directory>/CHECK.md and follow it.
Run folder: <run folder>
Evidence log: <its batch's logs, comma-separated: evidence-<session id>.jsonl, ...; or evidence.jsonl>
```

When they have all reported, for each `evidence-<session id>.jsonl` with no `check-<session id>.jsonl` (or `evidence.jsonl` with no `evidence-check.jsonl`), each log whose checker said it stopped before the end, and each log whose lines the report script says are not checked, dispatch one more checker, the same way, for that log alone. When that one writes none either, the log is unchecked: say so in your report, by name; never write its check file yourself. Then join their rows in session order: `cat '<run folder>'/check-*.jsonl > '<run folder>/evidence-check.jsonl'`. Skip the join when one checker wrote `evidence-check.jsonl` itself. The report script lists each evidence file no check row names as `not checked`.

Never edit `evidence-check.jsonl`. Never recapture or change evidence because of a `mismatch`: report it.
