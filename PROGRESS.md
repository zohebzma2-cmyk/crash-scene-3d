# PROGRESS: final handoff (2026-10-10)

**Read this and `git log --oneline -20` before doing anything.** The build is closed out. Earlier, detailed progress notes are in this file's git history.

## Hard rules (for anyone picking this up, human or agent)
- **Ask the owner first** before `git push`, any `gh` command, `npm publish`, or any deploy (including `npx netlify-cli ... deploy`).
- **Push only `main`, and only on top of `origin/main`.** Never push the local branches `fix/*`, `integ/*`, `test/*`, `night/*`, `show/*`, `live/*` or `roundA/*`, or any older local `main`: older local history has data that must not be published.
- **No destructive git**: no force push, `reset --hard`, `clean -fdx`, or history rewrites of shared branches. **No `rm -rf`.**
- **Never read secrets**: no `.env` files, nothing under `~/.ssh`, and never read or print the Netlify environment values.
- **Before any push:** run the privacy scan (`node scripts/privacy-scan.mjs --tree HEAD` with your untracked `.privacy-terms`) and `./check.sh`.
- **Agents:** one worktree and one port each; never kill processes by name.

## What's live
- **Site:** https://crash-scene-3d.netlify.app (Netlify site `crash-scene-3d`). It is deployed from `main`, and GitHub `main` is the deployed commit.
- **Repo:** https://github.com/zohebzma2-cmyk/crash-scene-3d (only `main`).
- **Contents:**
  - The 4-step flow, the 3D viewer with the compass, and the tips.
  - The proxy, with the claim-town search bias, a per-user Overpass slot reservation (no 429s) and typed "A and B, Town".
  - Exports: one ZIP of PDF, PNGs and the scene JSON, all carrying the same SHA-256 fingerprint.
  - Fixer v2: wider fixes in a Web Worker, a regression corpus, and a "remembered fixes" memory that stays on the device.
- **Secrets set on Netlify (values never read):** `PROXY_USER_SALT`, plus two logo.dev keys for round B, which isn't built.
- **`./check.sh` on the final commit:**
  - 1,583 unit and property tests;
  - 353 browser tests on Chromium and WebKit at 1440 and 390;
  - 34 skipped (WebKit runs the `@xb` subset; plus the known fixme and opt-in cases).
- **Live checks after each deploy:**
  - `BASE_URL=https://crash-scene-3d.netlify.app npm run e2e:live`, which covers search near the claim;
  - `e2e/csp-steps.spec.ts` and `e2e/viewer-clear.spec.ts` against the live URL;
  - the examples, ZIP and fingerprint check on Chromium and WebKit, desktop and phone.

## What's next (in order)
1. **The owner's polish list (2026-10-10, after close-out):**
   1. PDF page 1 fills with as many assumptions as fit, and only the rest moves to page 2.
   2. The PDF "Hit on" column gets more room, or its note moves under the table.
   3. The PDF map thumbnail: street labels at the pin spaced apart.
   4. The diagram: the scale bar moved off the north arrow.
   5. The vehicles step: offer the same one-tap fixes as Review. An unpicked direction reads as a missing detail ("pick which way your car was going"), not "don't fit together". **Done on branch `polish/vehicles` (2026-10-11), not merged or deployed.**
2. **The camera framing fixes** from docs/VISIBILITY-SWEEP.md, in this order:
   1. fit into the unobstructed view, which matters most on phones;
   2. the 900 m orbit clamp;
   3. Aftermath turns off when the user scrubs;
   4. ground height.

   After those come the DESIGN §7 decisions (C1 start framing, C3 driver views). Then remove the sweep's opt-in gate so check.sh runs it.
3. **Round B:** the vehicle picker (vPIC type-ahead with aliases), maker logos through `/api/logos/make` (server-side, cached, with a fallback), vehicle colours in every view, and a write-up of the photo provider.
4. **The fixer review follow-ups and the rest of README "Next version".**

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
- **Decisions:** docs/decisions (0001–0009).
- **Benchmarks:** docs/FIXER-BENCHMARK.md.
- **Diagnosis:** docs/VISIBILITY-SWEEP.md.
- **Red team:** docs/RED-TEAM.md.
- **Deploy:** docs/DEPLOY.md.

## Round B: vehicle colours and catalog 3D models (branch `roundB/colors`, 2026-10-11, not merged or deployed)
- **Done:** optional `color {name, hex}` on each scene vehicle (schema v3, additive; absent = Not sure, fingerprints of older scenes unchanged); ColorPicker on the vehicle card (12 factory colours, Custom, Not sure); one helper `vehicleColor()` drives the 3D body, the mini map disc, the web diagram, the diagram PNG, the PDF diagram, the 3D stills and the PDF table ("2021 Honda Accord · Red" plus a swatch). Letters and outlines stay in the token colour; ink on paint is chosen for contrast. `PaintChip` ("Picked: Red") is the hook for roundB/images' VehiclePhoto.
- **Catalog GLBs:** `/api/vehicles/model` (roundB/images' route; `MODEL_ROUTE` in `apps/web/src/services/vehicle-models.ts` until it moves to `PROXY_ROUTES`), swapped in over our model when loaded, fitted to the footprint, tinted (named material / largest material / shader recolour of a paint baked in the texture / none for a dark paint), freed on change and unmount. Fixtures: `apps/web/fixtures/models/*.glb` from `node scripts/make-fixture-glb.mjs`.
- **Checks:** typecheck, lint, 1,660 unit tests, design tokens; e2e `colors`, `csp-steps`, `download` green on all four projects; `viewer-clear` green except the phone "Wide @ End: B Stopped label over B" flake, which also fails on b7edec1 (5 of 60 runs there).
- **Open for the owner:** dents are not drawn on catalog models; watermarked previews appear in the 3D stills; a dark catalog paint can't be retinted; README "Next version" round B line still says not started (update when the round B branches meet).
