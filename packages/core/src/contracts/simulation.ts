// The physics result: the data contract in DESIGN.md section 14. Every number
// the UI, PDF and PNGs show comes from here, through the formatter. SI units.
import type { LanePath } from "./roads";
import type { Pose, Range, Vec2 } from "./geometry";
import type { VehicleId, VehicleType, Zone } from "./scene";

/** One assumption the model made, written for the PDF and the scene file. */
export interface Assumption {
  readonly id: string;
  /** Plain sentence, e.g. "Road dry, as entered: friction 0.7 for the whole road." */
  readonly text: string;
  readonly value?: number;
  readonly unit?: string;
  readonly source?: string;
}

/** A message for the claimant: a validation problem or a warning. Text only, never HTML. */
export interface PlainMessage {
  readonly code: string;
  readonly text: string;
  readonly vehicleIds: readonly VehicleId[];
}

/**
 * What the hit did to one vehicle, for effects and labels (optional: a renderer that finds it missing reads the track).
 * All numbers are for the three speed cases of the "not sure" scan (lo / mid / hi), mid being the picture.
 */
export interface ImpactData {
  /** Size of the velocity change the hit gave this vehicle, m/s (|v after - v before|). */
  readonly deltaVMps: Range;
  /** Where this vehicle was pushed: the centre of the contact patch, local ENU, meters. */
  readonly contactPointM: Vec2;
  /** Unit vector, the direction the hit pushed THIS vehicle (local ENU). */
  readonly normal: Vec2;
  /**
   * Yaw rate right after the impact, rad/s. Positive = clockwise seen from above, the compass sense: the same sign
   * convention as `headingRad` in the track, so heading rises while spin > 0. It slows at a steady rate until it stops.
   */
  readonly spinRadps: Range;
  /** The zone the claimant entered for this vehicle. */
  readonly zoneHit: Zone;
  /** The zone of THIS vehicle's body that actually touched (nearest of the eight zone anchors to the contact point); can differ from zoneHit. */
  readonly leadingZone: Zone;
}

export interface VehicleResult {
  readonly id: VehicleId;
  readonly type: VehicleType;
  readonly massKg: number;
  readonly lengthM: number;
  readonly widthM: number;
  /** Yaw moment of inertia, kg·m² (box approximation; listed in assumptions). */
  readonly inertiaKgM2: number;
  /** The lane path the vehicle followed before impact (null when parked). */
  readonly path: LanePath | null;
  readonly speedAtImpactMps: Range;
  /** Distance covered in the approach window before impact, meters. */
  readonly approachDistanceM: Range;
  readonly postImpactDistanceM: Range;
  readonly impactPose: Pose;
  readonly restPose: Pose;
  /** Middle run, sampled every `dtS` from `startTimeS` to `restTimeS`. */
  readonly track: readonly Pose[];
  /** What the hit did to this vehicle; absent for a vehicle that took no part in a contact. */
  readonly impact?: ImpactData;
}

export interface SimulationResult {
  readonly physicsVersion: string;
  /** Fixed step of the integration and of every track, seconds. */
  readonly dtS: number;
  /** Negative: start of the approach window. Impact is at t = 0. */
  readonly startTimeS: number;
  readonly impactTimeS: 0;
  readonly restTimeS: number;
  readonly frictionCoefficient: number;
  readonly restitution: number;
  readonly impactPointM: Vec2;
  readonly vehicles: readonly VehicleResult[];
  /**
   * Center-to-center distances at final rest, ONLY for pairs of vehicles that
   * touched at impact (Zoheb, 2026-10-09). Two vehicles: one A–B entry. A chain
   * A–B–C: A–B and B–C, never A–C. Consumers print what's here, unfiltered.
   */
  readonly gaps: ReadonlyArray<{ readonly a: VehicleId; readonly b: VehicleId; readonly restGapM: Range }>;
  readonly assumptions: readonly Assumption[];
  /** Things that may not fit together; shown on review and in the PDF. Never block. */
  readonly warnings: readonly PlainMessage[];
}

export type SimulationOutcome =
  | { readonly ok: true; readonly result: SimulationResult }
  /** Inputs that can't produce a picture (e.g. bodies overlap before impact). Shown as plain text. */
  | { readonly ok: false; readonly errors: readonly PlainMessage[] };
