// Renders each prototype screen and writes it as a static Claude Design
// artboard (.dc.html) that links the same tokens.css and styles.css.
// Usage: node scripts/build-canvas.mjs <outRoot>
import { chromium } from "playwright";
import { mkdir, writeFile, copyFile } from "node:fs/promises";
import { join } from "node:path";

const out = join(process.argv[2], "project");
await mkdir(out, { recursive: true });
const BASE = "http://localhost:5180/prototype/";
await copyFile(new URL("../../tokens.css", import.meta.url), join(out, "tokens.css"));
await copyFile(new URL("../styles.css", import.meta.url), join(out, "styles.css"));
await copyFile(new URL("../node_modules/leaflet/dist/leaflet.css", import.meta.url), join(out, "leaflet.css"));
// The scene the walkthrough saved: a filled-in claim to show in the frames.
import { readFile as rf } from "node:fs/promises";
const saved = JSON.parse(await rf(new URL("../recordings/1440/crash-scene-CLM-2419.json", import.meta.url), "utf8"));
delete saved.createdAt; delete saved.disclaimer;
saved.location = { ...saved.location, query: "Times Square, New York", autoSearched: true };
const KEY = "crash-scene-3d/scene/v2";

const FRAMES = [
  // file, title, route, width, kind
  ["Main.dc.html",                "Location · desktop",               "location",       1440, "app"],
  ["Location-390.dc.html",        "Location · mobile",                "location",       390,  "app"],
  ["NoResults-1440.dc.html",      "No results, drop a pin · desktop", "location", 1440, "app", "fresh"],
  ["NoResults-390.dc.html",       "No results, drop a pin · mobile",  "location", 390,  "app", "fresh"],
  ["Vehicles-1440.dc.html",       "Vehicles · desktop",               "vehicles",       1440, "app"],
  ["Vehicles-390.dc.html",        "Vehicles · mobile",                "vehicles",       390,  "app"],
  ["Viewer-1440.dc.html",         "Review · desktop",                 "review", 1440, "app"],
  ["Viewer-390.dc.html",          "Review · mobile",                  "review", 390,  "app"],
  ["Export-1440.dc.html",         "Export · desktop",                 "export",         1440, "app"],
  ["Export-390.dc.html",          "Export · mobile",                  "export",         390,  "app"],
  ["PDF-Letter.dc.html",          "PDF summary · US Letter",          "pdf",            1000, "pdf"],
  ["PNG-TopDown.dc.html",         "Top-down PNG · 1600 × 1600",       "png",            1700, "png"],
];

const browser = await chromium.launch();
const boards = {};
for (const [file, title, route, width, kind, fresh] of FRAMES) {
  const page = await browser.newPage({ viewport: { width, height: width < 500 ? 844 : 900 }, reducedMotion: "reduce", userAgent: "InsurifyAI-CrashScene-Prototype/0.1 (+https://insurifyai.app; design frames)" });
  // The first-visit welcome (DESIGN.md section 19) is seen already, so the frames show the screens.
  await page.addInitScript(() => { try { localStorage.setItem("csd.welcome.v1", JSON.stringify({ seen: true })); } catch { /* blocked */ } });
  await page.goto(BASE);
  await page.evaluate(([k, v, f]) => { sessionStorage.clear(); if (!f) sessionStorage.setItem(k, v); }, [KEY, JSON.stringify(saved), !!fresh]);
  await page.goto(`${BASE}#${route}`);
  await page.waitForTimeout(route === "location" ? 3500 : 1200);
  if (route === "review") { await page.click("#t-measure"); await page.locator("#sw-measure").check(); await page.waitForTimeout(300); }
  await page.evaluate(() => document.fonts.ready);
  // Canvas artboards can't load third-party images: swap live map tiles and data images for a labeled placeholder.
  await page.evaluate(() => {
    document.querySelectorAll("img.leaflet-tile, img[src^='data:'], img[src^='blob:']").forEach((img) => img.remove());
    document.querySelectorAll(".map, .pdf-fig").forEach((m) => {
      if (m.querySelector(".diagram-host")) return;
      const n = document.createElement("p");
      n.className = "map-empty";
      n.textContent = "Map tiles (OpenStreetMap) load live in the prototype";
      m.append(n);
    });
  });
  const { body, w, h } = await page.evaluate((kind) => {
    const sprite = document.querySelector("body > svg").outerHTML;
    let node, w, h;
    if (kind === "app") {
      node = document.querySelector("#app").cloneNode(true);
      node.querySelectorAll(".screen:not([data-active]), #toast").forEach((s) => s.remove());
      node.querySelector("#theme-toggle")?.remove();
      w = document.documentElement.clientWidth;
      h = Math.max(document.documentElement.scrollHeight, window.innerHeight);
    } else {
      const el = document.querySelector(kind === "pdf" ? "#pdf-page" : "#png-page");
      node = el.cloneNode(true);
      w = el.offsetWidth; h = el.offsetHeight;
    }
    node.querySelectorAll("[hidden]").forEach((n) => n.remove());
    return { body: sprite + node.outerHTML, w, h };
  }, kind);
  const preview = { width: w, height: h };
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
<script src="./support.js"></script>
<link rel="stylesheet" href="tokens.css">
<link rel="stylesheet" href="leaflet.css">
<link rel="stylesheet" href="styles.css">
</head>
<body>
<x-dc>
<helmet>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&amp;family=JetBrains+Mono:wght@400;500;600&amp;display=swap">
<style>body{margin:0}</style>
</helmet>
<div style="${kind === "app" ? "width: 100%; min-height: 100%;" : `width: ${w}px; height: ${h}px;`} background: var(--color-bg); font-family: var(--font-sans); color: var(--color-text)">
${body}
</div>
</x-dc>
<script type="text/x-dc" data-dc-script data-props='{"$preview":{"width":${w},"height":${h}}}'>
class Component extends DCLogic {
  renderVals() { return {}; }
}
</script>
</body>
</html>
`;
  await writeFile(join(out, file), html);
  boards[file] = { title, w, h, kind };
  console.log(`${file} ${w}×${h}`);
  await page.close();
}
await browser.close();

// Layout: desktop row, mobile row, export row.
const order = FRAMES.map((f) => f[0]);
const desktop = order.filter((f) => boards[f].kind === "app" && boards[f].w > 500);
const mobile = order.filter((f) => boards[f].kind === "app" && boards[f].w <= 500);
const exportsRow = order.filter((f) => boards[f].kind !== "app");
const layout = {};
let y = 0;
const notes = {};
const placeRow = (files, label, id) => {
  notes[id] = { x: 0, y, text: label, kind: "title1", maxW: 6000 };
  y += 260;
  let x = 0, rowH = 0;
  for (const f of files) {
    const b = boards[f];
    layout[f] = { x, y, w: b.w, h: b.h, title: b.title, ...(b.kind === "app" ? { expand: "fill" } : {}) };
    x += b.w + 80; rowH = Math.max(rowH, b.h);
  }
  y += rowH + 160;
};
placeRow(desktop, "Desktop · 1440", "row-desktop");
placeRow(mobile, "Mobile · 390", "row-mobile");
placeRow(exportsRow, "Exports · PDF and PNG", "row-exports");
notes["readme"] = { x: -1100, y: 0, w: 900, maxH: 1400, fill: "blue", size: "l", text:
  "crash-scene-3d — InsurifyAI\n\nFrames are captured from the clickable prototype after a recorded walkthrough. Numbers come from the prototype physics for that sample scene; the app computes its own (DESIGN.md section 14). Live map tiles are replaced by a placeholder here.\n\nBuilt only from design/tokens.css (DESIGN.md section 2) and the prototype stylesheet in the repo.\n\nThe claim is made up; the sample place is a public landmark found with live search. The 3D view is a top-down diagram until 3D is built.\n\nComing next (designed, not built): video clip and share link — see the Export frames.\n\nComment on any frame." };

const createdAt = process.env.CANVAS_CREATED_AT || new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const canvas = { v: 3, createdOnFiles: { v: 1, at: createdAt }, title: "crash-scene-3d — InsurifyAI", launch: { view: "canvas" }, pages: [], boards: layout, order, notes, designSystems: [] };
await writeFile(join(out, "canvas.json"), JSON.stringify(canvas, null, 2));
console.log("canvas.json written");
