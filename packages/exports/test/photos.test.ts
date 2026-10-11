// Stock photos in the exports: an optional fixed-width cell in the PDF vehicles table and a card per vehicle
// along the bottom of the 3D stills, from a provider injected like the canvas. Synthetic pictures only.
import { describe, expect, it, vi } from "vitest";
import type { ExportRequest, Scene, SimulationResult } from "@csd/core";
import { buildExports, sceneFile, type VehicleMediaProvider } from "../src";
import { buildModel, fileClaim } from "../src/model";
import { buildPdf } from "../src/pdf";
import { renderStillPng } from "../src/png";
import { decodePng } from "../src/png-decode";
import { brandFonts, readPdf, saveOutput, syntheticPng, testCanvas } from "./helpers";
import { loadRoads } from "./osm-roads";
import { twoVehicle } from "./sim-fixtures";

const CREATED = "2026-10-09T20:52:18Z";
const NOW = new Date("2026-10-09T20:52:18.456Z");

async function pdf(scene: Scene, sim: SimulationResult, photos?: ReadonlyMap<string, Uint8Array>) {
  const { stamp } = await sceneFile(scene, sim, CREATED);
  return buildPdf({
    model: buildModel(scene, sim, stamp), scene, sim, roads: loadRoads("t-bone-intersection", scene.location), fonts: brandFonts(), createdAt: CREATED,
    sceneFileName: `crash-scene-${fileClaim(scene.claim.number)}.json`, mapThumbnail: syntheticPng(800, 600, "map"),
    ...(photos ? { vehiclePhotos: photos } : {}),
  });
}

describe("PDF vehicles table photo cell", () => {
  it("is absent without photos (the table is as before)", async () => {
    const { scene, sim } = twoVehicle();
    const r = await pdf(scene, sim);
    expect(r.report[0]!.images).toHaveLength(1); // the map only
  });

  it("holds each vehicle's photo, inside the page body, and the page still fits", async () => {
    const { scene, sim } = twoVehicle();
    const photos = new Map(scene.vehicles.map((v) => [v.id, syntheticPng(600, 400, `photo ${v.id}`)] as const));
    const r = await pdf(scene, sim, photos);
    saveOutput("pdf-with-photos.pdf", r.bytes);
    const p = r.report[0]!;
    expect(r.pages).toBe(1);
    expect(p.images).toHaveLength(1 + scene.vehicles.length);
    const cells = p.images.slice(1);
    for (const c of cells) {
      expect(c.w).toBeGreaterThan(20);
      expect(c.w / c.h).toBeCloseTo(1.5, 1);
      expect(c.y + c.h).toBeLessThan(p.footerTop);
    }
    // One cell per row, stacked, in the same column.
    expect(new Set(cells.map((c) => Math.round(c.x))).size).toBe(1);
    expect(cells[1]!.y).toBeGreaterThan(cells[0]!.y + cells[0]!.h - 0.5);
    expect(p.bodyBottom).toBeLessThan(p.footerTop);
    const read = await readPdf(r.bytes);
    // Every vehicle's text is still in the table.
    for (const v of scene.vehicles) expect(read.text).toContain(v.make);
  });

  it("a photo that isn't a readable PNG is left out, nothing else changes", async () => {
    const { scene, sim } = twoVehicle();
    const r = await pdf(scene, sim, new Map([["A", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])]]));
    expect(r.report[0]!.images).toHaveLength(1);
  });
});

describe("still photo cards", () => {
  it("one card per vehicle with a photo along the bottom of the frame, letter and picture, clear of the band", async () => {
    const { scene, sim } = twoVehicle();
    const { stamp } = await sceneFile(scene, sim, CREATED);
    const tc = testCanvas();
    const fam = await tc.factory.registerFonts(brandFonts());
    const photo = syntheticPng(600, 400, "photo");
    const { layout, png } = await renderStillPng(syntheticPng(960, 492, "impact"), "Moment of impact", buildModel(scene, sim, stamp), tc.factory, fam, new Map([["A", photo], ["B", photo]]));
    saveOutput("still-with-photos.png", png);
    expect(layout.photoCards).toHaveLength(2);
    for (const c of layout.photoCards) {
      expect(c.y + c.h).toBeLessThanOrEqual(layout.bandTop);
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.x + c.w).toBeLessThanOrEqual(layout.width);
    }
    expect(layout.photoCards[1]!.x).toBeGreaterThan(layout.photoCards[0]!.x + layout.photoCards[0]!.w);
    // The letters are drawn on the cards.
    for (const id of ["A", "B"]) {
      const t = tc.drawn.find((d) => d.text === id && d.y > layout.photoCards[0]!.y && d.y < layout.bandTop);
      expect(t, id).toBeDefined();
    }
    // The photo's own pixels are there (its background color, not the card's white), in the card's right part.
    const out = await decodePng(png);
    const c = layout.photoCards[0]!;
    const at = (x: number, y: number) => Array.from(out.rgba.subarray((Math.round(y) * out.width + Math.round(x)) * 4, (Math.round(y) * out.width + Math.round(x)) * 4 + 3));
    expect(at(c.x + c.w - 40, c.y + 20)).toEqual(at(c.x + c.w - 60, c.y + 30));
    const photoPixel = await decodePng(photo);
    expect(at(c.x + c.w - 40, c.y + 20)).toEqual(Array.from(photoPixel.rgba.subarray(0, 3)));
  });

  it("without photos: no cards", async () => {
    const { scene, sim } = twoVehicle();
    const { stamp } = await sceneFile(scene, sim, CREATED);
    const tc = testCanvas();
    const fam = await tc.factory.registerFonts(brandFonts());
    const { layout } = await renderStillPng(syntheticPng(960, 492, "impact"), "Final rest", buildModel(scene, sim, stamp), tc.factory, fam);
    expect(layout.photoCards).toEqual([]);
  });
});

describe("buildExports with a photo provider", () => {
  const req = (scene: Scene, sim: SimulationResult): ExportRequest => ({
    scene, sim, roads: loadRoads("t-bone-intersection", scene.location), formats: ["pdf", "png-impact"], fonts: brandFonts(), now: () => NOW,
    stills: { impact: syntheticPng(960, 492, "impact") }, mapThumbnail: syntheticPng(800, 600, "map"),
  });

  it("asks once per vehicle and puts the photos in; a failing or odd answer is skipped quietly", async () => {
    const { scene, sim } = twoVehicle();
    const tc = testCanvas();
    const vehiclePhoto = vi.fn(async (v: { id: string }) => {
      if (v.id === "A") return syntheticPng(600, 400, "A");
      throw new Error("offline");
    });
    const media: VehicleMediaProvider = { vehiclePhoto };
    const b = await buildExports(req(scene, sim), tc.factory, media);
    expect(vehiclePhoto).toHaveBeenCalledTimes(scene.vehicles.length);
    expect(b.skipped).toEqual([]);
    expect(b.files.map((f) => f.name.split("-").pop())).toEqual(expect.arrayContaining(["impact.png"]));
    // Same files as without a provider: photos never add or drop a file.
    const without = await buildExports(req(scene, sim), testCanvas().factory);
    expect(b.files.map((f) => f.name)).toEqual(without.files.map((f) => f.name));
    expect(b.stamp.fingerprintHex).toBe(without.stamp.fingerprintHex);
  });

  it("is never asked when only the scene file or the diagram is saved", async () => {
    const { scene, sim } = twoVehicle();
    const vehiclePhoto = vi.fn(async () => null);
    await buildExports({ ...req(scene, sim), formats: ["json", "png-diagram"] }, testCanvas().factory, { vehiclePhoto });
    expect(vehiclePhoto).not.toHaveBeenCalled();
  });
});
