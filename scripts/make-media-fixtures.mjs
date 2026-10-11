// Writes the synthetic media fixtures used in fixtures mode and tests (apps/web/test/fixtures/media/):
//   car.png   a drawn car silhouette standing in for a stock photo (400 x 267, transparent background)
//   logo.png  an abstract round badge standing in for a maker logo (128 x 128); not any real brand
//   car.glb   a minimal glTF 2.0 binary (one triangle) standing in for a 3D model
// Everything is drawn here from shapes: no real photo, logo or model (CLAUDE.md hard rule 1).
// Run: node scripts/make-media-fixtures.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const OUT = fileURLToPath(new URL("../apps/web/test/fixtures/media/", import.meta.url));

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** RGBA pixels -> PNG (8-bit RGBA, no interlace). */
function png(w, h, pixel) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = pixel(x, y);
      const o = y * (w * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

const inEllipse = (x, y, cx, cy, rx, ry) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
const inRect = (x, y, x0, y0, x1, y1) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
const CLEAR = [0, 0, 0, 0];

// A side-on car: body, cabin with two windows, two wheels with hubs, a ground shadow.
const car = png(400, 267, (x, y) => {
  for (const cx of [110, 290]) {
    if (inEllipse(x, y, cx, 196, 16, 16)) return [176, 182, 190, 255];
    if (inEllipse(x, y, cx, 196, 36, 36)) return [38, 41, 46, 255];
  }
  const glass = (inRect(x, y, 150, 96, 205, 134) || inRect(x, y, 212, 96, 268, 134)) && y - 96 >= (150 - x) * 0.6 && y - 96 >= (x - 268) * 0.6;
  if (glass) return [150, 182, 210, 255];
  const cabin = inRect(x, y, 128, 84, 292, 146) && y - 84 >= (128 + 30 - x) * 1.2 && y - 84 >= (x - 292 + 30) * 1.2;
  const body = inRect(x, y, 40, 140, 360, 200) && !(y > 186 && (x < 52 || x > 348));
  if (cabin || body) return y < 168 ? [78, 104, 140, 255] : [64, 88, 120, 255];
  if (inEllipse(x, y, 200, 232, 170, 8)) return [0, 0, 0, 40];
  return CLEAR;
});

// An abstract badge: a ring and a chevron, in two greys.
const logo = png(128, 128, (x, y) => {
  const d = Math.hypot(x - 64, y - 64);
  if (d <= 60 && d >= 50) return [90, 96, 106, 255];
  const chevron = Math.abs(x - 64) <= 30 && y >= 44 + Math.abs(x - 64) * 0.6 && y <= 60 + Math.abs(x - 64) * 0.6;
  if (chevron) return [90, 96, 106, 255];
  if (d < 50) return [236, 238, 241, 255];
  return CLEAR;
});

// One triangle, positions only.
function glb() {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const bin = Buffer.from(positions.buffer);
  const json = {
    asset: { version: "2.0", generator: "crash-scene-3d fixture" },
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.length }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] }],
  };
  let jsonBuf = Buffer.from(JSON.stringify(json), "utf8");
  if (jsonBuf.length % 4) jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(4 - (jsonBuf.length % 4), 0x20)]);
  const header = Buffer.alloc(12);
  header.write("glTF", 0, "ascii");
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + bin.length, 8);
  const jh = Buffer.alloc(8);
  jh.writeUInt32LE(jsonBuf.length, 0);
  jh.write("JSON", 4, "ascii");
  const bh = Buffer.alloc(8);
  bh.writeUInt32LE(bin.length, 0);
  bh.write("BIN\0", 4, "ascii");
  return Buffer.concat([header, jh, jsonBuf, bh, bin]);
}

mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}car.png`, car);
writeFileSync(`${OUT}logo.png`, logo);
writeFileSync(`${OUT}car.glb`, glb());
console.log(`wrote car.png (${car.length} B), logo.png (${logo.length} B), car.glb to ${OUT}`);
