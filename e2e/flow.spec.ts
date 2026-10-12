import type { Page } from "@playwright/test";
// 1. The full flow on the default (made-up) claim, from step 1 to Save, in fixtures mode.
import { SEARCH_TEXT, canvasPainted, expect, fillDefaultClaim, freshStart, saveFiles, searchBox, test, toReview, waitForViewer } from "./helpers";

/** Where the screenshots of the refusal go (SHOTS_DIR overrides). */
const SHOTS = process.env.SHOTS_DIR ?? "test-results/shots";

test.describe("full flow on the default claim", () => {
  test("search, pin, streets, vehicles, gate, review, save @xb", async ({ page, pageErrors }) => {
    await freshStart(page);
    await expect(page.locator("main h1")).toHaveText("Where did it happen?");

    // Step 1: the full search goes to the Main/Park crossing (fixtures), pick it, then set the pin.
    await searchBox(page).fill(SEARCH_TEXT);
    await searchBox(page).press("Enter");
    const results = page.locator(".results button");
    await expect(results.first()).toBeVisible();
    await expect(results.first()).toContainText("Main Street & Park Street");
    await expect(results.first()).toContainText("where Main Street meets Park Street");
    await results.first().click();
    await expect(page.locator(".coords-label")).toContainText("From search");
    const coords = page.locator(".coords .num");
    await expect(coords).toHaveText(/^42\.76\d+, -71\.46\d+$/);
    const before = await coords.innerText();

    // Set the pin: nudge it with the keyboard (the marker is keyboard-operable), as a claimant would fine-tune it.
    const marker = page.locator(".leaflet-marker-icon");
    await expect(marker).toBeVisible();
    await marker.focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".coords-label")).toHaveText("Pin placed by you");
    await expect(coords).not.toHaveText(before);

    // Streets at the pin are detected from the cached OSM data.
    await expect(page.locator(".streets-here")).toContainText(/Streets at the pin: .*Main Street/);
    await expect(page.locator(".streets-here")).toContainText("Park Street");

    await page.getByRole("button", { name: /Next: vehicles/ }).click();
    await expect(page.locator("main h1")).toHaveText("Which vehicles were involved?");

    // Step 2: nothing pre-filled for direction.
    const a = page.locator("#vehicle-A");
    const b = page.locator("#vehicle-B");
    for (const card of [a, b]) {
      await expect(card.locator("[data-fix-direction] [role=radio]").first()).toBeVisible();
      await expect(card.locator("[data-fix-direction] [role=radio][aria-checked=true]")).toHaveCount(0);
      await expect(card.locator(".dir-caption")).toHaveText("Not picked yet");
    }
    // Road-relative choices come from the streets at the pin.
    await expect(a.getByRole("radio", { name: "Northbound on Main Street" })).toBeVisible();
    await expect(a.getByRole("radio", { name: "Westbound on Park Street" })).toBeVisible();

    // The gate blocks until every vehicle has a direction, with no way around it.
    await page.getByRole("button", { name: /See the recreation/ }).click();
    const gate = page.getByTestId("gate-panel");
    await expect(gate).toContainText("Pick which way your car was going.");
    await expect(gate).toContainText("Pick which way vehicle B was going.");
    await expect(gate.getByRole("button", { name: "See it anyway" })).toHaveCount(0);
    await expect(page.locator("#app")).toHaveAttribute("data-step", "vehicles");

    await a.getByRole("radio", { name: "Northbound on Main Street" }).click();
    await expect(a.locator(".dir-caption")).toContainText(/north/i);
    await page.getByRole("button", { name: /See the recreation/ }).click();
    await expect(gate).not.toContainText("your car was going");
    await expect(gate).toContainText("Pick which way vehicle B was going.");
    await expect(page.locator("#app")).toHaveAttribute("data-step", "vehicles");

    // Vehicle B: year, make and model; the type comes from the (fixture) vPIC list.
    await b.getByLabel("Year").fill("2018");
    await b.getByLabel("Make").fill("Ford");
    await expect(b.locator(".lookup")).toContainText("Ford models for 2018");
    await b.getByLabel("Model").fill("Escape");
    await expect(b.locator(".lookup")).toContainText("from NHTSA vPIC");
    await expect(b.locator(".type-auto")).toContainText("SUV");
    await expect(b.getByRole("button", { name: /Not right\? Change the type/ })).toBeVisible();
    // Changing the make clears the model.
    await b.getByLabel("Make").fill("Toyota");
    await expect(b.getByLabel("Model")).toHaveValue("");
    await expect(b.locator(".lookup")).toContainText("Toyota models for 2018");
    await b.getByLabel("Model").fill("RAV4");
    await expect(b.locator(".lookup")).toContainText("from NHTSA vPIC");

    await b.getByRole("radio", { name: "Westbound on Park Street" }).click();

    // The speed question, and the zones.
    await expect(a.getByText("About how fast at the moment of the crash?")).toBeVisible();
    await expect(b.getByText("About how fast at the moment of the crash?")).toBeVisible();
    const aSpeed = a.getByRole("textbox", { name: "Speed at impact in mph, vehicle A" });
    const start = Number(await aSpeed.inputValue());
    await a.getByRole("button", { name: "Faster, vehicle A" }).click();
    await expect(aSpeed).toHaveValue(String(start + 5));
    // The speed can also be typed.
    await aSpeed.fill("32.5");
    await expect(aSpeed).toHaveValue("32.5");
    await expect(a.locator(".field-error")).toHaveCount(0);
    await a.getByRole("radio", { name: "Hit on the right side", exact: true }).click();
    await expect(a.getByRole("radio", { name: "Hit on the right side", exact: true })).toHaveAttribute("aria-checked", "true");
    await b.getByRole("radio", { name: "Hit on the front", exact: true }).click();

    // Step 3: Review. The 3D canvas renders.
    await toReview(page);
    await expect(page.locator("main h1")).toHaveText("Does this match what happened?");
    await waitForViewer(page);
    await expect(page.getByTestId("scene-summary")).toContainText(/about/);

    // Step 4: Save. The scene file is locked on next to PDF or PNG.
    await page.getByRole("button", { name: "Looks right: save it" }).click();
    await expect(page.locator("#app")).toHaveAttribute("data-step", "export");
    await expect(page.locator("main h1")).toHaveText("What do you want to save?");
    const pdf = page.locator("input[name=fmt][value=pdf]");
    const png = page.locator("input[name=fmt][value=png]");
    const json = page.locator("input[name=fmt][value=json]");
    await expect(pdf).toBeChecked();
    await expect(png).toBeChecked();
    await expect(json).toBeChecked();
    await expect(json).toBeDisabled();
    await expect(page.getByTestId("json-hint")).toBeVisible();
    await pdf.uncheck();
    await expect(json).toBeChecked();
    await expect(json).toBeDisabled();
    await png.uncheck();
    await expect(json).toBeEnabled();
    await pdf.check();
    await expect(json).toBeChecked();
    await expect(json).toBeDisabled();
    await png.check();

    // One save = one download: crash-scene-<claim>.zip holding every file.
    const saved = await saveFiles(page);
    expect(saved.name).toBe("crash-scene-CLM-2419.zip");
    const names = [...saved.files.keys()].sort();
    expect(names).toContain("crash-scene-CLM-2419.pdf");
    expect(names).toContain("crash-scene-CLM-2419.json");
    expect(names).toContain("crash-scene-CLM-2419-diagram.png");
    // With 3D available, pictures also include the impact and final-rest stills (DESIGN.md section 8).
    expect(names).toContain("crash-scene-CLM-2419-impact.png");
    expect(names).toContain("crash-scene-CLM-2419-final-rest.png");
    expect(names).toHaveLength(5);
    await expect(page.getByTestId("stamp")).toContainText("Fingerprint");
    // The typed speed made it into the scene file.
    const sceneFile = JSON.parse(saved.files.get("crash-scene-CLM-2419.json")!.toString("utf8")) as { vehicles: Array<{ id: string; speed: { kind: string; mph?: number } }> };
    expect(sceneFile.vehicles.find((v) => v.id === "A")?.speed).toEqual({ kind: "known", mph: 32.5 });
    expect(pageErrors()).toEqual([]);
  });

  test("'See it anyway' reaches a picture, or an honest refusal (DESIGN.md section 18)", async ({ page }) => {
    // On the default claim A is pre-set as hit on the LEFT; with A northbound on Main and B westbound on Park
    // those zones can't touch. Section 18: the picture uses the nearest zone that can, and says so.
    await fillDefaultClaim(page);
    await page.getByRole("button", { name: /See the recreation/ }).click();
    const anyway = page.getByTestId("gate-panel").getByRole("button", { name: "See it anyway" });
    await expect(anyway).toBeVisible();
    await anyway.click();
    await expect(page.locator("#app")).toHaveAttribute("data-step", "review");
    const refusal = page.locator(".review-fail");
    await expect(page.locator(".viewer-canvas[data-ready='true']").or(refusal)).toBeVisible({ timeout: 30_000 });
    if (await refusal.isVisible()) {
      // An honest refusal: plain words and a way back, never a blank screen.
      await expect(refusal).toContainText(/\w+/);
      await expect(refusal.getByRole("button", { name: "Edit the details myself" })).toBeVisible();
      throw new Error(`zones that can't touch should fall back to the nearest zone, not refuse: ${await refusal.innerText()}`);
    }
    await waitForViewer(page);
    // The review leads with what the picture used, and still lists the accepted mismatch.
    const warnings = page.getByTestId("review-warnings");
    await expect(warnings).toContainText(/so the picture uses the .+ instead/);
    await warnings.getByRole("button", { name: /Show all/ }).click();
    await expect(warnings).toContainText("marked as hit on the left side");
  });

  test("the review says which zone the picture used instead (DESIGN.md section 18)", async ({ page }) => {
    // Regression guard, fixed 2026-10-09 (Review hides the physics' own warnings): when the entered zones can't touch, the physics uses the
    // nearest zone that can and says so in sim.warnings ("...so the picture uses the front right instead",
    // packages/core/src/physics/simulate.ts:370). The PDF prints sim.warnings (packages/exports/src/model.ts:224),
    // but the Review step only shows the gate's problems (apps/web/src/review/ReviewStep.tsx:49-51), so the
    // claimant sees a hit zone they never entered with no word about it.
    await fillDefaultClaim(page);
    await page.getByRole("button", { name: /See the recreation/ }).click();
    await page.getByTestId("gate-panel").getByRole("button", { name: "See it anyway" }).click();
    await waitForViewer(page);
    await expect(page.locator("main")).toContainText(/so the picture uses the .+ instead/, { timeout: 5_000 });
  });

  test("an impossible scene after 'See it anyway' explains why and offers one-tap fixes that draw (DESIGN.md section 18)", async ({ page }, info) => {
    // Section 18: moving apart is never drawn as entered. A northbound, B southbound on the same road, both hit on the rear.
    await fillDefaultClaim(page);
    await page.locator("#vehicle-B").getByRole("radio", { name: "Southbound on Main Street" }).click();
    await page.locator("#vehicle-A").getByRole("radio", { name: "Hit on the rear", exact: true }).click();
    await page.locator("#vehicle-B").getByRole("radio", { name: "Hit on the rear", exact: true }).click();
    await page.getByRole("button", { name: /See the recreation/ }).click();
    const anyway = page.getByTestId("gate-panel").getByRole("button", { name: "See it anyway" });
    if (await anyway.isVisible()) await anyway.click();
    await expect(page.locator("#app")).toHaveAttribute("data-step", "review");
    const refusal = page.getByTestId("refusal");
    await expect(refusal).toBeVisible({ timeout: 30_000 });
    await expect(refusal).toContainText("We can't draw this yet");
    await expect(page.getByTestId("refusal-why")).toHaveText(/^[A-Z].*\.$/);
    await expect(page.locator(".viewer3d canvas")).toHaveCount(0);
    const fixes = refusal.locator("button.refusal-fix");
    await expect(fixes.first()).toBeVisible({ timeout: 30_000 });
    const n = await fixes.count();
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(3);
    for (const label of await fixes.allInnerTexts()) expect(label).toMatch(/^(Change [A-D]'s (hit side|direction|action|lane|speed) to |Swap who hit whom: |Move the pin about )/);
    await expect(refusal.getByRole("button", { name: "Edit the details myself" })).toBeVisible();
    // No horizontal scroll at this width.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `${SHOTS}/refusal-${info.project.name}.png`, fullPage: true });
    // One tap draws a picture.
    await fixes.first().click();
    await expect(refusal).toHaveCount(0);
    await waitForViewer(page);
    await expect(page.locator("#h-review")).toBeFocused();
    await page.screenshot({ path: `${SHOTS}/refusal-fixed-${info.project.name}.png`, fullPage: true });
  });

  test("'Edit the details myself' goes back to the vehicles", async ({ page }) => {
    await fillDefaultClaim(page);
    await page.locator("#vehicle-B").getByRole("radio", { name: "Southbound on Main Street" }).click();
    await page.locator("#vehicle-A").getByRole("radio", { name: "Hit on the rear", exact: true }).click();
    await page.locator("#vehicle-B").getByRole("radio", { name: "Hit on the rear", exact: true }).click();
    await page.getByRole("button", { name: /See the recreation/ }).click();
    const anyway = page.getByTestId("gate-panel").getByRole("button", { name: "See it anyway" });
    if (await anyway.isVisible()) await anyway.click();
    const refusal = page.getByTestId("refusal");
    await expect(refusal).toBeVisible({ timeout: 30_000 });
    await refusal.getByRole("button", { name: "Edit the details myself" }).click();
    await expect(page.locator("#app")).toHaveAttribute("data-step", "vehicles");
  });

  test("Review exposes a ready signal once the 3D view has drawn", async ({ page }) => {
    await openExampleNoWait(page);
    await expect(page.locator(".viewer-canvas[data-ready='true']")).toHaveCount(1, { timeout: 30_000 });
    expect(await canvasPainted(page), "ready means the picture has drawn").toBe(true);
  });

  test("typing a whole crossing with its town never says the streets don't cross", async ({ page }) => {
    // Regression guard, fixed 2026-10-09 (search): with "Main Street and Park Street, Nashua NH" typed, the crossing list filters the real
    // crossings by everything after "and" ("Park Street, Nashua NH"), so Park Street doesn't match and the list
    // says "No streets cross Main Street near here", which is false (SearchPanel.tsx:175 filters on
    // crossFor.rest; :307 then shows noCrossingText). The town part should be ignored, or Park Street offered.
    // Typed fresh: the claim's town gives the area. (Retyping the text of a result just picked is a settled
    // search, so the list stays closed; that is not this case.)
    await freshStart(page);
    await searchBox(page).fill(SEARCH_TEXT);
    await expect(page.locator(".combo-pop")).toBeVisible();
    await expect(page.locator(".combo-pop")).not.toContainText("Searching", { timeout: 10_000 });
    await expect(page.locator(".combo-pop")).not.toContainText("No streets cross");
    await expect(page.getByRole("listbox").getByRole("option", { name: /^Park Street/ })).toHaveCount(1);
  });

  test("the open suggestion list never covers the Search button", async ({ page }) => {
    // Regression guard, fixed 2026-10-09 (phone layout): on a phone the Search button sits under the box, and the open list (.combo-pop)
    // is drawn over it, so a claimant who types a full address can't tap Search until the list is closed.
    await freshStart(page);
    await searchBox(page).fill(SEARCH_TEXT);
    await expect(page.locator(".combo-pop")).toBeVisible();
    const button = page.getByRole("button", { name: "Search", exact: true });
    const hit = await button.evaluate((b) => {
      const r = b.getBoundingClientRect();
      const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return el === b || b.contains(el);
    });
    expect(hit, "the Search button can be tapped while the list is open").toBe(true);
    await button.click({ timeout: 5_000 });
    await expect(page.locator(".results button").first()).toBeVisible();
  });

  test("the crossing dropdown: pick a street, then the street that crosses it @xb", async ({ page }) => {
    await freshStart(page);
    const box = searchBox(page);
    await box.fill("Main Str");
    const list = page.getByRole("listbox");
    await expect(list).toBeVisible();
    await expect(page.locator(".combo-title")).toHaveText("Suggestions");
    const main = list.getByRole("option", { name: /^Main Street/ }).first();
    await expect(main).toBeVisible();
    await expect(main).toContainText(/N(ashua|H)/);
    await main.click();
    await expect(page.locator(".combo-title")).toHaveText("Crossing streets");
    const park = list.getByRole("option", { name: /^Park Street/ }).first();
    await expect(park).toBeVisible();
    // Keyboard: arrow down to an option and Enter picks it.
    await box.focus();
    const options = await list.getByRole("option").allInnerTexts();
    const idx = options.findIndex((t) => t.startsWith("Park Street"));
    for (let k = 0; k <= idx; k++) await page.keyboard.press("ArrowDown");
    await expect(box).toHaveAttribute("aria-activedescendant", /.+/);
    await page.keyboard.press("Enter");
    await expect(box).toHaveValue(/^Main Street & Park Street/);
    await expect(page.locator(".coords-label")).toContainText("From search: Main Street & Park Street");
    await expect(page.locator(".coords .num")).toHaveText(/^42\.76\d+, -71\.46\d+$/);
    await expect(page.locator(".streets-here")).toContainText(/Streets at the pin: .*Main Street/);
  });
});

async function openExampleNoWait(page: Page): Promise<void> {
  await page.goto("/?example=t-bone-intersection");
  await expect(page.locator(".viewer3d canvas")).toBeVisible({ timeout: 30_000 });
}
