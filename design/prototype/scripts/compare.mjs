// Brand match check: reads computed styles from matching elements on
// insurifyai.app's PUBLIC pages and on this prototype, writes a diff table
// and side-by-side crops to design/compare/ (gitignored, local only).
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";

const OUT = new URL("../../compare/", import.meta.url);
await mkdir(OUT, { recursive: true });
const OURS = process.env.BASE || "http://localhost:5180/prototype/";
const PROPS = ["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "color", "backgroundColor", "borderTopColor", "borderTopWidth", "borderRadius", "paddingTop", "paddingLeft", "boxShadow", "height", "textTransform"];

// [component, their page, their locator, our hash, our selector]
const PAIRS = [
  ["Header",          "home",   "nav >> nth=0",                                      "location", ".app-header"],
  ["Primary button (hero)", "home", "a:has-text('Upload your insurer') >> nth=0",    "location", "#to-vehicles"],
  ["Text input",      "signin", "input[name='identifier']",                          "location", "#q"],
  ["Card",            "signin", ".cl-card >> nth=0",                                 "vehicles", ".vehicle >> nth=0"],
  ["Section heading", "home",   "h2 >> nth=0",                                       "location", ".title"],
  ["Body text",       "home",   "p:has-text('Claim outcomes and customer reviews')", "location", ".lede"],
  ["Small print",     "home",   "p:has-text('Individual results vary')",             "location", ".hint >> nth=0"],
];
const THEIRS = { home: "https://insurifyai.app/", signin: "https://insurifyai.app/sign-in" };

const browser = await chromium.launch();
const rows = [];
for (const width of [1440, 390]) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 2, reducedMotion: "reduce" });
  const pages = {};
  for (const [k, url] of Object.entries(THEIRS)) {
    pages[k] = await ctx.newPage();
    await pages[k].goto(url, { waitUntil: "networkidle" });
    await pages[k].evaluate(() => document.fonts.ready);
  }
  const ours = await ctx.newPage();
  for (const [name, theirPage, theirSel, hash, ourSel] of PAIRS) {
    await ours.goto(`${OURS}#${hash}`);
    await ours.waitForTimeout(1200);
    await ours.evaluate(() => document.fonts.ready);
    const read = async (page, sel) => {
      const loc = page.locator(sel).first();
      if (!(await loc.count())) return null;
      await loc.scrollIntoViewIfNeeded().catch(() => {});
      const styles = await loc.evaluate((el, props) => {
        const cs = getComputedStyle(el);
        return Object.fromEntries(props.map((p) => [p, cs[p]]));
      }, PROPS);
      return { styles, loc };
    };
    const a = await read(pages[theirPage], theirSel);
    const b = await read(ours, ourSel);
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    if (a) await a.loc.screenshot({ path: new URL(`${slug}-${width}-theirs.png`, OUT).pathname }).catch(() => {});
    if (b) await b.loc.screenshot({ path: new URL(`${slug}-${width}-ours.png`, OUT).pathname }).catch(() => {});
    for (const p of PROPS) {
      const va = a?.styles[p] ?? "(not found)", vb = b?.styles[p] ?? "(not found)";
      rows.push({ width, name, prop: p, theirs: va, ours: vb, same: va === vb });
    }
  }
  // full-screen pairs for the side-by-side
  await pages.signin.screenshot({ path: new URL(`screen-signin-${width}-theirs.png`, OUT).pathname });
  await pages.home.screenshot({ path: new URL(`screen-home-${width}-theirs.png`, OUT).pathname });
  await ours.goto(`${OURS}#location`);
  await ours.waitForTimeout(1500);
  await ours.screenshot({ path: new URL(`screen-location-${width}-ours.png`, OUT).pathname });
  await ctx.close();
}
await browser.close();
await writeFile(new URL("styles.json", OUT), JSON.stringify(rows, null, 2));
const diffs = rows.filter((r) => !r.same && r.width === 1440);
console.log(`${diffs.length} differing properties at 1440 (of ${rows.filter((r) => r.width === 1440).length})`);
for (const r of diffs) console.log(`${r.name} | ${r.prop} | theirs: ${r.theirs} | ours: ${r.ours}`);
