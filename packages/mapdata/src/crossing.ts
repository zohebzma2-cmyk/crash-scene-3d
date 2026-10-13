// Where do two named streets meet? Works on the Overpass response of overpassCrossingQuery()
// (or any `out body geom` response that contains both streets).
import type { LatLon, Vec2 } from "@csd/core";
import { enuAbout, metersPerDegree } from "./enu";
import { nameMatchScore, normalizeStreetName } from "./names";
import { isDrivableHighway } from "./queries";
import { osmWays, type OsmWay } from "./osm";

export interface Crossing {
  readonly point: LatLon;
  /** The two street names as OSM spells them. */
  readonly streets: readonly [string, string];
  /** True when the ways share an OSM node (a real junction); false when this is the closest approach (within 30 m). */
  readonly sharedNode: boolean;
}

/** Streets that never come closer than this are not "meeting" (e.g. two same-named streets in different towns). */
const MAX_GAP_M = 30;
/** Shared nodes closer than this are one junction (dual carriageways, split intersections). */
const CLUSTER_M = 30;

function displayName(ways: readonly OsmWay[], fallback: string): string {
  return ways.find((w) => w.tags.name)?.tags.name ?? fallback;
}

function distM(p: LatLon, q: LatLon): number {
  const m = metersPerDegree((p.lat + q.lat) / 2);
  return Math.hypot((p.lon - q.lon) * m.lon, (p.lat - q.lat) * m.lat);
}

/** Closest points between segments a0-a1 and b0-b1 (2D). Intersecting segments give the intersection twice. */
function closestOnSegments(a0: Vec2, a1: Vec2, b0: Vec2, b1: Vec2): { p: Vec2; q: Vec2; d: number } {
  const r = { x: a1.x - a0.x, y: a1.y - a0.y };
  const s = { x: b1.x - b0.x, y: b1.y - b0.y };
  const denom = r.x * s.y - r.y * s.x;
  if (denom !== 0) {
    const t = ((b0.x - a0.x) * s.y - (b0.y - a0.y) * s.x) / denom;
    const u = ((b0.x - a0.x) * r.y - (b0.y - a0.y) * r.x) / denom;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
      const p = { x: a0.x + t * r.x, y: a0.y + t * r.y };
      return { p, q: p, d: 0 };
    }
  }
  const onSeg = (pt: Vec2, s0: Vec2, s1: Vec2): Vec2 => {
    const dx = s1.x - s0.x;
    const dy = s1.y - s0.y;
    const l2 = dx * dx + dy * dy;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((pt.x - s0.x) * dx + (pt.y - s0.y) * dy) / l2));
    return { x: s0.x + t * dx, y: s0.y + t * dy };
  };
  let best: { p: Vec2; q: Vec2; d: number } | null = null;
  const consider = (p: Vec2, q: Vec2) => {
    const d = Math.hypot(p.x - q.x, p.y - q.y);
    if (best === null || d < best.d) best = { p, q, d };
  };
  consider(a0, onSeg(a0, b0, b1));
  consider(a1, onSeg(a1, b0, b1));
  consider(onSeg(b0, a0, a1), b0);
  consider(onSeg(b1, a0, a1), b1);
  return best as unknown as { p: Vec2; q: Vec2; d: number };
}

/** Ways whose name matches best: exact words first, and only if there are none, ones missing the street type. */
function bestMatches(roads: readonly OsmWay[], wanted: string): OsmWay[] {
  const scored = roads.map((w) => ({ w, score: nameMatchScore(wanted, w.tags) }));
  const top = Math.max(0, ...scored.map((x) => x.score));
  return top === 0 ? [] : scored.filter((x) => x.score === top).map((x) => x.w);
}

/** Every place the two streets meet, best first (nearest `prefer` when given, else nearest the middle of the data). */
export function findCrossings(overpassJson: unknown, a: string, b: string, prefer?: LatLon): Crossing[] {
  if (normalizeStreetName(a) === normalizeStreetName(b)) return [];
  const roads = osmWays(overpassJson).filter((w) => isDrivableHighway(w.tags.highway) && w.geometry.length >= 2);
  const aWays = bestMatches(roads, a);
  const bWays = bestMatches(roads, b).filter((w) => !aWays.includes(w));
  if (aWays.length === 0 || bWays.length === 0) return [];
  const streets = [displayName(aWays, a), displayName(bWays, b)] as const;

  const all = [...aWays, ...bWays].flatMap((w) => w.geometry);
  const centre: LatLon = prefer ?? {
    lat: all.reduce((s, p) => s + p.lat, 0) / all.length,
    lon: all.reduce((s, p) => s + p.lon, 0) / all.length,
  };
  const byDistance = (x: LatLon, y: LatLon) => distM(x, centre) - distM(y, centre);

  // 1. Shared OSM nodes: a real junction.
  const aNodes = new Map<number, LatLon>();
  for (const w of aWays) w.nodes.forEach((n, i) => { if (n !== undefined) aNodes.set(n, w.geometry[i] as LatLon); });
  const shared: LatLon[] = [];
  for (const w of bWays) {
    w.nodes.forEach((n, i) => {
      const p = n === undefined ? undefined : aNodes.get(n);
      if (p) shared.push(p);
      void i;
    });
  }
  if (shared.length > 0) {
    const clusters: LatLon[] = [];
    for (const p of shared.sort(byDistance)) if (clusters.every((c) => distM(c, p) > CLUSTER_M)) clusters.push(p);
    return clusters.map((point) => ({ point, streets, sharedNode: true }));
  }

  // 2. No shared node: the midpoint of the closest pair of points between the two streets.
  const enu = enuAbout(aWays[0]?.geometry[0] as LatLon);
  const project = (w: OsmWay) => w.geometry.map((p) => enu.toLocal(p));
  const aLines = aWays.map(project);
  const bLines = bWays.map(project);
  let best: { p: Vec2; q: Vec2; d: number } | null = null;
  for (const al of aLines) {
    for (const bl of bLines) {
      for (let i = 0; i + 1 < al.length; i++) {
        for (let j = 0; j + 1 < bl.length; j++) {
          const c = closestOnSegments(al[i] as Vec2, al[i + 1] as Vec2, bl[j] as Vec2, bl[j + 1] as Vec2);
          if (best === null || c.d < best.d) best = c;
        }
      }
    }
  }
  if (best === null || (best as { d: number }).d > MAX_GAP_M) return [];
  const { p, q } = best as { p: Vec2; q: Vec2 };
  return [{ point: enu.toLatLon({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }), streets, sharedNode: false }];
}

/**
 * Where the two named streets meet in an Overpass response: the shared node if the ways
 * share one, else the midpoint of the closest pair of points (only if within 30 m).
 * When the streets cross more than once, `prefer` picks the crossing nearest to it.
 */
export function crossingPoint(overpassJson: unknown, a: string, b: string, prefer?: LatLon): LatLon | null {
  return findCrossings(overpassJson, a, b, prefer)[0]?.point ?? null;
}
