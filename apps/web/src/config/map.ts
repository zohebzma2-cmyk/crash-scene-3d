// Everything the browser knows about the map. It only ever names its own origin: tiles come
// from our proxy, which holds the real provider (see ProviderConfig in @csd/core).
import { PROXY_ROUTES } from "@csd/core";

export const mapConfig = Object.freeze({
  /** Type-ahead: wait this long after the last keystroke, and don't search for fewer characters than this. */
  suggestDebounceMs: 300,
  suggestMinChars: 3,
  suggestLimit: 6,
  tilesUrl: `${PROXY_ROUTES.tile}/{z}/{x}/{y}.png`,
  attribution: "© OpenStreetMap contributors",
  attributionUrl: "https://www.openstreetmap.org/copyright",
  geocoderAttribution: "Search by Nominatim",
  maxZoom: 19,
  /** Zoomed out past a city the map is no use for placing a pin. */
  minZoom: 3,
  /** Zoom when a place is set. */
  placeZoom: 18,
  /** Zoom before any place is set (the whole continental US). */
  emptyZoom: 4,
  /** Arrow keys nudge the pin by this much; Shift nudges by the larger step. */
  nudgeM: 2,
  nudgeShiftM: 10,
  metersPerDegLat: 111_320,
});
