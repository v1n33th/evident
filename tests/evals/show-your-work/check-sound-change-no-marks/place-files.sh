#!/usr/bin/env bash
set -eu
cp -R "$(dirname "$0")/files/." .
# The app repo: a base commit on main, then the change left uncommitted.
cd app-base && git init -q -b main && git add -A && git -c user.name=qa -c user.email=qa@acme.test commit -qm base && cd ..
cp -R app-change/. app-base/ && rm -rf app-change && mv app-base app
