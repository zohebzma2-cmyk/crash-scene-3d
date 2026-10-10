// A plain ground-colored tile with no text: the stand-in where there is no road data to draw
// (fixtures mode, outside the cached tiles). A data: URL, so it is same-origin for the CSP and the
// thumbnail canvas, and no request is made.
import { resolveColor } from "./dom";

const TILE_PX = 256;
const cache = new Map<string, string>();

/** An SVG image of a plain tile in the given (already resolved) color. */
export function groundTileSvg(fill: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${TILE_PX}" height="${TILE_PX}" viewBox="0 0 ${TILE_PX} ${TILE_PX}"><rect width="${TILE_PX}" height="${TILE_PX}" fill="${fill}"/></svg>`;
}

/** The ground tile (the color comes from the --color-map-ground token). */
export function groundTileUrl(): string {
  const fill = resolveColor("--color-map-ground");
  let url = cache.get(fill);
  if (!url) {
    url = `data:image/svg+xml,${encodeURIComponent(groundTileSvg(fill))}`;
    cache.set(fill, url);
  }
  return url;
}
