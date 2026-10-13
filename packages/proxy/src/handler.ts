// createProxy: routes, validation, response shaping. Upstream mechanics live in upstream.ts.
import {
  PROXY_ROUTES, normName, typeFromVpic,
  type CrossStreetsResult, type PlaceResult, type ProviderConfig, type ProxyCapabilities, type ProxyError, type ProxyTopic, type VehicleModelResult,
} from "@csd/core";
import {
  findCrossings, findCrossStreets, matchCrossStreet, mergeSearchResults, overpassBboxQuery, overpassCrossingQuery,
  overpassCrossStreetsQuery, type StreetSelector,
} from "@csd/mapdata";
import { NO_TILE_PNG } from "./fixture-tiles";
import { createMediaRoutes } from "./media";
import { photonToPlaces } from "./photon";
import {
  crossStreetsParams, crossingParams, modelsParams, noParams, overpassParams, parseQuery, searchParams, suggestParams, tileCoords,
} from "./params";
import type { ProxyDeps } from "./types";
import {
  BadUpstreamBody, ProxyFailure, composite, fetchUpstream, type Ctx, type Entry, type UpstreamCall, type UpstreamSpec,
} from "./upstream";

const json = (v: unknown) => ({ bytes: new TextEncoder().encode(JSON.stringify(v)), contentType: "application/json; charset=utf-8" });
/**
 * How far around the geocoded place to look for the two streets, tried in order. Most "X and Y,
 * City" pairs meet near the city centre, and a small area is cheap for the (often overloaded)
 * public Overpass servers; the wide pass only runs when the small one found no crossing.
 */
const CROSSING_RADII_M = [1500, 5000] as const;
const MAX_CROSSINGS = 3;
const FALLBACK_RESERVE_MS = 1500;
/** Entries built from what people typed are kept at most this long, even as stale fallbacks. */
const SEARCH_KEEP_S = 7 * 24 * 60 * 60;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const isPng = (b: Uint8Array) => b.byteLength >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((v, i) => b[i] === v);
/** Type-ahead has to feel fast: give up on Photon after this long (the app falls back on submit). */
const SUGGEST_DEADLINE_MS = 4000;
/** Photon is asked for more than we show, so merging pieces of one street still leaves enough. */
const SUGGEST_OVERFETCH = 2;
/** Where the second dropdown looks for crossings, and how many candidate streets "A and B" tries. */
const CROSS_STREETS_RADIUS_M = 2000;
const MAX_STREET_CANDIDATES = 2;
/**
 * The vPIC vehicle types the picker covers: cars, MPVs (SUVs and vans), trucks (pickups and heavy trucks) and
 * motorcycles. Bus, trailer, low-speed and incomplete vehicles have no class of ours, so their makes aren't listed;
 * the claimant can still type one.
 */
const VPIC_KINDS = ["car", "mpv", "truck", "motorcycle"] as const;
type VpicKind = (typeof VPIC_KINDS)[number];
/** Store key of the makes index: normalized make name -> the vPIC kinds it is listed under. */
const MAKE_KINDS_KEY = "vehicles/make-kinds";
/** vPIC spells makes in capitals; these don't title-case on their own. */
/** Words that stay in capitals inside a make's name. */
const KEEP_UPPER: ReadonlySet<string> = new Set(["BMW", "GMC", "KTM", "AMG", "LLC", "USA", "UK", "II", "III", "IV", "EV", "RV", "MV", "SRT", "CNG", "LTD"]);
const MAKE_CASE: Readonly<Record<string, string>> = { KIA: "Kia", RAM: "Ram", "TH!NK": "TH!NK", MCLAREN: "McLaren", "MERCEDES-AMG": "Mercedes-AMG", DELOREAN: "DeLorean" };

function errorResponse(status: number, error: ProxyError): Response {
  const headers: Record<string, string> = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" };
  if (error.retryAfterS !== undefined) headers["retry-after"] = String(error.retryAfterS);
  return new Response(JSON.stringify(error), { status, headers });
}

function dataResponse(entry: Entry, ttlS: number, extra: Record<string, string> = {}): Response {
  const headers: Record<string, string> = {
    "content-type": entry.contentType,
    // Stale copies are served only when the provider is failing: don't let browsers keep them long.
    // A provider's no-store is passed on to the browser as it is.
    "cache-control": entry.noStore ? "no-store" : entry.stale ? "public, max-age=60" : `public, max-age=${ttlS}`,
    "x-content-type-options": "nosniff",
    "x-proxy-cache": entry.stale ? "stale" : entry.hit ? "hit" : "miss",
    "x-fetched-at": new Date(entry.fetchedAt).toISOString(),
    ...(entry.etag ? { etag: entry.etag } : {}),
    ...extra,
  };
  return new Response(entry.bytes as BodyInit, { status: 200, headers });
}

const decode = (b: Uint8Array) => new TextDecoder().decode(b);
function parseJsonBody(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(decode(bytes));
  } catch {
    throw new BadUpstreamBody("not JSON");
  }
}

/** Collapse whitespace and lowercase: the cache key form of free text. */
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const keyOf = (route: string, params: Record<string, string | number>) =>
  `${route}?${Object.entries(params).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&")}`;

interface NominatimRow {
  lat?: string; lon?: string; display_name?: string; name?: string; type?: string; addresstype?: string;
  address?: Record<string, string>;
}

function toPlaces(rows: unknown): PlaceResult[] {
  if (!Array.isArray(rows)) throw new BadUpstreamBody("search result is not a list");
  const places: PlaceResult[] = [];
  for (const r of rows as NominatimRow[]) {
    const lat = Number(r.lat);
    const lon = Number(r.lon);
    if (typeof r.display_name !== "string" || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const a = r.address ?? {};
    places.push({
      label: r.display_name,
      main: r.name || a.road || r.display_name.split(",")[0] || r.display_name,
      sub: [a.city || a.town || a.village || a.hamlet, a.state].filter(Boolean).join(", "),
      lat, lon,
      kind: (r.addresstype || r.type || "").replace(/_/g, " "),
    });
  }
  return mergeSearchResults(places);
}

/** The PlaceResult[] a cached geocoder entry holds. */
const placesOf = (entry: Entry): PlaceResult[] => parseJsonBody(entry.bytes) as PlaceResult[];
const placesOfCross = (entry: Entry): CrossStreetsResult => parseJsonBody(entry.bytes) as CrossStreetsResult;

export function createProxy(config: ProviderConfig, deps: ProxyDeps): (req: Request) => Promise<Response> {
  const inflight = new Map<string, Promise<Entry>>();
  const health = new Map<string, number>();

  // ---- upstream specs -------------------------------------------------------------------------

  /** Nominatim: only q plus fixed parameters are ever sent. */
  const geocodeSpec = (q: string, limit: number): UpstreamSpec => ({
    cacheKey: keyOf("geo/search", { q: norm(q), limit }),
    ttlS: config.cacheTtlS.search,
    keepS: SEARCH_KEEP_S,
    calls: [{
      service: "nominatim",
      url: `${config.geocoder.url}?${new URLSearchParams({ q, format: "jsonv2", limit: String(limit), addressdetails: "1" })}`,
    }],
    process: (bytes) => json(toPlaces(parseJsonBody(bytes))),
  });

  const overpassCalls = (query: string): UpstreamCall[] =>
    config.overpass.urls.map((url, i) => ({
      url,
      service: i === 0 ? "overpass" : (`overpass-${i + 1}` as const),
      init: { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ data: query }).toString() },
    }));

  /** Overpass answers 200 with a "remark" when its query ran out of time or memory: treat as failed. */
  function checkOverpass(bytes: Uint8Array): Record<string, unknown> {
    const body = parseJsonBody(bytes);
    if (typeof body !== "object" || body === null || !Array.isArray((body as { elements?: unknown }).elements)) throw new BadUpstreamBody("no elements");
    const remark = (body as { remark?: unknown }).remark;
    if (typeof remark === "string" && /error|timed out|out of memory/i.test(remark)) throw new BadUpstreamBody("overpass remark");
    return body as Record<string, unknown>;
  }

  /** A bias point as it goes upstream: 0.01 degrees (about 1 km), enough to rank nearby places first. */
  const round2 = (v: number) => Number(v.toFixed(2));
  const round3 = (v: number) => Number(v.toFixed(3));

  /** Photon type-ahead: q, a rounded bias, language, a limit; never anything else. */
  const suggestSpec = (q: string, bias: { lat: number; lon: number } | undefined, zoom: number | undefined, limit: number): UpstreamSpec => {
    const params = new URLSearchParams({ q, limit: String(Math.min(16, limit * SUGGEST_OVERFETCH)), lang: "en" });
    // Streets, towns and neighbourhoods only. Without this, "main st" comes back as a dozen bus stops.
    // Addresses (the "house" layer, which also brings every shop and school) only when a number was typed.
    const layers = ["street", "city", "locality", "district", ...(/^\s*\d/.test(q) ? ["house"] : [])];
    for (const layer of layers) params.append("layer", layer);
    if (bias) { params.set("lat", String(bias.lat)); params.set("lon", String(bias.lon)); }
    if (zoom !== undefined) params.set("zoom", String(zoom));
    return {
      cacheKey: keyOf("geo/suggest", { q: norm(q), lat: bias?.lat ?? "", lon: bias?.lon ?? "", z: zoom ?? "", limit, l: layers.length }),
      ttlS: config.cacheTtlS.search,
      keepS: SEARCH_KEEP_S,
      calls: [{ service: "photon", url: `${config.photon.url}?${params}` }],
      process: (bytes) => {
        const places = photonToPlaces(parseJsonBody(bytes), limit);
        if (!places) throw new BadUpstreamBody("not a Photon response");
        return json(places);
      },
    };
  };

  /** Streets (not addresses or places) Photon finds for `name` near a bias point. */
  async function photonStreets(ctx: Ctx, name: string, bias: { lat: number; lon: number }): Promise<PlaceResult[]> {
    const near = { lat: round2(bias.lat), lon: round2(bias.lon) };
    const entry = await fetchUpstream({ ...ctx, deadline: Math.min(ctx.deadline, ctx.deps.now() + SUGGEST_DEADLINE_MS) }, suggestSpec(name, near, undefined, 8));
    return placesOf(entry).filter((p) => p.category === "street").slice(0, MAX_STREET_CANDIDATES);
  }

  /**
   * A position as it goes upstream for a cross-streets lookup: about 100 m (3 decimals) when way ids
   * pin the street down, about 1 km (2 decimals) when the street is found by name, as for Photon.
   */
  const roundNear = (p: { lat: number; lon: number }, street: StreetSelector) =>
    street.wayIds && street.wayIds.length > 0 ? { lat: round3(p.lat), lon: round3(p.lon) } : { lat: round2(p.lat), lon: round2(p.lon) };

  /** The streets crossing one street, from one Overpass query; the cached value is the small final result. */
  const crossStreetsSpec = (street: StreetSelector, near: { lat: number; lon: number } | undefined, radiusM: number): UpstreamSpec => ({
    cacheKey: keyOf("geo/cross-streets", {
      s: norm(street.name ?? ""), ways: [...(street.wayIds ?? [])].sort((x, y) => x - y).join(","),
      lat: near ? near.lat : "", lon: near ? near.lon : "", r: radiusM,
    }),
    ttlS: config.cacheTtlS.search,
    keepS: SEARCH_KEEP_S,
    calls: overpassCalls(overpassCrossStreetsQuery(street, near, radiusM)),
    process: (bytes) => {
      checkOverpass(bytes);
      return json(findCrossStreets(parseJsonBody(bytes), street, near));
    },
  });

  // ---- routes ---------------------------------------------------------------------------------

  async function search(ctx: Ctx, url: URL): Promise<Response> {
    const p = parseQuery(url, searchParams);
    if (!p.ok) return badRequest(p.fields);
    return dataResponse(await fetchUpstream(ctx, geocodeSpec(p.data.q, p.data.limit)), config.cacheTtlS.search);
  }

  async function suggest(ctx: Ctx, url: URL): Promise<Response> {
    const p = parseQuery(url, suggestParams);
    if (!p.ok) return badRequest(p.fields);
    const { q, bbox, limit } = p.data;
    // Bias: the claim's point, else the middle of the map view. A view's width sets how local the bias is.
    const centre = p.data.lat !== undefined && p.data.lon !== undefined ? { lat: p.data.lat, lon: p.data.lon }
      : bbox ? { lat: (bbox[1] + bbox[3]) / 2, lon: (bbox[0] + bbox[2]) / 2 } : undefined;
    const widthDeg = bbox ? Math.abs(bbox[2] - bbox[0]) : 0;
    const zoom = widthDeg > 0 ? Math.max(8, Math.min(16, Math.round(Math.log2(360 / widthDeg)))) : undefined;
    const bias = centre ? { lat: round2(centre.lat), lon: round2(centre.lon) } : undefined;
    const entry = await fetchUpstream({ ...ctx, deadline: Math.min(ctx.deadline, deps.now() + SUGGEST_DEADLINE_MS) }, suggestSpec(q, bias, zoom, limit));
    return dataResponse(entry, config.cacheTtlS.search);
  }

  async function crossStreets(ctx: Ctx, url: URL): Promise<Response> {
    const p = parseQuery(url, crossStreetsParams);
    if (!p.ok) return badRequest(p.fields);
    const street: StreetSelector = { name: p.data.street, ...(p.data.ways ? { wayIds: p.data.ways } : {}) };
    const near = p.data.near ? roundNear(p.data.near, street) : undefined;
    let spec: UpstreamSpec;
    try {
      spec = crossStreetsSpec(street, near, p.data.radius);
    } catch (e) {
      // A name with nothing searchable in it ("Ave", "St St", non-Latin text) is the caller's mistake, not ours.
      if (e instanceof RangeError) return badRequest(["street"]);
      throw e;
    }
    return dataResponse(await fetchUpstream(ctx, spec), config.cacheTtlS.search);
  }

  function capabilities(): Response {
    const body: ProxyCapabilities = {
      suggest: true,
      tileMaxZoom: config.tiles.maxZoom,
      attribution: {
        search: config.geocoder.attribution, tiles: config.tiles.attribution, terrain: config.terrain.attribution, vehicles: config.vehicles.attribution,
      },
    };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=3600", "x-content-type-options": "nosniff" } });
  }

  async function overpass(ctx: Ctx, url: URL): Promise<Response> {
    const p = parseQuery(url, overpassParams);
    if (!p.ok) return badRequest(p.fields);
    // The pin is rounded to 5 decimals (about 1 m): nearby pins share one cache entry, and the entry
    // (stored in the dated geo store, so kept at most 7 days) only ever records the rounded spot.
    const center = { lat: Number(p.data.lat.toFixed(5)), lon: Number(p.data.lon.toFixed(5)) };
    const query = overpassBboxQuery(center, p.data.radius);
    const entry = await fetchUpstream(ctx, {
      cacheKey: keyOf("geo/overpass", { lat: center.lat.toFixed(5), lon: center.lon.toFixed(5), radius: p.data.radius, features: 1 }),
      ttlS: config.cacheTtlS.overpass,
      calls: overpassCalls(query),
      // Same shape as examples/*/osm.json, so the app treats live and cached data alike.
      process: (bytes, _ct, call, nowMs) => {
        const body = checkOverpass(bytes);
        // Our fields go after the body so nothing in the upstream JSON can overwrite them.
        return json({
          ...body,
          fetchedAt: new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, "Z"),
          source: call.url, center, radiusM: p.data.radius, query,
        });
      },
    });
    return dataResponse(entry, config.cacheTtlS.overpass);
  }

  async function crossing(ctx: Ctx, url: URL): Promise<Response> {
    const p = parseQuery(url, crossingParams);
    if (!p.ok) return badRequest(p.fields);
    const { a, b, near } = p.data;
    // Without a town, the bias (claim or map view, rounded to about 1 km) says where to look.
    const bias = near === "" && p.data.lat !== undefined && p.data.lon !== undefined ? { lat: round2(p.data.lat), lon: round2(p.data.lon) } : undefined;
    const key = keyOf("geo/crossing", { a: norm(a), b: norm(b), near: norm(near), lat: bias?.lat ?? "", lon: bias?.lon ?? "" });
    const entry = await composite(ctx, key, config.cacheTtlS.search, async () => {
      let places: PlaceResult[] = [];
      // False once the plain-search fallback is standing in for a failure (timeout, 5xx, every mirror down).
      let cache = true;
      // The reason the street search could not run, when it could not: if the plain search then finds
      // nothing, the caller must hear about the failure, not "no results".
      let failure: ProxyFailure | null = null;
      if (near === "" && bias) {
        // "north main street and pleasant street", no town: find street A near the bias with Photon, then B
        // among A's cross streets (the streets that really share a node with it).
        try {
          const reserve = { ...ctx, deadline: ctx.deadline - FALLBACK_RESERVE_MS };
          for (const street of await photonStreets(ctx, a, bias)) {
            const selector: StreetSelector = { name: street.street ?? street.main, ...(street.osmWayIds ? { wayIds: street.osmWayIds } : {}) };
            const around = roundNear({ lat: street.lat, lon: street.lon }, selector);
            const result = placesOfCross(await fetchUpstream(reserve, crossStreetsSpec(selector, around, CROSS_STREETS_RADIUS_M)));
            const hit = matchCrossStreet(result.crossings, b);
            if (!hit) continue;
            // Several crossings: nearest the bias first.
            const sorted = [...hit.points].sort((p1, p2) => (p1.lat - bias.lat) ** 2 + (p1.lon - bias.lon) ** 2 - ((p2.lat - bias.lat) ** 2 + (p2.lon - bias.lon) ** 2));
            places = sorted.slice(0, MAX_CROSSINGS).map((pt) => ({
              label: `${result.street} & ${hit.name}, ${street.sub}`,
              main: `${result.street} & ${hit.name}`,
              sub: street.sub,
              lat: pt.lat, lon: pt.lon,
              kind: "crossing",
              category: "crossing" as const,
              streets: [result.street, hit.name] as const,
              ...(street.town ? { town: street.town } : {}), ...(street.state ? { state: street.state } : {}),
            }));
            break;
          }
        } catch (e) {
          if (e instanceof ProxyFailure && e.status === 429) throw e;
          cache = false;
          if (e instanceof ProxyFailure) failure = e;
        }
      }
      if (near !== "") {
        try {
          const where = placesOf(await fetchUpstream(ctx, geocodeSpec(near, 1)))[0];
          if (where) {
            for (const radius of CROSSING_RADII_M) {
              const query = overpassCrossingQuery(a, b, where, radius);
              // Leave 1.5 s of the request's deadline for the plain-search fallback if every mirror is slow.
              const op = await fetchUpstream({ ...ctx, deadline: ctx.deadline - FALLBACK_RESERVE_MS }, {
                cacheKey: keyOf("geo/crossing-overpass", { a: norm(a), b: norm(b), lat: where.lat.toFixed(5), lon: where.lon.toFixed(5), radius }),
                ttlS: config.cacheTtlS.search,
                keepS: SEARCH_KEEP_S,
                calls: overpassCalls(query),
                process: (bytes, ct) => { checkOverpass(bytes); return { bytes, contentType: ct }; },
              });
              places = findCrossings(parseJsonBody(op.bytes), a, b, where).slice(0, MAX_CROSSINGS).map((c) => ({
                label: `${c.streets[0]} & ${c.streets[1]}, ${near}`,
                main: `${c.streets[0]} & ${c.streets[1]}`,
                sub: near,
                lat: c.point.lat, lon: c.point.lon,
                kind: "crossing",
                category: "crossing" as const,
                streets: c.streets,
                ...(c.sharedNode ? {} : { approximate: true }),
              }));
              if (places.length > 0) break;
            }
          }
        } catch (e) {
          // Too busy: say so. Any other failure: fall back to a plain search below, but don't cache that answer.
          if (e instanceof ProxyFailure && e.status === 429) throw e;
          cache = false;
          if (e instanceof ProxyFailure) failure = e;
        }
      }
      if (places.length === 0) {
        const q = `${a} and ${b}${near ? `, ${near}` : ""}`;
        places = placesOf(await fetchUpstream(ctx, geocodeSpec(q, 5)));
        // Nominatim rarely resolves "X and Y". Empty after the street search failed means we don't
        // know, so say that (a timeout / upstream error the app shows), never a quiet empty list.
        if (places.length === 0 && failure) throw failure;
      }
      return { ...json(places), cache };
    }, SEARCH_KEEP_S);
    return dataResponse(entry, config.cacheTtlS.search);
  }

  async function tile(ctx: Ctx, kind: "tile" | "terrain", rest: string, url: URL, req: Request): Promise<Response> {
    if ([...url.searchParams.keys()].length > 0) return badRequest([...new Set(url.searchParams.keys())].map((k) => k.replace(/[^\w-]/g, "").slice(0, 20)));
    const m = /^(\d+)\/(\d+)\/(\d+)\.png$/.exec(rest);
    const maxZoom = kind === "tile" ? config.tiles.maxZoom : 15;
    const t = m ? tileCoords([m[1] as string, m[2] as string, m[3] as string], maxZoom) : null;
    if (!t) return badRequest(["tile"]);
    if (kind === "tile" && deps.fixtureTiles) {
      // Fixtures mode: captured files only, a neutral grey tile elsewhere, never the network.
      const bytes = (await deps.fixtureTiles(t.z, t.x, t.y)) ?? NO_TILE_PNG;
      return new Response(bytes as BodyInit, { status: 200, headers: {
        "content-type": "image/png", "cache-control": "public, max-age=3600", "x-content-type-options": "nosniff", "x-proxy-cache": "fixture",
      } });
    }
    const template = kind === "tile" ? config.tiles.url : config.terrain.url;
    const ttlS = kind === "tile" ? config.cacheTtlS.tile : config.cacheTtlS.terrain;
    // The same ttl is the browser's max-age: 7 days for map tiles and 30 days for terrain. Zoheb's call:
    // terrain doesn't change, so the browser may keep it the full 30 days.
    const entry = await fetchUpstream(ctx, {
      cacheKey: `${kind}/${t.z}/${t.x}/${t.y}`,
      ttlS,
      httpCache: true,
      validStored: isPng,
      calls: [{ service: kind === "tile" ? "tiles" : "terrain", url: template.replace("{z}", String(t.z)).replace("{x}", String(t.x)).replace("{y}", String(t.y)) }],
      process: (bytes) => {
        // Only a real PNG is cached or relayed (the status is checked to be exactly 200 upstream):
        // not an HTML error page labelled image/png, not an empty body.
        if (!isPng(bytes)) throw new BadUpstreamBody("not a PNG");
        return { bytes, contentType: "image/png" };
      },
    });
    // The browser's own cache skips us too; if it holds a copy with the same ETag, answer 304 without a body.
    if (entry.etag && !entry.stale && !entry.noStore && req.headers.get("if-none-match") === entry.etag) {
      return new Response(null, { status: 304, headers: { etag: entry.etag, "cache-control": `public, max-age=${ttlS}`, "x-proxy-cache": entry.hit ? "hit" : "miss" } });
    }
    return dataResponse(entry, ttlS);
  }

  /**
   * vPIC lists for the given vehicle kinds (all four unless a make's own kinds are known), asked side by side
   * (each call takes its own global token). Each list is cached on its own, so after a failure only the missing
   * ones are fetched again; the first failure is thrown once every call has settled (so the ones that worked are
   * all cached). `lists[i]` belongs to `kinds[i]`.
   */
  async function vpicAll(ctx: Ctx, pathOf: (kind: VpicKind) => string, kinds: readonly VpicKind[] = VPIC_KINDS): Promise<{ lists: Record<string, unknown>[][]; stale: boolean; fetchedAt?: number }> {
    const settled = await Promise.allSettled(kinds.map((kind) => vpic(ctx, pathOf(kind))));
    const failed = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
    if (failed) throw failed.reason;
    const parts = settled.map((s) => (s as PromiseFulfilledResult<{ rows: Record<string, unknown>[]; stale: boolean; fetchedAt: number }>).value);
    const stale = parts.some((p) => p.stale);
    // A list made from expired parts is as old as its oldest part.
    return { lists: parts.map((p) => p.rows), stale, ...(stale ? { fetchedAt: Math.min(...parts.map((p) => p.fetchedAt)) } : {}) };
  }

  /** One vPIC list call, cached on its own. The key is lowercased: vPIC doesn't care about case, so neither does the cache. */
  async function vpic(ctx: Ctx, path: string): Promise<{ rows: Record<string, unknown>[]; stale: boolean; fetchedAt: number }> {
    const entry = await fetchUpstream(ctx, {
      cacheKey: `vpic/${path.toLowerCase()}`,
      ttlS: config.cacheTtlS.vehicles,
      calls: [{ service: "vehicles", url: `${config.vehicles.url}/${path}${path.includes("?") ? "&" : "?"}format=json` }],
      process: (bytes, ct) => {
        const body = parseJsonBody(bytes);
        if (typeof body !== "object" || body === null || !Array.isArray((body as { Results?: unknown }).Results)) throw new BadUpstreamBody("no Results");
        return { bytes, contentType: ct };
      },
    });
    // Only plain objects are rows: a null, a string or an array in Results is skipped (the cached body is the same
    // either way, and it is filtered again on every read), so it can never throw below.
    const results = (parseJsonBody(entry.bytes) as { Results: unknown[] }).Results;
    const rows = results.filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null && !Array.isArray(r));
    return { rows, stale: entry.stale, fetchedAt: entry.fetchedAt };
  }

  /**
   * vPIC's capitals as a name: "HARLEY-DAVIDSON" -> "Harley-Davidson", "BUELL (EBR)" -> "Buell (EBR)" (a short
   * part in brackets stays an acronym), "JASPER'S HOT RODS LLC" -> "Jasper's Hot Rods LLC" (nothing capitalised
   * after an apostrophe; known acronyms stay).
   */
  const titleCase = (s: string): string => {
    const fixed = MAKE_CASE[s.toUpperCase()];
    if (fixed) return fixed;
    if (s.length <= 3) return s.toUpperCase();
    return s.replace(/\(([^)]*)\)|[A-Za-z0-9]+(?:'[A-Za-z]+)?/g, (part: string, inBrackets: string | undefined) => {
      if (inBrackets !== undefined) return inBrackets.length <= 5 ? `(${inBrackets.toUpperCase()})` : `(${titleCase(inBrackets)})`;
      const upper = part.toUpperCase();
      return KEEP_UPPER.has(upper) ? upper : upper.charAt(0) + part.slice(1).toLowerCase();
    });
  };

  async function makes(ctx: Ctx, url: URL): Promise<Response> {
    const p = parseQuery(url, noParams);
    if (!p.ok) return badRequest(p.fields);
    const entry = await composite(ctx, "vehicles/makes", config.cacheTtlS.vehicles, async () => {
      const names = new Map<string, string>();
      const kinds: Record<string, VpicKind[]> = {};
      const { lists, stale, fetchedAt } = await vpicAll(ctx, (kind) => `GetMakesForVehicleType/${kind}`);
      for (const [i, rows] of lists.entries()) {
        const kind = VPIC_KINDS[i] as VpicKind;
        for (const row of rows) {
          const n = typeof row.MakeName === "string" ? row.MakeName.trim() : "";
          if (!n) continue;
          names.set(n.toUpperCase(), titleCase(n));
          const k = normName(n);
          const list = (kinds[k] ??= []);
          if (!list.includes(kind)) list.push(kind);
        }
      }
      // Which vehicle kinds each make is listed under, so a models lookup asks vPIC only about those.
      // Best effort: without the index a models lookup asks about all four kinds, so a failed write never fails this.
      try {
        await deps.store.set(MAKE_KINDS_KEY, json(kinds).bytes, "application/json; charset=utf-8", config.cacheTtlS.vehicles);
      } catch {
        console.warn("proxy: the vPIC make-kinds index wasn't stored");
      }
      return { ...json([...names.values()].sort((x, y) => x.localeCompare(y))), stale, ...(fetchedAt !== undefined ? { fetchedAt } : {}) };
    });
    return dataResponse(entry, config.cacheTtlS.vehicles);
  }

  /**
   * The vehicle kinds vPIC lists this make under, from the makes index when it is in the store (even past its
   * time: makes barely change). All four when there is no index or the make isn't in it (typed by hand).
   */
  async function kindsFor(make: string): Promise<readonly VpicKind[]> {
    try {
      const stored = await deps.store.get(MAKE_KINDS_KEY);
      if (!stored) return VPIC_KINDS;
      const index = JSON.parse(decode(stored.value)) as Record<string, unknown>;
      const listed = index[normName(make)];
      if (!Array.isArray(listed)) return VPIC_KINDS;
      const kinds = VPIC_KINDS.filter((k) => listed.includes(k));
      return kinds.length > 0 ? kinds : VPIC_KINDS;
    } catch {
      return VPIC_KINDS;
    }
  }

  async function models(ctx: Ctx, url: URL): Promise<Response> {
    const p = parseQuery(url, modelsParams(new Date(deps.now()).getUTCFullYear()));
    if (!p.ok) return badRequest(p.fields);
    const { make, year } = p.data;
    const entry = await composite(ctx, keyOf("vehicles/models", { make: norm(make), year }), config.cacheTtlS.vehicles, async () => {
      const out = new Map<string, VehicleModelResult>();
      const kinds = await kindsFor(make);
      const { lists, stale, fetchedAt } = await vpicAll(ctx, (kind) => `GetModelsForMakeYear/make/${encodeURIComponent(make)}/modelyear/${year}/vehicletype/${kind}`, kinds);
      for (const rows of lists) {
        for (const row of rows) {
          const name = typeof row.Model_Name === "string" ? row.Model_Name.trim() : "";
          const vpicType = typeof row.VehicleTypeName === "string" ? row.VehicleTypeName : "";
          if (name && !out.has(name.toUpperCase())) out.set(name.toUpperCase(), { name, vpicType, type: typeFromVpic(vpicType, name) });
        }
      }
      return { ...json([...out.values()].sort((x, y) => x.name.localeCompare(y.name))), stale, ...(fetchedAt !== undefined ? { fetchedAt } : {}) };
    });
    return dataResponse(entry, config.cacheTtlS.vehicles);
  }

  function badRequest(fields: string[]): Response {
    const which = fields.length > 0 ? ` Check: ${fields.join(", ")}.` : "";
    return errorResponse(400, { code: "bad-request", message: `That request wasn't valid.${which}` });
  }

  // Vehicle photos, 3D models and maker logos (media.ts).
  const media = createMediaRoutes(config, deps, badRequest);

  // ---- entry point ----------------------------------------------------------------------------

  return async (req: Request): Promise<Response> => {
    let topic: ProxyTopic = "map";
    try {
      if (req.method !== "GET") return errorResponse(405, { code: "bad-request", message: "Only GET is supported." });
      const url = new URL(req.url);
      const path = url.pathname;
      const R = PROXY_ROUTES;
      topic = path === R.makes || path === R.models || path === R.vehicleImage || path === R.vehicleModel || path === R.makeLogo ? "vehicles"
        : path === R.search || path === R.suggest || path === R.crossing || path === R.crossStreets ? "search" : "map";
      const ctx: Ctx = {
        topic, config, deps, userKey: deps.userKey(req), userSlots: new Set(), userTokens: new Map(), inflight, health,
        deadline: deps.now() + config.limits.timeoutMs,
      };
      if (path === R.search) return await search(ctx, url);
      if (path === R.overpass) return await overpass(ctx, url);
      if (path === R.crossing) return await crossing(ctx, url);
      if (path === R.suggest) return await suggest(ctx, url);
      if (path === R.crossStreets) return await crossStreets(ctx, url);
      if (path === R.config) return capabilities();
      if (path === R.makes) return await makes(ctx, url);
      if (path === R.models) return await models(ctx, url);
      if (path === R.vehicleImage) return await media.vehicleImage(ctx, url);
      if (path === R.vehicleModel) return await media.vehicleModel(ctx, url);
      if (path === R.makeLogo) return await media.makeLogo(ctx, url);
      if (path.startsWith(`${R.tile}/`)) return await tile(ctx, "tile", path.slice(R.tile.length + 1), url, req);
      if (path.startsWith(`${R.terrain}/`)) return await tile(ctx, "terrain", path.slice(R.terrain.length + 1), url, req);
      return errorResponse(404, { code: "not-found", message: "That wasn't found." });
    } catch (e) {
      if (e instanceof ProxyFailure) {
        // One line per refused request, naming the limit (never the user key, the query or an address).
        if (e.status === 429) console.warn(`proxy: busy topic=${topic}${e.why ? ` service=${e.why.service} limiter=${e.why.limiter}` : ""}`);
        return errorResponse(e.status, e.error);
      }
      console.error("proxy: unexpected error", e instanceof Error ? e.message : "unknown");
      return errorResponse(500, { code: "upstream", message: "Something went wrong on our side. Please try again shortly.", retryAfterS: 5 });
    }
  };
}
