// The live-failover roads path: when a live Overpass fetch fails, loadCuratedRoads serves a bundled example's
// baked roads IF the pin sits right on it, and null otherwise so the app can show its honest failure notice.
// Uses the real parser against the real bundled example data, so it also proves the curated osm.json files
// actually yield roads at their pins.
import { describe, expect, it } from "vitest";
import type { RoadNetwork } from "@csd/core";
import { parseOverpass } from "@csd/mapdata";
import { loadCuratedRoads } from "../src/services/fixtures";

const deps = {
  parseOverpass: parseOverpass as (json: unknown, frame: { origin: { lat: number; lon: number } }, radiusM: number, fetchedAt: string) => RoadNetwork,
  // Terrain is optional for a scene; skip it here so the test stays pure (no PNG decoding, no network).
  terrain: async () => null,
};

describe("curated roads fallback", () => {
  // Signal-node pins of the famous curated intersections (see examples/<slug>/scene.json).
  const PINS: Record<string, { lat: number; lon: number }> = {
    "chicago-state-madison": { lat: 41.8820455, lon: -87.6278089 },
    "nyc-5th-42nd": { lat: 40.7534805, lon: -73.9808792 },
    "la-hollywood-highland": { lat: 34.1015452, lon: -118.3387179 },
    "sf-haight-ashbury": { lat: 37.7700148, lon: -122.4469519 },
    "t-bone-intersection": { lat: 42.7627323, lon: -71.4661324 },
  };

  for (const [name, pin] of Object.entries(PINS)) {
    it(`serves baked roads when the pin is on ${name}`, async () => {
      const net = await loadCuratedRoads(pin, 250, deps);
      expect(net).not.toBeNull();
      expect(net!.ways.length).toBeGreaterThan(0);
    });
  }

  it("returns null when no bundled example is near the pin (so the live failure is surfaced honestly)", async () => {
    expect(await loadCuratedRoads({ lat: 0, lon: 0 }, 250, deps)).toBeNull();
    // A pin a few blocks from a curated intersection is also too far: the baked 250 m window wouldn't cover it.
    expect(await loadCuratedRoads({ lat: 41.8880, lon: -87.6278 }, 250, deps)).toBeNull();
  });
});
