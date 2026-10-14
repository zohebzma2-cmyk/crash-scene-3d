#!/usr/bin/env node
// The link-preview picture (og:image / twitter:image in apps/web/index.html): apps/web/public/og.png, 1200 x 630.
// It is the T-bone example on the Review step in fixtures mode (our own vehicle models, no catalog media), in a
// 1440 x 756 window (the 1200:630 shape), where Review fits whole: the header, the "Illustration only" bar, the stepper,
// the 3D picture with its timeline and the side panel. Taken at 2x and scaled down so it stays sharp. Made-up example
// data on public Nashua streets only.
//
//   node scripts/build-og-image.mjs              builds with VITE_FIXTURES=1 first
//   node scripts/build-og-image.mjs --no-build   reuses apps/web/dist from an earlier `VITE_FIXTURES=1 npm run build`
//
// Serves on OG_PORT (default 4523) and stops that server by its own PID. A test checks the file is a 1200 x 630 PNG.
import { chromium } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.OG_PORT ?? 4523);
const BASE = `http://localhost:${PORT}`;
const OUT = join(root, "apps/web/public/og.png");
const OG_SIZE = { width: 1200, height: 630 };
const VIEW = { width: 1440, height: Math.round((1440 * OG_SIZE.height) / OG_SIZE.width) };
const SCALE = 2;

if (!process.argv.includes("--no-build")) {
  execFileSync("npm", ["run", "build"], { cwd: root, stdio: "inherit", env: { ...process.env, VITE_FIXTURES: "1" } });
}

const server = spawn("npx", ["--no-install", "vite", "preview", "--port", String(PORT), "--strictPort"], { cwd: join(root, "apps/web"), stdio: "ignore" });
let browser;
try {
  for (let i = 0; ; i++) {
    try { if ((await fetch(BASE)).ok) break; } catch { /* not up yet */ }
    if (i > 60) throw new Error(`nothing served on ${BASE}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  const context = await browser.newContext({
    viewport: VIEW, deviceScaleFactor: SCALE, colorScheme: "light", reducedMotion: "reduce",
    // No tip and no welcome over the picture.
    storageState: { cookies: [], origins: [{ origin: BASE, localStorage: [
      { name: "csd.tips.v1", value: JSON.stringify({ hidden: [], all: true }) },
      { name: "csd.welcome.v1", value: JSON.stringify({ seen: true }) },
    ] }] },
  });
  const page = await context.newPage();
  await page.goto(`${BASE}/?example=t-bone-intersection`);
  await page.waitForSelector(".viewer-canvas[data-ready=true]", { timeout: 60_000 });
  // The road features join the picture in the first idle moment after it is shown.
  await page.waitForTimeout(2500);
  await page.mouse.move(0, 0);
  // The whole window: 1440 x 756 CSS px (2880 x 1512 at 2x).
  const shot = await page.screenshot({ caret: "initial" });
  const { createCanvas, loadImage } = await import("@napi-rs/canvas");
  const img = await loadImage(shot);
  const canvas = createCanvas(OG_SIZE.width, OG_SIZE.height);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, OG_SIZE.width, OG_SIZE.height);
  writeFileSync(OUT, canvas.toBuffer("image/png"));
  console.log(`wrote ${OUT} (${OG_SIZE.width} x ${OG_SIZE.height})`);
} finally {
  await browser?.close();
  server.kill();
}
