# Acme invites fixture

A small invites app with eight planted faults, used to test the show-your-work, bug-bash and re-prove skills end to end. `tests/fixtures/answer-keys/acme-invites.json` lists the faults; never put it where a tester can read it.

## Set up

```
tests/fixtures/acme-invites/setup.sh [folder]     # creates the scratch repo, prints its path
cd <folder>
node server.mjs                             # web + API on :4173, admin + mail on :4174
```

`setup.sh` also writes `environment.md` next to the folder (the scratch repo's parent) with `<repo>` filled in, and an empty `acme-work` folder beside it that testers use as the CLI's working folder, so CLI captures never list the repo's files. Switch builds with `git checkout main` (correct) or `git checkout next`, then restart `node server.mjs`. The app keeps its data in memory, so a restart restores the seed. `node admin/reset.mjs` wipes the data of a running server; the operator runs it between scenarios, testers never do.

Do not point testers at other branches. The branch named `next` is visible to anyone who runs git in the scratch repo.

Before each scenario, check out its branch, restart the server and (for the parallel ones) run `node admin/reset.mjs`. With the server running, `tests/fixtures/acme-invites/check-web.sh <branch> [scratch-repo]` (run it from the skills repo; the scratch repo defaults to the current folder) prints whether the Send button is visible at 360 px, the console error count and how many invites a double click makes: `no / 1 / 2` on `next`, `yes / 0 / 1` on `main`. It needs agent-browser.

## Results folder

Pick `<temp>/fixture-runs`; every request from S1 on carries the line `Evident folder: <temp>/fixture-runs` so fixture runs never mix with real ones. Run S0 first, in its own folder `<temp>/fixture-runs-s0`, so the `environment.md` its quick start writes never lands where S1 to S4 look. Then copy the fixture's environment file so the skills find it (S1 to S4 use it):

```
mkdir -p <temp>/fixture-runs/acme-acme-invites
cp <folder>/../environment.md <temp>/fixture-runs/acme-acme-invites/environment.md
```

Each request goes to a fresh session started in the scratch repo. Do NOT commit `proof/` in the scratch repo: leave it untracked so the ledger survives `git checkout main|next` and R1 can see S2's entry.

## Scenarios, in this order

| # | Branch | Request to type |
|---|---|---|
| S0 | `next` | `quick start: explore team invites at http://localhost:4173. Evident folder: <temp>/fixture-runs-s0` |
| S1 | `main` | `prove the last commit; the spec is docs/invite-limit.md. Evident folder: <temp>/fixture-runs`; when asked for the slug, confirm `invite-limit` |
| S2 | `next` | the same request as S1 (with its `Evident folder:` line), confirm the slug `invite-limit`, and answer yes to running sessions in parallel |
| R1 | `next` | `re-prove run <S1's run>. Evident folder: <temp>/fixture-runs` (after S2) |
| R2 | `main` | `re-prove run <S2's run>. Evident folder: <temp>/fixture-runs` (after R1, with `main` checked out and the server restarted) |
| S3 | `next` | full setup from the fixture's `environment.md`: `explore team invites; the spec is docs/invite-limit.md`, default profiles. Naming the spec puts it in the brief: the charter planner reads it, and explorers see its path in the request, which is the only way they can know the refusal should end "Try again tomorrow." `Evident folder: <temp>/fixture-runs` |
| S4 | `next` | `explore invites through the API`, profiles integrator, bad-actor. `Evident folder: <temp>/fixture-runs` |

A pass means (spec §8): S0 finishes with no questions beyond the test-environment one, writes `environment.md` and explores signed out. S1 proves every expected behaviour on web and API with every file `matches`. S2 disproves the claims P1 and P3 break, proves the paid-plan and refused-invite claims, and each parallel session used its own account. R1 skips the ledger step and names S2 as the later run. R2 proves what S2 disproved and the ledger takes it. S3 files at least 5 of P1, P2, P3, P4, P6, P8 and each is reproduced by a blind prover. S4 files P5 and P7, the bad actor used only new accounts, and every email went to the `New accounts` pattern except the attack addresses of the bad actor and of the provers of its bugs (the score lists them; read them).

## Auto scenarios

Run S1 to S4, R1 and R2 again in auto mode, in the same order and on the same branches, with the same setup and results folder. Each request ends `--auto`, and for S1 and S2 the slug is given in the request, so nothing is asked. S4 names its profiles: auto mode otherwise runs the default ones, and the opt-in bad actor never runs.

| # | Request to type |
|---|---|
| S1 | `prove the last commit; the spec is docs/invite-limit.md. feature: invite-limit --auto. Evident folder: <temp>/fixture-runs` |
| S2 | the same request as S1 (on `next`) |
| R1 | `re-prove run <S1's run> --auto. Evident folder: <temp>/fixture-runs` |
| R2 | `re-prove run <S2's run> --auto. Evident folder: <temp>/fixture-runs` |
| S3 | `explore team invites; the spec is docs/invite-limit.md --auto. Evident folder: <temp>/fixture-runs` |
| S4 | `explore invites through the API, profiles integrator, bad-actor --auto. Evident folder: <temp>/fixture-runs` |

Auto runs write the ledger with claims marked `approvedBy: auto`, so R1 and R2 see them as approved. Pass criteria are the ones above, plus: no question is asked, `decisions.md` is in each run folder, and the proof page shows the auto mode banner.

## Score

```
node tests/fixtures/score.mjs <run folder> --key tests/fixtures/answer-keys/acme-invites.json --scenario <id> [--requests <repo>/.acme/requests.jsonl] [--mail http://localhost:4174/mail]
```

It scores S1 to S4: verdicts against the key for S1 and S2, found bugs for S3 and S4. S0, R1 and R2 are checked by reading the run against the pass criteria above. `--requests` is needed for S2 (parallel sessions each used their own account) and S4 (the bad actor used only new accounts); `--mail` is also needed for S4.

Run it from the skills repo after the scenario. The script proposes matches; a person or a grader confirms them. Whether explorers read fixture code is checked by reading their transcripts.
