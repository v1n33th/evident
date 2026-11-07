---
name: api
label: API
address: API
drivers: curl, hurl
methods: readable, raw, tool report
default-methods: readable
proven-by: file
viewports: no
session-cases: 6
found: none
evidence-summary: saved response of each call
---

## Connect

The base URL and auth are under `API` in `## Targets` of `environment.md`.

## Drive

`<run folder>` is an absolute path; do not `cd`.

Allowed commands (`CAPTURE.md` §2): `curl` to make calls. Read a saved body or an email list from the mail API with `pick.mjs` (`CAPTURE.md` §2), never `node -e` or `python`.

## Capture

Tool notes: read the `## curl` section of `~/.evident/tool-notes.md` if it exists. When the tool surprises you (a command fails, a workaround works), append a line under that heading (add the file or the heading if missing) about the tool, never the app, and never a password, token or account email: `- <what happened>. <what works instead>. (<run folder name>)`.

`readable`: save two files per call:

- `<claim>-<case>-request.txt`: the method, the URL, the headers and the body.
- `<claim>-<case>-response.txt`: the status line, the response headers, then the body. Build it from the header and body files, and keep those two as well, with `role` `raw`: they are the tool's own files.

`raw` alone: keep only the `-headers.txt` and `-body.txt` files `curl` wrote, with `role` `raw`.

In the response file's `note`, put the status and the field the claim is about; the request file's `note` says only what was sent. For several calls in a case, add `-n`: `C5-c-2-request.txt`.

## Try

- One input that breaks one rule; another owner's or role's ids; the same request twice; two writes in both orders; a limit crossed by many requests at once; a lifecycle step twice or out of order (confirm, activate, delete in use); another org's record, file or key in a save; a plan's gate; a timeout or cancel mid-action; recovery after a partial failure. Success means the state read back, not the response.

## Sign in

Sign in: no sign-in page. Run the `setup <key>` that `CAPTURE.md` §2 names, and send its token as the API auth in `## Targets` says. Else log blocked with `needs sign-in: setup command`.
