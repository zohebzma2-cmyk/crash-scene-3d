# 0007. Full Opus review only for physics and security-sensitive code

Status: Accepted, 2026-10-09 (Zoheb's speed policy).

## Context
The build ran many agents in parallel, each in its own worktree and with strict file ownership. A full review of every diff would have been the slowest step.

## Options considered
- A full Opus review of every branch.
- Review depth by risk: full review where a mistake is expensive or exploitable; a lighter check elsewhere.

## Decision
- Full Opus review (the `reviewer` agent, see `.claude/agents/reviewer.md`) only for physics and security-sensitive code: the proxy, parsing, and CSP/headers.
- Visual-only changes are reviewed by screenshot.
- Integrate continuously on a trial branch; only reviewed SHAs go to main; one-line status per milestone.
- Reviewer, e2e, walkthrough and break-it tests run on Opus; the builder agents run on Sonnet.

## Consequences
- Merge commits name the reviewed SHA: physics reviewed 6 times, exports 4, app shell 4, search 3 (e.g. c35ca9c, 0ed554b, ae9fabe, 154dbcd).
- Review blockers were fixed and re-reviewed before merge (for example the one-tap fixes in 5089e72 and the compass in bf21613).

Sources: PROGRESS.md "Decisions" (Feature freeze + speed policy) and "Running", CLAUDE.md conventions, `git log` merge messages.
