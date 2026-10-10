import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";
import { Canvas, createCanvas, GlobalFonts, type SKRSContext2D } from "@napi-rs/canvas";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { BrandFonts, ExportRequest } from "@csd/core";
import type { CanvasFactory, CanvasLike } from "../src";

const fontFile = (pkg: string, file: string) => new Uint8Array(readFileSync(new URL(`../../../node_modules/@fontsource/${pkg}/files/${file}`, import.meta.url)));

export function brandFonts(ext: "woff" | "woff2" = "woff"): BrandFonts {
  return {
    sansRegular: fontFile("plus-jakarta-sans", `plus-jakarta-sans-latin-400-normal.${ext}`),
    sansBold: fontFile("plus-jakarta-sans", `plus-jakarta-sans-latin-700-normal.${ext}`),
    monoRegular: fontFile("jetbrains-mono", `jetbrains-mono-latin-400-normal.${ext}`),
  };
}

export const SANS = "Plus Jakarta Sans";
export const MONO = "JetBrains Mono";

export interface DrawnText {
  readonly text: string;
  readonly font: string;
  /** Where the text's baseline starts on the canvas, after the canvas transform. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  /** Font size in canvas px, read from the font string. */
  readonly size: number;
  readonly rotateRad: number;
}
export interface TestCanvas {
  readonly factory: CanvasFactory;
  /** Every fillText made on any canvas the factory created, with the font in effect. */
  readonly drawn: DrawnText[];
  readonly registered: Array<{ family: string; bytes: number }>;
  readonly sizes: Array<[number, number]>;
}

/** A real node canvas (@napi-rs/canvas) that records what is drawn so tests can read it back. */
export function testCanvas(): TestCanvas {
  const drawn: DrawnText[] = [];
  const registered: Array<{ family: string; bytes: number }> = [];
  const sizes: Array<[number, number]> = [];
  const factory: CanvasFactory = {
    create(width, height) {
      sizes.push([width, height]);
      const cv = createCanvas(width, height) as Canvas;
      const real = cv.getContext("2d");
      const ctx = new Proxy(real, {
        get(target, prop) {
          if (prop === "fillText") {
            return (text: string, x: number, y: number) => {
              const m = target.getTransform();
              drawn.push({
                text, font: target.font, x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f,
                width: target.measureText(text).width, size: Number(/(\d+(?:\.\d+)?)px/.exec(target.font)?.[1] ?? 0), rotateRad: Math.atan2(m.b, m.a),
              });
              target.fillText(text, x, y);
            };
          }
          const v = Reflect.get(target, prop, target) as unknown;
          return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
        set(target, prop, value) { Reflect.set(target, prop, value, target); return true; },
      }) as SKRSContext2D;
      const like = { width, height, getContext: () => ctx as unknown as ReturnType<CanvasLike["getContext"]>, __cv: cv };
      return like as CanvasLike;
    },
    async toPng(c) { return new Uint8Array((c as unknown as { __cv: Canvas }).__cv.toBuffer("image/png")); },
    async registerFonts(f: ExportRequest["fonts"]) {
      for (const [bytes, family] of [[f.sansRegular, SANS], [f.sansBold, SANS], [f.monoRegular, MONO]] as const) {
        const key = GlobalFonts.register(Buffer.from(bytes), family);
        if (!key) throw new Error(`Skia could not read the ${family} font`);
        registered.push({ family, bytes: bytes.length });
      }
      return { sans: SANS, mono: MONO };
    },
  };
  return { factory, drawn, registered, sizes };
}

export interface PdfRead {
  readonly pages: number;
  readonly text: string;
  readonly items: string[];
  /** The text of each page on its own. */
  readonly pageTexts: string[];
  /** Every text item with where it starts (PDF points, origin bottom-left) and its width. */
  readonly positioned: Array<{ str: string; x: number; y: number; w: number; page: number }>;
  /** Page size and the extent of all text (PDF points, origin bottom-left). */
  readonly page: { width: number; height: number };
  readonly extent: { minX: number; maxX: number; minY: number; maxY: number };
}

export async function readPdf(bytes: Uint8Array): Promise<PdfRead> {
  const task = getDocument({ data: bytes.slice(), useSystemFonts: false });
  const doc = await task.promise;
  const items: string[] = [];
  const pageTexts: string[] = [];
  const positioned: Array<{ str: string; x: number; y: number; w: number; page: number }> = [];
  const extent = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  let size = { width: 0, height: 0 };
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const [x0, y0, x1, y1] = page.view;
    size = { width: x1! - x0!, height: y1! - y0! };
    const tc = await page.getTextContent();
    const here: string[] = [];
    for (const it of tc.items) {
      if (!("str" in it)) continue;
      items.push(it.str);
      here.push(it.str);
      positioned.push({ str: it.str, x: it.transform[4] as number, y: it.transform[5] as number, w: it.width, page: i });
      if (!it.str.trim()) continue;
      const x = it.transform[4] as number;
      const y = it.transform[5] as number;
      extent.minX = Math.min(extent.minX, x);
      extent.maxX = Math.max(extent.maxX, x + it.width);
      extent.minY = Math.min(extent.minY, y);
      extent.maxY = Math.max(extent.maxY, y + it.height);
    }
    pageTexts.push(here.join(" ").replace(/\s+/g, " "));
  }
  const pages = doc.numPages;
  await task.destroy();
  return { pages, items, pageTexts, positioned, text: items.join(" ").replace(/\s+/g, " "), page: size, extent };
}

/** Render one PDF page to RGBA pixels (white background), as a viewer would draw it. */
export async function renderPdfPage(bytes: Uint8Array, pageNo: number, scale = 1): Promise<{ width: number; height: number; data: Uint8ClampedArray }> {
  const task = getDocument({ data: bytes.slice(), useSystemFonts: false });
  const doc = await task.promise;
  const page = await doc.getPage(pageNo);
  const vp = page.getViewport({ scale });
  const cv = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height)) as Canvas;
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, cv.width, cv.height);
  await page.render({ canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport: vp, canvas: cv as unknown as HTMLCanvasElement }).promise;
  const data = new Uint8ClampedArray(ctx.getImageData(0, 0, cv.width, cv.height).data);
  await task.destroy();
  return { width: cv.width, height: cv.height, data };
}

/** Text measurer using the brand fonts on a real canvas, like the PNG pen does. */
export async function brandMeasure(): Promise<(font: "sans" | "sansBold" | "mono", size: number, text: string) => number> {
  const tc = testCanvas();
  await tc.factory.registerFonts(brandFonts());
  const ctx = tc.factory.create(10, 10).getContext("2d")!;
  return (font, size, text) => {
    ctx.font = font === "mono" ? `400 ${size}px "${MONO}"` : `${font === "sansBold" ? 700 : 400} ${size}px "${SANS}"`;
    return ctx.measureText(text).width;
  };
}

export function saveOutput(name: string, bytes: Uint8Array): string {
  const dir = new URL("../test-output/", import.meta.url);
  mkdirSync(dir, { recursive: true });
  const path = new URL(name, dir);
  writeFileSync(path, bytes);
  return path.pathname;
}

/** Latin-1 view of a file, enough to grep PDF dictionaries (saved without object streams). */
export const latin1 = (b: Uint8Array) => new TextDecoder("latin1").decode(b);

/** A synthetic "map" picture (PNG) for the thumbnail: shapes only, no real map data. */
export function syntheticPng(width: number, height: number, label: string): Uint8Array {
  const cv = createCanvas(width, height) as Canvas;
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "#EDE9E0";
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = "#FFFFFF";
  ctx.lineWidth = height / 12;
  ctx.beginPath();
  ctx.moveTo(0, height * 0.55); ctx.lineTo(width, height * 0.45);
  ctx.moveTo(width * 0.4, 0); ctx.lineTo(width * 0.55, height);
  ctx.stroke();
  ctx.fillStyle = "#2563EB";
  ctx.beginPath(); ctx.arc(width * 0.47, height * 0.5, height / 24, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#334155";
  ctx.font = `${Math.round(height / 20)}px sans-serif`;
  ctx.fillText(label, 12, height - 12);
  return new Uint8Array(cv.toBuffer("image/png"));
}

/** Build a PNG from raw scanlines (each already starting with its filter byte). For decoder tests. */
export function makePng(opts: { width: number; height: number; colorType?: number; bitDepth?: number; raw?: Uint8Array; ihdrFirst?: boolean; ihdrLength?: number }): Uint8Array {
  const chunk = (type: string, data: Uint8Array) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "latin1");
    Buffer.from(data).copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(opts.ihdrLength ?? 13);
  ihdr.writeUInt32BE(opts.width, 0);
  ihdr.writeUInt32BE(opts.height, 4);
  ihdr[8] = opts.bitDepth ?? 8;
  ihdr[9] = opts.colorType ?? 2;
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[opts.colorType ?? 2] ?? 3;
  const raw = opts.raw ?? new Uint8Array((opts.width * channels * ((opts.bitDepth ?? 8) / 8) + 1) * opts.height);
  const parts = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk(opts.ihdrFirst === false ? "tEXt" : "IHDR", opts.ihdrFirst === false ? Buffer.from("k\0v") : ihdr)];
  if (opts.ihdrFirst === false) parts.push(chunk("IHDR", ihdr));
  parts.push(chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array(0)));
  return new Uint8Array(Buffer.concat(parts));
}

/** A plain dark PNG of any size (for clipping and letterbox checks). */
export function createSolidPng(width: number, height: number): Uint8Array {
  const cv = createCanvas(width, height) as Canvas;
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "#101820";
  ctx.fillRect(0, 0, width, height);
  return new Uint8Array(cv.toBuffer("image/png"));
}

/** The same PNG with one tEXt chunk added before IEND (what the app does to say how big a thumbnail pixel is). */
export function withPngText(png: Uint8Array, key: string, value: string): Uint8Array {
  const data = Buffer.concat([Buffer.from(key, "latin1"), Buffer.from([0]), Buffer.from(value, "latin1")]);
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write("tEXt", 4, "latin1");
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  const iend = png.length - 12;
  return new Uint8Array(Buffer.concat([Buffer.from(png.subarray(0, iend)), chunk, Buffer.from(png.subarray(iend))]));
}
