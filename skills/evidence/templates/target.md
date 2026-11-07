---
# The target's file name without .md. Lowercase, no spaces.
name: <name>
# What the target is called in reports, for example Web or API.
label: Target
# What environment.md calls its address in ## Targets, for example Web (an App URL) or API (a base URL).
address: Target
# Comma-separated driver names, in the order to prefer them. Each is a drivers/<name>.md.
drivers: curl
# Comma-separated ways to capture evidence for this target. Free words the drivers and the Capture section explain.
methods: text
# Comma-separated methods used when nobody picks: a subset of methods.
default-methods: text
# What proves a case: picture (a person looks at an image or video) or file (a saved text file).
proven-by: file
# Whether cases run at several viewports: yes or no.
viewports: no
# How many cases a proof session carries: a whole number, 1 or more.
session-cases: 6
# Files a filed bug carries, comma-separated (for example found.png, found.txt), or none.
found: none
# One line for the evidence summary: what each case's evidence is.
evidence-summary: saved output of each step
---

## Connect

How a tester reaches the target.

## Drive

How a tester acts on it.

## Capture

How a tester saves evidence for each method.

## Try

Ideas for what to try when exploring this target.

## Sign in

How a tester signs in.
