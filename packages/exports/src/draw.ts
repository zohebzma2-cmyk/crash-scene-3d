// Backend-neutral drawing primitives. The diagram is planned once as a list of
// these (y down, output units) and replayed by the PDF writer and by the 2D
// canvas, so the picture is the same in both.
export type Pt = readonly [number, number];
export type FontKey = "sans" | "sansBold" | "mono";

export interface Stroke {
  readonly color: string;
  readonly width: number;
  readonly dash?: readonly number[];
  readonly cap?: "butt" | "round";
  readonly join?: "miter" | "round";
}

export type Prim =
  | { readonly k: "poly"; readonly pts: readonly Pt[]; readonly closed?: boolean; readonly fill?: string; readonly stroke?: Stroke }
  | { readonly k: "circle"; readonly c: Pt; readonly r: number; readonly fill?: string; readonly stroke?: Stroke }
  | {
      readonly k: "text";
      readonly at: Pt;
      readonly text: string;
      readonly font: FontKey;
      readonly size: number;
      readonly color: string;
      readonly anchor?: "start" | "middle" | "end";
      /** Clockwise on the page, degrees. */
      readonly rotateDeg?: number;
      /** Extra space between letters, in the same units as size. */
      readonly tracking?: number;
    }
  | { readonly k: "clip"; readonly x: number; readonly y: number; readonly w: number; readonly h: number }
  | { readonly k: "unclip" };

export type Measure = (font: FontKey, size: number, text: string) => number;

export interface TextRun {
  readonly x: number;
  readonly y: number;
  readonly text: string;
  readonly rotateDeg: number;
}

/**
 * Where to put the pieces of a text primitive. Plain text is one run starting at
 * the left of the box; tracked text is one run per letter so both backends space it the same.
 */
export function layoutText(p: Extract<Prim, { k: "text" }>, measure: Measure): TextRun[] {
  const rot = p.rotateDeg ?? 0;
  const th = (rot * Math.PI) / 180;
  const dx = Math.cos(th);
  const dy = Math.sin(th);
  const tracking = p.tracking ?? 0;
  const chars = Array.from(p.text);
  const widths = tracking ? chars.map((c) => measure(p.font, p.size, c)) : [];
  const total = tracking ? widths.reduce((a, b) => a + b, 0) + tracking * Math.max(0, chars.length - 1) : measure(p.font, p.size, p.text);
  const shift = p.anchor === "middle" ? total / 2 : p.anchor === "end" ? total : 0;
  const sx = p.at[0] - dx * shift;
  const sy = p.at[1] - dy * shift;
  if (!tracking) return [{ x: sx, y: sy, text: p.text, rotateDeg: rot }];
  const runs: TextRun[] = [];
  let off = 0;
  chars.forEach((c, i) => {
    runs.push({ x: sx + dx * off, y: sy + dy * off, text: c, rotateDeg: rot });
    off += (widths[i] ?? 0) + tracking;
  });
  return runs;
}

/** Break text into lines no wider than maxW. Long unbroken words are split by character. */
export function wrapText(text: string, maxW: number, widthOf: (s: string) => number): string[] {
  const lines: string[] = [];
  let line = "";
  const push = () => { if (line) lines.push(line); line = ""; };
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (widthOf(next) <= maxW) { line = next; continue; }
    push();
    if (widthOf(word) <= maxW) { line = word; continue; }
    let chunk = "";
    for (const ch of Array.from(word)) {
      if (widthOf(chunk + ch) > maxW && chunk) { lines.push(chunk); chunk = ch; } else chunk += ch;
    }
    line = chunk;
  }
  push();
  return lines.length ? lines : [""];
}

/** Rounded rectangle as a polygon (corner arcs in segments). */
export function roundedRectPts(x: number, y: number, w: number, h: number, r: number, seg = 6): Pt[] {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  if (rr === 0) return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  const pts: Pt[] = [];
  const corner = (cx: number, cy: number, a0: number) => {
    for (let i = 0; i <= seg; i++) {
      const a = a0 + (Math.PI / 2) * (i / seg);
      pts.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a)]);
    }
  };
  corner(x + w - rr, y + rr, -Math.PI / 2);
  corner(x + w - rr, y + h - rr, 0);
  corner(x + rr, y + h - rr, Math.PI / 2);
  corner(x + rr, y + rr, Math.PI);
  return pts;
}

/** Offset a polyline sideways by d (positive = to the left of travel in a y-up frame), with mitered joins. */
export function offsetPolyline(pts: readonly Pt[], d: number): Pt[] {
  const n = pts.length;
  if (n < 2) return [...pts];
  const out: Pt[] = [];
  const normal = (a: Pt, b: Pt): Pt => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    return [-dy / len, dx / len];
  };
  for (let i = 0; i < n; i++) {
    const p = pts[i]!;
    const n0 = i > 0 ? normal(pts[i - 1]!, p) : normal(p, pts[i + 1]!);
    const n1 = i < n - 1 ? normal(p, pts[i + 1]!) : n0;
    let mx = n0[0] + n1[0];
    let my = n0[1] + n1[1];
    const ml = Math.hypot(mx, my);
    if (ml < 1e-6) { mx = n0[0]; my = n0[1]; } else { mx /= ml; my /= ml; }
    const cos = mx * n0[0] + my * n0[1];
    const k = d / Math.max(cos, 0.5);
    out.push([p[0] + mx * k, p[1] + my * k]);
  }
  return out;
}
