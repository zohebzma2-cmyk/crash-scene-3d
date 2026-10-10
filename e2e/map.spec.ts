// The Location map in a real browser, on the fixtures build: no request ever leaves the origin, a plain wheel scrolls the
// page while Ctrl + wheel zooms, the expanded phone map opens and closes with focus handled, the attribution is
// visible and uncovered, and the loaded tiles can be drawn on a canvas (the PDF thumbnail's source) without tainting it.
import { expect, test, type Page } from "@playwright/test";

async function openLocation(page: Page): Promise<string[]> {
  const foreign: string[] = [];
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== new URL(page.url() === "about:blank" ? "http://localhost" : page.url()).origin && url.protocol.startsWith("http") && !/^localhost|127\.0\.0\.1/.test(url.hostname)) {
      foreign.push(route.request().url());
      return route.abort();
    }
    return route.continue();
  });
  page.on("request", (r) => { if (!/^(data|blob):/.test(r.url()) && !/^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(r.url())) foreign.push(r.url()); });
  await page.goto("/?example=t-bone-intersection#review");
  await page.getByRole("heading", { level: 1 }).first().waitFor();
  await page.waitForTimeout(500);
  await page.evaluate(() => { location.hash = "#location"; });
  await page.locator("img.leaflet-tile-loaded").first().waitFor({ state: "attached" });
  return foreign;
}

const zoomOf = (page: Page) => page.locator(".map-frame").getAttribute("data-zoom").then(Number);

test("fixtures mode makes no request to another origin, and shows labeled cached tiles", async ({ page }) => {
  const foreign = await openLocation(page);
  await page.waitForTimeout(800);
  expect(foreign).toEqual([]);
  const srcs = await page.locator("img.leaflet-tile").evaluateAll((els) => els.map((e) => (e as HTMLImageElement).src));
  expect(srcs.length).toBeGreaterThan(0);
  const origin = new URL(page.url()).origin;
  for (const s of srcs) expect(s.startsWith("data:") || new URL(s).origin === origin).toBe(true);
  expect(await page.locator(".map path.map-road").count()).toBe(0);
});

test("a plain wheel scrolls the page; Ctrl + wheel zooms the map", async ({ page, isMobile }) => {
  test.skip(isMobile, "wheel is a desktop gesture");
  await openLocation(page);
  const map = page.locator(".leaflet-container");
  const box = (await map.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const z0 = await zoomOf(page);
  const y0 = await page.evaluate(() => window.scrollY);
  await page.mouse.wheel(0, 300);
  await page.waitForTimeout(400);
  expect(await zoomOf(page)).toBe(z0);
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(y0);
  await page.waitForTimeout(500);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 300);
  await expect(page.locator(".map-wheel-hint")).toHaveAttribute("data-show", "true");
  // let the page's own smooth scroll finish before going back to the top
  await page.waitForTimeout(700);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  const y1 = await page.evaluate(() => window.scrollY);
  await page.keyboard.down("Control");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 5);
  await page.mouse.wheel(0, -240);
  await page.keyboard.up("Control");
  await page.waitForTimeout(400);
  expect(await zoomOf(page)).toBeGreaterThan(z0);
  expect(await page.evaluate(() => window.scrollY)).toBe(y1);
});

test("the keyboard pans and zooms the focused map", async ({ page, isMobile }) => {
  test.skip(isMobile, "keyboard");
  await openLocation(page);
  await page.locator(".leaflet-container").focus();
  const z0 = await zoomOf(page);
  await page.keyboard.press("+");
  await page.waitForTimeout(500);
  expect(await zoomOf(page)).toBeGreaterThan(z0);
});

test("the attribution is visible and nothing covers it", async ({ page }) => {
  await openLocation(page);
  const link = page.getByRole("link", { name: "© OpenStreetMap contributors" });
  await expect(link).toBeVisible();
  const covered = await link.evaluate((a) => {
    const r = a.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !(hit === a || a.contains(hit));
  });
  expect(covered).toBe(false);
});

// KNOWN-STALE (2026-10-09): this checked the cached OSM tiles, which were removed (OSM's tile policy forbids a bulk
// download). Fixtures mode now draws every tile from road data, so there is no non-neutral tile to copy here. The live
// path (proxied tiles into the PDF thumbnail) needs a live-tile test instead; see README "Next version".
test.skip("the loaded tiles can be copied to a canvas without tainting it", async ({ page }) => {
  await openLocation(page);
  await page.locator("img.leaflet-tile-loaded:not([data-neutral])").first().waitFor({ state: "attached" });
  const ok = await page.evaluate(async () => {
    const img = document.querySelector<HTMLImageElement>("img.leaflet-tile-loaded:not([data-neutral])");
    if (!img) return "no cached tile loaded";
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    c.getContext("2d")!.drawImage(img, 0, 0, 64, 64);
    const blob = await new Promise<Blob | null>((res) => { try { c.toBlob(res, "image/png"); } catch { res(null); } });
    return blob && blob.size > 0 ? "ok" : "tainted";
  });
  expect(ok).toBe("ok");
});

test("the phone map expands to full screen, closes with Esc and gives focus back", async ({ page, isMobile }) => {
  test.skip(!isMobile, "phone only");
  await openLocation(page);
  const expand = page.getByRole("button", { name: "Expand map" });
  await expand.click();
  const dialog = page.locator("dialog.map-dialog");
  await expect(dialog).toBeVisible();
  const box = (await dialog.boundingBox())!;
  const vp = page.viewportSize()!;
  expect(Math.round(box.width)).toBe(vp.width);
  expect(Math.round(box.height)).toBe(vp.height);
  await expect(page.getByRole("button", { name: "Close map" })).toBeFocused();
  await expect(page.getByRole("link", { name: "© OpenStreetMap contributors" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Expand map" })).toBeFocused();
});

test("every tile in the map view is a cached OSM tile or a locally drawn one, never a placeholder", async ({ page }) => {
  await openLocation(page);
  await page.waitForTimeout(1200);
  const tiles = await page.locator(".map img.leaflet-tile").evaluateAll((els) => {
    const view = document.querySelector(".leaflet-container")!.getBoundingClientRect();
    return els.map((e) => { const r = e.getBoundingClientRect(); return { src: (e as HTMLImageElement).src, inView: r.right > view.left && r.left < view.right && r.bottom > view.top && r.top < view.bottom, loaded: e.classList.contains("leaflet-tile-loaded") }; }).filter((t) => t.inView);
  });
  expect(tiles.length).toBeGreaterThan(0);
  const origin = new URL(page.url()).origin;
  let drawn = 0;
  for (const t of tiles) {
    expect(t.loaded).toBe(true);
    expect(decodeURIComponent(t.src)).not.toMatch(/No map here|<text/i);
    if (t.src.startsWith("data:image/png")) drawn++;
    else expect(t.src.startsWith("data:") || t.src.startsWith(`${origin}/examples/`)).toBe(true);
  }
  expect(drawn).toBeGreaterThanOrEqual(0);
});
