#!/usr/bin/env bash
# Creates the Acme invites scratch repo: branch main (the correct build) and branch next
# (the build with the planted faults), both on one base commit. Writes environment.md and
# an empty CLI working folder, acme-work, next to the repo and prints the repo folder.
# Usage: setup.sh [folder]   (default: a new folder under the system temp directory)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
dest="${1:-$(mktemp -d)/acme-invites}"
work="$(dirname "$dest")/acme-work"
for d in "$dest" "$work"; do
  if [ -e "$d" ] && [ -n "$(ls -A "$d")" ]; then
    echo "$d is not empty; pass a new or empty folder whose parent has no acme-work." >&2
    exit 1
  fi
done
mkdir -p "$dest" "$work"
dest="$(cd "$dest" && pwd)"
work="$(cd "$work" && pwd)"

g() { git -C "$dest" -c user.name=fixture -c user.email=fixture@acme.test "$@"; }
put() { cp -R "$1/." "$dest/" && rm -rf "$dest/.acme" && g add -A && g commit -qm "$2"; }

git init -q -b main "$dest"
put "$here/app" "Invites: send, resend, revoke"
g branch next
put "$here/overlays/main" "Daily invite limit for Free orgs"
g checkout -q next
put "$here/overlays/next" "Daily invite limit for Free orgs"
g checkout -q main
g remote add origin https://example.test/acme/acme-invites.git

sed -e "s|<repo>|$dest|g" -e "s|<work>|$work|g" "$here/environment.md" > "$dest/../environment.md"
echo "$dest"
