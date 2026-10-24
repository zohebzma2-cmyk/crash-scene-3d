#!/usr/bin/env node
// Gentle smoke test of a DEPLOYED copy (Netlify draft or production): one real person's flow, one take, on Chromium at
// 1440 and WebKit at 390. Nothing is stubbed: it verifies the real search, the real vPIC lookups and the real media
// (maker logo, stock photo, GLB model), then saves and checks the files. docs/DEPLOY.md "Release safety".
//
//   npm run smoke -- https://crash-scene-3d.netlify.app                 production: media REQUIRED
//   npm run smoke -- https://<id>--crash-scene-3d.netlify.app           draft/preview: media misses are SKIP (keys are
//                                                                        production-only); --draft forces this mode
//   npm run smoke -- http://localhost:4631 --allow-no-media              a local `vite preview` (no /api): media SKIP
//
//   --out <dir>         where report.json, report.md, the saved ZIP and screenshots go (default smoke-out/, gitignored)
//   --engine <name>     chromium | webkit (default: both, one after the other)
//
// Exit code 0 = every check passed (SKIPs allowed), 1 = at least one FAIL (or the run itself broke).
//
// It is gentle on purpose: one search, one crossing, two vehicles typed key by key (about four vPIC lookups, three
// media calls), the examples opened once each, no loops, no retries, engines one at a time (one machine = one proxy
// user). Run it ONCE per deploy. The scenario is synthetic and uses public road names only.
import { chromium, devices, webkit } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const SEARCH_TEXT = "Main Street and Park Street, Nashua NH";
/** Where the pin must land: the Main Street / Park Street crossing in Nashua, NH (as e2e/live/search.live.spec.ts). */
export const NASHUA = { lat: 42.76, lon: -71.46, dLat: 0.01, dLon: 0.015 };
export const VEHICLES = Object.freeze({
  A: { year: "2019", make: "chevy", model: "silverado 1500", wantMake: /^chevrolet$/i, wantModel: /silverado/i, name: "2019 Chevrolet Silverado 1500" },
  B: { year: "2021", make: "honda", model: "accord", wantMake: /^honda$/i, wantModel: /accord/i, name: "2021 Honda Accord" },
});
/**
 * What the person answers on each card (a new visitor's cards start with nothing picked, 2026-10-12): a T-bone that fits
 * the crossing (B westbound on Park into A's right side as A goes north on Main). `type` is the tile picked only when vPIC
 * didn't fill it (no /api on a local preview).
 */
export const ANSWERS = Object.freeze({
  A: { type: "Pickup", action: "Straight", mph: 25, zone: "Hit on the right side" },
  B: { type: "Car", action: "Straight", mph: 30, zone: "Hit on the front" },
});
export const EXAMPLES = [
  "t-bone-intersection", "highway-rear-end", "parking-lot-backing",
  // Curated famous intersections, pre-baked so they never wait on a live Overpass call.
  "nyc-5th-42nd", "chicago-state-madison", "la-hollywood-highland", "sf-haight-ashbury",
];
export const ENGINES = Object.freeze({
  chromium: { label: "Chromium 1440", device: "Desktop Chrome", width: 1440, height: 900 },
  webkit: { label: "WebKit 390", device: "iPhone 15", width: 390, height: 844 },
});
/** Media a person sees on the Vehicles step and in the PDF; required in production, SKIP-on-miss elsewhere. */
export const MEDIA_CHECKS = new Set(["logo-A", "logo-B", "photo-A", "photo-B", "glb", "save-pdf-photo"]);
const DRAFT_HOST = /--crash-scene-3d\.netlify\.app$/i;
const PRODUCTION_HOST = /^crash-scene-3d\.netlify\.app$/i;

export const USAGE = `usage: npm run smoke -- <base-url> [--out <dir>] [--engine chromium|webkit] [--draft | --require-media] [--allow-no-media]`;

/** A Netlify draft or deploy preview of this site (<anything>--crash-scene-3d.netlify.app). */
export const isDraftHost = (baseUrl) => DRAFT_HOST.test(new URL(baseUrl).hostname);

/** Command-line options. Throws on anything it doesn't understand, so a typo never runs a silently different smoke. */
export function parseArgs(argv) {
  const opts = { baseUrl: null, out: "smoke-out", allowNoMedia: false, draft: false, requireMedia: false, engines: ["chromium", "webkit"], help: false };
  const engines = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = (name) => { const v = a.includes("=") ? a.slice(a.indexOf("=") + 1) : argv[++i]; if (!v || v.startsWith("--")) throw new Error(`${name} needs a value`); return v; };
    if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--allow-no-media") opts.allowNoMedia = true;
    else if (a === "--draft") opts.draft = true;
    else if (a === "--require-media") opts.requireMedia = true;
    else if (a === "--out" || a.startsWith("--out=")) opts.out = value("--out");
    else if (a === "--engine" || a.startsWith("--engine=")) {
      const e = value("--engine");
      if (!ENGINES[e]) throw new Error(`--engine must be one of ${Object.keys(ENGINES).join(", ")}, not "${e}"`);
      engines.push(e);
    } else if (a.startsWith("-")) throw new Error(`Unknown option ${a}\n${USAGE}`);
    else if (opts.baseUrl) throw new Error(`Only one base URL, got "${opts.baseUrl}" and "${a}"`);
    else opts.baseUrl = a;
  }
  if (opts.help) return opts;
  if (!opts.baseUrl) throw new Error(`A base URL is required.\n${USAGE}`);
  let url;
  try { url = new URL(opts.baseUrl); } catch { throw new Error(`"${opts.baseUrl}" is not a URL`); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`The base URL must be http(s), not ${url.protocol}`);
  opts.baseUrl = url.origin + url.pathname.replace(/\/+$/, "");
  if (isDraftHost(opts.baseUrl)) opts.draft = true;
  if (opts.requireMedia && opts.allowNoMedia) throw new Error("--require-media and --allow-no-media contradict each other");
  if (engines.length) opts.engines = [...new Set(engines)];
  opts.target = opts.draft ? "draft" : PRODUCTION_HOST.test(url.hostname) ? "production" : "other";
  return opts;
}

/**
 * What a media miss means here: FAIL in production; SKIP on a draft (the CarImages and logo.dev keys are
 * production-only) or when the run said --allow-no-media (a local build with no /api at all).
 * --require-media makes it FAIL anywhere (for a draft once the keys exist in the deploy-preview context).
 */
export function missStatus(opts) {
  if (opts.requireMedia) return { status: "fail", note: null };
  if (opts.draft) return { status: "skip", note: "not tested on draft (keys production-only)" };
  if (opts.allowNoMedia) return { status: "skip", note: "not tested (--allow-no-media)" };
  return { status: "fail", note: null };
}

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// --- a stored ZIP reader (the app saves method 0 only: packages/exports/src/zip.ts, kept in step by hand) ---
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
/** Entries of a stored ZIP as a Map name -> Buffer. Throws on compression, damage or a bad CRC. */
export function unzipStored(zip) {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("not a zip file");
  const count = v.getUint16(eocd + 10, true);
  let o = v.getUint32(eocd + 16, true);
  const dec = new TextDecoder("utf-8", { fatal: true });
  const out = new Map();
  for (let k = 0; k < count; k++) {
    if (v.getUint32(o, true) !== 0x02014b50) throw new Error("zip central directory damaged");
    if (v.getUint16(o + 10, true) !== 0) throw new Error("zip entry is compressed (the app stores)");
    const size = v.getUint32(o + 24, true), nameLen = v.getUint16(o + 28, true), extra = v.getUint16(o + 30, true), comment = v.getUint16(o + 32, true);
    const at = v.getUint32(o + 42, true);
    const name = dec.decode(zip.subarray(o + 46, o + 46 + nameLen));
    const lName = v.getUint16(at + 26, true), lExtra = v.getUint16(at + 28, true);
    const data = zip.slice(at + 30 + lName + lExtra, at + 30 + lName + lExtra + size);
    if (crc32(data) !== v.getUint32(o + 16, true)) throw new Error(`zip entry ${name}: bad CRC`);
    out.set(name, Buffer.from(data));
    o += 46 + nameLen + extra + comment;
  }
  return out;
}

/** Text of every PDF page (pdfjs-dist, legacy build, runs in Node). */
async function pdfText(bytes) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: false }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    pages.push(content.items.map((it) => ("str" in it ? it.str + (it.hasEOL ? "\n" : " ") : "")).join(""));
  }
  await doc.cleanup();
  return pages.join("\n");
}

/** True when the PDF carries at least one image object (the stock photo on the vehicle page). */
export const pdfHasImage = (bytes) => /\/Subtype\s*\/Image/.test(Buffer.from(bytes).toString("latin1"));

// --- report ---
const fmtMs = (ms) => (ms >= 10_000 ? `${Math.round(ms / 1000)}s` : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);
const STATUS = { pass: "PASS", fail: "FAIL", skip: "SKIP" };
const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const clip = (s, n = 160) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** The compact markdown report: one row per check, one column per engine, then first errors, media and notes. */
export function formatReport(report) {
  const engines = report.engines;
  const ids = [];
  for (const e of engines) for (const c of e.checks) if (!ids.includes(c.id)) ids.push(c.id);
  const cell = (c) => (c ? `${STATUS[c.status]} ${fmtMs(c.ms)}${c.status === "skip" && c.note ? ` (${c.note})` : ""}` : "—");
  const lines = [];
  lines.push(`# Smoke: ${report.baseUrl}`, "");
  lines.push(`- Result: **${report.ok ? "PASS" : "FAIL"}** (${report.counts.fail} failed, ${report.counts.skip} skipped, ${report.counts.pass} passed) in ${fmtMs(report.totalMs)}`);
  lines.push(`- Started: ${report.startedAt}; target: ${report.target}; media on a miss: ${report.mediaPolicy}; /api on this origin: ${report.apiPresent ? "yes" : "no"}`);
  if (report.sha) lines.push(`- Script at commit: ${report.sha}`);
  lines.push("");
  lines.push(`| Check | ${engines.map((e) => e.label).join(" | ")} |`);
  lines.push(`|---|${engines.map(() => "---").join("|")}|`);
  for (const id of ids) lines.push(`| ${id} | ${engines.map((e) => cell(e.checks.find((c) => c.id === id))).join(" | ")} |`);
  lines.push(`| total | ${engines.map((e) => fmtMs(e.totalMs)).join(" | ")} |`);
  const errors = engines.flatMap((e) => e.checks.filter((c) => c.status === "fail").map((c) => `- ${e.label} / ${c.id}: ${clip(oneLine(c.error), 400)}`));
  lines.push("", "## First errors", "", ...(errors.length ? errors : ["- none"]));
  lines.push("", "## Media responses");
  for (const e of engines) {
    lines.push("", `### ${e.label}`, "");
    if (!e.media.length) lines.push("- none seen");
    for (const m of e.media) lines.push(`- ${m.status} ${m.path} ${m.type || ""}${m.fallback ? ` fallback=${m.fallback}` : ""}${m.image ? ` image=${m.image}` : ""}`.trimEnd());
  }
  lines.push("", "## Notes");
  for (const e of engines) {
    lines.push("", `### ${e.label}`, "");
    lines.push(`- welcome dialog ("See what happened"): ${e.welcomeDialog ? "shown, dismissed" : "not shown"}`);
    lines.push(`- console errors: ${e.consoleErrors.length}; page errors: ${e.pageErrors.length}; CSP violations: ${e.cspViolations.length}${e.ignoredConsole ? `; ignored (no /api here): ${e.ignoredConsole}` : ""}`);
    for (const c of e.checks) if (c.note && c.status !== "skip") lines.push(`- ${c.id}: ${c.note}`);
    for (const t of e.consoleErrors.slice(0, 5)) lines.push(`- console: ${clip(oneLine(t.text), 300)}${t.url ? ` (${clip(t.url, 200)})` : ""}`);
    for (const t of e.pageErrors.slice(0, 5)) lines.push(`- pageerror: ${clip(oneLine(t), 300)}`);
    for (const t of e.cspViolations.slice(0, 5)) lines.push(`- csp: ${clip(oneLine(`${t.directive} blocked ${t.blocked} at ${t.source}:${t.line}`), 300)}`);
  }
  return lines.join("\n") + "\n";
}

/** Totals over every engine's checks. */
export function summarize(engines) {
  const counts = { pass: 0, fail: 0, skip: 0 };
  for (const e of engines) for (const c of e.checks) counts[c.status]++;
  return { counts, ok: counts.fail === 0 };
}

// --- browser helpers ---
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Polls until fn is truthy; throws `message` with the last value otherwise. */
async function poll(fn, { timeout, message, every = 250 }) {
  const end = Date.now() + timeout;
  let last;
  for (;;) {
    last = await fn();
    if (last) return last;
    if (Date.now() > end) throw new Error(`${message} (after ${fmtMs(timeout)}; last: ${clip(oneLine(JSON.stringify(last)), 120)})`);
    await sleep(every);
  }
}

const LAUNCH = { chromium: { args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] }, webkit: {} };

/** Does this origin have the proxy at /api? Probes a route the proxy 404s itself (JSON), so no upstream is called. */
async function probeApi(baseUrl) {
  try {
    const r = await fetch(`${baseUrl}/api/__smoke-probe`, { method: "GET", redirect: "manual" });
    return (r.headers.get("content-type") || "").includes("application/json");
  } catch { return false; }
}

async function run(opts) {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const outDir = resolve(opts.out);
  mkdirSync(outDir, { recursive: true });
  const apiPresent = await probeApi(opts.baseUrl);
  const miss = missStatus(opts);
  const engines = [];
  for (const name of opts.engines) engines.push(await runEngine(name, opts, { apiPresent, miss, outDir }));
  const { counts, ok } = summarize(engines);
  const report = {
    baseUrl: opts.baseUrl, startedAt, totalMs: Date.now() - t0, target: opts.target, apiPresent,
    mediaPolicy: miss.status === "fail" ? "required" : `SKIP, ${miss.note}`, sha: process.env.SMOKE_SHA || null,
    counts, ok, engines,
  };
  writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2));
  const md = formatReport(report);
  writeFileSync(join(outDir, "report.md"), md);
  process.stdout.write("\n" + md);
  process.stdout.write(`\nreport: ${join(outDir, "report.md")}\n`);
  return ok;
}

async function runEngine(name, opts, env) {
  const spec = ENGINES[name];
  const engineDir = join(env.outDir, name);
  mkdirSync(engineDir, { recursive: true });
  const rec = { name, label: spec.label, viewport: `${spec.width}x${spec.height}`, totalMs: 0, checks: [], media: [], consoleErrors: [], pageErrors: [], cspViolations: [], welcomeDialog: false, ignoredConsole: 0 };
  const t0 = Date.now();
  process.stdout.write(`\n== ${spec.label} (${name}) against ${opts.baseUrl}\n`);
  const browser = await (name === "webkit" ? webkit : chromium).launch(LAUNCH[name]);
  try {
    const context = await browser.newContext({
      ...devices[spec.device], viewport: { width: spec.width, height: spec.height }, acceptDownloads: true,
      // First-time tips stay hidden, as in every other script that drives the app (they would sit over the controls).
      storageState: { cookies: [], origins: [{ origin: new URL(opts.baseUrl).origin, localStorage: [{ name: "csd.tips.v1", value: JSON.stringify({ hidden: [], all: true }) }] }] },
    });
    // Clicks and waits get a minute, not Playwright's 30 s: this checks the deploy, not the speed of the machine running it.
    context.setDefaultTimeout(60_000);
    const page = await context.newPage();
    await watch(page, rec, env.apiPresent);
    await flow(page, rec, opts, { ...env, engineDir });
    await examplesCheck(page, rec, opts, engineDir);
    errorsCheck(rec);
  } catch (e) {
    rec.checks.push({ id: "run", status: "fail", ms: 0, error: `the run itself broke: ${oneLine(e?.stack || e)}` });
  } finally {
    await browser.close().catch(() => {});
  }
  rec.totalMs = Date.now() - t0;
  return rec;
}

/** Console errors, page errors, CSP violations and the media responses, for the whole engine run. */
function watch(page, rec, apiPresent) {
  page.on("console", (m) => {
    const text = m.text();
    if (text.startsWith("__smoke_csp__")) { if (!rec.screenshotting) rec.cspViolations.push(JSON.parse(text.slice("__smoke_csp__".length))); return; }
    if (m.type() !== "error") return;
    // WebKit also reports the stylesheet Playwright injects for its own screenshots as a console error; not the site's.
    if (rec.screenshotting && /stylesheet|style-src/i.test(text)) return;
    // A local `vite preview` has no /api: the app's failed lookups are not what this run is about.
    if (!apiPresent && /\/api\//.test(text + (m.location()?.url || ""))) { rec.ignoredConsole++; return; }
    rec.consoleErrors.push({ text, url: m.location()?.url || "" });
  });
  page.on("pageerror", (e) => rec.pageErrors.push(e.message));
  page.on("response", (r) => {
    const u = new URL(r.url());
    // The three media routes only (/api/vehicles/models, the vPIC list, is not media).
    if (!/^\/api\/(vehicles\/(image|model)|logos\/[^/]+)$/.test(u.pathname)) return;
    const h = r.headers();
    rec.media.push({ status: r.status(), path: u.pathname + u.search, type: h["content-type"] || "", fallback: h["x-media-fallback"] || "", image: h["x-vehicle-image"] || "" });
  });
  return page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => {
      console.log("__smoke_csp__" + JSON.stringify({ directive: e.violatedDirective, blocked: e.blockedURI, source: e.sourceFile, line: e.lineNumber }));
    });
  });
}

/** Runs one check and records it. A thrown error = FAIL (with a screenshot); a returned { skip } = SKIP. */
async function check(rec, page, dir, id, fn) {
  const t0 = Date.now();
  const c = { id, status: "pass", ms: 0 };
  try {
    const r = await fn();
    if (r?.skip) { c.status = "skip"; c.note = r.skip; } else if (r?.note) c.note = r.note;
  } catch (e) {
    c.status = "fail";
    c.error = oneLine(e?.message || e);
    // caret "initial": the default ("hide") injects an inline <style>, which WebKit reports as a CSP violation of our own making.
    rec.screenshotting = true; // Playwright injects a <style> for its own screenshot; not the app's CSP problem
    await page.screenshot({ path: join(dir, `fail-${id}.png`), fullPage: false, caret: "initial" }).catch(() => {});
    await page.waitForTimeout(50); rec.screenshotting = false;
  }
  c.ms = Date.now() - t0;
  rec.checks.push(c);
  process.stdout.write(`  ${STATUS[c.status].padEnd(4)} ${id.padEnd(18)} ${fmtMs(c.ms).padStart(6)}${c.note ? `  ${c.note}` : ""}${c.error ? `  ${clip(c.error, 200)}` : ""}\n`);
  return c;
}

/** Records the media-dependent checks under the run's miss policy: `missing` is the failure text, or null when fine. */
const mediaCheck = (rec, page, dir, miss, id, fn) => check(rec, page, dir, id, async () => {
  const missing = await fn();
  if (!missing) return undefined;
  if (miss.status === "skip") return { skip: `${miss.note}: ${missing}` };
  throw new Error(missing);
});

/** Picks a combobox value like a person: type key by key, wait for the ranked suggestion, Enter. */
async function pickCombo(page, card, label, text) {
  const box = card.getByRole("combobox", { name: label });
  await box.click();
  await box.fill("");
  await box.pressSequentially(text, { delay: 90 });
  const ranked = card.locator(".combo-option:not(.is-free)").first();
  // The model list waits on vPIC (through the proxy, on a cold cache several calls at 1/s): Honda's took 6–20 s on
  // drafts (2026-10-12) while the card said "Looking up…", so the model gets longer than the year and make lists.
  const sawRanked = await ranked.waitFor({ timeout: label === "Model" ? 45_000 : 15_000 }).then(() => true, () => false);
  await sleep(200);
  await box.press("Enter");
  await sleep(400);
  return { sawRanked, value: await box.inputValue() };
}

async function flow(page, rec, opts, env) {
  const { engineDir: dir, apiPresent, miss } = env;
  const base = opts.baseUrl;
  let broken = null;
  /** A flow check: after an earlier flow failure the rest is not reached, and says so. */
  const step = (id, fn, critical = false) => check(rec, page, dir, id, async () => {
    if (broken) throw new Error(`not reached: ${broken} failed`);
    try { return await fn(); } catch (e) { if (critical) broken = id; throw e; }
  });

  await step("load", async () => {
    const r = await page.goto(`${base}/#location`, { waitUntil: "load", timeout: 60_000 });
    if (!r || !r.ok()) throw new Error(`page answered ${r?.status() ?? "nothing"}`);
    await page.locator("main h1").waitFor({ timeout: 30_000 });
    await sleep(800);
    const dialog = page.getByRole("dialog", { name: /see what happened/i });
    if (await dialog.isVisible().catch(() => false)) {
      rec.welcomeDialog = true;
      const btn = dialog.getByRole("button").filter({ hasText: /close|got it|skip|start|dismiss|ok|later|^×$/i }).first();
      if (await btn.isVisible().catch(() => false)) await btn.click(); else await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden", timeout: 5_000 });
      return { note: "welcome dialog shown and dismissed" };
    }
    return { note: "no welcome dialog" };
  }, true);

  // Location: the public crossing, searched and picked. Without /api (a local preview) the search cannot work, so the
  // flow borrows an example's pin through "Edit details" and the location checks are SKIP.
  let streets = false;
  await step("location", async () => {
    if (!apiPresent) {
      await page.goto(`${base}/?example=t-bone-intersection`, { waitUntil: "load", timeout: 60_000 });
      await page.locator("#app[data-step=review]").waitFor({ timeout: 90_000 });
      await page.getByRole("button", { name: "Edit details" }).click();
      await page.locator("#vehicle-A").waitFor({ timeout: 30_000 });
      return { skip: "no /api on this origin; using the example's pin" };
    }
    const box = page.getByRole("combobox", { name: "Address, intersection or landmark" });
    await box.fill(SEARCH_TEXT);
    await box.press("Enter");
    const first = page.locator(".results button").first();
    await first.waitFor({ timeout: 45_000 });
    const picked = oneLine(await first.innerText());
    await first.click();
    const coords = page.locator(".coords .num");
    await coords.waitFor({ timeout: 15_000 });
    const [lat, lon] = (await coords.innerText()).split(",").map((s) => Number(s.trim()));
    if (!(Math.abs(lat - NASHUA.lat) < NASHUA.dLat && Math.abs(lon - NASHUA.lon) < NASHUA.dLon)) throw new Error(`the pin landed at ${lat}, ${lon}, not the Nashua crossing (picked "${picked}")`);
    return { note: `pin at ${lat.toFixed(5)}, ${lon.toFixed(5)} (picked "${clip(picked, 60)}")` };
  }, true);

  await step("location-streets", async () => {
    if (!apiPresent) return { skip: "no /api on this origin" };
    const el = page.locator(".streets-here");
    await poll(async () => /Streets at the pin/.test(await el.innerText().catch(() => "")), { timeout: 60_000, message: "no 'Streets at the pin' (Overpass)" });
    const text = oneLine(await el.innerText());
    if (!/Main Street/.test(text) || !/Park Street/.test(text)) throw new Error(`streets at the pin: "${text}"`);
    streets = true;
    await page.getByRole("button", { name: /Next: vehicles/ }).click();
    await page.locator("#vehicle-A").waitFor({ timeout: 30_000 });
    return { note: clip(text, 80) };
  });
  if (apiPresent && !streets && !broken) {
    // Streets are a soft miss: still go on to the vehicles when the pin is there.
    await page.getByRole("button", { name: /Next: vehicles/ }).click().catch(() => {});
  }

  // Vehicles: both typed like a person.
  const cards = { A: page.locator("#vehicle-A"), B: page.locator("#vehicle-B") };
  for (const id of ["A", "B"]) {
    const v = VEHICLES[id];
    await step(`vehicle-${id}`, async () => {
      const card = cards[id];
      await card.waitFor({ timeout: 30_000 });
      await poll(async () => !/Loading the makes/.test((await card.locator(".lookup").allTextContents()).join(" ")), { timeout: 30_000, message: "the makes list never loaded" });
      const year = await pickCombo(page, card, "Year", v.year);
      await sleep(300);
      const make = await pickCombo(page, card, "Make", v.make);
      const model = await pickCombo(page, card, "Model", v.model);
      const got = `${year.value} ${make.value} ${model.value}`;
      if (!apiPresent) return { skip: `no /api on this origin; typed as-is: ${got}` };
      if (!make.sawRanked || !v.wantMake.test(make.value)) throw new Error(`vehicle ${id} (${v.name}): make picked "${make.value}" (ranked suggestion ${make.sawRanked ? "seen" : "never appeared"})`);
      if (!model.sawRanked || !v.wantModel.test(model.value)) throw new Error(`vehicle ${id} (${v.name}): model picked "${model.value}" (ranked suggestion ${model.sawRanked ? "seen" : "never appeared"})`);
      return { note: got };
    }, true);
  }
  if (streets) {
    // The roads a person would pick for this crossing; a soft step (the recreation runs without them).
    for (const [id, name] of [["A", "Northbound on Main Street"], ["B", "Westbound on Park Street"]]) {
      await cards[id].getByRole("radio", { name }).click({ timeout: 5_000 }).catch(() => {});
    }
  }
  // What each was doing, its speed and where it was hit; the type only if vPIC left the tiles up. Soft: "See the
  // recreation" below says plainly what is still missing if any of this didn't take.
  for (const id of ["A", "B"]) {
    const a = ANSWERS[id], card = cards[id];
    const tiles = card.locator("[data-fix-type]");
    if (await tiles.isVisible().catch(() => false)) await tiles.getByRole("radio", { name: a.type, exact: true }).click({ timeout: 5_000 }).catch(() => {});
    await card.locator("[data-fix-action]").getByRole("radio", { name: a.action, exact: true }).click({ timeout: 5_000 }).catch(() => {});
    await card.getByRole("textbox", { name: `Speed at impact in mph, vehicle ${id}` }).fill(String(a.mph), { timeout: 5_000 }).catch(() => {});
    await card.getByRole("radio", { name: a.zone, exact: true }).click({ timeout: 5_000 }).catch(() => {});
  }

  for (const id of ["A", "B"]) {
    const v = VEHICLES[id];
    await mediaCheck(rec, page, dir, miss, `logo-${id}`, async () => {
      if (broken) return `not reached: ${broken} failed`;
      const logo = cards[id].locator(".make-logo").first();
      const state = await poll(async () => { const s = await logo.getAttribute("data-make-logo").catch(() => null); return s === "logo" ? s : null; }, { timeout: 20_000, message: "logo" }).catch(async () => logo.getAttribute("data-make-logo").catch(() => "missing"));
      return state === "logo" ? null : `vehicle ${id} (${v.name}): maker logo is "${state}", not "logo"`;
    });
    await mediaCheck(rec, page, dir, miss, `photo-${id}`, async () => {
      if (broken) return `not reached: ${broken} failed`;
      const photo = cards[id].locator(".vehicle-photo").first();
      const state = await poll(async () => { const s = await photo.getAttribute("data-photo").catch(() => null); return s && s !== "loading" && s !== "none" ? s : null; }, { timeout: 30_000, message: "photo" }).catch(async () => photo.getAttribute("data-photo").catch(() => "missing"));
      const natural = await photo.locator("img").first().evaluate((el) => (el.complete ? el.naturalWidth : 0)).catch(() => 0);
      if (state === "photo" && natural > 0) return null;
      return `vehicle ${id} (${v.name}): stock photo state "${state}", img naturalWidth ${natural}${state === "icon" ? " (fallback icon shown)" : ""}`;
    });
  }

  // Review.
  await step("review-ready", async () => {
    await page.getByRole("button", { name: /See the recreation/ }).click({ timeout: 60_000 });
    const anyway = page.getByRole("button", { name: "See it anyway" });
    await poll(async () => (await page.locator("#app[data-step=review]").count()) > 0 || (await anyway.isVisible().catch(() => false)), { timeout: 30_000, message: "neither Review nor 'See it anyway' appeared" })
      .catch(async (e) => {
        const gate = oneLine(await page.getByTestId("gate-panel").innerText({ timeout: 1_000 }).catch(() => ""));
        throw gate ? new Error(`still on Vehicles: ${clip(gate, 300)}`) : e;
      });
    let note;
    if (await anyway.isVisible().catch(() => false)) { note = "passed a warning with 'See it anyway'"; await anyway.click(); }
    await page.locator("#app[data-step=review]").waitFor({ timeout: 15_000 });
    await page.locator(".viewer-canvas[data-ready=true]").waitFor({ timeout: 90_000 });
    return note ? { note } : undefined;
  }, true);

  await step("review-canvas", async () => {
    await page.locator(".viewer3d canvas").waitFor({ timeout: 30_000 });
    const colors = await poll(() => page.evaluate(async () => {
      const c = document.querySelector(".viewer3d canvas");
      if (!c || c.width < 50 || c.height < 50) return 0;
      const bmp = await createImageBitmap(c);
      const off = new OffscreenCanvas(64, 64);
      const ctx = off.getContext("2d");
      ctx.drawImage(bmp, 0, 0, 64, 64);
      const px = ctx.getImageData(0, 0, 64, 64).data;
      const seen = new Set();
      for (let i = 0; i < px.length; i += 4) seen.add(`${px[i] >> 3},${px[i + 1] >> 3},${px[i + 2] >> 3}`);
      return seen.size > 8 ? seen.size : 0;
    }), { timeout: 30_000, message: "the 3D canvas is blank or one colour" });
    rec.screenshotting = true;
    await page.locator(".viewer3d").first().screenshot({ path: join(dir, "review.png"), caret: "initial" }).catch(() => {});
    await page.waitForTimeout(50); rec.screenshotting = false;
    return { note: `${colors} distinct colours in a 64x64 sample` };
  });

  await mediaCheck(rec, page, dir, miss, "glb", async () => {
    if (broken) return `not reached: ${broken} failed`;
    // The viewer asks for the models as it loads; give a slow answer a moment.
    const ok = await poll(() => rec.media.some((m) => m.path.startsWith("/api/vehicles/model") && m.status === 200 && /model\/gltf-binary/.test(m.type)), { timeout: 15_000, message: "glb" }).catch(() => false);
    if (ok) return null;
    const seen = rec.media.filter((m) => m.path.startsWith("/api/vehicles/model"));
    return seen.length ? `no model/gltf-binary answer from /api/vehicles/model; got ${seen.map((m) => `${m.status} ${m.type || "(no type)"}${m.fallback ? ` fallback=${m.fallback}` : ""}`).join(", ")}` : "the page never asked /api/vehicles/model";
  });

  await step("review-play", async () => {
    const slider = page.locator(".timeline .track[role=slider]");
    await slider.waitFor({ timeout: 15_000 });
    await slider.focus();
    await page.keyboard.press("Home");
    const t0 = Number(await slider.getAttribute("aria-valuenow"));
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await poll(async () => Number(await slider.getAttribute("aria-valuenow")) >= 0, { timeout: 30_000, message: "playback never reached the impact mark" });
    const t = Number(await slider.getAttribute("aria-valuenow"));
    const pause = page.getByRole("button", { name: "Pause", exact: true });
    if (await pause.isVisible().catch(() => false)) await pause.click();
    return { note: `played from ${t0}s through impact (now ${t}s)` };
  });

  await step("review-aftermath", async () => {
    const btn = page.locator(".timeline .aftermath-btn");
    if (!(await btn.count())) return { skip: "no Aftermath button" };
    await btn.click();
    await poll(async () => (await btn.getAttribute("aria-pressed")) === "true", { timeout: 10_000, message: "Aftermath did not switch on" });
  });

  await step("review-measure", async () => {
    const tab = page.getByRole("tab", { name: "Measure" });
    if (!(await tab.count())) return { skip: "no Measure tab" };
    await tab.click();
    const rows = page.locator(".measure-list > div");
    await rows.first().waitFor({ timeout: 15_000 });
    return { note: `${await rows.count()} measure rows` };
  });

  // Save.
  let files = null;
  await step("save-download", async () => {
    // The stills are captured on the way out of Review, so this click can take a moment on a slow machine.
    await page.getByRole("button", { name: "Looks right: save it" }).click({ timeout: 60_000 });
    await page.locator("#app[data-step=export]").waitFor({ timeout: 60_000 });
    const downloads = [];
    page.on("download", (d) => downloads.push(d));
    const save = page.getByRole("button", { name: "Save to my device" });
    await poll(() => save.isEnabled().catch(() => false), { timeout: 90_000, message: "'Save to my device' never became ready" });
    await save.click();
    const again = page.getByRole("button", { name: "Download your files" });
    await poll(async () => downloads.length > 0 || (await again.isVisible().catch(() => false)), { timeout: 90_000, message: "no download and no second tap" });
    let secondTap = false;
    if (!downloads.length) { secondTap = true; await again.click(); }
    await poll(() => downloads.length >= 1, { timeout: 60_000, message: "no download after the tap" });
    await sleep(600);
    if (downloads.length !== 1) throw new Error(`one save gave ${downloads.length} downloads: ${downloads.map((d) => d.suggestedFilename()).join(", ")}`);
    const d = downloads[0];
    const name = d.suggestedFilename();
    const bytes = await readFile(await d.path());
    writeFileSync(join(dir, name), bytes);
    files = name.endsWith(".zip") ? unzipStored(new Uint8Array(bytes)) : new Map([[name, bytes]]);
    return { note: `${name} (${bytes.length} bytes${secondTap ? ", needed the second tap" : ""})` };
  }, true);

  const pick = (re) => { for (const [n, b] of files ?? []) if (re.test(n)) return { name: n, bytes: b }; return null; };
  await step("save-files", async () => {
    const want = [["PDF", /\.pdf$/], ["impact still", /-impact\.png$/], ["final-rest still", /-final-rest\.png$/], ["diagram", /-diagram\.png$/], ["scene JSON", /\.json$/]];
    const missing = want.filter(([, re]) => !pick(re)).map(([what]) => what);
    if (missing.length) throw new Error(`missing from the save: ${missing.join(", ")}; got ${[...files.keys()].join(", ")}`);
    return { note: [...files.keys()].join(", ") };
  }, true);

  await step("save-fingerprint", async () => {
    const json = pick(/\.json$/), pdf = pick(/\.pdf$/);
    const hex = sha256(json.bytes);
    const squashed = (await pdfText(pdf.bytes)).replace(/\s+/g, "");
    if (!squashed.includes(hex)) throw new Error(`the PDF does not print the scene file's SHA-256 ${hex}`);
    return { note: `sha256 ${hex.slice(0, 16)}… printed in the PDF` };
  });

  await mediaCheck(rec, page, dir, miss, "save-pdf-photo", async () => {
    if (broken) return `not reached: ${broken} failed`;
    const pdf = pick(/\.pdf$/);
    return pdf && pdfHasImage(pdf.bytes) ? null : "the PDF holds no image object (no stock photo)";
  });
}

async function examplesCheck(page, rec, opts, dir) {
  for (const name of EXAMPLES) {
    await check(rec, page, dir, `example-${name}`, async () => {
      // A blank page first: a goto that only changes the hash of the current URL would not reload the app.
      await page.goto("about:blank");
      await page.goto(`${opts.baseUrl}/?example=${name}#review`, { waitUntil: "load", timeout: 60_000 });
      await page.locator("#app[data-step=review]").waitFor({ timeout: 30_000 });
      await page.locator(".viewer-canvas[data-ready=true]").waitFor({ timeout: 90_000 });
    });
  }
}

function errorsCheck(rec) {
  const c = { id: "no-errors", status: "pass", ms: 0 };
  const all = [...rec.pageErrors.map((t) => `pageerror: ${t}`), ...rec.cspViolations.map((v) => `csp: ${v.directive} blocked ${v.blocked}`), ...rec.consoleErrors.map((e) => `console: ${e.text}`)];
  if (all.length) { c.status = "fail"; c.error = `${all.length} error(s); first: ${clip(oneLine(all[0]), 300)}`; }
  rec.checks.push(c);
  process.stdout.write(`  ${STATUS[c.status].padEnd(4)} ${c.id.padEnd(18)} ${"".padStart(6)}${c.error ? `  ${clip(c.error, 200)}` : ""}\n`);
}

const isMain = (() => { try { return process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url; } catch { return false; } })();
if (isMain) {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) { process.stderr.write(`${e.message}\n`); process.exit(2); }
  if (opts.help) { process.stdout.write(`${USAGE}\n`); process.exit(0); }
  run(opts).then((ok) => process.exit(ok ? 0 : 1), (e) => { process.stderr.write(`smoke: ${e?.stack || e}\n`); process.exit(1); });
}
