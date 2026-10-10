// Screen-space helpers shared by the live label layer and the still-image capture: where a vehicle's
// box lands on screen, and what its label says.
import { Vector3, type Camera } from "three";
import { formatSpeed, type Pose, type SceneVehicle, type Units } from "@csd/core";
import { headingToYaw, toThree, type Rect } from "./math";
import { roleName } from "../lib/text";

/** Label anchor sits this far above the roof, meters. */
const ANCHOR_LIFT_M = 0.15;
/** Below this speed a vehicle reads as stopped, m/s (about 1 mph). */
const STOPPED_MPS = 0.45;

export interface VehicleDims { readonly lengthM: number; readonly widthM: number; readonly heightM: number }
export interface ProjectedVehicle {
  /** The projected top of the vehicle: where its label attaches. */
  readonly anchor: { readonly x: number; readonly y: number };
  /** The projected screen rect of the vehicle's box. */
  readonly rect: Rect;
  /**
   * The same box as a stack of thin rectangles that follow its outline (the convex hull of its projected corners),
   * for labels to keep off: much tighter than `rect` for a vehicle seen at an angle.
   */
  readonly strips: readonly Rect[];
  /** False when any corner is behind the camera (the rect can't be trusted). */
  readonly valid: boolean;
}

/** How many bands the hull is cut into. */
const STRIPS = 8;

function hull(points: ReadonlyArray<readonly [number, number]>): Array<[number, number]> {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]) as Array<[number, number]>;
  const cross = (o: readonly [number, number], a: readonly [number, number], b: readonly [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (list: Array<[number, number]>) => {
    const h: Array<[number, number]> = [];
    for (const p of list) { while (h.length >= 2 && cross(h[h.length - 2]!, h[h.length - 1]!, p) <= 0) h.pop(); h.push(p); }
    h.pop();
    return h;
  };
  return [...half(pts), ...half([...pts].reverse())];
}

/** Horizontal extent of a convex polygon between two heights (its widest point in that band). */
function stripsOf(poly: ReadonlyArray<readonly [number, number]>, minY: number, maxY: number): Rect[] {
  const out: Rect[] = [];
  const n = poly.length;
  const xAt = (y: number): [number, number] => {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) {
      const a = poly[i]!, b = poly[(i + 1) % n]!;
      if ((a[1] - y) * (b[1] - y) > 0) continue;                       // the edge doesn't reach this height
      const t = a[1] === b[1] ? 0 : (y - a[1]) / (b[1] - a[1]);
      const x = a[0] + (b[0] - a[0]) * t;
      lo = Math.min(lo, x, a[1] === b[1] ? b[0] : x); hi = Math.max(hi, x, a[1] === b[1] ? b[0] : x);
    }
    return [lo, hi];
  };
  const step = (maxY - minY) / STRIPS;
  for (let i = 0; i < STRIPS; i++) {
    const y0 = minY + i * step, y1 = y0 + step;
    let lo = Infinity, hi = -Infinity;
    for (const y of [y0, y1]) { const [a, b] = xAt(y); lo = Math.min(lo, a); hi = Math.max(hi, b); }
    for (const p of poly) if (p[1] >= y0 && p[1] <= y1) { lo = Math.min(lo, p[0]); hi = Math.max(hi, p[0]); }
    if (hi > lo) out.push({ x: lo, y: y0, w: hi - lo, h: step });
  }
  return out;
}

const v3 = new Vector3();

/** The vehicle's oriented box, projected through `camera` into a viewport of `size` px. */
export function projectVehicle(camera: Camera, size: { w: number; h: number }, pose: Pick<Pose, "xM" | "yM" | "headingRad">, dims: VehicleDims, groundM: number): ProjectedVehicle {
  const yaw = headingToYaw(pose.headingRad), c = Math.cos(yaw), s = Math.sin(yaw);
  const [cx, cy, cz] = toThree({ x: pose.xM, y: pose.yM }, groundM);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, valid = true;
  const corners: Array<[number, number]> = [];
  const place = (lx: number, ly: number, lz: number) => {
    v3.set(cx + lx * c + lz * s, cy + ly, cz - lx * s + lz * c).project(camera);
    if (v3.z > 1) valid = false;
    const sx = ((v3.x + 1) / 2) * size.w, sy = ((1 - v3.y) / 2) * size.h;
    return [sx, sy] as const;
  };
  for (const ly of [0, dims.heightM]) for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const [px, py] = place((sx * dims.widthM) / 2, ly, (sz * dims.lengthM) / 2);
    minX = Math.min(minX, px); maxX = Math.max(maxX, px); minY = Math.min(minY, py); maxY = Math.max(maxY, py);
    corners.push([px, py]);
  }
  const [ax, ay] = place(0, dims.heightM + ANCHOR_LIFT_M, 0);
  return { anchor: { x: ax, y: ay }, rect: { x: minX, y: minY, w: maxX - minX, h: maxY - minY }, strips: valid ? stripsOf(hull(corners), minY, maxY) : [], valid };
}

/** Name and speed for a vehicle's label at the moment `pose` describes. */
export function vehicleLabel(sv: SceneVehicle | undefined, id: string, pose: Pose, timeS: number, units: Units): { name: string; speed: string; text: string } {
  const name = sv ? roleName(sv) : id === "A" ? "Your car" : `Vehicle ${id}`;
  let speed: string;
  if (pose.speedMps < STOPPED_MPS) speed = sv?.action === "parked" && timeS <= 0 ? "Parked" : "Stopped";
  else speed = `${sv?.speed.kind === "unsure" ? "~" : ""}${formatSpeed(pose.speedMps, { units }).text}`;
  return { name, speed, text: `${name} ${speed}` };
}
