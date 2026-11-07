# Auto mode

Only the orchestrator reads this file. In auto mode the run asks the user nothing: where a step would ask, this file decides and records, or stops the run. Section and step numbers refer to `SKILL.md`, `RUN.md` and `PROOF.md`, next to this file.

Tester prompts and tester rules never change: `Never open` URLs, safe recipients, no payments, secrets out of log lines. Never put anything from this file into a prompt or a claim.

## 1. Turning it on

1. Auto mode is on for a run when the request contains `--auto` or the phrase `auto mode`, or when `Mode: auto` is in Preferences of `<project folder>/environment.md`. Read that line, if the file exists, before anything else.
2. `--ask` or `ask mode` in the request turns it off for this run, whatever Preferences say.
3. A bare word "auto" never counts: "prove the auto-save change" is ask mode.
4. Your first line in chat says the run is in auto mode, and why, for example: `Auto mode (--auto in the request): I decide instead of asking, and record each decision in decisions.md.` Name Preferences when the `Mode:` line turned it on.

## 2. Decisions

Three kinds:

- **Rule**: one clearly right answer. Decide and record it.
- **Default**: a person might choose differently. Decide and record it as a default; the page lists it in its auto-mode banner.
- **Hard stop**: only the user can decide, or a wrong answer costs too much. Stop with its `Stopped:` line and write nothing more.

| Where | In auto mode | Kind |
|---|---|---|
| `SKILL.md` §2: the writer returns `too big` | Prove the first phase it lists. Add it to `brief.md` under `## Auto mode` (§3), and dispatch the writer again. A second `too big`: stop. | default / hard stop |
| `RUN.md` step 1: `project.mjs` prints a `Problem:` line (the project folder is not git-ignored) | Stop: `Stopped: <the Problem line, without "Problem: ">` | hard stop |
| `RUN.md` step 1: no `environment.md`, or no `## Targets` or `## Setup commands` | Stop: `Stopped: auto mode needs <project folder>/environment.md with ## Targets and ## Setup commands. Run once in ask mode to fill it in, then run again.` | hard stop |
| `RUN.md` step 1: App on a host that is not a local host | Go on only if `environment.md` already has this target and its `Environment` is exactly `local`, `shared` or `preview` (with `App: ask each run`, `preview` covers the URL the request names). Anything else, missing or the template placeholder: stop: `Stopped: <App> is not marked a test environment in <project folder>/environment.md. Set Environment to local, shared or preview if it is one, or run in ask mode.` | hard stop |
| `RUN.md` step 1: `App: ask each run` | The URL the request names. None: stop: `Stopped: App is "ask each run" and the request names no URL. Run again with the preview URL.` | hard stop |
| `RUN.md` step 1: first run, add setup commands? | Add none. When `## Setup commands` already lists some, there is nothing to decide: record nothing. | default |
| `RUN.md` step 1 and `PROOF.md` §2 step 1: evidence setup | Follow the evidence skill's `SETUP.md` auto mode line: defaults for missing targets (default), never install (rule), its stops. Record each default it picks. | default / rule / hard stop |
| `RUN.md` step 1: what the user must do for a driver, and the text-only warning | Say it in chat and go on. A tool that then fails leaves its cases blocked. | rule |
| `RUN.md` step 1: Claude in Chrome not connected | Stop, as its driver definition says: `Stopped: Claude in Chrome is not connected. In Claude Code, run /chrome, then run again.` | hard stop |
| `RUN.md` step 1: the agent asks before a write outside the working folder | Try the write. A refused write: stop: `Stopped: a write to <folder> was refused. Allow it (Claude Code: /add-dir <folder>), then run again.` | hard stop |
| `RUN.md` step 2: feature slug | The request's `feature: <slug>` (rule). Else the matching folder. Else a new slug from the request. | rule / default |
| `RUN.md` step 3: run lock held by another run | Stop: `Stopped: run <folder> holds the run lock. Wait for it to finish, or run again in ask mode to take the lock.` Never pass `--take-lock`, and leave `run.lock` as it is. | hard stop |
| `PROOF.md` §1: approve the areas, then the claims | Approve the area list and every claim as written, headline and routine alike, once `--plan` prints no `Problem:` line. If it prints some, dispatch the writer once more with the prompt it had (`CLAIMS.md` §8 has it fix every `Problem:` line), then the code check if your run uses one, then `--plan`. Still some: stop: `Stopped: the claims still have Problem: lines after a second try. Run again in ask mode to fix them with you.` Approve with `--approve --by auto`. | default / hard stop |
| `PROOF.md` §2 step 4: run sessions in parallel | As the evidence skill's `PARALLEL.md` says. | default |
| `PROOF.md` §2 step 5: a prover reports a blocker a retry can clear | Dispatch that session once more, with the same session id and only the blocked claims' ids. Still blocked: its cases stay not proven. | rule |
| `PROOF.md` §3 step 5: write the ledger | Write it as usual. `build-proof.mjs` marks each claim this run approved `approvedBy: auto`; a claim copied unchanged, or a retirement already in the ledger, keeps its mark. Say in chat that the ledger is not committed. Never commit it. | rule |
| Any other step that would ask the user or wait for them | Stop: `Stopped: auto mode cannot decide <what>. Run again in ask mode, or answer it in the request.` | hard stop |

## 3. Recording

- **`decisions.md`**, next to `brief.md` (`RUN.md` step 4): one line per rule and default, in the order you made them: `Ruling: <what was decided> — <why> — <what it costs if wrong>`. A default's line starts `Ruling: default: `. A hard stop writes `Stop: <its message without "Stopped: ">` as the last line, and nothing follows it.
- **Before the run folder exists** (every ruling before `RUN.md` step 3 creates it: merge base, setup commands, evidence defaults, drivers, slug): keep each ruling, and write them first into `decisions.md` when `RUN.md` step 3 creates the folder. A hard stop before then is the chat line only: create no folder (beyond the project folder `project.mjs` makes) and write no file.
- **`brief.md`**: the only section not in the user's words is `## Auto mode`, for the `too big` pick: `Prove first: <the first phase, as the writer listed it>`.
- **On a stop**: release `run.lock` (`RUN.md` step 3) only if this run wrote it. Then show the `Stopped:` line in chat. If `decisions.md` exists and has rulings, add `Auto mode: <n> decisions, see <path of decisions.md>` and each default under `Decided without you:`.

## 4. Stops

Each stop is one line in chat. Fill in the `<...>` parts. A stop with no row above:

- No driver (`SETUP.md`): `Stopped: no driver for <target label> is installed or connected, and ## Evidence in <project folder>/environment.md names none. Install or connect one, or name one with "· driver: <name>", then run again.`

A stop the steps already have (Node too old, the evidence skill missing, App matching a `Never open` URL) keeps its message, as one line starting `Stopped:`.
