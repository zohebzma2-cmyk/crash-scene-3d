import { describe, expect, it } from "vitest";
import { iconPrims } from "../src/feature-icons";
import { color } from "../src/style";
describe("tagged one-way bearings on exported maps", () => {
  for (const [bearing, expected] of [[0, [12, 6]], [90, [18, 12]], [180, [12, 18]], [270, [6, 12]]] as const) it(`points toward ${bearing} degrees`, () => {
    const primitives = iconPrims("feature-oneway", 0, 0, 24, color("color-text"), bearing - 90);
    const points = primitives.flatMap((p) => p.k === "poly" ? p.pts : []);
    expect(points.some((p) => Math.hypot(p[0] - expected[0], p[1] - expected[1]) < 0.01)).toBe(true);
  });
});
