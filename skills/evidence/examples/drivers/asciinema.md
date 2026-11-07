---
name: asciinema
targets: cli
methods: recording
shell: yes
check: asciinema --version and agg --version
parallel: yes
command: asciinema
install-macos: brew install asciinema
install-linux: sudo apt install asciinema (Debian, Ubuntu 22.04+), sudo dnf install asciinema (Fedora), sudo pacman -S asciinema (Arch). agg: download the binary for your CPU from its releases page, then chmod a+x agg and sudo mv agg /usr/local/bin
install-windows: no install documented
---

Untested: copy into your project's drivers/ and try it before relying on it.

## Weak spots

Records the terminal session, so secrets typed or printed show in the file.

## Forms

`asciinema rec --command '<command>' '<run folder>/evidence/<claim>-<case>.cast'`. Log it with `role` `raw`, then `agg '<run folder>/evidence/<claim>-<case>.cast' '<run folder>/evidence/<claim>-<case>.gif'`, logged with `role` `picture`.
