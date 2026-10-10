import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Scene, SimulationResult } from "@csd/core";
import { sceneFile } from "../src";
import { planDiagram } from "../src/diagram";
import { buildModel, fileClaim } from "../src/model";
import { northArrow, northArrowSize, NORTH_ICON_POINTS } from "../src/north";
import { buildPdf, MIN_DIAGRAM_TEXT_PT } from "../src/pdf";
import { renderDiagramPng } from "../src/png";
import { brandFonts, brandMeasure, saveOutput, syntheticPng, testCanvas } from "./helpers";
import { loadRoads } from "./osm-roads";

const CREATED = "2026-10-09T20:52:18Z";
type R = { x: number; y: number; w: number; h: number };
const overlap = (a: R, b: R) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (a: R, b: R, tol = 0.01) => a.x >= b.x - tol && a.y >= b.y - tol && a.x + a.w <= b.x + b.w + tol && a.y + a.h <= b.y + b.h + tol;
const real = JSON.parse(readFileSync(new URL("./data/real-sims.json", import.meta.url), "utf8")) as Record<string, { scene: Scene; sim: SimulationResult }>;

describe("north arrow geometry", () => {
  it("is the `north` icon from the design icon set", () => {
    const icons = JSON.parse(readFileSync(new URL("../../../design/icons/icons.json", import.meta.url), "utf8")) as { groups: Record<string, Record<string, string>> };
    const markup = Object.values(icons.groups).map((g) => g.north).find(Boolean);
    expect(markup, "icons.json has a north icon").toBeTruthy();
    const d = /<path d="([^"]+)"/.exec(markup!)![1]!;
    // M12 3.5 17 19.5l-5-3-5 3 5-16Z : tip, right, notch (relative), left (relative), back to the tip.
    expect(d).toBe("M12 3.5 17 19.5l-5-3-5 3 5-16Z");
    expect(NORTH_ICON_POINTS).toEqual([[12, 3.5], [17, 19.5], [12, 16.5], [7, 19.5]]);
  });

  it("draws the kite pointing up with an N above its tip, all inside its rectangle", async () => {
    const measure = await brandMeasure();
    const a = northArrow([100, 200], 24, 8, "#000000", 1, measure);
    const size = northArrowSize(24, 8, measure);
    expect(a.rect).toEqual({ x: 100, y: 200, w: size.w, h: size.h });
    const kite = a.prims.find((p) => p.k === "poly" && p.closed && p.stroke)!;
    if (kite.k !== "poly") throw new Error("kite");
    const [tip, right, notch, left] = kite.pts;
    expect(tip![1]).toBeLessThan(notch![1]);          // the tip is the top
    expect(notch![1]).toBeLessThan(right![1]);        // the corners are lowest
    expect(tip![0]).toBeCloseTo(notch![0], 9);        // symmetric about the center line
    expect(right![0] - tip![0]).toBeCloseTo(tip![0] - left![0], 9);
    const n = a.prims.find((p) => p.k === "text")!;
    if (n.k !== "text") throw new Error("N");
    expect(n.text).toBe("N");
    expect(n.at[1]).toBeLessThan(tip![1]);            // the N sits above the tip
    for (const [x, y] of kite.pts) expect(inside({ x, y, w: 0, h: 0 }, a.rect)).toBe(true);
  });
});

describe("north arrow in the PNG diagram", () => {
  for (const [name, { scene, sim }] of Object.entries(real)) {
    it(`${name}: drawn at a readable size, inside the scale card, clear of every other card and of the scene`, async () => {
      const { stamp } = await sceneFile(scene, sim, CREATED);
      const tc = testCanvas();
      const fam = await tc.factory.registerFonts(brandFonts());
      const { layout, png } = await renderDiagramPng({ model: buildModel(scene, sim, stamp), sim, roads: loadRoads(name, scene.location) }, tc.factory, fam);
      saveOutput(`north-${name}.png`, png);
      expect(inside(layout.north, layout.scaleCard)).toBe(true);
      expect(layout.north.h).toBeGreaterThan(40);
      for (const c of layout.cards) if (c !== layout.scaleCard) expect(overlap(layout.north, c), `card ${JSON.stringify(c)}`).toBe(false);
      for (const k of layout.keep) expect(overlap(layout.north, k), `keep ${JSON.stringify(k)}`).toBe(false);
      const n = tc.drawn.filter((t) => t.text === "N");
      expect(n.length).toBeGreaterThan(0);
      expect(n.every((t) => t.size >= 16)).toBe(true);
    }, 60_000);
  }
});

describe("north arrow in the PDF diagram", () => {
  for (const [name, { scene, sim }] of Object.entries(real)) {
    it(`${name}: one page, arrow on the chip inside the diagram, at 8 pt or more, never over the scene`, async () => {
      const { stamp } = await sceneFile(scene, sim, CREATED);
      const r = await buildPdf({
        model: buildModel(scene, sim, stamp), scene, sim, roads: loadRoads(name, scene.location), fonts: brandFonts(), createdAt: CREATED,
        sceneFileName: `crash-scene-${fileClaim(scene.claim.number)}.json`, mapThumbnail: syntheticPng(800, 600, "map"),
      });
      saveOutput(`north-${name}.pdf`, r.bytes);
      expect(r.pages).toBe(1);
      const n = r.report[0]!.north!;
      expect(n, "the report records the north arrow").toBeTruthy();
      expect(inside(n.arrow, n.chip)).toBe(true);
      expect(inside(n.chip, n.box)).toBe(true);
      for (const k of n.keep) expect(overlap(n.chip, k), `chip over ${JSON.stringify(k)}`).toBe(false);
      expect(r.report[0]!.minDiagramTextPt).toBeGreaterThanOrEqual(MIN_DIAGRAM_TEXT_PT - 1e-6);
    }, 60_000);
  }
});

describe("diagram obstacles", () => {
  it("street names and markers keep clear of a rectangle drawn over the picture", async () => {
    const measure = await brandMeasure();
    for (const [name, { scene, sim }] of Object.entries(real)) {
      const box = { x: 0, y: 0, w: 400, h: 300 };
      const base = { box, letters: true, markers: true, streetLabels: true, ghosts: true, minTextSize: 8, minLine: 1, minTagRadius: 6 };
      const roads = loadRoads(name, scene.location);
      const plain = planDiagram(sim, roads, base, measure);
      // Put the obstacle where the plain plan has a marker or a street name, so it has to move.
      const names = plain.prims.filter((p) => p.k === "text" && p.font === "sansBold" && p.text.length > 3);
      const at = plain.markers[0]?.at ?? (names[0]?.k === "text" ? names[0].at : [200, 150] as const);
      const ob: R = { x: at[0] - 25, y: at[1] - 12, w: 50, h: 24 };
      const moved = planDiagram(sim, roads, { ...base, obstacles: [ob] }, measure);
      expect(moved.scale).toBeCloseTo(plain.scale, 9);
      for (const m of moved.markers) expect(overlap({ x: m.at[0] - 6, y: m.at[1] - 6, w: 12, h: 12 }, ob), `${name} marker ${m.n}`).toBe(false);
      for (const p of moved.prims) if (p.k === "text" && p.font === "sansBold" && p.text.length > 3) expect(overlap({ x: p.at[0] - 2, y: p.at[1] - 2, w: 4, h: 4 }, ob), `${name} street name ${p.text}`).toBe(false);
    }
  });
});
