# Evidence setup

Terms are in `SKILL.md`, next to this file. If `environment.md` does not exist, create it with only the sections this setup writes: `## Targets`, `## Drivers` and `## Evidence`.

**Defaults mode**: when a calling skill asks for defaults, ask nothing. Write step 6's section for the picked targets with the defaults of steps 3 and 5. Offer no installs: a tool that is not installed gets a `failed:` line when used. Then show the user the section and say how to change it (ask for evidence setup).

**Auto mode**: run defaults mode for the targets whose `## Evidence` line is missing or `none` and that `## Targets` lists (not `none`); keep the other lines. For a target with no driver (step 3), write the first of its definition's `drivers` that is installed or connected, as step 3 says. Instead of showing the section and asking, write one line in chat naming the defaults chosen and how to change them. Never install: a missing tool gets a `failed:` line when used, except where its driver's definition says to stop. A target with no driver and none of its `drivers` installed or connected: stop.

Defaults mode and auto mode never define a target or a driver. A target the run uses with no definition: stop with `Stopped: no definition for target <name>. Ask for evidence setup to define it, then run again.`

Run setup when the user asks for it, or when `SKILL.md` `## For calling skills` step 1 calls for it. Only an orchestrator runs it, never a subagent. When a calling skill runs it for missing targets and `## Evidence` already has its `Strength` and `Check` lines, do steps 3, 4, step 5's secrets question (only for those targets that are local) and 6 for those targets only, and keep the other lines. Otherwise run every step.

1. **Scan.** Run `node <evidence directory>/scripts/definitions.mjs <project folder> --list targets`: one known target per line. Look in the app repo (the Code path in `environment.md`, else the current repo) for those targets. Also read `## Targets`. Show what you found in plain words, and each `Warning:` line it printed, once.
2. **Pick apps.** Ask the user which targets to set up (several allowed). They may add one the scan missed, or a target that is not listed: define it first (**Define a target or a driver** below). If `## Targets` is empty, write the picked targets there, one line each as `- <its definition's address setting>: <address>`, with the URLs or commands the user gives.
3. **Pick methods.** Read the definition of each picked target, and of each driver `node <evidence directory>/scripts/definitions.mjs <project folder> --list drivers` lists: `--show target|driver <name>` prints its path first. For each picked target, ask which methods to use (several allowed), from its `methods`. For each method, show the drivers that can do it, those whose `targets` name the target (never a tool from a search result alone), whether each is installed or connected here (run its `check`), and its `## Weak spots`, in one line. Add a **Custom** option for a method in the user's own words, and **a driver that is not listed**: define it first (below).
   - Offer only the methods the target's driver lists. If it has none, offer `text` and Custom, and name the drivers that have one. If the target has no driver (its `## Evidence` line names no `driver:`; in an older file, a `tool:` on the API line or a command under `## Browser` other than the template's `<browser tool …>` placeholder counts as one), first ask which driver to use: one listed for it (default: the one already installed or connected, else the first in the target's `drivers`), or one the user names. Write its `command` under `## Drivers` as `- <driver>: <command>`; a driver whose `command` is `none` gets no line. If the user wants a method that driver cannot do, name the drivers that can, and offer to change to one. Change it only on yes.
   - Defaults: the target's `default-methods` that its driver can do (`video` in place of `gif` when it has no gif), and the driver above.
   - If a target whose `proven-by` is `picture` gets only `text`, warn that a calling skill that needs a picture will mark every case of it not proven.
4. **Install.** For each picked driver that is not installed, show its install line for this OS (`install-macos`, `install-linux` or `install-windows`, else its `## Install`) and ask "Install <tool> now?". Run it only on yes, one tool at a time. Never install a tool the user did not pick.
5. **Strength and check.** Ask for the strength:
   - `basic`: the tool's file, hashed right after capture, one log line per file. Catches a file edited later.
   - `cross-checked` (default): also a second record per case from another source (network log, raw response, raw stdout). Catches a picture that does not match what the app sent or printed.
   Then ask whether the check runs (default `on`): one more subagent per run opens every evidence file and flags files that do not show what their log line says.
   Then tell the user that `environment.md` keeps the test accounts' passwords in plain text (git-ignored, never committed), so it must name test accounts only, and that evidence files keep passwords, tokens, cookies and account emails as captured, so the run folder must stay private, and to redact before sharing any evidence file.
6. **Save.** Write `## Drivers` and then `## Evidence` in `environment.md`, in this form, each in place of the template's placeholder line if there is one. On a run for missing targets, edit only those targets' lines. A target the user did not pick gets `none`. One line per target, `- <label>: <methods> · driver: <name>`, and one `## Drivers` line per driver in use, as step 3 says. Leave an older `## Browser` as it is: a web line with no `driver:` still reads it.
   ```
   ## Drivers
   - agent-browser: agent-browser --no-auto-dialog --session <app-name>-<session>

   ## Evidence
   - Web: video, text · driver: agent-browser
   - API: readable · driver: curl
   - Custom: <the user's words>, or none
   - Strength: cross-checked
   - Check: on
   ```
   Show the user the section and each install command they said no to.

## Define a target or a driver

When the user asks to define one, or step 2 or 3 picks one that is not listed. A user who writes the file by hand skips the questions.

1. Ask one question at a time, to fill `<evidence directory>/templates/target.md` or `templates/driver.md`: each setting, as its comment explains, then each `##` section. Offer the template's value where it fits.
2. Save it as `<project folder>/targets/<name>.md` (a driver: `drivers/<name>.md`), or in `~/.evident/targets/` (`~/.evident/drivers/`) when the user says it is for every app. Never in `<evidence directory>`. A file with a built-in's name overrides it.
3. Run `node <evidence directory>/scripts/definitions.mjs <project folder> --check`. Fix each `Problem:` line with the user, and run it again until it prints none.
4. Show the file, and say the user can edit it by hand. If `git -C <project folder> check-ignore <saved file>` says it is ignored (an older `.gitignore`), print `!targets/`, `!targets/*.md`, `!drivers/` and `!drivers/*.md` for the user to add to `<project folder>/.gitignore`, so the team shares it.
5. For a target, ask which tester profiles fit it (default: those whose `targets` list `api`), and add its name to their `targets` in `<project folder>/tester-profiles.json`, only when that file exists. Never create it: bug-bash adds the name when it makes its copy.

Then go back to the step that sent you here.
