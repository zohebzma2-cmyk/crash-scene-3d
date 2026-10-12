// Writes apps/web/test/fixtures/media/car.webp: the synthetic car.png (scripts/make-media-fixtures.mjs) encoded as
// WebP, as production photos come (CarImages' free plan is WebP only). Node has no WebP encoder, so Chromium's own
// canvas encoder does it (Playwright, already a dev dependency). Synthetic content only (CLAUDE.md hard rule 1).
// Run: node scripts/make-media-webp.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const DIR = fileURLToPath(new URL("../apps/web/test/fixtures/media/", import.meta.url));
const png = readFileSync(`${DIR}car.png`).toString("base64");

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const dataUrl = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const cv = document.createElement("canvas");
    cv.width = img.naturalWidth;
    cv.height = img.naturalHeight;
    cv.getContext("2d").drawImage(img, 0, 0);
    return cv.toDataURL("image/webp", 0.9);
  }, png);
  if (!dataUrl.startsWith("data:image/webp;base64,")) throw new Error("this Chromium did not encode WebP");
  const bytes = Buffer.from(dataUrl.split(",")[1], "base64");
  if (bytes.subarray(0, 4).toString() !== "RIFF" || bytes.subarray(8, 12).toString() !== "WEBP") throw new Error("not a WebP");
  writeFileSync(`${DIR}car.webp`, bytes);
  console.log(`car.webp: ${bytes.length} bytes`);
} finally {
  await browser.close();
}
