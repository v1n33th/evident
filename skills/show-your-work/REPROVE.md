# Re-prove mode

"re-prove run <folder>" proves the approved claims of an earlier run again on the current code, without approval. Section and step numbers refer to `RUN.md` and `PROOF.md`.

1. Do `RUN.md` steps 1 and 3, with kind `proof`, the feature from the old run's `claims.json`, and the old run's request folder (the folder above it): the new run is the next `proof` step there, so the folder keeps the whole story. With no run of that folder holding it, `--in` takes the lock; on `Lock: held by`, do as `RUN.md` step 3 says.
2. Copy the old run's `claims.json`, and its `brief.md` (in the old run, else in the folder above it), into it. Do not change them. If `approvedAt` in `claims.json` is null, stop: tell the user that run was never approved, and offer a normal run (auto mode: `## Auto mode` below).
3. The ledger dir is `<project folder>/ledger/`.
4. Skip `SKILL.md` §2 (the claim writer and the code check) and `PROOF.md` §1. Do `PROOF.md` §2 and §3.
5. `--ledger` leaves each claim a later run reworded or retired as it is, and prints `Kept: <id> changed since this run`: show those lines, so re-proving an old run never rolls the ledger back.

## Auto mode

Only when the run is in auto mode. Re-prove already runs without approval. In auto mode it follows every `AUTO.md` row for the steps it runs (`RUN.md` steps 1 and 3, `PROOF.md` §2 and §3), plus the row below. A re-prove keeps each claim's `approvedBy` as it is.

| Where | In auto mode | Kind |
|---|---|---|
| Step 2: the old run was never approved | Stop: `Stopped: run <folder> was never approved, so auto mode cannot re-prove it. Run a normal proof instead.` | hard stop |
