// Our server-side proxy: the browser only ever talks to its own origin.
// Every outside service sits behind /api/* with caching, a 1 req/s limit
// (global and per user), timeouts and fallbacks. Provider details live in
// one server-side config value.

/** Routes the browser may call. Query parameters are listed; nothing else is forwarded. */
export const PROXY_ROUTES = Object.freeze({
  /** Nominatim search. Params: q (address text only), limit (1–5). */
  search: "/api/geo/search",
  /** Overpass around a point. Params: lat, lon, radius (m, 50–400). The query is built server-side. */
  overpass: "/api/geo/overpass",
  /**
   * "X and Y" crossing. Params: a, b (street names), near (free text, e.g. "Nashua NH", optional),
   * lat + lon (optional bias, used to find the streets when `near` is empty).
   */
  crossing: "/api/geo/crossing",
  /**
   * Type-ahead (Photon). Params: q (3-120 chars), lat + lon (bias), bbox (w,s,e,n of the map view,
   * optional), limit (1-8). Returns PlaceResult[]. Photon only: Nominatim is for submit (search).
   */
  suggest: "/api/geo/suggest",
  /**
   * The streets that cross a street. Params: street (name), near ("lat,lon"), radius (m, 50-2000),
   * ways (OSM way ids from a suggestion). At least one of near and ways is required: `near` is where to
   * look for a street found by name (sent upstream rounded to about 1 km, or 100 m when `ways` is given);
   * `ways` alone is enough when the client has no position. Returns CrossStreetsResult.
   */
  crossStreets: "/api/geo/cross-streets",
  /** What this server offers (suggest, zoom limits, attributions). No upstream call. Returns ProxyCapabilities. */
  config: "/api/geo/config",
  /** Map tile. Path: /api/geo/tile/{z}/{x}/{y}.png */
  tile: "/api/geo/tile",
  /** Terrarium elevation tile. Path: /api/geo/terrain/{z}/{x}/{y}.png */
  terrain: "/api/geo/terrain",
  /** NHTSA vPIC makes (cached long). No params. */
  makes: "/api/vehicles/makes",
  /** NHTSA vPIC models. Params: make, year. */
  models: "/api/vehicles/models",
});

export type ProxyErrorCode = "busy" | "timeout" | "upstream" | "bad-request" | "not-found";

/** JSON body of every non-2xx proxy response. `message` is safe to show as text. */
export interface ProxyError {
  readonly code: ProxyErrorCode;
  readonly message: string;
  /** Seconds to wait before trying again (also sent as Retry-After). */
  readonly retryAfterS?: number;
}

/**
 * What a proxy answer is about, so its message names the right thing: the map (tiles, terrain, the roads
 * around a pin), the address search (search, type-ahead, crossings, cross streets) or the vehicle list (vPIC).
 * A vehicle lookup must never say "map requests" (owner's report, 2026-10-11).
 */
export type ProxyTopic = "map" | "search" | "vehicles";

/** "Too many requests": shown only after the proxy and the app have both waited and tried again. */
export const BUSY_MESSAGES: Readonly<Record<ProxyTopic, string>> = Object.freeze({
  map: "We're getting a lot of map requests right now. Please try again in a moment.",
  search: "We're getting a lot of searches right now. Please try again in a moment.",
  vehicles: "The vehicle list is busy right now. Please try again in a moment.",
});
export const TIMEOUT_MESSAGES: Readonly<Record<ProxyTopic, string>> = Object.freeze({
  map: "The map service is slow to answer right now. Please try again shortly.",
  search: "Search is slow to answer right now. Please try again shortly.",
  vehicles: "The vehicle list is slow to answer right now. Please try again shortly.",
});
export const UPSTREAM_MESSAGES: Readonly<Record<ProxyTopic, string>> = Object.freeze({
  map: "The map service isn't answering right now. Please try again shortly.",
  search: "Search isn't answering right now. Please try again shortly.",
  vehicles: "The vehicle list isn't answering right now. Please try again shortly.",
});
/** The map's wording (kept for callers that predate the per-topic messages). */
export const BUSY_MESSAGE = BUSY_MESSAGES.map;
export const TIMEOUT_MESSAGE = TIMEOUT_MESSAGES.map;

/** Search result as returned by /api/geo/search and /api/geo/crossing. */
export interface PlaceResult {
  readonly label: string;
  readonly main: string;
  readonly sub: string;
  readonly lat: number;
  readonly lon: number;
  readonly kind: string;
  /** Set for crossings: the two street names that meet here. */
  readonly streets?: readonly [string, string];
  /** True for a crossing found by closest approach (within 30 m) rather than a shared OSM junction node. */
  readonly approximate?: boolean;
  // The fields below are set by /api/geo/suggest (Photon) so the app can show "Town, State" on every suggestion.
  /** What this result is: a street, a place (town, landmark) or a specific address. */
  readonly category?: "street" | "place" | "address" | "crossing";
  /** Street name (for an address, the street it is on). */
  readonly street?: string;
  /** City, town or village. */
  readonly town?: string;
  readonly county?: string;
  /** State name as US postal abbreviation where known ("NH"). */
  readonly state?: string;
  readonly postcode?: string;
  /** OSM way ids behind a street result (several when one street was merged from pieces); pass to cross-streets. */
  readonly osmWayIds?: readonly number[];
}

/** One street that crosses the chosen street, merged by name. */
export interface CrossStreet {
  /** The street's name as OSM spells it ("North Maple Road"). */
  readonly name: string;
  /** Route number when the street carries one ("NH 101A"). */
  readonly ref?: string;
  /** The crossing nearest the `near` point. */
  readonly lat: number;
  readonly lon: number;
  /** Every place the two streets share a node, nearest `near` first (several when they cross more than once). */
  readonly points: ReadonlyArray<{ readonly lat: number; readonly lon: number }>;
  /** OSM way ids of this street's pieces that touch the chosen street. */
  readonly osmWayIds: readonly number[];
  /** Town, when OSM tags one on the way. */
  readonly place?: string;
}

/** Response of /api/geo/cross-streets. */
export interface CrossStreetsResult {
  /** The chosen street, as OSM spells it (or as typed when OSM has no match). */
  readonly street: string;
  /** One entry per crossing street name, nearest first. Empty when nothing crosses (or the street wasn't found). */
  readonly crossings: readonly CrossStreet[];
}

/** Response of /api/geo/config. */
export interface ProxyCapabilities {
  readonly suggest: boolean;
  readonly tileMaxZoom: number;
  /** Text to show wherever the data is. */
  readonly attribution: {
    readonly search: string;
    readonly tiles: string;
    readonly terrain: string;
    readonly vehicles: string;
  };
}

/** Model as returned by /api/vehicles/models; `type` maps vPIC's vehicle type to ours (null = ask the claimant). */
export interface VehicleModelResult {
  readonly name: string;
  readonly vpicType: string;
  readonly type: "car" | "suv" | "pickup" | "van" | "motorcycle" | "truck" | null;
}

/** A token bucket: up to `capacity` requests at once, refilled at `refillPerS` per second. */
export interface BucketLimit {
  readonly capacity: number;
  readonly refillPerS: number;
}

/**
 * One value holds everything provider-specific (server-side only; future keys
 * go here, never in the browser bundle). Switching providers is a one-line change.
 */
export interface ProviderConfig {
  readonly userAgent: string;
  readonly contact: string;
  /** Nominatim: search on submit only, and the fallback when Photon has nothing. */
  readonly geocoder: { readonly url: string; readonly attribution: string };
  /**
   * Photon (komoot, OSM data) for type-ahead. One value so it can point at a self-hosted Photon later:
   * the public instance asks for "reasonable" use, so if volume grows, self-host and change `url`.
   */
  readonly photon: { readonly url: string; readonly attribution: string };
  readonly overpass: { readonly urls: readonly string[]; readonly attribution: string };
  readonly tiles: { readonly url: string; readonly attribution: string; readonly maxZoom: number };
  readonly terrain: { readonly url: string; readonly encoding: "terrarium"; readonly attribution: string };
  readonly vehicles: { readonly url: string; readonly attribution: string };
  /**
   * Strict limits for Nominatim and Overpass (search and crossing included): one request
   * per `minIntervalMs` globally and per `perUserMinIntervalMs` per user. `timeoutMs` is the overall
   * deadline for one proxy request (slot waits and every upstream attempt count against it).
   */
  readonly limits: { readonly minIntervalMs: number; readonly perUserMinIntervalMs: number; readonly timeoutMs: number };
  /**
   * Map tiles and elevation tiles are limited by token buckets instead of 1 req/s (approved by
   * Zoheb, 2026-10-09), because one 1440 px map view needs ~35 tiles in a burst and Leaflet does not
   * retry a refused tile. `perUser` is each caller's bucket; `global` is one shared bucket per
   * service (tiles and terrain separately). Only real upstream calls take a token; cache hits never
   * do. Over the limit, a request waits up to ~1 s for a token before the 429.
   */
  readonly tileBurst: { readonly perUser: BucketLimit; readonly global: BucketLimit };
  /** Type-ahead (Photon): a token bucket too, since autocomplete can't live at 1 req/s. Cache hits take no token. */
  readonly suggestBurst: { readonly perUser: BucketLimit; readonly global: BucketLimit };
  /**
   * NHTSA vPIC (makes and model lists): its own token buckets, separate from the map's (owner, 2026-10-11).
   * `perUser` takes one token per proxy request; `global` one per vPIC call (a model list is four calls,
   * one per vehicle kind). Cache hits take none. Over the limit a request waits up to ~2.5 s for a token.
   */
  readonly vehiclesBurst: { readonly perUser: BucketLimit; readonly global: BucketLimit };
  readonly cacheTtlS: { readonly search: number; readonly overpass: number; readonly tile: number; readonly terrain: number; readonly vehicles: number };
}
