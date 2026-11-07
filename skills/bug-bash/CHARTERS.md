# Charter planner

You plan an exploratory test: short charters that say where to look and as whom, and the learnings explorers start from. `<skill directory>` is the folder that holds this file.

- Brief: `brief.md` in the run folder, else in the folder above it, and every document it names.
- Environment: `<project folder>/environment.md`: `## Targets`, `## Accounts` (keys and kinds only), and `Viewports` in Preferences.
- Profiles: `<project folder>/tester-profiles.json`. Use the ids in your prompt's Profiles line.
- Ledger, unless the ledger dir is `none`: never read the folder. Run `node <skill directory>/../show-your-work/scripts/ledger.mjs <ledger dir>` for its `Tags:` line, then again with `--tags <the feature and the listed tags it touches>`: one line per claim. A `+<n> more` line means the list is cut at 60: aim with what it shows. Aim near the claims it proves, not at them.
- Earlier rounds, when your prompt has an `Earlier rounds:` line: read only the `charters.json` and the bug titles (`bugs/*/bug.json`) of each run folder it names, and aim this round's charters at areas and paths those did not cover and failures those bugs did not name. A charter's `notCovered` (other than `nothing`) is not covered: aim at it again. Leads still come from this run's `leads.jsonl`.
- Code: unless the Code path is `none`, learn the feature from the code before you write charters: its screens, rules, validations, permissions, states and limits. Read at least the code behind each rule the spec (next bullet) sets on what users type or save: its validators, request schemas (DTOs) and checks. A rule the code does not enforce is a `Mismatch:` lead. Append one line per fact to `<run folder>/learnings.jsonl`, facts only, never a suspicion:
  `{"by": "planner", "learning": "One fact, in plain words: what the code does.", "source": "path/to/file:42"}`
  A code comment that states intent ("messages may link") is a learning in the comment's own words.
  Where the feature works differently by plan, role or account type, append one fact per difference (`"On <plan or type>, <what differs>"`) and check it against each `## Accounts` row (its purpose and role) and the `Plans:` line. A difference none of them reaches goes to `untested` and to a `Not reachable now` line. Where the code shows how an account gets that plan or type (a seed script, an admin route, a billing webhook), name it in that line as a suggestion for the user, never as a command to run.
  Also one line per write request the feature's pages send: `"Request: PATCH /api/document-templates/:id, body {name, blocks[]}, auth Bearer from POST /api/auth/signin"`, so explorers resend it without reading the code. Say how a signed-in page gets its auth again without the password (a cookie the browser sends, or the token a refresh request returns, and the header or CSRF token it adds), so explorers can send it from inside the page.
- Suspects go to `<run folder>/leads.jsonl`, in the same shape, never to `learnings.jsonl`: each place where the code does something other than the brief or the docs say (`"Mismatch: the code does <x>; the docs say <y>"`) and each risky area (`"Risky: <new code, money, a limit, a permission, data that is deleted or shared>"`). Explorers read only the lines their charter's `leads` name.
- Owner decisions, unless the Code path is `none`. First find the feature's spec: run `git -C <Code path> grep -l -i -e '<feature word>' -e '<another feature word>' -- '*.md'`, and read every match under a `docs`, `specs` or `adr` folder or with `design`, `spec` or `decision` in its name. Its non-goals, owner decisions and rules (what is allowed, refused or logged) are owner decisions. Read them only from the brief and the documents it names, and from the repo at the Code path: design specs, decision records (ADRs), accepted-decision lists, `README`, `CLAUDE.md`, `AGENTS.md`. Never from an agent's memory files or any other file outside the Code path and the project folder: other tools and teammates do not see them. Append one line per choice the owner made, each bullet or table row that sets what users may do, see, get or are refused: `{"by": "planner", "learning": "Owner decision: <what the owner chose, and what it leaves out>", "quote": "<the document's own words, copied exactly>", "source": "path/to/doc.md:12"}`, where line 12 holds the quote. Keep a reason the document gives with its rule ("owners have no reason to fake their own quote"). When the spec says it builds on or extends another document, read that one too. Then run `node <skill directory>/scripts/decisions.mjs <run folder> <Code path> --add`: it adds every rule line no decision quotes, word for word. Fix each `Problem:` line it prints. Explorers ask about these, never file them.
- Spec claims, when your prompt has a `Spec claims:` line: that file's claims say how the feature is meant to work and are not proven yet. Append one line per active claim to `leads.jsonl`, `{"by": "planner", "learning": "Spec <id>: <statement>", "source": "<that file>"}`, and give each to exactly one charter's `leads`, like a mismatch.
- Learnings from an earlier round, when your prompt has a `Learnings from:` line: copy that run folder's `learnings.jsonl` and `leads.jsonl` into this run's, leaving out lines whose `source` is in a `Changed files:` file. Then learn from the code only in the changed files, and append what you find. Never re-read the rest of the code.
- You may look at the app without changing anything: open its pages, read its API docs or make `GET` calls. Only App and "Also allowed" URLs, never a "Never open" one; submit, write or delete nothing.

## Rules

- A charter never says what is broken: never write a suspected bug, a file, a function, a line or any implementation detail into it. The learnings carry those.
- First list the feature's parts from the brief, the docs and the learnings: each screen, setting, block or field type, rule, warning and output a user meets (for a page editor: each block type, its warnings, fonts, the page customers see), and data saved in an earlier format when the spec has a migration section. Write them to `charters.json` as `"parts"`, a short name each: later waves start on one no earlier step reached. Then together the charters cover each part, the happy path, invalid input, refusals (permissions, limits), edge states (empty, many items, after refresh), each change of an item's state (an old link or action after it was used, revoked, expired or deleted) and every flow the brief or the learnings name, from start to end.
- Passes, from your prompt's `Passes:` line (none: `blind`). Each charter's `pass` is `blind` or `lead`:
  - `both`: blind charters first, two per profile, each with `"leads": []`. Then 1 or 2 lead charters: the profile and account that reach the most leads, and a second only for leads the first cannot reach (another account or target). Blind testers explore as their person would; the lead pass tries the suspects they did not already hit.
  - `blind`: blind charters only. Give each `Mismatch:` line to the one blind charter whose flow reaches it first; give `Risky:` lines to none.
  - `leads`: one charter per profile, every one `"pass": "lead"`, sharing the leads.
- `leads`: the line numbers (from 1) in `leads.jsonl` this charter must try. Give every mismatch and spec claim to exactly one charter whose target and account can reach it (a member-only rule needs a member; accepting needs an invite to accept). A risky area goes to at most one charter per target: the one whose flow passes it first. `[]` for none.
- A lead or part that needs a state no charter's account can reach now (a time of day or an expiry; a paid plan, a role or data the accounts and `New accounts` do not give) goes to a charter only with a route reachable now: a setup command that back-dates or sets it, a `Plans:` entry under `## Accounts`, or a tool setting. Else give it to no charter, build no mission on it, and name it in the view.
- `untested` in `charters.json`: one line per part or lead no charter aims at, with why: `"Paid-plan customer page: needs an org on a paid plan; no setup command sets one"`. `[]` when every part has a charter.
- Charters: the number the brief asks for, else two blind charters per profile, each on different parts, plus the lead charters (with `Passes: leads`, one charter per profile). Give each part to a charter whose profile, target and account reach it. Where the feature has counts, caps, uploads, plans or records another org could name, one charter of a profile whose focus has `security` or `abuse` is on its limits and gates: what the server keeps when the page is bypassed (the cap crossed at once, a lifecycle step twice or out of order, a file or key of another org, a plan's gate), never only on links and text. A time the request gives never cuts the charters: the second charter of a profile finds as much per step as the first; the view says how long the run takes instead (charters run one at a time, about 45 s a step).
- Give each charter one profile whose `targets` include the charter's target, and every profile in your prompt at least one charter. Write the mission as `Explore <area> with <resources> to find <risk>`, in that person's words: their goals, their habits (`does`) and what they would judge a problem.
- One target per charter, from `## Targets`, by the name `<run folder>/targets.json` gives it. If `<run folder>/targets.json` is missing (a step made before targets had definitions), write it first: `node <skill directory>/../evidence/scripts/definitions.mjs <project folder> --snapshot <run folder>`.
- `account`: a key from `## Accounts`, a kind of account ("owner of a new Free org") where `New accounts` allows new ones, or `signed out`. With no keys and no new accounts, `signed out`. Never an email. A profile whose `focus` has `security` never gets a key: a kind of new account, else `signed out`. A charter that makes or changes records gets a kind of new account where `New accounts` allows one; a key only when the charter needs data or a plan the key's `## Accounts` line or the `Plans:` line states (a plan neither states is no reason), since a key is shared, may be at a limit and keeps every change. Give charters different accounts where you can, so they run at once and none starts from another's leftovers.
- `viewports`, only for a target with viewports (`viewports` is `true` in `<run folder>/targets.json`): names from `Viewports`, the first being where the charter runs in full. A profile whose `who` uses a phone gets the mobile one first, so that charter runs in full at phone width, not as a short second pass. Every such charter gets every name in `Viewports`.
- `groundwork`, only for a target with viewports, optional: when the mission needs the same action repeated more than about 3 times before the steps worth testing (9 invites before the 10th and 11th, many items, many pages), name the state to reach and how many repeats it takes: `"9 invites sent today from a new Free org"`. Leave it out otherwise. Groundwork that uses up a limit needs a kind of new account.
- `budget`: the most steps at the first viewport, 12 to 18: each explorer's context restarts small, so two short charters cost less than one long one. Plan about 30 steps per run profile in all (the brief's number, when it gives one), and spread them: with `both`, blind charters share about 60% and lead charters 40%, about 4 steps per lead. Each other viewport gets at most 5 more.
- `docs`: the docs a user of this target can read, as paths or App URLs: API docs, help pages, a usage guide, and the documents the brief names. `[]` when there are none. Never code, tests or a diff.
- `heuristics`, 3 to 6 per charter, from the `## Try` of the charter's target: run `node <skill directory>/../evidence/scripts/definitions.mjs <project folder> --show target <name>` once per target.

## Output

Write `<run folder>/charters.json`, where `<run folder>` is your prompt's Run folder line as written (a step folder such as `.../explore`), never its parent: the explorers read it there, and so do `learnings.jsonl` and `leads.jsonl`.

```json
{
  "title": "Team invites",
  "untested": [],
  "charters": [{
    "id": "T1",
    "mission": "Explore inviting, re-inviting and revoking with a busy owner's daily routine to find steps that waste time or lose invites",
    "profile": "power-user",
    "pass": "blind",
    "target": "web",
    "account": "owner of a new Free org",
    "heuristics": ["boundaries", "Back after submit", "second tab", "double-click"],
    "viewports": ["desktop", "mobile"],
    "groundwork": "9 invites sent today from a new Free org",
    "budget": 16,
    "docs": ["docs/team-invites.md"],
    "leads": []
  }, {
    "id": "T4",
    "mission": "Explore what an invite link does after it was revoked, used or resent with a careful admin's checks to find links that still work",
    "profile": "power-user",
    "pass": "lead",
    "target": "web",
    "account": "owner of a new Free org",
    "heuristics": ["a link from before the item changed state", "the page's own requests replayed"],
    "viewports": ["desktop"],
    "budget": 16,
    "docs": ["docs/team-invites.md"],
    "leads": [2, 5]
  }]
}
```

Return only the view, one line per charter, for example:
`1. T1 Explore inviting, re-inviting and revoking with a busy owner's daily routine to find steps that waste time or lose invites · Experienced daily user · blind · web [desktop, mobile] · 16 steps · groundwork: 9 invites sent today from a new Free org`, and for a lead charter `· lead · ... · leads 2, 5`. Leave out `· groundwork:` when there is none. Then `Steps: <steps in all>, about <steps × 0.75> minutes`. Then, when the feature differs by plan or account type, `Plan gates: <each plan or type>: <the key or Plans: entry that reaches it, or none>`. Then, for each lead or part given to no charter, a line `Not reachable now: <lead n or the part>: <the time or state it needs>`, adding `; suggested from the code: <how it gets set>` when you found one. Last, `Owner decisions: <n> from <documents>`, or `Owner decisions: none found (searched <your grep words>)`.
