// End-to-end walkthrough of the prototype at 1440 and 390, recorded on video.
// Uses every button, toggle and input; checks that the review and every export
// match what was entered; checks the Nominatim 1 req/s rule and allowed hosts.
// Output: recordings/<width>/ (video, downloads, screenshots) + recordings/report.md
import { chromium } from "playwright";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rm, rename, readdir } from "node:fs/promises";

const BASE = process.env.BASE || "http://localhost:5180/prototype/";
const UA = "InsurifyAI-CrashScene-Prototype/0.1 (+https://insurifyai.app; design testing)";
const OUT = new URL("../recordings/", import.meta.url).pathname;
const SHOTS = new URL("../screens/", import.meta.url).pathname;
const ALLOWED = ["localhost", "tile.openstreetmap.org", "nominatim.openstreetmap.org", "vpic.nhtsa.dot.gov", "fonts.googleapis.com", "fonts.gstatic.com"];
await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
await mkdir(SHOTS, { recursive: true });

const report = [];
const browser = await chromium.launch();

for (const width of [1440, 390]) {
  const phone = width < 500;
  const dir = `${OUT}${width}/`;
  await mkdir(dir, { recursive: true });
  const ctx = await browser.newContext({
    viewport: { width, height: phone ? 844 : 900 }, userAgent: UA, acceptDownloads: true,
    reducedMotion: "reduce", recordVideo: { dir, size: { width, height: phone ? 844 : 900 } },
  });
  const page = await ctx.newPage();
  // The first-visit welcome (DESIGN.md section 19) is seen already, so the frames show the screens.
  await ctx.addInitScript(() => { try { localStorage.setItem("csd.welcome.v1", JSON.stringify({ seen: true })); } catch { /* blocked */ } });
  const results = [];
  const errors = [];
  const hosts = new Set();
  const nominatimAt = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.protocol === "http:" || u.protocol === "https:") hosts.add(u.hostname);
    if (u.hostname === "nominatim.openstreetmap.org") nominatimAt.push({ t: Date.now(), q: u.searchParams.get("q"), params: [...u.searchParams.keys()].sort().join(",") });
  });

  async function step(name, fn) {
    try { const note = await fn(); results.push({ name, ok: true, note: note || "" }); }
    catch (e) { results.push({ name, ok: false, note: String(e.message || e).split("\n")[0] }); await page.screenshot({ path: `${dir}FAIL-${results.length}.png` }).catch(() => {}); }
  }
  const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
  const text = (sel) => page.locator(sel).first().innerText();
  const shot = (name) => page.screenshot({ path: `${SHOTS}${name}-${width}.png`, fullPage: !phone && !name.startsWith("review") });
  const card = (letter) => page.locator(`.vehicle.v-${letter.toLowerCase()}`);
  const tapIn = async (loc) => { await loc.scrollIntoViewIfNeeded(); await loc.click(); };

  /* ---------------- Step 1: location ---------------- */
  await page.goto(BASE);
  await page.evaluate(() => sessionStorage.clear());
  await page.goto(`${BASE}#location`);
  await page.waitForSelector("svg#i-shield, symbol#i-shield", { state: "attached" });

  await step("Claim address is prefilled but not sent until the claimant taps Search", async () => {
    await page.waitForTimeout(800);
    const t = await text("#search-status");
    expect(/address on your claim. Tap Search/.test(t), `status "${t}"`);
    expect(nominatimAt.length === 0, `${nominatimAt.length} geocoder requests before Search`);
    await page.click("#search-btn");
    await page.waitForFunction(() => !document.querySelector("#search-btn").hasAttribute("aria-busy") && document.querySelector(".status-empty, #results:not([hidden])"), null, { timeout: 15000 });
    return t;
  });
  await step("No-results state for the made-up claim address offers the pin drop", async () => {
    const t = await text("#search-status");
    expect(/couldn't find|isn't working/i.test(t), `status was "${t}"`);
    expect(await page.locator("#map-empty").isVisible(), "map empty state not shown");
    await shot("location-nopin");
  });
  await step("Search box shows the whole field width (no cut-off)", async () => {
    const b = await page.locator("#q").boundingBox();
    expect(b.width >= (phone ? 330 : 300), `input only ${Math.round(b.width)}px wide`);
    return `${Math.round(b.width)}px`;
  });
  await step("Live Nominatim search: loading state, then results with attribution", async () => {
    await page.fill("#q", "Times Square, New York");
    await page.click("#search-btn");
    await page.waitForSelector(".status-loading", { timeout: 3000 });
    await page.waitForSelector("#results li", { timeout: 15000 });
    expect(await page.locator("#search-attrib").isVisible(), "attribution hidden");
    return `${await page.locator("#results li").count()} results`;
  });
  await step("Picking a result moves the pin, recenters and fills the coordinates", async () => {
    await page.locator("#results li button").first().click();
    await page.waitForSelector(".pin-marker");
    await page.waitForTimeout(1200);   // let tiles finish fading in before the screenshot
    const coords = await text("#coords-value");
    expect(/^4\d\.\d{5}, -7\d\.\d{5}$/.test(coords), `coords "${coords}"`);
    expect((await text("#coords-label")).startsWith("From search"), "label not 'From search'");
    const ew = await page.inputValue("#street-ew");
    await shot("location");
    return `${coords}; street filled: "${ew}"`;
  });
  await step("Zoom in and zoom out change the map zoom", async () => {
    const z = () => page.evaluate(() => Math.max(...[...document.querySelectorAll("#map img.leaflet-tile")].map((i) => Number(i.src.split("/").slice(-3)[0]))));
    const z0 = await z();
    await page.click("#zoom-out"); await page.waitForTimeout(900);
    const z1 = await z();
    await page.click("#zoom-in"); await page.waitForTimeout(900);
    const z2 = await z();
    expect(z1 < z0 && z2 > z1, `zoom ${z0} → ${z1} → ${z2}`);
    await page.click("#recenter"); await page.waitForTimeout(500);
    return `zoom ${z0} → ${z1} → ${z2}`;
  });
  await step("Dragging the pin updates the coordinates under the map", async () => {
    const before = await text("#coords-value");
    const b = await page.locator(".pin-marker").boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2 + 60, b.y + b.height / 2 + 30, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    const after = await text("#coords-value");
    expect(after !== before, "coordinates did not change");
    expect((await text("#coords-label")) === "Pin placed by you", "label not 'Pin placed by you'");
    const loc = await page.evaluate(() => JSON.parse(sessionStorage.getItem("crash-scene-3d/scene/v2")).location);
    expect(loc.label === "" && /Times Square/.test(loc.nearLabel), `label "${loc.label}", near "${loc.nearLabel}"`);
    return `${before} → ${after}; exports will say "near ${loc.nearLabel.split(",")[0]}"`;
  });
  await step("Tapping the map moves the pin", async () => {
    const before = await text("#coords-value");
    const m = await page.locator("#map").boundingBox();
    await page.mouse.click(m.x + m.width * 0.3, m.y + m.height * 0.7);
    await page.waitForTimeout(300);
    const after = await text("#coords-value");
    expect(after !== before, "coordinates did not change");
    return after;
  });
  await step("A search with no matches shows the no-results message (queued at 1 request per second)", async () => {
    await page.fill("#q", "qqzzx nowhere 99999 imaginary");
    await page.click("#search-btn");
    await page.waitForFunction(() => /couldn't find/i.test(document.querySelector("#search-status").innerText), null, { timeout: 15000 });
    await page.fill("#q", "Times Square, New York");
    await page.click("#search-btn");
    await page.waitForSelector("#results li", { timeout: 15000 });
    await page.locator("#results li button").first().click();
  });
  await step("Place type: parking hides street names (and drops them from captions), road hides the cross street", async () => {
    await page.fill("#street-ew", "Maple Ave");
    await tapIn(page.locator("#place-tiles .tile", { hasText: "Parking lot" }));
    expect(!(await page.locator("#streets-group").isVisible()), "streets visible for parking");
    await page.goto(`${BASE}#vehicles`);
    const cap = await card("B").locator("[data-dir-caption]").innerText();
    expect(!/ on /.test(cap), `parking caption still names a street: "${cap}"`);
    await page.goto(`${BASE}#location`);
    await tapIn(page.locator("#place-tiles .tile", { hasText: "Road" }));
    expect(await page.locator("#streets-group").isVisible() && !(await page.locator("#street-ns-field").isVisible()), "road layout fields wrong");
    await tapIn(page.locator("#place-tiles .tile", { hasText: "Intersection" }));
    expect(await page.locator("#street-ns-field").isVisible(), "cross street hidden for intersection");
  });
  await step("Street names, date and time take input", async () => {
    await page.fill("#street-ew", "Maple Ave");
    await page.fill("#street-ns", "3rd St");
    await page.fill("#date", "2026-09-30");
    await page.fill("#time", "08:45");
    await page.locator("#time").blur();
  });
  await step("Road condition tiles have a clear selected state", async () => {
    await tapIn(page.locator("#road-tiles .tile", { hasText: "Ice" }));
    const ring = await page.locator("#road-tiles .tile", { hasText: "Ice" }).evaluate((el) => getComputedStyle(el).boxShadow);
    expect(ring && ring !== "none", "no selected ring");
    await tapIn(page.locator("#road-tiles .tile", { hasText: "Dry" }));
    const checked = await page.locator('#road-tiles input[value="dry"]').isChecked();
    expect(checked, "dry not checked");
    return `selected ring: ${ring}`;
  });
  await step("Next goes to vehicles and keeps step 1 marked done", async () => {
    await tapIn(page.locator("#to-vehicles"));
    await page.waitForSelector("#screen-vehicles[data-active]");
    if (!phone) expect(await page.locator('.stepper li[data-step="1"]').getAttribute("data-state") === "done", "step 1 not done");
  });

  /* ---------------- Step 2: vehicles ---------------- */
  await step("Your car is prefilled from the claim and editable", async () => {
    expect(await card("A").locator('[data-field="make"]').inputValue() === "Honda", "make not prefilled");
    expect(await card("A").locator('[data-field="model"]').inputValue() === "Accord", "model not prefilled");
  });
  await step("Year, make and model look up the model list in NHTSA vPIC and fill in the type", async () => {
    const a = card("A");
    await a.locator('[data-field="year"]').fill("2019");
    await a.locator('[data-field="make"]').fill("Toyota");
    await a.locator('[data-field="model"]').fill("");
    await page.waitForFunction(() => { const el = document.querySelector(".vehicle.v-a [data-lookup]"); return !el.querySelector(".spinner") && /\d+ toyota models for 2019|couldn't reach|no toyota/i.test(el.innerText); }, null, { timeout: 20000 });
    const lk = await a.locator("[data-lookup]").innerText();
    if (/couldn't reach/i.test(lk)) { await tapIn(a.locator('[data-type="suv"]')); return "vPIC unreachable: picked the type by hand (fallback works)"; }
    await a.locator('[data-field="model"]').fill("RAV4");
    await a.locator('[data-field="model"]').dispatchEvent("change");
    await page.waitForTimeout(300);
    expect(await a.locator('[data-type="suv"]').getAttribute("aria-checked") === "true", "type not set to SUV");
    expect(await a.locator('[data-type="suv"] .auto').count() === 1, "no vPIC mark");
    return (await a.locator("[data-lookup]").innerText()).trim();
  });
  await step("Picking a type by hand overrides the lookup", async () => {
    await tapIn(card("A").locator('[data-type="car"]'));
    expect(await card("A").locator('[data-type="car"]').getAttribute("aria-checked") === "true", "car not selected");
    await tapIn(card("A").locator('[data-type="suv"]'));
  });
  await step("Direction picker updates the arrow and the caption", async () => {
    const a = card("A");
    await tapIn(a.locator('[data-compass] [data-h="90"]'));
    const rot = await a.locator("[data-dir-arrow]").evaluate((el) => el.style.rotate);
    const cap = await a.locator("[data-dir-caption]").innerText();
    expect(rot === "90deg", `arrow rotate ${rot}`);
    expect(/east on Maple Ave/i.test(cap), `caption "${cap}"`);
    return `arrow ${rot}; "${cap}"`;
  });
  await step("Every action works and changes the caption (straight, turning left/right, backing up, parked)", async () => {
    const a = card("A");
    const seen = [];
    for (const act of ["turn-left", "turn-right", "backing", "parked", "straight"]) {
      await tapIn(a.locator(`[data-action="${act}"]`));
      seen.push(await a.locator("[data-dir-caption]").innerText());
      if (act === "parked") expect(!(await a.locator("[data-speed-group]").isVisible()), "speed shown for parked");
    }
    expect(seen[2].includes("backing up"), `backing caption "${seen[2]}"`);
    return seen.join(" | ");
  });
  await step("Arrow keys move the choice inside a radio group (one tab stop per group)", async () => {
    const a = card("A");
    await a.locator('[data-compass] [aria-checked="true"]').focus();
    await page.keyboard.press("ArrowRight");
    const now = await a.locator('[data-compass] [aria-checked="true"]').getAttribute("data-h");
    const stops = await a.locator('[data-compass] [tabindex="0"]').count();
    await page.keyboard.press("ArrowLeft");
    expect(now !== "90" && stops === 1, `heading after arrow ${now}, tab stops ${stops}`);
    return `moved to ${now}°, back with ArrowLeft`;
  });
  await step("Speed stepper changes the speed", async () => {
    const a = card("A");
    await tapIn(a.locator('[data-speed="5"]'));
    expect((await a.locator("[data-speed-out]").innerText()) === "30", "speed not 30");
    await tapIn(a.locator('[data-speed="-5"]')); await tapIn(a.locator('[data-speed="5"]'));
  });
  await step("Impact zones select (A front right)", async () => {
    await tapIn(card("A").locator('[data-z="front-right"]'));
    expect(await card("A").locator('[data-z="front-right"]').getAttribute("aria-checked") === "true", "zone not selected");
  });
  await step("Vehicle B: Not sure + limit stepper + I don't know the limit", async () => {
    const b = card("B");
    await tapIn(b.locator('[data-compass] [data-h="90"]'));
    await tapIn(b.locator("[data-unsure]"));
    expect(await b.locator("[data-limit-row]").isVisible(), "limit row hidden");
    await tapIn(b.locator('[data-limit="5"]'));
    const r1 = await b.locator("[data-speed-out]").innerText();
    expect(r1 === "25–35", `range with limit 30: ${r1}`);
    await tapIn(b.locator("[data-nolimit]"));
    const r2 = await b.locator("[data-speed-out]").innerText();
    const note = await b.locator("[data-range-note]").innerText();
    expect(r2 === "20–30", `range with unknown limit: ${r2}`);
    expect(/typical city limit/.test(note), `note "${note}"`);
    return `${r1} → ${r2}; "${note}"`;
  });
  await step("Validation: same direction, neither hit in the rear, shows a plain warning instead of the picture", async () => {
    await tapIn(card("B").locator('[data-z="front"]'));
    await tapIn(page.locator("#to-review"));
    await page.waitForSelector("#vehicle-warnings:not([hidden])");
    const w = await text("#vehicle-warning-list");
    expect(/both going east/i.test(w) && /rear/i.test(w), `warning "${w}"`);
    expect(await page.locator("#screen-vehicles[data-active]").count() === 1, "left the vehicles step");
    return w;
  });
  await step("Validation: impossible zones (head-on marked as rear) are explained", async () => {
    await tapIn(card("B").locator('[data-compass] [data-h="270"]'));
    await tapIn(card("B").locator('[data-z="rear"]'));
    await page.waitForTimeout(200);
    const w = await text("#vehicle-warning-list");
    expect(/marked as hit on the rear/i.test(w), `warning "${w}"`);
    return w;
  });
  await step("Fixing the details clears the warning live", async () => {
    await tapIn(page.locator("#warn-fix"));
    await tapIn(card("B").locator('[data-compass] [data-h="90"]'));
    await tapIn(card("B").locator('[data-z="rear"]'));
    await page.waitForTimeout(200);
    expect(await page.locator("#vehicle-warnings").isHidden(), "warning still shown");
  });
  await step("No false warning when a 'Not sure' range covers the other vehicle's speed", async () => {
    await tapIn(card("A").locator('[data-speed="-5"]'));      // A 25 mph = middle of B's 20–30
    await page.waitForTimeout(200);
    const hidden = await page.locator("#vehicle-warnings").isHidden();
    await tapIn(card("A").locator('[data-speed="5"]'));
    expect(hidden, `warning shown: ${await text("#vehicle-warning-list")}`);
  });
  await step("Add another vehicle up to 4 (C and D colors), then remove both", async () => {
    await tapIn(page.locator("#add-vehicle"));
    await tapIn(page.locator("#add-vehicle"));
    expect(await page.locator(".vehicle").count() === 4, "not 4 vehicles");
    expect(await page.locator("#add-vehicle").isHidden(), "add button still shown at 4");
    const cColor = await card("C").locator(".badge-letter").evaluate((el) => getComputedStyle(el).backgroundColor);
    const dColor = await card("D").locator(".badge-letter").evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(cColor !== dColor, "C and D share a color");
    await tapIn(card("C").locator('[data-action="parked"]'));
    const opts = await card("A").locator("datalist option").count();
    expect(opts > 0 || /couldn't reach/i.test(await card("A").locator("[data-lookup]").innerText()), "A lost its model list when vehicles were added");
    await shot("vehicles-4");
    await tapIn(card("D").locator("[data-remove]"));
    await tapIn(card("C").locator("[data-remove]"));
    expect(await page.locator(".vehicle").count() === 2, "not back to 2");
    expect(await card("B").locator("[data-remove]").isHidden(), "remove shown with only 2");
    expect(await card("B").locator("[data-speed-out]").innerText() === "20–30", "B lost its state after removals");
    expect((await card("A").locator("datalist option").count()) > 0 || /couldn't reach/i.test(await card("A").locator("[data-lookup]").innerText()), "A lost its model list after removals");
    expect(await page.evaluate(() => document.activeElement?.id) === "add-vehicle", "focus not kept after remove");
    return `C ${cColor}, D ${dColor}`;
  });
  await step("Mini map shows each vehicle as a silhouette", async () => {
    await page.waitForFunction(() => document.querySelectorAll("#mini-map .veh-marker").length === 2, null, { timeout: 3000 }).catch(() => {});
    const n = await page.locator("#mini-map .veh-marker").count();
    expect(n === 2, `${n} markers`);
    return `${n} markers: ${(await page.locator("#mini-map .veh-marker b").allInnerTexts()).join(", ")}`;
  });
  await step("Sticky action bar doesn't cover the impact grid (phone)", async () => {
    if (!phone) return "desktop: not sticky";
    const zone = card("B").locator('[data-z="rear"]');
    await zone.scrollIntoViewIfNeeded();
    const z = await zone.boundingBox(), bar = await page.locator("#screen-vehicles .actions").boundingBox();
    expect(z.y + z.height <= bar.y, `zone bottom ${Math.round(z.y + z.height)} > bar top ${Math.round(bar.y)}`);
  });
  await page.locator("#toast-close").click().catch(() => {});
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  await shot("vehicles");
  await step("See the recreation goes to review", async () => {
    await tapIn(page.locator("#to-review"));
    await page.waitForSelector("#screen-review[data-active]");
  });

  /* ---------------- Step 3: review ---------------- */
  await page.waitForTimeout(400);
  await step("Review reads the shared state (A east 30 mph front right, B 20–30 mph rear, dry)", async () => {
    const s = await text("#tab-vehicles");
    for (const want of ["2019 Toyota RAV4", "Heading east on Maple Ave", "30 mph", "front right", "not sure, 20–30 mph", "dry road"]) {
      if (!s.includes(want) && !(want === "2019 Toyota RAV4" && s.includes("SUV"))) throw new Error(`summary missing "${want}"`);
    }
    return s.replace(/\s+/g, " ").slice(0, 160);
  });
  await step("Opens at the moment of impact with speeds at impact on the labels", async () => {
    expect((await text("#readout")) === "At impact", `readout ${await text("#readout")}`);
    const labels = await page.locator(".vlabel").allInnerTexts();
    expect(labels.some((l) => l.includes("30 mph")) && labels.some((l) => l.includes("~25 mph")), `labels ${labels.join(" / ")}`);
    return labels.join(" / ").replace(/\n/g, " ");
  });
  await shot("review");
  await step("Play runs to final rest; play at the end restarts from the beginning", async () => {
    await page.click("#play");
    await page.waitForFunction(() => document.querySelector("#readout").innerText === "Final rest", null, { timeout: 15000 });
    await page.click("#play");
    await page.waitForTimeout(150);
    const r = await text("#readout");
    expect(/before impact/.test(r), `after restart readout "${r}"`);
    await page.click("#play");
    return `restart readout "${r}"`;
  });
  await step("Timeline keyboard: Home, End, I, arrow keys", async () => {
    await page.focus("#track");
    await page.keyboard.press("Home"); const a = await text("#readout");
    await page.keyboard.press("End"); const b = await text("#readout");
    await page.keyboard.press("i"); const c = await text("#readout");
    await page.keyboard.press("ArrowRight"); const d = await text("#readout");
    await page.keyboard.press("i");
    expect(/before impact/.test(a) && b === "Final rest" && c === "At impact" && /0\.1 s after impact/.test(d), `${a} | ${b} | ${c} | ${d}`);
    return `${a} | ${b} | ${c} | ${d}`;
  });
  await step("Close and Wide views switch", async () => {
    await page.click('.view-controls [data-view="wide"]');
    expect(await page.locator('.view-controls [data-view="wide"]').getAttribute("aria-pressed") === "true", "wide not pressed");
    await page.click('.view-controls [data-view="near"]');
  });
  await step("Measure tab: values from the physics; pills on desktop, list on phones", async () => {
    await page.click("#t-measure");
    await page.locator("#sw-measure").check();
    await page.waitForTimeout(200);
    const pills = await page.locator("#measure-pills .mpill").count();
    const pillsVisible = pills > 0 && await page.locator("#measure-pills .mpill").first().isVisible();
    if (phone) expect(!pillsVisible, "pills shown on phone"); else expect(pills >= 3 && pillsVisible, `${pills} pills`);
    const rows = await page.locator("#measure-list > div").allInnerTexts();
    expect(rows.length >= 4 && rows.every((r) => /\d/.test(r)), `rows ${rows.join("|")}`);
    const wrapped = await page.locator("#measure-list dd .num").evaluateAll((els) => els.filter((e) => e.getClientRects().length > 1).length);
    expect(wrapped === 0, `${wrapped} values wrap`);
    await shot("review-measure");
    return rows.map((r) => r.replace(/\n/g, " ")).join(" | ");
  });
  const reviewRows = await page.locator("#measure-list > div").allInnerTexts();
  await step("View tab: labels and paths toggles, units switch to metric and back", async () => {
    await page.click("#t-view");
    await page.locator("#sw-labels").uncheck(); expect(await page.locator("#label-layer").isHidden(), "labels still shown");
    await page.locator("#sw-labels").check();
    await page.locator("#sw-paths").uncheck(); expect(await page.locator(".d-paths").count() === 0, "paths still drawn");
    await page.locator("#sw-paths").check();
    await page.locator('#units label', { hasText: "m · km/h" }).click();
    const l = await page.locator(".vlabel").allInnerTexts();
    expect(l.some((x) => x.includes("km/h")), `labels ${l.join("/")}`);
    await page.locator('#units label', { hasText: "ft · mph" }).click();
  });
  await step("Dark theme renders the review without errors", async () => {
    await page.click("#theme-toggle"); await page.waitForTimeout(200);
    await page.screenshot({ path: `${SHOTS}review-dark-${width}.png` });
    await page.click("#theme-toggle");
  });
  await step("'Looks right: save it' is reachable (phone: fixed in the bottom sheet)", async () => {
    const b = await page.locator("#to-export").boundingBox();
    expect(b && b.y + b.height <= (phone ? 844 : 900) + 1, `button at ${b && Math.round(b.y)}`);
    if (phone) {
      const tabs = await page.locator(".tabs").boundingBox();
      await page.locator(".tabs").scrollIntoViewIfNeeded();
      const t2 = await page.locator(".tabs").boundingBox(), f = await page.locator(".panel-foot").boundingBox();
      expect(t2.y + t2.height <= f.y, "tabs hidden under the button");
    }
    await page.click("#to-export");
    await page.waitForSelector("#screen-export[data-active]");
  });

  /* ---------------- Step 4: save ---------------- */
  await page.waitForTimeout(500);
  await step("Before saving, the time and fingerprint are not faked", async () => {
    const st = await text("#export-stamp");
    expect(/added to every file when you save/.test(st), `stamp "${st}"`);
    await shot("export");
  });
  await step("Preview tabs: PDF, diagram, scene file", async () => {
    await page.click('.preview-tabs [data-preview="png"]'); await page.waitForSelector("#preview-host .preview-box"); await shot("export-png");
    await page.click('.preview-tabs [data-preview="json"]'); await page.waitForSelector("#preview-host .json-preview");
    const j = await text("#preview-host .json-preview");
    expect(j.includes('"condition": "dry"') && j.includes('"heading": 90') && j.includes('"zone": "front-right"'), "JSON preview doesn't match state");
    await shot("export-json");
    await page.click('.preview-tabs [data-preview="pdf"]');
  });
  let fp = null, saved = {};
  await step("Save downloads the scene file and the diagram PNG, stamped with the real time", async () => {
    await page.locator('input[name="fmt"][value="json"]').check();
    const t0 = Date.now();
    const downloads = [];
    page.on("download", (d) => downloads.push(d));
    await page.click("#save-btn");
    await page.waitForFunction(() => /Saved/.test(document.querySelector("#export-stamp").innerText), null, { timeout: 10000 });
    await page.waitForTimeout(1500);
    for (const d of downloads) { const p = `${dir}${d.suggestedFilename()}`; await d.saveAs(p); saved[d.suggestedFilename().endsWith(".json") ? "json" : "png"] = p; }
    expect(saved.json && saved.png, `downloads: ${Object.keys(saved).join(",")}`);
    const json = await readFile(saved.json, "utf8");
    const hash = createHash("sha256").update(json).digest("hex");
    fp = hash.slice(0, 16).match(/.{4}/g).join(" ");
    const scene = JSON.parse(json);
    const age = Date.now() - Date.parse(scene.createdAt);
    expect(age >= -2000 && Date.parse(scene.createdAt) >= t0 - 2000 && age < 60000, `createdAt ${scene.createdAt}`);
    const st = await text("#export-stamp");
    expect(st.includes(fp), `stamp "${st}" lacks ${fp}`);
    expect(scene.disclaimer && scene.vehicles[0].heading === 90 && scene.road.condition === "dry", "scene file doesn't match state");
    const png = await readFile(saved.png);
    const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
    expect(w === 1600 && h === 1600, `png ${w}×${h}`);
    return `fingerprint ${fp}; createdAt ${scene.createdAt}; PNG ${w}×${h}`;
  });
  await step("Toast sits clear of the save button and goes away on other screens", async () => {
    const t = await page.locator("#toast").boundingBox(), b = await page.locator("#save-btn").boundingBox();
    expect(t && !(t.x < b.x + b.width && b.x < t.x + t.width && t.y < b.y + b.height && b.y < t.y + t.height), "toast overlaps save");
    await page.goto(`${BASE}#review`);
    expect(await page.locator("#toast").isHidden(), "toast followed to review");
    await page.goto(`${BASE}#export`);
  });
  await step("PDF page matches the state and fits on one US Letter page", async () => {
    await page.goto(`${BASE}#pdf`);
    await page.waitForTimeout(800);
    const t = await text("#pdf-page");
    for (const want of ["Times Square", "Maple Ave", "40.", "Road dry, as entered: friction 0.7", "20–30 mph", "30 mph", "Front right", "Rear", fp, "local time"]) expect(t.includes(want), `PDF missing "${want}"`);
    const fit = await page.evaluate(() => { const p = document.querySelector("#pdf-page").getBoundingClientRect(); const pad = parseFloat(getComputedStyle(document.querySelector("#pdf-page")).paddingBottom); const last = [...document.querySelectorAll("#pdf-page .pdf-foot > *")].pop().getBoundingClientRect(); return Math.round(p.bottom - pad - last.bottom); });
    expect(fit >= 0, `PDF content runs ${-fit}px past the page margin`);
    for (const r of reviewRows) {
      const [label, val] = r.split("\n").map((x) => x.trim()).filter(Boolean).slice(-2);
      const ft = val.split(" / ")[0];
      expect(t.includes(ft), `PDF lacks review value "${label}: ${ft}"`);
    }
    await page.screenshot({ path: `${SHOTS}pdf-${width}.png`, fullPage: true });
    if (!phone) {
      const pdf = await page.pdf({ format: "Letter", printBackground: true, preferCSSPageSize: true });
      await writeFile(`${dir}crash-scene-CLM-2419.pdf`, pdf);
      const pages = (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length;
      expect(pages === 1, `${pages} pages`);
      return `1 page, ${Math.round(pdf.length / 1024)} KB, review values all present`;
    }
    return "review values all present";
  });
  await step("Diagram page carries the disclaimer, fingerprint and time", async () => {
    await page.goto(`${BASE}#png`);
    await page.waitForTimeout(800);
    const t = await text("#png-page");
    expect(t.includes(fp) && /Illustration only/.test(t), "missing fingerprint or disclaimer");
    await page.locator("#png-page").screenshot({ path: `${SHOTS}png-${width}.png` });
  });
  await step("Changing the scene after saving marks the export as out of date", async () => {
    await page.goto(`${BASE}#location`);
    await tapIn(page.locator("#road-tiles .tile", { hasText: "Wet" }));
    await page.goto(`${BASE}#export`);
    await page.waitForTimeout(300);
    const st = await text("#export-stamp");
    expect(/changed the scene after saving/.test(st), `stamp "${st}"`);
    await page.goto(`${BASE}#location`);
    await tapIn(page.locator("#road-tiles .tile", { hasText: "Dry" }));
  });

  await step("Four vehicles with warnings still fit the PDF on one page (auto-fit)", async () => {
    await page.goto(`${BASE}#vehicles`);
    await tapIn(page.locator("#add-vehicle")); await tapIn(page.locator("#add-vehicle"));
    await tapIn(card("C").locator('[data-action="parked"]'));
    await tapIn(card("D").locator('[data-type="truck"]'));
    await page.goto(`${BASE}#pdf`);
    await page.waitForTimeout(900);
    const fit = await page.evaluate(() => { const p = document.querySelector("#pdf-page"); const pad = parseFloat(getComputedStyle(p).paddingBottom); const last = [...p.querySelectorAll(".pdf-foot > *")].pop().getBoundingClientRect(); return { gap: Math.round(p.getBoundingClientRect().bottom - pad - last.bottom), level: p.dataset.fit || "none", rows: p.querySelectorAll("tbody tr").length }; });
    expect(fit.rows === 4 && fit.gap >= 0, `rows ${fit.rows}, footer overflow ${-fit.gap}px`);
    await page.screenshot({ path: `${SHOTS}pdf-4-vehicles-${width}.png`, fullPage: true });
    if (!phone) {
      const pdf = await page.pdf({ format: "Letter", printBackground: true, preferCSSPageSize: true });
      const pages = (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length;
      expect(pages === 1, `${pages} pages`);
    }
    return `fit level ${fit.level}, ${fit.gap}px to spare`;
  });
  await step("Opening the saved scene file rebuilds the same scene", async () => {
    await page.goto(`${BASE}#export`);
    await page.setInputFiles("#open-scene", saved.json);
    await page.waitForSelector("#screen-review[data-active]");
    await page.waitForFunction(() => /^Opened/.test(document.querySelector("#toast-text").textContent), null, { timeout: 5000 });
    const n = await page.evaluate(() => JSON.parse(sessionStorage.getItem("crash-scene-3d/scene/v2")).vehicles.length);
    const toastText = await text("#toast-text");
    expect(n === 2 && toastText.includes(fp), `vehicles ${n}, toast "${toastText}"`);
    const s = await text("#tab-vehicles");
    expect(s.includes("Heading east") && s.includes("not sure, 20–30 mph"), "reopened scene differs");
    return toastText;
  });

  /* ---------------- Policy checks ---------------- */
  await step("Nominatim: at most 1 request per second, address text only", async () => {
    const gaps = nominatimAt.slice(1).map((r, i) => r.t - nominatimAt[i].t);
    expect(gaps.every((g) => g >= 990), `gaps ${gaps.join(",")} ms`);
    expect(nominatimAt.every((r) => r.params === "addressdetails,format,limit,q"), `params ${nominatimAt.map((r) => r.params).join(" | ")}`);
    return `${nominatimAt.length} requests, gaps ${gaps.map((g) => `${g} ms`).join(", ") || "n/a"}`;
  });
  await step("Network: only allowed hosts", async () => {
    const bad = [...hosts].filter((h) => !ALLOWED.includes(h));
    expect(!bad.length, `unexpected hosts ${bad.join(", ")}`);
    return [...hosts].join(", ");
  });
  await step("No console errors", async () => { expect(!errors.length, errors.slice(0, 3).join(" | ")); });

  const video = page.video();
  await ctx.close();
  if (video) { const p = await video.path(); await rename(p, `${dir}walkthrough-${width}.webm`); }
  report.push({ width, results });
}
await browser.close();

let md = `# Prototype walkthrough\n\nRun: ${new Date().toISOString()}\n`;
for (const r of report) {
  const pass = r.results.filter((x) => x.ok).length;
  md += `\n## ${r.width}px — ${pass}/${r.results.length} passed\n\n| | Check | Detail |\n|---|---|---|\n`;
  for (const x of r.results) md += `| ${x.ok ? "PASS" : "**FAIL**"} | ${x.name} | ${x.note.replace(/\|/g, "/").replace(/\n/g, " ").slice(0, 220)} |\n`;
}
await writeFile(`${OUT}report.md`, md);
console.log(md);
process.exit(report.every((r) => r.results.every((x) => x.ok)) ? 0 : 1);
