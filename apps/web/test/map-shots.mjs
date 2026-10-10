// Screenshots of the Location step at 1440 and 390 (compact and expanded), t-bone area, fixtures build:
//   VITE_FIXTURES=1 npx vite build && npx --no-install vite preview --port 4701 --strictPort
//   node apps/web/test/map-shots.mjs http://localhost:4701
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const base = process.argv[2] ?? "http://localhost:4701";
const out = fileURLToPath(new URL("../test-screens/", import.meta.url));
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
try {
  for (const [name, w, h, mobile] of [["1440", 1440, 900, false], ["390", 390, 844, true]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile });
    const page = await ctx.newPage();
    await page.goto(`${base}/?example=t-bone-intersection#review`);
    await page.waitForTimeout(500);
    await page.evaluate(() => { location.hash = "#location"; });
    await page.locator(".leaflet-tile-loaded").first().waitFor();
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${out}map-location-${name}.png` });
    await page.screenshot({ path: `${out}map-location-${name}-full.png`, fullPage: true });
    if (mobile) {
      await page.getByRole("button", { name: "Expand map" }).click();
      await page.waitForTimeout(800);
      await page.screenshot({ path: `${out}map-location-${name}-expanded.png` });
    }
    await ctx.close();
  }
} finally {
  await browser.close();
}
