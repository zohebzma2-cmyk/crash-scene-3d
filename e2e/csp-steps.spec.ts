// CSP on every step, in every engine. WebKit (Safari) reports style-src differently from Chromium and the Chromium-only
// csp.spec.ts passed while Safari's console showed "Refused to apply a stylesheet", so this spec runs on WebKit too (@xb).
//
// It fails on ANY violation: a securitypolicyviolation event, or the browser's own "Refused to ..." console error.
// It needs no fixtures, so it also runs against a deployed copy. On a production deploy the examples use the live
// /api (map, roads, terrain), so a run there spends a few proxy requests:
//
//   BASE_URL=https://crash-scene-3d.netlify.app E2E_FULL=1 npx playwright test e2e/csp-steps.spec.ts --project=webkit-desktop
//
// It starts as a first visit (tips shown, real motion) because that is what a person sees.
import type { Page } from "@playwright/test";
import { expect, exampleSceneFile, isPhone, openExample, saveFiles, test, waitForViewer, watchCsp } from "./helpers";

test.use({ storageState: { cookies: [], origins: [] }, reducedMotion: "no-preference" });

async function goStep(page: Page, hash: "location" | "vehicles"): Promise<void> {
  await page.goto(`/#${hash}`);
  await expect(page.locator("main h1")).toBeVisible();
  await page.waitForTimeout(1500);   // the map and tips settle
}

test("@xb no CSP violation on any step: location, vehicles, review (measure, aftermath), save, an example", async ({ page, browserName }, info) => {
  const violations = await watchCsp(page);
  const where = async (step: string) => {
    const v = await violations();
    expect(v, `${browserName} ${info.project.name}: CSP violations by the end of "${step}"`).toEqual([]);
  };

  // The first-visit welcome (fixtures mode shows it only with ?welcome=1), with its fade-in, then Dismiss.
  await page.goto("/?welcome=1");
  await expect(page.getByRole("dialog", { name: "See what happened, in 3D" })).toBeVisible();
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: "Dismiss" }).click();
  await where("welcome");

  // Step 1 and step 2, as a first visit sees them (tips on): hide one tip, hide all, show again.
  await goStep(page, "location");
  await where("location");
  await page.getByRole("button", { name: "Hide all tips" }).click();
  await page.getByRole("button", { name: "Show tips" }).click();
  await goStep(page, "vehicles");
  await where("vehicles");

  // Step 3: an example, the 3D view, Measure, Aftermath, playback, the camera.
  await openExample(page, "t-bone-intersection");
  await where("review");
  await page.getByRole("tab", { name: "Measure" }).click();
  await page.getByRole("checkbox", { name: "Distances at impact" }).check();
  await page.getByRole("checkbox", { name: "Travel paths" }).check();
  await page.getByRole("button", { name: "Aftermath" }).click();
  await page.getByRole("button", { name: "Play" }).click();
  const canvas = await page.locator(".viewer3d canvas").boundingBox();
  if (canvas) {
    await page.mouse.move(canvas.x + 200, canvas.y + 200);
    await page.mouse.down();
    await page.mouse.move(canvas.x + 320, canvas.y + 160, { steps: 6 });
    await page.mouse.up();
    if (!isPhone(page)) await page.mouse.wheel(0, 200);   // mobile WebKit has no wheel
  }
  await page.getByRole("button", { name: "Reset view" }).click();
  await page.locator(".viewer-canvas").focus();
  for (const k of ["2", "3", "4", "1"]) await page.keyboard.press(k);
  await where("review, measure and aftermath");

  // Step 4: every preview tab, then the save itself (PNG + PDF + scene file built in the browser).
  await page.getByRole("button", { name: "Looks right: save it" }).click();
  await expect(page.locator("#app")).toHaveAttribute("data-step", "export");
  for (const tab of ["Diagram", "Scene file", "PDF"]) await page.getByRole("tab", { name: tab, exact: true }).click();
  await page.waitForTimeout(1500);   // the PDF preview (pdfjs) draws
  await where("save preview");
  await saveFiles(page);
  await where("save");

  // Reopen a scene file, then the other examples.
  const file = await exampleSceneFile("parking-lot-backing");
  await page.locator("#open-scene").setInputFiles({ name: "scene.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(file)) });
  await expect(page.locator("#app")).toHaveAttribute("data-step", "review");
  await waitForViewer(page);
  await openExample(page, "highway-rear-end");
  await where("an example");
  await page.getByRole("button", { name: "Switch to the dark theme" }).click();
  await page.waitForTimeout(500);
  await where("dark theme");

  // Step 2's one-tap fixes: the fixer's module Web Worker starts and answers under the CSP (worker-src 'self').
  // The T-bone example with A marked hit on the left doesn't fit together (it only draws with A's right side).
  await openExample(page, "t-bone-intersection");
  await page.goto("/#vehicles");
  await page.locator("#vehicle-A").getByRole("radio", { name: "Hit on the left side", exact: true }).click();
  await page.getByRole("button", { name: /See the recreation/ }).click();
  const fixes = page.getByTestId("gate-fixes");
  await expect(fixes.locator("button.refusal-fix").first()).toBeVisible({ timeout: 30_000 });
  await expect(fixes).toHaveAttribute("data-fixer", "worker");
  await where("vehicles (one-tap fixes from the worker)");
});

test("@xb self-check: this engine reports a blocked <style>, a style attribute and a stylesheet", async ({ page }) => {
  const violations = await watchCsp(page);
  await page.goto("/");
  const count = async () => (await violations()).length;
  // Each kind is checked on its own, so one report can't stand in for another.
  await page.evaluate(() => { const s = document.createElement("style"); s.textContent = "a{color:red}"; document.head.append(s); });
  await expect.poll(count, { message: "a blocked <style> element is reported" }).toBeGreaterThanOrEqual(1);
  const afterStyle = await count();
  await page.evaluate(() => { const d = document.createElement("div"); d.setAttribute("style", "color:red"); document.body.append(d); });
  await expect.poll(count, { message: "a blocked style attribute is reported" }).toBeGreaterThan(afterStyle);
  const afterAttr = await count();
  // CSSOM (element.style.x = ...) is allowed by CSP and must NOT be reported.
  await page.evaluate(() => { const f = document.createElement("div"); f.style.color = "red"; document.body.append(f); });
  await page.waitForTimeout(300);
  expect(await count()).toBe(afterAttr);
});
