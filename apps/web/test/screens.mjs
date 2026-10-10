// Screenshots of every step at 1440 and 390 in fixtures mode, from the built app.
//   npm run build && npm run preview     (in another terminal; serves :4173)
//   node apps/web/test/screens.mjs [baseUrl]
// Writes PNGs to apps/web/test-screens/. Nothing here calls a live service: fixtures mode serves examples/*.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const base = process.argv[2] ?? "http://localhost:4173";
const out = fileURLToPath(new URL("../test-screens/", import.meta.url));
mkdirSync(out, { recursive: true });

const sizes = [
  { name: "1440", viewport: { width: 1440, height: 900 }, mobile: false },
  { name: "390", viewport: { width: 390, height: 844 }, mobile: true },
];

const browser = await chromium.launch();
try {
  for (const s of sizes) {
    const ctx = await browser.newContext({ viewport: s.viewport, deviceScaleFactor: s.mobile ? 2 : 1, isMobile: s.mobile, hasTouch: s.mobile, reducedMotion: "reduce" });
    const page = await ctx.newPage();
    const shot = async (name, full = false) => { await page.waitForTimeout(500); await page.screenshot({ path: `${out}${name}-${s.name}.png`, fullPage: full }); console.log("wrote", `${name}-${s.name}.png`); };
    page.on("pageerror", (e) => console.log("pageerror:", e.message));

    // Step 1 before a place is set (the phone gets the compact note, not an empty map).
    await page.goto(`${base}/?fixtures=1#location`);
    await page.evaluate(() => sessionStorage.clear());
    await page.goto(`${base}/?fixtures=1#location`);
    await page.waitForSelector("h1");
    await shot("1-location-nopin", true);

    // Search with the claim address, pick the result.
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await page.waitForSelector(".results button");
    await shot("1-location-results", true);
    await page.locator(".results button").first().click();
    await page.waitForTimeout(1200);
    await shot("1-location", true);

    // Step 2.
    await page.getByRole("button", { name: /Next: vehicles/ }).click();
    await page.waitForSelector("#vehicle-A");
    await page.waitForTimeout(800);
    await shot("2-vehicles", true);

    // Directions are the claimant's to pick: nothing is pre-filled, and Review waits for them.
    await page.getByRole("button", { name: /See the recreation/ }).click();
    await page.waitForTimeout(500);
    await shot("2-vehicles-needs-directions", true);
    await page.locator("#vehicle-A").getByRole("radio", { name: "Northbound on Main Street" }).click();
    await page.locator("#vehicle-B").getByRole("radio", { name: "Northbound on Main Street" }).click();
    // Both going the same way, and A hit on the front: the checks have something to say.
    await page.locator("#vehicle-A").getByRole("radio", { name: "Hit on the front", exact: true }).click();

    // Step 3 from the form.
    await page.getByRole("button", { name: /See the recreation/ }).click();
    await page.waitForTimeout(800);
    await shot("3-vehicles-warnings", true);
    const anyway = page.getByRole("button", { name: "See it anyway" });
    if (await anyway.count()) await anyway.click();
    await page.waitForTimeout(1200);
    await shot("3-review-default-warnings");

    // Step 4.
    if (await page.getByRole("button", { name: "Looks right: save it" }).count()) {
      await page.getByRole("button", { name: "Looks right: save it" }).click();
      await page.waitForSelector("#h-export");
      await page.waitForSelector(".preview-canvas", { timeout: 20000 });   // the real PDF, drawn by pdf.js
      await page.waitForTimeout(4000);
      await shot("4-save", true);
    }

    // The three examples straight on the review step, with the measure tab.
    for (const name of ["t-bone-intersection", "highway-rear-end", "parking-lot-backing"]) {
      await page.goto(`${base}/?example=${name}#review`);
      await page.waitForSelector(".viewer-canvas");
      await page.waitForTimeout(1500);
      await shot(`3-review-${name}`);
    }
    await page.goto(`${base}/?example=t-bone-intersection#review`);
    await page.waitForSelector(".viewer-canvas");
    await page.getByRole("tab", { name: "Measure" }).click();
    await page.getByLabel("Show on the picture").check();
    await page.waitForTimeout(800);
    await shot("3-review-measure");

    // Dark theme.
    await page.goto(`${base}/?example=t-bone-intersection&theme=dark#review`);
    await page.waitForSelector(".viewer-canvas");
    await page.waitForTimeout(1200);
    await shot("3-review-dark");
    await ctx.close();
  }

  // ---- Real-browser checks: focus rings are keyboard-only, and the full size view is wider than the inline one ----
  let failed = 0;
  const check = (name, ok, detail = "") => { console.log(ok ? "OK  " : "FAIL", name, detail); if (!ok) failed++; };
  const ringOf = (page) => page.evaluate(() => {
    const el = document.activeElement;
    const cs = el ? getComputedStyle(el) : null;
    const probe = document.createElement("span");
    probe.style.width = "var(--size-focus-ring)";
    document.body.append(probe);
    const tokenPx = getComputedStyle(probe).width;
    probe.remove();
    return { tag: el?.tagName, role: el?.getAttribute("role"), style: cs?.outlineStyle, width: cs?.outlineWidth, token: tokenPx, color: cs?.outlineColor };
  });
  for (const [w, h] of [[1440, 900], [390, 844]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: w < 768, hasTouch: w < 768 });
    const page = await ctx.newPage();
    await page.goto(`${base}/?fixtures=1#location`);
    await page.evaluate(() => sessionStorage.clear());
    await page.goto(`${base}/?fixtures=1#location`);
    await page.waitForSelector("h1");
    // A mouse click moves to the next step: the step title is focused by script and shows no ring.
    await page.getByRole("button", { name: /Next: vehicles/ }).click();
    await page.waitForSelector("#vehicle-A");
    await page.waitForTimeout(300);
    let r = await ringOf(page);
    check(`${w}: h1 is focused after a mouse click`, r.tag === "H1", JSON.stringify(r));
    check(`${w}: ...and draws no ring`, r.style === "none" || r.width === "0px", `${r.style} ${r.width}`);
    // Tab to a real control: it shows the ring, from the tokens.
    await page.keyboard.press("Tab");
    r = await ringOf(page);
    check(`${w}: Tab lands on a control`, r.tag !== "H1" && r.tag !== "BODY", JSON.stringify(r));
    check(`${w}: ...which shows the ring (solid, --size-focus-ring)`, r.style === "solid" && r.width === r.token, `${r.style} ${r.width} vs ${r.token}`);
    // A radio reached by Tab, and one more Tab for a button or input.
    await page.keyboard.press("Tab");
    r = await ringOf(page);
    check(`${w}: the next Tab also shows the ring`, r.style === "solid" && r.width === r.token, JSON.stringify(r));
    // A mouse click on a control leaves no ring on it.
    await page.locator("#vehicle-A").getByRole("radio", { name: "Straight" }).click();
    r = await ringOf(page);
    check(`${w}: a mouse-clicked radio shows no ring`, r.style === "none" || r.width === "0px", JSON.stringify(r));
    await ctx.close();
  }
  {
    // Script focus with no interaction at all (an example opens straight on the review).
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`${base}/?example=t-bone-intersection#review`);
    await page.waitForSelector(".viewer-canvas");
    await page.waitForTimeout(800);
    const r = await ringOf(page);
    check("1440: script-focused h1 with no interaction draws no ring", r.tag !== "H1" || r.style === "none" || r.width === "0px", JSON.stringify(r));
    // Full size view is at least as wide as the inline preview.
    await page.getByRole("button", { name: "Looks right: save it" }).click();
    await page.waitForSelector(".preview-canvas", { timeout: 20000 });
    await page.waitForTimeout(3000);
    const inline = await page.evaluate(() => document.querySelector(".preview-frame .preview-canvas")?.getBoundingClientRect().width ?? 0);
    await page.getByRole("button", { name: "Open full size" }).click();
    await page.waitForSelector("dialog.full-size-dialog .preview-canvas");
    await page.waitForTimeout(2500);
    const full = await page.evaluate(() => ({ canvas: document.querySelector("dialog.full-size-dialog .preview-canvas")?.getBoundingClientRect().width ?? 0, dialog: document.querySelector("dialog.full-size-dialog")?.getBoundingClientRect().width ?? 0 }));
    check("1440: full size canvas is wider than the inline preview", full.canvas > inline, `inline ${Math.round(inline)}px, full size ${Math.round(full.canvas)}px (dialog ${Math.round(full.dialog)}px)`);
    await page.screenshot({ path: `${out}4-save-fullsize-1440.png` });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    const closed = await page.evaluate(() => !document.querySelector("dialog.full-size-dialog"));
    check("1440: Esc closes the full size view", closed);
    await page.close();
  }
  if (failed) process.exitCode = 1;
} finally {
  await browser.close();
}
