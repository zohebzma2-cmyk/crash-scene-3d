// "Main St and Amherst St, Nashua NH" handling and search-result clean-up.
import { isStreetSuffix, normalizeStreetName } from "./names";

const MAX_PART = 80;
const MERGE_RADIUS_M = 300;

/** Road-like Nominatim `type`/`addresstype` values; results of these kinds can be segments of one street. */
const ROAD_KINDS = new Set([
  "motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential", "service",
  "living street", "living_street", "road", "street", "highway", "pedestrian", "motorway_link",
  "trunk_link", "primary_link", "secondary_link", "tertiary_link",
]);

const validPart = (s: string) => s.length >= 2 && s.length <= MAX_PART && /[a-z]/i.test(s);
const hasStreetWord = (s: string) => s.split(/\s+/).some((w) => isStreetSuffix(w));

/**
 * Split "Main St and Amherst St, Nashua NH" / "Main St & Amherst St" / "Main St at Amherst St" /
 * "Main St / Amherst St" / "corner of Main St and Amherst St, Nashua, NH 03060" into its parts;
 * null if it isn't a crossing query. A leading "corner of" / "intersection of" is dropped.
 *
 * The place goes after the first comma. Without a comma, the words after the second street's
 * type word ("St", "Ave" …) are taken as the place. "at" needs a street-type word on one side
 * so "Hotel at the Mall" isn't read as a crossing. Names that contain "&" or "and"
 * ("Smith & Sons") can't be told apart from crossings; the crossing route falls back to a
 * plain geocoder search when it finds no street pair.
 */
export function splitCrossingQuery(q: string): { a: string; b: string; near: string } | null {
  // "corner of Main St and Amherst St" / "the intersection of …" / "at the junction of …"
  const text = q.replace(/\s+/g, " ").trim().replace(/^(?:at\s+)?(?:the\s+)?(?:corner|intersection|junction|crossing)(?:\s+(?:of|at|between))?\s+/i, "");
  if (text === "") return null;
  const m = /\s+(and|at)\s+|\s*(&|\/|@)\s*/i.exec(text);
  if (!m) return null;
  const word = (m[1] ?? "").toLowerCase();
  const a = text.slice(0, m.index).replace(/[.,;]+$/, "").trim();
  const rest = text.slice(m.index + m[0].length).trim();
  if (!validPart(a) || rest === "") return null;

  let b: string;
  let near: string;
  const comma = rest.indexOf(",");
  if (comma >= 0) {
    b = rest.slice(0, comma).trim();
    near = rest.slice(comma + 1).trim();
  } else {
    const words = rest.split(" ");
    // First street-type word after at least one name word ends the street; the rest is the place.
    const end = words.findIndex((w, i) => i > 0 && isStreetSuffix(w));
    b = end >= 0 ? words.slice(0, end + 1).join(" ") : rest;
    near = end >= 0 ? words.slice(end + 1).join(" ") : "";
  }
  b = b.replace(/[.;]+$/, "").trim();
  if (!validPart(b) || /^\d+$/.test(a) || /^\d+$/.test(b)) return null;
  if (normalizeStreetName(a) === normalizeStreetName(b)) return null;
  if (word === "at" && !hasStreetWord(a) && !hasStreetWord(b)) return null;
  return { a, b, near };
}

function distM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const dLat = (a.lat - b.lat) * 111_320;
  const dLon = (a.lon - b.lon) * 111_320 * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  return Math.hypot(dLat, dLon);
}

/**
 * Merge and de-duplicate search results that are segments of the same street: road-like
 * results with the same street name within about 300 m collapse to the first (best-ranked)
 * one. Results of other kinds are only dropped when label and position are identical.
 */
export function mergeSearchResults<T extends { label: string; lat: number; lon: number; kind: string }>(results: readonly T[]): T[] {
  const kept: T[] = [];
  const nameOf = (r: T) => normalizeStreetName(r.label.split(",")[0] ?? r.label);
  for (const r of results) {
    const road = ROAD_KINDS.has(r.kind.toLowerCase());
    const dup = kept.some((k) => {
      if (k.label === r.label && distM(k, r) < 1) return true;
      if (!road || !ROAD_KINDS.has(k.kind.toLowerCase())) return false;
      return nameOf(k) === nameOf(r) && distM(k, r) <= MERGE_RADIUS_M;
    });
    if (!dup) kept.push(r);
  }
  return kept;
}
