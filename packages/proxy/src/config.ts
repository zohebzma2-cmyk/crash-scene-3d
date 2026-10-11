import type { ProviderConfig } from "@csd/core";

const DAY_S = 24 * 60 * 60;
const SEARCH_ATTRIBUTION = "Search by Photon (komoot) · Nominatim · © OpenStreetMap contributors";

/**
 * Who providers can contact about our traffic (OSM usage policies ask for this). This is the only
 * place it is written down: swap it here and the User-Agent follows.
 */
export const DEFAULT_CONTACT = "https://github.com/zohebzma2-cmyk/crash-scene-3d";

/** The production config: OSM tiles, Nominatim, Overpass (+ fallbacks), Terrarium, NHTSA vPIC. */
export function defaultProviderConfig(contact: string = DEFAULT_CONTACT): ProviderConfig {
  // The contact ends up in a request header: keep it to one printable line.
  const safeContact = contact.replace(/[^\x20-\x7e]+/g, " ").trim().slice(0, 200);
  return {
    userAgent: `InsurifyAI-CrashScene/1.0 (+${safeContact})`,
    contact: safeContact,
    // Nominatim: submit only (never as-you-type), and the fallback when Photon finds nothing.
    geocoder: { url: "https://nominatim.openstreetmap.org/search", attribution: SEARCH_ATTRIBUTION },
    // Photon (komoot) for type-ahead. The public instance asks for "reasonable" use; if volume grows,
    // self-host Photon and change this one URL.
    photon: { url: "https://photon.komoot.io/api", attribution: SEARCH_ATTRIBUTION },
    // Order matters. Checked live on 2026-10-10: the main server and its two official backends often
    // answered a street-name query with 504 "dispatcher timeout" after many seconds (2 of 9 probes
    // succeeded), while overpass.openstreetmap.fr (OSM France) answered every probe, usually in
    // under a second; the two community mirrors at the end answered HTTP 500 to everything that day
    // but may recover. A mirror that fails is tried last for two minutes (see byHealth).
    overpass: {
      urls: [
        "https://overpass.openstreetmap.fr/api/interpreter",
        "https://overpass-api.de/api/interpreter",
        "https://lz4.overpass-api.de/api/interpreter",
        "https://overpass.private.coffee/api/interpreter",
        "https://overpass.kumi.systems/api/interpreter",
      ],
      attribution: "© OpenStreetMap contributors (ODbL)",
    },
    tiles: { url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png", attribution: "© OpenStreetMap contributors", maxZoom: 19 },
    terrain: {
      url: "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png",
      encoding: "terrarium",
      attribution: "Elevation: Terrarium tiles, AWS Open Data Terrain Tiles (Mapzen/Tilezen; USGS 3DEP, SRTM)",
    },
    vehicles: { url: "https://vpic.nhtsa.dot.gov/api/vehicles", attribution: "Vehicle data: NHTSA vPIC" },
    // Nominatim and Overpass: 1 request a second, globally and per user.
    limits: { minIntervalMs: 1000, perUserMinIntervalMs: 1000, timeoutMs: 8000 },
    // Map and elevation tiles use token buckets, not 1 req/s (approved by Zoheb, 2026-10-09): a
    // 1440 px map view needs ~35 tiles at once and Leaflet doesn't retry a refused tile. Tiles and
    // terrain each get their own global bucket. Tiles are cached at least `cacheTtlS.tile`.
    tileBurst: { perUser: { capacity: 64, refillPerS: 16 }, global: { capacity: 256, refillPerS: 64 } },
    // Type-ahead is a token bucket, not 1 req/s: per user 12 at once refilling 3/s, all users 20 at once
    // refilling 10/s. Cache hits take no token. A slowly typed search spends about 5 to 7 within a few
    // seconds (the claim's town once, one per typing pause, one or two for a town typed after a comma),
    // which the old 5 at 2/s could not cover with room to spare.
    suggestBurst: { perUser: { capacity: 12, refillPerS: 3 }, global: { capacity: 20, refillPerS: 10 } },
    // NHTSA vPIC: its own buckets, separate from the map's (owner, 2026-10-11; docs/PROXY-BUSY.md). It used to be
    // 1 req/s per user, refused at once, and 1 req/s globally per vPIC call, while a model list is four calls: opening
    // the vehicles step (makes + vehicle A's models) or a pause inside a typed make got a 429. Both buckets count vPIC
    // calls (a list is four). Per user: 24 at once (six cold lists; two vehicles typed by a person need about three)
    // refilling 1/s, so one person never takes more than half the global refill. All users: 16 at once (four cold
    // lists) refilling 2/s. Cache hits (30 days, shared through Blobs) take no token.
    vehiclesBurst: { perUser: { capacity: 24, refillPerS: 1 }, global: { capacity: 16, refillPerS: 2 } },
    cacheTtlS: { search: DAY_S, overpass: 7 * DAY_S, tile: 7 * DAY_S, terrain: 30 * DAY_S, vehicles: 30 * DAY_S },
  };
}
