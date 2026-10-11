// Live search against a real deployment (BASE_URL; run with npm run e2e:live, see playwright.live.config.ts).
// These make real, rate-limited requests through the deployment's proxy: a handful per test, one test at a time.
// The default claim address is "Main Street and Park Street, Nashua, NH" (synthetic; public road names only).
import { expect, test, type Locator, type Page, type Response } from "@playwright/test";
import { stubNonEssentialApi } from "../live-guard";

/** Every /api answer the page got, so a test can say none of them was a 429. */
function watchApi(page: Page): Array<{ url: string; status: number }> {
  const seen: Array<{ url: string; status: number }> = [];
  page.on("response", (r: Response) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith("/api/")) seen.push({ url: `${u.pathname}${u.search}`, status: r.status() });
  });
  return seen;
}

const box = (page: Page) => page.locator("form[role=search] textarea");
const options = (page: Page) => page.getByRole("option");
const option = (page: Page, main: RegExp, sub?: RegExp): Locator =>
  options(page).filter({ has: page.locator(".r-main", { hasText: main }) }).filter(sub ? { has: page.locator(".r-sub", { hasText: sub }) } : {}).first();

async function fresh(page: Page): Promise<Array<{ url: string; status: number }>> {
  const api = watchApi(page);
  await page.goto("/");
  await expect(box(page)).toBeVisible();
  return api;
}

/** Type like a person: clear the box, then key by key with a short gap (the app waits 300 ms after the last key). */
async function typeSlowly(page: Page, text: string, clear = true): Promise<void> {
  if (clear) await box(page).fill("");
  await box(page).pressSequentially(text, { delay: 90 });
}

let api: Array<{ url: string; status: number }> = [];
// Map tiles and vehicle lookups are answered inside the test: these specs check the search (e2e/live-guard.ts).
test.beforeEach(async ({ page }) => { await stubNonEssentialApi(page); });
test.afterEach(() => {
  // A normal search must never be told "busy".
  expect(api.filter((a) => a.status === 429), "429 answers").toEqual([]);
});

test("'Main St' on a fresh home page suggests Nashua, NH first, not Colorado", async ({ page }) => {
  api = await fresh(page);
  await typeSlowly(page, "Main St");
  await expect(options(page).first()).toBeVisible();
  const first = options(page).first();
  await expect(first.locator(".r-sub")).toContainText(/, NH\b/);
  await expect(first.locator(".r-sub")).toContainText("Nashua");
  // Anything in Colorado (or elsewhere far away) is listed after, and says it is far from the claim.
  for (const sub of await options(page).locator(".r-sub").allTextContents()) {
    if (/, CO\b/.test(sub)) expect(sub).toContain("far from the claim");
  }
  // The suggestion request carried a bias near Nashua.
  const suggest = api.filter((a) => a.url.startsWith("/api/geo/suggest") && new URL(a.url, "http://x").searchParams.get("q") === "Main St");
  expect(suggest.length).toBeGreaterThan(0);
  const params = new URL(suggest[0]!.url, "http://x").searchParams;
  expect(Math.abs(Number(params.get("lat")) - 42.76)).toBeLessThan(0.05);
  expect(Math.abs(Number(params.get("lon")) + 71.46)).toBeLessThan(0.05);
});

test("'Main Street' then 'and Park Street': the pin lands on the Nashua crossing and both streets are found there", async ({ page }) => {
  api = await fresh(page);
  await typeSlowly(page, "Main St");
  await option(page, /^Main Street$/, /Nashua, NH/).click({ timeout: 30_000 });
  // The crossing list for the picked street (Overpass, through the proxy).
  await expect(page.locator(".combo-title")).toHaveText("Crossing streets");
  await box(page).press("End");
  await typeSlowly(page, " and Park", false);
  await option(page, /^Park Street$/).click({ timeout: 45_000 });
  const coords = page.locator(".coords .num");
  await expect(coords).toBeVisible();
  const [lat, lon] = (await coords.innerText()).split(",").map((s) => Number(s.trim())) as [number, number];
  expect(Math.abs(lat - 42.76)).toBeLessThan(0.01);
  expect(Math.abs(lon + 71.46)).toBeLessThan(0.015);
  const streets = page.locator(".streets-here");
  await expect(streets).toContainText("Streets at the pin", { timeout: 60_000 });
  await expect(streets).toContainText("Main Street");
  await expect(streets).toContainText("Park Street");
});

test("'Elm St and Hanover St, Manchester NH' typed in one go offers the Manchester crossing", async ({ page }) => {
  api = await fresh(page);
  await box(page).fill("Elm St and Hanover St, Manchester NH");
  const hanover = option(page, /^Hanover Street$/);
  await expect(hanover).toBeVisible({ timeout: 45_000 });
  await expect(hanover.locator(".r-sub")).toContainText("Manchester");
  await hanover.click();
  const [lat, lon] = (await page.locator(".coords .num").innerText()).split(",").map((s) => Number(s.trim())) as [number, number];
  // Elm Street meets Hanover Street in downtown Manchester, NH.
  expect(Math.abs(lat - 42.991)).toBeLessThan(0.01);
  expect(Math.abs(lon + 71.463)).toBeLessThan(0.01);
});
