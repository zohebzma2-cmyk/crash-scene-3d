import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_LIMIT_MPH, DISCLAIMER_LONG, DISCLAIMER_SHORT, MPH_TO_MPS, PRESETS, RANGE_HALF_MPH, canonicalJson, formatDistance, formatSpeed, formatStamp,
  parseSceneFile, shortFingerprint,
} from "@csd/core";
import type { ExportBundle, ExportRequest, Scene, SimulationResult } from "@csd/core";
import { buildExports, footerBandHeight, sceneFile } from "../src";
import { about } from "../src/about";
import { planDiagram, planRoadOutline, scaleBars } from "../src/diagram";
import { buildModel, approachPhrase, fileClaim, printable, speedInputs } from "../src/model";
import { buildPdf, MIN_DIAGRAM_TEXT_PT, MIN_TEXT_PT, type PdfResult } from "../src/pdf";
import { renderBand, renderDiagramPng, renderStillPng } from "../src/png";
import { MAX_PNG_SIDE, decodePng } from "../src/png-decode";
import { color, rgb01 } from "../src/style";
import { MONO, SANS, brandFonts, brandMeasure, createSolidPng, latin1, makePng, readPdf, renderPdfPage, saveOutput, syntheticPng, testCanvas, withPngText } from "./helpers";
import { loadRoads } from "./osm-roads";
import { fourVehicle, manyShortWarnings, stress, twoVehicle } from "./sim-fixtures";
// @ts-expect-error plain .mjs without types
import { buildTokensSource, generate } from "../scripts/generate.mjs";

const NOW = new Date("2026-10-09T20:52:18.456Z");
const CREATED = "2026-10-09T20:52:18Z";
const ALL = ["json", "pdf", "png-diagram", "png-impact", "png-rest"] as const;
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const countOf = (text: string, part: string) => text.split(part).length - 1;
const PAGE_MARGIN_PT = 36;

function req(scene: Scene, sim: SimulationResult, extra: Partial<ExportRequest> = {}): ExportRequest {
  return {
    scene, sim, roads: loadRoads("t-bone-intersection", scene.location), formats: ALL,
    fonts: brandFonts(), now: () => NOW,
    stills: { impact: syntheticPng(960, 492, "impact"), rest: syntheticPng(960, 492, "rest") },
    mapThumbnail: syntheticPng(800, 600, "synthetic map"),
    ...extra,
  };
}
const file = (b: ExportBundle, suffix: string) => {
  const f = b.files.find((x) => x.name.endsWith(suffix));
  if (!f) throw new Error(`no file ending ${suffix}: ${b.files.map((x) => x.name).join(", ")}`);
  return f;
};

/** Build just the PDF, with its layout report. */
async function makePdf(scene: Scene, sim: SimulationResult, opts: { thumb?: boolean; thumbBytes?: Uint8Array; noRoads?: boolean } = {}): Promise<{ r: PdfResult; read: Awaited<ReturnType<typeof readPdf>> }> {
  const { stamp } = await sceneFile(scene, sim, CREATED);
  const model = buildModel(scene, sim, stamp);
  const r = await buildPdf({
    model, scene, sim, roads: opts.noRoads ? null : loadRoads("t-bone-intersection", scene.location), fonts: brandFonts(), createdAt: CREATED,
    sceneFileName: `crash-scene-${fileClaim(scene.claim.number)}.json`,
    ...(opts.thumb === false ? {} : { mapThumbnail: opts.thumbBytes ?? syntheticPng(800, 600, "map") }),
  });
  return { r, read: await readPdf(r.bytes) };
}

/** Every page: nothing but the footer in the footer's band, the footer inside the margins, text no smaller than allowed. */
async function expectSafePages(r: PdfResult) {
  r.report.forEach((p, i) => {
    expect(p.bodyBottom, `page ${i + 1} body bottom vs footer top`).toBeLessThan(p.footerTop - 0.5);
    expect(p.footerBottom, `page ${i + 1} footer bottom`).toBeLessThanOrEqual(p.height - PAGE_MARGIN_PT + 1);
    expect(p.minTextPt, `page ${i + 1} text size`).toBeGreaterThanOrEqual(MIN_TEXT_PT - 1e-6);
    if (Number.isFinite(p.minDiagramTextPt)) expect(p.minDiagramTextPt, `page ${i + 1} diagram text size`).toBeGreaterThanOrEqual(MIN_DIAGRAM_TEXT_PT - 1e-6);
  });
  // The same thing from the rendered page, not from what the layout says it drew: the gap is blank.
  for (let i = 0; i < r.report.length; i++) {
    const p = r.report[i]!;
    const img = await renderPdfPage(r.bytes, i + 1, 2);
    const blankRows = (from: number, to: number) => {
      for (let y = Math.ceil(from); y < Math.floor(to); y++) {
        for (let x = 0; x < img.width; x++) {
          const o = (y * img.width + x) * 4;
          if (img.data[o]! < 250 || img.data[o + 1]! < 250 || img.data[o + 2]! < 250) return false;
        }
      }
      return true;
    };
    expect(blankRows(p.bodyBottom * 2 + 3, p.footerTop * 2 - 3), `page ${i + 1}: something is drawn between the body and the footer`).toBe(true);
    expect(blankRows(p.footerBottom * 2 + 3, img.height), `page ${i + 1}: something is drawn below the footer`).toBe(true);
  }
}

describe("scene file (DESIGN.md section 8)", () => {
  it("is canonical JSON, hashes to the stamp and parses back", async () => {
    const { scene, sim } = twoVehicle();
    const { text, stamp } = await sceneFile(scene, sim, CREATED);
    expect(stamp.createdAt).toBe(CREATED);
    expect(stamp.fingerprintHex).toBe(sha(new TextEncoder().encode(text)));
    expect(stamp.fingerprintShort).toBe(shortFingerprint(stamp.fingerprintHex));
    expect(stamp.fingerprintShort).toMatch(/^[0-9a-f]{4}( [0-9a-f]{4}){3}$/);
    const parsed = JSON.parse(text);
    expect(text).toBe(canonicalJson(parsed));
    expect(parsed.disclaimer).toBe(DISCLAIMER_LONG);
    expect(parsed.createdAt).toBe(CREATED);
    const r = parseSceneFile(new TextEncoder().encode(text));
    expect(r.ok ? [] : r.errors).toEqual([]);
    if (r.ok) {
      expect(r.value.claim.number).toBe(scene.claim.number);
      expect(r.value.vehicles).toHaveLength(2);
      expect(r.value.disclaimer).toBe(DISCLAIMER_LONG);
    }
  });

  it("has physicsVersion and road.friction at the top, and the speed fields per vehicle from the inputs", async () => {
    const { scene, sim } = twoVehicle();
    const parsed = JSON.parse((await sceneFile(scene, sim, CREATED)).text);
    expect(parsed.physicsVersion).toBe(sim.physicsVersion);
    expect(parsed.road).toEqual({ condition: scene.road.condition, friction: sim.frictionCoefficient });
    const [a, b] = scene.vehicles;
    const [va, vb] = parsed.vehicles;
    if (a!.speed.kind !== "known" || b!.speed.kind !== "unsure") throw new Error("fixture changed");
    // known speed: the entered value, no limit; drawn the same
    expect(va).toMatchObject({
      id: "A", speedSource: "claimant", postedLimitMph: null, postedLimitSource: null,
      speedRangeMph: { lo: a!.speed.mph, mid: a!.speed.mph, hi: a!.speed.mph }, speedUsedMph: a!.speed.mph,
      speedShownRangeMph: { lo: a!.speed.mph, mid: a!.speed.mph, hi: a!.speed.mph },
    });
    // not sure and no limit given: the default limit plus and minus the range
    expect(vb).toMatchObject({
      id: "B", speedSource: "not-sure", postedLimitMph: DEFAULT_LIMIT_MPH, postedLimitSource: "default-25",
      speedRangeMph: { lo: DEFAULT_LIMIT_MPH - RANGE_HALF_MPH, mid: DEFAULT_LIMIT_MPH, hi: DEFAULT_LIMIT_MPH + RANGE_HALF_MPH }, speedUsedMph: DEFAULT_LIMIT_MPH,
      speedShownRangeMph: { lo: DEFAULT_LIMIT_MPH - RANGE_HALF_MPH, mid: DEFAULT_LIMIT_MPH, hi: DEFAULT_LIMIT_MPH + RANGE_HALF_MPH },
    });
    // the original scene fields are all still there
    expect(va.make).toBe(a!.make);
    expect(vb.zone).toBe(b!.zone);
  });

  it("uses the limit the claimant gave, and says so; the entered range and the drawn range are both kept", async () => {
    const { scene, sim } = twoVehicle();
    const s2: Scene = { ...scene, vehicles: scene.vehicles.map((v, i) => (i === 1 ? { ...v, speed: { kind: "unsure" as const, limitMph: 30 } } : v)) };
    const vb = JSON.parse((await sceneFile(s2, sim, CREATED)).text).vehicles[1];
    // entered: the limit given plus and minus the range
    expect(vb).toMatchObject({ postedLimitMph: 30, postedLimitSource: "claimant", speedRangeMph: { lo: 30 - RANGE_HALF_MPH, mid: 30, hi: 30 + RANGE_HALF_MPH } });
    // drawn: what the physics result holds (the fixture ran the default limit)
    const shown = sim.vehicles[1]!.speedAtImpactMps;
    expect(vb.speedUsedMph).toBeCloseTo(shown.mid / MPH_TO_MPS, 3);
    expect(vb.speedShownRangeMph.lo).toBeCloseTo(shown.lo / MPH_TO_MPS, 3);
    expect(vb.speedShownRangeMph.hi).toBeCloseTo(shown.hi / MPH_TO_MPS, 3);
  });

  it("keeps the physics outputs (assumptions, warnings, weights with an honest source) under derived", async () => {
    const { scene, sim } = fourVehicle();
    const d = JSON.parse((await sceneFile(scene, sim, CREATED)).text).derived;
    expect(d.physicsVersion).toBe(sim.physicsVersion);
    expect(d.frictionCoefficient).toBe(sim.frictionCoefficient);
    expect(d.restitution).toBe(sim.restitution);
    expect(d.assumptions).toEqual(sim.assumptions);
    expect(d.warnings).toEqual(sim.warnings.map((w) => ({ code: w.code, text: w.text })));
    expect(d.vehicles.map((v: { id: string }) => v.id)).toEqual(["A", "B", "C", "D"]);
    d.vehicles.forEach((v: { massKg: number; massSource: string }, i: number) => {
      const preset = PRESETS[scene.vehicles[i]!.type];
      expect(v.massKg).toBe(sim.vehicles[i]!.massKg);
      expect(v.massSource).toContain(preset.mass.source);
      expect(v.massSource).toMatch(/^Typical weight for a /);
      expect(v.massSource).not.toContain("supplied");
    });
  });

  it("round-trips for 4 vehicles too", async () => {
    const { scene, sim } = fourVehicle();
    const { text } = await sceneFile(scene, sim, CREATED);
    expect(parseSceneFile(new TextEncoder().encode(text)).ok).toBe(true);
  });
});

describe("one save", () => {
  let two: ExportBundle;
  let tc: ReturnType<typeof testCanvas>;
  let fx: ReturnType<typeof twoVehicle>;
  beforeAll(async () => {
    fx = twoVehicle();
    tc = testCanvas();
    two = await buildExports(req(fx.scene, fx.sim), tc.factory);
    for (const f of two.files) saveOutput(`2-vehicles-${f.name.replace(/^crash-scene-/, "")}`, f.bytes);
  }, 60_000);

  it("names the files from the claim number", () => {
    expect(two.files.map((f) => f.name).sort()).toEqual([
      "crash-scene-CLM-EX-1001-diagram.png", "crash-scene-CLM-EX-1001-final-rest.png", "crash-scene-CLM-EX-1001-impact.png",
      "crash-scene-CLM-EX-1001.json", "crash-scene-CLM-EX-1001.pdf",
    ]);
    expect(file(two, ".pdf").mime).toBe("application/pdf");
    expect(file(two, ".json").mime).toBe("application/json");
    expect(two.skipped).toEqual([]);
    expect(two.notes).toEqual([]);
  });

  it("uses the injected clock once, with seconds precision", () => {
    expect(two.stamp.createdAt).toBe(CREATED);
    expect(JSON.parse(new TextDecoder().decode(file(two, ".json").bytes)).createdAt).toBe(CREATED);
  });

  it("fingerprints the exact bytes of the JSON file", () => {
    const json = file(two, ".json").bytes;
    expect(two.stamp.fingerprintHex).toBe(sha(json));
    expect(parseSceneFile(json).ok).toBe(true);
  });

  it("prints the same stamp in the PDF text and in every PNG footer", async () => {
    const pdf = await readPdf(file(two, ".pdf").bytes);
    expect(pdf.text).toContain(two.stamp.fingerprintHex);
    expect(pdf.text).toContain(two.stamp.fingerprintShort);
    expect(pdf.text).toContain(CREATED);
    expect(pdf.text).toContain(formatStamp(CREATED));
    const drawn = tc.drawn.map((d) => d.text);
    expect(drawn.filter((t) => t === `Fingerprint ${two.stamp.fingerprintShort}`)).toHaveLength(3);
    expect(drawn.filter((t) => t === formatStamp(CREATED))).toHaveLength(3);
    expect(drawn.filter((t) => t === CREATED)).toHaveLength(3);
  });

  it("puts the short disclaimer on the PNGs and the long one on the PDF", async () => {
    const pdf = await readPdf(file(two, ".pdf").bytes);
    expect(pdf.text).toContain(DISCLAIMER_LONG);
    const joined = norm(tc.drawn.map((d) => d.text).join(" "));
    for (const w of DISCLAIMER_SHORT.split(" ")) expect(joined).toContain(w);
    expect(tc.drawn.filter((d) => d.text.startsWith("Illustration only")).length).toBeGreaterThanOrEqual(3);
  });

  it("captions the 3D stills", () => {
    const drawn = tc.drawn.map((d) => d.text);
    expect(drawn).toContain("Moment of impact");
    expect(drawn).toContain("Final rest");
  });

  it("gives the PNGs the right sizes: every still is fitted to 1920 x 1080 with its band", async () => {
    const dim = async (name: string) => { const p = await decodePng(file(two, name).bytes); return [p.width, p.height]; };
    expect(await dim("-diagram.png")).toEqual([1600, 1600]);
    expect(await dim("-impact.png")).toEqual([1920, 1080]);
    expect(await dim("-final-rest.png")).toEqual([1920, 1080]);
    // the app's capture of 1920 x (1080 - band) fills the frame exactly
    const full = await buildExports(req(fx.scene, fx.sim, { formats: ["png-impact"], stills: { impact: syntheticPng(1920, 1080 - footerBandHeight(), "full") } }), testCanvas().factory);
    const p = await decodePng(file(full, "-impact.png").bytes);
    expect([p.width, p.height]).toEqual([1920, 1080]);
  });

  it("draws every PNG text in the brand fonts, which were registered", async () => {
    expect(tc.registered.map((r) => r.family).sort()).toEqual([MONO, SANS, SANS].sort());
    expect(tc.drawn.length).toBeGreaterThan(20);
    for (const d of tc.drawn) expect(d.font, d.text).toMatch(new RegExp(`"(${SANS}|${MONO})"`));
    expect(tc.drawn.some((d) => d.font.includes(MONO))).toBe(true);
    expect(tc.drawn.some((d) => d.font.startsWith("700 ") && d.font.includes(SANS))).toBe(true);
    const { GlobalFonts, createCanvas } = await import("@napi-rs/canvas");
    expect(GlobalFonts.families.some((f) => f.family === SANS)).toBe(true);
    expect(GlobalFonts.families.some((f) => f.family === MONO)).toBe(true);
    const ctx = createCanvas(10, 10).getContext("2d");
    const w = (font: string) => { ctx.font = font; return ctx.measureText("Illustration only. This shows what you described.").width; };
    expect(w(`700 24px "${SANS}"`)).not.toBeCloseTo(w(`700 24px "No Such Font Family"`), 0);
    expect(w(`400 24px "${MONO}"`)).not.toBeCloseTo(w(`700 24px "${SANS}"`), 0);
  });

  it("the PDF has one page, embeds the brand fonts and prints the numbers from the result with 'about'", async () => {
    const bytes = file(two, ".pdf").bytes;
    const pdf = await readPdf(bytes);
    expect(pdf.pages).toBe(1);
    const raw = latin1(bytes);
    expect(raw).toMatch(/\/FontName \/[A-Za-z+-]*PlusJakartaSans-Regular/);
    expect(raw).toMatch(/\/FontName \/[A-Za-z+-]*PlusJakartaSans-Bold/);
    expect(raw).toMatch(/\/FontName \/[A-Za-z+-]*JetBrainsMono-Regular/);
    expect(raw).toMatch(/\/FontFile[23]? /);
    expect(raw).not.toMatch(/\/BaseFont \/(Helvetica|Times|Courier)/);
    for (const a of fx.sim.assumptions) expect(pdf.text).toContain(norm(a.text));
    for (const rv of fx.sim.vehicles) {
      expect(pdf.text).toContain(about(formatDistance(rv.postImpactDistanceM).text));
      expect(pdf.text).toContain(about(formatDistance(rv.approachDistanceM).text));
      expect(pdf.text).toContain(about(formatSpeed(rv.speedAtImpactMps, { both: true }).text));
    }
    for (const g of fx.sim.gaps) expect(pdf.text).toContain(about(formatDistance(g.restGapM).text));
    expect(pdf.text).toContain("Crash scene illustration");
    expect(pdf.text).toContain("Claim CLM-EX-1001");
    expect(pdf.text).toContain("© OpenStreetMap contributors");
    // the check text is exactly the wording from the design
    expect(pdf.text).toContain("How to check this file");
    expect(pdf.text).toContain("Hash the scene file with SHA-256. If it doesn't match, the scene was changed after export.");
    expect(pdf.text).toContain("crash-scene-CLM-EX-1001.json");
    // "Picture uses" comes from the speed the claimant entered (the default limit), formatted through the core formatter
    const used = speedInputs(fx.scene.vehicles[1]!).usedMph;
    expect(pdf.text).toContain(`Picture uses ${about(formatSpeed(used * MPH_TO_MPS).text)}.`);
    expect(pdf.text).toContain("Westbound on Park Street");
    expect(pdf.text).toContain("center to center");
    expect(pdf.text).not.toContain("centre");
  });

  it("is deterministic for the same inputs", async () => {
    const again = await buildExports(req(fx.scene, fx.sim), testCanvas().factory);
    expect(again.stamp).toEqual(two.stamp);
    expect(Buffer.from(file(again, ".pdf").bytes).equals(Buffer.from(file(two, ".pdf").bytes))).toBe(true);
    expect(Buffer.from(file(again, "-diagram.png").bytes).equals(Buffer.from(file(two, "-diagram.png").bytes))).toBe(true);
  });
});

describe("the scene file always travels with the PDF and PNGs", () => {
  it("adds it, with a note, when only a PDF or PNG was asked for", async () => {
    const { scene, sim } = twoVehicle();
    for (const formats of [["pdf"], ["png-diagram"], ["pdf", "png-diagram"]] as const) {
      const b = await buildExports(req(scene, sim, { formats }), testCanvas().factory);
      expect(b.files.some((f) => f.name.endsWith(".json")), formats.join()).toBe(true);
      expect(b.notes).toContain("The scene file was added so the fingerprint on the other files can be checked.");
      expect(sha(file(b, ".json").bytes)).toBe(b.stamp.fingerprintHex);
    }
  }, 30_000);
  it("says nothing extra when the JSON was asked for", async () => {
    const { scene, sim } = twoVehicle();
    const b = await buildExports(req(scene, sim, { formats: ["json", "pdf"] }), testCanvas().factory);
    expect(b.files).toHaveLength(2);
    expect(b.notes).toEqual([]);
  });
});

describe("PDF pages", () => {
  it("is one page for 2 vehicles with the normal lists, and nothing touches the footer", async () => {
    const { scene, sim } = twoVehicle();
    const { r, read } = await makePdf(scene, sim);
    saveOutput("page-2-vehicles.pdf", r.bytes);
    expect(r.pages).toBe(1);
    expect(read.pages).toBe(1);
    expect(r.mode).toBe("one-page");
    expect(read.text).not.toContain("Page 1 of");
    expect(read.text).not.toContain("continued on page 2");
    for (const a of sim.assumptions) expect(read.text).toContain(norm(a.text));
    await expectSafePages(r);
  });

  it("keeps the diagram at least MIN_DIAGRAM_FRACTION (0.3) of the room between header and footer", async () => {
    const { scene, sim } = twoVehicle();
    const { r } = await makePdf(scene, sim);
    const p = r.report[0]!;
    // the diagram's drawn extent is the biggest thing in the body
    const dia = p.extents.diagram;
    const room = p.footerTop - 36 - 56;
    expect(dia.maxY - dia.minY).toBeGreaterThanOrEqual(room / 3 - 6);
  });

  it("moves the full assumptions and warnings to page 2 when 30 warnings can't fit, repeating header and footer", async () => {
    const { scene, sim } = manyShortWarnings(30);
    const { r, read } = await makePdf(scene, sim);
    saveOutput("page-30-warnings.pdf", r.bytes);
    expect(r.pages).toBe(2);
    expect(r.mode).toBe("overflow");
    expect(read.pages).toBe(2);
    expect(read.text).toContain("Page 1 of 2");
    expect(read.text).toContain("Page 2 of 2");
    // the warnings move too, so page 1 says so
    expect(read.pageTexts[0]).toContain("Assumptions and details that may not fit together continued on page 2");
    expect(r.notes.join(" ")).toContain("assumptions and details that may not fit together continue on page 2");
    // every assumption and every warning is there, in full
    for (const a of sim.assumptions) expect(read.text).toContain(norm(a.text));
    for (const w of sim.warnings) expect(read.text).toContain(norm(w.text));
    // the header and the whole footer are on every page
    expect(countOf(read.text, "Crash scene illustration")).toBeGreaterThanOrEqual(2);
    expect(countOf(read.text, "Claim CLM-EX-1001")).toBe(2);
    expect(countOf(read.text, DISCLAIMER_LONG)).toBe(2);
    expect(countOf(read.text, "How to check this file")).toBe(2);
    const { stamp } = await sceneFile(scene, sim, CREATED);
    expect(countOf(read.text, stamp.fingerprintHex)).toBe(2);
    expect(countOf(read.text, stamp.fingerprintShort)).toBe(2);
    expect(countOf(read.text, formatStamp(CREATED))).toBe(2);
    expect(r.notes.join(" ")).toMatch(/continue on page 2/);
    await expectSafePages(r);
  }, 60_000);

  it("keeps going to more pages for a truly huge set, never dropping a line", async () => {
    const { scene, sim } = stress(30);
    const { r, read } = await makePdf(scene, sim);
    saveOutput("page-stress.pdf", r.bytes);
    expect(r.pages).toBeGreaterThanOrEqual(3);
    expect(read.pages).toBe(r.pages);
    for (const a of sim.assumptions) expect(read.text).toContain(norm(a.text));
    for (const w of sim.warnings) expect(read.text).toContain(norm(w.text));
    expect(countOf(read.text, DISCLAIMER_LONG)).toBe(r.pages);
    for (let i = 1; i <= r.pages; i++) expect(read.text).toContain(`Page ${i} of ${r.pages}`);
    await expectSafePages(r);
  }, 90_000);

  it("fits 4 vehicles with 3 warnings on one page or moves the lists cleanly", async () => {
    const { scene, sim } = fourVehicle();
    const { r, read } = await makePdf(scene, sim);
    saveOutput("page-4-vehicles.pdf", r.bytes);
    for (const a of sim.assumptions) expect(read.text).toContain(norm(a.text));
    for (const w of sim.warnings) expect(read.text).toContain(norm(w.text));
    for (const rv of sim.vehicles) expect(read.text).toContain(about(formatDistance(rv.postImpactDistanceM).text));
    if (r.pages > 1) expect(read.pageTexts[0]).toMatch(/continued on page 2/);
    await expectSafePages(r);
  }, 60_000);

  it("never prints 'last 0 s'", () => {
    const { sim } = twoVehicle();
    expect(approachPhrase({ ...sim, startTimeS: -2 })).toBe("last 2 s");
    expect(approachPhrase({ ...sim, startTimeS: -0.3 })).toBe("under 1 s");
    expect(approachPhrase({ ...sim, startTimeS: 0 })).toBe("under 1 s");
  });
});

describe("real physics output (test/data/real-sims.json)", () => {
  const real = JSON.parse(readFileSync(new URL("./data/real-sims.json", import.meta.url), "utf8")) as Record<string, { scene: Scene; sim: SimulationResult }>;
  const names = Object.keys(real);

  it("has the three examples", () => {
    expect([...names].sort()).toEqual(["highway-rear-end", "parking-lot-backing", "t-bone-intersection"]);
  });

  for (const name of names) {
    it(`${name}: one page, every assumption present, no replaced glyphs, nothing under 8 pt or over the footer`, async () => {
      const { scene, sim } = real[name]!;
      const { stamp } = await sceneFile(scene, sim, CREATED);
      const model = buildModel(scene, sim, stamp);
      const r = await buildPdf({
        model, scene, sim, roads: loadRoads(name, scene.location), fonts: brandFonts(), createdAt: CREATED,
        sceneFileName: `crash-scene-${fileClaim(scene.claim.number)}.json`, mapThumbnail: syntheticPng(800, 600, "map"),
      });
      saveOutput(`real-${name}.pdf`, r.bytes);
      const read = await readPdf(r.bytes);
      expect(sim.assumptions.length).toBeGreaterThan(8);
      expect(r.pages, `${name} should fit one page`).toBe(1);
      expect(read.pages).toBe(1);
      for (const a of sim.assumptions) expect(read.text, a.id).toContain(norm(printable(a.text)));
      for (const w of sim.warnings) expect(read.text).toContain(norm(printable(w.text)));
      expect(read.text).not.toContain("?");
      expect(r.notes.join(" ")).not.toMatch(/couldn't be printed/);
      expect(r.report[0]!.minTextPt).toBeGreaterThanOrEqual(MIN_TEXT_PT - 1e-6);
      await expectSafePages(r);
    }, 60_000);
  }

  it("shows the speed at impact as entered, and what a braking vehicle slowed from (highway-rear-end)", async () => {
    const { scene, sim } = real["highway-rear-end"]!;
    const a = scene.vehicles[0]!;
    if (a.speed.kind !== "known" || !a.braking) throw new Error("data changed: expected A known and braking");
    const { read } = await makePdf(scene, sim);
    expect(read.text).toContain("Speed at impact, as entered");
    // the speed shown is the typed speed, through the formatter: for a known speed the physics works back from it, so it is the speed at impact
    for (const [name2, { scene: sc, sim: sm }] of Object.entries(real)) {
      const { read: rd } = name2 === "highway-rear-end" ? { read } : await makePdf(sc, sm);
      sc.vehicles.forEach((v, i) => {
        if (v.action === "parked" || v.speed.kind !== "known") return;
        expect(rd.text, `${name2} ${v.id}`).toContain(about(formatSpeed(v.speed.mph * MPH_TO_MPS, { both: true }).text));
        // and it is what the physics says too
        expect(sm.vehicles[i]!.speedAtImpactMps.mid / MPH_TO_MPS).toBeCloseTo(v.speed.mph, 3);
      });
    }
    // a braking vehicle says what it slowed from: the first sample of its track, and that is higher than the speed at impact
    scene.vehicles.forEach((v, i) => {
      if (!v.braking) return;
      const rv = sim.vehicles[i]!;
      expect(rv.track[0]!.speedMps).toBeGreaterThan(rv.speedAtImpactMps.mid);
      expect(read.text).toContain(`Braking: slowed from ${about(formatSpeed(rv.track[0]!.speedMps).text)}`);
    });
    // and none of the copy that can't happen any more
    expect(read.text).not.toContain("stopped before impact");
    expect(read.text).not.toMatch(/Braking: about/);
  });

  it("adds no braking line when the speed at impact is the speed used (t-bone)", async () => {
    const { scene, sim } = real["t-bone-intersection"]!;
    const { read } = await makePdf(scene, sim);
    expect(read.text).not.toContain("Braking:");
    expect(read.text).toContain("Not sure.");
  });

  it("writes symbols the font lacks as words instead of '?'", () => {
    expect(printable("sedan/wagon \u2248 3,550 lb")).toBe("sedan/wagon about 3,550 lb");
    expect(printable("a \u2264 b \u2265 c")).toBe("a at most b at least c");
  });
});

describe("PNG footer band and stills", () => {
  const widths: Array<[number, number, string]> = [[400, 225, "400 x 225"], [1920, 933, "1920 x 933"]];
  for (const [w, h, name] of widths) {
    it(`keeps the band text inside the band for a ${name} still`, async () => {
      const { scene, sim } = twoVehicle();
      const { stamp } = await sceneFile(scene, sim, CREATED);
      const tc = testCanvas();
      const fam = await tc.factory.registerFonts(brandFonts());
      const { layout, png } = await renderStillPng(syntheticPng(w, h, name), "Moment of impact", buildModel(scene, sim, stamp), tc.factory, fam);
      saveOutput(`still-${w}.png`, png);
      expect(layout.width).toBe(1920);
      const inBand = tc.drawn.filter((d) => d.y >= layout.bandTop);
      expect(inBand.length).toBeGreaterThan(3);
      for (const d of inBand) {
        expect(d.x, d.text).toBeGreaterThanOrEqual(0);
        expect(d.x + d.width, d.text).toBeLessThanOrEqual(layout.width);
        expect(d.y - d.size * 0.8, d.text).toBeGreaterThanOrEqual(layout.bandTop - 0.5);
        expect(d.y + d.size * 0.25, d.text).toBeLessThanOrEqual(layout.bandTop + layout.band + 0.5);
      }
      // the caption is on the picture, not in the band
      expect(tc.drawn.find((d) => d.text === "Moment of impact")!.y).toBeLessThan(layout.bandTop);
    });
  }

  it("stacks the stamp under the disclaimer and grows the band when it can't sit beside it", async () => {
    const { scene, sim } = twoVehicle();
    const { stamp } = await sceneFile(scene, sim, CREATED);
    const model = buildModel(scene, sim, stamp);
    for (const width of [500, 800, 1600, 1920]) {
      const tc = testCanvas();
      const fam = await tc.factory.registerFonts(brandFonts());
      const b = await renderBand(tc.factory, fam, width, model);
      if (width <= 500) { expect(b.stacked).toBe(true); expect(b.height).toBeGreaterThan(footerBandHeight()); }
      if (width >= 1600) expect(b.stacked).toBe(false);
      for (const d of tc.drawn) {
        expect(d.x, `${width}: ${d.text}`).toBeGreaterThanOrEqual(0);
        expect(d.x + d.width, `${width}: ${d.text}`).toBeLessThanOrEqual(width);
        expect(d.y - d.size * 0.8, `${width}: ${d.text}`).toBeGreaterThanOrEqual(-0.5);
        expect(d.y + d.size * 0.25, `${width}: ${d.text}`).toBeLessThanOrEqual(b.height + 0.5);
      }
      const all = norm(tc.drawn.map((d) => d.text).join(" "));
      expect(all).toContain(`Fingerprint ${stamp.fingerprintShort}`);
      expect(all).toContain(CREATED);
    }
  });
});

describe("the diagram picture", () => {
  const rectsOverlap = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

  /** Slide the two vehicles far apart sideways: a wide scene. */
  function wide(): { scene: Scene; sim: SimulationResult } {
    const { scene, sim } = twoVehicle();
    const shift = (dx: number) => (p: { xM: number; yM: number; headingRad: number; speedMps: number }) => ({ ...p, xM: p.xM + dx });
    return {
      scene,
      sim: {
        ...sim,
        vehicles: sim.vehicles.map((v, i) => {
          const f = shift(i === 0 ? -60 : 60);
          return { ...v, impactPose: f(v.impactPose), restPose: f(v.restPose), track: v.track.map(f) };
        }),
      },
    };
  }

  for (const [name, make] of [["2 vehicles", twoVehicle], ["4 vehicles", fourVehicle], ["a wide scene", wide]] as const) {
    it(`keeps vehicles, the run-up and the impact ring out from under the cards: ${name}`, async () => {
      const { scene, sim } = make();
      const { stamp } = await sceneFile(scene, sim, CREATED);
      const tc = testCanvas();
      const fam = await tc.factory.registerFonts(brandFonts());
      const { layout, png } = await renderDiagramPng({ model: buildModel(scene, sim, stamp), sim, roads: loadRoads("t-bone-intersection", scene.location) }, tc.factory, fam);
      saveOutput(`diagram-${name.replace(/ /g, "-")}.png`, png);
      expect(layout.cards.length).toBeGreaterThanOrEqual(2);
      for (const k of layout.keep) {
        expect(k.x).toBeGreaterThanOrEqual(layout.safe.x - 1);
        expect(k.y).toBeGreaterThanOrEqual(layout.safe.y - 1);
        expect(k.x + k.w).toBeLessThanOrEqual(layout.safe.x + layout.safe.w + 1);
        expect(k.y + k.h).toBeLessThanOrEqual(layout.safe.y + layout.safe.h + 1);
        for (const c of layout.cards) expect(rectsOverlap(k, c), `keep ${JSON.stringify(k)} under card ${JSON.stringify(c)}`).toBe(false);
      }
    });
  }

  const dist = (p: [number, number], poly: ReadonlyArray<readonly [number, number]>) => {
    let best = Infinity;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
      const vx = b[0] - a[0], vy = b[1] - a[1];
      const l2 = vx * vx + vy * vy || 1;
      const k = Math.min(1, Math.max(0, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / l2));
      best = Math.min(best, Math.hypot(p[0] - (a[0] + vx * k), p[1] - (a[1] + vy * k)));
    }
    return best;
  };
  const inside = (p: [number, number], poly: ReadonlyArray<readonly [number, number]>) => {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i]!, b = poly[j]!;
      if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) c = !c;
    }
    return c;
  };

  for (const [name, make] of [["2 vehicles", twoVehicle], ["4 vehicles", fourVehicle]] as const) {
    it(`draws letters last and keeps numbered markers off the vehicle bodies: ${name}`, async () => {
      const { scene, sim } = make();
      const measure = await brandMeasure();
      for (const box of [{ x: 0, y: 0, w: 264, h: 200 }, { x: 0, y: 0, w: 1600, h: 1450 }]) {
        const minTag = box.w > 500 ? 18 : 5.6;
        const plan = planDiagram(sim, loadRoads("t-bone-intersection", scene.location), { box, minTagRadius: minTag, minTextSize: box.w > 500 ? 16 : 7 }, measure);
        // the letters are the last things drawn before the clip ends
        const tail = plan.prims.slice(-1 - 2 * sim.vehicles.length, -1);
        sim.vehicles.forEach((v, i) => {
          expect(tail[2 * i]).toMatchObject({ k: "circle", fill: color("color-surface") });
          expect(tail[2 * i + 1]).toMatchObject({ k: "text", text: v.id });
        });
        const r = Math.max(0.85 * plan.scale, minTag);
        expect(plan.markers.length).toBeGreaterThan(0);
        for (const m of plan.markers) {
          for (const body of plan.bodies) {
            expect(inside(m.at as [number, number], body), `marker ${m.n} inside a body`).toBe(false);
            expect(dist(m.at as [number, number], body), `marker ${m.n} touches a body`).toBeGreaterThanOrEqual(r - 0.5);
          }
        }
      }
    });
  }

  it("never clips or crowds a street name: the rotated, tracked glyph box stays inside the picture", async () => {
    const { scene, sim } = fourVehicle();
    const measure = await brandMeasure();
    let labels = 0;
    for (const box of [{ x: 10, y: 10, w: 264, h: 200 }, { x: 0, y: 0, w: 1600, h: 1450 }, { x: 0, y: 0, w: 500, h: 500 }]) {
      const plan = planDiagram(sim, loadRoads("t-bone-intersection", scene.location), { box, minTextSize: 7 }, measure);
      for (const p of plan.prims) {
        if (p.k !== "text" || !p.tracking) continue;
        labels++;
        const chars = Array.from(p.text);
        const total = chars.reduce((a, c) => a + measure(p.font, p.size, c), 0) + p.tracking * (chars.length - 1);
        const th = ((p.rotateDeg ?? 0) * Math.PI) / 180;
        const [ux, uy] = [Math.cos(th), Math.sin(th)];
        const half = total / 2; // anchor is the middle of the text
        for (const [lx, ly] of [[-half, -p.size * 0.75], [half, -p.size * 0.75], [half, p.size * 0.2], [-half, p.size * 0.2]] as const) {
          const x = p.at[0] + lx * ux - ly * uy;
          const y = p.at[1] + lx * uy + ly * ux;
          expect(x, p.text).toBeGreaterThanOrEqual(box.x);
          expect(x, p.text).toBeLessThanOrEqual(box.x + box.w);
          expect(y, p.text).toBeGreaterThanOrEqual(box.y);
          expect(y, p.text).toBeLessThanOrEqual(box.y + box.h);
        }
      }
    }
    expect(labels).toBeGreaterThan(0);
  });

  it("draws two scale bars, each exact in its own unit", () => {
    const b = scaleBars(10, 50);
    expect(b.metric.label).toBe(formatDistance(5, { both: false, units: "metric" }).text);
    expect(b.metric.label).toMatch(/^\d+(\.\d)? m$/);
    expect(b.us.label).toMatch(/^\d+ ft$/);
    const ft = Number(b.us.label.replace(" ft", ""));
    // the foot bar is exactly that many feet long, and the metre bar exactly that many metres
    expect(b.us.meters).toBeCloseTo(ft * 0.3048, 9);
    expect(b.us.px).toBeCloseTo(ft * 0.3048 * 10, 6);
    expect(b.metric.px).toBeCloseTo(b.metric.meters * 10, 6);
    // and they are different lengths: the foot label never rides on a metre bar
    expect(Math.abs(b.us.meters - b.metric.meters)).toBeGreaterThan(0.01);
    // for several scales the label always matches the length drawn
    for (const pxPerM of [3, 8, 21, 64, 150]) {
      const s = scaleBars(pxPerM, 250);
      expect(s.metric.px).toBeLessThanOrEqual(250);
      expect(s.us.px).toBeLessThanOrEqual(250);
      expect(Number(s.us.label.replace(" ft", "")) * 0.3048).toBeCloseTo(s.us.meters, 9);
      expect(Number(s.metric.label.replace(" m", ""))).toBeCloseTo(s.metric.meters, 9);
    }
  });
});

describe("text from the scene is only ever text", () => {
  it("shows <script> labels literally in the PDF and the PNG", async () => {
    const { scene, sim } = fourVehicle();
    const evil = "<script>alert(1)</script>";
    const s2: Scene = {
      ...scene,
      location: { ...scene.location, label: `Main ${evil} Street, Nashua` },
      vehicles: scene.vehicles.map((v, i) => (i === 1 ? { ...v, make: evil, model: "<img src=x onerror=alert(2)>" } : v)),
    };
    const tc = testCanvas();
    const b = await buildExports(req(s2, sim, { formats: ["pdf", "png-diagram", "json"] }), tc.factory);
    const pdf = await readPdf(file(b, ".pdf").bytes);
    expect(pdf.text).toContain(`Main ${evil} Street`);
    const squeezed = pdf.text.replace(/\s/g, "");
    expect(squeezed).toContain(evil.replace(/\s/g, ""));
    expect(squeezed).toContain("<imgsrc=xonerror=alert(2)>");
    expect(tc.drawn.some((d) => d.text.includes(evil))).toBe(true);
    expect(JSON.parse(new TextDecoder().decode(file(b, ".json").bytes)).vehicles[1].make).toBe(evil);
  });

  it("strips bidirectional controls from everything printed, but keeps the data in the scene file", async () => {
    const { scene, sim } = twoVehicle();
    const rlo = "‮";
    const s2: Scene = {
      ...scene,
      claim: { ...scene.claim, number: `CLM-${rlo}9001` },
      location: { ...scene.location, label: `Main ${rlo}Street⁦, Nashua‏` },
      vehicles: scene.vehicles.map((v, i) => (i === 0 ? { ...v, make: `Hon‪da`, travel: { ...v.travel, roadName: `Main‎ Street` } } : v)),
    };
    const tc = testCanvas();
    const b = await buildExports(req(s2, sim), tc.factory);
    const pdf = await readPdf(file(b, ".pdf").bytes);
    expect(pdf.text).not.toMatch(/[‪-‮⁦-⁩‎‏]/);
    expect(pdf.text).toContain("Claim CLM-9001");
    expect(pdf.text).toContain("Honda");
    expect(tc.drawn.map((d) => d.text).join("")).not.toMatch(/[‪-‮⁦-⁩‎‏]/);
    expect(b.files.every((f) => !/[‪-‮]/.test(f.name))).toBe(true);
    expect(new TextDecoder().decode(file(b, ".json").bytes)).toContain(rlo);
  });

  it("keeps odd claim numbers out of the file names", async () => {
    const { scene, sim } = twoVehicle();
    const s2: Scene = { ...scene, claim: { ...scene.claim, number: "../A/B:1<2>" } };
    const b = await buildExports(req(s2, sim, { formats: ["json", "pdf"] }), testCanvas().factory);
    for (const f of b.files) expect(f.name).toMatch(/^crash-scene-[A-Za-z0-9._-]+\.(json|pdf)$/);
    expect(b.files.every((f) => !f.name.includes("/"))).toBe(true);
  });

  it("prints '?' for characters the brand font lacks and says so in the notes", async () => {
    const { scene, sim } = twoVehicle();
    const s2: Scene = { ...scene, vehicles: scene.vehicles.map((v, i) => (i === 0 ? { ...v, model: "Accord 🚗 日本" } : v)) };
    const b = await buildExports(req(s2, sim, { formats: ["json", "pdf"] }), testCanvas().factory);
    const pdf = await readPdf(file(b, ".pdf").bytes);
    expect(pdf.pages).toBe(1);
    expect(pdf.text).toContain("Accord");
    expect(pdf.text).toContain("?");
    const note = b.notes.find((n) => /couldn't be printed/.test(n));
    expect(note).toBeDefined();
    expect(note).toContain("🚗");
    expect(note).toContain("日");
  });
});

describe("missing pieces", () => {
  it("skips impact and rest with a reason when the stills are missing", async () => {
    const { scene, sim } = twoVehicle();
    const b = await buildExports(req(scene, sim, { formats: ["png-impact", "png-rest", "json"], stills: undefined }), testCanvas().factory);
    expect(b.files.map((f) => f.name)).toEqual(["crash-scene-CLM-EX-1001.json"]);
    expect(b.skipped.map((s) => s.format).sort()).toEqual(["png-impact", "png-rest"]);
    for (const s of b.skipped) expect(s.reason.length).toBeGreaterThan(10);
  });

  it("skips only the missing one", async () => {
    const { scene, sim } = twoVehicle();
    const b = await buildExports(req(scene, sim, { formats: ["png-impact", "png-rest"], stills: { impact: syntheticPng(400, 225, "x") } }), testCanvas().factory);
    expect(b.files.map((f) => f.name).sort()).toEqual(["crash-scene-CLM-EX-1001-impact.png", "crash-scene-CLM-EX-1001.json"]);
    expect(b.skipped).toHaveLength(1);
    expect(b.skipped[0]!.format).toBe("png-rest");
  });

  it("skips an unreadable still with a reason", async () => {
    const { scene, sim } = twoVehicle();
    const b = await buildExports(req(scene, sim, { formats: ["png-rest"], stills: { rest: new Uint8Array([1, 2, 3, 4]) } }), testCanvas().factory);
    expect(b.files.some((f) => f.name.endsWith(".png"))).toBe(false);
    expect(b.skipped[0]!.reason).toMatch(/couldn't be read/);
  });

  it("says the map is missing when there's no thumbnail, and survives a bad one (with a note)", async () => {
    const { scene, sim } = twoVehicle();
    const none = await buildExports(req(scene, sim, { formats: ["json", "pdf"], mapThumbnail: undefined }), testCanvas().factory);
    expect((await readPdf(file(none, ".pdf").bytes)).text).not.toContain("Map not available");
    expect(none.notes).toEqual([]);
    const bad = await buildExports(req(scene, sim, { formats: ["json", "pdf"], mapThumbnail: new Uint8Array([9, 9, 9]) }), testCanvas().factory);
    const pdf = await readPdf(file(bad, ".pdf").bytes);
    expect(pdf.pages).toBe(1);
    expect(pdf.text).not.toContain("Map not available");
    expect(pdf.text).toContain("© OpenStreetMap contributors");
    expect(bad.notes.join(" ")).toMatch(/map picture couldn't be read/);
  });

  it("draws without a road network", async () => {
    const { scene, sim } = twoVehicle();
    const b = await buildExports(req(scene, sim, { roads: null, formats: ["pdf", "png-diagram"] }), testCanvas().factory);
    expect(b.files.map((f) => f.name).sort()).toEqual(["crash-scene-CLM-EX-1001-diagram.png", "crash-scene-CLM-EX-1001.json", "crash-scene-CLM-EX-1001.pdf"]);
    expect((await readPdf(file(b, ".pdf").bytes)).pages).toBe(1);
  });
});

describe("voice and robustness", () => {
  it("avoids the words DESIGN.md bans, except inside the disclaimers", async () => {
    const { scene, sim } = fourVehicle();
    const tc = testCanvas();
    const b = await buildExports(req(scene, sim), tc.factory);
    const pdf = await readPdf(file(b, ".pdf").bytes);
    const banned = /\b(liable|negligent|proves?|forensic|determined|conclusive|reconstruction|expert|evidence|fault)\b/i;
    expect(pdf.text.replaceAll(DISCLAIMER_LONG, "")).not.toMatch(banned);
    const pngText = tc.drawn.map((d) => d.text).join(" ");
    const pngRest = DISCLAIMER_SHORT.split(" ").reduce((t, w) => t.replaceAll(w, ""), pngText);
    expect(pngRest).not.toMatch(banned);
  });

  it("uses US spelling", async () => {
    const { scene, sim } = fourVehicle();
    const tc = testCanvas();
    const b = await buildExports(req(scene, sim), tc.factory);
    const all = `${(await readPdf(file(b, ".pdf").bytes)).text} ${tc.drawn.map((d) => d.text).join(" ")}`;
    expect(all).not.toMatch(/\b(centre|colour|metre|neighbour)\b/i);
    expect(all).toContain("center to center");
  });

  it("still draws when the result has no sampled tracks", async () => {
    const { scene, sim } = twoVehicle();
    const bare: SimulationResult = { ...sim, vehicles: sim.vehicles.map((v) => ({ ...v, track: [] })) };
    const b = await buildExports(req(scene, bare, { formats: ["pdf", "png-diagram"] }), testCanvas().factory);
    expect((await readPdf(file(b, ".pdf").bytes)).pages).toBe(1);
    expect(b.files.some((f) => f.name.endsWith("-diagram.png"))).toBe(true);
  });

  it("works for the other example scenes' roads (highway, parking lot)", async () => {
    const { scene, sim } = twoVehicle();
    for (const ex of ["highway-rear-end", "parking-lot-backing"]) {
      const roads = loadRoads(ex, scene.location);
      const b = await buildExports(req(scene, sim, { roads, formats: ["pdf", "png-diagram"] }), testCanvas().factory);
      expect(b.files).toHaveLength(3);
    }
  });
});

describe("numbers come from the result", () => {
  it("changing the result changes every printed number that depends on it", async () => {
    const { scene, sim } = twoVehicle();
    const a = await readPdf(file(await buildExports(req(scene, sim, { formats: ["pdf"] }), testCanvas().factory), ".pdf").bytes);
    const bigger: SimulationResult = {
      ...sim,
      vehicles: sim.vehicles.map((v) => ({ ...v, postImpactDistanceM: { lo: v.postImpactDistanceM.lo * 2, mid: v.postImpactDistanceM.mid * 2, hi: v.postImpactDistanceM.hi * 2 }, massKg: v.massKg + 500 })),
    };
    const b = await readPdf(file(await buildExports(req(scene, bigger, { formats: ["pdf"] }), testCanvas().factory), ".pdf").bytes);
    for (const v of sim.vehicles) expect(a.text).toContain(formatDistance(v.postImpactDistanceM).text);
    for (const v of bigger.vehicles) expect(b.text).toContain(formatDistance(v.postImpactDistanceM).text);
    for (const v of sim.vehicles) expect(b.text).not.toContain(formatDistance(v.postImpactDistanceM).text);
    expect(a.text).not.toBe(b.text);
  });
});

describe("fonts", () => {
  it("skips the PDF with a reason, and still saves the rest, when a font is WOFF2", async () => {
    const { scene, sim } = twoVehicle();
    const b = await buildExports(req(scene, sim, { formats: ["json", "pdf"], fonts: brandFonts("woff2") }), testCanvas().factory);
    expect(b.files.map((f) => f.name)).toEqual(["crash-scene-CLM-EX-1001.json"]);
    expect(b.skipped).toHaveLength(1);
    expect(b.skipped[0]!.format).toBe("pdf");
    expect(b.skipped[0]!.reason).toMatch(/WOFF2/);
  });

  it("skips the PDF with a reason when a font can't be read at all", async () => {
    const { scene, sim } = twoVehicle();
    const fonts = { ...brandFonts(), monoRegular: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) };
    const b = await buildExports(req(scene, sim, { formats: ["json", "pdf"], fonts }), testCanvas().factory);
    expect(b.files.map((f) => f.name)).toEqual(["crash-scene-CLM-EX-1001.json"]);
    expect(b.skipped[0]!.format).toBe("pdf");
    expect(b.skipped[0]!.reason.length).toBeGreaterThan(20);
  });

  it("embeds WOFF, which is what Fontsource ships", async () => {
    const { scene, sim } = twoVehicle();
    const b = await buildExports(req(scene, sim, { formats: ["pdf"], fonts: brandFonts("woff") }), testCanvas().factory);
    expect(latin1(file(b, ".pdf").bytes)).toMatch(/PlusJakartaSans-Bold/);
  });
});

describe("PNG reader (untrusted input)", () => {
  it("reads a PNG the canvas wrote", async () => {
    const p = await decodePng(syntheticPng(64, 48, "x"));
    expect([p.width, p.height]).toEqual([64, 48]);
    expect(p.rgba).toHaveLength(64 * 48 * 4);
  });

  it("refuses a decompression bomb with a plain message", async () => {
    // 20 000 x 20 000 declared would be refused by size; here the header is small but the data inflates far past it
    const raw = new Uint8Array(60_000_000);
    const bomb = makePng({ width: 16, height: 16, raw });
    expect(bomb.length).toBeLessThan(200_000);
    await expect(decodePng(bomb)).rejects.toThrow(/more picture data than its size allows/);
  });

  it("refuses data that is cut short", async () => {
    await expect(decodePng(makePng({ width: 16, height: 16, raw: new Uint8Array(10) }))).rejects.toThrow(/cut short/);
  });

  it(`refuses pictures wider or taller than ${MAX_PNG_SIDE}`, async () => {
    await expect(decodePng(makePng({ width: MAX_PNG_SIDE + 1, height: 2, raw: new Uint8Array(10) }))).rejects.toThrow(/too large/);
    await expect(decodePng(makePng({ width: 2, height: MAX_PNG_SIDE + 1, raw: new Uint8Array(10) }))).rejects.toThrow(/too large/);
    await expect(decodePng(makePng({ width: 100_000, height: 100_000, raw: new Uint8Array(10) }))).rejects.toThrow(/too large/);
  });

  it("insists on an IHDR chunk of 13 bytes first", async () => {
    await expect(decodePng(makePng({ width: 4, height: 4, ihdrFirst: false }))).rejects.toThrow(/header is damaged/);
    await expect(decodePng(makePng({ width: 4, height: 4, ihdrLength: 12 }))).rejects.toThrow(/header is damaged/);
  });

  it("rejects colour type and bit depth pairs that don't exist", async () => {
    for (const [colorType, bitDepth] of [[2, 4], [6, 1], [3, 16], [4, 4], [0, 3], [5, 8], [2, 0]] as const) {
      await expect(decodePng(makePng({ width: 4, height: 4, colorType, bitDepth })), `type ${colorType} depth ${bitDepth}`).rejects.toThrow(/isn't supported/);
    }
  });

  it("still reads the valid kinds", async () => {
    for (const [colorType, bitDepth] of [[0, 8], [0, 16], [2, 8], [2, 16], [4, 8], [6, 8], [6, 16]] as const) {
      const ch = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[colorType]!;
      const p = await decodePng(makePng({ width: 3, height: 2, colorType, bitDepth, raw: new Uint8Array((3 * ch * (bitDepth / 8) + 1) * 2) }));
      expect([p.width, p.height]).toEqual([3, 2]);
    }
  });
});

describe("design tokens, not literals", () => {
  it("the generated files match design/tokens.css and the official logo SVG", () => {
    const fresh = generate() as Record<string, string>;
    for (const [name, text] of Object.entries(fresh)) {
      expect(readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8"), `${name} is stale: run npm run gen -w @csd/exports`).toBe(text);
    }
  });

  it("the generator fails on an unclosed light-dark( instead of looping forever", () => {
    const css = ":root {\n  --color-bg: light-dark(#FFFFFF, #000000;\n}";
    expect(() => buildTokensSource(css)).toThrow(/light-dark/);
  }, 5000);

  it("no color literals outside the generated files", () => {
    const dir = new URL("../src/", import.meta.url);
    for (const f of readdirSync(dir)) {
      if (f === "tokens.ts") continue;
      const src = readFileSync(new URL(f, dir), "utf8");
      expect(src, f).not.toMatch(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b|\brgba?\(\s*\d|\bhsla?\(\s*\d/);
    }
  });
});

describe("long claim numbers (the file name wraps; the hash keeps its own 8 pt line)", () => {
  for (const claim of ["C".repeat(40), "CLM-2026-ABCDEFGHIJKLMNOPQRSTUVWXYZ01234"]) {
    for (const [label, make] of [["2 vehicles", twoVehicle], ["30 warnings", () => manyShortWarnings(30)]] as const) {
      it(`${claim.slice(0, 14)}... (${claim.length}) with ${label}`, async () => {
        expect(claim).toHaveLength(40);
        const { scene, sim } = make();
        const s2: Scene = { ...scene, claim: { ...scene.claim, number: claim } };
        const { r, read } = await makePdf(s2, sim);
        saveOutput(`claim-40-${label.replace(/ /g, "-")}-${claim[0] === "C" && claim[1] === "C" ? "c" : "clm"}.pdf`, r.bytes);
        const { stamp } = await sceneFile(s2, sim, CREATED);
        // the full hash is on every page, in one piece
        expect(countOf(read.text, stamp.fingerprintHex)).toBe(r.pages);
        for (const t of read.pageTexts) expect(t.replace(/\s/g, "")).toContain(`crash-scene-${claim}.json`);
        // the hash line is drawn at 8 pt or more, like the rest
        for (const p of r.report) expect(p.minTextPt).toBeGreaterThanOrEqual(MIN_TEXT_PT - 1e-6);
        await expectSafePages(r);
      }, 60_000);
    }
  }
});

describe("overflow placeholder always lands on page 1", () => {
  const sixGaps = (sim: SimulationResult): SimulationResult => {
    const gaps: SimulationResult["gaps"][number][] = [];
    for (let i = 0; i < sim.vehicles.length; i++) for (let j = i + 1; j < sim.vehicles.length; j++) {
      const a = sim.vehicles[i]!, b = sim.vehicles[j]!;
      const d = Math.hypot(a.restPose.xM - b.restPose.xM, a.restPose.yM - b.restPose.yM);
      gaps.push({ a: a.id, b: b.id, restGapM: { lo: d * 0.9, mid: d, hi: d * 1.1 } });
    }
    return { ...sim, gaps };
  };
  const names = [
    "Grand Touring Premium Limited Edition All-Wheel-Drive Extended Cab Long Bed Plus Pkg".slice(0, 80),
    "W".repeat(80),
    "Alpha Bravo Charlie Delta Echo Foxtrot Golf Hotel India Juliet Kilo Lima Mike Nov".slice(0, 80),
    "Z".repeat(80),
  ];
  function repro(): { scene: Scene; sim: SimulationResult } {
    const { scene } = fourVehicle();
    const { sim } = manyShortWarnings(30);
    const s2: Scene = { ...scene, vehicles: scene.vehicles.map((v, i) => ({ ...v, model: names[i]! })) };
    return { scene: s2, sim: sixGaps(sim) };
  }

  it("says on page 1 what moved to page 2, and what it names really is on page 2", async () => {
    const { scene, sim } = repro();
    expect(scene.vehicles.every((v) => v.model.length === 80)).toBe(true);
    expect(sim.gaps).toHaveLength(6);
    expect(sim.warnings).toHaveLength(30);
    const { r, read } = await makePdf(scene, sim);
    saveOutput("repro-80-char-models.pdf", r.bytes);
    expect(r.pages).toBeGreaterThanOrEqual(2);
    const first = read.pageTexts[0]!;
    const note = /((?:Vehicles, )?(?:key measurements, )?assumptions and details that may not fit together continued on page 2)/i.exec(first);
    expect(note, "page 1 must say what moved, warnings included").not.toBeNull();
    expect(r.notes.join(" ")).toContain("details that may not fit together");
    const rest = read.pageTexts.slice(1).join(" ");
    const mentionsMeasurements = /key measurements/i.test(note![1]!);
    const mentionsVehicles = /^vehicles/i.test(note![1]!);
    expect(first.includes("moved after impact")).toBe(!mentionsMeasurements);
    expect(rest.includes("moved after impact")).toBe(mentionsMeasurements);
    expect(first.includes("Hit on")).toBe(!mentionsVehicles);
    // nothing is lost, and the lists are whole
    for (const a of sim.assumptions) expect(read.text).toContain(norm(a.text));
    for (const w of sim.warnings) expect(read.text).toContain(norm(w.text));
    for (const g of sim.gaps) expect(read.text).toContain(about(formatDistance(g.restGapM).text));
    await expectSafePages(r);
  }, 90_000);

  it("keeps the short wording when there are no warnings", async () => {
    const { scene, sim } = stress(30);
    const noWarnings: SimulationResult = { ...sim, warnings: [] };
    const { r, read } = await makePdf(scene, noWarnings);
    expect(r.pages).toBeGreaterThanOrEqual(2);
    expect(read.pageTexts[0]).toContain("Assumptions continued on page 2");
    expect(read.pageTexts[0]).not.toContain("details that may not fit together");
    expect(r.notes.join(" ")).toContain("assumptions continue on page 2");
    expect(r.notes.join(" ")).not.toContain("details that may not fit together");
  }, 60_000);
});

describe("numbered assumptions (DESIGN.md section 8)", () => {
  const numbered = (text: string, list: readonly { text: string }[]) =>
    list.forEach((a, i) => expect(text, `assumption ${i + 1}`).toContain(`${i + 1}. ${norm(a.text).slice(0, 14)}`));

  it("one page: 1., 2., 3. ...", async () => {
    const { scene, sim } = twoVehicle();
    const { read } = await makePdf(scene, sim);
    numbered(read.text, sim.assumptions);
  });
  it("real physics output, all examples", async () => {
    const real = JSON.parse(readFileSync(new URL("./data/real-sims.json", import.meta.url), "utf8")) as Record<string, { scene: Scene; sim: SimulationResult }>;
    for (const { scene, sim } of Object.values(real)) numbered((await makePdf(scene, sim)).read.text, sim.assumptions);
  }, 60_000);
  it("overflow pages keep the numbering in one sequence; warnings stay bullets", async () => {
    const { scene, sim } = stress(30);
    const { r, read } = await makePdf(scene, sim);
    expect(r.pages).toBeGreaterThanOrEqual(3);
    numbered(read.pageTexts.slice(1).join(" "), sim.assumptions);
    expect(read.text).not.toMatch(/\b1\. Check 1:/);
  }, 90_000);
});

describe("speeds come from the physics result (DESIGN.md section 14)", () => {
  /** B's "not sure" range narrowed to 22.5-30 mph and the picture speed moved to 27 mph. */
  function narrowed(): { scene: Scene; sim: SimulationResult } {
    const { scene, sim } = twoVehicle();
    const at = { lo: 22.5 * MPH_TO_MPS, mid: 27 * MPH_TO_MPS, hi: 30 * MPH_TO_MPS };
    return { scene, sim: { ...sim, vehicles: sim.vehicles.map((v, i) => (i === 1 ? { ...v, speedAtImpactMps: at } : v)) } };
  }

  it("the PDF and the PNG show the sim's range and picture speed, not the entered ones", async () => {
    const { scene, sim } = narrowed();
    const at = sim.vehicles[1]!.speedAtImpactMps;
    const range = about(formatSpeed(at).text);
    const both = about(formatSpeed(at, { both: true }).text);
    const mid = about(formatSpeed(at.mid).text);
    const r = speedInputs(scene.vehicles[1]!).rangeMph;
    const entered = about(formatSpeed({ lo: r.lo * MPH_TO_MPS, mid: r.mid * MPH_TO_MPS, hi: r.hi * MPH_TO_MPS }).text);
    expect(range).not.toBe(entered);
    const tc = testCanvas();
    const b = await buildExports(req(scene, sim, { formats: ["pdf", "png-diagram"] }), tc.factory);
    const pdf = await readPdf(file(b, ".pdf").bytes);
    const png = norm(tc.drawn.map((d) => d.text).join(" "));
    // the PDF speed column, the "Picture uses" sentence (equal to the sim's mid), and the narrowing note
    expect(pdf.text).toContain(both);
    expect(pdf.text).toContain(`Picture uses ${mid}.`);
    expect(pdf.text).toContain("Narrowed to the speeds where the crash works; see the notes below.");
    expect(pdf.text).not.toContain(about(formatSpeed({ lo: r.lo * MPH_TO_MPS, mid: r.mid * MPH_TO_MPS, hi: r.hi * MPH_TO_MPS }, { both: true }).text));
    // the limit wording still comes from the scene
    expect(pdf.text).toContain("Around 25 mph, a typical city limit (limit not known)");
    // the PNG title card agrees
    expect(png).toContain(`B speed at impact not known: ${range}`);
    expect(png).not.toContain(`B speed at impact not known: ${entered}`);
    // the picture speed on the card is the PDF's: the sim's mid, not a fixed phrase
    expect(png).toContain(`B speed at impact not known: ${range}. Picture uses ${mid}.`);
    expect(png).not.toContain("Picture uses the middle value");
  });

  it("says nothing about narrowing when the sim range is the entered one", async () => {
    const { scene, sim } = twoVehicle();
    const { read } = await makePdf(scene, sim);
    expect(read.text).not.toContain("Narrowed to the speeds");
  });

  it("the scene file keeps what was entered and what was drawn; the fingerprint is over the canonical text", async () => {
    const { scene, sim } = narrowed();
    const { text, stamp } = await sceneFile(scene, sim, CREATED);
    const vb = JSON.parse(text).vehicles[1];
    expect(vb.speedRangeMph).toEqual({ lo: 20, mid: 25, hi: 30 });
    expect(vb.speedUsedMph).toBeCloseTo(27, 3);
    expect(vb.speedShownRangeMph.lo).toBeCloseTo(22.5, 3);
    expect(vb.speedShownRangeMph.mid).toBeCloseTo(27, 3);
    expect(vb.speedShownRangeMph.hi).toBeCloseTo(30, 3);
    expect(text).toBe(canonicalJson(JSON.parse(text)));
    expect(stamp.fingerprintHex).toBe(sha(new TextEncoder().encode(text)));
    // and it still reads back
    expect(parseSceneFile(new TextEncoder().encode(text)).ok).toBe(true);
  });

  it("a braking vehicle's note still reads the start of its track", async () => {
    const { scene, sim } = narrowed();
    const s2: Scene = { ...scene, vehicles: scene.vehicles.map((v, i) => (i === 1 ? { ...v, braking: true } : v)) };
    const { read } = await makePdf(s2, sim);
    expect(read.text).toContain(`Braking: slowed from ${about(formatSpeed(sim.vehicles[1]!.track[0]!.speedMps).text)}`);
  });
});

describe("the approach label comes from the window, never a fixed 2 s", () => {
  it("reads N from startTimeS", async () => {
    const { scene, sim } = twoVehicle();
    const five: SimulationResult = { ...sim, startTimeS: -5 };
    const { stamp } = await sceneFile(scene, five, CREATED);
    const m = buildModel(scene, five, stamp);
    expect(m.measurements.find((r) => r.key === "approach-A")!.label).toBe("A, last 5 s before impact");
  });
});

describe("copy for braking and unmoved vehicles", () => {
  async function model(scene: Scene, sim: SimulationResult) {
    const { stamp } = await sceneFile(scene, sim, CREATED);
    return buildModel(scene, sim, stamp);
  }

  it("a braking vehicle says what it slowed from; a vehicle that wasn't braking says nothing extra", async () => {
    const { scene, sim } = twoVehicle();
    const braking: Scene = { ...scene, vehicles: scene.vehicles.map((v, i) => (i === 0 ? { ...v, braking: true } : v)) };
    expect((await model(braking, sim)).vehicles[0]!.brakingNote).toBe(`Braking: slowed from ${about(formatSpeed(sim.vehicles[0]!.track[0]!.speedMps).text)}`);
    expect((await model(scene, sim)).vehicles[0]!.brakingNote).toBeNull();
    // no track, no claim about where it started
    const bare: SimulationResult = { ...sim, vehicles: sim.vehicles.map((v) => ({ ...v, track: [] })) };
    expect((await model(braking, bare)).vehicles[0]!.brakingNote).toBeNull();
  });

  it("reads \"didn't move\" instead of an about-zero distance, in the PDF and the PNG legend", async () => {
    const { scene, sim } = twoVehicle();
    const still: SimulationResult = {
      ...sim,
      vehicles: sim.vehicles.map((v, i) => (i === 1 ? { ...v, postImpactDistanceM: { lo: 0, mid: 0.01, hi: 0.02 } } : v)),
    };
    const m = await model(scene, still);
    const row = m.measurements.find((r) => r.key === "moved-B")!;
    expect(row.value).toBe("didn't move");
    expect(row.marker).toBeNull();
    expect(m.measurements.find((r) => r.key === "moved-A")!.value).toMatch(/^about /);
    const { read } = await makePdf(scene, still);
    expect(read.text).toContain("B moved after impact didn't move");
    expect(read.text).not.toContain("about 0 ft / 0.0 m");
  });
});

describe("what goes in the notes", () => {
  it("doesn't claim the scene file was added for other files when none of them was made", async () => {
    const { scene, sim } = twoVehicle();
    const b = await buildExports(req(scene, sim, { formats: ["pdf"], fonts: brandFonts("woff2") }), testCanvas().factory);
    expect(b.files.map((f) => f.name)).toEqual(["crash-scene-CLM-EX-1001.json"]);
    expect(b.skipped.map((s) => s.format)).toEqual(["pdf"]);
    expect(b.notes.join(" ")).not.toMatch(/scene file was added/);
  });
});

describe("map picture and stills of odd shapes", () => {
  it("clips the map picture to the same rounded rectangle as its border", async () => {
    const { scene, sim } = twoVehicle();
    const dark = createSolidPng(300, 200);
    const { r } = await makePdf(scene, sim, { thumbBytes: dark });
    const box = r.report[0]!.images[0]!;
    expect(box.w).toBeGreaterThan(100);
    const img = await renderPdfPage(r.bytes, 1, 4);
    const at = (x: number, y: number) => { const o = (Math.round(y * 4) * img.width + Math.round(x * 4)) * 4; return img.data[o]!; };
    expect(at(box.x + 0.4, box.y + 0.4), "the corner is cut off").toBeGreaterThan(235);
    expect(at(box.x + 10, box.y + 10), "inside the corner is picture").toBeLessThan(80);
    expect(at(box.x + box.w - 0.4, box.y + box.h - 0.4), "other corner cut off").toBeGreaterThan(235);
  });

  it("fits a very tall still into the 1920 x 933 frame with the ground color on the sides", async () => {
    const { scene, sim } = twoVehicle();
    const { stamp } = await sceneFile(scene, sim, CREATED);
    const tc = testCanvas();
    const fam = await tc.factory.registerFonts(brandFonts());
    const { png, layout } = await renderStillPng(createSolidPng(400, 4096), "Final rest", buildModel(scene, sim, stamp), tc.factory, fam);
    saveOutput("still-400x4096.png", png);
    expect([layout.width, layout.height]).toEqual([1920, 1080]);
    expect(layout.picture.h).toBeLessThanOrEqual(1080 - footerBandHeight());
    expect(layout.picture.w).toBeLessThan(200);
    const dec = await decodePng(png);
    expect([dec.width, dec.height]).toEqual([1920, 1080]);
    const g = rgb01(color("color-scene-ground"));
    const o = (500 * 1920 + 5) * 4;
    [0, 1, 2].forEach((k) => expect(Math.abs(dec.rgba[o + k]! - Math.round(g[k]! * 255))).toBeLessThanOrEqual(1));
    // and a wide, short still is letterboxed top and bottom the same way
    const wideOut = await renderStillPng(createSolidPng(4096, 100), "Moment of impact", buildModel(scene, sim, stamp), tc.factory, fam);
    expect(wideOut.layout.picture.w).toBeLessThanOrEqual(1920);
    expect(wideOut.layout.picture.h).toBeLessThan(200);
  });
});

describe("map fallback (DESIGN.md section 9)", () => {
  /** Pixels in the left column's map area that are the road color: the outline is drawn there, or it isn't. */
  async function roadPixelsInMapArea(bytes: Uint8Array): Promise<number> {
    const img = await renderPdfPage(bytes, 1, 1);
    const road = rgb01(color("color-scene-road")).map((v) => Math.round(v * 255));
    let n = 0;
    for (let y = 150; y < 480; y++) {
      for (let x = 40; x < 290; x++) {
        const o = (y * img.width + x) * 4;
        if (Math.abs(img.data[o]! - road[0]!) < 4 && Math.abs(img.data[o + 1]! - road[1]!) < 4 && Math.abs(img.data[o + 2]! - road[2]!) < 4) n++;
      }
    }
    return n;
  }

  it("draws the road outline, the place, the coordinates and the credit when there is roads data but no map picture", async () => {
    const { scene, sim } = twoVehicle();
    const { r, read } = await makePdf(scene, sim, { thumb: false });
    saveOutput("map-fallback-roads.pdf", r.bytes);
    const { stamp } = await sceneFile(scene, sim, CREATED);
    const model = buildModel(scene, sim, stamp);
    expect(read.text).not.toContain("Map not available");
    expect(read.text).toContain(model.coordinates);
    expect(read.text).toContain(model.place);
    expect(read.text).toContain("Map data © OpenStreetMap contributors");
    expect(await roadPixelsInMapArea(r.bytes)).toBeGreaterThan(2000);
    // wider than the diagram: it frames more of the neighbourhood than the diagram does
    expect(r.pages).toBe(1);
    await expectSafePages(r);
  });

  it("also falls back to the outline when the map picture can't be read", async () => {
    const { scene, sim } = twoVehicle();
    const { r, read } = await makePdf(scene, sim, { thumbBytes: new Uint8Array([9, 9, 9]) });
    expect(read.text).not.toContain("Map not available");
    expect(await roadPixelsInMapArea(r.bytes)).toBeGreaterThan(2000);
  }, 30_000);

  it("is text only when there is no roads data either", async () => {
    const { scene, sim } = twoVehicle();
    const { r, read } = await makePdf(scene, sim, { thumb: false, noRoads: true });
    const { stamp } = await sceneFile(scene, sim, CREATED);
    const model = buildModel(scene, sim, stamp);
    expect(read.text).toContain("Map not available");
    expect(read.text).toContain(model.coordinates);
    expect(await roadPixelsInMapArea(r.bytes)).toBeLessThan(50);
    await expectSafePages(r);
  });

  const longPlace = ("Main Street and Park Street near the old mill by the river crossing in the historic downtown district of Nashua New Hampshire just past the fire station and the library on the corner where the farmers market is held every Saturday morning in summer and autumn until the first hard frost arrives and the stalls close for the winter season").slice(0, 279);

  it("puts the full place and the coordinates under the map, never over it", async () => {
    const { scene, sim } = twoVehicle();
    expect(longPlace).toHaveLength(279);
    expect(longPlace).not.toContain(",");
    const s2: Scene = { ...scene, location: { ...scene.location, label: longPlace } };
    const { r, read } = await makePdf(s2, sim, { thumb: false });
    saveOutput("map-fallback-long-place.pdf", r.bytes);
    const o = r.report[0]!.mapOutline!;
    // the caption has the whole place (no ellipsis) and the coordinates, directly under the map box
    const captionSans = o.caption.filter((l) => l.font === "sans").map((l) => l.text).join(" ");
    expect(captionSans.replace(/\s/g, "")).toBe(longPlace.replace(/\s/g, ""));
    expect(captionSans).not.toContain("…");
    expect(o.caption[o.caption.length - 1]!.font).toBe("mono");
    expect(o.captionBox.y).toBeGreaterThanOrEqual(o.box.y + o.box.h);
    expect(o.captionBox.y - (o.box.y + o.box.h)).toBeLessThan(6);
    expect(o.captionBox.x).toBeCloseTo(o.box.x, 6);
    // no text of the caption lands inside the map box; the only things drawn there are street names and the credit
    const mapRight = o.box.x + o.box.w;
    const mapTopUp = r.report[0]!.height - o.box.y;
    const mapBottomUp = r.report[0]!.height - (o.box.y + o.box.h);
    const inMap = read.positioned.filter((t) => t.x >= o.box.x - 0.5 && t.x <= mapRight && t.y <= mapTopUp && t.y >= mapBottomUp - 1);
    const inMapText = inMap.map((t) => t.str).join("");
    expect(inMapText).not.toContain("42.");
    expect(inMapText).not.toContain("Nashua");
    expect(inMapText).not.toContain("Street and Park");
    // the pin is really on the page: its pixels are the pin color
    const img = await renderPdfPage(r.bytes, 1, 4);
    const at = (x: number, y: number) => { const i = (Math.round(y * 4) * img.width + Math.round(x * 4)) * 4; return [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!]; };
    const pinColor = rgb01(color("color-map-pin")).map((v) => Math.round(v * 255));
    at(o.pin[0], o.pin[1]).forEach((v, k) => expect(Math.abs(v - pinColor[k]!)).toBeLessThanOrEqual(3));
    await expectSafePages(r);
  });

  it("draws every caption line in the body text color, the coordinates in mono", async () => {
    const { scene, sim } = twoVehicle();
    const s2: Scene = { ...scene, location: { ...scene.location, label: longPlace } };
    const { r } = await makePdf(s2, sim, { thumb: false });
    const o = r.report[0]!.mapOutline!;
    expect(o.caption.filter((l) => l.font === "sans").length).toBeGreaterThanOrEqual(2);
    expect(o.caption.every((l) => l.color === color("color-text"))).toBe(true);
    expect(o.caption[o.caption.length - 1]!.font).toBe("mono");
  });

  const inRect = (b: { x: number; y: number; w: number; h: number }, o: { x: number; y: number; w: number; h: number }) => b.x >= o.x && b.y >= o.y && b.x + b.w <= o.x + o.w && b.y + b.h <= o.y + o.h;
  const overlap = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

  it("labels both streets that meet at the pin on the outline, clear of the pin, the credit and each other", async () => {
    const { scene, sim } = twoVehicle();
    const { r } = await makePdf(scene, sim, { thumb: false });
    saveOutput("map-outline-labels.pdf", r.bytes);
    const o = r.report[0]!.mapOutline!;
    const labels = r.report[0]!.mapLabels!;
    const texts = labels.map((l) => l.text);
    expect(texts).toContain("MAIN STREET");
    expect(texts).toContain("PARK STREET");
    const pinRect = { x: o.pin[0] - o.pinRadius * 1.5, y: o.pin[1] - o.pinRadius * 1.5, w: o.pinRadius * 3, h: o.pinRadius * 3 };
    labels.forEach((l, i) => {
      expect(inRect(l.box, o.box), `${l.text} inside the map`).toBe(true);
      expect(overlap(l.box, pinRect), `${l.text} over the pin`).toBe(false);
      expect(overlap(l.box, o.credit), `${l.text} under the credit`).toBe(false);
      labels.slice(i + 1).forEach((m) => expect(overlap(l.box, m.box), `${l.text} over ${m.text}`).toBe(false));
    });
    // the names are real text at 8 pt or more
    expect(r.report[0]!.minTextPt).toBeGreaterThanOrEqual(MIN_TEXT_PT - 1e-6);
  });

  it("labels the streets at the pin on a real map picture too, when the picture says how big a pixel is", async () => {
    const { scene, sim } = twoVehicle();
    const { PNG_METERS_PER_PIXEL_KEY } = await import("../src/png-meta");
    // zoom 18 at this latitude, drawn at 2x: about 0.22 m per picture pixel
    const picture = withPngText(syntheticPng(800, 600, "map"), PNG_METERS_PER_PIXEL_KEY, "0.22");
    const { r } = await makePdf(scene, sim, { thumbBytes: picture });
    saveOutput("map-picture-labels.pdf", r.bytes);
    const labels = r.report[0]!.mapLabels!;
    expect(labels).toBeDefined();
    expect(labels.map((l) => l.text)).toContain("MAIN STREET");
    const box = r.report[0]!.images[0]!;
    for (const l of labels) expect(inRect(l.box, box), `${l.text} inside the picture`).toBe(true);
    expect(r.report[0]!.minTextPt).toBeGreaterThanOrEqual(MIN_TEXT_PT - 1e-6);
    await expectSafePages(r);
    // no scale in the picture: no guessing, the tiles keep their own labels
    const { r: plain } = await makePdf(scene, sim);
    expect(plain.report[0]!.mapLabels).toBeUndefined();
  });

  it("frames the outline on the pin, at twice the diagram's width or 80 m, whichever is wider", async () => {
    const { scene, sim } = twoVehicle();
    const { r } = await makePdf(scene, sim, { thumb: false });
    const o = r.report[0]!.mapOutline!;
    expect(o.pin[0]).toBeCloseTo(o.box.x + o.box.w / 2, 6);
    expect(o.pin[1]).toBeCloseTo(o.box.y + o.box.h / 2, 6);
    expect(o.spanM).toBeCloseTo(Math.max((o.diagramWidthPt / o.diagramScale) * 2, 80), 6);
    // never narrower than the diagram's own span
    expect(o.spanM).toBeGreaterThan(o.diagramWidthPt / o.diagramScale);
    // the credit chip is inside the box, bottom right
    expect(o.credit.x + o.credit.w).toBeLessThanOrEqual(o.box.x + o.box.w + 1e-6);
    expect(o.credit.y + o.credit.h).toBeLessThanOrEqual(o.box.y + o.box.h + 1e-6);
  });

  it("keeps street names off the pin and the credit chip", async () => {
    const { scene } = twoVehicle();
    const roads = loadRoads("t-bone-intersection", scene.location);
    const measure = await brandMeasure();
    const box = { x: 0, y: 0, w: 264, h: 160 };
    const pinR = 4.8;
    const pinRect = { x: box.w / 2 - pinR * 2, y: box.h / 2 - pinR * 2, w: pinR * 4, h: pinR * 4 };
    const credit = { x: box.w - 110, y: box.h - 12, w: 110, h: 12 };
    const hits = (b: { x: number; y: number; w: number; h: number }, k: { x: number; y: number; w: number; h: number }) => b.x < k.x + k.w && k.x < b.x + b.w && b.y < k.y + k.h && k.y < b.y + b.h;
    let labels = 0;
    for (const span of [60, 80, 140, 200]) {
      const out = planRoadOutline(roads, box, { spanM: span, minTextSize: 8, minLine: 0.5, pinRadius: pinR, center: { x: 0, y: 0 }, keepClear: [pinRect, credit] }, measure);
      expect(out.pin).toEqual([box.w / 2, box.h / 2]);
      expect(out.scale * span).toBeCloseTo(box.w, 9);
      for (const pr of out.prims) {
        if (pr.k !== "text" || !pr.tracking) continue;
        labels++;
        const chars = Array.from(pr.text);
        const total = chars.reduce((a, ch) => a + measure(pr.font, pr.size, ch), 0) + pr.tracking * (chars.length - 1);
        const th = ((pr.rotateDeg ?? 0) * Math.PI) / 180;
        const [ux, uy] = [Math.cos(th), Math.sin(th)];
        const xs: number[] = [];
        const ys: number[] = [];
        for (const [lx, ly] of [[-total / 2, -pr.size * 0.75], [total / 2, -pr.size * 0.75], [total / 2, pr.size * 0.2], [-total / 2, pr.size * 0.2]] as const) {
          xs.push(pr.at[0] + lx * ux - ly * uy);
          ys.push(pr.at[1] + lx * uy + ly * ux);
        }
        const bb = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
        expect(hits(bb, pinRect), `${pr.text} over the pin at ${span} m`).toBe(false);
        expect(hits(bb, credit), `${pr.text} under the credit at ${span} m`).toBe(false);
      }
    }
    expect(labels).toBeGreaterThan(0);
  });

  it("centers on the scene pin, not on the roads' frame origin (capture center 60 m away)", async () => {
    const { scene, sim } = twoVehicle();
    // a network whose frame origin is 60 m north of the pin, like a cached capture center
    const metersPerDegLat = 111_320;
    const origin = { lat: scene.location.lat + 60 / metersPerDegLat, lon: scene.location.lon };
    const roads = loadRoads("t-bone-intersection", origin);
    const { stamp } = await sceneFile(scene, sim, CREATED);
    const r = await buildPdf({
      model: buildModel(scene, sim, stamp), scene, sim, roads, fonts: brandFonts(), createdAt: CREATED,
      sceneFileName: `crash-scene-${fileClaim(scene.claim.number)}.json`,
    });
    saveOutput("map-outline-offpin.pdf", r.bytes);
    const o = r.report[0]!.mapOutline!;
    // the pin is 60 m south of the frame origin
    expect(o.centerM.x).toBeCloseTo(0, 1);
    expect(o.centerM.y).toBeCloseTo(-60, 0);
    expect(o.pin[0]).toBeCloseTo(o.box.x + o.box.w / 2, 6);
    expect(o.pin[1]).toBeCloseTo(o.box.y + o.box.h / 2, 6);
    // and the roads are shifted by that much relative to an outline centered on the frame origin
    const measure = await brandMeasure();
    const box = { x: 0, y: 0, w: 264, h: 160 };
    const common = { spanM: 120, minTextSize: 8, minLine: 0.5, pinRadius: 4.8 };
    const atOrigin = planRoadOutline(roads, box, { ...common, center: { x: 0, y: 0 } }, measure);
    const atPin = planRoadOutline(roads, box, { ...common, center: o.centerM }, measure);
    // some shape drawn in both (the views differ, so not every one is) moved by exactly 60 m on the page, and only up or down
    type Poly = { k: "poly"; pts: [number, number][]; stroke?: unknown };
    const polys = (prims: typeof atPin.prims) => prims.filter((q): q is never => q.k === "poly" && (q as Poly).pts.length > 3) as unknown as Poly[];
    const shifted = polys(atOrigin.prims).filter((pa) =>
      polys(atPin.prims).some((pb) => pb.pts.length === pa.pts.length && pb.pts.every((q, i) => Math.abs(q[0] - pa.pts[i]![0]) < 1e-6 && Math.abs(Math.abs(q[1] - pa.pts[i]![1]) - Math.abs(o.centerM.y) * atPin.scale) < 1e-6)),
    );
    expect(shifted.length).toBeGreaterThan(3);
  });

  it("a real map picture still wins over the outline", async () => {
    const { scene, sim } = twoVehicle();
    const { r, read } = await makePdf(scene, sim);
    expect(read.text).not.toContain("Map not available");
    expect(r.report[0]!.images.length).toBe(1);
  });

  it("the outline fallback keeps the real examples on one page at 8 pt or more", async () => {
    const real = JSON.parse(readFileSync(new URL("./data/real-sims.json", import.meta.url), "utf8")) as Record<string, { scene: Scene; sim: SimulationResult }>;
    for (const [name, { scene, sim }] of Object.entries(real)) {
      const { stamp } = await sceneFile(scene, sim, CREATED);
      const r = await buildPdf({
        model: buildModel(scene, sim, stamp), scene, sim, roads: loadRoads(name, scene.location), fonts: brandFonts(), createdAt: CREATED,
        sceneFileName: `crash-scene-${fileClaim(scene.claim.number)}.json`,
      });
      saveOutput(`fallback-${name}.pdf`, r.bytes);
      expect(r.pages, name).toBe(1);
      expect(r.report[0]!.minTextPt).toBeGreaterThanOrEqual(MIN_TEXT_PT - 1e-6);
      expect(r.report[0]!.minDiagramTextPt).toBeGreaterThanOrEqual(MIN_TEXT_PT - 1e-6);
    }
  }, 90_000);
});

describe("a hit side the picture couldn't use as entered (red team, 2026-10-10)", () => {
  const real = JSON.parse(readFileSync(new URL("./data/real-sims.json", import.meta.url), "utf8")) as Record<string, { scene: Scene; sim: SimulationResult }>;
  const { scene, sim } = real["t-bone-intersection"]!;
  const note = { code: "zone-used", text: "Vehicle A is marked hit on the front, but that did not fit with the way each vehicle was going, so the picture uses the rear instead.", vehicleIds: ["A" as const] };
  const adjusted: SimulationResult = { ...sim, warnings: [...sim.warnings, note] };

  it("says so in the PDF table and carries the note for every picture", async () => {
    const { stamp } = await sceneFile(scene, adjusted, CREATED);
    const m = buildModel(scene, adjusted, stamp);
    expect(m.vehicles.find((v) => v.id === "A")!.hitOn).toMatch(/as entered; the picture uses another side \(see notes\)$/);
    expect(m.vehicles.find((v) => v.id === "B")!.hitOn).not.toMatch(/as entered/);
    expect(m.adjustedNotes).toEqual([note.text]);
  });

  it("adds nothing when every hit side was used as entered", async () => {
    const { stamp } = await sceneFile(scene, sim, CREATED);
    const m = buildModel(scene, sim, stamp);
    expect(m.adjustedNotes).toEqual([]);
    expect(m.vehicles.every((v) => !/as entered/.test(v.hitOn))).toBe(true);
  });
});
