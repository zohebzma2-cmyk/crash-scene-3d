// Tips for first-time users: shown on a first visit, dismissible, remembered per device, brought
// back by "Show tips", accessible, and never in the way of the primary action. Runs at desktop and phone.
// A full-suite run with the tips shown in every spec (2026-10-10) failed on layout only: the tip's height pushed the
// Location map's attribution below 900 px (map.spec) and shortened the Review picture so labels crowded (examples.spec).
// Every other spec therefore starts with tips hidden (playwright.config.ts); this one starts clean.
import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";
import { DEFAULT_ANSWERS, answerVehicle, boxes, expect, intersections, isPhone, openExample, searchAndPick, test, toReview, waitForViewer } from "./helpers";

// A real first visit for the tips: playwright.config.ts seeds tips hidden for every other spec. (Fixtures mode keeps the
// first-visit welcome away unless ?welcome=1; the last test here asks for it.)
test.use({ storageState: { cookies: [], origins: [] } });

const tip = (page: Page): Locator => page.locator(".tip");
const showTips = (page: Page): Locator => page.getByRole("button", { name: "Show tips" });

/** Walks the default claim, calling `at` on each step with its name. */
async function eachStep(page: Page, at: (step: "location" | "vehicles" | "review" | "export") => Promise<void>): Promise<void> {
  await page.goto("/#location");
  await expect(page.locator("main h1")).toHaveText("Where did it happen?");
  await at("location");
  await searchAndPick(page);
  await expect(page.locator(".streets-here")).toContainText("Streets at the pin");
  await page.getByRole("button", { name: /Next: vehicles/ }).click();
  await expect(page.locator("#vehicle-A")).toBeVisible();
  await page.locator("#vehicle-A").getByRole("radio", { name: "Northbound on Main Street" }).click();
  await page.locator("#vehicle-B").getByRole("radio", { name: "Westbound on Park Street" }).click();
  await answerVehicle(page, "A", { type: "Car", ...DEFAULT_ANSWERS.A });
  await answerVehicle(page, "B", DEFAULT_ANSWERS.B);
  await at("vehicles");
  await toReview(page);
  await waitForViewer(page);
  await at("review");
  await page.getByRole("button", { name: "Looks right: save it" }).click();
  await expect(page.locator("main h1")).toHaveText("What do you want to save?");
  await at("export");
}

const PRIMARY: Record<string, string> = { location: "Next: vehicles", vehicles: "See the recreation", review: "Looks right: save it", export: "Save to my device" };

test("tips show by default on every step, as a labelled note that takes no focus", async ({ page }) => {
  await eachStep(page, async (step) => {
    await expect(tip(page)).toHaveCount(1);
    await expect(tip(page)).toHaveAttribute("role", "note");
    await expect(tip(page)).toHaveAttribute("aria-label", /^Tip: .+/);
    await expect(tip(page).getByRole("button", { name: /^Hide tip: / })).toBeVisible();
    await expect(tip(page).getByRole("button", { name: "Hide all tips" })).toBeVisible();
    await expect(showTips(page)).toHaveCount(0);
    // The step's own title (not the tip) has the focus, and the tip announces nothing by itself.
    expect(await page.evaluate(() => document.activeElement?.closest(".tip") === null)).toBe(true);
    await expect(page.locator(".tip [aria-live]")).toHaveCount(0);
    void step;
  });
});

test("a dismissed tip stays dismissed after a reload; Show tips brings it back", async ({ page }) => {
  await page.goto("/#location");
  await tip(page).getByRole("button", { name: /^Hide tip: / }).click();
  await expect(tip(page)).toHaveCount(0);
  await expect(showTips(page)).toBeFocused();
  await page.reload();
  await expect(page.locator("main h1")).toBeVisible();
  await expect(tip(page)).toHaveCount(0);
  await expect(showTips(page)).toBeVisible();
  await showTips(page).click();
  await expect(tip(page)).toHaveCount(1);
  await expect(showTips(page)).toHaveCount(0);
  await page.reload();
  await expect(tip(page)).toHaveCount(1);
});

test("Hide all tips hides them on every step and Show tips is on each step", async ({ page }) => {
  await page.goto("/#location");
  await page.getByRole("button", { name: "Hide all tips" }).click();
  await eachStep(page, async () => {
    await expect(tip(page)).toHaveCount(0);
    await expect(showTips(page)).toBeVisible();
  });
  await showTips(page).click();
  await expect(tip(page)).toHaveCount(1);
});

// Present with the tips hidden too (the default claim's Vehicles tab on Review scrolls without a focusable child): not caused by tips.
const KNOWN = new Set(["scrollable-region-focusable"]);

test("no axe violations with the tips shown", async ({ page }) => {
  const tags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];
  await eachStep(page, async (step) => {
    // The whole page: nothing serious or critical (the bar a11y.spec.ts holds every step to).
    const res = await new AxeBuilder({ page }).withTags(tags).analyze();
    const bad = res.violations.filter((v) => (v.impact === "serious" || v.impact === "critical") && !KNOWN.has(v.id)).map((v) => `${step}: [${v.impact}] ${v.id} - ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
    expect(bad, `axe on ${step}`).toEqual([]);
    // The tip itself: no violation of any impact.
    const own = await new AxeBuilder({ page }).include(".tip").withTags(tags).analyze();
    expect(own.violations.map((v) => `${step}: [${v.impact}] ${v.id}`), `axe on the ${step} tip`).toEqual([]);
  });
});

test("tips never overlap the primary button, stay inside the page and have big enough buttons", async ({ page }) => {
  await eachStep(page, async (step) => {
    const card = await tip(page).boundingBox();
    const primary = await page.getByRole("button", { name: PRIMARY[step]!, exact: false }).first().boundingBox();
    expect(card, "tip box").not.toBeNull();
    expect(primary, "primary button box").not.toBeNull();
    const overlap = card!.x < primary!.x + primary!.width && primary!.x < card!.x + card!.width && card!.y < primary!.y + primary!.height && primary!.y < card!.y + card!.height;
    expect(overlap, `${step}: tip overlaps the primary button`).toBe(false);
    const vw = page.viewportSize()!.width;
    expect(card!.x).toBeGreaterThanOrEqual(0);
    expect(card!.x + card!.width).toBeLessThanOrEqual(vw + 0.5);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    for (const b of await tip(page).getByRole("button").all()) {
      const box = (await b.boundingBox())!;
      expect(box.height, `${step}: tap target height`).toBeGreaterThanOrEqual(43.5);
      expect(box.width, `${step}: tap target width`).toBeGreaterThanOrEqual(43.5);
    }
  });
});

test("Tab reaches the tip's buttons from the keyboard, with a visible focus ring", async ({ page, isMobile }) => {
  test.skip(isMobile === true, "keyboard path is checked at desktop");
  await page.goto("/#location");
  const hideAll = page.getByRole("button", { name: "Hide all tips" });
  await hideAll.focus();
  await page.keyboard.press("Tab");
  await expect(tip(page).getByRole("button", { name: /^Hide tip: / })).toBeFocused();
  const outline = await tip(page).getByRole("button", { name: /^Hide tip: / }).evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(outline).toBe("solid");
  await page.keyboard.press("Enter");
  await expect(showTips(page)).toBeFocused();
});

test("the header's Show tips is a big enough tap target", async ({ page }) => {
  await page.goto("/#location");
  await tip(page).getByRole("button", { name: /^Hide tip: / }).click();
  const box = (await showTips(page).boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(43.5);
  expect(box.width).toBeGreaterThanOrEqual(43.5);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

// The first-visit layout failures a full-suite run found with tips shown, now held to the same bar as the other specs.
test("Location with a tip showing: the map's attribution is on screen and uncovered", async ({ page }) => {
  await page.goto("/?example=t-bone-intersection#review");
  await expect(page.locator("main h1")).toHaveText("Does this match what happened?");
  // Loaded means the picture is up (the heading shows with the loading box, before the roads are in).
  await expect(page.locator(".viewer-canvas")).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
  await page.evaluate(() => { location.hash = "#location"; });
  await expect(page.locator("main h1")).toHaveText("Where did it happen?");
  await expect(tip(page)).toHaveCount(1);
  const link = page.getByRole("link", { name: "© OpenStreetMap contributors" });
  await expect(link).toBeVisible();
  await page.waitForTimeout(500);
  // Desktop: on screen as the page opens (900 px tall). Phone: the map is below the title, search and tip, so it is
  // scrolled to like any page; what matters there is that the fixed action bar does not sit on it.
  if (isPhone(page)) { await link.evaluate((a) => a.scrollIntoView({ block: "center" })); await page.waitForTimeout(200); }
  const covered = await link.evaluate((a) => {
    const r = a.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !(hit === a || a.contains(hit));
  });
  expect(covered, "attribution is below the fold or covered").toBe(false);
});

test("Review with a tip showing: labels, pills and the view controls never overlap", async ({ page }) => {
  await openExample(page, "t-bone-intersection");
  await expect(tip(page)).toHaveCount(1);
  await page.getByRole("tab", { name: "Measure" }).click();
  await page.getByRole("checkbox", { name: "Distances at impact" }).check();
  const problems: string[] = [];
  const views = isPhone(page) ? [["Top", "1"], ["Wide", "2"], ["Aftermath", "5"]] : [["Top", "1"], ["Wide", "2"], ["Driver A", "3"], ["Driver B", "4"], ["Aftermath", "5"]];
  for (const [view, viewKey] of views) {
    for (const key of ["Home", "i", "End"]) {
      await page.locator(".viewer-canvas").focus();
      await page.keyboard.press(viewKey!);
      await page.getByRole("slider", { name: "Timeline" }).focus();
      await page.keyboard.press(key);
      await page.waitForTimeout(300);
      const canvasBox = await page.locator(".viewer-canvas").boundingBox();
      const list = [
        ...(await boxes(page, ".viewer3d-label", "label")),
        ...(await boxes(page, ".view-controls", "view controls")),
        ...(await boxes(page, ".scene-caption", "caption")),
        ...(await boxes(page, ".viewer3d-controls", "zoom buttons")),
        ...(await boxes(page, ".viewer3d-legend", "legend")),
      ];
      for (const hit of intersections(list)) problems.push(`${view} @ ${key}: ${hit}`);
      if (canvasBox) for (const b of list) {
        if (b.x < canvasBox.x - 1 || b.y < canvasBox.y - 1 || b.x + b.width > canvasBox.x + canvasBox.width + 1 || b.y + b.height > canvasBox.y + canvasBox.height + 1) problems.push(`${view} @ ${key}: ${b.label} leaves the picture`);
      }
    }
  }
  expect(problems).toEqual([]);
});

// The welcome and the tips together on a real first visit (DESIGN.md section 19): the welcome comes first, over the
// page with the Location tip already in it; after Dismiss the tip is there and works, and a reload keeps the tip, not the welcome.
test("@xb first visit: the welcome first, then the Location tip after Dismiss", async ({ page }) => {
  await page.goto("/?welcome=1");
  const welcome = page.getByRole("dialog", { name: "See what happened, in 3D" });
  await expect(welcome).toBeVisible();
  await expect(page.getByRole("button", { name: "Try an example" })).toBeFocused();
  // The tip is already in the page behind the modal.
  await expect(tip(page)).toHaveCount(1);
  await page.getByRole("button", { name: "Dismiss" }).click();
  await expect(welcome).toHaveCount(0);
  await expect(page.locator("#app")).toHaveAttribute("data-step", "location");
  await expect(tip(page)).toHaveCount(1);
  await expect(tip(page)).toHaveAttribute("aria-label", "Tip: Finding the place");
  await tip(page).getByRole("button", { name: /^Hide tip: / }).click();
  await expect(tip(page)).toHaveCount(0);
  await page.reload();
  await expect(page.locator("main h1")).toHaveText("Where did it happen?");
  await expect(showTips(page)).toBeVisible();
  await expect(welcome).toHaveCount(0);
});

