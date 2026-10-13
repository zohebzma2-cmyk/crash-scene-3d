// Vehicle paint: the colour the claimant picked for a vehicle (round B). It is the claimant's own data,
// like the make and model, so its hex lives in the scene, not in the design tokens. Identity never
// depends on it: the A/B/C/D letter badges and the outlines stay in the vehicle's token colour
// everywhere, and paint only fills the body (DESIGN.md section 4, ColorPicker).
//
// Pure TS: no DOM, no three. The web app, the viewer and the exports all ask `vehicleColor()`.

/** "#rrggbb", six hex digits. */
export const PAINT_HEX = /^#[0-9a-fA-F]{6}$/;

export interface VehiclePaint {
  /** Shown to the claimant and printed: "Red", or "Custom" for a colour from the custom picker. */
  readonly name: string;
  /** "#rrggbb" (lower case once normalised). */
  readonly hex: string;
}

/**
 * The common factory colours offered as swatches, in the order shown. Mid-tone values a typical
 * paint chart would show for each family; they are user data (a paint), never UI colours.
 */
export const FACTORY_COLORS: readonly VehiclePaint[] = Object.freeze([
  { name: "White", hex: "#f4f5f2" },
  { name: "Black", hex: "#16181b" },
  { name: "Silver", hex: "#b8bcc1" },
  { name: "Gray", hex: "#6b7075" },
  { name: "Red", hex: "#b3151b" },
  { name: "Blue", hex: "#1f5fbf" },
  { name: "Dark blue", hex: "#1b2a4a" },
  { name: "Green", hex: "#2f6b3a" },
  { name: "Beige", hex: "#cdb994" },
  { name: "Brown", hex: "#5a3b26" },
  { name: "Orange", hex: "#e0661b" },
  { name: "Yellow", hex: "#f2c414" },
]);

/** The name used for a colour from the custom picker. */
export const CUSTOM_PAINT_NAME = "Custom";

/** Longest paint name accepted in a scene file. */
export const MAX_PAINT_NAME = 40;

/** The factory swatch with this name (case-insensitive), if any. */
export function factoryColor(name: string): VehiclePaint | undefined {
  const k = name.trim().toLowerCase();
  return FACTORY_COLORS.find((c) => c.name.toLowerCase() === k);
}

/** A custom paint from a picker value ("#RRGGBB"); null when the value is not a 6-digit hex. */
export function customPaint(hex: string): VehiclePaint | null {
  return PAINT_HEX.test(hex) ? { name: CUSTOM_PAINT_NAME, hex: hex.toLowerCase() } : null;
}

/** Anything with a letter and, maybe, a paint: a SceneVehicle, or a plain {id, color}. */
export interface Paintable {
  readonly id: string;
  readonly color?: VehiclePaint | null | undefined;
}

/**
 * THE colour to fill a vehicle's body with, everywhere (3D body, mini map, diagrams, stills, PDF):
 * the picked paint's hex, or the vehicle's token colour when nothing (or "Not sure") was picked.
 * `token` maps a letter to its token colour in the caller's own form (a resolved CSS colour, a hex).
 */
export function vehicleColor(v: Paintable, token: (id: string) => string): string {
  const hex = v.color?.hex;
  return hex && PAINT_HEX.test(hex) ? hex.toLowerCase() : token(v.id);
}

/** The picked paint, or null for "Not sure" (also for a malformed value, which the schema never lets in). */
export function paintOf(v: Paintable): VehiclePaint | null {
  return v.color && PAINT_HEX.test(v.color.hex) ? v.color : null;
}

/** Each vehicle's picked hex by letter (only vehicles with a paint). For renderers that take a map. */
export function paintMap(vehicles: readonly Paintable[]): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const v of vehicles) { const p = paintOf(v); if (p) out[v.id] = p.hex.toLowerCase(); }
  return out;
}

/** Copy for the chip next to a catalog photo and for the PDF: "Red", "Custom colour". */
export function paintLabel(p: VehiclePaint): string {
  return p.name === CUSTOM_PAINT_NAME ? "Custom colour" : p.name;
}

/** The chip next to a catalog photo: "Picked: Red" (the photo's own paint may differ). */
export function pickedChipText(p: VehiclePaint): string {
  return `Picked: ${paintLabel(p)}`;
}

/** The chip on a catalog photo: it is the catalog's picture, in the catalog's paint ("Catalog photo · Picked: Red"). */
export function catalogPhotoChipText(p: VehiclePaint | null): string {
  return p ? `Catalog photo · ${pickedChipText(p)}` : "Catalog photo";
}

/**
 * The factory colour nearest an sRGB colour (0..1 channels), by distance in sRGB with the channels weighted as the eye weighs
 * them (a "redmean"-style weighting): the name for a catalog model's own paint ("White", "Black").
 */
export function nearestFactoryColor(rgb: readonly [number, number, number]): VehiclePaint {
  let best = FACTORY_COLORS[0]!, bestD = Infinity;
  for (const c of FACTORY_COLORS) {
    const [r, g, b] = hexToRgb01(c.hex);
    const rm = (r + rgb[0]) / 2, dr = r - rgb[0], dg = g - rgb[1], db = b - rgb[2];
    const d = (2 + rm) * dr * dr + 4 * dg * dg + (3 - rm) * db * db;
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}

/** The chip for a catalog model that keeps its own paint: "Catalog colour: White" (never the picked colour, which it doesn't show). */
export function catalogColourChipText(p: VehiclePaint): string {
  return `Catalog colour: ${paintLabel(p)}`;
}

/* ------------------------------ contrast ------------------------------ */

/** "#rrggbb" to 0..1 sRGB channels. */
export function hexToRgb01(hex: string): readonly [number, number, number] {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new Error(`Not a #rrggbb colour: ${hex}`);
  return [parseInt(m[1]!, 16) / 255, parseInt(m[2]!, 16) / 255, parseInt(m[3]!, 16) / 255];
}

/** WCAG 2.x relative luminance of an sRGB colour given as 0..1 channels. */
export function relativeLuminance(rgb: readonly [number, number, number]): number {
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
}

/** WCAG contrast ratio between two colours (1..21). */
export function contrastRatio(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  const [x, y] = [relativeLuminance(a), relativeLuminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

/**
 * Which of two inks reads best on a paint: the badge text, glyph or line colour drawn ON the paint.
 * `light` and `dark` are the caller's token inks (for example the surface and text colours).
 * Returns the chosen ink and its contrast ratio against the paint.
 */
export function inkOn<T extends string>(paintHex: string, light: T, dark: T, rgbOf: (c: T) => readonly [number, number, number] = hexToRgb01 as (c: T) => readonly [number, number, number]): { ink: T; ratio: number; which: "light" | "dark" } {
  const p = hexToRgb01(paintHex);
  const rl = contrastRatio(p, rgbOf(light));
  const rd = contrastRatio(p, rgbOf(dark));
  return rl >= rd ? { ink: light, ratio: rl, which: "light" } : { ink: dark, ratio: rd, which: "dark" };
}
