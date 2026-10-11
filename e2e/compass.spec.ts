// The compass in the 3D view and the north arrows on the maps, in a real browser (fixtures build, SwiftShader WebGL).
//   - turning the camera turns the compass; pressing it (click, Enter, Space) puts the camera back to north up,
//     keeping its distance and elevation, in Wide and in Top
//   - with motion allowed it flies there (short); with reduced motion it is instant
//   - it never overlaps a label, the view chips or the timeline, also on a phone
//   - both Leaflet maps carry a north arrow that doesn't sit on the zoom buttons, Expand or the attribution
import { expect, test, type Page } from "@playwright/test";

async function open(page: Page, name = "t-bone-intersection"): Promise<void> {
  await page.goto(`/?example=${name}#review`);
  await page.waitForSelector(".viewer3d canvas", { timeout: 30_000 });
  await page.waitForFunction(() => Boolean((window as unknown as { __csdViewer?: { camera(): unknown } }).__csdViewer?.camera()), undefined, { timeout: 30_000 });
  await page.waitForTimeout(1200);
}
const pickView = async (page: Page, label: string) => { await page.getByRole("radio", { name: label, exact: true }).click(); await page.waitForTimeout(900); };

interface Cam { orthographic: boolean; position: number[]; target: number[] }
const camera = (page: Page) => page.evaluate(() => (window as unknown as { __csdViewer: { camera(): Cam } }).__csdViewer.camera());
/** Where the camera stands: azimuth around its target (0 = due south of it, so it looks north), distance and elevation. */
function stand(c: Cam) {
  const dx = c.position[0]! - c.target[0]!, dy = c.position[1]! - c.target[1]!, dz = c.position[2]! - c.target[2]!;
  return { azimuth: Math.atan2(dx, dz), distance: Math.hypot(dx, dy, dz), elevation: Math.atan2(dy, Math.hypot(dx, dz)) };
}
const rotation = (page: Page) => page.locator(".viewer3d-compass").getAttribute("data-rotation").then(Number);
/** The compass is written by the frame loop, and a SwiftShader frame can take a while: wait for it. */
const expectRotation = (page: Page, ok: (r: number) => boolean) => expect.poll(async () => ok(Math.abs(await rotation(page))), { timeout: 10_000 }).toBe(true);
const turnWithKeys = async (page: Page, key: string, n: number) => {
  await page.locator(".viewer-canvas").focus();
  for (let i = 0; i < n; i++) await page.keyboard.press(key);
  await page.waitForTimeout(400);
};

test.describe("3D compass", () => {
  test("has its accessible name, a 44 px target, and sits with the zoom controls", async ({ page }) => {
    await open(page);
    const compass = page.getByRole("button", { name: "Compass: reset to north up" });
    await expect(compass).toBeVisible();
    const box = (await compass.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    const zoom = (await page.getByRole("button", { name: "Zoom in" }).boundingBox())!;
    // In one row with the zoom buttons: just left of them, not over them, and vertically level with them.
    expect(box.x + box.width).toBeLessThanOrEqual(zoom.x + 1);
    expect(Math.abs((box.y + box.height / 2) - (zoom.y + zoom.height / 2))).toBeLessThan(8);
  });

  test("Wide: after turning the camera, a click returns it to north up (same distance and elevation)", async ({ page }) => {
    await open(page);
    await pickView(page, "Wide");
    const before = stand((await camera(page))!);
    await turnWithKeys(page, "ArrowLeft", 10);
    const turned = stand((await camera(page))!);
    expect(Math.abs(turned.azimuth - 0)).toBeGreaterThan(0.3);
    await expectRotation(page, (r) => r > 15);                                     // the compass turned with it
    await page.getByRole("button", { name: "Compass: reset to north up" }).click();
    await page.waitForTimeout(300);
    const after = stand((await camera(page))!);
    expect(Math.abs(after.azimuth)).toBeLessThan(0.01);
    expect(after.distance).toBeCloseTo(turned.distance, 1);
    expect(after.elevation).toBeCloseTo(turned.elevation, 2);
    await expectRotation(page, (r) => r <= 1);
    expect(before.distance).toBeGreaterThan(0);
  });

  test("Top: turning the picture turns the compass; Enter and Space put north back at the top", async ({ page }) => {
    await open(page);
    await pickView(page, "Top");
    await expectRotation(page, (r) => r <= 1);                                      // Top opens north up
    await turnWithKeys(page, "ArrowRight", 12);
    await expectRotation(page, (r) => r > 20);
    const compass = page.getByRole("button", { name: "Compass: reset to north up" });
    await compass.focus();
    await page.keyboard.press("Enter");
    await expectRotation(page, (r) => r <= 1);
    await turnWithKeys(page, "ArrowLeft", 12);
    await expectRotation(page, (r) => r > 20);
    await compass.focus();
    await page.keyboard.press(" ");
    await expectRotation(page, (r) => r <= 1);
    const c = (await camera(page))!;
    expect(c.orthographic).toBe(true);
    expect(Math.abs(stand(c).azimuth)).toBeLessThan(0.01);
  });

  test("shows a focus ring for the keyboard", async ({ page }) => {
    await open(page);
    await page.locator(".viewer-canvas").focus();
    await page.getByRole("button", { name: "Compass: reset to north up" }).focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    const outline = await page.getByRole("button", { name: "Compass: reset to north up" }).evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(outline).toBe("solid");
  });

  test("never overlaps a label, the view chips, the zoom buttons or the timeline", async ({ page }) => {
    await open(page);
    for (const view of ["Top", "Wide"]) {
      await pickView(page, view);
      const rects = await page.evaluate(() => {
        const r = (el: Element | null) => { const b = el?.getBoundingClientRect(); return b ? { x: b.left, y: b.top, w: b.width, h: b.height } : null; };
        return {
          compass: r(document.querySelector(".viewer3d-compass")),
          others: [".view-controls", ".viewer3d-controls", ".timeline", ".scene-caption"].map((s) => [s, r(document.querySelector(s))] as const),
          labels: [...document.querySelectorAll(".viewer3d-label")].map(r),
        };
      });
      const hit = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      for (const [name, o] of rects.others) if (o) expect(hit(rects.compass!, o), `${view}: compass over ${name}`).toBe(false);
      for (const l of rects.labels) if (l) expect(hit(rects.compass!, l), `${view}: compass under a label`).toBe(false);
    }
  });
});

test.describe("3D compass, motion allowed", () => {
  test.use({ reducedMotion: "no-preference" });
  test("flies to north up in well under a second", async ({ page }) => {
    await open(page);
    await pickView(page, "Wide");
    await turnWithKeys(page, "ArrowLeft", 10);
    expect(Math.abs(stand((await camera(page))!).azimuth)).toBeGreaterThan(0.3);
    await page.getByRole("button", { name: "Compass: reset to north up" }).click();
    await page.waitForTimeout(150);
    const mid = Math.abs(stand((await camera(page))!).azimuth);
    expect(mid).toBeGreaterThan(0.01);                                              // still on its way (not instant)
    await page.waitForTimeout(900);
    expect(Math.abs(stand((await camera(page))!).azimuth)).toBeLessThan(0.01);
  });
});

test.describe("map north arrows", () => {
  test("the step 1 map and the step 2 mini map each show one, clear of their controls", async ({ page }) => {
    await page.goto("/?example=t-bone-intersection#review");
    // Loaded means the picture is up (the heading shows with the loading box, before the roads are in).
    await page.locator('.viewer-canvas[data-ready="true"]').waitFor({ timeout: 30_000 });
    await page.evaluate(() => { location.hash = "#location"; });
    await page.locator("img.leaflet-tile-loaded").first().waitFor({ state: "attached" });
    await page.waitForTimeout(800);
    const clear = async (frame: string) => page.evaluate((f) => {
      const root = document.querySelector(f)!;
      const r = (el: Element | null) => { const b = el?.getBoundingClientRect(); return b ? { x: b.left, y: b.top, w: b.width, h: b.height } : null; };
      const hit = (a: NonNullable<ReturnType<typeof r>>, b: NonNullable<ReturnType<typeof r>>) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      const north = r(root.querySelector(".map-north"));
      const frameBox = r(root)!;
      const others = [".map-tools", ".map-attrib", ".map-expand", ".map-hint", ".map-close"].map((s) => [s, r(root.querySelector(s))] as const).filter((x) => x[1]);
      return { north, inside: !!north && north.x >= frameBox.x && north.y >= frameBox.y && north.x + north.w <= frameBox.x + frameBox.w && north.y + north.h <= frameBox.y + frameBox.h, over: others.filter(([, b]) => north && hit(north, b!)).map(([s]) => s) };
    }, frame);
    const big = await clear(".map-frame-lg");
    expect(big.north).toBeTruthy();
    expect(big.inside).toBe(true);
    expect(big.over).toEqual([]);
    await expect(page.locator(".map-frame-lg .map-north")).toHaveAttribute("aria-label", "North is up");
    await page.evaluate(() => { location.hash = "#vehicles"; });
    await page.locator(".map-frame-sm img.leaflet-tile").first().waitFor({ state: "attached" });
    await page.waitForTimeout(800);
    const mini = await clear(".map-frame-sm");
    expect(mini.north).toBeTruthy();
    expect(mini.inside).toBe(true);
    expect(mini.over).toEqual([]);
  });
});
