// Terrarium elevation tiles → a height grid around the scene origin.
// https://github.com/tilezen/joerd/blob/master/docs/formats.md#terrarium
import type { LocalFrame, TerrainGrid } from "@csd/core";
import { enuAbout } from "./enu";

export const TERRAIN_ATTRIBUTION = "Elevation: Terrarium tiles, AWS Open Data Terrain Tiles (Mapzen/Tilezen; USGS 3DEP, SRTM)";
/** Zoom used by the cached examples and the proxy (≈3.5 m per pixel at 43°N). */
export const TERRAIN_ZOOM = 15;
const TILE_SIZE = 256;

/** Decode Terrarium RGBA pixels into heights (m): height = R*256 + G + B/256 − 32768. */
export function decodeTerrarium(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): Float32Array {
  if (rgba.length < width * height * 4) throw new RangeError("pixel buffer is smaller than width × height × 4");
  const out = new Float32Array(width * height);
  for (let i = 0; i < out.length; i++) {
    out[i] = (rgba[i * 4] as number) * 256 + (rgba[i * 4 + 1] as number) + (rgba[i * 4 + 2] as number) / 256 - 32768;
  }
  return out;
}

/** World pixel coordinates (Web Mercator) of a WGS84 point at zoom z for 256 px tiles. */
function worldPixel(lat: number, lon: number, z: number, size: number): { x: number; y: number } {
  const n = 2 ** z * size;
  const sin = Math.sin((lat * Math.PI) / 180);
  return { x: ((lon + 180) / 360) * n, y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * n };
}

/** The tiles needed to cover the square of half-size radiusM around the origin (plus a pixel of margin). */
export function terrainTilesFor(frame: LocalFrame, radiusM: number, z: number = TERRAIN_ZOOM): { z: number; x: number; y: number }[] {
  const enu = enuAbout(frame.origin);
  const sw = worldPixel(...latLonArgs(enu.toLatLon({ x: -radiusM, y: -radiusM })), z, TILE_SIZE);
  const ne = worldPixel(...latLonArgs(enu.toLatLon({ x: radiusM, y: radiusM })), z, TILE_SIZE);
  const max = 2 ** z - 1;
  const x0 = clamp(Math.floor((sw.x - 1) / TILE_SIZE), 0, max);
  const x1 = clamp(Math.floor((ne.x + 1) / TILE_SIZE), 0, max);
  const y0 = clamp(Math.floor((ne.y - 1) / TILE_SIZE), 0, max);
  const y1 = clamp(Math.floor((sw.y + 1) / TILE_SIZE), 0, max);
  const out: { z: number; x: number; y: number }[] = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push({ z, x, y });
  return out;
}

const latLonArgs = (p: { lat: number; lon: number }): [number, number] => [p.lat, p.lon];
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Build the terrain grid for the scene square [-radiusM, radiusM]² from decoded tiles.
 *
 * Grid vertices sit every `cellM` metres (cols = rows = floor(2·radius/cell) + 1), row 0 at the
 * south edge. Heights are bilinear samples across tile edges and are relative to the elevation
 * at the frame origin. All tiles must share one zoom; throws if a tile the square needs is missing
 * (see terrainTilesFor).
 */
export function terrainGrid(
  tiles: ReadonlyArray<{ z: number; x: number; y: number; heights: Float32Array; size: number }>,
  frame: LocalFrame,
  radiusM: number,
  cellM: number,
): TerrainGrid {
  if (!(radiusM > 0) || !(cellM > 0)) throw new RangeError("radiusM and cellM must be positive");
  const first = tiles[0];
  if (!first) throw new Error("no terrain tiles given");
  const z = first.z;
  const size = first.size;
  if (tiles.some((t) => t.z !== z || t.size !== size)) throw new Error("terrain tiles must share one zoom and size");
  const byKey = new Map(tiles.map((t) => [`${t.x}/${t.y}`, t] as const));
  const missing = terrainTilesFor(frame, radiusM, z).filter((t) => !byKey.has(`${t.x}/${t.y}`));
  if (missing.length > 0) {
    throw new Error(`missing terrain tiles: ${missing.map((t) => `${t.z}/${t.x}/${t.y}`).join(", ")}`);
  }
  const xs = tiles.map((t) => t.x);
  const ys = tiles.map((t) => t.y);
  const minPx = Math.min(...xs) * size;
  const maxPx = (Math.max(...xs) + 1) * size - 1;
  const minPy = Math.min(...ys) * size;
  const maxPy = (Math.max(...ys) + 1) * size - 1;

  // Height of the pixel at integer world coordinates; clamped to the area the tiles cover.
  const pixel = (gx: number, gy: number): number => {
    const px = clamp(gx, minPx, maxPx);
    const py = clamp(gy, minPy, maxPy);
    const tile = byKey.get(`${Math.floor(px / size)}/${Math.floor(py / size)}`);
    // Tiles inside the bounding box can be absent for sparse sets; fall back to the nearest given tile's edge.
    if (!tile) return first.heights[0] as number;
    return tile.heights[(py - tile.y * size) * size + (px - tile.x * size)] as number;
  };
  // Terrarium pixel values describe the pixel centre, so sample at (world − 0.5).
  const sample = (lat: number, lon: number): number => {
    const w = worldPixel(lat, lon, z, size);
    const u = w.x - 0.5;
    const v = w.y - 0.5;
    const x0 = Math.floor(u);
    const y0 = Math.floor(v);
    const fx = u - x0;
    const fy = v - y0;
    const top = pixel(x0, y0) * (1 - fx) + pixel(x0 + 1, y0) * fx;
    const bottom = pixel(x0, y0 + 1) * (1 - fx) + pixel(x0 + 1, y0 + 1) * fx;
    return top * (1 - fy) + bottom * fy;
  };

  const enu = enuAbout(frame.origin);
  const originH = sample(frame.origin.lat, frame.origin.lon);
  const cols = Math.floor((2 * radiusM) / cellM) + 1;
  const rows = cols;
  const heightsM: number[] = new Array<number>(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const ll = enu.toLatLon({ x: -radiusM + c * cellM, y: -radiusM + r * cellM });
      heightsM[r * cols + c] = sample(ll.lat, ll.lon) - originH;
    }
  }
  return {
    originM: { x: -radiusM, y: -radiusM },
    cellM,
    cols,
    rows,
    heightsM,
    source: `Terrarium z${z} (AWS Open Data Terrain Tiles)`,
  };
}
