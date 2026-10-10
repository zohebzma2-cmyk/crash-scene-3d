// Fails on hard-coded design values in the prototype's CSS, HTML style
// attributes and JS. Allowed: tokens.css itself, SVG geometry attributes,
// media-query breakpoints (CSS can't read variables there).
import { readFile } from "node:fs/promises";
const dir = new URL("../", import.meta.url);
import { readdir } from "node:fs/promises";
const files = ["styles.css", "index.html", ...(await readdir(new URL("../src/", import.meta.url))).filter((f) => f.endsWith(".js")).map((f) => `src/${f}`)];
const rules = [
  [/#[0-9a-fA-F]{3,8}\b(?![-\w])/g, "hex color"],
  [/\b(?:rgb|rgba|hsl|hsla|oklch)\(/g, "color function"],
  [/(?<![\w.-])\d*\.?\d+(?:px|rem|em|pt|in|deg|ms)\b/g, "length/angle/time literal"],
  [/stroke-width:\s*\d/g, "unitless stroke width"],
];
let bad = 0;
for (const f of files) {
  const lines = (await readFile(new URL(f, dir), "utf8")).split("\n");
  lines.forEach((line, i) => {
    let scan = line;
    if (f === "index.html") {
      // only inspect style="" attributes in HTML; SVG geometry is data
      scan = (line.match(/style="[^"]*"/g) || []).join(" ");
    }
    if (f.endsWith(".js")) {
      // only inspect string literals that set styles
      scan = (line.match(/style\.[a-zA-Z]+\s*=\s*`[^`]*`|style\.[a-zA-Z]+\s*=\s*"[^"]*"/g) || []).join(" ").replace(/\$\{[^}]*\}(px|%)/g, "");
    }
    if (/^\s*@media/.test(line)) return;
    for (const [re, what] of rules) {
      for (const m of scan.matchAll(re)) {
        if (what === "hex color" && /href="#|use href|#i-/.test(scan.slice(Math.max(0, m.index - 12), m.index + 1))) continue;
        console.error(`${f}:${i + 1}: ${what} "${m[0]}" → use a token`);
        bad++;
      }
    }
  });
}
if (bad) { console.error(`${bad} hard-coded value(s)`); process.exit(1); }
console.log("literals: none outside tokens.css");
