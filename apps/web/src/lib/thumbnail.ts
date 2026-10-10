// Geometry for the PDF map thumbnail. The thumbnail is copied from tiles already loaded in the visible
// map (never fetched for export), and it is cropped so the pin is exactly at its center: the PDF
// fits the picture into its map box around the picture's center, so the place shown is the pin's,
// not wherever the map view happened to be panned. The picture also says how big one of its pixels is
// (a PNG text chunk), so the PDF can put street names along the roads at the pin on top of it.
import { PNG_METERS_PER_PIXEL_KEY } from "@csd/exports";
export interface Rect { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
export interface Point { readonly x: number; readonly y: number }

/**
 * The largest rectangle of the map view that is centered exactly on the pin, or null when the pin
 * is so close to an edge that less than `minSide` would be left (the PDF then draws the road outline).
 */
export function thumbnailCrop(view: { readonly w: number; readonly h: number }, pin: Point, minSide: number): Rect | null {
  const halfW = Math.min(pin.x, view.w - pin.x);
  const halfH = Math.min(pin.y, view.h - pin.y);
  if (!(halfW * 2 >= minSide) || !(halfH * 2 >= minSide)) return null;
  return { x: pin.x - halfW, y: pin.y - halfH, w: halfW * 2, h: halfH * 2 };
}

export interface LoadedTile { readonly image: CanvasImageSource; readonly rect: Rect }

export interface PaintOptions {
  /** The crop, in the map view's pixels. */
  readonly crop: Rect;
  /** Tiles already loaded, in the map view's pixels. */
  readonly tiles: readonly LoadedTile[];
  /** The pin, in the map view's pixels. */
  readonly pin: Point;
  /** Output pixels per view pixel. */
  readonly scale: number;
  readonly dotRadius: number;
  readonly ringWidth: number;
  readonly dotColor: string;
  readonly ringColor: string;
}

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Draw the crop: loaded tiles shifted so the crop's corner is the canvas corner, then the pin as a dot
 * with a ring. Returns how many tiles were drawn (0 means there is nothing worth keeping).
 */
export function paintThumbnail(ctx: CanvasRenderingContext2D, o: PaintOptions): number {
  ctx.save();
  ctx.scale(o.scale, o.scale);
  ctx.translate(-o.crop.x, -o.crop.y);
  let drew = 0;
  for (const t of o.tiles) {
    if (!overlaps(t.rect, o.crop)) continue;
    ctx.drawImage(t.image, t.rect.x, t.rect.y, t.rect.w, t.rect.h);
    drew++;
  }
  if (drew) {
    ctx.fillStyle = o.dotColor;
    ctx.beginPath();
    ctx.arc(o.pin.x, o.pin.y, o.dotRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = o.ringWidth;
    ctx.strokeStyle = o.ringColor;
    ctx.stroke();
  }
  ctx.restore();
  return drew;
}

/** Ground meters per pixel of the captured picture: Web Mercator at this latitude and zoom (256 px tiles), at `scale` pixels per map pixel. */
export function metersPerImagePixel(lat: number, zoom: number, scale: number): number {
  const earthCircumferenceM = 40_075_016.685_578_49;
  return (earthCircumferenceM * Math.cos((lat * Math.PI) / 180)) / (256 * 2 ** zoom) / scale;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = (bytes: Uint8Array): number => { let c = 0xffffffff; for (const b of bytes) c = CRC_TABLE[(c ^ b) & 255]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

/** The same PNG with one tEXt chunk (Latin-1 key and value) added before IEND. A file that isn't a PNG comes back unchanged. */
export function addPngText(png: Uint8Array, key: string, value: string): Uint8Array {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (png.length < 20 || sig.some((b, i) => png[i] !== b)) return png;
  const latin1 = (t: string) => Uint8Array.from(Array.from(t, (ch) => ch.charCodeAt(0) & 255));
  const data = new Uint8Array([...latin1(key), 0, ...latin1(value)]);
  const chunk = new Uint8Array(12 + data.length);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, data.length);
  chunk.set([0x74, 0x45, 0x58, 0x74], 4); // "tEXt"
  chunk.set(data, 8);
  dv.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  const iend = png.length - 12; // IEND is always the last 12 bytes
  const out = new Uint8Array(png.length + chunk.length);
  out.set(png.subarray(0, iend), 0);
  out.set(chunk, iend);
  out.set(png.subarray(iend), iend + chunk.length);
  return out;
}

export interface CaptureOptions extends PaintOptions {
  /** Ground meters per pixel of the picture, written into it for the PDF's street names. */
  readonly metersPerPixel?: number;
  /** Makes the canvas for the crop at the output size (injected so tests don't need a browser canvas). */
  readonly createCanvas: (width: number, height: number) => HTMLCanvasElement;
}

/**
 * Paint and encode the thumbnail. Resolves to the PNG bytes, or to null whenever there is nothing
 * trustworthy to keep (no 2D context, painting threw, no tiles drawn, no blob, encoding failed), so a
 * caller can always clear what it had before.
 */
export async function captureThumbnail(o: CaptureOptions): Promise<Uint8Array | null> {
  try {
    const canvas = o.createCanvas(Math.round(o.crop.w * o.scale), Math.round(o.crop.h * o.scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    if (paintThumbnail(ctx, o) === 0) return null;
    const blob = await new Promise<Blob | null>((resolve, reject) => {
      try { canvas.toBlob((b) => resolve(b), "image/png"); } catch (e) { reject(e); }
    });
    if (!blob) return null;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return o.metersPerPixel && o.metersPerPixel > 0 ? addPngText(bytes, PNG_METERS_PER_PIXEL_KEY, String(o.metersPerPixel)) : bytes;
  } catch {
    return null;
  }
}
