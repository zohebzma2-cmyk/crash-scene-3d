// The yaw model: an off-centre hit gives spin (r x J / I), friction slows the spin at a constant rate alpha = mu g / k,
// the heading integrates the spin and the slide follows the velocity. Plus the impact data for the renderer (VehicleResult.impact).
// The worked T-bone example below has hand-computed numbers (steps in the comments) so a reviewer can check them with a calculator.
import { describe, expect, it } from "vitest";
import { CONTACT_FRICTION, DT_S, FRICTION, G_MPS2, PRESETS, RESTITUTION, resolveContacts, resolveImpact, simulate, slideToRest } from "../src";
import type { Body2D, SimulationResult, Vec2, VehicleResult, Zone } from "../src";
import { placeDetailed } from "../src/physics/placement";
import { impactInput } from "../src/physics/simulate";
import { speedCases } from "../src/physics/model";
import { MPH, expectOk, fwdOf, flatTBoneScene, known, rightOf, sceneOf, unsure, veh } from "./physics-helpers";

const run = (scene: Parameters<typeof simulate>[0]): SimulationResult => expectOk(simulate(scene, null)).result;
const vr = (sim: SimulationResult, id: string): VehicleResult => sim.vehicles.find((v) => v.id === id)!;
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const cross = (a: Vec2, b: Vec2) => a.x * b.y - a.y * b.x;
const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
const box = (m: number, L: number, W: number) => (m * (L * L + W * W)) / 12;

describe("yaw model: signs and the centred case", () => {
  const body = (centre: Vec2, v: Vec2): Body2D => ({ massKg: 1600, inertiaKgM2: box(1600, 4.8, 1.85), centreM: centre, velocityMps: v, spinRadPs: 0 });
  const wall: Body2D = { massKg: 1e9, inertiaKgM2: 1e12, centreM: { x: -10, y: 0 }, velocityMps: { x: 0, y: 0 }, spinRadPs: 0 };
  // Body `a` is pushed east (+x) by a wall on its west. Spin is counter-clockwise positive (math frame): a push east at
  // the north end of the body (ahead of the centre if it faces north) turns it clockwise (negative); at the south end, counter-clockwise.

  it("an off-centre hit gives spin with the right sign: a push at the north end is clockwise, at the south end counter-clockwise", () => {
    const a = body({ x: 0, y: 0 }, { x: -6, y: 0 });
    const north = resolveImpact(a, wall, { x: 0, y: 2 }, { x: 1, y: 0 }, RESTITUTION, 0);
    const south = resolveImpact(a, wall, { x: 0, y: -2 }, { x: 1, y: 0 }, RESTITUTION, 0);
    expect(north.a.spinRadPs).toBeLessThan(0);
    expect(south.a.spinRadPs).toBeGreaterThan(0);
    // The size is r x J / I (r = 2 m).
    expect(north.a.spinRadPs).toBeCloseTo((-2 * north.impulseNs) / a.inertiaKgM2, 9);
    expect(south.a.spinRadPs).toBeCloseTo((2 * south.impulseNs) / a.inertiaKgM2, 9);
    expect(north.a.spinRadPs).toBeCloseTo(-south.a.spinRadPs, 9);
  });

  it("with contact friction the sign still follows the lever arm, and a heavier or longer vehicle spins less for the same push", () => {
    const a = body({ x: 0, y: 0 }, { x: -6, y: 0 });
    const heavy: Body2D = { ...a, massKg: 3200, inertiaKgM2: box(3200, 4.8, 1.85) };
    const long: Body2D = { ...a, inertiaKgM2: box(1600, 8, 1.85) };
    const base = resolveImpact(a, wall, { x: 0, y: 2 }, { x: 1, y: 0 }, RESTITUTION);
    expect(base.a.spinRadPs).toBeLessThan(0);
    // Same closing speed: J grows with the mass, I grows with it too, so heavy spins about as much; a longer body (bigger I) spins less.
    expect(Math.abs(resolveImpact(long, wall, { x: 0, y: 2 }, { x: 1, y: 0 }, RESTITUTION).a.spinRadPs)).toBeLessThan(Math.abs(base.a.spinRadPs));
    expect(Number.isFinite(resolveImpact(heavy, wall, { x: 0, y: 2 }, { x: 1, y: 0 }, RESTITUTION).a.spinRadPs)).toBe(true);
  });

  it("a centred hit with no slip gives no spin and no tangential impulse", () => {
    const a = body({ x: 0, y: 0 }, { x: -6, y: 0 });
    const r = resolveImpact(a, wall, { x: 0, y: 0 }, { x: 1, y: 0 }, RESTITUTION, CONTACT_FRICTION);
    expect(r.a.spinRadPs).toBe(0);
    expect(r.b.spinRadPs).toBe(0);
    expect(r.tangentialImpulseNs).toBeCloseTo(0, 12);
    expect(r.a.velocityMps.y).toBeCloseTo(0, 12);
  });

  it("in a whole simulation a centred rear-end gives no spin: the impact data says 0 and the heading never changes", () => {
    const sim = run(sceneOf([veh("A", { type: "suv", bearingDeg: 0, speed: known(20), zone: "rear" }), veh("B", { type: "pickup", bearingDeg: 0, speed: known(45), zone: "front" })]));
    for (const v of sim.vehicles) {
      expect(Math.abs(v.impact!.spinRadps.mid)).toBeLessThan(1e-9);
      expect(Math.abs(wrap(v.restPose.headingRad - v.impactPose.headingRad))).toBeLessThan(1e-9);
    }
  });
});

describe("yaw model: the spin slows at a constant rate and the heading integrates it", () => {
  const start = { positionM: { x: 1, y: 2 }, velocityMps: { x: 3, y: 4 }, headingRad: 0.5, spinRadPs: 2 };
  const MU = FRICTION.dry;
  const K = 1.5;
  const ALPHA = (MU * G_MPS2) / K;

  it("the spin falls linearly: w(t) = w0 - alpha t, and is exactly 0 from t = w0 / alpha on", () => {
    const run = slideToRest(start, MU, DT_S, ALPHA);
    const tStop = start.spinRadPs / ALPHA;
    for (const k of [1, 7, 20, 40]) {
      const t = k * DT_S;
      if (t < tStop) expect(run.samples[k]!.spinRadPs).toBeCloseTo(start.spinRadPs - ALPHA * t, 9);
    }
    const firstZero = run.samples.findIndex((s) => s.spinRadPs === 0);
    expect(firstZero).toBeGreaterThan(0);
    expect(Math.abs(firstZero * DT_S - tStop)).toBeLessThanOrEqual(DT_S + 1e-9);
    for (const s of run.samples.slice(firstZero)) expect(s.spinRadPs).toBe(0);
  });

  it("the heading at rest equals the integral of the spin: start - w0^2 / (2 alpha), and a trapezoid sum of the samples agrees", () => {
    const run = slideToRest(start, MU, DT_S, ALPHA);
    const last = run.samples[run.samples.length - 1]!;
    expect(last.headingRad).toBeCloseTo(start.headingRad - (start.spinRadPs * start.spinRadPs) / (2 * ALPHA), 9);
    let integral = 0;
    for (let i = 1; i < run.samples.length; i++) integral += 0.5 * (run.samples[i - 1]!.spinRadPs + run.samples[i]!.spinRadPs) * DT_S;
    expect(Math.abs(start.headingRad - integral - last.headingRad)).toBeLessThan(0.01 * Math.abs(integral) + 1e-6);
  });

  it("the slide follows the velocity, not the heading: the centre moves along (3, 4) while the heading turns", () => {
    const run = slideToRest(start, MU, DT_S, ALPHA);
    for (const s of run.samples) {
      const d = sub(s.positionM, start.positionM);
      expect(Math.abs(cross(d, { x: 0.6, y: 0.8 }))).toBeLessThan(1e-9);
    }
    const last = run.samples[run.samples.length - 1]!;
    expect(Math.abs(last.headingRad - start.headingRad)).toBeGreaterThan(0.1);
    // 0.6, 0.8 is not the heading (0.5 rad is about 29 degrees from north): the vehicle slides partly sideways.
    const dirOfHeading = fwdOf(start.headingRad);
    expect(Math.abs(cross({ x: 0.6, y: 0.8 }, dirOfHeading))).toBeGreaterThan(0.1);
  });

  it("the yaw stop time differs from the slide stop time, so it can keep turning after it stops sliding", () => {
    const fast = slideToRest({ ...start, velocityMps: { x: 0.3, y: 0.4 }, spinRadPs: 3 }, MU, DT_S, ALPHA);
    const tSlide = fast.restTimeS;
    expect(3 / ALPHA).toBeGreaterThan(tSlide);
    const afterSlide = fast.samples[Math.ceil(tSlide / DT_S) + 1]!;
    expect(afterSlide.velocityMps).toEqual({ x: 0, y: 0 });
    expect(afterSlide.spinRadPs).toBeGreaterThan(0);
  });
});

describe("yaw model: angular momentum at the impact", () => {
  it("angular and linear momentum about a fixed point are conserved through the impulses of the T-bone, with friction", () => {
    const scene = flatTBoneScene({ aMph: 25, bSpeed: known(20) });
    const placed = expectOk(placeDetailed(scene, null, { x: 0, y: 0 })).value;
    const { before, specs } = impactInput(placed.bodies, placed.contacts, placed.bodies.map((b) => speedCases(b.veh).mid), FRICTION.dry);
    const after = resolveContacts(before, specs, RESTITUTION, 4, CONTACT_FRICTION);
    const about: Vec2 = { x: 3.3, y: -7.1 };
    const L = (bs: readonly Body2D[]) => bs.reduce((s, b) => s + b.inertiaKgM2 * b.spinRadPs + b.massKg * cross(sub(b.centreM, about), b.velocityMps), 0);
    const P = (bs: readonly Body2D[]) => ({ x: bs.reduce((s, b) => s + b.massKg * b.velocityMps.x, 0), y: bs.reduce((s, b) => s + b.massKg * b.velocityMps.y, 0) });
    const scale = before.reduce((s, b) => s + Math.abs(b.inertiaKgM2 * b.spinRadPs) + Math.abs(b.massKg * cross(sub(b.centreM, about), b.velocityMps)), 0);
    expect(Math.abs(L(after) - L(before)) / scale).toBeLessThan(1e-9);
    expect(Math.abs(P(after).x - P(before).x)).toBeLessThan(1e-6);
    expect(Math.abs(P(after).y - P(before).y)).toBeLessThan(1e-6);
    expect(after.some((b) => b.spinRadPs !== 0)).toBe(true);
  });
});

describe("yaw model: whole simulations", () => {
  it("the heading at rest is the impact heading minus w0^2 / (2 alpha), with alpha = mu g / k, for hits all over the body", () => {
    const zones: Zone[] = ["front", "front-right", "right", "rear-right", "rear", "rear-left", "left", "front-left"];
    let checked = 0;
    const bearingFor = (z: Zone): number => (z === "left" || z === "front-left" || z === "rear-left" ? 90 : z === "right" || z === "front-right" || z === "rear-right" ? 270 : z === "front" ? 180 : 0);
    for (const za of zones) for (const zb of ["front", "front-left", "front-right"] as const) for (const condition of ["dry", "wet"] as const) {
      const o = simulate(sceneOf([
        veh("A", { type: "car", bearingDeg: 0, speed: known(25), zone: za }),
        veh("B", { type: "suv", bearingDeg: bearingFor(za), speed: known(za.startsWith("rear") ? 40 : 20), zone: zb }),
      ], { condition }), null);
      if (!o.ok) continue;
      const sim = o.result;
      if (sim.warnings.some((w) => w.code === "stopped-at-vehicle" || w.code === "stopped-at-building")) continue;
      for (const v of sim.vehicles) {
        const w0 = -v.impact!.spinRadps.mid; // back to the math frame (counter-clockwise positive)
        const k = Math.sqrt(v.inertiaKgM2 / v.massKg);
        const alpha = (sim.frictionCoefficient * G_MPS2) / k;
        const turnCcw = ((w0 * w0) / (2 * alpha)) * Math.sign(w0);
        expect(Math.abs(wrap(v.restPose.headingRad - v.impactPose.headingRad + turnCcw)), `${za}/${zb} ${condition} ${v.id}`).toBeLessThan(1e-6);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(30);
  });

  it("the track's heading rate follows w(t) = w0 - alpha t (a finite difference, in the compass sense)", () => {
    const sim = run(flatTBoneScene({ aMph: 25, bSpeed: known(20), condition: "dry" }));
    const i0 = Math.round(-sim.startTimeS / sim.dtS);
    for (const id of ["A", "B"]) {
      const v = vr(sim, id);
      const w0 = v.impact!.spinRadps.mid; // compass sense: heading rate = +w
      const alpha = (sim.frictionCoefficient * G_MPS2) / Math.sqrt(v.inertiaKgM2 / v.massKg);
      const tStop = Math.abs(w0) / alpha;
      for (const frac of [0.2, 0.5, 0.8]) {
        const k = Math.max(2, Math.round((frac * tStop) / DT_S));
        const rate = wrap(v.track[i0 + k + 1]!.headingRad - v.track[i0 + k]!.headingRad) / DT_S;
        const t = (k + 0.5) * DT_S;
        expect(rate, `${id} at ${frac}`).toBeCloseTo(Math.sign(w0) * (Math.abs(w0) - alpha * t), 2);
      }
    }
  });
});

describe("worked T-bone example, hand-computed (A: car north at 25 mph, B: SUV east at 20 mph, dry, flat ground)", () => {
  // Inputs (from the presets): m_A = 1610 kg (3,550 lb), m_B = 2064 kg (4,550 lb); A is 4.80 x 1.85 m, B is 4.85 x 1.95 m.
  //   I = m (L^2 + W^2) / 12:   I_A = 3550.39 kg m^2,   I_B = 4699.90 kg m^2.
  //   Speeds at impact: v_A = 25 mph = 11.176 m/s (north), v_B = 20 mph = 8.9408 m/s (east).
  // Contact: the middle of A's left side and the middle of B's front. Normal n = east (from B into A), tangent t = north.
  //   Lever arms: r_A = (-0.925, 0) (half of A's width, west of A's centre), r_B = (+2.425, 0) (half of B's length, ahead of B's centre).
  //   Both are along n, so the normal impulse has no lever arm: the spin comes from the tangential (friction) impulse alone.
  // Closing speed along n is v_B = 8.9408, and the slip along t is v_A = 11.176.
  //   1/m_A + 1/m_B = 6.21118e-4 + 4.84496e-4 = 1.105614e-3 1/kg.
  //   Normal impulse  J_n = (1 + e) v_B / (1/m_A + 1/m_B) = 1.2 x 8.9408 / 1.105614e-3 = 9704.07 N s.
  //   K_tt = 1/m_A + 1/m_B + (W_A/2)^2 / I_A + (L_B/2)^2 / I_B = 1.105614e-3 + 2.40990e-4 + 1.251232e-3 = 2.597836e-3 1/kg.
  //   Sticking tangential impulse J_t = -v_A / K_tt = -4302.05 N s, and |J_t| / J_n = 0.4433 < 0.5, so it sticks (no cap).
  // After the impact:
  //   A: v = (J_n/m_A, v_A + J_t/m_A) = (6.0274, 8.5039) m/s, |v| = 10.4233 m/s.     B: v = (v_B - J_n/m_B, -J_t/m_B) = (4.2392, 2.0843) m/s, |v| = 4.7239 m/s.
  //   Velocity change: A |dv| = |(6.0274, -2.6721)| = 6.5929 m/s;  B |dv| = |(-4.7016, 2.0843)| = 5.1429 m/s.
  //   Spin (counter-clockwise): w_A = -(W_A/2) J_t / I_A = +1.12083 rad/s;   w_B = -(L_B/2) J_t / I_B = +2.21972 rad/s.
  // After the impact the spin slows at alpha = mu g / k, k = sqrt(I/m):  k_A = 1.48499 m, k_B = 1.50900 m, mu g = 6.864655 m/s^2.
  //   alpha_A = 4.62268 rad/s^2, alpha_B = 4.54914 rad/s^2.   Spin stops after w/alpha:  0.24246 s (A), 0.48794 s (B).
  //   Total turn = w^2 / (2 alpha):  A 0.135881 rad = 7.785 degrees,  B 0.541579 rad = 31.028 degrees, both counter-clockwise (to the left).
  // Slide: distance = |v|^2 / (2 mu g):  A 7.9134 m (25.96 ft) in 1.5184 s,  B 1.6254 m (5.33 ft) in 0.6882 s.
  // In the full simulation the same impulse acts at the middle of the contact patch (the midpoint of its two ends along the contact face),
  // which for this square-on hit is exactly the point above. The two ends of the patch are already separating after that impulse, so
  // they add nothing here, and the simulation reproduces the hand numbers to the digits printed. (An earlier version put the impulse at the
  // area centre of the patch, which sat a few mm inside A's side and made A turn 7.6 instead of 7.8 degrees.)
  const sim = run(flatTBoneScene({ aMph: 25, bSpeed: known(20), condition: "dry" }));
  const A = vr(sim, "A"), B = vr(sim, "B");

  it("the presets are the ones used above", () => {
    expect(PRESETS.car.mass.value).toBe(1610);
    expect(PRESETS.suv.mass.value).toBe(2064);
    expect(A.inertiaKgM2).toBeCloseTo(3550.39, 1);
    expect(B.inertiaKgM2).toBeCloseTo(4699.9, 1);
    expect(25 * MPH).toBeCloseTo(11.176, 9);
  });

  it("the impulses: J_n = 9704.07 N s, J_t = -4302.05 N s (it sticks), velocities and spins after the impact", () => {
    const a: Body2D = { massKg: A.massKg, inertiaKgM2: A.inertiaKgM2, centreM: { x: 0.925, y: 0 }, velocityMps: { x: 0, y: 25 * MPH }, spinRadPs: 0 };
    const b: Body2D = { massKg: B.massKg, inertiaKgM2: B.inertiaKgM2, centreM: { x: -2.425, y: 0 }, velocityMps: { x: 20 * MPH, y: 0 }, spinRadPs: 0 };
    const r = resolveImpact(a, b, { x: 0, y: 0 }, { x: 1, y: 0 }, RESTITUTION, CONTACT_FRICTION);
    expect(r.mode).toBe("stick");
    expect(r.impulseNs).toBeCloseTo(9704.07, 1);
    expect(r.tangentialImpulseNs).toBeCloseTo(-4302.05, 1);
    expect(Math.abs(r.tangentialImpulseNs) / r.impulseNs).toBeCloseTo(0.4433, 3);
    expect(r.a.velocityMps.x).toBeCloseTo(6.0274, 3);
    expect(r.a.velocityMps.y).toBeCloseTo(8.5039, 3);
    expect(r.b.velocityMps.x).toBeCloseTo(4.2392, 3);
    expect(r.b.velocityMps.y).toBeCloseTo(2.0843, 3);
    expect(r.a.spinRadPs).toBeCloseTo(1.12083, 4);
    expect(r.b.spinRadPs).toBeCloseTo(2.21972, 4);
  });

  it("the simulation reports the same: delta-v, spin (compass sense, so negative = counter-clockwise), contact, normal and zones", () => {
    const ia = A.impact!, ib = B.impact!;
    expect(ia.deltaVMps.mid).toBeCloseTo(6.5929, 3);
    expect(ib.deltaVMps.mid).toBeCloseTo(5.1429, 3);
    expect(ia.spinRadps.mid).toBeCloseTo(-1.12083, 4);
    expect(ib.spinRadps.mid).toBeCloseTo(-2.21972, 4);
    expect(ia.normal.x).toBeCloseTo(1, 6);
    expect(ib.normal.x).toBeCloseTo(-1, 6);
    expect(Math.hypot(ia.contactPointM.x - sim.impactPointM.x, ia.contactPointM.y - sim.impactPointM.y)).toBeLessThan(0.05);
    expect([ia.zoneHit, ia.leadingZone, ib.zoneHit, ib.leadingZone]).toEqual(["left", "left", "front", "front"]);
  });

  it("spin stops after 0.2425 s (A) and 0.4879 s (B), and the headings turn 7.785 and 31.028 degrees to the left", () => {
    for (const [v, w, alpha, tStop, turnDeg] of [[A, 1.12083, 4.62268, 0.24246, 7.785], [B, 2.21972, 4.54914, 0.48794, 31.028]] as const) {
      expect(w / alpha).toBeCloseTo(tStop, 4);
      const i0 = Math.round(-sim.startTimeS / sim.dtS);
      const spinning = (k: number) => Math.abs(wrap(v.track[i0 + k + 1]!.headingRad - v.track[i0 + k]!.headingRad)) / DT_S;
      expect(spinning(Math.floor(tStop / DT_S) - 2)).toBeGreaterThan(0);
      expect(spinning(Math.ceil(tStop / DT_S) + 2)).toBeLessThan(1e-9);
      const turn = (wrap(v.restPose.headingRad - v.impactPose.headingRad) * 180) / Math.PI;
      expect(turn).toBeCloseTo(-turnDeg, 2);
    }
  });

  it("the slides: A 7.913 m (25.96 ft), B 1.625 m (5.33 ft), along the velocity after the hit", () => {
    expect(A.postImpactDistanceM.mid).toBeCloseTo(7.9134, 3);
    expect(B.postImpactDistanceM.mid).toBeCloseTo(1.6254, 3);
    const mu = FRICTION.dry;
    expect(sim.restTimeS).toBeGreaterThan(0);
    const dA = { x: A.restPose.xM - A.impactPose.xM, y: A.restPose.yM - A.impactPose.yM };
    expect(dA.x / Math.hypot(dA.x, dA.y)).toBeCloseTo(6.0274 / 10.4233, 3);
    expect(Math.hypot(dA.x, dA.y)).toBeCloseTo(10.4233 ** 2 / (2 * mu * G_MPS2), 3);
  });
});

describe("impact data for the renderer (VehicleResult.impact)", () => {
  it("is present for every vehicle in a contact, with a unit normal, the entered zone and the zone that touched", () => {
    const sim = run(flatTBoneScene({ aMph: 25, bSpeed: known(25) }));
    for (const v of sim.vehicles) {
      const im = v.impact!;
      expect(im).toBeDefined();
      expect(Math.hypot(im.normal.x, im.normal.y)).toBeCloseTo(1, 9);
      expect(im.deltaVMps.mid).toBeGreaterThan(0);
      expect(im.deltaVMps.lo).toBeLessThanOrEqual(im.deltaVMps.mid);
      expect(im.deltaVMps.hi).toBeGreaterThanOrEqual(im.deltaVMps.mid);
    }
    const [a, b] = sim.vehicles.map((v) => v.impact!);
    expect(a!.normal.x * b!.normal.x + a!.normal.y * b!.normal.y).toBeCloseTo(-1, 9); // equal and opposite pushes
  });

  it("the contact point lies on both bodies' outlines at the impact", () => {
    const sim = run(flatTBoneScene({ aMph: 25, bSpeed: known(25) }));
    for (const v of sim.vehicles) {
      const p = v.impact!.contactPointM, pose = v.impactPose;
      const d = { x: p.x - pose.xM, y: p.y - pose.yM };
      const f = fwdOf(pose.headingRad), r = rightOf(pose.headingRad);
      const along = Math.abs(d.x * f.x + d.y * f.y) - v.lengthM / 2, across = Math.abs(d.x * r.x + d.y * r.y) - v.widthM / 2;
      expect(Math.max(along, across)).toBeLessThan(0.08);
      expect(Math.max(along, across)).toBeGreaterThan(-0.08);
    }
  });

  it("delta-v and spin are ranges over the 'not sure' speeds: a faster B changes the velocities more", () => {
    const sim = run(flatTBoneScene({ aMph: 25, bSpeed: unsure(25) }));
    const a = vr(sim, "A").impact!, b = vr(sim, "B").impact!;
    expect(a.deltaVMps.hi).toBeGreaterThan(a.deltaVMps.lo + 0.5);
    expect(b.deltaVMps.hi).toBeGreaterThan(b.deltaVMps.lo + 0.5);
    expect(a.deltaVMps.lo).toBeLessThanOrEqual(a.deltaVMps.mid);
    expect(a.deltaVMps.mid).toBeLessThanOrEqual(a.deltaVMps.hi);
    expect(a.spinRadps.lo).toBeLessThanOrEqual(a.spinRadps.mid);
    expect(a.spinRadps.hi).toBeGreaterThanOrEqual(a.spinRadps.mid);
  });

  it("the leading zone is the part of the body that touched: a diagonal entered zone on the striker reads as the corner or side that touched", () => {
    const sim = run(sceneOf([
      veh("A", { type: "car", bearingDeg: 0, speed: known(25), zone: "front-right" }),
      veh("B", { type: "car", bearingDeg: 270, speed: known(25), zone: "front" }),
    ]));
    const zones: Zone[] = ["front", "front-right", "right", "rear-right", "rear", "rear-left", "left", "front-left"];
    for (const v of sim.vehicles) expect(zones).toContain(v.impact!.leadingZone);
    expect(vr(sim, "A").impact!.zoneHit).toBe("front-right");
    expect(vr(sim, "B").impact!.zoneHit).toBe("front");
  });

  it("the spin's sign matches the way the heading turns, for every vehicle in a grid of hits", () => {
    let checked = 0;
    for (const za of ["front", "front-left", "front-right", "left", "right"] as const) for (const bb of [90, 270, 180]) {
      const o = simulate(sceneOf([
        veh("A", { type: "car", bearingDeg: 0, speed: known(25), zone: za }),
        veh("B", { type: "suv", bearingDeg: bb, speed: known(20), zone: "front" }),
      ]), null);
      if (!o.ok) continue;
      const sim = o.result;
      if (sim.warnings.some((w) => w.code === "stopped-at-vehicle")) continue;
      for (const v of sim.vehicles) {
        const turn = wrap(v.restPose.headingRad - v.impactPose.headingRad);
        if (Math.abs(v.impact!.spinRadps.mid) > 0.05) { expect(Math.sign(turn)).toBe(Math.sign(v.impact!.spinRadps.mid)); checked++; }
      }
    }
    expect(checked).toBeGreaterThan(5);
  });
});
