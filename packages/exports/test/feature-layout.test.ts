// The key to the road symbols in the PDF sits under the diagram's caption, never inside the picture. It used to be drawn
// across the middle of the diagram, and the crash was squeezed into a thin strip above it.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FEATURE_NAMES, parseScene, simulate, type RoadNetwork, type Scene, type SimulationResult } from "@csd/core";
import { parseOverpass } from "@csd/mapdata";
import { sceneFile } from "../src/scene-file";
import { buildModel } from "../src/model";
import { buildPdf, type PdfResult } from "../src/pdf";
import { FEATURE_LEGEND_NOTE, featureKinds, planDiagram, rectsTouch, type Rect } from "../src/diagram";
import type { Prim } from "../src/draw";
import { color } from "../src/style";
import { brandFonts, brandMeasure, readPdf, syntheticPng } from "./helpers";
import { fourVehicle } from "./sim-fixtures";

const EXAMPLES = ["t-bone-intersection", "highway-rear-end", "parking-lot-backing"] as const;
/** The crash (every vehicle's body at impact and at final rest) spans at least this share of the diagram's shorter side. */
const MIN_CRASH_SHARE = 0.35;
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

function exampleRoads(name: string): RoadNetwork {
  const raw = JSON.parse(readFileSync(new URL(`../../../examples/${name}/osm.json`, import.meta.url), "utf8"));
  return parseOverpass(raw, { origin: raw.center }, raw.radiusM, raw.fetchedAt);
}

function example(name: string): { scene: Scene; sim: SimulationResult; roads: RoadNetwork } {
  const roads = exampleRoads(name);
  const parsed = parseScene(JSON.parse(readFileSync(new URL(`../../../examples/${name}/scene.json`, import.meta.url), "utf8")));
  if (!parsed.ok) throw new Error(`Invalid example ${name}`);
  const result = simulate(parsed.value, roads);
  if (!result.ok) throw new Error(`Example ${name} doesn't simulate`);
  return { scene: parsed.value, sim: result.result, roads };
}

async function pdfOf(scene: Scene, sim: SimulationResult, roads: RoadNetwork, thumb: boolean): Promise<PdfResult> {
  const { stamp } = await sceneFile(scene, sim, "2026-10-11T00:00:00Z");
  return buildPdf({
    model: buildModel(scene, sim, stamp), scene, sim, roads, fonts: brandFonts(), createdAt: stamp.createdAt, sceneFileName: "synthetic.json",
    ...(thumb ? { mapThumbnail: syntheticPng(800, 600, "map") } : {}),
  });
}

const union = (rs: readonly Rect[]): Rect => {
  const x = Math.min(...rs.map((r) => r.x));
  const y = Math.min(...rs.map((r) => r.y));
  return { x, y, w: Math.max(...rs.map((r) => r.x + r.w)) - x, h: Math.max(...rs.map((r) => r.y + r.h)) - y };
};

/** The diagram on page 1: the crash fills it, clear of the chip, and the key is under the caption, outside the picture. */
async function expectClearDiagram(pdf: PdfResult, roads: RoadNetwork, what: string) {
  const page = pdf.report[0]!;
  const d = page.diagram!;
  expect(d, `${what}: the report records the diagram`).toBeTruthy();
  const { box, chip, legend } = d;
  const bodies = d.vehicles.flatMap((v) => [v.impact, v.rest]);
  expect(bodies.length, what).toBeGreaterThanOrEqual(4);
  for (const b of bodies) {
    // Every vehicle is in the picture at impact and at rest, and the north and scale chip doesn't cover it.
    expect(b.x >= box.x - 0.5 && b.y >= box.y - 0.5 && b.x + b.w <= box.x + box.w + 0.5 && b.y + b.h <= box.y + box.h + 0.5, `${what}: ${JSON.stringify(b)} inside ${JSON.stringify(box)}`).toBe(true);
    expect(rectsTouch(b, chip), `${what}: vehicle ${JSON.stringify(b)} under the chip ${JSON.stringify(chip)}`).toBe(false);
  }
  const crash = union(bodies);
  const share = Math.max(crash.w, crash.h) / Math.min(box.w, box.h);
  expect(share, `${what}: the crash spans ${share.toFixed(2)} of the diagram's shorter side`).toBeGreaterThanOrEqual(MIN_CRASH_SHARE);
  // The key: every symbol drawn on the diagram is named, under the diagram (and its caption), never over the picture or a vehicle.
  expect(legend, `${what}: has a key`).not.toBeNull();
  expect([...legend!.kinds].sort()).toEqual(featureKinds(roads).sort());
  expect(legend!.y, `${what}: the key starts under the diagram`).toBeGreaterThanOrEqual(box.y + box.h);
  expect(rectsTouch(legend!, box), `${what}: the key touches the picture`).toBe(false);
  for (const b of bodies) expect(rectsTouch(b, legend!), `${what}: vehicle ${JSON.stringify(b)} under the key`).toBe(false);
  expect(legend!.y + legend!.h, `${what}: the key ends above the footer`).toBeLessThan(page.footerTop);
  const keyTexts = page.texts.filter((t) => t.box.y >= legend!.y - 0.5 && t.box.y + t.box.h <= legend!.y + legend!.h + 0.5 && t.box.x >= legend!.x - 0.5);
  for (const kind of legend!.kinds) expect(keyTexts.map((t) => t.text), `${what}: ${kind} named in the key`).toContain(FEATURE_NAMES[kind]);
  expect(norm(keyTexts.map((t) => t.text).join(" ")), what).toContain(FEATURE_LEGEND_NOTE);
  // Nothing in the diagram's own region spells out the key any more.
  expect(page.texts.filter((t) => t.region === "diagram").map((t) => t.text), what).not.toContain(FEATURE_LEGEND_NOTE);
  expect(page.minDiagramTextPt).toBeGreaterThanOrEqual(8);
  expect(page.minTextPt).toBeGreaterThanOrEqual(8);
  const read = await readPdf(pdf.bytes);
  expect(norm(read.pageTexts[0]!)).toContain(FEATURE_LEGEND_NOTE);
  for (const p of pdf.report) expect(p.bodyBottom).toBeLessThan(p.footerTop);
}

describe("the PDF diagram with road symbols: the crash fills the picture and the key is under the caption", () => {
  for (const name of EXAMPLES) {
    for (const thumb of [true, false]) {
      it(`${name} (${thumb ? "map picture" : "road outline map"}): still one page, crash clear of the chip and the key`, async () => {
        const { scene, sim, roads } = example(name);
        expect(roads.features!.length).toBeGreaterThan(0);
        const pdf = await pdfOf(scene, sim, roads, thumb);
        expect(pdf.pages, `${name} stays on one page`).toBe(1);
        await expectClearDiagram(pdf, roads, name);
      });
    }
  }

  it("a claim that runs to a second page (four vehicles, every answer, photos) keeps the same diagram on page 1", async () => {
    const { scene, sim } = fourVehicle();
    const roads = exampleRoads("t-bone-intersection");
    scene.conditions = { lighting: "dark-lit", weather: "snow", visibility: ["sun-glare", "parked-cars", "hedges"] };
    for (const v of scene.vehicles) v.account = { control: "flashing", signaled: "yes", braking: "no", swerving: "not-sure", airbags: "yes", towed: "yes" };
    const pdf = await pdfOf(scene, sim, roads, true);
    expect(pdf.pages).toBeGreaterThanOrEqual(2);
    await expectClearDiagram(pdf, roads, "four vehicles");
  });

  it("the diagram plan: legend 'none' gives the scene the whole box; the default keeps the PNG's strip exactly as it was", async () => {
    const measure = await brandMeasure();
    for (const name of EXAMPLES) {
      const { sim, roads } = example(name);
      const box = { x: 10, y: 20, w: 264, h: 177 };
      const inside = planDiagram(sim, roads, { box, minTextSize: 8, legend: "inside" }, measure);
      expect(planDiagram(sim, roads, { box, minTextSize: 8 }, measure), `${name}: "inside" is the default`).toEqual(inside);
      expect(inside.legend, name).not.toBeNull();
      expect(inside.safe.h + inside.legend!.h).toBeCloseTo(box.h, 6);
      const none = planDiagram(sim, roads, { box, minTextSize: 8, legend: "none" }, measure);
      expect(none.legend, name).toBeNull();
      expect(none.safe, name).toEqual(box);
      expect(none.keep.some((k) => k.w === box.w), `${name}: no key strip to keep clear`).toBe(false);
      expect(none.prims.some((p) => p.k === "text" && (p.text === FEATURE_LEGEND_NOTE || Object.values(FEATURE_NAMES).includes(p.text))), `${name}: no key drawn`).toBe(false);
      expect(none.scale, `${name}: the scene is drawn larger without the strip`).toBeGreaterThanOrEqual(inside.scale);
    }
  });

  it("road symbols under an overlay (the PDF's chip) are left out rather than half hidden", async () => {
    const measure = await brandMeasure();
    const { sim, roads } = example("t-bone-intersection");
    const box = { x: 0, y: 0, w: 400, h: 300 };
    // Each symbol sits on a disc of the surface colour; they are drawn before any vehicle, ring, marker or letter disc.
    const discs = (obstacles: Rect[]) => planDiagram(sim, roads, { box, minTextSize: 8, legend: "none", obstacles }, measure).prims
      .filter((p): p is Extract<Prim, { k: "circle" }> => p.k === "circle" && p.fill === color("color-surface"));
    const first = discs([])[0]!;
    const symbols = (obstacles: Rect[]) => discs(obstacles).filter((p) => p.r === first.r);
    const plain = symbols([]);
    expect(plain.length).toBeGreaterThan(1);
    const ob: Rect = { x: first.c[0] - 10, y: first.c[1] - 10, w: 20, h: 20 };
    const moved = symbols([ob]);
    expect(moved.length).toBeLessThan(plain.length);
    for (const p of moved) expect(rectsTouch({ x: p.c[0] - p.r, y: p.c[1] - p.r, w: p.r * 2, h: p.r * 2 }, ob)).toBe(false);
  });
});
