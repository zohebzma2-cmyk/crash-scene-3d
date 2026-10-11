# PROGRESS — crash-scene-3d real build

**Read this and `git log --oneline -20` before doing anything.** Pick up exactly where it says. Don't redo verified work. The lead integrates on `integ/m2` (worktree .claude/worktrees/m2), which is squash-merged into main.

Plan: approved 2026-10-09; the plan file is kept outside the repo. The summary below is the source of truth if that file is gone.

## Hard rules (apply to the lead and every agent, regardless of session settings)
This build session was started from the home folder, so the repo's `.claude/settings.json` permissions and hook are **not loaded**. These rules are enforced by hand, without exception:
- **Ask Zoheb first** before `git push`, any `gh` command, `npm publish`, or any deploy (`netlify`, `vercel`, `wrangler`, `firebase`, including `npx` forms).
- **No destructive git:** no `git push --force`/`-f`/`--force-with-lease`, `git reset --hard`, `git clean -fdx`, `git checkout -- .`/`git restore .` over uncommitted work, branch deletion of unmerged work, or history rewrites of shared branches.
- **No `rm -rf`.**
- **Never read secrets:** no `.env` or `.env.*` files, nothing under `~/.ssh`.
- **No hook:** after editing TypeScript, run `npm run typecheck` and the related tests yourself.

## Status (updated 2026-10-09, Milestone 0 DONE, Milestone 1 starting)

### Done and verified
- **Design locked** (d8f22d0).
- **Scaffold** (2589627). npm 11 workspaces with pinned tooling:
  - TypeScript 6.0.3, Vitest 5.0.1, ESLint 10, stylelint 17, Playwright 1.63.
  - Configs and check.sh.
  - Reviewer on Opus with the deeper checklist.
- **Contracts locked** (c4fc1b9, 88df122) in `packages/core/src/contracts/`:
  - Scene v3 (zod), RoadNetwork, SimulationResult, exports, proxy routes and ProviderConfig.
  - Viewer interface in `apps/web/src/viewer/types.ts`.
  - Implemented: canonical JSON + SHA-256, presets with sources, physics constants, the formatter.
  - Stubs (throw "not implemented"):
    - physics/placement/projection/streetsAtPin/lanePath (core)
    - mapdata parse/search/terrain
    - exports
    - proxy
- **Examples** (ec3686f): 3 made-up scenes on real Nashua roads with cached Overpass JSON + 3×3 Terrarium z15 tiles + ATTRIBUTION.md. Validated by test.
  - t-bone-intersection: Main St northbound at 342°, Park St one-way westbound at 252°.
  - highway-rear-end: Everett Tpk northbound at 358°, 5 lanes, 55 mph.
  - parking-lot-backing: aisle at 92°, B backing facing 2°.
- **Tests:** 16 passing (contracts, formatter, examples).
- **Hook demo done (2026-10-09).**
  - The deliberate `const HOOK_DEMO: number = "not a number"` in canonical.ts made the hook print `TS2322` and exit 2. After the revert it exited 0 silently.
  - NOTE: the hook only fires in sessions started inside the repo. This session started in ~, so it was run with the real payload. Agents must run tsc and vitest themselves.

### Milestone 1 (in progress)
Four Sonnet agents, each in its own git worktree (`isolation: worktree`), based on 88df122.
- **A physics + projection** (packages/core physics, placement, lanePath, streetsAtPin, checkScene). Phase 1 = failing tests only, then stop for Zoheb to see them.
- **B mapdata + proxy** (packages/mapdata, packages/proxy, netlify/functions). Netlify Blobs has onlyIfNew/onlyIfMatch + strong consistency, so a true global slot is feasible.
- **C app shell + 4-step flow** (apps/web except src/viewer), with Zoheb's fix list.
- **D exports** (packages/exports).
- **Me: viewer** on branch `feat/viewer` in the main checkout (apps/web/src/viewer).
- Branch and worktree names: see "Agents and worktrees" (filled in as agents report).

### Next
- Show Zoheb A's failing tests, then let A implement.
- Opus reviewer on each branch, then merge, then integration (Milestone 2).

## Agents and worktrees
| Agent | Scope | Branch / worktree | State |
|---|---|---|---|
| A | physics + projection | MERGED: v2 (c35ca9c/844d764) and physics 3.0 squash e4cdf8f (reviewed x6, final 7546b1d) on main; main 1141 tests green. | DONE |
| B | mapdata + proxy | MERGED into main (a227311, reviewed SHA 1465b0d). main verified: 178 tests, tsc, eslint. | DONE |
| C | app shell + flow | MERGED into main (ae9fabe, reviewed x4, final SHA bef2e2a; main 867 tests, lint, build). Now on walkthrough items (braking control, Measure options, minimap, phone search). | IN PROGRESS |
| D | exports | feat/exports MERGED (0ed554b) + feat/exports-2 MERGED (e83d994, reviewed SHA 2748392). main: 264 tests, tsc, eslint. | DONE |
| E | break-it tests | feat/breakit @ cc2bbcb (worktree .claude/worktrees/agent-a85a4bb2ff3f7ca62) | 154 new tests + 20 physics-gated. Plain messages for every bad scene field; fileClaim/printable hardened. Opus review running. E resumed: real calendar dates + no future, canonicalJson depth cap, parseOverpass NaN guard. A on feat/physics-2: defensive input validation (OOM at 1e6 mph, negative speeds), track cap, ocean-pin refusal. |
| F | deploy prep, NO deploy | chore/deploy-prep (worktree .claude/worktrees/agent-a0d5fd6fbd831d902) | netlify.toml hardened, functions bundle OK (0.95 MB), Blobs works locally, verify-headers 84/0/3 (3 = local static Cache-Control), e2e/csp.spec.ts (only violation: zod eval probe, fix = z.config jitless), docs/AUDIT.md (0 prod vulns) + DEPLOY.md. F resumed: netlify-cli via pinned npx not devDep, no prod sourcemaps, [dev] off 5173. Then Opus review. |
| G | README draft | MERGED into main (e9ebb1c; reviewed x2, 08a0f61 = reviewer's exact one-line fix). | DONE |
| me | viewer | feat/viewer (main checkout ~/Developer/crash-scene-3d) | in progress |

## Running
- **Fast plan + showcase status (01:55):** all merged into integ/m2 after Opus review (blockers fixed and re-reviewed): compass, tips, one-tap fixes, property tests + parser fuzz, Chromium/WebKit e2e + axe + zip checks; showcase: docs/decisions (8 ADRs), .githooks/pre-commit + scripts/privacy-scan.mjs + /release-check (hook NOT activated: `git config core.hooksPath .githooks` is Zoheb's call), docs/demo.gif, docs/RED-TEAM.md (finding 1 fixed: exports say when the picture uses another hit side), README "How this was built". Showcase step came from Zoheb's showcase.md, relayed by his other session. Next: final check.sh, squash into main, address/coordinate checks, ready-to-publish summary. Nothing public.
- **Fast plan status (01:30):** merged into integ/m2 after Opus review: night/compass (review blocker fixed: a new view cancels a compass turn), night/props (no blockers), night/fixes (3 blockers fixed and re-reviewed: count limits by vehicle count, every simulate counted, parked-to-moving labels show the speed), night/e2e3 (no blockers). night/tips is fixing its review blocker (first-visit layout with a tip shown) by 01:45. Known gaps for README Next version: about 1 in 5 refused scenes get only "Edit the details myself" (mostly 3-4 vehicle zones-cannot-touch); worst fix search ~1.75 s on the main thread (Web Worker); parking Driver A label/pill overlap (test.fixme); textarea combobox aria-allowed-role (test.fail).
- **FAST PLAN (Zoheb, 2026-10-10 00:10, replaces the overnight plan): about 2 hours, deadline 02:11 EDT, agents stop at 01:20.** Local only. Scope: compass; one tip per step; one-tap fixes (hit side, direction or action; no sketches); fast-check over 1,000 scenes + parser fuzz; Playwright Chromium + WebKit at 1440/390, axe on every step, zip test. Firefox, dark matrix, visual baselines and the proxy load test moved to README "Next version" (load agent stopped). Anything unfinished at the deadline goes to "Next version"; then check.sh, squash to main, address/coordinate checks, "ready to publish" summary.
- (superseded) **OVERNIGHT (Zoheb, 2026-10-10): local only, nothing public until he approves in the morning.** Six agents in their own worktrees (.claude/worktrees/night-*, branches night/*, all from integ/m2 e546f4a); Opus reviewer before each merge into integ/m2; then squash integ/m2 into main again, re-run the address/coordinate checks, and stop with a "ready to publish" summary.
  - night/compass (Sonnet, port 4311): north arrow on location + mini maps and PDF/PNG diagrams; 3D compass that rotates with the camera, click resets to north-up; own icon set, tokens only.
  - night/tips (Sonnet, 4312): first-time hints on every step, dismissible, remembered per device, "Show tips", accessible, mobile, DESIGN.md.
  - night/fixes (Opus, 4316): "We can't draw this yet" gets up to 3 ranked one-tap fixes with sketches + "Edit the details myself", one-sentence why, every refusal code covered, property test that each suggestion draws; hit-side-only fix may ride "See it anyway" with a note on Review. Tip copy wired at integration.
  - night/props (Opus): fast-check physics properties (momentum, typed speed = impact speed, no pass-through, slides end, all finite, deterministic) over thousands of scenes; scene-file parser fuzz.
  - night/e2e3 (Opus, 4314/4315): Chromium/Firefox/WebKit x 1440/390 x light/dark, axe on every step, visual regression baselines (regenerate after UI merges: npm run e2e:update-snapshots), full ZIP check.
  - night/load (Sonnet): proxy rate-limit load tests with fake upstream and clock.
  - Step 1 tail done (e546f4a): no home-folder, plan-file or scratch paths in the tree. caffeinate keeps the Mac awake.
- **FINAL STATE (2026-10-09, late):** all of Zoheb's final 7 are on integ/m2:
  - (1) claim town c976ee6; (2) dents wording a8cab10 + 6aca776, which shortened the rigid-bodies/damage sentences and lowered MIN_DIAGRAM_FRACTION to 0.3 so all 3 example PDFs fit one page; (3) PDF map labels 31d9dbe; (4)+(5) stills framing and Aftermath labels b5de895; (6) answered in chat; (7) map fallback fill 95094a5.
  - The e2e update (test/e2e-2) is merged (d4026e5). Its 5 real app bugs are fixed in 98f3531: Review shows sim.warnings with zone-used first; 3D pills follow the Measure switches; "X and Y, Town" crossing filter; phone Search button beside the field; phone logo 20px for dark contrast. The phone header shows the whole claim number (15a52d4).
  - Wrap-up (Zoheb): the personal street in tests is replaced by a made-up pair in a made-up town; the 204 cached OSM tiles are deleted (test mode draws the map from road data); the parking example moved to the Target lot on Amherst Street (captured through the proxy). integ/m2 is squashed into main as one commit; main is published only after Zoheb approves each step.
- **Zoheb's final 7 (2026-10-09):** (1) claim-town crossing -> C fix/claim-town; (2) assumptions match dents -> A fix/assumption-dents (from main); (3) PDF map card out of map + pin street labels -> D fix/pdf-map-labels; (4) stills framed tight + no clipped names, (5) aftermath label crowding -> V fix/stills-labels; (6) T-bone explanation answered in chat (physics verified: car keeps its own forward speed, ~26 mph after vs SUV ~13 mph; slide ~ v^2); (7) test-mode map edges drawn fallback -> M fix/map-fallback-fill. Then e2e update (test/e2e-2), check.sh, squash integ/m2 -> main, final link.
- **E2E vs integrated trial:** 99 pass / 47 fail / 4 skip (most = fixed bugs still marked test.fail + suite expecting old UI: 5 downloads vs zip, old map/phone). e2e agent updating on test/e2e-2 from integ/m2; real bugs to be reported. Static checks (tsc, eslint, stylelint, tokens, contrast 56/56) green on integ/m2.
- Physics 7546b1d (bodies-overlap in zone fallback, 45/135 deg tie-break) merged to trial; tiny Opus check running.
- **Trial integrated (integ/m2 @ 649e713+):** V viewer, X impact/aftermath, R roads/parking, M real map, C search+speed field, B proxy search, L logo, D pdf fixes, physics-2 (pending blocker fix), e2e suite (test/e2e) all merged; 1361 vitest pass. Before/after shots were kept locally (not in the repo). main has: mapdata, proxy, exports, physics (v2), README, deploy-prep, breakit, app shell, search (squashed 154dbcd).
- **History hygiene before ANY push:** fix/crossing-search history (a260b2a etc.) contains removed recordings of a personal street; integ/m2 merged it. Squash-merge integ/m2 into main (as done for search) so no removed data reaches the public repo.
- **Open:** A physics blocker (face-patch crush band, 3-vehicle touch) + 'See it anyway' dead end; Wide view vehicles small on the highway; e2e test.fail items to flip after fixes.
- **Downloads fixed (Zoheb, 2026-10-09):** Save delivers ONE file: a lone file, or one stored ZIP (crash-scene-<claim>.zip) of PDF + PNGs + JSON; if building outlasts ~3 s tap window, button becomes "Download your files". Save waits up to 10 s for the 3D view before stills; pictures always requested (missing still reported). e2e/download.spec.ts: 6/6 (3 examples x desktop/phone) catches the real download, unzips, checks PDF pages (1-2, overflow announced), embedded Plus Jakarta + JetBrains Mono, disclaimer and fingerprint on every page = SHA-256 of downloaded JSON, PNG sizes. WebKit desktop + iPhone 15 emulation: zip downloads. Trial builds now use --emptyOutDir=false so open tabs don't lose chunks. Physics 3.0 assumptions push T-bone/highway PDFs to 2 pages (allowed by rule) - D could tighten.
- Merged into integ/m2: fix/viewer-visuals (V), fix/crossing-search (B, Opus security review running), fix/search-map (C), feat/physics-2 (A; review asked for push-point midpoint fix + wording, A working).
- **Impact + aftermath (Zoheb, 2026-10-09):** X (Sonnet, worktree .claude/worktrees/effects, fix/impact-effects from integ/m2): display slowdown ~0.25x within +-0.25 s, shake, seeded debris burst + field, dentGeometry by hit zone scaled by delta-v (0 <3 mph .. 0.35 m at 40+), skid marks (post-impact + braking), 'aftermath' camera/timeline view used as final-rest export still; reduced motion respected; no people/gore. A: yaw model documented (omega0 = sum(r x J)/I, alpha = mu*g/k), optional VehicleResult.impact {deltaVMps, contactPointM, normal, spinRadps, zoneHit, leadingZone}, README + PDF assumption. Opus hand-check of yaw after A lands.
- **Search + map (Zoheb, 2026-10-09):** Photon type-ahead via /api/geo/suggest (debounce 300 ms, >=3 chars, cached, token buckets), cross-streets dropdown via /api/geo/cross-streets (Overpass), Nominatim fallback on submit; big real OSM map (near full width / full screen on phones with Expand), pinch/ctrl-scroll zoom, Locate me (Permissions-Policy geolocation=(self)), USGS satellite toggle only if free, pin + chosen streets highlighted; fixture tiles ~200 cached OSM tiles for the example areas. B = proxy/data on fix/crossing-search; C = UI on fix/search-map (from main). DESIGN §5/§9 + CLAUDE updated on integ/m2 (26cc456).
- **Logo (Zoheb, 2026-10-09):** official InsurifyAI mark from insurifyai.app/bimi/insurifyai.svg (path fill #2369D7) + wordmark per logo-full.png; header, PDF, PNGs, favicon; README trademark note. Agent L in worktree .claude/worktrees/logo (fix/official-logo from integ/m2). Dark mode: 'Insurify' uses --color-text, mark + 'AI' stay #2369D7 (flagged to Zoheb).
- **Momentum (item 3):** not a bug; normal-only impulse lets struck car keep its forward speed. Fix = Brach planar impact with contact friction mu_c 0.5 (analysis kept locally). A implementing on feat/physics-2 (PHYSICS_VERSION 3.0.0). T-bone A 38-49 -> ~26-37 ft, B 4-10 -> ~5-11 ft, B rotates ~31 deg.
- **Walkthrough (M3) 29 findings** routed: V (stills capture P0, stills labels P0, dark lighting, off-screen labels, nested focus, phone measures, ghosts, legend, tap labels, shadow warn, '0 mph'), R (ground covers road P0, lot invisible P0, doubled Main St, 3D street names), C (braking control + Review mention, Measure tab options, minimap, phone search), D (map card, done on fix/pdf-map).
- Reviews running: app-shell bef2e2a (focus), fix/pdf-map 71d499a.
- **Zoheb's trial feedback round (2026-10-09), 10 items, all in flight:** before shots kept locally (18 PNGs). (1) overlap at impact = RENDER only (physics pen 0.000 m in all 3) -> V; (2) low-poly models -> V (fix/viewer-visuals); (3) T-bone momentum split -> Opus analysis, then A implements; (4) labels attached/auto-offset -> V; (5) wheel scroll/zoom -> V; (6) focus ring keyboard-only -> C (feat/app-shell); (7) highway carriageways + parking stalls -> R (fix/roads-render); (8) PDF map center/render -> D (fix/pdf-map from integ/m2); (9) 'Main St and Amherst St' search live via netlify dev -> B (fix/crossing-search from main); (10) clip markings -> R. Then re-run walkthrough 1440/390 x 3 and before/after shots.
- **M2 TRIAL (Zoheb's call, 2026-10-09: full speed, nothing idle):** branch integ/m2 in worktree .claude/worktrees/m2 = feat/viewer + feat/physics + feat/app-shell (as-is, re-merged as fixes land). Fixtures build served at http://localhost:4190 (vite preview, background). Only reviewed SHAs go to main. Opus e2e agent on test/e2e (from integ/m2) and Opus walkthrough agent (screens kept locally) running against :4190. Agent C's own preview holds :4173.
- Worktree .claude/worktrees/main-merge has main checked out (own node_modules). Merge reviewed branches there, then `git merge main` into feat/viewer.
- Scratch worktree .claude/worktrees/integ-trial (branch scratch/integ-trial = main + physics + exports) for integration trials; has its own node_modules. Not for merging.
- Vite dev for the viewer harness: `apps/web` on :5174 (`/viewer-dev.html?example=…&view=…&t=…`), started in the background by the lead.
- Old prototype server: `node design/prototype/scripts/serve.mjs` on :5180, possibly still up from the design phase.

## Decisions
- **Feature freeze + speed policy (Zoheb, 2026-10-09):** freeze after impact/aftermath; new ideas -> README "Next version" (satellite toggle + locate me cut there). One agent per piece with strict file ownership; full Opus review only for physics and security-sensitive code (proxy, parsing, CSP/headers); visual-only changes reviewed by screenshot; integrate continuously on integ/m2; one-line status per milestone.
  Ownership: A physics (packages/core/src/physics, contracts/simulation.ts, README physics) | X impact visuals (viewer/effects/*, Timeline aftermath hook) | V vehicles/labels/camera/zoom (Viewer.tsx, vehicle-models.ts, math.ts) | R roads/parking (scene-geometry road fns, World, exports diagram lanes) | B proxy+mapdata (packages/proxy, packages/mapdata, contracts/proxy.ts, examples/*/tiles) | C search UI + braking (SearchPanel, combobox, services/geo.ts, VehicleCard braking) | M real map (LocationMap, MiniMap, fixture tile serving) | L logo DONE (merged to integ/m2 f8cd155) | D pdf map DONE on integ/m2.
- **Parallel side work (Zoheb, 2026-10-09):** integration stays sequential with the lead; E/F/G run on main in their own worktrees (Sonnet), Opus reviewer before merge, nothing pushed or deployed.
- **Speed meaning (Zoheb, 2026-10-09):** the typed speed IS the speed at impact. Physics works backwards from impact over a 5 s window (APPROACH_S 5). Braking = slowing down INTO the crash, never stopping before it. My call: braking lasts the final 1.5 s (BRAKING_S), steady speed before; flagged to Zoheb. Question copy: "About how fast at the moment of the crash?". Assumptions + PDF say "speed at impact, as entered". Test: typed speed == speed at impact, always. Highway example reworked. DESIGN §5/§7/§8/§14 + prototype updated.
- **Tile rate (Zoheb, 2026-10-09):** approved. Tiles and terrain: per user burst 64, refill 16/s, plus a global bucket (burst 256, refill 64/s). Tiles cached at least 7 days (terrain 30), honoring OSM cache headers with ETag/If-Modified-Since revalidation. CLAUDE.md rule 6 updated. B told.
- **User-Agent contact (Zoheb, 2026-10-09):** crash-scene@insurifyai.app doesn't exist. The contact is https://github.com/zohebzma2-cmyk/crash-scene-3d, held only in ProviderConfig. B told; fetch-fixtures.mjs fixed on feat/viewer.
- **Gaps (Zoheb, 2026-10-09):** list only vehicle pairs that actually touched at impact. `SimulationResult.gaps` holds only those pairs (A told). D renders whatever gaps are present.
- **PDF assumptions (Zoheb, 2026-10-09):** never drop or cut any assumption or warning. Shrink text first, but never below **8 pt**. If it still doesn't fit at 8 pt, move the FULL assumptions list to a second page and print "continued on page 2" in its place. D will be told with the review fixes.
- Real public road geometry for examples is OK. Never house numbers or personal data. People and claims are made up.
- Every outside call (Nominatim, Overpass, tiles, Terrarium terrain, NHTSA vPIC) goes through our proxy; CSP `connect-src 'self'`.
- Reviewer, e2e, walkthrough and break-it tests run on Opus. The four builder agents run on Sonnet.
- Installs: use `npx -y npm@11.20.0 install` (npm 10 crashes on Vitest's peer set).
- No push or deploy until Zoheb has looked.

## Open problems
- **Viewer Wide framing:** DONE (WIDE_APPROACH_S = 2 in math.ts, tested). Check in Milestone 3 screenshots that vehicles driving in from the edge read well.
- **Integration trial (scratch/integ-trial = main + all 5 branches):** 520/520 tests pass. Conflicts: apps/web/src/vite-env.d.ts (keep the VITE_FIXTURES interface) and scripts/fetch-fixtures.mjs (take mapdata's, reads DEFAULT_CONTACT). tsc: 3 errors where app-shell builds ExportBundle without the new required skipped/notes (fakes.ts:315, save.test.tsx:17, services.test.ts:161). Fix at real merge.
- **Told Zoheb (my call, reversible):** any save with a PDF or PNG always includes the scene JSON too, so the fingerprint printed on them can be checked.
- feat/viewer also has: the browser CanvasFactory (apps/web/src/exports/browser-canvas.ts) and DESIGN §8/§9/§11 updates.
- D contract requests (decide at merge): add `skipped?` to ExportBundle (accept); BrandFonts = TTF/OTF/WOFF only, fontkit can't subset WOFF2 (accept, document).
- D: the app must provide a browser CanvasFactory (OffscreenCanvas + FontFace). 3D stills should be captured at 1920×933 so stills + footer = 1920×1080.
- **Decision for Zoheb (B):** tiles get 16 slots/s and terrain 16 global / 12 per user, instead of 1/s. A map view requests ~20 tiles at once. Nominatim, Overpass and vPIC are strict 1/s globally and per user.
- B: footprints are open rings; the contract comment says "closed". Clarify the contract wording at merge.
- `npm audit` reports issues in the dev tree; review them before Milestone 4.

## night/e2e3 (2026-10-10): browser test matrix
- Projects: Chromium `desktop`/`phone` run every spec; `webkit-desktop`/`webkit-phone` run the `@xb` subset (`npm run e2e`), everything with `npm run e2e:full` (E2E_FULL=1). Firefox, dark-mode project matrix and visual baselines were dropped from scope (Zoheb, 00:11).
- New specs: `e2e/axe-steps.spec.ts` (axe, every impact, every step, light + dark), `e2e/engines.spec.ts` (what each engine draws; no-WebGL fallback), `e2e/download.spec.ts` rewritten (every file in the zip).
- Fixed: disclaimer bar outside landmarks (now a labeled `<aside>`), Review summary headings h3 -> h2.
- Known bug (test.fail): `<textarea role="combobox">` search box, apps/web/src/components/SearchPanel.tsx:341-349 (axe aria-allowed-role).
- Known bug (intermittent, pre-existing): parking example, Driver A view at final rest, B's label overlaps measurement pill 2 (apps/web/src/viewer/Viewer.tsx:206); set aside by exact pattern in examples.spec.ts, test.fixme'd on its own.
- Known (WebKit) fixed: Learn more now focuses itself so the About dialog returns focus to it on close.

## live/search (2026-10-10): search on the live site (branch live/search, NOT deployed; Zoheb approves the redeploy)
- Root causes: (1) the claim's town was only looked up for "A and B" with no other area, so a plain "Main St" on a fresh page went to Photon with no bias (no pin, map at zoom 4) and came back Lyons, CO; (2) picking a street sends /api/geo/overpass (roads preview) and /api/geo/cross-streets 300 ms apart, and the caller's 1 req/s Overpass slot refused the second at once (429); (3) "A and B, Town" ignored the town.
- Fixes: claim town looked up on the first keystroke (geo.town, state-checked) and waited for; far results last with " — far from the claim"; geo.streetIn for a typed town; proxy waits up to 2 s for the caller's Overpass slot (still 1/s per user and globally); Photon per-user bucket 12 @ 3/s (global unchanged); app retries a busy suggest/cross-streets once (Retry-After, cap 2 s, "Busy, trying again…"); no suggest requests while " and" is typed after a picked street; no cross-streets lookup for a pick's own label.
- Live-mode e2e: `BASE_URL=... npm run e2e:live` (playwright.live.config.ts, e2e/live/). Locally use `netlify serve` with `NETLIFY_LOCAL_MEMORY_STORE=1` from a normal clone: `netlify dev` serves Vite's dev page, whose inline preamble the CSP blocks (blank page), and the serve sandbox's Blobs gives no ETags, so its rate-limit writes are refused (tile 429s that production does not have).
