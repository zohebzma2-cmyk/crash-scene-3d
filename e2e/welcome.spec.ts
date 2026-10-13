// The first-visit welcome (DESIGN.md section 19): over step 1 on a first visit, Try an example opens the T-bone
// example on Review (as /?example=t-bone-intersection#review does), Dismiss stays on Location, it is remembered, it
// never shows over an example or a deep link, and it is a real modal dialog from the keyboard. Every test is @xb
// (WebKit too), at 1440 and 390. Fixtures mode keeps the welcome away unless the page asks with ?welcome=1.
import type { Locator, Page } from "@playwright/test";
import { DISCLAIMER_SHORT, expect, isPhone, test, waitForViewer } from "./helpers";

// Tips hidden (as in every other spec), but the welcome not seen yet: a first visit as far as the welcome goes.
test.use({ storageState: { cookies: [], origins: [] } });
test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => {
    try { localStorage.setItem("csd.tips.v1", JSON.stringify({ hidden: [], all: true })); } catch { /* blocked storage is fine */ }
  });
});

const TITLE = "See what happened, in 3D";
const welcome = (page: Page): Locator => page.getByRole("dialog", { name: TITLE });
const focusedName = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.textContent?.trim() ?? "");
const stored = (page: Page) => page.evaluate(() => localStorage.getItem("csd.welcome.v1"));

/**
 * The way back to the welcome: "About this tool" in the disclaimer bar from 768 px up; on phones, Learn more and then
 * the About dialog's "About this tool". Returns the control focus should go back to when the welcome closes.
 */
async function reopen(page: Page, how: "click" | "keys"): Promise<Locator> {
  const press = async (l: Locator) => { if (how === "click") await l.click(); else { await l.focus(); await page.keyboard.press("Enter"); } };
  if (!isPhone(page)) {
    const about = page.getByRole("complementary", { name: "Disclaimer" }).getByRole("button", { name: "About this tool" });
    await press(about);
    return about;
  }
  await expect(page.getByRole("complementary", { name: "Disclaimer" }).getByRole("button", { name: "About this tool" })).toBeHidden();
  const learn = page.getByRole("button", { name: "Learn more" });
  await press(learn);
  const aboutDialog = page.getByRole("dialog", { name: "About this illustration" });
  await expect(aboutDialog).toBeVisible();
  await press(aboutDialog.getByRole("button", { name: "About this tool" }));
  await expect(aboutDialog).toHaveCount(0);
  return learn;
}

async function firstVisit(page: Page): Promise<void> {
  await page.goto("/?welcome=1");
  await expect(welcome(page)).toBeVisible();
}

test("@xb first visit: a labelled modal over step 1 with the copy, the disclaimer and the four steps", async ({ page }) => {
  await firstVisit(page);
  const d = welcome(page);
  await expect(page.locator("#app")).toHaveAttribute("data-step", "location");
  await expect(d).toHaveAttribute("aria-modal", "true");
  await expect(d).toHaveAttribute("aria-labelledby", "welcome-title");
  await expect(page.locator("#welcome-title")).toHaveText(TITLE);
  await expect(d).toContainText("We rebuild the crash in 3D on the real road layout");
  await expect(d).toContainText(DISCLAIMER_SHORT);
  await expect(d.getByRole("list", { name: "How it works" }).getByRole("listitem")).toHaveText(["1Location", "2Vehicles", "3Review", "4Save"]);
  await expect(d.getByRole("button", { name: "Try an example" })).toBeFocused();
  // The dialog fits the screen, and the page doesn't scroll sideways.
  const box = (await d.boundingBox())!;
  const vw = page.viewportSize()!.width;
  expect(box.x).toBeGreaterThanOrEqual(-0.5);
  expect(box.x + box.width).toBeLessThanOrEqual(vw + 0.5);
  expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize()!.height + 0.5);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  for (const name of ["Try an example", "Dismiss"]) {
    const b = (await d.getByRole("button", { name }).boundingBox())!;
    expect(b.height, `${name} tap target`).toBeGreaterThanOrEqual(43.5);
  }
});

test("@xb first visit: Try an example lands on Review with the T-bone scene drawn, like the example link", async ({ page, context }) => {
  await firstVisit(page);
  await page.getByRole("button", { name: "Try an example" }).click();
  await expect(welcome(page)).toHaveCount(0);
  await expect(page.locator("#app")).toHaveAttribute("data-step", "review");
  await expect(page.locator("main h1")).toHaveText("Does this match what happened?");
  await waitForViewer(page);
  expect(new URL(page.url()).searchParams.get("example")).toBe("t-bone-intersection");
  expect(new URL(page.url()).hash).toBe("#review");
  expect(await stored(page)).toBe(JSON.stringify({ seen: true }));
  // The same scene as /?example=t-bone-intersection#review opened directly.
  const chip = await page.getByTestId("claim-chip").textContent();
  const labels = await page.locator(".viewer3d-label").count();
  // One 3D view at a time: SwiftShader is slow enough that two at once made the second one's load flaky.
  await page.close();
  const direct = await context.newPage();
  await direct.goto("/?example=t-bone-intersection#review");
  await waitForViewer(direct);
  await expect(direct.getByTestId("claim-chip")).toHaveText(chip ?? "");
  expect(await direct.locator(".viewer3d-label").count()).toBe(labels);
  await expect(welcome(direct)).toHaveCount(0);
});

test("@xb after Try an example, the claimant's own edit survives a reload (the example isn't loaded over it)", async ({ page }) => {
  await firstVisit(page);
  await page.getByRole("button", { name: "Try an example" }).click();
  await expect(page.locator("#app")).toHaveAttribute("data-step", "review");
  await expect(page.getByTestId("claim-chip")).toContainText("CLM-EX-1001");
  await page.evaluate(() => { location.hash = "#location"; });
  await expect(page.locator("main h1")).toHaveText("Where did it happen?");
  await page.getByLabel("Claim number (optional)").fill("MY-OWN-1");
  await expect(page.getByTestId("claim-chip")).toHaveText("Claim MY-OWN-1 · 2021 Honda Accord");
  await expect.poll(() => new URL(page.url()).searchParams.has("example")).toBe(false);
  await page.reload();
  await expect(page.locator("main h1")).toBeVisible();
  await expect(page.getByTestId("claim-chip")).toHaveText("Claim MY-OWN-1 · 2021 Honda Accord");
  // Going back to an older entry that still names the example and reloading it keeps the work too.
  await page.goto("/?example=t-bone-intersection#review");
  await expect(page.locator("main h1")).toBeVisible();
  await expect(page.getByTestId("claim-chip")).toHaveText("Claim MY-OWN-1 · 2021 Honda Accord");
});

test("@xb first visit: Dismiss stays on Location, and a reload shows no welcome", async ({ page }) => {
  await firstVisit(page);
  await page.getByRole("button", { name: "Dismiss" }).click();
  await expect(welcome(page)).toHaveCount(0);
  await expect(page.locator("#app")).toHaveAttribute("data-step", "location");
  await expect(page.locator("main h1")).toHaveText("Where did it happen?");
  expect(await stored(page)).toBe(JSON.stringify({ seen: true }));
  await page.reload();
  await expect(page.locator("main h1")).toHaveText("Where did it happen?");
  await page.waitForTimeout(500);
  await expect(welcome(page)).toHaveCount(0);
});

test("@xb a click on the backdrop dismisses it", async ({ page }) => {
  await firstVisit(page);
  await page.mouse.click(4, 4);
  await expect(welcome(page)).toHaveCount(0);
  await expect(page.locator("#app")).toHaveAttribute("data-step", "location");
  expect(await stored(page)).toBe(JSON.stringify({ seen: true }));
});

test("@xb second visit: no welcome", async ({ page }) => {
  await page.goto("/?welcome=1");
  await page.evaluate(() => localStorage.setItem("csd.welcome.v1", JSON.stringify({ seen: true })));
  await page.reload();
  await expect(page.locator("main h1")).toHaveText("Where did it happen?");
  await page.waitForTimeout(500);
  await expect(welcome(page)).toHaveCount(0);
});

test("@xb an example link or a deep link: no welcome", async ({ page }) => {
  await page.goto("/?welcome=1&example=t-bone-intersection#review");
  await expect(page.locator("#app")).toHaveAttribute("data-step", "review");
  await waitForViewer(page);
  await expect(welcome(page)).toHaveCount(0);
  // A deep link to a later step on a fresh page (the gate may move it back, but never under a welcome).
  await page.evaluate(() => { localStorage.removeItem("csd.welcome.v1"); sessionStorage.clear(); });
  await page.goto("/?welcome=1#vehicles");
  await page.reload();
  await expect(page.locator("main h1")).toBeVisible();
  await page.waitForTimeout(500);
  await expect(welcome(page)).toHaveCount(0);
});

test("@xb keyboard: Tab and Shift+Tab stay inside, Esc closes, focus goes back to About this tool", async ({ page }) => {
  await firstVisit(page);
  const tryBtn = page.getByRole("button", { name: "Try an example" });
  const dismiss = page.getByRole("button", { name: "Dismiss" });
  await expect(tryBtn).toBeFocused();
  for (const expected of ["Dismiss", "Try an example", "Dismiss"]) {
    await page.keyboard.press("Tab");
    expect(await focusedName(page)).toBe(expected);
  }
  await page.keyboard.press("Shift+Tab");
  await expect(tryBtn).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(dismiss).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(welcome(page)).toHaveCount(0);
  await expect(page.locator("#app")).toHaveAttribute("data-step", "location");

  // Reopened with the keyboard: focus goes in, and Esc brings it back to the control that opened it.
  const about = await reopen(page, "keys");
  await expect(welcome(page)).toBeVisible();
  await expect(tryBtn).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dismiss).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(welcome(page)).toHaveCount(0);
  await expect(about).toBeFocused();
  // Reopening never brings it back by itself on the next load.
  await page.reload();
  await expect(page.locator("main h1")).toBeVisible();
  await page.waitForTimeout(500);
  await expect(welcome(page)).toHaveCount(0);
});

test("@xb About this tool reopens it with a click (phones: from Learn more), and Dismiss returns focus there", async ({ page }) => {
  await firstVisit(page);
  await page.getByRole("button", { name: "Dismiss" }).click();
  const about = await reopen(page, "click");
  await expect(welcome(page)).toBeVisible();
  await page.getByRole("button", { name: "Dismiss" }).click();
  await expect(welcome(page)).toHaveCount(0);
  await expect(about).toBeFocused();
});
