# evident

Coding-agent skills that test your app the way a person would, and show you the evidence.

| Skill | Ask for | What you get |
|---|---|---|
| **show-your-work** | "prove my changes" | A short list of claims about what your change does, proven or disproved by blind testers in the running app, with screenshots, GIFs or API responses for each |
| **bug-bash** | "explore team invites" | Testers who act as different kinds of users, and a list of bugs, each with evidence and what should have happened |
| **fix-and-prove** | "fix the bugs of <run folder>", "improve team invites" | Fixes for the bugs it is confident about, each proven blind in the running app; your call on the rest |
| **evidence** | (used by the others) | How testers drive the app (web, API, or a target you define) and capture evidence |

Tests tell the machine it works. Evidence shows a person it works.

## Install

Pick one. Each installs a tagged release, so you run the files you reviewed.

### Claude Code plugin

```bash
git clone --depth 1 --branch v0.1.2 https://github.com/v1n33th/evident ~/evident
```

```bash
claude plugin marketplace add ~/evident
```

```bash
claude plugin install evident@evident
```

The skills show up as `evident:bug-bash`, `evident:show-your-work` and so on. To upgrade, check out a newer tag in `~/evident` and start a new session.

### Claude Code skills folder

```bash
git clone --depth 1 --branch v0.1.2 https://github.com/v1n33th/evident ~/.claude/skills/evident
```

```bash
~/.claude/skills/evident/setup
```

`setup` links the four skills into `~/.claude/skills/`, writes five optional agents into `~/.claude/agents/`, and offers to let Claude Code read the skill files without asking each time. Start a new session afterwards. Use the plugin or `setup`, not both.

- `setup --remove` undoes it.
- `setup --agents <project>/.claude/agents` installs the agents for one project.
- `setup --model checker=haiku` runs a role (`checker`, `explorer`, `prover`, `fixer`) on a smaller model. Try the checker first.

### Codex

Clone as above, then:

```bash
~/.claude/skills/evident/setup --codex
```

### Other agents

```bash
npx skills add https://github.com/v1n33th/evident#v0.1.2 --skill '*'
```

Keep the four skills side by side: their scripts import each other's.

## Use

Start your app locally, open your coding agent in its repository, and ask:

```
prove my changes
```

```
prove that checkout with a coupon works
```

```
explore the team invites page as a first-time user on mobile
```

```
fix the bugs of .evident/team-invites/2026-11-01-0900-explore
```

```
improve team invites --rounds 3
```

The first run asks for your environment (app URL, test accounts, browser tool, how to read the app's emails, what testers must not touch) and saves it in `.evident/environment.md`. Later runs reuse it.

Never point it at production. Testers click everything, submit forms twice and confirm every warning.

## How each skill works

### show-your-work

1. **Claims.** A writer turns your diff, a commit you name or your own words into short claims: one sentence each, with cases and the evidence to capture. A separate agent marks claims the code likely breaks.
2. **You approve.** At most 7 headline claims. Answer "ok" or edit in words ("drop 6"). Nothing is tested before that.
3. **Blind proof.** Testers get only the claims, never the code. Each claim ends proven, disproved or not proven, with its evidence.
4. **Ledger.** Claims and verdicts go to `.evident/ledger/`, which you commit, so later changes re-check them.

`re-prove run <folder>` proves an earlier run's claims again on the current code.

### bug-bash

1. **Charters.** A planner learns the feature from the code and writes one mission per tester profile: a first-time user, a daily user, someone from a competing product, an API developer. Add a bad actor, a phone user or a screen-reader user with `Profiles: all`.
2. **Explore.** Testers run their charters at each viewport, log what they expect before each step, and file each bug with evidence.
3. **Report.** An evidence check opens every file, then the report lists bugs worst first.

A run of 8 charters takes about an hour on a mid-size feature.

### fix-and-prove

1. **Fix.** A fixer changes code only when it is confident: the cause is found, the fix is contained, nothing you designed changes, and the risk is low or medium. Everything else becomes a question for you.
2. **Verify.** Blind provers prove each fix in the running app and re-check the claims that held before. A fix that does not hold, or breaks something, is undone.
3. **Report.** One row per bug, from found to fixed to proven, with the patch, its risk and what users will notice. Pick an answer in a bug's "Your call" box, copy the answers, and paste them in chat.

Fixes are saved as patches and committed on your branch (`Fix commits: current branch`, `none` or `new branch`). It never pushes, deploys or runs a migration. One round takes about 30 to 50 minutes on a small feature; start it in a new session.

**Self-improvement** ("improve team invites --rounds 3") repeats explore, fix and verify on its own. It asks one question at the start (fix the pending bugs, or explore first), then runs in auto mode: it fixes up to `Auto fixes:` (very-high by default), builds missing features that only add, and lists every choice in the report, ready to undo. It stops early when a round has nothing to fix.

## Auto mode

Add `--auto` to a request, or `Mode: auto` to `environment.md`'s Preferences, and the skills decide instead of asking. Each decision goes in `decisions.md`, and the report marks everything approved by auto mode. It still stops where only you can decide, such as a missing environment or another run holding the lock.

## Where results go

```
<app repo>/.evident/
├── index.html          start here: what needs you, then each feature's latest run
├── ledger.html         every claim with its latest verdict
├── environment.md      URLs, accounts, passwords, preferences (git-ignored)
├── ledger/             one file per feature; commit it with your change
└── <feature>/<date>-<kind>/
    ├── report.html     the request's page, live while the run goes
    └── explore/ fix/ proof/ ...
```

`.evident/` ignores itself except the ledger and your own target and driver definitions, so passwords never reach git. Your `.gitignore` is never touched. Set `Evident folder: ~/work/qa` in `CLAUDE.md` or `AGENTS.md` to keep everything outside the repo.

## Make it yours

Everything below lives in your app's `.evident/` folder, so the team shares it. Put a file in `~/.evident/` instead to use it for every app.

### Add a tester profile

bug-bash copies its profiles to `.evident/tester-profiles.json` on the first run and tailors them to your product. Ask for a new one ("add a tester profile: an accountant closing the month on a tablet"), or add an entry by hand:

```json
{
  "id": "month-end",
  "name": "Accountant at month end",
  "targets": ["web"],
  "who": "Closes the books on the last day of the month, in a hurry, on a tablet.",
  "knows": "Accounting well; the app only through the screens they use monthly.",
  "focus": ["bug", "usability"],
  "does": ["Exports the same report three times", "Edits an entry while another tab has it open"],
  "judges": "Any total that does not add up, and anything that loses an edit.",
  "optIn": true
}
```

`focus` takes the kinds of bug in `issue-types.json` (`bug`, `usability`, `visual`, `copy`, `accessibility`, `performance`, `security`, `gap`). With `"optIn": true` the profile runs only when you name it ("explore invites as month-end") or list it in `Profiles:`.

### Add a way to collect evidence

A **driver** is a tool testers drive the app with and capture evidence through (built in: agent-browser, Claude in Chrome, curl, Hurl). A **target** is a kind of app (built in: web and API); add one for a desktop app, a CLI or a mobile app. Ask the evidence skill:

```
define a driver for playwright
```

```
define a target for our desktop app
```

It asks one question per setting, saves `.evident/drivers/<name>.md` or `.evident/targets/<name>.md`, and checks it. To write one by hand, copy [templates/driver.md](skills/evidence/templates/driver.md) or [templates/target.md](skills/evidence/templates/target.md): every setting is explained there. Check your files with:

```bash
node <skills>/evidence/scripts/definitions.mjs .evident --check
```

A file with a built-in's name replaces the built-in.

### Add a kind of bug

Copy [issue-types.json](skills/evidence/issue-types.json) to `.evident/issue-types.json` and add or edit a type: testers check every screen against the list.

### Change the defaults

`## Preferences` in `.evident/environment.md` holds the settings, each with its choices: viewports, `Mode`, `Profiles`, `Rounds`, `Batch`, `Explore time`, `Auto fixes`, `Gaps`, `Fix commits` and more. Anything you say in a request wins for that run.

## Requirements

- A coding agent that can start subagents (Claude Code, Codex and others).
- A browser tool for web apps: [agent-browser](https://github.com/vercel-labs/agent-browser), [Claude in Chrome](https://claude.com/chrome), or any tool that can navigate, click, resize, take screenshots and read the console. `curl` or Hurl for APIs.
- Node.js 18+, and git with the app's code for fix-and-prove.
- The app running locally or on a test server, with test accounts.

## Security

A skill is software: its Markdown tells your agent what to run, and its scripts run on your machine. Read both before installing.

- **No network.** No script contacts a network host. The report loads nothing from the internet.
- **Narrow scripts.** `build-proof.mjs` has no dependencies, reads only the run folder, the ledger and `environment.md`, and cannot start programs or run code it reads; a test keeps it that way. Of the evidence scripts, only `setup.mjs` runs commands (the setup commands you declare), and `sessions.mjs` closes the run's own browser sessions.
- **Blind testers.** In Claude Code, the agents carry a hook (`guard.mjs`) that refuses what their instructions forbid: a prover reading the code, the claims file, a fix or the ledger; an explorer writing outside its run folder.
- **Secrets.** Evidence files keep what they captured, cookies and tokens included, so keep `.evident/` private and redact a file before sharing it. Log lines and reports say `<redacted>` instead.
- **Your definitions are code.** Target and driver definitions in `targets/` and `drivers/` are shell your agent runs: review changes to them as you would code.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) lists every file and how to run the tests and evals.

## License

MIT. See [LICENSE](LICENSE).
