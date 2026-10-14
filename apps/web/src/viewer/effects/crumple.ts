// Crumple on the catalog 3D models. Like the dents (damage.ts), an illustration of where a vehicle was hit and
// roughly how hard, not a crush analysis.
//
// Our own low-poly model is dented by damage.ts. A catalog model (a GLB fitted to the footprint, catalog-models.ts)
// is drawn instead of it once it arrives, so it gets the same treatment here, placed from the physics' own impact
// data (ImpactData, read through impact-info.ts):
//  - Where: on the face of the zone that was hit, centred where the vehicles touched (the contact point, the centre
//    of the contact patch). The zone the claimant entered is always crumpled; the face that actually touched is
//    crumpled too when it differs (a little shallower), the same pair of zones as planDents.
//  - Which way: the direction the hit pushed this vehicle (ImpactData.normal) when it goes into that face (within
//    60 degrees of straight in), else straight in from the face.
//  - How deep: the dents' curve (damage.ts severityFromDeltaV and dentDepthM): nothing under 3 mph of delta-v,
//    then deeper with delta-v, capped at DENT_MAX_M (about 0.35 m) from 40 mph.
//  - How far: a smooth bump, full at the contact and gone at the reach, along the face, into the body (at most
//    CRUSH_REACH_M, so the windshield stays put when the nose goes in) and toward the roof (which barely moves).
//  - What it looks like: crumpled, not a soft bowl. Inside that bump the panel is folded: creases across the face
//    (every FOLD_ALONG_M) and along it (every FOLD_UP_M) are pushed in less than the contact, by up to FOLD of the
//    depth, so the facets of the panel catch the light differently. Deterministic, never deeper than the bump.
// Vertices only move inward and never leave the model's own drawn box, so two vehicles that touch in the physics
// never overlap on screen.
//
// Never on the catalog model itself: the crumple goes on a per-vehicle copy of the model whose meshes carry COPIES
// of the geometry with the crumple as a morph target (intact at 0, crumpled at 1). ImpactEffects grows it at the
// impact like the dents (applyDentProgress), so scrubbing back undoes it and every still shows the right state.
//
// Frame: the vehicle's own, as the models are drawn: faces -z, x is the vehicle's right, y up, centred in plan.
import { Float32BufferAttribute, Matrix3, Vector3, type BufferGeometry, type Matrix4, type Mesh, type Object3D } from "three";
import type { Pose, Scene, SimulationResult, Vec2, Zone } from "@csd/core";
import { CRUSH_REACH_M, LEADING_ZONE_SHARE, dentDepthM, markDentMorph, severityFromDeltaV, type Box3 } from "./damage";
import { getImpactInfo, zoneDistance } from "./impact-info";

/** A point or a direction on the ground plan, in a vehicle's own frame (x to its right, z to its back), m. */
export interface PlanXZ { readonly x: number; readonly z: number }

/** One crumple on one vehicle. */
export interface CrumpleSpec {
  /** The zone (face or corner) of the body that is pushed in. */
  readonly zone: Zone;
  /** 0..1, from this vehicle's delta-v (severityFromDeltaV). */
  readonly severity: number;
  /** Where the vehicles touched, vehicle frame; absent = the middle of the zone's face (or its corner). */
  readonly contact?: PlanXZ | null;
  /** The direction the hit pushed this vehicle, vehicle frame (any length); absent = straight in from the face. */
  readonly push?: PlanXZ | null;
}

/** A world point (local ENU, m) in the frame of a vehicle standing at `pose`. */
export function toVehicleFrame(pose: Pose, p: Vec2): PlanXZ {
  return dirToVehicleFrame(pose, { x: p.x - pose.xM, y: p.y - pose.yM });
}

/** A world direction (local ENU) in the frame of a vehicle heading `pose.headingRad` (compass, clockwise from north). */
export function dirToVehicleFrame(pose: Pose, d: Vec2): PlanXZ {
  const s = Math.sin(pose.headingRad), c = Math.cos(pose.headingRad);
  const forward = d.x * s + d.y * c, right = d.x * c - d.y * s;
  return { x: right, z: -forward };
}

/**
 * The crumples for every vehicle in a simulation, from the physics' own impact numbers: the same zones and depths as
 * planDents (the entered zone at full depth, the face that touched at LEADING_ZONE_SHARE when it differs, nothing for
 * a vehicle under 3 mph of delta-v), each centred on the contact point when the contact is on or next to that zone,
 * and pushed the way the hit pushed the vehicle.
 */
export function planCrumples(sim: SimulationResult, scene?: Scene): Map<string, CrumpleSpec[]> {
  const out = new Map<string, CrumpleSpec[]>();
  for (const v of sim.vehicles) {
    const info = getImpactInfo(sim, v, scene);
    const severity = severityFromDeltaV(info.deltaVMps);
    if (severity <= 0) continue;
    const contact = toVehicleFrame(v.impactPose, info.contactPointM);
    const push = v.impact ? dirToVehicleFrame(v.impactPose, v.impact.normal) : null;
    const spec = (zone: Zone, s: number): CrumpleSpec => ({ zone, severity: s, contact: zoneDistance(zone, info.leadingZone) <= 1 ? contact : null, push });
    const specs: CrumpleSpec[] = [];
    const entered = info.zoneHit;
    if (entered) specs.push(spec(entered, severity));
    if (!entered || entered !== info.leadingZone) specs.push(spec(info.leadingZone, entered ? severity * LEADING_ZONE_SHARE : severity));
    out.set(v.id, specs);
  }
  return out;
}

// ---------------------------------------------------------------- the displacement

/** A crumple placed on a box: everything the per-vertex step needs. */
export interface CrumpleFrame {
  /** The centre of the crumple, on the zone's face (or near its corner). */
  readonly cx: number; readonly cz: number;
  /** The face's inward normal: depth into the body is measured along it. */
  readonly fx: number; readonly fz: number;
  /** The push, unit, inward. */
  readonly px: number; readonly pz: number;
  /** A corner zone: the falloff is radial around the centre. */
  readonly corner: boolean;
  /** Reach along the face, and into the body, m. */
  readonly reachAlong: number; readonly reachIn: number;
  /** Depth at the centre, m. */
  readonly depth: number;
}

const SQ = Math.SQRT1_2;
/** Straight in from each zone (corners diagonally). */
export const ZONE_INWARD: Readonly<Record<Zone, PlanXZ>> = {
  front: { x: 0, z: 1 }, rear: { x: 0, z: -1 }, left: { x: 1, z: 0 }, right: { x: -1, z: 0 },
  "front-left": { x: SQ, z: SQ }, "front-right": { x: -SQ, z: SQ }, "rear-left": { x: SQ, z: -SQ }, "rear-right": { x: -SQ, z: -SQ },
};
/** The physics' push is used when it is within 60 degrees of straight in (cosine); a push along or out of the face is not. */
export const PUSH_MIN_COS = 0.5;

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const clamp01 = (x: number) => clamp(x, 0, 1);

/** Place a crumple on the box `b` (the model as drawn, vehicle frame). The reaches are the dents' (damage.ts). */
export function crumpleFrame(spec: CrumpleSpec, b: Box3): CrumpleFrame {
  const L = b.maxZ - b.minZ, W = b.maxX - b.minX;
  const mx = (b.minX + b.maxX) / 2, mz = (b.minZ + b.maxZ) / 2;
  const reachIn = Math.min(CRUSH_REACH_M, L * 0.3);
  const c = spec.contact ?? null;
  const n = ZONE_INWARD[spec.zone];
  const along = (cx: number, cz: number, reachAlong: number, rIn: number) => ({ cx, cz, corner: false, reachAlong, reachIn: rIn });
  let place: { cx: number; cz: number; corner: boolean; reachAlong: number; reachIn: number };
  switch (spec.zone) {
    case "front": place = along(c ? clamp(c.x, b.minX, b.maxX) : mx, b.minZ, 0.75 * W, reachIn); break;
    case "rear": place = along(c ? clamp(c.x, b.minX, b.maxX) : mx, b.maxZ, 0.75 * W, reachIn); break;
    case "left": place = along(b.minX, c ? clamp(c.z, b.minZ, b.maxZ) : mz, 0.3 * L, Math.min(reachIn, W * 0.45)); break;
    case "right": place = along(b.maxX, c ? clamp(c.z, b.minZ, b.maxZ) : mz, 0.3 * L, Math.min(reachIn, W * 0.45)); break;
    default: {
      // A corner: around the contact (kept on the box) when it is in that corner's quarter of the body, else the corner itself.
      const kx = n.x > 0 ? b.minX : b.maxX, kz = n.z > 0 ? b.minZ : b.maxZ;
      const mine = c !== null && (c.x - mx) * n.x <= 0 && (c.z - mz) * n.z <= 0;
      place = { cx: mine ? clamp(c.x, b.minX, b.maxX) : kx, cz: mine ? clamp(c.z, b.minZ, b.maxZ) : kz, corner: true, reachAlong: 0.3 * L, reachIn: 0.3 * L };
    }
  }
  let px = n.x, pz = n.z;
  const p = spec.push;
  const len = p ? Math.hypot(p.x, p.z) : 0;
  if (p && len > 1e-9 && (p.x * n.x + p.z * n.z) / len >= PUSH_MIN_COS) { px = p.x / len; pz = p.z / len; }
  return { ...place, fx: n.x, fz: n.z, px, pz, depth: dentDepthM(spec.severity) };
}

/** Smooth bump, 1 at r = 0, 0 (with zero slope) at r >= 1. */
const bump = (r: number): number => { if (r >= 1) return 0; const s = 1 - r * r; return s * s; };

/** How much of the crumple's depth a point (vehicle frame) gets, 0..1. */
export function crumpleWeight(f: CrumpleFrame, b: Box3, x: number, y: number, z: number): number {
  const dx = x - f.cx, dz = z - f.cz;
  let w: number;
  if (f.corner) {
    w = bump(Math.hypot(dx, dz) / f.reachAlong);
  } else {
    const along = Math.abs(dx * f.fz - dz * f.fx);             // distance along the face from the contact
    const into = Math.max(0, dx * f.fx + dz * f.fz);           // depth into the body from the face
    w = bump(along / f.reachAlong) * bump(into / f.reachIn);
  }
  if (w === 0) return 0;
  const H = Math.max(b.maxY - b.minY, 1e-6);
  const u = clamp01((y - b.minY - 0.65 * H) / (0.35 * H));
  return w * (1 - 0.75 * u * u * (3 - 2 * u));                 // the roof barely moves
}

/** How much of the depth a crease gives back at most (0..1): the folds of the crumpled panel. */
export const FOLD = 0.45;
/** Spacing of the creases across the face and up it, m. */
export const FOLD_ALONG_M = 0.36;
export const FOLD_UP_M = 0.3;

/**
 * The share of the crumple's depth a point (vehicle frame) is pushed: the bump (crumpleWeight) times the folds,
 * 1 - FOLD x crease, where the crease is 0 at the contact and on the fold lines and 1 between them.
 */
export function crumpleAmount(f: CrumpleFrame, b: Box3, x: number, y: number, z: number): number {
  const w = crumpleWeight(f, b, x, y, z);
  if (w === 0) return 0;
  const s = (x - f.cx) * f.pz - (z - f.cz) * f.px;             // across the push, from the contact
  const across = 0.5 * (1 - Math.cos((2 * Math.PI * s) / FOLD_ALONG_M));
  const up = 0.5 * (1 - Math.cos((2 * Math.PI * (y - b.minY)) / FOLD_UP_M));
  return w * (1 - FOLD * across * (0.6 + 0.4 * up));
}

/** A mutable xyz (three's Vector3 is one). */
export interface XYZ { x: number; y: number; z: number }

/** Step for the weight's gradient (normals), m. */
const GRAD_STEP_M = 0.02;

/**
 * Apply one crumple to a point (vehicle frame), in place: pushed by depth x crumpleAmount, kept inside the box. With a unit
 * normal `nor`, the displaced surface's normal is written back into it (first order: n - depth (push . n) grad w).
 */
export function crumpleStep(f: CrumpleFrame, b: Box3, p: XYZ, nor?: XYZ | null): void {
  if (f.depth <= 0) return;
  const w = crumpleAmount(f, b, p.x, p.y, p.z);
  if (w === 0) return;
  if (nor) {
    const e = GRAD_STEP_M;
    const gx = (crumpleAmount(f, b, p.x + e, p.y, p.z) - crumpleAmount(f, b, p.x - e, p.y, p.z)) / (2 * e);
    const gy = (crumpleAmount(f, b, p.x, p.y + e, p.z) - crumpleAmount(f, b, p.x, p.y - e, p.z)) / (2 * e);
    const gz = (crumpleAmount(f, b, p.x, p.y, p.z + e) - crumpleAmount(f, b, p.x, p.y, p.z - e)) / (2 * e);
    const dn = f.px * nor.x + f.pz * nor.z;
    const nx = nor.x - f.depth * dn * gx, ny = nor.y - f.depth * dn * gy, nz = nor.z - f.depth * dn * gz;
    const l = Math.hypot(nx, ny, nz) || 1;
    nor.x = nx / l; nor.y = ny / l; nor.z = nz / l;
  }
  const push = f.depth * w;
  p.x = clamp(p.x + f.px * push, b.minX, b.maxX);
  p.z = clamp(p.z + f.pz * push, b.minZ, b.maxZ);
}

/**
 * Apply every crumple to a point in turn (vehicle frame, in place, against the same box), then cap the total move at the
 * deepest one's depth, so two overlapping crumples (the entered zone and the face that touched) never go deeper than the
 * curve's cap. Shrinking the move toward the start keeps the point inside the box. Returns whether it moved.
 */
export function crumplePoint(frames: readonly CrumpleFrame[], b: Box3, p: XYZ, nor?: XYZ | null): boolean {
  const x0 = p.x, y0 = p.y, z0 = p.z;
  let cap = 0;
  for (const f of frames) { crumpleStep(f, b, p, nor); cap = Math.max(cap, f.depth); }
  const dx = p.x - x0, dy = p.y - y0, dz = p.z - z0;
  const d = Math.hypot(dx, dy, dz);
  if (d === 0) return false;
  if (d > cap) { const k = cap / d; p.x = x0 + dx * k; p.y = y0 + dy * k; p.z = z0 + dz * k; }
  return true;
}

/** How far a point (vehicle frame) moves under a set of crumples (crumplePoint): [dx, dy, dz], m. */
export function crumpleOffset(specs: readonly CrumpleSpec[], b: Box3, x: number, y: number, z: number): [number, number, number] {
  const p = { x, y, z };
  crumplePoint(specs.map((s) => crumpleFrame(s, b)), b, p);
  return [p.x - x, p.y - y, p.z - z];
}

// ---------------------------------------------------------------- on a model

/** A crumpled copy of a catalog model. */
export interface Crumpled {
  /** What to draw: a copy of the model's nodes that shares its materials, with crumpled copies of the touched geometry. */
  readonly object: Object3D;
  /** Frees the geometry copies. Never the catalog model's own geometry, materials or textures (catalog-models.ts owns those). */
  dispose(): void;
}

function meshesOf(root: Object3D): Mesh[] {
  const out: Mesh[] = [];
  root.traverse((o) => { if ((o as Mesh).isMesh) out.push(o as Mesh); });
  return out;
}

/**
 * A crumpled copy of a catalog model (the fitted group, whose parent is the vehicle's own frame). `model` and its
 * geometry are never changed. Null when nothing would move (no live spec, an empty model, or the crumple misses every
 * vertex): draw the model as it is.
 */
export function crumpleModel(model: Object3D, specs: readonly CrumpleSpec[]): Crumpled | null {
  const live = specs.filter((s) => s.severity > 0);
  if (!live.length) return null;
  const copy = model.clone(true);                          // shares geometry and materials; the touched geometry is replaced below
  copy.updateMatrixWorld(true);                            // no parent: each mesh's matrixWorld takes it into the vehicle frame
  const meshes = meshesOf(copy).filter((m) => m.geometry.getAttribute("position") && !Object.keys(m.geometry.morphAttributes).length);
  // The model's own drawn box in the vehicle frame: the crumples' footprint (inside the physics box: catalog-models.ts's fit guard).
  const b = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
  const v = new Vector3();
  for (const m of meshes) {
    const pos = m.geometry.getAttribute("position");
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
      if (v.x < b.minX) b.minX = v.x; if (v.x > b.maxX) b.maxX = v.x;
      if (v.y < b.minY) b.minY = v.y; if (v.y > b.maxY) b.maxY = v.y;
      if (v.z < b.minZ) b.minZ = v.z; if (v.z > b.maxZ) b.maxZ = v.z;
    }
  }
  if (![b.minX, b.maxX, b.minY, b.maxY, b.minZ, b.maxZ].every(Number.isFinite) || b.maxX <= b.minX || b.maxZ <= b.minZ) return null;
  const frames = live.map((s) => crumpleFrame(s, b));
  const made: BufferGeometry[] = [];
  for (const m of meshes) {
    const g = crumpleGeometry(m.geometry, m.matrixWorld, frames, b);
    if (!g) continue;
    m.geometry = g;
    m.updateMorphTargets();                                // influence 0 (intact) until ImpactEffects sets the time's
    made.push(g);
  }
  if (!made.length) return null;
  return { object: copy, dispose: () => { for (const g of made) g.dispose(); } };
}

/**
 * A copy of `g` carrying the crumple as a relative morph target, or null when no vertex moves. `toVehicle` takes the
 * geometry's own frame into the vehicle frame (any scale, turn and offset): the crumple is worked out there and the
 * offsets are taken back into the geometry's frame, so the model's scale doesn't stretch the dent.
 */
export function crumpleGeometry(g: BufferGeometry, toVehicle: Matrix4, frames: readonly CrumpleFrame[], b: Box3): BufferGeometry | null {
  const pos = g.getAttribute("position");
  if (!pos) return null;
  const nor = g.getAttribute("normal") ?? null;
  const lin = new Matrix3().setFromMatrix4(toVehicle);
  if (!(Math.abs(lin.determinant()) > 1e-12)) return null;
  const back = lin.clone().invert();                       // a vehicle-frame offset into the geometry's frame
  const normalTo = new Matrix3().getNormalMatrix(toVehicle);
  const normalBack = lin.clone().transpose();              // the inverse of the normal matrix
  const dPos = new Float32Array(pos.count * 3);
  const dNor = nor ? new Float32Array(nor.count * 3) : null;
  const p0 = new Vector3(), p = new Vector3(), n0 = new Vector3(), n = new Vector3();
  let moved = 0;
  for (let i = 0; i < pos.count; i++) {
    p0.fromBufferAttribute(pos, i).applyMatrix4(toVehicle);
    p.copy(p0);
    if (nor) n.fromBufferAttribute(nor, i).applyMatrix3(normalTo).normalize();
    if (!crumplePoint(frames, b, p, nor ? n : null)) continue;
    moved++;
    p.sub(p0).applyMatrix3(back);
    dPos[i * 3] = p.x; dPos[i * 3 + 1] = p.y; dPos[i * 3 + 2] = p.z;
    if (nor && dNor) {
      n0.fromBufferAttribute(nor, i);
      n.applyMatrix3(normalBack).normalize().multiplyScalar(n0.length() || 1);
      dNor[i * 3] = n.x - n0.x; dNor[i * 3 + 1] = n.y - n0.y; dNor[i * 3 + 2] = n.z - n0.z;
    }
  }
  if (!moved) return null;
  const out = g.clone();
  out.morphAttributes["position"] = [new Float32BufferAttribute(dPos, 3)];
  if (dNor) out.morphAttributes["normal"] = [new Float32BufferAttribute(dNor, 3)];
  out.morphTargetsRelative = true;
  markDentMorph(out);
  return out;
}
