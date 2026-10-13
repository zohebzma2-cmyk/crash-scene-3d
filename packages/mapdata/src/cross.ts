// "Which streets cross this street?" from one Overpass response, for the second dropdown after a
// street is chosen, and for resolving "A and B" when no town was typed.
import type { CrossStreet, CrossStreetsResult, LatLon } from "@csd/core";
import { metersPerDegree } from "./enu";
import { nameMatchScore, normalizeStreetName } from "./names";
import { osmWays, type OsmWay } from "./osm";
import { isDrivableHighway, nameFilter } from "./queries";

/** Crossings of one street closer than this are one junction (dual carriageways, split intersections). */
const CLUSTER_M = 30;
/** Service-road kinds that are never a street you would name as a crossing. */
const NOT_A_STREET = new Set(["driveway", "parking_aisle", "drive-through", "emergency_access"]);

export interface StreetSelector {
  /** The street as typed or as OSM spells it. */
  readonly name?: string;
  /** OSM way ids of the street (from a suggestion), added to whatever the name finds. */
  readonly wayIds?: readonly number[];
}

function radius(r: number): number {
  if (!Number.isFinite(r) || r <= 0) throw new RangeError("radius must be a positive number of metres");
  return Math.round(r);
}
const coord = (v: number) => Number(v.toFixed(7));

/**
 * Overpass QL: the chosen street (by name near a point, and/or by way ids) plus every named way
 * that shares a node with it, with geometry. The name filter is the same tiny over-matching one the
 * crossing search uses, and like it this asks for any `highway` (a regex of the drivable kinds made
 * this query 7 to 8 times slower live); findCrossStreets() does the exact matching and keeps only
 * drivable roads.
 */
export function overpassCrossStreetsQuery(street: StreetSelector, near: LatLon | undefined, radiusM: number): string {
  const ids = [...new Set(street.wayIds ?? [])].filter((n) => Number.isInteger(n) && n > 0).slice(0, 40);
  // The name is searched around a point; with no point only the way ids can find the street.
  const byName = street.name !== undefined && near !== undefined;
  if (!byName && ids.length === 0) throw new RangeError("a street name with a position, or way ids, are required");
  const parts: string[] = [];
  if (byName) {
    const around = `around:${radius(radiusM)},${coord(near.lat)},${coord(near.lon)}`;
    parts.push(`way(${around})["highway"]["name"~"${nameFilter(street.name)}",i];`);
  }
  if (ids.length > 0) parts.push(`way(id:${ids.join(",")});`);
  return `[out:json][timeout:25];(${parts.join("")})->.s;node(w.s)->.n;way(bn.n)["highway"]["name"]->.x;(.s;.x;);out body geom;`;
}

function distM(a: LatLon, b: LatLon): number {
  const m = metersPerDegree((a.lat + b.lat) / 2);
  return Math.hypot((a.lon - b.lon) * m.lon, (a.lat - b.lat) * m.lat);
}

/** Route numbers: "Route 111", "Rte 111", "NH 111" and "111" all mean the same road. */
function refKeys(ref: string): string[] {
  return ref.split(";").map((r) => {
    const words = r.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
    while (["route", "rte", "rt", "highway", "hwy", "state"].includes(words[0] ?? "")) words.shift();
    return words.join("").replace(/^[a-z]{1,2}(?=\d)/, ""); // drop a "NH"/"US"/"MA"/"I" prefix
  }).filter((k) => /\d/.test(k));
}

/** Does the typed text name this route number? ("route 111" / "NH 111" for ref "NH 111") */
export function refMatches(typed: string, ref: string | undefined): boolean {
  if (!ref) return false;
  const wanted = refKeys(typed);
  if (wanted.length === 0) return false;
  const have = refKeys(ref);
  return wanted.some((w) => have.includes(w));
}

function centroid(ways: readonly OsmWay[]): LatLon {
  const pts = ways.flatMap((w) => w.geometry);
  return { lat: pts.reduce((s, p) => s + p.lat, 0) / pts.length, lon: pts.reduce((s, p) => s + p.lon, 0) / pts.length };
}

/** The ways of the chosen street: ids given, plus the best name tier (exact words before street-type-less). */
function streetWays(roads: readonly OsmWay[], street: StreetSelector): OsmWay[] {
  const ids = new Set(street.wayIds ?? []);
  const byId = roads.filter((w) => ids.has(w.id));
  let byName: OsmWay[] = [];
  if (street.name) {
    const scored = roads.map((w) => ({ w, score: nameMatchScore(street.name!, w.tags) }));
    const top = Math.max(0, ...scored.map((x) => x.score));
    byName = top === 0 ? [] : scored.filter((x) => x.score === top).map((x) => x.w);
  }
  return [...new Set([...byId, ...byName])];
}

/**
 * Every named street that shares a node with the chosen street, one entry per street name (same-name
 * pieces merged, spellings like "N Maple Rd" / "North Maple Road" are one name), nearest `near` first.
 * An empty list means nothing crosses, or the street wasn't in the data.
 */
export function findCrossStreets(overpassJson: unknown, street: StreetSelector, near?: LatLon): CrossStreetsResult {
  const roads = osmWays(overpassJson).filter((w) => isDrivableHighway(w.tags.highway) && w.geometry.length >= 2);
  const own = streetWays(roads, street);
  const typed = street.name ?? "";
  if (own.length === 0) return { street: typed, crossings: [] };
  const streetName = own.find((w) => w.tags.name)?.tags.name ?? typed;
  const ownKey = normalizeStreetName(streetName);
  const ownIds = new Set(own.map((w) => w.id));

  const streetNodes = new Map<number, LatLon>();
  for (const w of own) w.nodes.forEach((n, i) => { if (n !== undefined) streetNodes.set(n, w.geometry[i] as LatLon); });

  const origin = near ?? centroid(own);
  interface Acc { name: string; ref?: string; place?: string; points: LatLon[]; ways: Set<number>; names: Map<string, number> }
  const byName = new Map<string, Acc>();
  for (const w of roads) {
    if (ownIds.has(w.id)) continue;
    const name = w.tags.name;
    if (!name || NOT_A_STREET.has(w.tags.service ?? "")) continue;
    const key = normalizeStreetName(name);
    if (key === ownKey) continue; // another piece of the same street, not a cross street
    const hits: LatLon[] = [];
    w.nodes.forEach((n, i) => { if (n !== undefined && streetNodes.has(n)) hits.push(w.geometry[i] as LatLon); });
    if (hits.length === 0) continue;
    const acc = byName.get(key) ?? { name, points: [], ways: new Set<number>(), names: new Map<string, number>() };
    acc.names.set(name, (acc.names.get(name) ?? 0) + 1);
    if (w.tags.ref && !acc.ref) acc.ref = w.tags.ref;
    if (w.tags["addr:city"] && !acc.place) acc.place = w.tags["addr:city"];
    acc.ways.add(w.id);
    for (const p of hits) if (acc.points.every((q) => distM(p, q) > CLUSTER_M)) acc.points.push(p);
    byName.set(key, acc);
  }

  const crossings: CrossStreet[] = [...byName.values()].map((acc) => {
    const points = [...acc.points].sort((p, q) => distM(p, origin) - distM(q, origin));
    // The most common spelling of the merged pieces.
    const name = [...acc.names.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    const first = points[0]!;
    return {
      name, ...(acc.ref ? { ref: acc.ref } : {}), lat: first.lat, lon: first.lon, points,
      osmWayIds: [...acc.ways].sort((a, b) => a - b), ...(acc.place ? { place: acc.place } : {}),
    };
  });
  crossings.sort((a, b) => distM(a, origin) - distM(b, origin));
  return { street: streetName, crossings };
}

/**
 * Pick the cross street the user typed ("north maple", "N Maple Rd", "Route 111") from a list.
 * Exact-words name matches beat street-type-less ones; a route number matches by its ref.
 */
export function matchCrossStreet(crossings: readonly CrossStreet[], typed: string): CrossStreet | null {
  let best: { c: CrossStreet; score: number } | null = null;
  for (const c of crossings) {
    let score: number = nameMatchScore(typed, { name: c.name });
    if (score === 0 && refMatches(typed, c.ref)) score = 1;
    if (score > 0 && (best === null || score > best.score)) best = { c, score };
  }
  return best?.c ?? null;
}
