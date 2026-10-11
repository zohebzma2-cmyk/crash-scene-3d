// The owner's polish list, item 5 (DESIGN.md sections 5 and 18), in Chromium and WebKit at 1440 and 390:
//  5b. a direction not picked yet is a missing detail ("Pick which way your car was going."), never "don't fit together";
//  5a. details that don't fit together on the Vehicles step get the same one-tap fixes as the Review refusal, from the
//      fixer's Web Worker; a tap changes the details, the warning goes away, and "See it anyway" / "Fix the details" stay.
import { expect, fillDefaultClaim, freshStart, searchAndPick, test } from "./helpers";

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
