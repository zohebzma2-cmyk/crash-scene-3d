#!/usr/bin/env node
// The full README walkthrough in fixtures mode (?media=on: the synthetic photo, badge and 3D model), from a search to
// the saved files. One flow, three outputs:
//
//   node scripts/record-demo-full.mjs                  video: docs/media/demo-flow.mp4 + docs/media/demo-flow.gif
//   node scripts/record-demo-full.mjs --stills=desktop docs/media/steps/desktop-<step>.png at 1440 (+ the PDF's page 1)
//   node scripts/record-demo-full.mjs --stills=phone   docs/media/steps/phone-<step>.png at 390 (Pixel 7) + phone-strip.png
//
// Add --no-build to reuse apps/web/dist from an earlier `VITE_FIXTURES=1 npm run build`. Needs ffmpeg (FFMPEG=...),
// and pdftoppm + unzip for the PDF still. Serves on DEMO_PORT (default 4521) and stops that server by its own PID.
// Synthetic data only: the example claim, public Nashua streets and fixture files; nothing here is a real photo.
import { chromium, devices } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.DEMO_PORT ?? 4521);
const BASE = `http://localhost:${PORT}`;
const FFMPEG = process.env.FFMPEG ?? "ffmpeg";
// The full flow is longer than record-demo.mjs's T-bone walk, so its GIF is sped up more and uses fewer colours to
// stay under 2.5 MB; the MP4 keeps record-demo.mjs's 1.35x.
const FPS = Number(process.env.DEMO_FPS ?? 9);
const WIDTH = Number(process.env.DEMO_WIDTH ?? 960);
const SPEED = Number(process.env.DEMO_SPEED ?? 1.35);          // MP4
const GIF_SPEED = Number(process.env.DEMO_GIF_SPEED ?? 1.75);  // GIF (about 38 s from a 66 s recording)
const GIF_COLORS = Number(process.env.DEMO_GIF_COLORS ?? 48);
const stillsArg = process.argv.find((a) => a.startsWith("--stills="));
const STILLS = stillsArg ? stillsArg.split("=")[1] : null;   // "desktop" | "phone" | null (video)
const MEDIA = resolve(root, "docs/media");
const STEPS_DIR = join(MEDIA, "steps");
const VIDEO_SIZE = { width: 1280, height: 720 };
const STEPS = ["location", "vehicles", "review", "aftermath", "save", "pdf"];

if (!process.argv.includes("--no-build")) {
  execFileSync("npm", ["run", "build"], { cwd: root, stdio: "inherit", env: { ...process.env, VITE_FIXTURES: "1" } });
}

/** A PNG squeezed to 256 colours (ffmpeg palette), so README stills stay small. */
function squeeze(src, out) {
  execFileSync(FFMPEG, ["-y", "-i", src, "-vf", "split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=sierra2_4a", out], { stdio: "ignore" });
}

const server = spawn("npx", ["--no-install", "vite", "preview", "--port", String(PORT), "--strictPort"], { cwd: join(root, "apps/web"), stdio: "ignore" });
const work = mkdtempSync(join(tmpdir(), "csd-demo-full-"));
let browser;
try {
  for (let i = 0; ; i++) {
    try { if ((await fetch(BASE)).ok) break; } catch { /* not up yet */ }
    if (i > 60) throw new Error(`nothing served on ${BASE}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  const ctxBase = {
    colorScheme: "light", reducedMotion: "no-preference", acceptDownloads: true,
    storageState: { cookies: [], origins: [{ origin: BASE, localStorage: [{ name: "csd.tips.v1", value: JSON.stringify({ hidden: [], all: true }) }] }] },
  };
  const context = await browser.newContext(
    STILLS === "phone" ? { ...devices["Pixel 7"], viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, ...ctxBase }
    : STILLS === "desktop" ? { viewport: { width: 1440, height: 900 }, ...ctxBase }
    : { viewport: VIDEO_SIZE, recordVideo: { dir: work, size: VIDEO_SIZE }, ...ctxBase });
  const phone = STILLS === "phone";
  if (!STILLS) {
    // A visible pointer: recorded video has none.
    await context.addInitScript(() => {
      addEventListener("DOMContentLoaded", () => {
        const dot = document.createElement("div");
        dot.style.cssText = "position:fixed;left:0;top:0;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:rgba(20,20,20,.35);border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.45);pointer-events:none;z-index:2147483647;transition:transform .05s linear";
        document.documentElement.appendChild(dot);
        addEventListener("mousemove", (e) => { dot.style.transform = `translate(${e.clientX}px,${e.clientY}px)`; }, true);
      });
    });
  }
  const t0 = Date.now();
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const pause = (ms) => page.waitForTimeout(STILLS ? Math.min(ms, 400) : ms);
  const moveTo = async (loc, steps = 25) => {
    await loc.scrollIntoViewIfNeeded();
    const b = await loc.boundingBox();
    if (!phone) await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps });
    return b;
  };
  const click = async (loc) => { await moveTo(loc); await pause(250); await loc.click(); };
  const type = async (field, text) => {
    await moveTo(field); await field.click(); await field.fill("");
    await field.pressSequentially(text, { delay: STILLS ? 20 : 90 });
    await pause(500);
    await field.press("Tab");
    await pause(400);
  };
  mkdirSync(STEPS_DIR, { recursive: true });
  const shot = async (name, target) => {
    if (!STILLS) return;
    if (target) await target.scrollIntoViewIfNeeded();
    await page.waitForTimeout(600);
    const raw = join(work, `${name}.png`);
    await page.screenshot({ path: raw });
    squeeze(raw, join(STEPS_DIR, `${STILLS}-${name}.png`));
  };

  // Fresh start on step 1 (the first frames are trimmed away below).
  await page.goto(`${BASE}/?media=on#location`);
  await page.evaluate(() => { try { sessionStorage.clear(); } catch { /* ignore */ } });
  await page.reload();
  await page.locator("main h1").waitFor();
  await pause(600);
  const tStart = (Date.now() - t0) / 1000;

  // Step 1: search, pick the crossing (the pin is set on it).
  const search = page.getByRole("combobox", { name: "Address, intersection or landmark" });
  await moveTo(search);
  await search.click();
  await search.fill("Main Street and Park Street, Nashua NH");
  await pause(700);
  await search.press("Enter");
  const first = page.locator(".results button").first();
  await first.waitFor();
  await pause(900);
  await click(first);
  await page.locator(".streets-here").waitFor();
  await pause(1800);   // the camera flies in
  await shot("location");
  await click(page.getByRole("button", { name: /Next: vehicles/ }));

  // Step 2: year, make, model, colour, direction for A and B.
  const a = page.locator("#vehicle-A");
  const b = page.locator("#vehicle-B");
  await a.waitFor();
  await pause(700);
  for (const [card, year, make, model, colour, dir, hit] of [
    [a, "2019", "chevy", "Silverado 1500", "Red", "Northbound on Main Street", "Hit on the right side"],
    [b, "2021", "honda", "Accord", "Blue", "Westbound on Park Street", "Hit on the front"],
  ]) {
    await type(card.getByLabel("Year"), year);
    await type(card.getByLabel("Make"), make);
    await type(card.getByLabel("Model"), model);
    await card.locator(".lookup").filter({ hasText: /from NHTSA vPIC/ }).waitFor({ timeout: 15_000 }).catch(() => {});
    await pause(1200);   // the photo and badge load
    await click(card.locator(`[data-paint-picker]`).getByRole("radio", { name: colour, exact: true }));
    await pause(500);
    await click(card.getByRole("radio", { name: dir, exact: true }));
    await pause(500);
    await click(card.getByRole("radio", { name: hit, exact: true }));
    await pause(700);
    if (card === a) {
      // Card A from its top (photo, year, make, model), just under the sticky bars.
      await page.evaluate(() => {
        const el = document.getElementById("vehicle-A");
        const bars = [".app-header", ".disclaimer-bar"].reduce((h, sel) => h + (document.querySelector(sel)?.getBoundingClientRect().height ?? 0), 0);
        if (el) window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - bars - 16);
      });
      await shot("vehicles");
    }
  }

  // Step 3: review. Top view, play to the impact, then Aftermath.
  await click(page.getByRole("button", { name: /See the recreation/ }));
  const anyway = page.getByRole("button", { name: "See it anyway" });
  await page.locator("#app[data-step=review]").or(anyway).waitFor();
  if (await anyway.isVisible()) await click(anyway);
  await page.locator(".viewer-canvas[data-ready=true]").waitFor({ timeout: 60_000 });
  await pause(1500);
  const top = page.getByRole("radio", { name: "Top", exact: true }).or(page.getByRole("button", { name: "Top", exact: true })).first();
  if (await top.isVisible().catch(() => false)) { await click(top); await pause(1200); }
  await click(page.getByRole("button", { name: "Play" }));
  await page.waitForTimeout(STILLS ? 3200 : 4200);
  // Back to the moment of impact: a tap on the timeline's Impact mark.
  const mark = page.locator(".track-impact");
  if (await mark.isVisible().catch(() => false)) {
    const ib = await mark.boundingBox();
    if (!phone) await page.mouse.move(ib.x + ib.width / 2, ib.y + ib.height / 2, { steps: 20 });
    await page.mouse.click(ib.x + ib.width / 2, ib.y + ib.height / 2);
    await pause(1800);
  }
  await page.evaluate(() => scrollTo(0, 0));
  await shot("review");
  await click(page.getByRole("button", { name: "Aftermath" }));
  await pause(3000);
  await page.evaluate(() => scrollTo(0, 0));
  await shot("aftermath");

  // Step 4: save.
  await click(page.getByRole("button", { name: "Looks right: save it" }));
  await page.locator("#app[data-step=export]").waitFor();
  await pause(1200);
  await shot("save");
  const saveBtn = page.getByRole("button", { name: "Save to my device" });
  await moveTo(saveBtn);
  const download = page.waitForEvent("download", { timeout: 60_000 });
  await saveBtn.click();
  const again = page.getByRole("button", { name: "Download your files" });
  const winner = await Promise.race([download.then(() => "d"), again.waitFor({ timeout: 45_000 }).then(() => "again")]);
  if (winner === "again") await again.click();
  const zip = await download;
  console.log(`downloaded ${zip.suggestedFilename()}`);
  await pause(2000);
  if (errors.length) console.warn("page errors:", errors);

  if (STILLS === "desktop") {
    const zipPath = join(work, "save.zip");
    await zip.saveAs(zipPath);
    const unz = join(work, "unz");
    mkdirSync(unz);
    execFileSync("unzip", ["-q", zipPath, "-d", unz]);
    const pdf = readdirSync(unz, { recursive: true }).find((f) => String(f).endsWith(".pdf"));
    if (pdf) {
      execFileSync(process.env.PDFTOPPM ?? "pdftoppm", ["-r", "110", "-png", "-f", "1", "-l", "1", "-singlefile", join(unz, String(pdf)), join(work, "pdf")]);
      squeeze(join(work, "pdf.png"), join(STEPS_DIR, "desktop-pdf.png"));
    } else console.warn("no PDF in the ZIP");
  }

  const video = page.video();
  await context.close();
  if (STILLS === "phone") {
    // One wide strip: each step scaled to 640 px tall, side by side.
    const names = STEPS.filter((s) => s !== "pdf").map((s) => join(STEPS_DIR, `phone-${s}.png`));
    const inputs = names.flatMap((n) => ["-i", n]);
    const scaled = names.map((_, i) => `[${i}:v]scale=-1:640,pad=iw+16:ih:8:0:white[s${i}]`).join(";");
    const filter = `${scaled};${names.map((_, i) => `[s${i}]`).join("")}hstack=inputs=${names.length},split[a][b];[a]palettegen=max_colors=256[p];[b][p]paletteuse=dither=sierra2_4a`;
    execFileSync(FFMPEG, ["-y", ...inputs, "-filter_complex", filter, join(STEPS_DIR, "phone-strip.png")], { stdio: "ignore" });
  }
  if (!STILLS) {
    const webm = await video.path();
    renameSync(webm, join(work, "demo.webm"));
    mkdirSync(MEDIA, { recursive: true });
    const vf = `setpts=PTS/${GIF_SPEED},fps=${FPS},scale=${WIDTH}:-1:flags=lanczos`;
    const ss = ["-ss", tStart.toFixed(2)];
    const src = ["-i", join(work, "demo.webm")];
    const mp4 = join(MEDIA, "demo-flow.mp4");
    execFileSync(FFMPEG, ["-y", ...ss, ...src, "-vf", `setpts=PTS/${SPEED},scale=1280:-2`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "30", "-preset", "slow", "-movflags", "+faststart", "-an", mp4], { stdio: "ignore" });
    const gif = join(MEDIA, "demo-flow.gif");
    const palette = join(work, "palette.png");
    execFileSync(FFMPEG, ["-y", ...ss, ...src, "-vf", `${vf},palettegen=max_colors=${GIF_COLORS}:stats_mode=diff`, palette], { stdio: "ignore" });
    execFileSync(FFMPEG, ["-y", ...ss, ...src, "-i", palette, "-lavfi", `${vf}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`, "-loop", "0", gif], { stdio: "ignore" });
    for (const f of [mp4, gif]) console.log(`wrote ${f} (${(statSync(f).size / 1e6).toFixed(2)} MB)`);
  } else {
    for (const f of readdirSync(STEPS_DIR).filter((f) => f.startsWith(STILLS))) console.log(`${f} ${(statSync(join(STEPS_DIR, f)).size / 1e3).toFixed(0)} KB`);
  }
} finally {
  await browser?.close().catch(() => {});
  if (server.pid) server.kill("SIGTERM");   // by PID: only the server this script started
  rmSync(work, { recursive: true, force: true });
}
