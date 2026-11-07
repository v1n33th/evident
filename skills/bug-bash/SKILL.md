---
name: bug-bash
description: Use when the user asks to explore, bug-bash, bug-hunt, dogfood or exploratory-test a feature in the running app (web, API, or a target you define), or asks what the approved claims missed.
license: MIT
compatibility: Needs an agent that can start subagents, Node.js 18+, git, the driver your target's definition names, and the show-your-work and evidence skills installed next to this one.
---

# Bug bash

Explore a feature as real users would, and file each bug with evidence and the behaviour a user should see. Proving comes later, on the user's request, with `show-your-work`: typically once a bug is fixed.

**Core rule: explorers learn only from their charter, the docs, the app and `learnings.jsonl`,** which the charter planner and explorers write from the code, each fact with its source; lead charters also read their lines of `leads.jsonl`, the planner's suspects. Never put a suspected bug, a file, a function or any code detail into a charter, a prompt or `brief.md` yourself. Prompts hold only the dispatch lines below, plus the two lines `PARALLEL.md` adds. Never fix the app, offer a fix or start one.

## Terms

- **Skill directory**: the absolute folder that holds this `SKILL.md`.
- **Show-your-work directory**: `<skill directory>/../show-your-work/`. **Evidence directory**: `<skill directory>/../evidence/`. If either is missing, stop and tell the user to install it next to `bug-bash`.
- Run terms are in `<show-your-work directory>/RUN.md`: read them first.

## 1. Set up

1. Input: the user's words for what to explore, verbatim. If they are too thin to aim at a feature, ask. Auto mode turns on as `<show-your-work directory>/AUTO.md` says; when it is on, read the file and the `## Auto mode` section at the end of this one before going on.
2. Quick start, when `<project folder>/environment.md` does not exist and the request gives the app's web URL or its API base URL (not one found in the app's docs or code): read `<skill directory>/QUICKSTART.md` and follow it.
3. Follow `<show-your-work directory>/RUN.md` with kind `explore`. The brief's second heading is `## To explore`.
4. Profiles: if `<project folder>/tester-profiles.json` does not exist:
   - Copy `<skill directory>/tester-profiles.json` there, and fill each profile's `who` and `knows` with the product's domain, from its docs, its own pages, its API docs, its `--help` or the user (on a quick start, only what the app itself shows). Add each target defined for this project to the `targets` of the profiles that list `api`: the names `node <evidence directory>/scripts/definitions.mjs <project folder> --list targets` prints with source `project` or `user`.
   - If the product's docs describe users no profile covers (a role, a device, a place of work), propose up to two more in the same shape, with `"optIn": true`, and add only those the user accepts. On a quick start, propose none.
   - Show the profiles in a few lines, marking those `default` runs, and ask which should run on every run. Write the answer as `Profiles:` in Preferences. On a quick start, ask nothing: say in one line which run by default and that `Profiles:` changes it.

   If it exists: run `node <skill directory>/scripts/profiles.mjs <project folder>/tester-profiles.json <skill directory>/tester-profiles.json`. When it lists what the skill added since the copy was made, show those lines and ask once: "Merge them into your profiles?" On yes, run it again with `--merge`. In auto mode, show them and merge nothing.

   The run's profiles: those the request names, else `Profiles:` in Preferences, else `default`. `default` means every profile without `"optIn": true`; `all` means every profile. Words in the request or anywhere in `environment.md` that ask for every profile ("use all tester profiles") mean `all`, in auto mode too, over a `Profiles:` line. When the run's profiles leave out `bad-actor` and the feature shows what one user types (text, links, images) to other people (an email, an invite, a shared or public page), say in one line, in auto mode too: `This feature shows user-typed text and links to others: add bad-actor with "profiles: default,bad-actor" to test abuse.` Keep only profiles whose `targets` include a target in `## Targets` (no `targets`: web). If none is left, say so and stop. If `bad-actor` is among them, tell the user, in auto mode too: "Warning: the bad actor sends emails and invites to made-up addresses, look-alike domains included. Run it only where the app's mail stays in a test inbox and never reaches real people."

5. Passes: `both` or `leads` when the request asks for them ("with leads", "leads only"), else `Passes:` in Preferences, else `blind`. `blind` runs only blind testers, who never see the planner's suspects. `both` adds one or two lead testers after them, who try the suspects the blind pass did not hit.

## 2. Charters

Dispatch one subagent with exactly this prompt, filled in:

```
Read <skill directory>/CHARTERS.md and follow it.
Run folder: <run folder>
Project folder: <project folder>
Code path: <app repo, or none>
Ledger dir: <ledger dir, or none>
Profiles: <profile ids, comma-separated>
Passes: <blind | both | leads>
```

When your caller gives `Spec claims:`, `Earlier rounds:`, `Learnings from:` or `Changed files:` lines, add them to this prompt as given. When it gives a `Batch:` or `Until:` line, add it to each explorer prompt in §3 as given. Add none otherwise.

Before you show its view, count the charters on each key of `## Accounts`. When `New accounts` allows one and more than two charters share a key, dispatch the planner once more with the same prompt and this line, and take that view instead: `Accounts: a new account for each charter that needs no seeded data or the key's plan; a charter that keeps a key names in its mission what it needs from it`. Charters on their own accounts can run at once (`PARALLEL.md`), and none is stopped by a limit another charter filled.

Show its view verbatim. When a `Not reachable now:` line needs a plan or account type and `## Accounts` has no `Plans:` line naming it, ask once, outside auto mode: `<part> needs a <plan> account (suggested from the code: <the line's suggestion, or none found>). How each app reaches a plan differs, so testers use only the way you give and never pay, start a trial or edit data to reach one. Test on that account type? Answer with a key on it, a setup command that sets it, or skip.` Write a key or command into a `Plans:` line under `## Accounts` (a new key also goes in its table, a command in `## Setup commands`), and dispatch the planner once more with the same prompt. For each other `Not reachable now:` line, suggest a setup command that reaches the state it needs (a back-dating one such as `seed-invites {org} {count} {hoursAgo}`, or one such as `set-plan {org} pro` for a paid plan), to add to `## Setup commands` for a later run; in auto mode too, in chat. The user answers "ok" or edits in words ("drop 3", "add: a lapsed paid user cancels", "T2 on mobile too"). Apply the edits to `<run folder>/charters.json`, and record them in `brief.md` under `## Charter edits`, never under `## Added at approval`. Every run profile must keep a charter: if one lost its last, say which and ask. Repeat until "ok".

Then, when a charter has `groundwork`, ask once: one line per such charter, then the question:

```
T1 needs 9 invites sent today from a new Free org first.
May explorers reach that state by a shortcut and test only the last steps in the browser? Answer yes, no, or the charter ids to allow.
```

In `charters.json`, write `"shortcut": true` into each charter the answer allows, and `"shortcut": false` into the other charters with `groundwork`. Nothing is explored before that.

## 3. Explore

1. Check that `## Evidence` has a line other than `none` for every target the charters use. If not, follow the evidence skill's `SETUP.md` for those targets (defaults mode on a quick start).
2. For each charter, dispatch a fresh subagent with exactly this prompt, filled in. In Claude Code, when the charter's driver runs from the shell (its target's `driver.shell` is `true` in `<run folder>/targets.json`) and the `evident:evident-explorer` or `evident-explorer` agent type is listed, use that type: it carries only Read and Bash, which cuts each turn's cost by about three quarters, and its guard keeps tokens out of files outside the run folder.
   ```
   Read <skill directory>/EXPLORER.md and follow it.
   Run folder: <run folder>
   Project folder: <project folder>
   Evidence directory: <evidence directory>
   Charter: <charter id>
   Session id: <charter id, or <name>-<charter id> when the request names a browser session name>
   Code path: <app repo, or none>
   Commit: <the value from the evidence skill's `## For calling skills` step 4>
   Evidence log: evidence-<charter id>.jsonl
   ```
   Each explorer logs to its own file, also when they run one at a time, so the evidence check can split the run into batches; this is the `Evidence log:` line `PARALLEL.md` names. Blind charters first, then lead charters once every blind one has returned. One at a time, unless `<evidence directory>/PARALLEL.md` allows parallel. Dispatch every explorer in the foreground and wait for its report, never in the background, in parallel too: a headless run ends when your turn ends, with the explorers unread. Send parallel explorers together in one message, in waves: a wave holds one charter per profile (every profile's first charter in the first wave), and the next wave starts once the whole wave has returned, so start.mjs shows each later charter what the earlier ones did and found.
   Before the first dispatch, and each time a batch of explorers returns (one that crashed or stopped on a blocker too), close the run's sessions as the evidence skill's `## For calling skills` step 6 says.
3. If an explorer reports a blocker (dialog, rate limit, app down), clear it or ask the user, never by changing the app's code, then dispatch that charter once more. If an explorer is waiting on its own background work (a timer, a sleep), tell it to stop waiting, log what is left as not covered, and return. An explorer that crashed or returned under its budget: run `node <skill directory>/scripts/step.mjs <run folder> <charter id> --left`. When it names a viewport or heuristic with no step and the explorer named no blocker, dispatch that charter once more, with the same prompt: it continues from its log and runs only what is left. Else never retry it.
4. With a `Batch: <n>` line: before each dispatch, run `node <evidence directory>/scripts/new-bug.mjs <run folder> --list`. At `n` or more bugs, dispatch no more charters. With an `Until:` line, dispatch none past that time.
5. In `charters.json`, add to each charter `"notCovered"`: its explorer's `Not covered:` line, or `"not run: batch full"` (`"not run: time"`) for a charter you did not dispatch.
6. Explorers can file one failure twice, under different titles, also when they run one at a time. Run `--list` once more, and for each bug whose title and `actual` show the same failure as an earlier one, run `node <evidence directory>/scripts/new-bug.mjs <run folder> --duplicate <BUG-NNN> <earlier BUG-NNN>`. Mark nothing you are unsure of.

## 4. Report

1. Do the evidence skill's `## For calling skills` step 6 (close the sessions), then step 5; in its join, join every explorer's `evidence-<charter id>.jsonl`, in the order they ran, never a session twice.
2. Run `node <show-your-work directory>/scripts/build-proof.mjs <run folder>`. It checks every capture, writes the step's `result.json` and the request's `report.html`, the bug report, and prints the chat summary. Fix a `Problem:` line that names a broken data file (a broken JSON line, a wrong path), and run it again. A `not checked` line: dispatch one more checker for each log those lines belong to, as the evidence skill's step 5 says, join again and run it again. Never edit `report.html`, `result.json`, `evidence.jsonl`, `evidence-check.jsonl` or `environment.md` by hand, and never change a bug's evidence. A `check says mismatch` line stays: show it. A bug whose own picture the check contradicts shows as not confirmed and is not counted.
3. Show two lines and nothing more: the summary's first line and its `Open:` URL. The page holds the bugs, questions, evidence problems and what each charter covered; never repeat them in chat.
4. Release the lock (`node <show-your-work directory>/scripts/run-folder.mjs --release <project folder>`) and stop. Never fix the app, offer a fix or start one.

## Auto mode

Only when the run is in auto mode. Read `<show-your-work directory>/AUTO.md` fully. Its rows hold here too, but where a row here and an `AUTO.md` row differ, this one wins. Below are only bug-bash's own rows.

| Where | In auto mode | Kind |
|---|---|---|
| §1 step 1: input too thin to aim at a feature | Stop: `Stopped: auto mode needs the change's intent in the request. Run again with what to explore.` | hard stop |
| §1 step 4: first-run profiles | Use the defaults. Propose none. Write nothing to Preferences. Record it as a default. | default |
| §2: charters | Approve them as written once every run profile has a charter. Write `"approvedBy": "auto"` into `charters.json`. Record it in `decisions.md` as `Ruling: default: `. Show the view in chat and go on. A run profile with no charter: stop with `Stopped: auto mode found no charter for profile <id>. Run again in ask mode.` | default / hard stop |
| §2: a charter has `groundwork` | Ask nothing. Write `"shortcut": true` into each such charter. Record it in `decisions.md` as `Ruling: default: `. | default |
| §3 step 1: evidence missing for a charter's target | Follow the evidence skill's `SETUP.md` auto mode line, as `AUTO.md` says. | default |
| §3 step 3: an explorer reports a blocker | Ask nothing. Dispatch that charter once more. Still blocked: it ends blocked, and §4 says why. | rule |

