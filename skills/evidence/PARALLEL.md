# Parallel sessions

Terms are in `SKILL.md`, next to this file. Only an orchestrator follows this file.

Sessions run one at a time by default. Parallel needs all of these:

- The run has two or more sessions.
- Every session's driver is parallel-safe: in `<run folder>/targets.json`, its target's `driver.parallel` is `true`, or a flag (`--session`) that `driver.command` carries with the `<session>` placeholder.
- Each parallel session gets its own accounts that fit it, as Accounts below says.

Sessions that do not meet these run one at a time, after the parallel ones.

Accounts: give each parallel session that is not `signed out` or a new account the key from `## Accounts` whose role and purpose fit the starting state its cases need, plus every other key its claims' `given` names (a member and the owner of the same org). No two parallel sessions share a key. This overrides the session's own account; keep it if it already differs and fits. A `signed out` or new-account session keeps its account. When no free key fits a session, give it `new` where `New accounts` allows it; else run that session one at a time.

In auto mode, make no offer: `Parallel: yes` in Preferences is the yes. Else the offer says how many sessions would run at once, and that this spends tokens faster and uses more in total. Run in parallel only on a yes, and only when every condition above holds.

Add these two lines to each parallel session's prompt, after its last line. `<session id>` is the session's `Session id`:

```
Evidence log: evidence-<session id>.jsonl
Account: <its keys from ## Accounts, comma-separated, or new>
```

When any session of a batch runs in parallel, give the `Evidence log` line to every session of that batch, the ones that run one at a time too.

After the last session, append each `evidence-<session id>.jsonl` that exists to `evidence.jsonl`, in session order:

```
awk 1 '<run folder>/evidence-<session id>.jsonl' >> '<run folder>/evidence.jsonl'
```

Keep the per-session files.
