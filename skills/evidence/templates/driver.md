---
# The driver's file name without .md. Lowercase, no spaces.
name: <name>
# Comma-separated target names this driver can drive.
targets: cli
# Comma-separated capture methods this driver provides, as named by its targets.
methods: text
# Whether the driver runs from a shell: yes or no.
shell: yes
# A command that succeeds when the driver is installed, or `tools: <prefix>` when its tools are listed by name.
check: example --version
# Whether sessions can run at once: yes, no, or `yes with <flag>` when each session needs its own value of that flag.
parallel: yes
# The command a tester starts with, or none.
command: example
# Optional: how to install it on macOS.
install-macos: brew install example
# Optional: how to install it on Linux.
install-linux: the example package from your distro
# Optional: how to install it on Windows.
install-windows: winget install example
# Optional: a command that prints the open sessions, one name per line (sessions.mjs closes only listed ones).
list: example sessions
# Optional: the command that closes one session, <name> (the session's name as command gives it).
close: example --session <name> close
# Optional: text in the --user-data-dir of the tool's own browser, so a run stops one whose tool died (parent PID 1).
orphans: example-profile-
---

## Weak spots

What the driver gets wrong or cannot do.

## Forms

The command lines for each thing a tester does with it.
