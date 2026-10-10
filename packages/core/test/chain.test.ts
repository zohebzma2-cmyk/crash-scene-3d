// One street, several RoadWays: lane paths chain the pieces, tapering the offset where the lane count changes,
// and the streets at the pin list a street once per direction however many pieces carry it.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { lanePath, parseScene, simulate, streetsAtPin } from "../src";
import type { LanePath, RoadNetwork, Vec2 } from "../src";
import { angleDiffDeg, expectOk, known, polylineLength, sceneOf, tBoneScene, veh } from "./physics-helpers";
import { LANE_W_M, forkNet, intersectionNet, splitMainNet } from "./roads-fixtures";

/** Largest change in x (the lateral offset from a street running along x = 0) between consecutive points. */
const maxLateralStep = (pts: readonly Vec2[]) => Math.max(...pts.slice(1).map((p, i) => Math.abs(p.x - pts[i]!.x)));

describe("lane paths through pieces with different lane counts", () => {
  const net = splitMainNet();
  const w = LANE_W_M;

  it("chains 2 -> 3 lanes into one continuous path with the offset tapering over 30 m, never a step", () => {
    const p = lanePath(net, "main-m", 0, 0)!;
    expect(p).not.toBeNull();
    expect(maxLateralStep(p.points)).toBeLessThanOrEqual(0.1);
    // Before the split (y < -20) it sits where lane 0 of the 2-lane piece is; after the taper, where lane 0 of the 3-lane piece is.
    const south = p.points.filter((q) => q.y < -20 - 1e-6), north = p.points.filter((q) => q.y > 10 + 1e-6);
    expect(south.length).toBeGreaterThan(0);
    for (const q of south) expect(q.x).toBeCloseTo(1.5 * w, 6);
    for (const q of north) expect(q.x).toBeCloseTo(2.5 * w, 6);
    // In between it is a straight ramp.
    const ramp = p.points.filter((q) => q.y > -20 && q.y < 10);
    expect(ramp.length).toBeGreaterThanOrEqual(30 / 0.5 - 2);
    for (const q of ramp) expect(q.x).toBeCloseTo(1.5 * w + (w * (q.y + 20)) / 30, 6);
    // Points are in travel order and reach well past both ends of the starting piece.
    for (let i = 1; i < p.points.length; i++) expect(p.points[i]!.y).toBeGreaterThan(p.points[i - 1]!.y);
    expect(p.points[0]!.y).toBeLessThanOrEqual(-249);
    expect(p.points[p.points.length - 1]!.y).toBeGreaterThanOrEqual(249);
    expect(p.roadId).toBe("main-m");
    expect(p.laneIndex).toBe(0);
  });

  it("gives the same path whichever piece it starts from", () => {
    const a = lanePath(net, "main-s", 0, 0)!, b = lanePath(net, "main-m", 0, 0)!;
    expect(a.points).toEqual(b.points);
    expect(a.roadId).toBe("main-s");
  });

  it("keeps the lane counted from the right, clamped to the piece it is on", () => {
    // Lane 2 is the leftmost of the 3-lane piece (offset 1.75 m); on the 2-lane piece it clamps to lane 1 (also 1.75 m): no taper.
    const p = lanePath(net, "main-m", 0, 2)!;
    for (const q of p.points) expect(q.x).toBeCloseTo(0.5 * w, 6);
    // Starting on the narrower piece, lane 2 doesn't exist.
    expect(lanePath(net, "main-s", 0, 2)).toBeNull();
  });

  it("tapers the other way when the lane count drops (southbound 3 -> 2)", () => {
    const p = lanePath(net, "main-s", 180, 0)!;
    expect(p.points[0]!.y).toBeGreaterThan(p.points[p.points.length - 1]!.y);
    expect(maxLateralStep(p.points)).toBeLessThanOrEqual(0.1);
    expect(p.points[0]!.x).toBeCloseTo(-2.5 * w, 6); // right of southbound is west: 3-lane piece
    expect(p.points[p.points.length - 1]!.x).toBeCloseTo(-1.5 * w, 6); // 2-lane piece
  });

  it("carries a simulated vehicle across the taper without a jump", () => {
    const scene = sceneOf([
      veh("A", { type: "car", bearingDeg: 0, roadId: "main-m", roadName: "Main Street", speed: known(25), zone: "left" }),
      veh("B", { type: "suv", bearingDeg: 90, roadId: "park", roadName: "Park Street", speed: known(20), zone: "front" }),
    ]);
    const sim = expectOk(simulate(scene, net)).result;
    const A = sim.vehicles.find((v) => v.id === "A")!;
    const i0 = Math.round(-sim.startTimeS / sim.dtS);
    const pre = A.track.slice(0, i0 + 1);
    expect(maxLateralStep(pre.map((q) => ({ x: q.xM, y: q.yM })))).toBeLessThanOrEqual(0.02);
    // It started before the split on the 2-lane lane and ended up farther out on the 3-lane one.
    expect(pre[i0]!.xM - pre[0]!.xM).toBeGreaterThan(1);
    expect(pre[0]!.yM).toBeLessThan(-20);
    expect(A.path!.roadId).toBe("main-m");
  });
});

describe("a fork picks the straightest piece", () => {
  const net = forkNet();

  it("backwards: of the pieces arriving at the node, the one that is straight on", () => {
    const p = lanePath(net, "D", 0, 0)!;
    expect(p.points[0]!.y).toBeLessThan(-99); // came up U1, not along U2 from the west
    expect(p.points[0]!.x).toBeGreaterThan(0);
    expect(p.points[p.points.length - 1]!.y).toBeGreaterThan(99);
  });

  it("forwards: of the pieces leaving the node, the one that is straight on", () => {
    const u2 = lanePath(net, "U2", 84.3, 0)!;
    expect(u2.points[0]!.x).toBeLessThan(-95);
    expect(u2.points[u2.points.length - 1]!.x).toBeGreaterThan(95); // on to E, not the sharp turn north onto D
    const u1 = lanePath(net, "U1", 0, 0)!;
    expect(u1.points[u1.points.length - 1]!.y).toBeGreaterThan(99); // on to D, not E
    expect(u1.points[u1.points.length - 1]!.x).toBeLessThan(5);
  });

  it("never loops back over a piece it has used", () => {
    const p = lanePath(net, "D", 0, 0)!;
    expect(polylineLength(p.points)).toBeLessThan(250);
  });
});

describe("streetsAtPin: one choice per street and direction, whichever piece carries it", () => {
  it("lists Main Street once northbound and once southbound when it is two pieces meeting at the junction", () => {
    const net = intersectionNet({ splitMain: true });
    const north = streetsAtPin(net, { x: 5, y: 8 });
    expect(north.directions.map((d) => d.label).sort()).toEqual(["eastbound on Park Street", "northbound on Main Street", "southbound on Main Street", "westbound on Park Street"]);
    // The piece that carries the vehicle into the pin: north of the junction, that is the northern piece, both ways.
    expect(north.directions.find((d) => d.bound === "northbound" && d.roadName === "Main Street")!.roadId).toBe("main-n");
    expect(north.directions.find((d) => d.bound === "southbound" && d.roadName === "Main Street")!.roadId).toBe("main-n");
    const south = streetsAtPin(net, { x: 5, y: -8 });
    expect(south.directions.find((d) => d.bound === "northbound" && d.roadName === "Main Street")!.roadId).toBe("main-s");
  });

  it("at the split itself, the piece the vehicle arrives on", () => {
    const net = splitMainNet();
    const r = streetsAtPin(net, { x: 3, y: -20 });
    const main = r.directions.filter((d) => d.roadName === "Main Street");
    expect(main.map((d) => d.label).sort()).toEqual(["northbound on Main Street", "southbound on Main Street"]);
    expect(main.find((d) => d.bound === "northbound")!.roadId).toBe("main-s"); // northbound arrives on the south piece
    expect(main.find((d) => d.bound === "southbound")!.roadId).toBe("main-m");
  });

  it("uses the route ref when a street has no name, and never merges unnamed, un-ref'd pieces", () => {
    const net: RoadNetwork = {
      ...intersectionNet({ corners: false }),
      ways: [
        { ...intersectionNet().ways[0]!, id: "r1", name: null, ref: "US 3", centerline: [{ x: 0, y: -100 }, { x: 0, y: 0 }] },
        { ...intersectionNet().ways[0]!, id: "r2", name: null, ref: "US 3", centerline: [{ x: 0, y: 0 }, { x: 0, y: 100 }] },
        { ...intersectionNet().ways[0]!, id: "svc1", name: null, ref: null, centerline: [{ x: 8, y: -20 }, { x: 8, y: 20 }] },
        { ...intersectionNet().ways[0]!, id: "svc2", name: null, ref: null, centerline: [{ x: -8, y: -20 }, { x: -8, y: 20 }] },
      ],
    };
    const r = streetsAtPin(net, { x: 3, y: 4 });
    expect(r.directions.filter((d) => d.roadName === "US 3").map((d) => d.label).sort()).toEqual(["northbound on US 3", "southbound on US 3"]);
    expect(r.roads.filter((x) => x.roadId.startsWith("svc"))).toHaveLength(2);
    // And the ref'd pieces chain.
    const p = lanePath(net, "r1", 0, 0)!;
    expect(p.points[p.points.length - 1]!.y).toBeGreaterThan(99);
  });
});

describe("the real t-bone map (mapdata's parse of the cached Overpass JSON)", () => {
  const net = JSON.parse(readFileSync(new URL("./data/t-bone-intersection-roads.json", import.meta.url), "utf8")) as RoadNetwork;
  const scene = (() => {
    const r = parseScene(JSON.parse(readFileSync(new URL("../../../examples/t-bone-intersection/scene.json", import.meta.url), "utf8")));
    if (!r.ok) throw new Error(r.errors.join("; "));
    return r.value;
  })();

  it("is several RoadWays for one Main Street", () => {
    expect(net.ways.filter((w) => w.name === "Main Street").length).toBeGreaterThanOrEqual(5);
  });

  it("offers exactly one northbound and one southbound choice on Main Street at the pin", () => {
    const r = streetsAtPin(net, { x: 0, y: 0 });
    const main = r.directions.filter((d) => d.roadName === "Main Street");
    expect(main.map((d) => d.bound).sort()).toEqual(["northbound", "southbound"]);
    expect(new Set(r.directions.map((d) => d.label)).size).toBe(r.directions.length);
    for (const d of main) expect(r.roads.some((x) => x.roadId === d.roadId)).toBe(true);
  });

  it("chains a northbound lane through several pieces: one connected path, no gaps, well past the approach distance", () => {
    const d = streetsAtPin(net, { x: 0, y: 0 }).directions.find((x) => x.roadName === "Main Street" && x.bound === "northbound")!;
    const p = lanePath(net, d.roadId, d.bearingDeg, 0) as LanePath;
    expect(p).not.toBeNull();
    for (let i = 1; i < p.points.length; i++) expect(Math.hypot(p.points[i]!.x - p.points[i - 1]!.x, p.points[i]!.y - p.points[i - 1]!.y)).toBeLessThan(80);
    expect(polylineLength(p.points)).toBeGreaterThan(150);
    expect(angleDiffDeg(d.bearingDeg, 342)).toBeLessThan(40);
  });

  it("simulates the example t-bone on the real map", () => {
    const r = simulate(scene, net);
    expect(r.ok, JSON.stringify(r.ok ? "" : r.errors)).toBe(true);
    if (r.ok) {
      expect(r.result.vehicles).toHaveLength(2);
      expect(r.result.gaps).toHaveLength(1);
      expect(tBoneScene().vehicles).toHaveLength(2);
    }
  });
});
