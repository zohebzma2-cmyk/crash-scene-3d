// What the hit did to one vehicle, as the effects need it: how hard (delta-v), where (contact point) and
// which faces of the body were involved. The physics supplies this as `VehicleResult.impact` (ImpactData);
// when it is missing for a vehicle (older scene files, a vehicle that took no part), it is derived from
// the track. Everything here is a pure function of the SimulationResult (and optionally the Scene).
import type { Pose, Scene, SimulationResult, Vec2, VehicleResult, Zone } from "@csd/core";

/** Clockwise from the front, the same order as the contract's ZONES. */
export const ZONE_RING: readonly Zone[] = ["front", "front-right", "right", "rear-right", "rear", "rear-left", "left", "front-left"];

export interface ImpactInfo {
  /** Size of the velocity change, m/s: |v after - v before|, middle case. */
  readonly deltaVMps: number;
  /** Where the vehicle was hit, local ENU meters. */
  readonly contactPointM: Vec2;
  /** The zone the claimant entered for this vehicle (null when the scene wasn't given and the physics has none). */
  readonly zoneHit: Zone | null;
  /** The zone of this vehicle's own body that touched (nearest zone to the contact point). */
  readonly leadingZone: Zone;
  /** True when the numbers came from the physics' own impact data, false when derived from the track. */
  readonly fromPhysics: boolean;
}

/** Index of t = 0 in a track. */
export function impactIndex(sim: SimulationResult): number {
  return Math.round((0 - sim.startTimeS) / sim.dtS);
}

/** The zone of a body (pose at impact) that a world point is nearest to: octants clockwise from the front. */
export function zoneOfPoint(pose: Pose, point: Vec2): Zone {
  const dx = point.x - pose.xM, dy = point.y - pose.yM;
  const fwd = dx * Math.sin(pose.headingRad) + dy * Math.cos(pose.headingRad);
  const right = dx * Math.cos(pose.headingRad) - dy * Math.sin(pose.headingRad);
  const a = Math.atan2(right, fwd);                           // clockwise from the front, (-pi, pi]
  const k = ((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8;
  return ZONE_RING[k]!;
}

/** Steps between two zones around the ring: 0 same, 1 neighbors, 4 opposite. */
export function zoneDistance(a: Zone, b: Zone): number {
  const d = Math.abs(ZONE_RING.indexOf(a) - ZONE_RING.indexOf(b));
  return Math.min(d, 8 - d);
}

/**
 * |v(0+) - v(0-)| from the track: the velocity just before the impact sample is the step into it, the velocity
 * just after is the step out of it. Positions, not the speed field, because after a hit a vehicle can slide
 * sideways while it points somewhere else.
 */
export function deltaVFromTrack(sim: SimulationResult, v: VehicleResult): number {
  const i = impactIndex(sim), tr = v.track;
  if (i < 1 || i + 1 >= tr.length) return 0;
  const a = tr[i - 1]!, b = tr[i]!, c = tr[i + 1]!;
  const before = { x: (b.xM - a.xM) / sim.dtS, y: (b.yM - a.yM) / sim.dtS };
  const after = { x: (c.xM - b.xM) / sim.dtS, y: (c.yM - b.yM) / sim.dtS };
  return Math.hypot(after.x - before.x, after.y - before.y);
}

/**
 * The adapter the effects read. Prefers `v.impact` (from the physics) and falls back to the track and
 * `sim.impactPointM`. Pass the Scene to get the zone the claimant entered.
 */
export function getImpactInfo(sim: SimulationResult, v: VehicleResult, scene?: Scene): ImpactInfo {
  const phys = v.impact;
  const entered = scene?.vehicles.find((x) => x.id === v.id)?.zone ?? null;
  if (phys) {
    return {
      deltaVMps: phys.deltaVMps.mid,
      contactPointM: phys.contactPointM,
      zoneHit: phys.zoneHit ?? entered,
      leadingZone: phys.leadingZone ?? zoneOfPoint(v.impactPose, phys.contactPointM),
      fromPhysics: true,
    };
  }
  return {
    deltaVMps: deltaVFromTrack(sim, v),
    contactPointM: sim.impactPointM,
    zoneHit: entered,
    leadingZone: zoneOfPoint(v.impactPose, sim.impactPointM),
    fromPhysics: false,
  };
}
