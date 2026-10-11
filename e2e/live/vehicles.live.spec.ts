// The owner's normal flow on a REAL deployment (BASE_URL; npm run e2e:live, see playwright.live.config.ts): search,
// pick the crossing, then type year, make and model for two vehicles key by key. No busy text may appear and no /api
// answer may be a 429 (docs/PROXY-BUSY.md).
//
// It spends real, shared proxy budget: the search and crossing, the roads and terrain at the pin, and about four vPIC
// lookups (the makes list, A's claim make, Chevrolet 2019, Ford 2019), most of them cache hits after the first run.
// Map tiles are answered inside the test (e2e/live-guard.ts). Run it ONCE after a deploy that touches the proxy or
// the vehicles step, never in a loop, never with --repeat-each, and never side by side with other live runs.
import { expect, test, type Locator, type Page, type Response } from "@playwright/test";
import { stubNonEssentialApi } from "../live-guard";

const SEARCH_TEXT = "Main Street and Park Street, Nashua NH";

function watchApi(page: Page): Array<{ url: string; status: number }> {
  const seen: Array<{ url: string; status: number }> = [];
  page.on("response", (r: Response) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith("/api/")) seen.push({ url: `${u.pathname}${u.search}`, status: r.status() });
  });
  return seen;
}

async function typeLikeAPerson(page: Page, field: Locator, text: string, pauses: Record<number, number> = {}): Promise<void> {
  await field.click();
  await field.fill("");
  let from = 0;
  for (const at of [...Object.keys(pauses).map(Number).sort((a, b) => a - b), text.length]) {
    await field.pressSequentially(text.slice(from, at), { delay: 160 });
    if (pauses[at]) await page.waitForTimeout(pauses[at]);
    from = at;
  }
}

test("search, pick the crossing, type two vehicles like a person: no busy message, no 429", async ({ page }) => {
  await stubNonEssentialApi(page, { keep: ["vehicles"] });
  const api = watchApi(page);
  const busyText: string[] = [];
  await page.goto("/#location");
  await page.evaluate(() => { try { sessionStorage.clear(); } catch { /* blocked storage is fine */ } });
  await page.reload();

  const box = page.getByRole("combobox", { name: "Address, intersection or landmark" });
  await box.fill(SEARCH_TEXT);
  await box.press("Enter");
  const first = page.locator(".results button").first();
  await expect(first).toBeVisible({ timeout: 45_000 });
  await first.click();
  await expect(page.locator(".coords .num")).toBeVisible();
  await page.getByRole("button", { name: /Next: vehicles/ }).click();
  await expect(page.locator("main h1")).toHaveText("Which vehicles were involved?");

  const lookups = page.locator(".lookup");
  const noteBusy = async () => {
    for (const t of await lookups.allTextContents()) if (/busy|map requests|isn't answering|slow to answer|couldn't/i.test(t)) busyText.push(t);
  };

  const b = page.locator("#vehicle-B");
  await typeLikeAPerson(page, b.getByLabel("Year"), "2019");
  await page.waitForTimeout(400);
  await typeLikeAPerson(page, b.getByLabel("Make"), "chevy", { 4: 700 });
  await noteBusy();
  await expect(b.locator(".lookup")).toContainText("models for 2019", { timeout: 30_000 });
  await typeLikeAPerson(page, b.getByLabel("Model"), "silverado");
  await noteBusy();

  const a = page.locator("#vehicle-A");
  await typeLikeAPerson(page, a.getByLabel("Year"), "2019");
  await page.waitForTimeout(300);
  await typeLikeAPerson(page, a.getByLabel("Make"), "chevy", { 4: 700 });
  await expect(a.locator(".lookup")).toContainText("models for 2019", { timeout: 30_000 });
  await typeLikeAPerson(page, a.getByLabel("Make"), "Ford");
  await expect(a.locator(".lookup")).toContainText("Ford models for 2019", { timeout: 30_000 });
  await noteBusy();

  expect(busyText, "busy or failure text on the vehicles step").toEqual([]);
  expect(api.filter((x) => x.status === 429), "429 answers").toEqual([]);
  // One request per make and year: never "ch", "chev" or "chevy".
  expect(api.filter((x) => /\/api\/vehicles\/models\?make=(ch|chev|chevy)&/i.test(x.url)), "lookups for half-typed makes").toEqual([]);
});
