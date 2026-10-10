# 0003. No bulk tiles in the repo

Status: Accepted, 2026-10-09.

## Context
For test mode ("fixtures"), the map needed to work offline. About 200 standard OSM tiles around the three example pins were cached and served from the examples (684707c, eff41eb: 204 tiles, z15-18). OSM's tile policy does not allow a bulk download, and the repo will be public.

## Options considered
- Keep the cached tiles as a test-only exception (it had been written into CLAUDE.md and DESIGN.md).
- Remove them and draw the test map without OSM tiles.

## Decision
Remove the 204 cached tiles (49ff3db). In test mode the map draws every tile locally from the examples' cached road data: roads with casing, buildings, parking and street names, and plain ground with no text where there is no data (77d3d19). No OSM tiles are stored in the repo. The PDF in test mode uses the labeled road outline instead of a tile thumbnail.

The live rules stay: tiles load only for the area in view, no pre-fetching, and the PDF map thumbnail is copied from tiles already loaded in the visible map, never by fetching tiles in a loop.

## Consequences
- The fixture tile index, its serving code and the cached-tile exception in CLAUDE.md and DESIGN.md were dropped.
- The copy-tiles-to-canvas e2e test (e2e/map.spec.ts) is skipped as known-stale. A live-tile test against the deployed proxy is on the README "Next version" list.

Sources: 49ff3db, 77d3d19, f910d08, 14fd1cb, CLAUDE.md "Map and geocoding rules", DESIGN.md sections 5 and 9, README "Next version".
