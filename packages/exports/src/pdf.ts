// The PDF summary: US Letter, brand fonts embedded, laid out like the locked
// prototype. The goal is one page. The layout shrinks in steps (padding, then
// text down to 8 pt, never smaller) to fit. If the assumptions and warnings
// still don't fit, page 1 keeps as many whole assumptions as fit and says what
// continues; the rest of the list and the warnings move to page 2 (and on, if
// they are huge), with the header and the full footer repeated on every page.
// Nothing is ever dropped, and nothing is ever drawn over the footer.
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, PDFName, PDFString, type PDFImage } from "pdf-lib";
import { DISCLAIMER_LONG, DISCLAIMER_SHORT, toLocal } from "@csd/core";
import type { BrandFonts, RoadNetwork, Scene, SimulationResult } from "@csd/core";
import { scaleChip, scaleChipPrims, type ScaleChipStyle } from "./north";
import { planDiagram, planPinStreetLabels, planRoadOutline, scaleBars, type Box } from "./diagram";
import { thumbnailMetersPerPixel } from "./png-meta";
import { roundedRectPts, wrapText, type FontKey, type Pt } from "./draw";
import { WORDMARK, drawMarkPdf, lockup } from "./logo";
import { HIT_ON_MARK, type ReportModel } from "./model";
import { PdfCanvas, type Extent, type PdfFonts, type Region } from "./pdf-canvas";
import { PX_TO_PT, color, px, vehicleColor } from "./style";

const OSM_CREDIT = "© OpenStreetMap contributors";
/** On the road outline the roads are OpenStreetMap data (not tiles). */
const OSM_DATA_CREDIT = "Map data © OpenStreetMap contributors";
/** No printed text below this (pt), except labels inside the diagram. */
export const MIN_TEXT_PT = 8;
/** The pin dot and its ring on the app's map thumbnail, in thumbnail pixels (apps/web LocationMap): street names keep clear of them. */
const THUMB_PIN_IMAGE_PX = 7;
const THUMB_RING_IMAGE_PX = 3;
/** Fewest meters the fallback road outline spans across the map box. */
const MIN_OUTLINE_SPAN_M = 80;
/** The diagram is at least this share of the room between the header and the footer (0.3 keeps the real examples on one page). */
export const MIN_DIAGRAM_FRACTION = 0.3;
/** Longest a scale bar may be, as shares of the diagram's width, tried in turn until the chip fits a clear corner. */
const CHIP_BAR_SHARES = [0.3, 0.24, 0.18, 0.12] as const;
/** Diagram labels (street names, letters, marker numbers, scale) stay at least this large (pt). */
export const MIN_DIAGRAM_TEXT_PT = MIN_TEXT_PT;

/**
 * The north arrow and scale chip in the PDF diagram, in pt. Its spacing comes from the tokens and doesn't shrink
 * with the page's fit level, so the bars keep clear of the arrow at every size.
 */
export function pdfChipStyle(textPt: number, lineH: number, hair: number): ScaleChipStyle {
  return {
    textSize: textPt, arrowH: textPt * 3.2, padX: px("space-2") * PX_TO_PT * 0.75, padY: px("space-1") * PX_TO_PT,
    gap: px("space-3") * PX_TO_PT, labelGap: px("space-2") * PX_TO_PT, rowH: lineH * 1.15,
    barLine: hair * 2, tick: textPt * 0.25, tickLine: hair * 1.2, arrowLine: hair * 1.3,
  };
}

interface Level { readonly textPx: number; readonly pad: number; readonly gap: number; readonly leading: number }
const LEVELS: readonly Level[] = [
  { textPx: px("text-xs"), pad: 1, gap: 1, leading: px("leading-snug") },
  { textPx: px("text-2xs"), pad: 0.75, gap: 0.8, leading: px("leading-snug") },
  { textPx: MIN_TEXT_PT / PX_TO_PT, pad: 0.5, gap: 0.6, leading: px("leading-tight") },
  { textPx: MIN_TEXT_PT / PX_TO_PT, pad: 0.25, gap: 0.4, leading: px("leading-tight") },
];

export interface PdfInput {
  readonly model: ReportModel;
  readonly scene: Scene;
  readonly sim: SimulationResult;
  readonly roads: RoadNetwork | null;
  readonly fonts: BrandFonts;
  readonly mapThumbnail?: Uint8Array;
  /** File name of the scene file whose fingerprint is printed. */
  readonly sceneFileName: string;
  readonly createdAt: string;
}

export interface PdfPageReport {
  /** Page height in pt. */
  readonly height: number;
  /** Real drawn extents per region, top-left origin, from what was actually drawn. */
  readonly extents: Readonly<Record<Region, Extent>>;
  /** Lowest edge of anything that isn't the footer. */
  readonly bodyBottom: number;
  /** Top edge of the footer. */
  readonly footerTop: number;
  readonly footerBottom: number;
  readonly minTextPt: number;
  readonly minDiagramTextPt: number;
  /** Visible boxes of pictures on this page (the map thumbnail), after clipping. */
  readonly images: ReadonlyArray<{ x: number; y: number; w: number; h: number }>;
  /** When the map fallback (road outline) was drawn: how it was framed and where its parts sit. */
  readonly mapOutline?: {
    readonly spanM: number;
    /** The pin in the roads' frame (meters): what the outline is centered on. */
    readonly centerM: { x: number; y: number };
    readonly diagramWidthPt: number;
    readonly diagramScale: number;
    readonly box: { x: number; y: number; w: number; h: number };
    readonly pin: readonly [number, number];
    readonly pinRadius: number;
    readonly credit: { x: number; y: number; w: number; h: number };
    /** The place and coordinates caption under the map, as drawn. */
    readonly caption: ReadonlyArray<{ text: string; font: string; color: string }>;
    readonly captionBox: { x: number; y: number; w: number; h: number };
  };
  /** The north arrow (with its "N") and the chip it shares with the scale bars, in the diagram, as drawn. */
  readonly north?: {
    readonly arrow: { x: number; y: number; w: number; h: number };
    readonly chip: { x: number; y: number; w: number; h: number };
    /** The diagram box, and what must stay clear of the chip: vehicles, run-up and impact ring. */
    readonly box: { x: number; y: number; w: number; h: number };
    readonly keep: ReadonlyArray<{ x: number; y: number; w: number; h: number }>;
    /** Each scale bar (line, caps and end ticks) and its label, as drawn. */
    readonly bars: ReadonlyArray<{ bar: { x: number; y: number; w: number; h: number }; label: { x: number; y: number; w: number; h: number } }>;
  };
  /** The street names drawn at the pin on the map picture or the outline (their boxes include the halo). */
  readonly mapLabels?: ReadonlyArray<{ text: string; rotateDeg: number; box: { x: number; y: number; w: number; h: number } }>;
  /** The pin (with its ring) and the credit chip on the map, when street names were placed around them. */
  readonly mapPin?: { x: number; y: number; w: number; h: number };
  readonly mapCredit?: { x: number; y: number; w: number; h: number };
  /** Every run of text drawn on the page, with its glyph box. */
  readonly texts: ReadonlyArray<{ region: Region; text: string; box: { x: number; y: number; w: number; h: number } }>;
  /** The vehicles table as drawn: its box (header row and rows), the column edges, and the note under it when there is one. */
  readonly table?: { readonly box: { x: number; y: number; w: number; h: number }; readonly cols: readonly number[]; readonly foot: { x: number; y: number; w: number; h: number } | null };
}

export interface PdfResult {
  readonly bytes: Uint8Array;
  readonly pages: number;
  /** "one-page", or "overflow" when the assumptions and warnings moved to the next page(s). */
  readonly mode: "one-page" | "overflow";
  readonly level: number;
  /** Plain-language notes for the person saving. */
  readonly notes: readonly string[];
  readonly report: readonly PdfPageReport[];
}

/** fontkit can't subset WOFF2, and the PDF needs a subset TrueType/CFF font, so check before embedding. */
function checkFontFormats(fonts: BrandFonts) {
  for (const [name, bytes] of Object.entries(fonts)) {
    const sig = String.fromCharCode(bytes[0] ?? 0, bytes[1] ?? 0, bytes[2] ?? 0, bytes[3] ?? 0);
    if (sig === "wOF2") throw new Error(`The ${name} brand font is a WOFF2 file. The PDF can embed TTF, OTF or WOFF fonts.`);
  }
}

/* ------------------------------------------------------------------ layout kit */

interface Metrics {
  readonly M: number; readonly W: number; readonly H: number; readonly CW: number;
  readonly colGap: number; readonly colW: number;
  readonly body: number; readonly small: number; readonly meta: number;
  readonly gapBig: number; readonly gapMid: number; readonly gapSm: number;
  readonly radius: number; readonly hair: number; readonly pad: number; readonly leading: number;
}
interface Info { readonly page: number; readonly total: number }
type Op = (c: PdfCanvas, info: Info) => void;

/** Everything drawn on one page, recorded as operations and replayed once the page count is known. */
class Sheet {
  readonly ops: Array<{ region: Region; fn: Op }> = [];
  /** Height of the page header (logo, rule, title), measured before the blocks are built. */
  headerH = 0;
  /** "Claim X", set once the page count is known (read when the header is drawn). */
  claimText = "";
  constructor(readonly cv: PdfCanvas, readonly m: Metrics) {}
  add(region: Region, fn: Op) { this.ops.push({ region, fn }); }
  lh = (s: number) => s * this.m.leading;
  wOf = (f: FontKey, s: number) => (t: string) => this.cv.measure(f, s, t);
  lines(text: string, w: number, f: FontKey, s: number): string[] { return wrapText(text, w, this.wOf(f, s)); }
  text(region: Region, at: Pt, text: string, font: FontKey, size: number, col: string, extra: { anchor?: "start" | "middle" | "end"; tracking?: number } = {}) {
    this.add(region, (c) => c.text({ k: "text", at, text, font, size, color: col, ...extra }));
  }
  /** Wrapped lines from the top edge y; returns the height used. */
  block(region: Region, x: number, y: number, ls: readonly string[], font: FontKey, size: number, col: string): number {
    ls.forEach((l, i) => this.text(region, [x, y + this.lh(size) * i + this.lh(size) * 0.5 + size * 0.35], l, font, size, col));
    return ls.length * this.lh(size);
  }
  box(region: Region, x: number, y: number, w: number, h: number, fill?: string, stroke?: string, r = this.m.radius) {
    this.add(region, (c) => c.poly(roundedRectPts(x, y, w, h, r, 5), true, fill, stroke ? { color: stroke, width: this.m.hair } : undefined));
  }
}

function metricsFor(cv: PdfCanvas, L: Level): Metrics {
  const W = cv.page.getWidth();
  const H = cv.page.getHeight();
  const M = px("size-page-margin") * PX_TO_PT;
  const CW = W - 2 * M;
  const colGap = px("space-4") * PX_TO_PT;
  const body = Math.max(MIN_TEXT_PT, L.textPx * PX_TO_PT);
  return {
    M, W, H, CW, colGap, colW: (CW - colGap) / 2,
    body, small: Math.max(MIN_TEXT_PT, body * 0.9), meta: Math.max(MIN_TEXT_PT, body * 0.92),
    gapBig: px("space-4") * PX_TO_PT * L.gap, gapMid: px("space-3") * PX_TO_PT * L.gap, gapSm: px("space-2") * PX_TO_PT * L.gap,
    radius: px("radius-xs") * PX_TO_PT, hair: px("size-border") * PX_TO_PT, pad: L.pad, leading: L.leading,
  };
}

/* ------------------------------------------------------------------ header and footer */

/** Logo, claim number, rule and title. Returns the y below it. */
function header(s: Sheet, first: boolean): number {
  const { M, CW, gapSm, body, small } = s.m;
  const logo = lockup(px("space-8") * PX_TO_PT);
  const mark = logo.markH;
  const wordSize = logo.wordSize;
  let y = M;
  const top = y;
  // The official mark (the supplied path data) and the wordmark in Plus Jakarta Sans 700.
  s.add("header", (c) => drawMarkPdf(c.page, M, c.height - top, mark));
  const wx = M + logo.markW + logo.gap;
  const wy = top + logo.baseline;
  s.text("header", [wx, wy], WORDMARK.lead, "sansBold", wordSize, color("color-text"));
  s.add("header", (c) => {
    c.text({ k: "text", at: [wx + c.measure("sansBold", wordSize, WORDMARK.lead), wy], text: WORDMARK.accent, font: "sansBold", size: wordSize, color: color("color-logo") });
  });
  s.add("header", (c, info) => {
    const parts = [s.claimText, info.total > 1 ? `Page ${info.page} of ${info.total}` : ""].filter(Boolean).join(" · ");
    if (parts) c.text({ k: "text", at: [M + CW, wy], text: parts, font: "sans", size: body, color: color("color-text-secondary"), anchor: "end" });
  });
  y += mark + gapSm * 0.8;
  const ruleY = y;
  s.add("header", (c) => c.poly([[M, ruleY], [M + CW, ruleY]], false, undefined, { color: color("color-brand"), width: px("size-focus-ring") * PX_TO_PT }));
  y += px("size-focus-ring") * PX_TO_PT + gapSm;
  const titleS = px("text-xl") * PX_TO_PT * Math.min(1, 0.75 + (s.m.gapBig / (px("space-4") * PX_TO_PT)) * 0.25);
  s.text("header", [M, y + titleS * 1.0], "Crash scene illustration", "sansBold", titleS, color("color-text"));
  const sub = "Illustration only. Made from the details the claimant entered.";
  // The subtitle shares the title's line when both fit, which saves a line on page 1.
  const inline = first && s.cv.measure("sansBold", titleS, "Crash scene illustration") + s.cv.measure("sans", small, sub) + gapSm * 2 <= CW;
  if (inline) {
    s.text("header", [M + CW, y + titleS * 1.0], sub, "sans", small, color("color-text-tertiary"), { anchor: "end" });
    y += s.lh(titleS);
  } else {
    y += s.lh(titleS);
    if (first) {
      s.text("header", [M, y + s.lh(small) * 0.5 + small * 0.35], sub, "sans", small, color("color-text-tertiary"));
      y += s.lh(small);
    }
  }
  return y + s.m.gapMid;
}

/** The full footer. Returns its height; draw(top) places it. */
function footer(s: Sheet, input: PdfInput): { height: number; draw: (top: number) => void } {
  const { M, CW, gapSm, meta, body, hair, pad } = s.m;
  const { model } = input;
  const discPad = px("space-2") * PX_TO_PT * pad;
  const discX = px("space-3") * PX_TO_PT * pad;
  const discLines = s.lines(DISCLAIMER_LONG, CW - 2 * discX, "sans", body);
  const discH = discLines.length * s.lh(body) + discPad * 2;
  const attribution = [OSM_CREDIT, ...(input.roads?.attribution ?? []).filter((a) => !/openstreetmap/i.test(a))];
  const runs: Array<{ t: string; f: FontKey; c: string }> = [
    { t: "Made ", f: "sans", c: color("color-text-secondary") },
    { t: model.stampLocal, f: "sansBold", c: color("color-text") },
    { t: " · ", f: "sans", c: color("color-text-secondary") },
    { t: model.stampUtc, f: "mono", c: color("color-text-secondary") },
    { t: "     Fingerprint ", f: "sans", c: color("color-text-secondary") },
    { t: model.fingerprintShort, f: "mono", c: color("color-text") },
    { t: `     Map ${attribution.join("; ")}`, f: "sans", c: color("color-text-secondary") },
  ];
  const metaW = runs.reduce((a, r) => a + s.cv.measure(r.f, meta, r.t), 0);
  const split = metaW > CW;
  const sentence = "Hash the scene file with SHA-256. If it doesn't match, the scene was changed after export.";
  // The hash sits on its own line at the normal footer size; a long file name wraps above it.
  const fileLines = s.lines(`SHA-256 of ${input.sceneFileName}:`, CW, "sans", meta);
  const headW = s.cv.measure("sansBold", meta, "How to check this file  ");
  const checkInline = headW + s.cv.measure("sans", meta, sentence) <= CW;
  const checkLines = checkInline ? 1 : 2;
  const height =
    hair + gapSm + discH + gapSm + (split ? s.lh(meta) * 2 : s.lh(meta)) + gapSm * 0.5 +
    s.lh(meta) * (checkLines + fileLines.length + 1);
  const draw = (top: number) => {
    let y = top;
    const r0 = y;
    s.add("footer", (c) => c.poly([[M, r0 + hair / 2], [M + CW, r0 + hair / 2]], false, undefined, { color: color("color-border-strong"), width: hair }));
    y += hair + gapSm;
    s.box("footer", M, y, CW, discH, color("color-warning-tint"));
    s.block("footer", M + discX, y + discPad, discLines, "sans", body, color("color-warning-tint-text"));
    y += discH + gapSm;
    const drawRuns = (rs: typeof runs, yy: number) => {
      let x = M;
      for (const r of rs) { s.text("footer", [x, yy + s.lh(meta) * 0.5 + meta * 0.35], r.t, r.f, meta, r.c); x += s.cv.measure(r.f, meta, r.t); }
    };
    if (split) {
      drawRuns(runs.slice(0, 4), y); y += s.lh(meta);
      drawRuns(runs.slice(4).map((r, i) => (i === 0 ? { ...r, t: r.t.trimStart() } : r)), y); y += s.lh(meta);
    } else { drawRuns(runs, y); y += s.lh(meta); }
    y += gapSm * 0.5;
    const base = (yy: number, sz: number) => yy + s.lh(sz) * 0.5 + sz * 0.35;
    s.text("footer", [M, base(y, meta)], "How to check this file", "sansBold", meta, color("color-text"));
    if (checkInline) {
      s.text("footer", [M + headW, base(y, meta)], sentence, "sans", meta, color("color-text-secondary"));
      y += s.lh(meta);
    } else {
      y += s.lh(meta);
      s.text("footer", [M, base(y, meta)], sentence, "sans", meta, color("color-text-secondary"));
      y += s.lh(meta);
    }
    y += s.block("footer", M, y, fileLines, "sans", meta, color("color-text-secondary"));
    s.text("footer", [M, base(y, meta)], model.fingerprintFull, "mono", meta, color("color-text"));
  };
  return { height, draw };
}

/* ------------------------------------------------------------------ blocks */

interface Block {
  readonly h: number;
  /** Space above this block when it isn't first on its page. */
  readonly gapBefore: number;
  readonly kind: "main" | "warn";
  /** What the section is called, for the "continued on page 2" line. */
  readonly name?: string;
  /** Start a new page before this block (the overflow lists begin on page 2). */
  readonly breakBefore?: boolean;
  readonly draw: (s: Sheet, y: number) => void;
}

/** Section names as a list: "a, b and c". */
function listOf(parts: readonly string[]): string {
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : (parts[0] ?? "");
}
/** What moved to the next page(s), in words: the sections that didn't fit, the assumptions, and the warnings when there are any. */
function movedList(moved: readonly string[], hasWarnings: boolean): string {
  return listOf([...moved.map((n) => n.toLowerCase()), "assumptions", ...(hasWarnings ? ["details that may not fit together"] : [])]);
}
const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

interface Built {
  /** What moved to page 2 in the standard split, in words (also used for the note to the app). */
  readonly movedList: string;
  /** A plain one-line "… continued on page 2" block for when the sections it names moved. */
  readonly placeholder: (text: string) => Block;
  /** Blocks of page 1 (one-page mode: everything; split mode: the sections above the assumptions). */
  readonly first: readonly Block[];
  /** Overflow blocks that follow (the whole assumption and warning lists in overflow mode). */
  readonly rest: readonly Block[];
  readonly footerH: number;
  /**
   * Split mode: the assumptions section of page 1 holding as many whole assumptions as fit in `room` (pt, the
   * section's heading and its "continued on page 2" line included), and the lists that follow on the next pages.
   */
  readonly fill?: (room: number) => { readonly block: Block; readonly shown: number; readonly rest: readonly Block[]; readonly movedText: string };
}

/** Split items into two columns of nearly equal height, keeping their order (left column first). */
function twoColumns<T extends { h: number }>(items: readonly T[]): { left: T[]; right: T[]; leftH: number; rightH: number } {
  const total = items.reduce((a, it) => a + it.h, 0);
  let best = 0;
  let bestMax = Infinity;
  let run = 0;
  for (let k = 0; k <= items.length; k++) {
    const m = Math.max(run, total - run);
    if (m < bestMax) { bestMax = m; best = k; }
    run += items[k]?.h ?? 0;
  }
  const left = items.slice(0, best);
  const right = items.slice(best);
  return { left: [...left], right: [...right], leftH: left.reduce((a, it) => a + it.h, 0), rightH: right.reduce((a, it) => a + it.h, 0) };
}

/** Fill two columns in order (left first) up to `cap` each: how many items fit, and the columns. */
function fillColumns<T extends { h: number }>(items: readonly T[], cap: number): { left: T[]; right: T[]; leftH: number; rightH: number; shown: number } {
  const cols: [T[], T[]] = [[], []];
  const hs = [0, 0];
  let c = 0;
  let shown = 0;
  for (const it of items) {
    while (c < 2 && hs[c]! + it.h > cap) c++;
    if (c >= 2) break;
    cols[c]!.push(it);
    hs[c]! += it.h;
    shown++;
  }
  return { left: cols[0], right: cols[1], leftH: hs[0]!, rightH: hs[1]!, shown };
}

/** "Assumptions 9 to 16", "Assumption 16" or "Assumptions" (none shown yet): what of the list still has to come. */
function assumptionsLeft(shown: number, total: number): string {
  if (shown <= 0) return "assumptions";
  return total - shown === 1 ? `assumption ${total}` : `assumptions ${shown + 1} to ${total}`;
}

function buildBlocks(s: Sheet, input: PdfInput, thumb: PDFImage | null, mode: "full" | "split", footerH: number, laterRoom: number): Built {
  const { model } = input;
  const m = s.m;
  const { M, CW, colW, colGap, body, small, gapBig, gapSm, hair, radius, pad } = m;
  const lh = s.lh;
  const rx = M + colW + colGap;
  const headingH = (): number => lh(Math.max(MIN_TEXT_PT, body * 0.95)) + gapSm * 0.3;
  const heading = (sh: Sheet, region: Region, x: number, y: number, text: string): number => {
    const sz = Math.max(MIN_TEXT_PT, body * 0.95);
    sh.text(region, [x, y + sz * 1.0], text.toUpperCase(), "sansBold", sz, color("color-brand"), { tracking: sz * 0.18 });
    return headingH();
  };

  /* Top row: location and time (left), diagram (right). */
  const kv: Array<{ k: string; v: string; mono?: boolean }> = [
    { k: "Place", v: model.place },
    { k: "Coordinates", v: model.coordinates, mono: true },
    { k: "Date and time", v: model.occurred },
    { k: "Road", v: model.road },
  ];
  const labelW = Math.max(...kv.map((r) => s.cv.measure("sans", body, r.k))) + gapSm;
  const kvRows = kv.map((r) => ({ ...r, ls: s.lines(r.v, colW - labelW, r.mono ? "mono" : "sans", body) }));
  const kvH = kvRows.reduce((a, r) => a + r.ls.length * lh(body) + pad * 1.5, 0);
  const caption = "Vehicles at final rest. Dashed: path before impact. Faint outline: position at impact. Red ring: point of impact. Numbers match Key measurements.";
  const capLines = s.lines(caption, CW, "sans", small);
  const capH = capLines.length * lh(small);
  // The diagram keeps at least MIN_DIAGRAM_FRACTION of the page's room above the footer, so it stays readable.
  const minDia = (m.H - 2 * m.M - footerH - s.headerH) * MIN_DIAGRAM_FRACTION;
  const noteH = lh(small) * 3 + gapSm;
  // With the road outline (no map picture) the place and coordinates sit as a caption under the map, in full.
  const outlineMap = !thumb && !!input.roads;
  const mapCaption = outlineMap
    ? [...s.lines(model.place, colW, "sans", small).map((t) => ({ t, f: "sans" as FontKey })), { t: model.coordinates, f: "mono" as FontKey }]
    : [];
  const mapCaptionH = outlineMap ? mapCaption.length * lh(small) + gapSm * 0.3 : 0;
  // Map and diagram share one row; the caption runs full width under both.
  const rowContentH = Math.max(minDia, kvH + gapSm * 0.5 + (thumb ? colW / 2 : outlineMap ? colW / 3 : noteH) + mapCaptionH);
  const diaH = rowContentH;
  const mapH = rowContentH - kvH - gapSm * 0.5 - mapCaptionH;
  const topH = headingH() + rowContentH + gapSm * 0.4 + capH;

  const top: Block = {
    h: topH, gapBefore: 0, kind: "main",
    draw: (sh, y) => {
      heading(sh, "body", M, y, "Location and time");
      heading(sh, "body", rx, y, "Top-down diagram");
      let ky = y + headingH();
      for (const r of kvRows) {
        sh.text("body", [M, ky + lh(body) * 0.5 + body * 0.35], r.k, "sans", body, color("color-text-tertiary"));
        sh.block("body", M + labelW, ky, r.ls, r.mono ? "mono" : "sans", body, color("color-text"));
        ky += r.ls.length * lh(body) + pad * 1.5;
      }
      const diaBox: Box = { x: rx, y: y + headingH(), w: colW, h: diaH };
      const diaOpts = {
        box: diaBox, letters: true, markers: true, streetLabels: true, ghosts: true,
        minTextSize: MIN_DIAGRAM_TEXT_PT, minLine: hair * 0.8, minTagRadius: MIN_DIAGRAM_TEXT_PT * 0.8,
      };
      // The north arrow and the scale bars sit on one chip in a corner of the diagram. The picture is planned once to
      // know its scale, the chip goes in the first corner that no vehicle, run-up or impact ring is under, and the
      // picture is planned again with the chip as an obstacle so street names and markers keep clear of it.
      const plan0 = planDiagram(input.sim, input.roads, diaOpts, sh.cv.measure);
      const cs = MIN_DIAGRAM_TEXT_PT;
      const chipStyle = pdfChipStyle(cs, lh(cs), hair);
      const inset = gapSm * 0.5;
      const clash = (c: { x: number; y: number; w: number; h: number }) => plan0.keep.some((k) => k.x < c.x + c.w + inset && c.x < k.x + k.w + inset && k.y < c.y + c.h + inset && c.y < k.y + k.h + inset);
      // When no corner is clear, shorter bars make a narrower chip (each bar stays exact in its unit).
      let found: { chip: { x: number; y: number; w: number; h: number }; barList: Array<{ label: string; px: number }> } | null = null;
      for (const share of CHIP_BAR_SHARES) {
        const bars = scaleBars(plan0.scale, colW * share);
        const barList = [bars.metric, bars.us];
        const { w: chipW, h: chipH } = scaleChip([0, 0], barList, chipStyle, sh.cv.measure).rect;
        const corners = [
          { x: diaBox.x + inset, y: diaBox.y + diaBox.h - chipH - inset },
          { x: diaBox.x + diaBox.w - chipW - inset, y: diaBox.y + diaBox.h - chipH - inset },
          { x: diaBox.x + diaBox.w - chipW - inset, y: diaBox.y + inset },
          { x: diaBox.x + inset, y: diaBox.y + inset },
        ].map((c) => ({ ...c, w: chipW, h: chipH }));
        const clear = corners.find((c) => !clash(c));
        if (clear || !found) found = { chip: clear ?? corners[0]!, barList };
        if (clear) break;
      }
      const { chip, barList } = found!;
      const plan = planDiagram(input.sim, input.roads, { ...diaOpts, obstacles: [chip] }, sh.cv.measure);
      const chipLayout = scaleChip([chip.x, chip.y], barList, chipStyle, sh.cv.measure);
      const mapBox: Box = { x: M, y: ky + gapSm * 0.5, w: colW, h: mapH };
      sh.add("body", (c) => {
        const { x, y: by, w, h } = mapBox;
        if (thumb) {
          c.clipPath(roundedRectPts(x, by, w, h, radius, 5));
          const k = Math.max(w / thumb.width, h / thumb.height);
          const iw = thumb.width * k;
          const ih = thumb.height * k;
          c.image(thumb, x + (w - iw) / 2, by + (h - ih) / 2, iw, ih);
          c.unclip();
          const cs = small;
          const tw = c.measure("sans", cs, OSM_CREDIT) + gapSm;
          const credit = { x: x + w - tw, y: by + h - lh(cs) - 1, w: tw, h: lh(cs) + 1 };
          // The tiles have their own labels, which can be tiny or cut off: our names for the streets at the pin go on top, when the
          // picture says how big a pixel is (the picture is centered on the pin, so the pin is the middle of the box).
          const mpp = input.mapThumbnail ? thumbnailMetersPerPixel(input.mapThumbnail) : null;
          if (input.roads && mpp) {
            const pinHalf = (THUMB_PIN_IMAGE_PX + THUMB_RING_IMAGE_PX) * k;
            const pinRect = { x: x + w / 2 - pinHalf, y: by + h / 2 - pinHalf, w: pinHalf * 2, h: pinHalf * 2 };
            const names = planPinStreetLabels(input.roads, {
              box: mapBox, center: toLocal(input.roads.frame, input.scene.location), scale: k / mpp, size: MIN_TEXT_PT,
              names: input.scene.vehicles.flatMap((v) => (v.travel.roadName ? [v.travel.roadName] : [])),
              keepClear: [pinRect, credit],
            }, c.measure);
            c.marks.mapPin = pinRect;
            c.marks.mapCredit = credit;
            c.clipPath(roundedRectPts(x, by, w, h, radius, 5));
            c.replay(names.prims);
            c.unclip();
            c.marks.mapLabels = names.labels;
          }
          c.poly(roundedRectPts(x + w - tw, by + h - lh(cs) - 1, tw, lh(cs) + 1, 0, 1), true, color("color-surface"));
          c.text({ k: "text", at: [x + w - tw + gapSm / 2, by + h - lh(cs) * 0.5 - 1 + cs * 0.35], text: OSM_CREDIT, font: "sans", size: cs, color: color("color-text-secondary") });
        } else if (input.roads) {
          // No map picture: the road outline around the pin (a map of the place, from OSM roads) with the names of the streets
          // that meet at the pin and the credit; the place and coordinates are a caption under the map, never over it (DESIGN.md section 9).
          const pinLocal = toLocal(input.roads.frame, input.scene.location);
          const cs = small;
          const pinR = MIN_TEXT_PT * 0.6;
          const tw = c.measure("sans", cs, OSM_DATA_CREDIT) + gapSm;
          const credit = { x: x + w - tw, y: by + h - lh(cs) - 1, w: tw, h: lh(cs) + 1 };
          const spanM = Math.max((diaBox.w / plan.scale) * 2, MIN_OUTLINE_SPAN_M);
          const outline = planRoadOutline(input.roads, mapBox, {
            spanM, minTextSize: MIN_TEXT_PT, minLine: hair * 0.8, pinRadius: pinR, center: pinLocal, keepClear: [credit],
            streetNames: input.scene.vehicles.flatMap((v) => (v.travel.roadName ? [v.travel.roadName] : [])),
          }, c.measure);
          const capY = by + h + gapSm * 0.3;
          c.marks.mapOutline = {
            spanM, centerM: pinLocal, diagramWidthPt: diaBox.w, diagramScale: plan.scale, box: { x, y: by, w, h }, pin: outline.pin, pinRadius: pinR,
            credit, caption: mapCaption.map((l) => ({ text: l.t, font: l.f, color: color("color-text") })),
            captionBox: { x, y: capY, w, h: mapCaption.length * lh(cs) },
          };
          c.marks.mapLabels = outline.labels;
          c.marks.mapPin = { x: outline.pin[0] - pinR * 1.5, y: outline.pin[1] - pinR * 1.5, w: pinR * 3, h: pinR * 3 };
          c.marks.mapCredit = credit;
          c.clipPath(roundedRectPts(x, by, w, h, radius, 5));
          c.replay(outline.prims);
          c.unclip();
          c.poly(roundedRectPts(credit.x, credit.y, credit.w, credit.h, 0, 1), true, color("color-surface"));
          c.text({ k: "text", at: [credit.x + gapSm / 2, credit.y + lh(cs) * 0.5 + cs * 0.35], text: OSM_DATA_CREDIT, font: "sans", size: cs, color: color("color-text-secondary") });
          mapCaption.forEach((l, i) => c.text({ k: "text", at: [x, capY + lh(cs) * i + lh(cs) * 0.5 + cs * 0.35], text: l.t, font: l.f, size: cs, color: color("color-text") }));
        } else {
          c.poly(roundedRectPts(x, by, w, h, radius, 5), true, color("color-scene-ground"));
          const note = `Map not available. ${model.place}. Coordinates ${model.coordinates}.`;
          const ls = wrapText(note, w - gapSm * 2, sh.wOf("sans", small));
          ls.forEach((l, i) => c.text({ k: "text", at: [x + w / 2, by + h / 2 + (i - (ls.length - 1) / 2) * lh(small) + small * 0.35], text: l, font: "sans", size: small, color: color("color-text-secondary"), anchor: "middle" }));
        }
        c.poly(roundedRectPts(x, by, w, h, radius, 5), true, undefined, { color: color("color-border"), width: hair });
      });
      sh.add("diagram", (c) => {
        c.replay(plan.prims);
        // Two scale bars (exact meters, exact feet) and the north arrow on a small chip, side by side with a gap between.
        c.poly(roundedRectPts(chip.x, chip.y, chip.w, chip.h, radius * 0.5, 3), true, color("color-surface"), { color: color("color-border"), width: hair });
        c.replay(scaleChipPrims(chipLayout, chipStyle, color("color-text"), color("color-border"), c.measure));
        c.marks.north = { arrow: chipLayout.arrow, chip, box: diaBox, keep: plan.keep, bars: chipLayout.bars.map((b) => ({ bar: b.box, label: b.labelBox })) };
        c.poly(roundedRectPts(diaBox.x, diaBox.y, diaBox.w, diaBox.h, radius, 5), true, undefined, { color: color("color-border"), width: hair });
      });
      sh.block("body", M, diaBox.y + diaH + gapSm * 0.4, capLines, "sans", small, color("color-text-secondary"));
    },
  };

  /* Vehicles table. A hit side the picture couldn't use keeps a short cell ("Front *"); its full wording is a note under the table. */
  const frac = [0.045, 0.165, 0.155, 0.21, 0.295, 0.13];
  const cw = frac.map((f) => f * CW);
  const cx = cw.reduce<number[]>((a, w, i) => (a.push((a[i] ?? M) + w), a), [M]);
  const padX = px("space-2") * PX_TO_PT * 0.75;
  const padY = px("space-2") * PX_TO_PT * 0.5 * pad;
  const headLabels = ["", "Vehicle", "Type, weight", "Direction", "Speed at impact, as entered", "Hit on"];
  const headLs = headLabels.map((t, i) => s.lines(t, cw[i]! - padX * 2, "sansBold", small));
  const tHeadH = Math.max(...headLs.map((l) => l.length)) * lh(small) + padY * 2;
  const bs = Math.min(cw[0]! - padX, px("space-5") * PX_TO_PT * Math.min(1, 0.6 + pad * 0.4));
  const rows = model.vehicles.map((v) => {
    const cells = [
      s.lines(v.name, cw[1]! - padX * 2, "sans", body),
      s.lines(v.typeWeight, cw[2]! - padX * 2, "sans", body),
      s.lines(v.direction, cw[3]! - padX * 2, "sans", body),
      s.lines(v.speed, cw[4]! - padX * 2, "mono", body),
      s.lines(v.hitOnShort, cw[5]! - padX * 2, "sans", body),
    ];
    // The notes may run under the one-line "Hit on" value, so they wrap wider.
    const noteW = cw[4]! + (cells[4]!.length === 1 ? cw[5]! : 0) - padX * 2;
    const noteLs = [...(v.brakingNote ? s.lines(v.brakingNote, noteW, "sans", small) : []), ...(v.speedNote ? s.lines(v.speedNote, noteW, "sans", small) : [])];
    const h = Math.max(Math.max(cells[0]!.length, cells[1]!.length, cells[2]!.length, cells[4]!.length) * lh(body), cells[3]!.length * lh(body) + noteLs.length * lh(small)) + padY * 2;
    return { v, cells, noteLs, h: Math.max(h, bs + hair * 2) };
  });
  const footLs = model.vehicles.filter((v) => v.hitOnAdjusted).flatMap((v) => s.lines(`${HIT_ON_MARK} ${v.id}: ${v.hitOn}.`, CW, "sans", small));
  const footGap = gapSm * 0.5;
  const table: Block = {
    h: headingH() + tHeadH + rows.reduce((a, r) => a + r.h, 0) + (footLs.length ? footGap + footLs.length * lh(small) : 0), gapBefore: gapBig, kind: "main", name: "Vehicles",
    draw: (sh, y0) => {
      let y = y0 + heading(sh, "body", M, y0, "Vehicles");
      sh.box("body", M, y, CW, tHeadH, color("color-surface-2"), undefined, 0);
      headLs.forEach((ls, i) => sh.block("body", cx[i]! + padX, y + padY, ls, "sansBold", small, color("color-text-secondary")));
      y += tHeadH;
      for (const r of rows) {
        const rowY = y;
        sh.add("body", (c) => {
          const cc: Pt = [cx[0]! + cw[0]! / 2, rowY + padY + Math.max(lh(body) / 2, bs / 2 - padY / 2)];
          c.circle(cc, bs / 2, vehicleColor(r.v.id));
          c.text({ k: "text", at: [cc[0], cc[1] + body * 0.3], text: r.v.id, font: "sansBold", size: Math.max(MIN_TEXT_PT, body * 0.85), color: color("color-text-on-brand"), anchor: "middle" });
          c.poly([[M, rowY + r.h], [M + CW, rowY + r.h]], false, undefined, { color: color("color-border"), width: hair });
        });
        sh.block("body", cx[1]! + padX, y + padY, r.cells[0]!, "sans", body, color("color-text"));
        sh.block("body", cx[2]! + padX, y + padY, r.cells[1]!, "sans", body, color("color-text"));
        sh.block("body", cx[3]! + padX, y + padY, r.cells[2]!, "sans", body, color("color-text"));
        const sph = sh.block("body", cx[4]! + padX, y + padY, r.cells[3]!, "mono", body, color("color-text"));
        sh.block("body", cx[4]! + padX, y + padY + sph, r.noteLs, "sans", small, color("color-text-tertiary"));
        sh.block("body", cx[5]! + padX, y + padY, r.cells[4]!, "sans", body, color("color-text"));
        y += r.h;
      }
      if (footLs.length) sh.block("body", M, y + footGap, footLs, "sans", small, color("color-text-tertiary"));
      const tableBox = { x: M, y: y0 + headingH(), w: CW, h: y - y0 - headingH() };
      sh.add("body", (c) => { c.marks.table = { box: tableBox, cols: cx, foot: footLs.length ? { x: M, y: y + footGap, w: CW, h: footLs.length * lh(small) } : null }; });
    },
  };

  /* Key measurements, then assumptions: each a full-width section whose items flow into two columns. */
  const markerD = Math.max(px("space-4") * PX_TO_PT * Math.min(1, 0.7 + pad * 0.3), MIN_TEXT_PT * 1.2);
  const valW = Math.max(...model.measurements.map((r) => s.cv.measure("mono", body, r.value)), 0);
  const labW = Math.max(colW - markerD - gapSm - valW - gapSm * 0.5, colW * 0.3);
  const mRows = model.measurements.map((r) => {
    const ls = s.lines(r.label, labW, "sans", body);
    return { r, ls, h: Math.max(ls.length * lh(body), markerD) + pad * 1.2 };
  });
  const mCols = twoColumns(mRows);
  const measures: Block = {
    h: headingH() + Math.max(mCols.leftH, mCols.rightH), gapBefore: gapBig, kind: "main", name: "Key measurements",
    draw: (sh, y0) => {
      heading(sh, "body", M, y0, "Key measurements");
      const col = (rowsIn: typeof mRows, x: number) => {
        let my = y0 + headingH();
        for (const r of rowsIn) {
          const rowY = my;
          if (r.r.marker !== null) {
            const n = r.r.marker;
            sh.add("body", (c) => {
              const cc: Pt = [x + markerD / 2, rowY + lh(body) / 2];
              c.circle(cc, markerD / 2, color("color-scene-measure"));
              c.text({ k: "text", at: [cc[0], cc[1] + MIN_TEXT_PT * 0.35], text: String(n), font: "sansBold", size: MIN_TEXT_PT, color: color("color-surface"), anchor: "middle" });
            });
          }
          sh.block("body", x + markerD + gapSm * 0.8, my, r.ls, "sans", body, color("color-text"));
          sh.text("body", [x + colW, my + lh(body) * 0.5 + body * 0.35], r.r.value, "mono", body, color("color-text"), { anchor: "end" });
          my += r.h;
        }
      };
      col(mCols.left, M);
      col(mCols.right, rx);
    },
  };

  const bullet = px("space-4") * PX_TO_PT * 0.7;
  // Assumptions are numbered (DESIGN.md section 8): "1.", "2.", ... and the numbering carries onto the overflow pages.
  const numW = s.cv.measure("sans", body, `${model.assumptions.length}.`) + body * 0.7;
  const aItems = model.assumptions.map((a, i) => { const ls = s.lines(a, colW - numW, "sans", body); return { n: i + 1, ls, h: ls.length * lh(body) + pad * 1.2 }; });
  type AItem = (typeof aItems)[number];
  /** The assumptions section: its heading, the items in two columns and, when some of it moves on, the "continued" line. */
  const assumptionsBlock = (cols: { left: readonly AItem[]; right: readonly AItem[]; leftH: number; rightH: number }, cont: string | null): Block => {
    const colsH = Math.max(cols.leftH, cols.rightH);
    const contGap = colsH > 0 ? gapSm * 0.5 : 0;
    return {
      h: headingH() + colsH + (cont ? contGap + lh(body) + pad : 0), gapBefore: gapBig, kind: "main",
      draw: (sh, y0) => {
        heading(sh, "body", M, y0, "Assumptions used");
        const col = (items: readonly AItem[], x: number) => {
          let ay = y0 + headingH();
          for (const it of items) {
            sh.text("body", [x, ay + lh(body) * 0.5 + body * 0.35], `${it.n}.`, "sans", body, color("color-text-secondary"));
            sh.block("body", x + numW, ay, it.ls, "sans", body, color("color-text"));
            ay += it.h;
          }
        };
        col(cols.left, M);
        col(cols.right, rx);
        if (cont) sh.block("body", M, y0 + headingH() + colsH + contGap, [cont], "sans", body, color("color-text-secondary"));
      },
    };
  };

  const first: Block[] = mode === "full" ? [top, table, measures, assumptionsBlock(twoColumns(aItems), null)] : [top, table, measures];
  const placeholder = (text: string): Block => ({
    h: lh(body) + pad, gapBefore: gapBig, kind: "main",
    draw: (sh, y) => { sh.block("body", M, y, [text], "sans", body, color("color-text-secondary")); },
  });

  /* Warnings. */
  const lead = "Details that may not fit together: ";
  if (mode === "full") {
    if (model.warnings.length) {
      const inner = CW - 2 * gapSm;
      const ls = s.lines(`${lead}${model.warnings.join(" ")}`, inner, "sans", body);
      const discPad = px("space-2") * PX_TO_PT * pad;
      first.push({
        h: ls.length * lh(body) + discPad * 2, gapBefore: gapSm * 1.5, kind: "main",
        draw: (sh, y) => {
          sh.box("body", M, y, CW, ls.length * lh(body) + discPad * 2, color("color-warning-tint"));
          ls.forEach((l, i) => {
            const ty = y + discPad + lh(body) * i + lh(body) * 0.5 + body * 0.35;
            if (i === 0) {
              sh.text("body", [M + gapSm, ty], lead, "sansBold", body, color("color-warning-tint-text"));
              sh.add("body", (c) => c.text({ k: "text", at: [M + gapSm + c.measure("sansBold", body, lead), ty], text: l.slice(lead.length), font: "sans", size: body, color: color("color-warning-tint-text") }));
            } else sh.text("body", [M + gapSm, ty], l, "sans", body, color("color-warning-tint-text"));
          });
        },
      });
    }
    return { first, rest: [], footerH, placeholder, movedList: "" };
  }

  /* Overflow: the lists, full width, on the pages that follow. */
  const bulletBlocks = (text: string, kind: "main" | "warn", textCol: string, dot: string, gapBefore: number, n?: number): Block[] => {
    const lead = n === undefined ? bullet : numW;
    const ls = s.lines(text, CW - lead - (kind === "warn" ? gapSm : 0), "sans", body);
    const extra = pad * 1.2 + (kind === "warn" ? pad : 0);
    // An item is never cut between pages, unless it alone is taller than a whole page: then it breaks between lines,
    // with its number or bullet on the first part.
    const per = Math.max(1, Math.floor((laterRoom - extra) / lh(body)));
    const parts: string[][] = [];
    for (let i = 0; i < ls.length; i += per) parts.push(ls.slice(i, i + per));
    return parts.map((part, j) => ({
      h: part.length * lh(body) + extra, gapBefore: j === 0 ? gapBefore : 0, kind,
      draw: (sh, y) => {
        const off = kind === "warn" ? gapSm : 0;
        const ty = y + (kind === "warn" ? pad * 0.5 : 0);
        if (j === 0) {
          if (n === undefined) sh.add("body", (c) => c.circle([M + off + bullet * 0.3, ty + lh(body) / 2], body * 0.12, dot));
          else sh.text("body", [M, ty + lh(body) * 0.5 + body * 0.35], `${n}.`, "sans", body, color("color-text-secondary"));
        }
        sh.block("body", M + off + lead, ty, part, "sans", body, textCol);
      },
    }));
  };
  const headBlock = (text: string, gapBefore: number, kind: "main" | "warn"): Block => ({
    h: headingH() + (kind === "warn" ? gapSm * 0.5 : 0), gapBefore, kind,
    draw: (sh, y) => { heading(sh, "body", kind === "warn" ? M + gapSm : M, y + (kind === "warn" ? gapSm * 0.5 : 0), text); },
  });
  /** The lists that follow page 1 when its first `shown` assumptions are on it. */
  const restFrom = (shown: number): Block[] => {
    const rest: Block[] = [];
    const left = model.assumptions.slice(shown);
    if (left.length) {
      rest.push({ ...headBlock(shown > 0 ? "Assumptions used (continued)" : "Assumptions used", gapBig, "main"), breakBefore: true });
      left.forEach((a, i) => rest.push(...bulletBlocks(a, "main", color("color-text"), color("color-text"), 0, shown + i + 1)));
    }
    if (model.warnings.length) {
      const wh = headBlock("Details that may not fit together", gapBig, "warn");
      rest.push(left.length ? wh : { ...wh, breakBefore: true });
      for (const w of model.warnings) rest.push(...bulletBlocks(w, "warn", color("color-warning-tint-text"), color("color-warning-tint-text"), 0));
    }
    return rest;
  };
  // Page 1 takes as many whole assumptions as fit in the room left under the other sections (in the same two
  // columns as a one-page summary); only the rest, and the warnings, move on, and a line says what moved.
  const fill = (room: number) => {
    const contH = gapSm * 0.5 + lh(body) + pad;
    const total = aItems.length;
    const greedy = fillColumns(aItems, room - headingH() - contH);
    const all = greedy.shown === total;
    const shown = greedy.shown;
    const moved = [...(all ? [] : [assumptionsLeft(shown, total)]), ...(model.warnings.length ? ["details that may not fit together"] : [])];
    const movedText = listOf(moved);
    const cols = all ? twoColumns(aItems) : greedy;
    const block = assumptionsBlock(cols, moved.length ? `${cap(movedText)} continued on page 2` : null);
    return { block, shown, rest: restFrom(shown), movedText };
  };
  return { first, rest: restFrom(0), footerH, placeholder, movedList: movedList([], model.warnings.length > 0), fill };
}

/* ------------------------------------------------------------------ pagination */

interface Placed { readonly block: Block; readonly y: number }

/** Flow blocks onto pages. A block never straddles a page; the first page starts at `top1`, later ones at `top2`. */
function paginate(blocks: readonly Block[], top1: number, top2: number, limit: number): Placed[][] {
  const pages: Placed[][] = [[]];
  let y = top1;
  for (const b of blocks) {
    const cur = pages[pages.length - 1]!;
    const gap = cur.length === 0 ? 0 : b.gapBefore;
    const forced = b.breakBefore === true && cur.length > 0 && pages.length === 1;
    if (cur.length > 0 && (forced || y + gap + b.h > limit)) {
      pages.push([{ block: b, y: top2 }]);
      y = top2 + b.h;
    } else {
      cur.push({ block: b, y: y + gap });
      y += gap + b.h;
    }
  }
  return pages;
}

/* ------------------------------------------------------------------ entry point */

export async function buildPdf(input: PdfInput): Promise<PdfResult> {
  checkFontFormats(input.fonts);
  const { model } = input;
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const fonts: PdfFonts = {
    sans: await doc.embedFont(input.fonts.sansRegular, { subset: true }),
    sansBold: await doc.embedFont(input.fonts.sansBold, { subset: true }),
    mono: await doc.embedFont(input.fonts.monoRegular, { subset: true }),
  };
  const pageW = px("size-page-w") * PX_TO_PT;
  const pageH = px("size-page-h") * PX_TO_PT;
  const notes: string[] = [];

  let thumb: PDFImage | null = null;
  if (input.mapThumbnail) {
    try { thumb = await doc.embedPng(input.mapThumbnail); } catch { notes.push(input.roads ? "The map picture couldn't be read, so the PDF shows the road outline instead." : "The map picture couldn't be read, so the PDF says the map isn't available."); }
  }

  // Measuring needs a canvas; use a scratch page that is removed afterwards.
  const scratch = doc.addPage([pageW, pageH]);
  const measureCv = new PdfCanvas(doc, scratch, fonts);

  const planFor = (li: number, mode: "full" | "split", fallback = false): { pages: Placed[][]; m: Metrics; mk: (cv: PdfCanvas) => Sheet; built: Built; foot: ReturnType<typeof footer>; movedText: string; fits: boolean } => {
    const m = metricsFor(measureCv, LEVELS[li]!);
    const sh = new Sheet(measureCv, m);
    // The footer and header are the same shape on every page, so measure them with throwaway sheets.
    const foot = footer(new Sheet(measureCv, m), input);
    const head1 = header(new Sheet(measureCv, m), true);
    const head2 = header(new Sheet(measureCv, m), false);
    sh.headerH = head1 - m.M;
    const limit = m.H - m.M - foot.height - m.gapBig;
    const built = buildBlocks(sh, input, thumb, mode, foot.height, limit - head2);
    let blocks: Block[] = [...built.first, ...built.rest];
    let movedText = built.movedList;
    // Split mode: page 1 must hold its sections and the assumptions heading with its "continued" line.
    let fits = true;
    if (mode === "split" && !fallback && built.fill) {
      let y = head1;
      built.first.forEach((b, i) => { y += (i === 0 ? 0 : b.gapBefore) + b.h; });
      const f = built.fill(limit - y - m.gapBig);
      fits = y + m.gapBig + f.block.h <= limit + 1e-6;
      blocks = [...built.first, f.block, ...f.rest];
      movedText = f.movedText;
    }
    if (fallback) {
      // Last resort: the first-page sections that fit stay, a one-line note says what moved, and the rest follows on page 2.
      const core = built.first.slice(0, 3);
      const probe = built.placeholder("x");
      let y = head1;
      let k = 0;
      for (const b of core) {
        const gap = k === 0 ? 0 : b.gapBefore;
        if (k > 0 && y + gap + b.h + probe.gapBefore + probe.h > limit) break;
        y += gap + b.h;
        k++;
      }
      const moved = core.slice(k);
      movedText = movedList(moved.map((b) => b.name ?? ""), model.warnings.length > 0);
      blocks = [
        ...core.slice(0, k), built.placeholder(`${cap(movedText)} continued on page 2`),
        ...moved.map((b, i) => (i === 0 ? { ...b, breakBefore: true } : b)), ...built.rest,
      ];
    }
    const pages = paginate(blocks, head1, head2, limit);
    return { pages, m, mk: (cv) => new Sheet(cv, m), built, foot, movedText, fits };
  };

  let chosen: ReturnType<typeof planFor> | null = null;
  let levelIdx = 0;
  for (let li = 0; li < LEVELS.length && !chosen; li++) {
    const p = planFor(li, "full");
    if (p.pages.length === 1) { chosen = p; levelIdx = li; }
  }
  if (!chosen) {
    for (let li = 0; li < LEVELS.length && !chosen; li++) {
      const p = planFor(li, "split");
      // Page 1 holds all the first-page sections and the assumptions section (as many as fit) when the overflow starts on page 2.
      if (p.fits && p.pages[0]!.length === p.built.first.length + 1) { chosen = p; levelIdx = li; }
    }
    if (!chosen) { levelIdx = LEVELS.length - 1; chosen = planFor(levelIdx, "split", true); }
  }

  doc.removePage(0); // the scratch page
  const plan = chosen;
  const total = plan.pages.length;
  const sheets: Sheet[] = [];
  const canvases: PdfCanvas[] = [];
  plan.pages.forEach((placed, i) => {
    const page = doc.addPage([pageW, pageH]);
    const cv = new PdfCanvas(doc, page, fonts);
    canvases.push(cv);
    const sh = plan.mk(cv);
    sheets.push(sh);
    header(sh, i === 0);
    // Warning panels first so they sit behind their text.
    let start = -1;
    for (let k = 0; k <= placed.length; k++) {
      const warn = k < placed.length && placed[k]!.block.kind === "warn";
      if (warn && start < 0) start = k;
      if (!warn && start >= 0) {
        const y0 = placed[start]!.y;
        const last = placed[k - 1]!;
        sh.box("body", sh.m.M, y0, sh.m.CW, last.y + last.block.h - y0, color("color-warning-tint"));
        start = -1;
      }
    }
    for (const pl of placed) pl.block.draw(sh, pl.y);
    const f = footer(sh, input);
    f.draw(sh.m.H - sh.m.M - f.height);
  });

  const claimText = model.claimNumber ? `Claim ${model.claimNumber}` : "";
  const report: PdfPageReport[] = [];
  sheets.forEach((sh, i) => {
    sh.claimText = claimText;
    const cv = canvases[i]!;
    for (const op of sh.ops) { cv.region = op.region; op.fn(cv, { page: i + 1, total }); }
    const e = cv.extents;
    const body = [e.header, e.body, e.diagram];
    const sizes = cv.textSizes;
    report.push({
      height: cv.height, extents: e,
      bodyBottom: Math.max(...body.map((x) => x.maxY)),
      footerTop: e.footer.minY, footerBottom: e.footer.maxY,
      minTextPt: Math.min(...sizes.filter((t) => t.region !== "diagram").map((t) => t.size)),
      minDiagramTextPt: Math.min(...sizes.filter((t) => t.region === "diagram").map((t) => t.size)),
      images: cv.images,
      ...(cv.marks.mapOutline ? { mapOutline: cv.marks.mapOutline as NonNullable<PdfPageReport["mapOutline"]> } : {}),
      ...(cv.marks.north ? { north: cv.marks.north as NonNullable<PdfPageReport["north"]> } : {}),
      ...(cv.marks.mapLabels ? { mapLabels: cv.marks.mapLabels as NonNullable<PdfPageReport["mapLabels"]> } : {}),
      ...(cv.marks.mapPin ? { mapPin: cv.marks.mapPin as NonNullable<PdfPageReport["mapPin"]> } : {}),
      ...(cv.marks.mapCredit ? { mapCredit: cv.marks.mapCredit as NonNullable<PdfPageReport["mapCredit"]> } : {}),
      texts: cv.texts,
      ...(cv.marks.table ? { table: cv.marks.table as NonNullable<PdfPageReport["table"]> } : {}),
    });
  });
  const missing = new Set<string>();
  for (const cv of canvases) for (const ch of cv.missing) missing.add(ch);
  if (missing.size) notes.push(`Some characters couldn't be printed in the PDF and show as "?": ${[...missing].join(" ")}`);
  if (total > 1) notes.push(`There wasn't room for everything on the first page, so ${plan.movedText} continue on ${total === 2 ? "page 2" : `pages 2 to ${total}`}.`);

  doc.setTitle("Crash scene illustration");
  doc.setSubject(DISCLAIMER_SHORT);
  doc.setKeywords([`fingerprint ${model.fingerprintShort}`]);
  doc.setProducer("InsurifyAI crash scene illustration");
  doc.setCreator("InsurifyAI crash scene illustration");
  doc.setAuthor("InsurifyAI");
  const created = new Date(input.createdAt);
  doc.setCreationDate(created);
  doc.setModificationDate(created);
  doc.catalog.set(PDFName.of("Lang"), PDFString.of("en-US"));
  const bytes = await doc.save({ useObjectStreams: false });
  return { bytes, pages: total, mode: total === 1 ? "one-page" : "overflow", level: levelIdx, notes, report };
}
