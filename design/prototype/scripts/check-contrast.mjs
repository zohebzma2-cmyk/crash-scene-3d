// WCAG contrast for every text/background pair the design uses, light and dark.
import { readFile } from "node:fs/promises";
const css = await readFile(new URL("../../tokens.css", import.meta.url), "utf8");
const tok = {};
for (const m of css.matchAll(/--([\w-]+):\s*([^;]+);/g)) tok[m[1]] = m[2].trim();
const pick = (name, mode) => {
  const v = tok[name]; const ld = v.match(/light-dark\(\s*(#[0-9A-Fa-f]{6})\s*,\s*(#[0-9A-Fa-f]{6})\s*\)/);
  return ld ? ld[mode === "light" ? 1 : 2] : v;
};
const lum = (hex) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const PAIRS = [
  ["color-text", "color-bg", 4.5], ["color-text", "color-surface", 4.5], ["color-text-secondary", "color-bg", 4.5],
  ["color-text-secondary", "color-surface", 4.5], ["color-text-tertiary", "color-surface", 4.5], ["color-text-tertiary", "color-surface-2", 4.5],
  ["color-text-on-brand", "color-brand", 4.5], ["color-text-on-brand", "color-brand-hover", 4.5], ["color-text-link", "color-surface", 4.5],
  ["color-brand", "color-surface", 4.5], ["color-brand-tint-text", "color-brand-tint", 4.5], ["color-warning-tint-text", "color-warning-tint", 4.5],
  ["color-success-text", "color-surface", 4.5], ["color-warning-text", "color-surface", 4.5], ["color-danger-text", "color-surface", 4.5],
  ["color-text-on-brand", "color-vehicle-a", 4.5], ["color-text-on-brand", "color-vehicle-b", 4.5], ["color-text-on-brand", "color-vehicle-c", 4.5], ["color-text-on-brand", "color-vehicle-d", 4.5],
  ["color-vehicle-a", "color-surface", 3], ["color-vehicle-b", "color-surface", 3], ["color-vehicle-c", "color-surface", 3], ["color-vehicle-d", "color-surface", 3],
  ["color-scene-measure", "color-scene-ground", 4.5], ["color-focus-ring", "color-surface", 3], ["color-text-secondary", "color-surface-2", 4.5],
  ["color-logo", "color-surface", 3], ["color-logo", "color-bg", 3],
];
let bad = 0;
for (const mode of ["light", "dark"]) for (const [fg, bg, min] of PAIRS) {
  const r = ratio(pick(fg, mode), pick(bg, mode));
  const ok = r >= min; if (!ok) bad++;
  if (!ok || process.argv.includes("-v")) console.log(`${ok ? "ok  " : "FAIL"} ${mode.padEnd(5)} ${fg} on ${bg}: ${r.toFixed(2)} (min ${min})`);
}
console.log(bad ? `${bad} pair(s) fail` : `contrast: all ${PAIRS.length * 2} pairs pass`);
process.exit(bad ? 1 : 0);
