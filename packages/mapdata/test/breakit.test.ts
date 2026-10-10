// "Break it on purpose": a crash pinned in the open Gulf of Maine (about 42.5, -69.5), where
// Overpass has no road to give us. Fixtures only; nothing here calls an API.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { LocalFrame, RoadNetwork } from "@csd/core";
import { OSM_ATTRIBUTION, findCrossings, overpassBboxQuery, parseOverpass, terrainTilesFor } from "../src";

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const OCEAN: LocalFrame = { origin: { lat: 42.5, lon: -69.5 } };
const FETCHED = "2026-10-09T12:00:00Z";
const parse = (json: unknown, radiusM = 250): RoadNetwork => parseOverpass(json, OCEAN, radiusM, FETCHED);

function expectEmptyNetwork(net: RoadNetwork, radiusM = 250) {
  expect(net.ways).toEqual([]);
  expect(net.buildings).toEqual([]);
  expect(net.parking).toEqual([]);
  expect(net.terrain).toBeNull();
  expect(net.frame).toEqual(OCEAN);
  expect(net.radiusM).toBe(radiusM);
  expect(net.fetchedAt).toBe(FETCHED);
  // The data we do have still carries its attribution.
  expect(net.attribution).toEqual([OSM_ATTRIBUTION]);
}

describe("4. a crash in the ocean (mapdata)", () => {
  it("an Overpass answer with no elements parses to a network with no drivable ways", () => {
    const net = parse(fixture("gulf-of-maine-empty"));
    expectEmptyNetwork(net);
  });

  it("a coastline, a car ferry, a pier, a boardwalk, a platform, a ferry relation and a terminal still give no drivable way", () => {
    const json = fixture("gulf-of-maine-coast-ferry") as { elements: unknown[] };
    expect(json.elements.length).toBeGreaterThanOrEqual(6); // the fixture really has things in it
    expectEmptyNetwork(parse(json));
  });

  it("each of those elements on its own is ignored too (nothing is mistaken for a road)", () => {
    const json = fixture("gulf-of-maine-coast-ferry") as { elements: unknown[] };
    for (const element of json.elements) expectEmptyNetwork(parse({ elements: [element] }));
  });

  it("with a real road in the same answer, only the road is kept", () => {
    const json = fixture("gulf-of-maine-coast-ferry") as { elements: unknown[] };
    const road = {
      type: "way", id: 900000099, nodes: [1, 2],
      geometry: [{ lat: 42.4995, lon: -69.5 }, { lat: 42.5005, lon: -69.5 }],
      tags: { highway: "residential", name: "Synthetic Landing Road" },
    };
    const net = parse({ elements: [...json.elements, road] });
    expect(net.ways.map((w) => w.name)).toEqual(["Synthetic Landing Road"]);
    expect(net.ways).toHaveLength(1);
  });

  it("is deterministic, and the result is plain JSON-safe data", () => {
    const json = fixture("gulf-of-maine-coast-ferry");
    expect(JSON.stringify(parse(json))).toBe(JSON.stringify(parse(json)));
    expect(JSON.parse(JSON.stringify(parse(json)))).toEqual(parse(json));
  });

  it("works at every radius the proxy allows", () => {
    for (const r of [50, 250, 400]) expectEmptyNetwork(parse(fixture("gulf-of-maine-coast-ferry"), r), r);
  });

  it("finds no 'X and Y' crossing in the ocean (empty list, no throw)", () => {
    for (const name of ["gulf-of-maine-empty", "gulf-of-maine-coast-ferry"]) {
      expect(findCrossings(fixture(name), "Main Street", "Park Street", OCEAN.origin)).toEqual([]);
    }
  });

  it("builds the terrain tile list for open water without trouble", () => {
    const tiles = terrainTilesFor(OCEAN, 250);
    expect(tiles.length).toBeGreaterThan(0);
    expect(tiles.length).toBeLessThanOrEqual(4);
  });
});

describe("answers that are not Overpass answers (mapdata)", () => {
  const NOT_OVERPASS = "Not an Overpass response (no elements array).";

  it("garbage in the place of the answer throws one plain sentence, never a stack-shaped message", () => {
    for (const bad of [undefined, null, 0, "", "<html>Too busy</html>", [], true, {}, { elements: null }, { elements: {} }, { elements: "x" }]) {
      let message = "";
      try { parse(bad); } catch (e) { message = e instanceof Error ? e.message : "not an Error"; }
      expect(message, JSON.stringify(bad)).toBe(NOT_OVERPASS);
    }
  });

  it("junk inside a valid answer is skipped, not fatal", () => {
    const junk = [
      null, 7, "way", [], {}, { type: "way" }, { type: "way", id: "1", geometry: [] }, { type: "way", id: 1, geometry: "x" },
      { type: "way", id: 2, geometry: [null, 5, { lat: "42", lon: -69 }, { lat: NaN, lon: 1 }], tags: { highway: "residential" } },
      { type: "way", id: 3, geometry: [{ lat: 42.5, lon: -69.5 }], tags: { highway: "residential" } },
      { type: "way", id: 4, geometry: [{ lat: 42.5, lon: -69.5 }, { lat: 42.5, lon: -69.4999 }], tags: null },
      { type: "way", id: 5, geometry: [{ lat: 42.5, lon: -69.5 }, { lat: 42.5, lon: -69.4999 }], tags: { highway: { toString: "<script>" }, name: ["x"], building: 5 } },
    ];
    const net = parse({ elements: junk });
    expect(net.ways).toEqual([]);
  });

  it("hostile street names stay plain text in the network", () => {
    const name = '<script>alert(1)</script> "><img src=x onerror=alert(1)>';
    const net = parse({
      elements: [{ type: "way", id: 7, nodes: [1, 2], geometry: [{ lat: 42.4995, lon: -69.5 }, { lat: 42.5005, lon: -69.5 }], tags: { highway: "residential", name } }],
    });
    expect(net.ways[0]!.name).toBe(name);
  });
});

describe("parseOverpass refuses an unusable pin or radius with a plain sentence", () => {
  const json = () => fixture("gulf-of-maine-coast-ferry");
  const messageOf = (f: () => unknown): string => {
    try { f(); } catch (e) { return e instanceof Error ? e.message : "not an Error"; }
    return "did not throw";
  };

  it("a pin that is not a finite position on Earth", () => {
    for (const origin of [
      { lat: Number.NaN, lon: -69.5 }, { lat: 42.5, lon: Number.NaN }, { lat: Infinity, lon: 0 }, { lat: 0, lon: -Infinity },
      { lat: 91, lon: 0 }, { lat: -91, lon: 0 }, { lat: 0, lon: 181 }, { lat: 0, lon: -181 },
      { lat: "42.5", lon: -69.5 }, { lat: undefined, lon: -69.5 }, { lat: null, lon: -69.5 },
    ]) {
      const message = messageOf(() => parseOverpass(json(), { origin } as unknown as LocalFrame, 250, FETCHED));
      expect(message, JSON.stringify(origin)).toBe("The map area has no usable pin position.");
      expect(message).not.toMatch(/NaN|undefined|null|Infinity/);
    }
  });

  it("a radius that is not a positive finite number of metres", () => {
    for (const radius of [Number.NaN, Infinity, -Infinity, 0, -5, "250", undefined, null]) {
      const message = messageOf(() => parseOverpass(json(), OCEAN, radius as unknown as number, FETCHED));
      expect(message, String(radius)).toBe("The map area has no usable size.");
    }
  });

  it("the edges of the planet are still fine", () => {
    for (const [lat, lon] of [[90, 180], [-90, -180], [0, 0]] as const) {
      expect(parseOverpass({ elements: [] }, { origin: { lat, lon } }, 250, FETCHED).ways).toEqual([]);
    }
  });

  it("bad area is reported before the answer is read, and a good area with a bad answer still says so", () => {
    expect(messageOf(() => parseOverpass("not json", { origin: { lat: Number.NaN, lon: 0 } }, 250, FETCHED))).toBe("The map area has no usable pin position.");
    expect(messageOf(() => parseOverpass("not json", OCEAN, 250, FETCHED))).toBe("Not an Overpass response (no elements array).");
  });
});

describe("bad coordinates (mapdata)", () => {
  it("building an Overpass query from a coordinate that isn't a number refuses with a sentence", () => {
    for (const lat of [Number.NaN, Infinity, -Infinity]) {
      expect(() => overpassBboxQuery({ lat, lon: -69.5 }, 250)).toThrow("coordinate must be a finite number");
      expect(() => overpassBboxQuery({ lat: 42.5, lon: lat }, 250)).toThrow("coordinate must be a finite number");
    }
    for (const r of [0, -5, Number.NaN, Infinity]) expect(() => overpassBboxQuery({ lat: 42.5, lon: -69.5 }, r)).toThrow("radius must be a positive number of metres");
  });

  it("the terrain tile list for a pin that isn't on Earth is empty instead of a crash", () => {
    for (const origin of [{ lat: Number.NaN, lon: 0 }, { lat: 0, lon: Number.NaN }, { lat: 91, lon: 0 }, { lat: -91, lon: 0 }]) {
      expect(terrainTilesFor({ origin }, 250), JSON.stringify(origin)).toEqual([]);
    }
  });
});
