// Type-ahead when the public suggestion server (Photon) is slow or busy (audit 2026-10-14: it took about 4.8 s for a
// street it hadn't cached, the proxy gave up at 4 s, and typing your own street never showed a suggestion).
// The page runs in fixture mode with ?geo=proxy (the real geo service; the roads stay on fixtures), and its /api/geo/*
// goes to the REAL proxy code in the test process over a fake Photon and Nominatim (e2e/fake-proxy.ts). Nothing
// leaves the machine. The proxy now waits 7 s for Photon; past that, or when it is busy, the list points to Search,
// and Nominatim (whose policy forbids type-ahead) is asked only when Search is pressed.
import type { Page } from "@playwright/test";
import { expect, freshStart, searchBox, test } from "./helpers";
import { photonFeature, routeGeoToFakeProxy } from "./fake-proxy";

/** SearchPanel's SUGGEST_SLOW_TEXT (DESIGN.md section 9, "Busy"). */
const SLOW_TEXT = "Suggestions are slow right now. Press Search to look it up.";
/** What the list said before the fix, the proxy's timeout and busy wording for search. */
const OLD_TEXT = /slow to answer right now|lot of searches right now/;
const SHOTS = process.env.SHOTS_DIR ?? "test-results/shots";

const ELM = photonFeature({ type: "street", osm_key: "highway", osm_value: "residential", osm_type: "W", osm_id: 101, name: "Elm Street", city: "Nashua" }, -71.4652, 42.7621);
const MAIN = photonFeature({ type: "street", osm_key: "highway", osm_value: "secondary", osm_type: "W", osm_id: 102, name: "Main Street", city: "Nashua" }, -71.4661, 42.7627);
const isElm = (q: string) => q.toLowerCase().startsWith("elm");

const note = (page: Page) => page.locator(".combo-pop .combo-note");
const suggestAnswers = (answers: Array<{ path: string; status: number }>, q: string) =>
  answers.filter((a) => a.path.startsWith("/api/geo/suggest") && new URL(a.path, "http://x").searchParams.get("q") === q).map((a) => a.status);

test("a street Photon takes 4.8 s to find is still suggested @xb", async ({ page, pageErrors }) => {
  const proxy = await routeGeoToFakeProxy(page, { photon: (q) => (isElm(q) ? { ms: 4800, features: [ELM] } : { ms: 50, features: [] }) });
  await freshStart(page, "/?geo=proxy#location");
  await searchBox(page).fill("Elm St");
  const option = page.getByRole("listbox").getByRole("option", { name: /^Elm Street/ });
  await expect(option).toBeVisible({ timeout: 12_000 });
  await expect(option).toContainText("Nashua, NH");
  await expect(note(page)).toHaveCount(0);
  expect(suggestAnswers(proxy.answers, "Elm St")).toEqual([200]);
  expect(proxy.upstream.filter((u) => !u.includes("photon")), "only Photon while typing").toEqual([]);
  expect(pageErrors()).toEqual([]);
});

test("Photon that never answers: after 7 s the list points to Search, and Search finds the street @xb", async ({ page, pageErrors }, info) => {
  const proxy = await routeGeoToFakeProxy(page, { photon: (q) => (isElm(q) ? { ms: Infinity, features: [] } : { ms: 50, features: [] }) });
  await freshStart(page, "/?geo=proxy#location");
  const started = Date.now();
  await searchBox(page).fill("Elm St");
  await expect(page.locator(".combo-pop")).toContainText("Searching…");
  await expect(note(page).filter({ hasText: SLOW_TEXT })).toBeVisible({ timeout: 15_000 });
  // The proxy waited its 7 s for Photon (it used to give up at 4 s), then answered "timeout".
  expect(Date.now() - started).toBeGreaterThanOrEqual(6500);
  expect(suggestAnswers(proxy.answers, "Elm St")).toEqual([504]);
  await expect(page.locator(".combo-pop")).not.toContainText(OLD_TEXT);
  await expect(page.getByRole("listbox").getByRole("option")).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/search-slow-${info.project.name}.png` });

  // Nothing but Photon was asked while typing: no Nominatim, no /api/geo/search.
  expect(proxy.upstream.filter((u) => !u.includes("photon"))).toEqual([]);
  expect(proxy.answers.some((a) => a.path.startsWith("/api/geo/search"))).toBe(false);

  // Search does what the line says: the on-submit search, which finds it.
  await page.getByRole("button", { name: "Search", exact: true }).click({ timeout: 5_000 });
  const result = page.locator(".results button").filter({ hasText: "Elm Street" });
  await expect(result).toBeVisible();
  expect(proxy.answers.filter((a) => a.path.startsWith("/api/geo/search")).map((a) => a.status)).toEqual([200]);
  expect(proxy.upstream.filter((u) => u.includes("nominatim"))).toHaveLength(1);
  await result.click();
  await expect(page.locator(".coords-label")).toContainText("From search");
  expect(pageErrors()).toEqual([]);
});

test("type-ahead still busy after its one retry says the same, never an empty list", async ({ page, pageErrors }) => {
  const busy = { on: false };
  const proxy = await routeGeoToFakeProxy(page, {
    photon: (q) => ({ ms: 50, features: q.toLowerCase().startsWith("main") ? [MAIN] : [] }),
    photonBusy: () => busy.on,
  });
  await freshStart(page, "/?geo=proxy#location");
  // First a normal suggestion (the claim's town is looked up on the way), then Photon's buckets run dry.
  await searchBox(page).fill("Main St");
  await expect(page.getByRole("listbox").getByRole("option", { name: /^Main Street/ })).toBeVisible();
  busy.on = true;
  await searchBox(page).fill("Elm St");
  await expect(page.locator(".combo-pop")).toContainText("Busy, trying again…");
  await expect(note(page).filter({ hasText: SLOW_TEXT })).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".combo-pop")).not.toContainText(OLD_TEXT);
  expect(suggestAnswers(proxy.answers, "Elm St")).toEqual([429, 429]); // the request and its one retry
  expect(proxy.upstream.filter((u) => !u.includes("photon"))).toEqual([]);
  expect(pageErrors()).toEqual([]);
});
