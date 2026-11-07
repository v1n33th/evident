# Test environment: acme-acme-invites

## Target
- Environment: local
- App: http://localhost:4173
- Also allowed: http://localhost:4174/mail
- Never open: http://localhost:4174/admin, tests/fixtures/answer-keys/
- Health: http://localhost:4173/api/health
- Code: <repo>

## Targets
- Web: http://localhost:4173
- API: http://localhost:4173/api, auth: bearer token (`Sign in` under `## Accounts` says how to get it)
- CLI: `node <repo>/cli.mjs`, working folder: <work> (pass the token with `--token <token>`)

## Browser
`agent-browser --no-auto-dialog --session <app-name>-<session>`
`<session>` and `<app-name>` are filled per session (the evidence skill's `CAPTURE-web.md`).

## Evidence
<written by the evidence skill's setup>

## Accounts
| key | purpose | email | password | role |
|---|---|---|---|---|
| free-owner | owner of the Free org QA Free | free-owner@acme.test | Passw0rd! | owner |
| free-member | member of QA Free | free-member@acme.test | Passw0rd! | member |
| pro-owner | owner of the paid org QA Pro | pro-owner@acme.test | Passw0rd! | owner |
| pro-member | member of QA Pro | pro-member@acme.test | Passw0rd! | member |

New accounts: qa+<unix-time>@acme.test
Sign in: setup login
Sign out: clear cookies

## Emails
`GET http://localhost:4174/mail` lists sent emails, newest first, as JSON (to, subject, body, links).

## Setup commands
Commands testers may run to reach a starting state the UI cannot reach. Testers run only these, with only the placeholders filled in, only where "allowed on" lists the environment. Run them in <repo>.
| key | does | command | allowed on |
|---|---|---|---|
| login | prints a bearer token, a session cookie and a one-time sign-in link for an account | `node admin/login.mjs {account}` | local |
| new-org | signs up a new account in a new org on a plan (free or pro) and prints its credentials | `node admin/new-org.mjs {plan}` | local |
| set-plan | sets an org's plan (free or pro) | `node admin/set-plan.mjs {org} {plan}` | local |
| seed-invites | adds invites to an org without sending email | `node admin/seed-invites.mjs {org} {count}` | local |

## Rules
- Do not run `node admin/reset.mjs`: it wipes every session's data.
- Never read `tests/fixtures/answer-keys/`.

## Preferences
- Viewports: desktop 1440×900, tablet 768×1024, mobile 390×844 (device: iPhone 14) (the first is primary; a device is emulated where the browser tool can)
- Profiles: default (used by exploring skills: `default`, `all` or profile ids)
- Mode: ask
- Parallel: yes

## Gotchas
- The app keeps its data in memory: restarting the server restores the seed.
