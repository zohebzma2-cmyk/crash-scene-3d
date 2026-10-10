// Fails if DESIGN.md's token block differs from design/tokens.css.
import { readFile } from "node:fs/promises";
const repo = new URL("../../../", import.meta.url);
const css = (await readFile(new URL("design/tokens.css", repo), "utf8")).trimEnd();
const md = await readFile(new URL("DESIGN.md", repo), "utf8");
const block = md.match(/## 2\. Design tokens[\s\S]*?```css\n([\s\S]*?)\n```/);
if (!block) { console.error("No css block in DESIGN.md section 2"); process.exit(1); }
if (block[1].trimEnd() !== css) {
  const a = block[1].split("\n"), b = css.split("\n");
  const i = a.findIndex((l, n) => l !== b[n]);
  console.error(`DESIGN.md tokens differ from design/tokens.css at line ${i + 1}:\n  DESIGN.md: ${a[i]}\n  tokens.css: ${b[i]}`);
  process.exit(1);
}
console.log("tokens: DESIGN.md matches design/tokens.css");
