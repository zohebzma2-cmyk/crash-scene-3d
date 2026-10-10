// At t = 0 the placement leaves the two bodies exactly touching (not inside each other, not apart), and the spin does not jump
// when the touching faces are a little out of square.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseScene, simulate } from "../src";
import type { RoadNetwork, Scene, SceneVehicle, SimulationResult, VehicleType, Zone } from "../src";
import { HWY, MAIN, PARK, cornersOf, expectOk, known, overlapDepth, sceneOf, veh } from "./physics-helpers";
import { highwayNet, intersectionNet } from "./roads-fixtures";

const load = (name: string): Scene => {
  const r = parseScene(JSON.parse(readFileSync(new URL(`../../../examples/${name}/scene.json`, import.meta.url), "utf8")));
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r.value;
};
const roads = (f: string): RoadNetwork => JSON.parse(readFileSync(new URL(`./data/${f}`, import.meta.url), "utf8")) as RoadNetwork;

const MAX_PENETRATION_M = 0.005;
const MAX_GAP_M = 0.02;

/** Signed SAT depth of every pair at the impact: positive = inside each other, negative = apart. */
function impactDepths(sim: SimulationResult): number[] {
  const out: number[] = [];
  for (const g of sim.gaps) {
    const a = sim.vehicles.find((v) => v.id === g.a)!, b = sim.vehicles.find((v) => v.id === g.b)!;
    out.push(overlapDepth(cornersOf(a.impactPose, a.lengthM, a.widthM), cornersOf(b.impactPose, b.lengthM, b.widthM)));
  }
  return out;
}

describe("the bodies touch exactly at t = 0", () => {
  const CASES: Array<[string, string | null]> = [
    ["t-bone-intersection", null], ["t-bone-intersection", "t-bone-intersection-roads.json"],
    ["highway-rear-end", null], ["highway-rear-end", "highway-rear-end-roads.json"],
    ["parking-lot-backing", null], ["parking-lot-backing", "parking-lot-backing-roads.json"], ["parking-lot-backing", "parking-lot-backing-roads-center-frame.json"],
  ];
  for (const [name, file] of CASES) {
    it(`${name} on ${file ?? "the flat template"}: penetration <= 5 mm and no gap over 2 cm`, () => {
      const sim = expectOk(simulate(load(name), file ? roads(file) : null)).result;
      const depths = impactDepths(sim);
      expect(depths.length).toBeGreaterThan(0);
      for (const d of depths) {
        expect(d).toBeLessThanOrEqual(MAX_PENETRATION_M);
        expect(d).toBeGreaterThanOrEqual(-MAX_GAP_M);
      }
      expect(sim.warnings).toEqual([]);
    });
  }

  it("holds across zone pairs, types and angles (flat template)", () => {
    const ZONES: Zone[] = ["front", "front-right", "right", "rear-right", "rear", "rear-left", "left", "front-left"];
    const TYPES: VehicleType[] = ["car", "suv", "van", "pickup", "truck", "motorcycle"];
    let ran = 0, worstIn = 0, worstGap = 0;
    for (const [ba, bb] of [[0, 90], [0, 180], [0, 270], [30, 150], [0, 45], [200, 20]] as const) for (const za of ZONES) for (const zb of ZONES) {
      const ta = TYPES[(ZONES.indexOf(za) + ZONES.indexOf(zb)) % TYPES.length]!, tb = TYPES[(ZONES.indexOf(za) * 2 + ZONES.indexOf(zb) + 1) % TYPES.length]!;
      const vs: SceneVehicle[] = [veh("A", { type: ta, bearingDeg: ba, speed: known(30), zone: za }), veh("B", { type: tb, bearingDeg: bb, speed: known(30), zone: zb })];
      const o = simulate(sceneOf(vs), null);
      if (!o.ok) continue;
      ran++;
      for (const d of impactDepths(o.result)) { worstIn = Math.max(worstIn, d); worstGap = Math.max(worstGap, -d); }
    }
    expect(ran).toBeGreaterThan(50);
    expect(worstIn).toBeLessThanOrEqual(MAX_PENETRATION_M);
    expect(worstGap).toBeLessThanOrEqual(MAX_GAP_M);
  });
});

describe("the response to a slightly out-of-square hit is smooth", () => {
  const turnOf = (v: SimulationResult["vehicles"][number]): number => {
    let d = ((v.restPose.headingRad - v.impactPose.headingRad) * 180) / Math.PI;
    d = ((d + 540) % 360) - 180;
    return d;
  };
  it("A's turn changes by less than 2.5 degrees as the SUV's direction goes from 88 to 92 degrees (about 2.1: 1.2 of it is the changing geometry, 0.9 the SUV's own sideways speed)", () => {
    const turns: number[] = [];
    for (const bearing of [88, 89, 90, 91, 92]) {
      const sim = expectOk(simulate(sceneOf([
        veh("A", { type: "car", bearingDeg: 0, speed: known(25), zone: "left" }),
        veh("B", { type: "suv", bearingDeg: bearing, speed: known(20), zone: "front" }),
      ]), null)).result;
      turns.push(turnOf(sim.vehicles[0]!));
    }
    expect(Math.max(...turns) - Math.min(...turns)).toBeLessThan(2.5);
  });

  it("B's turn also stays within 3 degrees over the same sweep, and both stay the same sign", () => {
    const a: number[] = [], b: number[] = [];
    for (const bearing of [88, 89, 90, 91, 92]) {
      const sim = expectOk(simulate(sceneOf([
        veh("A", { type: "car", bearingDeg: 0, speed: known(25), zone: "left" }),
        veh("B", { type: "suv", bearingDeg: bearing, speed: known(20), zone: "front" }),
      ]), null)).result;
      a.push(turnOf(sim.vehicles[0]!)); b.push(turnOf(sim.vehicles[1]!));
    }
    expect(Math.max(...b) - Math.min(...b)).toBeLessThan(3);
    expect(a.every((x) => x < 0)).toBe(true);
    expect(b.every((x) => x < 0)).toBe(true);
  });

  it("the real-map T-bone (roads at about 87.6 degrees) turns A and B about as the square-on hit does", () => {
    const sim = expectOk(simulate(load("t-bone-intersection"), roads("t-bone-intersection-roads.json"))).result;
    const [a, b] = [turnOf(sim.vehicles[0]!), turnOf(sim.vehicles[1]!)];
    expect(Math.abs(a)).toBeLessThan(12);
    expect(Math.abs(b)).toBeGreaterThan(20);
    expect(Math.abs(b)).toBeLessThan(40);
  });
});

describe("the patch follows the touching corner as the SUV's direction sweeps from 78 to 102 degrees", () => {
  const SWEEP: number[] = [];
  for (let b = 78; b <= 102.0001; b += 0.25) SWEEP.push(Math.round(b * 100) / 100);
  const runAt = (bearing: number) => expectOk(simulate(sceneOf([
    veh("A", { type: "car", bearingDeg: 0, speed: known(25), zone: "left" }),
    veh("B", { type: "suv", bearingDeg: bearing, speed: known(20), zone: "front" }),
  ]), null)).result;
  const turnOf = (v: SimulationResult["vehicles"][number]): number => {
    let d = ((v.restPose.headingRad - v.impactPose.headingRad) * 180) / Math.PI;
    d = ((d + 540) % 360) - 180;
    return d;
  };
  const sims = new Map(SWEEP.map((b) => [b, runAt(b)] as const));

  it("A's and B's turns never jump between neighbouring steps, even where the patch swings fastest", () => {
    let worstA = 0, worstB = 0;
    for (let i = 1; i < SWEEP.length; i++) {
      const p = sims.get(SWEEP[i - 1]!)!, q = sims.get(SWEEP[i]!)!;
      worstA = Math.max(worstA, Math.abs(turnOf(q.vehicles[0]!) - turnOf(p.vehicles[0]!)));
      worstB = Math.max(worstB, Math.abs(turnOf(q.vehicles[1]!) - turnOf(p.vehicles[1]!)));
    }
    // 0.25 degree steps. The spin does change fastest where the patch shrinks from the whole nose to the leading corner (about 1.2
    // degrees of turn per step with the 0.3 m crush band), but it never jumps by the 6 to 40 degrees that a jump to another stretch gave.
    expect(worstA).toBeLessThan(1.5);
    expect(worstB).toBeLessThan(1.5);
  });

  it("is continuous at the old switch points: 79.75 to 80 and 100 to 100.25 degrees differ by under a degree", () => {
    for (const [lo, hi] of [[79.75, 80], [100, 100.25]] as const) {
      for (const k of [0, 1] as const) {
        expect(Math.abs(turnOf(sims.get(hi)!.vehicles[k]!) - turnOf(sims.get(lo)!.vehicles[k]!))).toBeLessThan(1);
      }
    }
  });

  it("the contact point is on the touching corner's side of the nose, within the crush band of it", () => {
    for (const bearing of SWEEP) {
      const sim = sims.get(bearing)!;
      const tilt = bearing - 90;
      if (Math.abs(tilt) < 10) continue; // nearly square: the whole nose is in the 0.3 m band (up to about 9 degrees)
      const b = sim.vehicles[1]!;
      // A's side faces west (normal east, +x); the corner of B's nose with the larger x touches first.
      const lead = cornersOf(b.impactPose, b.lengthM, b.widthM).slice().sort((p, q) => q.x - p.x)[0]!;
      const contactY = sim.vehicles[0]!.impact!.contactPointM.y;
      expect(Math.sign(contactY), `${bearing}: contact y ${contactY.toFixed(3)} vs corner y ${lead.y.toFixed(3)}`).toBe(Math.sign(lead.y - b.impactPose.yM));
      const reach = 0.3 / Math.tan((Math.abs(tilt) * Math.PI) / 180) + 0.1; // the stretch within the crush band of the corner
      expect(Math.abs(contactY - lead.y), `${bearing}`).toBeLessThanOrEqual(reach);
    }
  });
});

describe("three vehicles: every pair that touches is exactly touching, and nothing else overlaps", () => {
  const check = (sim: SimulationResult, label: string): void => {
    const vs = sim.vehicles;
    const touching = new Set(sim.gaps.map((g) => `${g.a}${g.b}`));
    for (let i = 0; i < vs.length; i++) for (let j = i + 1; j < vs.length; j++) {
      const a = vs[i]!, b = vs[j]!;
      const d = overlapDepth(cornersOf(a.impactPose, a.lengthM, a.widthM), cornersOf(b.impactPose, b.lengthM, b.widthM));
      if (touching.has(`${a.id}${b.id}`)) {
        expect(d, `${label} ${a.id}${b.id}`).toBeLessThanOrEqual(MAX_PENETRATION_M);
        expect(d, `${label} ${a.id}${b.id}`).toBeGreaterThanOrEqual(-MAX_GAP_M);
      } else {
        expect(d, `${label} ${a.id}${b.id} (not touching)`).toBeLessThanOrEqual(0.05);
      }
    }
  };

  it("a rear-end chain A-B-C (flat)", () => {
    const sim = expectOk(simulate(sceneOf([
      veh("A", { type: "suv", bearingDeg: 0, speed: known(20), zone: "rear" }),
      veh("B", { type: "car", bearingDeg: 0, speed: known(35), zone: "rear" }),
      veh("C", { type: "pickup", bearingDeg: 0, speed: known(50), zone: "front" }),
    ], { place: "road" }), null)).result;
    expect(sim.gaps.map((g) => `${g.a}${g.b}`)).toEqual(["AB", "BC"]);
    check(sim, "chain");
  });

  it("a rear-end chain A-B-C on the highway lane", () => {
    const sim = expectOk(simulate(sceneOf([
      veh("A", { type: "suv", bearingDeg: 0, ...HWY, lane: 1, speed: known(20), zone: "rear" }),
      veh("B", { type: "car", bearingDeg: 0, ...HWY, lane: 1, speed: known(35), zone: "rear" }),
      veh("C", { type: "pickup", bearingDeg: 0, ...HWY, lane: 1, speed: known(50), zone: "front" }),
    ], { place: "road" }), highwayNet())).result;
    check(sim, "highway chain");
  });

  it("a T-bone with a third car, slightly tilted, hitting the striker's rear: the first pair is not pushed into each other", () => {
    // A is hit on its left by B (heading 90); C comes up behind B at 80 to 100 degrees, so its corner leads into B's rear. Attaching C must
    // move only C: if B moved too it would be pushed 10 to 24 mm into A.
    let ran = 0;
    for (const [bBearing, cBearing] of [[90, 80], [90, 85], [90, 95], [90, 100], [100, 110]] as const) {
      const o = simulate(sceneOf([
        veh("A", { type: "car", bearingDeg: 0, speed: known(25), zone: "left" }),
        veh("B", { type: "suv", bearingDeg: bBearing, speed: known(20), zone: "front" }),
        veh("C", { type: "pickup", bearingDeg: cBearing, speed: known(40), zone: "front" }),
      ]), null);
      if (!o.ok) continue;
      ran++;
      check(o.result, `B ${bBearing} C ${cBearing}`);
    }
    expect(ran).toBeGreaterThanOrEqual(4);
  });

  it("four vehicles, two T-bones in one intersection", () => {
    const sim = expectOk(simulate(sceneOf([
      veh("A", { type: "car", bearingDeg: 0, ...MAIN, speed: known(25), zone: "left" }),
      veh("B", { type: "suv", bearingDeg: 90, ...PARK, speed: known(25), zone: "front" }),
      veh("C", { type: "car", bearingDeg: 180, ...MAIN, speed: known(25), zone: "left" }),
      veh("D", { type: "suv", bearingDeg: 270, ...PARK, speed: known(25), zone: "front" }),
    ]), intersectionNet())).result;
    check(sim, "four-way");
  });
});

describe("the whole range of tilts that still hit the marked face: 45 to 135 degrees", () => {
  // (At exactly 45 and 135 degrees the nose is equally square to two faces; the tie goes to the marked zone's face, so both ends are in the sweep.)
  const BEARINGS: number[] = [];
  for (let b = 45; b <= 135.00001; b += 0.25) BEARINGS.push(Math.round(b * 100) / 100);
  const sims = new Map(BEARINGS.map((b) => [b, expectOk(simulate(sceneOf([
    veh("A", { type: "car", bearingDeg: 0, speed: known(25), zone: "left" }),
    veh("B", { type: "suv", bearingDeg: b, speed: known(20), zone: "front" }),
  ]), null)).result] as const));
  const turnOf = (v: SimulationResult["vehicles"][number]): number => {
    let d = ((v.restPose.headingRad - v.impactPose.headingRad) * 180) / Math.PI;
    d = ((d + 540) % 360) - 180;
    return d;
  };

  it("every direction is drawn as entered: no zone is swapped, so there is no zone-used warning", () => {
    for (const b of BEARINGS) {
      const sim = sims.get(b)!;
      expect(sim.warnings.filter((w) => w.code === "zone-used"), `${b}`).toEqual([]);
      expect(sim.vehicles[0]!.impact!.leadingZone, `${b}`).toBe("left");
      expect(["front", "front-left", "front-right"], `${b}`).toContain(sim.vehicles[1]!.impact!.leadingZone); // the nose, or the corner of it that touches
    }
  });

  it("neither car's turn jumps between neighbouring steps (under 1.5 degrees per quarter degree) anywhere in the range", () => {
    for (let i = 1; i < BEARINGS.length; i++) {
      const p = sims.get(BEARINGS[i - 1]!)!, q = sims.get(BEARINGS[i]!)!;
      for (const k of [0, 1] as const) {
        expect(Math.abs(turnOf(q.vehicles[k]!) - turnOf(p.vehicles[k]!)), `${BEARINGS[i]} vehicle ${k}`).toBeLessThan(1.5);
      }
    }
  });

  it("is continuous across 75 and 105 degrees, where the limits of an earlier version switched the contact", () => {
    for (const [lo, hi] of [[74.75, 75], [75, 75.25], [104.75, 105], [105, 105.25]] as const) {
      for (const k of [0, 1] as const) {
        expect(Math.abs(turnOf(sims.get(hi)!.vehicles[k]!) - turnOf(sims.get(lo)!.vehicles[k]!))).toBeLessThan(1.5);
      }
    }
  });
});
