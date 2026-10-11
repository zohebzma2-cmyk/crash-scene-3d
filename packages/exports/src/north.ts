// The north arrow of the PDF and PNG diagrams. It uses the geometry of the `north` icon in the
// design icon set (design/icons/icons.json: a kite whose tip is north, drawn on the 24 grid), so the
// app, the PDF and the PNG show one drawing. A test reads icons.json and checks these points match.
// The diagram is always north up (x east, y north), so the arrow always points straight up.
import type { Measure, Pt, Prim } from "./draw";

type Rect = { readonly x: number; readonly y: number; readonly w: number; readonly h: number };

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

/** One scale bar as laid out on the chip: the bar's ends and middle line, and its label. */
export interface ChipBar {
  readonly label: string;
  /** Left and right ends of the bar and the line it runs along. */
  readonly x0: number;
  readonly x1: number;
  readonly y: number;
  /** What the bar draws (line with round caps and end ticks), output units. */
  readonly box: Rect;
  /** Where the label's baseline starts, and its glyph box. */
  readonly labelAt: Pt;
  readonly labelBox: Rect;
}

export interface ScaleChipStyle {
  /** Size of the "N" and of the bar labels. */
  readonly textSize: number;
  /** Height of the arrow's kite. */
  readonly arrowH: number;
  readonly padX: number;
  readonly padY: number;
  /** Space between the north arrow and the bars; a divider runs down its middle. */
  readonly gap: number;
  /** Space between the end of the longest bar and the labels. */
  readonly labelGap: number;
  /** Height of one bar's row. */
  readonly rowH: number;
  readonly barLine: number;
  /** Half the height of the ticks at the bar ends, and their line width. */
  readonly tick: number;
  readonly tickLine: number;
  /** Line width of the arrow's outline. */
  readonly arrowLine: number;
}

export interface ScaleChip {
  readonly rect: Rect;
  /** The north arrow (with its "N"): where it starts and what it covers, its outline included. */
  readonly arrowAt: Pt;
  readonly arrow: Rect;
  readonly divider: readonly [Pt, Pt];
  readonly bars: readonly ChipBar[];
}

/**
 * The chip that holds the north arrow and the two scale bars (DESIGN.md section 8), with its top-left corner at
 * `at`. The arrow sits on the left and the bars, each with its label, on the right, both centred on the chip's
 * middle, with a clear gap and a divider between them, so the bars never run into the arrow or its "N" (owner,
 * 2026-10-10). The PDF and the PNG both lay their chip out with this, at their own sizes.
 */
export function scaleChip(at: Pt, bars: ReadonlyArray<{ readonly label: string; readonly px: number }>, st: ScaleChipStyle, measure: Measure): ScaleChip {
  const arrowSize = northArrowSize(st.arrowH, st.textSize, measure);
  const barW = Math.max(0, ...bars.map((b) => b.px));
  const labW = Math.max(0, ...bars.map((b) => measure("mono", st.textSize, b.label)));
  const barsH = bars.length * st.rowH;
  const contentH = Math.max(arrowSize.h + st.arrowLine, barsH);
  const w = st.padX * 2 + arrowSize.w + st.gap + barW + st.labelGap + labW;
  const h = st.padY * 2 + contentH;
  const [x, y] = at;
  const arrowAt: Pt = [x + st.padX, y + st.padY + (contentH - arrowSize.h) / 2];
  const half = st.arrowLine / 2;
  const arrow: Rect = { x: arrowAt[0] - half, y: arrowAt[1] - half, w: arrowSize.w + st.arrowLine, h: arrowSize.h + st.arrowLine };
  const dx = x + st.padX + arrowSize.w + st.gap / 2;
  const top = y + st.padY + (contentH - barsH) / 2;
  const x0 = x + st.padX + arrowSize.w + st.gap;
  const reach = Math.max(st.tick, st.barLine / 2);
  const out = bars.map((b, i): ChipBar => {
    const by = top + st.rowH * (i + 0.5);
    const lx = x0 + barW + st.labelGap;
    const lw = measure("mono", st.textSize, b.label);
    return {
      label: b.label, x0, x1: x0 + b.px, y: by,
      box: { x: x0 - Math.max(st.barLine, st.tickLine) / 2, y: by - reach, w: b.px + Math.max(st.barLine, st.tickLine), h: reach * 2 },
      labelAt: [lx, by + st.textSize * 0.35],
      labelBox: { x: lx, y: by - st.textSize * 0.4, w: lw, h: st.textSize * 0.95 },
    };
  });
  return { rect: { x, y, w, h }, arrowAt, arrow, divider: [[dx, y + st.padY], [dx, y + h - st.padY]], bars: out };
}

/** The chip's drawing: the arrow, the divider, the bars with their end ticks, and the labels (the card behind it is the caller's). */
export function scaleChipPrims(chip: ScaleChip, st: ScaleChipStyle, ink: string, rule: string, measure: Measure): Prim[] {
  const prims: Prim[] = [...northArrow(chip.arrowAt, st.arrowH, st.textSize, ink, st.arrowLine, measure).prims];
  prims.push({ k: "poly", pts: [...chip.divider], stroke: { color: rule, width: st.tickLine * 0.5 } });
  for (const b of chip.bars) {
    prims.push({ k: "poly", pts: [[b.x0, b.y], [b.x1, b.y]], stroke: { color: ink, width: st.barLine, cap: "round" } });
    for (const bx of [b.x0, b.x1]) prims.push({ k: "poly", pts: [[bx, b.y - st.tick], [bx, b.y + st.tick]], stroke: { color: ink, width: st.tickLine } });
    prims.push({ k: "text", at: b.labelAt, text: b.label, font: "mono", size: st.textSize, color: ink });
  }
  return prims;
}
