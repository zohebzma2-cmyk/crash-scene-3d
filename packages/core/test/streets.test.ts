import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { directionCaption, streetsAtPin, toLocal, type RoadNetwork, type RoadWay, type Scene } from "../src";
import { angleDiffDeg } from "./physics-helpers";
import { highwayNet, intersectionNet, parkingLotNet } from "./roads-fixtures";

const labels = (r: ReturnType<typeof streetsAtPin>) => r.directions.map((d) => d.label).sort();

describe("streetsAtPin: roads within 25 m", () => {
  it("lists the roads near the pin with their distance, and leaves out far ones", () => {
    const r = streetsAtPin(intersectionNet(), { x: 5, y: 8 });
    expect(r.pin).toEqual({ x: 5, y: 8 });
    const byId = new Map(r.roads.map((x) => [x.roadId, x]));
    expect([...byId.keys()].sort()).toEqual(["main", "park"]); // Hill Road is 55 m away
    expect(byId.get("main")!.distanceM).toBeCloseTo(5, 6);
    expect(byId.get("main")!.name).toBe("Main Street");
    expect(byId.get("park")!.distanceM).toBeCloseTo(8, 6);
  });

  it("draws the line at 25 m", () => {
    const net = intersectionNet();
    const inside = streetsAtPin(net, { x: 24, y: 100 }); // Main is 24 m west of the pin
    expect(inside.roads.map((x) => x.roadId)).toContain("main");
    const outside = streetsAtPin(net, { x: 26, y: 100 });
    expect(outside.roads.map((x) => x.roadId)).not.toContain("main");
  });

  it("returns nothing when no road is near", () => {
    const r = streetsAtPin(intersectionNet(), { x: -100, y: 100 });
    expect(r.roads).toEqual([]);
    expect(r.directions).toEqual([]);
  });
});

describe("streetsAtPin: legs split at the junction", () => {
  it("gives four legs at a 4-way, with outward bearings and the junction point", () => {
    const r = streetsAtPin(intersectionNet(), { x: 5, y: 8 });
    expect(r.legs).toHaveLength(4);
    const want = [
      { roadId: "main", name: "Main Street", bearing: 0 }, { roadId: "main", name: "Main Street", bearing: 180 },
      { roadId: "park", name: "Park Street", bearing: 90 }, { roadId: "park", name: "Park Street", bearing: 270 },
    ];
    for (const w of want) {
      const leg = r.legs.find((l) => l.roadId === w.roadId && angleDiffDeg(l.outwardBearingDeg, w.bearing) < 1);
      expect(leg, `leg ${w.name} ${w.bearing}`).toBeDefined();
      expect(leg!.name).toBe(w.name);
      expect(Math.hypot(leg!.junction.x, leg!.junction.y)).toBeLessThan(0.5);
    }
  });

  it("still finds the junction when the pin is 24 m up the street", () => {
    const r = streetsAtPin(intersectionNet(), { x: 1, y: 24 });
    expect(r.legs).toHaveLength(4);
  });

  it("finds the same four legs when Main Street is stored as two ways with the same name", () => {
    const r = streetsAtPin(intersectionNet({ splitMain: true }), { x: 5, y: 8 });
    expect(r.legs).toHaveLength(4);
    expect(r.legs.filter((l) => l.name === "Main Street").map((l) => Math.round(l.outwardBearingDeg) % 360).sort((a, b) => a - b)).toEqual([0, 180]);
  });
});

describe("streetsAtPin: direction choices", () => {
  it("offers a bound on each road, labelled like 'northbound on Main Street'", () => {
    const r = streetsAtPin(intersectionNet(), { x: 5, y: 8 });
    expect(labels(r)).toEqual(["eastbound on Park Street", "northbound on Main Street", "southbound on Main Street", "westbound on Park Street"]);
    const north = r.directions.find((d) => d.label === "northbound on Main Street")!;
    expect(north.roadId).toBe("main");
    expect(north.roadName).toBe("Main Street");
    expect(north.bound).toBe("northbound");
    expect(angleDiffDeg(north.bearingDeg, 0)).toBeLessThan(1);
    const west = r.directions.find((d) => d.label === "westbound on Park Street")!;
    expect(west.bound).toBe("westbound");
    expect(angleDiffDeg(west.bearingDeg, 270)).toBeLessThan(1);
  });

  it("offers only the legal bound on a one-way street", () => {
    const r = streetsAtPin(intersectionNet({ parkOneWay: true }), { x: 5, y: 8 });
    expect(labels(r)).toEqual(["northbound on Main Street", "southbound on Main Street", "westbound on Park Street"]);
    expect(r.directions.some((d) => /eastbound/.test(d.label) && /Park/.test(d.label))).toBe(false);
  });

  it("offers no 'southbound' on a one-way northbound highway", () => {
    const r = streetsAtPin(highwayNet(), { x: 0, y: 0 }); // the highway is 10 m west of this pin
    expect(labels(r)).toEqual(["northbound on Everett Turnpike"]);
    expect(r.directions.some((d) => /southbound/.test(d.label))).toBe(false);
  });

  it("lists each named road once even when it is stored as several segments", () => {
    const r = streetsAtPin(intersectionNet({ splitMain: true }), { x: 5, y: 8 });
    expect(r.roads.filter((x) => x.name === "Main Street")).toHaveLength(1);
    const ls = labels(r);
    expect(new Set(ls).size).toBe(ls.length);
    expect(ls.filter((l) => l === "northbound on Main Street")).toHaveLength(1);
    expect(ls.filter((l) => l === "southbound on Main Street")).toHaveLength(1);
    expect(ls).toHaveLength(4);
  });

  it("offers bounds for an unnamed parking aisle without a street name", () => {
    const r = streetsAtPin(parkingLotNet(), { x: 10, y: -1 });
    expect(r.roads.map((x) => x.roadId)).toEqual(["aisle"]);
    expect(r.directions.map((d) => d.bound).sort()).toEqual(["eastbound", "westbound"]);
    for (const d of r.directions) {
      expect(d.roadName).toBeNull();
      expect(d.label).not.toMatch(/null|undefined/);
    }
  });
});

describe("streetsAtPin: unnamed roads are told apart (vehicles step fixes, 2026-10-11)", () => {
  const net = JSON.parse(readFileSync(new URL("./data/parking-lot-backing-roads.json", import.meta.url), "utf8")) as RoadNetwork;
  const scene = JSON.parse(readFileSync(new URL("../../../examples/parking-lot-backing/scene.json", import.meta.url), "utf8")) as Scene;

  it("the parking example's six choices on three parallel aisles all read differently, from west to east", () => {
    const r = streetsAtPin(net, toLocal(net.frame, scene.location));
    expect(r.directions).toHaveLength(6);
    expect(new Set(r.directions.map((d) => d.label)).size).toBe(6);
    expect(labels(r)).toEqual([
      "northbound on the parking aisle (east one)", "northbound on the parking aisle (middle)", "northbound on the parking aisle (west one)",
      "southbound on the parking aisle (east one)", "southbound on the parking aisle (middle)", "southbound on the parking aisle (west one)",
    ]);
    // The aisle the pin is on is the middle one; never a made-up name.
    const onPin = r.directions.find((d) => d.roadId === r.roads[0]!.roadId)!;
    expect(onPin.roadDesc).toBe("the parking aisle (middle)");
    for (const d of r.directions) expect(d.roadName).toBeNull();
  });

  it("one unnamed road of its kind is just its kind; a named road keeps its name and no description", () => {
    const r = streetsAtPin(parkingLotNet(), { x: 10, y: -1 });
    expect(labels(r)).toEqual(["eastbound on the parking aisle", "westbound on the parking aisle"]);
    const named = streetsAtPin(intersectionNet(), { x: 5, y: 8 });
    for (const d of named.directions) { expect(d.roadDesc).toBeNull(); expect(d.label).toMatch(/ on (Main|Park) Street$/); }
  });

  it("two pieces of one unnamed aisle are one road; four side by side are told apart by how near the pin they are", () => {
    const aisle = (id: string, x: number, y0: number, y1: number): RoadWay => ({
      id, name: null, ref: null, kind: "parking_aisle", oneway: false, lanesForward: 1, lanesBackward: 1, laneWidthM: 3,
      centerline: [{ x, y: y0 }, { x, y: y1 }], speedLimitMph: null, osmWayIds: [],
    });
    const base = parkingLotNet();
    const split = streetsAtPin({ ...base, ways: [aisle("a1", 0, -30, 0), aisle("a2", 0, 0, 30), aisle("b", 12, -30, 30)] }, { x: 1, y: 0 });
    expect(labels(split)).toEqual([
      "northbound on the parking aisle (east one)", "northbound on the parking aisle (west one)",
      "southbound on the parking aisle (east one)", "southbound on the parking aisle (west one)",
    ]);
    const four = streetsAtPin({ ...base, ways: [aisle("w", -14, -30, 30), aisle("p", 0, -30, 30), aisle("e", 9, -30, 30), aisle("f", 20, -30, 30)] }, { x: 1, y: 0 });
    expect(new Set(four.directions.map((d) => d.label)).size).toBe(8);
    expect(four.directions.find((d) => d.roadId === "p")!.roadDesc).toBe("the parking aisle (nearest the pin)");
    expect(four.directions.find((d) => d.roadId === "e")!.roadDesc).toBe("the parking aisle (second nearest the pin)");
  });

  it("one diagonal unnamed road stored as two pieces split near the pin is one road, wherever the pin is", () => {
    const at = (s: number) => ({ x: s * Math.sin(Math.PI / 9), y: s * Math.cos(Math.PI / 9) });   // 20° east of north
    const piece = (id: string, s0: number, s1: number): RoadWay => ({
      id, name: null, ref: null, kind: "service", oneway: false, lanesForward: 1, lanesBackward: 1, laneWidthM: 3,
      centerline: [at(s0), at(s1)], speedLimitMph: null, osmWayIds: [],
    });
    const net = { ...parkingLotNet(), ways: [piece("s1", -100, 15), piece("s2", 15, 100)] };
    for (const pin of [{ x: 3, y: 0 }, { x: 0, y: 0 }, { x: -2, y: 10 }]) {
      expect(labels(streetsAtPin(net, pin))).toEqual(["northbound on the unnamed service road", "southbound on the unnamed service road"]);
    }
  });

  it("a Y-fork of unnamed service roads at the pin (straight north, and 30° east of north) is two roads, all four choices offered", () => {
    const road = (id: string, deg: number): RoadWay => {
      const r = (deg * Math.PI) / 180;
      return {
        id, name: null, ref: null, kind: "service", oneway: false, lanesForward: 1, lanesBackward: 1, laneWidthM: 3,
        centerline: [{ x: 0, y: 0 }, { x: 80 * Math.sin(r), y: 80 * Math.cos(r) }].map((p, i) => (i === 0 ? { x: -40 * Math.sin(r), y: -40 * Math.cos(r) } : p)), speedLimitMph: null, osmWayIds: [],
      };
    };
    const r = streetsAtPin({ ...parkingLotNet(), ways: [road("straight", 0), road("fork", 30)] }, { x: 0, y: 1 });
    expect(r.directions).toHaveLength(4);
    expect(new Set(r.directions.map((d) => d.label)).size).toBe(4);
    expect(new Set(r.directions.map((d) => d.roadId))).toEqual(new Set(["straight", "fork"]));
    expect(r.directions.find((d) => d.roadId === "fork")!.roadDesc).toBe("the unnamed service road (east one)");
    expect(r.directions.find((d) => d.roadId === "straight")!.roadDesc).toBe("the unnamed service road (west one)");
  });

  it("the caption, the summary and the PDF say the same words (directionCaption is the one formatter)", () => {
    const travel = { bearingDeg: 37, roadId: "w1", roadName: null, roadDesc: "the parking aisle (west one)", lane: null };
    expect(directionCaption({ action: "straight", travel })).toBe("Northbound on the parking aisle (west one)");
    expect(directionCaption({ action: "parked", travel })).toBe("Parked, facing north on the parking aisle (west one)");
    // A name always wins over a description; neither: just the bound.
    expect(directionCaption({ action: "straight", travel: { ...travel, roadName: "Main Street" } })).toBe("Northbound on Main Street");
    expect(directionCaption({ action: "straight", travel: { ...travel, roadDesc: undefined } })).toBe("Northbound");
  });
});
