// Cameras for the export stills. They are independent of the live view (its zoom, its time, its camera):
// each still is framed on its own subject, tight, with some context around it.
//   - impact: both vehicles at the moment of impact plus the impact ring, filling about 60% of the frame
//   - rest:   both vehicles at rest, the slide marks that lead there and the debris, filling about 62%
// The camera looks across the crash (square to its long axis) so a long crash reads wide on a wide frame.
import type { Pose, SimulationResult, TerrainGrid, Vec2 } from "@csd/core";
import { fitDistance, heightAt, type CameraSpec, type Viewport } from "./math";

/** Share of the frame the subject fills, along its limiting side. */
export const IMPACT_STILL_FILL = 0.6;
export const REST_STILL_FILL = 0.62;
/** Radius of the impact ring drawn in the scene, m (see ImpactRing in Viewer). */
const IMPACT_RING_M = 1.65;
/** Tallest part of a vehicle worth keeping in frame, m. */
export const SUBJECT_HEIGHT_M = 2.4;
/** Closest the camera may come, m: a bump in a parking lot is not a close-up of a bumper. */
const MIN_DISTANCE_M = 9;
/** Elevation of the still's camera: lower for the impact (the vehicles read larger), steeper for the aftermath (the marks read). */
const ELEVATION_DEG: Readonly<Record<"impact" | "rest", number>> = { impact: 38, rest: 48 };
/** The usual side to look from: south-south-east, as the Wide view does. */
const DEFAULT_AZIMUTH_RAD = (160 * Math.PI) / 180;
/** A subject this much longer than wide is viewed from the side. */
const ELONGATED_RATIO = 1.15;
const FOV_DEG = 45;

export type StillKind = "impact" | "rest";

/** The four corners of a vehicle's box at a pose. */
function corners(p: Pose, lengthM: number, widthM: number): Vec2[] {
  const fx = Math.sin(p.headingRad), fy = Math.cos(p.headingRad), rx = fy, ry = -fx;
  return ([[1, 1], [1, -1], [-1, 1], [-1, -1]] as const).map(([a, b]) => ({ x: p.xM + fx * a * (lengthM / 2) + rx * b * (widthM / 2), y: p.yM + fy * a * (lengthM / 2) + ry * b * (widthM / 2) }));
}

/** What a still is a picture OF, in ground plan: the points that must all be in frame. */
export function stillSubject(kind: StillKind, sim: SimulationResult, extraPoints: readonly Vec2[] = []): Vec2[] {
  const pts: Vec2[] = [];
  const c = sim.impactPointM;
  for (let i = 0; i < 8; i++) pts.push({ x: c.x + Math.cos((i * Math.PI) / 4) * IMPACT_RING_M, y: c.y + Math.sin((i * Math.PI) / 4) * IMPACT_RING_M });
  for (const v of sim.vehicles) {
    if (kind === "impact") { pts.push(...corners(v.impactPose, v.lengthM, v.widthM)); continue; }
    pts.push(...corners(v.restPose, v.lengthM, v.widthM));
    // The slide marks: the path from the impact to where it stopped.
    const iImpact = Math.round((0 - sim.startTimeS) / sim.dtS);
    const step = Math.max(1, Math.round(0.25 / sim.dtS));
    for (let i = Math.max(iImpact, 0); i < v.track.length; i += step) pts.push({ x: v.track[i]!.xM, y: v.track[i]!.yM });
  }
  if (kind === "rest") pts.push(...extraPoints);
  return pts;
}

/** Compass azimuth to look from: across the long axis of the subject, from the side nearest the usual one. */
export function stillAzimuth(subject: readonly Vec2[]): number {
  const n = subject.length;
  const mx = subject.reduce((a, p) => a + p.x, 0) / n, my = subject.reduce((a, p) => a + p.y, 0) / n;
  let cxx = 0, cyy = 0, cxy = 0;
  for (const p of subject) { cxx += (p.x - mx) ** 2; cyy += (p.y - my) ** 2; cxy += (p.x - mx) * (p.y - my); }
  const mid = (cxx + cyy) / 2, root = Math.sqrt(((cxx - cyy) / 2) ** 2 + cxy ** 2);
  const l1 = mid + root, l2 = Math.max(mid - root, 1e-6);
  if (Math.sqrt(l1 / l2) < ELONGATED_RATIO) return DEFAULT_AZIMUTH_RAD;
  const theta = 0.5 * Math.atan2(2 * cxy, cxx - cyy);                 // long axis, from east toward north
  // The camera stands on a perpendicular to it: compass azimuths of that line are (90° - theta) ± 90°.
  const base = Math.PI / 2 - theta;
  const options = [base + Math.PI / 2, base - Math.PI / 2];
  const away = (az: number) => Math.abs(Math.atan2(Math.sin(az - DEFAULT_AZIMUTH_RAD), Math.cos(az - DEFAULT_AZIMUTH_RAD)));
  return away(options[0]!) <= away(options[1]!) ? options[0]! : options[1]!;
}

type V3 = [number, number, number];

/**
 * Distance and target that put `points` at `fill` of the frame, centered: the target is moved until the
 * projected extent is centered (a few passes), because a point set that sits off to one side of the
 * target would otherwise hit the edge first and leave the frame emptier than asked.
 */
function fitCentered(points: readonly V3[], target0: V3, dir: V3, aspect: number, fill: number): { target: V3; d: number } {
  let target: V3 = [...target0];
  let d = 0;
  const th = Math.tan((FOV_DEG * Math.PI) / 360);
  // Camera basis for this direction: forward = -dir, right = forward x up, up = right x forward.
  const fwd: V3 = [-dir[0], -dir[1], -dir[2]];
  const rl = Math.hypot(fwd[2], fwd[0]) || 1;
  const right: V3 = [-fwd[2] / rl, 0, fwd[0] / rl];
  const up: V3 = [right[1] * fwd[2] - right[2] * fwd[1], right[2] * fwd[0] - right[0] * fwd[2], right[0] * fwd[1] - right[1] * fwd[0]];
  for (let pass = 0; pass < 4; pass++) {
    d = fitDistance(points, target, dir, FOV_DEG, aspect, fill);
    // Normalized screen position of every point from the camera at this distance; recenter on the middle of its extent.
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of points) {
      const rx = p[0] - target[0], ry = p[1] - target[1], rz = p[2] - target[2];
      const depth = d - (rx * dir[0] + ry * dir[1] + rz * dir[2]);
      const x = (rx * right[0] + ry * right[1] + rz * right[2]) / (depth * th * aspect), y = (rx * up[0] + ry * up[1] + rz * up[2]) / (depth * th);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    if (Math.abs(cx) < 0.005 && Math.abs(cy) < 0.005) break;
    const kx = cx * d * th * aspect, ky = cy * d * th;
    target = [target[0] + right[0] * kx + up[0] * ky, target[1] + right[1] * kx + up[1] * ky, target[2] + right[2] * kx + up[2] * ky];
  }
  return { target, d: Math.max(d, MIN_DISTANCE_M) };
}

/** The camera for an export still: tight on its subject, whatever the live view is doing. */
export function stillCamera(kind: StillKind, sim: SimulationResult, viewport: Viewport, terrain: TerrainGrid | null, extraPoints: readonly Vec2[] = []): CameraSpec {
  const subject = stillSubject(kind, sim, extraPoints);
  const xs = subject.map((p) => p.x), ys = subject.map((p) => p.y);
  const c: Vec2 = { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
  const ground = heightAt(terrain, c);
  const az = stillAzimuth(subject);
  const el = (ELEVATION_DEG[kind] * Math.PI) / 180;
  const dir: V3 = [Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)];
  const pts: V3[] = [];
  for (const p of subject) for (const hh of [0, SUBJECT_HEIGHT_M]) pts.push([p.x, ground + hh, -p.y]);
  const fill = kind === "impact" ? IMPACT_STILL_FILL : REST_STILL_FILL;
  const { target, d } = fitCentered(pts, [c.x, ground + SUBJECT_HEIGHT_M / 2, -c.y], dir, viewport.w / Math.max(viewport.h, 1), fill);
  return { kind: "perspective", position: [target[0] + dir[0] * d, target[1] + dir[1] * d, target[2] + dir[2] * d], target, fovDeg: FOV_DEG, zoom: 1 };
}
