#!/usr/bin/env bash
set -eu
mkdir -p results
cp -R "$(dirname "$0")/files/proj" results/app
# Another run holds the lock: its folder has no result.json, and the lock is minutes old.
mkdir -p results/app/team-invites/2026-10-28-0900-prove/proof
echo "results/app/team-invites/2026-10-28-0900-prove/proof" > results/app/run.lock
cp results/app/run.lock results/run.lock.expected
# A tiny app repo with a last commit to prove.
mkdir app && cd app && git init -q -b main
echo "v1" > app.txt && git add -A && git -c user.name=qa -c user.email=qa@acme.test commit -qm base
echo "v2" > app.txt && git -c user.name=qa -c user.email=qa@acme.test commit -qam "change"
