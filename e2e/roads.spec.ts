// Roads and paths on real road shapes (the owner's report, 2026-10-11): a pin on a single curved road with no crossing,
// A going north and B going west (compass directions that don't match the road), 25 and 30 mph, B's front into A's rear
// quarter. Before the fix the picture drew both approach paths straight across the grass, warned that the picture "draws it
// anyway", and the bodies overlapped at impact.
//
// The road is synthetic (packages/mapdata/test/synthetic-osm.ts, served by the fixtures build from
// apps/web/fixtures/roads/curved/osm.json). ROADS_SHOT_DIR=<dir> saves the Top view at impact there (the "after"; the
// "before" was taken from commit a32d0bc, where this spec reproduced the report).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { Scene } from "../packages/core/src";
import { SITE_CENTERS, type SiteName } from "../packages/mapdata/test/synthetic-osm";
import { sceneFile } from "./visibility/scenes";
import { expect, test } from "./helpers";

type Zone = Scene["vehicles"][number]["zone"];
const vehicle = (id: "A" | "B", bearingDeg: number, mph: number, zone: Zone): Scene["vehicles"][number] => ({
  id, role: id === "A" ? "claimant" : "other", year: null, make: "", model: "", type: "car", typeSource: "manual", action: "straight",
  travel: { bearingDeg, roadId: null, roadName: null, lane: null }, speed: { kind: "known", mph }, braking: false, zone,
});

/** The owner's scene on a synthetic site: compass directions, no road picked. */
export function compassScene(site: SiteName, a: number, b: number): Scene {
  const c = SITE_CENTERS[site];
  return {
    schemaVersion: 4,
    claim: { number: "CLM-ROADS", vehicle: { year: null, make: "", model: "" } },
    location: { lat: c.lat, lon: c.lon, label: "", nearLabel: "", source: "pin", place: "road" },
    occurred: { date: "2026-10-02", time: "17:15" },
    road: { condition: "dry" },
    vehicles: [vehicle("A", a, 25, "rear-right"), vehicle("B", b, 30, "front")],
  };
}

/** Opens a scene through Save's "Open a saved scene file", as a person would. */
export async function openSceneFile(page: Page, scene: Scene): Promise<void> {
  // Save is reachable once a scene passes; the T-bone example gets there (no need to wait for its 3D view), then the file replaces it.
  await page.goto("/?example=t-bone-intersection");
  await expect(page.locator("#app")).toHaveAttribute("data-step", "review");
  await page.evaluate(() => { window.location.hash = "export"; });
  await expect(page.locator("#app")).toHaveAttribute("data-step", "export");
  await page.locator("#open-scene").setInputFiles({ name: "scene.json", mimeType: "application/json", buffer: Buffer.from(sceneFile(scene)) });
}

const shotDir = process.env["ROADS_SHOT_DIR"] ?? "";

/**
 * How deep the two drawn vehicles are in each other at the time shown, metres (negative: a gap): every vertex of each
 * vehicle's visible meshes in the live scene graph, flattened to the ground, convex hull, separating axes.
 */
async function drawnOverlapM(page: Page): Promise<number> {
  return page.evaluate(() => {
    /* eslint-disable @typescript-eslint/no-explicit-any -- the page reads three.js objects untyped */
    const t = (window as any).__csdViewer?.three?.();
    if (!t) return Number.NaN;
    const outline = (g: any): Array<[number, number]> => {
      const pts: Array<[number, number]> = [];
      g.updateMatrixWorld(true);
      g.traverseVisible((o: any) => {
        if (!o.isMesh) return;
        const pos = o.geometry.attributes.position, e = o.matrixWorld.elements;
        for (let i = 0; i < pos.count; i++) {
          const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
          pts.push([e[0] * x + e[4] * y + e[8] * z + e[12], e[2] * x + e[6] * y + e[10] * z + e[14]]);
        }
      });
      pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      const cross = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
      const lo: Array<[number, number]> = [], hi: Array<[number, number]> = [];
      for (const p of pts) { while (lo.length >= 2 && cross(lo[lo.length - 2]!, lo[lo.length - 1]!, p) <= 0) lo.pop(); lo.push(p); }
      for (const p of [...pts].reverse()) { while (hi.length >= 2 && cross(hi[hi.length - 2]!, hi[hi.length - 1]!, p) <= 0) hi.pop(); hi.push(p); }
      return [...lo.slice(0, -1), ...hi.slice(0, -1)];
    };
    const a = outline(t.groups.A), b = outline(t.groups.B);
    let best = Infinity;
    for (const poly of [a, b]) {
      for (let i = 0; i < poly.length; i++) {
        const p = poly[i]!, q = poly[(i + 1) % poly.length]!;
        const len = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1, n = [-(q[1] - p[1]) / len, (q[0] - p[0]) / len];
        const pa = a.map((v) => v[0] * n[0]! + v[1] * n[1]!), pb = b.map((v) => v[0] * n[0]! + v[1] * n[1]!);
        best = Math.min(best, Math.min(Math.max(...pa), Math.max(...pb)) - Math.max(Math.min(...pa), Math.min(...pb)));
      }
    }
    return best;
  });
}

/** Top view at the moment of impact, saved as <name>.png in ROADS_SHOT_DIR (desktop only). */
async function topAtImpact(page: Page, name: string, project: string): Promise<void> {
  await expect(page.locator(".viewer-canvas")).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
  await page.locator(".viewer-canvas").press("1");
  await page.locator(".viewer-canvas").press("i");
  await page.waitForTimeout(800);
  if (!shotDir || project !== "desktop") return;
  mkdirSync(shotDir, { recursive: true });
  await page.locator(".viewer-layout").screenshot({ path: join(shotDir, `${name}.png`) });
}

test.describe("roads and paths: the owner's curved road", () => {
  test("a compass direction that doesn't fit the curved road is fixed on the Vehicles step, never drawn across the grass @xb", async ({ page, pageErrors }, info) => {
    await openSceneFile(page, compassScene("curved", 0, 270));
    // Nothing off the road is drawn: the file lands on the Vehicles step, which names the problem for each vehicle.
    await expect(page.locator("#app")).toHaveAttribute("data-step", "vehicles", { timeout: 30_000 });
    const gate = page.getByTestId("gate-panel");
    await expect(gate).toContainText("Vehicle A's direction doesn't follow any road at the pin.");
    await expect(gate).toContainText("Vehicle B's direction doesn't follow any road at the pin.");
    // No "See it anyway": a picture off the roads is never drawn.
    await expect(gate.getByRole("button", { name: "See it anyway" })).toHaveCount(0);
    // The one-tap fixes put each vehicle on Willow Bend Road, the road at the pin.
    const fixes = page.getByTestId("gate-fixes").getByRole("button");
    await expect(fixes.first()).toBeVisible({ timeout: 30_000 });
    const label = (await fixes.first().textContent()) ?? "";
    expect(label).toMatch(/A's direction to .* on Willow Bend Road/);
    expect(label).toMatch(/B's direction to .* on Willow Bend Road/);
    await fixes.first().click();
    await expect(page.getByTestId("gate-panel")).toHaveCount(0);
    await page.locator("#to-review").click();
    await expect(page.locator("#app")).toHaveAttribute("data-step", "review");
    await topAtImpact(page, "after-curved-top-impact", info.project.name);
    // At the impact the drawn cars touch: neither is more than a few centimetres inside the other.
    const depth = await drawnOverlapM(page);
    expect(depth).toBeLessThanOrEqual(0.03);
    expect(depth).toBeGreaterThan(-0.1);
    for (const t of ["draws it anyway", "drawn straight", "edge of the road", "doesn't follow any road"]) await expect(page.locator("body")).not.toContainText(t);
    expect(pageErrors()).toEqual([]);
  });

  test("the direction list on the curved road is its two directions and the driveways beside it, never a compass", async ({ page }) => {
    await openSceneFile(page, compassScene("curved", 0, 270));
    await expect(page.locator("#app")).toHaveAttribute("data-step", "vehicles", { timeout: 30_000 });
    const group = page.locator("#vehicle-A [data-fix-direction]").getByRole("radiogroup");
    await expect(group.getByRole("radio")).toHaveText([
      "Heading southeast on Willow Bend Road", "Heading northwest on Willow Bend Road",
      "Out of a driveway or parking lot on the southwest side of Willow Bend Road", "Out of a driveway or parking lot on the northeast side of Willow Bend Road",
    ]);
    await expect(page.locator("#vehicle-A [data-compass-note]")).toHaveCount(0);
    // Picking the road for both draws the crash on the road.
    await group.getByRole("radio", { name: "Heading northwest on Willow Bend Road" }).click();
    await page.locator("#vehicle-B [data-fix-direction]").getByRole("radio", { name: "Heading southeast on Willow Bend Road" }).click();
    await expect(page.locator("#vehicle-A .dir-caption")).toHaveText("Heading northwest on Willow Bend Road");
  });
});
