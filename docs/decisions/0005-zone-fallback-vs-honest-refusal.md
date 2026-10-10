# 0005. Zone fallback vs honest refusal, and one-tap fixes

Status: Accepted. Zone fallback and refusals 2026-10-09; one-tap fixes 2026-10-10.

## Context
The claimant marks where each vehicle was hit. Sometimes the entered zones, directions and speeds cannot produce a crash. The rule that warnings never block ("See it anyway") left a dead end on the default claim, which the e2e suite recorded as a known bug (49d7378).

## Options considered
- Stop with an error whenever the entered zones cannot touch.
- Draw something anyway.
- Place the nearest zone that touches and say so; but never invent a picture when no honest one exists.

## Decision
- Zone fallback (8fccb99, DESIGN.md section 18): when the entered zones cannot touch, the physics tries other zones (one vehicle before two, the zone facing where the other comes from first). The warning `zone-used` says: "...the picture uses the right side instead." A tilt under 45 degrees keeps the marked zone (3839c17).
- Honest refusal, even after "See it anyway": vehicles moving apart or not toward each other, too slow to meet at any speed, passing through each other, overlapping, on a building, or with no road near the pin. A near-miss that ends up overlapping is refused as `bodies-overlap`, not sent to the fallback.
- The refusal is never a dead end (2026-10-10, 4bf520b, b7fc78e): "We can't draw this yet", one plain sentence on why, up to three one-tap fixes, and "Edit the details myself". Fixes change only hit side, direction or action, are kept only when the simulation draws them exactly as the button says, and are the same every time. No speed fixes, no moving the pin, no sketches (README "Next version").

## Consequences
- Measured: about 1 in 5 refused random scenes (56 of 300) get only "Edit the details myself", mostly three or four vehicles whose marked zones all miss (182deaa).
- Search is capped by counts, not a clock: 30 trial simulations for two vehicles, 20 for three or four. Worst case about 1.8 s on the main thread; a Web Worker and a wider fallback for 3-4 vehicles are on "Next version".

Sources: 8fccb99, 3839c17, 7bf9b1d, 4bf520b, b7fc78e, 35842fb, 182deaa, DESIGN.md section 18, README "Next version".
