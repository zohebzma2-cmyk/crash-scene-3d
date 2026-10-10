// Tire marks. Pure geometry: from each vehicle's track poses, its size and heading, build one ribbon per
// wheel (four for a car, SUV, pickup, van or truck; two for a motorcycle, front and rear on the centerline).
// The ribbons follow the WHEEL positions, so when the vehicle yaws after an off-center hit the marks curve.
//
//  - Post-impact: from the impact to final rest, wherever the vehicle moves (dark).
//  - Pre-impact braking: only for vehicles marked as braking, over the last BRAKING_S before impact (lighter).
//  - Marks only appear on drivable surfaces (roads, parking lots) and never inside a building. If the
//    vehicle isn't on a mapped drivable surface at all (no road data there), the road test is skipped so
//    the marks still show; the building test always applies.
//  - Each ribbon is a triangle strip whose index list is ordered by time, so showing "up to time t" is a
//    draw range: marks grow as the vehicle moves and stay once it has stopped.
import { BRAKING_S, type Pose, type RoadNetwork, type SimulationResult, type TerrainGrid, type Vec2, type VehicleResult } from "@csd/core";
import { heightAt, roadWidthM } from "../math";

/** Width of a tire mark, m. */
export const MARK_WIDTH_M = 0.2;
/** Lift above the ground, m (above the road at 0.04 and its paint at 0.07). */
export const MARK_LIFT_M = 0.085;
/** Keep one track sample in this many (the track is 120 Hz). */
export const SAMPLE_STRIDE = 3;
/** Below this speed (m/s) a vehicle isn't leaving a mark. */
export const MIN_MARK_SPEED_MPS = 0.15;

export type SkidKind = "slide" | "brake";

export interface WheelOffset { readonly a: number; readonly b: number }   // a: along the front, b: toward the right (m)

/** Wheel centers in the vehicle frame: inside the footprint, so a mark never sits outside the body's own box. */
export function wheelOffsets(type: string, lengthM: number, widthM: number): WheelOffset[] {
  const a = 0.3 * lengthM;
  if (type === "motorcycle") return [{ a, b: 0 }, { a: -a, b: 0 }];
  const b = 0.5 * widthM - 0.18;
  return [{ a, b: -b }, { a, b }, { a: -a, b: -b }, { a: -a, b }];
}

/** World position of a wheel for a pose. */
export function wheelAt(p: Pose, w: WheelOffset): Vec2 {
  const s = Math.sin(p.headingRad), c = Math.cos(p.headingRad);
  return { x: p.xM + w.a * s + w.b * c, y: p.yM + w.a * c - w.b * s };
}

// ---------------------------------------------------------------- where marks may be drawn

function inPolygon(p: Vec2, poly: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!, b = poly[j]!;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export interface Surfaces {
  readonly drivable: (p: Vec2) => boolean;
  readonly building: (p: Vec2) => boolean;
  /** True when the network has any drivable surface at all. */
  readonly hasDrivable: boolean;
}

/** Surface tests over a road network (null network: everything is allowed). */
export function makeSurfaces(roads: RoadNetwork | null): Surfaces {
  if (!roads) return { drivable: () => true, building: () => false, hasDrivable: false };
  const ways = roads.ways.map((w) => {
    const half = roadWidthM(w) / 2 + 0.2;
    const xs = w.centerline.map((p) => p.x), ys = w.centerline.map((p) => p.y);
    return { w, half, minX: Math.min(...xs) - half, maxX: Math.max(...xs) + half, minY: Math.min(...ys) - half, maxY: Math.max(...ys) + half };
  });
  const lots = roads.parking.map((l) => l.outline);
  const blds = roads.buildings.map((b) => ({
    f: b.footprint, minX: Math.min(...b.footprint.map((p) => p.x)), maxX: Math.max(...b.footprint.map((p) => p.x)),
    minY: Math.min(...b.footprint.map((p) => p.y)), maxY: Math.max(...b.footprint.map((p) => p.y)),
  }));
  return {
    hasDrivable: ways.length + lots.length > 0,
    drivable: (p) => {
      for (const r of ways) {
        if (p.x < r.minX || p.x > r.maxX || p.y < r.minY || p.y > r.maxY) continue;
        const c = r.w.centerline;
        for (let i = 1; i < c.length; i++) if (distToSegment(p, c[i - 1]!, c[i]!) <= r.half) return true;
      }
      return lots.some((l) => inPolygon(p, l));
    },
    building: (p) => blds.some((b) => p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY && inPolygon(p, b.f)),
  };
}

// ---------------------------------------------------------------- the ribbons

export interface SkidRibbon {
  readonly vehicleId: string;
  readonly kind: SkidKind;
  /** xyz per vertex (three.js axes), two vertices per sample per wheel. */
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
  /** Sim time of each segment's far end, ascending; segment k is drawn once t >= segEndS[k]. */
  readonly segEndS: Float32Array;
  /** Number of indices to draw once segment k (0-based) is complete: cumIndex[k]. */
  readonly cumIndex: Uint32Array;
  /** The wheel tracks as plan polylines (marked samples only), for tests and framing. */
  readonly tracks: ReadonlyArray<readonly Vec2[]>;
}

export interface SkidInput {
  readonly sim: SimulationResult;
  readonly roads: RoadNetwork | null;
  readonly terrain: TerrainGrid | null;
  /** Vehicle ids marked as braking and not parked. */
  readonly braking: ReadonlySet<string>;
  readonly surfaces?: Surfaces;
}

function ribbonFor(v: VehicleResult, kind: SkidKind, i0: number, i1: number, input: SkidInput, surf: Surfaces, onRoad: boolean): SkidRibbon | null {
  const { sim, terrain } = input;
  const wheels = wheelOffsets(v.type, v.lengthM, v.widthM);
  const idx: number[] = [];
  for (let i = i0; i <= i1; i += SAMPLE_STRIDE) idx.push(i);
  if (idx[idx.length - 1] !== i1) idx.push(i1);
  const samples = idx.map((i) => v.track[i]!);
  const n = samples.length;
  if (n < 2) return null;
  const ok = (p: Pose, w: WheelOffset): boolean => {
    if (p.speedMps < MIN_MARK_SPEED_MPS) return false;
    const q = wheelAt(p, w);
    return !surf.building(q) && (!onRoad || surf.drivable(q));
  };
  const pos = new Float32Array(n * wheels.length * 6);
  const half = MARK_WIDTH_M / 2;
  const tracks: Vec2[][] = wheels.map(() => []);
  wheels.forEach((w, wi) => {
    const pts = samples.map((p) => wheelAt(p, w));
    for (let k = 0; k < n; k++) {
      const a = pts[Math.max(0, k - 1)]!, b = pts[Math.min(n - 1, k + 1)]!;
      let dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if (len < 1e-6) { const h = samples[k]!.headingRad; dx = Math.sin(h); dy = Math.cos(h); } else { dx /= len; dy /= len; }
      const nx = dy * half, ny = -dx * half;
      const p = pts[k]!, g = heightAt(terrain, p) + MARK_LIFT_M;
      const o = (wi * n + k) * 6;
      pos[o] = p.x - nx; pos[o + 1] = g; pos[o + 2] = -(p.y - ny);
      pos[o + 3] = p.x + nx; pos[o + 4] = g; pos[o + 5] = -(p.y + ny);
    }
  });
  const indices: number[] = [], segEnd: number[] = [], cum: number[] = [];
  for (let k = 0; k + 1 < n; k++) {
    const t1 = sim.startTimeS + idx[k + 1]! * sim.dtS;
    wheels.forEach((w, wi) => {
      if (ok(samples[k]!, w) && ok(samples[k + 1]!, w)) {
        const a = (wi * n + k) * 2, b = (wi * n + k + 1) * 2;
        indices.push(a, a + 1, b, a + 1, b + 1, b);
        if (!tracks[wi]!.length) tracks[wi]!.push(wheelAt(samples[k]!, w));
        tracks[wi]!.push(wheelAt(samples[k + 1]!, w));
      }
    });
    segEnd.push(t1);
    cum.push(indices.length);
  }
  if (!indices.length) return null;
  return {
    vehicleId: v.id, kind, positions: pos, indices: Uint32Array.from(indices),
    segEndS: Float32Array.from(segEnd), cumIndex: Uint32Array.from(cum), tracks,
  };
}

/** Every vehicle's ribbons: post-impact slide marks, and pre-impact braking marks for braking vehicles. */
export function buildSkids(input: SkidInput): SkidRibbon[] {
  const { sim } = input;
  const surf = input.surfaces ?? makeSurfaces(input.roads);
  const iImpact = Math.round((0 - sim.startTimeS) / sim.dtS);
  const out: SkidRibbon[] = [];
  for (const v of sim.vehicles) {
    const last = v.track.length - 1;
    if (last <= iImpact) continue;
    const onRoad = surf.hasDrivable && surf.drivable({ x: v.impactPose.xM, y: v.impactPose.yM });
    if (v.postImpactDistanceM.mid > 0.3) {
      const r = ribbonFor(v, "slide", iImpact, last, input, surf, onRoad);
      if (r) out.push(r);
    }
    if (input.braking.has(v.id)) {
      const from = Math.max(0, iImpact - Math.round(BRAKING_S / sim.dtS));
      const r = ribbonFor(v, "brake", from, iImpact, input, surf, onRoad);
      if (r) out.push(r);
    }
  }
  return out;
}

/** Number of indices of a ribbon to draw at sim time t (a draw-range count, always a multiple of 3). */
export function drawCountAt(r: SkidRibbon, t: number): number {
  const s = r.segEndS;
  if (!s.length || t < s[0]!) return 0;
  let lo = 0, hi = s.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (s[mid]! <= t) lo = mid; else hi = mid - 1; }
  return r.cumIndex[lo]!;
}
