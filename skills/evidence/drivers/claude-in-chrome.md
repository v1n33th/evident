---
name: claude-in-chrome
targets: web
methods: gif, screenshots, text
shell: no
# Claude Code only: the tools named here exist only in Claude Code.
check: tools: mcp__claude-in-chrome__
parallel: no
command: none
---

## Weak spots

the GIF lands in Chrome's download folder. No dialog command, and a dialog blocks every tool. One shared window, so runs cannot split it. In Claude Code, when the `mcp__claude-in-chrome__*` tools are not listed, report the case blocked with `Chrome not connected`.

## Forms

- Notes: use the first tab from `tabs_context_mcp` with `createIfEmpty: true`, not `tabs_create_mcp` (its tabs open off-screen). `resize_window` resizes the real window, not below about 500px wide. It does nothing while the window is off-screen, minimized, on another desktop or fullscreen (signs: `innerWidth` 0, `screenY` at the screen's bottom edge, or `outerHeight` equal to `innerHeight`): switch to another tab in the group, else report the case blocked: Chrome must stay visible and not fullscreen. Use the srcdoc fallback only to check layout at the viewport's width, never for click, type or submit results: with JavaScript, copy the page's DOM (without `<script>` tags) and its CSS (each stylesheet's `cssRules` text, and the `<link>` tags of cross-origin ones) into a same-origin `srcdoc` iframe of that width, and measure the layout there. Report "srcdoc fallback" with the attempt. When a dialog blocks it, report the case blocked by a dialog. The network log clears when the page moves to another domain; for requests still missing, use the UI text or the server logs.
- Forms: `gif_creator` start, reproduce, stop, export with download and `filename` `<claim>-<case>.gif`. Move it from Chrome's download folder (usually `~/Downloads`; a repeated name gets ` (1)`) to `<run folder>/evidence/`, taking only a file modified after the export, waiting up to 30 s for it. If only an older file of that name is there, the export failed: log the `failed:` line. See the page: `read_page` (refs) or `get_page_text`; act by `ref` with `computer` or `find`. Screenshots: the `computer` screenshot action. Text: `javascript_tool`. Network and console: call `read_network_requests` with `tabId` before the action, then after it `read_network_requests` and `read_console_messages` with `tabId`.

## Check (Claude Code only)

Installed when the `mcp__claude-in-chrome__*` tools are listed. If not: in auto mode the orchestrator, at setup, stops; else ask the user to run `/chrome`.

## Install (Claude Code only)

A Chrome extension, not a command: add "Claude" from the Chrome Web Store and sign in with a paid claude.ai account. Start with `claude --chrome`.
