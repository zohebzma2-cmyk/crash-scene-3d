# Fixer benchmark

How well the one-tap fixer (`suggestFixes`, DESIGN.md section 18) does on refused scenes, measured the same way before and after a change.

## The set

`packages/core/test/data/fixer-bench.jsonl`: **573 refused scenes**, made once by seeded generators and committed, so every measurement runs on exactly the same scenes even after the physics changes. Synthetic data only (made-up vehicles on the public road geometry of the three examples, synthetic roads, or no roads).

| Generator | 2 vehicles | 3 vehicles | 4 vehicles | Where |
|---|---:|---:|---:|---|
| `sweep`: the suggestFixes sweep's random scenes (directions are the ones step 2 offers at the pin) | 150 | 75 | 51 | 50 / 25 / 17 on each example network |
| `prop`: the property tests' arbitraries (pin up to 15 m off, speeds up to 150 mph, any bearing) | 150 | 75 | 50 | example networks, synthetic straight and crossing roads, no road data |
| `no-road`: example scenes with the pin moved 50 to 200 m to a spot with no road within reach | 12 | 6 | 4 | example roads re-centred on the pin, compass directions (as the app would load them) |

Three and four vehicles are over-represented on purpose (they are where the fixer failed most): a claim usually has two.

A scene counts as **fixed** when at least one offered fix draws exactly as its button says: `simulate()` accepts the changed scene and swaps in no hit side behind it (no `zone-used` warning). The benchmark re-checks every fix itself.

Commands:
- `npm run fixer:bench` measures the current fixer (Node, through Vite's module runner; about 5 minutes for the old fixer).
- `npm run fixer:bench -- --v1` measures the fixer before round A: commit 8dde902's own `packages/core/src`, physics and all, unpacked from git into `node_modules/.cache/fixer-v1` (scripts/fixer-v1.mjs).
- `npm run fixer:bench:browser` runs the same set in Chromium and WebKit (Playwright, a small Vite harness on 127.0.0.1:4391): before on the main thread, after on the main thread and in a module Web Worker.
- `npm run fixer:bench -- --generate` rebuilds the set from its generators. Don't, unless the scene format changes: it resets the "before" numbers.

Times are the fastest of two runs per scene (other processes on the machine only ever add time), on an 18-core Mac shared with other jobs (load average 5 to 9 during the runs). After round A each timed run gets a fresh copy of the road data (`structuredClone`, as the worker receives it), so nothing the physics caches per road network helps: the time of a first search.

Note: the no-road scenes were regenerated once during round A (roads re-centred on the pin, compass directions). The old fixer gives no fix for any no-road scene either way, so its numbers below are unchanged by that.

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

The browser numbers for the old fixer are in "After" below, measured in the same run as the new one.

## After (round A, roads fresh for each search)

### Node 22 (main thread)

| Group | Refused | With a working fix | Share | Median | p95 | Worst |
|---|---:|---:|---:|---:|---:|---:|
| **All** | 573 | 482 | **84.1%** (was 59.2%) | 20 ms | 120 ms | **172 ms** (was 2781) |
| 2 vehicles | 312 | 300 | 96.2% (was 89.4%) | 13 ms | 110 ms | 172 ms |
| 3 vehicles | 156 | 106 | 67.9% (was 18.6%) | 25 ms | 113 ms | 156 ms |
| 4 vehicles | 105 | 76 | 72.4% (was 29.5%) | 51 ms | 139 ms | 172 ms |

Every offered fix was re-checked with the full `simulate()`: all draw, none swaps a hit side in. The per-code breakdown is printed by `npm run fixer:bench`; the biggest gains are `zones-cannot-touch` (19% before) and the path refusals `no-such-lane` and `wrong-way`, mostly with three or four vehicles, and `no-road` (0% before, now fixed by moving the pin when a road is within 90 m). Two thirds of the best fixes change one detail; almost all of the rest two or three.

### Browsers (Playwright on the same Mac)

| Browser | Fixer | Where | Offered a fix | Median | p95 | Worst search | Longest main-thread task |
|---|---|---|---:|---:|---:|---:|---:|
| Chromium | before (8dde902) | main thread | 339 of 573 | 35 ms | 548 ms | 2611 ms | 5281 ms (two runs of one scene per task) |
| Chromium | after | main thread | 483 of 573 | 11 ms | 62 ms | 107 ms | 219 ms (two runs per task) |
| Chromium | **after** | **Web Worker** | 483 of 573 | 11 ms | 63 ms | **106 ms** | (search off the main thread) |
| WebKit | before (8dde902) | main thread | 341 of 573 | 33 ms | 457 ms | 2056 ms | not measured (no long-task timing) |
| WebKit | after | main thread | 486 of 573 | 9 ms | 52 ms | 87 ms | not measured |
| WebKit | **after** | **Web Worker** | 486 of 573 | 11 ms | 62 ms | **104 ms** | (search off the main thread) |

In the app the search runs in the worker, so the page never waits for it; the worst search there was 106 ms (target: under 300 ms). The engines differ on a handful of close calls (Node 482, Chromium 483, WebKit 486 scenes with a fix): floating-point results of Math functions differ slightly between engines, and the search is exact within one engine. A fix is always judged in the same engine that then draws it.

### Targets

- **Worst search under 300 ms off the main thread: met** (106 ms Chromium, 104 ms WebKit, in the worker; 172 ms in Node).
- **95% of refusals get a working fix: not met on this benchmark** (84.1%). Two-vehicle refusals: 96.2%. The benchmark over-weights three and four vehicles on purpose (47% of the set); weighted like the sweep's mix (80% two, 14% three, 6% four vehicles) it is about 91%. Most of the remaining refusals are random three- and four-vehicle scenes where nothing meets anything and three or more details would have to change.
- Measured trade: limits of 2.5M work units and 600 checks reach **88.8%** (3 vehicles 73.7%, 4 vehicles 88.6%) but the worst search takes 554 ms in Node, over the target. Without any limit, the current candidates reach about 89 to 90%. Getting to 95% would need fixes that change three or more details at once (in effect re-entering the crash), which is not a small change; that is listed in README "Next version" instead.

## The corpus

`packages/core/test/data/fixer-corpus.jsonl` (decision 0009): 576 refused scenes, every benchmark scene by reference plus the e2e suite's impossible scene and the unit tests' path refusals, each with the best fix found when it was added (485 have one). `packages/core/test/fixer-corpus.test.ts` fails if any case loses its fix or its best fix gets bigger, and checks that the best fix draws. Commands: `npm run fixer:corpus -- --add <scene.json> --roads <example|none|roads.json> [--src name] [--note text]`, `--check`, `--update` (records improvements only), `--seed` (rebuilds; resets the bar).
