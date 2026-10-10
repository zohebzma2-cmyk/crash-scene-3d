// The official logo in the PDF and the PNGs: drawn from the supplied path in the logo blue.
import { readFileSync } from "node:fs";
import { createCanvas, Path2D } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";
import { sceneFile } from "../src";
import { MARK_BOUNDS, MARK_PATH_D, MARK_SCALE, MARK_TRANSLATE } from "../src/brand";
import { MARK_ASPECT, lockup, markPlacement } from "../src/logo";
import { buildModel } from "../src/model";
import { buildPdf } from "../src/pdf";
import { decodePng } from "../src/png-decode";
import { renderDiagramPng, renderStillPng } from "../src/png";
import { PX_TO_PT, color, px, rgb01 } from "../src/style";
import { brandFonts, readPdf, renderPdfPage, saveOutput, syntheticPng, testCanvas } from "./helpers";
import { loadRoads } from "./osm-roads";
import { twoVehicle } from "./sim-fixtures";

const CREATED = "2026-10-09T20:52:18Z";
const LOGO = color("color-logo");
const LOGO_RGB = rgb01(LOGO).map((v) => Math.round(v * 255)) as [number, number, number];
const near = (d: Uint8ClampedArray, i: number, [r, g, b]: [number, number, number], tol = 2) =>
  Math.abs(d[i]! - r) <= tol && Math.abs(d[i + 1]! - g) <= tol && Math.abs(d[i + 2]! - b) <= tol;

/** Bounding box of the pixels that are exactly the logo blue (in a region), or null. */
function logoPixels(d: Uint8ClampedArray, w: number, region: { x0: number; y0: number; x1: number; y1: number }) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, n = 0;
  for (let y = Math.floor(region.y0); y < region.y1; y++) {
    for (let x = Math.floor(region.x0); x < region.x1; x++) {
      if (near(d, (y * w + x) * 4, LOGO_RGB, 1)) { n++; x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    }
  }
  return n ? { n, x0, y0, x1, y1 } : null;
}

describe("the logo blue and the mark in the generated files", () => {
  it("--color-logo is the official blue and the SVG fill agrees", () => {
    expect(LOGO).toBe("#2369D7");
    const svg = readFileSync(new URL("../../../design/brand/insurifyai.svg", import.meta.url), "utf8");
    expect(svg).toContain(`fill="${LOGO}"`);
    expect(svg).toContain(`d="${MARK_PATH_D}"`);
    expect(svg).toContain(`translate(${MARK_TRANSLATE[0]} ${MARK_TRANSLATE[1]}) scale(${MARK_SCALE})`);
  });

  it("the lockup follows logo-full.png: mark 1.742 x the font size tall, no space in the wordmark", () => {
    const l = lockup(100);
    expect(l.wordSize).toBeCloseTo(57.4, 1);
    expect(l.gap).toBeCloseTo(0.343 * l.wordSize, 6);
    expect(l.markW / l.markH).toBeCloseTo(MARK_ASPECT, 9);
    expect(MARK_ASPECT).toBeCloseTo((MARK_BOUNDS.maxX - MARK_BOUNDS.minX) / (MARK_BOUNDS.maxY - MARK_BOUNDS.minY), 9);
  });

  it("the nonzero fill (all pdf-lib has) draws the same pixels as the SVG's evenodd fill", () => {
    const draw = (rule: "nonzero" | "evenodd") => {
      const cv = createCanvas(600, 600);
      const ctx = cv.getContext("2d");
      ctx.fillStyle = "#FFFFFF";
      ctx.fillRect(0, 0, 600, 600);
      const p = markPlacement(20, 20, 560);
      ctx.translate(p.originX, p.originY);
      ctx.scale(p.scale, p.scale);
      ctx.fillStyle = LOGO;
      ctx.fill(new Path2D(MARK_PATH_D), rule);
      return ctx.getImageData(0, 0, 600, 600).data;
    };
    const a = draw("nonzero");
    const b = draw("evenodd");
    let diff = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
    expect(diff).toBe(0);
  });
});

describe("PDF header", () => {
  it("draws the mark path in #2369D7 at the right proportions, and the wordmark as text", async () => {
    const { scene, sim } = twoVehicle();
    const { stamp } = await sceneFile(scene, sim, CREATED);
    const r = await buildPdf({
      model: buildModel(scene, sim, stamp), scene, sim, roads: loadRoads("t-bone-intersection", scene.location), fonts: brandFonts(), createdAt: CREATED,
      sceneFileName: "crash-scene.json", mapThumbnail: syntheticPng(800, 600, "map"),
    });
    saveOutput("logo-pdf.pdf", r.bytes);
    // The rendered page shows the exact logo blue where the header is (content streams are compressed, so check pixels).
    const scale = 6;
    const page = await renderPdfPage(r.bytes, 1, scale);
    const margin = px("size-page-margin") * PX_TO_PT * scale;
    const markH = px("space-8") * PX_TO_PT * scale;
    const box = logoPixels(page.data, page.width, { x0: margin - 4, y0: margin - 4, x1: margin + markH * 2, y1: margin + markH + 4 });
    expect(box, "no logo-blue pixels in the header").not.toBeNull();
    expect(box!.n).toBeGreaterThan(1000);
    expect((box!.y1 - box!.y0 + 1)).toBeGreaterThan(markH * 0.97);
    expect((box!.y1 - box!.y0 + 1)).toBeLessThan(markH * 1.03);
    expect((box!.x1 - box!.x0 + 1) / (box!.y1 - box!.y0 + 1)).toBeCloseTo(MARK_ASPECT, 1);
    expect(box!.x0).toBeLessThanOrEqual(margin + 2);
    const text = (await readPdf(r.bytes)).text;
    expect(text).toContain("Insurify");
    expect(text).toContain("AI");
    // Text stays at 8 pt or larger.
    for (const p of r.report) expect(p.minTextPt).toBeGreaterThanOrEqual(8 - 1e-6);
  });
});

describe("PNG exports", () => {
  it("diagram: the logo card has the mark in #2369D7 and the wordmark text", async () => {
    const { scene, sim } = twoVehicle();
    const { stamp } = await sceneFile(scene, sim, CREATED);
    const tc = testCanvas();
    const fam = await tc.factory.registerFonts(brandFonts());
    const { png, layout } = await renderDiagramPng({ model: buildModel(scene, sim, stamp), sim, roads: loadRoads("t-bone-intersection", scene.location) }, tc.factory, fam);
    saveOutput("logo-diagram.png", png);
    const img = await decodePng(png);
    const card = layout.cards[layout.cards.length - 1]!;
    const topRight = layout.cards.filter((c) => c.x > img.width / 2 && c.y < img.height / 4);
    expect(topRight).toHaveLength(1);
    const c = topRight[0]!;
    expect(card).toBeDefined();
    const box = logoPixels(img.rgba, img.width, { x0: c.x, y0: c.y, x1: c.x + c.w, y1: c.y + c.h });
    expect(box, "no logo-blue pixels on the logo card").not.toBeNull();
    expect(box!.n).toBeGreaterThan(500);
    const markH = px("space-10");
    expect(box!.y1 - box!.y0 + 1).toBeGreaterThan(markH * 0.97);
    const words = tc.drawn.filter((t) => t.text === "Insurify" || t.text === "AI");
    expect(words.map((w) => w.text)).toEqual(["Insurify", "AI"]);
  });

  it("3D still: the logo card is drawn too", async () => {
    const { scene, sim } = twoVehicle();
    const { stamp } = await sceneFile(scene, sim, CREATED);
    const tc = testCanvas();
    const fam = await tc.factory.registerFonts(brandFonts());
    const { png, layout } = await renderStillPng(syntheticPng(960, 492, "still"), "Moment of impact", buildModel(scene, sim, stamp), tc.factory, fam);
    saveOutput("logo-still.png", png);
    const img = await decodePng(png);
    const box = logoPixels(img.rgba, img.width, { x0: layout.width * 0.7, y0: 0, x1: layout.width, y1: layout.bandTop / 3 });
    expect(box, "no logo-blue pixels top right").not.toBeNull();
    expect(box!.n).toBeGreaterThan(500);
  });
});
