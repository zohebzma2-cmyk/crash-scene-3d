import { describe, expect, it } from "vitest";
import { streetsAtPin } from "../src";
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
