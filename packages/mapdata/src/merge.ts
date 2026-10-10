// Joining the pieces OSM splits one street into.
//
// Two ways join when they have the same name (or, if unnamed, the same ref), the same kind and
// one-way-ness, compatible refs (equal, or missing on one side: OSM often tags only some pieces
// of a numbered route) and meet at an end node where exactly two same-name ways end. The fork
// test counts every way of that name, whatever its kind or one-way value, so a node where a
// one-way pair and a two-way road meet is a fork and nothing joins there.
//
// One-way ways join head-to-tail only. Three further guards keep divided roads and loops apart:
//  - two ways that share BOTH end nodes never join (that would close a loop, e.g. the two
//    opposite one-way carriageways of a short street);
//  - a join that turns more than 100 degrees is a hairpin (a U-turn between carriageways), not
//    a continuation, and is refused;
//  - a join whose result starts and ends at the same node is refused.
//
// Further conditions for a join:
//  - the ways agree on lanes, lanes:forward/backward, width and maxspeed (a road that changes from
//    3/2 lanes to 2/3 lanes is two RoadWays, because RoadWay has one lane count);
//  - a route ref is not carried past a node where another street takes that ref (NH 101A turns
//    from Main Street onto Canal Street, so a ref-less Main Street piece beyond that node is not
//    NH 101A).
// Unnamed, un-ref'd ways (service roads, aisles) are never joined.
import type { RoadKind, Vec2 } from "@csd/core";

/**
 * One original OSM way inside a merged road. Lane counts are relative to the merged centerline.
 * Only ways with the same lanes, direction split, lane width and speed limit are merged, so every
 * part of one merged road carries the same values.
 */
export interface Part {
  readonly osmWayId: number;
  readonly lanesForward: number;
  readonly lanesBackward: number;
  readonly laneWidthM: number;
  readonly speedLimitMph: number | null;
}

export interface Segment {
  readonly name: string | null;
  readonly ref: string | null;
  readonly kind: RoadKind;
  readonly oneway: boolean;
  readonly pts: readonly Vec2[];
  /** Identity of the first and last node (OSM node id, or coordinates when ids are missing). */
  readonly startKey: string;
  readonly endKey: string;
  readonly parts: readonly Part[];
}

const nameKey = (s: Segment) => s.name ?? `ref:${s.ref ?? ""}`;
const mergeable = (s: Segment) => s.name !== null || s.ref !== null;
/** Largest turn, in degrees, between the two ways at a join for it to count as the same street continuing. */
export const MAX_JOIN_TURN_DEG = 100;
const HEADING_LOOKBACK_M = 8;

function flip(s: Segment): Segment {
  return {
    ...s,
    pts: [...s.pts].reverse(),
    startKey: s.endKey,
    endKey: s.startKey,
    parts: s.parts.map((p) => ({ ...p, lanesForward: p.lanesBackward, lanesBackward: p.lanesForward })),
  };
}

/** `a` then `b`, where a.endKey === b.startKey. */
function concat(a: Segment, b: Segment): Segment {
  return {
    ...a,
    ref: a.ref ?? b.ref,
    pts: [...a.pts, ...b.pts.slice(1)],
    endKey: b.endKey,
    parts: [...a.parts, ...b.parts],
  };
}

/** Direction (unit vector) of travel through the junction end of `pts`, measured over the last few metres. */
function headingAt(pts: readonly Vec2[], atEnd: boolean): Vec2 {
  const at = atEnd ? pts.length - 1 : 0;
  const step = atEnd ? -1 : 1;
  const j = pts[at] as Vec2;
  let far = pts[at + step] as Vec2;
  for (let i = at + step; i >= 0 && i < pts.length; i += step) {
    far = pts[i] as Vec2;
    if (Math.hypot(far.x - j.x, far.y - j.y) >= HEADING_LOOKBACK_M) break;
  }
  const dx = atEnd ? j.x - far.x : far.x - j.x;
  const dy = atEnd ? j.y - far.y : far.y - j.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: dx / len, y: dy / len };
}

/** Degrees the street turns when `a` continues into `b` (a.end meets b.start). */
function turnDeg(a: Segment, b: Segment): number {
  const h1 = headingAt(a.pts, true);
  const h2 = headingAt(b.pts, false);
  const dot = Math.max(-1, Math.min(1, h1.x * h2.x + h1.y * h2.y));
  return (Math.acos(dot) * 180) / Math.PI;
}

/** Ends of ways that carry a ref, by node: where each numbered route (and which street) stops or turns. */
type RefEnds = Map<string, { ref: string; name: string | null }[]>;

function sameRoadShape(a: Part, b: Part): boolean {
  return a.lanesForward === b.lanesForward && a.lanesBackward === b.lanesBackward
    && Math.abs(a.laneWidthM - b.laneWidthM) < 0.01 && a.speedLimitMph === b.speedLimitMph;
}

/** May `a` continue into `b` (a.end meets b.start)? */
function canContinue(a: Segment, b: Segment, refEnds: RefEnds): boolean {
  if (a.kind !== b.kind || a.oneway !== b.oneway) return false;
  if (!sameRoadShape(a.parts[0] as Part, b.parts[0] as Part)) return false;
  if (a.ref !== null && b.ref !== null && a.ref !== b.ref) return false; // two different routes
  if ((a.ref === null) !== (b.ref === null)) {
    const ref = a.ref ?? b.ref;
    // Another street takes this ref at the junction: the route turned off here.
    if ((refEnds.get(a.endKey) ?? []).some((e) => e.ref === ref && e.name !== a.name)) return false;
  }
  // Two ways that touch at both ends would close a loop.
  if (a.startKey === b.endKey || a.startKey === a.endKey || b.startKey === b.endKey) return false;
  return turnDeg(a, b) <= MAX_JOIN_TURN_DEG;
}

type End = { i: number; end: "start" | "end" };

/** Find one joinable pair among the ways of one name and return the new list, or null when none is left. */
function joinOnce(group: Segment[], refEnds: RefEnds): Segment[] | null {
  const ends = new Map<string, End[]>();
  group.forEach((s, i) => {
    for (const [end, key] of [["start", s.startKey], ["end", s.endKey]] as const) {
      const list = ends.get(key) ?? [];
      list.push({ i, end });
      ends.set(key, list);
    }
  });
  for (const list of ends.values()) {
    if (list.length !== 2) continue; // free end, or a fork / three-way junction of the same street
    const [p, q] = list as [End, End];
    if (p.i === q.i) continue; // a closed loop
    const a = group[p.i] as Segment;
    const b = group[q.i] as Segment;
    let merged: Segment | null = null;
    if (a.oneway && b.oneway) {
      // Direction is fixed: only (end → start) joins.
      if (p.end === "end" && q.end === "start" && canContinue(a, b, refEnds)) merged = concat(a, b);
      else if (q.end === "end" && p.end === "start" && canContinue(b, a, refEnds)) merged = concat(b, a);
    } else if (!a.oneway && !b.oneway) {
      const [first, second] =
        p.end === "end" && q.end === "start" ? [a, b]
        : p.end === "end" && q.end === "end" ? [a, flip(b)]
        : p.end === "start" && q.end === "start" ? [flip(a), b]
        : [b, a];
      if (canContinue(first, second, refEnds)) merged = concat(first, second);
    }
    if (merged) return [...group.filter((_, i) => i !== p.i && i !== q.i), merged];
  }
  return null;
}

/** Merge OSM segments of the same street; the result keeps input order of first appearance. */
export function mergeSegments(segments: readonly Segment[]): Segment[] {
  const out: Segment[] = [];
  const groups = new Map<string, Segment[]>();
  const refEnds: RefEnds = new Map();
  for (const s of segments) {
    if (s.ref !== null) {
      for (const key of [s.startKey, s.endKey]) refEnds.set(key, [...(refEnds.get(key) ?? []), { ref: s.ref, name: s.name }]);
    }
    if (!mergeable(s)) {
      out.push(s);
      continue;
    }
    const k = nameKey(s);
    const list = groups.get(k) ?? [];
    list.push(s);
    groups.set(k, list);
  }
  for (const group of groups.values()) {
    let current = group;
    for (;;) {
      const next = joinOnce(current, refEnds);
      if (next === null) break;
      current = next;
    }
    out.push(...current);
  }
  return out;
}
