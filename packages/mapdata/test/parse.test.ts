import { describe, expect, it } from "vitest";
import { clipPolyline, overpassAroundQuery, overpassBboxLiveQuery, overpassBboxQuery, overpassBboxRoadsQuery, parseOverpass } from "../src";
import { loadExample } from "./helpers";

const FRAME = { origin: { lat: 42.7, lon: -71.4 } };
const M_PER_DEG_LAT = 111_000;

/** A way at (dx, dy) metres from the origin, as Overpass `out body geom` writes it. */
function way(id: number, tags: Record<string, string>, pts: [number, number][], nodes?: number[]) {
  return {
    type: "way", id, tags, nodes: nodes ?? pts.map((_, i) => id * 100 + i),
    geometry: pts.map(([x, y]) => ({ lat: 42.7 + y / M_PER_DEG_LAT, lon: -71.4 + x / (M_PER_DEG_LAT * Math.cos((42.7 * Math.PI) / 180)) })),
  };
}
const wrap = (...elements: unknown[]) => ({ elements });

describe("overpassAroundQuery", () => {
  for (const name of ["t-bone-intersection", "highway-rear-end", "parking-lot-backing"]) {
    it(`reproduces the query cached in examples/${name}`, () => {
      const { json } = loadExample(name);
      // Captured by scripts/fetch-fixtures.mjs (around query) or through the proxy's /api/geo/overpass (bbox query).
      expect([overpassAroundQuery(json.center, json.radiusM), overpassBboxQuery(json.center, json.radiusM)]).toContain(json.query);
    });
  }
  it("bbox query covers the whole square of half-size radiusM, not a circle", () => {
    const q = overpassBboxQuery({ lat: 42.7627323, lon: -71.4661324 }, 250);
    const m = /way\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\)\["highway"/.exec(q)!;
    const [s, w, n, e] = m.slice(1).map(Number) as [number, number, number, number];
    expect(n - s).toBeCloseTo(500 / 111_000, 4);
    expect(e - w).toBeCloseTo(500 / (111_412.84 * Math.cos((42.7627323 * Math.PI) / 180)), 4);
    expect((n + s) / 2).toBeCloseTo(42.7627323, 6);
    expect((e + w) / 2).toBeCloseTo(-71.4661324, 6);
    expect(q).not.toContain("around");
    expect(q.match(/way\(/g)).toHaveLength(4);
    expect(q).toContain('["footway"="crossing"]');
    expect(q).toContain("traffic_signals|stop|give_way|crossing|street_lamp");
    expect(q).toMatch(/^\[out:json\]\[timeout:60\];\(/);
    expect(q).toMatch(/out body geom;$/);
  });
  it("rounds noisy coordinates to 7 decimals", () => {
    expect(overpassAroundQuery({ lat: 42.762732312345, lon: -71.46613241234 }, 250.4)).toContain("around:250,42.7627323,-71.4661324");
  });
});

describe("live-route queries (short timeout, roads-first fallback)", () => {
  const center = { lat: 42.7627323, lon: -71.4661324 };
  it("the primary live query is the bbox query with the short 25 s timeout and buildings", () => {
    const live = overpassBboxLiveQuery(center, 250);
    expect(live).toMatch(/^\[out:json\]\[timeout:25\];\(/);
    expect(live).toContain('["building"]');
    expect(live).toContain('["amenity"="parking"]');
    expect(live).toContain("traffic_signals|stop|give_way|crossing|street_lamp");
    // The same square as the examples' query, only a shorter server timeout (so the examples' cached query is unchanged).
    expect(live).toBe(overpassBboxQuery(center, 250).replace("[timeout:60]", "[timeout:25]"));
  });
  it("the roads-only fallback drops buildings but keeps roads, parking and controls", () => {
    const roads = overpassBboxRoadsQuery(center, 250);
    expect(roads).toMatch(/^\[out:json\]\[timeout:25\];\(/);
    expect(roads).not.toContain('["building"]');
    expect(roads).toContain('["highway"~');
    expect(roads).toContain('["amenity"="parking"]');
    expect(roads).toContain('["footway"="crossing"]');
  });
});

describe("parseOverpass: tags", () => {
  it("reads lanes, oneway, width, speed, name and ref", () => {
    const net = parseOverpass(wrap(
      way(1, { highway: "secondary", name: "Main Street", ref: "NH 101A", lanes: "5", "lanes:forward": "3", "lanes:backward": "2", maxspeed: "25 mph", width: "17.5" }, [[-50, 0], [50, 0]]),
      way(2, { highway: "residential", name: "One Way St", oneway: "yes", lanes: "2", maxspeed: "50" }, [[0, -50], [0, 50]]),
      way(3, { highway: "residential", name: "Plain Rd" }, [[100, 0], [150, 0]]),
    ), FRAME, 250, "2026-10-09T00:00:00Z");
    const main = net.ways.find((w) => w.name === "Main Street")!;
    expect(main).toMatchObject({ kind: "secondary", ref: "NH 101A", oneway: false, lanesForward: 3, lanesBackward: 2, speedLimitMph: 25, osmWayIds: [1] });
    expect(main.laneWidthM).toBeCloseTo(3.5, 5); // 17.5 / 5
    const one = net.ways.find((w) => w.name === "One Way St")!;
    expect(one).toMatchObject({ oneway: true, lanesForward: 2, lanesBackward: 0, speedLimitMph: 31 }); // 50 km/h
    const plain = net.ways.find((w) => w.name === "Plain Rd")!;
    expect(plain).toMatchObject({ lanesForward: 1, lanesBackward: 1, laneWidthM: 3.5, speedLimitMph: null, ref: null });
    expect(net.attribution).toEqual(["© OpenStreetMap contributors (ODbL)"]);
    expect(net.fetchedAt).toBe("2026-10-09T00:00:00Z");
  });

  it("splits a lone lanes total and honours lanes:forward only", () => {
    const net = parseOverpass(wrap(
      way(1, { highway: "tertiary", name: "A St", lanes: "3" }, [[0, 0], [10, 0]]),
      way(2, { highway: "tertiary", name: "B St", lanes: "4", "lanes:forward": "3" }, [[0, 10], [10, 10]]),
      way(3, { highway: "tertiary", name: "C St", lanes: "1" }, [[0, 20], [10, 20]]),
    ), FRAME, 250, "t");
    const by = (n: string) => net.ways.find((w) => w.name === n)!;
    expect([by("A St").lanesForward, by("A St").lanesBackward]).toEqual([2, 1]);
    expect([by("B St").lanesForward, by("B St").lanesBackward]).toEqual([3, 1]);
    expect([by("C St").lanesForward, by("C St").lanesBackward]).toEqual([1, 1]);
  });

  it("reverses oneway=-1 so the centerline runs with traffic", () => {
    const net = parseOverpass(wrap(way(1, { highway: "residential", name: "Back St", oneway: "-1" }, [[0, 0], [100, 0]])), FRAME, 250, "t");
    const w = net.ways[0]!;
    expect(w.oneway).toBe(true);
    expect(w.centerline[0]!.x).toBeGreaterThan(w.centerline[1]!.x); // now runs east → west
    expect(w.lanesForward).toBe(1);
  });

  it("treats motorways as one-way unless tagged otherwise", () => {
    const net = parseOverpass(wrap(way(1, { highway: "motorway", ref: "US 3" }, [[0, 0], [100, 0]])), FRAME, 250, "t");
    expect(net.ways[0]).toMatchObject({ oneway: true, kind: "motorway", lanesBackward: 0 });
  });

  it("maps kinds: links fold into their class, parking aisles are their own kind, footpaths are dropped", () => {
    const net = parseOverpass(wrap(
      way(1, { highway: "primary_link" }, [[0, 0], [10, 0]]),
      way(2, { highway: "service", service: "parking_aisle" }, [[0, 5], [10, 5]]),
      way(3, { highway: "footway", name: "Walk" }, [[0, 9], [10, 9]]),
    ), FRAME, 250, "t");
    expect(net.ways.map((w) => w.kind).sort()).toEqual(["parking_aisle", "primary"]);
  });

  it("derives building height from height, levels, then the 6 m default; footprints are CCW open rings", () => {
    const sq = (x: number, ccw: boolean): [number, number][] => {
      const p: [number, number][] = [[x, 0], [x + 10, 0], [x + 10, 10], [x, 10]];
      if (!ccw) p.reverse();
      return [...p, p[0]!];
    };
    const net = parseOverpass(wrap(
      way(1, { building: "yes", height: "12 m" }, sq(0, true)),
      way(2, { building: "yes", "building:levels": "4" }, sq(20, false)),
      way(3, { building: "yes" }, sq(40, true)),
      way(4, { building: "yes", height: "40 ft" }, sq(60, true)),
    ), FRAME, 250, "t");
    const b = (id: string) => net.buildings.find((x) => x.id === id)!;
    expect(b("b1")).toMatchObject({ heightM: 12, heightSource: "height-tag" });
    expect(b("b2")).toMatchObject({ heightM: 12, heightSource: "levels-tag" });
    expect(b("b3")).toMatchObject({ heightM: 6, heightSource: "default" });
    expect(b("b4").heightM).toBeCloseTo(12.192, 3);
    for (const x of net.buildings) {
      expect(x.footprint).toHaveLength(4);
      let area = 0;
      x.footprint.forEach((p, i) => { const q = x.footprint[(i + 1) % 4]!; area += p.x * q.y - q.x * p.y; });
      expect(area / 2).toBeGreaterThan(0);
    }
  });

  it("collects parking areas and rejects non-JSON", () => {
    const ring: [number, number][] = [[0, 0], [30, 0], [30, 30], [0, 30], [0, 0]];
    const net = parseOverpass(wrap(way(9, { amenity: "parking" }, ring)), FRAME, 250, "t");
    expect(net.parking).toHaveLength(1);
    expect(net.parking[0]!.outline).toHaveLength(4);
    expect(() => parseOverpass("<html>busy</html>", FRAME, 250, "t")).toThrow(/Overpass/);
  });
});

describe("parseOverpass: merging", () => {
  it("joins consecutive same-name ways that share an end node, in either digitising direction", () => {
    const net = parseOverpass(wrap(
      way(1, { highway: "secondary", name: "Main Street", lanes: "2" }, [[-100, 0], [0, 0]], [10, 11]),
      way(2, { highway: "secondary", name: "Main Street", lanes: "2" }, [[100, 0], [0, 0]], [12, 11]), // digitised the other way
      way(3, { highway: "secondary", name: "Main Street", lanes: "2" }, [[100, 0], [200, 0]], [12, 13]),
    ), FRAME, 250, "t");
    expect(net.ways).toHaveLength(1);
    expect(net.ways[0]!.osmWayIds.slice().sort()).toEqual([1, 2, 3]);
    expect(net.ways[0]!.centerline.length).toBeGreaterThanOrEqual(4);
  });

  it("joins a street's pieces even when only some carry the route ref, but not two different refs", () => {
    const net = parseOverpass(wrap(
      way(1, { highway: "secondary", name: "Main Street" }, [[-50, 0], [0, 0]], [1, 2]),
      way(2, { highway: "secondary", name: "Main Street", ref: "NH 101A" }, [[0, 0], [50, 0]], [2, 3]),
      way(3, { highway: "secondary", name: "Main Street", ref: "US 3" }, [[50, 0], [100, 0]], [3, 4]),
    ), FRAME, 250, "t");
    expect(net.ways).toHaveLength(2);
    expect(net.ways.map((w) => w.ref).sort()).toEqual(["NH 101A", "US 3"]);
  });

  it("does not merge ways whose lanes, width or speed differ", () => {
    const net = parseOverpass(wrap(
      way(1, { highway: "secondary", name: "A St", lanes: "2", maxspeed: "25 mph" }, [[-50, 0], [0, 0]], [1, 2]),
      way(2, { highway: "secondary", name: "A St", lanes: "4", maxspeed: "25 mph" }, [[0, 0], [50, 0]], [2, 3]),
      way(3, { highway: "secondary", name: "B St", lanes: "2", maxspeed: "25 mph" }, [[0, 20], [50, 20]], [4, 5]),
      way(4, { highway: "secondary", name: "B St", lanes: "2", maxspeed: "35 mph" }, [[50, 20], [100, 20]], [5, 6]),
      way(5, { highway: "secondary", name: "C St", lanes: "2", width: "7" }, [[0, 40], [50, 40]], [7, 8]),
      way(6, { highway: "secondary", name: "C St", lanes: "2", width: "8" }, [[50, 40], [100, 40]], [8, 9]),
      way(7, { highway: "secondary", name: "D St", lanes: "2" }, [[0, 60], [50, 60]], [10, 11]),
      way(8, { highway: "secondary", name: "D St", lanes: "2" }, [[50, 60], [100, 60]], [11, 12]),
    ), FRAME, 250, "t");
    expect(net.ways.filter((w) => w.name === "A St")).toHaveLength(2);
    expect(net.ways.filter((w) => w.name === "B St")).toHaveLength(2);
    expect(net.ways.filter((w) => w.name === "C St")).toHaveLength(2);
    expect(net.ways.filter((w) => w.name === "D St")).toHaveLength(1);
  });

  it("does not carry a ref past a node where another street takes that ref", () => {
    const net = parseOverpass(wrap(
      way(1, { highway: "secondary", name: "Main Street", ref: "NH 1" }, [[-100, 0], [0, 0]], [1, 2]),
      way(2, { highway: "secondary", name: "Main Street" }, [[0, 0], [100, 0]], [2, 3]),
      way(3, { highway: "secondary", name: "Canal Street", ref: "NH 1" }, [[0, 0], [0, -100]], [2, 4]),
    ), FRAME, 250, "t");
    const mains = net.ways.filter((w) => w.name === "Main Street");
    expect(mains).toHaveLength(2);
    expect(mains.map((w) => w.ref).sort()).toEqual(["NH 1", null]);
    // Without the competing street the ref-less piece is the continuation.
    const alone = parseOverpass(wrap(
      way(1, { highway: "secondary", name: "Main Street", ref: "NH 1" }, [[-100, 0], [0, 0]], [1, 2]),
      way(2, { highway: "secondary", name: "Main Street" }, [[0, 0], [100, 0]], [2, 3]),
    ), FRAME, 250, "t");
    expect(alone.ways).toHaveLength(1);
    expect(alone.ways[0]!.ref).toBe("NH 1");
  });

  it("keeps different names and forks of the same street apart", () => {
    const net = parseOverpass(wrap(
      way(1, { highway: "secondary", name: "Main Street" }, [[-50, 0], [0, 0]], [1, 2]),
      way(3, { highway: "secondary", name: "Elm Street" }, [[0, 0], [0, 50]], [2, 4]),
      way(4, { highway: "service" }, [[0, 0], [0, -50]], [2, 5]),
      way(5, { highway: "service" }, [[0, -50], [0, -90]], [5, 6]), // unnamed: never joined
    ), FRAME, 250, "t");
    expect(net.ways).toHaveLength(4);
  });

  it("joins one-way ways only head to tail, so divided roads stay two", () => {
    const net = parseOverpass(wrap(
      way(1, { highway: "primary", name: "Turnpike", oneway: "yes" }, [[-100, 5], [0, 5]], [1, 2]),
      way(2, { highway: "primary", name: "Turnpike", oneway: "yes" }, [[0, 5], [100, 5]], [2, 3]),
      way(3, { highway: "primary", name: "Turnpike", oneway: "yes" }, [[100, -5], [0, -5]], [4, 5]),
      way(4, { highway: "primary", name: "Turnpike", oneway: "yes" }, [[0, -5], [-100, -5]], [5, 6]),
    ), FRAME, 250, "t");
    // The two carriageways run opposite ways, so they never join.
    const east = net.ways.find((w) => w.osmWayIds.includes(1))!;
    const west = net.ways.find((w) => w.osmWayIds.includes(3))!;
    expect(east).not.toBe(west);
    expect(east.osmWayIds).toEqual(expect.arrayContaining([1, 2]));
    expect(west.osmWayIds).toEqual(expect.arrayContaining([3, 4]));
  });

  it("never joins opposite one-way carriageways that share both end nodes (no closed loops)", () => {
    const net = parseOverpass(wrap(
      way(1, { highway: "residential", name: "Loop St", oneway: "yes" }, [[0, 0], [60, 20], [120, 0]], [1, 2, 3]),
      way(2, { highway: "residential", name: "Loop St", oneway: "yes" }, [[120, 0], [60, -20], [0, 0]], [3, 4, 1]),
    ), FRAME, 250, "t");
    expect(net.ways).toHaveLength(2);
  });

  it("refuses a join that turns back on itself (hairpin) but accepts a right-angle bend", () => {
    const hairpin = parseOverpass(wrap(
      way(1, { highway: "residential", name: "Hair St", oneway: "yes" }, [[0, 0], [100, 0]], [1, 2]),
      way(2, { highway: "residential", name: "Hair St", oneway: "yes" }, [[100, 0], [10, 5]], [2, 3]),
    ), FRAME, 250, "t");
    expect(hairpin.ways).toHaveLength(2);
    const bend = parseOverpass(wrap(
      way(1, { highway: "residential", name: "Bend St" }, [[0, 0], [100, 0]], [1, 2]),
      way(2, { highway: "residential", name: "Bend St" }, [[100, 0], [100, 100]], [2, 3]),
    ), FRAME, 250, "t");
    expect(bend.ways).toHaveLength(1);
  });

  it("counts a same-name way of any one-way value when testing for a fork", () => {
    const net = parseOverpass(wrap(
      way(1, { highway: "residential", name: "Fork St" }, [[0, 0], [100, 0]], [1, 2]),
      way(2, { highway: "residential", name: "Fork St" }, [[100, 0], [200, 0]], [2, 3]),
      way(3, { highway: "residential", name: "Fork St", oneway: "yes" }, [[100, 0], [100, 100]], [2, 4]),
    ), FRAME, 250, "t");
    expect(net.ways).toHaveLength(3);
  });

  it("clips centerlines to the square and splits a way that leaves and re-enters", () => {
    expect(clipPolyline([[-300, 0], [300, 0]].map(([x, y]) => ({ x: x!, y: y! })), 100)).toEqual([[{ x: -100, y: 0 }, { x: 100, y: 0 }]]);
    const pieces = clipPolyline([{ x: -50, y: 0 }, { x: 150, y: 0 }, { x: 150, y: 50 }, { x: -50, y: 50 }], 100);
    expect(pieces).toHaveLength(2);
  });
});

describe("parseOverpass: t-bone example (Main St & Park St, Nashua)", () => {
  const { json, frame } = loadExample("t-bone-intersection");
  const net = parseOverpass(json, frame, json.radiusM, json.fetchedAt);

  it("merges Main Street's split ways that agree on lanes and speed, keeping the OSM ids", () => {
    const mains = net.ways.filter((w) => w.name === "Main Street");
    const near = mains.find((w) => w.osmWayIds.includes(870231914))!;
    // 870231914 and 32285512 are both 5 lanes, 3 forward / 2 backward, 25 mph, and meet end to end.
    expect(near.osmWayIds).toEqual(expect.arrayContaining([870231914, 32285512]));
    expect([near.lanesForward, near.lanesBackward]).toEqual([3, 2]);
    expect(near.speedLimitMph).toBe(25);
    expect(near.oneway).toBe(false);
    expect(near.kind).toBe("secondary");
    expect(near.ref).toBeNull();
    // 947876105 is tagged 2 forward / 3 backward: a different road, not averaged into its neighbour.
    const odd = mains.find((w) => w.osmWayIds.includes(947876105))!;
    expect(odd).not.toBe(near);
    expect([odd.lanesForward, odd.lanesBackward]).toEqual([2, 3]);
    expect(mains.length).toBeGreaterThan(1);
    const osmMain = json.elements.filter((e) => (e as { tags?: { name?: string; highway?: string } }).tags?.name === "Main Street" && (e as { tags: { highway?: string } }).tags.highway).length;
    expect(mains.length).toBeLessThan(osmMain);
    // Each road is uniform: no merged road mixes lane splits.
    const raw = new Map(json.elements.map((e) => [(e as { id: number }).id, (e as { tags?: Record<string, string> }).tags ?? {}]));
    for (const w of mains) {
      const splits = new Set(w.osmWayIds.map((id) => `${raw.get(id)!["lanes:forward"] ?? ""}/${raw.get(id)!["lanes:backward"] ?? ""}/${raw.get(id)!.lanes ?? ""}`));
      expect(splits.size).toBe(1);
    }
  });

  it("does not carry NH 101A past Canal Street, where the route turns off Main Street", () => {
    const refMain = net.ways.find((w) => w.osmWayIds.includes(947876104))!;
    const refless = net.ways.find((w) => w.osmWayIds.includes(42674102))!;
    expect(refMain.ref).toBe("NH 101A");
    expect(refless.ref).toBeNull();
    expect(refMain).not.toBe(refless);
  });

  it("keeps Park Street one-way and gives every road at least two points inside the square", () => {
    const park = net.ways.find((w) => w.name === "Park Street")!;
    expect(park.oneway).toBe(true);
    expect(park.lanesBackward).toBe(0);
    for (const w of net.ways) {
      expect(w.centerline.length).toBeGreaterThanOrEqual(2);
      for (const p of w.centerline) {
        expect(Math.abs(p.x)).toBeLessThanOrEqual(net.radiusM + 1e-6);
        expect(Math.abs(p.y)).toBeLessThanOrEqual(net.radiusM + 1e-6);
      }
    }
  });

  it("has merged fewer roads than OSM ways, and buildings and parking", () => {
    const osmRoads = json.elements.filter((e) => (e as { tags?: { highway?: string } }).tags?.highway).length;
    expect(net.ways.length).toBeLessThan(osmRoads);
    expect(net.buildings.length).toBeGreaterThan(10);
    expect(net.parking.length).toBeGreaterThan(0);
    expect(net.ways.some((w) => w.kind === "parking_aisle")).toBe(true);
  });
});

describe("parseOverpass: Temple Street in the t-bone example", () => {
  it("keeps the opposite one-way pieces 77083040 and 5567784 apart, with no closed road", () => {
    const { json, frame } = loadExample("t-bone-intersection");
    const net = parseOverpass(json, frame, json.radiusM, json.fetchedAt);
    const a = net.ways.find((w) => w.osmWayIds.includes(77083040))!;
    const b = net.ways.find((w) => w.osmWayIds.includes(5567784))!;
    expect(a).not.toBe(b);
    for (const w of net.ways) {
      const first = w.centerline[0]!;
      const last = w.centerline.at(-1)!;
      if (w.oneway && w.centerline.length > 2) expect(Math.hypot(first.x - last.x, first.y - last.y)).toBeGreaterThan(1);
    }
  });
});

describe("parseOverpass: other examples", () => {
  it("highway example: divided turnpike carriageways are one-way with several lanes", () => {
    const { json, frame } = loadExample("highway-rear-end");
    const net = parseOverpass(json, frame, json.radiusM, json.fetchedAt);
    const pike = net.ways.filter((w) => w.kind === "motorway" || w.kind === "trunk");
    expect(pike.length).toBeGreaterThanOrEqual(2);
    expect(pike.every((w) => w.oneway && w.lanesBackward === 0)).toBe(true);
    expect(Math.max(...pike.map((w) => w.lanesForward))).toBeGreaterThanOrEqual(2);
  });

  it("parking example: finds aisles and a parking lot", () => {
    const { json, frame } = loadExample("parking-lot-backing");
    const net = parseOverpass(json, frame, json.radiusM, json.fetchedAt);
    expect(net.ways.some((w) => w.kind === "parking_aisle")).toBe(true);
    expect(net.parking.length).toBeGreaterThan(0);
  });
});
