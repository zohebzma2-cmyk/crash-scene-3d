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
    const decoded = [];
    for (const t of wanted) {
      const px = await pngPixels(await tile(t.z, t.x, t.y));
      if (!px) return null;
      decoded.push({ ...t, heights: decodeTerrarium(px, TILE_PX, TILE_PX), size: TILE_PX });
    }
    return decoded.length ? terrainGrid(decoded, frame, radiusM, TERRAIN_CELL_M) : null;
  } catch (e) {
    if (isNotImplemented(e)) return null;
    return null;
  }
};
