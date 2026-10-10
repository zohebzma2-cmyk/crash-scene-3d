// Copies design/tokens.css into DESIGN.md section 2 (the css block).
import { readFile, writeFile } from "node:fs/promises";
const repo = new URL("../../../", import.meta.url);
const css = (await readFile(new URL("design/tokens.css", repo), "utf8")).trimEnd();
const mdUrl = new URL("DESIGN.md", repo);
const md = await readFile(mdUrl, "utf8");
const out = md.replace(/(## 2\. Design tokens[\s\S]*?```css\n)[\s\S]*?(\n```)/, (_, a, b) => a + css + b);
await writeFile(mdUrl, out);
console.log("DESIGN.md section 2 updated from design/tokens.css");
