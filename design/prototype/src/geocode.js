// Nominatim search, following its usage policy (DESIGN.md section 9):
// submit only (no autocomplete), at most 1 request per second via a queue,
// session cache, address text only, attribution shown by the caller.
import { mapProvider } from "./config.js";

const cfg = mapProvider.geocoder;
const cache = new Map();
let nextSlot = 0;          // earliest time the next request may be sent
let inFlight = null;

/** @returns {Promise<{label:string, lat:number, lon:number, road:string, kind:string}[]>} */
export async function geocode(query, { onWait } = {}) {
  const q = query.trim();
  if (!q) return [];
  if (cache.has(q)) return cache.get(q);
  if (inFlight) await inFlight.catch(() => {});
  const now = performance.now();
  const wait = Math.max(0, nextSlot - now);
  if (wait > 0) { onWait?.(wait); await new Promise((r) => setTimeout(r, wait)); }
  nextSlot = performance.now() + cfg.minIntervalMs;      // measured from the real send time
  const url = `${cfg.url}?${new URLSearchParams({ q, format: "jsonv2", limit: String(cfg.maxResults), addressdetails: "1" })}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  inFlight = fetch(url, { signal: ctrl.signal, credentials: "omit", referrerPolicy: "strict-origin-when-cross-origin" })
    .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
    .finally(() => clearTimeout(timer));
  const rows = await inFlight;
  const results = rows.map((r) => ({
    label: r.display_name,
    main: r.name || r.address?.road || r.display_name.split(",")[0],
    sub: [r.address?.city || r.address?.town || r.address?.village || r.address?.hamlet, r.address?.state].filter(Boolean).join(", "),
    lat: Number(r.lat), lon: Number(r.lon),
    road: r.address?.road || "",
    kind: (r.addresstype || r.type || "").replace(/_/g, " "),
  }));
  cache.set(q, results);
  return results;
}
