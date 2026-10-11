// Round B: the maker logo and the stock photo on the vehicle card (docs/decisions/0011-vehicle-images.md), in
// Chromium and WebKit at 1440 and 390, in fixtures mode: ?media=on answers the media routes with synthetic files,
// ?media=busy answers 429 as a provider over its quota would. The browser only ever talks to its own origin.
// E2E_SHOTS_DIR=<dir> also saves a screenshot of the card for each case.
import type { Page, TestInfo } from "@playwright/test";
import { expect, freshStart, searchAndPick, test, watchCsp } from "./helpers";

async function toVehicles(page: Page, media: "on" | "busy"): Promise<void> {
  await freshStart(page, `/?media=${media}#location`);
  await searchAndPick(page);
  await expect(page.locator(".streets-here")).toContainText("Streets at the pin");
  await page.getByRole("button", { name: /Next: vehicles/ }).click();
  await expect(page.locator("#vehicle-A")).toBeVisible();
}

async function shot(page: Page, info: TestInfo, name: string): Promise<void> {
  const dir = process.env.E2E_SHOTS_DIR;
  if (!dir) return;
  // Card A's top just under the sticky app header and disclaimer bar.
  await page.evaluate(() => {
    const card = document.getElementById("vehicle-A");
    const bars = [".app-header", ".disclaimer-bar"].reduce((h, s) => h + (document.querySelector(s)?.getBoundingClientRect().height ?? 0), 0);
    if (card) window.scrollTo(0, card.getBoundingClientRect().top + window.scrollY - bars - 16);
  });
  await page.screenshot({ path: `${dir}/media-${name}-${info.project.name}.png` });
}

test.describe("the vehicle card's logo and photo", () => {
  test("@xb shows the maker logo and the stock photo, all from our own origin", async ({ page, pageErrors }, info) => {
    const csp = await watchCsp(page);
    const foreign: string[] = [];
    const origin = new URL(info.project.use.baseURL ?? "http://localhost").origin;
    page.on("request", (r) => { if (/^https?:/.test(r.url()) && new URL(r.url()).origin !== origin) foreign.push(r.url()); });
    await toVehicles(page, "on");
    const card = page.locator("#vehicle-A");
    const logo = card.locator(".make-logo");
    await expect(logo).toHaveAttribute("data-make-logo", "logo");
    await expect(logo.getByRole("img", { name: "Honda" })).toBeVisible();
    const photo = card.locator(".vehicle-photo");
    await expect(photo).toHaveAttribute("data-photo", "photo");
    const img = photo.getByRole("img", { name: /^Stock photo of a 20\d\d Honda Accord$/ });
    await expect(img).toBeVisible();
    expect(await img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0 && el.src.startsWith("blob:"))).toBe(true);
    // The photo sits in the card's header, inside the card, and the page doesn't scroll sideways.
    const [cardBox, photoBox] = [await card.boundingBox(), await photo.boundingBox()];
    expect(photoBox!.x).toBeGreaterThanOrEqual(cardBox!.x);
    expect(photoBox!.x + photoBox!.width).toBeLessThanOrEqual(cardBox!.x + cardBox!.width + 0.5);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    // The fixture logo is CarImages': no logo.dev credit.
    await expect(page.locator(".logo-credit")).toHaveCount(0);
    expect(foreign).toEqual([]);
    // Checked before the screenshot: Playwright's screenshot adds a style of its own that WebKit reports under our CSP.
    expect(await csp()).toEqual([]);
    expect(pageErrors()).toEqual([]);
    await shot(page, info, "on");
  });

  test("@xb with the provider answering 429, the card shows our own icons and no error text", async ({ page, pageErrors }, info) => {
    const csp = await watchCsp(page);
    await toVehicles(page, "busy");
    const card = page.locator("#vehicle-A");
    // The model is picked from the list, so the photo was asked for and the answer was 429.
    await expect(card.locator(".vehicle-photo")).toHaveAttribute("data-photo", "icon");
    await expect(card.locator(".vehicle-photo svg")).toBeVisible();
    await expect(card.locator(".vehicle-photo img")).toHaveCount(0);
    await expect(card.locator(".make-logo")).toHaveAttribute("data-make-logo", "icon");
    await expect(card.locator(".make-logo img")).toHaveCount(0);
    const text = (await card.innerText()).replace(/\s+/g, " ");
    expect(text).not.toMatch(/busy|error|wrong|couldn't|try again|requests|quota/i);
    await expect(page.getByRole("alert")).toHaveCount(0);
    expect(await csp()).toEqual([]);
    expect(pageErrors()).toEqual([]);
    await shot(page, info, "busy");
  });

  test("@xb the make list shows a logo at the start of each row, decorative, and the page stays inside the screen", async ({ page, pageErrors }, info) => {
    const csp = await watchCsp(page);
    await toVehicles(page, "on");
    const make = page.locator("#vehicle-B").getByRole("combobox", { name: "Make", exact: true });
    await make.click();
    await make.pressSequentially("h", { delay: 60 });
    await expect(make).toHaveAttribute("aria-expanded", "true");
    const list = page.locator(`[id="${await make.getAttribute("aria-controls")}"]`);
    const first = list.getByRole("option").first();
    await expect(first.locator(".make-logo")).toHaveAttribute("data-make-logo", "logo");
    // The row already names the make: the logo has an empty alt, so the option's name is the make once.
    await expect(first.locator(".make-logo img")).toHaveAttribute("alt", "");
    const name = (await first.textContent())?.trim() ?? "";
    expect(name.length).toBeGreaterThan(0);
    await expect(list.getByRole("option", { name, exact: true })).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(await csp()).toEqual([]);
    expect(pageErrors()).toEqual([]);
    const dir = process.env.E2E_SHOTS_DIR;
    if (dir) {
      await make.scrollIntoViewIfNeeded();
      await page.evaluate(() => window.scrollBy(0, -120));
      await page.screenshot({ path: `${dir}/media-make-list-${info.project.name}.png` });
      await page.emulateMedia({ colorScheme: "dark" });
      await page.screenshot({ path: `${dir}/media-make-list-dark-${info.project.name}.png` });
    }
  });
});
