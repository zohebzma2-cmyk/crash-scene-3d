// Roads around the pin: Overpass JSON through our proxy -> parseOverpass -> RoadNetwork,
// plus Terrarium terrain tiles (also through the proxy). Terrain is best effort: the
// network works without it (the viewer then draws flat ground).
import { PROXY_ROUTES, type LatLon, type LocalFrame, type RoadNetwork, type TerrainGrid } from "@csd/core";
import { getBytes, getJsonRetrying, retryBusy, type FetchLike } from "./http";
import type { RoadsService } from "./types";

export type TileBytes = (z: number, x: number, y: number) => Promise<Uint8Array>;

/** Decodes the tiles covering the area into a height grid, or null when it can't. */
export type TerrainLoader = (frame: LocalFrame, radiusM: number, tile: TileBytes) => Promise<TerrainGrid | null>;

export interface RoadsDeps {
  readonly parseOverpass: (json: unknown, frame: LocalFrame, radiusM: number, fetchedAt: string) => RoadNetwork;
  readonly terrain: TerrainLoader;
}

export const ROAD_RADIUS_M = 250;
export const TERRAIN_ZOOM = 15;
export const TERRAIN_CELL_M = 10;

/** Slippy-map tile numbers for a point. */
export function tileOf(p: LatLon, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const rad = (p.lat * Math.PI) / 180;
  return {
    x: Math.floor(((p.lon + 180) / 360) * n),
    y: Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n),
  };
}

/** Tiles that cover a square of half-size radiusM around the point. */
export function tilesCovering(center: LatLon, radiusM: number, z: number): Array<{ z: number; x: number; y: number }> {
  const dLat = radiusM / 111_320;
  const dLon = radiusM / (111_320 * Math.cos((center.lat * Math.PI) / 180));
  const a = tileOf({ lat: center.lat + dLat, lon: center.lon - dLon }, z);
  const b = tileOf({ lat: center.lat - dLat, lon: center.lon + dLon }, z);
  const out: Array<{ z: number; x: number; y: number }> = [];
  for (let x = a.x; x <= b.x; x++) for (let y = a.y; y <= b.y; y++) out.push({ z, x, y });
  return out;
}

export function createRoadsService(fetchFn: FetchLike, deps: RoadsDeps): RoadsService {
  return {
    async load(center, radiusM = ROAD_RADIUS_M) {
      const q = new URLSearchParams({ lat: center.lat.toFixed(6), lon: center.lon.toFixed(6), radius: String(radiusM) });
      // A busy answer is tried again after its Retry-After (up to 2.5 s in all) before it counts as a failure.
      const json = await getJsonRetrying<unknown>(fetchFn, `${PROXY_ROUTES.overpass}?${q}`);
      const frame: LocalFrame = { origin: center };
      const net = deps.parseOverpass(json, frame, radiusM, new Date().toISOString());
      const terrain = await deps.terrain(frame, radiusM, (z, x, y) => retryBusy(() => getBytes(fetchFn, `${PROXY_ROUTES.terrain}/${z}/${x}/${y}.png`)));
      return terrain ? { ...net, terrain } : net;
    },
  };
}
