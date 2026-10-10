// The official InsurifyAI mark is never redrawn or recolored: the derived files must carry the
// original path byte for byte, in the logo blue, with the original transform.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// @ts-expect-error plain .mjs script, no types
import { buildMarkSvg, parseOfficial, pathBounds } from "../../../scripts/build-brand.mjs";

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
});
