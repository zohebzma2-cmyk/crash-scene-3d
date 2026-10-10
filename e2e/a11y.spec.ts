// 4. Keyboard and accessibility: roving arrows in tabs and radio groups, a stepper that can't skip
// the checks (not even by URL), focus on the h1 after each move, and axe on every step.
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, fillDefaultClaim, freshStart, openExample, searchAndPick, searchBox, test, toReview, waitForViewer } from "./helpers";

async function axe(page: Page, where: string): Promise<void> {
  const res = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"]).analyze();
  const bad = res.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${where}: [${v.impact}] ${v.id} — ${v.help} — ${v.nodes.slice(0, 4).map((n) => n.target.join(" ")).join(" | ")}`);
  expect(bad, `axe on ${where}`).toEqual([]);
}

const focusedText = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.textContent?.trim() ?? "");

test.describe("keyboard", () => {
  test("radio groups rove with the arrow keys", async ({ page }) => {
    await freshStart(page);
    const place = page.getByRole("radiogroup", { name: "What kind of place?" });
    const checked = place.locator("[role=radio][aria-checked=true]");
    await expect(checked).toHaveText("Intersection");
    // One tab stop per group: only the checked radio is tabbable.
    await expect(place.locator("[role=radio][tabindex='0']")).toHaveCount(1);
    await checked.focus();
    await page.keyboard.press("ArrowRight");
    await expect(place.getByRole("radio", { name: "Road" })).toBeFocused();
    await expect(place.getByRole("radio", { name: "Road" })).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("ArrowDown");
    await expect(place.getByRole("radio", { name: "Parking lot" })).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("ArrowRight"); // wraps
    await expect(place.getByRole("radio", { name: "Intersection" })).toBeFocused();
    await page.keyboard.press("End");
    await expect(place.getByRole("radio", { name: "Parking lot" })).toBeFocused();
    await page.keyboard.press("Home");
    await expect(place.getByRole("radio", { name: "Intersection" })).toHaveAttribute("aria-checked", "true");
    await expect(place.locator("[role=radio][tabindex='0']")).toHaveCount(1);

    // The road condition group too.
    const road = page.getByRole("radiogroup", { name: "What was the road like?" });
    await road.locator("[role=radio][aria-checked=true]").focus();
    await page.keyboard.press("ArrowLeft");
    await expect(road.getByRole("radio", { name: "Ice" })).toHaveAttribute("aria-checked", "true");
  });

  test("tabs rove with the arrow keys", async ({ page }) => {
    await openExample(page, "t-bone-intersection");
    const tabs = page.getByRole("tablist", { name: "Scene details" });
    await tabs.getByRole("tab", { name: "Vehicles" }).focus();
    await expect(tabs.locator("[role=tab][tabindex='0']")).toHaveCount(1);
    await page.keyboard.press("ArrowRight");
    await expect(tabs.getByRole("tab", { name: "Measure" })).toBeFocused();
    await expect(tabs.getByRole("tab", { name: "Measure" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tabpanel")).toContainText("Distances at impact");
    await page.keyboard.press("End");
    await expect(tabs.getByRole("tab", { name: "View" })).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("ArrowRight"); // wraps
    await expect(tabs.getByRole("tab", { name: "Vehicles" })).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(tabs.getByRole("tab", { name: "View" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tabpanel")).toBeVisible();
    // The tab and its panel are tied together.
    const panelId = await tabs.getByRole("tab", { name: "View" }).getAttribute("aria-controls");
    await expect(page.locator(`#${panelId}`)).toHaveAttribute("role", "tabpanel");
  });

  test("focus moves to the h1 on every step change", async ({ page }) => {
    await fillDefaultClaim(page);
    // fillDefaultClaim moved from Location to Vehicles.
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(page.locator("main h1")).toHaveText("Where did it happen?");
    await expect(page.locator("main h1")).toBeFocused();
    await page.getByRole("button", { name: /Next: vehicles/ }).click();
    await expect(page.locator("main h1")).toHaveText("Which vehicles were involved?");
    await expect(page.locator("main h1")).toBeFocused();
    await page.locator("#vehicle-A").getByRole("radio", { name: "Hit on the right side", exact: true }).click();
    await toReview(page);
    await expect(page.locator("main h1")).toBeFocused();
    await page.getByRole("button", { name: "Looks right: save it" }).click();
    await expect(page.locator("main h1")).toHaveText("What do you want to save?");
    await expect(page.locator("main h1")).toBeFocused();
  });
});

test.describe("the stepper can't skip the checks", () => {
  test("stepper links to Review and Save are gated", async ({ page }) => {
    await freshStart(page);
    // The phone shows a compact stepper; the links are still in the page for keyboard and screen readers.
    for (const name of ["Review", "Save"]) {
      await page.locator(".stepper a", { hasText: name }).dispatchEvent("click");
      await expect(page.locator("#app")).toHaveAttribute("data-step", "location");
      await expect(page.getByTestId("gate-panel")).toContainText("Tell us where it happened first");
      await expect(page.getByTestId("gate-panel").getByRole("button", { name: "See it anyway" })).toHaveCount(0);
    }
  });

  for (const target of ["review", "export"]) {
    test(`a direct #${target} URL on an empty doc goes back to Location`, async ({ page }) => {
      await freshStart(page);
      await page.goto(`/#${target}`);
      await expect(page.locator("#app")).toHaveAttribute("data-step", "location");
      await expect(page).toHaveURL(/#location$/);
      await expect(page.locator("main h1")).toHaveText("Where did it happen?");
      await expect(page.getByTestId("gate-panel")).toContainText("Tell us where it happened first");
      await expect(page.locator(".viewer3d, .viewer-canvas")).toHaveCount(0);
    });

    test(`a direct #${target} URL with the place set but no directions goes to Vehicles`, async ({ page }) => {
      await freshStart(page);
      await searchAndPick(page);
      await expect(page.locator(".coords-label")).toContainText("From search");
      await page.goto(`/#${target}`);
      await expect(page.locator("#app")).toHaveAttribute("data-step", "vehicles");
      await expect(page.getByTestId("gate-panel")).toContainText("Pick which way your car (A) was going.");
      await expect(page.getByTestId("gate-panel").getByRole("button", { name: "See it anyway" })).toHaveCount(0);
    });
  }
});

test.describe("axe: no serious or critical violations", () => {
  test("location, vehicles (with the gate), review and save", async ({ page }) => {
    await freshStart(page);
    await axe(page, "location (no pin)");
    // The combobox with its suggestions open.
    await searchBox(page).fill("Main Str");
    await expect(page.getByRole("listbox")).toBeVisible();
    await expect(page.getByRole("option").first()).toBeVisible();
    await axe(page, "location (suggestions open)");
    await searchAndPick(page);
    await expect(page.locator(".streets-here")).toContainText("Streets at the pin");
    await axe(page, "location (pin + results)");
    await page.getByRole("button", { name: /Next: vehicles/ }).click();
    await expect(page.locator("#vehicle-B")).toBeVisible();
    await page.getByRole("button", { name: /See the recreation/ }).click();
    await expect(page.getByTestId("gate-panel")).toBeVisible();
    await axe(page, "vehicles (gate showing)");
    await page.locator("#vehicle-A").getByRole("radio", { name: "Northbound on Main Street" }).click();
    await page.locator("#vehicle-B").getByRole("radio", { name: "Westbound on Park Street" }).click();
    await page.locator("#vehicle-A").getByRole("radio", { name: "Hit on the right side", exact: true }).click();
    await toReview(page);
    await waitForViewer(page);
    await axe(page, "review");
    await page.getByRole("tab", { name: "Measure" }).click();
    await axe(page, "review (measure)");
    await page.getByRole("button", { name: "Aftermath" }).click();
    await expect(page.locator(".scene-caption")).toHaveText("Aftermath view");
    await axe(page, "review (aftermath)");
    await page.getByRole("button", { name: "Looks right: save it" }).click();
    await expect(page.locator("#app")).toHaveAttribute("data-step", "export");
    await expect(page.locator(".preview-frame")).not.toContainText("Making the preview");
    await axe(page, "save");
  });

  test("dark theme review", async ({ page }) => {
    // Regression guard, fixed 2026-10-09 (dark theme contrast, phones): the "AI" of the logo is --color-logo #2369D7 on the dark header
    // #0F172A, 3.46:1. At the phone's 14 px bold that needs 4.5:1 (desktop's larger logo passes as large
    // text). --color-logo has no dark value (design/tokens.css:36; used at apps/web/src/styles/base.css:48).
    await page.emulateMedia({ colorScheme: "dark" });
    await openExample(page, "highway-rear-end");
    await axe(page, "review (dark)");
    await freshStart(page);
    await searchAndPick(page);
    await expect(page.locator(".streets-here")).toContainText("Streets at the pin");
    await axe(page, "location with the map (dark)");
  });
});

test("the about dialog: Learn more opens it and Escape closes it, returning focus", async ({ page }) => {
  await freshStart(page);
  await page.getByRole("button", { name: "Learn more" }).click();
  const dialog = page.getByRole("dialog", { name: "About this illustration" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("It is not an expert accident reconstruction");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  expect(await focusedText(page)).toBe("Learn more");
});
