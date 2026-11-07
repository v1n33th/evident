#!/usr/bin/env bash
# Builds results/app with earlier bug-bash runs, and a tiny app repo, for fix-and-prove's start evals.
# Pending bugs (no fix record) for team-invites: 2026-10-28-0900-explore BUG-001 and BUG-002, 2026-10-27-0900-explore BUG-001.
# Not pending: 2026-10-27-0900-explore BUG-002 (fixed), and billing's bug (another feature).
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
P=results/app
mkdir -p results/app && cp "$here/environment.md" results/app/environment.md
bug() { # explore step, bug folder, id, severity, kind, title, [fix json]
  mkdir -p "$P/$1/bugs/$2" "$P/$1/sessions" "$P/$1/evidence"
  printf '{"id":"%s","title":"%s","severity":"%s","kind":"%s","target":"cli","steps":["cat app.txt"],"expected":"e","actual":"a"%s}\n' "$3" "$6" "$4" "$5" "${7:+,\"fix\":$7}" > "$P/$1/bugs/$2/bug.json"
}
bug team-invites/2026-10-27-0900-explore/explore BUG-001-resend-cooldown BUG-001 minor bug "Resend has no cooldown"
bug team-invites/2026-10-27-0900-explore/explore BUG-002-empty-email BUG-002 major bug "Empty email is accepted" '{"status":"fixed","summary":"Refuses an empty email","risk":"low"}'
bug team-invites/2026-10-28-0900-explore/explore BUG-001-limit-off-by-one BUG-001 major bug "The 20th invite of the day is refused"
bug team-invites/2026-10-28-0900-explore/explore BUG-002-other-org-invites BUG-002 critical security "Another org's invites can be read"
bug billing/2026-10-28-0900-explore/explore BUG-001-tax-rounding BUG-001 minor bug "Tax rounds down"
mkdir -p app && cd app && git init -q -b main
echo "v1" > app.txt && git add -A && git -c user.name=qa -c user.email=qa@acme.test commit -qm base
# Another run holds the lock (no result.json, minutes old), so every case stops at RUN.md step 3 at the latest.
cd ..
mkdir -p results/app/team-invites/2026-10-29-0900-prove/proof
echo "results/app/team-invites/2026-10-29-0900-prove/proof" > results/app/run.lock
