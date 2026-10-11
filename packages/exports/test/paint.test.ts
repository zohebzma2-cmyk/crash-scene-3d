// Round B colours in the exports: the diagram (PNG and PDF) fills a painted body with the picked colour and keeps its
// outline and letter in the vehicle token colour; the PDF vehicles table names the colour and shows a swatch.
import { describe, expect, it } from "vitest";
import { inkOn, type Scene, type SimulationResult } from "@csd/core";
import { sceneFile } from "../src";
import { planDiagram } from "../src/diagram";
import type { Prim } from "../src/draw";
import { buildModel, fileClaim, paintByLetter } from "../src/model";
import { buildPdf } from "../src/pdf";
import { renderDiagramPng } from "../src/png";
import { decodePng } from "../src/png-decode";
import { color, vehicleColor } from "../src/style";
import { brandFonts, brandMeasure, readPdf, renderPdfPage, syntheticPng, testCanvas } from "./helpers";
import { loadRoads } from "./osm-roads";
import { twoVehicle } from "./sim-fixtures";

const CREATED = "2026-10-09T20:52:18Z";
/** A paint no token comes near, so its pixels can be counted. */
const LIME = "#7fff00";

const painted = (hex = LIME): { scene: Scene; sim: SimulationResult } => {
  const { scene, sim } = twoVehicle();
  const s: Scene = structuredClone(scene);
  s.vehicles[0]!.color = { name: "Custom", hex };
  return { scene: s, sim };
};

/** Pixels within `tol` (per channel) of a hex colour. */
function countNear(rgba: Uint8ClampedArray, hex: string, tol = 24): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
  let n = 0;
  for (let i = 0; i < rgba.length; i += 4) if (Math.abs(rgba[i]! - r) <= tol && Math.abs(rgba[i + 1]! - g) <= tol && Math.abs(rgba[i + 2]! - b) <= tol) n++;
  return n;
}

const bodies = (prims: readonly Prim[]) => prims.filter((p): p is Extract<Prim, { k: "poly" }> => p.k === "poly" && p.closed === true && p.fill !== undefined);

describe("the diagram planner uses the picked paint", () => {
  it("fills A's body with the paint and outlines it in A's token colour; B is drawn as before", async () => {
    const { scene, sim } = painted();
    const measure = await brandMeasure();
    const box = { x: 0, y: 0, w: 800, h: 600 };
    const plan = planDiagram(sim, null, { box, paint: paintByLetter({ vehicles: scene.vehicles.map((v) => ({ id: v.id, paint: v.color ? { label: v.color.name, hex: v.color.hex } : null })) as never }) }, measure);
    const a = bodies(plan.prims).filter((p) => p.fill === LIME);
    expect(a.length).toBe(1);
    expect(a[0]!.stroke?.color).toBe(vehicleColor("A"));
    const b = bodies(plan.prims).filter((p) => p.fill === vehicleColor("B"));
    expect(b.length).toBe(1);
    expect(b[0]!.stroke).toBeUndefined();
    // The letter A stays in A's token colour, on a surface disc.
    const letters = plan.prims.filter((p): p is Extract<Prim, { k: "text" }> => p.k === "text" && p.text === "A");
    expect(letters.every((l) => l.color === vehicleColor("A"))).toBe(true);
    // Window lines on the paint take an ink with at least 4.5:1 on a near-white or near-black paint.
    for (const hex of ["#fdfdfc", "#050506"]) {
      const lines = planDiagram(sim, null, { box, paint: { A: hex } }, measure).prims.filter((p): p is Extract<Prim, { k: "poly" }> => p.k === "poly" && !p.closed && !!p.stroke && (p.stroke.color === color("color-surface") || p.stroke.color === color("color-text")));
      expect(lines.length).toBeGreaterThan(0);
      expect(inkOn(hex, color("color-surface"), color("color-text")).ratio).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("without a paint nothing changes: no outline on the bodies, token fills", async () => {
    const { sim } = twoVehicle();
    const measure = await brandMeasure();
    const plan = planDiagram(sim, null, { box: { x: 0, y: 0, w: 800, h: 600 } }, measure);
    for (const id of ["A", "B"]) {
      const f = bodies(plan.prims).filter((p) => p.fill === vehicleColor(id));
      expect(f.length).toBe(1);
      expect(f[0]!.stroke).toBeUndefined();
    }
  });
});

describe("the diagram PNG and the PDF show the paint", () => {
  it("the diagram PNG has the paint's pixels only when it is picked", async () => {
    const out: number[] = [];
    for (const make of [painted, twoVehicle]) {
      const { scene, sim } = make();
      const { stamp } = await sceneFile(scene, sim, CREATED);
      const tc = testCanvas();
      const fam = await tc.factory.registerFonts(brandFonts());
      const { png } = await renderDiagramPng({ model: buildModel(scene, sim, stamp), sim, roads: loadRoads("t-bone-intersection", scene.location) }, tc.factory, fam);
      const d = await decodePng(png);
      out.push(countNear(d.rgba, LIME));
    }
    expect(out[0]).toBeGreaterThan(200);
    expect(out[1]).toBe(0);
  });

  it("the PDF names the colour in the vehicles table, draws a swatch and paints the diagram", async () => {
    const { scene, sim } = painted();
    const { stamp } = await sceneFile(scene, sim, CREATED);
    const model = buildModel(scene, sim, stamp);
    expect(model.vehicles[0]!.paint).toEqual({ label: "Custom colour", hex: LIME });
    expect(model.vehicles[1]!.paint).toBeNull();
    const r = await buildPdf({
      model, scene, sim, roads: loadRoads("t-bone-intersection", scene.location), fonts: brandFonts(), createdAt: CREATED,
      sceneFileName: `crash-scene-${fileClaim(scene.claim.number)}.json`, mapThumbnail: syntheticPng(800, 600, "map"),
    });
    const read = await readPdf(r.bytes);
    expect(read.text).toContain("· Custom colour");
    const page = await renderPdfPage(r.bytes, 1, 1.5);
    expect(countNear(page.data, LIME, 30)).toBeGreaterThan(60);
  });
});
