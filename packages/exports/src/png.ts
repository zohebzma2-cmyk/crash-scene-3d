// PNG pictures on an injected 2D canvas: the 1600 x 1600 top-down diagram and
// the 3D stills wrapped with a footer band. All text is drawn in the brand
// fonts registered through the CanvasFactory.
import { DISCLAIMER_SHORT } from "@csd/core";
import type { RoadNetwork, SimulationResult } from "@csd/core";
import { planDiagram, rectsTouch, scaleBars, type Rect } from "./diagram";
import { layoutText, roundedRectPts, wrapText, type FontKey, type Measure, type Prim, type Pt, type Stroke } from "./draw";
import type { CanvasFactory, CanvasLike } from "./canvas-types";
import type { ReportModel } from "./model";
import { scaleChip, scaleChipPrims, type ScaleChipStyle } from "./north";
import { WORDMARK, drawMarkCanvas, lockup } from "./logo";
import { decodePng } from "./png-decode";
import { color, px } from "./style";
import { SHADOWS } from "./tokens";

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
export interface Families { readonly sans: string; readonly mono: string }

const LEADING = px("leading-snug");
const SPACE = (n: 1 | 2 | 3 | 4 | 5 | 6 | 8) => px(`space-${n}`);
/** Width every still is fitted to, so the band and captions read the same on every picture. */
export const STILL_MIN_WIDTH = px("size-png-3d-w");

/** Longest a scale bar may be, as a share of the diagram's width. */
const SCALE_BAR_SHARE = 0.16;

/** The north arrow and scale card on the PNG diagram, in px. */
export function pngChipStyle(): ScaleChipStyle {
  const text = px("text-xl");
  return {
    textSize: text, arrowH: SPACE(8) + SPACE(5), padX: SPACE(5), padY: SPACE(3), gap: SPACE(8), labelGap: SPACE(3),
    rowH: text * LEADING + SPACE(2), barLine: SPACE(1), tick: SPACE(2), tickLine: SPACE(1) * 0.75, arrowLine: SPACE(1) * 0.75,
  };
}

/** Height of the footer band when the stamp sits beside the disclaimer: padding plus the three stamp lines. */
export function footerBandHeight(): number {
  return Math.round(SPACE(8) * 2 + 3 * px("text-xl") * LEADING);
}

class CanvasPen {
  constructor(readonly ctx: Ctx, readonly fam: Families) {}

  font(font: FontKey, size: number): string {
    return font === "mono" ? `400 ${size}px "${this.fam.mono}"` : `${font === "sansBold" ? 700 : 400} ${size}px "${this.fam.sans}"`;
  }

  readonly measure: Measure = (font, size, text) => {
    this.ctx.font = this.font(font, size);
    return this.ctx.measureText(text).width;
  };

  private path(pts: readonly Pt[], closed: boolean) {
    const c = this.ctx;
    c.beginPath();
    pts.forEach((p, i) => (i === 0 ? c.moveTo(p[0], p[1]) : c.lineTo(p[0], p[1])));
    if (closed) c.closePath();
  }
  private strokeWith(s: Stroke) {
    const c = this.ctx;
    c.strokeStyle = s.color;
    c.lineWidth = s.width;
    c.lineCap = s.cap === "round" ? "round" : "butt";
    c.lineJoin = s.join === "round" ? "round" : "miter";
    c.setLineDash(s.dash ? [...s.dash] : []);
    c.stroke();
    c.setLineDash([]);
  }

  poly(pts: readonly Pt[], closed: boolean, fill?: string, s?: Stroke) {
    if (pts.length < 2) return;
    this.path(pts, closed || !!fill);
    if (fill) { this.ctx.fillStyle = fill; this.ctx.fill(); }
    if (s) this.strokeWith(s);
  }
  circle(c: Pt, r: number, fill?: string, s?: Stroke) {
    this.ctx.beginPath();
    this.ctx.arc(c[0], c[1], r, 0, Math.PI * 2);
    if (fill) { this.ctx.fillStyle = fill; this.ctx.fill(); }
    if (s) this.strokeWith(s);
  }
  text(p: Extract<Prim, { k: "text" }>) {
    const c = this.ctx;
    c.font = this.font(p.font, p.size);
    c.fillStyle = p.color;
    c.textAlign = "left";
    c.textBaseline = "alphabetic";
    for (const run of layoutText(p, this.measure)) {
      c.save();
      c.translate(run.x, run.y);
      c.rotate((run.rotateDeg * Math.PI) / 180);
      c.fillText(run.text, 0, 0);
      c.restore();
    }
  }
  replay(prims: readonly Prim[]) {
    for (const p of prims) {
      switch (p.k) {
        case "poly": this.poly(p.pts, !!p.closed, p.fill, p.stroke); break;
        case "circle": this.circle(p.c, p.r, p.fill, p.stroke); break;
        case "text": this.text(p); break;
        case "clip": this.ctx.save(); this.ctx.beginPath(); this.ctx.rect(p.x, p.y, p.w, p.h); this.ctx.clip(); break;
        case "unclip": this.ctx.restore(); break;
      }
    }
  }
  /** Card with the medium shadow. */
  card(r: Rect) {
    const c = this.ctx;
    c.save();
    c.shadowColor = SHADOWS.md.color;
    c.shadowBlur = SHADOWS.md.blurPx;
    c.shadowOffsetX = SHADOWS.md.offsetXPx;
    c.shadowOffsetY = SHADOWS.md.offsetYPx;
    this.poly(roundedRectPts(r.x, r.y, r.w, r.h, px("radius-md"), 8), true, color("color-surface"));
    c.restore();
  }
}

const getCtx = (cv: CanvasLike): Ctx => {
  const ctx = cv.getContext("2d");
  if (!ctx) throw new Error("The canvas can't draw 2D pictures.");
  return ctx;
};

/* ------------------------------------------------------------------ footer band */

interface Band { readonly h: number; readonly draw: (pen: CanvasPen, x: number, y: number) => void }

/**
 * Footer band: short disclaimer with the fingerprint and times beside it. When
 * they can't sit side by side at this width, the stamp goes under the
 * disclaimer and the band grows to hold it. `minH` is the band's height when it fits beside.
 */
function bandLayout(pen: CanvasPen, w: number, model: ReportModel, minH: number): Band {
  const pad = SPACE(8);
  const metaSize = px("text-xl");
  const mlh = metaSize * LEADING;
  const meta = [`Fingerprint ${model.fingerprintShort}`, model.stampLocal, model.stampUtc];
  const metaW = Math.max(...meta.map((m) => pen.measure("mono", metaSize, m)));
  const sizes = [px("text-2xl"), px("text-xl"), px("text-lg"), px("text-base")];
  const ink = color("color-warning-tint-text");
  const sideW = w - pad * 2 - metaW - pad;
  if (sideW >= w * 0.35) {
    for (const size of sizes) {
      const lines = wrapText(DISCLAIMER_SHORT, sideW, (t) => pen.measure("sansBold", size, t));
      if (lines.length * size * LEADING <= minH - pad * 2) {
        return {
          h: minH,
          draw: (pen, x, y) => {
            const lh = size * LEADING;
            const top = y + (minH - lines.length * lh) / 2;
            lines.forEach((l, i) => pen.text({ k: "text", at: [x + pad, top + lh * i + lh * 0.5 + size * 0.35], text: l, font: "sansBold", size, color: ink }));
            const mtop = y + (minH - meta.length * mlh) / 2;
            meta.forEach((m, i) => pen.text({ k: "text", at: [x + w - pad, mtop + mlh * i + mlh * 0.5 + metaSize * 0.35], text: m, font: "mono", size: metaSize, color: ink, anchor: "end" }));
          },
        };
      }
    }
  }
  // Stacked: the stamp under the disclaimer, wrapped to the width we have.
  const size = sizes[sizes.length - 2]!;
  const lines = wrapText(DISCLAIMER_SHORT, w - pad * 2, (t) => pen.measure("sansBold", size, t));
  const lh = size * LEADING;
  const stamp = wrapText(meta.join("   "), w - pad * 2, (t) => pen.measure("mono", metaSize, t));
  const h = Math.max(minH, Math.round(pad * 2 + lines.length * lh + SPACE(2) + stamp.length * mlh));
  return {
    h,
    draw: (pen, x, y) => {
      lines.forEach((l, i) => pen.text({ k: "text", at: [x + pad, y + pad + lh * i + lh * 0.5 + size * 0.35], text: l, font: "sansBold", size, color: ink }));
      const sy = y + pad + lines.length * lh + SPACE(2);
      stamp.forEach((l, i) => pen.text({ k: "text", at: [x + pad, sy + mlh * i + mlh * 0.5 + metaSize * 0.35], text: l, font: "mono", size: metaSize, color: ink }));
    },
  };
}

/** The band's background and text, drawn into the rectangle (x, y, w, band.h). */
function drawBand(pen: CanvasPen, x: number, y: number, w: number, band: Band) {
  pen.poly([[x, y], [x + w, y], [x + w, y + band.h], [x, y + band.h]], true, color("color-warning-tint"));
  band.draw(pen, x, y);
}

/**
 * The InsurifyAI logo on a card, its right edge at `right` and its top at `top`: the official mark
 * (the supplied path data) and the wordmark in Plus Jakarta Sans 700, "AI" in the logo blue.
 */
function logoCard(pen: CanvasPen, right: number, top: number): { rect: Rect; draw: () => void } {
  const padX = SPACE(5);
  const padY = SPACE(3);
  const lk = lockup(px("space-10"));
  const lead = pen.measure("sansBold", lk.wordSize, WORDMARK.lead);
  const w = padX * 2 + lk.markW + lk.gap + lead + pen.measure("sansBold", lk.wordSize, WORDMARK.accent);
  const rect: Rect = { x: right - w, y: top, w, h: padY * 2 + lk.markH };
  return {
    rect,
    draw: () => {
      pen.card(rect);
      const mx = rect.x + padX;
      const my = rect.y + padY;
      drawMarkCanvas(pen.ctx, mx, my, lk.markH);
      const wx = mx + lk.markW + lk.gap;
      const wy = my + lk.baseline;
      pen.text({ k: "text", at: [wx, wy], text: WORDMARK.lead, font: "sansBold", size: lk.wordSize, color: color("color-text") });
      pen.text({ k: "text", at: [wx + lead, wy], text: WORDMARK.accent, font: "sansBold", size: lk.wordSize, color: color("color-logo") });
    },
  };
}

/* ------------------------------------------------------------------ diagram picture */

export interface DiagramPngInput {
  readonly model: ReportModel;
  readonly sim: SimulationResult;
  readonly roads: RoadNetwork | null;
}

/** What the diagram picture drew, for checks: the cards over the picture and what has to stay clear of them. */
export interface DiagramPngLayout {
  readonly cards: readonly Rect[];
  readonly keep: readonly Rect[];
  readonly safe: Rect;
  readonly band: number;
  /** The north arrow with its "N" (inside the scale card), and the scale card itself. */
  readonly north: Rect;
  readonly scaleCard: Rect;
  /** The legend card of numbered measurements, when there is one. */
  readonly legend: Rect | null;
  /** Each scale bar (line, caps and end ticks) and its label, as drawn. */
  readonly bars: ReadonlyArray<{ readonly bar: Rect; readonly label: Rect }>;
}

export async function renderDiagramPng(input: DiagramPngInput, factory: CanvasFactory, fam: Families): Promise<{ png: Uint8Array; layout: DiagramPngLayout }> {
  const { model, sim, roads } = input;
  const S = px("size-png-diagram");
  const cv = factory.create(S, S);
  const pen = new CanvasPen(getCtx(cv), fam);
  const band = bandLayout(pen, S, model, footerBandHeight());
  const area = S - band.h;
  const edge = SPACE(8);
  const draws: Array<() => void> = [];
  const cards: Rect[] = [];

  // Title card, top left.
  {
    const padY = SPACE(4);
    const padX = SPACE(6);
    const titleS = px("text-3xl");
    const subS = px("text-xl");
    const maxW = S * 0.62 - padX * 2;
    const road = model.road.split(" · ")[1];
    const sub = [model.place, model.occurred, road ? `${road} road` : ""].filter(Boolean).join(" · ");
    const subLines = wrapText(sub, maxW, (t) => pen.measure("sans", subS, t));
    const noteLines = [
      ...(model.adjustedNotes.length ? wrapText(model.adjustedNotes.join(" "), maxW, (t) => pen.measure("sans", subS, t)) : []),
      ...(model.unsureNotes.length ? wrapText(model.unsureNotes.join(" "), maxW, (t) => pen.measure("sans", subS, t)) : []),
      ...(model.brakingNotes.length ? wrapText(`${model.brakingNotes.join("; ")}.`, maxW, (t) => pen.measure("sans", subS, t)) : []),
    ];
    const all = [...subLines, ...noteLines];
    const w = Math.min(maxW, Math.max(pen.measure("sansBold", titleS, "Top-down diagram"), ...all.map((l) => pen.measure("sans", subS, l)))) + padX * 2;
    const h = padY * 2 + titleS * LEADING + all.length * (subS * LEADING + SPACE(1)) + SPACE(1);
    const r: Rect = { x: edge, y: edge, w, h };
    cards.push(r);
    draws.push(() => {
      pen.card(r);
      pen.text({ k: "text", at: [r.x + padX, r.y + padY + titleS * LEADING * 0.5 + titleS * 0.35], text: "Top-down diagram", font: "sansBold", size: titleS, color: color("color-text") });
      all.forEach((l, i) => pen.text({ k: "text", at: [r.x + padX, r.y + padY + titleS * LEADING + (subS * LEADING + SPACE(1)) * i + subS * LEADING * 0.5 + subS * 0.35 + SPACE(1)], text: l, font: "sans", size: subS, color: color("color-text-secondary") }));
    });
  }
  // Logo card, top right.
  {
    const lc = logoCard(pen, S - edge, edge);
    cards.push(lc.rect);
    draws.push(lc.draw);
  }
  // Legend, bottom left: the numbered measurements.
  {
    const rows = model.measurements.filter((r) => r.marker !== null).sort((a, b) => (a.marker ?? 0) - (b.marker ?? 0));
    if (rows.length) {
      const padY = SPACE(4);
      const padX = SPACE(6);
      const size = px("text-xl");
      const dot = SPACE(8);
      const rowGap = SPACE(2);
      const rowH = Math.max(dot, size * LEADING);
      const labW = Math.max(...rows.map((r) => pen.measure("sans", size, r.label)));
      const valW = Math.max(...rows.map((r) => pen.measure("mono", size, r.value)));
      const w = padX * 2 + dot + SPACE(3) + labW + SPACE(3) + valW;
      const h = padY * 2 + rows.length * rowH + (rows.length - 1) * rowGap;
      const r: Rect = { x: edge, y: area - edge - h, w, h };
      cards.push(r);
      draws.push(() => {
        pen.card(r);
        rows.forEach((row, i) => {
          const cy = r.y + padY + i * (rowH + rowGap) + rowH / 2;
          pen.circle([r.x + padX + dot / 2, cy], dot / 2, color("color-scene-measure"));
          pen.text({ k: "text", at: [r.x + padX + dot / 2, cy + px("text-lg") * 0.35], text: String(row.marker), font: "sansBold", size: px("text-lg"), color: color("color-surface"), anchor: "middle" });
          pen.text({ k: "text", at: [r.x + padX + dot + SPACE(3), cy + size * 0.35], text: row.label, font: "sans", size, color: color("color-text") });
          pen.text({ k: "text", at: [r.x + padX + dot + SPACE(3) + labW + SPACE(3), cy + size * 0.35], text: row.value, font: "mono", size, color: color("color-text") });
        });
      });
    }
  }
  // The diagram is fitted into what the cards leave free, then the scale card (whose bars depend on the scale) is placed,
  // bottom right. If it would come within a gap of the legend, the scale card goes above the legend instead and the
  // diagram is fitted again with room for both, so the two never overlap.
  const legend = cards.find((c) => c.y > S / 2) ?? null;
  const maxCardH = legend?.h ?? 0;
  const chipStyle = pngChipStyle();
  // The card's height doesn't depend on the scale, only its width does.
  const scaleH = scaleChip([0, 0], [{ label: "", px: 0 }, { label: "", px: 0 }], chipStyle, pen.measure).rect.h;
  const titleBottom = Math.max(...cards.filter((c) => c.y < S / 2).map((c) => c.y + c.h));
  const fit = (stacked: boolean) => {
    const bottomInset = (stacked ? maxCardH + SPACE(4) + scaleH : Math.max(maxCardH, scaleH)) + edge + SPACE(4);
    const plan = planDiagram(sim, roads, {
      box: { x: 0, y: 0, w: S, h: area }, letters: true, markers: true, streetLabels: true, ghosts: true,
      minTextSize: px("text-base"), minLine: 2, minTagRadius: px("text-lg"),
      insets: { top: titleBottom + SPACE(4), bottom: bottomInset, left: SPACE(4), right: SPACE(4) },
    }, pen.measure);
    // The north arrow, then two bars, each exact in its own unit, with a clear gap and a divider between them.
    const bars = scaleBars(plan.scale, S * SCALE_BAR_SHARE);
    const barList = [bars.metric, bars.us];
    const size = scaleChip([0, 0], barList, chipStyle, pen.measure).rect;
    const at: Pt = [S - edge - size.w, stacked && legend ? legend.y - SPACE(4) - size.h : area - edge - size.h];
    return { plan, chip: scaleChip(at, barList, chipStyle, pen.measure) };
  };
  let fitted = fit(false);
  if (legend && rectsTouch(fitted.chip.rect, legend, SPACE(4))) fitted = fit(true);
  const { plan, chip } = fitted;
  pen.poly([[0, 0], [S, 0], [S, S], [0, S]], true, color("color-surface"));
  pen.replay(plan.prims);
  const scaleCard: Rect = chip.rect;
  cards.push(scaleCard);
  draws.push(() => {
    pen.card(scaleCard);
    pen.replay(scaleChipPrims(chip, chipStyle, color("color-text"), color("color-border"), pen.measure));
  });
  for (const d of draws) d();
  drawBand(pen, 0, area, S, band);
  return {
    png: await factory.toPng(cv),
    layout: { cards, keep: plan.keep, safe: plan.safe, band: band.h, north: chip.arrow, scaleCard, legend, bars: chip.bars.map((b) => ({ bar: b.box, label: b.labelBox })) },
  };
}

export async function buildDiagramPng(input: DiagramPngInput, factory: CanvasFactory, fam: Families): Promise<Uint8Array> {
  return (await renderDiagramPng(input, factory, fam)).png;
}

/* ------------------------------------------------------------------ 3D stills */

/** Bilinear scaling to nw x nh. */
function scaleTo(rgba: Uint8ClampedArray, w: number, h: number, nw: number, nh: number): Uint8ClampedArray {
  if (nw === w && nh === h) return rgba;
  const out = new Uint8ClampedArray(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    const fy = ((y + 0.5) * h) / nh - 0.5;
    const y0 = Math.max(0, Math.min(h - 1, Math.floor(fy)));
    const y1 = Math.min(h - 1, y0 + 1);
    const ty = Math.min(1, Math.max(0, fy - y0));
    for (let x = 0; x < nw; x++) {
      const fx = ((x + 0.5) * w) / nw - 0.5;
      const x0 = Math.max(0, Math.min(w - 1, Math.floor(fx)));
      const x1 = Math.min(w - 1, x0 + 1);
      const tx = Math.min(1, Math.max(0, fx - x0));
      const o = (y * nw + x) * 4;
      for (let k = 0; k < 4; k++) {
        const a = rgba[(y0 * w + x0) * 4 + k]!, b = rgba[(y0 * w + x1) * 4 + k]!, c = rgba[(y1 * w + x0) * 4 + k]!, d = rgba[(y1 * w + x1) * 4 + k]!;
        out[o + k] = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
      }
    }
  }
  return out;
}

/** What a still's composed picture looks like, for checks. */
export interface StillLayout {
  readonly width: number;
  readonly height: number;
  readonly bandTop: number;
  readonly band: number;
  /** Where the picture itself sits inside the frame above the band (letterboxed). */
  readonly picture: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
}

/**
 * A 3D still from the viewer with a caption on it and the footer band under it.
 * Every still is fitted (aspect kept, scaled up or down) into a 1920 x (1080 - band)
 * frame and letterboxed with the scene's ground color, so the picture is always
 * 1920 x 1080 no matter the shape it was captured in.
 */
export async function renderStillPng(still: Uint8Array, caption: string, model: ReportModel, factory: CanvasFactory, fam: Families): Promise<{ png: Uint8Array; layout: StillLayout }> {
  const img = await decodePng(still);
  const frameW = STILL_MIN_WIDTH;
  const frameH = px("size-png-3d-h") - footerBandHeight();
  const k = Math.min(frameW / img.width, frameH / img.height);
  const pw = Math.max(1, Math.min(frameW, Math.round(img.width * k)));
  const ph = Math.max(1, Math.min(frameH, Math.round(img.height * k)));
  const pixels = scaleTo(img.rgba, img.width, img.height, pw, ph);
  // Measure the band on a scratch canvas first so the real canvas gets the right height.
  const probe = factory.create(frameW, 1);
  const band = bandLayout(new CanvasPen(getCtx(probe), fam), frameW, model, footerBandHeight());
  const cv = factory.create(frameW, frameH + band.h);
  const ctx = getCtx(cv);
  const pen = new CanvasPen(ctx, fam);
  pen.poly([[0, 0], [frameW, 0], [frameW, frameH], [0, frameH]], true, color("color-scene-ground"));
  const px0 = Math.round((frameW - pw) / 2);
  const py0 = Math.round((frameH - ph) / 2);
  const data = ctx.createImageData(pw, ph);
  data.data.set(pixels);
  ctx.putImageData(data, px0, py0);
  // Caption card, top left of the frame.
  const size = px("text-xl");
  const padX = SPACE(5);
  const padY = SPACE(3);
  const w = pen.measure("sansBold", size, caption) + padX * 2;
  const h = size * LEADING + padY * 2;
  const r: Rect = { x: SPACE(8), y: SPACE(8), w, h };
  pen.card(r);
  pen.text({ k: "text", at: [r.x + padX, r.y + padY + size * LEADING * 0.5 + size * 0.35], text: caption, font: "sansBold", size, color: color("color-text") });
  logoCard(pen, frameW - SPACE(8), SPACE(8)).draw();
  drawBand(pen, 0, frameH, frameW, band);
  return { png: await factory.toPng(cv), layout: { width: frameW, height: frameH + band.h, bandTop: frameH, band: band.h, picture: { x: px0, y: py0, w: pw, h: ph } } };
}

export async function buildStillPng(still: Uint8Array, caption: string, model: ReportModel, factory: CanvasFactory, fam: Families): Promise<Uint8Array> {
  return (await renderStillPng(still, caption, model, factory, fam)).png;
}

/** Just the footer band at a given width (for checking the layout at widths a still never has). */
export async function renderBand(factory: CanvasFactory, fam: Families, width: number, model: ReportModel): Promise<{ png: Uint8Array; height: number; stacked: boolean }> {
  const probe = factory.create(width, 1);
  const band = bandLayout(new CanvasPen(getCtx(probe), fam), width, model, footerBandHeight());
  const cv = factory.create(width, band.h);
  drawBand(new CanvasPen(getCtx(cv), fam), 0, 0, width, band);
  return { png: await factory.toPng(cv), height: band.h, stacked: band.h > footerBandHeight() };
}
