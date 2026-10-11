// Roads around the pin: Overpass JSON through our proxy -> parseOverpass -> RoadNetwork,
// plus Terrarium terrain tiles (also through the proxy). Terrain is best effort: the
// network works without it (the viewer then draws flat ground).
import { PROXY_ROUTES, type LatLon, type LocalFrame, type RoadNetwork, type TerrainGrid } from "@csd/core";
import { getBytes, getJson, type FetchLike } from "./http";
import type { RoadsProgress, RoadsService } from "./types";

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

/** Wraps a tile source so each tile that arrives reports progress (the roads are in by then). */
export function countingTiles(center: LatLon, radiusM: number, tile: TileBytes, onProgress?: (p: RoadsProgress) => void): TileBytes {
  if (!onProgress) return tile;
  const total = tilesCovering(center, radiusM, TERRAIN_ZOOM).length;
  let done = 0;
  onProgress({ terrainDone: 0, terrainTotal: total });
  return async (z, x, y) => {
    const bytes = await tile(z, x, y);
    done += 1;
    onProgress({ terrainDone: done, terrainTotal: total });
    return bytes;
  };
}

export function createRoadsService(fetchFn: FetchLike, deps: RoadsDeps): RoadsService {
  return {
    async load(center, radiusM = ROAD_RADIUS_M, onProgress) {
      const q = new URLSearchParams({ lat: center.lat.toFixed(6), lon: center.lon.toFixed(6), radius: String(radiusM) });
      const json = await getJson<unknown>(fetchFn, `${PROXY_ROUTES.overpass}?${q}`);
      const frame: LocalFrame = { origin: center };
      const net = deps.parseOverpass(json, frame, radiusM, new Date().toISOString());
      const tile = countingTiles(center, radiusM, (z, x, y) => getBytes(fetchFn, `${PROXY_ROUTES.terrain}/${z}/${x}/${y}.png`), onProgress);
      const terrain = await deps.terrain(frame, radiusM, tile);
      return terrain ? { ...net, terrain } : net;
    },
  };
}

const loadKey = (c: LatLon, radiusM: number) => `${c.lat.toFixed(6)},${c.lon.toFixed(6)},${radiusM}`;

/**
 * One request per place at a time: a second load of the same point while the first is running joins it (and is
 * told the progress so far). This is what lets an example's roads start at boot and the Roads provider pick
 * them up without waiting for its pin-drag debounce.
 */
export function shareRoadLoads(inner: RoadsService): RoadsService {
  const running = new Map<string, { promise: Promise<RoadNetwork>; last: RoadsProgress | null; listeners: Set<(p: RoadsProgress) => void> }>();
  return {
    load(center, radiusM = ROAD_RADIUS_M, onProgress) {
      const key = loadKey(center, radiusM);
      let entry = running.get(key);
      if (!entry) {
        const e = { promise: null as unknown as Promise<RoadNetwork>, last: null as RoadsProgress | null, listeners: new Set<(p: RoadsProgress) => void>() };
        e.promise = inner.load(center, radiusM, (p) => { e.last = p; for (const l of e.listeners) l(p); });
        running.set(key, e);
        const clear = () => { if (running.get(key) === e) running.delete(key); };
        e.promise.then(clear, clear);
        entry = e;
      }
      if (onProgress) {
        const listeners = entry.listeners;
        listeners.add(onProgress);
        if (entry.last) onProgress(entry.last);
        const off = () => { listeners.delete(onProgress); };
        entry.promise.then(off, off);
      }
      return entry.promise;
    },
    inFlight: (center, radiusM = ROAD_RADIUS_M) => running.has(loadKey(center, radiusM)),
  };
}
