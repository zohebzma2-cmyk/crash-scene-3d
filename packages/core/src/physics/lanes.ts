// Lane geometry and the streets at the pin. Right-hand traffic.
//
// Lanes of a direction are numbered from the RIGHT: laneIndex 0 is the rightmost
// lane for that direction. On a two-way road that is the lane farthest from the
// centerline, and the highest index is the leftmost, next to the centerline.
// Offsets, measured to the right of the direction of travel:
//   two-way road, N lanes in that direction: (N - 1/2 - i) * w
//   one-way road, N lanes (full width, centred on the way line): ((N - 1)/2 - i) * w
//
// One street is often several RoadWays (mapdata only merges pieces whose lanes, width
// and speed limit agree), meeting at shared end nodes. So:
//  - A street is its name, or its route ref when it has no name. Unnamed, un-ref'd ways
//    stand alone.
//  - lanePath() does not stop at the end of a piece. It chains the connected pieces of
//    the same street: backwards it takes the piece whose end node meets the current
//    piece's start, forwards the piece that starts where the current one ends. At a
//    fork it picks the straightest continuation (and never one that turns more than
//    100 degrees). It reaches CHAIN_REACH_M past each end of the starting piece, far
//    more than the approach window needs.
//  - The lane keeps its number counted from the right, clamped to the lane count of
//    each piece. When the lateral offset differs between pieces (the lane count
//    changes) it tapers linearly over LANE_TAPER_M metres, starting at the split
//    point, never as a step. Samples are at most 0.5 m apart inside a taper.
//  - streetsAtPin() lists a street once per direction, whichever pieces carry it on
//    either side of a junction; TravelChoice.roadId is the piece that carries the
//    vehicle into the pin.
import type { LanePath, Leg, RoadKind, RoadNetwork, RoadWay, StreetsAtPin, TravelChoice } from "../contracts/roads";
import type { Vec2 } from "../contracts/geometry";
import { LIMITS } from "../contracts/scene";
import { boundWord, travelLabel } from "../format";
import { FRICTION, MPH_TO_MPS } from "./constants";
import { approachFor, brakeDecel } from "./model";
import {
  add, angleBetween, bearingOf, dist, dot, makePoly, mul, pointAt, project, reversePts, sub, toDeg, toRad, unit, wrap2Pi,
} from "./geo";

/** Roads and junctions within this distance of the pin are "at the pin" (meters). */
export const NEAR_PIN_M = 25;
/**
 * How far a chained lane path reaches beyond each end of the piece it starts on, m: the longest approach there can
 * be (the fastest typed speed, braking on dry road, over the whole window) plus 50 m. Computed, not a fixed number.
 */
export const CHAIN_REACH_M = Math.ceil(approachFor(LIMITS.maxSpeedMph * MPH_TO_MPS, brakeDecel(FRICTION.dry)).distanceM + 50);
/** Length over which the lateral offset changes where the lane count changes, m. */
export const LANE_TAPER_M = 30;
const JOIN_M = 1.5;
/** Pieces meet when their end nodes are this close, m. */
const JOINT_M = 1.0;
const MAX_JOIN_TURN_RAD = toRad(100);
const HEADING_LOOKBACK_M = 8;
const TAPER_STEP_M = 0.5;

export const wayById = (net: RoadNetwork, id: string): RoadWay | undefined => net.ways.find((w) => w.id === id);

/** Consecutive points closer than this are one point (1 cm). */
const SAME_POINT_M = 0.01;
const cleaned = new WeakMap<RoadNetwork, RoadNetwork>();

/**
 * The network with every way made usable: consecutive duplicate points (within 1 cm) dropped, and ways
 * left with fewer than 2 distinct points removed (they have no direction). Memoised per network object;
 * the same object comes back when nothing needed fixing. Every public function in this file goes through it.
 */
export function cleanNet(net: RoadNetwork): RoadNetwork {
  const hit = cleaned.get(net);
  if (hit) return hit;
  let changed = false;
  const ways: RoadWay[] = [];
  for (const w of net.ways) {
    const pts: Vec2[] = [];
    for (const p of w.centerline) if (pts.length === 0 || dist(pts[pts.length - 1]!, p) > SAME_POINT_M) pts.push(p);
    if (pts.length < 2) { changed = true; continue; }
    if (pts.length !== w.centerline.length) { changed = true; ways.push({ ...w, centerline: pts }); } else ways.push(w);
  }
  const out = changed ? { ...net, ways } : net;
  cleaned.set(net, out);
  cleaned.set(out, out);
  return out;
}

/** The street a way belongs to: its name, else its route ref; null for unnamed, un-ref'd ways (never chained or grouped). */
export function streetKey(w: RoadWay): string | null {
  const name = w.name?.trim();
  if (name) return `n:${name.toLowerCase()}`;
  const ref = w.ref?.trim();
  return ref ? `r:${ref.toLowerCase()}` : null;
}
/** What to call the street: its name, else its ref. */
export const streetName = (w: RoadWay): string | null => w.name?.trim() || w.ref?.trim() || null;

/** Direction of the whole way: first point to last (falls back to the longest segment for loops). */
export function wayBearing(way: RoadWay): number {
  const pts = way.centerline;
  const chord = sub(pts[pts.length - 1]!, pts[0]!);
  if (Math.hypot(chord.x, chord.y) > 1) return bearingOf(chord);
  let best = 0, bestLen = -1;
  for (let i = 0; i + 1 < pts.length; i++) {
    const d = dist(pts[i]!, pts[i + 1]!);
    if (d > bestLen) { bestLen = d; best = bearingOf(sub(pts[i + 1]!, pts[i]!)); }
  }
  return best;
}

/** Number of lanes travelling in a direction (forward = along the centerline order). */
export function lanesIn(way: RoadWay, forward: boolean): number {
  if (way.oneway) return forward ? way.lanesForward : 0;
  return forward ? way.lanesForward : way.lanesBackward;
}

/** Meters to the right of the direction of travel for lane i. */
export function laneOffsetM(way: RoadWay, forward: boolean, i: number): number {
  const n = lanesIn(way, forward);
  return way.oneway ? ((n - 1) / 2 - i) * way.laneWidthM : (n - 0.5 - i) * way.laneWidthM;
}

// ---------------------------------------------------------------- chaining the pieces of one street

interface Oriented { readonly way: RoadWay; readonly forward: boolean; readonly pts: readonly Vec2[] }
const orient = (way: RoadWay, forward: boolean): Oriented => ({ way, forward, pts: forward ? way.centerline : reversePts(way.centerline) });
const lengthOf = (pts: readonly Vec2[]): number => makePoly(pts).length;

/** Unit direction of travel near the start (leaving) or end (arriving) of an oriented piece. */
function nodeHeading(pts: readonly Vec2[], atStart: boolean): Vec2 {
  const poly = makePoly(pts);
  const s = atStart ? Math.min(HEADING_LOOKBACK_M, poly.length) : Math.max(0, poly.length - HEADING_LOOKBACK_M);
  const a = atStart ? pts[0]! : pointAt(poly, s).p, b = atStart ? pointAt(poly, s).p : pts[pts.length - 1]!;
  return unit(sub(b, a));
}
const turnBetween = (arriving: Vec2, leaving: Vec2): number => Math.acos(Math.max(-1, Math.min(1, dot(arriving, leaving))));

/** The piece that continues `cur` backwards (ends where `cur` starts) or forwards (starts where `cur` ends): the straightest one. */
function neighbour(net: RoadNetwork, cur: Oriented, used: ReadonlySet<string>, upstream: boolean): Oriented | null {
  const key = streetKey(cur.way);
  if (!key) return null;
  const node = upstream ? cur.pts[0]! : cur.pts[cur.pts.length - 1]!;
  const mine = nodeHeading(cur.pts, upstream); // leaving (upstream case) or arriving (downstream case)
  let best: { o: Oriented; turn: number } | null = null;
  for (const w of net.ways) {
    if (w.id === cur.way.id || used.has(w.id) || streetKey(w) !== key) continue;
    for (const forward of [true, false]) {
      if (lanesIn(w, forward) <= 0) continue;
      const o = orient(w, forward);
      const meet = upstream ? o.pts[o.pts.length - 1]! : o.pts[0]!;
      if (dist(meet, node) > JOINT_M) continue;
      const theirs = nodeHeading(o.pts, !upstream);
      const turn = upstream ? turnBetween(theirs, mine) : turnBetween(mine, theirs);
      if (turn > MAX_JOIN_TURN_RAD) continue;
      if (!best || turn < best.turn - 1e-9) best = { o, turn };
    }
  }
  return best?.o ?? null;
}

function chainAround(net: RoadNetwork, way: RoadWay, forward: boolean, reachM: number): Oriented[] {
  const first = orient(way, forward);
  const back: Oriented[] = [];
  const ahead: Oriented[] = [];
  for (const [list, upstream] of [[back, true], [ahead, false]] as const) {
    // Each direction has its own budget and its own record of used pieces, so on a loop the way back
    // can't use up the way ahead.
    const used = new Set([way.id]);
    let cur = first, len = 0;
    for (let n = 0; n < net.ways.length && len < reachM; n++) {
      const nb = neighbour(net, cur, used, upstream);
      if (!nb) break;
      used.add(nb.way.id);
      if (upstream) list.unshift(nb); else list.push(nb);
      len += lengthOf(nb.pts);
      cur = nb;
    }
  }
  return [...back, first, ...ahead];
}

/**
 * Lane centerline through a chain of pieces, in travel order. `offsets[k]` is the lateral offset
 * (right of travel) on piece k; it tapers linearly over LANE_TAPER_M from each joint into the next piece.
 */
function chainLanePoints(chain: readonly Oriented[], offsets: readonly number[]): Vec2[] {
  // Reference line: the pieces end to end (a joint's start node is dropped; it is within JOINT_M of the previous end).
  const ref: Vec2[] = [];
  const jointAt: number[] = []; // index in `ref` where each piece after the first begins
  chain.forEach((piece, k) => {
    piece.pts.forEach((p, i) => {
      if (k > 0 && i === 0) { jointAt[k] = ref.length - 1; return; }
      if (ref.length && dist(ref[ref.length - 1]!, p) < 1e-9) return;
      ref.push(p);
    });
  });
  const poly = makePoly(ref);
  // Offset as a function of arc length: constant on a piece, linear over the taper after each joint.
  const ctrl: Array<[number, number]> = [[0, offsets[0]!]];
  for (let k = 1; k < chain.length; k++) {
    const j = poly.cum[jointAt[k]!]!;
    const end = k + 1 < chain.length ? poly.cum[jointAt[k + 1]!]! : poly.length;
    const taper = Math.min(LANE_TAPER_M, Math.max(end - j, 1e-6));
    ctrl.push([j, offsets[k - 1]!], [j + taper, offsets[k]!]);
  }
  ctrl.push([poly.length, offsets[offsets.length - 1]!]);
  const offsetAt = (s: number): number => {
    for (let i = 0; i + 1 < ctrl.length; i++) {
      const [s0, o0] = ctrl[i]!, [s1, o1] = ctrl[i + 1]!;
      if (s <= s1 + 1e-12) return s1 - s0 < 1e-12 ? o1 : o0 + ((o1 - o0) * (Math.max(s, s0) - s0)) / (s1 - s0);
    }
    return ctrl[ctrl.length - 1]![1];
  };
  // Samples: every reference vertex, plus a fine step wherever the offset is changing.
  const samples = new Set<number>(poly.cum);
  for (let i = 0; i + 1 < ctrl.length; i++) {
    const [s0, o0] = ctrl[i]!, [s1, o1] = ctrl[i + 1]!;
    if (Math.abs(o1 - o0) < 1e-9 || s1 - s0 < 1e-9) continue;
    const n = Math.ceil((s1 - s0) / TAPER_STEP_M);
    for (let k = 0; k <= n; k++) samples.add(s0 + ((s1 - s0) * k) / n);
  }
  const normals = (i: number): Vec2 => { const t = unit(sub(ref[i + 1]!, ref[i]!)); return { x: t.y, y: -t.x }; };
  const vertexIndex = new Map<number, number>(poly.cum.map((s, i) => [s, i]));
  const out: Vec2[] = [];
  for (const s of [...samples].sort((a, b) => a - b)) {
    const o = offsetAt(s);
    const vi = vertexIndex.get(s);
    let n: Vec2;
    if (vi !== undefined && vi > 0 && vi < ref.length - 1) {
      const n1 = normals(vi - 1), n2 = normals(vi), denom = 1 + dot(n1, n2);
      n = denom < 0.2 ? unit(add(n1, n2)) : mul(add(n1, n2), 1 / denom);
    } else if (vi === ref.length - 1) {
      n = normals(ref.length - 2);
    } else if (vi === 0) {
      n = normals(0);
    } else {
      let i = 0;
      while (i < ref.length - 2 && poly.cum[i + 1]! <= s) i++;
      n = normals(i);
    }
    const base = pointAt(poly, s).p;
    out.push(add(base, mul(n, o)));
  }
  return out;
}

/**
 * Lane centerline for travel with (forward) or against the way's point order, chained through the connected
 * pieces of the same street (see the header). Null if the starting piece has no such lane.
 */
export function chainedLane(net: RoadNetwork, way: RoadWay, forward: boolean, laneIndex: number): Vec2[] | null {
  const n = lanesIn(way, forward);
  if (!Number.isInteger(laneIndex) || laneIndex < 0 || laneIndex >= n) return null;
  const chain = chainAround(net, way, forward, CHAIN_REACH_M);
  const offsets = chain.map((p) => laneOffsetM(p.way, p.forward, Math.min(laneIndex, lanesIn(p.way, p.forward) - 1)));
  return chainLanePoints(chain, offsets);
}

/** Lane centerline of one piece alone (no chaining). Kept for callers that want just the piece. */
export function directedLanePoints(way: RoadWay, forward: boolean, laneIndex: number): Vec2[] | null {
  const n = lanesIn(way, forward);
  if (!Number.isInteger(laneIndex) || laneIndex < 0 || laneIndex >= n) return null;
  const o = orient(way, forward);
  return chainLanePoints([o], [laneOffsetM(way, forward, laneIndex)]);
}

/**
 * Lane centerline for travel along a road in a bearing; laneIndex 0 = rightmost for that direction. Right-hand traffic.
 * Chains connected pieces of the street. `near` (optional, normally the pin) says where to judge the direction: a way
 * that hooks or bends can run one way at the pin and, end to end, the other; without it the whole way's first-to-last
 * direction is used.
 */
export function lanePath(rawNet: RoadNetwork, roadId: string, bearingDeg: number, laneIndex: number, near?: Vec2): LanePath | null {
  const net = cleanNet(rawNet);
  const way = wayById(net, roadId);
  if (!way) return null;
  const forward = near ? goesForward(way, near, toRad(bearingDeg)) : angleBetween(toRad(bearingDeg), wayBearing(way)) <= Math.PI / 2 + 1e-9;
  const pts = chainedLane(net, way, forward, laneIndex);
  return pts ? { roadId: way.id, laneIndex, points: pts } : null;
}

/** Travel bearing (radians) of the way's local direction nearest to p, with (forward) or against its point order. */
export function localBearing(way: RoadWay, p: Vec2, forward: boolean): number {
  const poly = makePoly(way.centerline);
  const pr = project(poly, p);
  let i = 0;
  while (i < poly.pts.length - 2 && poly.cum[i + 1]! < pr.s - 1e-9) i++;
  const b = bearingOf(sub(poly.pts[i + 1]!, poly.pts[i]!));
  return forward ? b : b + Math.PI;
}

/** Is a vehicle travelling in `bearingRad` near p going with the way's point order? Judged on the local segment. */
export function goesForward(way: RoadWay, p: Vec2, bearingRad: number): boolean {
  return angleBetween(bearingRad, localBearing(way, p, true)) <= Math.PI / 2 + 1e-9;
}

// ---------------------------------------------------------------- streets at the pin

interface NearWay { readonly way: RoadWay; readonly dist: number; readonly s: number; readonly group: number }

/** Same street (name, else ref) and touching = one road: duplicate pieces of a street count once. */
function groupNearWays(ways: readonly { way: RoadWay; dist: number; s: number }[]): NearWay[] {
  const parent = ways.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const touches = (a: RoadWay, b: RoadWay): boolean => {
    const pb = makePoly(b.centerline), pa = makePoly(a.centerline);
    return a.centerline.some((v) => project(pb, v).dist < JOIN_M) || b.centerline.some((v) => project(pa, v).dist < JOIN_M);
  };
  for (let i = 0; i < ways.length; i++) {
    for (let j = i + 1; j < ways.length; j++) {
      const a = ways[i]!.way, b = ways[j]!.way;
      const ka = streetKey(a);
      if (ka !== null && ka === streetKey(b) && touches(a, b)) parent[find(j)] = find(i);
    }
  }
  return ways.map((w, i) => ({ ...w, group: find(i) }));
}

export function streetsAtPin(rawNet: RoadNetwork, pin: Vec2): StreetsAtPin {
  const net = cleanNet(rawNet);
  const near = net.ways
    .map((way) => { const pr = project(makePoly(way.centerline), pin); return { way, dist: pr.dist, s: pr.s }; })
    .filter((w) => w.dist <= NEAR_PIN_M)
    .sort((a, b) => a.dist - b.dist || a.way.id.localeCompare(b.way.id));
  const grouped = groupNearWays(near);
  const groupIds: number[] = [];
  for (const w of grouped) if (!groupIds.includes(w.group)) groupIds.push(w.group);

  const roads = groupIds.map((g) => {
    const rep = grouped.find((w) => w.group === g)!;
    return { roadId: rep.way.id, name: streetName(rep.way), distanceM: rep.dist };
  });

  // One choice per street and direction. The piece that carries the vehicle INTO the pin is the nearest piece;
  // where two pieces are equally near (the pin is at the split), the one the vehicle arrives on (its travel end is at the pin).
  const directions: TravelChoice[] = [];
  for (const g of groupIds) {
    const members = grouped.filter((w) => w.group === g);
    const nearest = members[0]!.dist;
    const cands: Array<{ way: RoadWay; bearing: number; progress: number }> = [];
    for (const m of members) {
      if (m.dist > nearest + 0.5) continue;
      const len = makePoly(m.way.centerline).length;
      for (const forward of [true, false]) {
        if (forward ? !(lanesIn(m.way, true) > 0 || m.way.oneway) : m.way.oneway || lanesIn(m.way, false) <= 0) continue;
        cands.push({ way: m.way, bearing: localBearing(m.way, pin, forward), progress: forward ? m.s : len - m.s });
      }
    }
    const byLabel = new Map<string, { way: RoadWay; bearing: number; progress: number }>();
    for (const c of cands) {
      const bound = boundWord(toDeg(wrap2Pi(c.bearing)));
      const prev = byLabel.get(bound);
      if (!prev || c.progress > prev.progress + 1e-9) byLabel.set(bound, c);
    }
    for (const c of cands) {
      const bearingDeg = toDeg(wrap2Pi(c.bearing));
      const bound = boundWord(bearingDeg);
      if (byLabel.get(bound) !== c) continue;
      byLabel.delete(bound);
      const name = streetName(c.way);
      directions.push({ roadId: c.way.id, roadName: name, roadDesc: null, bearingDeg, bound, label: travelLabel(bound, { roadName: name }) });
    }
  }
  // Unnamed roads are told apart by kind and place ("northbound on the parking aisle (west one)"), never by a made-up
  // name. Two pieces of the same unnamed road get the same words and so the same label: each label is kept once.
  const descs = unnamedDescriptions(grouped.filter((w) => streetName(w.way) === null), pin);
  const seen = new Set<string>();
  const unique: TravelChoice[] = [];
  for (const d of directions) {
    const roadDesc = d.roadName === null ? descs.get(d.roadId) ?? null : null;
    const label = travelLabel(d.bound, { roadName: d.roadName, roadDesc });
    if (seen.has(label)) continue;
    seen.add(label);
    unique.push({ ...d, roadDesc, label });
  }

  return { pin, roads, legs: legsNear(net, pin), directions: unique };
}

/** What an unnamed road is called in captions: its kind only. */
const UNNAMED_KIND: Partial<Record<RoadKind, string>> = { parking_aisle: "the parking aisle", service: "the unnamed service road" };
const unnamedKind = (k: RoadKind): string => UNNAMED_KIND[k] ?? "the unnamed road";
/** Pieces whose sideways offsets from the pin are this close are one road (meters). */
const SAME_LINE_M = 2;
/** …and whose axes are this close (degrees, either way along the road). */
const SAME_AXIS_DEG = 10;
const ORDINALS = ["nearest the pin", "second nearest the pin", "third nearest the pin", "fourth nearest the pin", "fifth nearest the pin", "sixth nearest the pin"];

/**
 * Words that tell unnamed roads at the pin apart, by way id: the kind ("the parking aisle"), and when several of that
 * kind run the same way (north–south or east–west at the pin), where each one sits: "(west one)", "(middle)", "(east
 * one)" for two or three side by side ("(south one)" … "(north one)" for east–west roads), or how near the pin it is
 * for more. Pieces of one road (the same sideways offset) share their words. Only what the map says: never a name.
 */
function unnamedDescriptions(ways: readonly NearWay[], pin: Vec2): Map<string, string> {
  const out = new Map<string, string>();
  const buckets = new Map<string, Array<{ id: string; offset: number; lean: number; dist: number }>>();
  for (const w of ways) {
    const poly = makePoly(w.way.centerline);
    const pr = project(poly, pin);
    const bearing = toDeg(wrap2Pi(localBearing(w.way, pin, true)));
    const ns = boundWord(bearing) === "northbound" || boundWord(bearing) === "southbound";
    const kind = unnamedKind(w.way.kind);
    const key = `${kind}|${ns ? "ns" : "ew"}`;
    const list = buckets.get(key) ?? [];
    // How far the road's line sits from the pin, sideways: measured to the line of the piece's nearest segment (not
    // its nearest point), so two pieces of one straight road split at a junction have the same offset wherever that
    // junction is. Signed west to east for a north–south road, south to north for an east–west one.
    let i = 0;
    while (i < poly.pts.length - 2 && poly.cum[i + 1]! < pr.s - 1e-9) i++;
    const a = poly.pts[i]!;
    const u = unit(sub(poly.pts[i + 1]!, a));
    let n = { x: u.y, y: -u.x };
    if ((ns && n.x < 0) || (!ns && n.y < 0)) n = { x: -n.x, y: -n.y };
    // How far its axis leans from due north (or due east), degrees, signed toward east (or north): -90 to 90.
    const lean = ns ? ((bearing + 90) % 180) - 90 : 90 - ((bearing % 180 + 180) % 180);
    list.push({ id: w.way.id, offset: dot(sub(a, pin), n), lean, dist: pr.dist });
    buckets.set(key, list);
  }
  for (const [key, list] of buckets) {
    const kind = key.slice(0, key.lastIndexOf("|"));
    const ns = key.endsWith("|ns");
    // West to east (south to north); roads that cross near the pin (a Y-fork: the same offset) by which way they lean.
    list.sort((a, b) => (Math.abs(a.offset - b.offset) <= SAME_LINE_M ? a.lean - b.lean : 0) || a.offset - b.offset);
    // Pieces of one road: the same axis (within SAME_AXIS_DEG) and the same sideways offset (within SAME_LINE_M). Two
    // roads through the pin at different angles both have offset 0 and stay two roads.
    const lines: Array<typeof list> = [];
    for (const r of list) {
      const last = lines[lines.length - 1];
      const prev = last?.[last.length - 1];
      if (last && prev && Math.abs(r.offset - prev.offset) <= SAME_LINE_M && Math.abs(r.lean - prev.lean) <= SAME_AXIS_DEG) last.push(r); else lines.push([r]);
    }
    const n = lines.length;
    const [lo, hi] = ns ? ["west one", "east one"] : ["south one", "north one"];
    const byNear = [...lines].sort((a, b) => Math.min(...a.map((r) => r.dist)) - Math.min(...b.map((r) => r.dist)));
    lines.forEach((line, i) => {
      const where = n === 1 ? null
        : n <= 3 ? (i === 0 ? lo : i === n - 1 ? hi : "middle")
        : ORDINALS[byNear.indexOf(line)] ?? `number ${byNear.indexOf(line) + 1} from the pin`;
      for (const r of line) out.set(r.id, where ? `${kind} (${where})` : kind);
    });
  }
  return out;
}

/** Split the roads at every junction within reach of the pin into legs with outward bearings. */
function legsNear(net: RoadNetwork, pin: Vec2): Leg[] {
  interface Vert { way: RoadWay; i: number; p: Vec2 }
  const verts: Vert[] = [];
  for (const way of net.ways) way.centerline.forEach((p, i) => { if (dist(p, pin) <= NEAR_PIN_M + JOIN_M) verts.push({ way, i, p }); });
  // Cluster vertices that sit on the same spot.
  const clusters: Vert[][] = [];
  for (const v of verts) {
    const c = clusters.find((cl) => cl.some((u) => dist(u.p, v.p) <= JOIN_M));
    if (c) c.push(v); else clusters.push([v]);
  }
  const legs: Leg[] = [];
  for (const cl of clusters) {
    const j = { x: cl.reduce((s, v) => s + v.p.x, 0) / cl.length, y: cl.reduce((s, v) => s + v.p.y, 0) / cl.length };
    if (dist(j, pin) > NEAR_PIN_M) continue;
    const found: Leg[] = [];
    for (const { way, i } of cl) {
      const pts = way.centerline;
      for (const k of [i - 1, i + 1]) {
        if (k < 0 || k >= pts.length) continue;
        // Skip degenerate zero-length neighbours.
        let kk = k;
        while (kk >= 0 && kk < pts.length && dist(pts[kk]!, j) < 1e-6) kk += kk < i ? -1 : 1;
        if (kk < 0 || kk >= pts.length) continue;
        found.push({ roadId: way.id, name: streetName(way), outwardBearingDeg: toDeg(wrap2Pi(bearingOf(sub(pts[kk]!, j)))), junction: j });
      }
    }
    const roadKeys = new Set(cl.map((v) => streetKey(v.way) ?? v.way.id));
    if (roadKeys.size >= 2 || found.length >= 3) legs.push(...found);
  }
  return legs;
}
