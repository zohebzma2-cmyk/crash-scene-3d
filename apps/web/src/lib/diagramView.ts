// Framing for the top-down diagram. World units are meters (x east, y north); SVG y is flipped.
import type { Pose, SimulationResult, VehicleResult } from "@csd/core";

export interface Bounds { minX: number; maxX: number; minY: number; maxY: number }
export interface ViewBox { x: number; y: number; w: number; h: number }
export type FrameMode = "near" | "wide";
export type PoseFn = (sim: SimulationResult, v: VehicleResult, tS: number) => Pose;

/** Impact and rest, plus the last moments before impact ("near") or the whole approach ("wide"). */
export function sceneBounds(sim: SimulationResult, poseAt: PoseFn, mode: FrameMode): Bounds {
  const pts: Array<[number, number]> = [];
  for (const v of sim.vehicles) {
    const r = Math.max(v.lengthM, v.widthM) / 2 + 1;
    const before = mode === "wide" ? sim.startTimeS : -0.6;
    for (const p of [v.impactPose, v.restPose, poseAt(sim, v, Math.max(before, sim.startTimeS))]) {
      pts.push([p.xM - r, p.yM - r], [p.xM + r, p.yM + r]);
    }
  }
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

/** A viewBox that fits the bounds into the given aspect (w/h), with padding and a minimum span. */
export function fitViewBox(b: Bounds, aspect: number, pad = 4, minSpan = 18): ViewBox {
  let w = Math.max(b.maxX - b.minX + pad * 2, minSpan);
  let h = Math.max(b.maxY - b.minY + pad * 2, minSpan / aspect);
  if (w / h > aspect) h = w / aspect;
  else w = h * aspect;
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  return { x: cx - w / 2, y: -(cy + h / 2), w, h };
}

/** World meters to pixels inside a box of the given size that shows the viewBox exactly. */
export function worldToPx(vb: ViewBox, size: { w: number; h: number }, x: number, y: number): { x: number; y: number } {
  return { x: ((x - vb.x) / vb.w) * size.w, y: ((-y - vb.y) / vb.h) * size.h };
}

/** Pixels per meter for that box. */
export const pxPerMeter = (vb: ViewBox, size: { w: number; h: number }): number => size.w / vb.w;

/** Pixels in a box that shows the viewBox exactly, back to world meters. */
export function pxToWorld(vb: ViewBox, size: { w: number; h: number }, px: number, py: number): { x: number; y: number } {
  return { x: vb.x + (px / size.w) * vb.w, y: -(vb.y + (py / size.h) * vb.h) };
}
