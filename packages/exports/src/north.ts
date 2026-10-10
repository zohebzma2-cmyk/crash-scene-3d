// The north arrow of the PDF and PNG diagrams. It uses the geometry of the `north` icon in the
// design icon set (design/icons/icons.json: a kite whose tip is north, drawn on the 24 grid), so the
// app, the PDF and the PNG show one drawing. A test reads icons.json and checks these points match.
// The diagram is always north up (x east, y north), so the arrow always points straight up.
import type { Measure, Pt, Prim } from "./draw";

/** The icon's kite on its 24 grid: tip, right corner, notch, left corner. */
export const NORTH_ICON_POINTS: readonly Pt[] = [[12, 3.5], [17, 19.5], [12, 16.5], [7, 19.5]];
/** Height of the kite on the grid (tip to the corners) and its width. */
const KITE_H = 16;
const KITE_W = 10;
/** Gap between the "N" and the tip, and the "N" box height, in text sizes. */
const N_GAP = 0.2;
const N_BOX = 1.1;

export interface NorthArrow {
  readonly prims: readonly Prim[];
  /** Everything it draws, "N" included, in output units: the rectangle that other things must stay clear of. */
  readonly rect: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
}

/** The room the arrow takes, for planning before it is drawn. */
export function northArrowSize(arrowH: number, textSize: number, measure: Measure): { w: number; h: number } {
  const kiteW = (KITE_W / KITE_H) * arrowH;
  return { w: Math.max(kiteW, measure("sansBold", textSize, "N")), h: textSize * N_BOX + textSize * N_GAP + arrowH };
}

/**
 * The arrow with its "N" above it, its top-left corner at `at`. `arrowH` is the kite's height; the
 * right half is filled so it reads at small sizes, the outline carries the icon's shape.
 */
export function northArrow(at: Pt, arrowH: number, textSize: number, ink: string, line: number, measure: Measure): NorthArrow {
  const size = northArrowSize(arrowH, textSize, measure);
  const k = arrowH / KITE_H;
  const cx = at[0] + size.w / 2;
  const top = at[1] + textSize * N_BOX + textSize * N_GAP;
  // Icon point (12, 3.5) is the tip: the kite's centre line is x = 12, its top y = 3.5.
  const p = ([x, y]: Pt): Pt => [cx + (x - 12) * k, top + (y - 3.5) * k];
  const [tip, right, notch, left] = NORTH_ICON_POINTS.map(p) as [Pt, Pt, Pt, Pt];
  const prims: Prim[] = [
    { k: "poly", pts: [tip, right, notch], closed: true, fill: ink },
    { k: "poly", pts: [tip, right, notch, left], closed: true, stroke: { color: ink, width: line, join: "round" } },
    { k: "text", at: [cx, at[1] + textSize * 0.85], text: "N", font: "sansBold", size: textSize, color: ink, anchor: "middle" },
  ];
  return { prims, rect: { x: at[0], y: at[1], w: size.w, h: size.h } };
}
