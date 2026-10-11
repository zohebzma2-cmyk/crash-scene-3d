// Plain 2-D geometry for the physics. Local frame: x = east, y = north, meters.
// Compass bearings (0 = north, clockwise) are converted to math vectors ONLY here:
//   forward vector of bearing h:  (sin h, cos h)
//   right-hand vector of bearing h: (cos h, -sin h)
//   bearing of a vector v: atan2(v.x, v.y)
import type { Vec2 } from "../contracts/geometry";

export const TAU = Math.PI * 2;
export const toRad = (d: number): number => (d * Math.PI) / 180;
export const toDeg = (r: number): number => (r * 180) / Math.PI;

export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const mul = (a: Vec2, k: number): Vec2 => ({ x: a.x * k, y: a.y * k });
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
/** z of the 3-D cross product a x b (counter-clockwise positive). */
export const cross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x;
export const norm = (a: Vec2): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);
export const unit = (a: Vec2): Vec2 => { const n = norm(a); return n < 1e-12 ? { x: 0, y: 0 } : { x: a.x / n, y: a.y / n }; };

/** Unit vector a vehicle with this compass bearing faces. */
export const fwdOf = (bearingRad: number): Vec2 => ({ x: Math.sin(bearingRad), y: Math.cos(bearingRad) });
/** Unit vector to the right of a compass bearing (north -> east). */
export const rightOf = (bearingRad: number): Vec2 => ({ x: Math.cos(bearingRad), y: -Math.sin(bearingRad) });
/** Compass bearing (radians, may be negative) of a vector. */
export const bearingOf = (v: Vec2): number => Math.atan2(v.x, v.y);

export const wrapPi = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));
/** Normalise to [0, 2 pi). */
export const wrap2Pi = (a: number): number => { const r = a % TAU; return r < 0 ? r + TAU : r; };
/** Smallest absolute angle between two bearings, radians. */
export const angleBetween = (a: number, b: number): number => Math.abs(wrapPi(a - b));

// ---------------------------------------------------------------- polylines

export interface Poly {
  readonly pts: readonly Vec2[];
  /** Cumulative arc length at each vertex. */
  readonly cum: readonly number[];
  readonly length: number;
}

export function makePoly(pts: readonly Vec2[]): Poly {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1]! + dist(pts[i - 1]!, pts[i]!));
  return { pts, cum, length: cum[cum.length - 1]! };
}

export interface PolyPoint { readonly p: Vec2; /** Compass bearing of travel here, radians. */ readonly bearing: number; }

/** Point and travel bearing at arc length s; beyond either end the first/last segment is extended straight. */
export function pointAt(poly: Poly, s: number): PolyPoint {
  const n = poly.pts.length;
  if (n === 1) return { p: poly.pts[0]!, bearing: 0 };
  let i = 0;
  if (s >= poly.length) i = n - 2;
  else if (s > 0) { while (i < n - 2 && poly.cum[i + 1]! < s) i++; }
  // Skip zero-length segments.
  let k = i;
  while (k > 0 && poly.cum[k + 1]! - poly.cum[k]! < 1e-9) k--;
  while (k < n - 2 && poly.cum[k + 1]! - poly.cum[k]! < 1e-9) k++;
  const a = poly.pts[k]!, b = poly.pts[k + 1]!;
  const segLen = poly.cum[k + 1]! - poly.cum[k]!;
  const t = segLen < 1e-9 ? 0 : (s - poly.cum[k]!) / segLen;
  return { p: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, bearing: bearingOf(sub(b, a)) };
}

export interface Projection { readonly s: number; readonly dist: number; readonly point: Vec2 }

/** Closest point of the polyline to p, as arc length, distance and point. */
export function project(poly: Poly, p: Vec2): Projection {
  let best: Projection = { s: 0, dist: Infinity, point: poly.pts[0]! };
  for (let i = 0; i + 1 < poly.pts.length; i++) {
    const a = poly.pts[i]!, b = poly.pts[i + 1]!, ab = sub(b, a);
    const l2 = dot(ab, ab);
    const t = l2 < 1e-18 ? 0 : Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2));
    const q = { x: a.x + ab.x * t, y: a.y + ab.y * t };
    const d = dist(p, q);
    if (d < best.dist - 1e-12) best = { s: poly.cum[i]! + t * Math.sqrt(l2), dist: d, point: q };
  }
  return best;
}

/** Intersection of segments p->p2 and q->q2 as (t, u) along each, or null when parallel/missing. */
export function segmentCross(p: Vec2, p2: Vec2, q: Vec2, q2: Vec2): { t: number; u: number } | null {
  const r = sub(p2, p), s = sub(q2, q);
  const den = cross(r, s);
  if (Math.abs(den) < 1e-12) return null;
  const qp = sub(q, p);
  const t = cross(qp, s) / den, u = cross(qp, r) / den;
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
  return { t, u };
}

export interface Crossing { readonly point: Vec2; /** Arc length along the first polyline. */ readonly sA: number; readonly sB: number }

/**
 * Margin for the bounding-box screen in polyCrossings, m. segmentCross accepts t and u up to 1e-9 past either end, which
 * is under 1e-6 m for any segment shorter than 1,000 km, so boxes grown by this never drop a crossing it would find.
 */
const BOX_MARGIN_M = 1e-6;

/** Bounding boxes of a polyline's segments, [minX, maxX, minY, maxY] per segment, cached per polyline. */
const segBoxCache = new WeakMap<Poly, Float64Array>();
function segBoxes(poly: Poly): Float64Array {
  const hit = segBoxCache.get(poly);
  if (hit) return hit;
  const n = Math.max(0, poly.pts.length - 1);
  const out = new Float64Array(4 * n);
  for (let i = 0; i < n; i++) {
    const p = poly.pts[i]!, q = poly.pts[i + 1]!;
    out[4 * i] = Math.min(p.x, q.x) - BOX_MARGIN_M; out[4 * i + 1] = Math.max(p.x, q.x) + BOX_MARGIN_M;
    out[4 * i + 2] = Math.min(p.y, q.y) - BOX_MARGIN_M; out[4 * i + 3] = Math.max(p.y, q.y) + BOX_MARGIN_M;
  }
  segBoxCache.set(poly, out);
  return out;
}

/** Crossings already worked out, per pair of polylines (polylines are never changed after makePoly). */
const crossingCache = new WeakMap<Poly, WeakMap<Poly, readonly Crossing[]>>();

/**
 * Every crossing of two polylines, in the order of a's segments, then b's. Segment pairs whose boxes miss are skipped, and a
 * pair of polylines seen before is answered from a cache: the same result, faster. The caller gets its own array.
 */
export function polyCrossings(a: Poly, b: Poly): Crossing[] {
  let inner = crossingCache.get(a);
  const hit = inner?.get(b);
  if (hit) return [...hit];
  const out = crossingsOf(a, b);
  if (!inner) { inner = new WeakMap(); crossingCache.set(a, inner); }
  inner.set(b, out);
  return [...out];
}

function crossingsOf(a: Poly, b: Poly): Crossing[] {
  const out: Crossing[] = [];
  const ba = segBoxes(a), bb = segBoxes(b);
  for (let i = 0; i + 1 < a.pts.length; i++) {
    const ax0 = ba[4 * i]!, ax1 = ba[4 * i + 1]!, ay0 = ba[4 * i + 2]!, ay1 = ba[4 * i + 3]!;
    for (let j = 0; j + 1 < b.pts.length; j++) {
      if (bb[4 * j]! > ax1 || bb[4 * j + 1]! < ax0 || bb[4 * j + 2]! > ay1 || bb[4 * j + 3]! < ay0) continue;
      const p = a.pts[i]!, p2 = a.pts[i + 1]!, q = b.pts[j]!, q2 = b.pts[j + 1]!;
      const hit = segmentCross(p, p2, q, q2);
      if (!hit) continue;
      out.push({
        point: { x: p.x + (p2.x - p.x) * hit.t, y: p.y + (p2.y - p.y) * hit.t },
        sA: a.cum[i]! + hit.t * dist(p, p2), sB: b.cum[j]! + hit.u * dist(q, q2),
      });
    }
  }
  return out;
}

/** Points of the polyline between arc lengths s0 and s1 (inclusive ends interpolated). */
export function slicePoly(poly: Poly, s0: number, s1: number): Vec2[] {
  const out: Vec2[] = [pointAt(poly, s0).p];
  for (let i = 0; i < poly.pts.length; i++) if (poly.cum[i]! > s0 + 1e-9 && poly.cum[i]! < s1 - 1e-9) out.push(poly.pts[i]!);
  out.push(pointAt(poly, s1).p);
  return out;
}

export function reversePts(pts: readonly Vec2[]): Vec2[] { return [...pts].reverse(); }

/** Offset a polyline to the right of its travel direction by d meters (negative = left), mitring interior corners. */
export function offsetRight(pts: readonly Vec2[], d: number): Vec2[] {
  const clean: Vec2[] = [];
  for (const p of pts) if (clean.length === 0 || dist(clean[clean.length - 1]!, p) > 1e-9) clean.push(p);
  if (clean.length < 2) return clean.map((p) => ({ ...p }));
  const normals: Vec2[] = [];
  for (let i = 0; i + 1 < clean.length; i++) {
    const t = unit(sub(clean[i + 1]!, clean[i]!));
    normals.push({ x: t.y, y: -t.x }); // right-hand normal
  }
  return clean.map((p, i) => {
    if (i === 0) return add(p, mul(normals[0]!, d));
    if (i === clean.length - 1) return add(p, mul(normals[normals.length - 1]!, d));
    const n1 = normals[i - 1]!, n2 = normals[i]!;
    const denom = 1 + dot(n1, n2);
    if (denom < 0.2) return add(p, mul(unit(add(n1, n2)), d)); // hairpin: don't spike
    return add(p, mul(add(n1, n2), d / denom));
  });
}

// ---------------------------------------------------------------- polygons and boxes

/** Drop the repeated closing point if the ring has one (map data gives open rings; tests may close them). */
export function openRing(ring: readonly Vec2[]): Vec2[] {
  const r = [...ring];
  if (r.length > 1 && dist(r[0]!, r[r.length - 1]!) < 1e-9) r.pop();
  return r;
}

export function pointInRing(p: Vec2, ringIn: readonly Vec2[]): boolean {
  const ring = openRing(ringIn);
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!, b = ring[j]!;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** The four corners of a vehicle rectangle (length along the heading, width across), centre-based. */
export function boxCorners(cx: number, cy: number, headingRad: number, lengthM: number, widthM: number): Vec2[] {
  const f = fwdOf(headingRad), r = rightOf(headingRad);
  const at = (a: number, b: number): Vec2 => ({ x: cx + f.x * a + r.x * b, y: cy + f.y * a + r.y * b });
  return [at(lengthM / 2, widthM / 2), at(lengthM / 2, -widthM / 2), at(-lengthM / 2, -widthM / 2), at(-lengthM / 2, widthM / 2)];
}

/**
 * Separating-axis test for two convex polygons: smallest signed overlap over all edge axes.
 * Positive = penetration depth; negative = a gap at least that wide; about 0 = touching.
 * `axis` is the minimising axis oriented from b toward a.
 */
export function satDepth(a: readonly Vec2[], b: readonly Vec2[]): { depth: number; axis: Vec2 } {
  let best = Infinity;
  let bestAxis: Vec2 = { x: 1, y: 0 };
  let bestAbs = Infinity;
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i]!, q = poly[(i + 1) % poly.length]!;
      const axis = unit({ x: -(q.y - p.y), y: q.x - p.x });
      if (axis.x === 0 && axis.y === 0) continue;
      let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
      for (const v of a) { const d = dot(v, axis); if (d < minA) minA = d; if (d > maxA) maxA = d; }
      for (const v of b) { const d = dot(v, axis); if (d < minB) minB = d; if (d > maxB) maxB = d; }
      const overlap = Math.min(maxA, maxB) - Math.max(minA, minB);
      if (overlap < best) best = overlap;
      if (Math.abs(overlap) < bestAbs - 1e-12) { bestAbs = Math.abs(overlap); bestAxis = axis; }
    }
  }
  const ca = centroid(a), cb = centroid(b);
  const oriented = dot(sub(ca, cb), bestAxis) < 0 ? mul(bestAxis, -1) : bestAxis;
  return { depth: best, axis: oriented };
}

export function centroid(pts: readonly Vec2[]): Vec2 {
  let x = 0, y = 0;
  for (const p of pts) { x += p.x; y += p.y; }
  return { x: x / pts.length, y: y / pts.length };
}

/** Does a (possibly concave) ring overlap a vehicle box by more than tolM? The box is shrunk by tolM on every side first. */
export function boxOverlapsRing(cx: number, cy: number, headingRad: number, lengthM: number, widthM: number, ringIn: readonly Vec2[], tolM: number): boolean {
  const ring = openRing(ringIn);
  if (ring.length < 3) return false;
  const box = boxCorners(cx, cy, headingRad, Math.max(0.01, lengthM - 2 * tolM), Math.max(0.01, widthM - 2 * tolM));
  for (const c of box) if (pointInRing(c, ring)) return true;
  if (pointInRing({ x: cx, y: cy }, ring)) return true;
  for (const v of ring) if (pointInRing(v, box)) return true;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
    for (let j = 0; j < 4; j++) if (segmentCross(a, b, box[j]!, box[(j + 1) % 4]!)) return true;
  }
  return false;
}

/** Intersection of two convex polygons, both counter-clockwise (Sutherland-Hodgman); empty when they don't overlap. */
export function clipConvex(subject: readonly Vec2[], clip: readonly Vec2[]): Vec2[] {
  let out: Vec2[] = [...subject];
  for (let i = 0; i < clip.length && out.length; i++) {
    const a = clip[i]!, b = clip[(i + 1) % clip.length]!;
    const inside = (p: Vec2) => cross(sub(b, a), sub(p, a)) >= -1e-12; // left of the edge a->b
    const input = out;
    out = [];
    for (let j = 0; j < input.length; j++) {
      const cur = input[j]!, prev = input[(j + input.length - 1) % input.length]!;
      const curIn = inside(cur), prevIn = inside(prev);
      if (curIn !== prevIn) {
        const d1 = cross(sub(b, a), sub(prev, a)), d2 = cross(sub(b, a), sub(cur, a));
        const t = d1 / (d1 - d2);
        out.push({ x: prev.x + (cur.x - prev.x) * t, y: prev.y + (cur.y - prev.y) * t });
      }
      if (curIn) out.push(cur);
    }
  }
  return out;
}

/** Area centroid of a polygon (vertex average when it is degenerate). */
export function polygonCentroid(poly: readonly Vec2[]): Vec2 {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!, q = poly[(i + 1) % poly.length]!;
    const f = p.x * q.y - q.x * p.y;
    a += f; cx += (p.x + q.x) * f; cy += (p.y + q.y) * f;
  }
  return Math.abs(a) < 1e-12 ? centroid(poly) : { x: cx / (3 * a), y: cy / (3 * a) };
}
