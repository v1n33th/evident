# Approve, prove and report

Both `show-your-work` and skills built on it follow this file after the claims are written. In this file, `<skill directory>` is the absolute folder that holds it; the terms are in `RUN.md`, next to it.

## 1. Approve

Nothing is tested before the user approves (auto mode: `AUTO.md`).

1. With areas, have the user approve the area list first, then each area's claims in turn.
2. Ask the user to answer "ok", or to edit in words: "drop 6" or "drop C6", "make 3 routine", "test 2 on mobile too", "add: deleting an org removes its invites".
3. Apply the drops, re-ranks, viewport changes and rewording the user dictates to `claims.json` yourself. Record each drop and addition under `## Added at approval` in `brief.md` as its template says, adding the section if it is missing. For an added claim, dispatch the writer again with the prompt you used. If the user added or reworded a claim, dispatch the code check again, if your run uses one.
4. Run `--plan` again and show its output verbatim. Repeat until the user says ok and it prints no `Problem:` line.
5. Then run `node <skill directory>/scripts/build-proof.mjs <run folder> --approve --by <user|auto>`.

## 2. Prove

1. Check that `## Evidence` has a line other than `none` for every target the approved claims use. If not, follow the evidence skill's `SETUP.md` for those targets.
2. Group the claims into sessions. Leave out retired claims, and claims whose `proof` starts with `will not`.
   1. Split by `target`, as each claim has it in `claims.json`. Never move a claim to another target because of what its cases do.
   2. Within a target, split by account: the `## Accounts` key the `given` names, or the key whose role and plan it names ("a new account of the same kind as `free-owner`" and "owner of a new Free org" are both `free-owner`). A setup command or a new account does not start a group of its own.
   3. Within an account group, split by `area` (claims with no area are one area), with claims of the same `given` next to each other: a session signs up and builds its setup once, then checks claim after claim on it. A claim whose `given` needs a state the others would spoil or cannot share (at a limit, an empty list, a full library) goes apart, with its area's other such claims. Split each into the fewest sessions of at most the target's `sessionCases` in `<run folder>/targets.json` (its definition's `session-cases`), near-equal in size (22 cases at 10: 8, 7 and 7). Within a session, claims whose cases change what later claims rely on (fill a list to its limit, delete or replace a default) go last. When the target has viewports (`viewports` is `true`), count a case once per viewport. Keep a claim's cases in one session, even past the cap. Each session pays its own setup (a sign-up, a sign-in) and two of your turns. The group's claims whose `given` names the account key itself, not a new account of its kind, share that account and so run one at a time (`PARALLEL.md`): put them apart from the others, in as few sessions as possible across areas, at most 12 cases each: this wins over the split by area, as each such session waits for the one before.
   4. Number the sessions in that order. Name each `<NN>-<target>-<account key>`, for example `01-web-free-owner`.
3. For each session, write `<run folder>/sessions/<session-id>.claims.json` with `node <skill directory>/scripts/build-proof.mjs <run folder> --session <session-id> <claim ids>`, never by hand.
4. For each session, dispatch a fresh subagent with exactly this prompt, filled in. In Claude Code, when it lists the `evident:evident-prover` agent type (the evident plugin's) or `evident-prover` (evident's `setup` installs it), use that type. When the session's driver runs from the shell (its target's `driver.shell` is `true` in `<run folder>/targets.json`) and `evident:evident-prover-shell` or `evident-prover-shell` is listed, use that one instead: it carries only Read and Bash, which cuts each turn's cost by about three quarters.
   ```
   Read <skill directory>/PROVER.md and follow it.
   Run folder: <run folder>
   Project folder: <project folder>
   Skill directory: <skill directory>
   Code path: <app repo, or none>
   Commit: <the value from the evidence skill's `## For calling skills` step 4>
   Target: <the target's name, as targets.json lists it>
   Target file: <its files.target in targets.json>
   Driver file: <its files.driver in targets.json, or none>
   Session id: <session-id>
   Session name: <session-id, or <name>-<session-id> when the request names a browser session name>
   Claim ids: <claim ids, comma-separated>
   ```
   When the target's `files` are missing (a step made before them), take each path from `node <evidence directory>/scripts/definitions.mjs <project folder> --show target|driver <name>`, which prints it first. When `<evidence directory>/PARALLEL.md` allows parallel, send its parallel sessions in waves of at most 5, each wave in one message and the next once the whole wave has reported: more at once trip the app's per-address sign-up and sign-in limits. Else one per message, each after the one before has reported.
   Before the first dispatch, and each time a batch of provers returns (one that crashed or stopped on a blocker too), close the run's sessions as the evidence skill's `## For calling skills` step 6 says.
5. If a prover reports a blocker (dialog, rate limit, app down), clear it or ask the user (auto mode: `AUTO.md`), never by changing the app's code, then dispatch that session again: the same prompt with the same session id, whose `sessions/<session-id>.claims.json` already exists, and only the blocked claims' ids. Never a new session id. A case still blocked stays not proven. A case blocked as `expect names nothing exact`, `needs setup: ...` or `needs fixture: ...` is a problem of its claim, which a retry cannot clear: never dispatch again for it. Dispatch a session again only here, before Check.

## 3. Report

1. Do the evidence skill's `## For calling skills` step 6 (close the sessions), then step 5; in its join, join each prover session that has an `evidence-<session id>.jsonl`, never a session twice.
2. Run `node <skill directory>/scripts/build-proof.mjs <run folder>`. It checks every capture, writes the step's `result.json` and the request's `report.html`, and prints the chat summary.
3. When a `Problem:` line names a line that does not parse as JSON, fix only that line's quoting or escaping, in the file it is in (`sessions/<id>.jsonl`, or `evidence-<id>.jsonl` before the join), and run it again. If that file was already joined, delete `evidence.jsonl` and do the join in `PARALLEL.md` again. Change no value: a `sha256`, `at`, `file`, `result`, `actual` or `note` that is wrong or missing stays as it is, and its case stays not proven. Never compute a hash or a time for a tester. Never edit `report.html`, `result.json`, `evidence.jsonl` or `evidence-check.jsonl` by hand, and never add or edit evidence. A `check says mismatch`, `check says not shown`, `contradicts the note`, `capture failed`, `without evidence`, `without visual evidence` or `without a recording` line is not fixed: the case stays not proven.
4. Show two lines and nothing more: the summary's first line and its `Open:` URL. The page holds the checks, bugs, questions and evidence problems; never repeat them in chat.
5. With no ledger dir, skip this step. Run `node <skill directory>/scripts/build-proof.mjs <run folder> --ledger <ledger dir>` (auto mode: `AUTO.md`). Show its `Kept:` and `Problem:` lines verbatim. A `Problem:` line means it wrote nothing: a feature file with git conflict markers is the user's to resolve (each claim is one line: keep the lines they want, delete the marker lines), then this command runs again. Else tell the user that the ledger in `<ledger dir>` changed and is not committed: they commit it with their change.
6. Stop there. Never fix the app, never offer a fix and never start one.
