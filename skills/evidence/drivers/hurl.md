---
name: hurl
targets: api
methods: tool report
shell: yes
check: hurl --version
parallel: yes
command: hurl
install-macos: brew install hurl
install-linux: the user installs their distro's package from the Hurl install page (it needs root, so never run it for them)
install-windows: winget install hurl (or choco install hurl, scoop install hurl)
---

## Weak spots

Makes the calls itself, so write the `.hurl` file first and keep it to the declared base URL. Write secrets as `{{token}}` and pass them with `--variable token=<token>`.

## Forms

`hurl --test --report-html '<run folder>/evidence/<claim>-<case>-hurl/' '<run folder>/evidence/<claim>-<case>.hurl'`. `--report-html` writes a folder: log one `evidence.jsonl` line per file in it, subfolders too.
