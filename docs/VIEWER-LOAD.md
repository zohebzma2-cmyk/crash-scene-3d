# Viewer load: an example opened straight on Review

The owner's report (2026-10-10): opening `/?example=t-bone-intersection#review` shows a blank gray 3D box for about 6 to 10 seconds before the scene appears. Nothing says it is loading, so it looks broken.

This file records the numbers before and after the fix, with how they were taken.

## Method

- **Build:** a production build (`npm run build`, no `VITE_FIXTURES`), served by `vite preview --port 4421`, which gzips like Netlify does. This is not fixtures mode, so the example uses the live service path: the scene file chunk, then `/api/geo/overpass`, then the `/api/geo/terrain` tiles.
- **`/api` locally:** vite preview has no proxy, so the measuring script routes the two `/api` calls to the example's cached `osm.json` and terrain PNGs. It adds the latency the live proxy showed on the reference loads below: 250 ms for Overpass and 100 ms per terrain tile.
- **Browsers:** Playwright Chromium (headless; SwiftShader WebGL, as in the e2e) and WebKit, at 1440 × 900 and at 390 × 844 (DPR 3, touch). Reduced motion is on, so the approach doesn't autoplay.
- **Throttled runs:** Chromium only, through CDP. Network is DevTools "Fast 3G" (562.5 ms RTT, 1.44 Mbit/s down) and CPU is slowed 4×. WebKit has no throttling hook.
- **The clock:** time from navigation to the first rendered vehicle frame, which is `.viewer-canvas[data-ready="true"]`. A MutationObserver stamps every intermediate state. Every figure is the median of 3 runs.
- **CPU breakdown:** a CDP CPU profile from navigation to ready, on a source-mapped copy of the same build, with each sample's self time mapped back to its source file.
- **Live reference:** https://crash-scene-3d.netlify.app, 3 page loads in total (2 Chromium at 1440, 1 WebKit at 390), read-only. No further live loads were made: all repeat runs are local.
- **Scripts:** kept outside the repo.

## Before (main at 2deab93)

### Time to the first rendered frame (median of 3, ms)

| Engine | Width | Unthrottled | Fast 3G + 4× CPU |
|---|---|---|---|
| Chromium | 1440 | 2,978 | 12,348 |
| Chromium | 390 | 3,064 | 12,221 |
| WebKit | 1440 | 2,185 | n/a |
| WebKit | 390 | 2,190 | n/a |

Live site, Chromium 1440: 4,292 ms and 2,873 ms. Live site, WebKit 390: 2,716 ms.

### Timeline (Chromium 390, Fast 3G + 4× CPU, median run)

| ms | What is on screen | Why |
|---|---|---|
| 0–5,300 | A white page | The main chunk downloads: 746 KB gzipped (1.9 MB raw), about 1 MB of it pdf-lib, fontkit and their fonts, which only the Save step uses. |
| 5,545 | "Opening the example…" | The scene file chunk (1 KB). |
| 6,150 | "Loading the road layout…" | RoadsProvider waits its 700 ms pin-drag debounce, though nothing is being dragged. |
| 6,850–7,104 | (same) | `/api/geo/overpass` |
| 7,119–7,552 | (same) | Four terrain tiles, fetched one after another |
| 7,771 | The 2D diagram | The 3D code chunk only starts downloading now (Viewer, 268 KB gzipped), after all the data. |
| **10,102–12,221** | **The gray box (2.1 s)** | The 3D view mounts with `.viewer3d`'s ground color behind an empty canvas. Two main-thread tasks of 852 ms and 928 ms run before the first frame. |
| 12,221 | The scene | `data-ready` |

Unthrottled, the gray box lasts 1.1 s in Chromium (1,844 to 2,978 ms) and 0.33 s in WebKit. On a phone with a real GPU, the shader compile and the road geometry are what fill it.

### Where the CPU goes (Chromium 390, 4× CPU, self time to ready)

| ms | What |
|---|---|
| 974 | Shader compile and link: three's `onFirstUse`, waiting on the GPU for every program at the first render |
| 681 | Road art (`buildRoadArt`, mostly `ribbonExcess`), ground and lot geometry, terrain PNG decode |
| 262 | The rest of three: buffer uploads and the shadow map |
| 128 | `simulate()` |
| 109 | React and react-three-fiber |
| 56 | pdf-lib, leaflet and exports module evaluation (on the critical path, never used here) |
| 20 | zod |
| 14 | Effects (debris, skids, dents) |

At 1× CPU (1440): 1,086 ms is three (almost all of it the shader link wait), 202 ms is road geometry and 30 ms is `simulate()`.

### Chunk sizes (raw / gzip)

| Chunk | Size | Biggest parts |
|---|---|---|
| `index` (main) | 1,944 KB / 768 KB | @pdf-lib/fontkit 557, pdf-lib 215, react-dom 203, leaflet 145, @pdf-lib/standard-fonts 127, zod 84, physics 70, exports 66, pako 44 KB |
| `Viewer` | 1,017 KB / 277 KB | three 570, r3f 162, viewer 53, three-stdlib 23, effects 15, drei 4 KB |
| `pdf` (pdfjs, lazy) | 487 KB / 148 KB | |
| `fixer.worker` | 173 KB | |
| `index.css` | 82 KB / 17.5 KB | |
| fonts | 5 × 12 KB woff2 (Jakarta), 2 × 22 KB (Mono) | |

### Root cause

**What is gray:** `.viewer3d`, the 3D view's own box, painted `var(--color-scene-ground)` (`apps/web/src/viewer/viewer.css:2`), with the transparent WebGL canvas in front of it. It stays like that until react-three-fiber renders its first frame.

**Why the first frame is late:**
- Everything runs in one chain:
  1. the example scene (`App.tsx:39`);
  2. a 700 ms debounce meant for pin drags (`state/Roads.tsx:24`, `:48`);
  3. Overpass (`services/roads.ts:47`);
  4. the terrain tiles, one at a time (`services/terrain.ts:24-28`);
  5. only then the simulation (`review/useSimulation.ts:14-16`) and ReviewBody;
  6. only then the 3D chunk request (`review/SceneView.tsx:8`).
- When the canvas mounts, the road art and geometry are built synchronously in render (`viewer/World.tsx:15-20`), and every shader is compiled and linked during the first `gl.render`.
- The main chunk carries pdf-lib and leaflet (`services/index.ts:5`, the step components), which costs about 4.7 s of the throttled load before anything paints.

**Why there is no indicator:**
- SceneView's `<Suspense fallback>` (`review/SceneView.tsx:46-50`) covers only the chunk download. When the lazy `Viewer` resolves, the 2D diagram is swapped for the bare 3D box.
- From `<Canvas>` (`viewer/Viewer.tsx:526`) to the `Ready` frame hook (`viewer/Viewer.tsx:298-302`, `:546`), nothing is shown.
- The only "ready" signal is the `data-ready` attribute (`review/ReviewStep.tsx:171`), which nothing visual uses.
- **Failures:**
  - Nothing catches a failed 3D chunk or WebGL context: there is no error boundary, so React unmounts the whole app.
  - A lost WebGL context leaves the canvas frozen.
  - A failed example scene says "We don't have an example called …", which is wrong for a network failure.

## After (polish/viewer-load)

### What changed

**Loading state.** `review/ViewerStatus.tsx` draws "Building the scene…" with a progress bar and the four real stages: map data, terrain (counted by tile), 3D view (the viewer chunk) and drawing (until the first frame).
- **Where the stages come from:** `viewer/load-stages.ts` derives them from the app's own state:
  - the roads' status and per-tile progress (`state/Roads.tsx`);
  - the viewer chunk's status (`viewer/load-viewer.ts`);
  - the 3D view's first frame.

  So they can't drift from the real work. Each change sets a `csd:load:<stage>:<status>` performance mark.
- **Accessibility:** the headline and the current step are in a `role="status"` `aria-live="polite"` element. The spinner stands still with reduced motion, and the bar's transition uses a duration token, so it is 0 with reduced motion.
- **From the first paint:** an example link shows the picture's box with the status from the first render (`ReviewSkeleton`), and so does Review while its roads load.
- **No more gray box:** the 3D view draws its first frame hidden (`.viewer3d.is-building`) on top of the top-down diagram, and takes over only once it is drawn.

**Failure.**
- **3D code fails to load:** "We couldn't load the 3D view. Check your connection and try again."
- **WebGL fails to start** (r3f's error, caught by an error boundary): "The 3D view couldn't start in this browser, so this is the top-down diagram."
- **WebGL context lost:** "The 3D view stopped, so this is the top-down diagram."

Each of these shows over the diagram, which is the existing no-WebGL fallback, with Retry.
- **The 3D chunk's Retry:** it imports the same file under a fresh query. Chromium caches a failed module fetch, and WebKit fails a module whose preload failed.
- **The map data failing** is a notice with Retry while the picture is drawn without roads, which is how it already behaved, but now said out loud.
- **The example's scene file failing** says "We couldn't open the example…" with Retry. Before, it said "We don't have an example called …".
- **A step's chunk failing** shows Retry, which reloads the page.

**Faster.**
- **Boot preload** (`boot.ts`): with `?example=`, the scene file, then its roads and terrain, and the 3D chunk all start before React renders, in parallel. The Roads provider joins the running load (`shareRoadLoads`), and a just-finished load is handed out again rather than fetched twice.
- **No debounce on the first load:** the provider's first roads load goes at once. The 700 ms debounce is now only for pin moves.
- **Parallel terrain:** the tiles are fetched in parallel. They are decoded on a CPU-backed canvas (`willReadFrequently`): reading back from a GPU canvas had waited on the GPU while it started the 3D view, 540 ms of the throttled profile, now about 90 ms.
- **Road art early:** it is built while the 3D chunk downloads (`lib/roadArt.ts`).
- **Code splitting:**
  - Steps 1, 2 and 4 are lazy chunks (`steps.ts`); the next step's code loads once the current one is up.
  - The exports and pdf-lib are a lazy chunk (`services/index.ts`).
  - `viewer.css` moved into the main CSS, so the 3D chunk has no stylesheet to wait for.
  - `lib/thumbnail.ts` imports its one constant from `png-meta`, so the map's chunk doesn't pull in pdf-lib.

**Tried and dropped.**
- **Compiling the shaders before the first frame** (`renderer.compileAsync` with the frame loop held): no measurable change (5,558 vs 5,729 ms throttled, 904 vs 821 ms unthrottled, same long tasks), so it was left out.
- **Splitting out the effects:** they are 15 KB of the 1,018 KB 3D chunk, and they are part of the first frame (the dents show from t = 0, and the debris is already down with reduced motion). A separate chunk would add a round trip for nothing.

### Time to the first rendered frame (median of 3, ms)

The machine was shared with other agents, with a load average of 30 to 60. So the before and after were also run back to back, on the same build server setup, minutes apart:

| Engine | Width | Before, unthrottled | After, unthrottled | Before, Fast 3G + 4× CPU | After, Fast 3G + 4× CPU |
|---|---|---|---|---|---|
| Chromium | 1440 | 4,223 | **971** | 12,992 | **5,608** |
| Chromium | 390 | 3,714 | **854** | 12,616 | **5,597** |
| WebKit | 1440 | 2,242 | **843** | n/a | n/a |
| WebKit | 390 | 2,258 | **1,069** | n/a | n/a |

An earlier, quieter pair gave the same picture:
- **Before:** 2,978 / 3,064 / 12,348 / 12,221 / 2,185 / 2,190 ms.
- **After the structural fixes:** 821 / 785 / 5,557 / 5,729 / 776 / 775 ms.

| What you see | Before | After |
|---|---|---|
| First paint, throttled | 5,600 ms (white page until then) | 2,372 ms, with the status box in the picture's place |
| The bare gray box | 1.1 s (Chromium), 0.33 s (WebKit), 2.1 s throttled | never: the diagram and the status until the 3D view has drawn |
| Overpass request starts, throttled | 6,850 ms | 2,883 ms (with the 3D chunk already downloading since 2,283 ms) |

### Timeline after (Chromium 390, Fast 3G + 4× CPU)

| ms | What is on screen |
|---|---|
| 590–2,222 | Main chunk 103 KB gz, plus core 54 KB, CSS 18 KB and two small shared chunks, all in parallel |
| 2,310 | "Building the scene…": the box with the stages; the 3D chunk (269 KB gz), the scene file and the fonts start |
| 2,883–3,265 | Overpass, then the 4 terrain tiles at once (map data and terrain tick off) |
| 3,469 | The top-down diagram under the status box ("Loading the 3D view") |
| 4,947 | The 3D chunk is in ("Drawing the scene") |
| 5,597 | The first 3D frame: the status box goes, and the 3D view replaces the diagram |
| after | Save's and the vehicles step's code load in the background |

### Chunk sizes (raw / gzip)

| Chunk | Before | After |
|---|---|---|
| `index` (main) | 1,944 / 768 KB | **324 / 106 KB** |
| core (zod, physics), shared | in main | 172 / 56 KB |
| two small shared chunks | in main | 37 / 14 KB |
| `index.css` | 82 / 17.5 KB | 90 / 18.5 KB (now includes viewer.css and the status styles) |
| `Viewer` | 1,017 / 277 KB + 4.8 KB CSS | 1,018 / 277 KB, no CSS |
| exports + pdf-lib (lazy, Save) | in main | 1,200 / 530 KB |
| LocationStep + leaflet (lazy) | in main | 31 / 11 + 157 / 47 KB |
| VehiclesStep / SaveStep (lazy) | in main | 21 / 7.5 and 13 / 4.8 KB |
| pdfjs preview (lazy) | 487 / 148 KB | 487 / 148 KB |

**What an example link downloads before the 3D view**, gzipped JS and CSS: 1,064 KB before, 472 KB after. The location step's first load (most visitors): 785 KB before, 253 KB after.

### Where the rest goes

What's left on a throttled phone link:
- **About 1.6 s:** the main chunks over Fast 3G.
- **About 2.7 s:** the 3D chunk (three.js is 570 KB raw of it).
- **About 0.6 s:** building the first frame:
  - shader compile and link (SwiftShader, in the GPU process);
  - the road art (`ribbonExcess`, about 420 ms at 4× CPU, half of it now while the chunk downloads);
  - `simulate()` (about 120 ms at 4× CPU).

Starting the 3D chunk in parallel with the main chunk would need a separate tiny entry module. That would cost every visitor a round trip, so it was left as an option. Speeding up `ribbonExcess` is a `packages/core` change; it was left alone here.

### Review fixes (2026-10-11)
- **Saving after a failure:**
  - A failure (the 3D code, WebGL start, or a lost context) now settles the save's wait at once and sets `data-ready`, since the diagram is the picture. Before, a save after a failed 3D chunk waited 2 × 10 s.
  - Retry starts a fresh wait, so a save pressed right after Retry waits for the new first frame and keeps the 3D pictures.
- **Retrying the 3D code:** Retry only re-imports a same-origin `/assets/Viewer-*.js`; anything else, or a second failure, reloads the page.
- **Screen readers:** one live region for the whole step (`LoadAnnouncer`, mounted once by the app). It says each stage without tile counts, then "The scene is ready."
- **The boxes:** the loading and failure boxes sit top left with the notice, clear of the crash in the middle. When only the first frame is left (a cached revisit), the loading box waits 300 ms, so it doesn't flash.
- **Focus:** a step change focuses the new step's title even when its code is still loading (it waits for the title).
- **Background preload:** Save's code (pdf-lib) loads 2 s after the picture is up, in idle time, and leaving Review cancels it. This keeps its evaluation off a screen the person has already moved to.
  - **Correction (re-review):** the preload was a contributor to the map.spec:70 failure, not the cause. The reviewer cancelled the preload and the failure still reproduced. The cause was the test's fixed 500 ms wait after "+": the zoom does reach 19, just later under load. The test now polls the zoom and waits for the map's tiles to settle.
  - **No rIC timeout:** the preload's `requestIdleCallback` no longer has a timeout, which had forced it in the middle of the first visit's approach (+115 ms stall at 4× CPU). It also never starts while the timeline is playing; playing again cancels one that hasn't started.
- **The stage name:** "3D models" is now "3D view" (it is the code that draws the 3D view).
- **Failure banner on narrow screens:** under 480 px it says a few words ("3D view didn't load.") with Retry and is docked at the picture's bottom edge, clear of the crash. The full sentence stays for screen readers.
- **Retry clears `data-ready`** until the new 3D view has drawn.

### Catalog 3D models (after merging live/integ 672d527)
The round-B catalog models (GLBs through `/api/vehicles/model`) load with the viewer and are swapped in once they arrive. Nothing waits on them: `useCatalogModels` is async state, with no Suspense.

Measured on the production build, with the model route answering at once or after 3 s (median of 3, time to the first frame):

| Engine and width | At once | After 3 s |
|---|---|---|
| Chromium 1440 | 813 ms | 805 ms |
| Chromium 390, Fast 3G + 4× CPU | 5,647 ms | 5,668 ms |
| WebKit 390 | 755 ms | 754 ms |

So "Drawing the scene" hands over on the app's own models, and the GLB swaps in later.

### Road features and questions (integ/with-codex, 2026-10-12)
Codex's road features and optional questions (`8d4c463`) roughly doubled the time to the first 3D frame. This is the fix and its numbers.

**Method.** A fixtures build (`VITE_FIXTURES=1`, vite preview), t-bone example opened straight on Review. Chromium (SwiftShader) with 4× CPU and no network throttle, median of 3. Base is main at `d4ae95c`, built and served from its own worktree. Each pair was run interleaved (one load each in turn) on the same shared machine. The clock is navigation start to the moment `data-ready` is set, stamped in the page by a MutationObserver (as above). Wall time is from `goto` until Playwright sees the attribute.

| ms (median of 3) | 1440 | 390 |
|---|---|---|
| Before (`48e0ebd`), same run as After | 2,987 | 3,000 |
| After, same run as Before | 1,595 | 1,558 |
| Base (`d4ae95c`), same run as After | 1,527 | 1,530 |
| After, same run as Base | 1,640 (+7%) | 1,543 (+1%) |

- **Wall time:**
  - Before vs After: 3,464 vs 1,665 ms at 1440, and 3,482 vs 2,036 ms at 390.
  - Base vs After: 1,546 vs 2,071 ms at 1440, and 1,550 vs 2,018 ms at 390.
  - A 5-run pair gave Base vs After 2,140 vs 2,110 ms at 1440, and 1,979 vs 2,047 ms at 390.
  - The wall clock includes GPU-bound frames after `data-ready`, so it is noisier than the in-page stamp.
- **Draw calls:** main 94, Before 113 to 116, After 106 to 107. With the road features there are 14 shader programs, against 13 on main.

**Root cause.** The shaders at the first frame were the same as main's. One new program was the features' symbol (MeshBasicMaterial with a map). It linked inside the first frames, and three's link-status read waited about 1.3 s for SwiftShader to finish the frame.

**Fix.**
- **Road features after the first frame:** they mount once the view is shown, in idle time (at most 1.5 s later). They join the picture once `gl.compileAsync` has compiled their shaders on a layer no camera draws.
  - Stills wait for them (at most 5 s).
  - "Drawing the scene" still ends at the vehicles' first frame.
  - The one task left, about 260 ms at 4× CPU, runs about 1.2 s after `data-ready`.
- **Shared resources:** geometries and materials are shared per feature kind, with one texture per symbol.
- **One draw for the paint:** the crosswalks and turn arrows are a single line-segments draw.
- **Street lights:** lamps get point lights only for "Dark with street lights", at most 8, the nearest the impact.
- **tz-lookup** (73 KB) and the icon strokes (57 KB) left the main bundle:
  - Both now arrive with the 3D chunk.
  - The scene questions load the estimate when their panel first opens.
  - The core chunk went from 259 to 185 KB raw, and the fix worker from 252 to 180 KB.
- **Result:** the renders are pixel-identical to `48e0ebd` (all three examples: Top at 1440 and 390, and Driver A).
