// The owner's polish list, item 5 (DESIGN.md sections 5 and 18), in Chromium and WebKit at 1440 and 390:
//  5b. a direction not picked yet is a missing detail ("Pick which way your car was going."), never "don't fit together";
//  5a. details that don't fit together on the Vehicles step get the same one-tap fixes as the Review refusal, from the
//      fixer's Web Worker; a tap changes the details, the warning goes away, and "See it anyway" / "Fix the details" stay.
import type { Page } from "@playwright/test";
import { expect, fillDefaultClaim, freshStart, openExample, searchAndPick, test } from "./helpers";
import { routeVehiclesToFakeProxy } from "./fake-proxy";

test.describe("the Vehicles step's warnings", () => {
  test("@xb an unpicked direction reads as missing, with no fixes and no 'See it anyway'", async ({ page, pageErrors }) => {
    await freshStart(page);
    await searchAndPick(page);
    await expect(page.locator(".streets-here")).toContainText("Streets at the pin");
    await page.getByRole("button", { name: /Next: vehicles/ }).click();
    await expect(page.locator("#vehicle-A")).toBeVisible();
    await page.getByRole("button", { name: /See the recreation/ }).click();
    const gate = page.getByTestId("gate-panel");
    const alert = gate.getByRole("alert");
    await expect(alert).toContainText("Some details are missing");
    await expect(alert).not.toContainText("don't fit together");
    await expect(alert).toContainText("Pick which way your car was going.");
    await expect(alert).toContainText("Pick which way vehicle B was going.");
    await expect(gate.getByTestId("gate-fixes")).toHaveCount(0);
    await expect(gate.getByRole("button", { name: "See it anyway" })).toHaveCount(0);
    await expect(gate.getByRole("button", { name: "Fix the details" })).toBeVisible();
    // Picking A's direction leaves B's as the one missing detail.
    await page.locator("#vehicle-A").getByRole("radio", { name: "Northbound on Main Street" }).click();
    await expect(alert).not.toContainText("your car was going");
    await expect(alert).toContainText("Pick which way vehicle B was going.");
    await expect(alert).toContainText("Some details are missing");
    expect(pageErrors()).toEqual([]);
  });

  test("@xb details that don't fit together offer one-tap fixes from the worker; a tap clears the warning", async ({ page, pageErrors }) => {
    // The default claim: A northbound on Main marked hit on the left, B westbound on Park. It only draws with A's right side.
    await fillDefaultClaim(page);
    await page.getByRole("button", { name: /See the recreation/ }).click();
    const gate = page.getByTestId("gate-panel");
    await expect(gate.getByRole("alert")).toContainText("Some details don't fit together");
    await expect(gate.getByRole("alert")).not.toContainText("missing");
    const area = gate.getByTestId("gate-fixes");
    const fixes = area.locator("button.refusal-fix");
    await expect(fixes.first()).toBeVisible({ timeout: 30_000 });
    // The search ran in the module Web Worker (CSP worker-src 'self'), as on Review.
    await expect(area).toHaveAttribute("data-fixer", "worker");
    const n = await fixes.count();
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(3);
    await expect(fixes.first()).toHaveText("Change A's hit side to Right side");
    for (const label of await fixes.allInnerTexts()) expect(label).toMatch(/^(Change [A-D]'s (hit side|direction|action|lane|speed) to |Swap who hit whom: |Move the pin about )/);
    await expect(area.getByRole("status")).toHaveText(`${n === 1 ? "One small change" : `${n} small changes`} would make them fit. Pick one only if it matches what happened:`);
    await expect(gate.getByRole("button", { name: "See it anyway" })).toBeVisible();
    await expect(gate.getByRole("button", { name: "Fix the details" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    await fixes.first().click();
    await expect(gate).toHaveCount(0);
    await expect(page.locator("#app")).toHaveAttribute("data-step", "vehicles");
    await expect(page.locator("#vehicle-A").getByRole("radio", { name: "Hit on the right side", exact: true })).toHaveAttribute("aria-checked", "true");
    await expect(page.locator("#to-review")).toBeFocused();
    // Nothing left to warn about: straight to the picture.
    await page.getByRole("button", { name: /See the recreation/ }).click();
    await expect(page.locator("#app")).toHaveAttribute("data-step", "review");
    await expect(page.getByTestId("refusal")).toHaveCount(0);
    await expect(page.getByTestId("review-warnings")).toHaveCount(0);

    // The kind picked is remembered on this device, offered first next time, and can be cleared from the Vehicles step too.
    await page.goto("/#vehicles");
    await page.locator("#vehicle-A").getByRole("radio", { name: "Hit on the left side", exact: true }).click();
    await page.getByRole("button", { name: /See the recreation/ }).click();
    await expect(area.locator("button.refusal-fix").first()).toBeVisible({ timeout: 30_000 });
    await expect(area).toContainText("Kinds of fix you picked before on this device are listed first.");
    await area.getByRole("button", { name: "Clear remembered fixes" }).click();
    await expect(area).toContainText("Remembered fixes cleared. Nothing about them is kept on this device.");
    expect(await page.evaluate(() => localStorage.getItem("csd.fixes.v1"))).toBeNull();
    // "See it anyway" still goes on to the picture as entered.
    await gate.getByRole("button", { name: "See it anyway" }).click();
    await expect(page.locator("#app")).toHaveAttribute("data-step", "review");
    expect(pageErrors()).toEqual([]);
  });
});

// Vehicles step fixes (2026-10-11), item 2: catalog 3D models (/api/vehicles/model) are for Review only. Nothing on
// the Vehicles step asks for one, and leaving Review cancels the ones still on their way, so the makes list is never
// queued behind them. ?models=proxy (fixture builds) sends the model requests over the network, where the test holds them.
/** The catalog model route (not /api/vehicles/models, the vPIC model list). */
const MODEL_URL = /\/api\/vehicles\/model\?/;

test.describe("catalog models stay on Review", () => {
  test("@xb the Vehicles step asks for no catalog model, and leaving Review cancels the ones in flight", async ({ page, pageErrors }) => {
    test.setTimeout(120_000);
    const asked: Array<{ url: string; step: string }> = [];
    const aborted: string[] = [];
    let held = 0;
    // The makes and models lists from the real proxy code; registered first, so the model route below wins for its URLs.
    await routeVehiclesToFakeProxy(page);
    // Hold every model request (a slow catalog): it either is cancelled by the page or never answers.
    await page.route(MODEL_URL, async (route) => {
      const step = await page.locator("#app").getAttribute("data-step").catch(() => "?");
      asked.push({ url: route.request().url(), step: step ?? "?" });
      held += 1;
      await new Promise(() => undefined);
    });
    page.on("requestfailed", (r) => { if (MODEL_URL.test(r.url())) aborted.push(r.url()); });

    // An example opens on Review: its two vehicles' models are asked for there.
    await openExample(page, "t-bone-intersection", "&models=proxy&vehicles=proxy");
    await expect.poll(() => held).toBe(2);
    expect(asked.every((a) => a.step === "review")).toBe(true);

    // Edit details: the Vehicles step. The held model requests are cancelled, the makes list is asked for and answers.
    const makesAnswer = page.waitForResponse((r) => r.url().includes("/api/vehicles/makes"));
    await page.getByRole("button", { name: "Edit details" }).click();
    await expect(page.locator("#app")).toHaveAttribute("data-step", "vehicles");
    expect((await makesAnswer).status()).toBe(200);
    await expect.poll(() => aborted.length, { message: "model requests still open on the Vehicles step" }).toBe(2);
    // The 3D code loads in the background after 2 s on this step; still no model is asked for.
    await page.waitForTimeout(3000);
    expect(asked.filter((a) => a.step !== "review")).toEqual([]);
    expect(pageErrors()).toEqual([]);
  });

  test("@xb a fresh claim reaches the Vehicles step and types a vehicle without one catalog model request", async ({ page, pageErrors }) => {
    const asked: string[] = [];
    page.on("request", (r) => { if (MODEL_URL.test(r.url())) asked.push(r.url()); });
    await routeVehiclesToFakeProxy(page);
    await freshStart(page, "/?models=proxy&vehicles=proxy#location");
    await searchAndPick(page);
    await page.getByRole("button", { name: /Next: vehicles/ }).click();
    await expect(page.locator("#vehicle-A")).toBeVisible();
    const b = page.locator("#vehicle-B");
    await b.getByLabel("Year").fill("2019");
    await b.getByLabel("Make").fill("Ford");
    await b.getByLabel("Make").press("Tab");
    await b.getByLabel("Model").fill("F-150");
    await b.getByLabel("Model").press("Tab");
    await expect(b.locator(".lookup")).toContainText("Pickup from NHTSA vPIC", { timeout: 10_000 });
    await expect(b.locator(".type-auto")).toContainText("Pickup");
    await expect(b.getByRole("radiogroup", { name: "Type of vehicle B" })).toHaveCount(0);
    await page.waitForTimeout(3000);
    expect(asked).toEqual([]);
    expect(pageErrors()).toEqual([]);
  });
});

// Item 1: "chevy" typed while the card still says "Loading the makes…" is matched once the makes list lands.
test.describe("a nickname typed before the makes list lands", () => {
  /** Step 1 to the Vehicles step with the makes list held until the returned release is called (a slow first answer). */
  async function toVehiclesWithMakesHeld(page: Page): Promise<() => void> {
    await routeVehiclesToFakeProxy(page);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    // Registered last, so it runs before the fake proxy's route; it hands the request on once released.
    await page.route(/\/api\/vehicles\/makes$/, async (route) => { await gate; await route.fallback(); });
    await freshStart(page, "/?vehicles=proxy#location");
    await searchAndPick(page);
    await page.getByRole("button", { name: /Next: vehicles/ }).click();
    await expect(page.locator("#vehicle-B")).toBeVisible();
    return release;
  }

  test("@xb is ranked again when the list lands: Chevrolet first and highlighted, so Enter takes it", async ({ page, pageErrors }) => {
    const release = await toVehiclesWithMakesHeld(page);
    const b = page.locator("#vehicle-B");
    const make = b.getByLabel("Make");
    await make.click();
    await make.pressSequentially("chevy", { delay: 60 });
    const list = b.getByRole("listbox", { name: "Suggestions" }).first();
    await expect(b.locator(".combo-note")).toContainText("Loading the makes…");
    await expect(list.getByRole("option")).toHaveText(["Use ‘chevy’ as typed"]);
    release();
    await expect(list.getByRole("option").first()).toHaveText("Chevrolet");
    await expect(list.getByRole("option").first()).toHaveAttribute("aria-selected", "true");
    await make.press("Enter");
    await expect(make).toHaveValue("Chevrolet");
    expect(pageErrors()).toEqual([]);
  });

  test("@xb left while the list loads, it becomes Chevrolet when the list lands", async ({ page, pageErrors }) => {
    const release = await toVehiclesWithMakesHeld(page);
    const make = page.locator("#vehicle-B").getByLabel("Make");
    await make.fill("chevy");
    await make.press("Tab");
    await expect(make).toHaveValue("chevy");
    release();
    await expect(make).toHaveValue("Chevrolet");
    expect(pageErrors()).toEqual([]);
  });
});

// Item 3: unnamed roads get words that tell them apart, the same in the list, the compass line and the summary.
test("@xb the parking example's direction list tells its three unnamed aisles apart, and the caption says the same", async ({ page, pageErrors }) => {
  await openExample(page, "parking-lot-backing");
  await page.getByRole("button", { name: "Edit details" }).click();
  await expect(page.locator("#app")).toHaveAttribute("data-step", "vehicles");
  const a = page.locator("#vehicle-A");
  const group = a.locator("[data-fix-direction]");
  const radios = group.getByRole("radio");
  // Six aisle directions (the aisles run about 37 degrees east of north: "heading northeast"), then across the lot four ways.
  await expect(radios).toHaveCount(10);
  const names = await radios.allInnerTexts();
  expect(new Set(names).size, names.join(" | ")).toBe(10);
  for (const n of names.slice(0, 6)) expect(n).toMatch(/^Heading (northeast|southwest) on the parking aisle \((west one|middle|east one)\)$/);
  expect(names.slice(6)).toEqual(["Across the parking lot, heading north", "Across the parking lot, heading east", "Across the parking lot, heading south", "Across the parking lot, heading west"]);
  const pick = group.getByRole("radio", { name: "Heading northeast on the parking aisle (west one)" });
  await pick.click();
  await expect(group.locator(".dir-caption")).toHaveText("Heading northeast on the parking aisle (west one)");
  expect(pageErrors()).toEqual([]);
});
