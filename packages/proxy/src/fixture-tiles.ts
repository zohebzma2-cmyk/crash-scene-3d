// Fixtures mode for map tiles: serve /api/geo/tile from files captured once under
// examples/<name>/tiles/{z}/{x}/{y}.png, and a neutral grey "no tile" PNG anywhere else, so tests and
// the fixture build never reach a live tile server. See createProxy's `deps.fixtureTiles`.

/** 256x256 flat light-grey PNG (#e9e9e9), generated once with pngjs. Shown outside the cached area. */
const NO_TILE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAIAAADTED8xAAACeUlEQVR4Ae3BAQEAMAyDMF7/RufiQiB5d0diNRKxkYiNRGwkYiMRG4nYSMRGIjYSsZGIjURsJGIjERuJ2EjERiI2ErGRiI1EbCRiIxEbidhIxEYiNhKxkYiNRGwkYiMRG4nYSMRGIjYSsZGIjURsJGIjERuJ2EjERiI2ErGRiI1EbCRiIxEbidhIxEYiNhKxkYiNRGwkYiMRG4nYSMRGIjYSsZGIjURsJGIjERuJ2EjERiI2ErGRiI1EbCRiIxEbidhIxEYiNhKxkYiNRGwkYiMRG4nYSMRGIjYSsZGIjURsJGIjERuJ2EjERiI2ErGRiI1EbCRiIxEbidhIxEYiNhKxkYiNRGwkYiMRG4nYSMRGIjYSsZGIjURsJGIjERuJ2EjERiI2ErGRiI1EbCRiIxEbidhIxEYiNhKxkYiNRGwkYiMRG4nYSMRGIjYSsZGIjURsJGIjERuJ2EjERiI2ErGRiI1EbCRiIxEbidhIxEYiNhKxkYiNRGwkYiMRG4nYSMRGIjYSsZGIjURsJGIjERuJ2EjERiI2ErGRiI1EbCRiIxEbidhIxEYiNhKxkYiNRGwkYiMRG4nYSMRGIjYSsZGIjURsJGIjERuJ2EjERiI2ErGRiI1EbCRiIxEbidhIxEYiNhKxkYiNRGwkYiMRG4nYSMRGIjYSsZGIjURsJGIjERuJ2EjERiI2ErGRiI1EbCRiIxEbidhIxEYiNhKxkYiNRGwkYiMRG4nYSMRGIjYSsZGIjURsJGIjERuJ2EjERiI2ErGRiI1EbCRiIxEbidhIxEYiNhKxkYiNRGwkYiMRG4nYSMRGIjYSsZGIjURsJGIjERuJ2EjEPl7SBLuyQuuJAAAAAElFTkSuQmCC";

function decodeBase64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export const NO_TILE_PNG: Uint8Array = decodeBase64(NO_TILE_BASE64);

/** Looks up one tile's bytes; null when it was not captured. */
export type FixtureTileLookup = (z: number, x: number, y: number) => Uint8Array | null | Promise<Uint8Array | null>;
