import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseScene, simulate } from "@csd/core";
import { parseOverpass } from "@csd/mapdata";
import { sceneFile } from "../src/scene-file";
import { buildModel } from "../src/model";
import { buildPdf } from "../src/pdf";
import { brandFonts, syntheticPng } from "./helpers";
describe("feature legends in actual cached example PDFs", () => {
  for (const name of ["t-bone-intersection", "highway-rear-end", "parking-lot-backing"]) it(`${name}: legend and vehicles stay clear of the north/scale chip`, async () => {
    const dir = new URL(`../../../examples/${name}/`, import.meta.url);
    const raw = JSON.parse(readFileSync(new URL("osm.json", dir), "utf8"));
    const roads = parseOverpass(raw, { origin: raw.center }, raw.radiusM, raw.fetchedAt);
    expect(roads.features!.length).toBeGreaterThan(0);
    const parsed = parseScene(JSON.parse(readFileSync(new URL("scene.json", dir), "utf8")));
    if (!parsed.ok) throw new Error("Invalid synthetic fixture");
    const scene = parsed.value, result = simulate(scene, roads);
    if (!result.ok) throw new Error("Invalid synthetic simulation");
    const sim = result.result;
    const { stamp } = await sceneFile(scene, sim, "2026-10-11T00:00:00Z");
    const pdf = await buildPdf({ model: buildModel(scene, sim, stamp), scene, sim, roads, fonts: brandFonts(), createdAt: stamp.createdAt, sceneFileName: "synthetic.json", mapThumbnail: syntheticPng(800, 600, "map") });
    const { chip, keep, box } = pdf.report[0]!.north!;
    expect(keep.some((k) => k.w === box.w && k.h > 0)).toBe(true);
    for (const k of keep) expect(k.x < chip.x + chip.w && chip.x < k.x + k.w && k.y < chip.y + chip.h && chip.y < k.y + k.h).toBe(false);
    expect(pdf.report[0]!.minDiagramTextPt).toBeGreaterThanOrEqual(8);
  });
});
