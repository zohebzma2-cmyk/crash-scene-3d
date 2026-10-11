#!/usr/bin/env node
// Builds the two synthetic catalog models the fixtures mode serves (apps/web/fixtures/models/), so the e2e can
// exercise the GLB path offline. Both are made-up boxes, not any real vehicle:
//
//   synthetic-box-car.glb    three's GLTFExporter: a body, a cabin and four wheels with materials named
//                            "Body", "Glass" and "Tire" (the tint sets the Body colour). Deliberately not to scale,
//                            off the origin and facing +z (glTF forward), so the viewer's fitting is exercised.
//   synthetic-baked-car.glb  written by hand like the catalog's own files: ONE mesh, ONE unnamed material whose
//                            base-colour PNG has the paint baked in (red panels, a grey window band, black tyre
//                            patches and black atlas padding), no normals. The tint recolours the red in a shader.
//
// Run: node scripts/make-fixture-glb.mjs   (writes both files; deterministic output)
import { mkdirSync, writeFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";
import { BoxGeometry, CylinderGeometry, Group, Mesh, MeshStandardMaterial } from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";

const OUT = new URL("../apps/web/fixtures/models/", import.meta.url);
mkdirSync(OUT, { recursive: true });

/* ---------- 1. the box car, through GLTFExporter ---------- */

// GLTFExporter reads its blobs with FileReader, which Node doesn't have.
globalThis.FileReader ??= class {
  readAsArrayBuffer(blob) { blob.arrayBuffer().then((b) => { this.result = b; this.onloadend?.(); }); }
  readAsDataURL(blob) { blob.arrayBuffer().then((b) => { this.result = `data:application/octet-stream;base64,${Buffer.from(b).toString("base64")}`; this.onloadend?.(); }); }
};

function boxCar() {
  const body = new MeshStandardMaterial({ name: "Body", color: 0x9aa0a6, roughness: 0.4, metalness: 0.2 });
  const glass = new MeshStandardMaterial({ name: "Glass", color: 0x334455, roughness: 0.1, transparent: true, opacity: 0.6 });
  const tire = new MeshStandardMaterial({ name: "Tire", color: 0x111111, roughness: 0.9 });
  const car = new Group();
  car.name = "SyntheticBoxCar";
  // Units are "catalog units": 4.0 long (z), 1.7 wide, 1.5 high, then the whole car is halved and moved.
  const lower = new Mesh(new BoxGeometry(1.7, 0.7, 4.0), body); lower.name = "lower"; lower.position.set(0, 0.55, 0);
  const cabin = new Mesh(new BoxGeometry(1.5, 0.55, 2.0), glass); cabin.name = "cabin"; cabin.position.set(0, 1.175, -0.2);
  const roof = new Mesh(new BoxGeometry(1.4, 0.05, 1.8), body); roof.name = "roof"; roof.position.set(0, 1.475, -0.2);
  const nose = new Mesh(new BoxGeometry(1.2, 0.3, 0.2), body); nose.name = "nose"; nose.position.set(0, 0.6, 2.0);   // +z is the front
  car.add(lower, cabin, roof, nose);
  for (const [x, z] of [[-0.75, 1.3], [0.75, 1.3], [-0.75, -1.3], [0.75, -1.3]]) {
    const w = new Mesh(new CylinderGeometry(0.3, 0.3, 0.2, 12), tire);
    w.rotation.z = Math.PI / 2; w.position.set(x, 0.3, z); w.name = "wheel";
    car.add(w);
  }
  const root = new Group();
  root.name = "root";
  root.scale.setScalar(0.5);
  root.position.set(2, 0.4, -1);
  root.add(car);
  return root;
}

const exporter = new GLTFExporter();
const boxBytes = await new Promise((resolve, reject) => exporter.parse(boxCar(), resolve, reject, { binary: true }));
writeFileSync(new URL("synthetic-box-car.glb", OUT), Buffer.from(boxBytes));

/* ---------- 2. the baked car, written by hand ---------- */

function png(width, height, pixel) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    for (let x = 0; x < width; x++) raw.set(pixel(x, y), y * (width * 4 + 1) + 1 + x * 4);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

// 64 x 64: red paint with soft shading, a grey window band, black tyre patches at the bottom corners, black padding round the edge.
const texture = png(64, 64, (x, y) => {
  if (x < 2 || y < 2 || x > 61 || y > 61) return [0, 0, 0, 255];
  if (y >= 20 && y < 30 && x >= 8 && x < 56) return [118, 124, 130, 255];
  if (y >= 50 && (x < 16 || x >= 48)) return [18, 18, 20, 255];
  const shade = 0.78 + 0.22 * (1 - Math.abs(32 - y) / 32);
  return [Math.round(196 * shade), Math.round(22 * shade), Math.round(28 * shade), 255];
});

// A box 1.8 wide, 1.4 high, 4.2 long (z), UVs over the whole texture on each face, no normals (like the catalog's files).
const geo = new BoxGeometry(1.8, 1.4, 4.2).translate(0.3, 0.7, 0.1);
const pos = new Float32Array(geo.getAttribute("position").array);
const uv = new Float32Array(geo.getAttribute("uv").array);
const idx = new Uint16Array(geo.index.array);
const pad4 = (b) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]);
const parts = [pad4(Buffer.from(pos.buffer)), pad4(Buffer.from(uv.buffer)), pad4(Buffer.from(idx.buffer)), pad4(texture)];
let off = 0;
const views = parts.map((p, i) => { const v = { buffer: 0, byteOffset: off, byteLength: [pos.byteLength, uv.byteLength, idx.byteLength, texture.length][i] }; off += p.length; return v; });
const bin = Buffer.concat(parts);
let minP = [Infinity, Infinity, Infinity], maxP = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { minP[k] = Math.min(minP[k], pos[i + k]); maxP[k] = Math.max(maxP[k], pos[i + k]); }
const json = {
  asset: { version: "2.0", generator: "crash-scene-3d scripts/make-fixture-glb.mjs (synthetic)" },
  scene: 0, scenes: [{ nodes: [0] }],
  nodes: [{ name: "geometry_0", mesh: 0 }],
  meshes: [{ name: "geometry_0", primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2, material: 0, mode: 4 }] }],
  materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 }, baseColorFactor: [1, 1, 1, 1], roughnessFactor: 1 }, doubleSided: false }],
  textures: [{ source: 0 }],
  images: [{ mimeType: "image/png", bufferView: 3 }],
  accessors: [
    { bufferView: 0, componentType: 5126, count: pos.length / 3, type: "VEC3", min: minP, max: maxP },
    { bufferView: 1, componentType: 5126, count: uv.length / 2, type: "VEC2" },
    { bufferView: 2, componentType: 5123, count: idx.length, type: "SCALAR" },
  ],
  bufferViews: views,
  buffers: [{ byteLength: bin.length }],
};
const jsonBuf = Buffer.from(JSON.stringify(json), "utf8");
const jsonChunk = Buffer.concat([jsonBuf, Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20)]);
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + bin.length, 8);
const chunkHead = (len, type) => { const b = Buffer.alloc(8); b.writeUInt32LE(len, 0); b.writeUInt32LE(type, 4); return b; };
writeFileSync(new URL("synthetic-baked-car.glb", OUT), Buffer.concat([header, chunkHead(jsonChunk.length, 0x4e4f534a), jsonChunk, chunkHead(bin.length, 0x004e4942), bin]));

console.log("wrote", new URL("synthetic-box-car.glb", OUT).pathname, `(${boxBytes.byteLength} bytes)`);
console.log("wrote", new URL("synthetic-baked-car.glb", OUT).pathname);
