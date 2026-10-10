// placeVehicles: lane snapping and contact (the plan's "Lane snapping when the pin is in the middle of an intersection").
// Pose.xM/yM is the CENTRE of each vehicle's rectangle. "Zone touches the impact point" means the
// zone's anchor on the body outline (mid-side, or the corner for the diagonal zones) is on the impact point.
import { describe, expect, it } from "vitest";
import { lanePath, placeVehicles } from "../src";
import type { PlacedVehicle, PlacementOutcome, RoadNetwork, Scene, Vec2 } from "../src";
import {
  HWY, MAIN, PARK, angleDiffRad, bearingDegOf, buildingProblems, contactProblems, crossings, dimsOf, distToPolyline, dot, dist, expectOk,
  fwdOf, inPolygon, known, parkingBackingScene, posOf, sceneOf, sub, tBoneScene, toRad, veh, highwayRearEndScene,
} from "./physics-helpers";
import { HWY_X_M, LANE_W_M, AISLE_LANE_W_M, archNet, highwayNet, intersectionNet, makeBuilding, parkingLotNet, rect, twoWayLaneOffsetM } from "./roads-fixtures";

const PIN: Vec2 = { x: 0, y: 0 };
const get = (r: Extract<PlacementOutcome, { ok: true }>, id: string): PlacedVehicle => r.vehicles.find((v) => v.id === id)!;
const wrapPi = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** The lane index (of `count` lanes) whose lane path the point is closest to. */
function nearestLane(net: RoadNetwork, roadId: string, bearingDeg: number, count: number, p: Vec2): number {
  let best = -1, bestD = Infinity;
  for (let i = 0; i < count; i++) {
    const d = distToPolyline(p, lanePath(net, roadId, bearingDeg, i)!.points);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

describe("placeVehicles: T-bone at a 4-way, each vehicle straight", () => {
  const net = intersectionNet({ mainLanes: 2 });
  const scene = tBoneScene();

  it("puts A in the rightmost northbound lane and B in the rightmost eastbound lane", () => {
    const r = expectOk(placeVehicles(scene, net, PIN));
    expect(r.vehicles.map((v) => v.id)).toEqual(["A", "B"]);
    const a = get(r, "A"), b = get(r, "B");
    expect(a.path!.roadId).toBe("main");
    expect(a.path!.laneIndex).toBe(0);
    expect(b.path!.roadId).toBe("park");
    expect(b.path!.laneIndex).toBe(0);
    // The body sits in that lane: within half a lane of its centerline, and closer to it than to any other lane.
    expect(distToPolyline(posOf(a.impactPose), a.path!.points)).toBeLessThanOrEqual(LANE_W_M / 2);
    expect(nearestLane(net, "main", 0, 2, posOf(a.impactPose))).toBe(0);
    expect(distToPolyline(posOf(b.impactPose), b.path!.points)).toBeLessThanOrEqual(LANE_W_M / 2);
    // And the right-hand-traffic geometry: rightmost northbound lane is east, rightmost eastbound is south.
    expect(posOf(a.impactPose).x).toBeGreaterThan(twoWayLaneOffsetM(2, LANE_W_M, 1));
    expect(posOf(b.impactPose).y).toBeLessThan(0);
  });

  it("faces each vehicle along its road at impact", () => {
    const r = expectOk(placeVehicles(scene, net, PIN));
    expect(angleDiffRad(get(r, "A").impactPose.headingRad, 0)).toBeLessThan(1e-6);
    expect(angleDiffRad(get(r, "B").impactPose.headingRad, Math.PI / 2)).toBeLessThan(1e-6);
  });

  it("makes the impact point the crossing of the two lane paths", () => {
    const r = expectOk(placeVehicles(scene, net, PIN));
    const want = { x: twoWayLaneOffsetM(2, LANE_W_M, 0), y: -twoWayLaneOffsetM(1, LANE_W_M, 0) };
    expect(dist(r.impactPointM, want)).toBeLessThan(0.05);
    const xs = crossings(get(r, "A").path!.points, get(r, "B").path!.points);
    expect(xs).toHaveLength(1);
    expect(dist(r.impactPointM, xs[0]!)).toBeLessThan(0.05);
  });

  it("touches the marked zones to the impact point, bodies touching and not overlapping", () => {
    const r = expectOk(placeVehicles(scene, net, PIN));
    expect(contactProblems(scene, r, "A", "B")).toEqual([]);
  });

  it("gives each lane path in travel order, running from before the impact point to past it", () => {
    const r = expectOk(placeVehicles(scene, net, PIN));
    for (const id of ["A", "B"]) {
      const v = get(r, id), pts = v.path!.points;
      const travel = fwdOf(v.impactPose.headingRad);
      expect(dot(travel, sub(pts[0]!, r.impactPointM))).toBeLessThan(-10);
      expect(dot(travel, sub(pts[pts.length - 1]!, r.impactPointM))).toBeGreaterThan(10);
    }
  });

  it("uses the lane the claimant picked", () => {
    const s = tBoneScene({ aLane: 1 });
    const r = expectOk(placeVehicles(s, net, PIN));
    expect(get(r, "A").path!.laneIndex).toBe(1);
    expect(nearestLane(net, "main", 0, 2, posOf(get(r, "A").impactPose))).toBe(1);
    expect(r.impactPointM.x).toBeCloseTo(twoWayLaneOffsetM(2, LANE_W_M, 1), 1);
    expect(contactProblems(s, r, "A", "B")).toEqual([]);
  });
});

describe("placeVehicles: one-way cross street", () => {
  it("puts B in the single lane of a one-way westbound Park Street and hits A's right side", () => {
    const net = intersectionNet({ parkOneWay: true });
    const scene = sceneOf([
      veh("A", { type: "car", bearingDeg: 0, ...MAIN, zone: "right" }),
      veh("B", { type: "suv", bearingDeg: 270, ...PARK, zone: "front" }),
    ]);
    const r = expectOk(placeVehicles(scene, net, PIN));
    expect(get(r, "B").path!.laneIndex).toBe(0);
    expect(dist(r.impactPointM, { x: LANE_W_M / 2, y: 0 })).toBeLessThan(0.05); // a one-way lane is on the line
    expect(contactProblems(scene, r, "A", "B")).toEqual([]);
    expect(angleDiffRad(get(r, "B").impactPose.headingRad, toRad(270))).toBeLessThan(1e-6);
  });

  it("refuses a vehicle going the wrong way, naming it", () => {
    const net = intersectionNet({ parkOneWay: true });
    const scene = sceneOf([
      veh("A", { type: "car", bearingDeg: 0, ...MAIN, zone: "left" }),
      veh("B", { type: "suv", bearingDeg: 90, ...PARK, zone: "front" }),
    ]);
    const r = placeVehicles(scene, net, PIN);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.length).toBeGreaterThan(0);
      expect(r.errors.some((e) => e.vehicleIds.includes("B"))).toBe(true);
      expect(r.errors[0]!.text).toMatch(/\bB\b/);
    }
  });
});

describe("placeVehicles: a left turn", () => {
  // Park Street has two lanes each way; Main has one. A ends northbound on Main after turning left.
  const net = intersectionNet({ parkLanes: 2 });
  const scene = sceneOf([
    veh("A", { type: "car", action: "turn-left", bearingDeg: 0, ...MAIN, zone: "right" }),
    veh("B", { type: "suv", bearingDeg: 270, ...PARK, zone: "front" }),
  ]);

  it("approaches from the west leg travelling eastbound, in the leftmost lane for its direction", () => {
    const r = expectOk(placeVehicles(scene, net, PIN));
    const a = get(r, "A");
    expect(a.path!.roadId).toBe("park");
    expect(a.path!.laneIndex).toBe(1); // 2 lanes eastbound: the leftmost is index 1, next to the centerline
    const pts = a.path!.points;
    expect(pts[0]!.x).toBeLessThan(-20); // the west leg
    expect(pts[1]!.x).toBeGreaterThan(pts[0]!.x); // heading east
    expect(distToPolyline(pts[0]!, lanePath(net, "park", 90, 1)!.points)).toBeLessThan(0.05);
  });

  it("ends the turn travelling north, past the impact point", () => {
    const r = expectOk(placeVehicles(scene, net, PIN));
    const pts = get(r, "A").path!.points;
    const last = pts[pts.length - 1]!, prev = pts[pts.length - 2]!;
    const endBearing = bearingDegOf(prev, last);
    expect(Math.min(endBearing, 360 - endBearing)).toBeLessThan(30);
    expect(last.y).toBeGreaterThan(r.impactPointM.y);
    // At the impact A is partway through or finished with a left turn: heading between east and north.
    const h = wrapPi(get(r, "A").impactPose.headingRad);
    expect(h).toBeGreaterThan(-0.05);
    expect(h).toBeLessThan(Math.PI / 2 + 0.05);
  });

  it("puts the impact point on B's lane, where A's path crosses it, with the zones touching", () => {
    const r = expectOk(placeVehicles(scene, net, PIN));
    const b = get(r, "B");
    expect(b.path!.laneIndex).toBe(0); // rightmost westbound lane: north side, farthest from the line
    expect(r.impactPointM.y).toBeCloseTo(twoWayLaneOffsetM(2, LANE_W_M, 0), 1);
    expect(distToPolyline(r.impactPointM, get(r, "A").path!.points)).toBeLessThan(0.05);
    // A is part-way round its turn, so its side isn't square to B's front: the contact slides along A's side.
    expect(contactProblems(scene, r, "A", "B", 1.5)).toEqual([]);
  });
});

describe("placeVehicles: rear-end on the highway", () => {
  const net = highwayNet();
  const scene = highwayRearEndScene();

  it("keeps both in the same lane with the follower's front touching the leader's rear", () => {
    const r = expectOk(placeVehicles(scene, net, PIN));
    const a = get(r, "A"), b = get(r, "B");
    expect(a.path!.roadId).toBe("hwy");
    expect(a.path!.laneIndex).toBe(1);
    expect(b.path!.laneIndex).toBe(1);
    expect(contactProblems(scene, r, "A", "B")).toEqual([]);
    const dA = dimsOf("suv"), dB = dimsOf("pickup");
    expect(a.impactPose.xM).toBeCloseTo(HWY_X_M, 6);
    expect(b.impactPose.xM).toBeCloseTo(HWY_X_M, 6);
    // A is ahead (north) of B by half of each body.
    expect(a.impactPose.yM - b.impactPose.yM).toBeCloseTo(dA.L / 2 + dB.L / 2, 2);
  });

  it("takes the impact point as the pin's projection onto the shared lane", () => {
    const r = expectOk(placeVehicles(scene, net, { x: 1.5, y: 40 }));
    expect(r.impactPointM.x).toBeCloseTo(HWY_X_M, 2);
    expect(r.impactPointM.y).toBeCloseTo(40, 2);
    expect(contactProblems(scene, r, "A", "B")).toEqual([]);
  });

  it("honours a different shared lane", () => {
    const s = sceneOf([
      veh("A", { type: "suv", bearingDeg: 0, ...HWY, lane: 0, speed: known(20), zone: "rear" }),
      veh("B", { type: "pickup", bearingDeg: 0, ...HWY, lane: 0, speed: known(50), zone: "front" }),
    ], { place: "road" });
    const r = expectOk(placeVehicles(s, net, PIN));
    expect(get(r, "A").path!.laneIndex).toBe(0);
    expect(r.impactPointM.x).toBeCloseTo(HWY_X_M + 3.7, 2); // rightmost lane is east of the line for northbound
  });

  it("gives a parked vehicle no path", () => {
    const s = sceneOf([
      veh("A", { type: "suv", bearingDeg: 0, ...HWY, lane: 1, speed: known(30), zone: "front" }),
      veh("B", { type: "pickup", action: "parked", bearingDeg: 0, ...HWY, lane: 1, speed: known(0), zone: "rear" }),
    ], { place: "road" });
    const r = expectOk(placeVehicles(s, net, PIN));
    expect(get(r, "B").path).toBeNull();
    expect(get(r, "A").path).not.toBeNull();
    expect(angleDiffRad(get(r, "B").impactPose.headingRad, 0)).toBeLessThan(1e-6);
    expect(get(r, "B").impactPose.speedMps).toBe(0);
    expect(contactProblems(s, r, "A", "B")).toEqual([]);
  });
});

describe("placeVehicles: backing in a parking lot", () => {
  const net = parkingLotNet();
  const scene = parkingBackingScene();
  const pin: Vec2 = { x: 10, y: -1 };

  it("sends the backing vehicle in the direction opposite to the way it faces", () => {
    const r = expectOk(placeVehicles(scene, net, pin));
    const b = get(r, "B");
    expect(angleDiffRad(b.impactPose.headingRad, 0)).toBeLessThan(1e-6); // still facing north
    const pts = b.path!.points;
    const travel = bearingDegOf(pts[0]!, pts[pts.length - 1]!);
    expect(Math.abs(travel - 180)).toBeLessThan(2); // travelling south
    expect(pts[0]!.y).toBeGreaterThan(pts[pts.length - 1]!.y);
  });

  it("puts A in the rightmost eastbound aisle lane and meets B's path on it", () => {
    const r = expectOk(placeVehicles(scene, net, pin));
    const a = get(r, "A");
    expect(a.path!.roadId).toBe("aisle");
    expect(a.path!.laneIndex).toBe(0);
    expect(r.impactPointM.y).toBeCloseTo(-AISLE_LANE_W_M / 2, 2);
    expect(Math.abs(r.impactPointM.x - pin.x)).toBeLessThan(1);
    expect(contactProblems(scene, r, "A", "B")).toEqual([]);
  });

  it("runs the backing vehicle's path from before the impact point to past it", () => {
    const r = expectOk(placeVehicles(scene, net, pin));
    const pts = get(r, "B").path!.points;
    expect(pts[0]!.y).toBeGreaterThan(r.impactPointM.y);
    expect(pts[pts.length - 1]!.y).toBeLessThan(r.impactPointM.y);
  });
});

describe("placeVehicles: a parking lot keeps the backing path inside the lot", () => {
  it("clips the synthetic stall line to the parking polygon", () => {
    const net = parkingLotNet();
    const r = expectOk(placeVehicles(parkingBackingScene(), net, { x: 10, y: -1 }));
    const pts = get(r, "B").path!.points;
    for (const p of pts) expect(inPolygon({ x: p.x, y: Math.max(-24.999, Math.min(24.999, p.y)) }, net.parking[0]!.outline)).toBe(true);
    for (const p of pts) expect(Math.abs(p.y)).toBeLessThanOrEqual(25 + 1e-6);
    expect(Math.abs(pts[0]!.y)).toBeGreaterThan(24); // it does run out to the edge of the lot
  });
});

describe("placeVehicles: two crossings", () => {
  const net = archNet();
  const scene = (zoneA: "left" | "right", bearing: number) => sceneOf([
    veh("A", { type: "car", bearingDeg: 0, ...MAIN, zone: zoneA }),
    veh("B", { type: "suv", bearingDeg: bearing, roadId: "arch", roadName: "Arch Road", zone: "front" }),
  ]);

  it("takes the crossing nearest the pin: the southern one near (0, -35), the northern one near (0, 35)", () => {
    const s1 = scene("left", 90), s2 = scene("right", 270);
    const south = expectOk(placeVehicles(s1, net, { x: 0, y: -35 }));
    const north = expectOk(placeVehicles(s2, net, { x: 0, y: 35 }));
    expect(crossings(get(south, "A").path!.points, get(south, "B").path!.points)).toHaveLength(2);
    expect(dist(south.impactPointM, { x: LANE_W_M / 2, y: -40 - LANE_W_M / 2 })).toBeLessThan(0.05);
    expect(dist(north.impactPointM, { x: LANE_W_M / 2, y: 40 + LANE_W_M / 2 })).toBeLessThan(0.05);
    expect(contactProblems(s1, south, "A", "B")).toEqual([]);
    expect(contactProblems(s2, north, "A", "B")).toEqual([]);
  });

  it("flips to the other crossing when the pin moves across the middle", () => {
    const s = scene("left", 90);
    const nearSouth = expectOk(placeVehicles(s, net, { x: 0, y: -1 }));
    const nearNorth = expectOk(placeVehicles(scene("right", 270), net, { x: 0, y: 1 }));
    expect(nearSouth.impactPointM.y).toBeLessThan(0);
    expect(nearNorth.impactPointM.y).toBeGreaterThan(0);
  });
});

describe("placeVehicles: no road data (flat template)", () => {
  it("crosses lines through the pin along each bearing, with the zones touching", () => {
    const scene = sceneOf([
      veh("A", { type: "car", bearingDeg: 0, zone: "left" }),
      veh("B", { type: "suv", bearingDeg: 90, zone: "front" }),
    ]);
    const r = expectOk(placeVehicles(scene, null, PIN));
    expect(dist(r.impactPointM, PIN)).toBeLessThan(0.05);
    expect(contactProblems(scene, r, "A", "B")).toEqual([]);
    expect(angleDiffRad(get(r, "A").impactPose.headingRad, 0)).toBeLessThan(1e-6);
    expect(angleDiffRad(get(r, "B").impactPose.headingRad, Math.PI / 2)).toBeLessThan(1e-6);
  });

  it("works for a backing vehicle too", () => {
    const r = expectOk(placeVehicles(parkingBackingScene(), null, PIN));
    const pts = get(r, "B").path!.points;
    expect(Math.abs(bearingDegOf(pts[0]!, pts[pts.length - 1]!) - 180)).toBeLessThan(2);
  });
});

describe("placeVehicles: buildings", () => {
  it("leaves every vehicle clear of building footprints in ordinary scenes", () => {
    for (const [scene, net, pin] of [
      [tBoneScene(), intersectionNet({ mainLanes: 2 }), PIN],
      [highwayRearEndScene(), highwayNet(), PIN],
      [parkingBackingScene(), parkingLotNet(), { x: 10, y: -1 }],
    ] as Array<[Scene, RoadNetwork, Vec2]>) {
      const r = expectOk(placeVehicles(scene, net, pin));
      const poses = r.vehicles.map((v) => ({ id: v.id, pose: v.impactPose, type: scene.vehicles.find((s) => s.id === v.id)!.type }));
      expect(buildingProblems(net, poses)).toEqual([]);
    }
  });

  it("never places a vehicle on a building: it either avoids it or says why it can't", () => {
    // A building sits across the road exactly where B would have to be.
    const blocker = makeBuilding("blocker", rect(-8, -4, -1, -1));
    const net = intersectionNet({ mainLanes: 2, extraBuildings: [blocker] });
    const scene = tBoneScene();
    const r = placeVehicles(scene, net, PIN);
    if (r.ok) {
      const poses = r.vehicles.map((v) => ({ id: v.id, pose: v.impactPose, type: scene.vehicles.find((s) => s.id === v.id)!.type }));
      expect(buildingProblems(net, poses)).toEqual([]);
    } else {
      expect(r.errors.length).toBeGreaterThan(0);
      expect(r.errors.some((e) => /building/i.test(e.text))).toBe(true);
    }
  });
});

describe("placeVehicles: zones that can't touch", () => {
  it("says so in plain words, naming both vehicles, when both are marked 'rear' in a head-on", () => {
    const net = intersectionNet();
    const scene = sceneOf([
      veh("A", { type: "car", bearingDeg: 0, ...MAIN, zone: "rear" }),
      veh("B", { type: "suv", bearingDeg: 180, ...MAIN, zone: "rear" }),
    ]);
    const r = placeVehicles(scene, net, PIN);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.length).toBeGreaterThan(0);
      const e = r.errors[0]!;
      expect(e.code.length).toBeGreaterThan(0);
      expect([...e.vehicleIds].sort()).toEqual(["A", "B"]);
      expect(e.text).toMatch(/\bA\b/);
      expect(e.text).toMatch(/\bB\b/);
      expect(e.text).not.toMatch(/undefined|NaN|null|not implemented/i);
      expect(e.text.length).toBeGreaterThan(30);
    }
  });

  it("does the same without any road data", () => {
    const scene = sceneOf([
      veh("A", { type: "car", bearingDeg: 0, zone: "rear" }),
      veh("B", { type: "suv", bearingDeg: 180, zone: "rear" }),
    ]);
    const r = placeVehicles(scene, null, PIN);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.vehicleIds).toEqual(expect.arrayContaining(["A", "B"]));
  });
});
