// Bad or awkward map data: degenerate ways, hooked ways, loops.
import { describe, expect, it } from "vitest";
import { lanePath, placeVehicles, simulate, streetsAtPin } from "../src";
import type { RoadNetwork, RoadWay, Vec2 } from "../src";
import { expectOk, known, polylineLength, sceneOf, veh } from "./physics-helpers";
import { LANE_W_M, intersectionNet, makeWay } from "./roads-fixtures";

const pt = (x: number, y: number): Vec2 => ({ x, y });
const withWays = (net: RoadNetwork, extra: RoadWay[]): RoadNetwork => ({ ...net, ways: [...net.ways, ...extra] });

describe("ways with fewer than 2 distinct points", () => {
  const bad = [
    makeWay({ id: "dot", name: "Dot Street", centerline: [pt(3, 4), pt(3, 4)] }),
    makeWay({ id: "dot3", name: "Dot Three", centerline: [pt(2, 2), pt(2.004, 2), pt(2, 2.003)] }), // all within 1 cm of the first
    makeWay({ id: "one", name: "One Point", centerline: [pt(1, 1)] }),
  ];
  const net = withWays(intersectionNet(), bad);

  it("lanePath returns null instead of throwing", () => {
    for (const id of ["dot", "dot3", "one"]) expect(() => lanePath(net, id, 0, 0), id).not.toThrow();
    for (const id of ["dot", "dot3", "one"]) expect(lanePath(net, id, 0, 0), id).toBeNull();
  });

  it("streetsAtPin doesn't offer them as roads or directions, and the real streets still work", () => {
    const r = streetsAtPin(net, { x: 2, y: 3 });
    expect(r.roads.map((x) => x.roadId).sort()).toEqual(["main", "park"]);
    expect(r.directions.some((d) => /Dot|One/.test(d.label))).toBe(false);
    expect(r.directions).toHaveLength(4);
    expect(() => streetsAtPin(withWays(intersectionNet(), bad), { x: 3, y: 4 })).not.toThrow();
  });

  it("a vehicle that names one falls back to a free line and the scene still runs", () => {
    const scene = sceneOf([
      veh("A", { type: "car", bearingDeg: 0, roadId: "dot", roadName: "Dot Street", speed: known(25), zone: "left" }),
      veh("B", { type: "suv", bearingDeg: 90, roadId: "park", roadName: "Park Street", speed: known(20), zone: "front" }),
    ]);
    expect(() => placeVehicles(scene, net, pt(0, 0))).not.toThrow();
    expect(expectOk(placeVehicles(scene, net, pt(0, 0))).vehicles).toHaveLength(2);
    expect(expectOk(simulate(scene, net)).result.vehicles).toHaveLength(2);
  });

  it("consecutive duplicate points inside a good way are dropped (no NaN lane points)", () => {
    const dup = withWays(intersectionNet(), [makeWay({ id: "dup", name: "Dup Road", centerline: [pt(200, -50), pt(200, -50), pt(200, 0), pt(200.005, 0), pt(200, 50)] })]);
    const p = lanePath(dup, "dup", 0, 0)!;
    expect(p).not.toBeNull();
    for (const q of p.points) expect(Number.isFinite(q.x) && Number.isFinite(q.y)).toBe(true);
    for (const q of p.points) expect(q.x).toBeCloseTo(200 + LANE_W_M / 2, 1);
    expect(p.points).toHaveLength(3);
  });
});

describe("a way that hooks", () => {
  // Runs north for 100 m, then hooks east and back south for 200 m: end to end it points south-east, at the pin it points north.
  const hook = makeWay({ id: "hook", name: "Hook Road", centerline: [pt(0, 0), pt(0, 100), pt(50, 100), pt(50, -100)] });
  const net: RoadNetwork = { ...intersectionNet({ corners: false }), ways: [hook] };

  it("judges the direction at the pin, not from end to end", () => {
    const pin = pt(2, 50);
    const north = lanePath(net, "hook", 0, 0, pin)!;
    expect(north).not.toBeNull();
    // Travel with the point order: the first point is the start of the way, offset to the right (east).
    expect(north.points[0]!.x).toBeCloseTo(LANE_W_M / 2, 6);
    expect(north.points[0]!.y).toBeCloseTo(0, 6);
    // Southbound at the pin is against the point order: it starts at the far end of the way.
    const south = lanePath(net, "hook", 180, 0, pin)!;
    expect(south.points[0]!.y).toBeCloseTo(-100, 6);
  });

  it("without a point, the end-to-end direction is used", () => {
    const north = lanePath(net, "hook", 0, 0)!; // end to end the way points south-east: northbound is against it
    expect(north.points[0]!.y).toBeCloseTo(-100, 6);
  });
});

describe("a loop of one street", () => {
  const side = (id: string, a: Vec2, b: Vec2) => makeWay({ id, name: "Ring Road", lanesForward: 1, lanesBackward: 1, centerline: [a, b] });
  const ring: RoadNetwork = {
    ...intersectionNet({ corners: false }),
    ways: [
      side("R1", pt(0, 0), pt(100, 0)), side("R2", pt(100, 0), pt(100, 100)),
      side("R3", pt(100, 100), pt(0, 100)), side("R4", pt(0, 100), pt(0, 0)),
    ],
  };

  it("gives the way back and the way ahead each their own reach", () => {
    const p = lanePath(ring, "R1", 90, 0)!;
    // 300 m behind (R4, R3, R2) and 300 m ahead (R2, R3, R4) of the 100 m piece: about 700 m, not 400.
    expect(polylineLength(p.points)).toBeGreaterThan(650);
    expect(polylineLength(p.points)).toBeLessThan(760);
  });
});
