// The vehicle picker (round B): year, make and model as type-ahead lists over NHTSA vPIC, in Chromium and
// WebKit at 1440 and 390, against the fixtures' offline vPIC slice. "Type '2019 chevy silverado' on my phone
// and get the right make, model and type in a few taps."
// PICKER_SHOTS=<folder> also saves screenshots there (outside the repo) for review.
import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page, TestInfo } from "@playwright/test";
import { expect, freshStart, searchAndPick, test } from "./helpers";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];
/** The search box's known textarea-combobox report (see axe-steps.spec.ts); nothing of the picker's is excused. */
const isKnownSearchBoxRole = (id: string, target: string): boolean => id === "aria-allowed-role" && /-q$/.test(target);

async function toVehicles(page: Page): Promise<void> {
  await freshStart(page);
  await searchAndPick(page);
  await expect(page.locator(".streets-here")).toContainText("Streets at the pin");
  await page.getByRole("button", { name: /Next: vehicles/ }).click();
  await expect(page.locator("#vehicle-B")).toBeVisible();
}

const fieldOf = (card: Locator, label: "Year" | "Make" | "Model") => card.getByRole("combobox", { name: label, exact: true });
const listOf = async (field: Locator, page: Page) => page.locator(`[id="${await field.getAttribute("aria-controls")}"]`);
const optionsOf = async (field: Locator, page: Page) => (await listOf(field, page)).getByRole("option");

async function shot(page: Page, info: TestInfo, name: string): Promise<void> {
  const dir = process.env.PICKER_SHOTS;
  if (dir) await page.screenshot({ path: `${dir}/${name}-${info.project.name}.png` });
}

test.describe("the vehicle picker", () => {
  test("@xb 2019 chevy silverado by tapping the list, then vehicle B by keyboard", async ({ page, pageErrors }, info) => {
    await toVehicles(page);
    const a = page.locator("#vehicle-A");
    const year = fieldOf(a, "Year");
    const make = fieldOf(a, "Make");
    const model = fieldOf(a, "Model");
    await expect(make).toHaveValue("Honda");   // from the claim

    // Year: type it like a person; the list is open as you type; tap the year.
    await year.click();
    await year.fill("");
    await year.pressSequentially("2019", { delay: 60 });
    await expect(year).toHaveAttribute("aria-expanded", "true");
    await expect(await optionsOf(year, page)).toHaveText(["2019"]);
    await (await optionsOf(year, page)).first().click();
    await expect(year).toHaveValue("2019");
    await expect(make).toBeFocused();

    // Make: "chevy" lists Chevrolet first.
    await make.fill("");
    await make.pressSequentially("chevy", { delay: 60 });
    await expect(make).toHaveAttribute("aria-expanded", "true");
    const makes = await optionsOf(make, page);
    await expect(makes.first()).toHaveText("Chevrolet");
    await expect(makes.last()).toHaveText("Use ‘chevy’ as typed");
    await expect(make).toHaveAttribute("aria-activedescendant", (await makes.first().getAttribute("id")) ?? "");
    await shot(page, info, "picker-make-open");
    await makes.first().click();
    await expect(make).toHaveValue("Chevrolet");
    await expect(model).toBeFocused();

    // Model: the list for Chevrolet 2019 opens on its own; "silverado" puts Silverado 1500 first.
    await expect(model).toHaveAttribute("aria-expanded", "true");
    await model.pressSequentially("silverado", { delay: 60 });
    const models = await optionsOf(model, page);
    await expect(models.first()).toContainText("Silverado 1500");
    await expect(models.first()).toContainText("Pickup");
    await shot(page, info, "picker-model-open");
    await models.first().click();
    await expect(model).toHaveValue("Silverado 1500");
    await expect(model).toHaveAttribute("aria-expanded", "false");
    await expect(a.getByRole("radio", { name: /Pickup/ })).toHaveAttribute("aria-checked", "true");
    await expect(a.locator(".lookup")).toContainText("Pickup from NHTSA vPIC (Truck). Weight and size: pickup class average.");
    await expect(a.locator(".vehicle-sub")).toContainText("2019 Chevrolet Silverado 1500");

    // Vehicle B with the keyboard only: 2015, vw, jetta, Enter each time.
    const b = page.locator("#vehicle-B");
    await fieldOf(b, "Year").click();
    await page.keyboard.type("2015", { delay: 60 });
    await page.keyboard.press("Enter");
    await expect(fieldOf(b, "Year")).toHaveValue("2015");
    await expect(fieldOf(b, "Make")).toBeFocused();
    await page.keyboard.type("vw", { delay: 60 });
    await expect((await optionsOf(fieldOf(b, "Make"), page)).first()).toHaveText("Volkswagen");
    await page.keyboard.press("Enter");
    await expect(fieldOf(b, "Make")).toHaveValue("Volkswagen");
    await expect(fieldOf(b, "Model")).toBeFocused();
    await expect((await optionsOf(fieldOf(b, "Model"), page)).first()).toBeVisible();
    await page.keyboard.type("jetta", { delay: 60 });
    await expect((await optionsOf(fieldOf(b, "Model"), page)).first()).toContainText("Jetta");
    await page.keyboard.press("Enter");
    await expect(fieldOf(b, "Model")).toHaveValue("Jetta");
    await expect(b.getByRole("radio", { name: /^Car/ })).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
    await shot(page, info, "picker-done");

    // Nothing wider than the screen, and no busy or map-service text anywhere on the step.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(page.locator("#app")).not.toContainText(/map requests|map service/);
    expect(pageErrors()).toEqual([]);
  });

  test("@xb a make and model vPIC doesn't know are kept as typed", async ({ page, pageErrors }) => {
    await toVehicles(page);
    const b = page.locator("#vehicle-B");
    await fieldOf(b, "Year").fill("2019");
    const make = fieldOf(b, "Make");
    await make.click();
    await make.pressSequentially("Zephyr", { delay: 40 });
    await expect(await optionsOf(make, page)).toHaveText(["Use ‘Zephyr’ as typed"]);
    await page.keyboard.press("Enter");
    await expect(make).toHaveValue("Zephyr");
    // vPIC may know a make outside the list: it is asked for once, as typed, and has no models.
    await expect(b.locator(".lookup")).toContainText("No Zephyr models found for 2019. Pick the type below.");
    const model = fieldOf(b, "Model");
    await model.click();
    await model.pressSequentially("Roadster", { delay: 40 });
    await page.keyboard.press("Enter");
    await expect(model).toHaveValue("Roadster");
    await b.getByRole("radio", { name: /^Car/ }).click();
    await expect(b.getByRole("radio", { name: /^Car/ })).toHaveAttribute("aria-checked", "true");
    expect(pageErrors()).toEqual([]);
  });

  for (const theme of ["light", "dark"] as const) {
    test(`@xb axe on the vehicles step with the lists open (${theme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await toVehicles(page);
      const b = page.locator("#vehicle-B");
      const found: string[] = [];
      const axe = async (where: string) => {
        const res = await new AxeBuilder({ page }).withTags(TAGS).analyze();
        found.push(...res.violations
          .map((v) => ({ ...v, nodes: v.nodes.filter((n) => !isKnownSearchBoxRole(v.id, n.target.join(" "))) }))
          .filter((v) => v.nodes.length > 0)
          .map((v) => `${where}: [${v.impact}] ${v.id} — ${v.help} — ${v.nodes.slice(0, 4).map((n) => n.target.join(" ")).join(" | ")}`));
      };
      await fieldOf(b, "Year").click();
      await expect(await optionsOf(fieldOf(b, "Year"), page)).not.toHaveCount(0);
      await axe("year list open");
      await page.keyboard.type("2019");
      await page.keyboard.press("Enter");
      await page.keyboard.type("ch");
      await expect((await optionsOf(fieldOf(b, "Make"), page)).first()).toBeVisible();
      await page.keyboard.press("ArrowDown");
      await axe("make list open, a row highlighted");
      await page.keyboard.press("Escape");
      await fieldOf(b, "Make").fill("Ford");
      await fieldOf(b, "Model").click();
      await expect((await optionsOf(fieldOf(b, "Model"), page)).first()).toBeVisible();
      await axe("model list open");
      expect(found).toEqual([]);
    });
  }
});
