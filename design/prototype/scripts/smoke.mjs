// Quick smoke check: load each route, report console errors and page errors.
import { chromium } from "playwright";
const UA = "InsurifyAI-CrashScene-Prototype/0.1 (+https://insurifyai.app; design testing)";
const b = await chromium.launch();
for (const w of [1440, 390]) {
  const ctx = await b.newContext({ viewport: { width: w, height: w > 500 ? 900 : 844 }, userAgent: UA });
  const p = await ctx.newPage();
  const errs = [];
  p.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") errs.push(`${m.type()}: ${m.text()}`); });
  p.on("pageerror", (e) => errs.push(`pageerror: ${e.message}`));
  for (const r of ["location", "vehicles", "review", "export", "pdf", "png"]) {
    await p.goto(`http://localhost:5180/prototype/#${r}`);
    await p.waitForTimeout(r === "location" ? 2500 : 900);
    console.log(w, r, errs.splice(0).join(" | ") || "ok");
  }
  await ctx.close();
}
await b.close();
