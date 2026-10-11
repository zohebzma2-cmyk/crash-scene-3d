// Stock photos in the exports: an optional fixed-width cell in the PDF vehicles table and a card per vehicle
// along the bottom of the 3D stills, from a provider injected like the canvas. Synthetic pictures only.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { ExportRequest, Scene, SimulationResult } from "@csd/core";
import { buildExports, sceneFile, type VehicleMediaProvider } from "../src";
import { buildModel, fileClaim } from "../src/model";
import { buildPdf } from "../src/pdf";
import { renderStillPng } from "../src/png";
import { decodePng } from "../src/png-decode";
import { brandFonts, readPdf, saveOutput, syntheticPng, tableLines, testCanvas } from "./helpers";
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
    // The cell is headed "Stock photo" and a note under the table says whose photos these are and what they show.
    expect(read.text).toContain("Stock photo");
    expect(read.text.replace(/\s+/g, " ")).toContain("not photos of the vehicles involved");
    const plain = await readPdf((await pdf(scene, sim)).bytes);
    expect(plain.text).not.toContain("Stock photo");
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
  async function still(photos: ReadonlyMap<string, Uint8Array>, vehicles = twoVehicle()) {
    const { scene, sim } = vehicles;
    const { stamp } = await sceneFile(scene, sim, CREATED);
    const tc = testCanvas();
    const fam = await tc.factory.registerFonts(brandFonts());
    const out = await renderStillPng(syntheticPng(960, 492, "impact"), "Moment of impact", buildModel(scene, sim, stamp), tc.factory, fam, photos);
    return { ...out, tc, scene };
  }

  it("sit in the footer band, never over the picture, labelled 'Stock photo', and the still stays 1920 x 1080", async () => {
    const photo = syntheticPng(600, 400, "photo");
    const { layout, png, tc } = await still(new Map([["A", photo], ["B", photo]]));
    saveOutput("still-with-photos.png", png);
    expect([layout.width, layout.height]).toEqual([1920, 1080]);
    expect(layout.photoCards).toHaveLength(2);
    for (const c of layout.photoCards) {
      expect(c.y).toBeGreaterThanOrEqual(layout.bandTop);
      expect(c.y + c.h).toBeLessThanOrEqual(layout.bandTop + layout.band);
      expect(c.x + c.w).toBeLessThanOrEqual(layout.width);
    }
    expect(layout.photoCards[1]!.x).toBeGreaterThan(layout.photoCards[0]!.x + layout.photoCards[0]!.w);
    const first = Math.min(...layout.photoCards.map((c) => c.x));
    for (const id of ["A", "B"]) expect(tc.drawn.find((d) => d.text === id && d.y > layout.bandTop), id).toBeDefined();
    const labels = tc.drawn.filter((d) => d.text === "Stock photo");
    expect(labels).toHaveLength(2);
    // The disclaimer and the stamp stay left of the cards.
    for (const d of tc.drawn.filter((t) => t.y > layout.bandTop && !["A", "B", "Stock photo"].includes(t.text))) {
      expect(d.x + d.width, d.text).toBeLessThanOrEqual(first);
    }
    // The photo's own pixels are in the card's right part.
    const out = await decodePng(png);
    const c = layout.photoCards[0]!;
    const at = (x: number, y: number) => Array.from(out.rgba.subarray((Math.round(y) * out.width + Math.round(x)) * 4, (Math.round(y) * out.width + Math.round(x)) * 4 + 3));
    const photoPixel = await decodePng(photo);
    expect(at(c.x + c.w - 20, c.y + 15)).toEqual(Array.from(photoPixel.rgba.subarray(0, 3)));
  });

  it("four vehicles: cards that would push the band taller are left out, the still stays 1920 x 1080", async () => {
    const { fourVehicle } = await import("./sim-fixtures");
    const four = fourVehicle();
    const photo = syntheticPng(600, 400, "photo");
    const { layout } = await still(new Map(four.scene.vehicles.map((v) => [v.id, photo] as const)), four);
    expect([layout.width, layout.height]).toEqual([1920, 1080]);
    expect(layout.photoCards.length).toBeGreaterThan(0);
    for (const c of layout.photoCards) expect(c.y).toBeGreaterThanOrEqual(layout.bandTop);
  });

  it("without photos: no cards", async () => {
    const { layout } = await still(new Map());
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

describe("the photo cell and the 2deab93 table (polish/pdf)", () => {
  const data = (name: string) => JSON.parse(readFileSync(new URL(`./data/${name}`, import.meta.url), "utf8"));
  const real = data("real-sims.json") as Record<string, { scene: Scene; sim: SimulationResult }>;
  const before = data("table-text-2deab93.json") as Record<string, string[]>;

  it("without a photo, the three examples' table text is exactly the snapshot (empty map, and a provider that has none)", async () => {
    for (const [name, { scene, sim }] of Object.entries(real)) {
      expect(tableLines(await readPdf((await pdf(scene, sim, new Map())).bytes)), `${name}, no photos`).toEqual(before[name]);
      const bundle = await buildExports(
        { scene, sim, roads: loadRoads("t-bone-intersection", scene.location), formats: ["pdf"], fonts: brandFonts(), now: () => NOW, mapThumbnail: syntheticPng(800, 600, "map") },
        testCanvas().factory, { vehiclePhoto: async () => null },
      );
      const file = bundle.files.find((f) => f.name.endsWith(".pdf"))!;
      expect(tableLines(await readPdf(file.bytes)), `${name}, provider with no photos`).toEqual(before[name]);
    }
  }, 120_000);

  it("with photos (the three-vehicle overflow scene too), the cell takes its room from Direction and Speed, never Vehicle or Type", async () => {
    const overflow = data("overflow-3v.json") as { scene: Scene; sim: SimulationResult };
    for (const [name, { scene, sim }] of [...Object.entries(real), ["overflow-3v", overflow] as const]) {
      const photos = new Map(scene.vehicles.map((v) => [v.id, syntheticPng(600, 400, `photo ${v.id}`)] as const));
      const without = await pdf(scene, sim);
      const withPhotos = await pdf(scene, sim, photos);
      const [a, b] = [await readPdf(without.bytes), await readPdf(withPhotos.bytes)];
      // Column starts, from the table's header labels on page 1.
      const head = (read: typeof a, label: string) => read.positioned.find((p) => p.page === 1 && p.str.trim() === label)?.x ?? NaN;
      const cols = (read: typeof a) => ["Vehicle", "Type, weight", "Direction", "Speed at impact, as entered", "Hit on"].map((l) => head(read, l));
      const [c0, c1] = [cols(a), cols(b)];
      for (const x of [...c0, ...c1]) expect(Number.isFinite(x), name).toBe(true);
      const w = (c: number[], i: number) => c[i + 1]! - c[i]!;
      expect(w(c1, 0), `${name}: Vehicle keeps its width`).toBeCloseTo(w(c0, 0), 3);
      expect(w(c1, 1), `${name}: Type keeps its width`).toBeCloseTo(w(c0, 1), 3);
      expect(w(c1, 2), `${name}: Direction gives some room`).toBeLessThan(w(c0, 2));
      expect(w(c1, 3), `${name}: Speed gives some room`).toBeLessThan(w(c0, 3));
      expect(c1[4], `${name}: Hit on doesn't move`).toBeCloseTo(c0[4]!, 3);
      // The photo cell sits before Vehicle, which moves right by exactly what Direction and Speed gave.
      expect(c1[0]! - c0[0]!).toBeCloseTo((w(c0, 2) - w(c1, 2)) + (w(c0, 3) - w(c1, 3)), 3);
      // Vehicle and Type wrap exactly as without photos.
      const cellText = (read: typeof a, from: number, to: number) => {
        const page = read.positioned.filter((p) => p.page === 1);
        const y = (word: string) => page.find((p) => p.str.replace(/\s+/g, "") === word)!.y;
        const [top, bottom] = [y("VEHICLES"), y("KEYMEASUREMENTS")];
        return page.filter((p) => p.y < top - 0.5 && p.y > bottom + 0.5 && p.x >= from - 0.5 && p.x < to - 0.5 && p.str.trim()).map((p) => p.str.trim());
      };
      expect(cellText(b, c1[0]!, c1[2]!), `${name}: Vehicle and Type text`).toEqual(cellText(a, c0[0]!, c0[2]!));
      // Every page still keeps the body off the footer.
      for (const p of withPhotos.report) expect(p.bodyBottom).toBeLessThan(p.footerTop);
    }
  }, 180_000);
});
