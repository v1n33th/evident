# Quick start

Bug-bash's `SKILL.md` §1 step 2 sends you here; its terms hold. Ask nothing that can default:

- If a URL's host is not a local host, ask first: "Explorers try every action and input here. Is this a test environment?" Stop on anything but yes.
- Write `environment.md` from `<evidence directory>/environment-template.md` with: the URL as App, `Code: none` unless the user names the code, `## Targets` only the target the user gave (API auth `none`), `## Setup commands` none, no accounts, `New accounts: not allowed`, Preferences, and `none` on every other line. In `RUN.md` steps 1 and 2, ask none of their questions: take the feature slug from the request.
- Follow the evidence skill's `SETUP.md` in defaults mode.
- Explore signed out, unless the user named an account or sign-in; then ask only for what is missing.
- Tell the user in one line what you defaulted and that the evidence skill's setup and `environment.md` change it.

## Auto mode

Only when the run is in auto mode. These rows hold with those of `SKILL.md` and `AUTO.md`, and win where they differ.

| Where | In auto mode | Kind |
|---|---|---|
| `SKILL.md` §1 step 2: no `<project folder>/environment.md`, and the request gives a web URL or an API base URL | The quick start goes on, with the evidence skill's `SETUP.md` auto mode line in place of defaults mode. `AUTO.md`'s no-`environment.md` stop applies only when none of these was given. | rule |
| `SKILL.md` §1 step 2: quick start, URL on a host that is not a local host | Stop: `Stopped: <URL host> is not a local host, and auto mode cannot ask whether it is a test environment. Run once in ask mode.` A quick start has no `environment.md`, so only a local host (`localhost`, `127.0.0.1`, `[::1]`, `*.localhost`, `*.test`) goes on. | hard stop |
| `SKILL.md` §1 step 2: the user named an account or sign-in but not all it needs | Stop: `Stopped: auto mode needs the account's <what is missing> in the request. Run again with it, or run in ask mode.` | hard stop |
