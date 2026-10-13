// Offline headless conversion of our authored SVGs to shared vector strokes for PDF/PNG/3D.
import { chromium } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
const spec = JSON.parse(await readFile("design/icons/icons.json", "utf8"));
const groups = ["Road features", "Lighting, weather and visibility", "Optional vehicle answers"];
const icons = Object.assign({}, ...groups.map((g) => spec.groups[g]));
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.route("**/*", (route) => route.abort());
  const geometry = {};
  for (const [name, markup] of Object.entries(icons)) {
    await page.setContent(`<svg xmlns="http://www.w3.org/2000/svg">${markup}</svg>`);
    geometry[name] = await page.evaluate(() => [...document.querySelectorAll("svg > *")].flatMap((el) => {
      // Separate subpaths before sampling so disconnected strokes never acquire connecting lines.
      const paths = el.tagName === "path" ? (el.getAttribute("d") ?? "").match(/[Mm][^Mm]*/g) ?? [] : [];
      const shapes = paths.length ? paths.map((d) => { const p = document.createElementNS("http://www.w3.org/2000/svg", "path"); p.setAttribute("d", d); return p; }) : [el];
      // Relative moveto subpaths need the previous current point. All our authored paths use absolute M
      // for distinct subpaths (relative m is normalised below by sampling the original path instead).
      if (paths.some((d) => d.startsWith("m"))) return [sample(el)];
      return shapes.map(sample);
      function sample(shape) {
        const length = shape.getTotalLength(), n = Math.max(1, Math.ceil(length / 0.4));
        return Array.from({ length: n + 1 }, (_, i) => { const p = shape.getPointAtLength(length * i / n); return [Number(p.x.toFixed(3)), Number(p.y.toFixed(3))]; });
      }
    }));
  }
  await writeFile("design/icons/feature-geometry.json", JSON.stringify(geometry));
} finally { await browser.close(); }
