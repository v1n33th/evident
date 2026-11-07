# Test environment: <app name>

## Target
- Environment: local | shared (staging, QA) | preview
- App: <url>, or "ask each run" (preview deploys)
- Also allowed: <other hosts the flows use: admin, API, sign-in, payment>, or none
- Never open: <production and any URL testers must not touch>
- Health: <URL or command that shows the app is up> (default: App)
- Code: <path to the source, at the version the target serves>, or none
- Production: <branch or tag production builds from>, or unknown
- Restart: <command that restarts the app on changed code, from the user's words>, or none (the app reloads changed code itself)

## Targets
One line per target, `- <name>: <address>`, with a target definition's `address` setting as the name (the evidence skill's setup lists them).
- Web: <App above>, or none
- API: <base URL>, auth: <bearer token, cookie or none; `Sign in` under `## Accounts` says how to get it>, or none

## Drivers
<one line per driver in use, `- <driver>: <command with flags>`, written by the evidence skill's setup, for example `- agent-browser: agent-browser --no-auto-dialog --session <app-name>-<session>`>
`<session>` and `<app-name>` are filled per session (the web target's `## Connect`). An older `## Browser` section, the web driver's command, is still read.

## Evidence
<written by the evidence skill's setup: one line per target, `- <label>: <methods> · driver: <name>`>

## Accounts
| key | purpose | email | password | role |
|---|---|---|---|---|

Plans: <each plan or account type testers may test on, and how to reach it: a key, new accounts or a setup command (for example `free: new accounts; pro: pro-owner; trial: set-plan {org} trial`)>, or none
New accounts: <email pattern the team can read, for example qa+<unix-time>@company.com>, or not allowed
Sign in: form <sign-in URL> (default: the app's own sign-in page) | email code | email link | setup <key> (a setup command that takes an account key and prints a sign-in link, cookie or token) | SSO <test sign-in host>
Sign out: <a menu item or URL>, or clear cookies

## Emails
<how to read emails the app sends, for example a Mailpit or MailHog API>, or none

## Setup commands
Commands testers may run to reach a starting state the UI cannot reach. Testers run only these, with only the placeholders filled in, only where "allowed on" lists the environment.
Where the feature has a day or time boundary (a daily limit, an expiry), add one that back-dates, for example `seed-invites {org} {count} {hoursAgo}`: testers never wait for the clock. One that adds a new member to an org spares the named member accounts.
| key | does | command | allowed on |
|---|---|---|---|

Fixtures: <folder of real input files testers may upload, such as a camera photo or a PDF a named app made>, or none

## Rules
<what testers must not do here, for example: no real payments, do not delete shared records, name created data "QA ...">

## Preferences
- Viewports: desktop 1440×900, tablet 768×1024, mobile 390×844 (device: iPhone 14) (the first is primary; a device is emulated where the driver can)
- Mode: ask (ask or auto; "--auto" in a request turns it on for one run)
- Parallel: no (yes lets auto mode run sessions in parallel when PARALLEL.md's conditions hold)
- Profiles: default (used by exploring skills: `default`, `all` or profile ids)
- Passes: blind (bug-bash: `blind` runs blind testers only; `both` adds testers who try the planner's suspects after them; `leads` runs only those)
- Rounds: 1 (fix-and-prove's self-improvement rounds)
- Batch: 30 (bugs per round before fix-and-prove fixes them)
- Explore time: none (minutes each explorer may take; none runs every charter's full step budget, a number stops explorers earlier and finds fewer bugs)
- Auto fixes: very-high (in auto mode, the highest risk fix-and-prove fixes without asking: low, medium, high or very-high)
- Gaps: yes in auto mode and self-improvement, else no (yes or no: build missing pieces, only by adding)
- Fix commits: current branch (current branch, none or new branch)

## Gotchas
<a login wall in front of the app (deploy protection, basic auth) and how to pass it, rate limits, seed data>
