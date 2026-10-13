// 7. Phone (390 × 844): no big empty map before a pin, the sticky action bar, Measure as a tab,
// and nothing wider than the screen on any step. Runs in the phone project only.
import type { Locator, Page } from "@playwright/test";
import { DEFAULT_ANSWERS, answerVehicle, expect, freshStart, openExample, searchAndPick, searchBox, test, toReview, waitForViewer } from "./helpers";

test.beforeEach(({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) > 600, "phone only");
});

async function noHorizontalOverflow(page: Page, where: string): Promise<void> {
  const r = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const wide = Array.from(document.querySelectorAll<HTMLElement>("body *"))
      .filter((el) => { const b = el.getBoundingClientRect(); const s = getComputedStyle(el); return b.width > 0 && s.visibility !== "hidden" && b.right > vw + 1 && !el.closest(".leaflet-container, .viewer3d-labels"); })
      .slice(0, 5).map((el) => `${el.tagName.toLowerCase()}.${String(el.className).split(" ").join(".")} right=${Math.round(el.getBoundingClientRect().right)}`);
    return { scroll: document.documentElement.scrollWidth, body: document.body.scrollWidth, vw, wide };
  });
  expect(r.scroll, `${where}: document.scrollWidth ${JSON.stringify(r)}`).toBeLessThanOrEqual(390);
  expect(r.body, `${where}: body.scrollWidth`).toBeLessThanOrEqual(390);
  expect(r.wide, `${where}: elements past the right edge`).toEqual([]);
}

/** The primary button sits in a bar fixed to the bottom of the screen, at the top and at the end of the page. */
async function stickyBar(page: Page, button: Locator, where: string): Promise<void> {
  const vh = page.viewportSize()!.height;
  for (const end of [false, true]) {
    await page.evaluate((e) => window.scrollTo(0, e ? document.documentElement.scrollHeight : 0), end);
    await page.waitForTimeout(100);
    const b = await button.boundingBox();
    expect(b, `${where}: primary button`).toBeTruthy();
    expect(b!.y + b!.height, `${where}: button bottom on screen (scrolled to ${end ? "end" : "top"})`).toBeLessThanOrEqual(vh);
    expect(b!.y, `${where}: button in the bottom part of the screen`).toBeGreaterThan(vh * 0.75);
    const pos = await button.evaluate((el) => { let n: HTMLElement | null = el as HTMLElement; while (n) { const p = getComputedStyle(n).position; if (p === "fixed" || p === "sticky") return p; n = n.parentElement; } return "static"; });
    expect(["fixed", "sticky"], where).toContain(pos);
  }
}

/** At the end of the page, the last thing in the form is not hidden under the fixed bar. */
async function nothingUnderTheBar(page: Page, bar: Locator, last: Locator, where: string): Promise<void> {
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(100);
  const b = await bar.boundingBox();
  const l = await last.boundingBox();
  expect(b && l, where).toBeTruthy();
  expect(l!.y + l!.height, `${where}: last control ends above the bar`).toBeLessThanOrEqual(b!.y + 1);
}

test("no big empty map before a pin is set; the map appears once there is a place", async ({ page }) => {
  await freshStart(page);
  await expect(page.getByTestId("map-compact")).toBeVisible();
  await expect(page.locator(".leaflet-container")).toHaveCount(0);
  const compact = await page.getByTestId("map-compact").boundingBox();
  expect(compact!.height, "compact note, not a map").toBeLessThan(200);
  // The search box comes before the note, so the form isn't pushed down.
  const search = await searchBox(page).boundingBox();
  expect(search!.y).toBeLessThan(compact!.y);
  await noHorizontalOverflow(page, "location (no pin)");

  // Vehicles before a place: a compact note too.
  await page.getByRole("button", { name: /Next: vehicles/ }).click();
  await expect(page.getByTestId("mini-compact")).toBeVisible();
  await noHorizontalOverflow(page, "vehicles (no pin)");
  await page.getByRole("button", { name: "Set the place" }).click();

  await searchAndPick(page);
  await expect(page.getByTestId("map-compact")).toHaveCount(0);
  await expect(page.locator(".leaflet-container")).toBeVisible();
  await expect(page.locator(".leaflet-marker-icon")).toBeVisible();
  // A compact map (DESIGN.md section 6: 16rem) with Expand map, not a full-height one.
  const map = (await page.locator(".map-frame").boundingBox())!;
  expect(map.height, "compact map").toBeLessThanOrEqual(320);
  await expect(page.getByRole("button", { name: "Expand map" })).toBeVisible();
  await noHorizontalOverflow(page, "location (pin)");

  // "Open the map" also works without a pin.
  await freshStart(page);
  await page.getByRole("button", { name: "Open the map" }).click();
  await expect(page.locator(".leaflet-container")).toBeVisible();
});

test("sticky action bar on every step, and nothing hides under it", async ({ page }) => {
  await freshStart(page);
  await searchAndPick(page);
  await expect(page.locator(".streets-here")).toContainText("Streets at the pin");
  await stickyBar(page, page.getByRole("button", { name: /Next: vehicles/ }), "location");
  await nothingUnderTheBar(page, page.locator("main .actions"), page.getByRole("radiogroup", { name: "What was the road like?" }), "location");

  await page.getByRole("button", { name: /Next: vehicles/ }).click();
  await expect(page.locator("#vehicle-B")).toBeVisible();
  await stickyBar(page, page.getByRole("button", { name: /See the recreation/ }), "vehicles");
  await nothingUnderTheBar(page, page.locator("main .actions"), page.getByRole("button", { name: "Add another vehicle" }), "vehicles");
  await noHorizontalOverflow(page, "vehicles");

  // The gate panel shows above the bar, not under it.
  await page.getByRole("button", { name: /See the recreation/ }).click();
  await expect(page.getByTestId("gate-panel")).toBeVisible();
  await nothingUnderTheBar(page, page.locator("main .actions"), page.getByTestId("gate-panel"), "vehicles (gate)");
  await noHorizontalOverflow(page, "vehicles (gate)");

  await page.locator("#vehicle-A").getByRole("radio", { name: "Northbound on Main Street" }).click();
  await page.locator("#vehicle-B").getByRole("radio", { name: "Westbound on Park Street" }).click();
  await answerVehicle(page, "A", { type: "Car", ...DEFAULT_ANSWERS.A });
  await answerVehicle(page, "B", DEFAULT_ANSWERS.B);
  await page.locator("#vehicle-A").getByRole("radio", { name: "Hit on the right side", exact: true }).click();
  await toReview(page);
  await waitForViewer(page);
  await stickyBar(page, page.getByRole("button", { name: "Looks right: save it" }), "review");
  await noHorizontalOverflow(page, "review");

  await page.getByRole("button", { name: "Looks right: save it" }).click();
  await expect(page.locator("#app")).toHaveAttribute("data-step", "export");
  await stickyBar(page, page.getByRole("button", { name: "Save to my device" }), "save");
  await noHorizontalOverflow(page, "save");
});

test("Measure opens as a tab, with the numbers in it rather than on the small picture", async ({ page }) => {
  await openExample(page, "highway-rear-end");
  const tabs = page.getByRole("tablist", { name: "Scene details" });
  await expect(tabs.getByRole("tab")).toHaveText(["Vehicles", "Measure", "View"]);
  await tabs.getByRole("tab", { name: "Measure" }).click();
  await expect(tabs.getByRole("tab", { name: "Measure" })).toHaveAttribute("aria-selected", "true");
  const panel = page.getByRole("tabpanel");
  await expect(panel.locator(".measure-list > div").first()).toBeVisible();
  await panel.getByRole("checkbox", { name: "Distances at impact" }).check();
  await expect(tabs.getByRole("tab", { name: "Measure" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".viewer3d-measure")).toHaveCount(0);
  await expect(panel.locator(".measure-list dd").first()).toContainText("about");
  await expect(panel.locator(".mnum").first()).toBeVisible();
  await noHorizontalOverflow(page, "review (measure)");
  // Turned on from outside the tab (the Aftermath view switches the distances on), the Measure tab opens by itself.
  await panel.getByRole("checkbox", { name: "Distances at impact" }).uncheck();
  await tabs.getByRole("tab", { name: "Vehicles" }).click();
  await page.getByRole("button", { name: "Aftermath" }).click();
  await expect(tabs.getByRole("tab", { name: "Measure" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel").getByRole("checkbox", { name: "Distances at impact" })).toBeChecked();
  await expect(page.locator(".viewer3d-measure")).toHaveCount(0);
});

test("phone view controls show Top and Wide only", async ({ page }) => {
  await openExample(page, "t-bone-intersection");
  const controls = page.getByRole("radiogroup", { name: "View" });
  await expect(controls.getByRole("radio")).toHaveText(["Top", "Wide"]);
  // The driver keys don't switch to a view that has no control here.
  await page.locator(".viewer-canvas").focus();
  await page.keyboard.press("3");
  await expect(controls.locator("[role=radio][aria-checked=true]")).toHaveText("Top");
  await expect(page.getByRole("button", { name: "Aftermath" })).toBeVisible();
});

for (const name of ["t-bone-intersection", "highway-rear-end", "parking-lot-backing"] as const) {
  test(`no horizontal overflow on Review for ${name}, in every view and at both ends of the timeline`, async ({ page }) => {
    await openExample(page, name);
    for (const key of ["1", "2", "5"]) {
      await page.locator(".viewer-canvas").focus();
      await page.keyboard.press(key);
      for (const t of ["Home", "End"]) {
        await page.getByRole("slider", { name: "Timeline" }).focus();
        await page.keyboard.press(t);
        await page.waitForTimeout(150);
        await noHorizontalOverflow(page, `review ${name} view ${key} @ ${t}`);
      }
    }
  });
}
// Labels spilling past the picture edge on phones are covered by examples.spec.ts "labels, pills and the
// view controls never overlap" (known bug, test.fail), which also runs in this project.
