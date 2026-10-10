// Zoom and pan arithmetic for the Location map, kept free of Leaflet so it can be tested alone.

/** Wheel pixels for one zoom level. A mouse notch is about 100 px; a trackpad pinch sends many tiny steps. */
export const WHEEL_PX_PER_ZOOM = 120;
const LINE_PX = 16;
const PAGE_PX = 400;

export interface WheelLike { readonly deltaY: number; readonly deltaMode: number }

/** Zoom levels to add for one wheel event (positive = zoom in). */
export function wheelZoomDelta(e: WheelLike): number {
  const px = e.deltaY * (e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? PAGE_PX : 1);
  return -px / WHEEL_PX_PER_ZOOM;
}

export const clampZoom = (z: number, min: number, max: number): number => Math.min(max, Math.max(min, z));

/** Arrow keys pan the focused map by this much (three times as far with Shift). */
export const KEY_PAN_PX = 80;
export const KEY_PAN_SHIFT_FACTOR = 3;

export type MapKeyAction = { readonly kind: "pan"; readonly dx: number; readonly dy: number } | { readonly kind: "zoom"; readonly delta: 1 | -1 };

/** What a key does to a focused map, or null when it does nothing there. */
export function mapKeyAction(e: { readonly key: string; readonly shiftKey: boolean; readonly ctrlKey: boolean; readonly metaKey: boolean; readonly altKey: boolean }): MapKeyAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  const step = e.shiftKey ? KEY_PAN_PX * KEY_PAN_SHIFT_FACTOR : KEY_PAN_PX;
  switch (e.key) {
    case "ArrowUp": return { kind: "pan", dx: 0, dy: -step };
    case "ArrowDown": return { kind: "pan", dx: 0, dy: step };
    case "ArrowLeft": return { kind: "pan", dx: -step, dy: 0 };
    case "ArrowRight": return { kind: "pan", dx: step, dy: 0 };
    case "+": case "=": return { kind: "zoom", delta: 1 };
    case "-": case "_": return { kind: "zoom", delta: -1 };
    default: return null;
  }
}
