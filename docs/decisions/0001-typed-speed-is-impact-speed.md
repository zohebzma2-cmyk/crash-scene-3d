# 0001. The typed speed is the speed at impact

Status: Accepted, 2026-10-09 (Zoheb's decision; the 1.5 s braking length was the lead's call, flagged to Zoheb).

## Context
The claimant is asked how fast a vehicle was going. An earlier version treated that number as the speed at the start of the 5 s replay window. The question needs to mean the same thing for a claimant, for the physics and for the numbers printed in the app and the PDF.

## Options considered
- Speed at the start of the window (the earlier mode, with a switch for where the entered speed applies). Removed in fe226ff.
- Speed at the moment of impact, with the approach worked out backwards from it.

## Decision
The typed speed IS the speed at impact. The physics works backwards from the impact over `APPROACH_S` = 5 s.
- A vehicle not marked as braking holds its speed for the whole window.
- A braking vehicle slows down INTO the crash, over the last `BRAKING_S` = 1.5 s, at 0.7 x road friction x gravity, with a steady speed before that. It is faster earlier and is never shown stopping before the crash.
- The 1.5 s length was the lead's call, flagged to Zoheb (PROGRESS.md, Decisions, "Speed meaning").
- The question reads "About how fast at the moment of the crash?". The assumptions list and the PDF say "speed at impact, as entered".

## Consequences
- Labels in the viewer, the review rows and the exports speak of speed at impact (58d90a9, 7872d88).
- One test rule: the typed speed equals the speed at impact, always. It is checked on the examples, the fixtures and 240 seeded random scenes (4d08408), and later over 1,000 random scenes in the property tests (f4884a3).
- The highway example was reworked (B typed at 45 mph).
- Lanes are chained far enough for the fastest approach (150 mph, braking, plus 50 m).

Sources: 37eb10f, fe226ff, PROGRESS.md "Decisions", DESIGN.md sections 5, 7, 8 and 14, README physics section.
