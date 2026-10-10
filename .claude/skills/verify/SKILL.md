---
name: verify
description: Run full verification for crash-scene-3d — check script, production build on a local server, browser screenshots of every example at desktop and phone width — and report pass/fail. Use before saying a change is done or before asking to push.
---

# verify

Run every step even if an earlier one fails, then report. Do not fix anything during the run.

## 1. Preconditions
- If `package.json` is missing, report "Not scaffolded yet: no package.json" and stop.
- If `node_modules` is missing, run `npm install` first.

## 2. Static checks
Run `npm run check` (typecheck + lint + unit tests). Record pass/fail and the first errors.

## 3. Build and serve
- Run `npm run build`. Record pass/fail.
- If the build passed, start the preview server in the background:
  `npm run preview -- --port 4173 --strictPort`
- Wait until `curl -sf http://localhost:4173/` succeeds (give up after 30 seconds and record a failure).

## 4. Browser checks
Run `npx playwright test e2e/examples.spec.ts`.

That spec must:
- discover every folder in `examples/`,
- load `http://localhost:4173/?example=<name>` for each,
- wait for the page to signal the scene is ready,
- fail on any console error, page error, or a blank WebGL canvas,
- save screenshots at 1440px and 390px wide to `test-results/screens/<name>-1440.png` and `<name>-390.png`.

If the spec does not exist yet, record "e2e spec missing" as a failure.

## 5. Clean up
Stop the preview server you started. Leave no background processes.

## 6. Look at the screenshots
Read every screenshot. Note anything visibly wrong: empty scene, vehicles off-screen, overlapping or clipped UI, horizontal scroll on phone width, missing disclaimer.

## 7. Report
A table with one row per step (check, build, server, each example at each width): PASS or FAIL plus a one-line detail. Then the screenshot paths and visual notes. End with an overall PASS only if every row passed.
