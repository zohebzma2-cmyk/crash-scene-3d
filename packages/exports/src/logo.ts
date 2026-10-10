// The official InsurifyAI logo for the PDF and the PNGs: the mark drawn from the supplied
// path data (never redrawn, never recolored) plus the wordmark as live text.
// Proportions are measured from design/brand/logo-full.png (DESIGN.md section 13).
import type { PDFPage } from "pdf-lib";
import { rgb } from "pdf-lib";
import { MARK_BOUNDS, MARK_PATH_D, MARK_SCALE, MARK_TRANSLATE } from "./brand";
import type { Pt } from "./draw";
import { color, rgb01 } from "./style";
import { LOGO } from "./tokens";

/** The wordmark, no space: "Insurify" in the text color, "AI" in the logo blue. */
export const WORDMARK = { lead: "Insurify", accent: "AI" } as const;

/** In logo-full.png the baseline sits 131 px below the top of the 187 px mark. */
const BASELINE_RATIO = 131 / 187;

/** Width / height of the tight-cropped mark. */
export const MARK_ASPECT = (MARK_BOUNDS.maxX - MARK_BOUNDS.minX) / (MARK_BOUNDS.maxY - MARK_BOUNDS.minY);

export interface Lockup {
  readonly markW: number;
  readonly markH: number;
  /** Wordmark font size, in the same units as markH. */
  readonly wordSize: number;
  /** From the right edge of the mark to the wordmark's origin. */
  readonly gap: number;
  /** From the top of the mark to the wordmark's baseline. */
  readonly baseline: number;
}

export function lockup(markH: number): Lockup {
  const wordSize = markH / LOGO.markHeightEm;
  return { markW: markH * MARK_ASPECT, markH, wordSize, gap: LOGO.gapEm * wordSize, baseline: markH * BASELINE_RATIO };
}

/**
 * Where the supplied path data goes so the mark's tight box sits at (x, top) with height markH:
 * page = origin + scale * path point. This is the SVG's own group transform
 * (translate, then scale) followed by the crop to the path bounds and the fit to markH.
 */
export function markPlacement(x: number, top: number, markH: number) {
  const [tx, ty] = MARK_TRANSLATE;
  const vbX = tx + MARK_SCALE * MARK_BOUNDS.minX;
  const vbY = ty + MARK_SCALE * MARK_BOUNDS.minY;
  const vbH = MARK_SCALE * (MARK_BOUNDS.maxY - MARK_BOUNDS.minY);
  const k = markH / vbH;
  return { scale: k * MARK_SCALE, originX: x + k * (tx - vbX), originY: top + k * (ty - vbY) };
}

/** Draw the mark on a pdf-lib page with drawSvgPath. `top` is the page-space (y up) top edge of the mark. */
export function drawMarkPdf(page: PDFPage, x: number, top: number, markH: number) {
  const p = markPlacement(x, 0, markH);
  const [r, g, b] = rgb01(color("color-logo"));
  // drawSvgPath flips y (page y = y - scale * path y) and fills with the nonzero rule; the
  // mark's four pieces don't overlap, so that is the same picture as the SVG's evenodd fill
  // (a test renders both and compares).
  page.drawSvgPath(MARK_PATH_D, { x: p.originX, y: top - p.originY, scale: p.scale, color: rgb(r, g, b) });
}

/** The mark's pieces as polygons in path coordinates (the path only uses M, L and Z), for a 2D canvas. */
export function markPolygons(): Pt[][] {
  const out: Pt[][] = [];
  for (const sub of MARK_PATH_D.split(/(?=M)/)) {
    const pts = [...sub.matchAll(/[ML]\s*(-?[\d.]+)\s+(-?[\d.]+)/g)].map((m): Pt => [Number(m[1]), Number(m[2])]);
    if (pts.length) out.push(pts);
  }
  return out;
}

/** Fill the mark on a 2D canvas context with the even-odd rule, exactly like the SVG. */
export function drawMarkCanvas(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, x: number, top: number, markH: number) {
  const p = markPlacement(x, top, markH);
  ctx.beginPath();
  for (const poly of markPolygons()) {
    poly.forEach((pt, i) => {
      const X = p.originX + p.scale * pt[0];
      const Y = p.originY + p.scale * pt[1];
      if (i === 0) ctx.moveTo(X, Y);
      else ctx.lineTo(X, Y);
    });
    ctx.closePath();
  }
  ctx.fillStyle = color("color-logo");
  ctx.fill("evenodd");
}
