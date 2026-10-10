// Test-only: turn an example's cached Overpass JSON into a RoadNetwork so the
// diagram has real roads to draw. (The real parser lives in @csd/mapdata; this
// avoids depending on it while it is being built.)
import { readFileSync } from "node:fs";
import type { Building, ParkingArea, RoadKind, RoadNetwork, RoadWay, Vec2 } from "@csd/core";

interface OsmWay { id: number; tags?: Record<string, string>; geometry?: Array<{ lat: number; lon: number }> }

const EARTH_M = 6_371_000;

export function loadRoads(example: string, origin: { lat: number; lon: number }): RoadNetwork {
  const osm = JSON.parse(readFileSync(new URL(`../../../examples/${example}/osm.json`, import.meta.url), "utf8")) as { elements: OsmWay[]; fetchedAt: string; radiusM: number };
  const k = (Math.PI / 180) * EARTH_M;
  const enu = (p: { lat: number; lon: number }): Vec2 => ({ x: (p.lon - origin.lon) * Math.cos((origin.lat * Math.PI) / 180) * k, y: (p.lat - origin.lat) * k });
  const ways: RoadWay[] = [];
  const buildings: Building[] = [];
  const parking: ParkingArea[] = [];
  for (const e of osm.elements) {
    const t = e.tags ?? {};
    const pts = (e.geometry ?? []).map(enu);
    if (pts.length < 2) continue;
    if (t.highway) {
      const oneway = t.oneway === "yes";
      const lanes = Number(t.lanes) || (oneway ? 1 : 2);
      const fwd = oneway ? lanes : Number(t["lanes:forward"]) || Math.ceil(lanes / 2);
      const back = oneway ? 0 : Number(t["lanes:backward"]) || lanes - fwd;
      const kind = (["motorway", "trunk", "primary", "secondary", "tertiary", "residential", "unclassified", "service"].includes(t.highway) ? t.highway : "other") as RoadKind;
      ways.push({ id: `w${e.id}`, name: t.name ?? null, ref: t.ref ?? null, kind, oneway, lanesForward: fwd, lanesBackward: back, laneWidthM: 3.5, centerline: pts, speedLimitMph: null, osmWayIds: [e.id] });
    } else if (t.building) {
      buildings.push({ id: `b${e.id}`, footprint: pts, heightM: 8, heightSource: "default" });
    } else if (t.amenity === "parking") {
      parking.push({ id: `p${e.id}`, outline: pts });
    }
  }
  return {
    frame: { origin }, radiusM: osm.radiusM, ways, buildings, parking, terrain: null,
    attribution: ["© OpenStreetMap contributors (ODbL)"], fetchedAt: osm.fetchedAt,
  };
}
