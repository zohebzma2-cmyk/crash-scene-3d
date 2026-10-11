// Review's picture while it loads, and when loading fails (docs/VIEWER-LOAD.md):
//   - "Building the scene…" (role=status) shows before the scene is ready and goes away after; the gray box never shows
//   - the 3D code failing to load, and WebGL failing to start, each say so with Retry over the top-down diagram,
//     and Retry brings the 3D view back
//   - the map data failing is a notice with Retry while the picture is drawn without roads
// Chromium and WebKit (@xb), at 1440 and 390.
import type { Page, Route } from "@playwright/test";
import { expect, saveFiles, test, waitForViewer } from "./helpers";

const EXAMPLE = "/?example=t-bone-intersection#review";
const VIEWER_CHUNK = /\/assets\/Viewer-[^/?]+\.js$/;
const loading = (page: Page) => page.getByTestId("viewer-loading");
const failure = (page: Page) => page.getByTestId("viewer-error");

/** Holds the 3D code back until `release()`, so the loading state can be looked at. */
async function holdViewerChunk(page: Page): Promise<() => void> {
  let release = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  await page.route(VIEWER_CHUNK, async (route: Route) => { await gate; await route.continue(); });
  return release;
}

test("@xb shows 'Building the scene…' with its stages before the scene is ready, never a bare gray box, and clears it after", async ({ page, pageErrors }) => {
  const release = await holdViewerChunk(page);
  // WebKit holds the load event for a pending dynamic import, so don't wait for it.
  await page.goto(EXAMPLE, { waitUntil: "commit" });
  await expect(loading(page)).toContainText("Building the scene…");
  await expect(loading(page)).toContainText("Loading the 3D view.");
  // A screen reader hears it through the one live region the page keeps (not a status inside the box).
  const live = page.getByTestId("load-announcer");
  await expect(live).toHaveAttribute("role", "status");
  await expect(live).toHaveText("Building the scene… Loading the 3D view.");
  await expect(loading(page).getByRole("status")).toHaveCount(0);
  await expect(page.locator(".viewer-canvas").first()).not.toHaveAttribute("data-ready", "true");
  // The stages are real: the map data and the terrain are in by now, the 3D code is what is still loading.
  await expect(loading(page).locator('[data-stage="map"]')).toHaveAttribute("data-status", "done");
  await expect(loading(page).locator('[data-stage="terrain"]')).toHaveAttribute("data-status", /done|skipped/);
  await expect(loading(page).locator('[data-stage="models"]')).toHaveAttribute("data-status", "active");
  // Under it is the top-down diagram, not an empty box.
  await expect(page.locator(".viewer-slot")).toBeVisible();
  // Reduced motion (the config's default): the spinner stands still.
  expect(await loading(page).locator(".spinner").first().evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
  release();
  // The 3D view draws its first frame hidden; while it does, it is never what shows.
  await expect.poll(async () => page.evaluate(() => {
    const v = document.querySelector(".viewer3d");
    const ready = document.querySelector('.viewer-canvas[data-ready="true"]');
    return !v || ready ? "ok" : getComputedStyle(v).visibility === "hidden" ? "ok" : "gray box shown";
  })).toBe("ok");
  await waitForViewer(page);
  await expect(loading(page)).toHaveCount(0);
  await expect(live).toHaveText("The scene is ready.");
  await expect(page.locator(".viewer-slot")).toHaveCount(0);
  await expect(page.locator(".viewer3d")).not.toHaveClass(/is-building/);
  expect(pageErrors()).toEqual([]);
});

test("@xb the 3D code failing to load says so with Retry over the diagram, and Retry recovers", async ({ page, pageErrors }) => {
  let failing = true;
  let release = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  // The first fetch fails; the retry's fetch is held until released, so the rebuilding state can be checked.
  await page.route(VIEWER_CHUNK, async (route) => { if (failing) return route.fulfill({ status: 500, body: "" }); await gate; return route.continue(); });
  await page.route(/\/assets\/Viewer-[^/?]+\.js\?retry=/, async (route) => { await gate; return route.continue(); });
  await page.goto(EXAMPLE);
  await expect(failure(page)).toBeVisible();
  await expect(failure(page)).toHaveAttribute("role", "alert");
  await expect(failure(page)).toContainText("We couldn't load the 3D view. Check your connection and try again.");
  await expect(page.locator(".viewer-slot")).toBeVisible();
  await expect(loading(page)).toHaveCount(0);
  // The diagram is the picture now, so the picture counts as ready.
  await expect(page.locator(".viewer-canvas")).toHaveAttribute("data-ready", "true");
  // Narrow screens: a few words, docked at the picture's bottom edge (the crash in the middle stays in view).
  if ((page.viewportSize()?.width ?? 1440) < 480) {
    await expect(failure(page).locator(".viewer-words-short")).toBeVisible();
    await expect(failure(page).locator(".viewer-words-short")).toHaveText("3D view didn't load.");
    const banner = (await failure(page).boundingBox())!;
    const picture = (await page.locator(".viewer-canvas").boundingBox())!;
    expect(picture.y + picture.height - (banner.y + banner.height)).toBeLessThan(40);
  } else {
    await expect(failure(page).locator(".viewer-words-short")).toBeHidden();
  }
  failing = false;
  await failure(page).getByRole("button", { name: "Retry" }).click();
  // Building again: the picture is not ready until the new 3D view has drawn.
  await expect(page.locator(".viewer-canvas")).not.toHaveAttribute("data-ready", "true");
  release();
  await waitForViewer(page);
  await expect(failure(page)).toHaveCount(0);
  expect(pageErrors()).toEqual([]);
});

test("@xb WebGL that can't start shows the diagram with Retry, and Retry recovers", async ({ page, pageErrors }) => {
  // The browser has WebGL (the first check passes), but the 3D view's own context can't be made: a blocked GPU, too many contexts.
  await page.addInitScript(() => {
    const w = window as unknown as { __failGL: boolean };
    w.__failGL = true;
    let made = 0;
    const real = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
      if (/webgl/.test(type) && w.__failGL && made++ > 0) return null;
      return (real as (...a: unknown[]) => unknown).call(this, type, ...rest);
    } as typeof real;
  });
  await page.goto(EXAMPLE);
  await expect(failure(page)).toBeVisible();
  await expect(failure(page)).toContainText("The 3D view couldn't start in this browser, so this is the top-down diagram.");
  await expect(page.locator(".viewer-slot")).toBeVisible();
  await page.evaluate(() => { (window as unknown as { __failGL: boolean }).__failGL = false; });
  await failure(page).getByRole("button", { name: "Retry" }).click();
  await waitForViewer(page);
  await expect(failure(page)).toHaveCount(0);
  // react-three-fiber reports the failed context as an uncaught error before the boundary takes it; nothing else may.
  expect(pageErrors().filter((e) => !/WebGL context/.test(e))).toEqual([]);
});

test("@xb the map data failing is a notice with Retry, and the picture is still drawn", async ({ page }) => {
  // Fixture builds serve the example's road data as its own chunk.
  await page.route(/\/assets\/osm-[^/]+\.js/, (route) => route.fulfill({ status: 500, body: "" }));
  await page.goto(EXAMPLE);
  const notice = page.getByTestId("viewer-notice");
  await expect(notice).toBeVisible({ timeout: 30_000 });
  await expect(notice).toHaveAttribute("role", "alert");
  await expect(notice).toContainText("We couldn't load the map data, so the picture has no roads.");
  await expect(notice.getByRole("button", { name: "Retry" })).toBeVisible();
  await waitForViewer(page);
  await expect(notice).toBeVisible();
  // The picture is up, so the loading box is gone; only the notice stays.
  await expect(loading(page)).toHaveCount(0);
});

test("@xb after the 3D code fails, saving goes on at once (without the 3D pictures) and focus lands on Save's title", async ({ page }) => {
  await page.route(VIEWER_CHUNK, (route) => route.fulfill({ status: 500, body: "" }));
  await page.goto(EXAMPLE);
  await expect(failure(page)).toBeVisible();
  const t0 = Date.now();
  await page.getByRole("button", { name: "Looks right: save it" }).click();
  // Before, each of the two stills waited out the 10 s ready timeout.
  await expect(page.locator("#app")).toHaveAttribute("data-step", "export", { timeout: 5_000 });
  expect(Date.now() - t0).toBeLessThan(5_000);
  await expect(page.locator("main h1")).toHaveText("What do you want to save?");
  await expect(page.locator("main h1")).toBeFocused();
  const saved = await saveFiles(page);
  expect([...saved.files.keys()].filter((n) => /-(impact|final-rest)\.png$/.test(n))).toEqual([]);
});

test("@xb a save right after Retry waits for the new 3D view and keeps its pictures", async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __failGL: boolean };
    w.__failGL = true;
    let made = 0;
    const real = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
      if (/webgl/.test(type) && w.__failGL && made++ > 0) return null;
      return (real as (...a: unknown[]) => unknown).call(this, type, ...rest);
    } as typeof real;
  });
  await page.goto(EXAMPLE);
  await expect(failure(page)).toBeVisible();
  await page.evaluate(() => { (window as unknown as { __failGL: boolean }).__failGL = false; });
  await failure(page).getByRole("button", { name: "Retry" }).click();
  // At once, before the new 3D view has drawn: the save must wait for it, not use the old failure.
  await page.getByRole("button", { name: "Looks right: save it" }).click();
  await expect(page.locator("#app")).toHaveAttribute("data-step", "export", { timeout: 30_000 });
  const saved = await saveFiles(page);
  const names = [...saved.files.keys()];
  expect(names.some((n) => n.endsWith("-impact.png")), names.join(", ")).toBe(true);
  expect(names.some((n) => n.endsWith("-final-rest.png")), names.join(", ")).toBe(true);
});
