# Fixer benchmark

How well the one-tap fixer (`suggestFixes`, DESIGN.md section 18) does on refused scenes, measured the same way before and after a change.

## The set

`packages/core/test/data/fixer-bench.jsonl`: **573 refused scenes**, made once by seeded generators and committed, so every measurement runs on exactly the same scenes even after the physics changes. Synthetic data only (made-up vehicles on the public road geometry of the three examples, synthetic roads, or no roads).

| Generator | 2 vehicles | 3 vehicles | 4 vehicles | Where |
|---|---:|---:|---:|---|
| `sweep`: the suggestFixes sweep's random scenes (directions are the ones step 2 offers at the pin) | 150 | 75 | 51 | 50 / 25 / 17 on each example network |
| `prop`: the property tests' arbitraries (pin up to 15 m off, speeds up to 150 mph, any bearing) | 150 | 75 | 50 | example networks, synthetic straight and crossing roads, no road data |
| `no-road`: example scenes with the pin moved 50 to 200 m to a spot with no road within reach | 12 | 6 | 4 | example networks |

Three and four vehicles are over-represented on purpose (they are where the fixer failed most): a claim usually has two.

A scene counts as **fixed** when at least one offered fix draws exactly as its button says: `simulate()` accepts the changed scene and swaps in no hit side behind it (no `zone-used` warning). The benchmark re-checks every fix itself.

Commands:
- `npm run fixer:bench` measures the current fixer (Node, through Vite's module runner; about 5 minutes for the old fixer).
- `npm run fixer:bench -- --v1` measures the frozen copy of the fixer before round A (`packages/core/test/fixer/suggest-v1.ts`), for side-by-side numbers on the same machine.
- `npm run fixer:bench -- --generate` rebuilds the set from its generators. Don't, unless the scene format changes: it resets the "before" numbers.

Times are the fastest of two runs per scene (other processes on the machine only ever add time), on an 18-core Mac shared with other jobs (load average 5 to 9 during the runs).

## Before (8dde902, Node 22, main thread)

| Group | Refused | With a working fix | Share | Median | p95 | Worst |
|---|---:|---:|---:|---:|---:|---:|
| **All** | 573 | 339 | 59.2% | 48 ms | 704 ms | 2781 ms |
| 2 vehicles | 312 | 279 | 89.4% | 72 ms | 767 ms | 1104 ms |
| 3 vehicles | 156 | 29 | 18.6% | 23 ms | 443 ms | 742 ms |
| 4 vehicles | 105 | 31 | 29.5% | 54 ms | 950 ms | 2781 ms |
| from sweep | 276 | 171 | 62.0% | 58 ms | 714 ms | 1537 ms |
| from prop | 275 | 168 | 61.1% | 45 ms | 649 ms | 2781 ms |
| from no-road | 22 | 0 | 0.0% | 0 ms | 0 ms | 0 ms |
| `moving-apart` | 59 | 53 | 89.8% | 38 ms | 464 ms | 555 ms |
| `no-road` | 22 | 0 | 0.0% | 0 ms | 0 ms | 0 ms |
| `no-such-lane` | 106 | 51 | 48.1% | 63 ms | 516 ms | 1453 ms |
| `no-workable-speed` | 99 | 93 | 93.9% | 255 ms | 1034 ms | 1537 ms |
| `not-moving-toward` | 29 | 27 | 93.1% | 30 ms | 168 ms | 213 ms |
| `on-building` | 34 | 27 | 79.4% | 56 ms | 341 ms | 422 ms |
| `passes-through` | 12 | 9 | 75.0% | 35 ms | 972 ms | 972 ms |
| `too-slow` | 11 | 9 | 81.8% | 24 ms | 89 ms | 89 ms |
| `wrong-way` | 72 | 46 | 63.9% | 21 ms | 533 ms | 951 ms |
| `zones-cannot-touch` | 129 | 24 | 18.6% | 27 ms | 587 ms | 2781 ms |

Slowest: prop-043 (4 vehicles, zones-cannot-touch, 2781 ms); sweep-067 (4 vehicles, no-workable-speed, 1537 ms); prop-060 (4 vehicles, no-such-lane, 1453 ms); prop-089 (2 vehicles, no-workable-speed, 1104 ms); sweep-043 (2 vehicles, no-workable-speed, 1078 ms).

Reading it: two-vehicle scenes were mostly fine (89%); three and four vehicles were not (19% and 30%), above all when the marked hit sides can't touch (19%) or a vehicle is in a lane its road doesn't have (48%). A pin with no road near it never got a fix (by design then). The search ran on the main thread, so its worst case (2.8 s here, about 1.8 s in the earlier sweep) froze the page for that long.

The browser main-thread numbers for the same frozen fixer are in "After" below, measured in the same run as the new one.
