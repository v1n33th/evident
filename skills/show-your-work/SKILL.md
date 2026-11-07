---
name: show-your-work
description: 'Use when the user asks to prove, verify or QA a change, commit or pull request in the running app (web, API, or a target you define), wants evidence a person can check that it works before merging, says "prove my changes", "show it works" or "proof of work", asks to prove bugs an exploring run found (for example once they are fixed), asks to re-prove run <folder>, or answers a question a run asked ("answer Q-1a2b: ...").'
license: MIT
compatibility: Needs an agent that can start subagents, Node.js 18+, git, the driver your target's definition names, and the evidence skill installed next to this one.
---

# Show your work

Turn a change into claims of what is now true for users, have the user approve them, then have blind testers prove or disprove each claim with evidence.

**Core rule: testers get only the claims.** Subagents do all the work. Their prompts hold only the dispatch lines below, plus the two lines `PARALLEL.md` adds. Provers get only each claim's test fields (what `--session` writes): never its source, its code-check mark, the diff or the code. Never add your own notes, suspicions or implementation details to any prompt, to `brief.md` or to a claim. The writer writes every claim. You edit `claims.json` only as `PROOF.md` §1 step 3 says.

For "re-prove run <folder>", read `<skill directory>/REPROVE.md` and follow it instead of the steps below.

## Terms

- **Skill directory**: the absolute folder that holds this `SKILL.md`.
- Run terms are in `RUN.md`: read them before §1.
- **Auto mode**: on when the request says `--auto` or `auto mode`, or `<project folder>/environment.md` Preferences say `Mode: auto` (read that line before §1); `--ask` or `ask mode` turns it off. When on, read `<skill directory>/AUTO.md` and `## Auto mode` below first, and follow them wherever a step asks the user.

## 1. Set up

1. Input. By default: the app repo's changes against its merge base with the main branch (ask if unclear), plus untracked files. Diff command: `git diff <merge base> -- . ':(exclude,glob)**/.evident/**' && git ls-files --others --exclude-standard -- . ':(exclude,glob)**/.evident/**'`, or with no merge base (a new repo, no main branch) `git diff HEAD -- . ':(exclude,glob)**/.evident/**' && git ls-files --others --exclude-standard -- . ':(exclude,glob)**/.evident/**'` (evident's own folder is never part of the change). A named commit: `git diff <commit>~1 <commit>`. A range ("the last 3 commits"): `git diff <from> <to>`. What the user names to prove ("prove that checkout with a coupon works") is input too, with or without a diff; with only their words, the diff command is `none`. Bugs an `bug-bash` run filed are input too ("prove BUG-002 of <run folder>", "prove the bugs of <run folder>"): the diff command is `none` unless a change is named as well, and the writer's prompt gets a `Findings:` line with each bug folder. A claim from a bug says what a user should see, so proven means the bug no longer happens. With no changes and no commit, words or bugs named, ask which commit or behaviour to prove.
2. If the input is too thin to write claims, ask what the change is meant to do. "Prove my changes" with no request for the change in this conversation is too thin. Never fill a gap from the code or your own guesses.
3. Follow `<skill directory>/RUN.md` with kind `proof`.

## 2. Claims

Dispatch one subagent with exactly this prompt, filled in:

```
Read <skill directory>/CLAIMS.md and <skill directory>/<CLAIMS-findings.md when bugs are the input, else CLAIMS-change.md> and follow them.
Run folder: <run folder>
Project folder: <project folder>
Skill directory: <skill directory>
Code path: <app repo>
Diff command: <diff command>
Ledger dir: <ledger dir>
Findings: <bug folders, comma-separated; only when bugs are the input>
```

If it returns `too big: propose phases <list>`, show the phases and ask which to prove first. Add the user's answer to `## To prove` in `brief.md`, verbatim, and dispatch the writer again.

Then dispatch a second subagent with exactly this prompt, filled in:

```
Read <skill directory>/CODE-CHECK.md and follow it.
Run folder: <run folder>
Skill directory: <skill directory>
Code path: <app repo>
Diff command: <diff command>
```

Run `node <skill directory>/scripts/build-proof.mjs <run folder> --plan` and show its output to the user verbatim, `Problem:` lines included.

## 3. Approve, prove and report

Follow `<skill directory>/PROOF.md`.

## Answering a question

When the user answers a question a report or chat summary asked ("answer Q-1a2b: per org"), find the project folder as `RUN.md` step 1 does (`project.mjs` only), then run `node <skill directory>/scripts/questions.mjs <project folder> <Q-id> <their answer, verbatim>` and show its lines verbatim. A message pasted from the report's Copy answers holds one `answer <Q-id>: ...` line per question: run the command once per line, in one call. Its `decide BUG-NNN of ...` lines are fix-and-prove's: follow `<skill directory>/../fix-and-prove/SKILL.md` `## Decisions from a page` for them. Do nothing else: the feature's next explore and proof read the answer. Never answer a question yourself, in any mode. On `Problem: no question`, say so and ask for the id again.

## Auto mode

Only when the run is in auto mode. `AUTO.md`'s rows hold here too.

| Where | In auto mode | Kind |
|---|---|---|
| §1 step 1: merge base unclear | The merge base with `main`, else `master`. A repo with no branch but the current one: `git diff HEAD`, as §1 says. Other branches but neither `main` nor `master`: stop: `Stopped: auto mode found no main or master branch to diff against. Run again naming the commit or range to prove.` | rule |
| §1 step 1: no changes, and no commit or behaviour named | Stop: `Stopped: auto mode needs a change, a commit or the behaviour to prove. Run again naming one.` | hard stop |
| §1 step 2: input too thin to write claims | Stop: `Stopped: auto mode needs the change's intent in the request. Run again with what the change is meant to do.` Never fill the gap from the code. | hard stop |
