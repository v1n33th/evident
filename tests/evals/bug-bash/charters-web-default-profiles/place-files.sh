#!/usr/bin/env bash
set -eu
cp -R "$(dirname "$0")/files/." .
# The app repo: everything committed on main.
cd app && git init -q -b main && git add -A && git -c user.name=qa -c user.email=qa@acme.test commit -qm base && cd ..
