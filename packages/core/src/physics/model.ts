// Vehicle numbers and speed cases shared by placement, checks and simulation. SI units.
import type { SceneVehicle, Zone } from "../contracts/scene";
import { PRESETS } from "../presets";
import { APPROACH_S, BRAKE_FACTOR, BRAKING_S, DEFAULT_LIMIT_MPH, G_MPS2, MPH_TO_MPS, RANGE_HALF_MPH } from "./constants";
import { toRad } from "./geo";

export interface VehicleDims {
  readonly massKg: number;
  readonly lengthM: number;
  readonly widthM: number;
  /** Yaw moment of inertia of a uniform rectangular box, kg·m². */
  readonly inertiaKgM2: number;
}

/** Class-average mass and size from the presets (the exact vehicle is rarely known). */
export function dimsOf(v: Pick<SceneVehicle, "type">): VehicleDims {
  const p = PRESETS[v.type];
  const m = p.mass.value, L = p.length.value, W = p.width.value;
  return { massKg: m, lengthM: L, widthM: W, inertiaKgM2: (m * (L * L + W * W)) / 12 };
}

export interface SpeedCases {
  /** Speeds in m/s AT THE IMPACT (the typed speeds). */
  readonly lo: number;
  readonly mid: number;
  readonly hi: number;
  readonly unsure: boolean;
  /** The posted limit the "not sure" range is centred on, mph (null when the speed is known or the vehicle is parked). */
  readonly limitMph: number | null;
  /** True when the claimant didn't know the limit and the default was used. */
  readonly limitAssumed: boolean;
}

/** Low / middle / high speeds: known speeds give one value; "not sure" gives limit-5, limit, limit+5 mph. Parked is 0. */
export function speedCases(v: SceneVehicle): SpeedCases {
  if (v.action === "parked") return { lo: 0, mid: 0, hi: 0, unsure: false, limitMph: null, limitAssumed: false };
  if (v.speed.kind === "known") {
    const s = v.speed.mph * MPH_TO_MPS;
    return { lo: s, mid: s, hi: s, unsure: false, limitMph: null, limitAssumed: false };
  }
  const assumed = v.speed.limitMph === null;
  const limit = v.speed.limitMph ?? DEFAULT_LIMIT_MPH;
  return {
    lo: Math.max(0, limit - RANGE_HALF_MPH) * MPH_TO_MPS, mid: limit * MPH_TO_MPS, hi: (limit + RANGE_HALF_MPH) * MPH_TO_MPS,
    unsure: true, limitMph: limit, limitAssumed: assumed,
  };
}

export type CaseKey = "lo" | "mid" | "hi";
export const CASES: readonly CaseKey[] = ["lo", "mid", "hi"];

/** Zone direction measured clockwise from the vehicle's front, radians. */
export const ZONE_ANGLE_RAD: Readonly<Record<Zone, number>> = Object.freeze({
  front: 0, "front-right": toRad(45), right: toRad(90), "rear-right": toRad(135), rear: toRad(180), "rear-left": toRad(225), left: toRad(270), "front-left": toRad(315),
});

/** Where a zone sits on the body outline, in the vehicle frame: `a` along the front, `b` toward the right. Mid-side, or the corner for the diagonals. */
export function zoneAnchorLocal(zone: Zone, lengthM: number, widthM: number): { a: number; b: number } {
  const L = lengthM / 2, W = widthM / 2;
  switch (zone) {
    case "front": return { a: L, b: 0 };
    case "front-right": return { a: L, b: W };
    case "right": return { a: 0, b: W };
    case "rear-right": return { a: -L, b: W };
    case "rear": return { a: -L, b: 0 };
    case "rear-left": return { a: -L, b: -W };
    case "left": return { a: 0, b: -W };
    case "front-left": return { a: L, b: -W };
  }
}

export const isRearZone = (z: Zone): boolean => z === "rear" || z === "rear-left" || z === "rear-right";
export const isSideZone = (z: Zone): boolean => z === "left" || z === "right";

/** How far from the zone's direction an approach may come and still count as hitting it: wider for the long sides. */
export const zoneToleranceRad = (z: Zone): number => (isSideZone(z) ? toRad(90) : toRad(67.5));

// ---------------------------------------------------------------- approach (working backwards from the impact)

/**
 * Speed and distance covered tau seconds BEFORE the impact (tau >= 0), for a vehicle that has speed vImpact at
 * the impact and decelerates at `a` (0 when not braking) during the last BRAKING_S, holding steady before that:
 *   v(tau) = vImpact + a * min(tau, B)
 *   s(tau) = vImpact * tau + a * min(tau, B)^2 / 2 + a * B * max(0, tau - B)
 * It is faster before the impact than at it, so it can never be stopped before the impact.
 */
export function approachBack(vImpactMps: number, a: number, tauS: number): { v: number; s: number } {
  const m = Math.min(tauS, BRAKING_S);
  return { v: vImpactMps + a * m, s: vImpactMps * tauS + 0.5 * a * m * m + a * BRAKING_S * Math.max(0, tauS - BRAKING_S) };
}

export interface Approach {
  /** Speed at the impact, m/s: exactly the entered speed. */
  readonly vImpactMps: number;
  /** Speed at the start of the window, APPROACH_S before the impact, m/s. */
  readonly vStartMps: number;
  /** Distance covered in the window, m. */
  readonly distanceM: number;
}

/** Deceleration of a braking vehicle on this road, m/s². */
export const brakeDecel = (mu: number): number => BRAKE_FACTOR * mu * G_MPS2;

/** The approach of a vehicle whose speed at the impact is `vImpactMps` (the typed speed). */
export function approachFor(vImpactMps: number, brakeDecelMps2: number): Approach {
  const k = approachBack(vImpactMps, brakeDecelMps2, APPROACH_S);
  return { vImpactMps, vStartMps: k.v, distanceM: k.s };
}

/** An approach on a path with limited room behind the vehicle: how it moves, and whether it starts from a stop. */
export interface RoomyApproach extends Approach {
  /** The room behind was shorter than the approach: it starts from a stop `roomM` back and speeds up evenly. */
  readonly fromRest: boolean;
  /** Its even speed-up from the stop, m/s² (0 when not from a stop). */
  readonly startAccelMps2: number;
}

/**
 * Like approachBack, for a vehicle with only `roomM` of path behind its place at the impact (null = as much as it needs).
 * When the usual approach (steady speed, then any braking) needs more room than that, the vehicle starts from a stop
 * `roomM` back and speeds up evenly to its entered speed at the impact (never braking: it was just starting):
 *   a = v² / (2 roomM); for tau <= v / a: v(tau) = v - a tau, s(tau) = v tau - a tau² / 2; earlier it stands at s = roomM.
 */
export function approachBackWithin(vImpactMps: number, a: number, roomM: number | null, tauS: number): { v: number; s: number } {
  const accel = startAccel(vImpactMps, a, roomM);
  if (accel === 0) return approachBack(vImpactMps, a, tauS);
  const tStart = vImpactMps / accel;
  if (tauS >= tStart) return { v: 0, s: roomM! };
  return { v: vImpactMps - accel * tauS, s: vImpactMps * tauS - 0.5 * accel * tauS * tauS };
}

/** The even speed-up from a stop that the room behind forces (0 when there is room for the usual approach). */
function startAccel(vImpactMps: number, a: number, roomM: number | null): number {
  if (roomM === null || vImpactMps <= 1e-9) return 0;
  if (approachBack(vImpactMps, a, APPROACH_S).s <= roomM + 1e-9) return 0;
  return (vImpactMps * vImpactMps) / (2 * Math.max(roomM, 1e-3));
}

/** approachFor with limited room behind (see approachBackWithin). */
export function approachWithin(vImpactMps: number, brakeDecelMps2: number, roomM: number | null): RoomyApproach {
  const accel = startAccel(vImpactMps, brakeDecelMps2, roomM);
  const k = approachBackWithin(vImpactMps, brakeDecelMps2, roomM, APPROACH_S);
  return { vImpactMps, vStartMps: k.v, distanceM: k.s, fromRest: accel > 0, startAccelMps2: accel };
}

export const letterName = (id: string): string => `Vehicle ${id}`;

/** The message for a scene where no vehicle moves (the same sentence checkScene gives). */
export const NOTHING_MOVING_TEXT = "None of the vehicles is moving, so nothing would have hit anything. Set a speed for at least one vehicle, or check what each was doing.";
/** Mid-sentence form: "vehicle B". */
export const vehicleWord = (id: string): string => `vehicle ${id}`;
