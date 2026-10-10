// Three and four vehicles: contacts, momentum, gaps, determinism.
// Each vehicle's marked zone touches the nearest other vehicle that can hit it, at the point where they meet at t = 0.
// A vehicle whose zone is already taken by another contact touches its partner with the face that points at it.
import { describe, expect, it } from "vitest";
import { APPROACH_S, CONTACT_FRICTION, DT_S, FRICTION, IMPACT_PASSES, RESTITUTION, simulate } from "../src";
import type { Scene, SimulationResult, Vec2, VehicleResult } from "../src";
import { resolveContacts } from "../src";
import { placeDetailed } from "../src/physics/placement";
import { impactInput } from "../src/physics/simulate";
import { speedCases } from "../src/physics/model";
import {
  HWY, MAIN, PARK, assertAllFinite, buildingProblems, cornersOf, dimsOf, dist, expectOk, overlapDepth, posOf, sceneOf, known, veh, zoneAnchor,
} from "./physics-helpers";
import { highwayNet, intersectionNet } from "./roads-fixtures";

const PIN: Vec2 = { x: 0, y: 0 };

/** A leader, B in the middle (hit in the rear by C, and hitting A), C the follower. All in the middle highway lane. */
function chainScene(): Scene {
  return sceneOf([
    veh("A", { type: "suv", bearingDeg: 0, ...HWY, lane: 1, speed: known(20), zone: "rear" }),
    veh("B", { type: "car", bearingDeg: 0, ...HWY, lane: 1, speed: known(35), zone: "rear" }),
    veh("C", { type: "pickup", bearingDeg: 0, ...HWY, lane: 1, speed: known(50), zone: "front" }),
  ], { place: "road", condition: "dry" });
}

/**
 * Two T-bones in the same 4-way, equal speeds:
 * B (eastbound) hits A (northbound) on its left; D (westbound) hits C (southbound) on its left.
 */
function fourWayScene(): Scene {
  return sceneOf([
    veh("A", { type: "car", bearingDeg: 0, ...MAIN, speed: known(25), zone: "left" }),
    veh("B", { type: "suv", bearingDeg: 90, ...PARK, speed: known(25), zone: "front" }),
    veh("C", { type: "car", bearingDeg: 180, ...MAIN, speed: known(25), zone: "left" }),
    veh("D", { type: "suv", bearingDeg: 270, ...PARK, speed: known(25), zone: "front" }),
  ]);
}

const pairKeys = (cs: ReadonlyArray<{ a: string; b: string }>) => cs.map((c) => [c.a, c.b].sort().join("")).sort();
const vr = (sim: SimulationResult, id: string): VehicleResult => sim.vehicles.find((v) => v.id === id)!;
const run = (scene: Scene, net = intersectionNet()): SimulationResult => expectOk(simulate(scene, net)).result;

describe("three vehicles: a rear-end chain", () => {
  const net = highwayNet();

  it("touches A-B and B-C only, bodies end to end in one lane", () => {
    const placed = expectOk(placeDetailed(chainScene(), net, PIN)).value;
    expect(pairKeys(placed.contacts)).toEqual(["AB", "BC"]);
    const [a, b, c] = placed.bodies;
    expect(a!.centre.x).toBeCloseTo(-10, 6);
    expect(b!.centre.x).toBeCloseTo(-10, 6);
    expect(c!.centre.x).toBeCloseTo(-10, 6);
    expect(a!.centre.y).toBeGreaterThan(b!.centre.y);
    expect(b!.centre.y).toBeGreaterThan(c!.centre.y);
    const box = (p: typeof a) => cornersOf({ xM: p!.centre.x, yM: p!.centre.y, headingRad: p!.headingRad, speedMps: 0 }, p!.dims.lengthM, p!.dims.widthM);
    expect(Math.abs(overlapDepth(box(a), box(b)))).toBeLessThanOrEqual(0.05); // touching
    expect(Math.abs(overlapDepth(box(b), box(c)))).toBeLessThanOrEqual(0.05);
    expect(overlapDepth(box(a), box(c))).toBeLessThan(-0.5); // A and C don't touch
    // The marked zones that are used sit on the contact points: A's rear on the pin's projection, C's front on B's rear.
    const A = posOf({ xM: a!.centre.x, yM: a!.centre.y, headingRad: a!.headingRad, speedMps: 0 });
    expect(dist(zoneAnchor({ xM: A.x, yM: A.y, headingRad: a!.headingRad, speedMps: 0 }, a!.dims.lengthM, a!.dims.widthM, "rear"), placed.impactPointM)).toBeLessThan(0.1);
    expect(placed.impactPointM.x).toBeCloseTo(-10, 6);
    expect(placed.impactPointM.y).toBeCloseTo(0, 6);
  });

  it("simulates, lists only the touching pairs as gaps, and never overlaps before impact", () => {
    const sim = run(chainScene(), net);
    expect(sim.gaps.map((g) => `${g.a}${g.b}`)).toEqual(["AB", "BC"]); // not AC
    for (const g of sim.gaps) {
      const a = vr(sim, g.a).restPose, b = vr(sim, g.b).restPose;
      expect(g.restGapM.mid).toBeCloseTo(dist(posOf(a), posOf(b)), 9);
    }
    const i0 = Math.round(-sim.startTimeS / sim.dtS);
    for (let i = 0; i < i0; i++) {
      for (const [p, q] of [["A", "B"], ["B", "C"], ["A", "C"]] as const) {
        const a = vr(sim, p), b = vr(sim, q);
        expect(overlapDepth(cornersOf(a.track[i]!, a.lengthM, a.widthM), cornersOf(b.track[i]!, b.lengthM, b.widthM))).toBeLessThanOrEqual(0.05);
      }
    }
    assertAllFinite(sim);
    expect(sim.assumptions.some((x) => x.id === "multi-impact")).toBe(true);
  });

  it("is deterministic", () => {
    expect(simulate(chainScene(), net)).toEqual(simulate(chainScene(), net));
  });

  it("conserves total linear and angular momentum through the pairwise impulses (1e-6), over any number of passes", () => {
    const placed = expectOk(placeDetailed(chainScene(), net, PIN)).value;
    const { before, specs } = impactInput(placed.bodies, placed.contacts, placed.bodies.map((b) => speedCases(b.veh).mid), FRICTION.dry);
    for (const contactFriction of [0, CONTACT_FRICTION]) {
      for (const passes of [1, IMPACT_PASSES, 9]) {
        const after = resolveContacts(before, specs, RESTITUTION, passes, contactFriction);
        expectConserved(before, after);
      }
    }
  });

  it("leaves no contact still closing after the passes", () => {
    const placed = expectOk(placeDetailed(chainScene(), net, PIN)).value;
    const { before, specs } = impactInput(placed.bodies, placed.contacts, placed.bodies.map((b) => speedCases(b.veh).mid), FRICTION.dry);
    const after = resolveContacts(before, specs, RESTITUTION, IMPACT_PASSES);
    for (const c of specs) {
      const a = after[c.ia]!, b = after[c.ib]!;
      const vr = { x: a.velocityMps.x - b.velocityMps.x, y: a.velocityMps.y - b.velocityMps.y };
      expect(vr.x * c.normal.x + vr.y * c.normal.y).toBeGreaterThan(-0.05);
    }
  });

  it("agrees with the track: linear momentum just after the impact matches just before (2%, the slide has barely started)", () => {
    const sim = run(chainScene(), net);
    const i0 = Math.round(-sim.startTimeS / sim.dtS);
    let before = 0, after = 0;
    for (const v of sim.vehicles) {
      before += v.massKg * v.impactPose.speedMps;
      after += (v.massKg * (v.track[i0 + 1]!.yM - v.track[i0]!.yM)) / DT_S;
    }
    expect(Math.abs(after - before) / before).toBeLessThan(0.02);
  });
});

describe("four vehicles: two T-bones in one intersection", () => {
  const net = intersectionNet();

  it("pairs A with B and C with D, each at its own crossing, and nothing overlaps at t = 0", () => {
    const placed = expectOk(placeDetailed(fourWayScene(), net, PIN)).value;
    expect(pairKeys(placed.contacts)).toEqual(["AB", "CD"]);
    expect(dist(placed.impactPointM, { x: 1.75, y: -1.75 })).toBeLessThan(0.05); // the first contact is the A-B one
    const byId = new Map<string, (typeof placed.bodies)[number]>(placed.bodies.map((b) => [b.id, b]));
    const anchor = (id: string) => {
      const b = byId.get(id)!;
      return zoneAnchor({ xM: b.centre.x, yM: b.centre.y, headingRad: b.headingRad, speedMps: 0 }, b.dims.lengthM, b.dims.widthM, b.zone);
    };
    expect(dist(anchor("A"), { x: 1.75, y: -1.75 })).toBeLessThan(0.1);
    expect(dist(anchor("B"), { x: 1.75, y: -1.75 })).toBeLessThan(0.1);
    expect(dist(anchor("C"), { x: -1.75, y: 1.75 })).toBeLessThan(0.1);
    expect(dist(anchor("D"), { x: -1.75, y: 1.75 })).toBeLessThan(0.1);
    const ids = ["A", "B", "C", "D"];
    for (let i = 0; i < 4; i++) {
      for (let j = i + 1; j < 4; j++) {
        const a = byId.get(ids[i]!)!, b = byId.get(ids[j]!)!;
        const box = (p: typeof a) => cornersOf({ xM: p.centre.x, yM: p.centre.y, headingRad: p.headingRad, speedMps: 0 }, p.dims.lengthM, p.dims.widthM);
        expect(overlapDepth(box(a), box(b)), `${ids[i]}-${ids[j]}`).toBeLessThanOrEqual(0.05);
      }
    }
  });

  it("simulates with a gap entry for A-B and C-D only, deterministic, no overlap before impact, nobody on a building", () => {
    const sim = run(fourWayScene(), net);
    expect(sim.gaps.map((g) => `${g.a}${g.b}`)).toEqual(["AB", "CD"]);
    expect(simulate(fourWayScene(), net)).toEqual(simulate(fourWayScene(), net));
    const i0 = Math.round(-sim.startTimeS / sim.dtS);
    for (let i = 0; i < i0; i += 1) {
      for (let p = 0; p < 4; p++) {
        for (let q = p + 1; q < 4; q++) {
          const a = sim.vehicles[p]!, b = sim.vehicles[q]!;
          expect(overlapDepth(cornersOf(a.track[i]!, a.lengthM, a.widthM), cornersOf(b.track[i]!, b.lengthM, b.widthM))).toBeLessThanOrEqual(0.05);
        }
      }
    }
    const poses = sim.vehicles.flatMap((v) => v.track.filter((_, i) => i % 6 === 0).map((pose, i) => ({ id: `${v.id}@${i}`, pose, type: v.type })));
    expect(buildingProblems(net, poses)).toEqual([]);
    assertAllFinite(sim);
    expect(APPROACH_S).toBe(-sim.startTimeS);
  });

  it("conserves linear and angular momentum (1e-6)", () => {
    const placed = expectOk(placeDetailed(fourWayScene(), net, PIN)).value;
    const { before, specs } = impactInput(placed.bodies, placed.contacts, placed.bodies.map((b) => speedCases(b.veh).mid), FRICTION.dry);
    expectConserved(before, resolveContacts(before, specs, RESTITUTION, IMPACT_PASSES));
  });
});

describe("three or more vehicles that can't be placed", () => {
  it("draws a vehicle nobody could have hit in its marked zone with the nearest zone that meets, and says so", () => {
    // C drives south in the other lane and is marked hit on its rear: nothing else comes from behind it.
    const scene = sceneOf([
      veh("A", { type: "car", bearingDeg: 0, ...MAIN, zone: "left" }),
      veh("B", { type: "suv", bearingDeg: 90, ...PARK, zone: "front" }),
      veh("C", { type: "car", bearingDeg: 180, ...MAIN, zone: "rear" }),
    ]);
    const r = simulate(scene, intersectionNet());
    // A warning never blocks: the picture uses the zone that can meet, and a plain warning names it.
    expect(r.ok).toBe(true);
    if (r.ok) {
      const w = r.result.warnings.find((m) => m.code === "zone-used" && m.vehicleIds.includes("C"));
      expect(w).toBeDefined();
      expect(w!.text).toMatch(/\bC\b/);
      expect(w!.text).not.toMatch(/undefined|NaN|null/);
      const c = r.result.vehicles.find((v) => v.id === "C")!;
      expect(c.impact!.zoneHit).toBe("rear");
      expect(c.impact!.leadingZone).not.toBe("rear");
    }
  });
});

function expectConserved(before: ReadonlyArray<{ massKg: number; inertiaKgM2: number; centreM: Vec2; velocityMps: Vec2; spinRadPs: number }>, after: typeof before): void {
  const lin = (bs: typeof before) => ({ x: bs.reduce((s, b) => s + b.massKg * b.velocityMps.x, 0), y: bs.reduce((s, b) => s + b.massKg * b.velocityMps.y, 0) });
  const ang = (bs: typeof before) => bs.reduce((s, b) => s + b.inertiaKgM2 * b.spinRadPs + b.massKg * (b.centreM.x * b.velocityMps.y - b.centreM.y * b.velocityMps.x), 0);
  const p0 = lin(before), p1 = lin(after);
  const pScale = before.reduce((s, b) => s + b.massKg * Math.hypot(b.velocityMps.x, b.velocityMps.y), 0);
  expect(pScale).toBeGreaterThan(0);
  expect(Math.abs(p1.x - p0.x) / pScale).toBeLessThan(1e-6);
  expect(Math.abs(p1.y - p0.y) / pScale).toBeLessThan(1e-6);
  const lScale = before.reduce((s, b) => s + Math.abs(b.inertiaKgM2 * b.spinRadPs) + b.massKg * Math.abs(b.centreM.x * b.velocityMps.y - b.centreM.y * b.velocityMps.x), 0);
  expect(Math.abs(ang(after) - ang(before)) / Math.max(lScale, 1)).toBeLessThan(1e-6);
  // And the impulses never add kinetic energy.
  const ke = (bs: typeof before) => bs.reduce((s, b) => s + 0.5 * b.massKg * (b.velocityMps.x ** 2 + b.velocityMps.y ** 2) + 0.5 * b.inertiaKgM2 * b.spinRadPs ** 2, 0);
  expect(ke(after)).toBeLessThanOrEqual(ke(before) + 1e-6);
  void dimsOf;
}
