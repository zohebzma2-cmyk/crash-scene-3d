// Snap each vehicle to a lane and place it at impact (the plan's "lane snapping" section).
//
// Frames and angles: local ENU meters (x east, y north). Pose.headingRad is a
// COMPASS bearing (0 = north, clockwise); the geo helpers convert to math vectors.
// Pose.xM / yM is the CENTRE of the vehicle's length x width rectangle.
//
// How it works:
//  1. Every vehicle gets a "guide": the polyline its centre follows, in travel
//     order. On a known road that is a lane centerline (a turn is an arc from the
//     approach lane into the exit lane); with no road it is a straight line
//     through the pin along its bearing (a backing vehicle travels opposite to
//     the way it faces; a free line is clipped to the parking lot it starts in).
//  2. Two vehicles: the impact point is where their guides cross nearest the pin
//     (for a rear-end, the pin's projection onto the shared lane). Each vehicle
//     is placed so its marked zone's anchor sits on that point, so the bodies
//     touch without overlapping. If they would overlap, the contact slides along
//     the struck side within the zone's extent; if nothing works, or the speeds
//     say they would be moving apart, a plain message names the vehicles.
//  3. Three or four vehicles: each vehicle's marked zone is matched to the other
//     vehicle that can hit it (nearest crossing, then the smallest relative
//     speed, then mutual pairs, then letter order). A vehicle whose zone is
//     already taken by another contact touches its partner with whichever of its
//     own faces points at it.
import type { Pose, Vec2 } from "../contracts/geometry";
import type { LanePath, RoadNetwork, RoadWay } from "../contracts/roads";
import type { Scene, SceneVehicle, VehicleId, Zone } from "../contracts/scene";
import type { PlainMessage } from "../contracts/simulation";
import { DRIVEWAY_WORDS, ZONE_WORDS, formatSpeedExact } from "../format";
import { NO_ROAD_TEXT, cannotWorkOut, validatePin, validateScene } from "./validate";
import { toLocal } from "./projection";
import {
  DRIVEWAY_M, MIN_CLOSING_MPS, OVERLAP_TOLERANCE_M, ROAD_REACH_M, TURN_RADIUS_LEFT_M, TURN_RADIUS_RIGHT_M,
} from "./constants";
import {
  type Poly, add, angleBetween, bearingOf, boxCorners, clipConvex, dist, dot, fwdOf, makePoly, mul, norm, pointAt, pointInRing, polyCrossings, project, rightOf, satDepth,
  slicePoly, sub, toRad, unit, wrap2Pi, wrapPi,
} from "./geo";
import {
  CHAIN_REACH_M, NEAR_PIN_M, chainedLane, cleanNet, goesForward, lanesIn, localBearing, streetsAtPin, wayById,
} from "./lanes";
import {
  CASES, type CaseKey, NOTHING_MOVING_TEXT, type VehicleDims, ZONE_ANGLE_RAD, dimsOf, isSideZone, letterName, speedCases, vehicleWord, zoneAnchorLocal, zoneToleranceRad,
} from "./model";

export interface PlacedVehicle {
  readonly id: VehicleId;
  /** Lane path the vehicle approached on, in travel order, ending past the impact point; null when parked. */
  readonly path: LanePath | null;
  /** Pose at t = 0 with the marked zone touching the impact point. */
  readonly impactPose: Pose;
}
export type PlacementOutcome =
  | { readonly ok: true; readonly impactPointM: Vec2; readonly vehicles: readonly PlacedVehicle[] }
  | { readonly ok: false; readonly errors: readonly PlainMessage[] };

/** The polyline a vehicle's centre follows, in travel order. */
export interface Guide {
  readonly poly: Poly;
  /** Way id, or "template" when there is no road data. */
  readonly roadId: string;
  readonly laneIndex: number;
  /** Heading of the front minus the travel bearing: 0, or pi when backing up. */
  readonly facingOffset: number;
  readonly moving: boolean;
  /**
   * The path really starts where it starts (a driveway, a parking lot's edge, a street that ends): a vehicle needing more
   * room than that behind it starts from a stop there. False where the path only stops because the map data does (its
   * edge), or where there is no road data at all: the approach then carries straight on, as the road was heading.
   */
  readonly startsThere: boolean;
  /** The path really ends where it ends (a street ending at a T, a lot's edge), not at the map data's edge. */
  readonly endsThere: boolean;
  /** The vehicle came out of a driveway or parking lot: the first part of its path is off the road by design. */
  readonly driveway: boolean;
  /** Half the full width of its road (or of a typical two-lane road off the roads), m: how far off its path a vehicle may sit at the impact. */
  readonly halfRoadM: number;
}

export interface PlacedBody {
  readonly id: VehicleId;
  readonly veh: SceneVehicle;
  readonly dims: VehicleDims;
  readonly guide: Guide;
  /** Rectangle centre at t = 0. */
  readonly centre: Vec2;
  /** Compass bearing of the front, radians (not wrapped). */
  readonly headingRad: number;
  /** Compass bearing of travel, radians (heading, or heading + pi when backing). */
  readonly travelBearingRad: number;
  /** Zone that touches in this vehicle's first contact. */
  readonly zone: Zone;
}

export interface Contact {
  readonly a: VehicleId;
  readonly b: VehicleId;
  /** Where the bodies touch. */
  readonly pointM: Vec2;
  /** Unit normal of the contact, pointing from b into a. */
  readonly normal: Vec2;
  /** The contact patch: its centre first, then the two ends along the contact face; where the impulses act. */
  readonly patchM: readonly Vec2[];
}

export interface DetailedPlacement {
  /** The first contact's point (the impact point shown on the map). */
  readonly impactPointM: Vec2;
  /** In scene order. */
  readonly bodies: readonly PlacedBody[];
  /** One per touching pair, in placement order. */
  readonly contacts: readonly Contact[];
  /**
   * Vehicles whose entered zone could not touch (or could not close), so the placement used the nearest zone that does. Empty when
   * every entered zone was used. `body.veh` keeps the entered zone; `body.zone` is the one used.
   */
  readonly zonesUsed: ReadonlyArray<{ readonly id: VehicleId; readonly entered: Zone; readonly used: Zone }>;
}
export type DetailedOutcome =
  | { readonly ok: true; readonly value: DetailedPlacement }
  | { readonly ok: false; readonly errors: readonly PlainMessage[] };

const msg = (code: string, text: string, vehicleIds: readonly VehicleId[]): PlainMessage => ({ code, text, vehicleIds });
const fail = (...errors: PlainMessage[]): { ok: false; errors: PlainMessage[] } => ({ ok: false, errors });
const isMessage = (x: unknown): x is PlainMessage => typeof x === "object" && x !== null && "code" in x && "text" in x;

/** How far a free line (no road data) reaches each way from the pin: as far as a chained lane path, m. */
const FREE_HALF_M = CHAIN_REACH_M;

// ---------------------------------------------------------------- guides

const alignment = (way: RoadWay, p: Vec2, bearing: number): number => {
  const b = localBearing(way, p, true);
  return Math.min(angleBetween(bearing, b), angleBetween(bearing, b + Math.PI));
};

/** A road picked by its id may point this far off the way entered (either way along it) and still be the road it was on. */
const ROAD_ID_ALIGN_RAD = toRad(45);
/** A direction with no road picked is on a road it lines up with this closely. */
const ROAD_ALIGN_RAD = toRad(30);

/**
 * The roads at the pin, as the direction list has them (streetsAtPin): within NEAR_PIN_M, else the nearest one within
 * ROAD_REACH_M. Nearest first.
 */
function waysAtPin(roads: RoadNetwork, pin: Vec2): Array<{ w: RoadWay; d: number }> {
  const all = roads.ways.map((w) => ({ w, d: project(makePoly(w.centerline), pin).dist })).sort((a, b) => a.d - b.d);
  const close = all.filter((x) => x.d <= NEAR_PIN_M);
  return close.length ? close : all.filter((x) => x.d <= ROAD_REACH_M && x.d <= all[0]!.d + 0.5);
}

/**
 * The road a vehicle is on: its road id (when the way entered runs along it), else a road at the pin with its name, else the
 * nearest one at the pin it is lined up with. Null when the direction follows no road at the pin.
 */
function resolveWay(v: SceneVehicle, roads: RoadNetwork, pin: Vec2, bearing: number): RoadWay | null {
  if (v.travel.roadId) {
    const w = wayById(roads, v.travel.roadId);
    if (w) return alignment(w, pin, bearing) <= ROAD_ID_ALIGN_RAD + 1e-9 ? w : null;
  }
  const near = waysAtPin(roads, pin).filter((x) => alignment(x.w, pin, bearing) <= ROAD_ALIGN_RAD);
  const name = v.travel.roadName?.trim().toLowerCase();
  if (name) {
    const m = near.find((x) => (x.w.name ?? "").trim().toLowerCase() === name);
    if (m) return m.w;
  }
  return near[0]?.w ?? null;
}

const roadWords = (w: RoadWay): string => (w.name && w.name.trim() ? w.name.trim() : "this road");

/** Half the road's full width, every lane both ways, m. */
const halfRoad = (w: RoadWay): number => ((w.oneway ? w.lanesForward : w.lanesForward + w.lanesBackward) * w.laneWidthM) / 2;
/** Half a typical two-lane road's width where there is no road (no road data, a parking lot), m. */
const OPEN_HALF_ROAD_M = 3.5;
/**
 * A path start this close to the edge of the road data is the edge of the data, not where the road starts, m: the clip at the
 * edge plus a lane's offset from the centre line on a road meeting the edge at an angle (four wide lanes, about 15 m).
 */
const DATA_EDGE_M = 20;
/** Does a path that starts at p start where the map data stops (so the road goes on), rather than where the road does? */
const atDataEdge = (net: RoadNetwork, p: Vec2): boolean => Math.max(Math.abs(p.x), Math.abs(p.y)) >= net.radiusM - DATA_EDGE_M;

/** "Vehicle A's direction doesn't follow any road at the pin." The direction list offers the roads that are there. */
function offRoadDirection(v: SceneVehicle): PlainMessage {
  return msg("off-road-direction", `${letterName(v.id)}'s direction doesn't follow any road at the pin. Pick the road it was on and the way it was going, or pick ${DRIVEWAY_WORDS} if it came out of one.`, [v.id]);
}

function laneGuide(v: SceneVehicle, net: RoadNetwork, way: RoadWay, pin: Vec2, travelBearing: number, facingOffset: number, defaultLane: (n: number) => number): Guide | PlainMessage {
  const forward = goesForward(way, pin, travelBearing);
  const n = lanesIn(way, forward);
  if (n <= 0) {
    return msg("wrong-way", way.oneway
      ? `${letterName(v.id)} is going the wrong way on ${roadWords(way)}, which is one-way. Check which way it was going.`
      : `${letterName(v.id)} is going in a direction that ${roadWords(way)} has no lanes for. Check which way it was going.`, [v.id]);
  }
  const lane = v.travel.lane ?? defaultLane(n);
  if (lane >= n) {
    return msg("no-such-lane", `${letterName(v.id)} is placed in lane ${lane + 1} (counting from the right), but ${roadWords(way)} only has ${n} lane${n === 1 ? "" : "s"} that way. Pick a different lane.`, [v.id]);
  }
  const pts = chainedLane(net, way, forward, lane, pin)!;
  return { poly: makePoly(pts), roadId: way.id, laneIndex: lane, facingOffset, moving: v.action !== "parked", startsThere: !atDataEdge(net, pts[0]!), endsThere: !atDataEdge(net, pts[pts.length - 1]!), driveway: false, halfRoadM: halfRoad(way) };
}

/** The parking lot the pin is in, if any. */
const lotAt = (roads: RoadNetwork | null, pin: Vec2) => roads?.parking.find((p) => pointInRing(pin, p.outline));

/** Straight line through the pin; clipped to the parking lot the pin is in, when there is one. */
function freeLine(v: SceneVehicle, travelBearing: number, facingOffset: number, roads: RoadNetwork | null, pin: Vec2): Guide {
  const u = fwdOf(travelBearing);
  let t0 = -FREE_HALF_M, t1 = FREE_HALF_M;
  const lot = lotAt(roads, pin);
  if (lot) {
    const inside = (t: number) => pointInRing(add(pin, mul(u, t)), lot.outline);
    const reach = (sign: number): number => {
      let lo = 0, hi = FREE_HALF_M, last = 0;
      for (let t = 0.5; t <= FREE_HALF_M; t += 0.5) { if (!inside(sign * t)) { hi = t; break; } last = t; lo = t; }
      if (hi === FREE_HALF_M && inside(sign * FREE_HALF_M)) return FREE_HALF_M;
      for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; if (inside(sign * mid)) lo = mid; else hi = mid; }
      return Math.max(last, lo);
    };
    t0 = -reach(-1); t1 = reach(1);
  }
  // In a lot the path starts at the lot's edge (a vehicle needing more room starts from a stop in the lot); with no road data it runs on.
  return {
    poly: makePoly([add(pin, mul(u, t0)), add(pin, mul(u, t1))]), roadId: "template", laneIndex: 0, facingOffset, moving: v.action !== "parked",
    startsThere: lot !== undefined && -t0 < FREE_HALF_M, endsThere: lot !== undefined && t1 < FREE_HALF_M, driveway: false, halfRoadM: OPEN_HALF_ROAD_M,
  };
}

/** Where the pin meets a road: the nearest point of its centre line, and half the road's full width, m. */
function roadFoot(way: RoadWay, pin: Vec2): { foot: Vec2; halfRoadM: number } {
  return { foot: project(makePoly(way.centerline), pin).point, halfRoadM: halfRoad(way) };
}

/**
 * Out of a driveway or parking lot, straight across or backing: a straight path along the way it travels, starting
 * DRIVEWAY_M off the road's edge, through the road at the pin and on to its far edge. Never longer off the road than that.
 */
function drivewayGuide(v: SceneVehicle, way: RoadWay, pin: Vec2, travel: number, facingOffset: number): Guide {
  const { foot, halfRoadM } = roadFoot(way, pin);
  const u = fwdOf(travel);
  const pts = [sub(foot, mul(u, halfRoadM + DRIVEWAY_M)), foot, add(foot, mul(u, halfRoadM + DRIVEWAY_M))];
  return { poly: makePoly(pts), roadId: way.id, laneIndex: 0, facingOffset, moving: v.action !== "parked", startsThere: true, endsThere: false, driveway: true, halfRoadM: halfRoad(way) };
}

/** Round a corner: approach lane into exit lane with a circular arc of radius R (reduced if the legs are too short). */
function fillet(aPts: readonly Vec2[], ePts: readonly Vec2[], radius: number, near: Vec2): Vec2[] | null {
  const a = makePoly(aPts), e = makePoly(ePts);
  const xs = polyCrossings(a, e).sort((p, q) => dist(p.point, near) - dist(q.point, near));
  const x = xs[0];
  if (!x) return null;
  const bA = pointAt(a, x.sA).bearing, bE = pointAt(e, x.sB).bearing;
  const dTheta = wrapPi(bE - bA);
  const theta = Math.abs(dTheta);
  if (theta < toRad(3)) return [...slicePoly(a, 0, x.sA), ...slicePoly(e, x.sB, e.length).slice(1)];
  const tMax = Math.min(x.sA, e.length - x.sB) - 0.5;
  if (tMax <= 0.5) return null;
  let r = radius;
  if (r * Math.tan(theta / 2) > tMax) r = tMax / Math.tan(theta / 2);
  const t = r * Math.tan(theta / 2);
  const left = dTheta < 0; // compass bearing decreasing = counter-clockwise = a left turn
  const side = (h: number): Vec2 => (left ? mul(rightOf(h), -1) : rightOf(h)); // toward the turn centre
  const s0 = pointAt(a, x.sA - t).p;
  const centre = add(s0, mul(side(bA), r));
  const n = Math.max(2, Math.ceil(theta / toRad(2)));
  const arc: Vec2[] = [];
  for (let k = 1; k < n; k++) {
    const h = bA + (dTheta * k) / n;
    arc.push(sub(centre, mul(side(h), r)));
  }
  return [...slicePoly(a, 0, x.sA - t), ...arc, ...slicePoly(e, x.sB + t, e.length)];
}

/** A turn with no road data: the arc ends at the pin, heading along the entered (final) bearing. */
function flatTurn(left: boolean, exitBearing: number, pin: Vec2): Guide {
  const r = left ? TURN_RADIUS_LEFT_M : TURN_RADIUS_RIGHT_M;
  const approach = exitBearing + (left ? Math.PI / 2 : -Math.PI / 2);
  const c = sub(pin, mul(fwdOf(exitBearing), r));
  const aLine = [sub(c, mul(fwdOf(approach), FREE_HALF_M)), add(c, mul(fwdOf(approach), 20))];
  const eLine = [sub(c, mul(fwdOf(exitBearing), 20)), add(c, mul(fwdOf(exitBearing), FREE_HALF_M))];
  const pts = fillet(aLine, eLine, r, pin)!;
  return { poly: makePoly(pts), roadId: "template", laneIndex: 0, facingOffset: 0, moving: true, startsThere: false, endsThere: false, driveway: false, halfRoadM: OPEN_HALF_ROAD_M };
}

/** The road a turning vehicle comes from: the leg at a junction near the pin that leads into the turn (null when there is none). */
export interface TurnFrom { readonly way: RoadWay; readonly forward: boolean; readonly junction: Vec2 }

/**
 * Where a turn ending on `exitWay` at `exitB` comes from: a left turn ending at bearing b came in at b + 90 degrees, a right
 * turn at b - 90, along a leg of another road at a junction near the pin (within 35 degrees). Null when no road leads in
 * (a single road, or only a one-way street the wrong way).
 */
export function turnFrom(roads: RoadNetwork, pin: Vec2, exitWayId: string, exitB: number, left: boolean): TurnFrom | null {
  const approachB = exitB + (left ? Math.PI / 2 : -Math.PI / 2);
  const legs = streetsAtPin(roads, pin).legs
    .filter((l) => l.roadId !== exitWayId && angleBetween(toRad(l.outwardBearingDeg), approachB + Math.PI) <= toRad(35))
    .sort((a, b) => dist(a.junction, pin) - dist(b.junction, pin));
  const leg = legs[0];
  const way = leg ? wayById(roads, leg.roadId) : undefined;
  if (!leg || !way) return null;
  const forward = goesForward(way, leg.junction, approachB);
  return lanesIn(way, forward) > 0 ? { way, forward, junction: leg.junction } : null;
}

function noRoadToTurnFrom(v: SceneVehicle, exitWay: RoadWay): PlainMessage {
  return msg("no-road-to-turn-from", `${letterName(v.id)} is turning onto ${roadWords(exitWay)}, but no road at the pin leads into that turn. If it came out of ${DRIVEWAY_WORDS}, pick that; otherwise check what it was doing or which way it was going.`, [v.id]);
}

function turnGuide(v: SceneVehicle, roads: RoadNetwork | null, pin: Vec2): Guide | PlainMessage {
  const left = v.action === "turn-left";
  const exitB = toRad(v.travel.bearingDeg);
  if (!roads) return flatTurn(left, exitB, pin);
  const exitWay = resolveWay(v, roads, pin, exitB);
  if (!exitWay) return offRoadDirection(v);
  const exitForward = goesForward(exitWay, pin, exitB);
  const nExit = lanesIn(exitWay, exitForward);
  if (nExit <= 0) {
    return msg("wrong-way", `${letterName(v.id)} ends its turn going the wrong way on ${roadWords(exitWay)}, which is one-way. Check which way it was going.`, [v.id]);
  }
  const exitPts = chainedLane(roads, exitWay, exitForward, left ? nExit - 1 : 0, pin)!;
  const radius = left ? TURN_RADIUS_LEFT_M : TURN_RADIUS_RIGHT_M;
  const approachB = exitB + (left ? Math.PI / 2 : -Math.PI / 2);
  if (v.travel.fromDriveway) {
    // Out of a driveway on the side the turn comes from: DRIVEWAY_M off the road, then the arc into the exit lane.
    const { foot, halfRoadM } = roadFoot(exitWay, pin);
    const u = fwdOf(approachB);
    const aLine = [sub(foot, mul(u, halfRoadM + DRIVEWAY_M)), add(foot, mul(u, halfRoadM + 2))];
    const pts = fillet(aLine, exitPts, radius, pin);
    if (!pts) return noRoadToTurnFrom(v, exitWay);
    return { poly: makePoly(pts), roadId: exitWay.id, laneIndex: 0, facingOffset: 0, moving: true, startsThere: true, endsThere: !atDataEdge(roads, pts[pts.length - 1]!), driveway: true, halfRoadM: halfRoad(exitWay) };
  }
  const from = turnFrom(roads, pin, exitWay.id, exitB, left);
  if (!from) return noRoadToTurnFrom(v, exitWay);
  const appWay = from.way;
  const nApp = lanesIn(appWay, from.forward);
  const lane = v.travel.lane ?? (left ? nApp - 1 : 0);
  if (lane >= nApp) {
    return msg("no-such-lane", `${letterName(v.id)} is placed in lane ${lane + 1} (counting from the right), but ${roadWords(appWay)} only has ${nApp} lane${nApp === 1 ? "" : "s"} that way. Pick a different lane.`, [v.id]);
  }
  const appPts = chainedLane(roads, appWay, from.forward, lane, from.junction)!;
  const pts = fillet(appPts, exitPts, radius, pin);
  if (!pts) return noRoadToTurnFrom(v, exitWay);
  return { poly: makePoly(pts), roadId: appWay.id, laneIndex: lane, facingOffset: 0, moving: true, startsThere: !atDataEdge(roads, pts[0]!), endsThere: !atDataEdge(roads, pts[pts.length - 1]!), driveway: false, halfRoadM: Math.max(halfRoad(appWay), halfRoad(exitWay)) };
}

/**
 * Guides already built, per road network (or none): a guide depends only on the network, the pin and the vehicle's letter,
 * action and travel (never its zone, type or speed), so the zone fallback's many trials and the fixer's candidates share them.
 * Guides are never changed after they are built. Bounded: a full table is simply emptied.
 */
const guideCache = new WeakMap<object, Map<string, Guide | PlainMessage>>();
const NO_ROADS = {};
const GUIDE_CACHE_MAX = 4096;

export function buildGuide(v: SceneVehicle, roads: RoadNetwork | null, pin: Vec2): Guide | PlainMessage {
  const owner = roads ?? NO_ROADS;
  let table = guideCache.get(owner);
  if (!table) { table = new Map(); guideCache.set(owner, table); }
  const t = v.travel;
  const key = JSON.stringify([pin.x, pin.y, v.id, v.action, t.bearingDeg, t.roadId, t.roadName, t.lane, t.fromDriveway === true]);
  const hit = table.get(key);
  if (hit) return hit;
  const g = buildGuideFresh(v, roads, pin);
  if (table.size >= GUIDE_CACHE_MAX) table.clear();
  table.set(key, g);
  return g;
}

function buildGuideFresh(v: SceneVehicle, roads: RoadNetwork | null, pin: Vec2): Guide | PlainMessage {
  if (v.action === "turn-left" || v.action === "turn-right") return turnGuide(v, roads, pin);
  const facing = toRad(v.travel.bearingDeg);
  const backing = v.action === "backing";
  const travel = backing ? facing + Math.PI : facing;
  const off = backing ? Math.PI : 0;
  if (!roads) return freeLine(v, travel, off, null, pin);
  if (v.travel.fromDriveway && v.action !== "parked") {
    // The road it came out onto: the one picked, else the nearest at the pin.
    const way = (v.travel.roadId ? wayById(roads, v.travel.roadId) : undefined) ?? waysAtPin(roads, pin)[0]?.w;
    if (way) return drivewayGuide(v, way, pin, travel, off);
  }
  const way = resolveWay(v, roads, pin, travel);
  if (way) return laneGuide(v, roads, way, pin, travel, off, () => 0);
  // Inside a parking lot a vehicle may go any way; anywhere else a path is never drawn across open ground.
  if (lotAt(roads, pin)) return freeLine(v, travel, off, roads, pin);
  return offRoadDirection(v);
}

// ---------------------------------------------------------------- geometry of one placed vehicle

interface Pose2 { readonly centre: Vec2; readonly heading: number; readonly travel: number }

/** Poses already worked out per guide (guides are cached and never change, so the same inputs always give the same pose). */
const poseCache = new WeakMap<Guide, Map<string, Pose2>>();

/** Pose with `zone`'s anchor (optionally slid along the struck side by `slide` m) on point q, aligned with the guide. */
function poseAtAnchor(g: Guide, dims: VehicleDims, zone: Zone, q: Vec2, slide: number): Pose2 {
  let table = poseCache.get(g);
  if (!table) { table = new Map(); poseCache.set(g, table); }
  const key = `${dims.lengthM},${dims.widthM},${zone},${q.x},${q.y},${slide}`;
  const hit = table.get(key);
  if (hit) return hit;
  const pose = poseAtAnchorFresh(g, dims, zone, q, slide);
  if (table.size >= GUIDE_CACHE_MAX) table.clear();
  table.set(key, pose);
  return pose;
}

function poseAtAnchorFresh(g: Guide, dims: VehicleDims, zone: Zone, q: Vec2, slide: number): Pose2 {
  const an = zoneAnchorLocal(zone, dims.lengthM, dims.widthM);
  let a = an.a, b = an.b;
  if (slide !== 0) { if (isSideZone(zone)) a += slide; else if (zone === "front" || zone === "rear") b += slide; }
  let est = q;
  let heading = 0, travel = 0;
  for (let i = 0; i < 4; i++) {
    travel = pointAt(g.poly, project(g.poly, est).s).bearing;
    heading = travel + g.facingOffset;
    est = sub(sub(q, mul(fwdOf(heading), a)), mul(rightOf(heading), b));
  }
  return { centre: est, heading, travel };
}

const boxOf = (p: Pose2, dims: VehicleDims): Vec2[] => boxCorners(p.centre.x, p.centre.y, p.heading, dims.lengthM, dims.widthM);

/** Offsets to try when sliding a contact along a side, nearest first. */
function slideOffsets(zone: Zone, dims: VehicleDims): number[] {
  const extent = isSideZone(zone) ? dims.lengthM / 2 - 0.3 : zone === "front" || zone === "rear" ? dims.widthM / 2 - 0.1 : 0;
  const out = [0];
  for (let d = 0.25; d <= extent + 1e-9; d += 0.25) out.push(d, -d);
  return out;
}

/** Where the bodies touch and how: smallest-overlap axis oriented from b to a. */
function contactBetween(a: Pose2, da: VehicleDims, b: Pose2, db: VehicleDims): { depth: number; normal: Vec2 } {
  const s = satDepth(boxOf(a, da), boxOf(b, db));
  return { depth: s.depth, normal: s.axis };
}

/**
 * The edge of a box whose outward normal points most along `dir`, with that normal. Edges that tie (within 1e-9, as at exactly 45 degrees,
 * where a nose is equally square to two faces) go to the one whose outward normal is nearest `prefer`, the direction of the marked
 * zone's face, so the choice never rests on the last binary digit of a sine.
 */
function faceFacing(box: readonly Vec2[], dir: Vec2, prefer?: Vec2): { p: Vec2; q: Vec2; out: Vec2 } {
  const c = { x: box.reduce((s, v) => s + v.x, 0) / box.length, y: box.reduce((s, v) => s + v.y, 0) / box.length };
  let best: { p: Vec2; q: Vec2; out: Vec2 } | null = null, bestScore = -Infinity, bestPrefer = -Infinity;
  for (let i = 0; i < box.length; i++) {
    const p = box[i]!, q = box[(i + 1) % box.length]!;
    const e = unit(sub(q, p));
    let out = { x: e.y, y: -e.x };
    if (dot(out, sub({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }, c)) < 0) out = { x: -out.x, y: -out.y };
    const score = dot(out, dir), pref = prefer ? dot(out, prefer) : 0;
    if (score > bestScore + 1e-9 || (Math.abs(score - bestScore) <= 1e-9 && pref > bestPrefer)) { bestScore = Math.max(score, bestScore); bestPrefer = pref; best = { p, q, out }; }
  }
  return best!;
}

/** The direction the marked zone's face points, in the world, for a pose (a unit vector). */
const zoneOut = (p: Pose2, zone: Zone): Vec2 => fwdOf(p.heading + ZONE_ANGLE_RAD[zone]);

/**
 * Where the bodies really touch, as the MIDPOINT of the contact patch's two ends measured along the contact face, then the two ends.
 * The patch is the stretch of the two touching faces where they overlap along the face AND are within CRUSH_BAND_M of each other
 * (nearer than a crumple zone's depth). Each point sits halfway between the two faces. For two faces that are square to each other
 * that is their whole overlap, so a degree or two of tilt does not move it (the area centre of a thin wedge, as an earlier version
 * used, jumped toward a corner). As the tilt grows, the band shrinks the patch to the end where the faces are close, and in the
 * limit to the corner that touches: the patch moves continuously, never to a stretch that is not touching anything.
 * With no such stretch (corner against corner), the overlap of the two bodies each grown evenly by 3 cm is used instead, with
 * the ends found as the middle of the vertices tied for the extreme. Falls back to the contact point when there is no patch.
 */
function contactPatch(a: Pose2, da: VehicleDims, b: Pose2, db: VehicleDims, normal: Vec2, fallback: Vec2, preferA?: Vec2, preferB?: Vec2): Vec2[] {
  const t = { x: -normal.y, y: normal.x };
  const fa = faceFacing(boxOf(a, da), mul(normal, -1), preferA), fb = faceFacing(boxOf(b, db), normal, preferB);
  const ta0 = dot(fa.p, t), ta1 = dot(fa.q, t), tb0 = dot(fb.p, t), tb1 = dot(fb.q, t);
  const lo = Math.max(Math.min(ta0, ta1), Math.min(tb0, tb1)), hi = Math.min(Math.max(ta0, ta1), Math.max(tb0, tb1));
  if (hi >= lo && Math.abs(ta1 - ta0) > 1e-9 && Math.abs(tb1 - tb0) > 1e-9) {
    const heightAt = (f: { p: Vec2; q: Vec2 }, t0: number, t1: number, at: number): number => {
      const u = (at - t0) / (t1 - t0);
      return (1 - u) * dot(f.p, normal) + u * dot(f.q, normal);
    };
    // The distance between the faces along the normal (a's face minus b's: negative = inside each other) is linear along the overlap.
    const gap = (at: number): number => heightAt(fa, ta0, ta1, at) - heightAt(fb, tb0, tb1, at);
    const g0 = gap(lo), g1 = gap(hi), dg = g1 - g0;
    let sLo = 0, sHi = 1;
    if (Math.abs(dg) < 1e-12) { if (Math.abs(g0) > CRUSH_BAND_M) sHi = -1; }
    else {
      const s1 = (-CRUSH_BAND_M - g0) / dg, s2 = (CRUSH_BAND_M - g0) / dg;
      sLo = Math.max(0, Math.min(s1, s2)); sHi = Math.min(1, Math.max(s1, s2));
    }
    if (sLo <= sHi) {
      const cLo = lo + sLo * (hi - lo), cHi = lo + sHi * (hi - lo);
      const point = (at: number): Vec2 => add(mul(t, at), mul(normal, (heightAt(fa, ta0, ta1, at) + heightAt(fb, tb0, tb1, at)) / 2));
      return [point((cLo + cHi) / 2), point(cLo), point(cHi)];
    }
  }
  const grown = (p: Pose2, d: VehicleDims): Vec2[] => boxCorners(p.centre.x, p.centre.y, p.heading, d.lengthM + 2 * PATCH_GROW_M, d.widthM + 2 * PATCH_GROW_M);
  const poly = clipConvex(grown(a, da), grown(b, db));
  if (poly.length < 3) return [fallback];
  const ts = poly.map((p) => dot(p, t));
  const tMin = Math.min(...ts), tMax = Math.max(...ts);
  const meanOf = (at: number): Vec2 => {
    const near = poly.filter((_, i) => Math.abs(ts[i]! - at) <= 1e-9);
    return { x: near.reduce((s, p) => s + p.x, 0) / near.length, y: near.reduce((s, p) => s + p.y, 0) / near.length };
  };
  const lo2 = meanOf(tMin), hi2 = meanOf(tMax);
  return [{ x: (lo2.x + hi2.x) / 2, y: (lo2.y + hi2.y) / 2 }, lo2, hi2];
}
/**
 * Two faces count as touching where they are within this distance of each other, m: roughly how far a side hit presses a door in
 * (about 0.3 m in a 20 mph side impact). UNVERIFIED: a typical figure, not a measurement, and it needs a primary source (for example
 * NHTSA side-impact crush profiles) before release. A smaller band makes the contact swing faster as the tilt grows.
 */
const CRUSH_BAND_M = 0.3;

/**
 * Do these two poses, with the contact point at the zone anchors (no sliding), already count as a fit? Up to the overlap tolerance, yes.
 * Beyond it, still yes while each body's face toward the contact normal is still the face of its marked zone, which is any tilt under
 * 45 degrees: a corner of the tilted face is then just leading, `touch` backs the bodies off along the normal, and the contact stays
 * where the claimant put it. Without this the contact jumped sideways, or the zone fallback swapped a zone, as soon as the tilt put a
 * corner more than the tolerance into the other body. SQUARE_PUSH_MAX_M is only a sanity bound on the back-off, not a model limit.
 */
function fitsWithoutSliding(a: Pose2, da: VehicleDims, b: Pose2, db: VehicleDims, preferA?: Vec2, preferB?: Vec2): boolean {
  const c = contactBetween(a, da, b, db);
  if (c.depth <= OVERLAP_TOLERANCE_M) return true;
  if (c.depth > SQUARE_PUSH_MAX_M) return false;
  const fa = faceFacing(boxOf(a, da), mul(c.normal, -1), preferA), fb = faceFacing(boxOf(b, db), c.normal, preferB);
  const minCos = Math.cos(Math.PI / 4) - 1e-9;
  return -dot(fa.out, c.normal) >= minCos && dot(fb.out, c.normal) >= minCos;
}
/** Sanity bound on how far a pair is backed off along the normal, m. */
const SQUARE_PUSH_MAX_M = 1.5;
const PATCH_GROW_M = 0.03;
/** Placement leaves two touching bodies at most this deep in each other (the tests allow a gap of at most 2 cm): exactly touching, to a few mm. */
const TOUCH_TOL_M = 0.002;
/** At the impact a vehicle's centre may sit this much further off its path than half its road's width plus half its own, m. */
const OFF_PATH_SLACK_M = 0.75;

// ---------------------------------------------------------------- choosing the impact point

/** Where two guides meet: their crossing nearest the pin; else (parallel or shared lane) the midpoint of the pin's projections. */
export function contactPoint(ga: Guide, gb: Guide, pin: Vec2): Vec2 {
  const xs = polyCrossings(ga.poly, gb.poly).sort((p, q) => dist(p.point, pin) - dist(q.point, pin));
  if (xs[0]) return xs[0].point;
  const pa = project(ga.poly, pin).point, pb = project(gb.poly, pin).point;
  return { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 };
}

/**
 * Two vehicles going the same way on one path (a rear-end: their paths don't cross) meet where the pin is; but where their road
 * ends just ahead (a street ending at a T, a lot's edge), the one in front would stick out past the end of the road. Then the
 * meeting point moves back along the path until a body fits before the end (the longer of the two), as a vehicle stopped at the
 * end of a street. Any other pair, or a road that runs on, keeps the point.
 */
function backFromRoadEnd(a: Drafted, b: Drafted, q: Vec2): Vec2 {
  if (polyCrossings(a.guide.poly, b.guide.poly).length) return q;
  if (angleBetween(pointAt(a.guide.poly, project(a.guide.poly, q).s).bearing, pointAt(b.guide.poly, project(b.guide.poly, q).s).bearing) > toRad(45)) return q;
  const need = Math.max(a.dims.lengthM, b.dims.lengthM);
  let best = q;
  for (const d of [a, b]) {
    if (!d.guide.endsThere || !d.guide.moving) continue;
    const poly = d.guide.poly;
    const s = project(poly, best).s;
    if (poly.length - s < need) best = pointAt(poly, Math.max(0, poly.length - need)).p;
  }
  return best;
}

/** First point where a guide, in travel order, enters a vehicle's body. */
function firstEntry(g: Guide, body: Vec2[], pin: Vec2): Vec2 | null {
  let best: { s: number; p: Vec2 } | null = null;
  for (let j = 0; j < 4; j++) {
    const edge = makePoly([body[j]!, body[(j + 1) % 4]!]);
    for (const x of polyCrossings(g.poly, edge)) {
      if (dist(x.point, pin) > 60) continue;
      if (!best || x.sA < best.s) best = { s: x.sA, p: x.point };
    }
  }
  return best?.p ?? null;
}

// ---------------------------------------------------------------- closing speed

interface Drafted { readonly veh: SceneVehicle; readonly guide: Guide; readonly dims: VehicleDims }

/** Entered-speed velocity vectors of every vehicle in one low/middle/high case (used to rank who can hit whom). */
function velocities(bodies: readonly { veh: SceneVehicle; travel: number }[], key: CaseKey): Vec2[] {
  return bodies.map((b) => mul(fwdOf(b.travel), speedCases(b.veh)[key]));
}

/** What a closing test needs to know about each vehicle. */
export interface MotionBody { readonly veh: SceneVehicle; readonly travelBearingRad: number; readonly moving: boolean }

/** Why a crash can't happen at the speeds given. */
export type ClosingFailure =
  | { readonly kind: "none-moving" }
  /** The vehicles are actually separating along the contact normal at the impact. */
  | { readonly kind: "apart"; readonly a: VehicleId; readonly b: VehicleId }
  /** Not separating, but not closing either: `mover` is the slower moving vehicle. It moves toward `other` ("too-slow") or not at all along the contact ("not-moving-toward"). */
  | { readonly kind: "not-moving-toward" | "too-slow"; readonly mover: VehicleId; readonly other: VehicleId; readonly speedMps: number };

/**
 * Do all the contacts close, at the velocities the vehicles have AT THE IMPACT (the typed speeds)? `enteredMps`
 * is each vehicle's typed speed. Null = they do. The kind is chosen by the physics, not by speed bands:
 * "apart" only when the normal relative speed is actually negative; otherwise the slower moving vehicle is named,
 * as not moving toward the other (it has no motion along the contact) or too slow to reach it.
 */
export function closingFailure(bodies: readonly MotionBody[], contacts: readonly Contact[], enteredMps: readonly number[]): ClosingFailure | null {
  if (!bodies.some((b, i) => b.moving && enteredMps[i]! > 1e-9)) return { kind: "none-moving" };
  const speed = bodies.map((b, i) => (b.moving ? enteredMps[i]! : 0));
  const vel = bodies.map((b, i) => mul(fwdOf(b.travelBearingRad), speed[i]!));
  const index = new Map(bodies.map((b, i) => [b.veh.id, i]));
  for (const c of contacts) {
    const ia = index.get(c.a)!, ib = index.get(c.b)!;
    const vr = sub(vel[ia]!, vel[ib]!);
    const closing = -(vr.x * c.normal.x + vr.y * c.normal.y); // positive = approaching along the normal (it points from b into a)
    if (closing > MIN_CLOSING_MPS) continue;
    if (closing < -1e-9) return { kind: "apart", a: c.a, b: c.b };
    // Decide from the geometry. A moving vehicle with a component of velocity toward the other along the contact
    // (a goes toward b along -normal, b goes toward a along +normal) is the one that is too slow to reach it.
    // Only when no vehicle has any such component is the slower mover (a parked one isn't expected to move; on a
    // tie, the later letter) named as not moving toward the other at all.
    const toward = (i: number): number => (i === ia ? Math.max(0, -(vel[ia]!.x * c.normal.x + vel[ia]!.y * c.normal.y)) : Math.max(0, vel[ib]!.x * c.normal.x + vel[ib]!.y * c.normal.y));
    const movers = [ia, ib].filter((i) => bodies[i]!.moving);
    const closers = movers.filter((i) => toward(i) > 1e-9).sort((x, y) => toward(x) - toward(y) || y - x);
    const m = closers[0] ?? [...movers].sort((x, y) => speed[x]! - speed[y]! || y - x)[0]!;
    const o = m === ia ? ib : ia;
    return { kind: closers.length ? "too-slow" : "not-moving-toward", mover: bodies[m]!.veh.id, other: bodies[o]!.veh.id, speedMps: speed[m]! };
  }
  return null;
}

/** The plain message for a closing failure. */
export function closingMessage(f: ClosingFailure, allIds: readonly VehicleId[]): PlainMessage {
  switch (f.kind) {
    case "none-moving": return msg("nothing-moving", NOTHING_MOVING_TEXT, allIds);
    case "not-moving-toward":
      return msg("not-moving-toward", `${letterName(f.mover)} isn't moving toward ${vehicleWord(f.other)} at ${formatSpeedExact(f.speedMps)}. Check ${f.mover}'s speed or what it was doing.`, [f.mover, f.other]);
    case "too-slow":
      return msg("too-slow", `${letterName(f.mover)} is moving too slowly to reach ${vehicleWord(f.other)}. Check ${f.mover}'s speed.`, [f.mover, f.other]);
    case "apart":
      return msg("moving-apart", `${letterName(f.a)} and ${vehicleWord(f.b)} would already have been moving apart before they touched, so they could not have hit each other this way. Check the speeds, the directions, or which vehicle was ahead.`, [f.a, f.b]);
  }
}

// ---------------------------------------------------------------- the main routine

interface Slot {
  centre?: Vec2;
  heading?: number;
  travel?: number;
  zone?: Zone;
}

const zonesText = (a: SceneVehicle, b: SceneVehicle): string =>
  `${letterName(a.id)} is marked hit on the ${ZONE_WORDS[a.zone]} and ${vehicleWord(b.id)} on the ${ZONE_WORDS[b.zone]}, but with the way each was going those two parts can't be touching at the same spot. Check which side of each vehicle was hit, or which way each was going.`;

export interface PlaceOptions {
  /** Refuse scenes where the contacts don't close at the impact. The simulation turns this off and checks every speed it scans itself. Default true. */
  readonly checkClosing?: boolean;
  /** Use the entered zones exactly and refuse when they can't touch (the checks use this to judge a hit). Default false: the nearest zone that works is used and reported in `zonesUsed`. */
  readonly exactZones?: boolean;
  /** At most this many other-zone placements are tried by the fallback (default MAX_ZONE_TRIALS). The one-tap fixer asks for fewer. */
  readonly maxZoneTrials?: number;
}

/** Is there a road (or a parking lot) within ROAD_REACH_M of the pin? Remembered per network and pin (the answer never changes). */
const nearPinCache = new WeakMap<RoadNetwork, Map<string, boolean>>();
function roadNearPin(roads: RoadNetwork, pin: Vec2): boolean {
  let table = nearPinCache.get(roads);
  if (!table) { table = new Map(); nearPinCache.set(roads, table); }
  const key = `${pin.x},${pin.y}`;
  const hit = table.get(key);
  if (hit !== undefined) return hit;
  const near = roads.ways.some((w) => project(makePoly(w.centerline), pin).dist <= ROAD_REACH_M) || roads.parking.some((p) => pointInRing(pin, p.outline));
  if (table.size >= GUIDE_CACHE_MAX) table.clear();
  table.set(key, near);
  return near;
}

/** The full placement, with guides and contacts, for the simulation and the checks. */
function placeCore(scene: Scene, rawRoads: RoadNetwork | null, pin: Vec2, opts: PlaceOptions = {}, preCleaned = false): DetailedOutcome {
  // Do not trust the input: check the scene and the pin here, whoever called.
  const invalid = [...validateScene(scene), ...validatePin(pin)];
  if (invalid.length) return fail(...invalid);
  const roads = rawRoads ? (preCleaned ? rawRoads : cleanNet(rawRoads)) : null;
  // With road data given there has to be a road (or a parking lot) near the pin; open water and a coastline are not drivable.
  if (roads && !roadNearPin(roads, pin)) return fail(msg("no-road", NO_ROAD_TEXT, scene.vehicles.map((v) => v.id)));
  const vs = scene.vehicles;
  const drafts: Drafted[] = [];
  const errors: PlainMessage[] = [];
  for (const v of vs) {
    const g = buildGuide(v, roads, pin);
    if (isMessage(g)) errors.push(g); else drafts.push({ veh: v, guide: g, dims: dimsOf(v) });
  }
  if (errors.length) return fail(...errors);
  if (vs.length < 2) return fail(msg("too-few-vehicles", "Add at least two vehicles to see a crash.", vs.map((v) => v.id)));
  if (vs.every((v) => v.action === "parked" || speedCases(v).hi <= 0)) return fail(msg("nothing-moving", NOTHING_MOVING_TEXT, vs.map((v) => v.id)));

  // Approximate travel bearings at the pin (to rank who can hit whom before anyone is placed).
  const pinTravel = drafts.map((d) => pointAt(d.guide.poly, project(d.guide.poly, pin).s).bearing);
  const slots: Slot[] = drafts.map(() => ({}));
  const contacts: Contact[] = [];
  const n = drafts.length;

  const bodyBox = (i: number): Vec2[] => {
    const s = slots[i]!;
    return boxCorners(s.centre!.x, s.centre!.y, s.heading!, drafts[i]!.dims.lengthM, drafts[i]!.dims.widthM);
  };
  const asPose = (i: number): Pose2 => ({ centre: slots[i]!.centre!, heading: slots[i]!.heading!, travel: slots[i]!.travel! });
  const setSlot = (i: number, p: Pose2, zone: Zone) => { slots[i] = { centre: p.centre, heading: p.heading, travel: p.travel, zone }; };
  const placed = (i: number) => slots[i]!.centre !== undefined;
  const clearOfOthers = (p: Pose2, i: number, except: number): boolean => {
    const box = boxOf(p, drafts[i]!.dims);
    for (let j = 0; j < n; j++) {
      if (j === i || j === except || !placed(j)) continue;
      if (satDepth(box, bodyBox(j)).depth > OVERLAP_TOLERANCE_M) return false;
    }
    return true;
  };
  /**
   * Make a recorded pair exactly touching at t = 0 by moving the bodies along the contact normal (the smallest-overlap axis, from j into i):
   * both bodies share the correction (each moves half of the overlap, or half of the gap) when neither had a partner yet; with
   * `movedOnly` set, only that body moves, by the full correction, so a body that already touches its first partner is not pushed
   * into it. Repeated a few times because the smallest-overlap axis can change as the bodies move apart.
   */
  const touch = (i: number, j: number, movedOnly: "i" | "j" | null): void => {
    const shareI = movedOnly === "i" ? 1 : movedOnly === "j" ? 0 : 0.5;
    for (let pass = 0; pass < 6; pass++) {
      const c = contactBetween(asPose(i), drafts[i]!.dims, asPose(j), drafts[j]!.dims);
      if (Math.abs(c.depth) <= TOUCH_TOL_M / 4) return;
      const si = slots[i]!, sj = slots[j]!;
      slots[i] = { ...si, centre: add(si.centre!, mul(c.normal, c.depth * shareI)) };
      slots[j] = { ...sj, centre: sub(sj.centre!, mul(c.normal, c.depth * (1 - shareI))) };
    }
  };
  /** `attached` is the body just placed against an already placed partner (it alone is moved to touch); omit it when both are new. */
  const record = (i: number, j: number, point: Vec2, attached?: "i" | "j") => {
    touch(i, j, attached ?? null);
    const c = contactBetween(asPose(i), drafts[i]!.dims, asPose(j), drafts[j]!.dims);
    contacts.push({ a: drafts[i]!.veh.id, b: drafts[j]!.veh.id, pointM: point, normal: c.normal, patchM: contactPatch(asPose(i), drafts[i]!.dims, asPose(j), drafts[j]!.dims, c.normal, point, zoneOut(asPose(i), slots[i]!.zone!), zoneOut(asPose(j), slots[j]!.zone!)) });
  };

  /** Both marked zones, anchors on q, sliding along the struck sides if the bodies would overlap. */
  const placeMutual = (i: number, j: number, q: Vec2): boolean => {
    const di = drafts[i]!, dj = drafts[j]!;
    const combos: Array<[number, number]> = [];
    for (const a of slideOffsets(di.veh.zone, di.dims)) for (const b of slideOffsets(dj.veh.zone, dj.dims)) combos.push([a, b]);
    combos.sort((x, y) => Math.abs(x[0]) + Math.abs(x[1]) - (Math.abs(y[0]) + Math.abs(y[1])));
    for (const [sa, sb] of combos) {
      const pa = poseAtAnchor(di.guide, di.dims, di.veh.zone, q, sa), pb = poseAtAnchor(dj.guide, dj.dims, dj.veh.zone, q, sb);
      const depth = contactBetween(pa, di.dims, pb, dj.dims).depth;
      const ok = sa === 0 && sb === 0 ? fitsWithoutSliding(pa, di.dims, pb, dj.dims, zoneOut(pa, di.veh.zone), zoneOut(pb, dj.veh.zone)) : Math.abs(depth) <= OVERLAP_TOLERANCE_M;
      if (!ok) continue;
      if (!clearOfOthers(pa, i, j) || !clearOfOthers(pb, j, i)) continue;
      setSlot(i, pa, di.veh.zone); setSlot(j, pb, dj.veh.zone);
      record(i, j, q);
      return true;
    }
    return false;
  };

  /** Put vehicle k's face that points at the (placed) partner on q: its marked zone if `marked`, else the best-facing free zone. */
  const attach = (k: number, m: number, q: Vec2, marked: boolean): boolean => {
    const dk = drafts[k]!;
    if (marked) {
      for (const s of slideOffsets(dk.veh.zone, dk.dims)) {
        const p = poseAtAnchor(dk.guide, dk.dims, dk.veh.zone, q, s);
        const depth = contactBetween(p, dk.dims, asPose(m), drafts[m]!.dims).depth;
        const ok = s === 0 ? fitsWithoutSliding(p, dk.dims, asPose(m), drafts[m]!.dims, zoneOut(p, dk.veh.zone), zoneOut(asPose(m), slots[m]!.zone!)) : Math.abs(depth) <= OVERLAP_TOLERANCE_M;
        if (ok && clearOfOthers(p, k, m)) { setSlot(k, p, dk.veh.zone); record(k, m, q, "i"); return true; }
      }
      return false;
    }
    const toPartner = bearingOf(sub(slots[m]!.centre!, q));
    const options: Array<{ zone: Zone; pose: Pose2; score: number }> = [];
    for (const zone of Object.keys(ZONE_ANGLE_RAD) as Zone[]) {
      const p = poseAtAnchor(dk.guide, dk.dims, zone, q, 0);
      const depth = contactBetween(p, dk.dims, asPose(m), drafts[m]!.dims).depth;
      if (depth > OVERLAP_TOLERANCE_M || !clearOfOthers(p, k, m)) continue;
      options.push({ zone, pose: p, score: angleBetween(ZONE_ANGLE_RAD[zone], toPartner - p.heading) });
    }
    options.sort((x, y) => x.score - y.score);
    const best = options[0];
    if (!best) return false;
    setSlot(k, best.pose, best.zone);
    record(k, m, q, "i");
    return true;
  };

  if (n === 2) {
    const q = backFromRoadEnd(drafts[0]!, drafts[1]!, contactPoint(drafts[0]!.guide, drafts[1]!.guide, pin));
    if (!placeMutual(0, 1, q)) return fail(msg("zones-cannot-touch", zonesText(vs[0]!, vs[1]!), [vs[0]!.id, vs[1]!.id]));
  } else {
    // Who can hit whose marked zone? Judge by relative motion in any of the low/middle/high cases.
    const feasible = (i: number, j: number): boolean => {
      const zi = drafts[i]!.veh.zone;
      const heading = pinTravel[i]! + drafts[i]!.guide.facingOffset;
      for (const key of CASES) {
        const v = velocities(drafts.map((d, k) => ({ veh: d.veh, travel: pinTravel[k]! })), key);
        const w = sub(v[j]!, v[i]!);
        if (norm(w) < 0.3) continue;
        if (angleBetween(bearingOf(mul(w, -1)) - heading, ZONE_ANGLE_RAD[zi]) < zoneToleranceRad(zi) - 1e-9) return true;
      }
      return false;
    };
    const feas = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => i !== j && feasible(i, j)));
    const midV = velocities(drafts.map((d, k) => ({ veh: d.veh, travel: pinTravel[k]! })), "mid");
    /** Where i and j could meet: their crossing, or (same lane) the shared projection; parallel lanes never meet. */
    const meetMemo = new Map<number, Vec2 | null>();
    const meet = (i: number, j: number): Vec2 | null => {
      const k = i * n + j;
      if (meetMemo.has(k)) return meetMemo.get(k)!;
      const gi = drafts[i]!.guide, gj = drafts[j]!.guide;
      const at = polyCrossings(gi.poly, gj.poly).length === 0 && dist(project(gi.poly, pin).point, project(gj.poly, pin).point) > 1 ? null : contactPoint(gi, gj, pin);
      meetMemo.set(k, at);
      return at;
    };
    const ptsMemo = new Map<number, Vec2>();
    const pts = (i: number, j: number): Vec2 => {
      const k = i * n + j;
      let at = ptsMemo.get(k);
      if (!at) { at = meet(i, j) ?? contactPoint(drafts[i]!.guide, drafts[j]!.guide, pin); ptsMemo.set(k, at); }
      return at;
    };
    const hitter: number[] = [];
    for (let i = 0; i < n; i++) {
      const cands: Array<{ j: number; d: number; rel: number; mutual: number }> = [];
      for (let j = 0; j < n; j++) {
        const at = feas[i]![j] ? meet(i, j) : null;
        if (!at) continue;
        cands.push({ j, d: Math.round(dist(at, pin) / 0.05), rel: Math.round(norm(sub(midV[j]!, midV[i]!)) / 0.01), mutual: feas[j]![i] ? 0 : 1 });
      }
      cands.sort((a, b) => a.d - b.d || a.rel - b.rel || a.mutual - b.mutual || a.j - b.j);
      hitter.push(cands[0]?.j ?? -1);
    }
    // Contact pairs (unordered), with which zones are "used" by the pair.
    const pairs = new Map<string, { i: number; j: number; usedI: boolean; usedJ: boolean }>();
    for (let i = 0; i < n; i++) {
      const j = hitter[i]!;
      if (j < 0) continue;
      const lo = Math.min(i, j), hi = Math.max(i, j);
      const e = pairs.get(`${lo}-${hi}`) ?? { i: lo, j: hi, usedI: false, usedJ: false };
      if (i === lo) e.usedI = true; else e.usedJ = true;
      pairs.set(`${lo}-${hi}`, e);
    }
    const touched = new Set<number>();
    for (const p of pairs.values()) { touched.add(p.i); touched.add(p.j); }
    const lonely = drafts.map((_, i) => i).filter((i) => !touched.has(i));
    if (lonely.length) {
      return fail(...lonely.map((i) => msg("zones-cannot-touch",
        `${letterName(drafts[i]!.veh.id)} is marked hit on the ${ZONE_WORDS[drafts[i]!.veh.zone]}, but none of the other vehicles was going the right way to hit it there. Check which side was hit, or which way each vehicle was going.`,
        [drafts[i]!.veh.id])));
    }
    const ordered = [...pairs.values()].sort((a, b) => dist(pts(a.i, a.j), pin) - dist(pts(b.i, b.j), pin) || a.i - b.i || a.j - b.j);
    for (const p of ordered) {
      const q = pts(p.i, p.j);
      const names: [VehicleId, VehicleId] = [drafts[p.i]!.veh.id, drafts[p.j]!.veh.id];
      const bad = () => fail(msg("zones-cannot-touch", zonesText(drafts[p.i]!.veh, drafts[p.j]!.veh), [...names]));
      if (placed(p.i) && placed(p.j)) continue;
      if (!placed(p.i) && !placed(p.j)) {
        if (p.usedI && p.usedJ) { if (!placeMutual(p.i, p.j, q)) return bad(); continue; }
        const [target, attacker] = p.usedI ? [p.i, p.j] : [p.j, p.i];
        const dt = drafts[target]!;
        const tp = poseAtAnchor(dt.guide, dt.dims, dt.veh.zone, q, 0);
        setSlot(target, tp, dt.veh.zone);
        if (!attach(attacker, target, q, false)) { slots[target] = {}; return bad(); }
        continue;
      }
      const [m, k] = placed(p.i) ? [p.i, p.j] : [p.j, p.i];
      const used = k === p.i ? p.usedI : p.usedJ;
      const entry = firstEntry(drafts[k]!.guide, bodyBox(m), pin);
      if (!entry || !attach(k, m, entry, used)) return bad();
    }
  }

  // Everything must be clear of everything else at t = 0, and every contact must be one the speeds allow.
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (satDepth(bodyBox(i), bodyBox(j)).depth > OVERLAP_TOLERANCE_M) {
        // Two vehicles that do not touch each other but overlap: backing a new vehicle off to touch its partner pushed it into a third.
        // The zone fallback tries other zones for this; the message below is what is left when none of them places the vehicles clear.
        const touching = contacts.some((c) => (c.a === drafts[i]!.veh.id && c.b === drafts[j]!.veh.id) || (c.a === drafts[j]!.veh.id && c.b === drafts[i]!.veh.id));
        if (!touching) {
          return fail(msg("bodies-overlap", `${letterName(drafts[i]!.veh.id)} and ${vehicleWord(drafts[j]!.veh.id)} would be inside each other at the moment of the crash, so the picture can't be drawn. Check the directions or where each vehicle was hit.`, [drafts[i]!.veh.id, drafts[j]!.veh.id]));
        }
        return fail(msg("zones-cannot-touch", zonesText(drafts[i]!.veh, drafts[j]!.veh), [drafts[i]!.veh.id, drafts[j]!.veh.id]));
      }
    }
  }
  // Every vehicle touches the other where its own path is: a body pulled off its lane to reach the other (two carriageways of a
  // divided road, parallel lanes far apart) would be drawn where it never drove. Inside a parking lot a vehicle may be anywhere
  // in the lot (in a stall beside the aisle).
  for (let i = 0; i < n; i++) {
    const g = drafts[i]!.guide;
    const off = project(g.poly, slots[i]!.centre!).dist;
    if (off <= g.halfRoadM + drafts[i]!.dims.widthM / 2 + OFF_PATH_SLACK_M) continue;
    if (roads?.parking.some((lot) => pointInRing(slots[i]!.centre!, lot.outline))) continue;
    const other = contacts.find((c) => c.a === drafts[i]!.veh.id || c.b === drafts[i]!.veh.id);
    const partner = other ? (other.a === drafts[i]!.veh.id ? other.b : other.a) : drafts[(i + 1) % n]!.veh.id;
    return fail(msg("paths-dont-meet", `${letterName(drafts[i]!.veh.id)} and ${vehicleWord(partner)} are on paths that don't meet near the pin, so they couldn't have touched there. Check the directions and lanes.`, [drafts[i]!.veh.id, partner]));
  }
  if (opts.checkClosing !== false) {
    const motion: MotionBody[] = drafts.map((d, i) => ({ veh: d.veh, travelBearingRad: slots[i]!.travel!, moving: d.guide.moving }));
    const fails = CASES.map((key) => closingFailure(motion, contacts, drafts.map((d) => speedCases(d.veh)[key])));
    // Any of the low, middle and high speeds may explain the hit; if none does, say why for the middle one.
    if (fails.every((f) => f !== null)) return fail(closingMessage(fails[CASES.indexOf("mid")]!, vs.map((v) => v.id)));
  }

  const bodies: PlacedBody[] = drafts.map((d, i) => ({
    id: d.veh.id, veh: d.veh, dims: d.dims, guide: d.guide, centre: slots[i]!.centre!, headingRad: slots[i]!.heading!,
    travelBearingRad: slots[i]!.travel!, zone: slots[i]!.zone!,
  }));
  return { ok: true, value: { impactPointM: contacts[0]!.pointM, bodies, contacts, zonesUsed: [] } };
}

/**
 * Errors that a different zone could cure: the entered zones can't touch at the same spot, or backing a vehicle off to touch pushes it
 * into a third (another zone often places it clear). Closing errors (moving apart, not moving
 * toward, too slow) are about the speeds and directions, not the zones: swapping zones there would turn "A was hit by B" into "A hit B",
 * so they stay refusals.
 */
const ZONE_FIXABLE = new Set(["zones-cannot-touch", "bodies-overlap"]);
const MAX_ZONE_TRIALS = 400;
const ALL_ZONES = Object.keys(ZONE_ANGLE_RAD) as Zone[];

/**
 * The full placement. A warning never blocks (DESIGN section 18), so when the entered zones can't touch, or can't close, the vehicles
 * are placed with the nearest zones that do and the change is reported in `zonesUsed`: the vehicles named in the errors try the other
 * zones, nearest to the entered one first (one vehicle changing before two), and the first that places and closes wins. Only scenes
 * where no zone works (no road, vehicles that can't meet at all) are refused.
 */
export function placeDetailed(scene: Scene, rawRoads: RoadNetwork | null, pin: Vec2, opts: PlaceOptions = {}): DetailedOutcome {
  if (opts.exactZones) return placeCore(scene, rawRoads, pin, opts);
  const probe = placeCore(scene, rawRoads, pin, { ...opts, checkClosing: true });
  if (probe.ok) return probe;
  const asked = (): DetailedOutcome => (opts.checkClosing === false ? placeCore(scene, rawRoads, pin, opts) : probe);
  if (!probe.errors.every((e) => ZONE_FIXABLE.has(e.code))) return asked();
  const ids = [...new Set(probe.errors.flatMap((e) => e.vehicleIds))].filter((id) => scene.vehicles.some((v) => v.id === id));
  if (ids.length === 0) return asked();
  const zoneDist = (a: Zone, b: Zone): number => angleBetween(ZONE_ANGLE_RAD[a], ZONE_ANGLE_RAD[b]);
  const cleaned = rawRoads ? cleanNet(rawRoads) : null; // once, not once per trial
  /**
   * Where the other vehicle comes from, as a bearing relative to this vehicle's front: the way from the meeting point back along the
   * other's path. The face that actually meets is the zone nearest to that. Null when it can't be told (the other is not moving).
   */
  const comesFrom = (id: VehicleId): number | null => {
    const v = scene.vehicles.find((x) => x.id === id)!;
    const other = scene.vehicles.find((x) => x.id !== id && ids.includes(x.id)) ?? scene.vehicles.find((x) => x.id !== id);
    if (!other) return null;
    const g = buildGuide(v, cleaned, pin), go = buildGuide(other, cleaned, pin);
    if (isMessage(g) || isMessage(go) || !go.moving) return null;
    const q = contactPoint(g, go, pin);
    const back = pointAt(go.poly, Math.max(0, project(go.poly, q).s - 8)).p;
    if (dist(back, q) < 1) return null;
    const heading = pointAt(g.poly, project(g.poly, q).s).bearing + g.facingOffset;
    return bearingOf(sub(back, q)) - heading;
  };
  const approach = new Map(ids.map((id) => [id, comesFrom(id)] as const));
  /** How well a zone fits what was entered: the angle to where the other comes from, else the angle to the zone entered. */
  const fit = (id: VehicleId, z: Zone): number => {
    const a = approach.get(id);
    return a === null || a === undefined ? zoneDist(enteredOf(id), z) : angleBetween(ZONE_ANGLE_RAD[z], a);
  };
  type Trial = { readonly cost: number; readonly zones: ReadonlyArray<readonly [VehicleId, Zone]> };
  const trials: Trial[] = [];
  const options = (id: VehicleId): Zone[] => {
    const entered = scene.vehicles.find((v) => v.id === id)!.zone;
    return ALL_ZONES.filter((z) => z !== entered);
  };
  const enteredOf = (id: VehicleId): Zone => scene.vehicles.find((v) => v.id === id)!.zone;
  for (const id of ids) for (const z of options(id)) trials.push({ cost: fit(id, z), zones: [[id, z]] });
  for (let a = 0; a < ids.length; a++) for (let b = a + 1; b < ids.length; b++) {
    for (const za of options(ids[a]!)) for (const zb of options(ids[b]!)) {
      trials.push({ cost: fit(ids[a]!, za) + fit(ids[b]!, zb), zones: [[ids[a]!, za], [ids[b]!, zb]] });
    }
  }
  // One vehicle changing before two (the claimant is usually wrong about one side), the zone that faces where the other comes from first; then scene order, so the choice is the same every time.
  trials.sort((x, y) => x.zones.length - y.zones.length || x.cost - y.cost);
  for (const t of trials.slice(0, Math.min(MAX_ZONE_TRIALS, opts.maxZoneTrials ?? MAX_ZONE_TRIALS))) {
    const swap = new Map(t.zones);
    const trialScene: Scene = { ...scene, vehicles: scene.vehicles.map((v) => (swap.has(v.id) ? { ...v, zone: swap.get(v.id)! } : v)) };
    const r = placeCore(trialScene, cleaned, pin, { ...opts, checkClosing: true }, true);
    if (!r.ok) continue;
    const original = new Map(scene.vehicles.map((v) => [v.id, v] as const));
    return {
      ok: true,
      value: {
        ...r.value,
        bodies: r.value.bodies.map((b) => ({ ...b, veh: original.get(b.id) ?? b.veh })),
        zonesUsed: t.zones.map(([id, used]) => ({ id, entered: enteredOf(id), used })),
      },
    };
  }
  return asked();
}

/** One hit side another vehicle could reach, and how squarely that vehicle comes at it (radians off the side's centre). */
export interface FacingZone {
  readonly zone: Zone;
  readonly off: number;
  /** The vehicle that meets it most squarely. */
  readonly by: VehicleId;
  /** Every vehicle that could reach it, in scene order. */
  readonly from: readonly VehicleId[];
}

/**
 * For the one-tap fixer: for each vehicle (scene order), the hit sides some other vehicle could reach given how each was
 * going, most squarely met first. It is the test the placement uses to match three or four vehicles (the other's approach,
 * relative to this vehicle at the pin, within the side's tolerance at the low, middle or high speeds; for three or four,
 * paths that meet), so a side not listed can't be hit there. Null when a vehicle has no usable path. Cheap: no placing.
 */
export function zonesFacing(scene: Scene, rawRoads: RoadNetwork | null, pin: Vec2): Array<readonly FacingZone[]> | null {
  const roads = rawRoads ? cleanNet(rawRoads) : null;
  const guides: Guide[] = [];
  for (const v of scene.vehicles) {
    const g = buildGuide(v, roads, pin);
    if (isMessage(g)) return null;
    guides.push(g);
  }
  const n = guides.length;
  const pinTravel = guides.map((g) => pointAt(g.poly, project(g.poly, pin).s).bearing);
  const meets = (i: number, j: number): boolean =>
    n === 2 || polyCrossings(guides[i]!.poly, guides[j]!.poly).length > 0 || dist(project(guides[i]!.poly, pin).point, project(guides[j]!.poly, pin).point) <= 1;
  const vel = CASES.map((key) => velocities(scene.vehicles.map((veh, k) => ({ veh, travel: pinTravel[k]! })), key));
  return scene.vehicles.map((_, i) => {
    const heading = pinTravel[i]! + guides[i]!.facingOffset;
    const best = new Map<Zone, FacingZone>();
    for (let j = 0; j < n; j++) {
      if (j === i || !meets(i, j)) continue;
      for (const v of vel) {
        const w = sub(v[j]!, v[i]!);
        if (norm(w) < 0.3) continue;
        const rel = bearingOf(mul(w, -1)) - heading;
        for (const z of ALL_ZONES) {
          const off = angleBetween(rel, ZONE_ANGLE_RAD[z]);
          if (off >= zoneToleranceRad(z) - 1e-9) continue;
          const prev = best.get(z), id = scene.vehicles[j]!.id;
          const from = prev ? (prev.from.includes(id) ? prev.from : [...prev.from, id]) : [id];
          if (!prev || off < prev.off - 1e-12) best.set(z, { zone: z, off, by: id, from });
          else if (from !== prev.from) best.set(z, { ...prev, from });
        }
      }
    }
    return [...best.values()].sort((a, b) => a.off - b.off || ALL_ZONES.indexOf(a.zone) - ALL_ZONES.indexOf(b.zone));
  });
}

/** A vehicle's own path that doesn't fit the roads at the pin: the Vehicles step blocks on these and offers one-tap fixes. */
export const ROAD_FIT_CODES: ReadonlySet<string> = new Set(["off-road-direction", "no-road-to-turn-from"]);

/**
 * Each vehicle whose direction doesn't fit the roads at the pin (it follows no road there, or turns where no road leads into
 * the turn), in scene order: what the picture would refuse to draw. Empty with no road data, with no road near the pin (that
 * is the pin's problem, said on Review with "move the pin"), or for a scene the physics can't read. Never throws.
 */
export function roadFitProblems(scene: Scene, rawRoads: RoadNetwork | null): PlainMessage[] {
  try {
    if (!rawRoads || rawRoads.ways.length === 0 || validateScene(scene).length) return [];
    const roads = cleanNet(rawRoads);
    const pin = toLocal(roads.frame, { lat: scene.location.lat, lon: scene.location.lon });
    if (validatePin(pin).length || !roadNearPin(roads, pin)) return [];
    const out: PlainMessage[] = [];
    for (const v of scene.vehicles) {
      const g = buildGuide(v, roads, pin);
      if (isMessage(g) && ROAD_FIT_CODES.has(g.code)) out.push(g);
    }
    return out;
  } catch {
    return [];
  }
}

/** Snap each vehicle to a lane and place it at impact (see the plan's lane-snapping section). Roads null = flat template. */
export function placeVehicles(scene: Scene, roads: RoadNetwork | null, pin: Vec2): PlacementOutcome {
  let r: DetailedOutcome;
  try { r = placeDetailed(scene, roads, pin); } catch { return fail(cannotWorkOut()); }
  if (!r.ok) return r;
  const { bodies, impactPointM } = r.value;
  return {
    ok: true,
    impactPointM,
    vehicles: bodies.map((b) => ({
      id: b.id,
      path: b.guide.moving ? { roadId: b.guide.roadId, laneIndex: b.guide.laneIndex, points: b.guide.poly.pts } : null,
      impactPose: { xM: b.centre.x, yM: b.centre.y, headingRad: wrap2Pi(b.headingRad), speedMps: speedCases(b.veh).mid },
    })),
  };
}
