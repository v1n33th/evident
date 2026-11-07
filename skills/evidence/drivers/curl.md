---
name: curl
targets: api
methods: readable, raw
shell: yes
check: curl --version
parallel: yes
command: curl
install-macos: comes with macOS
install-linux: the curl package from your distro
install-windows: comes with current Windows
---

## Weak spots

Writes files only with `-D` and `-o`.

## Forms

`curl -sS -D '<run folder>/evidence/<claim>-<case>-headers.txt' -o '<run folder>/evidence/<claim>-<case>-body.txt' -w '%{http_code} %{time_total}' -X <method> -H '<header>' -d '<body>' <base URL>/<path>`
