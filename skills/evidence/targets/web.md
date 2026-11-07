---
name: web
label: Web
address: Web
drivers: agent-browser, claude-in-chrome
methods: gif, video, screenshots, text
default-methods: gif, text
proven-by: picture
viewports: yes
session-cases: 10
found: found.png, found.txt
evidence-summary: each method `## Evidence` picks for web, of every step; text on screen
---

## Connect

- Use your driver's command under `## Drivers` in `environment.md` (an older file: under `## Browser`), else its definition's `command`, with its flags. Fill `<session>` with the `Session name` in your prompt (none: its `Session id`), and `<app-name>` with the project folder's name (for `.evident`, the name of the folder that holds it). In the whole `--session` value, as filled, write each character that is not a letter, digit, hyphen or underscore as a hyphen: `acme.app-01-web` is `acme-app-01-web`. agent-browser refuses a dot.
- If the browser tools do not load, stop and report it. Never switch tools silently.
- In a sandbox, the browser tool needs network access: allow it, or run the tool outside the sandbox.
- Read the `## <your browser tool>` section of `~/.evident/tool-notes.md` if it exists. When the tool surprises you (a command fails, a workaround works, the file is wrong), append a line under that heading (add the file or the heading if missing) about the tool, never the app, and never a password, token or account email: `- <what happened>. <what works instead>. (<run folder name>)`.

## Drive

- Use one tab for your session, never the user's other tabs. Keep it open until your last step, where your instructions close your session.
- A viewport may name a device (`mobile 390×844 (device: iPhone 14)`): emulate it with your tool's device form, even when `tool-notes.md` says the form is off: a phone's user agent and touch are what its users get. Then read `innerWidth`: when it is not the named width, also set the named width and height with the resize form, and reload. The page lays out by width, so a phone at the wrong width hides the bugs only that width shows. Report what each form gave. With no device form, resize only, and report "resize only, no device emulation" with the attempt.
- Test at each viewport your instructions name, else at the first under `Viewports` in `## Preferences` of `environment.md` (none: leave the size as it is). After each resize or emulation (after an emulation, reload the page so the server sees the device), read `innerWidth`, `innerHeight`, `devicePixelRatio`, `navigator.maxTouchPoints` and `matchMedia('(pointer: coarse)').matches` with JavaScript, and report them with the attempt. When the viewport names a device and the page shows no touch, also report "no touch emulation", and note it under your tool in `~/.evident/tool-notes.md`.
- At every viewport but a desktop one, on each new screen and after each action that changes the layout, read with JavaScript how far the page scrolls sideways and which controls lie outside the screen: `JSON.stringify({sideways: document.documentElement.scrollWidth - innerWidth, outside: [...document.querySelectorAll('button,a[href],input,select,textarea')].filter(e => { const r = e.getBoundingClientRect(); return r.width && (r.left < 0 || r.right > innerWidth); }).map(e => e.textContent.trim() || e.name || e.id)})`. A control outside the screen is a finding, and so is sideways scroll: your tool scrolls to what it clicks, a person sees no button. Report the value with the step.
- When the tool cannot reach a viewport's width, click, type and submit at the narrowest width it reaches, and report that real width.
- Read the page as text with your tool's snapshot form, and act by the refs it gives. JavaScript reads what a snapshot misses.
- Act as a user, with the tool's own click, double-click, type, fill, press and select commands. Never act on the page in JavaScript (`click()`, `submit()`, `requestSubmit()`, dispatched events, set values): it gets past disabled buttons and checks no user can, so its result proves nothing. Two quick clicks (a double click on a button or link): two of the tool's click commands chained in one shell command (`&&`), never its double-click command, which can send one click event. Then click the page's top-left corner (2, 2), where nothing is, and wait 1 s: when the first click clears a form, the second opens the browser's "Please fill out this field" bubble over the page, and only a click elsewhere closes it (Escape does not). Before any case's final screenshot, close such a bubble the same way. JavaScript only reads the page, except for date and color inputs below. When the tool cannot do an action, report the case blocked.
- A case whose action is a request the page does not send itself (a call its steps name, or several sent at the same moment): send it from inside the page with the tool's JavaScript form, so the page's sign-in goes with it, and only to the host the page is on: `fetch('<path>', {method: '<METHOD>', credentials: 'include', headers: {'content-type': 'application/json'}, body: '<JSON>'})`, and for several at once `Promise.all` of that many, returning each status and body. `API: none` in `## Targets` does not stop it: no other auth is used. Save what it returns as `<claim>-<case>-response.txt`, the case's raw evidence. It is the one action JavaScript takes: never for what a person can do on the page.
- Dialogs (`alert`, `confirm`, `prompt`): answer with the tool's dialog command as a user would, and report it with the attempt.
- Date, time and color inputs: use the tool's fill with an ISO value (`2026-10-22`) or a hex color (`#ff0000`) and read the value back: a fill can report done and change nothing (agent-browser's does on a color input). Else, and for every color input whose picker the tool cannot drive, set it in JavaScript with the native setter `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v)`, not `el.value = v`, then dispatch `input` and `change` with `bubbles: true`. Never type the digits.
- On every new screen, read the console's and the page's errors with your tool's console form (errors only, where it can filter). Report each one with the attempt, even when the screen looks fine.
- Emails: read them as `## Emails` in `environment.md` says, outside your tab (the mail API with `curl -o`, then `pick.mjs` as `CAPTURE.md` §2 says), so your tab stays on the app. Open an email's link in your tab only when the case follows that link. If `## Emails` says none, report the case blocked.

## Capture

Allowed commands (`CAPTURE.md` §2): your driver's command, and `sleep`.

Capture each picked method with your tool's Forms. In each log line, `viewport`: when your instructions name viewports for the case, the one captured at. Else omit it.

- `gif` or `video`: record every case, pass or fail, as `<claim>-<case>.<ext>`: start before its first action and stop after its final state. A case that starts where the case before ended records its own actions from there. Pace it for a person: about 1 s between actions and 2 s on the final state (`sleep`, or your tool's wait). Before you return, list `<run folder>/evidence/` and record any case you ran that has no recording at each of its viewports: a case without one is not proven, even when it passed.
- `screenshots`: each important step, as `<claim>-<case>-step-01.png`, `-step-02.png`, ... Take the last one on the page the case's `expect` names, before your tab leaves it, and annotated when your tool's Forms have an annotated form.
- `text`: only values measured with JavaScript, before you write the picture's log line. Put them in the `note` of the picture line whose picture shows them (the last one when there are several). With no picture method picked, save them in `<claim>-<case>-measure.txt` with `role` `measure`.

Pictures stay as captured, so keep secrets off screen where you can: leave password fields masked, and open pages that show keys or tokens only when the case is about them.

At cross-checked: start the tool's network log before the action, as its Forms say. After it, save the requests to `<claim>-<case>-network.txt` and the console messages to `<claim>-<case>-console.txt`, with `role` `raw`. When its Forms have no network or console form, log `failed: <tool>: no network log` or `failed: <tool>: no console log` instead.

## Try

- Boundaries (0, 1, the limit, one over), empty and many items, Back after submit, refresh mid-flow, a second tab, double-click, the same request twice at once, a link or action from before the item changed state, slow or failed network, the page's own requests replayed (another role's or org's ids, a field the form hides or caps, a plan's gate, two writes in both orders).

## Sign in

- `setup <key>`: open the link it prints, or set its cookie with your tool's cookie command.
- Sign in only in the browser, never with `curl`, and never save a sign-in response: `api` sends requests with the page's sign-in.
