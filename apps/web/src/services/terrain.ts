// Terrarium PNG tiles -> height grid. Browser only (needs a canvas to read the pixels).
// Any failure returns null: the road network is still good without terrain.
import { decodeTerrarium, terrainGrid } from "@csd/mapdata";
import { isNotImplemented } from "./fallbacks";
import { TERRAIN_CELL_M, TERRAIN_ZOOM, tilesCovering, type TerrainLoader } from "./roads";

const TILE_PX = 256;

async function pngPixels(bytes: Uint8Array): Promise<Uint8ClampedArray | null> {
  if (typeof createImageBitmap !== "function") return null;
  const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: "image/png" }));
  const canvas = typeof OffscreenCanvas === "function" ? new OffscreenCanvas(bitmap.width, bitmap.height) : Object.assign(document.createElement("canvas"), { width: bitmap.width, height: bitmap.height });
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) return null;
  ctx.drawImage(bitmap, 0, 0);
  const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
  bitmap.close();
  return data;
}

export const loadTerrain: TerrainLoader = async (frame, radiusM, tile) => {
  try {
    const wanted = tilesCovering(frame.origin, radiusM, TERRAIN_ZOOM);
    // All tiles at once (a handful, well inside the proxy's per-user tile burst), not one round trip after another.
    const decoded = await Promise.all(wanted.map(async (t) => {
      const px = await pngPixels(await tile(t.z, t.x, t.y));
      return px ? { ...t, heights: decodeTerrarium(px, TILE_PX, TILE_PX), size: TILE_PX } : null;
    }));
    if (decoded.some((d) => d === null)) return null;
    const tiles = decoded.filter((d): d is NonNullable<typeof d> => d !== null);
    return tiles.length ? terrainGrid(tiles, frame, radiusM, TERRAIN_CELL_M) : null;
  } catch (e) {
    if (isNotImplemented(e)) return null;
    return null;
  }
};
