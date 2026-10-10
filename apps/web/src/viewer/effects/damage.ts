// Dents. An illustration of where a vehicle was hit and roughly how hard, not a crush analysis.
//
// Depth curve (documented, one place): the hit's delta-v for THIS vehicle (|v after - v before|, from the
// physics) maps to a severity 0..1, and the dent is DENT_MAX_M x severity deep:
//   below 3 mph          severity 0 (no dent)
//   3 mph .. 40 mph      severity = ((mph - 3) / 37) ^ 0.75  (concave: even a modest hit creases the panel)
//   40 mph and over      severity 1 (about 0.35 m deep)
//
// Shape: smooth, never shredded. The panel in the hit zone is pushed straight inward (toward the vehicle's
// center, diagonally for the corner zones). The push fades smoothly with distance along the face, with
// depth into the body (a crush reach of about 0.9 m, so the windshield stays put when the nose goes in) and
// with height (the roof barely moves). Vertices only ever move inward and are clamped to the original
// lengthM x widthM footprint, so a dented vehicle never pokes outside the box the physics treated it as.
//
// Frame: the vehicle models face -z, are centered in plan, x is the vehicle's right.
import { Float32BufferAttribute, type BufferGeometry, type Object3D, type Mesh } from "three";
import { MPH_TO_MPS, type Scene, type SimulationResult, type Zone } from "@csd/core";
import { getImpactInfo } from "./impact-info";

export const DENT_MIN_MPH = 3;
export const DENT_FULL_MPH = 40;
/** Depth at severity 1, m. */
export const DENT_MAX_M = 0.35;
/** How far into the body a dent reaches, m (capped to a third of the length for short vehicles). */
export const CRUSH_REACH_M = 0.9;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Severity 0..1 from a delta-v in m/s. The documented curve above. */
export function severityFromDeltaV(deltaVMps: number): number {
  const mph = deltaVMps / MPH_TO_MPS;
  if (!(mph > DENT_MIN_MPH)) return 0;
  return clamp01((mph - DENT_MIN_MPH) / (DENT_FULL_MPH - DENT_MIN_MPH)) ** 0.75;
}

/** Dent depth in meters for a severity. */
export function dentDepthM(severity: number): number {
  return DENT_MAX_M * clamp01(severity);
}

interface Frame {
  /** Where on the footprint the zone sits (plan, x right / z back). */
  readonly cx: number; readonly cz: number;
  /** Unit push direction in plan (inward). */
  readonly nx: number; readonly nz: number;
  readonly corner: boolean;
  /** Reach along the face, and into the body, m. */
  readonly reachAlong: number; readonly reachIn: number;
}

export interface Box3 { readonly minX: number; readonly maxX: number; readonly minY: number; readonly maxY: number; readonly minZ: number; readonly maxZ: number }

const SQ = Math.SQRT1_2;
function frameOf(zone: Zone, b: Box3): Frame {
  const L = b.maxZ - b.minZ, W = b.maxX - b.minX;
  const mx = (b.minX + b.maxX) / 2, mz = (b.minZ + b.maxZ) / 2;
  const reachIn = Math.min(CRUSH_REACH_M, L * 0.3);
  const corner = 0.3 * L;
  switch (zone) {
    case "front": return { cx: mx, cz: b.minZ, nx: 0, nz: 1, corner: false, reachAlong: 0.75 * W, reachIn };
    case "rear": return { cx: mx, cz: b.maxZ, nx: 0, nz: -1, corner: false, reachAlong: 0.75 * W, reachIn };
    case "left": return { cx: b.minX, cz: mz, nx: 1, nz: 0, corner: false, reachAlong: 0.3 * L, reachIn: Math.min(reachIn, W * 0.45) };
    case "right": return { cx: b.maxX, cz: mz, nx: -1, nz: 0, corner: false, reachAlong: 0.3 * L, reachIn: Math.min(reachIn, W * 0.45) };
    case "front-left": return { cx: b.minX, cz: b.minZ, nx: SQ, nz: SQ, corner: true, reachAlong: corner, reachIn: corner };
    case "front-right": return { cx: b.maxX, cz: b.minZ, nx: -SQ, nz: SQ, corner: true, reachAlong: corner, reachIn: corner };
    case "rear-left": return { cx: b.minX, cz: b.maxZ, nx: SQ, nz: -SQ, corner: true, reachAlong: corner, reachIn: corner };
    case "rear-right": return { cx: b.maxX, cz: b.maxZ, nx: -SQ, nz: -SQ, corner: true, reachAlong: corner, reachIn: corner };
  }
}

/** Smooth bump, 1 at r = 0, 0 (with zero slope) at r >= 1. */
const bump = (r: number): number => { if (r >= 1) return 0; const s = 1 - r * r; return s * s; };

/** Dent weight 0..1 at a point; the push is depth x this. */
function weightAt(f: Frame, b: Box3, x: number, y: number, z: number): number {
  const dx = x - f.cx, dz = z - f.cz;
  let w: number;
  if (f.corner) {
    w = bump(Math.hypot(dx, dz) / f.reachAlong);
  } else {
    const along = Math.abs(dx * f.nz - dz * f.nx);             // distance along the face
    const into = Math.max(0, dx * f.nx + dz * f.nz);           // depth into the body
    w = bump(along / f.reachAlong) * bump(into / f.reachIn);
  }
  if (w === 0) return 0;
  const H = Math.max(b.maxY, 1e-6);
  const u = clamp01((y - 0.65 * H) / (0.35 * H));
  return w * (1 - 0.75 * u * u * (3 - 2 * u));                 // the roof barely moves
}

function boundsOf(g: BufferGeometry): Box3 {
  g.computeBoundingBox();
  const bb = g.boundingBox!;
  return { minX: bb.min.x, maxX: bb.max.x, minY: bb.min.y, maxY: bb.max.y, minZ: bb.min.z, maxZ: bb.max.z };
}

/**
 * A dented copy of `geometry`: the zone's panel pushed inward by up to dentDepthM(severity), smooth falloff,
 * clamped to the original footprint. The input is not modified. `bounds` (the intact vehicle's box) can be
 * passed when the geometry is only one part of the vehicle, so every part dents against the same footprint.
 */
export function dentGeometry(geometry: BufferGeometry, zone: Zone, severity: number, bounds?: Box3): BufferGeometry {
  const out = geometry.clone();
  const depth = dentDepthM(severity);
  const pos = out.getAttribute("position");
  if (depth <= 0 || !pos) return out;
  const b = bounds ?? boundsOf(geometry);
  const f = frameOf(zone, b);
  const nor = out.getAttribute("normal");
  const e = 0.02;                                             // step for the weight gradient (normals)
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const w = weightAt(f, b, x, y, z);
    if (w === 0) continue;
    const push = depth * w;
    if (nor) {
      // Normal of the displaced surface: n' = n - depth * (dir . n) * grad(w)  (first order).
      const gx = (weightAt(f, b, x + e, y, z) - weightAt(f, b, x - e, y, z)) / (2 * e);
      const gy = (weightAt(f, b, x, y + e, z) - weightAt(f, b, x, y - e, z)) / (2 * e);
      const gz = (weightAt(f, b, x, y, z + e) - weightAt(f, b, x, y, z - e)) / (2 * e);
      const nx = nor.getX(i), ny = nor.getY(i), nz = nor.getZ(i);
      const dn = f.nx * nx + f.nz * nz;
      const px = nx - depth * dn * gx, py = ny - depth * dn * gy, pz = nz - depth * dn * gz;
      const len = Math.hypot(px, py, pz) || 1;
      nor.setXYZ(i, px / len, py / len, pz / len);
    }
    pos.setX(i, Math.min(b.maxX, Math.max(b.minX, x + f.nx * push)));
    pos.setZ(i, Math.min(b.maxZ, Math.max(b.minZ, z + f.nz * push)));
  }
  pos.needsUpdate = true;
  if (nor) nor.needsUpdate = true;
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}

export interface DentSpec { readonly zone: Zone; readonly severity: number }

/** Dent a geometry with several zones in turn (each against the original footprint). */
export function dentGeometryMulti(geometry: BufferGeometry, specs: readonly DentSpec[], bounds?: Box3): BufferGeometry {
  const b = bounds ?? boundsOf(geometry);
  let cur: BufferGeometry | null = null;
  for (const s of specs) {
    if (s.severity <= 0) continue;
    const next = dentGeometry(cur ?? geometry, s.zone, s.severity, b);
    cur?.dispose();
    cur = next;
  }
  return cur ?? geometry.clone();
}

/** Parts that stay as they are when a vehicle is dented (tires are bolted to the chassis, not to the panel). */
const UNDENTED = new Set(["tire"]);

/**
 * Dent every panel of a vehicle model (a record of merged geometries by slot, as vehicle-models.ts builds
 * them), all against the body's footprint. Returns NEW geometry for the dented slots (the caller owns and
 * disposes them) and the input geometry itself for the slots that don't dent.
 */
export function dentParts<P extends { readonly [K in keyof P]: BufferGeometry }>(parts: P, specs: readonly DentSpec[]): P {
  const live = specs.filter((s) => s.severity > 0);
  const out: Record<string, BufferGeometry> = {};
  const bounds = boundsOf((parts as Record<string, BufferGeometry>)["body"] ?? Object.values<BufferGeometry>(parts)[0]!);
  for (const [slot, g] of (Object.entries(parts) as Array<[string, BufferGeometry]>)) out[slot] = live.length && !UNDENTED.has(slot) ? dentGeometryMulti(g, live, bounds) : g;
  return out as P;
}

// ---------------------------------------------------------------- growing the dent

/** The dent grows over this long after the impact, s (sim time), so the crunch is seen, then it stays. */
export const DENT_GROW_S = 0.12;

/** 0 before the impact, easing to 1 over DENT_GROW_S, and 1 for good. `settled`: no growing (reduced motion). */
export function dentProgress(t: number, settled = false): number {
  if (t < 0) return 0;
  if (settled || t >= DENT_GROW_S) return 1;
  const k = t / DENT_GROW_S;
  return k * k * (3 - 2 * k);
}

/**
 * Like dentParts, but each dented panel is a copy of the INTACT geometry carrying the dent as a morph target
 * (relative). Drawn with morphTargetInfluences = [dentProgress(t)] it is intact at 0, fully dented at 1, and
 * the viewer can show any time (scrubbing, stills) without swapping geometry. Tires come back as they are.
 */
export function morphParts<P extends { readonly [K in keyof P]: BufferGeometry }>(parts: P, specs: readonly DentSpec[]): P {
  const dented = dentParts(parts, specs);
  const out: Record<string, BufferGeometry> = {};
  for (const [slot, g] of (Object.entries(parts) as Array<[string, BufferGeometry]>)) {
    const d = (dented as Record<string, BufferGeometry>)[slot]!;
    if (d === g) { out[slot] = g; continue; }
    const base = g.clone();
    const delta = (name: "position" | "normal"): Float32BufferAttribute => {
      const a = g.getAttribute(name), b = d.getAttribute(name);
      const arr = new Float32Array(a.count * 3);
      for (let i = 0; i < a.count; i++) { arr[i * 3] = b.getX(i) - a.getX(i); arr[i * 3 + 1] = b.getY(i) - a.getY(i); arr[i * 3 + 2] = b.getZ(i) - a.getZ(i); }
      return new Float32BufferAttribute(arr, 3);
    };
    base.morphAttributes["position"] = [delta("position")];
    if (g.getAttribute("normal")) base.morphAttributes["normal"] = [delta("normal")];
    base.morphTargetsRelative = true;
    d.dispose();
    out[slot] = base;
  }
  return out as P;
}

/** Set the dent on every morph-carrying mesh under a vehicle group. No allocation after the first call per mesh. */
export function applyDentProgress(group: Object3D, k: number): void {
  const kids = group.children;
  for (let i = 0; i < kids.length; i++) {
    const m = kids[i] as Mesh;
    if (!m.isMesh || !m.geometry.morphAttributes["position"]?.length) continue;
    if (!m.morphTargetInfluences) m.morphTargetInfluences = [0];
    m.morphTargetInfluences[0] = k;
  }
}

// ---------------------------------------------------------------- which zones to dent

/** The second dent (the face that actually touched, when it isn't the one entered) is a little shallower. */
export const LEADING_ZONE_SHARE = 0.85;

/**
 * The dents for every vehicle in a simulation, from the physics' own impact numbers.
 *  - The zone the claimant entered as hit is always dented (the request: "the zone that was entered as hit").
 *  - The zone of the vehicle's own body that actually touched (nearest to the contact point) is dented too
 *    when it differs. That is how the STRIKING vehicle gets its leading face: in a T-bone the striker's
 *    entered zone is usually already its front; when it isn't, the contact point decides, so the picture
 *    shows the face that met the other vehicle.
 *  - Depth comes from this vehicle's own delta-v through severityFromDeltaV. A vehicle with no real velocity
 *    change (a parked car that was never touched) gets nothing.
 */
export function planDents(sim: SimulationResult, scene?: Scene): Map<string, DentSpec[]> {
  const out = new Map<string, DentSpec[]>();
  for (const v of sim.vehicles) {
    const info = getImpactInfo(sim, v, scene);
    const severity = severityFromDeltaV(info.deltaVMps);
    if (severity <= 0) continue;
    const specs: DentSpec[] = [];
    const entered = info.zoneHit;
    if (entered) specs.push({ zone: entered, severity });
    if (!entered || entered !== info.leadingZone) specs.push({ zone: info.leadingZone, severity: entered ? severity * LEADING_ZONE_SHARE : severity });
    out.set(v.id, specs);
  }
  return out;
}
