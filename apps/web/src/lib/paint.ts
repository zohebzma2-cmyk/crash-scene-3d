// Paint in the web app: the claimant's picked colour as CSS. The hex is the claimant's own data (like the
// make and model), never a design colour, so it reaches CSS only through custom properties set inline:
// `--vehicle-paint` (the body fill) and `--paint-ink` (the glyph or line drawn ON the paint, a token chosen
// for contrast). Stylesheets read `var(--vehicle-paint, var(--vehicle))`, so with no paint they draw the
// vehicle token exactly as before. This is the one place app code turns a paint into CSS.
import type { CSSProperties } from "react";
import { hexToRgb01, paintOf, relativeLuminance, type Paintable } from "@csd/core";

/**
 * Below this paint luminance the light ink reads better than the dark one: about the crossover between the white
 * surface and the near-black text token (the two inks; see `inkVar`).
 */
export const LIGHT_INK_BELOW = 0.2;

/** The light and the dark ink in either theme: the surface and text tokens swap places in dark mode, so each is a light-dark() pair. */
export const INK = {
  light: "light-dark(var(--color-surface), var(--color-text))",
  dark: "light-dark(var(--color-text), var(--color-surface))",
} as const;

/**
 * The ink for a glyph, check mark or line drawn on `hex`. Decided by the paint alone (no DOM reads, so it costs
 * nothing per render) and written as a light-dark() pair, so it stays right when the theme flips without a
 * re-render. At least 4.5:1 on every factory colour and on near-white and near-black paints (test/paint.test.tsx).
 */
export function inkVar(hex: string): string {
  return relativeLuminance(hexToRgb01(hex)) < LIGHT_INK_BELOW ? INK.light : INK.dark;
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
