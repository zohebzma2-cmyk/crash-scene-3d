// Tests for scripts/smoke.mjs that need no browser: the command line, the draft/production policy, the stored-ZIP
// reader, the PDF image sniff and the report formatter. The browser flow itself is run by hand against a deploy.
import { describe, expect, it } from "vitest";
import { ENGINES, MEDIA_CHECKS, crc32, formatReport, isDraftHost, missStatus, parseArgs, pdfHasImage, sha256, summarize, unzipStored } from "../smoke.mjs";

const PROD = "https://crash-scene-3d.netlify.app";
const DRAFT = "https://68e9c0ffabcd1200085f1234--crash-scene-3d.netlify.app";

describe("parseArgs", () => {
  it("needs a base URL", () => {
    expect(() => parseArgs([])).toThrow(/base URL is required/);
    expect(() => parseArgs(["--out", "x"])).toThrow(/base URL is required/);
  });

  it("defaults: both engines, smoke-out/, media required against production", () => {
    const o = parseArgs([PROD]);
    expect(o).toMatchObject({ baseUrl: PROD, out: "smoke-out", allowNoMedia: false, draft: false, engines: ["chromium", "webkit"], target: "production" });
  });

  it("strips a trailing slash and keeps a path", () => {
    expect(parseArgs([`${PROD}/`]).baseUrl).toBe(PROD);
    expect(parseArgs(["http://localhost:4631/sub/"]).baseUrl).toBe("http://localhost:4631/sub");
  });

  it("auto-detects a Netlify draft or deploy preview host", () => {
    expect(isDraftHost(DRAFT)).toBe(true);
    expect(isDraftHost("https://deploy-preview-12--crash-scene-3d.netlify.app")).toBe(true);
    expect(isDraftHost(PROD)).toBe(false);
    expect(isDraftHost("https://crash-scene-3d.netlify.app.evil.example")).toBe(false);
    const o = parseArgs([DRAFT]);
    expect(o.draft).toBe(true);
    expect(o.target).toBe("draft");
  });

  it("--draft forces draft mode on any host; --allow-no-media is separate", () => {
    expect(parseArgs([PROD, "--draft"])).toMatchObject({ draft: true, target: "draft", allowNoMedia: false });
    expect(parseArgs(["http://localhost:4631", "--allow-no-media"])).toMatchObject({ draft: false, target: "other", allowNoMedia: true });
  });

  it("--out and --engine, in both spellings; engines are deduplicated and validated", () => {
    expect(parseArgs([PROD, "--out", "tmp/x"]).out).toBe("tmp/x");
    expect(parseArgs([PROD, "--out=tmp/y"]).out).toBe("tmp/y");
    expect(parseArgs([PROD, "--engine", "webkit"]).engines).toEqual(["webkit"]);
    expect(parseArgs([PROD, "--engine=webkit", "--engine", "webkit", "--engine", "chromium"]).engines).toEqual(["webkit", "chromium"]);
    expect(() => parseArgs([PROD, "--engine", "firefox"])).toThrow(/chromium, webkit/);
    expect(() => parseArgs([PROD, "--out"])).toThrow(/--out needs a value/);
    expect(() => parseArgs([PROD, "--out", "--draft"])).toThrow(/--out needs a value/);
  });

  it("rejects unknown options, two URLs and non-http URLs", () => {
    expect(() => parseArgs([PROD, "--loop"])).toThrow(/Unknown option --loop/);
    expect(() => parseArgs([PROD, "http://localhost:4631"])).toThrow(/Only one base URL/);
    expect(() => parseArgs(["ftp://x"])).toThrow(/http\(s\)/);
    expect(() => parseArgs(["not a url"])).toThrow(/not a URL/);
  });

  it("--help short-circuits", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["-h"]).help).toBe(true);
  });

  it("knows both engines at the asked widths", () => {
    expect(ENGINES.chromium.width).toBe(1440);
    expect(ENGINES.webkit.width).toBe(390);
  });
});

describe("missStatus: what a media miss means", () => {
  it("fails in production", () => expect(missStatus({ draft: false, allowNoMedia: false })).toEqual({ status: "fail", note: null }));
  it("skips on a draft, naming the reason", () => expect(missStatus({ draft: true, allowNoMedia: false })).toEqual({ status: "skip", note: "not tested on draft (keys production-only)" }));
  it("skips with --allow-no-media", () => expect(missStatus({ draft: false, allowNoMedia: true }).status).toBe("skip"));
  it("draft wins over --allow-no-media in the wording", () => expect(missStatus({ draft: true, allowNoMedia: true }).note).toMatch(/draft/));
  it("--require-media makes a miss fail even on a draft", () => {
    expect(missStatus({ draft: true, allowNoMedia: false, requireMedia: true })).toEqual({ status: "fail", note: null });
    expect(parseArgs([DRAFT, "--require-media"])).toMatchObject({ draft: true, requireMedia: true });
    expect(() => parseArgs([DRAFT, "--require-media", "--allow-no-media"])).toThrow(/contradict/);
  });
  it("lists the six media checks", () => expect([...MEDIA_CHECKS].sort()).toEqual(["glb", "logo-A", "logo-B", "photo-A", "photo-B", "save-pdf-photo"]));
});

/** A stored ZIP with these entries, written the way packages/exports/src/zip.ts writes one. */
function storedZip(entries) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const n = enc.encode(name), d = enc.encode(text), crc = crc32(d);
    const local = new Uint8Array(30 + n.length + d.length);
    const v = new DataView(local.buffer);
    v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true); v.setUint16(6, 0x0800, true); v.setUint16(8, 0, true);
    v.setUint32(14, crc, true); v.setUint32(18, d.length, true); v.setUint32(22, d.length, true); v.setUint16(26, n.length, true);
    local.set(n, 30); local.set(d, 30 + n.length);
    parts.push(local);
    const c = new Uint8Array(46 + n.length);
    const cv = new DataView(c.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true); cv.setUint16(10, 0, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, d.length, true); cv.setUint32(24, d.length, true); cv.setUint16(28, n.length, true); cv.setUint32(42, offset, true);
    c.set(n, 46);
    central.push(c);
    offset += local.length;
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true); ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + cdSize + 22);
  let o = 0;
  for (const p of [...parts, ...central, eocd]) { out.set(p, o); o += p.length; }
  return out;
}

describe("unzipStored", () => {
  it("reads names and bytes back and checks the CRC", () => {
    const zip = storedZip([["crash-scene-x.json", "{\"a\":1}"], ["crash-scene-x.pdf", "%PDF-1.7 fake"]]);
    const files = unzipStored(zip);
    expect([...files.keys()]).toEqual(["crash-scene-x.json", "crash-scene-x.pdf"]);
    expect(files.get("crash-scene-x.json").toString("utf8")).toBe("{\"a\":1}");
    expect(sha256(files.get("crash-scene-x.json"))).toBe(sha256(Buffer.from("{\"a\":1}")));
  });
  it("refuses a damaged entry and a non-zip", () => {
    const zip = storedZip([["a.txt", "hello"]]);
    zip[30 + 5 + 1] ^= 0xff;   // flip a data byte
    expect(() => unzipStored(zip)).toThrow(/bad CRC/);
    expect(() => unzipStored(new Uint8Array(40))).toThrow(/not a zip/);
  });
});

describe("pdfHasImage", () => {
  it("sees an image XObject and nothing else", () => {
    expect(pdfHasImage(Buffer.from("%PDF-1.7\n1 0 obj << /Type /XObject /Subtype /Image /Width 10 >>"))).toBe(true);
    expect(pdfHasImage(Buffer.from("%PDF-1.7\n1 0 obj << /Type /XObject /Subtype/Image >>"))).toBe(true);
    expect(pdfHasImage(Buffer.from("%PDF-1.7\n1 0 obj << /Type /Font /Subtype /TrueType >>"))).toBe(false);
  });
});

function sampleReport({ fail = false } = {}) {
  const engines = [
    {
      name: "chromium", label: "Chromium 1440", viewport: "1440x900", totalMs: 61_200, welcomeDialog: true, ignoredConsole: 0,
      checks: [
        { id: "load", status: "pass", ms: 1200, note: "welcome dialog shown and dismissed" },
        { id: "location", status: "pass", ms: 4300, note: "pin at 42.76, -71.46" },
        { id: "photo-A", status: fail ? "fail" : "pass", ms: 900, ...(fail ? { error: "vehicle A (2019 Chevrolet Silverado 1500): stock photo state \"icon\", img naturalWidth 0" } : {}) },
        { id: "glb", status: "pass", ms: 15 },
        { id: "no-errors", status: "pass", ms: 0 },
      ],
      media: [{ status: 200, path: "/api/logos/make?make=Chevrolet", type: "image/svg+xml", fallback: "", image: "" }, { status: 200, path: "/api/vehicles/model?make=Chevrolet&model=Silverado+1500&year=2019", type: "model/gltf-binary", fallback: "", image: "" }],
      consoleErrors: [], pageErrors: [], cspViolations: [],
    },
    {
      name: "webkit", label: "WebKit 390", viewport: "390x844", totalMs: 83_000, welcomeDialog: false, ignoredConsole: 0,
      checks: [
        { id: "load", status: "pass", ms: 2100, note: "no welcome dialog" },
        { id: "location", status: "pass", ms: 5100 },
        { id: "photo-A", status: "skip", ms: 30_100, note: "not tested on draft (keys production-only): vehicle A: stock photo state \"icon\"" },
        { id: "glb", status: "skip", ms: 15_000, note: "not tested on draft (keys production-only): the page never asked /api/vehicles/model" },
        { id: "review-measure", status: "skip", ms: 20, note: "no Measure tab" },
        { id: "no-errors", status: "fail", ms: 0, error: "1 error(s); first: csp: style-src-elem blocked inline" },
      ],
      media: [], consoleErrors: [], pageErrors: [], cspViolations: [{ directive: "style-src-elem", blocked: "inline", source: "https://x/", line: 1 }],
    },
  ];
  const { counts, ok } = summarize(engines);
  return { baseUrl: DRAFT, startedAt: "2026-10-12T15:00:00.000Z", totalMs: 144_200, target: "draft", apiPresent: true, mediaPolicy: "SKIP, not tested on draft (keys production-only)", sha: "abc1234", counts, ok, engines };
}

describe("summarize", () => {
  it("counts per status and fails on any FAIL (SKIPs are fine)", () => {
    const r = sampleReport();
    expect(r.counts).toEqual({ pass: 7, fail: 1, skip: 3 });
    expect(r.ok).toBe(false);
    const clean = { engines: r.engines.map((e) => ({ ...e, checks: e.checks.filter((c) => c.status !== "fail") })) };
    expect(summarize(clean.engines).ok).toBe(true);
  });
});

describe("formatReport", () => {
  const md = formatReport(sampleReport());
  const lines = md.split("\n");

  it("heads with the result, the target and the media policy", () => {
    expect(lines[0]).toBe(`# Smoke: ${DRAFT}`);
    expect(md).toContain("Result: **FAIL** (1 failed, 3 skipped, 7 passed) in 144s");
    expect(md).toContain("target: draft; media on a miss: SKIP, not tested on draft (keys production-only); /api on this origin: yes");
    expect(md).toContain("Script at commit: abc1234");
  });

  it("has one column per engine and one row per check, in first-seen order, with timings", () => {
    expect(md).toContain("| Check | Chromium 1440 | WebKit 390 |");
    const rows = lines.filter((l) => l.startsWith("| ")).slice(1);
    expect(rows.map((r) => r.split("|")[1].trim())).toEqual(["load", "location", "photo-A", "glb", "no-errors", "review-measure", "total"]);
    expect(md).toContain("| load | PASS 1.2s | PASS 2.1s |");
    expect(md).toContain("| photo-A | PASS 900ms | SKIP 30s (not tested on draft (keys production-only): vehicle A: stock photo state \"icon\") |");
    expect(md).toContain("| review-measure | — | SKIP 20ms (no Measure tab) |");
    expect(md).toContain("| total | 61s | 83s |");
  });

  it("lists the first error text per failed check and every media response", () => {
    expect(md).toContain("## First errors\n\n- WebKit 390 / no-errors: 1 error(s); first: csp: style-src-elem blocked inline");
    expect(md).toContain("- 200 /api/vehicles/model?make=Chevrolet&model=Silverado+1500&year=2019 model/gltf-binary");
    expect(md).toContain("### WebKit 390\n\n- none seen");
    expect(md).toContain("welcome dialog (\"See what happened\"): shown, dismissed");
    expect(md).toContain("welcome dialog (\"See what happened\"): not shown");
    expect(md).toContain("- csp: style-src-elem blocked inline at https://x/:1");
  });

  it("prints 'none' under errors when everything passed", () => {
    const r = sampleReport();
    r.engines[1].checks = r.engines[1].checks.filter((c) => c.status !== "fail");
    expect(formatReport(r)).toContain("## First errors\n\n- none");
  });

  it("clips a long error to one line", () => {
    const r = sampleReport({ fail: true });
    r.engines[0].checks[2].error = "line one\nline two " + "x".repeat(600);
    const out = formatReport(r);
    const line = out.split("\n").find((l) => l.startsWith("- Chromium 1440 / photo-A:"));
    expect(line).toContain("line one line two");
    expect(line.length).toBeLessThan(450);
  });
});
