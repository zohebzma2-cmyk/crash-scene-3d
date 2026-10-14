# Release status (2026-10-14)

**Production = GitHub `main`**, deployed to https://crash-scene-3d.netlify.app from the same tree, after a draft deploy and the release smoke (docs/DEPLOY.md). Previous release: `75d71f6` (2026-10-12). Rollback: Netlify → Deploys → the 2026-10-12 deploy → "Publish deploy", and `git revert` the release commit on `main`.

**One release commit:** the four fixes (PDF, search, viewer, layout and link previews) and the docs were combined into a single commit on top of `75d71f6`.

**What shipped:**
- PDF: the top-down diagram shows the whole crash with the impact ring; the key to the road symbols runs under the caption, and the scale and north chip sits in a clear corner. The diagram PNG is unchanged.
- Search: type-ahead waits up to 7 s for Photon; a timeout or a second busy answer says "Suggestions are slow right now. Press Search to look it up."
- Viewer: catalog 3D models crumple on the face that was hit, from the impact on; scrubbing back undoes it.
- Phones: the catalog-model note sits under the timeline and can be closed.
- Save step: Back and "Save to my device" come right after the file choices; "Coming next" moved to the README's Next version; the PDF is described as "usually one page".
- Road condition: nothing is picked for a new visitor; the summary, Review and PDF say the road surface was not given, and the picture uses dry-road friction, which the assumptions list says (optional scene field `road.conditionNotGiven`).
- Link previews: a description, Open Graph and Twitter tags, `og.png`, `favicon.ico` and `robots.txt`.
- README: the demo GIF, MP4 and step pictures re-recorded from this build; the pitch and live link at the top; a License section; facts brought up to date.

**Checks on the release tree:** `./check.sh` (typecheck, lint, stylelint, design tokens, build): 2,198 unit and property tests and 575 browser tests passed (64 skipped); the privacy scan of the tree is clean; the release smoke passed on a draft deploy (40 passed; its 6 media checks skip on a draft, which has no media keys).

**Open after this release:** the highway example opens too far out in the Top view (a framing decision); the parking-lot example shows no crumple, because neither car's speed changes by more than 3 mph in the hit; the PDF's road-symbol key lists symbols outside the picture; the crossing-streets list does not use the new slow message; the PDF map thumbnail can show blank tiles in a corner when it is captured before every tile has loaded (seen on the 2026-10-12 release too).

# PROGRESS: handoff (updated 2026-10-14)

**Read this and `git log --oneline -20` before doing anything.** The release status above is the current state. Earlier, detailed progress notes are in this file's git history.

## Hard rules (for anyone picking this up, human or agent)
- **Ask the owner first** before `git push`, any `gh` command, `npm publish`, or any deploy (including `npx netlify-cli ... deploy`).
- **Push only `main`, and only on top of `origin/main`.** Never push the local branches `fix/*`, `feat/*`, `integ/*`, `codex/*`, `test/*`, `night/*`, `show/*`, `live/*` or `roundA/*`, or any older local `main`: older local history must not be published. Ship a single commit with the final tree on top of `origin/main` when a branch's history isn't clean.
- **No destructive git**: no force push, `reset --hard`, `clean -fdx`, or history rewrites of shared branches. **No `rm -rf`.**
- **Never read secrets**: no `.env` files, nothing under `~/.ssh`, and never read or print the Netlify environment values.
- **Before any push:** run the privacy scan (`node scripts/privacy-scan.mjs --tree HEAD` with your untracked `.privacy-terms`) and `./check.sh`.
- **Agents:** one worktree and one port each; never kill processes by name.
- **Our own runs against the live site** (added 2026-10-11, docs/PROXY-BUSY.md):
  - **They must not spend users' budget.** Any e2e spec run with a deployed `BASE_URL` answers `/api/vehicles/*` and `/api/geo/tile/*` inside the test (`e2e/live-guard.ts`, automatic through `e2e/helpers.ts`). Scratch live checks call `stubNonEssentialApi(page)` from that file.
  - **What stays live:** only the flows a live check verifies (search, crossing, Overpass, terrain), plus `e2e/live/vehicles.live.spec.ts`, which runs once after a deploy that touches the proxy or the vehicles step.
  - **Never** loop live checks, use `--repeat-each`, or run live suites side by side.
  - `E2E_LIVE_API=all` turns the guard off; that is for a deliberate full check by the owner only.

## What's live
- **Site:** https://crash-scene-3d.netlify.app (Netlify site `crash-scene-3d`). It is deployed from `main`, and GitHub `main` is the deployed commit.
- **Repo:** https://github.com/zohebzma2-cmyk/crash-scene-3d (only `main`).
- **Contents:**
  - The 4-step flow, the 3D viewer with the compass, and the tips.
  - The proxy, with the claim-town search bias, a per-user Overpass slot reservation (no 429s) and typed "A and B, Town".
  - Exports: one ZIP of PDF, PNGs and the scene JSON, all carrying the same SHA-256 fingerprint.
  - Fixer v2: wider fixes in a Web Worker, a regression corpus, and a "remembered fixes" memory that stays on the device.
- **Secrets set on Netlify (values never read):** `PROXY_USER_SALT`, and the CarImages and logo.dev keys for production only (drafts have none, so the smoke skips its media checks there).
- **`./check.sh` on the release tree (2026-10-14):**
  - 2,198 unit and property tests;
  - 575 browser tests on Chromium and WebKit at 1440 and 390;
  - 64 skipped (WebKit runs the `@xb` subset; plus the known fixme and opt-in cases).
  - **The release smoke** (`npm run smoke -- <url>`, `scripts/smoke.mjs`, added 2026-10-12) is the one unstubbed check: one person's flow, one take, Chromium 1440 then WebKit 390, real search, real vPIC, real media, then the saved files. Media is required against production and SKIP-on-miss on a draft (the CarImages/logo.dev keys are production-only). Release flow (docs/DEPLOY.md): build → Netlify draft (no `--prod`) → smoke → report → owner says "promote" → the same commit `--prod` + push `main` → smoke live → "last known good" note here.
- **In production:** the 2026-10-14 release (the release commit on `main`). Previous: `75d71f6` (2026-10-12). Rollback = Netlify "Publish deploy" on that deploy.
- **Live checks after each deploy:**
  - `BASE_URL=https://crash-scene-3d.netlify.app npm run e2e:live`, which covers search near the claim and, since 2026-10-11, typing two vehicles (`e2e/live/vehicles.live.spec.ts`; run once, see the hard rules);
  - `e2e/csp-steps.spec.ts` and `e2e/viewer-clear.spec.ts` against the live URL;
  - the examples, ZIP and fingerprint check on Chromium and WebKit, desktop and phone.

## 2026-10-11 night deploy (production, d4ae95c)
- Vehicle picker, photos/logos/GLB, colours, vPIC auto-type, loading state, PDF polish, busy-message fix, README demo. Road features + optional questions were NOT in it.

## 2026-10-12 release
- Part 1: Codex's road features + optional questions (scene v4, v3 migration) on main, first frame within 8% of base (was 2×), road-features e2e fixed properly. Codex's handoff notes: CODEX-NOTES.md (its own PROGRESS sections are in this file's history on `codex/questions`: "optional questions on current main" and "road-features handoff", 2026-10-11; its last green was `E2E_PORT=4196 ./check.sh`, 1,644 unit + 357 browser tests, 12-case visual audit inspected).
- Part 2: first-visit welcome dialog (§3 disclaimer word for word, focus trap, axe), header follows vehicle A, no made-up claim number, optional "Claim number", `?claim=` validated, exports without a number named by date and time, examples keep CLM-EX numbers, old files open.
- Part 3: directions from the roads (`directionChoices`), paths along the lanes (no straight lines across grass; short driveway entry allowed), inconsistent input fixed before Review with one-tap fixes, contact not overlap (GLB fitted to the footprint with a guard), impact ring beside the cars with a leader, paint chips that say "Catalog colour", one label wording ("Your car" / "Other car"), road-type matrix test, fixer corpus re-baselined (bar 70%, budget 440 checks / 2 M units). Review fixes a204191. Cut nothing from 1–3; roundabout turn choices and two fixer gaps are listed in README Next version.
- Integration fixes (mine): ring framed by the live camera; Top view centred above the legend and zoom buttons on phones (DESIGN §7); smoke script (`npm run smoke`).

## What's next (in order)
1. **Two more scene rules + the scenario corpus gate** (specs agreed 2026-10-12): RULE 1 vehicles stay on the road, including after the impact (obstacles in the physics; "Did A end up off the road?"; a Parked option); RULE 2 single-vehicle crashes ("What was hit?": objects from OSM, leaving the road, fixed-object physics, a 4th guard-rail example); `npm run check:scenarios` over Codex's `qa/scenario-corpus` (branch `codex/scenarios`, blocked on an approval prompt last night) wired into check.sh.
2. **Context questions** answered only from the OSM data at the pin (lanes, signal, sign, turn, speed limit, lot, conditions), schema minor bump, "As described" PDF section, fingerprint unchanged for old files.
3. **Crash damage + the real scene** (crumple on catalog models shipped 2026-10-14): crumple at the contact patch (animated, effects, stills caption; illustration wording only, CLAUDE.md rule 4) and signals facing traffic, signs, markings, kerbs, buildings with heights, trees, lamps, night and weather, a legend; instanced, mounted after the first frame.
4. **Realistic surroundings research spike** (Google 3D Tiles, Cesium, NAIP + OSM massing); if it needs a paid key, write the plan and move on.
5. **README demo with real catalog media**, recorded on the live site (check CarImages and logo.dev terms first; MP4 ≤ 15 MB, GIF ≤ 10 MB, caption).
6. The follow-ups in README "Next version" (fixer bench re-time, GLB fit-guard unit test, smoke Save navigation, makes retry after a 500, the fix-button flicker seen once under load, the rest of the camera framing fixes from docs/VISIBILITY-SWEEP.md).

## roundB/picker (2026-10-11, not merged)
- Year, make and model are WAI-ARIA comboboxes (`VehicleCombobox`), with aliases, typo tolerance and popular-first ranking from `packages/core/src/vehicle-names.ts`. Free text always works. `MakeLogo` renders in each make row once round B's images branch adds it.
- The proxy routes are unchanged in shape. The makes route also stores a make → vPIC kinds index, and the models route asks vPIC only about those kinds (Chevrolet 3 calls, Harley-Davidson 1, otherwise 4). The limiter is untouched (owned by polish/proxy-busy).
- vPIC has no trims and no makes-by-year list.
- "2019 chevy silverado" costs 1 makes request per session plus 1 models request (Chevrolet 2019) from the browser. Live vPIC calls 2019 Chevrolet pickups "Silverado" / "Silverado HD" / "Silverado LD"; the fixtures use "Silverado 1500".
- Tests: core `vehicle-names.test.ts`, proxy `vehicles.test.ts` (captured vPIC bodies in `test/fixtures/vpic`), web `vehicle-picker.test.tsx`, and e2e `vehicle-picker.spec.ts` (@xb, with axe on the lists open).
- Merged `live/integ` (polish/proxy-busy) on 2026-10-11 and reconciled: their service (session cache, retry before busy, per-topic wording, canonicalMake, abort on typing) with core's aliases; their parallel vPIC calls with the kinds index; unknown makes asked once typing stops; phones show the list in the page flow so it never covers Model.

## Open risks
- **Camera framing:**
  - Some views don't show both vehicles. In the sweep, a vehicle is off screen at impact or rest in 78 of 302 desktop scenes and 174 phone scenes.
  - The worst case is the phone legend covering a car in the highway example's opening picture.
- **The fixer reaches 84% of refused scenes, not the 95% target.** For three- and four-vehicle scenes it reaches about 70%.
- **Physics constants:** the contact friction and the crush band are typical values marked UNVERIFIED. Weights are class averages. The road is flat, and there are no secondary collisions.
- **Production only:**
  - The global rate limits depend on Netlify Blobs conditional writes, with no load test yet.
  - The daily cleanup of stored searches hasn't been seen running.
  - The live-tile path into the PDF thumbnail is checked by hand only.
- **Safari "Refused to apply a stylesheet" reports.** They weren't reproduced in WebKit and are likely a browser extension or a test tool. If they come back, check in a Private window with extensions off.
- **The privacy pre-commit hook exists but isn't on.** Turning it on (`git config core.hooksPath .githooks`) is the owner's call.

## Where things are
- **Decisions:** docs/decisions (0001–0011).
- **Benchmarks:** docs/FIXER-BENCHMARK.md.
- **Diagnosis:** docs/VISIBILITY-SWEEP.md.
- **Red team:** docs/RED-TEAM.md.
- **Deploy:** docs/DEPLOY.md.

## Round B: vehicle colours and catalog 3D models (branch `roundB/colors`, 2026-10-11, not merged or deployed)
- **Done:** optional `color {name, hex}` on each scene vehicle (schema v3, additive; absent = Not sure, fingerprints of older scenes unchanged); ColorPicker on the vehicle card (12 factory colours, Custom, Not sure); one helper `vehicleColor()` drives the 3D body, the mini map disc, the web diagram, the diagram PNG, the PDF diagram, the 3D stills and the PDF table ("2021 Honda Accord · Red" plus a swatch). Letters and outlines stay in the token colour; ink on paint is chosen for contrast. `PaintChip` ("Picked: Red") is the hook for roundB/images' VehiclePhoto.
- **Catalog GLBs:** `/api/vehicles/model` (roundB/images' route; `MODEL_ROUTE` in `apps/web/src/services/vehicle-models.ts` until it moves to `PROXY_ROUTES`), swapped in over our model when loaded, fitted to the footprint, tinted (named material / largest material / shader recolour of a paint baked in the texture / none for a dark paint), freed on change and unmount. Fixtures: `apps/web/fixtures/models/*.glb` from `node scripts/make-fixture-glb.mjs`.
- **Checks:** typecheck, lint, 1,660 unit tests, design tokens; e2e `colors`, `csp-steps`, `download` green on all four projects; `viewer-clear` green except the phone "Wide @ End: B Stopped label over B" flake, which also fails on b7edec1 (5 of 60 runs there).
- **Open for the owner:** dents are not drawn on catalog models; watermarked previews appear in the 3D stills; a dark catalog paint can't be retinted; README "Next version" round B line still says not started (update when the round B branches meet).

## fix/vehicles-step (2026-10-11, from live 71a69bf; not merged or deployed)
- **Late makes list:** a nickname typed while "Loading the makes…" is ranked again when the list lands; a make or model already left is resolved then (claim's own A make/model never renamed).
- **Catalog GLBs:** asked for on Review only; leaving Review cancels downloads still running (the service now aborts once every caller has given up) and they go at low priority. `?models=proxy` (fixture builds) puts them on the network for e2e.
- **Direction list:** unnamed roads are told apart by kind and place ("Northbound on the parking aisle (west one)"); `TravelChoice.roadDesc` and an optional `travel.roadDesc` (additive, fingerprints unchanged); core `roadWords`/`directionCaption` is the one formatter (list, caption, summary, PDF, fixes).
- **Phones:** colours are one sideways-scrolling row under 480 px (fades, picked swatch in view, arrow keys); type/action tiles put the icon beside the label from 380 to 479 px. T-bone Vehicles step at 390: 5217 -> 4465 px.
- **Picker leftovers:** alias-shadowed makes (vPIC "Harley") not listed; accents dropped before lookups (`asciiName`, `VPIC_MAKE_TEXT` shared with the proxy); "No matches. Press Enter to use what you typed."
- **Save second tap:** "Download your files" is focused and announced.
- **Not done here:** design/ (prototype, canvas) not updated for the phone layout (locked; owner's call).
