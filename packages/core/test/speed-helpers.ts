// The "typed speed is the speed at impact" check, shared by speed-at-impact.test.ts and the property tests.
import { expect } from "vitest";
import { APPROACH_S, BRAKING_S, DEFAULT_LIMIT_MPH, MPH_TO_MPS, RANGE_HALF_MPH } from "../src";
import type { Scene, SceneVehicle, SimulationResult } from "../src";

const EPS = 1e-9;

/** The typed speed in m/s as the physics must have used it (converted at the boundary only). */
export function typedRange(v: SceneVehicle): { lo: number; mid: number; hi: number } {
  if (v.action === "parked") return { lo: 0, mid: 0, hi: 0 };
  if (v.speed.kind === "known") { const s = v.speed.mph * MPH_TO_MPS; return { lo: s, mid: s, hi: s }; }
  const limit = v.speed.limitMph ?? DEFAULT_LIMIT_MPH;
  return { lo: (limit - RANGE_HALF_MPH) * MPH_TO_MPS, mid: limit * MPH_TO_MPS, hi: (limit + RANGE_HALF_MPH) * MPH_TO_MPS };
}

/** Assert the whole rule for one finished run. */
export function expectSpeedAtImpact(scene: Scene, sim: SimulationResult, label: string): void {
  const i0 = Math.round(-sim.startTimeS / sim.dtS);
  const pictureWasMoved = sim.warnings.some((w) => w.code === "picture-speed");
  for (const sv of scene.vehicles) {
    const r = sim.vehicles.find((x) => x.id === sv.id)!;
    const typed = typedRange(sv);
    const at = r.speedAtImpactMps;
    if (sv.action === "parked" || sv.speed.kind === "known") {
      expect(Math.abs(at.lo - typed.mid), `${label} ${sv.id} lo`).toBeLessThan(EPS);
      expect(Math.abs(at.mid - typed.mid), `${label} ${sv.id} mid`).toBeLessThan(EPS);
      expect(Math.abs(at.hi - typed.mid), `${label} ${sv.id} hi`).toBeLessThan(EPS);
    } else {
      expect(at.lo, `${label} ${sv.id} lo`).toBeGreaterThanOrEqual(typed.lo - EPS);
      expect(at.hi, `${label} ${sv.id} hi`).toBeLessThanOrEqual(typed.hi + EPS);
      expect(at.lo).toBeLessThanOrEqual(at.mid + EPS);
      expect(at.mid).toBeLessThanOrEqual(at.hi + EPS);
      // Every shown speed (including a moved picture speed) is exactly on the 0.5 mph grid the scan works on, counted from limit - 5.
      const limit = sv.speed.limitMph ?? DEFAULT_LIMIT_MPH;
      for (const v of [at.lo, at.mid, at.hi]) {
        const steps = (v / MPH_TO_MPS - (limit - RANGE_HALF_MPH)) / 0.5;
        expect(Math.abs(steps - Math.round(steps)), `${label} ${sv.id} grid ${v / MPH_TO_MPS} mph`).toBeLessThan(1e-9);
      }
      if (!pictureWasMoved) expect(Math.abs(at.mid - typed.mid), `${label} ${sv.id} mid`).toBeLessThan(EPS);
    }
    // The pose at the impact carries the same speed.
    expect(r.impactPose.speedMps, `${label} ${sv.id} impact pose`).toBe(at.mid);
    expect(r.track[i0]!.speedMps).toBe(at.mid);
    const moving = sv.action !== "parked";
    // A vehicle with less room behind it than its approach needs starts from a stop and speeds up evenly to its speed at the
    // impact (the start-from-stop assumption says so, with its rate): never faster than at the impact, never slowing down.
    const start = sim.assumptions.find((x) => x.id === `start-from-stop-${sv.id}`);
    if (start) {
      for (let i = 0; i < i0; i++) {
        const s = r.track[i]!.speedMps, next = r.track[i + 1]!.speedMps;
        if (!(s <= at.mid + EPS && s <= next + 1e-9)) expect(s, `${label} ${sv.id} start sample ${i}`).toBeLessThanOrEqual(Math.min(at.mid, next) + 1e-9);
      }
      // Standing at the start when the window opens: it covers exactly the room, at the rate the assumption gives.
      if (r.track[0]!.speedMps === 0) expect(Math.abs((start.value as number) - (at.mid * at.mid) / (2 * r.approachDistanceM.mid)), `${label} ${sv.id} start rate`).toBeLessThan(1e-6);
      continue;
    }
    // Before the impact it is never slower than at the impact, and a moving vehicle is never at rest.
    for (let i = 0; i < i0; i++) {
      // Plain comparisons per sample (expect() per sample is slow in the property tests); expect() only on a failure.
      const s = r.track[i]!.speedMps;
      if (!(s >= at.mid - EPS)) expect(s, `${label} ${sv.id} t<0 sample ${i}`).toBeGreaterThanOrEqual(at.mid - EPS);
      if (moving && at.mid > 0 && !(s > 0)) expect(s, `${label} ${sv.id} not stopped sample ${i}`).toBeGreaterThan(0);
    }
    // Braking: a steady higher speed before the last BRAKING_S; not braking: the same speed all the way.
    const a = sim.assumptions.find((x) => x.id === "braking-deceleration")?.value;
    if (moving && sv.braking) expect(Math.abs(r.track[0]!.speedMps - (at.mid + a! * BRAKING_S)), `${label} ${sv.id} braking`).toBeLessThan(1e-6);
    else expect(Math.abs(r.track[0]!.speedMps - at.mid), `${label} ${sv.id} steady`).toBeLessThan(EPS);
  }
  expect(APPROACH_S).toBe(-sim.startTimeS);
}
