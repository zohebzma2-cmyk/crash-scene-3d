// Review's picture while it loads, and when loading fails (docs/VIEWER-LOAD.md):
//   - "Building the scene…" (role=status) shows before the scene is ready and goes away after; the gray box never shows
//   - the 3D code failing to load, and WebGL failing to start, each say so with Retry over the top-down diagram,
//     and Retry brings the 3D view back
//   - the map data failing is a notice with Retry while the picture is drawn without roads
// Chromium and WebKit (@xb), at 1440 and 390.
import type { Page, Route } from "@playwright/test";
import { expect, test, waitForViewer } from "./helpers";

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
  const status = loading(page).getByRole("status");
  await expect(status).toContainText("Building the scene…");
  await expect(status).toContainText("Loading the 3D models.");
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
  await expect(page.locator(".viewer-slot")).toHaveCount(0);
  await expect(page.locator(".viewer3d")).not.toHaveClass(/is-building/);
  expect(pageErrors()).toEqual([]);
});

test("@xb the 3D code failing to load says so with Retry over the diagram, and Retry recovers", async ({ page, pageErrors }) => {
  let failing = true;
  await page.route(VIEWER_CHUNK, (route) => (failing ? route.fulfill({ status: 500, body: "" }) : route.continue()));
  await page.goto(EXAMPLE);
  await expect(failure(page)).toBeVisible();
  await expect(failure(page)).toHaveAttribute("role", "alert");
  await expect(failure(page)).toContainText("We couldn't load the 3D view. Check your connection and try again.");
  await expect(page.locator(".viewer-slot")).toBeVisible();
  await expect(loading(page)).toHaveCount(0);
  failing = false;
  await failure(page).getByRole("button", { name: "Retry" }).click();
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
});
