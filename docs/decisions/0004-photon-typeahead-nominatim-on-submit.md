# 0004. Photon for type-ahead, Nominatim on submit only

Status: Accepted, 2026-10-09 (Zoheb's decision).

## Context
The location step needs a search box with suggestions as the claimant types. Nominatim's usage policy forbids autocomplete and allows at most 1 request per second.

## Options considered
- Nominatim for everything, including as-you-type. Not allowed by its policy.
- Photon (komoot, OSM-based, built for autocomplete) for type-ahead, with Nominatim kept for submitted searches.

## Decision
- Type-ahead uses Photon through `/api/geo/suggest`: 3 or more characters, debounced about 300 ms, stale requests cancelled, cached in the browser and by the proxy, token-bucket limited, biased to the claim location and then the map view.
- Nominatim is the fallback on submit only: Enter or the Search button with no suggestion chosen, or when Photon fails or finds nothing. At most 1 request per second. Never as-you-type, never reverse geocoding.
- Intersections ("X and Y") use `/api/geo/cross-streets` (Overpass): a second dropdown lists the streets that actually cross, and picking one drops the pin on the real crossing point.
- Results carry "Search by Photon · Nominatim · © OpenStreetMap contributors".

## Consequences
- Photon is one more upstream in the privacy table and in `ProviderConfig` (6dde4af).
- On failure or no result the claimant still gets the pin-drop state and can continue.
- Tests use recorded real exchanges for Photon, Nominatim and Overpass (a260b2a).

Sources: PROGRESS.md "Search + map", 26cc456, 4cca1e6, 68631ba, CLAUDE.md "Map and geocoding rules", DESIGN.md section 9.
