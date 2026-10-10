import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseScene } from "../src";

const EXAMPLES = ["t-bone-intersection", "highway-rear-end", "parking-lot-backing"];

describe("example scenes", () => {
  for (const name of EXAMPLES) {
    it(`${name} is a valid scene with cached map data`, () => {
      const scene = JSON.parse(readFileSync(new URL(`../../../examples/${name}/scene.json`, import.meta.url), "utf8"));
      const r = parseScene(scene);
      expect(r.ok ? [] : r.errors).toEqual([]);
      const osm = JSON.parse(readFileSync(new URL(`../../../examples/${name}/osm.json`, import.meta.url), "utf8"));
      expect(osm.elements.length).toBeGreaterThan(10);
      expect(osm.osm3s?.copyright ?? "").toMatch(/ODbL/);
    });
  }
});
