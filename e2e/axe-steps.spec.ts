// axe on EVERY step and state, in light and dark (the OS setting and the header toggle), at 1440 and 390.
// Stricter than a11y.spec.ts: any violation of any impact fails (WCAG 2.0/2.1/2.2 A + AA and best practice).
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { EXAMPLES, expect, fillDefaultClaim, freshStart, isPhone, openExample, searchAndPick, searchBox, test, toReview, waitForViewer } from "./helpers";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

/**
 * One known, reported bug is left out here so the rest stays strict; it has its own test.fail below.
 * BUG (axe aria-allowed-role, minor): the search box is a growing <textarea role="combobox">
 * (apps/web/src/components/SearchPanel.tsx:341-349), and ARIA doesn't allow the combobox role on a textarea.
 */
const isKnownSearchBoxRole = (id: string, target: string): boolean => id === "aria-allowed-role" && /-q$/.test(target);

/** Runs axe and returns readable violations (every impact). */
async function axe(page: Page, where: string, { known = true } = {}): Promise<string[]> {
  const res = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return res.violations
    .map((v) => ({ ...v, nodes: v.nodes.filter((n) => !(known && isKnownSearchBoxRole(v.id, n.target.join(" ")))) }))
    .filter((v) => v.nodes.length > 0)
    .map((v) => `${where}: [${v.impact}] ${v.id} — ${v.help} — ${v.nodes.slice(0, 4).map((n) => n.target.join(" ")).join(" | ")}`);
}

const THEMES = ["light", "dark"] as const;

for (const theme of THEMES) {
  test.describe(`axe on every step (${theme})`, () => {
    test.beforeEach(async ({ page }) => { await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" }); });

    test(`location, vehicles, gate, review views, measure, save, dialog (${theme})`, async ({ page }) => {
      const found: string[] = [];
      await freshStart(page);
      found.push(...await axe(page, "location (empty)"));
      await searchBox(page).fill("Main Str");
      await expect(page.getByRole("option").first()).toBeVisible();
      found.push(...await axe(page, "location (suggestions open)"));
      await searchAndPick(page);
      await expect(page.locator(".streets-here")).toContainText("Streets at the pin");
      found.push(...await axe(page, "location (with a place)"));

      // The theme toggle, both ways.
      const toggle = page.getByRole("button", { name: /Switch to the (light|dark) theme/ });
      await toggle.click();
      found.push(...await axe(page, `location (toggled away from ${theme})`));
      await toggle.click();
      found.push(...await axe(page, `location (toggled back to ${theme})`));

      // About dialog.
      await page.getByRole("button", { name: "Learn more" }).click();
      await expect(page.getByRole("dialog", { name: "About this illustration" })).toBeVisible();
      found.push(...await axe(page, "about dialog"));
      await page.keyboard.press("Escape");

      await page.getByRole("button", { name: /Next: vehicles/ }).click();
      await expect(page.locator("#vehicle-B")).toBeVisible();
      found.push(...await axe(page, "vehicles"));
      await page.getByRole("button", { name: /See the recreation/ }).click();
      await expect(page.getByTestId("gate-panel")).toBeVisible();
      found.push(...await axe(page, "vehicles (gate panel)"));

      await page.locator("#vehicle-A").getByRole("radio", { name: "Northbound on Main Street" }).click();
      await page.locator("#vehicle-B").getByRole("radio", { name: "Westbound on Park Street" }).click();
      // The default claim (A hit on the left) doesn't fit together: the gate offers its one-tap fixes.
      await page.getByRole("button", { name: /See the recreation/ }).click();
      await expect(page.getByTestId("gate-fixes").locator("button.refusal-fix").first()).toBeVisible({ timeout: 30_000 });
      found.push(...await axe(page, "vehicles (gate panel with one-tap fixes)"));
      await page.locator("#vehicle-A").getByRole("radio", { name: "Hit on the right side", exact: true }).click();
      await toReview(page);
      await waitForViewer(page);
      found.push(...await axe(page, "review (at impact)"));
      const views = isPhone(page) ? ["Top", "Wide"] : ["Top", "Wide", "Driver A", "Driver B"];
      for (const v of views) {
        await page.getByRole("radiogroup", { name: "View" }).getByRole("radio", { name: v, exact: true }).click();
        await expect(page.locator(".scene-caption")).toHaveText(`${v} view`);
        found.push(...await axe(page, `review (${v})`));
      }
      await page.getByRole("button", { name: "Aftermath" }).click();
      await expect(page.locator(".scene-caption")).toHaveText("Aftermath view");
      found.push(...await axe(page, "review (Aftermath)"));
      await page.getByRole("tab", { name: "Measure" }).click();
      await page.getByRole("checkbox", { name: "Travel paths" }).check();
      found.push(...await axe(page, "review (Measure tab, distances + travel on)"));
      await page.getByRole("tab", { name: "View" }).click();
      found.push(...await axe(page, "review (View tab)"));

      await page.getByRole("button", { name: "Looks right: save it" }).click();
      await expect(page.locator("#app")).toHaveAttribute("data-step", "export");
      await expect(page.locator(".preview-frame")).not.toContainText("Making the preview", { timeout: 60_000 });
      found.push(...await axe(page, "save"));
      expect(found).toEqual([]);
    });

    test(`the refusal screen (${theme})`, async ({ page }) => {
      // Section 18: moving apart is never drawn. A northbound, B southbound on the same road, both hit on the rear.
      await fillDefaultClaim(page);
      await page.locator("#vehicle-B").getByRole("radio", { name: "Southbound on Main Street" }).click();
      await page.locator("#vehicle-A").getByRole("radio", { name: "Hit on the rear", exact: true }).click();
      await page.locator("#vehicle-B").getByRole("radio", { name: "Hit on the rear", exact: true }).click();
      await page.getByRole("button", { name: /See the recreation/ }).click();
      const anyway = page.getByTestId("gate-panel").getByRole("button", { name: "See it anyway" });
      if (await anyway.isVisible()) await anyway.click();
      await expect(page.locator(".review-fail")).toBeVisible({ timeout: 30_000 });
      expect(await axe(page, "refusal")).toEqual([]);
    });

    test(`the three examples on Review (${theme})`, async ({ page }) => {
      const found: string[] = [];
      for (const name of EXAMPLES) {
        await openExample(page, name);
        found.push(...await axe(page, `${name} review`));
      }
      expect(found).toEqual([]);
    });
  });
}

test("BUG: the search box's combobox role is allowed on its element (axe aria-allowed-role)", async ({ page }) => {
  // Known bug, see isKnownSearchBoxRole: <textarea role="combobox"> at apps/web/src/components/SearchPanel.tsx:341-349.
  // Fix by making the box an <input> (or wrapping it in an ARIA 1.2 combobox); then remove test.fail and the filter.
  test.fail();
  await freshStart(page);
  expect((await axe(page, "location", { known: false })).filter((v) => v.includes("aria-allowed-role"))).toEqual([]);
});
