# Integration fixes (2026-10-12, integ/with-codex)

Made on `integ/with-codex` (Codex's `8d4c463` merged onto main) while Codex is stopped. They belong to Codex's code, so they are listed here.

- **road-features.spec** failed on all four projects: `b67e953` moved the compact answers out of the 3D view into `.viewer-answers` and changed the summary to "Claimant said · N answers", but the spec still looked for `.viewer3d .account-icons` with "Claimant said:". The spec now checks the row, the count (10) and two answers' full labels after expanding it (`e2e/road-features.spec.ts:22`). No app change.
- **First-frame time** (was ~2x main): the road features now mount after the first frame, in idle time, and join the picture once `gl.compileAsync` has compiled their shaders on a layer no camera draws (`viewer/RoadFurniture.tsx`, `viewer/Viewer.tsx`); stills wait for them. Shared geometries/materials per kind, one texture per symbol, all paint in one line-segments draw, point lights only for "Dark with street lights" and at most 8 (nearest the impact). This covers the deferred "cap dynamic street-lamp lights".
- **Lazy loads** (also deferred above): `estimateSun` moved to `@csd/core/sun` (tz-lookup) and the stroke geometry to `@csd/core/icon-strokes`, so neither is in the core index. The viewer imports both statically, so they arrive with its chunk. `SceneQuestions` loads the estimate when its panel first opens, and the 2D diagram loads the strokes on demand. Two unit tests now open the panel before reading the estimate (`apps/web/test/questions.test.tsx`), with the same assertions.
- Numbers and method: `docs/VIEWER-LOAD.md`, "Road features and questions".

# Handoff — 2026-10-11, road features and questions

The 10:40 PM scope supersedes the earlier full-polish plan: privacy, crosswalk performance, braking provenance and plain map wording only. All work stays on `codex/questions`; `codex/road-features` remains at `31db17b`. No push, deployment, provider request, live-site test or desktop browser control.

- Privacy (`9f55c81`): example nodes and every retained way coordinate are within 250 m of the actual scene pin. Road ends are interpolated at a conservative circle boundary; original interior node IDs survive, boundary points have no invented node IDs, disconnected runs and cut building/parking polygons are omitted. The requested four-term `git grep -i -E` in `examples/` returns zero matches. Regression tests also check distance and clipped-node connectivity.
- Crosswalk performance (`d59e176`): one WeakMap result per network, early return with no marked crossings, polygon bounding boxes before exact line clipping, overlapping road spans unioned once. No 0.2 m sampling. Tests cover overlapping/disconnected spans, no intersection and reuse of nonempty and empty results.
- Braking (`0746717`): generic physics/default patches do not create claimant answers; explicit controls supply recollection provenance. Regression coverage includes the summary and actual PDF. User-facing map text spells out OpenStreetMap.

Local t-bone measurements, median of seven fresh headless Chromium contexts at 1440×900 on the same local fixture server: viewer-ready **2,130 ms before / 2,318 ms after (+8.9%)**. This does not demonstrate an end-to-end load improvement. Crosswalk first-call CPU median (12 networks, including road-art construction) **472.8 / 224.7 ms**, with repeat access **271.7 / 0.0008 ms**. The datasets changed with privacy trimming, so this is a combined before/after comparison, not an isolated algorithm benchmark. Raw results are in `qa-output/benchmarks/before.json` and `after.json`; reproduce with `scripts/benchmark-road-features.mjs` against localhost only.

Validation at handoff: `./check.sh` passed typecheck, ESLint, stylelint and design-token checks; the full unit and browser run was completed later on the release tree (PROGRESS.md). Focused privacy/mapdata/clipping tests passed (187); subsequent state/feature checks passed (25). Built-in privacy scan passed on the implementation tree (764 files); the owner separately confirmed privacy-scan and grep-private pass. The full private-term file is unavailable; the explicit four-term example scan was run independently.

Deferred: correct the attribution files (including upstream endpoint and obsolete retained-tag note), document the tag whitelist, consolidate the two braking controls, group legend entries by street name, revert the requested diagram street-filter change, undo `design/` edits, cap dynamic street-lamp lights, lazy-load timezone lookup and feature geometry, update remaining v3 documentation and add the v4 ADR. The hand-restored lane-change tag was removed by the strict privacy filter; its old attribution note still needs removal. Final question visual QA after the answer-row move and cache trimming is also deferred: earlier 12-case captures exist, but they do not verify this final tree. Do not treat the historical green road-feature handoff below as validation of the current branch.

# Optional questions on current main (2026-10-11)

The deferred questions are implemented on `codex/questions`, created from the existing local `origin/main` (`07f6e07`) with `codex/road-features` merged. The road-features branch remains at `31db17b`. The newer vehicle picker, media and paint work is retained. No push, deploy, live-site test or provider request was made in this pass.

Scene lighting, weather and visibility, plus every per-vehicle recollection, live in separate question components with one render hook in each host. Every question can be skipped with Not sure. Scene v4 opens v3 files through an additive migration, preserving vehicle identity, paint and physics inputs without inventing answers. Lighting estimates use the pin's offline time zone and approximate solar position, including sunrise/sunset on that local date; uncertain or ambiguous clock times remain unknown. Estimates never become claimant statements without a selected answer.

Lane choices use explicit OSM tags near the current pin, including named roads in older files without road IDs, and remain unknown at ambiguous count boundaries. Both braking controls stay synchronized; parked vehicles retain the recollection while braking is applied only when moving. Swerving stays a note. Rain, snow, fog and lighting change appearance, without changing the separately entered road surface. Only mapped lamps light up; schematic night fill keeps the illustration readable.

The scene has an expandable icon strip; the review summary and PDF show each answer with an icon and explicit claimant attribution. No signal timing or fault assessment is introduced. PDF overflow retains recollections, photos and the other sections without overlapping the footer. Tests exercise every answer in the summary and actual PDF text, v3 migration, solar boundaries, pin-local counts, optional controls and parked/braking edits.

Verification is in progress: focused tests and independent diff reviews pass. The final local screenshot matrix and sequential `./check.sh` are still pending; this entry will be updated with their results before handoff.

Local QA is reproducible with `e2e/questions-visual.spec.ts` on a fixture build: `QUESTIONS_VISUAL=1`, a localhost `BASE_URL`, projects `desktop` and `phone`. It blocks external browser requests and covers all three examples at 1440/390 in both themes, all four steps, start/impact/rest, expanded question panels and scene answers, the summary, PDF/JSON and three PNG exports. The intersection also covers all 16 lighting/weather combinations. `python3 scripts/review-feature-captures.py qa-output/questions` rasterizes every PDF and makes contact sheets. Artifacts stay ignored under `qa-output/questions/<example>-<width>-<theme>/`.

Findings outside question ownership: the existing start camera can leave approaching vehicles outside the frame (`qa-output/questions/highway-rear-end-1440-light/review-start.png`), and the parking example repeats indistinguishable directions for unnamed aisles (`qa-output/questions/parking-lot-backing-1440-light/vehicles.png`). Camera and direction-picker code were not changed. Phone Driver controls remain unavailable in the existing responsive UI; this pass does not claim to verify them.

The older “what remains” list below is historical and is superseded by this entry.

# Previous handoff — road features first (2026-10-11)

Implemented and locally committed the authored SVG icon set; tagged OSM controls, crossings, lanes, turns, one-way arrows, speed annotations and lamps; the one authorized proxy recapture of all three examples; low-poly furniture and shared map/diagram/export symbols; and collision-free legend space. Schema v4, v3 migration, optional-question UI and claimant-labeled summary/PDF output are also committed as working foundation. Per the scope cutoff, optional-question polish below remains unfinished.

Verified: `E2E_PORT=4196 ./check.sh` is green — typecheck, lint, stylelint, design tokens, build, 1,644 unit tests and 357 browser tests (46 skipped). The separate local 12-case screenshot/export run passed; every final capture and rasterized PDF was visually inspected. Built-in privacy checks passed (private-term matching was unavailable, as detailed below). No push, deployment, live-site testing, gh/Netlify commands, desktop browser control, secrets or identifying user data were used. Vehicle identity, photos, logos and vehicle colors were not changed.

## What is represented

- Only explicit OSM tags create features. Missing tags remain unknown. Road-wide speed/lane/turn tags are annotations, not invented sign positions. No signal timing or claimant-colored signal simulation.
- Models use schematic real-world sizes; OSM control points are not surveys of physical pole positions. Untagged facing remains null in the data and is labeled unknown; the mesh orientation is schematic.
- Turn arrows need an established directional lane count. A total alone never becomes an assumed equal split. Shared center lanes are kept clear.
- Crossing paint needs a mapped path and explicit markings, and is clipped to the modeled road surfaces. Missing or unmarked crossings remain map symbols.
- SVGs, UI, Three.js colors and exports use existing tokens. Scene and OSM strings use text nodes or drawing primitives, never HTML. Browser requests stay on the own-origin proxy; the visual audit blocks outside URLs.

## Optional questions: what remains

Do not call the full optional-question scope complete yet.

1. Compact scene icons still need distinct visible yes/no/not-sure states and separate visibility-issue glyphs; tooltips/accessibility text and the summary/PDF carry the full answers now.
2. Lane choices need further pin-local refinement on merged roads whose lane counts vary. The current conservative function returns unknown if merged segments disagree, and measures the tangent near the cache origin rather than a moved pin. It does not offer an invented count.
3. Review the braking recollection versus the existing parked/maneuver reducer so later maneuver changes cannot leave contradictory retained recollection/physics states.
4. Complete dedicated visual QA for every lighting/weather combination and all-question answers, including nighttime lamp appearance and long mobile icon rows. The current example matrix exercises the examples' automatic lighting in both UI themes, not every environmental choice.
5. Extend solar-boundary tests to polar and date-line locations before calling the automatic prefill fully validated. Missing, invalid and DST-ambiguous local times already remain unanswered.

Implemented tests cover v3 migration without invented answers, every optional answer in the summary and actual PDF text, and PDF overflow with four vehicles. Questions are optional and default to “Not sure”; estimates do not become claimant statements until explicitly selected.

## Visual audit and reproducible local artifacts

The opt-in `e2e/road-feature-visual.spec.ts` visits all four steps, Top/Driver A/Driver B, start/impact/rest, and exports PDF plus diagram/impact/rest PNGs. Run against a fixture build on localhost only, with `FEATURE_VISUAL=1`, projects `desktop` and `phone`, and `--output=qa-output/playwright-visual` so it does not conflict with check.sh. `scripts/review-feature-captures.py` rasterizes every PDF and creates contact sheets offline. Captures remain ignored local files in this worktree, rather than repository binaries.

Each directory is `qa-output/road-features/<example>-<width>-<theme>/`, where example is `t-bone-intersection`, `highway-rear-end` or `parking-lot-backing`, width is `1440` or `390`, and theme is `light` or `dark`. It contains `location.png`, `vehicles.png`, `review-start.png`, `review-impact.png`, `review-rest.png`, `view-top.png`, `view-driver-a.png`, `view-driver-b.png`, `save.png`, the actual PDF/JSON/three PNG exports, PDF page rasters and contact sheets.

All 12 final sets were visually inspected through their contact sheets, including every exported PNG and rasterized PDF. The phone layout exposes only Top/Wide: the phone files named `view-driver-a.png` and `view-driver-b.png` remain Top, so they do not establish mobile Driver-view verification. Desktop Driver views were inspected in both themes. The legend/scale overlap found in PDFs was fixed and covered with all three real caches.

The privacy scanner passed its built-in checks. No `.privacy-terms` file exists in this worktree, so the scanner explicitly skipped private-term matching; this is not a claim that that optional check ran.

## Findings outside this session's ownership

- At the five-second start, existing camera framing can leave approaching vehicles outside the picture (particularly the highway) or clip a vehicle at the edge (parking). See `qa-output/road-features/highway-rear-end-1440-light/review-start.png` and `qa-output/road-features/parking-lot-backing-1440-light/review-start.png`. Camera behavior was not changed.
- The parking example's existing direction choices repeat indistinguishable “Northbound”/“Southbound” entries for different unnamed aisles. See `qa-output/road-features/parking-lot-backing-1440-light/vehicles.png`. Direction/card controls were not redesigned.
- Dark-theme vehicle/ground colors and identity dropdown behavior belong to the other session. This pass changes only road-furniture contrast; see the paired light/dark `view-driver-b.png` and `vehicles.png` captures for comparison.

Earlier captures showed sticky headers in the middle of full-page images when taken after an auto-scroll; the capture harness now scrolls to the top first. Phone captures use CSS-pixel scale to avoid Chromium's oversized-raster failure. These were capture issues, not changes to the other session's layouts.
