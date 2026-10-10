// 5. CSP: the preview server sends the same strict policy as netlify.toml, and nothing in the whole
// flow (form, example, review, save, opening a scene file) trips it.
import type { Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import {
  expect, exampleSceneFile, saveFiles, searchBox, fillDefaultClaim, openExample, test, toReview, waitForViewer, watchCsp, type CspViolation,
} from "./helpers";

async function netlifyCsp(): Promise<string> {
  const toml = await readFile(new URL("../netlify.toml", import.meta.url), "utf8");
  const m = /Content-Security-Policy\s*=\s*"([^"]+)"/.exec(toml);
  if (!m?.[1]) throw new Error("no CSP in netlify.toml");
  return m[1];
}

/** zod's JIT probe (new Function) reports script-src 'eval'. Known; the fix is z.config({ jitless: true }). */
const isZodEvalProbe = (v: CspViolation) => v.blocked === "eval" && v.directive.startsWith("script-src");

async function wholeFlow(page: Page): Promise<void> {
  // The type-ahead combobox and the crossing list too.
  await page.goto("/#location");
  await searchBox(page).fill("Main Str");
  await page.getByRole("listbox").getByRole("option", { name: /^Main Street/ }).first().click();
  await expect(page.locator(".combo-title")).toHaveText("Crossing streets");
  await fillDefaultClaim(page);
  await page.locator("#vehicle-A").getByRole("radio", { name: "Hit on the right side", exact: true }).click();
  await toReview(page);
  await waitForViewer(page);
  await page.getByRole("tab", { name: "Measure" }).click();
  await page.getByRole("checkbox", { name: "Distances at impact" }).check();
  await page.getByRole("checkbox", { name: "Travel paths" }).check();
  await page.getByRole("button", { name: "Aftermath" }).click();
  await page.getByRole("button", { name: "Play" }).click();
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "Looks right: save it" }).click();
  await expect(page.locator("#app")).toHaveAttribute("data-step", "export");
  for (const tab of ["Diagram", "Scene file", "PDF"]) await page.getByRole("tab", { name: tab, exact: true }).click();
  await saveFiles(page);
  // Reopen a scene file, then an example.
  const file = await exampleSceneFile("parking-lot-backing");
  await page.locator("#open-scene").setInputFiles({ name: "scene.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(file)) });
  await expect(page.locator("#app")).toHaveAttribute("data-step", "review");
  await waitForViewer(page);
  await openExample(page, "highway-rear-end");
  await page.locator(".viewer-canvas").focus();
  for (const k of ["2", "3", "4", "1"]) await page.keyboard.press(k);
}

test("the server sends the netlify.toml CSP", async ({ page }) => {
  const res = await page.goto("/");
  const sent = res?.headers()["content-security-policy"];
  expect(sent, "a Content-Security-Policy header").toBeTruthy();
  const norm = (s: string) => s.split(";").map((d) => d.trim().replace(/\s+/g, " ")).filter(Boolean).sort();
  expect(norm(sent ?? "")).toEqual(norm(await netlifyCsp()));
  expect(res?.headers()["x-content-type-options"]).toBe("nosniff");
});

test("no CSP violations across the whole flow, apart from the known zod eval probe", async ({ page }) => {
  const violations = await watchCsp(page);
  await wholeFlow(page);
  const other = (await violations()).filter((v) => !isZodEvalProbe(v));
  expect(other).toEqual([]);
});

test("no CSP violations at all across the whole flow", async ({ page }) => {
  // zod's JIT probe used to report "script-src eval"; core now sets z.config({ jitless: true }), so nothing is allowed.
  const violations = await watchCsp(page);
  await wholeFlow(page);
  expect(await violations()).toEqual([]);
});

test("self-check: the collector does see a violation", async ({ page }) => {
  const violations = await watchCsp(page);
  await page.goto("/");
  // Blocked by img-src before any request leaves the browser (the .invalid TLD never resolves anyway).
  await page.evaluate(() => { const i = document.createElement("img"); i.src = "https://csp-canary.invalid/x.png"; document.body.append(i); });
  await expect.poll(async () => (await violations()).map((v) => v.directive)).toContain("img-src");
});
