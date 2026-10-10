// Usage: node scripts/sheet.mjs out.png "Title A" a.png "Title B" b.png ...
// Lays images side by side with captions (used for reviews and brand compare).
import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const [out, ...rest] = process.argv.slice(2);
const items = [];
for (let i = 0; i < rest.length; i += 2) items.push({ title: rest[i], file: resolve(rest[i + 1]) });
const imgs = await Promise.all(items.map(async (it) => ({ ...it, data: (await readFile(it.file)).toString("base64") })));
const html = `<!doctype html><meta charset="utf-8"><body style="margin:0;padding:24px;background:#e5e7eb;font:600 15px system-ui">
<div style="display:flex;gap:24px;align-items:flex-start">${imgs.map((i) => `<figure style="margin:0;display:flex;flex-direction:column;gap:8px"><figcaption>${i.title.replace(/</g, "&lt;")}</figcaption><img style="max-width:${Math.floor(2400 / imgs.length)}px;border:1px solid #9ca3af;background:#fff" src="data:image/png;base64,${i.data}"></figure>`).join("")}</div></body>`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 2500, height: 800 } });
await page.setContent(html);
await page.screenshot({ path: resolve(out), fullPage: true });
await browser.close();
console.log(resolve(out));
