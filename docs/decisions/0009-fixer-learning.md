# 0009. The one-tap fixer learns on the device only

Status: Accepted, 2026-10-10 (round A). Cross-user learning: proposed only, not built.

## Context
Zoheb asked for the one-tap fixer (DESIGN.md section 18) to improve over time without anything leaving the browser.
"Learning" can mean two things: the developers' test set gets better, or the app adapts to people. Only the first may
use many scenes; scenes are claimants' crash details and stay on their device (CLAUDE.md hard rules 5 and 6).

## Options considered
- Send refused scenes and the fix each person picked to a server and learn from all users.
- Learn nothing; rank fixes by size only.
- A regression corpus in the repo, plus a small per-device memory of which *kinds* of fix were picked.

## Decision
- **Regression corpus (developers).** `packages/core/test/data/fixer-corpus.jsonl` holds refused scenes from the
  benchmark, the red team, the e2e suite and the unit tests, each with the best fix found when it was added. The test
  `fixer-corpus.test.ts` fails if a case loses its fix or its best fix gets bigger, so the fixer can only get better.
  Adding a case is one command: `npm run fixer:corpus -- --add <scene.json> --roads <example|none|roads.json>`.
  Synthetic scenes only.
- **Device memory (claimants).** When someone taps a fix, the app remembers its *kind* in `localStorage`
  (`csd.fixes.v1`): the fields changed and whether each vehicle was marked as the one hitting or the one hit, e.g.
  `zone:struck`, `direction:striking+zone:struck`, `swap`, `pin`, with a count (capped at 20, at most 32 kinds). Never
  the scene, the letters, the location, speeds or labels. Next time, among fixes of the same size, remembered kinds come
  first; it never changes which fixes are found. "Clear remembered fixes" on the refusal screen removes it. Blocked or
  full storage means nothing is remembered.
- **No cross-user learning in this version.** It would mean sending people's crash details to a server.

## If cross-user learning is ever wanted (not built)
It would have to be a separate, opt-in feature with:
- **Consent:** off by default; a plain explanation before the first upload; can be turned off at any time, and turning
  it off stops sending at once. No change to the fixer for people who say no.
- **What is sent:** only the kind of refusal (its code), the vehicle count, the kinds of fix offered and the kind picked.
  No coordinates, street names, claim numbers, vehicle details, speeds, dates or free text; no scene file. No user id;
  at most a random id that resets with the stored data.
- **Anonymisation:** counts aggregated on the server per (refusal code, vehicle count, fix kind), with a minimum
  group size before any figure is used; no per-person record kept.
- **Retention:** raw events kept no more than 30 days, aggregates only after that; a documented deletion path.
- **Infrastructure:** a new `/api` route behind the same proxy, its own rate limit, the privacy notice updated, and the
  CSP unchanged (`connect-src 'self'`).

## Consequences
- The fixer improves through the corpus and code review, not from live data.
- A person's device ranks the kinds they tend to pick higher, on that device only.

Sources: DESIGN.md section 18, docs/FIXER-BENCHMARK.md, apps/web/src/fixer/memory.ts, README "Next version".
