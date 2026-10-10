// Small planar helpers in the local East-North frame (meters). x = east, y = north.
// Compass bearings are degrees, 0 = north, clockwise. Pure; no DOM.
import type { Vec2 } from "@csd/core";

export const DEG = Math.PI / 180;

export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);

/** Compass bearing from one point toward another, degrees [0, 360). */
export function bearingDeg(from: Vec2, to: Vec2): number {
  const b = Math.atan2(to.x - from.x, to.y - from.y) / DEG;
  return ((b % 360) + 360) % 360;
}

/** Unit vector for a compass bearing. */
export function unitFromBearing(deg: number): Vec2 {
  return { x: Math.sin(deg * DEG), y: Math.cos(deg * DEG) };
}

/** Smallest angle between two bearings, 0 to 180. */
export function angleDiffDeg(a: number, b: number): number {
  const d = Math.abs((((a - b) % 360) + 540) % 360 - 180);
  return d;
}

export function pointInPolygon(p: Vec2, poly: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (!a || !b) continue;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function polylineLength(pts: readonly Vec2[]): number {
  let s = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (a && b) s += dist(a, b);
  }
  return s;
}

export interface Nearest {
  readonly point: Vec2;
  /** Distance along the polyline from its first point, meters. */
  readonly s: number;
  readonly distance: number;
  readonly segment: number;
}

/** Closest point on a polyline to p. */
export function nearestOnPolyline(pts: readonly Vec2[], p: Vec2): Nearest | null {
  let best: Nearest | null = null;
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
    const point = { x: a.x + dx * t, y: a.y + dy * t };
    const d = dist(point, p);
    if (!best || d < best.distance) best = { point, s: acc + Math.sqrt(len2) * t, distance: d, segment: i - 1 };
    acc += Math.sqrt(len2);
  }
  return best;
}

/** Point at distance s along a polyline; before the start or after the end it extends the first or last segment. */
export function pointAtDistance(pts: readonly Vec2[], s: number): { point: Vec2; bearingDeg: number } | null {
  if (pts.length < 2) return null;
  const first = pts[0] as Vec2;
  const second = pts[1] as Vec2;
  if (s <= 0) {
    const u = unitFromBearing(bearingDeg(first, second));
    return { point: { x: first.x + u.x * s, y: first.y + u.y * s }, bearingDeg: bearingDeg(first, second) };
  }
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1] as Vec2;
    const b = pts[i] as Vec2;
    const len = dist(a, b);
    if (acc + len >= s) {
      const t = len === 0 ? 0 : (s - acc) / len;
      return { point: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, bearingDeg: bearingDeg(a, b) };
    }
    acc += len;
  }
  const last = pts[pts.length - 1] as Vec2;
  const prev = pts[pts.length - 2] as Vec2;
  const br = bearingDeg(prev, last);
  const u = unitFromBearing(br);
  const over = s - acc;
  return { point: { x: last.x + u.x * over, y: last.y + u.y * over }, bearingDeg: br };
}

/** Parallel polyline, positive distance = to the right of travel. Joins are averaged normals (fine for drawing and for fake lane paths). */
export function offsetPolyline(pts: readonly Vec2[], d: number): Vec2[] {
  return pts.map((p, i) => {
    const prev = pts[i - 1] ?? p;
    const next = pts[i + 1] ?? p;
    const a = bearingDeg(prev, p === prev ? next : p);
    const b = bearingDeg(p, p === next ? prev : next);
    const ua = unitFromBearing(a);
    const ub = unitFromBearing(b);
    let nx = ua.x + ub.x;
    let ny = ua.y + ub.y;
    const n = Math.hypot(nx, ny);
    if (n < 1e-9) {
      nx = ua.x;
      ny = ua.y;
    } else {
      nx /= n;
      ny /= n;
    }
    // Right of travel = rotate the unit direction 90 degrees clockwise: (x, y) -> (y, -x).
    return { x: p.x + ny * d, y: p.y - nx * d };
  });
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export function rectsOverlap(a: Rect, b: Rect, pad = 0): boolean {
  return !(a.x + a.w + pad <= b.x || b.x + b.w + pad <= a.x || a.y + a.h + pad <= b.y || b.y + b.h + pad <= a.y);
}

/** Where two segments cross, or null. */
export function segmentIntersection(a: Vec2, b: Vec2, c: Vec2, d: Vec2): Vec2 | null {
  const r = { x: b.x - a.x, y: b.y - a.y };
  const s = { x: d.x - c.x, y: d.y - c.y };
  const den = r.x * s.y - r.y * s.x;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((c.x - a.x) * s.y - (c.y - a.y) * s.x) / den;
  const u = ((c.x - a.x) * r.y - (c.y - a.y) * r.x) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? { x: a.x + t * r.x, y: a.y + t * r.y } : null;
}

/** Every place two polylines cross (or, failing that, come within `tolerance` meters at a vertex). */
export function polylineCrossings(p: readonly Vec2[], q: readonly Vec2[], tolerance = 3): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 1; i < p.length; i++) for (let j = 1; j < q.length; j++) {
    const hit = segmentIntersection(p[i - 1] as Vec2, p[i] as Vec2, q[j - 1] as Vec2, q[j] as Vec2);
    if (hit && !out.some((o) => dist(o, hit) < tolerance)) out.push(hit);
  }
  if (out.length === 0) {
    for (const a of p) for (const b of q) if (dist(a, b) <= tolerance && !out.some((o) => dist(o, a) < tolerance)) out.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  }
  return out;
}
