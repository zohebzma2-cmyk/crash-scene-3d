// Small helpers over the generated design tokens. The only place hex strings
// and token names meet code; nothing else in the package spells a color.
import { COLORS, SIZES, type ColorToken, type SizeToken } from "./tokens";

/** CSS px (96 per inch) to PDF points (72 per inch). */
export const PX_TO_PT = 0.75;

export const color = (token: ColorToken): string => COLORS[token];
export const px = (token: SizeToken): number => SIZES[token];

/** "#RRGGBB" to 0..1 channels. */
export function rgb01(hex: string): readonly [number, number, number] {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new Error(`Not a hex color: ${hex}`);
  return [parseInt(m[1]!, 16) / 255, parseInt(m[2]!, 16) / 255, parseInt(m[3]!, 16) / 255];
}

/** Blend `a` over `b` with weight `t` of `a` (used instead of transparency so PDF and canvas match). */
export function mix(a: string, b: string, t: number): string {
  const x = rgb01(a);
  const y = rgb01(b);
  const h = (i: 0 | 1 | 2) => Math.round((x[i] * t + y[i] * (1 - t)) * 255).toString(16).padStart(2, "0");
  return `#${h(0)}${h(1)}${h(2)}`.toUpperCase();
}

/** Vehicle color for a letter, from the tokens. */
export function vehicleColor(id: string): string {
  switch (id) {
    case "A": return COLORS["color-vehicle-a"];
    case "B": return COLORS["color-vehicle-b"];
    case "C": return COLORS["color-vehicle-c"];
    default: return COLORS["color-vehicle-d"];
  }
}

export type { ColorToken, SizeToken };
