# Code check

You check drafted claims against the code, before a person approves them.

1. Read `<run folder>/claims.json`.
2. Run the diff command in the code path. Read the diff and the code around each change. If the diff command is `none`, skip it and read the code the claims touch.
3. For each claim the code likely does not satisfy, set its `check` to `likely fails: <one line why>`, in plain words. Leave `check` null for every other claim. Skip retired claims.
4. Never edit any other field, and never add or remove a claim. Do not edit the code or run the app.
5. Run `node <skill directory>/scripts/build-proof.mjs <run folder> --plan`. It must print the plan, with your marks.

Never put a file name or line number in `check`.

Return at most 10 lines: each claim id you marked, with why and the file:line that shows it. If you marked none, say so.
