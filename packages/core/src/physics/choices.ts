// "Which way was it going?": the choices the Vehicles step offers, from the roads at the pin (DESIGN.md section 5, step 2).
//
//  - Going straight, backing up or parked: each road at the pin, each way it can be driven ("northbound on Main Street",
//    "heading northwest on Willow Bend Road"; unnamed roads told apart by kind and place). At a single road that is its two
//    directions; same-direction and opposite-direction choices give the rear-end, head-on and sideswipe crashes.
//  - Turning left or right: each road it could turn onto, with the road it turns from ("from Park Street onto Main Street,
//    northbound"). Only turns a road at the pin leads into are offered.
//  - Out of a driveway or parking lot, on either side of each road at the pin (for going straight, backing and turning): its
//    path starts a short way off the road (DRIVEWAY_M), from a stop.
//  - In a parking lot: across the lot, north, east, south or west, as well as along its aisles.
//  - With no mapped roads at all: north, east, south or west, as a fallback, and said to be one.
// The physics draws every choice offered here along the roads (placement.ts); a choice it couldn't draw on a road is not offered.
import type { Vec2 } from "../contracts/geometry";
import type { RoadNetwork, RoadWay, TravelChoice } from "../contracts/roads";
import type { Action, SceneVehicle } from "../contracts/scene";
import { DRIVEWAY_WORDS, compassWord, goingWords, roadWords } from "../format";
import { makePoly, pointInRing, project, toDeg, toRad, wrap2Pi } from "./geo";
import { cleanNet, localBearing, streetName, streetsAtPin, wayById } from "./lanes";
import { buildGuide, turnFrom } from "./placement";

/** One choice in the direction list. `travel` is what picking it sets on the vehicle (with lane: null). */
export interface DirectionChoice {
  readonly kind: "road" | "turn" | "driveway" | "lot" | "compass";
  readonly label: string;
  readonly travel: Pick<SceneVehicle["travel"], "bearingDeg" | "roadId" | "roadName"> & { readonly roadDesc?: string; readonly fromDriveway?: true };
}

/** The list's own words for the compass fallback. */
export const COMPASS_FALLBACK_TEXT = "No mapped roads here, so pick a compass direction.";

const CARDINALS = [0, 90, 180, 270] as const;
/** A moving vehicle's direction is offered only with at least this much road behind the pin, m. */
const MIN_ROOM_M = 10;
/** No driveway is offered where the pin meets a road this close to a junction, m (a junction's mouth is no driveway). */
const DRIVEWAY_CLEAR_M = 15;
const ucFirst = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const travelOf = (c: TravelChoice): DirectionChoice["travel"] => ({
  bearingDeg: c.bearingDeg, roadId: c.roadId, roadName: c.roadName, ...(c.roadDesc ? { roadDesc: c.roadDesc } : {}),
});

/** What the turn's road is called: its name, else "the unnamed road". */
const fromWords = (w: RoadWay): string => streetName(w) ?? (w.kind === "parking_aisle" ? "the parking aisle" : "the unnamed road");

/**
 * The direction choices for a vehicle doing `action`, at the pin, in list order. Roads null (or none at the pin): N, E, S, W
 * (kind "compass", the fallback). Labels are sentence case.
 */
export function directionChoices(rawNet: RoadNetwork | null, pin: Vec2, action: Action): DirectionChoice[] {
  const net = rawNet ? cleanNet(rawNet) : null;
  const streets = net && net.ways.length ? streetsAtPin(net, pin) : null;
  const lot = net?.parking.find((p) => pointInRing(pin, p.outline));
  if (!streets || (streets.directions.length === 0 && !lot)) {
    return CARDINALS.map((b) => ({ kind: "compass", label: ucFirst(compassWord(b)), travel: { bearingDeg: b, roadId: null, roadName: null } }));
  }
  const out: DirectionChoice[] = [];
  const turning = action === "turn-left" || action === "turn-right";
  if (!turning) {
    for (const c of streets.directions) out.push({ kind: "road", label: ucFirst(c.label), travel: travelOf(c) });
  } else {
    const left = action === "turn-left";
    for (const c of streets.directions) {
      const from = turnFrom(net!, pin, c.roadId, toRad(c.bearingDeg), left);
      if (!from) continue;
      const onto = roadWords(c) ?? "the road";
      out.push({ kind: "turn", label: `From ${fromWords(from.way)} onto ${onto}, ${goingWords(c.bearingDeg)}`, travel: travelOf(c) });
    }
  }
  if (lot && action !== "turn-left" && action !== "turn-right") {
    for (const b of CARDINALS) out.push({ kind: "lot", label: `Across the parking lot, ${action === "parked" || action === "backing" ? "facing" : "heading"} ${compassWord(b)}`, travel: { bearingDeg: b, roadId: null, roadName: null } });
  }
  // In a lot "across the parking lot" stands for coming out of a space; a driveway is a way onto a road from beside it.
  if (action !== "parked" && !lot) out.push(...drivewayChoices(net!, pin, action, streets.directions, streets.legs.map((l) => l.junction)));
  // Only what the picture can draw on the roads is offered: a choice whose path the physics can't build here is left out.
  return out.filter((c) => drawable(net!, pin, action, c));
}

/** Does this choice give a vehicle doing `action` a path on the roads at the pin (no "follows no road", wrong way or such)? */
function drawable(net: RoadNetwork, pin: Vec2, action: Action, c: DirectionChoice): boolean {
  const v: SceneVehicle = {
    id: "A", role: "claimant", year: null, make: "", model: "", type: "car", typeSource: "manual", action,
    travel: { ...c.travel, lane: null }, speed: { kind: "known", mph: 0 }, braking: false, zone: "front",
  };
  const g = buildGuide(v, net, pin);
  if ("code" in g) return false;
  // A moving vehicle needs some road behind the pin to have come along (a street that starts right at the pin, such as the
  // way out of a roundabout drawn as one loop, has none): without MIN_ROOM_M it could only have crept from a stop there.
  return !g.moving || !g.startsThere || project(g.poly, pin).s >= MIN_ROOM_M;
}

/**
 * Out of a driveway or parking lot onto each road at the pin (its two nearest roads, unnamed ones as the list words them).
 * Straight across: from either side, heading across the road. Backing: facing away from the road on either side. Turning: onto
 * each way the road can be driven (the side it came from follows from the turn).
 */
/** Is that side of a closed road (a roundabout) its middle, where no driveway can be? Open roads have none. */
function inside(way: RoadWay, pin: Vec2, sideDeg: number): boolean {
  const pts = way.centerline;
  if (pts.length < 3 || Math.hypot(pts[0]!.x - pts[pts.length - 1]!.x, pts[0]!.y - pts[pts.length - 1]!.y) > 1) return false;
  const c = { x: pts.reduce((a, p) => a + p.x, 0) / pts.length, y: pts.reduce((a, p) => a + p.y, 0) / pts.length };
  const u = { x: Math.sin(toRad(sideDeg)), y: Math.cos(toRad(sideDeg)) };
  return (c.x - pin.x) * u.x + (c.y - pin.y) * u.y > 0;
}

function drivewayChoices(net: RoadNetwork, pin: Vec2, action: Action, directions: readonly TravelChoice[], junctions: readonly Vec2[]): DirectionChoice[] {
  const out: DirectionChoice[] = [];
  const seen = new Set<string>();
  const roads: TravelChoice[] = [];
  for (const d of directions) if (!seen.has(d.roadId) && roads.length < 2) { seen.add(d.roadId); roads.push(d); }
  for (const r of roads) {
    const way = wayById(net, r.roadId);
    if (!way) continue;
    // A driveway never opens into a junction: where the pin meets this road at (or next to) a junction, it has none.
    const foot = project(makePoly(way.centerline), pin).point;
    if (junctions.some((j) => Math.hypot(j.x - foot.x, j.y - foot.y) <= DRIVEWAY_CLEAR_M)) continue;
    const road = roadWords(r) ?? "the road";
    const base = { roadId: r.roadId, roadName: r.roadName, ...(r.roadDesc ? { roadDesc: r.roadDesc } : {}), fromDriveway: true as const };
    if (action === "turn-left" || action === "turn-right") {
      for (const d of directions.filter((x) => x.roadId === r.roadId)) {
        // The driveway is on the side the turn comes from: behind its approach (exit - 90 degrees for a left turn's, + 90 for a right's).
        const fromSide = d.bearingDeg + (action === "turn-left" ? -90 : 90);
        if (inside(way, pin, fromSide)) continue;
        out.push({ kind: "driveway", label: `Out of ${DRIVEWAY_WORDS} onto ${road}, ${goingWords(d.bearingDeg)}`, travel: { ...base, bearingDeg: d.bearingDeg } });
      }
      continue;
    }
    // The road's direction at the pin, and its two sides.
    const along = toDeg(wrap2Pi(localBearing(way, pin, true)));
    for (const side of [along + 90, along - 90]) {
      if (inside(way, pin, side)) continue;
      const sideDeg = toDeg(wrap2Pi(toRad(side)));
      const across = toDeg(wrap2Pi(toRad(side + 180)));
      const where = `on the ${compassWord(sideDeg)} side of ${road}`;
      out.push(action === "backing"
        ? { kind: "driveway", label: `Backing out of ${DRIVEWAY_WORDS} ${where}`, travel: { ...base, bearingDeg: sideDeg } }
        : { kind: "driveway", label: `Out of ${DRIVEWAY_WORDS} ${where}`, travel: { ...base, bearingDeg: across } });
    }
  }
  return out;
}
