import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseScene } from "../src";

const EXAMPLES = [
  "t-bone-intersection", "highway-rear-end", "parking-lot-backing",
  // Curated, famous public intersections pre-baked so a reviewer never waits on a live Overpass call.
  "nyc-5th-42nd", "chicago-state-madison", "la-hollywood-highland", "sf-haight-ashbury",
];

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
