#!/usr/bin/env node
// Checks the response headers (and the proxy's error shape) of a running copy of the site.
//
//   npm run verify:headers -- http://localhost:8888
//   npm run verify:headers -- https://<the deployed site>
//   npm run verify:headers -- http://localhost:8888 --local   (netlify dev / netlify serve: see below)
//   npm run verify:headers -- http://localhost:8888 --dev     (also skip the /assets check: Vite dev has none)
//
// --local: Netlify's local static server overrides Cache-Control on static files, so those rows
// are shown as SKIP when they differ (the toml rules themselves are still checked above). Always run
// WITHOUT --local against a real deploy.
//
// It sends a handful of GET requests (and one POST) to the base URL only. The API requests are
// all deliberately invalid, so the proxy answers them itself and never calls an outside service.
// It prints a table and exits 1 if any check fails, 0 if all pass. Needs Node 22+ (global fetch).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ---- what we expect (must match netlify.toml; the script also checks that it does) ---------------

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; font-src 'self'; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const PERMISSIONS =
  "accelerometer=(), autoplay=(), bluetooth=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), hid=(), magnetometer=(), microphone=(), midi=(), payment=(), serial=(), usb=(), xr-spatial-tracking=()";

/** Header name (as written in netlify.toml) -> exact expected value, on every path. */
const SECURITY = {
  "Content-Security-Policy": CSP,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": PERMISSIONS,
  "Cross-Origin-Opener-Policy": "same-origin",
  "X-Frame-Options": "DENY",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
};
const ASSET_CACHE = "public, max-age=31536000, immutable";

// ---- plumbing ---------------------------------------------------------------------------------------

const args = process.argv.slice(2);
const dev = args.includes("--dev");
// netlify dev / netlify serve: their local static server stamps its own Cache-Control on files and
// ignores the toml value, so static-file Cache-Control can only be checked on a real deploy.
const local = args.includes("--local");
const positional = args.filter((a) => !a.startsWith("--"));
const base = (positional[0] ?? "http://localhost:8888").replace(/\/+$/, "");
if (!/^https?:\/\//.test(base)) {
  console.error(`Usage: verify-headers.mjs <base-url> [--dev]   (got "${base}")`);
  process.exit(2);
}

/** @type {{ group: string; check: string; expected: string; actual: string; ok: boolean; skipped?: boolean }[]} */
const rows = [];
const add = (group, check, expected, actual, ok) => rows.push({ group, check, expected, actual, ok });
const skip = (group, check, why) => rows.push({ group, check, expected: why, actual: "-", ok: true, skipped: true });
const eq = (group, check, expected, actual) => add(group, check, expected, actual ?? "(missing)", actual === expected);

async function get(path, init) {
  const res = await fetch(base + path, { redirect: "manual", ...init });
  const body = await res.text();
  return { path, res, body, h: (n) => res.headers.get(n) };
}

/** Cache-Control on a static file; under --local a mismatch is skipped, not failed. */
function cacheEq(group, expected, actual) {
  if (local && actual !== expected) skip(group, "Cache-Control", `--local server sets "${actual}"; toml says "${expected}"`);
  else eq(group, "Cache-Control", expected, actual);
}

function checkSecurity(group, r) {
  for (const [name, want] of Object.entries(SECURITY)) eq(group, name, want, r.h(name));
  const csp = r.h("Content-Security-Policy") ?? "";
  add(group, "frame-ancestors 'none' in CSP", "present", csp.includes("frame-ancestors 'none'") ? "present" : "absent", csp.includes("frame-ancestors 'none'"));
  const pp = r.h("Permissions-Policy") ?? "";
  const denied = ["camera=()", "microphone=()", "geolocation=()"].filter((d) => !pp.split(/,\s*/).includes(d));
  add(group, "Permissions-Policy denies camera, mic, geolocation", "all three", denied.length ? `missing ${denied.join(" ")}` : "all three", denied.length === 0);
  const hsts = /max-age=(\d+)/.exec(r.h("Strict-Transport-Security") ?? "");
  add(group, "HSTS max-age >= 1 year", ">= 31536000", hsts ? hsts[1] : "(missing)", !!hsts && Number(hsts[1]) >= 31536000);
}

/** Every proxy failure is a JSON ProxyError with friendly text, never HTML. */
function checkProxyError(group, r, status, code) {
  eq(group, "status", String(status), String(r.res.status));
  add(group, "Content-Type is JSON", "application/json", r.h("content-type") ?? "(missing)", /^application\/json\b/i.test(r.h("content-type") ?? ""));
  eq(group, "Cache-Control", "no-store", r.h("cache-control"));
  eq(group, "X-Content-Type-Options", "nosniff", r.h("x-content-type-options"));
  let parsed = null;
  try { parsed = JSON.parse(r.body); } catch { /* reported below */ }
  const shaped = parsed !== null && typeof parsed === "object" && typeof parsed.code === "string" && typeof parsed.message === "string" && parsed.message.length > 0;
  add(group, "body is a JSON ProxyError", '{"code","message"}', shaped ? `${parsed.code}: ${parsed.message}` : `not a ProxyError (${r.body.slice(0, 40).replace(/\s+/g, " ")})`, shaped);
  if (code) add(group, `code is "${code}"`, code, shaped ? parsed.code : "-", shaped && parsed.code === code);
  add(group, "body is not HTML", "no leading <", r.body.trimStart().startsWith("<") ? "starts with <" : "no leading <", !r.body.trimStart().startsWith("<"));
  add(group, "friendly text has no stack or path", "none", /\bat \S+\(|node_modules|\/Users\/|\.ts:\d+/.test(r.body) ? "leaks internals" : "none", !/\bat \S+\(|node_modules|\/Users\/|\.ts:\d+/.test(r.body));
}

// ---- the checks -----------------------------------------------------------------------------------------

try {
  // netlify.toml says the same thing as this script.
  const toml = readFileSync(fileURLToPath(new URL("../netlify.toml", import.meta.url)), "utf8");
  for (const [name, want] of Object.entries(SECURITY)) {
    const m = new RegExp(`^\\s*${name} = "(.*)"\\s*$`, "m").exec(toml);
    add("netlify.toml", name, want, m ? m[1] : "(missing)", !!m && m[1] === want);
  }
  const t = (re) => re.test(toml);
  add("netlify.toml", "/assets/* immutable", ASSET_CACHE, t(/for = "\/assets\/\*"[\s\S]*?Cache-Control = "public, max-age=31536000, immutable"/) ? ASSET_CACHE : "(missing)", t(/for = "\/assets\/\*"[\s\S]*?Cache-Control = "public, max-age=31536000, immutable"/));
  add("netlify.toml", "/index.html no-cache", "no-cache", t(/for = "\/index\.html"[\s\S]*?Cache-Control = "no-cache"/) ? "no-cache" : "(missing)", t(/for = "\/index\.html"[\s\S]*?Cache-Control = "no-cache"/));
  add("netlify.toml", "NODE_VERSION pinned", "set", t(/^\s*NODE_VERSION = "\d+/m) ? "set" : "(missing)", t(/^\s*NODE_VERSION = "\d+/m));
} catch (e) {
  add("netlify.toml", "readable", "readable", String(e.message), false);
}

let home = null;
try {
  home = await get("/");
  eq("GET /", "status", "200", String(home.res.status));
  add("GET /", "Content-Type is HTML", "text/html", home.h("content-type") ?? "(missing)", /^text\/html\b/i.test(home.h("content-type") ?? ""));
  checkSecurity("GET /", home);
  cacheEq("GET /", "no-cache", home.h("cache-control"));

  const idx = await get("/index.html");
  // Some servers redirect /index.html to /; follow that for the header check.
  const idxFinal = idx.res.status >= 300 && idx.res.status < 400 ? home : idx;
  cacheEq("GET /index.html", "no-cache", idxFinal.h("cache-control"));
  checkSecurity("GET /index.html", idxFinal);
} catch (e) {
  add("GET /", "reachable", base, `unreachable: ${e.message}`, false);
}

if (home) {
  const m = /(?:src|href)="(\/assets\/[^"]+)"/.exec(home.body);
  if (m) {
    const a = await get(m[1]);
    const g = `GET ${m[1]}`;
    eq(g, "status", "200", String(a.res.status));
    checkSecurity(g, a);
    cacheEq(g, ASSET_CACHE, a.h("cache-control"));
  } else if (dev) {
    skip("GET /assets/*", "hashed asset", "--dev: the Vite dev server has no /assets files");
  } else {
    add("GET /assets/*", "a hashed asset is linked from /", "an /assets/ URL", "none found (is this a built site?)", false);
  }
}

try {
  // Invalid on purpose: the proxy rejects each of these itself, no outside service is called.
  const bad = await get("/api/geo/search?q=");
  checkProxyError("GET /api/geo/search?q= (bad query)", bad, 400, "bad-request");
  add("GET /api/geo/search?q= (bad query)", "CSP on this response (info)", "any", bad.h("content-security-policy") ? "present" : "absent", true);

  const tile = await get("/api/geo/tile/99/0/0.png");
  checkProxyError("GET /api/geo/tile/99/0/0.png (bad shape)", tile, 400, "bad-request");

  const terrain = await get("/api/geo/terrain/x/y/z.png");
  checkProxyError("GET /api/geo/terrain/x/y/z.png (bad shape)", terrain, 400, "bad-request");

  const nope = await get("/api/nope");
  checkProxyError("GET /api/nope", nope, 404, "not-found");

  const post = await get("/api/geo/search?q=x", { method: "POST", body: "x" });
  checkProxyError("POST /api/geo/search", post, 405, "bad-request");
} catch (e) {
  add("GET /api/*", "reachable", base, `unreachable: ${e.message}`, false);
}

// ---- report -------------------------------------------------------------------------------------------------

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const W = { check: 46, expected: 40, actual: 40 };
let lastGroup = "";
console.log(`verify-headers  base=${base}${dev ? "  (--dev)" : ""}\n`);
for (const r of rows) {
  if (r.group !== lastGroup) {
    console.log(`\n${r.group}`);
    console.log(`  ${"result".padEnd(6)} ${"check".padEnd(W.check)} ${"expected".padEnd(W.expected)} actual`);
    lastGroup = r.group;
  }
  const mark = r.skipped ? "SKIP" : r.ok ? "ok" : "FAIL";
  console.log(`  ${mark.padEnd(6)} ${clip(r.check, W.check).padEnd(W.check)} ${clip(r.expected, W.expected).padEnd(W.expected)} ${clip(r.actual, r.ok ? W.actual : W.actual * 2)}`);
}
const failed = rows.filter((r) => !r.ok);
const skipped = rows.filter((r) => r.skipped).length;
console.log(`\n${rows.length - failed.length - skipped} passed, ${failed.length} failed, ${skipped} skipped`);
if (failed.length) {
  console.log("\nFailures:");
  for (const r of failed) console.log(`  [${r.group}] ${r.check}\n      expected: ${r.expected}\n      actual:   ${r.actual}`);
  process.exit(1);
}
