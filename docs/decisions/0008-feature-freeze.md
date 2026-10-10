# 0008. Feature freeze after impact and aftermath

Status: Accepted, 2026-10-09 (Zoheb).

## Context
Ideas kept arriving during the build while several agents were working in parallel. Each new feature would have needed design, tests and review, and would have pushed back the point where the whole tool could be checked together.

## Options considered
- Keep adding features as they come up.
- Freeze the feature list after the impact and aftermath work, and write new ideas down for later.

## Decision
Feature freeze after impact/aftermath. New ideas go to the README "Next version" list. Two features already built or started were cut there: the satellite/street toggle and "Locate me" on the location map (0010c33). The geolocation permission change made for Locate me was reverted (c51c818, 34539d8).

The 2026-10-10 "fast plan" kept the same rule: anything unfinished at the deadline goes to "Next version" (PROGRESS.md "Running"). Later entries include Firefox in the e2e matrix, a dark-mode e2e matrix, visual regression baselines, the proxy load test, a wider zone fallback, more one-tap fixes, and three known small bugs.

## Consequences
- README "Next version" is the single list of what is not in this version.

Sources: 0010c33, c51c818, 34539d8, 0e365ee, 5c78597, PROGRESS.md "Decisions" and "Running", README "Next version".
