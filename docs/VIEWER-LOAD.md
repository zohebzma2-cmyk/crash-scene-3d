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
- **Scripts:** kept outside the repo, in the session scratchpad (`measure.mjs`, `profile.mjs`, `runall.sh`).

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
