// Builds design/icons/*.svg, the prototype's inline sprite (icons.svg),
// and design/icons/sheet.png from design/icons/icons.json.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const root = new URL("../../", import.meta.url);
const spec = JSON.parse(await readFile(new URL("icons/icons.json", root), "utf8"));
const ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
await mkdir(new URL("icons/", root), { recursive: true });

const symbols = [];
const cells = [];
for (const [group, icons] of Object.entries(spec.groups)) {
  cells.push(`<h2>${group}</h2><div class="grid">`);
  for (const [name, inner] of Object.entries(icons)) {
    const file = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" ${ATTRS}>${inner}</svg>\n`;
    await writeFile(new URL(`icons/${name}.svg`, root), file);
    symbols.push(`<symbol id="i-${name}" ${ATTRS}>${inner}</symbol>`);
    cells.push(`<figure><div class="tile"><svg ${ATTRS} width="48" height="48">${inner}</svg><svg ${ATTRS} width="24" height="24">${inner}</svg></div><figcaption>${name}</figcaption></figure>`);
  }
  cells.push(`</div>`);
}
const sprite = `<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden"><defs>${symbols.join("")}</defs></svg>\n`;
await writeFile(new URL("prototype/icons.svg", root), sprite);

const tokens = await readFile(new URL("tokens.css", root), "utf8");
const html = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@500;700&display=swap"><style>${tokens}
:root{color-scheme:light} body{margin:0;padding:var(--space-8);background:var(--color-surface);font-family:var(--font-sans);color:var(--color-text);width:1100px}
h2{font-size:var(--text-sm);font-weight:var(--weight-bold);margin:var(--space-6) 0 var(--space-3);color:var(--color-text-secondary)}
.grid{display:grid;grid-template-columns:repeat(8,1fr);gap:var(--space-3)}
figure{margin:0;display:flex;flex-direction:column;align-items:center;gap:var(--space-2)}
.tile{display:flex;align-items:center;justify-content:center;gap:var(--space-4);width:100%;padding:var(--space-4) 0;border:1px solid var(--color-border);border-radius:var(--radius-sm);color:var(--color-text);background-image:linear-gradient(var(--color-surface-2) 1px,transparent 1px),linear-gradient(90deg,var(--color-surface-2) 1px,transparent 1px);background-size:6px 6px}
figcaption{font-size:var(--text-xs);color:var(--color-text-secondary)}</style>
<h1 style="font-size:var(--text-xl);margin:0">crash-scene-3d icons · 24px grid · 2px stroke</h1>${cells.join("")}`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1170, height: 800 }, deviceScaleFactor: 2 });
await page.setContent(html, { waitUntil: "networkidle" });
await page.screenshot({ path: new URL("icons/sheet.png", root).pathname, fullPage: true });
await browser.close();
console.log(`${symbols.length} icons → design/icons/*.svg, prototype/icons.svg, icons/sheet.png`);
