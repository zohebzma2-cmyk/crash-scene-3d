// Road surface art, as pure data: one ribbon per road, lane paint clipped to the ribbons and stopped at
// junctions, parking stalls, and spots for street names. The 3D viewer and the top-down diagram (PDF and
// PNG) both read this, so they draw the same roads. No three.js, no DOM. Local ENU frame, meters.
//
// Conventions (match lanes.ts, which places the vehicles):
//  - A two-way road has its centerline at the divider between the directions: `lanesBackward` lanes to the
//    left of travel along the centerline and `lanesForward` lanes to the right.
//  - A one-way road is centred on its centerline, `lanesForward` lanes wide.
//  - Lane i of a direction therefore always lies inside the ribbon drawn here.
//
// Rules:
//  - Two opposite one-way roads that face each other (a divided highway) keep a median between them: where
//    their ribbons would touch, each is pulled back on the facing side, in proportion to its width.
//  - Paint is generated inside its own ribbon, never outside it.
//  - Paint stops JUNCTION_GAP_M before the ribbon of any road that crosses it (or ends in it), so the box of
//    an intersection has no lane lines. Pieces of one road that meet end to end (a continuation) don't cut
//    each other. Where two nearly parallel ribbons overlap, the road with more lanes keeps its paint.
//  - Parking aisles get no paint at all; stall lines are drawn on both sides of an aisle instead.
import type { Vec2 } from "./contracts/geometry";
import type { Building, ParkingArea, RoadNetwork, RoadWay } from "./contracts/roads";

export const ART = {
  /** Longest stretch between two points of a drawn road, so it can follow the terrain. */
  STEP_M: 1.5,
  /** Edge lines sit this far inside the ribbon edge. */
  EDGE_IN_M: 0.3,
  /** A lane line must be this far from the ribbon edge to be drawn. */
  LANE_CLEAR_M: 0.4,
  /** Least median kept between two facing one-way carriageways. */
  MEDIAN_M: 2.5,
  /** A ribbon is never pulled in below this half-width. */
  MIN_EXT_M: 1.5,
  /** Paint ends this far before the ribbon of a crossing road. */
  JUNCTION_GAP_M: 1.5,
  /** Two roads are "parallel" when the cosine of the angle between them is above this (about 25 degrees). */
  PARALLEL_COS: 0.9,
  /** Two roads that meet end to end continue each other when their outward directions are this opposed (about 35 degrees off straight). */
  CONTINUE_COS: -0.82,
  /** End points this close are the same junction. */
  JOIN_M: 1.5,
  /** Spacing of the checks that cut paint. */
  SAMPLE_M: 0.5,
  STALL_W_M: 2.6,
  STALL_D_M: 5.5,
  /** A stall shorter than this (the lot polygon, a building or another road is in the way) is not drawn. */
  STALL_MIN_D_M: 4,
} as const;

export interface Box { readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number }

export interface Ribbon {
  readonly way: RoadWay;
  /** Centerline, with a point at least every ART.STEP_M. */
  readonly line: readonly Vec2[];
  /** Half-width to the left / right of travel at each point of `line`, m. */
  readonly left: readonly number[];
  readonly right: readonly number[];
  readonly leftEdge: readonly Vec2[];
  readonly rightEdge: readonly Vec2[];
  /** The ribbon outline: left edge forward, right edge back. */
  readonly polygon: readonly Vec2[];
  readonly box: Box;
}

export type PaintKind = "center" | "lane" | "edge" | "stall";
export interface PaintLine {
  /** The road (or, for stalls, the aisle) the line belongs to. */
  readonly roadId: string;
  readonly kind: PaintKind;
  readonly dashed: boolean;
  readonly points: readonly Vec2[];
}

export interface RoadArt {
  readonly ribbons: readonly Ribbon[];
  readonly paint: readonly PaintLine[];
  readonly lots: readonly ParkingArea[];
  byId(id: string): Ribbon | undefined;
}

// ------------------------------------------------------------------ small geometry

const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);
const unitOf = (a: Vec2, b: Vec2): Vec2 => { const d = dist(a, b) || 1; return { x: (b.x - a.x) / d, y: (b.y - a.y) / d }; };

function boxOf(pts: readonly Vec2[], pad = 0): Box {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) { if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x; if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y; }
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}
const boxesTouch = (a: Box, b: Box) => a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;
const inBox = (b: Box, p: Vec2, pad = 0) => p.x >= b.minX - pad && p.x <= b.maxX + pad && p.y >= b.minY - pad && p.y <= b.maxY + pad;

/** Even-odd point in polygon. */
export function pointInPolygon(p: Vec2, poly: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!, b = poly[j]!;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Drop consecutive points closer than 1 cm. */
function cleanPts(pts: readonly Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const p of pts) if (out.length === 0 || dist(out[out.length - 1]!, p) > 0.01) out.push(p);
  return out;
}

/** Add points so no segment is longer than step; original points are kept. */
export function densify(pts: readonly Vec2[], step: number = ART.STEP_M): Vec2[] {
  const clean = cleanPts(pts);
  const out: Vec2[] = [];
  for (let i = 0; i < clean.length; i++) {
    const a = clean[i]!;
    out.push(a);
    const b = clean[i + 1];
    if (!b) break;
    const n = Math.ceil(dist(a, b) / step);
    for (let k = 1; k < n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
  }
  return out;
}

/**
 * Offset a polyline sideways (positive = right of travel), by one distance or one per point, with mitred
 * joins (capped so a sharp bend doesn't spike).
 */
export function offsetPolyline(points: readonly Vec2[], d: number | readonly number[]): Vec2[] {
  const n = points.length;
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const p = points[i]!;
    const a = points[Math.max(0, i - 1)]!, b = points[Math.min(n - 1, i + 1)]!;
    const t = unitOf(a, b);
    let nx = t.y, ny = -t.x;
    if (i > 0 && i < n - 1) {
      const t0 = unitOf(points[i - 1]!, p), t1 = unitOf(p, points[i + 1]!);
      const n0 = { x: t0.y, y: -t0.x }, n1 = { x: t1.y, y: -t1.x };
      const mx = n0.x + n1.x, my = n0.y + n1.y, ml = Math.hypot(mx, my);
      if (ml > 1e-6) {
        const cos = (mx / ml) * n0.x + (my / ml) * n0.y;
        const scale = 1 / Math.max(cos, 0.35);
        nx = (mx / ml) * scale; ny = (my / ml) * scale;
      }
    }
    const di = typeof d === "number" ? d : d[i]!;
    out.push({ x: p.x + nx * di, y: p.y + ny * di });
  }
  return out;
}

// ------------------------------------------------------------------ ribbons

/** Half-widths (left, right of travel) of a road, from the lane convention in the header. */
export function baseExtents(w: RoadWay): { left: number; right: number } {
  const f = Math.max(w.lanesForward, 0), b = Math.max(w.lanesBackward, 0), lw = w.laneWidthM;
  if (w.oneway) { const e = (Math.max(f, 1) * lw) / 2; return { left: e, right: e }; }
  return { left: b * lw, right: (f + b === 0 ? 1 : f) * lw };
}

interface Nearest { readonly q: Vec2; readonly dir: Vec2; readonly d: number; readonly i: number }
function nearestOnLine(line: readonly Vec2[], p: Vec2): Nearest {
  let best: Nearest = { q: line[0]!, dir: { x: 1, y: 0 }, d: Infinity, i: 0 };
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i]!, b = line[i + 1]!;
    const vx = b.x - a.x, vy = b.y - a.y, l2 = vx * vx + vy * vy || 1;
    const t = Math.min(1, Math.max(0, ((p.x - a.x) * vx + (p.y - a.y) * vy) / l2));
    const q = { x: a.x + vx * t, y: a.y + vy * t };
    const d = dist(p, q);
    if (d < best.d) { const l = Math.sqrt(l2); best = { q, dir: { x: vx / l, y: vy / l }, d, i }; }
  }
  return best;
}

interface Draft { way: RoadWay; line: Vec2[]; left: number[]; right: number[]; base: { left: number; right: number }; box: Box }

/** Pull the facing sides of opposite one-way roads back so a median of at least ART.MEDIAN_M stays between them. */
function applyMedians(drafts: Draft[]): void {
  const oneways = drafts.filter((d) => d.way.oneway);
  for (const a of oneways) {
    for (const b of oneways) {
      if (a === b || !boxesTouch(boxOf(a.line, 40), b.box)) continue;
      for (let i = 0; i < a.line.length; i++) {
        const p = a.line[i]!;
        const near = nearestOnLine(b.line, p);
        if (near.d > 60) continue;
        const ta = unitOf(a.line[Math.max(0, i - 1)]!, a.line[Math.min(a.line.length - 1, i + 1)]!);
        if (ta.x * near.dir.x + ta.y * near.dir.y > -0.7) continue; // not facing the other way
        const vx = near.q.x - p.x, vy = near.q.y - p.y;
        const along = vx * ta.x + vy * ta.y;
        const lateral = vx * ta.y - vy * ta.x; // positive = to the right of a's travel
        const g = Math.abs(lateral);
        if (Math.abs(along) > 0.4 * near.d || g < 0.5) continue; // beside, not ahead or behind
        const mine = a.base.right, theirs = b.base.right; // one-way roads are symmetric
        if (mine + theirs + ART.MEDIAN_M <= g) continue;
        const limit = Math.max(ART.MIN_EXT_M, ((g - ART.MEDIAN_M) * mine) / (mine + theirs));
        const side = lateral > 0 ? a.right : a.left;
        side[i] = Math.min(side[i]!, limit);
      }
    }
  }
}

function buildRibbons(net: RoadNetwork): Ribbon[] {
  const drafts: Draft[] = [];
  for (const way of net.ways) {
    const line = densify(way.centerline);
    if (line.length < 2) continue;
    const base = baseExtents(way);
    drafts.push({ way, line, left: line.map(() => base.left), right: line.map(() => base.right), base, box: boxOf(line, Math.max(base.left, base.right)) });
  }
  applyMedians(drafts);
  return drafts.map((d) => {
    const leftEdge = offsetPolyline(d.line, d.left.map((e) => -e));
    const rightEdge = offsetPolyline(d.line, d.right);
    const polygon = [...leftEdge, ...[...rightEdge].reverse()];
    return { way: d.way, line: d.line, left: d.left, right: d.right, leftEdge, rightEdge, polygon, box: boxOf(polygon) };
  });
}

/**
 * How far outside the ribbon p is (negative = inside), measured sideways from the centerline. Beyond an
 * end of the line the ribbon stops square, unless `over` allows a stretch past that end (used where a
 * road ends inside another one and the junction box has to reach across it).
 * `dir` is the direction of the nearest piece of centerline.
 */
export function ribbonExcess(r: Ribbon, p: Vec2, over: { start: number; end: number } = { start: 0, end: 0 }): { excess: number; dir: Vec2 } {
  let best = Infinity;
  let dir: Vec2 = { x: 1, y: 0 };
  const line = r.line, last = line.length - 2;
  const side = (k: number, lat: number) => (lat >= 0 ? r.left[k]! : r.right[k]!);
  for (let i = 0; i <= last; i++) {
    const a = line[i]!, b = line[i + 1]!;
    const vx = b.x - a.x, vy = b.y - a.y, len = Math.hypot(vx, vy) || 1;
    const ux = vx / len, uy = vy / len;
    const px = p.x - a.x, py = p.y - a.y;
    const s = px * ux + py * uy;          // along the segment
    const lat = px * -uy + py * ux;       // positive = left of travel
    let e: number;
    if (s >= 0 && s <= len) {
      const t = s / len;
      const ext = lat >= 0 ? r.left[i]! + (r.left[i + 1]! - r.left[i]!) * t : r.right[i]! + (r.right[i + 1]! - r.right[i]!) * t;
      e = Math.abs(lat) - ext;
    } else if (s < 0) {
      if (i !== 0) continue; // the piece before covers this
      e = Math.max(Math.abs(lat) - side(0, lat), -s - over.start);
    } else if (i === last) {
      e = Math.max(Math.abs(lat) - side(i + 1, lat), s - len - over.end);
    } else {
      // Past the end of a piece that has a next one: only the outer wedge of a bend belongs to neither piece.
      const c = line[i + 2]!;
      const nx = c.x - b.x, ny = c.y - b.y, nl = Math.hypot(nx, ny) || 1;
      const nux = nx / nl, nuy = ny / nl;
      const qx = p.x - b.x, qy = p.y - b.y;
      if (qx * nux + qy * nuy >= 0) continue; // the next piece covers it
      const lat2 = qx * -nuy + qy * nux;
      if (lat2 * lat < 0) continue;
      const ext = side(i + 1, lat);
      e = Math.max(Math.abs(lat) - ext, Math.abs(lat2) - ext); // inside the mitred corner
    }
    if (e < best) { best = e; dir = { x: ux, y: uy }; }
  }
  return { excess: best, dir };
}

/** Is p inside the ribbon of road `id` (within tol, m, of its edge)? */
export function insideRibbon(art: RoadArt, id: string, p: Vec2, tol = 0): boolean {
  const r = art.byId(id);
  return r !== undefined && inBox(r.box, p, tol + 1) && ribbonExcess(r, p).excess <= tol;
}

// ------------------------------------------------------------------ junction relations

function endsOf(r: Ribbon): Array<{ p: Vec2; out: Vec2 }> {
  const line = r.line;
  const outward = (from: number, step: number): Vec2 => {
    const o = line[from]!;
    let k = from + step;
    while (k > 0 && k < line.length - 1 && dist(o, line[k]!) < 6) k += step;
    return unitOf(o, line[Math.min(line.length - 1, Math.max(0, k))]!);
  };
  return [{ p: line[0]!, out: outward(0, 1) }, { p: line[line.length - 1]!, out: outward(line.length - 1, -1) }];
}

/** Do the two roads meet end to end and carry on in about the same direction (one street in two pieces)? */
export function isContinuation(a: Ribbon, b: Ribbon): boolean {
  for (const ea of endsOf(a)) for (const eb of endsOf(b)) {
    if (dist(ea.p, eb.p) <= ART.JOIN_M && ea.out.x * eb.out.x + ea.out.y * eb.out.y <= ART.CONTINUE_COS) return true;
  }
  return false;
}

const lanesTotal = (w: RoadWay) => Math.max(1, w.lanesForward + w.lanesBackward);
/** Which of two overlapping, nearly parallel roads keeps its paint: more lanes, then the lower id. */
const outranks = (b: RoadWay, a: RoadWay) => lanesTotal(b) > lanesTotal(a) || (lanesTotal(b) === lanesTotal(a) && b.id < a.id);

/** How far the ends of `b` may be treated as reaching into `a`: where b's end lies inside a, the distance it takes to cross a. */
function overshootInto(b: Ribbon, a: Ribbon): { start: number; end: number } {
  const res = { start: 0, end: 0 };
  endsOf(b).forEach((e, idx) => {
    if (ribbonExcess(a, e.p).excess > -0.2) return;
    const dir = { x: -e.out.x, y: -e.out.y }; // continuing past the end
    let o = 0;
    while (o < 25 && ribbonExcess(a, { x: e.p.x + dir.x * o, y: e.p.y + dir.y * o }).excess < 0) o += 0.5;
    if (idx === 0) res.start = o; else res.end = o;
  });
  return res;
}

// ------------------------------------------------------------------ paint

interface RawLine { kind: PaintKind; dashed: boolean; d: number[]; ok: boolean[] }

function rawLines(r: Ribbon): RawLine[] {
  const w = r.way;
  if (w.kind === "parking_aisle") return [];
  const out: RawLine[] = [];
  const lw = w.laneWidthM;
  const f = Math.max(w.lanesForward, 0), b = Math.max(w.lanesBackward, 0);
  const fixed = (kind: PaintKind, dashed: boolean, d: number): void => {
    out.push({ kind, dashed, d: r.line.map(() => d), ok: r.line.map((_, i) => (d >= 0 ? r.right[i]! : r.left[i]!) - Math.abs(d) >= ART.LANE_CLEAR_M) });
  };
  const edges = w.kind !== "service";
  if (w.oneway) {
    const e = (Math.max(f, 1) * lw) / 2;
    if (w.kind !== "service") for (let j = 1; j < Math.max(f, 1); j++) fixed("lane", true, -e + j * lw);
  } else {
    if (f > 0 && b > 0) out.push({ kind: "center", dashed: false, d: r.line.map(() => 0), ok: r.line.map(() => true) });
    if (w.kind !== "service") {
      for (let j = 1; j < f; j++) fixed("lane", true, j * lw);
      for (let j = 1; j < b; j++) fixed("lane", true, -j * lw);
    }
  }
  if (edges) {
    out.push({ kind: "edge", dashed: false, d: r.line.map((_, i) => -(r.left[i]! - ART.EDGE_IN_M)), ok: r.line.map((_, i) => r.left[i]! > 1) });
    out.push({ kind: "edge", dashed: false, d: r.line.map((_, i) => r.right[i]! - ART.EDGE_IN_M), ok: r.line.map((_, i) => r.right[i]! > 1) });
  }
  return out;
}

/** Split a polyline into the pieces for which blocked() is false; boundaries are found to about 5 cm. */
function cutRun(pts: readonly Vec2[], blocked: (p: Vec2, dir: Vec2) => boolean): Vec2[][] {
  const runs: Vec2[][] = [];
  let cur: Vec2[] = [];
  const flush = () => { const c = cleanPts(cur); if (c.length >= 2) runs.push(c); cur = []; };
  let prev: Vec2 | null = null, prevBlocked = false;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!, b = pts[i + 1]!;
    const len = dist(a, b);
    const dir = unitOf(a, b);
    const n = Math.max(1, Math.ceil(len / ART.SAMPLE_M));
    for (let k = i === 0 ? 0 : 1; k <= n; k++) {
      const p = k === n ? b : { x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n };
      const bl = blocked(p, dir);
      if (prev && bl !== prevBlocked) {
        let lo = prev, hi = p;
        for (let it = 0; it < 4; it++) {
          const mid = { x: (lo.x + hi.x) / 2, y: (lo.y + hi.y) / 2 };
          if (blocked(mid, dir) === prevBlocked) lo = mid; else hi = mid;
        }
        const edge = prevBlocked ? hi : lo; // the free side of the boundary
        if (bl) { cur.push(edge); flush(); } else { cur = [edge]; }
      }
      if (!bl) cur.push(p);
      prev = p; prevBlocked = bl;
    }
  }
  flush();
  return runs.filter((r) => r.reduce((s, p, i) => (i ? s + dist(r[i - 1]!, p) : 0), 0) >= 0.5);
}

function validRuns(pts: readonly Vec2[], ok: readonly boolean[]): Vec2[][] {
  const runs: Vec2[][] = [];
  let cur: Vec2[] = [];
  pts.forEach((p, i) => {
    if (ok[i]) cur.push(p);
    else { if (cur.length >= 2) runs.push(cur); cur = []; }
  });
  if (cur.length >= 2) runs.push(cur);
  return runs;
}

function roadPaint(ribbons: readonly Ribbon[]): PaintLine[] {
  const out: PaintLine[] = [];
  const overshoot = new Map<string, { start: number; end: number }>();
  const over = (b: Ribbon, a: Ribbon) => {
    const key = `${b.way.id}>${a.way.id}`;
    let v = overshoot.get(key);
    if (!v) { v = overshootInto(b, a); overshoot.set(key, v); }
    return v;
  };
  for (const a of ribbons) {
    const lines = rawLines(a);
    if (lines.length === 0) continue;
    const near = ribbons.filter((b) => b !== a && boxesTouch(a.box, { minX: b.box.minX - 30, minY: b.box.minY - 30, maxX: b.box.maxX + 30, maxY: b.box.maxY + 30 }) && !isContinuation(a, b));
    const near2 = near.map((b) => ({ b, over: over(b, a) }));
    const blockedFor = (kind: PaintKind) => (p: Vec2, dir: Vec2): boolean => {
      for (const { b, over: ov } of near2) {
        if (!inBox(b.box, p, ART.JUNCTION_GAP_M + 30)) continue;
        const { excess, dir: bd } = ribbonExcess(b, p, ov);
        if (excess >= ART.JUNCTION_GAP_M) continue;
        const parallel = Math.abs(bd.x * dir.x + bd.y * dir.y) > ART.PARALLEL_COS;
        if (!parallel) return true;
        if (excess < 0 && outranks(b.way, a.way)) return true;
        // An edge line well inside another road's surface is no longer an edge: the two roads are one surface there.
        if (kind === "edge" && excess < -ART.EDGE_IN_M * 2) return true;
      }
      return false;
    };
    for (const l of lines) {
      const pts = offsetPolyline(a.line, l.d);
      const blocked = blockedFor(l.kind);
      for (const run of validRuns(pts, l.ok)) {
        for (const piece of cutRun(run, blocked)) out.push({ roadId: a.way.id, kind: l.kind, dashed: l.dashed, points: piece });
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------ parking stalls

function stallPaint(ribbons: readonly Ribbon[], lots: readonly ParkingArea[], buildings: readonly Building[]): PaintLine[] {
  const out: PaintLine[] = [];
  if (lots.length === 0) return out;
  const lotBoxes = lots.map((l) => boxOf(l.outline));
  const bBoxes = buildings.map((b) => boxOf(b.footprint));
  const step = 0.25;
  for (const aisle of ribbons) {
    if (aisle.way.kind !== "parking_aisle") continue;
    const line = aisle.line;
    const cum = [0];
    for (let i = 1; i < line.length; i++) cum.push(cum[i - 1]! + dist(line[i - 1]!, line[i]!));
    const total = cum[cum.length - 1]!;
    const at = (s: number): { p: Vec2; t: Vec2 } => {
      let i = 0;
      while (i < line.length - 2 && cum[i + 1]! < s) i++;
      const a = line[i]!, b = line[i + 1]!, seg = cum[i + 1]! - cum[i]! || 1;
      const k = Math.min(1, Math.max(0, (s - cum[i]!) / seg));
      return { p: { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k }, t: unitOf(a, b) };
    };
    const others = ribbons.filter((r) => r !== aisle && boxesTouch(r.box, boxOf(line, ART.STALL_D_M + 8)) && !isContinuation(r, aisle));
    for (let s = 0; s <= total + 1e-6; s += ART.STALL_W_M) {
      const { p, t } = at(Math.min(s, total));
      const before = at(Math.max(0, s - ART.STALL_W_M / 2)).t, after = at(Math.min(total, s + ART.STALL_W_M / 2)).t;
      if (before.x * after.x + before.y * after.y < 0.9) continue; // a tight bend: stalls would fan out
      const lotIdx = lots.findIndex((l, i) => inBox(lotBoxes[i]!, p) && pointInPolygon(p, l.outline));
      if (lotIdx < 0) continue;
      const lot = lots[lotIdx]!;
      for (const side of [1, -1]) {
        const n = { x: t.y * side, y: -t.x * side };
        const ext = side > 0 ? aisle.right[0]! : aisle.left[0]!;
        const a = { x: p.x + n.x * ext, y: p.y + n.y * ext };
        let free = 0;
        for (let d = 0.1; d <= ART.STALL_D_M + 1e-6; d += step) {
          const q = { x: a.x + n.x * d, y: a.y + n.y * d };
          if (!pointInPolygon(q, lot.outline)) break;
          if (buildings.some((b, i) => inBox(bBoxes[i]!, q) && pointInPolygon(q, b.footprint))) break;
          if (others.some((r) => inBox(r.box, q, 1) && ribbonExcess(r, q).excess < 0.1)) break;
          free = d;
        }
        if (free < ART.STALL_MIN_D_M) continue;
        out.push({ roadId: aisle.way.id, kind: "stall", dashed: false, points: [a, { x: a.x + n.x * free, y: a.y + n.y * free }] });
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------ the whole thing

const cache = new WeakMap<RoadNetwork, RoadArt>();

/** Ribbons, paint and stalls for a road network. Memoised per network object. */
export function buildRoadArt(net: RoadNetwork): RoadArt {
  const hit = cache.get(net);
  if (hit) return hit;
  const ribbons = buildRibbons(net);
  const byId = new Map(ribbons.map((r) => [r.way.id, r] as const));
  const art: RoadArt = {
    ribbons,
    paint: [...roadPaint(ribbons), ...stallPaint(ribbons, net.parking, net.buildings)],
    lots: net.parking,
    byId: (id) => byId.get(id),
  };
  cache.set(net, art);
  return art;
}

// ------------------------------------------------------------------ street names

/** A place along a named road where its name could be laid flat on the surface. */
export interface NameSpot {
  readonly name: string;
  readonly at: Vec2;
  /** Direction of the text, radians counter-clockwise from east, kept upright (within about 12 degrees of the -90 to 90 range, leaning to read north-south names bottom-up). */
  readonly angleRad: number;
  /** Straight stretch free of junctions either side of `at`, m: the text may be up to twice this long. */
  readonly halfSpanM: number;
  /** Width of the road across, m. */
  readonly widthM: number;
}

const NAME_STEP_M = 4;
const NAME_MAX_REACH_M = 40;
/** The text must clear every crossing road by this much either side of the centerline, m. */
const NAME_CLEAR_M = 1;
const NAME_MAX_TURN_COS = 0.94; // about 20 degrees
const NAME_LEAN_RAD = 0.21; // about 12 degrees

const upright = (a: number): number => {
  let x = a;
  // A road that runs about north-south reads from the bottom up, so the range leans a little past 90 degrees.
  while (x > Math.PI / 2 + NAME_LEAN_RAD) x -= Math.PI;
  while (x <= -Math.PI / 2 + NAME_LEAN_RAD) x += Math.PI;
  return x;
};

/**
 * Candidate places for street names within maxDistM of `focus`: along every named road, outside the
 * boxes of junctions, on stretches that stay straight. Several per road; the caller picks.
 */
export function streetNameSpots(art: RoadArt, focus: Vec2, maxDistM = 120): NameSpot[] {
  const out: NameSpot[] = [];
  for (const r of art.ribbons) {
    const name = r.way.name?.trim();
    if (!name || r.way.kind === "parking_aisle") continue;
    const line = r.line;
    const cum = [0];
    for (let i = 1; i < line.length; i++) cum.push(cum[i - 1]! + dist(line[i - 1]!, line[i]!));
    const total = cum[cum.length - 1]!;
    const at = (s: number): { p: Vec2; t: Vec2; k: number } => {
      let i = 0;
      while (i < line.length - 2 && cum[i + 1]! < s) i++;
      const a = line[i]!, b = line[i + 1]!, seg = cum[i + 1]! - cum[i]! || 1;
      const f = Math.min(1, Math.max(0, (s - cum[i]!) / seg));
      return { p: { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }, t: unitOf(a, b), k: i };
    };
    const others = art.ribbons.filter((b) => b !== r && boxesTouch(b.box, boxOf(line, NAME_MAX_REACH_M + NAME_CLEAR_M)) && !isContinuation(r, b));
    for (let s = NAME_STEP_M; s <= total - NAME_STEP_M; s += NAME_STEP_M) {
      const c = at(s);
      if (dist(c.p, focus) > maxDistM) continue;
      const free = (q: Vec2, t: Vec2): boolean => others.every((b) => {
        if (!inBox(b.box, q, NAME_CLEAR_M + 2)) return true;
        const { excess, dir } = ribbonExcess(b, q);
        if (excess >= NAME_CLEAR_M) return true;
        return Math.abs(dir.x * t.x + dir.y * t.y) > ART.PARALLEL_COS; // a parallel neighbour doesn't cross the text
      });
      if (!free(c.p, c.t)) continue;
      const reach = (sign: 1 | -1): number => {
        let d = 0;
        for (; d < NAME_MAX_REACH_M; d += 1) {
          const ss = s + sign * (d + 1);
          if (ss < 0 || ss > total) break;
          const q = at(ss);
          if (q.t.x * c.t.x + q.t.y * c.t.y < NAME_MAX_TURN_COS || !free(q.p, q.t)) break;
        }
        return d;
      };
      const half = Math.min(reach(1), reach(-1));
      if (half < 3) continue;
      const width = r.left[c.k]! + r.right[c.k]!;
      const angleRad = upright(Math.atan2(c.t.y, c.t.x));
      out.push({ name, at: c.p, angleRad, halfSpanM: half, widthM: width });
      if (width >= 8) {
        // A wide road: the name can also sit in the middle of either half, out of the way of what is on the centerline.
        for (const off of [r.right[c.k]! * 0.5, -r.left[c.k]! * 0.5]) out.push({ name, at: { x: c.p.x + c.t.y * off, y: c.p.y - c.t.x * off }, angleRad, halfSpanM: half, widthM: width });
      }
    }
  }
  return out;
}

export interface PlacedName extends NameSpot {
  readonly lengthM: number;
  readonly heightM: number;
}

/** Do two text boxes (centre, direction, length, height) overlap, with a gap, m? */
function boxesOverlap(a: PlacedName, b: PlacedName, gap: number): boolean {
  const axes = [a.angleRad, b.angleRad].flatMap((t) => [{ x: Math.cos(t), y: Math.sin(t) }, { x: -Math.sin(t), y: Math.cos(t) }]);
  const radius = (n: PlacedName, ax: Vec2): number => {
    const c = Math.cos(n.angleRad), s = Math.sin(n.angleRad);
    return (Math.abs(ax.x * c + ax.y * s) * n.lengthM + Math.abs(-ax.x * s + ax.y * c) * n.heightM) / 2;
  };
  return axes.every((ax) => Math.abs((a.at.x - b.at.x) * ax.x + (a.at.y - b.at.y) * ax.y) < radius(a, ax) + radius(b, ax) + gap);
}

/**
 * One name per street, laid out so no two overlap and none sits on the focus (where the vehicles are).
 * `size` gives the text sizes to try, largest first, for a name on a road of that width. Streets whose best spot
 * is nearest the preferred distance from the focus go first; a name with no free spot is left off. The text
 * stays at least `keepClearM` from the focus, within `maxReachM` of it, and inside the `inside` polygon (the
 * part of the ground in view) when one is given.
 */
export function placeStreetNames(
  spots: readonly NameSpot[],
  size: (name: string, roadWidthM: number) => ReadonlyArray<{ lengthM: number; heightM: number }>,
  focus: Vec2,
  opts: { preferM?: number; keepClearM?: number; maxReachM?: number; avoid?: readonly Vec2[]; inside?: readonly Vec2[] } = {},
): PlacedName[] {
  const prefer = opts.preferM ?? 14, clear = opts.keepClearM ?? 5, reach = opts.maxReachM ?? Infinity;
  const byName = new Map<string, NameSpot[]>();
  for (const s of spots) byName.set(s.name, [...(byName.get(s.name) ?? []), s]);
  const rank = (s: NameSpot) => Math.abs(dist(s.at, focus) - prefer);
  const names = [...byName.values()].map((list) => [...list].sort((a, b) => rank(a) - rank(b))).sort((a, b) => rank(a[0]!) - rank(b[0]!));
  const placed: PlacedName[] = [];
  for (const list of names) {
    for (const s of list) {
      // Try the sizes largest first: a smaller name fits where a bigger one doesn't.
      let cand: PlacedName | null = null;
      for (const { lengthM, heightM } of size(s.name, s.widthM)) {
        if (lengthM + 1 > s.halfSpanM * 2) continue;
        const c = Math.cos(s.angleRad), sn = Math.sin(s.angleRad);
        const trial: PlacedName = { ...s, lengthM, heightM };
        const fu = Math.abs((focus.x - s.at.x) * c + (focus.y - s.at.y) * sn), fv = Math.abs(-(focus.x - s.at.x) * sn + (focus.y - s.at.y) * c);
        if (Math.hypot(Math.max(fu - lengthM / 2, 0), Math.max(fv - heightM / 2, 0)) < clear) continue; // not on the crash
        if (Math.hypot(fu + lengthM / 2, fv + heightM / 2) > reach) continue; // and not so far out that the view may cut it off
        if (opts.inside) {
          const corners = [[1, 1], [1, -1], [-1, -1], [-1, 1]].map(([i, j]) => ({ x: s.at.x + (i! * lengthM * c) / 2 - (j! * heightM * sn) / 2, y: s.at.y + (i! * lengthM * sn) / 2 + (j! * heightM * c) / 2 }));
          if (!corners.every((q) => pointInPolygon(q, opts.inside!))) continue; // the whole text has to be in view
        }
        if (placed.some((p) => boxesOverlap(p, trial, 1.5))) continue;
        if ((opts.avoid ?? []).some((a) => Math.abs((a.x - s.at.x) * c + (a.y - s.at.y) * sn) < lengthM / 2 + 0.8 && Math.abs(-(a.x - s.at.x) * sn + (a.y - s.at.y) * c) < heightM / 2 + 0.8)) continue;
        cand = trial;
        break;
      }
      if (!cand) continue;
      placed.push(cand);
      break;
    }
  }
  return placed;
}
