// The Save step (Chromium and WebKit, 1440 and 390):
//   - "Save to my device" is in the first view at 1440 x 900, with the step's tip showing or hidden (it used to sit
//     below the fold while the preview still said "Making the preview…")
//   - on a short desktop window the Back / Save row stays at the bottom of the screen, and at the end of the page it
//     sits in its place again
//   - the step shows only what can be saved: no "Coming next" roadmap (that lives in the README's Next version)
import type { Page } from "@playwright/test";
import { expect, isPhone, openExample, test } from "./helpers";

async function toSave(page: Page): Promise<void> {
  await openExample(page, "t-bone-intersection");
  await page.getByRole("button", { name: "Looks right: save it" }).click();
  await expect(page.locator("#app")).toHaveAttribute("data-step", "export");
}

async function inFirstView(page: Page, where: string): Promise<void> {
  const button = page.getByRole("button", { name: "Save to my device" });
  await expect(button).toBeVisible();
  expect(await page.evaluate(() => window.scrollY), `${where}: no scrolling needed`).toBe(0);
  const box = (await button.boundingBox())!;
  const vh = page.viewportSize()!.height;
  expect(box.y, where).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height, `${where}: the primary action ends on screen`).toBeLessThanOrEqual(vh);
}

test("@xb Save to my device is in the first view, and the step shows no roadmap", async ({ page, pageErrors }) => {
  await toSave(page);
  await inFirstView(page, "tips hidden");
  await expect(page.locator("main")).not.toContainText("Coming next");
  await expect(page.locator("main")).not.toContainText(/Video clip|Share link/);
  expect(pageErrors()).toEqual([]);
});

test.describe("first visit, the step's tip showing", () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  test("@xb Save to my device is still in the first view", async ({ page }) => {
    await toSave(page);
    await expect(page.getByRole("note", { name: /^Tip: Saving your files/ })).toBeVisible();
    await inFirstView(page, "tip showing");
  });
});

test("@xb on a short desktop window the Back / Save row stays at the bottom of the screen, then sits in its place at the end", async ({ page }) => {
  test.skip(isPhone(page), "phones have the fixed action bar (e2e/phone.spec.ts)");
  await page.setViewportSize({ width: 1024, height: 600 });
  await toSave(page);
  const row = page.locator(".save-actions");
  const button = row.getByRole("button", { name: "Save to my device" });
  const box = (await button.boundingBox())!;
  expect(box.y + box.height, "on screen").toBeLessThanOrEqual(600);
  expect(box.y, "at the bottom of the screen").toBeGreaterThan(600 * 0.75);
  expect(await row.evaluate((el) => getComputedStyle(el).position)).toBe("sticky");
  await expect(row).toHaveAttribute("data-stuck", "");
  // The choices it passes over don't show through it.
  expect(await row.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
  // At the end of the page it is back in its place, above the stamp, with no edge line.
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect(row).not.toHaveAttribute("data-stuck", /.*/);
  const [rowBox, stamp] = [(await row.boundingBox())!, (await page.getByTestId("stamp").boundingBox())!];
  expect(rowBox.y + rowBox.height).toBeLessThanOrEqual(stamp.y);
});
