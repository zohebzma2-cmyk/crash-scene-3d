// Draws primitives onto a pdf-lib page. Layout code works top-left, y down, in
// points; this class flips to PDF's bottom-left origin. It also records what it
// drew (extent per region and text sizes) so the layout can be checked against
// the real drawing, not just the numbers it planned with.
import {
  LineCapStyle, LineJoinStyle, PDFDocument, appendBezierCurve, clip, closePath, endPath, fill, fillAndStroke, degrees, lineTo, moveTo,
  popGraphicsState, pushGraphicsState, rectangle, rgb, setDashPattern, setFillingRgbColor, setLineCap, setLineJoin, setLineWidth,
  setStrokingRgbColor, stroke,
  type PDFFont, type PDFImage, type PDFOperator, type PDFPage,
} from "pdf-lib";
import { layoutText, type FontKey, type Measure, type Prim, type Pt, type Stroke } from "./draw";
import { rgb01 } from "./style";

export interface PdfFonts {
  readonly sans: PDFFont;
  readonly sansBold: PDFFont;
  readonly mono: PDFFont;
}

/** What a piece of drawing belongs to: the footer must never be overlapped by anything else. */
export type Region = "header" | "body" | "diagram" | "footer";
export interface Extent { minX: number; minY: number; maxX: number; maxY: number }

const KAPPA = 0.5522847498;
const emptyExtent = (): Extent => ({ minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });

export class PdfCanvas {
  private readonly charsets = new Map<PDFFont, Set<number>>();
  private readonly clips: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];
  readonly extents: Record<Region, Extent> = { header: emptyExtent(), body: emptyExtent(), diagram: emptyExtent(), footer: emptyExtent() };
  /** Text sizes drawn, in points, with the region they belong to. */
  readonly textSizes: Array<{ region: Region; size: number; text: string }> = [];
  /** Every run of text drawn, with its glyph box (top-left origin, axis-aligned around a rotated run). */
  readonly texts: Array<{ region: Region; text: string; box: { x: number; y: number; w: number; h: number } }> = [];
  /** Characters the fonts don't have (drawn as "?"). */
  readonly missing = new Set<string>();
  /** Where each picture was shown on the page (its visible box after clipping). */
  readonly images: Array<{ x: number; y: number; w: number; h: number }> = [];
  /** Layout facts worth checking later (framing of the map fallback, say). */
  readonly marks: Record<string, unknown> = {};
  region: Region = "body";

  constructor(readonly doc: PDFDocument, readonly page: PDFPage, readonly fonts: PdfFonts) {}

  get height(): number { return this.page.getHeight(); }

  /** Text the font can show: control characters become spaces, missing glyphs become "?" (recorded in `missing` when asked). */
  private convert(font: FontKey, text: string, record: boolean): string {
    const f = this.fonts[font];
    let set = this.charsets.get(f);
    if (!set) { set = new Set(f.getCharacterSet()); this.charsets.set(f, set); }
    let out = "";
    for (const ch of Array.from(text.replace(/[\r\n\t ]+/g, " "))) {
      if (set.has(ch.codePointAt(0)!)) out += ch;
      else { out += "?"; if (record) this.missing.add(ch); }
    }
    return out;
  }

  readonly measure: Measure = (font, size, text) => this.fonts[font].widthOfTextAtSize(this.convert(font, text, false), size);

  private note(x0: number, y0: number, x1: number, y1: number) {
    let a = x0, b = y0, c = x1, d = y1;
    const cl = this.clips[this.clips.length - 1];
    if (cl) { a = Math.max(a, cl.x0); b = Math.max(b, cl.y0); c = Math.min(c, cl.x1); d = Math.min(d, cl.y1); }
    if (c < a || d < b) return;
    const e = this.extents[this.region];
    e.minX = Math.min(e.minX, a); e.minY = Math.min(e.minY, b); e.maxX = Math.max(e.maxX, c); e.maxY = Math.max(e.maxY, d);
  }

  private ops(...o: PDFOperator[]) { this.page.pushOperators(...o); }
  private y(v: number) { return this.height - v; }

  private strokeOps(s: Stroke): PDFOperator[] {
    const [r, g, b] = rgb01(s.color);
    const o: PDFOperator[] = [setStrokingRgbColor(r, g, b), setLineWidth(s.width)];
    o.push(setLineCap(s.cap === "round" ? LineCapStyle.Round : LineCapStyle.Butt));
    o.push(setLineJoin(s.join === "round" ? LineJoinStyle.Round : LineJoinStyle.Miter));
    o.push(setDashPattern(s.dash ? [...s.dash] : [], 0));
    return o;
  }

  private paint(pathOps: PDFOperator[], fillColor?: string, s?: Stroke) {
    const o: PDFOperator[] = [pushGraphicsState()];
    if (fillColor) { const [r, g, b] = rgb01(fillColor); o.push(setFillingRgbColor(r, g, b)); }
    if (s) o.push(...this.strokeOps(s));
    o.push(...pathOps);
    o.push(fillColor && s ? fillAndStroke() : fillColor ? fill() : stroke());
    o.push(popGraphicsState());
    this.ops(...o);
  }

  private polyOps(pts: readonly Pt[], closed: boolean): PDFOperator[] {
    const o: PDFOperator[] = [];
    pts.forEach((p, i) => o.push(i === 0 ? moveTo(p[0], this.y(p[1])) : lineTo(p[0], this.y(p[1]))));
    if (closed) o.push(closePath());
    return o;
  }

  poly(pts: readonly Pt[], closed: boolean, fillColor?: string, s?: Stroke) {
    if (pts.length < 2 || (!fillColor && !s)) return;
    const pad = s ? s.width / 2 : 0;
    this.note(Math.min(...pts.map((p) => p[0])) - pad, Math.min(...pts.map((p) => p[1])) - pad, Math.max(...pts.map((p) => p[0])) + pad, Math.max(...pts.map((p) => p[1])) + pad);
    this.paint(this.polyOps(pts, closed || !!fillColor), fillColor, s);
  }

  circle(c: Pt, r: number, fillColor?: string, s?: Stroke) {
    if (!fillColor && !s) return;
    const pad = (s ? s.width / 2 : 0) + r;
    this.note(c[0] - pad, c[1] - pad, c[0] + pad, c[1] + pad);
    const [cx, cy] = [c[0], this.y(c[1])];
    const k = r * KAPPA;
    this.paint([
      moveTo(cx + r, cy),
      appendBezierCurve(cx + r, cy + k, cx + k, cy + r, cx, cy + r),
      appendBezierCurve(cx - k, cy + r, cx - r, cy + k, cx - r, cy),
      appendBezierCurve(cx - r, cy - k, cx - k, cy - r, cx, cy - r),
      appendBezierCurve(cx + k, cy - r, cx + r, cy - k, cx + r, cy),
      closePath(),
    ], fillColor, s);
  }

  image(img: PDFImage, x: number, y: number, w: number, h: number) {
    const cl = this.clips[this.clips.length - 1];
    const vis = cl ? { x: Math.max(x, cl.x0), y: Math.max(y, cl.y0), w: Math.min(x + w, cl.x1) - Math.max(x, cl.x0), h: Math.min(y + h, cl.y1) - Math.max(y, cl.y0) } : { x, y, w, h };
    this.images.push(vis);
    this.note(x, y, x + w, y + h);
    this.page.drawImage(img, { x, y: this.y(y + h), width: w, height: h });
  }

  /** Clip to a polygon (a rounded rectangle, say); undone by unclip(). */
  clipPath(pts: readonly Pt[]) {
    const prev = this.clips[this.clips.length - 1];
    this.clips.push({
      x0: Math.max(Math.min(...pts.map((p) => p[0])), prev?.x0 ?? -Infinity), y0: Math.max(Math.min(...pts.map((p) => p[1])), prev?.y0 ?? -Infinity),
      x1: Math.min(Math.max(...pts.map((p) => p[0])), prev?.x1 ?? Infinity), y1: Math.min(Math.max(...pts.map((p) => p[1])), prev?.y1 ?? Infinity),
    });
    this.ops(pushGraphicsState(), ...this.polyOps(pts, true), clip(), endPath());
  }

  clipRect(x: number, y: number, w: number, h: number) {
    const prev = this.clips[this.clips.length - 1];
    this.clips.push({ x0: Math.max(x, prev?.x0 ?? -Infinity), y0: Math.max(y, prev?.y0 ?? -Infinity), x1: Math.min(x + w, prev?.x1 ?? Infinity), y1: Math.min(y + h, prev?.y1 ?? Infinity) });
    this.ops(pushGraphicsState(), rectangle(x, this.y(y + h), w, h), clip(), endPath());
  }
  unclip() { this.clips.pop(); this.ops(popGraphicsState()); }

  text(p: Extract<Prim, { k: "text" }>) {
    const font = this.fonts[p.font];
    const [r, g, b] = rgb01(p.color);
    for (const run of layoutText(p, this.measure)) {
      const shown = this.convert(p.font, run.text, true);
      this.page.drawText(shown, { x: run.x, y: this.y(run.y), size: p.size, font, color: rgb(r, g, b), rotate: degrees(-run.rotateDeg) });
      // Glyph box: cap height above the baseline, a little descender below, rotated with the text.
      const w = font.widthOfTextAtSize(shown, p.size);
      const th = (run.rotateDeg * Math.PI) / 180;
      const ux = Math.cos(th), uy = Math.sin(th);
      const corners: Pt[] = [[0, -p.size * 0.75], [w, -p.size * 0.75], [w, p.size * 0.2], [0, p.size * 0.2]].map((c) => [run.x + c[0]! * ux - c[1]! * uy, run.y + c[0]! * uy + c[1]! * ux] as Pt);
      const [x0, y0, x1, y1] = [Math.min(...corners.map((c) => c[0])), Math.min(...corners.map((c) => c[1])), Math.max(...corners.map((c) => c[0])), Math.max(...corners.map((c) => c[1]))];
      this.note(x0, y0, x1, y1);
      if (shown.trim()) {
        this.textSizes.push({ region: this.region, size: p.size, text: shown });
        this.texts.push({ region: this.region, text: shown, box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } });
      }
    }
  }

  replay(prims: readonly Prim[]) {
    for (const p of prims) {
      switch (p.k) {
        case "poly": this.poly(p.pts, !!p.closed, p.fill, p.stroke); break;
        case "circle": this.circle(p.c, p.r, p.fill, p.stroke); break;
        case "text": this.text(p); break;
        case "clip": this.clipRect(p.x, p.y, p.w, p.h); break;
        case "unclip": this.unclip(); break;
      }
    }
  }
}
