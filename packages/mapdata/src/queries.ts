// Overpass QL builders. Built server-side only (the browser never sends QL).
import type { LatLon } from "@csd/core";
import { metersPerDegree } from "./enu";
import { isStreetSuffix } from "./names";

/** Highway values we treat as drivable; also the filter in the around-query. */
export const DRIVABLE_HIGHWAYS = [
  "motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link",
  "secondary", "secondary_link", "tertiary", "tertiary_link", "unclassified",
  "residential", "living_street", "service",
] as const;

/** Coordinates to 7 decimals (≈1 cm): stable cache keys and the exact shape of the cached fixtures. */
function coord(v: number): number {
  if (!Number.isFinite(v)) throw new RangeError("coordinate must be a finite number");
  return Number(v.toFixed(7));
}

function radius(r: number): number {
  if (!Number.isFinite(r) || r <= 0) throw new RangeError("radius must be a positive number of metres");
  return Math.round(r);
}

/**
 * Overpass QL for drivable roads, buildings and parking within a circle of radiusM around a point.
 * Same shape as the `query` field in examples/\*\/osm.json. The circle misses the corners of the
 * scene square, so the proxy uses overpassBboxQuery; this stays for the cached examples.
 */
export function overpassAroundQuery(center: LatLon, radiusM: number): string {
  const around = `around:${radius(radiusM)},${coord(center.lat)},${coord(center.lon)}`;
  const hw = DRIVABLE_HIGHWAYS.join("|");
  return `[out:json][timeout:60];(way(${around})["highway"~"^(${hw})$"];way(${around})["building"];way(${around})["amenity"="parking"];${featureQuery(around)});out body geom;`;
}

/**
 * Overpass QL for drivable roads, buildings and parking in the square of half-size radiusM
 * around a point, so everything inside the scene square (parseOverpass clips to it) is fetched.
 */
export function overpassBboxQuery(center: LatLon, radiusM: number): string {
  const r = radius(radiusM);
  const m = metersPerDegree(center.lat);
  const dLat = r / m.lat;
  const dLon = r / m.lon;
  const bbox = [center.lat - dLat, center.lon - dLon, center.lat + dLat, center.lon + dLon].map(coord).join(",");
  const hw = DRIVABLE_HIGHWAYS.join("|");
  return `[out:json][timeout:60];(way(${bbox})["highway"~"^(${hw})$"];way(${bbox})["building"];way(${bbox})["amenity"="parking"];${featureQuery(bbox)});out body geom;`;
}

function featureQuery(area: string): string {
  return `node(${area})["highway"~"^(traffic_signals|stop|give_way|crossing|street_lamp)$"];node(${area})["traffic_sign"];way(${area})["footway"="crossing"];`;
}

/** Typed street-type words and 1-2 letter directions never make a useful search word. */
const isWeakWord = (w: string) => isStreetSuffix(w) || w.length < 3;

/**
 * A SHORT, plain-ASCII, case-insensitive Overpass regex that finds every way whose name could be
 * this street. It deliberately over-matches; findCrossings() does the exact matching
 * (street-type abbreviations, accents, apostrophes, hyphens) on the response.
 *
 * Why not one regex that spells out every variant? A first version did (every letter with its
 * accented forms and optional apostrophes; "Main St" came to ~600 characters). It was too heavy
 * to ask of the public Overpass servers, and anything that has to survive an accent or an
 * apostrophe in the middle of the word can't be a plain substring anyway. So: the longest plain
 * word of the name, as its first three letters OR its last four. A typed "OBrien" still finds
 * "O'Brien" (last four), and a typed "Cafe" still finds "Cafe" with an accent (first three).
 * Not anchored.
 *
 * Only [A-Za-z0-9] from the user reach the query.
 */
export function nameFilter(name: string): string {
  const words = name.match(/[A-Za-z0-9]+/g) ?? [];
  const strong = words.filter((w) => !isWeakWord(w));
  const pool = strong.length > 0 ? strong : words.filter((w) => !isStreetSuffix(w));
  const word = [...pool].sort((x, y) => y.length - x.length)[0];
  if (word === undefined) throw new RangeError("street name is empty");
  const letters = word.toLowerCase();
  // A 1-2 letter name ("A St", "I 93") can't be searched by substring: match it as a whole word.
  if (letters.length < 3) return `(^|[^a-z0-9])${letters}([^a-z0-9]|$)`;
  const alternatives = new Set([letters.slice(0, 3), ...(letters.length > 4 ? [letters.slice(-4)] : [])]);
  return alternatives.size === 1 ? [...alternatives][0]! : `(${[...alternatives].join("|")})`;
}

/** True for a highway value cars drive on; used to filter responses, since the queries below ask for any `highway`. */
export function isDrivableHighway(value: string | undefined): boolean {
  return value !== undefined && (DRIVABLE_HIGHWAYS as readonly string[]).includes(value);
}

/**
 * Overpass QL that finds two named streets near a place, for "X and Y" searches.
 *
 * It asks for any `highway` and filters to drivable roads afterwards (isDrivableHighway). Measured
 * live against OSM France's server: the same lookup took 0.7 s with ["highway"] and 4.5 to 6 s
 * with the 12-value ["highway"~"^(motorway|...)$"] regex, and the official servers answered the
 * regex form with 504 dispatcher timeouts. Keep these queries free of big alternations.
 */
export function overpassCrossingQuery(a: string, b: string, near: LatLon, radiusM: number): string {
  const around = `around:${radius(radiusM)},${coord(near.lat)},${coord(near.lon)}`;
  const one = (n: string) => `way(${around})["highway"]["name"~"${nameFilter(n)}",i];`;
  return `[out:json][timeout:30];(${one(a)}${one(b)});out body geom;`;
}
