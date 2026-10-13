// Shared helpers for the physics tests: scene builders and plain geometry.
// Conventions (also in the stubs): x = east, y = north; compass bearing 0 =
// north, clockwise; Pose.xM/yM is the CENTRE of the vehicle's rectangle.
import { PRESETS } from "../src";
import type { Pose, Scene, SceneSpeed, SceneVehicle, Vec2, VehicleId, VehicleType, Zone, RoadCondition, RoadNetwork, PlacementOutcome } from "../src";
import { ORIGIN, intersectionNet, makeWay } from "./roads-fixtures";

// ---------------------------------------------------------------- scenes

export const known = (mph: number): SceneSpeed => ({ kind: "known", mph });
export const unsure = (limitMph: number | null): SceneSpeed => ({ kind: "unsure", limitMph });

export interface VehicleSpec {
  readonly type?: VehicleType;
  readonly action?: SceneVehicle["action"];
  readonly bearingDeg?: number;
  readonly roadId?: string | null;
  readonly roadName?: string | null;
  readonly lane?: number | null;
  /** Came out of a driveway or parking lot onto the road (2026-10-11). */
  readonly fromDriveway?: true;
  readonly speed?: SceneSpeed;
  readonly braking?: boolean;
  readonly zone?: Zone;
}

export function veh(id: VehicleId, s: VehicleSpec = {}): SceneVehicle {
  return {
    id, role: id === "A" ? "claimant" : "other", year: null, make: "", model: "",
    type: s.type ?? "car", typeSource: "manual", action: s.action ?? "straight",
    travel: { bearingDeg: s.bearingDeg ?? 0, roadId: s.roadId ?? null, roadName: s.roadName ?? null, lane: s.lane ?? null, ...(s.fromDriveway ? { fromDriveway: true } : {}) },
    speed: s.speed ?? known(25), braking: s.braking ?? false, zone: s.zone ?? "front",
  };
}

export function sceneOf(vehicles: SceneVehicle[], o: { condition?: RoadCondition; place?: Scene["location"]["place"] } = {}): Scene {
  return {
    schemaVersion: 4,
    claim: { number: "CLM-TEST", vehicle: { year: null, make: "", model: "" } },
    location: { lat: ORIGIN.lat, lon: ORIGIN.lon, label: "Test location", nearLabel: "", source: "pin", place: o.place ?? "intersection" },
    occurred: { date: "2026-10-02", time: "17:15" },
    road: { condition: o.condition ?? "dry" },
    vehicles,
  };
}

export const MAIN = { roadId: "main", roadName: "Main Street" } as const;
export const PARK = { roadId: "park", roadName: "Park Street" } as const;

/** A northbound on Main (hit on its left side), B eastbound on Park (front). The pin is the junction. */
export function tBoneScene(o: { aMph?: number; bSpeed?: SceneSpeed; condition?: RoadCondition; aLane?: number | null } = {}): Scene {
  return sceneOf([
    veh("A", { type: "car", bearingDeg: 0, ...MAIN, lane: o.aLane ?? null, speed: known(o.aMph ?? 25), zone: "left" }),
    veh("B", { type: "suv", bearingDeg: 90, ...PARK, speed: o.bSpeed ?? known(20), zone: "front" }),
  ], { condition: o.condition });
}

/** Same crash with no road data at all (flat template): lines through the pin along each bearing. */
export function flatTBoneScene(o: { aMph?: number; bSpeed?: SceneSpeed; condition?: RoadCondition } = {}): Scene {
  return sceneOf([
    veh("A", { type: "car", bearingDeg: 0, speed: known(o.aMph ?? 25), zone: "left" }),
    veh("B", { type: "suv", bearingDeg: 90, speed: o.bSpeed ?? known(20), zone: "front" }),
  ], { condition: o.condition });
}

export function flatRearEndScene(o: { leaderMph?: number; followerMph?: number; condition?: RoadCondition; braking?: boolean } = {}): Scene {
  return sceneOf([
    veh("A", { type: "suv", bearingDeg: 0, speed: known(o.leaderMph ?? 15), zone: "rear", braking: o.braking ?? false }),
    veh("B", { type: "pickup", bearingDeg: 0, speed: known(o.followerMph ?? 50), zone: "front", braking: o.braking ?? false }),
  ], { condition: o.condition, place: "road" });
}

export const HWY = { roadId: "hwy", roadName: "Everett Turnpike" } as const;

export function highwayRearEndScene(o: { leaderMph?: number; followerMph?: number; condition?: RoadCondition; braking?: boolean } = {}): Scene {
  return sceneOf([
    veh("A", { type: "suv", bearingDeg: 0, ...HWY, lane: 1, speed: known(o.leaderMph ?? 20), zone: "rear", braking: o.braking ?? false }),
    veh("B", { type: "pickup", bearingDeg: 0, ...HWY, lane: 1, speed: known(o.followerMph ?? 50), zone: "front", braking: o.braking ?? false }),
  ], { condition: o.condition ?? "wet", place: "road" });
}

export function parkingBackingScene(): Scene {
  return sceneOf([
    veh("A", { type: "car", bearingDeg: 90, roadId: "aisle", speed: known(8), zone: "left" }),
    veh("B", { type: "van", action: "backing", bearingDeg: 0, speed: known(3), zone: "rear" }),
  ], { place: "parking" });
}

// ---------------------------------------------------------------- angles and vectors

export const MPH = 0.44704;
export const toRad = (d: number) => (d * Math.PI) / 180;
export const toDeg = (r: number) => (r * 180) / Math.PI;
/** Smallest absolute difference between two compass angles, degrees. */
export function angleDiffDeg(a: number, b: number): number {
  return Math.abs((((a - b) % 360) + 540) % 360 - 180);
}
/** Smallest absolute difference between two compass angles, radians. */
export const angleDiffRad = (a: number, b: number) => toRad(angleDiffDeg(toDeg(a), toDeg(b)));
/** Unit vector the vehicle faces; compass heading to math: x = sin, y = cos. */
export const fwdOf = (headingRad: number): Vec2 => ({ x: Math.sin(headingRad), y: Math.cos(headingRad) });
/** Unit vector to the right of a heading (north -> east). */
export const rightOf = (headingRad: number): Vec2 => ({ x: Math.cos(headingRad), y: -Math.sin(headingRad) });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const dot = (a: Vec2, b: Vec2) => a.x * b.x + a.y * b.y;
export const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);
export const posOf = (p: Pose): Vec2 => ({ x: p.xM, y: p.yM });
/** Compass bearing in degrees [0, 360) of the vector from a to b. */
export function bearingDegOf(a: Vec2, b: Vec2): number {
  return (toDeg(Math.atan2(b.x - a.x, b.y - a.y)) + 360) % 360;
}

// ---------------------------------------------------------------- vehicle boxes

export function dimsOf(type: VehicleType): { L: number; W: number } {
  return { L: PRESETS[type].length.value, W: PRESETS[type].width.value };
}

export function cornersOf(p: Pose, L: number, W: number): Vec2[] {
  const f = fwdOf(p.headingRad), r = rightOf(p.headingRad);
  const at = (a: number, b: number): Vec2 => ({ x: p.xM + f.x * a + r.x * b, y: p.yM + f.y * a + r.y * b });
  return [at(L / 2, W / 2), at(L / 2, -W / 2), at(-L / 2, -W / 2), at(-L / 2, W / 2)];
}

/**
 * Separating-axis test for two convex polygons. Returns the smallest signed
 * overlap over all edge axes: positive = penetration depth, negative = a gap
 * of at least that size, ~0 = touching.
 */
export function overlapDepth(a: readonly Vec2[], b: readonly Vec2[]): number {
  let best = Infinity;
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i]!, q = poly[(i + 1) % poly.length]!;
      const len = Math.hypot(q.x - p.x, q.y - p.y);
      const axis = { x: -(q.y - p.y) / len, y: (q.x - p.x) / len };
      const pa = a.map((v) => dot(v, axis)), pb = b.map((v) => dot(v, axis));
      const overlap = Math.min(Math.max(...pa), Math.max(...pb)) - Math.max(Math.min(...pa), Math.min(...pb));
      best = Math.min(best, overlap);
    }
  }
  return best;
}

/** Where a zone sits on the vehicle's outline: mid-side for front/rear/left/right, a corner for the diagonals. */
export function zoneAnchor(p: Pose, L: number, W: number, zone: Zone): Vec2 {
  const f = fwdOf(p.headingRad), r = rightOf(p.headingRad);
  const table: Record<Zone, [number, number]> = {
    front: [L / 2, 0], "front-right": [L / 2, W / 2], right: [0, W / 2], "rear-right": [-L / 2, W / 2],
    rear: [-L / 2, 0], "rear-left": [-L / 2, -W / 2], left: [0, -W / 2], "front-left": [L / 2, -W / 2],
  };
  const [a, b] = table[zone];
  return { x: p.xM + f.x * a + r.x * b, y: p.yM + f.y * a + r.y * b };
}

// ---------------------------------------------------------------- polylines

export function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const ab = sub(b, a), t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / dot(ab, ab)));
  return dist(p, { x: a.x + ab.x * t, y: a.y + ab.y * t });
}
export function distToPolyline(p: Vec2, pts: readonly Vec2[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) best = Math.min(best, distToSegment(p, pts[i]!, pts[i + 1]!));
  return best;
}
export function polylineLength(pts: readonly Vec2[]): number {
  let s = 0;
  for (let i = 0; i + 1 < pts.length; i++) s += dist(pts[i]!, pts[i + 1]!);
  return s;
}
/** All proper crossings of two polylines. */
export function crossings(a: readonly Vec2[], b: readonly Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i + 1 < a.length; i++) {
    for (let j = 0; j + 1 < b.length; j++) {
      const p = a[i]!, r = sub(a[i + 1]!, p), q = b[j]!, s = sub(b[j + 1]!, q);
      const den = r.x * s.y - r.y * s.x;
      if (Math.abs(den) < 1e-12) continue;
      const qp = sub(q, p);
      const t = (qp.x * s.y - qp.y * s.x) / den, u = (qp.x * r.y - qp.y * r.x) / den;
      if (t >= 0 && t <= 1 && u >= 0 && u <= 1) out.push({ x: p.x + r.x * t, y: p.y + r.y * t });
    }
  }
  return out;
}

// ---------------------------------------------------------------- results

export function expectOk<T extends { ok: boolean }>(o: T): Extract<T, { ok: true }> {
  if (!o.ok) throw new Error(`expected ok:true but got ${JSON.stringify(o)}`);
  return o as Extract<T, { ok: true }>;
}

/** Throws if any number anywhere in a value is NaN or infinite. */
export function assertAllFinite(v: unknown, path = "result"): void {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error(`${path} is ${v}`);
  } else if (Array.isArray(v)) {
    v.forEach((x, i) => assertAllFinite(x, `${path}[${i}]`));
  } else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) assertAllFinite(x, `${path}.${k}`);
  }
}

/**
 * Contact checks shared by the placement tests: both marked zones sit on the impact point (within anchorTolM),
 * bodies touch without overlapping. Headings that are not square to each other (a vehicle part-way round a
 * turn) can't have both anchors exactly on the point without the corners overlapping, so the contact slides
 * along the struck side; those tests pass a wider anchorTolM (the plan: "slides along the struck side within the zone's extent").
 */
export function contactProblems(scene: Scene, placed: Extract<PlacementOutcome, { ok: true }>, aId: VehicleId, bId: VehicleId, anchorTolM = 0.1): string[] {
  const problems: string[] = [];
  const get = (id: VehicleId) => {
    const v = scene.vehicles.find((x) => x.id === id)!;
    const p = placed.vehicles.find((x) => x.id === id)!;
    return { v, p, ...dimsOf(v.type) };
  };
  const a = get(aId), b = get(bId);
  for (const x of [a, b]) {
    const anchor = zoneAnchor(x.p.impactPose, x.L, x.W, x.v.zone);
    const d = dist(anchor, placed.impactPointM);
    if (d > anchorTolM) problems.push(`${x.v.id}'s ${x.v.zone} zone is ${d.toFixed(3)} m from the impact point`);
  }
  const depth = overlapDepth(cornersOf(a.p.impactPose, a.L, a.W), cornersOf(b.p.impactPose, b.L, b.W));
  if (Math.abs(depth) > 0.05) problems.push(`bodies ${depth > 0 ? "overlap by" : "are apart by"} ${Math.abs(depth).toFixed(3)} m`);
  return problems;
}

function inPolygon(p: Vec2, ring: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!, b = ring[j]!;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Every corner of every body must be on road width (with 30 cm slack) or inside a parking outline. */
export function drivableProblems(net: RoadNetwork, poses: ReadonlyArray<{ id: string; pose: Pose; type: VehicleType }>, tolM = 0.3): string[] {
  const out: string[] = [];
  for (const { id, pose, type } of poses) {
    const { L, W } = dimsOf(type);
    for (const c of cornersOf(pose, L, W)) {
      const onRoad = net.ways.some((w) => distToPolyline(c, w.centerline) <= ((w.oneway ? w.lanesForward : w.lanesForward + w.lanesBackward) * w.laneWidthM) / 2 + tolM);
      const inLot = net.parking.some((p) => inPolygon(c, p.outline));
      if (!onRoad && !inLot) out.push(`${id} has a corner off the road at (${c.x.toFixed(2)}, ${c.y.toFixed(2)})`);
    }
  }
  return out;
}

export { inPolygon };

export function buildingProblems(net: RoadNetwork, poses: ReadonlyArray<{ id: string; pose: Pose; type: VehicleType }>): string[] {
  const out: string[] = [];
  for (const { id, pose, type } of poses) {
    const { L, W } = dimsOf(type);
    for (const b of net.buildings) {
      const d = overlapDepth(cornersOf(pose, L, W), b.footprint);
      if (d > 0.05) out.push(`${id} overlaps building ${b.id} by ${d.toFixed(2)} m`);
    }
  }
  return out;
}

/**
 * A scene with a real two-sided hole in the working speeds, found by a timing window rather than an obstacle:
 * A (Main, northbound, "not sure") hits B at the Park Street junction, while C (westbound on Elm Street, 60 m
 * south) hits D (southbound on Oak Street). A's path and C's path cross at (6, -62); A passes that spot before
 * C arrives (slow A) or after C has gone (fast A), but at A speeds around 27.5 to 34 mph they are there together
 * and A would have passed through C. Speeds either side of that band work.
 */
export function holeScene(a: SceneSpeed): { scene: Scene; net: RoadNetwork } {
  const base = intersectionNet({ mainLanes: 2, corners: false });
  const elm = makeWay({ id: "elm", name: "Elm Street", lanesForward: 1, lanesBackward: 1, centerline: [{ x: -150, y: -63.5 }, { x: 150, y: -63.5 }] });
  const oak = makeWay({ id: "oak", name: "Oak Street", lanesForward: 1, lanesBackward: 1, centerline: [{ x: -42.05, y: -10 }, { x: -42.05, y: -150 }] });
  const scene = sceneOf([
    veh("A", { type: "car", bearingDeg: 0, ...MAIN, speed: a, zone: "left" }),
    veh("B", { type: "suv", bearingDeg: 90, ...PARK, speed: known(10), zone: "front" }),
    veh("C", { type: "car", bearingDeg: 270, roadId: "elm", roadName: "Elm Street", speed: known(25), zone: "right" }),
    veh("D", { type: "suv", bearingDeg: 180, roadId: "oak", roadName: "Oak Street", speed: known(25), zone: "front" }),
  ]);
  return { scene, net: { ...base, ways: [...base.ways, elm, oak] } };
}
