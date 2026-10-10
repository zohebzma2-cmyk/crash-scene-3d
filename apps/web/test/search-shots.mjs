// Screenshots of the search dropdowns at 1440 and 390 (built app, fixtures mode):
//   VITE_FIXTURES=1 npm run build && npm run preview    then    node apps/web/test/search-shots.mjs
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
    page.on("request", (r) => requests.push(r.url()));
    await page.goto(`${base}/?fixtures=1#location`);
    await page.evaluate(() => sessionStorage.clear());
    await page.goto(`${base}/?fixtures=1#location`);
    const box = page.getByRole("combobox");
    await box.waitFor();
    await box.fill("");
    await box.pressSequentially("main str", { delay: 40 });
    await page.getByRole("listbox").waitFor();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${out}search-suggestions-${name}.png` });
    check(`${name}: suggestions show name and Town, State`, (await page.locator("[role=option]").first().innerText()).includes("Nashua, NH"));
    await box.press("ArrowDown");
    check(`${name}: ArrowDown highlights an option`, (await box.getAttribute("aria-activedescendant")) !== null);
    // The crossing list.
    await box.fill("");
    await box.pressSequentially("Main Street and ", { delay: 40 });
    await page.waitForFunction(() => document.querySelector(".combo-title")?.textContent === "Crossing streets");
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${out}search-crossings-${name}.png` });
    const names = await page.locator("[role=option] .r-main").allInnerTexts();
    check(`${name}: crossing list has Park Street and not Main Street`, names.includes("Park Street") && !names.includes("Main Street"), names.join(", "));
    // Pick it: the pin lands on the crossing.
    await page.locator("[role=option]", { hasText: "Park Street" }).first().click();
    await page.waitForTimeout(600);
    const coords = await page.locator(".coords .num").innerText();
    check(`${name}: the pin is on the crossing point`, /^42\.762\d+, -71\.466\d+$/.test(coords), coords);
    check(`${name}: nothing left the origin`, requests.every((u) => u.startsWith(base) || u.startsWith("data:") || u.startsWith("blob:")), requests.filter((u) => !u.startsWith(base) && !u.startsWith("data:") && !u.startsWith("blob:")).join(" "));
    await page.screenshot({ path: `${out}search-picked-${name}.png`, fullPage: false });
    // A long address wraps instead of being cut off.
    await box.fill("Main Street and Park Street, Nashua, New Hampshire, United States of America");
    await page.waitForTimeout(200);
    const grew = await box.evaluate((el) => ({ h: el.clientHeight, sh: el.scrollHeight }));
    check(`${name}: a long address is never cut off (the field grows)`, grew.sh <= grew.h + 1, JSON.stringify(grew));
    await ctx.close();
  }
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
