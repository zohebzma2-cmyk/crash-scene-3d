// Overpass JSON → RoadNetwork. Pure; no fetching.
import type { Building, LocalFrame, ParkingArea, RoadKind, RoadNetwork, RoadWay, Vec2 } from "@csd/core";
import { enuAbout, signedArea } from "./enu";
import { mergeSegments, type Part, type Segment } from "./merge";
import { osmWays, parseCount, parseLengthM, parseSpeedMph, type OsmWay } from "./osm";
import { parseFeatures } from "./features";

export const OSM_ATTRIBUTION = "© OpenStreetMap contributors (ODbL)";

const DEFAULT_LANE_WIDTH_M = 3.5;
/** Tagged widths ÷ lanes outside this range are almost certainly tagging errors (shoulders, medians). */
const LANE_WIDTH_RANGE_M = [2.5, 4.5] as const;
const DEFAULT_BUILDING_HEIGHT_M = 6;
const LEVEL_HEIGHT_M = 3;

const KINDS: Readonly<Record<string, RoadKind>> = {
  motorway: "motorway", motorway_link: "motorway",
  trunk: "trunk", trunk_link: "trunk",
  primary: "primary", primary_link: "primary",
  secondary: "secondary", secondary_link: "secondary",
  tertiary: "tertiary", tertiary_link: "tertiary",
  unclassified: "unclassified", residential: "residential", living_street: "residential",
  service: "service",
};

function kindOf(way: OsmWay): RoadKind | null {
  const hw = way.tags.highway;
  if (hw === undefined) return null;
  const kind = KINDS[hw];
  if (kind === undefined) return null; // footway, path, steps, track … are not drivable
  if (kind === "service" && way.tags.service === "parking_aisle") return "parking_aisle";
  return kind;
}

/** oneway: "yes" | "-1" | "no" | absent. Motorways and roundabouts are one-way unless tagged otherwise. */
function onewayOf(way: OsmWay): "forward" | "reverse" | "no" {
  const v = way.tags.oneway?.toLowerCase();
  if (v === "yes" || v === "true" || v === "1") return "forward";
  if (v === "-1" || v === "reverse") return "reverse";
  if (v === "no" || v === "false" || v === "0") return "no";
  const hw = way.tags.highway;
  if (hw === "motorway" || hw === "motorway_link" || way.tags.junction === "roundabout" || way.tags.junction === "circular") return "forward";
  return "no";
}

/**
 * Lanes in the direction of the (possibly reversed) way, and against it.
 *
 * Limitation: OSM `lanes` counts every lane, including a centre two-way turn lane
 * (`lanes:both_ways`), but RoadWay has no field for it. With only a total, an odd count gives the
 * extra lane to the forward side, so a 5-lane road with a centre turn lane reads as 3 forward / 2
 * backward. When `lanes:forward` and `lanes:backward` are both tagged they are used as they are
 * (the centre lane is then left out of the totals). Placement should treat odd totals as
 * approximate.
 */
function lanesOf(way: OsmWay, oneway: boolean): { forward: number; backward: number } {
  const total = parseCount(way.tags.lanes);
  const f = parseCount(way.tags["lanes:forward"]);
  const b = parseCount(way.tags["lanes:backward"]);
  if (oneway) return { forward: Math.max(1, total ?? f ?? 1), backward: 0 };
  if (f !== null && b !== null) return { forward: f, backward: b };
  if (total !== null && total > 0) {
    if (f !== null) return { forward: f, backward: Math.max(0, total - f) };
    if (b !== null) return { forward: Math.max(0, total - b), backward: b };
    // Only a total: split it; an odd lane (centre turn lane) goes to the forward side.
    if (total === 1) return { forward: 1, backward: 1 };
    return { forward: Math.ceil(total / 2), backward: Math.floor(total / 2) };
  }
  if (f !== null) return { forward: f, backward: 1 };
  if (b !== null) return { forward: 1, backward: b };
  return { forward: 1, backward: 1 };
}

function laneWidthOf(way: OsmWay, totalLanes: number): number {
  const w = parseLengthM(way.tags.width);
  if (w === null || totalLanes <= 0) return DEFAULT_LANE_WIDTH_M;
  const per = w / totalLanes;
  return Math.min(LANE_WIDTH_RANGE_M[1], Math.max(LANE_WIDTH_RANGE_M[0], per));
}

function endKey(way: OsmWay, i: number): string {
  const n = way.nodes[i];
  if (n !== undefined) return `n${n}`;
  const g = way.geometry[i] as { lat: number; lon: number };
  return `c${g.lat},${g.lon}`;
}

/**
 * Clip a polyline to the square [-r, r]² (Liang–Barsky per segment). A way that
 * leaves and re-enters comes back as several pieces.
 */
export function clipPolyline(pts: readonly Vec2[], r: number): Vec2[][] {
  const pieces: Vec2[][] = [];
  let cur: Vec2[] = [];
  const flush = () => {
    if (cur.length >= 2) pieces.push(cur);
    cur = [];
  };
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i] as Vec2;
    const b = pts[i + 1] as Vec2;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    let t0 = 0;
    let t1 = 1;
    let inside = true;
    for (const [p, q] of [[-dx, a.x + r], [dx, r - a.x], [-dy, a.y + r], [dy, r - a.y]] as const) {
      if (p === 0) {
        if (q < 0) inside = false;
      } else {
        const t = q / p;
        if (p < 0) t0 = Math.max(t0, t);
        else t1 = Math.min(t1, t);
      }
    }
    if (!inside || t0 >= t1) {
      flush();
      continue;
    }
    const p0 = { x: a.x + t0 * dx, y: a.y + t0 * dy };
    const p1 = { x: a.x + t1 * dx, y: a.y + t1 * dy };
    if (cur.length === 0) cur.push(p0);
    else if (t0 > 0) {
      flush();
      cur.push(p0);
    }
    cur.push(p1);
    if (t1 < 1) flush();
  }
  flush();
  return pieces;
}

function ringOf(way: OsmWay, enu: ReturnType<typeof enuAbout>): Vec2[] | null {
  const g = way.geometry;
  if (g.length < 4) return null;
  const first = g[0] as { lat: number; lon: number };
  const last = g[g.length - 1] as { lat: number; lon: number };
  if (first.lat !== last.lat || first.lon !== last.lon) return null; // not a closed area
  const ring = g.slice(0, -1).map((p) => enu.toLocal(p));
  return signedArea(ring) < 0 ? ring.reverse() : ring;
}

function buildingHeight(tags: Readonly<Record<string, string>>): Pick<Building, "heightM" | "heightSource"> {
  const h = parseLengthM(tags.height);
  if (h !== null) return { heightM: h, heightSource: "height-tag" };
  const levels = parseCount(tags["building:levels"]);
  if (levels !== null && levels > 0) return { heightM: levels * LEVEL_HEIGHT_M, heightSource: "levels-tag" };
  return { heightM: DEFAULT_BUILDING_HEIGHT_M, heightSource: "default" };
}

/**
 * Parse an Overpass JSON response (`out body geom`) into a RoadNetwork in the given frame.
 *
 * - Roads: drivable highways only. OSM splits one street into many ways, so ways with the same
 *   name, ref, kind and direction that share an end node are merged into one RoadWay (OSM ids
 *   kept). One-way ways join head-to-tail only, and joins that would close a loop or turn more
 *   than 100 degrees are refused, so opposite carriageways are not joined into a U. Unnamed
 *   ways are never merged.
 * - Ways are merged only when their lanes, lanes:forward/backward, width and maxspeed agree, so a
 *   RoadWay's single lane count is true along its whole length.
 * - Centerlines are clipped to the square of half-size `radiusM` around the origin (Overpass
 *   `around` returns whole ways, which can run for kilometres).
 * - Building and parking outlines are returned as open rings (the closing point is not
 *   repeated), counter-clockwise.
 */
export function parseOverpass(json: unknown, frame: LocalFrame, radiusM: number, fetchedAt: string): RoadNetwork {
  // Validated upstream, but a NaN here would quietly turn every road into NaN points.
  const { lat, lon } = frame.origin;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new Error("The map area has no usable pin position.");
  if (!Number.isFinite(radiusM) || radiusM <= 0) throw new Error("The map area has no usable size.");
  const enu = enuAbout(frame.origin);
  const segments: Segment[] = [];
  const buildings: Building[] = [];
  const parking: ParkingArea[] = [];

  for (const way of osmWays(json)) {
    const kind = kindOf(way);
    if (kind !== null) {
      if (way.geometry.length < 2) continue;
      const dir = onewayOf(way);
      const oneway = dir !== "no";
      const reverse = dir === "reverse";
      const geometry = reverse ? [...way.geometry].reverse() : way.geometry;
      const pts = geometry.map((p) => enu.toLocal(p));
      const lanes = lanesOf(way, oneway);
      const part: Part = {
        osmWayId: way.id,
        lanesForward: lanes.forward,
        lanesBackward: lanes.backward,
        laneWidthM: laneWidthOf(way, lanes.forward + lanes.backward),
        speedLimitMph: parseSpeedMph(way.tags.maxspeed) ?? parseSpeedMph(way.tags["maxspeed:forward"]),
      };
      const startIdx = reverse ? way.geometry.length - 1 : 0;
      const endIdx = reverse ? 0 : way.geometry.length - 1;
      segments.push({
        name: way.tags.name ?? null,
        ref: way.tags.ref ?? null,
        kind,
        oneway,
        pts,
        startKey: endKey(way, startIdx),
        endKey: endKey(way, endIdx),
        parts: [part],
      });
      continue;
    }
    if (way.tags.building !== undefined && way.tags.building !== "no") {
      const ring = ringOf(way, enu);
      if (ring) buildings.push({ id: `b${way.id}`, footprint: ring, ...buildingHeight(way.tags) });
    }
    if (way.tags.amenity === "parking") {
      const ring = ringOf(way, enu);
      if (ring) parking.push({ id: `p${way.id}`, outline: ring });
    }
  }

  const ways: RoadWay[] = [];
  for (const seg of mergeSegments(segments)) {
    // Merged parts agree on lanes, width and speed, so the first part speaks for the road.
    const lanePart = seg.parts[0] as Part;
    const speed = lanePart.speedLimitMph;
    const osmWayIds = seg.parts.map((p) => p.osmWayId);
    const baseId = `w${Math.min(...osmWayIds)}`;
    clipPolyline(seg.pts, radiusM).forEach((centerline, i) => {
      ways.push({
        id: i === 0 ? baseId : `${baseId}-${i + 1}`,
        name: seg.name,
        ref: seg.ref,
        kind: seg.kind,
        oneway: seg.oneway,
        lanesForward: lanePart.lanesForward,
        lanesBackward: lanePart.lanesBackward,
        laneWidthM: lanePart.laneWidthM,
        centerline,
        speedLimitMph: speed,
        osmWayIds,
      });
    });
  }
  ways.sort((p, q) => (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));

  return {
    ...parseFeatures(json, frame, radiusM),
    frame,
    radiusM,
    ways,
    buildings,
    parking,
    terrain: null,
    attribution: [OSM_ATTRIBUTION],
    fetchedAt,
  };
}
