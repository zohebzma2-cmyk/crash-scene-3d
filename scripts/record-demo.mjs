#!/usr/bin/env node
// Records a short GIF (docs/demo.gif): the T-bone walkthrough in fixtures mode, start to Save. The README no longer
// uses it (since 2026-10-14 its demo and pictures come from record-demo-full.mjs), so the file is not committed.
//
//   node scripts/record-demo.mjs            build (VITE_FIXTURES=1), serve on :4333, record, convert
//   node scripts/record-demo.mjs --no-build reuse apps/web/dist from an earlier build
//
// Needs ffmpeg (FFMPEG=/path/to/ffmpeg, default: ffmpeg on PATH). Only the server this script starts is used,
// and it is stopped by its own PID at the end. Output: docs/demo.gif (override with DEMO_OUT).
import { chromium } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.DEMO_PORT ?? 4333);
const BASE = `http://localhost:${PORT}`;
const FFMPEG = process.env.FFMPEG ?? "ffmpeg";
const OUT = resolve(root, process.env.DEMO_OUT ?? "docs/demo.gif");
const FPS = Number(process.env.DEMO_FPS ?? 11);
const WIDTH = Number(process.env.DEMO_WIDTH ?? 960);
const SPEED = Number(process.env.DEMO_SPEED ?? 1.35);   // >1 plays the GIF faster than it was recorded (about 30 s from a 40 s recording)
const SIZE = { width: 1280, height: 720 };
const pause = (page, ms) => page.waitForTimeout(ms);

if (!process.argv.includes("--no-build")) {
  execFileSync("npm", ["run", "build"], { cwd: root, stdio: "inherit", env: { ...process.env, VITE_FIXTURES: "1" } });
}

const server = spawn("npx", ["--no-install", "vite", "preview", "--port", String(PORT), "--strictPort"], { cwd: join(root, "apps/web"), stdio: "ignore" });
const work = mkdtempSync(join(tmpdir(), "csd-demo-"));
let browser;
try {
  for (let i = 0; ; i++) {
    try { if ((await fetch(BASE)).ok) break; } catch { /* not up yet */ }
    if (i > 60) throw new Error(`nothing served on ${BASE}`);
    await new Promise((r) => setTimeout(r, 500));
  }

  browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  const context = await browser.newContext({
    viewport: SIZE, colorScheme: "light", reducedMotion: "no-preference", acceptDownloads: true,
    recordVideo: { dir: work, size: SIZE },
    // Tips hidden, as in the e2e suite.
    storageState: { cookies: [], origins: [{ origin: BASE, localStorage: [{ name: "csd.tips.v1", value: JSON.stringify({ hidden: [], all: true }) }] }] },
  });
  // A visible pointer: recorded video has none.
  await context.addInitScript(() => {
    addEventListener("DOMContentLoaded", () => {
      const dot = document.createElement("div");
      dot.style.cssText = "position:fixed;left:0;top:0;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:rgba(20,20,20,.35);border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.45);pointer-events:none;z-index:2147483647;transition:transform .05s linear";
      document.documentElement.appendChild(dot);
      addEventListener("mousemove", (e) => { dot.style.transform = `translate(${e.clientX}px,${e.clientY}px)`; }, true);
    });
  });
  const t0 = Date.now();
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  const moveTo = async (loc, steps = 25) => {
    const b = await loc.boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps });
    return b;
  };
  const click = async (loc) => { await moveTo(loc); await pause(page, 250); await loc.click(); };

  // Fresh start on step 1 (the first frames are trimmed away below).
  await page.goto(`${BASE}/#location`);
  await page.evaluate(() => { try { sessionStorage.clear(); } catch { /* ignore */ } });
  await page.reload();
  await page.locator("main h1").waitFor();
  await pause(page, 600);
  const tStart = (Date.now() - t0) / 1000;

  // Step 1: search, pick the crossing, set the pin.
  const search = page.getByRole("combobox", { name: "Address, intersection or landmark" });
  await moveTo(search);
  await search.click();
  // fill, not per-key typing: typing under the recorder's CPU load let late suggestions garble the text.
  await search.fill("Main Street and Park Street, Nashua NH");
  await pause(page, 700);
  await search.press("Enter");
  const first = page.locator(".results button").first();
  await first.waitFor();
  await pause(page, 900);
  await click(first);
  await page.locator(".streets-here").waitFor();
  await pause(page, 1600);   // the camera flies in
  const marker = page.locator(".leaflet-marker-icon");
  const mb = await moveTo(marker);
  await page.mouse.down();
  await page.mouse.move(mb.x + mb.width / 2 + 14, mb.y + mb.height / 2 + 10, { steps: 12 });
  await page.mouse.up();
  await page.locator(".coords-label", { hasText: "Pin placed by you" }).waitFor();
  await pause(page, 1500);
  await click(page.getByRole("button", { name: /Next: vehicles/ }));

  // Step 2: type, what each was doing, direction, speed and zones (a new visitor's cards start with nothing picked).
  const a = page.locator("#vehicle-A");
  const b = page.locator("#vehicle-B");
  await a.waitFor();
  await pause(page, 900);
  for (const [card, type, mph] of [[a, "Car", "25"], [b, "SUV", "30"]]) {
    await click(card.locator("[data-fix-type]").getByRole("radio", { name: type, exact: true }));
    await pause(page, 300);
    await click(card.locator("[data-fix-action]").getByRole("radio", { name: "Straight", exact: true }));
    await pause(page, 300);
    await card.locator("[data-fix-speed] input").fill(mph);
    await pause(page, 300);
  }
  await click(a.getByRole("radio", { name: "Northbound on Main Street" }));
  await pause(page, 500);
  await click(b.getByRole("radio", { name: "Westbound on Park Street" }));
  await pause(page, 500);
  await click(a.getByRole("radio", { name: "Hit on the right side", exact: true }));
  await pause(page, 400);
  await click(b.getByRole("radio", { name: "Hit on the front", exact: true }));
  await pause(page, 900);

  // Step 3: review. Play the timeline, then the Aftermath view.
  await click(page.getByRole("button", { name: /See the recreation/ }));
  const anyway = page.getByRole("button", { name: "See it anyway" });
  await page.locator("#app[data-step=review]").or(anyway).waitFor();
  if (await anyway.isVisible()) await click(anyway);
  await page.locator(".viewer-canvas[data-ready=true]").waitFor({ timeout: 60_000 });
  await pause(page, 1800);
  const playBtn = page.getByRole("button", { name: "Play" });
  await click(playBtn);
  await pause(page, 4200);
  await click(page.getByRole("button", { name: "Aftermath" }));
  await pause(page, 3000);

  // Step 4: save.
  await click(page.getByRole("button", { name: "Looks right: save it" }));
  await page.locator("#app[data-step=export]").waitFor();
  await pause(page, 1200);
  const saveBtn = page.getByRole("button", { name: "Save to my device" });
  await moveTo(saveBtn);
  const download = page.waitForEvent("download", { timeout: 60_000 });
  await saveBtn.click();
  const zip = await download;
  console.log(`downloaded ${zip.suggestedFilename()}`);
  await pause(page, 2000);
  if (errors.length) console.warn("page errors:", errors);

  const video = page.video();
  await context.close();
  const webm = await video.path();
  renameSync(webm, join(work, "demo.webm"));

  // webm -> GIF, two passes (palette from the frames, then dithered with it).
  mkdirSync(dirname(OUT), { recursive: true });
  const vf = `setpts=PTS/${SPEED},fps=${FPS},scale=${WIDTH}:-1:flags=lanczos`;
  const ss = ["-ss", tStart.toFixed(2)];
  const palette = join(work, "palette.png");
  execFileSync(FFMPEG, ["-y", ...ss, "-i", join(work, "demo.webm"), "-vf", `${vf},palettegen=max_colors=128:stats_mode=diff`, palette], { stdio: "ignore" });
  execFileSync(FFMPEG, ["-y", ...ss, "-i", join(work, "demo.webm"), "-i", palette, "-lavfi", `${vf}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`, "-loop", "0", OUT], { stdio: "ignore" });
  console.log(`wrote ${OUT} (${(statSync(OUT).size / 1e6).toFixed(2)} MB)`);
} finally {
  await browser?.close().catch(() => {});
  if (server.pid) server.kill("SIGTERM");   // by PID: only the server this script started
  rmSync(work, { recursive: true, force: true });
}
