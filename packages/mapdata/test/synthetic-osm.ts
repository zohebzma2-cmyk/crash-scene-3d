// Synthetic Overpass JSON for the road-type test matrix: one made-up site per kind of place (a straight road, a curved
// road, a T-junction, a 4-way crossing, a roundabout, a parking lot, a divided highway, and a spot with no mapped roads).
// Never live data: the geometry is built here in metres and written out as `out body geom` JSON, so the same parser the
// app uses (parseOverpass) turns it into a RoadNetwork. Street names are invented. The sites sit in open country far from
// the examples (and from each other), so the fixtures build can tell them apart by their centre.
//
// Used by the core/mapdata unit tests (road-matrix.test.ts), by the e2e specs (the site centres), and written to
// apps/web/fixtures/roads/<site>/osm.json for the fixtures build (synthetic-fixtures.test.ts keeps those files in step;
// WRITE_ROAD_FIXTURES=1 rewrites them).
import type { LatLon, RoadNetwork, Vec2 } from "@csd/core";
import { enuAbout } from "../src/enu";
import { parseOverpass } from "../src/parse";

export const SITE_NAMES = ["straight", "curved", "t-junction", "four-way", "roundabout", "parking-lot", "divided-highway", "no-roads"] as const;
export type SiteName = (typeof SITE_NAMES)[number];

/** Fetch radius the app uses (services/roads.ts ROAD_RADIUS_M and the fixtures' default). */
export const SITE_RADIUS_M = 250;
const FETCHED_AT = "2026-10-11T12:00:00Z";

/** Each site's centre: open country, about 2.2 km apart, far from the examples (Nashua, NH). */
export const SITE_CENTERS: Readonly<Record<SiteName, LatLon>> = Object.freeze(Object.fromEntries(
  SITE_NAMES.map((name, i) => [name, { lat: 40 + 0.02 * i, lon: -100 }]),
) as Record<SiteName, LatLon>);

export interface OsmJson {
  readonly version: number;
  readonly generator: string;
  readonly center: LatLon;
  readonly radiusM: number;
  readonly fetchedAt: string;
  readonly synthetic: true;
  readonly elements: readonly unknown[];
}

interface Builder {
  way(pts: readonly Vec2[], tags: Record<string, string>, opts?: { closed?: boolean; shareEnds?: ReadonlyArray<readonly [number, number]> }): number[];
  node(p: Vec2): number;
  json(): OsmJson;
}

/** Points rounded to 7 decimals, as OSM stores them. Nodes at the same spot (within 1 cm) are one node, so ways share their ends. */
function builder(site: SiteName): Builder {
  const center = SITE_CENTERS[site];
  const enu = enuAbout(center);
  const base = (SITE_NAMES.indexOf(site) + 1) * 100_000;
  let nextNode = base, nextWay = base;
  const nodes: Array<{ id: number; p: Vec2 }> = [];
  const elements: unknown[] = [];
  const node = (p: Vec2): number => {
    const same = nodes.find((n) => Math.hypot(n.p.x - p.x, n.p.y - p.y) < 0.01);
    if (same) return same.id;
    const id = ++nextNode;
    nodes.push({ id, p });
    return id;
  };
  const ll = (p: Vec2): LatLon => { const g = enu.toLatLon(p); return { lat: Math.round(g.lat * 1e7) / 1e7, lon: Math.round(g.lon * 1e7) / 1e7 }; };
  return {
    node,
    way(pts, tags, opts = {}) {
      const ids = pts.map(node);
      if (opts.closed) ids.push(ids[0]!);
      const all = opts.closed ? [...pts, pts[0]!] : pts;
      elements.push({ type: "way", id: ++nextWay, nodes: ids, geometry: all.map(ll), tags });
      return ids;
    },
    json: () => ({ version: 0.6, generator: "crash-scene-3d synthetic test data", center, radiusM: SITE_RADIUS_M, fetchedAt: FETCHED_AT, synthetic: true, elements }),
  };
}

const P = (x: number, y: number): Vec2 => ({ x, y });
const rad = (deg: number): number => (deg * Math.PI) / 180;
/** Points along a straight line through `through` at a compass bearing, from -len to +len, every `step` m. */
function line(through: Vec2, bearingDeg: number, from: number, to: number, step = 20): Vec2[] {
  const u = { x: Math.sin(rad(bearingDeg)), y: Math.cos(rad(bearingDeg)) };
  const out: Vec2[] = [];
  const n = Math.max(1, Math.round((to - from) / step));
  for (let i = 0; i <= n; i++) { const t = from + ((to - from) * i) / n; out.push(P(through.x + u.x * t, through.y + u.y * t)); }
  return out;
}

/**
 * The curved road: a circular arc of radius 120 m through the pin, running north-west to south-east AT the pin and
 * bending north at one end and east at the other (the owner's report: a single curved road, no crossing).
 */
export const CURVE_RADIUS_M = 120;
function curvePoints(): Vec2[] {
  const c = { x: CURVE_RADIUS_M / Math.SQRT2, y: CURVE_RADIUS_M / Math.SQRT2 };
  const out: Vec2[] = [];
  for (let a = 125; a <= 325 + 1e-9; a += 5) out.push(P(c.x + CURVE_RADIUS_M * Math.cos(rad(a)), c.y + CURVE_RADIUS_M * Math.sin(rad(a))));
  return out;
}

/** Overpass JSON for a site. Every pin is at the site's centre, (0, 0) in its local frame. */
export function siteOsm(site: SiteName): OsmJson {
  const b = builder(site);
  switch (site) {
    case "straight":
      // A two-lane road at 20 degrees east of north, straight through the pin.
      b.way(line(P(0, 0), 20, -240, 240), { highway: "residential", name: "Birch Lane", maxspeed: "30 mph" });
      break;
    case "curved":
      b.way(curvePoints(), { highway: "residential", name: "Willow Bend Road", maxspeed: "30 mph" });
      break;
    case "t-junction":
      // Main Road runs east-west through the pin; Oak Street starts at the pin and runs south.
      b.way(line(P(0, 0), 90, -240, 240), { highway: "secondary", name: "Main Road", maxspeed: "35 mph" });
      b.way(line(P(0, 0), 180, 0, 240), { highway: "residential", name: "Oak Street", maxspeed: "25 mph" });
      break;
    case "four-way":
      // Maple Avenue at 10 degrees and Cedar Street at 95 degrees cross at the pin (not quite square).
      b.way(line(P(0, 0), 10, -240, 240), { highway: "tertiary", name: "Maple Avenue", maxspeed: "30 mph" });
      b.way(line(P(0, 0), 95, -240, 240), { highway: "residential", name: "Cedar Street", maxspeed: "25 mph" });
      break;
    case "roundabout": {
      // A one-way ring of radius 16 m (counter-clockwise, right-hand traffic) centred 16 m north of the pin, so the pin is
      // on its south side; Elm Street comes up from the south to the ring, Ash Street leaves east.
      const r = 16, c = P(0, r);
      const ring: Vec2[] = [];
      for (let a = 270; a < 270 + 360 - 1e-9; a += 15) ring.push(P(c.x + r * Math.cos(rad(a)), c.y + r * Math.sin(rad(a))));
      b.way(ring, { highway: "tertiary", junction: "roundabout" }, { closed: true });
      b.way([...line(P(0, 0), 0, -240, -20), P(0, 0)], { highway: "tertiary", name: "Elm Street", maxspeed: "25 mph" });
      b.way([P(r, r), ...line(P(0, r), 90, 40, 240)], { highway: "residential", name: "Ash Street", maxspeed: "25 mph" });
      break;
    }
    case "parking-lot": {
      // A lot 90 x 60 m with two east-west aisles, reached from Market Street on its south side.
      b.way([P(-45, -20), P(45, -20), P(45, 40), P(-45, 40)], { amenity: "parking" }, { closed: true });
      b.way(line(P(0, 0), 90, -40, 40, 10), { highway: "service", service: "parking_aisle" });
      b.way(line(P(0, 22), 90, -40, 40, 10), { highway: "service", service: "parking_aisle" });
      b.way([P(-40, 0), P(-40, 22)], { highway: "service", service: "parking_aisle" });
      b.way([P(40, 0), P(40, 22)], { highway: "service", service: "parking_aisle" });
      b.way([P(0, -60), P(0, -20), P(0, 0)], { highway: "service" });
      b.way(line(P(0, -60), 90, -240, 240), { highway: "secondary", name: "Market Street", maxspeed: "35 mph" });
      break;
    }
    case "divided-highway":
      // Two one-way carriageways 14 m apart, two lanes each: northbound east of the median, southbound west of it.
      b.way(line(P(7, 0), 0, -240, 240, 40), { highway: "trunk", name: "Valley Highway", ref: "NE 9", oneway: "yes", lanes: "2", maxspeed: "55 mph" });
      b.way(line(P(-7, 0), 180, -240, 240, 40), { highway: "trunk", name: "Valley Highway", ref: "NE 9", oneway: "yes", lanes: "2", maxspeed: "55 mph" });
      break;
    case "no-roads":
      break;
  }
  return b.json();
}

/** The RoadNetwork the app builds for a pin at the site's centre (parseOverpass with the app's radius). */
export function siteNet(site: SiteName): RoadNetwork {
  const osm = siteOsm(site);
  return parseOverpass(osm, { origin: osm.center }, SITE_RADIUS_M, FETCHED_AT);
}
