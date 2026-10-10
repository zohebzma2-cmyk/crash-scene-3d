// Screenshots of "Main Street and Park" typed with no pin, using the claim's town (built app, fixtures mode):
//   VITE_FIXTURES=1 npm run build && npm run preview    then    node apps/web/test/claim-town-shots.mjs [base]
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const base = process.argv[2] ?? "http://localhost:4173";
const out = fileURLToPath(new URL("../test-screens/", import.meta.url));
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
let failed = 0;
const check = (name, ok, detail = "") => { console.log(ok ? "OK  " : "FAIL", name, detail); if (!ok) failed++; };
try {
  for (const [name, w, h, mobile] of [["1440", 1440, 900, false], ["390", 390, 844, true]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile });
    const page = await ctx.newPage();
    const requests = [];
    page.on("request", (r) => { if (r.url().includes("/api/")) requests.push(decodeURIComponent(r.url().replace(base, ""))); });
    await page.goto(`${base}/?fixtures=1#location`);
    await page.evaluate(() => sessionStorage.clear());
    await page.goto(`${base}/?fixtures=1#location`);
    const box = page.getByRole("combobox");
    await box.waitFor();
    await page.waitForTimeout(600);
    check(`${name}: nothing is sent before typing`, requests.length === 0, requests.join(" | "));
    check(`${name}: no pin yet`, (await page.locator(".coords").innerText()).includes("No pin yet"));
    await box.fill("");
    await box.pressSequentially("Main Street and Park", { delay: 40 });
    await page.waitForFunction(() => document.querySelector(".combo-title")?.textContent === "Crossing streets");
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${out}claim-town-crossings-${name}.png` });
    const names = await page.locator("[role=option] .r-main").allInnerTexts();
    const msg = await page.locator(".combobox").innerText();
    check(`${name}: finds Park Street without asking to search first`, names.includes("Park Street") && !/search for the place/i.test(msg), names.join(", ") || msg);
    console.log("     requests:", requests.join(" | "));
    await ctx.close();
  }
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
