// The owner's report (2026-10-11): "We're getting a lot of map requests right now ... Pick the type below." on the
// vehicles step, just from typing a make and model. This types two vehicles key by key, as a person does, against the
// REAL proxy code with its real limits and a cold cache (e2e/fake-proxy.ts, a made-up vPIC behind it), in fixture
// mode with ?vehicles=proxy (the real vehicle service; everything else stays on fixtures). No busy text may ever
// appear and no request may be refused. See docs/PROXY-BUSY.md.
import type { Locator, Page } from "@playwright/test";
import { SEARCH_TEXT, expect, freshStart, searchBox, test } from "./helpers";
import { routeVehiclesToFakeProxy } from "./fake-proxy";

/** Records, from the first paint on, any busy or failure text that ever shows in a vehicle card's lookup line. */
async function watchLookupText(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __lookupSeen: string[] }).__lookupSeen = seen;
    const check = () => {
      for (const el of document.querySelectorAll(".lookup")) {
        const t = el.textContent ?? "";
        if (/busy|map requests|try again|couldn't|isn't answering|slow to answer/i.test(t) && !seen.includes(t)) seen.push(t);
      }
    };
    new MutationObserver(check).observe(document, { subtree: true, childList: true, characterData: true });
  });
  return () => page.evaluate(() => [...(window as unknown as { __lookupSeen: string[] }).__lookupSeen]);
}

/** Type like a person: key by key, ~160 ms apart, with a pause after the characters listed. */
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

test("@xb typing year, make and model for two vehicles like a person never shows a busy message or gets a 429", async ({ page, pageErrors }) => {
  test.setTimeout(120_000);
  const seenText = await watchLookupText(page);
  const proxy = await routeVehiclesToFakeProxy(page);

  // Step 1: search and pick the crossing (fixtures).
  await freshStart(page, "/?vehicles=proxy#location");
  await searchBox(page).fill(SEARCH_TEXT);
  await searchBox(page).press("Enter");
  await page.locator(".results button").first().click();
  await expect(page.locator(".coords-label")).toContainText("From search");
  await page.getByRole("button", { name: /Next: vehicles/ }).click();
  await expect(page.locator("main h1")).toHaveText("Which vehicles were involved?");

  // Vehicle B: "2019", "chevy" with a pause after "chev" (longer than the debounce), "silverado".
  const b = page.locator("#vehicle-B");
  await typeLikeAPerson(page, b.getByLabel("Year"), "2019");
  await page.waitForTimeout(400);
  await typeLikeAPerson(page, b.getByLabel("Make"), "chevy", { 4: 700 });
  await page.waitForTimeout(500);
  await expect(b.locator(".lookup")).toContainText("models for 2019", { timeout: 10_000 });
  await typeLikeAPerson(page, b.getByLabel("Model"), "Silverado 1500");
  await expect(b.locator(".lookup")).toContainText("Pickup from NHTSA vPIC");

  // Vehicle A, changed from the claim the same way, then a different make.
  const a = page.locator("#vehicle-A");
  await typeLikeAPerson(page, a.getByLabel("Year"), "2019");
  await page.waitForTimeout(300);
  await typeLikeAPerson(page, a.getByLabel("Make"), "chevy", { 2: 600, 4: 700 });
  await typeLikeAPerson(page, a.getByLabel("Model"), "Silverado 1500");
  await expect(a.locator(".lookup")).toContainText("Pickup from NHTSA vPIC");
  await typeLikeAPerson(page, a.getByLabel("Make"), "Ford");
  await expect(a.locator(".lookup")).toContainText("Ford models for 2019", { timeout: 10_000 });
  await page.waitForTimeout(1500);

  expect(await seenText(), "busy or failure text in a vehicle card").toEqual([]);
  expect(proxy.answers.filter((x) => x.status !== 200), "refused vehicle lookups").toEqual([]);
  // One request per make and year, never per keystroke: the makes list, A's claim make (Honda 2021), Chevrolet 2019
  // (asked for once, under the list's spelling, and shared by B and A), Ford 2019, and Honda 2019 when the pause
  // between A's year and its make was longer than the debounce. Never "ch", "chev" or "chevy".
  const paths = proxy.answers.map((x) => x.path);
  const allowed = [
    "/api/vehicles/makes", "/api/vehicles/models?make=Honda&year=2021", "/api/vehicles/models?make=Chevrolet&year=2019",
    "/api/vehicles/models?make=Honda&year=2019", "/api/vehicles/models?make=Ford&year=2019",
  ];
  expect(paths.filter((p) => !allowed.includes(p)), paths.join("\n")).toEqual([]);
  expect(new Set(paths).size, paths.join("\n")).toBe(paths.length);
  expect(pageErrors()).toEqual([]);
});
