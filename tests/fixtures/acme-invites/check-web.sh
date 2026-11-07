#!/usr/bin/env bash
# Shows the three browser-only behaviours of the running build with agent-browser.
# Start nothing: run `node server.mjs` in the scratch repo first.
# Usage: check-web.sh <branch> [scratch-repo-folder]   (folder defaults to $PWD; branch is only a label)
set -euo pipefail
branch="${1:?usage: check-web.sh <branch> [scratch-repo-folder]}"
repo="${2:-$PWD}"
base=http://localhost:4173
command -v agent-browser >/dev/null || { echo "agent-browser is not installed." >&2; exit 1; }
curl -sf "$base/api/health" >/dev/null || { echo "Nothing answers at $base: start node server.mjs in the scratch repo first." >&2; exit 1; }
s="check-web-$$"
ab() { agent-browser --session "$s" "$@"; }
trap 'agent-browser --session "$s" close >/dev/null 2>&1 || true' EXIT
link() {
  local l
  l=$(cd "$repo" && node admin/login.mjs "$1" | sed -n 's/^link: //p')
  [ -n "$l" ] || { echo "No sign-in link for $1 (is $repo the scratch repo?)." >&2; exit 1; }
  echo "$l"
}

# send button on screen at 390 and 360 px, errors on load
url=$(link free-owner)
ab open "$url" >/dev/null
visible=yes
for w in 390 360; do
  ab set viewport "$w" 844 >/dev/null
  ab open "$base/team" >/dev/null
  ab wait 500 >/dev/null
  r=$(ab eval 'const b=document.getElementById("send").getBoundingClientRect(); String(b.left>=0 && b.right<=innerWidth)')
  [[ "$r" == *true* ]] || visible=no
done
# the browser reports each page error twice and keeps earlier loads: count distinct errors
errors=$(ab errors --json | node -e 'const e=JSON.parse(require("fs").readFileSync(0)).data.errors;console.log(new Set(e.map((x)=>x.text)).size)') || { echo "Could not read the browser's errors." >&2; exit 1; }

# double click on a fresh org
key=$(cd "$repo" && node admin/new-org.mjs free | sed -n 's/^key: //p')
[ -n "$key" ] || { echo "new-org printed no key." >&2; exit 1; }
url=$(link "$key")
ab open "$url" >/dev/null
ab set viewport 1440 900 >/dev/null
ab open "$base/team" >/dev/null
ab fill '#email' "qa+$(date +%s)@acme.test" >/dev/null
# the browser's dblclick fires one click event, so click twice in the same tick, as a fast double click does
ab eval 'const b=document.getElementById("send"); b.click(); b.click()' >/dev/null
ab wait 1000 >/dev/null
count=$(ab eval 'document.querySelectorAll("#invite-list .invite").length' | tr -d '"')

echo "send visible: $visible"
echo "console errors: $errors"
echo "double click invites: $count"
