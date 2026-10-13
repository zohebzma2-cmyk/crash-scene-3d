// simulate(): approach worked out backwards from the impact, planar impulse at t = 0, friction slide to rest.
// Expected values are computed here from the plan's equations and the class presets, never copied from DESIGN.md samples.
// The typed speed is the speed AT the impact. Working backwards, tau = -t seconds before the impact, B = BRAKING_S:
//   v(tau) = v_impact + a * min(tau, B)
//   s(tau) = v_impact * tau + a * min(tau, B)^2 / 2 + a * B * max(0, tau - B)
// with a = 0 for a vehicle that isn't braking (it holds its speed for the whole window).
import { beforeEach, describe, expect, it } from "vitest";
import {
  APPROACH_S, BRAKING_S, CONTACT_FRICTION, DEFAULT_LIMIT_MPH, DT_S, FRICTION, G_MPS2, PHYSICS_VERSION, PRESETS, RANGE_HALF_MPH, RESTITUTION, placeVehicles, poseAt, simulate,
} from "../src";
import type { Pose, RoadNetwork, Scene, SimulationResult, SceneSpeed, VehicleResult } from "../src";
import {
  MAIN, MPH, PARK, angleDiffRad, assertAllFinite, bearingDegOf, buildingProblems, cornersOf, dist, drivableProblems, expectOk, flatRearEndScene, flatTBoneScene,
  highwayRearEndScene, known, overlapDepth, parkingBackingScene, polylineLength, posOf, sceneOf, tBoneScene, unsure, veh,
} from "./physics-helpers";
import { highwayNet, intersectionNet, makeBuilding, parkingLotNet, rect } from "./roads-fixtures";

const run = (scene: Scene, net: RoadNetwork | null = null): SimulationResult => expectOk(simulate(scene, net)).result;
const vr = (sim: SimulationResult, id: string): VehicleResult => sim.vehicles.find((v) => v.id === id)!;
const impactIndex = (sim: SimulationResult) => Math.round(-sim.startTimeS / sim.dtS);
const withSpeed = (scene: Scene, id: string, speed: SceneSpeed): Scene => ({ ...scene, vehicles: scene.vehicles.map((v) => (v.id === id ? { ...v, speed } : v)) });
const close = (a: number, b: number, rel = 1e-9) => Math.abs(a - b) <= rel * Math.max(1, Math.abs(a), Math.abs(b));
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** Speed and distance covered tau seconds BEFORE the impact, for impact speed vi and deceleration a (0 = no braking). */
function approachBackOracle(vi: number, a: number, tau: number): { v: number; s: number } {
  const m = Math.min(tau, BRAKING_S);
  return { v: vi + a * m, s: vi * tau + 0.5 * a * m * m + a * BRAKING_S * Math.max(0, tau - BRAKING_S) };
}

/** 1-D collision along the line of impact, with restitution e. */
function collinear(m1: number, v1: number, m2: number, v2: number, e: number): [number, number] {
  return [(m1 * v1 + m2 * v2 + m2 * e * (v2 - v1)) / (m1 + m2), (m1 * v1 + m2 * v2 + m1 * e * (v1 - v2)) / (m1 + m2)];
}
const slide = (v: number, mu: number) => (v * Math.abs(v)) / (2 * mu * G_MPS2); // signed distance travelled along v

describe("simulate: result shape and time base", () => {
  let sim!: SimulationResult;
  beforeEach(() => { sim = run(flatTBoneScene()); });

  it("stamps the model, friction and restitution", () => {
    expect(sim.physicsVersion).toBe(PHYSICS_VERSION);
    expect(PHYSICS_VERSION).toBe("3.0.0");
    expect(sim.frictionCoefficient).toBe(FRICTION.dry);
    expect(sim.restitution).toBe(RESTITUTION);
    expect(sim.impactTimeS).toBe(0);
    expect(Array.isArray(sim.warnings)).toBe(true);
  });

  it("uses friction 0.7, 0.5, 0.25 and 0.1 for dry, wet, snow and ice", () => {
    for (const [c, mu] of [["dry", 0.7], ["wet", 0.5], ["snow", 0.25], ["ice", 0.1]] as const) {
      expect(run(flatTBoneScene({ condition: c })).frictionCoefficient).toBe(mu);
    }
  });

  it("steps at DT_S from -APPROACH_S to rest, every vehicle on the same clock", () => {
    expect(sim.dtS).toBe(DT_S);
    expect(sim.startTimeS).toBe(-APPROACH_S);
    expect(sim.restTimeS).toBeGreaterThan(0);
    const n = vr(sim, "A").track.length;
    expect(Math.abs(n - 1 - (sim.restTimeS - sim.startTimeS) / sim.dtS)).toBeLessThanOrEqual(1);
    for (const v of sim.vehicles) expect(v.track).toHaveLength(n);
  });

  it("matches the impact and rest poses to the track", () => {
    for (const v of sim.vehicles) {
      const at0 = v.track[impactIndex(sim)]!;
      expect(close(at0.xM, v.impactPose.xM, 1e-6) && close(at0.yM, v.impactPose.yM, 1e-6)).toBe(true);
      expect(angleDiffRad(at0.headingRad, v.impactPose.headingRad)).toBeLessThan(1e-6);
      const last = v.track[v.track.length - 1]!;
      expect(last.xM).toBeCloseTo(v.restPose.xM, 9);
      expect(last.yM).toBeCloseTo(v.restPose.yM, 9);
      expect(angleDiffRad(last.headingRad, v.restPose.headingRad)).toBeLessThan(1e-9);
      expect(v.restPose.speedMps).toBe(0);
    }
  });

  it("reports each vehicle's class mass, size and box inertia from the presets", () => {
    for (const [id, type] of [["A", "car"], ["B", "suv"]] as const) {
      const v = vr(sim, id), p = PRESETS[type];
      expect(v.type).toBe(type);
      expect(v.massKg).toBe(p.mass.value);
      expect(v.lengthM).toBe(p.length.value);
      expect(v.widthM).toBe(p.width.value);
      expect(v.inertiaKgM2).toBeCloseTo((p.mass.value * (p.length.value ** 2 + p.width.value ** 2)) / 12, 6);
    }
  });

  it("keeps every number finite", () => {
    assertAllFinite(sim);
    assertAllFinite(run(tBoneScene({ condition: "ice" }), intersectionNet({ mainLanes: 2 })));
  });

  it("is deterministic: the same input gives a deep-equal output", () => {
    const net = intersectionNet({ mainLanes: 2 });
    const a = simulate(tBoneScene({ bSpeed: unsure(30) }), net);
    const b = simulate(structuredClone(tBoneScene({ bSpeed: unsure(30) })), structuredClone(net));
    expect(a).toEqual(b);
    expect(simulate(flatTBoneScene(), null)).toEqual(simulate(flatTBoneScene(), null));
  });

  it("uses the same placement as placeVehicles, so the mini map and the 3D scene agree", () => {
    const net = intersectionNet({ mainLanes: 2 });
    const scene = tBoneScene();
    const placed = expectOk(placeVehicles(scene, net, { x: 0, y: 0 }));
    const s = run(scene, net);
    expect(s.impactPointM.x).toBeCloseTo(placed.impactPointM.x, 9);
    expect(s.impactPointM.y).toBeCloseTo(placed.impactPointM.y, 9);
    for (const p of placed.vehicles) {
      const v = vr(s, p.id);
      expect(v.impactPose.xM).toBeCloseTo(p.impactPose.xM, 9);
      expect(v.impactPose.yM).toBeCloseTo(p.impactPose.yM, 9);
      expect(angleDiffRad(v.impactPose.headingRad, p.impactPose.headingRad)).toBeLessThan(1e-9);
      expect(v.path).toEqual(p.path);
    }
  });
});

describe("simulate: before impact (constant deceleration, 0 unless braking)", () => {
  it("keeps constant speed on a straight line when nobody brakes", () => {
    const sim = run(flatTBoneScene({ aMph: 25, bSpeed: known(20) }));
    const i0 = impactIndex(sim);
    for (const [id, mph, dir] of [["A", 25, { x: 0, y: 1 }], ["B", 20, { x: 1, y: 0 }]] as const) {
      const v = vr(sim, id), v0 = mph * MPH;
      expect(v.speedAtImpactMps).toEqual({ lo: v0, mid: v0, hi: v0 });
      expect(v.approachDistanceM.mid).toBeCloseTo(v0 * APPROACH_S, 9);
      expect(v.impactPose.speedMps).toBeCloseTo(v0, 9);
      for (let i = 0; i < i0; i++) {
        const t = sim.startTimeS + i * sim.dtS, p = v.track[i]!;
        expect(p.xM).toBeCloseTo(v.impactPose.xM + dir.x * v0 * t, 6);
        expect(p.yM).toBeCloseTo(v.impactPose.yM + dir.y * v0 * t, 6);
        expect(p.speedMps).toBeCloseTo(v0, 9);
      }
    }
  });

  it("faces A north and B east for the whole approach (compass headings)", () => {
    const sim = run(flatTBoneScene());
    const i0 = impactIndex(sim);
    for (let i = 0; i <= i0; i++) {
      expect(angleDiffRad(vr(sim, "A").track[i]!.headingRad, 0)).toBeLessThan(1e-9);
      expect(angleDiffRad(vr(sim, "B").track[i]!.headingRad, Math.PI / 2)).toBeLessThan(1e-9);
    }
  });

  it("brakes into the crash over the last 1.5 s and holds steady before that, and lists the deceleration it used", () => {
    const braking = (condition: "dry" | "ice") => sceneOf([
      veh("A", { type: "car", bearingDeg: 0, speed: known(30), braking: true, zone: "front" }),
      veh("B", { type: "suv", action: "parked", bearingDeg: 0, speed: known(0), zone: "rear" }),
    ], { condition, place: "road" });
    const decelOf = (sim: SimulationResult) => {
      const a = sim.assumptions.find((x) => x.id === "braking-deceleration");
      expect(a, "assumption 'braking-deceleration'").toBeDefined();
      expect(typeof a!.value).toBe("number");
      return a!.value!;
    };
    const dry = run(braking("dry")), ice = run(braking("ice"));
    const a = decelOf(dry);
    expect(a).toBeGreaterThan(0.3 * FRICTION.dry * G_MPS2); // a braking assumption, in the range of a real stop...
    expect(a).toBeLessThanOrEqual(FRICTION.dry * G_MPS2 + 1e-9); // ...never harder than the tires can grip
    expect(decelOf(ice)).toBeLessThan(a); // it follows the road condition
    expect(dry.assumptions.find((x) => x.id === "braking-deceleration")!.unit).toBe("m/s²");

    const vi = 30 * MPH, A = vr(dry, "A"), i0 = impactIndex(dry);
    const yImpact = A.track[i0]!.yM;
    for (let i = 0; i <= i0; i++) {
      const tau = (i0 - i) * dry.dtS, want = approachBackOracle(vi, a, tau);
      expect(A.track[i]!.speedMps).toBeCloseTo(want.v, 9);
      expect(yImpact - A.track[i]!.yM).toBeCloseTo(want.s, 6);
    }
    // The typed speed is the speed at impact, exactly; before the last 1.5 s it holds a steady (higher) speed.
    expect(A.speedAtImpactMps).toEqual({ lo: vi, mid: vi, hi: vi });
    expect(A.impactPose.speedMps).toBe(vi);
    expect(A.track[0]!.speedMps).toBeCloseTo(vi + a * BRAKING_S, 9);
    expect(A.track[Math.round((APPROACH_S - BRAKING_S - 0.5) / dry.dtS)]!.speedMps).toBeCloseTo(vi + a * BRAKING_S, 9);
    expect(A.approachDistanceM.mid).toBeCloseTo(approachBackOracle(vi, a, APPROACH_S).s, 6);
  });

  it("holds a parked vehicle still until it is hit", () => {
    const sim = run(sceneOf([
      veh("A", { type: "car", bearingDeg: 0, speed: known(25), zone: "front" }),
      veh("B", { type: "suv", action: "parked", bearingDeg: 0, speed: known(0), zone: "rear" }),
    ], { place: "road" }));
    const B = vr(sim, "B"), i0 = impactIndex(sim);
    expect(B.path).toBeNull();
    expect(B.approachDistanceM).toEqual({ lo: 0, mid: 0, hi: 0 });
    for (let i = 0; i <= i0; i++) {
      expect(B.track[i]!.xM).toBeCloseTo(B.impactPose.xM, 9);
      expect(B.track[i]!.yM).toBeCloseTo(B.impactPose.yM, 9);
      expect(B.track[i]!.speedMps).toBe(0);
    }
  });

  it("backs a vehicle along the direction opposite to the way it faces", () => {
    const sim = run(parkingBackingScene(), parkingLotNet());
    const B = vr(sim, "B"), i0 = impactIndex(sim);
    const start = posOf(B.track[0]!), end = posOf(B.track[i0]!);
    expect(Math.abs(bearingDegOf(start, end) - 180)).toBeLessThan(1); // moving south...
    expect(dist(start, end)).toBeCloseTo(3 * MPH * APPROACH_S, 6);
    for (let i = 0; i <= i0; i++) expect(angleDiffRad(B.track[i]!.headingRad, 0)).toBeLessThan(1e-9); // ...while facing north
    const A = vr(sim, "A");
    // A goes east along its aisle lane; hit on its side, it eases over to where the contact puts it in the last 20 m.
    expect(Math.abs(bearingDegOf(posOf(A.track[0]!), posOf(A.track[i0]!)) - 90)).toBeLessThan(5);
  });

  it("follows a left turn's path at constant speed, turning only to the left", () => {
    const net = intersectionNet({ parkLanes: 2 });
    const scene = sceneOf([
      veh("A", { type: "car", action: "turn-left", bearingDeg: 0, ...MAIN, speed: known(15), zone: "right" }),
      veh("B", { type: "suv", bearingDeg: 270, ...PARK, speed: known(25), zone: "front" }),
    ]);
    const sim = run(scene, net);
    const A = vr(sim, "A"), i0 = impactIndex(sim);
    const pre = A.track.slice(0, i0 + 1).map(posOf);
    expect(polylineLength(pre)).toBeCloseTo(15 * MPH * APPROACH_S, 1);
    let turned = 0;
    for (let i = 1; i <= i0; i++) {
      const d = wrap(A.track[i]!.headingRad - A.track[i - 1]!.headingRad);
      // Compass heading only decreases on a left turn (a hair either way where it eases to its place at the impact).
      expect(d).toBeLessThanOrEqual(0.01);
      turned += d;
    }
    expect(turned).toBeLessThanOrEqual(0);
  });
});

describe("simulate: impact (planar impulse, restitution 0.2, contact friction 0.5)", () => {
  it("T-bone: the struck car is slowed (tangential impulse v_t / K_tt), the striking car is dragged along, and both turn", () => {
    for (const condition of ["dry", "wet"] as const) {
      const mu = FRICTION[condition];
      for (const bMph of [20, 25, 30]) {
        const sim = run(flatTBoneScene({ aMph: 25, bSpeed: known(bMph), condition }));
        const A = vr(sim, "A"), B = vr(sim, "B");
        const car = PRESETS.car, suv = PRESETS.suv;
        const mA = car.mass.value, mB = suv.mass.value;
        const LA = car.length.value, WA = car.width.value, LB = suv.length.value, WB = suv.width.value;
        const IA = (mA * (LA * LA + WA * WA)) / 12, IB = (mB * (LB * LB + WB * WB)) / 12;
        const vA = 25 * MPH, vB = bMph * MPH;
        // Contact at the middle of A's left side and the middle of B's front: the normal is east, through both centres, so
        // only the tangential impulse has a lever arm (half of A's width on A, half of B's length on B).
        const ktt = 1 / mA + 1 / mB + (WA / 2) ** 2 / IA + (LB / 2) ** 2 / IB;
        const jn = ((1 + RESTITUTION) * vB) / (1 / mA + 1 / mB);
        const jt = -vA / ktt; // the sticking impulse: A's side stops sliding past B's nose
        expect(Math.abs(jt), "sticks, not capped").toBeLessThan(0.5 * jn);
        const vAfterA = { x: jn / mA, y: vA + jt / mA }, vAfterB = { x: vB - jn / mB, y: -jt / mB };
        expect(vAfterA.y, "A's own forward speed is cut").toBeLessThan(vA);
        expect(vAfterB.y, "B gains a component along A's travel").toBeGreaterThan(0);
        const want = {
          A: { x: (vAfterA.x * Math.hypot(vAfterA.x, vAfterA.y)) / (2 * mu * G_MPS2), y: (vAfterA.y * Math.hypot(vAfterA.x, vAfterA.y)) / (2 * mu * G_MPS2) },
          B: { x: (vAfterB.x * Math.hypot(vAfterB.x, vAfterB.y)) / (2 * mu * G_MPS2), y: (vAfterB.y * Math.hypot(vAfterB.x, vAfterB.y)) / (2 * mu * G_MPS2) },
        };
        const tol = (x: number) => 0.02 + 0.01 * Math.abs(x);
        const dA = { x: A.restPose.xM - A.impactPose.xM, y: A.restPose.yM - A.impactPose.yM };
        const dB = { x: B.restPose.xM - B.impactPose.xM, y: B.restPose.yM - B.impactPose.yM };
        const tag = `${condition} B ${bMph}`;
        expect(Math.abs(dA.x - want.A.x), `${tag} A east`).toBeLessThan(tol(want.A.x));
        expect(Math.abs(dA.y - want.A.y), `${tag} A north`).toBeLessThan(tol(want.A.y));
        expect(Math.abs(dB.x - want.B.x), `${tag} B east`).toBeLessThan(tol(want.B.x));
        expect(Math.abs(dB.y - want.B.y), `${tag} B north`).toBeLessThan(tol(want.B.y));
        // Spin from the tangential impulse, then the constant-rate decay in the slide: total turn = spin^2 * r_gyration / (2 mu g).
        // Positive spin is counter-clockwise, which lowers the compass heading: both are dragged toward the north, so both turn left.
        const spinA = (-(WA / 2) * jt) / IA, spinB = (-(LB / 2) * jt) / IB;
        const turn = (spin: number, m: number, inertia: number) => -Math.sign(spin) * ((spin * spin) * Math.sqrt(inertia / m)) / (2 * mu * G_MPS2);
        const headingTurn = (v: VehicleResult) => wrap(v.restPose.headingRad - v.impactPose.headingRad);
        expect(Math.abs(headingTurn(A) - turn(spinA, mA, IA)), `${tag} A turn`).toBeLessThan(0.01);
        expect(Math.abs(headingTurn(B) - turn(spinB, mB, IB)), `${tag} B turn`).toBeLessThan(0.01);
        expect(headingTurn(A)).toBeLessThan(-0.05);
        expect(headingTurn(B)).toBeLessThan(-0.2);
      }
    }
  });

  it("T-bone golden (dry, A 25 mph, B 25 mph): A slides about 9.40 m (30.8 ft), B about 2.36 m (7.7 ft), turning about 8 and 31 degrees", () => {
    const sim = run(flatTBoneScene({ aMph: 25, bSpeed: known(25), condition: "dry" }));
    expect(Math.abs(vr(sim, "A").postImpactDistanceM.mid - 9.40)).toBeLessThan(0.05);
    expect(Math.abs(vr(sim, "B").postImpactDistanceM.mid - 2.36)).toBeLessThan(0.05);
    const deg = (v: VehicleResult) => Math.abs((wrap(v.restPose.headingRad - v.impactPose.headingRad) * 180) / Math.PI);
    expect(Math.abs(deg(vr(sim, "A")) - 8)).toBeLessThan(1);
    expect(Math.abs(deg(vr(sim, "B")) - 31)).toBeLessThan(1.5);
  });

  it("T-bone with B 'not sure' at a 25 mph limit: A slides 26.0 to 36.8 ft and B 5.3 to 10.7 ft across 20 to 30 mph", () => {
    const sim = run(flatTBoneScene({ aMph: 25, bSpeed: unsure(25), condition: "dry" }));
    const ft = 0.3048;
    const A = vr(sim, "A").postImpactDistanceM, B = vr(sim, "B").postImpactDistanceM;
    expect(Math.abs(A.lo / ft - 26.0)).toBeLessThan(0.15);
    expect(Math.abs(A.hi / ft - 36.8)).toBeLessThan(0.15);
    expect(Math.abs(B.lo / ft - 5.3)).toBeLessThan(0.15);
    expect(Math.abs(B.hi / ft - 10.7)).toBeLessThan(0.15);
  });

  it("rear-end: the follower slows, the leader speeds up, by the 1-D collision with e = 0.2", () => {
    const mu = FRICTION.wet;
    const sim = run(flatRearEndScene({ leaderMph: 15, followerMph: 50, condition: "wet" }));
    const A = vr(sim, "A"), B = vr(sim, "B");
    const mA = PRESETS.suv.mass.value, mB = PRESETS.pickup.mass.value;
    const [a1, b1] = collinear(mA, 15 * MPH, mB, 50 * MPH, RESTITUTION);
    expect(b1).toBeGreaterThan(0);
    expect(a1).toBeGreaterThan(15 * MPH);
    const dA = A.restPose.yM - A.impactPose.yM, dB = B.restPose.yM - B.impactPose.yM;
    expect(Math.abs(dA - slide(a1, mu))).toBeLessThan(0.02 + 0.01 * Math.abs(slide(a1, mu)));
    expect(Math.abs(dB - slide(b1, mu))).toBeLessThan(0.02 + 0.01 * Math.abs(slide(b1, mu)));
    expect(Math.abs(A.restPose.xM - A.impactPose.xM)).toBeLessThan(1e-6);
    // Speeds just after the impact step: the leader is faster than before, the follower slower.
    const i0 = impactIndex(sim);
    expect(A.track[i0 + 1]!.speedMps).toBeGreaterThan(A.impactPose.speedMps);
    expect(B.track[i0 + 1]!.speedMps).toBeLessThan(B.impactPose.speedMps);
  });

  it("runs a rear-end on the highway lane, and both vehicles stay in it", () => {
    const sim = run(highwayRearEndScene(), highwayNet());
    for (const id of ["A", "B"]) {
      for (const p of vr(sim, id).track) expect(p.xM).toBeCloseTo(-10, 6);
    }
  });
});

describe("simulate: after impact (friction slide, yaw decay, rest)", () => {
  it("slides ice farther than snow, wet and dry, in the ratio of the friction coefficients", () => {
    const base = run(flatTBoneScene({ condition: "dry" }));
    for (const c of ["wet", "snow", "ice"] as const) {
      const s = run(flatTBoneScene({ condition: c }));
      for (const id of ["A", "B"]) {
        const dry = vr(base, id).postImpactDistanceM.mid * FRICTION.dry;
        const d = vr(s, id).postImpactDistanceM.mid * FRICTION[c];
        expect(Math.abs(d - dry) / dry, `${c} ${id}`).toBeLessThan(0.01);
      }
      expect(s.restTimeS).toBeGreaterThan(base.restTimeS);
    }
  });

  it("slows monotonically after impact and comes to rest and stays there", () => {
    const sim = run(flatTBoneScene());
    const i0 = impactIndex(sim);
    for (const v of sim.vehicles) {
      for (let i = i0 + 1; i + 1 < v.track.length; i++) expect(v.track[i + 1]!.speedMps).toBeLessThanOrEqual(v.track[i]!.speedMps + 1e-9);
      const n = v.track.length;
      expect(v.track[n - 1]!.speedMps).toBe(0);
      for (const k of [2, 3]) {
        expect(v.track[n - k]!.xM).toBeCloseTo(v.track[n - 1]!.xM, 9);
        expect(v.track[n - k]!.yM).toBeCloseTo(v.track[n - 1]!.yM, 9);
        expect(angleDiffRad(v.track[n - k]!.headingRad, v.track[n - 1]!.headingRad)).toBeLessThan(1e-9);
      }
    }
  });

  it("reports the distance moved after impact consistent with the track, and the last vehicle to stop sets the rest time", () => {
    const sim = run(flatRearEndScene({ condition: "wet" }));
    for (const v of sim.vehicles) {
      expect(v.postImpactDistanceM.mid).toBeCloseTo(dist(posOf(v.impactPose), posOf(v.restPose)), 3);
    }
    const stops = sim.vehicles.map((v) => {
      let k = v.track.length - 1;
      while (k > 0 && v.track[k - 1]!.speedMps === 0) k--;
      return sim.startTimeS + k * sim.dtS;
    });
    expect(Math.abs(sim.restTimeS - Math.max(...stops))).toBeLessThanOrEqual(3 * sim.dtS); // the track keeps two samples at rest after the last vehicle stops
  });

  it("measures the gap at rest centre to centre, with exactly one entry (A-B) for two vehicles", () => {
    const sim = run(flatTBoneScene());
    expect(sim.gaps).toHaveLength(1);
    const g = sim.gaps[0]!;
    expect([g.a, g.b]).toEqual(["A", "B"]);
    expect(g.restGapM.mid).toBeCloseTo(dist(posOf(vr(sim, "A").restPose), posOf(vr(sim, "B").restPose)), 9);
    expect(g.restGapM.lo).toBeLessThanOrEqual(g.restGapM.mid);
    expect(g.restGapM.hi).toBeGreaterThanOrEqual(g.restGapM.mid);
  });
});

describe("simulate: 'not sure' speeds", () => {
  const base = flatTBoneScene({ aMph: 25 });

  it("runs the posted limit minus 5, the limit, and the limit plus 5", () => {
    const sim = run(withSpeed(base, "B", unsure(30)));
    const b = vr(sim, "B").speedAtImpactMps;
    expect(b.lo).toBeCloseTo((30 - RANGE_HALF_MPH) * MPH, 9);
    expect(b.mid).toBeCloseTo(30 * MPH, 9);
    expect(b.hi).toBeCloseTo((30 + RANGE_HALF_MPH) * MPH, 9);
  });

  it("assumes a 25 mph limit when the claimant doesn't know it", () => {
    const b = vr(run(withSpeed(base, "B", unsure(null))), "B").speedAtImpactMps;
    expect(b.lo).toBeCloseTo((DEFAULT_LIMIT_MPH - 5) * MPH, 9);
    expect(b.mid).toBeCloseTo(DEFAULT_LIMIT_MPH * MPH, 9);
    expect(b.hi).toBeCloseTo((DEFAULT_LIMIT_MPH + 5) * MPH, 9);
  });

  it("never runs a negative speed, and drops the speeds where B wouldn't reach A (a stopped B can't hit A's side)", () => {
    const sim = run(withSpeed(base, "B", unsure(5)));
    const b = vr(sim, "B").speedAtImpactMps;
    expect(b.lo).toBeGreaterThan(0); // 0 mph is not workable, so the range starts at the first speed that is
    expect(b.lo).toBeCloseTo(0.5 * MPH, 9);
    expect(b.mid).toBeCloseTo(5 * MPH, 9);
    expect(b.hi).toBeCloseTo(10 * MPH, 9);
    expect(sim.warnings.some((w) => w.code === "range-start")).toBe(true);
  });

  it("gives lo = mid = hi for a known speed", () => {
    for (const v of run(base).vehicles) {
      expect(v.speedAtImpactMps.lo).toBe(v.speedAtImpactMps.mid);
      expect(v.speedAtImpactMps.hi).toBe(v.speedAtImpactMps.mid);
      expect(v.postImpactDistanceM.lo).toBeCloseTo(v.postImpactDistanceM.hi, 12);
    }
  });

  it("returns the min and max over the three runs for every range, and the picture plays the middle run", () => {
    const sim = run(withSpeed(base, "B", unsure(30)));
    const runs = [25, 30, 35].map((mph) => run(withSpeed(base, "B", known(mph))));
    const mid = runs[1]!;
    for (const id of ["A", "B"]) {
      for (const field of ["speedAtImpactMps", "approachDistanceM", "postImpactDistanceM"] as const) {
        const xs = runs.map((r) => vr(r, id)[field].mid);
        const got = vr(sim, id)[field];
        expect(close(got.lo, Math.min(...xs)), `${id}.${field}.lo`).toBe(true);
        expect(close(got.hi, Math.max(...xs)), `${id}.${field}.hi`).toBe(true);
        expect(close(got.mid, vr(mid, id)[field].mid), `${id}.${field}.mid`).toBe(true);
      }
      expect(vr(sim, id).track).toEqual(vr(mid, id).track);
      expect(vr(sim, id).restPose).toEqual(vr(mid, id).restPose);
    }
    const gaps = runs.map((r) => r.gaps[0]!.restGapM.mid);
    expect(close(sim.gaps[0]!.restGapM.lo, Math.min(...gaps))).toBe(true);
    expect(close(sim.gaps[0]!.restGapM.hi, Math.max(...gaps))).toBe(true);
    expect(close(sim.gaps[0]!.restGapM.mid, gaps[1]!)).toBe(true);
    expect(sim.restTimeS).toBeCloseTo(mid.restTimeS, 9);
  });

  it("runs all 'not sure' vehicles together at low, middle and high (as the prototype did)", () => {
    const both = withSpeed(withSpeed(base, "A", unsure(25)), "B", unsure(30));
    const sim = run(both);
    const runs = [[20, 25], [25, 30], [30, 35]].map(([a, b]) => run(withSpeed(withSpeed(base, "A", known(a!)), "B", known(b!))));
    for (const id of ["A", "B"]) {
      const xs = runs.map((r) => vr(r, id).postImpactDistanceM.mid);
      expect(close(vr(sim, id).postImpactDistanceM.lo, Math.min(...xs))).toBe(true);
      expect(close(vr(sim, id).postImpactDistanceM.hi, Math.max(...xs))).toBe(true);
    }
  });
});

describe("simulate: no overlap before impact", () => {
  const tol = 0.05;
  const lotScene = parkingBackingScene();
  const cases: Array<[string, Scene, RoadNetwork | null]> = [
    ["flat T-bone", flatTBoneScene(), null],
    ["flat rear-end", flatRearEndScene(), null],
    ["T-bone on a 4-way", tBoneScene(), intersectionNet({ mainLanes: 2 })],
    ["T-bone, one-way cross street", sceneOf([
      veh("A", { type: "car", bearingDeg: 0, ...MAIN, zone: "right" }), veh("B", { type: "suv", bearingDeg: 270, ...PARK, zone: "front" }),
    ]), intersectionNet({ parkOneWay: true })],
    ["rear-end on the highway", highwayRearEndScene({ braking: true }), highwayNet()],
    ["parking lot backing", lotScene, parkingLotNet()],
  ];

  for (const [name, scene, net] of cases) {
    it(`${name}: no pair of bodies overlaps by more than 5 cm at any step before t = 0`, () => {
      const sim = run(scene, net);
      const i0 = impactIndex(sim);
      let worst = -Infinity;
      for (let i = 0; i < i0; i++) {
        for (let a = 0; a < sim.vehicles.length; a++) {
          for (let b = a + 1; b < sim.vehicles.length; b++) {
            const va = sim.vehicles[a]!, vb = sim.vehicles[b]!;
            worst = Math.max(worst, overlapDepth(cornersOf(va.track[i]!, va.lengthM, va.widthM), cornersOf(vb.track[i]!, vb.lengthM, vb.widthM)));
          }
        }
      }
      expect(worst).toBeLessThanOrEqual(tol);
    });
  }

  it("explains a rear-end where the leader is faster than the follower: A would have passed through B", () => {
    const scene = sceneOf([
      veh("A", { type: "suv", bearingDeg: 0, speed: known(40), zone: "rear" }),
      veh("B", { type: "pickup", bearingDeg: 0, speed: known(20), zone: "front" }),
    ], { place: "road" });
    const r = simulate(scene, null);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.length).toBeGreaterThan(0);
      const e = r.errors[0]!;
      expect(e.code.length).toBeGreaterThan(0);
      expect([...e.vehicleIds].sort()).toEqual(["A", "B"]);
      expect(e.text).toMatch(/\bA\b/);
      expect(e.text).toMatch(/\bB\b/);
      expect(e.text).toMatch(/before/i);
      expect(e.text).not.toMatch(/undefined|NaN|not implemented/i);
    }
  });

  it("refuses a scene where a vehicle would have driven through a building", () => {
    // A building across Main Street's northbound lanes, 18 to 32 m south of the junction: A passes through it on the way in.
    const net = intersectionNet({ mainLanes: 2, extraBuildings: [makeBuilding("wall", rect(0, -32, 8, -18))] });
    const r = simulate(tBoneScene(), net);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.vehicleIds.includes("A") && /building/i.test(e.text) && /\bA\b/.test(e.text))).toBe(true);
    }
  });

  it("treats a building footprint the same whether or not its ring repeats the first point", () => {
    const ring = rect(0, -32, 8, -18);
    for (const footprint of [ring, [...ring, ring[0]!]]) {
      const net = intersectionNet({ mainLanes: 2, extraBuildings: [makeBuilding("wall", footprint)] });
      const r = simulate(tBoneScene(), net);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.some((e) => /building/i.test(e.text))).toBe(true);
    }
  });

  it("keeps every vehicle's body on the road width (30 cm slack) or inside the parking lot, up to the impact", () => {
    for (const [name, scene, net] of cases) {
      if (!net) continue;
      const sim = run(scene, net);
      const i0 = impactIndex(sim);
      const poses = sim.vehicles.flatMap((v) => v.track.slice(0, i0 + 1).filter((_, i) => i % 4 === 0).map((pose, i) => ({ id: `${name} ${v.id}@${i}`, pose, type: v.type })));
      expect(drivableProblems(net, poses)).toEqual([]);
    }
  });

  it("keeps every vehicle off every building footprint for the whole run in ordinary scenes", () => {
    for (const [name, scene, net] of cases) {
      if (!net) continue;
      const sim = run(scene, net);
      const poses: Array<{ id: string; pose: Pose; type: (typeof sim.vehicles)[number]["type"] }> = [];
      for (const v of sim.vehicles) {
        for (let i = 0; i < v.track.length; i += 6) poses.push({ id: `${name} ${v.id}@${i}`, pose: v.track[i]!, type: v.type });
        poses.push({ id: `${name} ${v.id}@rest`, pose: v.restPose, type: v.type });
      }
      expect(buildingProblems(net, poses)).toEqual([]);
    }
  });
});

describe("simulate: assumptions are listed with their numbers and sources", () => {
  const scene = sceneOf([
    veh("A", { type: "car", bearingDeg: 0, speed: known(20), braking: true, zone: "left" }),
    veh("B", { type: "suv", bearingDeg: 90, speed: unsure(null), zone: "front" }),
  ], { condition: "wet" });
  let sim!: SimulationResult;
  beforeEach(() => { sim = run(scene); });
  const byId = (id: string) => sim.assumptions.find((a) => a.id === id);

  it("has unique ids and plain text for each", () => {
    const ids = sim.assumptions.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const a of sim.assumptions) expect(a.text.trim().length).toBeGreaterThan(10);
  });

  it("rigid-bodies says the motion treats vehicles as rigid, and the dents are explained separately (damage-illustrated) once a hit is above 3 mph", () => {
    const text = (s: SimulationResult, id: string) => s.assumptions.find((a) => a.id === id)?.text;
    expect(text(sim, "rigid-bodies")).toBe("For the motion, vehicles are rigid bodies of typical weight for their type that don't tip over or break apart.");
    expect(text(sim, "rigid-bodies")).not.toMatch(/crumple/);
    const hard = run(flatTBoneScene({ aMph: 25, bSpeed: known(25) }));
    expect(hard.vehicles.every((v) => v.impact!.deltaVMps.mid / 0.44704 > 3)).toBe(true);
    expect(text(hard, "damage-illustrated")).toBe("The dents show roughly where and how hard each vehicle was hit. They are drawn for illustration only and don't change the motion.");
    // A 1 mph tap: nobody's speed changes by 3 mph, so there are no dents to explain.
    const tap = run(flatRearEndScene({ leaderMph: 24, followerMph: 25 }));
    expect(tap.vehicles.every((v) => v.impact!.deltaVMps.mid / 0.44704 <= 3)).toBe(true);
    expect(text(tap, "damage-illustrated")).toBeUndefined();
  });

  it("lists friction, restitution, braking deceleration, inertia, flat ground, rigid bodies, step and window", () => {
    for (const id of ["friction", "restitution", "braking-deceleration", "inertia", "flat-ground", "rigid-bodies", "time-step", "entered-speed"]) {
      expect(byId(id), id).toBeDefined();
    }
    expect(byId("friction")!.value).toBe(FRICTION.wet);
    expect(byId("friction")!.text).toMatch(/wet/i);
    expect(byId("restitution")!.value).toBe(RESTITUTION);
    // Collision friction: the sentence gives its value, and says the hit can slow the struck vehicle and turn both.
    expect(byId("restitution")!.text).toContain(`friction of ${CONTACT_FRICTION}`);
    expect(CONTACT_FRICTION).toBe(0.5);
    expect(byId("restitution")!.text).toMatch(/which can slow a vehicle hit on its side and turn both vehicles/);
    expect(byId("restitution")!.text).not.toMatch(/the struck vehicle is slowed/);
    expect(byId("restitution")!.text).not.toMatch(/no sideways force/);
    // After the crash each vehicle is treated as skidding (the simple option), and the text says so.
    expect(byId("post-impact-slide")!.text).toMatch(/is treated as skidding/);
    expect(byId("time-step")!.value).toBeCloseTo(DT_S, 12);
    // The window is folded into the speeds sentence.
    expect(byId("entered-speed")!.value).toBe(APPROACH_S);
    expect(byId("entered-speed")!.unit).toBe("s");
    expect(byId("entered-speed")!.text).toBe("Speed at impact, as entered, and directions as entered. The picture works backwards from the impact for the 5 seconds before it.");
    expect(sim.assumptions.find((a) => a.id === "approach-window")).toBeUndefined();
    expect(byId("braking-deceleration")!.unit).toBe("m/s²");
    expect(byId("inertia")!.text).toMatch(/box|rectang/i);
  });

  it("lists each vehicle's class-average mass with its preset source", () => {
    expect(byId("mass-A")!.value).toBe(PRESETS.car.mass.value);
    expect(byId("mass-A")!.unit).toBe("kg");
    // Same report and figure as the preset, in the PDF's plain wording: "about" for the approx sign; the chart note stays as one short clause.
    expect(byId("mass-A")!.source).toContain("EPA Automotive Trends Report 2025 (EPA-420-R-26-001), Fig. 3.6");
    expect(byId("mass-A")!.source).toContain("model year 2024 class average, ±100 lb, read from chart: sedan/wagon about 3,550 lb");
    expect(byId("mass-A")!.source).not.toMatch(/≈/);
    expect(byId("mass-A")!.text).toMatch(/of 1,610 kg \(3,550 lb\), a class average\. Source:/);
    expect(byId("mass-A")!.text).toContain(`Source: ${byId("mass-A")!.source}.`);
    expect(byId("mass-B")!.value).toBe(PRESETS.suv.mass.value);
    expect(byId("mass-B")!.source).toContain("truck SUV about 4,550 lb");
  });

  it("has one sentence for the 'not sure' range and the assumed limit, and only when they were used", () => {
    const range = byId("speed-range")!;
    expect(range.value).toBe(RANGE_HALF_MPH);
    expect(range.unit).toBe("mph");
    expect(range.text).toContain(`around ${DEFAULT_LIMIT_MPH} mph, a typical city limit, if it isn't known`);
    expect(range.text).toContain(`${RANGE_HALF_MPH} mph below to ${RANGE_HALF_MPH} mph above it`);
    expect(sim.assumptions.find((a) => a.id === "default-limit")).toBeUndefined();
    const plain = run(flatTBoneScene());
    expect(plain.assumptions.find((a) => a.id === "speed-range")).toBeUndefined();
    const withLimit = run(withSpeed(flatTBoneScene(), "B", unsure(30)));
    const given = withLimit.assumptions.find((a) => a.id === "speed-range")!;
    expect(given.text).not.toMatch(/city limit/); // the limit was given, so there is no assumed one to mention
    expect(given.text).toContain(`${RANGE_HALF_MPH} mph below to ${RANGE_HALF_MPH} mph above it`);
  });
});

describe("poseAt on a real result", () => {
  let sim!: SimulationResult;
  let A!: VehicleResult;
  beforeEach(() => { sim = run(flatTBoneScene()); A = vr(sim, "A"); });

  it("returns the impact pose at t = 0 and the first and last samples at the ends", () => {
    const p = poseAt(sim, A, 0);
    expect(p.xM).toBeCloseTo(A.impactPose.xM, 9);
    expect(p.yM).toBeCloseTo(A.impactPose.yM, 9);
    expect(poseAt(sim, A, sim.startTimeS)).toEqual(A.track[0]);
    expect(poseAt(sim, A, sim.restTimeS).xM).toBeCloseTo(A.restPose.xM, 9);
  });

  it("clamps outside the time range", () => {
    expect(poseAt(sim, A, sim.startTimeS - 10)).toEqual(A.track[0]);
    expect(poseAt(sim, A, sim.restTimeS + 10)).toEqual(A.track[A.track.length - 1]);
  });

  it("is between neighbouring samples in between", () => {
    const t = sim.startTimeS + 10.5 * sim.dtS;
    const p = poseAt(sim, A, t), a = A.track[10]!, b = A.track[11]!;
    expect(p.yM).toBeCloseTo((a.yM + b.yM) / 2, 9);
    expect(dist(posOf(p), posOf(a))).toBeCloseTo(dist(posOf(a), posOf(b)) / 2, 9);
  });
});
