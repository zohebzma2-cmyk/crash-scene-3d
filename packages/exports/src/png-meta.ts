// Text chunks in a PNG. The app writes how big a map-thumbnail pixel is (meters) into the picture
// itself, so the PDF can put street names along the roads at the pin without any new contract field.
/** tEXt keyword: meters on the ground per pixel of the thumbnail picture. */
export const PNG_METERS_PER_PIXEL_KEY = "csd-meters-per-pixel";

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/** The tEXt chunks of a PNG as key -> value (Latin-1). Never throws; a damaged file gives what could be read. */
export function pngText(bytes: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  if (bytes.length < 12 || SIGNATURE.some((b, i) => bytes[i] !== b)) return out;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 8;
  while (pos + 12 <= bytes.length) {
    const len = dv.getUint32(pos);
    const type = String.fromCharCode(bytes[pos + 4]!, bytes[pos + 5]!, bytes[pos + 6]!, bytes[pos + 7]!);
    if (pos + 12 + len > bytes.length) break;
    if (type === "tEXt") {
      const data = bytes.subarray(pos + 8, pos + 8 + len);
      const z = data.indexOf(0);
      if (z > 0) out[String.fromCharCode(...data.subarray(0, z))] = String.fromCharCode(...data.subarray(z + 1));
    }
    if (type === "IEND") break;
    pos += 12 + len;
  }
  return out;
}

/** Meters per thumbnail pixel from the picture, or null when it isn't there or isn't a sensible number. */
export function thumbnailMetersPerPixel(bytes: Uint8Array): number | null {
  const v = Number(pngText(bytes)[PNG_METERS_PER_PIXEL_KEY]);
  return Number.isFinite(v) && v > 0 && v < 1000 ? v : null;
}
