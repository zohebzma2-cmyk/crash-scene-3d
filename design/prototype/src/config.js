// Everything provider-specific lives here (DESIGN.md section 9).
// Switching to a hosted provider is a one-line change.
export const mapProvider = Object.freeze({
  tiles: {
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
    attributionText: "© OpenStreetMap contributors",
    maxZoom: 19,
  },
  geocoder: {
    url: "https://nominatim.openstreetmap.org/search",
    attributionText: "Search by Nominatim",
    minIntervalMs: 1000,
    maxResults: 5,
    timeoutMs: 8000,
  },
  // Browsers can't set User-Agent; the page's Referer identifies the app.
  // Non-browser callers (tests, a future proxy) send this.
  userAgent: "InsurifyAI-CrashScene/0.1 (+https://insurifyai.app)",
});

export const vehicleData = Object.freeze({
  url: "https://vpic.nhtsa.dot.gov/api/vehicles",
  timeoutMs: 6000,
  attributionText: "Vehicle lists from NHTSA vPIC",
});
