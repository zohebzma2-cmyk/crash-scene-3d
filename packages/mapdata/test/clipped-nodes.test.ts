import { expect, it } from "vitest";
import { osmWays } from "../src/osm";
import { findCrossStreets } from "../src/cross";
it("keeps clipped node slots without joining unrelated missing IDs", () => {
  const data = { elements: [
    { type: "way", id: 1, nodes: [null, 2], geometry: [{ lat: 0, lon: 0 }, { lat: 0, lon: .001 }], tags: { highway: "residential", name: "First Street" } },
    { type: "way", id: 3, nodes: [null, 4], geometry: [{ lat: .01, lon: 0 }, { lat: .01, lon: .001 }], tags: { highway: "residential", name: "Second Street" } },
  ] };
  expect(osmWays(data)[0]!.nodes).toEqual([undefined, 2]);
  expect(findCrossStreets(data, { name: "First Street" }).crossings).toEqual([]);
});
