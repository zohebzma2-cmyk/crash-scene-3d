// Derives the tight-cropped InsurifyAI mark and the favicon files from the official
// files in design/brand/. Nothing is redrawn or recolored:
//   insurifyai-mark.svg  the same <g transform> and <path> as insurifyai.svg, minus the
//                        white BIMI background <rect>, with the viewBox cropped to the path.
//   favicon-32.png / apple-touch-icon.png  plain resampling of logo-mark.png
//                        (the apple icon is laid on the official white, because iOS
//                        paints transparent icons black).
//   favicon.ico          the same resampling at 16, 32 and 48 px, each a PNG inside one
//                        .ico file, for the browsers and crawlers that ask for /favicon.ico.
// Run: node scripts/build-brand.mjs   (a test fails if the checked-in files are stale)
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const brand = `${root}design/brand/`;

/** Pull the one path and the group transform out of the official SVG. */
export function parseOfficial(svg) {
  const g = svg.match(/<g transform="translate\(([\d.]+) ([\d.]+)\) scale\(([\d.]+)\)">/);
  const p = svg.match(/<path fill="(#[0-9A-Fa-f]{6})" fill-rule="evenodd" d="([^"]+)"\/>/);
  if (!g || !p) throw new Error("insurifyai.svg is not the shape this script knows (one path in one translate/scale group)");
  return { tx: Number(g[1]), ty: Number(g[2]), scale: Number(g[3]), fill: p[1], d: p[2] };
}

/** Bounds of the path points (absolute M/L/Z polygons), in the path's own coordinates. */
export function pathBounds(d) {
  const nums = [...d.matchAll(/[ML]\s*(-?[\d.]+)\s+(-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
  if (!nums.length || /[a-df-ln-yA-DF-KN-Y]/.test(d.replace(/[MLZ]/g, ""))) throw new Error("path has commands other than M, L, Z");
  const xs = nums.map((n) => n[0]);
  const ys = nums.map((n) => n[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

export function buildMarkSvg(officialSvg) {
  const o = parseOfficial(officialSvg);
  const b = pathBounds(o.d);
  const r = (n) => Number(n.toFixed(2));
  const x = r(o.tx + o.scale * b.minX);
  const y = r(o.ty + o.scale * b.minY);
  const w = r(o.scale * (b.maxX - b.minX));
  const h = r(o.scale * (b.maxY - b.minY));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${w} ${h}">
<title>InsurifyAI</title>
<g transform="translate(${o.tx} ${o.ty}) scale(${o.scale})">
<path fill="${o.fill}" fill-rule="evenodd" d="${o.d}"/>
</g>
</svg>
`;
}

export async function buildFavicons(markPng) {
  const { createCanvas, loadImage } = await import("@napi-rs/canvas");
  const img = await loadImage(markPng);
  const make = (size, whiteBackground) => {
    const cv = createCanvas(size, size);
    const ctx = cv.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    if (whiteBackground) { ctx.fillStyle = "#FFFFFF"; ctx.fillRect(0, 0, size, size); }
    ctx.drawImage(img, 0, 0, size, size);
    return cv.toBuffer("image/png");
  };
  return { "favicon-32.png": make(32, false), "apple-touch-icon.png": make(180, true), "favicon.ico": icoFromPngs(ICO_SIZES.map((s) => [s, make(s, false)])) };
}

/** The sizes inside favicon.ico. */
export const ICO_SIZES = [16, 32, 48];

/**
 * An .ico file holding PNG images (allowed since Windows Vista; every current browser reads it): a 6-byte header,
 * one 16-byte entry per image (size, colour depth 32, byte length, offset), then the PNG files themselves.
 * `images` is [[size in px, PNG bytes], ...].
 */
export function icoFromPngs(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(([size, png], i) => {
    const at = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, at); // width (0 = 256)
    header.writeUInt8(size >= 256 ? 0 : size, at + 1); // height
    header.writeUInt8(0, at + 2); // no palette
    header.writeUInt8(0, at + 3); // reserved
    header.writeUInt16LE(1, at + 4); // colour planes
    header.writeUInt16LE(32, at + 6); // bits per pixel
    header.writeUInt32LE(png.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map(([, png]) => png)]);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const pub = `${root}apps/web/public/`;
  mkdirSync(pub, { recursive: true });
  const mark = buildMarkSvg(readFileSync(`${brand}insurifyai.svg`, "utf8"));
  writeFileSync(`${brand}insurifyai-mark.svg`, mark);
  writeFileSync(`${pub}favicon.svg`, mark);
  writeFileSync(`${pub}insurifyai-mark.svg`, mark); // the header <img> (a real file on our origin, never inlined)
  for (const [name, buf] of Object.entries(await buildFavicons(readFileSync(`${brand}logo-mark.png`)))) writeFileSync(`${pub}${name}`, buf);
  console.log("wrote design/brand/insurifyai-mark.svg and apps/web/public/{favicon.svg,insurifyai-mark.svg,favicon-32.png,apple-touch-icon.png,favicon.ico}");
}
