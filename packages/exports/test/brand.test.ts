// The official InsurifyAI mark is never redrawn or recolored: the derived files must carry the
// original path byte for byte, in the logo blue, with the original transform.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// @ts-expect-error plain .mjs script, no types
import { ICO_SIZES, buildMarkSvg, icoFromPngs, parseOfficial, pathBounds } from "../../../scripts/build-brand.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const read = (p: string) => readFileSync(`${root}${p}`, "utf8");
const official = read("design/brand/insurifyai.svg");
const derived = read("design/brand/insurifyai-mark.svg");
const pathOf = (svg: string) => (/<path [^>]*\bd="([^"]+)"/.exec(svg) ?? [])[1];

describe("official logo files", () => {
  it("keeps the official SVG as one path and one white rect, no scripts", () => {
    expect(official.match(/<path /g)).toHaveLength(1);
    expect(official).toMatch(/<rect width="512" height="512" fill="#FFFFFF"\/>/);
    expect(official).not.toMatch(/<script|onload|href=/i);
  });
  it("derived mark has the path d byte-identical to the original", () => {
    const d = pathOf(official);
    expect(d).toBeTruthy();
    expect(pathOf(derived)).toBe(d);
  });
  it("derived mark is the logo blue with the same transform and no background rect", () => {
    expect(derived).toContain('fill="#2369D7"');
    expect(derived).toContain('fill-rule="evenodd"');
    expect(derived).toContain('<g transform="translate(64 64) scale(0.75)">');
    expect(derived).not.toContain("<rect");
    expect(derived).not.toMatch(/#FFFFFF/i);
  });
  it("derived viewBox is cropped tightly to the path bounds", () => {
    const o = parseOfficial(official);
    const b = pathBounds(o.d);
    const [x, y, w, h] = (/viewBox="([^"]+)"/.exec(derived)![1]!).split(" ").map(Number) as [number, number, number, number];
    expect(x).toBeCloseTo(o.tx + o.scale * b.minX, 1);
    expect(y).toBeCloseTo(o.ty + o.scale * b.minY, 1);
    expect(w).toBeCloseTo(o.scale * (b.maxX - b.minX), 1);
    expect(h).toBeCloseTo(o.scale * (b.maxY - b.minY), 1);
    expect(w).toBeLessThan(512);
  });
  it("checked-in derived files are current (run: node scripts/build-brand.mjs)", () => {
    expect(derived).toBe(buildMarkSvg(official));
    expect(read("apps/web/public/favicon.svg")).toBe(derived);
    expect(read("apps/web/public/insurifyai-mark.svg")).toBe(derived);
    // PNG bytes depend on the platform's encoder, so the favicons are checked by size, not bytes.
    for (const [name, size] of [["favicon-32.png", 32], ["apple-touch-icon.png", 180]] as const) {
      const buf = readFileSync(`${root}apps/web/public/${name}`);
      expect([buf.readUInt32BE(16), buf.readUInt32BE(20)]).toEqual([size, size]);
    }
  });
  it("serves a real /favicon.ico: an icon file holding the mark as 16, 32 and 48 px PNGs", () => {
    const ico = readFileSync(`${root}apps/web/public/favicon.ico`);
    expect([ico.readUInt16LE(0), ico.readUInt16LE(2)]).toEqual([0, 1]);   // reserved, type icon
    const count = ico.readUInt16LE(4);
    expect(count).toBe(ICO_SIZES.length);
    const sizes: number[] = [];
    for (let i = 0; i < count; i++) {
      const at = 6 + 16 * i;
      const size = ico.readUInt8(at), length = ico.readUInt32LE(at + 8), offset = ico.readUInt32LE(at + 12);
      const png = ico.subarray(offset, offset + length);
      expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      expect([png.readUInt32BE(16), png.readUInt32BE(20)], `entry ${i}`).toEqual([size, size]);
      expect(ico.readUInt16LE(at + 6)).toBe(32);
      sizes.push(size);
    }
    expect(sizes).toEqual(ICO_SIZES);
  });
  it("packs PNGs into an .ico with each entry pointing at its own bytes", () => {
    const a = Buffer.from("first png"), b = Buffer.from("second, longer png");
    const ico = icoFromPngs([[16, a], [256, b]]) as Buffer;
    expect(ico.readUInt16LE(4)).toBe(2);
    expect(ico.readUInt8(6 + 16)).toBe(0);   // 256 px is written as 0
    const entry = (i: number) => ico.subarray(ico.readUInt32LE(6 + 16 * i + 12), ico.readUInt32LE(6 + 16 * i + 12) + ico.readUInt32LE(6 + 16 * i + 8));
    expect(entry(0).toString()).toBe("first png");
    expect(entry(1).toString()).toBe("second, longer png");
    expect(ico.length).toBe(6 + 32 + a.length + b.length);
  });
});
