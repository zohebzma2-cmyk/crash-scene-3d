// Paint in the web app: the claimant's picked colour as CSS. The hex is the claimant's own data (like the
// make and model), never a design colour, so it reaches CSS only through custom properties set inline:
// `--vehicle-paint` (the body fill) and `--paint-ink` (the glyph or line drawn ON the paint, a token chosen
// for contrast). Stylesheets read `var(--vehicle-paint, var(--vehicle))`, so with no paint they draw the
// vehicle token exactly as before. This is the one place app code turns a paint into CSS.
import type { CSSProperties } from "react";
import { contrastRatio, inkOn, paintOf, relativeLuminance, hexToRgb01, type Paintable } from "@csd/core";
import { resolveColor } from "./dom";

type Rgb = readonly [number, number, number];

/** "rgb(r, g, b)" / "rgb(r g b / a)" / "color(srgb r g b)" to 0..1 channels; null when unreadable (jsdom). */
export function parseRgb(css: string): Rgb | null {
  const rgb = css.match(/rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/);
  if (rgb) return [Number(rgb[1]) / 255, Number(rgb[2]) / 255, Number(rgb[3]) / 255];
  const srgb = css.match(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
  if (srgb) return [Number(srgb[1]), Number(srgb[2]), Number(srgb[3])];
  return null;
}

/** The two inks a glyph on paint can take: the surface and text tokens (one light, one dark, in either theme). */
const INKS = { light: "--color-surface", dark: "--color-text" } as const;

/**
 * The ink token for a glyph, check mark or line drawn on `hex`, as `var(--…)`: whichever of the surface and
 * text tokens has more contrast against the paint in the current theme. Where tokens can't be resolved (tests
 * without CSS) it decides by the paint's luminance alone.
 */
export function inkVar(hex: string): string {
  const surface = typeof document !== "undefined" ? parseRgb(resolveColor(INKS.light)) : null;
  const text = typeof document !== "undefined" ? parseRgb(resolveColor(INKS.dark)) : null;
  if (surface && text) {
    const pick = inkOn<"s" | "t">(hex, "s", "t", (k) => (k === "s" ? surface : text));
    // `inkOn` picks the token with more contrast; when surface is the dark one (dark theme), that's still right.
    return `var(${pick.ink === "s" ? INKS.light : INKS.dark})`;
  }
  const l = relativeLuminance(hexToRgb01(hex));
  // White text beats near-black text below this luminance (about the crossover between a white surface and the near-black text token).
  return l < 0.2 ? `var(${INKS.light})` : `var(${INKS.dark})`;
}

/** Contrast of the chosen ink on the paint, for tests and the dev overlay (null where tokens can't be resolved). */
export function inkContrast(hex: string): number | null {
  const css = inkVar(hex).slice(4, -1);
  const rgb = parseRgb(resolveColor(css));
  return rgb ? contrastRatio(hexToRgb01(hex), rgb) : null;
}

/** Inline custom properties for a paint hex: the fill and the ink drawn on it. */
export function paintVars(hex: string): CSSProperties {
  return { "--vehicle-paint": hex.toLowerCase(), "--paint-ink": inkVar(hex) } as CSSProperties;
}

/** Inline custom properties for a vehicle's paint; empty for "Not sure", so the token colour shows. */
export function paintStyle(v: Paintable): CSSProperties {
  const p = paintOf(v);
  return p ? paintVars(p.hex) : {};
}
