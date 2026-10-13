// Screenshot routes for a quick visual check: node scripts/peek.mjs out-dir route... 
import { chromium } from "playwright";
const [out, ...routes] = process.argv.slice(2);
const UA = "InsurifyAI-CrashScene-Prototype/0.1 (+https://insurifyai.app; design testing)";
const b = await chromium.launch();
for (const w of [1440, 390]) {
  const ctx = await b.newContext({ viewport: { width: w, height: w > 500 ? 900 : 844 }, userAgent: UA, reducedMotion: "reduce" });
  const p = await ctx.newPage();
  // The first-visit welcome (DESIGN.md section 19) is seen already, so the frames show the screens.
  await ctx.addInitScript(() => { try { localStorage.setItem("csd.welcome.v1", JSON.stringify({ seen: true })); } catch { /* blocked */ } });
  for (const r of routes) {
    await p.goto(`http://localhost:5180/prototype/#${r}`);
    await p.waitForTimeout(r === "location" ? 3500 : 1200);
    await p.screenshot({ path: `${out}/${r}-${w}.png`, fullPage: w > 500 });
  }
  await ctx.close();
}
await b.close();
