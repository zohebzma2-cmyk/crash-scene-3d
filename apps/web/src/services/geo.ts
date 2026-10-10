// Location search through our proxy. Search on submit only (no autocomplete). Repeat presses
// within 300 ms are merged; requests are at least 1 s apart; results are cached for the session.
// Only the typed text leaves the browser (and only to our own /api).
import { PROXY_ROUTES, type CrossStreet, type CrossStreetsResult, type LatLon, type PlaceResult } from "@csd/core";
import { mapConfig } from "../config/map";
import { API_TIMEOUT_MS, getJson, type FetchLike } from "./http";
import type { GeoService, SearchOptions } from "./types";

export interface GeoDeps {
  readonly splitCrossing: (q: string) => { a: string; b: string; near: string } | null;
  readonly mergeResults: <T extends { label: string; lat: number; lon: number; kind: string }>(r: readonly T[]) => T[];
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export const SEARCH_LIMIT = 5;
export const MIN_INTERVAL_MS = 1000;
export const MERGE_WINDOW_MS = 300;
export const SEARCH_TIMEOUT_MS = API_TIMEOUT_MS;

function asArray(body: unknown): PlaceResult[] {
  if (Array.isArray(body)) return body as PlaceResult[];
  const inner = (body as { results?: unknown } | null)?.results;
  if (Array.isArray(inner)) return inner as PlaceResult[];
  return body && typeof body === "object" && "lat" in body ? [body as PlaceResult] : [];
}

const validResult = (r: PlaceResult): boolean => typeof r.label === "string" && Number.isFinite(r.lat) && Number.isFinite(r.lon);

/** The request URL for a query: "X and Y" goes to the crossing route, everything else to search. */
export function searchUrl(q: string, split: GeoDeps["splitCrossing"], bias?: LatLon | null, town?: string | null): string {
  const crossing = split(q);
  if (crossing) {
    // No town typed: the claim's town (as text) stands in for it, unless a point is known.
    const p = new URLSearchParams({ a: crossing.a, b: crossing.b, near: crossing.near || (!bias && town ? town : "") });
    // "birchwood and quarry hill" with no town: the proxy looks near the bias instead.
    if (bias) { p.set("lat", bias.lat.toFixed(5)); p.set("lon", bias.lon.toFixed(5)); }
    return `${PROXY_ROUTES.crossing}?${p}`;
  }
  return `${PROXY_ROUTES.search}?${new URLSearchParams({ q, limit: String(SEARCH_LIMIT) })}`;
}

/** Bias is rounded to about a kilometer for the cache key: a map nudge shouldn't be a new search. */
const biasKey = (b: LatLon | null | undefined) => (b ? `${b.lat.toFixed(2)},${b.lon.toFixed(2)}` : "-");

export function suggestUrl(q: string, bias: LatLon | null | undefined, bbox?: readonly [number, number, number, number] | null): string {
  const p = new URLSearchParams({ q, limit: String(mapConfig.suggestLimit) });
  if (bbox) p.set("bbox", bbox.map((n) => n.toFixed(5)).join(","));
  if (bias) { p.set("lat", bias.lat.toFixed(5)); p.set("lon", bias.lon.toFixed(5)); }
  return `${PROXY_ROUTES.suggest}?${p}`;
}

export function crossStreetsUrl(street: string, near: LatLon | null, ways?: readonly number[]): string {
  const p = new URLSearchParams({ street });
  if (near) p.set("near", `${near.lat.toFixed(5)},${near.lon.toFixed(5)}`);
  if (ways?.length) p.set("ways", ways.join(","));
  return `${PROXY_ROUTES.crossStreets}?${p}`;
}

function asCrossings(body: unknown, street: string): CrossStreetsResult {
  const raw = Array.isArray(body) ? body : (body as { crossings?: unknown } | null)?.crossings;
  const list = Array.isArray(raw) ? raw : [];
  const crossings = list.filter((c): c is CrossStreet => !!c && typeof (c as CrossStreet).name === "string" && Number.isFinite((c as CrossStreet).lat) && Number.isFinite((c as CrossStreet).lon));
  return { street: typeof (body as { street?: unknown } | null)?.street === "string" ? (body as { street: string }).street : street, crossings };
}

export function createGeoService(fetchFn: FetchLike, deps: GeoDeps): GeoService {
  const now = deps.now ?? (() => performance.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const cache = new Map<string, PlaceResult[]>();
  let nextSlot = 0;
  let last: { q: string; at: number; promise: Promise<PlaceResult[]> } | null = null;

  async function run(q: string, opts: SearchOptions): Promise<PlaceResult[]> {
    const url = searchUrl(q, deps.splitCrossing, opts.bias, opts.town);
    const wait = Math.max(0, nextSlot - now());
    if (wait > 0) { opts.onWait?.(); await sleep(wait); }
    nextSlot = now() + MIN_INTERVAL_MS;
    const body = await getJson<unknown>(fetchFn, url, SEARCH_TIMEOUT_MS);
    const results = deps.mergeResults(asArray(body).filter(validResult)).slice(0, SEARCH_LIMIT);
    cache.set(q, results);
    return results;
  }

  const suggestCache = new Map<string, PlaceResult[]>();
  const crossCache = new Map<string, CrossStreetsResult>();
  return {
    async suggest(query, opts = {}) {
      const q = query.trim();
      if (q.length < mapConfig.suggestMinChars) return [];
      const key = `${q.toLowerCase()}|${biasKey(opts.bias)}|${opts.bbox?.map((n) => n.toFixed(2)).join(",") ?? ""}`;
      const hit = suggestCache.get(key);
      if (hit) return hit;
      const body = await getJson<unknown>(fetchFn, suggestUrl(q, opts.bias, opts.bbox), API_TIMEOUT_MS, opts.signal);
      const results = deps.mergeResults(asArray(body).filter(validResult) as PlaceResult[]).slice(0, mapConfig.suggestLimit);
      suggestCache.set(key, results);
      return results;
    },
    async crossStreets(street, near, opts = {}) {
      const s = street.trim();
      if (!s) return { street: s, crossings: [] };
      const key = `${s.toLowerCase()}|${biasKey(near)}|${opts.ways?.join(",") ?? ""}`;
      const hit = crossCache.get(key);
      if (hit) return hit;
      const out = asCrossings(await getJson<unknown>(fetchFn, crossStreetsUrl(s, near, opts.ways), API_TIMEOUT_MS, opts.signal), s);
      crossCache.set(key, out);
      return out;
    },
    async search(query, opts = {}) {
      const q = query.trim();
      if (!q) return [];
      const hit = cache.get(q);
      if (hit) return hit;
      if (last && last.q === q && now() - last.at < MERGE_WINDOW_MS) return last.promise;
      const promise = (last ? last.promise.catch(() => undefined) : Promise.resolve()).then(() => run(q, opts));
      last = { q, at: now(), promise };
      return promise;
    },
  };
}
