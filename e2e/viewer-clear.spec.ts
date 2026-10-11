// Review's picture on phones and desktops (all three examples; Chromium and WebKit):
//   - the compass and zoom buttons are never under the sticky "Looks right: save it" bar, at any scroll position
//   - at impact, and at Home / I / End in Top and Wide, no vehicle label covers a vehicle or the impact ring
// Runs against a deployed build too: BASE_URL=https://crash-scene-3d.netlify.app npx playwright test e2e/viewer-clear.spec.ts
import type { Page } from "@playwright/test";
import { EXAMPLES, boxes, crossIntersections, expect, isPhone, openExample, test, viewerObstacles, type ExampleName } from "./helpers";

async function settled(page: Page): Promise<void> {
  const read = () => page.locator(".viewer3d-labels").evaluate((el) => `${el.getAttribute("data-boxes")}|${[...el.querySelectorAll(".viewer3d-label")].map((e) => { const r = e.getBoundingClientRect(); return `${Math.round(r.x)},${Math.round(r.y)}`; }).join(";")}`);
  let last = await read();
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(150);
    const now = await read();
    if (now === last) return;
    last = now;
  }
}

const hudBoxes = async (page: Page) => [...(await boxes(page, ".viewer3d-compass", "compass")), ...(await boxes(page, ".viewer3d-controls", "zoom buttons"))];

/** Walks the page top to bottom (and to the viewer) and checks the compass and zoom buttons against the action bar's box each time. */
async function hudClearOfBar(page: Page, name: ExampleName, height: number): Promise<void> {
  const size = page.viewportSize()!;
  // A phone's visible height varies (Safari's toolbar); a desktop keeps its own.
  if (isPhone(page)) await page.setViewportSize({ width: size.width, height });
  await openExample(page, name);
  await page.waitForTimeout(600);
  const check = async (where: string) => {
    const bar = await boxes(page, ".panel-foot", "action bar");
    const hud = await hudBoxes(page);
    expect(hud.length, `${where}: the compass and zoom buttons are shown`).toBe(2);
    expect(crossIntersections(hud, bar), where).toEqual([]);
  };
  await check("default scroll");
  await page.evaluate(() => document.querySelector(".viewer")!.scrollIntoView({ block: "start" }));
  await page.waitForTimeout(300);
  await check("viewer at the top of the screen");
  const max = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
  for (let y = 0; y <= Math.min(max, 1400); y += 90) {
    await page.evaluate((to) => window.scrollTo(0, to), y);
    await page.waitForTimeout(80);
    await check(`scrollY ${y}`);
  }
}

// A first visit shows the step's tip (the config hides tips for every other spec), which pushes the picture down the page.
const firstVisit = { cookies: [], origins: [] };

for (const name of EXAMPLES) {
  test.describe(name, () => {
    test(`@xb compass and zoom buttons clear of the action bar, 844 px tall`, async ({ page }) => hudClearOfBar(page, name, 844));
    test(`@xb compass and zoom buttons clear of the action bar, 664 px tall (Safari with its toolbar)`, async ({ page }) => hudClearOfBar(page, name, 664));
    test.describe("first visit, tip showing", () => {
      test.use({ storageState: firstVisit });
      test(`@xb compass and zoom buttons clear of the action bar, 844 px tall`, async ({ page }) => hudClearOfBar(page, name, 844));
      test(`@xb compass and zoom buttons clear of the action bar, 664 px tall`, async ({ page }) => hudClearOfBar(page, name, 664));
    });

    for (const [w, h] of [[390, 844], [390, 664], [360, 640], [375, 667], [430, 932]] as const) {
      test(`@xb vehicle labels stay off the vehicles and the impact ring (Top and Wide, Home / I / End, ${w}x${h})`, async ({ page }) => {
        test.skip(!isPhone(page) && (w !== 390 || h !== 844), "desktop runs once, at its own size");
        if (isPhone(page)) await page.setViewportSize({ width: w, height: h });
        await openExample(page, name);
        const problems: string[] = [];
        for (const [view, viewKey] of [["Top", "1"], ["Wide", "2"]] as const) {
          for (const key of ["i", "Home", "End"]) {
            await page.locator(".viewer-canvas").focus();
            await page.keyboard.press(viewKey);
            await page.getByRole("slider", { name: "Timeline" }).focus();
            await page.keyboard.press(key);
            await page.waitForTimeout(300);
            await settled(page);
            const labels = await boxes(page, ".viewer3d-label.viewer3d-vehicle", "label");
            const { vehicles, ring } = await viewerObstacles(page);
            expect(vehicles.length, `${view} @ ${key}: vehicle outlines are published`).toBeGreaterThan(0);
            expect(ring.length, `${view} @ ${key}: the ring outline is published`).toBeGreaterThan(0);
            for (const hit of [...crossIntersections(labels, vehicles), ...crossIntersections(labels, ring)]) problems.push(`${view} @ ${key}: ${hit}`);
          }
        }
        expect(problems).toEqual([]);
      });
    }
  });
}
