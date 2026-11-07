# Claim writer: change mode

`CLAIMS.md` sends you here. Section numbers refer to it; §1 is here.

## 1. Ledger

Select the ledger before you write (`CLAIMS.md`, Inputs). For each earlier claim it prints:

- Copy it with its id, `"rank": "routine"`, `"fromLedger": true`, `"status": "active"`, `"changed": null` and `"check": null`. Leave out its `verdict`.
- If the brief or the change alters its behaviour on purpose, propose it as changed, and write it whole as a claim of this run (with `proof` and `source`): new `statement`, `"status": "changed"` and `"changed": {"from": "<old statement>", "at": "<YYYY-MM-DD>", "why": "<where it came from>"}`. `why` is `your words: "<the brief's words that ask for it, verbatim>"`, or `the code only: <commit> <file>` when the brief does not ask for it. If the behaviour is gone, propose it as retired: `"status": "retired"` and a one-line `retiredReason`.
- Check its `given` against this change and your new claims. If the app now refuses the state it starts from, write a given the UI still reaches, or set `setup` and `proof` by §7. If no user can reach that state any more, propose it as retired.

New claims take ids C1, C2, ... after this run's highest; approval gives them their ledger ids.

## 5. Required claims

Add these whenever they apply, except when the diff command is `none`:
1. For every limit: attempts the app refuses do not use it up.
2. For anything removed or restricted: what existing users (paid, trial, lapsed, old data) now see.
3. For every new endpoint or screen: another organization, or a user without the permission, is refused.
