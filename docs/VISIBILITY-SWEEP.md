# Visibility sweep: "some scenes don't show both vehicles"

Phase 1 (2026-10-10): reproduce and diagnose. **No viewer behavior was changed.** The only app change is a read-only,
test-build-only addition to the existing `window.__csdViewer` hook (see "Harness").

## Result in one paragraph

The bug reproduces, at both widths, in Chromium and WebKit alike. It is not one bug but five distinct causes in the camera
framing, plus two smaller ground-height defects. The one people meet first: **the Review step opens on Top, and on its first
visit plays the approach from 5 s before impact. At that moment at least one vehicle is outside the Top picture in 291 of 302
scenes (1440) and 293 of 302 (390), and both are outside in all three examples**, because Top and Wide frame only the impact
and the rest positions (cause C1). At the moment of impact and at final rest, Top or Wide still loses a vehicle in 78 of 302
scenes on desktop and **174 of 302 on a phone**. On a phone this is mostly the bottom-left overlays (legend, compass and zoom
buttons) sitting on the crash (C5, 158 scenes), the highway example's opening picture included. In the rest, long post-impact
slides shrink the vehicles to specks or push them out entirely (C4, 73 desktop / 87 phone scenes).

## Method

- **Real viewer.** The fixtures build (`VITE_FIXTURES=1`), served by `vite preview`, driven by Playwright. Chromium uses
  SwiftShader WebGL. WebKit was spot-checked on the three examples (144 vehicle views). Its verdicts were identical to
  Chromium's, view for view.
- **Scenes.** The 3 examples plus 300 random valid scenes. They come from the physics property tests' fast-check
  arbitraries (`packages/core/test/property/arbitraries.ts`, seed `20261010`), restricted to the three example road
  networks, and kept only when `simulate()` accepts them on the network the fixtures build loads for that pin. That took
  about 2,400 candidates. Each random scene is opened the way a person would: Save, then "Open a saved scene file", then
  Review. One of the 300 (`random:20261010#406`) was refused by the app although `simulate()` in Node accepted it, so 302
  scenes were measured.
  The mix: 118 highway, 93 t-bone, 92 parking-lot; 279 with two vehicles, 24 with three or four; every type, road
  condition and action; speeds up to 150 mph.
- **Cameras × times × widths.** Desktop 1440×900: Top, Wide, Driver A, Driver B, Aftermath. Phone 390×844 (Pixel 7): Top,
  Wide and Aftermath, because the phone has no driver views. Each camera was measured at start (`Home`, 5 s before impact),
  impact (`I`) and final rest (`End`), using the real keys, with reduced motion so camera moves are instant.
  Every measurement is taken with the page scrolled to the top, as a person arriving on Review sees it. Keyboard focus on
  the timeline scrolls the page, and an earlier run that skipped this blamed the sticky header unfairly.
- **Checks, per vehicle, from the live scene graph and camera** (`e2e/visibility/probe.ts`):

| Check | Fails when |
|---|---|
| missing | group not in the scene graph, hidden up the chain, zero scale, or no drawable mesh |
| behind-camera / near-clip | whole box behind the camera / part of it nearer than `camera.near` |
| out-of-frame | under 60% of the projected box (hull of its 8 corners) inside the canvas |
| too-small | in frame but under 40 px² on screen |
| under-terrain | bottom more than 0.10 m (center) or 0.35 m (worst corner) below the drawn ground mesh |
| behind-building | more than half of 14 sight lines from the body to the camera cross a building (ray vs. triangles) |
| under-ui | more than half of its on-canvas part under painted page UI (chips, HUD, caption, labels, dots, sticky bars) |
| off-page | more than half of its on-canvas part outside the window |
| no-pixels | in frame, yet hiding the vehicles changes under 15% of the pixels inside its hull (ground truth) |

**Totals: 15,336 vehicle views in 7,248 camera states over 302 scenes.** 1440: 9,585 views, 3,089 failing. 390: 5,751
views, 2,839 failing. No vehicle was ever missing from the scene graph or invisible as an object, so the mesh, the
material and the scene graph are fine. Every failure is about where the camera is or what covers the picture.

## Failures by cause

The counts are failing vehicle views. One view can fail for more than one reason, and Scenes counts distinct scenes.

| Cause | Views | Scenes | 1440 | 390 | Where |
|---|---|---|---|---|---|
| **C1** Top and Wide frame impact + rest only; at start the vehicles are outside | 1,942 | 298 | 960 | 982 | Top@start 1,061, Wide@start 881 |
| **C2** Aftermath keeps its final-rest framing when time moves back | 1,177 | 298 | 550 | 627 | Aftermath@start 1,042, @impact 135 |
| **C3** Driver chase camera: the other vehicle is behind the camera, the camera is inside it, or it is off to the side | 814 | 271 | 814 | n/a | start 366, impact 134, rest 314 |
| **C3b** Driver chase camera: the other vehicle is behind a building | 114 | 47 | 114 | n/a | mostly @start (84) |
| **C4** Long post-impact slides: the framed area is huge, so vehicles become specks; past 900 m the camera is clamped and they leave the frame | 1,393 | 92 | 597 | 796 | Top/Wide/Aftermath at every time |
| **C5** Picture overlays (legend, compass, zoom buttons, view chips) over the vehicle | 645 | 205 | 38 | 607 | Top@impact 116, Wide@impact 139, Aftermath@impact 97 |
| **C5b/c** Phone action bar over the bottom of the picture / picture below the fold | 55 | 46 | 0 | 55 | when a warning pushes the picture down |
| **C6a** Vehicle drawn at height 0 outside the terrain grid (up to 9 m under the drawn ground) | 249 | 26 | 156 | 93 | vehicles more than 250 m from the pin |
| **C6b** Yaw-only body on steep ground: a corner up to 2.3 m in the ground | 360 | 42 | 225 | 135 | off-road start poses on embankments |
| **C7** Fixed camera: a vehicle that ends against a building is hidden by it | 3 | 1 | 2 | 1 | Wide/Aftermath@rest |

At impact and final rest, the moments Top and Wide promise to frame, a vehicle fails in 78 desktop scenes (C4 73, C6a 7,
C6b 7, C7 1) and in 174 phone scenes (C5 158, C4 87, C5b 12, C6a 7, C6b 7, C7 1).

## Root causes

### C1: Top and Wide never frame the start of the timeline
- `apps/web/src/viewer/math.ts:67-77` (`framingPoints`) frames each vehicle at impact and at rest. Only Wide adds the pose 2 s
  before impact, capped at 25 m back (`WIDE_APPROACH_S`/`WIDE_APPROACH_MAX_M`, `math.ts:43-45`, `approachPose` `:55`).
  Top (`math.ts:205-212`) and Wide (`:213-223`) fit that set and nothing else. DESIGN.md §7 says exactly this ("impact, rest,
  and in Wide the last 2 s of the approach").
- The camera is fitted once per view or reset (`Viewer.tsx:129`, the key is view|reset|camera|vehicle count). It never moves
  with time.
- The timeline starts 5 s before impact. A 30 mph car is 67 m away then, and a highway follower at 55 mph is more than 120 m
  back. The first Review visit plays the approach from there (`ReviewStep.tsx:111-117`), and `Home` or scrubbing goes there.
  The highway follower is even behind the Wide camera at start, because Wide looks along the crash from behind the approach.
- Seen: `example:t-bone-intersection` Wide at start, with A and B both 0% in frame
  ([c1-tbone-wide-start-1440.png](visibility/c1-tbone-wide-start-1440.png)).

### C2: Aftermath frames only what happens after impact, but stays on when time moves back
- `effects/aftermath.ts:15-27` (`aftermathBox`) holds the impact point, the poses from impact to rest and the debris.
  `aftermathSpec` (`math.ts:169-180`) fits it.
- `ReviewStep.tsx:161-164` (`chooseView`) seeks to final rest only when Aftermath is chosen. A later `Home`, `I` or play keeps
  the Aftermath camera while the vehicles drive in from outside it.
- Seen: `example:t-bone-intersection` Aftermath at start ([c2-tbone-aftermath-start-1440.png](visibility/c2-tbone-aftermath-start-1440.png)).

### C3 / C3b: the driver views are a chase camera on one vehicle only
- `math.ts:194-203`: the eye is `max(9, 1.4·L+4)` m behind the vehicle and 3.2 m up, looking 6 m ahead along its heading.
  Nothing takes the other vehicles into account.
  - In a rear-end, the follower is exactly where Driver A's camera sits. At impact it fills the bottom of the picture, cut
    open (34% in frame in `example:highway-rear-end`). At rest the camera is inside it (near-clip, nearest corner -4.8 m).
  - In a side impact, the other vehicle comes from the side at start and ends to the side at rest, so it is out of view.
  - At start the other vehicle is often round a corner behind a building: `example:t-bone-intersection` Driver A at start,
    B 100% blocked, 0 of 721 pixels change when it is hidden.
- Seen: `random:20261010#32` Driver A at impact ([c3-r32-drivera-impact-1440.png](visibility/c3-r32-drivera-impact-1440.png)),
  and the t-bone example Driver A at start ([c3b-tbone-drivera-start-1440.png](visibility/c3b-tbone-drivera-start-1440.png)).

### C4: long post-impact slides blow the framing up, and the orbit controls clamp it
- Top, Wide and Aftermath fit the rest poses wherever they are. Snow and ice, plus speeds the schema allows (up to 150 mph),
  give slides of 50 m up to 2.5 km. Top spans reach 2.9 km.
  - Of the 92 scenes: 59 have no vehicle over 80 mph. Road conditions are ice 44, snow 24, wet 17, dry 7.
  - Framed spans: under 100 m in 28 scenes, 100–200 m in 31, 200–700 m in 26, over 700 m in 7.
  - Specks: `random:20261010#3`, a motorcycle at 55 mph on snow in the parking lot, slides 95 m. At impact it is 30 px² in
    Top, sitting under its own label dot near the view chips ([c4-r3-top-impact-1440.png](visibility/c4-r3-top-impact-1440.png)).
    Under-UI by the label dot is a symptom of the same thing.
- `Viewer.tsx:540`: `<OrbitControls maxDistance={900}>`. three-stdlib's `update()` clamps the radius every frame
  (`OrbitControls.js:222-225`), so a preset that needs more than 900 m is pulled in toward its target, the middle of a
  multi-kilometre box, and both vehicles leave the frame.
  - Seen: `random:20261010#284`, pickups at 85 and 150 mph on ice. Wide at impact shows an empty road
    ([c4-r284-wide-impact-1440.png](visibility/c4-r284-wide-impact-1440.png)).
- Beyond about 250 m the vehicles also drive off the map data: the terrain grid is ±250 m and the ground mesh ±300 m. That
  feeds C6a.

### C5: the framing ignores the overlays drawn on top of the picture
- Every fit uses the whole canvas, centered: `TOP_FILL` and `WIDE_FILL` (`math.ts:104-105`), `fitDistance` (`math.ts:120-136`)
  and `AFTERMATH_FILL`. The overlays take fixed corners:
  - the view chips, top right
  - the HUD, bottom left: the legend plus the compass and zoom row (`viewer.css:40-48`), which is sticky above the action
    bar on phones (`styles/responsive.css:40`)
  - the caption, bottom right
- On a 390 px canvas the HUD covers about 60% of the width and the bottom quarter of the height. A crash that is long
  north–south (Top) or seen along its length (Wide) puts the impact in that bottom band.
- The label layout already measures these rectangles (`Viewer.tsx:212` `OBSTACLES`, `measureObstacles` `:417-428`). The
  camera does not use them.
- Seen: `example:highway-rear-end` on a phone, Top at impact, which is the opening picture: B is 57% under the legend
  ([c5-highway-top-impact-390.png](visibility/c5-highway-top-impact-390.png)). `random:20261010#5`, Wide at impact on a
  phone: A 74% and B 89% under the legend, with the action bar over the bottom edge
  ([c5-r5-wide-impact-390.png](visibility/c5-r5-wide-impact-390.png)).
- C5b: when a warning card pushes the picture down on a phone, its bottom goes under the fixed "Looks right" action bar
  (`.panel-foot`).

### C6: two ground heights
- C6a: `heightAt` (`math.ts:23-33`) returns **0** outside the terrain grid (`:27`). The ground mesh carries the edge heights
  outward instead (`scene-geometry.ts:74-79`, `terrainHeight`). Vehicles (`vehicle-view.tsx:68`), outlines, paths and cameras
  use `heightAt`, so past 250 m from the pin a vehicle is drawn up to 9 m under the drawn ground (`random:20261010#118`,
  `#89`).
- C6b: bodies only turn about the vertical (`vehicle-view.tsx:68-73`). On an embankment a corner sinks up to 2.3 m
  (`random:20261010#188`). This happens mostly at off-road start poses the physics warns about.
- Neither hides a vehicle: the ground layers draw with no depth test (`scene-geometry.ts:24`, `World.tsx`), and the pixel
  check confirms the vehicles still reach the screen. In perspective they look sunk or displaced against the roads.

### C7: one scene where a building hides a vehicle in a fixed view
- `random:20261010#770`: A stops against a building, and from Wide's south-south-east side the building is in front of it
  (93% of sight lines blocked, 66 of 496 pixels). It is rare: one scene.

## Proposed fixes (not implemented; for the owner to choose)

| # | Fix | Where | Needs a DESIGN.md change? |
|---|---|---|---|
| C1 | Fixed cameras follow time when a vehicle would leave the safe frame. While the person hasn't moved the camera, Top and Wide refit to impact + rest + **the vehicles' current poses** whenever one would fall outside, easing back to the crash framing by impact. The alternative is to frame the start poses from the outset, which keeps the camera still but makes the crash much smaller on highways. | `math.ts` `framingPoints`/`cameraFor`, `Viewer.tsx` `Rig` (key at `:129`) | Yes, §7 framing rule |
| C2 | Aftermath is the final-rest picture, so moving the time off final rest leaves it (back to Wide), the same way picking a preset leaves it. The alternative is to include the current poses in its box. | `ReviewStep.tsx` `chooseView` and timeline seek/play, or `aftermath.ts` | Yes, §7 Aftermath |
| C3 | Driver views keep every vehicle in frame. The yaw stays on the driver's heading; the distance and elevation come from `fitDistance` over all vehicles' current boxes. The eye never goes inside or just above another body (raise it over the follower in a rear-end). Elevation rises until the sight line to the other vehicle clears the building footprints and heights, a pure-TS 2.5D check. If the owner prefers a true driver's perspective, the sweep can exempt "other vehicle" there instead. | `math.ts:194-203` | Yes, §7 driver views |
| C4 | (a) Never clamp a preset: set OrbitControls `maxDistance` from the preset's own distance, at least the current 900. (b) Frame only the crash itself when the slide is very long: impact, the vehicles at the current time and a bounded part of the slide, with a floor on vehicle size (say 12 px long). The rest of a long slide is followed in time rather than shrunk to fit. (c) Separately, the owner may want the physics or schema to cap the 1–2.5 km slides; that is out of viewer scope. | `Viewer.tsx:540`, `math.ts` framing, `aftermath.ts` | (b) yes |
| C5 | Fit into the **safe area**: the canvas minus the overlay rectangles the labels already measure (chips, HUD, caption, and the phone action bar when it overlaps). Fit to its size and shift the target, or use `camera.setViewOffset`, so the crash centers in it. | `math.ts` fit functions take an inset; `Viewer.tsx` passes `measureObstacles` rects | §7: "fills 60–70% of the *unobstructed* view" |
| C6 | Use one height function everywhere: `heightAt` clamps to the grid edge, as the ground mesh does, or vehicles, paths, ring and cameras sample the ground surface itself. Tilt each body to the plane through its four wheel heights, or at least lift it to the highest corner. | `math.ts:23-33`, `vehicle-view.tsx` | No |
| C7 | When a building hides a vehicle in a fixed view, try the other side or a steeper elevation, picking the azimuth with clear sight lines. The alternative is to fade that building. | `math.ts` Wide/Aftermath azimuth | No |

Once fixed, the sweep becomes the permanent test. The gate comes off, `check.sh` runs the small default, and a deep run
(`SWEEP_N=300`) runs before releases. The limits for start times and for "other vehicle in a driver view" follow whatever
the owner decides for C1–C3.

## Harness

- `e2e/visibility-sweep.spec.ts`: the sweep. It is opt-in for now because it fails today, which is the point:
  `SWEEP=1 npx playwright test e2e/visibility-sweep.spec.ts` runs the examples plus 6 random scenes, and `SWEEP_N=300 ...`
  is the deep run (about 70 min with 4 workers on SwiftShader).
  - Options: `SWEEP_SEED`, `SWEEP_PIXELS=0`, `SWEEP_BATCH` (scenes per page, default 4).
  - `SWEEP_OUT=<dir>` writes one JSONL row per vehicle view, the scene files and failure screenshots.
  - It runs on the desktop and phone projects. WebKit runs with `E2E_FULL=1`.
- `e2e/visibility/scenes.ts`: the seeded scene list (the examples plus accepted random scenes) and the scene-file builder.
- `e2e/visibility/probe.ts`: the in-page measurements (geometry, buildings, terrain, UI) and the pixel check.
- `apps/web/src/viewer/Viewer.tsx`: `window.__csdViewer.three()` returns the live scene, camera, canvas size and vehicle
  groups. It is **read-only**, and installed only where the hook already is (dev server or `VITE_FIXTURES=1` build). The
  `ProbeSource` component that feeds it is rendered only in those builds.

Run notes: the machine was heavily loaded during the deep run. Four desktop batches (scenes 257–272) hit the test timeout
and were rerun on their own; their rows replace the partial ones. Raw data, the analysis scripts and full-size screenshots
were kept outside the repo.
