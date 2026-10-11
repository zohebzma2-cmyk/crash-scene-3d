// Finding a town ("Nashua, NH", the claim's) and a street in a typed town ("Elm St" in "Manchester NH"),
// on top of the type-ahead service, so the live and fixture services answer alike.
import type { PlaceResult } from "@csd/core";
import { isStateText, nameMatchScore, stateOfText } from "@csd/mapdata";
import type { GeoService, StreetInTown, TownPlace } from "./types";

type Suggest = GeoService["suggest"];
const finite = (p: PlaceResult) => Number.isFinite(p.lat) && Number.isFinite(p.lon);
/** A result's state: the proxy's two-letter code, else read from its "Town, ST" line. */
const stateOf = (p: PlaceResult) => p.state ?? stateOfText(p.sub);
/** "Manchester NH" / "Nashua, NH 03060" -> "manchester" / "nashua": the town's own name, lowercased. */
export function townName(text: string): string {
  const first = (text.split(",")[0] ?? "").trim();
  if (text.includes(",")) return first.toLowerCase();
  // "Manchester NH" / "Concord New Hampshire 03301" (no comma): drop the state and ZIP at the end.
  const words = first.replace(/\s+\d{5}(-\d{4})?$/, "").split(/\s+/);
  for (let k = 1; k < words.length; k++) if (isStateText(words.slice(k).join(" "))) return words.slice(0, k).join(" ").toLowerCase();
  return words.join(" ").toLowerCase();
}
const townOf = (p: PlaceResult) => (p.town ?? p.sub.split(",")[0] ?? "").trim().toLowerCase();

/**
 * The best match for a typed town among type-ahead results: a place before a street or address, the
 * town's own name before anything else in it, and never a result in another state than the one typed
 * ("Nashua, NH" must not land in Nashua, Iowa).
 */
export function pickTown(results: readonly PlaceResult[], text: string): TownPlace | null {
  const state = stateOfText(text);
  const name = townName(text);
  let best: { p: PlaceResult; score: number } | null = null;
  for (const p of results) {
    if (!finite(p) || (state && stateOf(p) !== state)) continue;
    // The town itself ("Nashua") beats a place in it ("Nashua Micro-Tech Center, Nashua"), which beats a street.
    const score = (p.category === "place" ? 2 : 0) + (p.main.toLowerCase() === name ? 2 : 0) + (townOf(p) === name ? 1 : 0);
    if (!best || score > best.score) best = { p, score };
  }
  if (!best) return null;
  const { p } = best;
  return { point: { lat: p.lat, lon: p.lon }, state: stateOf(p), label: p.sub || p.label };
}

/** A street of that name in that town (and state, when typed) among type-ahead results. */
export function pickStreetIn(results: readonly PlaceResult[], street: string, town: string): StreetInTown | null {
  const state = stateOfText(town);
  const name = townName(town);
  // The same street name, "St" / "Street" and "N" / "North" alike (nameMatchScore, as the crossings use).
  const hit = results.find((p) => p.category === "street" && finite(p) && (!state || stateOf(p) === state) && townOf(p) === name
    && nameMatchScore(street, { name: p.street ?? p.main }) > 0);
  return hit ? { name: hit.street ?? hit.main, at: { lat: hit.lat, lon: hit.lon }, ways: hit.osmWayIds ?? [], place: hit.sub } : null;
}

export function townLookups(suggest: Suggest): Pick<GeoService, "town" | "streetIn"> {
  async function town(text: string, opts: { signal?: AbortSignal } = {}): Promise<TownPlace | null> {
    const t = text.trim();
    if (!t) return null;
    return pickTown(await suggest(t, opts.signal ? { signal: opts.signal } : {}), t);
  }
  return {
    town,
    async streetIn(street, townText, opts = {}) {
      const s = street.trim();
      const t = townText.trim();
      if (!s || !t) return null;
      // One type-ahead request usually finds the street in the town ("Elm St, Manchester NH").
      const found = pickStreetIn(await suggest(`${s}, ${t}`, opts.signal ? { signal: opts.signal } : {}), s, t);
      if (found) return found;
      // Else the town's own spot: its cross streets are then looked for by name around it.
      const where = await town(t, opts);
      return where ? { name: s, at: where.point, ways: [], place: where.label } : null;
    },
  };
}
