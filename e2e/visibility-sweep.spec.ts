// The visibility sweep: every vehicle is really in the picture, in every camera, at start, impact and final rest,
// at 1440 and 390 (the desktop and phone projects), in the REAL viewer (fixtures build, SwiftShader WebGL).
//
// Scenes: the three examples plus SWEEP_N random valid scenes on the three example road networks (e2e/visibility/
// scenes.ts; seeded fast-check scenes from the physics property tests, kept only when simulate() accepts them).
// Each random scene is opened through Save's "Open a saved scene file", as a person would.
//
// For each vehicle (e2e/visibility/probe.ts):
//   missing        the group isn't in the scene graph, isn't visible all the way up, has zero scale or no drawable mesh
//   behind-camera  its whole box is behind the camera
//   near-clip      part of its box is in front of the camera and part nearer than the near plane (cut open)
//   out-of-frame   less than 60% of its projected box is inside the canvas
//   too-small      it is in frame but under 40 px² on screen
//   under-terrain  its bottom is more than 0.10 m below the drawn ground at its center (0.35 m at the worst corner)
//   behind-building more than half of the sight lines from points on its body to the camera cross a building
//   under-ui       more than half of its on-canvas part is under page UI (view chips, HUD, caption, labels, tips, bars)
//   off-page       more than half of its on-canvas part is outside the browser window
//   no-pixels      it is in frame, yet hiding it changes under 15% of the pixels inside its projected box
//
// SWEEP=1 npx playwright test e2e/visibility-sweep.spec.ts          (the small default: examples + SWEEP_N=6 random)
// SWEEP_N=300 npx playwright test e2e/visibility-sweep.spec.ts   (a deep run, about an hour on SwiftShader)
// SWEEP_SEED replays another seed; SWEEP_PIXELS=0 skips the pixel check; SWEEP_BATCH sets scenes per page (default 4).
// SWEEP_OUT=<dir> writes every measurement (JSONL) and failure screenshots there.
import { mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { isPhone, openExample, waitForViewer } from "./helpers";
import { pixelsInPage, probeInPage, type ProbeResult, type VehicleProbe } from "./visibility/probe";
import { sceneFile, sweepScenes, type SweepScene } from "./visibility/scenes";

type View = "top" | "wide" | "driver-a" | "driver-b" | "aftermath";
type When = "start" | "impact" | "rest";
const VIEW_KEY: Record<View, string> = { top: "1", wide: "2", "driver-a": "3", "driver-b": "4", aftermath: "5" };
const TIME_KEY: Record<When, string> = { start: "Home", impact: "i", rest: "End" };
const DESKTOP_VIEWS: readonly View[] = ["top", "wide", "driver-a", "driver-b", "aftermath"];
/** A phone shows Top and Wide (the driver views need the room) and the Aftermath button. */
const PHONE_VIEWS: readonly View[] = ["top", "wide", "aftermath"];
const TIMES: readonly When[] = ["start", "impact", "rest"];

export const LIMITS = { inFrame: 0.6, minAreaPx: 40, sinkCenterM: 0.1, sinkCornerM: 0.35, occluded: 0.5, ui: 0.5, offPage: 0.5, pixels: 0.15 } as const;
const PIXELS = process.env["SWEEP_PIXELS"] !== "0";
const OUT = process.env["SWEEP_OUT"] ?? "";
/** Scenes per test (one page each): opening the next scene reuses the page. */
const BATCH = Number(process.env["SWEEP_BATCH"] ?? 4);

export interface Failure { readonly check: string; readonly detail: string }

export function failuresOf(v: VehicleProbe, px: { changed: number; inHull: number } | undefined): Failure[] {
  const out: Failure[] = [];
  if (!v.exists || !v.drawable) { out.push({ check: "missing", detail: v.notDrawableWhy }); return out; }
  if (v.maxDepthM < v.near) out.push({ check: "behind-camera", detail: `whole box behind the camera (${v.maxDepthM.toFixed(1)} m)` });
  else if (v.minDepthM < v.near + 0.01) out.push({ check: "near-clip", detail: `nearest corner ${v.minDepthM.toFixed(2)} m, near plane ${v.near} m` });
  if (v.maxDepthM < v.near) { /* "behind-camera" already says it is out of the picture */ } else if (v.inFrameShare < LIMITS.inFrame) out.push({ check: "out-of-frame", detail: `${Math.round(v.inFrameShare * 100)}% in frame` });
  else if (v.areaPx < LIMITS.minAreaPx) out.push({ check: "too-small", detail: `${v.areaPx.toFixed(0)} px²` });
  if (v.sinkCenterM > LIMITS.sinkCenterM || v.sinkCornerM > LIMITS.sinkCornerM) out.push({ check: "under-terrain", detail: `center ${v.sinkCenterM.toFixed(2)} m, corner ${v.sinkCornerM.toFixed(2)} m below the ground` });
  if (v.occludedShare > LIMITS.occluded) out.push({ check: "behind-building", detail: `${Math.round(v.occludedShare * 100)}% of sight lines blocked (${v.occluders.join(", ")})` });
  if (v.uiShare > LIMITS.ui) out.push({ check: "under-ui", detail: `${Math.round(v.uiShare * 100)}% covered: ${Object.entries(v.uiBy).map(([k, s]) => `${k} ${Math.round(s * 100)}%`).join(", ")}` });
  if (v.offPageShare > LIMITS.offPage) out.push({ check: "off-page", detail: `${Math.round(v.offPageShare * 100)}% outside the window` });
  if (px && v.inFrameShare >= LIMITS.inFrame && px.inHull >= LIMITS.minAreaPx && px.changed / px.inHull < LIMITS.pixels) out.push({ check: "no-pixels", detail: `${px.changed}/${px.inHull} px change when hidden` });
  return out;
}

async function frames(page: Page, n = 3): Promise<void> {
  await page.evaluate((k) => new Promise<void>((r) => { const step = (i: number) => (i <= 0 ? r() : requestAnimationFrame(() => step(i - 1))); step(k); }), n);
}

/** Opens a scene on Review: an example by its URL, any other through Save's "Open a saved scene file". */
async function openScene(page: Page, s: SweepScene, onApp: boolean): Promise<"ok" | "refused"> {
  if (s.id.startsWith("example:")) { await openExample(page, s.network); return "ok"; }
  if (!onApp) await openExample(page, "t-bone-intersection");
  await page.evaluate(() => { window.location.hash = "export"; });
  await expect(page.locator("#app")).toHaveAttribute("data-step", "export");
  await page.locator("#open-scene").setInputFiles({ name: "scene.json", mimeType: "application/json", buffer: Buffer.from(sceneFile(s.scene)) });
  await expect(page.locator("#app")).toHaveAttribute("data-step", "review");
  await expect(page.locator(".viewer-canvas").or(page.getByTestId("refusal"))).toBeVisible({ timeout: 30_000 });
  if (await page.getByTestId("refusal").isVisible()) return "refused";
  await waitForViewer(page);
  return "ok";
}

interface Row { scene: string; width: number; view: View; when: When; vehicle: string; failures: Failure[]; probe: Omit<VehicleProbe, "hull">; pixels?: { changed: number; inHull: number } }

const scenes = sweepScenes();
const batches: SweepScene[][] = [];
for (let i = 0; i < scenes.length; i += BATCH) batches.push(scenes.slice(i, i + BATCH));

// Opt-in until the fixes in docs/VISIBILITY-SWEEP.md land (it fails today, by design: it reproduces the bug). Then this gate
// goes and check.sh runs the small default sweep on every push.
const ENABLED = process.env["SWEEP"] === "1" || process.env["SWEEP_N"] !== undefined;

test.describe("visibility sweep", () => {
  test.skip(!ENABLED, "opt-in for now: SWEEP=1 (or SWEEP_N=<n>)");
  for (const [bi, batch] of batches.entries()) {
    test(`every vehicle is visible in every camera: scenes ${bi * BATCH + 1}-${bi * BATCH + batch.length} of ${scenes.length}`, async ({ page }, info) => {
      test.setTimeout(batch.length * 240_000);
      const width = page.viewportSize()?.width ?? 0;
      const views = isPhone(page) ? PHONE_VIEWS : DESKTOP_VIEWS;
      const failed: string[] = [];
      const refused: string[] = [];
      let shots = 0;
      const out = OUT ? join(OUT, `${info.project.name}.jsonl`) : "";
      if (OUT) mkdirSync(join(OUT, "shots"), { recursive: true });
      let onApp = false;
      for (const s of batch) {
        if ((await openScene(page, s, onApp)) === "refused") { refused.push(s.id); onApp = true; continue; }
        onApp = true;
        const ids = s.scene.vehicles.map((v) => v.id);
        for (const view of views) {
          await page.locator(".viewer-canvas").press(VIEW_KEY[view]);
          for (const when of TIMES) {
            await page.getByRole("slider", { name: "Timeline" }).press(TIME_KEY[when]);
            // Keyboard focus scrolls the page (the slider sits below the picture); a person arriving on Review sees it
            // from the top, so every measurement is taken there.
            await page.evaluate(() => window.scrollTo(0, 0));
            await frames(page, 4);
            const probe: ProbeResult = await page.evaluate(probeInPage, ids);
            expect(probe.ok, probe.error).toBe(true);
            const px = PIXELS ? await page.evaluate(pixelsInPage, { hulls: Object.fromEntries(probe.vehicles.map((v) => [v.id, v.inFrameShare >= LIMITS.inFrame ? v.hull : []])) }) : {};
            for (const v of probe.vehicles) {
              const f = failuresOf(v, px[v.id]);
              const { hull: _hull, ...rest } = v;
              const row: Row = { scene: s.id, width, view, when, vehicle: v.id, failures: f, probe: rest, ...(px[v.id] ? { pixels: px[v.id] } : {}) };
              if (out) appendFileSync(out, `${JSON.stringify(row)}\n`);
              if (f.length) failed.push(`${s.id} ${width}px ${view} @${when} vehicle ${v.id}: ${f.map((x) => `${x.check} (${x.detail})`).join("; ")}`);
            }
            if (OUT && probe.vehicles.some((v) => failuresOf(v, px[v.id]).length) && shots < 6) {
              shots++;
              await page.screenshot({ path: join(OUT, "shots", `${s.id.replace(/[^a-z0-9]+/gi, "_")}-${width}-${view}-${when}.png`) });
            }
          }
        }
        if (OUT) writeFileSync(join(OUT, `scene-${s.id.replace(/[^a-z0-9]+/gi, "_")}.json`), sceneFile(s.scene));
      }
      if (refused.length) info.annotations.push({ type: "refused in the app (skipped)", description: refused.join(", ") });
      expect(failed, `${failed.length} vehicle views fail:\n${failed.join("\n")}`).toEqual([]);
    });
  }
});
