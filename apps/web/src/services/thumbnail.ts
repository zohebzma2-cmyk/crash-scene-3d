// The map thumbnail for the PDF: copied from tiles already loaded in the visible map (never fetched
// for export). The map writes it together with the pin it was captured for; the Save step uses it
// only if that is still the pin. It is cleared whenever the scene is replaced or the pin moves.
interface Stored {
  readonly bytes: Uint8Array;
  readonly lat: number;
  readonly lon: number;
}

/** Two pins closer than this (degrees, about a centimeter) are the same pin. */
const SAME_PIN_DEG = 1e-7;

let stored: Stored | null = null;

export const mapThumbnail = {
  /** The thumbnail, only if it was captured for this pin. */
  get(pin: { lat: number; lon: number }): Uint8Array | null {
    if (!stored) return null;
    return Math.abs(stored.lat - pin.lat) < SAME_PIN_DEG && Math.abs(stored.lon - pin.lon) < SAME_PIN_DEG ? stored.bytes : null;
  },
  set(bytes: Uint8Array, pin: { lat: number; lon: number }): void {
    stored = { bytes, lat: pin.lat, lon: pin.lon };
  },
  clear(): void {
    stored = null;
  },
};
