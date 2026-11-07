---
name: cli
label: CLI
address: CLI
drivers: asciinema
methods: text, recording
default-methods: text
proven-by: file
viewports: no
session-cases: 6
found: none
evidence-summary: command, output and exit code of each run
---

Untested: copy into your project's targets/ and try it before relying on it.

## Connect

The command and its `<working folder>` are under `CLI` in `## Targets` of `environment.md`. `<run folder>` and `<working folder>` are absolute paths; quote them.

## Drive

Allowed commands (`CAPTURE.md` §2): the target command with the arguments the case needs, and the forms in this file (`touch`, `find`, `echo $?`).

## Capture

Tool notes: read the `## <the target command>` section of `~/.evident/tool-notes.md` if it exists. When the tool surprises you (a command fails, a workaround works), append a line under that heading (add the file or the heading if missing) about the tool, never the app, and never a password, token or account email: `- <what happened>. <what works instead>. (<run folder name>)`.

`text`: run the command once per run, in one call:

`set -C; cd '<working folder>' && touch '<run folder>/evidence/.marker-<claim>-<case>' && <command> >'<run folder>/evidence/.out-<claim>-<case>' 2>'<run folder>/evidence/.err-<claim>-<case>'; echo $?`

When the command asks for input, write the answers to `<run folder>/evidence/.in-<claim>-<case>` with your file tools first, and add `<'<run folder>/evidence/.in-<claim>-<case>'` before `>`. Delete it with the marker.

`set -C` refuses to overwrite: if the shell says a file exists, you reused a name, so take the next `-n`.

Then save `<claim>-<case>.txt` with, in order: the command as run, with its working folder; stdout; stderr; the exit code; and the files created, the output of `find '<working folder>' -newer '<run folder>/evidence/.marker-<claim>-<case>' -type f -not -path '<run folder>/*'`.

Delete the marker. At cross-checked: keep the `.out-` and `.err-` files as `<claim>-<case>-stdout.txt` and `<claim>-<case>-stderr.txt`, with `role` `raw`; below that, delete them. Put the exit code and the key output line in `note`. For several runs in a case, add `-n`: `C5-c-2.txt`.

`recording`: run the command once through asciinema, from the working folder, in its Forms. The `.cast` is the `raw` record. When `text` is also picked, record first, then do the `text` run; if a second run would change the result (the command changes state), skip it and log a `failed: text: command changes state, recorded only` line.

## Try

Run it with no arguments, with `--help`, with a wrong argument, and twice in a row. Read the exit code and what it wrote or changed.

## Sign in

Sign in: no sign-in page. Run the `setup <key>` that `CAPTURE.md` §2 names, or `email code` for a CLI login command, and pass the token as the `CLI` line of `## Targets` says. Else log blocked with `needs sign-in: setup command`.
