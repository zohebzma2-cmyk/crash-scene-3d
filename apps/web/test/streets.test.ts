import { describe, expect, it } from "vitest";
import { fitViewBox } from "../src/lib/diagramView";
import { streetNames, templateAxes } from "../src/lib/streets";
import { tbone, tboneNet } from "./fakes";

const vb = fitViewBox({ minX: -20, maxX: 20, minY: -20, maxY: 20 }, 4 / 3, 4, 60);

describe("street name spots", () => {
  it("offers spots in view on each named road, once per name", () => {
    const names = streetNames(tbone, tboneNet(), vb, { x: 0, y: 0 });
    const labels = names.map((n) => n.name);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).toContain("Main Street");
    for (const n of names) {
      expect(n.spots.length).toBeGreaterThan(0);
      for (const s of n.spots) {
        expect(s.at.x).toBeGreaterThan(vb.x);
        expect(s.at.x).toBeLessThan(vb.x + vb.w);
        expect(Math.abs(s.angleDeg)).toBeLessThanOrEqual(90);     // always upright
      }
    }
  });

  it("ranks spots by closeness to a preferred distance from the impact, not by being on top of it", () => {
    const main = streetNames(tbone, tboneNet(), vb, { x: 0, y: 0 }).find((n) => n.name === "Main Street")!;
    const d = (s: { at: { x: number; y: number } }) => Math.hypot(s.at.x, s.at.y);
    expect(d(main.spots[0]!)).toBeGreaterThan(Math.min(vb.w, vb.h) * 0.1);
  });

  it("uses the vehicles' own road names on the template when there is no road data", () => {
    const names = streetNames(tbone, null, vb, { x: 0, y: 0 });
    expect(names.map((n) => n.name).sort()).toEqual(["Main Street", "Park Street"]);
    expect(templateAxes(tbone.vehicles)).toHaveLength(2);
  });
});
