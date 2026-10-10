// Checks that the review's timeline and primary action are on screen at desktop sizes (built app, fixtures mode):
// the three examples, and the default claim with warnings shown ("See it anyway").
//   VITE_FIXTURES=1 npm run build && npm run preview   then   node apps/web/test/layout.mjs
import { chromium } from "@playwright/test";

const base = process.argv[2] ?? "http://localhost:4173";
const browser = await chromium.launch();
let bad = 0;

async function measure(page, label, w, h) {
  await page.waitForSelector(".timeline");
  await page.waitForTimeout(600);
  const r = await page.evaluate(() => {
    const b = (s) => { const e = document.querySelector(s); const r = e?.getBoundingClientRect(); return r ? { top: Math.round(r.top), bottom: Math.round(r.bottom) } : null; };
    return { timeline: b(".timeline"), primary: b(".panel-foot .btn-primary"), warnings: !!document.querySelector("[data-testid=review-warnings]"), page: document.documentElement.scrollHeight };
  });
  const ok = r.timeline && r.primary && r.timeline.bottom <= h && r.primary.bottom <= h && r.page <= h;
  console.log(`${w}x${h} ${label}`, JSON.stringify(r), ok ? "OK" : "OFF SCREEN");
  if (!ok) bad++;
}

try {
  for (const [w, h] of [[1440, 900], [1920, 1080]]) {
    for (const name of ["t-bone-intersection", "highway-rear-end", "parking-lot-backing"]) {
      const page = await browser.newPage({ viewport: { width: w, height: h } });
      await page.goto(`${base}/?example=${name}#review`);
      await measure(page, name, w, h);
      await page.close();
    }
    // The default claim: search, pick, directions, a mismatch on purpose, then "See it anyway".
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    await page.goto(`${base}/?fixtures=1#location`);
    await page.evaluate(() => sessionStorage.clear());
    await page.goto(`${base}/?fixtures=1#location`);
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await page.locator(".results button").first().click();
    await page.getByRole("button", { name: /Next: vehicles/ }).click();
    await page.waitForSelector("#vehicle-A");
    await page.waitForTimeout(900);
    await page.locator("#vehicle-A").getByRole("radio", { name: "Northbound on Main Street" }).click();
    await page.locator("#vehicle-B").getByRole("radio", { name: "Northbound on Main Street" }).click();
    await page.locator("#vehicle-A").getByRole("radio", { name: "Hit on the front", exact: true }).click();
    await page.getByRole("button", { name: /See the recreation/ }).click();
    await page.waitForTimeout(500);
    const anyway = page.getByRole("button", { name: "See it anyway" });
    if (await anyway.count()) await anyway.click();
    await measure(page, "default claim with warnings", w, h);
    await page.close();
  }
} finally {
  await browser.close();
}
process.exit(bad ? 1 : 0);
