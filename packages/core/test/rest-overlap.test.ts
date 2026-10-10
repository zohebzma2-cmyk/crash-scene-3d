// Bodies never overlap after the crash: not while they slide and not at rest, and the "gap" is the centre distance, so it is
// at least half the sum of the widths. (The app once printed "A to B at final rest about 0 ft": a single-point impulse and no
// later collisions left bodies sliding through each other.)
import { describe, expect, it } from "vitest";
import { simulate } from "../src";
import type { Scene, SceneVehicle, SimulationResult, VehicleResult, VehicleType, Zone } from "../src";
import { cornersOf, dist, expectOk, flatTBoneScene, known, overlapDepth, posOf, sceneOf, veh } from "./physics-helpers";

const ZONES: Zone[] = ["front", "front-right", "right", "rear-right", "rear", "rear-left", "left", "front-left"];
const TOUCH_TOL_M = 0.05; // the model's own overlap tolerance (OVERLAP_TOLERANCE_M)

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Every pair that touched at the impact: no overlap at any sampled step from the impact on, and the gap is the centre distance and at least the half-widths. */
function checkNoOverlap(sim: SimulationResult, label: string): void {
  const i0 = Math.round(-sim.startTimeS / sim.dtS);
  for (const g of sim.gaps) {
    const a = sim.vehicles.find((v) => v.id === g.a)!, b = sim.vehicles.find((v) => v.id === g.b)!;
    const n = Math.min(a.track.length, b.track.length);
    for (let i = i0; i < n; i += 3) {
      const depth = overlapDepth(cornersOf(a.track[i]!, a.lengthM, a.widthM), cornersOf(b.track[i]!, b.lengthM, b.widthM));
      expect(depth, `${label} ${g.a}${g.b} step ${i - i0}`).toBeLessThanOrEqual(TOUCH_TOL_M + 1e-9);
    }
    const lastDepth = overlapDepth(cornersOf(a.restPose, a.lengthM, a.widthM), cornersOf(b.restPose, b.lengthM, b.widthM));
    expect(lastDepth, `${label} ${g.a}${g.b} at rest`).toBeLessThanOrEqual(TOUCH_TOL_M + 1e-9);
    expect(g.restGapM.mid, `${label} gap is the centre distance`).toBeCloseTo(dist(posOf(a.restPose), posOf(b.restPose)), 9);
    const halfWidths = (a.widthM + b.widthM) / 2;
    expect(g.restGapM.lo, `${label} ${g.a}${g.b} lo gap`).toBeGreaterThanOrEqual(halfWidths - 0.06);
    expect(g.restGapM.mid, `${label} ${g.a}${g.b} gap`).toBeGreaterThanOrEqual(halfWidths - 0.06);
    expect(g.restGapM.hi, `${label} ${g.a}${g.b} hi gap`).toBeGreaterThanOrEqual(halfWidths - 0.06);
  }
}

describe("no body overlaps another after the crash", () => {
  it("the default claim in the app (A north, B east, left side hit by B's front) leaves them clear of each other", () => {
    const sim = expectOk(simulate(flatTBoneScene(), null)).result;
    checkNoOverlap(sim, "default");
    const g = sim.gaps[0]!;
    const a = sim.vehicles[0]!, b = sim.vehicles[1]!;
    expect(g.restGapM.mid).toBeGreaterThan((a.widthM + b.widthM) / 2);
    expect(g.restGapM.mid * 3.28084).toBeGreaterThan(5); // not "about 0 ft"
  });

  it("the case that printed a gap of 0.11 m: head-on, van front-left against a car's front-right, 40 and 10 mph", () => {
    const o = simulate(sceneOf([
      veh("A", { type: "van", bearingDeg: 0, speed: known(40), zone: "front-left" }),
      veh("B", { type: "car", bearingDeg: 180, speed: known(10), zone: "front-right" }),
    ]), null);
    const sim = expectOk(o).result;
    checkNoOverlap(sim, "van/car");
    expect(sim.gaps[0]!.restGapM.mid).toBeGreaterThan(1.8);
  });

  it("holds for every zone pair, several vehicle types and speed pairs, and the directions the app offers", () => {
    const types: VehicleType[] = ["car", "van", "motorcycle", "truck"];
    const speeds: Array<[number, number]> = [[25, 25], [40, 10], [10, 40], [5, 5]];
    let ran = 0;
    for (const [ba, bb] of [[0, 90], [0, 180], [30, 150], [0, 270], [0, 45], [0, 135], [0, 0], [200, 20]] as const) for (const za of ZONES) for (const zb of ZONES) {
      const ta = types[(ZONES.indexOf(za) + ZONES.indexOf(zb)) % types.length]!, tb = types[(ZONES.indexOf(za) * 3 + ZONES.indexOf(zb) + 1) % types.length]!;
      for (const [sa, sb] of speeds) {
        const vs: SceneVehicle[] = [veh("A", { type: ta, bearingDeg: ba, speed: known(sa), zone: za }), veh("B", { type: tb, bearingDeg: bb, speed: known(sb), zone: zb })];
        const o = simulate(sceneOf(vs, { condition: "wet" }), null);
        if (!o.ok) continue;
        ran++;
        checkNoOverlap(o.result, `${ba}/${bb} ${za}/${zb} ${ta}/${tb} ${sa}/${sb}`);
      }
    }
    expect(ran).toBeGreaterThan(250);
  }, 30000); // about 3 s alone; the default 5 s is too tight when the property tests share the CPU

  it("holds for random scenes (seeded): bearings, zones, types, speeds, road conditions", () => {
    const rnd = mulberry32(2026);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
    const TYPES: VehicleType[] = ["car", "suv", "pickup", "van", "motorcycle", "truck"];
    let ran = 0;
    for (let i = 0; i < 1500; i++) {
      const ba = Math.round(rnd() * 359), bb = Math.round(rnd() * 359);
      const vs: SceneVehicle[] = [
        veh("A", { type: pick(TYPES), bearingDeg: ba, speed: known(Math.round(rnd() * 600) / 10), zone: pick(ZONES) }),
        veh("B", { type: pick(TYPES), bearingDeg: bb, speed: known(Math.round(rnd() * 600) / 10), zone: pick(ZONES) }),
      ];
      const o = simulate(sceneOf(vs, { condition: pick(["dry", "wet", "snow", "ice"] as const) }), null);
      if (!o.ok) continue;
      ran++;
      checkNoOverlap(o.result, `random ${i}`);
    }
    expect(ran).toBeGreaterThan(150);
  }, 30000);

  it("holds for three vehicles in a chain, every touching pair", () => {
    const vs: SceneVehicle[] = [
      veh("A", { type: "suv", bearingDeg: 0, speed: known(20), zone: "rear" }),
      veh("B", { type: "car", bearingDeg: 0, speed: known(35), zone: "rear" }),
      veh("C", { type: "pickup", bearingDeg: 0, speed: known(50), zone: "front" }),
    ];
    const o = simulate(sceneOf(vs, { place: "road" }), null);
    if (o.ok) checkNoOverlap(o.result, "chain");
  });
});

describe("when a body would slide into another, it stops where they touch and the result says so", () => {
  const scene = (): Scene => sceneOf([
    veh("A", { type: "car", bearingDeg: 0, speed: known(25), zone: "front-left" }),
    veh("B", { type: "car", bearingDeg: 90, speed: known(25), zone: "front-right" }),
  ]);

  it("warns with stopped-at-vehicle, names who stopped whom, and the stopped body ends no deeper than the tolerance", () => {
    const sim = expectOk(simulate(scene(), null)).result;
    const w = sim.warnings.filter((x) => x.code === "stopped-at-vehicle");
    expect(w.length).toBeGreaterThan(0);
    expect(w[0]!.text).toMatch(/would have slid into vehicle . after the crash\. The picture stops it where they touch\./);
    expect(w[0]!.vehicleIds).toHaveLength(2);
    checkNoOverlap(sim, "stopped");
    const stopped = sim.vehicles.find((v) => v.id === w[0]!.vehicleIds[0])!;
    const last = stopped.track[stopped.track.length - 1]!;
    expect(last.speedMps).toBe(0);
  });

  it("a stop is mentioned in the post-impact assumption (no later collisions)", () => {
    const sim = expectOk(simulate(scene(), null)).result;
    expect(sim.assumptions.find((a) => a.id === "post-impact-slide")!.text).toMatch(/a vehicle that would slide into another stops where they touch/);
  });

  it("an ordinary T-bone raises no stop warning", () => {
    expect(expectOk(simulate(flatTBoneScene(), null)).result.warnings.filter((x) => x.code === "stopped-at-vehicle")).toEqual([]);
  });
});

/** (kept: a tiny helper so a failing run names the vehicles) */
export function describeVehicles(vs: readonly VehicleResult[]): string {
  return vs.map((v) => `${v.id}:${v.type}`).join(",");
}
